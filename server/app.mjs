// 游戏服务器请求处理（与监听分开，测试可直接起在随机端口上）。
//   /healthz                 健康检查（客户端据 api:true 判断能否同步）
//   /api/v1/guest            POST 游客账号
//   /api/v1/me               GET  当前用户
//   /api/v1/matches[...]     对局上传 / 战绩 / 详情 / 记录下载
//   /api/v1/providers        服务商预设（M1）
//   /api/v1/keys[...]        玩家自己的 key：保存 / 列出 / 删除 / 测试连接（M1）
//   /api/v1/usage            用量（M1）
//   /llm/v1/chat             大模型中转：附上本人 key 调用服务商（M1，谁用谁付）
//   其他                     开发模式下托管游戏静态文件；生产由反向代理直接给静态文件也行

import { HttpError, clientIp, createLimiter, selfOrigin, sendError, sendJson } from './http.mjs';
import { createGuest, getMe } from './api/accounts.mjs';
import { getMatch, getRecord, listMatches, uploadMatch } from './api/matches.mjs';
import { createKey, deleteKey, getProviders, getUsage, listKeys, relayChat, testKey } from './api/llm.mjs';
import { createVault } from './vault.mjs';
import { RULES_VERSION } from './verifier.mjs';
import { createStaticHandler } from './static.mjs';
import { CLIENT_VERSION } from '../src/app/version.js';
import { SCHEMA_VERSION } from './store/db.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Maze-Client',
  'Access-Control-Max-Age': '600',
};

/**
 * @param {{store:object, root?:string|null, now?:()=>number, upstream?:Function,
 *          options?:{allowedOrigins?:string[], trustProxy?:boolean, minClientVersion?:string, staticCache?:string, masterKey?:Buffer|null,
 *                    limits?:{ipPerMinute?:number, guestPerMinute?:number, guestBurst?:number, uploadPerMinute?:number,
 *                             keysPerMinute?:number, testPerMinute?:number, relayPerMinute?:number, relayBurst?:number}}}} o
 *   upstream：测试替身，替换真正的 HTTPS 上游调用（见 llm-relay.mjs httpsUpstream）
 */
export function createApp({ store, root = null, now = Date.now, upstream = undefined, options = {} }) {
  const opt = {
    allowedOrigins: [],
    trustProxy: false,
    minClientVersion: CLIENT_VERSION,
    staticCache: 'no-store',
    masterKey: null,
    ...options,
    limits: {
      ipPerMinute: 240, guestPerMinute: 2, guestBurst: 10, uploadPerMinute: 30,
      keysPerMinute: 10, testPerMinute: 6, relayPerMinute: 180, relayBurst: 60,
      ...(options.limits || {}),
    },
  };
  const L = opt.limits;
  const limiters = {
    ip: createLimiter({ capacity: L.ipPerMinute, perMinute: L.ipPerMinute, now }),
    guest: createLimiter({ capacity: L.guestBurst, perMinute: L.guestPerMinute, now }),
    upload: createLimiter({ capacity: L.uploadPerMinute, perMinute: L.uploadPerMinute, now }),
    keys: createLimiter({ capacity: L.keysPerMinute, perMinute: L.keysPerMinute, now }),
    test: createLimiter({ capacity: L.testPerMinute, perMinute: L.testPerMinute, now }),
    relay: createLimiter({ capacity: L.relayBurst, perMinute: L.relayPerMinute, now }),
  };
  const vault = createVault({ store, masterKey: opt.masterKey, now });
  const matchCalls = new Map();
  const serveStatic = root ? createStaticHandler(root, { cache: opt.staticCache }) : null;
  const allowed = new Set(opt.allowedOrigins);

  /** 有 Origin 头（浏览器跨源 / 同源 POST）时：同源或白名单才放行；无 Origin（Agent、curl）不受限。 */
  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (origin === selfOrigin(req, opt.trustProxy)) return {};
    if (allowed.has(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    throw new HttpError(403, 'origin_not_allowed', `来源 ${origin} 不在白名单内`);
  }

  async function api(req, res, url, ctx) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/v1/guest') {
      if (m !== 'POST') throw new HttpError(405, 'method_not_allowed', '只支持 POST');
      limiters.guest.take(ctx.ip);
      return createGuest(req, res, ctx);
    }
    if (p === '/api/v1/me') {
      if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', '只支持 GET');
      return getMe(req, res, ctx);
    }
    if (p === '/api/v1/matches') {
      if (m === 'POST') return uploadMatch(req, res, ctx);
      if (m === 'GET') return listMatches(req, res, ctx);
      throw new HttpError(405, 'method_not_allowed', '只支持 GET / POST');
    }
    const mm = /^\/api\/v1\/matches\/([^/]+)(\/record)?$/.exec(p);
    if (mm) {
      if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', '只支持 GET');
      return mm[2] ? getRecord(req, res, ctx, mm[1]) : getMatch(req, res, ctx, mm[1]);
    }
    if (p === '/api/v1/providers') {
      if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', '只支持 GET');
      return getProviders(req, res, ctx);
    }
    if (p === '/api/v1/keys') {
      if (m === 'POST') return createKey(req, res, ctx);
      if (m === 'GET') return listKeys(req, res, ctx);
      throw new HttpError(405, 'method_not_allowed', '只支持 GET / POST');
    }
    const mk = /^\/api\/v1\/keys\/([^/]+)(\/test)?$/.exec(p);
    if (mk) {
      if (mk[2]) {
        if (m !== 'POST') throw new HttpError(405, 'method_not_allowed', '只支持 POST');
        return testKey(req, res, ctx, mk[1]);
      }
      if (m !== 'DELETE') throw new HttpError(405, 'method_not_allowed', '只支持 DELETE');
      return deleteKey(req, res, ctx, mk[1]);
    }
    if (p === '/api/v1/usage') {
      if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', '只支持 GET');
      return getUsage(req, res, ctx);
    }
    if (p === '/llm/v1/chat') {
      if (m !== 'POST') throw new HttpError(405, 'method_not_allowed', '只支持 POST');
      return relayChat(req, res, ctx);
    }
    throw new HttpError(404, 'not_found', `没有这个接口：${m} ${p}`);
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const p = url.pathname;
    try {
      if (p === '/healthz') {
        // 公开接口：白名单来源（如桌面端 app://maze）带上 CORS 头，其余来源照常回复但浏览器读不到
        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        sendJson(res, 200, { ok: true, api: true, version: CLIENT_VERSION, rulesVersion: RULES_VERSION, schema: SCHEMA_VERSION });
        return;
      }
      if (p.startsWith('/api/') || p.startsWith('/llm/')) {
        const extra = corsHeaders(req);
        for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS);
          res.end();
          return;
        }
        const ip = clientIp(req, opt.trustProxy);
        limiters.ip.take(ip);
        await api(req, res, url, { store, now, opt, limiters, url, ip, vault, matchCalls, upstream });
        return;
      }
      if (serveStatic && (await serveStatic(req, res, p))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(`[server] ${req.method} ${p}`, e);
      if (!res.headersSent) sendError(res, e);
      else res.end();
    }
  };
}
