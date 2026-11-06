// 脚本库（统一编程接口 v2）：本机 localStorage「maze.scripts.v1」+ 内置脚本（src/player/builtin/*.js）。
// 文件头（导入 / 导出 .js 时用，人和 agent 写的脚本同一格式）：
//   // @maze-script name: 我的凑套脚本 | author: 张三 | origin: agent
// origin：human（人写）/ agent（agent 写）/ builtin（内置）。代码哈希 FNV-1a hex8，写进对局记录 meta.scripts。

import { fnv1a, hex8 } from '../core/hash.js';

const KEY = 'maze.scripts.v1';
const MAX_ENTRIES = 50;
const MAX_CODE = 200 * 1024;
export const ORIGINS = Object.freeze({ human: '人写', agent: 'agent 写', builtin: '内置' });

export const BUILTINS = Object.freeze([
  Object.freeze({ id: 'builtin:heuristic', file: 'heuristic.js', name: '启发式（参考实现）', author: '迷宫寻宝', origin: 'builtin' }),
  Object.freeze({ id: 'builtin:aware', file: 'aware.js', name: '预判对手（参考实现）', author: '迷宫寻宝', origin: 'builtin' }),
  Object.freeze({ id: 'builtin:sets', file: 'sets.js', name: '凑套 + 推演抢宝石', author: '迷宫寻宝', origin: 'builtin' }),
]);

/** 内置脚本源码地址（浏览器 fetch 用）。 */
export const builtinUrl = (file) => new URL(`./builtin/${file}`, import.meta.url).href;

export const codeHashOf = (code) => hex8(fnv1a(String(code ?? '')));

const HEADER = /^\s*\/\/\s*@maze-script\b(.*)$/m;

/** 解析文件头。缺失的字段为空串。 */
export function parseHeader(code) {
  const m = HEADER.exec(String(code ?? '').split('\n').slice(0, 5).join('\n'));
  const out = { name: '', author: '', origin: '' };
  if (!m) return out;
  for (const part of m[1].split('|')) {
    const kv = /^\s*(name|author|origin)\s*[:=]\s*(.*?)\s*$/.exec(part);
    if (kv) out[kv[1]] = kv[2].slice(0, 40);
  }
  if (out.origin && !ORIGINS[out.origin]) out.origin = '';
  return out;
}

const clean = (s) => String(s ?? '').replace(/[|\n\r]/g, ' ').trim().slice(0, 40);

/** 写入 / 替换文件头。 */
export function withHeader(code, { name, author, origin }) {
  const line = `// @maze-script name: ${clean(name) || '未命名脚本'} | author: ${clean(author)} | origin: ${ORIGINS[origin] ? origin : 'human'}`;
  const src = String(code ?? '');
  const lines = src.split('\n');
  const k = lines.slice(0, 5).findIndex((l) => HEADER.test(l));
  if (k >= 0) {
    lines[k] = line;
    return lines.join('\n');
  }
  return `${line}\n${src}`;
}

const newId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * @param {Storage} [storage]
 */
export function createLibrary(storage = globalThis.localStorage) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string' && typeof e.code === 'string') : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };
  return {
    list: () => read().sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => read().find((e) => e.id === id) || null,
    /** 新建 / 更新。返回保存后的条目，或 {error}。 */
    save(entry) {
      const code = String(entry.code ?? '');
      if (code.length > MAX_CODE) return { error: `脚本超过 ${MAX_CODE / 1024} KB` };
      const list = read();
      const e = {
        id: entry.id || newId(),
        name: clean(entry.name) || '未命名脚本',
        author: clean(entry.author),
        origin: ORIGINS[entry.origin] && entry.origin !== 'builtin' ? entry.origin : 'human',
        code,
        updatedAt: Date.now(),
      };
      const k = list.findIndex((x) => x.id === e.id);
      if (k >= 0) list[k] = e;
      else {
        if (list.length >= MAX_ENTRIES) return { error: `脚本库最多 ${MAX_ENTRIES} 个` };
        list.push(e);
      }
      return write(list) ? e : { error: '存储空间不足，保存失败' };
    },
    remove(id) {
      write(read().filter((e) => e.id !== id));
    },
    /** 导入 .js 文本：文件头里的 name / author / origin 优先，其次文件名。 */
    importText(text, filename = '') {
      const h = parseHeader(text);
      return this.save({ name: h.name || filename.replace(/\.m?js$/i, ''), author: h.author, origin: h.origin === 'agent' ? 'agent' : 'human', code: text });
    },
    /** 导出：带文件头的 .js。 */
    exportText(entry) {
      return { filename: `${clean(entry.name).replace(/[\\/:*?"<>\s]+/g, '-') || 'maze-script'}.js`, text: withHeader(entry.code, entry) };
    },
  };
}
