// 色板常量（docs/03 §1.2–§1.4、§3.3–§3.13 的确切值）与配色核算工具。
// 只放数据与纯函数，不碰 Canvas；渲染层与样张页、测试都从这里取值，保证「同一个常量表」。

/** 座位色：0 玩家 P，1 AI-A，2 AI-B，3 AI-C。出口直接复用，不经 tint（03 §3.8）。 */
export const ACTOR_COLORS = Object.freeze(['#FF3B6B', '#6A4BE0', '#10B8A0', '#F7B32B']);
export const SEAT_KEYS = Object.freeze(['P', 'A', 'B', 'C']);
/** 玩家面板 / 关节色（03 §3.3）。 */
export const PLAYER_PANEL = '#C2185B';
export const HALO = '#FFD84D';

export const INK = '#3B362F'; // 角色/道具描边、深色嵌线、正文
export const LINE = '#5E574C'; // 结构分割线
export const BRASS = '#BFA46A'; // art deco 哑金线脚
export const SEAM = '#C6BCAE'; // 地块缝
export const SHADOW = 'rgba(59,54,47,0.22)';
export const WALL_B_OUTLINE = '#4A443A';

/** 地面 F1–F4 主色；F5 = F1 底 + 砖纹线。 */
export const FLOOR = Object.freeze(['#E9E1D6', '#E6DBDD', '#DCE3DC', '#DBE1E6', '#E9E1D6']);
export const FLOOR_BRICK_LINE = '#D6CBBB';

/** 装饰 D1–D3（alpha 0.22–0.28）。 */
export const DECO = Object.freeze([
  { color: '#DECFBC', alpha: 0.28, name: '日出纹' },
  { color: '#E2D8C8', alpha: 0.26, name: '同心弧' },
  { color: '#E0D5C3', alpha: 0.26, name: '阶梯 chevron' },
]);

/** 墙两套：顶 / 左 / 右（光来自左上，系数 1 / .86 / .72）。 */
export const WALL_SETS = Object.freeze({
  A: Object.freeze({ top: '#B9AD9B', left: '#9F9382', right: '#857A66', outline: null, name: 'A 套 · 暖灰' }),
  B: Object.freeze({ top: '#D5C9BA', left: '#B9AC97', right: '#9A8E7C', outline: WALL_B_OUTLINE, name: 'B 套 · 浅马卡龙' }),
});

/** 宝石：颜色索引与内核 cfg.treasure.gemColors 同序（红黄绿蓝紫）。 */
export const GEM_KEYS = Object.freeze(['RUBY', 'CITRINE', 'EMERALD', 'SAPPHIRE', 'AMETHYST']);
export const GEM_NAMES = Object.freeze(['红', '黄', '绿', '蓝', '紫']);
export const GEM_COLORS_BASE = Object.freeze(['#E8384F', '#F2CE3B', '#3FBF6A', '#4A6FE3', '#932C9B']);

/**
 * 紫宝石候选（SPEC O5，已由用户选定 P2 深梅紫 #932C9B）。旧占位 #B65BD9 与 AI-A 靛紫只差约 30° 色相，
 * 灰度又与红/蓝挤在 L*50 附近；深梅紫把色相推向品红、明度压到红蓝之下。其余候选保留作对照。
 */
export const PURPLE_CANDIDATES = Object.freeze([
  { id: 'P0', hex: '#B65BD9', name: '旧占位紫' },
  { id: 'P1', hex: '#D24FD9', name: '品红紫' },
  { id: 'P2', hex: '#932C9B', name: '深梅紫（已选定）' },
  { id: 'P3', hex: '#E9A0EE', name: '浅丁香' },
]);

/**
 * 宝箱配色候选（03 未定，我方自定）。线脚统一用场景哑金 BRASS，避免与光环金 #FFD84D 撞色。
 * reveal：score = 金色爆发，stamina = 蓝色注入。爆发金偏橙偏白，与光环的柠檬金拉开。
 */
export const CHEST_PALETTES = Object.freeze([
  { id: 'K1', name: '胡桃木 + 哑金', top: '#8C5A36', left: '#764A2C', right: '#5F3B23', trim: BRASS, lock: '#E9D9A8' },
  { id: 'K2', name: '墨绿漆 + 哑金', top: '#3E6E60', left: '#33594E', right: '#28463D', trim: BRASS, lock: '#E9D9A8' },
  { id: 'K3', name: '藏青漆 + 哑金', top: '#3E4F86', left: '#33416E', right: '#283357', trim: BRASS, lock: '#E9D9A8' },
]);
export const REVEAL = Object.freeze({
  score: { core: '#FFF4D6', mid: '#FFB43A', edge: 'rgba(255,140,40,0)', name: '得分 · 橙金爆发' },
  stamina: { core: '#E8FBFF', mid: '#45B6F0', edge: 'rgba(40,140,230,0)', name: '体力 · 蓝色注入' },
});

/** 体力条四档（03 §3.10）。 */
export const STAMINA_TIERS = Object.freeze([
  { min: 60, color: '#3FBF6A', cells: 4 },
  { min: 30, color: '#F2CE3B', cells: 3 },
  { min: 10, color: '#F08A2E', cells: 2 },
  { min: 0, color: '#E8384F', cells: 1 },
]);

export const UI = Object.freeze({
  panel: 'rgba(239,233,224,0.96)',
  text: INK,
  disabled: '#A29A8C',
  plate: '#F3EDE4',
  plateIdle: '#E9E1D6',
  speedBg: 'rgba(42,38,32,0.72)',
  font: '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
});

// ---------- 颜色运算 ----------

/** '#RRGGBB' | 'rgb(...)' | 'rgba(...)' → [r,g,b,a]（0–255, a 0–1）。 */
export function parseColor(c) {
  if (c[0] === '#') {
    const h = c.length === 4 ? c.slice(1).split('').map((k) => k + k).join('') : c.slice(1);
    return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)).concat(h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`无法解析颜色 ${c}`);
  const p = m[1].split(',').map((s) => Number(s.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

export function toHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function rgba(c, a) {
  const [r, g, b] = parseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** 线性插值混色，t=0 → a，t=1 → b。 */
export function mix(a, b, t) {
  const p = parseColor(a);
  const q = parseColor(b);
  return toHex([0, 1, 2].map((k) => p[k] + (q[k] - p[k]) * t));
}

/** 各通道乘系数（外圈墙压暗用）。 */
export function shade(c, k) {
  const p = parseColor(c);
  return toHex([p[0] * k, p[1] * k, p[2] * k]);
}

/** 去饱和：向同明度灰靠拢 t（0–1）。 */
export function desaturate(c, t) {
  const [r, g, b] = parseColor(c);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return toHex([r + (y - r) * t, g + (y - g) * t, b + (y - b) * t]);
}

/** HSV：h 0–360，s 0–1，v 0–255。 */
export function hsv(c) {
  const [r, g, b] = parseColor(c);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx ? d / mx : 0, v: mx };
}

const lin = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** WCAG 相对亮度。 */
export function luminance(c) {
  const [r, g, b] = parseColor(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** CIE L*（D65）。 */
export function lstar(c) {
  const y = luminance(c);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 两色色相差（0–180）。 */
export function hueGap(a, b) {
  const d = Math.abs(hsv(a).h - hsv(b).h) % 360;
  return d > 180 ? 360 - d : d;
}

/** 按候选紫生成五色宝石表。 */
export function gemColors(purple = GEM_COLORS_BASE[4]) {
  return [...GEM_COLORS_BASE.slice(0, 4), purple];
}

/** 体力百分比 → 档位。 */
export function staminaTier(pct) {
  return STAMINA_TIERS.find((t) => pct > t.min) ?? STAMINA_TIERS[STAMINA_TIERS.length - 1];
}
