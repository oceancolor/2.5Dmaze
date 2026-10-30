// 场外布景（docs/03 §15）：确定性摆放 + 不压地图一格 + 图集缺失时安全退回。
// 用假图集（只提供 box），不碰 canvas —— 断言的是摆放表，与像素无关。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, lowEdgeY, CLIFF } from '../src/render/env.js';
import { HALF_W, HALF_H } from '../src/render/iso.js';

// 高度取自 assets/atlas/env.json（1× 帧高 / 锚点以上的部分），按 sprite 类型给近似包围盒
const BOX = {
  TREE01: { l: -21, r: 21, t: 52, b: 6 },
  TREE02: { l: -18, r: 18, t: 34, b: 5 },
  TREE03: { l: -14, r: 14, t: 22, b: 4 },
  TREE04: { l: -20, r: 20, t: 44, b: 5 },
  PINE01: { l: -13, r: 13, t: 50, b: 5 },
  BUSH01: { l: -14, r: 14, t: 18, b: 4 },
  BUSH02: { l: -13, r: 13, t: 15, b: 3 },
  ROCK01: { l: -11, r: 11, t: 10, b: 4 },
  CABIN01: { l: -37, r: 37, t: 49, b: 19 },
  CABIN02: { l: -33, r: 33, t: 52, b: 16 },
  TOWER01: { l: -22, r: 22, t: 76, b: 10 },
  STONES01: { l: -18, r: 18, t: 20, b: 6 },
  STONES02: { l: -16, r: 16, t: 30, b: 6 },
  JADE01: { l: -17, r: 17, t: 40, b: 6 },
  JADE02: { l: -15, r: 15, t: 34, b: 6 },
  CLIFF_SW01: { l: -34, r: 34, t: 3, b: 48 },
  CLIFF_SW02: { l: -34, r: 34, t: 3, b: 48 },
  CLIFF_SW03: { l: -34, r: 34, t: 3, b: 48 },
  CLIFF_SE01: { l: -5, r: 38, t: 3, b: 48 },
  CLIFF_SE02: { l: -5, r: 38, t: 3, b: 48 },
  CLIFF_SE03: { l: -5, r: 38, t: 3, b: 48 },
  CLIFF_S: { l: -38, r: 38, t: 3, b: 46 },
};

const boxOf = (name) => {
  const k = name.replace(/^ENV_/, '').replace(/_na_00$/, '').replace(/(CLIFF_(?:SW|SE)\d|CLIFF_S)$/, (m) => m);
  const key = BOX[k] ?? BOX[k.replace(/\d+$/, '')] ?? BOX[k.slice(0, -2)] ?? null;
  assert.ok(key, `测试缺 ${name} 的包围盒`);
  return key;
};

const SIZE = 128;
const plan = buildPlan(SIZE, boxOf);

test('摆放表：确定性（同尺寸两次生成逐项相同）', () => {
  const again = buildPlan(SIZE, boxOf);
  assert.deepEqual(again.back.map((i) => i.name), plan.back.map((i) => i.name));
  assert.deepEqual(again.front.map((i) => [i.name, i.wx, i.wy]), plan.front.map((i) => [i.name, i.wx, i.wy]));
  assert.deepEqual(again.cliffs, plan.cliffs);
});

test('土崖：两条前沿各 N−1 段 + 南角，按行序（后一段压前一段）', () => {
  assert.equal(plan.cliffs.length, 2 * (SIZE - 1) + 1);
  for (let i = 1; i < plan.cliffs.length; i++) assert.ok(plan.cliffs[i].depth >= plan.cliffs[i - 1].depth, '行序不减');
  assert.equal(plan.cliffs[plan.cliffs.length - 1].name, 'ENV_CLIFF_S_na_00');
});

test('不压地图一格：前方每一件（含地标重叠回退后）的剪影顶都在菱形下边线 + CLIFF 的 60% 之下', () => {
  const limit = Math.round(CLIFF * 0.6);
  for (const it of plan.front) {
    const b = boxOf(it.name);
    // 区间内离菱形中轴最近的点 = 下边线最低处（最容易被越过的位置）
    const xm = Math.min(Math.max(0, it.wx + b.l), it.wx + b.r);
    assert.ok(it.wy - b.t >= lowEdgeY(SIZE, xm) + limit, `${it.name} 在 (${it.wx.toFixed(1)}, ${it.wy.toFixed(1)}) 越线`);
  }
});

test('前方布景只出现在菱形下侧（x 或 y 越界的那两条边）', () => {
  // 前方 = 网格 gx≥N 或 gy≥N 的一侧（朝镜头的 SW / SE），世界坐标上就是菱形下半部
  for (const it of plan.front) {
    assert.ok(it.wy > 0, `${it.name} 应在下半区`);
  }
});

test('地标：全部在后方（菱形上侧），且玉石在两处空地附近', () => {
  const marks = plan.back.filter((it) => /^ENV_(CABIN|TOWER|STONES|JADE)/.test(it.name));
  assert.equal(marks.length, 10, `地标应有 10 件，实际 ${marks.length}`);
  for (const it of marks) assert.ok(it.wy < SIZE * 2 * HALF_H - 200, `${it.name} 应在后方`);
  assert.equal(plan.glows.length, 2);
  assert.ok(plan.glows.every((g) => g.name.startsWith('ENV_JADE')));
});

test('林带有界：只铺到菱形外 RING 格', () => {
  // 世界坐标 wx = (gx − gy)·32，gx、gy 都在 [−RING, N+RING)，所以 |wx| ≤ (N + 2·RING)·32（再多一个抖动）
  const lim = (SIZE + 2 * 14) * HALF_W + 64;
  for (const it of [...plan.back, ...plan.front]) {
    assert.ok(Math.abs(it.wx) <= lim, `${it.name} 的 x 超界：${it.wx}`);
    assert.ok(Math.abs(it.wy) <= lim + 2 * HALF_H, `${it.name} 的 y 超界：${it.wy}`);
  }
});

test('图集缺失时 createEnvScene 安全跳过（场外退回纯底色）', async () => {
  const { createEnvScene } = await import('../src/render/env.js');
  const none = createEnvScene({ atlas: null, size: SIZE });
  assert.equal(none.ready, false);
  assert.equal(none.drawBack({}, 1, 0, 0, 100, 100), 0);
  assert.equal(none.drawFront({}, 1, 0, 0, 100, 100), 0);

  // 图集里没有 ENV_ 帧（例如误传了 pilot 图集）：同样安全跳过，不抛
  const wrong = createEnvScene({ atlas: { has: () => false }, size: SIZE });
  assert.equal(wrong.drawBack({}, 1, 0, 0, 100, 100), 0);
});
