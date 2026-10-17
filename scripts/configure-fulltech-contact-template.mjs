import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {parseCallingEnv} from './check-whatsapp-calling.mjs';
import {FULLTECH_CONTACT_TEMPLATE as template} from '../server/fulltech-contact-template.mjs';
const {values}=parseArgs({options:{'env-file':{type:'string'},apply:{type:'boolean',default:false}}});
const env={...(values['env-file']?parseCallingEnv(await readFile(values['env-file'],'utf8')):{}),...process.env};
const token=env.WHATSAPP_ACCESS_TOKEN,waba=env.WHATSAPP_BUSINESS_ACCOUNT_ID,version=env.WHATSAPP_GRAPH_VERSION||'v21.0';
if(!token||!/^\d+$/.test(waba||'')||!/^v\d+\.\d+$/.test(version)){
 console.log(JSON.stringify({ok:false,error:'missing_or_invalid_configuration'}));process.exitCode=1;
}else{
 async function graph(route,body){
  const response=await fetch(`https://graph.facebook.com/${version}/${route}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok||data.error)throw Object.assign(new Error('meta_request_failed'),{status:response.status,code:data.error?.code});return data;
 }
 try{
  const result=await graph(`${waba}/message_templates?name=${template.name}&fields=name,status,language,components`);
  const found=result.data?.find(row=>row.name===template.name&&row.language===template.language);
  if(found){
   const body=found.components?.find(c=>c.type==='BODY')?.text;
   console.log(JSON.stringify({ok:body===template.body,name:template.name,status:found.status,bodyMatches:body===template.body}));if(body!==template.body)process.exitCode=1;
  }else if(!values.apply){console.log(JSON.stringify({ok:true,name:template.name,status:'NOT_REGISTERED',body:template.body}));}
  else{
   const created=await graph(`${waba}/message_templates`,{name:template.name,language:template.language,category:template.category,components:[{type:'BODY',text:template.body,example:{body_text:[['Ana','Tenemos disponible el equipo que consultaste. ¿Quieres que te enviemos los detalles?']]}}]});
   console.log(JSON.stringify({ok:true,name:template.name,status:created.status||'PENDING'}));
  }
 }catch(error){console.log(JSON.stringify({ok:false,error:'meta_request_failed',httpStatus:error.status||null,code:error.code||null}));process.exitCode=1;}
}
