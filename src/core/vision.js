// 视野与记忆（SPEC §6.1）：对手位置只在切比雪夫 R 内可见；视野外保留最后目击，永不清除。
// state.memory[i][j] = [x, y, turn] | null

import { cheb } from './geom.js';

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

/** 拾取 / 开箱广播：所有人都得知该角色此刻的位置。 */
export function broadcastPosition(state, seat, turn) {
  const a = state.actors[seat];
  for (let i = 0; i < state.actors.length; i++) {
    if (i !== seat) state.memory[i][seat] = [a.x, a.y, turn];
  }
}
