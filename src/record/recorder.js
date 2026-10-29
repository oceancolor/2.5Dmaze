// 对局记录（JSONL，SPEC §12）。每回合一行：原始意图（紧凑串）+ 结算后状态哈希。
//   {"t":"meta","v":2,"rulesVersion","seed","configHash","mapHash","attempts","seats"?,"players"?}
//   {"t":"plan","n":13,"seat":1,"req":11,"src":"llm","why":"interval","plan":{...},"err"?}   v2：计划生效行（仅供复盘，严格回放不读）
//   {"t":"turn","n":12,"i":"NE.-","h":"a1b2c3d4"}
//   {"t":"end","n":388,"ranking":[...]}
// players（05 §9）：玩家自己的 AI 的说明 [{seat, provider?, model?, autonomy?, safetyGate?, strategyHash?}]；
//   思路原文不进记录（只随上传进服务器的私有表），API key / 令牌绝不写入。

import { DIR_CHARS, OFF_BOARD_CHAR, toDir } from '../core/geom.js';
import { configHash } from '../core/hash.js';
import { rankActors } from '../core/scoring.js';

export const RECORD_VERSION = 2;
/** 回放器接受的版本：v1 无计划行，其余同 v2。 */
export const RECORD_VERSIONS = Object.freeze([1, 2]);

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

/**
 * @param {object} match
 * @param {object} cfg
 * @param {{seats?: string[], players?: object[]}} [extra] seats：各座位控制通道标签（如 ['manual','llm','mock','heuristic']），仅作复盘说明
 */
export function createRecorder(match, cfg, extra = {}) {
  const meta = {
    t: 'meta',
    v: RECORD_VERSION,
    rulesVersion: cfg.rulesVersion,
    seed: match.seed,
    configHash: configHash(cfg),
    mapHash: match.map.hash,
    attempts: match.attempts,
  };
  if (extra.seats) meta.seats = extra.seats.slice();
  if (extra.players && extra.players.length) meta.players = extra.players.map((p) => ({ ...p }));
  const lines = [JSON.stringify(meta)];
  return {
    lines,
    turn(n, intents, actors, hash) {
      lines.push(JSON.stringify({ t: 'turn', n, i: encodeIntents(intents, actors), h: hash }));
    },
    /** 计划生效行：n = 生效回合，req = 发起回合，src = llm | llm-repair | invalid | stale（生效时目标已没了）| failed，
     *  why = 触发原因，err = 不合格 / 失败原因。 */
    plan({ n, seat, requestTurn, source, plan, why, err }) {
      const L = { t: 'plan', n, seat, req: requestTurn, src: source };
      if (why) L.why = why;
      L.plan = plan ?? null;
      if (err) L.err = String(err).slice(0, 120);
      lines.push(JSON.stringify(L));
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
