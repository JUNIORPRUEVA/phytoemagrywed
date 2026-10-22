/*
 * ASISTENTE IA CONTEXTUAL DEL CHAT (panel del empleado).
 *
 * Se abre con el botón ✦ que ya existía en la conversación. Es una herramienta
 * INTERNA: no escribe en el hilo del cliente ni se confunde con él.
 *
 * Reglas que no se rompen:
 *   - solo consulta y redacta BORRADORES; nunca envía ni modifica nada;
 *   - el contexto es de LA conversación abierta: al cambiar de chat se invalida
 *     de inmediato y una respuesta que llega tarde NO se pinta en el chat nuevo;
 *   - el panel vive DENTRO de la columna del chat, encima del compositor, así no
 *     tapa el campo de escritura ni el teclado del móvil;
 *   - si el servicio de IA falla, el chat sigue funcionando igual.
 */
(() => {
  'use strict';

  const ACTIONS = [
    ['draft_reply', 'Redactar respuesta'],
    ['analyze_customer', 'Analizar cliente'],
    ['orders', 'Consultar pedidos'],
    ['templates', 'Plantillas rápidas'],
    ['next_action', 'Sugerir próxima acción'],
    ['company_info', 'Consultar empresa'],
  ];

  const REASONS = {
    ai_unavailable: 'La IA no está activada o la cuenta no tiene saldo. Revísala en Configuración → DeepSeek.',
    invalid_response: 'La IA respondió algo que no se puede usar. Reintenta.',
    provider_error: 'No se pudo consultar la IA. Reintenta en un momento.',
    provider_balance: 'La cuenta de la IA no tiene saldo. Revísala en Configuración.',
    provider_auth: 'La clave de la IA ya no es válida. Revísala en Configuración.',
    rate_limited: 'Demasiadas consultas seguidas. Espera un minuto y reintenta.',
    conversation_not_accessible: 'No tienes acceso a esta conversación.',
    customer_missing: 'Este chat no tiene una ficha de cliente asociada.',
    timeout: 'La IA tardó demasiado en responder. Reintenta.',
    network: 'Sin conexión con el servidor.',
  };

  const state = { el: null, conv: '', gen: 0, busy: false, open: false, action: 'free' };

  function $(selector) { return document.querySelector(selector); }

  /** Misma resolución de conversación activa que usa el resto del panel. */
  function conversation() {
    const desdeAcciones = $('#wa-actions')?.dataset.conversation;
    if (desdeAcciones) return desdeAcciones;
    const fila = document.querySelector('.conv--active[data-conv], [data-conv][aria-current="true"], #wa-conversations [data-conv].conv--active');
    if (fila?.dataset.conv) return fila.dataset.conv;
    return $('#wa-chat-pane')?.dataset.conversation || '';
  }

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /* --------------------------------------------------------------- estructura */

  function build() {
    // Idempotente: si el panel ya existe (DOMContentLoaded puede llegar dos
    // veces: el natural y el que dispara el guard de arranque) se reutiliza en
    // vez de crear un segundo panel huérfano.
    const existente = document.getElementById('wa-assistant');
    if (existente) { state.el = existente; return existente; }
    const pane = $('#wa-chat-pane');
    if (!pane) return null;
    const section = h('section', 'wa-assistant');
    section.id = 'wa-assistant';
    section.hidden = true;
    section.setAttribute('aria-label', 'Asistente IA contextual');

    const head = h('div', 'wa-assistant__head');
    const titles = h('div', 'wa-assistant__titles');
    const title = h('p', 'wa-assistant__title', 'Asistente IA');
    title.append(h('span', 'wa-assistant__badge', 'interno'));
    titles.append(title, h('p', 'wa-assistant__sub', '¿En qué puedo ayudarte con este cliente?'));
    const close = h('button', 'wa-assistant__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar el asistente');
    close.dataset.assistantClose = '1';
    head.append(titles, close);

    const chips = h('div', 'wa-assistant__chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Accesos del asistente');
    for (const [action, label] of ACTIONS) {
      const chip = h('button', 'wa-assistant__chip', label);
      chip.type = 'button';
      chip.dataset.assistantAction = action;
      chips.append(chip);
    }

    const form = h('form', 'wa-assistant__form');
    const input = h('textarea', 'wa-assistant__input');
    input.id = 'wa-assistant-input';
    input.rows = 2;
    input.maxLength = 600;
    input.placeholder = 'Escribe qué necesitas que haga la IA…';
    input.setAttribute('aria-label', 'Instrucciones para el asistente');
    const go = h('button', 'wa-assistant__go', 'Consultar IA');
    go.type = 'submit';
    form.append(input, go);

    const out = h('div', 'wa-assistant__out');
    out.id = 'wa-assistant-out';
    out.setAttribute('role', 'log');
    out.setAttribute('aria-live', 'polite');

    const foot = h('p', 'wa-assistant__foot', 'Solo consultas y borradores. Nada se envía ni se modifica sin tu confirmación.');

    section.append(head, chips, form, out, foot);
    const composer = $('#wa-composer');
    if (composer && composer.parentElement === pane) pane.insertBefore(section, composer);
    else pane.append(section);
    state.el = section;
    return section;
  }

  function out() { return state.el?.querySelector('#wa-assistant-out') ?? null; }
  function input() { return state.el?.querySelector('#wa-assistant-input') ?? null; }

  function setBusy(busy) {
    state.busy = busy;
    if (!state.el) return;
    state.el.dataset.busy = busy ? '1' : '0';
    // Cerrar SIEMPRE se puede: una consulta lenta no secuestra el panel.
    for (const button of state.el.querySelectorAll('button:not([data-assistant-close])')) button.disabled = busy;
    const go = state.el.querySelector('.wa-assistant__go');
    if (go) go.textContent = busy ? 'Consultando…' : 'Consultar IA';
    const field = input();
    if (field) field.readOnly = busy;
  }

  function markChip(action) {
    state.action = action;
    for (const chip of state.el?.querySelectorAll('[data-assistant-action]') ?? []) {
      chip.dataset.active = chip.dataset.assistantAction === action ? '1' : '0';
    }
  }

  function clearOutput() {
    const box = out();
    if (box) box.replaceChildren();
  }

  function reset(id) {
    state.gen += 1;
    state.conv = id || '';
    state.action = 'free';
    setBusy(false);
    clearOutput();
    const field = input();
    if (field) field.value = '';
    const box = document.querySelector('#wa-ai-reply-result');
    if (box) box.hidden = true;
    markChip('free');
  }

  /* ---------------------------------------------------------------- apertura */

  function open() {
    const id = conversation();
    if (!id) return;
    const el = state.el ?? build();
    if (!el) return;
    if (state.conv !== id) reset(id);
    state.open = true;
    el.hidden = false;
    el.dataset.open = '1';
    markChip(state.action);
  }

  function close() {
    if (!state.el) return;
    state.open = false;
    state.el.hidden = true;
    delete state.el.dataset.open;
    // Lo que estuviera en vuelo ya no se pinta (el panel está cerrado).
    state.gen += 1;
    setBusy(false);
  }

  /* ------------------------------------------------------------------ pintado */

  function renderNotice(text, { retry = null } = {}) {
    const box = out();
    if (!box) return;
    box.replaceChildren();
    const note = h('div', 'wa-assistant__notice');
    note.append(h('p', 'wa-assistant__text', text));
    if (retry) {
      const again = h('button', 'wa-assistant__link', 'Reintentar');
      again.type = 'button';
      again.addEventListener('click', retry);
      note.append(again);
    }
    box.append(note);
  }

  function renderLoading(text) {
    const box = out();
    if (!box) return;
    box.replaceChildren();
    const row = h('div', 'wa-assistant__loading');
    row.append(h('span', 'wa-assistant__dot'), h('span', null, text));
    box.append(row);
  }

  function renderResult(result, request) {
    const box = out();
    if (!box) return;
    box.replaceChildren();

    if (!result || result.ai !== true) {
      const reason = result?.reason ?? 'provider_error';
      renderNotice(REASONS[reason] ?? REASONS.provider_error, {
        retry: () => { void ask(request.action, request.message); },
      });
      if (Array.isArray(result?.sources) && result.sources.length) box.append(sourcesRow(result.sources));
      return;
    }

    const answer = h('p', 'wa-assistant__answer', result.answer);
    box.append(answer);

    if (Array.isArray(result.bullets) && result.bullets.length) {
      const list = h('ul', 'wa-assistant__bullets');
      for (const item of result.bullets) list.append(h('li', null, item));
      box.append(list);
    }

    if (result.draft) {
      const block = h('div', 'wa-assistant__draft');
      block.append(h('p', 'wa-assistant__label', 'Borrador para el cliente'));
      const area = h('textarea', 'wa-assistant__draft-text');
      area.value = result.draft;
      area.rows = 3;
      area.maxLength = 600;
      area.setAttribute('aria-label', 'Borrador editable');
      const actions = h('div', 'wa-assistant__draft-actions');
      const use = h('button', 'wa-assistant__link wa-assistant__link--primary', 'Insertar en el compositor');
      use.type = 'button';
      const note = h('p', 'wa-assistant__hint', 'Insertar no envía: el mensaje lo revisas y lo mandas tú.');
      use.addEventListener('click', () => {
        const target = $('#wa-text');
        const text = area.value.trim();
        if (!target || !text) return;
        /*
         * NO SE PISA TRABAJO SIN PERMISO.
         * Si el compositor ya tiene texto sin enviar, la persona decide: el
         * borrador de la IA nunca reemplaza en silencio lo que ella escribió.
         */
        const actual = String(target.value ?? '');
        if (actual.trim() && actual !== text) {
          const reemplazar = typeof window.confirm === 'function'
            ? window.confirm('El compositor ya tiene texto sin enviar. ¿Reemplazarlo por el borrador?')
            : true;
          if (!reemplazar) {
            note.textContent = 'Se conservó el texto que ya tenías en el compositor.';
            return;
          }
        }
        target.value = text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus({ preventScroll: true });
        note.textContent = 'Borrador colocado en el compositor. Revísalo antes de enviarlo.';
      });
      actions.append(use);
      block.append(area, actions, note);
      box.append(block);
    }

    if (Array.isArray(result.suggestions) && result.suggestions.length) {
      const block = h('div', 'wa-assistant__suggestions');
      block.append(h('p', 'wa-assistant__label', 'Próximos pasos'));
      const list = h('ul', 'wa-assistant__bullets');
      for (const item of result.suggestions) list.append(h('li', null, item));
      block.append(list);
      box.append(block);
    }

    // OPERACIÓN PREPARADA: se muestra y SOLO se ejecuta si la persona confirma.
    if (result.proposal) box.append(proposalCard(result.proposal));
    if (result.proposalError) {
      box.append(h('p', 'wa-assistant__hint', `No pude preparar la operación: ${result.proposalError.message ?? result.proposalError.error}`));
    }

    if (Array.isArray(result.sources) && result.sources.length) box.append(sourcesRow(result.sources));
    box.append(h('p', 'wa-assistant__hint', 'Solo lectura · no se envió ni cambió nada.'));
    box.scrollTop = 0;
  }

  /*
   * TARJETA DE PROPUESTA.
   *
   * Enseña EXACTAMENTE lo que se va a ejecutar (cliente, productos, total que
   * calculó el backend o el texto/fecha) y exige un toque en «Confirmar». Nada
   * se envía ni se guarda sin ese toque; «Cancelar» deja la propuesta muerta.
   */
  function proposalCard(proposal) {
    const PREPARED = { order: 'Pedido preparado', quote: 'Cotización preparada', note: 'Nota preparada', followup: 'Seguimiento preparado' };
    const DONE = { order: 'Pedido confirmado', quote: 'Cotización confirmada', note: 'Nota guardada', followup: 'Seguimiento creado' };
    const card = h('div', 'wa-assistant__proposal');
    card.dataset.proposalId = proposal.id;
    card.append(h('p', 'wa-assistant__label', PREPARED[proposal.type] ?? `${proposal.label} preparado`));
    if (proposal.preview?.customer?.name) {
      card.append(h('p', 'wa-assistant__proposal-line', `Cliente: ${proposal.preview.customer.name}`));
    }
    const preview = proposal.preview ?? {};
    if (Array.isArray(preview.items) && preview.items.length) {
      const list = h('ul', 'wa-assistant__bullets');
      for (const item of preview.items) {
        list.append(h('li', null, `${item.name ?? item.variantId} × ${item.quantity}${item.unitPrice ? ` · ${money(item.unitPrice)}` : ''}`));
      }
      card.append(list);
      card.append(h('p', 'wa-assistant__proposal-total', `Total: ${money(preview.total)} ${preview.currency ?? 'DOP'}`));
      if (preview.paymentLabel) card.append(h('p', 'wa-assistant__proposal-line', `Pago: ${preview.paymentLabel}`));
    }
    if (preview.text) card.append(h('p', 'wa-assistant__proposal-text', preview.text));
    if (preview.date) card.append(h('p', 'wa-assistant__proposal-line', `Fecha: ${preview.date}${preview.reason ? ` · ${preview.reason}` : ''}`));

    const actions = h('div', 'wa-assistant__proposal-actions');
    const editar = h('button', 'wa-assistant__link', 'Editar');
    const cancelar = h('button', 'wa-assistant__link', 'Cancelar');
    const confirmar = h('button', 'wa-assistant__link wa-assistant__link--primary', 'Confirmar');
    for (const button of [editar, cancelar, confirmar]) button.type = 'button';

    editar.addEventListener('click', () => {
      const field = input();
      if (!field) return;
      field.value = instructionFor(proposal);
      field.focus({ preventScroll: true });
      card.dataset.editing = '1';
    });

    const cerrar = (texto, clase) => {
      card.replaceChildren(h('p', clase ?? 'wa-assistant__hint', texto));
    };

    cancelar.addEventListener('click', async () => {
      cancelar.disabled = true; confirmar.disabled = true; editar.disabled = true;
      try {
        const response = await fetch(`/api/admin/assistant/actions/${encodeURIComponent(proposal.id)}/cancel`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!response.ok) throw new Error('cancel');
        cerrar('Propuesta cancelada. No se guardó nada.');
      } catch {
        cancelar.disabled = false; confirmar.disabled = false; editar.disabled = false;
        cerrar('No se pudo cancelar. Reintenta.', 'wa-assistant__hint');
      }
    });

    confirmar.addEventListener('click', async () => {
      if (confirmar.dataset.busy === '1') return;
      confirmar.dataset.busy = '1';
      cancelar.disabled = true; editar.disabled = true;
      confirmar.textContent = 'Confirmando…';
      try {
        const response = await fetch(`/api/admin/assistant/actions/${encodeURIComponent(proposal.id)}/confirm`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true) {
          cerrar(result?.message ?? 'No se pudo ejecutar. Revisa antes de reintentar.');
          confirmar.dataset.busy = '0';
          return;
        }
        const ref = result.result ?? {};
        const numero = ref.number ? ` · ${ref.number}` : '';
        cerrar(`${DONE[proposal.type] ?? `${proposal.label} confirmado`}${numero}${ref.status ? ` · ${ref.status}` : ''}${result.duplicate ? ' (ya estaba hecho)' : ''}.`);
      } catch {
        confirmar.dataset.busy = '0';
        cerrar('No se pudo confirmar. Reintenta cuando vuelva la conexión.');
      }
    });

    actions.append(editar, cancelar, confirmar);
    card.append(actions);
    // La persona tiene que VER la propuesta completa (líneas, total y botones)
    // sin tener que buscarla dentro del panel.
    setTimeout(() => card.scrollIntoView({ block: 'nearest' }), 0);
    return card;
  }

  function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `RD$${number.toLocaleString('es-DO', { maximumFractionDigits: 2 })}`;
  }

  /** Instrucción editable que devuelve la propuesta al campo libre. */
  function instructionFor(proposal) {
    const preview = proposal.preview ?? {};
    if (proposal.type === 'note') return `Cambia la nota: ${preview.text ?? ''}`;
    if (proposal.type === 'followup') return `Cambia el seguimiento del ${preview.date ?? ''}: ${preview.reason ?? ''}`;
    const items = (preview.items ?? []).map((item) => `${item.quantity} × ${item.name}`).join(', ');
    return `Prepara ${proposal.type === 'quote' ? 'una cotización' : 'un pedido'} con: ${items}`;
  }

  function sourcesRow(sources) {
    const row = h('div', 'wa-assistant__sources');
    row.append(h('span', 'wa-assistant__label', 'Datos usados'));
    for (const item of sources.slice(0, 6)) {
      if (!item?.label) continue;
      const chip = h('span', 'wa-assistant__source', item.label);
      if (item.detail) chip.title = item.detail;
      row.append(chip);
    }
    return row;
  }

  /* ------------------------------------------------------------------ consulta */

  async function ask(action, message = '') {
    const id = conversation();
    if (!id || state.busy) return;
    const request = { action, message };
    const gen = (state.gen += 1);
    markChip(action);
    setBusy(true);
    renderLoading(action === 'free' ? 'Consultando la IA…' : 'Preparando con los datos del cliente…');
    const controller = new AbortController();
    const reloj = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/admin/assistant/query', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id, action, message }),
      });
      const result = await response.json().catch(() => null);
      // Respuesta obsoleta: otra conversación, otra consulta o panel cerrado.
      if (gen !== state.gen || id !== conversation() || !state.open) return;
      if (!response.ok) {
        const reason = response.status === 429 ? 'rate_limited'
          : response.status === 403 ? 'conversation_not_accessible'
            : response.status === 409 ? 'customer_missing'
              : response.status === 503 ? 'network' : (result?.reason ?? 'provider_error');
        renderResult({ ai: false, reason, sources: [] }, request);
        return;
      }
      renderResult(result, request);
    } catch (error) {
      if (gen !== state.gen || id !== conversation() || !state.open) return;
      renderResult({ ai: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network', sources: [] }, request);
    } finally {
      clearTimeout(reloj);
      if (gen === state.gen) setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ eventos */

  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('.wa-assistant__form');
    if (!form) return;
    event.preventDefault();
    const field = input();
    const text = (field?.value ?? '').trim();
    if (!text) { field?.focus({ preventScroll: true }); return; }
    void ask(state.action === 'free' ? 'free' : state.action, text);
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-assistant-close]')) { event.preventDefault(); close(); return; }
    const chip = event.target.closest('[data-assistant-action]');
    if (chip && state.el?.contains(chip)) {
      event.preventDefault();
      if (state.busy) return;
      const field = input();
      void ask(chip.dataset.assistantAction, (field?.value ?? '').trim());
      return;
    }
    // Si el panel oficial no está cargado (o falló), el botón ✦ también abre.
    // Un botón deshabilitado (chat aún cargando) no abre nada, igual que antes.
    const fab = event.target.closest('#wa-ai-reply');
    if (fab && !fab.disabled && !state.open) open();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.open) return;
    close();
  });

  /*
   * CAMBIO DE CLIENTE = CONTEXTO NUEVO.
   * Se vigilan las tres señales reales del panel: las acciones del chat, la fila
   * activa de la bandeja y la vista (lista/chat).
   */
  function invalidar() {
    const id = conversation();
    if (id === state.conv) return;
    if (!id) { reset(''); close(); return; }
    reset(id);
    if (state.open) renderNotice('Cambiaste de conversación. Pregunta de nuevo por este cliente.');
  }
  function fueraDelChat() {
    if (document.body.dataset.tab !== 'whatsapp' || document.body.dataset.waView === 'list') { reset(''); close(); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    build();
    const actions = $('#wa-actions');
    if (actions) new MutationObserver(invalidar).observe(actions, { attributes: true, attributeFilter: ['data-conversation'] });
    const lista = $('#wa-conversations');
    if (lista) new MutationObserver(invalidar).observe(lista, { attributes: true, attributeFilter: ['class', 'data-conv', 'aria-current'], subtree: true });
    new MutationObserver(fueraDelChat).observe(document.body, { attributes: true, attributeFilter: ['data-tab', 'data-wa-view'] });
    new MutationObserver(invalidar).observe(document.body, { attributes: true, attributeFilter: ['data-wa-chat'] });
  });

  window.PhytoAssistant = {
    open,
    close,
    state: () => ({ open: state.open, conversation: state.conv, busy: state.busy, action: state.action }),
  };
})();
