#!/usr/bin/env node
// 生成器标定：扫 thinKeep → 封边后墙密度 / 各校验通过率，给出命中目标密度的 thinKeep。
// 用法：node tools/calibrate.mjs [--seeds 200] [--from 0.68] [--to 0.80] [--step 0.02]

import { makeConfig } from '../src/config/default.config.js';
import { generateMapAttempt } from '../src/core/state.js';
import { analyzeMap } from '../src/core/maze/validate.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const SEEDS = Number(args.seeds ?? 200);
const FROM = Number(args.from ?? 0.68);
const TO = Number(args.to ?? 0.80);
const STEP = Number(args.step ?? 0.02);

const pct = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

const base = makeConfig();
const target = base.maze.wallDensityTarget;
console.log(`# calibrate · 生成器=src/core/maze/generate.js · 种子 1..${SEEDS} · 目标密度 ${target} ± ${base.maze.wallDensityTol}`);
console.log('thinKeep | density mean   sd     min    max   | V6%   V4%   V5%   V1-3% all% | spawn→exit mean P95 max | gen ms');

const rows = [];
for (let k = FROM; k <= TO + 1e-9; k += STEP) {
  const keep = Math.round(k * 1000) / 1000;
  const cfg = makeConfig({ maze: { thinKeep: keep } });
  const dens = [];
  const se = [];
  const fails = { V1: 0, V2: 0, V3: 0, V4: 0, V5: 0, V6: 0 };
  let allOk = 0;
  let t = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const t0 = performance.now();
    const map = generateMapAttempt(s, 0, cfg);
    const a = analyzeMap(map, cfg);
    t += performance.now() - t0;
    dens.push(map.density);
    se.push(...a.metrics.spawnExit);
    for (const f of a.failures) fails[f]++;
    if (a.ok) allOk++;
  }
  const p = (c) => ((100 * (SEEDS - c)) / SEEDS).toFixed(1).padStart(5);
  const v13 = SEEDS - Math.max(fails.V1, fails.V2, fails.V3);
  const m = mean(dens);
  rows.push({ keep, m });
  console.log(
    `${keep.toFixed(3)}    | ${m.toFixed(4)} ${sd(dens).toFixed(4)} ${Math.min(...dens).toFixed(4)} ${Math.max(...dens).toFixed(4)} |` +
      `${p(fails.V6)} ${p(fails.V4)} ${p(fails.V5)} ${((100 * v13) / SEEDS).toFixed(1).padStart(5)} ${((100 * allOk) / SEEDS).toFixed(1).padStart(5)} |` +
      ` ${mean(se).toFixed(1)} ${pct(se, 0.95)} ${Math.max(...se)} | ${(t / SEEDS).toFixed(2)}`,
  );
}

for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1];
  const b = rows[i];
  if ((a.m - target) * (b.m - target) <= 0) {
    const keep = a.keep + ((target - a.m) * (b.keep - a.keep)) / (b.m - a.m);
    console.log(`\n建议 thinKeep ≈ ${keep.toFixed(3)}（线性插值 ${a.keep} → ${b.keep}）`);
  }
}
