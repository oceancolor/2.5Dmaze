// 小地图（右上，正交俯视、正方形）。Tab 或标题栏按钮收起 / 展开，状态记在 localStorage。
//
// 信息与主画面同源（scene.actorViews）：地形、宝石、宝箱全公开；对手只在视野内画真身，视野外画「最后目击」幽灵 +
// 已过回合数；结算 / 观战后（god）全部真身。小地图不会比主画面多透露任何东西。
//
// 两层画布（2026-11-05 批次 1）：
//   底层  地形（墙 / 地板），整体半透明，透出底下的游戏画面；鼠标悬停时变实，方便看清路
//   上层  出口、宝石、宝箱、角色、主画面视口框，始终不透明 —— 透明了也找得到人和宝物
// 大小按规格分档（SIDE_BY_SIZE）：小图不至于每格十几像素占一大块，大图每格不少于约 3 像素、墙不糊成一片；
// 窗口放不下时按可用空间等比缩小（不压住其他面板），窗口缩放时重排。
// 点击 / 拖动小地图 = 把镜头移过去（全图档时先切回最近档）。

import { ACTOR_COLORS, GEM_COLORS_BASE, HALO, INK } from '../render/palette.js';
import { actorViews } from '../render/scene.js';
import { worldToTile, tileCenter } from '../render/iso.js';

const STORE = 'maze.minimap';
const WALL = '#3A3128';
const FLOOR = '#F3ECE0';

/** 各规格的小地图边长（CSS px）。XS 16 → 10 px/格，S 32 → 6.25，M 64 → 4.06，L 96 → 3.33，XL 128 → 3。 */
export const SIDE_BY_SIZE = Object.freeze({ 16: 160, 32: 200, 64: 260, 96: 320, 128: 384 });
/** 视口占比上限：高不超过视口 42%、宽不超过 28%（1440×900 下 XL 约 378 px）。 */
const MAX_H = 0.42;
const MAX_W = 0.28;
const MIN_SIDE = 120;

/** 规格的目标边长（非标准尺寸按边长插值，夹在 160–384）。 */
export function targetSide(N) {
  if (SIDE_BY_SIZE[N]) return SIDE_BY_SIZE[N];
  return Math.round(Math.min(384, Math.max(160, 120 + 2.1 * N)));
}

/** 实际边长：目标边长，但不超过视口可用空间（也不小于 MIN_SIDE）。 */
export function sideFor(N, viewW = 1440, viewH = 900) {
  const cap = Math.min(viewH * MAX_H, viewW * MAX_W);
  return Math.round(Math.max(Math.min(MIN_SIDE, targetSide(N)), Math.min(targetSide(N), cap)));
}

function loadOpen() {
  try {
    return localStorage.getItem(STORE) !== '0';
  } catch {
    return true;
  }
}

/**
 * @param {HTMLElement} host 挂载点
 * @param {{map:object, cfg:object, onLook:(wx:number, wy:number)=>void}} o
 */
export function createMinimap(host, { map, cfg, onLook }) {
  const N = map.size;
  let open = loadOpen();

  const box = document.createElement('div');
  box.className = 'minimap';
  box.innerHTML = `<div class="mm-head"><span>小地图 <small>${N}×${N}</small></span><span class="sp"></span>
    <button class="btn mini" data-mm="toggle" title="收起 / 展开（Tab）"></button></div>
    <div class="mm-body"><div class="mm-stack"><canvas class="mm-base"></canvas><canvas class="mm-top"></canvas></div><div class="mm-legend k"></div></div>`;
  host.append(box);
  const baseCv = box.querySelector('.mm-base');
  const cv = box.querySelector('.mm-top');
  const stack = box.querySelector('.mm-stack');
  const body = box.querySelector('.mm-body');
  const btn = box.querySelector('[data-mm="toggle"]');
  const legend = box.querySelector('.mm-legend');
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const ctx = cv.getContext('2d');

  // 底层：地形，按目标边长 × dpr 的整数像素 / 格画一次；实际显示尺寸由 CSS 缩放（pixelated，格子不糊）
  {
    const k = Math.max(1, Math.ceil((targetSide(N) * dpr) / N));
    baseCv.width = N * k;
    baseCv.height = N * k;
    const b = baseCv.getContext('2d');
    b.fillStyle = WALL;
    b.fillRect(0, 0, N * k, N * k);
    b.fillStyle = FLOOR;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) if (map.grid[y * N + x]) b.fillRect(x * k, y * k, k, k);
    }
  }

  // 尺寸（随窗口重排）：side = CSS 边长，cell = 每格 CSS 像素（可为小数）
  let side = 0;
  let cell = 1;
  let half = 0.5;
  let rGem = 2.4;
  let rActor = 3.6;
  function layout() {
    const s = sideFor(N, globalThis.innerWidth || 1440, globalThis.innerHeight || 900);
    if (s === side) return;
    side = s;
    cell = side / N;
    half = cell / 2;
    rGem = Math.max(2.4, cell * 0.42);
    rActor = Math.max(3.6, cell * 0.55);
    for (const c of [baseCv, cv]) {
      c.style.width = `${side}px`;
      c.style.height = `${side}px`;
    }
    stack.style.width = `${side}px`;
    stack.style.height = `${side}px`;
    legend.style.maxWidth = `${Math.max(side, 200)}px`;
    cv.width = Math.round(side * dpr);
    cv.height = Math.round(side * dpr);
  }
  layout();
  const onResize = () => layout();
  globalThis.addEventListener?.('resize', onResize);

  const sync = () => {
    body.hidden = !open;
    box.classList.toggle('closed', !open);
    btn.textContent = open ? '收起' : '展开';
    try {
      localStorage.setItem(STORE, open ? '1' : '0');
    } catch {
      /* 隐私模式 */
    }
  };
  sync();

  // 点击 / 拖动：移动镜头
  let dragging = false;
  const look = (e) => {
    const r = cv.getBoundingClientRect();
    const tx = ((e.clientX - r.left) / r.width) * N - 0.5;
    const ty = ((e.clientY - r.top) / r.height) * N - 0.5;
    const [wx, wy] = tileCenter(Math.max(0, Math.min(N - 1, tx)), Math.max(0, Math.min(N - 1, ty)));
    onLook(wx, wy);
  };
  cv.addEventListener('pointerdown', (e) => {
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    look(e);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => { if (dragging) look(e); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  btn.addEventListener('click', () => {
    open = !open;
    sync();
  });

  let lastLegend = '';

  function dot(x, y, r, fill, stroke = INK, w = 1) {
    ctx.beginPath();
    ctx.arc(x * cell + half, y * cell + half, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = w;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  return {
    get open() { return open; },
    get side() { return side; },
    toggle() {
      open = !open;
      sync();
    },
    dispose() {
      globalThis.removeEventListener?.('resize', onResize);
    },
    /**
     * 每帧调用（收起时立即返回）。只重画上层；底层地形画一次。
     * @param {object} sched 调度器
     * @param {object} camera 摄像机（x/y/zoom 为世界坐标）
     * @param {number} viewW CSS 像素
     * @param {number} viewH
     */
    draw(sched, camera, viewW, viewH) {
      if (!open) return;
      const s = sched.state;
      const viewer = sched.playerSeat;
      const god = Boolean(sched.spectating || s.ended);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, side, side);

      // 四个出口（座位色）；自己的出口再加金色描边
      const g = Math.max(1, cell * 0.25);
      map.exits.forEach(([x, y], seat) => {
        ctx.fillStyle = ACTOR_COLORS[seat];
        ctx.fillRect(x * cell - g, y * cell - g, cell + 2 * g, cell + 2 * g);
      });
      const [ex, ey] = map.exits[viewer];
      ctx.lineWidth = 2;
      ctx.strokeStyle = HALO;
      ctx.strokeRect(ex * cell - rActor + half, ey * cell - rActor + half, rActor * 2, rActor * 2);

      for (const gm of s.gems) {
        const cx = gm.x * cell + half;
        const cy = gm.y * cell + half;
        const r = rGem * 1.15;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fillStyle = GEM_COLORS_BASE[gm.c];
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = INK;
        ctx.stroke();
      }
      if (s.chest.present) {
        const k = Math.max(5, cell * 0.8);
        ctx.fillStyle = '#8C5A36';
        ctx.strokeStyle = '#E9D9A8';
        ctx.lineWidth = 1.5;
        ctx.fillRect(s.chest.x * cell + half - k / 2, s.chest.y * cell + half - k / 2, k, k);
        ctx.strokeRect(s.chest.x * cell + half - k / 2, s.chest.y * cell + half - k / 2, k, k);
      }

      let ghosts = 0;
      const views = actorViews(map, s, cfg, { viewer, god });
      views.forEach((v, seat) => {
        if (!v || seat === viewer) return;
        if (v.show === 'ghost') {
          ghosts++;
          ctx.globalAlpha = 0.45;
          dot(v.x, v.y, rActor, ACTOR_COLORS[seat], '#fff', 1);
          ctx.globalAlpha = 1;
        } else {
          dot(v.x, v.y, rActor, ACTOR_COLORS[seat], '#fff', 1.5);
        }
      });
      const me = s.actors[viewer];
      if (me.status === 'active') {
        dot(me.x, me.y, rActor + 2.5, 'rgba(0,0,0,0)', HALO, 2.5);
        dot(me.x, me.y, rActor, ACTOR_COLORS[viewer], '#fff', 1.5);
      }

      // 主画面视口（屏幕矩形 → 世界 → 格；俯视下是菱形）
      const z = camera.zoom;
      const hw = viewW / 2 / z;
      const hh = viewH / 2 / z;
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => worldToTile(camera.x + dx, camera.y + dy));
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, side, side);
      ctx.clip();
      ctx.beginPath();
      corners.forEach(([tx, ty], i) => (i ? ctx.lineTo(tx * cell + half, ty * cell + half) : ctx.moveTo(tx * cell + half, ty * cell + half)));
      ctx.closePath();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 2;
      ctx.stroke();
      ctx.restore();

      // 批次 6：对局一律全公开；旧规则只会在回放旧记录时出现
      const VM = cfg.vision.mode ?? 'radius';
      const rule = VM === 'full' ? '所有对手实时显示 · 他们要去哪得你自己判断' : `旧记录：对手只在视野 ${cfg.vision.entityRadius} 格内实时显示`;
      const lg = god ? '观战：显示全部对手' : `${rule}${ghosts ? ' · 半透明 = 已知的旧位置' : ''}`;
      if (lg !== lastLegend) {
        legend.textContent = lg;
        lastLegend = lg;
      }
    },
  };
}
