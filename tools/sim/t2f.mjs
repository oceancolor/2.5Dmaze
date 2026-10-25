// X16 口径钉死 + ④ moveMs 阈值求解
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2f · X16 口径钉死 + ④ moveMs 阈值求解');

const GAMES = Number(process.argv[2] || 400);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
const FRAME = 1000 / 60;

function probe(label, o) {
  let gems = 0, chests = 0, n = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: 0.76,
      gemColors: 5, gemsPerColor: 2, minSep: 30,
    }, o));
    if (r.invalid) continue;
    for (const a of r.actors) { n++; gems += a.picked - a.chestHits; chests += a.chestHits; }
  }
  console.log(`${label.padEnd(46)} 人均宝石 ${(gems / n).toFixed(2)}   人均宝箱 ${(chests / n).toFixed(2)}   人均宝物(宝石+箱) ${((gems + chests) / n).toFixed(2)}`);
  return { gems: gems / n, chests: chests / n, all: (gems + chests) / n };
}

console.log('########## X16：人均「宝石」与人均「宝物」拆开（剔宝箱）##########');
probe('5颗 · reject+minSep30', { gemsPerColor: 1 });
probe('5颗 · new（旧撒点）', { gemsPerColor: 1, placementMode: 'new' });
probe('10颗 · reject+minSep30', {});
probe('10颗 · new（旧撒点）', { placementMode: 'new' });
probe('10颗 · reject+minSep30 · 单人独占', { nAgents: 1 });

// ---------- ④ moveMs 阈值求解：1× 纯动画 ≤90s 的最大 moveMs ----------
function collect(o) {
  const turns = []; const anim = { move: 0, bump: 0, pick: 0, end: 0, idle: 0, turns: 0 };
  let T = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: 0.76,
      gemColors: 5, gemsPerColor: 2, minSep: 30,
    }, o));
    if (r.invalid) continue;
    T++; turns.push(r.turns);
    for (const k of ['move', 'bump', 'pick', 'end', 'idle', 'turns']) anim[k] += r.anim[k];
  }
  return { turns, anim: { move: anim.move / T, bump: anim.bump / T, pick: anim.pick / T, end: anim.end / T, idle: anim.idle / T, turns: anim.turns / T }, T };
}

function total(anim, c, speed, statTurns) {
  const scale = statTurns / anim.turns;
  const per = { move: c.move, bump: c.bump, pick: c.pick, end: c.end, idle: 0 };
  let t = 0;
  for (const k of ['move', 'bump', 'pick', 'end', 'idle']) t += (anim[k] * scale) * Math.ceil(per[k] / speed / FRAME) * FRAME;
  return t / 1000;
}

const A = collect({});
console.log('\n########## ④ moveMs 阈值求解（1× 纯动画 ≤ 90 s）##########');
for (const [pn, p] of [['P50', .50], ['P90', .90], ['P95', .95]]) {
  const tn = q(A.turns, p);
  let lo = 40, hi = 400;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const c = { move: mid, bump: mid * 0.7, pick: mid * 1.2, end: 600 };
    if (total(A.anim, c, 1, tn) <= 90) lo = mid; else hi = mid;
  }
  console.log(`  回合${pn}=${tn}: 1×≤90s 要求 moveMs ≤ ${lo.toFixed(1)} ms  (bump=0.7×, pick=1.2× 联动)`);
}
console.log('\n  （4× 档：moveMs=250 时 P50 仅 26.7 s，距 90 s 有 3.4× 余量 → L02 的 90 s 若真按 4× 判，是空门禁）');

// 若决策不预取（最坏）：每回合都要等 decisionWindowMs
const tn50 = q(A.turns, .50);
console.log(`\n  反例对照：若 LLM 决策不做预取、每回合同步等待 decisionWindowMs=1500ms`);
console.log(`    1× 单局 = ${(tn50 * 1.5).toFixed(0)} s ；4× 也只省掉动画部分 → ${(tn50 * (0.25 + 1.5)).toFixed(0)} s。故「决策预取」是 ≤90s 的前提，不是可选项。`);
