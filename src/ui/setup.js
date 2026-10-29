// 开局设置（SPEC §9 玩家通道、§7 AI 对手）：
//   你怎么玩：手打 / 脚本 Agent（JS，Worker 沙箱）/ 提示词 Agent（写风格，模拟大模型或本地代理）
//            / 接入我的大模型（05 模式 B：key 交给游戏服务器保管，经服务器中转；思路 + 自主度 + 自保闸门 + 调用上限）
//   对手：每个 AI 选「模拟大模型 / 大模型（本地代理）/ 启发式」+ 风格预设
//   对局：种子（空 = 随机）、默认倍速、方向映射；代理状态探测
// 设置存 localStorage（maze.setup.v1）。API key 绝不进 localStorage / 设置对象：只在点「保存」时从输入框读一次发给服务器，随即清空。

import { PERSONAS } from '../ai/mock-llm.js';
import { AUTONOMY, FOLLOW_ZH } from '../ai/codec.js';
import { SCRIPT_TEMPLATE, SCRIPT_EXAMPLES } from '../player/script-host.js';
import { MAPPINGS } from '../player/input.js';
import { ACTOR_COLORS } from '../render/palette.js';
import { esc, frame, SEAT_NAMES, tokensText } from './hud.js';

const KEY = 'maze.setup.v1';

export const BRAINS = Object.freeze({
  mock: '模拟大模型',
  proxy: '大模型（本地代理）',
  heuristic: '启发式',
});

export function defaultSetup() {
  return {
    seed: '',
    speed: 2,
    mapping: 'grid',
    player: {
      mode: 'manual', code: SCRIPT_TEMPLATE, persona: PERSONAS.balanced.text, llm: 'mock',
      // 模式 B：keyId 只是服务器上那把 key 的编号（不是 key 本身）；keyMeta 只有服务商 / 模型名
      keyId: '', keyMeta: null, autonomy: 'blend', safetyGate: true, callCap: 0,
    },
    opponents: [
      { brain: 'mock', persona: 'setHunter' },
      { brain: 'mock', persona: 'chest' },
      { brain: 'mock', persona: 'cautious' },
    ],
  };
}

export function loadSetup() {
  const d = defaultSetup();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s) return d;
    return {
      ...d,
      ...s,
      player: { ...d.player, ...(s.player || {}) },
      opponents: d.opponents.map((o, i) => ({ ...o, ...((s.opponents || [])[i] || {}) })),
    };
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
  { id: 'script', title: '脚本 Agent', desc: '写一个 JS 函数 decide(obs, api)，在 Worker 沙箱里替你走。' },
  { id: 'prompt', title: '提示词 Agent', desc: '用一段话描述打法，交给模拟大模型 / 本地代理规划目标，引擎负责寻路。' },
  { id: 'byok', title: '接入我的大模型', desc: '填自己的模型 key，按你的思路代打；经游戏服务器中转，费用由你的服务商账户承担。' },
];

const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;

const VERIFY = {
  verified: '<b class="ok">✓ 校验通过</b>',
  mismatch: '<b class="bad">✗ 校验不一致</b>',
  unverifiable: '<b class="warn">? 无法校验</b>',
};
const CHANNEL = { manual: '手打', script: '脚本', 'prompt-mock': '提示词·模拟', 'prompt-proxy': '提示词·大模型' };
const channelOf = (tag) => CHANNEL[tag] || (tag.startsWith('byok:') ? `我的大模型·${tag.slice(5).split('/').pop()}` : tag);
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
  return `<table class="hist"><tr><th>时间</th><th>种子</th><th>回合</th><th>你</th><th>名次 / 分数</th><th>校验</th></tr>${r.items.map((m) => {
    const me = m.ranking.find((x) => x.seat === 0) || {};
    const tag = m.seats[0] ? m.seats[0].tag : '';
    return `<tr><td>${when(m.endedAt || m.receivedAt)}</td><td>${esc(m.seed)}</td><td>${m.turns}</td><td>${esc(channelOf(tag))}</td>
      <td>${me.place ?? '–'} 名 · ${me.score ?? '–'} 分 · ${esc(STATUS[me.status] || me.status || '')}</td>
      <td title="${esc(m.verifyNote || '')}">${VERIFY[m.verify] || esc(m.verify)}</td></tr>`;
  }).join('')}</table>${r.total > r.items.length ? `<p class="k">共 ${r.total} 局，显示最近 ${r.items.length} 局</p>` : ''}`;
}

/**
 * @param {HTMLElement} root
 * @param {{probe:()=>Promise<object>, trial:(code:string, seed:string)=>Promise<object>, onStart:(s:object)=>void, onResume:()=>void,
 *          history?:()=>Promise<{ok:boolean, items?:object[], total?:number, reason?:string}>,
 *          llm?:{call:(method:string, path:string, body?:object)=>Promise<{status:number, json:object|null, reason?:string}>}}} o
 *   llm.call：带游客令牌的服务器请求（sync.call），模式 B 的 key 管理 / 测试连接 / 用量
 */
export function createSetup(root, { probe, trial, onStart, onResume, history, llm }) {
  let s = loadSetup();
  let proxy = { ok: false, error: '未检测' };
  let probed = false;
  let canResume = false;
  let error = '';
  let trialHtml = '';
  let historyHtml = '<span class="k">读取中…</span>';
  // 模式 B 的界面状态（不进 localStorage；API key 输入框的值从不进这里）
  const byok = {
    loading: false, note: '', providers: null, canRemember: false, keys: [], usage: null, adding: false,
    form: { provider: 'hunyuan', model: '', baseUrl: '', reasoning: false, remember: false },
    testHtml: '',
  };

  async function loadHistory() {
    if (!history) return;
    const r = await history();
    historyHtml = historyView(r);
    const el = root.querySelector('[data-k="history"]');
    if (el) el.innerHTML = historyHtml;
  }

  // 只有选了「本地代理」才自动探测：代理没起时浏览器会把被拒的连接记成 error 级控制台日志（L13 要求冷启动 0 error）
  const wantsProxy = () => (s.player.mode === 'prompt' && s.player.llm === 'proxy') || s.opponents.some((o) => o.brain === 'proxy');
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
    if (p.mode === 'manual') {
      return `<div class="row"><label>方向映射</label><select data-f="mapping">${Object.entries(MAPPINGS).map(([k, m]) => opt(k, m.label, s.mapping)).join('')}</select></div>
        <p class="k">等距视角下箭头键没有「正上方」的网格方向，只能二选一地转 45°（SPEC O7，灰盒 A/B）。Q / E / C / Z 永远是屏幕斜向：左上 / 右上 / 右下 / 左下。空格原地等一回合。</p>`;
    }
    if (p.mode === 'script') {
      return `<div class="row"><label>示例</label>
          <select data-f="example"><option value="">— 套用示例 —</option>${opt('template', '模板：直奔出口', '')}${Object.entries(SCRIPT_EXAMPLES).map(([k, e]) => opt(k, e.label, '')).join('')}</select>
          <span class="sp"></span><button class="btn" data-a="trial">试运行</button></div>
        <textarea class="code" data-f="code" spellcheck="false" rows="16">${esc(p.code)}</textarea>
        <div class="trial k" data-k="trial">${trialHtml}</div>
        <details class="api"><summary>obs / api 速查</summary><pre>${esc(`obs.self   {seat,x,y,stamina,staminaMax,score,gems[5],sets,exit{x,y},distToExit,lowStamina,inEndgame,blockedStreak}
obs.actors [{seat,score,stamina,gems,sets,status,visible, x,y | lastSeen{x,y,turnsSince}}]   视野切比雪夫 9
obs.gems   [{c,color,x,y,dist}]     obs.chest {present,x,y,dist | respawnAtTurn}
obs.turn / maxTurns / gemGeneration / gemRespawnsLeft     obs.state = 上回合 api.setState 存的值
api.shortestStep(x,y) → 'N'|'E'|'S'|'W'|'STAY'|-1     api.distance(x,y[,fromX,fromY]) → 步数|-1
   每回合最多 8 次；目标须是宝物 / 自己出口 / 视野内或记忆中的对手 / 视野半径内的格子，否则 -1
api.isFloor(x,y)  api.size  api.setState(v ≤16KB)  api.log(...)
限时 100 ms；连续 10 次异常切回手动，累计 5 次无效返回改为自动回家。`)}</pre></details>`;
    }
    return `<div class="row"><label>大模型</label>
        <label class="radio"><input type="radio" name="llm" value="mock"${p.llm === 'mock' ? ' checked' : ''}> 模拟大模型（离线）</label>
        <label class="radio"><input type="radio" name="llm" value="proxy"${p.llm === 'proxy' ? ' checked' : ''}> 本地代理</label></div>
      <div class="row chips"><label>风格预设</label>${Object.entries(PERSONAS).map(([k, v]) => `<button class="btn chip" data-persona="${k}">${esc(v.label)}</button>`).join('')}</div>
      <textarea class="persona" data-f="persona" rows="6" maxlength="2000" placeholder="例如：先拿缺的颜色凑成套；宝箱近就顺手开；体力只够回家就回家。">${esc(p.persona)}</textarea>
      <div class="k"><span data-k="count">${Array.from(p.persona).length}</span> / 2000 字 · 只能影响「选哪个目标」，改不了规则和观察内容；模拟大模型按关键词（保守 / 冒险 / 凑套 / 宝箱 / 不去抢）调整权重。</div>`;
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
      return `<b class="ok">✓ 连接正常</b> · ${(r.json.ms / 1000).toFixed(1)} 秒 · 模型 <code>${esc(r.json.model || '')}</code> · token ${r.json.usage.in} / ${r.json.usage.out}<br>
        示范决策（开局局面）：去${TARGET_ZH[p.targetType]} (${p.target.x}, ${p.target.y}) · ${FOLLOW_ZH[p.follow] || '—'} · 「${esc(p.reason)}」${p.deviation ? `<br>说明：${esc(p.deviation)}` : ''}`;
    }
    if (r.status === 200) {
      return `<b class="warn">● 连得上，但回复不合格</b>：${esc(r.json.error || '')} · 原文 <code>${esc(r.json.text || '')}</code><br>
        对局里不合格的回复会带着错误重试一次，仍不行就由启发式顶上；也可以换一个模型试试。`;
    }
    const code = r.json && r.json.error;
    const hint = code === 'upstream_auth' ? '（请检查 key 是否正确、账户是否欠费）'
      : code === 'upstream_bad' ? '（请检查模型名）'
        : code === 'upstream_timeout' ? '（服务商响应太慢；如果是推理模型，请勾选「这是推理模型」后重新添加）'
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
          <label class="radio"><input type="checkbox" data-f="kreasoning"${f.reasoning ? ' checked' : ''}> 这是推理模型（先思考再回答，超时从 40 秒放宽到 85 秒）</label></div>
        <div class="row"><label>API key</label><input type="password" data-f="kkey" autocomplete="off" spellcheck="false" size="34" placeholder="只在点按钮时发给游戏服务器一次">
          <label class="radio"><input type="checkbox" data-f="kremember"${f.remember && byok.canRemember ? ' checked' : ''}${byok.canRemember ? '' : ' disabled'}> 记住（服务器加密保存）</label>
          <button class="btn" data-a="kadd">保存并测试</button></div>
        <p class="k">${pv.note ? `${esc(pv.note)} · ` : ''}key 交给游戏服务器保管，页面不保存、不回显。默认「仅本次会话」：只在服务器内存里，24 小时后丢弃；勾「记住」则用 AES-256-GCM 加密后存进数据库${byok.canRemember ? '' : '（服务器未配置主密钥，暂不可用）'}。接口只返回服务商、模型名和尾号，随时可删。</p>
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
      <div class="k"><span data-k="count">${Array.from(p.persona).length}</span> / 2000 字 · 只能影响取舍，改不了规则和 AI 看到的局面。思路随对局存进服务器，仅你本人可见；对局记录里只有它的哈希。</div>
      <h4>你的 AI 该多听你的</h4>
      <div class="modes">${Object.entries(AUTONOMY).map(([k, a]) => `<button class="choice${p.autonomy === k ? ' on' : ''}" data-autonomy="${k}"><b>${a.label}</b><span>${a.short}</span></button>`).join('')}</div>
      <div class="row"><label class="radio"><input type="checkbox" data-f="risk"${p.safetyGate ? '' : ' checked'}> 允许冒险（关闭自保闸门）</label>
        <span class="k">默认关：目标会让你回不了出口时，引擎自动改为回家，记为「引擎安全覆盖」，不算 AI 偏离。</span></div>
      <div class="row"><label>每局调用上限</label><input type="number" data-f="callcap" min="0" max="400" step="10" value="${p.callCap || ''}" placeholder="不限" style="width:80px">
        <span class="k">到上限后由启发式接着打。实测 HY4 一局约 20 次调用、2–3 万 token（每次输入约 1.2k、输出约 45）；游戏本身的规划预算每座位每局约 70 次。</span></div>`;
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
    const r = await llm.call('POST', `/api/v1/keys/${encodeURIComponent(id)}/test`, { autonomy: s.player.autonomy, strategy: s.player.persona });
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
        <div class="detail">${detail()}</div>
      </section>
      <section><h3>对手</h3>
        <div class="opps">${s.opponents.map((o, k) => {
          const seat = k + 1;
          return `<div class="opp" style="--c:${ACTOR_COLORS[seat]}"><span class="nm">${SEAT_NAMES[seat]}</span>
            <select data-opp="${k}" data-f="brain">${Object.entries(BRAINS).map(([v, l]) => opt(v, l, o.brain)).join('')}</select>
            <select data-opp="${k}" data-f="opersona"${o.brain === 'heuristic' ? ' disabled' : ''}>${Object.entries(PERSONAS).map(([v, l]) => opt(v, l.label, o.persona)).join('')}</select>
            <span class="k">${o.brain === 'heuristic' ? '按距离贪心、自带让行解锁' : esc(PERSONAS[o.persona].text)}</span></div>`;
        }).join('')}</div>
      </section>
      <section><h3>大模型代理 <button class="btn mini" data-a="probe">重新检测</button></h3>
        <p class="proxy">${proxyLine()}</p>
        <p class="k">在项目目录运行 <code>npm run proxy</code>（先设 <code>LLM_BASE_URL</code> <code>LLM_API_KEY</code> <code>LLM_MODEL</code>，任何 OpenAI 兼容端点均可）。密钥只在代理进程里，页面拿不到。</p>
      </section>
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
    if (b.dataset.mode) {
      set(() => { s.player.mode = b.dataset.mode; });
      render();
      autoProbe();
      if (s.player.mode === 'byok') loadByok();
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
      trialHtml = r.ok
        ? `<b class="ok">通过</b> · 第 1 回合返回 <code>${esc(r.dir)}</code> · 耗时 ${r.ms.toFixed(1)} ms · 寻路调用 ${r.nav}${r.denied ? `（越权 / 超额 ${r.denied}）` : ''}${logs}`
        : `<b class="bad">失败</b> · ${esc(r.error)}${logs}`;
      paint();
    } else if (b.dataset.a === 'history') {
      historyHtml = '<span class="k">读取中…</span>';
      const el = root.querySelector('[data-k="history"]');
      if (el) el.innerHTML = historyHtml;
      await loadHistory();
    } else if (b.dataset.a === 'start') {
      error = '';
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
    if (t.name === 'llm') {
      set(() => { s.player.llm = t.value; });
      autoProbe();
    } else if (t.name === 'keysel') {
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
    else if (f === 'mapping') set(() => { s.mapping = t.value; });
    else if (f === 'speed') set(() => { s.speed = Number(t.value); });
    else if (f === 'brain') {
      set(() => { s.opponents[Number(t.dataset.opp)].brain = t.value; });
      render();
      autoProbe();
    } else if (f === 'opersona') {
      set(() => { s.opponents[Number(t.dataset.opp)].persona = t.value; });
      render();
    } else if (f === 'example' && t.value) {
      set(() => { s.player.code = t.value === 'template' ? SCRIPT_TEMPLATE : SCRIPT_EXAMPLES[t.value].code; });
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
      render();
      root.hidden = false;
      autoProbe();
      loadHistory();
      if (s.player.mode === 'byok') loadByok();
    },
    hide() {
      root.hidden = true;
    },
  };
}
