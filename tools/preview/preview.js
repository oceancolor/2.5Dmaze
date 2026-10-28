// 阶段 1 内核预览：俯视调试视图，四座位兜底启发式 AI 实时对打。
// 只读调用 src/ 内核；本文件属于工具层，不进确定性 lint 范围（可以用 rAF / 时钟）。

import { makeConfig } from '../../src/config/default.config.js';
import { createMatch } from '../../src/core/state.js';
import { step } from '../../src/core/game.js';
import { observe } from '../../src/core/observe.js';
import { stateHash, configHash } from '../../src/core/hash.js';
import { rankActors, scoreOf, setsOf, gemTotal } from '../../src/core/scoring.js';
import { fieldFrom } from '../../src/core/nav/bfs.js';
import { DX, DY } from '../../src/core/geom.js';
import { freshSeed } from '../../src/core/rng.js';
import { createHeuristic } from '../../src/ai/heuristic.js';
import { createRecorder } from '../../src/record/recorder.js';
import { replay } from '../../src/record/replayer.js';

const cfg = makeConfig();
const N = cfg.maze.size;
const R = cfg.vision.entityRadius;
const H10 = cfg.ai.homeFactorX10;

const SEAT_COLOR = ['#FF3B6B', '#6A4BE0', '#10B8A0', '#F7B32B'];
const SEAT_NAME = ['玩家座位（AI 代打）', 'AI-A', 'AI-B', 'AI-C'];
const GEM_COLOR = ['#E8384F', '#F2CE3B', '#3FBF6A', '#4A6FE3', '#932C9B'];
const GEM_NAME = ['红', '黄', '绿', '蓝', '紫'];
const FLOOR = [233, 225, 214];
const WALL = [159, 147, 130];
const SPEEDS = [
  { label: '1×', tps: 5 },
  { label: '2×', tps: 10 },
  { label: '4×', tps: 20 },
  { label: '16×', tps: 80 },
  { label: '极速', tps: 1200 },
];

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const mapLayer = document.createElement('canvas');
mapLayer.width = N;
mapLayer.height = N;

let CELL = 6;
let G = null;
let playing = false;
let speed = 1;
let sel = 0;
let acc = 0;
let lastTs = 0;
let panelTurn = -1;

// ---------- 对局 ----------

function parseSeed(v) {
  const t = String(v ?? '').trim();
  if (!t) return 42;
  return /^\d+$/.test(t) ? Number(t) : t;
}

function newMatch(seedInput) {
  const seed = parseSeed(seedInput);
  const match = createMatch(seed, cfg);
  const { map } = match;
  G = {
    seedInput: seed,
    match,
    map,
    state: match.state,
    prev: match.state,
    ctrls: [0, 1, 2, 3].map((i) => createHeuristic(map, i, cfg, match.seed)),
    decisions: [null, null, null, null],
    rec: createRecorder(match, cfg),
    hash: stateHash(match.state),
    cfgHash: configHash(cfg),
    log: [],
    trails: match.state.actors.map((a) => [[a.x, a.y]]),
    blocked: 0,
    exitField: map.exits.map(([x, y]) => fieldFrom(map, y * N + x)),
  };
  $('seed').value = String(seed);
  history.replaceState(null, '', `?seed=${encodeURIComponent(String(seed))}`);
  $('endcard').hidden = true;
  playing = false;
  acc = 0;
  panelTurn = -1;
  bakeMap();
  addLog(0, null, `新局 · 种子 ${seed} · 地图第 ${match.attempts} 次生成通过校验`);
  updatePanel(true);
}

function advance() {
  const s = G.state;
  if (s.ended) return;
  const intents = ['STAY', 'STAY', 'STAY', 'STAY'];
  const dec = [null, null, null, null];
  for (let i = 0; i < 4; i++) {
    if (s.actors[i].status !== 'active') continue;
    dec[i] = G.ctrls[i].decide(observe(G.map, s, i, cfg, { patch: false }));
    intents[i] = dec[i].dir;
  }
  const r = step(G.map, s, intents, cfg);
  G.hash = stateHash(r.state);
  G.rec.turn(s.turn, intents, s.actors, G.hash);
  G.prev = s;
  G.state = r.state;
  G.decisions = dec;
  r.state.actors.forEach((a, i) => {
    if (a.status !== 'active' && s.actors[i].status !== 'active') return;
    const tr = G.trails[i];
    const [lx, ly] = tr[tr.length - 1];
    if (lx !== a.x || ly !== a.y) tr.push([a.x, a.y]);
    if (tr.length > 160) tr.shift();
  });
  for (const e of r.events) logEvent(s.turn, e);
  if (r.state.ended) {
    G.rec.end(r.state);
    playing = false;
    syncPlayBtn();
    showEnd();
  }
}

function runToEnd() {
  let guard = 0;
  while (!G.state.ended && guard++ < 5000) advance();
  updatePanel(true);
}

// ---------- 事件日志 ----------

function addLog(turn, seat, text) {
  G.log.unshift({ turn, seat, text });
  if (G.log.length > 300) G.log.pop();
}

function logEvent(turn, e) {
  switch (e.type) {
    case 'pickup': addLog(turn, e.seat, `拾取 <b style="color:${GEM_COLOR[e.color]}">${GEM_NAME[e.color]}</b> 宝石`); break;
    case 'chest': addLog(turn, e.seat, e.kind === 'score' ? `开宝箱：+${e.value} 分` : `开宝箱：+${e.gained} 体力（掷出 ${e.value}）`); break;
    case 'gemRespawn': addLog(turn, null, `第 ${e.generation} 代宝石重生（间距放宽到 ${e.sep}）`); break;
    case 'chestRespawn': addLog(turn, null, '宝箱重生'); break;
    case 'escaped': addLog(turn, e.seat, '<b>到达出口 ✓</b>'); break;
    case 'failed': addLog(turn, e.seat, `出局：${e.reason === 'stamina' ? '体力耗尽' : '回合上限'}`); break;
    case 'gemRespawnDeferred': addLog(turn, null, '宝石重生顺延（附近有人）'); break;
    case 'end': addLog(turn, null, `对局结束 · 第 ${e.turn} 回合`); break;
    case 'blocked': G.blocked++; break;
    default: break;
  }
}

// ---------- 绘制 ----------

function bakeMap() {
  const m = mapLayer.getContext('2d');
  const img = m.createImageData(N, N);
  const g = G.map.grid;
  for (let i = 0; i < N * N; i++) {
    const c = g[i] ? FLOOR : WALL;
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  const tint = (x, y, hex, a) => {
    const i = (y * N + x) * 4;
    const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * (1 - a) + rgb[k] * a);
  };
  G.map.spawns.forEach(([sx, sy], i) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tint(sx + dx, sy + dy, SEAT_COLOR[i], 0.28);
  });
  G.map.exits.forEach(([ex, ey], i) => tint(ex, ey, SEAT_COLOR[i], 1));
  m.putImageData(img, 0, 0);
}

function fitCanvas() {
  const avail = Math.min(window.innerHeight - 32, window.innerWidth - 460);
  CELL = Math.max(4, Math.min(9, Math.floor(avail / N)));
  const px = CELL * N;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const cx = (x) => (x + 0.5) * CELL;
const cy = (y) => (y + 0.5) * CELL;

function gemPath(c, x, y, r) {
  ctx.beginPath();
  if (c === 0) { // 竖长菱形
    ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 0.74, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 0.74, y);
  } else if (c === 1) { // 六角星
    for (let k = 0; k < 12; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 6;
      const rr = k % 2 ? r * 0.55 : r * 1.15;
      k ? ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)) : ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
  } else if (c === 2) { // 切角正方
    const s = r * 0.95;
    const k = s * 0.42;
    ctx.moveTo(x - s + k, y - s); ctx.lineTo(x + s - k, y - s); ctx.lineTo(x + s, y - s + k); ctx.lineTo(x + s, y + s - k);
    ctx.lineTo(x + s - k, y + s); ctx.lineTo(x - s + k, y + s); ctx.lineTo(x - s, y + s - k); ctx.lineTo(x - s, y - s + k);
  } else if (c === 3) { // 圆钻
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else { // 扁六边板
    const w = r * 1.2;
    const h = r * 0.75;
    ctx.moveTo(x - w, y); ctx.lineTo(x - w / 2, y - h); ctx.lineTo(x + w / 2, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x - w / 2, y + h);
  }
  ctx.closePath();
}

function drawGem(c, x, y, r) {
  gemPath(c, x, y, r);
  ctx.fillStyle = GEM_COLOR[c];
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.stroke();
  gemPath(c, x, y, r + 1);
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(46,42,36,.55)';
  ctx.stroke();
}

function drawChest(x, y, r) {
  ctx.fillStyle = '#8A5A2B';
  ctx.strokeStyle = '#3B2A17';
  ctx.lineWidth = 1;
  ctx.fillRect(x - r, y - r * 0.8, r * 2, r * 1.6);
  ctx.strokeRect(x - r, y - r * 0.8, r * 2, r * 1.6);
  ctx.fillStyle = '#FFD84D';
  ctx.fillRect(x - r, y - r * 0.15, r * 2, r * 0.3);
  ctx.fillRect(x - r * 0.2, y - r * 0.35, r * 0.4, r * 0.7);
}

/** 沿目标距离场下降得到的路线（只用于显示）。 */
function pathTo(sx, sy, t) {
  const f = fieldFrom(G.map, t.y * N + t.x);
  const pts = [[sx, sy]];
  let x = sx;
  let y = sy;
  for (let k = 0; k < 400; k++) {
    const d = f[y * N + x];
    if (d <= 0) break;
    let moved = false;
    for (let dir = 0; dir < 4; dir++) {
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (f[ny * N + nx] === d - 1) { x = nx; y = ny; moved = true; break; }
    }
    if (!moved) break;
    pts.push([x, y]);
  }
  return pts;
}

function polyline(pts) {
  ctx.beginPath();
  pts.forEach(([x, y], k) => (k ? ctx.lineTo(cx(x), cy(y)) : ctx.moveTo(cx(x), cy(y))));
  ctx.stroke();
}

function draw(t) {
  const px = CELL * N;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mapLayer, 0, 0, px, px);
  const s = G.state;
  const ease = t < 1 ? t * t * (3 - 2 * t) : 1;

  // 出口标记
  G.map.exits.forEach(([ex, ey], i) => {
    ctx.strokeStyle = SEAT_COLOR[i];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx(ex), cy(ey), CELL * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  });

  // 选中座位的视野（切比雪夫 R）
  const me = s.actors[sel];
  if ($('optVision').checked && me.status === 'active') {
    const p = lerpPos(sel, ease);
    const x0 = (p[0] - R) * CELL;
    const y0 = (p[1] - R) * CELL;
    const w = (2 * R + 1) * CELL;
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(x0, y0, w, w);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = SEAT_COLOR[sel];
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, w, w);
    ctx.setLineDash([]);
  }

  // 轨迹
  if ($('optTrail').checked) {
    G.trails.forEach((tr, i) => {
      if (tr.length < 2) return;
      ctx.strokeStyle = SEAT_COLOR[i];
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(1.5, CELL * 0.35);
      ctx.lineJoin = 'round';
      polyline(tr);
      ctx.globalAlpha = 1;
    });
  }

  // 当前路线
  if ($('optPath').checked) {
    s.actors.forEach((a, i) => {
      const d = G.decisions[i];
      if (a.status !== 'active' || !d || !d.target) return;
      ctx.strokeStyle = SEAT_COLOR[i];
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      polyline(pathTo(a.x, a.y, d.target));
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    });
  }

  // 宝物
  const gr = Math.max(3, CELL * 0.95);
  for (const gm of s.gems) drawGem(gm.c, cx(gm.x), cy(gm.y), gr);
  if (s.chest.present) drawChest(cx(s.chest.x), cy(s.chest.y), gr);

  // 角色
  s.actors.forEach((a, i) => {
    const was = G.prev.actors[i];
    if (a.status !== 'active' && was.status !== 'active') return;
    const [x, y] = lerpPos(i, ease);
    const r = Math.max(4, CELL * 1.25);
    if (i === 0) {
      ctx.fillStyle = 'rgba(255,216,77,.55)';
      ctx.beginPath();
      ctx.arc(cx(x), cy(y), r + 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = a.status === 'failed' ? 0.4 : 1;
    ctx.fillStyle = SEAT_COLOR[i];
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx(x), cy(y), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(r * 1.2)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i), cx(x), cy(y) + 0.5);
    ctx.globalAlpha = 1;
    if (a.blockedStreak >= 2 && a.status === 'active') {
      ctx.fillStyle = '#2E2A24';
      ctx.font = `700 ${Math.round(r)}px system-ui`;
      ctx.fillText('!', cx(x) + r, cy(y) - r);
    }
  });
}

function lerpPos(i, t) {
  const a = G.state.actors[i];
  const b = G.prev.actors[i];
  if (t >= 1 || !b) return [a.x, a.y];
  return [b.x + (a.x - b.x) * t, b.y + (a.y - b.y) * t];
}

// ---------- 面板 ----------

function staminaClass(s, d) {
  if (s < d) return 'bad';
  if (s * 10 < d * H10) return 'warn';
  return 'ok';
}

function gemIcon(c, size = 12) {
  const shapes = [
    `<polygon points="6,0 10,6 6,12 2,6"/>`,
    `<polygon points="6,0 7.4,3.6 11.2,3 8.6,6 11.2,9 7.4,8.4 6,12 4.6,8.4 0.8,9 3.4,6 0.8,3 4.6,3.6"/>`,
    `<polygon points="3.5,1 8.5,1 11,3.5 11,8.5 8.5,11 3.5,11 1,8.5 1,3.5"/>`,
    `<circle cx="6" cy="6" r="5"/>`,
    `<polygon points="0.5,6 3.3,2.5 8.7,2.5 11.5,6 8.7,9.5 3.3,9.5"/>`,
  ];
  return `<svg width="${size}" height="${size}" viewBox="0 0 12 12" fill="${GEM_COLOR[c]}" stroke="rgba(46,42,36,.5)" stroke-width=".7">${shapes[c]}</svg>`;
}

function targetText(d) {
  if (!d) return '—';
  const t = d.target;
  if (d.mode === 'home') return `回家 → 出口 (${t.x},${t.y})`;
  if (t.type === 'chest') return `收集 → 宝箱 (${t.x},${t.y})`;
  const gm = G.state.gems.find((g) => g.x === t.x && g.y === t.y) ?? G.prev.gems.find((g) => g.x === t.x && g.y === t.y);
  return gm ? `收集 → ${GEM_NAME[gm.c]}宝石 (${t.x},${t.y})` : `收集 → (${t.x},${t.y})`;
}

function updatePanel(force = false) {
  const s = G.state;
  if (!force && s.turn === panelTurn && !s.ended) return;
  panelTurn = s.turn;
  const m = G.match;
  const turnShown = s.ended ? s.endTurn : s.turn - 1;
  const chestTxt = s.chest.present
    ? `在场 (${s.chest.x},${s.chest.y})`
    : s.chest.respawnsLeft > 0 ? `第 ${s.chest.openedTurn + cfg.treasure.chest.respawnTurns} 回合起重生` : '已用完';
  $('info').innerHTML = `
    <div class="row" style="justify-content:space-between;margin:0">
      <span>回合 <span class="big">${turnShown}</span> <span class="kv">/ ${cfg.rules.maxTurns}</span></span>
      <span class="kv">宝石第 <b>${s.gemGeneration}</b> / ${1 + cfg.treasure.gemRespawnMax} 代 · 场上 <b>${s.gems.length}</b> 颗</span>
    </div>
    <div class="kv">宝箱：${chestTxt} · 本局受阻 ${G.blocked} 次</div>
    <div class="kv">地图：墙密度 ${(m.map.density * 100).toFixed(1)}% · 出生→出口 ${Array.from(m.map.spawnExit).join(' / ')} 步 · 第 ${m.attempts} 次生成</div>
    <div class="mono">seed ${m.seed} · config ${G.cfgHash} · map ${m.map.hash} · state ${G.hash}</div>`;

  $('seats').innerHTML = s.actors.map((a, i) => {
    const d = a.status === 'active' ? G.exitField[i][a.y * N + a.x] : 0;
    const cls = staminaClass(a.stamina, d);
    const pct = (v) => Math.min(100, (100 * v) / a.staminaMax);
    const chip = a.status === 'escaped'
      ? `<span class="chip escaped">第 ${a.escapedTurn} 回合到达</span>`
      : a.status === 'failed'
        ? `<span class="chip failed">${a.failReason === 'stamina' ? '体力耗尽' : '回合上限'}</span>`
        : `<span class="chip">${G.decisions[i]?.mode === 'home' ? '回家中' : '收集中'}</span>`;
    const gems = a.gems.map((n, c) => `<span class="g ${n ? '' : 'zero'}">${gemIcon(c)}${n}</span>`).join('');
    const bar = a.status === 'active'
      ? `<div class="bar"><div class="fill ${cls}" style="width:${pct(a.stamina)}%"></div>
           <div class="mk" style="left:${pct(d)}%" title="回家所需"></div>
           <div class="mk mk2" style="left:${pct((d * H10) / 10)}%" title="终盘线 1.3×"></div></div>`
      : '';
    const line = a.status === 'active'
      ? `<div class="kv">体力 <b>${a.stamina}</b>/${a.staminaMax} · 回家 <b>${d}</b> 步 · 移动 ${a.moves}${a.blockedStreak ? ` · <b>受阻 ${a.blockedStreak}</b>` : ''}</div>
         <div class="mode kv">${targetText(G.decisions[i])}</div>`
      : `<div class="kv">剩余体力 <b>${a.stamina}</b> · 移动 ${a.moves}</div>`;
    return `<div class="seat ${i === sel ? 'sel' : ''}" style="--c:${SEAT_COLOR[i]}" data-seat="${i}">
      <div class="seat-h"><span class="dot"></span><b>#${i} ${SEAT_NAME[i]}</b>${chip}</div>
      ${bar}${line}
      <div class="gems">${gems}<span class="sets">成套 ×${setsOf(a.gems)} · ${scoreOf(a, cfg)} 分</span></div>
    </div>`;
  }).join('');

  $('log').innerHTML = G.log.slice(0, 120).map((e) => `<li><span class="t">${e.turn ? `T${e.turn}` : ''}</span>${
    e.seat === null ? '' : `<span class="dot" style="--c:${SEAT_COLOR[e.seat]}"></span><b>#${e.seat}</b>`
  }<span>${e.text}</span></li>`).join('');
}

function showEnd() {
  const s = G.state;
  const rows = rankActors(s.actors, cfg);
  const T = cfg.treasure;
  const card = $('endcard');
  card.innerHTML = `<h3>对局结束 · 第 ${s.endTurn} 回合</h3>
    <table>
      <tr><th>名次</th><th>座位</th><th>状态</th><th>分数</th><th>构成</th><th>剩余体力</th></tr>
      ${rows.map((r) => {
        const a = s.actors[r.seat];
        const gt = gemTotal(a.gems) * T.gemScore;
        const sb = T.setBonus * setsOf(a.gems);
        return `<tr><td>${r.place}${r.champion ? ' 🏆' : ''}</td>
          <td><span class="dot" style="--c:${SEAT_COLOR[r.seat]}"></span> #${r.seat}</td>
          <td>${r.status === 'escaped' ? `到达 (T${a.escapedTurn})` : r.status === 'failed' ? '出局' : r.status}</td>
          <td><b>${r.score}</b></td>
          <td class="kv">宝石 ${gt} + 成套 ${sb} + 宝箱 ${a.chestScore}</td>
          <td>${r.stamina}</td></tr>`;
      }).join('')}
    </table>
    <div class="row" style="margin-top:10px">
      <button id="btnVerify">校验严格回放</button>
      <button id="btnDownload">下载记录 JSONL</button>
      <button id="btnAgain" class="primary">再来一局</button>
    </div>
    <div id="verify" class="kv"></div>`;
  card.hidden = false;
  $('btnVerify').onclick = () => {
    const t0 = performance.now();
    try {
      const r = replay(G.rec.toJSONL(), cfg);
      $('verify').innerHTML = `✓ 只读记录重放 ${r.turns} 回合，逐回合状态哈希全部一致（${(performance.now() - t0).toFixed(0)} ms）`;
    } catch (e) {
      $('verify').innerHTML = `<span style="color:var(--bad)">✗ ${e.message}</span>`;
    }
  };
  $('btnDownload').onclick = () => {
    const blob = new Blob([G.rec.toJSONL()], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `maze-${G.match.seed}.jsonl`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('btnAgain').onclick = () => { newMatch(freshSeed() % 100000); };
  updatePanel(true);
}

// ---------- 控制 ----------

function syncPlayBtn() {
  $('btnPlay').textContent = playing ? '❚❚ 暂停' : '▶ 播放';
}

function togglePlay() {
  if (G.state.ended) return;
  playing = !playing;
  acc = 0;
  syncPlayBtn();
}

function buildSpeeds() {
  $('speeds').innerHTML = SPEEDS.map((sp, k) => `<button data-k="${k}" class="${k === speed ? 'on' : ''}">${sp.label}</button>`).join('');
  $('speeds').onclick = (ev) => {
    const k = ev.target.dataset.k;
    if (k === undefined) return;
    speed = Number(k);
    buildSpeeds();
  };
}

function buildLegend() {
  const gems = GEM_NAME.map((n, c) => `<span>${gemIcon(c)}${n}</span>`).join('');
  $('legend').innerHTML = `${gems}
    <span><svg width="12" height="12"><rect x="1" y="2" width="10" height="8" fill="#8A5A2B" stroke="#3B2A17"/><rect x="1" y="5" width="10" height="2" fill="#FFD84D"/></svg>宝箱</span>
    <span><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#6A4BE0" stroke-width="2"/></svg>出口（座位色）</span>
    <span>! 连续受阻</span>`;
}

$('btnNew').onclick = () => newMatch($('seed').value);
$('btnRand').onclick = () => newMatch(freshSeed() % 100000);
$('btnPlay').onclick = togglePlay;
$('btnStep').onclick = () => { playing = false; syncPlayBtn(); advance(); updatePanel(true); };
$('btnEnd').onclick = () => { playing = false; syncPlayBtn(); runToEnd(); };
$('seed').onkeydown = (e) => { if (e.key === 'Enter') newMatch($('seed').value); };
$('seats').onclick = (e) => {
  const el = e.target.closest('.seat');
  if (!el) return;
  sel = Number(el.dataset.seat);
  updatePanel(true);
};

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); $('btnStep').click(); }
  else if (e.key === 'n' || e.key === 'N') newMatch(freshSeed() % 100000);
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / CELL);
  const y = Math.floor((e.clientY - rect.top) / CELL);
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const s = G.state;
  const bits = [`(${x}, ${y})`, G.map.grid[y * N + x] ? '地板' : '墙'];
  const gm = s.gems.find((g) => g.x === x && g.y === y);
  if (gm) bits.push(`${GEM_NAME[gm.c]}宝石`);
  if (s.chest.present && s.chest.x === x && s.chest.y === y) bits.push('宝箱');
  const ex = G.map.exits.findIndex(([a, b]) => a === x && b === y);
  if (ex >= 0) bits.push(`#${ex} 的出口`);
  s.actors.forEach((a, i) => { if (a.status === 'active' && a.x === x && a.y === y) bits.push(`#${i}`); });
  $('hover').textContent = bits.join(' · ');
  $('hover').hidden = false;
});
canvas.addEventListener('mouseleave', () => { $('hover').hidden = true; });
window.addEventListener('resize', fitCanvas);

function frame(ts) {
  const dt = lastTs ? Math.min(ts - lastTs, 100) : 0;
  lastTs = ts;
  const interval = 1000 / SPEEDS[speed].tps;
  if (playing && !G.state.ended) {
    acc += dt;
    let n = 0;
    while (acc >= interval && !G.state.ended && n < 400) { advance(); acc -= interval; n++; }
  }
  const t = playing && SPEEDS[speed].tps <= 20 ? Math.min(acc / interval, 1) : 1;
  draw(t);
  updatePanel();
  requestAnimationFrame(frame);
}

buildSpeeds();
buildLegend();
fitCanvas();
newMatch(new URLSearchParams(location.search).get('seed') ?? 42);
requestAnimationFrame(frame);
