// 浏览器「整局试跑」的主线程端：把各座位脚本拼进一个模块 Worker（每个脚本一个工厂函数），发起评测，回传进度与结果。
// 与 maze-eval 命令行同一个评测引擎（run-eval.js）、同一套运行时，结果一致。

import { BIND_EXPR, prepareScript } from '../runtime/core.js';

const workerUrl = () => new URL('./eval-worker.js', import.meta.url).href;

/**
 * @param {{size:string, seeds:string|Array, seats:object[], baseline?:boolean, worst?:number,
 *          onProgress?:(done:number, total:number)=>void, timeoutMs?:number}} o
 *   seats：{kind:'script', code, name?, author?, origin?} | {kind:'heuristic'} | {kind:'mock', persona}
 * @returns {Promise<{result:object, markdown:string}>}
 */
export function runEvalInWorker({ size, seeds, seats, baseline = true, worst = 5, onProgress = null, timeoutMs = 180000 }) {
  const parts = [`import { __reg, __ready } from ${JSON.stringify(workerUrl())};`];
  const specs = [];
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (s.kind !== 'script') {
      specs.push(s);
      continue;
    }
    const p = prepareScript(s.code);
    if (!p.ok) return Promise.reject(new Error(`座位 ${i}：${p.error}`));
    const offset = parts.join('\n').split('\n').length + 1; // 工厂开头那一行之后才是脚本第 1 行
    parts.push(`__reg(${i}, () => {\n${p.code}\n;return ${BIND_EXPR};\n}, ${offset});`);
    specs.push({ ...s, slot: i });
  }
  parts.push('__ready();');
  const url = URL.createObjectURL(new Blob([parts.join('\n')], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      w.terminate();
      URL.revokeObjectURL(url);
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error(`试跑超过 ${Math.round(timeoutMs / 1000)} 秒，已停止（脚本可能有死循环）`)), timeoutMs);
    w.onerror = (e) => {
      e.preventDefault();
      done(reject, new Error(`${e.message || '脚本加载失败（多半是语法错误）'}`));
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') w.postMessage({ type: 'run', size, seeds, seats: specs, baseline, worst });
      else if (m.type === 'progress' && onProgress) onProgress(m.done, m.total);
      else if (m.type === 'done') done(resolve, { result: m.result, markdown: m.markdown });
      else if (m.type === 'error') done(reject, new Error(m.error));
    };
  });
}
