// 脚本座位的「裁判」（浏览器宿主与 Node 适配器共用，保证两边处理一致）：
// 预算记账（时间银行）、超时 / 异常 / 无效返回的兜底、降级、统计。不碰 Worker、不读时钟（耗时由宿主测好传进来）。
//
// 兜底决策：沿着脚本最后一次声明的有效意图走（引擎寻路 + 让行）；没有意图、或意图目标已经没了 → 回自己的出口。
// 降级：
//   L1 自动回家  累计 l1CumulativeSoft 次软异常（返回值无效 / v1 state 超限）；或运行环境重建达到 maxResets；
//                或非玩家座位连续 l2ConsecutiveHard 次硬异常
//   L2 切回手动  只对玩家座位：连续 l2ConsecutiveHard 次硬异常（抛错 / 卡死）
// mode：'enforce' 超支当回合作废走兜底；'measure'（本机评测）不作废，只记「按正式预算会超时」的回合。

import { STAY, toDir } from '../../core/geom.js';
import { STREAM, createStream, subSeed } from '../../core/rng.js';
import { stepToward } from '../../ai/heuristic.js';
import { BUDGET, budgetView, chargeTurn } from './budget.js';

const OVER_LIST_MAX = 50;

/**
 * @param {{map:object, seat:number, cfg:object, seed:number, mode?:'enforce'|'measure', isPlayer?:boolean,
 *          budget?:object, onEvent?:(e:object)=>void}} o
 */
export function createGovernor({ map, seat, cfg, seed, mode = 'enforce', isPlayer = false, budget = BUDGET, onEvent = null }) {
  const S = cfg.script;
  const st = createStream(subSeed(subSeed(seed >>> 0, STREAM.AI), seat));
  const mem = { yieldSeat: -1, yieldLeft: 0 };
  const emit = (e) => onEvent && onEvent({ seat, ...e });
  let bank = 0;
  let level = 'script'; // script | auto-home | manual
  let intent = null;
  let bag = null;
  let last = null;
  const ms = [];
  const counts = {
    ok: 0, hard: 0, hardStreak: 0, soft: 0, timeouts: 0, resets: 0, initMs: 0, initError: null, initSkipped: false,
    avgMs: 0, maxMs: 0, overBudgetTurns: [], usedClock: false, warns: 0, errors: [],
  };
  let wantsManual = null;
  const noteError = (turn, kind, msg) => {
    if (counts.errors.length < 5) counts.errors.push({ turn, kind, msg: String(msg).slice(0, 200) });
  };

  function degrade(to, why) {
    if (level !== 'script') return;
    level = to;
    if (to === 'manual') wantsManual = why;
    emit({ type: 'degrade', level: to === 'manual' ? 'L2' : 'L1', reason: why });
  }

  function intentTarget(obs) {
    const me = obs.self;
    const home = { type: 'exit', x: me.exit.x, y: me.exit.y };
    if (!intent || level !== 'script') return home;
    if (intent.type === 'gem' && !obs.gems.some((g) => g.x === intent.x && g.y === intent.y)) return home;
    if (intent.type === 'chest' && !(obs.chest.present && obs.chest.x === intent.x && obs.chest.y === intent.y)) return home;
    if (intent.type === 'exit' && !(intent.x === me.exit.x && intent.y === me.exit.y)) return home;
    if (!map.grid[intent.y * map.size + intent.x]) return home;
    return intent;
  }

  function fallback(obs, source, error) {
    const target = intentTarget(obs);
    const dir = stepToward(map, obs, target, cfg, st, mem);
    last = { source, target, error: error ?? null };
    return { dir, source, mode: target.type === 'exit' ? 'home' : 'collect', target, error };
  }

  return {
    get level() { return level; },
    get wantsManual() { return wantsManual; },
    get intent() { return intent; },
    get bag() { return bag; },
    budget: () => budgetView(bank, budget),
    hangMs: () => budget.baseMs + bank + budget.hangGraceMs,

    noteInit(r) {
      counts.initMs = Math.round(r.ms || 0);
      if (r.clock) counts.usedClock = true;
      if (r.error) {
        counts.initError = r.error;
        emit({ type: 'hard', turn: 0, error: `init：${r.error}`, streak: 0 });
      }
      if (r.skipped) {
        counts.initSkipped = true;
        emit({ type: 'warn', turn: 0, error: r.skipped });
      }
    },

    /** 运行环境卡死并已重建（模块变量丢失）。这一回合的硬异常由 settle 计，这里只计重建次数。 */
    noteReset(turn, why) {
      counts.resets++;
      emit({ type: 'reset', turn, error: why, total: counts.resets });
      if (counts.resets >= budget.maxResets) degrade('auto-home', `运行环境重建 ${counts.resets} 次`);
    },

    /**
     * 本回合裁决。res = 宿主拿到的结果（runtime.callDecide 的返回，或 {error}，或 null = 没拿到）。
     * @returns {{dir:number, source:string, mode?:string, target?:object, ms?:number, intent?:object|null, error?:string}}
     */
    settle(turn, obs, res) {
      if (level === 'manual') return { dir: STAY, source: 'manual-pending' };
      if (level === 'auto-home') return fallback(obs, 'auto-home');
      const r = res ?? { error: '没有结果' };
      if (r.clock) counts.usedClock = true;
      if (r.warn) {
        counts.warns++;
        emit({ type: 'warn', turn, error: r.warn });
      }
      if (r.error) {
        counts.hard++;
        counts.hardStreak++;
        noteError(turn, 'hard', r.error);
        emit({ type: 'hard', turn, error: r.error, streak: counts.hardStreak });
        if (counts.hardStreak >= S.l2ConsecutiveHard) {
          degrade(isPlayer ? 'manual' : 'auto-home', `连续 ${S.l2ConsecutiveHard} 次硬异常`);
          if (level === 'manual') return { dir: STAY, source: 'manual-pending' };
        }
        return fallback(obs, 'script-error', r.error);
      }
      counts.hardStreak = 0;
      const t = r.ms || 0;
      ms.push(t);
      counts.maxMs = Math.max(counts.maxMs, t);
      counts.avgMs += (t - counts.avgMs) / ms.length;
      const c = chargeTurn(bank, t, budget);
      bank = c.bank;
      if (!c.ok) {
        counts.timeouts++;
        if (counts.overBudgetTurns.length < OVER_LIST_MAX) counts.overBudgetTurns.push(turn);
        if (mode === 'enforce') {
          const why = `超时（${Math.round(t)} ms，超出可用预算 ${Math.round(c.overrun)} ms）`;
          emit({ type: 'timeout', turn, error: why });
          return fallback(obs, 'script-timeout', why);
        }
      }
      // v1 state 包（≤ stateBagKB）
      let softWhy = null;
      if (r.bag !== undefined && r.bag !== bag) {
        let size = 0;
        try {
          size = JSON.stringify(r.bag ?? null)?.length ?? 0;
        } catch {
          size = Infinity;
        }
        if (size > S.stateBagKB * 1024) softWhy = `state 超过 ${S.stateBagKB} KB，已丢弃`;
        else bag = r.bag;
      }
      if (r.invalid) softWhy = r.invalid;
      if (softWhy) {
        counts.soft++;
        noteError(turn, 'soft', softWhy);
        emit({ type: 'soft', turn, error: softWhy, total: counts.soft });
        if (counts.soft >= S.l1CumulativeSoft) degrade('auto-home', `累计 ${S.l1CumulativeSoft} 次软异常，引擎接管自动回家`);
        if (r.invalid) return fallback(obs, 'script-invalid', r.invalid);
      }
      counts.ok++;
      if (r.intent) intent = r.intent;
      last = { source: 'script', target: intent, error: null };
      return { dir: toDir(r.move), source: 'script', ms: t, intent };
    },

    status() {
      const src = level === 'script' ? (last ? last.source : 'script') : level;
      return {
        source: src,
        target: intent && level === 'script' ? intent : last && last.target ? last.target : null,
        reason: intent && intent.note ? intent.note : '',
        mode: level,
        counts: { ...counts, overBudgetTurns: counts.overBudgetTurns.slice(), errors: counts.errors.slice(), bankMs: Math.round(bank) },
      };
    },

    /** 每回合耗时样本（评测汇总用）。 */
    samples: () => ms.slice(),

    /** 评测 / 报告用的耗时分位数。 */
    timing() {
      const s = ms.slice().sort((a, b) => a - b);
      const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
      return { turns: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? s[s.length - 1] : 0, total: s.reduce((a, b) => a + b, 0) };
    },
  };
}
