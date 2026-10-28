// 静态层分块缓存（SPEC §11、02 §2.3）：chunk × chunk 格一块，按需烘焙、LRU 淘汰。
// 一块里按顺序烘：底色菱形 → 地面 / 出口 → 装饰 → 墙投影（含相邻块墙投过来的部分，裁到本块菱形）→ 墙（块内按 x+y 行序）。
// 块按 (cx+cy) 升序贴到屏幕：同和的块在屏幕上左右不相交，后排块的墙顶探进前排块时正好被盖住 → 静态层遮挡正确。
// 动态实体画在所有块之后；它前方的墙由 renderer 按实体包围盒裁剪重画（见 renderer.js「遮挡」）——前排墙照样压住后排角色。
// 另有一张整图 overview 位图（zoom 0.234 档，L16）：只烘地面 + 墙，不含装饰与投影。

import { tileHash, decoVariant } from './variants.js';
import { SEAT_KEYS } from './palette.js';
import { tileCenter, worldBounds, HALF_W, HALF_H } from './iso.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 场外 / 墙缝底色：绿篱色相、明度压到 22%（与样张页同值）。 */
export const GROUND_BG = '#243822';

// 地面 4 种拼法均匀轮换；墙：素面绿篱为主（~45%），其余 4 种植物 / 高度变体分摊（与样张页同表）
const WALL_MIX = [1, 1, 1, 1, 1, 2, 2, 3, 4, 4, 5];
const wallIdx = (x, y) => WALL_MIX[tileHash(x + 7, y + 3) % WALL_MIX.length];
export const floorSprite = (x, y) => `TIL_FLOOR${pad2((tileHash(x, y) & 3) + 1)}_na_00`;
export const wallSprite = (x, y) => `TIL_WALL${pad2(wallIdx(x, y))}_na_00`;
export const wallShadowSprite = (x, y) => `SHD_WALL${pad2(wallIdx(x, y))}_na_00`;
export const exitSprite = (seat) => `TIL_EXIT_${SEAT_KEYS[seat]}_na_00`;
export const DECO_DENSITY = 0.15;

/** 块 (cx,cy) 的世界包围盒：左角格中心 −32、顶格中心 −32（墙顶探出 16px）；宽 64C，高 16(2C+1)。 */
export function chunkBounds(cx, cy, C) {
  const x0 = cx * C;
  const y0 = cy * C;
  return {
    x0,
    y0,
    minX: tileCenter(x0, y0 + C - 1)[0] - HALF_W,
    minY: tileCenter(x0, y0)[1] - 2 * HALF_H,
    w: 2 * C * HALF_W,
    h: (2 * C + 1) * HALF_H,
  };
}

/**
 * @param {{map:object, atlas:object, makeCanvas:(w:number,h:number)=>any, chunk?:number, lruMax?:number,
 *          deco?:boolean, wallShadows?:boolean}} o
 */
export function createChunkCache({ map, atlas, makeCanvas, chunk = 8, lruMax = 64, deco = true, wallShadows = true }) {
  const N = map.size;
  const C = chunk;
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < N && y < N && map.grid[y * N + x] === 1;
  const isWall = (x, y) => x >= 0 && y >= 0 && x < N && y < N && map.grid[y * N + x] === 0;
  const exitSeat = new Map(map.exits.map(([x, y], i) => [y * N + x, i]));
  const near = (pts, r) => (x, y) => pts.some(([px, py]) => Math.max(Math.abs(x - px), Math.abs(y - py)) <= r);
  const nearExit = near(map.exits, 2);
  const nearSpawn = near(map.spawns, 3);
  const decoBlocked = (x, y) => nearExit(x, y) || nearSpawn(x, y);

  const lru = new Map(); // key → {canvas, bytes, b}
  let max = lruMax;
  let bytes = 0;
  let builds = 0;

  function diamond(ctx, b, at) {
    // 块的地面菱形（四个外角）
    const { x0, y0 } = b;
    const top = at(x0, y0);
    const right = at(x0 + C - 1, y0);
    const bottom = at(x0 + C - 1, y0 + C - 1);
    const left = at(x0, y0 + C - 1);
    const s = b.s;
    ctx.beginPath();
    ctx.moveTo(top[0], top[1] - HALF_H * s);
    ctx.lineTo(right[0] + HALF_W * s, right[1]);
    ctx.lineTo(bottom[0], bottom[1] + HALF_H * s);
    ctx.lineTo(left[0] - HALF_W * s, left[1]);
    ctx.closePath();
  }

  /**
   * 位图原点取 floor(世界 × s) 的整设备像素：块内 sprite 与直接画在屏幕上的 sprite 落在同一张设备像素网格上，
   * 分数缩放档（0.6）下块与块之间、墙重画与块之间都不会差半个像素。
   */
  function bake(cx, cy, s) {
    const b = { ...chunkBounds(cx, cy, C), s };
    const offX = Math.floor(b.minX * s);
    const offY = Math.floor(b.minY * s);
    const canvas = makeCanvas(Math.ceil((b.minX + b.w) * s) - offX, Math.ceil((b.minY + b.h) * s) - offY);
    const ctx = canvas.getContext('2d');
    const at = (gx, gy) => {
      const [wx, wy] = tileCenter(gx, gy);
      return [wx * s - offX, wy * s - offY];
    };
    const x1 = Math.min(N, b.x0 + C);
    const y1 = Math.min(N, b.y0 + C);
    ctx.save();
    diamond(ctx, b, at);
    ctx.fillStyle = GROUND_BG;
    ctx.fill();
    ctx.clip();
    for (let y = b.y0; y < y1; y++) {
      for (let x = b.x0; x < x1; x++) {
        if (!isFloor(x, y)) continue;
        const seat = exitSeat.get(y * N + x);
        atlas.draw(ctx, seat === undefined ? floorSprite(x, y) : exitSprite(seat), s, ...at(x, y));
        if (deco && seat === undefined) {
          const d = decoVariant(x, y, DECO_DENSITY, decoBlocked);
          if (d >= 0) atlas.draw(ctx, `TIL_DECO${pad2(d + 1)}_na_00`, s, ...at(x, y));
        }
      }
    }
    if (wallShadows) {
      // 墙投影向 +x / −y 方向落：左侧一列（x0−1）与下方一行（y1）的墙也会投进本块
      for (let y = b.y0; y <= y1; y++) {
        for (let x = b.x0 - 1; x < x1; x++) {
          if (isWall(x, y)) atlas.draw(ctx, wallShadowSprite(x, y), s, ...at(x, y));
        }
      }
    }
    ctx.restore();
    for (let d = b.x0 + b.y0; d <= x1 - 1 + y1 - 1; d++) {
      for (let x = Math.max(b.x0, d - (y1 - 1)); x <= Math.min(x1 - 1, d - b.y0); x++) {
        const y = d - x;
        if (isWall(x, y)) atlas.draw(ctx, wallSprite(x, y), s, ...at(x, y));
      }
    }
    builds++;
    return { canvas, bytes: canvas.width * canvas.height * 4, b, offX, offY };
  }

  function evict() {
    while (lru.size > max) {
      const [k, v] = lru.entries().next().value;
      lru.delete(k);
      bytes -= v.bytes;
    }
  }

  return {
    chunk: C,
    count: Math.ceil(N / C),
    /** 取块（不存在则烘焙）。s = 设备像素 / 世界像素。返回 {canvas, b}。 */
    get(cx, cy, s) {
      const key = `${cx},${cy},${s}`;
      let e = lru.get(key);
      if (e) {
        lru.delete(key);
        lru.set(key, e);
        return e;
      }
      e = bake(cx, cy, s);
      lru.set(key, e);
      bytes += e.bytes;
      evict();
      return e;
    },
    /** LRU 上限：至少 lruMax，且不少于当前可见块数的 1.5 倍（避免可见块互相挤掉造成每帧重烘）。 */
    ensureCapacity(visible) {
      max = Math.max(lruMax, Math.ceil(visible * 1.5));
    },
    setMax(n) {
      max = n;
      evict();
    },
    clear() {
      lru.clear();
      bytes = 0;
    },
    stats: () => ({ count: lru.size, bytes, builds, max }),
  };
}

/** 整图 overview 位图（L16）：地面 + 出口 + 墙，跳过装饰与投影；一次性烘焙。返回 {canvas, offX, offY, s}（设备像素原点）。 */
export function bakeOverview({ map, atlas, makeCanvas, s }) {
  const N = map.size;
  const { minX, minY, maxX, maxY } = worldBounds(N);
  const offX = Math.floor(minX * s);
  const offY = Math.floor(minY * s);
  const canvas = makeCanvas(Math.ceil(maxX * s) - offX, Math.ceil(maxY * s) - offY);
  const ctx = canvas.getContext('2d');
  const exitSeat = new Map(map.exits.map(([x, y], i) => [y * N + x, i]));
  for (let d = 0; d <= 2 * (N - 1); d++) {
    for (let x = Math.max(0, d - N + 1); x <= Math.min(N - 1, d); x++) {
      const y = d - x;
      const [wx, wy] = tileCenter(x, y);
      const px = wx * s - offX;
      const py = wy * s - offY;
      if (map.grid[y * N + x]) {
        const seat = exitSeat.get(y * N + x);
        atlas.draw(ctx, seat === undefined ? floorSprite(x, y) : exitSprite(seat), s, px, py);
      } else {
        atlas.draw(ctx, wallSprite(x, y), s, px, py);
      }
    }
  }
  return { canvas, offX, offY, s, bytes: canvas.width * canvas.height * 4 };
}
