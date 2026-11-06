// 视野与记忆（SPEC §6.1）：state.memory[i][j] = [x, y, turn] | null —— 座位 i 记得座位 j 最后一次被确知的位置与回合。
// 规则（cfg.vision.mode，2026-11-06 实验，缺省 radius = 现行）：
//   radius   切比雪夫 entityRadius 内实时可见；视野外保留最后目击，永不清除
//   full     所有在场对手实时可见（意图仍不公开）
//   delayed  视野内实时；视野外每回合更新为 delayTurns 回合前的真实位置（state.trail 保存最近 delayTurns+1 回合的位置）
//   radar    视野内实时；每 radarEvery 回合末全员互相得知当前位置
// 拾取 / 开箱广播（所有规则都有）：所有人得知该角色此刻的位置。
// 只有 delayed 往状态里加 trail；其余规则的状态与旧版逐字节相同（stateHash / 旧记录不受影响）。

import { cheb } from './geom.js';

export const visionModeOf = (cfg) => cfg.vision.mode ?? 'radius';
/** 实时可见半径（full = 无限）。 */
export const sightRadius = (cfg) => (visionModeOf(cfg) === 'full' ? Infinity : cfg.vision.entityRadius);

export function canSee(a, b, R) {
  return cheb(a.x, a.y, b.x, b.y) <= R;
}

/** 回合末：每个在场角色记下视野内的其他在场角色。 */
export function refreshMemory(state, R, turn) {
  const A = state.actors;
  for (let i = 0; i < A.length; i++) {
    if (A[i].status !== 'active') continue;
    for (let j = 0; j < A.length; j++) {
      if (j === i || A[j].status !== 'active') continue;
      if (canSee(A[i], A[j], R)) state.memory[i][j] = [A[j].x, A[j].y, turn];
    }
  }
}

/** 记忆只往新里更新（拾取广播的位置比延迟位置新时不被覆盖）。 */
function remember(state, i, j, entry) {
  const m = state.memory[i][j];
  if (!m || m[2] < entry[2]) state.memory[i][j] = entry.slice();
}

/** delayed 用：开局建 trail（每座位最近 delayTurns+1 回合的 [x, y, turn]）。 */
export function initTrail(state, cfg) {
  if (visionModeOf(cfg) === 'delayed') state.trail = state.actors.map(() => []);
}

/**
 * 回合末（以及开局 turn = 0）按规则刷新所有人的记忆。radius 时与旧版 refreshMemory 完全一致。
 */
export function refreshVision(state, cfg, turn) {
  const mode = visionModeOf(cfg);
  refreshMemory(state, sightRadius(cfg), turn);
  const A = state.actors;
  if (mode === 'radar') {
    if (turn % cfg.vision.radarEvery !== 0) return;
    for (let i = 0; i < A.length; i++) {
      if (A[i].status !== 'active') continue;
      for (let j = 0; j < A.length; j++) if (j !== i && A[j].status === 'active') remember(state, i, j, [A[j].x, A[j].y, turn]);
    }
  } else if (mode === 'delayed') {
    const D = cfg.vision.delayTurns;
    for (let j = 0; j < A.length; j++) {
      if (A[j].status !== 'active') continue;
      const t = state.trail[j];
      t.push([A[j].x, A[j].y, turn]);
      if (t.length > D + 1) t.splice(0, t.length - (D + 1));
    }
    for (let i = 0; i < A.length; i++) {
      if (A[i].status !== 'active') continue;
      for (let j = 0; j < A.length; j++) {
        if (j === i || A[j].status !== 'active') continue;
        const t = state.trail[j];
        if (t.length) remember(state, i, j, t[0]); // t[0] = turn − D 回合（开局前几回合不足 D 时取最早的）
      }
    }
  }
}

/** 拾取 / 开箱广播：所有人都得知该角色此刻的位置。 */
export function broadcastPosition(state, seat, turn) {
  const a = state.actors[seat];
  for (let i = 0; i < state.actors.length; i++) {
    if (i !== seat) state.memory[i][seat] = [a.x, a.y, turn];
  }
}
