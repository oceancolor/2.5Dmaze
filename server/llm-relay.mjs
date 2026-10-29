// 大模型中转（06 §7）：服务器附上玩家自己的 key，调用 OpenAI 兼容的 /chat/completions。谁用谁付：服务器不出任何调用费。
// 上游请求用 node:https + guardedLookup（每次连接按 DNS 结果拒绝内网地址）。测试可注入 upstream 替身。
//
// 失败分类（客户端据此决定重试 / 熔断）：
//   auth         上游 401 / 402 / 403：key 无效、欠费、无权限 → 熔断
//   rate         上游 429
//   5xx          上游 5xx / 回复不是合法 JSON
//   bad          上游其他 4xx（多半是模型名不对）
//   timeout      超时
//   unreachable  连不上（DNS 失败、拒绝连接、TLS 失败）
//   blocked      目标是内网地址（SSRF 防护）

import { request as httpsRequest } from 'node:https';
import { guardedLookup } from './providers.mjs';

const MAX_RESPONSE = 2 * 1024 * 1024;

/** 默认上游：POST JSON，返回 {status, text}；网络错误抛出（带 code）。 */
export function httpsUpstream({ url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = httpsRequest({
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: guardedLookup,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) {
          req.destroy(Object.assign(new Error('上游回复过大'), { code: 'ETOOBIG' }));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('上游超时'), { code: 'EUPSTREAMTIMEOUT' })), timeoutMs);
    req.on('error', (e) => finish(reject, e));
    req.end(body);
  });
}

const errKind = (status) => (status === 401 || status === 402 || status === 403 ? 'auth' : status === 429 ? 'rate' : status >= 500 ? '5xx' : 'bad');

/** 上游错误回复里取一句人话（不同厂商格式不同）。 */
function upstreamMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = (j.error && (j.error.message || j.error.msg || j.error.code)) || j.message || j.msg;
    if (m) return String(m).slice(0, 160);
  } catch { /* 非 JSON */ }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * @param {{base:string, model:string, apiKey:string, messages:object[], maxTokens:number, temperature:number,
 *          extra?:object, timeoutMs:number, upstream?:Function, now?:()=>number}} o
 * @returns {Promise<{ok:true, text:string, usage:{in:number,out:number}, model:string, ms:number, finish:string|null}
 *                 | {ok:false, kind:string, status:number|null, message:string, ms:number}>}
 */
export async function chatCompletion({ base, model, apiKey, messages, maxTokens, temperature, extra = {}, timeoutMs, upstream = httpsUpstream, now = Date.now }) {
  const t0 = now();
  const ms = () => Math.max(0, Math.round(now() - t0));
  let r;
  try {
    r = await upstream({
      url: `${base}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false, ...extra }),
      timeoutMs,
    });
  } catch (e) {
    const code = e && e.code;
    if (code === 'ESSRF') return { ok: false, kind: 'blocked', status: null, message: e.message, ms: ms() };
    if (code === 'EUPSTREAMTIMEOUT') return { ok: false, kind: 'timeout', status: null, message: `上游 ${timeoutMs / 1000} 秒没有回复`, ms: ms() };
    return { ok: false, kind: 'unreachable', status: null, message: `连不上服务商（${code || (e && e.message) || '网络错误'}）`, ms: ms() };
  }
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, kind: errKind(r.status), status: r.status, message: `服务商返回 ${r.status}：${upstreamMessage(r.text)}`, ms: ms() };
  }
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    return { ok: false, kind: '5xx', status: r.status, message: '服务商回复不是 JSON', ms: ms() };
  }
  const c = j && Array.isArray(j.choices) ? j.choices[0] : null;
  const text = c && c.message && typeof c.message.content === 'string' ? c.message.content : '';
  const u = j.usage || {};
  return {
    ok: true,
    text,
    usage: { in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0 },
    model: typeof j.model === 'string' ? j.model.slice(0, 80) : model,
    finish: c && c.finish_reason ? String(c.finish_reason) : null,
    ms: ms(),
  };
}
