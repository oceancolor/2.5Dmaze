// 大模型对话日志（供运营复盘 / 调 harness）：每次经服务器的调用（中转 + 测试连接）追加一行 JSONL。
//   {dir}/{YYYY-MM-DD}/{matchId}.jsonl   一局一个文件（日期取 UTC，跨零点的对局会分到两天）
//   {dir}/{YYYY-MM-DD}/_test.jsonl       测试连接
// 每行：时间、游客 id、对局 / 座位 / 调用类型、服务商 / 模型 / 推理档、发出的 messages、原始回复、结束原因、token、耗时、成败。
// 绝不写 key：只记 keyId 与尾号提示；调用方传进来的对象里也没有 apiKey 字段（见 api/llm.mjs）。
// 写盘异步串行，不阻塞响应；写失败只打一行警告，不影响游戏。启动时与每天一次清理超过 retentionDays 的日期目录。

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 86400000;
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{dir:string|null, retentionDays?:number, now?:()=>number, warn?:(msg:string)=>void}} o
 *   dir 为空 = 不记日志（测试默认）
 */
export function createLlmLog({ dir, retentionDays = 30, now = Date.now, warn = (m) => console.warn(m) }) {
  if (!dir) return { enabled: false, dir: null, retentionDays, write() {}, readMatch: async () => [], flush: async () => {}, prune: async () => 0 };

  let chain = Promise.resolve();
  let lastPrune = 0;

  async function prune() {
    lastPrune = now();
    const keepFrom = dayOf(now() - retentionDays * DAY);
    let removed = 0;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    for (const n of names) {
      if (DATE_DIR.test(n) && n < keepFrom) {
        await rm(join(dir, n), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  function write(entry) {
    const t = now();
    const file = SAFE.test(entry.matchId ?? '') ? entry.matchId : '_test';
    const day = dayOf(t);
    const line = `${JSON.stringify({ at: new Date(t).toISOString(), ...entry })}\n`;
    chain = chain.then(async () => {
      try {
        if (t - lastPrune > DAY) await prune();
        await mkdir(join(dir, day), { recursive: true });
        await appendFile(join(dir, day, `${file}.jsonl`), line, 'utf8');
      } catch (e) {
        warn(`llm-log: 写入失败 ${e.message}`);
      }
    });
  }

  /**
   * 读出某局某人的全部日志行（各日期目录合并，按时间排序）。战绩里的「下载对话」用。
   * @returns {Promise<object[]>} 没有日志时空数组
   */
  async function readMatch(matchId, userId) {
    if (!SAFE.test(matchId ?? '')) return [];
    await chain; // 先等排队的写入落盘
    let days = [];
    try {
      days = (await readdir(dir)).filter((n) => DATE_DIR.test(n)).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const d of days) {
      let text;
      try {
        text = await readFile(join(dir, d, `${matchId}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.matchId === matchId && e.userId === userId) out.push(e);
        } catch {
          /* 半行（写到一半崩了）跳过 */
        }
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  return {
    enabled: true,
    dir,
    retentionDays,
    write,
    readMatch,
    /** 等待已排队的写入落盘（测试 / 优雅退出用）。 */
    flush: () => chain,
    prune,
  };
}
