// 桌面端 preload（06 §8.2）：沙箱里运行，只通过 contextBridge 暴露最小接口 window.mazeDesktop。
// 网页据此判断自己在桌面端。这里没有任何 key：key 只在主进程里，网页只拿到服务商 / 模型名 / 尾号。

const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const p = `--maze-${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : '';
};
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mazeDesktop', {
  platform: 'desktop',
  version: arg('version'),
  electron: process.versions.electron,
  /** 游戏服务器地址（页面在 app://maze/ 下，接口要带完整地址）。 */
  serverOrigin: arg('server'),
  /** 本机保存的模型 key：列出 / 保存（保存后网页再也拿不到明文）/ 删除；服务商预设。 */
  keys: {
    providers: () => invoke('maze:keys:providers'),
    list: () => invoke('maze:keys:list'),
    add: (spec) => invoke('maze:keys:add', spec),
    remove: (keyId) => invoke('maze:keys:remove', keyId),
  },
  /** 本机直连：{keyId, seat, kind, messages, max_tokens, temperature, timeoutMs} → {ok, text, usage, model, ms} | {ok:false, kind, message}。 */
  llm: {
    chat: (req) => invoke('maze:llm:chat', req),
    usage: () => invoke('maze:llm:usage'),
  },
  /** 检查更新；outdated：服务器说客户端版本过旧（426）时调用。 */
  update: {
    check: () => invoke('maze:update:check'),
    outdated: () => invoke('maze:update:outdated'),
  },
});
