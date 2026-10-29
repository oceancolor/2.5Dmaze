// 游戏入口：加载图集 → 开局设置 → 建对局（调度器 + 控制器 + 渲染 + HUD）→ 逐帧推进。
// 玩家座位 0：手打 / 脚本 Agent / 提示词 Agent / 我的大模型（05 模式 B，经服务器中转）；座位 1–3：模拟大模型 / 本地代理大模型 / 启发式。

import { makeConfig } from '../config/default.config.js';
import { normalizeSeed, freshSeed } from '../core/rng.js';
import { createMatch } from '../core/state.js';
import { observe } from '../core/observe.js';
import { fnv1a, hex8 } from '../core/hash.js';
import { createHeuristic } from '../ai/heuristic.js';
import { createAgentPool, createPlanner } from '../ai/planner.js';
import { PERSONAS } from '../ai/mock-llm.js';
import { AUTONOMY } from '../ai/codec.js';
import { replay } from '../record/replayer.js';
import { rankActors } from '../core/scoring.js';
import { createScheduler } from './scheduler.js';
import { createMockTransport, createProxyTransport, createRelayTransport, probeProxy } from './transport.js';
import { now, wallNow, frameLoop } from './clock.js';
import { saveRecord } from './storage.js';
import { createSync, newMatchId, syncText } from './sync.js';
import { createInput, MAPPINGS } from '../player/input.js';
import { createScriptController, testScript } from '../player/script-host.js';
import { loadAtlas } from '../render/atlas.js';
import { createRenderer, createFrameMonitor } from '../render/renderer.js';
import { createCamera } from '../render/camera.js';
import { createAnimator } from '../render/animator.js';
import { tileCenter } from '../render/iso.js';
import { createHud } from '../ui/hud.js';
import { createSetup, BRAINS } from '../ui/setup.js';

const canvas = document.getElementById('stage');
const hudRoot = document.getElementById('hud');
const setupRoot = document.getElementById('setup');
const boot = document.getElementById('boot');

let atlas = null;
let game = null;
let lastSeed = null;
let waitSince = -1;

const parseSeed = (s) => (/^\d+$/.test(s) ? normalizeSeed(Number(s)) : normalizeSeed(s));

// 对局记录上传（06 §3.1）：结束即入队上传，离线时联网后补传；结算卡显示本局状态
const sync = createSync({
  onStatus: (id, st) => {
    if (game && game.matchId === id) game.hud.syncStatus(syncText(st));
  },
});

/** 记录里的座位标签（服务器校验：字母开头，只含 字母数字 : _ . / -，≤ 64）。 */
const byokTag = (k) => `byok:${k.provider}/${k.model}`.replace(/[^a-z0-9:_./-]/gi, '_').slice(0, 64);

function seatPlan(setup) {
  const p = setup.player;
  const seats = [];
  if (p.mode === 'manual') seats.push({ label: '手动', tag: 'manual' });
  else if (p.mode === 'script') seats.push({ label: '脚本', tag: 'script' });
  else if (p.mode === 'byok') {
    const k = p.keyMeta || { provider: 'byok', model: 'unknown' };
    seats.push({ label: k.model, persona: AUTONOMY[p.autonomy] ? AUTONOMY[p.autonomy].label : '', tag: byokTag(k), byok: true });
  } else seats.push({ label: p.llm === 'proxy' ? '提示词·大模型' : '提示词·模拟', tag: `prompt-${p.llm}` });
  setup.opponents.forEach((o) => {
    if (o.brain === 'heuristic') seats.push({ label: '启发式', tag: 'heuristic' });
    else seats.push({ label: o.brain === 'proxy' ? '大模型' : '模拟', persona: PERSONAS[o.persona].label, tag: `${o.brain}:${o.persona}` });
  });
  return seats;
}

/**
 * 「同一张图、同样的对手，换成启发式代打」能拿多少（05 §8.3）。模拟大模型对手同步回复，结果与真实对局里的它们一致；
 * 本地代理的对手无法重放，按启发式算。几十毫秒。
 */
function heuristicBaseline(cfg, seed, setup) {
  const pool = createAgentPool(cfg);
  const mock = createMockTransport({ isFast: () => true });
  const s = createScheduler(cfg, seed, {
    controllers: (m) => [createHeuristic(m.map, 0, cfg, m.seed), ...setup.opponents.map((o, k) => (o.brain === 'mock'
      ? createPlanner({ map: m.map, seat: k + 1, cfg, seed: m.seed, pool, persona: PERSONAS[o.persona].text, transport: mock })
      : createHeuristic(m.map, k + 1, cfg, m.seed)))],
  });
  s.runSync(0, cfg.rules.maxTurns + 10);
  return rankActors(s.state.actors, cfg).find((r) => r.seat === 0);
}

function compareText(mine, base, proxied) {
  const show = (r) => (r.status === 'escaped' ? `${r.score} 分（第 ${r.place} 名）` : `出局（第 ${r.place} 名）`);
  const both = mine.status === 'escaped' && base.status === 'escaped';
  const d = both ? mine.score - base.score : null;
  return `对比：同一张图、同样的对手，换成启发式代打 → ${show(base)}；你的思路 + AI → ${show(mine)}`
    + `${d === null ? '' : d === 0 ? '，打平' : `，${d > 0 ? '多' : '少'} ${Math.abs(d)} 分`}${proxied ? '（本地代理的对手按启发式算）' : ''}`;
}

function disposeGame() {
  if (!game) return;
  for (const c of game.sched.controllers) if (c && c.dispose) c.dispose();
  game.offs.forEach((f) => f());
  game = null;
}

async function startMatch(setup, { sameSeed = false } = {}) {
  const p = setup.player;
  // 模式 B：开局前确认选中的 key 还在服务器上（「仅本次会话」的 key 24 小时后丢弃；服务器重启也会丢）
  let keyMeta = null;
  if (p.mode === 'byok') {
    boot.hidden = false;
    boot.textContent = '连接游戏服务器…';
    const r = await sync.call('GET', '/api/v1/keys');
    keyMeta = r.status === 200 ? r.json.items.find((k) => k.keyId === p.keyId) || null : null;
    if (!keyMeta) {
      boot.hidden = true;
      setupUi.show({
        resume: Boolean(game && !game.sched.state.ended),
        err: r.status === 0 ? '连不上游戏服务器：接入大模型需要服务器中转（npm run play）'
          : '选中的模型已不在服务器上（「仅本次会话」的 key 24 小时后丢弃，或服务器重启过），请重新添加',
      });
      return;
    }
    p.keyMeta = { provider: keyMeta.provider, providerLabel: keyMeta.providerLabel, model: keyMeta.model, reasoning: Boolean(keyMeta.reasoning) };
  }
  const cfg = makeConfig({ match: { playerMode: p.mode } });
  const seed = sameSeed && lastSeed !== null ? lastSeed : setup.seed ? parseSeed(setup.seed) : freshSeed();
  boot.hidden = false;
  boot.textContent = '生成迷宫…';
  await new Promise((r) => setTimeout(r, 16));
  const match = createMatch(seed, cfg);
  const seats = seatPlan(setup);
  const matchId = newMatchId();
  // 调用池按来源分开：本地代理 / 玩家自己的模型熔断（L3）只影响走那条线路的座位，模拟大模型照常
  const pools = { mock: createAgentPool(cfg), proxy: createAgentPool(cfg), byok: createAgentPool(cfg) };
  let schedRef = null;
  const isFast = () => Boolean(schedRef && schedRef.fast);
  const mock = createMockTransport({ isFast });
  const proxy = createProxyTransport({ cfg });
  const transport = (kind) => (kind === 'proxy' ? proxy : mock);
  const usesProxy = (p.mode === 'prompt' && p.llm === 'proxy') || setup.opponents.some((o) => o.brain === 'proxy');
  const pool = p.mode === 'byok' ? pools.byok : usesProxy ? pools.proxy : pools.mock;
  const usage = { calls: 0, failed: 0, in: 0, out: 0 };
  let hudRef = null;

  const ctrls = [];
  try {
    if (p.mode === 'manual') ctrls.push(null);
    else if (p.mode === 'script') {
      boot.textContent = '加载脚本…';
      ctrls.push(await createScriptController({
        code: p.code, map: match.map, seat: 0, cfg, seed: match.seed,
        warmObs: observe(match.map, match.state, 0, cfg, { patch: false }),
        onLog: (t, lines) => hudRef && hudRef.scriptLog(t, lines),
        onEvent: (e) => hudRef && hudRef.agentEvent(e),
      }));
    } else if (p.mode === 'byok') {
      const relay = createRelayTransport({
        cfg, call: sync.call, keyId: p.keyId, matchId, reasoning: p.keyMeta.reasoning,
        onCall: (i) => {
          usage.calls++;
          if (!i.ok) usage.failed++;
          if (i.usage) {
            usage.in += i.usage.in | 0;
            usage.out += i.usage.out | 0;
          }
        },
      });
      ctrls.push(createPlanner({
        map: match.map, seat: 0, cfg, seed: match.seed, pool: pools.byok, persona: p.persona,
        autonomy: p.autonomy, safetyGate: p.safetyGate !== false, callCap: p.callCap || 0, transport: relay,
      }));
    } else {
      ctrls.push(createPlanner({ map: match.map, seat: 0, cfg, seed: match.seed, pool: pools[p.llm], persona: p.persona, transport: transport(p.llm) }));
    }
  } catch (e) {
    boot.hidden = true;
    setupUi.show({ resume: Boolean(game), err: `脚本无法加载：${e.message}` });
    return;
  }
  setup.opponents.forEach((o, k) => {
    const seat = k + 1;
    ctrls.push(o.brain === 'heuristic'
      ? createHeuristic(match.map, seat, cfg, match.seed)
      : createPlanner({ map: match.map, seat, cfg, seed: match.seed, pool: pools[o.brain], persona: PERSONAS[o.persona].text, transport: transport(o.brain) }));
  });
  // 提示词 / 我的大模型：玩家可以接管、交还、换启发式（05 §4 / §8.1）
  const playerAI = p.mode === 'prompt' || p.mode === 'byok' ? ctrls[0] : null;
  const strategy = p.mode === 'byok' ? String(p.persona || '').slice(0, 2000) : '';
  const players = p.mode === 'byok'
    ? [{ seat: 0, provider: p.keyMeta.provider, model: p.keyMeta.model, autonomy: p.autonomy, safetyGate: p.safetyGate !== false, strategyHash: hex8(fnv1a(strategy)) }]
    : undefined;

  disposeGame();
  lastSeed = seed;
  const startedAt = wallNow();
  const sched = createScheduler(cfg, seed, { match, controllers: ctrls, seatLabels: seats.map((s) => s.tag), players });
  schedRef = sched;
  sched.setSpeed(setup.speed);
  const renderer = createRenderer({ canvas, map: match.map, cfg, atlas });
  renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1);
  const camera = createCamera({ zoomLevels: cfg.render.zoomLevels, size: match.map.size });
  const animator = createAnimator({ map: match.map, cfg, playerSeat: sched.playerSeat });
  const hud = createHud(hudRoot, { cfg, atlas, seats, actions });
  hudRef = hud;
  const monitor = createFrameMonitor({
    onTrip: () => {
      if (renderer.stepDown()) hud.toast(`帧时间持续超过 16.7 ms，画质降到 L${renderer.quality}`, 2600);
    },
  });
  const offs = [
    sched.on('turn', (l) => {
      animator.onTurn(l);
      hud.onTurn(l);
    }),
    sched.on('bump', (b) => animator.onBump(b)),
    sched.on('drop', () => hud.toast('输入太快：缓冲已满（3），丢弃了 1 次')),
    sched.on('spectate', () => hud.toast(`你已结算，切到 ${cfg.motion.spectateSpeed}× 观战`, 2400)),
    sched.on('manual', (e) => hud.toast(`脚本${e.reason}，已切回手动操作`, 3200)),
    sched.on('end', ({ state }) => {
      const mine = p.mode === 'byok'
        ? { report: playerAI.report(), usage: { ...usage }, l3: pool.stats().l3, label: `${p.keyMeta.providerLabel || p.keyMeta.provider} / ${p.keyMeta.model}` }
        : null;
      // 模式 B 的调用次数已在思路执行报告里（以服务器账本为准），标题行不再重复
      hud.showEnd(sched, game && game.usesLLM && !mine ? pool.stats() : null, mine);
      const ranking = rankActors(state.actors, cfg);
      const record = sched.toJSONL();
      saveRecord({
        matchId, seed, endTurn: state.endTurn, seats: seats.map((s) => s.tag),
        ranking: ranking.map((r) => ({ seat: r.seat, place: r.place, score: r.score, status: r.status })),
        jsonl: record,
      }, cfg.record.keepRecent);
      // 思路原文只随上传进服务器的私有表（仅本人可见）；记录里只有它的哈希
      sync.submit({ matchId, record, startedAt, endedAt: wallNow(), strategy: mine ? { seat: 0, autonomy: p.autonomy, safetyGate: p.safetyGate !== false, text: strategy } : null });
      if (mine) {
        setTimeout(() => {
          const base = heuristicBaseline(cfg, seed, setup);
          hud.setCompare(compareText(ranking.find((r) => r.seat === 0), base, setup.opponents.some((o) => o.brain === 'proxy')));
        }, 50);
        // 用量以服务器账本为准：客户端超时放弃的那次，服务器仍等到上游回来并记账（服务商照样计费）
        sync.call('GET', `/api/v1/usage?matchId=${matchId}`).then((r) => {
          const s0 = r.status === 200 && r.json.match ? r.json.match.seats.filter((x) => x.seat === 0) : [];
          if (!s0.length) return;
          hud.setUsage(mine, s0.reduce((a, x) => ({ calls: a.calls + x.calls, in: a.in + x.tokensIn, out: a.out + x.tokensOut }), { calls: 0, in: 0, out: 0 }));
        });
      }
    }),
  ];
  game = {
    sched, renderer, camera, animator, hud, monitor, pool, setup, seats, follow: sched.playerSeat, offs, matchId, playerAI, held: 'ai', usage,
    usesLLM: setup.opponents.some((o) => o.brain !== 'heuristic') || p.mode === 'prompt' || p.mode === 'byok',
  };
  input.setMapping(setup.mapping);
  boot.hidden = true;
  setupUi.hide();
  hud.toast(`种子 ${seed} · ${seats.map((s, i) => `${i ? `AI-${'ABC'[i - 1]}` : '你'}：${s.label}${s.persona ? `·${s.persona}` : ''}`).join(' · ')}`, 3600);
  if (usesProxy) {
    probeProxy().then((r) => {
      if (!(r.ok && r.keyPresent)) hud.toast('本地代理未就绪：用大模型的座位会在首次调用失败后熔断为启发式', 4200);
    });
  }
}

const actions = {
  setSpeed: (v) => game && game.sched.setSpeed(v),
  toggleSkipAnim: () => game && game.sched.setSkipAnim(!game.sched.skipAnim),
  togglePause: () => game && game.sched.setPaused(!game.sched.paused),
  zoomBy: (k) => game && game.camera.zoomBy(k),
  recenter: () => game && game.camera.recenter(),
  toggleMapping: () => {
    const keys = Object.keys(MAPPINGS);
    const next = keys[(keys.indexOf(input.mapping) + 1) % keys.length];
    input.setMapping(next);
    setupUi.patch({ mapping: next });
    if (game) game.hud.toast(`方向映射：${MAPPINGS[next].label}`);
  },
  skipToEnd: () => {
    if (game && game.sched.skipToEnd()) game.hud.toast('快进到结算…');
  },
  follow: (seat) => {
    if (!game) return;
    game.follow = seat;
    game.camera.recenter();
  },
  newMatch: (mode) => startMatch(game ? game.setup : setupUi.setup, { sameSeed: mode === 'same' }),
  openSetup,
  /** 接管：玩家座位切手打（AI 的统计保留，随时交还）。 */
  takeOver: () => {
    if (!game || !game.playerAI || game.sched.state.ended) return;
    game.sched.setPlayerController(null);
    game.held = 'manual';
    game.hud.toast('你接管了：方向键 / WASD 手打；点「交还 AI」让它接着打', 3200);
  },
  handBack: () => {
    if (!game || !game.playerAI || game.sched.state.ended) return;
    game.sched.setPlayerController(game.playerAI);
    game.held = 'ai';
    game.hud.toast('已交还 AI', 1800);
  },
  useHeuristic: () => {
    if (!game || !game.playerAI || game.sched.state.ended) return;
    const { sched } = game;
    sched.setPlayerController(createHeuristic(sched.map, sched.playerSeat, sched.cfg, sched.match.seed));
    game.held = 'heuristic';
    game.hud.toast('换成启发式代打；随时可以交还 AI', 2400);
  },
  verify: () => {
    if (!game) return '';
    try {
      const r = replay(game.sched.toJSONL(), game.sched.cfg);
      return `严格回放通过：${r.turns} 回合逐回合 stateHash 一致${r.complete ? '，终局一致' : ''}。`;
    } catch (e) {
      return `回放不一致：${e.message}`;
    }
  },
  download: () => {
    if (!game) return;
    const blob = new Blob([game.sched.toJSONL()], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `maze-${game.sched.match.seed}-${wallNow()}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

function openSetup() {
  if (game) game.sched.setPaused(true);
  setupUi.show({ resume: Boolean(game && !game.sched.state.ended) });
}

const setupUi = createSetup(setupRoot, {
  probe: () => probeProxy(),
  trial: async (code, seedText) => {
    const cfg = makeConfig({ match: { playerMode: 'script' } });
    const m = createMatch(seedText ? parseSeed(seedText) : 1, cfg);
    return testScript({ code, map: m.map, seat: 0, cfg, obs: observe(m.map, m.state, 0, cfg, { patch: false }) });
  },
  onStart: (s) => startMatch(s),
  history: () => sync.listMine(10),
  llm: { call: sync.call },
  onResume: () => {
    setupUi.hide();
    if (game) game.sched.setPaused(false);
  },
});

function onKey(e) {
  if (setupUi.open) {
    if (e.code === 'Escape' && game && !game.sched.state.ended) {
      setupUi.hide();
      game.sched.setPaused(false);
    }
    return;
  }
  if (!game) return;
  const { sched } = game;
  const k = e.code;
  const sp = { Digit1: 1, Digit2: 2, Digit3: 4 };
  if (k in sp) actions.setSpeed(sp[k]);
  else if (k === 'Digit0') actions.toggleSkipAnim();
  else if (k === 'KeyP') actions.togglePause();
  else if (k === 'Minus' || k === 'NumpadSubtract') actions.zoomBy(1);
  else if (k === 'Equal' || k === 'NumpadAdd') actions.zoomBy(-1);
  else if (k === 'KeyF') actions.recenter();
  else if (k === 'KeyM') actions.toggleMapping();
  else if (k === 'KeyN') actions.newMatch('new');
  else if (k === 'Escape') openSetup();
  else if (k === 'Enter') {
    if (sched.state.ended) actions.newMatch('new');
    else actions.skipToEnd();
  } else return;
  e.preventDefault();
}

const input = createInput(window, {
  onDir: (d) => {
    if (!game || setupUi.open) return;
    if (game.sched.manual && game.camera.free) game.camera.recenter();
    game.sched.pushIntent(d);
  },
  onKey,
});

// 拖拽平移 / 滚轮缩放
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || !game) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  drag.moved = true;
  game.camera.pan(dx, dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  if (!game) return;
  e.preventDefault();
  game.camera.zoomBy(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
addEventListener('resize', () => game && game.renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1));

function followSeat(sched) {
  const A = sched.state.actors;
  if (A[sched.playerSeat].status === 'active') return sched.playerSeat;
  if (A[game.follow] && A[game.follow].status === 'active') return game.follow;
  const a = A.find((x) => x.status === 'active');
  return a ? a.seat : game.follow;
}

frameLoop((t, dt) => {
  if (!game) return;
  const t0 = now();
  const { sched, camera, renderer, animator, hud } = game;
  if (sched.fast) {
    const until = t0 + 12;
    while (now() < until && sched.tick(now()));
  } else {
    sched.tick(t);
  }
  const waitingNow = (sched.waiting || sched.waitingFor.length) && !sched.state.ended;
  if (waitingNow) {
    if (waitSince < 0) waitSince = t;
  } else waitSince = -1;
  const view = { viewer: sched.playerSeat, god: sched.spectating || sched.state.ended };
  const fr = animator.frame(t, { state: sched.state, last: sched.last, view, quality: renderer.quality });
  const fs = followSeat(sched);
  const pos = fr.pos[fs];
  if (pos) {
    const [wx, wy] = tileCenter(pos[0], pos[1]);
    camera.follow(wx, wy - 20);
  }
  camera.update(dt, innerWidth, innerHeight);
  renderer.render(fr, camera, t, sched.playerSeat);
  hud.update(sched, {
    follow: fs, mapping: input.mapping, zoomIndex: camera.zoomIndex, waitMs: waitSince < 0 ? 0 : t - waitSince,
    quality: renderer.quality, poolStats: game.usesLLM ? game.pool.stats() : null,
    player: game.playerAI ? { ai: game.playerAI, held: game.held, usage: game.usage } : null,
  });
  if (!sched.fast) game.monitor.sample(now() - t0);
});

(async function main() {
  try {
    boot.textContent = '加载图集…';
    atlas = await loadAtlas({ base: '/assets/atlas/', onHi: () => game && game.renderer.invalidate() });
  } catch (e) {
    boot.textContent = `图集加载失败：${e.message}`;
    return;
  }
  boot.hidden = true;
  const q = new URLSearchParams(location.search);
  if (q.get('seed')) setupUi.patch({ seed: q.get('seed') });
  if (q.get('mode') && ['manual', 'script', 'prompt', 'byok'].includes(q.get('mode'))) {
    const s = setupUi.setup;
    s.player.mode = q.get('mode');
    setupUi.patch({ player: s.player });
  }
  if (q.get('start') === '1') startMatch(setupUi.setup);
  else setupUi.show();
  sync.flush(); // 上次离线结束、还没传上去的对局
})();

// 调试入口（控制台）：__maze.game / __maze.BRAINS / __maze.sync
globalThis.__maze = { get game() { return game; }, BRAINS, sync };
