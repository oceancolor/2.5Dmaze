import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../tools/art/png.mjs';
import { createCatalog, catalogCsv, describe, SCENES } from '../tools/gallery/env-catalog.js';
import { MAP_SIZE_IDS, MAP_SIZES } from '../src/config/map-sizes.js';
import { buildPlan } from '../src/render/env.js';

const manifest = JSON.parse(readFileSync(new URL('../assets/atlas/env.json', import.meta.url), 'utf8'));
const image = decodePNG(readFileSync(new URL(`../assets/atlas/${manifest.file}`, import.meta.url)));
const boxes = new Map();
const atlas = {
  names: () => Object.keys(manifest.frames),
  frame: (n) => manifest.frames[n],
  box(n) {
    if (boxes.has(n)) return boxes.get(n);
    const f = manifest.frames[n];
    if (!f) throw new Error(`missing ${n}`);
    let l = f.w, r = -1, top = f.h, bottom = -1;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      if (image.data[((f.y + y) * image.width + f.x + x) * 4 + 3] <= 16) continue;
      l = Math.min(l, x); r = Math.max(r, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const b = r < l ? { l: 0, r: 0, t: 0, b: 0 } : { l: l - f.ax, r: r + 1 - f.ax, t: f.ay - top, b: bottom + 1 - f.ay };
    boxes.set(n, b);
    return b;
  },
};

test('场外资产目录：五种规格的类型 / 数量 / 每个坐标与运行时摆放表一致', () => {
  for (const id of MAP_SIZE_IDS) {
    const size = MAP_SIZES[id].size;
    const c = createCatalog(atlas, size);
    const p = buildPlan(size, atlas.box);
    const sprites = c.assets.filter((a) => a.kind === 'sprite');
    assert.equal(sprites.length, Object.keys(manifest.frames).length);
    assert.equal(sprites.reduce((n, a) => n + a.count, 0), p.back.length + p.front.length + p.cliffs.length);
    const normalized = ['back', 'front', 'cliffs'].flatMap((layer) => p[layer].map((it) => [it.name, ...(it.at || [it.wx, it.wy]), layer]));
    assert.deepEqual(c.placements.map((it) => [it.name, it.wx, it.wy, it.layer]), normalized);
    for (const a of sprites) {
      assert.equal(a.count, a.instances.length);
      assert.equal(a.scenes.reduce((n, [, v]) => n + v, 0), a.count);
      assert.ok(a.instances.every((it) => SCENES[it.scene] && Number.isFinite(it.gx) && Number.isFinite(it.gy)));
    }
    assert.equal(c.assets.find((a) => a.name === 'GROUND_plaza').count, 2);
    assert.equal(c.assets.find((a) => a.name === 'GROUND_path').count, 2);
    assert.equal(c.assets.find((a) => a.name === 'GROUND_meadow').count, 1);
    assert.equal(c.assets.find((a) => a.name === 'CONTACT_SHADOW').count, p.back.length + p.front.length);
    assert.equal(c.assets.find((a) => a.name === 'GIANT_GLOW').count, p.glows.length);
  }
});

test('场外资产目录：古镇 / 村落 / 遗迹归属明确，CSV 导出不漏实例', () => {
  const c = createCatalog(atlas, 16);
  const tower = c.assets.find((a) => a.key === 'TOWERE');
  assert.deepEqual(tower.scenes, [['east', 1]]);
  assert.deepEqual(c.assets.find((a) => a.key === 'CASTLE').scenes, [['west', 1]]);
  assert.deepEqual(c.assets.find((a) => a.key === 'GIANTHEAD').scenes, [['giant', 1]]);
  const csv = catalogCsv(c);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('左上 · 东方古镇'));
  assert.equal(csv.split('\r\n').length, 1 + c.assets.reduce((n, a) => n + Math.max(1, a.instances.length), 0));
  assert.equal(describe('ENV_CLIFF_SW02_na_00').category, '地形');
});
