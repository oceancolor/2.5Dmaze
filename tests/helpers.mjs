// 测试辅助：手工小地图 + 初始状态。不匹配 node --test 的默认文件模式，不会被当作用例执行。

import { makeConfig } from '../src/config/default.config.js';
import { buildMap, initState } from '../src/core/state.js';
import { createStream } from '../src/core/rng.js';

export const CFG = makeConfig();

/** 以函数定义地板：floor(x,y) → bool；额外地板格 extra = [[x,y],...] */
export function gridOf(size, floor, extra = []) {
  const g = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) g[y * size + x] = floor(x, y) ? 1 : 0;
  for (const [x, y] of extra) g[y * size + x] = 1;
  return g;
}

/**
 * 手工对局。inactive 的座位直接标记为 escaped（不在场）。
 * 重生全部关掉（手工地图没有撒点池），需要时测试自己改 state。
 */
export function handMatch({ size, grid, spawns, exits, gems = [], chest = null, active = [true, true, true, true], cfg = CFG }) {
  const map = buildMap(grid, size, spawns, exits);
  const state = initState(map, { gems, chest }, createStream(1), createStream(2), cfg);
  state.gemRespawnsLeft = 0;
  state.chest.respawnsLeft = 0;
  state.actors.forEach((a, i) => {
    if (!active[i]) a.status = 'escaped';
  });
  return { map, state, cfg };
}

/** 8×8：内部 1..6 全地板，东/西/南/北边中点各开一个出口。 */
export function smallRoom(opts = {}) {
  const size = 8;
  const exits = [[7, 3], [0, 3], [3, 7], [3, 0]];
  const grid = gridOf(size, (x, y) => x >= 1 && x <= 6 && y >= 1 && y <= 6, exits);
  const spawns = opts.spawns ?? [[1, 1], [6, 1], [6, 6], [1, 6]];
  return handMatch({ size, grid, spawns, exits, ...opts });
}

export const idx = (x, y, N) => y * N + x;
