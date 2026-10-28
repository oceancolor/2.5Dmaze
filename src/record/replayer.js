// 严格回放：只读记录、不调用任何决策者，逐回合比对状态哈希，不一致立即报错。

import { configHash, stateHash } from '../core/hash.js';
import { createMatch } from '../core/state.js';
import { step } from '../core/game.js';
import { decodeIntents, RECORD_VERSION } from './recorder.js';

export class ReplayMismatch extends Error {
  constructor(message, turn, expected, actual) {
    super(message);
    this.name = 'ReplayMismatch';
    this.turn = turn;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * @param {string|string[]} jsonl
 * @param {object} cfg 必须与记录时的 config 一致（configHash 校验）
 */
export function replay(jsonl, cfg) {
  const raw = typeof jsonl === 'string' ? jsonl.split('\n') : jsonl;
  const lines = raw.filter((l) => l && l.trim()).map((l) => JSON.parse(l));
  const meta = lines[0];
  if (!meta || meta.t !== 'meta') throw new ReplayMismatch('missing meta line', 0);
  if (meta.v !== RECORD_VERSION) throw new ReplayMismatch(`unsupported record version ${meta.v}`, 0);
  const ch = configHash(cfg);
  if (meta.configHash !== ch) throw new ReplayMismatch('configHash mismatch', 0, meta.configHash, ch);

  const match = createMatch(meta.seed, cfg);
  if (match.map.hash !== meta.mapHash) throw new ReplayMismatch('mapHash mismatch', 0, meta.mapHash, match.map.hash);

  let state = match.state;
  let turns = 0;
  let sawEnd = false;
  for (const L of lines.slice(1)) {
    if (L.t === 'turn') {
      if (state.ended) throw new ReplayMismatch(`turn ${L.n} after match end`, L.n);
      if (L.n !== state.turn) throw new ReplayMismatch(`turn number ${L.n} != expected ${state.turn}`, L.n, state.turn, L.n);
      const r = step(match.map, state, decodeIntents(L.i), cfg);
      const h = stateHash(r.state);
      if (h !== L.h) throw new ReplayMismatch(`state hash mismatch at turn ${L.n}`, L.n, L.h, h);
      state = r.state;
      turns++;
    } else if (L.t === 'end') {
      if (!state.ended || state.endTurn !== L.n) throw new ReplayMismatch(`end mismatch at turn ${L.n}`, L.n, L.n, state.endTurn);
      sawEnd = true;
    }
  }
  return { match, state, turns, complete: sawEnd };
}
