// MCP 决策协议（决策协议改造 §14 C4 / C7 / C8，第 5 项）：三层回包、帧段衔接、提交防重、过期决策点、
// 多局必须指明、observe 纯读、maze_frames 的范围 / 字段 / 权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store/db.mjs';
import { createApp } from '../server/app.mjs';
import { mockPlan } from '../src/ai/mock-llm.js';
import { CLIENT_VERSION } from '../src/app/version.js';
import { MAX_PACKET_FRAMES } from '../src/ai/decision-packet.js';
import { createReceipts } from '../server/decision-receipts.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function boot() {
  const store = await openStore(':memory:');
  // 测试一秒内连发几十次工具调用：放开限流（真实对局每次决策要思考几秒，远低于 60 次突发 / 120 次每分钟）
  const limits = { mcpBurst: 1e6, mcpPerMinute: 1e6, ipPerMinute: 1e6 };
  const server = createServer(createApp({ store, root: ROOT, options: { masterKey: randomBytes(32), limits } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, token, body) => {
    const r = await fetch(base + path, {
      method, headers: { 'X-Maze-Client': `web/${CLIENT_VERSION}`, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return r.json();
  };
  const user = async () => {
    const A = (await http('POST', '/api/v1/guest', null, {})).token;
    return (await http('POST', '/api/v1/mcp/token', A, {})).token;
  };
  let rid = 0;
  const tool = async (T, name, args = {}) => {
    const r = (await http('POST', '/mcp', T, { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } })).result;
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  return { user, tool, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) };
}

const ENDED = /结束（第 \d+ 回合）/;
const block = (text) => JSON.parse(/```json\n(.+)\n```\s*$/.exec(text)[1]);
const gameIdOf = (text) => /对局 ([a-f0-9]{32})/.exec(text)[1];
function answer(text, extra = {}) {
  const payload = JSON.parse(text.slice(text.indexOf('局面：') + 3).split('\n本次决策：')[0]);
  const b = block(text);
  return { gameId: b.gameId, decisionPointId: b.decisionPointId, ...extra, decision: JSON.parse(mockPlan(payload, '', { contract: true })) };
}
const lastFrame = async (s, T, gameId) => block((await s.tool(T, 'maze_frames', { gameId, fields: ['seats'], from: 0, to: 0 })).text).last;

test('回包：标题口径、末尾 JSON 块；相邻决策点的帧段首尾相接、终局尾段收尾；决策层与帧同源；零缓冲无作废', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    for (const size of ['XS', 'S']) {
      let r = await s.tool(T, 'maze_new_game', { size, opponents: 'aware' });
      assert.match(r.text, /决策时序/);
      assert.match(r.text, /决策点 dp-1 · 局面是开局（还没有人行动）的；你的决定从第 1 回合起执行/);
      let expectFrom = 0;
      let n = 0;
      while (!/结束（第 \d+ 回合）/.test(r.text)) {
        const b = block(r.text);
        n++;
        assert.equal(b.protocol, 'decision-v2');
        assert.equal(b.decisionPointId, `dp-${n}`);
        assert.equal(b.effectiveTurn, b.snapshotTurn + 1);
        assert.equal(b.frames.from, expectFrom, `dp-${n} 帧段接着上一个`);
        assert.equal(b.frames.to, b.snapshotTurn);
        if (!b.frames.truncated) assert.deepEqual(b.frames.items.map((f) => f.k), Array.from({ length: b.frames.to - b.frames.from + 1 }, (_, i) => b.frames.from + i));
        else assert.equal(b.frames.items.length, MAX_PACKET_FRAMES);
        assert.match(r.text, new RegExp(`决策点 dp-${n} · 局面是${b.snapshotTurn === 0 ? '开局' : `第 ${b.snapshotTurn} 回合结束后`}`));
        // 决策层（局面 JSON）与帧 k 来自同一次投影
        const payload = JSON.parse(r.text.slice(r.text.indexOf('局面：') + 3).split('\n本次决策：')[0]);
        const me = b.frames.items.at(-1).seats[0];
        assert.deepEqual([payload.self.x, payload.self.y, payload.self.stamina, payload.self.score], me.slice(0, 4));
        assert.equal(payload.turn, b.snapshotTurn + 1);
        // 上一个决策点的结果事件都带在这里
        if (n > 1) assert.ok(b.lastDecisionOutcome.length >= 1 && b.lastDecisionOutcome.every((e) => e.dp === n - 1));
        assert.ok(!b.lastDecisionOutcome.some((e) => e.type === 'stale'), '零缓冲没有作废');
        expectFrom = b.snapshotTurn + 1;
        r = await s.tool(T, 'maze_decide', answer(r.text));
        assert.equal(r.isError, false, r.text);
      }
      const end = block(r.text);
      assert.equal(end.ended, true);
      assert.equal(end.frames.from, expectFrom, '终局尾段接着最后一个决策点');
      assert.equal(end.frames.to, end.endTurn);
      assert.ok(end.lastDecisionOutcome.length >= 1);
      assert.match(r.text, /### 最后一次决策以来/);
      assert.ok(n >= 3, `${size}：${n} 个决策点`);
    }
  } finally {
    await s.close();
  }
});

test('防重：同一 submissionId 重试原样返回、不推进；过期 decisionPointId 拒绝、不推进；不带 gameId 也能凭 submissionId 找回', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    const r0 = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    const gameId = gameIdOf(r0.text);
    const a = answer(r0.text, { submissionId: 'sub-1' });
    const r1 = await s.tool(T, 'maze_decide', a);
    const k1 = await lastFrame(s, T, gameId);
    const again = await s.tool(T, 'maze_decide', a);
    assert.equal(again.text, r1.text, '重试原样返回');
    assert.equal(await lastFrame(s, T, gameId), k1, '重试不推进');
    const noGame = await s.tool(T, 'maze_decide', { ...a, gameId: undefined });
    assert.equal(noGame.text, r1.text, '不带 gameId 凭 submissionId 找回');

    // 过期决策点：拿 dp-1 的决定（换一个新 submissionId）再交
    const stale = await s.tool(T, 'maze_decide', { ...a, submissionId: 'sub-2' });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /决策点 dp-1 已经处理过了（当前是 dp-2）[\s\S]*没有推进/);
    assert.equal(await lastFrame(s, T, gameId), k1);
    assert.equal((await s.tool(T, 'maze_observe', { gameId })).text, r1.text, '当前决策点没变');

    // 不带 decisionPointId 仍可提交（兼容），按当前决策点处理
    const r2 = await s.tool(T, 'maze_decide', { ...answer(r1.text), decisionPointId: undefined });
    assert.equal(r2.isError, false);
    assert.match(r2.text, /决策点 dp-3|结束/);
    assert.equal((await s.tool(T, 'maze_decide', { gameId, submissionId: 'bad id!', decision: a.decision })).isError, true, 'submissionId 格式');
  } finally {
    await s.close();
  }
});

test('多局：不带 gameId 时只有一局可以省略，两局以上报错并列出 id', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    const r1 = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    const o1 = (await s.tool(T, 'maze_observe')).text;
    assert.ok(o1.startsWith('## 对局') && r1.text.endsWith(o1), '只有一局：省略 gameId；新局回包 = 规则 + 同一个决策点回包');
    const r2 = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    for (const name of ['maze_observe', 'maze_frames']) {
      const e = await s.tool(T, name);
      assert.equal(e.isError, true);
      assert.ok(e.text.includes(gameIdOf(r1.text)) && e.text.includes(gameIdOf(r2.text)), '列出两局的 id');
    }
    const d = await s.tool(T, 'maze_decide', { ...answer(r1.text), gameId: undefined });
    assert.equal(d.isError, true, '提交也不猜');
    assert.equal((await s.tool(T, 'maze_observe', { gameId: gameIdOf(r1.text) })).text, o1, '没有被误交');
  } finally {
    await s.close();
  }
});

test('maze_observe 纯读：连续调用逐字节相同、对局不动；fresh 结果相同', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    const r0 = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'aware' });
    const r1 = await s.tool(T, 'maze_decide', answer(r0.text));
    const gameId = gameIdOf(r0.text);
    const k = await lastFrame(s, T, gameId);
    const o1 = await s.tool(T, 'maze_observe', { gameId });
    const o2 = await s.tool(T, 'maze_observe', { gameId, fresh: true });
    assert.equal(o1.text, r1.text);
    assert.equal(o2.text, r1.text);
    assert.equal(await lastFrame(s, T, gameId), k);
  } finally {
    await s.close();
  }
});

test('maze_frames：本座位投影、字段白名单、范围与分页、只读、他人读不到', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    let r = await s.tool(T, 'maze_new_game', { size: 'L', opponents: 'heuristic' });
    const gameId = gameIdOf(r.text);
    for (let i = 0; i < 4 && !ENDED.test(r.text); i++) r = await s.tool(T, 'maze_decide', answer(r.text));
    const all = block((await s.tool(T, 'maze_frames', { gameId })).text);
    assert.equal(all.from, 0);
    assert.equal(all.to, all.last);
    assert.deepEqual(all.items.map((f) => f.k), Array.from({ length: all.last + 1 }, (_, i) => i));
    for (const f of all.items) {
      assert.deepEqual(Object.keys(f).sort(), ['aim', 'chest', 'events', 'gems', 'gen', 'k', 'seats']);
      assert.equal(f.seats.length, 4);
      for (const e of f.events) if (['bump', 'blocked', 'invalidIntent'].includes(e.type)) assert.equal(e.seat, 0, '撞墙 / 受阻只给自己');
    }
    const txt = JSON.stringify(all);
    for (const w of ['"plan"', '"then"', '"abandonIf"', '"rng"', '"memory"', '"persona"', '"intent"']) assert.ok(!txt.includes(w), `不应出现 ${w}`);
    assert.ok(all.items.some((f) => f.aim && f.aim[0] >= 1), '标出了当时在执行的决策点');

    const part = block((await s.tool(T, 'maze_frames', { gameId, from: 2, to: 4, fields: ['events'] })).text);
    assert.deepEqual(part.items.map((f) => Object.keys(f).sort()), [['events', 'k'], ['events', 'k'], ['events', 'k']]);
    assert.equal((await s.tool(T, 'maze_frames', { gameId, fields: ['rng'] })).isError, true, '字段白名单');
    assert.equal((await s.tool(T, 'maze_frames', { gameId, from: 5, to: 2 })).isError, true);
    assert.equal((await s.tool(T, 'maze_frames', { gameId, from: all.last + 1 })).isError, true, '不能读未来');
    const clamp = block((await s.tool(T, 'maze_frames', { gameId, from: 0, to: all.last + 50 })).text);
    assert.equal(clamp.to, all.last);
    assert.equal(await lastFrame(s, T, gameId), all.last, '只读');

    // 一次最多 200 帧：打到超过 200 回合再取
    while (!ENDED.test(r.text) && (await lastFrame(s, T, gameId)) < 210) r = await s.tool(T, 'maze_decide', answer(r.text));
    const last = await lastFrame(s, T, gameId);
    assert.ok(last >= 210, `L 图应能打到 210 回合以上（实际 ${last}）`);
    const big = block((await s.tool(T, 'maze_frames', { gameId, fields: ['seats'] })).text);
    assert.equal(big.items.length, 200);
    assert.equal(big.to, 199);
    assert.equal(big.more, true);
    const rest = block((await s.tool(T, 'maze_frames', { gameId, from: 200, fields: ['seats'] })).text);
    assert.equal(rest.items[0].k, 200);
    assert.equal(rest.to, last);
    const B = await s.user();
    const other = await s.tool(B, 'maze_frames', { gameId });
    assert.equal(other.isError, true, '别人读不到');
  } finally {
    await s.close();
  }
});

test('回执：只留最近 limit 条，同 id 覆盖', () => {
  const r = createReceipts(3);
  for (const id of ['a', 'b', 'c', 'd']) r.put(id, id.toUpperCase());
  assert.equal(r.get('a'), null);
  assert.equal(r.get('d'), 'D');
  r.put('b', 'B2');
  r.put('e', 'E');
  assert.equal(r.get('c'), null, 'b 被重新放入后最旧的是 c');
  assert.equal(r.get('b'), 'B2');
  assert.equal(r.size, 3);
});
