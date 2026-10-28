import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, gridOf, handMatch } from './helpers.mjs';
import { runMatch } from '../src/sim/headless.js';
import { step } from '../src/core/game.js';
import { observe } from '../src/core/observe.js';
import { createHeuristic, isHome, isAffordable, hasRightOfWay } from '../src/ai/heuristic.js';

function play(map, state, cfg, maxTurns = 300) {
  const ctrls = [0, 1, 2, 3].map((i) => createHeuristic(map, i, cfg, 7));
  let s = state;
  while (!s.ended && s.turn <= maxTurns) {
    const intents = s.actors.map((a, i) => (a.status === 'active' ? ctrls[i].decide(observe(map, s, i, cfg, { patch: false })).dir : 'STAY'));
    s = step(map, s, intents, cfg).state;
  }
  return s;
}

test('阈值函数：回家 s*10 ≤ d*13；可负担 s ≥ d去 + 1.3·d回；路权 体力低 > 座位小', () => {
  assert.equal(isHome(130, 100, 13), true);
  assert.equal(isHome(131, 100, 13), false);
  assert.equal(isAffordable(23, 10, 10, 13), true);
  assert.equal(isAffordable(22, 10, 10, 13), false);
  assert.equal(hasRightOfWay({ seat: 3, stamina: 10 }, { seat: 0, stamina: 11 }), true);
  assert.equal(hasRightOfWay({ seat: 1, stamina: 10 }, { seat: 2, stamina: 10 }), true);
  assert.equal(hasRightOfWay({ seat: 2, stamina: 10 }, { seat: 1, stamina: 10 }), false);
});

test('单通道迎面相遇（中间只有一个侧袋）：靠路权 + 让行双方都能回家', () => {
  const size = 24;
  const exits = [[23, 5], [0, 5], [23, 20], [0, 20]];
  const grid = gridOf(size, (x, y) => y === 5 && x >= 1 && x <= 22, [[11, 6], ...exits]);
  const spawns = [[2, 5], [21, 5], [3, 5], [4, 5]];
  const { map, state, cfg } = handMatch({ size, grid, spawns, exits, active: [true, true, false, false] });
  const s = play(map, state, cfg);
  assert.ok(s.ended, '应在回合上限前结束');
  assert.deepEqual(s.actors.slice(0, 2).map((a) => a.status), ['escaped', 'escaped']);
});

test('两人隔一格抢同一颗宝石：掷币让行打破对称，一人拿到、两人都回家', () => {
  const size = 20;
  const exits = [[0, 10], [19, 10], [10, 19], [10, 0]];
  const grid = gridOf(size, (x, y) => (y === 10 && x >= 1 && x <= 18) || (x === 10 && y >= 1 && y <= 18), exits);
  const spawns = [[8, 10], [12, 10], [10, 15], [10, 5]];
  const { map, state, cfg } = handMatch({ size, grid, spawns, exits, gems: [{ c: 0, x: 10, y: 10 }], active: [true, true, false, false] });
  const s = play(map, state, cfg, 100);
  assert.ok(s.ended);
  const got = s.actors.slice(0, 2).map((a) => a.gems[0]);
  assert.deepEqual(got.slice().sort(), [0, 1]);
  assert.deepEqual(s.actors.slice(0, 2).map((a) => a.status), ['escaped', 'escaped']);
});

test('4 个启发式 AI 互打 40 局：无人因体力或回合上限失败（不自杀、能解开僵局）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = runMatch(seed, CFG);
    for (const a of r.state.actors) assert.equal(a.status, 'escaped', `seed ${seed} seat ${a.seat}: ${a.failReason}`);
  }
});

test('启发式 AI 的随机性只来自本座位 AI 流：同种子同决策', () => {
  const a = runMatch(11, CFG, { hashes: true });
  const b = runMatch(11, CFG, { hashes: true });
  assert.deepEqual(a.hashes, b.hashes);
});
