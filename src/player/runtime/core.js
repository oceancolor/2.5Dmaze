// 统一编程接口 v2 的运行时核心（与运行环境无关：浏览器 Worker / Node vm / 浏览器整局试跑共用）。
//
// 脚本 = 一段代码，定义可选的 init(ctx, api) 与必须的 decide(obs, api)：
//   init    开局调用一次（预算 initMs），可预计算距离场、做全局规划；模块里的变量整局保留
//   decide  每回合调用一次，返回 'N'|'E'|'S'|'W'|'STAY' 或 { move, intent: {type:'gem'|'chest'|'exit'|'cell', x, y, note?} }
// 信息边界（SPEC §6）：ctx 只有公开信息（整图、四个出生点、四个出口、本规格规则参数）；没有种子、没有各座位的模式；
// obs 与手打界面 / 大模型同源（observe()），另附上一回合的公开事件 obs.events。
// v1 兼容：obs.state + api.setState、api.distance / shortestStep / isFloor / size / navLeft（不再限次数）。
// 时钟由宿主注入（本文件不读时钟）；随机数 api.random 与 Math.random 都来自 subSeed(subSeed(seed, SCRIPT), seat)。

import { bfsField } from '../../core/nav/bfs.js';
import { STREAM, createStream, next, subSeed } from '../../core/rng.js';
import { staminaFor } from '../../config/default.config.js';
import { MAP_SIZES } from '../../config/map-sizes.js';
import { createSim } from './sim.js';

export const MOVES = Object.freeze(['N', 'E', 'S', 'W', 'STAY']);
const MOVE_SET = new Set(MOVES);
const INTENT_TYPES = new Set(['gem', 'chest', 'exit', 'cell']);
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const FIELD_CACHE = 256;
const LOG_MAX = 20;

/** 规格 id（由边长反查）。 */
export function mapSizeIdOf(size) {
  for (const z of Object.values(MAP_SIZES)) if (z.size === size) return z.id;
  return null;
}

/**
 * 脚本可见的开局信息（只含公开信息）。grid 是拷贝，脚本改了不影响对局。
 * @returns {object} ScriptCtx
 */
export function buildCtx(map, seat, cfg) {
  const T = cfg.treasure;
  const C = T.chest;
  return {
    v: 2,
    seat,
    size: map.size,
    mapSize: mapSizeIdOf(map.size),
    grid: new Uint8Array(map.grid),
    spawns: map.spawns.map(([x, y]) => [x, y]),
    exits: map.exits.map(([x, y]) => [x, y]),
    rules: {
      maxTurns: cfg.rules.maxTurns,
      stamina: staminaFor(cfg),
      moveCost: cfg.rules.moveCost,
      visionRadius: cfg.vision.entityRadius,
      // 视野规则（SPEC §6.1）：mode = radius | full | delayed | radar；delayTurns / radarEvery 只在对应规则下有值
      vision: { mode: cfg.vision.mode ?? 'radius', delayTurns: cfg.vision.delayTurns ?? null, radarEvery: cfg.vision.radarEvery ?? null },
      gemColors: T.gemColors.slice(),
      gemScore: T.gemScore,
      setBonus: T.setBonus,
      gemRespawnMax: T.gemRespawnMax,
      chest: { pScore: C.pScore, scoreRange: C.scoreRange.slice(), staminaRange: C.staminaRange.slice(), respawnTurns: C.respawnTurns, respawnMax: C.respawnMax },
    },
  };
}

/**
 * 代码预处理（三处同一规则，保证行为一致）：不允许 import；去掉顶层 export 关键字（函数 / 变量照常可用）；
 * 运行环境都是严格模式 + 块作用域。返回 {ok, code} 或 {ok:false, error}。
 */
export function prepareScript(code) {
  const src = String(code ?? '');
  if (/^\s*import\s[\s\S]*?from\s|^\s*import\s*['"(]|\bimport\s*\(/m.test(src)) return { ok: false, error: '脚本不能 import 其他模块（所有能力都在 api 里）' };
  if (/^\s*export\s+default\b/m.test(src)) return { ok: false, error: '不支持 export default；请写 function decide(obs, api) { … }（可加 export）' };
  return { ok: true, code: src.replace(/^(\s*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '$1') };
}

/** 取出脚本里 init / decide 的表达式（三处运行环境都在脚本代码之后求值它）。 */
export const BIND_EXPR = "({ init: typeof init === 'function' ? init : null, decide: typeof decide === 'function' ? decide : null })";

/**
 * 规范化 decide 返回值。
 * @returns {{ok:true, move:string, intent:object|null, warn:string|null} | {ok:false, error:string}}
 */
export function normalizeResult(r, size) {
  if (r && typeof r.then === 'function') return { ok: false, error: 'decide 不能返回 Promise（v2 要求同步返回）' };
  let move = r;
  let intent = null;
  let warn = null;
  if (r && typeof r === 'object') {
    move = r.move;
    if (r.intent !== undefined && r.intent !== null) {
      const t = r.intent;
      const ok = t && typeof t === 'object' && INTENT_TYPES.has(t.type) && Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0 && t.x < size && t.y < size;
      if (ok) {
        intent = { type: t.type, x: t.x, y: t.y };
        if (typeof t.note === 'string' && t.note.trim()) intent.note = Array.from(t.note.trim()).slice(0, 60).join('');
      } else warn = 'intent 不合法（需要 {type:"gem"|"chest"|"exit"|"cell", x, y}），已忽略';
    }
  }
  const name = typeof move === 'string' ? move.toUpperCase() : move;
  if (!MOVE_SET.has(name)) return { ok: false, error: `返回值 ${safeJson(move)} 不是 N/E/S/W/STAY` };
  return { ok: true, move: name, intent, warn };
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const fmt = (v) => (typeof v === 'string' ? v : safeJson(v));

/** 错误 → 文本（带脚本内行号；lineOffset = 包装代码在脚本前面加的行数）。 */
export function errText(err, lineOffset = 0, marker = /(?:blob:[^\s)]+|maze-script[^\s):]*):(\d+):(\d+)/) {
  if (!err) return '未知错误';
  const msg = `${err.name || 'Error'}: ${err.message || err}`;
  const m = marker.exec(String(err.stack || ''));
  return m ? `${msg}（第 ${Number(m[1]) - lineOffset} 行）` : msg;
}

/**
 * 一个座位的脚本运行时（每个运行环境一份）。
 * @param {{map:{size:number, grid:Uint8Array, exits:number[][], spawns:number[][]}, seat:number, cfg:object, seed:number, clock:()=>number}} o
 */
export function createRuntime({ map, seat, cfg, seed, clock }) {
  const N = map.size;
  const grid = map.grid;
  const ctx = buildCtx(map, seat, cfg);
  const rnd = createStream(subSeed(subSeed(seed >>> 0, STREAM.SCRIPT), seat));
  const random = () => next(rnd);
  const simStep = createSim({ map, cfg });
  const cache = new Map();

  const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < N && y < N;
  function fieldAt(idx) {
    let f = cache.get(idx);
    if (f) {
      cache.delete(idx);
      cache.set(idx, f);
      return f;
    }
    f = bfsField(grid, N, [idx]);
    cache.set(idx, f);
    if (cache.size > FIELD_CACHE) cache.delete(cache.keys().next().value);
    return f;
  }

  /**
   * 给一次调用（init 或 decide）造 api。budget = api.budget 的内容；obs 用于 v1 接口的「从我出发」与 sim 的默认局面。
   * @returns {{api:object, done:()=>{logs:string[], bag:any, clock:boolean}}}
   */
  function makeApi({ obs = null, bag = null, budget = null, t0 = 0 }) {
    const logs = [];
    let state = bag;
    let usedClock = false;
    const me = obs ? obs.self : null;
    const field = (x, y, opts) => {
      if (!inside(x, y)) return null;
      if (opts && Array.isArray(opts.avoid) && opts.avoid.length) {
        const blocked = new Uint8Array(N * N);
        for (const c of opts.avoid) {
          const cx = Array.isArray(c) ? c[0] : c && c.x;
          const cy = Array.isArray(c) ? c[1] : c && c.y;
          if (inside(cx, cy) && !(cx === x && cy === y)) blocked[cy * N + cx] = 1;
        }
        return bfsField(grid, N, [y * N + x], blocked);
      }
      return fieldAt(y * N + x);
    };
    const dist = (x, y, fromX, fromY) => {
      const fx = fromX ?? (me ? me.x : -1);
      const fy = fromY ?? (me ? me.y : -1);
      const f = field(x, y);
      return f && inside(fx, fy) ? f[fy * N + fx] : -1;
    };
    const stepTo = (x, y, opts) => {
      if (!me) return -1;
      const f = field(x, y, opts);
      if (!f) return -1;
      const cur = f[me.y * N + me.x];
      if (cur < 0) return -1;
      if (cur === 0) return 'STAY';
      for (let d = 0; d < 4; d++) {
        const nx = me.x + DX[d];
        const ny = me.y + DY[d];
        if (inside(nx, ny) && f[ny * N + nx] === cur - 1) return MOVES[d];
      }
      return -1;
    };
    const api = Object.freeze({
      v: 2,
      size: N,
      ctx,
      isFloor: (x, y) => inside(x, y) && grid[y * N + x] === 1,
      /** 以 (x,y) 为源的距离场（Int16Array，索引 y*size+x，-1 不可达）。只读，别改。opts.avoid：额外当墙的格（不缓存）。 */
      field,
      /** (fromX,fromY) → (x,y) 最短步数，默认从自己出发；不可达 −1。 */
      dist,
      distance: dist,
      /** 朝 (x,y) 最短路的下一步（同距离按 N E S W 取第一个）；已在目标上 'STAY'；不可达 −1。opts.avoid 同 field。 */
      shortestStep: stepTo,
      random,
      randInt: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
      sim: Object.freeze({
        step: (belief, moves) => {
          if (!obs) throw new Error('sim.step 只能在 decide 里用（需要本回合的观察作默认局面）');
          return simStep(obs, belief, moves);
        },
      }),
      budget,
      /** 本次调用已用毫秒。注意：按时间截断的算法在不同机器上结果会不同（评测报告会标出用了时钟）。 */
      elapsed: () => {
        usedClock = true;
        return clock() - t0;
      },
      log(...a) {
        if (logs.length < LOG_MAX) logs.push(a.map(fmt).join(' ').slice(0, 200));
      },
      setState(v) {
        state = v;
      },
      navLeft: Infinity,
    });
    return { api, done: () => ({ logs, bag: state, clock: usedClock }) };
  }

  return {
    ctx,
    random,
    /**
     * 调 init（没有 init 时 ok 且 ms=0）。
     * @returns {{ok:boolean, ms:number, logs:string[], error?:string, clock?:boolean}}
     */
    callInit(fns, lineOffset = 0) {
      if (!fns.init) return { ok: true, ms: 0, logs: [] };
      const t0 = clock();
      const { api, done } = makeApi({ t0 });
      try {
        const r = fns.init(ctx, api);
        if (r && typeof r.then === 'function') return { ok: false, ms: clock() - t0, logs: done().logs, error: 'init 不能是 async（v2 要求同步）' };
        const d = done();
        return { ok: true, ms: clock() - t0, logs: d.logs, clock: d.clock };
      } catch (e) {
        return { ok: false, ms: clock() - t0, logs: done().logs, error: errText(e, lineOffset) };
      }
    },
    /**
     * 调 decide。
     * @returns {{ms:number, logs:string[], bag:any, clock:boolean, move?:string, intent?:object|null, warn?:string|null, error?:string, invalid?:string}}
     *   error = 抛错（硬异常）；invalid = 返回值不合法（软异常）
     */
    callDecide(fns, obs, bag, budget, lineOffset = 0) {
      const o = { ...obs, state: bag ?? null };
      const t0 = clock();
      const { api, done } = makeApi({ obs: o, bag, budget, t0 });
      let r;
      try {
        if (!fns.decide) throw new Error('没有找到 decide(obs, api) 函数');
        r = fns.decide(o, api);
      } catch (e) {
        const d = done();
        return { ms: clock() - t0, logs: d.logs, bag, clock: d.clock, error: errText(e, lineOffset) };
      }
      const ms = clock() - t0;
      const d = done();
      const n = normalizeResult(r, N);
      if (!n.ok) return { ms, logs: d.logs, bag: d.bag, clock: d.clock, invalid: n.error };
      return { ms, logs: d.logs, bag: d.bag, clock: d.clock, move: n.move, intent: n.intent, warn: n.warn };
    },
  };
}
