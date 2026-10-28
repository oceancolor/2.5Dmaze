import test from 'node:test';
import assert from 'node:assert/strict';
import { smallRoom } from './helpers.mjs';
import { step } from '../src/core/game.js';
import { stateHash } from '../src/core/hash.js';

const ONLY0 = [true, false, false, false];
const types = (r) => r.events.map((e) => e.type);

test('零扣费：停留、撞墙、被挡都不扣体力；只有成功位移扣 1', () => {
  const { map, state, cfg } = smallRoom({ spawns: [[1, 1], [2, 1], [6, 6], [1, 6]], active: [true, true, false, false] });
  const s0 = state.actors[0].stamina;
  // 座位 0 向北撞墙，座位 1 停留
  let r = step(map, state, ['N', 'STAY'], cfg);
  assert.equal(r.state.actors[0].stamina, s0);
  assert.equal(r.state.actors[1].stamina, s0);
  assert.ok(types(r).includes('bump'));
  // 座位 0 向东顶停留的座位 1：被挡，不扣
  r = step(map, r.state, ['E', 'STAY'], cfg);
  assert.equal(r.state.actors[0].stamina, s0);
  assert.equal(r.state.actors[0].x, 1);
  assert.ok(r.events.some((e) => e.type === 'blocked' && e.seat === 0));
  // 成功位移扣 1、moves+1
  r = step(map, r.state, ['S', 'STAY'], cfg);
  assert.equal(r.state.actors[0].stamina, s0 - 1);
  assert.equal(r.state.actors[0].moves, 1);
  assert.deepEqual([r.state.actors[0].x, r.state.actors[0].y], [1, 2]);
});

test('step 是纯函数：不修改 prev', () => {
  const { map, state, cfg } = smallRoom();
  const h = stateHash(state);
  step(map, state, ['E', 'W', 'N', 'S'], cfg);
  assert.equal(stateHash(state), h);
});

test('非法意图 → invalidIntent 事件并按停留处理', () => {
  const { map, state, cfg } = smallRoom({ active: ONLY0 });
  const r = step(map, state, ['jump'], cfg);
  assert.deepEqual(types(r).filter((t) => t === 'invalidIntent'), ['invalidIntent']);
  assert.equal(r.state.actors[0].x, 1);
  assert.equal(r.state.actors[0].stamina, state.actors[0].stamina);
});

test('体力 1 时最后一步正好踩上自己出口 → 达成，不算失败', () => {
  const { map, state, cfg } = smallRoom({ spawns: [[6, 3], [6, 1], [6, 6], [1, 6]], active: ONLY0 });
  state.actors[0].stamina = 1;
  const r = step(map, state, ['E'], cfg);
  const a = r.state.actors[0];
  assert.equal(a.status, 'escaped');
  assert.equal(a.stamina, 0);
  assert.ok(r.state.ended);
});

test('踩上别人的出口不算达成', () => {
  // 座位 0 的出口在 (7,3)；(0,3) 是座位 1 的出口
  const { map, state, cfg } = smallRoom({ spawns: [[1, 3], [6, 1], [6, 6], [1, 6]], active: ONLY0 });
  const r = step(map, state, ['W'], cfg);
  assert.equal(r.state.actors[0].status, 'active');
});

test('体力 1 走一步落在普通格 → 体力耗尽失败', () => {
  const { map, state, cfg } = smallRoom({ active: ONLY0 });
  state.actors[0].stamina = 1;
  const r = step(map, state, ['E'], cfg);
  assert.equal(r.state.actors[0].status, 'failed');
  assert.equal(r.state.actors[0].failReason, 'stamina');
});

test('体力归零那一步踩上宝箱：先判失败，宝箱不开、不续命', () => {
  const { map, state, cfg } = smallRoom({ active: ONLY0, chest: { x: 2, y: 1 } });
  state.actors[0].stamina = 1;
  const r = step(map, state, ['E'], cfg);
  assert.equal(r.state.actors[0].status, 'failed');
  assert.equal(r.state.chest.present, true);
  assert.ok(!types(r).includes('chest'));
});

test('拾取宝石：宝石移除、计入颜色、向所有人广播位置', () => {
  const { map, state, cfg } = smallRoom({ gems: [{ c: 4, x: 2, y: 1 }] });
  const r = step(map, state, ['E', 'STAY', 'STAY', 'STAY'], cfg);
  assert.equal(r.state.gems.length, 0);
  assert.deepEqual(r.state.actors[0].gems, [0, 0, 0, 0, 1]);
  const ev = r.events.find((e) => e.type === 'pickup');
  assert.deepEqual([ev.seat, ev.color, ev.x, ev.y], [0, 4, 2, 1]);
  for (const j of [1, 2, 3]) assert.deepEqual(r.state.memory[j][0].slice(0, 2), [2, 1]);
});

test('开宝箱：得分或体力（体力不超过上限），宝箱消失', () => {
  const { map, state, cfg } = smallRoom({ active: ONLY0, chest: { x: 2, y: 1 } });
  const r = step(map, state, ['E'], cfg);
  const a = r.state.actors[0];
  const ev = r.events.find((e) => e.type === 'chest');
  assert.ok(ev);
  assert.equal(r.state.chest.present, false);
  assert.ok(a.stamina <= a.staminaMax);
  if (ev.kind === 'score') assert.equal(a.chestScore, ev.value);
  else assert.equal(a.chestStamina, ev.gained);
});

test('回合上限：到点仍在场者判 maxTurns 失败、对局结束', () => {
  const { map, state, cfg } = smallRoom({ active: [true, true, false, false] });
  state.turn = cfg.rules.maxTurns;
  const r = step(map, state, ['STAY', 'STAY'], cfg);
  assert.ok(r.state.ended);
  assert.equal(r.state.endTurn, cfg.rules.maxTurns);
  assert.ok(r.state.actors.slice(0, 2).every((a) => a.status === 'failed' && a.failReason === 'maxTurns'));
});

test('结束后再 step 抛错', () => {
  const { map, state, cfg } = smallRoom({ active: [false, false, false, false] });
  state.ended = true;
  assert.throws(() => step(map, state, [], cfg));
});
