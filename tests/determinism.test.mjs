import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from './helpers.mjs';
import { makeConfig } from '../src/config/default.config.js';
import { runMatch } from '../src/sim/headless.js';
import { replay, ReplayMismatch } from '../src/record/replayer.js';
import { encodeIntents, decodeIntents } from '../src/record/recorder.js';
import { subSeed, createStream, next, normalizeSeed } from '../src/core/rng.js';

test('随机流：同种子同序列；具名子流互不相同；字符串种子稳定', () => {
  const a = createStream(123);
  const b = createStream(123);
  for (let i = 0; i < 100; i++) assert.equal(next(a), next(b));
  assert.notEqual(subSeed(123, 1), subSeed(123, 2));
  assert.equal(normalizeSeed('abc'), normalizeSeed('abc'));
  assert.notEqual(normalizeSeed('abc'), normalizeSeed('abd'));
});

test('同种子两次跑局：逐回合状态哈希完全一致', () => {
  for (const seed of [5, 77]) {
    const a = runMatch(seed, CFG, { hashes: true });
    const b = runMatch(seed, CFG, { hashes: true });
    assert.deepEqual(a.hashes, b.hashes);
    assert.ok(a.state.ended);
  }
});

const recorded = runMatch(9, CFG, { record: true });

test('严格回放：只读记录逐回合复现，终局一致', () => {
  const r = replay(recorded.record, CFG);
  assert.ok(r.complete);
  assert.equal(r.state.endTurn, recorded.state.endTurn);
  assert.deepEqual(
    r.state.actors.map((a) => [a.status, a.x, a.y, a.stamina]),
    recorded.state.actors.map((a) => [a.status, a.x, a.y, a.stamina]),
  );
});

test('篡改一条意图 → ReplayMismatch（定位到该回合）', () => {
  const lines = recorded.record.trim().split('\n');
  const k = lines.findIndex((l) => {
    const o = JSON.parse(l);
    return o.t === 'turn' && /[NESW]/.test(o.i);
  });
  const o = JSON.parse(lines[k]);
  const pos = o.i.search(/[NESW]/);
  o.i = o.i.slice(0, pos) + '.' + o.i.slice(pos + 1);
  lines[k] = JSON.stringify(o);
  assert.throws(() => replay(lines, CFG), (e) => e instanceof ReplayMismatch && e.turn === o.n);
});

test('篡改状态哈希 / 换 config → ReplayMismatch', () => {
  const lines = recorded.record.trim().split('\n');
  const o = JSON.parse(lines[3]);
  o.h = o.h === '00000000' ? '00000001' : '00000000';
  const bad = lines.slice();
  bad[3] = JSON.stringify(o);
  assert.throws(() => replay(bad, CFG), ReplayMismatch);
  const other = makeConfig({ rules: { maxTurns: 601 } });
  assert.throws(() => replay(recorded.record, other), /configHash/);
});

test('意图编码：N E S W . 与不在场 -', () => {
  const actors = [{ status: 'active' }, { status: 'escaped' }, { status: 'active' }, { status: 'active' }];
  const s = encodeIntents(['N', 'E', 4, 'bogus'], actors);
  assert.equal(s, 'N-..');
  assert.deepEqual(decodeIntents('NESW.-'), ['N', 'E', 'S', 'W', '.', 'STAY']);
});
