import {createSqlQuery} from './sql-query.mjs';
const services=new WeakMap();
const conflict=()=>Object.assign(new Error('El ticket cambió en otra sesión. Vuelve a abrirlo antes de continuar.'),{status:409,code:'ticket_conflict'});
/** Un ticket es un borrador persistente, nunca una venta ni una reserva. */
export function ticketsFor(ctx){
  if(!services.has(ctx))services.set(ctx,(async()=>{
    const adapter=createSqlQuery({backend:ctx.db.kind,handle:ctx.store.handle});
    const sql={query:(text,args)=>ctx.db.kind==='sqlite'&&!text.trim().startsWith('SELECT')?ctx.storeCatalog.exclusive(()=>adapter.query(text,args)):adapter.query(text,args)};
    await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_pos_tickets_v1 (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL, operation_id TEXT, doc TEXT NOT NULL)`);
    await sql.query('CREATE INDEX IF NOT EXISTS fulltech_pos_tickets_actor_idx ON fulltech_pos_tickets_v1(actor_id,updated_at)');
    const decode=r=>r?{...JSON.parse(r.doc),status:r.status,version:Number(r.version),operation_id:r.operation_id}:null;
    const get=async id=>decode((await sql.query('SELECT * FROM fulltech_pos_tickets_v1 WHERE id=$1',[id])).rows[0]);
    return {
      get,
      list:async actor=>(await sql.query(actor.role==='ADMIN'?
        'SELECT * FROM fulltech_pos_tickets_v1 ORDER BY updated_at DESC LIMIT 200':
        'SELECT * FROM fulltech_pos_tickets_v1 WHERE actor_id=$1 ORDER BY updated_at DESC LIMIT 200',actor.role==='ADMIN'?[]:[actor.id||actor.role])).rows.map(decode),
      async create(doc){
        await sql.query('INSERT INTO fulltech_pos_tickets_v1(id,actor_id,status,version,updated_at,doc) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(id) DO NOTHING',[doc.id,doc.actor_id,'open',doc.updated_at,JSON.stringify(doc)]);
        return get(doc.id);
      },
      async save(doc,version){
        const row=(await sql.query("UPDATE fulltech_pos_tickets_v1 SET doc=$1,version=version+1,updated_at=$2 WHERE id=$3 AND version=$4 AND status='open' RETURNING *",[JSON.stringify(doc),doc.updated_at,doc.id,version])).rows[0];
        if(!row)throw conflict();return decode(row);
      },
      async begin(id,version,operationId){
        const row=(await sql.query("UPDATE fulltech_pos_tickets_v1 SET status='processing',version=version+1,operation_id=$1 WHERE id=$2 AND version=$3 AND status='open' RETURNING *",[operationId,id,version])).rows[0];
        if(!row)throw conflict();return decode(row);
      },
      async finish(id,operationId,result){
        const doc=await get(id);if(!doc)return;
        await sql.query("UPDATE fulltech_pos_tickets_v1 SET status='completed',version=version+1,doc=$1 WHERE id=$2 AND operation_id=$3 AND status='processing'",[JSON.stringify({...doc,result}),id,operationId]);
      },
      async discard(id,version){
        const row=(await sql.query("UPDATE fulltech_pos_tickets_v1 SET status='discarded',version=version+1 WHERE id=$1 AND version=$2 AND status='open' RETURNING *",[id,version])).rows[0];
        if(!row)throw conflict();return decode(row);
      },
    };
  })());return services.get(ctx);
}
