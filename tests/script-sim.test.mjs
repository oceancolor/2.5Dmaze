// api.sim.step：单回合推演与真实结算 step() 一致；不预知开箱结果与刷新位置；视野外对手默认不参与；非法输入报错。
import test from 'node:test';
import assert from 'node:assert/strict';

import { smallRoom, CFG } from './helpers.mjs';
import { observe } from '../src/core/observe.js';
import { step } from '../src/core/game.js';
import { createSim } from '../src/player/runtime/sim.js';

function setup(opts = {}) {
  const h = smallRoom(opts);
  const sim = createSim({ map: h.map, cfg: CFG });
  const obs = (seat = 0) => observe(h.map, h.state, seat, CFG, { patch: false, events: [] });
  return { ...h, sim, obs };
}

test('与真实 step() 一致：默认局面 + 同一组移动 → 位置、体力、移动与否相同', () => {
  const { map, state, sim, obs } = setup();
  const moves = ['E', 'S', 'W', 'N'];
  const r = sim(obs(0), {}, moves);
  const real = step(map, state, moves, CFG).state;
  for (let i = 0; i < 4; i++) {
    assert.equal(r.actors[i].x, real.actors[i].x);
    assert.equal(r.actors[i].y, real.actors[i].y);
    assert.equal(r.actors[i].stamina, real.actors[i].stamina);
  }
  assert.equal(r.turn, state.turn + 1);
});

test('同格冲突：两人想进同一格 → 都不动、事件 blocked(contest)', () => {
  const { sim, obs } = setup();
  const r = sim(obs(0), { actors: { 0: { x: 1, y: 2 }, 1: { x: 3, y: 2 } } }, { 0: 'E', 1: 'W' });
  assert.equal(r.actors[0].moved, false);
  assert.equal(r.actors[1].moved, false);
  assert.ok(r.events.some((e) => e.type === 'blocked' && e.seat === 0 && e.reason === 'contest'));
});

test('对穿：两人互换位置 → 都不动；链式跟进 → 都动', () => {
  const { sim, obs } = setup();
  const swap = sim(obs(0), { actors: { 0: { x: 2, y: 2 }, 1: { x: 3, y: 2 } } }, { 0: 'E', 1: 'W' });
  assert.equal(swap.actors[0].moved || swap.actors[1].moved, false);
  const chain = sim(obs(0), { actors: { 0: { x: 2, y: 2 }, 1: { x: 3, y: 2 } } }, { 0: 'E', 1: 'E' });
  assert.equal(chain.actors[0].moved && chain.actors[1].moved, true);
  assert.equal(chain.actors[0].x, 3);
});

test('体力：撞墙不扣；体力归零出局；最后一步踩上自己出口算到达', () => {
  const { sim, obs } = setup();
  const wall = sim(obs(0), { actors: { 0: { x: 1, y: 1 } } }, { 0: 'N' });
  assert.equal(wall.actors[0].stamina, obs(0).self.stamina, '撞墙不扣体力');
  const dead = sim(obs(0), { actors: { 0: { x: 2, y: 2, stamina: 1 } } }, { 0: 'E' });
  assert.equal(dead.actors[0].status, 'failed');
  const home = sim(obs(0), { actors: { 0: { x: 6, y: 3, stamina: 1 } } }, { 0: 'E' });
  assert.equal(home.actors[0].status, 'escaped', '最后一步踩上出口（座位 0 出口 (7,3)）');
});

test('拾取：事件 + 宝石消失；拿空且还能刷新 → 只给 respawn 标记，不给新位置', () => {
  const { sim, obs } = setup({ gems: [{ c: 2, x: 2, y: 2 }] });
  const o = obs(0);
  const r = sim(o, { actors: { 0: { x: 1, y: 2 } }, gemRespawnsLeft: 1 }, { 0: 'E' });
  assert.ok(r.events.some((e) => e.type === 'pickup' && e.seat === 0 && e.color === 2));
  assert.equal(r.actors[0].gems[2], 1);
  assert.deepEqual(r.gems, []);
  assert.deepEqual(r.respawn, { gems: true });
  assert.equal(r.events.some((e) => e.type === 'gemRespawn'), false, '不预知刷新位置');
});

test('开箱：只给两个分支与概率；推演结果是开箱前的分数 / 体力', () => {
  const { sim, obs } = setup({ chest: { x: 2, y: 1 } });
  const o = obs(0);
  const r = sim(o, { actors: { 0: { x: 1, y: 1, stamina: 100 } } }, { 0: 'E' });
  const e = r.events.find((x) => x.type === 'chest');
  assert.ok(e && Array.isArray(e.branches) && e.branches.length === 2);
  assert.equal(e.branches[0].p + e.branches[1].p, 1);
  assert.deepEqual(e.branches.map((b) => b.kind), ['score', 'stamina']);
  assert.equal(e.value, undefined);
  assert.equal(r.actors[0].stamina, 99, '只扣了这一步');
  assert.equal(r.actors[0].chestScore, 0);
  assert.equal(r.chest.present, false);
});

test('视野外的对手默认不参与；给了假设位置才参与；结果可以当作下一次的 belief', () => {
  const { sim, obs } = setup();
  const o = obs(0);
  o.actors = o.actors.map((a) => (a.seat === 2 ? { ...a, visible: false, x: undefined, y: undefined, lastSeen: { x: 6, y: 6, turnsSince: 5 } } : a));
  const r = sim(o, {}, { 0: 'E' });
  assert.equal(r.actors[2].known, false);
  const r2 = sim(o, { actors: [{ seat: 2, x: 5, y: 6 }] }, { 2: 'W' });
  assert.equal(r2.actors[2].known, true);
  assert.equal(r2.actors[2].x, 4);
  const r3 = sim(o, r2, { 0: 'E' });
  assert.equal(r3.turn, r2.turn + 1, '结果可直接串成多步');
});

test('非法输入报错：位置重叠、在墙里、移动不是 N/E/S/W/STAY、seat 越界', () => {
  const { sim, obs } = setup();
  const o = obs(0);
  assert.throws(() => sim(o, { actors: { 0: { x: 2, y: 2 }, 1: { x: 2, y: 2 } } }, {}), /重叠/);
  assert.throws(() => sim(o, { actors: { 0: { x: 0, y: 0 } } }, {}), /是墙/);
  assert.throws(() => sim(o, {}, { 0: 'UP' }), /不是 N\/E\/S\/W\/STAY/);
  assert.throws(() => sim(o, { actors: [{ seat: 7, x: 1, y: 1 }] }, {}), /seat/);
});
