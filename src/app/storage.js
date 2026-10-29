// 浏览器端存储（SPEC §12）：IndexedDB。
//   records  最近 cfg.record.keepRecent 局的本地缓存
//   outbox   待上传到游戏服务器的对局（06 §3.1：离线结束的对局联网后补传；上传成功即删）
// 任何失败都静默（隐私模式 / 无 IDB 不影响游戏）。

import { wallNow } from './clock.js';

const DB = 'maze-quest';
const STORE = 'records';
const OUTBOX = 'outbox';

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'matchId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});

const result = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** @param {{seed:number, endTurn:number, ranking:object[], jsonl:string, matchId?:string}} rec */
export async function saveRecord(rec, keep = 20) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    st.add({ ...rec, savedAt: wallNow() });
    const keys = st.getAllKeys();
    keys.onsuccess = () => {
      const ks = keys.result;
      for (let i = 0; i < ks.length - keep; i++) st.delete(ks[i]);
    };
    await done(tx);
    db.close();
  } catch (e) {
    console.info('对局记录未保存（IndexedDB 不可用）', e && e.message);
  }
}

export async function listRecords() {
  try {
    const db = await open();
    const out = await result(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    db.close();
    return out;
  } catch {
    return [];
  }
}

/** 上传队列：IndexedDB 不可用时退回内存（关页即丢，但本局仍能上传）。 */
const memOutbox = new Map();

export async function outboxPut(item) {
  try {
    const db = await open();
    const tx = db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).put(item);
    await done(tx);
    db.close();
  } catch {
    memOutbox.set(item.matchId, item);
  }
}

export async function outboxAll() {
  let items = [];
  try {
    const db = await open();
    items = await result(db.transaction(OUTBOX, 'readonly').objectStore(OUTBOX).getAll());
    db.close();
  } catch {
    /* 只用内存队列 */
  }
  for (const it of memOutbox.values()) if (!items.some((x) => x.matchId === it.matchId)) items.push(it);
  return items.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
}

export async function outboxDelete(matchId) {
  memOutbox.delete(matchId);
  try {
    const db = await open();
    const tx = db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).delete(matchId);
    await done(tx);
    db.close();
  } catch {
    /* 内存队列已删 */
  }
}
