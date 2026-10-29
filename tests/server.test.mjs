// S0 游戏服务器（06 §14）：记录校验（V01）、幂等上传（V02）、鉴权 / 限频 / 来源 / 版本（V06 / V07）、静态文件边界。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { makeConfig } from '../src/config/default.config.js';
import { createScheduler } from '../src/app/scheduler.js';
import { CLIENT_VERSION } from '../src/app/version.js';
import { openStore } from '../server/store/db.mjs';
import { createApp } from '../server/app.mjs';
import { verifyRecord, parseRecord, seatSource } from '../server/verifier.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CFG = makeConfig();
const TAGS = ['manual', 'mock:setHunter', 'proxy:chest', 'heuristic'];

function playRecord(seed, cfg = CFG) {
  const s = createScheduler(cfg, seed, { manual: false, seatLabels: TAGS });
  s.runSync(0);
  assert.ok(s.state.ended);
  return s.toJSONL();
}

const REC = playRecord(7);
const REC2 = playRecord(8);

/** 改第 k 条 turn 行的某个在场座位的意图。 */
function tamperIntent(text, k = 20) {
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  const turns = lines.filter((l) => l.t === 'turn');
  const L = turns[k];
  const seat = [...L.i].findIndex((c) => c !== '-');
  const swap = { N: 'S', S: 'N', E: 'W', W: 'E', '.': 'N' };
  L.i = L.i.slice(0, seat) + swap[L.i[seat]] + L.i.slice(seat + 1);
  return { text: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, turn: L.n };
}

function editLines(text, fn) {
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  fn(lines);
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

test('客户端版本与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLIENT_VERSION, pkg.version);
});

test('V01 校验器：诚实记录 verified；改一个意图 → mismatch 并指出回合；改分数 / 规则版本 / 配置各有结论', () => {
  const ok = verifyRecord(REC);
  assert.equal(ok.verify, 'verified', ok.verifyNote);
  assert.equal(ok.playerMode, 'manual');
  assert.equal(ok.ranking.length, 4);
  assert.ok(ok.turns > 50);

  const t = tamperIntent(REC);
  const bad = verifyRecord(t.text);
  assert.equal(bad.verify, 'mismatch');
  assert.ok(bad.verifyTurn >= t.turn, `应在第 ${t.turn} 回合或之后发现（撞墙的改动可能不改状态）：${bad.verifyNote}`);

  const score = verifyRecord(editLines(REC, (ls) => { ls[ls.length - 1].ranking[0].score += 5; }));
  assert.equal(score.verify, 'mismatch');
  assert.match(score.verifyNote, /排名/);

  const rules = verifyRecord(editLines(REC, (ls) => { ls[0].rulesVersion = 'SPEC-0.0'; }));
  assert.equal(rules.verify, 'unverifiable');

  const conf = verifyRecord(editLines(REC, (ls) => { ls[0].configHash = '00000000'; }));
  assert.equal(conf.verify, 'mismatch');
  assert.equal(conf.verifyTurn, 0);
});

test('校验器：结构不合格直接拒收（400 / 422），不跑内核', () => {
  const code = (fn) => { try { fn(); return 0; } catch (e) { return e.status; } };
  assert.equal(code(() => parseRecord('')), 400);
  assert.equal(code(() => parseRecord('not json\n')), 400);
  assert.equal(code(() => parseRecord(editLines(REC, (ls) => { ls[0].t = 'x'; }))), 400);
  assert.equal(code(() => parseRecord(editLines(REC, (ls) => { ls[3].i = 'NNNNN'; }))), 400);
  assert.equal(code(() => parseRecord(editLines(REC, (ls) => { ls[0].seats = ['<script>', 'a', 'b', 'c']; }))), 400);
  assert.equal(code(() => parseRecord(editLines(REC, (ls) => { ls.push({ t: 'turn', n: 1, i: '....', h: '00000000' }); }))), 400, 'end 之后还有内容');
  assert.equal(code(() => parseRecord(editLines(REC, (ls) => { ls.pop(); }))), 422, '没有 end 行');
  assert.equal(seatSource('mock:setHunter'), 'mock');
  assert.equal(seatSource('prompt-proxy'), 'proxy');
});

async function boot(options = {}) {
  const store = await openStore(':memory:');
  let clock = 1_800_000_000_000;
  const app = createApp({ store, root: ROOT, now: () => clock, options: { allowedOrigins: ['app://maze'], ...options } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    store, base, call,
    tick: (ms) => { clock += ms; },
    close: () => new Promise((r) => server.close(() => { store.close(); r(); })),
  };
}

const CLIENT = { 'X-Maze-Client': `web/${CLIENT_VERSION}` };
const mid = (k) => `m${String(k).padStart(31, '0')}`;

test('V05 桌面端跨域（app://maze）：healthz 带 CORS 头；POST 预检 OPTIONS 204 且放行自定义头；非白名单来源 403', async () => {
  const s = await boot();
  try {
    const O = { headers: { Origin: 'app://maze' } };
    const hz = await s.call('GET', '/healthz', O);
    assert.equal(hz.status, 200);
    assert.equal(hz.headers.get('access-control-allow-origin'), 'app://maze');

    // 跨域 POST 带 Authorization / Content-Type / X-Maze-Client → 浏览器先发 OPTIONS 预检
    const pre = await s.call('OPTIONS', '/api/v1/keys', {
      headers: { Origin: 'app://maze', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-maze-client' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'app://maze');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Maze-Client/i);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);

    // 白名单外的来源：/api/* 一律 403；healthz 公开但不回 CORS 头（浏览器读不到）
    assert.equal((await s.call('GET', '/api/v1/providers', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const bad = await s.call('GET', '/healthz', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 200);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('S0 HTTP：游客 → 上传（校验 / 幂等 / 冲突）→ 战绩 → 详情 → 下载；别人看不到', async () => {
  const s = await boot();
  try {
    const hz = await s.call('GET', '/healthz');
    assert.equal(hz.status, 200);
    assert.equal(hz.json.api, true);

    const g = await s.call('POST', '/api/v1/guest', { body: { nickname: '测试玩家' } });
    assert.equal(g.status, 201);
    assert.match(g.json.token, /^mq_/);
    const tok = g.json.token;
    assert.ok(!s.store.db.prepare('SELECT token_hash FROM users').get().token_hash.includes(tok.slice(3)), '库里只有哈希');

    const me = await s.call('GET', '/api/v1/me', { token: tok });
    assert.equal(me.status, 200);
    assert.equal(me.json.nickname, '测试玩家');
    assert.equal(me.json.matches, 0);

    assert.equal((await s.call('GET', '/api/v1/me')).status, 401);
    assert.equal((await s.call('GET', '/api/v1/me', { token: 'mq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status, 401);

    const up = { matchId: mid(1), record: REC, startedAt: 1_799_999_000_000, endedAt: 1_799_999_900_000 };
    assert.equal((await s.call('POST', '/api/v1/matches', { token: tok, body: up })).status, 400, '缺 X-Maze-Client');
    const old = await s.call('POST', '/api/v1/matches', { token: tok, body: up, headers: { 'X-Maze-Client': 'web/0.0.1' } });
    assert.equal(old.status, 426, 'V07 过旧客户端');
    assert.equal(old.json.error, 'client_outdated');

    const a = await s.call('POST', '/api/v1/matches', { token: tok, body: up, headers: CLIENT });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.verify, 'verified');
    assert.equal(a.json.duplicate, false);
    assert.equal(a.json.platform, 'web');
    assert.deepEqual(a.json.seats.map((x) => x.source), ['manual', 'mock', 'proxy', 'heuristic']);

    const again = await s.call('POST', '/api/v1/matches', { token: tok, body: up, headers: CLIENT });
    assert.equal(again.status, 200, 'V02 同一 matchId 同一内容：幂等');
    assert.equal(again.json.duplicate, true);
    assert.equal((await s.call('POST', '/api/v1/matches', { token: tok, body: { ...up, record: REC2 }, headers: CLIENT })).status, 409);

    const t = tamperIntent(REC2);
    const b = await s.call('POST', '/api/v1/matches', { token: tok, body: { matchId: mid(2), record: t.text }, headers: CLIENT });
    assert.equal(b.status, 201);
    assert.equal(b.json.verify, 'mismatch');
    assert.ok(Number.isInteger(b.json.verifyTurn));
    const n = (id) => s.store.db.prepare('SELECT COUNT(*) AS n FROM seat_stats WHERE match_id = ?').get(id).n;
    assert.equal(n(mid(1)), 4, '通过校验的对局进座位统计');
    assert.equal(n(mid(2)), 0, '不一致的对局不进统计');

    s.tick(1000);
    const list = await s.call('GET', '/api/v1/matches?limit=10', { token: tok });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 2);
    assert.deepEqual(list.json.items.map((x) => x.matchId), [mid(2), mid(1)], '按收到时间倒序');

    const d = await s.call('GET', `/api/v1/matches/${mid(1)}`, { token: tok });
    assert.equal(d.status, 200);
    assert.equal(d.json.startedAt, up.startedAt);
    const rec = await s.call('GET', `/api/v1/matches/${mid(1)}/record`, { token: tok });
    assert.equal(rec.status, 200);
    assert.equal(rec.text, REC, '下载回来的记录逐字节相同');

    const other = (await s.call('POST', '/api/v1/guest', { body: {} })).json.token;
    assert.equal((await s.call('GET', `/api/v1/matches/${mid(1)}`, { token: other })).status, 404, '别人的对局 404');
    assert.equal((await s.call('GET', `/api/v1/matches/${mid(1)}/record`, { token: other })).status, 404);
    assert.equal((await s.call('POST', '/api/v1/matches', { token: other, body: up, headers: CLIENT })).status, 409, '别人不能占用同一 matchId');
    assert.equal((await s.call('GET', '/api/v1/matches', { token: other })).json.total, 0);
  } finally {
    await s.close();
  }
});

test('S0 HTTP 边界：请求体上限 413、坏 JSON 400、限频 429（V06）、跨域白名单、未知接口 404', async () => {
  const s = await boot({ limits: { guestBurst: 3, guestPerMinute: 1 } });
  try {
    const tok = (await s.call('POST', '/api/v1/guest', { body: {} })).json.token;
    const big = await s.call('POST', '/api/v1/matches', { token: tok, headers: CLIENT, body: { matchId: mid(9), record: 'x'.repeat(1024 * 1024 + 10) } });
    assert.equal(big.status, 413);
    assert.equal((await s.call('POST', '/api/v1/matches', { token: tok, headers: { ...CLIENT, 'Content-Type': 'application/json' }, raw: '{oops' })).status, 400);
    assert.equal((await s.call('POST', '/api/v1/matches', { token: tok, headers: CLIENT, body: { matchId: 'short', record: REC } })).status, 400);
    assert.equal((await s.call('POST', '/api/v1/guest', { body: { nickname: '<b>x</b>' } })).status, 400);

    assert.equal((await s.call('POST', '/api/v1/guest', { body: {} })).status, 201);
    const lim = await s.call('POST', '/api/v1/guest', { body: {} });
    assert.equal(lim.status, 429, '第 4 次超出突发额度');
    assert.ok(Number(lim.headers.get('retry-after')) > 0);
    s.tick(60_000);
    assert.equal((await s.call('POST', '/api/v1/guest', { body: {} })).status, 201, '过一会儿恢复');
    assert.equal((await s.call('GET', '/api/v1/me', { token: tok })).status, 200, '限频只针对创建游客，不影响已有用户');

    const evil = await s.call('GET', '/api/v1/me', { token: tok, headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const shell = await s.call('GET', '/api/v1/me', { token: tok, headers: { Origin: 'app://maze' } });
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get('access-control-allow-origin'), 'app://maze');
    const same = await s.call('GET', '/api/v1/me', { token: tok, headers: { Origin: s.base } });
    assert.equal(same.status, 200, '同源放行');
    const pre = await s.call('OPTIONS', '/api/v1/matches', { headers: { Origin: 'app://maze' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

    assert.equal((await s.call('GET', '/api/v1/nope', { token: tok })).status, 404);
    assert.equal((await s.call('DELETE', '/api/v1/me', { token: tok })).status, 405);
  } finally {
    await s.close();
  }
});

test('备份：VACUUM INTO 快照可独立打开、数据完整；只保留最近 N 份', async () => {
  const { mkdtempSync, rmSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { backupTo, prune } = await import('../server/backup.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'maze-bk-'));
  try {
    const dbPath = join(dir, 'live.db');
    const live = await openStore(dbPath);
    live.createUser({ id: 'u_test', tokenHash: 'h'.repeat(64), now: 1 });
    live.close();
    const snap = await backupTo(dbPath, join(dir, 'maze-20261029-120000.db'));
    const b = await openStore(snap);
    assert.equal(b.userByTokenHash('h'.repeat(64)).id, 'u_test');
    b.close();
    for (const s of ['20261027-120000', '20261028-120000']) writeFileSync(join(dir, `maze-${s}.db`), '');
    assert.deepEqual(prune(dir, 2), ['maze-20261027-120000.db']);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('maze-')).sort(), ['maze-20261028-120000.db', 'maze-20261029-120000.db']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('开发模式静态文件：游戏页带 CSP；服务器源码 / 文档 / 点目录不对外；路径穿越拦截', async () => {
  const s = await boot();
  try {
    const home = await s.call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await s.call('GET', '/src/app/version.js')).status, 200);
    for (const p of ['/server/app.mjs', '/server/store/db.mjs', '/docs/SPEC.md', '/.data/maze.db', '/.git/config', '/proxy/proxy.mjs',
      '/tests/server.test.mjs', '/package.json', '/README.md', '/tools/serve.mjs', '/src/.hidden']) {
      assert.equal((await s.call('GET', p)).status, 404, p);
    }
    assert.equal((await s.call('GET', '/tools/preview/')).status, 200, '调试页照常可用');
    const trav = await s.call('GET', '/src/%2e%2e/%2e%2e/package.json');
    assert.ok([403, 404].includes(trav.status), `路径穿越 ${trav.status}`);
    const enc = await s.call('GET', '/src/..%2f..%2fpackage.json');
    assert.ok([403, 404].includes(enc.status), `编码斜杠穿越 ${enc.status}`);
  } finally {
    await s.close();
  }
});
