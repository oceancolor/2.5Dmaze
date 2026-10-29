// 对战数据存储（06 §6.1）：Node 内置 SQLite（node:sqlite，Node ≥ 22.13）。
// 存储层与路由隔离：日后换 Postgres 只需重写本文件。
// 迁移按 PRAGMA user_version 递增：v1 = S0（账号 / 对局 / 记录 / 座位），v2 = M1（key / 用量 / 思路 / 座位遵循统计 / 对局报告）。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let DatabaseSync = null;

/** node:sqlite 在 22.x 会打印实验特性警告；只压这一条，其他警告照常输出。 */
async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  const orig = process.emitWarning;
  process.emitWarning = function patched(w, ...rest) {
    const text = typeof w === 'string' ? w : w && w.message;
    if (/SQLite is an experimental feature/.test(text || '')) return;
    return orig.call(process, w, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } finally {
    process.emitWarning = orig;
  }
  return DatabaseSync;
}

const MIGRATIONS = [
  // v1 · S0
  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL DEFAULT 'guest',
     nickname      TEXT,
     token_hash    TEXT NOT NULL UNIQUE,
     created_at    INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   );
   CREATE TABLE matches (
     id              TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL REFERENCES users(id),
     host            TEXT NOT NULL,
     platform        TEXT NOT NULL,
     client_version  TEXT NOT NULL,
     rules_version   TEXT NOT NULL,
     record_version  INTEGER NOT NULL,
     config_hash     TEXT NOT NULL,
     player_mode     TEXT,
     seed            INTEGER NOT NULL,
     map_hash        TEXT NOT NULL,
     turns           INTEGER NOT NULL,
     ranking_json    TEXT NOT NULL,
     seats_json      TEXT NOT NULL,
     verify          TEXT NOT NULL,
     verify_turn     INTEGER,
     verify_note     TEXT,
     started_at      INTEGER,
     ended_at        INTEGER,
     received_at     INTEGER NOT NULL,
     record_sha256   TEXT NOT NULL
   );
   CREATE INDEX matches_by_user ON matches(user_id, received_at DESC);
   CREATE TABLE match_records (
     match_id  TEXT PRIMARY KEY REFERENCES matches(id),
     jsonl_gz  BLOB NOT NULL,
     bytes     INTEGER NOT NULL
   );
   CREATE TABLE seat_stats (
     match_id  TEXT NOT NULL REFERENCES matches(id),
     seat      INTEGER NOT NULL,
     source    TEXT NOT NULL,
     place     INTEGER,
     score     INTEGER,
     status    TEXT,
     stamina   INTEGER,
     PRIMARY KEY (match_id, seat)
   );`,
  // v2 · M1：玩家自带模型（key 只存密文）、用量（谁用谁付的账）、玩家思路（仅本人可见）、座位遵循统计
  `CREATE TABLE keys (
     id            TEXT PRIMARY KEY,
     user_id       TEXT NOT NULL REFERENCES users(id),
     provider      TEXT NOT NULL,
     base_url      TEXT NOT NULL,
     model         TEXT NOT NULL,
     reasoning     INTEGER NOT NULL DEFAULT 0,
     enc_key       BLOB NOT NULL,
     iv            BLOB NOT NULL,
     hint          TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     last_used_at  INTEGER
   );
   CREATE INDEX keys_by_user ON keys(user_id);
   CREATE TABLE usage (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     TEXT NOT NULL REFERENCES users(id),
     match_id    TEXT,
     seat        INTEGER,
     kind        TEXT NOT NULL,
     provider    TEXT NOT NULL,
     model       TEXT NOT NULL,
     tokens_in   INTEGER NOT NULL DEFAULT 0,
     tokens_out  INTEGER NOT NULL DEFAULT 0,
     ms          INTEGER,
     ok          INTEGER NOT NULL,
     at          INTEGER NOT NULL
   );
   CREATE INDEX usage_by_user ON usage(user_id, at);
   CREATE INDEX usage_by_match ON usage(match_id);
   CREATE TABLE strategies (
     match_id     TEXT NOT NULL REFERENCES matches(id),
     seat         INTEGER NOT NULL,
     autonomy     TEXT,
     safety_gate  INTEGER,
     text         TEXT,
     PRIMARY KEY (match_id, seat)
   );
   ALTER TABLE matches ADD COLUMN report_json TEXT;
   ALTER TABLE seat_stats ADD COLUMN model TEXT;
   ALTER TABLE seat_stats ADD COLUMN decisions INTEGER;
   ALTER TABLE seat_stats ADD COLUMN follow_yes INTEGER;
   ALTER TABLE seat_stats ADD COLUMN follow_partial INTEGER;
   ALTER TABLE seat_stats ADD COLUMN follow_override INTEGER;
   ALTER TABLE seat_stats ADD COLUMN invalid INTEGER;
   ALTER TABLE seat_stats ADD COLUMN tokens_in INTEGER;
   ALTER TABLE seat_stats ADD COLUMN tokens_out INTEGER;`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db) {
  const cur = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

const matchSummary = (r) => r && ({
  matchId: r.id,
  host: r.host,
  platform: r.platform,
  clientVersion: r.client_version,
  rulesVersion: r.rules_version,
  playerMode: r.player_mode,
  seed: r.seed,
  turns: r.turns,
  ranking: JSON.parse(r.ranking_json),
  seats: JSON.parse(r.seats_json),
  verify: r.verify,
  verifyTurn: r.verify_turn ?? null,
  verifyNote: r.verify_note ?? null,
  startedAt: r.started_at ?? null,
  endedAt: r.ended_at ?? null,
  receivedAt: r.received_at,
});

/**
 * @param {string} path 数据库文件路径；':memory:' 用于测试
 */
export async function openStore(path = ':memory:') {
  const Db = await loadSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Db(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);

  const q = {
    insertUser: db.prepare('INSERT INTO users (id, kind, nickname, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'),
    userByToken: db.prepare('SELECT * FROM users WHERE token_hash = ?'),
    touchUser: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
    insertMatch: db.prepare(`INSERT INTO matches (id, user_id, host, platform, client_version, rules_version, record_version, config_hash, player_mode,
      seed, map_hash, turns, ranking_json, seats_json, verify, verify_turn, verify_note, started_at, ended_at, received_at, record_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertRecord: db.prepare('INSERT INTO match_records (match_id, jsonl_gz, bytes) VALUES (?, ?, ?)'),
    insertSeat: db.prepare(`INSERT INTO seat_stats (match_id, seat, source, place, score, status, stamina, model, decisions, follow_yes, follow_partial,
      follow_override, invalid, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setReport: db.prepare('UPDATE matches SET report_json = ? WHERE id = ?'),
    insertStrategy: db.prepare('INSERT INTO strategies (match_id, seat, autonomy, safety_gate, text) VALUES (?, ?, ?, ?, ?)'),
    strategiesOf: db.prepare('SELECT seat, autonomy, safety_gate, text FROM strategies WHERE match_id = ? ORDER BY seat'),
    listByUser: db.prepare('SELECT * FROM matches WHERE user_id = ? AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT ?'),
    countByUser: db.prepare('SELECT COUNT(*) AS n FROM matches WHERE user_id = ?'),
    recordById: db.prepare('SELECT jsonl_gz FROM match_records WHERE match_id = ?'),
    insertKey: db.prepare(`INSERT INTO keys (id, user_id, provider, base_url, model, reasoning, enc_key, iv, hint, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`),
    keysByUser: db.prepare('SELECT id, provider, base_url, model, reasoning, hint, created_at, last_used_at FROM keys WHERE user_id = ? ORDER BY created_at DESC'),
    countKeys: db.prepare('SELECT COUNT(*) AS n FROM keys WHERE user_id = ?'),
    keyById: db.prepare('SELECT * FROM keys WHERE id = ?'),
    touchKey: db.prepare('UPDATE keys SET last_used_at = ? WHERE id = ?'),
    deleteKey: db.prepare('DELETE FROM keys WHERE id = ? AND user_id = ?'),
    insertUsage: db.prepare(`INSERT INTO usage (user_id, match_id, seat, kind, provider, model, tokens_in, tokens_out, ms, ok, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    usageSince: db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout,
      COALESCE(SUM(1 - ok), 0) AS failed FROM usage WHERE user_id = ? AND at >= ?`),
    usageByMatch: db.prepare(`SELECT seat, provider, model, COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout
      FROM usage WHERE user_id = ? AND match_id = ? GROUP BY seat, provider, model ORDER BY seat`),
  };

  const keyMeta = (r) => ({
    id: r.id, userId: r.user_id, provider: r.provider, baseUrl: r.base_url, model: r.model, reasoning: Boolean(r.reasoning),
    hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null,
  });

  return {
    db,
    createUser({ id, kind = 'guest', nickname = null, tokenHash, now }) {
      q.insertUser.run(id, kind, nickname, tokenHash, now, now);
      return { id, kind, nickname, createdAt: now };
    },
    userByTokenHash(hash) {
      const r = q.userByToken.get(hash);
      return r ? { id: r.id, kind: r.kind, nickname: r.nickname, createdAt: r.created_at, lastSeenAt: r.last_seen_at } : null;
    },
    touchUser(id, now) {
      q.touchUser.run(now, id);
    },
    /** 原始行（含 user_id / record_sha256），给幂等判定用。 */
    matchRow(id) {
      return q.matchById.get(id) ?? null;
    },
    getMatch(id) {
      return matchSummary(q.matchById.get(id));
    },
    /** 本人看的详情：摘要 + 对局报告（各座位决策 / 遵循统计、token）+ 玩家思路原文。 */
    getMatchDetail(id) {
      const r = q.matchById.get(id);
      if (!r) return null;
      return {
        ...matchSummary(r),
        report: r.report_json ? JSON.parse(r.report_json) : null,
        strategies: q.strategiesOf.all(id).map((s) => ({ seat: s.seat, autonomy: s.autonomy, safetyGate: s.safety_gate === null ? null : Boolean(s.safety_gate), text: s.text })),
      };
    },
    /**
     * 一个事务里写入对局、记录、座位统计、对局报告与玩家思路。
     * @param {object} m 对局元数据（字段见 MIGRATIONS matches 表；m.report 写入 report_json）
     * @param {Uint8Array} recordGz 压缩后的 JSONL
     * @param {{seat:number, source:string, place?:number, score?:number, status?:string, stamina?:number, model?:string,
     *          decisions?:number, yes?:number, partial?:number, override?:number, invalid?:number, tokensIn?:number, tokensOut?:number}[]} seats
     * @param {{seat:number, autonomy:string|null, safetyGate:boolean|null, text:string}[]} [strategies]
     */
    insertMatch(m, recordGz, rawBytes, seats, strategies = []) {
      db.exec('BEGIN');
      try {
        q.insertMatch.run(m.id, m.userId, m.host, m.platform, m.clientVersion, m.rulesVersion, m.recordVersion, m.configHash, m.playerMode ?? null,
          m.seed, m.mapHash, m.turns, JSON.stringify(m.ranking), JSON.stringify(m.seats), m.verify, m.verifyTurn ?? null, m.verifyNote ?? null,
          m.startedAt ?? null, m.endedAt ?? null, m.receivedAt, m.recordSha256);
        if (m.report) q.setReport.run(JSON.stringify(m.report), m.id);
        q.insertRecord.run(m.id, recordGz, rawBytes);
        for (const s of seats) {
          q.insertSeat.run(m.id, s.seat, s.source, s.place ?? null, s.score ?? null, s.status ?? null, s.stamina ?? null, s.model ?? null,
            s.decisions ?? null, s.yes ?? null, s.partial ?? null, s.override ?? null, s.invalid ?? null, s.tokensIn ?? null, s.tokensOut ?? null);
        }
        for (const g of strategies) q.insertStrategy.run(m.id, g.seat, g.autonomy ?? null, g.safetyGate === null || g.safetyGate === undefined ? null : g.safetyGate ? 1 : 0, g.text ?? '');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    listMatches(userId, { limit = 20, before = Number.MAX_SAFE_INTEGER } = {}) {
      return q.listByUser.all(userId, before, limit).map(matchSummary);
    },
    countMatches(userId) {
      return q.countByUser.get(userId).n;
    },
    recordGz(id) {
      const r = q.recordById.get(id);
      return r ? r.jsonl_gz : null;
    },

    // ── key（只存密文，vault.mjs 负责加解密）──
    insertKey(k) {
      q.insertKey.run(k.id, k.userId, k.provider, k.baseUrl, k.model, k.reasoning ? 1 : 0, k.enc, k.iv, k.hint, k.createdAt);
    },
    listKeys(userId) {
      return q.keysByUser.all(userId).map((r) => keyMeta({ ...r, user_id: userId }));
    },
    countKeys(userId) {
      return q.countKeys.get(userId).n;
    },
    /** 带密文的整行；不存在 → null。 */
    keyRow(id) {
      const r = q.keyById.get(id);
      return r ? { ...keyMeta(r), enc: r.enc_key, iv: r.iv } : null;
    },
    touchKey(id, now) {
      q.touchKey.run(now, id);
    },
    deleteKey(userId, id) {
      return q.deleteKey.run(id, userId).changes > 0;
    },

    // ── 用量（谁用谁付的账：每次经服务器的模型调用一行）──
    insertUsage(u) {
      q.insertUsage.run(u.userId, u.matchId ?? null, u.seat ?? null, u.kind, u.provider, u.model, u.tokensIn | 0, u.tokensOut | 0, u.ms ?? null, u.ok ? 1 : 0, u.at);
    },
    usageSince(userId, since) {
      const r = q.usageSince.get(userId, since);
      return { calls: r.calls, failed: r.failed, tokensIn: r.tin, tokensOut: r.tout };
    },
    usageByMatch(userId, matchId) {
      return q.usageByMatch.all(userId, matchId).map((r) => ({ seat: r.seat, provider: r.provider, model: r.model, calls: r.calls, tokensIn: r.tin, tokensOut: r.tout }));
    },
    close() {
      db.close();
    },
  };
}
