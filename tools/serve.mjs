#!/usr/bin/env node
// 零依赖本地静态预览（不含游戏服务器 API）。只监听 127.0.0.1。
// 用法：node tools/serve.mjs [端口，默认 8080]  → 游戏 http://127.0.0.1:8080/
//   /                 游戏入口（index.html）；对局记录不上传（/healthz 报 api:false，客户端据此静默跳过同步）
//   /tools/preview/   内核俯视预览（4 个启发式 AI 对打）
//   /tools/gallery/   美术样张页
// 要玩带服务器的完整版：npm run play（server/main.mjs，默认 5173）。

import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/static.mjs';

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const serveStatic = createStaticHandler(root);

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, api: false }));
    return;
  }
  if (!(await serveStatic(req, res, pathname))) {
    res.writeHead(405);
    res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`game:    http://127.0.0.1:${port}/   （静态预览，不连服务器）`);
  console.log(`preview: http://127.0.0.1:${port}/tools/preview/   gallery: http://127.0.0.1:${port}/tools/gallery/`);
});
