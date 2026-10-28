// 全项目唯一允许出现随机源的文件（SPEC §12）。mulberry32 + 具名子流。
// 流对象是普通 { s }，可被克隆/哈希/存档，因此能放进对局状态。

export const STREAM = Object.freeze({ MAZE: 1, PLACE: 2, CHEST: 3, AI: 4 });

export function subSeed(seed, k) {
  let h = (seed ^ Math.imul(k, 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createStream(seed) {
  return { s: seed >>> 0 };
}

/** [0,1) */
export function next(st) {
  st.s = (st.s + 0x6D2B79F5) >>> 0;
  let t = Math.imul(st.s ^ (st.s >>> 15), 1 | st.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [lo, hi] 闭区间整数 */
export function randInt(st, lo, hi) {
  return lo + Math.floor(next(st) * (hi - lo + 1));
}

/** 种子归一化：数字 → uint32；字符串 → FNV-1a。 */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
  if (typeof seed === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  throw new Error(`invalid seed: ${String(seed)}`);
}

/** 仅供 UI 生成“随机种子”。内核 / AI 不得调用。 */
export function freshSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
