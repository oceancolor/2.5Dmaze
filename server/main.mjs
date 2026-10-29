#!/usr/bin/env node
// 游戏服务器入口（06 §12）。Node ≥ 22.13（内置 node:sqlite），零第三方依赖。
//   本地开发：npm run play  → http://127.0.0.1:5173/ （同时托管游戏静态文件，数据在 .data/maze.db）
//   生产：    见 deploy/（systemd + Nginx，HTTPS 由反向代理终结）
// 环境变量：
//   HOST / PORT            监听地址，默认 127.0.0.1:5173（生产也只监听本机，由反向代理转发）
//   DB_PATH                SQLite 文件，默认 .data/maze.db
//   PUBLIC_ORIGIN          对外地址，如 https://maze.aiquiz.games（只用于日志与跨域白名单）
//   ALLOWED_ORIGINS        额外允许的跨域来源，逗号分隔；默认含 app://maze（Electron 壳）
//   TRUST_PROXY=1          部署在反向代理后：信任 X-Forwarded-For / X-Forwarded-Proto
//   SERVE_STATIC=0         不托管静态文件（反向代理直接给）
//   STATIC_CACHE           静态文件的 Cache-Control，默认 no-store（生产可设 "public, max-age=300"）
//   MIN_CLIENT_VERSION     低于此版本的客户端上传返回 426，默认等于当前版本
//   MASTER_KEY             「记住 key」用的主密钥（32 字节，base64 或 hex；生成：node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"）
//                          不设时：开发模式自动生成 .data/master.key；NODE_ENV=production 下只能「仅本次会话」
// 备份：node server/backup.mjs（VACUUM INTO，运行中也可做），见 deploy/。

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/db.mjs';
import { createApp } from './app.mjs';
import { parseMasterKey } from './vault.mjs';
import { CLIENT_VERSION } from '../src/app/version.js';

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const env = process.env;
const host = env.HOST || '127.0.0.1';
const port = Number(process.argv[2] ?? env.PORT ?? 5173);
const dbPath = resolve(root, env.DB_PATH || '.data/maze.db');
const publicOrigin = env.PUBLIC_ORIGIN || `http://${host}:${port}`;
const allowedOrigins = [...new Set([publicOrigin, 'app://maze', ...(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)])];

function loadMasterKey() {
  if (env.MASTER_KEY) return parseMasterKey(env.MASTER_KEY);
  if (env.NODE_ENV === 'production') return null;
  const file = join(dirname(dbPath), 'master.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return parseMasterKey(readFileSync(file, 'utf8'));
}
const masterKey = loadMasterKey();

const store = await openStore(dbPath);
const handle = createApp({
  store,
  root: env.SERVE_STATIC === '0' ? null : root,
  options: {
    allowedOrigins,
    trustProxy: env.TRUST_PROXY === '1',
    minClientVersion: env.MIN_CLIENT_VERSION || CLIENT_VERSION,
    staticCache: env.STATIC_CACHE || 'no-store',
    masterKey,
  },
});

const server = createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/llm/')) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  handle(req, res);
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, host, () => {
  console.log(`maze server ${CLIENT_VERSION} · http://${host}:${port}/ · db ${dbPath}`);
  console.log(`public origin ${publicOrigin} · cors ${allowedOrigins.join(' ')}${env.TRUST_PROXY === '1' ? ' · trust proxy' : ''}`);
  console.log(masterKey ? 'key vault: 「记住」可用（AES-256-GCM）' : 'key vault: 未设 MASTER_KEY，只能「仅本次会话」');
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
