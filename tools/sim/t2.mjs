// 任务 2：体力 400 复核（200 局 × 单人独占 / 四人竞争）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2 · 任务 2：体力 400 复核（200 局 × 单人独占 / 四人竞争）');

const GAMES = Number(process.argv[2] || 200);
const SEED0 = 5000;

function run(nAgents, stamina, placementMode, games = GAMES) {
  let n = 0, invalid = 0;
  const picked = [], colors = [], turns = [], fail = [], esc = [], scores = [], pickedMax = [];
  for (let s = 0; s < games; s++) {
    const r = simulateGame(SEED0 + s * 131, {
      nAgents, stamina, placementMode, thinKeep: 0.76,
      exits: [[63, 0], [127, 63], [0, 63], [63, 127]],
    });
    if (r.invalid) { invalid++; continue; }
    n++;
    turns.push(r.turns);
    for (const a of r.actors) {
      picked.push(a.picked); colors.push(a.colors); scores.push(a.score);
      if (a.status === 'failed') fail.push(1); else fail.push(0);
      if (a.status === 'escaped') esc.push(1); else esc.push(0);
    }
    pickedMax.push(Math.max(...r.actors.map(a => a.picked)));
  }
  const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  const pct = a => (a.reduce((x, y) => x + y, 0) / a.length * 100);
  const t = turns.slice().sort((a, b) => a - b);
  return {
    games: n, invalid,
    pickedAvg: av(picked),
    ge3: picked.filter(x => x >= 3).length / picked.length,
    ge5: picked.filter(x => x >= 5).length / picked.length,
    all5: colors.filter(c => c >= 5).length / colors.length,
    failRate: pct(fail),
    escRate: pct(esc),
    scoreAvg: av(scores),
    turnMean: av(turns), turnP50: t[(t.length / 2) | 0], turnMin: t[0], turnMax: t[t.length - 1],
    turnsIn320to400: turns.filter(x => x >= 320 && x <= 400).length / turns.length,
  };
}

function show(label, r) {
  console.log(`\n### ${label}`);
  console.log(`有效局 ${r.games}（连通失败 ${r.invalid}）`);
  console.log(`平均可捡宝物数      ${r.pickedAvg.toFixed(2)}`);
  console.log(`≥3 个占比           ${(r.ge3 * 100).toFixed(1)}%`);
  console.log(`≥5 个占比           ${(r.ge5 * 100).toFixed(1)}%`);
  console.log(`五色全拿（通吃）    ${(r.all5 * 100).toFixed(1)}%`);
  console.log(`失败率              ${r.failRate.toFixed(1)}%`);
  console.log(`达成率              ${r.escRate.toFixed(1)}%`);
  console.log(`平均得分            ${r.scoreAvg.toFixed(2)}`);
  console.log(`单局回合数          均值 ${r.turnMean.toFixed(1)}  P50 ${r.turnP50}  min ${r.turnMin}  max ${r.turnMax}  落在320-400 ${(r.turnsIn320to400 * 100).toFixed(1)}%`);
}

console.log('======== 单人独占（与前任 200 局仿真同口径）========');
show('体力 400 / 撒点 new', run(1, 400, 'new'));
show('体力 400 / 撒点 old', run(1, 400, 'old'));

console.log('\n======== 四人竞争（实际对局）========');
show('体力 400 / 撒点 new', run(4, 400, 'new'));

console.log('\n======== 体力梯度（单人独占 / 撒点 new）========');
for (const st of [300, 350, 400, 450, 500]) show(`体力 ${st}`, run(1, st, 'new', 120));
