// 桌面端主进程（06 §8.2）：窗口、app:// 协议、安全基线、IPC（本机 key / 直连调用 / 版本 / 更新）。
//
// 加载：注册「标准 + 安全」的 app://maze/，网页文件来自安装包（开发时来自仓库根），不用 file://。
//   路径白名单与 CSP 复用 server/static.mjs；CSP 另加游戏服务器地址（connect-src）。
// 安全基线（每个窗口，V11 自动检查）：contextIsolation / sandbox / 无 Node / webSecurity；
//   网页只能用 preload 暴露的 window.mazeDesktop；禁止导航到外部，外部链接交给系统浏览器；拒绝一切权限请求；不加载远程代码。
// 本机直连（模式 B）：key 用 safeStorage 加密存在用户目录，主进程附上 key 调用服务商，网页拿不到 key。
//
// 配置：游戏服务器地址来自打包时写进 package.json 的 mazeServer（默认 https://maze.aiquiz.games）；
//   只有开发模式（未打包）认命令行 --server= / 环境变量 MAZE_SERVER / MAZE_USER_DATA。

import { app, BrowserWindow, ipcMain, Menu, protocol, safeStorage, session, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME, gameCsp, isPublicPath } from '../server/static.mjs';
import { createLocalVault } from './local/vault.mjs';
import { createDirect, localProviderList } from './local/direct.mjs';
import { createUpdater } from './local/update.mjs';

// 必须在 ready 之前、任何 await 之前
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const HERE = dirname(fileURLToPath(import.meta.url));
/** 网页根：开发 = 仓库根；安装包 = app.asar 根（stage 保持与仓库相同的布局）。 */
const WEB = normalize(join(HERE, '..'));
const ORIGIN = 'app://maze';
const DEV = !app.isPackaged;
const PKG = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
const VERSION = PKG.version;

const argOf = (name) => {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
};

/** 服务器地址只取 origin；http 只允许本机（开发 / 本机测试），其余必须 https。 */
export function serverOrigin(raw) {
  const u = new URL(raw);
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new Error(`游戏服务器地址必须是 https：${raw}`);
  return u.origin;
}

const SERVER = serverOrigin((DEV && (argOf('server') || process.env.MAZE_SERVER)) || PKG.mazeServer || 'https://maze.aiquiz.games');
const CSP = gameCsp([SERVER]);

app.setPath('userData', (DEV && process.env.MAZE_USER_DATA) || join(app.getPath('appData'), DEV ? 'maze-quest-dev' : 'maze-quest'));
if (!app.requestSingleInstanceLock()) app.quit();

const vault = createLocalVault({
  file: join(app.getPath('userData'), 'keys.json'),
  crypto: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  },
  now: Date.now,
});
const direct = createDirect({ vault, ledgerFile: join(app.getPath('userData'), 'usage.json'), now: Date.now });
const updater = createUpdater({ app, pkg: PKG, dev: DEV });

// ───────── app:// 协议 ─────────

const notFound = () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function serveApp(request) {
  const url = new URL(request.url);
  if (url.host !== 'maze') return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (p === '/') p = '/index.html';
  // 安装包里只有游戏本身：调试页（tools/）不对外
  if (!isPublicPath(p) || p.startsWith('/tools/')) return notFound();
  const file = normalize(join(WEB, p));
  if (!file.startsWith(WEB.endsWith(sep) ? WEB : WEB + sep)) return new Response(null, { status: 403 });
  try {
    const data = await readFile(file);
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (p === '/index.html') headers['Content-Security-Policy'] = CSP;
    return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
  } catch {
    return notFound();
  }
}

// ───────── 安全基线 ─────────

function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch {
    /* 不是合法地址：忽略 */
  }
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    openOutside(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
});

/** IPC 只接受来自本应用页面的调用（防止万一被导航走的页面调用本机能力）。 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    const u = e.senderFrame && e.senderFrame.url;
    if (typeof u !== 'string' || !u.startsWith(`${ORIGIN}/`)) throw new Error('forbidden');
    return fn(...args);
  });
}

handle('maze:keys:providers', () => ({ items: localProviderList(), canRemember: vault.canRemember() }));
handle('maze:keys:list', () => ({ items: vault.list(), canRemember: vault.canRemember() }));
handle('maze:keys:add', (spec) => direct.addKey(spec));
handle('maze:keys:remove', (id) => vault.remove(String(id ?? '')));
handle('maze:llm:chat', (req) => direct.chat(req));
handle('maze:llm:usage', () => direct.usage());
handle('maze:update:check', () => updater.check({ interactive: true }));
handle('maze:update:outdated', () => updater.check({ interactive: true, outdated: true }));

// ───────── 窗口 ─────────

function createWindow() {
  const icon = join(HERE, 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#14110d',
    title: '迷宫寻宝',
    autoHideMenuBar: true,
    ...(DEV && existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: DEV || process.env.MAZE_DEVTOOLS === '1',
      additionalArguments: [`--maze-server=${SERVER}`, `--maze-version=${VERSION}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  let reloads = 0;
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit' && reloads++ < 2) win.loadURL(`${ORIGIN}/index.html`);
  });
  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.protocol.handle('app', serveApp);
  // 游戏用不到任何权限（摄像头、通知、定位……）；开发时连本机服务器需要的本地网络访问除外
  const loopServer = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(SERVER);
  const allow = (perm) => loopServer && (perm === 'local-network-access' || perm === 'loopback-network' || perm === 'local-network');
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allow(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => allow(perm));
  if (!DEV) Menu.setApplicationMenu(null);
  createWindow();
  updater.start();
});

app.on('window-all-closed', () => app.quit());
