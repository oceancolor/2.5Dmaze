// 任务 2 补：宝石数 5 颗 vs 10 颗（v1.6 gemsPerColor=2）对体力 400 结论的影响
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2c · 任务 2 补：宝石数 5 颗 vs 10 颗（v1.6 gemsPerColor=2）对体力 400 结论的影响');
const GAMES = Number(process.argv[2] || 200);

function run(label, o) {
  let n = 0;
  const picked = [], ge3 = [], ge5 = [], all5 = [], fail = [], turns = [], scores = [], callTot = [];
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'new', thinKeep: 0.76,
      exits: [[63, 0], [127, 63], [0, 63], [63, 127]],
    }, o));
    if (r.invalid) continue;
    n++; turns.push(r.turns);
    let ct = 0;
    for (const a of r.actors) {
      picked.push(a.picked); scores.push(a.score);
      ge3.push(a.picked >= 3 ? 1 : 0); ge5.push(a.picked >= 5 ? 1 : 0);
      all5.push(a.colors >= 5 ? 1 : 0);
      fail.push(a.status === 'failed' ? 1 : 0);
      const e = a.endTurn < 0 ? r.turns : a.endTurn;
      ct += Math.floor(e / 8) + 6;
    }
    callTot.push(ct);
  }
  const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  const t = turns.slice().sort((a, b) => a - b);
  const c = callTot.slice().sort((a, b) => a - b);
  console.log(`${label.padEnd(26)} 局${n}  可捡 ${av(picked).toFixed(2)}  ≥3 ${(av(ge3) * 100).toFixed(1)}%  ≥5 ${(av(ge5) * 100).toFixed(1)}%  集齐五色 ${(av(all5) * 100).toFixed(1)}%  分 ${av(scores).toFixed(2)}  失败 ${(av(fail) * 100).toFixed(1)}%  回合P50 ${t[(t.length / 2) | 0]}  调用合计均值 ${av(callTot).toFixed(0)}/P95 ${c[Math.floor(0.95 * c.length)]}/max ${c[c.length - 1]}`);
  return { turnsP50: t[(t.length / 2) | 0], callMax: c[c.length - 1] };
}

console.log('=== 四人竞争 · 体力 400 ===');
run('5 颗（每色 1，v1.4）', { gemsPerColor: 1 });
run('10 颗（每色 2，v1.6）', { gemsPerColor: 2 });
console.log('\n=== 单人独占 · 体力 400 ===');
run('5 颗 单人', { gemsPerColor: 1, nAgents: 1 });
run('10 颗 单人', { gemsPerColor: 2, nAgents: 1 });
console.log('\n=== 10 颗下的体力梯度（四人）===');
for (const st of [300, 350, 400, 450]) run(`10 颗 体力 ${st}`, { gemsPerColor: 2, stamina: st });
console.log('\n=== 10 颗下 minSep 敏感性（四人，体力400）===');
for (const ms of [20, 30, 40]) run(`10 颗 minSep=${ms}`, { gemsPerColor: 2, minSep: ms });
