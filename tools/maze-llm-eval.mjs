#!/usr/bin/env node
// maze-llm-eval：用你自己的大模型，在一批固定种子上试跑「接入大模型」模式（批次 6 P3），给人和 agent 迭代思路用。
// 与游戏设置页「思路试跑 / A/B 对比」同一个引擎（src/player/eval/llm-eval.js）；这里直连服务商，key 只从环境变量读。
// 退出码：0 正常，1 参数错误，4 没加 --yes（只打印费用估算），3 试跑出错。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, checkBaseUrl, thinkingPlan, THINKING } from '../server/providers.mjs';
import { chatCompletion } from '../server/llm-relay.mjs';
import { messagesFor } from '../src/app/transport.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { estimateTrial, runLlmTrial, trialMarkdown, compareTrials } from '../src/player/eval/llm-eval.js';
import { parseSeeds } from '../src/player/eval/run-eval.js';
import { makeConfig } from '../src/config/default.config.js';
import { AUTONOMY } from '../src/ai/codec.js';

const HELP = `maze-llm-eval —— 用你自己的大模型试跑「接入大模型」模式（思路 / 模型 / 思考档位的量化对比）

用法：
  MAZE_LLM_KEY=sk-… npm run eval:llm -- --provider kimi --strategy my-strategy.txt --size XS --seeds 1-5 --yes
  （PowerShell：$env:MAZE_LLM_KEY='sk-…'; npm run eval:llm -- …）

选项：
  --provider <id>        hunyuan | kimi | deepseek | glm | custom（默认 kimi；预设都在腾讯云 TokenHub，用 TokenHub 的 API Key）
  --base-url <url>       custom 时必填（https 公网）；--model <名> 覆盖模型名
  --strategy <文件>      思路文本（≤ 2000 字，必填）
  --autonomy <free|blend|strict>  默认 blend
  --thinking <off|low|high>       默认 low
  --memory <文件>        跨局经验（可选，放进 system 提示词）
  --b-strategy <文件> / --b-provider / --b-model / --b-thinking / --b-memory
                         A/B 对比：B 变体（没给的项沿用 A）；同一批种子各跑一遍，按种子配对算分差
  --size <XS|S|M|L|XL>   默认 XS        --seeds <范围>  默认 1-5        --concurrency <n>  并行局数，默认 2
  --format <md|json>     默认 md        --records <目录>  每局记录 JSONL 写到该目录
  --yes                  确认费用后才真正调用（不加只打印估算）
陪练：三个「预判对手」脚本（src/player/builtin/aware.js），不花你的钱。费用记在你的服务商账户。`;

function parseArgs(argv) {
  const o = { provider: 'kimi', thinking: 'low', autonomy: 'blend', size: 'XS', seeds: '1-5', concurrency: 2, format: 'md', yes: false, b: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      return v;
    };
    const m = /^--b-(strategy|provider|model|thinking|memory)$/.exec(a);
    if (a === '--help' || a === '-h') o.help = true;
    else if (m) o.b[m[1]] = val();
    else if (a === '--provider') o.provider = val();
    else if (a === '--base-url') o.baseUrl = val();
    else if (a === '--model') o.model = val();
    else if (a === '--strategy') o.strategy = val();
    else if (a === '--autonomy') o.autonomy = val();
    else if (a === '--thinking') o.thinking = val();
    else if (a === '--memory') o.memory = val();
    else if (a === '--size') o.size = val().toUpperCase();
    else if (a === '--seeds') o.seeds = val();
    else if (a === '--concurrency') o.concurrency = Number(val());
    else if (a === '--format') o.format = val();
    else if (a === '--records') o.records = val();
    else if (a === '--yes') o.yes = true;
    else throw new Error(`未知参数 ${a}（--help 查看用法）`);
  }
  if (!o.help && !o.strategy) throw new Error('缺少 --strategy <思路文件>');
  if (!AUTONOMY[o.autonomy]) throw new Error('--autonomy 只能是 free / blend / strict');
  for (const t of [o.thinking, o.b.thinking].filter(Boolean)) if (!THINKING.includes(t)) throw new Error('--thinking 只能是 off / low / high');
  if (!['md', 'json'].includes(o.format)) throw new Error('--format 只能是 md 或 json');
  return o;
}

const readText = (p) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n').trim();

function modelOf(provider, model, baseUrl) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`不支持的服务商 ${provider}（hunyuan | kimi | deepseek | glm | custom）`);
  const base = provider === 'custom' ? checkBaseUrl(baseUrl) : p.baseUrl;
  const name = model || p.model;
  if (!name) throw new Error('custom 需要 --model');
  return { provider, base, model: name };
}

/** 直连服务商的传输层：与服务器中转同一张思考档位表、同一套失败分类。 */
function directTransport({ cfg, apiKey, m, thinking, onCall }) {
  const KIND = { auth: 'auth', bad: 'auth', blocked: 'unreachable', unreachable: 'unreachable', rate: '429', '5xx': '5xx', timeout: 'timeout' };
  const L = cfg.ai.llm;
  return (req, reply) => {
    const messages = messagesFor(req, cfg);
    const want = req.kind === 'repair' ? Math.max(L.repairMaxTokens, L.contractMaxTokens) : L.contractMaxTokens;
    const tp = thinkingPlan(m.provider, thinking, { requested: want });
    const ask = (p) => chatCompletion({ base: m.base, model: m.model, apiKey, messages, maxTokens: p.maxTokens, temperature: L.temperature, extra: p.extra, timeoutMs: p.timeoutMs });
    // 思考用光预算、答案为空 → 用「关」档补问一次（与服务器中转一致）
    ask(tp).then((r) => (r.ok && tp.level !== 'off' && r.finish === 'length' && !String(r.text || '').trim() ? ask(thinkingPlan(m.provider, 'off', { requested: want })) : r)).then((r) => {
      onCall({ seat: req.seat, kind: req.kind, ok: r.ok, ms: r.ms, usage: r.ok ? r.usage : null });
      if (r.ok) reply.deliver(r.text);
      else {
        console.error(`  调用失败（T${req.requestTurn} ${req.kind} · ${r.kind}）：${r.message}`);
        reply.fail(KIND[r.kind] || '5xx', r.message);
      }
    });
  };
}

let o;
try {
  o = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (o.help) {
  console.log(HELP);
  process.exit(0);
}

const cfg = makeConfig({ match: { playerMode: 'byok' } });
let A;
let B = null;
try {
  A = { m: modelOf(o.provider, o.model, o.baseUrl), strategy: readText(o.strategy), thinking: o.thinking, memory: o.memory ? readText(o.memory) : '' };
  if (Object.keys(o.b).length) {
    B = {
      m: modelOf(o.b.provider || o.provider, o.b.model || (o.b.provider ? undefined : o.model), o.baseUrl),
      strategy: o.b.strategy ? readText(o.b.strategy) : A.strategy,
      thinking: o.b.thinking || A.thinking,
      memory: o.b.memory ? readText(o.b.memory) : A.memory,
    };
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const games = parseSeeds(o.seeds).length;
const est = estimateTrial({ size: o.size, games, thinking: B && B.thinking === 'high' ? 'high' : A.thinking, variants: B ? 2 : 1 });
const estLine = `估算：约 ${est.calls} 次调用 · 输入约 ${Math.round(est.tokensIn / 1000)}k / 输出约 ${Math.round(est.tokensOut / 1000)}k token · 约 ${est.minutes} 分钟（费用记在你的服务商账户）`;
if (!o.yes) {
  console.log(`${estLine}\n确认后加 --yes 重新运行。`);
  process.exit(4);
}
const apiKey = process.env.MAZE_LLM_KEY;
if (!apiKey) {
  console.error('缺少环境变量 MAZE_LLM_KEY（你的模型 API key；不会写进任何文件）');
  process.exit(1);
}
console.error(estLine);

const aware = { kind: 'script', code: readFileSync(fileURLToPath(new URL('../src/player/builtin/aware.js', import.meta.url)), 'utf8'), name: '预判对手（参考实现）', author: '迷宫寻宝', origin: 'builtin' };
const run = (v, tag) => runLlmTrial({
  size: o.size, seeds: o.seeds, concurrency: o.concurrency,
  variant: {
    name: `${v.m.model} · 思考${{ off: '关', low: '低', high: '高' }[v.thinking]}`, provider: v.m.provider, model: v.m.model,
    strategy: v.strategy, autonomy: o.autonomy, thinking: v.thinking, memory: v.memory,
  },
  opponents: [aware, aware, aware],
  makeScript: ({ spec, seat, match, cfg: c }) => createNodeScriptController({ code: spec.code, map: match.map, seat, cfg: c, seed: match.seed, isPlayer: false }),
  makeTransport: ({ onCall }) => directTransport({ cfg, apiKey, m: v.m, thinking: v.thinking, onCall }),
  onProgress: (d, t, g) => console.error(`${tag} ${d}/${t} · 种子 ${g.seed} · ${g.status === 'escaped' ? `到达 ${g.rawScore} 分` : '出局'} · 第 ${g.place} 名 · 白跑 ${g.stats.wasted} 步`),
});

try {
  const ra = await run(A, 'A');
  const rb = B ? await run(B, 'B') : null;
  if (o.records) {
    mkdirSync(o.records, { recursive: true });
    for (const [tag, r] of [['A', ra], ['B', rb]]) if (r) for (const g of r.games) writeFileSync(join(o.records, `${tag}-${o.size}-${g.seed}.jsonl`), g.jsonl);
  }
  const strip = (r) => r && { ...r, games: r.games.map(({ jsonl, ...g }) => g) };
  if (o.format === 'json') console.log(JSON.stringify({ a: strip(ra), b: strip(rb), compare: rb ? compareTrials(ra, rb) : null }, null, 2));
  else console.log(trialMarkdown(ra, rb));
} catch (e) {
  console.error(`试跑出错：${e.message}`);
  process.exit(3);
}
