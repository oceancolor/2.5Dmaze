#!/usr/bin/env node
// 体积门禁（04 K11 / K12 / K14）。接在 npm test 链上：超预算 → 退出码 1 → npm test 失败。
//   K11 静态资源总量 ≤ 4 MB，其中 JS ≤ 600 KB（SPEC U5：由 300 KB 翻倍，用户裁定）、图集 ≤ 3.0 MB（03 v1.5：由 2.5 MB 上调 20%，用户裁定）、字体 ≤ 200 KB
//   K12 首屏 ≤ 1.2 MB：入口页 + 样式 + 全部运行时 JS + 1× 地图图集（@2x 与场外 env 图集为非首屏，后台补拉）
// 运行时 = 浏览器会加载的文件：index.html、src/**（.js / .css）、assets/**。tools/ tests/ docs/ proxy/ 不计。

import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = 1024;
const MB = 1024 * 1024;

export const BUDGETS = Object.freeze({
  total: 4 * MB,
  js: 600 * KB,
  atlas: 3.0 * MB,
  font: 200 * KB,
  firstScreen: 1.2 * MB,
});

/** 文件分类：js | css | html | atlas | atlasFirst | font | other。 */
export function classify(rel) {
  const p = rel.replace(/\\/g, '/');
  const ext = extname(p);
  if (ext === '.js' || ext === '.mjs') return 'js';
  if (ext === '.css') return 'css';
  if (ext === '.html') return 'html';
  if (/\.(woff2?|ttf|otf)$/.test(p)) return 'font';
  if (p.startsWith('assets/atlas/')) return /\/pilot\.(png|json)$/.test(p) ? 'atlasFirst' : 'atlas';
  return 'other';
}

/** @param {{rel:string,size:number}[]} files @returns {{ok:boolean, totals:object, failures:string[]}} */
export function checkBudget(files, budgets = BUDGETS) {
  const t = { total: 0, js: 0, css: 0, html: 0, atlas: 0, atlasFirst: 0, font: 0, other: 0 };
  for (const f of files) {
    t.total += f.size;
    t[classify(f.rel)] += f.size;
  }
  const totals = {
    total: t.total,
    js: t.js,
    atlas: t.atlas + t.atlasFirst,
    font: t.font,
    firstScreen: t.html + t.css + t.js + t.atlasFirst,
  };
  const failures = Object.keys(budgets)
    .filter((k) => totals[k] > budgets[k])
    .map((k) => `${k} ${(totals[k] / KB).toFixed(0)} KB > ${(budgets[k] / KB).toFixed(0)} KB`);
  return { ok: failures.length === 0, totals, failures };
}

async function walk(root, dir, out) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else out.push({ rel: relative(root, full).replace(/\\/g, '/'), size: (await stat(full)).size });
  }
  return out;
}

/**
 * 收集运行时文件：从 index.html 出发，沿 <script src> / <link href> 与 JS 的静态 import、
 * `new URL('…', import.meta.url)`（Worker 桥）走依赖图；assets/ 整个计入（图集按名字运行时拉取）。
 */
export async function runtimeFiles(root) {
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const seen = new Set();
  const files = [];
  const add = async (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = await readFile(abs, 'utf8');
    files.push({ rel: relative(root, abs).replace(/\\/g, '/'), size: Buffer.byteLength(text) });
    const deps = [];
    if (abs.endsWith('.html')) {
      for (const m of text.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)) deps.push(join(root, m[1]));
    } else if (/\.m?js$/.test(abs)) {
      const base = dirname(abs);
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) deps.push(resolve(base, m[1]));
      for (const m of text.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) deps.push(resolve(base, m[1]));
    }
    for (const d of deps) await add(d);
  };
  await add(join(root, 'index.html'));
  await walk(root, join(root, 'assets'), files);
  return files.filter((f) => !/\.(md|txt)$/.test(f.rel));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const extra = Number(process.env.SIZE_BUDGET_INJECT_BYTES || 0); // K14 演练：人为注入体积，npm test 必须失败
  const files = await runtimeFiles(root);
  if (extra > 0) files.push({ rel: 'assets/atlas/__inject__.png', size: extra });
  const r = checkBudget(files);
  const f = (k) => `${(r.totals[k] / KB).toFixed(0)} / ${(BUDGETS[k] / KB).toFixed(0)} KB`;
  console.log(`size-budget: total ${f('total')} · js ${f('js')} · atlas ${f('atlas')} · font ${f('font')} · first-screen ${f('firstScreen')}`);
  if (!r.ok) {
    console.error(`size-budget FAILED: ${r.failures.join('; ')}`);
    process.exit(1);
  }
}
