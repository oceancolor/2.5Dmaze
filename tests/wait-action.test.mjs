// 等待动作（SPEC-0.4，redesign §14 C15，第 10.4 项）：wait / home。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { mockPlan } from '../src/ai/mock-llm.js';
import { parsePlan } from '../src/ai/codec.js';
import { timelineFromRecord } from '../src/ai/harness.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { verifyRecord } from '../server/verifier.mjs';

const AWARE = readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8');
const exitOf = (req) => req.payload.self.exit;

/** 座位 0 = 玩家自己的 AI（answer 决定回复），1–3 = 预判对手。记录请求与每回合座位 0 的状态。 */
function play(size, seed, answer, { cfgOver = null } = {}) {
  const cfg = cfgOver || makeConfig(matchOverrides('byok', size));
  const reqs = [];
  const turns = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => [
      createPlanner({ map: m.map, seat: 0, cfg, seed: m.seed, pool: createAgentPool(cfg), persona: '', autonomy: 'free', transport: (req, reply) => { reqs.push(req); reply.deliver(answer(req, reqs)); } }),
      ...[1, 2, 3].map((i) => createNodeScriptController({ code: AWARE, map: m.map, seat: i, cfg, seed: m.seed })),
    ],
  });
  s.on('turn', (l) => turns.push({ n: l.n, prev: l.prev.actors[0], next: l.next.actors[0], d: l.decisions[0], events: l.events }));
  s.runSync(0, 100000);
  return { s, cfg, reqs, turns, p: s.controllers[0] };
}
const plans = (reqs) => reqs.filter((r) => r.kind === 'plan');
const mock = (req) => mockPlan(req.payload, '', { contract: true });

test('解析：wait / home 的默认值与截断；then 里可写等待', () => {
  assert.deepEqual(parsePlan('{"targetType":"wait","turns":4,"reason":"等刷新"}').plan, { targetType: 'wait', turns: 4, reason: '等刷新' });
  assert.equal(parsePlan('{"targetType":"wait","turns":99}').plan.turns, 10);
  assert.equal(parsePlan('{"targetType":"wait"}').plan.turns, 3);
  assert.equal(parsePlan('{"targetType":"home","stopAt":9}').plan.stopAt, 3);
  assert.equal(parsePlan('{"targetType":"home"}').plan.stopAt, 1);
  const t = parsePlan('{"targetType":"gem","target":{"x":1,"y":2},"then":[{"targetType":"home","stopAt":2},{"targetType":"wait","turns":5}]}').plan.then;
  assert.deepEqual(t, [{ targetType: 'home', stopAt: 2 }, { targetType: 'wait', turns: 5 }]);
  assert.match(parsePlan('{"targetType":"nap"}').error, /wait \| home/);
});

test('wait：原地不动、不耗体力，等满到期必问；结果 applied → woken(expired)；复盘「原地等了 n 回合」', () => {
  // 开局先等 4 回合，之后照 mock
  const { reqs, turns, p, s, cfg } = play('XS', 5, (req, all) => (plans(all).length === 1 ? '{"targetType":"wait","turns":4,"reason":"先看看"}' : mock(req)));
  const first4 = turns.slice(0, 4);
  for (const t of first4) {
    assert.deepEqual([t.next.x, t.next.y, t.next.stamina], [t.prev.x, t.prev.y, t.prev.stamina], `第 ${t.n} 回合没动、体力不变`);
    assert.equal(t.d.mode, 'wait');
  }
  assert.notEqual(turns[4].d.mode, 'wait', '第 5 回合不再等');
  const second = plans(reqs)[1];
  assert.equal(second.requestTurn, 5, '等满 4 回合后第 5 回合开头必问');
  assert.equal(second.why, 'complete');
  const out = p.outcomes.filter((e) => e.dp === 1).map((e) => e.type);
  assert.deepEqual(out, ['applied', 'woken']);
  assert.deepEqual(p.outcomes.find((e) => e.type === 'woken'), { dp: 1, type: 'woken', k: 4, cause: 'expired', waited: 4 });
  assert.equal(p.status().stats.totalWaited, 4);
  const jsonl = s.toJSONL();
  assert.equal(verifyRecord(jsonl).verify, 'verified');
  const tl = timelineFromRecord(jsonl, cfg, 0);
  assert.equal(tl.entries[0].targetType, 'wait');
  assert.equal(tl.entries[0].outcome, 'waited');
  assert.equal(tl.entries[0].waited, 4);
  assert.equal(tl.entries.length, p.session().entries.length, '复盘重放与对局中一致');
});

test('等待中：对手接近 / 受阻 / 定期都不问；只有刷新会叫醒（woken refresh），回 keep 继续等完', () => {
  let woke = 0;
  for (let seed = 1; seed <= 12; seed++) {
    // 玩家 AI 一直等（每次 10 回合），被刷新叫醒就 keep；累计 40 回合用完后被要求重交 → 照 mock
    const { reqs, p } = play('XS', seed, (req) => {
      if (req.kind === 'repair') return mock(req);
      if (req.why === 'refresh' && req.context.plan && req.context.plan.targetType === 'wait') return '{"keep":true}';
      return '{"targetType":"wait","turns":10}';
    });
    const firstRepair = reqs.findIndex((r) => r.kind === 'repair');
    const pure = plans(firstRepair < 0 ? reqs : reqs.slice(0, firstRepair));
    for (const r of pure.slice(1)) assert.ok(['complete', 'refresh'].includes(r.why), `种子 ${seed}：等待中第 ${r.requestTurn} 回合因 ${r.why} 被问`);
    for (const w of p.outcomes.filter((e) => e.type === 'woken' && e.cause === 'refresh')) {
      woke++;
      const kept = p.outcomes.find((e) => e.type === 'applied' && e.keep && e.k === w.k);
      assert.ok(kept, `种子 ${seed}：被刷新叫醒后 keep`);
      const end = p.outcomes.find((e) => e.dp === kept.dp && e.type === 'woken' && e.cause !== 'refresh');
      if (end) assert.ok(end.waited > w.waited, `种子 ${seed}：keep 后接着计数（${w.waited} → ${end.waited}）`);
    }
  }
  assert.ok(woke >= 3, `覆盖到被刷新叫醒（${woke} 次）`);
});

test('home：走到离出口 stopAt 步处停下等（不踩进出口），等满 10 回合必问；走路扣体力、等待不扣', () => {
  let ok = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const { turns, p, cfg } = play('S', seed, (req, all) => {
      if (plans(all).length === 1) return '{"targetType":"home","stopAt":2}';
      if (req.why === 'refresh' && req.context.plan && req.context.plan.targetType === 'home') return '{"keep":true}';
      return mock(req);
    });
    const applied = p.outcomes[0];
    assert.equal(applied.ref.type, 'home');
    const stop = applied.ref;
    const woken = p.outcomes.find((e) => e.type === 'woken' && e.cause !== 'refresh');
    if (!woken) continue; // 时间闸门之类先到（S 图 200 回合，基本不会）
    ok++;
    assert.equal(woken.cause, 'expired');
    assert.equal(woken.waited, cfg.ai.wait.maxTurns);
    const waitTurns = turns.filter((t) => t.d && t.d.mode === 'wait' && t.n <= woken.k);
    assert.equal(waitTurns.length, cfg.ai.wait.maxTurns);
    for (const t of waitTurns) {
      assert.deepEqual([t.prev.x, t.prev.y], [stop.x, stop.y], '在停下的那一格等');
      assert.equal(t.next.stamina, t.prev.stamina, '等待不扣体力');
    }
    assert.ok(turns.every((t) => t.n > woken.k || t.next.status === 'active'), '等待结束前没有踩进出口');
  }
  assert.ok(ok >= 5, `覆盖 ${ok} 局`);
});

test('时间闸门：剩余回合 ≤ 回家步数 + 2 时结束等待、改回出口（guard cause time），并且到得了家', () => {
  // XS 100 回合：一直要求等 10 回合，直到时间闸门
  const { p, s } = play('XS', 3, (req) => (req.payload.self.distToExit >= 0 ? '{"targetType":"wait","turns":10}' : mock(req)), {
    cfgOver: makeConfig({ ...matchOverrides('byok', 'XS'), ai: { ...(matchOverrides('byok', 'XS').ai || {}), wait: { maxTurns: 10, maxTotal: 400, stopAtMax: 3, timeMargin: 2 } } }),
  });
  const g = p.outcomes.find((e) => e.type === 'guard' && e.cause === 'time');
  assert.ok(g, '触发了时间闸门');
  assert.ok(g.left <= g.distToExit + 2);
  assert.equal(s.state.actors[0].status, 'escaped', '回得了家');
});

test('累计上限：本局等满 40 回合后，再交等待判不合格并重交', () => {
  const { reqs, p } = play('M', 7, (req) => {
    if (req.kind === 'repair') return mock(req);
    return '{"targetType":"wait","turns":10}';
  });
  const st = p.status().stats;
  assert.equal(st.totalWaited, 40);
  const caps = p.outcomes.filter((e) => e.type === 'woken');
  assert.ok(caps.every((e) => e.cause === 'expired' || e.cause === 'cap'));
  const rep = reqs.find((r) => r.kind === 'repair');
  assert.ok(rep, '满了之后的等待被要求重交');
  assert.match(rep.error, /累计等待已满 40 回合/);
});

test('then 里接等待：拿到宝石后直接原地等（不问），等满再问', () => {
  let seen = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const { p, reqs } = play('XS', seed, (req, all) => {
      if (plans(all).length !== 1) {
        // 主目标还在执行时被别的事件问到：keep（保住 then）；目标没了 keep 不合格 → 重交时照 mock
        if (req.kind === 'plan' && req.why !== 'complete' && req.context.plan) return '{"keep":true}';
        return mock(req);
      }
      const g = req.payload.gems.filter((x) => x.dist > 0).sort((a, b) => a.dist - b.dist)[0];
      return JSON.stringify({ targetType: 'gem', target: { x: g.x, y: g.y }, then: [{ targetType: 'wait', turns: 2 }] });
    });
    const q = p.outcomes.find((e) => e.type === 'queued' && e.ref.type === 'wait');
    if (!q) continue;
    seen++;
    const w = p.outcomes.find((e) => e.type === 'woken' && e.dp === q.dp && e.cause !== 'refresh');
    assert.ok(w && w.cause === 'expired' && w.waited === 2, `种子 ${seed}：${JSON.stringify(w)}`);
    const asked = plans(reqs).filter((r) => r.requestTurn > q.k + 1 && r.requestTurn <= w.k);
    assert.ok(asked.every((r) => r.why === 'refresh'), `种子 ${seed}：等的两回合里只可能因刷新被问`);
  }
  assert.ok(seen >= 3, `覆盖 ${seen} 局`);
});

test('旧规则配置（没有 ai.wait）：等待判不合格', () => {
  const base = makeConfig(matchOverrides('byok', 'XS'));
  const cfg = structuredClone(base);
  delete cfg.ai.wait;
  const { reqs } = play('XS', 5, (req) => (req.kind === 'repair' ? mock(req) : '{"targetType":"wait","turns":3}'), { cfgOver: cfg });
  assert.match(reqs.find((r) => r.kind === 'repair').error, /没有等待动作/);
});
