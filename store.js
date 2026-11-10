/* Receipt photos and PDFs, stored in this browser's IndexedDB (localStorage is too small for images). */
(function (root) {
  'use strict';
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('expense-receipts', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('receipts', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('receipts', mode);
      const store = t.objectStore('receipts');
      let out;
      Promise.resolve(fn(store)).then((r) => { out = r; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  }
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const Store = {
    async put(blob, name = '', id) {
      const rec = { id: id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), blob, type: blob.type || 'application/octet-stream', name: String(name).slice(0, 120), createdAt: Date.now() };
      await tx('readwrite', (s) => { s.put(rec); });
      return rec.id;
    },
    async get(id) { return tx('readonly', (s) => req2p(s.get(id))); },
    async remove(id) { await tx('readwrite', (s) => { s.delete(id); }); },
    async ids() { return tx('readonly', (s) => req2p(s.getAllKeys())); },
    async clear() { await tx('readwrite', (s) => { s.clear(); }); },
  };
  root.ReceiptStore = Store;
})(window);
