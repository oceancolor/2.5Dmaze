// v1.9/X22 终裁口径复核 + X29 最终池值（240/120）复跑
// 用法：node tools/sim/t2l.mjs [局数] [终盘间隔] [常态池] [终盘池] [总量上限] [事件总额度]
//   node tools/sim/t2l.mjs 400 6 320 40 360 40   ← X22 口径
//   node tools/sim/t2l.mjs 400 6 240 120 360 40  ← X29 终裁口径（默认）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2l · X22/X29 双池复核：终盘间隔 6、常态池/终盘池可切（默认 X29 = 240/120）');
const GAMES = Number(process.argv[2] || 400);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
const intEnd = Number(process.argv[3] || 6);
const POOL_MID = Number(process.argv[4] || 240);
const POOL_END = Number(process.argv[5] || 120);
const CAP = Number(process.argv[6] || 360);
const EV = Number(process.argv[7] || 40);

for (const st of [400, 450]) {
  const mid = [], end = [], tot = [], perEnd = [], ent = [], turns = [], perMid = [];
  let n = 0, overMid = 0, overEnd = 0, overTot = 0, nEntered = 0, ge6 = 0, ge8 = 0, ge10 = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, { nAgents: 4, stamina: st, placementMode: 'reject', thinKeep: 0.76, gemColors: 5, gemsPerColor: 2, minSep: 30, intervalEnd: intEnd });
    if (r.invalid) continue;
    n++; turns.push(r.turns);
    let m = 0, e = 0;
    for (const a of r.actors) {
      m += a.midCalls; e += a.endCalls; perMid.push(a.midCalls); perEnd.push(a.endCalls); ent.push(a.endgameEntries);
      if (a.endgameEntries >= 1) { nEntered++; if (a.endCalls >= 6) ge6++; if (a.endCalls >= 8) ge8++; if (a.endCalls >= 10) ge10++; }
    }
    mid.push(m); end.push(e); tot.push(m + e);
    if (m > POOL_MID) overMid++; if (e > POOL_END) overEnd++; if (m + e > CAP) overTot++;
  }
  const pr = x => (x / n * 100).toFixed(1) + '%';
  console.log(`\n=== 体力 ${st} · 终盘间隔 ${intEnd} · ${n} 局 · 池 ${POOL_MID}/${POOL_END}（总 ${CAP}，事件 ${EV}）===`);
  console.log(`回合 P50 ${q(turns, .5)} / P95 ${q(turns, .95)} / max ${Math.max(...turns)}`);
  console.log(`常态池 ${POOL_MID}: mean ${av(mid).toFixed(1)} P95 ${q(mid, .95)} max ${Math.max(...mid)}  余量 ${POOL_MID - Math.max(...mid)}  破池 ${pr(overMid)}`);
  console.log(`终盘池 ${POOL_END}: mean ${av(end).toFixed(1)} P95 ${q(end, .95)} max ${Math.max(...end)}  余量 ${POOL_END - Math.max(...end)}  破池 ${pr(overEnd)}`);
  console.log(`总量  ${CAP}: mean ${av(tot).toFixed(1)} P95 ${q(tot, .95)} max ${Math.max(...tot)}  余量 ${CAP - Math.max(...tot)}  破顶 ${pr(overTot)}`);
  console.log(`  G23 归属：事件 ${EV} 全记常态池 → max ${Math.max(...mid) + EV} vs ${POOL_MID} ${Math.max(...mid) + EV > POOL_MID ? '❌' : '✅'} ；全记终盘池 → max ${Math.max(...end) + EV} vs ${POOL_END} ${Math.max(...end) + EV > POOL_END ? '❌' : '✅'}`);
  // per-agent 常态软上限校验（X29 规则：软上限 = ceil(M×1.15/5)×5，M 取 per-agent 常态调用 P95）
  const Mp95 = q(perMid, .95), Mmax = Math.max(...perMid);
  const soft = Math.ceil(Mp95 * 1.15 / 5) * 5;
  console.log(`  per-agent 常态调用 M: mean ${av(perMid).toFixed(2)} P95 ${Mp95} max ${Mmax}  → 软上限 ${soft}（规则 ceil(P95×1.15/5)×5）；软上限×4 = ${soft * 4} vs 常态池 ${POOL_MID} ${soft * 4 > POOL_MID ? '❌ 需压到 75' : '✅'}`);
  console.log(`  被软上限削到的 agent: ${(perMid.filter(x => x > soft).length / perMid.length * 100).toFixed(2)}%`);
  console.log(`单人终盘调用: mean ${av(perEnd).toFixed(2)} max ${Math.max(...perEnd)}  终盘进入次数 max ${Math.max(...ent)}`);
  console.log(`进终盘者(n=${nEntered}): 终盘调用 mean ${av(perEnd.filter(x => x > 0)).toFixed(2)} P50 ${q(perEnd.filter(x => x > 0), .5)} P90 ${q(perEnd.filter(x => x > 0), .90)}`);
  console.log(`  ≥6 次 ${(ge6 / nEntered * 100).toFixed(1)}%   ≥8 次 ${(ge8 / nEntered * 100).toFixed(1)}%   ≥10 次 ${(ge10 / nEntered * 100).toFixed(1)}%   ← G09b 红线`);
}
