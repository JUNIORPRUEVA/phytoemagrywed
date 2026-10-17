// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProofreadingService, validCorrection } from '../server/proofreading.mjs';
import { handleProofreadingRoute } from '../server/proofreading-routes.mjs';
import { startCrmServer } from '../server/crm-server.mjs';

const API_KEY = 'sk-fake-test-not-a-real-key-123456';
const result = text => ({ ok: true, json: async()=>({ choices:[{finish_reason:'stop',message:{content:JSON.stringify({text})}}] }) });
function fixture(options={}) {
  const rows = new Map();
  const settings = {read:async key=>rows.has(key)?{value:rows.get(key)}:null,write:async(key,value)=>{rows.set(key,value);}};
  const fetchImpl = vi.fn(async()=>result('hola'));
  const service = createProofreadingService({settings,secret:'server-only-secret',fetchImpl,checker:async()=>()=>({uncertain:[{word:'hoas'}]}),...options});
  const input = {text:'hoas',conversationId:'chat-1',actorId:'agent-1'};
  return {service,settings,rows,fetchImpl:options.fetchImpl || fetchImpl,input};
}
async function enable(f, extra={}) { await f.service.save({apiKey:API_KEY,enabled:true,dailyLimit:100,...extra}); }
describe('DeepSeek: secretos, consumo y correcciones',()=>{
  it('guarda cifrado y mantiene la configuración al recrear el servicio',async()=>{
    const f=fixture();await enable(f);
    expect(JSON.stringify([...f.rows])).not.toContain(API_KEY);
    expect(JSON.stringify(await f.service.status())).not.toContain(API_KEY);
    const reopened=createProofreadingService({settings:f.settings,secret:'server-only-secret',fetchImpl:f.fetchImpl});
    expect(await reopened.status()).toMatchObject({configured:true,enabled:true,model:'deepseek-flash',dailyLimit:100});
    await reopened.save({enabled:true,dailyLimit:12});expect((await reopened.status()).configured).toBe(true);
    await reopened.save({removeKey:true,enabled:false});expect(await reopened.status()).toMatchObject({configured:false,enabled:false});
  });
  it('no llama sin configurar o sin dudas reales del motor local',async()=>{
    const f=fixture();expect(await f.service.correct(f.input)).toBeNull();expect(f.fetchImpl).not.toHaveBeenCalled();
    const g=fixture({checker:async()=>()=>null});await enable(g);expect(await g.service.correct(g.input)).toBeNull();expect(g.fetchImpl).not.toHaveBeenCalled();
  });
  it('verifica las dudas con el diccionario real del servidor antes de gastar',async()=>{
    const f=fixture({checker:undefined});await enable(f);
    expect(await f.service.correct({...f.input,text:'hoas coo esta'})).toBeNull();expect(f.fetchImpl).not.toHaveBeenCalled();
    expect((await f.service.correct(f.input)).correctedText).toBe('hola');expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('solo usa Flash sin razonamiento y entrega una propuesta completa',async()=>{
    const f=fixture();await enable(f);const suggestion=await f.service.correct(f.input);
    expect(suggestion.correctedText).toBe('hola');
    const [url,request]=f.fetchImpl.mock.calls[0],body=JSON.parse(request.body);
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(body).toMatchObject({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:2048});
    expect(JSON.parse(body.messages[1].content).draft).toBe('hoas');
    expect(request.signal).toBeTruthy();
  });
  it('comparte consultas simultáneas y reutiliza la caché sin otro cargo',async()=>{
    const f=fixture();await enable(f);
    const values=await Promise.all([f.service.correct(f.input),f.service.correct(f.input)]);
    expect(values[0]).toEqual(values[1]);await f.service.correct(f.input);expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect((await f.service.status()).usedToday).toBe(1);
  });
  it('respeta el tope diario y lo conserva al recrear el servicio',async()=>{
    const f=fixture();await enable(f,{dailyLimit:1});await f.service.correct(f.input);
    expect(await f.service.correct({...f.input,actorId:'agent-2',text:'otra duda'})).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const reopened=createProofreadingService({settings:f.settings,secret:'server-only-secret',fetchImpl:f.fetchImpl,checker:async()=>()=>({uncertain:[{}]})});
    expect(await reopened.correct({...f.input,text:'otra duda'})).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('limita consultas distintas del mismo usuario aunque cambie el texto',async()=>{
    const f=fixture();await enable(f);
    for(let i=0;i<10;i++)await f.service.correct({...f.input,text:'hoas '+i});
    expect(await f.service.correct({...f.input,text:'otro borrador'})).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(10);
  });
  it('omite respuestas truncadas, inválidas, errores y timeouts sin exponer el proveedor',async()=>{
    for (const response of [()=>({ok:false}),()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})}),()=>({ok:true,json:async()=>{throw new Error(API_KEY);}}),()=>{throw new Error(API_KEY);}]) {
      const f=fixture({fetchImpl:vi.fn(response)});await enable(f);expect(await f.service.correct(f.input)).toBeNull();
    }
  });
  it('verifica el modelo con models sin generar una corrección',async()=>{
    const f=fixture({fetchImpl:vi.fn(async()=>({ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})}))});
    await enable(f);expect(await f.service.test()).toBe(true);expect(f.fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/models');expect((await f.service.status()).usedToday).toBe(0);
  });
  it('rechaza modelos caros, límites inválidos y activación sin clave',async()=>{
    const f=fixture();await expect(f.service.save({enabled:true})).rejects.toThrow();
    await expect(f.service.save({model:'deepseek-v4-pro'})).rejects.toThrow();await expect(f.service.save({dailyLimit:1001})).rejects.toThrow();
  });
  it('no acepta cambios en números, enlaces o nombres del cliente ni respuestas inventadas',()=>{
    expect(validCorrection('grasias Ana RD$ 1250 https://a.do','gracias Ana RD$ 1500 https://a.do',['Ana'])).toBe(false);
    expect(validCorrection('grasias Ana RD$ 1250','gracias Ana US$ 1250',['Ana'])).toBe(false);
    expect(validCorrection('grasias Ana https://a.do','gracias Ana https://b.do',['Ana'])).toBe(false);
    expect(validCorrection('grasias Ana','gracias Pedro',['Ana'])).toBe(false);
    expect(validCorrection('grasias por su pedido de hoy','No puedo ayudar con esa petición')).toBe(false);
    expect(validCorrection('grasias Ana RD$ 1250','gracias Ana RD$ 1250',['Ana'])).toBe(true);
    expect(validCorrection('buenas, hoas coo esta mi amido','Buenas, ¿cómo está mi amigo?',['Prueba Seis'])).toBe(true);
    expect(validCorrection('hoas nesesito saver komo resivir el pediod','Hola, necesito saber cómo recibir el pedido')).toBe(true);
  });
  it('el endpoint no permite configurar al agente ni revisar otra conversación',async()=>{
    const correct=vi.fn();const json=vi.fn();
    const base={req:{method:'POST'},res:{},ctx:{db:{get:async()=>({id:'chat-2',customer_id:'c'})},customers:{get:async()=>({name:'Ana'})},proofreading:{correct}},actor:{id:'a'},can:permission=>permission==='chats.reply',canOpen:async()=>false,readJson:async()=>({conversationId:'chat-2',text:'hoas'}),json};
    await handleProofreadingRoute({...base,route:'/api/admin/settings/deepseek'});expect(json.mock.calls.at(-1)[1]).toBe(403);
    await handleProofreadingRoute({...base,route:'/api/admin/proofreading'});expect(json.mock.calls.at(-1)[1]).toBe(403);expect(correct).not.toHaveBeenCalled();
  });
});

let app, folder, cookie;
beforeAll(async()=>{
  folder=mkdtempSync(path.join(os.tmpdir(),'fulltech-deepseek-'));
  app=await startCrmServer({port:0,host:'127.0.0.1',dataFile:path.join(folder,'test.sqlite'),token:'deepseek-test-token',quiet:true,schedulerEnabled:false,bootstrapAdminUser:'admin@deepseek.local',bootstrapAdminPassword:'Deepseek-12345'});
  const response=await fetch(app.url+'/api/admin/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin@deepseek.local',password:'Deepseek-12345'})});
  cookie=response.headers.get('set-cookie').split(';')[0];
});
afterAll(async()=>{await app?.close();rmSync(folder,{recursive:true,force:true});});
describe('API de configuración real',()=>{
  it('exige sesión y rechaza un origen externo',async()=>{
    expect((await fetch(app.url+'/api/admin/settings/deepseek')).status).toBe(401);
    const response=await fetch(app.url+'/api/admin/settings/deepseek',{method:'POST',headers:{cookie,origin:'https://otro.example','content-type':'application/json'},body:'{}'});expect(response.status).toBe(403);
  });
  it('guarda en el almacén real sin devolver ni guardar la clave en claro',async()=>{
    const response=await fetch(app.url+'/api/admin/settings/deepseek',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({apiKey:API_KEY,enabled:true,dailyLimit:25})});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({deepseek:{configured:true,enabled:true,dailyLimit:25}});
    const saved=await app.collections.findBy('settings','key','proofreading_deepseek');expect(JSON.stringify(saved)).not.toContain(API_KEY);
    const read=await fetch(app.url+'/api/admin/settings/deepseek',{headers:{cookie}});expect(await read.text()).not.toContain(API_KEY);
  });
  it('conserva la clave cifrada y la activación al reiniciar el servidor con el mismo almacén',async()=>{
    await app.close();
    app=await startCrmServer({port:0,host:'127.0.0.1',dataFile:path.join(folder,'test.sqlite'),token:'deepseek-test-token',quiet:true,schedulerEnabled:false});
    const response=await fetch(app.url+'/api/admin/settings/deepseek',{headers:{cookie}});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({deepseek:{configured:true,enabled:true,dailyLimit:25}});
    const saved=await app.collections.findBy('settings','key','proofreading_deepseek');expect(JSON.stringify(saved)).not.toContain(API_KEY);
  });
});
