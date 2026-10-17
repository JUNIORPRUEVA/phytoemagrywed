import { createHash, randomUUID } from 'node:crypto';
import { normalizeLocation } from './locations.mjs';
const KEY = 'chat_sharing';
const clean = (value, max=160) => { const result=typeof value==='string'?value.trim():''; if(result.length>max)throw new Error(`Acorta el texto a ${max} caracteres.`);return result; };
const required = (value,label,max) => { const text=clean(value,max); if(!text) throw new Error(`Completa ${label}.`); return text; };
export function normalizeChatSharing(input) {
  const list = key => { if (!Array.isArray(input[key]) || input[key].length > 10) throw new Error(`Puedes guardar hasta 10 opciones en ${key}.`); return input[key]; };
  const ids = new Set();
  const identify = row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Opción no válida.');
    const id = /^[a-zA-Z0-9_-]{1,80}$/.test(row.id || '') ? row.id : randomUUID();
    if(ids.has(id))throw new Error('Hay opciones duplicadas.');ids.add(id);return id;
  };
  return {
    locations:list('locations').map(row=>{
      const id=identify(row),name=required(row.name,'el nombre de la ubicación',120);
      const result=normalizeLocation({latitude:row.latitude,longitude:row.longitude,name,address:clean(row.address,300),source:'manual_coordinates'});
      if(!result.ok)throw new Error(result.message);
      return {id,name,address:result.location.address || '',latitude:result.location.latitude,longitude:result.location.longitude};
    }),
    banks:list('banks').map(row=>{
      const id=identify(row),bank=required(row.bank,'el banco',100),holder=required(row.holder,'el titular',160),number=required(row.number,'el número de cuenta',64);
      if(!/^[\p{L}\p{N} .-]+$/u.test(number))throw new Error('Revisa el número de cuenta.');
      if(!['DOP','USD','EUR'].includes(row.currency))throw new Error('Elige una moneda válida.');
      return {id,bank,holder,number,currency:row.currency,type:clean(row.type,80),note:clean(row.note,250)};
    }),
    catalogs:list('catalogs').map(row=>{
      const id=identify(row),name=required(row.name,'el nombre del catálogo',100);
      let url;try {url=new URL(row.url);}catch{throw new Error('Escribe una dirección web válida para el catálogo.');}
      if(url.protocol!=='https:' || url.username || url.password || url.href.length>1200)throw new Error('El catálogo necesita una dirección HTTPS sin credenciales.');
      return {id,name,url:url.href,message:clean(row.message,500)};
    }),
  };
}
export function bankMessage(bank) {
  return [`Banco: ${bank.bank}`,`Titular: ${bank.holder}`,bank.type?`Tipo: ${bank.type}`:null,`Cuenta: ${bank.number}`,`Moneda: ${bank.currency}`,bank.note||null].filter(Boolean).join('\n');
}
export function createChatSharingService({settings,customers}) {
  const read=async()=> (await settings.read(KEY))?.value || {locations:[],banks:[],catalogs:[]};
  const snapshot=async()=>{
    const data=await read();
    return {...data,banks:data.banks.map(row=>({...row,message:bankMessage(row)})),catalogs:data.catalogs.map(row=>({...row,text:[row.message||`Mira nuestro catálogo de ${row.name}:`,row.url].join('\n')}))};
  };
  return {snapshot,async save(input){
    const data=normalizeChatSharing(input);
    // Referencia global sin asociarla al domicilio de ningún cliente. El envío
    // nativo existente reutiliza la referencia y mantiene sus controles.
    for(const row of data.locations){
      const fingerprint=createHash('sha256').update(JSON.stringify(row)).digest('hex');
      const saved=await customers.saveLocation({location:{latitude:row.latitude,longitude:row.longitude,name:row.name,address:row.address,source:'manual_coordinates'},customerId:null,idempotencyKey:`business:${fingerprint}`});
      if(!saved.ok)throw new Error('No se pudo guardar la ubicación.');
      row.referenceId=saved.location.id;
    }
    await settings.write(KEY,data);return snapshot();
  }};
}
export async function handleChatSharingRoute({req,res,route,ctx,can,readJson,json}) {
  const read=route==='/api/admin/chat-sharing',save=route==='/api/admin/settings/chat-sharing';
  if(!read&&!save)return false;
  const send=(status,body)=>{json(res,status,body);return true;};
  if(!can(save?'settings.manage':'chats.reply'))return send(403,{ok:false,error:'forbidden'});
  if((read&&req.method!=='GET')||(save&&req.method!=='POST'))return send(405,{ok:false});
  if(read)return send(200,{ok:true,sharing:await ctx.chatSharing.snapshot()});
  let body;try{body=await readJson(req,30000);if(!body||typeof body!=='object')throw new Error();}catch{return send(400,{ok:false,message:'Datos no válidos.'});}
  try{return send(200,{ok:true,sharing:await ctx.chatSharing.save(body)});}catch(error){return send(400,{ok:false,message:error.message || 'No se pudo guardar.'});}
}
