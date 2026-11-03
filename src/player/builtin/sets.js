// @maze-script name: 凑套 + 推演抢宝石 | author: 迷宫寻宝 | origin: builtin
// 示例：演示统一编程接口 v2 的几样能力 ——
//   init 预计算（我出口的距离场）、模块变量记忆（锁定目标，避免来回摇摆）、
//   obs.events（目标被谁拿走、宝石刷新了）、对手模型（按对手到宝石的距离判断「抢不过」）、
//   api.sim.step（下一步会不会和对手撞在同一格 / 对穿而白等一回合）。
// 打法：优先补齐自己最缺的颜色凑成套；宝箱近而且体力偏低就先开；回不来的不去；体力只够回家就回家。

let N = 0;
let R = null;
let exitField = null;
let target = null; // {type, x, y, note}
let lostTo = null; // 最近一次被抢走的提示

export function init(ctx, api) {
  N = ctx.size;
  R = ctx.rules;
  const [ex, ey] = ctx.exits[ctx.seat];
  exitField = api.field(ex, ey);
  api.log(`规格 ${ctx.mapSize}：体力 ${R.stamina}，${R.maxTurns} 回合，视野 ${R.visionRadius}`);
}

const affordable = (stamina, dTo, dBack, marginX10) => dTo >= 0 && dBack >= 0 && stamina * 10 >= dTo * 10 + dBack * marginX10;

/** 有没有对手（视野内）比我更快到达这一格。视野外的对手看不到，按「不知道」处理。 */
function rivalFaster(obs, api, x, y, myDist) {
  for (const o of obs.actors) {
    if (!o.visible || o.status !== 'active') continue;
    if (api.dist(x, y, o.x, o.y) >= 0 && api.dist(x, y, o.x, o.y) < myDist) return o.seat;
  }
  return -1;
}

function pickTarget(obs, api) {
  const me = obs.self;
  const low = Math.min(...me.gems);
  let best = null;
  for (const g of obs.gems) {
    const back = exitField[g.y * N + g.x];
    if (!affordable(me.stamina, g.dist, back, 14)) continue;
    let v = me.gems[g.c] === low ? 3 : me.gems[g.c] > low ? 0.6 : 1; // 缺的颜色最值钱
    if (rivalFaster(obs, api, g.x, g.y, g.dist) >= 0) v *= 0.35; // 抢不过就别去
    const score = v / (g.dist + 1);
    if (!best || score > best.score) best = { score, type: 'gem', x: g.x, y: g.y, note: `补${g.color}` };
  }
  const ch = obs.chest;
  if (ch.present && affordable(me.stamina, ch.dist, exitField[ch.y * N + ch.x], 14)) {
    const v = me.stamina < R.stamina * 0.6 ? 2.2 : 0.8;
    const score = v / (ch.dist + 1);
    if (!best || score > best.score) best = { score, type: 'chest', x: ch.x, y: ch.y, note: '开宝箱' };
  }
  return best ? { type: best.type, x: best.x, y: best.y, note: best.note } : null;
}

const stillThere = (obs, t) => t && (t.type === 'exit'
  || (t.type === 'gem' && obs.gems.some((g) => g.x === t.x && g.y === t.y))
  || (t.type === 'chest' && obs.chest.present && obs.chest.x === t.x && obs.chest.y === t.y));

/** 用 sim.step 检查：照最短路走这一步，会不会被视野内的对手挡住（假设对手也朝它最近的宝石走）。 */
function safeStep(obs, api, t) {
  const first = api.shortestStep(t.x, t.y);
  if (first === -1 || first === 'STAY') return first;
  const rivals = obs.actors.filter((o) => o.visible && o.status === 'active');
  if (!rivals.length) return first;
  const guess = (o) => {
    let best = null;
    for (const g of obs.gems) {
      const d = api.dist(g.x, g.y, o.x, o.y);
      if (d >= 0 && (!best || d < best.d)) best = { d, g };
    }
    if (!best) return 'STAY';
    const f = api.field(best.g.x, best.g.y);
    const cur = f[o.y * N + o.x];
    for (const [m, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      if (api.isFloor(o.x + dx, o.y + dy) && f[(o.y + dy) * N + o.x + dx] === cur - 1) return m;
    }
    return 'STAY';
  };
  const moves = { [obs.self.seat]: first };
  for (const o of rivals) moves[o.seat] = guess(o);
  const r = api.sim.step({}, moves);
  if (r.actors[obs.self.seat].moved) return first;
  // 会被挡：试试其他同样不绕远的方向，再不行就原地等一回合
  const f = api.field(t.x, t.y);
  const cur = f[obs.self.y * N + obs.self.x];
  for (const [m, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
    if (m === first) continue;
    const nx = obs.self.x + dx;
    const ny = obs.self.y + dy;
    if (!api.isFloor(nx, ny) || f[ny * N + nx] > cur) continue;
    const r2 = api.sim.step({}, { ...moves, [obs.self.seat]: m });
    if (r2.actors[obs.self.seat].moved) return m;
  }
  return first;
}

export function decide(obs, api) {
  const me = obs.self;
  for (const e of obs.events) {
    if (e.type === 'pickup' && target && e.x === target.x && e.y === target.y && e.seat !== me.seat) lostTo = `座位 ${e.seat} 抢走了我的目标`;
    if (e.type === 'gemRespawn') api.log(`第 ${e.generation} 代宝石刷新`);
  }
  if (lostTo) {
    api.log(lostTo);
    lostTo = null;
  }
  const home = { type: 'exit', x: me.exit.x, y: me.exit.y, note: '回家' };
  if (me.stamina * 10 <= me.distToExit * 14) target = home;
  else if (!stillThere(obs, target) || target.type === 'exit') target = pickTarget(obs, api) || home;
  const move = safeStep(obs, api, target);
  return { move: move === -1 ? 'STAY' : move, intent: target };
}
