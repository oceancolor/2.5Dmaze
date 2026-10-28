import test from 'node:test';
import assert from 'node:assert/strict';
import { arbitrate } from '../src/core/arbitrate.js';
import { DIR } from '../src/core/geom.js';

const N = 10;
const P = (x, y) => y * N + x;
const { N: UP, E, S, W, STAY } = DIR;

function run(pos, dirs) {
  const r = arbitrate(pos, dirs, N);
  return { moved: r.moved, reason: r.reason };
}

/** 换座位顺序后结果应一致（按原座位映射回来）。 */
function assertOrderIndependent(pos, dirs) {
  const base = run(pos, dirs);
  const n = pos.length;
  const perm = Array.from({ length: n }, (_, i) => n - 1 - i);
  const r = run(perm.map((i) => pos[i]), perm.map((i) => dirs[i]));
  for (let k = 0; k < n; k++) {
    assert.equal(r.moved[k], base.moved[perm[k]]);
    assert.equal(r.reason[k], base.reason[perm[k]]);
  }
  return base;
}

test('两人抢同一格：都不动', () => {
  const r = assertOrderIndependent([P(1, 1), P(3, 1)], [E, W]);
  assert.deepEqual(r.moved, [false, false]);
  assert.deepEqual(r.reason, ['contest', 'contest']);
});

test('三人抢同一格：都不动', () => {
  const r = assertOrderIndependent([P(1, 2), P(3, 2), P(2, 1)], [E, W, S]);
  assert.deepEqual(r.moved, [false, false, false]);
  assert.ok(r.reason.every((x) => x === 'contest'));
});

test('链式让位：前车走、后车跟上', () => {
  const r = assertOrderIndependent([P(1, 1), P(2, 1), P(3, 1)], [E, E, E]);
  assert.deepEqual(r.moved, [true, true, true]);
});

test('链头不动则整链不动', () => {
  const r = assertOrderIndependent([P(1, 1), P(2, 1), P(3, 1)], [E, E, STAY]);
  assert.deepEqual(r.moved, [false, false, false]);
  assert.deepEqual(r.reason, ['blocked', 'blocked', 'stay']);
});

test('两条链汇入同一格：链头冲突、两条链都不动', () => {
  // A1(1,3)→A2(2,3)→X(3,3)←B2(4,3)←B1(5,3)
  const r = assertOrderIndependent([P(1, 3), P(2, 3), P(4, 3), P(5, 3)], [E, E, W, W]);
  assert.deepEqual(r.moved, [false, false, false, false]);
  assert.deepEqual(r.reason, ['blocked', 'contest', 'contest', 'blocked']);
});

test('对穿（长度 2 的环）：都不动', () => {
  const r = assertOrderIndependent([P(1, 1), P(2, 1)], [E, W]);
  assert.deepEqual(r.reason, ['cycle', 'cycle']);
});

test('对穿 + 第三人抢入同一格：同格冲突先判，整组不动', () => {
  // (1,1)E ↔ (2,1)W 对穿；(0,1)E 与 (2,1)W 抢 (1,1) → 后两者 contest，(1,1) 的目标格上是不动者 → blocked
  const r = assertOrderIndependent([P(1, 1), P(2, 1), P(0, 1)], [E, W, E]);
  assert.deepEqual(r.moved, [false, false, false]);
  assert.deepEqual(r.reason, ['blocked', 'contest', 'contest']);
});

test('对穿旁边的独立移动者不受影响', () => {
  const r = assertOrderIndependent([P(1, 1), P(2, 1), P(5, 5)], [E, W, S]);
  assert.deepEqual(r.moved, [false, false, true]);
  assert.deepEqual(r.reason, ['cycle', 'cycle', 'moved']);
});

test('4 人环（2×2 旋转）：全员不动', () => {
  // (1,1)→E (2,1)→S (2,2)→W (1,2)→N
  const r = assertOrderIndependent([P(1, 1), P(2, 1), P(2, 2), P(1, 2)], [E, S, W, UP]);
  assert.deepEqual(r.moved, [false, false, false, false]);
  assert.ok(r.reason.every((x) => x === 'cycle'));
});

test('不在场者不参与，也不挡路', () => {
  const r = run([-1, P(1, 1)], [STAY, E]);
  assert.deepEqual(r.moved, [false, true]);
  assert.equal(r.reason[0], 'off');
});

test('长链撞上停留者：迭代到不动点后整串不动', () => {
  // A→B→C→D(STAY)
  const r = assertOrderIndependent([P(3, 4), P(2, 4), P(1, 4), P(4, 4)], [E, E, E, STAY]);
  assert.deepEqual(r.moved, [false, false, false, false]);
});
