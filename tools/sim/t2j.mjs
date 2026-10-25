// P18 复核：进入终盘的 agent，其终盘重规划次数分布（v1.9 终盘 interval=8）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2j · P18 复核：进入终盘的 agent，其终盘重规划次数分布（v1.9 终盘 interval=8）');
const GAMES = Number(process.argv[2] || 400);
const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
const av=a=>a.reduce((x,y)=>x+y,0)/a.length;
for (const st of [400, 450]) {
  const entered = [], all = [];
  let nEntered = 0, nAll = 0, ge6 = 0, ge8 = 0, escapedInEnd = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, { nAgents: 4, stamina: st, placementMode: 'reject', thinKeep: 0.76, gemColors: 5, gemsPerColor: 2, minSep: 30, intervalEnd: 8 }); // 钉 8：历史口径
    if (r.invalid) continue;
    for (const a of r.actors) {
      nAll++; all.push(a.endCalls);
      if (a.endgameEntries >= 1) { nEntered++; entered.push(a.endCalls); if (a.endCalls >= 6) ge6++; if (a.endCalls >= 8) ge8++; if (a.status === 'escaped') escapedInEnd++; }
    }
  }
  console.log(`体力 ${st}`);
  console.log(`  全部 agent（n=${nAll}）        终盘调用 mean ${av(all).toFixed(2)}  P50 ${q(all,.5)}  P90 ${q(all,.9)}  max ${Math.max(...all)}`);
  console.log(`  进过终盘的 agent（n=${nEntered}，占 ${(nEntered/nAll*100).toFixed(1)}%）`);
  console.log(`    终盘调用 mean ${av(entered).toFixed(2)}  P10 ${q(entered,.10)}  P50 ${q(entered,.5)}  P90 ${q(entered,.9)}  max ${Math.max(...entered)}`);
  console.log(`    ≥6 次占比 ${(ge6/nEntered*100).toFixed(1)}%   ≥8 次占比 ${(ge8/nEntered*100).toFixed(1)}%   其中逃脱者占 ${(escapedInEnd/nEntered*100).toFixed(1)}%`);
  console.log('');
}
