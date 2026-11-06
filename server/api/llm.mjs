// 玩家自带模型（05 §7、06 §7 / §11）：
//   GET    /api/v1/providers        服务商预设（无需登录）
//   GET    /api/v1/keys             我的 key（只有服务商 / 模型 / 尾号）
//   POST   /api/v1/keys             保存 key（默认仅本次会话；remember=true 加密入库）
//   DELETE /api/v1/keys/:id
//   POST   /api/v1/keys/:id/test    测试连接 + 一次示范决策（开局局面，按决策契约 v1）
//   POST   /llm/v1/chat             中转：服务器附上本人 key 调用服务商，并记账
//   GET    /api/v1/usage            本月 / 某一局的用量
// 谁用谁付：每次调用都记到 usage 表、归属到具体用户；服务器自己从不付费调用。

import { makeConfig } from '../../src/config/default.config.js';
import { createMatch } from '../../src/core/state.js';
import { observe } from '../../src/core/observe.js';
import { buildMessages, buildPayload, checkContract, parsePlan, validatePlan, AUTONOMY } from '../../src/ai/codec.js';
import { PERSONAS } from '../../src/ai/mock-llm.js';
import { HttpError, readJson, sendJson } from '../http.mjs';
import { authenticate } from './accounts.mjs';
import { PROVIDERS, checkBaseUrl, providerList, thinkingPlan, THINKING, DEFAULT_THINKING, THINK_BUDGET } from '../providers.mjs';
import { chatCompletion } from '../llm-relay.mjs';

const KEY_ID = /^k_[A-Za-z0-9_-]{16}$/;
const MODEL = /^[\w.:/@-]{1,80}$/;
const API_KEY = /^[\x21-\x7e]{8,400}$/;
const MATCH_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ROLES = new Set(['system', 'user', 'assistant']);
/** 契约 v2 起每次请求带本局会话（≤ 8 条原样 + 摘要）与跨局经验（≤ 2000 字），上限放宽。 */
const MAX_CHARS = 48000;
/** 调用类型：plan / repair（对局中）、memory（赛后让模型自己写经验 / 压缩经验，批次 6）。 */
const KINDS = new Set(['plan', 'repair', 'memory']);
/** 上游超时按实际思考档位（providers.RELAY_TIMEOUT_MS：45 / 75 / 150 s），比客户端（40 / 70 / 145 s）略长，由客户端判超时与重试。
 *  客户端放弃后这里仍等上游回来并记账（服务商照样计费）。 */
export { RELAY_TIMEOUT_MS } from '../providers.mjs';
/** 每局经中转的调用上限（4 座位 × 360 次池上限 + 修复，留余量）；防止中转被当成通用代理。 */
const MATCH_CALL_CAP = 1600;

const UPSTREAM_ERROR = {
  auth: { status: 502, code: 'upstream_auth' },
  rate: { status: 502, code: 'upstream_rate' },
  '5xx': { status: 502, code: 'upstream_5xx' },
  bad: { status: 502, code: 'upstream_bad' },
  timeout: { status: 504, code: 'upstream_timeout' },
  unreachable: { status: 502, code: 'upstream_unreachable' },
  blocked: { status: 502, code: 'upstream_blocked' },
};

function keyOf(ctx, user, id) {
  const k = KEY_ID.test(id) ? ctx.vault.get(user.id, id) : null;
  if (!k) throw new HttpError(404, 'key_not_found', '没有这个 key（可能已删除，或「仅本次会话」的 key 已过期 / 服务器重启过）');
  return k;
}

function upstreamFail(res, r) {
  const e = UPSTREAM_ERROR[r.kind] ?? UPSTREAM_ERROR['5xx'];
  sendJson(res, e.status, { error: e.code, message: r.message, upstreamStatus: r.status, ms: r.ms });
}

function record(ctx, user, k, { matchId = null, seat = null, kind, r, messages, tp }) {
  ctx.store.insertUsage({
    userId: user.id, matchId, seat, kind, provider: k.provider, model: k.model,
    tokensIn: r.ok ? r.usage.in : 0, tokensOut: r.ok ? r.usage.out : 0, ms: r.ms, ok: r.ok, at: ctx.now(),
  });
  if (r.ok) ctx.vault.touch(k.id);
  // 对话日志：只放 keyId 与尾号，不放 key（k.apiKey 不进这个对象）
  if (ctx.llmLog && ctx.llmLog.enabled) {
    ctx.llmLog.write({
      userId: user.id, matchId, seat, kind,
      provider: k.provider, model: k.model, reasoning: Boolean(k.reasoning), thinking: tp.level, keyId: k.id, keyHint: k.hint,
      request: { maxTokens: tp.maxTokens, extra: tp.extra, messages },
      ok: r.ok, ms: r.ms,
      ...(r.ok
        ? { reply: r.text, finish: r.finish, usage: r.usage, upstreamModel: r.model, ...(r.reasoning ? { reasoningText: r.reasoning } : {}) }
        : { error: { kind: r.kind, status: r.status, message: r.message } }),
    });
  }
}

/** 这把 key 在请求的思考档位下怎么调（模型不支持时降档）。 */
const planOf = (k, thinking, maxTokens) => thinkingPlan(k.provider, THINKING.includes(thinking) ? thinking : DEFAULT_THINKING, { requested: maxTokens, reasoning: k.reasoning });

const once = (ctx, k, { messages, tp, temperature }) => chatCompletion({
  base: k.baseUrl,
  model: k.model,
  apiKey: k.apiKey,
  messages,
  maxTokens: tp.maxTokens,
  temperature,
  extra: tp.extra,
  timeoutMs: tp.timeoutMs,
  upstream: ctx.upstream,
  now: ctx.now,
});

/**
 * 一次调用；思考把预算用光、答案为空（finish = length 且 content 空，DeepSeek 低档实测偶发）时，
 * 用「关」档补问一次，保证拿到答案。返回 {r, tp}：tp 是实际生效的档位（补问时 level = 'off'、fallback = true）。
 * 两次调用都记账、都写日志（由调用方 record）。
 */
async function call(ctx, k, { messages, tp, temperature, onFirst }) {
  const r = await once(ctx, k, { messages, tp, temperature });
  if (!(r.ok && tp.level !== 'off' && r.finish === 'length' && !String(r.text || '').trim())) return { r, tp };
  if (onFirst) onFirst(r, tp);
  const off = { ...planOf(k, 'off', tp.maxTokens - (THINK_BUDGET[tp.level] || 0)), fallback: true };
  const r2 = await once(ctx, k, { messages, tp: off, temperature });
  return { r: r2.ok ? { ...r2, usage: { in: r.usage.in + r2.usage.in, out: r.usage.out + r2.usage.out, reasoning: (r.usage.reasoning || 0) + (r2.usage.reasoning || 0) } } : r2, tp: off, first: r };
}

export function getProviders(req, res, ctx) {
  sendJson(res, 200, { items: providerList(), canRemember: ctx.vault.canRemember });
}

export function listKeys(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  sendJson(res, 200, { items: ctx.vault.list(user.id), canRemember: ctx.vault.canRemember });
}

export async function createKey(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  ctx.limiters.keys.take(user.id);
  const b = await readJson(req, 8 * 1024);
  const p = PROVIDERS[b.provider];
  if (!p) throw new HttpError(400, 'bad_provider', `不支持的服务商：${String(b.provider).slice(0, 32)}`);
  let baseUrl = p.baseUrl;
  if (b.provider === 'custom') {
    try {
      baseUrl = checkBaseUrl(b.baseUrl);
    } catch (e) {
      throw new HttpError(400, 'bad_base_url', `地址不可用：${e.message}`);
    }
  }
  const model = String(b.model ?? '').trim() || p.model;
  if (!MODEL.test(model)) throw new HttpError(400, 'bad_model', '模型名 1–80 字符，只能是字母、数字和 . _ : / @ -');
  if (typeof b.apiKey !== 'string' || !API_KEY.test(b.apiKey.trim())) throw new HttpError(400, 'bad_api_key', 'API key 应为 8–400 个可见 ASCII 字符');
  try {
    const meta = ctx.vault.add(user.id, { provider: b.provider, baseUrl, model, apiKey: b.apiKey.trim(), reasoning: Boolean(b.reasoning), remember: Boolean(b.remember) });
    sendJson(res, 201, meta);
  } catch (e) {
    if (e.message === 'remember_unavailable') throw new HttpError(400, 'remember_unavailable', '服务器没有配置主密钥，暂时只能「仅本次会话」');
    if (e.message === 'too_many_keys') throw new HttpError(409, 'too_many_keys', '每人最多保存 10 个 key，请先删除不用的');
    throw e;
  }
}

export function deleteKey(req, res, ctx, id) {
  const user = authenticate(req, ctx.store, ctx.now);
  if (!KEY_ID.test(id) || !ctx.vault.remove(user.id, id)) throw new HttpError(404, 'key_not_found', '没有这个 key');
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/** 测试连接：用开局局面跑一次示范决策，验证能按决策契约 v1 输出。 */
export async function testKey(req, res, ctx, id) {
  const user = authenticate(req, ctx.store, ctx.now);
  ctx.limiters.test.take(user.id);
  const k = keyOf(ctx, user, id);
  const b = await readJson(req, 16 * 1024);
  const autonomy = AUTONOMY[b.autonomy] ? b.autonomy : 'blend';
  const strategy = typeof b.strategy === 'string' && b.strategy.trim() ? b.strategy : PERSONAS.balanced.text;
  const cfg = makeConfig({ match: { playerMode: 'byok' } });
  const m = createMatch(1, cfg);
  const obs = observe(m.map, m.state, 0, cfg, { patch: true, events: [] });
  const payload = buildPayload(m.map, obs, cfg);
  const messages = buildMessages(payload, strategy, cfg, { autonomy, safetyGate: true, context: { why: 'start', plan: null, budget: cfg.ai.normalSoftCapPerAgent } });
  // 思考档位与对局一致（默认低）：思考 token 另给预算，否则会把答案挤掉
  const tp0 = planOf(k, b.thinking, cfg.ai.llm.contractMaxTokens);
  const { r, tp } = await call(ctx, k, { messages, tp: tp0, temperature: 0, onFirst: (r1, t1) => record(ctx, user, k, { kind: 'test', r: r1, messages, tp: t1 }) });
  record(ctx, user, k, { kind: 'test', r, messages, tp });
  if (!r.ok) {
    upstreamFail(res, r);
    return;
  }
  const parsed = parsePlan(r.text);
  const contract = parsed.ok ? checkContract(parsed.plan, autonomy) : null;
  const valid = parsed.ok ? validatePlan(parsed.plan, obs) : null;
  sendJson(res, 200, {
    ok: Boolean(parsed.ok && contract.ok && valid.ok),
    thinking: tp.level,
    thinkingRequested: tp0.requested,
    ...(tp.fallback ? { fallback: '思考用光了预算、没写出答案，已自动用「关」档补问一次' } : {}),
    ms: r.ms,
    model: r.model,
    finish: r.finish,
    usage: r.usage,
    text: r.text.slice(0, 300),
    plan: parsed.ok ? parsed.plan : null,
    error: !parsed.ok ? parsed.error : !contract.ok ? contract.error : !valid.ok ? valid.why : null,
  });
}

/** 中转一次规划请求。 */
export async function relayChat(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  ctx.limiters.relay.take(user.id);
  const b = await readJson(req, 96 * 1024);
  const k = keyOf(ctx, user, String(b.keyId ?? ''));
  if (typeof b.matchId !== 'string' || !MATCH_ID.test(b.matchId)) throw new HttpError(400, 'bad_match_id', 'matchId 必填（本局的对局 ID）');
  const seat = Number.isInteger(b.seat) && b.seat >= 0 && b.seat < 4 ? b.seat : null;
  if (seat === null) throw new HttpError(400, 'bad_seat', 'seat 应为 0–3');
  const kind = KINDS.has(b.kind) ? b.kind : 'plan';
  const msgs = b.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 4) throw new HttpError(400, 'bad_messages', 'messages 应为 1–4 条');
  let chars = 0;
  for (const x of msgs) {
    if (!x || !ROLES.has(x.role) || typeof x.content !== 'string') throw new HttpError(400, 'bad_messages', 'messages 每条须为 {role, content}');
    chars += x.content.length;
  }
  if (chars > MAX_CHARS) throw new HttpError(413, 'body_too_large', `messages 合计超过 ${MAX_CHARS} 字符`);
  const n = (ctx.matchCalls.get(b.matchId) ?? 0) + 1;
  if (n > MATCH_CALL_CAP) throw new HttpError(429, 'match_call_cap', `本局经服务器的调用已达上限 ${MATCH_CALL_CAP}`);
  ctx.matchCalls.set(b.matchId, n);
  if (ctx.matchCalls.size > 20000) ctx.matchCalls.clear();

  const maxTokens = Number.isInteger(b.max_tokens) && b.max_tokens > 0 ? b.max_tokens : 200;
  const temperature = Number.isFinite(b.temperature) ? Math.min(1, Math.max(0, b.temperature)) : 0;
  const tp0 = planOf(k, b.thinking, maxTokens);
  const { r, tp, first } = await call(ctx, k, {
    messages: msgs, tp: tp0, temperature,
    onFirst: (r1, t1) => record(ctx, user, k, { matchId: b.matchId, seat, kind, r: r1, messages: msgs, tp: t1 }),
  });
  record(ctx, user, k, { matchId: b.matchId, seat, kind, r, messages: msgs, tp });
  if (!r.ok) {
    upstreamFail(res, r);
    return;
  }
  const reasoning = (first && first.reasoning) || r.reasoning;
  sendJson(res, 200, {
    text: r.text, usage: r.usage, model: r.model, finish: r.finish, ms: r.ms + (first ? first.ms : 0), thinking: tp.level,
    ...(tp.fallback ? { fallback: true } : {}), ...(reasoning ? { reasoning } : {}),
  });
}

export function getUsage(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  const t = new Date(ctx.now());
  const monthStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
  const out = { month: { since: monthStart, ...ctx.store.usageSince(user.id, monthStart) }, total: ctx.store.usageSince(user.id, 0) };
  const mid = ctx.url.searchParams.get('matchId');
  if (mid) {
    if (!MATCH_ID.test(mid)) throw new HttpError(400, 'bad_match_id', 'matchId 格式不对');
    out.match = { matchId: mid, seats: ctx.store.usageByMatch(user.id, mid) };
  }
  sendJson(res, 200, out);
}
