// 实测反馈采纳（决策协议改造 §14 C14，第 9 项）：规则正文如实（何时被问 + 平局规则）、keep 续走、
// 同目标重交记「续走」而非「被替换」、白跑改为净绕路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { messagesFor } from '../src/app/transport.js';
import { buildMessages, buildPayload, parsePlan, checkContract } from '../src/ai/codec.js';
import { createTracker, outcomeText, timelineFromRecord, wastedOf } from '../src/ai/harness.js';
import { sameRef } from '../src/ai/decision-protocol.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { verifyRecord } from '../server/verifier.mjs';

const PS = ['balanced', 'setHunter', 'chest', 'cautious'];
const cfgOf = (size) => makeConfig(matchOverrides('byok', size));

function run(size, seed, answer) {
  const cfg = cfgOf(size);
  const reqs = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      return [0, 1, 2, 3].map((i) => createPlanner({
        map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? 'free' : null,
        transport: (req, reply) => {
          reqs.push(req);
          reply.deliver(answer(req));
        },
      }));
    },
  });
  s.runSync(0, 5000);
  return { s, cfg, reqs };
}
const mock = (req) => mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) });
const EVENT_WHY = new Set(['sighted', 'refresh', 'blocked', 'lowStamina', 'interval']);

test('规则正文：何时会被问（含与目标无关的事件、冷却 / 预算、定期间隔）+ 平局规则 + keep 写法；数值取自配置', () => {
  const cfg = cfgOf('XS');
  const m = createMatch(1, cfg);
  const p = buildPayload(m.map, observe(m.map, m.state, 0, cfg, { patch: true, events: [] }), cfg);
  const A = cfg.ai;
  for (const [sys, contract] of [[buildMessages(p, '', cfg, { autonomy: 'free' })[0].content, true], [buildMessages(p, '', cfg)[0].content, false]]) {
    assert.match(sys, /什么时候会轮到你决策/);
    assert.match(sys, new RegExp(`同一种事件 ${A.eventCooldownTurns} 回合内不重复，每局最多 ${A.eventBudgetPerAgent} 次`));
    assert.match(sys, /宝石整批刷新或宝箱刷新；有对手进入你 9 格内/);
    assert.match(sys, /这些事件与你的目标无关时也会问你——此时局面没变就回 keep/);
    assert.match(sys, new RegExp(`距上次被问满 ${A.replanInterval} 回合（终盘 ${A.replanIntervalEndgame}`));
    assert.match(sys, /正在回出口时不定期问，但上面的事件照样会问/);
    assert.match(sys, /先比分数，分数相同比剩余体力（多者在前），再相同比到达回合（早者在前）/);
    assert.match(sys, /\{"keep":true/);
    assert.doesNotMatch(sys, /不能中途改主意/);
    if (!contract) assert.doesNotMatch(sys, /then|abandonIf/);
  }
});

test('解析：keep 只带 reason / memo；契约档不要求 follow；格式错误照旧', () => {
  const k = parsePlan('{"keep":true,"reason":"局面没变","memo":"盯紧座位 2","targetType":"gem"}');
  assert.deepEqual(k, { ok: true, plan: { keep: true, reason: '局面没变', memo: '盯紧座位 2' } });
  assert.equal(checkContract(k.plan, 'strict').ok, true);
  assert.equal(parsePlan('{"keep":"yes"}').ok, false);
});

test('keep 续走：目标 / then 原样保留（之后能按 then 接着走）；结果事件 continued → applied(keep)；录像带 keep 标记、校验通过；复盘并入原条目', () => {
  // 玩家 AI：首次就近 + then 两个；之后凡是「与目标无关的事件」都回 keep
  const chain = (req) => {
    const p = req.payload;
    const gems = p.gems.filter((g) => g.dist > 0).sort((a, b) => a.dist - b.dist);
    if (!gems.length) return JSON.stringify({ targetType: 'exit', target: p.self.exit, reason: '回家' });
    const [g, ...rest] = gems;
    return JSON.stringify({ targetType: 'gem', target: { x: g.x, y: g.y }, reason: '就近', then: rest.slice(0, 2).map((q) => ({ targetType: 'gem', target: { x: q.x, y: q.y } })) });
  };
  let kept = 0;
  let queuedAfterKeep = 0;
  for (const seed of [2, 5, 9, 13, 21]) {
    const { s, cfg } = run('XS', seed, (req) => {
      if (req.seat !== 0) return mock(req);
      if (req.kind === 'plan' && req.context && req.context.plan && EVENT_WHY.has(req.why)) return '{"keep":true,"reason":"局面没变"}';
      return chain(req);
    });
    const out = s.controllers[0].outcomes;
    for (const e of out.filter((x) => x.type === 'applied' && x.keep)) {
      kept++;
      const prev = out.find((x) => x.type === 'continued' && x.by === e.dp);
      assert.ok(prev, `dp-${e.dp} 续走前一个决策点应记 continued`);
      assert.ok(sameRef(prev.dp && out.filter((x) => x.dp === prev.dp && x.ref).at(-1).ref, e.ref), '续走的是同一个目标实例');
      if (out.some((x) => x.dp === e.dp && x.type === 'queued')) queuedAfterKeep++;
    }
    assert.ok(!out.some((x) => x.type === 'replaced' && sameRef(out.filter((y) => y.dp === x.dp && y.ref).at(-1).ref, out.find((y) => y.dp === x.by && y.type === 'applied')?.ref)), '换了目标才记 replaced');
    const jsonl = s.toJSONL();
    assert.equal(verifyRecord(jsonl).verify, 'verified');
    const keepLines = jsonl.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.t === 'plan' && l.seat === 0 && l.plan && l.plan.keep);
    assert.equal(keepLines.length, out.filter((x) => x.type === 'applied' && x.keep).length);
    const tl = timelineFromRecord(jsonl, cfg, 0);
    const live = s.controllers[0].session().entries;
    assert.equal(tl.entries.length, live.length, '复盘重放与对局中的会话条目一致');
    assert.equal(tl.stats.kept, keepLines.length + tl.entries.reduce((a, x) => a + (x.kept || 0), 0) - keepLines.length);
    assert.equal(tl.stats.decisions, s.controllers[0].report().applied + s.controllers[0].report().invalid + s.controllers[0].report().failed, '决策次数含续走');
  }
  assert.ok(kept >= 5, `应有若干次续走（实际 ${kept}）`);
  assert.ok(queuedAfterKeep >= 1, '续走后 then 队列仍在：拿到目标后按 then 接着走');
});

test('keep 没有可续走的计划：判不合格、给一次重交机会（同一决策点 rev + 1）', () => {
  const { s, reqs } = run('XS', 5, (req) => {
    if (req.seat === 0 && req.kind === 'plan' && req.why === 'start') return '{"keep":true}';
    return mock(req);
  });
  const repair = reqs.find((r) => r.seat === 0 && r.kind === 'repair');
  assert.ok(repair, '有重交');
  assert.equal(repair.dp, 1);
  assert.equal(repair.rev, 1);
  assert.match(repair.error, /没有在执行的计划可以续走/);
  assert.equal(s.controllers[0].outcomes[0].type, 'applied');
  assert.equal(s.controllers[0].outcomes[0].rev, 1);
});

test('对手座位也能 keep：没有计划时重交、有计划时续走；整局打完、校验通过', () => {
  const { s, reqs, cfg } = run('S', 3, (req) => {
    if (req.seat > 0 && req.kind === 'plan' && EVENT_WHY.has(req.why)) return '{"keep":true,"reason":"续走"}';
    return mock(req);
  });
  assert.ok(s.state.ended);
  const keptOpp = [1, 2, 3].reduce((a, i) => a + s.controllers[i].outcomes.filter((e) => e.type === 'applied' && e.keep).length, 0);
  assert.ok(keptOpp > 0, '对手续走过');
  assert.match(messagesFor(reqs.find((r) => r.seat === 1), cfg)[0].content, /\{"keep":true,"reason":"不超过 30 字"\}/);
  assert.equal(verifyRecord(s.toJSONL()).verify, 'verified');
});

test('口径：交了和当前一样的目标 → 记 continued（不是 replaced）；replaced 一定换了目标', () => {
  let continued = 0;
  let replaced = 0;
  for (const seed of [1, 2, 3, 4]) {
    const { s } = run('XS', seed, mock);
    for (const c of s.controllers) {
      const out = c.outcomes;
      const refOf = (dp) => out.filter((x) => x.dp === dp && x.ref).at(-1)?.ref;
      for (const e of out) {
        const next = out.find((x) => x.dp === e.by && x.type === 'applied');
        if (e.type === 'continued') {
          continued++;
          assert.ok(sameRef(refOf(e.dp), next.ref));
        } else if (e.type === 'replaced') {
          replaced++;
          assert.ok(!sameRef(refOf(e.dp), next.ref));
        }
      }
    }
  }
  assert.ok(continued > replaced, `mock 被问到时多半还选同一个目标（续走 ${continued} / 换目标 ${replaced}）`);
});

test('净绕路：白跑 = 走的步数 − 其间离出口近了的步数；文字写出顺路部分；续走次数并入条目', () => {
  const { map } = createMatch(1, cfgOf('XS'));
  const tr = createTracker(map, 0);
  const obs = (turn, x, d, events = []) => ({ turn, self: { x, y: 1, distToExit: d }, events });
  tr.observe(obs(1, 1, 10));
  tr.start({ n: 1, src: 'llm', targetType: 'gem', target: { x: 9, y: 9 } });
  tr.observe(obs(2, 2, 9));
  tr.observe(obs(3, 3, 8));
  tr.start({ n: 3, src: 'llm', targetType: 'gem', target: { x: 9, y: 9 }, keep: true }); // 续走
  tr.observe(obs(4, 4, 9));
  tr.observe(obs(5, 5, 10));
  tr.observe(obs(6, 6, 9, [{ type: 'pickup', seat: 2, x: 9, y: 9 }]));
  const [e] = tr.entries;
  assert.equal(tr.entries.length, 1, '续走并入原条目');
  assert.equal(e.kept, 1);
  assert.equal(e.steps, 5);
  assert.equal(e.outcome, 'lost');
  assert.equal(wastedOf(e), 4, '走 5 步、离出口近了 1 步 → 白跑 4');
  assert.match(outcomeText(e), /白跑 4 步（走了 5 步，其中 1 步顺路向出口）.*期间续走 1 次/);
  // 一路顺着往家走被抢：不算白跑
  const t2 = createTracker(map, 0);
  t2.observe(obs(1, 1, 10));
  t2.start({ n: 1, src: 'llm', targetType: 'gem', target: { x: 9, y: 9 } });
  for (let k = 2; k <= 4; k++) t2.observe(obs(k, k, 11 - k, k === 4 ? [{ type: 'pickup', seat: 1, x: 9, y: 9 }] : []));
  assert.equal(wastedOf(t2.entries[0]), 0);
  assert.match(outcomeText(t2.entries[0]), /白跑 0 步（走了 3 步，其中 3 步顺路向出口）/);
});
