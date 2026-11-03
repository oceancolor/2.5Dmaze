// 脚本座位的浏览器宿主（统一编程接口 v2，SPEC §9.2）：每个脚本一个模块 Worker；每回合 begin 时把观察发过去，
// 调度器在结果回来前等待（blocking）。预算、兜底、降级、统计都在 runtime/control.js（与 Node 评测共用）。
//   开局    编译（Blob 模块）→ bound → init（≤ initMs；超时重建并跳过 init）
//   每回合  可用 = 基础额度 + 时间银行；超支 → 当回合作废，沿意图兜底；卡死（可用 + 宽限仍未回）→ 重建并重新 init
// 任意座位可用：玩家座位连续硬异常切回手动（L2），其他座位改为自动回家（L1）。
// 代码加载不用 eval / new Function：Blob 里 import 桥，再接玩家代码（CSP worker-src blob:，script-src 'self'）。

import { DIR_NAMES } from '../core/geom.js';
import { BUDGET } from './runtime/budget.js';
import { BIND_EXPR, normalizeResult, prepareScript } from './runtime/core.js';
import { createGovernor } from './runtime/control.js';

const BIND_TIMEOUT_MS = 3000;
const LINE_OFFSET = 2; // 与 sandbox-worker.js 一致：import 行 + 块开头

export const SCRIPT_TEMPLATE = `// 统一编程接口 v2：init 开局调用一次（可选），decide 每回合调用一次。文档：docs/07-脚本编程接口.md
// decide 返回 'N' | 'E' | 'S' | 'W' | 'STAY'（N 是 y−1，E 是 x+1），或 { move, intent } 让界面显示你的意图。
let exit = null; // 模块变量整局保留

function init(ctx, api) {
  exit = ctx.exits[ctx.seat]; // ctx：整图、四个出生点、四个出口、本规格规则
}

function decide(obs, api) {
  return { move: api.shortestStep(exit[0], exit[1]), intent: { type: 'exit', x: exit[0], y: exit[1], note: '直奔出口' } };
}
`;

export const SCRIPT_EXAMPLES = Object.freeze({
  greedy: {
    label: '贪心：最近且回得来的宝石（v1 写法）',
    code: `// 贪心：挑「去了还回得来」的最近宝石；体力只够回家就回家。v1 写法（只有 decide）照常可用。
function decide(obs, api) {
  const me = obs.self;
  const exit = me.exit;
  if (me.stamina * 10 <= me.distToExit * 13) {
    api.log('回家', me.stamina, '/', me.distToExit);
    return api.shortestStep(exit.x, exit.y);
  }
  let best = null;
  for (const g of obs.gems) {
    const back = api.distance(exit.x, exit.y, g.x, g.y); // 宝石 → 我的出口
    if (back < 0 || me.stamina < g.dist + back * 1.3) continue;
    if (!best || g.dist < best.dist) best = g;
  }
  if (!best) return api.shortestStep(exit.x, exit.y);
  return api.shortestStep(best.x, best.y);
}
`,
  },
  sets: {
    label: '凑套 + 宝箱 + 记住目标（v1 写法）',
    code: `// 凑套：缺的颜色价值 ×3；宝箱近就先开；用 api.setState 记住目标，避免来回摇摆。v1 写法照常可用。
function decide(obs, api) {
  const me = obs.self;
  const exit = me.exit;
  if (me.stamina * 10 <= me.distToExit * 14) return api.shortestStep(exit.x, exit.y);
  const mem = obs.state || {};
  const still = (t) => t && (t.kind === 'chest'
    ? obs.chest.present && obs.chest.x === t.x && obs.chest.y === t.y
    : obs.gems.some((g) => g.x === t.x && g.y === t.y));
  let t = still(mem.target) ? mem.target : null;
  if (!t) {
    const low = Math.min(...me.gems);
    let best = -1;
    for (const g of obs.gems) {
      const back = api.distance(exit.x, exit.y, g.x, g.y);
      if (back < 0 || me.stamina < g.dist + back * 1.4) continue;
      const v = (me.gems[g.c] === low ? 3 : 1) / (g.dist + 1);
      if (v > best) { best = v; t = { kind: 'gem', x: g.x, y: g.y }; }
    }
    if (obs.chest.present && obs.chest.dist < 25) t = { kind: 'chest', x: obs.chest.x, y: obs.chest.y };
    api.log('新目标', t);
  }
  api.setState({ target: t });
  return t ? api.shortestStep(t.x, t.y) : api.shortestStep(exit.x, exit.y);
}
`,
  },
});

const VALID = new Set(DIR_NAMES);

function bridgeUrl() {
  return new URL('./sandbox-worker.js', import.meta.url).href;
}

/** Worker 错误事件 → 文本（行号换算回玩家代码）。 */
const workerErr = (e, fallback) => `${e.message || fallback}${e.lineno ? `（第 ${e.lineno - LINE_OFFSET} 行）` : ''}`;

/**
 * 起一个模块 Worker 并等它绑定好 init / decide。编译错误 / 没有 decide → reject（带行号）。
 * @returns {Promise<{worker:Worker, url:string}>}
 */
function spawn(prepared) {
  const src = `import { __bind } from ${JSON.stringify(bridgeUrl())};\n{\n${prepared}\n;__bind(${BIND_EXPR});\n}\n`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    const kill = (msg) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(msg));
    };
    const timer = setTimeout(() => kill('脚本加载超时'), BIND_TIMEOUT_MS);
    worker.onerror = (e) => {
      e.preventDefault();
      clearTimeout(timer);
      kill(workerErr(e, '脚本加载失败（多半是语法错误）'));
    };
    worker.onmessage = (e) => {
      if (e.data.type !== 'bound') return;
      clearTimeout(timer);
      worker.onerror = null;
      if (e.data.ok) resolve({ worker, url });
      else kill('没有找到 decide(obs, api) 函数');
    };
  });
}

/** 向 Worker 发 init 并等结果；超过 initMs + 宽限 → null（调用方重建并跳过 init）。 */
function initWorker(w, { map, seat, cfg, seed, skipInit = false }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), BUDGET.initMs + BUDGET.hangGraceMs);
    w.worker.onmessage = (e) => {
      if (e.data.type !== 'inited') return;
      clearTimeout(timer);
      resolve(e.data);
    };
    const grid = map.grid.slice();
    w.worker.postMessage({ type: 'init', size: map.size, grid: grid.buffer, exits: map.exits, spawns: map.spawns, seat, cfg, seed, skipInit }, [grid.buffer]);
  });
}

function close(w) {
  if (!w) return;
  w.worker.terminate();
  URL.revokeObjectURL(w.url);
}

/** 起 Worker + init；init 超时则重建并跳过 init。返回 {w, init}。 */
async function boot(prepared, env) {
  let w = await spawn(prepared);
  let r = await initWorker(w, env);
  if (!r) {
    close(w);
    w = await spawn(prepared);
    r = await initWorker(w, { ...env, skipInit: true });
    if (!r) {
      close(w);
      throw new Error('运行环境启动失败');
    }
    r = { ...r, skipped: `init 超过 ${BUDGET.initMs} ms 未完成，已跳过 init 开局（模块变量为初始值）` };
  } else if (r.skipped) r = { ...r, skipped: null };
  return { w, init: r };
}

/** 发一次 decide 并等结果（试运行用）。 */
function callOnce(worker, obs, ms) {
  return new Promise((resolve) => {
    const id = -1;
    const timer = setTimeout(() => resolve({ error: `超时（>${ms} ms 未返回）` }), ms);
    worker.onmessage = (e) => {
      if (e.data.type !== 'result' || e.data.id !== id) return;
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage({ type: 'decide', id, obs, state: null, budget: { turnMs: BUDGET.baseMs, bankMs: 0, availableMs: BUDGET.baseMs, bankCapMs: BUDGET.bankCapMs } });
  });
}

/** 试运行（开局设置页）：编译 + init + 用给定观察调用一次。返回 {ok, dir, intent, logs, ms, initMs, error}。 */
export async function testScript({ code, map, seat, cfg, seed = 1, obs }) {
  const p = prepareScript(code);
  if (!p.ok) return { ok: false, error: p.error, logs: [] };
  let b;
  try {
    b = await boot(p.code, { map, seat, cfg, seed });
  } catch (e) {
    return { ok: false, error: e.message, logs: [] };
  }
  const initLogs = b.init.logs ?? [];
  if (b.init.error) {
    close(b.w);
    return { ok: false, error: `init：${b.init.error}`, logs: initLogs, initMs: b.init.ms };
  }
  const r = await callOnce(b.w.worker, obs, BUDGET.initMs);
  close(b.w);
  const logs = [...initLogs, ...(r.logs ?? [])];
  if (r.error) return { ok: false, error: r.error, logs, ms: r.ms, initMs: b.init.ms };
  if (r.invalid) return { ok: false, error: r.invalid, logs, ms: r.ms, initMs: b.init.ms };
  const n = normalizeResult(r.intent ? { move: r.move, intent: r.intent } : r.move, map.size);
  if (!n.ok || !VALID.has(n.move)) return { ok: false, error: n.error, logs, ms: r.ms };
  return { ok: true, dir: n.move, intent: n.intent, logs, ms: r.ms, initMs: b.init.ms, skipped: b.init.skipped ?? null, warn: r.warn ?? null };
}

/**
 * @param {{code:string, map:object, seat:number, cfg:object, seed:number, isPlayer?:boolean,
 *          onLog?:(turn:number, lines:string[])=>void, onEvent?:(e:object)=>void}} o
 * @returns {Promise<object>} 控制器（编译失败 reject）
 */
export async function createScriptController({ code, map, seat, cfg, seed, isPlayer = seat === cfg.match.playerSeat, onLog = null, onEvent = null }) {
  const p = prepareScript(code);
  if (!p.ok) throw new Error(p.error);
  const env = { map, seat, cfg, seed };
  const gov = createGovernor({ map, seat, cfg, seed, mode: 'enforce', isPlayer, onEvent });
  let { w, init } = await boot(p.code, env);
  gov.noteInit(init);
  if (init.logs && init.logs.length && onLog) onLog(0, init.logs);

  let ready = true;
  let disposed = false;
  let reqId = 0;
  let pendingTurn = -1;
  let reply = null;
  let hangTimer = 0;

  const listen = () => {
    w.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'result' || m.id !== reqId || reply !== null) return;
      clearTimeout(hangTimer);
      reply = m;
    };
    w.worker.onerror = (e) => {
      e.preventDefault();
      if (reply === null && pendingTurn >= 0) reply = { error: workerErr(e, 'Worker 错误') };
    };
  };
  listen();

  async function respawn(turn, why) {
    ready = false;
    close(w);
    gov.noteReset(turn, why);
    try {
      const b = await boot(p.code, env);
      if (disposed) {
        close(b.w);
        return;
      }
      w = b.w;
      if (b.init.error || b.init.skipped) gov.noteInit(b.init);
      listen();
      ready = true;
    } catch (e) {
      if (onEvent) onEvent({ seat, type: 'degrade', level: 'L1', reason: `重建运行环境失败：${e.message}` });
    }
  }

  const ctrl = {
    kind: 'script',
    get wantsManual() { return gov.wantsManual; },
    get mode() { return gov.level; },
    get counts() { return gov.status().counts; },

    begin(obs, turn) {
      if (gov.level !== 'script' || pendingTurn === turn) return;
      pendingTurn = turn;
      reply = null;
      if (!ready) {
        reply = { error: '运行环境重建中' };
        return;
      }
      const id = ++reqId;
      w.worker.postMessage({ type: 'decide', id, obs, state: gov.bag, budget: gov.budget() });
      const hang = gov.hangMs();
      hangTimer = setTimeout(() => {
        if (reply !== null || reqId !== id) return;
        const why = `卡死（${Math.round(hang)} ms 未返回，已重建运行环境，模块变量丢失）`;
        reply = { error: why };
        respawn(turn, why);
      }, hang);
    },

    blocking(turn) {
      return gov.level === 'script' && pendingTurn === turn && reply === null;
    },

    decide(obs, turn) {
      const r = gov.level === 'script' ? reply : null;
      if (r && r.logs && r.logs.length && onLog) onLog(turn, r.logs);
      return gov.settle(turn, obs, r);
    },

    status() {
      return { ...gov.status(), timing: gov.timing() };
    },

    report() {
      return { ...gov.status().counts, timing: gov.timing() };
    },

    dispose() {
      disposed = true;
      clearTimeout(hangTimer);
      close(w);
    },
  };
  return ctrl;
}
