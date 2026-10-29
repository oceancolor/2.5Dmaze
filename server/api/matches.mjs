// 对局上传与查询（06 §6 / §11）。
//   POST /api/v1/matches            上传本地对局记录 → 重放校验 → 入库（同一 matchId 幂等）
//                                   可选 strategy：玩家思路原文 + 自主度 + 闸门（只进私有表，仅本人可见；记录里只有哈希）
//   GET  /api/v1/matches            我的战绩（按收到时间倒序，?limit=&before=）
//   GET  /api/v1/matches/:id        详情（只有本人可见；别人的一律 404，不泄露是否存在）：含对局报告与思路原文
//   GET  /api/v1/matches/:id/record 下载记录 JSONL

import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpError, compareVersions, parseClient, readJson, sendJson } from '../http.mjs';
import { seatSource, verifyRecord } from '../verifier.mjs';
import { authenticate, sha256 } from './accounts.mjs';

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
  if (typeof body.matchId !== 'string' || !MATCH_ID.test(body.matchId)) throw new HttpError(400, 'bad_match_id', 'matchId 应为 16–64 位 [A-Za-z0-9_-]');
  if (typeof body.record !== 'string') throw new HttpError(400, 'bad_record', '缺少 record（JSONL 文本）');
  const bytes = Buffer.byteLength(body.record);
  if (bytes > RECORD_LIMIT) throw new HttpError(413, 'body_too_large', `记录超过 ${RECORD_LIMIT} 字节`);
  const t = now();
  const digest = sha256(body.record);

  const prev = store.matchRow(body.matchId);
  if (prev) {
    if (prev.user_id !== user.id || prev.record_sha256 !== digest) throw new HttpError(409, 'match_id_conflict', '这个 matchId 已被另一份记录占用');
    sendJson(res, 200, { ...store.getMatch(body.matchId), duplicate: true });
    return;
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
    host: 'local',
    platform: client.platform,
    clientVersion: client.version,
    rulesVersion: v.meta.rulesVersion,
    recordVersion: v.meta.v,
    configHash: v.meta.configHash,
    playerMode: v.playerMode,
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
  sendJson(res, 201, { ...store.getMatch(m.id), duplicate: false });
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
