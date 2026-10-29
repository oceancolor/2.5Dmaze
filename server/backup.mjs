#!/usr/bin/env node
// SQLite 在线备份（06 §12.2：每日备份到云主机之外）。VACUUM INTO 生成一致的快照，服务器运行中也可执行。
// 用法：node server/backup.mjs [目标目录，默认 .data/backups] [保留份数，默认 14]
//   DB_PATH 同 server/main.mjs（默认 .data/maze.db）。建议由 systemd timer / cron 每日调用，再把目标目录同步到对象存储。

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/db.mjs';

/** 把 dbPath 快照到 destFile（destFile 不能已存在）。 */
export async function backupTo(dbPath, destFile) {
  const store = await openStore(dbPath);
  try {
    store.db.prepare('VACUUM INTO ?').run(destFile);
  } finally {
    store.close();
  }
  return destFile;
}

/** 只保留最近 keep 份 maze-*.db。 */
export function prune(dir, keep) {
  const files = readdirSync(dir).filter((f) => /^maze-\d{8}-\d{6}\.db$/.test(f)).sort();
  const gone = files.slice(0, Math.max(0, files.length - keep));
  for (const f of gone) rmSync(join(dir, f));
  return gone;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const dbPath = resolve(root, process.env.DB_PATH || '.data/maze.db');
  const dir = resolve(root, process.argv[2] || '.data/backups');
  const keep = Number(process.argv[3] || 14);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = await backupTo(dbPath, join(dir, `maze-${stamp}.db`));
  const gone = prune(dir, keep);
  console.log(`backup ${out}${gone.length ? ` · pruned ${gone.length}` : ''}`);
}
