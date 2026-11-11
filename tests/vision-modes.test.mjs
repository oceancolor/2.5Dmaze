// 视野规则（2026-11-06 实验）：radius 与旧版逐字节一致；full 全员实时可见；delayed 视野外给 D 回合前的位置；
// radar 每 K 回合广播；拾取广播不被延迟位置覆盖；配置哈希、服务器白名单与校验。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { VISION_IDS, visionIdOf, visionOverrides } from '../src/config/vision-modes.js';
import { spec01Config } from '../src/config/legacy.js';
import { configHash } from '../src/core/hash.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { verifyRecord } from '../server/verifier.mjs';

const cfgOf = (vision, size = 'M') => makeConfig(matchOverrides('script', size, vision));
const play = (cfg, seed, onTurn) => {
  const s = createScheduler(cfg, seed, { controllers: (m) => [0, 1, 2, 3].map((i) => createHeuristic(m.map, i, cfg, m.seed)) });
  if (onTurn) s.on('turn', () => onTurn(s));
  s.runSync(0, cfg.rules.maxTurns + 10);
  return s;
};

test('配置（批次 6）：默认就是全公开；旧 radius 规则的哈希与批次 6 之前逐字节一致（旧记录照常校验）；四种规则哈希互不相同', () => {
  assert.equal(DEFAULT_CONFIG.vision.mode, 'full');
  assert.deepEqual(visionOverrides('full'), {});
  assert.equal(configHash(spec01Config('manual', 'XL', 'radius')), '7e19e5c6', '批次 6 之前 XL 手打的默认哈希（冻结快照）');
  assert.equal(configHash(spec01Config('script', 'XS', 'full')), '090728bb', '批次 2 实验里 XS 全公开的哈希');
  assert.notEqual(configHash(DEFAULT_CONFIG), '7e19e5c6');
  assert.equal(DEFAULT_CONFIG.rulesVersion, 'SPEC-0.4');
  const hs = new Set(VISION_IDS.map((v) => configHash(cfgOf(v))));
  assert.equal(hs.size, 4);
  for (const v of VISION_IDS) assert.equal(visionIdOf(cfgOf(v)), v);
  assert.throws(() => makeConfig({ vision: { mode: 'xray' } }), /unknown vision.mode/);
  assert.throws(() => makeConfig({ vision: { mode: 'delayed' } }), /delayTurns/);
});

test('旧 radius 规则：状态里没有 trail；视野外不给实时位置', () => {
  const cfg = cfgOf('radius');
  let hidden = 0;
  const a = play(cfg, 'v-1', (s) => {
    const st = s.state;
    if (st.ended || st.actors[0].status !== 'active') return;
    for (const o of observe(s.map, st, 0, cfg, { patch: false }).actors) if (o.status === 'active' && !o.visible) hidden++;
  });
  assert.equal('trail' in a.state, false);
  assert.ok(hidden > 0);
});

test('full：所有在场对手每回合都实时可见', () => {
  const cfg = cfgOf('full');
  let checked = 0;
  play(cfg, 'v-2', (s) => {
    const st = s.state;
    if (st.ended || st.actors[0].status !== 'active') return;
    const obs = observe(s.map, st, 0, cfg, { patch: false });
    for (const o of obs.actors) {
      if (o.status !== 'active') continue;
      assert.equal(o.visible, true);
      assert.equal(o.x, st.actors[o.seat].x);
      checked++;
    }
  });
  assert.ok(checked > 100);
});

test('delayed：视野外的对手给 D 回合前的真实位置（turnsSince = D+1），视野内实时', () => {
  const D = 5;
  const cfg = cfgOf({ mode: 'delayed', delayTurns: D });
  const hist = [];
  let checked = 0;
  play(cfg, 'v-3', (s) => {
    const st = s.state;
    hist[st.turn - 1] = st.actors.map((a) => [a.x, a.y]); // 第 turn-1 回合末的位置
    if (st.ended || st.actors[0].status !== 'active' || st.turn < D + 3) return;
    const obs = observe(s.map, st, 0, cfg, { patch: false });
    for (const o of obs.actors) {
      if (o.status !== 'active') continue;
      if (o.visible) continue;
      const then = st.turn - o.lastSeen.turnsSince;
      if (o.lastSeen.turnsSince === D + 1) {
        assert.deepEqual([o.lastSeen.x, o.lastSeen.y], hist[then][o.seat], `座位 ${o.seat} 第 ${then} 回合位置`);
        checked++;
      } else {
        assert.ok(o.lastSeen.turnsSince < D + 1, '只会比 D 回合更新（拾取广播 / 刚离开视野），不会更旧');
      }
    }
  });
  assert.ok(checked > 50, `checked ${checked}`);
});

test('radar：每 K 回合末全员位置广播；之间视野外的最后已知位置不超过 K 回合', () => {
  const K = 15;
  const cfg = cfgOf('radar');
  let worst = 0;
  play(cfg, 'v-4', (s) => {
    const st = s.state;
    if (st.ended || st.actors[0].status !== 'active') return;
    const obs = observe(s.map, st, 0, cfg, { patch: false });
    for (const o of obs.actors) if (o.status === 'active' && !o.visible) worst = Math.max(worst, o.lastSeen.turnsSince);
  });
  assert.ok(worst > 0 && worst <= K, `最旧 ${worst}`);
});

test('服务器：新版（全公开）与 SPEC-0.1 四种规则的记录都 verified，并识别出规则版本与视野', () => {
  const now = verifyRecord(play(cfgOf('full', 'S'), 'srv-now').toJSONL());
  assert.equal(now.verify, 'verified', now.verifyNote);
  assert.equal(now.vision, 'full');
  assert.equal(now.meta.rulesVersion, 'SPEC-0.4');
  // 用户裁定旧成绩作废：SPEC-0.2（+2 回合生效，2026-11-10）、SPEC-0.3（宝箱随机，2026-11-11）的记录不再认可
  for (const ver of ['SPEC-0.2', 'SPEC-0.3']) {
    const lines = play(cfgOf('full', 'S'), `srv-${ver}`).toJSONL().split('\n');
    const meta = JSON.parse(lines[0]);
    lines[0] = JSON.stringify({ ...meta, rulesVersion: ver });
    const old = verifyRecord(lines.join('\n'));
    assert.equal(old.verify, 'unverifiable', ver);
    assert.match(old.verifyNote, new RegExp(ver.replace('.', '\\.')));
  }
  for (const v of VISION_IDS) {
    const r = verifyRecord(play(spec01Config('script', 'S', v), `srv-${v}`).toJSONL());
    assert.equal(r.verify, 'verified', `${v}: ${r.verifyNote}`);
    assert.equal(r.vision, v);
    assert.equal(r.mapSize, 'S');
    assert.equal(r.meta.rulesVersion, 'SPEC-0.1');
  }
});

test('「预判对手」参考脚本：四种规则 × XS / M 零异常打完；评测结果带规则', async () => {
  const { readFileSync } = await import('node:fs');
  const { createNodeScriptController } = await import('../src/player/node-adapter.mjs');
  const { runEval } = await import('../src/player/eval/run-eval.js');
  const code = readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8');
  for (const vision of VISION_IDS) {
    const r = runEval({
      size: 'XS', vision, seeds: '1-4', seats: [{ kind: 'script', code, name: '预判' }, { kind: 'script', code }, { kind: 'heuristic' }, { kind: 'heuristic' }],
      makeScript: (o) => createNodeScriptController({ code: o.spec.code, map: o.match.map, seat: o.seat, cfg: o.cfg, seed: o.match.seed }),
    });
    assert.equal(r.vision, vision);
    for (const s of r.seats.slice(0, 2)) assert.equal(s.script.hard + s.script.soft, 0, `${vision}: ${JSON.stringify(s.script.errors)}`);
  }
  assert.throws(() => runEval({ size: 'XS', vision: 'xray', seeds: '1', seats: [{ kind: 'heuristic' }, { kind: 'heuristic' }, { kind: 'heuristic' }, { kind: 'heuristic' }], makeScript: () => null }), /未知视野规则/);
});

test('视野实验工具：一格（XS × 全公开 × 2 种子）出全部指标', async () => {
  const { runCell, renderMarkdown, RULES } = await import('../tools/vision-experiment.mjs');
  const r = runCell('XS', RULES.find((x) => x.vision === 'full'), [1, 2]);
  for (const k of ['encounter', 'wasted', 'contests', 'escape', 'luck', 'skillScore', 'skillWin', 'heurWasted', 'heurContests']) assert.equal(typeof r[k], 'number', k);
  assert.ok(r.encounter > 0.5, 'XS 几乎总在视野内');
  assert.match(renderMarkdown([r], 2), /B 全公开/);
});

test('启发式在全公开规则下照常打完（远处的对手不当障碍）', () => {
  for (const size of ['XS', 'M', 'XL']) {
    const s = play(cfgOf('full', size), `full-${size}`);
    assert.ok(s.state.ended);
    assert.ok(s.state.actors.filter((a) => a.status === 'escaped').length >= 3, size);
  }
  void createMatch;
});
