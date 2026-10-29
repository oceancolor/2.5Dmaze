// 游客账号（06 §5）：POST /api/v1/guest 发令牌，之后一律 Authorization: Bearer <token>。
// 数据库只存令牌的 SHA-256；令牌本身只在创建时返回一次。

import { createHash, randomBytes } from 'node:crypto';
import { HttpError, readJson, sendJson } from '../http.mjs';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => `mq_${randomBytes(32).toString('base64url')}`;
const newUserId = () => `u_${randomBytes(12).toString('base64url')}`;

const NICK = /^[\p{L}\p{N}_\- ]{1,24}$/u;

/** 解析 Bearer 令牌 → 用户；缺失或无效抛 401。 */
export function authenticate(req, store, now) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(mq_[A-Za-z0-9_-]{20,80})$/.exec(h.trim()) : null;
  if (!m) throw new HttpError(401, 'unauthorized', '缺少或无效的令牌（Authorization: Bearer mq_…）');
  const user = store.userByTokenHash(sha256(m[1]));
  if (!user) throw new HttpError(401, 'unauthorized', '令牌无效或已失效');
  const t = now();
  if (t - user.lastSeenAt > 60000) store.touchUser(user.id, t);
  return user;
}

export async function createGuest(req, res, { store, now }) {
  const body = await readJson(req, 4 * 1024);
  let nickname = null;
  if (body.nickname !== undefined && body.nickname !== null && body.nickname !== '') {
    nickname = String(body.nickname).trim();
    if (!NICK.test(nickname)) throw new HttpError(400, 'bad_nickname', '昵称 1–24 字，只能是文字、数字、空格、下划线、短横');
  }
  const token = newToken();
  const user = store.createUser({ id: newUserId(), kind: 'guest', nickname, tokenHash: sha256(token), now: now() });
  sendJson(res, 201, { userId: user.id, kind: user.kind, nickname: user.nickname, token });
}

export function getMe(req, res, { store, now }) {
  const user = authenticate(req, store, now);
  sendJson(res, 200, { userId: user.id, kind: user.kind, nickname: user.nickname, createdAt: user.createdAt, matches: store.countMatches(user.id) });
}
