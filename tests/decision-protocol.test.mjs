// 决策锚点与结果事件（决策协议改造 §14 C4 / C5 / C6，第 3 项）：只记录，不改变任何决定。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { createDecisionLog, OUTCOME_TYPES, sameRef } from '../src/ai/decision-protocol.js';
import { createMatch } from '../src/core/state.js';

const PS = ['balanced', 'setHunter', 'chest', 'cautious'];
const SUBMIT = new Set(['applied', 'invalid', 'failed', 'stale', 'cancelled']);
const END = new Set(['lost', 'reached', 'abandoned', 'replaced', 'interrupted']);

/** 四个规划器跑一局；transport 可换；autonomy 只给座位 0。 */
function run(id, seed, { autonomy = null, transport = null } = {}) {
  const cfg = makeConfig(matchOverrides(autonomy ? 'byok' : 'prompt', id));
  const reqs = [];
  const tp = transport || ((req, reply) => reply.deliver(mockPlan(req.payload, req.persona)));
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      return [0, 1, 2, 3].map((i) => createPlanner({
        map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? autonomy : null,
        transport: (req, reply) => {
          reqs.push({ seat: i, kind: req.kind, dp: req.dp, rev: req.rev, requestTurn: req.requestTurn });
          tp(req, reply);
        },
      }));
    },
  });
  s.runSync(0, 5000);
  return { s, reqs, cfg };
}

/** 一个会触发「放弃」与「安全覆盖」的玩家 AI：总去最远的宝石，abandonIf 0，then 排两个。 */
function greedyFar(req, reply) {
  if (req.seat !== 0) return reply.deliver(mockPlan(req.payload, req.persona));
  const p = req.payload;
  const gems = p.gems.filter((g) => g.dist > 0).sort((a, b) => b.dist - a.dist);
  if (!gems.length) return reply.deliver(JSON.stringify({ targetType: 'exit', target: p.self.exit, reason: '回家', follow: 'yes' }));
  const [g, ...rest] = gems;
  reply.deliver(JSON.stringify({
    targetType: 'gem', target: { x: g.x, y: g.y }, reason: '去最远的', follow: 'yes',
    then: rest.slice(0, 2).map((q) => ({ targetType: 'gem', target: { x: q.x, y: q.y } })), abandonIf: { rivalLeadBy: 0 },
  }));
}

/** 就近连拿：最近的宝石，then 排次近的两个（覆盖 queued）。 */
function chainNear(req, reply) {
  if (req.seat !== 0) return reply.deliver(mockPlan(req.payload, req.persona));
  const p = req.payload;
  const gems = p.gems.filter((g) => g.dist > 0).sort((a, b) => a.dist - b.dist);
  if (!gems.length) return reply.deliver(JSON.stringify({ targetType: 'exit', target: p.self.exit, reason: '回家', follow: 'yes' }));
  const [g, ...rest] = gems;
  reply.deliver(JSON.stringify({
    targetType: 'gem', target: { x: g.x, y: g.y }, reason: '就近', follow: 'yes',
    then: rest.slice(0, 2).map((q) => ({ targetType: 'gem', target: { x: q.x, y: q.y } })),
  }));
}

test('规划器指纹：大模型规划器（mock 回复）对局的录像冻结', () => {
  // 第 3 项冻结于改动前、证明结果事件只记录；第 4 项（SPEC-0.3 零缓冲）有意改变时序，这里换成零缓冲后的值。
  // 之后任何改动让这些值变化 = 改动了大模型座位的行为，须在提交里说明原因。
  const want = [['XS', 5, null, '4532e77a35ad5b0f'], ['XS', 11, 'free', 'ed34f9c47b81292c'], ['M', 7, 'blend', '8c3e549bb6ccc8dc'], ['S', 3, 'strict', '6be4bd61d82dabdb']];
  // 第 6 项（录像 v3）只加了 outcome 行与 plan.dp / rev，行为不变：按 v2 的写法还原后，指纹必须与第 4 项冻结的相同
  const asV2 = (jsonl) => `${jsonl.trim().split('\n').map((l) => JSON.parse(l)).filter((L) => L.t !== 'outcome').map((L) => {
    if (L.t === 'meta') return JSON.stringify({ ...L, v: 2 });
    if (L.t !== 'plan') return JSON.stringify(L);
    const { dp, rev, ...rest } = L;
    return JSON.stringify(rest);
  }).join('\n')}\n`;
  for (const [id, seed, autonomy, hash] of want) {
    const { s } = run(id, seed, { autonomy });
    assert.equal(createHash('sha256').update(asV2(s.toJSONL())).digest('hex').slice(0, 16), hash, `${id} 种子 ${seed} ${autonomy}`);
  }
});

test('决策点：每座位从 1 递增；不合格重交沿用 dp、rev + 1', () => {
  let bad = 0;
  const flaky = (req, reply) => {
    if (req.seat === 0 && req.kind === 'plan' && req.dp % 2 === 1) {
      bad++;
      return reply.deliver('这不是 JSON');
    }
    reply.deliver(mockPlan(req.payload, req.persona));
  };
  const { reqs, s } = run('XS', 5, { transport: flaky });
  assert.ok(bad > 0);
  for (const seat of [0, 1, 2, 3]) {
    const plans = reqs.filter((r) => r.seat === seat && r.kind === 'plan');
    assert.deepEqual(plans.map((r) => r.dp), plans.map((_, i) => i + 1), `座位 ${seat} dp 连续`);
    assert.ok(plans.every((r) => r.rev === 0));
    assert.equal(s.controllers[seat].decisionPoints, plans.length);
  }
  const repairs = reqs.filter((r) => r.kind === 'repair');
  assert.ok(repairs.length > 0);
  for (const r of repairs) {
    const orig = reqs.find((q) => q.seat === r.seat && q.kind === 'plan' && q.dp === r.dp);
    assert.ok(orig, 'repair 对应一个原请求');
    assert.equal(r.rev, 1);
    assert.equal(r.requestTurn, orig.requestTurn);
  }
});

/** 一个座位的结果事件是否自洽：每个 dp 恰好一个提交结果且排第一；执行中的事件带原因参数；结束后只能被队列接续。 */
function checkSeat(events, frames, seat) {
  const byDp = new Map();
  for (const e of events) {
    assert.ok(OUTCOME_TYPES.includes(e.type), `未知类型 ${e.type}`);
    assert.ok(Object.isFrozen(e));
    if (!byDp.has(e.dp)) byDp.set(e.dp, []);
    byDp.get(e.dp).push(e);
  }
  for (let i = 1; i < events.length; i++) assert.ok(events[i].k >= events[i - 1].k, '帧号不减');
  for (const [dp, list] of byDp) {
    assert.ok(SUBMIT.has(list[0].type), `dp ${dp} 第一条应是提交结果，实际 ${list[0].type}`);
    assert.equal(list.filter((e) => SUBMIT.has(e.type)).length, 1, `dp ${dp} 只有一个提交结果`);
    let open = list[0].type === 'applied';
    for (const e of list) {
      switch (e.type) {
        case 'applied': assert.equal(e.effectiveTurn, e.k + 1); assert.ok(e.ref); break;
        case 'invalid': case 'failed': case 'stale': assert.equal(typeof e.why, 'string'); break;
        case 'guard': assert.ok(e.dist >= 0 && e.back >= 0 && e.stamina < e.dist + e.back, 'guard 原因：体力不够去再回'); break;
        case 'abandoned': assert.ok(Number.isInteger(e.seat) && e.lead >= e.need); break;
        case 'lost': case 'reached': {
          const f = frames.get(seat, e.k);
          if (e.ref.type === 'exit') {
            assert.equal(e.type, 'reached');
            assert.equal(f.seats.find((a) => a.seat === seat).status, 'escaped');
          } else {
            const hit = f.events.find((x) => (x.type === 'pickup' || x.type === 'chest') && x.x === e.ref.x && x.y === e.ref.y);
            assert.ok(hit, `帧 ${e.k} 有对应的拾取 / 开箱`);
            assert.equal(hit.seat === seat, e.type === 'reached');
            if (e.type === 'lost') assert.equal(e.by, hit.seat);
          }
          break;
        }
        case 'replaced': assert.ok(e.by > dp, 'replaced 指向更晚的决策点'); break;
        default: break;
      }
      if (e.type === 'queued') {
        assert.ok(!open, '接续前上一个目标已结束');
        open = true;
      } else if (END.has(e.type)) {
        assert.ok(open, `dp ${dp} ${e.type} 之前应有在执行的目标`);
        open = false;
      } else if (e.type === 'guard') assert.ok(open);
    }
  }
  return byDp;
}

test('结果事件：自洽、带原因参数，拿到 / 被抢与帧里的拾取逐条对得上', () => {
  const seen = new Map();
  for (const [id, seed, autonomy, transport] of [['XS', 5, null, null], ['XS', 11, 'free', greedyFar], ['M', 7, 'free', greedyFar], ['S', 3, 'blend', null], ['XS', 9, 'free', chainNear], ['M', 4, 'free', chainNear]]) {
    const { s } = run(id, seed, { autonomy, transport });
    for (const seat of [0, 1, 2, 3]) {
      const c = s.controllers[seat];
      checkSeat(c.outcomes, s.frames, seat);
      for (const e of c.outcomes) seen.set(e.type, (seen.get(e.type) || 0) + 1);
      assert.equal(c.outcomes.filter((e) => e.type === 'stale').length, c.status().stats.stale, '与 stats.stale 一致');
    }
  }
  for (const t of ['applied', 'reached', 'lost', 'queued', 'abandoned', 'replaced', 'guard']) assert.ok(seen.get(t) > 0, `覆盖到 ${t}`);
});

test('目标身份：同坐标的新一代宝石是另一个实例；刷新那回合被拾取的宝石算上一代', () => {
  const { map } = createMatch(1, makeConfig(matchOverrides('prompt', 'XS')));
  const base = { seat: 0, seats: [{ seat: 0, x: 1, y: 1, status: 'active' }, { seat: 1, x: 3, y: 4, status: 'active' }], chest: null };
  const log = createDecisionLog(map, 0);
  log.onFrame({ ...base, k: 0, events: [], gems: [[2, 3, 4], [0, 9, 9]], gen: 1 });
  const r1 = log.ref('gem', { x: 3, y: 4 });
  assert.deepEqual(r1, { type: 'gem', gen: 1, x: 3, y: 4, c: 2 });
  log.push('applied', 1, 0, { ref: r1 });
  log.bind(1, r1);
  // 第 1 回合：座位 1 拿走它，同回合整批刷新，新一代恰好也有 (3,4)
  log.onFrame({ ...base, k: 1, events: [{ type: 'pickup', seat: 1, color: 2, x: 3, y: 4 }, { type: 'gemRespawn', generation: 2 }], gems: [[2, 3, 4]], gen: 2 });
  assert.deepEqual(log.events.map((e) => e.type), ['applied', 'lost']);
  assert.equal(log.events[1].by, 1);
  const r2 = log.ref('gem', { x: 3, y: 4 });
  assert.equal(r2.gen, 2);
  assert.ok(!sameRef(r1, r2), '同坐标的新一代宝石是另一个实例');
  // 绑到旧实例的话，新一代被拾取不会算到它头上
  log.bind(1, r1);
  log.onFrame({ ...base, k: 2, events: [{ type: 'pickup', seat: 0, color: 2, x: 3, y: 4 }], gems: [], gen: 2 });
  assert.equal(log.events.length, 2);
  log.bind(2, r2);
  log.onFrame({ ...base, k: 3, events: [{ type: 'pickup', seat: 0, color: 2, x: 3, y: 4 }], gems: [], gen: 2 });
  assert.equal(log.events[2].type, 'reached');
  assert.equal(log.events[2].dp, 2);
});

test('宝箱序号：开局有宝箱为第 1 只，每次刷新 + 1', () => {
  const { map } = createMatch(1, makeConfig(matchOverrides('prompt', 'XS')));
  const base = { seat: 0, seats: [{ seat: 0, x: 1, y: 1, status: 'active' }], gems: [], gen: 1 };
  const log = createDecisionLog(map, 0);
  log.onFrame({ ...base, k: 0, events: [], chest: [5, 5] });
  assert.equal(log.ref('chest', { x: 5, y: 5 }).spawn, 1);
  log.onFrame({ ...base, k: 1, events: [{ type: 'chest', seat: 0, x: 5, y: 5 }], chest: null });
  log.onFrame({ ...base, k: 2, events: [{ type: 'chestRespawn', x: 7, y: 2 }], chest: [7, 2] });
  assert.equal(log.ref('chest', { x: 7, y: 2 }).spawn, 2);
});
