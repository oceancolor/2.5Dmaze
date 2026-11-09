// 特效（2026-11-09）：拾取宝石 / 凑齐一套 / 开宝箱（得分 · 加体力）/ 到达出口 / 体力耗尽 / 撞墙。
// 纯程序绘制：粒子轨迹由 (seed, 粒子序号) 的哈希决定，只依赖进度 u ∈ [0,1)，不存状态 —— 回放、跳转、倍速下都一致。
// 坐标：调用前 ctx 已 setTransform 到「锚点 = 格心、1 单位 = 1 屏幕 px（×缩放）」。画质 L0 粒子减半。

const TAU = Math.PI * 2;

/** 0..1 的确定性伪随机（seed, i, k）。 */
function rnd(seed, i, k) {
  let h = (seed * 374761393 + i * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const easeOut = (u) => 1 - (1 - u) * (1 - u);
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** 四角星（闪光）。 */
function star(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

/** 地面冲击环（等距压扁的椭圆）。 */
function ring(ctx, u, r0, r1, color, width, yOff = 0) {
  const r = r0 + (r1 - r0) * easeOut(u);
  ctx.strokeStyle = hexA(color, (1 - u) * 0.9);
  ctx.lineWidth = width * (1 - u * 0.6);
  ctx.beginPath();
  ctx.ellipse(0, yOff, r, r * 0.5, 0, 0, TAU);
  ctx.stroke();
}

/** 抛射粒子：从 (0, y0) 出发，初速随机朝上散开，受重力落下。 */
function sparks(ctx, { u, seed, n, color, speed = 60, up = 70, g = 120, size = 2.2, y0 = -14, shape = 'dot', colors = null }) {
  for (let i = 0; i < n; i++) {
    const a = rnd(seed, i, 1) * TAU;
    const sp = speed * (0.45 + 0.55 * rnd(seed, i, 2));
    const vu = up * (0.55 + 0.45 * rnd(seed, i, 3));
    const t = u * (0.75 + 0.25 * rnd(seed, i, 4));
    const x = Math.cos(a) * sp * t;
    const y = y0 + Math.sin(a) * sp * t * 0.5 - vu * t + g * t * t;
    const al = Math.max(0, 1 - u * 1.15);
    const c = colors ? colors[i % colors.length] : color;
    const sz = size * (0.7 + 0.6 * rnd(seed, i, 5)) * (1 - u * 0.4);
    if (shape === 'star') star(ctx, x, y, sz * 1.8, hexA(c, al));
    else if (shape === 'coin') {
      ctx.fillStyle = hexA('#C98A1E', al);
      ctx.beginPath();
      ctx.ellipse(x, y, sz * 1.5, sz * 1.5 * Math.abs(Math.cos((u * 9 + i) * 1.3)) + 0.4, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = hexA('#FFE08A', al);
      ctx.beginPath();
      ctx.ellipse(x - 0.4, y - 0.4, sz, sz * Math.abs(Math.cos((u * 9 + i) * 1.3)) + 0.2, 0, 0, TAU);
      ctx.fill();
    } else if (shape === 'plus') {
      ctx.fillStyle = hexA(c, al);
      ctx.fillRect(x - sz * 1.4, y - sz * 0.45, sz * 2.8, sz * 0.9);
      ctx.fillRect(x - sz * 0.45, y - sz * 1.4, sz * 0.9, sz * 2.8);
    } else if (shape === 'confetti') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((u * 8 + i) * (rnd(seed, i, 6) > 0.5 ? 1 : -1));
      ctx.fillStyle = hexA(c, al);
      ctx.fillRect(-sz, -sz * 0.45, sz * 2, sz * 0.9);
      ctx.restore();
    } else {
      ctx.fillStyle = hexA(c, al);
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, TAU);
      ctx.fill();
    }
  }
}

/** 放射光芒（宝箱开启时从箱口射出）。 */
function rays(ctx, u, color, n, len, y0) {
  const al = u < 0.15 ? u / 0.15 : Math.max(0, 1 - (u - 0.15) / 0.65);
  if (al <= 0) return;
  ctx.save();
  ctx.translate(0, y0);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.36 + Math.sin(u * 6 + i) * 0.04;
    const l = len * (0.7 + 0.3 * Math.sin(i * 2.1)) * (0.6 + 0.4 * easeOut(u));
    const g = ctx.createLinearGradient(0, 0, Math.cos(a) * l, Math.sin(a) * l);
    g.addColorStop(0, hexA(color, 0.55 * al));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a - 0.09) * l, Math.sin(a - 0.09) * l);
    ctx.lineTo(Math.cos(a + 0.09) * l, Math.sin(a + 0.09) * l);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** 柔光（screen 叠加的径向渐变）。 */
function bloom(ctx, x, y, r, color, a) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(color, a));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

const RAINBOW = ['#E8384F', '#FFC94A', '#3FBF6A', '#3E8EE0', '#9B5DE5'];

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{kind:string, u:number, seed:number, color?:string, quality?:number}} l
 */
export function drawBurst(ctx, l) {
  const { kind, u } = l;
  const seed = l.seed | 0;
  const q = l.quality ?? 2;
  const k = q >= 1 ? 1 : 0.5;
  const c = l.color || '#FFFFFF';
  switch (kind) {
    case 'gem': // 宝石：闪光 + 冲击环 + 同色碎光向上散开
      bloom(ctx, 0, -14, 22, c, 0.5 * (1 - u));
      ring(ctx, Math.min(1, u * 1.3), 4, 22, c, 2.4);
      sparks(ctx, { u, seed, n: Math.round(12 * k), color: c, speed: 42, up: 66, g: 70, size: 2.0, shape: 'dot' });
      sparks(ctx, { u, seed: seed + 7, n: Math.round(6 * k), color: '#FFFFFF', speed: 30, up: 80, g: 40, size: 2.2, shape: 'star' });
      break;
    case 'set': // 凑齐一套：彩虹环 + 五色星雨
      bloom(ctx, 0, -18, 40, '#FFF3C4', 0.6 * (1 - u));
      ring(ctx, u, 8, 46, '#FFD84D', 3.2);
      ring(ctx, Math.min(1, u * 1.25), 4, 34, '#FFFFFF', 2.0, -2);
      sparks(ctx, { u, seed, n: Math.round(26 * k), colors: RAINBOW, speed: 70, up: 110, g: 90, size: 2.6, shape: 'star' });
      break;
    case 'chestScore': // 开箱得分：金光芒 + 金币抛起落下
      rays(ctx, u, '#FFE7A0', 7, 52, -16);
      bloom(ctx, 0, -16, 30, '#FFD86A', 0.55 * (1 - u));
      sparks(ctx, { u, seed, n: Math.round(14 * k), speed: 34, up: 110, g: 190, size: 2.4, y0: -16, shape: 'coin' });
      sparks(ctx, { u, seed: seed + 3, n: Math.round(6 * k), color: '#FFF6D0', speed: 26, up: 70, g: 30, size: 2.0, y0: -16, shape: 'star' });
      break;
    case 'chestStamina': // 开箱加体力：青绿光柱 + 「+」号缓缓上升
      rays(ctx, u, '#A8F0C8', 5, 46, -16);
      bloom(ctx, 0, -16, 30, '#7FE3B0', 0.5 * (1 - u));
      sparks(ctx, { u, seed, n: Math.round(12 * k), color: '#5FD79A', speed: 20, up: 58, g: 0, size: 2.4, y0: -14, shape: 'plus' });
      sparks(ctx, { u, seed: seed + 5, n: Math.round(8 * k), color: '#E6FFF2', speed: 16, up: 46, g: 0, size: 1.6, y0: -10, shape: 'dot' });
      break;
    case 'escape': // 到达出口：座位色彩纸 + 光环
      bloom(ctx, 0, -22, 36, c, 0.55 * (1 - u));
      ring(ctx, u, 6, 40, c, 3.0);
      sparks(ctx, { u, seed, n: Math.round(22 * k), colors: [c, '#FFFFFF', '#FFD84D'], speed: 56, up: 120, g: 150, size: 2.6, y0: -24, shape: 'confetti' });
      break;
    case 'fail': // 体力耗尽：灰色烟团往上散
      for (let i = 0; i < Math.round(7 * k); i++) {
        const a = rnd(seed, i, 1) * TAU;
        const r = 6 + 16 * easeOut(u) * (0.6 + 0.4 * rnd(seed, i, 2));
        const x = Math.cos(a) * r;
        const y = -10 + Math.sin(a) * r * 0.45 - 20 * u;
        ctx.fillStyle = `rgba(120,116,110,${0.42 * (1 - u)})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + 6 * u, 0, TAU);
        ctx.fill();
      }
      break;
    case 'bump': // 撞墙：两三缕尘土
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.6;
        const r = 4 + 10 * easeOut(u);
        ctx.fillStyle = `rgba(190,176,150,${0.5 * (1 - u)})`;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, -4 + Math.sin(a) * r * 0.5, 2.2 + 2 * u, 0, TAU);
        ctx.fill();
      }
      break;
    default:
      break;
  }
}

/** 各特效的时长倍数（× 该回合的 pickMs / 倍速）。 */
export const FX_DUR = Object.freeze({ gem: 1.7, set: 2.6, chestScore: 2.4, chestStamina: 2.4, escape: 2.8, fail: 2.2, bump: 0.9 });
