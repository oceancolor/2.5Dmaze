// ③ 体力 450 在 X13=360 额度下的调用数复核（修正 chest 上限 bug 后）
// 调用模型（X14 终裁）：中盘 interval=10，终盘（stamina<=60）无条件回调 interval=8，事件 ≤6/agent/局
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2g · ③ 体力 450 在 X13=360 额度下的调用数复核（修正 chest 上限 bug 后） / 调用模型（X14 终裁）：中盘 inte');

const GAMES = Number(process.argv[2] || 400);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;

function calls(seedTurns, endTurn) {
  const T = endTurn > 0 ? endTurn : seedTurns;
  const endg = Math.min(T, 60);
  const mid = Math.max(0, T - endg);
  return Math.ceil(mid / 10) + Math.ceil(endg / 8) + 6;
}

for (const st of [400, 450]) {
  const perGame = [], perAgent = [], turns = [];
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, {
      nAgents: 4, stamina: st, placementMode: 'reject', thinKeep: 0.76,
      gemColors: 5, gemsPerColor: 2, minSep: 30,
    });
    if (r.invalid) continue;
    turns.push(r.turns);
    let g = 0;
    for (const a of r.actors) { const c = calls(r.turns, a.endTurn); perAgent.push(c); g += c; }
    perGame.push(g);
  }
  const n = perGame.length;
  console.log(`体力 ${st}（${n} 局）`);
  console.log(`  单局调用数(4人合计)  mean ${av(perGame).toFixed(1)}  P50 ${q(perGame, .5)}  P95 ${q(perGame, .95)}  max ${Math.max(...perGame)}`);
  console.log(`  单人调用数           mean ${av(perAgent).toFixed(1)}  max ${Math.max(...perAgent)}`);
  console.log(`  超 240 占比 ${(perGame.filter(x => x > 240).length / n * 100).toFixed(1)}%   超 360 占比 ${(perGame.filter(x => x > 360).length / n * 100).toFixed(1)}%`);
  console.log(`  回合数 P50 ${q(turns, .5)} P95 ${q(turns, .95)}  [320,400] 占比 ${(turns.filter(t => t >= 320 && t <= 400).length / n * 100).toFixed(1)}%`);
  console.log('');
}
