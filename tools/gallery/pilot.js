// 样张页 · 3D 管线试做区：读 Blender 渲染的图集（assets/atlas/pilot*.json），在 64px 实际尺寸下拼场景、播走路。
// 描边三档对比：无 / 深色 #3B362F / 本色加深。工具层，可用 rAF。

import * as S from '../../src/render/sprites.js';
import * as P from '../../src/render/palette.js';
import { tileCenter } from '../../src/render/iso.js';
import { tileHash, decoVariant } from '../../src/render/variants.js';

const ATLAS = {};
const ENV = {}; // 场外布景图集（env*.png）：不挡首屏，到货后静态层自动重烘
const pending = {};

async function loadAtlas(name, scale) {
  const suffix = scale === 1 ? '' : `@${scale}x`;
  const res = await fetch(`/assets/atlas/${name}${suffix}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读不到 /assets/atlas/${name}${suffix}.json（先跑 node tools/art/build.mjs）`);
  const m = await res.json();
  const img = new Image();
  img.src = `/assets/atlas/${m.file}?v=${m.bytes}`;
  await img.decode();
  return { m, img };
}

/**
 * 加载策略（已与用户确认）：首屏只等 1×；@2x 在 1× 就绪后、浏览器空闲时后台补拉，
 * 拉到之前凡是要 @2x 的地方先用 1× 放大顶上（blit 内回退），拉到后自动切换。
 * 场外布景 env 与 1× 并行拉但不等它：到货前场外只有底色，到货后静态层重烘（地图本身一帧不差）。
 */
export function loadPilot() {
  if (!pending[1]) {
    const warn = (what) => (e) => console.warn(`${what}加载失败`, e);
    loadAtlas('env', 1).then((a) => { ENV[1] = a; }).catch(warn('场外布景图集 env.png '));
    pending[1] = loadAtlas('pilot', 1).then((a) => {
      ATLAS[1] = a;
      // 页面一直在跑 rAF 动画时浏览器可能迟迟不空闲 → 给 idle 回调加 1 s 兜底
      const idle = globalThis.requestIdleCallback
        ? (f) => globalThis.requestIdleCallback(f, { timeout: 1000 })
        : (f) => setTimeout(f, 200);
      idle(() => {
        pending[2] = loadAtlas('pilot', 2).then((b) => { ATLAS[2] = b; }).catch(warn('@2x 图集补加载失败，继续用 1× 放大；'));
        loadAtlas('env', 2).then((b) => { ENV[2] = b; }).catch(warn('@2x 场外布景'));
      });
      return a;
    });
  }
  return pending[1];
}

const bookOf = (name) => (name.startsWith('ENV_') ? ENV : ATLAS);
const hasScale = (scale, name = '') => Boolean(bookOf(name)[scale]);

// ---------- sprite 取用 / 描边 ----------

const cache = new Map();

function frameOf(name, scale) {
  const f = bookOf(name)[scale].m.frames[name];
  if (!f) throw new Error(`图集缺 ${name}`);
  return f;
}

function rawSprite(name, scale) {
  const key = `raw|${name}|${scale}`;
  if (!cache.has(key)) {
    const f = frameOf(name, scale);
    const c = S.makeCanvas(f.w, f.h);
    c.getContext('2d').drawImage(bookOf(name)[scale].img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    cache.set(key, c);
  }
  return cache.get(key);
}

/** 本色加深描边：把 sprite 向 8 方向膨胀 r px，膨胀出的那圈用邻近像素颜色压暗。 */
function selfRing(src, r) {
  const c = S.makeCanvas(src.width, src.height);
  const x = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    x.drawImage(src, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
  }
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = 'rgba(45,30,24,0.58)';
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'destination-out';
  x.drawImage(src, 0, 0);
  return c;
}

function ringOf(base, scale, mode) {
  if (mode === 'self') return selfRing(base, scale);
  return S.outlineRing(base, P.INK, scale);
}

/** mode: none | ink | self；ghost：本体 α.35 去饱和，描边保留 α1（03 §3.9）。 */
function sprite(name, scale, mode, ghost = false) {
  const key = `${name}|${scale}|${mode}|${ghost}`;
  if (cache.has(key)) return cache.get(key);
  const base = rawSprite(name, scale);
  let out = base;
  if (ghost) {
    out = S.makeCanvas(base.width, base.height);
    const o = out.getContext('2d');
    o.drawImage(ringOf(base, scale, mode === 'none' ? 'ink' : mode), 0, 0);
    o.globalAlpha = 0.35;
    o.drawImage(S.desaturateCanvas(base, 0.65), 0, 0);
  } else if (mode !== 'none') {
    out = S.makeCanvas(base.width, base.height);
    const o = out.getContext('2d');
    o.drawImage(ringOf(base, scale, mode), 0, 0);
    o.drawImage(base, 0, 0);
  }
  cache.set(key, out);
  return out;
}

/** 全灰版本（出局 tween 用：按进度叠上去，60% 时 = 03 §3.3 的「去饱和 60%」）。 */
function graySprite(name, scale) {
  const key = `gray|${name}|${scale}`;
  if (!cache.has(key)) cache.set(key, S.desaturateCanvas(rawSprite(name, scale), 1));
  return cache.get(key);
}

/**
 * 把 sprite 的锚点放到 (wx, wy)（1× 世界像素），按 scale 放大并对齐到整像素。
 * 要 @2x 但还没补加载完 → 用 1× sprite 放大 2 倍顶上（描边也随之变 2px，与 @2x 描边粗细一致）。
 * desat ∈ [0,1]：在本体上叠一层全灰（描边不动）。
 */
function blit(ctx, name, scale, wx, wy, { mode = 'none', ghost = false, alpha = 1, desat = 0 } = {}) {
  const src = hasScale(scale, name) ? scale : 1;
  const k = scale / src;
  const f = frameOf(name, src);
  const c = mode === 'raw' ? rawSprite(name, src) : sprite(name, src, mode, ghost);
  const x = Math.round(wx * scale - f.ax * k);
  const y = Math.round(wy * scale - f.ay * k);
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, x, y, c.width * k, c.height * k);
  if (desat > 0) {
    const g = graySprite(name, src);
    ctx.globalAlpha = alpha * desat;
    ctx.drawImage(g, x, y, g.width * k, g.height * k);
  }
  ctx.globalAlpha = 1;
}

// ---------- 动画时间轴 ----------

const MOVE_SEQ = [['MOVE', 0, 2], ['MOVE', 1, 1], ['MOVE', 2, 1], ['MOVE', 3, 1], ['MOVE', 0, 1], ['IDLE', 0, 2]];
const HOP = [0, 1.5, 3.5, 2, 0, 0];

/** 一步内的拍：t ∈ [0,1) → {state, frame, beat}（hold 2-1-1-1-1-2，共 8 单位）。 */
function moveBeat(t) {
  let u = t * 8;
  for (let b = 0; b < MOVE_SEQ.length; b++) {
    if (u < MOVE_SEQ[b][2]) return { state: MOVE_SEQ[b][0], frame: MOVE_SEQ[b][1], beat: b };
    u -= MOVE_SEQ[b][2];
  }
  return { state: 'IDLE', frame: 0, beat: 5 };
}

/** 位移进度：蓄力拍不动，腾空 3 拍完成位移，落地后停。 */
function moveProgress(t) {
  const p = Math.min(1, Math.max(0, (t - 0.25) / 0.625));
  return p * p * (3 - 2 * p);
}

const IDLE_P = [[0, 420], [1, 380], [2, 380], [0, 420], [3, 120], [0, 300]];
const IDLE_A = [[0, 600], [1, 600]];
function seqFrame(seq, ms) {
  const total = seq.reduce((s, q) => s + q[1], 0);
  let r = ms % total;
  for (const [f, d] of seq) {
    if (r < d) return f;
    r -= d;
  }
  return seq[0][0];
}

/** 拾取 / 受阻 / 出局的单次演出时长（ms），其后回 IDLE_00 停一会再循环。 */
const ACT_SEQ = {
  player: {
    PICK: [[0, 90], [1, 200], [2, 260]],
    BLOCK: [[0, 140], [1, 120]],
    DEAD: [[0, 160], [1, 640]],
  },
  ai: {
    PICK: [[0, 90], [1, 360]],
    BLOCK: [[0, 260]],
    DEAD: [[0, 800]],
  },
};
const DEAD_TWEEN = 600; // 下沉 4px + 去饱和 60%（03 §3.3），由动画层做，sprite 不含
const pad2 = (n) => String(n).padStart(2, '0');

/** 一次状态演出 + 停顿（出局停在终帧，其余回 IDLE_00）：返回 {name, sink, desat}。base 如 'ACT_PLAYER'。 */
function stateNames(base, dir, kind, state, rest = 600) {
  const seq = ACT_SEQ[kind][state];
  const len = seq.reduce((s, q) => s + q[1], 0);
  return (ms) => {
    const r = ms % (len + rest);
    if (r >= len && state !== 'DEAD') return { name: `${base}_IDLE_${dir}_00` };
    const out = { name: `${base}_${state}_${dir}_${pad2(seqFrame(seq, Math.min(r, len - 1)))}` };
    if (state === 'DEAD') {
      const p = Math.min(1, r / DEAD_TWEEN);
      const e = p * p * (3 - 2 * p);
      out.sink = 4 * e;
      out.desat = 0.6 * e;
    }
    return out;
  };
}

/** 依次轮播 拾取 → 受阻 → 出局。 */
function cycleStates(base, dir, kind) {
  const parts = ['PICK', 'BLOCK', 'DEAD'].map((s) => stateNames(base, dir, kind, s));
  const span = 1400;
  return (ms) => parts[Math.floor(ms / span) % 3](ms % span);
}

// 宝箱：闭合呼吸 ×2 → 开盖 35/70/100° → 迸发（盖过冲）→ 回落 → 空箱停留
const CHEST_SEQ = [[0, 700], [1, 700], [0, 700], [1, 700], [2, 80], [3, 80], [4, 90], [5, 140], [6, 240], [7, 1400]];

// ---------- 场景 ----------
// 视口 1280×720（03 §3.10 参考视口），zoom 1.0。20×20 的菱形正好 1280×640：左右顶点贴视口边、上下各留 40px，
// 地图占满视口能占的全部面积；菱形外的四个角三角形放 HUD，HUD 底下是场外布景（台地土崖 + 林子，见下方「场外布景」）。

const SCENE = [
  '######.#############',
  '#....#.....#.......#',
  '#.##.#.###...####.##',
  '#.#......#.#.#.....#',
  '#.#.####.#.#.#.###.#',
  '#...#..#...#...#...#',
  '###.#..###.####.#.##',
  '#......#...#.....#..',
  '#.####.#.#.#.###.#.#',
  '#......#.#.....#...#',
  '#.#.#....#.#.#.#.###',
  '#.#.#.##.#...#...#.#',
  '#.#...#..#.###.#.#.#',
  '#.###.#.##...#.#...#',
  '....#.#....#.#.###.#',
  '###.#.####.#.#.....#',
  '#...#......#.####.##',
  '#.#####.##.#.....#.#',
  '#.......#....#.....#',
  '################.###',
];
const SN = SCENE.length;
const isWall = (x, y) => x < 0 || y < 0 || x >= SN || y >= SN || SCENE[y][x] === '#';
// 出口在外圈上，每座位一个（[x, y, 座位序号]）；只有玩家出口带光柱
const EXITS = [[6, 0, 0], [19, 7, 1], [16, 19, 2], [0, 14, 3]];
const LOOP = [[1, 1], [2, 1], [3, 1], [4, 1], [4, 2], [4, 3], [3, 3], [3, 4], [3, 5], [2, 5], [1, 5], [1, 4], [1, 3], [1, 2]];
// [x, y, 宝石序号（GEM_KEYS 顺序：红黄绿蓝紫）]
const GEMS = [[6, 7, 0], [10, 10, 1], [8, 3, 2], [2, 9, 3], [9, 1, 4], [13, 7, 1], [16, 12, 2], [3, 16, 4], [11, 18, 0], [17, 15, 3]];
const CHESTS = [[8, 5], [7, 14]];
const AIS = [
  { key: 'AIA', x: 15, y: 7, dir: 'e' },
  { key: 'AIB', x: 16, y: 17, dir: 'n' },
  { key: 'AIC', x: 1, y: 13, dir: 's', ghost: true },
];
const VIEW_W = 1280;
const VIEW_H = 720;
const OX = VIEW_W / 2;
const OY = (VIEW_H - SN * 32) / 2;
// 地图外底色：取绿篱的色相（#62AE5A ≈ 114°），饱和度略降、明度压到 22% —— 与画面同一色系，但比最暗的绿篱侧面还暗一大档，把菱形托出来
const HUD_BG = '#243822';
const at = (x, y) => {
  const [cx, cy] = tileCenter(x, y);
  return [OX + cx, OY + cy];
};
// 地面 4 种拼法均匀轮换；墙：素面绿篱为主（~45%），其余 4 种植物 / 高度变体分摊
const floorName = (x, y) => `TIL_FLOOR${pad2((tileHash(x, y) & 3) + 1)}_na_00`;
const WALL_MIX = [1, 1, 1, 1, 1, 2, 2, 3, 4, 4, 5];
const wallIdx = (x, y) => WALL_MIX[tileHash(x + 7, y + 3) % WALL_MIX.length];
const wallName = (x, y) => `TIL_WALL${pad2(wallIdx(x, y))}_na_00`;
const wallShadow = (x, y) => `SHD_WALL${pad2(wallIdx(x, y))}_na_00`;
// 装饰：03 §5 的密度 / 选型 hash；出口 2 格邻域、宝石 / 宝箱格不放
const decoBlocked = (x, y) => EXITS.some(([ex, ey]) => Math.max(Math.abs(x - ex), Math.abs(y - ey)) <= 2)
  || GEMS.some(([gx, gy]) => gx === x && gy === y) || CHESTS.some(([cx, cy]) => cx === x && cy === y);
const DECO_DENSITY = 0.15;
const dirOf = (a, b) => (b[0] > a[0] ? 'e' : b[0] < a[0] ? 'w' : b[1] > a[1] ? 's' : 'n');
const GEM_KEYS = P.GEM_KEYS;

// ---------- 场外布景（菱形之外；参考图的外围：台地土崖 + 圆冠密林） ----------
// 地图 = 一块抬高的台地：朝镜头的两条边（SW / SE）露出 CLIFF px 高的土崖，场外地面比地图低 CLIFF。
// 场外按同一套等距格继续铺：后方（网格 x<0 或 y<0）画在地图之前、被地图挡住下半截，只露出探过外圈绿篱的树冠；
// 前方（x≥SN 或 y≥SN）画在土崖之后，且任何一件的剪影顶都不越过菱形下边线 —— 不压地图一格（越线就换矮一档，直到灌木 / 石块）。
// 崖脚沿两条前沿再撒一排灌木 / 石块，盖住土崖与地面的交线。全部烘进静态层，HUD 照常盖在上面。
const CLIFF = 28; // = tools/art/blender/models.py CLIFF_PX
// 前方布景最多盖住土崖的下 40%：上面（草皮卷边 + 两层地层）始终露出来，台地才读得出「高出一截」
const CLIFF_SHOW = Math.round(CLIFF * 0.6);
const DIAMOND = [[OX, OY], [OX + SN * 32, OY + SN * 16], [OX, OY + SN * 32], [OX - SN * 32, OY + SN * 16]];
/** 菱形下边线（地图在屏幕上的最低处）在横坐标 x 处的 y。 */
const yLow = (x) => OY + SN * 32 - Math.abs(x - OX) / 2;
// 林相按 3×3 格一片：阔叶林 / 塔松林 / 林间空地（树稀、灌木石块多、露出深色林地）—— 成片成簇，不是均匀的一层毯子
const ENV_ZONES = [
  [50, [['TREE01', 30], ['TREE04', 28], ['TREE02', 26], ['TREE03', 8], ['PINE01', 4], [null, 4]]],
  [28, [['PINE01', 52], ['TREE02', 16], ['TREE03', 16], ['TREE04', 8], [null, 8]]],
  [22, [['TREE03', 22], ['TREE02', 14], ['BUSH01', 18], ['BUSH02', 12], ['ROCK01', 10], [null, 24]]],
];
const ENV_NEAR = [['BUSH01', 34], ['BUSH02', 24], ['ROCK01', 6], ['TREE03', 25], [null, 11]];
const ENV_FOOT = [['BUSH01', 50], ['BUSH02', 35], ['ROCK01', 15]];
// 地标（左上 = 网格 x<0、右上 = 网格 y<0 的场外）：山墙小屋 / 蘑菇圆屋 / 圆木塔 / 石堆 / 发光玉石，屏幕落点 [名, x, y] 手工定。
// 只摆在后方：画在地图之前，地图一格都压不到；整件（含底边）离后边线 ≥ 20px（外圈绿篱探上来也碰不到），且避开 HUD 面板。
// 两处成组：左上、右上各一片林间空地（空地椭圆里的树约 1/3 换成灌木 / 石块、其余清掉，地上垫一块柔和的苔地），右上体力面板下再单立一座木塔；
// 另外与地标重叠、且不在它后面的树也清掉。玉石另在暗角之上加一圈静态辉光（不做动画：余光里不抢戏）。
const ENV_MARKS = [
  ['TOWER01', 250, 190], ['STONES01', 296, 110], ['CABIN01', 360, 120], ['JADE01', 440, 80], ['STONES02', 480, 46],
  ['STONES01', 760, 60], ['JADE02', 820, 74], ['CABIN02', 910, 118], ['STONES02', 985, 150], ['TOWER01', 1150, 236],
];
const ENV_CLEARINGS = [[360, 122, 150, 68], [872, 104, 132, 60], [1150, 232, 50, 26]];
const ENV_GLOW = [126, 240, 200];
const envName = (k) => `ENV_${k}_na_00`;

function pathOf(ctx, pts, close = true) {
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  if (close) ctx.closePath();
}

function pickWeighted(table, u) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = u * total;
  for (const [k, w] of table) {
    if (r < w) return k;
    r -= w;
  }
  return table[table.length - 1][0];
}

/** sprite 不透明像素的包围（1×，相对锚点；t = 锚点以上的高度）。 */
const BOX = new Map();
function contentBox(name) {
  if (BOX.has(name)) return BOX.get(name);
  const c = rawSprite(name, 1);
  const f = frameOf(name, 1);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let [l, r, t, b] = [c.width, -1, c.height, -1];
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] <= 16) continue;
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
    }
  }
  const box = { l: l - f.ax, r: r + 1 - f.ax, t: f.ay - t, b: b + 1 - f.ay };
  BOX.set(name, box);
  return box;
}

let ENV_PLAN = null;
/** 场外布景的摆放表（只依赖格坐标 hash，确定性；1× 包围盒定「越不越线」，@2x 同一张表）。 */
function envPlan() {
  if (ENV_PLAN) return ENV_PLAN;
  const visible = (n, wx, wy) => {
    const b = contentBox(n);
    return wx + b.r > 0 && wx + b.l < VIEW_W && wy - b.t < VIEW_H && wy + b.b > 0;
  };
  const fits = (n, wx, wy) => {
    const b = contentBox(n);
    const xm = Math.min(Math.max(OX, wx + b.l), wx + b.r); // 区间内离菱形中轴最近的点 = 下边线最低处
    return wy - b.t >= yLow(xm) + CLIFF_SHOW;
  };
  const shorter = ['TREE01', 'TREE04', 'PINE01', 'TREE02', 'TREE03', 'BUSH01', 'ROCK01', 'BUSH02']
    .map(envName).sort((p, q) => contentBox(q).t - contentBox(p).t);
  const fallback = (n, wx, wy) => shorter.slice(shorter.indexOf(n)).find((m) => fits(m, wx, wy)) || null;
  const back = [];
  const front = [];
  const cliffs = [];
  // 土崖：SW 前沿每格一段 → 南角 → SE 前沿每格一段；按行序画（后一段压前一段的重叠端，接缝不露）
  for (let i = 0; i < SN - 1; i++) {
    cliffs.push({ name: `ENV_CLIFF_SW${pad2((tileHash(i + 41, 83) % 3) + 1)}_na_00`, at: at(i, SN - 1), depth: i + SN - 1 });
    cliffs.push({ name: `ENV_CLIFF_SE${pad2((tileHash(97, i + 59) % 3) + 1)}_na_00`, at: at(SN - 1, i), depth: i + SN - 1 });
  }
  cliffs.push({ name: 'ENV_CLIFF_S_na_00', at: at(SN - 1, SN - 1), depth: 2 * SN - 2 });
  cliffs.sort((p, q) => p.depth - q.depth);
  // 崖脚：沿两条前沿约 60% 的格放一件灌木 / 石块（沿边偏移 ±0.3 格）
  for (let i = 0; i < SN; i++) {
    for (const side of [0, 1]) {
      const [gx, gy] = side ? [SN - 1, i] : [i, SN - 1];
      const h = tileHash(gx * 5 + 11 + side * 97, gy * 3 + 29);
      if ((h & 255) / 256 > 0.6) continue;
      const [cx, cy] = at(gx, gy);
      const t = (((h >>> 8) & 255) / 255 - 0.5) * 0.6;
      const wx = side ? cx + 16 - 32 * t : cx - 16 + 32 * t;
      const wy = cy + 8 + 16 * t + CLIFF + 4;
      const n = fallback(envName(pickWeighted(ENV_FOOT, ((h >>> 16) & 0xffff) / 65536)), wx, wy);
      if (n && visible(n, wx, wy)) front.push({ name: n, wx, wy, depth: gx + gy + 0.5 });
    }
  }
  // 场外各格：一格一件，格内抖动 ±7 / ±3 px
  const R = 14;
  for (let gy = -R; gy < SN + R; gy++) {
    for (let gx = -R; gx < SN + R; gx++) {
      if (gx >= 0 && gy >= 0 && gx < SN && gy < SN) continue;
      const h = tileHash(gx + 3001, gy + 7919);
      const isFront = gx >= SN || gy >= SN;
      const near = isFront && Math.max(gx, gy) === SN;
      const zone = pickWeighted(ENV_ZONES.map(([w], i) => [i, w]), (tileHash(Math.floor(gx / 3) + 61, Math.floor(gy / 3) + 17) & 0xffff) / 65536);
      const k = pickWeighted(near ? ENV_NEAR : ENV_ZONES[zone][1], (h & 0xffff) / 65536);
      if (!k) continue;
      const [cx, cy] = at(gx, gy);
      const wx = cx + ((h >>> 16) & 15) - 7.5;
      const wy = cy + CLIFF + ((h >>> 20) & 7) - 3.5;
      const n = isFront ? fallback(envName(k), wx, wy) : envName(k);
      if (!n || !visible(n, wx, wy)) continue;
      (isFront ? front : back).push({ name: n, wx, wy, depth: gx + gy });
    }
  }
  const order = (p, q) => p.depth - q.depth || p.wx - q.wx;
  // 地标：深度按落点反推回网格行（与林子同一套排序）；清掉压在它身上的树（同排及更靠前的），身后的树冠照常露出来
  const marks = ENV_MARKS.map(([k, wx, wy]) => ({ name: envName(k), wx, wy, depth: (wy - CLIFF - OY - 16) / 16 }));
  const overlap = (p, q, m) => {
    const a = contentBox(p.name);
    const b = contentBox(q.name);
    return p.wx + a.l < q.wx + b.r + m && q.wx + b.l < p.wx + a.r + m && p.wy - a.t < q.wy + b.b + m && q.wy - b.t < p.wy + a.b + m;
  };
  const inClearing = (it) => ENV_CLEARINGS.some(([cx, cy, rx, ry]) => ((it.wx - cx) / rx) ** 2 + ((it.wy - cy) / ry) ** 2 < 1);
  // 空地里的树：约 1/3 换成灌木 / 石块（空地不是秃的），其余清掉
  const glade = (it) => {
    if (!inClearing(it) || /^ENV_(BUSH|ROCK)/.test(it.name)) return it;
    const h = tileHash(Math.round(it.wx) + 503, Math.round(it.wy) + 211);
    return (h & 255) < 96 ? { ...it, name: envName(['BUSH01', 'BUSH02', 'ROCK01', 'BUSH01'][(h >>> 8) & 3]) } : null;
  };
  const kept = back.map(glade).filter((it) => it && !marks.some((mk) => it.depth > mk.depth - 0.5 && overlap(it, mk, 2)));
  const glows = marks.filter((mk) => mk.name.startsWith('ENV_JADE'));
  ENV_PLAN = { back: [...kept, ...marks].sort(order), front: front.sort(order), cliffs, glows };
  return ENV_PLAN;
}

/** 一件布景：先在落地点垫一块柔和的暗斑（压暗身后那棵的下半截 → 一簇簇分得开），再贴 sprite。 */
function envItems(ctx, items, scale) {
  for (const it of items) {
    const b = contentBox(it.name);
    const rx = (b.r - b.l) * 0.55;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(it.wx, it.wy - 2);
    ctx.scale(1, 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(8,18,10,0.5)');
    g.addColorStop(1, 'rgba(8,18,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
    blit(ctx, it.name, scale, it.wx, it.wy, { mode: 'raw' });
  }
}

/** 沿折线画一道模糊暗带（地图后沿的暗晕 / 崖脚落地影）。 */
function softBand(ctx, scale, pts, width, alpha, dy = 0) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.filter = `blur(${Math.round(width * 0.45 * scale)}px)`;
  ctx.beginPath();
  pathOf(ctx, pts.map(([px, py]) => [px, py + dy]), false);
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(6,14,8,${alpha})`;
  ctx.stroke();
  ctx.restore();
}

/** 林间空地：深色林地上垫一块柔和的苔地（比底色亮一档，仍远暗于地图），边缘淡进周围的树脚。 */
function clearingGround(ctx, scale) {
  ctx.save();
  ctx.scale(scale, scale);
  for (const [cx, cy, rx, ry] of ENV_CLEARINGS) {
    const r = rx * 1.15;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(74,104,60,0.5)');
    g.addColorStop(0.6, 'rgba(74,104,60,0.28)');
    g.addColorStop(1, 'rgba(74,104,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.restore();
}

/** 玉石辉光：叠在暗角之上（screen，不被压暗），裁掉菱形 —— 只亮场外，地图一格不沾。一圈晕 + 脚边地上一块扁椭圆光斑。 */
function jadeGlow(ctx, scale, items) {
  const c = (a) => `rgba(${ENV_GLOW.join(',')},${a})`;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  pathOf(ctx, DIAMOND);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';
  for (const it of items) {
    const b = contentBox(it.name);
    const cy = it.wy - b.t * 0.55;
    const r = b.t * 1.4;
    let g = ctx.createRadialGradient(it.wx, cy, 0, it.wx, cy, r);
    g.addColorStop(0, c(0.26));
    g.addColorStop(0.4, c(0.1));
    g.addColorStop(1, c(0));
    ctx.fillStyle = g;
    ctx.fillRect(it.wx - r, cy - r, r * 2, r * 2);
    ctx.save();
    ctx.translate(it.wx, it.wy);
    ctx.scale(1, 0.5);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, c(0.3));
    g.addColorStop(1, c(0));
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.restore();
}

function staticLayer(scale) {
  // @2x 补加载完成前烘的是 1× 放大版，键里带上「是否已有原生图集」，到货后自动重烘；场外布景同理（0 未到 / 1× / 原生）
  const env = ENV[1] ? (hasScale(scale, 'ENV_') ? 2 : 1) : 0;
  const key = `static|${scale}|${hasScale(scale)}|${env}`;
  if (cache.has(key)) return cache.get(key);
  const c = S.makeCanvas(VIEW_W * scale, VIEW_H * scale);
  const x = c.getContext('2d');
  x.fillStyle = HUD_BG;
  x.fillRect(0, 0, c.width, c.height);
  const plan = env ? envPlan() : null;
  if (plan) {
    clearingGround(x, scale);
    envItems(x, plan.back, scale);
    softBand(x, scale, [DIAMOND[3], DIAMOND[0], DIAMOND[1]], 16, 0.6, -2); // 后两条边外一圈暗晕：外圈绿篱与后面的树冠分开
  }
  // 菱形内先铺底色：墙块圆角处的细缝里不透出后面的林子
  x.save();
  x.scale(scale, scale);
  x.beginPath();
  pathOf(x, DIAMOND);
  x.fillStyle = HUD_BG;
  x.fill();
  x.restore();
  for (let gy = 0; gy < SN; gy++) for (let gx = 0; gx < SN; gx++) {
    if (isWall(gx, gy)) continue;
    const [wx, wy] = at(gx, gy);
    blit(x, floorName(gx, gy), scale, wx, wy, { mode: 'raw' });
    const d = decoVariant(gx, gy, DECO_DENSITY, decoBlocked);
    if (d >= 0) blit(x, `TIL_DECO${pad2(d + 1)}_na_00`, scale, wx, wy, { mode: 'raw' });
  }
  for (const [ex, ey, seat] of EXITS) blit(x, `TIL_EXIT_${P.SEAT_KEYS[seat]}_na_00`, scale, ...at(ex, ey), { mode: 'raw' });
  // 墙投影只落在台地上（不往土崖 / 场外林子上抹）
  x.save();
  x.beginPath();
  pathOf(x, DIAMOND.map(([px, py]) => [px * scale, py * scale]));
  x.clip();
  for (let gy = 0; gy < SN; gy++) for (let gx = 0; gx < SN; gx++) {
    if (!isWall(gx, gy)) continue;
    const [wx, wy] = at(gx, gy);
    blit(x, wallShadow(gx, gy), scale, wx, wy, { mode: 'raw' });
  }
  x.restore();
  if (plan) {
    for (const cl of plan.cliffs) blit(x, cl.name, scale, ...cl.at, { mode: 'raw' });
    softBand(x, scale, [DIAMOND[3], DIAMOND[2], DIAMOND[1]], 12, 0.7, CLIFF + 3); // 台地压在林地上的落地影
    envItems(x, plan.front, scale);
    // 暗角：只压场外（越往视口四角越暗，HUD 面板底下最暗 → 地图最亮、面板次之、林子垫底）
    x.save();
    x.scale(scale, scale);
    x.beginPath();
    x.rect(0, 0, VIEW_W, VIEW_H);
    pathOf(x, DIAMOND);
    x.clip('evenodd');
    x.translate(OX, OY + SN * 16);
    x.scale(1, 0.5);
    const g = x.createRadialGradient(0, 0, 520, 0, 0, 980);
    g.addColorStop(0, 'rgba(12,24,12,0)');
    g.addColorStop(1, 'rgba(12,24,12,0.62)');
    x.fillStyle = g;
    x.fillRect(-OX, -VIEW_H * 2, VIEW_W, VIEW_H * 4);
    x.restore();
    jadeGlow(x, scale, plan.glows);
  }
  cache.set(key, c);
  return c;
}

// ---------- HUD 实样（03 §3.10 视觉规格；运行时走 DOM/CSS，这里画出来只为核对布局与对比度） ----------
// 位置全部落在菱形外的四个角三角形里（距视口边 24px），不压地图一格。

const SECS = { 1: 81, 2: 40, 4: 20 };
const SEATS = [
  { name: '玩家', score: 1240 },
  { name: 'AI-A', score: 980 },
  { name: 'AI-B', score: 1105 },
  { name: 'AI-C', score: 760, note: '3 回合前' },
];
const HOLD = [2, 1, 0, 3, 1];
const HOME_STEPS = 18;
const MATCH_SEC = 40;

/** 面板：底 #EFE9E0@96% + 1px #5E574C + 四角 45° 斜切 12px（03 §3.10）。 */
function panel(ctx, x, y, w, h, c = 12) {
  x += 0.5;
  y += 0.5;
  w -= 1;
  h -= 1;
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
  ctx.fillStyle = P.UI.panel;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = P.LINE;
  ctx.stroke();
}

function label(ctx, s, x, y, { size = 13, weight = 600, color = P.INK, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${P.UI.font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

function glyph(ctx, kind, cx, cy) {
  ctx.fillStyle = P.INK;
  ctx.beginPath();
  if (kind === 'play') {
    ctx.moveTo(cx - 5, cy - 7);
    ctx.lineTo(cx + 7, cy);
    ctx.lineTo(cx - 5, cy + 7);
  } else {
    const s = kind === 'next' ? 1 : -1;
    ctx.moveTo(cx - 5 * s, cy - 6);
    ctx.lineTo(cx + 3 * s, cy);
    ctx.lineTo(cx - 5 * s, cy + 6);
    ctx.rect(s > 0 ? cx + 4 : cx - 6, cy - 6, 2, 12);
  }
  ctx.fill();
}

function drawHud(ctx, scale, k, ms, speed, mode) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';

  // 左上：分数 + 回合
  panel(ctx, 24, 24, 200, 64);
  label(ctx, '分数', 40, 42, { size: 12, weight: 500, color: P.LINE });
  label(ctx, SEATS[0].score.toLocaleString('en-US'), 40, 66, { size: 22, weight: 700 });
  label(ctx, '回合', 140, 42, { size: 12, weight: 500, color: P.LINE });
  label(ctx, String(1 + (k % 400)), 140, 66, { size: 22, weight: 700 });

  // 右上：倍速 / 时长（常驻读数）→ 体力 + 回家成本
  ctx.beginPath();
  ctx.roundRect(1124, 24, 132, 32, 6);
  ctx.fillStyle = P.UI.speedBg;
  ctx.fill();
  label(ctx, `${speed}× · 预计 ${SECS[speed]} 秒`, 1190, 40, { size: 14, color: '#FFFFFF', align: 'center' });
  const stamina = 64 - (k % 64);
  const tier = P.staminaTier((stamina / 64) * 100);
  const home = stamina >= HOME_STEPS * 1.3 ? '#3FBF6A' : stamina >= HOME_STEPS ? '#F2CE3B' : '#E8384F';
  panel(ctx, 1004, 64, 252, 64);
  label(ctx, '体力', 1016, 82, { size: 12, weight: 500, color: P.LINE });
  label(ctx, `${stamina} / 64`, 1046, 82);
  label(ctx, `回家 ${HOME_STEPS} 步`, 1244, 82, { align: 'right' });
  ctx.beginPath();
  ctx.arc(1176, 82, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = home;
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(1010, 98, 240, 16, 4);
  ctx.fillStyle = 'rgba(59,54,47,0.14)';
  ctx.fill();
  for (let i = 0; i < tier.cells; i++) {
    ctx.beginPath();
    ctx.roundRect(1012 + i * 60, 100, 56, 12, 2);
    ctx.fillStyle = tier.color;
    ctx.fill();
  }

  // 左下：宝石（各色持有 + 剩余代数）→ 回放控制条
  panel(ctx, 24, 576, 216, 60);
  label(ctx, '宝石 · 剩余 2 代', 40, 592, { size: 12, weight: 500, color: P.LINE });
  HOLD.forEach((n, i) => label(ctx, `×${n}`, 56 + i * 40, 619, { size: 12, color: n ? P.INK : P.UI.disabled }));
  panel(ctx, 24, 648, 480, 48);
  glyph(ctx, 'prev', 52, 672);
  glyph(ctx, 'play', 84, 672);
  glyph(ctx, 'next', 116, 672);
  const sec = (ms / 1000) % MATCH_SEC;
  ctx.beginPath();
  ctx.roundRect(140, 669, 260, 6, 3);
  ctx.fillStyle = 'rgba(59,54,47,0.18)';
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(140, 669, 260 * (sec / MATCH_SEC), 6, 3);
  ctx.fillStyle = P.BRASS;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(140 + 260 * (sec / MATCH_SEC), 672, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = P.INK;
  ctx.stroke();
  label(ctx, `0:${pad2(Math.floor(sec))} / 0:${MATCH_SEC}`, 488, 672, { size: 12, align: 'right' });

  // 右下：名牌（当前回合 = 左侧 4px 座位色竖条 + 亮底）
  SEATS.forEach((s, i) => {
    const y = 550 + i * 38;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(1088, y, 168, 32, 4);
    ctx.fillStyle = i === 0 ? P.UI.plate : P.UI.plateIdle;
    ctx.fill();
    ctx.clip();
    if (i === 0) {
      ctx.fillStyle = P.ACTOR_COLORS[i];
      ctx.fillRect(1088, y, 4, 32);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(1104, y + 16, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = P.ACTOR_COLORS[i];
    ctx.fill();
    label(ctx, s.name, 1116, y + 16);
    if (s.note) label(ctx, s.note, 1154, y + 16, { size: 11, weight: 500, color: P.UI.disabled });
    label(ctx, s.score.toLocaleString('en-US'), 1246, y + 16, { align: 'right' });
  });
  ctx.restore();

  // 宝石图标复用图集（blit 在设备像素下取整，放在变换外）
  GEM_KEYS.forEach((g, i) => blit(ctx, `PRP_GEM_${g}_na_00`, scale, 42 + i * 40, 630, { mode }));
}

function drawScene(ctx, t, opt) {
  const { scale, mode, speed } = opt;
  ctx.drawImage(staticLayer(scale), 0, 0);
  const ms = t * 1000;
  const stepMs = 200 / speed;
  const k = Math.floor(ms / stepMs);
  const u = (ms % stepMs) / stepMs;
  const from = LOOP[k % LOOP.length];
  const to = LOOP[(k + 1) % LOOP.length];
  const dir = dirOf(from, to);
  const beat = moveBeat(u);
  const p = moveProgress(u);
  const px = from[0] + (to[0] - from[0]) * p;
  const py = from[1] + (to[1] - from[1]) * p;
  const hop = HOP[beat.beat];
  // 移动中的角色按两格中行序较小的那格入列（02b 遮挡：前排墙能盖住它）
  const host = from[0] + from[1] <= to[0] + to[1] ? from : to;

  const drawPlayer = () => {
    const [wx, wy] = at(px, py);
    blit(ctx, 'SHD_PLAYER_na_00', scale, wx, wy, { mode: 'raw', alpha: 1 - hop * 0.06 });
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(wx - 32, wy - 56);
    S.drawHalo(ctx, t);
    ctx.restore();
    blit(ctx, `ACT_PLAYER_${beat.state}_${dir}_${pad2(beat.frame)}`, scale, wx, wy - hop, { mode });
  };

  for (let d = 0; d <= 2 * (SN - 1); d++) {
    for (let gx = Math.max(0, d - SN + 1); gx <= Math.min(SN - 1, d); gx++) {
      const gy = d - gx;
      const [wx, wy] = at(gx, gy);
      if (isWall(gx, gy)) {
        blit(ctx, wallName(gx, gy), scale, wx, wy, { mode: 'raw' });
        continue;
      }
      if (gx === EXITS[0][0] && gy === EXITS[0][1]) {
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(wx - 32, wy - 32);
        S.drawExitBeam(ctx, P.ACTOR_COLORS[0], t);
        ctx.restore();
      }
      for (const [ex, ey, gi] of GEMS) {
        if (ex !== gx || ey !== gy) continue;
        const f = Math.floor((ms + gi * 90) / 150) % 4;
        blit(ctx, `SHD_GEM_${GEM_KEYS[gi]}_na_00`, scale, wx, wy, { mode: 'raw' });
        blit(ctx, `PRP_GEM_${GEM_KEYS[gi]}_na_${pad2(f)}`, scale, wx, wy, { mode });
      }
      CHESTS.forEach(([cx, cy], i) => {
        if (cx !== gx || cy !== gy) return;
        blit(ctx, 'SHD_CHEST_na_00', scale, wx, wy, { mode: 'raw' });
        blit(ctx, `PRP_CHEST_na_${pad2(seqFrame(CHEST_SEQ, ms + i * 2300))}`, scale, wx, wy, { mode });
      });
      for (const a of AIS) {
        if (a.x !== gx || a.y !== gy) continue;
        if (!a.ghost) blit(ctx, 'SHD_AI_na_00', scale, wx, wy, { mode: 'raw' });
        const f = a.ghost ? 0 : seqFrame(IDLE_A, ms + a.x * 137);
        blit(ctx, `ACT_${a.key}_IDLE_${a.dir}_${pad2(f)}`, scale, wx, wy, { mode, ghost: a.ghost });
        if (a.ghost) {
          ctx.save();
          ctx.scale(scale, scale);
          ctx.translate(wx - 32, wy - 56);
          S.drawGhostBadge(ctx, 34, 0, '3', P.UI.font);
          ctx.restore();
        }
      }
      if (host[0] === gx && host[1] === gy) drawPlayer();
    }
  }
  ctx.globalAlpha = 1;
  if (opts.hud === 'on') drawHud(ctx, scale, k, ms, speed, mode);
}

// ---------- 区块 ----------

const opts = { mode: 'ink', speed: 2, hud: 'on' };

function segButtons(label, items, get, set) {
  const wrap = document.createElement('span');
  wrap.className = 'ctl';
  wrap.innerHTML = `<span>${label}</span><span class="seg"></span>`;
  const seg = wrap.querySelector('.seg');
  const render = () => {
    seg.innerHTML = items.map(([v, t]) => `<button data-v="${v}" class="${String(get()) === String(v) ? 'on' : ''}">${t}</button>`).join('');
  };
  seg.onclick = (e) => {
    const v = e.target.dataset.v;
    if (v === undefined) return;
    set(isNaN(Number(v)) ? v : Number(v));
    render();
  };
  render();
  return wrap;
}

/** fit：画布按容器宽度显示（@2x 视口 2560 px 太宽，放进页面里看，仍比 1× 大） */
function stageBox(parent, title, w, h, scale, paint, live, { fit = false } = {}) {
  const box = document.createElement('div');
  box.className = 'scene';
  box.innerHTML = `<h3>${title}</h3>`;
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  if (fit) {
    box.style.width = '100%';
    c.style.width = '100%';
    c.style.maxWidth = `${w * scale}px`;
    c.style.height = 'auto';
  } else {
    c.style.width = `${w * scale}px`;
    c.style.height = `${h * scale}px`;
  }
  box.appendChild(c);
  parent.appendChild(box);
  live.push({ canvas: c, scale: 1, animated: true, paint: (ctx, t) => paint(ctx, t) });
  return box;
}

/** 一格展台：地面 + 投影 + sprite（1× 与 @2x 两张）。 */
function plinth(parent, title, names, { shadow = null, live, cellW = 72, cellH = 76 }) {
  const el = document.createElement('div');
  el.className = 'card';
  const pics = document.createElement('div');
  pics.className = 'pics';
  el.appendChild(pics);
  for (const scale of [1, 2]) {
    const c = document.createElement('canvas');
    c.width = cellW * scale;
    c.height = cellH * scale;
    if (scale === 1) c.className = 'native';
    pics.appendChild(c);
    const ax = cellW / 2;
    const ay = cellH - 14;
    live.push({
      canvas: c, scale: 1, animated: true,
      paint: (ctx, t) => {
        const ms = t * 1000;
        blit(ctx, 'TIL_FLOOR01_na_00', scale, ax, ay, { mode: 'raw' });
        const n = names(ms);
        const sh = n.shadow === undefined ? shadow : n.shadow;
        if (sh) blit(ctx, sh, scale, ax, ay, { mode: 'raw', alpha: (1 - (n.hop || 0) * 0.06) * (1 - (n.sink || 0) * 0.12) });
        blit(ctx, n.name, scale, ax, ay - (n.hop || 0) + (n.sink || 0), { mode: n.tile ? 'raw' : opts.mode, ghost: n.ghost, desat: n.desat || 0 });
      },
    });
  }
  el.insertAdjacentHTML('beforeend', `<div class="t">${title}</div><div class="s">左 1× 实际像素 · 右 @2x 高分屏图集</div>`);
  parent.appendChild(el);
}

function walkNames(dir) {
  return (ms) => {
    const cyc = 200 + 360;
    const r = ms % cyc;
    if (r >= 200) return { name: `ACT_PLAYER_IDLE_${dir}_00` };
    const b = moveBeat(r / 200);
    return { name: `ACT_PLAYER_${b.state}_${dir}_${String(b.frame).padStart(2, '0')}`, hop: HOP[b.beat] };
  };
}

function aiWalkNames(key, dir) {
  return (ms) => {
    const cyc = 200 + 360;
    const r = ms % cyc;
    if (r >= 200) return { name: `ACT_${key}_IDLE_${dir}_00` };
    const b = moveBeat(r / 200);
    return { name: `ACT_${key}_${b.state}_${dir}_${String(b.frame).padStart(2, '0')}`, hop: HOP[b.beat] };
  };
}

export function buildPilot(main, live, drawItem) {
  const s = document.createElement('section');
  s.innerHTML = `<h2>⓪ 3D 管线试做（Blender 4.2 无头渲染 → 图集）</h2>
    <p class="note">按参考图的软胶玩具风格建模：玩家 = 蘑菇帽小人（座位色帽 + 白斑 + 大眼高光 + 腮红），AI = 圆头团子（同一模型三色，白眼豆瞳 + 一字嘴，无高光）；
    地面 = 同一种奶油石的 4 种拼法（细缝、圆角、缝交汇处嵌小圆石）；墙 = 植绒绿篱 5 变体（侧棱 16 / 14 / 12 px 三档高度 × 开心果 / 嫩芽 / 叶绿三档深浅；顶上素面 / 小白花 / 薄荷修剪球 / 粉绣球 / 四叶草）。相机正交 2:1 等距、光从左上，4× 超采样后在线性空间缩到 64px。
    角色含 待机 / 走路 / 拾取 / 受阻 / 出局（× 眼）全部状态；五色宝石外形 = 红竖长双锥 · 黄六角鼓包星 · 绿切角方 · 蓝水滴 · 紫扁六边板；宝箱 8 帧；出口 = 座位色下沉传送台（不高出地面）；地面装饰 3 种（草簇雏菊 / 落花瓣 / 苔藓卵石，按 03 §5 hash 15% 密度烘进静态层）。
    布局：1280×720 视口、zoom 1.0，20×20 地图的菱形正好 1280×640，左右顶点贴视口边——地图占满视口能占的全部面积；菱形外的四个角三角形放 HUD（按 03 §3.10 规格画的实样：左上分数 + 回合，右上倍速 / 时长 + 体力 + 回家成本，左下宝石 + 回放条，右下名牌），HUD 不压地图一格。四座位出口都在外圈上。
    场外布景（参考图的外围）：地图是一块抬高的台地，朝镜头的两条边露出 28px 土崖（三层地层 + 草皮卷边 + 嵌石 / 垂草，SW / SE 各 3 段变体 + 南角 1 段，段与段重叠拼接无缝）；四周按同一套等距格铺林子——阔叶林 / 塔松林 / 林间空地按 3×3 格成片，后方只露出探过外圈绿篱的树冠，前方任何一件都不越过菱形下边线、只许盖住土崖下 40%；崖脚撒一排灌木 / 石块；场外越往四角越暗。左上、右上各一片林间空地摆地标（童话村落风：大圆鱼鳞瓦顶、矮胖墙身、圆拱门圆窗）：红瓦山墙小屋、橙瓦蘑菇圆屋、灰蓝尖帽圆木塔、切面石堆 2 种、发光玉石 2 种（悬浮碎晶 + 静态辉光，不做动画）——只摆在地图后方，整件离后边线 ≥ 20px、不与 HUD 相交，地图一格不压。布景单独一套 env 图集，不挡首屏，到货后静态层重烘。
    墙的投影与角色 / 宝石 / 宝箱的落地影是单独渲染的阴影贴片（地面层 / 角色前绘制）。光环、出口光柱仍是程序绘制的动态层。下拉选描边档对比可读性；顶部「灰度检查」同样生效。</p>
    <div class="pilot-ctl" style="display:flex;gap:24px;flex-wrap:wrap;margin:0 0 12px"></div>
    <div class="pilot-stat s" style="margin:-4px 0 10px">加载图集中…</div>`;
  main.appendChild(s);
  const ctl = s.querySelector('.pilot-ctl');
  const reset = () => { for (const it of live) if (it.pilot) drawItem(it, 0.4); };
  ctl.appendChild(segButtons('描边', [['none', '无'], ['ink', '深色 #3B362F'], ['self', '本色加深']], () => opts.mode, (v) => { opts.mode = v; reset(); }));
  ctl.appendChild(segButtons('倍速', [[1, '1×'], [2, '2×'], [4, '4×']], () => opts.speed, (v) => { opts.speed = v; }));
  ctl.appendChild(segButtons('HUD', [['on', '显示'], ['off', '隐藏']], () => opts.hud, (v) => { opts.hud = v; reset(); }));

  loadPilot().then(() => {
    const m1 = ATLAS[1].m;
    const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
    const stat = s.querySelector('.pilot-stat');
    const t0 = performance.now();
    let t2 = 0;
    const render = () => {
      const m2 = ATLAS[2] && ATLAS[2].m;
      const e1 = ENV[1] && ENV[1].m;
      const e2 = ENV[2] && ENV[2].m;
      if (m2 && !t2) t2 = performance.now() - t0;
      const hi = m2 ? `@2x ${m2.size.join('×')} ${kb(m2.bytes)}（首屏后 ${(t2 / 1000).toFixed(1)} s 到货，已切换）` : '@2x 后台补加载中（暂以 1× 放大顶替）…';
      const env = e1 ? `场外布景 env ${Object.keys(e1.frames).length} 张 · 1× ${kb(e1.bytes)}${e2 ? ` / @2x ${kb(e2.bytes)}` : ''}（非首屏）` : '场外布景加载中…';
      stat.textContent = `${Object.keys(m1.frames).length} 张 sprite · 单张渲染中位 ${(m1.renderMs.median / 1000).toFixed(1)} s（256² · ${m1.meta.samples} spp · CPU）· 渲染总计 ${(m1.renderMs.total / 1000).toFixed(0)} s · 图集 1× ${m1.size.join('×')} ${kb(m1.bytes)}（首屏）· ${hi} · ${env}`;
      return Boolean(m2 && e2);
    };
    render();
    const watch = setInterval(() => { if (render() || performance.now() - t0 > 30000) clearInterval(watch); }, 100);

    const row = document.createElement('div');
    row.className = 'scene-row';
    s.appendChild(row);
    stageBox(row, `视口 ${VIEW_W}×${VIEW_H} · zoom 1.0 · 1× 实际像素（20×20 地图铺满视口宽；玩家沿环线走路，AI-C 为幽灵态）`, VIEW_W, VIEW_H, 1, (ctx, t) => drawScene(ctx, t, { scale: 1, mode: opts.mode, speed: opts.speed }), live);
    const row2 = document.createElement('div');
    row2.className = 'scene-row';
    row2.style.marginTop = '12px';
    s.appendChild(row2);
    stageBox(row2, '同一视口 · @2x 图集（高分屏；按页面宽度显示）', VIEW_W, VIEW_H, 2, (ctx, t) => drawScene(ctx, t, { scale: 2, mode: opts.mode, speed: opts.speed }), live, { fit: true });

    const g = document.createElement('div');
    g.className = 'grid';
    g.style.marginTop = '12px';
    s.appendChild(g);
    for (const d of ['n', 'e', 's', 'w']) {
      plinth(g, `玩家 · 走路 6 拍 · ${d}`, walkNames(d), { shadow: 'SHD_PLAYER_na_00', live });
    }
    for (const key of ['AIA', 'AIB', 'AIC']) {
      for (const d of ['s', 'e']) {
        plinth(g, `${key} · 走路 · ${d}`, aiWalkNames(key, d), { shadow: 'SHD_AI_na_00', live });
      }
    }
    for (const d of ['n', 'w']) {
      plinth(g, `AIA · 待机 · ${d}`, (ms) => ({ name: `ACT_AIA_IDLE_${d}_${String(seqFrame(IDLE_A, ms)).padStart(2, '0')}` }), { shadow: 'SHD_AI_na_00', live });
    }
    plinth(g, '玩家 · 待机（含眨眼）', (ms) => ({ name: `ACT_PLAYER_IDLE_s_${pad2(seqFrame(IDLE_P, ms))}` }), { shadow: 'SHD_PLAYER_na_00', live });

    // 拾取 → 受阻 → 出局 轮播（出局的下沉 4px + 去饱和 60% 由动画层 tween，sprite 不含）
    const g3 = document.createElement('div');
    g3.className = 'grid';
    g3.style.marginTop = '12px';
    s.appendChild(g3);
    for (const d of ['s', 'e', 'n', 'w']) {
      plinth(g3, `玩家 · 拾取 3 / 受阻 2 / 出局 2 · ${d}`, cycleStates('ACT_PLAYER', d, 'player'), { shadow: 'SHD_PLAYER_na_00', live });
    }
    for (const key of ['AIA', 'AIB', 'AIC']) {
      plinth(g3, `${key} · 拾取 2 / 受阻 1 / 出局 1 · s`, cycleStates(`ACT_${key}`, 's', 'ai'), { shadow: 'SHD_AI_na_00', live });
    }
    plinth(g3, 'AIA · 拾取 / 受阻 / 出局 · e', cycleStates('ACT_AIA', 'e', 'ai'), { shadow: 'SHD_AI_na_00', live });

    // 五色宝石 + 宝箱
    const g4 = document.createElement('div');
    g4.className = 'grid';
    g4.style.marginTop = '12px';
    s.appendChild(g4);
    GEM_KEYS.forEach((k, i) => {
      plinth(g4, `${P.GEM_NAMES[i]}宝石 ${k} · 4 帧悬浮`, (ms) => ({ name: `PRP_GEM_${k}_na_${pad2(Math.floor(ms / 150) % 4)}` }),
        { shadow: `SHD_GEM_${k}_na_00`, live });
    });
    plinth(g4, '宝箱 · 8 帧（闭合呼吸 → 开盖 → 迸发 → 空箱）', (ms) => ({ name: `PRP_CHEST_na_${pad2(seqFrame(CHEST_SEQ, ms))}` }),
      { shadow: 'SHD_CHEST_na_00', live });
    for (const f of [0, 4, 5, 7]) {
      plinth(g4, `宝箱 · ${pad2(f)} ${['闭合', '', '', '', '全开', '迸发', '', '空箱'][f]}`, () => ({ name: `PRP_CHEST_na_${pad2(f)}` }),
        { shadow: 'SHD_CHEST_na_00', live });
    }

    const g2 = document.createElement('div');
    g2.className = 'grid';
    g2.style.marginTop = '12px';
    s.appendChild(g2);
    const tiles = Object.keys(m1.frames).filter((n) => n.startsWith('TIL_')).sort();
    for (const n of tiles) {
      plinth(g2, n.replace('_na_00', ''), () => ({ name: n, tile: true }), { live });
    }
    for (const it of live) if (!it.pilot && it.canvas.closest('section') === s) it.pilot = true;
  }).catch((e) => {
    s.querySelector('.pilot-stat').innerHTML = `<span class="bad">${e.message}</span>`;
  });
  return s;
}
