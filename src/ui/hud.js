// HUD（SPEC §10、03 §3.10）：DOM/CSS，不占 canvas 预算。四角分区，不压视口中心 40%。
//   左上 分数 + 回合（下挂事件播报） · 右上 倍速 / 时长常驻读数 + 体力 + 回家成本 + 出口罗盘
//   左下 本人宝石 + 剩余代数 + 宝箱 · 右下 四人公开信息（分数 / 体力 / 各色 / 成套）
//   顶部中间 工具条（倍速三档带各自预计时长 / 跳过动画 / 暂停 / 缩放 / 方向映射）· 底部中间 操作提示 / 输入丢弃提示
// 只读调度器与观察；所有操作经回调交给 main。

import { ACTOR_COLORS, GEM_KEYS, GEM_NAMES, staminaTier } from '../render/palette.js';
import { tileCenter } from '../render/iso.js';
import { fieldFrom } from '../core/nav/bfs.js';
import { rankActors, scoreOf, setsOf, gemTotal } from '../core/scoring.js';
import { estimateTurnsLeft, estimateSeconds } from '../app/scheduler.js';
import { MAPPINGS } from '../player/input.js';

export const SEAT_NAMES = Object.freeze(['你', 'AI-A', 'AI-B', 'AI-C']);
const HOME_COLORS = { ok: '#3FBF6A', warn: '#F2CE3B', bad: '#E8384F' };

/** 回家成本三档（SPEC §10）：绿 s ≥ 1.3d · 黄 d ≤ s < 1.3d · 红 s < d（整数比较）。 */
export function homeTier(stamina, dist, factorX10 = 13) {
  if (stamina * 10 >= dist * factorX10) return 'ok';
  if (stamina >= dist) return 'warn';
  return 'bad';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dot = (seat) => `<i class="dot" style="--c:${ACTOR_COLORS[seat]}"></i>`;

function el(tag, cls, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

/**
 * @param {HTMLElement} root
 * @param {{cfg:object, atlas:object, actions:object}} o
 *   actions: setSpeed(s) · toggleSkipAnim() · togglePause() · zoomBy(k) · recenter() · toggleMapping() · skipToEnd()
 *            follow(seat) · newMatch(seed?) · verify() → string · download()
 */
export function createHud(root, { cfg, atlas, actions }) {
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

  tl.innerHTML = `<div class="panel"><div class="in score-row">
      <div><div class="k">分数</div><div class="big" data-k="score">0</div></div>
      <div><div class="k">回合</div><div class="big"><span data-k="turn">1</span><small> / ${cfg.rules.maxTurns}</small></div></div>
    </div></div><ul class="feed"></ul>`;
  tr.innerHTML = `<div class="speed" data-k="speed"></div>
    <div class="panel"><div class="in">
      <div class="row"><span class="k">体力</span><b data-k="stamina"></b><span class="sp"></span>
        <span class="home"><i class="hdot" data-k="hdot"></i>回家 <b data-k="home"></b> 步</span>
        <span class="compass" data-k="compass" title="出口方向"><svg viewBox="-10 -10 20 20" width="20" height="20"><path d="M0-8 L6 6 L0 3 L-6 6Z"/></svg></span></div>
      <div class="bar" data-k="bar"><i></i><i></i><i></i><i></i></div>
      <div class="note" data-k="note"></div>
    </div></div>`;
  bl.innerHTML = `<div class="panel"><div class="in">
      <div class="k" data-k="gemhead"></div>
      <div class="gems" data-k="gems"></div>
      <div class="k sub" data-k="chest"></div>
    </div></div>`;
  br.innerHTML = '<div class="panel"><div class="in seats" data-k="seats"></div></div>';
  top.innerHTML = `<div class="bar-tools">
      <span class="seg" data-k="speeds"></span>
      <button data-a="skip" title="跳过动画（0）">跳过动画</button>
      <button data-a="pause" title="暂停（P）">暂停</button>
      <span class="seg"><button data-a="zout" title="缩小（-）">－</button><button data-a="zin" title="放大（=）">＋</button></span>
      <button data-a="center" title="镜头回到自己（F）">归位</button>
      <button data-a="map" title="方向映射（M）" data-k="mapping"></button>
      <button data-a="new" title="换一张图（N）">新局</button>
    </div>
    <div class="spectate" data-k="spectate" hidden>你已结算 · 观战中 <button data-a="toend">跳到结算（Enter）</button></div>`;
  bottom.innerHTML = '<div class="toast" data-k="toast" hidden></div><div class="hint" data-k="hint"></div>';

  const $ = (k) => root.querySelector(`[data-k="${k}"]`);
  const feed = tl.querySelector('.feed');

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
    else if (a === 'new') actions.newMatch();
    else if (a === 'toend') actions.skipToEnd();
    else if (a === 'again') actions.newMatch();
    else if (a === 'same') actions.newMatch('same');
    else if (a === 'verify') root.querySelector('[data-k="verify"]').textContent = actions.verify();
    else if (a === 'download') actions.download();
    if (b.dataset.follow !== undefined) actions.follow(Number(b.dataset.follow));
  });

  let lastKey = '';
  let toastTimer = 0;
  let exitField = null;
  let fieldMap = null;

  function speedButtons(sched) {
    const left = estimateTurnsLeft(sched.map, sched.state);
    return cfg.motion.speeds.map((s) => {
      const on = sched.speed === s && !sched.skipAnim ? ' on' : '';
      return `<button class="${on}" data-speed="${s}" title="${s}×（${cfg.motion.speeds.indexOf(s) + 1}）">${s}× <small>${estimateSeconds(left, cfg, s)}s</small></button>`;
    }).join('');
  }

  function seatRows(sched, follow) {
    const s = sched.state;
    const ranks = new Map(rankActors(s.actors, cfg).map((r) => [r.seat, r]));
    return s.actors.map((a, i) => {
      const r = ranks.get(i);
      const chip = a.status === 'escaped' ? `<em class="chip ok">到达 T${a.escapedTurn}</em>`
        : a.status === 'failed' ? `<em class="chip bad">${a.failReason === 'stamina' ? '体力耗尽' : '超时'}</em>`
          : `<em class="chip">体力 ${a.stamina}</em>`;
      const gems = a.gems.map((nc, c) => `<span class="${nc ? '' : 'zero'}">${img(c, 'gs')}${nc}</span>`).join('');
      const me = i === sched.playerSeat ? ' me' : '';
      const fol = sched.spectating && i === follow ? ' fol' : '';
      return `<button class="seat${me}${fol}" data-follow="${i}" title="${sched.spectating ? '镜头跟随' : ''}">
        <span class="nm">${dot(i)}${SEAT_NAMES[i]}${r.champion ? ' 🏆' : ''}</span>${chip}<b class="sc">${scoreOf(a, cfg)}</b>
        <span class="mini">${gems}<span class="sets">套×${setsOf(a.gems)}</span></span></button>`;
    }).join('');
  }

  return {
    /** 每帧调用；只在可见量变化时改 DOM。 */
    update(sched, { follow, mapping, zoomIndex, waitMs, quality }) {
      const s = sched.state;
      const me = s.actors[sched.playerSeat];
      const key = [s.turn, s.ended, sched.speed, sched.skipAnim, sched.paused, sched.spectating, follow, mapping, zoomIndex, waitMs > 600, quality].join('|');
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
      $('speed').textContent = sched.paused ? '已暂停'
        : sched.skipAnim ? '跳过动画 · 预计 0 秒'
          : `${sched.speed}× · 预计 ${estimateSeconds(left, cfg, sched.speed)} 秒`;

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

      $('seats').innerHTML = seatRows(sched, follow);
      $('speeds').innerHTML = speedButtons(sched);
      top.querySelector('[data-a="skip"]').classList.toggle('on', sched.skipAnim);
      top.querySelector('[data-a="pause"]').classList.toggle('on', sched.paused);
      top.querySelector('[data-a="pause"]').textContent = sched.paused ? '继续' : '暂停';
      $('mapping').textContent = `映射：${MAPPINGS[mapping].label}`;
      $('spectate').hidden = !(sched.spectating && !s.ended);

      const hint = $('hint');
      if (s.ended) hint.textContent = '';
      else if (!active) hint.textContent = '观战中 · 点右下名牌切换镜头跟随 · 拖拽平移 · 滚轮缩放';
      else {
        const m = MAPPINGS[mapping];
        const arrows = `↑${m.up} →${m.right} ↓${m.down} ←${m.left}`;
        hint.innerHTML = `${waitMs > 600 ? `<b class="you">${dot(sched.playerSeat)}轮到你</b> · ` : ''}方向键 / WASD 移动（${arrows}）· Q E C Z 斜向 · 空格原地等 · 按住连走`;
      }
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

    toast(text, ms = 1600) {
      const t = $('toast');
      t.textContent = text;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    },

    showEnd(sched) {
      const s = sched.state;
      const T = cfg.treasure;
      const rows = rankActors(s.actors, cfg);
      const champ = rows.filter((r) => r.champion).map((r) => SEAT_NAMES[r.seat]);
      end.innerHTML = `<div class="panel"><div class="in">
        <h2>对局结束 · 第 ${s.endTurn} 回合</h2>
        <p class="k">${champ.length ? `冠军：${champ.join('、')}${champ.length > 1 ? '（并列）' : ''}` : '无人到达出口，冠军空缺'} · 种子 ${esc(sched.match.seed)}</p>
        <table><tr><th>名次</th><th>角色</th><th>状态</th><th>分数</th><th>构成</th><th>剩余体力</th></tr>
        ${rows.map((r) => {
          const a = s.actors[r.seat];
          return `<tr class="${r.seat === sched.playerSeat ? 'me' : ''}"><td>${r.place}${r.champion ? ' 🏆' : ''}</td><td>${dot(r.seat)}${SEAT_NAMES[r.seat]}</td>
            <td>${r.status === 'escaped' ? `到达（T${a.escapedTurn}）` : a.failReason === 'stamina' ? '体力耗尽' : '回合上限'}</td>
            <td><b>${r.score}</b></td><td class="k">宝石 ${gemTotal(a.gems) * T.gemScore} + 成套 ${T.setBonus * setsOf(a.gems)} + 宝箱 ${a.chestScore}</td><td>${r.stamina}</td></tr>`;
        }).join('')}</table>
        <div class="btns"><button data-a="verify">校验严格回放</button><button data-a="download">下载记录 JSONL</button>
          <button data-a="same">同一张图再来</button><button data-a="again" class="primary">再来一局（N）</button></div>
        <div class="k" data-k="verify"></div>
      </div></div>`;
      end.hidden = false;
      lastKey = '';
    },

    hideEnd() {
      end.hidden = true;
      feed.innerHTML = '';
      lastKey = '';
    },
  };
}
