/* Almacén compartido por la página y el service worker. Nunca usa localStorage para imágenes. */
(() => {
  const DB = 'fulltech-offline-v1';
  let opening;
  function open() {
    return opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records'); };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opening = null; };
        resolve(request.result);
      };
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
  // Las respuestas confirmadas son independientes del diario de escrituras.
  const putRemote = (key,value) => transaction('readwrite',(s,done)=>{
    const previous=s.get(key);
    previous.onsuccess=()=>{
      const old=previous.result;
      if(old&&(!old.owner||!old.url||!Array.isArray(old.headers)||!old.body||!Number.isFinite(old.at))){
        s.put({version:1,key,original:old,at:Date.now()},'repair-backup:'+key);
        s.put({version:1,key,state:'replaced-from-server',at:Date.now()},'repair:'+key);
      }
      const revision=s.get('cloud-revision:'+value.owner);
      revision.onsuccess=()=>{s.put((revision.result||0)+1,'cloud-revision:'+value.owner);s.put(value,key);done(true);};
    };
  });
  // Migración de datos v1: respaldo, adopción y marcador en UNA transacción.
  // La cola de origen permanece intacta y no se vuelve a importar al reabrir.
  const adoptQueue = (source,target) => transaction('readwrite', (s,done) => {
    const marker='migration:queue-v1:'+source+':'+target;
    const checked=s.get(marker);
    checked.onsuccess=()=>{
      if(checked.result&&!checked.result.ids){done(false);return;}
      const imported=new Set(checked.result?.ids||[]);
      const old=s.get(source);
      old.onsuccess=()=>{
        if(!Array.isArray(old.result)) {done(false);return;}
        const current=s.get(target);
        current.onsuccess=()=>{
          if(current.result!==undefined&&!Array.isArray(current.result)){s.transaction.abort();return;}
          const merged=[...(current.result||[])],ids=new Set(merged.map(q=>q.id));
          for(const entry of old.result){
            if(!entry?.id){s.transaction.abort();return;}
            if(imported.has(entry.id))continue;
            if(!ids.has(entry.id)){merged.push(entry);ids.add(entry.id);}
            else if(JSON.stringify(merged.find(q=>q.id===entry.id))!==JSON.stringify(entry)){
              s.put({source,entry,at:Date.now()},'migration-conflict:'+target+':'+entry.id);
            }
          }
          const sequence=(checked.result?.sequence||0)+1;
          if(!checked.result)s.put({source,operaciones:old.result,at:Date.now(),version:1},'migration-backup:'+source);
          if(old.result.every(entry=>imported.has(entry.id))){done(false);return;}
          s.put({source,operaciones:old.result,at:Date.now(),version:2},'migration-backup:'+source+':'+sequence);
          s.put(merged,target);s.put({version:2,sequence,ids:old.result.map(entry=>entry.id),at:Date.now()},marker);done(true);
        };
      };
    };
  });
  const remove = key => transaction('readwrite', s => s.delete(key));
  const projectionSnapshot = owner => transaction('readonly',(s,done)=>{
    const records=[],cursor=s.openCursor();
    let queue=[],revision=0,identity=null;
    cursor.onsuccess=()=>{
      const c=cursor.result;
      if(!c){done({records:records.filter(([,r])=>(!r.authorization&&!identity?.legacyCacheDisabled)||r.authorization===JSON.stringify(identity?.permissions||[])),queue,revision,authorization:JSON.stringify(identity?.permissions||[])});return;}
      if(c.key==='identity')identity=c.value;
      if(c.key==='queue:'+owner)queue=c.value||[];
      if(c.key==='cloud-revision:'+owner)revision=c.value||0;
      if((String(c.key).startsWith('response:'+owner+':')||String(c.key).startsWith('local-response:'+owner+':'))&&c.value?.url)records.push([c.value.url,c.value]);
      c.continue();
    };
  });
  const commitProjection = (owner,projection) => transaction('readwrite',(s,done)=>{
    const revision=s.get('cloud-revision:'+owner);
    revision.onsuccess=()=>{
      if((revision.result||0)!==projection.revision){done(false);return;}
      const queue=s.get('queue:'+owner);
      queue.onsuccess=()=>{
        if(JSON.stringify(queue.result||[])!==projection.queueSignature){done(false);return;}
        for(const [url,record] of projection.records)if(record.source==='local'&&/\/pos\/local\//.test(url))s.put(record,'local-response:'+owner+':'+url);
        s.put(projection,'projection:'+owner);done(true);
      };
    };
  });
  const validProjection = owner => transaction('readonly',(s,done)=>{
    const p=s.get('projection:'+owner);
    p.onsuccess=()=>{
      if(!p.result){done(null);return;}
      const auth=s.get('identity');
      auth.onsuccess=()=>{
      if(auth.result?.key!==owner||JSON.stringify(auth.result.permissions||[])!==p.result.authorization){done(null);return;}
      const revision=s.get('cloud-revision:'+owner);
      revision.onsuccess=()=>{
        if((revision.result||0)!==p.result.revision){done(null);return;}
        const queue=s.get('queue:'+owner);
        queue.onsuccess=()=>done(JSON.stringify(queue.result||[])===p.result.queueSignature?p.result:null);
      };
      };
    };
  });
  const backupQueue = owner => transaction('readwrite',(s,done)=>{
    const queue=s.get('queue:'+owner);
    queue.onsuccess=()=>{
      const operations=queue.result||[];
      if(!Array.isArray(operations)){s.transaction.abort();return;}
      if(!operations.length){done(null);return;}
      const last=s.get('respaldo-ultimo:'+owner);
      last.onsuccess=()=>{
        const firma=JSON.stringify(operations);
        if(last.result?.firma===firma){done(last.result);return;}
        const snapshot={version:2,sequence:(last.result?.sequence||0)+1,at:Date.now(),firma,operaciones:operations};
        const original=s.get('respaldo:'+owner);
        original.onsuccess=()=>{
          if(!original.result)s.put(snapshot,'respaldo:'+owner);
          s.put(snapshot,'respaldo-version:'+owner+':'+snapshot.sequence);
          s.put(snapshot,'respaldo-ultimo:'+owner);done(snapshot);
        };
      };
    };
  });
  const entries = () => transaction('readonly', (s, done) => {
    const result = [], r = s.openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { result.push([c.key, c.value]); c.continue(); } else done(result); };
  });
  // Una cola por cuenta: actualizarla en una sola transacción evita perder acciones entre pestañas.
  const update = (key, fn) => transaction('readwrite', (s, done) => {
    const r = s.get(key); r.onsuccess = () => { const value = fn(r.result); s.put(value, key); done(value); };
  });
  async function clear() { await transaction('readwrite', s => s.clear()); }
  const api = {get, put, putRemote, adoptQueue, backupQueue, projectionSnapshot, commitProjection, validProjection, remove, entries, update, clear};
  globalThis.FulltechOfflineStore = api;
  globalThis.FullTECHOfflineStore = api;
})();
