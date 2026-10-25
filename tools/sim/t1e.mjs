// 回应 QA：`[68,108]` 的 3.0% 是"仅距离条件"还是"含连通性+公平性"的联合重掷率？
import { N, at, mulberry32, subSeed, generateMaze, bfsField, cfgSummary } from './lib.mjs';
cfgSummary('t1e · 回应 QA：`[68,108]` 的 3.0% 是"仅距离条件"还是"含连通性+公平性"的联合重掷率？');

const SEEDS = Number(process.argv[2] || 2000);
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS = [[63, 0], [127, 63], [0, 63], [63, 127]];

let n = 0;
let dOut = 0, connBad = 0, fairBad = 0, anyBad = 0;
const all = [];
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

for (let s = 0; s < SEEDS; s++) {
  const seed = 1000 + s * 37;
  const mz = generateMaze(mulberry32(subSeed(seed, 1)), { spawns: SPAWNS, exits: EXITS, thinKeep: 0.76 });
  const grid = mz.grid;
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const ex = EXITS.map(([x, y]) => at(x, y));
  const f0 = bfsField(grid, [sp[0]]);
  let bad = false;
  // 连通性
  if (sp.some(p => f0[p] < 0) || ex.some(p => f0[p] < 0)) { connBad++; bad = true; }
  // 距离
  const ds = [];
  for (let i = 0; i < 4; i++) { const f = bfsField(grid, [ex[i]]); ds.push(f[sp[i]]); }
  ds.forEach(d => all.push(d));
  const dOK = ds.every(d => d >= 68 && d <= 108);
  if (!dOK) { dOut++; bad = true; }
  // 公平性（极差/均值 ≤ 0.35）
  const mean = ds.reduce((a, b) => a + b, 0) / 4;
  const spread = (Math.max(...ds) - Math.min(...ds)) / mean;
  if (spread > 0.35) { fairBad++; bad = true; }
  if (bad) anyBad++;
  n++;
}
const r = x => (x / n * 100).toFixed(2) + '%';
console.log(`种子 ${n} 个（thinKeep=0.76，出口=四边中点，就近分配）`);
console.log(`  spawn→exit 距离全样本: mean ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(2)}  P05 ${pct(all, .05)}  P50 ${pct(all, .5)}  P95 ${pct(all, .95)}  P99 ${pct(all, .99)}  max ${Math.max(...all)}  min ${Math.min(...all)}`);
console.log(`  单项重掷率:`);
console.log(`    距离越界 [68,108]        ${r(dOut)}`);
console.log(`    连通性失败                ${r(connBad)}`);
console.log(`    公平性 > 0.35             ${r(fairBad)}`);
console.log(`  【联合】任一条件失败 → 重掷  ${r(anyBad)}`);
console.log(`  attempts=20 下单局生成失败概率 ≈ ${(Math.pow(anyBad / n, 20) * 100).toExponential(2)}%`);
