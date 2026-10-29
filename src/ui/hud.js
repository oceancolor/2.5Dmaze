// HUD（SPEC §10、03 §3.10）：DOM/CSS，不占 canvas 预算。四角分区，不压视口中心 40%。
//   左上 分数 + 回合（下挂事件播报） · 右上 倍速 / 时长常驻读数 + 体力 + 回家成本 + 出口罗盘
//   左下 你的 Agent（脚本 / 提示词 / 我的大模型代打时）+ 本人宝石 / 代数 / 宝箱 · 右下 四人名牌（通道 / 分数 / 体力 / 各色 / 成套 / 思考中）
//   顶部中间 工具条（倍速三档带各自预计时长 / 跳过动画 / 暂停 / 缩放 / 归位 / 方向映射 / 设置）· 底部中间 提示 / 丢弃提示
// 面板一律三层框：深色漆木外框 → 哑金线脚 → 纸面（frame > rim > in），切角 + 厚投影由 game.css 负责。
// 只读调度器与观察；所有操作经回调交给 main。对手的计划目标只在观战 / 结算后显示（不泄露非公开信息）。
// 「你的 AI」面板（05 §8.1）：意图 + 理由、遵循标签（遵循 / 部分 / 偏离 / 引擎安全覆盖）、计数与 token、
//   状态灯（熔断红灯 / 连续不合格黄灯）、接管 / 交还 AI / 换启发式代打。

import { ACTOR_COLORS, GEM_KEYS, GEM_NAMES, staminaTier } from '../render/palette.js';
import { tileCenter } from '../render/iso.js';
import { fieldFrom } from '../core/nav/bfs.js';
import { rankActors, scoreOf, setsOf, gemTotal } from '../core/scoring.js';
import { estimateTurnsLeft, estimateSeconds } from '../app/scheduler.js';
import { MAPPINGS } from '../player/input.js';
import { AUTONOMY, FOLLOW_ZH } from '../ai/codec.js';

export const SEAT_NAMES = Object.freeze(['你', 'AI-A', 'AI-B', 'AI-C']);
const HOME_COLORS = { ok: '#3FBF6A', warn: '#F2CE3B', bad: '#E8384F' };
const SOURCE_ZH = {
  llm: '大模型计划', 'llm-repair': '大模型计划（修复后）', guard: '引擎安全覆盖：回家', heuristic: '启发式', l3: '启发式（大模型熔断）',
  script: '脚本', 'auto-home': '引擎接管 · 自动回家', manual: '已切回手动', 'script-error': '脚本异常', 'script-invalid': '返回值无效',
};
const TARGET_ZH = { gem: '宝石', chest: '宝箱', exit: '出口' };
const FOLLOW_CHIP = { yes: 'ok', partial: 'warn', override: 'bad' };
/** 连续多少次不合格亮黄灯（05 §4，agent.maxInvalidStreak）。 */
const WARN_STREAK = 3;

/** 「1.2 万」式的 token 数。 */
export function tokensText(n) {
  if (!n) return '0';
  return n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万` : String(n);
}

/** 回家成本三档（SPEC §10）：绿 s ≥ 1.3d · 黄 d ≤ s < 1.3d · 红 s < d（整数比较）。 */
export function homeTier(stamina, dist, factorX10 = 13) {
  if (stamina * 10 >= dist * factorX10) return 'ok';
  if (stamina >= dist) return 'warn';
  return 'bad';
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dot = (seat) => `<i class="dot" style="--c:${ACTOR_COLORS[seat]}"></i>`;
/** 三层框。 */
export const frame = (inner, cls = '') => `<div class="frame ${cls}"><div class="rim"><div class="in">${inner}</div></div></div>`;

function el(tag, cls, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

/**
 * @param {HTMLElement} root
 * @param {{cfg:object, atlas:object, seats:{label:string, persona?:string}[], actions:object}} o
 *   actions: setSpeed(s) · toggleSkipAnim() · togglePause() · zoomBy(k) · recenter() · toggleMapping() · skipToEnd()
 *            follow(seat) · newMatch(mode?) · verify() → string · download() · openSetup()
 */
export function createHud(root, { cfg, atlas, seats, actions }) {
  const gemIcon = GEM_KEYS.map((k) => atlas.icon(`PRP_GEM_${k}_na_00`, 2).toDataURL());
  const img = (c, cls = 'gi') => `<img class="${cls}" src="${gemIcon[c]}" alt="${GEM_NAMES[c]}">`;

  root.innerHTML = '';
  const tl = el('div', 'hud tl');
  const tr = el('div', 'hud tr');
  const bl = el('div', 'hud bl');
  const br = el('div', 'hud br');
  const top = el('div', 'hud top');
  const bottom = el('div', 'hud bottom');
  const end = el('div', 'endcard');
  end.hidden = true;
  root.append(tl, tr, bl, br, top, bottom, end);

  tl.innerHTML = `${frame(`<div class="score-row">
      <div><div class="k">分数</div><div class="big" data-k="score">0</div></div>
      <div class="vr"></div>
      <div><div class="k">回合</div><div class="big"><span data-k="turn">1</span><small> / ${cfg.rules.maxTurns}</small></div></div>
    </div>`)}<ul class="feed"></ul>`;
  tr.innerHTML = `<div class="plate speed" data-k="speed"></div>
    ${frame(`<div class="row"><span class="k">体力</span><b class="num" data-k="stamina"></b><span class="sp"></span>
        <span class="home"><i class="hdot" data-k="hdot"></i>回家 <b class="num" data-k="home"></b> 步</span>
        <span class="compass" data-k="compass" title="出口方向"><svg viewBox="-10 -10 20 20" width="22" height="22"><path d="M0-8 L6 6 L0 3 L-6 6Z"/></svg></span></div>
      <div class="bar" data-k="bar"><i></i><i></i><i></i><i></i></div>
      <div class="note" data-k="note"></div>`, 'stam')}`;
  const s0 = seats[0];
  const agentBox = s0 && s0.label !== '手动'
    ? frame(`<div class="k">${s0.byok ? '你的 AI' : '你的 Agent'} · <b data-k="agentkind">${esc(s0.label)}</b>${s0.byok && s0.persona ? ` · ${esc(s0.persona)}` : ''}</div>
        <div class="agent" data-k="agent"></div><div class="aictl" data-k="aictl"></div><ol class="console" data-k="console"></ol>`, 'agentbox')
    : '';
  bl.innerHTML = `${agentBox}${frame(`<div class="k" data-k="gemhead"></div>
      <div class="gems" data-k="gems"></div>
      <div class="k sub" data-k="chest"></div>`)}`;
  br.innerHTML = frame('<div class="seats" data-k="seats"></div><div class="k foot" data-k="llm"></div>', 'seatbox');
  top.innerHTML = `<div class="toolbar">
      <span class="seg" data-k="speeds"></span>
      <button class="btn" data-a="skip" title="跳过动画（0）">跳过动画</button>
      <button class="btn" data-a="pause" title="暂停（P）">暂停</button>
      <span class="seg"><button class="btn" data-a="zout" title="缩小（-）">－</button><button class="btn" data-a="zin" title="放大（=）">＋</button></span>
      <button class="btn" data-a="center" title="镜头回到自己（F）">归位</button>
      <button class="btn" data-a="map" title="方向映射（M）" data-k="mapping"></button>
      <button class="btn" data-a="setup" title="开局设置（Esc）">设置</button>
    </div>
    <div class="plate spectate" data-k="spectate" hidden>你已结算 · 观战中 <button class="btn brass" data-a="toend">跳到结算（Enter）</button></div>`;
  bottom.innerHTML = '<div class="plate toast" data-k="toast" hidden></div><div class="plate hint" data-k="hint"></div>';

  const $ = (k) => root.querySelector(`[data-k="${k}"]`);
  const feed = tl.querySelector('.feed');
  const consoleEl = $('console');

  root.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault(); // 按钮不抢焦点：空格 / 方向键始终给游戏
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a;
    if (b.dataset.speed) actions.setSpeed(Number(b.dataset.speed));
    else if (a === 'skip') actions.toggleSkipAnim();
    else if (a === 'pause') actions.togglePause();
    else if (a === 'zout') actions.zoomBy(1);
    else if (a === 'zin') actions.zoomBy(-1);
    else if (a === 'center') actions.recenter();
    else if (a === 'map') actions.toggleMapping();
    else if (a === 'setup') actions.openSetup();
    else if (a === 'toend') actions.skipToEnd();
    else if (a === 'again') actions.newMatch('new');
    else if (a === 'same') actions.newMatch('same');
    else if (a === 'verify') root.querySelector('[data-k="verify"]').textContent = actions.verify();
    else if (a === 'download') actions.download();
    else if (a === 'takeover') actions.takeOver();
    else if (a === 'handback') actions.handBack();
    else if (a === 'useheur') actions.useHeuristic();
    else if (a === 'warnok') {
      warnFloor = warnStreak;
      lastKey = '';
    }
    if (b.dataset.follow !== undefined) actions.follow(Number(b.dataset.follow));
  });

  let lastKey = '';
  let syncLine = '';
  let compareLine = '';
  let toastTimer = 0;
  let exitField = null;
  let fieldMap = null;
  let warnStreak = 0;
  let warnFloor = 0;
  const agentNotes = { hard: 0, soft: 0, last: '' };

  function speedButtons(sched) {
    const left = estimateTurnsLeft(sched.map, sched.state);
    return cfg.motion.speeds.map((s) => {
      const on = sched.speed === s && !sched.skipAnim ? ' on' : '';
      return `<button class="btn${on}" data-speed="${s}" title="${s}×（${cfg.motion.speeds.indexOf(s) + 1}）">${s}× <small>${estimateSeconds(left, cfg, s, false, sched.waitPerTurn)}s</small></button>`;
    }).join('');
  }

  const statusOf = (sched, i) => {
    const c = sched.controllers[i];
    return c && c.status ? c.status() : null;
  };

  function planText(st) {
    if (!st || !st.target) return '';
    const t = st.target;
    return `${SOURCE_ZH[st.source] ?? st.source} → ${TARGET_ZH[t.type] ?? t.type} (${t.x}, ${t.y})${st.reason ? ` · ${esc(st.reason)}` : ''}`;
  }

  /** 遵循标签：引擎安全覆盖与 AI 偏离分开显示（05 §5.3）。 */
  function followTag(st) {
    if (st.source === 'guard') return '<em class="chip warn">引擎安全覆盖</em>';
    if (!st.follow) return '';
    return `<em class="chip ${FOLLOW_CHIP[st.follow]}">${FOLLOW_ZH[st.follow]}</em>${st.deviation ? ` <span class="k">${esc(st.deviation)}</span>` : ''}`;
  }

  /** 玩家 AI（规划 agent）的计数行与控制区；player = {ai, held:'ai'|'manual'|'heuristic', usage?}。 */
  function aiCounts(st, player) {
    const S = st.stats;
    const dec = S.applied + S.invalid + S.rejected + (S.stale || 0) + S.failed;
    const u = player.usage;
    return `决策 ${dec}${st.autonomy ? ` · 偏离 ${S.follow.override} · 部分 ${S.follow.partial}` : ''} · 不合格 ${S.invalid + S.rejected} · 安全覆盖 ${S.guardPlans}`
      + `${S.capped ? ' · 已到调用上限' : ''}${u && u.calls ? ` · token ${tokensText(u.in + u.out)}` : ''}`;
  }

  function aiControls(st, player) {
    const lamp = st.l3
      ? `<div class="lamp bad">● 大模型已熔断：${esc(st.l3)} · 本局由启发式接着打</div>`
      : warnStreak >= WARN_STREAK && warnStreak >= warnFloor + WARN_STREAK
        ? `<div class="lamp warn">● 你的 AI 一直答不对（连续 ${warnStreak} 次不合格）
            <button class="btn mini" data-a="warnok">继续</button><button class="btn mini" data-a="useheur">换启发式代打</button><button class="btn mini" data-a="takeover">我来手打</button></div>`
        : '';
    const btns = player.held === 'ai'
      ? '<button class="btn mini" data-a="takeover" title="切到手打；随时可以交还">接管（我来手打）</button>'
      : `<span class="k">${player.held === 'manual' ? '你在手打' : '启发式代打中'}</span> <button class="btn mini" data-a="handback">交还 AI</button>${player.held === 'heuristic' ? '<button class="btn mini" data-a="takeover">我来手打</button>' : ''}`;
    return `${lamp}<div class="row">${btns}</div>`;
  }

  /** 报告里的用量行；server = true 表示已换成服务器账本（含客户端超时放弃、但服务商照样计费的调用）。 */
  function usageText(u, r) {
    return `经服务器调用 ${u.calls} 次（其中修复 ${r.repairs}${u.failed ? `、客户端放弃 ${u.failed}` : ''}）· 输入 ${tokensText(u.in)} / 输出 ${tokensText(u.out)} token`
      + `${u.server ? '（服务器账本）' : ''} · 费用记在你的服务商账户${r.stale ? ' · 过期 = 回复合格，但生效时目标已被别人拿走' : ''}`;
  }

  /** 思路执行报告（05 §8.3）。 */
  function reportHtml({ report: r, usage: u, label, l3 = null }) {
    const f = r.follow;
    const a = AUTONOMY[r.autonomy];
    const parts = [`遵循 ${f.yes}`, `部分 ${f.partial}`, `偏离 ${f.override}`, `不合格 ${r.invalid}`];
    if (r.stale) parts.push(`过期 ${r.stale}`);
    if (r.failed) parts.push(`调用失败 ${r.failed}`);
    const devs = r.deviations;
    return `<div class="report">
      <h3>思路执行报告 <span class="k">· ${esc(label)}${a ? ` · ${a.label}` : ''}${r.safetyGate ? '' : ' · 允许冒险'}</span></h3>
      <p>决策 <b>${r.decisions}</b> 次：${parts.join(' / ')} · 引擎安全覆盖 ${r.guard}${r.capped ? ` · 到调用上限后 ${r.capped} 次没再问` : ''}</p>
      ${l3 ? `<p class="bad">大模型中途熔断（${esc(l3)}），之后由启发式接着打</p>` : ''}
      <p class="k" data-k="usage">${usageText(u, r)}</p>
      ${devs.length ? `<details><summary>偏离 / 部分的理由（${devs.length} 条，按回合）</summary><ol class="devs">${devs.map((d) => `<li><span class="t">T${d.n}</span>
        <em class="chip ${FOLLOW_CHIP[d.follow]}">${FOLLOW_ZH[d.follow]}</em> ${esc(d.deviation || '（没写理由）')} <span class="k">→ ${TARGET_ZH[d.targetType] ?? ''} (${d.target.x}, ${d.target.y})</span></li>`).join('')}</ol></details>` : ''}
      <p class="k" data-k="compare">${esc(compareLine)}</p>
    </div>`;
  }

  function seatRows(sched, follow, god) {
    const s = sched.state;
    const ranks = new Map(rankActors(s.actors, cfg).map((r) => [r.seat, r]));
    return s.actors.map((a, i) => {
      const r = ranks.get(i);
      const st = statusOf(sched, i);
      const chip = a.status === 'escaped' ? `<em class="chip ok">到达 T${a.escapedTurn}</em>`
        : a.status === 'failed' ? `<em class="chip bad">${a.failReason === 'stamina' ? '体力耗尽' : '超时'}</em>`
          : `<em class="chip">体力 ${a.stamina}</em>`;
      const gems = a.gems.map((nc, c) => `<span class="${nc ? '' : 'zero'}">${img(c, 'gs')}${nc}</span>`).join('');
      const me = i === sched.playerSeat ? ' me' : '';
      const fol = sched.spectating && i === follow ? ' fol' : '';
      const think = (st && st.thinking) || sched.waitingFor.includes(i) ? '<em class="think">思考中</em>' : '';
      const info = seats[i] ? `<span class="tag">${esc(seats[i].label)}${seats[i].persona ? `·${esc(seats[i].persona)}` : ''}</span>` : '';
      const plan = god && i !== sched.playerSeat && a.status === 'active' && st ? `<span class="plan">${planText(st)}</span>` : '';
      return `<button class="seat${me}${fol}" data-follow="${i}" style="--c:${ACTOR_COLORS[i]}" title="${sched.spectating ? '镜头跟随' : ''}">
        <span class="nm">${SEAT_NAMES[i]}${r.champion ? ' ★' : ''}${info}${think}</span>${chip}<b class="sc">${scoreOf(a, cfg)}</b>
        <span class="mini">${gems}<span class="sets">套×${setsOf(a.gems)}</span></span>${plan}</button>`;
    }).join('');
  }

  return {
    /** 每帧调用；只在可见量变化时改 DOM。player：玩家座位的规划 agent（提示词 / 我的大模型），接管后仍从它读状态。 */
    update(sched, { follow, mapping, zoomIndex, waitMs, quality, poolStats, player = null }) {
      const s = sched.state;
      const me = s.actors[sched.playerSeat];
      const god = sched.spectating || s.ended;
      const sts = s.actors.map((_, i) => statusOf(sched, i));
      const ast = player && player.ai ? player.ai.status() : null;
      if (ast) {
        if (ast.invalidStreak < warnFloor) warnFloor = 0;
        warnStreak = ast.invalidStreak;
      }
      const stKey = sts.map((x) => (x ? `${x.source}${x.thinking ? '+' : ''}${x.target ? `${x.target.x},${x.target.y}` : ''}` : '')).join('/');
      const aKey = ast ? `${player.held}${ast.follow}${ast.invalidStreak}${warnFloor}${ast.l3}${ast.stats.applied}${ast.stats.invalid}${player.usage ? player.usage.calls : ''}` : '';
      const key = [s.turn, s.ended, sched.speed, sched.skipAnim, sched.paused, sched.spectating, follow, mapping, zoomIndex,
        waitMs > 600, quality, sched.waitingFor.join(','), stKey, aKey, poolStats ? `${poolStats.total}${poolStats.l3}` : ''].join('|');
      if (key === lastKey) return;
      lastKey = key;
      const map = sched.map;
      const N = map.size;
      if (fieldMap !== map) {
        const [ex, ey] = map.exits[sched.playerSeat];
        exitField = fieldFrom(map, ey * N + ex);
        fieldMap = map;
      }

      $('score').textContent = String(scoreOf(me, cfg));
      $('turn').textContent = String(s.ended ? s.endTurn : s.turn);

      const left = estimateTurnsLeft(map, s);
      $('speed').textContent = s.ended ? `对局结束 · 第 ${s.endTurn} 回合`
        : sched.paused ? '已暂停'
          : sched.fast ? '快进到结算…'
            : sched.skipAnim ? `跳过动画 · 预计 ${estimateSeconds(left, cfg, sched.speed, true, sched.waitPerTurn)} 秒`
              : `${sched.speed}× · 预计 ${estimateSeconds(left, cfg, sched.speed, false, sched.waitPerTurn)} 秒`;

      const active = me.status === 'active';
      const d = active ? exitField[me.y * N + me.x] : 0;
      $('stamina').textContent = `${me.stamina} / ${me.staminaMax}`;
      const tier = staminaTier((100 * me.stamina) / me.staminaMax);
      $('bar').querySelectorAll('i').forEach((c, k) => { c.style.background = k < tier.cells ? tier.color : ''; });
      const ht = active ? homeTier(me.stamina, d, cfg.ai.homeFactorX10) : 'ok';
      $('home').textContent = active ? String(d) : '—';
      $('hdot').style.background = HOME_COLORS[ht];
      const comp = $('compass');
      if (active) {
        const [ex, ey] = map.exits[sched.playerSeat];
        const [ax, ay] = tileCenter(me.x, me.y);
        const [bx, by] = tileCenter(ex, ey);
        const ang = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI + 90;
        comp.style.transform = `rotate(${ang.toFixed(1)}deg)`;
        comp.style.color = HOME_COLORS[ht];
        comp.hidden = false;
      } else {
        comp.hidden = true;
      }
      const note = $('note');
      note.className = `note ${ht}`;
      note.textContent = !active ? (me.status === 'escaped' ? `已到达出口（第 ${me.escapedTurn} 回合）` : '已出局')
        : ht === 'bad' ? '体力不够走回出口了！' : ht === 'warn' ? '体力只剩回家的余量，该往回走了' : '';
      tr.classList.toggle('alarm', ht === 'bad');

      $('gemhead').textContent = `宝石 · 第 ${s.gemGeneration} / ${1 + cfg.treasure.gemRespawnMax} 代 · 场上 ${s.gems.length} 颗 · 还会重生 ${s.gemRespawnsLeft} 次`;
      $('gems').innerHTML = me.gems.map((nc, c) => `<span class="${nc ? '' : 'zero'}">${img(c)}×${nc}</span>`).join('')
        + `<span class="sets">成套 ×${setsOf(me.gems)}</span>`;
      const ch = s.chest;
      $('chest').textContent = ch.present ? `宝箱在场 (${ch.x}, ${ch.y})`
        : ch.respawnsLeft > 0 ? `宝箱第 ${ch.openedTurn + cfg.treasure.chest.respawnTurns} 回合起重生` : '宝箱已用完';

      const agent = $('agent');
      if (agent) {
        const kind = sched.controllers[sched.playerSeat];
        const st = ast || sts[sched.playerSeat];
        if (ast) {
          const live = player.held === 'ai';
          const head = live ? `${ast.thinking ? '<em class="think">思考中</em> ' : ''}${planText(ast) || esc(SOURCE_ZH[ast.source] ?? ast.source)} ${followTag(ast)}`
            : '<span class="k">AI 暂停中（计划照常统计）</span>';
          agent.innerHTML = `${head}<div class="k">${aiCounts(ast, player)}</div>`;
          const ctl = $('aictl');
          if (ctl) ctl.innerHTML = s.ended || me.status !== 'active' ? '' : aiControls(ast, player);
        } else if (!kind) agent.innerHTML = '<span class="bad">已切回手动操作</span>';
        else if (st) {
          const extra = st.counts ? ` · 硬异常 ${st.counts.hard}（连续 ${st.counts.hardStreak}）· 软异常 ${st.counts.soft} · 平均 ${st.counts.avgMs.toFixed(1)} ms` : '';
          const stats = st.stats ? ` · 调用 ${st.stats.requests} · 修复 ${st.stats.repairs} · 自保 ${st.stats.guard}` : '';
          agent.innerHTML = `${st.thinking ? '<em class="think">思考中</em> ' : ''}${planText(st) || esc(SOURCE_ZH[st.source] ?? st.source)}<div class="k">${extra}${stats}</div>`;
        }
      }

      $('seats').innerHTML = seatRows(sched, follow, god);
      const llm = $('llm');
      if (poolStats) {
        llm.innerHTML = poolStats.l3
          ? `<span class="bad">大模型已熔断（${esc(poolStats.l3)}）· 本局改用启发式</span>`
          : `大模型调用 ${poolStats.total} / ${cfg.ai.maxCallsPerGame}${poolStats.repairs ? ` · 修复 ${poolStats.repairs}` : ''}`;
      } else {
        llm.textContent = '';
      }
      $('speeds').innerHTML = speedButtons(sched);
      top.querySelector('[data-a="skip"]').classList.toggle('on', sched.skipAnim);
      top.querySelector('[data-a="pause"]').classList.toggle('on', sched.paused);
      top.querySelector('[data-a="pause"]').textContent = sched.paused ? '继续' : '暂停';
      $('mapping').textContent = `映射：${MAPPINGS[mapping].label}`;
      $('spectate').hidden = !(sched.spectating && !s.ended && !sched.fast);

      const hint = $('hint');
      const wf = sched.waitingFor.filter((i) => i !== sched.playerSeat).map((i) => SEAT_NAMES[i]);
      if (s.ended) hint.textContent = '';
      else if (sched.waitingFor.length && waitMs > 300) {
        hint.innerHTML = sched.waitingFor.includes(sched.playerSeat) && !wf.length ? '等你的脚本返回…' : `等待 ${wf.join('、')} 规划…`;
      } else if (!active) hint.textContent = '观战中 · 点右下名牌切换镜头跟随 · 拖拽平移 · 滚轮缩放';
      else if (!sched.manual) hint.textContent = `你的 ${seats[sched.playerSeat]?.label ?? 'Agent'} 正在代打 · 拖拽平移 · 滚轮缩放 · Esc 设置`;
      else {
        const m = MAPPINGS[mapping];
        const arrows = `↑${m.up} →${m.right} ↓${m.down} ←${m.left}`;
        hint.innerHTML = `${waitMs > 600 ? `<b class="you">${dot(sched.playerSeat)}轮到你</b> · ` : ''}方向键 / WASD（${arrows}）· Q E C Z 斜向 · 空格原地等 · 按住连走`;
      }
      hint.hidden = !hint.textContent;
    },

    /** 事件播报（拾取全局广播，SPEC §6.1）。 */
    onTurn(last) {
      const add = (html) => {
        const li = el('li', '', `<span class="t">T${last.n}</span>${html}`);
        feed.prepend(li);
        while (feed.children.length > 5) feed.lastChild.remove();
      };
      for (const e of last.events) {
        if (e.type === 'pickup') add(`${dot(e.seat)}${SEAT_NAMES[e.seat]} 拾取 ${img(e.color, 'gs')}${GEM_NAMES[e.color]}`);
        else if (e.type === 'chest') add(`${dot(e.seat)}${SEAT_NAMES[e.seat]} 开宝箱：${e.kind === 'score' ? `+${e.value} 分` : `+${e.gained} 体力`}`);
        else if (e.type === 'escaped') add(`${dot(e.seat)}${SEAT_NAMES[e.seat]} 到达出口`);
        else if (e.type === 'failed') add(`${dot(e.seat)}${SEAT_NAMES[e.seat]} 出局（${e.reason === 'stamina' ? '体力耗尽' : '回合上限'}）`);
        else if (e.type === 'gemRespawn') add(`第 ${e.generation} 代宝石刷新`);
        else if (e.type === 'chestRespawn') add('宝箱重生');
      }
    },

    /** 脚本 api.log 输出。 */
    scriptLog(turn, lines) {
      if (!consoleEl) return;
      for (const l of lines) {
        const li = el('li', '', `<span class="t">T${turn}</span>${esc(l)}`);
        consoleEl.prepend(li);
      }
      while (consoleEl.children.length > 6) consoleEl.lastChild.remove();
    },

    /** 脚本异常 / 降级事件。 */
    agentEvent(e) {
      if (e.type === 'hard' || e.type === 'soft') {
        agentNotes[e.type]++;
        if (consoleEl) {
          consoleEl.prepend(el('li', 'err', `<span class="t">T${e.turn}</span>${e.type === 'hard' ? '硬异常' : '软异常'}：${esc(e.error)}`));
          while (consoleEl.children.length > 6) consoleEl.lastChild.remove();
        }
      } else if (e.type === 'degrade') {
        this.toast(`${e.level} 降级：${e.reason}`, 3200);
      }
      lastKey = '';
    },

    toast(text, ms = 1600) {
      const t = $('toast');
      t.textContent = text;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    },

    /**
     * @param {object|null} poolStats
     * @param {{report:object, usage:{calls:number, failed:number, in:number, out:number}, label:string}|null} [mine]
     *   玩家自己的 AI 的思路执行报告（05 §8.3）
     */
    showEnd(sched, poolStats, mine = null) {
      const s = sched.state;
      const T = cfg.treasure;
      const rows = rankActors(s.actors, cfg);
      const champ = rows.filter((r) => r.champion).map((r) => SEAT_NAMES[r.seat]);
      compareLine = mine ? '对比：用同一张图、同样的对手跑一遍启发式代打…' : '';
      end.innerHTML = frame(`
        <h2>对局结束 · 第 ${s.endTurn} 回合</h2>
        <p class="k">${champ.length ? `冠军：${champ.join('、')}${champ.length > 1 ? '（并列）' : ''}` : '无人到达出口，冠军空缺'} · 种子 ${esc(sched.match.seed)}${poolStats ? ` · 大模型调用 ${poolStats.total} 次${poolStats.l3 ? `（熔断：${esc(poolStats.l3)}）` : ''}` : ''}</p>
        <table><tr><th>名次</th><th>角色</th><th>通道</th><th>状态</th><th>分数</th><th>构成</th><th>剩余体力</th></tr>
        ${rows.map((r) => {
          const a = s.actors[r.seat];
          const sinfo = seats[r.seat];
          return `<tr class="${r.seat === sched.playerSeat ? 'me' : ''}"><td>${r.place}${r.champion ? ' ★' : ''}</td><td>${dot(r.seat)}${SEAT_NAMES[r.seat]}</td>
            <td class="k">${sinfo ? `${esc(sinfo.label)}${sinfo.persona ? ` · ${esc(sinfo.persona)}` : ''}` : ''}</td>
            <td>${r.status === 'escaped' ? `到达（T${a.escapedTurn}）` : a.failReason === 'stamina' ? '体力耗尽' : '回合上限'}</td>
            <td><b>${r.score}</b></td><td class="k">宝石 ${gemTotal(a.gems) * T.gemScore} + 成套 ${T.setBonus * setsOf(a.gems)} + 宝箱 ${a.chestScore}</td><td>${r.stamina}</td></tr>`;
        }).join('')}</table>
        ${mine ? reportHtml(mine) : ''}
        <div class="btns"><button class="btn" data-a="verify">校验严格回放</button><button class="btn" data-a="download">下载记录 JSONL</button>
          <button class="btn" data-a="same">同一张图再来</button><button class="btn" data-a="setup">改设置</button><button class="btn brass" data-a="again">再来一局（N）</button></div>
        <div class="k" data-k="verify"></div>
        <div class="k sync" data-k="sync">${esc(syncLine)}</div>`, 'lg');
      end.hidden = false;
      lastKey = '';
    },

    /** 结算卡上「与启发式代打对比」一行（main 算完后填）。 */
    setCompare(text) {
      compareLine = text || '';
      const el = end.querySelector('[data-k="compare"]');
      if (el) el.textContent = compareLine;
    },

    /** 用服务器账本替换报告里的用量（{calls, in, out}；failed 沿用客户端统计）。 */
    setUsage(mine, server) {
      const el = end.querySelector('[data-k="usage"]');
      if (!el || !mine) return;
      mine.usage = { ...mine.usage, calls: server.calls, in: server.in, out: server.out, server: true };
      el.innerHTML = usageText(mine.usage, mine.report);
    },

    /** 记录上传状态（06 §3.1），结算卡上一行。 */
    syncStatus(text) {
      syncLine = text || '';
      const el = end.querySelector('[data-k="sync"]');
      if (el) el.textContent = syncLine;
    },

    hideEnd() {
      end.hidden = true;
      lastKey = '';
    },
  };
}
