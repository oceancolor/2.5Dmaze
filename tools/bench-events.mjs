// 事件触发次数实测：取消「每 agent 每局 6 次」上限，只保留冷却，统计实际触发次数
// 事件清单（设计案 v1.7 §4.7 终稿 6 条 + 可选第 7 条）
const N = 128, SIZE = N * N;
const idx = (x, y) => y * N + x;
const cxm = (c) => c % N, cym = (c) => (c / N) | 0;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const D2 = [[0, -2], [0, 2], [-2, 0], [2, 0]], D1 = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const CHEB = (a, b) => Math.max(Math.abs(cxm(a) - cxm(b)), Math.abs(cym(a) - cym(b)));

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
  for (let i = 0; i < SIZE; i++) if (!floor[i] && rnd() > 0.72) floor[i] = 1;
  for (let x = 0; x < N; x++) { floor[idx(x, 0)] = 0; floor[idx(x, N - 1)] = 0; }
  for (let y = 0; y < N; y++) { floor[idx(0, y)] = 0; floor[idx(N - 1, y)] = 0; }
  return floor;
}
function carve(floor, cx, cy, r) { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x <= N - 1 && y <= N - 1) floor[idx(x, y)] = 1; }
function bfs(floor, src, out, q) { out.fill(-1); let h = 0, t = 0; q[t++] = src; out[src] = 0; while (h < t) { const c = q[h++], x = c % N, y = (c / N) | 0, d = out[c]; if (x + 1 < N && floor[c + 1] && out[c + 1] < 0) { out[c + 1] = d + 1; q[t++] = c + 1; } if (x - 1 >= 0 && floor[c - 1] && out[c - 1] < 0) { out[c - 1] = d + 1; q[t++] = c - 1; } if (y + 1 < N && floor[c + N] && out[c + N] < 0) { out[c + N] = d + 1; q[t++] = c + N; } if (y - 1 >= 0 && floor[c - N] && out[c - N] < 0) { out[c - N] = d + 1; q[t++] = c - N; } } }

const SP = [[2, 2], [125, 2], [125, 125], [2, 125]];
const EXIT = [[63, 0], [127, 63], [63, 127], [0, 63]];
const DOOR = [[63, 1], [126, 63], [63, 126], [1, 63]];
const F = [new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE)];
const EXF = [new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE)];
const dist = new Int32Array(SIZE), dist2 = new Int32Array(SIZE), qbuf = new Int32Array(SIZE);
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
  const EX = EXIT.map(([x, y]) => idx(x, y));
  for (const [x, y] of SP) carve(floor, x, y, 1);
  DOOR.forEach(([x, y]) => carve(floor, x, y, 1));
  SP.forEach((sp, i) => bfs(floor, idx(sp[0], sp[1]), F[i], qbuf));
  EX.forEach((e, i) => bfs(floor, e, EXF[i], qbuf));   // 出口距离场：供事件④⑦取 d(→exit)
  for (let i = 0; i < 4; i++) if (F[i][EX[i]] < 0) return null;

  const count = 5 * cfg.gemsPerColor;
  const pool = buildPool(0.90, 55);
  if (!pool || pool.length < count) return null;
  const sets = []; for (let s = 0; s < 3; s++) { const g = placeSet(pool, rnd, count, 20); if (!g) return null; sets.push(g.gems); }
  let setIdx = 0;
  let gems = sets[setIdx].map((p, i) => ({ pos: p, color: i % 5, alive: true }));
  const freeAll = []; for (let i = 0; i < SIZE; i++) if (floor[i] && F[0][i] >= 0) freeAll.push(i);
  let chest = null, chestRespawns = 0, lastChestTurn = -999;
  const placeChest = (actors) => { for (let k = 0; k < 200; k++) { const c = freeAll[(rnd() * freeAll.length) | 0]; let ok = true; for (const a of actors) if (a.state === 'run' && euclid(c, a.pos) < 30) { ok = false; break; } if (ok) return c; } return null; };
  const actors = SP.map((sp, i) => ({
    id: i, pos: idx(sp[0], sp[1]), exit: EX[i], stamina: 400, score: 0, gemsGot: 0,
    colors: [0, 0, 0, 0, 0], state: 'run', target: null, path: null, pathIdx: 0, streak: 0,
    lastEventTurn: -999, ev: [0, 0, 0, 0, 0, 0, 0], evTotal: 0, still: 0,
    pWarn: false, pSprint: false, pSeeGem: false, pSeeFoe: false, pStuck: false
  }));
  chest = placeChest(actors);
  const retarget = (a) => {
    bfs(floor, a.pos, dist, qbuf);
    const dExit = dist[a.exit];
    const cands = [];
    if (chest != null && dist[chest] >= 0) cands.push({ pos: chest, u: 2.0 / (dist[chest] + 1) });
    for (const g of gems) { if (!g.alive || a.colors[g.color]) continue; const d = dist[g.pos]; if (d < 0) continue; cands.push({ pos: g.pos, u: 1.0 / (d + 1) }); }
    cands.sort((x, y) => (y.u - x.u) || (x.pos - y.pos));
    let target = a.exit;
    for (const c of cands) {
      const dTo = dist[c.pos];
      bfs(floor, c.pos, dist2, qbuf);
      const dBack = dist2[a.exit];
      if (dBack < 0) continue;
      if (a.stamina >= dTo + dBack * 1.3) { target = c.pos; break; }
    }
    if (a.stamina <= dExit * 1.3) target = a.exit;
    a.target = target;
    const p = []; let c = target;
    if (dist[c] >= 0) { while (c !== a.pos) { p.push(c); let nx = -1; for (const [dx, dy] of D1) { const n2 = c + dy * N + dx; if (n2 < 0 || n2 >= SIZE || Math.abs(cxm(n2) - cxm(c)) > 1) continue; if (dist[n2] >= 0 && dist[n2] === dist[c] - 1) { nx = n2; break; } } if (nx < 0) { p.length = 0; break; } c = nx; } }
    a.path = p.reverse(); a.pathIdx = 0;
  };
  let turns = 0;
  const cd = cfg.cooldown, use7 = cfg.useEvent7;
  const R = 9;
  for (turns = 1; turns <= 600; turns++) {
    const running = actors.filter(a => a.state === 'run');
    if (!running.length) break;
    for (const a of running) { if (!a.path || a.pathIdx >= a.path.length) retarget(a); a.want = (a.path && a.pathIdx < a.path.length) ? a.path[a.pathIdx] : null; }
    const occupied = new Map(); for (const a of actors) if (a.state === 'run') occupied.set(a.pos, a);
    const intents = new Map(); for (const a of running) if (a.want != null) { if (!intents.has(a.want)) intents.set(a.want, []); intents.get(a.want).push(a); }
    const blocked = new Set();
    for (const [tile, list] of intents) if (list.length > 1) for (const a of list) blocked.add(a);
    for (const a of running) { if (a.want == null) continue; const occ = occupied.get(a.want); if (occ && occ.want === a.pos) { blocked.add(a); blocked.add(occ); } }
    for (let it = 0; it < 4; it++) { let ch = false; for (const a of running) { if (a.want == null || blocked.has(a)) continue; const occ = occupied.get(a.want); if (!occ) continue; const leaves = occ.state === 'run' && occ.want != null && occ.want !== occ.pos && !blocked.has(occ); if (!leaves) { blocked.add(a); ch = true; } } if (!ch) break; }
    for (const a of running) {
      let moved = false, cost = 0;
      if (a.want != null && !blocked.has(a)) { a.pos = a.want; a.pathIdx++; moved = true; cost = 1; }
      else {
        let open = 0;
        for (const [dx, dy] of D1) { const n = a.pos + dy * N + dx; if (floor[n]) open++; }
        if (open === 0 || D1.every(([dx, dy]) => { const n = a.pos + dy * N + dx; if (!floor[n]) return true; const o = occupied.get(n); return o && o !== a; })) cost = 1;
        else cost = 0;
      }
      if (!moved) a.streak++; else a.streak = 0;
      if (!moved) a.still++; else a.still = 0;
      if (a.streak >= 4) { if (cost === 0) cost = 1; }
      a.stamina -= cost;
      if (!moved) a.path = null;
    }
    // ---- 结算：拾取 / 开箱（在事件判定之前，保证"目标失效"看到的是本回合后的状态）----
    let refreshed = false;
    for (const a of [...running].sort((x, y) => x.id - y.id)) {
      if (a.state !== 'run') continue;
      if (chest != null && a.pos === chest) {
        if (rnd() < 0.5) a.score += 1 + ((rnd() * 5) | 0); else a.stamina += 25 + ((rnd() * 26) | 0);
        chest = null; lastChestTurn = turns; a.path = null;
      }
      for (const g of gems) if (g.alive && g.pos === a.pos && !a.colors[g.color]) { g.alive = false; a.colors[g.color] = 1; a.score += 1; a.gemsGot++; a.path = null; }
    }
    if (gems.every(g => !g.alive) && setIdx + 1 < sets.length) { setIdx++; gems = sets[setIdx].map((p, i) => ({ pos: p, color: i % 5, alive: true })); for (const a of running) a.path = null; refreshed = true; }
    if (chest == null && chestRespawns < 2 && turns - lastChestTurn >= 60) { const c = placeChest(actors); if (c != null) { chest = c; chestRespawns++; lastChestTurn = turns; refreshed = true; } }

    // ---- 事件判定（无次数上限，只受冷却约束）----
    for (const a of running) {
      const mask = [0, 0, 0, 0, 0, 0, 0];
      // ① 目标失效：目标点上的宝石/宝箱已消失（天然边沿）
      if (a.target != null) {
        const g = gems.find(x => x.pos === a.target);
        if (g && !g.alive) mask[0] = 1;
        if (a.target === chest) mask[0] = 0;
      }
      // ② 宝物刷新（全局广播，天然边沿）
      if (refreshed) mask[1] = 1;
      const dExitNow = EXF[a.id][a.pos];
      const nowWarn = dExitNow >= 0 && a.stamina <= dExitNow * 1.3;
      let seeGem = false, seeFoe = false;
      for (const g of gems) if (g.alive && !a.colors[g.color] && CHEB(a.pos, g.pos) <= R) { seeGem = true; break; }
      for (const o of actors) if (o !== a && o.state === 'run' && CHEB(a.pos, o.pos) <= R) { seeFoe = true; break; }
      let cc = 0; for (const c of a.colors) cc += c;
      const nowSprint = cc >= 3 && dExitNow >= 0 && dExitNow <= 25;
      const stuck = a.still >= 2;

      if (cfg.edge) {
        // —— 边沿型：只在「从不满足 → 满足」的跃迁那一刻触发 ——
        if (stuck && !a.pStuck) mask[2] = 1;              // ③ 卡住的那一刻（一段僵持只算一次）
        if (nowWarn && !a.pWarn) mask[3] = 1;             // ④ 首次跨过体力阈值
        if (seeGem && !a.pSeeGem) mask[4] = 1;            // ⑤ 缺色宝石进入视野
        if (seeFoe && !a.pSeeFoe) mask[5] = 1;            // ⑥ 对手进入视野
        if (use7 && nowSprint && !a.pSprint) mask[6] = 1; // ⑦ 进入冲刺窗口
      } else {
        // —— 状态型（当前定义）：条件满足即候选，冷却一过就再触发 ——
        if (stuck) mask[2] = 1;
        if (nowWarn) mask[3] = 1;
        if (seeGem) mask[4] = 1;
        if (seeFoe) mask[5] = 1;
        if (use7 && nowSprint) mask[6] = 1;
      }
      a.pStuck = stuck; a.pWarn = nowWarn; a.pSeeGem = seeGem; a.pSeeFoe = seeFoe; a.pSprint = nowSprint;

      if (mask.some(v => v) && turns - a.lastEventTurn >= cd) {
        for (let k = 0; k < 7; k++) a.ev[k] += mask[k];
        a.evTotal++; a.lastEventTurn = turns;
      }
    }
    for (const a of running) if (a.pos === a.exit) a.state = 'done';
    for (const a of running) if (a.stamina <= 0) a.state = 'dead';
  }
  return { actors, turns };
}
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
function stat(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return { mean: (s.reduce((a, b) => a + b, 0) / s.length), p50: pct(s, 0.5), p90: pct(s, 0.9), p95: pct(s, 0.95), max: s[s.length - 1] };
}
const GAMES = Number(process.env.GAMES || 100);
const EVNAME = ['①目标失效', '②宝物刷新', '③路径受阻', '④体力告警', '⑤高价值出现', '⑥对手进视野', '⑦冲刺窗口'];
for (const [mode, edge] of [['状态型（现行定义）', false], ['边沿型（建议改法）', true]]) {
 for (const cd of [3, 5]) {
  for (const use7 of [false, true]) {
    if (edge && use7) continue;
    const per = [], global = [], byEv = [0, 0, 0, 0, 0, 0, 0];
    let turnsSum = 0, played = 0;
    for (let s = 1; s <= GAMES; s++) {
      const r = runGame(s, { cooldown: cd, useEvent7: use7, edge });
      if (!r) continue; played++; turnsSum += r.turns;
      let g = 0;
      for (const a of r.actors) { per.push(a.evTotal); g += a.evTotal; for (let k = 0; k < 7; k++) byEv[k] += a.ev[k]; }
      global.push(g);
    }
    const ps = stat(per), gs = stat(global);
    console.log(`\n### ${mode} · 冷却 ≥${cd} · ${use7 ? '含⑦' : '不含⑦'} · ${played} 局 · 平均回合 ${(turnsSum / played).toFixed(0)}`);
    console.log(`  每 agent 每局事件次数 : 均值 ${ps.mean.toFixed(1)} | P50 ${ps.p50} | P90 ${ps.p90} | P95 ${ps.p95} | max ${ps.max}`);
    console.log(`  每局全局事件次数(×4)  : 均值 ${gs.mean.toFixed(1)} | P50 ${gs.p50} | P90 ${gs.p90} | P95 ${gs.p95} | max ${gs.max}`);
    console.log(`  分项（每 agent 每局均值）: ` + EVNAME.map((n, k) => `${n} ${(byEv[k] / (played * 4)).toFixed(2)}`).join(' | '));
  }
 }
}
