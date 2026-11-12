/**
 * Where the Analyzer keeps things between visits: the captured bursts (their samples and what the person named,
 * starred and noted), the saved protocols and the capture filter, in the browser's IndexedDB. Everything here is a
 * best effort: a private window or a full disk loses the history, never the app.
 */

const DB = 'mayhem-analyzer', BURSTS = 'bursts', KV = 'kv';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const db = r.result; db.createObjectStore(BURSTS, { keyPath: 'id' }); db.createObjectStore(KV); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}

let dbp: Promise<IDBDatabase | null> | null = null;
const db = () => (dbp ??= openDb());

function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return db().then(d => new Promise<T | null>(res => {
    if (!d) { res(null); return; }
    try {
      const tx = d.transaction(store, mode);
      const req = f(tx.objectStore(store));
      tx.oncomplete = () => res(req ? (req.result as T) : null);
      tx.onerror = () => res(null);
    } catch { res(null); }
  }));
}

/** A burst as stored: whatever the screen keeps, arrays included (IndexedDB stores typed arrays as they are). */
export type StoredBurst = { id: number } & Record<string, unknown>;

export const store = {
  putBurst: (b: StoredBurst) => run(BURSTS, 'readwrite', s => s.put(b)),
  deleteBurst: (id: number) => run(BURSTS, 'readwrite', s => s.delete(id)),
  clearBursts: () => run(BURSTS, 'readwrite', s => s.clear()),
  allBursts: () => run<StoredBurst[]>(BURSTS, 'readonly', s => s.getAll()).then(v => v ?? []),
  get: <T>(key: string) => run<T>(KV, 'readonly', s => s.get(key)),
  set: (key: string, v: unknown) => run(KV, 'readwrite', s => s.put(v, key)),
};
