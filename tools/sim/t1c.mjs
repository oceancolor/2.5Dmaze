// 任务 1 定稿：thinKeep 校准到锁定密度 0.355 后的 1000 种子实测 + 结构探针
import { N, at, mulberry32, subSeed, generateMaze, bfsField, cfgSummary } from './lib.mjs';
cfgSummary('t1c · 任务 1 定稿：thinKeep 校准到锁定密度 0.355 后的 1000 种子实测 + 结构探针');

const SEEDS = Number(process.argv[2] || 1000);
const KEEP = Number(process.argv[3] || 0.76);
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS_A = [[63, 0], [127, 63], [0, 63], [63, 127]];
const EXITS_B = [[33, 33], [95, 33], [33, 95], [95, 95]];
const mh = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

// ---- 结构探针：为什么边中点比内侧环绕？(50 种子)
{
  const probeRow = [], probeDiag = [], probeCenter = [];
  for (let s = 0; s < 50; s++) {
    const rng = mulberry32(subSeed(1000 + s * 7919, 1));
    const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A, thinKeep: KEEP });
    const f = bfsField(mz.grid, [at(2, 2)]);
    probeRow.push(f[at(63, 1)]);      // 边中点出口的内侧格
    probeDiag.push(f[at(33, 33)]);
    probeCenter.push(f[at(63, 63)]);
  }
  const av = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log('--- 结构探针（从 (2,2) 出发，50 种子）---');
  console.log(`到 (63,1)  [边出口内侧格] 曼哈顿 62  实测 ${av(probeRow)}  绕路 ${(av(probeRow) / 62).toFixed(3)}`);
  console.log(`到 (33,33) [内侧环出口]   曼哈顿 62  实测 ${av(probeDiag)}  绕路 ${(av(probeDiag) / 62).toFixed(3)}`);
  console.log(`到 (63,63) [地图中心]     曼哈顿 122 实测 ${av(probeCenter)}  绕路 ${(av(probeCenter) / 122).toFixed(3)}`);
}

// ---- 1000 种子实测
const rowsA = [], rowsB = [], dens = [];
let invalid = 0;
const t0 = Date.now();
for (let s = 0; s < SEEDS; s++) {
  const rng = mulberry32(subSeed(1000 + s * 7919, 1));
  const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A.concat(EXITS_B), thinKeep: KEEP });
  dens.push(mz.density);
  const grid = mz.grid;
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const eA = EXITS_A.map(([x, y]) => at(x, y));
  const eB = EXITS_B.map(([x, y]) => at(x, y));
  const f0 = bfsField(grid, [sp[0]]);
  let ok = true;
  for (let i = 0; i < 4; i++) if (f0[sp[i]] < 0 || f0[eA[i]] < 0 || f0[eB[i]] < 0) ok = false;
  if (!ok) { invalid++; continue; }
  for (let i = 0; i < 4; i++) {
    rowsA.push({ seed: s, d: bfsField(grid, [eA[i]])[sp[i]], m: mh(SPAWNS[i], EXITS_A[i]) });
    rowsB.push({ seed: s, d: bfsField(grid, [eB[i]])[sp[i]], m: mh(SPAWNS[i], EXITS_B[i]) });
  }
}
function rep(rows, label, lo, hi) {
  const d = rows.map(r => r.d).sort((a, b) => a - b);
  const q = p => d[Math.floor(p * (d.length - 1))];
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const mmean = rows.reduce((a, r) => a + r.m, 0) / rows.length;
  const inR = d.filter(x => x >= lo && x <= hi).length / d.length;
  console.log(`\n=== ${label} ===`);
  console.log(`n=${d.length} 曼哈顿 ${mmean.toFixed(1)} 路径均值 ${mean.toFixed(2)} P05 ${q(0.05)} P50 ${q(0.5)} P95 ${q(0.95)} max ${d[d.length - 1]} 绕路 ${(mean / mmean).toFixed(3)}`);
  console.log(`落在 [${lo},${hi}] : ${(inR * 100).toFixed(2)}%   落在 [70,95] : ${(d.filter(x => x >= 70 && x <= 95).length / d.length * 100).toFixed(2)}%   落在 [75,105] : ${(d.filter(x => x >= 75 && x <= 105).length / d.length * 100).toFixed(2)}%`);
  const byS = new Map();
  for (const r of rows) byS.set(r.seed, Math.max(byS.get(r.seed) ?? 0, r.d));
  const w = [...byS.values()].sort((a, b) => a - b);
  console.log(`每种子的四人最坏值: 均值 ${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2)} P95 ${w[Math.floor(0.95 * w.length)]} max ${w[w.length - 1]}`);
  return { mean, inR };
}
dens.sort((a, b) => a - b);
console.log(`\n墙密度 (thinKeep=${KEEP}): 均值 ${(dens.reduce((a, b) => a + b, 0) / dens.length).toFixed(4)} min ${dens[0].toFixed(4)} max ${dens[dens.length - 1].toFixed(4)}`);
console.log(`连通性失败 ${invalid}/${SEEDS}  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const A = rep(rowsA, `A 四条边中点 + 就近分配`, 85, 100);
rep(rowsB, `B 内侧环 (33,33)(95,33)(33,95)(95,95)`, 85, 100);
