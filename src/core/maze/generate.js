// 迷宫生成（SPEC §1.3，顺序固定）：
// growing-tree → braid → 房间 → 削墙 → 封边 → 开洞（出生 3×3、出口格+内侧 1 格）→ 回填孤岛
// 纯函数：同 seed + 同参数 → 同网格。

import { createStream, next } from '../rng.js';
import { inwardOf } from '../geom.js';
import { bfsField } from '../nav/bfs.js';

const CDX = [0, 1, 0, -1];
const CDY = [-1, 0, 1, 0];

/**
 * @param {number} seed uint32
 * @param {{size:number, growth:{newest:number,random:number}, braidRatio:number, roomCount:number,
 *          roomSize:[number,number], thinKeep:number, spawns:number[][], exits:number[][], spawnPlazaRadius:number}} P
 * @returns {{grid: Uint8Array, density: number}}
 */
export function generateGrid(seed, P) {
  const st = createStream(seed);
  const rng = () => next(st);
  const N = P.size;
  const g = new Uint8Array(N * N); // 0 墙 / 1 地板
  const at = (x, y) => y * N + x;

  // 1. growing tree：单元在奇坐标 (2i+1, 2j+1)，i,j ∈ [0,C)，最大到 N-3（128 → 125），不触碰外圈
  const C = (N - 2) >> 1;
  const visited = new Uint8Array(C * C);
  const list = new Int32Array(C * C);
  let ln = 0;
  visited[0] = 1;
  g[at(1, 1)] = 1;
  list[ln++] = 0;
  const pNewest = P.growth.newest;
  const pNewestRandom = P.growth.newest + P.growth.random;
  while (ln > 0) {
    const r = rng();
    let p;
    if (r < pNewest) p = ln - 1;
    else if (r < pNewestRandom) p = (rng() * ln) | 0;
    else p = 0;
    const id = list[p];
    const i = id % C;
    const j = (id / C) | 0;
    let bi = -1;
    let bj = -1;
    let cnt = 0;
    for (let d = 0; d < 4; d++) {
      const ni = i + CDX[d];
      const nj = j + CDY[d];
      if (ni < 0 || nj < 0 || ni >= C || nj >= C || visited[nj * C + ni]) continue;
      cnt++;
      if (rng() * cnt < 1) { bi = ni; bj = nj; }
    }
    if (cnt === 0) { list[p] = list[--ln]; continue; }
    g[at(2 * i + 1 + (bi - i), 2 * j + 1 + (bj - j))] = 1;
    visited[bj * C + bi] = 1;
    g[at(2 * bi + 1, 2 * bj + 1)] = 1;
    list[ln++] = bj * C + bi;
  }

  // 2. braid：死胡同以 braidRatio 概率打通一面墙
  const maxCell = 2 * C - 1;
  const dead = [];
  for (let j = 0; j < C; j++) {
    for (let i = 0; i < C; i++) {
      const x = 2 * i + 1;
      const y = 2 * j + 1;
      let nb = 0;
      for (let d = 0; d < 4; d++) if (g[at(x + CDX[d], y + CDY[d])]) nb++;
      if (nb === 1) dead.push(x, y);
    }
  }
  for (let k = 0; k < dead.length; k += 2) {
    const x = dead[k];
    const y = dead[k + 1];
    if (rng() >= P.braidRatio) continue;
    let pick = -1;
    let cnt = 0;
    for (let d = 0; d < 4; d++) {
      const cx = x + 2 * CDX[d];
      const cy = y + 2 * CDY[d];
      if (cx < 1 || cy < 1 || cx > maxCell || cy > maxCell) continue;
      if (g[at(x + CDX[d], y + CDY[d])]) continue;
      if (!g[at(cx, cy)]) continue;
      cnt++;
      if (rng() * cnt < 1) pick = d;
    }
    if (pick >= 0) g[at(x + CDX[pick], y + CDY[pick])] = 1;
  }

  // 3. 房间：完全落在 [2, N-3]
  const [rlo, rhi] = P.roomSize;
  for (let k = 0; k < P.roomCount; k++) {
    const w = rlo + ((rng() * (rhi - rlo + 1)) | 0);
    const h = rlo + ((rng() * (rhi - rlo + 1)) | 0);
    const x0 = 2 + ((rng() * (N - 3 - w)) | 0);
    const y0 = 2 + ((rng() * (N - 3 - h)) | 0);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[at(x, y)] = 1;
  }

  // 4. 削墙：内部墙以 (1-thinKeep) 概率变地板
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const idx = at(x, y);
      if (!g[idx] && rng() >= P.thinKeep) g[idx] = 1;
    }
  }

  // 5. 封边
  for (let k = 0; k < N; k++) {
    g[at(k, 0)] = 0;
    g[at(k, N - 1)] = 0;
    g[at(0, k)] = 0;
    g[at(N - 1, k)] = 0;
  }

  // 6. 开洞：出生 (2r+1)²；出口格 + 内侧 1 格（开口宽 1）
  const r = P.spawnPlazaRadius;
  for (const [sx, sy] of P.spawns) {
    for (let y = Math.max(1, sy - r); y <= Math.min(N - 2, sy + r); y++) {
      for (let x = Math.max(1, sx - r); x <= Math.min(N - 2, sx + r); x++) g[at(x, y)] = 1;
    }
  }
  for (const [ex, ey] of P.exits) {
    g[at(ex, ey)] = 1;
    const [ix, iy] = inwardOf(ex, ey, N);
    g[at(ix, iy)] = 1;
  }

  // 7. 回填孤岛：与座位 0 出生点不连通的地板全部回填为墙
  const [s0x, s0y] = P.spawns[0];
  const reach = bfsField(g, N, [at(s0x, s0y)]);
  let walls = 0;
  for (let i = 0; i < g.length; i++) {
    if (g[i] && reach[i] < 0) g[i] = 0;
    if (!g[i]) walls++;
  }

  return { grid: g, density: walls / (N * N) };
}
