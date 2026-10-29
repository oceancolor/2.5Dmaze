// 对局同步（06 §3.1 / §5 / §11）：游客账号 + 上传队列（离线补传）+ 我的战绩。
// 页面由游戏服务器托管时 /healthz 返回 api:true 才同步；静态预览（tools/serve.mjs）返回 api:false，静默跳过。
// 令牌存 localStorage（游客身份 = 这台设备 / 这个浏览器）；令牌失效（401）时重新领一个游客身份再试一次。
// 桌面端（Electron，06 §8.2）：页面加载在 app://maze/ 下，接口请求要带游戏服务器的绝对地址（window.mazeDesktop.serverOrigin）；
//   Web / H5 版页面与接口同源，用相对路径即可。服务器已把 app://maze 加进 CORS 白名单。

import { CLIENT_VERSION } from './version.js';
import { outboxAll, outboxDelete, outboxPut } from './storage.js';

const AUTH_KEY = 'maze.auth.v1';

/** 桌面端页面的接口根地址；Web / H5 为空串（同源相对路径）。 */
const API_BASE = (() => {
  const d = globalThis.mazeDesktop;
  return d && d.serverOrigin ? String(d.serverOrigin).replace(/\/+$/, '') : '';
})();
const apiUrl = (path) => API_BASE + path;

export function detectPlatform() {
  if (globalThis.mazeDesktop) return 'desktop';
  const coarse = globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches;
  return coarse ? 'h5' : 'web';
}

/** 客户端生成的对局 ID：128 bit 随机（getRandomValues 在非安全上下文也可用，H5 局域网调试不受限）。 */
export function newMatchId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function loadAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY));
    return a && typeof a.token === 'string' ? a : null;
  } catch {
    return null;
  }
}

function saveAuth(a) {
  try {
    if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* 隐私模式：只在内存里 */
  }
}

/**
 * @param {{onStatus?:(matchId:string, st:object)=>void}} [o]
 *   st.state：queued | uploading | done | offline | retry | rejected | local
 */
export function createSync({ onStatus } = {}) {
  const client = `${detectPlatform()}/${CLIENT_VERSION}`;
  let api = null;
  let auth = loadAuth();
  let flushing = null;
  const statuses = new Map();

  const set = (id, st) => {
    statuses.set(id, st);
    if (onStatus) onStatus(id, st);
  };

  async function available() {
    if (api !== null) return api;
    try {
      const r = await fetch(apiUrl('/healthz'), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      api = Boolean(j && j.api);
    } catch {
      api = null;
      return false;
    }
    return api;
  }

  async function ensureAuth() {
    if (auth) return auth;
    const r = await fetch(apiUrl('/api/v1/guest'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Maze-Client': client }, body: '{}' });
    if (!r.ok) throw Object.assign(new Error(`guest ${r.status}`), { status: r.status });
    const j = await r.json();
    auth = { userId: j.userId, token: j.token };
    saveAuth(auth);
    return auth;
  }

  /** 带令牌的请求；401 时换一个游客身份重试一次。网络错误直接抛出。 */
  async function request(method, path, body, { signal } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = await ensureAuth();
      const headers = { Authorization: `Bearer ${a.token}`, 'X-Maze-Client': client };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(apiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      if (r.status === 401 && attempt === 0) {
        auth = null;
        saveAuth(null);
        continue;
      }
      let json = null;
      try { json = await r.json(); } catch { /* 非 JSON */ }
      return { status: r.status, json };
    }
    return { status: 401, json: null };
  }

  async function flushOnce() {
    if (!(await available())) {
      if (api === null) for (const it of await outboxAll()) set(it.matchId, { state: 'offline' });
      return;
    }
    for (const it of await outboxAll()) {
      set(it.matchId, { state: 'uploading' });
      let r;
      try {
        const body = { matchId: it.matchId, record: it.record, startedAt: it.startedAt, endedAt: it.endedAt };
        if (it.strategy) body.strategy = it.strategy;
        r = await request('POST', '/api/v1/matches', body);
      } catch {
        set(it.matchId, { state: 'offline' });
        api = null;
        return;
      }
      if (r.status === 200 || r.status === 201) {
        await outboxDelete(it.matchId);
        set(it.matchId, { state: 'done', verify: r.json.verify, verifyTurn: r.json.verifyTurn, note: r.json.verifyNote });
      } else if (r.status === 429 || r.status >= 500) {
        set(it.matchId, { state: 'retry', error: (r.json && r.json.message) || `HTTP ${r.status}` });
        return;
      } else {
        // 400 / 409 / 413 / 422 / 426：重传也不会成功，移出队列
        await outboxDelete(it.matchId);
        set(it.matchId, { state: 'rejected', error: (r.json && r.json.message) || `HTTP ${r.status}`, code: r.json && r.json.error });
      }
    }
  }

  function flush() {
    if (!flushing) flushing = flushOnce().catch(() => {}).finally(() => { flushing = null; });
    return flushing;
  }

  if (globalThis.addEventListener) {
    globalThis.addEventListener('online', () => {
      api = null;
      flush();
    });
  }

  return {
    client,
    status: (id) => statuses.get(id) ?? null,
    /** 对局结束：入队并尝试上传。strategy：玩家思路（只进服务器私有表，仅本人可见；API key 绝不经过这里）。 */
    async submit({ matchId, record, startedAt, endedAt, strategy = null }) {
      if (api === false) {
        set(matchId, { state: 'local' });
        return statuses.get(matchId);
      }
      await outboxPut({ matchId, record, startedAt, endedAt, strategy });
      set(matchId, { state: 'queued' });
      await flush();
      if (api === false) {
        await outboxDelete(matchId);
        set(matchId, { state: 'local' });
      }
      return statuses.get(matchId);
    },
    flush,
    /**
     * 通用的带令牌请求（key 管理、测试连接、中转、用量）。
     * @returns {Promise<{status:number, json:object|null, reason?:'static'|'offline'|'abort'}>} 没有服务器 / 网络不通时 status = 0
     */
    async call(method, path, body, { signal } = {}) {
      if (!(await available())) return { status: 0, json: null, reason: api === false ? 'static' : 'offline' };
      try {
        return await request(method, path, body, { signal });
      } catch (e) {
        if (e && e.name === 'AbortError') return { status: 0, json: null, reason: 'abort' };
        return { status: 0, json: null, reason: 'offline' };
      }
    },
    /** 有服务器时返回 {ok:true, items, total}；没有服务器 / 离线返回 {ok:false, reason}。 */
    async listMine(limit = 10) {
      if (!(await available())) return { ok: false, reason: api === false ? 'static' : 'offline' };
      if (!auth) return { ok: true, items: [], total: 0 };
      try {
        const r = await request('GET', `/api/v1/matches?limit=${limit}`);
        if (r.status !== 200) return { ok: false, reason: (r.json && r.json.message) || `HTTP ${r.status}` };
        return { ok: true, items: r.json.items, total: r.json.total };
      } catch {
        return { ok: false, reason: 'offline' };
      }
    },
    async serverAvailable() {
      return available();
    },
  };
}

/** 状态 → 给人看的一句话。 */
export function syncText(st) {
  if (!st) return '';
  switch (st.state) {
    case 'queued':
    case 'uploading': return '记录上传中…';
    case 'done':
      if (st.verify === 'verified') return '记录已上传 · 服务器严格回放校验通过';
      if (st.verify === 'mismatch') return `记录已上传 · 服务器校验不一致${st.verifyTurn ? `（第 ${st.verifyTurn} 回合）` : ''}：${st.note || ''}`;
      return `记录已上传 · ${st.note || '服务器无法校验'}`;
    case 'offline': return '离线：记录已存本机，联网后自动补传';
    case 'retry': return `服务器暂时不可用（${st.error}），稍后自动补传`;
    case 'rejected': return `记录被服务器拒收：${st.error}`;
    case 'local': return '未连接游戏服务器（静态预览），记录只存本机';
    default: return '';
  }
}
