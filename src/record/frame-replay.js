// 从录像重建决策帧（决策协议改造 §14 C9，第 6 项）：帧不入录像，需要时由「严格回放 + 逐回合 observe 投影」重建。
// 与对局中实时采集的帧逐字段一致（同一个 observe → toFrame），所以已入库的对局也能给 maze_frames / timeline 用。
//
//   v3 录像：结果事件取自 outcome 行（对局中实际记下的）；决策锚点 anchors = 'recorded'
//   v1 / v2 录像：没有 outcome 行与 dp，只给帧；anchors = 'derived'（复盘只能从 plan 行推导，不伪造结果事件）

import { createMatch } from '../core/state.js';
import { step } from '../core/game.js';
import { observe } from '../core/observe.js';
import { stateHash, configHash } from '../core/hash.js';
import { createFrameLog, toFrame } from '../ai/decision-frames.js';
import { decodeIntents, RECORD_VERSIONS } from './recorder.js';
import { ReplayMismatch } from './replayer.js';

/**
 * @param {string} jsonl 录像
 * @param {object} cfg 录像对应的配置（configHash 必须一致）
 * @param {number[]} seats 重建哪些座位的帧
 * @returns {{meta:object, frames:object, outcomes:Map<number, object[]>, plans:object[], anchors:'recorded'|'derived', endTurn:number}}
 */
export function framesFromRecord(jsonl, cfg, seats = [0]) {
  const lines = String(jsonl).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const meta = lines[0];
  if (!meta || meta.t !== 'meta' || !RECORD_VERSIONS.includes(meta.v)) throw new ReplayMismatch('不是可识别的录像', 0);
  if (meta.configHash !== configHash(cfg)) throw new ReplayMismatch('configHash mismatch', 0, meta.configHash, configHash(cfg));
  const { map, state: s0 } = createMatch(meta.seed, cfg);
  if (map.hash !== meta.mapHash) throw new ReplayMismatch('mapHash mismatch', 0, meta.mapHash, map.hash);
  const frames = createFrameLog(seats);
  let state = s0;
  const push = (events, k) => {
    for (const i of seats) frames.push(i, toFrame(observe(map, state, i, cfg, { patch: false, events }), k));
  };
  push([], 0);
  const outcomes = new Map(seats.map((i) => [i, []]));
  const plans = [];
  for (const L of lines.slice(1)) {
    if (L.t === 'turn') {
      if (L.n !== state.turn) throw new ReplayMismatch(`turn number ${L.n} != expected ${state.turn}`, L.n);
      const r = step(map, state, decodeIntents(L.i), cfg);
      if (stateHash(r.state) !== L.h) throw new ReplayMismatch(`state hash mismatch at turn ${L.n}`, L.n);
      state = r.state;
      push(r.events, L.n);
    } else if (L.t === 'outcome' && outcomes.has(L.seat)) {
      const { t, seat, ...e } = L;
      outcomes.get(seat).push(e);
    } else if (L.t === 'plan' && outcomes.has(L.seat)) {
      plans.push(L);
    }
  }
  return { meta, frames, outcomes, plans, anchors: meta.v >= 3 ? 'recorded' : 'derived', endTurn: state.ended ? state.endTurn : state.turn - 1 };
}
