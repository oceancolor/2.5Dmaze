// maze-quest 仿真内核（技术架构总监 · 增量复核用）
// 零依赖。所有随机源为可复现的 mulberry32。
export const N = 128;
export const WALL = 0, FLOOR = 1;
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];   // E W S N
export const DIRS5 = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]];
export const STAY = 4;

export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function subSeed(seed, k) {
  let h = (seed ^ (k * 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const at = (x, y) => y * N + x;
export { at };

// ---------------------------------------------------------------- 迷宫生成
// growing-tree(newest .55 / random .35 / oldest .10) + braid + 房间 + 削墙
export function generateMaze(rng, opt = {}) {
  const P = Object.assign({
    newest: 0.55, random: 0.35, oldest: 0.10,
    braidRatio: 0.35, roomCount: 4, thinKeep: 0.72,
    spawns: [[2, 2], [125, 2], [2, 125], [125, 125]],
    exits: [[63, 0], [127, 63], [0, 63], [63, 127]],   // 与 spawns 同序 TL,TR,BL,BR
    plazaRadius: 1,
  }, opt);

  if (!_inSim && (_pendingLabel || (_watch && cfgKey(P) !== _lastKey))) printMazeCfg(P, _label);   // X30 自报（t1* 系列直调 generateMaze，无宝石口径）

  const g = new Uint8Array(N * N);      // 0 = 墙, 1 = 地板
  const C = 64;                          // 单元在奇坐标 (2i+1, 2j+1)
  const visited = new Uint8Array(C * C);
  const list = new Int32Array(C * C);
  let ln = 0;

  visited[0] = 1; g[at(1, 1)] = FLOOR; list[ln++] = 0;
  while (ln > 0) {
    const r = rng();
    let p;
    if (r < P.newest) p = ln - 1;
    else if (r < P.newest + P.random) p = (rng() * ln) | 0;
    else p = 0;
    const id = list[p];
    const i = id % C, j = (id / C) | 0;
    let bx = -1, by = 0, cnt = 0;
    for (let d = 0; d < 4; d++) {
      const ni = i + DIRS[d][0], nj = j + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= C || nj >= C) continue;
      if (visited[nj * C + ni]) continue;
      cnt++;
      if (rng() * cnt < 1) { bx = ni; by = nj; }
    }
    if (cnt === 0) { list[p] = list[ln - 1]; ln--; continue; }
    g[at(2 * i + 1 + (bx - i), 2 * j + 1 + (by - j))] = FLOOR;   // 中间墙
    visited[by * C + bx] = 1; g[at(2 * bx + 1, 2 * by + 1)] = FLOOR;
    list[ln++] = by * C + bx;
  }

  // 编织：去掉 35% 死胡同
  const dead = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const x = 2 * i + 1, y = 2 * j + 1;
    let n = 0;
    for (let d = 0; d < 4; d++) if (g[at(x + DIRS[d][0], y + DIRS[d][1])] === FLOOR) n++;
    if (n === 1) dead.push(x, y);
  }
  for (let k = 0; k < dead.length; k += 2) {
    const x = dead[k], y = dead[k + 1];
    if (rng() >= P.braidRatio) continue;
    let pickD = -1, cnt = 0;
    for (let d = 0; d < 4; d++) {
      const dx = DIRS[d][0], dy = DIRS[d][1];
      const wx = x + dx, wy = y + dy, cx = x + 2 * dx, cy = y + 2 * dy;
      if (cx < 1 || cy < 1 || cx > N - 2 || cy > N - 2) continue;
      if (g[at(wx, wy)] !== WALL) continue;
      if (g[at(cx, cy)] !== FLOOR) continue;
      cnt++;
      if (rng() * cnt < 1) pickD = d;
    }
    if (pickD >= 0) g[at(x + DIRS[pickD][0], y + DIRS[pickD][1])] = FLOOR;
  }

  // 房间
  for (let k = 0; k < P.roomCount; k++) {
    const w = 6 + ((rng() * 9) | 0);
    const h = 6 + ((rng() * 9) | 0);
    const x0 = 2 + ((rng() * (N - 4 - w)) | 0);
    const y0 = 2 + ((rng() * (N - 4 - h)) | 0);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[at(x, y)] = FLOOR;
  }

  // 削墙：内部墙按 (1-keep) 概率变地板；外圈边界保持为墙（出口是"门"）
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const idx = at(x, y);
    if (g[idx] === WALL && rng() >= P.thinKeep) g[idx] = FLOOR;
  }

  // 强制开挖：出生点 3×3；出口格 + 内侧 1 格
  for (const [sx, sy] of P.spawns) {
    for (let y = sy - P.plazaRadius; y <= sy + P.plazaRadius; y++)
      for (let x = sx - P.plazaRadius; x <= sx + P.plazaRadius; x++)
        if (x >= 0 && y >= 0 && x < N && y < N) g[at(x, y)] = FLOOR;
  }
  for (const [ex, ey] of P.exits) {
    g[at(ex, ey)] = FLOOR;
    const ix = ex === 0 ? 1 : (ex === N - 1 ? N - 2 : ex);
    const iy = ey === 0 ? 1 : (ey === N - 1 ? N - 2 : ey);
    g[at(ix, iy)] = FLOOR;
  }

  let walls = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === WALL) walls++;
  return { grid: g, density: walls / (N * N) };
}

// ---------------------------------------------------------------- BFS 距离场
const Q = new Int32Array(N * N);
export function bfsField(grid, sources) {
  const dist = new Int32Array(N * N).fill(-1);
  let head = 0, tail = 0;
  for (const s of sources) { if (dist[s] < 0) { dist[s] = 0; Q[tail++] = s; } }
  while (head < tail) {
    const c = Q[head++];
    const d = dist[c] + 1;
    const x = c % N, y = (c / N) | 0;
    if (x > 0) { const n = c - 1; if (grid[n] === FLOOR && dist[n] < 0) { dist[n] = d; Q[tail++] = n; } }
    if (x < N - 1) { const n = c + 1; if (grid[n] === FLOOR && dist[n] < 0) { dist[n] = d; Q[tail++] = n; } }
    if (y > 0) { const n = c - N; if (grid[n] === FLOOR && dist[n] < 0) { dist[n] = d; Q[tail++] = n; } }
    if (y < N - 1) { const n = c + N; if (grid[n] === FLOOR && dist[n] < 0) { dist[n] = d; Q[tail++] = n; } }
  }
  return dist;
}

// 沿距离场走一步（返回 DIRS5 下标）
export function stepFrom(pos, field) {
  const d = field[pos];
  if (d <= 0) return STAY;
  const x = pos % N, y = (pos / N) | 0;
  for (let k = 0; k < 4; k++) {
    const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    const n = ny * N + nx;
    if (field[n] === d - 1) return k;
  }
  return STAY;
}

// ---------------------------------------------------------------- 宝物撒点
export function buildFloorPool(grid, spawns, exits) {
  const pool = [];
  const banned = new Uint8Array(N * N);
  for (const [sx, sy] of spawns)
    for (let y = sy - 3; y <= sy + 3; y++) for (let x = sx - 3; x <= sx + 3; x++)
      if (x >= 0 && y >= 0 && x < N && y < N) banned[at(x, y)] = 1;
  for (const [ex, ey] of exits)
    for (let y = ey - 2; y <= ey + 2; y++) for (let x = ex - 2; x <= ex + 2; x++)
      if (x >= 0 && y >= 0 && x < N && y < N) banned[at(x, y)] = 1;
  for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR && !banned[i]) pool.push(i);
  return pool;
}

// 逐点公平度：(max-min)/mean over 4 spawns
function spreadOf(sf, cell) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let s = 0; s < sf.length; s++) {
    const d = sf[s][cell];
    if (d < 0) return Infinity;
    if (d < mn) mn = d; if (d > mx) mx = d; sum += d;
  }
  const mean = sum / sf.length;
  return mean === 0 ? 0 : (mx - mn) / mean;
}

// 整体公平度：每个出生点到"五颗宝石"的总距离，再算 4 个出生点之间的离散度
function aggregateSpread(sf, gemCells) {
  const tot = [];
  for (let s = 0; s < sf.length; s++) {
    let t = 0;
    for (const c of gemCells) { const d = sf[s][c]; if (d < 0) return Infinity; t += d; }
    tot.push(t);
  }
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (const t of tot) { if (t < mn) mn = t; if (t > mx) mx = t; sum += t; }
  const mean = sum / tot.length;
  return mean === 0 ? 0 : (mx - mn) / mean;
}

function minPairwise(cells) {
  let mn = Infinity;
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const xi = cells[i] % N, yi = (cells[i] / N) | 0;
    const xj = cells[j] % N, yj = (cells[j] / N) | 0;
    const d = Math.abs(xi - xj) + Math.abs(yi - yj);
    if (d < mn) mn = d;
  }
  return mn;
}

/**
 * mode:
 *  'old'     逐颗 best-of-K 最小离散度（会把宝物推向中心 —— 外圈死景元凶）
 *  'new'     best-of-K 整组采样：过滤 aggregateSpread<=0.35，取空间分散度最大者
 *  'reject'  一次通过式：逐个采样 + 拒绝采样（距已放置 >= minSep），最多 30 次/个
 */
export function placeTreasures(rng, pool, spawnFields, opt = {}) {
  const K = opt.K ?? 64;
  const nGem = opt.nGem ?? 5;
  const nChest = opt.nChest ?? 1;
  const maxSpread = opt.maxSpread ?? 0.35;
  const minSep = opt.minSep ?? 30;
  const mode = opt.mode ?? 'new';
  const total = nGem + nChest;

  const pick = () => pool[(rng() * pool.length) | 0];

  if (mode === 'old') {
    const cells = [];
    for (let t = 0; t < total; t++) {
      let best = -1, bs = Infinity;
      for (let k = 0; k < K; k++) {
        const c = pick();
        const s = spreadOf(spawnFields, c);
        if (s < bs) { bs = s; best = c; }
      }
      cells.push(best);
    }
    return { cells, gems: cells.slice(0, nGem), chest: cells[nGem], spread: aggregateSpread(spawnFields, cells.slice(0, nGem)), disp: minPairwise(cells) };
  }

  if (mode === 'reject') {
    for (let restart = 0; restart < 4; restart++) {
      const cells = [];
      let ok = true;
      for (let t = 0; t < total; t++) {
        let chosen = -1;
        for (let tries = 0; tries < 30; tries++) {
          const c = pick();
          let far = true;
          for (const e of cells) {
            const xi = c % N, yi = (c / N) | 0, xj = e % N, yj = (e / N) | 0;
            if (Math.abs(xi - xj) + Math.abs(yi - yj) < minSep) { far = false; break; }
          }
          if (far) { chosen = c; break; }
        }
        if (chosen < 0) { ok = false; break; }
        cells.push(chosen);
      }
      if (!ok) continue;
      const sp = aggregateSpread(spawnFields, cells.slice(0, nGem));
      if (sp <= maxSpread) return { cells, gems: cells.slice(0, nGem), chest: cells[nGem], spread: sp, disp: minPairwise(cells) };
    }
    // 兜底：退化到 new
    return placeTreasures(rng, pool, spawnFields, Object.assign({}, opt, { mode: 'new' }));
  }

  // 'new'：整组采样
  let bestSet = null, bestKey = -Infinity, bestSpread = Infinity;
  for (let k = 0; k < K; k++) {
    const cells = [];
    for (let t = 0; t < total; t++) cells.push(pick());
    const sp = aggregateSpread(spawnFields, cells.slice(0, nGem));
    const dp = minPairwise(cells);
    if (sp <= maxSpread) {
      if (dp > bestKey) { bestKey = dp; bestSet = cells; bestSpread = sp; }
    } else if (bestSet === null && sp < bestSpread) {
      bestSpread = sp; bestSet = cells;   // 记录一个"最接近达标"的候选
    }
  }
  return { cells: bestSet, gems: bestSet.slice(0, nGem), chest: bestSet[nGem], spread: bestSet ? aggregateSpread(spawnFields, bestSet.slice(0, nGem)) : Infinity, disp: minPairwise(bestSet) };
}

// ---------------------------------------------------------------- 对局仿真
/**
 * opt: { nAgents, stamina, maxTurns, exitLayout, treasureMode, placementMode }
 */
export const SIM_DEFAULTS = {
  nAgents: 4, stamina: 400, maxTurns: 600,
  spawns: [[2, 2], [125, 2], [2, 125], [125, 125]],
  exits: [[63, 0], [127, 63], [0, 63], [63, 127]],
  gemRespawnMax: 2, gemRespawnMinDist: 15,
  chestRespawnMax: 2, chestRespawnMinDist: 30, chestRespawnTurns: 60,
  endgameFactor: 1.3, placementMode: 'new', thinKeep: 0.76, aggressive: false,
  gemColors: 5, gemsPerColor: 1, minSep: 30,
  // v1.9：终盘间隔 6（X22）；中盘上限 10（X14 终裁）；终盘触发线 60；事件 6/agent/局
  intervalMid: 10, intervalEnd: 6, endgameStamina: 60, eventBudgetPerAgent: 6,
};

/**
 * X30 · 自报配置摘要：每个 sim 脚本在输出头三行打印本局口径。
 * 起因：bench-match 被贴成"10颗"却给出 5 颗的值，同类错误已复发三次，
 * 每次都会污染一批判据的预期值。三行固定为 宝石数 / 撒点 / 体力+keep。
 *
 * 两种用法（推荐第一种，它不会写错）：
 *   1) cfgSummary('脚本名 · 用途')            // 延迟式：挂标签，真正跑第一局时用**实跑参数**打印
 *   2) cfgSummary(OPTS, '脚本名 · 用途')      // 立即式：直接按给定 OPTS 打印
 */
let _pendingLabel = null;
let _watch = false;          // 已报过一次 → 之后口径一变就再报一行（扫参数脚本自动分组）
let _label = '';             // 记住标签，配置变化时重报仍带标签
let _inSim = false;          // simulateGame 内部调用 generateMaze 时，由 simulateGame 负责自报
let _lastKey = '';
export function cfgSummary(a = '', b = '') {
  if (typeof a === 'string' && b === '') { _pendingLabel = a; _label = a; _watch = false; _lastKey = ''; return null; }
  _label = b || a && typeof a === 'string' ? (b || a) : (_label);
  return printCfg(a, b || _label);
}
const cfgKey = O => JSON.stringify([O.gemColors, O.gemsPerColor, O.placementMode, O.minSep,
  O.nAgents, O.aggressive, O.stamina, O.thinKeep, O.intervalMid, O.intervalEnd, O.endgameStamina, O.eventBudgetPerAgent]);
function printCfg(opt, label) {
  _pendingLabel = null;
  if (label) _label = label;
  const O = Object.assign({}, SIM_DEFAULTS, opt);
  const k = cfgKey(O);
  if (k === _lastKey) return O;      // 同口径不重复报
  _lastKey = k; _watch = true;
  const nGem = O.gemColors * O.gemsPerColor;
  const L1 = `宝石 ${nGem} 颗 (gemColors ${O.gemColors} × gemsPerColor ${O.gemsPerColor}) + 宝箱 1`
    + (nGem === 5 ? '   ⚠ 5 颗口径，不是 v1.6 定案的 10 颗' : '');
  const L2 = `撒点 ${O.placementMode}${O.placementMode === 'reject' ? `+minSep${O.minSep}` : ''}`
    + ` · 角色 ${O.nAgents} · 策略 ${O.aggressive ? 'aggressive(买不起也去)' : 'rational(买不起则跳过)'}`;
  const L3 = `体力 ${O.stamina} · keep ${O.thinKeep} · 间隔 mid${O.intervalMid}/end${O.intervalEnd}`
    + ` · 终盘线 ${O.endgameStamina} · 事件 ${O.eventBudgetPerAgent}/agent`;
  console.log(`┌─ ${label}`);
  console.log(`│ ${L1}`);
  console.log(`│ ${L2}`);
  console.log(`│ ${L3}`);
  console.log(`└${'─'.repeat(64)}`);
  return O;
}
function printMazeCfg(P, label) {
  _pendingLabel = null;
  if (label) _label = label;
  const k = 'maze|' + JSON.stringify([P.thinKeep, P.braidRatio, P.roomCount, P.plazaRadius]);
  if (k === _lastKey) return P;
  _lastKey = k; _watch = true;
  console.log(`┌─ ${label}   （纯迷宫脚本：无宝石/体力口径）`);
  console.log(`│ keep ${P.thinKeep} · braid ${P.braidRatio} · 房间 ${P.roomCount} · 出口广场 r${P.plazaRadius}`);
  console.log(`│ 出生 ${JSON.stringify(P.spawns)}`);
  console.log(`│ 出口 ${JSON.stringify(P.exits)}`);
  console.log(`└${'─'.repeat(64)}`);
  return P;
}

export function simulateGame(seed, opt = {}) {
  const O = Object.assign({}, SIM_DEFAULTS, opt);
  if (_pendingLabel || (_watch && cfgKey(O) !== _lastKey)) printCfg(O, _label);   // X30 自报

  const rngM = mulberry32(subSeed(seed, 1));
  const rngT = mulberry32(subSeed(seed, 2));
  const rngC = mulberry32(subSeed(seed, 3));

  _inSim = true;
  const maze = generateMaze(rngM, { spawns: O.spawns, exits: O.exits, thinKeep: O.thinKeep });
  _inSim = false;
  const grid = maze.grid;
  const nA = O.nAgents;

  const spawnPos = O.spawns.map(([x, y]) => at(x, y));
  const exitPos = O.exits.map(([x, y]) => at(x, y));

  // 连通性校验
  const f0 = bfsField(grid, [spawnPos[0]]);
  for (let i = 0; i < 4; i++) {
    if (f0[spawnPos[i]] < 0) return { invalid: 'spawn' };
    if (f0[exitPos[i]] < 0) return { invalid: 'exit' };
  }

  // 出生点距离场（宝物撒点用，整局复用）
  const spawnFields = spawnPos.slice(0, 4).map(p => bfsField(grid, [p]));
  const pool = buildFloorPool(grid, O.spawns, O.exits);
  if (pool.length < 100) return { invalid: 'pool' };

  // 出口距离场（每 agent 一张）
  const exitFields = [];
  for (let i = 0; i < nA; i++) exitFields.push(bfsField(grid, [exitPos[i]]));

  const place = (minDistFromActors, actorPos) => {
    let p = pool;
    if (minDistFromActors > 0 && actorPos.length) {
      const df = bfsField(grid, actorPos);      // 多源 BFS：到最近角色的距离
      const f = pool.filter(c => df[c] >= minDistFromActors);
      if (f.length >= 20) p = f;
    }
    return placeTreasures(rngT, p, spawnFields, {
      mode: O.placementMode,
      nGem: O.gemColors * O.gemsPerColor,
      minSep: O.minSep,
    });
  };

  let placement = place(0, []);
  let gemPos = placement.gems.slice();
  let chestPos = placement.chest;
  let gemAlive = gemPos.map(() => true);
  let chestAlive = true;

  const gemFields = gemPos.map(p => bfsField(grid, [p]));
  let chestField = bfsField(grid, [chestPos]);

  const actors = [];
  for (let i = 0; i < nA; i++) {
    actors.push({
      id: i, pos: spawnPos[i], stamina: O.stamina, score: 0,
      colors: new Set(), picked: 0, streak: 0, mode: 'COLLECT',
      status: 'active', endTurn: -1, illegal: 0, pickDist: [], chestHits: 0,
      // v1.9 物理隔离双池：常态池 / 终盘池 独立计数，终盘由 stamina<=60 判定
      lastCall: -999, midCalls: 0, endCalls: 0, endgameEntries: 0, inEnd: false,
    });
  }

  let gen = 0, chestRespawns = 0, lastChestTurn = -999;
  const BASE_COLORS = ['R', 'G', 'B', 'Y', 'P'];
  const gemColors = gemPos.map((_, k) => BASE_COLORS[k % O.gemColors]);
  let turn = 0;

  // 动画分档直方图：每回合取"该回合出现的最长动画"类别（结算 > 拾取 > 移动 > 弹回）
  const anim = { move: 0, bump: 0, pick: 0, end: 0, idle: 0, turns: 0 };
  let tMove = false, tBump = false, tPick = false, tEnd = false;

  while (turn < O.maxTurns) {
    turn++;
    const alive = actors.filter(a => a.status === 'active');
    if (alive.length === 0) break;
    tMove = false; tBump = false; tPick = false; tEnd = false;

    // ---- 1. 决策
    const intents = new Array(nA).fill(STAY);
    for (const a of alive) {
      // ---- 0. v1.9 双池记账：终盘判定 = stamina <= 60（X14 终裁触发线）
      const isEnd = a.stamina <= O.endgameStamina;
      const interval = isEnd ? O.intervalEnd : O.intervalMid;
      if (isEnd && !a.inEnd) { a.endgameEntries++; a.inEnd = true; }
      if (!isEnd) a.inEnd = false;
      if (turn - a.lastCall >= interval) {
        a.lastCall = turn;
        if (isEnd) a.endCalls++; else a.midCalls++;
      }

      const ef = exitFields[a.id];
      const dExit = ef[a.pos];
      if (a.mode !== 'HOME' && a.stamina <= dExit * O.endgameFactor) a.mode = 'HOME';
      let dir;
      if (a.mode === 'HOME') {
        dir = dExit > 0 ? stepFrom(a.pos, ef) : STAY;
      } else {
        let bestF = null, bestScore = -Infinity;
        for (let k = 0; k < gemPos.length; k++) {
          if (!gemAlive[k]) continue;
          const dc = gemFields[k][a.pos];
          if (dc < 0) continue;
          const dce = ef[gemPos[k]];
          if (!O.aggressive && a.stamina - dc - dce < 0) continue;    // 买不起
          const sc = 1 / (dc + 1);
          if (sc > bestScore) { bestScore = sc; bestF = gemFields[k]; }
        }
        if (chestAlive) {
          const dc = chestField[a.pos];
          if (dc >= 0) {
            const dce = ef[chestPos];
            if (a.stamina - dc - dce >= 0) {
              const v = a.stamina < 300 ? 1.2 : 0.6;
              const sc = v / (dc + 1);
              if (sc > bestScore) { bestScore = sc; bestF = chestField; }
            }
          }
        }
        if (!bestF) { a.mode = 'HOME'; dir = dExit > 0 ? stepFrom(a.pos, ef) : STAY; }
        else dir = stepFrom(a.pos, bestF);
      }
      intents[a.id] = dir;
    }

    // ---- 2. 合法性 + 阻挡仲裁
    const want = new Array(nA).fill(STAY);
    const tgt = new Array(nA).fill(-1);
    const isIllegal = new Array(nA).fill(false);
    const occAt = new Map();
    for (const a of alive) occAt.set(a.pos, a.id);

    for (const a of alive) {
      const d = intents[a.id];
      if (d === STAY) { want[a.id] = STAY; continue; }
      const x = a.pos % N, y = (a.pos / N) | 0;
      const nx = x + DIRS5[d][0], ny = y + DIRS5[d][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || grid[at(nx, ny)] !== FLOOR) {
        want[a.id] = STAY; isIllegal[a.id] = true; a.illegal++; continue;
      }
      want[a.id] = d; tgt[a.id] = at(nx, ny);
    }

    let mover = new Array(nA).fill(false);
    for (const a of alive) if (want[a.id] !== STAY) mover[a.id] = true;

    let changed = true;
    while (changed) {
      changed = false;
      // A: 目标格被"不动者"占据
      for (const a of alive) {
        if (!mover[a.id]) continue;
        const occ = occAt.get(tgt[a.id]);
        if (occ !== undefined && !mover[occ]) { mover[a.id] = false; changed = true; }
      }
      if (changed) continue;
      // B: 同格抢占
      const byTgt = new Map();
      for (const a of alive) if (mover[a.id]) {
        if (byTgt.has(tgt[a.id])) byTgt.get(tgt[a.id]).push(a.id); else byTgt.set(tgt[a.id], [a.id]);
      }
      for (const [t, ids] of byTgt) if (ids.length >= 2) { for (const i of ids) mover[i] = false; changed = true; }
      if (changed) continue;
      // C: 环（含对穿）—— 环上全员不动
      const posToMover = new Map();
      for (const a of alive) if (mover[a.id]) posToMover.set(a.pos, a.id);
      const state = new Map();
      for (const a of alive) {
        if (!mover[a.id] || state.has(a.id)) continue;
        const path = [];
        let cur = a.id, cyc = false;
        while (cur !== undefined && !state.has(cur)) {
          state.set(cur, 1); path.push(cur);
          cur = posToMover.get(tgt[cur]);
        }
        if (cur !== undefined && state.get(cur) === 1) {
          const s = path.indexOf(cur);
          for (let k = s; k < path.length; k++) { mover[path[k]] = false; changed = true; }
          cyc = true;
        }
        for (const p of path) state.set(p, 2);
        if (cyc) break;
      }
    }

    // ---- 3. 位移 + 体力结算
    const newPos = new Array(nA).fill(-1);
    for (const a of alive) {
      if (mover[a.id]) { newPos[a.id] = tgt[a.id]; a.streak = 0; tMove = true; }
      else {
        newPos[a.id] = a.pos;
        a.streak++;
        if (want[a.id] !== STAY) tBump = true;      // 撞墙 / 被角色挡 → 弹回动画
        // 四面全阻判定（墙或角色，按回合开始的占据状态）
        let surrounded = true;
        const x = a.pos % N, y = (a.pos / N) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const n = at(nx, ny);
          if (grid[n] === FLOOR && !occAt.has(n)) { surrounded = false; break; }
        }
        let cost;
        if (isIllegal[a.id] || want[a.id] === STAY) cost = 1;
        else if (surrounded) cost = 1;
        else cost = 0;                                   // 被角色阻挡
        if (a.streak >= 4) cost = 1;                     // 僵持兜底
        a.stamina -= cost;
      }
      if (mover[a.id]) a.stamina -= 1;
    }
    for (const a of alive) if (newPos[a.id] >= 0) a.pos = newPos[a.id];

    for (const a of alive) {
      if (a.stamina <= 0) {
        if (a.pos === exitPos[a.id]) { a.status = 'escaped'; a.stamina = 0; a.endTurn = turn; }
        else { a.status = 'failed'; a.stamina = 0; a.endTurn = turn; }
        tEnd = true;
      }
    }

    // ---- 4. 拾取（P0→P3，失败者不参与）
    for (const a of actors) {
      if (a.status !== 'active') continue;
      for (let k = 0; k < gemPos.length; k++) {
        if (gemAlive[k] && a.pos === gemPos[k]) {
          gemAlive[k] = false; a.score += 1; a.picked += 1; a.colors.add(gemColors[k]);
          a.pickDist.push(spawnFields[a.id][gemPos[k]]);   // 该宝物离"本角色出生点"的 BFS 距离
          tPick = true;
        }
      }
      if (chestAlive && a.pos === chestPos) {
        chestAlive = false; a.picked += 1; lastChestTurn = turn; a.chestHits++;
        a.pickDist.push(spawnFields[a.id][chestPos]);
        tPick = true;
        if (rngC() < 0.5) a.score += 1 + ((rngC() * 5) | 0);
        else a.stamina = Math.min(O.stamina, a.stamina + 25 + ((rngC() * 26) | 0));
      }
    }

    // ---- 5. 达成判定
    for (const a of actors) {
      if (a.status === 'active' && a.pos === exitPos[a.id]) { a.status = 'escaped'; a.endTurn = turn; tEnd = true; }
    }

    // ---- 5.5 动画分档记账（取该回合最长动画，互斥直方图）
    anim.turns++;
    if (tEnd) anim.end++;
    else if (tPick) anim.pick++;
    else if (tMove) anim.move++;
    else if (tBump) anim.bump++;
    else anim.idle++;

    // ---- 6. 重生
    if (gemAlive.every(x => !x) && gen < O.gemRespawnMax) {
      gen++;
      const apos = actors.filter(a => a.status === 'active').map(a => a.pos);
      const pl = place(O.gemRespawnMinDist, apos);
      gemPos = pl.gems.slice(); gemAlive = gemPos.map(() => true);
      for (let k = 0; k < gemPos.length; k++) gemFields[k] = bfsField(grid, [gemPos[k]]);
    }
    if (!chestAlive && chestRespawns < O.chestRespawnMax && turn - lastChestTurn >= O.chestRespawnTurns) {
      chestRespawns++;
      const apos = actors.filter(a => a.status === 'active').map(a => a.pos);
      const pl = place(O.chestRespawnMinDist, apos);
      chestPos = pl.chest; chestAlive = true;
      chestField = bfsField(grid, [chestPos]);
    }

    if (actors.every(a => a.status !== 'active')) break;
  }

  return {
    invalid: null, turns: turn, anim, actors: actors.map(a => ({
      id: a.id, status: a.status, score: a.score, picked: a.picked, chestHits: a.chestHits,
      midCalls: a.midCalls, endCalls: a.endCalls, endgameEntries: a.endgameEntries,
      colors: a.colors.size, stamina: a.stamina, endTurn: a.endTurn,
      pickDist: a.pickDist.slice(),
    })),
  };
}
