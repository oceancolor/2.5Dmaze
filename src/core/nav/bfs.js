// BFS 距离场（4 邻，墙不可通，不计角色占位）。Int16Array，-1 = 不可达。

let Q = new Int32Array(0);

/**
 * @param {Uint8Array} grid 1=地板 0=墙
 * @param {number} size
 * @param {ArrayLike<number>} sources 源格索引
 * @param {Uint8Array|null} [blocked] 额外视为墙的格
 */
export function bfsField(grid, size, sources, blocked = null) {
  const n = size * size;
  if (Q.length < n) Q = new Int32Array(n);
  const dist = new Int16Array(n).fill(-1);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (s < 0 || s >= n || !grid[s] || dist[s] !== -1) continue;
    if (blocked && blocked[s]) continue;
    dist[s] = 0;
    Q[tail++] = s;
  }
  while (head < tail) {
    const c = Q[head++];
    const d = dist[c] + 1;
    const x = c % size;
    let m;
    if (x > 0) { m = c - 1; if (dist[m] === -1 && grid[m] && !(blocked && blocked[m])) { dist[m] = d; Q[tail++] = m; } }
    if (x < size - 1) { m = c + 1; if (dist[m] === -1 && grid[m] && !(blocked && blocked[m])) { dist[m] = d; Q[tail++] = m; } }
    if (c >= size) { m = c - size; if (dist[m] === -1 && grid[m] && !(blocked && blocked[m])) { dist[m] = d; Q[tail++] = m; } }
    if (c < n - size) { m = c + size; if (dist[m] === -1 && grid[m] && !(blocked && blocked[m])) { dist[m] = d; Q[tail++] = m; } }
  }
  return dist;
}

const CACHE = new WeakMap();

/** 以某格为源的距离场（按地图缓存；网格无向，故 field[a] = 距离(源, a)）。 */
export function fieldFrom(map, idx) {
  let m = CACHE.get(map);
  if (!m) { m = new Map(); CACHE.set(map, m); }
  let f = m.get(idx);
  if (!f) { f = bfsField(map.grid, map.size, [idx]); m.set(idx, f); }
  return f;
}
