// LLM 规划 agent（SPEC §7）：LLM 只选目标，执行交给启发式的 stepToward（寻路 / 受阻让行）。
// 纯逻辑、确定性：网络 / 超时 / 延迟都在外层 transport（src/app/transport.js），这里只发请求、收结果，不读时钟。
//
// 生效时序（§7.5，SPEC-0.3 起 L = 0）：第 t 回合开头（= 第 t-1 回合结算后的局面，帧 k = t-1）发请求，
//   当回合 blocking(t) 即为真，调度器停下等回复；回复后在第 t 回合【决策时】生效 —— 新计划驱动第 t 回合的第一步。
//   首个决策点在第 1 回合开头（帧 0，任何人行动之前）。超时由 transport 判、回调 fail('timeout')。
//   所以结果只取决于回复内容，与网络快慢无关（同一批回复 → 同一局）。L > 0 只为旧配置保留。
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
//
// harness（批次 6，玩家自己的 AI）：一局一个会话。
//   每次请求带上「本局到目前为止」（harness.sessionText：更早的决策折成摘要、最近 N 条原样、每条的结局）与模型上次的 memo；
//   局面附博弈事实表（codec.buildPayload：各对手到各宝物的步数、能否回家、动向 heading）；
//   契约 v2：then 目标队列（拿到当前目标后引擎直接接着走，记 plan 行 src 'queue'）、
//            abandonIf 放弃条件（引擎每回合检查，触发记 src 'abandon' 并立刻重问）；
//   自保闸门第一次改写某个计划时记 src 'guard'。这三种都不算「一次决策」（服务器 planStats 跳过）。
//   跨局经验 memory 进 system 提示词（只读，由外层赛后让模型自己写 / 压缩）。
//
// 等待动作（SPEC-0.4，§14 C15，所有大模型座位）：wait = 原地等 turns 回合；home = 沿最短路走到离出口 stopAt 步处再等（最多 wait.maxTurns 回合）。
//   生效时把「在哪等」定成具体格（plan.target）；在那一格上每回合原地不动（不耗体力），waited + 1；永远不踩进自己的出口。
//   等满到期 → 结果 woken{expired}（记 plan 行 src 'wake'），then 有下一个就接着走，否则必问；本局累计等待满 maxTotal → woken{cap}。
//   在等的时候：刷新必问（woken{refresh}，回 keep 继续等完）；对手接近 / 受阻 / 体力终盘 / 定期都不问。
//   时间闸门：剩余回合 ≤ 回家步数 + timeMargin → 改回出口（guard{cause:'time'}）。旧规则配置没有 cfg.ai.wait → 等待判不合格。

import { STREAM, createStream, subSeed } from '../core/rng.js';
import { fieldFrom } from '../core/nav/bfs.js';
import { DX, DY, STAY, cheb } from '../core/geom.js';
import { chooseTarget, stepToward, isAffordable } from './heuristic.js';
import { WAIT_TYPES, buildPayload, checkContract, parsePlan, validatePlan } from './codec.js';
import { createTracker, sessionText } from './harness.js';
import { createDecisionLog, sameRef } from './decision-protocol.js';
import { buildPacket, trajectoryText } from './decision-packet.js';

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
export function createPlanner({ map, seat, cfg, seed, pool, persona = '', autonomy = null, safetyGate = true, callCap = 0, memory = '', transport }) {
  const A = cfg.ai;
  const H = A.harness;
  const L = A.planLatencyTurns;
  const N = map.size;
  const contract = Boolean(autonomy);
  // harness 状态（只有玩家自己的 AI 用）
  const tracker = contract ? createTracker(map, seat) : null;
  // 决策点编号与结果事件（§14 C4 / C5）：所有大模型座位都记；只记录，不影响下面的任何决定
  const dlog = createDecisionLog(map, seat);
  let memo = '';
  let queue = []; // then 目标队列（当前计划之后依次去）
  const hist = new Map(); // seat → 最近 trendTurns+1 回合的位置（对手动向 heading）
  const exitFieldOf = (s) => fieldFrom(map, map.exits[s][1] * N + map.exits[s][0]);
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
  let refreshDue = false; // 刷新待问（SPEC-0.4：冷却中推迟，不丢）
  let invalidStreak = 0;
  let prev = null;
  let last = null;
  const log = [];
  const stats = {
    requests: 0, repairs: 0, applied: 0, invalid: 0, rejected: 0, stale: 0, failed: 0, timeouts: 0,
    events: 0, eventsSkipped: 0, mustAsk: 0, refreshDeferred: 0, denied: 0, guard: 0, guardPlans: 0, capped: 0, queued: 0, abandons: 0, kept: 0,
  };
  const follow = { yes: 0, partial: 0, override: 0 };
  const deviations = [];

  const capReached = () => callCap > 0 && stats.requests + stats.repairs >= callCap;
  let resume = false; // 玩家接管后交还：下一回合按当时局面重新问一次（why 'resume'）
  let disposed = false;
  let outTaken = 0; // 结果事件已写进录像的条数

  // ── 等待动作（SPEC-0.4）──
  const W = A.wait || null; // 旧规则配置没有 → 等待不合格
  let totalWaited = 0; // 本局累计原地等待的回合数
  const isWaitPlan = (p) => Boolean(p) && WAIT_TYPES.includes(p.targetType);
  /** home 停下来等的格：从 (x,y) 沿回家最短路走（方向序 N E S W），直到离出口 ≤ s 步；本来就够近就是原地。 */
  function stopCell(x, y, s) {
    let i = y * N + x;
    while (exitField[i] > s) {
      let nxt = -1;
      for (let d = 0; d < 4; d++) {
        const nx = (i % N) + DX[d];
        const ny = ((i / N) | 0) + DY[d];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        if (exitField[j] >= 0 && exitField[j] === exitField[i] - 1) {
          nxt = j;
          break;
        }
      }
      if (nxt < 0) break;
      i = nxt;
    }
    return { x: i % N, y: (i / N) | 0 };
  }
  /** 等待规格 → 生效中的计划字段：在哪等（target）、等几回合（turns）、已等（waited）。 */
  function materializeWait(spec, me) {
    if (spec.targetType === 'wait') return { targetType: 'wait', turns: Math.min(spec.turns, W.maxTurns), target: { x: me.x, y: me.y }, waited: 0 };
    const stopAt = Math.min(spec.stopAt, W.stopAtMax);
    return { targetType: 'home', stopAt, turns: W.maxTurns, target: stopCell(me.x, me.y, stopAt), waited: 0 };
  }
  /** 计划行 / 会话里展示的等待计划（不带内部计数）。 */
  const waitLine = (p) => ({ targetType: p.targetType, ...(p.targetType === 'wait' ? { turns: p.turns } : { stopAt: p.stopAt }), target: { ...p.target } });
  /** 正在那一格上等（home 还在路上时不算）。 */
  const waitingNow = (me) => isWaitPlan(plan) && !plan.guarded && me.x === plan.target.x && me.y === plan.target.y;
  // 「上次决策以来」（§14 C7）：上一个决策点之后收到的帧（调度器帧缓冲里冻结对象的引用）与上一个决策点
  let segment = [];
  let anchorK = -1;
  let anchorDp = 0;
  const segFrames = { range: (_s, from, to) => segment.filter((f) => f.k >= from && f.k <= to) };
  /** 本次决策点的轨迹回包（帧段 = (上一个决策点的帧号, k]）。 */
  function packetFor(k, dp) {
    const colors = cfg.treasure.gemColors;
    const packet = buildPacket({ frames: segFrames, seat, outcomes: dlog.events, from: anchorK + 1, to: k, colors, prevDp: anchorDp, dp });
    const text = trajectoryText(packet, { frames: segFrames, seat, colors });
    segment = segment.filter((f) => f.k > k);
    anchorK = k;
    anchorDp = dp;
    return { packet, trajectory: text };
  }

  function send(kind, req) {
    if (disposed) return;
    const id = nextId++;
    // 撤销信号：玩家接管 / 换控制器 / 对局关闭时 abort，transport 据此中止网络请求、不再回调、不计入本局用量
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    pending = { id, kind, ...req, status: 'out', result: null, ctl };
    if (kind === 'repair') {
      stats.repairs++;
      pool.noteRepair();
    } else {
      stats.requests++;
    }
    const r = {
      id, seat, kind, persona, requestTurn: req.requestTurn, appliedTurn: req.appliedTurn, payload: req.payload, raw: req.raw, error: req.error, why: req.why,
      dp: req.dp, rev: req.rev, packet: req.packet, trajectory: req.trajectory,
    };
    if (contract) {
      r.autonomy = autonomy;
      r.safetyGate = safetyGate;
      r.context = req.context;
      r.session = req.session;
      r.memory = memory;
    }
    transport(r, { deliver: (text) => deliver(id, text), fail: (reason, detail) => fail(id, reason, detail), signal: ctl ? ctl.signal : null });
  }

  /** 撤销在途请求（不回调、不生效）：玩家接管 / 换控制器 / 对局关闭。返回是否撤销了一个。 */
  function abortPending(cause, k) {
    if (!pending) return false;
    const p = pending;
    pending = null;
    if (p.ctl) p.ctl.abort();
    if (p.status === 'out' || p.status === 'done' || p.status === 'failed') dlog.push('cancelled', p.dp, k, { rev: p.rev, cause });
    return true;
  }

  /** 解析失败 / 不合契约：plan 请求且还能修复 → repair 一次；否则本次作废（不合格）。 */
  function reject(text, error) {
    if (pending.kind === 'plan' && !pool.l3 && !capReached()) {
      const p = pending;
      send('repair', { requestTurn: p.requestTurn, appliedTurn: p.appliedTurn, payload: p.payload, why: p.why, context: p.context, session: p.session, raw: text, error, dp: p.dp, rev: p.rev + 1, packet: p.packet, trajectory: p.trajectory });
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
    // 续走（§14 C14）：必须有在执行、且请求时目标还在的计划；否则当作不合格，给一次重交机会
    if (result.keep && !keepable(pending.payload)) {
      reject(text, '现在没有在执行的计划可以续走（keep），请给出 targetType + target');
      return;
    }
    if (isWaitPlan(result)) {
      if (!W) {
        reject(text, '本局规则没有等待动作（wait / home），请给出宝石 / 宝箱 / 出口');
        return;
      }
      if (totalWaited >= W.maxTotal) {
        reject(text, `本局累计等待已满 ${W.maxTotal} 回合，不能再等，请给出宝石 / 宝箱 / 出口`);
        return;
      }
    }
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

  /** 当前计划能否续走：有计划，且目标在发请求时的局面里还在（出口 / 等待总在）。 */
  const keepable = (payload) => Boolean(plan && plan.target && (plan.targetType === 'exit' || isWaitPlan(plan) || validAtRequest(plan, payload)));

  function fail(id, reason, detail) {
    if (!pending || pending.id !== id || pending.status !== 'out') return;
    if (reason === 'timeout') stats.timeouts++;
    pool.noteError(reason, detail);
    if (reason === 'timeout' && pending.kind === 'plan' && !pool.l3 && !capReached()) {
      const p = pending;
      send('repair', { requestTurn: p.requestTurn, appliedTurn: p.appliedTurn, payload: p.payload, why: p.why, context: p.context, session: p.session, raw: '', error: '超时', dp: p.dp, rev: p.rev + 1, packet: p.packet, trajectory: p.trajectory });
      return;
    }
    pending.status = 'failed';
    pending.err = detail || reason;
  }

  /** 计划在发请求时的局面里是否合法（生效时目标没了 = 过期，不算 AI 答错）。 */
  function validAtRequest(r, payload) {
    if (isWaitPlan(r)) return true;
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
    const entry = { n: turn, seat, requestTurn: p.requestTurn, why: p.why, dp: p.dp, rev: p.rev };
    const k = turn - 1; // 决策基于的帧：第 turn-1 回合结算后的局面
    // 旧计划（还在执行的那个决策）让位给这次决策：目标没变 = 续走（continued），换了目标 = 被替换（replaced）
    const drop = (ref = null) => {
      if (!dlog.bound) return;
      dlog.push(ref && sameRef(ref, dlog.bound.ref) ? 'continued' : 'replaced', dlog.bound.dp, k, { by: p.dp });
      dlog.unbind();
    };
    const source = p.kind === 'repair' ? 'llm-repair' : 'llm';
    if (p.status === 'done' && p.result.keep) {
      // 续走：目标 / then / abandonIf / 闸门状态原样保留，只换决策点编号
      if (!plan || !planAlive(obs)) { // 交付时已查过；防御（例如 L > 0 的旧配置）
        stats.invalid++;
        invalidStreak++;
        log.push({ ...entry, source: 'invalid', plan: null, err: '没有可续走的计划' });
        note(turn, p, 'invalid', null, '没有可续走的计划');
        dlog.push('invalid', p.dp, k, { rev: p.rev, why: '没有可续走的计划' });
        drop();
        plan = null;
        queue = [];
        lastFailTurn = turn;
        return;
      }
      const ref = dlog.bound ? dlog.bound.ref : dlog.ref(plan.targetType, plan.target);
      drop(ref);
      plan = { ...plan, requestTurn: p.requestTurn, source, why: p.why, dp: p.dp };
      dlog.push('applied', p.dp, k, { rev: p.rev, effectiveTurn: turn, ref, keep: true });
      dlog.bind(p.dp, ref);
      stats.applied++;
      stats.kept++;
      invalidStreak = 0;
      const shown = plan.guarded ? { targetType: 'exit', target: { x: obs.self.exit.x, y: obs.self.exit.y } } : { targetType: plan.targetType, target: { ...plan.target } };
      const line = { keep: true, ...shown, reason: p.result.reason || plan.reason, ...(p.result.memo ? { memo: p.result.memo } : {}) };
      if (contract) {
        if (p.result.memo) memo = p.result.memo;
        track(turn, p, source, line, obs);
      }
      log.push({ ...entry, source, plan: line });
      return;
    }
    if (p.status === 'done') {
      const v = validatePlan(p.result, obs);
      if (v.ok) {
        // 等待：生效这一刻定下「在哪等、等几回合」
        const result = isWaitPlan(p.result) ? { ...p.result, ...materializeWait(p.result, obs.self) } : p.result;
        const ref = dlog.ref(result.targetType, result.target);
        drop(ref);
        plan = { ...result, requestTurn: p.requestTurn, appliedTurn: turn, source, why: p.why, guarded: false, dp: p.dp };
        dlog.push('applied', p.dp, k, { rev: p.rev, effectiveTurn: turn, ref });
        dlog.bind(p.dp, ref);
        stats.applied++;
        invalidStreak = 0;
        if (contract) {
          follow[plan.follow]++;
          if (plan.follow !== 'yes') {
            deviations.push({ n: turn, follow: plan.follow, deviation: plan.deviation ?? '', reason: plan.reason, targetType: plan.targetType, target: plan.target });
          }
          if (plan.memo) memo = plan.memo;
          queue = (plan.then || []).slice(0, H.thenMax);
          track(turn, p, plan.source, plan, obs);
        }
        log.push({ ...entry, source: plan.source, plan: isWaitPlan(p.result) ? { ...p.result, ...waitLine(plan) } : p.result });
        return;
      }
      if (validAtRequest(p.result, p.payload)) {
        stats.stale++;
        log.push({ ...entry, source: 'stale', plan: p.result, err: v.why });
        note(turn, p, 'stale', p.result, v.why);
        dlog.push('stale', p.dp, k, { rev: p.rev, why: v.why });
      } else {
        stats.invalid++;
        invalidStreak++;
        log.push({ ...entry, source: 'invalid', plan: p.result, err: v.why });
        note(turn, p, 'invalid', p.result, v.why);
        dlog.push('invalid', p.dp, k, { rev: p.rev, why: v.why });
      }
    } else if (p.invalid) {
      stats.rejected++;
      invalidStreak++;
      log.push({ ...entry, source: 'invalid', plan: null, err: p.err });
      note(turn, p, 'invalid', null, p.err);
      dlog.push('invalid', p.dp, k, { rev: p.rev, why: p.err ?? '' });
    } else {
      stats.failed++;
      log.push({ ...entry, source: 'failed', plan: null, err: p.err });
      note(turn, p, 'failed', null, p.err);
      dlog.push('failed', p.dp, k, { rev: p.rev, why: p.err ?? '' });
    }
    drop();
    plan = null;
    queue = [];
    lastFailTurn = turn;
  }

  const colorAt = (obs, t) => {
    const g = obs.gems.find((q) => q.x === t.x && q.y === t.y);
    return g ? g.color : null;
  };

  /** 会话追踪：新目标生效（与 harness.timelineFromRecord 同一套条目，复盘时由记录重放得到同样的结局）。 */
  function track(turn, p, src, pl, obs, prevOutcome = 'switched') {
    if (!tracker) return;
    tracker.start({
      n: turn, req: p ? p.requestTurn : turn, src, why: p ? p.why : null, targetType: pl.targetType, target: { ...pl.target },
      color: pl.targetType === 'gem' ? colorAt(obs, pl.target) : null, reason: pl.reason ?? '', follow: pl.follow ?? null,
      deviation: pl.deviation ?? '', memo: pl.memo ?? '', then: Array.isArray(pl.then) ? pl.then.length : 0, abandonIf: pl.abandonIf ?? null,
      ...(pl.keep ? { keep: true } : {}),
    }, prevOutcome);
  }

  function note(turn, p, outcome, pl, err) {
    if (!tracker) return;
    tracker.note({ n: turn, req: p.requestTurn, src: outcome, why: p.why, outcome, err: err ?? '', targetType: pl ? pl.targetType : null, target: pl ? pl.target : null, reason: pl ? pl.reason ?? '' : '' });
  }

  /** 放弃条件：有一个拿得起的对手比我离当前目标近 k 步以上。返回 {text, seat, lead, need} 或 null。 */
  function abandonWhy(obs) {
    if (!plan || !plan.abandonIf || plan.targetType === 'exit' || isWaitPlan(plan) || plan.guarded) return null;
    const k = plan.abandonIf.rivalLeadBy;
    const t = plan.target;
    const f = fieldFrom(map, t.y * N + t.x);
    const mine = f[obs.self.y * N + obs.self.x];
    if (mine < 0) return null;
    for (const o of obs.actors) {
      if (!o.visible || o.status !== 'active') continue;
      const d = f[o.y * N + o.x];
      const back = exitFieldOf(o.seat)[t.y * N + t.x];
      if (d < 0 || back < 0 || o.stamina < d + back) continue;
      if (mine - d >= k) return { text: `座位 ${o.seat} 比我近 ${mine - d} 步（条件 ≥ ${k}）`, seat: o.seat, lead: mine - d, need: k };
    }
    return null;
  }

  /** 当前目标拿到后接着走队列里的下一个（跳过已经没了的）。返回是否接上了。 */
  function nextFromQueue(obs, turn) {
    while (queue.length) {
      const q = queue.shift();
      let cand;
      if (isWaitPlan(q)) {
        if (!W || totalWaited >= W.maxTotal) continue;
        cand = materializeWait(q, obs.self);
      } else cand = { targetType: q.targetType, target: q.target };
      if (!validatePlan(cand, obs).ok) continue;
      const rest = queue.slice();
      const dp = plan ? plan.dp : undefined;
      plan = {
        ...cand, reason: '按上次的计划接着走', follow: plan ? plan.follow : 'yes', abandonIf: plan ? plan.abandonIf : undefined,
        requestTurn: turn, appliedTurn: turn, source: 'queue', why: null, guarded: false, dp,
      };
      if (dp) {
        const ref = dlog.ref(cand.targetType, cand.target);
        dlog.push('queued', dp, turn - 1, { ref });
        dlog.bind(dp, ref);
      }
      stats.queued++;
      const head = isWaitPlan(cand) ? waitLine(cand) : { targetType: cand.targetType, target: cand.target };
      const line = { ...head, reason: plan.reason, ...(rest.length ? { then: rest } : {}), ...(plan.abandonIf ? { abandonIf: plan.abandonIf } : {}) };
      log.push({ n: turn, seat, requestTurn: turn, why: null, source: 'queue', plan: line, dp });
      track(turn, null, 'queue', line, obs, 'got');
      return true;
    }
    return false;
  }

  const planAlive = (obs) => plan && (plan.targetType === 'exit' || validatePlan(plan, obs).ok);

  function context(turn) {
    if (!contract) return undefined;
    const left = pool.remaining(seat);
    return {
      why: null,
      plan: plan
        ? {
          targetType: plan.targetType, target: plan.target, reason: plan.reason, turns: turn - plan.appliedTurn,
          ...(isWaitPlan(plan) ? { waited: plan.waited, waitTurns: plan.turns, ...(plan.guarded ? { guarded: 'time' } : {}) } : {}),
        }
        : null,
      ...(W ? { waitLeft: Math.max(0, W.maxTotal - totalWaited) } : {}),
      budget: callCap > 0 ? Math.min(left, Math.max(0, callCap - stats.requests - stats.repairs)) : left,
    };
  }

  return {
    kind: 'planner',
    wantsPatch: true,
    wantsFrames: true,
    autonomy,
    /** 调度器每采一帧调一次（§14 C5：判定当前目标拿到 / 被抢 / 到家）。只记录。 */
    onFrame(frame) {
      dlog.onFrame(frame);
      segment.push(frame);
    },
    /** 结果事件（只读，append-only）。 */
    get outcomes() { return dlog.events; },
    /** 已发出的决策点个数（= 最新 dp；还没问过为 0）。 */
    get decisionPoints() { return dlog.dp; },
    /** 最近收到的帧号（调度器交还控制器时据此补发漏掉的帧）。 */
    get frameK() { return dlog.frameK; },

    /**
     * 玩家接管 / 换成别的控制器（§14 C2，用户裁定「接管即作废，交还重问」）：
     * 撤销在途请求，当前计划作废；之后交还时下一回合按当时局面重新问（why 'resume'）。
     */
    cancel(cause = 'takeover') {
      const k = dlog.frameK;
      abortPending(cause, k);
      if (plan && plan.dp && dlog.bound) {
        dlog.push('interrupted', plan.dp, k, { cause });
        dlog.unbind();
      }
      plan = null;
      queue = [];
      prev = null;
      resume = true;
    },
    /** 对局关闭：撤销在途请求，之后一切回调都忽略。 */
    dispose() {
      if (disposed) return;
      abortPending('dispose', dlog.frameK);
      disposed = true;
    },

    /** 回合开始：判断要不要发新请求（事件 / 间隔 / 计划完成）。每回合恰好调用一次，在等待与决策之前。 */
    begin(obs, turn) {
      if (disposed) return;
      if (pool.l3) {
        pending = null;
        plan = null;
        return;
      }
      const me = obs.self;
      // 「对手接近」：进入近身范围（entityRadius）。批次 6 起对手位置全公开，「进入视野」不再有意义
      const R = cfg.vision.entityRadius;
      const vis = new Set();
      for (const o of obs.actors) if (o.visible && o.status === 'active' && cheb(o.x, o.y, me.x, me.y) <= R) vis.add(o.seat);
      if (contract) {
        tracker.observe(obs);
        for (const o of obs.actors) {
          if (!o.visible || o.status !== 'active') {
            hist.delete(o.seat);
            continue;
          }
          const h = hist.get(o.seat) || [];
          h.push([o.x, o.y]);
          if (h.length > H.trendTurns + 1) h.shift();
          hist.set(o.seat, h);
        }
      }
      // 等待到期 / 本局等待额度用完（SPEC-0.4）：结束这个决策；then 有下一个就接着走，否则下面按「计划完成」必问
      if (isWaitPlan(plan) && !plan.guarded && (plan.waited >= plan.turns || totalWaited >= W.maxTotal)) {
        const cause = plan.waited >= plan.turns ? 'expired' : 'cap';
        if (plan.dp && dlog.bound) {
          dlog.push('woken', plan.dp, turn - 1, { cause, waited: plan.waited });
          dlog.unbind();
        }
        log.push({ n: turn, seat, requestTurn: turn, why: null, source: 'wake', plan: null, err: cause, dp: plan.dp });
        if (tracker) tracker.wake(cause);
        if (!(contract && nextFromQueue(obs, turn))) plan = null;
      }
      let complete = !plan;
      let event = null;
      if (plan && plan.targetType !== 'exit' && !validatePlan(plan, obs).ok) {
        if (me.x === plan.target.x && me.y === plan.target.y) complete = !(contract && nextFromQueue(obs, turn));
        else {
          event = 'targetLost';
          queue = [];
        }
      }
      let abandoned = null;
      if (contract && !event && !complete && !pending) {
        const ab = abandonWhy(obs);
        abandoned = ab ? ab.text : null;
        if (abandoned) {
          stats.abandons++;
          tracker.abandon(abandoned);
          log.push({ n: turn, seat, requestTurn: turn, why: null, source: 'abandon', plan: null, err: abandoned, dp: plan.dp });
          if (plan.dp && dlog.bound) {
            dlog.push('abandoned', plan.dp, turn - 1, { seat: ab.seat, lead: ab.lead, need: ab.need });
            dlog.unbind();
          }
          plan = null;
          queue = [];
          complete = true;
        }
      }
      if (prev) {
        // 刷新（SPEC-0.4 必问）：单独检测，挂起「待问」；冷却中就等冷却结束再问，期间任何一次提问都会把它消化掉
        if (obs.gemGeneration > prev.gen || (obs.chest.present && !prev.chest)) refreshDue = true;
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
      // 正在那一格上等：对手接近 / 受阻 / 体力终盘都不问（这是玩家主动选的等），刷新照问
      const waiting = waitingNow(me);
      if (waiting && event !== 'targetLost') event = null;
      if (pending) return;

      const endgame = me.inEndgame;
      const interval = endgame ? A.replanIntervalEndgame : pool.pressure(seat) ? A.replanIntervalMax : A.replanInterval;
      let why = null;
      const cooled = turn - lastEventTurn >= A.eventCooldownTurns;
      // §14 C15（SPEC-0.4）：目标被抢、刷新必问 —— 不占每局事件次数；目标被抢连冷却也不看（只受「上次失败」的冷却，
      // 防止连续失败时每回合重发）；刷新若在冷却中就推迟到冷却结束（refreshDue 一直挂着）。
      // 对手接近 / 受阻 / 体力进终盘照旧：冷却中或次数用完就不问，也不补问。
      if (resume) why = 'resume';
      else if (abandoned) why = 'abandon';
      else if (complete && turn - lastFailTurn >= A.eventCooldownTurns) why = lastPlanTurn === -Infinity ? 'start' : 'complete';
      else if (event === 'targetLost') {
        if (turn - lastFailTurn >= A.eventCooldownTurns) why = 'targetLost';
      } else if (refreshDue && cooled) why = 'refresh';
      else if (event) {
        if (!cooled || eventsUsed >= A.eventBudgetPerAgent) stats.eventsSkipped++;
        else why = event;
      }
      if (!why && refreshDue && !cooled) stats.refreshDeferred++;
      // 已在回家路上：间隔重规划只会再答一次「回出口」，省掉；目标被抢 / 刷新 / 其他事件照常触发。
      // 等待（SPEC-0.4）：在等 / 往出口附近走 / 被时间闸门改回家，同样不定期问
      const homing = plan && (plan.targetType === 'exit' || plan.targetType === 'home' || waiting || (isWaitPlan(plan) && plan.guarded));
      if (!why && !homing && turn - lastPlanTurn >= interval) why = 'interval';
      if (!why) return;
      resume = false;
      if (capReached()) {
        stats.capped++;
        return;
      }
      if (!pool.take(seat, endgame)) {
        stats.denied++;
        return;
      }
      refreshDue = false; // 这次提问给的就是最新局面，挂着的刷新算问过了
      if (why === 'refresh' && waiting && plan.dp && dlog.bound) dlog.push('woken', plan.dp, turn - 1, { cause: 'refresh', waited: plan.waited });
      if (why === 'targetLost' || why === 'refresh') {
        lastEventTurn = turn; // 必问事件不占次数，但照样开启冷却（压住紧跟着的「对手接近」之类）
        stats.events++;
        stats.mustAsk++;
      } else if (why !== 'complete' && why !== 'interval' && why !== 'start' && why !== 'abandon' && why !== 'resume') {
        eventsUsed++;
        lastEventTurn = turn;
        stats.events++;
      }
      lastPlanTurn = turn;
      const ctx = context(turn);
      if (ctx) ctx.why = why;
      const dp = dlog.nextDp();
      send('plan', {
        requestTurn: turn, appliedTurn: turn + L, why, context: ctx, dp, rev: 0, ...packetFor(turn - 1, dp),
        payload: buildPayload(map, obs, cfg, contract ? { history: hist } : {}),
        session: contract ? sessionText(tracker.entries, memo, H.journalWindow) : undefined,
      });
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
        if (isWaitPlan(plan)) {
          // 等待（SPEC-0.4）：时间闸门 —— 剩余回合 ≤ 回家步数 + 余量 → 结束等待、改回出口（只改写一次）
          const left = obs.maxTurns - turn + 1;
          if (!plan.guarded && left <= me.distToExit + W.timeMargin) {
            plan.guarded = true;
            stats.guardPlans++;
            queue = [];
            if (plan.dp) {
              const ref = dlog.ref('exit', me.exit);
              dlog.push('guard', plan.dp, turn - 1, { cause: 'time', left, distToExit: me.distToExit, waited: plan.waited, ref });
              dlog.bind(plan.dp, ref);
            }
            if (contract) {
              const line = { targetType: 'exit', target: { x: me.exit.x, y: me.exit.y }, reason: '剩余回合只够回家，引擎结束等待、改为回家' };
              log.push({ n: turn, seat, requestTurn: turn, why: null, source: 'guard', plan: line, dp: plan.dp });
              track(turn, null, 'guard', line, obs, 'guard');
            }
          }
          if (plan.guarded) {
            source = 'guard';
            target = { type: 'exit', x: me.exit.x, y: me.exit.y };
            mode = 'home';
          } else if (me.x === t.x && me.y === t.y) {
            // 就在等的那一格：原地不动（不耗体力），计一回合
            plan.waited++;
            totalWaited++;
            last = { dir: STAY, mode: 'wait', target: { type: plan.targetType, x: t.x, y: t.y }, source: plan.source, reason: plan.source.startsWith('llm') ? plan.reason : '' };
            return last;
          } else {
            // home 还在往那一格走（或被挤开了回去）
            target = { type: plan.targetType, x: t.x, y: t.y };
            mode = 'home';
            source = plan.source;
          }
        } else if (plan.targetType === 'exit') {
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
              queue = [];
              if (plan.dp) {
                const ref = dlog.ref('exit', me.exit);
                dlog.push('guard', plan.dp, turn - 1, { dist: dTo, back: exitField[t.y * N + t.x], stamina: me.stamina, ref });
                dlog.bind(plan.dp, ref);
              }
              if (contract) {
                const line = { targetType: 'exit', target: { x: me.exit.x, y: me.exit.y }, reason: '体力不够去目标再回家，引擎改为回家' };
                log.push({ n: turn, seat, requestTurn: turn, why: null, source: 'guard', plan: line, dp: plan.dp });
                track(turn, null, 'guard', line, obs, 'guard');
              }
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
      let dir = stepToward(map, obs, target, cfg, st, mem);
      // home 往等待格走时绕路也不能踩进自己的出口（踩上就算到达，等待就没了）
      if (mode === 'home' && target.type === 'home' && dir !== STAY && me.x + DX[dir] === me.exit.x && me.y + DY[dir] === me.exit.y) dir = STAY;
      last = { dir, mode, target, source, reason: source.startsWith('llm') ? plan.reason : '' };
      return last;
    },

    /** 本回合新生效的计划（记录器写 plan 行）。 */
    takeLog() {
      return log.splice(0);
    },
    /** 自上次取走以来新增的结果事件（记录器写 outcome 行，§14 C9）。 */
    takeOutcomes() {
      const out = dlog.events.slice(outTaken);
      outTaken = dlog.events.length;
      return out;
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
        memo,
        queue: queue.length,
        abandonIf: plan && plan.abandonIf ? plan.abandonIf : null,
        wait: isWaitPlan(plan) && !plan.guarded ? { type: plan.targetType, waited: plan.waited, turns: plan.turns, total: totalWaited, max: W.maxTotal } : null,
        stats: { ...stats, eventsUsed, totalWaited, follow: { ...follow } },
      };
    },

    /** 本局会话（追踪器条目：每次决策的目标与结局）。复盘以记录重放为准（harness.timelineFromRecord），这里给对局中的 HUD 用。 */
    session() {
      return tracker ? { entries: tracker.entries.map((e) => ({ ...e })), memo } : null;
    },

    /** 思路执行报告（05 §8.3）：决策次数、遵循 / 部分 / 偏离 / 不合格 / 过期 / 引擎安全覆盖，偏离理由按回合。
     *  过期（stale）：回复合格，但生效时目标已被别人拿走，不算 AI 答错。SPEC-0.3 零缓冲后应为 0（请求与生效是同一局面）。 */
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
        queued: stats.queued,
        abandons: stats.abandons,
        kept: stats.kept,
        deviations: deviations.slice(),
      };
    },
  };
}
