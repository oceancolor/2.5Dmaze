// 任务 1 诊断：thinKeep 标定 + 边中点方案按出口逐项分解
import { N, at, mulberry32, subSeed, generateMaze, bfsField, WALL, cfgSummary } from './lib.mjs';
cfgSummary('t1b · 任务 1 诊断：thinKeep 标定 + 边中点方案按出口逐项分解');

const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS_A = [[63, 0], [127, 63], [0, 63], [63, 127]];
const LABEL = ['(2,2)->上(63,0)', '(125,2)->右(127,63)', '(2,125)->左(0,63)', '(125,125)->下(63,127)'];

// --- 1) thinKeep 标定
console.log('--- 墙密度 vs thinKeepRatio (120 种子) ---');
for (const keep of [0.68, 0.70, 0.72, 0.74, 0.75, 0.76, 0.78]) {
  let ds = [];
  for (let s = 0; s < 120; s++) {
    const rng = mulberry32(subSeed(1000 + s * 7919, 1));
    ds.push(generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A, thinKeep: keep }).density);
  }
  ds.sort((a, b) => a - b);
  console.log(`keep=${keep.toFixed(2)}  密度均值 ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(4)}  min ${ds[0].toFixed(4)}  max ${ds[ds.length - 1].toFixed(4)}`);
}

// --- 2) 按出口分解（用当前 keep=0.72）
console.log('\n--- 边中点方案 · 按出口分解 (300 种子, keep=0.72) ---');
const per = [[], [], [], []];
for (let s = 0; s < 300; s++) {
  const rng = mulberry32(subSeed(1000 + s * 7919, 1));
  const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A });
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const ex = EXITS_A.map(([x, y]) => at(x, y));
  for (let i = 0; i < 4; i++) per[i].push(bfsField(mz.grid, [ex[i]])[sp[i]]);
}
for (let i = 0; i < 4; i++) {
  const d = per[i].slice().sort((a, b) => a - b);
  const mh = Math.abs(SPAWNS[i][0] - EXITS_A[i][0]) + Math.abs(SPAWNS[i][1] - EXITS_A[i][1]);
  console.log(`${LABEL[i]}  曼哈顿 ${mh}  路径均值 ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2)}  P50 ${d[150]}  max ${d[d.length - 1]}  绕路 ${(d.reduce((a, b) => a + b, 0) / d.length / mh).toFixed(3)}`);
}

// --- 3) 死胡同与环路密度诊断（单张图）
const rng = mulberry32(subSeed(1000, 1));
const mz = generateMaze(rng, { spawns: SPAWNS, exits: EXITS_A });
let dead = 0, floors = 0;
for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
  const p = at(x, y);
  if (mz.grid[p] === WALL) continue;
  floors++;
  let n = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (mz.grid[at(x + dx, y + dy)] !== WALL) n++;
  if (n === 1) dead++;
}
console.log(`\n单图诊断: 地板 ${floors}  内部死胡同 ${dead} (${(dead / floors * 100).toFixed(2)}%)  墙密度 ${mz.density.toFixed(4)}`);
