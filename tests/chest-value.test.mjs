// SPEC-0.4 宝箱估值（redesign §14 C15，第 10.2 项）：宝箱只给分时，启发式 AI / 内置脚本 / 模拟大模型都按分数估宝箱；
// 旧规则（可能给体力）下沿用原来的体力权重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { chestFixedScore } from '../src/core/scoring.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { chooseTarget } from '../src/ai/heuristic.js';
import { buildPayload } from '../src/ai/codec.js';
import { mockPlan } from '../src/ai/mock-llm.js';
import { runMatch } from '../src/sim/headless.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';

const NEW = makeConfig(matchOverrides('manual', 'XS'));
const OLD = makeConfig({ ...matchOverrides('manual', 'XS'), treasure: { ...matchOverrides('manual', 'XS').treasure, chest: { ...matchOverrides('manual', 'XS').treasure.chest, pScore: 0.5, scoreRange: [1, 5] } } });
const script = (name) => readFileSync(new URL(`../src/player/builtin/${name}.js`, import.meta.url), 'utf8');

/** 一个宝箱比宝石稍远的局面：所有宝石离我 3 步，宝箱 5 步。 */
function scene(cfg) {
  const m = createMatch(4, cfg);
  const obs = observe(m.map, m.state, 0, cfg, { patch: true, events: [] });
  obs.gems = obs.gems.map((g) => ({ ...g, dist: 3 }));
  obs.chest = { ...obs.chest, present: true, dist: 5 };
  return { m, obs };
}

test('chestFixedScore：只给分 → 期望分；可能给体力 → null', () => {
  assert.equal(chestFixedScore(NEW.treasure.chest), 5);
  assert.equal(chestFixedScore(OLD.treasure.chest), null);
  assert.equal(chestFixedScore({ pScore: 1, scoreRange: [2, 4] }), 3);
});

test('启发式 AI：新规则下稍远的宝箱（5 分）胜过近处的宝石；旧规则下仍选宝石', () => {
  const a = scene(NEW);
  assert.equal(chooseTarget(a.m.map, a.obs, NEW).target.type, 'chest');
  const b = scene(OLD);
  assert.equal(chooseTarget(b.m.map, b.obs, OLD).target.type, 'gem');
});

test('载荷：新规则宝箱带 score 5；模拟大模型按分数估、旧规则不带 score', () => {
  const cfg = makeConfig(matchOverrides('byok', 'XS'));
  const m = createMatch(4, cfg);
  const p = buildPayload(m.map, observe(m.map, m.state, 0, cfg, { patch: true, events: [] }), cfg);
  assert.equal(p.chest.score, 5);
  p.gems = p.gems.map((g) => ({ ...g, dist: 3, rivalsNearer: [] }));
  p.chest = { ...p.chest, dist: 5, rivalsNearer: [] };
  assert.equal(JSON.parse(mockPlan(p, '')).targetType, 'chest');
  const pOld = buildPayload(m.map, observe(m.map, m.state, 0, OLD, { patch: true, events: [] }), OLD);
  assert.equal(pOld.chest.score, undefined);
});

test('整局：新规则下宝箱几乎都被开掉（启发式 / 三个内置脚本），旧规则对照开得明显更少', () => {
  const opens = (cfg, ctl) => {
    let n = 0;
    for (let seed = 1; seed <= 8; seed++) {
      if (!ctl) n += runMatch(seed, cfg).state.actors.reduce((a, x) => a + x.chestOpens, 0);
      else {
        const s = createScheduler(cfg, seed, { controllers: (m) => [0, 1, 2, 3].map((i) => createNodeScriptController({ code: script(ctl), map: m.map, seat: i, cfg, seed: m.seed })) });
        s.runSync(0, 100000);
        n += s.state.actors.reduce((a, x) => a + x.chestOpens, 0);
      }
    }
    return n / 8;
  };
  const cfgS = (old) => makeConfig({ ...matchOverrides('script', 'XS'), ...(old ? { treasure: { ...matchOverrides('script', 'XS').treasure, chest: { ...matchOverrides('script', 'XS').treasure.chest, pScore: 0.5, scoreRange: [1, 5] } } } : {}) });
  for (const [label, ctl, cfgNew, cfgOld] of [['启发式', null, NEW, OLD], ['heuristic 脚本', 'heuristic', cfgS(false), cfgS(true)], ['aware', 'aware', cfgS(false), cfgS(true)], ['sets', 'sets', cfgS(false), cfgS(true)]]) {
    const now = opens(cfgNew, ctl);
    const before = opens(cfgOld, ctl);
    assert.ok(now >= 2, `${label}：新规则每局开箱 ${now}（共 3 只；sets 抢不过会打折，略少）`);
    assert.ok(now > before, `${label}：新 ${now} > 旧 ${before}`);
  }
});
