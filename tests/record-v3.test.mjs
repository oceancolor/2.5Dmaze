// 录像 v3 与帧重建（决策协议改造 §14 C9，第 6 项）：
//   v3 记录严格回放 + 服务器校验通过；重建帧与对局中实时帧逐字段一致；录像里的结果事件与对局中一致（所有大模型座位）；
//   旧格式（SPEC-0.1 v2）仍能校验与回放、重建只给帧；XL 整局四个大模型座位录像 < 1 MiB；
//   MCP：已入库对局的 maze_frames、maze_replay timeline，只有本人读得到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { spec01Config } from '../src/config/legacy.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { replay } from '../src/record/replayer.js';
import { framesFromRecord } from '../src/record/frame-replay.js';
import { RECORD_VERSION } from '../src/record/recorder.js';
import { verifyRecord, parseRecord } from '../server/verifier.mjs';
import { openStore } from '../server/store/db.mjs';
import { createApp } from '../server/app.mjs';
import { CLIENT_VERSION } from '../src/app/version.js';

const PS = ['balanced', 'setHunter', 'chest', 'cautious'];
const answer = (req, reply) => reply.deliver(mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) }));

function plannerGame(size, seed, { autonomy = 'free', cfg = makeConfig(matchOverrides(autonomy ? 'byok' : 'prompt', size)) } = {}) {
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      return [0, 1, 2, 3].map((i) => createPlanner({ map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? autonomy : null, transport: answer }));
    },
  });
  s.runSync(0, 5000);
  return { s, cfg };
}

const linesOf = (jsonl) => jsonl.trim().split('\n').map((l) => JSON.parse(l));

test('录像 v3：版本号、plan 行带 dp、所有大模型座位的 outcome 行；严格回放与服务器校验通过', () => {
  for (const [size, seed, autonomy] of [['XS', 4, 'free'], ['S', 8, 'blend'], ['M', 2, null]]) {
    const { s, cfg } = plannerGame(size, seed, { autonomy });
    const jsonl = s.toJSONL();
    const L = linesOf(jsonl);
    assert.equal(L[0].v, RECORD_VERSION);
    assert.equal(RECORD_VERSION, 3);
    assert.ok(replay(jsonl, cfg).complete);
    const v = verifyRecord(jsonl);
    assert.equal(v.verify, 'verified', v.verifyNote);
    const llmPlans = L.filter((x) => x.t === 'plan' && x.src.startsWith('llm'));
    assert.ok(llmPlans.length && llmPlans.every((p) => Number.isInteger(p.dp)), 'plan 行带 dp');
    // 录像里的 outcome 行 = 对局中各座位的结果事件（逐条、同序）
    for (const seat of [0, 1, 2, 3]) {
      const rec = L.filter((x) => x.t === 'outcome' && x.seat === seat).map(({ t, seat: _, ...e }) => e);
      assert.deepEqual(rec, s.controllers[seat].outcomes.map((e) => ({ ...e })), `${size} 座位 ${seat}`);
      assert.ok(rec.length > 0);
    }
    // outcome 行都在 end 行之前、帧号不超过终局
    assert.equal(L.at(-1).t, 'end');
    assert.ok(L.filter((x) => x.t === 'outcome').every((x) => x.k <= L.at(-1).n));
  }
});

test('帧重建：从录像重建的帧与对局中实时帧逐字段一致；结果事件取自录像（anchors recorded）', () => {
  for (const [size, seed] of [['XS', 4], ['M', 2]]) {
    const { s, cfg } = plannerGame(size, seed);
    const r = framesFromRecord(s.toJSONL(), cfg, [0, 1, 2, 3]);
    assert.equal(r.anchors, 'recorded');
    assert.equal(r.endTurn, s.state.endTurn);
    for (const seat of [0, 1, 2, 3]) {
      assert.deepEqual(r.frames.range(seat, 0, Infinity), s.frames.range(seat, 0, Infinity), `${size} 座位 ${seat} 帧`);
      assert.deepEqual(r.outcomes.get(seat), s.controllers[seat].outcomes.map((e) => ({ ...e })));
    }
  }
});

test('旧格式：SPEC-0.1（v2，无 outcome 行）仍能校验与回放；重建只给帧，锚点标为推导；v2 不得出现 outcome 行', () => {
  const cfg = spec01Config('script', 'S', 'radius');
  const s = createScheduler(cfg, 'legacy-1', { controllers: (m) => [0, 1, 2, 3].map((i) => createHeuristic(m.map, i, cfg, m.seed)) });
  s.runSync(0, 5000);
  const lines = s.toJSONL().trim().split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), v: 2 }); // 当时的客户端写的是 v2
  const v2 = `${lines.join('\n')}\n`;
  const v = verifyRecord(v2);
  assert.equal(v.verify, 'verified', v.verifyNote);
  assert.equal(v.meta.rulesVersion, 'SPEC-0.1');
  const r = framesFromRecord(v2, cfg, [0]);
  assert.equal(r.anchors, 'derived');
  assert.deepEqual(r.outcomes.get(0), []);
  assert.equal(r.frames.lastK(0), s.state.endTurn);
  const forged = `${[...lines.slice(0, -1), JSON.stringify({ t: 'outcome', seat: 0, dp: 1, type: 'applied', k: 0 }), lines.at(-1)].join('\n')}\n`;
  assert.throws(() => parseRecord(forged), /不该有 outcome/);
});

test('校验器：outcome 行形状检查（未知类型 / 座位越界 / 缺 dp 拒绝）；篡改 outcome 行不影响 verified（只是自报信息）', () => {
  const { s } = plannerGame('XS', 4);
  const L = s.toJSONL().trim().split('\n');
  const at = L.findIndex((l) => l.includes('"t":"outcome"'));
  const swap = (o) => `${L.map((l, i) => (i === at ? JSON.stringify(o) : l)).join('\n')}\n`;
  const base = JSON.parse(L[at]);
  for (const bad of [{ ...base, type: 'win' }, { ...base, seat: 9 }, { ...base, dp: undefined }, { ...base, k: -1 }]) {
    assert.throws(() => parseRecord(swap(bad)), /outcome 字段不合法/);
  }
  assert.equal(verifyRecord(swap({ ...base, type: 'lost', by: 3 })).verify, 'verified');
});

test('体积：XL 整局四个大模型座位（含玩家契约模式）的录像压缩前 < 1 MiB', () => {
  const { s } = plannerGame('XL', 7);
  assert.ok(s.state.ended);
  const bytes = Buffer.byteLength(s.toJSONL());
  assert.ok(bytes < 1024 * 1024, `XL 录像 ${bytes} 字节`);
  const outcomes = linesOf(s.toJSONL()).filter((x) => x.t === 'outcome').length;
  assert.ok(outcomes > 50, `XL 结果事件 ${outcomes} 条`);
});

async function boot() {
  const store = await openStore(':memory:');
  const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const limits = { mcpBurst: 1e6, mcpPerMinute: 1e6, ipPerMinute: 1e6 };
  const clock = { t: 1_800_000_000_000 };
  const server = createServer(createApp({ store, root: ROOT, now: () => clock.t, options: { masterKey: randomBytes(32), limits } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, token, body) => (await fetch(base + path, {
    method, headers: { 'X-Maze-Client': `web/${CLIENT_VERSION}`, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })).json();
  const user = async () => (await http('POST', '/api/v1/mcp/token', (await http('POST', '/api/v1/guest', null, {})).token, {})).token;
  let rid = 0;
  const tool = async (T, name, args = {}) => {
    const r = (await http('POST', '/mcp', T, { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } })).result;
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  return { clock, store, user, tool, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) };
}
const block = (text) => JSON.parse(/```json\n(.+)\n```\s*$/.exec(text)[1]);

test('MCP：已入库对局的 maze_frames（录像重建）与实时帧一致；maze_replay timeline 标出决策点与结果；别人读不到', async () => {
  const s = await boot();
  try {
    const T = await s.user();
    let r = await s.tool(T, 'maze_new_game', { size: 'XS', opponents: 'aware' });
    const gameId = /对局 ([a-f0-9]{32})/.exec(r.text)[1];
    while (!/结束（第 \d+ 回合）/.test(r.text)) {
      const payload = JSON.parse(r.text.slice(r.text.indexOf('局面：') + 3).split('\n本次决策：')[0]);
      r = await s.tool(T, 'maze_decide', { gameId, decisionPointId: block(r.text).decisionPointId, decision: JSON.parse(mockPlan(payload, '', { contract: true })) });
    }
    // 刚结束：对局还在内存里 → 实时帧
    const live = block((await s.tool(T, 'maze_frames', { gameId })).text);
    assert.equal(live.anchors, 'recorded');
    assert.ok(s.store.matchRow(gameId), '已入库');
    // 闲置 7 小时后宿主清理了这局：只剩入库的录像 → 从录像重建，结果与实时帧一致
    s.clock.t += 7 * 3600 * 1000;
    assert.equal((await s.tool(T, 'maze_observe', { gameId })).isError, true, '内存里已经没有这局');
    const rebuilt = block((await s.tool(T, 'maze_frames', { gameId })).text);
    assert.equal(rebuilt.anchors, 'recorded');
    assert.deepEqual(rebuilt.items, live.items, '录像重建的帧 = 实时帧（含 aim）');
    const timeline = await s.tool(T, 'maze_replay', { gameId, detail: 'timeline' });
    assert.equal(timeline.isError, false, timeline.text);
    const tb = block(timeline.text);
    assert.equal(tb.anchors, 'recorded');
    assert.deepEqual(tb.items, live.items.map(({ k, seats, events, aim }) => ({ k, seats, events, aim })), 'timeline 逐帧 = 实时帧');
    assert.ok(tb.points.length >= 2 && tb.points[0].dp === 1 && tb.points[0].k === 0);
    assert.ok(tb.outcomes.some((e) => e.type === 'applied'));
    assert.match(timeline.text, /### 决策点与结果[\s\S]*dp-1 · 帧 0/);
    assert.equal((await s.tool(T, 'maze_replay', { gameId })).isError, false, 'summary 仍可用');
    const B = await s.user();
    assert.equal((await s.tool(B, 'maze_replay', { gameId, detail: 'timeline' })).isError, true, '别人读不到 timeline');
    assert.equal((await s.tool(B, 'maze_frames', { gameId })).isError, true, '别人读不到帧');
  } finally {
    await s.close();
  }
});
