// 模式 B 的「导出 AI 对话」（结算卡按钮）：本局玩家 AI 每次经服务器中转的请求 / 回复，加上每次决策在局里的结局。
// 纯函数，不碰 DOM。格式 JSONL：
//   {t:'meta', matchId, seed, mapSize, provider, model, autonomy, safetyGate, strategy, calls, exportedAt}
//   {t:'call', id, kind, requestTurn, appliedTurn, why, ok, ms, model, finish, usage, messages, reply, error}
//   {t:'outcome', n, req, src, plan, err}     来自对局记录的 plan 行（llm / llm-repair / invalid / stale / failed）
// 不含 key（客户端本来就没有）和 keyId；思路原文是玩家自己写的，导出给自己看。

/** 每局最多保留的调用条数（中转上限每局 1600 次，正常一局 40–70 次）。 */
export const TALK_MAX_CALLS = 1600;

/** onCall 信息 → 导出行。 */
export function talkEntry(i) {
  return {
    t: 'call',
    id: i.id ?? null,
    kind: i.kind,
    requestTurn: i.requestTurn ?? null,
    appliedTurn: i.appliedTurn ?? null,
    why: i.why ?? null,
    ok: Boolean(i.ok),
    ms: i.ms ?? null,
    model: i.model ?? null,
    finish: i.finish ?? null,
    usage: i.usage ?? null,
    messages: i.messages ?? [],
    reply: i.ok ? i.text ?? '' : null,
    error: i.ok ? null : i.error ?? null,
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
    if (!raw.includes('"plan"')) continue;
    let L;
    try {
      L = JSON.parse(raw);
    } catch {
      continue;
    }
    if (L.t !== 'plan' || L.seat !== seat) continue;
    lines.push({ t: 'outcome', n: L.n, req: L.req ?? null, src: L.src, plan: L.plan ?? null, err: L.err ?? null });
  }
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
