/* Revisión local en Worker. Cada envío conserva la decisión explícita del usuario. */
(() => {
  'use strict';
  let worker, timer, maxTimer, watchdog, inFlight, pending, version = 0;
  const REVIEW_DELAY = 120;
  const MAX_WAIT = 600;
  function clearScheduled() { clearTimeout(timer); clearTimeout(maxTimer); maxTimer = null; }
  let composing = false;
  let context = '';
  let ignored = new Set();
  let shown;
  let unavailable = false;
  let retryAt = 0;
  let lastReview, sendAttempt, sendTimer, bypass;
  let aiTimer, aiTimeout, aiAbort, aiJob;
  const aiCache = new Map();
  const area = () => document.querySelector('#wa-text');
  const conversation = () => document.querySelector('#wa-actions')?.dataset.conversation || '';
  function sameDraft(job) {
    return job && job.area === area() && job.area.isConnected && job.text === job.area.value && job.context === conversation() && document.body.dataset.tab === 'whatsapp' && document.body.dataset.waView !== 'list' && !document.querySelector('#app')?.hidden;
  }
  function cancelAI() {
    clearTimeout(aiTimer); clearTimeout(aiTimeout);
    aiAbort?.abort(); aiAbort = null; aiJob = null;
  }
  function requestSupport(job, suggestion) {
    if (!isCurrent(job)) return;
    const local = Boolean(suggestion?.uncertain?.length || suggestion?.edits?.length);
    // Con dudas locales se pide enseguida; sin ellas también se pide (una frase
    // puede tener todas las palabras válidas y aun así llevar tildes o
    // concordancia mal) pero con más calma y solo desde tres palabras.
    if (!local && job.text.trim().split(/\s+/).filter(Boolean).length < 3) return;
    cancelAI();
    const key = JSON.stringify([job.context, job.text, [...ignored]]);
    const apply = result => {
      if (!isCurrent(job) || !result?.edits?.length) return;
      lastReview = { job, suggestion: result };
      renderSuggestion(job, result);
      if (sendAttempt && sameDraft(sendAttempt)) showSendNotice('errors', result);
    };
    const cached = aiCache.get(key);
    if (cached && cached.until > Date.now()) { apply(cached.value); return; }
    aiJob = job;
    aiTimer = setTimeout(async () => {
      if (!isCurrent(job)) return;
      const controller = new AbortController(); aiAbort = controller;
      aiTimeout = setTimeout(() => controller.abort(), 5500);
      let result = null;
      try {
        const response = await fetch('/api/admin/proofreading', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: job.context, text: job.text }) });
        if (response.ok) result = (await response.json()).suggestion || null;
        if (!controller.signal.aborted) apply(result);
      } catch { /* La ayuda local sigue disponible; sin avisos por fallos. */ }
      finally {
        if (!controller.signal.aborted) {
          if (aiCache.size >= 64) aiCache.delete(aiCache.keys().next().value);
          aiCache.set(key, { value: result, until: Date.now() + (result ? 600000 : 30000) });
        }
        if (aiAbort === controller) { clearTimeout(aiTimeout); aiAbort = null; aiJob = null; }
      }
    }, local ? 900 : 1400);
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
    if (composing || !sameDraft({ area: area(), text: area().value, context: conversation() })) return;
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
    worker.postMessage({ type: 'check', id: job.id, text: job.text, ignored: [...ignored], names: [document.querySelector('#wa-chat-name')?.textContent || ''] });
  }
  function schedule() {
    const input = area();
    const nextContext = conversation();
    if (composing || (aiJob && !sameDraft(aiJob))) cancelAI();
    if (sendAttempt && !sameDraft(sendAttempt)) cancelSend();
    if (!composing && ((shown && isCurrent(shown.job)) || (lastReview && isCurrent(lastReview.job)) || isCurrent(pending) || isCurrent(inFlight))) return;
    if (unavailable && Date.now() >= retryAt) unavailable = false;
    version++;
    clearTimeout(timer);
    pending = null;
    if (context !== nextContext) { context = nextContext; ignored = new Set(); clearSuggestion(); }
    if (!input || !input.value.trim()) clearSuggestion();
    if (shown) {
      document.querySelector('[data-proofreading="accept"]').disabled = true;
      document.querySelector('#wa-proofreading').setAttribute('aria-busy', 'true');
    }
    if (!composing && input && !input.disabled && document.body.dataset.tab === 'whatsapp') ensureWorker();
    if (composing || unavailable || !input || input.disabled || input.value.trim().length < 2 || input.value.length > 4000) { clearScheduled(); return; }
    const job = { id: version, area: input, text: input.value, context: nextContext };
    pending = job;
    timer = setTimeout(pump, REVIEW_DELAY);
    // No reiniciar este límite con cada tecla: revisar también mientras escribe
    // seguido, conservando solo el borrador más reciente en la cola.
    if (maxTimer == null) maxTimer = setTimeout(() => { maxTimer = null; pump(); }, MAX_WAIT);
  }
  document.addEventListener('input', (event) => { if (event.target.id === 'wa-text') schedule(); });
  document.addEventListener('focusin', (event) => { if (event.target.id === 'wa-text') schedule(); });
  document.addEventListener('compositionstart', (event) => { if (event.target.id === 'wa-text') { composing = true; schedule(); } });
  document.addEventListener('compositionend', (event) => { if (event.target.id === 'wa-text') { composing = false; schedule(); } });
  // Conservar el teclado al tocar Usar/Omitir en teléfonos.
  document.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-proofreading]')) event.preventDefault(); });
  document.addEventListener('click', async (event) => {
    const aiButton = event.target.closest('#wa-ai-reply');
    if (aiButton) {
      event.preventDefault(); event.stopPropagation();
      const id = conversation(), input = area();
      if (!id || aiButton.disabled || !input || document.body.dataset.waView === 'list') return;
      aiButton.disabled = true;
      let box = document.querySelector('#wa-ai-reply-result');
      if (!box) { box = document.createElement('div'); box.id = 'wa-ai-reply-result'; box.className = 'wa-proofreading wa-ai-reply-result'; input.closest('#wa-composer')?.prepend(box); }
      box.replaceChildren();
      const status = document.createElement('span'); status.className = 'wa-proofreading__text'; status.setAttribute('role', 'status'); status.textContent = 'Preparando sugerencia…'; box.append(status); box.hidden = false;
      const controller = new AbortController();
      try {
        const response = await fetch('/api/admin/ai/reply-suggestion', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: id }) });
        const result = response.ok ? await response.json() : null;
        if (id !== conversation() || !box.isConnected) return;
        box.replaceChildren();
        const text = document.createElement('span'); text.className = 'wa-proofreading__text'; text.setAttribute('role', 'status');
        if (result?.ok && result.ai && typeof result.text === 'string') {
          text.textContent = result.text; box.append(text);
          const use = document.createElement('button'); use.type = 'button'; use.textContent = 'Usar respuesta';
          use.addEventListener('click', () => { if (id !== conversation() || !area()) return; area().value = result.text; area().dispatchEvent(new Event('input', { bubbles: true })); area().focus({ preventScroll: true }); box.hidden = true; });
          box.append(use);
        } else {
          text.textContent = response.status === 503
            ? 'Conéctate al servidor para pedir una sugerencia. No se guardará como mensaje pendiente.'
            : result?.reason === 'limit_reached'
            ? 'Se alcanzó el límite de uso de IA. Inténtalo más tarde.'
            : result?.reason === 'awaiting_customer'
              ? 'El último mensaje lo envió tu equipo. Espera la respuesta del cliente para sugerir qué contestar.'
              : result?.reason === 'unknown_direction'
                ? 'No pude confirmar quién envió el último mensaje. No generaré una respuesta para evitar confusiones.'
                : result?.reason === 'no_messages'
                  ? 'No hay un mensaje reciente del cliente para responder.'
                  : 'No se pudo generar la respuesta. Comprueba DeepSeek en Configuración.';
          box.append(text);
        }
        const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cerrar'; close.addEventListener('click', () => { box.hidden = true; }); box.append(close);
      } catch {
        if (id === conversation() && box.isConnected) { box.replaceChildren(); const error = document.createElement('span'); error.className = 'wa-proofreading__text'; error.textContent = 'No se pudo conectar para sugerir la respuesta.'; box.append(error); }
      } finally { aiButton.disabled = false; }
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
})();
