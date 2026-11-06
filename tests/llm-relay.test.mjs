// M1 服务器（05 §7、06 §7）：服务商预设、SSRF 防护、key 保管（V04 / X05）、大模型中转与错误分类、用量（谁用谁付）、
// 模式 B 对局上传后的报告与思路（仅本人可见）。上游一律用测试替身，不连外网。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeConfig } from '../src/config/default.config.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { mockPlan } from '../src/ai/mock-llm.js';
import { AUTONOMY, buildMessages, buildPayload } from '../src/ai/codec.js';
import { observe } from '../src/core/observe.js';
import { createMatch } from '../src/core/state.js';
import { CLIENT_VERSION } from '../src/app/version.js';
import { openStore } from '../server/store/db.mjs';
import { createApp } from '../server/app.mjs';
import { checkBaseUrl, guardedLookup, isPublicAddress, extraBody, outputBudget, PROVIDERS } from '../server/providers.mjs';
import { createLlmLog } from '../server/llm-log.mjs';
import { createVault, keyHint } from '../server/vault.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BCFG = makeConfig({ match: { playerMode: 'byok' } });
const SECRET = `sk-${randomBytes(18).toString('base64url')}`;
const CLIENT = { 'X-Maze-Client': `web/${CLIENT_VERSION}` };
const mid = (k) => `m${String(k).padStart(31, '0')}`;

/** 从中转请求体里取回局面，用模拟大模型按契约作答（相当于一个守规矩的真模型）。 */
function planFromBody(b) {
  const user = b.messages.find((m) => m.role === 'user').content;
  const payload = JSON.parse(user.slice('局面：'.length).split('\n本次决策：')[0]);
  return mockPlan(payload, '', { contract: true });
}

const okReply = (b) => ({
  status: 200,
  text: JSON.stringify({ model: b.model, choices: [{ message: { content: planFromBody(b) }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 35 } }),
});

function fakeUpstream() {
  const calls = [];
  let behave = okReply;
  const fn = async ({ url, headers, body, timeoutMs }) => {
    const b = JSON.parse(body);
    calls.push({ url, auth: headers.Authorization, body: b, timeoutMs });
    return behave(b);
  };
  fn.calls = calls;
  fn.set = (f) => { behave = f; };
  return fn;
}

async function boot({ dbPath = ':memory:', masterKey = randomBytes(32), upstream = fakeUpstream(), limits, llmLog = null } = {}) {
  const store = await openStore(dbPath);
  let clock = 1_800_000_000_000;
  const app = createApp({ store, root: ROOT, now: () => clock, upstream, llmLog, options: { allowedOrigins: ['app://maze'], masterKey, limits } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const texts = [];
  const call = async (method, path, { token, body } = {}) => {
    const h = { ...CLIENT };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    texts.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* 204 */ }
    return { status: r.status, json, text };
  };
  const guest = async () => (await call('POST', '/api/v1/guest', { body: {} })).json.token;
  return {
    store, call, guest, upstream, texts,
    tick: (ms) => { clock += ms; },
    close: () => new Promise((r) => server.close(() => { store.close(); r(); })),
  };
}

function openingMessages(autonomy = 'blend') {
  const m = createMatch(1, BCFG);
  const obs = observe(m.map, m.state, 0, BCFG, { patch: true });
  return buildMessages(buildPayload(m.map, obs, BCFG), '先凑红黄绿', BCFG, { autonomy, context: { why: 'start', plan: null, budget: 70 } });
}

test('SSRF：只放行 https 公网地址；内网 / 回环 / 链路本地 / 元数据地址、账号密码、非 443 端口一律拒绝；DNS 解析结果再查一次', async () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2400:3200::1', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '198.18.0.1',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', 'localhost', 'x']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(checkBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(checkBaseUrl(' https://ark.cn-beijing.volces.com:443/api/v3 '), 'https://ark.cn-beijing.volces.com/api/v3');
  for (const u of ['http://api.deepseek.com/v1', 'https://localhost/v1', 'https://foo.localhost/v1', 'https://10.0.0.5/v1', 'https://169.254.169.254/latest',
    'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://u:p@api.x.com/v1', 'https://api.x.com:8443/v1', 'https://api.x.com/v1?k=1', 'https://intranet/v1',
    'https://svc.internal/v1', 'https://nas.lan/v1', 'ftp://x.com/', 'file:///etc/passwd', 'not a url', '']) {
    assert.throws(() => checkBaseUrl(u), Error, u);
  }
  const lookup = (host, opts) => new Promise((resolve) => guardedLookup(host, opts, (err, addr) => resolve(err ? err.code : addr)));
  assert.equal(await lookup('127.0.0.1', {}), 'ESSRF');
  assert.equal(await lookup('169.254.169.254', { all: true }), 'ESSRF');
  assert.equal(await lookup('localhost', { all: true }), 'ESSRF', 'DNS 解析到回环也拒绝（防 DNS 重绑定）');
  assert.deepEqual(await lookup('8.8.8.8', { all: true }), [{ address: '8.8.8.8', family: 4 }]);
});

test('服务商预设：只留 HY4 / K3 / DeepSeek V4.1 Flash / GLM-5.3 Flash（同一 MaaS 网关）+ 自定义；各家关思考写法与输出预算', () => {
  const MAAS = 'https://tokenhub.tencentmaas.com/v1';
  assert.deepEqual(Object.keys(PROVIDERS), ['hunyuan', 'kimi', 'deepseek', 'glm', 'custom']);
  const models = { hunyuan: 'hy4-preview', kimi: 'kimi-k3', deepseek: 'deepseek-v4.1-flash', glm: 'glm-5.3-flash' };
  for (const [id, model] of Object.entries(models)) {
    assert.equal(PROVIDERS[id].baseUrl, MAAS, id);
    assert.equal(PROVIDERS[id].model, model, id);
  }
  // 实测：HY4 / K3 / DeepSeek 认 thinking:disabled；GLM 对它回 400，只能 reasoning_effort:'low'
  for (const id of ['hunyuan', 'kimi', 'deepseek']) {
    assert.deepEqual(extraBody(id, false), { thinking: { type: 'disabled' } }, id);
    assert.deepEqual(extraBody(id, true), {}, `${id} 勾推理模型才放开思考`);
  }
  assert.deepEqual(extraBody('glm', false), { reasoning_effort: 'low' });
  assert.deepEqual(extraBody('glm', true), {});
  assert.deepEqual(extraBody('custom', false), {});
  assert.deepEqual(extraBody('moonshot', false), {}, '已下线的服务商不附加字段');

  // 输出预算：请求值先抬到服务商下限，再按档位封顶
  assert.equal(outputBudget('kimi', 200, false), 200);
  assert.equal(outputBudget('kimi', 9999, false), 400);
  assert.equal(outputBudget('kimi', 9999, true), 4000);
  assert.equal(outputBudget('glm', 200, false), 1000, 'GLM 思考关不掉，给残余思考留余量');
  assert.equal(outputBudget('glm', 4000, true), 4000);
  assert.equal(outputBudget('custom', undefined, false), 200);
});

test('Kimi K3 测试连接：普通档关思考用 200 token；推理档放开思考并放宽到 4000 token / 90 秒', async () => {
  const up = fakeUpstream();
  const s = await boot({ upstream: up });
  try {
    const A = await s.guest();
    for (const [reasoning, wantTokens, wantTimeout] of [[false, 200, 45000], [true, 4000, 90000]]) {
      const saved = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'kimi', apiKey: SECRET, reasoning } });
      assert.equal(saved.status, 201);
      const t = await s.call('POST', `/api/v1/keys/${saved.json.keyId}/test`, { token: A, body: { autonomy: 'blend' } });
      assert.equal(t.status, 200);
      assert.equal(t.json.ok, true, t.json.error);
      const c = up.calls.at(-1);
      assert.equal(c.body.model, 'kimi-k3');
      assert.equal(c.body.max_tokens, wantTokens);
      assert.equal(c.timeoutMs, wantTimeout);
      if (reasoning) assert.equal(c.body.thinking, undefined);
      else assert.deepEqual(c.body.thinking, { type: 'disabled' });
    }
    // GLM：普通档带 reasoning_effort:'low'，输出预算抬到 1000；中转同样适用
    const g = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'glm', apiKey: SECRET } });
    await s.call('POST', `/api/v1/keys/${g.json.keyId}/test`, { token: A, body: {} });
    assert.equal(up.calls.at(-1).body.reasoning_effort, 'low');
    assert.equal(up.calls.at(-1).body.thinking, undefined);
    assert.equal(up.calls.at(-1).body.max_tokens, 1000);
    const relay = await s.call('POST', '/llm/v1/chat', { token: A, body: { keyId: g.json.keyId, matchId: mid(7), seat: 0, messages: openingMessages(), max_tokens: 200 } });
    assert.equal(relay.status, 200);
    assert.equal(up.calls.at(-1).body.max_tokens, 1000);
  } finally {
    await s.close();
  }
});

test('对话日志：中转与测试连接逐行写 JSONL（按日期 / 对局分文件），含完整 messages 与回复；绝不含 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-llmlog-'));
  const llmLog = createLlmLog({ dir, now: () => 1_800_000_000_000 });
  const s = await boot({ llmLog });
  try {
    const A = await s.guest();
    const k = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'hunyuan', apiKey: SECRET } });
    await s.call('POST', `/api/v1/keys/${k.json.keyId}/test`, { token: A, body: {} });
    const M = mid(42);
    const msgs = openingMessages();
    assert.equal((await s.call('POST', '/llm/v1/chat', { token: A, body: { keyId: k.json.keyId, matchId: M, seat: 0, kind: 'plan', messages: msgs } })).status, 200);
    s.upstream.set(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' }));
    assert.equal((await s.call('POST', '/llm/v1/chat', { token: A, body: { keyId: k.json.keyId, matchId: M, seat: 0, kind: 'repair', messages: msgs } })).status, 502);
    await llmLog.flush();

    const day = new Date(1_800_000_000_000).toISOString().slice(0, 10);
    assert.deepEqual(readdirSync(join(dir, day)).sort(), [`${M}.jsonl`, '_test.jsonl'].sort());
    const lines = readFileSync(join(dir, day, `${M}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    const [ok, bad] = lines;
    assert.equal(ok.matchId, M);
    assert.equal(ok.seat, 0);
    assert.equal(ok.kind, 'plan');
    assert.equal(ok.model, 'hy4-preview');
    assert.deepEqual(ok.request.messages, msgs, '完整 messages（system + 局面）');
    assert.deepEqual(ok.request.extra, { thinking: { type: 'disabled' } });
    assert.equal(typeof ok.reply, 'string');
    assert.ok(ok.reply.length > 0);
    assert.deepEqual(ok.usage, { in: 800, out: 35 });
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'repair');
    assert.equal(bad.error.kind, 'auth');
    const test0 = JSON.parse(readFileSync(join(dir, day, '_test.jsonl'), 'utf8').trim());
    assert.equal(test0.kind, 'test');
    assert.equal(test0.matchId, null);

    for (const f of readdirSync(join(dir, day))) {
      assert.ok(!readFileSync(join(dir, day, f), 'utf8').includes(SECRET), `${f} 不含 key`);
    }
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('战绩下载对话（2026-11-05 批次 1）：本人取回这局的全部调用 + 决策结局，与结算卡导出同格式；别人 404；无日志 / 关日志如实提示；不含 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-llmlog-'));
  const llmLog = createLlmLog({ dir, now: () => 1_800_000_000_000 });
  const s = await boot({ llmLog });
  const off = await boot();
  try {
    const A = await s.guest();
    const B = await s.guest();
    const k = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'hunyuan', apiKey: SECRET } });
    const M = mid(77);
    const msgs = openingMessages();
    assert.equal((await s.call('POST', '/llm/v1/chat', { token: A, body: { keyId: k.json.keyId, matchId: M, seat: 0, kind: 'plan', messages: msgs } })).status, 200);
    s.upstream.set(() => ({ status: 503, text: '' }));
    assert.equal((await s.call('POST', '/llm/v1/chat', { token: A, body: { keyId: k.json.keyId, matchId: M, seat: 0, kind: 'repair', messages: msgs } })).status, 502);

    const record = (seed) => {
      const sched = createScheduler(BCFG, seed, {
        seatLabels: ['byok:hunyuan/hy4-preview', 'heuristic', 'heuristic', 'heuristic'],
        players: [{ seat: 0, provider: 'hunyuan', model: 'hy4-preview', autonomy: 'blend', safetyGate: true }],
        controllers: (m) => [
          createPlanner({ map: m.map, seat: 0, cfg: BCFG, seed: m.seed, pool: createAgentPool(BCFG), persona: '先凑红黄绿', autonomy: 'blend',
            transport: (req, r) => r.deliver(mockPlan(req.payload, req.persona, { contract: true })) }),
          ...[1, 2, 3].map((i) => createHeuristic(m.map, i, BCFG, m.seed)),
        ],
      });
      sched.runSync(0, 5000);
      return sched.toJSONL();
    };
    const up = await s.call('POST', '/api/v1/matches', { token: A, body: { matchId: M, record: record(9), strategy: { seat: 0, autonomy: 'blend', safetyGate: true, text: '先凑红黄绿' } } });
    assert.equal(up.status, 201, up.text);

    const r = await s.call('GET', `/api/v1/matches/${M}/llm-log`, { token: A });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.calls, 2);
    assert.match(r.json.filename, /^maze-ai-talk-.*\.jsonl$/);
    const lines = r.json.jsonl.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].t, 'meta');
    assert.equal(lines[0].source, 'server-log');
    assert.equal(lines[0].strategy, '先凑红黄绿');
    assert.equal(lines[0].model, 'hy4-preview');
    const calls = lines.filter((l) => l.t === 'call');
    assert.deepEqual(calls.map((c) => [c.kind, c.ok]), [['plan', true], ['repair', false]]);
    assert.equal(calls[0].requestTurn, 1, '发起回合从局面里取回');
    assert.equal(calls[0].why, 'start');
    assert.deepEqual(calls[0].messages, msgs);
    assert.ok(calls[0].reply.length > 0);
    assert.match(calls[1].error, /503/);
    assert.ok(lines.some((l) => l.t === 'outcome'), '附每次决策的结局（来自存档记录）');
    for (const bad of [SECRET, k.json.keyId, 'keyHint', 'userId']) assert.equal(r.json.jsonl.includes(bad), false, `不含 ${bad}`);

    assert.equal((await s.call('GET', `/api/v1/matches/${M}/llm-log`, { token: B })).status, 404, '别人的对局 404');
    const M2 = mid(78);
    assert.equal((await s.call('POST', '/api/v1/matches', { token: A, body: { matchId: M2, record: record(10) } })).status, 201);
    const miss = await s.call('GET', `/api/v1/matches/${M2}/llm-log`, { token: A });
    assert.equal(miss.status, 404);
    assert.equal(miss.json.error, 'llm_log_missing');
    assert.match(miss.json.message, /保留 30 天/);

    const C = await off.guest();
    assert.equal((await off.call('POST', '/api/v1/matches', { token: C, body: { matchId: M, record: record(9) } })).status, 201);
    const dis = await off.call('GET', `/api/v1/matches/${M}/llm-log`, { token: C });
    assert.equal(dis.status, 404);
    assert.equal(dis.json.error, 'llm_log_disabled');
  } finally {
    await s.close();
    await off.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('对话日志：超过保留天数的日期目录被清理；不配目录 = 关闭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-llmlog-'));
  try {
    let t = Date.UTC(2026, 10, 2);
    const log = createLlmLog({ dir, retentionDays: 30, now: () => t });
    log.write({ matchId: mid(1), kind: 'plan' });
    await log.flush();
    const day1 = new Date(t).toISOString().slice(0, 10);
    assert.deepEqual(readdirSync(dir), [day1]);
    t += 29 * 86400000;
    assert.equal(await log.prune(), 0, '29 天内保留');
    t += 2 * 86400000;
    assert.equal(await log.prune(), 1, '超过 30 天删除');
    assert.deepEqual(readdirSync(dir), []);
    log.write({ matchId: mid(2), kind: 'plan' });
    await log.flush();
    assert.deepEqual(readdirSync(dir), [new Date(t).toISOString().slice(0, 10)]);
    const off = createLlmLog({ dir: null });
    assert.equal(off.enabled, false);
    off.write({ matchId: mid(3) });
    await off.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：会话 key 只在内存、24 小时过期；「记住」= AES-256-GCM 密文入库，绑定用户与行，换主密钥解不开', async () => {
  const store = await openStore(':memory:');
  let t = 1000;
  const now = () => t;
  const mk = randomBytes(32);
  for (const id of ['u_a', 'u_b']) store.createUser({ id, tokenHash: id.repeat(32).slice(0, 64), now: 1 });
  const v = createVault({ store, masterKey: mk, now });
  const spec = { provider: 'hunyuan', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy4-preview', apiKey: SECRET, reasoning: false };

  const kept = v.add('u_a', { ...spec, remember: true });
  assert.equal(kept.hint, keyHint(SECRET));
  assert.ok(!JSON.stringify(kept).includes(SECRET));
  const row = store.keyRow(kept.keyId);
  assert.ok(!Buffer.from(row.enc).includes(Buffer.from(SECRET)), '库里只有密文');
  assert.equal(v.get('u_a', kept.keyId).apiKey, SECRET);
  assert.equal(v.get('u_b', kept.keyId), null, '别人的 key 拿不到');
  assert.equal(createVault({ store, masterKey: randomBytes(32), now }).get('u_a', kept.keyId), null, '换了主密钥解不开');
  assert.equal(createVault({ store, masterKey: null, now }).get('u_a', kept.keyId), null);

  const sess = v.add('u_a', { ...spec, remember: false });
  assert.equal(store.countKeys('u_a'), 1, '会话 key 不入库');
  assert.equal(v.get('u_a', sess.keyId).apiKey, SECRET);
  assert.deepEqual(v.list('u_a').map((k) => k.remember).sort(), [false, true]);
  t += 24 * 3600 * 1000 + 1;
  assert.equal(v.get('u_a', sess.keyId), null, '24 小时后丢弃');
  assert.equal(v.get('u_a', kept.keyId).apiKey, SECRET);

  assert.throws(() => createVault({ store, masterKey: null, now }).add('u_a', { ...spec, remember: true }), /remember_unavailable/);
  assert.equal(v.remove('u_b', kept.keyId), false);
  assert.equal(v.remove('u_a', kept.keyId), true);
  assert.equal(v.get('u_a', kept.keyId), null);
  store.close();
});

test('M1 HTTP：预设 → 存 key（不回显）→ 测试连接（示范决策）→ 中转 → 用量 → 上传模式 B 对局（报告 + 思路仅本人可见）→ 删 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-m1-'));
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  const s = await boot({ dbPath: join(dir, 'm1.db') });
  try {
    const pv = await s.call('GET', '/api/v1/providers');
    assert.equal(pv.status, 200);
    assert.equal(pv.json.canRemember, true);
    const hy = pv.json.items.find((p) => p.id === 'hunyuan');
    assert.equal(hy.baseUrl, 'https://tokenhub.tencentmaas.com/v1');
    assert.equal(hy.model, 'hy4-preview');
    assert.equal(hy.verified, true);
    const kimi = pv.json.items.find((p) => p.id === 'kimi');
    assert.ok(kimi, '设置页下拉里要有 Kimi K3');
    assert.equal(kimi.baseUrl, 'https://tokenhub.tencentmaas.com/v1');
    assert.equal(kimi.model, 'kimi-k3');

    const A = await s.guest();
    const B = await s.guest();
    assert.equal((await s.call('POST', '/api/v1/keys', { body: { provider: 'hunyuan', apiKey: SECRET } })).status, 401);
    const bad = async (body, code) => {
      const r = await s.call('POST', '/api/v1/keys', { token: A, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, code);
    };
    await bad({ provider: 'nope', apiKey: SECRET }, 'bad_provider');
    await bad({ provider: 'custom', baseUrl: 'http://api.x.com/v1', model: 'm', apiKey: SECRET }, 'bad_base_url');
    await bad({ provider: 'custom', baseUrl: 'https://169.254.169.254/v1', model: 'm', apiKey: SECRET }, 'bad_base_url');
    await bad({ provider: 'hunyuan', apiKey: 'short' }, 'bad_api_key');
    await bad({ provider: 'hunyuan', model: 'bad model!', apiKey: SECRET }, 'bad_model');

    const k1 = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'hunyuan', apiKey: SECRET, remember: true } });
    assert.equal(k1.status, 201);
    assert.equal(k1.json.model, 'hy4-preview');
    assert.equal(k1.json.hint, keyHint(SECRET));
    const k2 = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'custom', baseUrl: 'https://api.example.com/v1/', model: 'my-model', apiKey: SECRET } });
    assert.equal(k2.status, 201);
    assert.equal(k2.json.baseUrl, 'https://api.example.com/v1');
    assert.ok(k2.json.expiresAt > 0, '默认仅本次会话');
    const list = await s.call('GET', '/api/v1/keys', { token: A });
    assert.equal(list.json.items.length, 2);
    assert.equal((await s.call('GET', '/api/v1/keys', { token: B })).json.items.length, 0);
    const keyId = k1.json.keyId;

    // 测试连接：开局局面 + 决策契约 → 示范决策
    const t = await s.call('POST', `/api/v1/keys/${keyId}/test`, { token: A, body: { autonomy: 'strict', strategy: '只拿宝石' } });
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true, t.json.error);
    assert.equal(t.json.plan.follow, 'yes');
    assert.deepEqual(t.json.usage, { in: 800, out: 35 });
    const up0 = s.upstream.calls[0];
    assert.equal(up0.url, 'https://tokenhub.tencentmaas.com/v1/chat/completions');
    assert.equal(up0.auth, `Bearer ${SECRET}`, '服务器附上的是本人的 key');
    assert.equal(up0.body.model, 'hy4-preview');
    assert.deepEqual(up0.body.thinking, { type: 'disabled' }, '混元默认关闭思考');
    assert.ok(up0.body.messages[0].content.includes(AUTONOMY.strict.clause) && up0.body.messages[0].content.includes('只拿宝石'));
    assert.equal(up0.timeoutMs, 45000);

    // 中转
    const M = mid(1);
    const relay = (token, body) => s.call('POST', '/llm/v1/chat', { token, body: { keyId, matchId: M, seat: 0, kind: 'plan', messages: openingMessages(), max_tokens: 200, temperature: 0, ...body } });
    const ok = await relay(A);
    assert.equal(ok.status, 200);
    assert.match(ok.json.text, /"follow":"yes"/);
    assert.deepEqual(ok.json.usage, { in: 800, out: 35 });
    assert.equal((await relay(B)).status, 404, '别人的 key 用不了');
    assert.equal((await relay(A, { matchId: undefined })).status, 400);
    assert.equal((await relay(A, { seat: 7 })).status, 400);
    assert.equal((await relay(A, { messages: [{ role: 'tool', content: 'x' }] })).status, 400);
    assert.equal((await relay(A, { messages: [{ role: 'user', content: 'x'.repeat(40000) }] })).status, 413);
    assert.equal((await relay(A, { keyId: 'k_nope' })).status, 404);

    // 上游错误分类（客户端据此重试 / 熔断）
    const cases = [
      [() => ({ status: 401, text: '{"error":{"message":"invalid api key"}}' }), 502, 'upstream_auth', /401.*invalid api key/],
      [() => ({ status: 402, text: '{"message":"余额不足"}' }), 502, 'upstream_auth', /余额不足/],
      [() => ({ status: 429, text: 'slow down' }), 502, 'upstream_rate', /429/],
      [() => ({ status: 503, text: '' }), 502, 'upstream_5xx', /503/],
      [() => ({ status: 404, text: '{"error":{"message":"model not found"}}' }), 502, 'upstream_bad', /model not found/],
      [() => ({ status: 200, text: '<html>' }), 502, 'upstream_5xx', /不是 JSON/],
      [() => { throw Object.assign(new Error('t'), { code: 'EUPSTREAMTIMEOUT' }); }, 504, 'upstream_timeout', /没有回复/],
      [() => { throw Object.assign(new Error('拒绝连接非公网地址 10.0.0.1'), { code: 'ESSRF' }); }, 502, 'upstream_blocked', /非公网/],
      [() => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, 502, 'upstream_unreachable', /ECONNREFUSED/],
    ];
    for (const [f, status, code, msg] of cases) {
      s.upstream.set(f);
      const r = await relay(A);
      assert.equal(r.status, status, code);
      assert.equal(r.json.error, code);
      assert.match(r.json.message, msg);
    }
    s.upstream.set(okReply);

    // 模式 B 对局：经中转打完，上传后报告里的 token 以服务器的账为准
    const players = [{ seat: 0, provider: 'hunyuan', model: 'hy4-preview', autonomy: 'blend', safetyGate: true }];
    let me;
    const sched = createScheduler(BCFG, 9, {
      seatLabels: ['byok:hunyuan/hy4-preview', 'heuristic', 'heuristic', 'heuristic'],
      players,
      controllers: (m) => {
        me = createPlanner({
          map: m.map, seat: 0, cfg: BCFG, seed: m.seed, pool: createAgentPool(BCFG), persona: '先凑红黄绿', autonomy: 'blend',
          transport: (req, r) => r.deliver(mockPlan(req.payload, req.persona, { contract: true })),
        });
        return [me, ...[1, 2, 3].map((i) => createHeuristic(m.map, i, BCFG, m.seed))];
      },
    });
    sched.runSync(0, 5000);
    const up = await s.call('POST', '/api/v1/matches', { token: A, body: { matchId: M, record: sched.toJSONL(), strategy: { seat: 0, autonomy: 'blend', safetyGate: true, text: '先凑红黄绿' } } });
    assert.equal(up.status, 201, up.text);
    assert.equal(up.json.verify, 'verified');
    const det = await s.call('GET', `/api/v1/matches/${M}`, { token: A });
    assert.equal(det.status, 200);
    const r0 = det.json.report.seats.find((x) => x.seat === 0);
    assert.equal(r0.model, 'hunyuan/hy4-preview');
    assert.equal(r0.autonomy, 'blend');
    assert.equal(r0.decisions, me.report().decisions);
    assert.equal(r0.follow.yes, me.report().follow.yes);
    assert.equal(r0.tokens.calls, 1 + cases.length, '用量来自服务器的中转记账：本局 1 次成功 + 各种失败');
    assert.equal(r0.tokens.in, 800, '失败的调用不计 token');
    assert.deepEqual(det.json.strategies, [{ seat: 0, autonomy: 'blend', safetyGate: true, text: '先凑红黄绿' }]);
    assert.equal((await s.call('GET', `/api/v1/matches/${M}`, { token: B })).status, 404, '思路仅本人可见');
    const badStrat = await s.call('POST', '/api/v1/matches', { token: A, body: { matchId: mid(2), record: sched.toJSONL(), strategy: { seat: 0, text: 'x'.repeat(5000) } } });
    assert.equal(badStrat.status, 400);

    const usage = await s.call('GET', `/api/v1/usage?matchId=${M}`, { token: A });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.match.seats[0].tokensIn, r0.tokens.in);
    assert.ok(usage.json.month.calls >= usage.json.match.seats[0].calls + 1, '测试连接也计入本月用量');
    assert.ok(usage.json.month.failed >= cases.length);
    assert.equal((await s.call('GET', '/api/v1/usage', { token: B })).json.month.calls, 0);

    // 删除：别人删不了；删了就不能再用
    assert.equal((await s.call('DELETE', `/api/v1/keys/${keyId}`, { token: B })).status, 404);
    assert.equal((await s.call('DELETE', `/api/v1/keys/${keyId}`, { token: A })).status, 204);
    assert.equal((await relay(A)).status, 404);

    // X05：key 不出现在任何接口回复里
    for (const text of s.texts) assert.ok(!text.includes(SECRET), `接口回复泄露 key：${text.slice(0, 120)}`);
  } finally {
    await s.close();
    for (const k of Object.keys(orig)) console[k] = orig[k];
  }
  try {
    // X05：库文件（含 WAL）与服务器日志里都没有明文 key
    for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f)).includes(Buffer.from(SECRET)), `${f} 里有明文 key`);
    assert.ok(logs.every((l) => !l.includes(SECRET)), '日志里有明文 key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1 HTTP 边界：没配主密钥时「记住」不可用；每人 key 上限；中转限频 429；本局调用上限', async () => {
  const s = await boot({ masterKey: null, limits: { relayBurst: 3, relayPerMinute: 1, keysPerMinute: 30 } });
  try {
    const A = await s.guest();
    assert.equal((await s.call('GET', '/api/v1/providers')).json.canRemember, false);
    const r = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'deepseek', apiKey: SECRET, remember: true } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'remember_unavailable');
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'deepseek', apiKey: SECRET } })).json.keyId);
    const over = await s.call('POST', '/api/v1/keys', { token: A, body: { provider: 'deepseek', apiKey: SECRET } });
    assert.equal(over.status, 409);
    const body = { keyId: ids[0], matchId: mid(3), seat: 0, messages: openingMessages() };
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/llm/v1/chat', { token: A, body })).status, 200);
    const lim = await s.call('POST', '/llm/v1/chat', { token: A, body });
    assert.equal(lim.status, 429);
    assert.equal(s.upstream.calls.length, 3, '被限频的请求不会打到服务商');
  } finally {
    await s.close();
  }
});
