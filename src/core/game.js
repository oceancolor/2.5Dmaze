// 回合结算（SPEC §4）。step 是纯函数：不修改 prev，返回新状态。
//   1 意图 → 2 合法化 → 3 仲裁 → 4 位移 → 5 体力/失败 → 6 拾取 → 7 重生/达成/终局

import { DX, DY, STAY, toDir } from './geom.js';
import { next, randInt } from './rng.js';
import { arbitrate } from './arbitrate.js';
import { cloneState } from './state.js';
import { placeRespawn } from './maze/place.js';
import { refreshMemory, broadcastPosition } from './vision.js';

const atOwnExit = (map, a) => a.x === map.exits[a.seat][0] && a.y === map.exits[a.seat][1];

function finish(a, turn, status, reason) {
  a.status = status;
  a.endTurn = turn;
  if (status === 'escaped') a.escapedTurn = turn;
  else a.failReason = reason;
}

/**
 * @param {object} map
 * @param {object} prev 对局状态（不被修改）
 * @param {Array<string|number|undefined>} intents 各座位意图：'N'|'E'|'S'|'W'|'STAY' 或 0..4；非在场座位忽略
 * @param {object} cfg
 * @returns {{state:object, events:object[], dirs:number[], moved:boolean[]}}
 */
export function step(map, prev, intents, cfg) {
  if (prev.ended) throw new Error('step() called on an ended match');
  const s = cloneState(prev);
  const N = map.size;
  const g = map.grid;
  const A = s.actors;
  const n = A.length;
  const turn = s.turn;
  const T = cfg.treasure;
  const events = [];

  // 1–2 意图与合法化（撞墙 / 越界 / 体力 0 → STAY，不扣体力）
  const pos = new Array(n).fill(-1);
  const dirs = new Array(n).fill(STAY);
  const bumped = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const a = A[i];
    if (a.status !== 'active') continue;
    pos[i] = a.y * N + a.x;
    let d = toDir(intents ? intents[i] : undefined);
    if (d < 0) { events.push({ type: 'invalidIntent', seat: i }); d = STAY; }
    if (d !== STAY) {
      const nx = a.x + DX[d];
      const ny = a.y + DY[d];
      if (a.stamina <= 0 || nx < 0 || ny < 0 || nx >= N || ny >= N || !g[ny * N + nx]) {
        events.push({ type: 'bump', seat: i, dir: d });
        bumped[i] = true;
        d = STAY;
      }
    }
    dirs[i] = d;
  }

  // 3–4 仲裁与同时位移
  const arb = arbitrate(pos, dirs, N);
  for (let i = 0; i < n; i++) {
    const a = A[i];
    if (a.status !== 'active') continue;
    if (arb.moved[i]) {
      const t = arb.target[i];
      a.x = t % N;
      a.y = (t / N) | 0;
      a.stamina -= cfg.rules.moveCost;
      a.moves++;
      a.lastDir = dirs[i];
      a.blockedStreak = 0;
    } else {
      a.lastDir = STAY;
      if (dirs[i] !== STAY) {
        a.blockedStreak++;
        events.push({ type: 'blocked', seat: i, reason: arb.reason[i] });
      } else if (bumped[i]) {
        a.blockedStreak++;
      } else {
        a.blockedStreak = 0;
      }
    }
  }

  // 5 体力归零且不在自己出口 → 失败离场（最后一步正好踩上出口不算失败）
  for (const a of A) {
    if (a.status !== 'active' || a.stamina > 0 || atOwnExit(map, a)) continue;
    a.stamina = 0;
    finish(a, turn, 'failed', 'stamina');
    events.push({ type: 'failed', seat: a.seat, reason: 'stamina' });
  }

  // 6 拾取：座位序；第 5 阶段已失败者不参与
  for (const a of A) {
    if (a.status !== 'active') continue;
    for (let k = 0; k < s.gems.length; k++) {
      const gm = s.gems[k];
      if (gm.x !== a.x || gm.y !== a.y) continue;
      s.gems.splice(k, 1);
      a.gems[gm.c]++;
      events.push({ type: 'pickup', seat: a.seat, color: gm.c, x: a.x, y: a.y });
      broadcastPosition(s, a.seat, turn);
      break;
    }
    const ch = s.chest;
    if (ch.present && ch.x === a.x && ch.y === a.y) {
      const C = T.chest;
      let ev;
      if (next(s.rng.chest) < C.pScore) {
        const v = randInt(s.rng.chest, C.scoreRange[0], C.scoreRange[1]);
        a.chestScore += v;
        ev = { kind: 'score', value: v };
      } else {
        const v = randInt(s.rng.chest, C.staminaRange[0], C.staminaRange[1]);
        const before = a.stamina;
        a.stamina = Math.min(a.staminaMax, a.stamina + v);
        a.chestStamina += a.stamina - before;
        ev = { kind: 'stamina', value: v, gained: a.stamina - before };
      }
      a.chestOpens++;
      ch.present = false;
      ch.openedTurn = turn;
      events.push({ type: 'chest', seat: a.seat, x: a.x, y: a.y, ...ev });
      broadcastPosition(s, a.seat, turn);
    }
  }

  // 7a 重生（放不下则顺延到下一回合，距角色下限永不放宽）
  const actorCells = [];
  for (const a of A) if (a.status === 'active') actorCells.push(a.y * N + a.x);
  if (s.gems.length === 0 && s.gemRespawnsLeft > 0) {
    const existing = s.chest.present ? [s.chest.y * N + s.chest.x] : [];
    const r = placeRespawn(map, s.rng.place, cfg, {
      count: T.gemColors.length * T.gemsPerColor,
      minActorDist: T.gemRespawnMinActorDist,
      actorCells,
      existingCells: existing,
    });
    if (r) {
      s.gems = r.cells.map((c, k) => ({ c: k % T.gemColors.length, x: c % N, y: (c / N) | 0 }));
      s.gemGeneration++;
      s.gemRespawnsLeft--;
      events.push({ type: 'gemRespawn', generation: s.gemGeneration, sep: r.sep });
    } else {
      events.push({ type: 'gemRespawnDeferred' });
    }
  }
  const ch = s.chest;
  if (!ch.present && ch.respawnsLeft > 0 && turn >= ch.openedTurn + T.chest.respawnTurns) {
    const r = placeRespawn(map, s.rng.place, cfg, {
      count: 1,
      minActorDist: T.chest.respawnMinActorDist,
      actorCells,
      existingCells: s.gems.map((gm) => gm.y * N + gm.x),
    });
    if (r) {
      ch.present = true;
      ch.x = r.cells[0] % N;
      ch.y = (r.cells[0] / N) | 0;
      ch.respawnsLeft--;
      events.push({ type: 'chestRespawn', x: ch.x, y: ch.y, sep: r.sep });
    } else {
      events.push({ type: 'chestRespawnDeferred' });
    }
  }

  // 7b 达成离场
  for (const a of A) {
    if (a.status === 'active' && atOwnExit(map, a)) {
      finish(a, turn, 'escaped');
      events.push({ type: 'escaped', seat: a.seat });
    }
  }

  // 7c 回合上限
  if (turn >= cfg.rules.maxTurns) {
    for (const a of A) {
      if (a.status !== 'active') continue;
      finish(a, turn, 'failed', 'maxTurns');
      events.push({ type: 'failed', seat: a.seat, reason: 'maxTurns' });
    }
  }

  refreshMemory(s, cfg.vision.entityRadius, turn);

  if (A.every((a) => a.status !== 'active')) {
    s.ended = true;
    s.endTurn = turn;
    events.push({ type: 'end', turn });
  } else {
    s.turn = turn + 1;
  }
  return { state: s, events, dirs, moved: arb.moved };
}
