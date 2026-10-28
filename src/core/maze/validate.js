// 开局校验（SPEC §1.4）。全部通过才可开局。

import { inwardOf } from '../geom.js';

/**
 * @param {object} map buildMap() 的结果
 * @param {object} cfg
 * @returns {{ok:boolean, failures:string[], metrics:{density:number, spawnExit:number[], spread:number, floors:number}}}
 */
export function analyzeMap(map, cfg) {
  const { size: N, grid: g, spawns, exits } = map;
  const failures = new Set();
  const floorAt = (x, y) => x >= 0 && y >= 0 && x < N && y < N && g[y * N + x] === 1;
  const floorNeighbors = (x, y) =>
    (floorAt(x, y - 1) ? 1 : 0) + (floorAt(x + 1, y) ? 1 : 0) + (floorAt(x, y + 1) ? 1 : 0) + (floorAt(x - 1, y) ? 1 : 0);

  // V1 地板单连通
  const reach = map.spawnField[0];
  let floors = 0;
  let reached = 0;
  for (let i = 0; i < g.length; i++) {
    if (!g[i]) continue;
    floors++;
    if (reach[i] >= 0) reached++;
  }
  if (floors === 0 || reached !== floors) failures.add('V1');

  // V2 出生格为地板且不四面受阻
  for (const [x, y] of spawns) {
    if (!floorAt(x, y) || floorNeighbors(x, y) < cfg.maze.spawnMinOpenNeighbors) failures.add('V2');
  }

  // V3 出口：在边上非角、为地板、开口宽 1、内侧格连通内部
  for (const [x, y] of exits) {
    const onV = x === 0 || x === N - 1;
    const onH = y === 0 || y === N - 1;
    if (onV === onH || !floorAt(x, y)) { failures.add('V3'); continue; }
    const sides = onV ? [[x, y - 1], [x, y + 1]] : [[x - 1, y], [x + 1, y]];
    if (sides.some(([sx, sy]) => floorAt(sx, sy))) failures.add('V3');
    const [ix, iy] = inwardOf(x, y, N);
    if (!floorAt(ix, iy) || floorNeighbors(ix, iy) < 2) failures.add('V3');
  }

  // V4 / V5 出生 → 自己出口
  const spawnExit = Array.from(map.spawnExit);
  const [lo, hi] = cfg.exits.spawnExitRange;
  if (spawnExit.some((d) => d < lo || d > hi)) failures.add('V4');
  let spread = Infinity;
  if (spawnExit.every((d) => d > 0)) {
    const mean = spawnExit.reduce((a, b) => a + b, 0) / spawnExit.length;
    spread = (Math.max(...spawnExit) - Math.min(...spawnExit)) / mean;
  }
  if (!(spread <= cfg.exits.fairnessMaxSpread)) failures.add('V5');

  // V6 封边后墙密度
  const { wallDensityTarget: t, wallDensityTol: tol } = cfg.maze;
  if (map.density < t - tol - 1e-12 || map.density > t + tol + 1e-12) failures.add('V6');

  return { ok: failures.size === 0, failures: [...failures].sort(), metrics: { density: map.density, spawnExit, spread, floors } };
}
