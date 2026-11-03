// 统一编程接口 v2：预算记账、ctx 信息边界、代码预处理、返回值规范化、公开事件、裁判（兜底 / 降级）、v1 兼容、随机数可复现、Node 适配器。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createMatch } from '../src/core/state.js';
import { observe, publicEvents } from '../src/core/observe.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { BUDGET, chargeTurn } from '../src/player/runtime/budget.js';
import { buildCtx, createRuntime, normalizeResult, prepareScript } from '../src/player/runtime/core.js';
import { createGovernor } from '../src/player/runtime/control.js';
import { compileScript, createNodeScriptController } from '../src/player/node-adapter.mjs';
import { SCRIPT_EXAMPLES, SCRIPT_TEMPLATE } from '../src/player/script-host.js';

const CFG = makeConfig(matchOverrides('script', 'XS'));
const clock = () => performance.now();

test('时间银行：用不完存入（有上限）、超支当回合作废且清零', () => {
  assert.deepEqual(chargeTurn(0, 10), { ok: true, bank: 40, overrun: 0 });
  assert.equal(chargeTurn(BUDGET.bankCapMs, 0).bank, BUDGET.bankCapMs, '银行有上限');
  assert.deepEqual(chargeTurn(100, 120), { ok: true, bank: 30, overrun: 0 }, '基础 50 + 银行 100 = 150 可用');
  const over = chargeTurn(10, 100);
  assert.equal(over.ok, false);
  assert.equal(over.bank, 0);
  assert.equal(over.overrun, 40);
});

test('ctx 只有公开信息：整图、四个出生点、四个出口、规则；没有种子、没有各座位模式', () => {
  const m = createMatch('ctx-1', CFG);
  const ctx = buildCtx(m.map, 2, CFG);
  assert.deepEqual(Object.keys(ctx).sort(), ['exits', 'grid', 'mapSize', 'rules', 'seat', 'size', 'spawns', 'v']);
  assert.equal(ctx.mapSize, 'XS');
  assert.equal(ctx.exits.length, 4);
  assert.deepEqual(ctx.exits, m.map.exits.map((e) => [...e]));
  assert.equal(ctx.rules.stamina, 50);
  const json = JSON.stringify({ ...ctx, grid: null });
  assert.equal(/seed|playerMode|manual|byok/.test(json), false, JSON.stringify(ctx.rules));
  ctx.grid[0] = 9;
  assert.notEqual(m.map.grid[0], 9, 'grid 是拷贝');
});

test('代码预处理：禁止 import / export default；去掉 export 关键字', () => {
  assert.equal(prepareScript("import x from './a.js';\nfunction decide(){}").ok, false);
  assert.equal(prepareScript('const m = await import("x");').ok, false);
  assert.equal(prepareScript('export default function () {}').ok, false);
  const p = prepareScript('export function decide() {}\n  export const A = 1;');
  assert.equal(p.ok, true);
  assert.equal(p.code, 'function decide() {}\n  const A = 1;');
});

test('返回值规范化：方向字符串 / {move, intent}；非法 intent 忽略并提示；Promise 不行', () => {
  assert.deepEqual(normalizeResult('n', 16), { ok: true, move: 'N', intent: null, warn: null });
  const r = normalizeResult({ move: 'E', intent: { type: 'gem', x: 3, y: 4, note: '补红色' } }, 16);
  assert.deepEqual(r.intent, { type: 'gem', x: 3, y: 4, note: '补红色' });
  assert.ok(normalizeResult({ move: 'S', intent: { type: 'gem', x: 99, y: 0 } }, 16).warn);
  assert.equal(normalizeResult('UP', 16).ok, false);
  assert.equal(normalizeResult(Promise.resolve('N'), 16).ok, false);
});

test('公开事件：拾取 / 开箱（含结果）/ 到达 / 出局 / 刷新全场可见；别人的撞墙受阻不给', () => {
  const ev = [
    { type: 'bump', seat: 1, dir: 0 }, { type: 'blocked', seat: 0, reason: 'contest' }, { type: 'invalidIntent', seat: 2 },
    { type: 'pickup', seat: 2, color: 3, x: 4, y: 5 }, { type: 'chest', seat: 1, x: 2, y: 2, kind: 'stamina', value: 30, gained: 12 },
    { type: 'escaped', seat: 3 }, { type: 'failed', seat: 1, reason: 'stamina' }, { type: 'gemRespawn', generation: 2, sep: 30 },
    { type: 'gemRespawnDeferred' }, { type: 'chestRespawn', x: 1, y: 1, sep: 10 }, { type: 'end', turn: 9 },
  ];
  const out = publicEvents(ev, 0);
  assert.deepEqual(out.map((e) => e.type), ['blocked', 'pickup', 'chest', 'escaped', 'failed', 'gemRespawn', 'chestRespawn']);
  assert.deepEqual(out[2], { type: 'chest', seat: 1, x: 2, y: 2, kind: 'stamina', value: 30, gained: 12 });
  assert.equal(out[5].sep, undefined, '内部细节不给');
  assert.equal(publicEvents(ev, 1).some((e) => e.type === 'bump'), true, '自己的撞墙给自己');
});

test('观察里的 events 来自上一回合（第 1 回合为空），不影响状态哈希', () => {
  const seen = [];
  const s = createScheduler(CFG, 'ev-1', {
    controllers: (m) => [0, 1, 2, 3].map((i) => {
      const h = createHeuristic(m.map, i, CFG, m.seed);
      return i === 0 ? { decide: (obs) => { seen.push(obs.events); return h.decide(obs); } } : h;
    }),
  });
  s.runSync(0, 200);
  assert.deepEqual(seen[0], []);
  assert.ok(seen.some((e) => e.some((x) => x.type === 'pickup')), '对局中能看到拾取事件');
  const plain = createScheduler(CFG, 'ev-1', { controllers: (m) => [0, 1, 2, 3].map((i) => createHeuristic(m.map, i, CFG, m.seed)) });
  plain.runSync(0, 200);
  assert.equal(s.toJSONL(), plain.toJSONL(), '加了 events 的观察不改变对局与记录');
});

test('裁判：enforce 超时作废走意图兜底；measure 只统计；软异常累计 → 自动回家；非玩家座位连续硬异常 → 自动回家；玩家座位 → 切手动', () => {
  const m = createMatch('gov-1', CFG);
  const obs = observe(m.map, m.state, 0, CFG, { patch: false, events: [] });
  const [ex, ey] = m.map.exits[0];
  const ok = { move: 'STAY', intent: { type: 'exit', x: ex, y: ey }, ms: 1 };

  const g = createGovernor({ map: m.map, seat: 0, cfg: CFG, seed: m.seed, mode: 'enforce' });
  assert.equal(g.settle(1, obs, ok).source, 'script');
  const t = g.settle(2, obs, { ...ok, ms: 999 });
  assert.equal(t.source, 'script-timeout');
  assert.equal(t.target.type, 'exit');
  assert.equal(g.status().counts.timeouts, 1);

  const meas = createGovernor({ map: m.map, seat: 0, cfg: CFG, seed: m.seed, mode: 'measure' });
  assert.equal(meas.settle(5, obs, { ...ok, ms: 999 }).source, 'script');
  assert.deepEqual(meas.status().counts.overBudgetTurns, [5]);

  const soft = createGovernor({ map: m.map, seat: 1, cfg: CFG, seed: m.seed });
  for (let k = 1; k <= CFG.script.l1CumulativeSoft; k++) soft.settle(k, obs, { ms: 1, invalid: '返回值不对' });
  assert.equal(soft.level, 'auto-home');

  const hard = createGovernor({ map: m.map, seat: 2, cfg: CFG, seed: m.seed, isPlayer: false });
  for (let k = 1; k <= CFG.script.l2ConsecutiveHard; k++) hard.settle(k, obs, { error: 'boom' });
  assert.equal(hard.level, 'auto-home');
  assert.equal(hard.wantsManual, null);

  const player = createGovernor({ map: m.map, seat: 0, cfg: CFG, seed: m.seed, isPlayer: true });
  for (let k = 1; k <= CFG.script.l2ConsecutiveHard; k++) player.settle(k, obs, { error: 'boom' });
  assert.equal(player.level, 'manual');
  assert.ok(player.wantsManual);
});

test('api.random 按种子 + 座位可复现，不同座位不同流', () => {
  const m = createMatch('rnd-1', CFG);
  const seq = (seat) => {
    const rt = createRuntime({ map: m.map, seat, cfg: CFG, seed: m.seed, clock });
    return [rt.random(), rt.random(), rt.random()];
  };
  assert.deepEqual(seq(1), seq(1));
  assert.notDeepEqual(seq(1), seq(2));
});

function playWith(code, seed = 'v1-1', size = 'XS') {
  const cfg = makeConfig(matchOverrides('script', size));
  const ctrls = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => [0, 1, 2, 3].map((i) => {
      const c = i === 0 ? createNodeScriptController({ code, map: m.map, seat: 0, cfg, seed: m.seed }) : createHeuristic(m.map, i, cfg, m.seed);
      ctrls.push(c);
      return c;
    }),
  });
  s.runSync(0, cfg.rules.maxTurns + 10);
  return { s, report: ctrls[0].report() };
}

test('v1 写法兼容：示例脚本（只有 decide、obs.state、api.distance / shortestStep / setState）不改代码跑完整局、零异常', () => {
  for (const ex of [SCRIPT_TEMPLATE, SCRIPT_EXAMPLES.greedy.code, SCRIPT_EXAMPLES.sets.code]) {
    const { s, report } = playWith(ex);
    assert.ok(s.state.ended);
    assert.equal(report.hard, 0, JSON.stringify(report.errors));
    assert.equal(report.soft, 0, JSON.stringify(report.errors));
  }
  const { s } = playWith(SCRIPT_EXAMPLES.greedy.code);
  assert.equal(s.state.actors[0].status, 'escaped');
});

test('Node 适配器：编译错误带行号；顶层抛错；没有 decide；死循环被打断并重建（记一次 reset）', () => {
  assert.throws(() => compileScript('function decide(obs, api) {\n  return (;\n}'), /SyntaxError/);
  assert.throws(() => compileScript('\nthrow new Error("坏了");\nfunction decide(){}'), /坏了（第 2 行）/);
  assert.throws(() => compileScript('function init() {}'), /没有找到 decide/);
  const m = createMatch('hang-1', CFG);
  const c = createNodeScriptController({
    code: 'let n = 0;\nfunction decide() { n++; if (n === 2) { for (;;) {} } return "STAY"; }', map: m.map, seat: 1, cfg: CFG, seed: m.seed, hangMs: 50,
  });
  const obs = observe(m.map, m.state, 1, CFG, { patch: false, events: [] });
  assert.equal(c.decide(obs, 1).source, 'script');
  const d = c.decide(obs, 2);
  assert.equal(d.source, 'script-error');
  assert.equal(c.report().resets, 1);
  assert.equal(c.decide(obs, 3).source, 'script', '重建后模块变量重新开始（n 从 0 计），照常工作');
});

test('Math.random 被换成本座位的脚本流：同一脚本两次结果一致', () => {
  const code = 'function decide(obs, api) { return ["N","E","S","W"][Math.floor(Math.random() * 4)]; }';
  assert.equal(playWith(code, 'mr-1').s.toJSONL(), playWith(code, 'mr-1').s.toJSONL());
});
