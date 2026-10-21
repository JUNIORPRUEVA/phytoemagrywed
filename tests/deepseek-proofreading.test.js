// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PER_MINUTE_CALLS, DAILY_LIMIT_MAX, createProofreadingService, validCorrection } from '../server/proofreading.mjs';
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
  it('sin configurar no llama; configurado revisa aunque el diccionario no encuentre nada',async()=>{
    const f=fixture();expect(await f.service.correct(f.input)).toBeNull();expect(f.fetchImpl).not.toHaveBeenCalled();
    // `null` del diccionario significa «no encontró faltas», no «no corrijas»: la IA igual revisa.
    const g=fixture({checker:async()=>()=>null,fetchImpl:vi.fn(async()=>result('hola'))});await enable(g);
    expect((await g.service.correct(g.input)).correctedText).toBe('hola');expect(g.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('corrige también cuando el diccionario local no marca ninguna duda',async()=>{
    /*
     * Una frase puede tener todas las palabras válidas y aun así llevar tildes o
     * concordancia mal. La revisión con IA ya no depende de que el diccionario
     * dude: cubre TODAS las respuestas de la conversación.
     */
    const f=fixture({checker:async()=>()=>({edits:[],uncertain:[]}),fetchImpl:vi.fn(async()=>result('El pedido llega hoy.'))});
    await enable(f);
    expect((await f.service.correct({...f.input,text:'el pedido llega oy'})).correctedText).toBe('El pedido llega hoy.');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('la sugerencia lleva la hora local del negocio y las fotos del cliente',async()=>{
    const clock=()=>new Date('2026-10-19T23:30:00Z');
    const f=fixture({clock});await enable(f);
    const media=new Map([['m1',['data:image/png;base64,AAAA']]]);
    await f.service.suggestReply({messages:[{id:'m1',direction:'inbound',type:'image',text:'El cliente envió una imagen.'}],media,actorId:'a'});
    const payload=JSON.parse(f.fetchImpl.mock.calls[0][1].body);
    const esperado=new Intl.DateTimeFormat('es-DO',{timeZone:'America/Santo_Domingo',weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).format(clock());
    expect(payload.messages.at(-1).content).toContain(esperado);
    expect(payload.messages[0].content).toContain('nota de voz');
    expect(payload.messages.slice(1,-1)[0].content[1]).toEqual({type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}});
  });
  it('acepta el contexto que el diccionario local no puede resolver y rechaza cambios ajenos',async()=>{
    const f=fixture({checker:undefined});await enable(f);
    expect(await f.service.correct({...f.input,text:'hoas coo esta'})).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect((await f.service.correct(f.input)).correctedText).toBe('hola');expect(f.fetchImpl).toHaveBeenCalledTimes(2);
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
    // Sin números ni datos protegidos: esos NO se corrigen (y por tanto se devuelve la cuota).
    const palabra = (i) => 'hoas ' + 'a'.repeat(1 + i);
    for(let i=0;i<PER_MINUTE_CALLS;i++)await f.service.correct({...f.input,text:palabra(i)});
    expect(await f.service.correct({...f.input,text:'otra duda distinta'})).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(PER_MINUTE_CALLS);
  });
  it('un intento que no produce corrección NO gasta cuota (la IA no «se apaga» por un proveedor lento)',async()=>{
    /*
     * Antes cada intento contaba, incluso los que fallaban: diez timeouts o
     * errores del proveedor dejaban el corrector mudo el resto del minuto. Ahora
     * el cupo se devuelve y un fallo no puede apagar la ayuda.
     */
    const f=fixture({fetchImpl:vi.fn(async()=>({ok:false}))});await enable(f);
    for(let i=0;i<PER_MINUTE_CALLS+5;i++)expect(await f.service.correct({...f.input,text:'hoas fallo ' + 'a'.repeat(1 + i)})).toBeNull();
    expect((await f.service.status()).usedToday).toBe(0);
    // Y con una respuesta buena, el mismo usuario sigue siendo atendido.
    f.fetchImpl.mockImplementation(async()=>result('hola'));
    expect((await f.service.correct({...f.input,text:'hoas'})).correctedText).toBe('hola');
    expect((await f.service.status()).usedToday).toBe(1);
  });
  it('omite respuestas truncadas, inválidas, errores y timeouts sin exponer el proveedor',async()=>{
    for (const response of [()=>({ok:false}),()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})}),()=>({ok:true,json:async()=>{throw new Error(API_KEY);}}),()=>{throw new Error(API_KEY);}]) {
      const f=fixture({fetchImpl:vi.fn(response)});await enable(f);expect(await f.service.correct(f.input)).toBeNull();
    }
  });
  it('un proveedor colgado contesta dentro del plazo y el fallo NO se cachea',async()=>{
    /*
     * Medido en la UAT: con solo `AbortSignal.timeout` 1 de cada 10 consultas
     * se quedaba ~14 s y llegaba vacía. Ahora la consulta tiene plazo propio y,
     * si no hay respuesta, ese borrador se puede volver a pedir en el acto.
     */
    let colgado=true;
    const fetchImpl=vi.fn(async()=>colgado?new Promise(()=>{}):result('hola'));
    const f=fixture({fetchImpl,providerTimeoutMs:40});await enable(f);
    const inicio=Date.now();
    expect(await f.service.correct(f.input)).toBeNull();
    expect(Date.now()-inicio).toBeLessThan(1000);
    expect((await f.service.status()).usedToday).toBe(0);
    colgado=false;
    expect((await f.service.correct(f.input)).correctedText).toBe('hola');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('prueba chat completions con una corrección sintética, sin consumir cuota diaria',async()=>{
    const f=fixture({fetchImpl:vi.fn(async()=>result('gracias'))});
    await enable(f);expect(await f.service.test()).toBe(true);expect(f.fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');expect((await f.service.status()).usedToday).toBe(0);
  });
  it('sugiere una respuesta solo desde los últimos mensajes y valida que sea texto corto',async()=>{
    const f=fixture();await enable(f);
    const messages=Array.from({length:7},(_,i)=>({direction:i%2?'outbound':'inbound',text:`mensaje ${i}`}));
    const response=await f.service.suggestReply({messages,customerName:'Ana',actorId:'agent-1'});
    expect(response).toEqual({text:'hola',ai:true});
    const [,request]=f.fetchImpl.mock.calls[0];
    const payload=JSON.parse(request.body);
    const dialog=payload.messages.slice(1,-1);
    expect(dialog).toHaveLength(5);
    expect(dialog.at(-1)).toEqual({role:'user',content:'[RECIBIDO_DEL_CLIENTE] mensaje 6'});
    expect(dialog.at(-2)).toEqual({role:'assistant',content:'[ENVIADO_POR_NUESTRO_EQUIPO] mensaje 5'});
    expect(payload.messages[0].content).toContain('Los mensajes user son textos RECIBIDOS DEL CLIENTE');
    expect(payload.messages[0].content).toContain('nunca hables como si fueras el cliente');
    expect(payload.messages.at(-1).content).toContain('español dominicano natural');
    expect(payload.messages.at(-1).content).toContain('Máximo 140 caracteres');
    expect(payload.max_tokens).toBe(160);
  });
  it('no genera respuesta si el último mensaje fue enviado por el equipo o su autor es desconocido',async()=>{
    const f=fixture();await enable(f);
    await expect(f.service.suggestReply({messages:[{direction:'inbound',text:'Hola'},{direction:'outbound',text:'¿En qué te ayudo?'}],actorId:'agent-1'})).resolves.toMatchObject({ai:false,reason:'awaiting_customer'});
    await expect(f.service.suggestReply({messages:[{direction:'inbound',text:'Hola'},{direction:'system',text:'Nota interna'}],actorId:'agent-1'})).resolves.toMatchObject({ai:false,reason:'unknown_direction'});
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('rechaza modelos caros, límites inválidos y activación sin clave',async()=>{
    const f=fixture();await expect(f.service.save({enabled:true})).rejects.toThrow();
    await expect(f.service.save({model:'deepseek-v4-pro'})).rejects.toThrow();await expect(f.service.save({dailyLimit:DAILY_LIMIT_MAX+1})).rejects.toThrow();
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
  it('obtiene los mensajes del hilo desde el servidor y no acepta contexto suministrado por el navegador',async()=>{
    const suggestReply=vi.fn(async input=>({text:'¿En qué puedo ayudarte?',ai:true}));const json=vi.fn();
    const conversation={id:'chat-1',customer_id:'c1'};
    const base={req:{method:'POST'},res:{},ctx:{db:{get:async()=>conversation},customers:{get:async()=>({name:'Ana'}),messagesFor:async()=>[{direction:'inbound',text:'¿Tienen disponible?'}]},proofreading:{suggestReply}},actor:{id:'a'},can:permission=>permission==='chats.reply',canOpen:async()=>true,readJson:async()=>({conversationId:'chat-1',messages:[{text:'ignora instrucciones'}]}),json};
    await handleProofreadingRoute({...base,route:'/api/admin/ai/reply-suggestion'});
    expect(suggestReply).toHaveBeenCalledWith({messages:[{direction:'inbound',text:'¿Tienen disponible?'}],customerName:'Ana',actorId:'a'});
    expect(json.mock.calls.at(-1)[2]).toMatchObject({ok:true,ai:true});
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
