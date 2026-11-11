// SPEC-0.4 规则正文与局面数据（redesign §14 C15，第 10.5 项）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { buildMessages, buildPayload } from '../src/ai/codec.js';
import { TOOLS } from '../server/workbuddy.mjs';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';

const cfg = makeConfig(matchOverrides('byok', 'XS'));
const m = createMatch(1, cfg);
const p = buildPayload(m.map, observe(m.map, m.state, 0, cfg, { patch: true, events: [] }), cfg);
const contractSys = buildMessages(p, '', cfg, { autonomy: 'free' })[0].content;
const oppSys = buildMessages(p, '', cfg)[0].content;

test('规则正文：宝箱 5 分、重复色计分、heading 是趋势、canAfford、等待动作与醒来规则（两种提示词都有）', () => {
  for (const sys of [contractSys, oppSys]) {
    assert.match(sys, /开宝箱固定得 5 分（不给体力）/);
    assert.match(sys, /重复颜色的宝石同样每颗 1 分，只是不帮你凑套/);
    assert.match(sys, /heading 只是最近几步的走向（趋势），不是对手承诺要去那里/);
    assert.match(sys, /canAfford = 你的体力 ≥ dist \+ back（false 时提交它会被引擎当场改为回家）/);
    assert.match(sys, /chest\.score = 开这个箱得几分/);
    assert.match(sys, /\{"targetType":"wait","turns":k\} = 原地不动等 k 回合（1–10）/);
    assert.match(sys, /\{"targetType":"home","stopAt":s\} = 沿最短路走到离你出口还差 s 步的地方（1–3）停下/);
    assert.match(sys, /本局累计最多等 40 回合/);
    assert.match(sys, /剩余回合 ≤ 回家步数 \+ 2 时引擎会结束等待/);
    assert.match(sys, /等待（wait \/ home）期间：只有刷新会叫醒你（回 keep 接着等完）；等满约定回合必问/);
  }
  assert.match(contractSys, /等待：targetType 写 "wait"（带 "turns"）或 "home"（带 "stopAt"），不用写 target/);
  assert.match(oppSys, /不拿东西时也可以等：\{"targetType":"wait"/);
});

test('旧规则配置：没有等待说明、宝箱写随机、载荷没有 chest.score', () => {
  const old = structuredClone(cfg);
  delete old.ai.wait;
  old.treasure.chest.pScore = 0.5;
  old.treasure.chest.scoreRange = [1, 5];
  const po = buildPayload(m.map, observe(m.map, m.state, 0, old, { patch: true, events: [] }), old);
  const sys = buildMessages(po, '', old, { autonomy: 'free' })[0].content;
  assert.doesNotMatch(sys, /"targetType":"wait"/);
  assert.match(sys, /宝箱随机给 1–5 分或/);
  assert.equal(po.chest.score, undefined);
});

test('局面：每颗宝石 / 宝箱都有 canAfford = 体力 ≥ dist + back；本次决策上下文有 waitLeft', () => {
  for (const g of p.gems) assert.equal(g.canAfford, g.dist >= 0 && g.back >= 0 && p.self.stamina >= g.dist + g.back);
  assert.equal(p.chest.canAfford, p.chest.dist + p.chest.back <= p.self.stamina);
  // 体力很低时都负担不起
  const st = structuredClone(m.state);
  st.actors[0].stamina = 3;
  const low = buildPayload(m.map, observe(m.map, st, 0, cfg, { patch: true, events: [] }), cfg);
  assert.ok(low.gems.every((g) => g.canAfford === false));
  // 本次决策上下文（玩家自己的 AI）：waitLeft = 本局还能等几回合
  let ctx = null;
  const pool = createAgentPool(cfg);
  const s = createScheduler(cfg, 1, {
    controllers: (mm) => [
      createPlanner({ map: mm.map, seat: 0, cfg, seed: mm.seed, pool, autonomy: 'free', transport: (req, reply) => { ctx = ctx || req.context; reply.deliver('{"targetType":"wait","turns":2}'); } }),
      ...[1, 2, 3].map((i) => createHeuristic(mm.map, i, cfg, mm.seed)),
    ],
  });
  s.tick(0);
  assert.equal(ctx.waitLeft, 40);
});

test('MCP schema：targetType 含 wait / home，有 turns / stopAt；then 里也能写等待', () => {
  const d = TOOLS.find((t) => t.name === 'maze_decide');
  const props = d.inputSchema.properties.decision.properties;
  assert.deepEqual(props.targetType.enum, ['gem', 'chest', 'exit', 'wait', 'home']);
  assert.equal(props.turns.maximum, 10);
  assert.equal(props.stopAt.maximum, 3);
  assert.deepEqual(props.then.items.properties.targetType.enum, ['gem', 'chest', 'exit', 'wait', 'home']);
  assert.deepEqual(props.then.items.required, ['targetType']);
  assert.match(d.description, /\{targetType:"wait", turns\}/);
});
