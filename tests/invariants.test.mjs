// 护栏（决策协议改造 §14 C11）：决策时序 / 帧 / 接口改造期间，下列「游戏本身」的结果必须逐字节不变。
// 冻结值取自 2026-11-10 改造前的内核。这些对局全是启发式座位，不经过大模型规划器。
// 某个值变了 = 动到了地图生成、结算、计分、体力或启发式对手。真要改游戏规则时，在同一提交里更新这里的值并写明原因。
//
// 2026-11-11 SPEC-0.4（用户裁定，§14 C15）：宝箱改为必给 5 分。护栏拆成两层：
//   旧规则对照（RUNS_OLD）：把宝箱配置改回「随机 1–5 分 / 体力」，必须逐字节复现 2026-11-10 的冻结值
//     → 证明结算 / 计分 / 体力代码没有动，启发式的新宝箱估值也只在「宝箱只给分」时生效；
//   现行规则（RUNS）：SPEC-0.4 的冻结值（10.2 起启发式按 5 分估宝箱，所以开局选目标就可能与旧值不同）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createMatch } from '../src/core/state.js';
import { scoreOf } from '../src/core/scoring.js';
import { runMatch } from '../src/sim/headless.js';
import { replay } from '../src/record/replayer.js';

const OLD_CHEST = { treasure: { chest: { pScore: 0.5, scoreRange: [1, 5] } } };
const deep = (a, b) => {
  const o = structuredClone(a);
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] ? deep(o[k], v) : v;
  return o;
};
const cfgOf = (id, old = false) => {
  const base = id === 'XL' ? {} : matchOverrides('manual', id);
  return makeConfig(old ? deep(base, OLD_CHEST) : base);
};

const MAPS = {
  XS: { 1: '8c6d64c5', 42: '653073cc', 20261110: '66256c13' },
  M: { 1: '89b854db', 42: 'aa0f11bb', 20261110: '7004225e' },
  XL: { 1: '5addfc8a', 42: 'd47ef2a8', 20261110: '26fb81f1' },
};

// [终局回合, 首回合后哈希, 终局哈希, 各座位 [分数, 剩余体力, 五色宝石数]]
const RUNS_OLD = {
  XS: {
    3: [48, '4222bff0', 'a77a49cf', [[3, 27, '10110'], [1, 19, '10000'], [2, 2, '01001'], [5, 8, '01112']]],
    9: [49, '6c9a54c8', '393d0927', [[4, 7, '11110'], [4, 5, '10111'], [7, 11, '01010'], [4, 4, '11101']]],
  },
  M: {
    3: [188, '1468af74', '12401580', [[2, 49, '01100'], [4, 45, '31000'], [1, 40, '00001'], [7, 12, '01231']]],
    9: [188, '0cd76832', '4d0be0d7', [[7, 49, '10001'], [1, 53, '00001'], [4, 12, '11110'], [2, 16, '01100']]],
  },
};
const RUNS = {
  XS: {
    3: [54, '83ce9db3', '52b3f371', [[3, 17, '20100'], [6, 25, '00010'], [6, 12, '00001'], [9, 4, '01111']]],
    9: [54, 'a39b25b2', 'd0cb9a07', [[3, 3, '00111'], [3, 17, '01011'], [13, 2, '11010'], [3, 6, '11100']]],
  },
  M: {
    3: [186, '1468af74', '95d33f89', [[4, 25, '12100'], [6, 25, '10000'], [13, 24, '00102'], [1, 14, '00010']]],
    9: [191, 'de3e77d4', 'cfbcdc4b', [[16, 9, '00001'], [2, 35, '10001'], [5, 40, '10121'], [3, 60, '02100']]],
  },
};

test('护栏 · 地图生成：固定种子的地图哈希不变（XS / M / XL；宝箱规则不影响地图）', () => {
  for (const [id, seeds] of Object.entries(MAPS)) {
    for (const old of [false, true]) {
      const cfg = cfgOf(id, old);
      for (const [seed, hash] of Object.entries(seeds)) {
        assert.equal(createMatch(Number(seed), cfg).map.hash, hash, `${id} 种子 ${seed}${old ? '（旧宝箱）' : ''}`);
      }
    }
  }
});

function checkRuns(runs, old) {
  for (const [id, list] of Object.entries(runs)) {
    const cfg = cfgOf(id, old);
    for (const [seed, [endTurn, first, last, seats]] of Object.entries(list)) {
      const r = runMatch(Number(seed), cfg, { hashes: true });
      const tag = `${id} 种子 ${seed}${old ? '（旧宝箱）' : ''}`;
      assert.equal(r.state.endTurn, endTurn, `${tag} 终局回合`);
      assert.equal(r.hashes.length, endTurn, `${tag} 逐回合哈希条数`);
      assert.equal(r.hashes[0], first, `${tag} 第 1 回合后状态哈希`);
      assert.equal(r.hashes[r.hashes.length - 1], last, `${tag} 终局状态哈希`);
      assert.deepEqual(r.state.actors.map((a) => [scoreOf(a, cfg), a.stamina, a.gems.join('')]), seats, `${tag} 分数 / 体力 / 宝石`);
      assert.ok(r.state.actors.every((a) => a.status === 'escaped'), `${tag} 全员到达`);
    }
  }
}

test('护栏 · 旧规则对照：宝箱配置改回随机分 / 体力 → 与 2026-11-10 冻结值逐字节相同（代码没动）', () => checkRuns(RUNS_OLD, true));

test('护栏 · 结算 / 计分 / 体力 / 启发式对手（SPEC-0.4）：固定种子四人启发式对局的过程与终局不变', () => checkRuns(RUNS, false));

test('护栏 · 录像严格回放：记录 → 回放逐回合哈希一致，终局与直跑相同', () => {
  for (const id of ['XS', 'M']) {
    const cfg = cfgOf(id);
    const r = runMatch(9, cfg, { record: true });
    const rp = replay(r.record, cfg);
    assert.ok(rp.complete, `${id} 回放完整`);
    assert.equal(rp.state.endTurn, RUNS[id][9][0], `${id} 回放终局回合`);
    assert.deepEqual(rp.state.actors.map((a) => [scoreOf(a, cfg), a.stamina]), RUNS[id][9][3].map(([s, st]) => [s, st]), `${id} 回放终局分数 / 体力`);
  }
});

test('宝箱（SPEC-0.4）：每次开箱都是 +5 分、不给体力', () => {
  let opens = 0;
  for (const id of ['XS', 'M']) {
    const cfg = cfgOf(id);
    for (const seed of [3, 9, 21]) {
      const r = runMatch(seed, cfg);
      for (const a of r.state.actors) {
        opens += a.chestOpens;
        assert.equal(a.chestScore, 5 * a.chestOpens, `${id} 种子 ${seed} 座位 ${a.seat}`);
        assert.equal(a.chestStamina, 0);
      }
    }
  }
  assert.ok(opens >= 3, `应开过几次箱（实际 ${opens}）`);
});
