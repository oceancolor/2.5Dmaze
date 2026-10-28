// 动画层：把调度器的回合结果 + 当前时间翻译成本帧的绘制条目（sprite 名、偏移、透明度、程序绘制层）。
// 不碰 Canvas；renderer 只管按条目画。节奏数值取 cfg.motion（moveMs / bumpMs / pickMs / endMs），全部除以该回合的倍速。
//
// 条目：{ x, y（连续格坐标，锚点位置）, cells（遮挡判定用的端点格）, order（同格先后）, layers:[...] }
//   layer = { sprite, dy, mode, alpha, desat, ghost } | { proc:'halo'|'beam'|'badge'|'text', ... }

import { DIR_LETTERS } from './iso.js';
import { GEM_KEYS, SEAT_KEYS, ACTOR_COLORS } from './palette.js';
import { settledEntities, transitionEntities, moveBeat, HOP, LAND } from './scene.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 各状态的帧序（权重 = 03 §3.3 的帧时长比例；实际时长按 cfg.motion 缩放）。 */
const SEQ = {
  player: {
    PICK: [[0, 90], [1, 200], [2, 260]],
    BLOCK: [[0, 140], [1, 120]],
    DEAD: [[0, 160], [1, 640]],
  },
  ai: {
    PICK: [[0, 90], [1, 360]],
    BLOCK: [[0, 260]],
    DEAD: [[0, 800]],
  },
};
const IDLE_P = [[0, 420], [1, 380], [2, 380], [0, 420], [3, 120], [0, 300]];
const IDLE_A = [[0, 600], [1, 600]];
const CHEST_IDLE = [[0, 700], [1, 700]];
const CHEST_OPEN = [[4, 80], [5, 90], [6, 140], [7, 240]];

/** 循环帧序：ms → 帧号。 */
function loopFrame(seq, ms) {
  const total = seq.reduce((s, q) => s + q[1], 0);
  let r = ((ms % total) + total) % total;
  for (const [f, d] of seq) {
    if (r < d) return f;
    r -= d;
  }
  return seq[0][0];
}

/** 单次帧序按比例铺满 [0,1)：f → 帧号。 */
function onceFrame(seq, f) {
  const total = seq.reduce((s, q) => s + q[1], 0);
  let r = Math.min(Math.max(f, 0), 0.9999) * total;
  for (const [fr, d] of seq) {
    if (r < d) return fr;
    r -= d;
  }
  return seq[seq.length - 1][0];
}

const smooth = (p) => p * p * (3 - 2 * p);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createAnimator({ map, cfg, playerSeat = 0 }) {
  const M = cfg.motion;
  const n = map.spawns.length;
  const facing = new Array(n).fill('s');
  const actions = new Array(n).fill(null); // {state, start, dur}
  let fx = []; // {type, x, y, c?, start, dur, text?}

  const keyOf = (seat) => (seat === playerSeat ? 'PLAYER' : `AI${SEAT_KEYS[seat]}`);
  const kindOf = (seat) => (seat === playerSeat ? 'player' : 'ai');
  const moveDurOf = (last) => Math.min(last.duration, M.moveMs / last.speed);

  function actorLayers(ent, seat, t, el, last, quality) {
    const key = keyOf(seat);
    const kind = kindOf(seat);
    const dir = facing[seat];
    let state = 'IDLE';
    let frame = 0;
    let hop = 0;
    let sink = 0;
    let desat = 0;
    let alpha = 1;
    const act = actions[seat] && t < actions[seat].start + actions[seat].dur && t >= actions[seat].start ? actions[seat] : null;
    if (ent.moved && ent.uMove < 1) {
      const b = moveBeat(ent.uMove);
      state = b.state;
      frame = b.frame;
      hop = HOP[b.beat];
    } else if (ent.leaving === 'failed') {
      state = 'DEAD';
      frame = onceFrame(SEQ[kind].DEAD, ent.uEnd);
      const e = smooth(ent.uEnd);
      sink = 4 * e;
      desat = 0.6 * e;
    } else if (ent.blocked && ent.uMove < 1) {
      state = 'BLOCK';
      frame = onceFrame(SEQ[kind].BLOCK, ent.uMove);
    } else if (act) {
      state = act.state;
      frame = onceFrame(SEQ[kind][act.state], (t - act.start) / act.dur);
    } else {
      const slow = quality === 0 ? 2 : 1;
      frame = seat === playerSeat ? loopFrame(IDLE_P, (t / slow) + seat * 211) : loopFrame(IDLE_A, (t / slow) + seat * 137);
    }
    if (ent.leaving === 'escaped' && last) {
      const md = moveDurOf(last);
      alpha = el <= md ? 1 : 1 - smooth(clamp01((el - md) / Math.max(1, last.duration - md)));
      sink = 6 * (1 - alpha);
    }
    const layers = [];
    if (quality >= 2) {
      layers.push({ sprite: seat === playerSeat ? 'SHD_PLAYER_na_00' : 'SHD_AI_na_00', dy: 0, mode: 'raw', alpha: alpha * (1 - hop * 0.06) * (1 - sink * 0.12) });
    }
    if (seat === playerSeat && quality >= 1) layers.push({ proc: 'halo', alpha });
    layers.push({ sprite: `ACT_${key}_${state}_${dir}_${pad2(frame)}`, dy: sink - hop, mode: quality >= 1 ? 'ink' : 'raw', alpha, desat });
    return layers;
  }

  return {
    facing,

    /** 调度器 'turn'：更新朝向、排拾取演出与特效。 */
    onTurn(last) {
      for (let i = 0; i < n; i++) {
        if (last.moved[i]) facing[i] = DIR_LETTERS[last.dirs[i]];
      }
      for (const e of last.events) {
        if (e.type === 'blocked') facing[e.seat] = DIR_LETTERS[last.dirs[e.seat]];
        else if (e.type === 'bump') facing[e.seat] = DIR_LETTERS[e.dir];
      }
      if (last.skipped || last.duration <= 0) {
        fx = [];
        actions.fill(null);
        return;
      }
      const land = last.start + LAND * moveDurOf(last);
      const pick = M.pickMs / last.speed;
      fx = fx.filter((f) => f.start + f.dur > last.start);
      for (const e of last.events) {
        if (e.type === 'pickup') {
          actions[e.seat] = { state: 'PICK', start: land, dur: pick };
          fx.push({ type: 'gem', c: e.color, x: e.x, y: e.y, start: land, dur: pick });
        } else if (e.type === 'chest') {
          actions[e.seat] = { state: 'PICK', start: land, dur: pick };
          const text = e.kind === 'score' ? `+${e.value} 分` : `+${e.gained} 体力`;
          fx.push({ type: 'chest', x: e.x, y: e.y, start: land, dur: pick * 2.2, text, kind: e.kind });
        }
      }
      // 本回合动了的角色，旧的拾取演出作废（移动优先）
      for (let i = 0; i < n; i++) {
        if (last.moved[i] && actions[i] && actions[i].start < last.start) actions[i] = null;
      }
    },

    /** 调度器 'bump'（手动输入朝墙，本地反馈，不进回合）。 */
    onBump(b) {
      facing[b.seat] = DIR_LETTERS[b.dir];
      actions[b.seat] = { state: 'BLOCK', start: b.start, dur: Math.max(1, b.duration) };
    },

    /**
     * 本帧条目。
     * @param {number} t now()
     * @param {{state:object, last:object|null, view:{viewer:number, god:boolean}, quality?:number}} o
     * @returns {{items:object[], pos:(number[]|null)[]}} pos = 各座位本帧的连续格坐标（镜头跟随 / 小地图）
     */
    frame(t, { state, last, view, quality = 2 }) {
      let ents;
      let el = 0;
      const live = last && last.duration > 0 && t < last.start + last.duration;
      if (live) {
        el = Math.max(0, t - last.start);
        ents = transitionEntities(map, cfg, last, view, clamp01(el / moveDurOf(last)), clamp01(el / last.duration));
      } else {
        ents = settledEntities(map, cfg, state, view);
      }
      const items = [];
      const pos = new Array(n).fill(null);
      for (const ent of ents) {
        if (ent.kind === 'gem') {
          const k = GEM_KEYS[ent.c];
          const f = Math.floor((t + ent.c * 90) / 150) % 4;
          const layers = quality >= 2 ? [{ sprite: `SHD_GEM_${k}_na_00`, dy: 0, mode: 'raw', alpha: 1 }] : [];
          layers.push({ sprite: `PRP_GEM_${k}_na_${pad2(f)}`, dy: 0, mode: quality >= 1 ? 'ink' : 'raw', alpha: 1 });
          items.push({ x: ent.x, y: ent.y, cells: [[ent.x, ent.y]], order: 0, layers, marker: { type: 'gem', c: ent.c } });
        } else if (ent.kind === 'chest') {
          const layers = quality >= 2 ? [{ sprite: 'SHD_CHEST_na_00', dy: 0, mode: 'raw', alpha: 1 }] : [];
          layers.push({ sprite: `PRP_CHEST_na_${pad2(loopFrame(CHEST_IDLE, t + ent.x * 31))}`, dy: 0, mode: quality >= 1 ? 'ink' : 'raw', alpha: 1 });
          items.push({ x: ent.x, y: ent.y, cells: [[ent.x, ent.y]], order: 0, layers, marker: { type: 'chest' } });
        } else if (ent.kind === 'ghost') {
          const text = ent.turnsSince > 99 ? '99+' : String(ent.turnsSince);
          items.push({
            x: ent.x, y: ent.y, cells: [[ent.x, ent.y]], order: 1,
            layers: [
              { sprite: `ACT_${keyOf(ent.seat)}_IDLE_${facing[ent.seat]}_00`, dy: 0, mode: 'ink', alpha: 1, ghost: true },
              { proc: 'badge', text },
            ],
            marker: { type: 'ghost', seat: ent.seat },
          });
        } else {
          const [x0, y0] = ent.from;
          const [x1, y1] = ent.to;
          const x = x0 + (x1 - x0) * ent.p;
          const y = y0 + (y1 - y0) * ent.p;
          pos[ent.seat] = [x, y];
          items.push({
            x, y, cells: x0 === x1 && y0 === y1 ? [[x0, y0]] : [[x0, y0], [x1, y1]], order: 2,
            layers: actorLayers(ent, ent.seat, t, el, live ? last : null, quality),
            marker: { type: 'actor', seat: ent.seat },
          });
        }
      }
      // 玩家自己的出口光柱（观战 / 回放不画）
      if (!view.god && state.actors[view.viewer].status === 'active' && quality >= 1) {
        const [ex, ey] = map.exits[view.viewer];
        items.push({ x: ex, y: ey, cells: [[ex, ey]], order: -1, layers: [{ proc: 'beam', color: ACTOR_COLORS[view.viewer] }], marker: null });
      }
      for (const f of fx) {
        if (t < f.start || t >= f.start + f.dur) continue;
        const u = (t - f.start) / f.dur;
        if (f.type === 'gem') {
          const e = smooth(u);
          items.push({
            x: f.x, y: f.y, cells: [[f.x, f.y]], order: 3,
            layers: [{ sprite: `PRP_GEM_${GEM_KEYS[f.c]}_na_00`, dy: -6 - 14 * e, mode: 'ink', alpha: 1 - e }],
            marker: null,
          });
        } else {
          const open = Math.min(1, u * 2.2);
          const fade = u < 0.7 ? 1 : 1 - smooth((u - 0.7) / 0.3);
          items.push({
            x: f.x, y: f.y, cells: [[f.x, f.y]], order: 0,
            layers: [
              { sprite: `PRP_CHEST_na_${pad2(onceFrame(CHEST_OPEN, open))}`, dy: 0, mode: 'ink', alpha: fade },
              { proc: 'text', text: f.text, kind: f.kind, dy: -48 - 18 * smooth(u), alpha: fade },
            ],
            marker: null,
          });
        }
      }
      return { items, pos };
    },
  };
}
