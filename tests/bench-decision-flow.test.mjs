// 决策协议基准工具（第 8 项）：能跑、口径正确；现行规则 stale = 0，旧延迟对照里 stale > 0（量化「延迟」这一项的作用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { benchGame, parseSeeds, summarize } from '../tools/bench-decision-flow.mjs';

test('基准：现行规则（零缓冲）stale = 0；旧规则对照（延迟 2）有 stale；两种模式都能打完', () => {
  assert.deepEqual(parseSeeds('1-3,7'), [1, 2, 3, 7]);
  const now = summarize([1, 2, 3, 4].map((s) => benchGame('XS', s)));
  const old = summarize([1, 2, 3, 4].map((s) => benchGame('XS', s, { latency: 2 })));
  assert.ok(now.allEnded && old.allEnded);
  assert.equal(now.outcomes.stale, 0);
  assert.ok(old.outcomes.stale > 0, '旧规则的 +2 延迟会产生作废');
  assert.ok(now.outcomes.applied > 0 && now.outcomes.reached > 0);
  assert.ok(now.avgPromptChars > now.avgPromptCharsNoTraj, '提示词带了轨迹');
  const aware = summarize([1, 2].map((s) => benchGame('XS', s, { mode: 'aware' })));
  assert.ok(aware.allEnded);
  assert.equal(aware.outcomes.stale, 0);
});

test('基准：会等待的玩家策略（SPEC-0.4）真的会等、能打完、等待只在 woken 时结束', () => {
  const r = summarize([1, 2, 3, 4, 5, 6].map((s) => benchGame('S', s, { mode: 'aware', player: 'waiter' })));
  assert.ok(r.allEnded);
  assert.ok(r.waitedPerGame > 0, `每局等待 ${r.waitedPerGame} 回合`);
  assert.ok(r.outcomes.woken > 0);
  assert.equal(r.me.escapeRate, 1, '等待不会把自己等出局');
});
