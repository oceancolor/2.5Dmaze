// ③+④+X16+X17+X18：单局动画时长测算 + 回合数分位 + 成功者剩余体力分位 + 人均宝石口径钉死
//    体力 400 / 四人 / 10 颗（gemsPerColor=2）/ reject+minSep30
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2e · ③+④+X16+X17+X18：单局动画时长测算 + 回合数分位 + 成功者剩余体力分位 + 人均宝石口径钉死 / 体力 400 / 四人 ');

const GAMES = Number(process.argv[2] || 400);
const BASE = {
  nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: 0.76,
  gemColors: 5, gemsPerColor: 2, minSep: 30,
};

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;

function run(label, o) {
  const turns = [], escStam = [], escRatio = [];
  let itemAll = 0, nA = 0, esc = 0, fail = 0;
  const anim = { move: 0, bump: 0, pick: 0, end: 0, idle: 0, turns: 0 };
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({}, BASE, o));
    if (r.invalid) continue;
    turns.push(r.turns);
    for (const k of ['move', 'bump', 'pick', 'end', 'idle', 'turns']) anim[k] += r.anim[k];
    for (const a of r.actors) {
      nA++; itemAll += a.picked;
      if (a.status === 'escaped') { esc++; escStam.push(a.stamina); escRatio.push(a.stamina / 400); }
      else if (a.status === 'failed') fail++;
    }
  }
  const T = turns.length;
  console.log(`\n===== ${label}  (有效局 ${T}) =====`);
  console.log(`回合数  mean ${av(turns).toFixed(1)}  P10 ${q(turns, .10)}  P50 ${q(turns, .50)}  P90 ${q(turns, .90)}  P95 ${q(turns, .95)}  max ${Math.max(...turns)}`);
  console.log(`        [320,400] 占比 ${(turns.filter(t => t >= 320 && t <= 400).length / T * 100).toFixed(1)}%   ≤480 占比 ${(turns.filter(t => t <= 480).length / T * 100).toFixed(1)}%`);
  console.log(`动画直方图(每局均值)  移动 ${(anim.move / T).toFixed(1)}  拾取 ${(anim.pick / T).toFixed(1)}  弹回 ${(anim.bump / T).toFixed(1)}  结算 ${(anim.end / T).toFixed(2)}  全静止 ${(anim.idle / T).toFixed(2)}  总回合 ${(anim.turns / T).toFixed(1)}`);
  console.log(`成功者剩余体力(样本=逃脱瞬间全部逃脱者 n=${escStam.length})  P10 ${q(escStam, .10)}  P50 ${q(escStam, .50)}  P90 ${q(escStam, .90)}  mean ${av(escStam).toFixed(1)}`);
  console.log(`  擦线占比(剩余=0) ${(escStam.filter(x => x === 0).length / escStam.length * 100).toFixed(1)}%   剩余/初始 P50 ${(q(escRatio, .50) * 100).toFixed(1)}%  落在[10%,30%] ${(escRatio.filter(x => x >= .10 && x <= .30).length / escRatio.length * 100).toFixed(1)}%`);
  console.log(`人均宝物件数(宝石+宝箱) ${(itemAll / nA).toFixed(2)}   逃脱率 ${(esc / nA * 100).toFixed(1)}%  失败率 ${(fail / nA * 100).toFixed(1)}%`);
  return { turns, T, anim, escStam, escRatio, itemAll: itemAll / nA, escRate: esc / nA };
}

console.log('########## X16 / X17 / X18 + ④ 基础量（400 局）##########');
const A = run('【A】体力400 · 四人 · 10颗 · reject+minSep30', {});
const B = run('【B】体力400 · 四人 · 5颗 · reject+minSep30（对照）', { gemsPerColor: 1 });
const C = run('【C】体力400 · 四人 · 10颗 · new（旧撒点，对照）', { placementMode: 'new' });

// ---------- ④ 单局纯动画时长 ----------
// 口径：每回合墙钟 = ceil(该回合最长动画 / 倍速 / 16.667ms) × 16.667ms（rAF 帧量化）
const FRAME = 1000 / 60;
const CAND = [
  { name: 'moveMs=250（L03 上限，最坏档）', move: 250, bump: 180, pick: 300, end: 600 },
  { name: 'moveMs=220（建议默认）', move: 220, bump: 160, pick: 260, end: 600 },
  { name: 'moveMs=200', move: 200, bump: 150, pick: 240, end: 600 },
  { name: 'moveMs=150（团队假设值）', move: 150, bump: 120, pick: 200, end: 600 },
];

function animTime(anim, T, c, speed, statTurns) {
  const per = { move: c.move, bump: c.bump, pick: c.pick, end: c.end, idle: 0 };
  // 按 P50/P90/P95 回合数缩放直方图（直方图按每局均值）
  const scale = statTurns / (anim.turns / T);
  let tot = 0;
  for (const k of ['move', 'bump', 'pick', 'end', 'idle']) {
    const n = (anim[k] / T) * scale;
    tot += n * Math.ceil(per[k] / speed / FRAME) * FRAME;
  }
  return tot / 1000;
}

console.log('\n\n########## ④ 单局纯动画时长（A 口径：体力400/四人/10颗）##########');
console.log('（每回合墙钟按 60fps 帧量化；直方图按该局均值，回合数取对应分位）');
for (const c of CAND) {
  console.log(`\n--- ${c.name}  (bump=${c.bump} pick=${c.pick} end=${c.end}) ---`);
  for (const [pn, p] of [['P50', .50], ['P90', .90], ['P95', .95]]) {
    const tn = q(A.turns, p);
    const r1 = animTime(A.anim, A.T, c, 1, tn);
    const r2 = animTime(A.anim, A.T, c, 2, tn);
    const r4 = animTime(A.anim, A.T, c, 4, tn);
    const flag = v => v <= 90 ? 'OK ' : 'BAD';
    console.log(`  回合${pn}=${tn}:  1× ${r1.toFixed(1)}s [${flag(r1)}]   2× ${r2.toFixed(1)}s [${flag(r2)}]   4× ${r4.toFixed(1)}s [${flag(r4)}]`);
  }
  // L01 校验：4× 单回合墙钟 ≤ 1× 的 1/3
  const t1 = Math.ceil(c.move / 1 / FRAME) * FRAME, t4 = Math.ceil(c.move / 4 / FRAME) * FRAME;
  console.log(`  L01 单回合墙钟: 1× ${t1.toFixed(1)}ms  4× ${t4.toFixed(1)}ms  比值 ${(t4 / t1).toFixed(3)} (要求 ≤0.333) ${t4 / t1 <= 1 / 3 ? 'OK' : 'BAD'}`);
}

// ---------- ③ 450 在 360 额度下重算（修正 chest 上限 bug 后）----------
console.log('\n\n########## ③ 体力 450 复核（修正 chest 体力上限 bug：min(400,...) → min(O.stamina,...)）##########');
const D = run('【D】体力450 · 四人 · 10颗 · reject+minSep30', { stamina: 450 });
const E = run('【E】体力400 · 四人 · 10颗 · reject+minSep30（同 A，并列便于对照）', {});
