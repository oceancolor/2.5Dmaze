// 桌面端配置（不依赖 electron，可测试）。

const LOOP_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 游戏服务器地址只取 origin；http 只允许本机（开发 / 本机测试），其余必须 https。 */
export function serverOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    throw new Error(`游戏服务器地址格式不对：${raw}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOP_HOSTS.has(u.hostname))) throw new Error(`游戏服务器地址必须是 https：${raw}`);
  return u.origin;
}

export const DEFAULT_SERVER = 'https://maze.aiquiz.games';
export const DEFAULT_UPDATE_URL = 'https://maze.aiquiz.games/desktop/';
