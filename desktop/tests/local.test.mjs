// 桌面端本机能力的单元测试（不依赖 Electron 运行时，node --test 直接跑）。
// 覆盖：服务器地址规则、本机 key 保管（safeStorage 用替身）、本机直连地址校验与调用、更新策略。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverOrigin } from '../local/config.mjs';
import { createLocalVault } from '../local/vault.mjs';
import { checkLocalBaseUrl, createDirect, localProviderList } from '../local/direct.mjs';
import { updatePlan } from '../local/update.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'maze-desktop-'));
}

test('serverOrigin：只接受 https，http 仅放行本机回环', () => {
  assert.equal(serverOrigin('https://maze.aiquiz.games/some/path'), 'https://maze.aiquiz.games');
  for (const h of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
    assert.doesNotThrow(() => serverOrigin(h));
  }
  assert.throws(() => serverOrigin('http://maze.aiquiz.games'), /https/);
  assert.throws(() => serverOrigin('http://10.0.0.1:5173'), /https/);
  assert.throws(() => serverOrigin('not a url'), /格式/);
});

test('checkLocalBaseUrl：https 公网沿用服务器规则；http 只放行本机', () => {
  assert.equal(checkLocalBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
  assert.equal(checkLocalBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.throws(() => checkLocalBaseUrl('http://10.0.0.1:11434/v1'), /本机/);
  assert.throws(() => checkLocalBaseUrl('http://169.254.169.254/v1'), /本机/);
  assert.equal(checkLocalBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.throws(() => checkLocalBaseUrl('https://169.254.169.254/v1'), /内网/);
  assert.throws(() => checkLocalBaseUrl('https://localhost/v1'), /内网/);
});

test('localProviderList：含本机 Ollama 预设', () => {
  const list = localProviderList();
  assert.ok(list.find((p) => p.id === 'ollama' && p.local));
  assert.ok(list.find((p) => p.id === 'hunyuan'));
});

test('vault：记住=加密入库（明文不落盘/不回显），仅本次运行=只在内存，删除生效', () => {
  const dir = tmp();
  const file = join(dir, 'keys.json');
  // 可逆的假「加密」：异或后 base64，模拟 safeStorage 的行为，便于断言明文不落盘
  const crypt = {
    available: () => true,
    encrypt: (s) => Buffer.from(s.split('').map((c) => String.fromCharCode(c.charCodeAt(0) ^ 7)).join(''), 'binary'),
    decrypt: (b) => Buffer.from(b).map((x) => x ^ 7).toString('binary'),
  };
  try {
    const v = createLocalVault({ file, crypto: crypt, now: () => 1000 });
    assert.equal(v.canRemember(), true);

    const saved = v.add({ provider: 'hunyuan', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy4-preview', apiKey: 'sk-SECRET-123456', reasoning: false, remember: true });
    assert.equal(saved.remember, true);
    assert.doesNotMatch(JSON.stringify(saved), /SECRET/, '对外结构不含明文');
    assert.equal(saved.hint, 'sk-…3456');
    const onDisk = readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes('sk-SECRET-123456'), '库文件里没有明文 key');
    assert.equal(v.get(saved.keyId).apiKey, 'sk-SECRET-123456', '内部可解密');

    const mem = v.add({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-MEM-88888888', reasoning: false, remember: false });
    assert.equal(v.list().length, 2);
    assert.equal(v.get(mem.keyId).apiKey, 'sk-MEM-88888888');
    assert.ok(!readFileSync(file, 'utf8').includes('sk-MEM-88888888'), '仅本次运行的 key 不落盘');

    // 重启（新实例）后：记住的还在，仅本次运行的丢了
    const v2 = createLocalVault({ file, crypto: crypt, now: () => 2000 });
    assert.equal(v2.list().length, 1);
    assert.equal(v2.get(saved.keyId).apiKey, 'sk-SECRET-123456');
    assert.equal(v2.get(mem.keyId), null);

    assert.equal(v2.remove(saved.keyId), true);
    assert.equal(v2.list().length, 0);
    assert.equal(v2.get(saved.keyId), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：系统加密不可用时「记住」被拒，仅本次运行仍可用', () => {
  const dir = tmp();
  try {
    const v = createLocalVault({ file: join(dir, 'k.json'), crypto: { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }, now: () => 1 });
    assert.equal(v.canRemember(), false);
    assert.throws(() => v.add({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '', reasoning: false, remember: true }), /remember_unavailable/);
    const ok = v.add({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '', reasoning: false, remember: false });
    assert.equal(ok.remember, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct.addKey：校验服务商 / 地址 / 模型名 / key；本机地址可无 key', () => {
  const dir = tmp();
  try {
    const store = new Map();
    const v = {
      canRemember: () => true,
      add: (s) => { const id = `d_${store.size}`.padEnd(18, 'x'); store.set(id, s); return { keyId: id, ...s }; },
      get: (id) => store.get(id) ? { id, ...store.get(id) } : null,
      list: () => [], remove: () => true, touch: () => {},
    };
    const d = createDirect({ vault: v, ledgerFile: join(dir, 'usage.json'), now: () => 1, upstreams: { https: async () => ({ status: 200, text: '{}' }), loopback: async () => ({ status: 200, text: '{}' }) } });
    assert.equal(d.addKey({ provider: 'nope', apiKey: 'x' }).error, 'bad_provider');
    assert.equal(d.addKey({ provider: 'custom', baseUrl: 'http://10.0.0.1/v1', model: 'm', apiKey: 'sk-12345678' }).error, 'bad_base_url');
    assert.equal(d.addKey({ provider: 'hunyuan', model: 'bad model!', apiKey: 'sk-12345678' }).error, 'bad_model');
    assert.equal(d.addKey({ provider: 'hunyuan', model: 'hy4-preview', apiKey: 'short' }).error, 'bad_api_key');
    assert.equal(d.addKey({ provider: 'ollama', apiKey: '' }).ok, true, '本机模型不需要 key');
    assert.equal(d.addKey({ provider: 'hunyuan', model: 'hy4-preview', apiKey: 'sk-12345678' }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct.chat：注入上游替身，成功记账、失败分类；本机用量按月统计', async () => {
  const dir = tmp();
  const ledger = join(dir, 'usage.json');
  const k = { id: 'd_abcdefghijklmnop', provider: 'hunyuan', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy4-preview', apiKey: 'sk-12345678', reasoning: false };
  const v = { canRemember: () => true, add: () => ({}), get: (id) => id === k.id ? k : null, list: () => [], remove: () => true, touch: () => {} };
  let reply = { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 35 } }) };
  const up = { https: async () => reply, loopback: async () => reply };
  try {
    const d = createDirect({ vault: v, ledgerFile: ledger, now: () => new Date('2026-10-01').getTime(), upstreams: up });
    const ok = await d.chat({ keyId: k.id, kind: 'plan', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.usage, { in: 800, out: 35 });
    const u = d.usage();
    assert.equal(u.month.calls, 1);
    assert.equal(u.month.tokensIn, 800);
    assert.equal(u.month.tokensOut, 35);
    assert.equal(u.local, true);

    assert.equal((await d.chat({ keyId: 'd_nope', messages: [{ role: 'user', content: 'x' }] })).kind, 'missing');
    assert.equal((await d.chat({ keyId: k.id, messages: [] })).kind, 'bad');
    assert.equal((await d.chat({ keyId: k.id, messages: [{ role: 'tool', content: 'x' }] })).kind, 'bad');

    reply = { status: 401, text: '{"error":{"message":"invalid key"}}' };
    const auth = await d.chat({ keyId: k.id, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(auth.ok, false);
    assert.equal(auth.kind, 'auth');
    assert.equal(d.usage().month.failed, 1, '失败也计一次调用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updatePlan：签名版自动下载，未签名版只提示', () => {
  assert.equal(updatePlan({ signed: false, available: false }), 'none');
  assert.equal(updatePlan({ signed: true, available: true }), 'download');
  assert.equal(updatePlan({ signed: false, available: true }), 'notify');
});
