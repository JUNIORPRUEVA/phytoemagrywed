import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import pg from 'pg';

/** Never reads DATABASE_URL or existing PostgreSQL services. Own cluster only. */
export async function startUatPostgres(){
 const bin=process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':process.env.FULLTECH_UAT_PG_BIN;
 if(!bin)throw Error('No dedicated PostgreSQL binaries were selected. Refusing external database fallback.');
 const runId=randomUUID().replaceAll('-',''),directory=await mkdtemp(path.join(tmpdir(),'fulltech-pg-uat-')),data=path.join(directory,'data'),database='fulltech_uat_'+runId,user='fulltech_uat';
 const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
 const command=(name,args)=>execFileSync(exe(name),args,{windowsHide:true,stdio:'ignore',timeout:30000});
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 command('initdb',['-D',data,'-U',user,'-A','trust','--encoding=UTF8','--locale=C']);
 let started=false,pool;
 try{
  command('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c max_connections=40`,'-w','start']);started=true;
  const bootstrap=new pg.Client({host:'127.0.0.1',port,user,database:'postgres',connectionTimeoutMillis:5000});await bootstrap.connect();
  try{const identity=(await bootstrap.query("SELECT current_user AS username,current_setting('data_directory') AS directory,inet_server_port() AS port")).rows[0];if(identity.username!==user||path.resolve(identity.directory)!==path.resolve(data)||identity.port!==port)throw Error('UAT cluster identity mismatch. No database may be created.');await bootstrap.query(`CREATE DATABASE ${database}`);}finally{await bootstrap.end();}
  const url=`postgresql://${user}@127.0.0.1:${port}/${database}`;pool=new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000});
  await pool.query('CREATE TABLE fulltech_uat_guard(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,nonce TEXT NOT NULL)');await pool.query('INSERT INTO fulltech_uat_guard VALUES($1,$2,$3)',['isolated','FULLTECH_DESTRUCTIVE_UAT_ONLY',runId]);
  async function verify(){const identity=(await pool.query("SELECT current_database() AS database,current_user AS username,current_setting('data_directory') AS directory,host(inet_server_addr()) AS address,inet_server_port() AS port,version() AS version")).rows[0],marker=(await pool.query('SELECT purpose,nonce FROM fulltech_uat_guard WHERE id=$1',['isolated'])).rows[0];if(identity.database!==database||!/^fulltech_uat_[a-f0-9]{32}$/.test(database)||identity.username!==user||identity.address!=='127.0.0.1'||identity.port!==port||path.resolve(identity.directory)!==path.resolve(data)||marker?.nonce!==runId||marker.purpose!=='FULLTECH_DESTRUCTIVE_UAT_ONLY')throw Error('Database is not positively identified as this UAT run. Refusing tests: '+JSON.stringify(identity));return {...identity,purpose:marker.purpose,runId};}
  await verify();return {url,pool,verify,directory,data,runId,async stop(){await verify();await pool.end();pool=null;await readFile(path.join(data,'PG_VERSION'));command('pg_ctl',['-D',data,'-m','fast','-w','stop']);started=false;}};
 }catch(error){await pool?.end().catch(()=>{});if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);throw error;}
}
