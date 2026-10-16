/* Voz de WhatsApp. Sesión multimedia en memoria; jamás se guarda en el modo offline. */
(() => {
  'use strict';
  const finalStates = new Set(['completed', 'failed', 'rejected', 'missed']);
  const labels = { starting: 'Iniciando llamada…', ringing: 'Llamando…', connecting: 'Conectando audio…',
    active: 'Llamada en curso', completed: 'Llamada finalizada', failed: 'La llamada falló', rejected: 'Llamada rechazada', missed: 'Llamada perdida' };
  const errors = {
    calling_disabled: 'Las llamadas aún no están habilitadas en este servidor.',
    call_permission_required: 'El cliente debe permitir las llamadas en WhatsApp.',
    permission_requires_open_window: 'Pide al cliente que escriba por WhatsApp para abrir la conversación y poder solicitarle permiso.',
    call_permission_template_unavailable: 'Meta todavía no aprobó la plantilla de permiso. Pide al cliente que escriba por WhatsApp y vuelve a solicitarlo.',
    permission_request_limit: 'Ya se solicitó permiso o Meta no permite otra solicitud por ahora.',
    do_not_contact: 'Este cliente pidió no recibir contacto.', call_busy: 'El agente o la conversación ya tiene otra llamada.',
    call_owned_by_other_agent: 'Otro agente está atendiendo esta llamada.',
    meta_calling_unconfirmed: 'Meta todavía no confirmó la operación. Revisa su estado antes de volver a llamar.',
    meta_calling_error: 'Meta rechazó la operación. Revisa la configuración y el permiso del cliente.',
    connection_failed: 'No se pudo conectar el audio. Revisa tu red y vuelve a intentarlo.',
    network: 'No hay conexión con el CRM. No se ha confirmado la operación.',
  };
  let context = null, current = null, pc = null, stream = null, audio = null;
  let config = null, busy = false, muted = false, polling = false, lastHeartbeat = 0, applying = false;
  let incoming = [], selectedConversation = null;
  let audioGeneration = 0;
  const button = document.getElementById('wa-calling-button');
  const dialog = document.getElementById('wa-calling-dialog');
  const dock = document.getElementById('wa-calling-dock');
  if (!button || !dialog || !dock) return;
  const $ = (id) => document.getElementById(id);
  const base = (id) => `/api/admin/conversations/${encodeURIComponent(id)}/calling`;
  async function request(url, body) {
    let response;
    try {
      response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw Object.assign(new Error(errors.network), { code: 'network' }); }
    let data;
    try { data = await response.json(); } catch { throw new Error(errors.network); }
    if (!response.ok || !data.ok) {
      if (response.status === 401) resetSession();
      throw Object.assign(new Error(errors[data.error] || `No se pudo completar la llamada${data.code ? ` (Meta ${data.code})` : ''}.`), { code: data.error, data });
    }
    return data;
  }
  const note = (text) => { $('wa-calling-notice').textContent = text; };
  function cleanup() {
    audioGeneration++;
    if (pc) { pc.onconnectionstatechange = null; pc.close(); }
    stream?.getTracks().forEach((t) => t.stop());
    if (audio) { audio.pause(); audio.srcObject = null; }
    pc = null; stream = null; audio = null; muted = false;
  }
  function resetSession() {
    cleanup(); current = null; context = null; incoming = []; selectedConversation = null; config = null;
    button.hidden = true; dialog.close(); render();
    $('wa-calling-history').replaceChildren(); note('');
  }
  function render() {
    const live = current && !finalStates.has(current.status);
    $('wa-calling-status').textContent = current ? `${current.customerName || 'Cliente'} · ${labels[current.status] || 'Actualizando…'}` : 'Llamadas de WhatsApp';
    $('wa-calling-hangup').hidden = !live;
    $('wa-calling-mute').hidden = !live || !stream;
    $('wa-calling-mute').textContent = muted ? 'Activar micrófono' : 'Silenciar';
    $('wa-calling-mute').setAttribute('aria-pressed', String(muted));
    $('wa-calling-connect').disabled = busy || Boolean(live) || !selectedConversation;
    $('wa-calling-permission').disabled = busy || Boolean(live) || !selectedConversation;
    button.disabled = !context || busy;
    dock.hidden = !live && !incoming.length;
    dock.textContent = live ? labels[current.status] || 'Llamada de WhatsApp' : `Llamada entrante de ${incoming[0]?.customerName || 'cliente'}`;
    const list = $('wa-calling-incoming');
    list.replaceChildren();
    for (const call of incoming) {
      const row = document.createElement('div'); row.className = 'calling__incoming';
      const name = document.createElement('span'); name.textContent = call.customerName || 'Cliente'; row.append(name);
      for (const [label, action] of [['Contestar', 'answer'], ['Rechazar', 'reject']]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn--ghost'; b.textContent = label;
        b.disabled = busy || Boolean(live); b.addEventListener('click', () => run(() => action === 'answer' ? answer(call) : reject(call))); row.append(b);
      }
      list.append(row);
    }
  }
  async function run(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (e) { note(e.message || 'No se pudo completar la llamada.'); }
    finally { busy = false; render(); }
  }
  async function iceComplete(peer) {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', changed); reject(new Error('No se pudo preparar el audio. Revisa tu red.')); }, 10000);
      function changed() { if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', changed); resolve(); } }
      peer.addEventListener('icegatheringstatechange', changed);
    });
  }
  async function prepareAudio(offer) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Para llamar, abre el CRM con HTTPS en un navegador con micrófono.');
    cleanup();
    const generation = audioGeneration;
    let microphoneTimeout;
    try {
      note('Preparando audio. Permite el micrófono si el navegador lo solicita.');
      if (navigator.permissions?.query) {
        // Diagnóstico auxiliar: no debe detener la captura si el navegador
        // demora o no implementa la consulta de permisos.
        navigator.permissions.query({ name: 'microphone' }).then((permission) => {
          if (generation !== audioGeneration || stream || pc) return;
          if (permission.state === 'granted') note('Micrófono autorizado. Abriendo audio…');
          if (permission.state === 'denied') note('Chrome bloqueó el micrófono. Permítelo en los ajustes de este sitio y vuelve a llamar.');
        }).catch(() => {});
      }
      const microphone = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }).then((media) => {
        if (generation !== audioGeneration) { media.getTracks().forEach((t) => t.stop()); throw new Error('Preparación de audio cancelada.'); }
        return media;
      });
      stream = await Promise.race([microphone, new Promise((_, reject) => {
        microphoneTimeout = setTimeout(() => reject(new Error('No se recibió permiso de micrófono. Revísalo en Chrome y vuelve a llamar.')), 30000);
      })]);
      clearTimeout(microphoneTimeout);
      note('Preparando conexión de audio…');
      pc = new RTCPeerConnection({ iceServers: config?.iceServers ?? [] });
      const peer = pc;
      audio = new Audio(); audio.autoplay = true;
      pc.ontrack = (event) => { audio.srcObject = event.streams[0] || new MediaStream([event.track]); audio.play().catch(() => note('Pulsa «Reproducir audio» para escuchar al cliente.')); };
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const transceiver = pc.getTransceivers()[0];
      const codecs = window.RTCRtpSender?.getCapabilities?.('audio')?.codecs?.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
      if (codecs?.length && transceiver?.setCodecPreferences) transceiver.setCodecPreferences(codecs);
      if (offer) await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(offer ? await pc.createAnswer() : await pc.createOffer());
      await iceComplete(pc);
      pc.onconnectionstatechange = () => {
        if (peer !== pc) return;
        if (pc.connectionState === 'failed') { note(errors.connection_failed); hangup().catch(() => cleanup()); }
        if (pc.connectionState === 'connected') note('Audio conectado.');
      };
      return pc.localDescription.sdp;
    } catch (e) {
      clearTimeout(microphoneTimeout);
      cleanup();
      if (e.name === 'NotAllowedError') throw new Error('Permite el micrófono en el navegador para llamar.');
      if (e.name === 'NotFoundError') throw new Error('Conecta un micrófono para llamar.');
      throw e;
    }
  }
  async function open() {
    selectedConversation = context?.id ?? current?.conversationId ?? null;
    if (!dialog.open) dialog.showModal(); note(''); render();
    if (selectedConversation) await refreshHistory();
  }
  async function refreshHistory() {
    note('');
    const conversationId = selectedConversation;
    if (!conversationId) return;
    const data = await request(base(conversationId));
    if (conversationId !== selectedConversation) return;
    const list = $('wa-calling-history'); list.replaceChildren();
    for (const call of data.calls ?? []) {
      const row = document.createElement('p');
      row.textContent = `${call.direction === 'inbound' ? 'Entrante' : 'Saliente'} · ${labels[call.status] || call.status} · ${new Date(call.createdAt).toLocaleString('es')}${call.duration ? ` · ${call.duration} s` : ''}`;
      list.append(row);
    }
    if (!data.calls?.length) list.textContent = 'Todavía no hay llamadas en esta conversación.';
    const p = await request(`${base(conversationId)}/permission-state`);
    $('wa-calling-permission-status').textContent = p.permission.canCall ? 'El cliente permite llamadas.' : 'Falta permiso del cliente o Meta restringe la llamada.';
  }
  async function connect() {
    const conversationId = selectedConversation;
    if (!conversationId || (current && !finalStates.has(current.status))) return;
    const permission = await request(`${base(conversationId)}/permission-state`);
    if (!permission.permission.canCall) throw new Error(errors.call_permission_required);
    const sdp = await prepareAudio();
    const requestId = crypto.randomUUID();
    try {
      let data;
      try { data = await request(`${base(conversationId)}/connect`, { sdp, requestId }); }
      catch (e) {
        if (e.code !== 'network') throw e;
        // Mismo id de operación: un reintento jamás genera otra llamada.
        data = await request(`${base(conversationId)}/connect`, { sdp, requestId });
      }
      current = data.call; lastHeartbeat = 0; note('Esperando respuesta del cliente…');
    } catch (e) {
      if (e.data?.call) { current = e.data.call; note(e.message); }
      else cleanup();
      throw e;
    }
  }
  async function answer(call) {
    current = call;
    try {
      const data = await request(`${base(call.conversationId)}/state?id=${encodeURIComponent(call.id)}`);
      if (!data.call.remoteSession || data.call.remoteSession.type !== 'offer') throw new Error('La llamada ya terminó o su sesión de audio caducó.');
      const sdp = await prepareAudio(data.call.remoteSession);
      current = (await request(`${base(call.conversationId)}/pre_accept`, { id: call.id, sdp })).call;
      // La respuesta se construye desde la oferta real; no se inventa ni modifica SDP.
      current = (await request(`${base(call.conversationId)}/accept`, { id: call.id, sdp })).call;
      lastHeartbeat = 0; note('Llamada aceptada. Conectando audio…');
    } catch (e) { cleanup(); current = null; throw e; }
  }
  async function reject(call) {
    await request(`${base(call.conversationId)}/reject`, { id: call.id });
    incoming = incoming.filter((c) => c.id !== call.id);
  }
  async function hangup() {
    if (!current || finalStates.has(current.status)) { cleanup(); return; }
    const call = current;
    cleanup();
    const result = await request(`${base(call.conversationId)}/terminate`, { id: call.id });
    current = result.call; note('Llamada finalizada.'); render();
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const data = await request('/api/admin/calling/incoming');
      config ??= await request('/api/admin/calling/config');
      button.hidden = !data.enabled;
      incoming = data.calls ?? [];
      if (current && !finalStates.has(current.status)) {
        const call = current;
        const state = await request(`${base(call.conversationId)}/state?id=${encodeURIComponent(call.id)}`);
        if (current?.id !== call.id) return;
        current = state.call;
        if (finalStates.has(current.status)) { cleanup(); note(labels[current.status]); }
        else {
          if (current.remoteSession?.type === 'answer' && pc && !pc.currentRemoteDescription && !applying) {
            applying = true;
            try { await pc.setRemoteDescription(current.remoteSession); } finally { applying = false; }
          }
          if (Date.now() - lastHeartbeat > 5000) {
            await request(`${base(call.conversationId)}/heartbeat`, { id: call.id }); lastHeartbeat = Date.now();
          }
        }
      }
      render();
    } catch (e) { if (current && !finalStates.has(current.status)) note(e.message); }
    finally { polling = false; }
  }
  window.addEventListener('phyto:calling-context', (e) => { context = e.detail; render(); });
  window.addEventListener('phyto:calling-logout', resetSession);
  button.addEventListener('click', () => run(open));
  dock.addEventListener('click', () => run(open));
  $('wa-calling-close').addEventListener('click', () => dialog.close());
  $('wa-calling-connect').addEventListener('click', () => run(connect));
  $('wa-calling-permission').addEventListener('click', () => run(async () => {
    if (!selectedConversation) return;
    await request(`${base(selectedConversation)}/permission`, {});
    note('Solicitud enviada. El cliente debe aceptarla en WhatsApp antes de llamar.');
  }));
  $('wa-calling-hangup').addEventListener('click', () => run(hangup));
  $('wa-calling-mute').addEventListener('click', () => { muted = !muted; stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; }); render(); });
  $('wa-calling-play').addEventListener('click', () => audio?.play().catch(() => note('Revisa el dispositivo de salida de audio.')));
  $('wa-calling-refresh').addEventListener('click', () => run(refreshHistory));
  window.addEventListener('pagehide', () => {
    if (current && !finalStates.has(current.status)) fetch(`${base(current.conversationId)}/terminate`, {
      method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: current.id }),
    }).catch(() => {});
    cleanup();
  });
  setInterval(poll, 2000);
  poll();
})();
