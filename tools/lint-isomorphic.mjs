#!/usr/bin/env node
// 同构门禁（06 §3.4）：同时跑在浏览器与 Node（服务器宿主 / 校验器）上的共享代码，
// 不得引用 DOM / 浏览器专有 API，也不得引用 Node 专有 API；只允许相对路径 import，且只能 import 共享代码。
// 用法：node tools/lint-isomorphic.mjs   （有违规退出码 1）

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lint-determinism.mjs';

/** 共享代码：目录或单个文件（相对仓库根）。 */
export const SHARED = ['src/core', 'src/ai', 'src/record', 'src/config', 'src/sim', 'src/app/scheduler.js', 'src/app/version.js'];

export const RULES = [
  {
    id: 'browser',
    re: /\b(?:window|document|localStorage|sessionStorage|indexedDB|navigator|HTMLElement|OffscreenCanvas|requestAnimationFrame|XMLHttpRequest|WebSocket|Worker)\b|\blocation\.|\bfetch\s*\(|\bnew\s+(?:Image|Blob)\b/,
  },
  { id: 'node', re: /\brequire\s*\(|\bprocess\.|\bBuffer\b|\b__dirname\b|\b__filename\b/ },
];

const isShared = (rel) => SHARED.some((s) => rel === s || rel.startsWith(`${s}/`));

/** @returns {{file:string, line:number, rule:string, text:string}[]} */
export function lintSource(relPath, text) {
  const file = relPath.split(sep).join('/');
  const out = [];
  const lines = stripComments(text).split('\n');
  lines.forEach((ln, i) => {
    for (const rule of RULES) if (rule.re.test(ln)) out.push({ file, line: i + 1, rule: rule.id, text: ln.trim() });
    for (const m of ln.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        out.push({ file, line: i + 1, rule: 'import', text: `非相对路径 import：${spec}` });
        continue;
      }
      const target = join(dirname(file), spec).split(sep).join('/');
      if (!isShared(target)) out.push({ file, line: i + 1, rule: 'import', text: `共享代码 import 了非共享模块：${target}` });
    }
  });
  return out;
}

function walk(p, acc) {
  let st;
  try { st = statSync(p); } catch { return acc; }
  if (st.isFile()) {
    if (/\.m?js$/.test(p)) acc.push(p);
    return acc;
  }
  for (const name of readdirSync(p)) walk(join(p, name), acc);
  return acc;
}

export function lintRepo(root) {
  const files = SHARED.flatMap((d) => walk(resolve(root, d), []));
  const violations = files.flatMap((f) => lintSource(relative(root, f), readFileSync(f, 'utf8')));
  return { files: files.length, violations };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { files, violations } = lintRepo(root);
  for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  console.log(`lint-isomorphic: ${files} files, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
