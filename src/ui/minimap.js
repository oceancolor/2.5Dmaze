// 小地图（右上，半透明，正交俯视、正方形）。Tab 或标题栏按钮收起 / 展开，状态记在 localStorage。
//
// 信息与主画面同源（scene.actorViews）：地形、宝石、宝箱全公开；对手只在视野内画真身，视野外画「最后目击」幽灵 +
// 已过回合数；结算 / 观战后（god）全部真身。小地图不会比主画面多透露任何东西。
//
// 可观测性：每格至少 2 CSS 像素（128 → 256 px），小图按比例放大（16 → 17 px/格），格子不合并、不丢墙；
// 宝石 / 宝箱 / 角色的标记有最小半径，128 图上也能看清。白框 = 主画面当前视口（等距视口在俯视下是菱形）。
// 点击 / 拖动小地图 = 把镜头移过去（全图档时先切回最近档）。

import { ACTOR_COLORS, GEM_COLORS_BASE, HALO, INK } from '../render/palette.js';
import { actorViews } from '../render/scene.js';
import { worldToTile, tileCenter } from '../render/iso.js';

const STORE = 'maze.minimap';
const WALL = '#4A3F33';
const FLOOR = '#EFE7DA';
const TARGET = 272;

/** 每格 CSS 像素：总边长约 256–288，且不小于 2。 */
export const cellFor = (N) => Math.max(2, Math.round(TARGET / N));

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
  const cell = cellFor(N);
  const side = N * cell;
  let open = loadOpen();

  const box = document.createElement('div');
  box.className = 'minimap';
  box.innerHTML = `<div class="mm-head"><span>小地图 <small>${N}×${N}</small></span><span class="sp"></span>
    <button class="btn mini" data-mm="toggle" title="收起 / 展开（Tab）"></button></div>
    <div class="mm-body"><canvas></canvas><div class="mm-legend k"></div></div>`;
  host.append(box);
  const cv = box.querySelector('canvas');
  const body = box.querySelector('.mm-body');
  const btn = box.querySelector('[data-mm="toggle"]');
  const legend = box.querySelector('.mm-legend');
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  cv.width = Math.round(side * dpr);
  cv.height = Math.round(side * dpr);
  cv.style.width = `${side}px`;
  cv.style.height = `${side}px`;
  const ctx = cv.getContext('2d');

  // 静态层：地形 + 四个出口（一次）
  const base = document.createElement('canvas');
  base.width = cv.width;
  base.height = cv.height;
  {
    const b = base.getContext('2d');
    b.scale(dpr, dpr);
    b.fillStyle = WALL;
    b.fillRect(0, 0, side, side);
    b.fillStyle = FLOOR;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) if (map.grid[y * N + x]) b.fillRect(x * cell, y * cell, cell, cell);
    }
    map.exits.forEach(([x, y], seat) => {
      b.fillStyle = ACTOR_COLORS[seat];
      const g = Math.max(1, Math.round(cell * 0.25));
      b.fillRect(x * cell - g, y * cell - g, cell + 2 * g, cell + 2 * g);
    });
  }

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

  const half = Math.max(1, cell / 2);
  const rGem = Math.max(2.4, cell * 0.42);
  const rActor = Math.max(3.6, cell * 0.55);
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
    toggle() {
      open = !open;
      sync();
    },
    /**
     * 每帧调用（收起时立即返回）。
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
      ctx.drawImage(base, 0, 0, side, side);

      // 自己的出口：金色描边
      const [ex, ey] = map.exits[viewer];
      ctx.lineWidth = 2;
      ctx.strokeStyle = HALO;
      ctx.strokeRect(ex * cell - rActor + half, ey * cell - rActor + half, rActor * 2, rActor * 2);

      for (const g of s.gems) {
        const cx = g.x * cell + half;
        const cy = g.y * cell + half;
        const r = rGem * 1.15;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fillStyle = GEM_COLORS_BASE[g.c];
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
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.restore();

      const lg = god ? '观战：显示全部对手' : `对手只在视野 ${cfg.vision.entityRadius} 格内实时显示${ghosts ? ' · 半透明 = 最后目击位置' : ''}`;
      if (lg !== lastLegend) {
        legend.textContent = lg;
        lastLegend = lg;
      }
    },
  };
}
