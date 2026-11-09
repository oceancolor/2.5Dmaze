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
  MAPLE: { l: -21, r: 21, t: 50, b: 6 },
  // 2026-11-09 大景（近似 1× 包围盒）
  TOWERE: { l: -45, r: 50, t: 205, b: 30 },
  HOUSEE: { l: -70, r: 70, t: 90, b: 40 },
  STALL: { l: -20, r: 20, t: 32, b: 12 },
  CASTLE: { l: -80, r: 80, t: 230, b: 45 },
  HOUSEW: { l: -55, r: 55, t: 100, b: 35 },
  FOLK: { l: -6, r: 6, t: 20, b: 4 },
  CART: { l: -24, r: 18, t: 18, b: 10 },
  VAN: { l: -30, r: 30, t: 34, b: 14 },
  CAR: { l: -24, r: 24, t: 24, b: 12 },
  GIANTHEAD: { l: -120, r: 120, t: 200, b: 40 },
  GIANTHAND: { l: -60, r: 60, t: 40, b: 30 },
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

test('大景（2026-11-09）：古镇 / 村落 / 巨像三处都在后方、落地点都在菱形之外；巨像眼有琥珀辉光', () => {
  for (const size of [16, 64, 128]) {
    const p = buildPlan(size, boxOf);
    const marks = p.back.filter((it) => /^ENV_(TOWERE|HOUSE|STALL|CASTLE|FOLK|CART|VAN|CAR|GIANT)/.test(it.name));
    assert.ok(marks.length >= 36, `${size}: 大景（不含树）应有 36 件以上，实际 ${marks.length}`);
    for (const it of marks) {
      // 菱形内部：|wx|/HALF_W + |wy − size·HALF_H|/HALF_H ≤ size
      const inside = Math.abs(it.wx) / HALF_W + Math.abs(it.wy - size * HALF_H) / HALF_H <= size;
      assert.ok(!inside, `${size}: ${it.name} 的落地点 (${it.wx.toFixed(0)}, ${it.wy.toFixed(0)}) 在地图里`);
      assert.ok(it.wy < size * HALF_H, `${size}: ${it.name} 应在上半区（后方）`);
    }
    assert.ok(p.glows.length === 1 && p.glows[0].name === 'ENV_GIANTHEAD_na_00');
    assert.ok(p.clearings.some((c) => c[4] === 'plaza') && p.clearings.some((c) => c[4] === 'meadow'));
  }
  // 图集里缺某件（旧图集）就跳过那件，不抛
  const partial = buildPlan(32, (n) => (/GIANT|CASTLE/.test(n) ? null : boxOf(n)));
  assert.ok(!partial.back.some((it) => /GIANT|CASTLE/.test(it.name)));
});

test('林带有界：只铺到菱形外 RING 格', () => {
  // 世界坐标 wx = (gx − gy)·32，gx、gy 都在 [−RING, N+RING)，所以 |wx| ≤ (N + 2·RING)·32（再多一个抖动）
  const lim = (SIZE + 2 * 20) * HALF_W + 64;
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
