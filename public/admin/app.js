/*
 * Panel de Phytoemagry (mini-CRM) — lógica del panel.
 *
 * Sin framework y sin dependencias: un archivo, servido desde el propio dominio.
 * Todo pasa por `/api/admin/*` (con la cookie de sesión) y funciona con el
 * service worker: si el móvil se queda sin datos, el panel abre con la última
 * copia y los cambios se envían solos al recuperar la conexión.
 */

(() => {
  'use strict';

  const SNAPSHOT_KEY = 'pe_crm_snapshot';
  const OUTBOX_KEY = 'pe_crm_outbox';
  const TAB_KEY = 'pe_crm_tab';
  const NEGOCIO = 'Phytoemagry';

  /** Estado en memoria del panel. */
  const state = {
    items: [],
    messages: [],
    stats: null,
    statuses: [],
    tab: localStorage.getItem(TAB_KEY) ?? 'hoy',
    filter: 'todos',
    q: '',
    openId: null,
    online: navigator.onLine,
    syncedAt: null,
  };

  // ------------------------------------------------------------------ helpers

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  /** Fecha-hora corta en español (la del teléfono es la del negocio). */
  const fmtWhen = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `hace ${hours} h`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'ayer';
    if (days < 7) return `hace ${days} días`;
    return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short' }).format(date);
  };

  /** `YYYY-MM-DD` de hoy en el reloj del teléfono. */
  const todayISO = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };

  const addDaysISO = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  const fmtDay = (day) => {
    if (!day) return '';
    const [year, month, date] = day.split('-').map(Number);
    const value = new Date(year, month - 1, date);
    const label = new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: 'numeric', month: 'short' }).format(value);
    const today = todayISO();
    if (day === today) return `hoy · ${label}`;
    if (day < today) return `vencido · ${label}`;
    return label;
  };

  const money = (value, currency = 'DOP') =>
    value === null || value === undefined
      ? '—'
      : `${currency} ${new Intl.NumberFormat('es-DO', { maximumFractionDigits: 0 }).format(value)}`;

  const digits = (phone) => String(phone ?? '').replace(/\D/g, '');

  let toastTimer = null;
  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, 3200);
  }

  // ---------------------------------------------------------------------- API

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      showLogin('Tu sesión ha caducado. Vuelve a entrar.');
      throw new Error('unauthorized');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.message ?? body.error ?? 'error'), { body });
    return body;
  }

  // ------------------------------------------------------- copia local (offline)

  function saveSnapshot() {
    try {
      localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ items: state.items, messages: state.messages, stats: state.stats, at: Date.now() }),
      );
    } catch {
      /* sin espacio: el panel sigue funcionando en línea */
    }
  }

  function readSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const readOutbox = () => {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]');
    } catch {
      return [];
    }
  };

  const writeOutbox = (list) => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    renderOutboxBanner();
  };

  /** Cambio que no se pudo enviar (sin red): se aplica en pantalla y se reintenta. */
  function queuePatch(id, patch) {
    const outbox = readOutbox().filter((entry) => entry.id !== id);
    const previous = readOutbox().find((entry) => entry.id === id)?.patch ?? {};
    outbox.push({ id, patch: { ...previous, ...patch }, at: Date.now() });
    writeOutbox(outbox);
  }

  async function flushOutbox() {
    const outbox = readOutbox();
    if (outbox.length === 0 || !state.online) return;
    const pending = [];
    for (const entry of outbox) {
      try {
        await api(`/api/admin/items/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(entry.patch),
        });
      } catch (error) {
        if (error.message !== 'unauthorized') pending.push(entry);
      }
    }
    writeOutbox(pending);
    if (pending.length === 0) toast('Cambios enviados');
    else return;
    await load({ keepTab: true });
  }

  // ------------------------------------------------------------------ sesión

  function showLogin(message = '') {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message;
    $('#login-token').focus({ preventScroll: true });
  }

  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    setTab(state.tab, { silent: true });
  }

  async function checkSession() {
    try {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      return Boolean(body.ok);
    } catch {
      // Sin red no se puede preguntar: no significa que la sesión no valga.
      return false;
    }
  }

  // -------------------------------------------------------------------- datos

  async function load(options = {}) {
    try {
      const data = await api('/api/admin/data');
      state.items = data.items ?? [];
      state.messages = data.messages ?? [];
      state.stats = data.stats ?? null;
      state.statuses = data.statuses ?? [];
      state.syncedAt = Date.now();
      saveSnapshot();
      render();
      if (!options.keepTab) await flushOutbox();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      const snapshot = readSnapshot();
      if (snapshot) {
        state.items = snapshot.items ?? [];
        state.messages = snapshot.messages ?? [];
        state.stats = snapshot.stats ?? null;
        state.syncedAt = snapshot.at ?? null;
        toast('Sin conexión: datos guardados en el teléfono');
        render();
      } else {
        toast('No se pudieron cargar los datos');
      }
    }
  }

  /**
   * El API habla `nextActionAt`; el panel pinta `next_action_at`. Traducir aquí
   * evita el fallo clásico: guardar bien en el servidor y no verse en pantalla.
   */
  const STATE_FIELDS = {
    status: 'status',
    notes: 'notes',
    nextActionAt: 'next_action_at',
    lastContactAt: 'last_contact_at',
  };

  function toStatePatch(patch) {
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
      const field = STATE_FIELDS[key];
      if (field) out[field] = value;
    }
    if (patch.contacted) out.last_contact_at = new Date().toISOString();
    return out;
  }

  /** Cambios pendientes aplicados en pantalla (mientras no hay red). */
  function applyOutbox(items) {
    const outbox = readOutbox();
    if (outbox.length === 0) return items;
    return items.map((item) => {
      const entry = outbox.find((candidate) => candidate.id === item.id);
      return entry ? { ...item, ...toStatePatch(entry.patch) } : item;
    });
  }

  async function patchItem(id, patch, message) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    Object.assign(item, toStatePatch(patch));
    render();
    try {
      await api(`/api/admin/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (message) toast(message);
      saveSnapshot();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      queuePatch(id, patch);
      toast('Se enviará cuando vuelva la conexión');
    }
    if (state.openId === id) renderSheet();
    await refreshStats();
  }

  /** Recalcula los contadores en el cliente (respuesta inmediata al tocar). */
  async function refreshStats() {
    const items = state.items;
    const today = todayISO();
    const open = items.filter((item) => !['entregado', 'perdido'].includes(item.status ?? 'nuevo'));
    const conRecordatorio = open.filter((item) => item.next_action_at);
    state.stats = {
      ...(state.stats ?? {}),
      total: items.length,
      nuevos: items.filter((item) => (item.status ?? 'nuevo') === 'nuevo').length,
      hoy: conRecordatorio.filter((item) => item.next_action_at <= today).length,
      atrasados: conRecordatorio.filter((item) => item.next_action_at < today).length,
      pedidos: open.filter((item) => item.type === 'order_intent').length,
      entregados: items.filter((item) => item.status === 'entregado').length,
      valorAbierto: open.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
      valorCobrado: items
        .filter((item) => item.status === 'entregado')
        .reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    };
    renderStats();
    updateBadge();
  }

  // -------------------------------------------------------------- plantillas

  function fillTemplate(body, item) {
    const values = {
      nombre: item?.name ?? 'cliente',
      // Un contacto sin frasco no debe leer "el frasco de nuestros frascos".
      frasco: item?.variant_name ?? 'Phytoemagry',
      cantidad: item?.quantity ?? '',
      total: item?.total ? money(item.total, item.currency) : '',
      negocio: NEGOCIO,
    };
    return String(body)
      .replaceAll(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
      .replace(/\s*\(\s*\)/g, '') // "()" de un dato que no existe
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function whatsappUrl(item, body) {
    const phone = digits(item.phone);
    const text = encodeURIComponent(fillTemplate(body, item));
    return phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
  }

  /** Abre WhatsApp en una pestaña nueva (con `<a>`: los bloqueadores no lo cortan). */
  function openWhatsApp(item, body) {
    const link = document.createElement('a');
    link.href = whatsappUrl(item, body);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
    // Escribir ES contactar: queda registrado para los recordatorios.
    const patch = { contacted: true };
    if (!item.status || item.status === 'nuevo') patch.status = 'contactado';
    patchItem(item.id, patch);
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderStats();
    renderHoy();
    renderClientes();
    renderMensajes();
    renderAjustes();
    updateBadge();
    renderOutboxBanner();
  }

  const label = (type) => (type === 'order_intent' ? 'Pedido' : 'Contacto');
  const statusLabel = (value) => state.statuses.find((entry) => entry.value === value)?.label ?? value;

  function renderStats() {
    const stats = state.stats ?? {};
    const cards = [
      { key: 'hoy', label: 'Para hoy', value: stats.hoy ?? 0, alert: (stats.hoy ?? 0) > 0, filter: 'hoy' },
      { key: 'atrasados', label: 'Atrasados', value: stats.atrasados ?? 0, alert: (stats.atrasados ?? 0) > 0, filter: 'atrasados' },
      { key: 'nuevos', label: 'Sin contactar', value: stats.nuevos ?? 0, filter: 'nuevos' },
      { key: 'pedidos', label: 'Pedidos abiertos', value: stats.pedidos ?? 0, filter: 'pedidos' },
    ];
    $('#stats').innerHTML = cards
      .map(
        (card) => `<button class="stat ${card.alert ? 'stat--alert' : ''}" data-stat="${card.filter}" type="button">
            <span class="stat__value">${card.value}</span>
            <span class="stat__label">${escapeHtml(card.label)}</span>
          </button>`,
      )
      .join('');
  }

  function itemCard(item) {
    const today = todayISO();
    const vencido = item.next_action_at && item.next_action_at <= today && !['entregado', 'perdido'].includes(item.status);
    const cerrado = ['entregado', 'perdido'].includes(item.status);
    const phone = digits(item.phone);
    return `<article class="item ${item.type === 'order_intent' ? 'item--pedido' : ''} ${
      vencido ? 'item--hoy' : ''
    } ${cerrado ? 'item--cerrado' : ''}" data-open="${escapeHtml(item.id)}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(item.name ?? 'Sin nombre')}</p>
            <span class="tag tag--${escapeHtml(item.status ?? 'nuevo')}">${escapeHtml(statusLabel(item.status ?? 'nuevo'))}</span>
            ${item.type === 'order_intent' ? '<span class="tag">Pedido</span>' : '<span class="tag">Contacto</span>'}
            ${
              item.next_action_at
                ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(item.next_action_at))}</span>`
                : ''
            }
          </div>
          <span class="item__when">${escapeHtml(fmtWhen(item.received_at))}</span>
        </div>
        <p class="item__meta">
          ${item.variant_name ? `${escapeHtml(item.variant_name)}${item.quantity ? ` ×${item.quantity}` : ''} · ` : ''}
          ${item.total ? `${money(item.total, item.currency)} · ` : ''}
          ${item.phone ? escapeHtml(item.phone) : 'sin teléfono'}
          ${item.location ? ` · ${escapeHtml(item.location)}` : ''}
        </p>
        ${item.notes ? `<p class="item__notes">📝 ${escapeHtml(item.notes)}</p>` : ''}
        <div class="item__actions">
          ${
            phone
              ? `<button class="btn btn--whatsapp btn--sm" data-wa="${escapeHtml(item.id)}" type="button">Escribir por WhatsApp</button>`
              : '<button class="btn btn--ghost btn--sm" type="button" disabled>Cliente escribió primero</button>'
          }
          <button class="btn btn--ghost btn--sm" data-open="${escapeHtml(item.id)}" type="button">Abrir ficha</button>
        </div>
      </article>`;
  }

  const emptyState = (text) => `<p class="empty">${escapeHtml(text)}</p>`;

  function renderHoy() {
    const today = todayISO();
    const pendientes = state.items
      .filter(
        (item) =>
          item.next_action_at &&
          item.next_action_at <= today &&
          !['entregado', 'perdido'].includes(item.status ?? 'nuevo'),
      )
      .sort((a, b) => String(a.next_action_at).localeCompare(String(b.next_action_at)));

    // Los que ya salen arriba no se repiten abajo (ver al mismo cliente dos veces
    // en la misma pantalla hace dudar de si son dos cosas distintas).
    const yaListados = new Set(pendientes.map((item) => item.id));
    const nuevos = state.items
      .filter((item) => (item.status ?? 'nuevo') === 'nuevo' && !yaListados.has(item.id))
      .slice(0, 5);
    const bloque = [
      pendientes.length
        ? `<h2 class="view__title">Recordatorios de hoy</h2><div class="list">${pendientes.map(itemCard).join('')}</div>`
        : '',
      nuevos.length
        ? `<h2 class="view__title">Nuevos sin contactar</h2><div class="list">${nuevos.map(itemCard).join('')}</div>`
        : '',
    ]
      .filter(Boolean)
      .join('');

    $('#list-hoy').innerHTML =
      bloque || emptyState('Todo al día 👌 Cuando alguien deje sus datos o pida algo, aparecerá aquí.');
  }

  function filteredItems() {
    const { filter, q } = state;
    const today = todayISO();
    let items = state.items.slice();
    if (filter === 'nuevos') items = items.filter((item) => (item.status ?? 'nuevo') === 'nuevo');
    if (filter === 'pedidos') items = items.filter((item) => item.type === 'order_intent');
    if (filter === 'recordatorio') items = items.filter((item) => item.next_action_at);
    if (filter === 'hoy') items = items.filter((item) => item.next_action_at && item.next_action_at <= today);
    if (filter === 'entregados') items = items.filter((item) => item.status === 'entregado');
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((item) =>
        [item.name, item.phone, item.location, item.variant_name, item.notes]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    return items;
  }

  function renderClientes() {
    const items = applyOutbox(filteredItems());
    $('#clientes-count').textContent = `${items.length} de ${state.items.length} registros`;
    $('#list-clientes').innerHTML = items.length
      ? items.map(itemCard).join('')
      : emptyState('No hay nada con este filtro.');
  }

  /** Plantilla marcada para borrar (segundo toque confirma). */
  let pendingDelete = null;

  function renderMensajes() {
    const list = state.messages.length
      ? state.messages
          .map(
            (message) => `<article class="item">
              <p class="item__name">${escapeHtml(message.name)}</p>
              <p class="item__meta">${escapeHtml(message.body)}</p>
              <div class="item__actions">
                <button class="btn btn--ghost btn--sm" data-edit-message="${escapeHtml(message.id)}" type="button">Editar</button>
                <button class="btn ${pendingDelete === message.id ? 'btn--danger' : 'btn--ghost'} btn--sm" data-del-message="${escapeHtml(
                  message.id,
                )}" type="button">${pendingDelete === message.id ? '¿Seguro? Toca otra vez' : 'Borrar'}</button>
              </div>
            </article>`,
          )
          .join('')
      : emptyState('No hay plantillas todavía.');
    $('#list-mensajes').innerHTML = list;
  }

  function renderAjustes() {
    const stats = state.stats ?? {};
    const outbox = readOutbox().length;
    $('#facts').innerHTML = [
      ['Registros', stats.total ?? state.items.length],
      ['Sin contactar', stats.nuevos ?? 0],
      ['Para hoy / atrasados', `${stats.hoy ?? 0} / ${stats.atrasados ?? 0}`],
      ['Valor abierto', money(stats.valorAbierto ?? 0)],
      ['Valor entregado', money(stats.valorCobrado ?? 0)],
      ['Cambios pendientes', outbox],
      [
        'Última actualización',
        state.syncedAt ? new Intl.DateTimeFormat('es-DO', { timeStyle: 'short' }).format(state.syncedAt) : '—',
      ],
    ]
      .map(([key, value]) => `<div class="fact"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join('');
    $('#build-info').textContent = `${state.items.length} registros · ${
      state.online ? 'en línea' : 'sin conexión'
    } · v1`;
  }

  // ------------------------------------------------------------------ ficha

  function renderSheet() {
    const item = state.items.find((candidate) => candidate.id === state.openId);
    if (!item) {
      $('#sheet').hidden = true;
      return;
    }
    const phone = digits(item.phone);
    const reminders = [
      { label: 'Hoy', days: 0 },
      { label: 'Mañana', days: 1 },
      { label: '3 días', days: 3 },
      { label: '1 semana', days: 7 },
    ];
    $('#sheet-title').textContent = item.name ?? label(item.type);
    $('#sheet-body').innerHTML = `
      <div>
        <span class="tag tag--${escapeHtml(item.status ?? 'nuevo')}">${escapeHtml(statusLabel(item.status ?? 'nuevo'))}</span>
        <span class="tag">${escapeHtml(label(item.type))}</span>
        ${item.next_action_at ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(item.next_action_at))}</span>` : ''}
      </div>

      <dl class="facts">
        ${item.phone ? `<div class="fact"><dt>Teléfono</dt><dd><a href="tel:${escapeHtml(phone)}">${escapeHtml(item.phone)}</a></dd></div>` : ''}
        ${item.location ? `<div class="fact"><dt>Ciudad</dt><dd>${escapeHtml(item.location)}</dd></div>` : ''}
        ${item.variant_name ? `<div class="fact"><dt>Frasco</dt><dd>${escapeHtml(item.variant_name)}</dd></div>` : ''}
        ${item.quantity ? `<div class="fact"><dt>Frascos</dt><dd>${escapeHtml(item.quantity)}</dd></div>` : ''}
        ${item.total ? `<div class="fact"><dt>Total</dt><dd>${money(item.total, item.currency)}</dd></div>` : ''}
        <div class="fact"><dt>Entrada</dt><dd>${escapeHtml(fmtWhen(item.received_at))}</dd></div>
        ${item.source ? `<div class="fact"><dt>Origen</dt><dd>${escapeHtml(item.source)}</dd></div>` : ''}
        ${
          item.last_contact_at
            ? `<div class="fact"><dt>Último contacto</dt><dd>${escapeHtml(fmtWhen(item.last_contact_at))}</dd></div>`
            : ''
        }
      </dl>

      <label class="field">
        <span class="field__label">Estado</span>
        <select class="field__select" id="sheet-status">
          ${state.statuses
            .map(
              (status) =>
                `<option value="${escapeHtml(status.value)}" ${
                  status.value === (item.status ?? 'nuevo') ? 'selected' : ''
                }>${escapeHtml(status.label)}</option>`,
            )
            .join('')}
        </select>
      </label>

      <div class="field">
        <span class="field__label">Recordatorio</span>
        <div class="item__actions" style="margin-top:0">
          ${reminders
            .map(
              (option) =>
                `<button class="chip" data-remind="${option.days}" data-id="${escapeHtml(item.id)}" type="button">${option.label}</button>`,
            )
            .join('')}
          <button class="chip" data-remind="clear" data-id="${escapeHtml(item.id)}" type="button">Quitar</button>
        </div>
        <input class="field__input" type="date" id="sheet-date" value="${escapeHtml(item.next_action_at ?? '')}" />
      </div>

      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="sheet-notes" placeholder="Qué dijo, cuándo pagar, a qué hora llamar…">${escapeHtml(item.notes ?? '')}</textarea>
      </label>
      <button class="btn btn--primary btn--block" id="sheet-save" type="button">Guardar notas</button>

      <div class="field">
        <span class="field__label">Mensaje de WhatsApp</span>
        <select class="field__select" id="sheet-template">
          ${state.messages
            .map((message) => `<option value="${escapeHtml(message.id)}">${escapeHtml(message.name)}</option>`)
            .join('')}
        </select>
        <p class="view__hint" id="sheet-preview"></p>
        <button class="btn btn--whatsapp btn--block" id="sheet-wa" type="button">Escribir por WhatsApp</button>
      </div>

      ${phone ? `<a class="btn btn--ghost btn--block" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}
    `;
    $('#sheet').hidden = false;
    updatePreview();

    $('#sheet-status').addEventListener('change', (event) => {
      patchItem(item.id, { status: event.target.value }, `Estado: ${statusLabel(event.target.value)}`);
    });
    $('#sheet-date').addEventListener('change', (event) => {
      patchItem(item.id, { nextActionAt: event.target.value }, event.target.value ? 'Recordatorio guardado' : 'Recordatorio quitado');
    });
    $('#sheet-save').addEventListener('click', () => {
      patchItem(item.id, { notes: $('#sheet-notes').value }, 'Notas guardadas');
    });
    $('#sheet-template').addEventListener('change', updatePreview);
    $('#sheet-wa').addEventListener('click', () => {
      const message = state.messages.find((entry) => entry.id === $('#sheet-template').value);
      openWhatsApp(item, message?.body ?? 'Hola {nombre}, te escribo de {negocio}.');
    });
    $$('[data-remind]', $('#sheet')).forEach((button) => {
      button.addEventListener('click', () => {
        const days = button.dataset.remind;
        const value = days === 'clear' ? '' : addDaysISO(Number(days));
        patchItem(item.id, { nextActionAt: value }, value ? `Recordatorio: ${fmtDay(value)}` : 'Recordatorio quitado');
      });
    });
  }

  function updatePreview() {
    const item = state.items.find((candidate) => candidate.id === state.openId);
    const message = state.messages.find((entry) => entry.id === $('#sheet-template')?.value);
    const preview = $('#sheet-preview');
    if (preview && message && item) preview.textContent = fillTemplate(message.body, item);
  }

  // ------------------------------------------------------------------ PWA

  function updateBadge() {
    const pendientes = (state.stats?.hoy ?? 0) + (state.stats?.nuevos ?? 0);
    const badge = $('#badge-hoy');
    badge.hidden = pendientes === 0;
    badge.textContent = pendientes;
    if (navigator.setAppBadge) navigator.setAppBadge(pendientes).catch(() => {});
  }

  function renderOutboxBanner() {
    const count = readOutbox().length;
    const banner = $('#outbox-banner');
    banner.hidden = count === 0;
    banner.textContent = count
      ? `${count} cambio(s) pendientes de enviar. Se enviarán solos cuando vuelva la conexión.`
      : '';
  }

  function setConnection(online) {
    state.online = online;
    const pill = $('#state-pill');
    pill.hidden = false;
    pill.textContent = online ? 'en línea' : 'sin conexión';
    pill.classList.toggle('pill--offline', !online);
    $('#offline-banner').hidden = online;
    if (online) flushOutbox();
  }

  let installEvent = null;

  function initPwa() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {});
    }

    window.addEventListener('online', () => setConnection(true));
    window.addEventListener('offline', () => setConnection(false));
    setConnection(navigator.onLine);

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installEvent = event;
      $('#install-card').hidden = false;
      $('#install').hidden = false; // el navegador puede instalarla por nosotros
    });

    $('#install').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      const choice = await installEvent.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        $('#install-card').hidden = true;
        toast('Instalada: búscala en tu pantalla de inicio');
      }
      installEvent = null;
    });

    // Instalada (o en iPhone, que no avisa): solo las instrucciones manuales.
    if (window.matchMedia('(display-mode: standalone)').matches) $('#install-card').hidden = true;
    else $('#install').hidden = !installEvent;
  }

  // ------------------------------------------------------------------- tabs

  function setTab(tab, options = {}) {
    state.tab = tab;
    localStorage.setItem(TAB_KEY, tab);
    $$('[data-tab]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.tab === tab)));
    ['hoy', 'clientes', 'mensajes', 'ajustes'].forEach((name) => {
      $(`#view-${name}`).hidden = name !== tab;
    });
    if (!options.silent) window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------- eventos

  function initEvents() {
    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = $('#login-token').value.trim();
      if (!token) return;
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ token }) });
        $('#login-token').value = '';
        showApp();
        await load();
      } catch (error) {
        $('#login-error').hidden = false;
        $('#login-error').textContent = error.body?.message ?? 'No se pudo entrar.';
      }
    });

    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));

    $('#refresh').addEventListener('click', async () => {
      await load({ keepTab: true });
      toast('Datos actualizados');
    });

    $('#search').addEventListener('input', (event) => {
      state.q = event.target.value.trim();
      renderClientes();
    });

    $('#chips').innerHTML = [
      ['todos', 'Todos'],
      ['nuevos', 'Sin contactar'],
      ['pedidos', 'Pedidos'],
      ['recordatorio', 'Con recordatorio'],
      ['hoy', 'Para hoy'],
      ['entregados', 'Entregados'],
    ]
      .map(
        ([value, text]) =>
          `<button class="chip" data-filter="${value}" aria-pressed="${value === state.filter}" type="button">${text}</button>`,
      )
      .join('');

    $('#chips').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      $$('[data-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)),
      );
      renderClientes();
    });

    $('#stats').addEventListener('click', (event) => {
      const card = event.target.closest('[data-stat]');
      if (!card) return;
      state.filter = card.dataset.stat === 'atrasados' ? 'hoy' : card.dataset.stat;
      $$('[data-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)),
      );
      setTab('clientes');
      renderClientes();
    });

    document.addEventListener('click', (event) => {
      /*
       * El orden importa: el botón de WhatsApp vive DENTRO de la tarjeta, que
       * también es táctil. Si se comprobara `data-open` primero, pulsar
       * "Escribir por WhatsApp" abriría la ficha en vez de escribir.
       */
      const wa = event.target.closest('[data-wa]');
      if (wa) {
        const item = state.items.find((candidate) => candidate.id === wa.dataset.wa);
        if (item) {
          const message = state.messages[0];
          openWhatsApp(item, message?.body ?? 'Hola {nombre}, te escribo de {negocio}.');
        }
        return;
      }
      const open = event.target.closest('[data-open]');
      if (open) {
        state.openId = open.dataset.open;
        renderSheet();
        return;
      }
      const del = event.target.closest('[data-del-message]');
      if (del) {
        const id = del.dataset.delMessage;
        // Dos toques: borrar una plantilla al primer roce sería un error caro.
        if (pendingDelete !== id) {
          pendingDelete = id;
          renderMensajes();
          toast('Toca otra vez para borrar');
          return;
        }
        pendingDelete = null;
        api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then((body) => {
            state.messages = body.messages;
            renderMensajes();
            toast('Plantilla borrada');
          })
          .catch(() => toast('No se pudo borrar'));
        return;
      }
      const edit = event.target.closest('[data-edit-message]');
      if (edit) {
        openMessageForm(state.messages.find((message) => message.id === edit.dataset.editMessage));
        return;
      }
      if (event.target.closest('[data-close-sheet]')) {
        state.openId = null;
        $('#sheet').hidden = true;
      }
    });

    $('#nueva-plantilla').addEventListener('click', () => openMessageForm(null));

    $('#logout').addEventListener('click', async () => {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
      showLogin('Sesión cerrada.');
    });
  }

  /** Formulario de plantilla (alta o edición) dentro de la hoja inferior. */
  function openMessageForm(message) {
    state.openId = null;
    $('#sheet-title').textContent = message ? 'Editar plantilla' : 'Nueva plantilla';
    $('#sheet-body').innerHTML = `
      <label class="field">
        <span class="field__label">Nombre</span>
        <input class="field__input" id="msg-name" value="${escapeHtml(message?.name ?? '')}" placeholder="Recordatorio de entrega" />
      </label>
      <label class="field">
        <span class="field__label">Texto del mensaje</span>
        <textarea class="field__area" id="msg-body" placeholder="Hola {nombre}, …">${escapeHtml(message?.body ?? '')}</textarea>
      </label>
      <p class="view__hint">Variables: {nombre} · {frasco} · {cantidad} · {total} · {negocio}</p>
      <button class="btn btn--primary btn--block" id="msg-save" type="button">Guardar plantilla</button>
    `;
    $('#sheet').hidden = false;
    $('#msg-save').addEventListener('click', async () => {
      const name = $('#msg-name').value.trim();
      const body = $('#msg-body').value.trim();
      if (!name || !body) {
        toast('Hacen falta nombre y texto');
        return;
      }
      try {
        const result = await api('/api/admin/messages', {
          method: 'POST',
          body: JSON.stringify({ id: message?.id, name, body, position: message?.position ?? 99 }),
        });
        state.messages = result.messages;
        renderMensajes();
        $('#sheet').hidden = true;
        toast('Plantilla guardada');
      } catch {
        toast('No se pudo guardar');
      }
    });
  }

  // --------------------------------------------------------------- arranque

  async function boot() {
    initEvents();
    initPwa();

    // Atajos del icono instalado (manifest → shortcuts): /admin/?v=clientes
    const wanted = new URLSearchParams(location.search).get('v');
    if (['hoy', 'clientes', 'mensajes', 'ajustes'].includes(wanted)) state.tab = wanted;

    /*
     * Sin conexión NO se puede comprobar la sesión, pero el panel ya estuvo
     * abierto antes en este teléfono: se muestra con la última copia en vez de
     * pedir la clave a alguien que está en la calle sin datos.
     */
    const cached = readSnapshot();
    if (!navigator.onLine && cached) {
      showApp();
      await load({ keepTab: true });
      toast('Sin conexión: datos guardados en el teléfono');
      return;
    }

    if (await checkSession()) {
      showApp();
      await load();
    } else if (cached) {
      // El servidor no contesta (o la sesión caducó): si hay copia, se enseña.
      showApp();
      await load({ keepTab: true });
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
