// 护栏（决策协议改造 §14 C11）：决策时序 / 帧 / 接口改造期间，下列「游戏本身」的结果必须逐字节不变。
// 冻结值取自 2026-11-10 改造前的内核。这些对局全是启发式座位，不经过大模型规划器，
// 所以零延迟改造不应让任何一个值变化；某个值变了 = 动到了地图生成、结算、计分、体力或启发式对手。
// 真要改游戏规则时，在同一提交里更新这里的值并写明原因。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createMatch } from '../src/core/state.js';
import { scoreOf } from '../src/core/scoring.js';
import { runMatch } from '../src/sim/headless.js';
import { replay } from '../src/record/replayer.js';

const cfgOf = (id) => (id === 'XL' ? makeConfig() : makeConfig(matchOverrides('manual', id)));

const MAPS = {
  XS: { 1: '8c6d64c5', 42: '653073cc', 20261110: '66256c13' },
  M: { 1: '89b854db', 42: 'aa0f11bb', 20261110: '7004225e' },
  XL: { 1: '5addfc8a', 42: 'd47ef2a8', 20261110: '26fb81f1' },
};

// [终局回合, 首回合后哈希, 终局哈希, 各座位 [分数, 剩余体力, 五色宝石数]]
const RUNS = {
  XS: {
    3: [48, '4222bff0', 'a77a49cf', [[3, 27, '10110'], [1, 19, '10000'], [2, 2, '01001'], [5, 8, '01112']]],
    9: [49, '6c9a54c8', '393d0927', [[4, 7, '11110'], [4, 5, '10111'], [7, 11, '01010'], [4, 4, '11101']]],
  },
  M: {
    3: [188, '1468af74', '12401580', [[2, 49, '01100'], [4, 45, '31000'], [1, 40, '00001'], [7, 12, '01231']]],
    9: [188, '0cd76832', '4d0be0d7', [[7, 49, '10001'], [1, 53, '00001'], [4, 12, '11110'], [2, 16, '01100']]],
  },
};

test('护栏 · 地图生成：固定种子的地图哈希不变（XS / M / XL）', () => {
  for (const [id, seeds] of Object.entries(MAPS)) {
    const cfg = cfgOf(id);
    for (const [seed, hash] of Object.entries(seeds)) {
      assert.equal(createMatch(Number(seed), cfg).map.hash, hash, `${id} 种子 ${seed}`);
    }
  }
});

test('护栏 · 结算 / 计分 / 体力 / 启发式对手：固定种子四人启发式对局的过程与终局不变', () => {
  for (const [id, runs] of Object.entries(RUNS)) {
    const cfg = cfgOf(id);
    for (const [seed, [endTurn, first, last, seats]] of Object.entries(runs)) {
      const r = runMatch(Number(seed), cfg, { hashes: true });
      const tag = `${id} 种子 ${seed}`;
      assert.equal(r.state.endTurn, endTurn, `${tag} 终局回合`);
      assert.equal(r.hashes.length, endTurn, `${tag} 逐回合哈希条数`);
      assert.equal(r.hashes[0], first, `${tag} 第 1 回合后状态哈希`);
      assert.equal(r.hashes[r.hashes.length - 1], last, `${tag} 终局状态哈希`);
      assert.deepEqual(r.state.actors.map((a) => [scoreOf(a, cfg), a.stamina, a.gems.join('')]), seats, `${tag} 分数 / 体力 / 宝石`);
      assert.ok(r.state.actors.every((a) => a.status === 'escaped'), `${tag} 全员到达`);
    }
  }
});

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
