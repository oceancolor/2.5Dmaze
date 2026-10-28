// 对局记录（JSONL，SPEC §12）。每回合一行：原始意图（紧凑串）+ 结算后状态哈希。
//   {"t":"meta","v":1,"rulesVersion","seed","configHash","mapHash","attempts"}
//   {"t":"turn","n":12,"i":"NE.-","h":"a1b2c3d4"}
//   {"t":"end","n":388,"ranking":[...]}

import { DIR_CHARS, OFF_BOARD_CHAR, toDir } from '../core/geom.js';
import { configHash } from '../core/hash.js';
import { rankActors } from '../core/scoring.js';

export const RECORD_VERSION = 1;

export function encodeIntents(intents, actors) {
  let out = '';
  for (let i = 0; i < actors.length; i++) {
    if (actors[i].status !== 'active') { out += OFF_BOARD_CHAR; continue; }
    const d = toDir(intents[i]);
    out += DIR_CHARS[d < 0 ? 4 : d];
  }
  return out;
}

export function decodeIntents(str) {
  return Array.from(str, (ch) => (ch === OFF_BOARD_CHAR ? 'STAY' : ch));
}

export function createRecorder(match, cfg) {
  const lines = [
    JSON.stringify({
      t: 'meta',
      v: RECORD_VERSION,
      rulesVersion: cfg.rulesVersion,
      seed: match.seed,
      configHash: configHash(cfg),
      mapHash: match.map.hash,
      attempts: match.attempts,
    }),
  ];
  return {
    lines,
    turn(n, intents, actors, hash) {
      lines.push(JSON.stringify({ t: 'turn', n, i: encodeIntents(intents, actors), h: hash }));
    },
    end(state) {
      const ranking = rankActors(state.actors, cfg).map((r) => ({
        seat: r.seat, place: r.place, champion: r.champion, status: r.status, score: r.score, stamina: r.stamina,
      }));
      lines.push(JSON.stringify({ t: 'end', n: state.endTurn, ranking }));
    },
    toJSONL() {
      return `${lines.join('\n')}\n`;
    },
  };
}
