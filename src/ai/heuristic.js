// 兜底启发式 AI（SPEC §8）。输入 = 同一份观察（对手位置同样受视野限制，不全知）。
// 随机性只用于等价方向 / 解锁侧移的打破对称，来自本座位的具名 AI 流。

import { DX, DY, STAY } from '../core/geom.js';
import { STREAM, createStream, subSeed, randInt } from '../core/rng.js';
import { bfsField, fieldFrom } from '../core/nav/bfs.js';
import { setsOf } from '../core/scoring.js';

/** 回家 / 终盘区：stamina*10 <= dist*factorX10 */
export const isHome = (stamina, dist, factorX10) => stamina * 10 <= dist * factorX10;

/** 可负担：stamina ≥ d(我,t) + 1.3·d(t,出口)（整数比较） */
export const isAffordable = (stamina, dTo, dBack, marginX10) =>
  dTo >= 0 && dBack >= 0 && stamina * 10 >= dTo * 10 + dBack * marginX10;

function better(score, x, y, best) {
  if (!best) return true;
  if (score !== best.score) return score > best.score;
  if (y !== best.y) return y < best.y;
  return x < best.x;
}

/** 选目标：返回 {type,x,y} 与模式。 */
export function chooseTarget(map, obs, cfg) {
  const H = cfg.ai.heuristic;
  const T = cfg.treasure;
  const N = map.size;
  const me = obs.self;
  const exitField = fieldFrom(map, me.exit.y * N + me.exit.x);
  const home = { mode: 'home', target: { type: 'exit', x: me.exit.x, y: me.exit.y } };
  if (isHome(me.stamina, me.distToExit, cfg.ai.homeFactorX10)) return home;

  const setsNow = setsOf(me.gems);
  let best = null;
  for (const gm of obs.gems) {
    if (!isAffordable(me.stamina, gm.dist, exitField[gm.y * N + gm.x], H.returnMarginX10)) continue;
    const after = me.gems.slice();
    after[gm.c]++;
    const v = T.gemScore + T.setBonus * (setsOf(after) - setsNow) + (me.gems[gm.c] === setsNow ? H.wProgress : 0);
    const score = v / (gm.dist + 1);
    if (better(score, gm.x, gm.y, best)) best = { score, type: 'gem', x: gm.x, y: gm.y };
  }
  const ch = obs.chest;
  if (ch.present && isAffordable(me.stamina, ch.dist, exitField[ch.y * N + ch.x], H.returnMarginX10)) {
    const v = me.stamina < H.chestLowStamina ? H.wChestLow : H.wChestHigh;
    const score = v / (ch.dist + 1);
    if (better(score, ch.x, ch.y, best)) best = { score, type: 'chest', x: ch.x, y: ch.y };
  }
  if (!best) return home;
  return { mode: 'collect', target: { type: best.type, x: best.x, y: best.y } };
}

/** 路权：体力低者先行，同体力座位号小者先行。双方都只用公开信息判定，所以结论一致。 */
export const hasRightOfWay = (me, other) => me.stamina < other.stamina || (me.stamina === other.stamina && me.seat < other.seat);

/**
 * 沿目标距离场下降一步。受阻处理（SPEC §8.3）——先定路权，只有无路权的一方改道，避免双方同时改道又撞上：
 *  - 连续受阻 ≥ unblockAfter 且堵路者就在最短路的下一格：
 *      有路权（体力低 / 同体力座位小）→ 继续顶；
 *      无路权，或有路权但连续受阻 ≥ yieldEscalateAfter（对方退无可退）→
 *        有绕路（把可见角色当墙）且多出 ≤ detourMaxExtra 步 → 承诺绕路（避让格在 detourCommitTurns 内一直当墙，防止走一步又折回）；
 *        否则进入让行模式：后退远离对方，同距离时优先不挡对方去出口的方向，直到对方不再挡在前面（≤ yieldMaxTurns）
 *  - 同格冲突（对方不在下一格而在争同一格）：掷币让一回合
 * @param {{yieldSeat?:number, yieldLeft?:number, avoid?:number[], avoidLeft?:number}} [mem] 控制器跨回合记忆
 */
export function stepToward(map, obs, target, cfg, st, mem = {}) {
  const H = cfg.ai.heuristic;
  const N = map.size;
  const g = map.grid;
  const me = obs.self;
  const selfIdx = me.y * N + me.x;
  const tIdx = target.y * N + target.x;
  if (selfIdx === tIdx) return STAY;

  const occupied = new Set();
  for (const o of obs.actors) if (o.visible) occupied.add(o.y * N + o.x);

  const nb = (d) => {
    const x = me.x + DX[d];
    const y = me.y + DY[d];
    return x >= 0 && y >= 0 && x < N && y < N && g[y * N + x] ? y * N + x : -1;
  };
  const pickFrom = (opts) => (opts.length === 1 ? opts[0] : opts[randInt(st, 0, opts.length - 1)]);
  const base = fieldFrom(map, tIdx);
  const descend = (field) => {
    const cur = field[selfIdx];
    const opts = [];
    for (let d = 0; d < 4; d++) {
      const c = nb(d);
      if (c >= 0 && field[c] >= 0 && field[c] === cur - 1) opts.push(d);
    }
    return opts;
  };
  const withWalls = (cells) => {
    const blocked = new Uint8Array(N * N);
    for (const c of cells) blocked[c] = 1;
    return bfsField(g, N, [tIdx], blocked);
  };

  // 让行：远离对方；同距离时避开对方去它出口的下一跳（拿不到对方目标，出口是最好的猜测）
  const retreatFrom = (b) => {
    const db = bfsField(g, N, [b.y * N + b.x]);
    const [bx, by] = map.exits[b.seat];
    const bExit = fieldFrom(map, by * N + bx);
    const cand = [];
    for (let d = 0; d < 4; d++) {
      const c = nb(d);
      if (c >= 0 && !occupied.has(c) && db[c] > db[selfIdx]) cand.push(d);
    }
    if (!cand.length) return -1;
    const off = cand.filter((d) => bExit[nb(d)] >= bExit[selfIdx]);
    return pickFrom(off.length ? off : cand);
  };

  // 让行模式延续：对方仍在我前方（离我目标更近）就继续退
  if (mem.yieldSeat >= 0) {
    const b = obs.actors.find((o) => o.seat === mem.yieldSeat && o.visible);
    const bIdx = b ? b.y * N + b.x : -1;
    if (b && mem.yieldLeft > 0 && base[bIdx] >= 0 && base[bIdx] < base[selfIdx]) {
      mem.yieldLeft--;
      const r = retreatFrom(b);
      if (r >= 0) return r;
    }
    mem.yieldSeat = -1;
  }

  // 承诺绕路延续
  if (mem.avoidLeft > 0) {
    mem.avoidLeft--;
    const detour = withWalls(mem.avoid);
    const opts = detour[selfIdx] > 0 ? descend(detour).filter((d) => !occupied.has(nb(d))) : [];
    if (opts.length) return pickFrom(opts);
    mem.avoidLeft = 0;
  }

  if (me.blockedStreak >= H.unblockAfter && occupied.size) {
    let blocker = null;
    for (const d of descend(base)) {
      const c = nb(d);
      if (!occupied.has(c)) { blocker = null; break; }
      blocker ??= obs.actors.find((o) => o.visible && o.y * N + o.x === c);
    }
    if (blocker && (!hasRightOfWay(me, blocker) || me.blockedStreak >= H.yieldEscalateAfter)) {
      const cells = [...occupied];
      const detour = withWalls(cells);
      if (detour[selfIdx] > 0 && detour[selfIdx] <= base[selfIdx] + H.detourMaxExtra) {
        mem.avoid = cells;
        mem.avoidLeft = H.detourCommitTurns - 1;
        return pickFrom(descend(detour).filter((d) => !occupied.has(nb(d))));
      }
      mem.yieldSeat = blocker.seat;
      mem.yieldLeft = H.yieldMaxTurns - 1;
      const r = retreatFrom(blocker);
      if (r >= 0) return r;
      mem.yieldSeat = -1; // 退无可退（死胡同）：继续顶，交给对方在 yieldEscalateAfter 后让
    }
  }

  const opts = descend(base);
  if (!opts.length) return STAY;
  const free = opts.filter((d) => !occupied.has(nb(d)));
  const pick = pickFrom(free.length ? free : opts);
  // 同格冲突全员不动（§4.3），对称僵局只能靠随机让行打破：连续受阻且目标格旁有可见角色 → 掷币让一回合
  if (me.blockedStreak >= H.unblockAfter && contested(nb(pick), occupied, N) && randInt(st, 0, 99) < H.yieldPct) return STAY;
  return pick;
}

function contested(c, occupied, N) {
  const cx = c % N;
  const cy = (c / N) | 0;
  for (const o of occupied) {
    if (o !== c && Math.abs((o % N) - cx) + Math.abs(((o / N) | 0) - cy) === 1) return true;
  }
  return false;
}

/** @returns {{dir:number, mode:'home'|'collect', target:{type:string,x:number,y:number}}} */
export function heuristicDecide(map, obs, cfg, st, mem) {
  const { mode, target } = chooseTarget(map, obs, cfg);
  return { dir: stepToward(map, obs, target, cfg, st, mem), mode, target };
}

/** 每座位独立的启发式控制器；AI 流 = subSeed(subSeed(seed, AI), seat)。 */
export function createHeuristic(map, seat, cfg, seed) {
  const st = createStream(subSeed(subSeed(seed >>> 0, STREAM.AI), seat));
  const mem = { yieldSeat: -1, yieldLeft: 0 };
  return {
    kind: 'heuristic',
    decide(obs) {
      return heuristicDecide(map, obs, cfg, st, mem);
    },
  };
}
