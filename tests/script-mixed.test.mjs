// 混合对局（统一编程接口 v2）：任意座位跑脚本，与启发式 / 模拟大模型同场；记录带 meta.scripts，服务器严格回放 verified；
// 同一脚本 + 种子两次逐字节相同；服务器侧标签分类与形状检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { SCRIPT_EXAMPLES } from '../src/player/script-host.js';
import { codeHash, scriptMeta, seatTag } from '../src/player/eval/run-eval.js';
import { verifyRecord, seatSource, parseRecord } from '../server/verifier.mjs';

const REF = readFileSync(new URL('../src/player/builtin/heuristic.js', import.meta.url), 'utf8');
const SETS = readFileSync(new URL('../src/player/builtin/sets.js', import.meta.url), 'utf8');

function mixed(size, seed) {
  const cfg = makeConfig(matchOverrides('script', size));
  const specs = [
    null,
    { kind: 'script', code: REF, name: '启发式（参考实现）', author: '迷宫寻宝', origin: 'builtin' },
    { kind: 'script', code: SETS, name: '凑套 + 推演抢宝石', author: 'agent-x', origin: 'agent' },
    { kind: 'script', code: SCRIPT_EXAMPLES.greedy.code, name: '贪心', author: '张三', origin: 'human' },
  ];
  const ctrls = [];
  const s = createScheduler(cfg, seed, {
    controllers: (m) => specs.map((sp, i) => {
      const c = sp ? createNodeScriptController({ code: sp.code, map: m.map, seat: i, cfg, seed: m.seed }) : createHeuristic(m.map, i, cfg, m.seed);
      ctrls.push(c);
      return c;
    }),
    seatLabels: specs.map((sp, i) => (sp ? seatTag(sp, i) : 'heuristic')),
    scripts: specs.map((sp, i) => (sp ? scriptMeta(sp, i) : null)).filter(Boolean),
  });
  s.runSync(0, cfg.rules.maxTurns + 10);
  return { s, ctrls };
}

test('座位 1–3 跑脚本（参考脚本 / agent 示例 / v1 示例）+ 座位 0 启发式：XS / S / M 整局结束，服务器回放 verified', () => {
  for (const size of ['XS', 'S', 'M']) {
    const { s, ctrls } = mixed(size, `mix-${size}`);
    assert.ok(s.state.ended, size);
    for (const c of ctrls.slice(1)) assert.equal(c.report().hard, 0, `${size}: ${JSON.stringify(c.report().errors)}`);
    const v = verifyRecord(s.toJSONL());
    assert.equal(v.verify, 'verified', `${size}: ${v.verifyNote}`);
    assert.equal(v.mapSize, size);
    assert.equal(v.meta.scripts.length, 3);
    assert.deepEqual(v.meta.scripts.map((x) => x.origin), ['builtin', 'agent', 'human']);
    assert.equal(v.meta.scripts[0].codeHash, codeHash(REF));
    assert.deepEqual(v.meta.seats.map(seatSource), ['heuristic', 'script', 'script', 'script']);
  }
});

test('同一批脚本 + 种子跑两次：记录逐字节相同（measure 模式可复现）', () => {
  assert.equal(mixed('S', 'det-1').s.toJSONL(), mixed('S', 'det-1').s.toJSONL());
});

test('服务器：script:<哈希> 归为 script；meta.scripts 形状不对 → 400', () => {
  assert.equal(seatSource('script:abcd1234'), 'script');
  const rec = mixed('XS', 'shape-1').s.toJSONL().split('\n');
  const meta = JSON.parse(rec[0]);
  const bad = (patch) => [JSON.stringify({ ...meta, scripts: patch }), ...rec.slice(1)].join('\n');
  assert.throws(() => parseRecord(bad([{ seat: 1, name: 'x', author: '', origin: 'robot', codeHash: '00000000' }])), /origin/);
  assert.throws(() => parseRecord(bad([{ seat: 1, name: 'x'.repeat(41), author: '', origin: 'human', codeHash: '00000000' }])), /name/);
  assert.throws(() => parseRecord(bad([{ seat: 1, name: 'x', author: '', origin: 'human', codeHash: 'zz' }])), /codeHash/);
  assert.throws(() => parseRecord(bad([{ seat: 1, name: 'a', author: '', origin: 'human', codeHash: '00000000' }, { seat: 1, name: 'b', author: '', origin: 'human', codeHash: '00000000' }])), /seat/);
  assert.equal(verifyRecord(rec.join('\n')).verify, 'verified');
});
