#!/usr/bin/env node
// 内核性能（04 K04 / K05）：
//   K04 地图生成 P95 ≤ 20 ms —— 口径 = 单次生成尝试（generateGrid + buildMap，不含校验与撒点）；
//       另报「整局开局」createMatch（生成 + 校验 + 撒点 + 失败重试）的分布，只作参考
//   K05 BFS ×1000 平均 ≤ 1.5 ms —— 128×128 全图单源距离场 fieldFrom
// 用法：node tools/bench-maze.mjs [--runs 1000] [--json]；任一门禁超标退出码 1。

import { performance } from 'node:perf_hooks';
import { makeConfig } from '../src/config/default.config.js';
import { createMatch, generateMapAttempt } from '../src/core/state.js';
import { fieldFrom } from '../src/core/nav/bfs.js';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 1000;
const json = args.includes('--json');
const cfg = makeConfig();

const pct = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (xs) => ({ p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length });

for (let k = 0; k < 20; k++) generateMapAttempt(k + 1, 0, cfg); // 预热 JIT

const gen = [];
for (let k = 0; k < runs; k++) {
  const t0 = performance.now();
  generateMapAttempt(1000 + k, 0, cfg);
  gen.push(performance.now() - t0);
}

const matchRuns = Math.min(runs, 200);
const match = [];
const attempts = [];
let maps = [];
for (let k = 0; k < matchRuns; k++) {
  const t0 = performance.now();
  const m = createMatch(5000 + k, cfg);
  match.push(performance.now() - t0);
  attempts.push(m.attempts);
  if (maps.length < 8) maps.push(m.map);
}

const N = cfg.maze.size;
const bfs = [];
for (let k = 0; k < 50; k++) fieldFrom(maps[k % maps.length], maps[0].spawns[0][1] * N + maps[0].spawns[0][0]);
for (let k = 0; k < runs; k++) {
  const map = maps[k % maps.length];
  const floors = [];
  for (let i = (k * 7919) % (N * N), c = 0; c < N * N && floors.length < 1; c++, i = (i + 1) % (N * N)) if (map.grid[i]) floors.push(i);
  const t0 = performance.now();
  fieldFrom(map, floors[0]);
  bfs.push(performance.now() - t0);
}

const out = {
  runs,
  K04: { ...stats(gen), limitP95: 20, ok: pct(gen, 95) <= 20 },
  createMatch: { ...stats(match), runs: matchRuns, attemptsMean: attempts.reduce((a, b) => a + b, 0) / attempts.length, attemptsMax: Math.max(...attempts) },
  K05: { ...stats(bfs), limitMean: 1.5, ok: stats(bfs).mean <= 1.5 },
  node: process.version,
};

if (json) console.log(JSON.stringify(out, null, 2));
else {
  const f = (v) => v.toFixed(2);
  console.log(`K04 生成（单次尝试）×${runs}: P50 ${f(out.K04.p50)} · P95 ${f(out.K04.p95)} · max ${f(out.K04.max)} ms（≤ 20）${out.K04.ok ? ' ✓' : ' ✗'}`);
  console.log(`    开局 createMatch ×${matchRuns}: P50 ${f(out.createMatch.p50)} · P95 ${f(out.createMatch.p95)} · max ${f(out.createMatch.max)} ms · 平均尝试 ${out.createMatch.attemptsMean.toFixed(2)} 次（参考）`);
  console.log(`K05 BFS 128×128 ×${runs}: 平均 ${f(out.K05.mean)} · P95 ${f(out.K05.p95)} · max ${f(out.K05.max)} ms（平均 ≤ 1.5）${out.K05.ok ? ' ✓' : ' ✗'}`);
}
if (!out.K04.ok || !out.K05.ok) process.exit(1);
