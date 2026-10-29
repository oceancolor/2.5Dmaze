// LLM 规划 agent（SPEC §7）：LLM 只选目标，执行交给启发式的 stepToward（寻路 / 受阻让行）。
// 纯逻辑、确定性：网络 / 超时 / 延迟都在外层 transport（src/app/transport.js），这里只发请求、收结果，不读时钟。
//
// 生效时序（§7.5）：第 t 回合用第 t 回合的观察发请求，结果在第 t+L 回合【决策时】生效。
//   到点还没回来 → blocking(t) 为真，调度器等；超时由 transport 判、回调 fail('timeout')。
//   所以结果只取决于回复内容，与网络快慢无关（同一批回复 → 同一局）。
// 重规划（§7.1）：固定间隔 8（终盘 6；常态池吃紧时放宽到 10）；
//   事件 ①目标失效 ②宝物刷新 ③连续受阻 2 ④体力进入回家阈值 ⑥对手进入视野 —— 冷却 3 回合、每 agent 预算 10；
//   计划完成（或失效 / 失败后无计划）立即重规划：计入调用池、不计事件预算。在途请求未生效前不叠加新请求。
// 降级（§7.6）：L1 启发式（无计划 / 计划无效 / 请求失败）；L2 超时或不可解析 → repair 1 次；
//   L3 服务不可达 / key 无效 / 连续 3 次 5xx 或 429 → 全体启发式（共享池上的标记）。
// 自保闸门：执行中的计划若已负担不起（体力 < 到目标 + 目标回出口）→ 改回出口（source 'guard'），LLM 不能把自己走死。
//
// 玩家自己的 AI（05 §3.4 / §5，传 autonomy 时启用）：
//   决策契约 v1：回复多 follow（yes / partial / override）与 deviation；不合契约 → 把错误回给 AI 重试 1 次 → 仍不合格按 L1。
//   自主度：free 不校验 follow；blend 统计偏离；strict 的 override 判不合格。
//   safetyGate=false：关闭自保闸门（玩家选择「允许冒险」）。callCap：本座位每局调用上限（含修复）。
//   请求附带本次决策的上下文 {why, plan, budget}；思路文本只进 system 提示词，不影响局面（J06）。

import { STREAM, createStream, subSeed } from '../core/rng.js';
import { fieldFrom } from '../core/nav/bfs.js';
import { chooseTarget, stepToward, isAffordable } from './heuristic.js';
import { buildPayload, checkContract, parsePlan, validatePlan } from './codec.js';

const L3_REASON = {
  unreachable: '代理不可达',
  auth: 'key 无效、欠费或已删除',
};

/** 全局调用池（§7.1 预算）：常态池 / 终盘池 / 总上限，以及 L3 熔断状态。共用同一条线路的 agent 共享一个。 */
export function createAgentPool(cfg) {
  const A = cfg.ai;
  const used = { total: 0, normal: 0, endgame: 0, repairs: 0, denied: 0 };
  const per = new Map();
  const seatOf = (s) => {
    let p = per.get(s);
    if (!p) {
      p = { normal: 0, endgame: 0 };
      per.set(s, p);
    }
    return p;
  };
  let l3 = null;
  let errStreak = 0;
  return {
    /** 熔断原因；null = 正常。 */
    get l3() { return l3; },
    tripL3(why) {
      if (!l3) l3 = why;
    },
    /** @param {string} kind unreachable | auth | 5xx | 429 | timeout | http  @param {string} [detail] 给人看的原因 */
    noteError(kind, detail) {
      if (kind === 'unreachable' || kind === 'auth') this.tripL3(detail || L3_REASON[kind]);
      else if (kind === '5xx' || kind === '429') {
        errStreak++;
        if (errStreak >= 3) this.tripL3(kind === '429' ? '持续限流（429）' : '连续 3 次 5xx');
      }
    },
    noteOk() { errStreak = 0; },
    noteRepair() { used.repairs++; },
    /** 取一次调用额度；拿不到返回 false（该 agent 继续用旧计划 / 启发式）。 */
    take(seat, endgame) {
      const p = seatOf(seat);
      let ok = used.total < A.maxCallsPerGame;
      if (ok && endgame) ok = used.endgame < A.poolEndgame && p.endgame < A.endgameBudgetPerAgent;
      else if (ok) ok = used.normal < A.poolNormal && p.normal < A.normalSoftCapPerAgent;
      if (!ok) {
        used.denied++;
        return false;
      }
      used.total++;
      if (endgame) {
        used.endgame++;
        p.endgame++;
      } else {
        used.normal++;
        p.normal++;
      }
      return true;
    },
    /** 常态额度用到 75% 时放宽间隔。 */
    pressure(seat) { return seatOf(seat).normal >= 0.75 * A.normalSoftCapPerAgent; },
    /** 该座位还剩多少次决策额度（常态 + 终盘的软上限，给 AI 看的 budget）。 */
    remaining(seat) {
      const p = seatOf(seat);
      return Math.max(0, A.normalSoftCapPerAgent - p.normal) + Math.max(0, A.endgameBudgetPerAgent - p.endgame);
    },
    stats() {
      return { ...used, l3, per: [...per.entries()].map(([seat, p]) => ({ seat, ...p })) };
    },
  };
}

/**
 * @param {{map:object, seat:number, cfg:object, seed:number, pool:object, persona?:string,
 *          autonomy?:'free'|'blend'|'strict'|null, safetyGate?:boolean, callCap?:number,
 *          transport:(req:object, reply:{deliver(text:string):void, fail(reason:string, detail?:string):void})=>void}} o
 *   transport 可以同步回调（mock 快进）也可以异步（真网络）；reason ∈ timeout | unreachable | auth | 5xx | 429 | http
 *   persona：对手 AI 的风格文本；玩家自己的 AI 时是「玩家思路」
 */
export function createPlanner({ map, seat, cfg, seed, pool, persona = '', autonomy = null, safetyGate = true, callCap = 0, transport }) {
  const A = cfg.ai;
  const L = A.planLatencyTurns;
  const N = map.size;
  const contract = Boolean(autonomy);
  const st = createStream(subSeed(subSeed(seed >>> 0, STREAM.AI), seat));
  const mem = { yieldSeat: -1, yieldLeft: 0 };
  const [ex, ey] = map.exits[seat];
  const exitField = fieldFrom(map, ey * N + ex);

  let plan = null; // 生效中的计划 {targetType, target, reason, follow?, deviation?, requestTurn, appliedTurn, source, why, guarded}
  let pending = null; // 在途 / 已回未生效 {id, kind, requestTurn, appliedTurn, payload, why, status:'out'|'done'|'failed', result, err, invalid}
  let nextId = 1;
  let lastPlanTurn = -Infinity;
  let lastEventTurn = -Infinity;
  let lastFailTurn = -Infinity;
  let eventsUsed = 0;
  let invalidStreak = 0;
  let prev = null;
  let last = null;
  const log = [];
  const stats = {
    requests: 0, repairs: 0, applied: 0, invalid: 0, rejected: 0, stale: 0, failed: 0, timeouts: 0,
    events: 0, eventsSkipped: 0, denied: 0, guard: 0, guardPlans: 0, capped: 0,
  };
  const follow = { yes: 0, partial: 0, override: 0 };
  const deviations = [];

  const capReached = () => callCap > 0 && stats.requests + stats.repairs >= callCap;

  function send(kind, req) {
    const id = nextId++;
    pending = { id, kind, ...req, status: 'out', result: null };
    if (kind === 'repair') {
      stats.repairs++;
      pool.noteRepair();
    } else {
      stats.requests++;
    }
    const r = {
      id, seat, kind, persona, requestTurn: req.requestTurn, appliedTurn: req.appliedTurn, payload: req.payload, raw: req.raw, error: req.error, why: req.why,
    };
    if (contract) {
      r.autonomy = autonomy;
      r.safetyGate = safetyGate;
      r.context = req.context;
    }
    transport(r, { deliver: (text) => deliver(id, text), fail: (reason, detail) => fail(id, reason, detail) });
  }

  /** 解析失败 / 不合契约：plan 请求且还能修复 → repair 一次；否则本次作废（不合格）。 */
  function reject(text, error) {
    if (pending.kind === 'plan' && !pool.l3 && !capReached()) {
      const p = pending;
      send('repair', { requestTurn: p.requestTurn, appliedTurn: p.appliedTurn, payload: p.payload, why: p.why, context: p.context, raw: text, error });
      return;
    }
    pending.status = 'failed';
    pending.invalid = true;
    pending.err = error;
  }

  function deliver(id, text) {
    if (!pending || pending.id !== id || pending.status !== 'out') return;
    pool.noteOk();
    const r = parsePlan(text);
    if (!r.ok) {
      reject(text, r.error);
      return;
    }
    let result = r.plan;
    if (contract) {
      const c = checkContract(result, autonomy);
      if (!c.ok) {
        reject(text, c.error);
        return;
      }
      result = c.plan;
    }
    pending.status = 'done';
    pending.result = result;
  }

  function fail(id, reason, detail) {
    if (!pending || pending.id !== id || pending.status !== 'out') return;
    if (reason === 'timeout') stats.timeouts++;
    pool.noteError(reason, detail);
    if (reason === 'timeout' && pending.kind === 'plan' && !pool.l3 && !capReached()) {
      const p = pending;
      send('repair', { requestTurn: p.requestTurn, appliedTurn: p.appliedTurn, payload: p.payload, why: p.why, context: p.context, raw: '', error: '超时' });
      return;
    }
    pending.status = 'failed';
    pending.err = detail || reason;
  }

  /** 计划在发请求时的局面里是否合法（生效时目标没了 = 过期，不算 AI 答错）。 */
  function validAtRequest(r, payload) {
    const { x, y } = r.target;
    if (r.targetType === 'exit') return x === payload.self.exit.x && y === payload.self.exit.y;
    if (r.targetType === 'gem') return payload.gems.some((g) => g.x === x && g.y === y);
    return payload.chest.present && payload.chest.x === x && payload.chest.y === y;
  }

  /** 到期结果生效（只在 decide 里调：此时调度器已保证到期请求都有了结果）。 */
  function applyDue(obs, turn) {
    if (!pending || pending.status === 'out' || pending.appliedTurn > turn) return;
    const p = pending;
    pending = null;
    const entry = { n: turn, seat, requestTurn: p.requestTurn, why: p.why };
    if (p.status === 'done') {
      const v = validatePlan(p.result, obs);
      if (v.ok) {
        plan = { ...p.result, requestTurn: p.requestTurn, appliedTurn: turn, source: p.kind === 'repair' ? 'llm-repair' : 'llm', why: p.why, guarded: false };
        stats.applied++;
        invalidStreak = 0;
        if (contract) {
          follow[plan.follow]++;
          if (plan.follow !== 'yes') {
            deviations.push({ n: turn, follow: plan.follow, deviation: plan.deviation ?? '', reason: plan.reason, targetType: plan.targetType, target: plan.target });
          }
        }
        log.push({ ...entry, source: plan.source, plan: p.result });
        return;
      }
      if (validAtRequest(p.result, p.payload)) {
        stats.stale++;
        log.push({ ...entry, source: 'stale', plan: p.result, err: v.why });
      } else {
        stats.invalid++;
        invalidStreak++;
        log.push({ ...entry, source: 'invalid', plan: p.result, err: v.why });
      }
    } else if (p.invalid) {
      stats.rejected++;
      invalidStreak++;
      log.push({ ...entry, source: 'invalid', plan: null, err: p.err });
    } else {
      stats.failed++;
      log.push({ ...entry, source: 'failed', plan: null, err: p.err });
    }
    plan = null;
    lastFailTurn = turn;
  }

  const planAlive = (obs) => plan && (plan.targetType === 'exit' || validatePlan(plan, obs).ok);

  function context(turn) {
    if (!contract) return undefined;
    const left = pool.remaining(seat);
    return {
      why: null,
      plan: plan ? { targetType: plan.targetType, target: plan.target, reason: plan.reason, turns: turn - plan.appliedTurn } : null,
      budget: callCap > 0 ? Math.min(left, Math.max(0, callCap - stats.requests - stats.repairs)) : left,
    };
  }

  return {
    kind: 'planner',
    wantsPatch: true,
    autonomy,

    /** 回合开始：判断要不要发新请求（事件 / 间隔 / 计划完成）。每回合恰好调用一次，在等待与决策之前。 */
    begin(obs, turn) {
      if (pool.l3) {
        pending = null;
        plan = null;
        return;
      }
      const me = obs.self;
      const vis = new Set();
      for (const o of obs.actors) if (o.visible) vis.add(o.seat);
      let complete = !plan;
      let event = null;
      if (plan && plan.targetType !== 'exit' && !validatePlan(plan, obs).ok) {
        if (me.x === plan.target.x && me.y === plan.target.y) complete = true;
        else event = 'targetLost';
      }
      if (prev) {
        if (!event && (obs.gemGeneration > prev.gen || (obs.chest.present && !prev.chest))) event = 'refresh';
        if (!event && me.blockedStreak === A.heuristic.unblockAfter && prev.blocked < me.blockedStreak) event = 'blocked';
        if (!event && me.inEndgame && !prev.endgame) event = 'lowStamina';
        if (!event) {
          for (const s of vis) {
            if (!prev.vis.has(s)) {
              event = 'sighted';
              break;
            }
          }
        }
      }
      prev = { gen: obs.gemGeneration, chest: obs.chest.present, blocked: me.blockedStreak, endgame: me.inEndgame, vis };
      if (pending) return;

      const endgame = me.inEndgame;
      const interval = endgame ? A.replanIntervalEndgame : pool.pressure(seat) ? A.replanIntervalMax : A.replanInterval;
      let why = null;
      if (complete && turn - lastFailTurn >= A.eventCooldownTurns) why = lastPlanTurn === -Infinity ? 'start' : 'complete';
      else if (event) {
        if (turn - lastEventTurn < A.eventCooldownTurns || eventsUsed >= A.eventBudgetPerAgent) stats.eventsSkipped++;
        else why = event;
      }
      // 已在回家路上：间隔重规划只会再答一次「回出口」，省掉；宝物刷新 / 对手进视野等事件照常触发
      const homing = plan && plan.targetType === 'exit';
      if (!why && !homing && turn - lastPlanTurn >= interval) why = 'interval';
      if (!why) return;
      if (capReached()) {
        stats.capped++;
        return;
      }
      if (!pool.take(seat, endgame)) {
        stats.denied++;
        return;
      }
      if (why !== 'complete' && why !== 'interval' && why !== 'start') {
        eventsUsed++;
        lastEventTurn = turn;
        stats.events++;
      }
      lastPlanTurn = turn;
      const ctx = context(turn);
      if (ctx) ctx.why = why;
      send('plan', { requestTurn: turn, appliedTurn: turn + L, payload: buildPayload(map, obs, cfg), why, context: ctx });
    },

    /** 有到期未回的请求 → 调度器必须等（§7.5）。 */
    blocking(turn) {
      return !pool.l3 && Boolean(pending) && pending.status === 'out' && pending.appliedTurn <= turn;
    },

    decide(obs, turn = obs.turn) {
      applyDue(obs, turn);
      const me = obs.self;
      let target = null;
      let mode = 'collect';
      let source = pool.l3 ? 'l3' : 'heuristic';
      if (!pool.l3 && planAlive(obs)) {
        const t = plan.target;
        if (plan.targetType === 'exit') {
          target = { type: 'exit', x: t.x, y: t.y };
          mode = 'home';
          source = plan.source;
        } else {
          const dTo = fieldFrom(map, t.y * N + t.x)[me.y * N + me.x];
          if (safetyGate && !isAffordable(me.stamina, dTo, exitField[t.y * N + t.x], 10)) {
            stats.guard++;
            if (!plan.guarded) {
              plan.guarded = true;
              stats.guardPlans++;
            }
            source = 'guard';
            target = { type: 'exit', x: me.exit.x, y: me.exit.y };
            mode = 'home';
          } else {
            target = { type: plan.targetType, x: t.x, y: t.y };
            source = plan.source;
          }
        }
      }
      if (!target) {
        const h = chooseTarget(map, obs, cfg);
        target = h.target;
        mode = h.mode;
      }
      const dir = stepToward(map, obs, target, cfg, st, mem);
      last = { dir, mode, target, source, reason: source.startsWith('llm') ? plan.reason : '' };
      return last;
    },

    /** 本回合新生效的计划（记录器写 plan 行）。 */
    takeLog() {
      return log.splice(0);
    },

    status() {
      const live = plan && last && last.source.startsWith('llm');
      return {
        source: last ? last.source : 'heuristic',
        target: last ? last.target : null,
        mode: last ? last.mode : null,
        reason: last ? last.reason : '',
        follow: contract && live ? plan.follow : null,
        deviation: contract && live ? plan.deviation ?? '' : '',
        thinking: Boolean(pending && pending.status === 'out'),
        l3: pool.l3,
        autonomy,
        safetyGate,
        invalidStreak,
        stats: { ...stats, eventsUsed, follow: { ...follow } },
      };
    },

    /** 思路执行报告（05 §8.3）：决策次数、遵循 / 部分 / 偏离 / 不合格 / 过期 / 引擎安全覆盖，偏离理由按回合。
     *  过期（stale）：回复合格，但生效时目标已被别人拿走（生效延迟 2 回合），不算 AI 答错。 */
    report() {
      return {
        autonomy,
        safetyGate,
        callCap,
        decisions: stats.applied + stats.invalid + stats.rejected + stats.stale + stats.failed,
        applied: stats.applied,
        follow: { ...follow },
        invalid: stats.invalid + stats.rejected,
        stale: stats.stale,
        failed: stats.failed,
        guard: stats.guardPlans,
        requests: stats.requests,
        repairs: stats.repairs,
        capped: stats.capped,
        deviations: deviations.slice(),
      };
    },
  };
}
