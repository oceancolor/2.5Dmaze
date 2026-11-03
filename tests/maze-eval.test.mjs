// 整局评测：输出结构与确定性、命令行冒烟（含退出码）、参考脚本与原生启发式的差距在阈值内（接口够用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { parseSeeds, runEval, renderMarkdown } from '../src/player/eval/run-eval.js';

const REF_PATH = new URL('../src/player/builtin/heuristic.js', import.meta.url);
const REF = readFileSync(REF_PATH, 'utf8');
const node = (o) => createNodeScriptController({ code: o.spec.code, map: o.match.map, seat: o.seat, cfg: o.cfg, seed: o.match.seed, mode: 'measure' });
const seats = (code) => [{ kind: 'script', code, name: '参考' }, { kind: 'heuristic' }, { kind: 'mock', persona: 'bold' }, { kind: 'heuristic' }];
// 耗时与「按正式预算会超时」取决于机器负载（并行跑测试时会变），比较时去掉；对局结果本身必须一致
const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'wallMs' || /^ms|Ms|ms$|^overBudget|^overBudget/.test(k) || k === 'overBudget' ? undefined : v)));

test('种子写法：范围 / 列表 / 字符串', () => {
  assert.deepEqual(parseSeeds('1-3,9'), [1, 2, 3, 9]);
  assert.equal(parseSeeds('abc').length, 1);
});

test('runEval：结构完整、同样输入两次结果相同（除耗时）', () => {
  const run = () => runEval({ size: 'XS', seeds: '1-4', seats: seats(REF), makeScript: node, worst: 2 });
  const a = run();
  const b = run();
  assert.deepEqual(strip(a), strip(b));
  assert.equal(a.seats.length, 4);
  assert.ok(a.baseline && a.baseline.delta);
  assert.equal(a.worst.length, 2);
  assert.ok(a.seats[0].script && Number.isInteger(a.seats[0].script.overBudgetTurns));
  assert.match(renderMarkdown(a), /整局评测 · XS/);
});

test('参考脚本（只用 v2 接口）与原生启发式：XS / S 各 40 局，到达率差 ≤ 5 个百分点、均分差 ≤ 0.6', () => {
  for (const size of ['XS', 'S']) {
    const r = runEval({ size, seeds: '1-40', seats: [{ kind: 'script', code: REF }, { kind: 'heuristic' }, { kind: 'heuristic' }, { kind: 'heuristic' }], makeScript: node });
    assert.ok(Math.abs(r.baseline.delta.escapeRate) <= 0.05, `${size} 到达率差 ${r.baseline.delta.escapeRate}`);
    assert.ok(Math.abs(r.baseline.delta.avgScore) <= 0.6, `${size} 均分差 ${r.baseline.delta.avgScore}`);
  }
});

test('maze-eval 命令行：JSON 输出可解析；编译失败退出码 2；参数错误退出码 1', () => {
  const cli = fileURLToPath(new URL('../tools/maze-eval.mjs', import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const ok = run(['--script', fileURLToPath(REF_PATH), '--size', 'XS', '--seeds', '1-3', '--format', 'json', '--seat2', 'mock:chest']);
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.seeds, 3);
  assert.equal(j.seats[2].kind, 'mock');
  const dir = mkdtempSync(join(tmpdir(), 'maze-eval-'));
  const badFile = join(dir, 'bad.js');
  writeFileSync(badFile, 'function decide(obs, api) { return (; }');
  assert.equal(run(['--script', badFile]).status, 2);
  assert.equal(run(['--nope']).status, 1);
  assert.match(run(['--help']).stdout, /用法/);
});
