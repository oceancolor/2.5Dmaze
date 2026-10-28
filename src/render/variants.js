// 变体分布（docs/03 §5）：确定性、无状态，只依赖格坐标。烘焙 chunk 与样张页共用。

/** 03 §5 的 hash（乘法用 Math.imul 保持 32 位语义）。 */
export function tileHash(gx, gy) {
  let h = Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 二级 hash（装饰选型用），与 tileHash 去相关。 */
export function tileHash2(gx, gy) {
  return tileHash(gx * 3 + 101, gy * 7 + 211);
}

/** 地面变体 0–4：chunk 主色 (cx+2cy)%4，再按格 hash 8% 替换为 F5 砖纹。 */
export function floorVariant(gx, gy, chunk = 8) {
  const h = tileHash(gx, gy);
  if ((h & 0xffff) / 65536 < 0.08) return 4;
  const cx = Math.floor(gx / chunk);
  const cy = Math.floor(gy / chunk);
  return (cx + 2 * cy) % 4;
}

/** 装饰：返回 -1（无）或 0–2。blocked(gx,gy) 为 true 的格（出口 2 格、出生 3 格邻域）不放。 */
export function decoVariant(gx, gy, density = 0.15, blocked = null) {
  if (blocked && blocked(gx, gy)) return -1;
  const h = tileHash(gx + 977, gy + 433);
  if ((h & 0xffff) / 65536 >= density) return -1;
  return tileHash2(gx, gy) % 3;
}

/**
 * 墙变体 0–3（bit0 日出纹、bit1 转角柱头）：hash%4；墙角（非直线段）强制柱头。
 * isWall(x,y) 越界应返回 true。
 */
export function wallVariant(gx, gy, isWall) {
  const n = isWall(gx, gy - 1);
  const s = isWall(gx, gy + 1);
  const e = isWall(gx + 1, gy);
  const w = isWall(gx - 1, gy);
  const straight = (n && s && !e && !w) || (e && w && !n && !s);
  let v = tileHash(gx, gy) % 4;
  if (!straight) v |= 2;
  return v;
}
