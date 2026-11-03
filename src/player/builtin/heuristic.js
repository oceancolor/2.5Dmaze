// @maze-script name: 启发式（参考实现） | author: 迷宫寻宝 | origin: builtin
// 内置启发式 AI 用统一编程接口 v2 重写的版本：只用 ctx / obs / api，没有任何内部接口。
// 用途：① 示例（怎么选目标、怎么回家、怎么让行）② 评测基线 ③ 证明接口够用。
// 打法：贪心选「价值 / 距离」最高、去了还回得来的宝物；体力只够回家就回家；被堵时按路权绕路或让行。

let N = 0;
let R = null; // ctx.rules
let exits = null; // 四个出口（公开）
let exitField = null; // 我出口的距离场：exitField[y*N+x] = 该格到我出口的步数
let chestLow = 0;
const mem = { yieldSeat: -1, yieldLeft: 0, avoid: null, avoidLeft: 0 };

const HOME_X10 = 13; // 回家阈值：体力×10 ≤ 到出口距离×13
const MARGIN_X10 = 13; // 可负担：体力 ≥ 去程 + 1.3 × 回程
const W_PROGRESS = 0.5; // 补上「最少的那种颜色」的额外价值
const W_CHEST_LOW = 1.2; // 体力低时宝箱价值（可能加体力）
const W_CHEST_HIGH = 0.6;
const UNBLOCK_AFTER = 2;
const DETOUR_MAX_EXTRA = 12;
const DETOUR_COMMIT = 12;
const YIELD_MAX = 16;
const YIELD_ESCALATE = 6;
const YIELD_PCT = 50;
const DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export function init(ctx, api) {
  N = ctx.size;
  R = ctx.rules;
  exits = ctx.exits;
  const [ex, ey] = exits[ctx.seat];
  exitField = api.field(ex, ey);
  chestLow = Math.round(R.stamina * 0.75);
}

const setsOf = (gems) => Math.min(...gems);
const affordable = (stamina, dTo, dBack) => dTo >= 0 && dBack >= 0 && stamina * 10 >= dTo * 10 + dBack * MARGIN_X10;
const better = (score, x, y, best) => !best || score > best.score || (score === best.score && (y < best.y || (y === best.y && x < best.x)));

function chooseTarget(obs) {
  const me = obs.self;
  const home = { type: 'exit', x: me.exit.x, y: me.exit.y, note: '回家' };
  if (me.stamina * 10 <= me.distToExit * HOME_X10) return home;
  const setsNow = setsOf(me.gems);
  let best = null;
  for (const g of obs.gems) {
    if (!affordable(me.stamina, g.dist, exitField[g.y * N + g.x])) continue;
    const after = me.gems.slice();
    after[g.c]++;
    const v = R.gemScore + R.setBonus * (setsOf(after) - setsNow) + (me.gems[g.c] === setsNow ? W_PROGRESS : 0);
    const score = v / (g.dist + 1);
    if (better(score, g.x, g.y, best)) best = { score, type: 'gem', x: g.x, y: g.y, note: `${g.color} 宝石` };
  }
  const ch = obs.chest;
  if (ch.present && affordable(me.stamina, ch.dist, exitField[ch.y * N + ch.x])) {
    const score = (me.stamina < chestLow ? W_CHEST_LOW : W_CHEST_HIGH) / (ch.dist + 1);
    if (better(score, ch.x, ch.y, best)) best = { score, type: 'chest', x: ch.x, y: ch.y, note: '开宝箱' };
  }
  return best ? { type: best.type, x: best.x, y: best.y, note: best.note } : home;
}

const hasRightOfWay = (me, o) => me.stamina < o.stamina || (me.stamina === o.stamina && me.seat < o.seat);

function stepToward(obs, api, t) {
  const me = obs.self;
  const self = me.y * N + me.x;
  const tIdx = t.y * N + t.x;
  if (self === tIdx) return 'STAY';
  const occupied = new Set();
  for (const o of obs.actors) if (o.visible) occupied.add(o.y * N + o.x);
  const nb = (d) => {
    const x = me.x + DX[d];
    const y = me.y + DY[d];
    return api.isFloor(x, y) ? y * N + x : -1;
  };
  const pick = (opts) => (opts.length === 1 ? opts[0] : opts[api.randInt(0, opts.length - 1)]);
  const descend = (f) => {
    const cur = f[self];
    const out = [];
    for (let d = 0; d < 4; d++) {
      const c = nb(d);
      if (c >= 0 && f[c] >= 0 && f[c] === cur - 1) out.push(d);
    }
    return out;
  };
  const avoidField = (cells) => api.field(t.x, t.y, { avoid: cells.map((c) => [c % N, (c / N) | 0]) });
  const base = api.field(t.x, t.y);

  // 让行：远离对方；同距离时别挡对方去它出口的路（出口是公开的，ctx.exits）
  const retreatFrom = (b) => {
    const db = api.field(b.x, b.y);
    const [bx, by] = exits[b.seat];
    const bExit = api.field(bx, by);
    const cand = [];
    for (let d = 0; d < 4; d++) {
      const c = nb(d);
      if (c >= 0 && !occupied.has(c) && db[c] > db[self]) cand.push(d);
    }
    if (!cand.length) return -1;
    const off = cand.filter((d) => bExit[nb(d)] >= bExit[self]);
    return pick(off.length ? off : cand);
  };

  if (mem.yieldSeat >= 0) {
    const b = obs.actors.find((o) => o.seat === mem.yieldSeat && o.visible);
    if (b && mem.yieldLeft > 0 && base[b.y * N + b.x] >= 0 && base[b.y * N + b.x] < base[self]) {
      mem.yieldLeft--;
      const r = retreatFrom(b);
      if (r >= 0) return DIRS[r];
    }
    mem.yieldSeat = -1;
  }
  if (mem.avoidLeft > 0) {
    mem.avoidLeft--;
    const detour = avoidField(mem.avoid);
    const opts = detour[self] > 0 ? descend(detour).filter((d) => !occupied.has(nb(d))) : [];
    if (opts.length) return DIRS[pick(opts)];
    mem.avoidLeft = 0;
  }
  if (me.blockedStreak >= UNBLOCK_AFTER && occupied.size) {
    let blocker = null;
    for (const d of descend(base)) {
      const c = nb(d);
      if (!occupied.has(c)) {
        blocker = null;
        break;
      }
      blocker = blocker || obs.actors.find((o) => o.visible && o.y * N + o.x === c);
    }
    if (blocker && (!hasRightOfWay(me, blocker) || me.blockedStreak >= YIELD_ESCALATE)) {
      const cells = [...occupied];
      const detour = avoidField(cells);
      if (detour[self] > 0 && detour[self] <= base[self] + DETOUR_MAX_EXTRA) {
        mem.avoid = cells;
        mem.avoidLeft = DETOUR_COMMIT - 1;
        const opts = descend(detour).filter((d) => !occupied.has(nb(d)));
        if (opts.length) return DIRS[pick(opts)];
      }
      mem.yieldSeat = blocker.seat;
      mem.yieldLeft = YIELD_MAX - 1;
      const r = retreatFrom(blocker);
      if (r >= 0) return DIRS[r];
      mem.yieldSeat = -1;
    }
  }
  const opts = descend(base);
  if (!opts.length) return 'STAY';
  const free = opts.filter((d) => !occupied.has(nb(d)));
  const d = pick(free.length ? free : opts);
  // 同格冲突全员不动，对称僵局靠随机让一回合打破
  if (me.blockedStreak >= UNBLOCK_AFTER && contested(nb(d), occupied) && api.randInt(0, 99) < YIELD_PCT) return 'STAY';
  return DIRS[d];
}

function contested(c, occupied) {
  const cx = c % N;
  const cy = (c / N) | 0;
  for (const o of occupied) if (o !== c && Math.abs((o % N) - cx) + Math.abs(((o / N) | 0) - cy) === 1) return true;
  return false;
}

export function decide(obs, api) {
  const intent = chooseTarget(obs);
  return { move: stepToward(obs, api, intent), intent };
}
