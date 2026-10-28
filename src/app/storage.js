// 浏览器端对局记录（SPEC §12）：IndexedDB 只留最近 cfg.record.keepRecent 局。任何失败都静默（隐私模式 / 无 IDB 不影响游戏）。

import { wallNow } from './clock.js';

const DB = 'maze-quest';
const STORE = 'records';

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});

/** @param {{seed:number, endTurn:number, ranking:object[], jsonl:string}} rec */
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
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    const out = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return out;
  } catch {
    return [];
  }
}
