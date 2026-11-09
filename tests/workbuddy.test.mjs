// WorkBuddy 上场（批次 7）：MCP 令牌、JSON-RPC（initialize / tools / prompts / 批量 / 通知）、托管对局整局、
// 不合格决策带错误重问、入库校验（座位标签 mcp:workbuddy）、复盘 / 战绩、服务器自留摘要不对外。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store/db.mjs';
import { createApp } from '../server/app.mjs';
import { mockPlan } from '../src/ai/mock-llm.js';
import { CLIENT_VERSION } from '../src/app/version.js';
import { createPlayback, seatLabelsOf } from '../src/record/playback.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function boot() {
  const store = await openStore(':memory:');
  const app = createApp({ store, root: ROOT, options: { masterKey: randomBytes(32) } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { 'X-Maze-Client': `web/${CLIENT_VERSION}`, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 空 */ }
    return { status: r.status, json, text };
  };
  const guest = async () => (await http('POST', '/api/v1/guest', { body: {} })).json.token;
  let rid = 0;
  const rpc = async (token, method, params) => http('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rid, method, params }, headers: { Accept: 'application/json, text/event-stream' } });
  const tool = async (token, name, args = {}) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, r.text);
    return { text: r.json.result.content[0].text, isError: Boolean(r.json.result.isError) };
  };
  return { store, http, guest, rpc, tool, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) };
}

/** 从决策点文本里取回局面，用模拟大模型按契约作答（一个守规矩的 agent）。 */
function decisionFrom(text) {
  const at = text.indexOf('局面：');
  const payload = JSON.parse(text.slice(at + 3).split('\n本次决策：')[0]);
  const d = JSON.parse(mockPlan(payload, ''));
  d.memo = `第 ${payload.turn} 回合判断`;
  return { gameId: /对局 ([a-f0-9]{32})/.exec(text)[1], decision: d };
}

test('MCP 令牌：生成只返回一次、给出 WorkBuddy 配置片段；新令牌作废旧的；无令牌 / 作废令牌 401', async () => {
  const s = await boot();
  try {
    const A = await s.guest();
    const t1 = await s.http('POST', '/api/v1/mcp/token', { token: A, body: {} });
    assert.equal(t1.status, 201);
    assert.match(t1.json.token, /^mz_/);
    assert.match(t1.json.url, /\/mcp$/);
    const srv = t1.json.config.mcpServers['maze-treasure'];
    assert.equal(srv.type, 'streamableHttp');
    assert.equal(srv.headers.Authorization, `Bearer ${t1.json.token}`);
    const info = await s.http('GET', '/api/v1/mcp', { token: A });
    assert.equal(info.json.token.hint, t1.json.hint);
    assert.equal(info.text.includes(t1.json.token), false, '查询接口不回显令牌');
    assert.equal((await s.rpc(t1.json.token, 'ping', {})).status, 200);
    const t2 = await s.http('POST', '/api/v1/mcp/token', { token: A, body: {} });
    assert.equal((await s.rpc(t1.json.token, 'ping', {})).status, 401, '旧令牌作废');
    assert.equal((await s.rpc(t2.json.token, 'ping', {})).status, 200);
    assert.equal((await s.rpc(null, 'ping', {})).status, 401);
    assert.equal((await s.rpc(A, 'ping', {})).status, 401, '游客令牌不能当 MCP 令牌用');
    assert.equal((await s.http('DELETE', '/api/v1/mcp/token', { token: A })).status, 204);
    assert.equal((await s.rpc(t2.json.token, 'ping', {})).status, 401);
  } finally {
    await s.close();
  }
});

test('MCP 协议：initialize 协商版本；tools / prompts 列表；通知回 202；批量；未知方法 -32601；GET 405', async () => {
  const s = await boot();
  try {
    const T = (await s.http('POST', '/api/v1/mcp/token', { token: await s.guest(), body: {} })).json.token;
    const init = await s.rpc(T, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'WorkBuddy', version: '4.24' } });
    assert.equal(init.json.result.protocolVersion, '2025-03-26');
    assert.ok(init.json.result.capabilities.tools);
    assert.equal((await s.rpc(T, 'initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion, '2025-06-18');
    const note = await s.http('POST', '/mcp', { token: T, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(note.status, 202);
    const tools = (await s.rpc(T, 'tools/list', {})).json.result.tools.map((t) => t.name);
    assert.deepEqual(tools, ['maze_new_game', 'maze_decide', 'maze_observe', 'maze_query', 'maze_replay', 'maze_history']);
    const pr = await s.rpc(T, 'prompts/get', { name: 'play_maze', arguments: { size: 'S', strategy: '先凑套' } });
    assert.match(pr.json.result.messages[0].content.text, /地图 S[\s\S]*maze_new_game[\s\S]*先凑套/);
    const batch = await s.http('POST', '/mcp', { token: T, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope' }] });
    assert.equal(batch.json.length, 2);
    assert.equal(batch.json[1].error.code, -32601);
    assert.equal((await s.http('GET', '/mcp', { token: T })).status, 405);
    assert.equal((await s.http('POST', '/mcp', { token: T, body: '{oops' })).json.error.code, -32700);
  } finally {
    await s.close();
  }
});

test('整局：开局 → 每个决策点 maze_decide → 结束；会话与备忘随决策点带回；入库校验 verified、标为 mcp:workbuddy；复盘 / 战绩；摘要只存服务器', async () => {
  const s = await boot();
  try {
    const A = await s.guest();
    const T = (await s.http('POST', '/api/v1/mcp/token', { token: A, body: {} })).json.token;
    for (const opponents of ['heuristic', 'aware']) {
      let r = await s.tool(T, 'maze_new_game', { size: 'XS', opponents, strategy: '先凑套' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /决策契约[\s\S]*先凑套/);
      assert.match(r.text, /决策点 #1/);
      let gameId = null;
      let points = 0;
      let sawSession = false;
      while (!/结束（第 \d+ 回合）/.test(r.text)) {
        const d = decisionFrom(r.text);
        gameId = d.gameId;
        if (/你上次写给自己的备忘：第 \d+ 回合判断/.test(r.text)) sawSession = true;
        r = await s.tool(T, 'maze_decide', d);
        assert.equal(r.isError, false, r.text);
        assert.ok(++points < 200, '决策点数应有限');
      }
      assert.ok(points >= 2, `${opponents}: ${points} 个决策点`);
      assert.ok(sawSession, '后续决策点带上本局会话与备忘');
      assert.match(r.text, /服务器回放校验：通过/);
      const m = (await s.http('GET', `/api/v1/matches/${gameId}`, { token: A })).json;
      assert.equal(m.verify, 'verified');
      assert.equal(m.seats[0].tag, 'mcp:workbuddy');
      assert.equal(m.host, 'server');
      assert.equal(m.playerMode, 'byok', '规则同接入大模型（同一配置）');
      // 网页回放：记录可由录像控制器逐回合重新播出，与记录完全一致；带座位 0 的复盘时间线
      const rp = await s.http('GET', `/api/v1/matches/${gameId}/replay`, { token: A });
      assert.equal(rp.status, 200, rp.text);
      assert.equal(rp.json.label, 'WorkBuddy 上场');
      assert.ok(rp.json.timeline && rp.json.timeline.entries.length >= 2);
      const pb = createPlayback(rp.json.record);
      const sched = pb.makeScheduler(1);
      sched.runSync(0, 5000);
      const turnsOf = (j) => j.split('\n').filter((l) => l.includes('"t":"turn"')).join('\n');
      assert.equal(turnsOf(sched.toJSONL()), turnsOf(rp.json.record), '重播的每回合意图与哈希都与记录一致');
      const mid = pb.makeScheduler(Math.floor(pb.endTurn / 2));
      assert.equal(mid.state.turn, Math.floor(pb.endTurn / 2), '跳到中间回合');
      assert.equal(seatLabelsOf(pb.meta)[0].label, 'WorkBuddy');
      assert.equal((await s.http('GET', `/api/v1/matches/${gameId}/replay`, { token: await s.guest() })).status, 404, '别人看不到');
      const rep = await s.tool(T, 'maze_replay', { gameId, detail: 'full' });
      assert.match(rep.text, /## 复盘[\s\S]*逐条决策/);
      assert.equal((await s.tool(T, 'maze_decide', { gameId, decision: d0() })).text.includes('结束'), true, '结束后再提交只回结果');
    }
    const hist = await s.tool(T, 'maze_history');
    assert.equal((hist.text.match(/^- [a-f0-9]{32}/gm) || []).length, 2);
    assert.equal(s.store.countAgentNotes((await s.http('GET', '/api/v1/me', { token: A })).json.userId), 2, '服务器自留两份摘要');
    // 别人看不到这些对局
    const B = (await s.http('POST', '/api/v1/mcp/token', { token: await s.guest(), body: {} })).json.token;
    assert.match((await s.tool(B, 'maze_history')).text, /还没有已结束/);
  } finally {
    await s.close();
  }
});

function d0() {
  return { targetType: 'exit', target: { x: 0, y: 0 }, reason: 'x' };
}

test('不合格决策：带着错误在同一决策点重问一次；参数错误回 isError；同时最多 3 局；maze_query 只给距离', async () => {
  const s = await boot();
  try {
    const T = (await s.http('POST', '/api/v1/mcp/token', { token: await s.guest(), body: {} })).json.token;
    const r = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    const { gameId } = decisionFrom(r.text);
    const bad = await s.tool(T, 'maze_decide', { gameId, decision: { targetType: 'gem', reason: '没写坐标' } });
    assert.match(bad.text, /上一次提交不合格/);
    assert.match(bad.text, /决策点 #1/);
    const fixed = await s.tool(T, 'maze_decide', decisionFrom(bad.text));
    assert.match(fixed.text, /决策点 #2|结束/);
    assert.equal((await s.tool(T, 'maze_new_game', { size: 'XXL' })).isError, true);
    assert.equal((await s.tool(T, 'maze_decide', { gameId: 'zz', decision: d0() })).isError, true);
    const q = await s.tool(T, 'maze_query', { gameId, from: { x: 2, y: 2 }, to: { x: 13, y: 13 } });
    assert.match(q.text, /最短 \d+ 步|走不通/);
    await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    const fourth = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'heuristic' });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /最多 3 局/);
    assert.match((await s.tool(T, 'maze_observe', { gameId })).text, /决策点|结束/);
  } finally {
    await s.close();
  }
});
