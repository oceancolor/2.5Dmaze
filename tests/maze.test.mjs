import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, gridOf } from './helpers.mjs';
import { createMatch, buildMap } from '../src/core/state.js';
import { analyzeMap } from '../src/core/maze/validate.js';
import { inwardOf } from '../src/core/geom.js';

const SEEDS = [1, 2, 3, 7, 42, 1234, 99991, 'hello'];
const matches = SEEDS.map((s) => createMatch(s, CFG));

test('生成：每个种子都能通过 V1–V7 开局', () => {
  for (const m of matches) {
    const v = analyzeMap(m.map, CFG);
    assert.ok(v.ok, `seed ${m.seed}: ${v.failures}`);
    assert.ok(m.attempts >= 1 && m.attempts <= CFG.maze.attempts);
  }
});

test('生成：同种子同地图（确定性），不同种子不同地图', () => {
  const again = createMatch(SEEDS[0], CFG);
  assert.equal(again.map.hash, matches[0].map.hash);
  assert.equal(new Set(matches.map((m) => m.map.hash)).size, matches.length);
});

test('V2 出生格是地板且至少 2 个地板邻居（开局不允许四面受阻）', () => {
  for (const { map } of matches) {
    const N = map.size;
    for (const [x, y] of map.spawns) {
      assert.equal(map.grid[y * N + x], 1);
      const open = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) => map.grid[(y + dy) * N + x + dx]).length;
      assert.ok(open >= CFG.maze.spawnMinOpenNeighbors);
    }
  }
});

test('V3 出口：开口宽 1、内侧格连通；外圈除出口外全是墙', () => {
  for (const { map } of matches) {
    const N = map.size;
    const exitSet = new Set(map.exits.map(([x, y]) => y * N + x));
    for (let i = 0; i < N; i++) {
      for (const [x, y] of [[i, 0], [i, N - 1], [0, i], [N - 1, i]]) {
        if (!exitSet.has(y * N + x)) assert.equal(map.grid[y * N + x], 0, `border (${x},${y}) should be wall`);
      }
    }
    for (const [x, y] of map.exits) {
      assert.equal(map.grid[y * N + x], 1);
      const [ix, iy] = inwardOf(x, y, N);
      assert.equal(map.grid[iy * N + ix], 1);
    }
  }
});

test('V6 墙密度在目标 ± 容差内；V1 单连通（出生点 0 能到所有地板）', () => {
  for (const { map, analysis } of matches) {
    assert.ok(Math.abs(map.density - CFG.maze.wallDensityTarget) <= CFG.maze.wallDensityTol + 1e-12);
    const f = map.spawnField[0];
    for (let i = 0; i < map.grid.length; i++) if (map.grid[i]) assert.ok(f[i] >= 0);
    assert.ok(analysis.floors > 0);
  }
});

test('V4/V5 出生→自己出口距离在区间内且四座位公平', () => {
  const [lo, hi] = CFG.exits.spawnExitRange;
  for (const { map } of matches) {
    for (const d of map.spawnExit) assert.ok(d >= lo && d <= hi, `spawn→exit ${d}`);
  }
});

test('开局撒点：5 颗宝石各色一颗 + 1 个宝箱，互不重叠、都在地板上', () => {
  for (const { map, state } of matches) {
    const N = map.size;
    assert.deepEqual(state.gems.map((g) => g.c).sort(), [0, 1, 2, 3, 4]);
    const cells = [...state.gems.map((g) => g.y * N + g.x), state.chest.y * N + state.chest.x];
    assert.equal(new Set(cells).size, cells.length);
    for (const c of cells) assert.equal(map.grid[c], 1);
  }
});

test('校验器能抓到违规：出生格被围死 → V2；出口两侧开口 → V3', () => {
  const size = 16;
  const spawns = [[2, 2], [13, 2], [13, 13], [2, 13]];
  const exits = [[8, 0], [15, 8], [8, 15], [0, 8]];
  const base = (x, y) => x >= 1 && x <= 14 && y >= 1 && y <= 14;
  // 把座位 0 出生点四周砌墙
  const boxed = new Set([[2, 1], [3, 2], [2, 3], [1, 2]].map(([x, y]) => y * size + x));
  let g = gridOf(size, (x, y) => base(x, y) && !boxed.has(y * size + x), exits);
  let v = analyzeMap(buildMap(g, size, spawns, exits), CFG);
  assert.ok(v.failures.includes('V2'));
  // 出口 (8,0) 两侧也开洞
  g = gridOf(size, base, [...exits, [7, 0], [9, 0]]);
  v = analyzeMap(buildMap(g, size, spawns, exits), CFG);
  assert.ok(v.failures.includes('V3'));
});
