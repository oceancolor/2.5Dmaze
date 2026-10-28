// 场景实体（纯函数，不碰 Canvas）：某回合「该画什么」。渲染、L11 消除时机断言、J01 观察同源都从这里取。
//
// 视角（view）：{ viewer: 座位号, god: bool }。
//   - 玩家在场时 god=false：对手只在玩家观察里可见时画真身，否则在「最后目击位置」画幽灵 + 已过回合数（SPEC §6.1/§6.2：
//     手动 UI 与 AI 用同一份观察，任何通道拿不到超出它的信息）。宝石 / 宝箱位置全公开。
//   - 玩家结算后（观战）与回放 god=true：全部真身。
//
// 一回合的过渡（prev → next）分两段进度：
//   uMove ∈ [0,1]：移动动画进度（落地时刻 LAND）。被拾取的宝石 / 被开的宝箱在落地前仍在，落地即消失；重生的落地后出现。
//   uEnd  ∈ [0,1]：整回合进度。本回合到达 / 出局者在 uEnd < 1 时播离场演出，uEnd = 1 时已不在场。
//   uMove = uEnd = 1 的结果与 settledEntities(next) 完全一致（tests/scene.test.mjs 逐回合断言）。

import { observe } from '../core/observe.js';

/** 一步内的落地时刻：蓄力 2 拍不动、腾空 3 拍完成位移（共 8 拍，第 7 拍末落地）。 */
export const LAND = 0.875;

/** 位移进度：u ∈ [0,1) → [0,1]，smoothstep。 */
export function moveProgress(u) {
  const p = Math.min(1, Math.max(0, (u - 0.25) / (LAND - 0.25)));
  return p * p * (3 - 2 * p);
}

const MOVE_SEQ = [['MOVE', 0, 2], ['MOVE', 1, 1], ['MOVE', 2, 1], ['MOVE', 3, 1], ['MOVE', 0, 1], ['IDLE', 0, 2]];
/** 每拍的腾空高度（px @1×）。 */
export const HOP = Object.freeze([0, 1.5, 3.5, 2, 0, 0]);

/** 一步内的拍：u ∈ [0,1) → {state, frame, beat}（hold 2-1-1-1-1-2，共 8 单位）。 */
export function moveBeat(u) {
  let k = Math.max(0, u) * 8;
  for (let b = 0; b < MOVE_SEQ.length; b++) {
    if (k < MOVE_SEQ[b][2]) return { state: MOVE_SEQ[b][0], frame: MOVE_SEQ[b][1], beat: b };
    k -= MOVE_SEQ[b][2];
  }
  return { state: 'IDLE', frame: 0, beat: MOVE_SEQ.length - 1 };
}

const VIEWS = new WeakMap();

/** 每个座位在该视角下画什么：{show:'actor'|'ghost', x, y, turnsSince?} | null。按 (state, 视角) 缓存。 */
export function actorViews(map, state, cfg, view) {
  const key = view.god ? 'god' : `v${view.viewer}`;
  let m = VIEWS.get(state);
  if (!m) {
    m = new Map();
    VIEWS.set(state, m);
  }
  if (m.has(key)) return m.get(key);
  const A = state.actors;
  const out = new Array(A.length).fill(null);
  if (view.god) {
    A.forEach((a, i) => {
      if (a.status === 'active') out[i] = { show: 'actor', x: a.x, y: a.y };
    });
  } else {
    const me = A[view.viewer];
    if (me.status === 'active') out[view.viewer] = { show: 'actor', x: me.x, y: me.y };
    const obs = observe(map, state, view.viewer, cfg, { patch: false });
    for (const o of obs.actors) {
      if (o.status !== 'active') continue;
      if (o.visible) out[o.seat] = { show: 'actor', x: o.x, y: o.y };
      else if (o.lastSeen) out[o.seat] = { show: 'ghost', x: o.lastSeen.x, y: o.lastSeen.y, turnsSince: o.lastSeen.turnsSince };
    }
  }
  m.set(key, out);
  return out;
}

const gemKey = (g) => `${g.c}:${g.x}:${g.y}`;

/** 结算后的静止画面。 */
export function settledEntities(map, cfg, state, view) {
  const out = [];
  for (const g of state.gems) out.push({ kind: 'gem', c: g.c, x: g.x, y: g.y });
  if (state.chest.present) out.push({ kind: 'chest', x: state.chest.x, y: state.chest.y });
  actorViews(map, state, cfg, view).forEach((v, seat) => {
    if (!v) return;
    if (v.show === 'actor') out.push({ kind: 'actor', seat, from: [v.x, v.y], to: [v.x, v.y], p: 1, uMove: 1, moved: false, blocked: false, leaving: null, dir: null });
    else out.push({ kind: 'ghost', seat, x: v.x, y: v.y, turnsSince: v.turnsSince });
  });
  return out;
}

/**
 * 过渡中的画面。last = 调度器的回合结果 {prev, next, events, dirs, moved}。
 * 角色条目带 from/to/p（位移进度）/moved/blocked/leaving/dir（本回合朝向，null = 沿用）。
 */
export function transitionEntities(map, cfg, last, view, uMove, uEnd) {
  if (uEnd >= 1) return settledEntities(map, cfg, last.next, view);
  const { prev, next, events, dirs, moved } = last;
  const landed = uMove >= LAND;
  const out = [];

  const nextGems = new Set(next.gems.map(gemKey));
  const prevGems = new Set(prev.gems.map(gemKey));
  for (const g of prev.gems) if (nextGems.has(gemKey(g)) || !landed) out.push({ kind: 'gem', c: g.c, x: g.x, y: g.y });
  if (landed) for (const g of next.gems) if (!prevGems.has(gemKey(g))) out.push({ kind: 'gem', c: g.c, x: g.x, y: g.y });

  const pc = prev.chest;
  const nc = next.chest;
  const same = pc.present && nc.present && pc.x === nc.x && pc.y === nc.y;
  if (same || (pc.present && !landed)) out.push({ kind: 'chest', x: pc.x, y: pc.y });
  else if (nc.present && landed) out.push({ kind: 'chest', x: nc.x, y: nc.y });

  const vp = actorViews(map, prev, cfg, view);
  const vn = actorViews(map, next, cfg, view);
  const blockedSeat = new Set();
  const bumpDir = new Map();
  for (const e of events) {
    if (e.type === 'blocked') blockedSeat.add(e.seat);
    else if (e.type === 'bump') bumpDir.set(e.seat, e.dir);
  }
  const p = moveProgress(uMove);
  for (let i = 0; i < prev.actors.length; i++) {
    const a0 = prev.actors[i];
    const a1 = next.actors[i];
    if (a0.status !== 'active') continue;
    const dir = moved[i] || blockedSeat.has(i) ? dirs[i] : bumpDir.has(i) ? bumpDir.get(i) : null;
    const base = { kind: 'actor', seat: i, p, uMove, moved: Boolean(moved[i]), blocked: blockedSeat.has(i) || bumpDir.has(i), dir };
    if (a1.status !== 'active') {
      // 本回合离场：只有本回合开始时看得见的才演
      if (vp[i] && vp[i].show === 'actor') out.push({ ...base, from: [a0.x, a0.y], to: [a1.x, a1.y], leaving: a1.status, uEnd });
      continue;
    }
    const v1 = vn[i];
    if (!v1) continue;
    if (v1.show === 'actor') {
      const seen = vp[i] && vp[i].show === 'actor';
      out.push({ ...base, from: seen ? [a0.x, a0.y] : [a1.x, a1.y], to: [a1.x, a1.y], leaving: null, moved: seen && base.moved });
    } else {
      out.push({ kind: 'ghost', seat: i, x: v1.x, y: v1.y, turnsSince: v1.turnsSince });
    }
  }
  return out;
}
