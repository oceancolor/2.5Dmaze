// 图集打包：读 Blender 4× 原图 → 线性空间预乘 alpha 盒式缩小 → 架子式打包 → atlas PNG + manifest JSON。
// 同时出 1× 与 2× 两套（2× 供高分屏）。用法：node tools/art/pack.mjs [--name pilot]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW = join(ROOT, '.cache', 'art', 'raw');
export const ATLAS_DIR = join(ROOT, 'assets', 'atlas');

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const L2S = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  L2S[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** 整数倍缩小（线性光、预乘 alpha 的盒式滤波）。 */
export function downsample(img, f) {
  if (f === 1) return img;
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = new Uint8Array(w * h * 4);
  const src = img.data;
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < f; dy++) {
        let o = ((y * f + dy) * img.width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, o += 4) {
          const al = src[o + 3] / 255;
          if (!al) continue;
          r += S2L[src[o]] * al;
          g += S2L[src[o + 1]] * al;
          b += S2L[src[o + 2]] * al;
          a += al;
        }
      }
      const q = (y * w + x) * 4;
      const A = a / n;
      out[q + 3] = Math.round(A * 255);
      if (a > 0) {
        out[q] = L2S[Math.round((r / a) * 4096)];
        out[q + 1] = L2S[Math.round((g / a) * 4096)];
        out[q + 2] = L2S[Math.round((b / a) * 4096)];
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** 阴影贴片后处理参数：暖深色（≈ palette SHADOW 的 #3B362F 系）、去掉天空遮蔽的极淡长尾、边缘淡出、强度封顶。 */
export const SHADOW_FX = Object.freeze({ rgb: [52, 45, 38], floor: 6, cap: 150, fade: 8 });

/**
 * Shadow catcher 输出是 黑色 + alpha；天空遮蔽会给整张贴片铺一层 1–3 的极淡 alpha，贴片边界处被截断 → 场景里出现矩形边。
 * 处理：alpha 先减 floor，再乘边缘淡出（距边 < fade·scale 像素线性到 0），最后封顶到 cap；颜色统一为暖深色。
 */
export function treatShadow(img, scale, fx = SHADOW_FX) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(data.length);
  const fw = fx.fade * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const d = Math.min(x + 0.5, y + 0.5, w - x - 0.5, h - y - 0.5);
      const edge = Math.min(1, d / fw);
      const a = Math.min(fx.cap, Math.max(0, data[o + 3] - fx.floor) * edge * edge);
      out[o] = fx.rgb[0];
      out[o + 1] = fx.rgb[1];
      out[o + 2] = fx.rgb[2];
      out[o + 3] = Math.round(a);
    }
  }
  return { width: w, height: h, data: out };
}

/** 直通 alpha 的 over 合成（top 盖在 bottom 上），尺寸须一致。装饰本体 + 接触阴影合成一张用。 */
export function over(top, bottom) {
  const { width: w, height: h } = top;
  const out = new Uint8Array(w * h * 4);
  const t = top.data;
  const b = bottom.data;
  for (let o = 0; o < out.length; o += 4) {
    const at = t[o + 3] / 255;
    const ab = (b[o + 3] / 255) * (1 - at);
    const a = at + ab;
    out[o + 3] = Math.round(a * 255);
    if (a > 0) for (let k = 0; k < 3; k++) out[o + k] = Math.round((t[o + k] * at + b[o + k] * ab) / a);
  }
  return { width: w, height: h, data: out };
}

/** 架子式打包：按高度分组排行，宽度固定。 */
function shelfPack(items, width) {
  const sorted = [...items].sort((p, q) => q.h - p.h || p.name.localeCompare(q.name));
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of sorted) {
    if (x + it.w > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    it.x = x;
    it.y = y;
    x += it.w;
    rowH = Math.max(rowH, it.h);
  }
  return y + rowH;
}

/** filter(sprite) → 是否打进这套图集（阴影贴片的 under 引用不受 filter 影响，照样能取到）。 */
export function pack(name = 'pilot', { widths = { 1: 1024, 2: 2048 }, filter = () => true } = {}) {
  const index = JSON.parse(readFileSync(join(RAW, 'index.json'), 'utf8'));
  const ss = index.meta.ss;
  mkdirSync(ATLAS_DIR, { recursive: true });
  const picked = index.sprites.filter(filter);
  const ms = picked.map((s) => s.ms).sort((a, b) => a - b);
  const renderMs = { median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1], total: ms.reduce((a, b) => a + b, 0) };
  const report = { name, sprites: picked.length, renderMs, files: {} };
  for (const scale of [1, 2]) {
    // 先全部解码 + 缩小；merge:true 的阴影不单独出图，垫到引用它（under）的 sprite 下面合成一张
    const imgs = new Map();
    const need = new Set(picked.flatMap((s) => [s.name, s.under].filter(Boolean)));
    for (const s of index.sprites) {
      if (!need.has(s.name)) continue;
      const file = join(RAW, `${s.name}.png`);
      if (!existsSync(file)) throw new Error(`缺少原图 ${file}`);
      let img = downsample(decodePNG(readFileSync(file)), ss / scale);
      if (s.group === 'shadow') img = treatShadow(img, scale, s.merge ? { ...SHADOW_FX, fade: 2 } : SHADOW_FX);
      imgs.set(s.name, img);
    }
    const items = [];
    for (const s of picked) {
      if (s.merge) continue;
      let img = imgs.get(s.name);
      if (s.under) {
        if (!imgs.has(s.under)) throw new Error(`${s.name} 引用的阴影 ${s.under} 不存在`);
        img = over(img, imgs.get(s.under));
      }
      items.push({ ...s, img, w: s.w * scale, h: s.h * scale });
    }
    const W = widths[scale];
    const H = shelfPack(items, W);
    const atlas = new Uint8Array(W * H * 4);
    for (const it of items) {
      for (let y = 0; y < it.h; y++) {
        atlas.set(it.img.data.subarray(y * it.w * 4, (y + 1) * it.w * 4), ((it.y + y) * W + it.x) * 4);
      }
    }
    const suffix = scale === 1 ? '' : `@${scale}x`;
    const png = encodePNG(W, H, atlas);
    writeFileSync(join(ATLAS_DIR, `${name}${suffix}.png`), png);
    const frames = {};
    for (const it of items.sort((p, q) => p.name.localeCompare(q.name))) {
      frames[it.name] = { x: it.x, y: it.y, w: it.w, h: it.h, ax: it.ax * scale, ay: it.ay * scale, group: it.group };
    }
    const manifest = { file: `${name}${suffix}.png`, scale, size: [W, H], bytes: png.length, renderMs, meta: index.meta, frames };
    writeFileSync(join(ATLAS_DIR, `${name}${suffix}.json`), JSON.stringify(manifest, null, 1));
    report.files[`${name}${suffix}.png`] = { size: [W, H], bytes: png.length };
  }
  return report;
}

/** 两套图集：pilot = 地图内全部 sprite（1× 首屏必需）；env = 场外布景（土崖 / 树林，非首屏：与 pilot 并行拉、到货后重烘静态层）。 */
const isEnv = (s) => s.group === 'env';
export const ATLASES = Object.freeze({
  pilot: { filter: (s) => !isEnv(s) },
  env: { filter: isEnv, widths: { 1: 512, 2: 1024 } },
});

export function packAll() {
  return Object.entries(ATLASES).map(([name, opt]) => pack(name, opt));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('pack.mjs')) {
  const i = process.argv.indexOf('--name');
  const name = i > 0 ? process.argv[i + 1] : null;
  console.log(JSON.stringify(name ? pack(name, ATLASES[name]) : packAll(), null, 1));
}
