import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from './helpers.mjs';
import { scoreFromParts, setsOf, rankActors } from '../src/core/scoring.js';

test('计分：红2 黄2 绿3 蓝3 紫1 = 11 + 5×1 = 16（用户裁定 U1 的例子）', () => {
  assert.equal(setsOf([2, 2, 3, 3, 1]), 1);
  assert.equal(scoreFromParts([2, 2, 3, 3, 1], 0, CFG), 16);
});

test('计分：不成套只算单颗；整套另加 5；宝箱分直接加', () => {
  assert.equal(scoreFromParts([0, 0, 0, 0, 0], 0, CFG), 0);
  assert.equal(scoreFromParts([3, 0, 1, 0, 0], 0, CFG), 4);
  assert.equal(scoreFromParts([1, 1, 1, 1, 1], 0, CFG), 10);
  assert.equal(scoreFromParts([2, 2, 2, 2, 2], 3, CFG), 10 + 10 + 3);
});

const actor = (seat, o) => ({
  seat, status: 'escaped', gems: [0, 0, 0, 0, 0], chestScore: 0, stamina: 100, escapedTurn: 300, moves: 300, ...o,
});

test('排名：达成者永远在未达成者之前，哪怕分数更低', () => {
  const r = rankActors([
    actor(0, { status: 'failed', gems: [3, 3, 3, 3, 3] }),
    actor(1, { gems: [1, 0, 0, 0, 0] }),
  ], CFG);
  assert.deepEqual(r.map((x) => x.seat), [1, 0]);
  assert.equal(r[0].champion, true);
  assert.equal(r[1].champion, false);
});

test('排名：分数 > 剩余体力 > 达成回合早', () => {
  const r = rankActors([
    actor(0, { gems: [1, 0, 0, 0, 0], stamina: 50, escapedTurn: 200 }),
    actor(1, { gems: [1, 0, 0, 0, 0], stamina: 50, escapedTurn: 190 }),
    actor(2, { gems: [1, 0, 0, 0, 0], stamina: 80, escapedTurn: 250 }),
    actor(3, { gems: [2, 0, 0, 0, 0], stamina: 1, escapedTurn: 400 }),
  ], CFG);
  assert.deepEqual(r.map((x) => x.seat), [3, 2, 1, 0]);
  assert.deepEqual(r.map((x) => x.place), [1, 2, 3, 4]);
});

test('排名：未达成者按 分数 > 体力 > 移动步数少', () => {
  const r = rankActors([
    actor(0, { status: 'failed', stamina: 0, moves: 400 }),
    actor(1, { status: 'failed', stamina: 0, moves: 350 }),
    actor(2, { status: 'failed', stamina: 20, moves: 600 }),
  ], CFG);
  assert.deepEqual(r.map((x) => x.seat), [2, 1, 0]);
  assert.ok(r.every((x) => !x.champion), '全员未达成 → 无冠军');
});

test('排名：完全并列 → 并列名次、并列冠军', () => {
  const r = rankActors([actor(0), actor(1)], CFG);
  assert.deepEqual(r.map((x) => x.place), [1, 1]);
  assert.ok(r.every((x) => x.champion));
});
