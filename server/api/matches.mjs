// 对局上传与查询（06 §6 / §11）。
//   POST /api/v1/matches            上传本地对局记录 → 重放校验 → 入库（同一 matchId 幂等）
//                                   可选 strategy：玩家思路原文 + 自主度 + 闸门（只进私有表，仅本人可见；记录里只有哈希）
//   GET  /api/v1/matches            我的战绩（按收到时间倒序，?limit=&before=）
//   GET  /api/v1/matches/:id        详情（只有本人可见；别人的一律 404，不泄露是否存在）：含对局报告与思路原文
//   GET  /api/v1/matches/:id/record 下载记录 JSONL
//   GET  /api/v1/matches/:id/llm-log 下载这局的大模型对话（接大模型模式；来自服务器对话日志，保留期内）

import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpError, compareVersions, parseClient, readJson, sendJson } from '../http.mjs';
import { seatSource, verifyRecord } from '../verifier.mjs';
import { authenticate, sha256 } from './accounts.mjs';
import { buildTalkExport, talkEntryFromLog } from '../../src/app/talk-export.js';
import { configByHash } from '../../src/config/known.js';
import { timelineFromRecord } from '../../src/ai/harness.js';

export const RECORD_LIMIT = 1024 * 1024;
const MATCH_ID = /^[A-Za-z0-9_-]{16,64}$/;
const DAY = 86400000;
const AUTONOMIES = new Set(['free', 'blend', 'strict']);
const STRATEGY_MAX = 4000;

function optTime(v, now) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 0 || v > now + DAY) throw new HttpError(400, 'bad_time', 'startedAt / endedAt 应为毫秒时间戳');
  return v;
}

function parseStrategy(s) {
  if (s === undefined || s === null) return [];
  if (typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'bad_strategy', 'strategy 应为对象');
  if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat > 3) throw new HttpError(400, 'bad_strategy', 'strategy.seat 应为 0–3');
  if (s.autonomy !== undefined && s.autonomy !== null && !AUTONOMIES.has(s.autonomy)) throw new HttpError(400, 'bad_strategy', 'strategy.autonomy');
  if (typeof s.text !== 'string' || s.text.length > STRATEGY_MAX) throw new HttpError(400, 'bad_strategy', `strategy.text 应为不超过 ${STRATEGY_MAX} 字符的文本`);
  return [{ seat: s.seat, autonomy: s.autonomy ?? null, safetyGate: typeof s.safetyGate === 'boolean' ? s.safetyGate : null, text: s.text }];
}

export async function uploadMatch(req, res, { store, now, opt, limiters }) {
  const user = authenticate(req, store, now);
  const client = parseClient(req.headers['x-maze-client']);
  if (!client) throw new HttpError(400, 'bad_client', '缺少请求头 X-Maze-Client（如 web/0.3.0）');
  if (compareVersions(client.version, opt.minClientVersion) < 0) {
    throw new HttpError(426, 'client_outdated', `客户端版本 ${client.version} 过旧，请更新到 ${opt.minClientVersion} 或以上`);
  }
  limiters.upload.take(user.id);
  // 记录作为 JSON 字符串传输，引号转义后体积约 1.3–1.5 倍
  const body = await readJson(req, RECORD_LIMIT * 2);
  const r = saveMatch(store, user, { ...body, host: 'local', platform: client.platform, clientVersion: client.version, now });
  sendJson(res, r.duplicate ? 200 : 201, r);
}

/**
 * 校验并入库一局（客户端上传与服务器托管的对局共用，批次 7）。
 * @param {{matchId:string, record:string, strategy?:object, startedAt?:number, endedAt?:number, host:string, platform:string, clientVersion:string, now:()=>number}} body
 * @returns {object} getMatch 的结果 + duplicate
 */
export function saveMatch(store, user, body) {
  const { now } = body;
  if (typeof body.matchId !== 'string' || !MATCH_ID.test(body.matchId)) throw new HttpError(400, 'bad_match_id', 'matchId 应为 16–64 位 [A-Za-z0-9_-]');
  if (typeof body.record !== 'string') throw new HttpError(400, 'bad_record', '缺少 record（JSONL 文本）');
  const bytes = Buffer.byteLength(body.record);
  if (bytes > RECORD_LIMIT) throw new HttpError(413, 'body_too_large', `记录超过 ${RECORD_LIMIT} 字节`);
  const t = now();
  const digest = sha256(body.record);

  const prev = store.matchRow(body.matchId);
  if (prev) {
    if (prev.user_id !== user.id || prev.record_sha256 !== digest) throw new HttpError(409, 'match_id_conflict', '这个 matchId 已被另一份记录占用');
    return { ...store.getMatch(body.matchId), duplicate: true };
  }

  const v = verifyRecord(body.record);
  const strategies = parseStrategy(body.strategy);
  const seats = (v.meta.seats ?? []).map((tag, seat) => ({ seat, tag, source: seatSource(tag) }));
  const players = new Map((v.meta.players ?? []).map((p) => [p.seat, p]));
  const plans = new Map(v.seatPlans.map((p) => [p.seat, p]));
  // 经服务器中转的调用，用量以服务器的账为准（客户端改不了）
  const usage = new Map();
  for (const u of store.usageByMatch(user.id, body.matchId)) {
    const x = usage.get(u.seat) ?? { calls: 0, tokensIn: 0, tokensOut: 0, model: `${u.provider}/${u.model}` };
    x.calls += u.calls;
    x.tokensIn += u.tokensIn;
    x.tokensOut += u.tokensOut;
    usage.set(u.seat, x);
  }
  const seatReport = (seat) => {
    const p = plans.get(seat);
    const u = usage.get(seat);
    const pl = players.get(seat);
    const model = pl && pl.provider ? `${pl.provider}/${pl.model ?? ''}` : u ? u.model : null;
    return {
      seat,
      model,
      autonomy: pl ? pl.autonomy ?? null : null,
      decisions: p ? p.decisions : 0,
      follow: p ? { yes: p.yes, partial: p.partial, override: p.override } : null,
      invalid: p ? p.invalid : 0,
      stale: p ? p.stale : 0,
      failed: p ? p.failed : 0,
      tokens: u ? { calls: u.calls, in: u.tokensIn, out: u.tokensOut } : null,
    };
  };
  const report = { seats: v.ranking.map((r) => seatReport(r.seat)).filter((x) => x.decisions || x.tokens) };
  const m = {
    id: body.matchId,
    userId: user.id,
    host: body.host,
    platform: body.platform,
    clientVersion: body.clientVersion,
    rulesVersion: v.meta.rulesVersion,
    recordVersion: v.meta.v,
    configHash: v.meta.configHash,
    playerMode: v.playerMode,
    mapSize: v.mapSize,
    vision: v.vision,
    seed: v.meta.seed,
    mapHash: v.meta.mapHash,
    turns: v.turns,
    ranking: v.ranking,
    seats,
    verify: v.verify,
    verifyTurn: v.verifyTurn,
    verifyNote: v.verifyNote,
    startedAt: optTime(body.startedAt, t),
    endedAt: optTime(body.endedAt, t),
    receivedAt: t,
    recordSha256: digest,
    report: report.seats.length ? report : null,
  };
  // 只有通过校验的对局进座位统计（06 §3.1：不一致的记录照存，但不进任何统计）
  const stats = v.verify === 'verified'
    ? v.ranking.map((r) => {
      const rep = seatReport(r.seat);
      return {
        seat: r.seat, source: seats[r.seat] ? seats[r.seat].source : 'unknown', place: r.place, score: r.score, status: r.status, stamina: r.stamina,
        model: rep.model, decisions: rep.decisions || null, yes: rep.follow ? rep.follow.yes : null, partial: rep.follow ? rep.follow.partial : null,
        override: rep.follow ? rep.follow.override : null, invalid: rep.decisions ? rep.invalid : null,
        tokensIn: rep.tokens ? rep.tokens.in : null, tokensOut: rep.tokens ? rep.tokens.out : null,
      };
    })
    : [];
  store.insertMatch(m, gzipSync(Buffer.from(body.record, 'utf8')), bytes, stats, strategies);
  return { ...store.getMatch(m.id), duplicate: false };
}

export function listMatches(req, res, { store, now, url }) {
  const user = authenticate(req, store, now);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const beforeRaw = Number(url.searchParams.get('before'));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : Number.MAX_SAFE_INTEGER;
  const items = store.listMatches(user.id, { limit, before });
  sendJson(res, 200, { items, total: store.countMatches(user.id), next: items.length === limit ? items[items.length - 1].receivedAt : null });
}

function ownMatch(req, id, { store, now }) {
  const user = authenticate(req, store, now);
  const row = MATCH_ID.test(id) ? store.matchRow(id) : null;
  if (!row || row.user_id !== user.id) throw new HttpError(404, 'not_found', '没有这局');
  return row;
}

export function getMatch(req, res, ctx, id) {
  ownMatch(req, id, ctx);
  sendJson(res, 200, ctx.store.getMatchDetail(id));
}

export function getRecord(req, res, ctx, id) {
  ownMatch(req, id, ctx);
  const gz = ctx.store.recordGz(id);
  const text = gunzipSync(gz);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Content-Disposition': `attachment; filename="maze-${id}.jsonl"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': text.length,
  });
  res.end(text);
}

/** 由大模型 / WorkBuddy 决策的座位才有复盘时间线（plan 行驱动）。 */
const DECIDES = (tag) => typeof tag === 'string' && (tag.startsWith('byok:') || tag.startsWith('mcp:') || tag.startsWith('prompt-'));

/**
 * 回放（2026-11-09）：记录原文 + 座位 0 的决策复盘时间线（有的话）。只有本人可看；JSON 返回（客户端 sync.call 只认 JSON）。
 */
export function getReplay(req, res, ctx, id) {
  const row = ownMatch(req, id, ctx);
  const text = gunzipSync(ctx.store.recordGz(id)).toString('utf8');
  const m = ctx.store.getMatch(id);
  const tag = m.seats[0] ? m.seats[0].tag : '';
  let timeline = null;
  if (DECIDES(tag)) {
    const meta = JSON.parse(text.slice(0, text.indexOf('\n')));
    const k = configByHash(meta.configHash);
    if (k) {
      try {
        timeline = timelineFromRecord(text, k.cfg, 0);
      } catch {
        timeline = null; // 复盘失败不影响回放本身
      }
    }
  }
  const label = tag === 'mcp:workbuddy' ? 'WorkBuddy 上场' : tag.startsWith('byok:') ? `我的大模型 · ${tag.slice(5).split('/').pop()}` : null;
  sendJson(res, 200, { matchId: id, verify: row.verify, mapSize: m.mapSize ?? null, label, record: text, timeline });
}

/**
 * 战绩里的「下载对话」（接大模型模式）：服务器对话日志里这一局本人的全部调用 + 存档记录里每次决策的结局，
 * 格式与结算卡「导出 AI 对话」相同（src/app/talk-export.js）。只有本人可下载；不含 key / keyId / 用户 id。
 * 返回 JSON {matchId, calls, filename, jsonl}（客户端 sync.call 只认 JSON）。
 */
export async function getLlmLog(req, res, ctx, id) {
  const row = ownMatch(req, id, ctx);
  const log = ctx.llmLog;
  if (!log || !log.enabled) throw new HttpError(404, 'llm_log_disabled', '这台游戏服务器没有开启对话日志（LLM_LOG_DIR=off），下载不了对话');
  const entries = await log.readMatch(id, row.user_id);
  if (!entries.length) {
    throw new HttpError(404, 'llm_log_missing', `服务器上没有这局的对话日志：日志只保留 ${log.retentionDays} 天，且只记录经服务器中转的调用（接大模型模式）`);
  }
  const d = ctx.store.getMatchDetail(id);
  const seat = Number.isInteger(entries[0].seat) ? entries[0].seat : 0;
  const strat = (d.strategies || []).find((s) => s.seat === seat) || null;
  const first = entries[0];
  const text = gunzipSync(ctx.store.recordGz(id)).toString('utf8');
  const jsonl = buildTalkExport({
    meta: {
      matchId: id, seed: d.seed, mapSize: d.mapSize ?? null, seat, provider: first.provider ?? null, model: first.model ?? null,
      reasoning: Boolean(first.reasoning), autonomy: strat ? strat.autonomy : null, safetyGate: strat ? strat.safetyGate : null,
      strategy: strat ? strat.text : null, verify: d.verify, turns: d.turns, source: 'server-log',
    },
    calls: entries.filter((e) => e.seat === seat).map(talkEntryFromLog),
    recordJSONL: text,
    seat,
    exportedAt: ctx.now(),
  });
  sendJson(res, 200, { matchId: id, calls: entries.length, filename: `maze-ai-talk-${d.seed}-${id.slice(0, 8)}.jsonl`, jsonl });
}
