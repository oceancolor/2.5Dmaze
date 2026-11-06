// 小地图尺寸分档（2026-11-05 批次 1）：按规格分档、随规格单调变大；窗口小时按可用空间缩小。
import test from 'node:test';
import assert from 'node:assert/strict';

import { SIDE_BY_SIZE, sideFor, targetSide } from '../src/ui/minimap.js';
import { MAP_SIZES, MAP_SIZE_IDS } from '../src/config/map-sizes.js';

test('每个规格都有一档；XS 每格不超过 10 px、XL 每格不少于 3 px；边长随规格单调变大', () => {
  const sides = MAP_SIZE_IDS.map((id) => targetSide(MAP_SIZES[id].size));
  for (let i = 1; i < sides.length; i++) assert.ok(sides[i] > sides[i - 1], JSON.stringify(sides));
  assert.ok(targetSide(16) / 16 <= 10, `XS ${targetSide(16) / 16} px/格`);
  assert.ok(targetSide(128) / 128 >= 3, `XL ${targetSide(128) / 128} px/格`);
  for (const id of MAP_SIZE_IDS) assert.ok(SIDE_BY_SIZE[MAP_SIZES[id].size], `${id} 有专门一档`);
});

test('窗口够大时用目标边长；窗口小时按可用空间缩小，但不小于下限', () => {
  assert.equal(sideFor(128, 2560, 1440), targetSide(128));
  assert.ok(sideFor(128, 1440, 900) <= 900 * 0.42 + 1);
  assert.ok(sideFor(128, 1280, 720) < targetSide(128));
  assert.ok(sideFor(128, 400, 300) >= 120);
  assert.equal(sideFor(16, 1280, 720), targetSide(16), 'XS 本来就小，不再缩');
});
