// ② 10 颗默认口径：可捡数按「距本角色出生点距离」分桶 + 撒点分布
//    目的：验证 "≥3 件 86.5%" 是靠博弈设计，还是靠出生点附近的密集撒点堆出来的
import { simulateGame, cfgSummary } from './lib.mjs';
import { N, at, mulberry32, subSeed, generateMaze, bfsField, buildFloorPool, placeTreasures } from './lib.mjs';
cfgSummary('t2d · ② 10 颗默认口径：可捡数按「距本角色出生点距离」分桶 + 撒点分布 / 目的：验证 "≥3 件 86.5%" 是靠博弈设计，还是靠出生点');

const GAMES = Number(process.argv[2] || 200);
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS = [[63, 0], [127, 63], [0, 63], [63, 127]];

// ---------- A. 可捡数按距出生点距离分桶 ----------
function bucketRun(label, o) {
  const near = [], mid = [], far = [], all = [];
  let tot = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'new', thinKeep: 0.76, exits: EXITS,
    }, o));
    if (r.invalid) continue;
    for (const a of r.actors) {
      let n = 0, m = 0, f = 0;
      for (const d of a.pickDist) {
        all.push(d);
        if (d < 40) n++; else if (d <= 80) m++; else f++;
      }
      near.push(n); mid.push(m); far.push(f); tot += n + m + f;
    }
  }
  const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  const nT = av(near), mT = av(mid), fT = av(far), sT = nT + mT + fT;
  console.log(`${label}`);
  console.log(`  近桶(<40)  ${nT.toFixed(2)} 件  ${(nT / sT * 100).toFixed(1)}%`);
  console.log(`  中桶(40-80) ${mT.toFixed(2)} 件  ${(mT / sT * 100).toFixed(1)}%`);
  console.log(`  远桶(>80)  ${fT.toFixed(2)} 件  ${(fT / sT * 100).toFixed(1)}%`);
  console.log(`  合计 ${sT.toFixed(2)} 件/人   全部拾取的距离分布: 均值 ${av(all).toFixed(1)}  P50 ${all.slice().sort((x, y) => x - y)[(all.length / 2) | 0]}  P90 ${all.slice().sort((x, y) => x - y)[Math.floor(all.length * 0.9)]}  max ${Math.max(...all)}`);
  return { nT, mT, fT, sT };
}

console.log('=== A. 可捡数按「距本角色出生点 BFS 距离」分桶（体力400，四人，200局）===');
const A5 = bucketRun('【5 颗 / v1.4】', { gemsPerColor: 1 });
const A10 = bucketRun('【10 颗 / v1.6】', { gemsPerColor: 2 });

// ---------- B. 撒点本身的分布（10 颗 = 11 件）----------
console.log('\n=== B. 撒点分布（100 张图，11 件宝物）===');
const MAPS = 100;
const acc = {};
for (const mode of ['new', 'reject']) acc[mode] = { dC: [], dSpawn: [], outer: [], b32: [], minP: [], sp: [] };
for (let s = 0; s < MAPS; s++) {
  const seed = 9000 + s * 613;
  const mz = generateMaze(mulberry32(subSeed(seed, 1)), { spawns: SPAWNS, exits: EXITS, thinKeep: 0.76 });
  const grid = mz.grid;
  const sp = SPAWNS.map(([x, y]) => at(x, y));
  const f0 = bfsField(grid, [sp[0]]);
  if (EXITS.some(([x, y]) => f0[at(x, y)] < 0)) continue;
  const sf = sp.map(p => bfsField(grid, [p]));
  const pool = buildFloorPool(grid, SPAWNS, EXITS);
  for (const mode of ['new', 'reject']) {
    const r = placeTreasures(mulberry32(subSeed(seed, 2)), pool, sf, {
      mode, nGem: 10, nChest: 1, minSep: mode === 'reject' ? 30 : 30,
    });
    const pts = r.cells.map(c => [c % N, (c / N) | 0]);
    const A = acc[mode];
    for (const [x, y] of pts) {
      A.dC.push(Math.hypot(x - 63.5, y - 63.5));
      let mn = Infinity; for (const f of sf) mn = Math.min(mn, f[at(x, y)]);
      A.dSpawn.push(mn);
    }
    A.outer.push(pts.filter(([x, y]) => Math.hypot(x - 63.5, y - 63.5) > 40).length);
    A.b32.push(new Set(pts.map(([x, y]) => ((y / 32) | 0) * 4 + ((x / 32) | 0))).size);
    let mp = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
      mp = Math.min(mp, Math.abs(pts[i][0] - pts[j][0]) + Math.abs(pts[i][1] - pts[j][1]));
    A.minP.push(mp);
    A.sp.push(r.spread);
  }
}
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
console.log('| 指标 | new（5颗时） | **new（10颗）** | reject（10颗） |');
console.log('|---|---|---|---|');
console.log(`| 到最近出生点 BFS · 均值 | 60.4 | **${av(acc.new.dSpawn).toFixed(1)}** | ${av(acc.reject.dSpawn).toFixed(1)} |`);
console.log(`| 到最近出生点 BFS · P90 | 95 | **${q(acc.new.dSpawn, 0.9)}** | ${q(acc.reject.dSpawn, 0.9)} |`);
console.log(`| 到中心距离 · 均值 | 51.7 | **${av(acc.new.dC).toFixed(1)}** | ${av(acc.reject.dC).toFixed(1)} |`);
console.log(`| 外圈(>40)件数 / 11 | 4.50 (of 6) | **${av(acc.new.outer).toFixed(2)}** | ${av(acc.reject.outer).toFixed(2)} |`);
console.log(`| 覆盖 32×32 区块 / 16 | 5.91 (of 6) | **${av(acc.new.b32).toFixed(2)}** | ${av(acc.reject.b32).toFixed(2)} |`);
console.log(`| 最小间距 | 46.8 | **${av(acc.new.minP).toFixed(1)}** | ${av(acc.reject.minP).toFixed(1)} |`);
console.log(`| 整体公平度 ≤0.35 通过率 | 100% | **${(acc.new.sp.filter(x => x <= 0.35).length / acc.new.sp.length * 100).toFixed(1)}%** | ${(acc.reject.sp.filter(x => x <= 0.35).length / acc.reject.sp.length * 100).toFixed(1)}% |`);

// ---------- C. 体力 450 在调用上限 360 下的重算 ----------
console.log('\n=== C. 体力梯度 · 调用上限 240 vs 360（10 颗，四人，200局）===');
for (const st of [350, 400, 420, 450]) {
  const call = [], turns = [], pk = [], ge3 = [];
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, {
      nAgents: 4, stamina: st, placementMode: 'new', thinKeep: 0.76, exits: EXITS, gemsPerColor: 2,
    });
    if (r.invalid) continue;
    turns.push(r.turns);
    let ct = 0;
    for (const a of r.actors) {
      pk.push(a.picked); ge3.push(a.picked >= 3 ? 1 : 0);
      ct += Math.floor((a.endTurn < 0 ? r.turns : a.endTurn) / 8) + 6;
    }
    call.push(ct);
  }
  const c = call.slice().sort((x, y) => x - y), t = turns.slice().sort((x, y) => x - y);
  const a = x => (x.reduce((p, q) => p + q, 0) / x.length);
  const max = c[c.length - 1];
  console.log(`体力 ${st}: 可捡 ${a(pk).toFixed(2)}  ≥3 ${(a(ge3) * 100).toFixed(1)}%  回合P50 ${t[(t.length / 2) | 0]}  调用 均值${a(call).toFixed(0)}/P95 ${c[Math.floor(0.95 * c.length)]}/max ${max}   → vs240 ${max > 240 ? '❌破' : '✅'} | vs360 ${max > 360 ? '❌破' : '✅'}`);
}
