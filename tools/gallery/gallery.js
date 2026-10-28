// 美术样张页（阶段 2 第 1 步）：把 docs/03 的全部资产用 src/render/sprites.js 程序化画出来，供逐项确认。
// 工具层：可用 rAF / 时钟。

import * as S from '../../src/render/sprites.js';
import * as P from '../../src/render/palette.js';
import { tileCenter, DIR_LETTERS } from '../../src/render/iso.js';
import { floorVariant, decoVariant, wallVariant } from '../../src/render/variants.js';
import { buildPilot } from './pilot.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const ZOOMS = [2, 3, 4];
const st = {
  zoom: 3,
  gray: false,
  anim: true,
  purple: localStorage.getItem('gallery.purple') || 'P2',
  chest: localStorage.getItem('gallery.chest') || 'K1',
};
const live = []; // 每帧重画的 {canvas, scale, paint}
const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
const purpleHex = () => P.PURPLE_CANDIDATES.find((c) => c.id === st.purple).hex;
const gemCols = () => P.gemColors(purpleHex());
const chestPal = () => P.CHEST_PALETTES.find((c) => c.id === st.chest);
const DIR_CN = { n: '北', e: '东', s: '南', w: '西' };
const SEAT_CN = ['玩家 P', 'AI-A', 'AI-B', 'AI-C'];
const STATE_CN = { IDLE: '待机', MOVE: '移动', PICK: '拾取', BLOCK: '受阻', DEAD: '出局' };

// ---------- 时间轴 ----------

/** seq = [[frame, ms], ...]，循环播放，返回当前项（含原始索引）。 */
function seqAt(seq, tMs) {
  const total = seq.reduce((s, [, ms]) => s + ms, 0);
  let r = tMs % total;
  for (let i = 0; i < seq.length; i++) {
    if (r < seq[i][1]) return { item: seq[i], i };
    r -= seq[i][1];
  }
  return { item: seq[seq.length - 1], i: seq.length - 1 };
}

const BEAT = 200 / 8; // moveMs 200 @1×，hold [2,1,1,1,1,2] 共 8 单位
const ROBOT_SEQ = {
  IDLE: (kind) => (kind === 'player' ? [[0, 420], [1, 380], [2, 380], [0, 420], [3, 120], [0, 300]] : [[0, 600], [1, 600]]),
  MOVE: () => [['M0', 2 * BEAT], ['M1', BEAT], ['M2', BEAT], ['M3', BEAT], ['M0', BEAT], ['I0', 2 * BEAT], ['I0', 500]],
  PICK: (kind) => (kind === 'player' ? [[0, 107], [1, 107], [2, 420], ['I0', 600]] : [[0, 160], [1, 480], ['I0', 600]]),
  BLOCK: (kind) => (kind === 'player' ? [[0, 90], [1, 90], [0, 90], [1, 90], ['I0', 700]] : [[0, 90], ['I0', 90], [0, 90], ['I0', 900]]),
  DEAD: (kind) => (kind === 'player' ? [['I0', 500], [0, 300], [1, 1200]] : [['I0', 500], [0, 1500]]),
};

function resolveFrame(state, f) {
  if (f === 'I0') return { state: 'IDLE', frame: 0 };
  if (typeof f === 'string' && f[0] === 'M') return { state: 'MOVE', frame: Number(f.slice(1)) };
  return { state, frame: f };
}

// ---------- 烘焙封装 ----------

function robotSprite(seat, dir, state, frame, scale, { ghost = false } = {}) {
  const kind = seat === 0 ? 'player' : 'ai';
  return memo(`R|${seat}|${dir}|${state}|${frame}|${scale}|${ghost}`, () => {
    let body = S.bakeRobotBody({ kind, dir, state, frame, color: P.ACTOR_COLORS[seat] }, { scale, w: 80, h: 76, ox: 8, oy: 2 });
    if (ghost) {
      body = S.desaturateCanvas(body, 0.65);
      return S.withOutline(body, { scale, bodyAlpha: 0.35 });
    }
    return S.withOutline(body, { scale });
  });
}

function gemSprite(c, frame, scale) {
  const cols = gemCols();
  return memo(`G|${c}|${cols[c]}|${frame}|${scale}`, () => S.bake((x) => S.drawGem(x, c, frame, cols), { scale }));
}

function chestSprite(frame, pal, scale) {
  return memo(`C|${pal.id}|${frame}|${scale}`, () => S.bake((x) => S.drawChest(x, frame, pal), { scale }));
}

function wallSprite(set, variant, border, scale) {
  return memo(`W|${set}|${variant}|${border}|${scale}`, () =>
    S.bake((x) => S.drawWall(x, set, variant, { border }), { scale, outline: P.WALL_SETS[set].outline }));
}

// ---------- 卡片 ----------

/**
 * w×h：sprite 局部坐标下的卡片画布尺寸；paint(ctx, t, scale) 以 identity 变换在画布像素上作画。
 */
function card(parent, title, sub, { w = 64, h = 64, paint, animated = true }) {
  const el = document.createElement('div');
  el.className = 'card';
  const pics = document.createElement('div');
  pics.className = 'pics';
  for (const scale of [1, st.zoom]) {
    const c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    if (scale === 1) c.className = 'native';
    pics.appendChild(c);
    const item = { canvas: c, scale, paint, animated };
    live.push(item);
    drawItem(item, 0);
  }
  el.appendChild(pics);
  el.insertAdjacentHTML('beforeend', `<div class="t">${title}</div>${sub ? `<div class="s">${sub}</div>` : ''}`);
  parent.appendChild(el);
  return el;
}

function drawItem(item, t) {
  const ctx = item.canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, item.canvas.width, item.canvas.height);
  ctx.imageSmoothingEnabled = false;
  item.paint(ctx, t, item.scale);
}

/** 在 sprite 局部坐标里画（矢量缩放）。 */
function vec(ctx, scale, ox, oy, fn) {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
  fn(ctx);
  ctx.restore();
}

function section(title, note) {
  const s = document.createElement('section');
  s.innerHTML = `<h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}`;
  main.appendChild(s);
  return s;
}

function grid(parent) {
  const g = document.createElement('div');
  g.className = 'grid';
  parent.appendChild(g);
  return g;
}

// ---------- 各区块 ----------

function buildTerrain() {
  const s = section('① 地形：地面 · 装饰 · 墙 · 出口',
    '地面 5 + 装饰 3 + 墙 4 = 12 个 tile 变体（需求 #7 上限）。墙 A/B 两套共用同一组 4 个变体，只换色值；B 套必须带 1px <code>#4A443A</code> 外轮廓和墙脚接触阴影。外圈墙不加变体，由渲染层乘 0.855 压暗并加顶棱哑金线。出口是地面圆盘，无门框立柱，光柱为动态层。');
  const g = grid(s);
  const FN = ['F1 奶油米', 'F2 淡藕粉', 'F3 淡薄荷', 'F4 雾霭蓝', 'F5 砖纹'];
  FN.forEach((name, i) => card(g, name, P.FLOOR[i], { animated: false, paint: (ctx, t, sc) => vec(ctx, sc, 0, 0, (x) => S.drawFloor(x, i)) }));
  P.DECO.forEach((d, i) => card(g, `D${i + 1} ${d.name}`, `${d.color} @${d.alpha} · 叠在 F1 上`, {
    animated: false,
    paint: (ctx, t, sc) => vec(ctx, sc, 0, 0, (x) => { S.drawFloor(x, 0); S.drawDeco(x, i); }),
  }));
  const g2 = grid(s);
  const VN = ['素面 · 直墙', '日出纹 · 直墙', '素面 · 转角柱头', '日出纹 · 转角柱头'];
  for (const set of ['A', 'B']) {
    VN.forEach((vn, v) => card(g2, `墙 ${set}${v + 1}`, vn, {
      animated: false,
      paint: (ctx, t, sc) => {
        vec(ctx, sc, 0, 0, (x) => { S.drawFloor(x, 0, { seam: false }); if (set === 'B') S.drawWallContactShadow(x); });
        ctx.drawImage(wallSprite(set, v, false, sc), 0, 0);
      },
    }));
    card(g2, `外圈墙 ${set}`, '×0.855 + 顶棱哑金', {
      animated: false,
      paint: (ctx, t, sc) => {
        vec(ctx, sc, 0, 0, (x) => { S.drawFloor(x, 0, { seam: false }); if (set === 'B') S.drawWallContactShadow(x); });
        ctx.drawImage(wallSprite(set, 2, true, sc), 0, 0);
      },
    });
  }
  const g3 = grid(s);
  ['P 上', 'A 右', 'B 下', 'C 左'].forEach((name, i) => card(g3, `出口 ${name}`, `${P.ACTOR_COLORS[i]} · 光柱 1.6s`, {
    w: 64, h: 76,
    paint: (ctx, t, sc) => vec(ctx, sc, 0, 12, (x) => {
      S.drawFloor(x, i % 4);
      const breath = st.anim ? 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 1.6) : 0;
      S.drawExitDisc(x, P.ACTOR_COLORS[i], { breath });
      S.drawExitBeam(x, P.ACTOR_COLORS[i], st.anim ? t : 0.4);
    }),
  }));
}

function robotCard(parent, seat, dir, state, { ghost = false, sub = '' } = {}) {
  const kind = seat === 0 ? 'player' : 'ai';
  const seq = ROBOT_SEQ[state](kind);
  const title = ghost ? `${SEAT_CN[seat]} · 幽灵态` : `${SEAT_CN[seat]} · ${STATE_CN[state]} · ${DIR_CN[dir]}`;
  card(parent, title, sub, {
    w: 80, h: 78,
    paint: (ctx, t, sc) => {
      const { item, i } = seqAt(seq, st.anim ? t * 1000 : 0);
      const r = resolveFrame(state, ghost ? 'I0' : item[0]);
      const lift = r.state === 'MOVE' ? [0, 2, 4, 2][r.frame] : 0;
      vec(ctx, sc, 8, 2, (x) => {
        x.fillStyle = P.FLOOR[0];
        x.beginPath();
        x.moveTo(32, 40); x.lineTo(64, 56); x.lineTo(32, 72); x.lineTo(0, 56); x.closePath();
        x.fill();
        if (!ghost) S.drawShadow(x, { lift });
        if (seat === 0 && !ghost && r.state !== 'DEAD') S.drawHalo(x, st.anim ? t : 0.4);
      });
      const spr = robotSprite(seat, dir, r.state, r.frame, sc, { ghost });
      ctx.drawImage(spr, 0, -lift * sc);
      vec(ctx, sc, 8, 2, (x) => {
        x.font = `700 11px ${P.UI.font}`;
        x.textAlign = 'center';
        if (r.state === 'PICK' && i >= (kind === 'player' ? 1 : 0) && item[0] !== 'I0') {
          x.fillStyle = P.INK; x.fillText('+1', 52, 12);
        }
        if (r.state === 'BLOCK') {
          x.fillStyle = P.INK; x.fillText('！', 46, 9);
        }
        if (ghost) S.drawGhostBadge(x, 32 + 14 - 12, 56 - 58 + 2, '3', P.UI.font);
      });
    },
  });
}

function buildRobots() {
  const s = section('② 角色：玩家与三只 AI',
    '高 56、宽 30，头:身约 1:1.2，腿 ≤16px（V20）。玩家无嘴、瞳孔带高光、球头天线；AI 同骨架，短柱天线 + 2px 一字嘴 + 无高光瞳，用灰度基底 multiply 着色后恢复 alpha。外轮廓 1px <code>#3B362F</code> 由渲染层统一加。光环贴地双椭圆、1.6s 脉动，按墙钟走不随倍速。MOVE 用 6 拍序列（hold 2-1-1-1-1-2，1× 下 200ms）。');
  const g = grid(s);
  for (let seat = 0; seat < 4; seat++) for (const d of DIR_LETTERS) robotCard(g, seat, d, 'IDLE', { sub: seat === 0 ? '光环 + 最高彩度' : 'tint ' + P.ACTOR_COLORS[seat] });
  const g2 = grid(s);
  for (let seat = 0; seat < 4; seat++) {
    for (const stt of ['MOVE', 'PICK', 'BLOCK', 'DEAD']) robotCard(g2, seat, 's', stt);
  }
  const g3 = grid(s);
  for (let seat = 1; seat < 4; seat++) robotCard(g3, seat, 's', 'IDLE', { ghost: true, sub: 'α.35 · 去饱和 · 描边保留 · 角标「3」' });
  for (const d of DIR_LETTERS) robotCard(g3, 0, d, 'MOVE', { sub: '四向独立绘制' });

  // 帧表（atlas 视角）
  const sheetWrap = document.createElement('div');
  sheetWrap.className = 'sheet';
  s.appendChild(sheetWrap);
  const sheets = [
    { seat: 0, label: '玩家帧表 4 向 × 15 帧（IDLE4 · MOVE4 · PICK3 · BLOCK2 · DEAD2）' },
    { seat: 1, label: 'AI 帧表 4 向 × 10 帧（IDLE2 · MOVE4 · PICK2 · BLOCK1 · DEAD1，示例 tint AI-A）' },
  ];
  for (const sh of sheets) {
    const kind = sh.seat === 0 ? 'player' : 'ai';
    const fc = S.FRAME_COUNTS[kind];
    const frames = [];
    for (const stt of S.ROBOT_STATES) for (let f = 0; f < fc[stt]; f++) frames.push([stt, f]);
    const sc = 2;
    const cw = 64;
    const c = document.createElement('canvas');
    c.width = frames.length * cw * sc;
    c.height = (4 * 64 + 16) * sc;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#F6F2EC';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = `600 ${10 * sc}px ${P.UI.font}`;
    ctx.fillStyle = P.INK;
    frames.forEach(([stt, f], k) => ctx.fillText(`${stt[0]}${stt.slice(1).toLowerCase()} ${f}`, (k * cw + 4) * sc, 11 * sc));
    DIR_LETTERS.forEach((d, r) => frames.forEach(([stt, f], k) => {
      const spr = robotSprite(sh.seat, d, stt, f, sc);
      ctx.drawImage(spr, (k * cw - 8) * sc, (16 + r * 64 - 2 + 2) * sc);
    }));
    sheetWrap.insertAdjacentHTML('beforeend', `<div class="s" style="margin:6px 0 4px">${sh.label}</div>`);
    sheetWrap.appendChild(c);
  }
}

function buildGems() {
  const s = section('③ 宝石：五色五形',
    '包围盒 18×20，4 帧悬浮 ±2px + 高光左→右扫过；顶部 45° 白色高光面 α.55、底部 1px 深色内描边、菱形落地投影。外形在四个维度两两不同（角数 4/12/8/0/6、宽高比、曲直、凹凸），打开「灰度检查」验证不靠颜色也能分。<b>紫宝石颜色待你选</b>：占位色与 AI-A 靛紫色相只差 31°，灰度又夹在红(52)蓝(50)之间。');
  const pick = document.createElement('div');
  pick.className = 'pick';
  s.appendChild(pick);
  const others = [P.GEM_COLORS_BASE[0], P.GEM_COLORS_BASE[3], P.GEM_COLORS_BASE[1], P.GEM_COLORS_BASE[2]];
  for (const cand of P.PURPLE_CANDIDATES) {
    const L = P.lstar(cand.hex);
    const dL = Math.min(...others.map((o) => Math.abs(P.lstar(o) - L)));
    const gap = P.hueGap(cand.hex, P.ACTOR_COLORS[1]);
    const b = document.createElement('button');
    b.className = cand.id === st.purple ? 'on' : '';
    b.innerHTML = `<span class="sw" style="background:${cand.hex}"></span>${cand.id} ${cand.name} <span class="s">${cand.hex} · L*${L.toFixed(0)} · 与其它宝石最小ΔL* ${dL.toFixed(0)} · 与 AI-A 色相差 ${gap.toFixed(0)}°</span>`;
    b.onclick = () => { st.purple = cand.id; localStorage.setItem('gallery.purple', cand.id); rebuild(); };
    pick.appendChild(b);
  }
  const g = grid(s);
  P.GEM_NAMES.forEach((name, c) => card(g, `${name} ${P.GEM_KEYS[c]}`, `${gemCols()[c]} · L*${P.lstar(gemCols()[c]).toFixed(0)}`, {
    paint: (ctx, t, sc) => {
      const f = st.anim ? Math.floor(t * 1000 / 150) % 4 : 0;
      vec(ctx, sc, 0, 0, (x) => { x.fillStyle = P.FLOOR[0]; x.beginPath(); x.moveTo(32, 40); x.lineTo(64, 56); x.lineTo(32, 72); x.lineTo(0, 56); x.closePath(); x.fill(); S.drawGemShadow(x, f); });
      ctx.drawImage(gemSprite(c, f, sc), 0, 0);
    },
  }));
  // 紫宝石 vs AI-A 并排
  card(g, '紫宝石 vs AI-A', '同屏对照色相', {
    w: 112, h: 78,
    paint: (ctx, t, sc) => {
      vec(ctx, sc, 0, 0, (x) => { x.fillStyle = P.FLOOR[0]; x.fillRect(0, 40, 112, 38); });
      ctx.drawImage(robotSprite(1, 's', 'IDLE', 0, sc), 0, 2 * sc);
      ctx.drawImage(gemSprite(4, 0, sc), 56 * sc, 14 * sc);
    },
  });
}

function buildChest() {
  const s = section('④ 宝箱：8 帧 + 揭晓特效',
    '03 未定配色，我出了三套候选，线脚统一用场景哑金 <code>#BFA46A</code>，避开光环金 <code>#FFD84D</code>。帧 00–01 闭合呼吸、锁扣闪光；02–04 开盖；05–06 迸发（特效层另画，可撑到 y=0）；07 空箱。揭晓：得分=橙金爆发，体力=蓝色注入，二者都与光环柠檬金拉开。<b>宝箱配色待你选。</b>');
  const pick = document.createElement('div');
  pick.className = 'pick';
  s.appendChild(pick);
  for (const pal of P.CHEST_PALETTES) {
    const b = document.createElement('button');
    b.className = pal.id === st.chest ? 'on' : '';
    b.innerHTML = `<span class="sw" style="background:${pal.top}"></span>${pal.id} ${pal.name}`;
    b.onclick = () => { st.chest = pal.id; localStorage.setItem('gallery.chest', pal.id); rebuild(); };
    pick.appendChild(b);
  }
  const g = grid(s);
  const pal = chestPal();
  for (let f = 0; f < 8; f++) {
    card(g, `PRP_CHEST ${String(f).padStart(2, '0')}`, ['闭合', '闭合·锁扣闪', '开盖 35°', '开盖 70°', '全开', '迸发', '迸发', '空箱'][f], {
      animated: false,
      paint: (ctx, t, sc) => {
        vec(ctx, sc, 0, 0, (x) => { x.save(); x.translate(0, 24); S.drawFloor(x, 0); x.restore(); S.drawShadow(x, { rx: 16, ry: 5.5, cy: 52 }); });
        ctx.drawImage(chestSprite(f, pal, sc), 0, 0);
        if (f === 5 || f === 6) vec(ctx, sc, 0, 0, (x) => S.drawChestReveal(x, f === 5 ? 'score' : 'stamina', 0.5));
      },
    });
  }
  const g2 = grid(s);
  for (const kind of ['score', 'stamina']) {
    card(g2, P.REVEAL[kind].name, '600ms 演出循环', {
      paint: (ctx, t, sc) => {
        const p = st.anim ? ((t * 1000) % 1100) / 600 : 0.5;
        const fr = p < 0.12 ? 2 : p < 0.24 ? 3 : 4;
        vec(ctx, sc, 0, 0, (x) => { x.save(); x.translate(0, 24); S.drawFloor(x, 0); x.restore(); S.drawShadow(x, { rx: 16, ry: 5.5, cy: 52 }); });
        ctx.drawImage(chestSprite(p > 1 ? 7 : fr, pal, sc), 0, 0);
        if (p <= 1) vec(ctx, sc, 0, 0, (x) => S.drawChestReveal(x, kind, Math.max(0, (p - 0.2) / 0.8)));
      },
    });
  }
  P.CHEST_PALETTES.forEach((pp) => card(g2, `候选 ${pp.id}`, pp.name, {
    animated: false,
    paint: (ctx, t, sc) => {
      vec(ctx, sc, 0, 0, (x) => { x.save(); x.translate(0, 24); S.drawFloor(x, 0); x.restore(); S.drawShadow(x, { rx: 16, ry: 5.5, cy: 52 }); });
      ctx.drawImage(chestSprite(0, pp, sc), 0, 0);
    },
  }));
}

// ---------- 场景拼合（墙 A / B 并排） ----------

const SCENE = [
  '######.#####',
  '#....#.....#',
  '#.##.#.###.#',
  '#.#......#.#',
  '#.#.####.#.#',
  '#...#..#...#',
  '###.#..###.#',
  '#......#...#',
  '#.####.#.#.#',
  '#......#.#.#',
  '#.#.#....#.#',
  '#.#.#.##.#.#',
];
const SN = SCENE.length;
const isWallS = (x, y) => x < 0 || y < 0 || x >= SN || y >= SN || SCENE[y][x] === '#';
const SCENE_ACTORS = [
  { seat: 0, x: 6, y: 1, dir: 's' },
  { seat: 1, x: 3, y: 7, dir: 'e' },
  { seat: 2, x: 8, y: 9, dir: 'w' },
  { seat: 3, x: 10, y: 5, dir: 'n', ghost: true },
];
const SCENE_GEMS = [[1, 1, 0], [4, 3, 1], [1, 9, 2], [10, 10, 3], [6, 7, 4]];
const SCENE_CHEST = [5, 5];
const SCENE_EXIT = [6, 0];

function drawScene(ctx, set, t, zoom) {
  const ox = (SN - 1) * 32 + 32;
  const oy = 32;
  const sc = zoom;
  const at = (x, y) => {
    const [cx, cy] = tileCenter(x, y);
    return [ox + cx, oy + cy];
  };
  const nearExit = (x, y) => Math.max(Math.abs(x - SCENE_EXIT[0]), Math.abs(y - SCENE_EXIT[1])) <= 2;
  ctx.save();
  ctx.scale(sc, sc);
  // 静态层：地面 + 装饰 + 出口圆盘 + 墙脚阴影
  for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) {
    if (isWallS(x, y)) continue;
    const [cx, cy] = at(x, y);
    ctx.save();
    ctx.translate(cx - 32, cy - 32);
    S.drawFloor(ctx, floorVariant(x + 3, y + 3));
    const d = decoVariant(x, y, 0.15, nearExit);
    if (d >= 0) S.drawDeco(ctx, d);
    if (x === SCENE_EXIT[0] && y === SCENE_EXIT[1]) S.drawExitDisc(ctx, P.ACTOR_COLORS[0]);
    ctx.restore();
  }
  if (set === 'B') for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) {
    if (!isWallS(x, y)) continue;
    const [cx, cy] = at(x, y);
    ctx.save(); ctx.translate(cx - 32, cy - 32); S.drawWallContactShadow(ctx); ctx.restore();
  }
  ctx.restore();
  // 行序：墙 / 宝物 / 角色 按 (x+y) 统一排序
  for (let d = 0; d <= 2 * (SN - 1); d++) {
    for (let x = Math.max(0, d - SN + 1); x <= Math.min(SN - 1, d); x++) {
      const y = d - x;
      const [cx, cy] = at(x, y);
      if (isWallS(x, y)) {
        const border = x === 0 || y === 0;
        const v = wallVariant(x, y, isWallS);
        ctx.drawImage(wallSprite(set, v, border, sc), (cx - 32) * sc, (cy - 32) * sc);
        continue;
      }
      if (x === SCENE_EXIT[0] && y === SCENE_EXIT[1]) {
        ctx.save(); ctx.scale(sc, sc); ctx.translate(cx - 32, cy - 32); S.drawExitBeam(ctx, P.ACTOR_COLORS[0], t); ctx.restore();
      }
      for (const [gx, gy, c] of SCENE_GEMS) {
        if (gx !== x || gy !== y) continue;
        const f = Math.floor(t * 1000 / 150) % 4;
        ctx.save(); ctx.scale(sc, sc); ctx.translate(cx - 32, cy - 56); S.drawGemShadow(ctx, f); ctx.restore();
        ctx.drawImage(gemSprite(c, f, sc), (cx - 32) * sc, (cy - 56) * sc);
      }
      if (SCENE_CHEST[0] === x && SCENE_CHEST[1] === y) {
        ctx.save(); ctx.scale(sc, sc); ctx.translate(cx - 32, cy - 56); S.drawShadow(ctx, { rx: 16, ry: 5.5, cy: 52 }); ctx.restore();
        ctx.drawImage(chestSprite(Math.floor(t * 1000 / 700) % 2, chestPal(), sc), (cx - 32) * sc, (cy - 56) * sc);
      }
      for (const a of SCENE_ACTORS) {
        if (a.x !== x || a.y !== y) continue;
        ctx.save(); ctx.scale(sc, sc); ctx.translate(cx - 32, cy - 56);
        if (!a.ghost) S.drawShadow(ctx);
        if (a.seat === 0) S.drawHalo(ctx, t);
        ctx.restore();
        const fr = Math.floor(t * 1000 / 500) % (a.seat === 0 ? 4 : 2);
        ctx.drawImage(robotSprite(a.seat, a.dir, 'IDLE', a.ghost ? 0 : fr, sc, { ghost: a.ghost }), (cx - 40) * sc, (cy - 58) * sc);
        if (a.ghost) {
          ctx.save(); ctx.scale(sc, sc); ctx.translate(cx - 32, cy - 56);
          S.drawGhostBadge(ctx, 34, 0, '3', P.UI.font);
          ctx.restore();
        }
      }
    }
  }
}

function buildScene() {
  const s = section('⑤ 场景拼合：墙 A / B 并排（<b>请你选一套</b>）',
    '同一块 12×12 局部（左上两边为外圈墙，上边开 P 的出口），按 (x+y) 行序绘制，前排墙压住后排角色的腿脚——遮挡只落在腿部 16px，头和躯干恒不被遮（03 §3.12）。右侧 AI-C 为幽灵态示例。A 套靠明度差分地/墙（ΔV 48，过需求 #7）；B 套整体更浅（ΔV 20），靠轮廓线 + 墙脚阴影 + 饱和度区分。');
  const row = document.createElement('div');
  row.className = 'scene-row';
  s.appendChild(row);
  const W = SN * 64;
  const H = SN * 32 + 48;
  for (const set of ['A', 'B']) {
    const box = document.createElement('div');
    box.className = 'scene';
    box.innerHTML = `<h3>${P.WALL_SETS[set].name} · zoom 1.0</h3>`;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    box.appendChild(c);
    row.appendChild(box);
    live.push({ canvas: c, scale: 1, animated: true, paint: (ctx, t) => drawScene(ctx, set, st.anim ? t : 0.4, 1) });
  }
  const row2 = document.createElement('div');
  row2.className = 'scene-row';
  row2.style.marginTop = '12px';
  s.appendChild(row2);
  for (const set of ['A', 'B']) {
    const box = document.createElement('div');
    box.className = 'scene';
    box.innerHTML = `<h3>${set} 套 · zoom 0.6（中档，每帧缩放绘制）</h3>`;
    const c = document.createElement('canvas');
    c.width = Math.round(W * 0.6);
    c.height = Math.round(H * 0.6);
    box.appendChild(c);
    row2.appendChild(box);
    live.push({ canvas: c, scale: 1, animated: true, paint: (ctx, t) => { ctx.imageSmoothingEnabled = true; ctx.scale(0.6, 0.6); drawScene(ctx, set, st.anim ? t : 0.4, 1); } });
  }
  live.slice(-4).forEach((it) => drawItem(it, 0.4));
}

function buildLod() {
  const s = section('⑥ 缩放 LOD 屏幕空间标记（zoom &lt; 0.6）',
    '恒定屏幕尺寸，不乘 zoom：玩家 16px（金环 + 粉芯）、出口 12px（座位色菱形 + 光条）、AI 10px 菱形。下面左为 1:1 屏幕像素，右为放大查看；底图模拟 0.234 档地面。');
  const g = grid(s);
  card(g, '标记 · 1:1 屏幕像素', '0.234 档：tile 15×7px', {
    w: 150, h: 40, animated: false,
    paint: (ctx, t, sc) => vec(ctx, sc, 0, 0, (x) => {
      x.fillStyle = P.FLOOR[0]; x.fillRect(0, 0, 150, 40);
      x.fillStyle = P.WALL_SETS.A.top;
      for (let i = 0; i < 10; i++) x.fillRect(i * 15 + (i % 3) * 2, 30 - (i % 2) * 4, 9, 4);
      S.drawMarkerPlayer(x, 18, 18);
      for (let i = 0; i < 4; i++) S.drawMarkerExit(x, 46 + i * 18, 22, P.ACTOR_COLORS[i]);
      for (let i = 1; i < 4; i++) S.drawMarkerAI(x, 108 + (i - 1) * 14, 20, P.ACTOR_COLORS[i]);
    }),
  });
}

function gemIconCanvas(c, size = 18) {
  const k = size / 20;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const x = cv.getContext('2d');
  x.drawImage(gemSprite(c, 0, 1), 23, 34, 18, 20, (size - 18 * k) / 2, 0, 18 * k, 20 * k);
  return cv;
}

function buildUi() {
  const s = section('⑦ UI 件（DOM / CSS）',
    '面板四角 45° 斜切 12px、名牌左侧 4px 座位色竖条、体力条 4 档同时改格数（颜色不是唯一载体）、倍速/时长读数常驻右上（不可交互）。按钮五态。');
  const wrap = document.createElement('div');
  wrap.className = 'ui-wrap';
  s.appendChild(wrap);
  const col1 = document.createElement('div');
  col1.className = 'ui-col';
  col1.innerHTML = `
    <div class="ui-cap">主按钮 200×56 · 默认 / 悬停 / 按下 / 禁用 / 选中</div>
    <div class="btn"><span>开始对局</span></div>
    <div class="btn hover"><span>开始对局</span></div>
    <div class="btn down"><span>开始对局</span></div>
    <div class="btn disabled"><span>开始对局</span></div>
    <div class="btn sel" style="--c:${P.ACTOR_COLORS[0]}"><span>手动操控</span></div>`;
  wrap.appendChild(col1);
  const col2 = document.createElement('div');
  col2.className = 'ui-col';
  const tiers = [[82, 'ok'], [45, 'mid'], [22, 'low'], [6, 'crit']];
  col2.insertAdjacentHTML('beforeend', '<div class="ui-cap">体力条 240×16 · >60% / 30–60% / 10–30% / &lt;10%</div>');
  for (const [pct] of tiers) {
    const tier = P.staminaTier(pct);
    col2.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:8px;align-items:center"><div class="stam">${[0, 1, 2, 3].map((i) => `<i class="${i < tier.cells ? '' : 'off'}" style="--f:${tier.color}"></i>`).join('')}</div><span class="s">${pct}%</span></div>`);
  }
  col2.insertAdjacentHTML('beforeend', '<div class="ui-cap" style="margin-top:8px">名牌 168×32 · 当前回合 / 非当前</div>');
  for (let i = 0; i < 4; i++) {
    const el = document.createElement('div');
    el.className = `plate ${i === 0 ? 'cur' : ''}`;
    el.style.setProperty('--c', P.ACTOR_COLORS[i]);
    el.innerHTML = `<span class="sw" style="background:${P.ACTOR_COLORS[i]};border-radius:50%"></span>${SEAT_CN[i]}<span class="sc">${[12, 9, 7, 3][i]} 分</span>`;
    col2.appendChild(el);
  }
  wrap.appendChild(col2);
  const col3 = document.createElement('div');
  col3.className = 'ui-col';
  col3.innerHTML = `<div class="ui-cap">倍速 / 时长读数 132×32（压在最亮地面上）</div>
    <div class="speed-bed"><div class="speed">1× · 预计 81 秒</div><div class="speed">2× · 预计 40 秒</div><div class="speed">4× · 预计 20 秒</div></div>
    <div class="ui-cap" style="margin-top:8px">面板 · 斜切 12px</div>`;
  const frame = document.createElement('div');
  frame.className = 'panel-frame';
  frame.innerHTML = '<div class="panel"><h4>玩家 P · 持有</h4><div class="gemrow"></div><div class="s" style="margin-top:8px">成套 ×1 · 宝石 7 + 成套 5 = 12 分</div></div>';
  const row = frame.querySelector('.gemrow');
  [2, 1, 2, 1, 1].forEach((n, c) => {
    const sp = document.createElement('span');
    sp.appendChild(gemIconCanvas(c));
    sp.insertAdjacentText('beforeend', `×${n}`);
    row.appendChild(sp);
  });
  col3.appendChild(frame);
  wrap.appendChild(col3);
}

function buildChecks() {
  const s = section('⑧ 配色核算（自动计算）', '对照 03 §1.2 / §1.8 的硬约束；紫宝石按当前选中的候选色计算。');
  const rows = [];
  const add = (name, val, ok) => rows.push(`<tr><td>${name}</td><td>${val}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? '通过' : '不过'}</td></tr>`);
  const sceneS = [...P.FLOOR.slice(0, 4), ...P.DECO.map((d) => d.color), ...Object.values(P.WALL_SETS).flatMap((w) => [w.top, w.left, w.right])];
  const maxS = Math.max(...sceneS.map((c) => P.hsv(c).s));
  const minA = Math.min(...P.ACTOR_COLORS.map((c) => P.hsv(c).s));
  add('非出口场景色 HSV S ≤ 0.25（V21）', maxS.toFixed(3), maxS <= 0.25);
  add('角色色 HSV S ≥ 0.55', minA.toFixed(3), minA >= 0.55);
  add('二者间隔 ≥ 0.30（N18）', (minA - maxS).toFixed(3), minA - maxS >= 0.3);
  const dvA = P.hsv(P.FLOOR[0]).v - P.hsv(P.WALL_SETS.A.top).v;
  add('A 套 地面 F1 vs 墙顶 ΔV ≥ 40（需求 #7）', dvA, dvA >= 40);
  const cB = P.contrast(P.WALL_B_OUTLINE, P.WALL_SETS.B.top);
  const cBf = P.contrast(P.WALL_B_OUTLINE, P.FLOOR[0]);
  add('B 套 轮廓 #4A443A 对墙顶 / 地面 ≥ 5:1', `${cB.toFixed(2)} / ${cBf.toFixed(2)}`, cB >= 5 && cBf >= 5);
  add('描边 #3B362F 对地面 F1', `${P.contrast(P.INK, P.FLOOR[0]).toFixed(2)}:1`, P.contrast(P.INK, P.FLOOR[0]) >= 4.5);
  const Ls = gemCols().map((c) => P.lstar(c));
  let minDL = 99;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) minDL = Math.min(minDL, Math.abs(Ls[i] - Ls[j]));
  add('五宝石两两 ΔL*（参考，外形兜底）', `${Ls.map((l) => l.toFixed(0)).join(' / ')} · 最小 ${minDL.toFixed(1)}`, true);
  const gap = P.hueGap(purpleHex(), P.ACTOR_COLORS[1]);
  add('紫宝石 vs AI-A 色相差（建议 ≥ 40°）', `${gap.toFixed(0)}°`, gap >= 40);
  const haloGap = P.hueGap(P.REVEAL.score.mid, P.HALO);
  add('得分爆发色 vs 光环金 色相差（建议 ≥ 8°）+ 明度差', `${haloGap.toFixed(0)}° / ΔL* ${(P.lstar(P.HALO) - P.lstar(P.REVEAL.score.mid)).toFixed(0)}`, haloGap >= 8);
  s.insertAdjacentHTML('beforeend', `<table class="chk"><tr><th>判据</th><th>实测</th><th>结论</th></tr>${rows.join('')}</table>`);
}

// ---------- 控件与主循环 ----------

function rebuild() {
  live.length = 0;
  main.innerHTML = '';
  buildPilot(main, live, drawItem);
  main.insertAdjacentHTML('beforeend', '<p class="note" style="margin:32px 0 0;padding-top:12px;border-top:1px solid #CDBFAD">以下为第 1 步的程序化（Canvas 2D 矢量）样张，保留作对照。</p>');
  buildScene();
  buildTerrain();
  buildRobots();
  buildGems();
  buildChest();
  buildLod();
  buildUi();
  buildChecks();
}

function buildZoom() {
  $('zoom').innerHTML = ZOOMS.map((z) => `<button data-z="${z}" class="${z === st.zoom ? 'on' : ''}">${z}×</button>`).join('');
  $('zoom').onclick = (e) => {
    const z = Number(e.target.dataset.z);
    if (!z) return;
    st.zoom = z;
    buildZoom();
    rebuild();
  };
}

$('gray').onchange = (e) => { st.gray = e.target.checked; document.body.classList.toggle('gray', st.gray); };
$('anim').onchange = (e) => { st.anim = e.target.checked; for (const it of live) drawItem(it, 0.4); };

function frame(ts) {
  if (st.anim) {
    const t = ts / 1000;
    for (const it of live) if (it.animated) drawItem(it, t);
  }
  requestAnimationFrame(frame);
}

buildZoom();
rebuild();
requestAnimationFrame(frame);
window.__galleryReady = true;
