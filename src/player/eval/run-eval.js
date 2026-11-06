// 整局评测（统一编程接口 v2）：Node 命令行 maze-eval 与浏览器「整局试跑」共用。
// 不碰 DOM / Node API：脚本座位的控制器由调用方注入（makeScript），Node 用 vm 适配器、浏览器用试跑 Worker 内的同步运行时。
//
// 座位配置：{kind:'script', code, name?, author?, origin?} | {kind:'heuristic'} | {kind:'mock', persona}
// 输出：各座位到达率 / 得分 / 名次、主角座位与启发式基线的差、每回合耗时分位数、按正式预算会超时的回合、异常、最差几局。

import { makeConfig } from '../../config/default.config.js';
import { MAP_SIZES, isMapSize, matchOverrides } from '../../config/map-sizes.js';
import { DEFAULT_VISION, VISION_IDS, VISION_PRESETS, isVision } from '../../config/vision-modes.js';
import { createScheduler } from '../../app/scheduler.js';
import { createMockTransport } from '../../app/transport.js';
import { createMatch } from '../../core/state.js';
import { normalizeSeed } from '../../core/rng.js';
import { rankActors } from '../../core/scoring.js';
import { fnv1a, hex8 } from '../../core/hash.js';
import { createHeuristic } from '../../ai/heuristic.js';
import { createAgentPool, createPlanner } from '../../ai/planner.js';
import { PERSONAS } from '../../ai/mock-llm.js';

export const codeHash = (code) => hex8(fnv1a(String(code ?? '')));

/** 座位标签（与游戏内一致：座位 0 的脚本 = 'script'，其余 = 'script:<hash8>'）。 */
export function seatTag(spec, seat) {
  if (spec.kind === 'script') return seat === 0 ? 'script' : `script:${codeHash(spec.code)}`;
  if (spec.kind === 'mock') return `mock:${spec.persona}`;
  return 'heuristic';
}

export const scriptMeta = (spec, seat) => ({
  seat,
  name: String(spec.name || '未命名脚本').slice(0, 40),
  author: String(spec.author || '').slice(0, 40),
  origin: ['human', 'agent', 'builtin'].includes(spec.origin) ? spec.origin : 'human',
  codeHash: codeHash(spec.code),
});

/** "1-20" / "1,5,9" / ["a","b"] → 种子数组（数字串按数字，其余按字符串哈希）。 */
export function parseSeeds(spec) {
  if (Array.isArray(spec)) return spec.map((s) => normalizeSeed(/^\d+$/.test(String(s)) ? Number(s) : String(s)));
  const out = [];
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m) for (let k = Number(m[1]); k <= Number(m[2]); k++) out.push(k >>> 0);
    else out.push(normalizeSeed(/^\d+$/.test(part) ? Number(part) : part));
  }
  return out;
}

function buildController(spec, seat, match, cfg, pool, mock, makeScript) {
  if (spec.kind === 'script') return makeScript({ spec, seat, match, cfg });
  if (spec.kind === 'mock') {
    const persona = PERSONAS[spec.persona] ? spec.persona : 'balanced';
    return createPlanner({ map: match.map, seat, cfg, seed: match.seed, pool, persona: PERSONAS[persona].text, transport: mock });
  }
  return createHeuristic(match.map, seat, cfg, match.seed);
}

function playOne(cfg, seed, seats, makeScript, keepRecord) {
  const match = createMatch(seed, cfg);
  const pool = createAgentPool(cfg);
  const mock = createMockTransport({ isFast: () => true });
  const ctrls = seats.map((sp, i) => buildController(sp, i, match, cfg, pool, mock, makeScript));
  const sched = createScheduler(cfg, seed, {
    match, controllers: ctrls, seatLabels: seats.map(seatTag),
    scripts: seats.map((sp, i) => (sp.kind === 'script' ? scriptMeta(sp, i) : null)).filter(Boolean),
  });
  sched.runSync(0, cfg.rules.maxTurns + 10);
  const s = sched.state;
  if (!s.ended) throw new Error(`种子 ${seed}：对局没有在同步模式下结束（有异步控制器？）`);
  const ranking = rankActors(s.actors, cfg);
  const bySeat = new Map(ranking.map((r) => [r.seat, r]));
  const out = {
    seed: match.seed,
    turns: s.endTurn,
    seats: s.actors.map((a) => {
      const r = bySeat.get(a.seat);
      const c = ctrls[a.seat];
      return {
        seat: a.seat, status: a.status, failReason: a.failReason || null, score: r.score, place: r.place, champion: r.champion,
        stamina: a.stamina, escapedTurn: a.escapedTurn || null, script: c && c.report ? c.report() : null,
      };
    }),
  };
  if (keepRecord) out.record = sched.toJSONL();
  for (const c of ctrls) if (c && c.dispose) c.dispose();
  return out;
}

const q = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const round = (v, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

function summarizeSeat(games, seat) {
  const rows = games.map((g) => g.seats[seat]);
  const n = rows.length || 1;
  const esc = rows.filter((r) => r.status === 'escaped');
  const sum = {
    games: rows.length,
    escapeRate: round(esc.length / n, 3),
    avgScore: round(esc.reduce((a, r) => a + r.score, 0) / n), // 未到达者成绩作废，按 0 计
    avgScoreEscaped: esc.length ? round(esc.reduce((a, r) => a + r.score, 0) / esc.length) : 0,
    avgPlace: round(rows.reduce((a, r) => a + r.place, 0) / n),
    winRate: round(rows.filter((r) => r.champion).length / n, 3),
    failReasons: rows.reduce((m, r) => (r.failReason ? ((m[r.failReason] = (m[r.failReason] || 0) + 1), m) : m), {}),
  };
  const scripts = rows.map((r) => r.script).filter(Boolean);
  if (scripts.length) {
    const ms = scripts.flatMap((x) => x.samples || []);
    sum.script = {
      msP50: round(q(ms, 0.5)), msP95: round(q(ms, 0.95)), msMax: round(ms.length ? Math.max(...ms) : 0),
      initMsMax: Math.max(...scripts.map((x) => x.initMs || 0)),
      overBudgetTurns: scripts.reduce((a, x) => a + (x.timeouts || 0), 0),
      overBudgetGames: scripts.filter((x) => x.timeouts > 0).length,
      hard: scripts.reduce((a, x) => a + x.hard, 0),
      soft: scripts.reduce((a, x) => a + x.soft, 0),
      resets: scripts.reduce((a, x) => a + x.resets, 0),
      warns: scripts.reduce((a, x) => a + (x.warns || 0), 0),
      usedClock: scripts.some((x) => x.usedClock),
      initError: scripts.find((x) => x.initError)?.initError ?? null,
      errors: rows.flatMap((r, k) => (r.script && r.script.errors ? r.script.errors.map((e) => ({ seed: games[k].seed, ...e })) : [])).slice(0, 5),
    };
  }
  return sum;
}

/**
 * @param {{size?:string, seeds:Array<number>|string, seats:object[], makeScript:(o:object)=>object, subject?:number,
 *          baseline?:boolean, worst?:number, keepRecords?:boolean, onProgress?:(done:number, total:number)=>void}} o
 */
export function runEval({ size = 'XS', vision = DEFAULT_VISION, seeds, seats, makeScript, subject = null, baseline = true, worst = 5, keepRecords = false, onProgress = null }) {
  if (!isMapSize(size)) throw new Error(`未知地图规格 ${size}（可选 ${Object.keys(MAP_SIZES).join(' / ')}）`);
  if (!isVision(vision)) throw new Error(`未知视野规则 ${vision}（可选 ${VISION_IDS.join(' / ')}）`);
  if (!Array.isArray(seats) || seats.length !== 4) throw new Error('seats 必须是 4 个座位配置');
  const list = parseSeeds(seeds);
  if (!list.length) throw new Error('没有种子');
  const cfg = makeConfig(matchOverrides('script', size, vision));
  const subj = subject ?? Math.max(0, seats.findIndex((s) => s.kind === 'script'));
  const total = list.length * (baseline && seats[subj].kind === 'script' ? 2 : 1);
  let done = 0;
  const tick = () => onProgress && onProgress(++done, total);

  const t0 = Date.now();
  const games = list.map((seed) => {
    const g = playOne(cfg, seed, seats, makeScript, keepRecords);
    tick();
    return g;
  });
  const result = {
    size, vision, mapSize: cfg.maze.size, seeds: list.length, subject: subj,
    rules: { stamina: cfg.rules.staminaByMode.script, maxTurns: cfg.rules.maxTurns },
    seats: seats.map((sp, i) => ({ seat: i, kind: sp.kind, label: sp.kind === 'script' ? scriptMeta(sp, i).name : sp.kind === 'mock' ? `模拟大模型·${sp.persona}` : '启发式', ...summarizeSeat(games, i) })),
    turnsP50: q(games.map((g) => g.turns), 0.5),
    worst: games
      .map((g) => ({ seed: g.seed, turns: g.turns, ...g.seats[subj], script: undefined, overBudget: g.seats[subj].script ? g.seats[subj].script.timeouts : 0 }))
      .sort((a, b) => (a.status === 'escaped' ? a.score : -1) - (b.status === 'escaped' ? b.score : -1) || b.place - a.place || a.seed - b.seed)
      .slice(0, worst)
      .map(({ script, ...r }) => r),
  };
  if (baseline && seats[subj].kind === 'script') {
    const alt = seats.map((s, i) => (i === subj ? { kind: 'heuristic' } : s));
    const bgames = list.map((seed) => {
      const g = playOne(cfg, seed, alt, makeScript, false);
      tick();
      return g;
    });
    const b = summarizeSeat(bgames, subj);
    const me = result.seats[subj];
    result.baseline = {
      escapeRate: b.escapeRate, avgScore: b.avgScore, avgPlace: b.avgPlace, winRate: b.winRate,
      delta: { escapeRate: round(me.escapeRate - b.escapeRate, 3), avgScore: round(me.avgScore - b.avgScore), avgPlace: round(me.avgPlace - b.avgPlace), winRate: round(me.winRate - b.winRate, 3) },
    };
  }
  result.wallMs = Date.now() - t0;
  if (keepRecords) result.records = games.map((g) => ({ seed: g.seed, jsonl: g.record }));
  return result;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const sign = (v, f = (x) => x) => `${v > 0 ? '+' : ''}${f(v)}`;
const STATUS_ZH = { escaped: '到达', failed: '出局' };

/** 结果 → Markdown（命令行与「整局试跑」同一份文字）。 */
export function renderMarkdown(r) {
  const L = [];
  L.push(`## 整局评测 · ${r.size}（${r.mapSize}×${r.mapSize}）· 视野 ${VISION_PRESETS[r.vision || DEFAULT_VISION].label} · ${r.seeds} 局 · 体力 ${r.rules.stamina} · 上限 ${r.rules.maxTurns} 回合`);
  L.push('');
  L.push('| 座位 | 控制 | 到达率 | 平均分（未到达计 0） | 到达者均分 | 平均名次 | 冠军率 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of r.seats) L.push(`| ${s.seat}${s.seat === r.subject ? ' ★' : ''} | ${s.label} | ${pct(s.escapeRate)} | ${s.avgScore} | ${s.avgScoreEscaped} | ${s.avgPlace} | ${pct(s.winRate)} |`);
  if (r.baseline) {
    const d = r.baseline.delta;
    L.push('');
    L.push(`**与启发式基线比**（座位 ${r.subject} 换成启发式、其余不变、同一批种子）：到达率 ${sign(d.escapeRate, pct)} · 平均分 ${sign(d.avgScore)} · 平均名次 ${sign(d.avgPlace)}（越小越好）· 冠军率 ${sign(d.winRate, pct)}`);
  }
  const sc = r.seats.filter((s) => s.script);
  if (sc.length) {
    L.push('');
    L.push('| 座位 | 每回合耗时 P50 / P95 / 最大 (ms) | init 最长 | 按正式预算会超时 | 硬异常 | 软异常 | 重建 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const s of sc) {
      const x = s.script;
      L.push(`| ${s.seat} | ${x.msP50} / ${x.msP95} / ${x.msMax} | ${x.initMsMax} ms | ${x.overBudgetTurns} 回合（${x.overBudgetGames} 局） | ${x.hard} | ${x.soft} | ${x.resets} |`);
      if (x.initError) L.push(`> 座位 ${s.seat} init 出错：${x.initError}`);
      for (const e of x.errors || []) L.push(`> 座位 ${s.seat} · 种子 ${e.seed} · 第 ${e.turn} 回合 · ${e.kind === 'hard' ? '硬异常' : '软异常'}：${e.msg}`);
      if (x.usedClock) L.push(`> 座位 ${s.seat} 调用了 api.elapsed()：按时间截断的算法在不同机器上结果会不同`);
    }
    L.push('');
    L.push('预算：每回合 50 ms + 时间银行（上限 5000 ms），init 2000 ms。评测默认不打断，只统计会超时的回合；实时对局里超时的回合作废，沿意图兜底。');
  }
  if (r.worst.length) {
    L.push('');
    L.push(`**最差 ${r.worst.length} 局**（座位 ${r.subject}）：`);
    for (const w of r.worst) L.push(`- 种子 ${w.seed}：${STATUS_ZH[w.status] || w.status}${w.failReason ? `（${w.failReason === 'stamina' ? '体力耗尽' : '回合上限'}）` : ''} · ${w.score} 分 · 第 ${w.place} 名 · ${w.turns} 回合${w.overBudget ? ` · 超时 ${w.overBudget} 回合` : ''}`);
  }
  L.push('');
  L.push(`用时 ${(r.wallMs / 1000).toFixed(1)} s · 回合 P50 ${r.turnsP50}`);
  return L.join('\n');
}
