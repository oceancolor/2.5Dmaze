// 04 K11 / K12 / K14：体积门禁的判定逻辑，以及它确实接在 npm test 链上（超了 npm test 必须失败）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUDGETS, checkBudget, classify, runtimeFiles } from '../tools/size-budget.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('K11 / K12：当前运行时资源在预算内（首屏只算 1× 地图图集）', async () => {
  const r = checkBudget(await runtimeFiles(root));
  assert.ok(r.ok, r.failures.join('; '));
  assert.ok(r.totals.firstScreen < r.totals.total);
  assert.equal(classify('assets/atlas/pilot.png'), 'atlasFirst');
  assert.equal(classify('assets/atlas/pilot@2x.png'), 'atlas');
  assert.equal(classify('assets/atlas/env.png'), 'atlas');
});

test('K14：超预算判定为失败（阳性对照），且脚本接在 npm test 链上', async () => {
  const files = await runtimeFiles(root);
  const over = checkBudget([...files, { rel: 'assets/atlas/huge.png', size: BUDGETS.total }]);
  assert.equal(over.ok, false);
  assert.ok(over.failures.some((f) => f.startsWith('total')));
  const js = checkBudget([...files, { rel: 'src/bloat.js', size: BUDGETS.js }]);
  assert.ok(js.failures.some((f) => f.startsWith('js')));
  const first = checkBudget([...files, { rel: 'assets/atlas/pilot.json', size: BUDGETS.firstScreen }]);
  assert.ok(first.failures.some((f) => f.startsWith('firstScreen')));

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const chain = pkg.scripts.test.split('&&').map((s) => s.trim());
  assert.ok(chain.includes('node tools/size-budget.mjs'), 'npm test 必须包含 size-budget');
  assert.ok(chain.indexOf('node tools/size-budget.mjs') < chain.findIndex((s) => s.startsWith('node --test')), '门禁在用例之前、用 && 串联');

  const run = spawnSync(process.execPath, ['tools/size-budget.mjs'], { cwd: root, env: { ...process.env, SIZE_BUDGET_INJECT_BYTES: String(4 * 1024 * 1024) }, encoding: 'utf8' });
  assert.equal(run.status, 1, '注入 4 MB 后脚本退出码必须为 1');
  assert.match(run.stderr, /size-budget FAILED/);
});
