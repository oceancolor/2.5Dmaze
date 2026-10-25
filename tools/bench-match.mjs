// v1.5 校验：A 边中点/出生点奇偶与地板概率  B 1000 种子 spawn→exit 路径  C v1.5 终稿完整对局
const N = 128, SIZE = N * N;
const KEEP = Number(process.env.KEEP || 0.68);
globalThis.BUDGET = true;
globalThis.DEDUP = process.env.DEDUP !== "0";
// —— 自报配置摘要（qa-lead X31②：脚本标签与实跑配置不符已发生 4 次，强制首屏自证）——
function selfReport(cfg, games, tag) {
  const gTot = 5 * cfg.gemsPerColor;
  console.log(`\n>>> [${tag}] 实跑配置自报`);
  console.log(`    gemsPerColor=${cfg.gemsPerColor} → 场上共 ${gTot} 颗（每色 ${cfg.gemsPerColor} 颗）；单角色每色最多计 1 颗 → 人均上限 ${5}`);
  console.log(`    stamina=${cfg.stamina} | thinKeepRatio=${KEEP} | maxTurns=${cfg.maxTurns} | gemGenerations=${cfg.gemGenerations} | rMax=${cfg.rMax} | perGemMax=${cfg.perGemMax}`);
  console.log(`    出口=${JSON.stringify(cfg.exits)} | 出生=${JSON.stringify(SP)} | 样本 N局=${games} | 预算检查=${globalThis.BUDGET ? '开' : '关'}`);
}
const idx = (x, y) => y * N + x;
const cxm = (c) => c % N, cym = (c) => (c / N) | 0;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const D2 = [[0, -2], [0, 2], [-2, 0], [2, 0]], D1 = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function genOdd(rnd) {
  const floor = new Uint8Array(SIZE); const list = [idx(1, 1)]; floor[list[0]] = 1; const dirs = D2.slice();
  while (list.length) {
    const r = rnd(); const i = r < 0.55 ? list.length - 1 : (r < 0.90 ? (rnd() * list.length) | 0 : 0);
    const cur = list[i], cx = cur % N, cy = (cur / N) | 0;
    for (let d = 3; d > 0; d--) { const j = (rnd() * (d + 1)) | 0; const t = dirs[d]; dirs[d] = dirs[j]; dirs[j] = t; }
    let ok = false;
    for (const [dx, dy] of dirs) { const nx = cx + dx, ny = cy + dy; if (nx < 1 || ny < 1 || nx > N - 2 || ny > N - 2) continue; if (floor[idx(nx, ny)]) continue; floor[idx(cx + dx / 2, cy + dy / 2)] = 1; floor[idx(nx, ny)] = 1; list.push(idx(nx, ny)); ok = true; break; }
    if (!ok) { list[i] = list[list.length - 1]; list.pop(); }
  }
  for (let r = 0; r < 4; r++) { const w = 5 + ((rnd() * 8) | 0), h = 5 + ((rnd() * 8) | 0); const x0 = 2 + ((rnd() * (N - w - 4)) | 0), y0 = 2 + ((rnd() * (N - h - 4)) | 0); for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) floor[idx(x, y)] = 1; }
  for (let i = 0; i < SIZE; i++) if (!floor[i] && rnd() > (KEEP)) floor[i] = 1;
  for (let x = 0; x < N; x++) { floor[idx(x, 0)] = 0; floor[idx(x, N - 1)] = 0; }
  for (let y = 0; y < N; y++) { floor[idx(0, y)] = 0; floor[idx(N - 1, y)] = 0; }
  return floor;
}
function carve(floor, cx, cy, r) { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x <= N - 1 && y <= N - 1) floor[idx(x, y)] = 1; }
function bfs(floor, src, out, q) { out.fill(-1); let h = 0, t = 0; q[t++] = src; out[src] = 0; while (h < t) { const c = q[h++], x = c % N, y = (c / N) | 0, d = out[c]; if (x + 1 < N && floor[c + 1] && out[c + 1] < 0) { out[c + 1] = d + 1; q[t++] = c + 1; } if (x - 1 >= 0 && floor[c - 1] && out[c - 1] < 0) { out[c - 1] = d + 1; q[t++] = c - 1; } if (y + 1 < N && floor[c + N] && out[c + N] < 0) { out[c + N] = d + 1; q[t++] = c + N; } if (y - 1 >= 0 && floor[c - N] && out[c - N] < 0) { out[c - N] = d + 1; q[t++] = c - N; } } }

const SP = [[2, 2], [125, 2], [125, 125], [2, 125]];
const EXIT = [[63, 0], [127, 63], [63, 127], [0, 63]];
const DOOR = [[63, 1], [126, 63], [63, 126], [1, 63]];   // 门格（carve 中心）
const RING = [[33, 33], [95, 33], [95, 95], [33, 95]];

// ================= A. 奇偶 / 地板概率 =================
console.log('=== A. 目标点「不 carve」时的地板率与连通率（2000 图）===');
const PROBES = [
  ['上 出口 (63,0)', 63, 0], ['上 门格 (63,1)', 63, 1], ['上 次格 (63,2)', 63, 2],
  ['右 出口 (127,63)', 127, 63], ['右 门格 (126,63)', 126, 63], ['右 节点 (125,63)', 125, 63],
  ['下 出口 (63,127)', 63, 127], ['下 门格 (63,126)', 63, 126], ['下 节点 (63,125)', 63, 125],
  ['左 出口 (0,63)', 0, 63], ['左 门格 (1,63)', 1, 63], ['左 次格 (2,63)', 2, 63],
  ['出生 左上 (2,2)', 2, 2], ['出生 右上 (125,2)', 125, 2], ['出生 右下 (125,125)', 125, 125], ['出生 左下 (2,125)', 2, 125],
  ['内侧环 (33,33)', 33, 33], ['内侧环 (95,33)', 95, 33], ['内侧环 (95,95)', 95, 95], ['内侧环 (33,95)', 33, 95],
];
const fl = new Int32Array(PROBES.length), rc = new Int32Array(PROBES.length);
const A_SEEDS = 2000;
const fieldTmp = new Int32Array(SIZE), qbuf = new Int32Array(SIZE);
const clsF = [0, 0, 0, 0], clsT = [0, 0, 0, 0];
for (let s = 1; s <= A_SEEDS; s++) {
  const rnd = mulberry32(s * 2654435761); const floor = genOdd(rnd);
  bfs(floor, idx(1, 1), fieldTmp, qbuf);
  for (let k = 0; k < PROBES.length; k++) { const p = idx(PROBES[k][1], PROBES[k][2]); if (floor[p]) fl[k]++; if (fieldTmp[p] >= 0) rc[k]++; }
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const c = y & 1 ? (x & 1 ? 0 : 1) : (x & 1 ? 2 : 3); clsT[c]++; if (floor[idx(x, y)]) clsF[c]++; }
}
const pc = (v) => (v / A_SEEDS * 100).toFixed(1) + '%';
console.log('  点                 奇偶类      地板率   连通率(自(1,1)可达)');
for (let k = 0; k < PROBES.length; k++) {
  const [nm, x, y] = PROBES[k]; const cl = (y & 1) ? (x & 1 ? '(奇,奇)' : '(偶,奇)') : (x & 1 ? '(奇,偶)' : '(偶,偶)');
  console.log(`  ${nm.padEnd(18)} ${cl}  ${pc(fl[k]).padStart(7)}  ${pc(rc[k]).padStart(7)}`);
}
console.log('  --- 内部 126×126 四类坐标统计 ---');
console.log(`  (奇,奇) 节点格   地板率 ${(clsF[0] / clsT[0] * 100).toFixed(1)}%   (样本 ${clsT[0]})`);
console.log(`  (偶,奇) 通道格   地板率 ${(clsF[1] / clsT[1] * 100).toFixed(1)}%`);
console.log(`  (奇,偶) 通道格   地板率 ${(clsF[2] / clsT[2] * 100).toFixed(1)}%`);
console.log(`  (偶,偶) 墙格     地板率 ${(clsF[3] / clsT[3] * 100).toFixed(1)}%`);

// ================= B. 1000 种子 spawn→exit 路径 =================
console.log('\n=== B. spawn→自己出口 BFS 路径（1000 图，carve 后）===');
const dist0 = new Int32Array(SIZE);
function measure(label, mkExit, seeds) {
  const ds = []; let bad = 0, eu = 0;
  for (let s = 1; s <= seeds; s++) {
    const rnd = mulberry32(s * 2654435761); const floor = genOdd(rnd);
    for (const [x, y] of SP) carve(floor, x, y, 1);
    const ex = mkExit(floor);
    bfs(floor, idx(SP[0][0], SP[0][1]), dist0, qbuf);
    const d = dist0[ex[0]];
    if (d < 0) { bad++; continue; }
    ds.push(d); eu += Math.hypot(cxm(ex[0]) - SP[0][0], cym(ex[0]) - SP[0][1]);
  }
  if (!ds.length) { console.log(`  ${label}: 全部不可达（${bad}/${seeds}）`); return null; }
  ds.sort((a, b) => a - b);
  const q = (p) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))];
  const mean = (ds.reduce((a, b) => a + b, 0) / ds.length);
  const inR = ds.filter(v => v >= 85 && v <= 100).length / ds.length * 100;
  console.log(`  ${label}: 欧氏 ${(eu / ds.length).toFixed(1)} | 平均 ${mean.toFixed(1)} | P10 ${q(0.10)} | P50 ${q(0.50)} | P90 ${q(0.90)} | P95 ${q(0.95)} | P99 ${q(0.99)} | 最大 ${ds[ds.length - 1]} | [85,100]占比 ${inR.toFixed(0)}% | 不可达 ${bad}`);
  return { mean, p50: q(0.5), p95: q(0.95), max: ds[ds.length - 1], bad };
}
measure('边中点就近(v1.5终稿) ', (f) => { const ex = EXIT.map(([x, y]) => idx(x, y)); DOOR.forEach(([x, y]) => carve(f, x, y, 1)); return ex; }, 1000);
measure('内侧环(33,33)(回退)  ', (f) => { const ex = RING.map(([x, y]) => idx(x, y)); ex.forEach(p => carve(f, cxm(p), cym(p), 1)); return ex; }, 1000);
measure('边中点「不 carve」对照', (f) => EXIT.map(([x, y]) => idx(x, y)), 1000);

// ================= C. v1.5 终稿完整对局 =================
const F = [new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE)];
const dist = new Int32Array(SIZE), dist2 = new Int32Array(SIZE);
function buildPool(perGemMax, rMax) {
  const pool = []; const a = F[0], b = F[1], c2 = F[2], d3 = F[3];
  for (let i = 0; i < SIZE; i++) {
    const d0 = a[i]; if (d0 < 0) continue; const d1 = b[i], d2 = c2[i], d4 = d3[i];
    if (d1 < 0 || d2 < 0 || d4 < 0) continue;
    let mx = d0, mn = d0; if (d1 > mx) mx = d1; if (d1 < mn) mn = d1; if (d2 > mx) mx = d2; if (d2 < mn) mn = d2; if (d4 > mx) mx = d4; if (d4 < mn) mn = d4;
    if ((mx - mn) / ((d0 + d1 + d2 + d4) * 0.25) > perGemMax) continue;
    if (rMax != null) { const dx = cxm(i) - 63.5, dy = cym(i) - 63.5; if (dx * dx + dy * dy > rMax * rMax) continue; }
    pool.push(i);
  }
  return pool;
}
function placeSet(pool, rng, count, tries) {
  const PL = pool.length; if (PL < count) return null;
  const minD2 = new Float64Array(PL); let best = null;
  for (let t = 0; t < tries; t++) {
    minD2.fill(Infinity);
    const chosen = [pool[(rng() * PL) | 0]];
    const x0 = cxm(chosen[0]), y0 = cym(chosen[0]);
    for (let k = 0; k < PL; k++) { const dx = cxm(pool[k]) - x0, dy = cym(pool[k]) - y0; minD2[k] = dx * dx + dy * dy; }
    while (chosen.length < count) {
      let bi = -1, bd = -1;
      for (let k = 0; k < PL; k++) if (minD2[k] > bd) { bd = minD2[k]; bi = k; }
      if (bi < 0) break;
      const p = pool[bi]; minD2[bi] = -1; chosen.push(p);
      const px = cxm(p), py = cym(p);
      for (let k = 0; k < PL; k++) { if (minD2[k] < 0) continue; const dx = cxm(pool[k]) - px, dy = cym(pool[k]) - py; const dd = dx * dx + dy * dy; if (dd < minD2[k]) minD2[k] = dd; }
    }
    if (chosen.length < count) continue;
    let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
    for (const g of chosen) { t0 += F[0][g]; t1 += F[1][g]; t2 += F[2][g]; t3 += F[3][g]; }
    let mx = t0, mn = t0; if (t1 > mx) mx = t1; if (t1 < mn) mn = t1; if (t2 > mx) mx = t2; if (t2 < mn) mn = t2; if (t3 > mx) mx = t3; if (t3 < mn) mn = t3;
    const ag = (mx - mn) / ((t0 + t1 + t2 + t3) * 0.25);
    if (!best || ag < best.ag) best = { gems: chosen, ag };
    if (ag <= 0.35) break;
  }
  return best;
}
const euclid = (a, b) => Math.hypot(cxm(a) - cxm(b), cym(a) - cym(b));

function runGame(seed, cfg) {
  const rnd = mulberry32(seed * 2654435761);
  const floor = genOdd(rnd);
  const EX = cfg.exits.map(([x, y]) => idx(x, y));
  const DIN = cfg.doors.map(([x, y]) => { carve(floor, x, y, 1); return idx(x, y); });
  for (const [x, y] of SP) carve(floor, x, y, 1);
  SP.forEach((sp, i) => bfs(floor, idx(sp[0], sp[1]), F[i], qbuf));
  for (let i = 0; i < 4; i++) if (F[i][EX[i]] < 0) return null;
  const exitPathLen = F[0][EX[0]];
  const count = 5 * cfg.gemsPerColor;
  const pool = buildPool(cfg.perGemMax, cfg.rMax);
  if (!pool || pool.length < count) return null;
  const sets = []; for (let s = 0; s < cfg.gemGenerations; s++) { const g = placeSet(pool, rnd, count, 20); if (!g) return null; sets.push(g.gems); }
  let setIdx = 0;
  let gems = sets[setIdx].map((p, i) => ({ pos: p, color: i % 5, alive: true }));
  const freeAll = []; for (let i = 0; i < SIZE; i++) if (floor[i] && F[0][i] >= 0) freeAll.push(i);
  let chest = null, chestRespawns = 0, lastChestTurn = -999;
  const placeChest = (actors) => { for (let k = 0; k < 200; k++) { const c = freeAll[(rnd() * freeAll.length) | 0]; let ok = true; for (const a of actors) if (a.state === 'run' && euclid(c, a.pos) < 30) { ok = false; break; } if (ok) return c; } return null; };
  const actors = SP.map((sp, i) => ({ id: i, pos: idx(sp[0], sp[1]), exit: EX[i], stamina: cfg.stamina, score: 0, gemsGot: 0, colors: [0, 0, 0, 0, 0], state: 'run', target: null, path: null, pathIdx: 0, streak: 0, blockedTurns: 0 }));
  chest = placeChest(actors);
  const retarget = (a) => {
    bfs(floor, a.pos, dist, qbuf);
    const dExit = dist[a.exit];
    const cands = [];
    if (chest != null && dist[chest] >= 0) cands.push({ pos: chest, u: 2.0 / (dist[chest] + 1) });
    for (const g of gems) { if (!g.alive || (globalThis.DEDUP && a.colors[g.color])) continue; const d = dist[g.pos]; if (d < 0) continue; cands.push({ pos: g.pos, u: 1.0 / (d + 1) }); }
    cands.sort((x, y) => (y.u - x.u) || (x.pos - y.pos));
    let target = a.exit;
    for (const c of cands) {
      const dTo = dist[c.pos];
      bfs(floor, c.pos, dist2, qbuf);
      const dBack = dist2[a.exit];
      if (dBack < 0) continue;
      if (!globalThis.BUDGET || a.stamina >= dTo + dBack * 1.3) { target = c.pos; break; }   // X11: ×1.3 纯比例
    }
    if (a.stamina <= dExit * 1.3) target = a.exit;
    a.target = target;
    const p = []; let c = target;
    if (dist[c] >= 0) { while (c !== a.pos) { p.push(c); let nx = -1; for (const [dx, dy] of D1) { const n2 = c + dy * N + dx; if (n2 < 0 || n2 >= SIZE || Math.abs(cxm(n2) - cxm(c)) > 1) continue; if (dist[n2] >= 0 && dist[n2] === dist[c] - 1) { nx = n2; break; } } if (nx < 0) { p.length = 0; break; } c = nx; } }
    a.path = p.reverse(); a.pathIdx = 0;
  };
  let turns = 0, chestOpens = 0, deadlockTriggers = 0, fourBlocked = 0, contestTurns = 0, stolen = 0;
  for (turns = 1; turns <= cfg.maxTurns; turns++) {
    const running = actors.filter(a => a.state === 'run');
    if (!running.length) break;
    // X25：本回合是否出现「>=2 人同时盯上同一颗存活宝石」
    { const tc = new Map(); for (const a of running) if (a.target != null) tc.set(a.target, (tc.get(a.target) || 0) + 1);
      for (const [t, c] of tc) if (c >= 2) { for (const g of gems) if (g.alive && g.pos === t) { contestTurns++; break; } } }
    for (const a of running) { if (!a.path || a.pathIdx >= a.path.length) retarget(a); a.want = (a.path && a.pathIdx < a.path.length) ? a.path[a.pathIdx] : null; }
    const occupied = new Map(); for (const a of actors) if (a.state === 'run') occupied.set(a.pos, a);
    const intents = new Map(); for (const a of running) if (a.want != null) { if (!intents.has(a.want)) intents.set(a.want, []); intents.get(a.want).push(a); }
    const blocked = new Set();
    for (const [tile, list] of intents) if (list.length > 1) for (const a of list) blocked.add(a);
    for (const a of running) { if (a.want == null) continue; const occ = occupied.get(a.want); if (occ && occ.want === a.pos) { blocked.add(a); blocked.add(occ); } }
    for (let it = 0; it < 4; it++) { let ch = false; for (const a of running) { if (a.want == null || blocked.has(a)) continue; const occ = occupied.get(a.want); if (!occ) continue; const leaves = occ.state === 'run' && occ.want != null && occ.want !== occ.pos && !blocked.has(occ); if (!leaves) { blocked.add(a); ch = true; } } if (!ch) break; }
    for (const a of running) {
      let moved = false, cost = 0, fourSide = false;
      if (a.want != null && !blocked.has(a)) { a.pos = a.want; a.pathIdx++; moved = true; cost = 1; }
      else {
        a.blockedTurns++;
        let open = 0;
        for (const [dx, dy] of D1) { const n = a.pos + dy * N + dx; if (floor[n]) open++; }
        if (open === 0 || D1.every(([dx, dy]) => { const n = a.pos + dy * N + dx; if (!floor[n]) return true; const o = occupied.get(n); return o && o !== a; })) { fourSide = true; cost = 1; fourBlocked++; }
        else cost = 0;
      }
      if (!moved) a.streak++; else a.streak = 0;
      if (a.streak >= 4) { if (cost === 0) { cost = 1; deadlockTriggers++; } }
      a.stamina -= cost;
      if (!moved) a.path = null;
    }
    for (const a of [...running].sort((x, y) => x.id - y.id)) {
      if (a.state !== 'run') continue;
      if (chest != null && a.pos === chest) {
        chestOpens++;
        if (rnd() < 0.5) a.score += 1 + ((rnd() * 5) | 0);
        else a.stamina += 25 + ((rnd() * 26) | 0);
        chest = null; lastChestTurn = turns; a.path = null;
      }
      for (const g of gems) if (g.alive && g.pos === a.pos && !(globalThis.DEDUP && a.colors[g.color])) { for (const o of running) if (o !== a && o.target === g.pos) stolen++; g.alive = false; a.colors[g.color] = 1; a.score += 1; a.gemsGot++; a.path = null; }
    }
    if (gems.every(g => !g.alive) && setIdx + 1 < sets.length) { setIdx++; gems = sets[setIdx].map((p, i) => ({ pos: p, color: i % 5, alive: true })); for (const a of running) a.path = null; }
    if (chest == null && chestRespawns < cfg.chestMaxRespawn && turns - lastChestTurn >= 60) { const c = placeChest(actors); if (c != null) { chest = c; chestRespawns++; lastChestTurn = turns; } }
    for (const a of running) if (a.pos === a.exit) a.state = 'done';
    for (const a of running) if (a.stamina <= 0) a.state = 'dead';
  }
  return { actors, turns, chestOpens, deadlockTriggers, fourBlocked, exitPathLen, contestTurns, stolen };
}
function evaluate(cfg, games) {
  let n = 0, win = 0, scoreSum = 0, gemSum = 0, stamSum = 0, turnSum = 0, chestSum = 0, zero = 0, dlSum = 0, fbSum = 0, played = 0, over480 = 0, exLen = 0, contestSum = 0, stolenSum = 0;
  const gl = [], tl = [], st = [], failGames = [], failActors = [];
  const gDone = [], gTot = [];   // 逐局 (到达数, actor 数) —— 供聚类自助用
  for (let s = 1; s <= games; s++) {
    const r = runGame(s, cfg); if (!r) continue; played++;
    turnSum += r.turns; chestSum += r.chestOpens; dlSum += r.deadlockTriggers; fbSum += r.fourBlocked;
    tl.push(r.turns); exLen += r.exitPathLen; if (r.turns > 480) over480++; contestSum += r.contestTurns; stolenSum += r.stolen;
    let gf = 0, gd = 0, gt = 0;
    for (const a of r.actors) { n++; gt++; scoreSum += a.score; gemSum += a.gemsGot; gl.push(a.gemsGot); if (!a.gemsGot) zero++; if (a.state !== 'done') gf++; if (a.state === 'done') { win++; gd++; stamSum += a.stamina; st.push(a.stamina); } }
    gDone.push(gd); gTot.push(gt);
    failActors.push(gf); if (gf > 0) failGames.push(1); else failGames.push(0);
  }
  gl.sort((a, b) => a - b); tl.sort((a, b) => a - b);
  const pq = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return {
    played, win: win / n * 100, score: scoreSum / n, gems: gemSum / n,
    p10: pq(gl, 0.1), p90: pq(gl, 0.9), zero: zero / n * 100, stam: stamSum / Math.max(1, win),
    turns: turnSum / played, tP50: pq(tl, 0.5), tP90: pq(tl, 0.9), tMax: tl[tl.length - 1],
    over480: over480 / played * 100, chest: chestSum / played, dl: dlSum / played, fb: fbSum / played, exLen: exLen / played,
    nGames: played, nActorGames: n, failByGame: failGames.reduce((a,b)=>a+b,0) / played * 100,
    stP10: (st.sort((a,b)=>a-b), pq(st,0.1)), stP50: pq(st,0.5), stP90: pq(st,0.9),
    stMean: st.reduce((a,b)=>a+b,0) / Math.max(1,st.length),
    grazeLo: st.filter(v=>v<40).length / Math.max(1,st.length) * 100,     // 剩余 < 体力上限 10%
    grazeHi: st.filter(v=>v>120).length / Math.max(1,st.length) * 100,    // 剩余 > 体力上限 30%
    grazeOld: st.filter(v=>v>=0&&v<=10).length / Math.max(1,st.length) * 100,
    ci: clusterBootstrap(gDone, gTot, failGames),
    contestPct: contestSum / Math.max(1, turnSum) * 100, stolenPerAgent: stolenSum / Math.max(1, n)
  };
}
// 聚类自助：以「局」为聚类单元重抽样，保留局内 4 个 actor 的相关性（qa-lead B02b/F05b）
function clusterBootstrap(gDone, gTot, failGames, B = 2000) {
  const m = gDone.length; if (!m) return null;
  const rnd = mulberry32(0xC0FFEE);
  const winB = [], failB = [];
  for (let b = 0; b < B; b++) {
    let d = 0, t = 0, f = 0;
    for (let i = 0; i < m; i++) { const k = (rnd() * m) | 0; d += gDone[k]; t += gTot[k]; f += failGames[k]; }
    winB.push(d / t * 100); failB.push(f / m * 100);
  }
  const q = (arr, p) => { arr.sort((a,b)=>a-b); return arr[Math.min(arr.length-1, Math.floor(arr.length*p))]; };
  return { winLo: q(winB, 0.025), winHi: q(winB, 0.975), failLo: q(failB, 0.025), failHi: q(failB, 0.975), B };
}

console.log('\n=== C. v1.5 终稿四角色对局（边中点就近 · 每色2颗=10颗 · 体力400 · maxTurns600）===');
const EDGE = { exits: EXIT, doors: DOOR };
const RINGC = { exits: RING, doors: RING };
const rows = [];
for (const [en, base] of [['边中点', EDGE], ['内侧环', RINGC]]) {
  for (const [gn, gpc] of [['5颗 ', 1], ['10颗', 2]]) {
    const cfg = { ...base, stamina: 400, gemsPerColor: gpc, perGemMax: 0.90, rMax: 55, chestMaxRespawn: 2, gemGenerations: 3, maxTurns: 600 };
    const G0 = Number(process.env.GAMES || 200);
    selfReport(cfg, G0, `C/${en}/${gn.trim()}`);
    const r = evaluate(cfg, G0);
    rows.push([en, gn, r]);
    console.log(`  ${en} | ${gn} | 到达率 ${r.win.toFixed(1).padStart(5)}% | 人均宝石 ${r.gems.toFixed(2)} | P10/P90 ${r.p10}/${r.p90} | 零收获 ${r.zero.toFixed(1).padStart(4)}% | 回合 均${r.turns.toFixed(0)} P50 ${r.tP50} P90 ${r.tP90} 最大${r.tMax} | >480回合 ${r.over480.toFixed(0)}% | 剩余体力 ${r.stam.toFixed(0)} | 开箱 ${r.chest.toFixed(2)} | 僵持兜底 ${r.dl.toFixed(1)} | 四面全阻 ${r.fb.toFixed(1)} | spawn→出口 ${r.exLen.toFixed(1)}`);
  }
}
console.log('\n  门禁（创意总监 v1.5）：到达率≥85% / 人均宝石≥1.5 / 零收获≤15% / 平均回合≤450');
for (const [en, gn, r] of rows) {
  const v = [r.win >= 85, r.gems >= 1.5, r.zero <= 15, r.turns <= 450];
  console.log(`  ${en} ${gn}: ${v.map((b, i) => ['到达率', '人均宝石', '零收获', '平均回合'][i] + (b ? '✅' : '❌')).join(' ')}  → ${v.every(Boolean) ? '过' : '不过'}`);
}
const G = Number(process.env.GAMES || 200);
for (const bv of ['1','0']) {
  globalThis.BUDGET = (bv === "1");
  const rr = runCfg(EDGE, 2, 400, bv);
  console.log(`  预算检查${bv==='1'?'开':'关'} | N局 ${rr.nGames} | N(actor-局) ${rr.nActorGames} | 到达率 ${rr.win.toFixed(1)}% [CI ${rr.ci.winLo.toFixed(1)}~${rr.ci.winHi.toFixed(1)}] | 失败率(按局) ${rr.failByGame.toFixed(1)}% [CI ${rr.ci.failLo.toFixed(1)}~${rr.ci.failHi.toFixed(1)}] | 失败率(按actor) ${(100-rr.win).toFixed(1)}% | 剩余体力 P10 ${rr.stP10} / P50 ${rr.stP50} / P90 ${rr.stP90} / 均值 ${rr.stMean.toFixed(1)} | 擦线 <10%(${rr.grazeLo.toFixed(1)}%) >30%(${rr.grazeHi.toFixed(1)}%) | 人均宝石 ${rr.gems.toFixed(2)} | 回合 ${rr.turns.toFixed(0)} | 争抢回合 ${rr.contestPct.toFixed(2)}% | 被抢先 ${rr.stolenPerAgent.toFixed(2)} 次/agent-局`);
}
console.log('\n=== D. X25 争抢频率（STRAT-A 同质四理性贪心 · 体力400 · 边中点就近）===');
for (const [gn, gpc] of [['5颗 ', 1], ['10颗', 2]]) {
  globalThis.BUDGET = true;
  const cfg = { ...EDGE, stamina: 400, gemsPerColor: gpc, perGemMax: 0.90, rMax: 55, chestMaxRespawn: 2, gemGenerations: 3, maxTurns: 600 };
  selfReport(cfg, G, 'D/X25/' + gn.trim());
  const r = evaluate(cfg, G);
  console.log(`  ${gn} | 争抢回合占比 ${r.contestPct.toFixed(2)}% | 争抢回合/局 ${(r.contestPct / 100 * r.turns).toFixed(1)} | 被抢先 ${r.stolenPerAgent.toFixed(3)} 次/agent-局 | 人均宝石 ${r.gems.toFixed(2)} | 到达率 ${r.win.toFixed(1)}% | 回合 ${r.turns.toFixed(0)}`);
}

function runCfg(base, gpc, stam, bv) {
  const cfg = { ...base, stamina: stam, gemsPerColor: gpc, perGemMax: 0.90, rMax: 55, chestMaxRespawn: 2, gemGenerations: 3, maxTurns: 600 };
  return evaluate(cfg, G);
}
