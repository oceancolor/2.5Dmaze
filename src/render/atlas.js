// 图集（docs/03 v1.5 §4.2）：pilot.png（1×，首屏）+ pilot@2x.png（高分屏，首屏后空闲时补拉）。
// 接口与样张页 tools/gallery/pilot.js 的 blit 同口径，但坐标直接给设备像素：draw(ctx, name, s, dx, dy) 把 sprite 锚点放到 (dx,dy)，
// s = 每 1× 像素对应的设备像素（zoom × 渲染倍率）。s > 1 且 @2x 已到货 → 取 @2x，否则用 1× 缩放顶上。

import * as S from './sprites.js';
import { INK } from './palette.js';

async function fetchAtlas(base, name, scale) {
  const suffix = scale === 1 ? '' : `@${scale}x`;
  const res = await fetch(`${base}${name}${suffix}.json`);
  if (!res.ok) throw new Error(`读不到 ${base}${name}${suffix}.json（先跑 node tools/art/build.mjs）`);
  const m = await res.json();
  const img = new Image();
  img.src = `${base}${m.file}?v=${m.bytes}`;
  await img.decode();
  return { m, img };
}

/**
 * @param {{base?:string, name?:string, hiDpi?:boolean}} [opts] hiDpi=false 时不补拉 @2x
 * @returns {Promise<object>} 1× 就绪即 resolve；@2x 到货后 atlas.hasHi 变 true，并回调 onHi
 */
export async function loadAtlas({ base = '/assets/atlas/', name = 'pilot', hiDpi = true, onHi = null } = {}) {
  const book = { 1: await fetchAtlas(base, name, 1) };
  const atlas = createAtlas(book);
  if (hiDpi) {
    const idle = globalThis.requestIdleCallback
      ? (f) => globalThis.requestIdleCallback(f, { timeout: 1000 })
      : (f) => setTimeout(f, 200);
    idle(() => {
      fetchAtlas(base, name, 2)
        .then((b) => {
          book[2] = b;
          atlas.clearCache();
          if (onHi) onHi();
        })
        .catch((e) => console.warn('@2x 图集补加载失败，继续用 1× 放大', e));
    });
  }
  return atlas;
}

/** book = {1:{m,img}, 2?:{m,img}}；makeCanvas 可注入（测试）。 */
export function createAtlas(book, { makeCanvas = S.makeCanvas } = {}) {
  const cache = new Map();

  const srcOf = (s) => (s > 1.01 && book[2] ? 2 : 1);
  const frameAt = (name, src) => {
    const f = book[src].m.frames[name];
    if (!f) throw new Error(`图集缺 ${name}`);
    return f;
  };

  function raw(name, src) {
    const key = `raw|${name}|${src}`;
    let c = cache.get(key);
    if (!c) {
      const f = frameAt(name, src);
      c = makeCanvas(f.w, f.h);
      c.getContext('2d').drawImage(book[src].img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      cache.set(key, c);
    }
    return c;
  }

  /** mode: raw | ink（深色 1px@1× 描边，03 §3.9）；ghost：本体 α.35 去饱和、描边保留。 */
  function sprite(name, src, mode, ghost) {
    if (mode === 'raw' && !ghost) return raw(name, src);
    const key = `${name}|${src}|${mode}|${ghost}`;
    let out = cache.get(key);
    if (out) return out;
    const base = raw(name, src);
    out = makeCanvas(base.width, base.height);
    const o = out.getContext('2d');
    o.drawImage(S.outlineRing(base, INK, src), 0, 0);
    if (ghost) {
      o.globalAlpha = 0.35;
      o.drawImage(S.desaturateCanvas(base, 0.65), 0, 0);
    } else {
      o.drawImage(base, 0, 0);
    }
    cache.set(key, out);
    return out;
  }

  function gray(name, src) {
    const key = `gray|${name}|${src}`;
    let c = cache.get(key);
    if (!c) {
      c = S.desaturateCanvas(raw(name, src), 1);
      cache.set(key, c);
    }
    return c;
  }

  return {
    get hasHi() { return Boolean(book[2]); },
    has: (name) => name in book[1].m.frames,
    names: () => Object.keys(book[1].m.frames),
    /** 1× 帧信息 {w,h,ax,ay}。 */
    frame: (name) => frameAt(name, 1),
    clearCache: () => cache.clear(),

    /** 把 sprite 锚点放到设备像素 (dx,dy)，按 s 缩放。返回 1（= 一次 drawImage，渲染统计用）。 */
    draw(ctx, name, s, dx, dy, { mode = 'raw', ghost = false, alpha = 1, desat = 0 } = {}) {
      const src = srcOf(s);
      const k = s / src;
      const f = frameAt(name, src);
      const c = sprite(name, src, mode, ghost);
      const x = Math.round(dx - f.ax * k);
      const y = Math.round(dy - f.ay * k);
      const w = Math.round(c.width * k);
      const h = Math.round(c.height * k);
      ctx.globalAlpha = alpha;
      ctx.drawImage(c, x, y, w, h);
      let ops = 1;
      if (desat > 0) {
        ctx.globalAlpha = alpha * desat;
        ctx.drawImage(gray(name, src), x, y, w, h);
        ops++;
      }
      ctx.globalAlpha = 1;
      return ops;
    },

    /** DOM 图标：裁到不透明包围盒的小画布（HUD 宝石图标用）。 */
    icon(name, scale = 1) {
      const src = scale > 1 && book[2] ? 2 : 1;
      const c = raw(name, src);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let [l, r, t, b] = [c.width, -1, c.height, -1];
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] <= 16) continue;
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < t) t = y;
          if (y > b) b = y;
        }
      }
      if (r < l) return c;
      const out = makeCanvas(r - l + 1, b - t + 1);
      out.getContext('2d').drawImage(c, l, t, r - l + 1, b - t + 1, 0, 0, r - l + 1, b - t + 1);
      return out;
    },
  };
}
