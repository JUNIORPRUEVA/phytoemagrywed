import {startCrmServer} from '../server/crm-server.mjs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay,setImmediate as yieldIO} from 'node:timers/promises';
const dir=await mkdtemp(path.join(tmpdir(),'fulltech-notify-diagnostic-')),app=await startCrmServer({host:'127.0.0.1',port:0,databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'notify-diagnostic',quiet:true,schedulerEnabled:false,whatsapp:{enabled:false},metaCapi:{enabled:false}}),results=[];
try{
 const login=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'notify-diagnostic'})}),cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
 const request=async()=>{const r=await fetch(app.url+'/api/admin/notifications',{headers:{cookie}});return r.json();};
 for(const fair of [false,true]){
  await request();await delay(100);const start=performance.now();
  for(let i=0;i<5005;i++){await app.collections.insert('notification_deletions',{id:`diag-${fair}-${i}`,user_id:'diagnostic',notification_id:'non-user-event-'+i,created_at:'2099-01-01T00:00:00Z'});if(fair&&i%128===0)await yieldIO();}
  // Probe a starvation hypothesis; passing both modes does NOT establish cause.
  if(fair){for(let i=0;i<60;i++){const until=performance.now()+100;while(performance.now()<until){}await yieldIO();}}else{const until=performance.now()+6000;while(performance.now()<until){}}
  try{await request();results.push({fair,status:'passed',elapsedMs:Math.round(performance.now()-start)});}catch(e){results.push({fair,status:'failed',elapsedMs:Math.round(performance.now()-start),message:e.message,cause:e.cause?.code,detail:e.cause?.message});}
 }
 await writeFile('.tmp/store-notification-starvation.json',JSON.stringify({controlledSixSecondStarvation:true,results},null,2));console.log(JSON.stringify(results));
}finally{await app.close();}
