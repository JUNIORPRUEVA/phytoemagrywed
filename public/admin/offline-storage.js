/* Almacén compartido por la página y el service worker. Nunca usa localStorage para imágenes. */
(() => {
  const DB = 'fulltech-offline-v1';
  let opening;
  function open() {
    return opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(request.error); };
    });
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode), store = tx.objectStore('records');
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo guardar en el dispositivo.'));
      action(store, value => { result = value; });
    });
  }
  const get = key => transaction('readonly', (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); });
  const put = (key, value) => transaction('readwrite', s => s.put(value, key));
  const putRemote = (key,value,queueKey) => transaction('readwrite', s => {
    const r=s.get(queueKey);r.onsuccess=()=>{if(!(r.result||[]).length)s.put(value,key);};
  });
  const remove = key => transaction('readwrite', s => s.delete(key));
  const entries = () => transaction('readonly', (s, done) => {
    const result = [], r = s.openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { result.push([c.key, c.value]); c.continue(); } else done(result); };
  });
  // Una cola por cuenta: actualizarla en una sola transacción evita perder acciones entre pestañas.
  const update = (key, fn) => transaction('readwrite', (s, done) => {
    const r = s.get(key); r.onsuccess = () => { const value = fn(r.result); s.put(value, key); done(value); };
  });
  async function clear() { await transaction('readwrite', s => s.clear()); }
  globalThis.FulltechOfflineStore = {get, put, putRemote, remove, entries, update, clear};
})();
