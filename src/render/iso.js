// 等距几何（SPEC §11、docs/03 §3.0）。格心换算只允许写在这里。
// 2:1 等距：tile 64×32；sprite 画布 64×64；tile 锚点 (32,32)，角色/道具锚点 (32,56)。

export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = 32;
export const HALF_H = 16;
/** 墙侧棱高度（顶面菱形 32 + 侧棱 16 = 剪影 48）。 */
export const WALL_SIDE = 16;
export const SPRITE = 64;
export const ANCHOR_TILE = Object.freeze([32, 32]);
export const ANCHOR_ACTOR = Object.freeze([32, 56]);

/** 格 (x,y) 的地面菱形中心（世界坐标）。 */
export function tileCenter(x, y) {
  return [(x - y) * HALF_W, (x + y) * HALF_H + HALF_H];
}

/** 世界坐标 → 连续格坐标（tileCenter 的逆）。 */
export function worldToTile(wx, wy) {
  const a = wx / HALF_W; // x - y
  const b = (wy - HALF_H) / HALF_H; // x + y
  return [(a + b) / 2, (b - a) / 2];
}

/** tile 类 sprite 左上角。 */
export function tileOrigin(x, y) {
  const [cx, cy] = tileCenter(x, y);
  return [cx - ANCHOR_TILE[0], cy - ANCHOR_TILE[1]];
}

/** 角色/道具 sprite 左上角（可传连续坐标做插值）。 */
export function actorOrigin(x, y) {
  const [cx, cy] = tileCenter(x, y);
  return [cx - ANCHOR_ACTOR[0], cy - ANCHOR_ACTOR[1]];
}

/** 全图包围盒：size=128 → 8192×4112，y ∈ [-16, 4096]。 */
export function worldBounds(size) {
  const minX = -(size - 1) * HALF_W - HALF_W;
  const maxX = (size - 1) * HALF_W + HALF_W;
  const minY = HALF_H - 32; // 墙顶 = 格心 - 32
  const maxY = (2 * size - 2) * HALF_H + HALF_H + HALF_H; // 最下格菱形下顶点
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 绘制深度键：按 (x+y) 行序，同行按 x。 */
export const depthKey = (x, y) => x + y;

/** 网格方向 N/E/S/W 在屏幕上的朝向：fx = 屏幕水平朝向，front = 是否面向镜头。 */
export const FACING = Object.freeze({
  n: Object.freeze({ fx: 1, front: false }),
  e: Object.freeze({ fx: 1, front: true }),
  s: Object.freeze({ fx: -1, front: true }),
  w: Object.freeze({ fx: -1, front: false }),
});
export const DIR_LETTERS = Object.freeze(['n', 'e', 's', 'w']);
