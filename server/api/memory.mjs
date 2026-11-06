// 跨局经验（批次 6 harness，05 §7.8）：玩家自己的 AI 每局结束后由模型自己写经验、超长时自己压缩，
// 下一局开局植入 system 提示词。按「服务商/模型」分开存（不同模型的经验不混用）；只有本人能看 / 改 / 清空。
//   GET    /api/v1/memory               我的全部经验（只有 scope / 字数 / 局数 / 更新时间）
//   GET    /api/v1/memory?scope=…       一份经验全文（没有 → item: null）
//   PUT    /api/v1/memory               {scope, text, games?} 保存（模型写的或玩家手改的）
//   DELETE /api/v1/memory?scope=…       清空
// 经验文本由模型生成，服务器只做长度与格式检查；它只进本人自己的提示词，不影响局面（J06）。

import { DEFAULT_CONFIG } from '../../src/config/default.config.js';
import { HttpError, readJson, sendJson } from '../http.mjs';
import { authenticate } from './accounts.mjs';

const SCOPE = /^[\w.:/@-]{1,120}$/;
const MAX = DEFAULT_CONFIG.ai.harness.memoryMaxChars;

function scopeOf(raw) {
  const s = String(raw ?? '');
  if (!SCOPE.test(s) || s.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new HttpError(400, 'bad_scope', 'scope 应为「服务商/模型」，1–120 字符');
  return s;
}

export function getMemory(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  const raw = ctx.url.searchParams.get('scope');
  if (raw === null) {
    sendJson(res, 200, { items: ctx.store.listMemories(user.id), maxChars: MAX });
    return;
  }
  sendJson(res, 200, { item: ctx.store.getMemory(user.id, scopeOf(raw)), maxChars: MAX });
}

export async function putMemory(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  const b = await readJson(req, 32 * 1024);
  const scope = scopeOf(b.scope);
  if (typeof b.text !== 'string') throw new HttpError(400, 'bad_text', 'text 必须是字符串');
  const text = b.text.replace(/\r\n/g, '\n').trim();
  if (Array.from(text).length > MAX) throw new HttpError(413, 'memory_too_long', `经验最多 ${MAX} 字（超过时让模型压缩，或手动删减）`);
  const prev = ctx.store.getMemory(user.id, scope);
  const games = Number.isInteger(b.games) && b.games >= 0 ? b.games : prev ? prev.games : 0;
  if (!text) {
    ctx.store.deleteMemory(user.id, scope);
    sendJson(res, 200, { item: null, maxChars: MAX });
    return;
  }
  ctx.store.putMemory(user.id, scope, text, games, ctx.now());
  sendJson(res, 200, { item: ctx.store.getMemory(user.id, scope), maxChars: MAX });
}

export function deleteMemory(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  const scope = scopeOf(ctx.url.searchParams.get('scope'));
  ctx.store.deleteMemory(user.id, scope);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}
