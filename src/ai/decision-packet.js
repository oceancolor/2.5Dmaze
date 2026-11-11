// 决策回包（决策协议改造 §14 C7 / C8，第 5 项）：轨迹层 + 摘要层，全部取自同一份决策帧与结果事件。
// 决策层（完整局面与博弈事实表）沿用 codec.buildPayload，由调用方另外附上 —— 它与 frame(k) 是同一次 observe 的投影。
// MCP（server/workbuddy.mjs）与网页大模型提示词（第 7 项）共用这里，保证两个入口看到的是同一份东西。
//
// 帧段：上一个决策点之后到本次决策点（含）的帧 (anchor, k]；首个决策点为 [0, 0]；终局为 (anchor, endK]。
// 相邻两个决策点的帧段首尾相接、不重不漏（修复重交沿用同一帧段）。

import { COLOR_NAME } from './harness.js';

/** 单个决策回包里最多带多少帧轨迹；更早的只进摘要，提示用 maze_frames 取全量。 */
export const MAX_PACKET_FRAMES = 40;
/** maze_frames 一次最多返回的帧数。 */
export const MAX_QUERY_FRAMES = 200;
/** maze_frames 的 fields 白名单（只能在本座位可见的字段里裁剪）。 */
export const FRAME_FIELDS = Object.freeze(['seats', 'events', 'gems', 'chest', 'gen', 'aim']);
export const SEATS_LEGEND = 'seats[i] = [x, y, 体力, 分数, 状态]（座位 i；看不见的对手 x / y 为 null）';

const OPEN = new Set(['applied', 'queued', 'guard']);
const CLOSE = new Set(['reached', 'lost', 'abandoned', 'replaced', 'continued', 'interrupted']);

/**
 * 每帧「这一回合在执行哪个决策、去哪」：第 k 回合的那一步由 k 之前的结果事件决定（applied 在帧 a，第 a+1 回合起执行）。
 * @returns {(k:number) => [number, string, number, number] | null}  [dp, 目标类型, x, y]
 */
export function aimsOf(outcomes) {
  const sorted = outcomes.slice().sort((p, q) => p.k - q.k);
  return (k) => {
    let cur = null;
    for (const e of sorted) {
      if (e.k >= k) break;
      if (OPEN.has(e.type) && e.ref) cur = [e.dp, e.ref.type, e.ref.x, e.ref.y];
      else if (CLOSE.has(e.type) && cur && cur[0] === e.dp) cur = null;
    }
    return cur;
  };
}

const colorOf = (colors, c) => (Number.isInteger(c) && colors[c] ? colors[c] : c);

/** 帧 → 回包里的一项（fields 为裁剪后的字段集合）。 */
export function frameItem(f, { colors = [], aim = null, fields = FRAME_FIELDS } = {}) {
  const want = new Set(fields);
  const o = { k: f.k };
  if (want.has('seats')) o.seats = f.seats.map((a) => [a.x, a.y, a.stamina, a.score, a.status]);
  if (want.has('events')) o.events = f.events.map((e) => (e.type === 'pickup' ? { ...e, color: colorOf(colors, e.color) } : { ...e }));
  if (want.has('gems')) o.gems = f.gems.map(([c, x, y]) => [colorOf(colors, c), x, y]);
  if (want.has('chest')) o.chest = f.chest;
  if (want.has('gen')) o.gen = f.gen;
  if (want.has('aim')) o.aim = aim;
  return o;
}

/**
 * 构造一个回包的轨迹层与摘要层。
 * @param {{frames:object, seat:number, outcomes:object[], from:number, to:number, colors?:string[], prevDp?:number, dp?:number}} o
 *   frames：调度器的帧缓冲；outcomes：该座位的结果事件；from..to：帧段（闭区间）
 *   prevDp..dp：「上次决策」的范围（dp ≥ prevDp 且 < dp 的结果事件进 lastDecisionOutcome；终局不传 dp = 全部）
 */
export function buildPacket({ frames, seat, outcomes, from, to, colors = [], prevDp = 0, dp = Infinity }) {
  const all = to >= from ? frames.range(seat, from, to) : [];
  const shown = all.slice(-MAX_PACKET_FRAMES);
  const aim = aimsOf(outcomes);
  const events = {};
  for (const f of all) for (const e of f.events) events[e.type] = (events[e.type] || 0) + 1;
  return {
    frames: {
      from, to, legend: SEATS_LEGEND,
      items: shown.map((f) => frameItem(f, { colors, aim: aim(f.k), fields: ['seats', 'events', 'aim'] })),
      truncated: shown.length < all.length,
      ...(shown.length < all.length ? { shownFrom: shown[0].k } : {}),
    },
    summary: { turns: all.filter((f) => f.k >= 1).length, events },
    lastDecisionOutcome: outcomes.filter((e) => e.dp >= prevDp && e.dp < dp).map((e) => ({ ...e })),
  };
}

// ───────── 给模型看的中文正文（摘要层；逐帧数据在 JSON 块里）─────────

export function refLabel(ref, colors = []) {
  if (!ref) return '—';
  if (ref.type === 'exit') return `出口(${ref.x},${ref.y})`;
  if (ref.type === 'chest') return `宝箱(${ref.x},${ref.y})`;
  const name = Number.isInteger(ref.c) ? colors[ref.c] : null;
  return `宝石·${COLOR_NAME[name] || name || '?'}(${ref.x},${ref.y})`;
}

const at = (k) => (k === 0 ? '开局' : `第 ${k} 回合`);

/** 一条结果事件 → 人话。 */
export function outcomeLine(e, colors = []) {
  const r = refLabel(e.ref, colors);
  switch (e.type) {
    case 'applied': return e.keep
      ? `${at(e.k)}${e.k === 0 ? '' : '结束后'}续走：去 ${r}`
      : `${at(e.k)}${e.k === 0 ? '' : '结束后'}提交：去 ${r}（第 ${e.effectiveTurn} 回合起执行）`;
    case 'continued': return `${at(e.k)}结束后由决策点 dp-${e.by} 续走（目标不变）`;
    case 'queued': return `${at(e.k)}结束后按 then 接着去 ${r}`;
    case 'reached': return `第 ${e.k} 回合${e.ref && e.ref.type === 'exit' ? '到达出口' : `拿到 ${r}`}`;
    case 'lost': return `第 ${e.k} 回合 ${r} 被座位 ${e.by} 拿走（你还差 ${e.behind} 步）`;
    case 'guard': return `${at(e.k)}结束后体力不够（去 ${e.dist} + 回 ${e.back} > 体力 ${e.stamina}），引擎改为回家`;
    case 'abandoned': return `${at(e.k)}结束后放弃：座位 ${e.seat} 比你近 ${e.lead} 步（条件 ≥ ${e.need}）`;
    case 'replaced': return `${at(e.k)}结束后被决策点 dp-${e.by} 换了目标`;
    case 'interrupted': return `${at(e.k)}被打断（${e.cause === 'takeover' ? '玩家接管' : e.cause}）`;
    case 'invalid': return `不合格：${e.why}`;
    case 'failed': return `调用失败：${e.why}`;
    case 'stale': return `作废：生效时目标已没了（${e.why}）`;
    case 'cancelled': return `请求被撤销（${e.cause === 'takeover' ? '玩家接管' : e.cause}）`;
    default: return e.type;
  }
}

function eventLine(k, e, seat, colors) {
  const who = e.seat === seat ? '你' : `座位 ${e.seat} `;
  switch (e.type) {
    case 'pickup': return `T${k} ${who}在 (${e.x},${e.y}) 拿到${COLOR_NAME[colorOf(colors, e.color)] || ''}宝石`;
    case 'chest': return `T${k} ${who}开宝箱 (${e.x},${e.y})：${e.kind === 'score' ? `+${e.value} 分` : `+${e.gained ?? e.value} 体力`}`;
    case 'escaped': return `T${k} ${who}到达出口`;
    case 'failed': return `T${k} ${who}出局（${e.reason === 'stamina' ? '体力耗尽' : '回合上限'}）`;
    case 'gemRespawn': return `T${k} 宝石整批刷新（第 ${e.generation} 代）`;
    case 'chestRespawn': return `T${k} 宝箱刷新在 (${e.x},${e.y})`;
    case 'blocked': return `T${k} 你受阻`;
    default: return null;
  }
}

/**
 * 摘要层正文：上次决策的结果 + 本段全场事件（按回合）。逐帧位置在 framesRef 指的地方（MCP = 末尾 JSON 块，提示词 = 下面的「逐回合」）。
 * @param {object} packet buildPacket 的结果
 */
export function packetText(packet, { frames, seat, colors = [], framesRef = '末尾 JSON 的 frames.items' }) {
  const { from, to } = packet.frames;
  const L = [];
  if (to < from || (from === 0 && to === 0)) L.push('### 上次决策以来\n（开局，还没有人行动）');
  else L.push(`### 上次决策以来（第 ${Math.max(1, from)}–${to} 回合，逐回合位置见${framesRef}）`);
  const outs = packet.lastDecisionOutcome;
  if (outs.length) {
    const byDp = new Map();
    for (const e of outs) {
      if (!byDp.has(e.dp)) byDp.set(e.dp, []);
      byDp.get(e.dp).push(e);
    }
    for (const [d, list] of byDp) {
      const last = list[list.length - 1];
      const open = OPEN.has(last.type);
      L.push(`上次决策 dp-${d}：${list.map((e) => outcomeLine(e, colors)).join(' → ')}${open ? ' → 仍在执行' : ''}`);
    }
  }
  const ev = [];
  if (to >= from) {
    for (const f of frames.range(seat, from, to)) {
      for (const e of f.events) {
        const t = eventLine(f.k, e, seat, colors);
        if (t) ev.push(`- ${t}`);
      }
    }
  }
  if (ev.length) L.push('全场事件：', ...ev.slice(-30));
  else if (to > 0 && to >= from) L.push('这段时间没有拾取 / 开箱 / 刷新 / 到达。');
  return L.join('\n');
}

/**
 * 网页大模型提示词里的「上次决策以来」（§14 C7，第 7 项）：摘要正文 + 逐回合位置（事件已在正文里，逐帧只给位置与 aim）。
 * 与 MCP 回包同一个 buildPacket / packetText，只是逐帧数据内联在文字里而不是放 JSON 块。
 */
export function trajectoryText(packet, { frames, seat, colors = [] }) {
  const head = packetText(packet, { frames, seat, colors, framesRef: '下面的「逐回合」' });
  const { items, truncated, shownFrom } = packet.frames;
  if (!items.length || (packet.frames.from === 0 && packet.frames.to === 0)) return head;
  const rows = items.map(({ k, seats, aim }) => ({ k, seats, aim }));
  return `${head}\n逐回合（${SEATS_LEGEND}；aim = 那一回合你在执行的 [决策点, 目标类型, x, y]${truncated ? `；只列第 ${shownFrom} 回合起的最近 ${items.length} 回合` : ''}）：${JSON.stringify(rows)}`;
}
