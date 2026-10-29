// 客户端版本（随 package.json 的 version 一起改；tests/server.test.mjs 断言两者一致）。
// 上传对局时作为 X-Maze-Client: <platform>/<version> 发给服务器，服务器据此拒绝过旧的客户端（06 §6.4）。
export const CLIENT_VERSION = '0.3.0';
