// 移动仲裁（SPEC §4）。结果与座位顺序无关。前置：dirs 已合法化（目标在界内且为地板）。
//   ① 同格冲突：≥2 个 mover 目标相同 → 全部不动
//   ② 环（含长度 2 的对穿）：环上全员不动（网格二着色 → 环长必为偶数，无 3 人环分支）
//   ③ 迭代到不动点：目标被本回合不动者占据 → 不动
//   ④ 其余同时位移（链式让位允许）

import { DX, DY, STAY } from './geom.js';

/**
 * @param {number[]} pos 各座位格索引，-1 = 不在场
 * @param {number[]} dirs 0..4
 * @param {number} size
 * @returns {{moved:boolean[], target:number[], reason:string[]}}
 *   reason ∈ moved | stay | off | contest | cycle | blocked
 */
export function arbitrate(pos, dirs, size) {
  const n = pos.length;
  const moving = new Array(n);
  const target = new Array(n);
  const reason = new Array(n);
  for (let i = 0; i < n; i++) {
    moving[i] = pos[i] >= 0 && dirs[i] !== STAY;
    target[i] = moving[i] ? pos[i] + DX[dirs[i]] + DY[dirs[i]] * size : pos[i];
    reason[i] = pos[i] < 0 ? 'off' : moving[i] ? null : 'stay';
  }

  // ① 同格冲突
  for (let i = 0; i < n; i++) {
    if (!moving[i]) continue;
    for (let j = 0; j < n; j++) {
      if (j !== i && moving[j] && target[j] === target[i]) { reason[i] = 'contest'; break; }
    }
  }

  // ② 环：先算出所有环成员，再统一标记（边标记边查会漏掉同环后续成员）
  const alive = (i) => moving[i] && reason[i] === null;
  const nextOf = (i) => {
    for (let j = 0; j < n; j++) if (j !== i && alive(j) && pos[j] === target[i]) return j;
    return -1;
  };
  const onCycle = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!alive(i)) continue;
    let cur = i;
    for (let k = 0; k < n; k++) {
      const j = nextOf(cur);
      if (j < 0) break;
      if (j === i) { onCycle[i] = true; break; }
      cur = j;
    }
  }
  for (let i = 0; i < n; i++) if (onCycle[i]) reason[i] = 'cycle';

  // ③ 不动点
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (!alive(i)) continue;
      for (let j = 0; j < n; j++) {
        if (j !== i && pos[j] === target[i] && !alive(j)) { reason[i] = 'blocked'; changed = true; break; }
      }
    }
  }

  // ④
  const moved = new Array(n);
  for (let i = 0; i < n; i++) {
    moved[i] = moving[i] && reason[i] === null;
    if (moved[i]) reason[i] = 'moved';
  }
  return { moved, target, reason };
}
