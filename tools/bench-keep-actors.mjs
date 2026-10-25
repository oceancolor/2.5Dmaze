// tools/bench-keep-actors.mjs —— keep 阈值下按 actor 拆分的 spawn→exit 分布（诊断四角色不对称）
// thinKeep 阈值 × spawn→exit 分布 × [68,108] 通过率 / 重掷率
// 回答：81.4/max111 与 82.37/max126 的差异是否来自 keep，以及 [68,108] 在哪一边校准
const N = 128, SIZE = N * N;
const idx = (x, y) => y * N + x;
const cxm = (c) => c % N, cym = (c) => (c / N) | 0;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const D2 = [[0, -2], [0, 2], [-2, 0], [2, 0]];

function genOdd(rnd, keep) {
  const floor = new Uint8Array(SIZE); const list = [idx(1, 1)]; floor[list[0]] = 1; const dirs = D2.slice();
  while (list.length) {
    const r = rnd(); const i = r < 0.55 ? list.length - 1 : (r < 0.90 ? (rnd() * list.length) | 0 : 0);
    const cur = list[i], cx = cur % N, cy = (cur / N) | 0;
    for (let d = 3; d > 0; d--) { const j = (rnd() * (d + 1)) | 0; const t = dirs[d]; dirs[d] = dirs[j]; dirs[j] = t; }
    let ok = false;
    for (const [dx, dy] of dirs) { const nx = cx + dx, ny = cy + dy; if (nx < 1 || ny < 1 || nx > N - 2 || ny > N - 2) continue; if (floor[idx(nx, ny)]) continue; floor[idx(cx + dx / 2, cy + dy / 2)] = 1; floor[idx(nx, ny)] = 1; list.push(idx(nx, ny)); ok = true; break; }
    if (!ok) { list[i] = list[list.length - 1]; list.pop(); }
  }
  for (let r = 0; r < 4; r++) { const w = 5 + ((rnd() * 8) | 0), h = 5 + ((rnd() * 8) | 0); const x0 = 2 + ((rnd() * (N - w - 4)) | 0), y0 = 2 + ((rnd() * (N - h - 4)) | 0); for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) floor[idx(x, y)] = 1; }
  for (let i = 0; i < SIZE; i++) if (!floor[i] && rnd() > keep) floor[i] = 1;
  for (let x = 0; x < N; x++) { floor[idx(x, 0)] = 0; floor[idx(x, N - 1)] = 0; }
  for (let y = 0; y < N; y++) { floor[idx(0, y)] = 0; floor[idx(N - 1, y)] = 0; }
  return floor;
}
function carve(floor, cx, cy, r) { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x <= N - 1 && y <= N - 1) floor[idx(x, y)] = 1; }
function bfs(floor, src, out, q) { out.fill(-1); let h = 0, t = 0; q[t++] = src; out[src] = 0; while (h < t) { const c = q[h++], x = c % N, y = (c / N) | 0, d = out[c]; if (x + 1 < N && floor[c + 1] && out[c + 1] < 0) { out[c + 1] = d + 1; q[t++] = c + 1; } if (x - 1 >= 0 && floor[c - 1] && out[c - 1] < 0) { out[c - 1] = d + 1; q[t++] = c - 1; } if (y + 1 < N && floor[c + N] && out[c + N] < 0) { out[c + N] = d + 1; q[t++] = c + N; } if (y - 1 >= 0 && floor[c - N] && out[c - N] < 0) { out[c - N] = d + 1; q[t++] = c - N; } } }

const SP = [[2, 2], [125, 2], [125, 125], [2, 125]];
const EXIT = [[63, 0], [127, 63], [63, 127], [0, 63]];
const DOOR = [[63, 1], [126, 63], [63, 126], [1, 63]];
const qbuf = new Int32Array(SIZE), dist = new Int32Array(SIZE);
const perI=[[],[],[],[]];
const SEEDS = Number(process.env.SEEDS || 1000);
const LO = Number(process.env.LO || 68), HI = Number(process.env.HI || 108);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

console.log(`阈值扫描：${SEEDS} 种子/档 · 四条 spawn→exit 全测 · 通过区间 [${LO},${HI}]`);
console.log('keep | 墙密度 | 平均 | P50 | P90 | P95 | P99 | max | 单条出区间% | **整图通过%** | 重掷率% | 20连败%');
for (const keep of [Number(process.env.K1 || 0.76)]) {
  let dens = 0, nseed = 0, okMaps = 0;
  const all = []; let outOne = 0, totOne = 0, unreach = 0;  
  for (let s = 1; s <= SEEDS; s++) {
    const rnd = mulberry32(s * 2654435761); const floor = genOdd(rnd, keep);
    let w = 0; for (let i = 0; i < SIZE; i++) if (!floor[i]) w++;
    dens += w / SIZE; nseed++;
    for (const [x, y] of SP) carve(floor, x, y, 1);
    DOOR.forEach(([x, y]) => carve(floor, x, y, 1));
    let ok = true;
    for (let i = 0; i < 4; i++) {
      bfs(floor, idx(SP[i][0], SP[i][1]), dist, qbuf);
      const d = dist[idx(EXIT[i][0], EXIT[i][1])];
      if (d < 0) { unreach++; ok = false; continue; }
      all.push(d); totOne++; perI[i].push(d);
      if (d < LO || d > HI) { outOne++; ok = false; }
    }
    if (ok) okMaps++;
  }
  all.sort((a, b) => a - b);
  const pass = okMaps / nseed, rej = 1 - pass;
  const fail20 = Math.pow(rej, 20) * 100;
  console.log(`${keep.toFixed(2)} | ${(dens / nseed).toFixed(4)} | ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)} | ${pct(all, 0.5)} | ${pct(all, 0.9)} | ${pct(all, 0.95)} | ${pct(all, 0.99)} | ${all[all.length - 1]} | ${(outOne / totOne * 100).toFixed(1)}% | **${(pass * 100).toFixed(1)}%** | ${(rej * 100).toFixed(1)}% | ${fail20.toFixed(3)}% | 不可达 ${unreach}`);
}
perI.forEach((a,i)=>{a.sort((x,y)=>x-y);const mh=Math.abs(SP[i][0]-EXIT[i][0])+Math.abs(SP[i][1]-EXIT[i][1]);console.log(`  actor${i} (${SP[i]})->(${EXIT[i]}) 曼哈顿${mh} 平均${(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1)} P95 ${pct(a,0.95)} max ${a[a.length-1]} 出区间${(a.filter(v=>v<68||v>108).length/a.length*100).toFixed(1)}%`);});
console.log('\n对照：旧区间 [85,100] 在 keep=0.72 下的通过率');
{
  let okMaps = 0, nseed = 0, outOne = 0, totOne = 0; const all = [];
  for (let s = 1; s <= SEEDS; s++) {
    const rnd = mulberry32(s * 2654435761); const floor = genOdd(rnd, 0.72);
    for (const [x, y] of SP) carve(floor, x, y, 1);
    DOOR.forEach(([x, y]) => carve(floor, x, y, 1));
    let ok = true; nseed++;
    for (let i = 0; i < 4; i++) {
      bfs(floor, idx(SP[i][0], SP[i][1]), dist, qbuf);
      const d = dist[idx(EXIT[i][0], EXIT[i][1])];
      if (d < 0) { ok = false; continue; }
      all.push(d); totOne++;
      if (d < 85 || d > 100) { outOne++; ok = false; }
    }
    if (ok) okMaps++;
  }
  all.sort((a, b) => a - b);
  const pass = okMaps / nseed, rej = 1 - pass;
  console.log(`  单条出区间 ${(outOne / totOne * 100).toFixed(1)}% | 整图通过 **${(pass * 100).toFixed(1)}%** | 重掷率 ${(rej * 100).toFixed(1)}% | 20连败 ${(Math.pow(rej, 20) * 100).toFixed(1)}%`);
}
