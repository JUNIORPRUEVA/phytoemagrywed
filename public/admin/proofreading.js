/* Revisión local en Worker. Cada envío conserva la decisión explícita del usuario. */
(() => {
  'use strict';
  let worker, timer, maxTimer, watchdog, inFlight, pending, version = 0;
  const REVIEW_DELAY = 120;
  const MAX_WAIT = 600;
  function clearScheduled() { clearTimeout(timer); clearTimeout(maxTimer); maxTimer = null; }
  let composing = false;
  let composingAt = 0;
  let context = '';
  let ignored = new Set();
  let shown;
  let unavailable = false;
  let retryAt = 0;
  let lastReview, sendAttempt, sendTimer, bypass;
  /*
   * CONTROL DE LA IA — UNA SOLA PETICIÓN EN VUELO, SIEMPRE LA ÚLTIMA.
   *
   * Antes cada tecla abortaba la consulta en curso y empezaba otra: escribiendo
   * seguido no llegaba NUNCA ninguna sugerencia (medido: 12 s escribiendo → 1
   * sola petición). Ahora se mantiene una única petición viva; si el texto
   * cambió mientras viajaba, su resultado se descarta y se consulta el borrador
   * más reciente en cuanto termina. Sin duplicados, sin avalancha y sin quedarse
   * mudo cuando la persona escribe rápido.
   */
  let aiTimer, aiTimeout, aiAbort, aiTimerDue = 0, aiAllowShort = false;
  let aiWanted = null;      // último borrador que quiere revisión
  let aiRunning = false;    // hay una petición en curso
  let aiRunningKey = '';
  const aiCache = new Map();
  /* Diagnóstico seguro (sin textos, sin claves): visible en la consola. */
  const diag = { requests: 0, applied: 0, discarded: 0, errors: 0, timeouts: 0, lastStatus: 0, lastLatencyMs: 0, lastEvent: 'idle' };
  const note = (event) => { diag.lastEvent = event; };
  const area = () => document.querySelector('#wa-text');
  /**
   * CONVERSACIÓN ACTIVA.
   *
   * Antes se leía solo de `#wa-actions[data-conversation]`. En el panel real ese
   * elemento puede no existir (el encabezado del chat cambió), así que se enviaba
   * `conversationId: ""`, el servidor contestaba 403 y la IA nunca respondía:
   * era el «la IA se apaga» que reportó el equipo. Ahora se resuelve con la
   * primera fuente disponible, incluida la fila activa de la lista.
   */
  function conversation() {
    const desdeAcciones = document.querySelector('#wa-actions')?.dataset.conversation;
    if (desdeAcciones) return desdeAcciones;
    const fila = document.querySelector('.conv--active[data-conv], [data-conv][aria-current="true"], #wa-conversations [data-conv].conv--active');
    const desdeLista = fila?.dataset.conv;
    if (desdeLista) return desdeLista;
    return document.querySelector('#wa-chat-pane')?.dataset.conversation || '';
  }
  function sameDraft(job) {
    return job && job.area === area() && job.area.isConnected && job.text === job.area.value && job.context === conversation() && document.body.dataset.tab === 'whatsapp' && document.body.dataset.waView !== 'list' && !document.querySelector('#app')?.hidden;
  }
  /**
   * ¿SE ESTÁ COMPONIENDO TEXTO (teclado con autocorrección)?
   *
   * El aviso de `compositionend` puede NO llegar (la app pasa a segundo plano, se
   * cierra el teclado): con la bandera puesta el corrector quedaba mudo hasta
   * recargar. Por eso manda `event.isComposing` de cada `input` y, como red de
   * seguridad, la composición caduca sola a los 2,5 s sin noticias.
   */
  const composingNow = () => composing && Date.now() - composingAt < 2500;
  function cancelAI() {
    clearTimeout(aiTimer); clearTimeout(aiTimeout);
    aiTimer = null; aiTimerDue = 0;
    aiWanted = null;
    aiAbort?.abort(); aiAbort = null;
    note('cancelled');
  }
  function aiKey(job) { return JSON.stringify([job.context, job.text, [...ignored]]); }

  /** Borrador actual listo para consultar a la IA (o null si no procede). */
  function currentDraft() {
    const input = area();
    if (!input || input.disabled || composingNow()) return null;
    if (!input.value.trim() || input.value.length > 4000) return null;
    const job = { id: version, area: input, text: input.value, context: conversation() };
    return isCurrent(job) ? job : null;
  }

  /**
   * Programa UNA consulta. La espera NO se reinicia con cada tecla (si ya hay
   * una en curso, se respeta) y, al vencer, revisa el texto que hay EN ESE
   * MOMENTO. Antes el temporizador se reiniciaba con cada pulsación y además
   * cerraba sobre un texto ya viejo: escribiendo seguido no llegaba ninguna
   * consulta (medido: 101 pulsaciones → 1 petición).
   */
  function scheduleAI(delay, allowShort = false) {
    if (aiRunning) return;
    /* Solo las dudas del diccionario justifican consultar frases de una o dos
       palabras; sin ellas se exige un texto con más contenido. */
    aiAllowShort = allowShort;
    const due = Date.now() + delay;
    /* Si ya hay una espera en curso solo se ADELANTA: nunca se retrasa con
       cada tecla (eso era lo que dejaba al corrector sin consultar nunca). */
    if (aiTimer) {
      if (due >= aiTimerDue) return;
      clearTimeout(aiTimer);
    }
    aiTimerDue = due;
    aiTimer = setTimeout(() => {
      aiTimer = null; aiTimerDue = 0;
      const draft = currentDraft();
      if (!draft) return;
      if (!aiAllowShort && draft.text.trim().split(/\s+/).filter(Boolean).length < 3) return;
      aiWanted = draft;
      runAI();
    }, delay);
  }

  /** Aplica una respuesta de la IA solo si sigue siendo el borrador actual. */
  function applyAIResult(job, result) {
    if (!isCurrent(job)) { diag.discarded += 1; note('stale_result'); return; }
    if (!result?.edits?.length) { note('no_suggestion'); return; }
    diag.applied += 1;
    lastReview = { job, suggestion: result };
    renderSuggestion(job, result);
    if (sendAttempt && sameDraft(sendAttempt)) showSendNotice('errors', result);
  }

  /** Una petición cada vez; si el texto cambia mientras viaja, se repite luego. */
  async function runAI() {
    if (aiRunning) return; // el bucle recogerá lo que haya pendiente
    aiRunning = true;
    let next = null;
    try {
      while (aiWanted) {
        const queued = aiWanted;
        aiWanted = null;
        // Si el texto cambió mientras esperaba turno, se revisa el de ahora.
        const job = isCurrent(queued) ? queued : currentDraft();
        if (!job) { diag.discarded += 1; note('stale_before_request'); continue; }
        const key = aiKey(job);
        const cached = aiCache.get(key);
        if (cached && cached.until > Date.now()) applyAIResult(job, cached.value);
        else if (aiRunningKey === key) note('duplicate_skip');
        else {
          aiRunningKey = key;
          const controller = new AbortController();
          aiAbort = controller;
          /*
           * El servidor se da a sí mismo 8 s y, si el proveedor se atasca,
           * contesta vacío dentro de ese plazo. Aquí se espera un poco más para
           * no cortar una respuesta buena a punto de llegar; al vencer, el
           * resultado se descarta y el borrador queda intacto.
           */
          aiTimeout = setTimeout(() => controller.abort(), 11000);
          const started = Date.now();
          let result = null;
          let status = 0;
          diag.requests += 1;
          note('request');
          try {
            const response = await fetch('/api/admin/proofreading', {
              method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: job.context, text: job.text }),
            });
            status = response.status;
            if (response.ok) result = (await response.json()).suggestion || null;
            else note(`http_${status}`);
          } catch {
            diag.errors += 1;
            if (controller.signal.aborted) diag.timeouts += 1;
            note(controller.signal.aborted ? 'timeout' : 'network_error');
          } finally {
            clearTimeout(aiTimeout); aiTimeout = null;
            diag.lastStatus = status;
            diag.lastLatencyMs = Date.now() - started;
            if (aiAbort === controller) aiAbort = null;
            /*
             * Caché: un acierto dura 10 min; una respuesta vacía, 30 s (no se
             * martillea el proveedor con el mismo borrador). Solo se guarda lo
             * que el servidor contestó de verdad: un timeout, un corte de red o
             * un error NO se cachean, porque dejaban ese borrador sin ayuda
             * durante medio minuto (el «se apaga» que reportó el equipo).
             */
            const cacheable = status >= 200 && status < 300;
            if (cacheable) {
              if (aiCache.size >= 64) aiCache.delete(aiCache.keys().next().value);
              aiCache.set(key, { value: result, until: Date.now() + (result ? 600000 : 30000) });
            }
            aiRunningKey = '';
          }
          applyAIResult(job, result);
        }
        const after = currentDraft();
        if (after && after.text !== job.text) next = after;
        break; // una consulta por turno; si el texto cambió, se repite tras una pausa
      }
    } finally {
      aiRunning = false;
    }
    if (next) scheduleAI(700);
  }

  function requestSupport(job, suggestion, urgent = false) {
    if (!isCurrent(job)) return;
    const local = Boolean(suggestion?.uncertain?.length || suggestion?.edits?.length);
    // Con dudas locales se pide enseguida; sin ellas también se pide (una frase
    // puede tener todas las palabras válidas y aun así llevar tildes o
    // concordancia mal) pero con más calma y solo desde tres palabras.
    if (!local && job.text.trim().split(/\s+/).filter(Boolean).length < 3) return;
    /*
     * Espera medida: 700 ms con dudas locales y 1200 ms sin ellas. La latencia
     * del proveedor (≈1 s de media, medida en producción) domina el total; bajar
     * más la espera solo multiplicaría consultas sin ganar velocidad percibida.
     */
    scheduleAI(urgent ? 0 : local ? 700 : 1200, local);
  }
  function cancelSend() {
    clearTimeout(sendTimer);
    sendAttempt = null;
    document.querySelector('#wa-proofreading-confirm')?.remove();
    const box = document.querySelector('#wa-proofreading');
    if (box && shown && isCurrent(shown.job)) box.hidden = false;
  }
  function resumeSend() {
    const attempt = sendAttempt;
    cancelSend();
    if (!sameDraft(attempt) || !attempt.button.isConnected || attempt.button.disabled) return;
    bypass = attempt;
    try { attempt.button.click(); } finally { bypass = null; }
  }
  function applyCorrections(job, suggestion) {
    if (!sameDraft(job)) return;
    for (const edit of [...(suggestion.edits || [suggestion])].sort((a, b) => b.start - a.start)) {
      job.area.setRangeText(edit.replacement, edit.start, edit.end, 'preserve');
    }
    clearSuggestion();
    job.area.dispatchEvent(new Event('input', { bubbles: true }));
    job.area.focus({ preventScroll: true });
  }
  function showSendNotice(mode, suggestion) {
    if (!sameDraft(sendAttempt)) { cancelSend(); return; }
    let box = document.querySelector('#wa-proofreading-confirm');
    if (!box) {
      box = document.createElement('div'); box.id = 'wa-proofreading-confirm';
      box.className = 'wa-proofreading-confirm';
      box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Revisión antes de enviar');
      sendAttempt.area.closest('#wa-composer').prepend(box);
    }
    box.replaceChildren();
    const text = document.createElement('p'); text.setAttribute('role', 'status');
    text.textContent = mode === 'errors' ? 'Este mensaje puede tener faltas ortográficas. ¿Quieres enviarlo así?' : mode === 'checking' ? 'Revisando la ortografía…' : 'No se pudo completar la revisión. ¿Quieres enviar el mensaje?';
    const actions = document.createElement('div'); actions.className = 'wa-proofreading-confirm__actions';
    const add = (label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', action); actions.append(button);
    };
    if (suggestion && (suggestion.edits ? suggestion.edits.length : suggestion.word)) add('Corregir', () => {
      const attempt = sendAttempt; cancelSend();
      if (sameDraft(attempt)) applyCorrections(attempt, suggestion);
    });
    add(mode === 'errors' ? 'Enviar así' : 'Enviar ahora', resumeSend);
    add('Seguir editando', () => { const input = area(); cancelSend(); input?.focus({ preventScroll: true }); });
    box.append(text, actions);
    const suggestionBox = document.querySelector('#wa-proofreading');
    if (suggestionBox) suggestionBox.hidden = true;
  }
  // Captura antes del listener de envío del compositor: también cubre Enter.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('#wa-send');
    if (!button || button.disabled || !area()?.value.trim()) return;
    if (bypass && bypass.button === button && sameDraft(bypass)) { bypass = null; return; }
    if (composingNow() || !sameDraft({ area: area(), text: area().value, context: conversation() })) return;
    const reviewed = lastReview && sameDraft(lastReview.job);
    if (reviewed && !lastReview.suggestion) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (sendAttempt && sameDraft(sendAttempt)) return;
    cancelSend();
    sendAttempt = { area: area(), text: area().value, context: conversation(), button };
    if (reviewed) { showSendNotice('errors', lastReview.suggestion); return; }
    showSendNotice('checking');
    // Adelantar la revisión pendiente sin ejecutar el diccionario en la UI.
    schedule(); clearScheduled();
    if (!unavailable && area().value.length <= 4000) {
      if (!isCurrent(inFlight)) pending = { ...sendAttempt, id: version };
      pump();
    } else showSendNotice('unavailable');
    if (sendAttempt) sendTimer = setTimeout(() => { if (sendAttempt) showSendNotice('unavailable'); }, 1500);
  }, true);
  function clearSuggestion() {
    shown = null;
    const box = document.querySelector('#wa-proofreading');
    if (box) box.hidden = true;
  }
  function isCurrent(job) {
    return sameDraft(job) && job.id === version && !document.querySelector('#wa-send')?.disabled;
  }
  function renderSuggestion(job, suggestion) {
    if (!isCurrent(job)) return;
    if (!suggestion) { clearSuggestion(); return; }
    const edits = suggestion.edits || [suggestion];
    if (!edits.length) { clearSuggestion(); return; }
    if (edits.some((edit) => job.text.slice(edit.start, edit.end) !== edit.word)) return;
    let box = document.querySelector('#wa-proofreading');
    if (!box) {
      box = document.createElement('div');
      box.id = 'wa-proofreading';
      box.className = 'wa-proofreading';
      box.setAttribute('aria-label', 'Sugerencia ortográfica');
      const text = document.createElement('span');
      text.className = 'wa-proofreading__text';
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      const accept = document.createElement('button');
      accept.type = 'button'; accept.dataset.proofreading = 'accept'; accept.textContent = 'Usar';
      const dismiss = document.createElement('button');
      dismiss.type = 'button'; dismiss.dataset.proofreading = 'dismiss'; dismiss.textContent = 'Omitir';
      box.append(text, accept, dismiss);
      job.area.closest('#wa-composer').prepend(box);
    }
    // Construir siempre la frase completa, incluso con un solo error y con
    // respuestas de una versión anterior del Worker durante una actualización.
    let correctedText = job.text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) correctedText = correctedText.slice(0, edit.start) + edit.replacement + correctedText.slice(edit.end);
    box.querySelector('.wa-proofreading__text').textContent = correctedText;
    box.querySelector('.wa-proofreading__text').title = correctedText;
    box.setAttribute('aria-busy', 'false');
    const accept = box.querySelector('[data-proofreading="accept"]');
    accept.disabled = false;
    accept.hidden = !edits.length;
    accept.textContent = 'Usar todo';
    accept.setAttribute('aria-label', 'Aplicar todas las correcciones al mensaje');
    box.hidden = Boolean(sendAttempt);
    shown = { job, suggestion };
  }
  function failQuietly() {
    clearTimeout(watchdog);
    clearScheduled();
    worker?.terminate(); worker = null; inFlight = null; pending = null;
    unavailable = true;
    retryAt = Date.now() + 30000;
    if (sendAttempt) showSendNotice('unavailable');
    clearTimeout(sendTimer);
    // Conservar una propuesta visible si una nueva revisión falla. No se puede
    // aplicar a otro borrador: el botón permanece desactivado hasta revisarlo.
  }
  function ensureWorker() {
    if (unavailable) return false;
    if (!worker) {
      try { worker = new Worker('/admin/vendor/proofreading/worker.js'); }
      catch { failQuietly(); return false; }
      worker.addEventListener('error', failQuietly);
      worker.addEventListener('message', ({ data }) => {
        if (!inFlight || data.id !== inFlight.id) return;
        clearTimeout(watchdog);
        const job = inFlight; inFlight = null;
        if (data.unavailable) { failQuietly(); return; }
        if (isCurrent(job)) {
          const suggestion = Object.prototype.hasOwnProperty.call(data, 'review') ? data.review : data.suggestion;
          lastReview = { job, suggestion };
          if (sendAttempt && sameDraft(sendAttempt)) {
            clearTimeout(sendTimer);
            if (suggestion) showSendNotice('errors', suggestion);
            else resumeSend();
          }
        }
        renderSuggestion(job, data.suggestion);
        requestSupport(job, data.suggestion);
        pump();
      });
      worker.postMessage({ type: 'warmup' });
    }
    return true;
  }
  function pump() {
    if (inFlight || !pending || !ensureWorker()) return;
    const job = pending; pending = null;
    clearScheduled();
    if (!isCurrent(job)) return;
    inFlight = job;
    watchdog = setTimeout(failQuietly, 8000);
    try {
      worker.postMessage({ type: 'check', id: job.id, text: job.text, ignored: [...ignored], names: [document.querySelector('#wa-chat-name')?.textContent || ''] });
    } catch {
      /* Un Worker que ya no existe no puede dejar el corrector bloqueado. */
      failQuietly();
    }
  }
  function schedule() {
    const input = area();
    const nextContext = conversation();
    const escribiendo = composingNow();
    /*
     * ESCRIBIR MÁS YA NO ABORTA LA CONSULTA EN CURSO: se deja terminar y, si el
     * texto cambió, su resultado se descarta (latest-wins). Antes cada tecla la
     * mataba y la IA nunca llegaba a contestar mientras se escribía seguido.
     */
    if (sendAttempt && !sameDraft(sendAttempt)) cancelSend();
    if (!escribiendo && ((shown && isCurrent(shown.job)) || (lastReview && isCurrent(lastReview.job)) || isCurrent(pending) || isCurrent(inFlight))) return;
    if (unavailable && Date.now() >= retryAt) unavailable = false;
    version++;
    clearTimeout(timer);
    pending = null;
    if (context !== nextContext) { context = nextContext; ignored = new Set(); clearSuggestion(); cancelAI(); }
    if (!input || !input.value.trim()) clearSuggestion();
    if (shown) {
      document.querySelector('[data-proofreading="accept"]').disabled = true;
      document.querySelector('#wa-proofreading').setAttribute('aria-busy', 'true');
    }
    if (!escribiendo && input && !input.disabled && document.body.dataset.tab === 'whatsapp') ensureWorker();
    const job = input ? { id: version, area: input, text: input.value, context: nextContext } : null;
    /*
     * LA IA DEL SERVIDOR NO DEPENDE DEL DICCIONARIO LOCAL.
     *
     * Antes, si el Worker del diccionario fallaba (`unavailable`), se salía aquí
     * y NO se pedía la corrección al servidor: el corrector quedaba mudo 30 s
     * aunque la IA estuviera perfectamente disponible. Ahora se programa igual;
     * el Worker, cuando llega, la adelanta o la reemplaza.
     */
    if (!escribiendo && input && !input.disabled && input.value.trim().length >= 2 && input.value.length <= 4000) {
      /*
       * Si el diccionario local ya se sabe caído o no contesta, no hay nada que
       * esperar: se pregunta al servidor antes. Con el Worker vivo se da un
       * margen por si contesta primero (y así se ahorra la consulta). El margen
       * NO se reinicia con cada tecla: al vencer se revisa el texto actual.
       */
      scheduleAI(unavailable ? 400 : 1200);
    }
    if (escribiendo || unavailable || !input || input.disabled || input.value.trim().length < 2 || input.value.length > 4000) { clearScheduled(); return; }
    pending = job;
    timer = setTimeout(pump, REVIEW_DELAY);
    // No reiniciar este límite con cada tecla: revisar también mientras escribe
    // seguido, conservando solo el borrador más reciente en la cola.
    if (maxTimer == null) maxTimer = setTimeout(() => { maxTimer = null; pump(); }, MAX_WAIT);
  }
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'wa-text') return;
    /* El propio evento dice si se está componiendo: es la fuente fiable. */
    composing = event.isComposing === true;
    composingAt = Date.now();
    schedule();
  });
  document.addEventListener('focusin', (event) => { if (event.target.id === 'wa-text') schedule(); });
  /*
   * Si el campo pierde el foco (se cierra el teclado, la app pasa a segundo
   * plano), la composición ha terminado aunque `compositionend` no llegue.
   */
  document.addEventListener('focusout', (event) => {
    if (event.target.id !== 'wa-text') return;
    composing = false; composingAt = 0;
    schedule();
  });
  document.addEventListener('compositionstart', (event) => { if (event.target.id === 'wa-text') { composing = true; composingAt = Date.now(); schedule(); } });
  document.addEventListener('compositionend', (event) => { if (event.target.id === 'wa-text') { composing = false; composingAt = 0; schedule(); } });
  // Conservar el teclado al tocar Usar/Omitir en teléfonos.
  document.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-proofreading]')) event.preventDefault(); });
  /*
   * SUGERIR RESPUESTA — botón flotante ✦ del chat.
   *
   * Reglas que no se rompen:
   *   - NUNCA se envía nada: la propuesta se coloca en el borrador solo si la
   *     persona pulsa «Usar respuesta», y desde ahí puede editarla;
   *   - una sola consulta a la vez (pulsar varias veces no multiplica peticiones);
   *   - si se cambia de conversación, la respuesta que llega tarde se descarta y
   *     no aparece en el chat equivocado;
   *   - el botón SIEMPRE vuelve a quedar usable: con error, sin red o por plazo.
   */
  const AI_REPLY_TIMEOUT = 20000;
  let aiReplyBusy = false;
  const AI_REPLY_MENSAJES = {
    limit_reached: 'Se alcanzó el límite diario de IA. Puedes seguir escribiendo a mano.',
    provider_balance: 'La cuenta de la IA no tiene saldo. Recarga DeepSeek en Configuración y reintenta.',
    provider_auth: 'La clave de la IA ya no es válida. Revísala en Configuración.',
    rate_limited: 'La IA está recibiendo demasiadas peticiones. Espera unos segundos y reintenta.',
    provider_unavailable: 'La IA no está disponible en este momento. Reintenta en un rato.',
    timeout: 'La IA tardó demasiado en responder. Reintenta.',
    invalid_response: 'La IA respondió algo que no se puede usar. Reintenta.',
    deepseek_unavailable: 'La IA no está activada. Actívala en Configuración.',
    awaiting_customer: 'El último mensaje lo envió tu equipo. Espera la respuesta del cliente para sugerir qué contestar.',
    unknown_direction: 'No pude confirmar quién envió el último mensaje. No generaré una respuesta para evitar confusiones.',
    no_messages: 'No hay un mensaje reciente del cliente para responder.',
  };
  const aiReplyMensaje = (result, status) => (status === 503
    ? 'Sin conexión con el servidor: no se pudo pedir la sugerencia.'
    : AI_REPLY_MENSAJES[result?.reason] ?? 'No se pudo generar la respuesta. Reintenta o revisa DeepSeek en Configuración.');
  async function pedirSugerenciaIA(boton) {
    if (aiReplyBusy) return;
    const id = conversation(), input = area();
    if (!id || !input || document.body.dataset.waView === 'list') return;
    aiReplyBusy = true;
    boton.disabled = true;
    let box = document.querySelector('#wa-ai-reply-result');
    if (!box) {
      box = document.createElement('div'); box.id = 'wa-ai-reply-result'; box.className = 'wa-proofreading wa-ai-reply-result';
      // Si el panel contextual está abierto, el resultado se pinta DENTRO de él
      // (deja libre el compositor); si no, se comporta como siempre.
      (document.querySelector('#wa-assistant-out') ?? input.closest('#wa-composer'))?.prepend(box);
    }
    const pintar = (texto, acciones = []) => {
      box.replaceChildren();
      const span = document.createElement('span'); span.className = 'wa-proofreading__text'; span.setAttribute('role', 'status'); span.textContent = texto; box.append(span);
      for (const [etiqueta, alPulsar] of acciones) { const accion = document.createElement('button'); accion.type = 'button'; accion.textContent = etiqueta; accion.addEventListener('click', alPulsar); box.append(accion); }
      box.hidden = false;
    };
    const reintentar = () => { box.hidden = true; void pedirSugerenciaIA(boton); };
    const cerrar = () => { box.hidden = true; };
    pintar('Preparando sugerencia…');
    const controller = new AbortController();
    const reloj = setTimeout(() => controller.abort(), AI_REPLY_TIMEOUT);
    try {
      const response = await fetch('/api/admin/ai/reply-suggestion', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: id }) });
      const result = response.ok ? await response.json() : null;
      if (id !== conversation() || !box.isConnected) return;
      if (result?.ok && result.ai && typeof result.text === 'string' && result.text.trim()) {
        const texto = result.text.trim();
        pintar(texto, [
          ['Usar respuesta', () => { if (id !== conversation() || !area()) return; area().value = texto; area().dispatchEvent(new Event('input', { bubbles: true })); area().focus({ preventScroll: true }); box.hidden = true; }],
          ['Cerrar', cerrar],
        ]);
      } else {
        pintar(aiReplyMensaje(result, response.status), [['Reintentar', reintentar], ['Cerrar', cerrar]]);
      }
    } catch (error) {
      if (id === conversation() && box.isConnected) {
        pintar(error?.name === 'AbortError'
          ? 'La IA tardó demasiado en responder. Reintenta.'
          : 'No se pudo conectar para sugerir la respuesta. Reintenta.', [['Reintentar', reintentar], ['Cerrar', cerrar]]);
      }
    } finally {
      clearTimeout(reloj);
      aiReplyBusy = false;
      // Nunca queda desactivado: si se cambió de chat, el siguiente render lo fija.
      if (id === conversation()) boton.disabled = false;
    }
  }
  document.addEventListener('click', async (event) => {
    const aiButton = event.target.closest('#wa-ai-reply');
    if (aiButton) {
      event.preventDefault(); event.stopPropagation();
      if (aiButton.disabled || aiReplyBusy || !conversation() || !area() || document.body.dataset.waView === 'list') return;
      // El MISMO toque abre el Asistente IA contextual (asistant.js). Si ese
      // archivo no está cargado, no cambia nada del comportamiento anterior.
      window.PhytoAssistant?.open?.({ conversationId: conversation() });
      await pedirSugerenciaIA(aiButton);
      return;
    }
    if (event.target.closest('#wa-send')) { setTimeout(schedule, 0); return; }
    const button = event.target.closest('[data-proofreading]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    if (!shown) return;
    const { job, suggestion } = shown;
    if (button.dataset.proofreading === 'dismiss') {
      cancelAI();
      for (const edit of [...(suggestion.edits || [suggestion]), ...(suggestion.uncertain || [])]) if (ignored.size < 128) ignored.add(edit.word.toLocaleLowerCase('es-DO'));
      version++; pending = null; clearScheduled();
      clearSuggestion();
      return;
    }
    if (!isCurrent(job) || button.disabled) return;
    cancelSend(); applyCorrections(job, suggestion);
  });
  document.addEventListener('DOMContentLoaded', () => {
    let lastArea = area();
    const composer = document.querySelector('#wa-composer');
    if (composer) new MutationObserver(() => {
      if (lastArea !== area()) {
        lastArea = area(); composing = false;
        if (sendAttempt && !sameDraft(sendAttempt)) cancelSend();
        version++; pending = null; clearScheduled();
        if (shown && lastArea && shown.job.text === lastArea.value && shown.job.context === conversation()) {
          const previous = shown;
          previous.job = { ...previous.job, area: lastArea, id: version };
          renderSuggestion(previous.job, previous.suggestion);
        } else { clearSuggestion(); schedule(); }
      }
      if (shown && (!lastArea?.value.trim() || shown.job.context !== conversation())) clearSuggestion();
    }).observe(composer, { childList: true });
    const actions = document.querySelector('#wa-actions');
    if (actions) new MutationObserver(() => { if (context !== conversation()) { version++; pending = null; clearScheduled(); clearSuggestion(); schedule(); } }).observe(actions, { attributes: true, attributeFilter: ['data-conversation'] });
    /*
     * LA CONVERSACIÓN TAMBIÉN CAMBIA DESDE LA LISTA.
     * Si el encabezado del chat no trae el identificador, la única señal fiable
     * de cambio de chat es la fila marcada como activa en la lista.
     */
    const lista = document.querySelector('#wa-conversations');
    if (lista) new MutationObserver(() => {
      if (context === conversation()) return;
      version++; pending = null; clearScheduled(); clearSuggestion(); cancelSend(); cancelAI();
      ignored = new Set(); context = conversation(); schedule();
    }).observe(lista, { attributes: true, attributeFilter: ['class', 'data-conv', 'aria-current'], subtree: true });
    const app = document.querySelector('#app');
    if (app) new MutationObserver(() => {
      if (app.hidden) { version++; pending = null; clearScheduled(); clearSuggestion(); cancelSend(); cancelAI(); }
    }).observe(app, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(() => {
      if (document.body.dataset.tab !== 'whatsapp' || document.body.dataset.waView === 'list') { version++; pending = null; clearScheduled(); clearSuggestion(); cancelSend(); cancelAI(); }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-tab','data-wa-view'] });
    if (area() && document.body.dataset.tab === 'whatsapp') schedule();
  });
  window.addEventListener('pagehide', () => { clearScheduled(); clearTimeout(watchdog); worker?.terminate(); worker = null; inFlight = null; pending = null; version++; clearSuggestion(); cancelSend(); cancelAI(); });
  window.addEventListener('fulltech:proofreading-config-updated', () => { cancelAI(); aiCache.clear(); lastReview = null; version++; schedule(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && sendAttempt) { cancelSend(); area()?.focus({ preventScroll: true }); } });
  window.addEventListener('online', () => { unavailable = false; if (area() === document.activeElement) schedule(); });
  /*
   * DIAGNÓSTICO SEGURO (FASE 5): estado y contadores, SIN textos ni claves.
   * Desde la consola del panel: __phytoProofreading.state()
   */
  window.__phytoProofreading = {
    state: () => ({
      composing: composingNow(), unavailable, version,
      pending: Boolean(pending), localInFlight: Boolean(inFlight),
      aiRunning, aiWanted: Boolean(aiWanted), cache: aiCache.size,
      ...diag,
    }),
  };
})();
