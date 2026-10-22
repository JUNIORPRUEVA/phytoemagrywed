/**
 * SUPERVISOR IA DELIVERY — pantalla administrativa.
 *
 * Muestra lo que el motor determinista del servidor ya sabe de cada pedido:
 * quién lo lleva, qué toca hacer, cuánto lleva parado, cuántos avisos se le
 * mandaron y si está escalado. NO calcula reglas aquí: solo pinta y manda las
 * acciones al servidor (posponer, ejecutar la pasada, guardar ajustes).
 *
 * Reglas de la pantalla
 *   - Solo lectura por defecto: mirar el supervisor nunca cambia nada.
 *   - «Posponer» pide motivo y fecha; el servidor vuelve a validar los límites.
 *   - Se dice la verdad cuando algo no se pudo enviar (p. ej. plantilla sin
 *     aprobar): el estado real viene del servidor, no se inventa.
 */

const state = {
  tab: '',
  data: null,
  bucket: 'todas',
  loading: false,
  error: '',
  busy: '',
  form: null,
  preview: null,
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const VIEW = () => document.getElementById('view-supervisor');

function toast(message) {
  const host = document.getElementById('toast');
  if (!host) return;
  host.textContent = message;
  host.classList.add('toast--show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => host.classList.remove('toast--show'), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.message || 'No se pudo completar la operación.');
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  // La capa sin conexión marca así lo que viene de la copia guardada.
  if (response.headers.get('x-fulltech-offline') === '1') data.__offline = true;
  return data;
}

const BUCKETS = [
  ['revision', 'Revisión pendiente'],
  ['sin_iniciar', 'Sin iniciar'],
  ['en_camino', 'En camino'],
  ['atrasados', 'Atrasados'],
  ['sin_respuesta', 'Sin respuesta'],
  ['pospuestos', 'Pospuestos'],
  ['incidencias', 'Incidencias'],
  ['confirmadas', 'Confirmadas'],
];

const minutes = (value) => {
  const total = Math.max(0, Math.round(Number(value) || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
};

const money = (value, currency = 'DOP') => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  try {
    return new Intl.NumberFormat('es-DO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(number);
  } catch {
    return `${currency} ${number}`;
  }
};

const dateShort = (value) => {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-DO', { day: '2-digit', month: 'short' });
};

function rowHtml(row) {
  const responsable = row.responsible
    ? `${esc(row.responsible.name)} · ${row.responsible.type === 'external' ? 'externo' : 'interno'}`
    : 'Sin responsable';
  const attempts = Number(row.attempts ?? 0);
  const max = Number(row.max_attempts ?? 0);
  const late = row.severity === 'late';
  const postponed = row.stage === 'postponed';
  return `
    <article class="sup-row${late ? ' sup-row--late' : ''}" data-sup-row="${esc(row.id)}">
      <div class="sup-row__main">
        <strong class="sup-row__number">${esc(row.order_number)}</strong>
        <span class="sup-row__customer">${esc(row.customer_name)}</span>
        <span class="sup-row__total">${esc(money(row.total, row.currency))}</span>
      </div>
      <div class="sup-row__meta">
        <span class="sup-tag${late ? ' sup-tag--late' : ''}">${esc(minutes(row.elapsed_minutes))}</span>
        <span class="sup-tag">${esc(responsable)}</span>
        ${attempts ? `<span class="sup-tag">${attempts}/${max || '—'} avisos</span>` : ''}
        ${postponed && row.postponed_until ? `<span class="sup-tag sup-tag--postponed">Hasta ${esc(dateShort(row.postponed_until))}</span>` : ''}
      </div>
      <p class="sup-row__next">${esc(row.next_action)}</p>
      <div class="sup-row__actions">
        <a class="sup-btn" href="${esc(row.deep_link)}">Abrir pedido</a>
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-centro="${esc(row.id)}">Centro IA</button>
        ${row.review_reason && row.responsible ? `<button class="sup-btn" type="button" data-sup-include="${esc(row.id)}">Incluir en seguimiento</button>` : ''}
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-postpone="${esc(row.id)}" data-sup-number="${esc(row.order_number)}">Posponer</button>
      </div>
    </article>`;
}

function listHtml() {
  const data = state.data;
  if (!data) return '';
  const rows = state.bucket === 'todas'
    ? data.upcoming ?? []
    : data.buckets?.[state.bucket] ?? [];
  if (!rows.length) {
    return `<p class="sup-empty">${state.bucket === 'todas' ? 'No hay pedidos pendientes de supervisión.' : 'Nada en esta lista.'}</p>`;
  }
  return `<div class="sup-list">${rows.map(rowHtml).join('')}</div>`;
}

function settingsHtml() {
  const s = state.data?.settings;
  if (!s) return '';
  const number = (key, label, min, max, suffix = '') => `
    <label class="sup-field">
      <span>${esc(label)}</span>
      <input type="number" min="${min}" max="${max}" step="1" value="${esc(s[key])}" data-sup-setting="${key}">
      ${suffix ? `<em>${esc(suffix)}</em>` : ''}
    </label>`;
  const check = (key, label) => `
    <label class="sup-check">
      <input type="checkbox" data-sup-setting="${key}" ${s[key] ? 'checked' : ''}>
      <span>${esc(label)}</span>
    </label>`;
  return `
    <details class="sup-settings">
      <summary>Reglas del supervisor</summary>
      <div class="sup-settings__grid">
        ${check('enabled', 'Supervisor activo')}
        ${check('internalNotifications', 'Avisos internos al repartidor')}
        ${check('whatsAppReminders', 'Recordatorios por WhatsApp')}
        ${check('useDeepSeek', 'Interpretar respuestas con DeepSeek')}
        ${number('firstReminderMinutes', 'Primer aviso', 1, 1440, 'minutos')}
        ${number('followUpMinutes', 'Repetir cada', 5, 1440, 'minutos')}
        ${number('maxAttempts', 'Máximo de intentos', 1, 10)}
        ${number('escalateAfterMinutes', 'Escalar a administración a los', 15, 43200, 'minutos')}
        ${number('lateAfterMinutes', 'Marcar atrasado a los', 15, 10080, 'minutos')}
        ${number('contactFromHour', 'Contactar desde las', 0, 23, 'h')}
        ${number('contactToHour', 'Contactar hasta las', 0, 23, 'h')}
        ${number('postponeMaxDays', 'Posponer como máximo', 1, 60, 'días')}
        ${number('postponeMaxCount', 'Posposiciones permitidas', 1, 10)}
        ${number('dailySummaryHour', 'Resumen diario a las', 0, 23, 'h')}
      </div>
      <button class="sup-btn" type="button" data-sup-save-settings ${state.busy === 'settings' ? 'disabled' : ''}>Guardar reglas</button>
    </details>`;
}

function render() {
  const host = VIEW();
  if (!host) return;
  if (state.error && !state.data) {
    host.innerHTML = `
      <div class="sup-head"><h2>Supervisor IA Delivery</h2></div>
      <p class="sup-empty" role="alert">${esc(state.error)}</p>
      <button class="sup-btn" type="button" data-sup-refresh>Reintentar</button>`;
    return;
  }
  const data = state.data;
  if (!data) {
    host.innerHTML = `<p class="sup-empty">Cargando supervisión…</p>`;
    return;
  }
  const counts = data.counts ?? {};
  /*
   * ÚLTIMA PASADA REAL. Sale del latido que escribe el backend (el scheduler
   * corre cada 30 s); si nunca corrió, se dice tal cual: nada de indicadores
   * fingidos.
   */
  const ultimaPasada = data.last_run_at
    ? new Date(data.last_run_at).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  const resumenPasada = data.last_run
    ? `${data.last_run.reminders} aviso(s) · ${data.last_run.escalations} escalado(s)${data.last_run.deferred ? ` · ${data.last_run.deferred} fuera de horario` : ''}${data.last_run.capped ? ' · tope de lectura alcanzado' : ''}`
    : null;
  const chips = BUCKETS.map(([key, label]) => `
    <button class="sup-chip${state.bucket === key ? ' sup-chip--on' : ''}" type="button" data-sup-bucket="${key}">
      <span>${esc(label)}</span><strong>${esc(counts[key] ?? 0)}</strong>
    </button>`).join('');
  host.innerHTML = `
    <div class="sup-head">
      <div>
        <h2>Supervisor IA Delivery</h2>
        <p class="sup-lede">${data.enabled ? 'Seguimiento activo' : 'Supervisor apagado'} · actualizado ${esc(new Date(data.generated_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }))}</p>
        <p class="sup-lede">${ultimaPasada ? `Última pasada automática: ${esc(ultimaPasada)}${resumenPasada ? ` · ${esc(resumenPasada)}` : ''}` : 'Sin pasadas automáticas registradas todavía.'}</p>
      </div>
      <div class="sup-head__actions">
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-refresh>Actualizar</button>
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-preview ${state.busy === 'preview' ? 'disabled' : ''}>Vista previa</button>
        <button class="sup-btn" type="button" data-sup-run ${state.busy === 'run' ? 'disabled' : ''}>${state.busy === 'run' ? 'Revisando…' : 'Ejecutar ahora'}</button>
      </div>
    </div>
    ${state.error ? `<p class="sup-alert" role="alert">${esc(state.error)} Lo que ves abajo es la última revisión guardada en este dispositivo.</p>` : data.__offline ? '<p class="sup-note" data-sup-offline>Sin conexión: viendo la última revisión guardada en este dispositivo.</p>' : ''}
    <div class="sup-chips">
      <button class="sup-chip${state.bucket === 'todas' ? ' sup-chip--on' : ''}" type="button" data-sup-bucket="todas">
        <span>Pendientes</span><strong>${esc((data.upcoming ?? []).length)}</strong>
      </button>
      ${chips}
    </div>
    ${listHtml()}
    <div class="sup-foot">
      <button class="sup-btn sup-btn--ghost" type="button" data-sup-daily ${state.busy === 'daily' ? 'disabled' : ''}>Generar resumen diario</button>
    </div>
    ${settingsHtml()}
    <section class="sup-activity">
      <h3>Actividad reciente</h3>
      ${(data.activity ?? []).length
        ? `<ul>${data.activity.map((row) => `<li><span class="sup-activity__when">${esc(dateShort(row.created_at))}</span> ${esc(row.detail ?? row.kind)}</li>`).join('')}</ul>`
        : '<p class="sup-empty">Sin actividad todavía.</p>'}
    </section>`;
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  try {
    state.data = await api('/api/admin/delivery-supervisor');
  } catch (error) {
    state.error = error.status === 403 ? 'Solo administración puede ver el supervisor.' : error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function runNow() {
  if (state.busy) return;
  state.busy = 'run';
  render();
  try {
    const result = await api('/api/admin/delivery-supervisor/run', { method: 'POST' });
    state.data = result.snapshot ?? state.data;
    const enviados = Number(result.result?.reminders ?? 0);
    const escalados = Number(result.result?.escalations ?? 0);
    toast(`Supervisión ejecutada · ${enviados} aviso(s) · ${escalados} escalamiento(s)`);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
    render();
  }
}

async function dailySummary() {
  if (state.busy) return;
  state.busy = 'daily';
  render();
  try {
    const result = await api('/api/admin/delivery-supervisor/daily', { method: 'POST' });
    toast(result.pendientes ? `Resumen generado · ${result.pendientes} pendiente(s)` : 'Resumen generado · sin pendientes');
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
    render();
  }
}

async function saveSettings() {
  if (state.busy) return;
  const payload = { ...state.data?.settings };
  document.querySelectorAll('[data-sup-setting]').forEach((input) => {
    const key = input.dataset.supSetting;
    payload[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
  });
  state.busy = 'settings';
  render();
  try {
    const result = await api('/api/admin/delivery-supervisor/settings', { method: 'POST', body: JSON.stringify(payload) });
    if (state.data) state.data.settings = result.settings;
    toast('Reglas guardadas');
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
    render();
  }
}

async function includeInFollowUp(orderId) {
  if (state.busy || !state.data?.settings) return;
  state.busy = `include:${orderId}`;
  render();
  try {
    const settings = state.data.settings;
    const includeOrderIds = [...new Set([...(settings.includeOrderIds ?? []), orderId])];
    await api('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ ...settings, includeOrderIds }),
    });
    state.data = await api('/api/admin/delivery-supervisor');
    toast('Pedido incluido; el supervisor lo revisará en la próxima pasada.');
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
    render();
  }
}

/*
 * VISTA PREVIA: a quién se escribiría AHORA MISMO.
 *
 * El servidor calcula elegibilidad, vencimientos y límites; aquí solo se pinta.
 * Es la pantalla que se mira ANTES de encender el supervisor en producción.
 */
async function openPreview() {
  if (state.busy) return;
  state.busy = 'preview';
  render();
  try {
    state.preview = await api('/api/admin/delivery-supervisor/preview');
  } catch (error) {
    state.preview = null;
    toast(error.message);
  } finally {
    state.busy = '';
    render();
    renderPreview();
  }
}

function renderPreview() {
  const host = document.getElementById('sup-preview');
  if (!host) return;
  const data = state.preview;
  if (!data) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  const activation = data.activation ?? {};
  const totals = data.totals ?? {};
  const excluded = data.excluded ?? {};
  const recipients = data.recipients ?? [];
  const motivos = {
    closed: 'cerrados',
    unassigned: 'sin repartidor',
    delivery_cancelled: 'entrega cancelada',
    not_activated: 'sin activar',
    before_activation: 'anteriores a la activación',
    no_assignment_date: 'sin fecha de asignación',
  };
  host.hidden = false;
  host.innerHTML = `
    <div class="sup-dialog__back" data-sup-preview-close></div>
    <div class="sup-dialog sup-dialog--wide" role="dialog" aria-label="Vista previa de destinatarios">
      <h3>Vista previa de destinatarios</h3>
      <p class="sup-dialog__hint">No se envía nada: es lo que pasaría en la próxima pasada.</p>
      ${activation.required ? '<p class="sup-dialog__error">Supervisor sin fecha de activación: todavía no hay pedidos elegibles.</p>' : ''}
      <p class="sup-lede">
        ${esc(totals.candidates ?? 0)} candidato(s) · ${esc(totals.reminders ?? 0)} recordatorio(s) ·
        ${esc(totals.escalations ?? 0)} escalamiento(s) · se enviarían ${esc(totals.would_send ?? 0)} ahora
        ${data.in_hours ? '' : ' · fuera del horario de contacto'}
      </p>
      <div class="sup-preview-tags">
        <span class="sup-tag">Límite ${esc(data.limits?.reminders ?? 0)}/pasada</span>
        <span class="sup-tag">Pendientes por límite: ${esc(totals.deferred_by_limit ?? 0)}</span>
        ${Object.entries(excluded)
          .map(([key, value]) => `<span class="sup-tag">${esc(value)} ${esc(motivos[key] ?? key)}</span>`)
          .join('')}
      </div>
      ${
        recipients.length
          ? `<ul class="sup-preview-list">${recipients
              .slice(0, 20)
              .map(
                (row) =>
                  `<li><strong>${esc(row.order_number)}</strong> · ${esc(row.responsible ?? 'sin responsable')}${
                    row.phone ? ` · ${esc(row.phone)}` : ''
                  } · ${esc(row.kind === 'reminder' ? 'recordatorio' : 'escalamiento')}<span>${esc(row.next_action ?? '')}</span></li>`,
              )
              .join('')}</ul>`
          : '<p class="sup-empty">Nadie sería contactado ahora mismo.</p>'
      }
      <div class="sup-dialog__actions">
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-preview-close>Cerrar</button>
      </div>
    </div>`;
}

function openPostpone(orderId, orderNumber) {
  state.form = { orderId, orderNumber, until: '', reason: '', note: '', error: '' };
  renderPostpone();
}

function renderPostpone() {
  const host = document.getElementById('sup-postpone');
  if (!host) return;
  const form = state.form;
  if (!form) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  host.hidden = false;
  host.innerHTML = `
    <div class="sup-dialog__back" data-sup-postpone-cancel></div>
    <form class="sup-dialog" data-sup-postpone-form>
      <h3>Posponer ${esc(form.orderNumber)}</h3>
      <p class="sup-dialog__hint">El pedido conserva su estado y su pago. Los recordatorios se pausan hasta la fecha indicada.</p>
      <label class="sup-field"><span>Nueva fecha</span>
        <input type="date" name="until" value="${esc(form.until || tomorrow)}" required>
      </label>
      <label class="sup-field"><span>Motivo</span>
        <input type="text" name="reason" maxlength="200" placeholder="Cliente no está, falta producto…" value="${esc(form.reason)}" required>
      </label>
      <label class="sup-field"><span>Comentario (opcional)</span>
        <input type="text" name="note" maxlength="400" value="${esc(form.note)}">
      </label>
      ${form.error ? `<p class="sup-dialog__error">${esc(form.error)}</p>` : ''}
      <div class="sup-dialog__actions">
        <button class="sup-btn sup-btn--ghost" type="button" data-sup-postpone-cancel>Cancelar</button>
        <button class="sup-btn" type="submit" ${state.busy === 'postpone' ? 'disabled' : ''}>${state.busy === 'postpone' ? 'Guardando…' : 'Posponer'}</button>
      </div>
    </form>`;
}

async function submitPostpone(form) {
  if (!state.form || state.busy) return;
  state.busy = 'postpone';
  const data = new FormData(form);
  try {
    await api(`/api/admin/orders/${encodeURIComponent(state.form.orderId)}/delivery/postpone`, {
      method: 'POST',
      body: JSON.stringify({ until: data.get('until'), reason: data.get('reason'), note: data.get('note') }),
    });
    state.form = null;
    state.busy = '';
    renderPostpone();
    toast('Entrega pospuesta');
    await load();
  } catch (error) {
    state.busy = '';
    state.form.error = error.message;
    renderPostpone();
  }
}

/* ------------------------------------------------------------- eventos */

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-sup-refresh]')) return void load();
  if (target.closest('[data-sup-preview]')) return void openPreview();
  if (target.closest('[data-sup-preview-close]')) {
    state.preview = null;
    renderPreview();
    return;
  }
  if (target.closest('[data-sup-run]')) return void runNow();
  if (target.closest('[data-sup-daily]')) return void dailySummary();
  if (target.closest('[data-sup-save-settings]')) return void saveSettings();
  /*
   * ENLACE CONTEXTUAL AL CENTRO IA: abre el ticket de ESTE pedido (si existe).
   * El supervisor no duplica la conversación: solo lleva a ella.
   */
  const centro = target.closest('[data-sup-centro]');
  if (centro) {
    window.dispatchEvent(
      new CustomEvent('fulltech:navigate', { detail: { tab: 'ops', orderId: centro.dataset.supCentro } }),
    );
    return;
  }
  const bucket = target.closest('[data-sup-bucket]');
  if (bucket) {
    state.bucket = bucket.dataset.supBucket;
    render();
    return;
  }
  const postpone = target.closest('[data-sup-postpone]');
  if (postpone) {
    openPostpone(postpone.dataset.supPostpone, postpone.dataset.supNumber ?? 'pedido');
    return;
  }
  const include = target.closest('[data-sup-include]');
  if (include) {
    includeInFollowUp(include.dataset.supInclude);
    return;
  }
  if (target.closest('[data-sup-postpone-cancel]')) {
    state.form = null;
    renderPostpone();
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form || !form.matches('[data-sup-postpone-form]')) return;
  event.preventDefault();
  submitPostpone(form).catch(() => {});
});

window.addEventListener('fulltech:tab', (event) => {
  const tab = event.detail?.tab ?? '';
  state.tab = tab;
  if (tab === 'supervisor') load().catch(() => {});
});

/** Enlace directo / recarga: no llega `fulltech:tab`, se mira la vista activa. */
function bootFromCurrentTab() {
  const active = document.querySelector('.view:not([hidden])')?.id ?? '';
  if (active === 'view-supervisor') load().catch(() => {});
}

/*
 * TIEMPO REAL.
 * El supervisor es una foto de lo que el motor ya decidió: si un pedido cambia
 * (asignación, entrega, posposición, cobro) o el motor corre, la foto se vuelve
 * a pedir. Solo cuando la pantalla está abierta: fuera de ella no se gasta red.
 */
let vivoTimer = null;
window.addEventListener('fulltech:crm-event', (event) => {
  const tipo = String(event.detail?.type ?? '');
  const interesa =
    tipo === 'supervisor.changed' ||
    tipo === 'order.assigned' ||
    tipo === 'delivery.started' ||
    tipo === 'delivery.completed' ||
    tipo === 'delivery.postponed' ||
    tipo === 'delivery.issue' ||
    tipo === 'order.status_changed';
  if (!interesa || document.body.dataset.tab !== 'supervisor') return;
  if (vivoTimer) clearTimeout(vivoTimer);
  vivoTimer = setTimeout(() => {
    vivoTimer = null;
    load().catch(() => {});
  }, 400);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFromCurrentTab, { once: true });
else setTimeout(bootFromCurrentTab, 0);
