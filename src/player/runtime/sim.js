// api.sim.step(belief, moves)：单回合规则推演（统一编程接口 v2 第一层）。
// 底层就是对局真正的结算函数 step()（同格冲突、对穿 / 环、链式让位、撞墙不扣体力、体力归零出局、
// 最后一步踩上自己出口算到达、座位序拾取、回合上限）。规则本来公开，sim 不多给任何信息：
//   - 局面只来自脚本自己的观察 + 脚本给的假设（belief）；默认只有视野内的对手参与推演，
//     视野外的对手要你在 belief.actors 里给出假设位置（比如用 lastSeen 或自己的推断）才参与
//   - 开箱结果不预知：事件里给「得分 / 加体力」两个分支与概率，推演结果按「开箱前」的分数 / 体力给出
//   - 宝石 / 宝箱刷新不预知位置：推演时关闭刷新，只用 respawn 标记告诉你「这一回合会刷新」
//   - 随机数用固定哑种子，不暴露对局真实随机流
// 结果与输入同形，可以把结果当作下一次的 belief 自己串起来做多步推演。

import { step } from '../../core/game.js';
import { toDir } from '../../core/geom.js';
import { gemTotal, scoreOf, setsOf } from '../../core/scoring.js';

const MOVES = new Set(['N', 'E', 'S', 'W', 'STAY']);

function fail(msg) {
  throw new Error(`sim.step：${msg}`);
}

const chestScoreOf = (score, gems, T) => score - gemTotal(gems) * T.gemScore - T.setBonus * setsOf(gems);

/** obs + belief → 各座位的推演起点（null = 不知道位置，不参与）。 */
function seedActors(obs, belief, n, T) {
  const base = new Array(n).fill(null);
  const me = obs.self;
  base[me.seat] = {
    seat: me.seat, x: me.x, y: me.y, stamina: me.stamina, staminaMax: me.staminaMax, gems: me.gems.slice(),
    chestScore: chestScoreOf(me.score, me.gems, T), status: me.status ?? 'active', blockedStreak: me.blockedStreak ?? 0, known: true,
  };
  for (const o of obs.actors) {
    // 默认只用视野内的真身；最后目击位置可能早已过时（还会和别人重叠），要用就自己在 belief 里给出
    const pos = o.visible ? { x: o.x, y: o.y } : null;
    base[o.seat] = {
      seat: o.seat, x: pos ? pos.x : -1, y: pos ? pos.y : -1, stamina: o.stamina, staminaMax: o.staminaMax, gems: o.gems.slice(),
      chestScore: chestScoreOf(o.score, o.gems, T), status: o.status, blockedStreak: 0, known: Boolean(pos),
    };
  }
  const given = Array.isArray(belief.actors) ? belief.actors : belief.actors ? Object.entries(belief.actors).map(([k, v]) => ({ seat: Number(k), ...v })) : [];
  for (const b of given) {
    if (!b || !Number.isInteger(b.seat) || b.seat < 0 || b.seat >= n) fail('belief.actors 里的 seat 必须是 0..3');
    const a = base[b.seat];
    if (Number.isInteger(b.x) && Number.isInteger(b.y)) {
      a.x = b.x;
      a.y = b.y;
      a.known = true;
    }
    if (b.stamina !== undefined) {
      if (!Number.isInteger(b.stamina) || b.stamina < 0) fail(`座位 ${b.seat} 的 stamina 必须是非负整数`);
      a.stamina = b.stamina;
    }
    if (b.gems !== undefined) {
      if (!Array.isArray(b.gems) || b.gems.length !== T.gemColors.length || !b.gems.every((v) => Number.isInteger(v) && v >= 0)) fail(`座位 ${b.seat} 的 gems 必须是 ${T.gemColors.length} 个非负整数`);
      a.gems = b.gems.slice();
    }
    if (b.chestScore !== undefined && Number.isInteger(b.chestScore)) a.chestScore = b.chestScore;
    if (b.status !== undefined) {
      if (!['active', 'escaped', 'failed'].includes(b.status)) fail(`座位 ${b.seat} 的 status 只能是 active / escaped / failed`);
      a.status = b.status;
    }
    if (Number.isInteger(b.blockedStreak)) a.blockedStreak = b.blockedStreak;
  }
  return base;
}

/**
 * @param {{map:{size:number, grid:Uint8Array, exits:number[][], spawns:number[][]}, cfg:object}} env
 * @returns {(obs:object, belief?:object, moves?:Array|object) => object}
 */
export function createSim({ map, cfg }) {
  const N = map.size;
  const T = cfg.treasure;
  const n = map.spawns.length;

  return function simStep(obs, belief = {}, moves = {}) {
    if (!belief || typeof belief !== 'object') fail('belief 必须是对象');
    const turn = Number.isInteger(belief.turn) ? belief.turn : obs.turn;
    if (turn > cfg.rules.maxTurns) fail(`turn ${turn} 超过回合上限 ${cfg.rules.maxTurns}`);
    const seeds = seedActors(obs, belief, n, T);

    const actors = seeds.map((a, seat) => {
      const live = a.status === 'active' && a.known;
      if (live) {
        if (!Number.isInteger(a.x) || !Number.isInteger(a.y) || a.x < 0 || a.y < 0 || a.x >= N || a.y >= N) fail(`座位 ${seat} 的位置越界`);
        if (!map.grid[a.y * N + a.x]) fail(`座位 ${seat} 的位置 (${a.x}, ${a.y}) 是墙`);
      }
      return {
        seat, x: live ? a.x : -1, y: live ? a.y : -1, stamina: a.stamina, staminaMax: a.staminaMax, gems: a.gems.slice(),
        chestScore: a.chestScore, chestStamina: 0, chestOpens: 0,
        // 不知道位置的在场对手按「不在场」处理（step 会忽略它），结果里标 known:false
        status: live ? 'active' : a.status === 'active' ? 'escaped' : a.status,
        escapedTurn: 0, endTurn: 0, failReason: '', moves: 0, blockedStreak: a.blockedStreak, lastDir: 4,
      };
    });
    const cells = new Map();
    for (const a of actors) {
      if (a.status !== 'active') continue;
      const k = a.y * N + a.x;
      if (cells.has(k)) fail(`座位 ${cells.get(k)} 与座位 ${a.seat} 位置重叠 (${a.x}, ${a.y})`);
      cells.set(k, a.seat);
    }

    const gemsIn = belief.gems ?? obs.gems;
    if (!Array.isArray(gemsIn)) fail('belief.gems 必须是数组');
    const gems = gemsIn.map((g) => {
      const c = Number.isInteger(g.c) ? g.c : T.gemColors.indexOf(g.color);
      if (c < 0 || c >= T.gemColors.length || !Number.isInteger(g.x) || !Number.isInteger(g.y)) fail('宝石需要 c（或 color）与整数 x / y');
      return { c, x: g.x, y: g.y };
    });
    const chIn = belief.chest ?? obs.chest;
    const chest = chIn && chIn.present
      ? { present: true, x: chIn.x, y: chIn.y, openedTurn: 0, respawnsLeft: 0 }
      : { present: false, x: -1, y: -1, openedTurn: 0, respawnsLeft: 0 };

    const intents = new Array(n).fill('STAY');
    const entries = Array.isArray(moves) ? moves.map((m, seat) => [seat, m]) : Object.entries(moves || {}).map(([k, m]) => [Number(k), m]);
    for (const [seat, m] of entries) {
      if (!Number.isInteger(seat) || seat < 0 || seat >= n) fail('moves 的座位必须是 0..3');
      if (m === undefined || m === null) continue;
      const v = typeof m === 'string' ? m.toUpperCase() : m;
      if (!MOVES.has(v) || toDir(v) < 0) fail(`座位 ${seat} 的移动 ${JSON.stringify(m)} 不是 N/E/S/W/STAY`);
      intents[seat] = v;
    }

    const state = {
      turn, ended: false, endTurn: 0, actors, gems,
      gemGeneration: belief.gemGeneration ?? obs.gemGeneration, gemRespawnsLeft: 0, chest,
      rng: { place: { s: 1 }, chest: { s: 1 } },
      memory: actors.map(() => actors.map(() => null)),
    };
    const r = step(map, state, intents, cfg);
    const s = r.state;

    const events = [];
    for (const e of r.events) {
      if (e.type === 'end' || e.type === 'gemRespawnDeferred' || e.type === 'chestRespawnDeferred') continue;
      if (e.type === 'chest') {
        // 撤掉哑种子开出来的结果，改为两个分支
        const a = s.actors[e.seat];
        if (e.kind === 'score') a.chestScore -= e.value;
        else {
          a.stamina -= e.gained;
          a.chestStamina -= e.gained;
        }
        const C = T.chest;
        events.push({
          type: 'chest', seat: e.seat, x: e.x, y: e.y,
          branches: [
            { kind: 'score', p: C.pScore, range: C.scoreRange.slice() },
            { kind: 'stamina', p: 1 - C.pScore, range: C.staminaRange.slice() },
          ],
        });
        continue;
      }
      events.push({ ...e });
    }

    const respawn = {};
    const gemLeft = Number.isInteger(belief.gemRespawnsLeft) ? belief.gemRespawnsLeft : obs.gemRespawnsLeft;
    if (s.gems.length === 0 && gemLeft > 0) respawn.gems = true;
    const respawnAt = chIn && !chIn.present ? chIn.respawnAtTurn ?? null : null;
    if (!s.chest.present && respawnAt !== null && turn >= respawnAt) respawn.chest = true;

    return {
      turn: s.ended ? turn : s.turn,
      ended: s.ended,
      actors: s.actors.map((a, seat) => ({
        seat, known: seeds[seat].known || seeds[seat].status !== 'active',
        x: a.status === 'active' ? a.x : seeds[seat].x, y: a.status === 'active' ? a.y : seeds[seat].y,
        status: seeds[seat].known || seeds[seat].status !== 'active' ? a.status : 'active',
        stamina: a.stamina, gems: a.gems.slice(), chestScore: a.chestScore, score: scoreOf(a, cfg),
        moved: Boolean(r.moved[seat]), blockedStreak: a.blockedStreak,
      })),
      gems: s.gems.map((g) => ({ c: g.c, color: T.gemColors[g.c], x: g.x, y: g.y })),
      chest: s.chest.present ? { present: true, x: s.chest.x, y: s.chest.y } : { present: false, respawnAtTurn: respawnAt },
      gemGeneration: s.gemGeneration,
      gemRespawnsLeft: gemLeft - (respawn.gems ? 1 : 0),
      events,
      ...(respawn.gems || respawn.chest ? { respawn } : {}),
    };
  };
}
