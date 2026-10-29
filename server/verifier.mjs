// 对局记录校验（06 §3.1 / §6.3）：上传的 JSONL 先过格式检查，再用同一个确定性内核严格回放，
// 最后用服务器重算的排名核对客户端声称的排名。
//   verified      规则合法，且结果确实由这串意图产生
//   mismatch      回放不一致（附第一处不一致的回合）；记录照存，不进任何统计
//   unverifiable  规则版本不是本服务器的内核版本；记录照存
// 证明不了「意图来自谁」（人手 / 外挂 / 某个模型），见 06 §6.3。

import { DEFAULT_CONFIG, makeConfig } from '../src/config/default.config.js';
import { canonicalJSON, configHash } from '../src/core/hash.js';
import { rankActors } from '../src/core/scoring.js';
import { RECORD_VERSIONS } from '../src/record/recorder.js';
import { replay, ReplayMismatch } from '../src/record/replayer.js';
import { HttpError } from './http.mjs';

export const RULES_VERSION = DEFAULT_CONFIG.rulesVersion;
const SEATS = DEFAULT_CONFIG.spawns.length;
const MAX_TURNS = DEFAULT_CONFIG.rules.maxTurns;
const MAX_LINES = MAX_TURNS * 6 + 8;

/** 服务器认可的配置：每种玩家通道一份（configHash 里含 match.playerMode）。 */
const KNOWN = new Map(Object.keys(DEFAULT_CONFIG.rules.staminaByMode).map((mode) => {
  const cfg = makeConfig({ match: { playerMode: mode } });
  return [configHash(cfg), { cfg, mode }];
}));

const HEX8 = /^[0-9a-f]{8}$/;
const INTENTS = new RegExp(`^[NESW.\\-]{${SEATS}}$`);
const SEAT_TAG = /^[a-z][a-z0-9:_./-]{0,63}$/i;
const SHORT = /^[\w.:/@-]{1,80}$/;
const AUTONOMIES = new Set(['free', 'blend', 'strict']);
const isInt = (v) => Number.isInteger(v);

const bad = (msg) => new HttpError(400, 'bad_record', `记录格式错误：${msg}`);

/** 座位标签 → 来源分类（seat_stats.source）。 */
export function seatSource(tag) {
  if (!tag) return 'unknown';
  if (tag === 'manual' || tag === 'script' || tag === 'heuristic') return tag;
  if (tag === 'prompt-mock' || tag.startsWith('mock:')) return 'mock';
  if (tag === 'prompt-proxy' || tag.startsWith('proxy:')) return 'proxy';
  if (tag === 'prompt-byok' || tag.startsWith('byok:')) return 'byok';
  return tag.split(':')[0];
}

/** meta.players（05 §9）：玩家 AI 的说明，只做形状检查。 */
function checkPlayers(p) {
  if (!Array.isArray(p) || p.length > SEATS) throw bad('meta.players');
  for (const x of p) {
    if (!x || typeof x !== 'object' || !isInt(x.seat) || x.seat < 0 || x.seat >= SEATS) throw bad('meta.players[].seat');
    for (const k of ['provider', 'model', 'strategyHash']) if (x[k] !== undefined && (typeof x[k] !== 'string' || !SHORT.test(x[k]))) throw bad(`meta.players[].${k}`);
    if (x.autonomy !== undefined && !AUTONOMIES.has(x.autonomy)) throw bad('meta.players[].autonomy');
    if (x.safetyGate !== undefined && typeof x.safetyGate !== 'boolean') throw bad('meta.players[].safetyGate');
  }
}

/** 计划行 → 每座位的决策统计（复盘 / 报告用；记录里自报，不影响校验结论）。 */
export function planStats(lines) {
  const per = new Map();
  for (const L of lines) {
    if (L.t !== 'plan') continue;
    let s = per.get(L.seat);
    if (!s) {
      s = { seat: L.seat, decisions: 0, applied: 0, yes: 0, partial: 0, override: 0, invalid: 0, stale: 0, failed: 0 };
      per.set(L.seat, s);
    }
    s.decisions++;
    if (L.src === 'llm' || L.src === 'llm-repair') {
      s.applied++;
      const f = L.plan && L.plan.follow;
      if (f === 'yes' || f === 'partial' || f === 'override') s[f]++;
    } else if (L.src === 'invalid') s.invalid++;
    else if (L.src === 'stale') s.stale++;
    else s.failed++;
  }
  return [...per.values()].sort((a, b) => a.seat - b.seat);
}

const rankingOf = (actors, cfg) => rankActors(actors, cfg).map((r) => ({
  seat: r.seat, place: r.place, champion: r.champion, status: r.status, score: r.score, stamina: r.stamina,
}));

function checkRanking(r) {
  if (!Array.isArray(r) || r.length !== SEATS) throw bad('end.ranking 应为每座位一项');
  for (const x of r) {
    if (!x || !isInt(x.seat) || !isInt(x.place) || !isInt(x.score) || typeof x.status !== 'string') throw bad('end.ranking 项缺字段');
  }
}

/**
 * 只做结构检查（不跑内核）：不合格直接 400，不入库。
 * @returns {{lines:object[], meta:object, end:object, turnCount:number}}
 */
export function parseRecord(text) {
  if (typeof text !== 'string' || !text.length) throw bad('record 为空');
  const raw = text.split('\n').filter((l) => l.trim());
  if (raw.length > MAX_LINES) throw bad(`行数 ${raw.length} 超过上限 ${MAX_LINES}`);
  const lines = raw.map((l, k) => {
    try {
      const v = JSON.parse(l);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw bad(`第 ${k + 1} 行不是 JSON 对象`);
    }
  });
  const meta = lines[0];
  if (meta.t !== 'meta') throw bad('第 1 行应为 meta');
  if (!RECORD_VERSIONS.includes(meta.v)) throw bad(`不支持的记录版本 ${meta.v}`);
  if (typeof meta.rulesVersion !== 'string' || meta.rulesVersion.length > 32) throw bad('meta.rulesVersion');
  if (!isInt(meta.seed) || meta.seed < 0 || meta.seed > 0xffffffff) throw bad('meta.seed');
  if (!HEX8.test(meta.configHash) || !HEX8.test(meta.mapHash)) throw bad('meta.configHash / mapHash');
  if (meta.seats !== undefined && (!Array.isArray(meta.seats) || meta.seats.length !== SEATS || !meta.seats.every((s) => typeof s === 'string' && SEAT_TAG.test(s)))) {
    throw bad('meta.seats');
  }
  if (meta.players !== undefined) checkPlayers(meta.players);
  let end = null;
  let turnCount = 0;
  for (let k = 1; k < lines.length; k++) {
    const L = lines[k];
    if (end) throw bad('end 行之后还有内容');
    if (L.t === 'turn') {
      if (!isInt(L.n) || L.n < 1 || L.n > MAX_TURNS || typeof L.i !== 'string' || !INTENTS.test(L.i) || !HEX8.test(L.h)) throw bad(`第 ${k + 1} 行 turn 字段不合法`);
      turnCount++;
    } else if (L.t === 'plan') {
      if (!isInt(L.n) || !isInt(L.seat) || L.seat < 0 || L.seat >= SEATS) throw bad(`第 ${k + 1} 行 plan 字段不合法`);
    } else if (L.t === 'end') {
      if (!isInt(L.n)) throw bad('end.n');
      checkRanking(L.ranking);
      end = L;
    } else {
      throw bad(`第 ${k + 1} 行类型未知：${String(L.t).slice(0, 16)}`);
    }
  }
  if (!end) throw new HttpError(422, 'record_incomplete', '记录没有 end 行：只接受已结束的对局');
  return { lines, meta, end, turnCount };
}

/**
 * 结构检查 + 严格回放 + 排名核对。
 * @returns {{verify:'verified'|'mismatch'|'unverifiable', verifyTurn:number|null, verifyNote:string|null,
 *            meta:object, ranking:object[], turns:number, playerMode:string|null, plans:number, seatPlans:object[]}}
 */
export function verifyRecord(text) {
  const { lines, meta, end } = parseRecord(text);
  const plans = lines.filter((l) => l.t === 'plan').length;
  const base = { meta, ranking: end.ranking, turns: end.n, plans, seatPlans: planStats(lines), playerMode: null };

  if (meta.rulesVersion !== RULES_VERSION) {
    return { ...base, verify: 'unverifiable', verifyTurn: null, verifyNote: `规则版本 ${meta.rulesVersion} 不是本服务器的内核版本（${RULES_VERSION}）` };
  }
  const known = KNOWN.get(meta.configHash);
  if (!known) {
    return { ...base, verify: 'mismatch', verifyTurn: 0, verifyNote: 'configHash 不是服务器认可的配置' };
  }
  base.playerMode = known.mode;
  let r;
  try {
    r = replay(lines.map((l) => JSON.stringify(l)), known.cfg);
  } catch (e) {
    if (e instanceof ReplayMismatch) return { ...base, verify: 'mismatch', verifyTurn: e.turn ?? null, verifyNote: e.message };
    return { ...base, verify: 'mismatch', verifyTurn: null, verifyNote: `回放出错：${e.message}` };
  }
  if (!r.complete || !r.state.ended) {
    return { ...base, verify: 'mismatch', verifyTurn: r.state.turn, verifyNote: '回放结束时对局未结束' };
  }
  const ranking = rankingOf(r.state.actors, known.cfg);
  if (canonicalJSON(ranking) !== canonicalJSON(end.ranking)) {
    return { ...base, verify: 'mismatch', verifyTurn: end.n, verifyNote: '结算排名与回放结果不一致' };
  }
  return { ...base, ranking, turns: r.state.endTurn, verify: 'verified', verifyTurn: null, verifyNote: null };
}
