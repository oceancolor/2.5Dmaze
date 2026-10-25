// keep=0.68 vs 0.76 全量重跑：密度标定 / F01a·F05 / M→软上限 / X18 四统计量
import { simulateGame, N, at, mulberry32, subSeed, generateMaze, bfsField, cfgSummary } from './lib.mjs';
cfgSummary('t2o · keep=0.68 vs 0.76 全量重跑：密度标定 / F01a·F05 / M→软上限 / X18 四统计量');

const GAMES = Number(process.argv[2] || 400);
const EVCAP = 10;
const SPAWNS = [[2, 2], [125, 2], [2, 125], [125, 125]];
const EXITS = [[63, 0], [127, 63], [0, 63], [63, 127]];
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
function boot(pg, B = 2000) { const n = pg.length, o = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += pg[(Math.random() * n) | 0]; o.push(s / n); } o.sort((x, y) => x - y); return { lo: o[(B * .025) | 0], hi: o[(B * .975) | 0] }; }

// ---------- A. 密度标定（封边后 =  thinning 只作用 1..N-2，外圈恒墙）----------
console.log('########## A. 墙密度标定（我的实现，300 图/档，封边后）##########');
for (const keep of [0.64, 0.68, 0.70, 0.72, 0.76, 0.80]) {
  const ds = [], lens = [];
  for (let s = 0; s < 300; s++) {
    const mz = generateMaze(mulberry32(subSeed(9000 + s * 613, 1)), { spawns: SPAWNS, exits: EXITS, thinKeep: keep });
    ds.push(mz.density);
    let ok = 0, tot = 0;
    for (let i = 0; i < 4; i++) {
      const f = bfsField(mz.grid, [at(EXITS[i][0], EXITS[i][1])]);
      const d = f[at(SPAWNS[i][0], SPAWNS[i][1])];
      if (d >= 0) { tot += d; if (d >= 68 && d <= 108) ok++; }
    }
    if (ok === 4) lens.push(tot / 4);
  }
  console.log(`  keep=${keep.toFixed(2)}  密度 mean ${av(ds).toFixed(4)}  P05 ${q(ds, .05).toFixed(4)}  P95 ${q(ds, .95).toFixed(4)}   ${Math.abs(av(ds) - 0.355) <= 0.008 ? '✅ 命中 0.355±0.008' : '❌ 偏离'}   四人全在[68,108]的图 ${(lens.length / 300 * 100).toFixed(1)}%  路径均值 ${lens.length ? av(lens).toFixed(1) : '-'}`);
}

// ---------- B. 两档 keep 的全量仿真 ----------
for (const keep of [0.68, 0.76]) {
  const perAgentMid = [], gameMid = [], gameEnd = [], esc = [], turns = [];
  const failRate = [], arriveRate = [];
  let nA = 0, fail = 0, esc0 = 0, nEntered = 0, ge6 = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, {
      nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: keep,
      gemColors: 5, gemsPerColor: 2, minSep: 30, intervalEnd: 6,
    });
    if (r.invalid) continue;
    turns.push(r.turns);
    let m = 0, e = 0, f = 0;
    for (const a of r.actors) {
      nA++; perAgentMid.push(a.midCalls + EVCAP);
      m += a.midCalls; e += a.endCalls;
      if (a.status === 'failed') { fail++; f++; }
      if (a.status === 'escaped') { esc.push(a.stamina); if (a.stamina === 0) esc0++; if (a.endgameEntries >= 1) { nEntered++; if (a.endCalls >= 6) ge6++; } }
    }
    gameMid.push(m); gameEnd.push(e);
    failRate.push(f / r.actors.length); arriveRate.push(1 - f / r.actors.length);
  }
  const G = gameMid.length, p = fail / nA;
  const cbF = boot(failRate), cbA = boot(arriveRate);
  const Mp95 = q(perAgentMid, .95), Mmax = Math.max(...perAgentMid);
  const su = Math.ceil(Mp95 * 1.15 / 5) * 5;

  console.log(`\n########## B. keep=${keep} 全量（${G} 局 / ${nA} actor-局）##########`);
  console.log(`回合 P50 ${q(turns, .5)} / P95 ${q(turns, .95)} / max ${Math.max(...turns)}`);
  console.log(`F01a 失败率 ${(p * 100).toFixed(1)}%  聚类CI [${(cbF.lo * 100).toFixed(1)}, ${(cbF.hi * 100).toFixed(1)}]  门槛 ≤15% & CI上限 ≤20% → ${p <= .15 && cbF.hi <= .20 ? '✅' : '❌'}`);
  console.log(`F05  到达率 ${((1 - p) * 100).toFixed(1)}%  聚类CI [${(cbA.lo * 100).toFixed(1)}, ${(cbA.hi * 100).toFixed(1)}]  门槛 ≥85% & CI下限 ≥80% → ${(1 - p) >= .85 && cbA.lo >= .80 ? '✅' : '❌'}`);
  console.log(`M(per-agent 常态，含事件${EVCAP})  mean ${av(perAgentMid).toFixed(2)}  P90 ${q(perAgentMid, .90)}  P95 ${Mp95}  P99 ${q(perAgentMid, .99)}  max ${Mmax}`);
  console.log(`  → 规则: 软上限 = ceil(${Mp95}×1.15/5)×5 = ${su}  常态池 ${4 * su} / 终盘池 ${360 - 4 * su}  ${360 - 4 * su >= 60 ? '✅' : '❌'}   (per-agent max ${Mmax} ${Mmax <= su ? '≤' : '>'} ${su} → 被削占比 ${(perAgentMid.filter(x => x > su).length / nA * 100).toFixed(1)}%)`);
  console.log(`常态池 max ${Math.max(...gameMid) + 40}（含事件40）  终盘池 max ${Math.max(...gameEnd)}  总量 max ${Math.max(...gameMid.map((x, i) => x + 40 + gameEnd[i]))}`);
  console.log(`X18 逃脱者剩余体力 (n=${esc.length})  P10 ${q(esc, .10)}  P50 ${q(esc, .50)}  P90 ${q(esc, .90)}  mean ${av(esc).toFixed(1)}  擦线(==0) ${(esc0 / esc.length * 100).toFixed(1)}%  擦线(≤20) ${(esc.filter(x => x <= 20).length / esc.length * 100).toFixed(1)}%  剩余/初始 P50 ${(q(esc, .50) / 400 * 100).toFixed(1)}%`);
  console.log(`  进终盘者 ${nEntered} 人，≥6 次 ${(ge6 / nEntered * 100).toFixed(1)}%`);
}
