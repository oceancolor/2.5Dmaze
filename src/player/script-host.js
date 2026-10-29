// 脚本 agent 宿主（SPEC §9.2）：每个脚本一个 Worker；每回合 begin 时把观察发过去，调度器在结果回来前等待。
// 异常分级：
//   A 硬异常 —— 超时（Worker 内测 decide 耗时 > decisionTimeoutMs）/ 抛错 / 返回值不可结构化克隆 / 卡死（硬期限到了仍未回，重建 Worker）。
//               本回合原地等；连续 l2ConsecutiveHard 次 → L2 切回手动（wantsManual，调度器下回合起改等键盘）。
//   B 软异常 —— 返回值不是 N/E/S/W/STAY、state 超 stateBagKB。本回合原地等；累计 l1CumulativeSoft 次 → L1 引擎接管、自动回家。
//   C 撞墙 —— 正常玩法，不计数。
// 代码加载不用 eval / new Function：Blob 里先 importScripts 桥，再接玩家代码（CSP worker-src blob:）。

import { now } from '../app/clock.js';
import { DIR_NAMES, STAY, toDir } from '../core/geom.js';
import { STREAM, createStream, subSeed } from '../core/rng.js';
import { stepToward } from '../ai/heuristic.js';

const HANG_GRACE_MS = 400;
const BIND_TIMEOUT_MS = 3000;

export const SCRIPT_TEMPLATE = `// 每回合调用一次，返回 'N' | 'E' | 'S' | 'W' | 'STAY'（N 是 y−1，E 是 x+1）。
// obs 与手动界面、AI 拿到的是同一份观察；api 提供寻路（每回合最多 8 次）。
function decide(obs, api) {
  const me = obs.self;
  return api.shortestStep(me.exit.x, me.exit.y); // 直奔出口
}
`;

export const SCRIPT_EXAMPLES = Object.freeze({
  greedy: {
    label: '贪心：最近且回得来的宝石',
    code: `// 贪心：挑「去了还回得来」的最近宝石；体力只够回家就回家。
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
    label: '凑套 + 宝箱 + 记住目标',
    code: `// 凑套：缺的颜色价值 ×3；宝箱近就先开；用 api.setState 记住目标，避免来回摇摆。
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
  return new URL('../player/sandbox-worker.js', import.meta.url).href;
}

/**
 * 起一个 Worker 并等它把 decide 绑定好。编译错误 / 没有 decide → reject（带行号）。
 * @returns {Promise<{worker:Worker, url:string}>}
 */
function spawn(code, map, seat, cfg) {
  const src = `importScripts(${JSON.stringify(bridgeUrl())});\n${code}\n;self.__bind(typeof decide === 'function' ? decide : null);\n`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.postMessage({ type: 'init', size: map.size, grid: map.grid.slice().buffer, seat, R: cfg.vision.entityRadius, navBudget: cfg.script.navCallBudget });
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
      const line = e.lineno ? `（第 ${e.lineno - 1} 行）` : '';
      kill(`${e.message || '脚本加载失败'}${line}`);
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

/** 发一次决策并等结果（试运行 / warm-up 用；不计异常）。 */
function callOnce(worker, obs, state, ms) {
  return new Promise((resolve) => {
    const id = -1;
    const timer = setTimeout(() => resolve({ error: `超时（>${ms} ms 未返回）` }), ms);
    const prev = worker.onmessage;
    worker.onmessage = (e) => {
      if (e.data.type !== 'result' || e.data.id !== id) return;
      clearTimeout(timer);
      worker.onmessage = prev;
      resolve(e.data);
    };
    worker.postMessage({ type: 'decide', id, obs, state });
  });
}

/** 试运行（开局设置页）：编译 + 用给定观察调用一次。返回 {ok, dir, logs, ms, error}。 */
export async function testScript({ code, map, seat, cfg, obs }) {
  let w;
  try {
    w = await spawn(code, map, seat, cfg);
  } catch (e) {
    return { ok: false, error: e.message, logs: [] };
  }
  const r = await callOnce(w.worker, obs, null, 1000);
  w.worker.terminate();
  URL.revokeObjectURL(w.url);
  if (r.error) return { ok: false, error: r.error, logs: r.logs ?? [], ms: r.ms };
  const dir = typeof r.dir === 'string' ? r.dir.toUpperCase() : r.dir;
  if (!VALID.has(dir)) return { ok: false, error: `返回值 ${JSON.stringify(r.dir)} 不是 N/E/S/W/STAY`, logs: r.logs, ms: r.ms };
  return { ok: true, dir, logs: r.logs, ms: r.ms, nav: r.nav, denied: r.denied };
}

/**
 * @param {{code:string, map:object, seat:number, cfg:object, seed:number, warmObs:object,
 *          onLog?:(turn:number, lines:string[])=>void, onEvent?:(e:object)=>void}} o
 * @returns {Promise<object>} 控制器（编译失败 reject）
 */
export async function createScriptController({ code, map, seat, cfg, seed, warmObs, onLog = null, onEvent = null }) {
  const S = cfg.script;
  const st = createStream(subSeed(subSeed(seed >>> 0, STREAM.AI), seat));
  const mem = { yieldSeat: -1, yieldLeft: 0 };
  let w = await spawn(code, map, seat, cfg);
  if (S.warmupCall) {
    const wr = await callOnce(w.worker, warmObs, null, 1000);
    if (wr.error && /超时/.test(wr.error)) {
      // warm-up 就卡死了：这个 Worker 已经回不来，换一个新的再开局（第 1 回合照常计时、计异常）
      w.worker.terminate();
      URL.revokeObjectURL(w.url);
      w = await spawn(code, map, seat, cfg);
    }
  }

  let reqId = 0;
  let pendingTurn = -1;
  let reply = null;
  let hangTimer = 0;
  let bag = null;
  let mode = 'script'; // script | auto-home | manual
  const counts = { hard: 0, hardStreak: 0, soft: 0, ok: 0, avgMs: 0, maxMs: 0 };
  const emit = (e) => onEvent && onEvent(e);

  const listen = () => {
    w.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'result' || m.id !== reqId || reply !== null) return;
      clearTimeout(hangTimer);
      reply = m;
      if (!m.error && m.ms > S.decisionTimeoutMs) reply = { ...m, error: `超时（${Math.round(m.ms)} ms > ${S.decisionTimeoutMs} ms）` };
    };
    w.worker.onerror = (e) => {
      e.preventDefault();
      if (reply === null && pendingTurn >= 0) reply = { error: e.message || 'Worker 错误' };
    };
  };
  listen();

  async function respawn() {
    w.worker.terminate();
    URL.revokeObjectURL(w.url);
    try {
      w = await spawn(code, map, seat, cfg);
      listen();
    } catch (e) {
      mode = 'auto-home';
      emit({ type: 'degrade', level: 'L1', reason: `重建 Worker 失败：${e.message}` });
    }
  }

  const ctrl = {
    kind: 'script',
    wantsManual: null,
    get mode() { return mode; },
    get counts() { return { ...counts }; },

    begin(obs, turn) {
      if (mode !== 'script' || pendingTurn === turn) return;
      pendingTurn = turn;
      reply = null;
      const id = ++reqId;
      w.worker.postMessage({ type: 'decide', id, obs, state: bag });
      const t0 = now();
      hangTimer = setTimeout(() => {
        if (reply !== null || reqId !== id) return;
        reply = { error: `卡死（${Math.round(now() - t0)} ms 未返回，已重建 Worker）` };
        respawn();
      }, S.decisionTimeoutMs + HANG_GRACE_MS);
    },

    blocking(turn) {
      return mode === 'script' && pendingTurn === turn && reply === null;
    },

    decide(obs, turn) {
      if (mode === 'auto-home') {
        return { dir: stepToward(map, obs, { type: 'exit', x: obs.self.exit.x, y: obs.self.exit.y }, cfg, st, mem), source: 'auto-home', mode: 'home' };
      }
      if (mode !== 'script') return { dir: STAY, source: 'manual-pending' };
      const r = reply ?? { error: '没有结果' };
      if (r.logs && r.logs.length && onLog) onLog(turn, r.logs);
      if (r.error) {
        counts.hard++;
        counts.hardStreak++;
        emit({ type: 'hard', turn, error: r.error, streak: counts.hardStreak });
        if (counts.hardStreak >= S.l2ConsecutiveHard) {
          mode = 'manual';
          ctrl.wantsManual = `连续 ${S.l2ConsecutiveHard} 次硬异常`;
          emit({ type: 'degrade', level: 'L2', reason: ctrl.wantsManual });
        }
        return { dir: STAY, source: 'script-error', error: r.error };
      }
      counts.hardStreak = 0;
      counts.ok++;
      counts.maxMs = Math.max(counts.maxMs, r.ms || 0);
      counts.avgMs += ((r.ms || 0) - counts.avgMs) / counts.ok;
      let softWhy = null;
      if (r.state !== undefined) {
        let size = 0;
        try {
          size = JSON.stringify(r.state ?? null)?.length ?? 0;
        } catch {
          size = 0;
        }
        if (size > S.stateBagKB * 1024) softWhy = `state 超过 ${S.stateBagKB} KB（${Math.ceil(size / 1024)} KB），已丢弃`;
        else bag = r.state;
      }
      const name = typeof r.dir === 'string' ? r.dir.toUpperCase() : r.dir;
      if (!VALID.has(name)) softWhy = `返回值 ${JSON.stringify(r.dir)} 不是 N/E/S/W/STAY`;
      if (softWhy) {
        counts.soft++;
        emit({ type: 'soft', turn, error: softWhy, total: counts.soft });
        if (counts.soft >= S.l1CumulativeSoft) {
          mode = 'auto-home';
          emit({ type: 'degrade', level: 'L1', reason: `累计 ${S.l1CumulativeSoft} 次软异常，引擎接管自动回家` });
        }
        if (!VALID.has(name)) return { dir: STAY, source: 'script-invalid', error: softWhy };
      }
      return { dir: toDir(name), source: 'script', ms: r.ms };
    },

    status() {
      return { source: mode === 'script' ? 'script' : mode, counts: { ...counts }, mode };
    },

    dispose() {
      clearTimeout(hangTimer);
      w.worker.terminate();
      URL.revokeObjectURL(w.url);
    },
  };
  return ctrl;
}
