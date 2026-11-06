// 玩家自己的 AI 的跨局经验（批次 6 harness，客户端一侧）：
//   开局：按「服务商/模型」取经验 → 植入 planner（system 提示词的一段）
//   赛后：由对局记录重放出每次决策的结局（harness.timelineFromRecord）→ 让模型自己写新经验 → 超长时让模型压缩 → 存回服务器
// 写经验 / 压缩都经服务器中转（kind 'memory'），记在玩家自己的账上；失败不影响对局与上传。

import { buildCompressMessages, buildMemoryMessages, cleanMemoryReply, matchDigest, timelineFromRecord } from '../ai/harness.js';

/** 经验按模型分开存：provider/model（服务器 scope 规则：字母数字 . _ : / @ -）。 */
export function memoryScope(keyMeta) {
  const clean = (s) => String(s ?? '').replace(/[^\w.:@-]/g, '_').slice(0, 58) || 'unknown';
  return `${clean(keyMeta.provider)}/${clean(keyMeta.model)}`;
}

/** @returns {Promise<{text:string, games:number}|null>} 没有 / 连不上 → null */
export async function loadMemory(call, scope) {
  const r = await call('GET', `/api/v1/memory?scope=${encodeURIComponent(scope)}`);
  if (r.status !== 200 || !r.json || !r.json.item) return null;
  return { text: String(r.json.item.text || ''), games: r.json.item.games | 0 };
}

async function ask(call, { keyId, matchId, thinking, messages, maxTokens }) {
  const r = await call('POST', '/llm/v1/chat', { keyId, matchId, seat: 0, kind: 'memory', messages, max_tokens: maxTokens, temperature: 0, thinking });
  if (r.status !== 200 || !r.json) throw new Error((r.json && r.json.message) || (r.status === 0 ? '连不上游戏服务器' : `HTTP ${r.status}`));
  return { text: cleanMemoryReply(r.json.text), usage: r.json.usage || null };
}

/**
 * 赛后写经验。
 * @param {{call:Function, cfg:object, keyId:string, matchId:string, thinking:string, scope:string, memory:{text:string, games:number}|null,
 *          strategy:string, recordJSONL:string, mapSize:string}} o
 * @returns {Promise<{text:string, games:number, calls:number, compressed:boolean, digest:string}>}
 */
export async function writeMemory(o) {
  const H = o.cfg.ai.harness;
  const tl = timelineFromRecord(o.recordJSONL, o.cfg, 0);
  const lines = String(o.recordJSONL).trim().split('\n');
  const end = JSON.parse(lines[lines.length - 1]);
  const me = (end.ranking || []).find((r) => r.seat === 0) || { status: '?', score: 0, place: '?' };
  const digest = matchDigest({ mapSize: o.mapSize, size: o.cfg.maze.size, turns: end.n, me, stats: tl.stats, mistakes: tl.mistakes, entries: tl.entries });
  const prev = o.memory || { text: '', games: 0 };
  const maxTokens = 900; // 约 1200 字的中文正文
  let calls = 1;
  let { text } = await ask(o.call, {
    keyId: o.keyId, matchId: o.matchId, thinking: o.thinking, maxTokens,
    messages: buildMemoryMessages({ memory: prev.text, strategy: o.strategy, digest, targetChars: H.memoryTargetChars, games: prev.games }),
  });
  if (!text) throw new Error('模型没有写出经验（空回复）');
  let compressed = false;
  if (Array.from(text).length > H.memoryMaxChars) {
    calls++;
    compressed = true;
    text = (await ask(o.call, { keyId: o.keyId, matchId: o.matchId, thinking: 'off', maxTokens, messages: buildCompressMessages(text, H.memoryTargetChars) })).text;
    if (Array.from(text).length > H.memoryMaxChars) text = Array.from(text).slice(0, H.memoryMaxChars).join('');
  }
  const games = prev.games + 1;
  const put = await o.call('PUT', '/api/v1/memory', { scope: o.scope, text, games });
  if (put.status !== 200) throw new Error((put.json && put.json.message) || `保存失败（HTTP ${put.status}）`);
  return { text, games, calls, compressed, digest };
}

/** 结算卡复盘：玩家座位每次决策的结局 + 关键失误（与对局中会话同一套规则）。 */
export function matchTimeline(recordJSONL, cfg, seat = 0) {
  return timelineFromRecord(recordJSONL, cfg, seat);
}
