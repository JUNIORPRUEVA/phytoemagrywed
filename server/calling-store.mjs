/** SQL aditivo, común a SQLite y PostgreSQL. Reservas atómicas entre procesos. */
export async function createCallingStore(sql) {
  if (!sql.enabled) return null;
  await sql.query(`CREATE TABLE IF NOT EXISTS phytoemagry_calls_v1 (
    id TEXT PRIMARY KEY, meta_id TEXT UNIQUE, conversation_id TEXT NOT NULL,
    status TEXT NOT NULL, updated_at BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS phytoemagry_calls_v1_conversation ON phytoemagry_calls_v1(conversation_id);
  CREATE TABLE IF NOT EXISTS phytoemagry_call_locks_v1 (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS phytoemagry_call_events_v1 (id TEXT PRIMARY KEY, payload TEXT, created_at BIGINT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
  const read = (r) => r ? { ...JSON.parse(r.doc), version: Number(r.version) } : null;
  const store = {
    async get(id) { return read((await sql.query('SELECT doc,version FROM phytoemagry_calls_v1 WHERE id=$1', [id])).rows[0]); },
    async byMeta(id) { return read((await sql.query('SELECT doc,version FROM phytoemagry_calls_v1 WHERE meta_id=$1', [id])).rows[0]); },
    async list(conversationId) {
      return (await sql.query('SELECT doc,version FROM phytoemagry_calls_v1 WHERE conversation_id=$1 ORDER BY updated_at DESC LIMIT 50', [conversationId])).rows.map(read);
    },
    async active() {
      return (await sql.query("SELECT doc,version FROM phytoemagry_calls_v1 WHERE status NOT IN ('completed','failed','rejected','missed') ORDER BY updated_at DESC")).rows.map(read);
    },
    async insert(doc) {
      await sql.query('INSERT INTO phytoemagry_calls_v1(id,meta_id,conversation_id,status,updated_at,doc) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
        [doc.id, doc.metaId ?? null, doc.conversationId, doc.status, doc.updatedAt, JSON.stringify(doc)]);
      return store.get(doc.id);
    },
    async change(id, transform) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await store.get(id);
        if (!current) return null;
        const doc = transform(current);
        if (!doc) return current;
        const result = await sql.query('UPDATE phytoemagry_calls_v1 SET meta_id=$1,status=$2,updated_at=$3,doc=$4,version=version+1 WHERE id=$5 AND version=$6 RETURNING id',
          [doc.metaId ?? null, doc.status, doc.updatedAt, JSON.stringify(doc), id, current.version]);
        if (result.rows.length) return { ...doc, version: current.version + 1 };
      }
      throw new Error('calling_concurrent_update');
    },
    async lock(resource, owner, ttl, now = Date.now()) {
      const r = await sql.query(`INSERT INTO phytoemagry_call_locks_v1(resource,owner,expires_at) VALUES($1,$2,$3)
        ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
        WHERE phytoemagry_call_locks_v1.expires_at < $4 OR phytoemagry_call_locks_v1.owner=$2 RETURNING resource`,
      [resource, owner, now + ttl, now]);
      return r.rows.length > 0;
    },
    async release(owner) { await sql.query('DELETE FROM phytoemagry_call_locks_v1 WHERE owner=$1', [owner]); },
    async enqueue(id, event) {
      await sql.query('INSERT INTO phytoemagry_call_events_v1(id,payload,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [id, JSON.stringify(event), Date.now()]);
    },
    async pending() { return (await sql.query('SELECT id,payload,created_at FROM phytoemagry_call_events_v1 WHERE done=0 ORDER BY created_at LIMIT 100')).rows.map((r) => ({ id: r.id, createdAt: Number(r.created_at), event: JSON.parse(r.payload) })); },
    async done(id) { await sql.query('UPDATE phytoemagry_call_events_v1 SET done=1,payload=NULL WHERE id=$1', [id]); },
    async prune(now = Date.now()) {
      await sql.query('DELETE FROM phytoemagry_call_events_v1 WHERE created_at < $1', [now - 7 * 86400000]);
    },
  };
  return store;
}
