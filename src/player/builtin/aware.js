// @maze-script name: 预判对手（参考实现） | author: 迷宫寻宝 | origin: builtin
// 在「启发式（参考实现）」的基础上加了对手推断，演示「看得清、拼推理」能做什么。只用公开信息：
//   1. 对手走了几步：体力只在成功移动时扣 1，开箱加体力会广播（obs.events），所以
//      从最后已知位置起走的步数 = 当时体力 − 现在体力 + 期间开箱加的体力（精确值，不是估计）。
//   2. 对手最快多久到某颗宝石：视野内 = 精确距离；视野外 = max(0, 最后已知位置到宝石的距离 − 已走步数)（乐观下界）。
//   3. 对手想不想要：这颗颜色是不是他最缺的；他的体力够不够去了再回他自己的出口（四个出口公开）。
//   4. 抢不过（想要且负担得起的对手比我先到）就降权换目标；同时到达（会同格冲突、双方都不动）也降权。
// 视野规则越透明，推断越准；radius 规则下视野外的对手只能靠最后目击位置 + 体力差推断。

let N = 0;
let R = null;
let exits = null;
let spawns = null;
let mySeat = 0;
let exitField = null;
let chestLow = 0;
const exitFields = []; // 各座位出口的距离场（判断对手负担得起吗）
const staminaAt = []; // staminaAt[seat][turn] = 该回合观察到的体力
const gainCum = []; // gainCum[seat][turn] = 截至该回合观察到的累计开箱加体力
const mem = { yieldSeat: -1, yieldLeft: 0, avoid: null, avoidLeft: 0 };

const HOME_X10 = 13;
const MARGIN_X10 = 13;
const W_PROGRESS = 0.5;
const W_CHEST_LOW = 1.2; // 宝箱还可能给体力的规则下：体力低时的宝箱价值
const W_CHEST_HIGH = 0.6;
const LOSE = 0.12; // 抢不过：价值乘这个
const TIE = 0.45; // 可能同时到：价值乘这个
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
  spawns = ctx.spawns;
  mySeat = ctx.seat;
  for (let s = 0; s < exits.length; s++) {
    exitFields[s] = api.field(exits[s][0], exits[s][1]);
    staminaAt[s] = [];
    gainCum[s] = [];
  }
  exitField = exitFields[mySeat];
  chestLow = Math.round(R.stamina * 0.75);
}

const setsOf = (gems) => Math.min(...gems);
const affordable = (stamina, dTo, dBack, marginX10 = MARGIN_X10) => dTo >= 0 && dBack >= 0 && stamina * 10 >= dTo * 10 + dBack * marginX10;
const better = (score, x, y, best) => !best || score > best.score || (score === best.score && (y < best.y || (y === best.y && x < best.x)));

/** 记账：每个对手每回合的体力与累计开箱加体力。 */
function track(obs) {
  const t = obs.turn;
  for (const e of obs.events) {
    if (e.type === 'chest' && e.kind === 'stamina' && e.seat !== mySeat) gainCum[e.seat][t] = (gainCum[e.seat][t] ?? lastGain(e.seat, t - 1)) + (e.gained ?? e.value);
  }
  for (const o of obs.actors) {
    staminaAt[o.seat][t] = o.stamina;
    if (gainCum[o.seat][t] === undefined) gainCum[o.seat][t] = lastGain(o.seat, t - 1);
  }
}
function lastGain(seat, t) {
  for (let k = t; k >= 0; k--) if (gainCum[seat][k] !== undefined) return gainCum[seat][k];
  return 0;
}

/** 对手最后已知位置与此后走的步数（精确，由体力差 + 开箱加体力算出）。 */
function knownOf(o, obs) {
  if (o.visible) return { x: o.x, y: o.y, moved: 0 };
  const t = obs.turn;
  const ls = o.lastSeen || { x: spawns[o.seat][0], y: spawns[o.seat][1], turnsSince: t };
  const then = Math.max(1, t - ls.turnsSince + 1); // 位置记录于第 t − turnsSince 回合末，下一回合的观察里是那时的体力
  const stThen = staminaAt[o.seat][then] ?? R.stamina;
  const moved = Math.max(0, stThen - o.stamina + (gainCum[o.seat][t] ?? 0) - lastGain(o.seat, then));
  return { x: ls.x, y: ls.y, moved: Math.min(moved, ls.turnsSince) };
}

/** 对手到 (x,y) 最快要几步（乐观下界）。 */
function etaOf(o, k, api, x, y) {
  const d = api.dist(x, y, k.x, k.y);
  if (d < 0) return Infinity;
  return Math.max(0, d - k.moved);
}

/** 这颗宝石对对手值不值得去（缺的颜色 + 负担得起）。 */
function rivalWants(o, eta, g) {
  if (o.status !== 'active') return false;
  const low = Math.min(...o.gems);
  const need = o.gems[g.c] === low;
  const back = exitFields[o.seat][g.y * N + g.x];
  return need && affordable(o.stamina, eta, back, 10);
}

function threat(obs, api, g, myDist, knowns) {
  let f = 1;
  for (const o of obs.actors) {
    if (o.status !== 'active') continue;
    const k = knowns[o.seat];
    const eta = etaOf(o, k, api, g.x, g.y);
    if (eta === Infinity) continue;
    if (g.c !== undefined && !rivalWants(o, eta, g)) continue;
    if (eta < myDist) f = Math.min(f, LOSE);
    else if (eta === myDist) f = Math.min(f, TIE);
  }
  return f;
}

function chooseTarget(obs, api) {
  const me = obs.self;
  const home = { type: 'exit', x: me.exit.x, y: me.exit.y, note: '回家' };
  if (me.stamina * 10 <= me.distToExit * HOME_X10) return home;
  const knowns = [];
  for (const o of obs.actors) knowns[o.seat] = knownOf(o, obs);
  const setsNow = setsOf(me.gems);
  let best = null;
  for (const g of obs.gems) {
    if (!affordable(me.stamina, g.dist, exitField[g.y * N + g.x])) continue;
    const after = me.gems.slice();
    after[g.c]++;
    const v = R.gemScore + R.setBonus * (setsOf(after) - setsNow) + (me.gems[g.c] === setsNow ? W_PROGRESS : 0);
    const f = threat(obs, api, g, g.dist, knowns);
    const score = (v * f) / (g.dist + 1);
    const note = f < 1 ? `${g.color}（${f <= LOSE ? '多半抢不过' : '可能撞上'}）` : `${g.color} 宝石`;
    if (better(score, g.x, g.y, best)) best = { score, type: 'gem', x: g.x, y: g.y, note };
  }
  const ch = obs.chest;
  if (ch.present && affordable(me.stamina, ch.dist, exitField[ch.y * N + ch.x])) {
    const f = threat(obs, api, { x: ch.x, y: ch.y }, ch.dist, knowns);
    // 宝箱只给分（规则 pScore = 1）就按分数和宝石同口径比；还可能给体力时，体力低更值得开
    const v = R.chest.pScore >= 1 ? (R.chest.scoreRange[0] + R.chest.scoreRange[1]) / 2 : me.stamina < chestLow ? W_CHEST_LOW : W_CHEST_HIGH;
    const score = (v * f) / (ch.dist + 1);
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
  // 只把视野半径内的对手当障碍（与启发式一致）：全公开规则下远处的人也在 obs 里，不该影响眼前走位
  const occupied = new Set();
  for (const o of obs.actors) if (o.visible && Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) <= R.visionRadius) occupied.add(o.y * N + o.x);
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
  const retreatFrom = (b) => {
    const db = api.field(b.x, b.y);
    const [bx, by] = exits[b.seat];
    const bExit = exitFields[b.seat] || api.field(bx, by);
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
  track(obs);
  const intent = chooseTarget(obs, api);
  return { move: stepToward(obs, api, intent), intent };
}
