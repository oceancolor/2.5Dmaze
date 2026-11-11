// SPEC-0.3 零缓冲（决策协议改造 §14 C1 / C2，第 4 项）：
//   首个决策点在帧 0（任何人行动之前）；提交后这一步就朝新目标走；多座位同一回合并行等、等最慢的；
//   超时 / 修复 / 熔断都不会卡死；零缓冲下没有「生效时目标已没了」；接管即作废、交还重问；关局后回调一律忽略。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { replay } from '../src/record/replayer.js';

const cfgOf = (id, mode = 'prompt') => makeConfig(matchOverrides(mode, id));
const XS = cfgOf('XS');
const PS = ['balanced', 'setHunter', 'chest', 'cautious'];
const answer = (req, reply) => reply.deliver(mockPlan(req.payload, req.persona, { contract: Boolean(req.autonomy) }));

function setup(cfg, seed, transport, { autonomy = null, seats = [0, 1, 2, 3] } = {}) {
  const reqs = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => {
      const pool = createAgentPool(cfg);
      return [0, 1, 2, 3].map((i) => (seats.includes(i)
        ? createPlanner({
          map: m.map, seat: i, cfg, seed: m.seed, pool, persona: PERSONAS[PS[i]].text, autonomy: i === 0 ? autonomy : null,
          transport: (req, reply) => {
            reqs.push({ seat: i, req, reply });
            transport(req, reply);
          },
        })
        : createHeuristic(m.map, i, cfg, m.seed)));
    },
  });
  return { s, reqs };
}

test('配置：规划延迟 0（SPEC-0.3 起；当前 SPEC-0.4）', () => {
  assert.equal(XS.rulesVersion, 'SPEC-0.4');
  assert.equal(XS.ai.planLatencyTurns, 0);
});

test('首个决策点在帧 0：请求时所有人都还在出生点，计划在第 1 回合生效', () => {
  const { s, reqs } = setup(XS, 5, answer);
  const spawn = s.state.actors.map((a) => [a.x, a.y]);
  s.runSync(0, 5000);
  for (const seat of [0, 1, 2, 3]) {
    const first = reqs.find((r) => r.seat === seat && r.req.kind === 'plan').req;
    assert.equal(first.requestTurn, 1);
    assert.equal(first.appliedTurn, 1, '零缓冲：请求回合 = 生效回合');
    assert.equal(first.why, 'start');
    assert.deepEqual([first.payload.self.x, first.payload.self.y], spawn[seat], '局面是开局（帧 0）');
    const applied = s.controllers[seat].outcomes.find((e) => e.type === 'applied');
    assert.equal(applied.k, 0);
    assert.equal(applied.effectiveTurn, 1);
  }
  const plans = s.toJSONL().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === 'plan' && l.src.startsWith('llm'));
  assert.ok(plans.length > 0);
  for (const p of plans) assert.equal(p.n, p.req, '每个大模型计划都在发请求的那一回合生效');
});

test('提交后这一步就朝新目标走：生效回合的那一步，目标正是新计划的目标', () => {
  for (const [id, seed] of [['XS', 5], ['S', 3]]) {
    const cfg = cfgOf(id);
    const { s } = setup(cfg, seed, answer);
    const steps = new Map();
    s.on('turn', (l) => steps.set(l.n, l.decisions));
    s.runSync(0, 5000);
    let n = 0;
    for (const seat of [0, 1, 2, 3]) {
      for (const e of s.controllers[seat].outcomes.filter((x) => x.type === 'applied')) {
        const d = steps.get(e.effectiveTurn)[seat];
        if (!d) continue; // 这一回合已离场
        n++;
        assert.ok(d.source.startsWith('llm') || d.source === 'guard', `${id} 座位 ${seat} 第 ${e.effectiveTurn} 回合来源 ${d.source}`);
        if (d.source !== 'guard') assert.deepEqual([d.target.x, d.target.y], [e.ref.x, e.ref.y], `${id} 座位 ${seat} 第 ${e.effectiveTurn} 回合`);
      }
    }
    assert.ok(n > 10);
  }
});

test('零缓冲没有「生效时目标已没了」：多局固定种子 stale = 0（含玩家 AI 契约模式）', () => {
  for (const [id, seed, autonomy] of [['XS', 5, null], ['XS', 11, 'free'], ['S', 3, 'blend'], ['M', 7, 'strict']]) {
    const cfg = cfgOf(id, autonomy ? 'byok' : 'prompt');
    const { s } = setup(cfg, seed, answer, { autonomy });
    s.runSync(0, 5000);
    assert.ok(s.state.ended);
    for (const c of s.controllers) {
      assert.equal(c.status().stats.stale, 0, `${id} 种子 ${seed}`);
      assert.ok(!c.outcomes.some((e) => e.type === 'stale'));
    }
  }
});

test('多座位同一回合并行等：等到最慢的才结算；回复先后顺序不影响结果', () => {
  const sync = setup(XS, 3, answer);
  sync.s.runSync(0, 5000);
  const want = sync.s.toJSONL();

  const pending = [];
  const { s } = setup(XS, 3, (req, reply) => pending.push(() => answer(req, reply)));
  let maxWaiting = 0;
  let order = 0;
  for (let t = 0; t < 200000 && !s.state.ended; t++) {
    if (s.tick(t * 1000)) continue;
    maxWaiting = Math.max(maxWaiting, s.waitingFor.length);
    assert.ok(pending.length > 0, '在等就一定有在途请求');
    // 交替从头 / 从尾回复，打乱先后
    const k = order++ % 2 ? pending.length - 1 : 0;
    pending.splice(k, 1)[0]();
  }
  assert.ok(s.state.ended);
  assert.equal(maxWaiting, 4, '开局四个座位同时在等');
  assert.equal(s.toJSONL(), want);
  assert.ok(replay(s.toJSONL(), XS).complete);
});

test('不卡死：一直超时（修复一次后判失败）、熔断（全体退回启发式）都能打完', () => {
  const timeouts = setup(XS, 9, (req, reply) => reply.fail('timeout'), { seats: [0, 1] });
  timeouts.s.runSync(0, 5000);
  assert.ok(timeouts.s.state.ended);
  const out = timeouts.s.controllers[0].outcomes;
  assert.ok(out.some((e) => e.type === 'failed'), '修复后仍超时 → failed');
  assert.ok(timeouts.reqs.some((r) => r.req.kind === 'repair' && r.req.rev === 1));

  const auth = setup(XS, 9, (req, reply) => reply.fail('auth', 'key 无效'));
  auth.s.runSync(0, 5000);
  assert.ok(auth.s.state.ended);
  assert.ok(auth.s.controllers[0].status().l3, '熔断');
  assert.ok(auth.reqs.length <= 4, `熔断后不再请求（实际 ${auth.reqs.length}）`);
});

test('接管即作废、交还重问：在途请求撤销且晚到的回复被忽略；交还后按当时局面重新问（why resume）', () => {
  const pending = [];
  const { s, reqs } = setup(XS, 5, (req, reply) => pending.push({ req, reply }), { seats: [0] });
  const ai = s.controllers[0];
  s.tick(0);
  assert.deepEqual(s.waitingFor, [0], '开局在等座位 0');
  const first = pending.shift();
  assert.equal(first.req.why, 'start');

  // 接管：在途请求撤销
  s.setPlayerController(createHeuristic(s.map, 0, XS, s.match.seed));
  assert.ok(first.reply.signal.aborted, '撤销信号已发出');
  assert.equal(ai.outcomes.at(-1).type, 'cancelled');
  assert.equal(ai.outcomes.at(-1).cause, 'takeover');
  first.reply.deliver(mockPlan(first.req.payload, first.req.persona)); // 晚到
  for (let t = 1; t <= 6; t++) assert.ok(s.tick(t * 1000), '接管期间不等 AI');
  assert.equal(ai.outcomes.filter((e) => e.type === 'applied').length, 0, '晚到的回复没有生效');
  assert.equal(pending.length, 0, '接管期间 AI 不发请求');

  // 交还：补齐接管期间的帧；下一回合一开始就按当时局面问（本回合已开始过的话当场问）
  const turn = s.state.turn;
  s.setPlayerController(ai);
  assert.equal(ai.frameK, s.frames.lastK(0), '补发了接管期间的帧');
  assert.equal(s.tick(7000), false, '交还后这一回合等 AI');
  const again = pending.shift();
  assert.ok(again, '交还后立即重问');
  assert.equal(again.req.why, 'resume');
  assert.equal(again.req.requestTurn, turn);
  assert.deepEqual([again.req.payload.self.x, again.req.payload.self.y], [s.state.actors[0].x, s.state.actors[0].y], '局面是交还时的');
  assert.equal(again.req.dp, 2);
  assert.deepEqual(s.waitingFor, [0]);
  // 回出口：一步到不了，执行中接管才会被打断
  again.reply.deliver(JSON.stringify({ targetType: 'exit', target: again.req.payload.self.exit, reason: '回家' }));
  assert.ok(s.tick(99000));
  assert.equal(ai.outcomes.at(-1).type, 'applied');
  assert.equal(ai.outcomes.at(-1).dp, 2);

  // 执行中接管：当前计划记为 interrupted
  s.setPlayerController(null);
  assert.equal(ai.outcomes.at(-1).type, 'interrupted');
  assert.equal(ai.outcomes.at(-1).dp, 2);
  assert.ok(reqs.length >= 2);
});

test('关局：在途请求撤销，之后的回复与回合都不再生效', () => {
  const pending = [];
  const { s } = setup(XS, 5, (req, reply) => pending.push({ req, reply }), { seats: [0] });
  s.tick(0);
  const ai = s.controllers[0];
  const p = pending.shift();
  ai.dispose();
  assert.ok(p.reply.signal.aborted);
  p.reply.deliver(mockPlan(p.req.payload, p.req.persona));
  assert.equal(ai.status().thinking, false);
  assert.ok(s.tick(1000), '关掉后不再阻塞');
  assert.equal(pending.length, 0, '关掉后不再发请求');
  ai.dispose();
});
