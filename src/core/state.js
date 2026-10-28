// 地图对象、对局创建（含重掷）、初始状态与克隆。

import { STREAM, createStream, subSeed, normalizeSeed } from './rng.js';
import { STAY } from './geom.js';
import { bfsField } from './nav/bfs.js';
import { mapHashOf } from './hash.js';
import { generateGrid } from './maze/generate.js';
import { analyzeMap } from './maze/validate.js';
import { buildPool, placeInitial } from './maze/place.js';
import { refreshMemory } from './vision.js';
import { staminaFor } from '../config/default.config.js';

/**
 * 静态地图（对局中不变，不进 stateHash）。
 * @param {Uint8Array} grid
 * @param {number} size
 * @param {number[][]} spawns 座位 i 的出生点
 * @param {number[][]} exits 座位 i 自己的出口
 */
export function buildMap(grid, size, spawns, exits, meta = {}) {
  const spawnField = spawns.map(([x, y]) => bfsField(grid, size, [y * size + x]));
  const spawnExit = spawns.map((_, i) => spawnField[i][exits[i][1] * size + exits[i][0]]);
  let walls = 0;
  for (let i = 0; i < grid.length; i++) if (!grid[i]) walls++;
  return {
    size,
    grid,
    spawns: spawns.map((p) => p.slice()),
    exits: exits.map((p) => p.slice()),
    spawnField,
    spawnExit,
    density: walls / (size * size),
    pool: null,
    hash: mapHashOf(grid, size, spawns, exits),
    ...meta,
  };
}

export function generatorParams(cfg) {
  const M = cfg.maze;
  return {
    size: M.size,
    growth: M.growth,
    braidRatio: M.braidRatio,
    roomCount: M.roomCount,
    roomSize: M.roomSize,
    thinKeep: M.thinKeep,
    spawns: cfg.spawns,
    exits: cfg.exits.positions,
    spawnPlazaRadius: M.spawnPlazaRadius,
  };
}

/** 第 attempt 次尝试的地图（未校验）。迷宫流 = subSeed(subSeed(seed,MAZE), attempt)。 */
export function generateMapAttempt(seed, attempt, cfg) {
  const { grid } = generateGrid(subSeed(subSeed(seed, STREAM.MAZE), attempt), generatorParams(cfg));
  return buildMap(grid, cfg.maze.size, cfg.spawns, cfg.exits.positions, { seed, attempt });
}

/**
 * 生成并校验地图、撒点、建初始状态。最多 cfg.maze.attempts 次，重试不放松任何参数。
 * @returns {{seed:number, map:object, state:object, attempts:number, rejects:string[], analysis:object}}
 */
export function createMatch(seed, cfg) {
  const s = normalizeSeed(seed);
  const rejects = [];
  for (let attempt = 0; attempt < cfg.maze.attempts; attempt++) {
    const map = generateMapAttempt(s, attempt, cfg);
    const v = analyzeMap(map, cfg);
    if (!v.ok) { rejects.push(v.failures.join('+')); continue; }
    map.pool = buildPool(map, cfg);
    const place = createStream(subSeed(subSeed(s, STREAM.PLACE), attempt));
    const items = placeInitial(map, place, cfg);
    if (!items) { rejects.push('V7'); continue; }
    const state = initState(map, items, place, createStream(subSeed(s, STREAM.CHEST)), cfg);
    return { seed: s, map, state, attempts: attempt + 1, rejects, analysis: v.metrics };
  }
  throw new Error(`map generation failed after ${cfg.maze.attempts} attempts (seed=${s}): ${rejects.join(', ')}`);
}

export function initState(map, items, placeStream, chestStream, cfg) {
  const T = cfg.treasure;
  const staminaMax = staminaFor(cfg);
  const actors = map.spawns.map(([x, y], seat) => ({
    seat,
    x,
    y,
    stamina: staminaMax,
    staminaMax,
    gems: new Array(T.gemColors.length).fill(0),
    chestScore: 0,
    chestStamina: 0,
    chestOpens: 0,
    status: 'active', // active | escaped | failed
    escapedTurn: 0,
    endTurn: 0,
    failReason: '',
    moves: 0,
    blockedStreak: 0,
    lastDir: STAY,
  }));
  const state = {
    turn: 1,
    ended: false,
    endTurn: 0,
    actors,
    gems: items.gems.map((g) => ({ c: g.c, x: g.x, y: g.y })),
    gemGeneration: 1,
    gemRespawnsLeft: T.gemRespawnMax,
    chest: items.chest
      ? { present: true, x: items.chest.x, y: items.chest.y, openedTurn: 0, respawnsLeft: T.chest.respawnMax }
      : { present: false, x: -1, y: -1, openedTurn: 0, respawnsLeft: 0 },
    rng: { place: { s: placeStream.s }, chest: { s: chestStream.s } },
    memory: actors.map(() => actors.map(() => null)),
  };
  refreshMemory(state, cfg.vision.entityRadius, 0);
  return state;
}

export function cloneState(s) {
  return {
    turn: s.turn,
    ended: s.ended,
    endTurn: s.endTurn,
    actors: s.actors.map((a) => ({ ...a, gems: a.gems.slice() })),
    gems: s.gems.map((g) => ({ c: g.c, x: g.x, y: g.y })),
    gemGeneration: s.gemGeneration,
    gemRespawnsLeft: s.gemRespawnsLeft,
    chest: { ...s.chest },
    rng: { place: { s: s.rng.place.s }, chest: { s: s.rng.chest.s } },
    memory: s.memory.map((row) => row.map((m) => (m ? m.slice() : null))),
  };
}
