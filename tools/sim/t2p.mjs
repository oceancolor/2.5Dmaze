// moveMs 终裁复核：180 vs 175 vs 200 vs 250（含"顺序播放"修正 + 4×/2× 帧量化等价性）
// 背景：美术拍 180（节奏下限），QA 建议 175（余量），此前主理人拍过 250 / 200。
// 本脚本同时回答：① 1× 对 90s 的真实余量  ② 4×"必须 3 渲染帧"是否构成对 180 的硬阻塞
import { simulateGame, cfgSummary } from './lib.mjs';

const GAMES = Number(process.argv[2] || 400);
const FRAME = 1000 / 60;
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;

const BASE = {
  nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: 0.76,
  gemColors: 5, gemsPerColor: 2, minSep: 30,
};

cfgSummary(BASE, 't2p · moveMs 终裁复核');

// ---------- 采集：每局 anim 直方图 + 回合数 ----------
const games = [];
for (let s = 0; s < GAMES; s++) {
  const r = simulateGame(5000 + s * 131, BASE);
  if (r.invalid) continue;
  games.push({ turns: r.turns, a: r.anim });
}
const T = games.length;
console.log(`  有效局数 ${T}   回合 P50 ${q(games.map(g => g.turns), .50)} / P90 ${q(games.map(g => g.turns), .90)} / P95 ${q(games.map(g => g.turns), .95)}`);

// ---------- 两种播放模型 ----------
// A（max，旧模型）：每回合只算最长那段动画
// B（sequential，真实模型）：拾取/结算回合 = 移动 + 演出 顺序播放
// A: pick/end 都与移动重叠（取 max）  B: 两者都顺序  C: pick 重叠、end 顺序
function perTurn(anim, c, speed, model) {
  const out = {};
  out.move = c.move;
  out.bump = c.bump;
  out.pick = (model === 'B') ? c.move + c.pick : c.pick;
  out.end = (model === 'A') ? c.end : c.move + c.end;
  out.idle = 0;
  return out;
}
function total(g, c, speed, model) {
  const p = perTurn(g.a, c, speed, model);
  let t = 0;
  for (const k of ['move', 'bump', 'pick', 'end', 'idle']) {
    if (!g.a[k]) continue;
    t += g.a[k] * Math.ceil(p[k] / speed / FRAME) * FRAME;
  }
  return t / 1000;
}

const CANDS = [150, 165, 175, 180, 200, 250];
const MN = { A: '（pick 与 end 都与移动重叠，取 max）', B: '（pick 与 end 都顺序接在移动之后）', C: '（pick 重叠、end 顺序）' };
for (const model of ['C', 'A', 'B']) {
  console.log(`\n########## 播放模型 ${model}${MN[model]} ##########`);
  console.log('  moveMs |   1× P50 / P90 / P95  | 对90s余量(P95) |   2× P50 |   4× P50 | L01(1×/4× 单回合比)');
  for (const mv of CANDS) {
    const c = { move: mv, bump: 180, pick: 320, end: 600 };
    const t1 = games.map(g => total(g, c, 1, model));
    const t2 = games.map(g => total(g, c, 2, model));
    const t4 = games.map(g => total(g, c, 4, model));
    const p50 = q(t1, .50), p90 = q(t1, .90), p95 = q(t1, .95);
    const w1 = Math.ceil(mv / 1 / FRAME) * FRAME;
    const w4 = Math.ceil(mv / 4 / FRAME) * FRAME;
    const margin = ((90 - p95) / 90 * 100).toFixed(1);
    console.log(`  ${String(mv).padStart(6)} | ${p50.toFixed(1).padStart(6)} / ${p90.toFixed(1).padStart(6)} / ${p95.toFixed(1).padStart(6)} | ${String(margin).padStart(9)}% | ${q(t2, .50).toFixed(1).padStart(8)} | ${q(t4, .50).toFixed(1).padStart(8)} | ${w1.toFixed(1)}/${w4.toFixed(1)} = ${(w4 / w1).toFixed(3)} ${(w4 / w1) <= 0.333 ? '✅' : '❌'}`);
  }
}

// ---------- 反解：要拿到 M08 要求的 ≥5pt 余量（P95 ≤ 85.5s），moveMs 上限是多少 ----------
console.log('\n########## 反解：1× P95 余量 ≥5pt（即 ≤85.5s）的最大 moveMs ##########');
for (const model of ['C', 'A', 'B']) {
  const ok = [];
  for (let mv = 100; mv <= 300; mv += 1) {
    const c = { move: mv, bump: 180, pick: 320, end: 600 };
    const p95 = q(games.map(g => total(g, c, 1, model)), .95);
    if (p95 <= 85.5) ok.push(mv);
  }
  console.log(`  模型 ${model}：moveMs ≤ ${ok.length ? Math.max(...ok) : '无解'} ms`);
}

// ---------- 兜底反解：若拾取必须"落地后单独播"（pickOverlaps=false），pickMs 上限是多少 ----------
console.log('\n########## 兜底：moveMs 锁 180 且 pick 顺序播放时，pickMs 最大可给多少（P95 ≤85.5s）##########');
{
  const ok = [];
  for (let pk = 100; pk <= 600; pk += 2) {
    const c = { move: 180, bump: 180, pick: pk, end: 600 };
    if (q(games.map(g => total(g, c, 1, 'B')), .95) <= 85.5) ok.push(pk);
  }
  console.log(`  pickMs ≤ ${ok.length ? Math.max(...ok) : '无解'} ms（当前提案 320 ms）`);
  const ok2 = [];
  for (let mv = 100; mv <= 300; mv += 1) {
    const c = { move: mv, bump: 180, pick: 320, end: 600 };
    if (q(games.map(g => total(g, c, 1, 'B')), .95) <= 85.5) ok2.push(mv);
  }
  console.log(`  等价的另一条路：pickMs 保持 320，则 moveMs ≤ ${Math.max(...ok2)} ms（低于美术节奏下限 180 → 不可取）`);
}

// ---------- 关键：2×/4× 的帧量化等价性 ----------
console.log('\n########## 帧量化等价性：moveMs 在 2×/4× 是否还分得开 ##########');
console.log('  moveMs | 1× 帧数/墙钟 | 2× 帧数/墙钟 | 4× 帧数/墙钟 | 4× 内可见节拍(6拍序列)');
for (const mv of [150, 165, 175, 180, 200, 220, 250]) {
  const f = s => Math.ceil(mv / s / FRAME);
  const w = s => (f(s) * FRAME).toFixed(1);
  // 6 拍序列在 4× 下：渲染采样时刻 0,16.67,33.33,... 落在哪个节拍
  const dur = mv / 4, beat = dur / 6;
  const beats = [];
  for (let t = 0; t < dur; t += FRAME) beats.push(Math.min(5, Math.floor(t / beat)));
  console.log(`  ${String(mv).padStart(6)} | ${String(f(1)).padStart(2)} 帧 ${w(1).padStart(6)} | ${String(f(2)).padStart(2)} 帧 ${w(2).padStart(6)} | ${String(f(4)).padStart(2)} 帧 ${w(4).padStart(6)} | 采样 ${beats.length} 次 → 节拍 [${beats.join(',')}]`);
}

// ---------- 6 拍序列在 1× 下的真实帧率 ----------
console.log('\n########## 1× 下 6 拍序列的观感帧率（美术关注）##########');
for (const mv of [175, 180, 200, 250]) {
  const beatMs = mv / 6;
  console.log(`  moveMs ${mv}: ${beatMs.toFixed(1)} ms/拍 = ${(1000 / beatMs).toFixed(1)} fps；1× 渲染帧数 ${Math.ceil(mv / FRAME)} → 实际可见节拍 ${Math.min(6, Math.ceil(mv / FRAME))}/6`);
}
