#!/usr/bin/env node
// 决策协议基准（决策协议改造 §14 C12，第 8 项）：固定种子、mock 大模型，统计新规则下的决策与结果，作为新基线。
//
// 用法：node tools/bench-decision-flow.mjs [--sizes XS,S,M] [--seeds 1-20] [--mode mock4|aware] [--latency 0|2] [--json]
//   mode mock4（默认）：四个座位都是 mock 大模型（座位 0 = 玩家自己的 AI，契约 free；1–3 = 对手风格）
//   mode aware       ：座位 0 = mock 大模型（契约 free），1–3 = 预判对手脚本（与 WorkBuddy 上场同配）
//   latency          ：规划延迟。默认 0 = 现行规则 SPEC-0.3；2 = 旧规则的对照（只用于比较延迟的影响，不对应任何认可的配置）
//
// 注意：mock 回复只看局面、不读提示词，所以测不出「轨迹段」对决策质量的影响 —— 那要真实模型（WorkBuddy 实测，见 redesign §14 C13）。
//
// 每局统计：决策点数、各类结果事件（applied / invalid / failed / stale / guard / abandoned / lost / reached / queued / replaced）、
//   座位 0 的分数 / 名次 / 是否到达、请求平均字符数（含 / 不含轨迹）、录像字节、耗时。

import { makeConfig } from '../src/config/default.config.js';
import { MAP_SIZE_IDS, matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { OUTCOME_TYPES } from '../src/ai/decision-protocol.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { messagesFor } from '../src/app/transport.js';
import { rankActors } from '../src/core/scoring.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { readFileSync } from 'node:fs';

const AWARE = readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8');
const PS = ['balanced', 'setHunter', 'chest', 'cautious'];

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[argv[i].slice(2)] = true;
    else {
      a[argv[i].slice(2)] = v;
      i++;
    }
  }
  return a;
}

export function parseSeeds(s) {
  const out = [];
  for (const part of String(s).split(',')) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) for (let k = +m[1]; k <= +m[2]; k++) out.push(k);
    else if (part.trim()) out.push(Number(part));
  }
  return out;
}

/** 跑一局，返回这局的统计。 */
export function benchGame(size, seed, { mode = 'mock4', latency = 0 } = {}) {
  const over = matchOverrides('byok', size);
  const cfg = makeConfig(latency === 0 ? over : { ...over, ai: { ...(over.ai || {}), planLatencyTurns: latency } });
  const chars = { n: 0, with: 0, without: 0 };
  const t0 = performance.now();
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      const planner = (i) => createPlanner({
        map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? 'free' : null,
        transport: (req, reply) => {
          chars.n++;
          chars.with += messagesFor(req, cfg).reduce((a, x) => a + x.content.length, 0);
          chars.without += messagesFor(req, cfg, { trajectory: false }).reduce((a, x) => a + x.content.length, 0);
          reply.deliver(mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) }));
        },
      });
      return [0, 1, 2, 3].map((i) => (mode === 'aware' && i > 0
        ? createNodeScriptController({ code: AWARE, map: m.map, seat: i, cfg, seed: m.seed, isPlayer: false })
        : planner(i)));
    },
  });
  s.runSync(0, 100000);
  const ms = performance.now() - t0;
  const llmSeats = s.controllers.map((c, i) => (c && c.kind === 'planner' ? i : -1)).filter((i) => i >= 0);
  const outcomes = Object.fromEntries(OUTCOME_TYPES.map((t) => [t, 0]));
  let decisions = 0;
  for (const i of llmSeats) {
    const c = s.controllers[i];
    decisions += c.decisionPoints;
    for (const e of c.outcomes) outcomes[e.type]++;
  }
  const me = rankActors(s.state.actors, cfg).find((r) => r.seat === 0);
  return {
    size, seed, turns: s.state.endTurn, ended: s.state.ended, llmSeats: llmSeats.length,
    decisions, decisionsPerSeat: decisions / llmSeats.length, outcomes,
    me: { score: me.status === 'escaped' ? me.score : 0, place: me.place, escaped: me.status === 'escaped', champion: Boolean(me.champion) },
    chars: { avg: chars.n ? chars.with / chars.n : 0, avgNoTraj: chars.n ? chars.without / chars.n : 0, calls: chars.n },
    recordBytes: Buffer.byteLength(s.toJSONL()), ms,
  };
}

export function summarize(games) {
  const n = games.length || 1;
  const sum = (f) => games.reduce((a, g) => a + f(g), 0);
  const outcomes = Object.fromEntries(OUTCOME_TYPES.map((t) => [t, sum((g) => g.outcomes[t])]));
  return {
    games: games.length,
    allEnded: games.every((g) => g.ended),
    avgTurns: sum((g) => g.turns) / n,
    decisionsPerSeatPerGame: sum((g) => g.decisionsPerSeat) / n,
    decisionsPer10Turns: (10 * sum((g) => g.decisionsPerSeat)) / sum((g) => g.turns),
    outcomes,
    staleRate: outcomes.stale / Math.max(1, outcomes.applied + outcomes.stale),
    lostRate: outcomes.lost / Math.max(1, outcomes.lost + outcomes.reached),
    me: {
      avgScore: sum((g) => g.me.score) / n, avgPlace: sum((g) => g.me.place) / n,
      escapeRate: sum((g) => (g.me.escaped ? 1 : 0)) / n, championRate: sum((g) => (g.me.champion ? 1 : 0)) / n,
    },
    avgPromptChars: sum((g) => g.chars.avg) / n,
    avgPromptCharsNoTraj: sum((g) => g.chars.avgNoTraj) / n,
    maxRecordBytes: Math.max(...games.map((g) => g.recordBytes)),
    avgMs: sum((g) => g.ms) / n,
  };
}

function table(rows) {
  const f1 = (x) => x.toFixed(1);
  const pc = (x) => `${(100 * x).toFixed(1)}%`;
  const L = [
    '| 规格 | 局数 | 平均回合 | 每座位决策 / 局 | 决策 / 10 回合 | applied | stale | invalid | guard | abandoned | lost | reached | queued | replaced | 被抢率 | 座位0 均分 | 均名次 | 到达 | 冠军 | 请求字符（含轨迹 / 不含） | 最大录像 | 平均耗时 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [size, r] of rows) {
    const o = r.outcomes;
    L.push(`| ${size} | ${r.games} | ${f1(r.avgTurns)} | ${f1(r.decisionsPerSeatPerGame)} | ${r.decisionsPer10Turns.toFixed(2)} | ${o.applied} | ${o.stale} | ${o.invalid} | ${o.guard} | ${o.abandoned} | ${o.lost} | ${o.reached} | ${o.queued} | ${o.replaced} | ${pc(r.lostRate)} | ${r.me.avgScore.toFixed(2)} | ${r.me.avgPlace.toFixed(2)} | ${pc(r.me.escapeRate)} | ${pc(r.me.championRate)} | ${Math.round(r.avgPromptChars)} / ${Math.round(r.avgPromptCharsNoTraj)} | ${(r.maxRecordBytes / 1024).toFixed(1)} KB | ${Math.round(r.avgMs)} ms |`);
  }
  return L.join('\n');
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('bench-decision-flow.mjs')) {
  const a = parseArgs(process.argv.slice(2));
  const sizes = String(a.sizes || 'XS,S,M').split(',').filter((x) => MAP_SIZE_IDS.includes(x));
  const seeds = parseSeeds(a.seeds || '1-20');
  const mode = a.mode === 'aware' ? 'aware' : 'mock4';
  const latency = Number(a.latency ?? 0);
  const rows = sizes.map((size) => [size, summarize(seeds.map((seed) => benchGame(size, seed, { mode, latency })))]);
  if (a.json) console.log(JSON.stringify({ mode, latency, seeds: seeds.length, rows: Object.fromEntries(rows) }, null, 1));
  else {
    console.log(`## 决策协议基准 · ${mode === 'aware' ? '座位 0 mock 大模型 vs 3 个预判对手脚本' : '四座位 mock 大模型'} · 规划延迟 ${latency}${latency === 0 ? '（现行 SPEC-0.3）' : '（旧规则对照，非认可配置）'} · 种子 ${seeds.length} 个`);
    console.log(table(rows));
  }
}
