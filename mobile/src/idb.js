// Tiny IndexedDB wrapper: video chunks + metadata (survives app restarts)
const DB = 'p2p-chat';
let dbp;

function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('chunks');
      r.result.createObjectStore('videos', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

export const idb = {
  getChunk: (h) => tx('chunks', 'readonly', (s) => s.get(h)),
  hasChunk: async (h) => (await tx('chunks', 'readonly', (s) => s.count(h))) > 0,
  putChunk: (h, data) => tx('chunks', 'readwrite', (s) => s.put(data, h)),
  delChunk: (h) => tx('chunks', 'readwrite', (s) => s.delete(h)),
  getVideo: (id) => tx('videos', 'readonly', (s) => s.get(id)),
  putVideo: (v) => tx('videos', 'readwrite', (s) => s.put(v)),
  allVideos: () => tx('videos', 'readonly', (s) => s.getAll()),
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k))
};
