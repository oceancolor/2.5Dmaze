// 模式 B 的「导出 AI 对话」：结算卡按钮（客户端内存里收集的调用）与战绩里的「下载对话」（服务器对话日志，talkEntryFromLog）同一格式。
// 纯函数，不碰 DOM。格式 JSONL：
//   {t:'meta', matchId, seed, mapSize, provider, model, autonomy, safetyGate, strategy, calls, exportedAt, source?}
//   {t:'call', id, at?, kind, dp, rev, requestTurn, appliedTurn, why, ok, ms, model, finish, usage, messages, reply, error}
//   {t:'outcome', n, req, dp, rev, src, plan, err}     来自对局记录的 plan 行（llm / llm-repair / invalid / stale / failed / queue / guard / abandon）
//   {t:'result', dp, type, k, ...}                    来自对局记录 v3 的 outcome 行（决策结果事件，§14 C5）
// dp = 决策点编号（同一决策点的修复重交 rev + 1）；k = 帧号（第 k 回合结束后）。
// 不含 key（客户端本来就没有）和 keyId；思路原文是玩家自己写的，导出给自己看。

/** 每局最多保留的调用条数（中转上限每局 1600 次，正常一局 40–70 次）。 */
export const TALK_MAX_CALLS = 1600;

/** onCall 信息 → 导出行。 */
export function talkEntry(i) {
  return {
    t: 'call',
    id: i.id ?? null,
    kind: i.kind,
    dp: i.dp ?? null,
    rev: i.rev ?? null,
    requestTurn: i.requestTurn ?? null,
    appliedTurn: i.appliedTurn ?? null,
    why: i.why ?? null,
    ok: Boolean(i.ok),
    ms: i.ms ?? null,
    model: i.model ?? null,
    finish: i.finish ?? null,
    usage: i.usage ?? null,
    thinking: i.thinking ?? null,
    messages: i.messages ?? [],
    reply: i.ok ? i.text ?? '' : null,
    ...(i.reasoning ? { reasoning: i.reasoning } : {}),
    error: i.ok ? null : i.error ?? null,
  };
}

/**
 * 服务器对话日志的一行（server/llm-log.mjs）→ 导出行（战绩里的「下载对话」用，格式与结算卡导出相同）。
 * 日志里没有发起回合 / 触发原因，从 user 消息里的「局面：{"turn":…}」「本次决策：{"why":…}」取回；取不到就是 null。
 * 不带 keyId / keyHint / userId。
 */
export function talkEntryFromLog(e) {
  const msgs = (e.request && Array.isArray(e.request.messages)) ? e.request.messages : [];
  const user = msgs.find((m) => m && m.role === 'user');
  const text = user && typeof user.content === 'string' ? user.content : '';
  const turn = /局面：\{"turn":(\d+)/.exec(text);
  const why = /本次决策：\{"why":"([A-Za-z]+)"/.exec(text);
  const err = e.error && typeof e.error === 'object' ? e.error.message || e.error.kind || '失败' : e.error ?? null;
  return {
    t: 'call',
    id: null,
    at: e.at ?? null,
    kind: e.kind,
    dp: null,
    rev: null,
    requestTurn: turn ? Number(turn[1]) : null,
    appliedTurn: null,
    why: why ? why[1] : null,
    ok: Boolean(e.ok),
    ms: e.ms ?? null,
    model: e.upstreamModel ?? e.model ?? null,
    finish: e.finish ?? null,
    usage: e.usage ?? null,
    thinking: e.thinking ?? null,
    messages: msgs,
    reply: e.ok ? e.reply ?? '' : null,
    ...(e.reasoningText ? { reasoning: e.reasoningText } : {}),
    error: e.ok ? null : err,
  };
}

/**
 * @param {{meta:object, calls:object[], recordJSONL:string, seat?:number, exportedAt:number}} o
 * @returns {string} JSONL
 */
export function buildTalkExport({ meta, calls, recordJSONL, seat = 0, exportedAt }) {
  const lines = [{ t: 'meta', ...meta, calls: calls.length, exportedAt }];
  for (const c of calls) lines.push(c);
  for (const raw of String(recordJSONL || '').split('\n')) {
    if (!raw.includes('"plan"') && !raw.includes('"outcome"')) continue;
    let L;
    try {
      L = JSON.parse(raw);
    } catch {
      continue;
    }
    if (L.seat !== seat) continue;
    if (L.t === 'plan') lines.push({ t: 'outcome', n: L.n, req: L.req ?? null, dp: L.dp ?? null, rev: L.rev ?? 0, src: L.src, plan: L.plan ?? null, err: L.err ?? null });
    else if (L.t === 'outcome') {
      const { t, seat: _s, ...e } = L;
      lines.push({ t: 'result', ...e });
    }
  }
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
