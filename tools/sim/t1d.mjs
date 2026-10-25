// 任务 1 附：硬校验区间候选 + 重掷率（1000 种子，thinKeep=0.76，边中点方案）
import { at, mulberry32, subSeed, generateMaze, bfsField, cfgSummary } from './lib.mjs';
cfgSummary('t1d · 任务 1 附：硬校验区间候选 + 重掷率（1000 种子，thinKeep=0.76，边中点方案）');
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS_A = [[63, 0], [127, 63], [0, 63], [63, 127]];
const KEEP = 0.76;
const perSeed = [];
const all = [];
for (let s = 0; s < 1000; s++) {
  const rng = mulberry32(subSeed(1000 + s * 7919, 1));
  const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A, thinKeep: KEEP });
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const ex = EXITS_A.map(([x, y]) => at(x, y));
  const ds = [];
  for (let i = 0; i < 4; i++) { const d = bfsField(mz.grid, [ex[i]])[sp[i]]; ds.push(d); all.push(d); }
  perSeed.push(ds);
}
const frac = f => (all.filter(f).length / all.length * 100).toFixed(1) + '%';
console.log(`样本 ${all.length}（1000 种子 × 4 人）`);
console.log(`[85,100] ${frac(x => x >= 85 && x <= 100)}`);
console.log(`[70,100] ${frac(x => x >= 70 && x <= 100)}`);
console.log(`[72,100] ${frac(x => x >= 72 && x <= 100)}`);
console.log(`[68,105] ${frac(x => x >= 68 && x <= 105)}`);
console.log(`[65,110] ${frac(x => x >= 65 && x <= 110)}`);
console.log(`[70,110] ${frac(x => x >= 70 && x <= 110)}`);

console.log('\n--- 种子级门禁候选（四人全部满足才算通过，否则重掷）---');
for (const [lo, hi] of [[70, 100], [70, 105], [70, 110], [72, 110], [65, 110], [68, 108]]) {
  let pass = 0, worstMax = 0;
  for (const ds of perSeed) {
    if (ds.every(d => d >= lo && d <= hi)) pass++;
    worstMax = Math.max(worstMax, Math.max(...ds));
  }
  console.log(`每人 ∈ [${lo},${hi}]  通过率 ${(pass / 10).toFixed(1)}%  重掷率 ${(100 - pass / 10).toFixed(1)}%  全样本最大 ${worstMax}`);
}
// 只卡上界
for (const hi of [100, 105, 110, 115]) {
  let pass = 0;
  for (const ds of perSeed) if (ds.every(d => d <= hi)) pass++;
  console.log(`只卡上界 ≤ ${hi}  重掷率 ${(100 - pass / 10).toFixed(1)}%`);
}
// 出口公平性（极差/均值）
const fair = perSeed.map(ds => (Math.max(...ds) - Math.min(...ds)) / (ds.reduce((a, b) => a + b, 0) / 4)).sort((a, b) => a - b);
console.log(`\n出口公平性 极差/均值: 均值 ${(fair.reduce((a, b) => a + b, 0) / fair.length).toFixed(3)} P95 ${fair[950].toFixed(3)} max ${fair[999].toFixed(3)}  >0.30 占比 ${(fair.filter(x => x > 0.3).length / 10).toFixed(1)}%`);
