// Node 端的脚本控制器（本机评测 maze-eval / 测试用）：脚本在 node:vm 上下文里同步执行，与浏览器 Worker 共用
// runtime/core.js（api、ctx、规范化）与 runtime/control.js（预算、兜底、降级），保证本机评测 = 游戏里的结果。
//   mode 'measure'（默认）：不打断、不作废，只记「按正式预算会超时」的回合 → 同一脚本 + 种子结果可复现
//   mode 'enforce'：与实时对局相同（超支当回合作废、走兜底）
// vm 只是隔离全局变量，不是安全沙箱（评测的是你自己的脚本）；hangMs 只防死循环。

import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { BIND_EXPR, createRuntime, errText, prepareScript } from './runtime/core.js';
import { createGovernor } from './runtime/control.js';

const LINE_OFFSET = 2; // "use strict" 行 + 块开头
const MARKER = /maze-script:(\d+):(\d+)/;
const clock = () => performance.now();

/** 编译脚本，返回 {fns, context}；语法错误 / 顶层抛错 / 没有 decide → throw。 */
export function compileScript(code, { hangMs = 10000, logs = null } = {}) {
  const p = prepareScript(code);
  if (!p.ok) throw new Error(p.error);
  const sink = (...a) => {
    if (logs && logs.length < 20) logs.push(a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').slice(0, 200));
  };
  const context = vm.createContext({ console: { log: sink, info: sink, warn: sink, error: sink } });
  let fns;
  try {
    new vm.Script(`"use strict";\n{\n${p.code}\n;globalThis.__fns = ${BIND_EXPR};\n}`, { filename: 'maze-script' })
      .runInContext(context, { timeout: hangMs });
    fns = context.__fns;
  } catch (e) {
    throw new Error(errText(e, LINE_OFFSET, MARKER));
  }
  if (!fns || !fns.decide) throw new Error('没有找到 decide(obs, api) 函数');
  return { fns, context };
}

/**
 * 在 vm 上下文里调用（timeout 防死循环）。函数在上下文内求值，所以 timeout 生效。
 */
function callIn(context, name, args, hangMs) {
  context.__call = args;
  try {
    return vm.runInContext(`__fns.${name}(...__call)`, context, { timeout: hangMs });
  } finally {
    context.__call = null;
  }
}

/**
 * @param {{code:string, map:object, seat:number, cfg:object, seed:number, mode?:'measure'|'enforce', isPlayer?:boolean,
 *          hangMs?:number, onEvent?:(e:object)=>void, onLog?:(turn:number, lines:string[])=>void}} o
 */
export function createNodeScriptController({ code, map, seat, cfg, seed, mode = 'measure', isPlayer = false, hangMs = 10000, onEvent = null, onLog = null }) {
  const gov = createGovernor({ map, seat, cfg, seed, mode, isPlayer, onEvent });
  let compiled = compileScript(code, { hangMs });
  let rt = null;
  let fnsProxy = null;

  function wire() {
    rt = createRuntime({ map, seat, cfg, seed, clock });
    vm.runInContext('Math', compiled.context).random = rt.random; // 与浏览器一致：Math.random 也来自本座位的脚本流
    // 让 runtime 通过 vm 调用（timeout 对上下文内函数生效）
    fnsProxy = {
      init: compiled.fns.init ? (ctx, api) => callIn(compiled.context, 'init', [ctx, api], hangMs) : null,
      decide: (obs, api) => callIn(compiled.context, 'decide', [obs, api], hangMs),
    };
  }

  function boot(skipInit = false) {
    wire();
    if (skipInit) return { ok: true, ms: 0, logs: [], skipped: 'init 卡死，已跳过 init 开局' };
    const r = rt.callInit(fnsProxy, LINE_OFFSET);
    if (r.error && /Script execution timed out/.test(r.error)) {
      compiled = compileScript(code, { hangMs });
      return boot(true);
    }
    return r;
  }
  const init = boot();
  gov.noteInit(init);
  if (init.logs && init.logs.length && onLog) onLog(0, init.logs);

  let pendingTurn = -1;
  let reply = null;

  return {
    kind: 'script',
    get wantsManual() { return gov.wantsManual; },
    get mode() { return gov.level; },

    begin(obs, turn) {
      if (gov.level !== 'script' || pendingTurn === turn) return;
      pendingTurn = turn;
      const o = structuredClone(obs);
      reply = rt.callDecide(fnsProxy, o, gov.bag, gov.budget(), LINE_OFFSET);
      if (reply.error && /Script execution timed out/.test(reply.error)) {
        const why = `卡死（${hangMs} ms 未返回，已重建运行环境，模块变量丢失）`;
        reply = { error: why };
        gov.noteReset(turn, why);
        compiled = compileScript(code, { hangMs });
        boot();
      }
    },

    blocking() {
      return false;
    },

    decide(obs, turn) {
      if (pendingTurn !== turn) this.begin(obs, turn);
      const r = gov.level === 'script' ? reply : null;
      if (r && r.logs && r.logs.length && onLog) onLog(turn, r.logs);
      return gov.settle(turn, obs, r);
    },

    status() {
      return { ...gov.status(), timing: gov.timing() };
    },

    report() {
      return { ...gov.status().counts, timing: gov.timing(), samples: gov.samples() };
    },

    dispose() {},
  };
}
