// 打包前的准备（06 §8.2）：把网页与服务器代码按「和仓库相同的布局」拷进 desktop/.stage/，
// 让 electron-builder 以 .stage 为 app 根打包。main.mjs 里 WEB = dirname(main)/..，对应 .stage 根；
// package.json 在 .stage 根，main = desktop/main.mjs，mazeServer 等配置一并写入（打包后不再认命令行 / 环境变量）。
// 保持 src/、assets/、index.html、server/、desktop/ 的相对关系，main.mjs 的 app:// 路径白名单照常生效。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..');
const ROOT = resolve(DESKTOP, '..');
const STAGE = join(DESKTOP, '.stage');

const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

/** 只拷运行时需要的文件；server 里带 .data / db 的目录不存在，api/ 里带数据库依赖的不打（main.mjs 不 import 它们）。 */
const COPY = [
  ['index.html', 'index.html'],
  ['src', 'src'],
  ['assets', 'assets'],
  ['server/static.mjs', 'server/static.mjs'],
  ['server/providers.mjs', 'server/providers.mjs'],
  ['server/llm-relay.mjs', 'server/llm-relay.mjs'],
  ['server/vault.mjs', 'server/vault.mjs'],
  ['desktop/main.mjs', 'desktop/main.mjs'],
  ['desktop/preload.cjs', 'desktop/preload.cjs'],
  ['desktop/local', 'desktop/local'],
];
for (const [from, to] of COPY) {
  const src = join(ROOT, from);
  const dest = join(STAGE, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// 图标是打包必需资源：先跑 npm run icon 生成 desktop/build/icon.{png,ico}。
// 缺失时明确报错（electron-builder 的 win.icon 依赖它），而不是留到打包阶段才失败。
const buildSrc = join(DESKTOP, 'build');
const iconIco = join(buildSrc, 'icon.ico');
if (!existsSync(iconIco)) {
  throw new Error(`缺少安装包图标 ${iconIco}：先运行 npm run icon（在 desktop 目录）`);
}
cpSync(buildSrc, join(STAGE, 'desktop', 'build'), { recursive: true });

const staged = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  private: true,
  main: 'desktop/main.mjs',
  mazeServer: pkg.mazeServer || 'https://maze.aiquiz.games',
  mazeUpdateUrl: pkg.mazeUpdateUrl || 'https://maze.aiquiz.games/desktop/',
  mazeDownloadPage: pkg.mazeDownloadPage || 'https://maze.aiquiz.games/',
  mazeSigned: pkg.mazeSigned === true,
  dependencies: { 'electron-updater': pkg.dependencies['electron-updater'] },
};
writeFileSync(join(STAGE, 'package.json'), JSON.stringify(staged, null, 2));
console.log(`staged ${COPY.length} entries → ${STAGE}`);
console.log(`server=${staged.mazeServer} signed=${staged.mazeSigned}`);
