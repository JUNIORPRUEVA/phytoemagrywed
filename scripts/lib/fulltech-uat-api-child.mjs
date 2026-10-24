import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import {startCrmServer} from '../../server/crm-server.mjs';
let app;
process.once('message',async message=>{try{
 if(!process.send)throw Error('This UAT helper requires a parent IPC channel.');
 const url=new URL(message.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'fulltech_uat');assert.match(url.pathname,/^\/fulltech_uat_[a-f0-9]{32}$/);
 const client=new pg.Client({connectionString:message.url,connectionTimeoutMillis:5000});await client.connect();try{const identity=(await client.query("SELECT current_database() AS database,current_setting('data_directory') AS directory")).rows[0],marker=(await client.query("SELECT nonce,purpose FROM fulltech_uat_guard WHERE id='isolated'")).rows[0];assert.equal(identity.database,url.pathname.slice(1));assert.equal(path.resolve(identity.directory),path.resolve(message.directory));assert.equal(marker.nonce,message.runId);assert.equal(marker.purpose,'FULLTECH_DESTRUCTIVE_UAT_ONLY');}finally{await client.end();}
 app=await startCrmServer({host:'127.0.0.1',port:0,databaseUrl:message.url,dataFile:path.join(message.directory,'unused.sqlite'),token:'postgres-uat-only',quiet:true,schedulerEnabled:false,clock:()=>new Date(message.now),whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true,faultInjector:async point=>{if(point===message.point){process.send({type:'paused',point});await new Promise(()=>{});}}}});
 process.send({type:'ready',url:app.url});
}catch(error){process.send?.({type:'failed',message:error.message});process.exitCode=1;await app?.close();process.disconnect?.();}});
process.on('disconnect',()=>{app?.close().finally(()=>process.exit());});
