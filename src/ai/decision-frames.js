// 决策帧（决策协议改造 §14 C1 / C7）：每回合结算后，按「该座位当时能看到的」生成一帧，append-only。
// 帧只从 observe() 的结果投影（同一个对象），所以与该座位拿去决策的观察同源，且不会多给可见性规则之外的信息：
// 对手的计划 / then / abandonIf / 随机数状态不在 observe 里，这里也就没有。
//
// 帧号 k：frame(0) = 开局（尚未行动）；frame(k) = 第 k 回合结算后的局面。
//   非终局时内部 state.turn = k + 1（即将执行的回合）；终局时 state.turn 不再递增，k = state.endTurn。

/** state → 它对应的帧号。 */
export const frameTurn = (state) => (state.ended ? state.endTurn : state.turn - 1);

/**
 * observe() 的结果 → 精简帧。obs 必须是「第 k 回合结算后、带第 k 回合事件」的观察。
 *   seats  各座位 {seat, x, y, stamina, score, status, gems}；不可见对手 x / y 为 null，附 seen（最后目击）
 *   gems   [[c, x, y], ...]（当前真实存在的宝石，已含本回合的拾取与刷新）
 *   chest  [x, y] 或 null
 */
export function toFrame(obs, k) {
  const s = obs.self;
  const seats = [{ seat: s.seat, x: s.x, y: s.y, stamina: s.stamina, score: s.score, status: s.status, gems: s.gems.slice() }];
  for (const a of obs.actors) {
    const e = { seat: a.seat, x: a.visible ? a.x : null, y: a.visible ? a.y : null, stamina: a.stamina, score: a.score, status: a.status, gems: a.gems.slice() };
    if (!a.visible && a.lastSeen) e.seen = { x: a.lastSeen.x, y: a.lastSeen.y, turnsSince: a.lastSeen.turnsSince };
    seats.push(e);
  }
  seats.sort((p, q) => p.seat - q.seat);
  return {
    k,
    seat: s.seat,
    seats,
    events: (obs.events || []).map((e) => ({ ...e })),
    gems: obs.gems.map((g) => [g.c, g.x, g.y]),
    gen: obs.gemGeneration,
    chest: obs.chest.present ? [obs.chest.x, obs.chest.y] : null,
  };
}

function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freeze(v);
  }
  return o;
}

/**
 * 每座位一条帧序列（k 从 0 起连续）。帧冻结，之后发生的事只能追加新帧。
 * @param {number[]} seats 采集哪些座位
 */
export function createFrameLog(seats) {
  const bySeat = new Map(seats.map((s) => [s, []]));
  const list = (seat) => {
    const l = bySeat.get(seat);
    if (!l) throw new Error(`座位 ${seat} 没有采集帧`);
    return l;
  };
  return {
    seats: [...bySeat.keys()],
    has: (seat) => bySeat.has(seat),
    push(seat, frame) {
      const l = list(seat);
      if (frame.k !== l.length) throw new Error(`帧不连续：座位 ${seat} 期望 k=${l.length}，收到 ${frame.k}`);
      l.push(freeze(frame));
    },
    /** 最新一帧的帧号（还没有帧时 -1）。 */
    lastK: (seat) => list(seat).length - 1,
    get: (seat, k) => list(seat)[k] ?? null,
    /** 闭区间 [from, to]，自动夹到已有范围。 */
    range(seat, from, to) {
      const l = list(seat);
      return l.slice(Math.max(0, from), Math.min(l.length - 1, to) + 1);
    },
  };
}
