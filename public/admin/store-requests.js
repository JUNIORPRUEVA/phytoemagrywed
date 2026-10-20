/* Solicitudes de clientes de FULLTECH Store. Administración y cotización. */
(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = (value, currency = 'DOP') => new Intl.NumberFormat('es-DO', { style: 'currency', currency }).format(Number(value) || 0);
  const date = (value) => (value ? new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '');
  const STATUSES = [
    ['nuevo', 'Nueva'], ['en_revision', 'En revisión'], ['cotizado', 'Cotizada'], ['aprobado', 'Aprobada'],
    ['anticipo_pendiente', 'Anticipo pendiente'],
    ['en_proceso', 'En proceso'], ['completado', 'Completada'], ['rechazado', 'No disponible'], ['cancelado', 'Cancelada'],
  ];
  const PAYMENT_LABEL = { reported: 'Reportado (sin verificar)', confirmed: 'Confirmado', rejected: 'Rechazado' };
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const host = () => document.getElementById('admin-requests');
  const state = { loaded: false, loading: false, requests: [], canManage: false, selected: null, status: '', q: '', error: '', notice: '' };

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/admin/store/requests${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) throw new Error('Tu sesión terminó. Vuelve a entrar.');
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo completar la operación.');
    return data;
  }

  async function load(force = false) {
    const box = host();
    if (!box) return;
    if (state.loading) return;
    state.loading = true;
    if (force || !state.loaded) box.innerHTML = '<p class="store-muted">Cargando solicitudes…</p>';
    try {
      const query = new URLSearchParams();
      if (state.status) query.set('status', state.status);
      if (state.q) query.set('q', state.q);
      const data = await api(`?${query}`);
      state.requests = data.requests ?? [];
      state.canManage = data.canManage === true;
      state.loaded = true;
      state.error = '';
      render();
    } catch (error) {
      state.error = error.message;
      if (box) box.innerHTML = `<p class="store-form-error" role="alert">${esc(error.message)}</p>`;
    } finally {
      state.loading = false;
    }
  }

  function card(request) {
    const customer = request.customer;
    const quote = request.quote ? `<span class="requests-item__amount">${money(request.quote.amount, request.quote.currency)}</span>` : '';
    return `<button class="requests-item" type="button" data-request-id="${esc(request.id)}" aria-pressed="${state.selected === request.id}">
      <span class="requests-item__status requests-status--${esc(request.status)}">${esc(STATUS_LABEL[request.status] || request.status)}</span>
      <span class="requests-item__main">
        <strong>${esc(request.title)}</strong>
        <small>${esc(customer?.name || 'Cliente')}${customer?.phone_e164 ? ` · ${esc(customer.phone_e164)}` : ''} · ${esc(date(request.created_at))}</small>
      </span>
      ${quote}
    </button>`;
  }

  function detail(request) {
    const customer = request.customer;
    const images = Array.from({ length: Number(request.images) || 0 }, (_, index) =>
      `<button class="requests-photo" type="button" data-request-photo="${esc(request.id)}/${index}" aria-label="Ver foto ${index + 1}"><img src="/api/admin/store/requests/${encodeURIComponent(request.id)}/image/${index}" alt="Foto ${index + 1} de la solicitud" loading="lazy"></button>`).join('');
    const timeline = (request.events ?? []).map((event) => `<li><span>${esc(STATUS_LABEL[event.status] || event.status)}</span><small>${esc(event.by || '')} · ${esc(date(event.at))}</small>${event.note ? `<em>${esc(event.note)}</em>` : ''}</li>`).join('');
    const quoteValue = request.quote ? (Number(request.quote.amount) || 0).toFixed(2) : '';
    return `<section class="requests-detail" aria-label="Detalle de la solicitud">
      <div class="requests-detail__head">
        <div><span class="requests-item__status requests-status--${esc(request.status)}">${esc(STATUS_LABEL[request.status] || request.status)}</span><h3>${esc(request.title)}</h3><p class="store-muted">${esc(customer?.name || 'Cliente')}${customer?.phone_e164 ? ` · ${esc(customer.phone_e164)}` : ''} · ${esc(date(request.created_at))}</p></div>
        <div class="requests-detail__actions">
          ${request.customer_id ? `<button class="btn btn--ghost btn--sm" type="button" data-order-new="${esc(request.customer_id)}" title="Abrir el alta de pedido del CRM para este cliente">Crear pedido</button>` : ''}
          <button class="store-icon-button" type="button" data-request-close aria-label="Cerrar detalle">×</button>
        </div>
      </div>
      ${request.details ? `<p class="requests-detail__body">${esc(request.details)}</p>` : ''}
      ${request.reference_url ? `<p class="requests-detail__link"><a href="${esc(request.reference_url)}" target="_blank" rel="noopener noreferrer">Abrir enlace enviado por el cliente</a></p>` : ''}
      ${images ? `<div class="requests-photos">${images}</div>` : ''}
      <ul class="requests-timeline">${timeline}</ul>
      ${request.quote ? `<div class="requests-quote-read"><span>Propuesta enviada</span><strong>${money(request.quote.amount, request.quote.currency)}</strong>${request.quote.advance_amount > 0 ? `<p>Anticipo ${request.quote.advance_percent}%: ${money(request.quote.advance_amount, request.quote.currency)}</p>` : ''}${request.quote.notes ? `<p>${esc(request.quote.notes)}</p>` : ''}</div>` : ''}
      ${request.payment ? `<div class="requests-payment"><h4>Anticipo reportado por el cliente</h4><p><strong>${money(request.payment.amount, 'DOP')}</strong>${request.payment.reference ? ` · Ref. ${esc(request.payment.reference)}` : ''} · ${esc(date(request.payment.reported_at))}</p><p class="store-muted">Estado: ${esc(PAYMENT_LABEL[request.payment.status] || request.payment.status)}${request.payment.verified_at ? ` · verificado ${esc(date(request.payment.verified_at))}` : ''}${request.payment.reason ? ` · ${esc(request.payment.reason)}` : ''}</p>${request.payment.status === 'reported' ? '<div class="requests-payment__actions"><button class="btn btn--primary btn--sm" type="button" data-payment-confirm>Confirmar anticipo</button><button class="btn btn--ghost btn--sm" type="button" data-payment-reject>Rechazar</button></div>' : ''}<p class="store-muted">Confirmar el anticipo no marca el pedido como pagado: el resto se cobra por los canales normales.</p></div>` : ''}
      ${state.canManage ? `<form class="requests-form" id="request-admin-form" data-request-id="${esc(request.id)}">
        <label class="field"><span class="field__label">Estado</span><select class="field__select" name="status">${STATUSES.map(([value, label]) => `<option value="${value}" ${request.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <div class="requests-form__grid">
          <label class="field"><span class="field__label">Monto de la propuesta (RD$)</span><input class="field__input" name="quoteAmount" inputmode="decimal" placeholder="0.00" value="${esc(quoteValue)}"></label>
          <label class="field"><span class="field__label">Anticipo (%)</span><input class="field__input" name="advancePercent" type="number" min="0" max="100" step="1" value="${Number(request.quote?.advance_percent ?? 30)}"></label>
          <label class="field"><span class="field__label">Válida hasta (opcional)</span><input class="field__input" name="quoteUntil" type="date" value="${esc(request.quote?.valid_until ? String(request.quote.valid_until).slice(0, 10) : '')}"></label>
        </div>
        <label class="field"><span class="field__label">Nota de la cotización (visible al cliente)</span><textarea class="field__input" name="quoteNotes" rows="2" maxlength="1000">${esc(request.quote?.notes ?? '')}</textarea></label>
        <label class="field"><span class="field__label">Nota interna</span><textarea class="field__input" name="adminNotes" rows="2" maxlength="2000">${esc(request.admin_notes ?? '')}</textarea></label>
        <p class="store-form-error" id="request-admin-error" role="alert"></p>
        <button class="btn btn--primary btn--block" type="submit">Guardar solicitud</button>
      </form>` : '<p class="store-muted">Solo administración puede cambiar el estado o enviar una cotización.</p>'}
    </section>`;
  }

  function render() {
    const box = host();
    if (!box) return;
    const selected = state.requests.find((request) => request.id === state.selected) ?? null;
    box.innerHTML = `<div class="requests-toolbar">
      <div class="requests-filters" role="group" aria-label="Filtrar por estado">
        <button class="chip ${state.status === '' ? 'active' : ''}" type="button" data-request-status="">Todas</button>
        ${STATUSES.map(([value, label]) => `<button class="chip ${state.status === value ? 'active' : ''}" type="button" data-request-status="${value}">${label}</button>`).join('')}
      </div>
      <label class="store-search field"><span class="sr-only">Buscar solicitud</span><input class="field__input" type="search" id="requests-search" value="${esc(state.q)}" placeholder="Buscar por título o detalle" autocomplete="off"></label>
    </div>
    ${state.notice ? `<p class="store-notice" role="status">${esc(state.notice)}</p>` : ''}
    <div id="requests-detail">${selected ? detail(selected) : ''}</div>
    <div class="requests-list" role="list">${state.requests.length ? state.requests.map(card).join('') : '<p class="store-empty">No hay solicitudes con este filtro.</p>'}</div>`;
    if (selected) bindDetailForm(selected);
  }

  function bindDetailForm(request) {
    const form = document.getElementById('request-admin-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type=submit]');
      const error = document.getElementById('request-admin-error');
      button.disabled = true;
      if (error) error.textContent = '';
      const data = Object.fromEntries(new FormData(form));
      const body = { status: data.status, admin_notes: data.adminNotes };
      if (String(data.quoteAmount ?? '').trim()) {
        body.quote = {
          amount: String(data.quoteAmount).trim(),
          notes: String(data.quoteNotes ?? '').trim(),
          valid_until: String(data.quoteUntil ?? '').trim() || null,
          advance_percent: String(data.advancePercent ?? '').trim() || 30,
        };
      }
      try {
        const result = await api(`/${encodeURIComponent(request.id)}`, { method: 'PATCH', body });
        state.requests = state.requests.map((row) => (row.id === result.request.id ? { ...row, ...result.request, customer: row.customer } : row));
        state.notice = 'Solicitud actualizada.';
        render();
      } catch (submitError) {
        if (error) error.textContent = submitError.message;
        button.disabled = false;
      }
    });
  }

  document.addEventListener('click', (event) => {
    // Solo el botón del menú: `body` también lleva `data-tab`, así que un
    // `closest` suelto se quedaba con CUALQUIER clic dentro de la vista.
    const tab = event.target.closest('button[data-tab="solicitudes"]');
    if (tab) {
      state.loaded = false;
      setTimeout(() => load(true), 0);
      return;
    }
    const filter = event.target.closest('[data-request-status]');
    if (filter) {
      state.status = filter.dataset.requestStatus ?? '';
      state.selected = null;
      load(true);
      return;
    }
    const item = event.target.closest('[data-request-id]');
    if (item && !item.closest('form')) {
      state.selected = state.selected === item.dataset.requestId ? null : item.dataset.requestId;
      state.notice = '';
      render();
      return;
    }
    if (event.target.closest('[data-request-close]')) {
      state.selected = null;
      state.notice = '';
      render();
      return;
    }
    /*
     * VERIFICAR EL ANTICIPO: solo aquí se da por bueno el dinero. Nunca se
     * confirma por subir un comprobante ni por un mensaje del cliente.
     */
    const paymentButton = event.target.closest('[data-payment-confirm],[data-payment-reject]');
    if (paymentButton) {
      const request = state.requests.find((row) => row.id === state.selected);
      if (!request) return;
      const decision = paymentButton.hasAttribute('data-payment-confirm') ? 'confirmed' : 'rejected';
      const reason = decision === 'rejected' ? (window.prompt('Motivo del rechazo (opcional)') ?? '') : '';
      paymentButton.disabled = true;
      api(`/${encodeURIComponent(request.id)}`, { method: 'PATCH', body: { payment: { decision, reason } } })
        .then((result) => {
          state.requests = state.requests.map((row) => (row.id === result.request.id ? { ...row, ...result.request, customer: row.customer } : row));
          state.notice = decision === 'confirmed' ? 'Anticipo confirmado.' : 'Transferencia rechazada.';
          render();
        })
        .catch((error) => {
          paymentButton.disabled = false;
          state.notice = error.message;
          render();
        });
      return;
    }
    const photo = event.target.closest('[data-request-photo]');
    if (photo) {
      const [id, index] = photo.dataset.requestPhoto.split('/');
      const overlay = document.createElement('div');
      overlay.className = 'requests-photo-view';
      overlay.innerHTML = `<button type="button" aria-label="Cerrar foto">×</button><img src="/api/admin/store/requests/${encodeURIComponent(id)}/image/${index}" alt="Foto ampliada de la solicitud">`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'requests-search') return;
    clearTimeout(render.searchTimer);
    render.searchTimer = setTimeout(() => {
      state.q = event.target.value.trim();
      state.selected = null;
      load(true);
    }, 260);
  });

  window.addEventListener('fulltech:tab', (event) => {
    if (event.detail?.tab !== 'solicitudes') return;
    state.loaded = false;
    load(true);
  });

  setInterval(() => {
    if (document.body.dataset.tab === 'solicitudes' && document.visibilityState === 'visible' && !state.loading) load();
  }, 15000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.tab === 'solicitudes') load(true);
  });
  else if (document.body.dataset.tab === 'solicitudes') load(true);
})();
