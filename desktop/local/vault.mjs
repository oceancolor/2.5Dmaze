// 本机 key 保管（06 §8.2）：桌面端「本机直连」用。
//   「记住」：Electron safeStorage 加密（Windows DPAPI / macOS 钥匙串 / Linux 系统密钥环）后写进用户目录的 keys.json；
//   「仅本次运行」：只在主进程内存里，退出即丢。
// 对网页只返回服务商、模型名和尾号；明文 key 只在主进程调用服务商的那一刻出现。
// 不依赖 electron：加解密函数由调用方注入（main.mjs 传 safeStorage，测试传替身）。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyHint } from '../../server/vault.mjs';

const newKeyId = () => `d_${randomBytes(12).toString('base64url')}`;
export const LOCAL_KEY_ID = /^d_[A-Za-z0-9_-]{16}$/;

/**
 * @param {{file:string, crypto:{available:()=>boolean, encrypt:(s:string)=>Buffer, decrypt:(b:Buffer)=>string},
 *          now:()=>number, maxKeys?:number, labelOf?:(provider:string)=>string}} o
 */
export function createLocalVault({ file, crypto, now, maxKeys = 10, labelOf = (p) => p }) {
  const session = new Map();
  let saved = null;

  function load() {
    if (saved) return saved;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      saved = Array.isArray(j.keys) ? j.keys : [];
    } catch {
      saved = [];
    }
    return saved;
  }

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, keys: saved }, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  }

  const meta = (r, remember) => ({
    keyId: r.id,
    provider: r.provider,
    providerLabel: labelOf(r.provider),
    model: r.model,
    baseUrl: r.provider === 'custom' ? r.baseUrl : undefined,
    reasoning: Boolean(r.reasoning),
    hint: r.hint,
    remember,
    route: 'direct',
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
  });

  return {
    canRemember: () => Boolean(crypto.available()),

    /** @param {{provider:string, baseUrl:string, model:string, apiKey:string, reasoning:boolean, remember:boolean}} spec 已校验 */
    add(spec) {
      if (spec.remember && !crypto.available()) throw new Error('remember_unavailable');
      if (session.size + load().length >= maxKeys) throw new Error('too_many_keys');
      const rec = {
        id: newKeyId(), provider: spec.provider, baseUrl: spec.baseUrl, model: spec.model, reasoning: Boolean(spec.reasoning),
        hint: spec.apiKey ? keyHint(spec.apiKey) : '无需 key', createdAt: now(), lastUsedAt: null,
      };
      if (spec.remember) {
        load().push({ ...rec, enc: crypto.encrypt(spec.apiKey).toString('base64') });
        persist();
      } else {
        session.set(rec.id, { ...rec, apiKey: spec.apiKey });
      }
      return meta(rec, Boolean(spec.remember));
    },

    list() {
      const mem = [...session.values()].map((r) => meta(r, false));
      return [...mem, ...load().map((r) => meta(r, true))].sort((a, b) => b.createdAt - a.createdAt);
    },

    /** 主进程内部用：带明文 apiKey；不存在 / 解不开 → null。 */
    get(id) {
      const s = session.get(id);
      if (s) return { ...s };
      const r = load().find((x) => x.id === id);
      if (!r) return null;
      try {
        return { ...r, enc: undefined, apiKey: crypto.decrypt(Buffer.from(r.enc, 'base64')) };
      } catch {
        return null; // 换了 Windows 账户 / 系统密钥环被重置
      }
    },

    touch(id) {
      const s = session.get(id);
      if (s) {
        s.lastUsedAt = now();
        return;
      }
      const r = load().find((x) => x.id === id);
      if (r) {
        r.lastUsedAt = now();
        persist();
      }
    },

    remove(id) {
      if (session.delete(id)) return true;
      const before = load().length;
      saved = load().filter((x) => x.id !== id);
      if (saved.length === before) return false;
      persist();
      return true;
    },
  };
}
