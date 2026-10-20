// @vitest-environment node
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import nspell from 'nspell';
import dictionary from 'dictionary-es-do';
import { createProofreader } from '../src/admin/proofreading-core.mjs';

const check = createProofreader(nspell(dictionary));
const script = readFileSync('public/admin/proofreading.js','utf8');
describe('diccionario real es-DO y protección del borrador', () => {
  it.each([
    ['hoas coo esta','hola cómo está'],
    ['Hoas coo estas','Hola cómo estás'],
    ['hola coo esta','hola cómo está'],
    ['hoas como esta','hola cómo está'],
    ['👋 hoas coo estas amigo','👋 hola cómo estás amigo'],
    ['hoala coo etsa','hola cómo está'],
  ])('reconoce el saludo con varios errores: %s', (text, correctedText) => {
    const result = check(text);
    expect(result.correctedText).toBe(correctedText);expect(result.uncertain).toEqual([]);
    const ranges = result.edits.map(edit=>edit.start);
    expect(new Set(ranges).size).toBe(ranges.length);
    for (const edit of result.edits) expect(text.slice(edit.start,edit.end)).toBe(edit.word);
  });
  it.each(['horas como esta','hola coco esta','hola como esta fruta','hola cómo está'])('respeta palabras válidas fuera del patrón de saludo: %s',text=>{
    expect(check(text)).toBeNull();
  });
  it('corrige expresiones comerciales completas sin reemplazos ajenos al mensaje', () => {
    expect(check('buenas nesecito el presio y la ubicasion porfabor grasias').correctedText).toBe('buenas necesito el precio y la ubicación por favor gracias');
    expect(check('Nesesito alludar a escrivir un exelente mensaje porfavor').correctedText).toBe('Necesito ayudar a escribir un excelente mensaje por favor');
  });
  it('corrige el mensaje completo de la captura, incluidos los acentos del saludo', () => {
    const result = check('hoala como esta amido');
    expect(result.correctedText).toBe('hola cómo está amigo');
    expect(result.edits).toHaveLength(4);
  });
  it('recoge todos los errores y sus repeticiones, sin parar en la primera palabra', () => {
    const text = '👋 grasias, nesecito aser el pediod oy. grasias! RD$ 1250 https://aser.do';
    const result = check(text);
    expect(result.correctedText).toBe('👋 gracias, necesito hacer el pedido hoy. gracias! RD$ 1250 https://aser.do');
    expect(result.edits).toHaveLength(6);
    for (const edit of result.edits) expect(text.slice(edit.start,edit.end)).toBe(edit.word);
  });
  it('también revisa el final de un mensaje con más de cien palabras', () => {
    const text = 'hola '.repeat(110) + 'grasias por el pediod';
    expect(check(text).correctedText).toBe('hola '.repeat(110) + 'gracias por el pedido');
  });
  it('no convierte usos válidos de como y esta en preguntas', () => {
    expect(check('hola como esta fruta')).toBeNull();
    expect(check('como esta fruta')).toBeNull();
  });
  it.each([['aser','hacer'],['grasias','gracias'],['ubicasion','ubicación'],['delibery','delivery'],['nesecito','necesito']])('%s propone %s', (word, result) => {
    expect(check(`le podemos ${word} ahora`).replacement).toBe(result);
  });
  it.each([['hoala','hola'],['Hoala','Hola'],['hoala!','hola'],['hloa','hola'],['holaa','hola'],['presio','precio'],['salduos','saludos'],['gracais','gracias'],['pediod','pedido'],['enttega','entrega']])('elige una corrección útil para %s: %s', (text, replacement) => {
    expect(check(text)?.replacement).toBe(replacement);
  });
  it('no sustituye palabras válidas por saludos ni impone puntuación', () => {
    expect(check('La ola sube, hala la cuerda. Hola!')).toBeNull();
    const result = check('hoala! ¿cómo estás?');
    expect('hoala! ¿cómo estás?'.slice(result.end)).toBe('! ¿cómo estás?');
  });
  it('ordena todos los candidatos cercanos, independientemente del orden del diccionario', () => {
    for (const suggestions of [['predio','prasio','premio','precio'],['precio','premio','prasio','predio']]) {
      const review = createProofreader({correct:()=>false,suggest:()=>suggestions});
      expect(review('presio')?.replacement).toBe('precio');
    }
  });
  it('omite empates y propuestas demasiado alejadas en lugar de adivinar', () => {
    const review = createProofreader({correct:()=>false,suggest:()=>['casa','cosa']});
    expect(review('cusa')).toMatchObject({edits:[],correctedText:'cusa',uncertain:[{word:'cusa'}]});
    const distant = createProofreader({correct:()=>false,suggest:()=>['extraordinario']});
    expect(distant('xzy')).toMatchObject({edits:[],correctedText:'xzy',uncertain:[{word:'xzy'}]});
  });
  it('una preferencia comercial no desplaza a una corrección más cercana', () => {
    const review = createProofreader({correct:()=>false,suggest:()=>['saludos','saldo']});
    expect(review('saldoo')?.replacement).toBe('saldo');
  });
  it('conserva expresiones dominicanas, marcas y términos de delivery', () => {
    expect(check('Klk mi pana, un chin de chercha. El delivery va en motoconcho por Fulltech y WhatsApp.')).toBeNull();
  });
  it('no revisa enlaces, correos, menciones, códigos, precios ni nombres del cliente', () => {
    expect(check('https://aser.do/grasias hola@delibery.do @ubicasion FT2650 RD$ 2650 yonfre', {names:['Yonfre']})).toBeNull();
  });
  it('los índices siguen siendo correctos con emojis y acentos', () => {
    const text = '👋 Qué tal, grasias por escribir.';
    const result = check(text);
    expect(text.slice(result.start,result.end)).toBe('grasias');
    expect(text.slice(0,result.start)+result.replacement+text.slice(result.end)).toBe('👋 Qué tal, gracias por escribir.');
  });
  it('no insiste con palabras omitidas y no cambia palabras válidas ambiguas', () => {
    expect(check('aser delivery', {ignored:['aser']})).toBeNull();
    expect(check('El cliente iba a pagar.')).toBeNull();
  });
  it('limita mensajes largos y el coste de las revisiones repetidas', () => {
    expect(check('aser '.repeat(1000))).toBeNull();
    const start = performance.now();
    for (let i=0;i<100;i++) check('buenas, le podemos aser el delivery hoy');
    expect(performance.now()-start).toBeLessThan(1500);
  });
});

let dom;
afterEach(()=>{ dom?.window.close(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  dom = new JSDOM('<body data-tab="whatsapp" data-wa-view="chat"><button id="wa-actions" data-conversation="chat-1"></button><button id="wa-ai-reply" type="button"></button><p id="wa-chat-name">Ana Ruiz</p><div id="wa-composer"><textarea id="wa-text"></textarea><button id="wa-send" type="button">Enviar</button></div></body>',{url:'https://crm.test/admin/',runScripts:'outside-only'});
  const win = dom.window;
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
  const jobs = [];
  const warmups = [];
  let instance;
  class Worker {
    handlers = new Map();
    constructor(url) { this.url = url; instance = this; }
    addEventListener(type,callback) { this.handlers.set(type,callback); }
    postMessage(job) { (job.type === 'warmup' ? warmups : jobs).push(job); }
    terminate = vi.fn();
  }
  win.Worker = Worker;
  win.fetch = vi.fn();
  let sends = 0;
  const $ = (s) => win.document.querySelector(s);
  $('#wa-send').addEventListener('click',()=>sends++);
  win.eval(script);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const type = (text) => { $('#wa-text').value=text; $('#wa-text').dispatchEvent(new win.Event('input',{bubbles:true})); };
  const reply = (index=jobs.length-1, override) => {
    const job=jobs[index];
    instance.handlers.get('message')({data:override || {id:job.id,review:check(job.text,{names:job.names}),suggestion:check(job.text,{ignored:job.ignored,names:job.names})}});
  };
  const click = (s) => $(s).dispatchEvent(new win.MouseEvent('click',{bubbles:true}));
  return {win,$,type,reply,click,jobs,warmups,get worker(){return instance;},get sends(){return sends;}};
}
function chooseNotice(ui, label) {
  const button = [...ui.$('#wa-proofreading-confirm').querySelectorAll('button')].find(b=>b.textContent===label);
  expect(button).toBeTruthy();button.click();
}

describe('confirmación discreta antes de enviar',()=>{
  it('también avisa de palabras dudosas sin inventar una corrección ni ofrecer Corregir',async()=>{
    const ui=setup();ui.type('hoas');await vi.advanceTimersByTimeAsync(180);ui.reply();ui.click('#wa-send');
    expect(ui.sends).toBe(0);
    expect(ui.$('#wa-proofreading-confirm').textContent).toContain('faltas ortográficas');
    expect(ui.$('#wa-proofreading-confirm').textContent).not.toContain('Corregir');
    chooseNotice(ui,'Seguir editando');expect(ui.$('#wa-text').value).toBe('hoas');
  });
  it('aprovecha una revisión en curso sin duplicarla al enviar',async()=>{
    const ui=setup();ui.type('gracias por su pedido');await vi.advanceTimersByTimeAsync(180);
    ui.click('#wa-send');expect(ui.jobs).toHaveLength(1);ui.reply();
    expect(ui.sends).toBe(1);expect(ui.jobs).toHaveLength(1);
  });
  it('detiene el envío con errores y permite continuar una sola vez',async()=>{
    const ui=setup();ui.type('grasias por el pediod');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('#wa-send');ui.click('#wa-send');
    expect(ui.sends).toBe(0);expect(ui.$('#wa-proofreading-confirm').textContent).toContain('faltas ortográficas');
    expect(ui.win.document.querySelectorAll('#wa-proofreading-confirm')).toHaveLength(1);
    chooseNotice(ui,'Enviar así');expect(ui.sends).toBe(1);
    expect(ui.$('#wa-text').value).toBe('grasias por el pediod');expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
  it('Corregir aplica todo sin enviar y permite enviar después sin aviso si ya no hay errores',async()=>{
    const ui=setup();ui.type('hoala como esta amido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('#wa-send');chooseNotice(ui,'Corregir');
    expect(ui.$('#wa-text').value).toBe('hola cómo está amigo');expect(ui.sends).toBe(0);
    await vi.advanceTimersByTimeAsync(600);ui.reply();ui.click('#wa-send');expect(ui.sends).toBe(1);
    expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
  it('Seguir editando y Escape conservan el borrador y no envían',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('#wa-send');chooseNotice(ui,'Seguir editando');
    expect(ui.sends).toBe(0);expect(ui.$('#wa-text').value).toBe('grasias');
    expect(ui.win.document.activeElement).toBe(ui.$('#wa-text'));expect(ui.$('#wa-proofreading').hidden).toBe(false);
    ui.click('#wa-send');ui.win.document.dispatchEvent(new ui.win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    expect(ui.$('#wa-proofreading-confirm')).toBeNull();expect(ui.sends).toBe(0);
  });
  it('un mensaje revisado sin errores pasa sin aviso ni otra consulta',async()=>{
    const ui=setup();ui.type('gracias por su pedido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('#wa-send');expect(ui.sends).toBe(1);expect(ui.$('#wa-proofreading-confirm')).toBeNull();expect(ui.jobs).toHaveLength(1);
  });
  it('al enviar antes de la pausa adelanta la revisión y pregunta si hay errores',async()=>{
    const ui=setup();ui.type('grasias');ui.click('#wa-send');ui.click('#wa-send');
    expect(ui.jobs).toHaveLength(1);expect(ui.sends).toBe(0);
    ui.reply();expect(ui.$('#wa-proofreading-confirm').textContent).toContain('faltas ortográficas');
    expect(ui.sends).toBe(0);chooseNotice(ui,'Enviar así');expect(ui.sends).toBe(1);
  });
  it('reanuda una sola vez el envío solicitado si la revisión pendiente no encuentra errores',async()=>{
    const ui=setup();ui.type('gracias por su pedido');ui.click('#wa-send');ui.reply();
    expect(ui.sends).toBe(1);expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
  it('una revisión tardía no envía un borrador nuevo',async()=>{
    const ui=setup();ui.type('gracias');ui.click('#wa-send');ui.type('otro mensaje');ui.reply();
    expect(ui.sends).toBe(0);expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
  it('la confirmación anterior no puede enviar a otra conversación',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();ui.click('#wa-send');
    ui.$('#wa-actions').dataset.conversation='chat-2';chooseNotice(ui,'Enviar así');
    expect(ui.sends).toBe(0);expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
  it('omitir la ayuda no desactiva la confirmación al enviar',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();ui.click('[data-proofreading="dismiss"]');
    ui.type('grasias por escribir');await vi.advanceTimersByTimeAsync(600);ui.reply();expect(ui.$('#wa-proofreading').hidden).toBe(true);
    ui.click('#wa-send');expect(ui.sends).toBe(0);expect(ui.$('#wa-proofreading-confirm').textContent).toContain('faltas ortográficas');
  });
  it('Enter utiliza la misma confirmación que el botón',async()=>{
    const ui=setup();ui.$('#wa-text').addEventListener('keydown',event=>{if(event.key==='Enter')ui.$('#wa-send').click();});
    ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.$('#wa-text').dispatchEvent(new ui.win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(ui.sends).toBe(0);expect(ui.$('#wa-proofreading-confirm')).not.toBeNull();
  });
  it('una revisión lenta permite elegir sin congelar el campo ni enviar automáticamente',async()=>{
    const ui=setup();ui.type('grasias');ui.click('#wa-send');await vi.advanceTimersByTimeAsync(1500);
    expect(ui.$('#wa-proofreading-confirm').textContent).toContain('No se pudo completar');
    expect(ui.$('#wa-text').disabled).toBe(false);expect(ui.sends).toBe(0);
    chooseNotice(ui,'Enviar ahora');expect(ui.sends).toBe(1);ui.reply();
    expect(ui.sends).toBe(1);expect(ui.$('#wa-proofreading-confirm')).toBeNull();
  });
});

describe('sugerencia discreta dentro de la app',()=>{
  it('el botón de IA muestra la propuesta y solo la coloca en el borrador tras elegir Usar respuesta',async()=>{
    const ui=setup();ui.$('#wa-ai-reply').disabled=false;
    ui.win.fetch.mockResolvedValue({ok:true,json:async()=>({ok:true,ai:true,text:'Claro, con gusto te ayudo.'})});
    ui.click('#wa-ai-reply');await vi.waitFor(()=>expect(ui.$('#wa-ai-reply-result').textContent).toContain('Claro, con gusto te ayudo.'));
    expect(ui.$('#wa-ai-reply-result').textContent).toContain('Claro, con gusto te ayudo.');
    expect(ui.$('#wa-text').value).toBe('');expect(ui.sends).toBe(0);
    ui.click('#wa-ai-reply-result button');
    expect(ui.$('#wa-text').value).toBe('Claro, con gusto te ayudo.');expect(ui.sends).toBe(0);
  });
  it('consulta el apoyo solo ante dudas y presenta la frase completa sin etiquetas técnicas',async()=>{
    const ui=setup(),text='grasias hoas',corrected='gracias hola';
    ui.win.fetch.mockResolvedValue({ok:true,json:async()=>({suggestion:{start:0,end:text.length,word:text,replacement:corrected,edits:[{start:0,end:text.length,word:text,replacement:corrected}]}})});
    ui.type(text);await vi.advanceTimersByTimeAsync(180);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias hoas');
    await vi.advanceTimersByTimeAsync(899);expect(ui.win.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(ui.win.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ui.win.fetch.mock.calls[0][1].body)).toEqual({conversationId:'chat-1',text});
    expect(ui.$('.wa-proofreading__text').textContent).toBe(corrected);
    expect(ui.$('#wa-proofreading').textContent).not.toMatch(/DeepSeek|inteligencia|segura/);
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe(corrected);expect(ui.sends).toBe(0);
  });
  it('consulta el apoyo también si el diccionario local encontró correcciones',async()=>{
    const ui=setup();ui.type('hoas coo esta');await vi.advanceTimersByTimeAsync(180);ui.reply();
    await vi.advanceTimersByTimeAsync(2000);expect(ui.win.fetch).toHaveBeenCalledTimes(1);
  });
  it('cancela una consulta pendiente si cambia el borrador o se omite la ayuda',async()=>{
    const ui=setup();ui.type('grasias hoas');await vi.advanceTimersByTimeAsync(180);ui.reply();
    ui.click('[data-proofreading="dismiss"]');await vi.advanceTimersByTimeAsync(1000);expect(ui.win.fetch).not.toHaveBeenCalled();
    ui.type('coo');await vi.advanceTimersByTimeAsync(180);ui.reply();ui.type('hola');await vi.advanceTimersByTimeAsync(1000);
    expect(ui.win.fetch).not.toHaveBeenCalled();
  });
  it('una respuesta de apoyo antigua nunca reemplaza el mensaje nuevo',async()=>{
    const ui=setup();let resolve;
    ui.win.fetch.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    ui.type('hoas');await vi.advanceTimersByTimeAsync(180);ui.reply();await vi.advanceTimersByTimeAsync(900);
    ui.type('hola');resolve({ok:true,json:async()=>({suggestion:{edits:[{start:0,end:4,word:'hoas',replacement:'hola'}]}})});
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.$('#wa-proofreading')).toBeNull();expect(ui.$('#wa-text').value).toBe('hola');expect(ui.sends).toBe(0);
  });
  it('si el apoyo falla conserva las correcciones locales y no muestra el error',async()=>{
    const ui=setup();ui.win.fetch.mockRejectedValue(new Error('proveedor caído'));
    ui.type('grasias hoas');await vi.advanceTimersByTimeAsync(180);ui.reply();await vi.advanceTimersByTimeAsync(900);
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias hoas');
    expect(ui.$('#wa-proofreading').textContent).not.toMatch(/error|segura|proveedor/);expect(ui.sends).toBe(0);
  });
  it('muestra y acepta exactamente la frase de la última captura, sin enviar',async()=>{
    const ui=setup();ui.type('hoas coo esta');await vi.advanceTimersByTimeAsync(180);ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    expect(ui.$('.wa-proofreading__text').textContent).toBe('hola cómo está');
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe('hola cómo está');expect(ui.sends).toBe(0);
  });
  it('una palabra ambigua no muestra avisos técnicos y un fallo del apoyo es silencioso',async()=>{
    const ui=setup();ui.type('hoas');await vi.advanceTimersByTimeAsync(180);ui.reply();
    expect(ui.$('#wa-proofreading')).toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    expect(ui.win.fetch).toHaveBeenCalledTimes(1);
    expect(ui.$('#wa-proofreading')).toBeNull();expect(ui.$('#wa-text').value).toBe('hoas');expect(ui.sends).toBe(0);
  });
  it('precarga el diccionario antes de escribir y no vuelve a cargarlo con cada tecla',async()=>{
    const ui=setup();expect(ui.warmups).toHaveLength(1);expect(ui.jobs).toHaveLength(0);
    ui.type('grasias');await vi.advanceTimersByTimeAsync(180);ui.reply();
    ui.type('grasias por el pediod');await vi.advanceTimersByTimeAsync(180);ui.reply();
    expect(ui.warmups).toHaveLength(1);expect(ui.jobs).toHaveLength(2);
  });
  it('revisa al cabo de 120 ms y muestra todo el texto aunque solo haya un error',async()=>{
    const ui=setup();ui.type('gracias por escribir, podemos aser el delivery hoy');
    await vi.advanceTimersByTimeAsync(119);expect(ui.jobs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias por escribir, podemos hacer el delivery hoy');
    expect(ui.$('[data-proofreading="accept"]').textContent).toBe('Usar todo');
  });
  it('no aplaza indefinidamente la revisión al escribir continuamente',async()=>{
    const ui=setup();
    for(let i=0;i<6;i++){ui.type('grasias'+' '.repeat(i));await vi.advanceTimersByTimeAsync(100);}
    expect(ui.jobs).toHaveLength(1);expect(ui.jobs[0].text).toBe('grasias'+' '.repeat(5));
    ui.reply();expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias'+' '.repeat(5));
  });
  it('conserva saltos, datos y todo el texto en la vista previa de un mensaje largo',async()=>{
    const ui=setup();const text='Hola Ana Ruiz,\n'+'gracias por su mensaje. '.repeat(15)+'Podemos aser el delivery por RD$ 1250. https://aser.do';
    ui.type(text);await vi.advanceTimersByTimeAsync(180);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe(text.replace('aser el','hacer el'));
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe(text.replace('aser el','hacer el'));
  });
  it('no reinicia una revisión pendiente solo por volver a enfocar el mismo campo',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(100);ui.$('#wa-text').focus();
    await vi.advanceTimersByTimeAsync(80);expect(ui.jobs).toHaveLength(1);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias');
  });
  it('muestra el mensaje revisado y Usar todo aplica todas las correcciones sin enviar',async()=>{
    const ui=setup();ui.type('hoala como esta amido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('hola cómo está amigo');
    expect(ui.$('[data-proofreading="accept"]').textContent).toBe('Usar todo');
    ui.click('[data-proofreading="accept"]');
    expect(ui.$('#wa-text').value).toBe('hola cómo está amigo');expect(ui.sends).toBe(0);
    expect(ui.win.document.activeElement).toBe(ui.$('#wa-text'));
  });
  it('permanece al esperar, salir y volver al campo y refrescar el mismo chat',async()=>{
    const ui=setup();ui.type('hoala como esta amido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.$('#wa-text').focus();ui.$('#wa-text').blur();ui.$('#wa-text').focus();
    ui.$('#wa-actions').dataset.conversation='chat-1';
    await vi.advanceTimersByTimeAsync(60000);
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    expect(ui.$('[data-proofreading="accept"]').disabled).toBe(false);
    expect(ui.jobs).toHaveLength(1);
  });
  it('conserva la fila mientras revisa cambios y no aplica una propuesta antigua',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.type('grasias por el pediod');
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    expect(ui.$('[data-proofreading="accept"]').disabled).toBe(true);
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe('grasias por el pediod');
    await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias por el pedido');
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe('gracias por el pedido');
  });
  it('mantiene la sugerencia si se reconstruye el compositor con el mismo borrador',async()=>{
    const ui=setup();ui.type('hoala como esta amido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.$('#wa-composer').innerHTML='<textarea id="wa-text">hoala como esta amido</textarea><button id="wa-send">Enviar</button>';
    await Promise.resolve();
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    ui.click('[data-proofreading="accept"]');expect(ui.$('#wa-text').value).toBe('hola cómo está amigo');
  });
  it('Omitir retira la propuesta completa y una respuesta pendiente no la restaura',async()=>{
    const ui=setup();ui.type('hoala como esta amido');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.type('hoala como esta amido!');await vi.advanceTimersByTimeAsync(600);
    ui.click('[data-proofreading="dismiss"]');ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(true);
    expect(ui.$('#wa-text').value).toBe('hoala como esta amido!');
    ui.type('hoala como esta amido!');await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(true);
  });
  it('borra la sugerencia al vaciar el campo o corregir manualmente los errores',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.type('');expect(ui.$('#wa-proofreading').hidden).toBe(true);
    ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.type('gracias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(true);
  });
  it('no retira la sugerencia por pulsar Enviar si el mensaje permanece en el campo',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('#wa-send');await vi.advanceTimersByTimeAsync(10);
    [...ui.$('#wa-proofreading-confirm').querySelectorAll('button')].find(b=>b.textContent==='Seguir editando').click();
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    expect(ui.$('#wa-text').value).toBe('grasias');
  });
  it('ofrece hola para el caso reportado y conserva la puntuación al aceptar',async()=>{
    const ui=setup();ui.type('hoala!');await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('hola!');
    ui.click('[data-proofreading="accept"]');
    expect(ui.$('#wa-text').value).toBe('hola!');expect(ui.sends).toBe(0);
  });
  it('se carga tras una pausa y acepta solo la palabra, sin enviar',async()=>{
    const ui=setup(); ui.type('le podemos aser el delivery hoy');
    await vi.advanceTimersByTimeAsync(119); expect(ui.jobs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(false);
    expect(ui.$('.wa-proofreading__text').textContent).toBe('le podemos hacer el delivery hoy');
    ui.$('#wa-text').setSelectionRange(30,30);
    ui.click('[data-proofreading="accept"]');
    expect(ui.$('#wa-text').value).toBe('le podemos hacer el delivery hoy');
    expect(ui.win.document.activeElement).toBe(ui.$('#wa-text'));
    expect(ui.sends).toBe(0); expect(ui.win.fetch).not.toHaveBeenCalled();
  });
  it('Omitir conserva el texto y evita repetir la misma sugerencia',async()=>{
    const ui=setup();ui.type('grasias por escribir');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.click('[data-proofreading="dismiss"]');
    expect(ui.$('#wa-text').value).toBe('grasias por escribir');
    await vi.advanceTimersByTimeAsync(600);
    expect(ui.jobs).toHaveLength(1);
    ui.type('grasias por escribir de nuevo');await vi.advanceTimersByTimeAsync(600);ui.reply();
    expect(ui.$('#wa-proofreading').hidden).toBe(true);expect(ui.sends).toBe(0);
  });
  it('descarta respuestas antiguas mientras continúa escribiendo',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);
    ui.type('gracias por todo');await vi.advanceTimersByTimeAsync(600);
    expect(ui.jobs).toHaveLength(1);ui.reply(0);
    expect(ui.jobs).toHaveLength(2);ui.reply(1);
    expect(ui.$('#wa-proofreading')?.hidden ?? true).toBe(true);
  });
  it('revisa también un segundo borrador después de terminar el primero',async()=>{
    const ui=setup();
    ui.type('grasias por el pedido');await vi.advanceTimersByTimeAsync(120);ui.reply();
    expect(ui.$('.wa-proofreading__text').textContent).toBe('gracias por el pedido');
    ui.type('');
    ui.type('nesecito aser otro pedido');await vi.advanceTimersByTimeAsync(120);ui.reply();
    expect(ui.jobs).toHaveLength(2);
    expect(ui.$('.wa-proofreading__text').textContent).toBe('necesito hacer otro pedido');
  });
  it('no aplica una corrección al borrador de otra conversación',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);ui.reply();
    ui.$('#wa-actions').dataset.conversation='chat-2';
    ui.click('[data-proofreading="accept"]');
    expect(ui.$('#wa-text').value).toBe('grasias');expect(ui.sends).toBe(0);
  });
  it('respeta composición del teclado y retira la sugerencia al enviar',async()=>{
    const ui=setup();ui.$('#wa-text').dispatchEvent(new ui.win.Event('compositionstart',{bubbles:true}));
    ui.type('grasias');await vi.advanceTimersByTimeAsync(900);expect(ui.jobs).toHaveLength(0);
    ui.$('#wa-text').dispatchEvent(new ui.win.Event('compositionend',{bubbles:true}));
    await vi.advanceTimersByTimeAsync(600);ui.reply();ui.click('#wa-send');
    [...ui.$('#wa-proofreading-confirm').querySelectorAll('button')].find(b=>b.textContent==='Enviar así').click();ui.type('');
    expect(ui.$('#wa-proofreading').hidden).toBe(true);expect(ui.sends).toBe(1);
  });
  it('un fallo o timeout no bloquea el campo ni el envío',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(8600);
    expect(ui.worker.terminate).toHaveBeenCalled();expect(ui.$('#wa-text').disabled).toBe(false);
    ui.click('#wa-send');
    [...ui.$('#wa-proofreading-confirm').querySelectorAll('button')].find(b=>b.textContent==='Enviar ahora').click();
    expect(ui.sends).toBe(1);
  });
  it('descarta la revisión cuando la sesión deja de mostrar la app',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);
    const app = ui.win.document.createElement('main');app.id='app';app.hidden=true;ui.win.document.body.append(app);
    ui.reply();
    expect(ui.$('#wa-proofreading')).toBeNull();expect(ui.$('#wa-text').value).toBe('grasias');
  });
  it('el contenido se presenta como texto, nunca como HTML',async()=>{
    const ui=setup();ui.type('grasias');await vi.advanceTimersByTimeAsync(600);
    ui.reply(0,{id:ui.jobs[0].id,suggestion:{start:0,end:7,word:'grasias',replacement:'<img src=x onerror=alert(1)>'}});
    expect(ui.$('#wa-proofreading img')).toBeNull();expect(ui.$('#wa-proofreading').textContent).toContain('<img');
  });
});
