// 脚本 agent 的 Worker 桥（SPEC §9.2）。经 importScripts 先于玩家代码加载；玩家代码只需定义 function decide(obs, api)。
// 这是「防误伤」边界，不是安全沙箱：CSP 由服务端响应头下发、Worker 继承；脚本拿到的只有观察 + 公开地形。
// 计时在 Worker 内测（只算 decide 本身，不含主线程排队），超过 cfg.script.decisionTimeoutMs 记一次硬异常。
(function () {
  'use strict';
  const DIRS = ['N', 'E', 'S', 'W'];
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  let G = null; // {size, grid:Uint8Array, seat, R, navBudget}
  let fn = null;
  const cache = new Map();

  function field(t) {
    let f = cache.get(t);
    if (f) return f;
    const N = G.size;
    const g = G.grid;
    f = new Int16Array(N * N).fill(-1);
    const q = new Int32Array(N * N);
    let h = 0;
    let tl = 0;
    f[t] = 0;
    q[tl++] = t;
    while (h < tl) {
      const c = q[h++];
      const x = c % N;
      const y = (c / N) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const k = ny * N + nx;
        if (!g[k] || f[k] >= 0) continue;
        f[k] = f[c] + 1;
        q[tl++] = k;
      }
    }
    if (cache.size >= 64) cache.clear();
    cache.set(t, f);
    return f;
  }

  const fmt = (v) => {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  function errText(err) {
    if (!err) return '未知错误';
    const msg = `${err.name || 'Error'}: ${err.message || err}`;
    const m = /blob:[^\s)]+?:(\d+):(\d+)/.exec(String(err.stack || ''));
    return m ? `${msg}（第 ${Number(m[1]) - 1} 行）` : msg;
  }

  self.__bind = function (f) {
    fn = typeof f === 'function' ? f : null;
    self.postMessage({ type: 'bound', ok: Boolean(fn) });
  };

  self.onmessage = function (e) {
    const m = e.data;
    if (m.type === 'init') {
      G = { size: m.size, grid: new Uint8Array(m.grid), seat: m.seat, R: m.R, navBudget: m.navBudget };
      cache.clear();
      return;
    }
    if (m.type !== 'decide' || !G) return;
    const obs = m.obs;
    let bag = m.state === undefined ? null : m.state;
    obs.state = bag;
    const logs = [];
    let nav = 0;
    let denied = 0;
    const N = G.size;
    const me = obs.self;
    const allowed = new Set();
    const add = (p) => {
      if (p && Number.isInteger(p.x) && Number.isInteger(p.y)) allowed.add(p.y * N + p.x);
    };
    add(me.exit);
    obs.gems.forEach(add);
    if (obs.chest.present) add(obs.chest);
    for (const o of obs.actors) {
      if (o.visible) add(o);
      else if (o.lastSeen) add(o.lastSeen);
    }
    const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < N && y < N;
    // 公开目标（宝物 / 自己出口 / 视野内或记忆中的对手）或视野半径内的格子
    const okTarget = (x, y) => inside(x, y) && (allowed.has(y * N + x) || Math.max(Math.abs(x - me.x), Math.abs(y - me.y)) <= G.R);
    const query = (x, y) => {
      nav++;
      if (nav > G.navBudget || !okTarget(x, y)) {
        denied++;
        return null;
      }
      return field(y * N + x);
    };
    const api = Object.freeze({
      size: N,
      isFloor: (x, y) => inside(x, y) && G.grid[y * N + x] === 1,
      /** (fromX,fromY) → (x,y) 的最短步数，默认从自己出发；越权 / 超预算 / 不可达返回 −1。 */
      distance(x, y, fromX = me.x, fromY = me.y) {
        const f = query(x, y);
        return f && inside(fromX, fromY) ? f[fromY * N + fromX] : -1;
      },
      /** 朝 (x,y) 的最短路下一步：'N'|'E'|'S'|'W'，已在目标上 'STAY'；越权 / 超预算 / 不可达返回 −1。 */
      shortestStep(x, y) {
        const f = query(x, y);
        if (!f) return -1;
        const cur = f[me.y * N + me.x];
        if (cur < 0) return -1;
        if (cur === 0) return 'STAY';
        for (let d = 0; d < 4; d++) {
          const nx = me.x + DX[d];
          const ny = me.y + DY[d];
          if (inside(nx, ny) && f[ny * N + nx] === cur - 1) return DIRS[d];
        }
        return -1;
      },
      setState(v) {
        bag = v;
      },
      log(...a) {
        if (logs.length < 20) logs.push(a.map(fmt).join(' ').slice(0, 200));
      },
      get navLeft() {
        return Math.max(0, G.navBudget - nav);
      },
    });
    const t0 = performance.now();
    const finish = (dir) => {
      const ms = performance.now() - t0;
      try {
        self.postMessage({ type: 'result', id: m.id, dir, state: bag, logs, nav, denied, ms });
      } catch (err) {
        self.postMessage({ type: 'result', id: m.id, error: `返回值或 state 不可结构化克隆：${err.message}`, logs, nav, denied, ms });
      }
    };
    const failWith = (err) => self.postMessage({ type: 'result', id: m.id, error: errText(err), logs, nav, denied, ms: performance.now() - t0 });
    if (!fn) {
      failWith(new Error('没有找到 decide(obs, api) 函数'));
      return;
    }
    let r;
    try {
      r = fn(obs, api);
    } catch (err) {
      failWith(err);
      return;
    }
    if (r && typeof r.then === 'function') r.then(finish, failWith);
    else finish(r);
  };
})();
