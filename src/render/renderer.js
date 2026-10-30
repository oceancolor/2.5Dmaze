// 主画布渲染（SPEC §11、02 §2–§3）。
//
// 每帧：底色 → 可见静态块（按 cx+cy 升序）→ 动态条目（按 x+y 行序）。
// 遮挡【实现】：静态块里墙与地面一起烘焙（块数少、drawOps 低），动态条目画在所有块之后；
//   每个条目把它前方三格（x+1,y）（x,y+1）（x+1,y+1）里的墙，裁剪到条目自身包围盒内、按行序重画一遍 ——
//   前排墙压住后排角色 / 宝石，等价于「墙与实体统一按 (x+y) 行序绘制」（SPEC §11），但不必每帧画几百块墙。
//   为什么三格就够：角色 sprite 锚点 (32,56)、向上 56 / 向下 8px；更远的前排墙顶最高只到格心 +16，碰不到。移动中取两端格的并集。
// 全图档（zoom 最小档）走整图 overview 位图 + 屏幕恒定尺寸的矢量标记（03 §3.11、L16），进该档时释放块缓存。
// 降级（02 §3 P1，K13）：连续 60 帧帧时间 > 16.7 ms → stepDown()：
//   L2 默认：块 8×8、按 DPR 渲染（≤2）、墙投影 / 落地影 / 描边 / 光环 / 光柱全开
//   L1：块 16×16（静态层 blit 约 1/3）、按 1× 渲染、关落地影
//   L0：再关墙投影、描边、光环 / 光柱，待机帧率减半

import * as S from './sprites.js';
import { tileCenter } from './iso.js';
import { ACTOR_COLORS, GEM_COLORS_BASE, HALO, INK, REVEAL, UI } from './palette.js';
import { createChunkCache, bakeOverview, chunkBounds, wallSprite, GROUND_BG } from './chunk-cache.js';
import { createEnvScene } from './env.js';

export const QUALITY = Object.freeze([
  Object.freeze({ chunk: 16, hiDpi: false, wallShadows: false, deco: true }),
  Object.freeze({ chunk: 16, hiDpi: false, wallShadows: true, deco: true }),
  Object.freeze({ chunk: 8, hiDpi: true, wallShadows: true, deco: true }),
]);

const FRONT = [[1, 0], [0, 1], [1, 1]];

/** 帧时间监视（02 §3 P1）：连续 frames 帧 > limitMs → onTrip()，然后清零重新计数。 */
export function createFrameMonitor({ limitMs = 16.7, frames = 60, onTrip }) {
  let slow = 0;
  return {
    sample(ms) {
      slow = ms > limitMs ? slow + 1 : 0;
      if (slow >= frames) {
        slow = 0;
        onTrip();
        return true;
      }
      return false;
    },
    get slow() { return slow; },
  };
}

/** 全图档宝石标记：五色五形（与预览页同形，灰度靠外形区分）。 */
function gemPath(ctx, c, x, y, r) {
  ctx.beginPath();
  if (c === 0) {
    ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 0.74, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 0.74, y);
  } else if (c === 1) {
    for (let k = 0; k < 12; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 6;
      const rr = k % 2 ? r * 0.55 : r * 1.15;
      if (k) ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      else ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
  } else if (c === 2) {
    const s = r * 0.95;
    const k = s * 0.42;
    ctx.moveTo(x - s + k, y - s); ctx.lineTo(x + s - k, y - s); ctx.lineTo(x + s, y - s + k); ctx.lineTo(x + s, y + s - k);
    ctx.lineTo(x + s - k, y + s); ctx.lineTo(x - s + k, y + s); ctx.lineTo(x - s, y + s - k); ctx.lineTo(x - s, y - s + k);
  } else if (c === 3) {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else {
    const w = r * 1.2;
    const h = r * 0.75;
    ctx.moveTo(x - w, y); ctx.lineTo(x - w / 2, y - h); ctx.lineTo(x + w / 2, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x - w / 2, y + h);
  }
  ctx.closePath();
}

/**
 * @param {{canvas:any, map:object, cfg:object, atlas:object, envAtlas?:object, makeCanvas?:(w:number,h:number)=>any}} o
 *   atlas 接口见 atlas.js（draw/frame/box）；envAtlas 是场外布景那套图集（非首屏，可后到）；
 *   makeCanvas 可注入（Node 下测试用假画布）
 */
export function createRenderer({ canvas, map, cfg, atlas, envAtlas = null, makeCanvas = S.makeCanvas }) {
  const N = map.size;
  const ctx = canvas.getContext('2d');
  const isWall = (x, y) => x >= 0 && y >= 0 && x < N && y < N && map.grid[y * N + x] === 0;
  let quality = QUALITY.length - 1;
  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let chunks = null;
  let overview = null;
  const stats = { drawOps: 0, chunks: 0, items: 0, occluders: 0, quality, scale: 1, chunkBytes: 0, chunkBuilds: 0, overviewBytes: 0 };

  function makeChunks() {
    const q = QUALITY[quality];
    const lru = q.chunk === 8 ? cfg.render.lruMax : Math.ceil(cfg.render.lruMax / 4);
    chunks = createChunkCache({ map, atlas, makeCanvas, chunk: q.chunk, lruMax: lru, deco: q.deco, wallShadows: q.wallShadows });
  }
  makeChunks();

  // 场外布景（docs/03 §15）：与地图一样只依赖尺寸与 hash，图集到货后自动生效
  const env = createEnvScene({ atlas: envAtlas, size: N, makeCanvas });

  const renderScale = () => (QUALITY[quality].hiDpi ? Math.min(2, Math.max(1, dpr)) : 1);

  function applySize() {
    const rs = renderScale();
    const w = Math.max(1, Math.round(cssW * rs));
    const h = Math.max(1, Math.round(cssH * rs));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
  }

  function drawLayers(e, s, t) {
    let ops = 0;
    for (const l of e.it.layers) {
      if (l.sprite) {
        ops += atlas.draw(ctx, l.sprite, s, e.dx, e.dy + l.dy * s, { mode: l.mode, ghost: l.ghost, alpha: l.alpha, desat: l.desat || 0 });
        continue;
      }
      ctx.save();
      if (l.proc === 'halo') {
        ctx.setTransform(s, 0, 0, s, e.dx - 32 * s, e.dy - 56 * s);
        S.drawHalo(ctx, t / 1000, { alpha: l.alpha });
      } else if (l.proc === 'beam') {
        ctx.setTransform(s, 0, 0, s, e.dx - 32 * s, e.dy - 32 * s);
        S.drawExitBeam(ctx, l.color, t / 1000);
      } else if (l.proc === 'badge') {
        ctx.setTransform(s, 0, 0, s, e.dx - 32 * s, e.dy - 56 * s);
        S.drawGhostBadge(ctx, 34, 0, l.text, UI.font);
      } else if (l.proc === 'text') {
        ctx.setTransform(s, 0, 0, s, e.dx, e.dy + l.dy * s);
        ctx.globalAlpha = l.alpha;
        ctx.font = `700 14px ${UI.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = INK;
        ctx.strokeText(l.text, 0, 0);
        ctx.fillStyle = l.kind === 'score' ? REVEAL.score.mid : REVEAL.stamina.mid;
        ctx.fillText(l.text, 0, 0);
      }
      ctx.restore();
      ops++;
    }
    return ops;
  }

  function drawChunks(s, ox, oy, W, H) {
    const C = chunks.chunk;
    const cnt = chunks.count;
    const wx0 = -ox / s;
    const wx1 = (W - ox) / s;
    const wy0 = -oy / s;
    const wy1 = (H - oy) / s;
    const vis = [];
    for (let cy = 0; cy < cnt; cy++) {
      for (let cx = 0; cx < cnt; cx++) {
        const b = chunkBounds(cx, cy, C);
        if (b.minX > wx1 || b.minX + b.w < wx0 || b.minY > wy1 || b.minY + b.h < wy0) continue;
        vis.push(cx, cy);
      }
    }
    const order = [];
    for (let k = 0; k < vis.length; k += 2) order.push(k);
    order.sort((p, q) => vis[p] + vis[p + 1] - (vis[q] + vis[q + 1]) || vis[p] - vis[q]);
    chunks.ensureCapacity(order.length);
    for (const k of order) {
      const e = chunks.get(vis[k], vis[k + 1], s);
      ctx.drawImage(e.canvas, e.offX + ox, e.offY + oy);
    }
    return order.length;
  }

  function drawItems(items, s, ox, oy, W, H, t) {
    const list = [];
    const m = 96 * s;
    let occ = 0;
    for (const it of items) {
      const [wx, wy] = tileCenter(it.x, it.y);
      const dx = wx * s + ox;
      const dy = wy * s + oy;
      if (dx < -m || dx > W + m || dy < -m || dy > H + m) continue;
      let host = Infinity;
      for (const [cx, cy] of it.cells) host = Math.min(host, cx + cy);
      const rect = [dx - 36 * s, dy - 68 * s, 72 * s, 88 * s];
      list.push({ depth: host + 0.5 + it.order * 0.01, it, dx, dy });
      const seen = new Set();
      for (const [cx, cy] of it.cells) {
        for (const [ax, ay] of FRONT) {
          const x = cx + ax;
          const y = cy + ay;
          const k = y * N + x;
          if (seen.has(k) || !isWall(x, y)) continue;
          seen.add(k);
          list.push({ depth: x + y, wall: [x, y], rect });
        }
      }
    }
    list.sort((p, q) => p.depth - q.depth);
    let ops = 0;
    let shown = 0;
    for (const e of list) {
      if (e.wall) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(e.rect[0], e.rect[1], e.rect[2], e.rect[3]);
        ctx.clip();
        const [wx, wy] = tileCenter(e.wall[0], e.wall[1]);
        ops += atlas.draw(ctx, wallSprite(e.wall[0], e.wall[1]), s, wx * s + ox, wy * s + oy);
        ctx.restore();
        occ++;
      } else {
        ops += drawLayers(e, s, t);
        shown++;
      }
    }
    return { ops, occ, shown };
  }

  function drawMarkers(items, s, rs, ox, oy, viewer) {
    let ops = 0;
    const at = (x, y) => {
      const [wx, wy] = tileCenter(x, y);
      return [wx * s + ox, wy * s + oy];
    };
    ctx.lineJoin = 'round';
    map.exits.forEach(([ex, ey], i) => {
      const [x, y] = at(ex, ey);
      ctx.beginPath();
      ctx.ellipse(x, y, 7 * rs, 4 * rs, 0, 0, Math.PI * 2);
      ctx.lineWidth = (i === viewer ? 3 : 2) * rs;
      ctx.strokeStyle = ACTOR_COLORS[i];
      ctx.stroke();
      if (i === viewer) {
        ctx.fillStyle = ACTOR_COLORS[i];
        ctx.fill();
      }
      ops++;
    });
    const order = { gem: 0, chest: 0, ghost: 1, actor: 2 };
    const marks = items.filter((it) => it.marker).sort((p, q) => order[p.marker.type] - order[q.marker.type]);
    for (const it of marks) {
      const [x, y] = at(it.x, it.y);
      const mk = it.marker;
      if (mk.type === 'gem') {
        gemPath(ctx, mk.c, x, y, 4.5 * rs);
        ctx.fillStyle = GEM_COLORS_BASE[mk.c];
        ctx.fill();
        ctx.lineWidth = 1.2 * rs;
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.stroke();
      } else if (mk.type === 'chest') {
        ctx.fillStyle = '#8C5A36';
        ctx.fillRect(x - 5 * rs, y - 4 * rs, 10 * rs, 8 * rs);
        ctx.fillStyle = '#E9D9A8';
        ctx.fillRect(x - 5 * rs, y - 0.8 * rs, 10 * rs, 1.6 * rs);
      } else if (mk.type === 'ghost') {
        ctx.beginPath();
        ctx.arc(x, y, 5 * rs, 0, Math.PI * 2);
        ctx.setLineDash([2 * rs, 2 * rs]);
        ctx.lineWidth = 2 * rs;
        ctx.strokeStyle = ACTOR_COLORS[mk.seat];
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const me = mk.seat === viewer;
        const r = (me ? 8 : 6) * rs;
        if (me) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4 * rs, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,216,77,.55)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = ACTOR_COLORS[mk.seat];
        ctx.fill();
        ctx.lineWidth = 2 * rs;
        ctx.strokeStyle = me ? HALO : '#FFFFFF';
        ctx.stroke();
      }
      ops++;
    }
    return ops;
  }

  return {
    stats,
    get quality() { return quality; },
    get renderScale() { return renderScale(); },

    /** CSS 像素视口 + 设备像素比。 */
    resize(w, h, devicePixelRatio = 1) {
      cssW = w;
      cssH = h;
      dpr = devicePixelRatio;
      applySize();
    },

    /** 世界坐标 ↔ 屏幕 CSS 像素（拖拽 / 点击用）。 */
    toWorld(camera, sx, sy) {
      const z = camera.zoom;
      return [(sx - cssW / 2) / z + camera.x, (sy - cssH / 2) / z + camera.y];
    },

    /**
     * @param {{items:object[]}} frame animator.frame() 的输出
     * @param {object} camera
     * @param {number} t 时间（ms）
     * @param {number} viewer 玩家座位（全图档出口标记加粗用）
     */
    render(frame, camera, t, viewer = 0) {
      const rs = renderScale();
      const W = canvas.width;
      const H = canvas.height;
      const s = camera.zoom * rs;
      const ox = Math.round(W / 2 - camera.x * s);
      const oy = Math.round(H / 2 - camera.y * s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = GROUND_BG;
      ctx.fillRect(0, 0, W, H);
      let ops = 0;
      stats.items = 0;
      stats.occluders = 0;
      stats.env = 0;
      const envOps = env.drawBack(ctx, s, ox, oy, W, H); // 后方树林：地图之前
      ops += envOps;
      stats.env += envOps;
      if (camera.overview) {
        if (!overview || overview.s !== s) {
          overview = bakeOverview({ map, atlas, makeCanvas, s });
          chunks.clear();
        }
        ctx.drawImage(overview.canvas, overview.offX + ox, overview.offY + oy);
        ops++;
        ops += drawMarkers(frame.items, s, rs, ox, oy, viewer);
        stats.chunks = 0;
      } else {
        stats.chunks = drawChunks(s, ox, oy, W, H);
        ops += stats.chunks;
        const r = drawItems(frame.items, s, ox, oy, W, H, t);
        ops += r.ops;
        stats.items = r.shown;
        stats.occluders = r.occ;
      }
      const frontOps = env.drawFront(ctx, s, ox, oy, W, H); // 土崖 + 前方林 + 暗角：地图与角色之后
      ops += frontOps;
      stats.env += frontOps;
      const cs = chunks.stats();
      stats.drawOps = ops;
      stats.quality = quality;
      stats.scale = s;
      stats.chunkBytes = cs.bytes;
      stats.chunkBuilds = cs.builds;
      stats.overviewBytes = overview ? overview.bytes : 0;
      return stats;
    },

    /** 图集换了（@2x 到货）：静态块与 overview 作废，下一帧重烘。 */
    invalidate() {
      chunks.clear();
      overview = null;
    },

    /** 场外布景图集到货（非首屏，晚于地图图集）。 */
    setEnvAtlas(a) {
      env.setAtlas(a);
    },

    /** 降一级（K13）。已到最低返回 false。 */
    stepDown() {
      if (quality <= 0) return false;
      this.setQuality(quality - 1);
      return true;
    },
    setQuality(q) {
      const next = Math.max(0, Math.min(QUALITY.length - 1, q));
      if (next === quality) return;
      quality = next;
      makeChunks();
      overview = null;
      applySize();
    },
  };
}
