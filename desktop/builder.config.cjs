// electron-builder 配置（06 §8.2）：以 tools/stage.mjs 生成的 .stage/ 为 app 根打 Windows NSIS 安装包。
// 签名：打包时若 staged package.json 的 mazeSigned=true，则写入 publisherName，electron-updater 安装前校验签名；
//   没有代码签名证书时保持 mazeSigned=false，壳只用「提示 + 打开下载页」，绝不自动下载安装（见 local/update.mjs）。

const pkg = require('./package.json');

module.exports = {
  appId: 'games.aiquiz.maze',
  productName: pkg.productName || '迷宫寻宝',
  copyright: 'Copyright © 2026',
  directories: {
    app: '.stage',
    output: 'release',
    buildResources: 'build',
  },
  asar: true,
  files: ['**/*'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    ...(pkg.mazeSigned ? { publisherName: pkg.mazePublisherName || 'Maze Quest' } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: pkg.productName || '迷宫寻宝',
  },
  publish: [{ provider: 'generic', url: pkg.mazeUpdateUrl || 'https://maze.aiquiz.games/desktop/' }],
};
