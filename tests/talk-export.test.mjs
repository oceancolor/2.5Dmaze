// 模式 B「导出 AI 对话」：传输层回报完整请求 / 回复，导出含 meta / call / outcome 三类行，不含 key。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeConfig } from '../src/config/default.config.js';
import { createRelayTransport } from '../src/app/transport.js';
import { buildTalkExport, talkEntry } from '../src/app/talk-export.js';

const CFG = makeConfig({ match: { playerMode: 'byok' } });

function relayOnce(response) {
  return new Promise((resolve) => {
    const infos = [];
    const t = createRelayTransport({
      cfg: CFG,
      call: async () => response,
      keyId: 'k_abc',
      matchId: 'm'.repeat(32),
      onCall: (i) => infos.push(i),
    });
    const req = {
      id: 7, seat: 0, kind: 'plan', persona: '先凑套', requestTurn: 12, appliedTurn: 14, why: 'interval',
      payload: { self: { seat: 0 }, maxTurns: 600, turn: 12 }, autonomy: 'blend', safetyGate: true, context: { why: null, plan: null, budget: 50 },
    };
    try {
      t(req, { deliver: (text) => resolve({ infos, text }), fail: (kind, msg) => resolve({ infos, fail: [kind, msg] }) });
    } catch (e) {
      resolve({ infos, error: e });
    }
  });
}

test('中转传输层：onCall 带回本次 messages、回复原文、finish 与决策触发信息', async () => {
  const r = await relayOnce({ status: 200, json: { text: '{"targetType":"exit"}', usage: { in: 900, out: 30 }, model: 'kimi-k3', finish: 'stop' } });
  assert.ok(!r.error, String(r.error));
  assert.equal(r.text, '{"targetType":"exit"}');
  const i = r.infos[0];
  assert.equal(i.ok, true);
  assert.equal(i.text, '{"targetType":"exit"}');
  assert.equal(i.finish, 'stop');
  assert.equal(i.id, 7);
  assert.equal(i.requestTurn, 12);
  assert.equal(i.why, 'interval');
  assert.ok(Array.isArray(i.messages) && i.messages.length >= 2);
  assert.equal(JSON.stringify(i).includes('k_abc'), false, 'onCall 信息里没有 keyId');
});

test('中转失败也记一条：ok=false、带错误信息', async () => {
  const r = await relayOnce({ status: 502, json: { error: 'upstream', message: '上游 502' } });
  const e = talkEntry(r.infos[0]);
  assert.equal(e.ok, false);
  assert.equal(e.reply, null);
  assert.equal(e.error, '上游 502');
});

test('导出：meta + 每次调用 + 玩家座位的决策结局；别的座位的 plan 行不混进来', () => {
  const record = [
    JSON.stringify({ t: 'meta', v: 1, seed: 5 }),
    JSON.stringify({ t: 'turn', n: 1, i: '....', h: '00000000' }),
    JSON.stringify({ t: 'plan', n: 14, seat: 0, req: 12, src: 'llm', plan: { targetType: 'exit' } }),
    JSON.stringify({ t: 'plan', n: 15, seat: 2, req: 13, src: 'llm', plan: { targetType: 'gem' } }),
    JSON.stringify({ t: 'plan', n: 30, seat: 0, req: 28, src: 'invalid', plan: null, err: '目标不是宝物' }),
  ].join('\n');
  const calls = [talkEntry({ ok: true, kind: 'plan', id: 1, messages: [{ role: 'user', content: 'x' }], text: '{}', ms: 800 })];
  const out = buildTalkExport({ meta: { matchId: 'm1', seed: 5, model: 'kimi-k3' }, calls, recordJSONL: record, seat: 0, exportedAt: 1 });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.t), ['meta', 'call', 'outcome', 'outcome']);
  assert.equal(lines[0].calls, 1);
  assert.equal(lines[1].reply, '{}');
  assert.deepEqual(lines.filter((l) => l.t === 'outcome').map((l) => l.src), ['llm', 'invalid']);
  assert.equal(lines[3].err, '目标不是宝物');
});
