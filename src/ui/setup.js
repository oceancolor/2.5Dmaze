// 开局设置（SPEC §9 玩家通道、§7 AI 对手）：
//   你怎么玩：自己手打 / 编写 Agent 脚本（统一编程接口 v2，模块 Worker）/ 接入大模型（05 模式 B，经服务器中转）
//   脚本：名称 / 作者 / 来源（人写 · agent 写）、脚本库（新建 / 导入 / 导出 / 删除）、试运行、整局试跑（与 maze-eval 同一引擎）、复制任务书
//   对手：每个 AI 选「模拟大模型 / 大模型（本地代理）/ 启发式 / 脚本」；脚本对手从脚本库选
//   对局：种子（空 = 随机）、默认倍速、方向映射；代理状态探测
// 设置存 localStorage（maze.setup.v1）。API key 绝不进 localStorage / 设置对象：只在点「保存」时从输入框读一次发给服务器，随即清空。

import { PERSONAS } from '../ai/mock-llm.js';
import { AUTONOMY, FOLLOW_ZH, buildMessages, buildPayload } from '../ai/codec.js';
import { createMatch } from '../core/state.js';
import { observe } from '../core/observe.js';
import { THINKING, DEFAULT_THINKING, isThinking } from '../app/transport.js';
import { memoryScope } from '../app/coach.js';
import { estimateTrial, trialMarkdown } from '../player/eval/llm-eval.js';
import { fnv1a, hex8 } from '../core/hash.js';
import { SCRIPT_TEMPLATE, SCRIPT_EXAMPLES } from '../player/script-host.js';
import { BUILTINS, ORIGINS, parseHeader, withHeader } from '../player/library.js';
import { buildBrief, buildStrategyBrief } from '../player/brief.js';
import { BUDGET } from '../player/runtime/budget.js';
import { MAPPINGS } from '../player/input.js';
import { MAP_SIZES, MAP_SIZE_IDS, DEFAULT_MAP_SIZE, isMapSize, matchOverrides } from '../config/map-sizes.js';
import { VISION_PRESETS, visionText } from '../config/vision-modes.js';
import { makeConfig } from '../config/default.config.js';
import { ACTOR_COLORS } from '../render/palette.js';
import { esc, frame, SEAT_NAMES, THINK_ZH, tokensText } from './hud.js';

const KEY = 'maze.setup.v1';
const MEMORY_MAX = makeConfig().ai.harness.memoryMaxChars;

/** 思路库（本机 localStorage）：每版思路一条，记下最近一次试跑的成绩，方便比较「哪版思路真的更好」。 */
const STRAT_KEY = 'maze.strategies.v1';
function createStrategyLibrary() {
  const load = () => {
    try {
      const a = JSON.parse(localStorage.getItem(STRAT_KEY) || '[]');
      return Array.isArray(a) ? a.filter((e) => e && typeof e.text === 'string') : [];
    } catch {
      return [];
    }
  };
  const store = (list) => {
    try {
      localStorage.setItem(STRAT_KEY, JSON.stringify(list.slice(0, 50)));
    } catch { /* 隐私模式 */ }
  };
  const idOf = (text) => `st_${hex8(fnv1a(text.trim()))}`;
  return {
    list: () => load().sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => load().find((e) => e.id === id) || null,
    save(name, text) {
      const t = String(text || '').trim();
      if (!t) return { error: '思路是空的' };
      const list = load();
      const id = idOf(t);
      const prev = list.find((e) => e.id === id);
      const e = { id, name: String(name || '').trim().slice(0, 30) || (prev ? prev.name : `思路 ${list.length + 1}`), text: t.slice(0, 2000), lastTrial: prev ? prev.lastTrial : null, updatedAt: Date.now() };
      store([e, ...list.filter((x) => x.id !== id)]);
      return e;
    },
    remove(id) {
      store(load().filter((e) => e.id !== id));
    },
    /** 试跑完成后记成绩（这版思路还不在库里就自动存一条）。 */
    noteTrial(text, summary) {
      const t = String(text || '').trim();
      if (!t) return;
      const list = load();
      const id = idOf(t);
      const prev = list.find((e) => e.id === id);
      const e = { id, name: prev ? prev.name : `思路 ${list.length + 1}`, text: t.slice(0, 2000), updatedAt: Date.now(), lastTrial: { ...summary, at: Date.now() } };
      store([e, ...list.filter((x) => x.id !== id)]);
    },
  };
}
const THINK_DESC = Object.freeze({
  off: '不思考，最快最省；只靠局面和博弈事实表直接选',
  low: '先想一小会儿再答（默认）；推理更强的模型开始拉开差距',
  high: '充分思考；每次决策可能要几十秒，费用明显更高',
});

export const BRAINS = Object.freeze({
  mock: '模拟大模型',
  proxy: '大模型（本地代理）',
  heuristic: '启发式',
  script: '脚本',
});

export function defaultSetup() {
  return {
    seed: '',
    speed: 2,
    mapping: 'grid',
    mapSize: DEFAULT_MAP_SIZE,
    evalRuns: 20,
    player: {
      mode: 'manual', code: SCRIPT_TEMPLATE, persona: PERSONAS.balanced.text, llm: 'mock',
      // 模式 B：keyId 只是服务器上那把 key 的编号（不是 key 本身）；keyMeta 只有服务商 / 模型名
      keyId: '', keyMeta: null, autonomy: 'blend', safetyGate: true, callCap: 0,
      // harness（批次 6）：思考档位默认「低」；跨局经验默认带上并在赛后自动更新
      thinking: DEFAULT_THINKING, useMemory: true, autoMemory: true,
      // 脚本（v2）：编辑器里的脚本说明；scriptId = 正在编辑的脚本库条目（'' = 未保存）；brief = 写给 agent 的要求
      scriptName: '我的脚本', scriptAuthor: '', scriptOrigin: 'human', scriptId: '', brief: '',
    },
    opponents: [
      { brain: 'mock', persona: 'setHunter', scriptId: BUILTINS[0].id },
      { brain: 'mock', persona: 'chest', scriptId: BUILTINS[0].id },
      { brain: 'mock', persona: 'cautious', scriptId: BUILTINS[0].id },
    ],
  };
}

export function loadSetup() {
  const d = defaultSetup();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s) return d;
    const out = {
      ...d,
      ...s,
      player: { ...d.player, ...(s.player || {}) },
      opponents: d.opponents.map((o, i) => ({ ...o, ...((s.opponents || [])[i] || {}) })),
    };
    // 「提示词 Agent」已下线（内核仍认 prompt，旧记录照常校验）：存档里的 prompt 改回手打
    if (!MODES.some((m) => m.id === out.player.mode)) out.player.mode = 'manual';
    if (!isMapSize(out.mapSize)) out.mapSize = DEFAULT_MAP_SIZE;
    delete out.vision; // 批次 6：视野规则不再可选（全公开）
    if (!isThinking(out.player.thinking)) out.player.thinking = DEFAULT_THINKING;
    return out;
  } catch {
    return d;
  }
}

export function saveSetup(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式：不存 */
  }
}

const MODES = [
  { id: 'manual', title: '自己手打', desc: '方向键 / WASD 每回合走一步，AI 等你；按住连走。' },
  { id: 'script', title: '编写 Agent 脚本', desc: '写脚本（或交给你的 agent 写）替你打完一整局；人和 agent 用同一套接口、同一份信息。' },
  { id: 'byok', title: '接入大模型', desc: '选一个大模型，按你写的思路代打；经游戏服务器中转，费用由你的服务商账户承担。' },
  { id: 'workbuddy', title: 'WorkBuddy 上场', desc: '把游戏作为 MCP 连接器接进 WorkBuddy：在 WorkBuddy 的任务会话里下棋、看复盘，用的是它自己的模型。' },
];

const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;

/** 评测结果 Markdown → HTML（只认标题 / 表格 / 列表 / 引用 / 粗体 / 行内代码；输入先转义）。 */
function mdToHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let table = null;
  let list = null;
  const flush = () => {
    if (table) out.push(`<table class="hist">${table.join('')}</table>`);
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    table = null;
    list = null;
  };
  for (const line of String(md).split('\n')) {
    if (/^\|/.test(line)) {
      if (/^\|[-| ]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (!table) {
        flush();
        table = [`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`];
      } else table.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    if (/^- /.test(line)) {
      if (!list) {
        flush();
        list = [];
      }
      list.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    flush();
    if (/^## /.test(line)) out.push(`<h4>${inline(line.slice(3))}</h4>`);
    else if (/^> /.test(line)) out.push(`<p class="warn">${inline(line.slice(2))}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

const VERIFY = {
  verified: '<b class="ok">✓ 校验通过</b>',
  mismatch: '<b class="bad">✗ 校验不一致</b>',
  unverifiable: '<b class="warn">? 无法校验</b>',
};
const CHANNEL = { manual: '手打', script: '脚本', 'prompt-mock': '提示词·模拟', 'prompt-proxy': '提示词·大模型' };
const channelOf = (tag) => CHANNEL[tag] || (tag === 'mcp:workbuddy' ? 'WorkBuddy 上场' : tag.startsWith('byok:') ? `我的大模型·${tag.slice(5).split('/').pop()}` : tag);
const STATUS = { escaped: '到达', failed: '出局' };
const TARGET_ZH = { gem: '宝石', chest: '宝箱', exit: '出口' };

function when(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 我的战绩（服务器上的对局，06 §6）。 */
function historyView(r) {
  if (!r) return '';
  if (!r.ok) {
    if (r.reason === 'static') return '<span class="k">当前是静态预览（没有游戏服务器），对局只存在本机。用 <code>npm run play</code> 启动带服务器的版本即可记录战绩。</span>';
    if (r.reason === 'offline') return '<span class="k">连不上游戏服务器；离线打完的对局会在联网后自动补传。</span>';
    return `<span class="k">读取失败：${esc(r.reason)}</span>`;
  }
  if (!r.items.length) return '<span class="k">还没有记录。打完一局会自动上传，服务器用同一个内核逐回合重放校验。</span>';
  const anyByok = r.items.some((m) => m.seats[0] && String(m.seats[0].tag).startsWith('byok:'));
  return `<table class="hist"><tr><th>时间</th><th>种子</th><th>回合</th><th>规格 · 视野</th><th>你</th><th>名次 / 分数</th><th>校验</th>${anyByok ? '<th>AI 对话</th>' : ''}<th>回放</th></tr>${r.items.map((m) => {
    const me = m.ranking.find((x) => x.seat === 0) || {};
    const tag = m.seats[0] ? m.seats[0].tag : '';
    // 接大模型模式的对局：从服务器对话日志下载这局的全部请求 / 回复 + 每次决策的结局（2026-11-05 批次 1）
    const talk = tag.startsWith('byok:') ? `<button class="btn mini" data-a="histtalk" data-id="${esc(m.matchId)}" title="下载这局你的 AI 每次请求 / 回复与结局（JSONL，不含 key）">下载对话</button>` : '';
    const vis = m.vision && VISION_PRESETS[m.vision] ? VISION_PRESETS[m.vision].label.replace('（现行）', '') : '—';
    return `<tr><td>${when(m.endedAt || m.receivedAt)}</td><td>${esc(m.seed)}</td><td>${m.turns}</td><td>${esc(m.mapSize || '—')} · ${esc(vis)}</td><td>${esc(channelOf(tag))}</td>
      <td>${me.place ?? '–'} 名 · ${me.score ?? '–'} 分 · ${esc(STATUS[me.status] || me.status || '')}</td>
      <td title="${esc(m.verifyNote || '')}">${VERIFY[m.verify] || esc(m.verify)}</td>${anyByok ? `<td>${talk}</td>` : ''}
      <td>${m.verify === 'verified' ? `<button class="btn mini" data-a="histreplay" data-id="${esc(m.matchId)}" title="在游戏画面里重新播一遍这局">回放</button>` : ''}</td></tr>`;
  }).join('')}</table>${r.total > r.items.length ? `<p class="k">共 ${r.total} 局，显示最近 ${r.items.length} 局</p>` : ''}<p class="k" data-k="histnote"></p>`;
}

/**
 * @param {HTMLElement} root
 * @param {{probe:()=>Promise<object>, trial:(code:string, seed:string)=>Promise<object>, onStart:(s:object)=>void, onResume:()=>void,
 *          history?:()=>Promise<{ok:boolean, items?:object[], total?:number, reason?:string}>,
 *          llm?:{call:(method:string, path:string, body?:object)=>Promise<{status:number, json:object|null, reason?:string}>}}} o
 *   llm.call：带游客令牌的服务器请求（sync.call），模式 B 的 key 管理 / 测试连接 / 用量
 *   scripts：{library, load(id) → {code,name,author,origin}, evaluate(opts) → {result, markdown}}（脚本库与整局试跑）
 */
export function createSetup(root, { probe, trial, onStart, onResume, onReplay = null, history, llm, scripts = null }) {
  let s = loadSetup();
  let proxy = { ok: false, error: '未检测' };
  let probed = false;
  let canResume = false;
  let error = '';
  let trialHtml = '';
  let evalHtml = '';
  let evalBusy = false;
  let libNote = '';
  let historyHtml = '<span class="k">读取中…</span>';
  // 模式 B 的界面状态（不进 localStorage；API key 输入框的值从不进这里）
  const byok = {
    loading: false, note: '', providers: null, canRemember: false, keys: [], usage: null, adding: false, memory: null,
    form: { provider: 'hunyuan', model: '', baseUrl: '', reasoning: false, remember: false },
    testHtml: '',
  };
  // 思路试跑 / A/B（批次 6 P3）
  const trialState = { games: 5, size: 'XS', ab: false, bText: '', bThinking: '', busy: false, stop: null, html: '' };
  // WorkBuddy 上场（批次 7）：令牌明文只在刚生成时留在内存里（fresh），不进 localStorage
  const wb = { info: null, note: '', fresh: null, size: 'XS', strategy: '' };
  const strategyLib = createStrategyLibrary();

  async function loadHistory() {
    if (!history) return;
    const r = await history();
    historyHtml = historyView(r);
    const el = root.querySelector('[data-k="history"]');
    if (el) el.innerHTML = historyHtml;
  }

  // 只有选了「本地代理」才自动探测：代理没起时浏览器会把被拒的连接记成 error 级控制台日志（L13 要求冷启动 0 error）
  const wantsProxy = () => s.opponents.some((o) => o.brain === 'proxy');
  function autoProbe() {
    if (probed || !wantsProxy()) return;
    probed = true;
    proxy = { ok: false, error: '检测中…' };
    refreshProxy();
    probe().then((r) => {
      proxy = r;
      if (!root.hidden) refreshProxy();
    });
  }

  function proxyLine() {
    if (proxy.ok && proxy.keyPresent) return `<b class="ok">● 已连接</b> · 模型 <code>${esc(proxy.model)}</code> · ${esc(proxy.base)}`;
    if (proxy.ok) return '<b class="warn">● 代理在线但未配置密钥</b> · 请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 后重启代理';
    if (proxy.error === '未检测') return '<b class="k">● 未检测</b> · 有座位选「本地代理」时自动检测，也可点「重新检测」';
    return `<b class="bad">● ${esc(proxy.error || '未启动')}</b> · 选了「本地代理」的座位在第一次调用失败后会熔断为启发式`;
  }

  function detail() {
    const p = s.player;
    if (p.mode === 'byok') return byokDetail();
    if (p.mode === 'workbuddy') return workbuddyDetail();
    if (p.mode === 'manual') {
      return `<div class="row"><label>方向映射</label><select data-f="mapping">${Object.entries(MAPPINGS).map(([k, m]) => opt(k, m.label, s.mapping)).join('')}</select></div>
        <p class="k">等距视角下箭头键没有「正上方」的网格方向，只能二选一地转 45°（SPEC O7，灰盒 A/B）。Q / E / C / Z 永远是屏幕斜向：左上 / 右上 / 右下 / 左下。空格原地等一回合。</p>`;
    }
    if (p.mode === 'script') return scriptDetail();
    return '';
  }

  // ───────── 编写 Agent 脚本（统一编程接口 v2，docs/07）─────────

  const libEntries = () => (scripts ? scripts.library.list() : []);
  /** 脚本选择项：内置 + 脚本库。 */
  const scriptOptions = (cur) => [
    ...BUILTINS.map((b) => opt(b.id, `内置 · ${b.name}`, cur)),
    ...libEntries().map((e) => opt(e.id, `${e.name}${e.author ? ` · ${e.author}` : ''} · ${ORIGINS[e.origin] || ''}`, cur)),
  ].join('');
  const scriptLabel = (id) => {
    const b = BUILTINS.find((x) => x.id === id);
    if (b) return { name: b.name, author: b.author, origin: 'builtin' };
    const e = scripts && scripts.library.get(id);
    return e ? { name: e.name, author: e.author, origin: e.origin } : null;
  };

  function libraryHtml() {
    const list = libEntries();
    const rows = list.map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.author || '—')}</td><td>${esc(ORIGINS[e.origin] || e.origin)}</td>
      <td>${new Date(e.updatedAt).toLocaleString()}</td>
      <td><button class="btn mini" data-a="libedit" data-id="${esc(e.id)}">载入编辑</button>
        <button class="btn mini" data-a="libexport" data-id="${esc(e.id)}">导出</button>
        <button class="btn mini" data-a="libdel" data-id="${esc(e.id)}">删除</button></td></tr>`).join('');
    return `${list.length ? `<table class="hist"><tr><th>名称</th><th>作者</th><th>来源</th><th>更新</th><th></th></tr>${rows}</table>` : '<p class="k">还没有保存的脚本。写好后点「保存到脚本库」，或「导入 .js」载入 agent 写的脚本。</p>'}
      <p class="k">内置：${BUILTINS.map((b) => esc(b.name)).join('、')}（可在对手座位直接选用，也可「载入编辑」改写）
        ${BUILTINS.map((b) => `<button class="btn mini" data-a="libedit" data-id="${b.id}">载入 ${esc(b.name)}</button>`).join(' ')}</p>`;
  }

  function scriptDetail() {
    const p = s.player;
    const cur = p.scriptId ? scriptLabel(p.scriptId) : null;
    return `<div class="row"><label>名称</label><input data-f="sname" value="${esc(p.scriptName)}" size="14" maxlength="40">
        <label>作者</label><input data-f="sauthor" value="${esc(p.scriptAuthor)}" size="10" maxlength="40">
        <label>来源</label><select data-f="sorigin">${opt('human', '人写', p.scriptOrigin)}${opt('agent', 'agent 写', p.scriptOrigin)}</select>
        <span class="k">${cur ? `编辑中：脚本库「${esc(cur.name)}」` : '未保存到脚本库'}</span></div>
      <div class="row"><label>示例</label>
        <select data-f="example"><option value="">— 套用示例 —</option>${opt('template', '模板：直奔出口（v2）', '')}${Object.entries(SCRIPT_EXAMPLES).map(([k, e]) => opt(k, e.label, '')).join('')}</select>
        <span class="sp"></span>
        <button class="btn" data-a="trial">试运行</button>
        <button class="btn" data-a="libsave">保存到脚本库</button>
        <button class="btn" data-a="libimport">导入 .js</button>
        <button class="btn" data-a="libexportcur">导出 .js</button>
        <input type="file" accept=".js,.mjs,text/javascript" data-f="libfile" hidden></div>
      <textarea class="code" data-f="code" spellcheck="false" rows="16">${esc(p.code)}</textarea>
      <div class="trial k" data-k="trial">${trialHtml}</div>
      <div class="k" data-k="libnote">${libNote}</div>
      <details class="evalbox"${evalHtml ? ' open' : ''}><summary>整局试跑（与命令行 <code>npm run eval</code> 同一个评测）</summary>
        <div class="row"><label>局数</label><select data-f="evalruns">${[10, 20, 50].map((n) => opt(String(n), `${n} 局`, String(s.evalRuns))).join('')}</select>
          <span class="k">规格 ${esc(MAP_SIZES[s.mapSize].label)} · 对手按下面「对手」的设置（本地代理按启发式算）· 种子 1–N · 预算只统计不打断</span>
          <span class="sp"></span><button class="btn brass" data-a="evalrun"${evalBusy ? ' disabled' : ''}>${evalBusy ? '试跑中…' : '开始试跑'}</button></div>
        <div class="evalout" data-k="eval">${evalHtml}</div>
      </details>
      <details class="evalbox"><summary>交给我的 agent 写：任务书</summary>
        <p class="k">把任务书粘贴给 WorkBuddy / Codex / Claude Code 等能写代码、跑命令的 agent。它会写脚本、用 <code>npm run eval</code> 反复评测，交给你一个带文件头的 .js，再在这里「导入 .js」。</p>
        <textarea class="persona" data-f="brief" rows="4" maxlength="2000" placeholder="写给 agent 的要求，例如：优先凑套；对手比我近的宝石别去抢；XS 和 S 都要能稳定到达。">${esc(p.brief)}</textarea>
        <div class="row"><span class="sp"></span><span class="k" data-k="briefnote"></span><button class="btn" data-a="copybrief">复制任务书</button></div>
      </details>
      <details class="evalbox"><summary>脚本库（${libEntries().length}）</summary><div data-k="library">${libraryHtml()}</div></details>
      <details class="api"><summary>接口 v2 速查（完整文档 docs/07-脚本编程接口.md）</summary><pre>${esc(`function init(ctx, api)   开局一次（≤ ${BUDGET.initMs} ms，可选）；模块变量整局保留
function decide(obs, api) 每回合一次 → 'N'|'E'|'S'|'W'|'STAY' 或 { move, intent:{type:'gem'|'chest'|'exit'|'cell', x, y, note} }
ctx   seat size mapSize grid(Uint8Array 1=地板) spawns[4] exits[4]（四个出口都公开） rules{maxTurns,stamina,visionRadius,gemScore,setBonus,chest…}
obs.self   {seat,x,y,stamina,staminaMax,score,gems[5],sets,exit{x,y},distToExit,lowStamina,inEndgame,blockedStreak}
obs.actors [{seat,score,stamina,gems,sets,status,visible:true, x,y,lastDir}]   全公开：所有在场对手的实时位置（意图不公开）
obs.gems   [{c,color,x,y,dist}]     obs.chest {present,x,y,dist | respawnAtTurn}     obs.turn / maxTurns / gemGeneration / gemRespawnsLeft
obs.events 上一回合公开事件：pickup{seat,color,x,y} chest{seat,x,y,kind,value} escaped failed{reason} gemRespawn chestRespawn；自己的 bump / blocked
api.field(x,y[,{avoid}]) 距离场   api.dist(x,y[,fromX,fromY])   api.shortestStep(x,y[,{avoid}])   api.isFloor(x,y)   （不限次数）
api.sim.step(belief, moves) 用真实规则推演一回合（开箱给概率分支、刷新只给标记；视野外对手需自己假设位置）
api.random() / randInt(lo,hi) 可复现随机数（Math.random 同一个流）   api.log(...)   api.budget   api.elapsed()
预算：每回合 ${BUDGET.baseMs} ms + 时间银行（≤ ${BUDGET.bankCapMs} ms）；超时的回合作废，沿最后的 intent 走；卡死重建并重新 init
v1 兼容：只有 decide 也行；obs.state + api.setState(≤16KB)、api.distance / shortestStep 照常`)}</pre></details>`;
  }

  /** 整局试跑的座位配置（对手按「对手」设置；本地代理没法离线重放，按启发式算）。 */
  async function evalSeats() {
    const p = s.player;
    const seats = [{ kind: 'script', code: p.code, name: p.scriptName || '我的脚本', author: p.scriptAuthor, origin: p.scriptOrigin }];
    for (const o of s.opponents) {
      if (o.brain === 'mock') seats.push({ kind: 'mock', persona: o.persona });
      else if (o.brain === 'script') seats.push({ kind: 'script', ...(await scripts.load(o.scriptId || BUILTINS[0].id)) });
      else seats.push({ kind: 'heuristic' });
    }
    return seats;
  }

  function paintK(k, html) {
    const el = root.querySelector(`[data-k="${k}"]`);
    if (el) el.innerHTML = html;
  }

  function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function briefText() {
    const cfg = makeConfig(matchOverrides('script', s.mapSize));
    const opponents = s.opponents.map((o) => {
      if (o.brain === 'script') {
        const l = scriptLabel(o.scriptId);
        return { brain: 'heuristic', label: `脚本「${l ? l.name : '?'}」（评测时可用 --seatN script:<路径>，或先用启发式）` };
      }
      return { brain: o.brain === 'proxy' ? 'heuristic' : o.brain, persona: o.persona, label: o.brain === 'mock' ? `模拟大模型（${PERSONAS[o.persona].label}）` : o.brain === 'proxy' ? '大模型（本地代理，评测时按启发式）' : '启发式' };
    });
    const rules = { stamina: cfg.rules.staminaByMode.script, maxTurns: cfg.rules.maxTurns, visionRadius: cfg.vision.entityRadius, gemScore: cfg.treasure.gemScore, setBonus: cfg.treasure.setBonus, gemRespawnMax: cfg.treasure.gemRespawnMax };
    return buildBrief({ mapSize: s.mapSize, size: cfg.maze.size, rules, opponents, requirement: s.player.brief, name: 'my-bot', visionRule: visionText(cfg) });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function loadIntoEditor(entry, id = '') {
    set(() => {
      s.player.code = entry.code;
      s.player.scriptName = entry.name || '我的脚本';
      s.player.scriptAuthor = entry.author || '';
      s.player.scriptOrigin = entry.origin === 'agent' ? 'agent' : 'human';
      s.player.scriptId = id;
    });
    trialHtml = '';
  }

  // ───────── 模式 B：接入我的大模型（05 §7）─────────

  const callErr = (r) => {
    if (r.status === 0) return r.reason === 'static' ? '静态预览没有游戏服务器' : '连不上游戏服务器';
    return (r.json && r.json.message) || `HTTP ${r.status}`;
  };

  function selectKey(k) {
    set(() => {
      s.player.keyId = k ? k.keyId : '';
      s.player.keyMeta = k ? { provider: k.provider, providerLabel: k.providerLabel, model: k.model, reasoning: Boolean(k.reasoning) } : null;
    });
    byok.memory = null; // 经验按模型分开存：换模型就要重新读
    paintK('mem', memoryHtml());
    paintK('thinknote', thinkNote());
  }

  async function loadByok() {
    if (!llm || byok.loading) return;
    byok.loading = true;
    const [pv, ks, us] = await Promise.all([
      byok.providers ? null : llm.call('GET', '/api/v1/providers'),
      llm.call('GET', '/api/v1/keys'),
      llm.call('GET', '/api/v1/usage'),
    ]);
    byok.loading = false;
    if (ks.status === 0) {
      byok.note = ks.reason === 'static'
        ? '当前是静态预览（没有游戏服务器）。接入大模型需要游戏服务器保管 key 并中转：请用 <code>npm run play</code> 启动。'
        : '连不上游戏服务器，暂时不能接入大模型。';
    } else byok.note = ks.status === 200 ? '' : `读取失败：${esc(callErr(ks))}`;
    if (pv && pv.status === 200) {
      byok.providers = pv.json.items;
      byok.canRemember = pv.json.canRemember;
    }
    if (ks.status === 200) {
      byok.keys = ks.json.items;
      byok.canRemember = ks.json.canRemember;
      if (s.player.keyId && !byok.keys.some((k) => k.keyId === s.player.keyId)) selectKey(null);
      if (!s.player.keyId && byok.keys.length) selectKey(byok.keys[0]);
      if (!byok.keys.length) byok.adding = true;
    }
    if (us.status === 200) byok.usage = us.json;
    paintByok();
  }

  function usageLine() {
    const u = byok.usage;
    if (!u) return '';
    const m = u.month;
    return `本月经服务器调用 ${m.calls} 次${m.failed ? `（失败 ${m.failed}）` : ''} · 输入 ${tokensText(m.tokensIn)} / 输出 ${tokensText(m.tokensOut)} token · 费用由你的服务商账户承担`;
  }

  function testView(r) {
    if (r.status === 200 && r.json.ok) {
      const p = r.json.plan;
      const th = r.json.thinking ? ` · 思考 ${THINK_ZH[r.json.thinking]}${r.json.fallback ? `（${esc(r.json.fallback)}）` : r.json.thinkingRequested && r.json.thinkingRequested !== r.json.thinking ? `（不支持「${THINK_ZH[r.json.thinkingRequested]}」，按「${THINK_ZH[r.json.thinking]}」）` : ''}${r.json.usage.reasoning ? `，思考 ${r.json.usage.reasoning} token` : ''}` : '';
      return `<b class="ok">✓ 连接正常</b> · ${(r.json.ms / 1000).toFixed(1)} 秒 · 模型 <code>${esc(r.json.model || '')}</code> · token ${r.json.usage.in} / ${r.json.usage.out}${th}<br>
        示范决策（开局局面）：去${TARGET_ZH[p.targetType]} (${p.target.x}, ${p.target.y}) · ${FOLLOW_ZH[p.follow] || '—'} · 「${esc(p.reason)}」${p.deviation ? `<br>说明：${esc(p.deviation)}` : ''}`;
    }
    if (r.status === 200) {
      return `<b class="warn">● 连得上，但回复不合格</b>：${esc(r.json.error || '')} · 原文 <code>${esc(r.json.text || '')}</code><br>
        对局里不合格的回复会带着错误重试一次，仍不行就由启发式顶上；也可以换一个模型试试。`;
    }
    const code = r.json && r.json.error;
    const hint = code === 'upstream_auth' ? '（请检查 key 是否正确、账户是否欠费）'
      : code === 'upstream_bad' ? '（请检查模型名）'
        : code === 'upstream_timeout' ? '（服务商响应太慢：可以把思考档位调低再试）'
          : code === 'key_not_found' ? '（「仅本次会话」的 key 已过期，或服务器重启过：请重新添加）' : '';
    return `<b class="bad">✗ 连接失败</b> · ${esc(callErr(r))}${hint}`;
  }

  function paintTest() {
    const el = root.querySelector('[data-k="ktest"]');
    if (el) el.innerHTML = byok.testHtml;
  }

  function keysHtml() {
    if (byok.note) return `<p class="k">${byok.note}</p>`;
    if (!byok.providers && byok.loading) return '<p class="k">读取中…</p>';
    const f = byok.form;
    const pv = (byok.providers || []).find((x) => x.id === f.provider) || { baseUrl: '', model: '' };
    const list = byok.keys.length
      ? byok.keys.map((k) => `<div class="keyrow${k.keyId === s.player.keyId ? ' on' : ''}">
          <label class="radio"><input type="radio" name="keysel" value="${esc(k.keyId)}"${k.keyId === s.player.keyId ? ' checked' : ''}>
            <b>${esc(k.providerLabel)}</b> · <code>${esc(k.model)}</code>${k.reasoning ? ' · 推理模型' : ''} · <span class="k">${esc(k.hint)} · ${k.remember ? '已记住（加密保存）' : '仅本次会话'}</span></label>
          <span class="sp"></span><button class="btn mini" data-a="ktest" data-key="${esc(k.keyId)}">测试连接</button>
          <button class="btn mini" data-a="kdel" data-key="${esc(k.keyId)}">删除</button></div>`).join('')
      : '<p class="k">还没有模型：在下面填好服务商、模型名和 API key。</p>';
    return `<div class="keys">${list}</div>
      <details class="addkey"${byok.adding ? ' open' : ''}><summary>添加模型</summary>
        <div class="row"><label>服务商</label><select data-f="kprovider">${(byok.providers || []).map((x) => opt(x.id, x.label, f.provider)).join('')}</select>
          ${f.provider === 'custom'
    ? `<input data-f="kbase" value="${esc(f.baseUrl)}" placeholder="https://api.example.com/v1" size="34">`
    : `<span class="k">${esc(pv.baseUrl)}</span>`}</div>
        <div class="row"><label>模型名</label><input data-f="kmodel" value="${esc(f.model)}" placeholder="${esc(pv.model || '必填')}" size="24">
          ${f.provider === 'custom' ? `<label class="radio"><input type="checkbox" data-f="kreasoning"${f.reasoning ? ' checked' : ''}> 这是推理模型（自定义模型的思考没法由游戏控制：勾上则按「高」档放宽预算与超时）</label>` : ''}</div>
        <div class="row"><label>API key</label><input type="password" data-f="kkey" autocomplete="off" spellcheck="false" size="34" placeholder="腾讯云 TokenHub 的 sk-…">
          <label class="radio"><input type="checkbox" data-f="kremember"${f.remember && byok.canRemember ? ' checked' : ''}${byok.canRemember ? '' : ' disabled'}> 记住（服务器加密保存）</label>
          <button class="btn" data-a="kadd">保存并测试</button></div>
        <p class="k">${pv.note ? `${esc(pv.note)} · ` : ''}key 交给游戏服务器保管，页面不保存、不回显。默认「仅本次会话」：只在服务器内存里，24 小时后丢弃；勾「记住」则用 AES-256-GCM 加密后存进数据库${byok.canRemember ? '' : '（服务器未配置主密钥，暂不可用）'}。接口只返回服务商、模型名和尾号，随时可删。</p>
        <p class="k keyhint"><b>填哪种 key：</b>预设的四个模型填<b>腾讯云 TokenHub 的 API Key</b>（在腾讯云控制台「TokenHub → API Key 管理」创建，<code>sk-</code> 开头；也就是你在 WorkBuddy「自定义模型」里填的那把），费用从你的腾讯云账户扣。<b>CodeBuddy / WorkBuddy 登录账号自带的积分不能用</b>：官方没有对第三方开放这部分额度，用非官方代理绕过有封号风险，游戏服务器也连不到你电脑上的代理。</p>
      </details>
      <div class="trial k" data-k="ktest">${byok.testHtml}</div>
      <p class="k" data-k="usage">${usageLine()}</p>`;
  }

  /** 只重绘 key 区域（不冲掉思路输入框的焦点）。 */
  function paintByok() {
    const el = root.querySelector('[data-k="byok"]');
    if (el) el.innerHTML = keysHtml();
  }

  function byokDetail() {
    const p = s.player;
    return `<div class="byok" data-k="byok">${keysHtml()}</div>
      <h4>你的思路</h4>
      <div class="row chips"><label>预设</label>${Object.entries(PERSONAS).map(([k, v]) => `<button class="btn chip" data-persona="${k}">${esc(v.label)}</button>`).join('')}</div>
      <textarea class="persona" data-f="persona" rows="5" maxlength="2000" placeholder="例如：先凑红黄绿三色，蓝紫看情况；宝箱只在 10 步内顺路开；对手比我近的宝石不去抢；体力剩一半就往家靠。">${esc(p.persona)}</textarea>
      <div class="k"><span data-k="count">${Array.from(p.persona).length}</span> / 2000 字 · 只能影响取舍，改不了规则和 AI 看到的局面。思路随对局存进服务器，仅你本人可见；对局记录里只有它的哈希。经服务器中转的对话（含思路，不含 key）会留存 30 天，用于改进游戏。</div>
      <h4>你的 AI 该多听你的</h4>
      <div class="modes">${Object.entries(AUTONOMY).map(([k, a]) => `<button class="choice${p.autonomy === k ? ' on' : ''}" data-autonomy="${k}"><b>${a.label}</b><span>${a.short}</span></button>`).join('')}</div>
      <div class="row"><label class="radio"><input type="checkbox" data-f="risk"${p.safetyGate ? '' : ' checked'}> 允许冒险（关闭自保闸门）</label>
        <span class="k">默认关：目标会让你回不了出口时，引擎自动改为回家，记为「引擎安全覆盖」，不算 AI 偏离。</span></div>
      <div class="row"><label>每局调用上限</label><input type="number" data-f="callcap" min="0" max="400" step="10" value="${p.callCap || ''}" placeholder="不限" style="width:80px">
        <span class="k">到上限后由启发式接着打。一局一般 20–60 次决策；每次输入约 2–4k token（含本局会话与经验），输出几十到几百 token，开思考另算思考 token。</span></div>
      <h4>思考档位</h4>
      <div class="modes sizes think3">${THINKING.map((lv) => `<button class="choice${p.thinking === lv ? ' on' : ''}" data-thinking="${lv}"><b>${THINK_ZH[lv]}</b><span>${THINK_DESC[lv]}</span></button>`).join('')}</div>
      <p class="k" data-k="thinknote">${thinkNote()}</p>
      <h4>本局会话与跨局经验</h4>
      <p class="k">每次决策，游戏都会把「本局到目前为止的决策和结局」与它上次留给自己的备忘一起带给模型，它能延续自己的计划、记住谁抢过它。下面是跨局的部分：</p>
      <div class="row"><label class="radio"><input type="checkbox" data-f="usemem"${p.useMemory !== false ? ' checked' : ''}> 开局带上它以往总结的经验</label>
        <label class="radio"><input type="checkbox" data-f="automem"${p.autoMemory !== false ? ' checked' : ''}${p.useMemory !== false ? '' : ' disabled'}> 每局结束后让它自己复盘、更新经验（多 1–2 次调用）</label></div>
      <details class="evalbox" data-k="membox"><summary>查看 / 编辑经验（按模型分开存，仅你本人可见）</summary><div data-k="mem">${memoryHtml()}</div></details>
      <details class="evalbox" data-k="prevbox"><summary>预览提示词（开局局面下它实际收到的内容）</summary><div data-k="preview"><button class="btn mini" data-a="preview">生成预览</button></div></details>
      <details class="evalbox"${trialState.html ? ' open' : ''}><summary>思路试跑 / A/B 对比（用你的模型在固定种子上跑，陪练是 3 个「预判对手」脚本）</summary>
        <div class="row"><label>局数</label><select data-f="trialn">${[3, 5, 10, 20].map((n) => opt(String(n), `${n} 局`, String(trialState.games))).join('')}</select>
          <label>规格</label><select data-f="trialsize">${MAP_SIZE_IDS.map((id) => opt(id, MAP_SIZES[id].label, trialState.size)).join('')}</select>
          <label class="radio"><input type="checkbox" data-f="trialab"${trialState.ab ? ' checked' : ''}> A/B 对比</label></div>
        <div data-k="trialb"${trialState.ab ? '' : ' hidden'}>
          <div class="row"><label>B 的思路</label><select data-f="trialbsel"><option value="">— 从思路库选 —</option>${strategyLib.list().map((e) => opt(e.id, e.name, '')).join('')}</select>
            <label>B 的思考</label><select data-f="trialbthink">${THINKING.map((lv) => opt(lv, THINK_ZH[lv], trialState.bThinking || p.thinking)).join('')}</select></div>
          <textarea class="persona" data-f="trialbtext" rows="3" maxlength="2000" placeholder="B 变体的思路（留空 = 和 A 一样，只比较思考档位）">${esc(trialState.bText)}</textarea>
        </div>
        <p class="k" data-k="trialest">${trialEstimate()}</p>
        <div class="row"><span class="sp"></span><button class="btn brass" data-a="trialrun"${trialState.busy ? ' disabled' : ''}>${trialState.busy ? '试跑中…' : '确认费用并开始'}</button>
          ${trialState.busy ? '<button class="btn" data-a="trialstop">停止</button>' : ''}</div>
        <div class="evalout" data-k="trial2">${trialState.html}</div>
      </details>
      <details class="evalbox"><summary>思路库（${strategyLib.list().length}）</summary><div data-k="stratlib">${strategyLibHtml()}</div></details>
      <details class="evalbox"><summary>交给我的 agent 调思路：任务书</summary>
        <p class="k">把任务书粘贴给 WorkBuddy / Codex / Claude Code 等能跑命令的 agent。它会改思路、用 <code>npm run eval:llm</code> 在固定种子上跑你的模型、读复盘、做 A/B，交回一版更好的思路。key 只放它那边的环境变量。</p>
        <textarea class="persona" data-f="sbrief" rows="3" maxlength="2000" placeholder="写给 agent 的要求，例如：XS 和 S 上冠军率都要提高；不要让 AI 太保守。">${esc(p.strategyBrief || '')}</textarea>
        <div class="row"><span class="sp"></span><span class="k" data-k="sbriefnote"></span><button class="btn" data-a="copysbrief">复制任务书</button></div>
      </details>`;
  }

  // ───────── WorkBuddy 上场（批次 7）─────────

  function workbuddyDetail() {
    const w = wb;
    if (w.note) return `<p class="k">${w.note}</p>`;
    if (!w.info) return '<p class="k">读取中…</p>';
    const t = w.info.token;
    const cfgText = w.fresh ? JSON.stringify(w.fresh.config, null, 2) : '';
    const prompt = wbPrompt();
    const active = w.info.active || [];
    return `<h4>第 1 步 · 把游戏接进 WorkBuddy（一次性）</h4>
      <p class="k">生成一个 MCP 令牌，把下面的配置粘贴到 WorkBuddy 桌面端「连接器（插件）→ 自定义连接器 / MCP 服务器 → 配置 MCP」里（保留已有的其他服务），保存后在连接器页启用 / 信任「maze-treasure」。地址：<code>${esc(w.info.url)}</code>${/127\.0\.0\.1|localhost/.test(w.info.url) ? '（本机地址：WorkBuddy 要和游戏服务器在同一台电脑上）' : ''}</p>
      <div class="row"><span class="k">${t ? `当前令牌 <code>${esc(t.hint)}</code> · ${t.lastUsedAt ? `最近使用 ${new Date(t.lastUsedAt).toLocaleString()}` : '还没被使用过'}` : '还没有令牌'}</span><span class="sp"></span>
        <button class="btn" data-a="wbtoken">${t ? '重新生成（旧的作废）' : '生成令牌'}</button>${t ? '<button class="btn mini" data-a="wbrevoke">作废</button>' : ''}</div>
      ${w.fresh ? `<p class="warn">令牌只显示这一次，复制后请勿外传（它能以你的身份在游戏里开局）。</p>
        <pre class="prompt" data-k="wbcfg">${esc(cfgText)}</pre>
        <div class="row"><span class="sp"></span><span class="k" data-k="wbcfgnote"></span><button class="btn" data-a="wbcopycfg">复制配置</button></div>` : ''}
      <h4>第 2 步 · 在 WorkBuddy 的任务会话里开一局</h4>
      <div class="row"><label>地图</label><select data-f="wbsize">${MAP_SIZE_IDS.map((id) => opt(id, MAP_SIZES[id].label, w.size)).join('')}</select>
        <span class="k">建议先用 XS（十来个决策点就打完）；对手是 3 个「预判对手」脚本。</span></div>
      <textarea class="persona" data-f="wbstrategy" rows="3" maxlength="2000" placeholder="你的思路（可选），会一起交给 WorkBuddy">${esc(w.strategy)}</textarea>
      <pre class="prompt" data-k="wbprompt">${esc(prompt)}</pre>
      <div class="row"><span class="sp"></span><span class="k" data-k="wbpromptnote"></span><button class="btn brass" data-a="wbcopyprompt">复制提示词</button></div>
      <p class="k">粘贴到 WorkBuddy 新建的任务会话里发送即可。WorkBuddy 每到一个决策点会自己推理（可以先查距离），再提交决定；游戏停在决策点等它，不限时间。打完的对局由服务器校验后记进下面的「我的战绩」，标为「WorkBuddy 上场」；也可以直接让 WorkBuddy 调用 maze_replay 给你复盘。WorkBuddy 自己的记忆由它自己管理。</p>
      ${active.length ? `<p class="k">进行中：${active.map((a) => `${esc(a.gameId.slice(0, 8))}…（${esc(a.size)}，第 ${a.turn} 回合）`).join('、')} · 在 WorkBuddy 里说「继续」即可接着打（服务器重启会丢失未完成的对局）</p>` : ''}
      <p class="k">这种玩法不经过「开始对局」按钮：对局在游戏服务器上进行，用的是 WorkBuddy 自己的模型与积分。</p>`;
  }

  function wbPrompt() {
    return [
      `用 maze-treasure 连接器帮我打一局「迷宫寻宝」，地图 ${wb.size}。`,
      '先调用 maze_new_game，仔细读规则和决策契约；然后每到一个决策点，认真推理（看博弈事实表里的 lead、对手的 heading 和 spare、本局到目前为止的结局）后调用 maze_decide。',
      '一直打到对局结束，中途不要停下来问我。结束后向我汇报名次和分数，再用 maze_replay 复盘：哪些决策好、哪些亏了、下一局怎么改，并把经验记在你自己的记忆里。',
      wb.strategy.trim() ? `我的思路：${wb.strategy.trim()}` : '',
    ].filter(Boolean).join('\n');
  }

  async function loadWorkbuddy() {
    if (!llm) return;
    const r = await llm.call('GET', '/api/v1/mcp');
    if (r.status === 0) wb.note = r.reason === 'static' ? '当前是静态预览（没有游戏服务器）。WorkBuddy 上场需要游戏服务器：请用 <code>npm run play</code> 启动。' : '连不上游戏服务器。';
    else if (r.status !== 200) wb.note = `读取失败：${esc(callErr(r))}`;
    else {
      wb.note = '';
      wb.info = r.json;
    }
    paintK('detail', detail());
  }

  // ───────── 思路库 + 思路试跑（批次 6 P3）─────────

  function trialEstimate() {
    const e = estimateTrial({ size: trialState.size, games: trialState.games, thinking: trialState.ab && trialState.bThinking === 'high' ? 'high' : s.player.thinking, variants: trialState.ab ? 2 : 1 });
    return `估算：约 ${e.calls} 次调用 · 输入约 ${Math.round(e.tokensIn / 1000)}k / 输出约 ${Math.round(e.tokensOut / 1000)}k token · 约 ${e.minutes} 分钟 · 费用记在你的服务商账户。A = 上面的思路 + 当前思考档位${s.player.useMemory !== false && byok.memory && byok.memory.text ? ' + 经验' : ''}。`;
  }

  function strategyLibHtml() {
    const list = strategyLib.list();
    const rows = list.map((e) => `<tr><td>${esc(e.name)}</td><td class="k">${esc(e.text.slice(0, 40))}${e.text.length > 40 ? '…' : ''}</td>
      <td class="k">${e.lastTrial ? `${esc(e.lastTrial.size)} ${e.lastTrial.games} 局：均分 ${e.lastTrial.avgScore.toFixed(2)} · 到达 ${(e.lastTrial.escapeRate * 100).toFixed(0)}% · 白跑 ${e.lastTrial.avgWasted.toFixed(1)}` : '还没试跑'}</td>
      <td><button class="btn mini" data-a="stratuse" data-id="${esc(e.id)}">用这版</button><button class="btn mini" data-a="stratdel" data-id="${esc(e.id)}">删除</button></td></tr>`).join('');
    return `${list.length ? `<table class="hist"><tr><th>名称</th><th>开头</th><th>最近一次试跑</th><th></th></tr>${rows}</table>` : '<p class="k">还没有保存的思路。</p>'}
      <div class="row"><input data-f="stratname" placeholder="给当前思路起个名字" size="18" maxlength="30"><button class="btn mini" data-a="stratsave">把上面的思路存进思路库</button><span class="k" data-k="stratnote"></span></div>`;
  }

  async function runTrial() {
    const p = s.player;
    if (!llm || !llm.trial || !p.keyId || !p.keyMeta) {
      paintK('trial2', '<b class="bad">先在上面选一个模型</b>');
      return;
    }
    const e = estimateTrial({ size: trialState.size, games: trialState.games, thinking: p.thinking, variants: trialState.ab ? 2 : 1 });
    if (!confirm(`将用你的 ${p.keyMeta.model} 跑 ${trialState.games} 局${trialState.ab ? ' × 2 个变体' : ''}，约 ${e.calls} 次调用、${Math.round((e.tokensIn + e.tokensOut) / 1000)}k token，费用记在你的服务商账户。继续？`)) return;
    trialState.busy = true;
    trialState.stop = { aborted: false };
    render();
    const memory = p.useMemory !== false && byok.memory && byok.memory.text ? byok.memory.text : '';
    const base = { strategy: p.persona, autonomy: p.autonomy, safetyGate: p.safetyGate !== false, memory };
    const seeds = `1-${trialState.games}`;
    const prog = (tag) => (d, t, g) => paintK('trial2', `<span class="k">${tag} 试跑中 ${d} / ${t} 局 · 刚完成种子 ${g.seed}：${g.status === 'escaped' ? `到达 ${g.rawScore} 分` : '出局'}，第 ${g.place} 名</span>`);
    try {
      const a = await llm.trial({ size: trialState.size, seeds, signal: trialState.stop, onProgress: prog('A'), variant: { ...base, name: `A · ${THINK_ZH[p.thinking]}思考`, thinking: p.thinking } });
      let b = null;
      if (trialState.ab) {
        const bText = trialState.bText.trim() || p.persona;
        b = await llm.trial({ size: trialState.size, seeds, signal: trialState.stop, onProgress: prog('B'), variant: { ...base, strategy: bText, name: `B · ${THINK_ZH[trialState.bThinking || p.thinking]}思考${trialState.bText.trim() ? ' · 另一版思路' : ''}`, thinking: trialState.bThinking || p.thinking } });
      }
      trialState.html = mdToHtml(trialMarkdown(a, b));
      strategyLib.noteTrial(p.persona, { size: trialState.size, ...a.summary });
      if (b && trialState.bText.trim()) strategyLib.noteTrial(trialState.bText.trim(), { size: trialState.size, ...b.summary });
    } catch (err) {
      trialState.html = `<b class="bad">试跑中止</b> · ${esc(err.message)}`;
    }
    trialState.busy = false;
    render();
  }

  // ───────── 思考档位 / 跨局经验 / 提示词预览（批次 6 harness）─────────

  const providerOf = () => (byok.providers || []).find((x) => s.player.keyMeta && x.id === s.player.keyMeta.provider) || null;
  function thinkNote() {
    const pv = providerOf();
    const lv = s.player.thinking;
    if (!pv) return '游戏会等模型想完再走（结果与快慢无关），开思考只让对局变慢、费用变高。';
    const ok = (pv.thinking || ['off']).includes(lv);
    return `${esc(pv.label)}：${esc(pv.note || '')}${ok ? '' : ` · <b class="warn">这个模型不支持「${THINK_ZH[lv]}」，对局里会按「关」调用</b>`}`;
  }

  function memoryHtml() {
    const m = byok.memory;
    if (!s.player.keyMeta) return '<p class="k">先在上面选一个模型。</p>';
    if (!m) return '<button class="btn mini" data-a="memload">读取经验</button>';
    if (m.error) return `<p class="bad">${esc(m.error)}</p><button class="btn mini" data-a="memload">重试</button>`;
    return `<p class="k">模型 <code>${esc(m.scope)}</code> · ${m.text ? `累计 ${m.games} 局 · ${Array.from(m.text).length} / ${MEMORY_MAX} 字` : '还没有经验：打完一局会自动写'}</p>
      <textarea class="persona" data-f="memtext" rows="8" maxlength="${MEMORY_MAX}">${esc(m.text)}</textarea>
      <div class="row"><span class="sp"></span><span class="k" data-k="memnote"></span>
        <button class="btn mini" data-a="memsave">保存修改</button><button class="btn mini" data-a="memclear">清空</button></div>`;
  }

  async function loadMem() {
    if (!llm || !s.player.keyMeta) return;
    const scope = memoryScope(s.player.keyMeta);
    const r = await llm.call('GET', `/api/v1/memory?scope=${encodeURIComponent(scope)}`);
    byok.memory = r.status === 200
      ? { scope, text: r.json.item ? r.json.item.text : '', games: r.json.item ? r.json.item.games : 0 }
      : { scope, error: `读取失败：${callErr(r)}` };
    paintK('mem', memoryHtml());
  }

  function promptPreview() {
    const p = s.player;
    const cfg = makeConfig(matchOverrides('byok', s.mapSize));
    const m = createMatch(1, cfg);
    const obs = observe(m.map, m.state, 0, cfg, { patch: true, events: [] });
    const memText = p.useMemory !== false && byok.memory && byok.memory.text ? byok.memory.text : '';
    const msgs = buildMessages(buildPayload(m.map, obs, cfg), p.persona, cfg, {
      autonomy: p.autonomy, safetyGate: p.safetyGate !== false, memory: memText,
      context: { why: 'start', plan: null, budget: cfg.ai.normalSoftCapPerAgent },
    });
    const chars = msgs.reduce((a, x) => a + x.content.length, 0);
    return `<p class="k">种子 1 · 规格 ${esc(s.mapSize)} 的开局；约 ${chars} 字符。对局中每次决策的 user 消息前面还会加上「本局到目前为止」的会话。${memText ? '已含经验。' : (p.useMemory !== false ? '经验还没读取或为空（点上面的「读取经验」）。' : '')}</p>
      ${msgs.map((x) => `<h4>${x.role}</h4><pre class="prompt">${esc(x.content)}</pre>`).join('')}
      <button class="btn mini" data-a="preview">重新生成</button>`;
  }

  async function addKey() {
    const inp = root.querySelector('[data-f="kkey"]');
    const apiKey = inp ? inp.value.trim() : '';
    if (inp) inp.value = '';
    if (!apiKey) {
      byok.testHtml = '<b class="bad">请填写 API key</b>';
      paintTest();
      return;
    }
    const f = byok.form;
    const pv = (byok.providers || []).find((x) => x.id === f.provider);
    const body = { provider: f.provider, model: f.model.trim() || (pv ? pv.model : ''), apiKey, reasoning: f.reasoning, remember: f.remember && byok.canRemember };
    if (f.provider === 'custom') body.baseUrl = f.baseUrl.trim();
    byok.testHtml = '保存中…';
    paintTest();
    const r = await llm.call('POST', '/api/v1/keys', body);
    body.apiKey = '';
    if (r.status !== 201) {
      byok.testHtml = `<b class="bad">保存失败</b> · ${esc(callErr(r))}`;
      paintTest();
      return;
    }
    byok.keys.unshift(r.json);
    byok.adding = false;
    f.model = '';
    selectKey(r.json);
    paintByok();
    await testKey(r.json.keyId);
  }

  async function testKey(id) {
    byok.testHtml = '测试中…（用开局局面跑一次示范决策）';
    paintTest();
    const r = await llm.call('POST', `/api/v1/keys/${encodeURIComponent(id)}/test`, { autonomy: s.player.autonomy, strategy: s.player.persona, thinking: s.player.thinking });
    byok.testHtml = testView(r);
    const us = await llm.call('GET', '/api/v1/usage');
    if (us.status === 200) byok.usage = us.json;
    paintTest();
    const u = root.querySelector('[data-k="usage"]');
    if (u) u.innerHTML = usageLine();
  }

  async function deleteKey(id) {
    const r = await llm.call('DELETE', `/api/v1/keys/${encodeURIComponent(id)}`);
    if (r.status !== 204 && r.status !== 404) {
      byok.testHtml = `<b class="bad">删除失败</b> · ${esc(callErr(r))}`;
      paintTest();
      return;
    }
    byok.keys = byok.keys.filter((k) => k.keyId !== id);
    if (s.player.keyId === id) selectKey(byok.keys[0] || null);
    if (!byok.keys.length) byok.adding = true;
    byok.testHtml = '<span class="k">已删除</span>';
    paintByok();
  }

  function render() {
    const p = s.player;
    root.innerHTML = `<div class="setup-wrap setup">${frame(`
      <header class="title"><span class="orn"></span><h1>迷宫寻宝 · 开局设置</h1><span class="orn r"></span></header>
      <section><h3>你怎么玩</h3>
        <div class="modes">${MODES.map((m) => `<button class="choice${p.mode === m.id ? ' on' : ''}" data-mode="${m.id}">
          <b>${m.title}</b><span>${m.desc}</span></button>`).join('')}</div>
        <div class="detail" data-k="detail">${detail()}</div>
      </section>
      <section><h3>地图大小</h3>
        <div class="modes sizes">${MAP_SIZE_IDS.map((id) => {
          const z = MAP_SIZES[id];
          return `<button class="choice${s.mapSize === id ? ' on' : ''}" data-size="${id}"><b>${z.label}</b><span>体力 ${z.stamina} · 上限 ${z.maxTurns} 回合</span></button>`;
        }).join('')}</div>
      </section>
      <section><h3>对手</h3>
        <div class="opps">${s.opponents.map((o, k) => {
          const seat = k + 1;
          const brainSel = `<select data-opp="${k}" data-f="brain">${Object.entries(BRAINS).map(([v, l]) => opt(v, l, o.brain)).join('')}</select>`;
          if (o.brain === 'script') {
            const l = scriptLabel(o.scriptId) || scriptLabel(BUILTINS[0].id);
            return `<div class="opp" style="--c:${ACTOR_COLORS[seat]}"><span class="nm">${SEAT_NAMES[seat]}</span>${brainSel}
              <select data-opp="${k}" data-f="oscript">${scriptOptions(o.scriptId || BUILTINS[0].id)}</select>
              <span class="k">${esc(l.name)}${l.author ? ` · ${esc(l.author)}` : ''} · ${esc(ORIGINS[l.origin] || '')} · 和你同一套接口与规则</span></div>`;
          }
          return `<div class="opp" style="--c:${ACTOR_COLORS[seat]}"><span class="nm">${SEAT_NAMES[seat]}</span>${brainSel}
            <select data-opp="${k}" data-f="opersona"${o.brain === 'heuristic' ? ' disabled' : ''}>${Object.entries(PERSONAS).map(([v, l]) => opt(v, l.label, o.persona)).join('')}</select>
            <span class="k">${o.brain === 'heuristic' ? '按距离贪心、自带让行解锁' : esc(PERSONAS[o.persona].text)}</span></div>`;
        }).join('')}</div>
      </section>
      ${wantsProxy() ? `<section><h3>对手用的大模型代理 <button class="btn mini" data-a="probe">重新检测</button></h3>
        <p class="proxy">${proxyLine()}</p>
        <p class="k">在项目目录运行 <code>npm run proxy</code>（先设 <code>LLM_BASE_URL</code> <code>LLM_API_KEY</code> <code>LLM_MODEL</code>，任何 OpenAI 兼容端点均可）。密钥只在代理进程里，页面拿不到。</p>
      </section>` : ''}
      <section><h3>我的战绩 <button class="btn mini" data-a="history">刷新</button></h3>
        <div class="history" data-k="history">${historyHtml}</div>
      </section>
      <section class="row last"><label>种子</label><input data-f="seed" value="${esc(s.seed)}" placeholder="留空 = 随机" size="14">
        <label>默认倍速</label><select data-f="speed">${[1, 2, 4].map((v) => opt(String(v), `${v}×`, String(s.speed))).join('')}</select>
        <span class="sp"></span>${canResume ? '<button class="btn" data-a="resume">继续当前对局</button>' : ''}
        <button class="btn brass big" data-a="start">开始对局</button></section>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}`, 'lg')}</div>`;
  }

  /** 只刷新代理状态行（探测异步返回时不重绘整页，免得冲掉输入焦点 / 试运行结果）。 */
  function refreshProxy() {
    const el = root.querySelector('.proxy');
    if (el) el.innerHTML = proxyLine();
  }

  const set = (fn) => {
    fn();
    saveSetup(s);
  };

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.size && isMapSize(b.dataset.size)) {
      set(() => { s.mapSize = b.dataset.size; });
      root.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', x === b));
      return;
    }
    if (b.dataset.mode) {
      set(() => { s.player.mode = b.dataset.mode; });
      render();
      autoProbe();
      if (s.player.mode === 'byok') loadByok();
      if (s.player.mode === 'workbuddy') loadWorkbuddy();
    } else if (b.dataset.a === 'wbtoken') {
      if (wb.info && wb.info.token && !confirm('重新生成后，WorkBuddy 里旧的配置立即失效，需要换成新令牌。继续？')) return;
      const r = await llm.call('POST', '/api/v1/mcp/token', {});
      if (r.status === 201) {
        wb.fresh = r.json;
        await loadWorkbuddy();
      } else paintK('detail', `<p class="bad">生成失败：${esc(callErr(r))}</p>${workbuddyDetail()}`);
    } else if (b.dataset.a === 'wbrevoke') {
      if (!confirm('作废后 WorkBuddy 连不上游戏，需要重新生成令牌。继续？')) return;
      await llm.call('DELETE', '/api/v1/mcp/token');
      wb.fresh = null;
      await loadWorkbuddy();
    } else if (b.dataset.a === 'wbcopycfg' && wb.fresh) {
      const ok = await copyText(JSON.stringify(wb.fresh.config, null, 2));
      paintK('wbcfgnote', ok ? '<b class="ok">已复制</b>' : '<b class="bad">复制失败</b>');
    } else if (b.dataset.a === 'wbcopyprompt') {
      const ok = await copyText(wbPrompt());
      paintK('wbpromptnote', ok ? '<b class="ok">已复制</b>，粘贴到 WorkBuddy 的任务会话' : '<b class="bad">复制失败</b>');
    } else if (b.dataset.thinking && isThinking(b.dataset.thinking)) {
      set(() => { s.player.thinking = b.dataset.thinking; });
      root.querySelectorAll('[data-thinking]').forEach((x) => x.classList.toggle('on', x === b));
      paintK('thinknote', thinkNote());
    } else if (b.dataset.a === 'memload') {
      paintK('mem', '<span class="k">读取中…</span>');
      await loadMem();
    } else if (b.dataset.a === 'memsave' || b.dataset.a === 'memclear') {
      const m = byok.memory;
      if (!m || m.error) return;
      const clear = b.dataset.a === 'memclear';
      if (clear && !confirm(`清空模型 ${m.scope} 的全部经验？`)) return;
      const ta = root.querySelector('[data-f="memtext"]');
      const text = clear ? '' : (ta ? ta.value : m.text);
      const r = await llm.call('PUT', '/api/v1/memory', { scope: m.scope, text, games: clear ? 0 : m.games });
      if (r.status === 200) {
        byok.memory = { scope: m.scope, text: r.json.item ? r.json.item.text : '', games: r.json.item ? r.json.item.games : 0 };
        paintK('mem', memoryHtml());
        paintK('memnote', `<b class="ok">${clear ? '已清空' : '已保存'}</b>`);
      } else paintK('memnote', `<b class="bad">${esc(callErr(r))}</b>`);
    } else if (b.dataset.a === 'preview') {
      paintK('preview', promptPreview());
    } else if (b.dataset.a === 'copysbrief') {
      const p = s.player;
      const km = p.keyMeta || { provider: 'kimi', model: 'kimi-k3' };
      const text = buildStrategyBrief({
        provider: km.provider, model: km.model, mapSize: s.mapSize, thinking: p.thinking, autonomy: p.autonomy, strategy: p.persona,
        memory: byok.memory && byok.memory.text ? byok.memory.text : '', requirement: p.strategyBrief,
      });
      const ok = await copyText(text);
      paintK('sbriefnote', ok ? '<b class="ok">已复制</b>，粘贴给你的 agent' : '<b class="bad">复制失败</b>');
    } else if (b.dataset.a === 'trialrun') {
      await runTrial();
    } else if (b.dataset.a === 'trialstop') {
      if (trialState.stop) trialState.stop.aborted = true;
      paintK('trial2', '<span class="k">正在停止（等当前这一步回来）…</span>');
    } else if (b.dataset.a === 'stratsave') {
      const nm = root.querySelector('[data-f="stratname"]');
      const r = strategyLib.save(nm ? nm.value : '', s.player.persona);
      paintK('stratlib', strategyLibHtml());
      paintK('stratnote', r.error ? `<b class="bad">${esc(r.error)}</b>` : `<b class="ok">已保存</b>「${esc(r.name)}」`);
    } else if (b.dataset.a === 'stratuse') {
      const e = strategyLib.get(b.dataset.id);
      if (e) {
        set(() => { s.player.persona = e.text; });
        render();
      }
    } else if (b.dataset.a === 'stratdel') {
      strategyLib.remove(b.dataset.id);
      paintK('stratlib', strategyLibHtml());
    } else if (b.dataset.autonomy) {
      set(() => { s.player.autonomy = b.dataset.autonomy; });
      root.querySelectorAll('[data-autonomy]').forEach((x) => x.classList.toggle('on', x === b));
    } else if (b.dataset.a === 'kadd') {
      await addKey();
    } else if (b.dataset.a === 'ktest') {
      await testKey(b.dataset.key);
    } else if (b.dataset.a === 'kdel') {
      await deleteKey(b.dataset.key);
    } else if (b.dataset.persona) {
      set(() => { s.player.persona = PERSONAS[b.dataset.persona].text; });
      const ta = root.querySelector('[data-f="persona"]');
      if (ta) ta.value = s.player.persona;
      const c = root.querySelector('[data-k="count"]');
      if (c) c.textContent = String(Array.from(s.player.persona).length);
    } else if (b.dataset.a === 'probe') {
      probed = true;
      proxy = { ok: false, error: '检测中…' };
      refreshProxy();
      proxy = await probe();
      refreshProxy();
    } else if (b.dataset.a === 'trial') {
      const paint = () => {
        const out = root.querySelector('[data-k="trial"]');
        if (out) out.innerHTML = trialHtml;
      };
      trialHtml = '运行中…';
      paint();
      const r = await trial(s.player.code, s.seed);
      const logs = r.logs && r.logs.length ? `<br>${r.logs.map(esc).join('<br>')}` : '';
      const it = r.intent ? ` · 意图 ${esc(r.intent.type)} (${r.intent.x}, ${r.intent.y})${r.intent.note ? ` ${esc(r.intent.note)}` : ''}` : '';
      trialHtml = r.ok
        ? `<b class="ok">通过</b> · 第 1 回合返回 <code>${esc(r.dir)}</code>${it} · decide ${r.ms.toFixed(1)} ms · init ${(r.initMs ?? 0).toFixed(1)} ms${r.skipped ? ` · ${esc(r.skipped)}` : ''}${r.warn ? ` · <span class="warn">${esc(r.warn)}</span>` : ''}${logs}`
        : `<b class="bad">失败</b> · ${esc(r.error)}${logs}`;
      paint();
    } else if (b.dataset.a === 'evalrun' && scripts) {
      evalBusy = true;
      evalHtml = '<span class="k">准备中…</span>';
      b.disabled = true;
      b.textContent = '试跑中…';
      paintK('eval', evalHtml);
      try {
        const seats = await evalSeats();
        const { markdown } = await scripts.evaluate({
          size: s.mapSize, seeds: `1-${s.evalRuns}`, seats,
          onProgress: (d, t) => paintK('eval', `<span class="k">试跑中 ${d} / ${t} 局…</span>`),
        });
        evalHtml = mdToHtml(markdown);
      } catch (err) {
        evalHtml = `<b class="bad">试跑失败</b> · ${esc(err.message)}`;
      }
      evalBusy = false;
      b.disabled = false;
      b.textContent = '开始试跑';
      paintK('eval', evalHtml);
    } else if (b.dataset.a === 'copybrief') {
      const ok = await copyText(briefText());
      paintK('briefnote', ok ? '<b class="ok">已复制</b>，粘贴给你的 agent' : '<b class="bad">复制失败</b>');
    } else if (b.dataset.a === 'libsave' && scripts) {
      const p = s.player;
      const r = scripts.library.save({ id: p.scriptId || undefined, name: p.scriptName, author: p.scriptAuthor, origin: p.scriptOrigin, code: p.code });
      libNote = r.error ? `<b class="bad">${esc(r.error)}</b>` : `<b class="ok">已保存</b>「${esc(r.name)}」，可在对手座位选用`;
      if (!r.error) set(() => { s.player.scriptId = r.id; });
      render();
    } else if (b.dataset.a === 'libimport') {
      root.querySelector('[data-f="libfile"]').click();
    } else if (b.dataset.a === 'libexportcur' && scripts) {
      const p = s.player;
      const x = scripts.library.exportText({ name: p.scriptName, author: p.scriptAuthor, origin: p.scriptOrigin, code: p.code });
      download(x.filename, x.text);
    } else if (b.dataset.a === 'libedit' && scripts) {
      const id = b.dataset.id;
      try {
        const e = await scripts.load(id);
        const builtin = BUILTINS.some((x) => x.id === id);
        // 内置脚本载入后是你的副本（不改内置本身）
        loadIntoEditor(builtin ? { ...e, name: `${e.name}（副本）`, author: '', origin: 'human' } : e, builtin ? '' : id);
        libNote = `已载入「${esc(e.name)}」`;
      } catch (err) {
        libNote = `<b class="bad">${esc(err.message)}</b>`;
      }
      render();
    } else if (b.dataset.a === 'libexport' && scripts) {
      const e = scripts.library.get(b.dataset.id);
      if (e) {
        const x = scripts.library.exportText(e);
        download(x.filename, x.text);
      }
    } else if (b.dataset.a === 'libdel' && scripts) {
      const e = scripts.library.get(b.dataset.id);
      if (e && confirm(`删除脚本「${e.name}」？`)) {
        scripts.library.remove(e.id);
        set(() => {
          if (s.player.scriptId === e.id) s.player.scriptId = '';
          for (const o of s.opponents) if (o.scriptId === e.id) o.scriptId = BUILTINS[0].id;
        });
        libNote = `已删除「${esc(e.name)}」`;
        render();
      }
    } else if (b.dataset.a === 'histreplay' && onReplay) {
      b.disabled = true;
      paintK('histnote', '<span class="k">读取记录…</span>');
      await onReplay(b.dataset.id);
      b.disabled = false;
    } else if (b.dataset.a === 'histtalk' && llm) {
      const id = b.dataset.id;
      const note = (html) => paintK('histnote', html);
      b.disabled = true;
      note('<span class="k">读取对话日志…</span>');
      const r = await llm.call('GET', `/api/v1/matches/${encodeURIComponent(id)}/llm-log`);
      b.disabled = false;
      if (r.status === 200 && r.json && typeof r.json.jsonl === 'string') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.json.jsonl], { type: 'application/x-ndjson' }));
        a.download = r.json.filename || `maze-ai-talk-${id}.jsonl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        note(`<b class="ok">已下载</b> · ${r.json.calls} 次调用 · ${esc(a.download)}`);
      } else {
        note(`<b class="bad">下载失败</b> · ${esc(r.status === 0 ? '连不上游戏服务器' : (r.json && r.json.message) || `HTTP ${r.status}`)}`);
      }
    } else if (b.dataset.a === 'history') {
      historyHtml = '<span class="k">读取中…</span>';
      const el = root.querySelector('[data-k="history"]');
      if (el) el.innerHTML = historyHtml;
      await loadHistory();
    } else if (b.dataset.a === 'start') {
      error = '';
      if (s.player.mode === 'workbuddy') {
        error = 'WorkBuddy 上场的对局在 WorkBuddy 的任务会话里进行：复制上面的提示词粘贴过去即可；想在这里玩请换一种玩法';
        render();
        return;
      }
      if (s.player.mode === 'byok' && !s.player.keyId) {
        error = byok.note ? '接入大模型需要游戏服务器（npm run play）' : '先在「接入我的大模型」里添加并选择一个模型';
        render();
        return;
      }
      onStart(structuredClone(s));
    } else if (b.dataset.a === 'resume') {
      onResume();
    }
  });

  root.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (f === 'code') set(() => { s.player.code = e.target.value; });
    else if (f === 'sname') set(() => { s.player.scriptName = e.target.value; });
    else if (f === 'sauthor') set(() => { s.player.scriptAuthor = e.target.value; });
    else if (f === 'brief') set(() => { s.player.brief = e.target.value; });
    else if (f === 'trialbtext') trialState.bText = e.target.value;
    else if (f === 'sbrief') set(() => { s.player.strategyBrief = e.target.value; });
    else if (f === 'wbstrategy') {
      wb.strategy = e.target.value;
      const pre = root.querySelector('[data-k="wbprompt"]');
      if (pre) pre.textContent = wbPrompt();
    }
    else if (f === 'persona') {
      set(() => { s.player.persona = e.target.value; });
      const c = root.querySelector('[data-k="count"]');
      if (c) c.textContent = String(Array.from(e.target.value).length);
    } else if (f === 'seed') set(() => { s.seed = e.target.value.trim(); });
    else if (f === 'kmodel') byok.form.model = e.target.value;
    else if (f === 'kbase') byok.form.baseUrl = e.target.value;
    else if (f === 'callcap') {
      const v = Math.floor(Number(e.target.value));
      set(() => { s.player.callCap = Number.isFinite(v) && v > 0 ? Math.min(400, v) : 0; });
    }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    const f = t.dataset.f;
    if (t.name === 'keysel') {
      selectKey(byok.keys.find((k) => k.keyId === t.value) || null);
      root.querySelectorAll('.keyrow').forEach((r) => r.classList.toggle('on', r.contains(t)));
    } else if (f === 'kprovider') {
      byok.form.provider = t.value;
      byok.form.model = '';
      byok.adding = true;
      paintByok();
    } else if (f === 'kreasoning') byok.form.reasoning = t.checked;
    else if (f === 'kremember') byok.form.remember = t.checked;
    else if (f === 'risk') set(() => { s.player.safetyGate = !t.checked; });
    else if (f === 'usemem') {
      set(() => { s.player.useMemory = t.checked; });
      const a = root.querySelector('[data-f="automem"]');
      if (a) a.disabled = !t.checked;
    } else if (f === 'automem') set(() => { s.player.autoMemory = t.checked; });
    else if (f === 'trialn' || f === 'trialsize' || f === 'trialab' || f === 'trialbthink') {
      if (f === 'trialn') trialState.games = Number(t.value) || 5;
      if (f === 'trialsize' && isMapSize(t.value)) trialState.size = t.value;
      if (f === 'trialab') {
        trialState.ab = t.checked;
        const box = root.querySelector('[data-k="trialb"]');
        if (box) box.hidden = !t.checked;
      }
      if (f === 'trialbthink') trialState.bThinking = t.value;
      paintK('trialest', trialEstimate());
    } else if (f === 'wbsize' && isMapSize(t.value)) {
      wb.size = t.value;
      const pre = root.querySelector('[data-k="wbprompt"]');
      if (pre) pre.textContent = wbPrompt();
    } else if (f === 'trialbsel' && t.value) {
      const e = strategyLib.get(t.value);
      if (e) {
        trialState.bText = e.text;
        const ta = root.querySelector('[data-f="trialbtext"]');
        if (ta) ta.value = e.text;
      }
    }
    else if (f === 'mapping') set(() => { s.mapping = t.value; });
    else if (f === 'speed') set(() => { s.speed = Number(t.value); });
    else if (f === 'brain') {
      set(() => { s.opponents[Number(t.dataset.opp)].brain = t.value; });
      render();
      autoProbe();
    } else if (f === 'opersona') {
      set(() => { s.opponents[Number(t.dataset.opp)].persona = t.value; });
      render();
    } else if (f === 'oscript') {
      set(() => { s.opponents[Number(t.dataset.opp)].scriptId = t.value; });
      render();
    } else if (f === 'sorigin') set(() => { s.player.scriptOrigin = t.value === 'agent' ? 'agent' : 'human'; });
    else if (f === 'evalruns') set(() => { s.evalRuns = Number(t.value) || 20; });
    else if (f === 'libfile' && t.files && t.files[0] && scripts) {
      const file = t.files[0];
      file.text().then((text) => {
        const r = scripts.library.importText(text, file.name);
        if (r.error) libNote = `<b class="bad">导入失败：${esc(r.error)}</b>`;
        else {
          loadIntoEditor(r, r.id);
          const h = parseHeader(text);
          libNote = `<b class="ok">已导入</b>「${esc(r.name)}」${h.name ? '' : '（没有文件头，按文件名命名）'}，已存进脚本库`;
        }
        render();
      });
    } else if (f === 'example' && t.value) {
      set(() => {
        s.player.code = t.value === 'template' ? SCRIPT_TEMPLATE : SCRIPT_EXAMPLES[t.value].code;
        s.player.scriptId = '';
      });
      trialHtml = '';
      render();
    }
  });

  // 代码框里 Tab 插两个空格，而不是跳焦点
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.target.classList.contains('code')) {
      e.preventDefault();
      const t = e.target;
      const a = t.selectionStart;
      t.setRangeText('  ', a, t.selectionEnd, 'end');
      set(() => { s.player.code = t.value; });
    }
  });

  return {
    get open() { return !root.hidden; },
    get setup() { return structuredClone(s); },
    /** 设置项（main 改了映射等也同步回来）。 */
    patch(p) {
      set(() => Object.assign(s, p));
    },
    show({ resume = false, err = '' } = {}) {
      canResume = resume;
      error = err;
      probed = false;
      byok.memory = null; // 赛后可能刚写过经验：回到设置页时重新读
      render();
      root.hidden = false;
      autoProbe();
      loadHistory();
      if (s.player.mode === 'byok') loadByok();
      if (s.player.mode === 'workbuddy') loadWorkbuddy();
    },
    hide() {
      root.hidden = true;
    },
  };
}
