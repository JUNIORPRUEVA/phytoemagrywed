// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
const html=readFileSync('public/admin/index.html','utf8');
const script=readFileSync('public/admin/deepseek-settings.js','utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let dom;
afterEach(()=>dom?.window.close());
async function setup() {
  dom=new JSDOM(html,{url:'https://crm.test/admin/#config/deepseek',runScripts:'outside-only'});
  await tick();const win=dom.window,$=id=>win.document.getElementById(id);
  let config={enabled:false,configured:false,model:'deepseek-flash',dailyLimit:100,usedToday:0};
  win.fetch=vi.fn(async(path,init={})=>{
    if(path.endsWith('/test'))return {ok:true,json:async()=>({ok:true,connected:true})};
    if(init.body){const value=JSON.parse(init.body);config={...config,enabled:value.enabled,configured:value.removeKey?false:Boolean(value.apiKey)||config.configured,dailyLimit:value.dailyLimit||config.dailyLimit};}
    return {ok:true,json:async()=>({ok:true,deepseek:config})};
  });
  $('config-deepseek').hidden=false;win.eval(script);win.document.dispatchEvent(new win.Event('DOMContentLoaded'));await tick();
  return {win,$};
}
it('guarda la configuración, vacía el campo secreto y no lo persiste en el navegador',async()=>{
  const ui=await setup();ui.$('deepseek-api-key').value='sk-fake-ui-key-123456';ui.$('deepseek-enabled').checked=true;ui.$('deepseek-daily-limit').value='25';
  ui.$('deepseek-settings-form').dispatchEvent(new ui.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  expect(ui.$('deepseek-api-key').value).toBe('');expect(ui.$('deepseek-enabled').checked).toBe(true);
  expect(ui.$('deepseek-key-status').textContent).toContain('Clave guardada');expect(ui.$('deepseek-feedback').textContent).toBe('Clave guardada y confirmada en el servidor. Apoyo activado.');
  expect(ui.$('deepseek-api-key').placeholder).toContain('Clave guardada');
  expect(ui.win.fetch.mock.calls.at(-1)[1].method).toBeUndefined();
  expect(ui.win.localStorage.length).toBe(0);expect(ui.win.sessionStorage.length).toBe(0);
});
it('un repintado de la misma pantalla no borra una clave que se está escribiendo',async()=>{
  const ui=await setup();ui.$('deepseek-api-key').value='sk-borrador';ui.$('config-deepseek').hidden=false;await tick();
  expect(ui.$('deepseek-api-key').value).toBe('sk-borrador');expect(ui.win.fetch).toHaveBeenCalledTimes(1);
});
it('comprueba la conexión y permite eliminar la clave desde la pantalla',async()=>{
  const ui=await setup();ui.$('deepseek-test').click();await tick();expect(ui.$('deepseek-feedback').textContent).toContain('Conexión correcta');
  ui.$('deepseek-remove').click();await tick();expect(ui.$('deepseek-feedback').textContent).toContain('Clave eliminada');
  expect(ui.$('deepseek-enabled').checked).toBe(false);expect(ui.$('deepseek-api-key').value).toBe('');
});
it('si guardar falla conserva la clave en el campo y no anuncia éxito',async()=>{
  const ui=await setup();ui.$('deepseek-api-key').value='sk-fake-unsaved-12345';
  ui.win.fetch.mockRejectedValueOnce(new Error('No se pudo guardar.'));
  ui.$('deepseek-settings-form').dispatchEvent(new ui.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  expect(ui.$('deepseek-api-key').value).toBe('sk-fake-unsaved-12345');
  expect(ui.$('deepseek-feedback').textContent).toBe('No se pudo guardar.');
  expect(ui.$('deepseek-api-key').disabled).toBe(false);
});
it('no anuncia éxito si POST responde bien pero la lectura no confirma la clave',async()=>{
  const ui=await setup();ui.$('deepseek-api-key').value='sk-fake-unconfirmed-12345';ui.$('deepseek-enabled').checked=true;
  ui.win.fetch.mockResolvedValue({ok:true,json:async()=>({ok:true,deepseek:{enabled:false,configured:false,model:'deepseek-flash',dailyLimit:100,usedToday:0}})});
  ui.$('deepseek-settings-form').dispatchEvent(new ui.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  expect(ui.$('deepseek-feedback').textContent).toContain('No se pudo confirmar');
  expect(ui.$('deepseek-api-key').value).toBe('sk-fake-unconfirmed-12345');
});
it('al volver a abrir la pantalla identifica claramente la clave guardada sin devolverla',async()=>{
  const ui=await setup();ui.$('deepseek-api-key').value='sk-fake-persistent-12345';ui.$('deepseek-enabled').checked=true;
  ui.$('deepseek-settings-form').dispatchEvent(new ui.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  ui.$('config-deepseek').hidden=true;await tick();ui.$('config-deepseek').hidden=false;await tick();
  expect(ui.$('deepseek-api-key').value).toBe('');expect(ui.$('deepseek-api-key').placeholder).toContain('Clave guardada');
  expect(ui.$('deepseek-key-status').textContent).toContain('Correcciones de apoyo activadas');
  expect(ui.$('deepseek-key-status').textContent).toContain('El campo queda vacío por seguridad');
});
it('guardar preferencias sin clave no dice que se haya guardado una clave',async()=>{
  const ui=await setup();ui.$('deepseek-settings-form').dispatchEvent(new ui.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  expect(ui.$('deepseek-feedback').textContent).toContain('Falta añadir una clave API');
  expect(ui.$('deepseek-key-status').textContent).toContain('Todavía no hay una clave');
});
