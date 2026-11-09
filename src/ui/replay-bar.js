// 回放控制条（2026-11-09）：播放 / 暂停、倍速、进度条拖动、上 / 下一个决策、退出；左侧决策栏（有复盘时间线时）。
// 只管自己的 DOM 与样式（game.css「回放」一段），通过回调和 main 通信；对局画面、HUD、小地图都是正常对局那一套。

import { esc } from './hud.js';
import { outcomeText, targetLabel, whyText } from '../ai/harness.js';

const SPEEDS = [1, 2, 4];

/**
 * @param {HTMLElement} root
 * @param {{title:string, endTurn:number, entries?:object[], onToggle:()=>void, onSpeed:(v:number)=>void, onSeek:(turn:number)=>void, onExit:()=>void}} o
 */
export function createReplayBar(root, o) {
  const entries = (o.entries || []).filter((e) => e.target || e.outcome);
  const bar = document.createElement('div');
  bar.className = 'replaybar';
  bar.innerHTML = `<div class="rb-row">
      <b class="rb-title">回放 · ${esc(o.title)}</b><span class="sp"></span>
      <button class="btn mini" data-r="prev" title="上一个决策（[）">◀ 决策</button>
      <button class="btn mini" data-r="toggle" title="播放 / 暂停（P）">暂停</button>
      <button class="btn mini" data-r="next" title="下一个决策（]）">决策 ▶</button>
      ${SPEEDS.map((v) => `<button class="btn mini" data-r="speed" data-v="${v}">${v}×</button>`).join('')}
      <button class="btn mini" data-r="exit">退出回放</button>
    </div>
    <div class="rb-row"><span class="rb-turn" data-r="turn">T1</span>
      <input type="range" min="1" max="${o.endTurn}" value="1" step="1" data-r="seek" aria-label="回合进度">
      <span class="k">${o.endTurn} 回合</span></div>`;
  const panel = document.createElement('div');
  panel.className = 'replaypanel';
  panel.hidden = !entries.length;
  panel.innerHTML = `<div class="rp-head">决策 · ${entries.length} 条 <span class="k">点击跳到那一刻</span></div>
    <ol class="rp-list">${entries.map((e, k) => `<li data-k="${k}" data-n="${e.n}"><span class="t">T${e.n}</span>
      <span class="w">${esc(e.src === 'queue' ? '队列' : e.src === 'guard' ? '闸门' : whyText(e.why) || '')}</span>
      <b>${esc(e.target ? targetLabel(e) : '—')}</b>${e.reason ? `<span class="r">「${esc(e.reason)}」</span>` : ''}
      ${e.memo ? `<span class="m">备忘：${esc(e.memo)}</span>` : ''}
      <span class="o ${e.outcome || ''}">→ ${esc(outcomeText(e))}</span></li>`).join('')}</ol>`;
  root.append(bar, panel);
  root.classList.add('replaying');

  const $ = (k) => bar.querySelector(`[data-r="${k}"]`);
  const seek = $('seek');
  let dragging = false;
  const stops = [...new Set(entries.map((e) => e.n))].sort((a, b) => a - b);
  let curTurn = 1;

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const r = b.dataset.r;
    if (r === 'toggle') o.onToggle();
    else if (r === 'speed') o.onSpeed(Number(b.dataset.v));
    else if (r === 'exit') o.onExit();
    else if (r === 'prev') jump(-1);
    else if (r === 'next') jump(1);
  });
  seek.addEventListener('input', () => {
    dragging = true;
    $('turn').textContent = `T${seek.value}`;
  });
  seek.addEventListener('change', () => {
    dragging = false;
    o.onSeek(Number(seek.value));
  });
  panel.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-n]');
    if (li) o.onSeek(Number(li.dataset.n));
  });

  function jump(dir) {
    if (!stops.length) return;
    const t = dir > 0 ? stops.find((n) => n > curTurn) : [...stops].reverse().find((n) => n < curTurn - 1);
    o.onSeek(t ?? (dir > 0 ? o.endTurn : 1));
  }

  let lastActive = -1;
  return {
    jump,
    /** 每帧调用。 */
    update({ turn, paused, speed, ended }) {
      curTurn = turn;
      if (!dragging) {
        seek.value = String(Math.min(turn, o.endTurn));
        $('turn').textContent = ended ? `T${o.endTurn} · 结束` : `T${turn}`;
      }
      const tg = $('toggle');
      const label = ended ? '从头播' : paused ? '播放' : '暂停';
      if (tg.textContent !== label) tg.textContent = label;
      bar.querySelectorAll('[data-r="speed"]').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === speed));
      // 决策栏：高亮最近一条已生效的决策
      let k = -1;
      for (let i = 0; i < entries.length; i++) if (entries[i].n <= turn) k = i;
      if (k !== lastActive) {
        panel.querySelectorAll('li.on').forEach((li) => li.classList.remove('on'));
        const li = panel.querySelector(`li[data-k="${k}"]`);
        if (li) {
          li.classList.add('on');
          li.scrollIntoView({ block: 'nearest' });
        }
        lastActive = k;
      }
    },
    dispose() {
      bar.remove();
      panel.remove();
      root.classList.remove('replaying');
    },
  };
}
