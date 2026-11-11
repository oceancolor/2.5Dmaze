// 大模型 harness（2026-11-06 批次 6）：把一局里的多次决策串成一个「会话」，让推理更强的模型有东西可推理、能延续思路。
//
//   追踪器 createTracker   每次决策的目标 → 结局（拿到 / 被谁抢先几步 / 主动放弃 / 改主意 / 安全覆盖 / 到家），以及这段路走了几步
//   会话文本 sessionText    每次决策都带上：更早的决策折成摘要 + 最近 N 条原样 + 模型上次留给自己的备忘
//   对手动向 headingOf      近 K 回合在靠近哪些目标（引擎算好，给模型判断意图）
//   复盘 timelineFromRecord 由对局记录重放出每次决策的结局（结算卡 / 战绩 / 试跑共用，与对局中看到的同一套规则）
//   关键失误 keyMistakes    白跑最多的几次（被抢 / 放弃）
//
// 纯逻辑、确定性：只读观察 / 记录，不读时钟、不碰网络。

import { fieldFrom } from '../core/nav/bfs.js';
import { observe } from '../core/observe.js';
import { createMatch } from '../core/state.js';
import { step } from '../core/game.js';
import { decodeIntents } from '../record/recorder.js';

export const COLOR_NAME = Object.freeze({ red: '红', yellow: '黄', green: '绿', blue: '蓝', purple: '紫' });
const WHY_ZH = Object.freeze({
  start: '开局', complete: '计划完成', interval: '定期', targetLost: '目标被抢', refresh: '宝物刷新',
  blocked: '被堵', lowStamina: '体力进终盘', sighted: '对手接近', abandon: '放弃条件触发', note: '喊话', resume: '接管后交还',
});
export const whyText = (why) => WHY_ZH[why] || why || '';

/** 目标 → 人话：宝石·红(12,30) / 宝箱(5,6) / 回出口。 */
export function targetLabel(e) {
  if (!e || !e.target) return '—';
  const { x, y } = e.target;
  if (e.targetType === 'exit') return '回出口';
  if (e.targetType === 'chest') return `宝箱(${x},${y})`;
  return `宝石·${COLOR_NAME[e.color] || e.color || '?'}(${x},${y})`;
}

/** 这段路里顺路向出口靠近的步数（§14 C14 净绕路口径）。 */
const homewardOf = (e) => (Number.isFinite(e.d0) && Number.isFinite(e.d1) ? Math.max(0, Math.min(e.steps || 0, e.d0 - e.d1)) : 0);
/** 「白跑 X 步」的说明：顺路的部分单独说出来。 */
const wasteText = (e) => {
  const s = e.steps ?? 0;
  const h = homewardOf(e);
  return h ? `白跑 ${s - h} 步（走了 ${s} 步，其中 ${h} 步顺路向出口）` : `白跑 ${s} 步`;
};

/** 结局 → 人话。kept = 期间被问到又续走的次数。 */
export function outcomeText(e) {
  return e.kept ? `${outcomeCore(e)}（期间续走 ${e.kept} 次）` : outcomeCore(e);
}

function outcomeCore(e) {
  const s = e.steps ?? 0;
  switch (e.outcome) {
    case 'got': return `拿到了（走了 ${s} 步）`;
    case 'lost': return `被座位 ${e.by} 先拿走（我还差 ${e.behind} 步，${wasteText(e)}）`;
    case 'abandoned': return `主动放弃（${e.cause || '放弃条件触发'}，${wasteText(e)}）`;
    case 'switched': return `改了主意（走了 ${s} 步）`;
    case 'guard': return `引擎安全覆盖：体力不够，改回家（走了 ${s} 步）`;
    case 'home': return '到家';
    case 'open': return `对局结束时还在路上（走了 ${s} 步）`;
    case 'stale': return '作废：应用时目标已经没了';
    case 'invalid': return `不合格：${e.err || ''}`;
    case 'failed': return `调用失败：${e.err || ''}`;
    case null:
    case undefined: return `进行中（已走 ${s} 步）`;
    default: return e.outcome;
  }
}

/**
 * 白跑：被抢走或主动放弃时这段路的「净绕路」= 走的步数 − 其间离自己出口近了的步数（最少 0）。
 * 2026-11-11 起（§14 C14）：顺路往家走的那几步不算白跑；原步数仍在 steps 里。
 */
export const wastedOf = (e) => (e.outcome === 'lost' || e.outcome === 'abandoned' ? (e.steps || 0) - homewardOf(e) : 0);

/**
 * 结局追踪器：同一套规则既给对局中的 planner 用（喂观察），也给复盘重放用（喂重放出的观察）。
 * 每回合开始调 observe(obs)（obs.events = 上一回合的公开事件）；新目标生效调 start；其他条目调 note。
 */
export function createTracker(map, seat) {
  const N = map.size;
  const entries = [];
  let cur = null;
  let lastPos = null;
  let lastTurn = 0;
  let lastDist = null; // 当前离自己出口的步数（净绕路口径用）
  const distTo = (t, x, y) => fieldFrom(map, t.y * N + t.x)[y * N + x];
  function resolve(outcome, extra = {}) {
    if (!cur) return;
    Object.assign(cur, { outcome, endTurn: lastTurn, ...extra });
    if (lastDist !== null) cur.d1 = lastDist;
    cur = null;
  }
  return {
    entries,
    get current() { return cur; },
    /**
     * 新目标生效（llm / llm-repair / queue / guard）；上一个目标按 prevOutcome 结束。
     * 续走（§14 C14）：大模型被问到后给的还是当前这个目标（keep，或交了同一个目标）→ 不另起一条，并入当前条目（kept + 1），
     * 步数与白跑从这个目标最初开始走算起；备忘 / then / abandonIf 按这次的更新。
     */
    start(e, prevOutcome = 'switched') {
      if (prevOutcome === 'switched' && cur && cur.target && e.target && cur.targetType === e.targetType && cur.target.x === e.target.x && cur.target.y === e.target.y) {
        cur.kept = (cur.kept || 0) + 1;
        if (e.memo) cur.memo = e.memo;
        if (!e.keep) Object.assign(cur, { then: e.then, abandonIf: e.abandonIf });
        return cur;
      }
      resolve(prevOutcome);
      cur = { ...e, outcome: null, steps: 0, endTurn: null, ...(lastDist !== null ? { d0: lastDist } : {}) };
      delete cur.keep;
      entries.push(cur);
      return cur;
    },
    /** 不带目标追踪的条目（stale / invalid / failed）。 */
    note(e) {
      entries.push({ ...e, steps: 0, endTurn: e.n });
    },
    /** 放弃条件触发：当前目标结束为「主动放弃」。 */
    abandon(cause) {
      resolve('abandoned', { cause });
    },
    observe(obs) {
      const me = obs.self;
      lastTurn = Math.max(0, obs.turn - 1);
      if (cur && lastPos && (me.x !== lastPos[0] || me.y !== lastPos[1])) cur.steps++;
      lastPos = [me.x, me.y];
      if (Number.isInteger(me.distToExit) && me.distToExit >= 0) lastDist = me.distToExit;
      if (!cur || !cur.target || cur.targetType === 'exit') return;
      const t = cur.target;
      for (const ev of obs.events || []) {
        if ((ev.type === 'pickup' || ev.type === 'chest') && ev.x === t.x && ev.y === t.y) {
          if (ev.seat === seat) resolve('got');
          else resolve('lost', { by: ev.seat, behind: Math.max(0, distTo(t, me.x, me.y)) });
          return;
        }
      }
    },
    /** 本座位离场（到达 / 出局）或对局结束。 */
    finish(status) {
      if (!cur) return;
      resolve(cur.targetType === 'exit' && status === 'escaped' ? 'home' : 'open');
    },
  };
}

/**
 * 对手动向：history = 该对手最近若干回合的位置（旧 → 新）。返回正在靠近的目标（最多 2 个，缩短步数多的在前）。
 * 目标候选：场上宝石、宝箱、他自己的出口。
 */
export function headingOf(map, history, gems, chest, exit) {
  if (!history || history.length < 2) return [];
  const N = map.size;
  const [ox, oy] = history[0];
  const [nx, ny] = history[history.length - 1];
  const out = [];
  const consider = (type, x, y, extra = {}) => {
    const f = fieldFrom(map, y * N + x);
    const was = f[oy * N + ox];
    const now = f[ny * N + nx];
    if (was < 0 || now < 0) return;
    const closedBy = was - now;
    if (closedBy >= Math.max(2, Math.floor((history.length - 1) / 2))) out.push({ type, x, y, ...extra, closedBy, dist: now });
  };
  for (const g of gems) consider('gem', g.x, g.y, { color: g.color });
  if (chest && chest.present) consider('chest', chest.x, chest.y);
  if (exit) consider('exit', exit[0], exit[1]);
  out.sort((a, b) => b.closedBy - a.closedBy || a.dist - b.dist);
  return out.slice(0, 2);
}

/**
 * 会话文本（每次决策附在局面前面）：更早的决策折成一行摘要，最近 keep 条原样，最后是模型上次留的备忘。
 * @param {object[]} entries 追踪器条目
 */
export function sessionText(entries, memo, keep = 8) {
  const decided = entries;
  if (!decided.length && !memo) return '';
  const recent = decided.slice(-keep);
  const older = decided.slice(0, Math.max(0, decided.length - keep));
  const L = ['## 本局到目前为止（引擎记录你之前的决策与结局；越新越靠下）'];
  if (older.length) {
    const c = (o) => older.filter((e) => e.outcome === o).length;
    const wasted = older.reduce((a, e) => a + wastedOf(e), 0);
    const worst = older.filter((e) => e.outcome === 'lost').sort((a, b) => wastedOf(b) - wastedOf(a))[0];
    const worstW = worst ? wastedOf(worst) : 0;
    L.push(`更早的 ${older.length} 条：拿到 ${c('got')} · 被抢 ${c('lost')} · 放弃 ${c('abandoned')} · 改主意 ${c('switched')} · 不合格 / 作废 ${c('invalid') + c('stale') + c('failed')}；白跑共 ${wasted} 步${worst ? `；损失最大：T${worst.n} ${targetLabel(worst)} 被座位 ${worst.by} 抢走，白跑 ${worstW} 步` : ''}`);
  }
  for (const e of recent) {
    const head = `T${e.n}${e.src === 'queue' ? ' [队列]' : e.why ? ` [${whyText(e.why)}]` : ''}`;
    const what = e.target ? targetLabel(e) : '（无计划）';
    const reason = e.reason ? `「${e.reason}」` : '';
    L.push(`- ${head} ${what}${reason} → ${outcomeText(e)}`);
  }
  if (memo) L.push(`你上次写给自己的备忘：${memo}`);
  return L.join('\n');
}

/** 白跑最多的几次（被抢 / 主动放弃），给复盘与赛后写经验用。 */
export function keyMistakes(entries, k = 3) {
  return entries
    .filter((e) => wastedOf(e) > 0)
    .sort((a, b) => wastedOf(b) - wastedOf(a) || a.n - b.n)
    .slice(0, k)
    .map((e) => ({ ...e, text: `第 ${e.n} 回合去${e.targetType === 'chest' ? '开' : '拿'}${targetLabel(e)}：${outcomeText(e)}` }));
}

/** 复盘统计。 */
export function timelineStats(entries) {
  const c = (o) => entries.filter((e) => e.outcome === o).length;
  const kept = entries.reduce((a, e) => a + (e.kept || 0), 0);
  return {
    // 续走并入了原条目，所以决策次数要把续走次数加回来
    decisions: entries.filter((e) => e.src === 'llm' || e.src === 'llm-repair' || e.outcome === 'invalid' || e.outcome === 'stale' || e.outcome === 'failed').length + kept,
    got: c('got'), lost: c('lost'), abandoned: c('abandoned'), switched: c('switched'), guard: c('guard'),
    invalid: c('invalid'), stale: c('stale'), failed: c('failed'), kept,
    wasted: entries.reduce((a, e) => a + wastedOf(e), 0),
  };
}

// ───────── 跨局经验（赛后由模型自己写；超长时由模型自己压缩）─────────

const STATUS_ZH = { escaped: '到达出口', dead: '体力耗尽出局', timeout: '超时出局', active: '未结束' };

/** 一局的复盘摘要（写经验时给模型看）：结果、统计、关键失误、逐条决策。 */
export function matchDigest({ mapSize, size, turns, me, stats, mistakes, entries }) {
  const L = [
    `地图 ${mapSize}（${size}×${size}），共 ${turns} 回合。你的结果：${STATUS_ZH[me.status] || me.status}，${me.score} 分，第 ${me.place} 名。`,
    `决策 ${stats.decisions} 次（其中续走 ${stats.kept || 0} 次）：拿到 ${stats.got} · 被抢 ${stats.lost} · 主动放弃 ${stats.abandoned} · 改主意 ${stats.switched} · 引擎安全覆盖 ${stats.guard} · 不合格 ${stats.invalid} · 作废 ${stats.stale} · 失败 ${stats.failed}；白跑共 ${stats.wasted} 步（净绕路：顺路向出口的步数不算）。`,
  ];
  if (mistakes.length) L.push('损失最大的几次：', ...mistakes.map((m, k) => `${k + 1}. ${m.text}${m.reason ? `（当时的理由：${m.reason}）` : ''}`));
  L.push('逐条决策（回合 · 目标 · 理由 → 结局）：');
  for (const e of entries.slice(-40)) L.push(`- T${e.n}${e.src === 'queue' ? ' [队列]' : ''} ${e.target ? targetLabel(e) : '（无）'}${e.reason ? `「${e.reason}」` : ''} → ${outcomeText(e)}`);
  return L.join('\n');
}

/**
 * 赛后写经验的消息：旧经验 + 本局摘要 → 新经验（整份重写，不是追加）。
 * @param {{memory:string, strategy:string, digest:string, targetChars:number, games:number}} o
 */
export function buildMemoryMessages({ memory, strategy, digest, targetChars, games }) {
  return [
    {
      role: 'system',
      content: [
        '你是迷宫寻宝游戏里一个 AI 玩家的「教练」。每局结束后，你根据这局的复盘更新一份「经验」，下一局开局时它会原样放进这个 AI 的提示词。',
        '游戏要点：四人同时行动，只选目标（宝石 / 宝箱 / 出口），寻路由引擎完成；对手位置全公开、目标不公开；只有到达自己的出口才算成绩。',
        '写法要求：',
        `- 输出整份新经验（不是增量），中文，不超过 ${targetChars} 字；用短条目，每条一句可执行的判断规则，例如「lead ≤ -2 的宝石不要去」。`,
        '- 保留旧经验里仍然成立的，修正被这局证伪的，补上这局学到的；不要写具体坐标和种子（下一局地图不同）。',
        '- 只写对下一局有用的规律，不要复述比分，不要写客套话。',
        '- 玩家思路是玩家定的，经验不能和它对着干；经验只补充「怎么执行得更好」。',
        '只输出经验正文，不要任何前言、标题或代码块。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `## 旧经验（已累计 ${games} 局）`, memory.trim() || '（还没有）',
        '## 玩家思路', strategy.trim() || '（未写）',
        '## 这局复盘', digest,
      ].join('\n'),
    },
  ];
}

/** 经验超长时让模型压缩。 */
export function buildCompressMessages(text, targetChars) {
  return [
    { role: 'system', content: `把下面这份游戏经验压缩到不超过 ${targetChars} 字：合并重复、删掉不确定或过于具体的条目，保留最有用的判断规则。只输出压缩后的正文。` },
    { role: 'user', content: text },
  ];
}

/** 模型回复 → 经验正文（去掉代码块围栏与首尾空白）。 */
export function cleanMemoryReply(text) {
  return String(text ?? '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
}

const colorAt = (state, cfg, x, y) => {
  const g = state.gems.find((q) => q.x === x && q.y === y);
  return g ? cfg.treasure.gemColors[g.c] : null;
};

/**
 * 由对局记录重放出某座位每次决策的结局（与对局中 planner 的追踪同一套规则）。
 * @param {string} jsonl 对局记录
 * @param {object} cfg 记录对应的配置（configHash 必须一致；调用方用 config/known.js 找回）
 * @returns {{entries:object[], stats:object, mistakes:object[]}}
 */
export function timelineFromRecord(jsonl, cfg, seat = 0) {
  const lines = String(jsonl).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const meta = lines[0];
  const { map, state: s0 } = createMatch(meta.seed, cfg);
  let state = s0;
  const tr = createTracker(map, seat);
  const obsOf = (events) => observe(map, state, seat, cfg, { patch: false, events });
  tr.observe(obsOf([]));
  let finished = false;
  for (const L of lines.slice(1)) {
    if (L.t === 'plan' && L.seat === seat) {
      const p = L.plan || null;
      const base = { n: L.n, req: L.req ?? null, src: L.src, why: L.why ?? null };
      if (L.src === 'llm' || L.src === 'llm-repair' || L.src === 'queue' || L.src === 'guard') {
        if (!p || !p.target) continue;
        const e = {
          ...base, targetType: p.targetType, target: { x: p.target.x, y: p.target.y },
          color: p.targetType === 'gem' ? colorAt(state, cfg, p.target.x, p.target.y) : null,
          reason: p.reason ?? '', follow: p.follow ?? null, deviation: p.deviation ?? '', memo: p.memo ?? '',
          then: Array.isArray(p.then) ? p.then.length : 0, abandonIf: p.abandonIf ?? null, ...(p.keep ? { keep: true } : {}),
        };
        tr.start(e, L.src === 'guard' ? 'guard' : L.src === 'queue' ? 'got' : 'switched');
      } else if (L.src === 'abandon') {
        tr.abandon(L.err || '放弃条件触发');
      } else {
        tr.note({ ...base, outcome: L.src, err: L.err ?? '', targetType: p ? p.targetType : null, target: p && p.target ? p.target : null, reason: p ? p.reason ?? '' : '' });
      }
    } else if (L.t === 'turn') {
      const r = step(map, state, decodeIntents(L.i), cfg);
      state = r.state;
      tr.observe(obsOf(r.events));
      const me = state.actors[seat];
      if (!finished && me.status !== 'active') {
        tr.finish(me.status);
        finished = true;
      }
    }
  }
  if (!finished) tr.finish(state.actors[seat].status);
  return { entries: tr.entries, stats: timelineStats(tr.entries), mistakes: keyMistakes(tr.entries) };
}
