import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createSqlQuery} from './sql-query.mjs';

const stores = new WeakMap();function service(ctx) {
  if (!stores.has(ctx)) stores.set(ctx, (async () => {
    const adapter = createSqlQuery({backend:ctx.db.kind, handle:ctx.store.handle});
    if (!adapter.enabled) return null;
    const sql={query:(text,args)=>ctx.db.kind==='sqlite'&&!text.trim().startsWith('SELECT')?ctx.storeCatalog.exclusive(()=>adapter.query(text,args)):adapter.query(text,args)};
    await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_offline_operations_v1 (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL)`);
    return sql;
  })());
  return stores.get(ctx);
}

/**
 * CONSULTA DE ESTADO (SOLO LECTURA).
 *
 * Responde, por cada clave de operación del teléfono, qué hizo el servidor con
 * ella: si llegó, si se completó y con qué código HTTP. No ejecuta nada ni
 * devuelve cuerpos (podrían llevar datos de clientes).
 */
export async function operationStatuses({ ctx, actor, keys = [] }) {
  const sql = await service(ctx);
  if (!sql) return { disponible: false, estados: [] };
  const actorId = String(actor?.id || actor?.role || '');
  const estados = [];
  for (const key of keys.slice(0, 50)) {
    const texto = String(key ?? '');
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(texto)) { estados.push({ key: texto, estado: 'clave_invalida' }); continue; }
    const id = createHash('sha256').update(actorId + '\n' + texto).digest('hex');
    const row = (await sql.query('SELECT status, response, created_at FROM fulltech_offline_operations_v1 WHERE id=$1', [id])).rows[0];
    if (!row) { estados.push({ key: texto, estado: 'no_recibida' }); continue; }
    let cabecera = null;
    try { cabecera = JSON.parse(row.response); } catch { cabecera = null; }
    const http = Number(cabecera?.status) || null;
    estados.push({
      key: texto,
      estado: row.status === 'completed' ? 'completada' : 'en_proceso',
      http,
      aplicada: Boolean(http && http >= 200 && http < 300),
      at: row.created_at ?? null,
    });
  }
  return { disponible: true, estados };
}

/** Guarda la respuesta antes de confirmarla. Una ejecución incierta NUNCA se repite a ciegas. */
export async function handleOfflineOperation({req,res,route,ctx,actor,json,handle}) {
  const key = req.headers['x-fulltech-operation'];
  if (!key || req.fulltechReplay || ['GET','HEAD'].includes(req.method)) return false;
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) { json(res,422,{ok:false,error:'invalid_operation'}); return true; }
  const sql = await service(ctx);
  if (!sql) { json(res,503,{ok:false,error:'offline_sql_required'}); return true; }
  const chunks=[];let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>2000000){json(res,413,{ok:false,error:'body_too_large'});return true;}
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks), actorId=String(actor.id||actor.role);
  const id=createHash('sha256').update(actorId+'\n'+key).digest('hex');
  const fingerprint=createHash('sha256').update(req.method+'\n'+req.url+'\n').update(raw).digest('hex');
  const inserted=await sql.query(`INSERT INTO fulltech_offline_operations_v1(id,actor_id,fingerprint,status,created_at)
    VALUES($1,$2,$3,'processing',$4) ON CONFLICT(id) DO NOTHING RETURNING id`,[id,actorId,fingerprint,ctx.clock().toISOString()]);
  if(!inserted.rows.length){
    const previous=(await sql.query('SELECT * FROM fulltech_offline_operations_v1 WHERE id=$1',[id])).rows[0];
    if(previous.fingerprint!==fingerprint){json(res,409,{ok:false,error:'operation_reused',message:'Esta operación tiene otros datos.'});return true;}
    if(previous.status!=='completed'){json(res,409,{ok:false,error:'offline_operation_uncertain',message:'Esta operación necesita revisión antes de volver a enviarse.'});return true;}
    const saved=JSON.parse(previous.response);res.writeHead(saved.status,saved.headers);res.end(Buffer.from(saved.body,'base64'));return true;
  }
  const replay=Readable.from([raw]);
  Object.assign(replay,{method:req.method,url:req.url,headers:req.headers,socket:req.socket,fulltechReplay:true});
  const parts=[],headers={};let status=200,ended=false;
  const proxy={
    setHeader:(k,v)=>{headers[k]=v;},getHeader:k=>headers[k],removeHeader:k=>delete headers[k],
    writeHead:(code,h={})=>{status=code;Object.assign(headers,h);},
    write:chunk=>{parts.push(Buffer.from(chunk));return true;},
    end:chunk=>{if(chunk)parts.push(Buffer.from(chunk));ended=true;},
    on:()=>proxy,once:()=>proxy,get headersSent(){return false;},get writableEnded(){return ended;},
  };
  try {
    await handle(replay,proxy,ctx);
    if(!ended)throw new Error('Missing offline operation response');
    const body=Buffer.concat(parts);
    if(status>=500)throw new Error('Server response needs review');
    // Rechazos de dominio también quedan registrados: no vuelven a ejecutarse al reintentar.
    await sql.query("UPDATE fulltech_offline_operations_v1 SET status='completed',response=$1 WHERE id=$2",[JSON.stringify({status,headers,body:body.toString('base64')}),id]);
    res.writeHead(status,headers);res.end(body);
  } catch(e) {
    console.error('[offline] operation needs review',{id,name:e.name});
    json(res,409,{ok:false,error:'offline_operation_uncertain',message:'El resultado necesita revisión. No se repetirá automáticamente.'});
  }
  return true;
}
