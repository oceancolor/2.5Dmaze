// 场外布景（docs/03 §15）：地图 = 一块抬高的台地，菱形外按同一套等距格继续铺林子 / 土崖 / 地标。
// 与对局无关、只依赖地图尺寸与格坐标 hash，所以是确定性的；摆放表算一次，之后按档位两路绘制：
//   近景（zoom 大）：每帧按视口裁剪逐件画，件数受视口限制；
//   全图档：整圈烤成两张位图（后方 / 前方），每帧各一次 drawImage —— 否则 7000 件会掉帧。
//
// 层次（renderer 调用顺序）：drawBack 在地图之前（后方树冠、林间空地、后沿暗晕）；
//                          drawFront 在地图与角色之后（土崖、崖脚、前方林、暗角、玉石辉光）。
// 约束（03 §15）：前方任何一件的剪影顶都不越过菱形下边线（+CLIFF 的 60%），不压地图一格。

import { HALF_W, HALF_H, tileCenter } from './iso.js';
import { tileHash } from './variants.js';

const pad2 = (n) => String(n).padStart(2, '0');
const envName = (k) => `ENV_${k}_na_00`;

/** 台地土崖高度（= tools/art/blender/models.py CLIFF_PX）。 */
export const CLIFF = 28;
/** 前方布景最多盖住土崖的下 40%：上面（草皮卷边 + 两层地层）始终露出来。 */
const CLIFF_SHOW = Math.round(CLIFF * 0.6);
/** 林带半径（格）。 */
const RING = 14;
/** 低于这个缩放比就整圈烘焙（近景逐件画太贵）。 */
export const BAKE_BELOW = 0.45;

// 林相按 3×3 格一片：阔叶林 / 塔松林 / 林间空地（树稀、灌木石块多、露出深色林地）
const ZONES = [
  [50, [['TREE01', 30], ['TREE04', 28], ['TREE02', 26], ['TREE03', 8], ['PINE01', 4], [null, 4]]],
  [28, [['PINE01', 52], ['TREE02', 16], ['TREE03', 16], ['TREE04', 8], [null, 8]]],
  [22, [['TREE03', 22], ['TREE02', 14], ['BUSH01', 18], ['BUSH02', 12], ['ROCK01', 10], [null, 24]]],
];
const NEAR = [['BUSH01', 34], ['BUSH02', 24], ['ROCK01', 6], ['TREE03', 25], [null, 11]];
const FOOT = [['BUSH01', 50], ['BUSH02', 35], ['ROCK01', 15]];

/**
 * 地标：样张页（20×20、1280×720）的屏幕坐标换算成「相对该边中点的世界偏移」，簇内布局原样保留，
 * 整簇锚到左上 / 右上边的中点 —— 20×20 时落在顶角两侧，128×128 时落在长边中段，不会全挤在顶角。
 * 每项：[名, 簇内 dx, 簇内 dy]（dy 为负 = 往边外推）。
 */
const MARK_CLUSTER = [
  // 左上边（x<0 一侧）
  ['TOWER01', -70, -10], ['STONES01', -24, -90], ['CABIN01', 40, -80], ['JADE01', 120, -120], ['STONES02', 160, -154],
  // 右上边（y<0 一侧）
  ['STONES01', -200, -140], ['JADE02', -140, -126], ['CABIN02', -50, -82], ['STONES02', 25, -50], ['TOWER01', 190, 36],
];
/** 林间空地（相对簇心的椭圆 rx, ry）：里面的树约 1/3 换成灌木 / 石块，其余清掉。 */
const CLEARING_REL = [
  [40, -78, 150, 68], [-88, -96, 132, 60], [190, 32, 50, 26],
];
const GLOW_RGB = [126, 240, 200];

/** 两簇的锚点：左上边 / 右上边的中点（菱形顶点 → 左右顶点）。 */
const anchors = (size) => [[-size * HALF_W / 2, size * HALF_H / 2], [size * HALF_W / 2, size * HALF_H / 2]];

function pickWeighted(table, u) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = u * total;
  for (const [k, w] of table) {
    if (r < w) return k;
    r -= w;
  }
  return table[table.length - 1][0];
}

/** 菱形下边线（世界）在横坐标 x 处的 y：地图在屏幕上的最低处。 */
export const lowEdgeY = (size, wx) => size * 2 * HALF_H - Math.abs(wx) / HALF_W * HALF_H;

/**
 * 生成摆放表（纯函数，只依赖 size 与图集包围盒）。boxOf(name) → {l,r,t,b}（1×，相对锚点）。
 * @returns {{back:object[], front:object[], cliffs:object[], glows:object[], clearings:number[][]}}
 */
export function buildPlan(size, boxOf) {
  const N = size;
  const at = (x, y) => tileCenter(x, y);
  const fits = (n, wx, wy) => {
    const b = boxOf(n);
    const xm = Math.min(Math.max(0, wx + b.l), wx + b.r); // 区间内离菱形中轴最近的点 = 下边线最低处
    return wy - b.t >= lowEdgeY(N, xm) + CLIFF_SHOW;
  };
  const shorter = ['TREE01', 'TREE04', 'PINE01', 'TREE02', 'TREE03', 'BUSH01', 'ROCK01', 'BUSH02']
    .map(envName).sort((p, q) => boxOf(q).t - boxOf(p).t);
  const fallback = (n, wx, wy) => {
    const i = shorter.indexOf(n);
    return shorter.slice(i < 0 ? 0 : i).find((m) => fits(m, wx, wy)) || null;
  };

  const back = [];
  const front = [];
  const cliffs = [];

  // 朝镜头的两条边（SW = x 方向，SE = y 方向）每格一段土崖，按行序画（后一段压前一段的重叠端）
  for (let i = 0; i < N - 1; i++) {
    cliffs.push({ name: `ENV_CLIFF_SW${pad2((tileHash(i + 41, 83) % 3) + 1)}_na_00`, at: at(i, N - 1), depth: i + N - 1 });
    cliffs.push({ name: `ENV_CLIFF_SE${pad2((tileHash(97, i + 59) % 3) + 1)}_na_00`, at: at(N - 1, i), depth: i + N - 1 });
  }
  cliffs.push({ name: 'ENV_CLIFF_S_na_00', at: at(N - 1, N - 1), depth: 2 * N - 2 });
  cliffs.sort((p, q) => p.depth - q.depth);

  // 崖脚：沿两条前沿约 60% 的格放一件灌木 / 石块（沿边偏移 ±0.3 格）
  for (let i = 0; i < N; i++) {
    for (const side of [0, 1]) {
      const [gx, gy] = side ? [N - 1, i] : [i, N - 1];
      const h = tileHash(gx * 5 + 11 + side * 97, gy * 3 + 29);
      if ((h & 255) / 256 > 0.6) continue;
      const [cx, cy] = at(gx, gy);
      const t = (((h >>> 8) & 255) / 255 - 0.5) * 0.6;
      const wx = side ? cx + 16 - 32 * t : cx - 16 + 32 * t;
      const wy = cy + 8 + 16 * t + CLIFF + 4;
      const n = fallback(envName(pickWeighted(FOOT, ((h >>> 16) & 0xffff) / 65536)), wx, wy);
      if (n) front.push({ name: n, wx, wy, depth: gx + gy + 0.5 });
    }
  }

  // 场外各格：一格一件，格内抖动 ±7 / ±3 px
  for (let gy = -RING; gy < N + RING; gy++) {
    for (let gx = -RING; gx < N + RING; gx++) {
      if (gx >= 0 && gy >= 0 && gx < N && gy < N) continue;
      const h = tileHash(gx + 3001, gy + 7919);
      const isFront = gx >= N || gy >= N;
      const near = isFront && Math.max(gx, gy) === N;
      const zone = pickWeighted(ZONES.map(([w], i) => [i, w]), (tileHash(Math.floor(gx / 3) + 61, Math.floor(gy / 3) + 17) & 0xffff) / 65536);
      const k = pickWeighted(near ? NEAR : ZONES[zone][1], (h & 0xffff) / 65536);
      if (!k) continue;
      const [cx, cy] = at(gx, gy);
      const wx = cx + ((h >>> 16) & 15) - 7.5;
      const wy = cy + CLIFF + ((h >>> 20) & 7) - 3.5;
      const n = isFront ? fallback(envName(k), wx, wy) : envName(k);
      if (!n) continue;
      (isFront ? front : back).push({ name: n, wx, wy, depth: gx + gy });
    }
  }

  const order = (p, q) => p.depth - q.depth || p.wx - q.wx;
  const [A0, A1] = anchors(N);
  const marks = [];
  MARK_CLUSTER.forEach(([k, dx, dy], i) => {
    const a = i < 5 ? A0 : A1;
    const wx = a[0] + dx;
    const wy = a[1] + dy;
    marks.push({ name: envName(k), wx, wy, depth: (wy - CLIFF - 2 * HALF_H) / (2 * HALF_H) });
  });
  const clearings = CLEARING_REL.map(([dx, dy, rx, ry], i) => {
    const a = i < 2 ? A0 : A1;
    return [a[0] + dx, a[1] + dy, rx, ry];
  });

  const overlap = (p, q, m) => {
    const a = boxOf(p.name);
    const b = boxOf(q.name);
    return p.wx + a.l < q.wx + b.r + m && q.wx + b.l < p.wx + a.r + m && p.wy - a.t < q.wy + b.b + m && q.wy - b.t < p.wy + a.b + m;
  };
  const inClearing = (it) => clearings.some(([cx, cy, rx, ry]) => ((it.wx - cx) / rx) ** 2 + ((it.wy - cy) / ry) ** 2 < 1);
  // 空地里的树：约 1/3 换成灌木 / 石块（空地不是秃的），其余清掉
  const glade = (it) => {
    if (!inClearing(it) || /^ENV_(BUSH|ROCK)/.test(it.name)) return it;
    const h = tileHash(Math.round(it.wx) + 503, Math.round(it.wy) + 211);
    return (h & 255) < 96 ? { ...it, name: envName(['BUSH01', 'BUSH02', 'ROCK01', 'BUSH01'][(h >>> 8) & 3]) } : null;
  };
  const kept = back.map(glade).filter((it) => it && !marks.some((mk) => it.depth > mk.depth - 0.5 && overlap(it, mk, 2)));

  return {
    back: [...kept, ...marks].sort(order),
    front: front.sort(order),
    cliffs,
    glows: marks.filter((mk) => mk.name.startsWith('ENV_JADE')),
    clearings,
  };
}

/** 落地点暗斑：预渲染一张 64×64 的柔和椭圆，绘制时缩放到件宽 —— 每帧 createRadialGradient 太贵。 */
const SHADOW = { canvas: null };
function shadowSprite(makeCanvas) {
  if (SHADOW.canvas) return SHADOW.canvas;
  const c = makeCanvas(64, 64);
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(8,18,10,0.5)');
  g.addColorStop(0.55, 'rgba(8,18,10,0.22)');
  g.addColorStop(1, 'rgba(8,18,10,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  SHADOW.canvas = c;
  return c;
}

/** 一件布景：先在落地点垫一块柔和的暗斑（压暗身后那棵的下半截 → 一簇簇分得开），再贴 sprite。 */
function drawItem(ctx, atlas, it, s, ox, oy, b, makeCanvas) {
  const rx = Math.max(2, (b.r - b.l) * 0.55 * s);
  const dx = it.wx * s + ox;
  const dy = it.wy * s + oy;
  ctx.drawImage(shadowSprite(makeCanvas), dx - rx, dy - 2 * s - rx * 0.5, rx * 2, rx);
  atlas.draw(ctx, it.name, s, dx, dy, { mode: 'raw' });
}

/** 沿菱形两条边画一道暗带（后沿暗晕 / 崖脚落地影）。 */
function drawBand(ctx, size, s, ox, oy, which, width, alpha, dy) {
  const top = [0, 0];
  const right = [size * HALF_W, size * HALF_H];
  const left = [-size * HALF_W, size * HALF_H];
  const pts = which === 'back' ? [left, top, right] : [left, [0, size * 2 * HALF_H], right];
  ctx.save();
  ctx.beginPath();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(6,14,8,${alpha})`;
  ctx.lineWidth = width * s;
  ctx.moveTo(pts[0][0] * s + ox, (pts[0][1] + dy) * s + oy);
  for (const p of pts.slice(1)) ctx.lineTo(p[0] * s + ox, (p[1] + dy) * s + oy);
  ctx.stroke();
  ctx.restore();
}

/** 菱形的屏幕路径（暗角 / 辉光用来裁掉地图一格）。 */
function diamondPath(ctx, size, s, ox, oy) {
  ctx.beginPath();
  ctx.moveTo(0 * s + ox, 0 * s + oy);
  ctx.lineTo(size * HALF_W * s + ox, size * HALF_H * s + oy);
  ctx.lineTo(0 * s + ox, size * 2 * HALF_H * s + oy);
  ctx.lineTo(-size * HALF_W * s + ox, size * HALF_H * s + oy);
  ctx.closePath();
}

/**
 * @param {{atlas:object, size:number, makeCanvas?:(w:number,h:number)=>any}} o
 *   atlas：场外布景图集（非首屏，可后到，setAtlas 注入）；makeCanvas：烘焙位图用
 */
export function createEnvScene({ atlas, size, makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } }) {
  let plan = null;
  let baked = null; // {s, back, front, minX, minY, w, h}

  function ensure() {
    if (plan || !atlas) return plan;
    if (!atlas.has('ENV_TREE01_na_00')) return null; // 图集不对 / 没加载
    plan = buildPlan(size, atlas.box);
    return plan;
  }

  const visible = (it, b, s, ox, oy, W, H) => it.wx * s + ox + b.r * s > 0 && it.wx * s + ox + b.l * s < W
    && it.wy * s + oy - b.t * s < H && it.wy * s + oy + b.b * s > 0;

  function items(ctx, list, s, ox, oy, W, H) {
    let ops = 0;
    for (const it of list) {
      const b = atlas.box(it.name);
      if (!visible(it, b, s, ox, oy, W, H)) continue;
      drawItem(ctx, atlas, it, s, ox, oy, b, makeCanvas);
      ops++;
    }
    return ops;
  }

  /** 整圈的世界包围盒（含 sprite 探出的部分），烘焙用。 */
  function bounds(p) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (name, wx, wy) => {
      const b = atlas.box(name);
      x0 = Math.min(x0, wx + b.l);
      x1 = Math.max(x1, wx + b.r);
      y0 = Math.min(y0, wy - b.t);
      y1 = Math.max(y1, wy + b.b);
    };
    for (const it of p.back) add(it.name, it.wx, it.wy);
    for (const it of p.front) add(it.name, it.wx, it.wy);
    for (const cl of p.cliffs) add(cl.name, cl.at[0], cl.at[1]);
    return { x0, y0, x1, y1 };
  }

  /** 全图档：整圈烤成后方 / 前方两张位图（每帧各一次 drawImage）。 */
  function bake(p, s) {
    if (baked && baked.s === s) return baked;
    const bd = bounds(p);
    const pad = 8;
    const w = Math.ceil((bd.x1 - bd.x0) * s) + pad * 2;
    const h = Math.ceil((bd.y1 - bd.y0) * s) + pad * 2;
    const ox = pad - Math.round(bd.x0 * s);
    const oy = pad - Math.round(bd.y0 * s);
    const mk = (which) => {
      const c = makeCanvas(w, h);
      const x = c.getContext('2d');
      if (which === 'back') {
        for (const [cx, cy, rx, ry] of p.clearings) {
          const r = rx * 1.15 * s;
          x.save();
          x.translate(cx * s + ox, cy * s + oy);
          x.scale(1, ry / rx);
          const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, 'rgba(74,104,60,0.5)');
          g.addColorStop(0.6, 'rgba(74,104,60,0.28)');
          g.addColorStop(1, 'rgba(74,104,60,0)');
          x.fillStyle = g;
          x.fillRect(-r, -r, r * 2, r * 2);
          x.restore();
        }
        for (const it of p.back) drawItem(x, atlas, it, s, ox, oy, atlas.box(it.name), makeCanvas);
        drawBand(x, size, s, ox, oy, 'back', 16, 0.6, -2);
      } else {
        for (const cl of p.cliffs) atlas.draw(x, cl.name, s, cl.at[0] * s + ox, cl.at[1] * s + oy, { mode: 'raw' });
        drawBand(x, size, s, ox, oy, 'front', 12, 0.7, CLIFF + 3);
        for (const it of p.front) drawItem(x, atlas, it, s, ox, oy, atlas.box(it.name), makeCanvas);
      }
      return c;
    };
    baked = { s, back: mk('back'), front: mk('front'), minX: bd.x0, minY: bd.y0, w, h, ox, oy };
    return baked;
  }

  return {
    /** 图集到货（或 @2x 补加载）后注入；摆放表与烘焙位图作废。 */
    setAtlas(a) {
      atlas = a;
      plan = null;
      baked = null;
    },
    get ready() { return Boolean(ensure()); },

    /** 地图之前：林间空地 + 后方树林 + 后沿暗晕。 */
    drawBack(ctx, s, ox, oy, W, H) {
      const p = ensure();
      if (!p) return 0;
      if (s < BAKE_BELOW) {
        const b = bake(p, s);
        ctx.drawImage(b.back, ox - b.ox, oy - b.oy, b.w, b.h); // b.ox 已含 −minX·s
        return 1;
      }
      let ops = 1;
      for (const [cx, cy, rx, ry] of p.clearings) {
        const r = rx * 1.15 * s;
        ctx.save();
        ctx.translate(cx * s + ox, cy * s + oy);
        ctx.scale(1, ry / rx);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, 'rgba(74,104,60,0.5)');
        g.addColorStop(0.6, 'rgba(74,104,60,0.28)');
        g.addColorStop(1, 'rgba(74,104,60,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.restore();
        ops++;
      }
      ops += items(ctx, p.back, s, ox, oy, W, H);
      drawBand(ctx, size, s, ox, oy, 'back', 16, 0.6, -2); // 后两条边外一圈暗晕：外圈绿篱与后面的树冠分开
      return ops;
    },

    /** 地图之后：土崖 + 台地落地影 + 前方林 + 暗角 + 玉石辉光（裁掉菱形，只亮场外）。 */
    drawFront(ctx, s, ox, oy, W, H) {
      const p = ensure();
      if (!p) return 0;
      let ops = 0;
      if (s < BAKE_BELOW) {
        const b = bake(p, s);
        ctx.drawImage(b.front, ox - b.ox, oy - b.oy, b.w, b.h); // b.ox 已含 −minX·s
        ops++;
      } else {
        for (const cl of p.cliffs) {
          atlas.draw(ctx, cl.name, s, cl.at[0] * s + ox, cl.at[1] * s + oy, { mode: 'raw' });
          ops++;
        }
        drawBand(ctx, size, s, ox, oy, 'front', 12, 0.7, CLIFF + 3); // 台地压在林地上的落地影
        ops += items(ctx, p.front, s, ox, oy, W, H) + 1;
      }

      // 暗角：只压场外（越往视口四角越暗 → 地图最亮、HUD 次之、林子垫底）。
      // 半径按视口归一（样张页按 1280×720 标定），任意窗口大小下「四角暗」的观感一致。
      const k = Math.min(W, H) / 720;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      diamondPath(ctx, size, s, ox, oy);
      ctx.clip('evenodd');
      ctx.translate(W / 2, H / 2);
      ctx.scale(1, 0.5);
      const g = ctx.createRadialGradient(0, 0, 520 * k, 0, 0, 980 * k);
      g.addColorStop(0, 'rgba(12,24,12,0)');
      g.addColorStop(1, 'rgba(12,24,12,0.62)');
      ctx.fillStyle = g;
      ctx.fillRect(-W, -H * 2, W * 2, H * 4);
      ctx.restore();

      // 玉石辉光：叠在暗角之上（screen），裁掉菱形 —— 只亮场外，地图一格不沾
      if (p.glows.length) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        diamondPath(ctx, size, s, ox, oy);
        ctx.clip('evenodd');
        ctx.globalCompositeOperation = 'screen';
        const c = (a) => `rgba(${GLOW_RGB.join(',')},${a})`;
        for (const it of p.glows) {
          const b = atlas.box(it.name);
          const cx = it.wx * s + ox;
          const cy = it.wy * s + oy - b.t * 0.55 * s;
          const r = Math.max(4, b.t * 1.4 * s);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, c(0.26));
          g.addColorStop(0.4, c(0.1));
          g.addColorStop(1, c(0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
          ctx.save();
          ctx.translate(it.wx * s + ox, it.wy * s + oy);
          ctx.scale(1, 0.5);
          const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g2.addColorStop(0, c(0.3));
          g2.addColorStop(1, c(0));
          ctx.fillStyle = g2;
          ctx.fillRect(-r, -r, r * 2, r * 2);
          ctx.restore();
          ops += 2;
        }
        ctx.restore();
      }
      return ops;
    },
  };
}
