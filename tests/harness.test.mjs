// 大模型 harness（批次 6）：契约 v2 解析、博弈事实表、会话 / 备忘 / 目标队列 / 放弃条件 / 闸门行，
// 对局中的会话结局与「由记录重放的复盘时间线」一致，记录照常严格回放，planStats 不把队列 / 放弃 / 闸门算作决策。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { mockPlan } from '../src/ai/mock-llm.js';
import { buildMessages, buildPayload, parsePlan } from '../src/ai/codec.js';
import { buildMemoryMessages, matchDigest, sessionText, timelineFromRecord } from '../src/ai/harness.js';
import { messagesFor } from '../src/app/transport.js';
import { fieldFrom } from '../src/core/nav/bfs.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { verifyRecord, planStats } from '../server/verifier.mjs';

const cfgOf = (size = 'S') => makeConfig(matchOverrides('byok', size));

test('契约 v2 解析：then / abandonIf / memo 可选；写错的后续目标丢掉，不判整条不合格', () => {
  const ok = parsePlan('{"targetType":"gem","target":{"x":3,"y":4},"reason":"r","follow":"yes","then":[{"targetType":"chest","target":{"x":1,"y":2}},{"targetType":"bad"},{"targetType":"exit","target":{"x":0,"y":9}},{"targetType":"gem","target":{"x":5,"y":5}}],"abandonIf":{"rivalLeadBy":99},"memo":"座位 2 在抢红"}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.then, [{ targetType: 'chest', target: { x: 1, y: 2 } }, { targetType: 'exit', target: { x: 0, y: 9 } }]);
  assert.deepEqual(ok.plan.abandonIf, { rivalLeadBy: 50 }, '封顶 50');
  assert.equal(ok.plan.memo, '座位 2 在抢红');
  const plain = parsePlan('{"targetType":"exit","target":{"x":1,"y":1},"reason":"x"}');
  assert.equal(plain.ok, true);
  assert.equal('then' in plain.plan || 'abandonIf' in plain.plan || 'memo' in plain.plan, false);
  const long = parsePlan(`{"targetType":"exit","target":{"x":1,"y":1},"reason":"x","memo":"${'字'.repeat(400)}"}`);
  assert.equal(Array.from(long.plan.memo).length, 300);
});

test('博弈事实表：race 的步数 / 能否回家与 BFS 一致，lead = 最近拿得起的对手 − 我；对手 spare / distToExit；对手动向 heading', () => {
  const cfg = cfgOf('M');
  const m = createMatch(7, cfg);
  const obs = observe(m.map, m.state, 0, cfg, { patch: false, events: [] });
  const N = m.map.size;
  const p = buildPayload(m.map, obs, cfg);
  for (const g of p.gems) {
    const f = fieldFrom(m.map, g.y * N + g.x);
    assert.equal(g.race.length, 3);
    for (const r of g.race) {
      const a = m.state.actors[r.seat];
      assert.equal(r.dist, f[a.y * N + a.x]);
      const [ex, ey] = m.map.exits[r.seat];
      assert.equal(r.back, fieldFrom(m.map, ey * N + ex)[g.y * N + g.x]);
      assert.equal(r.canReturn, a.stamina >= r.dist + r.back);
    }
    const c = g.race.filter((r) => r.canReturn);
    assert.equal(g.lead, c.length ? Math.min(...c.map((r) => r.dist)) - g.dist : null);
  }
  for (const r of p.rivals) {
    assert.equal(typeof r.distToExit, 'number');
    assert.equal(r.spare, r.stamina - r.distToExit);
  }
  // 动向：对手 1 沿最短路朝某颗宝石走了 4 步 → heading 里有它
  const g0 = p.gems[0];
  const f = fieldFrom(m.map, g0.y * N + g0.x);
  const a1 = m.state.actors[1];
  const path = [[a1.x, a1.y]];
  let [x, y] = [a1.x, a1.y];
  for (let k = 0; k < 4; k++) {
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].find(([nx, ny]) => nx >= 0 && ny >= 0 && nx < N && ny < N && f[ny * N + nx] === f[y * N + x] - 1);
    if (!nb) break;
    [x, y] = nb;
    path.push([x, y]);
  }
  const moved = { ...obs, actors: obs.actors.map((o) => (o.seat === 1 ? { ...o, x, y } : o)) };
  const h = buildPayload(m.map, moved, cfg, { history: new Map([[1, path]]) }).rivals.find((r) => r.seat === 1).heading;
  assert.ok(h && h.length <= 2 && h.every((t) => t.closedBy <= path.length - 1), JSON.stringify(h));
  // 只留这一颗宝石（宝箱不在）时，它就是动向
  const only = { ...moved, gems: moved.gems.filter((g) => g.x === g0.x && g.y === g0.y), chest: { present: false } };
  const h1 = buildPayload(m.map, only, cfg, { history: new Map([[1, path]]) }).rivals.find((r) => r.seat === 1).heading;
  assert.ok(h1.some((t) => t.type === 'gem' && t.x === g0.x && t.closedBy === path.length - 1), JSON.stringify(h1));
  assert.equal(buildPayload(m.map, moved, cfg).rivals.find((r) => r.seat === 1).heading, undefined, '没有历史就不给动向');
});

test('提示词：契约 v2 字段说明、经验段、会话在局面之前；对手 AI 的提示词不变', () => {
  const cfg = cfgOf('S');
  const m = createMatch(3, cfg);
  const obs = observe(m.map, m.state, 0, cfg, { patch: true, events: [] });
  const payload = buildPayload(m.map, obs, cfg);
  const [sys, user] = buildMessages(payload, '先凑套', cfg, { autonomy: 'blend', memory: '- lead ≤ -2 别去', session: '## 本局到目前为止\n- T1 …', context: { why: 'start' } });
  assert.match(sys.content, /"then"/);
  assert.match(sys.content, /abandonIf/);
  assert.match(sys.content, /以往对局总结的经验[\s\S]*lead ≤ -2 别去[\s\S]*玩家思路[\s\S]*先凑套/);
  assert.ok(user.content.indexOf('## 本局到目前为止') < user.content.indexOf('局面：'));
  const opp = buildMessages(payload, '风格', cfg);
  assert.doesNotMatch(opp[0].content, /then|abandonIf|经验/);
  assert.ok(opp[1].content.startsWith('局面：'));
});

/** 守规矩的「模型」：模拟大模型的选择 + 契约 v2（下一颗宝石进队列、放弃条件、备忘）。 */
function harnessTransport(log) {
  return (req, reply) => {
    log.push(req);
    const base = JSON.parse(mockPlan(req.payload, req.persona, { contract: true }));
    if (base.targetType === 'gem') {
      const next = req.payload.gems.filter((g) => g.x !== base.target.x || g.y !== base.target.y).sort((a, b) => a.dist - b.dist)[0];
      if (next) base.then = [{ targetType: 'gem', target: { x: next.x, y: next.y } }];
      base.abandonIf = { rivalLeadBy: 1 };
    }
    base.memo = `T${req.requestTurn} 的判断`;
    reply.deliver(JSON.stringify(base));
  };
}

function playHarness(seed, size = 'S', memory = '') {
  const cfg = cfgOf(size);
  const reqs = [];
  let planner;
  const sched = createScheduler(cfg, seed, {
    seatLabels: ['byok:kimi/kimi-k3', 'heuristic', 'heuristic', 'heuristic'],
    players: [{ seat: 0, provider: 'kimi', model: 'kimi-k3', autonomy: 'blend', safetyGate: true, thinking: 'low' }],
    controllers: (m) => {
      planner = createPlanner({ map: m.map, seat: 0, cfg, seed: m.seed, pool: createAgentPool(cfg), persona: '先凑套', autonomy: 'blend', memory, transport: harnessTransport(reqs) });
      return [planner, ...[1, 2, 3].map((i) => createHeuristic(m.map, i, cfg, m.seed))];
    },
  });
  sched.runSync(0, cfg.rules.maxTurns + 10);
  return { cfg, sched, planner, reqs, jsonl: sched.toJSONL() };
}

test('harness 整局：会话与备忘随请求带上；队列接着走不发请求；放弃条件触发即重问；记录严格回放 verified', () => {
  let queued = 0;
  let abandons = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { reqs, jsonl, planner } = playHarness(seed, 'S', '- 经验一条');
    assert.equal(reqs[0].session, '', '第一次决策没有会话');
    const later = reqs.filter((r) => r.kind === 'plan').slice(1);
    assert.ok(later.length > 0);
    for (const r of later) {
      assert.match(r.session, /本局到目前为止/);
      assert.match(r.session, /你上次写给自己的备忘：T\d+ 的判断/);
    }
    assert.equal(reqs[0].memory, '- 经验一条');
    assert.match(messagesFor(reqs[0], cfgOf('S'))[0].content, /经验一条/);
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const plans = lines.filter((l) => l.t === 'plan' && l.seat === 0);
    queued += plans.filter((l) => l.src === 'queue').length;
    abandons += plans.filter((l) => l.src === 'abandon').length;
    for (const l of plans.filter((x) => x.src === 'abandon')) {
      assert.match(l.err, /比我近 \d+ 步/);
      const nextReq = reqs.find((r) => r.requestTurn === l.n && r.kind === 'plan');
      assert.ok(nextReq && nextReq.why === 'abandon', `T${l.n} 放弃后同回合重问`);
    }
    const r = planner.report();
    assert.equal(r.queued, plans.filter((l) => l.src === 'queue').length);
    const v = verifyRecord(jsonl);
    assert.equal(v.verify, 'verified', v.verifyNote);
    const st = planStats(lines).find((x) => x.seat === 0);
    assert.equal(st.decisions, plans.filter((l) => !['queue', 'abandon', 'guard'].includes(l.src)).length, '队列 / 放弃 / 闸门不算决策');
  }
  assert.ok(queued > 0, '六局里至少用上一次目标队列');
  assert.ok(abandons > 0, '六局里至少触发一次放弃条件');
});

test('复盘时间线：由记录重放出的每次决策结局，与对局中给模型看的会话完全一致', () => {
  for (const seed of [1, 2, 3]) {
    const { planner, jsonl, cfg } = playHarness(seed, 'S');
    const live = planner.session().entries;
    const tl = timelineFromRecord(jsonl, cfg, 0);
    assert.equal(tl.entries.length, live.length);
    tl.entries.forEach((e, k) => {
      const l = live[k];
      assert.equal(e.n, l.n);
      assert.equal(e.src, l.src);
      assert.deepEqual(e.target, l.target);
      if (l.outcome !== null) {
        assert.equal(e.outcome, l.outcome, `seed ${seed} 第 ${k} 条 T${e.n}`);
        assert.equal(e.steps, l.steps);
      }
    });
    const s = tl.stats;
    assert.equal(s.got + s.lost + s.abandoned + s.switched + s.guard + s.invalid + s.stale + s.failed + tl.entries.filter((e) => e.outcome === 'home' || e.outcome === 'open').length, tl.entries.length);
    for (const m of tl.mistakes) assert.ok(m.outcome === 'lost' || m.outcome === 'abandoned');
    // 会话文本：最近 N 条原样，更早的折成摘要
    const txt = sessionText(tl.entries, '备忘', 3);
    assert.equal((txt.match(/^- T/gm) || []).length, Math.min(3, tl.entries.length));
    if (tl.entries.length > 3) assert.match(txt, /更早的 \d+ 条/);
  }
});

test('赛后写经验：复盘摘要含结果 / 统计 / 失误；消息要求整份重写、给出字数与旧经验', () => {
  const { jsonl, cfg } = playHarness(2, 'S');
  const tl = timelineFromRecord(jsonl, cfg, 0);
  const end = JSON.parse(jsonl.trim().split('\n').at(-1));
  const digest = matchDigest({ mapSize: 'S', size: cfg.maze.size, turns: end.n, me: end.ranking.find((r) => r.seat === 0), stats: tl.stats, mistakes: tl.mistakes, entries: tl.entries });
  assert.match(digest, /你的结果/);
  assert.match(digest, /白跑共 \d+ 步/);
  const msgs = buildMemoryMessages({ memory: '- 旧条目', strategy: '先凑套', digest, targetChars: 1200, games: 3 });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /不超过 1200 字/);
  assert.match(msgs[1].content, /已累计 3 局[\s\S]*- 旧条目[\s\S]*先凑套[\s\S]*你的结果/);
});
