#!/usr/bin/env node
// 新内核平衡基线（SPEC-0.1 规则 · 四座位均为兜底启发式 AI）。
// 用法：node tools/bench.mjs [--n 300] [--seed0 1] [--stamina 400] [--respawn 2] [--setBonus 5] [--gemsPerColor 1] [--maxTurns 600] [--json]
// 输出自报口径：（出口=边中点就近, 宝石=5/代, 竞争=四人启发式, 目标墙密度, 体力, 实现=src/core）

import { makeConfig } from '../src/config/default.config.js';
import { runMatch } from '../src/sim/headless.js';
import { createStream, next } from '../src/core/rng.js';
import { gemTotal, setsOf } from '../src/core/scoring.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = v; i++; }
}
const n = Number(args.n ?? 300);
const seed0 = Number(args.seed0 ?? 1);
const over = {};
if (args.stamina) over.rules = { staminaByMode: { manual: +args.stamina, prompt: +args.stamina, script: +args.stamina } };
if (args.maxTurns) over.rules = { ...(over.rules ?? {}), maxTurns: +args.maxTurns };
if (args.respawn !== undefined || args.setBonus !== undefined || args.gemsPerColor !== undefined) {
  over.treasure = {};
  if (args.respawn !== undefined) over.treasure.gemRespawnMax = +args.respawn;
  if (args.setBonus !== undefined) over.treasure.setBonus = +args.setBonus;
  if (args.gemsPerColor !== undefined) over.treasure.gemsPerColor = +args.gemsPerColor;
}
const cfg = makeConfig(over);

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pc = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');

/** 按局聚类的自助法 CI（确定性 RNG） */
function clusterCI(perGame, B = 1000) {
  const st = createStream(0xC0FFEE);
  const vals = [];
  for (let b = 0; b < B; b++) {
    let num = 0;
    let den = 0;
    for (let k = 0; k < perGame.length; k++) {
      const g = perGame[Math.floor(next(st) * perGame.length)];
      num += g[0];
      den += g[1];
    }
    vals.push(num / den);
  }
  return [pct(vals, 0.025), pct(vals, 0.975)];
}

const G = [];
const t0 = performance.now();
for (let k = 0; k < n; k++) {
  const seed = seed0 + k;
  const tg = performance.now();
  const r = runMatch(seed, cfg);
  const ms = performance.now() - tg;
  G.push({ seed, r, ms });
}
const totalMs = performance.now() - t0;

const actors = G.flatMap(({ r }) => r.state.actors.map((a) => ({ a, r })));
const escaped = actors.filter(({ a }) => a.status === 'escaped');
const failedStamina = actors.filter(({ a }) => a.status === 'failed' && a.failReason === 'stamina');
const failedMaxTurns = actors.filter(({ a }) => a.status === 'failed' && a.failReason === 'maxTurns');
const gemsPer = actors.map(({ a }) => gemTotal(a.gems));
const setsPer = actors.map(({ a }) => setsOf(a.gems));
const scores = actors.map(({ a, r }) => r.ranking.find((x) => x.seat === a.seat).score);
const endTurns = G.map(({ r }) => r.state.endTurn);
const activeTurns = G.reduce((s, { r }) => s + r.stats.activeTurns.reduce((x, y) => x + y, 0), 0);
const blocked = G.reduce((s, { r }) => s + r.stats.blocked.reduce((x, y) => x + y, 0), 0);
const homeTurns = G.reduce((s, { r }) => s + r.stats.homeTurns.reduce((x, y) => x + y, 0), 0);
const contests = G.reduce((s, { r }) => s + r.stats.contests, 0);
const cycles = G.reduce((s, { r }) => s + r.stats.cycles, 0);
const deferred = G.reduce((s, { r }) => s + r.stats.deferred, 0);
const remain = escaped.map(({ a }) => a.stamina / a.staminaMax);
const escCI = clusterCI(G.map(({ r }) => [r.state.actors.filter((a) => a.status === 'escaped').length, r.state.actors.length]));
const gamesWithFail = G.filter(({ r }) => r.state.actors.some((a) => a.status !== 'escaped')).length;
const champions = G.map(({ r }) => r.ranking.filter((x) => x.champion).length);
const attempts = G.map(({ r }) => r.match.attempts);
const rejects = {};
for (const { r } of G) for (const x of r.match.rejects) rejects[x] = (rejects[x] ?? 0) + 1;
const dens = G.map(({ r }) => r.match.map.density);
const spawnExit = G.flatMap(({ r }) => Array.from(r.match.map.spawnExit));
const gens = G.map(({ r }) => r.state.gemGeneration);
const chestOpens = G.map(({ r }) => r.state.actors.reduce((s, a) => s + a.chestOpens, 0));
const allGemsTaken = G.filter(({ r }) => r.state.gemRespawnsLeft === 0 && r.state.gems.length === 0).length;
const seatRows = [0, 1, 2, 3].map((seat) => {
  const xs = actors.filter(({ a }) => a.seat === seat);
  return {
    seat,
    esc: xs.filter(({ a }) => a.status === 'escaped').length / xs.length,
    gems: mean(xs.map(({ a }) => gemTotal(a.gems))),
    score: mean(xs.map(({ a, r }) => r.ranking.find((x) => x.seat === a.seat).score)),
    win: G.filter(({ r }) => r.ranking.some((x) => x.champion && x.seat === seat)).length / G.length,
  };
});
const setDist = [0, 1, 2, 3].map((k) => setsPer.filter((s) => s === k).length / setsPer.length);
const stamina0 = cfg.rules.staminaByMode[cfg.match.playerMode];

const report = {
  caliber: {
    exits: 'edge-mid-nearest',
    gemsPerGeneration: cfg.treasure.gemColors.length * cfg.treasure.gemsPerColor,
    generations: 1 + cfg.treasure.gemRespawnMax,
    setBonus: cfg.treasure.setBonus,
    competition: '4×heuristic',
    wallDensityTarget: cfg.maze.wallDensityTarget,
    stamina: stamina0,
    maxTurns: cfg.rules.maxTurns,
    impl: `src/core ${cfg.rulesVersion}`,
    games: n,
    seeds: [seed0, seed0 + n - 1],
  },
  map: {
    attemptsMean: mean(attempts),
    rerollGames: attempts.filter((a) => a > 1).length / n,
    rejects,
    density: [mean(dens), Math.min(...dens), Math.max(...dens)],
    spawnExit: { mean: mean(spawnExit), p95: pct(spawnExit, 0.95), max: Math.max(...spawnExit) },
  },
  outcome: {
    escapeRate: escaped.length / actors.length,
    escapeCI95: escCI,
    failStamina: failedStamina.length / actors.length,
    failMaxTurns: failedMaxTurns.length / actors.length,
    gamesWithAnyFailure: gamesWithFail / n,
    noChampionGames: champions.filter((c) => c === 0).length / n,
    tiedChampionGames: champions.filter((c) => c > 1).length / n,
  },
  treasure: {
    gemsPerActor: mean(gemsPer),
    zeroGemRate: gemsPer.filter((g) => g === 0).length / gemsPer.length,
    setsDist: setDist,
    scoreMean: mean(scores),
    scoreP50: pct(scores, 0.5),
    chestOpensPerGame: mean(chestOpens),
    generationsReachedMean: mean(gens),
    allGemsTakenGames: allGemsTaken / n,
    respawnDeferrals: deferred,
  },
  tempo: {
    turnsP50: pct(endTurns, 0.5),
    turnsP95: pct(endTurns, 0.95),
    turnsMax: Math.max(...endTurns),
    remainStaminaEscapees: { p10: pct(remain, 0.1), p50: pct(remain, 0.5), p90: pct(remain, 0.9) },
    blockedTurnShare: blocked / activeTurns,
    contestsPerGame: contests / n,
    cyclesPerGame: cycles / n,
    homeTurnShare: homeTurns / activeTurns,
  },
  seats: seatRows,
  perf: { msPerGame: totalMs / n },
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.caliber;
  console.log(`# bench · 口径（出口=边中点就近, 宝石=${c.gemsPerGeneration}/代×${c.generations}代 成套+${c.setBonus}, 竞争=${c.competition}, 目标墙密度=${c.wallDensityTarget}）· 体力=${c.stamina} · maxTurns=${c.maxTurns} · 实现=${c.impl} · ${n} 局 seed ${c.seeds[0]}..${c.seeds[1]}`);
  const m = report.map;
  console.log(`地图   | 尝试均值 ${f2(m.attemptsMean)} | 有重掷的局 ${pc(m.rerollGames)} | 拒因 ${JSON.stringify(m.rejects)} | 密度 ${m.density.map((x) => x.toFixed(4)).join(' / ')} | spawn→exit 均 ${f1(m.spawnExit.mean)} P95 ${m.spawnExit.p95} max ${m.spawnExit.max}`);
  const o = report.outcome;
  console.log(`结局   | 到达率 ${pc(o.escapeRate)} [CI ${pc(o.escapeCI95[0])}~${pc(o.escapeCI95[1])}] | 体力耗尽 ${pc(o.failStamina)} | 回合上限 ${pc(o.failMaxTurns)} | 有人没回家的局 ${pc(o.gamesWithAnyFailure)} | 无冠军 ${pc(o.noChampionGames)} | 并列冠军 ${pc(o.tiedChampionGames)}`);
  const t = report.treasure;
  console.log(`宝物   | 人均宝石 ${f2(t.gemsPerActor)} | 零收获 ${pc(t.zeroGemRate)} | 成套 0/1/2/3 = ${t.setsDist.map(pc).join(' / ')} | 分数 均 ${f2(t.scoreMean)} P50 ${t.scoreP50} | 开箱/局 ${f2(t.chestOpensPerGame)} | 到达代数均 ${f2(t.generationsReachedMean)} | 全部宝石被拿光的局 ${pc(t.allGemsTakenGames)} | 重生顺延 ${t.respawnDeferrals}`);
  const p = report.tempo;
  console.log(`节奏   | 回合 P50 ${p.turnsP50} P95 ${p.turnsP95} max ${p.turnsMax} | 到达者剩余体力 P10/P50/P90 ${pc(p.remainStaminaEscapees.p10)} / ${pc(p.remainStaminaEscapees.p50)} / ${pc(p.remainStaminaEscapees.p90)} | 受阻回合占比 ${pc(p.blockedTurnShare)} | 同格冲突/局 ${f2(p.contestsPerGame)} | 环/对穿/局 ${f2(p.cyclesPerGame)} | 回家模式占比 ${pc(p.homeTurnShare)}`);
  console.log(`座位   | ${report.seats.map((s) => `#${s.seat} 到达 ${pc(s.esc)} 宝石 ${f2(s.gems)} 分 ${f2(s.score)} 夺冠 ${pc(s.win)}`).join(' | ')}`);
  console.log(`性能   | ${f2(report.perf.msPerGame)} ms/局`);
}
