// 浏览器「整局试跑」的 Worker 端（模块 Worker）。宿主（eval-client.js）用 Blob 拼出：
//   import { __reg, __ready } from '<本文件>';
//   __reg(0, () => { <脚本代码> ; return { init, decide }; });   // 每个脚本一个工厂：每局调用一次，模块变量每局重新开始
//   __ready();
// 然后发 {type:'run', ...}。脚本在本 Worker 里同步执行（不经 postMessage 往返），预算按 measure 统计，结果与 maze-eval 一致。

import { runEval, renderMarkdown } from './run-eval.js';
import { createRuntime } from '../runtime/core.js';
import { createGovernor } from '../runtime/control.js';

const factories = new Map();
const offsets = new Map();
const clock = () => performance.now();

export function __reg(slot, factory, lineOffset = 0) {
  factories.set(slot, factory);
  offsets.set(slot, lineOffset);
}

export function __ready() {
  self.postMessage({ type: 'ready' });
}

function makeSync({ spec, seat, match, cfg }) {
  const factory = factories.get(spec.slot);
  if (!factory) throw new Error(`座位 ${seat} 的脚本没有加载`);
  const off = offsets.get(spec.slot) || 0;
  const { map } = match;
  const rt = createRuntime({ map, seat, cfg, seed: match.seed, clock });
  const gov = createGovernor({ map, seat, cfg, seed: match.seed, mode: 'measure', isPlayer: false });
  const realRandom = Math.random;
  const withRandom = (fn) => {
    Math.random = rt.random; // 多个脚本座位共用一个 Worker：调用期间换成本座位的流
    try {
      return fn();
    } finally {
      Math.random = realRandom;
    }
  };
  let fns;
  try {
    fns = withRandom(() => factory());
  } catch (e) {
    throw new Error(`座位 ${seat} 的脚本顶层代码出错：${e.message}`);
  }
  if (!fns || !fns.decide) throw new Error(`座位 ${seat} 的脚本没有 decide(obs, api)`);
  gov.noteInit(withRandom(() => rt.callInit(fns, off)));
  let pending = -1;
  let reply = null;
  return {
    kind: 'script',
    begin(obs, turn) {
      if (gov.level !== 'script' || pending === turn) return;
      pending = turn;
      reply = withRandom(() => rt.callDecide(fns, structuredClone(obs), gov.bag, gov.budget(), off));
    },
    blocking: () => false,
    decide(obs, turn) {
      if (pending !== turn) this.begin(obs, turn);
      return gov.settle(turn, obs, gov.level === 'script' ? reply : null);
    },
    report: () => ({ ...gov.status().counts, timing: gov.timing(), samples: gov.samples() }),
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'run') return;
  try {
    let lastPost = 0;
    const result = runEval({
      size: m.size, vision: m.vision, seeds: m.seeds, seats: m.seats, baseline: m.baseline !== false, worst: m.worst ?? 5, makeScript: makeSync,
      onProgress: (done, total) => {
        const t = clock();
        if (t - lastPost > 100 || done === total) {
          lastPost = t;
          self.postMessage({ type: 'progress', done, total });
        }
      },
    });
    self.postMessage({ type: 'done', result, markdown: renderMarkdown(result) });
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message || String(err) });
  }
};
