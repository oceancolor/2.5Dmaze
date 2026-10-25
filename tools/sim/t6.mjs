// 任务 6：宝物撒点改"最大化空间分散度"后的分布实测
import { N, at, mulberry32, subSeed, generateMaze, bfsField, buildFloorPool, placeTreasures, cfgSummary } from './lib.mjs';
cfgSummary('t6 · 任务 6：宝物撒点改"最大化空间分散度"后的分布实测');

const MAPS = Number(process.argv[2] || 100);
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS = [[63, 0], [127, 63], [0, 63], [63, 127]];
const CX = 63.5, CY = 63.5;
const euclid = (x, y) => Math.hypot(x - CX, y - CY);
const MODES = ['old', 'new', 'reject'];

const acc = {};
for (const m of MODES) acc[m] = {
  dCenter: [], dCenterMin: [], dCenterMax: [], block32: [], block16: [],
  minPair: [], spread: [], spreadPass: [], dSpawnNearest: [], outerCount: [], tMs: [],
};

let okMaps = 0;
for (let s = 0; s < MAPS; s++) {
  const seed = 9000 + s * 613;
  const rngM = mulberry32(subSeed(seed, 1));
  const mz = generateMaze(rngM, { spawns: SPAWNS, exits: EXITS, thinKeep: 0.76 });
  const grid = mz.grid;
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const f0 = bfsField(grid, [sp[0]]);
  if (EXITS.some(([x, y]) => f0[at(x, y)] < 0)) continue;
  okMaps++;
  const spawnFields = sp.map(p => bfsField(grid, [p]));
  const pool = buildFloorPool(grid, SPAWNS, EXITS);
  if (pool.length < 100) continue;

  for (const m of MODES) {
    const t0 = process.hrtime.bigint();
    const rngT = mulberry32(subSeed(seed, 2));
    const r = placeTreasures(rngT, pool, spawnFields, { mode: m, K: 64, minSep: 30 });
    const t1 = process.hrtime.bigint();
    const A = acc[m];
    A.tMs.push(Number(t1 - t0) / 1e6);

    const cells = r.cells;                    // 5 宝石 + 1 宝箱
    const pts = cells.map(c => [c % N, (c / N) | 0]);
    const dc = pts.map(([x, y]) => euclid(x, y));
    A.dCenter.push(...dc);
    A.dCenterMin.push(Math.min(...dc));
    A.dCenterMax.push(Math.max(...dc));
    A.outerCount.push(dc.filter(d => d > 40).length);

    const b32 = new Set(pts.map(([x, y]) => ((y / 32) | 0) * 4 + ((x / 32) | 0)));
    const b16 = new Set(pts.map(([x, y]) => ((y / 16) | 0) * 8 + ((x / 16) | 0)));
    A.block32.push(b32.size);
    A.block16.push(b16.size);

    let mp = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
      mp = Math.min(mp, Math.abs(pts[i][0] - pts[j][0]) + Math.abs(pts[i][1] - pts[j][1]));
    A.minPair.push(mp);

    A.spread.push(r.spread);
    A.spreadPass.push(r.spread <= 0.35 ? 1 : 0);

    // 到最近出生点的 BFS 距离（可达性/公平性体感）
    for (const c of cells) {
      let mn = Infinity;
      for (const f of spawnFields) mn = Math.min(mn, f[c]);
      A.dSpawnNearest.push(mn);
    }
  }
}

const av = a => a.reduce((x, y) => x + y, 0) / a.length;
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
console.log(`有效地图 ${okMaps} / ${MAPS}\n`);
console.log('| 指标 | ' + MODES.join(' | ') + ' |');
console.log('|---|---|---|---|');
function row(label, fn, fmt = (v => v.toFixed(1))) {
  console.log(`| ${label} | ` + MODES.map(m => fmt(fn(acc[m]))).join(' | ') + ' |');
}
row('到地图中心距离 · 均值', A => av(A.dCenter), v => v.toFixed(1));
row('到地图中心距离 · P10', A => q(A.dCenter, 0.10), v => v.toFixed(1));
row('到地图中心距离 · P90', A => q(A.dCenter, 0.90), v => v.toFixed(1));
row('每张图最靠近中心的那件 · 均值', A => av(A.dCenterMin), v => v.toFixed(1));
row('每张图最远离中心的那件 · 均值', A => av(A.dCenterMax), v => v.toFixed(1));
row('落在"外圈"(距中心>40)的件数 / 6', A => av(A.outerCount), v => v.toFixed(2));
row('覆盖 32×32 大区块数 / 16', A => av(A.block32), v => v.toFixed(2));
row('覆盖 16×16 小区块数 / 64', A => av(A.block16), v => v.toFixed(2));
row('两件宝物最小间距(曼哈顿) · 均值', A => av(A.minPair), v => v.toFixed(1));
row('两件宝物最小间距 · P10', A => q(A.minPair, 0.10), v => v.toFixed(1));
row('整体公平度(聚合离散度) · 均值', A => av(A.spread), v => v.toFixed(3));
row('整体公平度 ≤0.35 通过率', A => av(A.spreadPass) * 100, v => v.toFixed(1) + '%');
row('到最近出生点的 BFS 步数 · 均值', A => av(A.dSpawnNearest), v => v.toFixed(1));
row('到最近出生点的 BFS 步数 · P90', A => q(A.dSpawnNearest, 0.90), v => v.toFixed(1));
row('单次撒点耗时 (ms)', A => av(A.tMs), v => v.toFixed(3));

console.log('\n--- 到地图中心距离的分段分布（占全部宝物的百分比）---');
const bins = [[0, 15], [15, 30], [30, 45], [45, 60], [60, 999]];
console.log('| 距中心区间 | ' + MODES.join(' | ') + ' |');
console.log('|---|---|---|---|');
for (const [lo, hi] of bins) {
  const label = hi > 900 ? `> ${lo}` : `${lo}–${hi}`;
  console.log(`| ${label} | ` + MODES.map(m => (acc[m].dCenter.filter(d => d >= lo && d < hi).length / acc[m].dCenter.length * 100).toFixed(1) + '%').join(' | ') + ' |');
}
