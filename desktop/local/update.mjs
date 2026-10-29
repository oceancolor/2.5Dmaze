// 自动更新（06 §8.2）：electron-updater，generic 源（默认 https://maze.aiquiz.games/desktop/）。
// 「下载的安装包必须带有效签名才安装」：
//   签过名的版本（打包时 package.json 写入 mazeSigned=true，electron-builder 写入 publisherName，安装前由 electron-updater 校验签名）
//     → 自动下载，询问后重启安装（不点就退出时安装）；
//   未签名的版本 → 只提示「有新版本」并打开下载页，绝不自动下载安装。
// 开发模式（未打包）不检查。服务器返回 426（客户端过旧）时网页调用 outdated()，立即检查一次。

import { DEFAULT_UPDATE_URL } from './config.mjs';

/** 发现新版本后怎么做（纯函数，便于测试）。 */
export function updatePlan({ signed, available }) {
  if (!available) return 'none';
  return signed ? 'download' : 'notify';
}

/**
 * @param {{app:object, dialog?:object, shell?:object, pkg:object, dev:boolean, env?:object,
 *          load?:()=>Promise<object>, getWindow?:()=>object|null}} o
 */
export function createUpdater({ app, dialog, shell, pkg, dev, env = process.env, load = () => import('electron-updater'), getWindow = () => null }) {
  const signed = pkg.mazeSigned === true;
  // 测试更新流程用：只有未签名版本认环境变量（未签名版本只会打开下载页，不会安装任何东西）
  const feed = (!signed && env.MAZE_UPDATE_URL) || pkg.mazeUpdateUrl || DEFAULT_UPDATE_URL;
  const downloadPage = pkg.mazeDownloadPage || DEFAULT_UPDATE_URL;
  let updater = null;
  let state = { status: dev ? 'disabled' : 'idle', version: null, signed, error: null };
  let notified = null;

  async function init() {
    if (updater) return updater;
    const mod = await load();
    updater = mod.autoUpdater ?? (mod.default && mod.default.autoUpdater);
    updater.setFeedURL({ provider: 'generic', url: feed });
    updater.autoDownload = signed;
    updater.autoInstallOnAppQuit = signed;
    updater.allowDowngrade = false;
    updater.on('update-downloaded', (info) => {
      state = { ...state, status: 'downloaded', version: info.version };
      if (!dialog) return;
      dialog.showMessageBox(getWindow(), {
        type: 'info', buttons: ['立即重启安装', '退出时再装'], defaultId: 0, cancelId: 1,
        title: '迷宫寻宝 · 更新', message: `新版本 ${info.version} 已下载`, detail: '安装包签名已校验。',
      }).then((r) => {
        if (r.response === 0) updater.quitAndInstall();
      });
    });
    return updater;
  }

  function notify(version, outdated) {
    if (!dialog || notified === version) return;
    notified = version;
    dialog.showMessageBox(getWindow(), {
      type: 'info', buttons: ['打开下载页', '以后再说'], defaultId: 0, cancelId: 1,
      title: '迷宫寻宝 · 更新',
      message: `发现新版本 ${version}（当前 ${app.getVersion()}）`,
      detail: `${outdated ? '游戏服务器要求更新后才能上传对局（已结束的对局留在本机，更新后自动补传）。\n' : ''}这个版本的安装包还没有代码签名，不能自动安装，请到下载页下载新版安装包。`,
    }).then((r) => {
      if (r.response === 0 && shell) shell.openExternal(downloadPage);
    });
  }

  return {
    get state() {
      return { ...state };
    },

    /** 启动后延迟检查一次。 */
    start(delayMs = 8000) {
      if (dev) return;
      setTimeout(() => this.check({ interactive: false }).catch(() => {}), delayMs).unref?.();
    },

    /** 检查更新；返回 {status, version, signed}。对话框异步弹出，不等用户点。 */
    async check({ interactive = false, outdated = false } = {}) {
      if (dev) return { ...state };
      state = { ...state, status: 'checking', error: null };
      try {
        const u = await init();
        const r = await u.checkForUpdates();
        const info = r && r.updateInfo;
        const available = Boolean(r && r.isUpdateAvailable !== false && info && info.version && info.version !== app.getVersion());
        const plan = updatePlan({ signed, available });
        state = { ...state, status: plan === 'none' ? 'latest' : plan === 'download' ? 'downloading' : 'available', version: available ? info.version : null };
        if (plan === 'notify') notify(info.version, outdated);
        else if (plan === 'none' && outdated && dialog) {
          dialog.showMessageBox(getWindow(), {
            type: 'warning', buttons: ['打开下载页', '关闭'], defaultId: 0, cancelId: 1, title: '迷宫寻宝 · 更新',
            message: '游戏服务器要求更新客户端', detail: '自动检查没有找到新版本，请到下载页手动下载。',
          }).then((x) => {
            if (x.response === 0 && shell) shell.openExternal(downloadPage);
          });
        }
      } catch (e) {
        state = { ...state, status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200) };
        if (interactive && outdated && dialog && shell) shell.openExternal(downloadPage);
      }
      return { ...state };
    },
  };
}
