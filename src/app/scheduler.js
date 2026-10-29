// 浏览器端回合调度（SPEC §5 观战、§7.5 生效时序、§9 玩家通道、§10 倍速）。
// 不碰 DOM、不读时钟：时间由调用方以 tick(now) 传入，所以能在 Node 里直接测。
//
// 一回合的生命周期：
//   开始   每个控制器 begin(obs, turn) 一次（LLM 规划发请求 / 脚本 Worker 收观察）
//   等待   ① 有控制器 blocking(turn)（LLM 计划到期未回、脚本还没返回）→ 等，超时由外层判
//          ② 玩家手动且在场 → 从输入缓冲 / 按住的方向键取意图；都没有就一直等，无超时
//   结算   控制器 decide(obs, turn) → step() 纯函数结算 → 逐回合记录意图 + stateHash（+ 计划生效行）
//   播放   时长 = 动画时长 ÷ 倍速；播放期间来的输入进缓冲，上限 3，满了明示丢弃
//   玩家结算后自动切到观战倍速；跳到终局 = 快进（不播动画，仍等异步控制器）。
// 手动输入朝墙：不提交意图、不消耗回合，只回一个本地「撞墙」反馈（地形全公开，UI 自己能判）。
//
// 控制器接口：{ decide(obs, turn) → dir | {dir,...}, begin?(obs, turn), blocking?(turn) → bool,
//              takeLog?() → plan 行[], wantsPatch?: bool, wantsManual?: bool（脚本 L2：切回手动）}

import { createMatch } from '../core/state.js';
import { step } from '../core/game.js';
import { observe } from '../core/observe.js';
import { stateHash } from '../core/hash.js';
import { DX, DY, STAY, toDir } from '../core/geom.js';
import { fieldFrom } from '../core/nav/bfs.js';
import { createHeuristic } from '../ai/heuristic.js';
import { createRecorder } from '../record/recorder.js';

/** 输入缓冲上限（04 L05：≥3 且明示丢弃）。 */
export const INPUT_BUFFER = 3;

/** 「预计时长」用的整局回合数基线：SPEC 附录 B 回合 P50。 */
export const BASELINE_TURNS_P50 = 375;

/** 一回合的播放时长（ms，已除倍速）。拾取不加时长（motion.pickOverlaps）；有人到达 / 出局时给离场演出留 endMs。 */
export function turnDuration(result, cfg, speed, skipAnim = false) {
  if (skipAnim) return 0;
  const M = cfg.motion;
  let ms = M.moveMs;
  if (!result.moved.some(Boolean) && result.events.some((e) => e.type === 'blocked' || e.type === 'bump')) ms = M.bumpMs;
  if (result.events.some((e) => e.type === 'escaped' || e.type === 'failed')) ms = Math.max(ms, M.endMs);
  if (!M.pickOverlaps && result.events.some((e) => e.type === 'pickup' || e.type === 'chest')) ms += M.pickMs;
  return ms / speed;
}

/** 剩余回合估计：基线 P50 减去已过回合；不少于在场者里最远的回家步数。 */
export function estimateTurnsLeft(map, state) {
  if (state.ended) return 0;
  const N = map.size;
  let far = 0;
  for (const a of state.actors) {
    if (a.status !== 'active') continue;
    const [ex, ey] = map.exits[a.seat];
    far = Math.max(far, fieldFrom(map, ey * N + ex)[a.y * N + a.x]);
  }
  return Math.max(BASELINE_TURNS_P50 - (state.turn - 1), far);
}

/**
 * HUD 的「{倍速}× · 预计 {秒} 秒」：ceil(剩余回合 × (moveMs ÷ 倍速 + 每回合平均同步等待))。
 * 同步等待 = 实测的 LLM 计划到期未回 / 脚本决策耗时（不含玩家自己思考的时间）。
 */
export function estimateSeconds(turnsLeft, cfg, speed, skipAnim = false, waitPerTurnMs = 0) {
  const per = (skipAnim ? 0 : cfg.motion.moveMs / speed) + waitPerTurnMs;
  return Math.ceil((turnsLeft * per) / 1000);
}

/**
 * @param {object} cfg
 * @param {number|string} seed
 * @param {{playerSeat?:number, manual?:boolean, controllers?:(object|null)[], seatLabels?:string[], players?:object[], match?:object,
 *          makeController?:(map:object, seat:number, cfg:object, seed:number)=>object}} [opts]
 *   controllers：每座位一个控制器（null = 手动，只允许玩家座位）；可传函数 (match) => 数组，以便控制器拿到地图与种子
 *   match：预先建好的 createMatch(seed, cfg)（异步控制器要先拿地图时用；必须是同一 seed / cfg）
 *   players：记录 meta 里玩家 AI 的说明（服务商 / 模型 / 自主度 / 思路哈希），见 recorder.js
 */
export function createScheduler(cfg, seed, opts = {}) {
  const playerSeat = opts.playerSeat ?? cfg.match.playerSeat;
  const match = opts.match ?? createMatch(seed, cfg);
  const { map } = match;
  const N = map.size;
  const n = match.state.actors.length;
  let ctrls;
  if (opts.controllers) {
    ctrls = (typeof opts.controllers === 'function' ? opts.controllers(match) : opts.controllers).slice();
    if (ctrls.length !== n) throw new Error(`controllers.length ${ctrls.length} != ${n}`);
    ctrls.forEach((c, i) => {
      if (!c && i !== playerSeat) throw new Error(`seat ${i} needs a controller (only the player seat may be manual)`);
    });
  } else {
    const manual0 = opts.manual ?? cfg.match.playerMode === 'manual';
    const make = opts.makeController ?? ((m, i, c, s) => createHeuristic(m, i, c, s));
    ctrls = Array.from({ length: n }, (_, i) => (i === playerSeat && manual0 ? null : make(map, i, cfg, match.seed)));
  }
  let manual = ctrls[playerSeat] === null;
  const rec = createRecorder(match, cfg, { seats: opts.seatLabels, players: opts.players });
  const listeners = new Map();
  const queue = [];

  let state = match.state;
  let hash = stateHash(state);
  let last = null;
  let busyUntil = -Infinity;
  let bumpUntil = -Infinity;
  let speed = cfg.motion.defaultSpeed;
  let skipAnim = false;
  let fast = false;
  let paused = false;
  let waiting = false;
  let waitingFor = [];
  let waitStart = -1;
  let waitTotal = 0;
  let spectating = false;
  let held = () => null;
  let dropped = 0;
  let begun = -1;
  let obsCache = new Array(n).fill(null);

  const emit = (type, payload) => {
    for (const fn of listeners.get(type) ?? []) fn(payload);
  };

  const playerActive = () => state.actors[playerSeat].status === 'active';
  const humanTurn = () => manual && playerActive();

  const isWallFor = (d) => {
    const a = state.actors[playerSeat];
    const x = a.x + DX[d];
    const y = a.y + DY[d];
    return x < 0 || y < 0 || x >= N || y >= N || !map.grid[y * N + x];
  };

  /** 取玩家本回合意图：缓冲优先，其次按住的键；朝墙的丢掉并给本地撞墙反馈。null = 继续等。 */
  function takeIntent(now) {
    for (;;) {
      const fromQueue = queue.length > 0;
      const raw = fromQueue ? queue.shift() : held(now);
      if (raw === null || raw === undefined) return null;
      const d = toDir(raw);
      if (d < 0) continue;
      if (d === STAY) return STAY;
      if (!isWallFor(d)) return d;
      if (fromQueue || now >= bumpUntil) {
        bumpUntil = now + (skipAnim ? 0 : cfg.motion.bumpMs / speed);
        emit('bump', { seat: playerSeat, dir: d, start: now, duration: bumpUntil - now });
      }
      if (!fromQueue) return null;
    }
  }

  const obsFor = (i) => {
    if (!obsCache[i]) obsCache[i] = observe(map, state, i, cfg, { patch: Boolean(ctrls[i] && ctrls[i].wantsPatch) });
    return obsCache[i];
  };

  function beginTurn() {
    if (begun === state.turn) return;
    begun = state.turn;
    obsCache = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const c = ctrls[i];
      if (c && c.begin && state.actors[i].status === 'active') c.begin(obsFor(i), state.turn);
    }
  }

  function advance(playerIntent, now) {
    const prev = state;
    const intents = new Array(n).fill(STAY);
    const decisions = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (prev.actors[i].status !== 'active') continue;
      const c = ctrls[i];
      if (!c) {
        intents[i] = playerIntent;
        continue;
      }
      const d = c.decide(obsFor(i), prev.turn);
      decisions[i] = d;
      intents[i] = d && typeof d === 'object' ? d.dir : d;
      if (c.takeLog) for (const p of c.takeLog()) rec.plan(p);
    }
    const r = step(map, prev, intents, cfg);
    hash = stateHash(r.state);
    rec.turn(prev.turn, intents, prev.actors, hash);
    state = r.state;
    const duration = fast ? 0 : turnDuration(r, cfg, speed, skipAnim);
    last = { n: prev.turn, prev, next: r.state, events: r.events, dirs: r.dirs, moved: r.moved, intents, decisions, start: now, duration, speed, hash, skipped: fast };
    busyUntil = now + duration;
    if (r.state.ended) rec.end(r.state);
    // 脚本 L2：连续硬异常 → 玩家座位切回手动（下一回合起）
    const pc = ctrls[playerSeat];
    if (pc && pc.wantsManual && playerActive()) {
      ctrls[playerSeat] = null;
      manual = true;
      emit('manual', { seat: playerSeat, reason: pc.wantsManual });
    }
    if (!spectating && !r.state.ended && !playerActive()) {
      spectating = true;
      speed = cfg.motion.spectateSpeed;
      queue.length = 0;
      emit('spectate', { speed });
    }
    emit('turn', last);
    if (r.state.ended) emit('end', { state: r.state });
    return last;
  }

  return {
    cfg,
    match,
    map,
    playerSeat,
    get manual() { return manual; },
    get controllers() { return ctrls; },
    get state() { return state; },
    get hash() { return hash; },
    get last() { return last; },
    get speed() { return speed; },
    get skipAnim() { return skipAnim; },
    get fast() { return fast; },
    get paused() { return paused; },
    /** 正在等玩家输入（HUD 提示用）。 */
    get waiting() { return waiting && !state.ended; },
    /** 正在等哪些座位的异步控制器。 */
    get waitingFor() { return waitingFor; },
    /** 每回合平均同步等待（ms）：只算等 AI / 脚本，不算等玩家。 */
    get waitPerTurn() { return state.turn > 1 ? waitTotal / (state.turn - 1) : 0; },
    get spectating() { return spectating; },
    get dropped() { return dropped; },
    get queued() { return queue.length; },
    /** 当前回合动画是否还在播。 */
    busy(now) { return now < busyUntil; },

    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },

    setSpeed(s) {
      if (!cfg.motion.speeds.includes(s)) throw new Error(`unsupported speed ${s}`);
      speed = s;
      skipAnim = false;
    },
    setSkipAnim(v) { skipAnim = Boolean(v); },
    setPaused(v) { paused = Boolean(v); },
    /** 按住方向键的查询函数：(now) => 'N'|'E'|'S'|'W'|null。 */
    setHeld(fn) { held = fn; },

    /**
     * 换玩家座位的控制器（05 §4 / §8.1：接管 = null 手打；交还 AI；换启发式代打）。下一次结算起生效。
     * 严格回放只读意图，换控制器不影响校验。本回合已开始过的话，补调新控制器的 begin（每回合恰好一次）。
     */
    setPlayerController(c) {
      if (state.ended) return;
      ctrls[playerSeat] = c;
      manual = c === null;
      queue.length = 0;
      obsCache[playerSeat] = null;
      if (c && c.begin && begun === state.turn && playerActive()) c.begin(obsFor(playerSeat), state.turn);
    },

    /**
     * 玩家方向输入（'N'|'E'|'S'|'W'|'STAY'）。返回 'queued' | 'dropped' | 'ignored'。
     * 缓冲满时丢弃最新一次并广播 'drop'（HUD 明示）。
     */
    pushIntent(dir) {
      if (!manual || state.ended || !playerActive()) return 'ignored';
      if (toDir(dir) < 0) return 'ignored';
      if (queue.length >= INPUT_BUFFER) {
        dropped++;
        emit('drop', { dropped });
        return 'dropped';
      }
      queue.push(dir);
      return 'queued';
    },

    /** 推进：到点、异步控制器就绪、且有玩家意图就结算一回合。返回本次是否结算了回合。 */
    tick(now) {
      if (state.ended || paused || now < busyUntil) return false;
      beginTurn();
      const wf = [];
      for (let i = 0; i < n; i++) {
        const c = ctrls[i];
        if (c && c.blocking && state.actors[i].status === 'active' && c.blocking(state.turn)) wf.push(i);
      }
      waitingFor = wf;
      if (wf.length) {
        if (waitStart < 0) waitStart = now;
        waiting = false;
        return false;
      }
      if (waitStart >= 0) {
        waitTotal += now - waitStart;
        waitStart = -1;
      }
      let intent = STAY;
      if (humanTurn()) {
        intent = takeIntent(now);
        if (intent === null) {
          waiting = true;
          return false;
        }
      }
      waiting = false;
      advance(intent, now);
      return true;
    },

    /** 跳到终局：快进（不播动画）。玩家仍在场且手动时不允许。由调用方循环 tick（异步控制器照样要等）。 */
    skipToEnd() {
      if (humanTurn()) return false;
      fast = true;
      return true;
    },

    /** 同步跑到底（Node 测试 / 全同步控制器，按快进时长 0 推进）：返回推进的回合数；遇到异步等待或等玩家即停。 */
    runSync(now = 0, guard = 5000) {
      const was = fast;
      fast = true;
      let k = 0;
      while (!state.ended && k < guard && this.tick(now)) k++;
      fast = was;
      return k;
    },

    observeFor(seat = playerSeat) {
      return observe(map, state, seat, cfg, { patch: false });
    },

    toJSONL() { return rec.toJSONL(); },
  };
}
