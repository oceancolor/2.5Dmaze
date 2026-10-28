// 浏览器端回合调度（SPEC §5 观战、§7.5 生效时序、§9.1 手动、§10 倍速）。
// 不碰 DOM、不读时钟：时间由调用方以 tick(now) 传入，所以能在 Node 里直接测。
//
// 一回合的生命周期：
//   等待（玩家在场且手动 → 从输入缓冲 / 按住的方向键取意图；都没有就一直等，无超时）
//   → 结算（AI 用同一份观察决策，step() 纯函数结算，逐回合记录意图 + stateHash）
//   → 播放（时长 = 动画时长 ÷ 倍速；播放期间来的输入进缓冲，上限 3，满了明示丢弃）
//   → 下一回合。玩家结算后自动切到观战倍速，可一键跳过到终局。
// 手动输入朝墙：不提交意图、不消耗回合，只回一个本地「撞墙」反馈（地形全公开，UI 自己能判）。

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

/** HUD 的「{倍速}× · 预计 {秒} 秒」：ceil(剩余回合 × moveMs ÷ 倍速)。无同步决策等待（启发式同步、LLM 计划提前 L 回合预取）。 */
export function estimateSeconds(turnsLeft, cfg, speed, skipAnim = false) {
  if (skipAnim) return 0;
  return Math.ceil((turnsLeft * cfg.motion.moveMs) / speed / 1000);
}

/**
 * @param {object} cfg
 * @param {number|string} seed
 * @param {{playerSeat?:number, manual?:boolean, makeController?:(map:object, seat:number, cfg:object, seed:number)=>{decide(obs:object):any}}} [opts]
 */
export function createScheduler(cfg, seed, opts = {}) {
  const playerSeat = opts.playerSeat ?? cfg.match.playerSeat;
  const manual = opts.manual ?? cfg.match.playerMode === 'manual';
  const match = createMatch(seed, cfg);
  const { map } = match;
  const N = map.size;
  const n = match.state.actors.length;
  const make = opts.makeController ?? ((m, i, c, s) => createHeuristic(m, i, c, s));
  const ctrls = Array.from({ length: n }, (_, i) => (i === playerSeat && manual ? null : make(map, i, cfg, match.seed)));
  const rec = createRecorder(match, cfg);
  const listeners = new Map();
  const queue = [];

  let state = match.state;
  let hash = stateHash(state);
  let last = null;
  let busyUntil = -Infinity;
  let bumpUntil = -Infinity;
  let speed = cfg.motion.defaultSpeed;
  let skipAnim = false;
  let paused = false;
  let waiting = false;
  let spectating = false;
  let held = () => null;
  let dropped = 0;

  const emit = (type, payload) => {
    for (const fn of listeners.get(type) ?? []) fn(payload);
  };

  const playerActive = () => state.actors[playerSeat].status === 'active';

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

  function advance(playerIntent, now, skipped = false) {
    const prev = state;
    const intents = new Array(n).fill(STAY);
    const decisions = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (prev.actors[i].status !== 'active') continue;
      if (!ctrls[i]) {
        intents[i] = playerIntent;
        continue;
      }
      const d = ctrls[i].decide(observe(map, prev, i, cfg, { patch: false }));
      decisions[i] = d;
      intents[i] = d && typeof d === 'object' ? d.dir : d;
    }
    const r = step(map, prev, intents, cfg);
    hash = stateHash(r.state);
    rec.turn(prev.turn, intents, prev.actors, hash);
    state = r.state;
    const duration = skipped ? 0 : turnDuration(r, cfg, speed, skipAnim);
    last = { n: prev.turn, prev, next: r.state, events: r.events, dirs: r.dirs, moved: r.moved, intents, decisions, start: now, duration, speed, hash, skipped };
    busyUntil = now + duration;
    if (r.state.ended) rec.end(r.state);
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
    manual,
    get state() { return state; },
    get hash() { return hash; },
    get last() { return last; },
    get speed() { return speed; },
    get skipAnim() { return skipAnim; },
    get paused() { return paused; },
    /** 正在等玩家输入（HUD 提示用）。 */
    get waiting() { return waiting && !state.ended; },
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

    /** 推进：到点且有意图就结算一回合。返回本次是否结算了回合。 */
    tick(now) {
      if (state.ended || paused || now < busyUntil) return false;
      let intent = STAY;
      if (manual && playerActive()) {
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

    /** 观战时跳到终局（不播动画）。玩家仍在场时不允许。 */
    skipToEnd(now, guard = 5000) {
      if (manual && playerActive()) return 0;
      let k = 0;
      while (!state.ended && k++ < guard) advance(STAY, now, true);
      busyUntil = now;
      return k;
    },

    observeFor(seat = playerSeat) {
      return observe(map, state, seat, cfg, { patch: false });
    },

    toJSONL() { return rec.toJSONL(); },
  };
}
