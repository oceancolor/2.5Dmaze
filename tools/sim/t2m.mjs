// X24（分母与聚类自助 CI）+ X26（"擦线"各候选定义）+ X28（"剩余体力 78"是哪个量）
// + X25（10 颗下理性 vs 激进是否还分得开）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2m · X24（分母与聚类自助 CI）+ X26（"擦线"各候选定义）+ X28（"剩余体力 78"是哪个量） / + X25（10 颗下理性 vs');

const GAMES = Number(process.argv[2] || 400);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
const BASE = { nAgents: 4, placementMode: 'reject', thinKeep: 0.76, gemColors: 5, gemsPerColor: 2, minSep: 30 };

function collect(o) {
  const perGame = [];                 // 每局的失败 actor 数（0..4）
  const esc = [];                     // 逃脱者剩余体力
  let nA = 0, fail = 0, esc0 = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({}, BASE, o));
    if (r.invalid) continue;
    let f = 0;
    for (const a of r.actors) {
      nA++;
      if (a.status === 'failed') { fail++; f++; }
      if (a.status === 'escaped') { esc.push(a.stamina); if (a.stamina === 0) esc0++; }
    }
    perGame.push(f / r.actors.length);   // 该局失败占比
  }
  return { perGame, esc, nA, fail, esc0, G: perGame.length };
}

// 聚类自助：以「局」为簇重抽样，统计量为 actor-局 失败率
function clusterBoot(perGame, B = 2000) {
  const n = perGame.length;
  const out = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += perGame[(Math.random() * n) | 0];
    out.push(s / n);
  }
  out.sort((x, y) => x - y);
  return { lo: out[(B * 0.025) | 0], hi: out[(B * 0.975) | 0] };
}

console.log('########## X24 · 失败率的分母与 CI ##########');
console.log('我历次报的失败率（9.4% / 8.3% / 11.9%）用的分母 = **actor-局**（Σ失败actor / Σactor），不是"有失败的局数占比"。');
for (const [lab, o] of [['10 颗 · 四人', {}], ['5 颗 · 四人', { gemsPerColor: 1 }]]) {
  const c = collect(o);
  const p = c.fail / c.nA;
  const naive = 1.96 * Math.sqrt(p * (1 - p) / c.nA);
  const cb = clusterBoot(c.perGame);
  console.log(`\n${lab}（${c.G} 局 / ${c.nA} actor-局）`);
  console.log(`  点估计（actor-局 分母）         ${(p * 100).toFixed(1)}%`);
  console.log(`  朴素 CI（把 actor-局 当独立）   ±${(naive * 100).toFixed(1)}pt  → [${((p - naive) * 100).toFixed(1)}%, ${((p + naive) * 100).toFixed(1)}%]`);
  console.log(`  聚类自助 CI（以局为簇，B=2000） ±${(((cb.hi - cb.lo) / 2) * 100).toFixed(1)}pt  → [${(cb.lo * 100).toFixed(1)}%, ${(cb.hi * 100).toFixed(1)}%]  ← **用这个**`);
  const gamesWithFail = c.perGame.filter(x => x > 0).length / c.G;
  console.log(`  （另：'至少有 1 人失败的局' 占比 = ${(gamesWithFail * 100).toFixed(1)}% —— 这是第三个口径，别混）`);
}

console.log('\n\n########## X26 · "擦线"的候选定义（10 颗 · 四人 · 体力 400）##########');
{
  const c = collect({});
  const n = c.esc.length;
  console.log(`样本 = 逃脱瞬间全部逃脱者 n=${n}`);
  for (const th of [0, 5, 10, 20, 40]) {
    const k = c.esc.filter(x => x <= th).length;
    console.log(`  剩余体力 ≤ ${String(th).padStart(2)} 点（初始的 ${(th / 4).toFixed(0)}%）: ${k} 人  ${(k / n * 100).toFixed(1)}%`);
  }
  console.log(`  剩余体力 == 0（严格"断电到达"）: ${c.esc0} 人  ${(c.esc0 / n * 100).toFixed(1)}%`);
  console.log(`  分位: P10 ${q(c.esc, .10)}  P50 ${q(c.esc, .50)}  P90 ${q(c.esc, .90)}  mean ${av(c.esc).toFixed(1)}`);
  console.log('\n  → 我报的 0.1% 用的是「剩余体力 == 0」。主理人的 6.5% 不可能是同一定义（我 ≤5 点也才 ' +
    (c.esc.filter(x => x <= 5).length / n * 100).toFixed(1) + '%）。');
}

console.log('\n\n########## X28 · "剩余体力 78" 是哪个量 ##########');
for (const [lab, o] of [
  ['10 颗 · 四人 · reject', {}],
  ['5 颗 · 四人 · reject', { gemsPerColor: 1 }],
  ['5 颗 · 四人 · new', { gemsPerColor: 1, placementMode: 'new' }],
  ['10 颗 · 单人 · reject', { nAgents: 1 }],
  ['5 颗 · 单人 · reject', { nAgents: 1, gemsPerColor: 1 }],
  ['10 颗 · 四人 · reject · 激进', { aggressive: true }],
]) {
  const c = collect(o);
  console.log(`${lab.padEnd(30)} 剩余体力 P10 ${String(q(c.esc, .10)).padStart(3)}  P50 ${String(q(c.esc, .50)).padStart(3)}  P90 ${String(q(c.esc, .90)).padStart(3)}  mean ${av(c.esc).toFixed(1).padStart(5)}   回合mean ${'-'}  到达率 ${(c.esc.length / c.nA * 100).toFixed(1)}%`);
}

console.log('\n\n########## X25 · 10 颗下"理性 vs 激进"还分不分得开 ##########');
{
  const R = collect({});
  const A = collect({ aggressive: true });
  const pR = R.fail / R.nA, pA = A.fail / A.nA;
  const cbR = clusterBoot(R.perGame), cbA = clusterBoot(A.perGame);
  console.log(`理性贪心 失败率 ${(pR * 100).toFixed(1)}%  聚类CI [${(cbR.lo * 100).toFixed(1)}, ${(cbR.hi * 100).toFixed(1)}]`);
  console.log(`激进(关预算检查) ${(pA * 100).toFixed(1)}%  聚类CI [${(cbA.lo * 100).toFixed(1)}, ${(cbA.hi * 100).toFixed(1)}]`);
  console.log(`差值 ${((pA - pR) * 100).toFixed(1)}pt —— 两个 CI ${cbR.hi < cbA.lo || cbA.hi < cbR.lo ? '不重叠 → 分得开 ✅' : '**重叠 → 分不开 ❌**'}`);
  console.log(`（5 颗时代是 8.3% vs 11.9%，差 3.6pt）`);
}
