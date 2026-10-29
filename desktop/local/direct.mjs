// 本机直连（06 §8.2）：主进程附上本机保存的 key，直接调用服务商；网页只发消息、收文本，拿不到 key。
// 地址规则同服务器（06 §7.3：https + 443 + 公网，每次连接按 DNS 结果再查一次），
// 另外放行本机模型 http://127.0.0.1:* / localhost:*（Ollama、LM Studio 等）。
// 用量记在本机（userData/usage.json）；服务器不经手这些调用，上传时只能标为「自报」。
// 不依赖 electron，可在 Node 里测试。

import { request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROVIDERS, checkBaseUrl, extraBody } from '../../server/providers.mjs';
import { chatCompletion, httpsUpstream } from '../../server/llm-relay.mjs';
import { LOCAL_KEY_ID } from './vault.mjs';

export const LOCAL_PROVIDERS = Object.freeze({
  ...PROVIDERS,
  ollama: Object.freeze({
    label: '本机模型（Ollama）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', verified: false, local: true,
    note: '不需要 key；先在本机运行 Ollama 并拉好模型（ollama pull 模型名）',
  }),
  custom: Object.freeze({ ...PROVIDERS.custom, note: '允许 https:// 公网地址，或本机 http://127.0.0.1:端口（LM Studio 等）' }),
});

export const providerLabel = (id) => (LOCAL_PROVIDERS[id] ? LOCAL_PROVIDERS[id].label : id);

export function localProviderList() {
  return Object.entries(LOCAL_PROVIDERS).map(([id, p]) => ({
    id, label: p.label, baseUrl: p.baseUrl, model: p.model, verified: p.verified, note: p.note ?? '', local: Boolean(p.local),
  }));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** 校验本机直连的地址：https 公网（同服务器规则），或 http 本机回环。返回规范化的 base（无结尾斜杠）。 */
export function checkLocalBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('地址格式不对');
  }
  if (u.protocol === 'http:') {
    if (!LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('http:// 只允许本机地址（127.0.0.1 / localhost）');
    if (u.username || u.password) throw new Error('地址里不能带账号密码');
    if (u.search || u.hash) throw new Error('地址里不能带查询串');
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  return checkBaseUrl(raw);
}

/** 本机模型的上游：只连回环地址（localhost 固定解析到 127.0.0.1，不查 DNS）。 */
export function loopbackUpstream({ url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'http:' || !LOOPBACK.has(host)) {
      reject(Object.assign(new Error(`拒绝连接非本机地址 ${host}`), { code: 'ESSRF' }));
      return;
    }
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = httpRequest({
      hostname: host === 'localhost' ? '127.0.0.1' : host,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(Object.assign(new Error('回复过大'), { code: 'ETOOBIG' }));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('超时'), { code: 'EUPSTREAMTIMEOUT' })), timeoutMs);
    req.on('error', (e) => finish(reject, e));
    req.end(body);
  });
}

const MODEL = /^[\w.:/@-]{1,80}$/;
const API_KEY = /^[\x21-\x7e]{8,400}$/;
const ROLES = new Set(['system', 'user', 'assistant']);
const KINDS = new Set(['plan', 'repair', 'test']);
const MAX_CHARS = 32000;
const MAX_TOKENS = { normal: 400, reasoning: 4000 };
const TIMEOUT = { min: 5000, normal: 40000, max: 90000 };

const fail = (error, message) => ({ ok: false, error, message });
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);

/**
 * @param {{vault:object, ledgerFile:string, now:()=>number, upstreams?:{https?:Function, loopback?:Function}}} o
 */
export function createDirect({ vault, ledgerFile, now, upstreams = {} }) {
  const up = { https: upstreams.https ?? httpsUpstream, loopback: upstreams.loopback ?? loopbackUpstream };
  let ledger = null;

  function loadLedger() {
    if (ledger) return ledger;
    try {
      ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
      if (!ledger || typeof ledger.months !== 'object') throw new Error('bad');
    } catch {
      ledger = { v: 1, months: {} };
    }
    return ledger;
  }

  function note(r) {
    const L = loadLedger();
    const m = monthOf(now());
    const x = L.months[m] ?? (L.months[m] = { calls: 0, failed: 0, in: 0, out: 0 });
    x.calls++;
    if (r.ok) {
      x.in += r.usage.in;
      x.out += r.usage.out;
    } else x.failed++;
    try {
      mkdirSync(dirname(ledgerFile), { recursive: true });
      writeFileSync(`${ledgerFile}.tmp`, JSON.stringify(L));
      renameSync(`${ledgerFile}.tmp`, ledgerFile);
    } catch {
      /* 记账失败不影响对局 */
    }
  }

  return {
    /** 保存 key：校验同服务器（本机模型 / 本机地址可以不填 key）。返回 {ok:true, key} 或 {ok:false, error, message}。 */
    addKey(spec) {
      const b = spec && typeof spec === 'object' ? spec : {};
      const p = LOCAL_PROVIDERS[b.provider];
      if (!p) return fail('bad_provider', `不支持的服务商：${String(b.provider).slice(0, 32)}`);
      let baseUrl = p.baseUrl;
      if (b.provider === 'custom') {
        try {
          baseUrl = checkLocalBaseUrl(b.baseUrl);
        } catch (e) {
          return fail('bad_base_url', `地址不可用：${e.message}`);
        }
      }
      const model = String(b.model ?? '').trim() || p.model;
      if (!MODEL.test(model)) return fail('bad_model', '模型名 1–80 字符，只能是字母、数字和 . _ : / @ -');
      const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
      const local = baseUrl.startsWith('http://');
      if (!(local && !apiKey) && !API_KEY.test(apiKey)) return fail('bad_api_key', 'API key 应为 8–400 个可见 ASCII 字符');
      try {
        return { ok: true, key: vault.add({ provider: b.provider, baseUrl, model, apiKey, reasoning: Boolean(b.reasoning), remember: Boolean(b.remember) }) };
      } catch (e) {
        if (e.message === 'remember_unavailable') return fail('remember_unavailable', '这台电脑的系统加密不可用（Linux 需要系统密钥环），只能「仅本次运行」');
        if (e.message === 'too_many_keys') return fail('too_many_keys', '最多保存 10 个 key，请先删除不用的');
        throw e;
      }
    },

    /** 一次调用。返回 {ok:true, text, usage, model, ms, finish} 或 {ok:false, kind, message, ms?}（kind 同 llm-relay：auth / rate / 5xx / bad / timeout / unreachable / blocked / missing）。 */
    async chat(req) {
      const b = req && typeof req === 'object' ? req : {};
      if (typeof b.keyId !== 'string' || !LOCAL_KEY_ID.test(b.keyId)) return { ok: false, kind: 'missing', message: '没有这个 key' };
      const k = vault.get(b.keyId);
      if (!k) return { ok: false, kind: 'missing', message: '没有这个 key（可能已删除，或「仅本次运行」的 key 在重启后已丢弃）' };
      const msgs = b.messages;
      if (!Array.isArray(msgs) || !msgs.length || msgs.length > 4) return { ok: false, kind: 'bad', message: 'messages 应为 1–4 条' };
      let chars = 0;
      for (const x of msgs) {
        if (!x || !ROLES.has(x.role) || typeof x.content !== 'string') return { ok: false, kind: 'bad', message: 'messages 每条须为 {role, content}' };
        chars += x.content.length;
      }
      if (chars > MAX_CHARS) return { ok: false, kind: 'bad', message: `messages 合计超过 ${MAX_CHARS} 字符` };
      const kind = KINDS.has(b.kind) ? b.kind : 'plan';
      const maxTokens = Math.min(Number.isInteger(b.max_tokens) && b.max_tokens > 0 ? b.max_tokens : 200, k.reasoning ? MAX_TOKENS.reasoning : MAX_TOKENS.normal);
      const temperature = Number.isFinite(b.temperature) ? Math.min(1, Math.max(0, b.temperature)) : 0;
      const timeoutMs = Number.isFinite(b.timeoutMs) ? Math.min(TIMEOUT.max, Math.max(TIMEOUT.min, b.timeoutMs)) : TIMEOUT.normal;
      const r = await chatCompletion({
        base: k.baseUrl, model: k.model, apiKey: k.apiKey, messages: msgs, maxTokens, temperature,
        extra: extraBody(k.provider, k.reasoning), timeoutMs,
        upstream: k.baseUrl.startsWith('http://') ? up.loopback : up.https,
        now,
      });
      note(r);
      if (r.ok) vault.touch(k.id);
      return r;
    },

    /** 本月 / 累计（本机统计）。形状同服务器 GET /api/v1/usage，设置页共用一套显示。 */
    usage() {
      const L = loadLedger();
      const m = L.months[monthOf(now())] ?? { calls: 0, failed: 0, in: 0, out: 0 };
      const total = Object.values(L.months).reduce((a, x) => ({ calls: a.calls + x.calls, failed: a.failed + x.failed, in: a.in + x.in, out: a.out + x.out }), { calls: 0, failed: 0, in: 0, out: 0 });
      const shape = (x) => ({ calls: x.calls, failed: x.failed, tokensIn: x.in, tokensOut: x.out });
      return { local: true, month: shape(m), total: shape(total) };
    },
  };
}
