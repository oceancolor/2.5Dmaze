#!/usr/bin/env node
// 确定性门禁（SPEC §12）：内核 / AI / 记录 / 仿真目录里禁止出现时钟、计时器与非受控随机源。
//   Math.random            只允许在 src/core/rng.js
//   Date.now / new Date / performance.now  只允许在 src/app/clock.js
//   setTimeout / setInterval / setImmediate / requestAnimationFrame  一律禁止
// 用法：node tools/lint-determinism.mjs   （有违规退出码 1）

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCAN_DIRS = ['src/core', 'src/ai', 'src/record', 'src/sim', 'src/config'];

export const RULES = [
  { id: 'random', re: /\bMath\.random\b/, allow: ['src/core/rng.js'] },
  { id: 'clock', re: /\bDate\.now\b|\bnew\s+Date\b|\bperformance\.now\b/, allow: ['src/app/clock.js'] },
  { id: 'timer', re: /\b(?:setTimeout|setInterval|setImmediate|requestAnimationFrame)\b/, allow: [] },
];

/** 去掉注释（足够应付本项目代码风格：不处理字符串里的 // 与 /*）。 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
}

/** @returns {{file:string, line:number, rule:string, text:string}[]} */
export function lintSource(relPath, text) {
  const file = relPath.split(sep).join('/');
  const out = [];
  const lines = stripComments(text).split('\n');
  for (const rule of RULES) {
    if (rule.allow.includes(file)) continue;
    lines.forEach((ln, i) => {
      if (rule.re.test(ln)) out.push({ file, line: i + 1, rule: rule.id, text: ln.trim() });
    });
  }
  return out;
}

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(m?js)$/.test(name)) acc.push(p);
  }
  return acc;
}

export function lintRepo(root) {
  const files = SCAN_DIRS.flatMap((d) => walk(join(root, d), []));
  const violations = files.flatMap((f) => lintSource(relative(root, f), readFileSync(f, 'utf8')));
  return { files: files.length, violations };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { files, violations } = lintRepo(root);
  for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  console.log(`lint-determinism: ${files} files, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
