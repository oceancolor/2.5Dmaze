// 决策帧（决策协议改造 §14 C1 / C7，第 2 项）：只采集，不改变任何对局结果。
// 断言：帧号连续（0 … 终局）、与决策观察同源、与独立重演逐字段一致、不越过可见性规则、采不采帧结果逐字节相同。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { visionOverrides } from '../src/config/vision-modes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { mockPlan, PERSONAS } from '../src/ai/mock-llm.js';
import { createFrameLog, frameTurn, toFrame } from '../src/ai/decision-frames.js';
import { createMatch } from '../src/core/state.js';
import { step } from '../src/core/game.js';
import { observe } from '../src/core/observe.js';
import { decodeIntents } from '../src/record/recorder.js';

const XS = makeConfig(matchOverrides('prompt', 'XS'));
const XS_MANUAL = makeConfig(matchOverrides('manual', 'XS'));
const syncMock = (req, reply) => reply.deliver(mockPlan(req.payload, req.persona));

function plannerMatch(seed, opts = {}) {
  const s = createScheduler(XS, seed, {
    ...opts,
    controllers: (m) => {
      const pool = createAgentPool(XS);
      return [0, 1, 2, 3].map((i) => createPlanner({ map: m.map, seat: i, cfg: XS, seed: m.seed, pool, persona: PERSONAS.balanced.text, transport: syncMock }));
    },
  });
  s.runSync(0, 5000);
  return s;
}

function heuristicMatch(seed, cfg, opts = {}) {
  const s = createScheduler(cfg, seed, { ...opts, controllers: (m) => [0, 1, 2, 3].map((i) => createHeuristic(m.map, i, cfg, m.seed)) });
  s.runSync(0, 5000);
  return s;
}

/** 从记录独立重演：逐回合 step + observe，得到每座位的期望帧。 */
function framesFromRecord(jsonl, cfg, seat) {
  const lines = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { map, state: s0 } = createMatch(lines[0].seed, cfg);
  let state = s0;
  const out = [toFrame(observe(map, state, seat, cfg, { patch: false, events: [] }), 0)];
  for (const L of lines) {
    if (L.t !== 'turn') continue;
    const r = step(map, state, decodeIntents(L.i), cfg);
    state = r.state;
    out.push(toFrame(observe(map, state, seat, cfg, { patch: false, events: r.events }), L.n));
  }
  return out;
}

test('帧号：frame(0) 是开局，之后每回合一帧连续到终局；frameTurn 换算与之一致', () => {
  const s = plannerMatch(5);
  assert.ok(s.state.ended);
  const F = s.frames;
  assert.deepEqual(F.seats, [0, 1, 2, 3], '大模型规划器座位自动采集');
  for (const seat of F.seats) {
    assert.equal(F.lastK(seat), s.state.endTurn, `座位 ${seat} 终局帧号 = 终局回合`);
    const all = F.range(seat, 0, Infinity);
    all.forEach((f, k) => assert.equal(f.k, k, `座位 ${seat} 帧 ${k} 连续`));
    assert.deepEqual(all[0].events, [], '开局帧没有事件');
    assert.ok(all[all.length - 1].seats.every((a) => a.status !== 'active'), '终局帧里没有在场者');
  }
  assert.equal(frameTurn(s.state), s.state.endTurn);
  assert.equal(frameTurn(createMatch(5, XS).state), 0);
});

test('同源：控制器在第 t 回合拿到的观察，投影后正是 frame(t-1)', () => {
  const seen = new Map();
  const s = createScheduler(XS_MANUAL, 8, {
    controllers: (m) => [0, 1, 2, 3].map((i) => {
      const h = createHeuristic(m.map, i, XS_MANUAL, m.seed);
      return i !== 0 ? h : {
        wantsFrames: true,
        begin(obs, turn) { seen.set(turn, obs); },
        decide: (obs, turn) => h.decide(obs, turn),
      };
    }),
  });
  s.runSync(0, 5000);
  assert.deepEqual(s.frames.seats, [0]);
  assert.ok(seen.size > 10);
  for (const [turn, obs] of seen) assert.deepEqual(toFrame(obs, turn - 1), s.frames.get(0, turn - 1), `第 ${turn} 回合`);
});

test('同源：帧与独立重演逐字段一致；同回合被拿走的宝石不在该帧目标表里', () => {
  const s = heuristicMatch(3, XS_MANUAL, { frames: true });
  const jsonl = s.toJSONL();
  let pickups = 0;
  for (const seat of [0, 1, 2, 3]) {
    const want = framesFromRecord(jsonl, XS_MANUAL, seat);
    assert.deepEqual(s.frames.range(seat, 0, Infinity), want, `座位 ${seat}`);
    for (const f of want) {
      if (f.events.some((e) => e.type === 'gemRespawn')) continue;
      for (const e of f.events.filter((x) => x.type === 'pickup')) {
        pickups++;
        assert.ok(!f.gems.some(([c, x, y]) => c === e.color && x === e.x && y === e.y), `帧 ${f.k} 拾取的宝石不应还在`);
      }
    }
  }
  assert.ok(pickups > 0, '对局里有拾取');
});

test('不越权：帧只有公开字段；视野半径规则下看不见的对手没有坐标', () => {
  const SEAT_KEYS = new Set(['seat', 'x', 'y', 'stamina', 'score', 'status', 'gems', 'seen']);
  const s = plannerMatch(5);
  for (const seat of s.frames.seats) {
    for (const f of s.frames.range(seat, 0, Infinity)) {
      assert.deepEqual(Object.keys(f).sort(), ['chest', 'events', 'gems', 'gen', 'k', 'seat', 'seats']);
      for (const a of f.seats) for (const k of Object.keys(a)) assert.ok(SEAT_KEYS.has(k), `多余字段 ${k}`);
      const self = f.seats.find((a) => a.seat === seat);
      for (const a of f.seats) {
        if (a.seat !== seat && self.status === 'active' && a.status === 'active') assert.notEqual(a.x, null, '全公开规则下在场对手可见');
      }
      for (const e of f.events) {
        if (['bump', 'blocked', 'invalidIntent'].includes(e.type)) assert.equal(e.seat, seat, '撞墙 / 受阻只给自己');
      }
    }
  }
  const text = JSON.stringify(s.frames.range(0, 0, Infinity));
  for (const w of ['"plan"', '"then"', '"abandonIf"', '"rng"', '"memory"', '"persona"']) assert.ok(!text.includes(w), `帧里不应出现 ${w}`);

  const R = makeConfig({ ...matchOverrides('manual', 'XS'), ...visionOverrides('radius') });
  const r = heuristicMatch(3, R, { frames: true });
  let hidden = 0;
  for (const f of r.frames.range(0, 0, Infinity)) {
    for (const a of f.seats) {
      if (a.seat === 0 || a.x !== null) continue;
      hidden++;
      assert.equal(a.y, null);
    }
  }
  assert.ok(hidden > 0, '视野半径规则下应有看不见的对手');
});

test('采不采帧对局结果逐字节相同；大模型规划器座位总是采帧（结果事件依赖帧）', () => {
  assert.equal(heuristicMatch(3, XS_MANUAL, { frames: true }).toJSONL(), heuristicMatch(3, XS_MANUAL).toJSONL());
  assert.equal(heuristicMatch(3, XS_MANUAL).frames, null, '没有规划器座位就不采');
  assert.equal(plannerMatch(5).toJSONL(), plannerMatch(5, { frames: [] }).toJSONL());
  assert.deepEqual(plannerMatch(5, { frames: [] }).frames.seats, [0, 1, 2, 3]);
});

test('帧缓冲：只能按序追加，帧冻结不可改', () => {
  const log = createFrameLog([2]);
  log.push(2, { k: 0, seats: [{ seat: 2 }] });
  assert.throws(() => log.push(2, { k: 2 }), /不连续/);
  assert.throws(() => log.get(1, 0), /没有采集/);
  const f = log.get(2, 0);
  assert.ok(Object.isFrozen(f) && Object.isFrozen(f.seats[0]));
  assert.deepEqual(log.range(2, -5, 99).map((x) => x.k), [0]);
});
