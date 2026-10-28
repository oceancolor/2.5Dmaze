// 坐标 (x,y)：x 向右、y 向下；格索引 = y*size + x（SPEC §1.1）

export const DIR = Object.freeze({ N: 0, E: 1, S: 2, W: 3, STAY: 4 });
export const STAY = 4;
export const DX = Object.freeze([0, 1, 0, -1, 0]);
export const DY = Object.freeze([-1, 0, 1, 0, 0]);
export const DIR_NAMES = Object.freeze(['N', 'E', 'S', 'W', 'STAY']);
/** 记录用单字符：N E S W，'.' = STAY，'-' = 不在场 */
export const DIR_CHARS = Object.freeze(['N', 'E', 'S', 'W', '.']);
export const OFF_BOARD_CHAR = '-';

/**
 * 归一化意图 → 0..4；undefined/null → STAY；无法识别 → -1（调用方按 STAY 处理并记事件）。
 * @param {unknown} v
 */
export function toDir(v) {
  if (v === undefined || v === null) return STAY;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 4 ? v : -1;
  switch (v) {
    case 'N': return 0;
    case 'E': return 1;
    case 'S': return 2;
    case 'W': return 3;
    case 'STAY':
    case '.': return 4;
    default: return -1;
  }
}

export const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
export const manh = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

/** 边界出口格向内一步的格（出口必在边上且非角）。 */
export function inwardOf(x, y, size) {
  if (x === 0) return [1, y];
  if (x === size - 1) return [size - 2, y];
  if (y === 0) return [x, 1];
  if (y === size - 1) return [x, size - 2];
  return [x, y];
}
