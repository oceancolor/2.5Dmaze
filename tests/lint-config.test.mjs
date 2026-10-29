import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lintSource, lintRepo } from '../tools/lint-determinism.mjs';
import * as iso from '../tools/lint-isomorphic.mjs';
import { makeConfig, DEFAULT_CONFIG, staminaFor } from '../src/config/default.config.js';

test('同构 lint（06 §3.4）：共享代码抓 DOM / 浏览器 API / Node API / 越界 import；仓库当前 0 违规', () => {
  assert.equal(iso.lintSource('src/core/x.js', 'const w = window.innerWidth;').length, 1);
  assert.equal(iso.lintSource('src/ai/x.js', 'document.body.append(el);').length, 1);
  assert.equal(iso.lintSource('src/ai/x.js', 'const r = await fetch(url);').length, 1);
  assert.equal(iso.lintSource('src/record/x.js', 'localStorage.setItem(k, v);').length, 1);
  assert.equal(iso.lintSource('src/core/x.js', 'const b = Buffer.from(s);').length, 1);
  assert.equal(iso.lintSource('src/core/x.js', 'if (process.env.X) {}').length, 1);
  assert.equal(iso.lintSource('src/core/x.js', "import fs from 'node:fs';").length, 1);
  assert.equal(iso.lintSource('src/ai/x.js', "import { h } from '../ui/hud.js';").length, 1);
  assert.equal(iso.lintSource('src/ai/x.js', "import { now } from '../app/clock.js';").length, 1);
  assert.equal(iso.lintSource('src/ai/x.js', "import { step } from '../core/game.js';").length, 0);
  assert.equal(iso.lintSource('src/app/scheduler.js', "import { createHeuristic } from '../ai/heuristic.js';").length, 0);
  assert.equal(iso.lintSource('src/core/x.js', '// window.alert 只在注释里\nconst allocation = 1;').length, 0);
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const r = iso.lintRepo(root);
  assert.ok(r.files > 20);
  assert.deepEqual(r.violations, []);
});

test('确定性 lint：抓 Math.random / 时钟 / 计时器，白名单与注释放行', () => {
  assert.equal(lintSource('src/core/foo.js', 'const r = Math.random();').length, 1);
  assert.equal(lintSource('src/core/rng.js', 'const r = Math.random();').length, 0);
  assert.equal(lintSource('src/ai/x.js', 'const t = Date.now();').length, 1);
  assert.equal(lintSource('src/sim/x.js', 'const t = new Date();').length, 1);
  assert.equal(lintSource('src/record/x.js', 'setTimeout(f, 1)').length, 1);
  assert.equal(lintSource('src/core/x.js', '// Math.random 不允许\n/* Date.now() */ const a = 1;').length, 0);
});

test('确定性 lint：仓库当前 0 违规', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { files, violations } = lintRepo(root);
  assert.ok(files > 10);
  assert.deepEqual(violations, []);
});

test('config：未知键直接抛错；结果冻结；体力按玩家通道取值', () => {
  assert.throws(() => makeConfig({ rules: { maxTurn: 1 } }), /unknown config key: rules\.maxTurn/);
  assert.throws(() => makeConfig({ maze: { thinKeep: 1.2 } }));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.rules.staminaByMode));
  const c = makeConfig({ match: { playerMode: 'prompt' }, rules: { staminaByMode: { prompt: 450 } } });
  assert.equal(staminaFor(c), 450);
  assert.equal(staminaFor(DEFAULT_CONFIG), 400);
});
