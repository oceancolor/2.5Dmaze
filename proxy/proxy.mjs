#!/usr/bin/env node
// 本地 LLM 代理（SPEC §7.7、§12）。零依赖，只监听 127.0.0.1；密钥只在这里，前端拿不到。
//   GET  /health   → {ok, model, keyPresent, base}
//   POST /v1/plan  → 转发到 OpenAI 兼容的 {base}/chat/completions，回 {text, usage}
// 配置（优先级：环境变量 > proxy/config.local.json，后者已在 .gitignore）：
//   LLM_BASE_URL   例如 https://api.hunyuan.cloud.tencent.com/v1 或任何 OpenAI 兼容端点
//   LLM_API_KEY
//   LLM_MODEL      例如 hunyuan-turbos-latest
//   PROXY_PORT     默认 8787
// 安全：Origin 白名单只放行 http://127.0.0.1:* / http://localhost:*；请求体 > 64 KB → 413；日志里密钥打码。
// 用法：LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL=… node proxy/proxy.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
let local = {};
try {
  local = JSON.parse(await readFile(`${here}config.local.json`, 'utf8'));
} catch {
  local = {};
}
const conf = {
  base: (process.env.LLM_BASE_URL || local.baseUrl || '').replace(/\/+$/, ''),
  key: process.env.LLM_API_KEY || local.apiKey || '',
  model: process.env.LLM_MODEL || local.model || '',
  port: Number(process.env.PROXY_PORT || local.port || 8787),
  timeoutMs: Number(local.timeoutMs || 8000),
};
const MAX_BODY = 64 * 1024;
const ORIGIN_OK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

const redact = (s) => (conf.key ? String(s).split(conf.key).join('sk-***') : String(s));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a.map(redact));

function cors(req, res) {
  const o = req.headers.origin;
  if (!o) return true; // 同机 curl
  if (!ORIGIN_OK.test(o)) return false;
  res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function plan(body) {
  if (!conf.base || !conf.key || !conf.model) return { code: 503, obj: { error: '代理未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL' } };
  const { messages, max_tokens: maxTokens = 200, temperature = 0 } = body;
  if (!Array.isArray(messages) || !messages.length) return { code: 400, obj: { error: 'messages 必填' } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), conf.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${conf.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.key}` },
      body: JSON.stringify({ model: conf.model, messages, max_tokens: Math.min(400, maxTokens), temperature, stream: false }),
      signal: ctl.signal,
    });
    const txt = await r.text();
    if (!r.ok) {
      log('upstream', r.status, txt.slice(0, 200));
      return { code: r.status === 429 ? 429 : r.status >= 500 ? 502 : r.status, obj: { error: `upstream ${r.status}` } };
    }
    const j = JSON.parse(txt);
    const text = j.choices?.[0]?.message?.content ?? '';
    log('plan', `${Date.now() - t0}ms`, JSON.stringify(j.usage ?? {}), text.slice(0, 120).replace(/\s+/g, ' '));
    return { code: 200, obj: { text, usage: j.usage ?? null, model: j.model ?? conf.model } };
  } catch (e) {
    const timeout = e.name === 'AbortError';
    log('upstream error', timeout ? 'timeout' : e.message);
    return { code: timeout ? 504 : 502, obj: { error: timeout ? 'upstream timeout' : 'upstream unreachable' } };
  } finally {
    clearTimeout(timer);
  }
}

createServer(async (req, res) => {
  if (!cors(req, res)) {
    send(res, 403, { error: 'origin not allowed' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, { ok: true, model: conf.model, keyPresent: Boolean(conf.key && conf.base && conf.model), base: conf.base.replace(/^(https?:\/\/[^/]+).*$/, '$1') });
    return;
  }
  if (req.method === 'POST' && path === '/v1/plan') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body > 64KB' : 'bad json' });
      return;
    }
    const r = await plan(body);
    send(res, r.code, r.obj);
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(conf.port, '127.0.0.1', () => {
  log(`LLM proxy: http://127.0.0.1:${conf.port}/  model=${conf.model || '（未配置）'}  key=${conf.key ? '已配置' : '未配置'}`);
});
