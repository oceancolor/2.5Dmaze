// 宝物撒点（SPEC §3.4）：开局拒绝采样 + 公平性；重生按距离角色下限 + 逐级放宽间距。

import { randInt } from '../rng.js';
import { cheb, manh } from '../geom.js';
import { bfsField } from '../nav/bfs.js';

/** 候选池：主连通域地板，排除出生点 / 出口附近（切比雪夫）。 */
export function buildPool(map, cfg) {
  const { size: N, grid: g, spawns, exits } = map;
  const P = cfg.treasure.placement;
  const reach = map.spawnField[0];
  const out = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const idx = y * N + x;
      if (!g[idx] || reach[idx] < 0) continue;
      if (spawns.some(([sx, sy]) => cheb(x, y, sx, sy) <= P.spawnExclusion)) continue;
      if (exits.some(([ex, ey]) => cheb(x, y, ex, ey) <= P.exitExclusion)) continue;
      out.push(idx);
    }
  }
  return Int32Array.from(out);
}

function sepOK(c, chosen, sep, N) {
  const x = c % N;
  const y = (c / N) | 0;
  for (let k = 0; k < chosen.length; k++) {
    const o = chosen[k];
    if (o === c) return false;
    if (sep > 0 && manh(x, y, o % N, (o / N) | 0) < sep) return false;
  }
  return true;
}

/** 四座位到全部件的 BFS 距离和的 (max-min)/mean。 */
export function fairSpread(map, cells) {
  const D = map.spawnField.map((f) => cells.reduce((acc, c) => acc + f[c], 0));
  const mean = D.reduce((a, b) => a + b, 0) / D.length;
  return mean > 0 ? (Math.max(...D) - Math.min(...D)) / mean : Infinity;
}

export function minPairwise(cells, N) {
  let m = Infinity;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const d = manh(a % N, (a / N) | 0, b % N, (b / N) | 0);
      if (d < m) m = d;
    }
  }
  return m;
}

function itemCount(cfg) {
  const T = cfg.treasure;
  return T.gemColors.length * T.gemsPerColor;
}

function toItems(cells, map, cfg) {
  const N = map.size;
  const gemN = itemCount(cfg);
  const colors = cfg.treasure.gemColors.length;
  const gems = [];
  for (let k = 0; k < gemN; k++) gems.push({ c: k % colors, x: cells[k] % N, y: (cells[k] / N) | 0 });
  const chest = cfg.treasure.chest.count > 0 ? { x: cells[gemN] % N, y: (cells[gemN] / N) | 0 } : null;
  return { gems, chest };
}

/**
 * 开局撒点：全部宝石 + 宝箱，逐件拒绝采样（曼哈顿间距）→ 公平性校验 → 兜底整组随机取最优。
 * @returns {{gems:{c:number,x:number,y:number}[], chest:{x:number,y:number}|null} | null}
 */
export function placeInitial(map, st, cfg) {
  const P = cfg.treasure.placement;
  const N = map.size;
  const pool = map.pool;
  const count = itemCount(cfg) + (cfg.treasure.chest.count > 0 ? 1 : 0);
  if (!pool || pool.length < count) return null;
  const pick = () => pool[randInt(st, 0, pool.length - 1)];

  for (let restart = 0; restart <= P.restartMax; restart++) {
    const chosen = [];
    for (let k = 0; k < count; k++) {
      let placed = false;
      for (let t = 0; t < P.rejectTries; t++) {
        const c = pick();
        if (sepOK(c, chosen, P.minSeparation, N)) { chosen.push(c); placed = true; break; }
      }
      if (!placed) break;
    }
    if (chosen.length === count && fairSpread(map, chosen) <= P.fairMaxSpread) return toItems(chosen, map, cfg);
  }

  let best = null;
  let bestMin = -1;
  for (let k = 0; k < P.fallbackSets; k++) {
    const set = [];
    while (set.length < count) {
      const c = pick();
      if (!set.includes(c)) set.push(c);
    }
    if (fairSpread(map, set) > P.fairMaxSpread) continue;
    const m = minPairwise(set, N);
    if (m > bestMin) { bestMin = m; best = set; }
  }
  return best ? toItems(best, map, cfg) : null;
}

/**
 * 重生撒点：距每个在场角色 BFS ≥ minActorDist（永不放宽）；与已在场物件的间距按 schedule 逐级放宽。
 * @returns {{cells:number[], sep:number} | null}
 */
export function placeRespawn(map, st, cfg, { count, minActorDist, actorCells, existingCells }) {
  const P = cfg.treasure.placement;
  const N = map.size;
  const actorField = actorCells.length ? bfsField(map.grid, N, actorCells) : null;
  const occupied = new Set([...actorCells, ...existingCells]);
  const cand = [];
  for (const c of map.pool) {
    if (occupied.has(c)) continue;
    if (actorField && actorField[c] >= 0 && actorField[c] < minActorDist) continue;
    cand.push(c);
  }
  if (cand.length < count) return null;
  const pick = () => cand[randInt(st, 0, cand.length - 1)];

  for (const sep of P.respawnSepSchedule) {
    for (let restart = 0; restart <= P.restartMax; restart++) {
      const chosen = [];
      for (let k = 0; k < count; k++) {
        let placed = false;
        for (let t = 0; t < P.rejectTries; t++) {
          const c = pick();
          if (sepOK(c, chosen, sep, N) && sepOK(c, existingCells, sep, N)) { chosen.push(c); placed = true; break; }
        }
        if (!placed) break;
      }
      if (chosen.length === count) return { cells: chosen, sep };
    }
  }
  return null;
}
