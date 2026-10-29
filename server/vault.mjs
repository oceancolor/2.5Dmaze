// key 保管（06 §7.2、05 §7.2）：
//   默认「仅本次会话」：只在服务器内存里，24 小时后丢弃（服务器重启也会丢）
//   「记住」：AES-256-GCM 加密后入库；附加数据 = userId|keyId（密文换到别的行 / 别的用户名下解不开）；主密钥不进库、不进仓库
// 任何对外的结构只有服务商、模型名和尾号，绝不含明文。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PROVIDERS } from './providers.mjs';

const DAY = 86400000;
const newKeyId = () => `k_${randomBytes(12).toString('base64url')}`;

/** 主密钥：32 字节，base64（44 字符）或 hex（64 字符）。 */
export function parseMasterKey(text) {
  const s = String(text ?? '').trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节（base64 44 字符或 hex 64 字符）');
  return buf;
}

export function keyHint(apiKey) {
  const k = String(apiKey);
  return k.length >= 12 ? `${k.slice(0, 3)}…${k.slice(-4)}` : `…${k.slice(-4)}`;
}

function encrypt(master, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return { enc, iv };
}

function decrypt(master, enc, iv, aad) {
  const buf = Buffer.from(enc);
  const d = createDecipheriv('aes-256-gcm', master, Buffer.from(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

const publicMeta = (r) => ({
  keyId: r.id,
  provider: r.provider,
  providerLabel: PROVIDERS[r.provider] ? PROVIDERS[r.provider].label : r.provider,
  model: r.model,
  baseUrl: r.provider === 'custom' ? r.baseUrl : undefined,
  reasoning: Boolean(r.reasoning),
  hint: r.hint,
  remember: Boolean(r.remember),
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt ?? null,
  expiresAt: r.expiresAt ?? null,
});

/**
 * @param {{store:object, masterKey?:Buffer|null, now:()=>number, sessionTtlMs?:number, maxPerUser?:number}} o
 */
export function createVault({ store, masterKey = null, now, sessionTtlMs = DAY, maxPerUser = 10 }) {
  const session = new Map();

  function sweep() {
    const t = now();
    for (const [id, r] of session) if (r.expiresAt <= t) session.delete(id);
  }

  function count(userId) {
    sweep();
    let n = 0;
    for (const r of session.values()) if (r.userId === userId) n++;
    return n + store.countKeys(userId);
  }

  return {
    canRemember: Boolean(masterKey),
    count,

    /** @param {{provider:string, baseUrl:string, model:string, apiKey:string, reasoning:boolean, remember:boolean}} spec */
    add(userId, spec) {
      if (spec.remember && !masterKey) throw new Error('remember_unavailable');
      if (count(userId) >= maxPerUser) throw new Error('too_many_keys');
      const id = newKeyId();
      const t = now();
      const rec = {
        id, userId, provider: spec.provider, baseUrl: spec.baseUrl, model: spec.model, reasoning: Boolean(spec.reasoning),
        hint: keyHint(spec.apiKey), createdAt: t, lastUsedAt: null, remember: Boolean(spec.remember),
      };
      if (spec.remember) {
        const { enc, iv } = encrypt(masterKey, spec.apiKey, `${userId}|${id}`);
        store.insertKey({ ...rec, enc, iv });
      } else {
        session.set(id, { ...rec, apiKey: spec.apiKey, expiresAt: t + sessionTtlMs });
      }
      return publicMeta({ ...rec, expiresAt: spec.remember ? null : t + sessionTtlMs });
    },

    list(userId) {
      sweep();
      const mem = [...session.values()].filter((r) => r.userId === userId).map(publicMeta);
      return [...mem, ...store.listKeys(userId).map((r) => publicMeta({ ...r, remember: true }))].sort((a, b) => b.createdAt - a.createdAt);
    },

    /** 内部使用：带明文 apiKey。不属于该用户 / 不存在 / 过期 → null。 */
    get(userId, id) {
      sweep();
      const s = session.get(id);
      if (s) return s.userId === userId ? { ...s } : null;
      const row = store.keyRow(id);
      if (!row || row.userId !== userId || !masterKey) return null;
      try {
        return { ...row, remember: true, apiKey: decrypt(masterKey, row.enc, row.iv, `${userId}|${id}`) };
      } catch {
        return null; // 主密钥换了 / 密文被篡改
      }
    },

    touch(id) {
      const t = now();
      const s = session.get(id);
      if (s) s.lastUsedAt = t;
      else store.touchKey(id, t);
    },

    remove(userId, id) {
      const s = session.get(id);
      if (s) {
        if (s.userId !== userId) return false;
        session.delete(id);
        return true;
      }
      return store.deleteKey(userId, id);
    },
  };
}
