// 程序化 sprite（docs/03 §3）。所有函数都在 64×64 的 sprite 局部坐标里作画，调用方负责平移/缩放。
// 形状语言：只用直线段与圆弧（含 ellipse）；发光只用渐变 + alpha（03 §1.6）。
// 外轮廓不画进 sprite，由 outlineRing() 在烘焙时统一加 1px #3B362F（03 §1.6「渲染层统一描边」）。

import {
  ACTOR_COLORS, PLAYER_PANEL, HALO, INK, LINE, BRASS, SEAM, SHADOW,
  FLOOR, FLOOR_BRICK_LINE, DECO, WALL_SETS, GEM_COLORS_BASE, CHEST_PALETTES, REVEAL,
  mix, shade, rgba, parseColor,
} from './palette.js';
import { FACING } from './iso.js';

const TAU = Math.PI * 2;

// ---------- 画布与路径工具 ----------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function line(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

function ell(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, TAU);
}

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 胶囊（两端圆头的粗线段），用于手臂、天线杆。 */
function capsule(ctx, x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
  ctx.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

/** 先整体填暗色，再把主色向左上错位重填 → 右下留出背光边（光来自左上）。 */
function shaded(ctx, path, main, dark, dx = -2, dy = -1.5) {
  path();
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.save();
  path();
  ctx.clip();
  ctx.translate(dx, dy);
  path();
  ctx.fillStyle = main;
  ctx.fill();
  ctx.restore();
}

/** 在 path 的裁剪区内执行 fn。 */
function within(ctx, path, fn) {
  ctx.save();
  path();
  ctx.clip();
  fn();
  ctx.restore();
}

/** 把 ground 平面（u,v 正交坐标）映射到以 (cx,cy) 为中心的等距菱形：圆 → 等距椭圆，方 → 菱形。 */
function groundSpace(ctx, cx, cy) {
  ctx.translate(cx, cy);
  ctx.scale(1, 0.5);
  ctx.rotate(Math.PI / 4);
}

// ---------- 地形：地面 / 装饰 / 墙 / 出口（锚点 32,32） ----------

export const FLOOR_DIAMOND = Object.freeze([[32, 16], [64, 32], [32, 48], [0, 32]]);
const WALL_TOP = [[32, 0], [64, 16], [32, 32], [0, 16]];
const WALL_LEFT = [[0, 16], [32, 32], [32, 48], [0, 32]];
const WALL_RIGHT = [[32, 32], [64, 16], [64, 32], [32, 48]];
export const WALL_SILHOUETTE = Object.freeze([[32, 0], [64, 16], [64, 32], [32, 48], [0, 32], [0, 16]]);

/** 地面 F1–F5（idx 0–4）。seam=true 时画上沿两条缝线（相邻格各画自己的上沿，不重复）。 */
export function drawFloor(ctx, idx, { seam = true } = {}) {
  poly(ctx, FLOOR_DIAMOND);
  ctx.fillStyle = FLOOR[idx];
  ctx.fill();
  if (idx === 4) {
    within(ctx, () => poly(ctx, FLOOR_DIAMOND), () => {
      ctx.strokeStyle = FLOOR_BRICK_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 4; k++) {
        const f = k / 4;
        // 平行于两组菱形边的细分线 → 子菱形宽 16px（03 §1.2 F5「间距 16px」）
        ctx.moveTo(f * 32, 32 - f * 16); ctx.lineTo(32 + f * 32, 48 - f * 16);
        ctx.moveTo(f * 32, 32 + f * 16); ctx.lineTo(32 + f * 32, 16 + f * 16);
      }
      ctx.stroke();
    });
  }
  if (seam) {
    ctx.strokeStyle = SEAM;
    ctx.lineWidth = 1;
    line(ctx, [[0, 32], [32, 16], [64, 32]]);
    ctx.stroke();
  }
}

/** 装饰 D1–D3（idx 0–2），叠在地面上，菱形内缩 4px（y∈[20,44]）。 */
export function drawDeco(ctx, idx, { alphaScale = 1 } = {}) {
  const d = DECO[idx];
  const inset = [[32, 20], [56, 32], [32, 44], [8, 32]];
  within(ctx, () => poly(ctx, inset), () => {
    ctx.globalAlpha = Math.min(1, d.alpha * alphaScale);
    ctx.fillStyle = d.color;
    ctx.strokeStyle = d.color;
    groundSpace(ctx, 32, 32);
    const H = 17; // inset 菱形在 ground 平面的半边长
    if (idx === 0) {
      // 日出纹：前角发出的放射扇形（交替楔形）+ 半圆日轮
      const ox = H;
      const oy = H;
      ctx.beginPath();
      const n = 9;
      for (let k = 0; k < n; k += 2) {
        const a0 = Math.PI + (k / n) * (Math.PI / 2);
        const a1 = Math.PI + ((k + 1) / n) * (Math.PI / 2);
        ctx.moveTo(ox, oy);
        ctx.arc(ox, oy, 2 * H, a0, a1);
        ctx.closePath();
      }
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ox, oy, H * 0.6, Math.PI, Math.PI * 1.5);
      ctx.lineTo(ox, oy);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 1) {
      // 同心弧：三道等距圆环
      ctx.lineWidth = 2.6;
      for (const r of [5, 10.5, 16]) {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.stroke();
      }
    } else {
      // 阶梯 chevron：三层嵌套 V
      ctx.lineWidth = 3;
      ctx.lineJoin = 'miter';
      for (const s of [-9, 0, 9]) {
        line(ctx, [[-H + 3 + s, H - 3 + s], [-H + 3 + s, -H + 3 + s], [H - 3 + s, -H + 3 + s]]);
        ctx.stroke();
      }
    }
  });
}

/** 墙脚接触阴影：沿墙底两条前棱向下 3px（B 套硬要求，03 §1.9）。画在地面层。 */
export function drawWallContactShadow(ctx) {
  poly(ctx, [[0, 32], [32, 48], [64, 32], [64, 35], [32, 51], [0, 35]]);
  ctx.fillStyle = SHADOW;
  ctx.fill();
}

/**
 * 墙体。variant 0–3：bit0 = 日出纹线脚，bit1 = 转角柱头（03 §1.2 ②、§5）。
 * border=true：外圈墙，乘 render.borderWallShade 压暗 + 顶棱哑金线（03 §3.13）。
 */
export function drawWall(ctx, set, variant, { border = false, borderShade = 0.855 } = {}) {
  const P = WALL_SETS[set];
  const k = border ? borderShade : 1;
  const top = shade(P.top, k);
  const left = shade(P.left, k);
  const right = shade(P.right, k);
  const sunburst = (variant & 1) === 1;
  const pillar = (variant & 2) === 2;

  poly(ctx, WALL_LEFT); ctx.fillStyle = left; ctx.fill();
  poly(ctx, WALL_RIGHT); ctx.fillStyle = right; ctx.fill();
  poly(ctx, WALL_TOP); ctx.fillStyle = top; ctx.fill();

  ctx.lineWidth = 1;
  // 受光棱 1px 提亮（左上两条顶边）
  ctx.strokeStyle = rgba('#FFFFFF', 0.35);
  line(ctx, [[0.5, 16], [32, 0.5], [63.5, 16]]);
  ctx.stroke();

  // 侧面：哑金线脚（顶棱下 3px）+ 深色嵌线（底边上 3px）
  ctx.strokeStyle = BRASS;
  line(ctx, [[0, 19.5], [32, 35.5], [64, 19.5]]);
  ctx.stroke();
  ctx.strokeStyle = rgba(INK, 0.45);
  line(ctx, [[0, 28.5], [32, 44.5], [64, 28.5]]);
  ctx.stroke();

  if (pillar) {
    // 转角柱头：侧面两端的壁柱竖线 + 顶面内缩阶梯帽
    ctx.strokeStyle = rgba(LINE, 0.6);
    line(ctx, [[5.5, 19], [5.5, 34.5]]); ctx.stroke();
    line(ctx, [[26.5, 29.5], [26.5, 45]]); ctx.stroke();
    line(ctx, [[37.5, 29.5], [37.5, 45]]); ctx.stroke();
    line(ctx, [[58.5, 19], [58.5, 34.5]]); ctx.stroke();
    const cap = [[32, 6], [52, 16], [32, 26], [12, 16]];
    const cap2 = [[32, 10], [44, 16], [32, 22], [20, 16]];
    poly(ctx, cap); ctx.fillStyle = mix(top, '#FFFFFF', 0.16); ctx.fill();
    ctx.strokeStyle = rgba(LINE, 0.6);
    line(ctx, [[12, 16], [32, 26], [52, 16]]); ctx.stroke();
    poly(ctx, cap2); ctx.fillStyle = mix(top, '#FFFFFF', 0.3); ctx.fill();
    line(ctx, [[20, 16], [32, 22], [44, 16]]); ctx.stroke();
  }
  if (sunburst) {
    // 日出纹：从顶面前角发出的放射线 + 弧（在柱头内缩区内时收短）
    within(ctx, () => poly(ctx, WALL_TOP), () => {
      ctx.strokeStyle = rgba(LINE, 0.6);
      ctx.lineWidth = 1;
      groundSpace(ctx, 32, 16);
      const H = 22.6;
      const R = pillar ? 13 : 24;
      ctx.beginPath();
      for (let kk = 0; kk <= 6; kk++) {
        const a = Math.PI + (kk / 6) * (Math.PI / 2);
        ctx.moveTo(H, H);
        ctx.lineTo(H + Math.cos(a) * (H + R), H + Math.sin(a) * (H + R));
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(H, H, H * 0.75, Math.PI, Math.PI * 1.5);
      ctx.stroke();
      ctx.strokeStyle = rgba(BRASS, 0.7);
      ctx.beginPath();
      ctx.arc(H, H, H * 0.45, Math.PI, Math.PI * 1.5);
      ctx.stroke();
    });
  }
  if (border) {
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = 1;
    poly(ctx, [[32, 0.5], [63.5, 16], [32, 31.5], [0.5, 16]]);
    ctx.stroke();
  }
}

/** 出口圆盘（静态层）：三层同心阶梯 + 中央实心点，2px 白内描边 + 1px 深色外描边（03 §3.8）。 */
export function drawExitDisc(ctx, color, { breath = 0 } = {}) {
  const cx = 32;
  const cy = 32;
  const tiers = [
    { rx: 30, ry: 15, c: mix(color, '#FFFFFF', 0.55) },
    { rx: 24, ry: 12, c: mix(color, '#FFFFFF', 0.28) },
    { rx: 18, ry: 9, c: color },
  ];
  // 外描边 1px 深色
  ell(ctx, cx, cy, 30.5, 15.5);
  ctx.fillStyle = INK;
  ctx.fill();
  tiers.forEach((t, i) => {
    // 阶梯侧壁：下沿 1.5px 暗带（只往下沉，不高出地面）
    ell(ctx, cx, cy + 1.5, t.rx, t.ry);
    ctx.fillStyle = mix(t.c, INK, 0.28);
    ctx.fill();
    ell(ctx, cx, cy, t.rx, t.ry);
    ctx.fillStyle = t.c;
    ctx.fill();
    if (i === 0) {
      ctx.save();
      ell(ctx, cx, cy, t.rx, t.ry);
      ctx.clip();
      ell(ctx, cx, cy, t.rx - 1, t.ry - 0.5);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    } else {
      ell(ctx, cx, cy, t.rx, t.ry);
      ctx.strokeStyle = rgba('#FFFFFF', 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });
  // 中央 3px 同色实心圆（白圈分隔）
  ell(ctx, cx, cy, 4.5, 2.6);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ell(ctx, cx, cy, 3, 1.6);
  ctx.fillStyle = mix(color, INK, 0.15);
  ctx.fill();
  if (breath) {
    ell(ctx, cx, cy, 30, 15);
    ctx.fillStyle = rgba('#FFFFFF', 0.18 * breath);
    ctx.fill();
  }
}

/** 出口脉冲光柱（动态层，可超出画布向上 40px）。t = 墙钟秒。 */
export function drawExitBeam(ctx, color, t = 0) {
  const cx = 32;
  const cy = 32;
  const p = 0.5 + 0.5 * Math.sin((t * TAU) / 1.6);
  const h = 40;
  const g = ctx.createLinearGradient(0, cy, 0, cy - h);
  g.addColorStop(0, rgba(color, 0.45 * (0.65 + 0.35 * p)));
  g.addColorStop(1, rgba(color, 0));
  ctx.beginPath();
  ctx.ellipse(cx, cy, 10, 5, 0, 0, Math.PI);
  ctx.lineTo(cx - 10, cy - h);
  ctx.lineTo(cx + 10, cy - h);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ell(ctx, cx, cy, 10, 5);
  ctx.fillStyle = rgba(color, 0.3 + 0.2 * p);
  ctx.fill();
  // 上升光点
  for (let i = 0; i < 3; i++) {
    const q = (t / 1.6 + i / 3) % 1;
    ell(ctx, cx + (i - 1) * 4, cy - 4 - q * (h - 8), 1.2, 1.2);
    ctx.fillStyle = rgba('#FFFFFF', 0.8 * (1 - q));
    ctx.fill();
  }
}

// ---------- 角色（锚点 32,56） ----------

/** 落地投影：椭圆中心 (32,58) rx14/ry5（03 §3.0.3）。lift = 离地高度，越高越小越淡。 */
export function drawShadow(ctx, { lift = 0, rx = 14, ry = 5, cx = 32, cy = 58 } = {}) {
  const k = Math.max(0.55, 1 - lift / 16);
  ell(ctx, cx, cy, rx * k, ry * k);
  ctx.fillStyle = rgba('#3B362F', 0.22 * k);
  ctx.fill();
}

/** 玩家光环：贴地双同心椭圆 + 外发光，1.6s 脉动（墙钟，不随倍速）。可超出 64×64。 */
export function drawHalo(ctx, t = 0, { cx = 32, cy = 56, alpha = 1 } = {}) {
  const p = 0.5 + 0.5 * Math.sin((t * TAU) / 1.6);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.5);
  const R = 30 + 2 * p;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, rgba(HALO, 0));
  g.addColorStop(0.45, rgba(HALO, 0.55 * (0.7 + 0.3 * p)));
  g.addColorStop(1, rgba(HALO, 0));
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ell(ctx, cx, cy, 24, 12);
  ctx.strokeStyle = rgba(HALO, 0.75 + 0.25 * p);
  ctx.lineWidth = 2;
  ctx.stroke();
  ell(ctx, cx, cy, 16, 8);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

export const ROBOT_STATES = Object.freeze(['IDLE', 'MOVE', 'PICK', 'BLOCK', 'DEAD']);

/** 每状态帧数（03 §3.2）：玩家 15 帧/向，AI 10 帧/向。 */
export const FRAME_COUNTS = Object.freeze({
  player: Object.freeze({ IDLE: 4, MOVE: 4, PICK: 3, BLOCK: 2, DEAD: 2 }),
  ai: Object.freeze({ IDLE: 2, MOVE: 4, PICK: 2, BLOCK: 1, DEAD: 1 }),
});

const MOVE_POSES = [
  { dy: 2, legs: 'bent', arms: 'out' }, // 蓄力压缩
  { dy: -1, legs: 'stepA', arms: 'swingA' }, // 起跳拉伸
  { dy: -1, legs: 'tuck', arms: 'out' }, // 腾空
  { dy: 0, legs: 'stepB', arms: 'swingB' }, // 下落
];

const POSES = {
  player: {
    IDLE: [{ dy: 0 }, { dy: -1 }, { dy: -1 }, { dy: 0, eyes: 'blink' }],
    MOVE: MOVE_POSES,
    PICK: [{ arms: 'mid' }, { arms: 'up', dy: -1 }, { arms: 'up', dy: -1, eyes: 'happy' }],
    BLOCK: [{ shift: 2, bend: 1, arms: 'out', eyes: 'squint' }, { shift: -2, bend: 1, arms: 'down', eyes: 'squint' }],
    DEAD: [{ dy: 2, eyes: 'x', arms: 'down', bend: 1 }, { dy: 4, eyes: 'x', arms: 'down', bend: 1, desat: 0.6 }],
  },
  ai: {
    IDLE: [{ dy: 0 }, { dy: -1 }],
    MOVE: MOVE_POSES,
    PICK: [{ arms: 'mid' }, { arms: 'up', dy: -1 }],
    BLOCK: [{ shift: 2, bend: 1, arms: 'out' }],
    DEAD: [{ dy: 4, eyes: 'x', arms: 'down', bend: 1, desat: 0.6 }],
  },
};

export function robotPose(kind, state, frame) {
  const list = POSES[kind][state];
  return list[((frame % list.length) + list.length) % list.length];
}

const AI_GRAY = { main: '#F2F2F2', joint: '#8C8C8C' };

/**
 * 画一只机器人。
 * kind: 'player' | 'ai'；dir: 'n'|'e'|'s'|'w'；pass: 'all' | 'body' | 'overlay'。
 * AI 走 03 §3.7 的 tint 流程：body 用灰度画 → tintCanvas() → 再叠 overlay（眼白/瞳/嘴/高光不参与着色）。
 */
export function drawRobot(ctx, { kind = 'player', dir = 's', state = 'IDLE', frame = 0, color = ACTOR_COLORS[0], pass = 'all' } = {}) {
  const pose = robotPose(kind, state, frame);
  const { fx, front } = FACING[dir];
  const gray = kind === 'ai' && pass !== 'all';
  const main = gray ? AI_GRAY.main : color;
  const joint = gray ? AI_GRAY.joint : kind === 'player' ? PLAYER_PANEL : mix(color, INK, 0.35);
  const dark = mix(main, gray ? '#2A2A2A' : INK, 0.22);
  const jointDark = mix(joint, gray ? '#2A2A2A' : INK, 0.25);
  const dy = pose.dy ?? 0;
  const sx = (pose.shift ?? 0) * fx;
  const doBody = pass === 'all' || pass === 'body';
  const doOver = pass === 'all' || pass === 'overlay';

  // 关键几何
  const headCx = 32 + sx + fx * 0.5;
  const headCy = 15 + dy;
  const torsoX = 21 + sx;
  const torsoY = 25 + dy;
  const torsoW = 22;
  const torsoH = 19;
  const faceCx = headCx + (front ? fx * 2.5 : -fx * 2.5);

  const legs = (() => {
    const near = { cx: 32 + sx - fx * 5.5, lift: 0, fwd: 0 };
    const far = { cx: 32 + sx + fx * 5.5 - fx * 0.5, lift: 0, fwd: 0, far: true };
    const L = pose.legs;
    if (L === 'stepA') { near.lift = 2; near.fwd = 1.5; }
    if (L === 'stepB') { far.lift = 2; far.fwd = 1.5; }
    if (L === 'tuck') { near.lift = 2; far.lift = 2; }
    return [far, near];
  })();

  const shoulder = (side) => ({ x: 32 + sx + side * 9, y: torsoY + 4 });
  const handOf = (side, mode, isNear) => {
    const s = shoulder(side);
    let h;
    switch (mode) {
      case 'out': h = { x: s.x + side * 4, y: s.y + 8 }; break;
      case 'mid': h = { x: s.x + side * 3, y: s.y + 3 }; break;
      case 'up': h = { x: s.x + side * 3.5, y: s.y - 12 }; break;
      case 'swingA': h = { x: s.x + side * 2.5 + (isNear ? fx * 3 : -fx * 3), y: s.y + 9 }; break;
      case 'swingB': h = { x: s.x + side * 2.5 + (isNear ? -fx * 3 : fx * 3), y: s.y + 9 }; break;
      default: h = { x: s.x + side * 2.5, y: s.y + 10 };
    }
    h.x = Math.max(19.5, Math.min(44.5, h.x));
    return { s, h };
  };
  const armMode = pose.arms ?? 'down';
  const farSide = fx;
  const nearSide = -fx;

  const drawLeg = (lg) => {
    const top = torsoY + torsoH - 4;
    const bottom = 56 - lg.lift;
    const x = lg.cx + (lg.fwd ? fx * lg.fwd : 0) - 3.5;
    const y = lg.far ? top - 0.5 : top;
    const h = bottom - y - (lg.far ? 0.5 : 0);
    const path = () => rrect(ctx, x, y, 7, h, 3);
    shaded(ctx, path, lg.far ? jointDark : joint, mix(joint, INK, 0.4), -1.5, -1);
    // 脚掌底线
    ctx.strokeStyle = rgba(LINE, 0.6);
    ctx.lineWidth = 1;
    line(ctx, [[x + 1, y + h - 3.5], [x + 6, y + h - 3.5]]);
    ctx.stroke();
  };

  const drawArm = (side, isNear) => {
    const { s, h } = handOf(side, armMode, isNear);
    const path = () => capsule(ctx, s.x, s.y, h.x, h.y, 2.6);
    shaded(ctx, path, isNear ? main : dark, mix(main, INK, 0.3), -1, -1);
    if (isNear) {
      path();
      ctx.strokeStyle = rgba(LINE, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ell(ctx, h.x, h.y, 2.9, 2.9);
    ctx.fillStyle = isNear ? joint : jointDark;
    ctx.fill();
  };

  const headPath = () => ell(ctx, headCx, headCy, 13.5, 10.5);
  const torsoPath = () => rrect(ctx, torsoX, torsoY, torsoW, torsoH, 6);

  const drawAntenna = () => {
    const bend = pose.bend ?? 0;
    const baseX = headCx + (front ? fx * 1.5 : -fx * 1.5);
    const baseY = headCy - 9.5;
    const tipX = baseX - fx * 3 * bend;
    const tipY = baseY - 6 + 2 * bend;
    if (kind === 'player') {
      ctx.strokeStyle = joint;
      ctx.lineWidth = 1.6;
      line(ctx, bend ? [[baseX, baseY], [baseX, baseY - 3], [tipX, tipY]] : [[baseX, baseY], [tipX, tipY]]);
      ctx.stroke();
      ell(ctx, tipX, tipY, 2.2, 2.2);
      ctx.fillStyle = joint;
      ctx.fill();
    } else {
      // AI：短柱天线
      const w = 4;
      const topY = baseY - 3.5 + bend;
      const lean = -fx * 1.5 * bend;
      poly(ctx, [[baseX - w / 2, baseY + 1], [baseX + w / 2, baseY + 1], [baseX + w / 2 + lean, topY], [baseX - w / 2 + lean, topY]]);
      ctx.fillStyle = joint;
      ctx.fill();
      poly(ctx, [[baseX - w / 2 - 0.5 + lean, topY], [baseX + w / 2 + 0.5 + lean, topY], [baseX + w / 2 + 0.5 + lean, topY - 1.5], [baseX - w / 2 - 0.5 + lean, topY - 1.5]]);
      ctx.fillStyle = gray ? '#D0D0D0' : mix(joint, '#FFFFFF', 0.35);
      ctx.fill();
    }
  };

  if (doBody) {
    if (armMode === 'up') {
      // 举手时远侧手臂在头后
      drawArm(farSide, false);
    } else {
      drawArm(farSide, false);
    }
    legs.forEach(drawLeg);
    shaded(ctx, torsoPath, main, dark);
    // 胸板 / 背板
    if (front) {
      const px = 32 + sx + fx * 2 - 5.5;
      const pp = () => rrect(ctx, px, torsoY + 5, 11, 9, 3);
      pp();
      ctx.fillStyle = joint;
      ctx.fill();
      ctx.strokeStyle = rgba(LINE, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const px = 32 + sx - fx * 2 - 6;
      rrect(ctx, px, torsoY + 4, 12, 10, 2);
      ctx.fillStyle = mix(main, gray ? '#2A2A2A' : INK, 0.12);
      ctx.fill();
      ctx.strokeStyle = rgba(LINE, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        ctx.moveTo(px + 2.5, torsoY + 6.5 + k * 2.5);
        ctx.lineTo(px + 9.5, torsoY + 6.5 + k * 2.5);
      }
      ctx.stroke();
    }
    if (armMode !== 'up') drawArm(nearSide, true);
    drawAntenna();
    shaded(ctx, headPath, main, dark, -2.2, -1.8);
    // 头/身分界（结构线）
    ctx.beginPath();
    ctx.ellipse(headCx, headCy, 13.5, 10.5, 0, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = rgba(LINE, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    if (!front) {
      // 后脑检修板
      const bx = headCx - fx * 2.5 - 5;
      rrect(ctx, bx, headCy - 4, 10, 7, 2.5);
      ctx.fillStyle = joint;
      ctx.fill();
      ctx.strokeStyle = rgba(LINE, 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx + 2.5, headCy - 1); ctx.lineTo(bx + 7.5, headCy - 1);
      ctx.moveTo(bx + 2.5, headCy + 1.2); ctx.lineTo(bx + 7.5, headCy + 1.2);
      ctx.strokeStyle = rgba('#000000', 0.25);
      ctx.stroke();
    } else {
      // 侧耳盖
      const ex = headCx - fx * 12.2;
      ell(ctx, ex, headCy + 0.5, 1.8, 3.4);
      ctx.fillStyle = joint;
      ctx.fill();
    }
    if (armMode === 'up') drawArm(nearSide, true);
  }

  if (doOver) {
    // 高光（白色，不参与 tint）
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(headCx, headCy, 10.8, 7.9, 0, Math.PI * 1.1, Math.PI * 1.42);
    ctx.strokeStyle = rgba('#FFFFFF', 0.55);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.stroke();
    line(ctx, [[torsoX + 2.2, torsoY + 6], [torsoX + 2.2, torsoY + 12]]);
    ctx.strokeStyle = rgba('#FFFFFF', 0.4);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    if (front) {
      const eyes = pose.eyes ?? 'open';
      const ey = headCy + 0.5;
      const pts = [
        { x: faceCx - 7, near: fx > 0 },
        { x: faceCx + 7, near: fx < 0 },
      ];
      ctx.lineCap = 'round';
      for (const e of pts) {
        const rx = e.near ? 4.6 : 3.9;
        if (eyes === 'open') {
          ell(ctx, e.x, ey, rx, 5.4);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          const px = e.x + fx * 1.3;
          const py = ey + 0.8;
          ell(ctx, px, py, 2.3, 2.5);
          ctx.fillStyle = INK;
          ctx.fill();
          if (kind === 'player') {
            ell(ctx, px - 0.8, py - 1.1, 0.9, 0.9);
            ctx.fillStyle = '#FFFFFF';
            ctx.fill();
          }
        } else if (eyes === 'blink') {
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.6;
          line(ctx, [[e.x - rx + 1, ey + 1], [e.x + rx - 1, ey + 1]]);
          ctx.stroke();
        } else if (eyes === 'happy') {
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.7;
          ctx.beginPath();
          ctx.arc(e.x, ey + 2, rx - 1.2, Math.PI * 1.1, Math.PI * 1.9);
          ctx.stroke();
        } else if (eyes === 'squint') {
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.6;
          const s = e.x < faceCx ? 1 : -1;
          line(ctx, [[e.x - s * 3, ey - 2.5], [e.x + s * 2, ey + 0.5], [e.x - s * 3, ey + 3]]);
          ctx.stroke();
        } else if (eyes === 'x') {
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.7;
          ctx.beginPath();
          ctx.moveTo(e.x - 2.6, ey - 2.6); ctx.lineTo(e.x + 2.6, ey + 2.6);
          ctx.moveTo(e.x + 2.6, ey - 2.6); ctx.lineTo(e.x - 2.6, ey + 2.6);
          ctx.stroke();
        }
      }
      if (kind === 'ai') {
        // poker face：2px 一字嘴
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.lineCap = 'butt';
        line(ctx, [[faceCx - 3, headCy + 7], [faceCx + 3, headCy + 7]]);
        ctx.stroke();
      }
    }
  }
}

// ---------- 宝石（锚点 32,56；包围盒 x∈[23,41] y∈[34,54]） ----------

/** 宝石外形路径。b = 底边 y（基准 54，悬浮时更小）。返回 {cx, cy, r}。 */
function gemPath(ctx, c, b) {
  switch (c) {
    case 0: { // 红：竖长尖锥菱形 1:1.7
      const cy = b - 10;
      poly(ctx, [[32, b - 20], [38, cy], [32, b], [26, cy]]);
      return { cx: 32, cy, r: 8 };
    }
    case 1: { // 黄：六角放射星（12 角，唯一凹多边形）
      const cy = b - 10;
      const pts = [];
      for (let k = 0; k < 12; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 6;
        const r = k % 2 ? 5.3 : 10;
        pts.push([32 + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      poly(ctx, pts);
      return { cx: 32, cy, r: 9 };
    }
    case 2: { // 绿：八边切角方 1.05
      const w = 17;
      const h = 16.2;
      const x = 32 - w / 2;
      const y = b - h;
      const k = 4.6;
      poly(ctx, [[x + k, y], [x + w - k, y], [x + w, y + k], [x + w, y + h - k], [x + w - k, y + h], [x + k, y + h], [x, y + h - k], [x, y + k]]);
      return { cx: 32, cy: y + h / 2, r: 8 };
    }
    case 3: { // 蓝：圆钻（纯曲线）0.8
      const cy = b - 10;
      ell(ctx, 32, cy, 8, 10);
      return { cx: 32, cy, r: 8.5 };
    }
    default: { // 紫：扁六边板 1.6:1
      const w = 18;
      const h = 11.25;
      const cy = b - h / 2;
      poly(ctx, [[23, cy], [27.5, cy - h / 2], [36.5, cy - h / 2], [41, cy], [36.5, cy + h / 2], [27.5, cy + h / 2]]);
      return { cx: 32, cy, r: 7 };
    }
  }
}

/** 宝石内部刻面（只画内部线与明暗，外形由 gemPath 定）。 */
function gemFacets(ctx, c, b, base) {
  const dark = mix(base, INK, 0.22);
  const light = mix(base, '#FFFFFF', 0.28);
  ctx.lineWidth = 1;
  switch (c) {
    case 0: {
      const cy = b - 10;
      poly(ctx, [[32, b - 20], [38, cy], [32, b]]); ctx.fillStyle = dark; ctx.fill();
      poly(ctx, [[32, b - 20], [29, cy], [32, cy + 3], [35, cy]]); ctx.fillStyle = light; ctx.fill();
      break;
    }
    case 1: {
      const cy = b - 10;
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 3;
        const a2 = a + Math.PI / 6;
        if (k >= 1 && k <= 3) {
          poly(ctx, [[32, cy], [32 + 10 * Math.cos(a), cy + 10 * Math.sin(a)], [32 + 5.3 * Math.cos(a2), cy + 5.3 * Math.sin(a2)]]);
          ctx.fillStyle = dark; ctx.fill();
        }
      }
      const hex = [];
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + Math.PI / 6 + (k * Math.PI) / 3;
        hex.push([32 + 3.2 * Math.cos(a), cy + 3.2 * Math.sin(a)]);
      }
      poly(ctx, hex); ctx.fillStyle = light; ctx.fill();
      break;
    }
    case 2: {
      const w = 17;
      const h = 16.2;
      const x = 32 - w / 2;
      const y = b - h;
      const t = 4.2;
      const k2 = 2.6;
      // 右、下斜面暗
      poly(ctx, [[x + w, y + 4.6], [x + w, y + h - 4.6], [x + w - 4.6, y + h], [x + 4.6, y + h], [x + t + k2, y + h - t], [x + w - t - k2, y + h - t], [x + w - t, y + h - t - k2], [x + w - t, y + t + k2]]);
      ctx.fillStyle = dark; ctx.fill();
      // 台面亮
      poly(ctx, [[x + t + k2, y + t], [x + w - t - k2, y + t], [x + w - t, y + t + k2], [x + w - t, y + h - t - k2], [x + w - t - k2, y + h - t], [x + t + k2, y + h - t], [x + t, y + h - t - k2], [x + t, y + t + k2]]);
      ctx.fillStyle = light; ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.25); ctx.stroke();
      break;
    }
    case 3: {
      const cy = b - 10;
      ctx.save();
      ell(ctx, 32, cy, 8, 10); ctx.clip();
      ell(ctx, 30, cy - 1.5, 8, 10); ctx.fillStyle = base;
      ell(ctx, 32, cy, 8, 10); ctx.fillStyle = dark; ctx.fill();
      ell(ctx, 30.6, cy - 1.4, 7.4, 9.4); ctx.fillStyle = base; ctx.fill();
      ell(ctx, 31, cy - 1.5, 4.2, 5.4); ctx.fillStyle = light; ctx.fill();
      ell(ctx, 31, cy - 1.5, 4.2, 5.4); ctx.strokeStyle = rgba(INK, 0.25); ctx.stroke();
      ctx.restore();
      break;
    }
    default: {
      const h = 11.25;
      const cy = b - h / 2;
      poly(ctx, [[23, cy], [41, cy], [36.5, cy + h / 2], [27.5, cy + h / 2]]); ctx.fillStyle = dark; ctx.fill();
      poly(ctx, [[27.5, cy - h / 2], [36.5, cy - h / 2], [38.5, cy - 1.6], [25.5, cy - 1.6]]); ctx.fillStyle = light; ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.25);
      line(ctx, [[23.5, cy], [40.5, cy]]); ctx.stroke();
    }
  }
}

export const GEM_HOVER = Object.freeze([0, -1, -2, -1]);
const GEM_SWEEP = [-16, -7, 2, 11];

/** 宝石（4 帧：悬浮 ±2px + 高光左→右扫过）。colors 可传候选色表。 */
export function drawGem(ctx, c, frame = 0, colors = GEM_COLORS_BASE) {
  const base = colors[c];
  const b = 54 + GEM_HOVER[frame % 4];
  const geo = gemPath(ctx, c, b);
  ctx.fillStyle = base;
  ctx.fill();
  within(ctx, () => gemPath(ctx, c, b), () => {
    gemFacets(ctx, c, b, base);
    // 顶部 45° 白色高光面 α .55
    // 45° 斜切线 u+v = -k（相对中心）以上为高光面
    const k = geo.r * 0.7;
    ctx.beginPath();
    ctx.moveTo(geo.cx - 30, geo.cy - 30);
    ctx.lineTo(geo.cx + 30 - k, geo.cy - 30);
    ctx.lineTo(geo.cx - 30, geo.cy + 30 - k);
    ctx.closePath();
    ctx.fillStyle = rgba('#FFFFFF', 0.55);
    ctx.fill();
    // 扫光带
    const s = GEM_SWEEP[frame % 4];
    ctx.beginPath();
    ctx.moveTo(geo.cx + s - 20, geo.cy + 20);
    ctx.lineTo(geo.cx + s + 20, geo.cy - 20);
    ctx.lineTo(geo.cx + s + 23, geo.cy - 20);
    ctx.lineTo(geo.cx + s - 17, geo.cy + 20);
    ctx.closePath();
    ctx.fillStyle = rgba('#FFFFFF', 0.4);
    ctx.fill();
    // 底部 1px 深色内描边
    ctx.beginPath();
    ctx.rect(0, geo.cy + 1, 64, 64);
    ctx.clip();
    gemPath(ctx, c, b);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

/** 宝石落地投影：等距菱形，随悬浮高度缩小。 */
export function drawGemShadow(ctx, frame = 0) {
  const lift = -GEM_HOVER[frame % 4];
  const k = 1 - lift * 0.08;
  poly(ctx, [[32, 56 - 3.5 * k], [32 + 7.5 * k, 56], [32, 56 + 3.5 * k], [32 - 7.5 * k, 56]]);
  ctx.fillStyle = rgba('#3B362F', 0.22 * k);
  ctx.fill();
}

// ---------- 宝箱（锚点 32,56；闭合 y∈[32,56]，开箱撑到 y=0） ----------

export const CHEST_FRAMES = 8;
const LID_ANGLE = [0, 0, 35, 70, 100, 100, 100, 100];

/**
 * 宝箱 8 帧（03 §3.6）：00–01 闭合呼吸 · 02–04 开盖 · 05–06 迸发（特效另画 drawChestReveal）· 07 空箱。
 * pal = CHEST_PALETTES 之一。
 */
export function drawChest(ctx, frame = 0, pal = CHEST_PALETTES[0]) {
  // 足印：沿网格 x 长 18、沿 y 宽 10 → 屏幕宽 28（x∈[18,46]），前角落在 (36,56)
  const a = [1, 0.5];
  const bv = [-1, 0.5];
  const A = 18;
  const B = 10;
  const H = 7; // 箱体高
  const LH = 3; // 盖厚
  const breath = frame === 1 ? -1 : 0;
  const o = [28, 42];
  const P = (u, v, z) => [o[0] + a[0] * u + bv[0] * v, o[1] + a[1] * u + bv[1] * v - z];
  const back = P(0, 0, 0);
  const R = P(A, 0, 0);
  const L = P(0, B, 0);
  const F = P(A, B, 0);
  const up = (p, z) => [p[0], p[1] - z];

  // 箱体左面（长面，朝左下）与右面（短面，朝右下）
  poly(ctx, [L, F, up(F, H), up(L, H)]); ctx.fillStyle = pal.left; ctx.fill();
  poly(ctx, [F, R, up(R, H), up(F, H)]); ctx.fillStyle = pal.right; ctx.fill();
  // 底部深色嵌线 + 竖向铜条
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(INK, 0.4);
  line(ctx, [[L[0], L[1] - 1.5], [F[0], F[1] - 1.5], [R[0], R[1] - 1.5]]); ctx.stroke();
  ctx.strokeStyle = pal.trim;
  ctx.lineWidth = 1.5;
  for (const u of [3.5, A - 3.5]) {
    const p = P(u, B, 0);
    line(ctx, [p, up(p, H)]); ctx.stroke();
  }
  { const p = P(A, 5, 0); line(ctx, [p, up(p, H)]); ctx.stroke(); }

  const ang = LID_ANGLE[frame % 8];
  if (ang === 0) {
    // 闭合：盖 = 抬高 LH 的薄板 + 顶面
    const z0 = H + breath * -1;
    const z1 = H + LH + breath * -1;
    poly(ctx, [up(L, z0), up(F, z0), up(F, z1), up(L, z1)]); ctx.fillStyle = mix(pal.left, '#FFFFFF', 0.08); ctx.fill();
    poly(ctx, [up(F, z0), up(R, z0), up(R, z1), up(F, z1)]); ctx.fillStyle = mix(pal.right, '#FFFFFF', 0.08); ctx.fill();
    poly(ctx, [up(back, z1), up(R, z1), up(F, z1), up(L, z1)]); ctx.fillStyle = pal.top; ctx.fill();
    // 盖沿铜线
    ctx.strokeStyle = pal.trim;
    ctx.lineWidth = 1;
    line(ctx, [up(L, z0), up(F, z0), up(R, z0)]); ctx.stroke();
    // 顶面中线（拱形盖的接缝）
    ctx.strokeStyle = rgba(LINE, 0.6);
    line(ctx, [up(P(0, B / 2, 0), z1), up(P(A, B / 2, 0), z1)]); ctx.stroke();
    // 锁扣
    const m = P(A / 2, B, 0);
    const lx = m[0];
    const ly = m[1] - z0;
    poly(ctx, [[lx - 2.5, ly - 2.2], [lx + 2.5, ly + 0.3], [lx + 2.5, ly + 4.3], [lx - 2.5, ly + 1.8]]);
    ctx.fillStyle = frame === 1 ? '#FFF6D8' : pal.lock;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (frame === 1) {
      ctx.strokeStyle = rgba('#FFFFFF', 0.9);
      ctx.lineWidth = 1;
      line(ctx, [[lx - 1.5, ly - 0.8], [lx + 1.5, ly + 0.7]]); ctx.stroke();
    }
  } else {
    // 开盖：箱口（暗）+ 绕后棱旋转的盖
    poly(ctx, [up(back, H), up(R, H), up(F, H), up(L, H)]);
    ctx.fillStyle = '#5E574C';
    ctx.fill();
    // 内壁受光带（后壁内侧）
    poly(ctx, [up(back, H), up(R, H), up(R, H - 3), up(back, H - 3)].map((p, i) => (i >= 2 ? [p[0] - 1.2 * (i === 2 ? 1 : 1), p[1] + 0.6] : p)));
    ctx.fillStyle = mix('#5E574C', '#FFFFFF', 0.15);
    ctx.fill();
    const th = (ang * Math.PI) / 180;
    // 盖的深度向量：沿 v（屏幕 (-1,.5)·B）→ 绕后棱旋转：水平分量 cos，竖直分量 sin（竖直 1 单位 ≈ 1.25px）
    const dv = [bv[0] * B * Math.cos(th), bv[1] * B * Math.cos(th) - B * 1.25 * Math.sin(th)];
    const hb = up(back, H);
    const hr = up(R, H);
    const fl = [hb[0] + dv[0], hb[1] + dv[1]];
    const fr = [hr[0] + dv[0], hr[1] + dv[1]];
    const thick = [0, -LH];
    // 盖内面（朝镜头时可见）
    if (ang < 90) {
      poly(ctx, [hb, hr, fr, fl]); ctx.fillStyle = mix(pal.right, INK, 0.2); ctx.fill();
      poly(ctx, [fl, fr, [fr[0] + thick[0], fr[1] + thick[1]], [fl[0] + thick[0], fl[1] + thick[1]]]);
      ctx.fillStyle = pal.left; ctx.fill();
    } else {
      poly(ctx, [hb, hr, fr, fl]); ctx.fillStyle = mix(pal.left, INK, 0.25); ctx.fill();
      poly(ctx, [[hb[0], hb[1] - 1], [hr[0], hr[1] - 1], [fr[0], fr[1] - 1], [fl[0], fl[1] - 1]]);
      ctx.strokeStyle = rgba('#FFFFFF', 0.15); ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.strokeStyle = pal.trim;
    ctx.lineWidth = 1;
    line(ctx, [fl, fr]); ctx.stroke();
    // 箱口前沿铜线
    line(ctx, [up(L, H), up(F, H), up(R, H)]); ctx.stroke();
  }
}

/**
 * 开箱揭晓特效（特效层，可撑到 y=0）：score = 橙金爆发，stamina = 蓝色注入。p ∈ [0,1] 演出进度。
 */
export function drawChestReveal(ctx, kind, p = 0.5) {
  const R = REVEAL[kind];
  const cx = 33;
  const cy = 40;
  const e = Math.sin(Math.min(1, p) * Math.PI);
  if (kind === 'score') {
    const r = 10 + 22 * p;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(R.core, 0.95 * e));
    g.addColorStop(0.35, rgba(R.mid, 0.75 * e));
    g.addColorStop(1, R.edge);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = rgba(R.mid, 0.9 * e);
    for (let k = 0; k < 8; k++) {
      const a = -Math.PI / 2 + ((k - 3.5) / 7) * Math.PI * 0.9;
      const r0 = 6;
      const r1 = 14 + 24 * p * (k % 2 ? 0.7 : 1);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - 0.06) * r0, cy + Math.sin(a - 0.06) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, Math.max(1, cy + Math.sin(a) * r1));
      ctx.lineTo(cx + Math.cos(a + 0.06) * r0, cy + Math.sin(a + 0.06) * r0);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const top = cy - 8 - 30 * p;
    const g = ctx.createLinearGradient(0, cy, 0, top);
    g.addColorStop(0, rgba(R.mid, 0.8 * e));
    g.addColorStop(1, rgba(R.mid, 0));
    ctx.beginPath();
    ctx.ellipse(cx, cy, 8, 4, 0, 0, Math.PI);
    ctx.lineTo(cx - 5, top);
    ctx.lineTo(cx + 5, top);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    for (let i = 0; i < 5; i++) {
      const q = (p + i / 5) % 1;
      const x = cx + Math.sin(i * 2.1) * 6;
      const y = cy - 4 - q * 34;
      poly(ctx, [[x, y - 2.5], [x + 1.6, y], [x, y + 2.5], [x - 1.6, y]]);
      ctx.fillStyle = rgba(i % 2 ? R.core : R.mid, (1 - q) * e);
      ctx.fill();
    }
  }
}

// ---------- 屏幕空间 LOD 标记（03 §3.11，尺寸以屏幕 px 计） ----------

export function drawMarkerPlayer(ctx, x, y) {
  ctx.beginPath(); ctx.arc(x, y, 8.5, 0, TAU); ctx.fillStyle = INK; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.lineWidth = 2; ctx.strokeStyle = HALO; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fillStyle = INK; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fillStyle = ACTOR_COLORS[0]; ctx.fill();
}

export function drawMarkerExit(ctx, x, y, color) {
  ctx.fillStyle = rgba(color, 0.7);
  ctx.fillRect(x - 1, y - 3 - 8, 2, 8);
  poly(ctx, [[x, y - 3], [x + 6, y], [x, y + 3], [x - 6, y]]);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = INK; ctx.stroke();
  poly(ctx, [[x, y - 2], [x + 4, y], [x, y + 2], [x - 4, y]]);
  ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
}

export function drawMarkerAI(ctx, x, y, color) {
  poly(ctx, [[x, y - 2.5], [x + 5, y], [x, y + 2.5], [x - 5, y]]);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = INK; ctx.stroke();
}

/** 幽灵角标底板 24×14（03 §3.9）：圆角 4，底 #3B362F@72%，1px #E9E1D6@60% 描边，10px/600 字。 */
export function drawGhostBadge(ctx, x, y, text, font) {
  rrect(ctx, x + 0.5, y + 0.5, 23, 13, 4);
  ctx.fillStyle = rgba(INK, 0.72);
  ctx.fill();
  ctx.strokeStyle = rgba('#E9E1D6', 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#EFE7DC';
  ctx.font = `600 10px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 12, y + 7.5);
}

// ---------- 烘焙期后处理 ----------

/** 03 §3.7 tint：multiply 角色色，再 destination-in 恢复 alpha。 */
export function tintCanvas(base, color) {
  const c = makeCanvas(base.width, base.height);
  const x = c.getContext('2d');
  x.drawImage(base, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(base, 0, 0);
  x.globalCompositeOperation = 'source-over';
  return c;
}

/** 渲染层统一外轮廓：返回只含 1px（×scale）描边环的画布（剪影膨胀 − 剪影）。 */
export function outlineRing(src, color = INK, radius = 1) {
  const w = src.width;
  const h = src.height;
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  const n = radius <= 1.01 ? 8 : 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    x.drawImage(src, Math.round(Math.cos(a) * radius * 100) / 100, Math.round(Math.sin(a) * radius * 100) / 100);
  }
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'destination-out';
  x.drawImage(src, 0, 0);
  // 膨胀环的半透明边会叠成实色，压回 1.0
  return c;
}

/** 像素级去饱和（烘焙期一次性，DEAD 帧与幽灵态用）。t=0.6 → 去 60%。 */
export function desaturateCanvas(src, t) {
  const c = makeCanvas(src.width, src.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0);
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] += (y - d[i]) * t;
    d[i + 1] += (y - d[i + 1]) * t;
    d[i + 2] += (y - d[i + 2]) * t;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/**
 * 烘焙一个 sprite：在 (w×h)·scale 的画布上，以 (ox,oy) 为 sprite 原点作画，可选外轮廓。
 * draw(ctx) 在 sprite 局部坐标（64×64 体系）里画。返回 canvas。
 */
export function bake(draw, { scale = 1, w = 64, h = 64, ox = 0, oy = 0, outline = INK } = {}) {
  const c = makeCanvas(w * scale, h * scale);
  const x = c.getContext('2d');
  x.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
  draw(x);
  if (!outline) return c;
  const ring = outlineRing(c, outline, scale);
  const out = makeCanvas(c.width, c.height);
  const o = out.getContext('2d');
  o.drawImage(ring, 0, 0);
  o.drawImage(c, 0, 0);
  return out;
}

/** 烘焙机器人（含 AI tint 流程与 DEAD 去饱和），不含描边。 */
export function bakeRobotBody(opts, { scale = 1, w = 64, h = 64, ox = 0, oy = 0 } = {}) {
  const pose = robotPose(opts.kind, opts.state, opts.frame);
  let c;
  if (opts.kind === 'ai') {
    const base = bake((x) => drawRobot(x, { ...opts, pass: 'body' }), { scale, w, h, ox, oy, outline: null });
    c = tintCanvas(base, opts.color);
    const x = c.getContext('2d');
    x.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
    drawRobot(x, { ...opts, pass: 'overlay' });
  } else {
    c = bake((x) => drawRobot(x, { ...opts, pass: 'all' }), { scale, w, h, ox, oy, outline: null });
  }
  if (pose.desat) c = desaturateCanvas(c, pose.desat);
  return c;
}

/** 合成：body 画布 + 外轮廓环（alpha 1），body 可单独设 alpha（幽灵态）。 */
export function withOutline(body, { scale = 1, color = INK, bodyAlpha = 1 } = {}) {
  const ring = outlineRing(body, color, scale);
  const out = makeCanvas(body.width, body.height);
  const o = out.getContext('2d');
  o.drawImage(ring, 0, 0);
  o.globalAlpha = bodyAlpha;
  o.drawImage(body, 0, 0);
  return out;
}

export { parseColor };
