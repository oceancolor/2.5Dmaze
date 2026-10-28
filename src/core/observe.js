// 观察构造器（SPEC §6.2）：手动 UI / 脚本 / 提示词托管 / LLM AI 共用这一份，任何通道拿不到超出它的信息。

import { DIR_NAMES, cheb } from './geom.js';
import { fieldFrom } from './nav/bfs.js';
import { scoreOf, setsOf } from './scoring.js';

function publicInfo(a, cfg) {
  return {
    score: scoreOf(a, cfg),
    stamina: a.stamina,
    staminaMax: a.staminaMax,
    gems: a.gems.slice(),
    sets: setsOf(a.gems),
    status: a.status,
  };
}

/** 以 (cx,cy) 为中心的 P×P 地形窗：'#' 墙/界外，'.' 地板。 */
export function terrainPatch(map, cx, cy, P) {
  const N = map.size;
  const half = (P - 1) >> 1;
  const originX = cx - half;
  const originY = cy - half;
  const rows = [];
  for (let y = originY; y < originY + P; y++) {
    let row = '';
    for (let x = originX; x < originX + P; x++) {
      row += x >= 0 && y >= 0 && x < N && y < N && map.grid[y * N + x] ? '.' : '#';
    }
    rows.push(row);
  }
  return { originX, originY, w: P, h: P, rows };
}

/**
 * @param {object} map
 * @param {object} state
 * @param {number} seat
 * @param {object} cfg
 * @param {{patch?: boolean}} [opts] patch=false 时省略地形窗（仿真提速用）
 */
export function observe(map, state, seat, cfg, opts = {}) {
  const N = map.size;
  const A = state.actors;
  const me = A[seat];
  const R = cfg.vision.entityRadius;
  const colors = cfg.treasure.gemColors;
  const selfIdx = me.y * N + me.x;
  const [ex, ey] = map.exits[seat];
  const distToExit = fieldFrom(map, ey * N + ex)[selfIdx];

  const self = {
    seat,
    x: me.x,
    y: me.y,
    ...publicInfo(me, cfg),
    exit: { x: ex, y: ey },
    distToExit,
    lowStamina: me.stamina < distToExit,
    inEndgame: me.stamina * 10 <= distToExit * cfg.ai.homeFactorX10,
    blockedStreak: me.blockedStreak,
  };

  const actors = [];
  for (let j = 0; j < A.length; j++) {
    if (j === seat) continue;
    const o = A[j];
    const entry = { seat: j, ...publicInfo(o, cfg) };
    if (me.status === 'active' && o.status === 'active' && cheb(me.x, me.y, o.x, o.y) <= R) {
      entry.visible = true;
      entry.x = o.x;
      entry.y = o.y;
      entry.lastDir = DIR_NAMES[o.lastDir];
    } else {
      entry.visible = false;
      const m = state.memory[seat][j];
      entry.lastSeen = m ? { x: m[0], y: m[1], turnsSince: state.turn - m[2] } : null;
    }
    actors.push(entry);
  }

  const gems = state.gems.map((gm) => ({
    c: gm.c,
    color: colors[gm.c],
    x: gm.x,
    y: gm.y,
    dist: fieldFrom(map, gm.y * N + gm.x)[selfIdx],
  }));

  const ch = state.chest;
  const chest = ch.present
    ? { present: true, x: ch.x, y: ch.y, dist: fieldFrom(map, ch.y * N + ch.x)[selfIdx] }
    : { present: false, respawnAtTurn: ch.respawnsLeft > 0 ? ch.openedTurn + cfg.treasure.chest.respawnTurns : null };

  const obs = {
    turn: state.turn,
    maxTurns: cfg.rules.maxTurns,
    self,
    actors,
    gems,
    gemGeneration: state.gemGeneration,
    gemRespawnsLeft: state.gemRespawnsLeft,
    chest,
  };
  if (opts.patch !== false) obs.terrainPatch = terrainPatch(map, me.x, me.y, cfg.vision.terrainPatch);
  return obs;
}
