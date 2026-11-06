// 思路试跑（批次 6 P3）：用玩家自己的模型，在一批固定种子上跑整局，量化「这版思路 / 这个模型 / 这个思考档位」打得怎么样。
// 浏览器（设置页「思路试跑」「A/B 对比」，经服务器中转）与 Node 命令行（maze-eval --llm，直连服务商）共用。
// 不碰 DOM / Node API：模型调用由调用方注入 makeTransport，脚本对手由 makeScript 注入（同步或异步控制器都行）。
//
// 陪练默认三个「预判对手」脚本（用户裁定：陪练强度保持脚本，不花玩家的钱）。
// 每局：名次 / 分数 / 状态 + 复盘统计（决策、拿到、被抢、放弃、白跑）+ 关键失误 + token；汇总：到达率、均分、冠军率、白跑、token。
// A/B：同一批种子跑两个变体，按种子配对算分差的均值与标准误（|均值| > 2 × 标准误才算「超出噪声」）。

import { makeConfig } from '../../config/default.config.js';
import { MAP_SIZES, isMapSize, matchOverrides } from '../../config/map-sizes.js';
import { createScheduler } from '../../app/scheduler.js';
import { createMatch } from '../../core/state.js';
import { rankActors } from '../../core/scoring.js';
import { fnv1a, hex8 } from '../../core/hash.js';
import { createHeuristic } from '../../ai/heuristic.js';
import { createAgentPool, createPlanner } from '../../ai/planner.js';
import { timelineFromRecord } from '../../ai/harness.js';
import { parseSeeds, seatTag, scriptMeta } from './run-eval.js';

/** 每局大约几次决策（按规格，实测量级），估算费用用。 */
const DECISIONS = Object.freeze({ XS: 12, S: 20, M: 35, L: 50, XL: 60 });
/** 每次决策的输入 token（局面 + 事实表 + 会话 + 提示词）与输出 token（按思考档位，含思考）。 */
const IN_TOKENS = Object.freeze({ XS: 2500, S: 3000, M: 3600, L: 4000, XL: 4300 });
// 实测（2026-11-06，DeepSeek 低思考 XS）：每次约 2.2k 输入、2.7k 输出（含思考）
const OUT_TOKENS = Object.freeze({ off: 200, low: 2800, high: 6000 });
/** 每次决策大约几秒（不同模型差很多，取保守值）。 */
const SECONDS = Object.freeze({ off: 4, low: 8, high: 45 });

/** 开跑前的估算（给玩家确认）。 */
export function estimateTrial({ size, games, thinking = 'low', variants = 1 }) {
  const d = DECISIONS[size] ?? 30;
  const calls = Math.round(d * 1.15) * games * variants; // 含修复
  return {
    calls,
    tokensIn: calls * (IN_TOKENS[size] ?? 3500),
    tokensOut: calls * (OUT_TOKENS[thinking] ?? 700),
    minutes: Math.ceil((d * (SECONDS[thinking] ?? 8) * games * variants) / 60 / 2), // 两局并行
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一个变体。
 * @param {{size:string, seeds:string|Array, variant:{name?:string, strategy:string, autonomy?:string, safetyGate?:boolean, thinking?:string, memory?:string},
 *          opponents?:object[], makeTransport:(o:{seed:number, matchId:string, onCall:Function})=>Function,
 *          makeScript:(o:{spec:object, seat:number, match:object, cfg:object})=>object|Promise<object>,
 *          concurrency?:number, onProgress?:(done:number, total:number, game?:object)=>void, signal?:{aborted:boolean}}} o
 */
export async function runLlmTrial(o) {
  const size = o.size || 'XS';
  if (!isMapSize(size)) throw new Error(`未知地图规格 ${size}（可选 ${Object.keys(MAP_SIZES).join(' / ')}）`);
  const cfg = makeConfig(matchOverrides('byok', size));
  const seeds = parseSeeds(o.seeds || '1-5');
  const v = { autonomy: 'blend', safetyGate: true, thinking: 'low', memory: '', name: '思路', ...o.variant };
  const opponents = o.opponents || [];
  const games = new Array(seeds.length);
  let next = 0;
  let done = 0;
  const one = async (k) => {
    const seed = seeds[k];
    const match = createMatch(seed, cfg);
    const matchId = `trial${hex8(fnv1a(`${v.name}|${seed}|${size}`))}${hex8(fnv1a(String(Date.now() + k)))}`.padEnd(24, '0');
    const calls = { n: 0, failed: 0, in: 0, out: 0, reasoning: 0, ms: 0 };
    const transport = o.makeTransport({
      seed, matchId,
      onCall: (i) => {
        calls.n++;
        if (!i.ok) calls.failed++;
        calls.ms += i.ms || 0;
        if (i.usage) {
          calls.in += i.usage.in | 0;
          calls.out += i.usage.out | 0;
          calls.reasoning += i.usage.reasoning | 0;
        }
      },
    });
    const ctrls = [createPlanner({
      map: match.map, seat: 0, cfg, seed: match.seed, pool: createAgentPool(cfg), persona: v.strategy,
      autonomy: v.autonomy, safetyGate: v.safetyGate !== false, memory: v.memory || '', transport,
    })];
    const scripts = [];
    for (let s = 1; s < 4; s++) {
      const spec = opponents[s - 1] || { kind: 'heuristic' };
      if (spec.kind === 'script') {
        ctrls.push(await o.makeScript({ spec, seat: s, match, cfg }));
        scripts.push(scriptMeta(spec, s));
      } else ctrls.push(createHeuristic(match.map, s, cfg, match.seed));
    }
    const sched = createScheduler(cfg, seed, {
      match, controllers: ctrls, scripts,
      // 与游戏内同一种标签（服务器 SEAT_TAG 只认 ASCII）：byok:<服务商>/<模型>
      seatLabels: [`byok:${v.provider || 'trial'}/${v.model || 'model'}`.replace(/[^a-z0-9:_./-]/gi, '_').slice(0, 64), ...[1, 2, 3].map((s) => seatTag(opponents[s - 1] || { kind: 'heuristic' }, s))],
      players: [{ seat: 0, provider: v.provider || 'trial', model: v.model || 'model', autonomy: v.autonomy, safetyGate: v.safetyGate !== false, strategyHash: hex8(fnv1a(v.strategy || '')), thinking: v.thinking }],
    });
    try {
      while (!sched.state.ended) {
        if (o.signal && o.signal.aborted) throw new Error('已取消');
        sched.runSync(0, 5000);
        if (!sched.state.ended) await sleep(25);
      }
    } finally {
      for (const c of ctrls) if (c && c.dispose) c.dispose();
    }
    const ranking = rankActors(sched.state.actors, cfg);
    const me = ranking.find((r) => r.seat === 0);
    const jsonl = sched.toJSONL();
    const tl = timelineFromRecord(jsonl, cfg, 0);
    const rep = ctrls[0].report();
    return {
      seed, place: me.place, score: me.status === 'escaped' ? me.score : 0, rawScore: me.score, status: me.status, champion: Boolean(me.champion),
      turns: sched.state.endTurn, stats: tl.stats, mistakes: tl.mistakes.map((m) => m.text), follow: rep.follow, guard: rep.guard,
      queued: rep.queued, abandons: rep.abandons, l3: ctrls[0].status().l3, calls, jsonl,
    };
  };
  const worker = async () => {
    while (next < seeds.length) {
      const k = next++;
      games[k] = await one(k);
      done++;
      if (o.onProgress) o.onProgress(done, seeds.length, games[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency || 2, seeds.length)) }, worker));
  return { size, variant: { ...v, memory: v.memory ? `${Array.from(v.memory).length} 字` : '' }, games, summary: summarize(games) };
}

export function summarize(games) {
  const n = games.length || 1;
  const sum = (f) => games.reduce((a, g) => a + f(g), 0);
  return {
    games: games.length,
    escapeRate: sum((g) => (g.status === 'escaped' ? 1 : 0)) / n,
    avgScore: sum((g) => g.score) / n,
    avgPlace: sum((g) => g.place) / n,
    championRate: sum((g) => (g.champion ? 1 : 0)) / n,
    avgWasted: sum((g) => g.stats.wasted) / n,
    avgDecisions: sum((g) => g.stats.decisions) / n,
    lostRate: sum((g) => g.stats.lost) / Math.max(1, sum((g) => g.stats.got + g.stats.lost)),
    calls: sum((g) => g.calls.n),
    failed: sum((g) => g.calls.failed),
    tokensIn: sum((g) => g.calls.in),
    tokensOut: sum((g) => g.calls.out),
    l3: games.filter((g) => g.l3).length,
  };
}

/** A/B：按种子配对，分差均值与标准误。 */
export function compareTrials(a, b) {
  const byA = new Map(a.games.map((g) => [g.seed, g]));
  const pairs = b.games.filter((g) => byA.has(g.seed)).map((g) => g.score - byA.get(g.seed).score);
  const n = pairs.length;
  const mean = n ? pairs.reduce((x, y) => x + y, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(pairs.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : Infinity;
  return { pairs: n, meanDiff: mean, se, beyondNoise: n > 1 && Math.abs(mean) > 2 * se, bWins: pairs.filter((d) => d > 0).length, aWins: pairs.filter((d) => d < 0).length };
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

/** 结果 → Markdown（浏览器显示 / 命令行输出共用）。 */
export function trialMarkdown(r, b = null) {
  const L = [];
  const row = (name, s) => `| ${name} | ${s.games} | ${pct(s.escapeRate)} | ${f1(s.avgScore)} | ${f1(s.avgPlace)} | ${pct(s.championRate)} | ${f1(s.avgWasted)} | ${pct(s.lostRate)} | ${s.calls}${s.failed ? `（失败 ${s.failed}）` : ''} | ${Math.round(s.tokensIn / 1000)}k / ${Math.round(s.tokensOut / 1000)}k |`;
  L.push(`## 思路试跑 · ${r.size} · ${r.games.length} 局 · 陪练：预判对手 × 3`);
  L.push('| 变体 | 局数 | 到达率 | 均分（未到达计 0） | 均名次 | 冠军率 | 白跑步数 | 被抢率 | 调用 | token 入 / 出 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  L.push(row(`A · ${r.variant.name}`, r.summary));
  if (b) L.push(row(`B · ${b.variant.name}`, b.summary));
  if (b) {
    const c = compareTrials(r, b);
    L.push(`> B − A：每局分差均值 **${c.meanDiff >= 0 ? '+' : ''}${f1(c.meanDiff)}**（标准误 ${f1(c.se)}，B 赢 ${c.bWins} 局 / A 赢 ${c.aWins} 局）· ${c.beyondNoise ? '**超出噪声**' : '还在噪声范围内，多跑几局再下结论'}`);
  }
  for (const [tag, x] of b ? [['A', r], ['B', b]] : [['', r]]) {
    if (x.summary.l3) L.push(`> ${tag ? `${tag}：` : ''}${x.summary.l3} 局里模型中途熔断（之后由启发式接着打），结果偏低`);
    L.push(`## 每局${tag ? ` · ${tag}` : ''}`);
    L.push('| 种子 | 结果 | 名次 | 决策 | 拿到 / 被抢 / 放弃 | 白跑 | 损失最大的一次 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const g of x.games) {
      L.push(`| ${g.seed} | ${g.status === 'escaped' ? `到达 ${g.rawScore} 分` : '出局'} | ${g.place} | ${g.stats.decisions} | ${g.stats.got} / ${g.stats.lost} / ${g.stats.abandoned} | ${g.stats.wasted} | ${g.mistakes[0] ? g.mistakes[0].replace(/\|/g, '/') : '—'} |`);
    }
  }
  return L.join('\n');
}
