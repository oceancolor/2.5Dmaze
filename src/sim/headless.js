// 无界面同步跑局：仿真 / 测试 / 平衡基线用。浏览器端的调度器（倍速、预取、等待）在阶段 2 另写。

import { STAY } from '../core/geom.js';
import { createMatch } from '../core/state.js';
import { step } from '../core/game.js';
import { observe } from '../core/observe.js';
import { stateHash } from '../core/hash.js';
import { rankActors } from '../core/scoring.js';
import { createHeuristic } from '../ai/heuristic.js';
import { createRecorder } from '../record/recorder.js';

/**
 * @param {number|string} seed
 * @param {object} cfg
 * @param {{controllers?: Array<{decide(obs:object): any}>, record?: boolean, hashes?: boolean, patch?: boolean,
 *          onTurn?: (prev:object, result:object, decisions:any[]) => void}} [opts]
 *   controller.decide 返回方向（'N'.. / 0..4）或 {dir, ...}
 */
export function runMatch(seed, cfg, opts = {}) {
  const match = createMatch(seed, cfg);
  const { map } = match;
  const n = match.state.actors.length;
  const ctrls = opts.controllers ?? Array.from({ length: n }, (_, i) => createHeuristic(map, i, cfg, match.seed));
  const rec = opts.record ? createRecorder(match, cfg) : null;
  const hashes = opts.hashes ? [] : null;
  const stats = {
    activeTurns: new Array(n).fill(0),
    blocked: new Array(n).fill(0),
    bumps: new Array(n).fill(0),
    homeTurns: new Array(n).fill(0),
    contests: 0,
    cycles: 0,
    gemRespawns: 0,
    chestRespawns: 0,
    deferred: 0,
  };

  let state = match.state;
  while (!state.ended) {
    const intents = new Array(n).fill(STAY);
    const decisions = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (state.actors[i].status !== 'active') continue;
      stats.activeTurns[i]++;
      const d = ctrls[i].decide(observe(map, state, i, cfg, { patch: !!opts.patch }));
      decisions[i] = d;
      if (d && typeof d === 'object') {
        intents[i] = d.dir;
        if (d.mode === 'home') stats.homeTurns[i]++;
      } else {
        intents[i] = d;
      }
    }
    const r = step(map, state, intents, cfg);
    for (const e of r.events) {
      switch (e.type) {
        case 'blocked':
          stats.blocked[e.seat]++;
          if (e.reason === 'contest') stats.contests++;
          else if (e.reason === 'cycle') stats.cycles++;
          break;
        case 'bump': stats.bumps[e.seat]++; break;
        case 'gemRespawn': stats.gemRespawns++; break;
        case 'chestRespawn': stats.chestRespawns++; break;
        case 'gemRespawnDeferred':
        case 'chestRespawnDeferred': stats.deferred++; break;
        default: break;
      }
    }
    if (rec || hashes) {
      const h = stateHash(r.state);
      if (rec) rec.turn(state.turn, intents, state.actors, h);
      if (hashes) hashes.push(h);
    }
    if (opts.onTurn) opts.onTurn(state, r, decisions);
    state = r.state;
  }
  if (rec) rec.end(state);
  return { match, state, ranking: rankActors(state.actors, cfg), stats, record: rec ? rec.toJSONL() : null, hashes };
}
