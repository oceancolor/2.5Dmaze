// 阶段 2 渲染侧：输入映射（O7 两套）、L11（过渡末帧 = 静止画面，宝物落地才消失 / 出现）、K13（降级实测 drawOps 下降）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { dirOfCode, MAPPINGS } from '../src/player/input.js';
import { createScheduler } from '../src/app/scheduler.js';
import { settledEntities, transitionEntities, LAND, moveProgress } from '../src/render/scene.js';
import { createRenderer, createFrameMonitor, QUALITY } from '../src/render/renderer.js';
import { createAnimator } from '../src/render/animator.js';
import { tileCenter } from '../src/render/iso.js';

const CFG = makeConfig();

test('输入映射：网格 / 屏幕两套，斜向键与原地等待不随映射变', () => {
  assert.equal(dirOfCode('ArrowUp', 'grid'), 'N');
  assert.equal(dirOfCode('KeyD', 'grid'), 'E');
  assert.equal(dirOfCode('ArrowUp', 'screen'), MAPPINGS.screen.up);
  assert.equal(dirOfCode('ArrowRight', 'screen'), MAPPINGS.screen.right);
  for (const m of Object.keys(MAPPINGS)) {
    assert.equal(dirOfCode('Space', m), 'STAY');
    assert.equal(dirOfCode('KeyQ', m), dirOfCode('KeyQ', 'grid'));
    assert.equal(dirOfCode('KeyX', m), null);
    const four = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].map((k) => dirOfCode(k, m));
    assert.deepEqual([...four].sort(), ['E', 'N', 'S', 'W'], `${m}：四个箭头各管一个方向`);
  }
});

test('位移进度单调，落地时刻到位', () => {
  let prev = -1;
  for (let u = 0; u <= 1; u += 0.01) {
    const p = moveProgress(u);
    assert.ok(p >= prev);
    prev = p;
  }
  assert.equal(moveProgress(LAND), 1);
  assert.equal(moveProgress(0), 0);
});

const norm = (list) => list
  .map((e) => (e.kind === 'actor' ? `a${e.seat}@${e.to[0]},${e.to[1]}` : e.kind === 'ghost' ? `g${e.seat}@${e.x},${e.y}` : `${e.kind}${e.c ?? ''}@${e.x},${e.y}`))
  .sort();

test('L11：每回合过渡末帧与结算后静止画面逐项一致；拾取的宝物落地前还在、落地后消失（玩家视角 + 上帝视角，多种子）', () => {
  let pickups = 0;
  let respawns = 0;
  for (const seed of [2, 8, 31]) {
    const s = createScheduler(CFG, seed, { manual: false });
    s.on('turn', (last) => {
      for (const view of [{ viewer: 0, god: false }, { viewer: 0, god: true }]) {
        const atEnd = transitionEntities(s.map, CFG, last, view, 1, 1);
        assert.deepEqual(norm(atEnd), norm(settledEntities(s.map, CFG, last.next, view)), `T${last.n} 末帧`);
        const almost = transitionEntities(s.map, CFG, last, view, 0.999, 0.999);
        const props = (list) => norm(list).filter((k) => k[0] !== 'a' && k[0] !== 'g');
        assert.deepEqual(props(almost), props(settledEntities(s.map, CFG, last.next, view)), `T${last.n} 落地后宝物与静止一致`);
      }
      const god = { viewer: 0, god: true };
      for (const e of last.events) {
        if (e.type === 'pickup') {
          pickups++;
          const before = transitionEntities(s.map, CFG, last, god, LAND - 0.01, 0.5);
          assert.ok(before.some((x) => x.kind === 'gem' && x.x === e.x && x.y === e.y), '落地前宝石还在');
          const after = transitionEntities(s.map, CFG, last, god, LAND, 0.9);
          assert.ok(!after.some((x) => x.kind === 'gem' && x.x === e.x && x.y === e.y), '落地后宝石消失');
        }
        if (e.type === 'gemRespawn') respawns++;
      }
    });
    s.runSync(0, 5000);
    assert.ok(s.state.ended);
  }
  assert.ok(pickups > 10);
  assert.ok(respawns > 0);
});

/** 万能假 2D 上下文：任何属性 / 调用都返回自己（渐变、measureText 链式调用都不炸）。 */
const stub = new Proxy(function stubFn() {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : stub),
  apply: () => stub,
  set: () => true,
});
const fakeCanvas = (w = 0, h = 0) => ({ width: w, height: h, style: {}, getContext: () => stub });
const fakeAtlas = { draw: () => 1, has: () => true };

test('K13：注入 60 帧慢帧 → stepDown 被调用，且同一画面实测 drawOps 下降 ≥15%', () => {
  const s = createScheduler(CFG, 13, { manual: false });
  s.runSync(0, 30);
  const animator = createAnimator({ map: s.map, cfg: CFG, playerSeat: 0 });
  const renderer = createRenderer({ canvas: fakeCanvas(), map: s.map, cfg: CFG, atlas: fakeAtlas, makeCanvas: fakeCanvas });
  renderer.resize(1600, 900, 2);
  const me = s.state.actors[0];
  const [cx, cy] = tileCenter(me.x, me.y);
  const camera = { zoom: CFG.render.zoomLevels[0], x: cx, y: cy, overview: false };
  const t = 1e6;
  const draw = () => {
    const fr = animator.frame(t, { state: s.state, last: s.last, view: { viewer: 0, god: true }, quality: renderer.quality });
    return { ...renderer.render(fr, camera, t, 0) };
  };

  assert.equal(renderer.quality, QUALITY.length - 1, '默认最高档');
  const before = draw();
  assert.ok(before.drawOps > 0 && before.chunks > 0 && before.items > 0);

  let trips = 0;
  const mon = createFrameMonitor({ onTrip: () => { trips++; renderer.stepDown(); } });
  for (let k = 0; k < 59; k++) mon.sample(20);
  assert.equal(trips, 0, '59 帧不触发');
  mon.sample(12);
  for (let k = 0; k < 59; k++) mon.sample(20);
  assert.equal(trips, 0, '中间夹一帧快帧要重新计数');
  mon.sample(20);
  assert.equal(trips, 1, '连续 60 帧 > 16.7 ms 触发');
  assert.equal(renderer.quality, QUALITY.length - 2);

  const after = draw();
  assert.equal(after.items, before.items, '画的东西不变，只是画法变便宜');
  assert.ok(after.drawOps <= before.drawOps * 0.85, `drawOps ${before.drawOps} → ${after.drawOps}，需下降 ≥15%`);
  assert.ok(renderer.renderScale === 1, 'L1 按 1× 渲染');

  renderer.stepDown();
  const floor = draw();
  assert.ok(floor.drawOps <= after.drawOps, '最低档不比上一档贵');
  assert.equal(renderer.stepDown(), false, '已到最低档');
});
