// 静态文件服务（游戏服务器开发模式与 tools/serve.mjs 共用；桌面端 app:// 协议也复用 CSP 与路径白名单）。
// 游戏页带 CSP 响应头（SPEC §9.2：脚本 Worker 的 CSP 必须来自服务端响应头，Worker 继承页面策略）：
//   不允许 eval；Worker 只能来自本站或 blob:；网络只到本站与本地 LLM 代理 127.0.0.1:8787（M1 后改为只到本站）。

import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
});

/** 游戏页 CSP；extraConnect：额外允许连接的源（桌面端 = 游戏服务器地址）。 */
export function gameCsp(extraConnect = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    ["connect-src 'self'", ...extraConnect, 'http://127.0.0.1:8787 http://localhost:8787'].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export const GAME_CSP = gameCsp();

/** 对外提供的路径白名单：游戏入口、运行时代码与资源、两个调试页。其余（服务器源码、文档、测试、点目录、根目录杂项）一律 404。 */
const PUBLIC = /^\/(?:index\.html|favicon\.ico|(?:src|assets|tools\/preview|tools\/gallery)\/[^\0]*)$/;

/** 已解码的路径是否可以对外提供（白名单 + 不含 .. 与点开头的段）。 */
export function isPublicPath(p) {
  return PUBLIC.test(p) && !p.split('/').some((seg) => seg === '..' || seg.startsWith('.'));
}

/**
 * @param {string} root 仓库根目录
 * @param {{cache?: string}} [opt]
 * @returns {(req:any, res:any, pathname:string) => Promise<boolean>} 处理了返回 true
 */
export function createStaticHandler(root, { cache = 'no-store' } = {}) {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return async (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let p;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return true;
    }
    if (p === '/play' || p === '/play/') {
      res.writeHead(302, { Location: '/' });
      res.end();
      return true;
    }
    if (p.endsWith('/')) p += 'index.html';
    if (!isPublicPath(p)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return true;
    }
    const file = normalize(join(base, p));
    if (!file.startsWith(base)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    try {
      const data = await readFile(file);
      const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
      if (p === '/index.html') headers['Content-Security-Policy'] = GAME_CSP;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
    return true;
  };
}
