// 提示词与文案对齐（决策协议改造 §14 C7 / C10，第 7 项）：
//   网页所有大模型座位（对手与玩家自己的 AI）的提示词都带「上次决策以来」，与 MCP 同一份帧段；
//   规则文字（决策时序、then 清空、abandonIf ≥ k 每个行动回合检查）；对话导出带决策点与结果事件；提示词增量有上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { messagesFor } from '../src/app/transport.js';
import { buildTalkExport, talkEntry } from '../src/app/talk-export.js';
import { MAX_PACKET_FRAMES } from '../src/ai/decision-packet.js';

const PS = ['balanced', 'setHunter', 'chest', 'cautious'];

function run(size, seed, transport = null) {
  const cfg = makeConfig(matchOverrides('byok', size));
  const reqs = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      return [0, 1, 2, 3].map((i) => createPlanner({
        map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? 'free' : null,
        transport: (req, reply) => {
          reqs.push(req);
          if (transport) transport(req, reply);
          else reply.deliver(mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) }));
        },
      }));
    },
  });
  s.runSync(0, 5000);
  return { s, cfg, reqs };
}

test('规则文字：两种提示词都有决策时序；契约写明 then 何时清空、abandonIf 是「≥ k」且每个行动回合检查', () => {
  const { cfg, reqs } = run('XS', 5);
  const sys = (seat) => messagesFor(reqs.find((r) => r.seat === seat), cfg)[0].content;
  for (const seat of [0, 1]) {
    assert.match(sys(seat), /决策时序：每次轮到你决策时[\s\S]*从下一回合起立即执行/);
    assert.match(sys(seat), /更早的在「上次决策以来」里/);
  }
  assert.match(sys(0), /abandonIf 是两次决策之间唯一的自动止损/);
  assert.match(sys(0), /近 ≥ k 步就放弃」；引擎每个行动回合检查，触发后清空 then/);
  assert.match(sys(0), /主目标被别人拿走或 abandonIf 触发时，整条 then 清空/);
  assert.doesNotMatch(sys(0), /k 步以上|每回合检查，触发后立刻/);
  assert.doesNotMatch(sys(1), /abandonIf|then/, '对手提示词没有契约字段');
});

test('轨迹：对手与玩家的 AI 都带「上次决策以来」（在局面前面）；首个决策点是开局；帧段首尾相接；修复重交沿用同一段', () => {
  let flaky = 0;
  const { s, cfg, reqs } = run('S', 3, (req, reply) => {
    if (req.seat === 1 && req.kind === 'plan' && req.dp === 2 && !flaky++) return reply.deliver('不是 JSON');
    reply.deliver(mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) }));
  });
  assert.ok(s.state.ended);
  for (const seat of [0, 1, 2, 3]) {
    const plans = reqs.filter((r) => r.seat === seat && r.kind === 'plan');
    assert.ok(plans.length >= 3);
    plans.forEach((r, i) => {
      const user = messagesFor(r, cfg)[1].content;
      assert.ok(user.indexOf('### 上次决策以来') >= 0 && user.indexOf('### 上次决策以来') < user.indexOf('局面：'), `座位 ${seat} dp-${r.dp}`);
      assert.equal(r.packet.frames.to, r.requestTurn - 1);
      if (i === 0) {
        assert.deepEqual([r.packet.frames.from, r.packet.frames.to], [0, 0]);
        assert.match(user, /（开局，还没有人行动）/);
      } else {
        assert.equal(r.packet.frames.from, plans[i - 1].packet.frames.to + 1, '首尾相接');
        assert.ok(r.packet.lastDecisionOutcome.every((e) => e.dp >= plans[i - 1].dp && e.dp < r.dp));
        assert.match(user, /逐回合（seats\[i\]/);
      }
      assert.ok(r.packet.frames.items.length <= MAX_PACKET_FRAMES);
    });
    // MCP 用 trajectory:false 自己排版：不带这段
    assert.doesNotMatch(messagesFor(plans[1], cfg, { trajectory: false })[1].content, /上次决策以来/);
  }
  const repair = reqs.find((r) => r.seat === 1 && r.kind === 'repair');
  const orig = reqs.find((r) => r.seat === 1 && r.kind === 'plan' && r.dp === repair.dp);
  assert.equal(repair.trajectory, orig.trajectory, '修复重交沿用同一段轨迹');
});

test('同源：轨迹里的逐回合位置与调度器的帧一致', () => {
  const { s, reqs } = run('XS', 9);
  for (const r of reqs.filter((x) => x.kind === 'plan' && x.packet.frames.to > 0)) {
    for (const it of r.packet.frames.items) {
      const f = s.frames.get(r.seat, it.k);
      assert.deepEqual(it.seats, f.seats.map((a) => [a.x, a.y, a.stamina, a.score, a.status]));
    }
  }
});

test('体积：每次请求平均增加 < 1500 字符、单次 < 8000（XS / M）', () => {
  for (const size of ['XS', 'M']) {
    const { cfg, reqs } = run(size, 31);
    const added = reqs.map((r) => messagesFor(r, cfg)[1].content.length - messagesFor(r, cfg, { trajectory: false })[1].content.length);
    const avg = added.reduce((a, b) => a + b, 0) / added.length;
    assert.ok(avg < 1500, `${size} 平均 +${Math.round(avg)}`);
    assert.ok(Math.max(...added) < 8000, `${size} 最多 +${Math.max(...added)}`);
  }
});

test('对话导出：调用行带 dp / rev；计划行带 dp；录像 v3 的结果事件导出为 result 行（只取本座位）', () => {
  const { s, reqs } = run('XS', 5);
  const calls = reqs.filter((r) => r.seat === 0).map((r) => talkEntry({ ok: true, kind: r.kind, id: r.id, dp: r.dp, rev: r.rev, requestTurn: r.requestTurn, messages: [], text: '{}' }));
  const out = buildTalkExport({ meta: { matchId: 'm' }, calls, recordJSONL: s.toJSONL(), seat: 0, exportedAt: 1 }).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(out.filter((l) => l.t === 'call').every((l) => Number.isInteger(l.dp) && l.rev === 0));
  assert.ok(out.filter((l) => l.t === 'outcome' && l.src.startsWith('llm')).every((l) => Number.isInteger(l.dp)));
  const results = out.filter((l) => l.t === 'result');
  assert.deepEqual(results, s.controllers[0].outcomes.map((e) => ({ t: 'result', ...e })));
});
