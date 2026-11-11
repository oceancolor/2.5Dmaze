// SPEC-0.4 提问规则可预期（redesign §14 C15，第 10.3 项）：
//   目标被抢必问（不看事件冷却、不占次数）；刷新必问（冷却中推迟到冷却结束、不丢；推迟期间被别的原因问过就算问过）；
//   其他事件照旧受冷却与次数限制；额度充足时大模型座位不再由启发式代走。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { mockPlan } from '../src/ai/mock-llm.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';

const AWARE = readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8');

/** 座位 0 = 玩家自己的 AI（answer 决定回复），1–3 = 预判对手脚本。记录每个请求与每回合的公开事件 / 座位 0 的执行来源。 */
function play(size, seed, answer = (req) => mockPlan(req.payload, '', { contract: true }), aiOver = {}) {
  const over = matchOverrides('byok', size);
  const cfg = makeConfig({ ...over, ai: { ...(over.ai || {}), ...aiOver } });
  const reqs = [];
  const turns = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => [
      createPlanner({ map: m.map, seat: 0, cfg, seed: m.seed, pool: createAgentPool(cfg), persona: '', autonomy: 'free', transport: (req, reply) => { reqs.push(req); reply.deliver(answer(req)); } }),
      ...[1, 2, 3].map((i) => createNodeScriptController({ code: AWARE, map: m.map, seat: i, cfg, seed: m.seed })),
    ],
  });
  s.on('turn', (l) => turns.push({ n: l.n, events: l.events, d: l.decisions[0], active: l.prev.actors[0].status === 'active' }));
  s.runSync(0, 100000);
  return { s, cfg, reqs, turns, planner: s.controllers[0] };
}
const plans = (reqs) => reqs.filter((r) => r.kind === 'plan');
const askedAt = (reqs, t) => plans(reqs).some((r) => r.requestTurn === t);

test('目标被抢必问：每次被抢的下一回合都问（不看事件冷却、不占事件次数）', () => {
  let lost = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const { reqs, planner } = play('XS', seed);
    for (const e of planner.outcomes.filter((x) => x.type === 'lost')) {
      lost++;
      const r = plans(reqs).find((q) => q.requestTurn === e.k + 1);
      assert.ok(r, `种子 ${seed}：帧 ${e.k} 被抢，第 ${e.k + 1} 回合应该问`);
    }
    assert.ok(planner.status().stats.eventsUsed <= 10);
  }
  assert.ok(lost >= 20, `覆盖到足够多的被抢（${lost}）`);
});

test('事件次数用完后，目标被抢与刷新照样问；其他事件不再问', () => {
  // 每局事件次数设为 0：只剩必问事件 + 计划完成 + 定期
  let lostAsked = 0;
  let refreshAsked = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const { reqs } = play('XS', seed, undefined, { eventBudgetPerAgent: 0 });
    for (const r of plans(reqs)) {
      assert.ok(!['sighted', 'blocked', 'lowStamina'].includes(r.why), `种子 ${seed} 第 ${r.requestTurn} 回合：次数为 0 时不该因 ${r.why} 问`);
      if (r.why === 'targetLost') lostAsked++;
      if (r.why === 'refresh') refreshAsked++;
    }
  }
  assert.ok(lostAsked > 0 && refreshAsked > 0, `被抢 ${lostAsked} / 刷新 ${refreshAsked}`);
});

test('刷新必问：每次刷新后最晚到冷却结束就问；推迟期间被别的原因问过就不再单独问', () => {
  const cd = 3;
  let refreshes = 0;
  let deferred = 0;
  let deferredStat = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { reqs, turns, planner } = play('XS', seed);
    const plansList = plans(reqs);
    for (const t of turns) {
      if (!t.active || !t.events.some((e) => e.type === 'gemRespawn' || e.type === 'chestRespawn')) continue;
      refreshes++;
      // 第 t.n 回合结算后刷新 → 第 t.n+1 回合起应在冷却允许的最早一回合问
      const after = plansList.filter((r) => r.requestTurn > t.n);
      const first = after[0];
      const endTurn = turns.at(-1).n;
      if (!first) {
        assert.ok(endTurn - t.n <= cd || !turns.some((x) => x.n > t.n && x.active), `种子 ${seed}：第 ${t.n} 回合刷新后再也没问`);
        continue;
      }
      assert.ok(first.requestTurn - (t.n + 1) <= cd, `种子 ${seed}：第 ${t.n} 回合刷新，到第 ${first.requestTurn} 回合才问（超过冷却 ${cd}）`);
      if (first.requestTurn > t.n + 1) deferred++;
      // 推迟期间若被别的原因问过，之后不应再出现一个「refresh」专门补问同一次刷新（除非期间又有新的刷新）
      if (first.why !== 'refresh') {
        const next = after.find((r) => r.requestTurn > first.requestTurn && r.requestTurn <= first.requestTurn + cd);
        const again = next && turns.some((x) => x.n >= first.requestTurn && x.n < next.requestTurn && x.events.some((e) => e.type === 'gemRespawn' || e.type === 'chestRespawn'));
        if (next && !again) assert.notEqual(next.why, 'refresh', `种子 ${seed}：第 ${t.n} 回合的刷新已在第 ${first.requestTurn} 回合问过（${first.why}）`);
      }
    }
    deferredStat += planner.status().stats.refreshDeferred;
  }
  assert.ok(refreshes >= 30, `覆盖刷新 ${refreshes}`);
  assert.ok(deferred > 0 && deferredStat > 0, `覆盖到冷却中推迟的刷新（${deferred} 次）`);
});

test('回出口途中遇到刷新也问', () => {
  let homeRefresh = 0;
  for (const size of ['XS', 'S']) {
    for (let seed = 1; seed <= 20; seed++) {
      const { reqs, turns } = play(size, seed);
      for (const t of turns) {
        if (!t.active || !t.d || t.d.mode !== 'home' || !t.d.source.startsWith('llm')) continue;
        if (!t.events.some((e) => e.type === 'gemRespawn' || e.type === 'chestRespawn')) continue;
        if (!turns.some((x) => x.n === t.n + 1 && x.active)) continue; // 这一回合就到家了
        homeRefresh++;
        const ask = plans(reqs).find((r) => r.requestTurn > t.n && r.requestTurn <= t.n + 4);
        assert.ok(ask, `${size} 种子 ${seed}：回家途中第 ${t.n} 回合刷新，没有问`);
      }
    }
  }
  assert.ok(homeRefresh >= 10, `覆盖回家途中的刷新 ${homeRefresh}`);
});

test('额度充足时，大模型座位没有一回合由启发式代走（被抢后不再静默顶班）', () => {
  let heur = 0;
  let total = 0;
  for (const size of ['XS', 'S']) {
    for (let seed = 1; seed <= 20; seed++) {
      const { turns, planner } = play(size, seed);
      const st = planner.status().stats;
      assert.equal(st.capped + st.denied, 0, '额度充足');
      for (const t of turns) {
        if (!t.active || !t.d) continue;
        total++;
        if (t.d.source === 'heuristic') heur++;
      }
    }
  }
  assert.equal(heur, 0, `启发式代走 ${heur} / ${total} 回合`);
});
