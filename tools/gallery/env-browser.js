import { loadAtlas } from '../../src/render/atlas.js';
import { createEnvScene } from '../../src/render/env.js';
import { HALF_W, HALF_H } from '../../src/render/iso.js';
import { MAP_SIZE_IDS, MAP_SIZES } from '../../src/config/map-sizes.js';
import { createCatalog, catalogCsv, CATEGORIES, SCENES, LAYERS } from './env-catalog.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toFixed(1);
const PAGE = 60;
let atlas, catalog, env, selected, instance = 0, page = 0;
let zoom = 1, cx = 0, cy = 0, fitted = true, scheduled = false;
const canvas = $('scene');
const ctx = canvas.getContext('2d');
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const sceneSummary = (a) => a.scenes.length ? a.scenes.map(([s, n]) => `${SCENES[s]} ×${n}`).join('；') : a.count ? '随视口绘制' : '当前规格未摆放';

for (const id of MAP_SIZE_IDS) $('map-size').add(new Option(MAP_SIZES[id].label, id));
const query = new URLSearchParams(location.search);
$('map-size').value = MAP_SIZE_IDS.includes(query.get('size')) ? query.get('size') : 'XS';
for (const c of CATEGORIES) $('category').add(new Option(c, c));

function checker(c, w, h) {
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y += 12) for (let i = 0; i < w; i += 12) {
    x.fillStyle = ((y / 12 + i / 12) & 1) ? '#e4e9de' : '#f1f2e9';
    x.fillRect(i, y, 12, 12);
  }
  return x;
}

function picture(c, a) {
  const x = checker(c, c.width, c.height);
  if (a.kind === 'sprite') {
    const f = a.frame;
    const s = Math.min((c.width - 12) / f.w, (c.height - 12) / f.h);
    atlas.draw(x, a.name, s, (c.width - f.w * s) / 2 + f.ax * s, (c.height - f.h * s) / 2 + f.ay * s);
    return;
  }
  const w = c.width, h = c.height;
  if (a.name === 'EDGE_BAND') {
    x.strokeStyle = '#243d28'; x.lineWidth = 10;
    x.beginPath(); x.moveTo(w * .1, h * .7); x.lineTo(w * .5, h * .25); x.lineTo(w * .9, h * .7); x.stroke();
  } else {
    const color = a.name === 'GIANT_GLOW' ? '255,196,90' : a.name === 'GROUND_plaza' ? '205,196,176' : a.name === 'GROUND_path' ? '176,148,104' : a.name === 'GROUND_meadow' ? '96,140,74' : '8,18,10';
    x.save(); x.translate(w / 2, h / 2); x.scale(1, .55);
    const r = w * .44, g = x.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(${color},.85)`); g.addColorStop(1, `rgba(${color},0)`);
    x.fillStyle = g; x.fillRect(-r, -r, 2 * r, 2 * r); x.restore();
  }
  if (w > 100) { x.font = '20px "Microsoft YaHei"'; x.fillStyle = '#69746b'; x.fillText('程序绘制示意', 18, h - 20); }
}

function renderList() {
  if (!catalog) return;
  const term = $('search').value.trim().toLowerCase();
  const cat = $('category').value;
  const rows = catalog.assets.filter((a) => (!cat || a.category === cat) && `${a.label} ${a.name} ${sceneSummary(a)}`.toLowerCase().includes(term));
  rows.sort((a, b) => $('sort').value === 'count' ? b.count - a.count || a.name.localeCompare(b.name) : CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
  $('result-count').textContent = `${rows.length} / ${catalog.assets.length} 种`;
  $('asset-list').innerHTML = rows.length ? rows.map((a) => `<tr data-name="${escape(a.name)}" class="${a.name === selected?.name ? 'selected' : ''}"><td><canvas class="thumb" width="144" height="136" aria-label="${escape(a.label)}"></canvas></td><td><button class="asset-link" data-asset="${escape(a.name)}">${escape(a.label)}</button><code class="asset-id">${escape(a.name)}</code><small>${escape(a.category)}${a.kind === 'procedure' ? ' · 示意' : ''}</small></td><td class="count">${a.count.toLocaleString()}</td><td class="scene-cell">${escape(sceneSummary(a))}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">没有符合条件的资产。清除搜索或更换分类。</td></tr>';
  for (const tr of $('asset-list').querySelectorAll('tr[data-name]')) picture(tr.querySelector('canvas'), catalog.assets.find((a) => a.name === tr.dataset.name));
}

function select(name, index = 0) {
  selected = catalog.assets.find((a) => a.name === name);
  if (!selected) return;
  instance = Math.max(0, Math.min(index, selected.instances.length - 1));
  page = Math.floor(instance / PAGE);
  $('asset-name').textContent = selected.label;
  $('asset-id').textContent = selected.name;
  $('asset-description').textContent = selected.description || '当前图集中的独立精灵；保持原有美术与比例，不额外描边。';
  const pairs = [
    ['类型', selected.category], ['总数', `${selected.count} 件 / 处`], ['场景', sceneSummary(selected)],
    ['1× 画布', selected.frame ? `${selected.frame.w} × ${selected.frame.h} px` : '无独立图集帧'],
    ['落地点', selected.frame ? `帧内 (${selected.frame.ax}, ${selected.frame.ay})` : '见程序说明'],
    ['可见高度', selected.box ? `${selected.box.t} px（锚点以上）` : '随场景绘制'],
  ];
  $('asset-meta').innerHTML = pairs.map(([k, v]) => `<dt>${k}</dt><dd>${escape(v)}</dd>`).join('');
  picture($('large-sprite'), selected);
  $('focus').disabled = !selected.instances.length;
  renderList(); renderPositions(); scheduleDraw();
}

function renderPositions() {
  const a = selected;
  if (!a) return;
  $('position-count').textContent = a.instances.length ? `${a.instances.length} 个锚点` : a.count ? '无固定世界坐标' : '0 个实例';
  const start = page * PAGE;
  $('positions').innerHTML = a.instances.length ? a.instances.slice(start, start + PAGE).map((p, i) => `<tr class="${start + i === instance ? 'active' : ''}"><td>${start + i + 1}</td><td>${escape(SCENES[p.scene])}<br><small>${escape(LAYERS[p.layer])}</small>${p.rx ? `<br><small>半径 ${fmt(p.rx)} / ${fmt(p.ry)}</small>` : ''}</td><td class="mono">${fmt(p.wx)}<br>${fmt(p.wy)}</td><td class="mono">${fmt(p.gx)}<br>${fmt(p.gy)}</td><td><button class="locate" data-index="${start + i}">定位</button></td></tr>`).join('') : `<tr><td colspan="5" class="empty">${a.count ? '随视口变化，无固定世界坐标。' : '该种资产在当前地图规格没有摆放。'}</td></tr>`;
  const pages = Math.max(1, Math.ceil(a.instances.length / PAGE));
  $('page-info').textContent = `${page + 1} / ${pages} 页`;
  $('prev-page').disabled = page === 0;
  $('next-page').disabled = page >= pages - 1;
}

function fit() {
  if (!catalog) return;
  const { x0, x1, y0, y1 } = catalog.bounds;
  zoom = Math.min((canvas.clientWidth - 40) / (x1 - x0), (canvas.clientHeight - 42) / (y1 - y0));
  cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
  fitted = true; scheduleDraw();
}

function focus(index = instance) {
  const p = selected?.instances[index];
  if (!p) return;
  instance = index; page = Math.floor(instance / PAGE);
  cx = p.wx; cy = p.wy;
  if (selected.box) {
    const b = selected.box;
    cy -= (b.t - b.b) / 2;
    zoom = Math.min(2, (canvas.clientWidth - 100) / Math.max(180, b.r - b.l + 100), (canvas.clientHeight - 70) / Math.max(160, b.t + b.b + 65));
  } else zoom = Math.max(zoom, .6);
  fitted = false; renderPositions(); scheduleDraw();
}

function scheduleDraw() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; draw(); });
}

function draw() {
  if (!env) return;
  const D = dpr(), W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * D) || canvas.height !== Math.round(H * D)) { canvas.width = Math.round(W * D); canvas.height = Math.round(H * D); }
  const ox = W / 2 - cx * zoom, oy = H / 2 - cy * zoom;
  const screen = (wx, wy) => [wx * zoom + ox, wy * zoom + oy];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#29442e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  env.drawBack(ctx, zoom * D, ox * D, oy * D, canvas.width, canvas.height);
  ctx.setTransform(D, 0, 0, D, 0, 0);
  const N = catalog.size;
  const corners = [[0, 0], [N * HALF_W, N * HALF_H], [0, N * 2 * HALF_H], [-N * HALF_W, N * HALF_H]].map(([x, y]) => screen(x, y));
  ctx.beginPath(); corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
  ctx.fillStyle = '#e7e5c8'; ctx.fill(); ctx.strokeStyle = '#94a17f'; ctx.lineWidth = 1; ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  env.drawFront(ctx, zoom * D, ox * D, oy * D, canvas.width, canvas.height);
  ctx.setTransform(D, 0, 0, D, 0, 0);
  ctx.textAlign = 'center'; ctx.font = '12px "Microsoft YaHei"';
  for (const [label, wx, wy] of [['顶角 / 遗迹', 0, -20], ['左上 / 古镇', -N * HALF_W, N * HALF_H], ['右上 / 村落', N * HALF_W, N * HALF_H], ['前沿 / 南角', 0, N * 2 * HALF_H + 32]]) {
    const [x, y] = screen(wx, wy); const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#f6f3ed'; ctx.fillRect(x - tw / 2 - 4, y - 12, tw + 8, 18); ctx.fillStyle = '#283c32'; ctx.fillText(label, x, y + 1);
  }
  if (selected && $('markers').checked) {
    ctx.beginPath();
    for (const p of selected.instances) {
      const [x, y] = screen(p.wx, p.wy);
      if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue;
      ctx.moveTo(x + 3, y); ctx.arc(x, y, 3, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#efab53'; ctx.fill(); ctx.strokeStyle = '#702d19'; ctx.lineWidth = 1; ctx.stroke();
  }
  const p = selected?.instances[instance];
  if (p) {
    const [x, y] = screen(p.wx, p.wy);
    ctx.strokeStyle = '#fff9db'; ctx.lineWidth = 2;
    if (selected.box) {
      const b = selected.box; ctx.strokeRect(x + b.l * zoom - 3, y - b.t * zoom - 3, (b.r - b.l) * zoom + 6, (b.t + b.b) * zoom + 6);
    } else if (p.rx) {
      ctx.beginPath(); ctx.ellipse(x, y, p.rx * zoom, p.ry * zoom, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff9db'; ctx.font = 'bold 12px Consolas'; ctx.fillText(`#${instance + 1}`, x, y - 14);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  $('zoom-value').textContent = `场景倍率 ${zoom.toFixed(2)}×`;
}

function rebuild() {
  const id = $('map-size').value;
  catalog = createCatalog(atlas, MAP_SIZES[id].size);
  env = createEnvScene({ atlas, size: catalog.size });
  const names = catalog.assets.filter((a) => a.kind === 'sprite');
  $('summary').textContent = `${names.length} 种图集资产 / ${catalog.placements.length.toLocaleString()} 件实例 / ${catalog.assets.length - names.length} 种程序布景`;
  $('export-csv').disabled = false;
  const url = new URL(location.href); url.searchParams.set('size', id); history.replaceState(null, '', url);
  select(selected?.name || query.get('asset') || 'ENV_TOWERE_na_00'); fit();
  $('status').textContent = `${MAP_SIZES[id].label}：与当前游戏共用 buildPlan，包含最终裁剪 / 回退后的布景。场外摆放仅取决于地图尺寸，不随对局种子变化。`;
}

$('asset-list').addEventListener('click', (e) => { const row = e.target.closest('tr[data-name]'); if (row) select(row.dataset.name); });
$('positions').addEventListener('click', (e) => { const b = e.target.closest('[data-index]'); if (b) focus(Number(b.dataset.index)); });
for (const id of ['search', 'category', 'sort']) $(id).addEventListener(id === 'search' ? 'input' : 'change', renderList);
$('map-size').addEventListener('change', () => { if (atlas) rebuild(); });
$('fit').addEventListener('click', fit);
$('focus').addEventListener('click', () => focus());
$('markers').addEventListener('change', scheduleDraw);
for (const [id, k] of [['zoom-in', 1.4], ['zoom-out', 1 / 1.4]]) $(id).addEventListener('click', () => { zoom = Math.max(.015, Math.min(4, zoom * k)); fitted = false; scheduleDraw(); });
for (const [id, k] of [['prev-page', -1], ['next-page', 1]]) $(id).addEventListener('click', () => { page += k; renderPositions(); });
$('export-csv').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([catalogCsv(catalog)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `env-assets-${$('map-size').value}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (!catalog) return; canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  cx -= dx / zoom; cy -= dy / zoom; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
  fitted = false; scheduleDraw();
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && drag.moved < 4 && selected && $('markers').checked) {
    const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    let nearest = -1, dist = 15;
    selected.instances.forEach((p, i) => { const d = Math.hypot((p.wx - cx) * zoom + canvas.clientWidth / 2 - x, (p.wy - cy) * zoom + canvas.clientHeight / 2 - y); if (d < dist) { nearest = i; dist = d; } });
    if (nearest >= 0) { instance = nearest; page = Math.floor(instance / PAGE); renderPositions(); scheduleDraw(); }
  }
  drag = null;
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  if (!catalog) return;
  e.preventDefault(); const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left - canvas.clientWidth / 2, y = e.clientY - r.top - canvas.clientHeight / 2;
  const z = Math.max(.015, Math.min(4, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
  cx += x / zoom - x / z; cy += y / zoom - y / z; zoom = z; fitted = false; scheduleDraw();
}, { passive: false });
new ResizeObserver(() => fitted ? fit() : scheduleDraw()).observe(canvas);

try {
  atlas = await loadAtlas({ name: 'env', onHi: () => { env?.setAtlas(atlas); if (selected) select(selected.name, instance); scheduleDraw(); } });
  rebuild();
} catch (e) {
  $('status').textContent = `加载失败：${e.message}。请确认游戏服务器与 assets/atlas/env 文件可用后刷新。`;
  $('summary').textContent = '资产未加载';
}
