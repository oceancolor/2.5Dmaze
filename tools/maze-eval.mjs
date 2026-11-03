#!/usr/bin/env node
// maze-eval：本机整局评测（统一编程接口 v2）。给 agent 和人用同一份输出迭代脚本。
// 用法见 --help；输出与游戏里「整局试跑」一致。退出码：0 正常，1 参数错误，2 脚本编译失败，3 评测出错。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createNodeScriptController, compileScript } from '../src/player/node-adapter.mjs';
import { runEval, renderMarkdown } from '../src/player/eval/run-eval.js';
import { parseHeader } from '../src/player/library.js';

const HELP = `maze-eval —— 迷宫寻宝脚本整局评测（统一编程接口 v2，文档 docs/07-脚本编程接口.md）

用法：
  node tools/maze-eval.mjs --script my-bot.js [选项]
  npm run eval -- --script my-bot.js --size S --seeds 1-50

选项：
  --script <路径>        座位 0 的脚本（必填，除非 --seat0 另有指定）
  --seat0..--seat3 <x>   各座位：heuristic | mock:<balanced|setHunter|chest|cautious|bold> | script:<路径>
                         默认：座位 0 = --script，座位 1–3 = heuristic
  --size <XS|S|M|L|XL>   地图规格，默认 XS
  --seeds <范围>         如 1-20、1,5,9、abc（字符串种子），默认 1-20
  --budget <measure|enforce>
                         measure（默认）：不打断，只统计按正式预算会超时的回合，结果可复现
                         enforce：与实时对局相同，超时的回合作废、沿意图兜底
  --format <md|json>     输出格式，默认 md
  --worst <n>            列出最差的 n 局，默认 5
  --no-baseline          不跑「换成启发式」的对照
  --records <目录>       把每局记录 JSONL 写到该目录（可在游戏里回放 / 上传校验）
  --help                 显示本帮助

预算：每回合 50 ms + 时间银行（上限 5000 ms），init 2000 ms。`;

function parseArgs(argv) {
  const o = { size: 'XS', seeds: '1-20', budget: 'measure', format: 'md', worst: 5, baseline: true, records: null, script: null, seats: [null, null, null, null] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--script') o.script = val();
    else if (/^--seat[0-3]$/.test(a)) o.seats[Number(a[6])] = val();
    else if (a === '--size') o.size = val().toUpperCase();
    else if (a === '--seeds') o.seeds = val();
    else if (a === '--budget') o.budget = val();
    else if (a === '--format') o.format = val();
    else if (a === '--worst') o.worst = Number(val());
    else if (a === '--no-baseline') o.baseline = false;
    else if (a === '--records') o.records = val();
    else throw new Error(`未知参数 ${a}（--help 查看用法）`);
  }
  if (!['measure', 'enforce'].includes(o.budget)) throw new Error('--budget 只能是 measure 或 enforce');
  if (!['md', 'json'].includes(o.format)) throw new Error('--format 只能是 md 或 json');
  return o;
}

function loadScript(path) {
  const code = readFileSync(resolve(path), 'utf8');
  const h = parseHeader(code);
  return { kind: 'script', code, name: h.name || basename(path).replace(/\.m?js$/, ''), author: h.author || '', origin: h.origin || 'human', path };
}

function seatSpec(text) {
  if (!text || text === 'heuristic') return { kind: 'heuristic' };
  if (text.startsWith('mock:')) return { kind: 'mock', persona: text.slice(5) || 'balanced' };
  if (text === 'mock') return { kind: 'mock', persona: 'balanced' };
  if (text.startsWith('script:')) return loadScript(text.slice(7));
  throw new Error(`座位配置 ${text} 无法识别（heuristic | mock:<人格> | script:<路径>）`);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

let seats;
try {
  seats = opts.seats.map((s, i) => (i === 0 && !s ? (opts.script ? loadScript(opts.script) : null) : seatSpec(s)));
  if (!seats[0]) throw new Error('缺少 --script（或 --seat0）');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
for (const s of seats) {
  if (s.kind !== 'script') continue;
  try {
    compileScript(s.code);
  } catch (e) {
    console.error(`脚本编译失败（${s.path}）：${e.message}`);
    process.exit(2);
  }
}

let result;
try {
  result = runEval({
    size: opts.size,
    seeds: opts.seeds,
    seats,
    baseline: opts.baseline,
    worst: opts.worst,
    keepRecords: Boolean(opts.records),
    // 评测没有人在键盘前：连续硬异常一律降级为自动回家（L1），不切手动
    makeScript: ({ spec, seat, match, cfg }) => createNodeScriptController({ code: spec.code, map: match.map, seat, cfg, seed: match.seed, mode: opts.budget, isPlayer: false }),
    onProgress: process.stderr.isTTY ? (d, t) => process.stderr.write(`\r评测中 ${d}/${t}`) : null,
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
} catch (e) {
  console.error(`评测出错：${e.message}`);
  process.exit(3);
}

if (opts.records) {
  mkdirSync(opts.records, { recursive: true });
  for (const r of result.records) writeFileSync(join(opts.records, `${opts.size}-${r.seed}.jsonl`), r.jsonl);
  delete result.records;
}
console.log(opts.format === 'json' ? JSON.stringify(result, null, 2) : renderMarkdown(result));
