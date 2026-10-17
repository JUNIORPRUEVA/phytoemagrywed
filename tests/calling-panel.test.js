// @vitest-environment node
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/admin/calling.js', import.meta.url), 'utf8');
const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
let dom, w, sent, track, peer, permission, calls, interval;
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)); };
beforeEach(async () => {
  dom = new JSDOM(html, { url: 'https://crm.example/admin/', runScripts: 'outside-only' }); w = dom.window;
  sent = []; permission = true; calls = [];
  track = { stop: vi.fn(), enabled: true };
  Object.defineProperty(w, 'isSecureContext', { value: true });
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) } });
  w.crypto.randomUUID = () => '12345678-1234-1234-1234-123456789012';
  w.AbortSignal.timeout = () => undefined;
  w.Audio = class { pause() {} play() { return Promise.resolve(); } };
  w.RTCPeerConnection = class {
    constructor() { peer = this; this.iceGatheringState = 'complete'; }
    addTrack() {} getTransceivers() { return []; }
    async createOffer() { return { type: 'offer', sdp: SDP }; }
    async createAnswer() { return { type: 'answer', sdp: SDP }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.currentRemoteDescription = d; }
    close() { this.closed = true; }
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.setInterval = (fn) => { interval = fn; return 1; };
  w.fetch = vi.fn(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null; sent.push({ url, body });
    let data = { ok: true };
    if (url.endsWith('/incoming')) data = { ok: true, enabled: true, calls };
    else if (url.endsWith('/config')) data = { ok: true, enabled: true, iceServers: [] };
    else if (url.endsWith('/permission-state')) data = { ok: true, permission: { canCall: permission } };
    else if (url.endsWith('/connect')) data = { ok: true, call: { id: 'call1', conversationId: 'conv1', status: 'starting', customerName: 'Cliente' } };
    else if (url.includes('/state?')) data = { ok: true, call: { id: 'call1', conversationId: 'conv1', status: 'connecting', remoteSession: { type: 'answer', sdp: SDP } } };
    else if (url.endsWith('/terminate')) data = { ok: true, call: { id: 'call1', conversationId: 'conv1', status: 'completed' } };
    else if (url.endsWith('/calling')) data = { ok: true, enabled: true, calls: [] };
    return { ok: true, status: 200, json: async () => data };
  });
  w.eval(script); await flush();
  w.dispatchEvent(new w.CustomEvent('phyto:calling-context', { detail: { id: 'conv1' } }));
});
afterEach(() => dom.window.close());

it('no solicita micrófono ni inicia llamadas automáticamente al cargar', () => {
  expect(w.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(sent.some((r) => r.body)).toBe(false);
  expect(w.document.getElementById('wa-calling-button').disabled).toBe(false);
});

it('sin permiso no captura audio ni llama a Meta', async () => {
  permission = false;
  w.document.getElementById('wa-calling-button').click(); await flush();
  w.document.getElementById('wa-calling-connect').click(); await flush();
  expect(w.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(sent.some((r) => r.url.endsWith('/connect'))).toBe(false);
  expect(w.document.getElementById('wa-calling-notice').textContent).toContain('permitir');
});

it('conecta con una oferta real, aplica la respuesta remota y libera el micrófono al colgar', async () => {
  w.document.getElementById('wa-calling-button').click(); await flush();
  w.document.getElementById('wa-calling-connect').click(); await flush();
  expect(sent.find((r) => r.url.endsWith('/connect')).body.sdp).toBe(SDP);
  await interval(); await flush();
  expect(peer.currentRemoteDescription).toEqual({ type: 'answer', sdp: SDP });
  w.document.getElementById('wa-calling-mute').click(); expect(track.enabled).toBe(false);
  const activePeer = peer;
  w.document.getElementById('wa-calling-hangup').click(); await flush();
  expect(activePeer.closed).toBe(true); expect(track.stop).toHaveBeenCalled();
  expect(sent.filter((r) => r.url.endsWith('/connect'))).toHaveLength(1);
  expect(sent.find((r) => r.url.endsWith('/terminate')).body.id).toBe('call1');
});

it('los nombres de llamadas entrantes se muestran como texto, sin interpretar HTML', async () => {
  calls = [{ id: 'in1', conversationId: 'conv1', customerName: '<img src=x onerror=alert(1)>' }];
  await interval(); await flush();
  const list = w.document.getElementById('wa-calling-incoming');
  expect(list.querySelector('img')).toBeNull();
  expect(list.textContent).toContain('<img src=x');
  expect(list.textContent).toContain('Contestar');
});

it('al cerrar sesión libera el audio y borra el historial visible', async () => {
  w.document.getElementById('wa-calling-button').click(); await flush();
  w.document.getElementById('wa-calling-connect').click(); await flush();
  w.document.getElementById('wa-calling-history').textContent = 'historial privado';
  w.dispatchEvent(new w.CustomEvent('phyto:calling-logout'));
  expect(track.stop).toHaveBeenCalled();
  expect(w.document.getElementById('wa-calling-dock').hidden).toBe(true);
  expect(w.document.getElementById('wa-calling-history').textContent).toBe('');
});

it('recibe una llamada, contesta con la oferta del cliente y permite colgar sin pedir permiso saliente', async () => {
  const incomingCall = { id: 'in1', conversationId: 'conv1', customerName: 'Cliente entrante', direction: 'inbound', status: 'ringing' };
  calls = [incomingCall];
  const originalFetch = w.fetch.getMockImplementation();
  w.fetch.mockImplementation(async (url, options) => {
    if (url.includes('/state?')) return { ok: true, status: 200, json: async () => ({ ok: true, call: { ...incomingCall, remoteSession: { type: 'offer', sdp: SDP } } }) };
    if (url.endsWith('/pre_accept') || url.endsWith('/accept')) {
      sent.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, call: { ...incomingCall, status: 'active' } }) };
    }
    return originalFetch(url, options);
  });
  await interval(); await flush();
  expect(w.document.getElementById('wa-calling-dock').textContent).toContain('Cliente entrante');
  w.document.querySelector('#wa-calling-incoming button').click(); await flush();
  expect(peer.currentRemoteDescription).toEqual({ type: 'offer', sdp: SDP });
  expect(sent.filter((r) => r.body).map((r) => r.url.split('/').at(-1))).toEqual(['pre_accept', 'accept']);
  expect(sent.find((r) => r.url.endsWith('/accept')).body).toEqual({ id: 'in1', sdp: SDP });
  expect(sent.some((r) => r.url.endsWith('/permission-state'))).toBe(false);
  w.document.getElementById('wa-calling-hangup').click(); await flush();
  expect(sent.find((r) => r.url.endsWith('/terminate')).body.id).toBe('in1');
  expect(track.stop).toHaveBeenCalled();
});

it('muestra las imágenes dentro del encabezado en orden buscar y llamar',()=>{
  const head=w.document.querySelector('.wa__chat-head');
  const controls=[...head.children].filter(node=>['wa-thread-search-open','wa-calling-button'].includes(node.id));
  expect(controls.map(node=>node.id)).toEqual(['wa-thread-search-open','wa-calling-button']);
  expect(controls[0].querySelector('img').getAttribute('src')).toBe('/admin/assets/icons/chat-search.png');
  expect(controls[1].querySelector('img').getAttribute('src')).toBe('/admin/assets/icons/chat-call.png');
  expect(controls[1].hidden).toBe(false);
});
it('mantiene visible el teléfono sin habilitar llamadas cuando el servicio no está disponible',async()=>{
  w.fetch.mockImplementation(async()=>({ok:true,status:200,json:async()=>({ok:true,enabled:false,calls:[]})}));
  await interval();await flush();
  const button=w.document.getElementById('wa-calling-button');
  expect(button.hidden).toBe(false);expect(button.disabled).toBe(true);expect(button.querySelector('img')).toBeTruthy();
  button.click();await flush();expect(w.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
