// MCP 提交回执（决策协议改造 §14 C4，第 5 项）：同一 submissionId 重试 → 原样返回第一次的回包、不推进对局。
// 每局一份，只保留最近 limit 条（对局结束、闲置清理时随对局释放）。

export const RECEIPT_LIMIT = 32;
const SUBMISSION_ID = /^[\w.:-]{1,64}$/;

export const isSubmissionId = (v) => typeof v === 'string' && SUBMISSION_ID.test(v);

export function createReceipts(limit = RECEIPT_LIMIT) {
  const map = new Map();
  return {
    get: (id) => map.get(id) ?? null,
    put(id, text) {
      map.delete(id);
      map.set(id, text);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}
