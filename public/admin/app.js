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
  const WA_NOTIFY_KEY = 'pe_wa_notify';
  const WA_SOUND_KEY = 'pe_wa_sound';
  const NEGOCIO = 'Phytoemagry';

  /** Estado en memoria del panel. */
  const state = {
    items: [],
    messages: [],
    // Clientes unificados (una persona = un cliente, venga de donde venga).
    customers: [],
    conversations: [],
    followups: null,
    hoy: null,
    catalog: [],
    inventory: null,
    salesReport: null,
    salesReportPeriod: 'hoy',
    whatsapp: null,
    templates: [],
    stats: null,
    statuses: [],
    // Ventas (S4/S5/S6): cola de programados, ajustes, estados y auditoría.
    scheduled: null,
    settings: null,
    commercial: null,
    orderStatuses: [],
    audit: null,
    media: null,
    auth: null,
    users: [],
    metrics: null,
    metricsPeriod: '30d',
    orderId: null,
    tab: localStorage.getItem(TAB_KEY) ?? 'hoy',
    filter: 'todos',
    q: '',
    openId: null,
    customerId: null,
    chat: null,
    // Bandeja de WhatsApp: conversación abierta, filtros y estado de la carga.
    wa: {
      selectedId: null,
      filter: 'todos',
      q: '',
      chat: null,
      draft: '',
      listSig: null,
      chatSig: null,
      counts: null,
      selected: new Set(),
      notify: localStorage.getItem(WA_NOTIFY_KEY) === '1',
      sound: localStorage.getItem(WA_SOUND_KEY) === '1',
      seenMessages: new Set(),
      loadingFor: null,
      followupId: null,
      listError: false,
      threadError: false,
    },
    online: navigator.onLine,
    syncedAt: null,
    drawer: false,
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

  /*
   * ICONOS — UN solo sistema visual: trazos SVG de 24x24 (nada de emojis
   * mezclados con iconos, nada de estilos distintos por pantalla).
   *
   * Los que viven en el HTML estático se pintan al arrancar con `paintIcons()`:
   * así la forma de cada icono se define UNA vez, aquí.
   */
  const svg = (paths) =>
    `<svg class="svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" `+
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

  const ICONS = {
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>'),
    chat: svg('<path d="M21 11.6a8 8 0 0 1-8 8H8.2L3 22.5l1.3-4.4A8 8 0 1 1 21 11.6z"/>'),
    users: svg('<path d="M15.5 20v-1.4a4 4 0 0 0-4-4H7.2a4 4 0 0 0-4 4V20"/><circle cx="9.3" cy="7.6" r="3.1"/><path d="M17.4 15.4a3.9 3.9 0 0 1 2.6 3.7V20M15.8 4.6a3.1 3.1 0 0 1 0 6"/>'),
    box: svg('<path d="M20.5 8.4v7.2L12 20.4l-8.5-4.8V8.4L12 3.6z"/><path d="M3.5 8.4 12 13l8.5-4.6M12 13v7.4"/>'),
    chart: svg('<path d="M4 19.5h16"/><path d="M7 16v-5M12 16V6.5M17 16v-8"/>'),
    bell: svg('<path d="M18 15.2V10a6 6 0 1 0-12 0v5.2L4 18.6h16z"/><path d="M10 21.4h4"/>'),
    note: svg('<path d="M8 3.5h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M9.2 8h5.6M9.2 12h5.6M9.2 16h3.4"/>'),
    /* Ajustes = mandos que se deslizan (un engranaje aquí se confundía con el sol de Hoy). */
    gear: svg('<path d="M4 7.4h9M17.4 7.4H20M4 16.6h2.6M11 16.6h9"/><circle cx="15.2" cy="7.4" r="2.2"/><circle cx="8.8" cy="16.6" r="2.2"/>'),
    close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    back: svg('<path d="M14.5 19l-7-7 7-7"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    mic: svg('<rect x="9.2" y="2.8" width="5.6" height="10.8" rx="2.8"/><path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0"/><path d="M12 17.4V21M9.4 21h5.2"/>'),
    send: svg('<path d="M4.6 12 20 4.6l-7.3 15-1.9-6.3z"/><path d="M10.8 13.3 20 4.6"/>'),
    spark: svg('<path d="M11.4 3.6l1.8 4.9 4.9 1.8-4.9 1.8-1.8 4.9-1.8-4.9L4.7 10.3l4.9-1.8z"/><path d="M18.4 15.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>'),
    bag: svg('<path d="M4.6 7.4h14.8l-1.2 11.9a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8z"/><path d="M8.8 7.4V5.8a3.2 3.2 0 0 1 6.4 0v1.6"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.9"/>'),
    person: svg('<circle cx="12" cy="7.9" r="3.9"/><path d="M4.8 20.4c1.3-3.3 4-4.9 7.2-4.9s5.9 1.6 7.2 4.9"/>'),
    image: svg('<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><circle cx="9" cy="10" r="1.6"/><path d="M3.6 17.2l4.9-4.9 4.4 4.4 2.8-2.7 4.7 4.6"/>'),
    audio: svg('<path d="M4 13.6v-3.2M8 17V7M12 20V4M16 16.4v-8.8M20 13.4v-2.8"/>'),
    doc: svg('<path d="M7.2 3.4h6.3l5 5V20.6H7.2z"/><path d="M13.2 3.4v5.2h5.3"/>'),
    video: svg('<rect x="3.2" y="6.2" width="11.6" height="11.6" rx="2.6"/><path d="M15 11.2l5.8-3.4v8.4L15 12.8z"/>'),
    tagIcon: svg('<path d="M4.4 12.6V5.2a.8.8 0 0 1 .8-.8h7.4l7.2 7.2-8.2 8.2z"/><circle cx="8.7" cy="8.7" r="1.3"/>'),
    pin: svg('<path d="M12 20.8s6.2-5.8 6.2-10.6a6.2 6.2 0 1 0-12.4 0C5.8 15 12 20.8 12 20.8z"/><circle cx="12" cy="10" r="2.3"/>'),
    retry: svg('<path d="M19.6 12a7.6 7.6 0 1 1-2.5-5.6"/><path d="M19.8 4.4v4.2h-4.2"/>'),
  };

  /** Pinta los iconos declarados en el HTML (`data-icon="..."`). */
  function paintIcons(root = document) {
    $$('[data-icon]', root).forEach((slot) => {
      const art = ICONS[slot.dataset.icon];
      if (art) slot.innerHTML = art;
    });
  }

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

    // La respuesta puede NO ser JSON: si el CRM no está en marcha, delante
    // contesta el servidor de ficheros y devuelve un 404 en HTML. Sin mirar el
    // texto, el panel decía "No se pudo entrar." sin ninguna pista.
    const raw = await response.text();
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: disconnectedMessage(response) };
      }
    }

    if (response.status === 401) {
      showLogin(body.message ?? 'Tu sesión ha caducado. Vuelve a entrar.');
      throw Object.assign(new Error('unauthorized'), { body });
    }
    if (!response.ok) throw Object.assign(new Error(body.message ?? 'error'), { body });
    return body;
  }

  /**
   * Qué contestar cuando el CRM no contesta.
   *
   * @param {Response} response
   * @returns {string}
   */
  function disconnectedMessage(response) {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return 'El CRM no está encendido. Arráncalo con «npm run crm» (o con el botón del servidor) y vuelve a intentarlo.';
    }
    return `El panel no está conectado con el CRM (respuesta ${response.status}). Comprueba que el API responda en /api/health.`;
  }

  // ------------------------------------------------------- copia local (offline)

  function saveSnapshot() {
    try {
      localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({
          items: state.items,
          messages: state.messages,
          customers: state.customers,
          conversations: state.conversations,
          followups: state.followups,
          hoy: state.hoy,
          catalog: state.catalog,
          inventory: state.inventory,
          whatsapp: state.whatsapp,
          stats: state.stats,
          at: Date.now(),
        }),
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
    ($('#login-username') ?? $('#login-token')).focus({ preventScroll: true });
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
      if (body.ok) state.auth = { user: body.user ?? null, legacy: body.legacy === true };
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
      state.customers = data.customers ?? [];
      state.conversations = data.conversations ?? [];
      state.wa.counts = data.conversationCounts ?? state.wa.counts;
      for (const row of state.conversations) {
        if (row.last_message?.direction === 'inbound') state.wa.seenMessages.add(`${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`);
      }
      state.followups = data.followups ?? null;
      state.hoy = data.hoy ?? null;
      state.catalog = data.catalog ?? [];
      state.inventory = data.inventory ?? null;
      state.whatsapp = data.whatsapp ?? null;
      state.stats = data.stats ?? null;
      state.statuses = data.statuses ?? [];
      state.meta = data.meta ?? null;
      state.scheduled = data.scheduled ?? null;
      state.settings = data.settings ?? null;
      state.commercial = data.commercial ?? null;
      state.orderStatuses = data.orderStatuses ?? [];
      state.audit = data.audit ?? null;
      state.media = data.media ?? null;
      state.auth = data.auth ?? null;
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
        state.customers = snapshot.customers ?? [];
        state.conversations = snapshot.conversations ?? [];
        for (const row of state.conversations) {
          if (row.last_message?.direction === 'inbound') state.wa.seenMessages.add(`${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`);
        }
        state.followups = snapshot.followups ?? null;
        state.hoy = snapshot.hoy ?? null;
        state.catalog = snapshot.catalog ?? [];
        state.inventory = snapshot.inventory ?? null;
        state.whatsapp = snapshot.whatsapp ?? null;
        state.stats = snapshot.stats ?? null;
        state.scheduled = snapshot.scheduled ?? null;
        state.settings = snapshot.settings ?? null;
        state.orderStatuses = snapshot.orderStatuses ?? [];
        state.syncedAt = snapshot.at ?? null;
        toast('Sin conexión: datos guardados en el teléfono');
        render();
      } else {
        // Sin copia guardada: la bandeja tiene que decir que FALLÓ, no “no hay nada”.
        state.wa.listError = true;
        toast('No se pudieron cargar los datos');
        render();
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
    /*
     * La venta se manda a Meta DESPUÉS de responder (para no hacer esperar al
     * panel), así que el resultado se recoge un momento más tarde: si no, el
     * negocio vería "pendiente" para siempre.
     */
    if (state.meta?.configured && patch.status === state.meta.purchaseStatus) {
      setTimeout(() => {
        load({ keepTab: true }).catch(() => {});
      }, 1800);
    }
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
    // `{telefono}` solo existe si HAY teléfono: sin dato, la variable se queda
    // escrita tal cual en vez de rellenarse con un «null» o con algo inventado.
    if (item?.phone) values.telefono = String(item.phone);
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
    renderWhatsapp();
    renderClientes();
    renderPedidos();
    renderProductos();
    renderReportes();
    renderSeguimientos();
    renderMensajes();
    renderAjustes();
    renderCurrentUser();
    renderUsuarios();
    updateBadge();
    renderOutboxBanner();
  }

  const label = (type) => (type === 'order_intent' ? 'Pedido' : 'Contacto');
  const statusLabel = (value) => state.statuses.find((entry) => entry.value === value)?.label ?? value;
  const moneyCents = (value) => money((Number(value) || 0) / 100);

  const currentUser = () => state.auth?.user ?? null;
  const isAdmin = () => currentUser()?.role === 'ADMIN' || state.auth?.legacy === true;
  const roleLabel = (role) => (role === 'ADMIN' ? 'Administrador' : role === 'AGENT' ? 'Agente' : 'Sesión');

  function renderCurrentUser() {
    const user = currentUser();
    const box = $('#drawer-user');
    if (box) {
      const name = user?.display_name ?? (state.auth?.legacy ? 'Panel legacy' : '');
      box.hidden = !name;
      box.innerHTML = name
        ? `<span class="avatar avatar--sm">${escapeHtml(waInitials(name))}</span>
           <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(roleLabel(user?.role ?? 'ADMIN'))}</small></span>`
        : '';
    }
    $$('[data-admin-only]').forEach((node) => {
      node.hidden = !isAdmin();
    });
  }

  function renderStats() {
    const hoy = state.hoy ?? {};
    const programados = state.scheduled ?? {};
    const conProblemas = (programados.blocked ?? 0) + (programados.failed ?? 0);
    /*
     * HOY es un centro OPERATIVO: los contadores son trabajo que hacer ahora
     * (contestar, seguir, resolver un mensaje que no salió), no gráficas. Cada
     * tarjeta lleva a la lista donde se resuelve.
     */
    const cards = [
      {
        label: 'Sin responder',
        value: hoy.sinResponder ?? 0,
        alert: (hoy.sinResponder ?? 0) > 0,
        goto: 'whatsapp',
      },
      { label: 'Seguimientos hoy', value: hoy.seguimientosHoy ?? 0, goto: 'seguimientos' },
      {
        label: 'Seguimientos vencidos',
        value: hoy.seguimientosVencidos ?? 0,
        alert: (hoy.seguimientosVencidos ?? 0) > 0,
        goto: 'seguimientos',
      },
      {
        label: 'Mensajes con problemas',
        value: conProblemas,
        alert: conProblemas > 0,
        goto: 'hoy',
      },
      { label: 'Pedidos abiertos', value: hoy.pedidosPendientes ?? 0, goto: 'pedidos' },
    ];
    $('#stats').innerHTML = cards
      .map(
        (card) => `<button class="stat ${card.alert ? 'stat--alert' : ''}" data-goto="${card.goto}" type="button">
            <span class="stat__value">${card.value}</span>
            <span class="stat__label">${escapeHtml(card.label)}</span>
          </button>`,
      )
      .join('');
  }

  function renderProductos() {
    const box = $('#inventory-view');
    if (!box) return;
    const inv = state.inventory;
    if (!inv) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando inventario…</p></div>';
      if (!state.inventoryLoading && state.online) loadInventory().catch(() => {});
      return;
    }
    const movements = inv.movements ?? [];
    box.innerHTML = `
      <div class="card">
        <p class="card__title">${escapeHtml(inv.product?.name ?? 'Phytoemagry')}</p>
        <dl class="facts">
          <div class="fact"><dt>Stock</dt><dd>${escapeHtml(inv.stock ?? 0)} cápsulas</dd></div>
          <div class="fact"><dt>Costo vigente</dt><dd>${moneyCents(inv.product?.current_unit_cost_cents ?? 0)} / cápsula</dd></div>
          <div class="fact"><dt>Valor referencial</dt><dd>${moneyCents(inv.inventory_value_cents ?? 0)}</dd></div>
          <div class="fact"><dt>Control activo</dt><dd>${inv.initialized ? 'sí' : 'sin inventario inicial'}</dd></div>
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Presentaciones</p>
        <dl class="facts">
          ${(inv.presentations ?? [])
            .map(
              (item) => `<div class="fact"><dt>${escapeHtml(item.name)}</dt><dd>${money(item.price)} · ${escapeHtml(
                item.capsule_quantity,
              )} cáps. · costo ${moneyCents(item.presentation_cost_cents)}</dd></div>`,
            )
            .join('')}
        </dl>
      </div>
      <form class="card" id="inventory-restock">
        <p class="card__title">Agregar inventario</p>
        <label class="field"><span class="field__label">Cápsulas</span><input class="field__input" name="quantity" type="number" min="1" step="1" required /></label>
        <label class="field"><span class="field__label">Costo unitario</span><input class="field__input" name="unitCost" type="number" min="0" step="0.01" value="${escapeHtml(
          ((inv.product?.current_unit_cost_cents ?? 0) / 100).toFixed(2),
        )}" required /></label>
        <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" value="Reposición" /></label>
        <button class="btn btn--primary btn--block" type="submit">Agregar stock</button>
      </form>
      <form class="card" id="inventory-cost">
        <p class="card__title">Costo vigente</p>
        <label class="field"><span class="field__label">Costo por cápsula</span><input class="field__input" name="unitCost" type="number" min="0" step="0.01" value="${escapeHtml(
          ((inv.product?.current_unit_cost_cents ?? 0) / 100).toFixed(2),
        )}" required /></label>
        <button class="btn btn--ghost btn--block" type="submit">Actualizar costo</button>
      </form>
      <form class="card" id="inventory-adjust">
        <p class="card__title">Ajuste manual</p>
        <label class="field"><span class="field__label">Tipo</span><select class="field__select" name="direction"><option value="in">Entrada</option><option value="out">Salida</option></select></label>
        <label class="field"><span class="field__label">Cápsulas</span><input class="field__input" name="quantity" type="number" min="1" step="1" required /></label>
        <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" value="Ajuste manual" /></label>
        <button class="btn btn--ghost btn--block" type="submit">Guardar ajuste</button>
      </form>
      <div class="card">
        <p class="card__title">Movimientos recientes</p>
        <dl class="facts">
          ${
            movements.length
              ? movements
                  .slice(0, 12)
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(fmtWhen(row.created_at))} · ${escapeHtml(row.type)}</dt><dd>${escapeHtml(
                        row.quantity_delta,
                      )} cápsulas${row.reason ? ` · ${escapeHtml(row.reason)}` : ''}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin movimientos</dt><dd>Agrega inventario para activar control estricto de stock.</dd></div>'
          }
        </dl>
      </div>`;
  }

  function renderReportes() {
    const box = $('#sales-report-view');
    if (!box) return;
    $('#sales-report-period')
      ?.querySelectorAll('[data-report-period]')
      .forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.reportPeriod === state.salesReportPeriod)));
    const report = state.salesReport;
    if (!report) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando reporte…</p></div>';
      if (!state.salesReportLoading && state.online) loadSalesReport(state.salesReportPeriod).catch(() => {});
      return;
    }
    const s = report.summary ?? {};
    box.innerHTML = `
      <div class="card">
        <p class="card__title">Utilidad</p>
        <dl class="facts">
          <div class="fact"><dt>Ventas entregadas</dt><dd>${escapeHtml(s.orders ?? 0)}</dd></div>
          <div class="fact"><dt>Ingresos productos</dt><dd>${moneyCents(s.product_revenue_cents)}</dd></div>
          <div class="fact"><dt>Delivery cobrado</dt><dd>${moneyCents(s.delivery_revenue_cents)}</dd></div>
          <div class="fact"><dt>Total cobrado</dt><dd>${moneyCents(s.total_collected_cents)}</dd></div>
          <div class="fact"><dt>Costo producto</dt><dd>${moneyCents(s.product_cost_cents)}</dd></div>
          <div class="fact"><dt>Utilidad bruta producto</dt><dd>${moneyCents(s.gross_product_profit_cents)}</dd></div>
          <div class="fact"><dt>Cápsulas vendidas</dt><dd>${escapeHtml(s.capsules_sold ?? 0)}</dd></div>
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Por presentación</p>
        <dl class="facts">
          ${
            (report.byPresentation ?? []).length
              ? report.byPresentation
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(row.presentation)}</dt><dd>${escapeHtml(row.units)} frasco(s) · ${escapeHtml(
                        row.capsules,
                      )} cáps. · utilidad ${moneyCents(row.gross_product_profit_cents)}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin ventas</dt><dd>No hay entregas en este período.</dd></div>'
          }
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Ventas</p>
        <dl class="facts">
          ${
            (report.sales ?? []).length
              ? report.sales
                  .slice(0, 20)
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(row.order_number ?? row.id)} · ${escapeHtml(fmtWhen(row.date))}</dt><dd>${escapeHtml(
                        row.presentation,
                      )} · cobrado ${moneyCents(row.total_collected_cents)} · utilidad ${moneyCents(
                        row.gross_product_profit_cents,
                      )}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin ventas</dt><dd>No hay detalle para mostrar.</dd></div>'
          }
        </dl>
      </div>`;
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
          ${
            item.type === 'order_intent'
              ? `<button class="btn btn--ghost btn--sm" data-receipt="${escapeHtml(item.id)}" type="button">Comprobante</button>`
              : ''
          }
          <button class="btn btn--ghost btn--sm" data-open="${escapeHtml(item.id)}" type="button">Abrir ficha</button>
        </div>
      </article>`;
  }

  const emptyState = (text) => `<p class="empty">${escapeHtml(text)}</p>`;

  // ------------------------------------------- clientes, WhatsApp, seguimiento

  const customerById = (id) => state.customers.find((row) => row.id === id) ?? null;
  const conversationForCustomer = (customerId) =>
    state.conversations.find((row) => row.customer_id === customerId) ?? null;

  /** Todas las tareas pendientes (vencidas + hoy + próximas), de la más cercana a la más lejana. */
  const pendingFollowups = () =>
    [...(state.followups?.overdue ?? []), ...(state.followups?.today ?? []), ...(state.followups?.upcoming ?? [])].sort(
      (a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)),
    );

  const nextFollowupFor = (customerId) => pendingFollowups().find((row) => row.customer_id === customerId) ?? null;

  /** Última compra ENTREGADA del cliente (el dinero que de verdad entró). */
  const lastPurchase = (customerId) =>
    state.items
      .filter((item) => item.customer_id === customerId && item.status === 'entregado')
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0] ?? null;

  const FOLLOWUP_LABELS = {
    thanks: 'Agradecimiento',
    checkin: '¿Cómo va?',
    education: 'Información',
    reorder: 'Recompra',
    alert: 'Aviso',
    manual: 'Manual',
  };
  const followupLabel = (type) => FOLLOWUP_LABELS[type] ?? type ?? 'Seguimiento';

  /** Tarjeta de una tarea de seguimiento: dice a QUIÉN y para CUÁNDO. */
  function followupCard(row) {
    const customer = row.customer ?? customerById(row.customer_id);
    const conversation = conversationForCustomer(row.customer_id);
    const late = row.scheduled_at < todayISO();
    return `<article class="item ${late ? 'item--hoy' : ''}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(customer?.name ?? customer?.phone_e164 ?? 'Cliente')}</p>
            <span class="tag tag--recordatorio">${escapeHtml(fmtDay(row.scheduled_at))}</span>
            <span class="tag">${escapeHtml(followupLabel(row.type))}</span>
            ${row.origin === 'manual' ? '<span class="tag">Manual</span>' : ''}
          </div>
        </div>
        <p class="item__meta">${escapeHtml(row.reason ?? 'Seguimiento')}</p>
        <div class="item__actions">
          ${
            conversation
              ? `<button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(conversation.id)}" data-followup="${
                  escapeHtml(row.id)
                }" type="button">Escribir ahora</button>`
              : ''
          }
          <button class="btn btn--ghost btn--sm" data-followup-done="${escapeHtml(row.id)}" type="button">Hecho</button>
          <button class="btn btn--ghost btn--sm" data-followup-postpone="${escapeHtml(row.id)}" type="button">+3 días</button>
          <button class="btn btn--ghost btn--sm" data-followup-cancel="${escapeHtml(row.id)}" type="button">Cancelar</button>
          ${customer ? `<button class="btn btn--ghost btn--sm" data-customer="${escapeHtml(customer.id)}" type="button">Ficha</button>` : ''}
        </div>
      </article>`;
  }

  /** Un mensaje programado que NO salió: dice por qué y qué puede hacer una persona. */
  function scheduledProblemCard(row) {
    const customer = customerById(row.customer_id);
    const conversation = conversationForCustomer(row.customer_id);
    const motivo =
      row.status === 'BLOCKED'
        ? row.blocked_message ?? 'Bloqueado'
        : `Error: ${row.error_message ?? 'no se pudo enviar'}`;
    return `<article class="item item--hoy">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(customer?.name ?? customer?.phone_e164 ?? 'Cliente')}</p>
            <span class="tag tag--recordatorio">${row.status === 'BLOCKED' ? 'Bloqueado' : 'Falló'}</span>
            <span class="tag">${escapeHtml(fmtDay(String(row.scheduled_at).slice(0, 10)))}</span>
          </div>
        </div>
        <p class="item__meta">${escapeHtml(String(row.text ?? row.template ?? '').slice(0, 90))}</p>
        <p class="item__meta">${escapeHtml(motivo)}</p>
        <div class="item__actions">
          ${
            conversation
              ? `<button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(conversation.id)}" type="button">Escribir ahora</button>`
              : ''
          }
          <button class="btn btn--ghost btn--sm" data-scheduled-cancel="${escapeHtml(row.id)}" type="button">Cancelar</button>
        </div>
      </article>`;
  }

  /** Tarjeta de una conversación de WhatsApp. */
  function conversationCard(row) {
    const customer = row.customer ?? customerById(row.customer_id);
    const unread = Number(row.unread_count) || 0;
    const next = nextFollowupFor(row.customer_id);
    const purchase = lastPurchase(row.customer_id);
    const needsHuman = row.status === 'HUMAN_REQUIRED';
    return `<article class="item ${unread > 0 ? 'item--hoy' : ''}" data-chat="${escapeHtml(row.id)}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(customer?.name ?? customer?.phone_e164 ?? 'Cliente')}</p>
            ${unread > 0 ? `<span class="tag tag--nuevo">${unread} sin leer</span>` : ''}
            ${needsHuman ? '<span class="tag tag--recordatorio">Necesita una persona</span>' : ''}
            ${customer?.do_not_contact ? '<span class="tag tag--perdido">No contactar</span>' : ''}
            ${next ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(next.scheduled_at))}</span>` : ''}
          </div>
          <span class="item__when">${row.last_message_at ? escapeHtml(fmtWhen(row.last_message_at)) : ''}</span>
        </div>
        <p class="item__meta">
          ${
            row.last_message
              ? `${row.last_message.direction === 'inbound' ? 'Cliente: ' : 'Tú: '}${escapeHtml(
                  String(row.last_message.body ?? '').slice(0, 90),
                )}`
              : 'Sin mensajes todavía'
          }
        </p>
        ${
          purchase
            ? `<p class="item__meta">Última compra: ${escapeHtml(purchase.variant_name ?? '')} ${money(
                purchase.total,
                purchase.currency,
              )} · ${escapeHtml(fmtWhen(purchase.received_at))}</p>`
            : '<p class="item__meta">Sin compras entregadas todavía</p>'
        }
        <div class="item__actions">
          <button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(row.id)}" type="button">Abrir chat</button>
          <button class="btn btn--ghost btn--sm" data-customer="${escapeHtml(customer?.id ?? '')}" type="button">Ficha</button>
          <button class="btn btn--ghost btn--sm" data-purchase="${escapeHtml(customer?.id ?? '')}" type="button">Registrar compra</button>
        </div>
      </article>`;
  }

  const section = (title, count, html) =>
    `<h2 class="view__title">${escapeHtml(title)}${count ? ` (${count})` : ''}</h2><div class="list">${html}</div>`;

  function renderHoy() {
    const today = todayISO();
    const followups = state.followups ?? { today: [], overdue: [], upcoming: [] };
    const hoy = state.hoy ?? {};

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

    // Conversaciones: lo que no se ha leído y lo que pide una persona. Una
    // conversación que necesita una persona se lista UNA vez.
    // “Sin contestar” = el último mensaje lo escribió el cliente y todavía no le
    // hemos respondido. NO se apaga por abrir la conversación: solo al responder.
    const sinLeer = state.conversations.filter((row) => row.awaiting_reply === true);
    const humano = state.conversations.filter(
      (row) => row.status === 'HUMAN_REQUIRED' && !sinLeer.some((other) => other.id === row.id),
    );

    const pedidosAbiertos = state.items.filter(
      (item) => item.type === 'order_intent' && !['entregado', 'perdido'].includes(item.status ?? 'nuevo'),
    );

    const bloques = [
      followups.overdue?.length
        ? section('Seguimientos vencidos', followups.overdue.length, followups.overdue.map(followupCard).join(''))
        : '',
      followups.today?.length
        ? section('Seguimientos de hoy', followups.today.length, followups.today.map(followupCard).join(''))
        : '',
      humano.length
        ? section('Necesitan una persona', humano.length, humano.map(conversationCard).join(''))
        : '',
      sinLeer.length
        ? section('Esperando respuesta', sinLeer.length, sinLeer.map(conversationCard).join(''))
        : '',
      pendientes.length
        ? section('Recordatorios de hoy', pendientes.length, pendientes.map(itemCard).join(''))
        : '',
      nuevos.length ? section('Nuevos sin contactar', nuevos.length, nuevos.map(itemCard).join('')) : '',
      pedidosAbiertos.length
        ? section('Pedidos sin cerrar', pedidosAbiertos.length, pedidosAbiertos.slice(0, 5).map(itemCard).join(''))
        : '',
      hoy.mensajesFallidos
        ? `<h2 class="view__title">Mensajes que no salieron (${hoy.mensajesFallidos})</h2>
           <p class="rule rule--warn">WhatsApp los rechazó. Revisa el número y vuelve a intentarlo desde la conversación.</p>`
        : '',
      // Mensajes programados BLOQUEADOS o fallidos: son trabajo para una persona.
      state.scheduled?.problems?.length
        ? section(
            'Mensajes programados con problemas',
            state.scheduled.problems.length,
            state.scheduled.problems.map(scheduledProblemCard).join(''),
          )
        : '',
    ]
      .filter(Boolean)
      .join('');

    $('#list-hoy').innerHTML =
      bloques || emptyState('Todo al día 👌 Nada pendiente y ningún mensaje sin contestar.');
  }

  function renderWhatsapp() {
    const wa = state.whatsapp ?? { configured: false };
    /*
     * En WhatsApp NO se anuncia "conectado" ni se repite el número del negocio:
     * es SU número y la pantalla ya dice dónde estamos. Solo se avisa cuando hay
     * algo que hacer de verdad: que WhatsApp no esté configurado en el servidor.
     */
    $('#wa-status').innerHTML = wa.configured
      ? ''
      : `<p class="rule rule--warn">WhatsApp todavía no está configurado en el servidor. Puedes registrar
         clientes y compras y ver sus fichas, pero el panel no envía ni recibe mensajes. Faltan las
         variables del servidor (ver docs/WHATSAPP_INTEGRATION.md).</p>`;

    const filters = $('#wa-filters');
    if (filters) {
      filters.innerHTML = WA_FILTERS.map(
        ([value, text]) => {
          const count = waFilterCount(value);
          const label = Number.isFinite(Number(count)) && Number(count) > 0 ? `${text} ${count}` : text;
          return (
          `<button class="chip" data-wa-filter="${value}" aria-pressed="${
            value === state.wa.filter
          }" type="button">${label}</button>`
          );
        },
      ).join('') + `<button class="chip" id="wa-notify" type="button">${
        state.wa.notify ? 'Notificaciones activas' : 'Activar notificaciones'
      }</button><button class="chip" id="wa-sound" aria-pressed="${state.wa.sound}" type="button">Sonido ${
        state.wa.sound ? 'sí' : 'no'
      }</button>`;
    }
    const search = $('#wa-search');
    if (search && search.value !== state.wa.q) search.value = state.wa.q;

    renderWaList();
    renderWaChat();
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

  /** Pedidos y compras (menú lateral): lo que entró por la web o se apuntó a mano. */
  function renderPedidos() {
    const box = $('#list-pedidos');
    if (!box) return;
    const items = applyOutbox(state.items.filter((item) => item.type === 'order_intent'));
    box.innerHTML = items.length
      ? items.map(itemCard).join('')
      : emptyState('Todavía no hay pedidos registrados.');
  }

  /** Seguimientos (menú lateral): vencidos, de hoy y los que vienen. */
  function renderSeguimientos() {
    const box = $('#list-seguimientos');
    if (!box) return;
    const followups = state.followups ?? {};
    const bloque = (titulo, filas) =>
      filas?.length
        ? `<h2 class="view__title">${escapeHtml(titulo)} (${filas.length})</h2>${filas.map(followupCard).join('')}`
        : '';
    const html = [
      bloque('Vencidos', followups.overdue),
      bloque('Para hoy', followups.today),
      bloque('Próximos', followups.upcoming),
    ]
      .filter(Boolean)
      .join('');
    box.innerHTML = html || emptyState('No hay seguimientos pendientes. Se crean solos al entregar una compra.');
  }

  /** Plantilla marcada para borrar (segundo toque confirma). */
  let pendingDelete = null;
  /** Cliente marcado como "no contactar" (segundo toque confirma). */
  let pendingOptOut = null;

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
    const wa = state.whatsapp ?? {};
    $('#facts').innerHTML = [
      ['Registros', stats.total ?? state.items.length],
      ['Clientes', state.customers.length],
      ['Sin contactar', stats.nuevos ?? 0],
      ['Para hoy / atrasados', `${stats.hoy ?? 0} / ${stats.atrasados ?? 0}`],
      ['Seguimientos hoy / vencidos', `${state.hoy?.seguimientosHoy ?? 0} / ${state.hoy?.seguimientosVencidos ?? 0}`],
      ['Mensajes sin responder', state.hoy?.sinResponder ?? 0],
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

    // Estado de WhatsApp en palabras: lo que falta, dicho sin tecnicismos.
    $('#wa-config').innerHTML = wa.configured
      ? `<dl class="facts">
        <div class="fact"><dt>Envío y recepción</dt><dd>activos${wa.phoneNumber ? ` (${escapeHtml(wa.phoneNumber)})` : ''}</dd></div>
        <div class="fact"><dt>Webhooks</dt><dd>${wa.verifyTokenConfigured ? 'con token de verificación' : 'FALTA WHATSAPP_VERIFY_TOKEN'}</dd></div>
        <div class="fact"><dt>Firma de Meta</dt><dd>${wa.appSecretConfigured ? 'se comprueba' : 'FALTA META_APP_SECRET'}</dd></div>
      </dl>
      <p class="card__text">Nada se envía solo: cada mensaje lo escribes y lo envías tú desde la conversación.</p>`
      : `<p class="card__text">Todavía no está conectado. Puedes registrar clientes y compras, pero no
         enviar ni recibir mensajes. Hacen falta WHATSAPP_PHONE_NUMBER_ID y WHATSAPP_ACCESS_TOKEN en el
         servidor (ver docs/WHATSAPP_INTEGRATION.md).</p>`;
    $('#build-info').textContent = `${state.items.length} registros · ${
      state.online ? 'en línea' : 'sin conexión'
    } · v2`;

    // -------------------------------------------- seguimiento postventa (S5)
    const plan = state.followups?.plan ?? [];
    const enabled = state.followups?.enabled ?? state.settings?.followup ?? {};
    $('#followup-config').innerHTML = plan.length
      ? plan
          .map(
            (entry) => `<label class="toggle">
              <input type="checkbox" data-plan-toggle="${escapeHtml(entry.key)}" ${
                enabled[entry.key] !== false ? 'checked' : ''
              } />
              <span><strong>Día ${escapeHtml(entry.day)}</strong><small>${escapeHtml(entry.reason)}</small></span>
            </label>`,
          )
          .join('')
      : '<p class="card__text">No hay plan configurado.</p>';

    // ---------------------------------------------------- métricas (S6)
    const byPeriod = state.metrics?.byPeriod ?? null;
    const periodName = state.metrics?.period?.name ?? state.metricsPeriod;
    $('#metrics-period')
      ?.querySelectorAll('[data-metrics]')
      .forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.metrics === periodName)));
    $('#metrics').innerHTML = byPeriod
      ? [
          ['Leads nuevos', byPeriod.leadsNuevos],
          ['Conversaciones', byPeriod.conversaciones],
          ['Pedidos creados', byPeriod.pedidosCreados],
          ['Pedidos confirmados', byPeriod.pedidosConfirmados],
          ['Pedidos entregados', byPeriod.pedidosEntregados],
          ['Ventas', money(byPeriod.ventas)],
          ['Recompras', byPeriod.recompras],
          ['Pendientes de seguimiento', byPeriod.clientesPendientesDeSeguimiento],
          ['Pedidos cancelados', byPeriod.pedidosCancelados],
        ]
          .map(([key, value]) => `<div class="fact"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
          .join('')
      : '<div class="fact"><dt>Período</dt><dd>cargando…</dd></div>';
    if (!state.metrics && !state.metricsLoading && state.online) {
      state.metricsLoading = true;
      loadMetrics(state.metricsPeriod).finally(() => {
        state.metricsLoading = false;
      });
    }

    // ---------------------------------------------------------- auditoría
    $('#audit').innerHTML = state.auditEntries?.length
      ? `<dl class="facts">${state.auditEntries
          .slice(0, 8)
          .map(
            (entry) =>
              `<div class="fact"><dt>${escapeHtml(fmtWhen(entry.created_at))} · ${escapeHtml(entry.action)}</dt><dd>${escapeHtml(
                entry.summary ?? '',
              )}</dd></div>`,
          )
          .join('')}</dl>`
      : `<p class="card__text">${
          state.audit?.total ? `${state.audit.total} operaciones registradas.` : 'Todavía no hay operaciones registradas.'
        }</p>`;
    if (!state.auditEntries && !state.auditLoading && state.online) {
      state.auditLoading = true;
      loadAuditEntries();
    }

    // ------------------------------------------------ multimedia (S3)
    const media = state.media ?? {};
    $('#media-config').innerHTML = media.enabled
      ? `<dl class="facts">
          <div class="fact"><dt>Imagen y audio</dt><dd>activos</dd></div>
          <div class="fact"><dt>Archivos</dt><dd>almacén privado (S3/R2)</dd></div>
          <div class="fact"><dt>Límites</dt><dd>imagen ${media.imageLimitMb ?? 5} MB · audio ${media.audioLimitMb ?? 16} MB</dd></div>
        </dl>
        <p class="card__text">Las fotos y los audios se piden al CRM con tu sesión: el almacén es privado y nadie
        de fuera puede abrir un archivo aunque tenga el enlace.</p>`
      : `<p class="card__text">Todavía no está activa: ${
          media.storageConfigured === false ? 'falta el almacén de archivos (R2). ' : ''
        }${
          media.graphConfigured === false ? 'faltan las credenciales de WhatsApp para descargar archivos. ' : ''
        }Los mensajes de texto, los pedidos y los comprobantes funcionan igual.</p>`;

    // Recuperación de envíos ambiguos: SOLO administración, nunca en el chat.
    const review = media.review ?? [];
    $('#media-review-card').hidden = review.length === 0;
    $('#media-review').innerHTML = review
      .map(
        (row) => `<div class="review-item">
          <p class="item__meta"><strong>${escapeHtml(row.media_type ?? 'archivo')}</strong> ·
            ${escapeHtml(row.send_status ?? '')}${row.http_status ? ` · HTTP ${escapeHtml(row.http_status)}` : ''}</p>
          <p class="item__meta">Intentado ${escapeHtml(fmtWhen(row.send_attempted_at ?? row.created_at))}${
            row.safe_code ? ` · ${escapeHtml(row.safe_code)}` : ''
          }</p>
          <label class="field">
            <span class="field__label">Identificador del mensaje en WhatsApp (si salió)</span>
            <input class="field__input" data-review-wamid="${escapeHtml(row.id)}" placeholder="wamid.…" />
          </label>
          <div class="item__actions">
            <button class="btn btn--ghost btn--sm" data-review="sent" data-review-id="${escapeHtml(
              row.id,
            )}" type="button">Sí salió</button>
            <button class="btn btn--primary btn--sm" data-review="not_sent" data-review-id="${escapeHtml(
              row.id,
            )}" type="button">No salió: reintentar</button>
          </div>
        </div>`,
      )
      .join('');
  }

  function renderUsuarios() {
    const box = $('#users-view');
    if (!box) return;
    if (!isAdmin()) {
      box.innerHTML = emptyState('Esta sección es solo para administradores.');
      return;
    }
    if (!state.users?.length) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando usuarios…</p></div>';
      if (!state.usersLoading && state.online) loadUsers().catch(() => {});
      return;
    }
    box.innerHTML = state.users
      .map(
        (user) => `<article class="item">
          <p class="item__name">${escapeHtml(user.display_name)}</p>
          <p class="item__meta">${escapeHtml(user.username)} · ${escapeHtml(roleLabel(user.role))} · ${
            user.active === false ? 'Inactivo' : 'Activo'
          }${user.last_login_at ? ` · último acceso ${escapeHtml(fmtWhen(user.last_login_at))}` : ''}</p>
          <div class="item__actions">
            <button class="btn btn--ghost btn--sm" data-user-role="${escapeHtml(user.id)}" data-role="${
              user.role === 'ADMIN' ? 'AGENT' : 'ADMIN'
            }" type="button">${user.role === 'ADMIN' ? 'Hacer agente' : 'Hacer admin'}</button>
            <button class="btn btn--ghost btn--sm" data-user-active="${escapeHtml(user.id)}" data-active="${
              user.active === false ? 'true' : 'false'
            }" type="button">${user.active === false ? 'Activar' : 'Desactivar'}</button>
            <button class="btn btn--ghost btn--sm" data-user-password="${escapeHtml(user.id)}" type="button">Reset contraseña</button>
          </div>
        </article>`,
      )
      .join('');
  }

  async function loadUsers() {
    if (!isAdmin()) return;
    state.usersLoading = true;
    try {
      const result = await api('/api/admin/users');
      state.users = result.users ?? [];
      renderUsuarios();
    } finally {
      state.usersLoading = false;
    }
  }

  async function updateUser(id, patch) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await loadUsers();
      toast('Usuario actualizado');
    } catch (error) {
      if (error.message !== 'unauthorized') {
        toast(error.body?.error === 'last_admin' ? 'Debe quedar al menos un administrador activo' : error.body?.message ?? 'No se pudo actualizar');
      }
    }
  }

  /**
   * Reconcilia un envío ambiguo: es la ÚNICA salida y la decide una persona que
   * ya miró WhatsApp. No llama a Meta; solo corrige el estado local y queda en la
   * auditoría (quién, cuándo, qué archivo y qué se eligió).
   */
  async function reconcileMedia(mediaId, outcome) {
    const waMessageId = outcome === 'sent' ? ($(`[data-review-wamid="${cssEscape(mediaId)}"]`)?.value ?? '').trim() : '';
    if (outcome === 'sent' && !waMessageId) {
      toast('Escribe el identificador del mensaje (wamid.…) o elige «No salió»');
      return;
    }
    try {
      const query = new URLSearchParams({ outcome });
      if (waMessageId) query.set('wa_message_id', waMessageId);
      await api(`/api/admin/media/retry/${encodeURIComponent(mediaId)}?${query.toString()}`, { method: 'POST' });
      toast(outcome === 'sent' ? 'Marcado como enviado' : 'Marcado como no enviado: se puede reintentar');
      await load({ keepTab: true });
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo reconciliar');
    }
  }

  /**
   * Auditoría reciente (lista corta). Se pide por separado porque NO cambia con
   * cada refresco del panel y así la carga principal sigue siendo una sola llamada.
   */
  async function loadAuditEntries() {
    try {
      const body = await api('/api/admin/audit?limit=10');
      state.auditEntries = body.entries ?? [];
    } catch {
      /* sin auditoría el panel sigue funcionando */
    } finally {
      state.auditLoading = false;
      renderAjustes();
    }
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

      ${metaBlock(item)}

      ${phone ? `<a class="btn btn--ghost btn--block" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}
    `;
    $('#sheet').hidden = false;
    updatePreview();

    $('#sheet-meta')?.addEventListener('click', async () => {
      const button = $('#sheet-meta');
      button.disabled = true;
      button.textContent = 'Enviando…';
      try {
        const result = await api(`/api/admin/items/${encodeURIComponent(item.id)}/meta-purchase`, { method: 'POST' });
        if (result.item) Object.assign(item, result.item);
        toast(result.ok ? 'Venta enviada a Meta' : 'Meta no aceptó el envío');
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo enviar a Meta');
      }
      renderSheet();
      await refreshStats();
    });

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

  /**
   * Bloque "Venta en Meta" de la ficha.
   *
   * Solo se enseña en pedidos y solo se puede reenviar cuando el negocio ya dio
   * el pedido por ENTREGADO (que es cuando de verdad hay una venta que contar).
   */
  function metaBlock(item) {
    if (item.type !== 'order_intent') return '';
    const venta = state.meta?.purchaseStatus ?? 'entregado';
    const enviada = Boolean(item.meta_purchase_sent_at);
    let texto;
    if (enviada) texto = `Venta enviada a Meta el ${fmtWhen(item.meta_purchase_sent_at)}.`;
    else if (item.meta_purchase_status === 'failed')
      texto = `Meta rechazó el envío (${item.meta_purchase_error ?? 'error'}). Se reintenta solo al reiniciar.`;
    else if (item.status === venta) texto = 'Enviando la venta a Meta…';
    else texto = `Al marcar el pedido como «${venta}» se envía la venta a Meta una sola vez.`;

    const canRetry = !enviada && item.status === venta;
    return `
      <div class="field">
        <span class="field__label">Venta en Meta</span>
        <p class="view__hint">${escapeHtml(texto)}</p>
        ${canRetry ? `<button class="btn btn--ghost btn--block" id="sheet-meta" type="button">${item.meta_purchase_status === 'failed' ? 'Reintentar envío' : 'Enviar a Meta'}</button>` : ''}
      </div>
    `;
  }

  // ------------------------------------------------ conversación y ficha 360

  /**
   * Abre la hoja. `variant: 'menu'` la convierte en popover en escritorio (un
   * menú no sube desde abajo en una pantalla grande); en el móvil es la misma
   * hoja de siempre.
   */
  function openSheet(title, html, { variant = '' } = {}) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    const sheet = $('#sheet');
    if (variant) sheet.dataset.variant = variant;
    else delete sheet.dataset.variant;
    sheet.hidden = false;
  }

  function closeSheet() {
    // Nada de micrófono abierto ni temporizadores vivos al cerrar la hoja.
    try {
      closeSheetCleanup?.();
    } catch {
      /* el cierre nunca puede fallar por una limpieza */
    }
    closeSheetCleanup = null;
    state.openId = null;
    state.customerId = null;
    state.chat = null;
    pendingOptOut = null;
    $('#sheet').hidden = true;
  }

  /** Botón con estado "trabajando" (evita dos toques que envían dos mensajes). */
  async function working(button, label, task) {
    const original = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = label;
    }
    try {
      return await task();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  /**
   * Abre una conversación EN LA BANDEJA (desde Hoy, un seguimiento o la lista).
   * Ya no hay chat en ventana emergente: una sola pantalla, una sola fuente.
   */
  async function openChat(conversationId, options = {}) {
    if (!conversationId) return;
    state.openId = null;
    state.customerId = null;
    closeSheet();
    setTab('whatsapp', { silent: true });
    await selectConversation(conversationId, options);
    window.scrollTo({ top: 0 });
  }

  /**
   * Enlace directo del tipo `?v=whatsapp&conv=<id>`: abre ESA conversación.
   * Lo usa el aviso de mensaje nuevo («tienes un mensaje de Ana») y sirve para
   * compartir un chat concreto con otra persona del negocio.
   */
  async function applyDeepLink(query) {
    const conversationId = query?.get('conv');
    if (!conversationId) return;
    try {
      await openChat(conversationId);
    } catch {
      /* el enlace apunta a algo que ya no existe: se queda en la bandeja */
    }
  }

  /** Un mensaje del hilo. Se distingue QUIÉN escribió: cliente, negocio o el sistema. */
  function bubble(message, grouped = false) {
    const inbound = message.direction === 'inbound';
    const auto = !inbound && message.actor_type === 'SYSTEM';
    // El cliente ve “Enviando / Enviado / Entregado / Leído / Fallido”, como en WhatsApp.
    const estado = inbound ? '' : WA_STATUS[message.status] ?? '';
    const media = message.media ?? null;
    const tipo = message.type ?? 'text';
    const mediaSrc = media?.id ? mediaUrl(media.id) : null;
    const mediaListo = media?.status === 'STORED';
    /*
     * Contenido: el texto se escapa SIEMPRE (nunca se pinta HTML de WhatsApp).
     * Multimedia: el archivo se pide al endpoint privado del CRM (con sesión) y se
     * muestra de verdad: imagen con miniatura y visor, audio con reproductor
     * propio. Si el servidor no lo tiene todavía se dice “descargando”, y si falló
     * se dice que falló y se ofrece reintentar. Nunca aparece “un objeto” ni un
     * corchete raro.
     */
    let cuerpo;
    /*
     * ¿El mensaje es SOLO el archivo? Entonces el archivo ES la burbuja (una
     * sola pieza visual, sin tarjeta dentro de tarjeta). Si además trae texto, la
     * burbuja hace de marco para la imagen + el pie de foto.
     */
    let soloArchivo = false;
    if (tipo === 'image' && mediaSrc && mediaListo) {
      soloArchivo = !message.body;
      cuerpo = `<button class="media-thumb" data-media-view="${escapeHtml(media.id)}" type="button" aria-label="Ver la imagen en grande"><img src="${escapeHtml(mediaSrc)}" alt="Imagen del cliente" loading="lazy" decoding="async" /></button>`;
      if (message.body) cuerpo += `<span class="media-caption">${escapeHtml(message.body)}</span>`;
    } else if ((tipo === 'audio' || tipo === 'voice') && mediaSrc && mediaListo) {
      soloArchivo = true;
      // Si el servidor ya sabe cuánto dura (Meta lo manda), se enseña desde el
      // principio: un reproductor que arranca en «--:--» parece roto.
      const duracion = Number(media?.durationMs) > 0 ? fmtSeconds(media.durationMs / 1000) : '--:--';
      cuerpo = `<span class="audio" data-audio="${escapeHtml(media.id)}">
          <button class="audio__play" data-audio-play="${escapeHtml(media.id)}" data-audio-src="${escapeHtml(
            mediaSrc,
          )}" type="button" aria-label="Reproducir">▶</button>
          <span class="audio__main">
            <input class="audio__seek" data-audio-seek="${escapeHtml(media.id)}" type="range" min="0" max="1000" value="0"
              aria-label="Posición del audio" />
            <span class="audio__times"><span data-audio-current>0:00</span><span data-audio-total>${duracion}</span></span>
          </span>
          <span class="audio__kind" aria-hidden="true">${tipo === 'voice' ? ICONS.mic : ICONS.audio}</span>
        </span>`;
    } else if (tipo === 'location') {
      /*
       * UBICACIÓN: una pieza visual propia (no pasa por multimedia). Si el mensaje
       * trae coordenadas legibles se puede abrir el mapa y reutilizarla; si no, se
       * dice sin inventar nada.
       */
      soloArchivo = true;
      cuerpo = message.location
        ? locationChip(message.location)
        : `<span class="loc loc--empty">
             <span class="loc__head"><span class="loc__pin" aria-hidden="true">📍</span>
               <span class="loc__title">Ubicación compartida</span></span>
             <span class="loc__meta">No se pudieron leer las coordenadas</span>
           </span>`;
    } else if (tipo !== 'text' && tipo !== 'button' && tipo !== 'interactive') {
      const falló = media?.status === 'FAILED' || Boolean(media?.errorCode);
      const cargando = Boolean(media) && !mediaListo && !falló;
      const icono = WA_KIND_ICON[tipo] ?? '📄';
      const nombre = WA_KIND_LABEL[tipo] ?? 'Archivo';
      if (falló) {
        cuerpo = `<span class="media-state media-state--failed"><span aria-hidden="true">${icono}</span>
            <span>No se pudo descargar el ${escapeHtml(nombre.toLowerCase())}</span></span>
          ${
            media?.id
              ? `<button class="btn btn--ghost btn--sm" data-media-retry="${escapeHtml(media.id)}" type="button">Reintentar</button>`
              : ''
          }`;
      } else if (cargando) {
        cuerpo = `<span class="media-state"><span aria-hidden="true">${icono}</span>
            <span>Descargando ${escapeHtml(nombre.toLowerCase())}…</span></span>`;
      } else {
        // Sin almacén (o mensaje antiguo): se describe, nunca se inventa el archivo.
        cuerpo = `<span class="media-fallback"><span aria-hidden="true">${icono}</span>${escapeHtml(
          `${nombre} recibido`,
        )}</span>`;
      }
      if (message.body && message.body !== `[${tipo}]`) cuerpo += escapeHtml(message.body);
    } else {
      cuerpo = escapeHtml(message.body ?? '');
    }
    const who = inbound
      ? 'Cliente'
      : message.actor_type === 'SYSTEM'
        ? 'Sistema'
        : message.sent_by_display_name_snapshot || (message.sent_by && message.sent_by !== 'panel' ? message.sent_by : '');
    /*
     * El HTML se arma PEGADO a propósito, sin saltos de línea ni sangría de
     * plantilla. La burbuja conserva los saltos que escribió una persona
     * (`white-space: pre-wrap`), así que cualquier espacio de la plantilla se
     * vería como líneas VACÍAS arriba y abajo del texto: eso era el aire que
     * dejaba el mensaje "suelto" en medio de la burbuja.
     */
    const quien = who && !grouped ? `<span class="bubble__who">${escapeHtml(who)}</span>` : '';
    const hora = `<span class="bubble__meta">${escapeHtml(fmtWhen(message.created_at))}${
      estado ? ` · ${escapeHtml(estado)}` : ''
    }${message.error_message ? ` · ${escapeHtml(message.error_message)}` : ''}</span>`;
    const clases = [
      `bubble bubble--${inbound ? 'in' : 'out'}`,
      auto ? 'bubble--auto' : '',
      message.status === 'failed' ? 'bubble--failed' : '',
      grouped ? 'bubble--grouped' : '',
      soloArchivo ? 'bubble--media' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<div class="${clases}">${quien}${cuerpo}${hora}</div>`;
  }

  // --------------------------------------------------- bandeja de WhatsApp
  /*
   * Una sola pantalla, dos columnas: a la izquierda las conversaciones (con
   * búsqueda y filtros), a la derecha el hilo y el compositor. En el móvil se
   * ve la lista y, al abrir una, la conversación ocupa la pantalla con ← para
   * volver. Nada se envía solo: el botón Enviar es siempre un acto humano.
   */

  const WA_FILTERS = [
    ['todos', 'Todos'],
    ['mios', 'Míos'],
    ['sin-asignar', 'Sin asignar'],
    ['no-leidos', 'Nuevos'],
    ['pendientes', 'Pendientes'],
    ['clientes', 'Clientes'],
    ['seguimiento', 'Seguimiento'],
    ['archivados', 'Archivados'],
  ];

  const waFilterCount = (value) => {
    const counts = state.wa.counts ?? {};
    return {
      todos: counts.todos,
      mios: state.conversations.filter((row) => row.assigned_user_id === currentUser()?.id).length,
      'sin-asignar': counts.sin_asignar ?? state.conversations.filter((row) => !row.assigned_user_id).length,
      'no-leidos': counts.no_leidos,
      pendientes: counts.pendientes,
      clientes: counts.clientes,
      seguimiento: counts.seguimiento,
      archivados: counts.archivados,
    }[value];
  };

  /** Lo que ve una persona: nunca el `wa_message_id`. */
  const WA_STATUS = {
    pending: 'Enviando',
    queued: 'Enviando',
    sent: 'Enviado',
    delivered: 'Entregado',
    read: 'Leído',
    failed: 'Fallido',
  };

  const waAwaiting = (row) => row.awaiting_reply === true;
  const waCustomer = (row) => row.customer ?? customerById(row.customer_id);
  const waDisplayName = (row) => {
    const customer = waCustomer(row);
    return (customer?.name ?? '').trim() || customer?.phone_e164 || 'Cliente';
  };

  /** Icono y nombre legible de cada tipo de contenido (mismo sistema de iconos). */
  const WA_KIND_ICON = {
    image: ICONS.image,
    audio: ICONS.audio,
    voice: ICONS.mic,
    document: ICONS.doc,
    video: ICONS.video,
    sticker: ICONS.tagIcon,
    location: ICONS.pin,
  };
  const WA_KIND_LABEL = {
    image: 'Imagen',
    audio: 'Audio',
    voice: 'Nota de voz',
    document: 'Documento',
    video: 'Video',
    sticker: 'Sticker',
    location: 'Ubicación',
  };

  const COMMERCIAL_HINTS = {
    NUEVO: 'Prospecto',
    EN_CONVERSACION: 'Prospecto',
    INTERESADO: 'Interesado',
    PEDIDO_CREADO: 'Pedido',
    CONFIRMADO: 'Confirmado',
    ENTREGADO: 'Cliente',
    SEGUIMIENTO: 'Seguimiento',
    RECOMPRA: 'Cliente',
    PERDIDO: 'Perdido',
  };

  /** Iniciales para el avatar (todavía no hay fotos de perfil). */
  const waInitials = (value) => {
    const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  };

  /** «Hoy», «Ayer» o la fecha: el separador que ordena el hilo. */
  const waDayLabel = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (day === todayISO()) return 'Hoy';
    if (day === addDaysISO(-1)) return 'Ayer';
    return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'long' }).format(date);
  };

  /** Hilo completo: separadores por día y agrupación de mensajes seguidos. */
  function waThreadHtml(messages) {
    let html = '';
    let lastDay = '';
    let lastDirection = '';
    for (const message of messages) {
      const day = waDayLabel(message.created_at);
      if (day && day !== lastDay) {
        html += `<div class="day-sep">${escapeHtml(day)}</div>`;
        lastDay = day;
        lastDirection = '';
      }
      const grouped = message.direction === lastDirection;
      html += bubble(message, grouped);
      lastDirection = message.direction;
    }
    return html;
  }

  /** Firma del hilo: si no cambia, no se vuelve a pintar (y no se pierde lo escrito). */
  const waThreadSig = (data) => {
    const messages = data?.messages ?? [];
    const last = messages[messages.length - 1];
    return [
      messages.length,
      last?.id ?? '',
      last?.status ?? '',
      last?.delivered_at ?? '',
      last?.read_at ?? '',
      data?.canSendFreeText ? 1 : 0,
    ].join('|');
  };

  /** Conversaciones visibles según el filtro y la búsqueda, la más reciente primero. */
  function waVisibleConversations() {
    const { filter, q } = state.wa;
    let rows = state.conversations.slice();
    if (filter === 'mios') rows = rows.filter((row) => row.assigned_user_id === currentUser()?.id);
    if (filter === 'sin-asignar') rows = rows.filter((row) => !row.assigned_user_id);
    if (filter === 'pendientes') rows = rows.filter(waAwaiting);
    if (filter === 'no-leidos') rows = rows.filter((row) => Number(row.unread_count) > 0);
    if (filter === 'clientes') rows = rows.filter((row) => row.has_purchase === true);
    if (filter === 'seguimiento') rows = rows.filter((row) => row.next_followup);
    if (filter === 'archivados') rows = rows.filter((row) => row.archived_at);
    if (filter !== 'archivados') rows = rows.filter((row) => !row.archived_at);
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((row) => {
        const customer = waCustomer(row);
        return [customer?.name, customer?.phone_e164, row.last_message?.body]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
    }
    return rows.sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
  }

  /** Una conversación de la lista (nombre o teléfono, nunca un id técnico). */
  function waRow(row) {
    const unread = Number(row.unread_count) || 0;
    const awaiting = waAwaiting(row);
    const last = row.last_message;
    const tipo = last?.type ?? 'text';
    const kind = last && tipo !== 'text' ? WA_KIND_ICON[tipo] ?? '' : '';
    const texto = last
      ? tipo === 'text'
        ? String(last.body ?? '').slice(0, 80)
        : WA_KIND_LABEL[tipo] ?? 'Adjunto'
      : 'Sin mensajes todavía';
    const nombre = waDisplayName(row);
    const followupText = row.next_followup ? fmtDay(row.next_followup.scheduled_at) : null;
    const commercial = COMMERCIAL_HINTS[row.commercial_state] ?? null;
    const assigned = row.assigned_display_name_snapshot
      ? `Atiende ${row.assigned_display_name_snapshot}`
      : 'Sin asignar';
    const compactFlags = [assigned, row.has_purchase ? 'Cliente' : commercial, followupText].filter(Boolean).slice(0, 3);
    const flags =
      unread || awaiting || row.status === 'HUMAN_REQUIRED' || compactFlags.length
        ? `<span class="conv__flags">
            ${unread ? `<span class="conv__unread">${unread}</span>` : ''}
            ${awaiting ? '<span class="conv__await">Pendiente</span>' : ''}
            ${row.status === 'HUMAN_REQUIRED' ? '<span class="conv__await">Necesita una persona</span>' : ''}
            ${compactFlags.map((flag) => `<span class="conv__tag">${escapeHtml(flag)}</span>`).join('')}
          </span>`
        : '';
    const selected = state.wa.selected.has(row.id);
    return `<div class="conv-wrap ${selected ? 'conv-wrap--selected' : ''}">
      <button class="conv ${state.wa.selectedId === row.id ? 'conv--active' : ''} ${unread ? 'conv--unread' : ''}" data-conv="${escapeHtml(
        row.id,
      )}" type="button" aria-label="Abrir conversación con ${escapeHtml(nombre)}">
        <span class="avatar conv__avatar" aria-hidden="true">${escapeHtml(waInitials(nombre))}</span>
        <span class="conv__body">
          <span class="conv__top">
            <span class="conv__name">${escapeHtml(nombre)}</span>
            <span class="conv__when">${row.last_message_at ? escapeHtml(fmtWhen(row.last_message_at)) : ''}</span>
          </span>
          <span class="conv__preview">${kind ? `<span class="conv__kind" aria-hidden="true">${kind}</span>` : ''}<span>${escapeHtml(texto)}</span></span>
          ${flags}
        </span>
      </button>
      <button class="conv-select" data-conv-select="${escapeHtml(row.id)}" type="button" aria-pressed="${selected}" aria-label="${
        selected ? 'Quitar de la selección' : 'Seleccionar conversación'
      }">${selected ? 'Sel' : ''}</button>
    </div>`;
  }

  function playNewMessageSound() {
    if (!state.wa.sound) return;
    try {
      const audio = new AudioContext();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 740;
      gain.gain.value = 0.025;
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.08);
      setTimeout(() => audio.close().catch(() => {}), 180);
    } catch {
      /* sin audio: no pasa nada */
    }
  }

  function notifyNewInbound(row) {
    if (!row?.last_message || row.last_message.direction !== 'inbound') return;
    const messageKey = `${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`;
    if (state.wa.seenMessages.has(messageKey)) return;
    state.wa.seenMessages.add(messageKey);
    toast(`Nuevo mensaje de ${waDisplayName(row)}`);
    playNewMessageSound();
    if (
      state.wa.notify &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      (document.visibilityState !== 'visible' || state.tab !== 'whatsapp')
    ) {
      const text = row.last_message.type === 'text' ? String(row.last_message.body ?? '').slice(0, 80) : WA_KIND_LABEL[row.last_message.type] ?? 'Nuevo mensaje';
      new Notification(NEGOCIO, { body: `${waDisplayName(row)}: ${text}`, tag: `wa-${row.id}`, silent: !state.wa.sound });
    }
  }

  function waBulkBar() {
    const count = state.wa.selected.size;
    if (!count) return '';
    const archived = state.wa.filter === 'archivados';
    return `<div class="wa-bulk" role="toolbar" aria-label="Acciones masivas">
      <span>${count} seleccionados</span>
      <button class="btn btn--ghost btn--sm" data-wa-bulk="mark_read" type="button">Marcar leído</button>
      <button class="btn btn--ghost btn--sm" data-wa-bulk="${archived ? 'unarchive' : 'archive'}" type="button">${
        archived ? 'Desarchivar' : 'Archivar'
      }</button>
      <button class="btn btn--ghost btn--sm" data-wa-bulk="message_preview" type="button">Mensaje</button>
    </div>`;
  }

  function renderWaList() {
    const box = $('#wa-conversations');
    const error = $('#wa-error');
    if (!box || !error) return;

    // Una caída del API NO puede parecer “no hay mensajes”.
    if (state.wa.listError) {
      error.hidden = false;
      error.innerHTML = `<span>No pudimos cargar las conversaciones.</span>
        <button class="btn btn--ghost btn--sm" id="wa-retry" type="button">Reintentar</button>`;
      box.innerHTML = '';
      return;
    }
    error.hidden = true;

    if (!state.conversations.length) {
      box.innerHTML = emptyState('Aún no hay conversaciones. Cuando un cliente escriba por WhatsApp, aparecerá aquí.');
      return;
    }
    const rows = waVisibleConversations();
    const empty = {
      'no-leidos': 'No tienes mensajes nuevos.',
      pendientes: 'No tienes mensajes pendientes.',
      clientes: 'Todavía no hay clientes con compra entregada en esta vista.',
      seguimiento: 'No hay seguimientos pendientes.',
      archivados: 'No hay conversaciones archivadas.',
    }[state.wa.filter] ?? 'No hay conversaciones con este filtro.';
    box.innerHTML = `${waBulkBar()}${rows.length ? rows.map(waRow).join('') : emptyState(empty)}`;
  }

  /**
   * El compositor. Respeta la regla de las 24 h que aplica el servidor: dentro
   * de la ventana se escribe libre; fuera, solo plantillas APROBADAS de verdad.
   */
  function waComposerHtml({ customer, canSendFreeText }) {
    const wa = state.whatsapp ?? {};
    if (!wa.configured) {
      return '<p class="rule rule--warn">WhatsApp no está configurado en el servidor: se reciben mensajes, pero no se pueden enviar.</p>';
    }
    if (customer?.do_not_contact) {
      return '<p class="rule rule--warn">Este cliente pidió no recibir mensajes. Reactívalo solo si te lo pide él.</p>';
    }
    if (!canSendFreeText) {
      const approved = (state.templates ?? []).filter((template) => template.sendable);
      if (!approved.length) {
        return `<p class="rule rule--warn">La ventana de atención de 24 horas terminó. Para contactar nuevamente al cliente debes utilizar una plantilla aprobada.</p>
          <p class="view__hint">Todavía no tienes ninguna plantilla aprobada en Meta.</p>`;
      }
      return `<p class="rule rule--warn">La ventana de atención de 24 horas terminó. Para contactar nuevamente al cliente debes utilizar una plantilla aprobada.</p>
        <label class="field">
          <span class="field__label">Usar plantilla</span>
          <select class="field__select" id="wa-template">
            ${approved
              .map((template) => `<option value="${escapeHtml(template.name)}">${escapeHtml(template.name)}</option>`)
              .join('')}
          </select>
        </label>
        <button class="btn btn--whatsapp btn--block" id="wa-send-template" type="button">Enviar plantilla</button>`;
    }
    const puedeAdjuntar = state.media?.enabled === true;
    const puedeGrabar = typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
    /*
     * Un solo compositor: adjuntar · campo · (audio | enviar), todo dentro de la
     * misma superficie. El micro y el envío viven en la MISMA casilla, así que el
     * cambio de uno a otro no mueve nada de sitio.
     */
    return `<div class="composer-bar">
        <button class="composer-btn" id="wa-attach" type="button" aria-label="Adjuntar imagen o audio"
          title="${
            puedeAdjuntar ? 'Adjuntar imagen o audio' : 'Adjuntar: la multimedia no está activa en el servidor'
          }">${ICONS.plus}</button>
        <textarea id="wa-text" rows="1" placeholder="Escribe un mensaje..." aria-label="Mensaje"></textarea>
        <span class="composer-end">
          <button class="composer-btn" id="wa-mic" type="button" aria-label="Grabar nota de voz"
            title="${
              puedeGrabar
                ? 'Grabar nota de voz'
                : 'Este navegador no permite grabar: usa + para adjuntar un audio'
            }">${puedeGrabar ? ICONS.mic : ICONS.audio}</button>
          <button class="composer-btn composer-btn--send" id="wa-send" type="button" aria-label="Enviar mensaje" hidden>${
            ICONS.send
          }</button>
        </span>
      </div>
      <p class="composer-rule">Enter envía · Shift+Enter salto de línea · Nada se envía solo.</p>`;
  }

  function renderWaChat() {
    const pane = $('#wa-chat-pane');
    const placeholder = $('#wa-placeholder');
    if (!pane || !placeholder) return;

    if (!state.wa.selectedId) {
      pane.hidden = true;
      placeholder.hidden = false;
      return;
    }
    pane.hidden = false;
    placeholder.hidden = true;

    const data = state.wa.chat;
    if (!data) {
      $('#wa-chat-name').textContent = 'Conversación';
      $('#wa-chat-meta').textContent = '';
      $('#thread').innerHTML = '<p class="view__hint">Cargando…</p>';
      $('#wa-composer').innerHTML = state.wa.threadError
        ? `<p class="rule rule--warn">No pudimos cargar esta conversación.</p>
           <button class="btn btn--ghost btn--block" id="wa-retry-thread" type="button">Reintentar</button>`
        : '';
      // Mientras no hay datos no se puede pedir ninguna acción comercial.
      const actionsLoading = $('#wa-actions');
      if (actionsLoading) actionsLoading.disabled = true;
      return;
    }

    const { customer, conversation, messages, canSendFreeText } = data;
    $('#wa-chat-name').textContent = (customer?.name ?? '').trim() || customer?.phone_e164 || 'Conversación';
    $('#wa-chat-meta').textContent = [
      customer?.phone_e164,
      conversation?.assigned_display_name_snapshot ? `Atiende ${conversation.assigned_display_name_snapshot}` : 'Sin asignar',
      conversation?.status === 'HUMAN_REQUIRED' ? 'Necesita una persona' : null,
      customer?.do_not_contact ? 'No contactar' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const viewCustomer = $('#wa-view-customer');
    if (viewCustomer) {
      viewCustomer.dataset.customer = customer?.id ?? '';
      viewCustomer.disabled = !customer?.id;
    }
    // El menú de acciones del chat (crear pedido, programar…) es una sola tecla
    // para no llenar el encabezado de botones en el móvil.
    const actions = $('#wa-actions');
    if (actions) {
      actions.dataset.customer = customer?.id ?? '';
      actions.dataset.conversation = conversation?.id ?? '';
      actions.disabled = !customer?.id;
    }

    const avatar = $('#wa-chat-avatar');
    if (avatar) avatar.textContent = waInitials((customer?.name ?? '').trim() || customer?.phone_e164);

    const assignmentActions = conversation?.assigned_user_id
      ? `<div class="assignment-bar">
          <span>Atiende ${escapeHtml(conversation.assigned_display_name_snapshot ?? 'agente')}</span>
          ${
            conversation.assigned_user_id === currentUser()?.id || isAdmin()
              ? '<button class="btn btn--ghost btn--sm" data-conv-release type="button">Liberar</button>'
              : ''
          }
          ${isAdmin() ? '<button class="btn btn--ghost btn--sm" data-conv-reassign type="button">Reasignar</button>' : ''}
        </div>`
      : `<div class="assignment-bar">
          <span>Sin asignar</span>
          ${currentUser() ? '<button class="btn btn--primary btn--sm" data-conv-take type="button">Tomar conversación</button>' : ''}
        </div>`;
    $('#thread').innerHTML =
      assignmentActions + (messages.length ? waThreadHtml(messages) : '<p class="view__hint">Todavía no hay mensajes.</p>');

    $('#wa-composer').innerHTML = waComposerHtml({ customer, canSendFreeText });
    const area = $('#wa-text');
    if (area) {
      area.value = state.wa.draft ?? '';
      const adjust = () => {
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight, 132)}px`;
        // Sin texto: micrófono. Con texto: Enviar. (El envío nunca es automático.)
        const vacio = !area.value.trim();
        const mic = $('#wa-mic');
        const send = $('#wa-send');
        if (mic) mic.hidden = !vacio;
        if (send) send.hidden = vacio;
      };
      area.addEventListener('input', () => {
        state.wa.draft = area.value;
        adjust();
      });
      area.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          $('#wa-send')?.click();
        }
      });
      adjust();
    }
    /*
     * Abrir una conversación tiene que dejar a la vista lo ÚLTIMO. Las imágenes
     * entran con `loading="lazy"` y crecen cuando llegan, así que se vuelve al
     * final en el cuadro siguiente y cada vez que una imagen termina de cargar.
     */
    const thread = $('#thread');
    if (thread) {
      const irAlFinal = () => {
        thread.scrollTop = thread.scrollHeight;
      };
      irAlFinal();
      // `requestAnimationFrame` no existe en todos los entornos de prueba: si no
      // está, basta con el empujón de arriba.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(irAlFinal);
      $$('img', thread).forEach((img) => img.addEventListener('load', irAlFinal, { once: true }));
    }

    $('#wa-send')?.addEventListener('click', (event) => {
      const body = $('#wa-text').value.trim();
      if (!body) {
        toast('Escribe el mensaje');
        return;
      }
      sendWaMessage({ body }, event.currentTarget);
    });
    $('#wa-send-template')?.addEventListener('click', (event) =>
      sendWaMessage({ template: $('#wa-template').value || null }, event.currentTarget),
    );
  }

  // ------------------------------------------------------------- MULTIMEDIA
  /*
   * Imagen y audio, encima de la UI comercial (nada de esto cambia el menú ⋯ ni
   * el flujo de pedido). El archivo se pide SIEMPRE a `/api/admin/media/:id` con
   * la sesión del panel: el bucket es privado y el navegador nunca ve su
   * dirección, ni la clave del objeto, ni ningún token.
   *
   * El compositor tiene TRES estados y ninguno envía solo:
   *   elegir archivo → PREVISUALIZAR → (cancelar | ENVIAR)
   *   grabar         → DETENER      → PREVISUALIZAR → (borrar/regrabar | ENVIAR)
   */

  const mediaUrl = (id) => `/api/admin/media/${encodeURIComponent(id)}`;
  const mediaReady = () => state.media?.enabled === true;

  /** Tipos que el almacén y Meta aceptan hoy (coincide con `server/storage.mjs`). */
  const AUDIO_MIME_OK = ['audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/amr', 'audio/opus'];
  const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
  const AUDIO_ACCEPT = 'audio/ogg,audio/mp4,audio/mpeg,audio/aac,audio/amr,audio/webm,audio/*';

  const fmtSeconds = (value) => {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const fmtBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  const uploadKey = (kind) =>
    `m:${kind}:${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 40)}`;

  /**
   * Escapa un valor para usarlo en un selector. `CSS.escape` existe en todos los
   * navegadores modernos, pero no en cualquier entorno: si falta, se usa un escape
   * mínimo equivalente para los identificadores que genera el CRM (letras, números,
   * guion y dos puntos).
   */
  const cssEscape = (value) => {
    const raw = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(raw);
    return raw.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
  };

  /**
   * ¿Qué tipo puede grabar este navegador? Se pregunta de verdad con
   * `MediaRecorder.isTypeSupported` y se guarda lo que responde: no se supone
   * nada, porque grabar en un formato que Meta no acepta es prometer de más.
   */
  function detectSupportedRecordingType() {
    if (typeof window.MediaRecorder === 'undefined') return null;
    const candidates = [
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    for (const candidate of candidates) {
      try {
        if (window.MediaRecorder.isTypeSupported?.(candidate)) return candidate;
      } catch {
        /* un navegador que lanza aquí no soporta: se sigue probando */
      }
    }
    return ''; // sin preferencia: el navegador decide (puede ser webm)
  }

  /** ¿Ese audio se puede enviar a WhatsApp hoy? (si no, se dice, no se finge) */
  const audioSendable = (mime) => AUDIO_MIME_OK.includes(String(mime ?? '').split(';')[0].trim());

  /**
   * Formatos que WhatsApp NO acepta tal cual pero que el SERVIDOR sabe convertir a
   * OGG/Opus antes de enviarlos (`server/audio-normalize.mjs`).
   *
   * Es el caso de Windows: el navegador graba en WebM, así que rechazarlo en el
   * panel era rechazar el audio de media plantilla. El servidor lo convierte.
   */
  const AUDIO_CONVERTIBLE = ['audio/webm', 'audio/wav', 'audio/x-wav'];
  const audioConvertible = (mime) =>
    AUDIO_CONVERTIBLE.includes(String(mime ?? '').split(';')[0].trim().toLowerCase());
  /** ¿Este servidor puede convertir? Lo dice `/api/admin/data` (`media.audioNormalize`). */
  const puedeConvertirAudio = () => state.media?.audioNormalize === true;

  // ------------------------------------------------- reproductor de audio
  /*
   * Un solo elemento de audio para toda la conversación: así, al reproducir otro,
   * el anterior se para (no suenan dos a la vez) y no hay autoplay: solo suena lo
   * que alguien pulsa.
   */
  let sharedAudio = null;
  let audioOwner = null;
  let audioBlocked = null;
  let ultimoAvisoAudio = 0;

  /**
   * El archivo no se pudo decodificar (descarga cortada, formato que el navegador
   * no entiende): el botón vuelve a «▶» en vez de quedarse en «❚❚» para siempre,
   * que haría creer que está sonando. Se avisa una sola vez por intento.
   */
  function audioNoReproducible() {
    audioBlocked = audioOwner;
    const row = audioOwner ? $(`[data-audio="${cssEscape(audioOwner)}"]`) : null;
    const play = row?.querySelector('[data-audio-play]');
    const current = row?.querySelector('[data-audio-current]');
    if (play) {
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Reproducir');
    }
    if (current) current.textContent = '0:00';
    const ahora = Date.now();
    if (ahora - ultimoAvisoAudio > 1500) {
      ultimoAvisoAudio = ahora;
      toast('No se pudo reproducir el audio');
    }
  }

  function ensureAudio() {
    if (sharedAudio) return sharedAudio;
    sharedAudio = new Audio();
    sharedAudio.preload = 'metadata';
    sharedAudio.addEventListener('timeupdate', syncAudioPlayer);
    sharedAudio.addEventListener('loadedmetadata', () => {
      // El archivo SÍ se pudo leer: se levanta el bloqueo anterior.
      audioBlocked = null;
      syncAudioPlayer();
    });
    sharedAudio.addEventListener('pause', syncAudioPlayer);
    sharedAudio.addEventListener('play', syncAudioPlayer);
    sharedAudio.addEventListener('error', audioNoReproducible);
    sharedAudio.addEventListener('ended', () => {
      sharedAudio.currentTime = 0;
      syncAudioPlayer();
    });
    return sharedAudio;
  }

  function syncAudioPlayer() {
    const row = audioOwner ? $(`[data-audio="${cssEscape(audioOwner)}"]`) : null;
    if (!row || !sharedAudio) return;
    const seek = row.querySelector('[data-audio-seek]');
    const current = row.querySelector('[data-audio-current]');
    const total = row.querySelector('[data-audio-total]');
    const play = row.querySelector('[data-audio-play]');
    const duration = Number(sharedAudio.duration);
    if (current) current.textContent = fmtSeconds(sharedAudio.currentTime);
    if (total) total.textContent = Number.isFinite(duration) && duration > 0 ? fmtSeconds(duration) : '--:--';
    if (seek && Number.isFinite(duration) && duration > 0) {
      const avance = sharedAudio.currentTime / duration;
      seek.value = String(Math.round(avance * 1000));
      /* La barra se pinta con esta variable: el avance se ve sin repintar el hilo. */
      row.style.setProperty('--audio-progress', `${Math.round(avance * 100)}%`);
    }
    if (play) {
      // Sonando = de verdad suena: si el archivo no se pudo decodificar
      // (`error`), el botón NO puede quedarse en «pausar».
      const sonando = !sharedAudio.paused && !sharedAudio.error && audioBlocked !== audioOwner;
      play.textContent = sonando ? '❚❚' : '▶';
      play.setAttribute('aria-label', sonando ? 'Pausar' : 'Reproducir');
      row.classList.toggle('audio--playing', sonando);
    }
  }

  function toggleAudio(mediaId, src) {
    const audio = ensureAudio();
    if (audioOwner === mediaId && !audio.paused) {
      audio.pause();
      syncAudioPlayer();
      return;
    }
    if (audioOwner !== mediaId) {
      audioOwner = mediaId;
      audioBlocked = null;
      audio.src = src;
      audio.currentTime = 0;
    }
    audioBlocked = null; // si vuelve a fallar, el aviso y el «▶» vuelven solos
    audio.play().catch(() => {
      audio.pause?.();
      audioNoReproducible();
    });
    syncAudioPlayer();
  }

  function seekAudio(mediaId, ratio) {
    const audio = ensureAudio();
    if (audioOwner !== mediaId) return;
    const duration = Number(audio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = Math.min(duration, Math.max(0, duration * (Number(ratio) / 1000)));
    syncAudioPlayer();
  }

  // ------------------------------------------------------------- visor
  function openViewer(mediaId) {
    const viewer = $('#media-viewer');
    const image = $('#media-viewer-img');
    if (!viewer || !image) return;
    image.src = mediaUrl(mediaId);
    viewer.hidden = false;
  }

  function closeViewer() {
    const viewer = $('#media-viewer');
    const image = $('#media-viewer-img');
    if (!viewer) return;
    viewer.hidden = true;
    if (image) image.removeAttribute('src');
  }

  // ------------------------------------------- subida desde el compositor
  /**
   * Manda los BYTES CRUDOS (sin multipart: el servidor decide el tipo mirando el
   * contenido, no la cabecera). La clave se genera AQUÍ y viaja en la petición:
   * repetir el envío con la misma clave no puede crear un segundo mensaje.
   */
  async function uploadMediaFile({ conversationId, kind, file, caption, key }) {
    const query = new URLSearchParams({ kind, key: key ?? uploadKey(kind) });
    if (caption) query.set('caption', caption);
    const response = await fetch(
      `/api/admin/conversations/${encodeURIComponent(conversationId)}/media?${query.toString()}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': file.type || (kind === 'audio' ? 'audio/ogg' : 'image/png'),
          'x-phyto-filename': file.name || kind,
        },
        body: file,
      },
    );
    const raw = await response.text();
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(body.message ?? 'No se pudo enviar el archivo');
      error.body = body;
      throw error;
    }
    return body;
  }

  /**
   * Cuando el envío queda AMBIGUO (pudo salir o no), desde el chat no se
   * reintenta NUNCA: se avisa, se cierra la hoja y se refrescan los datos para
   * que la cola de revisión de Ajustes esté al día (si no, el vendedor no vería
   * nada que revisar hasta la siguiente recarga).
   */
  async function avisoEnvioAmbiguo(error) {
    const ambiguo = error.body?.error === 'send_unknown';
    toast(
      ambiguo
        ? 'No se pudo confirmar si el mensaje salió. No se reintenta solo: míralo en Ajustes → «Envíos de archivo por revisar».'
        : error.body?.message ?? 'No se pudo enviar el archivo',
    );
    if (ambiguo) {
      closeSheet();
      await load({ keepTab: true });
    }
  }

  /** Elegir un archivo del teléfono y PREVISUALIZARLO (nunca se envía al elegir). */
  function openAttachSheet(conversationId) {
    if (!conversationId) return;
    /*
     * Una UBICACIÓN no necesita almacén de archivos: se puede enviar aunque la
     * multimedia esté apagada. El resto (imagen/audio) sí necesita R2.
     */
    const soloUbicacion = !mediaReady();
    openSheet(
      'Adjuntar',
      `
      ${
        soloUbicacion
          ? `<p class="rule rule--warn">La multimedia no está activa en el servidor: faltan las variables del
             almacén de archivos (R2) o las credenciales de WhatsApp. Los mensajes de texto y las ubicaciones siguen funcionando.</p>`
          : '<p class="view__hint">Nada se envía al elegir: primero lo ves y después lo mandas.</p>'
      }
      <div class="menu-list">
        ${
          soloUbicacion
            ? ''
            : `<button class="menu-item" id="attach-image" type="button">
                 <span class="menu-item__icon" aria-hidden="true">${ICONS.image}</span>
                 <span><strong>Imagen</strong><small>JPG, PNG o WebP · hasta 5 MB</small></span>
               </button>
               <button class="menu-item" id="attach-audio" type="button">
                 <span class="menu-item__icon" aria-hidden="true">${ICONS.audio}</span>
                 <span><strong>Audio</strong><small>Un archivo de audio · hasta 16 MB</small></span>
               </button>`
        }
        <button class="menu-item" id="attach-location" type="button">
          <span class="menu-item__icon" aria-hidden="true">📍</span>
          <span><strong>Ubicación</strong><small>Elegir, previsualizar y confirmar antes de enviar</small></span>
        </button>
      </div>
      <input id="attach-image-input" type="file" accept="${IMAGE_ACCEPT}" hidden />
      <input id="attach-audio-input" type="file" accept="${AUDIO_ACCEPT}" hidden />
      `,
      { variant: 'menu' },
    );

    $('#attach-location').addEventListener('click', () => {
      const customer = waCustomer(state.conversations.find((row) => row.id === conversationId) ?? {});
      closeSheet();
      openSendLocation({ conversationId, customerId: customer?.id ?? null });
    });

    if (soloUbicacion) return;

    const pick = (inputSelector, kind) => {
      const input = $(inputSelector);
      input.value = '';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) openMediaPreview({ conversationId, kind, file });
      };
      input.click();
    };
    $('#attach-image').addEventListener('click', () => pick('#attach-image-input', 'image'));
    $('#attach-audio').addEventListener('click', () => pick('#attach-audio-input', 'audio'));
  }

  /** Previsualización de un archivo elegido, con ENVIAR explícito. */
  function openMediaPreview({ conversationId, kind, file, key, durationMs }) {
    const objectUrl = URL.createObjectURL(file);
    const mime = String(file.type || '').split(';')[0].trim();
    /*
     * ¿SE PUEDE ENVIAR? Lo decide el SERVIDOR, no el navegador.
     *
     * El servidor mira los BYTES (`sniffMime`) y es la única puerta de verdad; el
     * navegador, en cambio, muchas veces NO sabe qué tipo es un archivo: en
     * Windows un `.m4a` o un `.amr` llegan con `type` vacío. Bloquear aquí por lo
     * que dice el navegador dejaba al vendedor sin poder mandar un audio válido
     * (el botón se quedaba gris y no pasaba NADA al pulsarlo).
     *
     * Por eso solo se bloquea el caso que SÍ se conoce y no tiene arreglo posible
     * en el servidor: un WebM (lo que graba Windows) sin conversor instalado.
     * Todo lo demás se envía y, si no vale, el servidor lo dice con su mensaje.
     */
    const seConvierte = kind === 'audio' && audioConvertible(mime) && puedeConvertirAudio();
    const audioSinSalida = kind === 'audio' && audioConvertible(mime) && !puedeConvertirAudio();
    const puedeEnviar = !audioSinSalida;
    const aviso = audioSinSalida
      ? `<p class="rule rule--warn">Este audio está en <strong>${escapeHtml(mime)}</strong> y el servidor no tiene el
         conversor instalado (falta <strong>ffmpeg</strong>). Puedes oírlo aquí, pero para enviarlo adjunta un audio
         en <strong>M4A, MP3, AAC, AMR u OGG/Opus</strong> (esos no necesitan conversión).</p>`
      : seConvierte
        ? `<p class="view__hint">WhatsApp no acepta <strong>${escapeHtml(mime)}</strong>: se enviará convertido a
             <strong>OGG/Opus</strong> (voz, mono). No tienes que hacer nada.</p>`
        : kind === 'audio' && !mime
          ? `<p class="view__hint">El navegador no dice de qué tipo es este archivo: lo comprobará el servidor
               por su contenido al enviarlo (si no vale, te lo dirá sin enviar nada).</p>`
          : kind === 'image' && mime && !mime.startsWith('image/')
            ? `<p class="view__hint">El navegador dice <strong>${escapeHtml(mime)}</strong>: el servidor lo comprobará
                 por su contenido al enviarlo.</p>`
            : '';
    openSheet(
      kind === 'image' ? 'Enviar imagen' : 'Enviar audio',
      `
      <div class="attach-preview">
        ${
          kind === 'image'
            ? `<img src="${escapeHtml(objectUrl)}" alt="Previsualización" />`
            : `<audio src="${escapeHtml(objectUrl)}" controls preload="metadata"></audio>`
        }
        <p class="attach-preview__meta">
          <span>${escapeHtml(file.name || (kind === 'image' ? 'Imagen' : 'Audio'))}</span>
          <span>${escapeHtml(mime || 'tipo desconocido')} · ${fmtBytes(file.size)}${durationMs ? ` · ${fmtSeconds(durationMs / 1000)}` : ''}</span>
        </p>
      </div>
      ${aviso}
      ${
        kind === 'image'
          ? `<label class="field">
               <span class="field__label">Texto (opcional)</span>
               <input class="field__input" id="attach-caption" maxlength="400" placeholder="Mira, este es el frasco…" />
             </label>`
          : ''
      }
      <button class="btn btn--primary btn--block" id="attach-send" type="button" ${puedeEnviar ? '' : 'disabled'}>Enviar</button>
      <button class="btn btn--ghost btn--block" id="attach-cancel" type="button">Cancelar</button>
      `,
    );

    const cleanup = () => URL.revokeObjectURL(objectUrl);
    $('#attach-cancel').addEventListener('click', () => {
      cleanup();
      closeSheet();
    });
    $('#attach-send').addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          const caption = kind === 'image' ? ($('#attach-caption')?.value ?? '').trim() : '';
          await uploadMediaFile({ conversationId, kind, file, caption, key: key ?? uploadKey(kind) });
          cleanup();
          toast(kind === 'image' ? 'Imagen enviada' : 'Audio enviado');
          closeSheet();
          await load({ keepTab: true });
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') {
            // Un envío AMBIGUO no se puede repetir desde aquí: se explica y se
            // resuelve en Ajustes (recuperación), nunca con un botón en el chat.
            await avisoEnvioAmbiguo(error);
          }
        }
      });
    });
  }

  /**
   * GRABAR una nota de voz: permiso → grabar (con contador) → DETENER →
   * PREVISUALIZAR → borrar/regrabar → ENVIAR. Nunca se envía al detener.
   */
  function openRecorder(conversationId) {
    if (!conversationId) return;
    const supportedType = detectSupportedRecordingType();
    if (!navigator.mediaDevices?.getUserMedia || supportedType === null) {
      openSheet(
        'Nota de voz',
        `<p class="rule rule--warn">Este navegador no permite grabar directamente. Puedes adjuntar un archivo
         de audio con el botón <strong>+</strong>.</p>
         <button class="btn btn--ghost btn--block" id="rec-attach" type="button">Adjuntar un audio</button>`,
      );
      $('#rec-attach').addEventListener('click', () => openAttachSheet(conversationId));
      return;
    }

    openSheet(
      'Nota de voz',
      `
      <p class="view__hint">Se graba con el micrófono del teléfono y <strong>no se envía hasta que tú lo mandes</strong>.</p>
      <div class="rec-status" id="rec-status"><span class="rec-dot" hidden></span><span id="rec-time">0:00</span></div>
      <div class="attach-preview" id="rec-preview" hidden></div>
      <button class="btn btn--primary btn--block" id="rec-start" type="button">Grabar</button>
      <button class="btn btn--danger btn--block" id="rec-stop" type="button" hidden>Detener</button>
      <button class="btn btn--ghost btn--block" id="rec-reset" type="button" hidden>Borrar y regrabar</button>
      <button class="btn btn--primary btn--block" id="rec-send" type="button" hidden>Enviar</button>
      <button class="btn btn--ghost btn--block" id="rec-attach" type="button">Adjuntar un audio en su lugar</button>
      `,
    );

    let recorder = null;
    let chunks = [];
    let blob = null;
    let objectUrl = null;
    let startedAt = 0;
    let timer = null;
    let stream = null;

    const preview = $('#rec-preview');
    const tick = () => {
      const seconds = (Date.now() - startedAt) / 1000;
      $('#rec-time').textContent = fmtSeconds(seconds);
      if (seconds >= 300) $('#rec-stop').click(); // tope de duración del audio
    };

    const reset = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      blob = null;
      preview.hidden = true;
      preview.innerHTML = '';
      $('#rec-time').textContent = '0:00';
      $('#rec-start').hidden = false;
      $('#rec-stop').hidden = true;
      $('#rec-reset').hidden = true;
      $('#rec-send').hidden = true;
      $('#rec-status').querySelector('.rec-dot').hidden = true;
    };

    const stopStream = () => {
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
    };

    $('#rec-start').addEventListener('click', async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('No se pudo usar el micrófono (permiso denegado)');
        return;
      }
      chunks = [];
      // El tipo REAL lo dice el grabador; lo guardamos tal cual (sin suponer).
      recorder = new window.MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        clearInterval(timer);
        const realType = recorder?.mimeType || chunks[0]?.type || supportedType || '';
        blob = new Blob(chunks, { type: realType });
        objectUrl = URL.createObjectURL(blob);
        preview.hidden = false;
        preview.innerHTML = `
          <audio src="${escapeHtml(objectUrl)}" controls preload="metadata"></audio>
          <p class="attach-preview__meta"><span>Nota de voz</span>
          <span>${escapeHtml(realType || 'tipo desconocido')} · ${fmtBytes(blob.size)}</span></p>`;
        $('#rec-status').querySelector('.rec-dot').hidden = true;
        $('#rec-start').hidden = true;
        $('#rec-stop').hidden = true;
        $('#rec-reset').hidden = false;
        $('#rec-send').hidden = false;
        /*
         * Si el navegador grabó en un formato que WhatsApp no acepta, hay dos
         * verdades distintas y no se mezclan:
         *   · el servidor sabe convertirlo → se puede enviar, y se dice que se
         *     convierte a OGG/Opus;
         *   · no sabe → no se deja enviar y se explica qué adjuntar.
         * Prometer compatibilidad sin comprobarla no es aceptable en ningún caso.
         */
        const seConvierte = audioConvertible(realType) && puedeConvertirAudio();
        if (!audioSendable(realType) && !seConvierte) {
          // No se finge compatibilidad: si el servidor no sabe convertirlo, no se
          // puede mandar. Y se dice la causa REAL (falta el conversor), no se
          // culpa al formato a secas: así se arregla de verdad (instalar ffmpeg).
          $('#rec-send').disabled = true;
          preview.insertAdjacentHTML(
            'beforeend',
            audioConvertible(realType)
              ? `<p class="rule rule--warn">El servidor no tiene el conversor instalado (falta <strong>ffmpeg</strong>),
                 y este navegador graba en <strong>${escapeHtml(realType)}</strong>. Mientras no se instale, adjunta un
                 audio en <strong>M4A, MP3, AAC, AMR u OGG/Opus</strong> con «Adjuntar un audio en su lugar».</p>`
              : `<p class="rule rule--warn">Tu navegador grabó en <strong>${escapeHtml(realType || 'un formato desconocido')}</strong>,
                 que WhatsApp todavía no acepta. Puedes oírlo y borrarlo, o adjuntar un audio en OGG, M4A o MP3.</p>`,
          );
        } else {
          $('#rec-send').disabled = false;
          if (!audioSendable(realType)) {
            preview.insertAdjacentHTML(
              'beforeend',
              `<p class="view__hint">Grabado en <strong>${escapeHtml(realType)}</strong>: al enviarlo se convierte a
               <strong>OGG/Opus</strong>.</p>`,
            );
          }
        }
        stopStream();
      };
      recorder.start();
      startedAt = Date.now();
      timer = setInterval(tick, 200);
      $('#rec-time').textContent = '0:00';
      $('#rec-status').querySelector('.rec-dot').hidden = false;
      $('#rec-start').hidden = true;
      $('#rec-stop').hidden = false;
      $('#rec-reset').hidden = true;
      $('#rec-send').hidden = true;
    });

    $('#rec-stop').addEventListener('click', () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    });

    $('#rec-reset').addEventListener('click', () => {
      reset();
    });

    $('#rec-send').addEventListener('click', async (event) => {
      if (!blob) return;
      const file = new File([blob], `nota-de-voz.${(blob.type || '').includes('ogg') ? 'ogg' : 'audio'}`, {
        type: blob.type || 'audio/ogg',
      });
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          await uploadMediaFile({ conversationId, kind: 'audio', file, key: uploadKey('audio') });
          toast('Nota de voz enviada');
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          closeSheet();
          await load({ keepTab: true });
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') await avisoEnvioAmbiguo(error);
        }
      });
    });

    $('#rec-attach').addEventListener('click', () => openAttachSheet(conversationId));
    closeSheetCleanup = () => {
      clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stopStream();
    };
  }

  /** Al cerrar la hoja: nada de micrófono abierto ni temporizadores vivos. */
  let closeSheetCleanup = null;

  /** Reintentar la descarga de un archivo que quedó en Failed (era de Meta). */
  async function retryMedia(mediaId) {
    try {
      await api(`/api/admin/media/retry/${encodeURIComponent(mediaId)}`, { method: 'POST' });
      toast('Reintentando la descarga…');
      await sleep(600);
      if (state.wa.selectedId) await loadWaThread(state.wa.selectedId, { force: true });
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo reintentar');
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setWaView(view) {
    const box = $('#wa');
    if (box) box.dataset.view = view;
    /* La hoja de estilos necesita saberlo para el modo "conversación a pantalla
     * completa" (ahí no hay menú flotante: se vuelve con ←). */
    document.body.dataset.waView = view;
  }

  /** Abre una conversación: carga el hilo y apaga la insignia de no leído. */
  async function selectConversation(conversationId, options = {}) {
    if (!conversationId) return;
    state.wa.selectedId = conversationId;
    state.wa.followupId = options.followupId ?? null;
    state.wa.chat = null;
    state.wa.chatSig = null;
    state.wa.threadError = false;
    state.wa.draft = '';
    setWaView('chat');
    renderWhatsapp();
    await loadWaThread(conversationId, { force: true });
  }

  async function loadWaThread(conversationId, options = {}) {
    // Evita peticiones duplicadas de la misma conversación.
    if (!options.force && state.wa.loadingFor === conversationId) return;
    state.wa.loadingFor = conversationId;
    try {
      const [data, templates] = await Promise.all([
        api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`),
        api('/api/admin/wa-templates').catch(() => ({ templates: state.templates ?? [] })),
      ]);
      if (state.wa.selectedId !== conversationId) return; // se cambió mientras cargaba
      state.templates = templates.templates ?? [];
      state.wa.chat = data;
      state.wa.chatSig = waThreadSig(data);
      state.wa.threadError = false;
      renderWaChat();
      if (Number(data.conversation?.unread_count) > 0) {
        // Leído ≠ contestado: apaga la insignia de no leído, no la de “sin responder”.
        const row = state.conversations.find((candidate) => candidate.id === conversationId);
        if (row) row.unread_count = 0;
        renderWaList();
        api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST' }).catch(() => {});
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      state.wa.chat = null;
      state.wa.threadError = true;
      renderWaChat();
    } finally {
      state.wa.loadingFor = null;
    }
  }

  /** Envío MANUAL: solo se llama desde el botón Enviar. */
  async function sendWaMessage(payload, button) {
    const conversationId = state.wa.selectedId;
    if (!conversationId) return;
    await working(button, 'Enviando…', async () => {
      try {
        await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        state.wa.draft = '';
        toast('Mensaje enviado');
        const followupId = state.wa.followupId;
        state.wa.followupId = null;
        await load({ keepTab: true });
        await loadWaThread(conversationId, { force: true });
        if (followupId) toast('Seguimiento marcado como hecho');
      } catch (error) {
        if (error.message !== 'unauthorized') {
          // El servidor explica la regla (24 h, no contactar, plantilla sin aprobar).
          toast(error.body?.message ?? 'No se pudo enviar');
        }
      }
    });
  }

  async function runWaBulk(action) {
    const ids = [...state.wa.selected];
    if (!ids.length) return;
    try {
      const result = await api('/api/admin/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, ids }),
      });
      if (action === 'message_preview') {
        const blocked = result.results.filter((row) => row.reason === 'do_not_contact').length;
        const free = result.results.filter((row) => row.reason === 'free_text_24h').length;
        const template = result.results.filter((row) => row.reason === 'template_required').length;
        openSheet(
          'Mensaje a varios',
          `<dl class="facts">
            <div class="fact"><dt>Seleccionados</dt><dd>${result.selected}</dd></div>
            <div class="fact"><dt>Elegibles 24 h</dt><dd>${free}</dd></div>
            <div class="fact"><dt>Requieren plantilla</dt><dd>${template}</dd></div>
            <div class="fact"><dt>Excluidos no contactar</dt><dd>${blocked}</dd></div>
          </dl>
          <p class="rule">Esta vista solo valida destinatarios. No se envía nada desde aquí.</p>`,
        );
        return;
      }
      toast(`${result.processed} procesados${result.failed ? `, ${result.failed} fallaron` : ''}`);
      state.wa.selected.clear();
      await refreshWhatsapp();
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo completar la acción');
    }
  }

  /**
   * Refresco ligero (lo usa el botón ⟳ y el sondeo). Solo vuelve a pintar lo que
   * de verdad ha cambiado, para no borrar lo que una persona está escribiendo.
   */
  async function refreshWhatsapp() {
    const params = new URLSearchParams();
    params.set('filter', state.wa.filter);
    if (state.wa.q) params.set('q', state.wa.q);
    const list = await api(`/api/admin/conversations?${params.toString()}`);
    const rows = list.conversations ?? [];
    state.wa.counts = list.counts ?? state.wa.counts;
    const listSig = JSON.stringify(
      rows.map((row) => [
        row.id,
        row.unread_count,
        row.last_message_at,
        row.status,
        row.awaiting_reply === true,
        row.archived_at ?? '',
        row.has_purchase === true,
        row.next_followup?.scheduled_at ?? '',
      ]),
    );
    if (listSig !== state.wa.listSig) {
      const previousKeys = new Set(
        state.conversations.map((row) => `${row.id}:${row.last_message?.at ?? row.last_message_at ?? ''}`),
      );
      state.wa.listSig = listSig;
      state.conversations = rows;
      state.wa.listError = false;
      for (const row of rows) {
        const key = `${row.id}:${row.last_message?.at ?? row.last_message_at ?? ''}`;
        if (!previousKeys.has(key)) notifyNewInbound(row);
      }
      renderWhatsapp();
    } else {
      renderWaList();
    }

    const conversationId = state.wa.selectedId;
    if (!conversationId) return;
    const data = await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (state.wa.selectedId !== conversationId) return;
    const sig = waThreadSig(data);
    if (sig === state.wa.chatSig) return;
    state.wa.chatSig = sig;
    state.wa.chat = data;
    state.wa.threadError = false;
    renderWaChat();
  }

  let waPolling = false;

  /** Un solo temporizador para todo el panel: nada de timers huérfanos. */
  function waPollTick() {
    if ($('#app')?.hidden) return; // con la sesión cerrada (o el panel oculto) no se sondea
    if (state.tab !== 'whatsapp') return; // fuera de la pestaña no se gasta red
    if (document.visibilityState !== 'visible') return; // ni con la app en segundo plano
    if (waPolling) return; // ni dos peticiones a la vez
    waPolling = true;
    refreshWhatsapp()
      .catch((error) => {
        if (error.message === 'unauthorized') return;
        if (!state.conversations.length) {
          state.wa.listError = true;
          renderWaList();
        }
      })
      .finally(() => {
        waPolling = false;
      });
  }

  /** Ficha 360 del cliente: compras, chat, seguimiento y consentimiento. */
  async function openCustomer(customerId) {
    if (!customerId) return;
    state.openId = null;
    state.chat = null;
    state.customerId = customerId;
    const customer = customerById(customerId);
    openSheet(customer?.name ?? 'Cliente', '<p class="view__hint">Cargando…</p>');
    try {
      const profile = await api(`/api/admin/customers/${encodeURIComponent(customerId)}`);
      renderCustomer(profile);
    } catch (error) {
      if (error.message === 'unauthorized') return;
      openSheet('Cliente', '<p class="rule rule--warn">No se pudo cargar la ficha.</p>');
    }
  }

  function renderCustomer(profile) {
    const { customer, totals, purchases, nextFollowup, followups, conversation, canSendFreeText } = profile;
    const scheduled = profile.scheduled ?? [];
    const commercial = profile.commercial_state ?? customer.commercial_state ?? 'NUEVO';
    const phone = digits(customer.phone_e164 ?? customer.phone);
    const conversationRow = conversation ?? conversationForCustomer(customer.id);
    const estado = {
      AUTOMATIC: 'Automático (puede recibir seguimiento)',
      HUMAN_REQUIRED: 'Necesita una persona',
      HUMAN_ACTIVE: 'Hablando con el negocio',
      PAUSED: 'En pausa',
      CLOSED: 'Cerrado',
    }[customer.automation_state] ?? customer.automation_state;

    openSheet(
      customer.name ?? customer.phone_e164,
      `
      <div>
        <span class="tag tag--recordatorio">${escapeHtml(commercialLabel(commercial))}</span>
        ${customer.do_not_contact ? '<span class="tag tag--perdido">No contactar</span>' : ''}
        <span class="tag">${escapeHtml(customer.source ?? 'origen desconocido')}</span>
        ${nextFollowup ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(nextFollowup.scheduled_at))}</span>` : ''}
      </div>
      <div class="item__actions" style="margin-top:0">
        <button class="btn btn--primary btn--sm" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Crear pedido</button>
        <button class="btn btn--ghost btn--sm" data-followup-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Programar seguimiento</button>
        <button class="btn btn--ghost btn--sm" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Programar mensaje</button>
      </div>
      <label class="field">
        <span class="field__label">Estado comercial</span>
        <select class="field__select" id="customer-commercial">
          <option value="" ${customer.commercial_state_manual ? '' : 'selected'}>Automático (${escapeHtml(
            commercialLabel(commercial),
          )})</option>
          ${(state.commercial?.manual ?? ['INTERESADO', 'PERDIDO'])
            .map(
              (value) =>
                `<option value="${escapeHtml(value)}" ${
                  customer.commercial_state_manual === value ? 'selected' : ''
                }>${escapeHtml(commercialLabel(value))} (a mano)</option>`,
            )
            .join('')}
        </select>
        <p class="view__hint">El estado se deriva de los hechos. Solo «Interesado» y «Perdido» se fijan a mano.</p>
      </label>
      <dl class="facts">
        <div class="fact"><dt>Teléfono</dt><dd><a href="tel:${escapeHtml(phone)}">${escapeHtml(customer.phone_e164 ?? customer.phone ?? '—')}</a></dd></div>
        ${customer.location ? `<div class="fact"><dt>Ciudad</dt><dd>${escapeHtml(customer.location)}</dd></div>` : ''}
        <div class="fact"><dt>Compras entregadas</dt><dd>${totals.total_purchases}</dd></div>
        <div class="fact"><dt>Total entregado</dt><dd>${money(totals.total_spent)}</dd></div>
        <div class="fact"><dt>Última compra</dt><dd>${totals.last_purchase_at ? escapeHtml(fmtWhen(totals.last_purchase_at)) : '—'}</dd></div>
        <div class="fact"><dt>Pedidos sin cerrar</dt><dd>${totals.open_purchases}</dd></div>
        <div class="fact"><dt>Próximo seguimiento</dt><dd>${nextFollowup ? escapeHtml(fmtDay(nextFollowup.scheduled_at)) : 'ninguno'}</dd></div>
        <div class="fact"><dt>Consentimiento</dt><dd>${
          customer.do_not_contact ? 'pidió NO recibir mensajes' : customer.whatsapp_opt_in ? 'sí (dejó sus datos)' : 'sin confirmar'
        }</dd></div>
        <div class="fact"><dt>Estado</dt><dd>${escapeHtml(estado)}</dd></div>
        <div class="fact"><dt>Ventana de 24 h</dt><dd>${canSendFreeText ? 'abierta' : 'cerrada (solo plantillas)'}</dd></div>
      </dl>

      <div class="item__actions" style="margin-top:0">
        ${conversationRow ? `<button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(conversationRow.id)}" type="button">Abrir chat</button>` : ''}
        <button class="btn btn--ghost btn--sm" data-purchase="${escapeHtml(customer.id)}" type="button">Registrar compra</button>
        <button class="btn btn--ghost btn--sm" data-followup-new="${escapeHtml(customer.id)}" type="button">Crear seguimiento</button>
        ${phone ? `<a class="btn btn--ghost btn--sm" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}
      </div>

      <div class="field">
        <span class="field__label">Compras</span>
        ${
          purchases.length
            ? `<dl class="facts">${purchases
                .map(
                  (row) => `<div class="fact"><dt>${escapeHtml(fmtWhen(row.received_at))} · ${escapeHtml(
                    row.variant_name ?? '',
                  )} ×${row.quantity ?? 1}</dt><dd>${escapeHtml(statusLabel(row.status ?? 'nuevo'))} · ${money(
                    row.total,
                    row.currency,
                  )}</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">Todavía no tiene compras registradas.</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Pedidos</span>
        ${
          purchases.length
            ? `<div class="orders">${purchases
                .map(
                  (row) => `<article class="order-card">
                    <div class="order-card__top">
                      <strong>${escapeHtml(row.order_number ?? '—')}</strong>
                      <span class="tag tag--${escapeHtml(row.status ?? 'nuevo')}">${escapeHtml(
                        statusLabel(row.status ?? 'nuevo'),
                      )}</span>
                    </div>
                    <p class="item__meta">${escapeHtml(row.variant_name ?? '')}${
                      row.quantity ? ` ×${row.quantity}` : ''
                    } · ${money(row.total, row.currency)} · ${escapeHtml(fmtWhen(row.received_at))}</p>
                    <div class="item__actions">
                      <button class="btn btn--ghost btn--sm" data-receipt="${escapeHtml(
                        row.id,
                      )}" type="button">Ver comprobante</button>
                    </div>
                  </article>`,
                )
                .join('')}</div>`
            : '<p class="view__hint">Todavía no tiene pedidos registrados.</p>'
        }
      </div>

      <!--
        UBICACIONES del cliente: la última a la vista y el resto bajo «Ver historial».
        Es una sección discreta, no un sistema de direcciones (§13).
      -->
      <div class="field">
        <span class="field__label">Ubicaciones</span>
        <div id="customer-locations">${customerLocationsHtml(profile.locations ?? [])}</div>
      </div>

      <div class="field">
        <span class="field__label">Mensajes programados</span>
        ${
          scheduled.length
            ? `<dl class="facts">${scheduled
                .map(
                  (row) => `<div class="fact"><dt>${escapeHtml(
                    new Intl.DateTimeFormat('es-DO', { dateStyle: 'short', timeStyle: 'short' }).format(
                      new Date(row.scheduled_at),
                    ),
                  )}</dt><dd>${escapeHtml(
                    {
                      SCHEDULED: 'programado',
                      PROCESSING: 'enviando',
                      SENT: 'enviado',
                      DELIVERED: 'entregado',
                      READ: 'leído',
                      FAILED: 'falló',
                      CANCELLED: 'cancelado',
                      BLOCKED: 'bloqueado',
                    }[row.status] ?? row.status,
                  )}${
                    row.blocked_message ? ` · ${escapeHtml(row.blocked_message)}` : ''
                  }</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">No hay mensajes programados. Programar un mensaje NO es un seguimiento: aquí el sistema intenta enviar.</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Seguimiento</span>
        ${
          followups.length
            ? `<dl class="facts">${followups
                .map(
                  (row) =>
                    `<div class="fact"><dt>${escapeHtml(fmtDay(row.scheduled_at))} · ${escapeHtml(
                      followupLabel(row.type),
                    )}</dt><dd>${escapeHtml(
                      { pending: 'pendiente', completed: 'hecho', cancelled: 'cancelado', skipped: 'omitido' }[
                        row.status
                      ] ?? row.status,
                    )}</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">Sin tareas de seguimiento (se crean al entregar una compra).</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Automatización</span>
        <div class="item__actions" style="margin-top:0">
          ${
            customer.automation_state === 'PAUSED'
              ? `<button class="btn btn--ghost btn--sm" data-resume="${escapeHtml(customer.id)}" type="button">Reactivar</button>`
              : `<button class="btn btn--ghost btn--sm" data-pause="${escapeHtml(customer.id)}" type="button">Pausar</button>`
          }
          ${
            customer.do_not_contact
              ? `<button class="btn btn--ghost btn--sm" data-optin="${escapeHtml(customer.id)}" type="button">Volver a permitir mensajes</button>`
              : `<button class="btn btn--danger btn--sm" data-optout="${escapeHtml(customer.id)}" type="button">No contactar nunca más</button>`
          }
        </div>
        <p class="view__hint">Pausar detiene el seguimiento; «no contactar» además borra las tareas de marketing pendientes.</p>
      </div>

      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="customer-notes">${escapeHtml(customer.notes ?? '')}</textarea>
      </label>
      <button class="btn btn--primary btn--block" id="customer-save" type="button">Guardar notas</button>
      `,
    );

    $('#customer-save')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ notes: $('#customer-notes').value }),
          });
          toast('Notas guardadas');
          await load({ keepTab: true });
          await openCustomer(customer.id);
        } catch (error) {
          if (error.message !== 'unauthorized') toast('No se pudieron guardar las notas');
        }
      });
    });

    // El estado comercial a mano (INTERESADO / PERDIDO) o de vuelta al derivado.
    $('#customer-commercial')?.addEventListener('change', async (event) => {
      try {
        await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ commercialState: event.target.value || null }),
        });
        toast('Estado comercial actualizado');
        await load({ keepTab: true });
        await openCustomer(customer.id);
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar el estado');
      }
    });
  }

  /**
   * Registrar una compra/pedido desde el panel.
   *
   * Hay UN solo formulario de pedido en todo el CRM (el mismo que se abre desde el
   * chat): antes era de una sola línea y cada pantalla tenía el suyo.
   */
  function openPurchaseForm(customerId) {
    openOrderForm({ customerId: customerId || null });
  }

  /**
   * Crear una tarea de seguimiento a mano (fuera del plan automático).
   *
   * Es una TAREA para una persona: el sistema no envía nada solo. Se puede crear
   * desde la ficha del cliente o desde la conversación (queda ligada a las dos).
   */
  function openFollowupForm(input) {
    const options = typeof input === 'string' ? { customerId: input } : (input ?? {});
    const customerId = options.customerId;
    const customer = customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null);
    if (!customer) return;
    const MOTIVOS = [
      ['Responder consulta', 'Responder una consulta'],
      ['Confirmar pedido', 'Confirmar el pedido'],
      ['Confirmar entrega', 'Confirmar la entrega'],
      ['Seguimiento postventa', 'Seguimiento postventa'],
      ['Recompra', 'Recompra'],
      ['Otro', 'Otro motivo'],
    ];
    const QUICK = [
      ['Hoy', 0],
      ['Mañana', 1],
      ['En 3 días', 3],
      ['En 7 días', 7],
    ];
    openSheet(
      `Nuevo seguimiento · ${customerName(customer)}`,
      `
      <div class="field">
        <span class="field__label">Para cuándo</span>
        <div class="item__actions" style="margin-top:0">
          ${QUICK.map(
            ([text, days]) => `<button class="chip" data-fu-quick="${days}" type="button">${escapeHtml(text)}</button>`,
          ).join('')}
            <button class="chip" data-fu-quick="custom" type="button">Fecha personalizada</button>
        </div>
        <input class="field__input" id="fu-date" type="date" value="${addDaysISO(1)}" />
      </div>
      <label class="field">
        <span class="field__label">Motivo</span>
        <select class="field__select" id="fu-motivo">
          ${MOTIVOS.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Nota (opcional)</span>
        <textarea class="field__area" id="fu-reason" placeholder="Qué tengo que decirle o preguntarle…"></textarea>
      </label>
      <button class="btn btn--primary btn--block" id="fu-save" type="button">Crear seguimiento</button>
      <p class="view__hint">Es una TAREA para una persona: el sistema no envía nada solo. Aparecerá en HOY.</p>
      `,
    );
    const dateInput = $('#fu-date');
    $$('[data-fu-quick]').forEach((chip) =>
      chip.addEventListener('click', () => {
        if (chip.dataset.fuQuick === 'custom') {
          dateInput.focus();
          return;
        }
        dateInput.value = addDaysISO(Number(chip.dataset.fuQuick));
      }),
    );
    $('#fu-save').addEventListener('click', async (event) => {
      const motivo = $('#fu-motivo').value;
      const nota = $('#fu-reason').value.trim();
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api('/api/admin/followups', {
            method: 'POST',
            body: JSON.stringify({
              customerId: customer.id,
              conversationId: options.conversationId || undefined,
              orderId: options.orderId || undefined,
              scheduledAt: dateInput.value,
              reason: nota ? `${motivo} · ${nota}` : motivo,
            }),
          });
          toast('Seguimiento creado');
          await load({ keepTab: true });
          closeSheet();
        } catch (error) {
          if (error.message !== 'unauthorized') toast('No se pudo crear el seguimiento');
        }
      });
    });
  }

  /** Decidir una tarea: hecha, pospuesta o cancelada. */
  async function followupAction(id, action, payload = {}) {
    try {
      await api(`/api/admin/followups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, ...payload }),
      });
      toast(
        { complete: 'Seguimiento hecho', postpone: 'Pospuesto 3 días', cancel: 'Seguimiento cancelado' }[action] ??
          'Seguimiento actualizado',
      );
      await load({ keepTab: true });
      if (state.chat) await openChat(state.chat.id);
      if (state.customerId) await openCustomer(state.customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el seguimiento');
    }
  }

  /** Pausar, reactivar, no contactar o volver a permitir mensajes. */
  async function customerAction(customerId, action) {
    const routes = {
      pause: ['/automation', { state: 'PAUSED' }],
      resume: ['/automation', { state: 'AUTOMATIC' }],
      optout: ['/opt-out', {}],
      optin: ['/opt-in', {}],
    };
    const [route, payload] = routes[action] ?? [];
    if (!route) return;
    try {
      const result = await api(`/api/admin/customers/${encodeURIComponent(customerId)}${route}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast(
        action === 'optout'
          ? `Marcado como no contactar${result.cancelled ? ` · ${result.cancelled} tarea(s) cancelada(s)` : ''}`
          : action === 'optin'
            ? 'Puede volver a recibir mensajes'
            : action === 'pause'
              ? 'Seguimiento en pausa'
              : 'Seguimiento reactivado',
      );
      await load({ keepTab: true });
      await openCustomer(customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el cliente');
    }
  }

  // --------------------------------------- acciones comerciales (S4 / S5)
  /*
   * El centro de ventas vive DENTRO de la conversación: una sola tecla abre las
   * acciones (crear pedido, programar seguimiento, programar mensaje, ver
   * cliente) sin llenar el encabezado de botones en el móvil.
   */

  const COMMERCIAL_LABELS = {
    NUEVO: 'Nuevo',
    EN_CONVERSACION: 'En conversación',
    INTERESADO: 'Interesado',
    PEDIDO_CREADO: 'Pedido creado',
    CONFIRMADO: 'Confirmado',
    ENTREGADO: 'Entregado',
    SEGUIMIENTO: 'En seguimiento',
    RECOMPRA: 'Recompra',
    PERDIDO: 'Perdido',
  };
  const commercialLabel = (value) => COMMERCIAL_LABELS[value] ?? value ?? '—';
  const orderStatusLabel = (value) => state.orderStatuses.find((entry) => entry.value === value)?.label ?? value;
  const customerName = (customer) => (customer?.name ?? '').trim() || customer?.phone_e164 || 'Cliente';

  const catalogOf = (variantId) => state.catalog.find((entry) => entry.id === variantId) ?? null;

  /** Total del pedido calculado con el catálogo del SERVIDOR (no hay precios aquí). */
  function orderTotals(lines, discount = 0, deliveryFee = 0) {
    const items = lines
      .map((line) => {
        const variant = catalogOf(line.variantId);
        if (!variant) return null;
        const quantity = Math.max(1, Number(line.quantity) || 1);
        return { variant, quantity, subtotal: variant.price * quantity };
      })
      .filter(Boolean);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const applied = Math.min(Math.max(0, Number(discount) || 0), subtotal);
    // El delivery es un importe APARTE (nunca una línea de producto falsa).
    const fee = Math.max(0, Math.trunc(Number(deliveryFee) || 0));
    return { items, subtotal, discount: applied, deliveryFee: fee, total: subtotal - applied + fee };
  }

  function openChatActions(customerId, conversationId) {
    const customer = customerById(customerId);
    if (!customer) return;
    /*
     * Acciones del cliente: icono + título corto, sin párrafos. La única que
     * lleva una nota es la que ENVÍA sola (una plantilla la manda el sistema): no
     * se puede confundir con una tarea para una persona.
     */
    openSheet(
      customerName(customer),
      `
      <div class="menu-list">
        <button class="menu-item" data-quick-replies="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.note}</span>
          <span><strong>Respuesta rápida</strong></span>
        </button>
        <button class="menu-item" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.bag}</span>
          <span><strong>Crear pedido</strong></span>
        </button>
        <button class="menu-item" data-followup-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.clock}</span>
          <span><strong>Programar seguimiento</strong></span>
        </button>
        <button class="menu-item" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.send}</span>
          <span><strong>Programar mensaje</strong><small>Lo envía el sistema</small></span>
        </button>
        <button class="menu-item" data-customer="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Ver cliente</strong></span>
        </button>
      </div>
    `,
      { variant: 'menu' },
    );
  }

  // ---------------------------------------------------- respuestas r?pidas
  /*
   * Las respuestas rápidas son los MISMOS textos guardados del panel (una sola
   * lista, un solo sitio donde viven): aquí se abren desde la conversación, para
   * no obligar a salir del chat ni a pasar por la pantalla de administración.
   *
   * LA REGLA QUE NO SE ROMPE: elegir una respuesta NUNCA envía nada. Solo deja el
   * texto escrito en el compositor, con el cursor puesto, para que una persona lo
   * revise, lo cambie (nombre, cantidad, precio…) y pulse Enviar. El envío sigue
   * pasando por las mismas reglas de siempre: ventana de 24 h, opt-out y
   * plantillas aprobadas. Una respuesta rápida NO es una plantilla de Meta.
   */
  const QR_PREVIEW = 92;
  let qrQuery = '';
  let qrMenuId = null;

  /** Orden estable y predecible: el que el negocio fijó con `position`. */
  const quickRepliesAll = () =>
    (state.messages ?? [])
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

  const quickReplyById = (id) => (state.messages ?? []).find((row) => row.id === id) ?? null;

  /** Una línea como mucho: el texto largo no cabe en una fila compacta. */
  const qrPreview = (body) => {
    const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > QR_PREVIEW ? `${flat.slice(0, QR_PREVIEW)}…` : flat;
  };

  /** Filtra por NOMBRE y por TEXTO: escribir "precio" encuentra lo que habla de precio. */
  function qrFiltered() {
    const needle = qrQuery.trim().toLowerCase();
    const rows = quickRepliesAll();
    if (!needle) return rows;
    return rows.filter((row) => `${row.name ?? ''} ${row.body ?? ''}`.toLowerCase().includes(needle));
  }

  function qrRowHtml(row) {
    const open = qrMenuId === row.id;
    const nombre = escapeHtml(row.name ?? '');
    return `<div class="qr__row${open ? ' qr__row--open' : ''}">
      <button class="qr__pick" data-qr-insert="${escapeHtml(row.id)}" type="button">
        <span class="qr__name">${nombre}</span>
        <span class="qr__text">${escapeHtml(qrPreview(row.body))}</span>
      </button>
      <button class="qr__more" data-qr-menu="${escapeHtml(row.id)}" type="button"
        aria-label="Opciones de ${nombre}" aria-expanded="${open ? 'true' : 'false'}">
        <span aria-hidden="true">⋯</span>
      </button>
      ${
        open
          ? `<div class="qr__menu">
        <button class="qr__menu-item" data-qr-edit="${escapeHtml(row.id)}" type="button">Editar</button>
        <button class="qr__menu-item qr__menu-item--danger" data-qr-del="${escapeHtml(
          row.id,
        )}" type="button">Eliminar</button>
      </div>`
          : ''
      }
    </div>`;
  }

  function renderQuickReplies() {
    const list = $('#qr-list');
    if (!list) return;
    const rows = qrFiltered();
    if (rows.length) {
      list.innerHTML = rows.map(qrRowHtml).join('');
      return;
    }
    // Vacío de verdad (no hay ninguna) o vacío por la búsqueda: se distinguen.
    list.innerHTML = (state.messages ?? []).length
      ? emptyState('Ninguna respuesta coincide con la búsqueda.')
      : `<div class="qr__empty">
          <p class="view__hint">Aún no tienes respuestas rápidas.</p>
          <button class="btn btn--primary btn--sm" data-qr-new type="button">+ Crear la primera</button>
        </div>`;
  }

  /** El selector: buscador, lista compacta y el «+» para crear. Nunca sale del chat. */
  function openQuickReplies({ keep = false } = {}) {
    if (!keep) {
      qrQuery = '';
      qrMenuId = null;
    }
    openSheet(
      'Respuestas rápidas',
      `<div class="qr">
        <div class="qr__top">
          <input class="field__input qr__search" id="qr-search" type="search" autocomplete="off"
            placeholder="Buscar respuestas" aria-label="Buscar respuestas" value="${escapeHtml(qrQuery)}" />
          <button class="icon-btn qr__new" data-qr-new type="button" aria-label="Crear respuesta rápida"
            title="Crear respuesta rápida">${ICONS.plus}</button>
        </div>
        <div class="qr__list" id="qr-list"></div>
      </div>`,
      { variant: 'menu' },
    );
    renderQuickReplies();
    /*
     * La lista se pinta AL INSTANTE con lo que hay en memoria y se refresca
     * detrás: si otra persona creó o borró una respuesta desde otro equipo, aquí
     * aparece sin recargar la página. Si el refresco falla, se queda la copia que
     * ya había (abrir el selector nunca puede quedarse en blanco por la red).
     */
    api('/api/admin/messages')
      .then((data) => {
        if (!Array.isArray(data?.messages)) return;
        state.messages = data.messages;
        renderQuickReplies();
      })
      .catch(() => {
        /* sin conexión: la lista que ya estaba se mantiene */
      });
    const search = $('#qr-search');
    search?.addEventListener('input', (event) => {
      qrQuery = event.target.value ?? '';
      qrMenuId = null;
      renderQuickReplies();
    });
    /*
     * En escritorio el foco entra en el buscador (se escribe y se filtra). En
     * móvil NO se abre el teclado al mirar la lista: el teclado aparece al
     * elegir la respuesta, que es cuando de verdad hace falta.
     */
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches) search?.focus();
  }

  /** Alta o edición, dentro de la MISMA hoja: el chat nunca se pierde de vista. */
  function openQuickReplyForm(id = null) {
    const row = id ? quickReplyById(id) : null;
    if (id && !row) {
      toast('Esa respuesta ya no existe');
      openQuickReplies();
      return;
    }
    openSheet(
      row ? 'Editar respuesta' : 'Nueva respuesta',
      `<label class="field">
        <span class="field__label">Nombre</span>
        <input class="field__input" id="qr-name" maxlength="60" value="${escapeHtml(
          row?.name ?? '',
        )}" placeholder="Modo de uso" />
      </label>
      <label class="field">
        <span class="field__label">Mensaje</span>
        <textarea class="field__area" id="qr-body" maxlength="1200" placeholder="Hola {nombre}, …">${escapeHtml(
          row?.body ?? '',
        )}</textarea>
      </label>
      <p class="view__hint">Variables: {nombre} y {telefono} se rellenan con los datos del cliente de ESTA conversación.</p>
      <div class="qr__form-actions">
        <button class="btn btn--ghost" data-qr-back type="button">Cancelar</button>
        <button class="btn btn--primary" id="qr-save" type="button">${row ? 'Guardar cambios' : 'Crear respuesta'}</button>
      </div>`,
      { variant: 'menu' },
    );
    $('#qr-name')?.focus();
    $('#qr-save')?.addEventListener('click', async (event) => {
      const name = $('#qr-name').value.trim();
      const texto = $('#qr-body').value.trim();
      if (!name || !texto) {
        toast('Hacen falta nombre y mensaje');
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          const result = await api('/api/admin/messages', {
            method: 'POST',
            body: JSON.stringify({ id: row?.id, name, body: texto, position: row?.position }),
          });
          state.messages = result.messages ?? state.messages;
          renderMensajes();
          toast(row ? 'Respuesta actualizada' : 'Respuesta creada');
          openQuickReplies({ keep: true });
        } catch {
          toast('No se pudo guardar la respuesta');
        }
      });
    });
  }

  /** Borrar: confirmación corta y nada más. No toca mensajes, clientes ni pedidos. */
  function quickReplyDelete(id) {
    const row = quickReplyById(id);
    if (!row) {
      openQuickReplies();
      return;
    }
    openSheet(
      'Eliminar respuesta',
      `<p class="view__hint">¿Eliminar «${escapeHtml(
        row.name ?? '',
      )}»? Los mensajes que ya enviaste no se tocan.</p>
      <div class="qr__form-actions">
        <button class="btn btn--ghost" data-qr-back type="button">Cancelar</button>
        <button class="btn btn--danger" id="qr-delete" type="button">Eliminar</button>
      </div>`,
      { variant: 'menu' },
    );
    $('#qr-delete')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Eliminando…', async () => {
        try {
          const result = await api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.messages = result.messages ?? state.messages;
          renderMensajes();
          toast('Respuesta eliminada');
          openQuickReplies();
        } catch {
          toast('No se pudo eliminar la respuesta');
        }
      });
    });
  }

  /**
   * Insertar la respuesta en el compositor. NO ENVÍA NADA: escribe el texto y
   * deja el cursor puesto. Si ya había algo escrito no se pisa nada: se inserta
   * donde estaba el cursor. El envío lo decide una persona con el botón Enviar.
   */
  function insertQuickReply(id) {
    const row = quickReplyById(id);
    if (!row) {
      toast('Esa respuesta ya no existe');
      closeSheet();
      return;
    }
    const area = $('#wa-text');
    if (!area) {
      // Fuera de la ventana de 24 h no hay campo de texto libre (solo plantillas
      // aprobadas): una respuesta rápida NO puede saltarse esa regla.
      toast('Ahora mismo solo se pueden enviar plantillas aprobadas');
      closeSheet();
      return;
    }
    const customer = state.wa?.chat?.customer ?? null;
    // Solo datos REALES de esta conversación: si no hay teléfono, `{telefono}` se
    // queda escrita tal cual en vez de rellenarse con algo inventado.
    const texto = fillTemplate(row.body, { name: customer?.name ?? null, phone: customer?.phone_e164 ?? null });
    const corte = typeof area.selectionStart === 'number' ? area.selectionStart : area.value.length;
    const fin = typeof area.selectionEnd === 'number' ? area.selectionEnd : area.value.length;
    const antes = area.value.slice(0, corte);
    const despues = area.value.slice(fin);
    const separador = antes && !antes.endsWith('\n') ? '\n' : '';
    const escrito = `${antes}${separador}${texto}`;
    area.value = `${escrito}${despues}`;
    state.wa.draft = area.value;
    // Se avisa al compositor como si lo hubiera escrito una persona: así decide
    // él si toca micrófono o Enviar y ajusta la altura.
    if (typeof window.Event === 'function') area.dispatchEvent(new window.Event('input'));
    closeSheet();
    area.focus();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(escrito.length, escrito.length);
    toast('Respuesta lista para revisar y enviar');
  }

  /**
   * Formulario de pedido (nuevo o edición). El catálogo y los precios vienen del
   * servidor: el panel solo elige el frasco y la cantidad.
   */
  async function openOrderForm({ customerId, conversationId = '', orderId = null, order = null, location = null } = {}) {
    const customer = customerId
      ? customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null)
      : null;
    const catalog = state.catalog ?? [];
    if (!catalog.length) {
      toast('El catálogo todavía no está disponible');
      return;
    }
    // Ubicaciones del cliente: se piden antes de pintar para poder ofrecerlas (§9).
    const customerLocations = customerId ? await fetchCustomerLocations(customerId) : [];
    /** @type {Array<{variantId: string, quantity: number}>} */
    let lines = order?.items?.map((line) => ({ variantId: line.variantId, quantity: line.quantity })) ?? [
      { variantId: catalog[0].id, quantity: 1 },
    ];
    const defaultStatus = order?.status ?? 'nuevo';

    openSheet(
      `${
        orderId
          ? `Modificar pedido · ${customer ? customerName(customer) : 'cliente'}`
          : customer
            ? `Pedido para ${customerName(customer)}`
            : 'Pedido para un cliente nuevo'
      }`,
      `
      ${
        customer
          ? ''
          : `<p class="view__hint">El teléfono identifica al cliente: si ya existe, el pedido se suma a su historial.</p>
             <label class="field">
               <span class="field__label">Teléfono del cliente</span>
               <input class="field__input" id="order-phone" type="tel" inputmode="tel" placeholder="809 555 1234" />
             </label>
             <label class="field">
               <span class="field__label">Nombre</span>
               <input class="field__input" id="order-name" placeholder="Nombre del cliente" />
             </label>`
      }
      <div id="order-lines"></div>
      <button class="btn btn--ghost btn--sm" id="order-add" type="button">+ Añadir otro frasco</button>
      <label class="field">
        <span class="field__label">Descuento (opcional, RD$)</span>
        <input class="field__input" id="order-discount" type="number" min="0" step="1" value="${
          order?.discount ?? 0
        }" />
      </label>
      <div class="field">
        <span class="field__label">Ubicación de entrega (opcional)</span>
        <div id="order-loc"></div>
      </div>
      <label class="field">
        <span class="field__label">Costo de delivery (opcional, RD$)</span>
        <input class="field__input" id="order-fee" type="number" min="0" step="1" value="${
          order?.delivery_fee ?? order?.delivery?.fee ?? ''
        }" placeholder="0" />
      </label>
      <label class="field">
        <span class="field__label">Estado</span>
        <select class="field__select" id="order-status">
          ${(state.orderStatuses ?? [])
            .map(
              (status) =>
                `<option value="${escapeHtml(status.value)}" ${
                  status.value === defaultStatus ? 'selected' : ''
                }>${escapeHtml(status.label)}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="order-notes" placeholder="Pagó en efectivo, entrega el viernes…">${escapeHtml(
          order?.notes ?? '',
        )}</textarea>
      </label>
      <p class="view__hint" id="order-total"></p>
      <button class="btn btn--primary btn--block" id="order-save" type="button">${
        orderId ? 'Guardar cambios' : 'Guardar pedido'
      }</button>
      <p class="view__hint">
        Al marcarlo como «entregado» se envía la venta a Meta una sola vez y se crean las tareas de
        seguimiento del día 1, 3, 7, 14, 21 y 30 (según tus Ajustes).
      </p>
      `,
    );

    const linesBox = $('#order-lines');
    const renderLines = () => {
      linesBox.innerHTML = lines
        .map(
          (line, index) => `
        <div class="order-line">
          <label class="field">
            <span class="field__label">Frasco</span>
            <select class="field__select" data-line-variant="${index}">
              ${catalog
                .map(
                  (variant) =>
                    `<option value="${escapeHtml(variant.id)}" ${
                      variant.id === line.variantId ? 'selected' : ''
                    }>${escapeHtml(variant.label)} · ${money(variant.price, variant.currency)}</option>`,
                )
                .join('')}
            </select>
          </label>
          <label class="field order-line__qty">
            <span class="field__label">Cantidad</span>
            <input class="field__input" type="number" min="1" step="1" value="${line.quantity}" data-line-qty="${index}" />
          </label>
          ${
            lines.length > 1
              ? `<button class="icon-btn" data-line-remove="${index}" type="button" aria-label="Quitar frasco">✕</button>`
              : ''
          }
        </div>`,
        )
        .join('');
      refreshOrderTotal();
    };
    const refreshOrderTotal = () => {
      const totals = orderTotals(
        lines,
        Number($('#order-discount')?.value) || 0,
        Number($('#order-fee')?.value) || 0,
      );
      const box = $('#order-total');
      if (!box) return;
      const stock = state.inventory;
      const strictStock = stock?.initialized === true;
      const insufficient = strictStock && Number(stock.stock) < Number(totals.totalCapsules);
      box.innerHTML = totals.items.length
        ? `Productos ${money(totals.subtotal)}${totals.discount ? ` · Descuento −${money(totals.discount)}` : ''}${
            totals.deliveryFee ? ` · Delivery ${money(totals.deliveryFee)}` : ''
          } · <strong>Total ${money(totals.total)}</strong>${
            strictStock
              ? ` · Stock ${escapeHtml(stock.stock)} cápsulas${insufficient ? ' · insuficiente para entregar' : ''}`
              : ' · Stock sin inicializar'
          }`
        : 'Elige al menos un frasco del catálogo.';
    };

    /*
     * UBICACIÓN DE ENTREGA (opcional). Se elige DENTRO del propio formulario, sin
     * abrir otra hoja: así no se pierde lo que ya estaba escrito (§9, §10, §24).
     * Nunca se pide el permiso de ubicación al abrir: solo al pulsar el botón.
     */
    let chosenLocation = location && locationCoordsOk(location)
      ? { ...location }
      : order?.delivery?.location
        ? { ...order.delivery.location, id: order.delivery.location.source_location_id ?? null }
        : null;
    chosenLocation = chosenLocation && locationCoordsOk(chosenLocation) ? chosenLocation : null;
    const renderLocationBlock = () => {
      const box = $('#order-loc');
      if (!box) return;
      if (chosenLocation) {
        box.innerHTML = `${locationChip(chosenLocation, { withActions: false })}
          <button class="btn btn--ghost btn--sm" id="order-loc-clear" type="button">Quitar ubicación</button>`;
        $('#order-loc-clear').addEventListener('click', () => {
          chosenLocation = null;
          renderLocationBlock();
        });
        return;
      }
      const visible = customerLocations.slice(0, 3);
      const rest = customerLocations.slice(3);
      const option = (location) => `
        <label class="loc-option">
          <input type="radio" name="order-loc-pick" value="${escapeHtml(location.id)}" />
          <span class="loc-option__body"><strong>${escapeHtml(locationTitle(location))}</strong>
          <small>${escapeHtml(locationContext(location).address ?? 'Solo coordenadas')}${
            location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
          }</small></span>
          ${location.map_url ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>` : ''}
        </label>`;
      box.innerHTML = `
        <p class="view__hint">Puede ir sin ubicación: el pedido se guarda igual.</p>
        <label class="loc-option">
          <input type="radio" name="order-loc-pick" value="" checked />
          <span class="loc-option__body"><strong>Sin ubicación</strong><small>No hace falta dirección ni ciudad.</small></span>
        </label>
        ${visible.map(option).join('')}
        ${rest.length ? `<details class="loc-history"><summary>Ver historial (${rest.length})</summary>${rest.map(option).join('')}</details>` : ''}
        <button class="btn btn--ghost btn--sm" id="order-loc-current" type="button">Usar la ubicación de este dispositivo</button>`;
      $('#order-loc-current').addEventListener('click', async (event) => {
        await working(event.currentTarget, 'Buscando…', async () => {
          const found = await getBrowserLocation();
          if (!found.ok) {
            toast(found.message);
            return;
          }
          chosenLocation = found.location;
          renderLocationBlock();
        });
      });
      box.addEventListener('change', (event) => {
        const value = event.target.closest('[name="order-loc-pick"]')?.value ?? '';
        if (value) {
          chosenLocation = customerLocations.find((row) => row.id === value) ?? null;
          renderLocationBlock();
        }
      });
    };
    renderLocationBlock();

    linesBox.addEventListener('change', (event) => {
      const select = event.target.closest('[data-line-variant]');
      if (select) {
        lines[Number(select.dataset.lineVariant)].variantId = select.value;
        refreshOrderTotal();
      }
      const quantity = event.target.closest('[data-line-qty]');
      if (quantity) {
        lines[Number(quantity.dataset.lineQty)].quantity = Math.max(1, Number(quantity.value) || 1);
        refreshOrderTotal();
      }
    });
    linesBox.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-line-remove]');
      if (!remove) return;
      lines = lines.filter((_, index) => index !== Number(remove.dataset.lineRemove));
      renderLines();
    });
    $('#order-add').addEventListener('click', () => {
      lines = [...lines, { variantId: catalog[0].id, quantity: 1 }];
      renderLines();
    });
    $('#order-discount').addEventListener('input', refreshOrderTotal);
    $('#order-fee').addEventListener('input', refreshOrderTotal);
    renderLines();

    $('#order-save').addEventListener('click', async (event) => {
      const totals = orderTotals(
        lines,
        Number($('#order-discount').value) || 0,
        Number($('#order-fee').value) || 0,
      );
      if (!totals.items.length) {
        toast('Elige al menos un frasco');
        return;
      }
      if (
        $('#order-status')?.value === 'entregado' &&
        state.inventory?.initialized === true &&
        Number(state.inventory.stock) < Number(totals.totalCapsules)
      ) {
        toast(`Stock insuficiente: hay ${state.inventory.stock} cápsulas y el pedido requiere ${totals.totalCapsules}`);
        return;
      }
      const typedPhone = customer ? null : $('#order-phone').value.trim();
      if (!customer && !typedPhone) {
        toast('Escribe el teléfono del cliente');
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          const payload = {
            customerId: customer?.id,
            phone: customer?.phone_e164 ?? typedPhone,
            name: customer?.name ?? $('#order-name')?.value.trim(),
            conversationId: conversationId || undefined,
            channel: conversationId ? 'whatsapp' : 'panel',
            items: lines,
            discount: Number($('#order-discount').value) || 0,
            // Delivery OPCIONAL e independiente de la ubicación (§26).
            deliveryFee: Number($('#order-fee').value) || 0,
            /*
             * Ubicación: la elegida (por id si ya existía, o con sus coordenadas
             * si es la del dispositivo). `null` = «sin ubicación», y es válido.
             */
            deliveryLocation: chosenLocation
              ? chosenLocation.id
                ? chosenLocation.id
                : {
                    latitude: chosenLocation.latitude,
                    longitude: chosenLocation.longitude,
                    name: chosenLocation.name ?? null,
                    address: chosenLocation.address ?? null,
                    source: chosenLocation.source ?? 'browser_geolocation',
                  }
              : null,
            status: $('#order-status').value,
            notes: $('#order-notes').value,
          };
          const result = orderId
            ? await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  items: lines,
                  discount: payload.discount,
                  deliveryFee: payload.deliveryFee,
                  deliveryLocation: payload.deliveryLocation,
                  notes: payload.notes,
                }),
              })
            : await api('/api/admin/orders', { method: 'POST', body: JSON.stringify(payload) });
          const savedId = orderId ?? result.item?.id;
          toast(orderId ? 'Pedido actualizado' : `Pedido ${result.order?.order_number ?? ''} guardado`);
          await load({ keepTab: true });
          if (savedId) await openReceipt(savedId);
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo guardar el pedido');
        }
      });
    });
  }

  /*
   * ==========================================================================
   *  UBICACIONES GPS
   * ==========================================================================
   *
   * Reglas (las mismas que aplica el servidor):
   *   · la fuente de verdad son las coordenadas; el enlace de mapa se CALCULA;
   *   · una ubicación no es un archivo: no se sube a ningún sitio, se pinta;
   *   · nada sale por WhatsApp sin confirmación explícita (§19);
   *   · compartir con otro chat es una acción aparte, avisada y auditada (§21);
   *   · el permiso de ubicación del navegador SOLO se pide al pulsar el botón.
   */

  /** ¿Son coordenadas utilizables? (mismo criterio que el servidor). */
  const locationCoordsOk = (location) => {
    const lat = Number(location?.latitude);
    const lng = Number(location?.longitude);
    return (
      Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    );
  };

  /** Enlace de mapa a partir de las coordenadas (nunca se guarda una URL). */
  const locationMapUrl = (location) => {
    if (!locationCoordsOk(location)) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${Number(location.latitude)},${Number(location.longitude)}`,
    )}`;
  };

  /** Título honesto: el nombre si lo hay, si no «Ubicación compartida». */
  const locationTitle = (location) => String(location?.name ?? '').trim() || 'Ubicación compartida';

  /** Línea de contexto: dirección y de dónde salió (nunca coordenadas crudas). */
  const locationContext = (location) => {
    const who = {
      whatsapp_inbound: 'Compartida por el cliente',
      whatsapp_outbound: 'Enviada al cliente',
      browser_geolocation: 'Ubicación de este dispositivo',
      manual_coordinates: 'Coordenadas escritas a mano',
      reused_location: 'Reutilizada de otra conversación',
    }[location?.source];
    return { address: String(location?.address ?? '').trim() || null, who: who ?? 'Ubicación', age: location?.age_label ?? null };
  };

  /**
   * Componente de ubicación: UNA pieza compacta (nada de tarjeta dentro de otra).
   * Va dentro de la burbuja, así que respeta la alineación de siempre: entrante a
   * la izquierda, saliente a la derecha (§35).
   */
  function locationChip(location, options = {}) {
    const url = locationMapUrl(location);
    const { address, who, age } = locationContext(location);
    const detalle = [address, age ? age.replace('Compartida', 'Compartida') : null].filter(Boolean).join(' · ');
    return `<span class="loc" data-location="${escapeHtml(location?.id ?? '')}">
        <span class="loc__head"><span class="loc__pin" aria-hidden="true">📍</span>
          <span class="loc__title">${escapeHtml(locationTitle(location))}</span></span>
        ${address ? `<span class="loc__address">${escapeHtml(address)}</span>` : ''}
        <span class="loc__meta">${escapeHtml(who)}${detalle && !address ? ` · ${escapeHtml(detalle)}` : ''}</span>
        <span class="loc__actions">
          ${
            url
              ? `<a class="loc__link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ver en mapa</a>`
              : '<span class="loc__link loc__link--off">Sin coordenadas legibles</span>'
          }
          ${
            options.withActions !== false
              ? `<button class="loc__more" type="button" data-loc-menu="${escapeHtml(location?.id ?? '')}" aria-label="Más acciones de la ubicación">⋯</button>`
              : ''
          }
        </span>
      </span>`;
  }

  /** Ubicaciones del cliente (historial). Se piden al abrir, nunca se cachean de más. */
  async function fetchCustomerLocations(customerId) {
    if (!customerId) return [];
    try {
      const data = await api(`/api/admin/customers/${encodeURIComponent(customerId)}/locations`);
      return Array.isArray(data.locations) ? data.locations : [];
    } catch {
      return [];
    }
  }

  /** Todas las ubicaciones del CRM (para poder compartir una entre chats). */
  async function fetchAllLocations() {
    const customers = state.customers ?? [];
    const lists = await Promise.all(customers.slice(0, 50).map((customer) => fetchCustomerLocations(customer.id)));
    return lists.flat();
  }

  /** Ubicación actual del dispositivo. SOLO se llama desde un clic (§15). */
  function getBrowserLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation?.getCurrentPosition) {
        resolve({ ok: false, error: 'unsupported', message: 'Este navegador no sabe dar la ubicación. Puedes adjuntarla o escribir las coordenadas.' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            ok: true,
            location: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              name: null,
              address: null,
              source: 'browser_geolocation',
            },
          }),
        (error) =>
          resolve({
            ok: false,
            error: error?.code === 1 ? 'denied' : 'unavailable',
            message:
              error?.code === 1
                ? 'No diste permiso para usar la ubicación. El pedido sigue funcionando sin ella.'
                : 'No pudimos obtener la ubicación del dispositivo. Puedes escribir las coordenadas o seguir sin ella.',
          }),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }

  /**
   * Selector de ubicación: lista las del cliente (con su edad) y ofrece la del
   * dispositivo o escribir coordenadas. Nunca envía nada: solo elige.
   */
  async function openLocationPicker({ customerId, conversationId = '', title = 'Ubicación de entrega' }) {
    const locations = await fetchCustomerLocations(customerId);
    const opciones = locations.length
      ? locations
          .map(
            (location) => `
        <label class="loc-option">
          <input type="radio" name="loc-pick" value="${escapeHtml(location.id)}" />
          <span class="loc-option__body">
            <strong>${escapeHtml(locationTitle(location))}</strong>
            <small>${escapeHtml(locationContext(location).address ?? 'Solo coordenadas')}${
              location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
            }</small>
          </span>
          ${
            location.map_url
              ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>`
              : ''
          }
        </label>`,
          )
          .join('')
      : `<p class="view__hint">Este cliente todavía no ha compartido ninguna ubicación.</p>`;
    return new Promise((resolve) => {
      openSheet(
        title,
        `
        <p class="view__hint">Elegir una ubicación no envía nada: primero se ve y después se confirma.</p>
        <label class="loc-option">
          <input type="radio" name="loc-pick" value="" checked />
          <span class="loc-option__body"><strong>Sin ubicación</strong><small>El pedido se guarda igual.</small></span>
        </label>
        ${opciones}
        ${
          locations.length > 1
            ? `<details class="loc-history"><summary>Ver historial completo (${locations.length})</summary>
                 <p class="view__hint">Las de arriba son todas, de la más reciente a la más antigua.</p></details>`
            : ''
        }
        <button class="btn btn--ghost btn--block" id="loc-current" type="button">Usar la ubicación de este dispositivo</button>
        <label class="field">
          <span class="field__label">…o escribir coordenadas (opcional)</span>
          <span class="loc-coords">
            <input class="field__input" id="loc-lat" inputmode="decimal" placeholder="Latitud" />
            <input class="field__input" id="loc-lng" inputmode="decimal" placeholder="Longitud" />
          </span>
        </label>
        <button class="btn btn--primary btn--block" id="loc-ok" type="button">Usar esta ubicación</button>
        <button class="btn btn--ghost btn--block" id="loc-cancel" type="button">Cancelar</button>
        `,
      );
      const close = (value) => {
        closeSheet();
        resolve(value);
      };
      $('#loc-cancel').addEventListener('click', () => close({ ok: false, cancelled: true }));
      $('#loc-current').addEventListener('click', async (event) => {
        await working(event.currentTarget, 'Buscando…', async () => {
          const found = await getBrowserLocation();
          if (!found.ok) {
            toast(found.message);
            return;
          }
          close({ ok: true, location: found.location });
        });
      });
      $('#loc-ok').addEventListener('click', () => {
        const chosen = document.querySelector('input[name="loc-pick"]:checked')?.value ?? '';
        if (chosen) {
          const found = locations.find((row) => row.id === chosen) ?? null;
          if (found) {
            close({ ok: true, location: found });
            return;
          }
        }
        const lat = Number($('#loc-lat').value);
        const lng = Number($('#loc-lng').value);
        const typed = $('#loc-lat').value.trim() !== '' || $('#loc-lng').value.trim() !== '';
        if (typed) {
          if (!locationCoordsOk({ latitude: lat, longitude: lng })) {
            toast('Esas coordenadas no son válidas (latitud −90…90, longitud −180…180).');
            return;
          }
          close({ ok: true, location: { latitude: lat, longitude: lng, name: null, address: null, source: 'manual_coordinates' } });
          return;
        }
        close({ ok: true, location: null });
      });
      void conversationId;
    });
  }

  /**
   * ENVIAR UNA UBICACIÓN por WhatsApp: elegir → previsualizar → CONFIRMAR (§18/§19).
   * El servidor exige `confirmed: true`, así que aquí no hay atajo posible.
   */
  async function openSendLocation({ conversationId, customerId }) {
    const elegida = await openLocationPicker({ customerId, conversationId, title: 'Enviar ubicación' });
    if (!elegida?.ok || !elegida.location) {
      if (elegida?.ok) toast('No se eligió ninguna ubicación');
      return;
    }
    const location = elegida.location;
    const url = locationMapUrl(location);
    openSheet(
      'Confirmar envío',
      `
      <p class="rule">Vas a enviar esta ubicación al cliente por WhatsApp. No se envía nada hasta que pulses «Enviar ubicación».</p>
      ${locationChip(location, { withActions: false })}
      ${url ? `<a class="btn btn--ghost btn--block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir en el mapa</a>` : ''}
      <button class="btn btn--primary btn--block" id="loc-send" type="button">Enviar ubicación</button>
      <button class="btn btn--ghost btn--block" id="loc-send-cancel" type="button">Cancelar</button>
      `,
    );
    $('#loc-send-cancel').addEventListener('click', () => closeSheet());
    $('#loc-send').addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/location`, {
            method: 'POST',
            body: JSON.stringify({
              locationId: location.id ?? undefined,
              latitude: location.latitude,
              longitude: location.longitude,
              name: location.name ?? undefined,
              address: location.address ?? undefined,
              source: location.source ?? 'browser_geolocation',
              confirmed: true,
              idempotencyKey: uploadKey('loc'),
            }),
          });
          toast('Ubicación enviada');
          closeSheet();
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo enviar la ubicación');
        }
      });
    });
  }

  /**
   * COMPARTIR una ubicación con OTRA conversación (§20/§21).
   *
   * Deliberado y avisado: se dice con QUIÉN se comparte y se exige confirmación.
   * No se copia nada más del cliente original: solo la ubicación.
   */
  async function openShareLocation({ locationId, location }) {
    const destinations = (state.conversations ?? []).filter((row) => row.id && row.customer);
    if (!destinations.length) {
      toast('No hay conversaciones con las que compartir');
      return;
    }
    openSheet(
      'Compartir ubicación',
      `
      <p class="rule rule--warn">Esta ubicación puede ser el domicilio de otra persona: solo se comparte la ubicación, nada más del cliente original.</p>
      ${locationChip(location, { withActions: false })}
      <label class="field">
        <span class="field__label">Compartir con</span>
        <select class="field__select" id="loc-share-to">
          ${destinations
            .map(
              (row) =>
                `<option value="${escapeHtml(row.id)}">${escapeHtml(waDisplayName(row))}</option>`,
            )
            .join('')}
        </select>
      </label>
      <p class="view__hint" id="loc-share-warning"></p>
      <button class="btn btn--primary btn--block" id="loc-share-ok" type="button">Compartir ubicación</button>
      <button class="btn btn--ghost btn--block" id="loc-share-cancel" type="button">Cancelar</button>
      `,
    );
    const refreshWarning = () => {
      const row = destinations.find((candidate) => candidate.id === $('#loc-share-to').value) ?? null;
      $('#loc-share-warning').textContent = row
        ? `Vas a compartir esta ubicación con ${waDisplayName(row)}.`
        : 'Elige un destinatario.';
    };
    $('#loc-share-to').addEventListener('change', refreshWarning);
    refreshWarning();
    $('#loc-share-cancel').addEventListener('click', () => closeSheet());
    $('#loc-share-ok').addEventListener('click', async (event) => {
      const destination = $('#loc-share-to').value;
      const row = destinations.find((candidate) => candidate.id === destination) ?? null;
      // Confirmación EXPLÍCITA con el nombre del destino (§21).
      if (!row || !window.confirm(`¿Compartir esta ubicación con ${waDisplayName(row)}?`)) return;
      await working(event.currentTarget, 'Compartiendo…', async () => {
        try {
          await api(`/api/admin/locations/${encodeURIComponent(locationId)}/share`, {
            method: 'POST',
            body: JSON.stringify({ conversationId: destination, confirmed: true }),
          });
          toast('Ubicación compartida');
          closeSheet();
          if (state.wa.selectedId) await loadWaThread(state.wa.selectedId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo compartir la ubicación');
        }
      });
    });
  }

  /** Acciones de una ubicación: lo esencial a la vista y el resto en «⋯» (§12). */
  function openLocationActions({ location, conversationId }) {
    const url = locationMapUrl(location);
    openSheet(
      'Ubicación',
      `
      ${locationChip(location, { withActions: false })}
      ${
        url
          ? `<a class="btn btn--primary btn--block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ver en mapa</a>`
          : '<p class="rule rule--warn">Esta ubicación no trae coordenadas legibles.</p>'
      }
      <button class="btn btn--ghost btn--block" id="loc-use" type="button">Usar para un pedido</button>
      <button class="btn btn--ghost btn--block" id="loc-share" type="button">Compartir con otra conversación</button>
      <button class="btn btn--ghost btn--block" id="loc-close" type="button">Cerrar</button>
      `,
    );
    $('#loc-close').addEventListener('click', () => closeSheet());
    $('#loc-use').addEventListener('click', () => {
      const customerId = state.wa.chat?.customer?.id ?? null;
      closeSheet();
      if (!customerId) {
        toast('Abre la conversación del cliente para crearle un pedido');
        return;
      }
      openOrderForm({ customerId, conversationId: conversationId ?? state.wa.selectedId ?? '', location });
    });
    $('#loc-share').addEventListener('click', () => {
      closeSheet();
      openShareLocation({ locationId: location.id, location });
    });
  }

  /** Bloque de ubicaciones del cliente para su ficha (§13). */
  function customerLocationsHtml(locations) {
    if (!locations?.length) {
      return `<p class="view__hint">Todavía no ha compartido ninguna ubicación.</p>`;
    }
    const [latest, ...rest] = locations;
    const row = (location) => `
      <div class="loc-row">
        <span class="loc-row__body">
          <strong>${escapeHtml(locationTitle(location))}</strong>
          <small>${escapeHtml(locationContext(location).who)}${
            location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
          }</small>
        </span>
        ${
          location.map_url
            ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>`
            : ''
        }
      </div>`;
    return `${row(latest)}${
      rest.length
        ? `<details class="loc-history"><summary>Ver historial (${rest.length})</summary>${rest.map(row).join('')}</details>`
        : ''
    }`;
  }

  /** Comprobante de compra dentro del CRM + cómo verlo, descargarlo o compartirlo. */
  async function openReceipt(orderId) {
    try {
      const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
      const receipt = data.receipt;
      const lines = (receipt.items ?? [])
        .map(
          (line) => `<div class="receipt-line">
            <span>${escapeHtml(line.label)}</span>
            <span class="receipt-line__qty">×${escapeHtml(line.quantity)}</span>
            <span class="receipt-line__amount">${money(line.subtotal, receipt.currency)}</span>
          </div>`,
        )
        .join('');
      openSheet(
        `Comprobante · ${receipt.order_number}`,
        `
        <div class="receipt">
          <p class="receipt__brand">${escapeHtml(receipt.business)}</p>
          <p class="receipt__doc">${escapeHtml(receipt.document)}</p>
          <dl class="facts">
            <div class="fact"><dt>Pedido</dt><dd>${escapeHtml(receipt.order_number)}</dd></div>
            <div class="fact"><dt>Fecha</dt><dd>${escapeHtml(fmtWhen(receipt.date))}</dd></div>
            ${receipt.customer_name ? `<div class="fact"><dt>Cliente</dt><dd>${escapeHtml(receipt.customer_name)}</dd></div>` : ''}
            ${receipt.phone_masked ? `<div class="fact"><dt>Teléfono</dt><dd>${escapeHtml(receipt.phone_masked)}</dd></div>` : ''}
            <div class="fact"><dt>Estado</dt><dd>${escapeHtml(receipt.status_label)}</dd></div>
          </dl>
          <div class="receipt__lines">${lines}</div>
          <div class="receipt__totals">
            <div><span>Productos</span><strong>${money(receipt.subtotal, receipt.currency)}</strong></div>
            ${receipt.discount ? `<div><span>Descuento</span><strong>−${money(receipt.discount, receipt.currency)}</strong></div>` : ''}
            ${
              receipt.delivery_fee
                ? `<div><span>Delivery</span><strong>${money(receipt.delivery_fee, receipt.currency)}</strong></div>`
                : ''
            }
            ${
              receipt.shipping
                ? `<div><span>Envío</span><strong>${money(receipt.shipping, receipt.currency)}</strong></div>`
                : ''
            }
            <div class="receipt__grand"><span>TOTAL</span><span>${money(receipt.total, receipt.currency)}</span></div>
          </div>
          ${
            receipt.has_location
              ? `<div class="loc-row">
                   <span class="loc-row__body"><strong>📍 Ubicación de entrega registrada</strong>
                   <small>${escapeHtml(receipt.location_label ?? 'Ubicación compartida')}</small></span>
                   ${
                     locationMapUrl(receipt.location ?? {})
                       ? `<a class="loc__link" href="${escapeHtml(locationMapUrl(receipt.location ?? {}))}" target="_blank" rel="noopener noreferrer">Ver ubicación</a>`
                       : ''
                   }
                 </div>`
              : ''
          }
          <p class="view__hint">${escapeHtml(receipt.thanks)}</p>
          <p class="view__hint">${escapeHtml(receipt.note)}</p>
        </div>
        <button class="btn btn--primary btn--block" id="receipt-open" type="button">Ver / Imprimir comprobante</button>
        <button class="btn btn--ghost btn--block" id="receipt-share" type="button">Compartir</button>
        <button class="btn btn--ghost btn--block" id="receipt-edit" type="button">Modificar pedido</button>
        <button class="btn btn--whatsapp btn--block" id="receipt-send" type="button" disabled
          title="Enviar el comprobante por WhatsApp llega con la fase multimedia (S3)">Enviar comprobante</button>
        <p class="view__hint">Enviar el comprobante por WhatsApp se activa cuando el CRM pueda enviar documentos.</p>
        `,
      );

      const url = `${app2Base()}/api/admin/orders/${encodeURIComponent(orderId)}/receipt`;
      $('#receipt-open').addEventListener('click', () => window.open(url, '_blank', 'noopener'));
      $('#receipt-share').addEventListener('click', async (event) => {
        // Compartir nativo si el móvil puede; si no, se abre el documento.
        if (navigator.share) {
          try {
            await navigator.share({ title: `Comprobante ${receipt.order_number}`, url });
            return;
          } catch {
            /* el usuario canceló: se abre el documento */
          }
        }
        window.open(url, '_blank', 'noopener');
      });
      $('#receipt-edit').addEventListener('click', () => {
        openOrderForm({
          customerId: data.item.customer_id,
          conversationId: data.item.conversation_id ?? '',
          orderId,
          order: data.order,
        });
      });
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo abrir el comprobante');
    }
  }

  /** Base del panel (para construir enlaces absolutos del comprobante). */
  const app2Base = () => `${window.location.origin}`;

  /**
   * Programar un MENSAJE (no es un seguimiento: aquí el sistema intenta enviar).
   * Fuera de la ventana de 24 h solo se puede programar una plantilla aprobada.
   */
  function openScheduledForm({ customerId, conversationId = '', orderId = '' } = {}) {
    const customer = customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null);
    if (!customer) return;
    const approved = (state.templates ?? []).filter((template) => template.sendable === true);
    const dentroDeVentana = state.wa.chat?.customer?.id === customerId ? state.wa.chat?.canSendFreeText !== false : null;
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    openSheet(
      `Programar mensaje · ${customerName(customer)}`,
      `
      <p class="view__hint">
        El sistema lo intentará enviar a esa hora. Si al llegar el momento ya no se puede (ventana de 24 h,
        «no contactar»), <strong>no se fuerza</strong>: queda bloqueado y te avisa.
      </p>
      <label class="field">
        <span class="field__label">Fecha</span>
        <input class="field__input" id="sch-date" type="date" value="${todayISO()}" />
      </label>
      <label class="field">
        <span class="field__label">Hora</span>
        <input class="field__input" id="sch-time" type="time" value="${time}" />
      </label>
      <div class="item__actions" style="margin-top:0">
        <button class="chip" data-sch-quick="60" type="button">En 1 hora</button>
        <button class="chip" data-sch-quick="1440" type="button">Mañana</button>
        <button class="chip" data-sch-quick="10080" type="button">En 7 días</button>
      </div>
      <label class="field">
        <span class="field__label">Mensaje</span>
        <textarea class="field__area" id="sch-text" placeholder="Hola, ¿te ayudo con tu pedido?"></textarea>
      </label>
      ${
        approved.length
          ? `<label class="field">
               <span class="field__label">O usar una plantilla aprobada</span>
               <select class="field__select" id="sch-template">
                 <option value="">— texto de arriba —</option>
                 ${approved.map((template) => `<option value="${escapeHtml(template.name)}">${escapeHtml(template.name)}</option>`).join('')}
               </select>
             </label>`
          : `<p class="view__hint">No hay plantillas aprobadas en Meta: fuera de la ventana de 24 h el mensaje quedará bloqueado.</p>`
      }
      ${
        dentroDeVentana === false
          ? '<p class="rule rule--warn">La ventana de 24 h ya terminó: programa una plantilla aprobada.</p>'
          : ''
      }
      <button class="btn btn--primary btn--block" id="sch-save" type="button">Programar mensaje</button>
      `,
    );

    $$('[data-sch-quick]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const when = new Date(Date.now() + Number(chip.dataset.schQuick) * 60000);
        $('#sch-date').value = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(
          when.getDate(),
        ).padStart(2, '0')}`;
        $('#sch-time').value = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      }),
    );

    $('#sch-save').addEventListener('click', async (event) => {
      const date = $('#sch-date').value;
      const time = $('#sch-time').value || '09:00';
      const template = $('#sch-template')?.value || '';
      const body = $('#sch-text').value.trim();
      if (!date) {
        toast('Elige la fecha');
        return;
      }
      if (!template && !body) {
        toast('Escribe el mensaje');
        return;
      }
      await working(event.currentTarget, 'Programando…', async () => {
        try {
          await api('/api/admin/scheduled', {
            method: 'POST',
            body: JSON.stringify({
              customerId: customer.id,
              conversationId: conversationId || undefined,
              orderId: orderId || undefined,
              // La hora local del teléfono → instante exacto (sin desfases).
              scheduledAt: new Date(`${date}T${time}:00`).toISOString(),
              type: template ? 'template' : 'text',
              template: template || undefined,
              text: body || undefined,
            }),
          });
          toast('Mensaje programado');
          await load({ keepTab: true });
          closeSheet();
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo programar');
        }
      });
    });
  }

  async function scheduledAction(id, action, payload = {}) {
    try {
      await api(`/api/admin/scheduled/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, ...payload }),
      });
      toast(action === 'cancel' ? 'Mensaje cancelado' : 'Mensaje reprogramado');
      await load({ keepTab: true });
      if (state.customerId) await openCustomer(state.customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el mensaje');
    }
  }

  /** Interruptores del plan de postventa (Ajustes). */
  async function toggleFollowupDay(key, enabled) {
    const current = { ...(state.settings?.followup ?? {}) };
    current[key] = enabled;
    try {
      const result = await api('/api/admin/settings/followup', {
        method: 'POST',
        body: JSON.stringify({ enabled: current }),
      });
      state.settings = { ...(state.settings ?? {}), followup: result.followup.enabled };
      toast(enabled ? 'Día activado' : 'Día desactivado');
      renderAjustes();
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo guardar el ajuste');
    }
  }

  /** Métricas del período elegido (Hoy / 7 días / 30 días). */
  async function loadMetrics(period) {
    state.metricsPeriod = period;
    try {
      state.metrics = (await api(`/api/admin/metrics?period=${encodeURIComponent(period)}`)).metrics;
    } catch (error) {
      if (error.message !== 'unauthorized') state.metrics = null;
    }
    renderAjustes();
  }

  async function assignCurrentConversation(action, userId = null) {
    const conversationId = state.wa.selectedId;
    if (!conversationId) return;
    const path =
      action === 'take'
        ? `/api/admin/conversations/${encodeURIComponent(conversationId)}/take`
        : action === 'release'
          ? `/api/admin/conversations/${encodeURIComponent(conversationId)}/release`
          : `/api/admin/conversations/${encodeURIComponent(conversationId)}/assign`;
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify(userId ? { userId } : {}),
      });
      await refreshWhatsapp();
      await loadWaThread(conversationId, { force: true });
      toast(action === 'take' ? 'Conversación tomada' : action === 'release' ? 'Conversación liberada' : 'Conversación reasignada');
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar la asignación');
    }
  }

  function chooseUserId() {
    const agents = (state.users ?? []).filter((user) => user.active !== false);
    if (!agents.length) return null;
    const menu = agents.map((user, index) => `${index + 1}. ${user.display_name} (${roleLabel(user.role)})`).join('\n');
    const raw = window.prompt(`Reasignar a:\n${menu}`);
    const index = Number.parseInt(raw ?? '', 10) - 1;
    return agents[index]?.id ?? null;
  }

  async function loadInventory() {
    state.inventoryLoading = true;
    try {
      const data = await api('/api/admin/inventory');
      state.inventory = data;
      state.catalog = data.presentations ?? state.catalog;
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo cargar inventario');
    } finally {
      state.inventoryLoading = false;
    }
    renderProductos();
  }

  async function loadSalesReport(period = state.salesReportPeriod) {
    state.salesReportPeriod = period;
    state.salesReportLoading = true;
    try {
      const data = await api(`/api/admin/reports/sales?period=${encodeURIComponent(period)}`);
      state.salesReport = data.report ?? null;
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo cargar el reporte');
    } finally {
      state.salesReportLoading = false;
    }
    renderReportes();
  }

  async function submitInventoryForm(form) {
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      let path = '/api/admin/inventory/restock';
      if (form.id === 'inventory-cost') path = '/api/admin/inventory/cost';
      if (form.id === 'inventory-adjust') path = '/api/admin/inventory/adjust';
      const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      state.inventory = data.inventory ?? state.inventory;
      toast(form.id === 'inventory-cost' ? 'Costo actualizado' : 'Inventario actualizado');
      await loadInventory();
      state.salesReport = null;
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo guardar inventario');
    }
  }


  // ------------------------------------------------------------------ PWA

  function updateBadge() {
    const pendientes = (state.stats?.hoy ?? 0) + (state.stats?.nuevos ?? 0);
    const badge = $('#badge-hoy');
    badge.hidden = pendientes === 0;
    badge.textContent = pendientes;
    // WhatsApp: mensajes sin leer + conversaciones que necesitan una persona.
    const whatsappPendiente = (state.hoy?.sinResponder ?? 0) + (state.hoy?.humanoRequerido ?? 0);
    const waBadge = $('#badge-whatsapp');
    waBadge.hidden = whatsappPendiente === 0;
    waBadge.textContent = whatsappPendiente;
    if (navigator.setAppBadge) navigator.setAppBadge(pendientes + whatsappPendiente).catch(() => {});
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
    /*
     * Indicador de PRESENCIA: un punto con un halo lento. Dice "sistema
     * conectado", no es un botón (no hace nada al tocarlo) y no finge nada: si
     * el navegador dice que no hay red, cambia de color y de texto.
     */
    pill.dataset.online = online ? 'true' : 'false';
    pill.innerHTML =
      '<span class="presence__dot" aria-hidden="true"></span>' +
      `<span class="presence__label">${online ? 'En línea' : 'Sin conexión'}</span>`;
    pill.setAttribute('aria-label', online ? 'Sistema en línea' : 'Sin conexión');
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

  // ------------------------------------------------------------------- menú
  /*
   * El menú lateral guarda lo secundario (pedidos, seguimientos, plantillas y
   * ajustes) para que abajo solo queden los tres destinos de trabajo. Se cierra
   * tocando fuera, con la ✕ o con Escape, y devuelve el foco a quien lo abrió.
   */
  let drawerFocusBack = null;

  function openDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#scrim');
    if (!drawer || !scrim) return;
    drawerFocusBack = document.activeElement;
    drawer.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add('drawer--open');
      scrim.classList.add('scrim--open');
    });
    $('#menu')?.setAttribute('aria-expanded', 'true');
    state.drawer = true;
    drawer.querySelector('button')?.focus();
  }

  function closeDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#scrim');
    if (!drawer || !scrim || drawer.hidden) return;
    drawer.classList.remove('drawer--open');
    scrim.classList.remove('scrim--open');
    $('#menu')?.setAttribute('aria-expanded', 'false');
    state.drawer = false;
    setTimeout(() => {
      if (!state.drawer) {
        drawer.hidden = true;
        scrim.hidden = true;
      }
    }, 200);
    if (drawerFocusBack instanceof HTMLElement) drawerFocusBack.focus();
    drawerFocusBack = null;
  }

  // ------------------------------------------------------------------- tabs

  /** Los tres destinos de trabajo + lo que vive en el menú lateral. */
  const VIEWS = ['hoy', 'whatsapp', 'clientes', 'pedidos', 'productos', 'reportes', 'seguimientos', 'mensajes', 'ajustes', 'usuarios'];
  const VIEW_SUBTITLE = {
    hoy: 'CRM',
    whatsapp: 'WhatsApp',
    clientes: 'Clientes',
    pedidos: 'Pedidos',
    productos: 'Inventario',
    reportes: 'Reportes',
    seguimientos: 'Seguimientos',
    mensajes: 'Plantillas',
    ajustes: 'Ajustes',
    usuarios: 'Usuarios',
  };

  function setTab(tab, options = {}) {
    state.tab = tab;
    localStorage.setItem(TAB_KEY, tab);
    // El ancho de la bandeja de WhatsApp depende de la pestaña activa (CSS).
    document.body.dataset.tab = tab;
    $$('[data-tab]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.tab === tab)));
    VIEWS.forEach((name) => {
      const view = $(`#view-${name}`);
      if (view) view.hidden = name !== tab;
    });
    const sub = $('#topbar-sub');
    if (sub) sub.textContent = VIEW_SUBTITLE[tab] ?? 'CRM';
    if (!options.silent) {
      window.scrollTo({ top: 0 });
      // Al entrar en WhatsApp se refresca una vez; el sondeo sigue después.
      if (tab === 'whatsapp') refreshWhatsapp().catch(() => {});
      if (tab === 'productos') loadInventory().catch(() => {});
      if (tab === 'reportes') loadSalesReport(state.salesReportPeriod).catch(() => {});
      if (tab === 'usuarios') loadUsers().catch(() => {});
      // Al entrar en Ajustes se refresca lo que cambia con el uso: los números y
      // la traza. Así el negocio ve el efecto de lo que acaba de hacer.
      if (tab === 'ajustes') {
        loadMetrics(state.metricsPeriod).catch(() => {});
        state.auditEntries = null;
        state.auditLoading = true;
        loadAuditEntries();
      }
    }
  }

  // ---------------------------------------------------------------- eventos

  /*
   * Los manejadores se enganchan una sola vez. Si `boot` llegara a ejecutarse
   * dos veces (por ejemplo, un `DOMContentLoaded` repetido), engancharlos de
   * nuevo haría que un toque contara doble (enviar dos mensajes, abrir y cerrar
   * una hoja a la vez), así que se marcan como ya montados.
   */
  let eventosMontados = false;

  function initEvents() {
    if (eventosMontados) return;
    eventosMontados = true;

    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = $('#login-username')?.value.trim() ?? '';
      const password = $('#login-password')?.value ?? '';
      const token = $('#login-token')?.value.trim() ?? '';
      if (!token && (!username || !password)) return;
      try {
        const payload = token ? { token } : { username, password };
        const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(payload) });
        state.auth = { user: result.user ?? null, legacy: Boolean(token) };
        if ($('#login-token')) $('#login-token').value = '';
        if ($('#login-password')) $('#login-password').value = '';
        showApp();
        await load();
      } catch (error) {
        $('#login-error').hidden = false;
        $('#login-error').textContent =
          error.body?.message ??
          (error.message === 'unauthorized' ? 'Usuario o contraseña incorrectos.' : 'No se pudo entrar: no hay conexión con el CRM.');
      }
    });

    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (['inventory-restock', 'inventory-cost', 'inventory-adjust'].includes(form.id)) {
        event.preventDefault();
        submitInventoryForm(form);
      }
      if (form.id === 'user-create') {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        working(form.querySelector('button[type="submit"]'), 'Creando…', async () => {
          await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
          form.reset();
          await loadUsers();
          toast('Usuario creado');
        }).catch((error) => {
          if (error.message !== 'unauthorized') toast(error.body?.error === 'weak_password' ? 'La contraseña debe tener mínimo 10 caracteres' : error.body?.message ?? 'No se pudo crear');
        });
      }
    });

    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));

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
      const card = event.target.closest('[data-goto]');
      if (card) {
        setTab(card.dataset.goto);
        return;
      }
      // Compatibilidad: las tarjetas antiguas filtraban la lista de clientes.
      const legacy = event.target.closest('[data-stat]');
      if (!legacy) return;
      state.filter = legacy.dataset.stat === 'atrasados' ? 'hoy' : legacy.dataset.stat;
      $$('[data-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)),
      );
      setTab('clientes');
      renderClientes();
    });

    document.addEventListener('click', (event) => {
      /*
       * El orden importa: los botones viven DENTRO de tarjetas que también son
       * táctiles. Si se comprobara `data-chat` primero, pulsar "Registrar compra"
       * abriría el chat en vez de la compra.
       */
      const purchase = event.target.closest('[data-purchase]');
      if (purchase) {
        openPurchaseForm(purchase.dataset.purchase);
        return;
      }
      /*
       * Ubicación en el hilo: «⋯» abre sus acciones (ver mapa, usar para un pedido,
       * compartir). Se busca el mensaje en el hilo ya cargado: la ubicación viaja
       * con el mensaje, así que no hace falta pedirla otra vez.
       */
      const locMenu = event.target.closest('[data-loc-menu]');
      if (locMenu) {
        const id = locMenu.dataset.locMenu;
        const messages = state.wa.chat?.messages ?? [];
        const found = messages.find((row) => row.location?.id === id)?.location ?? null;
        if (found) openLocationActions({ location: found, conversationId: state.wa.selectedId });
        return;
      }
      // --- acciones comerciales (S4/S5): pedido, comprobante, programar ---
      if (event.target.closest('#wa-actions')) {
        const button = event.target.closest('#wa-actions');
        openChatActions(button.dataset.customer, button.dataset.conversation);
        return;
      }
      if (event.target.closest('[data-conv-take]')) {
        assignCurrentConversation('take');
        return;
      }
      if (event.target.closest('[data-conv-release]')) {
        assignCurrentConversation('release');
        return;
      }
      if (event.target.closest('[data-conv-reassign]')) {
        if (!state.users?.length) {
          loadUsers()
            .then(() => {
              const userId = chooseUserId();
              if (userId) assignCurrentConversation('assign', userId);
            })
            .catch(() => toast('No se pudieron cargar usuarios'));
        } else {
          const userId = chooseUserId();
          if (userId) assignCurrentConversation('assign', userId);
        }
        return;
      }
      const orderNew = event.target.closest('[data-order-new]');
      if (orderNew) {
        openOrderForm({
          customerId: orderNew.dataset.orderNew,
          conversationId: orderNew.dataset.conversation ?? '',
        });
        return;
      }
      const receipt = event.target.closest('[data-receipt]');
      if (receipt) {
        openReceipt(receipt.dataset.receipt);
        return;
      }
      const scheduledNew = event.target.closest('[data-scheduled-new]');
      if (scheduledNew) {
        openScheduledForm({
          customerId: scheduledNew.dataset.scheduledNew,
          conversationId: scheduledNew.dataset.conversation ?? '',
        });
        return;
      }
      const scheduledCancel = event.target.closest('[data-scheduled-cancel]');
      if (scheduledCancel) {
        scheduledAction(scheduledCancel.dataset.scheduledCancel, 'cancel', { reason: 'cancelado en el panel' });
        return;
      }
      const metricsChip = event.target.closest('[data-metrics]');
      if (metricsChip) {
        loadMetrics(metricsChip.dataset.metrics);
        return;
      }
      const reportChip = event.target.closest('[data-report-period]');
      if (reportChip) {
        loadSalesReport(reportChip.dataset.reportPeriod);
        return;
      }
      const review = event.target.closest('[data-review]');
      if (review) {
        reconcileMedia(review.dataset.reviewId, review.dataset.review);
        return;
      }
      const role = event.target.closest('[data-user-role]');
      if (role) {
        updateUser(role.dataset.userRole, { role: role.dataset.role });
        return;
      }
      const active = event.target.closest('[data-user-active]');
      if (active) {
        updateUser(active.dataset.userActive, { active: active.dataset.active === 'true' });
        return;
      }
      const password = event.target.closest('[data-user-password]');
      if (password) {
        const next = window.prompt('Nueva contraseña temporal (mínimo 10 caracteres)');
        if (next) updateUser(password.dataset.userPassword, { password: next });
        return;
      }
      // ---------------------------------------------- multimedia (S3)
      const viewImage = event.target.closest('[data-media-view]');
      if (viewImage) {
        openViewer(viewImage.dataset.mediaView);
        return;
      }
      if (event.target.closest('#media-viewer') || event.target.closest('#media-viewer-close')) {
        closeViewer();
        return;
      }
      const playAudio = event.target.closest('[data-audio-play]');
      if (playAudio) {
        toggleAudio(playAudio.dataset.audioPlay, playAudio.dataset.audioSrc);
        return;
      }
      const retry = event.target.closest('[data-media-retry]');
      if (retry) {
        retryMedia(retry.dataset.mediaRetry);
        return;
      }
      if (event.target.closest('#wa-attach')) {
        openAttachSheet(state.wa.selectedId);
        return;
      }
      if (event.target.closest('#wa-mic')) {
        openRecorder(state.wa.selectedId);
        return;
      }
      // --------------------------------------------- respuestas rápidas
      if (event.target.closest('[data-quick-replies]')) {
        openQuickReplies();
        return;
      }
      if (event.target.closest('[data-qr-new]')) {
        openQuickReplyForm(null);
        return;
      }
      const qrPick = event.target.closest('[data-qr-insert]');
      if (qrPick) {
        insertQuickReply(qrPick.dataset.qrInsert);
        return;
      }
      const qrMore = event.target.closest('[data-qr-menu]');
      if (qrMore) {
        qrMenuId = qrMenuId === qrMore.dataset.qrMenu ? null : qrMore.dataset.qrMenu;
        renderQuickReplies();
        return;
      }
      const qrEdit = event.target.closest('[data-qr-edit]');
      if (qrEdit) {
        openQuickReplyForm(qrEdit.dataset.qrEdit);
        return;
      }
      const qrDel = event.target.closest('[data-qr-del]');
      if (qrDel) {
        quickReplyDelete(qrDel.dataset.qrDel);
        return;
      }
      if (event.target.closest('[data-qr-back]')) {
        openQuickReplies();
        return;
      }
      const customer = event.target.closest('[data-customer]');
      if (customer) {
        openCustomer(customer.dataset.customer);
        return;
      }
      const newFollowup = event.target.closest('[data-followup-new]');
      if (newFollowup) {
        openFollowupForm(newFollowup.dataset.followupNew);
        return;
      }
      const done = event.target.closest('[data-followup-done]');
      if (done) {
        followupAction(done.dataset.followupDone, 'complete');
        return;
      }
      const postpone = event.target.closest('[data-followup-postpone]');
      if (postpone) {
        followupAction(postpone.dataset.followupPostpone, 'postpone', { days: 3 });
        return;
      }
      const cancel = event.target.closest('[data-followup-cancel]');
      if (cancel) {
        followupAction(cancel.dataset.followupCancel, 'cancel', { reason: 'cancelado en el panel' });
        return;
      }
      const pause = event.target.closest('[data-pause]');
      if (pause) {
        customerAction(pause.dataset.pause, 'pause');
        return;
      }
      const resume = event.target.closest('[data-resume]');
      if (resume) {
        customerAction(resume.dataset.resume, 'resume');
        return;
      }
      const optin = event.target.closest('[data-optin]');
      if (optin) {
        customerAction(optin.dataset.optin, 'optin');
        return;
      }
      const optout = event.target.closest('[data-optout]');
      if (optout) {
        const id = optout.dataset.optout;
        // Dos toques: dejar de escribirle a alguien para siempre no puede ser
        // un roce con el dedo.
        if (pendingOptOut !== id) {
          pendingOptOut = id;
          optout.textContent = '¿Seguro? Toca otra vez';
          toast('Si tocas otra vez, este cliente no recibirá más mensajes');
          return;
        }
        pendingOptOut = null;
        customerAction(id, 'optout');
        return;
      }
      const chat = event.target.closest('[data-chat]');
      if (chat) {
        openChat(chat.dataset.chat, { followupId: chat.dataset.followup ?? null });
        return;
      }
      const convSelect = event.target.closest('[data-conv-select]');
      if (convSelect) {
        const id = convSelect.dataset.convSelect;
        if (state.wa.selected.has(id)) state.wa.selected.delete(id);
        else state.wa.selected.add(id);
        renderWaList();
        return;
      }
      const bulk = event.target.closest('[data-wa-bulk]');
      if (bulk) {
        runWaBulk(bulk.dataset.waBulk);
        return;
      }
      const conv = event.target.closest('[data-conv]');
      if (conv) {
        selectConversation(conv.dataset.conv);
        return;
      }
      // Reintentos de la bandeja: un fallo del API se ve y se puede volver a probar.
      if (event.target.closest('#wa-retry')) {
        state.wa.listError = false;
        renderWaList();
        load({ keepTab: true })
          .then(() => refreshWhatsapp())
          .catch(() => {});
        return;
      }
      if (event.target.closest('#wa-retry-thread')) {
        if (state.wa.selectedId) loadWaThread(state.wa.selectedId, { force: true });
        return;
      }
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
        closeSheet();
      }
    });

    $('#nueva-plantilla').addEventListener('click', () => openMessageForm(null));
    $('#compra-nueva').addEventListener('click', () => openPurchaseForm(null));
    $('#compra-nueva-ped').addEventListener('click', () => openPurchaseForm(null));

    // Interruptores del plan de postventa (Ajustes): cada día se activa o apaga.
    document.addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-plan-toggle]');
      if (toggle) toggleFollowupDay(toggle.dataset.planToggle, toggle.checked);
    });

    // Buscar dentro de un audio (el deslizador manda en la reproducción).
    document.addEventListener('input', (event) => {
      const seek = event.target.closest('[data-audio-seek]');
      if (seek) seekAudio(seek.dataset.audioSeek, Number(seek.value));
    });

    // ------------------------------------------------------- menú lateral
    $('#menu').addEventListener('click', () => (state.drawer ? closeDrawer() : openDrawer()));
    $('#drawer-close').addEventListener('click', () => closeDrawer());
    $('#scrim').addEventListener('click', () => closeDrawer());
    $('#drawer').addEventListener('click', (event) => {
      // Elegir una opción del menú navega y lo cierra.
      if (event.target.closest('[data-tab]')) closeDrawer();
    });
    $('#logout-drawer').addEventListener('click', () => $('#logout').click());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('#media-viewer')?.hidden) {
          closeViewer();
          return;
        }
        if (state.drawer) {
          closeDrawer();
          return;
        }
        if (!$('#sheet')?.hidden) closeSheet();
      }
    });

    // -------------------------------------------------- bandeja de WhatsApp
    /*
     * La bandeja no tiene botón de recargar: se refresca sola (sondeo de 8 s) y
     * al entrar en la pestaña. Buscar y filtrar sí son acciones de la persona.
     */
    $('#wa-search').addEventListener('input', (event) => {
      state.wa.q = event.target.value.trim();
      refreshWhatsapp().catch(() => renderWaList());
    });
    $('#wa-filters').addEventListener('click', (event) => {
      if (event.target.closest('#wa-notify')) {
        if (typeof Notification === 'undefined') {
          toast('Este navegador no soporta notificaciones');
          return;
        }
        Notification.requestPermission().then((permission) => {
          state.wa.notify = permission === 'granted';
          localStorage.setItem(WA_NOTIFY_KEY, state.wa.notify ? '1' : '0');
          renderWhatsapp();
          toast(state.wa.notify ? 'Notificaciones activadas' : 'No se activaron las notificaciones');
        });
        return;
      }
      if (event.target.closest('#wa-sound')) {
        state.wa.sound = !state.wa.sound;
        localStorage.setItem(WA_SOUND_KEY, state.wa.sound ? '1' : '0');
        renderWhatsapp();
        if (state.wa.sound) playNewMessageSound();
        return;
      }
      const chip = event.target.closest('[data-wa-filter]');
      if (!chip) return;
      state.wa.filter = chip.dataset.waFilter;
      state.wa.selected.clear();
      $$('[data-wa-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.waFilter === state.wa.filter)),
      );
      refreshWhatsapp().catch(() => renderWaList());
    });
    // En el móvil, ← vuelve a la lista de conversaciones.
    $('#wa-back').addEventListener('click', () => setWaView('list'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') waPollTick();
    });

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
    paintIcons();
    initPwa();

    // Un único temporizador para la bandeja de WhatsApp (8 s, solo cuando toca).
    setInterval(waPollTick, 8000);

    // Atajos del icono instalado (manifest → shortcuts): /admin/?v=clientes
    const query = new URLSearchParams(location.search);
    const wanted = query.get('v');
    if (VIEWS.includes(wanted)) state.tab = wanted;

    /*
     * Sin conexión NO se puede comprobar la sesión, pero el panel ya estuvo
     * abierto antes en este teléfono: se muestra con la última copia en vez de
     * pedir la clave a alguien que está en la calle sin datos.
     */
    const cached = readSnapshot();
    if (!navigator.onLine && cached) {
      showApp();
      await load({ keepTab: true });
      await applyDeepLink(query);
      toast('Sin conexión: datos guardados en el teléfono');
      return;
    }

    /*
     * Enlace con la clave dentro (`/panel?token=…`, el de antes; nginx lo
     * redirige a `/admin/?token=…`): se entra solo y se quita la clave de la
     * barra de direcciones, para que no quede a la vista ni en el historial.
     */
    const linkToken = query.get('token');
    if (linkToken) {
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: linkToken }) });
        history.replaceState(null, '', `${location.pathname}${wanted ? `?v=${wanted}` : ''}`);
        showApp();
        await load();
        await applyDeepLink(query);
        return;
      } catch {
        /* Clave caducada o CRM apagado: se cae al acceso normal, que explica el motivo. */
      }
    }

    if (await checkSession()) {
      showApp();
      await load();
      await applyDeepLink(query);
    } else if (cached) {
      // El servidor no contesta (o la sesión caducó): si hay copia, se enseña.
      showApp();
      await load({ keepTab: true });
      await applyDeepLink(query);
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
