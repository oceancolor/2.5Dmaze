// 桌面端冒烟测试（06 §8.2 / V11）：用 playwright-core 启动 Electron，验证
//   app://maze 能加载、preload 暴露 window.mazeDesktop、渲染进程无 Node（安全基线）、
//   页面能连到游戏服务器（app:// 跨域 + CORS 预检这条 Web 版从不走的路径）。
// 用法：先在项目根 npm run play，再 node desktop/tools/e2e.mjs
// 环境变量 MAZE_E2E_SERVER 可改服务器地址（默认 http://127.0.0.1:5173）。
// 需要能开图形窗口的会话；CI 无显示环境时会明确报「启动失败」，不算功能回归。

import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = dirname(HERE);
const EXE = join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const SRV = process.env.MAZE_E2E_SERVER || 'http://127.0.0.1:5173';

const fail = (m) => {
  console.error('FAIL:', m);
  process.exitCode = 1;
};

const hz = await fetch(`${SRV}/healthz`).then((r) => r.json()).catch(() => null);
if (!hz || !hz.api) {
  fail(`游戏服务器不可用（${SRV}）：先在项目根运行 npm run play`);
  process.exit(1);
}
console.log('server:', hz.version, hz.rulesVersion);

const userData = mkdtempSync(join(tmpdir(), 'maze-e2e-'));
let app;
try {
  app = await electron.launch({
    executablePath: EXE,
    args: [DESKTOP, `--server=${SRV}`],
    env: { ...process.env, MAZE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  const diags = [];
  win.on('console', (m) => { if (m.type() === 'error') diags.push(`console: ${m.text()}`); });
  win.on('pageerror', (e) => diags.push(`pageerror: ${e.message}`));
  win.on('requestfailed', (r) => diags.push(`requestfailed: ${r.url().slice(0, 90)} ${r.failure()?.errorText || ''}`));
  await win.waitForFunction(() => Boolean(window.mazeDesktop), null, { timeout: 20000 });

  const info = await win.evaluate(async () => {
    const d = window.mazeDesktop;
    let healthz = null;
    try {
      const r = await fetch(`${d.serverOrigin}/healthz`);
      healthz = { status: r.status, api: (await r.json()).api };
    } catch (e) {
      healthz = { error: String(e) };
    }
    return {
      title: document.title,
      origin: location.origin,
      platform: d.platform,
      version: d.version,
      serverOrigin: d.serverOrigin,
      hasNode: typeof require !== 'undefined' || typeof process !== 'undefined',
      healthz,
    };
  });
  console.log('window:', JSON.stringify(info));
  if (diags.length) console.log('diags:', JSON.stringify(diags));

  if (info.platform !== 'desktop') fail('platform 不是 desktop（preload 没注入？）');
  if (info.hasNode) fail('渲染进程能访问 Node（nodeIntegration / sandbox 未生效）');
  if (info.healthz.api !== true) fail(`页面连不上游戏服务器：${JSON.stringify(info.healthz)}`);
  if (!process.exitCode) console.log('OK: 桌面端冒烟通过（app:// 加载 + 安全基线 + 跨域连通）');
} catch (e) {
  fail(`Electron 启动 / 加载失败：${e.message}`);
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
