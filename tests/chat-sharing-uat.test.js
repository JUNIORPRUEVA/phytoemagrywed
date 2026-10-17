// @vitest-environment node
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {startCrmServer} from '../server/crm-server.mjs';
import {normalizeChatSharing} from '../server/chat-sharing.mjs';
const TOKEN='sharing-uat-token',SECRET='sharing-uat-webhook';
const data={locations:[{id:'office',name:'Oficina de prueba',address:'Dirección de prueba',latitude:18.4861,longitude:-69.9312}],banks:[{id:'bank-one',bank:'Banco de prueba',holder:'Empresa de prueba',number:'001234567890',type:'Ahorros',currency:'DOP',note:'Envía tu comprobante.'},{id:'bank-two',bank:'Otro banco',holder:'Empresa de prueba',number:'000000009999',type:'Corriente',currency:'USD'}],catalogs:[{id:'phyto',name:'Phytoemagry',url:'https://phyto.example.com/',message:'Mira nuestro catálogo:'},{id:'fulltech',name:'FullTECH',url:'https://fulltech.example.com/',message:'Nuestro catálogo FullTECH:'}]};
let app,dir,cookie,conversationId,dom,copied='';
const sent=[],locations=[];
const whatsapp={enabled:true,phoneNumberId:'sharing-uat',graphVersion:'v21.0',businessAccountId:'uat',sendText:async(to,body)=>{sent.push({to,body});return{ok:true,messageId:'wamid.shared.'+sent.length};},sendLocation:async(to,location)=>{locations.push({to,location});return{ok:true,messageId:'wamid.loc.'+locations.length};},markAsRead:async()=>({ok:true})};
const start=()=>startCrmServer({host:'127.0.0.1',port:0,dataFile:path.join(dir,'test.sqlite'),token:TOKEN,metaAppSecret:SECRET,whatsapp,quiet:true,schedulerEnabled:false});
async function request(route,body,options={}){return fetch(app.url+route,{headers:{cookie,'content-type':'application/json',...(options.headers||{})},...(body?{method:'POST',body:JSON.stringify(body)}:{}),...options});}
async function waitFor(check){const until=Date.now()+7000;while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('No se completó la operación de compartir');}
const $=selector=>dom.window.document.querySelector(selector);
const click=selector=>{const node=$(selector);expect(node).toBeTruthy();node.click();};
const input=(node,value)=>{node.value=value;node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
beforeAll(async()=>{
  dir=mkdtempSync(path.join(os.tmpdir(),'fulltech-sharing-'));app=await start();
  const payload={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'sharing-uat'},contacts:[{wa_id:'18095551234',profile:{name:'Cliente Compartir'}}],messages:[{from:'18095551234',id:'wamid.sharing.inbound',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Hola, quiero información'}}]}}]}]};
  const body=JSON.stringify(payload);
  await fetch(app.url+'/api/webhooks/whatsapp',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',SECRET).update(body).digest('hex')},body});
  const login=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:TOKEN})});cookie=login.headers.get('set-cookie').split(';')[0];
  conversationId=(await(await request('/api/admin/data')).json()).conversations[0].id;
});
afterAll(async()=>{dom?.window.close();await app?.close();rmSync(dir,{recursive:true,force:true});});

describe('opciones persistentes del negocio',()=>{
  it('guarda ubicaciones, cuentas con ceros iniciales y dos catálogos',async()=>{
    const response=await request('/api/admin/settings/chat-sharing',data);expect(response.status).toBe(200);
    const saved=(await response.json()).sharing;
    expect(saved.banks[0].number).toBe('001234567890');expect(saved.banks[0].message).toContain('Titular: Empresa de prueba');
    expect(saved.catalogs.map(row=>row.name)).toEqual(['Phytoemagry','FullTECH']);
    const location=await app.collections.get('locations',saved.locations[0].referenceId);expect(location.customer_id).toBeNull();expect(location.latitude).toBe(data.locations[0].latitude);
  });
  it('reutiliza la misma referencia al guardar sin cambios y crea otra si cambia el punto',async()=>{
    const old=(await(await request('/api/admin/chat-sharing')).json()).sharing;
    const same=(await(await request('/api/admin/settings/chat-sharing',data)).json()).sharing;
    expect(same.locations[0].referenceId).toBe(old.locations[0].referenceId);
    const changed=(await(await request('/api/admin/settings/chat-sharing',{...data,locations:[{...data.locations[0],latitude:19}]})).json()).sharing;
    expect(changed.locations[0].referenceId).not.toBe(old.locations[0].referenceId);
    expect((await app.collections.get('locations',old.locations[0].referenceId)).latitude).toBe(data.locations[0].latitude);
    await request('/api/admin/settings/chat-sharing',data);
  });
  it('sobrevive al reinicio del servidor',async()=>{
    await app.close();app=await start();
    const response=await request('/api/admin/chat-sharing');expect(response.status).toBe(200);
    expect((await response.json()).sharing.banks[1].number).toBe('000000009999');
  });
  it('exige sesión, permisos de administración y el origen correcto para configurar',async()=>{
    expect((await fetch(app.url+'/api/admin/chat-sharing')).status).toBe(401);
    expect((await request('/api/admin/settings/chat-sharing',data,{headers:{cookie,origin:'https://otro.example','content-type':'application/json'}})).status).toBe(403);
    const user=await request('/api/admin/users',{username:'agent-sharing',password:'Agente-12345',displayName:'Agente Compartir',role:'AGENT'});expect(user.ok).toBe(true);
    const login=await fetch(app.url+'/api/admin/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'agent-sharing',password:'Agente-12345'})});const agentCookie=login.headers.get('set-cookie').split(';')[0];
    expect((await request('/api/admin/chat-sharing',null,{headers:{cookie:agentCookie}})).status).toBe(200);
    expect((await request('/api/admin/settings/chat-sharing',data,{headers:{cookie:agentCookie,'content-type':'application/json'}})).status).toBe(403);
  });
  it('rechaza enlaces ejecutables, coordenadas inválidas y números de cuenta demasiado largos',async()=>{
    expect(()=>normalizeChatSharing({...data,catalogs:[{name:'Inseguro',url:'javascript:alert(1)'}]})).toThrow();
    expect(()=>normalizeChatSharing({...data,locations:[{name:'Punto',latitude:99,longitude:0}]})).toThrow();
    expect(()=>normalizeChatSharing({...data,banks:[{...data.banks[0],number:'0'.repeat(65)}]})).toThrow();
    expect(()=>normalizeChatSharing({...data,banks:[{...data.banks[0],currency:'XXX'}]})).toThrow();
  });
});

describe('menú + real con datos guardados',()=>{
  beforeAll(async()=>{
    dom=new JSDOM(readFileSync('public/admin/index.html','utf8'),{url:app.url+'/admin/?v=whatsapp',runScripts:'outside-only'});
    const win=dom.window;win.matchMedia=()=>({matches:false,addEventListener(){}});win.scrollTo=()=>{};win.confirm=()=>true;
    Object.defineProperty(win.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
    win.fetch=(input,init={})=>request(new URL(typeof input==='string'?input:input.url,app.url).pathname,null,{...init,headers:{...(init.headers||{}),cookie}});
    win.eval(readFileSync('public/admin/conversation-list.js','utf8'));win.eval(readFileSync('public/admin/app.js','utf8'));win.eval(readFileSync('public/admin/chat-sharing-settings.js','utf8'));win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await waitFor(()=>$('[data-conv]'));click(`[data-conv="${conversationId}"]`);await waitFor(()=>$('#wa-attach'));
  });
  it('usa la flecha junto al cliente para volver del chat a la lista',async()=>{
    expect(dom.window.document.body.dataset.waView).toBe('chat');
    click('#wa-back');
    expect(dom.window.document.body.dataset.waView).toBe('list');
    expect(dom.window.document.body.dataset.tab).toBe('whatsapp');
    click(`[data-conv="${conversationId}"]`);
    await waitFor(()=>dom.window.document.body.dataset.waView==='chat'&&$('#wa-text'));
  });
  it('abrir un chat y volver conserva el desplazamiento de la bandeja',async()=>{
    click('#wa-back');
    const list=$('#wa-conversations');list.scrollTop=236;
    click(`[data-conv="${conversationId}"]`);
    await waitFor(()=>dom.window.document.body.dataset.waView==='chat'&&$('#wa-text'));
    click('#wa-back');expect(list.scrollTop).toBe(236);
    click(`[data-conv="${conversationId}"]`);
    await waitFor(()=>dom.window.document.body.dataset.waView==='chat'&&$('#wa-text'));
  });
  it('ofrece bancos y catálogos aunque la multimedia esté desactivada',async()=>{
    click('#wa-attach');expect($('#attach-banks')).toBeTruthy();expect($('#attach-catalogs')).toBeTruthy();expect($('#attach-location')).toBeTruthy();expect(sent).toHaveLength(0);
  });
  it('Enter en móvil y durante composición no envía; en escritorio conserva el atajo',()=>{
    const win=dom.window, area=$('#wa-text'), send=$('#wa-send'), previous=win.matchMedia;
    let attempts=0;
    const intercept=(event)=>{attempts++;event.preventDefault();event.stopImmediatePropagation();};
    send.addEventListener('click',intercept,true);
    const press=(options={})=>{const event=new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});area.dispatchEvent(event);return event;};
    try {
      input(area,'Borrador del mensaje');
      win.matchMedia=()=>({matches:true,addEventListener(){}});
      expect(press().defaultPrevented).toBe(false);expect(attempts).toBe(0);
      win.matchMedia=previous;
      press({isComposing:true});press({keyCode:229});press({repeat:true});press({shiftKey:true});
      expect(attempts).toBe(0);
      expect(press().defaultPrevented).toBe(true);expect(attempts).toBe(1);
      expect(area.value).toBe('Borrador del mensaje');
    } finally {win.matchMedia=previous;send.removeEventListener('click',intercept,true);input(area,'');}
  });
  it('copia únicamente el número y prepara una cuenta sin borrar el borrador ni enviarlo',async()=>{
    input($('#wa-text'),'Mensaje anterior');click('#attach-banks');await waitFor(()=>$('[data-sharing-copy]'));
    click('[data-sharing-copy="0"]');await waitFor(()=>copied==='001234567890');expect(sent).toHaveLength(0);
    click('[data-sharing-use="0"]');expect($('#wa-text').value).toContain('Mensaje anterior\n\nBanco: Banco de prueba');expect($('#wa-text').value).toContain('Cuenta: 001234567890');expect(sent).toHaveLength(0);
    input($('#wa-text'),'');
  });
  it('prepara todas las cuentas en un solo texto ordenado',async()=>{
    click('#wa-attach');click('#attach-banks');await waitFor(()=>$('[data-sharing-all]'));click('[data-sharing-all]');
    expect($('#wa-text').value).toContain('Cuentas bancarias — FullTECH, SRL');expect($('#wa-text').value).toContain('000000009999');expect($('#wa-text').value).toContain('Moneda: USD');expect(sent).toHaveLength(0);input($('#wa-text'),'');
  });
  it('permite elegir entre las dos webs y previsualiza solo la seleccionada',async()=>{
    click('#wa-attach');click('#attach-catalogs');await waitFor(()=>$('[data-sharing-use="1"]'));expect($('#sheet-body').textContent).toContain('Phytoemagry');expect($('#sheet-body').textContent).toContain('FullTECH');
    click('[data-sharing-use="1"]');expect($('.wa-preview').textContent).toContain('https://fulltech.example.com/');expect(sent).toHaveLength(0);
    click('#sharing-catalog-use');expect($('#wa-text').value).toBe('Nuestro catálogo FullTECH:\nhttps://fulltech.example.com/');expect(sent).toHaveLength(0);input($('#wa-text'),'');
  });
  it('previsualiza y envía el mapa nativo solo al confirmar, manteniendo la ubicación global',async()=>{
    const config=(await(await request('/api/admin/chat-sharing')).json()).sharing;
    expect((await request(`/api/admin/conversations/${conversationId}/location`,{locationId:config.locations[0].referenceId})).status).toBe(409);
    click('#wa-attach');click('#attach-location');await waitFor(()=>$('[data-sharing-use="0"]'));click('[data-sharing-use="0"]');
    expect($('#sheet-title').textContent).toBe('Ubicación del negocio');expect(locations).toHaveLength(0);expect($('#sheet-body').textContent).toContain('Oficina de prueba');
    click('#sharing-location-send');await waitFor(()=>locations.length===1);expect(locations[0].location.latitude).toBe(data.locations[0].latitude);await waitFor(()=>$('#sheet').hidden);
    expect((await app.collections.get('locations',config.locations[0].referenceId)).customer_id).toBeNull();
  });
  it('abre su configuración, permite editar y confirma los datos al volver a leer',async()=>{
    click('#wa-attach');click('#attach-configure');await waitFor(()=>!$('#config-chat-sharing').hidden&&$('#sharing-edit-banks').children.length===2);
    expect($('#chat-sharing-form').hidden).toBe(true);
    click('[data-settings-open="compartir-bancos"]');
    expect($('#sharing-edit-banks').closest('section').hidden).toBe(false);
    expect($('#sharing-edit-locations').closest('section').hidden).toBe(true);
    const holder=$('#sharing-edit-banks [data-sharing-field="holder"]');input(holder,'Empresa actualizada');
    $('#chat-sharing-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>{const status=$('#sharing-settings-feedback').textContent;if(status&&status!=='Guardando…'&&!status.startsWith('Opciones guardadas'))throw new Error(status);return status.startsWith('Opciones guardadas');});
    const result=(await(await request('/api/admin/chat-sharing')).json()).sharing;expect(result.banks[0].holder).toBe('Empresa actualizada');expect(result.banks[0].number).toBe('001234567890');
  });
  it('permite agregar y eliminar cuentas, conservando el número como texto',async()=>{
    click('[data-sharing-add="banks"]');
    expect($('#sharing-edit-banks').children).toHaveLength(3);
    const row=$('#sharing-edit-banks').lastElementChild;
    input(row.querySelector('[data-sharing-field="bank"]'),'Nuevo banco');input(row.querySelector('[data-sharing-field="holder"]'),'Titular de prueba');input(row.querySelector('[data-sharing-field="number"]'),'000000000001');
    $('#chat-sharing-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>{const status=$('#sharing-settings-feedback').textContent;if(status&&status!=='Guardando…'&&!status.startsWith('Opciones guardadas'))throw new Error(status);return status.startsWith('Opciones guardadas');});
    let result=(await(await request('/api/admin/chat-sharing')).json()).sharing;expect(result.banks).toHaveLength(3);expect(result.banks[2].number).toBe('000000000001');
    $('#sharing-edit-banks').lastElementChild.querySelector('[data-sharing-remove]').click();
    $('#chat-sharing-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>$('#sharing-settings-feedback').textContent.startsWith('Opciones guardadas'));
    result=(await(await request('/api/admin/chat-sharing')).json()).sharing;expect(result.banks).toHaveLength(2);
  });
  it('solo solicita la ubicación del dispositivo cuando se pulsa Usar mi ubicación actual',async()=>{
    click('#view-ajustes [data-settings-back]');
    expect(dom.window.location.hash).toBe('#config/compartir');
    click('[data-settings-open="compartir-ubicaciones"]');
    let requests=0;Object.defineProperty(dom.window.navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>{requests++;success({coords:{latitude:19.1,longitude:-70.7}});}}});
    expect(requests).toBe(0);click('[data-sharing-current]');expect(requests).toBe(1);
    expect($('#sharing-edit-locations [data-sharing-field="latitude"]').value).toBe('19.1');expect($('#sharing-edit-locations [data-sharing-map]').hidden).toBe(false);
    expect(locations).toHaveLength(1); // Solo el envío confirmado en la prueba anterior.
  });
  it('selecciona en el mapa, cancela sin cambiar y guarda solo el punto confirmado',async()=>{
    let onClick,removed=0;
    const map={setView(){return this;},on(event,handler){if(event==='click')onClick=handler;return this;},remove(){removed++;},invalidateSize(){}};
    dom.window.L={map:()=>map,tileLayer:()=>({addTo(){return this;},on(){}}),marker:()=>({addTo(){return this;},on(){},setLatLng(){}})};
    click('[data-sharing-select-map]');onClick({latlng:{lat:18.5,lng:-69.9}});
    dom.window.dispatchEvent(new dom.window.Event('fulltech:sharing-page'));
    expect($('[data-map-confirm]')).toBeTruthy();expect(removed).toBe(0);
    expect($('#sharing-edit-locations [data-sharing-field="latitude"]').value).toBe('19.1');
    click('[data-map-cancel]');expect(removed).toBe(1);
    click('[data-sharing-select-map]');onClick({latlng:{lat:18.5,lng:-69.9}});click('[data-map-confirm]');
    expect($('#sharing-edit-locations [data-sharing-field="latitude"]').value).toBe('18.500000');
    expect($('#sharing-edit-locations [data-sharing-field="longitude"]').value).toBe('-69.900000');
    $('#chat-sharing-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await waitFor(()=>$('#sharing-settings-feedback').textContent.startsWith('Opciones guardadas'));
    const result=(await(await request('/api/admin/chat-sharing')).json()).sharing;
    expect(result.locations[0].latitude).toBe(18.5);expect(result.banks[0].holder).toBe('Empresa actualizada');expect(result.catalogs).toHaveLength(2);
  });

});
