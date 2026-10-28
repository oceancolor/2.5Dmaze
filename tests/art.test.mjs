// 美术管线的纯 JS 部分（不需要 Blender）：PNG 编解码往返、线性空间缩小、阴影贴片后处理、图集清单完整性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { decodePNG, encodePNG } from '../tools/art/png.mjs';
import { downsample, treatShadow, SHADOW_FX } from '../tools/art/pack.mjs';

function pattern(w, h) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = (x * 37) & 255;
    d[o + 1] = (y * 53) & 255;
    d[o + 2] = (x * y) & 255;
    d[o + 3] = (x + y) % 3 ? 255 : (x * 11) & 255;
  }
  return d;
}

test('PNG 编码 → 解码逐字节一致', () => {
  const w = 37;
  const h = 23;
  const src = pattern(w, h);
  const img = decodePNG(encodePNG(w, h, src));
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.deepEqual(Buffer.from(img.data), Buffer.from(src));
});

test('缩小：全不透明纯色保持原色；半覆盖像素 alpha 减半且颜色不被透明黑拉暗', () => {
  const w = 4;
  const h = 4;
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([200, 100, 50, 255], i * 4);
  const solid = downsample({ width: w, height: h, data: d }, 4);
  assert.deepEqual([...solid.data], [200, 100, 50, 255]);
  for (let i = 0; i < 8; i++) d.set([0, 0, 0, 0], i * 4);
  const half = downsample({ width: w, height: h, data: d }, 4);
  assert.deepEqual([...half.data], [200, 100, 50, 128]);
});

test('阴影贴片：贴边 alpha 归零、极淡底噪被去掉、强度封顶', () => {
  const w = 40;
  const h = 40;
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = 3; // 天空遮蔽底噪
  for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) d[(y * w + x) * 4 + 3] = 255;
  const out = treatShadow({ width: w, height: h, data: d }, 1).data;
  const a = (x, y) => out[(y * w + x) * 4 + 3];
  assert.equal(a(0, 0), 0);
  assert.equal(a(5, 20), 0);
  assert.equal(a(20, 20), SHADOW_FX.cap);
});

test('已入库图集：清单帧都在图内，锚点在帧内，1× 与 @2x 帧集合一致', { skip: !existsSync('assets/atlas/pilot.json') }, () => {
  const m1 = JSON.parse(readFileSync('assets/atlas/pilot.json', 'utf8'));
  const m2 = JSON.parse(readFileSync('assets/atlas/pilot@2x.json', 'utf8'));
  assert.deepEqual(Object.keys(m1.frames).sort(), Object.keys(m2.frames).sort());
  for (const m of [m1, m2]) {
    const img = decodePNG(readFileSync(`assets/atlas/${m.file}`));
    assert.deepEqual([img.width, img.height], m.size);
    for (const [name, f] of Object.entries(m.frames)) {
      assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= img.width && f.y + f.h <= img.height, `${name} 越界`);
      assert.ok(f.ax >= 0 && f.ax <= f.w && f.ay >= 0 && f.ay <= f.h, `${name} 锚点越界`);
    }
  }
});
