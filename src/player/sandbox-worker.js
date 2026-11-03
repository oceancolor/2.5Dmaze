// 脚本运行环境的 Worker 桥（统一编程接口 v2，模块 Worker）。
// 宿主用 Blob 拼出：import { __bind } from '<本文件>'; { <玩家代码> ; __bind({init, decide}) }
// 玩家代码在块作用域、严格模式里运行；所有能力都在 api 里（runtime/core.js），与 Node 评测共用同一份实现。
// 这是「防误伤」边界，不是安全沙箱：CSP 由服务端响应头下发、Worker 继承；脚本拿到的只有公开信息。
// 计时在 Worker 内测（只算 init / decide 本身，不含主线程排队）。

import { createRuntime } from './runtime/core.js';

/** 包装代码在玩家代码前面加的行数（报错行号要减掉）。 */
export const LINE_OFFSET = 2;

let fns = null;
let rt = null;

export function __bind(f) {
  fns = f && typeof f === 'object' ? f : null;
  self.postMessage({ type: 'bound', ok: Boolean(fns && fns.decide) });
}

const clock = () => performance.now();

function post(msg) {
  try {
    self.postMessage(msg);
  } catch (err) {
    self.postMessage({ type: msg.type, id: msg.id, error: `返回值或 state 不可结构化克隆：${err.message}`, logs: msg.logs ?? [], ms: msg.ms ?? 0 });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const map = { size: m.size, grid: new Uint8Array(m.grid), exits: m.exits, spawns: m.spawns };
    rt = createRuntime({ map, seat: m.seat, cfg: m.cfg, seed: m.seed, clock });
    Math.random = rt.random; // 用了 Math.random 也可复现
    if (m.skipInit || !fns) {
      post({ type: 'inited', ok: true, ms: 0, logs: [], skipped: true });
      return;
    }
    post({ type: 'inited', ...rt.callInit(fns, LINE_OFFSET) });
    return;
  }
  if (m.type === 'decide') {
    if (!rt || !fns) {
      post({ type: 'result', id: m.id, error: '运行环境未就绪', logs: [], ms: 0 });
      return;
    }
    post({ type: 'result', id: m.id, ...rt.callDecide(fns, m.obs, m.state, m.budget, LINE_OFFSET) });
  }
};
