// 决策锚点与结果事件（决策协议改造 §14 C4 / C5 / C6，第 3 项）。
// 只记录、不左右决策：planner 在已有分支上调 push / bind，调度器每采一帧调 onFrame；对局结果与录像不受影响。
//
//   决策点 dp     每座位从 1 递增；repair（上次提交不合格后的重交）沿用同一 dp，rev + 1
//   目标身份 ref  宝石 {type:'gem', gen, x, y, c}（gen = 宝石代数）；宝箱 {type:'chest', spawn, x, y}（spawn = 本局第几只）；
//                 出口 {type:'exit', x, y}。只在这一层推导，不进核心状态、不影响 stateHash
//   结果事件      append-only，一个决策可以先后有多条（applied → guard → reached）；历史条目冻结，不回写
//                 每条 {dp, type, k, ...原因参数}，k = 帧号（第 k 回合结算后的局面，见 decision-frames.js）

import { fieldFrom } from '../core/nav/bfs.js';

export const OUTCOME_TYPES = Object.freeze([
  'applied', // 计划开始执行 {rev, effectiveTurn, ref, keep?}（keep = 续走原计划）
  'invalid', // 提交不合法 / 不合契约 {rev, why}
  'failed', // 调用失败（超时 / 网络 / 熔断）{rev, why}
  'stale', // 生效时目标已没了（请求时合法）{rev, why}；零延迟后应恒为 0
  'cancelled', // 请求还没回就被撤销（玩家接管 / 换控制器 / 对局关闭）{rev, cause}
  'guard', // 体力安全覆盖：改为回家 {dist, back, stamina, ref}
  'abandoned', // abandonIf 触发 {seat, lead, need}
  'lost', // 目标被别人拿走 {by, behind, ref}
  'reached', // 拿到目标 / 开箱 / 到达出口 {ref}
  'queued', // then 接续下一个目标 {ref}
  'replaced', // 被下一次决策换了目标 {by}
  'continued', // 下一次决策续走了同一个目标（keep，或交了同一个目标）{by}；§14 C14
  'interrupted', // 执行中被打断（玩家接管 / 换控制器）{cause}
]);

export const sameRef = (a, b) => Boolean(a && b) && a.type === b.type && a.x === b.x && a.y === b.y
  && (a.type !== 'gem' || (a.gen === b.gen && a.c === b.c))
  && (a.type !== 'chest' || a.spawn === b.spawn);

function freeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) freeze(v);
  return o;
}

/**
 * 每座位一份。onFrame 必须按帧号顺序收到该座位的每一帧（调度器保证）。
 * @param {object} map
 * @param {number} seat
 */
export function createDecisionLog(map, seat) {
  const N = map.size;
  const events = [];
  let dp = 0;
  let bound = null; // {dp, ref}：当前在执行的决策和它指向的目标实例
  let frame = null; // 最近一帧
  let chestSpawn = 0;

  const push = (type, d, k, extra = {}) => {
    const e = freeze({ dp: d, type, k, ...extra });
    events.push(e);
    return e;
  };

  /** 当前局面（最近一帧）里 (x,y) 上的目标实例 → ref；目标不存在时宝石不带 c。 */
  function ref(targetType, t) {
    const { x, y } = t;
    if (targetType === 'exit') return { type: 'exit', x, y };
    if (targetType === 'chest') return { type: 'chest', spawn: chestSpawn, x, y };
    const g = frame ? frame.gems.find(([, gx, gy]) => gx === x && gy === y) : null;
    return { type: 'gem', gen: frame ? frame.gen : 0, x, y, ...(g ? { c: g[0] } : {}) };
  }

  return {
    events,
    get dp() { return dp; },
    get bound() { return bound; },
    get frameK() { return frame ? frame.k : -1; },
    /** 新决策点（plan 请求）。repair 不调这个，沿用原 dp。 */
    nextDp: () => ++dp,
    ref,
    push,
    bind(d, r) { bound = { dp: d, ref: r }; },
    unbind() { bound = null; },

    /** 采到新帧：更新宝箱序号；判定当前目标是被拿到、被抢走，还是已到家。 */
    onFrame(f) {
      frame = f;
      if (f.k === 0) chestSpawn = f.chest ? 1 : 0;
      // 本帧里拾取发生在刷新之前（game.js 7a），所以刷新那一回合被拾取的宝石属于上一代
      const respawn = f.events.find((e) => e.type === 'gemRespawn');
      const pickGen = respawn ? respawn.generation - 1 : f.gen;
      if (bound) {
        const r = bound.ref;
        const me = f.seats.find((a) => a.seat === seat);
        let hit = null;
        if (r.type === 'gem') hit = f.events.find((e) => e.type === 'pickup' && e.x === r.x && e.y === r.y && pickGen === r.gen && (r.c === undefined || e.color === r.c));
        else if (r.type === 'chest') hit = f.events.find((e) => e.type === 'chest' && e.x === r.x && e.y === r.y && chestSpawn === r.spawn);
        if (hit) {
          if (hit.seat === seat) push('reached', bound.dp, f.k, { ref: r });
          else {
            const d = me && me.x !== null ? fieldFrom(map, r.y * N + r.x)[me.y * N + me.x] : -1;
            push('lost', bound.dp, f.k, { by: hit.seat, behind: Math.max(0, d), ref: r });
          }
          bound = null;
        } else if (r.type === 'exit' && me && me.status === 'escaped') {
          push('reached', bound.dp, f.k, { ref: r });
          bound = null;
        }
      }
      if (f.events.some((e) => e.type === 'chestRespawn')) chestSpawn++;
    },

    /** dp ≥ from 的全部结果事件（决策回包「上次决策的结果」用）。 */
    since: (from) => events.filter((e) => e.dp >= from),
  };
}
