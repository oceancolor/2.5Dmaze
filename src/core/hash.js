// FNV-1a 32 位 + 规范化 JSON（键排序、TypedArray 转数组）。

export function fnv1a(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fnv1aBytes(bytes, h = 0x811c9dc5) {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in hashed value');
    return JSON.stringify(v);
  }
  if (ArrayBuffer.isView(v)) return canonicalJSON(Array.from(v));
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}

export const hex8 = (h) => (h >>> 0).toString(16).padStart(8, '0');

/** 动态对局状态的哈希（静态地图单独算 mapHash）。 */
export function stateHash(state) {
  return hex8(fnv1a(canonicalJSON(state)));
}

export function configHash(cfg) {
  return hex8(fnv1a(canonicalJSON(cfg)));
}

export function mapHashOf(grid, size, spawns, exits) {
  const h = fnv1aBytes(grid);
  return hex8(fnv1a(canonicalJSON({ size, spawns, exits }), h));
}
