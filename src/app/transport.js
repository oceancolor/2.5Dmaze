// LLM 传输层（SPEC §7.5「等待和超时看门狗放在内核外层」）：planner 只管发请求 / 收结果，
// 这里负责网络、超时、模拟延迟。计时器只允许出现在 src/app 与 src/player（确定性 lint 不扫这两处）。
//
//   mock   ：模拟大模型（src/ai/mock-llm.js），延迟 90–420 ms 伪随机（按请求 id 散列，不碰随机源）；快进时同步回复
//   proxy  ：本地代理 http://127.0.0.1:8787/v1/plan（proxy/proxy.mjs，密钥只在代理里）；超时 cfg.ai.llm.timeoutMs
//   relay  ：经游戏服务器中转 POST /llm/v1/chat（05 模式 B）：请求里只有 keyId，服务器附上本人的 key；超时 byokTimeoutMs

import { mockPlan } from '../ai/mock-llm.js';
import { buildMessages, buildRepairMessages } from '../ai/codec.js';
import { now } from './clock.js';

export const PROXY_URL = 'http://127.0.0.1:8787';

/**
 * 玩家自己的 AI（planner 传了 autonomy）用决策契约 v2 的提示词（含本局会话与跨局经验）；对手 AI 用原来的。
 * 两者都带「上次决策以来」（req.trajectory，§14 C7）；o.trajectory = false 时不带（MCP 回包自己另外排版）。
 */
export function messagesFor(req, cfg, o = {}) {
  const trajectory = o.trajectory === false ? undefined : req.trajectory;
  const opts = req.autonomy
    ? { autonomy: req.autonomy, safetyGate: req.safetyGate, context: req.context, session: req.session, memory: req.memory, trajectory }
    : { trajectory };
  return req.kind === 'repair'
    ? buildRepairMessages(req.payload, req.persona, cfg, req.raw, req.error, opts)
    : buildMessages(req.payload, req.persona, cfg, opts);
}

/** 思考档位（批次 6）：off / low / high，默认 low（玩家可改）。 */
export const THINKING = Object.freeze(['off', 'low', 'high']);
export const DEFAULT_THINKING = 'low';
export const isThinking = (v) => THINKING.includes(v);

/**
 * @param {{isFast?:()=>boolean, latency?:[number,number], onCall?:(info:object)=>void}} [o]
 */
export function createMockTransport({ isFast = () => false, latency = [90, 420], onCall = null } = {}) {
  return (req, reply) => {
    const text = mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) });
    if (onCall) onCall({ seat: req.seat, kind: req.kind, source: 'mock', ms: 0, ok: true });
    if (isFast()) {
      reply.deliver(text);
      return;
    }
    const h = Math.imul(req.id + 1, 2654435761) ^ Math.imul(req.seat + 7, 40503);
    const ms = latency[0] + ((h >>> 0) % (latency[1] - latency[0]));
    const timer = setTimeout(() => reply.deliver(text), ms);
    if (reply.signal) reply.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  };
}

/** planner 撤销（接管 / 换控制器 / 对局关闭）→ 中止本地这次网络请求；返回「是否已被撤销」的查询。 */
function linkCancel(reply, ctl) {
  let cancelled = false;
  if (reply.signal) {
    const onAbort = () => {
      cancelled = true;
      ctl.abort();
    };
    if (reply.signal.aborted) onAbort();
    else reply.signal.addEventListener('abort', onAbort, { once: true });
  }
  return () => cancelled;
}

/**
 * @param {{cfg:object, url?:string, onCall?:(info:object)=>void}} o
 *   onCall 收到 {seat, kind, source:'proxy', ms, ok, usage?, error?}（HUD 统计 / 调试面板）
 */
export function createProxyTransport({ cfg, url = PROXY_URL, onCall = null }) {
  const L = cfg.ai.llm;
  return (req, reply) => {
    const messages = messagesFor(req, cfg);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), L.timeoutMs);
    const cancelled = linkCancel(reply, ctl);
    const t0 = now();
    const done = (info) => {
      clearTimeout(timer);
      if (onCall) onCall({ seat: req.seat, kind: req.kind, source: 'proxy', ms: Math.round(now() - t0), ...info });
    };
    fetch(`${url}/v1/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: req.kind === 'repair' ? L.repairMaxTokens : L.maxOutputTokens,
        temperature: L.temperature,
      }),
      signal: ctl.signal,
    })
      .then(async (r) => {
        if (cancelled()) {
          clearTimeout(timer);
          return;
        }
        if (r.status === 429 || r.status >= 500) {
          done({ ok: false, error: `HTTP ${r.status}` });
          reply.fail(r.status === 429 ? '429' : '5xx');
          return;
        }
        if (!r.ok) {
          done({ ok: false, error: `HTTP ${r.status}` });
          reply.fail('http');
          return;
        }
        const j = await r.json();
        done({ ok: true, usage: j.usage ?? null });
        reply.deliver(String(j.text ?? ''));
      })
      .catch((e) => {
        clearTimeout(timer);
        if (cancelled()) return;
        const timeout = e && e.name === 'AbortError';
        done({ ok: false, error: timeout ? '超时' : '不可达' });
        reply.fail(timeout ? 'timeout' : 'unreachable');
      });
  };
}

/** 服务器错误码 → planner 的失败类型（决定重试 / 熔断，见 planner.js 降级规则）。 */
const RELAY_FAIL = {
  upstream_auth: 'auth', // key 无效 / 欠费 → 熔断
  upstream_bad: 'auth', // 模型名不对等配置错误：每次都会失败 → 熔断
  key_not_found: 'auth', // 「仅本次会话」的 key 过期 / 服务器重启过
  upstream_blocked: 'unreachable',
  upstream_unreachable: 'unreachable',
  upstream_rate: '429',
  upstream_5xx: '5xx',
  upstream_timeout: 'timeout',
};

/**
 * 经游戏服务器中转（05 §7）。
 * @param {{cfg:object, call:(method:string, path:string, body:object, o:{signal:AbortSignal})=>Promise<{status:number, json:object|null, reason?:string}>,
 *          keyId:string, matchId:string, thinking?:'off'|'low'|'high', onCall?:(info:object)=>void}} o
 *   call：sync.call（带游客令牌）；onCall 收到 {seat, kind, source:'relay', ms, ok, usage?, error?, thinking?}
 *   thinking：思考档位，服务器按服务商换成对应参数并放宽输出预算 / 超时（模型不支持时服务器降档，回复里的 thinking 是实际档位）
 */
export function createRelayTransport({ cfg, call, keyId, matchId, thinking = DEFAULT_THINKING, onCall = null }) {
  const L = cfg.ai.llm;
  const level = isThinking(thinking) ? thinking : DEFAULT_THINKING;
  const timeoutMs = L.byokTimeoutMs[level];
  return (req, reply) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const cancelled = linkCancel(reply, ctl);
    const t0 = now();
    // 答案本身的预算：契约 v2（可带 then / memo）给 contractMaxTokens；思考 token 由服务器按档位另加
    const answer = req.autonomy ? L.contractMaxTokens : L.maxOutputTokens;
    const body = {
      keyId, matchId, seat: req.seat, kind: req.kind, messages: messagesFor(req, cfg), thinking: level,
      max_tokens: req.kind === 'repair' ? Math.max(L.repairMaxTokens, answer) : answer, temperature: L.temperature,
    };
    // 导出对话用：本次请求的完整 messages 与触发信息（不含 key：客户端本来就没有 key）
    const exchange = { id: req.id, dp: req.dp, rev: req.rev, requestTurn: req.requestTurn, appliedTurn: req.appliedTurn, why: req.why ?? null, messages: body.messages };
    const done = (info) => {
      clearTimeout(timer);
      if (onCall) onCall({ seat: req.seat, kind: req.kind, source: 'relay', ms: Math.round(now() - t0), ...exchange, ...info });
    };
    call('POST', '/llm/v1/chat', body, { signal: ctl.signal }).then((r) => {
      if (cancelled()) {
        clearTimeout(timer);
        return;
      }
      if (r.status === 200 && r.json) {
        done({
          ok: true, usage: r.json.usage ?? null, model: r.json.model, finish: r.json.finish ?? null, text: String(r.json.text ?? ''),
          thinking: r.json.thinking ?? level, ...(r.json.reasoning ? { reasoning: String(r.json.reasoning) } : {}),
        });
        reply.deliver(String(r.json.text ?? ''));
        return;
      }
      if (r.status === 0) {
        const timeout = r.reason === 'abort';
        done({ ok: false, error: timeout ? '超时' : '游戏服务器不可达' });
        reply.fail(timeout ? 'timeout' : 'unreachable', timeout ? undefined : '游戏服务器不可达');
        return;
      }
      const code = r.json && r.json.error;
      const msg = (r.json && r.json.message) || `HTTP ${r.status}`;
      done({ ok: false, error: msg });
      const kind = RELAY_FAIL[code] ?? (r.status === 429 ? '429' : r.status >= 500 ? '5xx' : 'http');
      reply.fail(kind, msg);
    });
  };
}

/** 探测本地代理：{ok, model, keyPresent, base} 或 {ok:false, error}。 */
export async function probeProxy(url = PROXY_URL, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/health`, { signal: ctl.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, model: j.model ?? '', keyPresent: Boolean(j.keyPresent), base: j.base ?? '' };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '未启动（无响应）' : '未启动' };
  } finally {
    clearTimeout(timer);
  }
}
