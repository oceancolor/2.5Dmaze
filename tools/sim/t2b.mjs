// 任务 2 附：失败率敏感性（贪心激进程度 / 终盘阈值系数）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2b · 任务 2 附：失败率敏感性（贪心激进程度 / 终盘阈值系数）');
const GAMES = Number(process.argv[2] || 200);

function run(label, o) {
  let n = 0; const picked = [], fail = [], turns = [], colors = [], ge3 = [];
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'new', thinKeep: 0.76,
      exits: [[63, 0], [127, 63], [0, 63], [63, 127]],
    }, o));
    if (r.invalid) continue;
    n++; turns.push(r.turns);
    for (const a of r.actors) {
      picked.push(a.picked); colors.push(a.colors);
      fail.push(a.status === 'failed' ? 1 : 0);
      ge3.push(a.picked >= 3 ? 1 : 0);
    }
  }
  const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`${label}  局 ${n}  可捡 ${av(picked).toFixed(2)}  ≥3 ${(av(ge3) * 100).toFixed(1)}%  五色全拿 ${(colors.filter(c => c >= 5).length / colors.length * 100).toFixed(1)}%  失败率 ${(av(fail) * 100).toFixed(1)}%  回合 ${av(turns).toFixed(1)}`);
}

console.log('--- 四人竞争 · 终盘阈值系数 ---');
for (const f of [1.0, 1.15, 1.3, 1.6]) run(`factor=${f}  预算检查开`, { endgameFactor: f });
console.log('--- 四人竞争 · 激进贪心（关闭预算检查）---');
for (const f of [1.0, 1.15, 1.3, 1.6]) run(`factor=${f}  预算检查关`, { endgameFactor: f, aggressive: true });
console.log('--- 单人独占 · 激进贪心 ---');
for (const f of [1.0, 1.3]) run(`factor=${f}  单人`, { endgameFactor: f, aggressive: true, nAgents: 1 });
