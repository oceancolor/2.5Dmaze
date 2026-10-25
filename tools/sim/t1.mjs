// 任务 1：spawn→exit 最短路径实测（1000 种子）
// 同时测两个候选：A 四条边中点（就近分配） / B 内侧环 (33,33)(95,33)(33,95)(95,95)
import { N, at, mulberry32, subSeed, generateMaze, bfsField, cfgSummary } from './lib.mjs';
cfgSummary('t1 · 任务 1：spawn→exit 最短路径实测（1000 种子） / 同时测两个候选：A 四条边中点（就近分配） / B 内侧环 (33,33');

const SEEDS = Number(process.argv[2] || 1000);
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS_A = [[63, 0], [127, 63], [0, 63], [63, 127]];      // TL,TR,BL,BR 顺序
const EXITS_B = [[33, 33], [95, 33], [33, 95], [95, 95]];      // 内侧环，全部为奇坐标单元

const manhattan = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

const rowsA = [], rowsB = [];
let densities = [], invalid = 0, regen = 0;
const t0 = Date.now();

for (let s = 0; s < SEEDS; s++) {
  const seed = 1000 + s * 7919;
  // 生成时把两套出口都挖开（B 全是单元格，本身即地板；A 的 (63,0)/(0,63) 需强制开挖）
  const rng = mulberry32(subSeed(seed, 1));
  const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A.concat(EXITS_B) });
  densities.push(mz.density);
  const grid = mz.grid;

  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const f0 = bfsField(grid, [sp[0]]);
  let ok = true;
  for (let i = 0; i < 4; i++) if (f0[sp[i]] < 0) ok = false;
  const eA = EXITS_A.map(([x, y]) => at(x, y));
  const eB = EXITS_B.map(([x, y]) => at(x, y));
  for (const e of eA.concat(eB)) if (f0[e] < 0) ok = false;
  if (!ok) { invalid++; continue; }

  const fa = eA.map(e => bfsField(grid, [e]));
  const fb = eB.map(e => bfsField(grid, [e]));
  for (let i = 0; i < 4; i++) {
    rowsA.push({ seed, i, d: fa[i][sp[i]], mh: manhattan(SPAWNS[i], EXITS_A[i]) });
    rowsB.push({ seed, i, d: fb[i][sp[i]], mh: manhattan(SPAWNS[i], EXITS_B[i]) });
  }
}

function stats(rows, label, lo, hi) {
  const d = rows.map(r => r.d).sort((a, b) => a - b);
  const q = p => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const inRange = d.filter(x => x >= lo && x <= hi).length / d.length;
  const mh = rows.reduce((a, r) => a + r.mh, 0) / rows.length;
  console.log(`\n=== ${label} ===`);
  console.log(`样本 ${d.length}  曼哈顿均值 ${mh.toFixed(1)}  路径均值 ${mean.toFixed(2)}  绕路系数 ${(mean / mh).toFixed(3)}`);
  console.log(`min ${d[0]}  P05 ${q(0.05)}  P50 ${q(0.5)}  P95 ${q(0.95)}  max ${d[d.length - 1]}`);
  console.log(`落在 [${lo}, ${hi}] 内占比 ${(inRange * 100).toFixed(2)}%`);
  // 按 seed 的最坏值（4 人中的最大值）
  const bySeed = new Map();
  for (const r of rows) bySeed.set(r.seed, Math.max(bySeed.get(r.seed) ?? 0, r.d));
  const worst = [...bySeed.values()].sort((a, b) => a - b);
  console.log(`每种子四人最大值: 均值 ${(worst.reduce((a, b) => a + b, 0) / worst.length).toFixed(2)}  max ${worst[worst.length - 1]}  P95 ${worst[Math.floor(0.95 * worst.length)]}`);
  return { mean, median: q(0.5), max: d[d.length - 1], inRange, detour: mean / mh };
}

console.log(`\n墙密度: 均值 ${(densities.reduce((a, b) => a + b, 0) / densities.length).toFixed(4)}  min ${Math.min(...densities).toFixed(4)}  max ${Math.max(...densities).toFixed(4)}`);
console.log(`连通性失败种子: ${invalid} / ${SEEDS}   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const A = stats(rowsA, 'A 四条边中点 + 就近分配（顺时针）', 85, 100);
const B = stats(rowsB, 'B 内侧环 (33,33)(95,33)(33,95)(95,95)', 85, 100);

// 出口公平性：每种子 4 人路径极差/均值
function fairness(rows) {
  const bySeed = new Map();
  for (const r of rows) { if (!bySeed.has(r.seed)) bySeed.set(r.seed, []); bySeed.get(r.seed).push(r.d); }
  let vals = [];
  for (const [, v] of bySeed) {
    const mn = Math.min(...v), mx = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
    vals.push((mx - mn) / mean);
  }
  vals.sort((a, b) => a - b);
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, p95: vals[Math.floor(0.95 * vals.length)], max: vals[vals.length - 1] };
}
console.log(`\n出口公平性（4 人路径极差/均值）:  A ${JSON.stringify(fairness(rowsA))}   B ${JSON.stringify(fairness(rowsB))}`);
console.log(`\n结论: A ${A.inRange >= 0.9 ? '落在区间内' : '落在区间外'}  B ${B.inRange >= 0.9 ? '落在区间内' : '落在区间外'}`);
