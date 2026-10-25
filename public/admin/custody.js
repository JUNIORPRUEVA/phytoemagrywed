/*
 * CUSTODIA Y RENDICIONES — versión compacta.
 *
 * Datos reales del backend: /api/admin/delivery-cash (saldos),
 * /delivery-cash/movements (libro append-only) e /delivery-cash/incidents
 * (conciliación de solo lectura). La única escritura es la rendición, que hace
 * el endpoint existente (idempotente, permiso admin.full, sin sobre-rendir).
 *
 * El efectivo DECLARADO no se presenta como verificado: la columna «Efectivo» es
 * lo que el repartidor declaró y se cargó en el libro.
 */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) => `RD$${(Number(cents || 0) / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const api = async (path, body) => {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(data.message || data.error || 'No disponible'), { status: response.status });
  return data;
};

const state = { couriers: [], movements: [], incidents: [], totals: {}, selected: null };
const notice = (text) => { $('#status').textContent = text; };

/* Pedidos cobrados por repartidor: se cuentan desde los cargos del libro. */
function ordersByCourier() {
  const map = new Map();
  for (const row of state.movements) {
    if (String(row.kind) !== 'charge' || !row.order_id) continue;
    const key = String(row.courier_account_id ?? '');
    map.set(key, (map.get(key) ?? new Set()).add(row.order_id));
  }
  return map;
}

function card(label, value, warn = false) {
  return `<div class="card${warn ? ' warn' : ''}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
}

function renderCards() {
  const totals = state.totals;
  const withBalance = state.couriers.filter((row) => Number(row.pending_cents) > 0).length;
  $('#cards').innerHTML = [
    card('Bajo custodia', money(totals.chargedCents)),
    card('Pendiente de rendir', money(totals.pendingCents), Number(totals.pendingCents) > 0),
    card('Rendido', money(totals.remittedCents)),
    card('Con saldo', String(withBalance)),
    card('Incidencias', String(state.incidents.length), state.incidents.length > 0),
  ].join('');
}

function tagFor(row) {
  if (Number(row.pending_cents) < 0) return '<span class="tag warn">Sobrerrendido</span>';
  if (Number(row.pending_cents) > 0) return '<span class="tag warn">Pendiente</span>';
  if (Number(row.charged_cents) > 0) return '<span class="tag ok">Conciliado</span>';
  return '<span class="tag none">Sin movimientos</span>';
}

function renderTable() {
  const term = $('#search').value.trim().toLowerCase();
  const filter = $('#filter').value;
  const orders = ordersByCourier();
  const rows = state.couriers.filter((row) => {
    if (term && !`${row.courier_name ?? ''} ${row.courier_id ?? ''}`.toLowerCase().includes(term)) return false;
    if (filter === 'pending') return Number(row.pending_cents) > 0;
    if (filter === 'settled') return Number(row.charged_cents) > 0 && Number(row.pending_cents) === 0;
    if (filter === 'risk') return Number(row.pending_cents) < 0;
    return true;
  });
  if (!rows.length) {
    $('#couriers').innerHTML = '<tr><td colspan="7" class="empty">No hay repartidores con movimientos de custodia.</td></tr>';
    return;
  }
  $('#couriers').innerHTML = rows.map((row) => {
    const count = orders.get(String(row.courier_id))?.size ?? 0;
    return `<tr data-courier="${esc(row.courier_id)}">
      <td class="who"><b>${esc(row.courier_name || row.courier_id)}</b><span>${esc(String(row.kind ?? '').toLowerCase() === 'internal' ? 'Interno' : 'Externo')}</span></td>
      <td class="hide">${count}</td>
      <td class="num">${money(row.charged_cents)}</td>
      <td class="num hide">${money(row.remitted_cents)}</td>
      <td class="num"><strong>${money(row.pending_cents)}</strong></td>
      <td>${tagFor(row)}</td>
      <td class="act"><button class="ghost" type="button" data-open="${esc(row.courier_id)}">Ver</button></td>
    </tr>`;
  }).join('');
}

function renderIncidents() {
  if (!state.incidents.length) {
    $('#incidents').innerHTML = '<h2>Incidencias de conciliación</h2><div class="item"><b>Sin discrepancias</b><p>Los pedidos entregados con efectivo cuadran con el libro de custodia.</p></div>';
    return;
  }
  $('#incidents').innerHTML = `<h2>Incidencias de conciliación (${state.incidents.length})</h2>` + state.incidents.map((row) => `
    <div class="item">
      <b>${esc(row.type)}</b> · ${money(row.amountCents)}
      <p>${row.orderId ? `Pedido <code>${esc(row.orderId)}</code>` : row.courierId ? `Repartidor <code>${esc(row.courierId)}</code>` : 'Sin referencia'} · ${esc(row.action)}</p>
    </div>`).join('');
}

function renderDrawer() {
  const row = state.selected;
  if (!row) return;
  $('#d-name').textContent = row.courier_name || row.courier_id;
  $('#d-totals').innerHTML = [
    ['Efectivo cargado', money(row.charged_cents)],
    ['Rendido', money(row.remitted_cents)],
    ['Saldo pendiente', money(row.pending_cents)],
  ].map(([label, value]) => `<div class="row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  const movements = state.movements.filter((m) => String(m.courier_account_id) === String(row.courier_id)).slice().reverse();
  $('#d-movements').innerHTML = movements.length
    ? movements.map((m) => `<div class="row"><span>${esc(m.kind)}${m.order_id ? ` · <code>${esc(m.order_id)}</code>` : ''}<br><small>${esc(new Date(m.created_at).toLocaleString('es-DO'))}${m.note ? ` · ${esc(m.note)}` : ''}</small></span><b>${money(m.amount_cents)}</b></div>`).join('')
    : '<p class="hint">Sin movimientos.</p>';

  $('#r-preview').textContent = `Saldo pendiente: ${money(row.pending_cents)} · Nuevo saldo: ${money(row.pending_cents)}`;
  $('#r-result').textContent = '';
  $('#drawer').setAttribute('open', '');
}

async function load() {
  try {
    const [cash, movements, incidents] = await Promise.all([
      api('/api/admin/delivery-cash'),
      api('/api/admin/delivery-cash/movements'),
      api('/api/admin/delivery-cash/incidents').catch(() => ({ incidents: [] })),
    ]);
    state.couriers = cash.couriers ?? [];
    state.movements = movements.movements ?? [];
    state.incidents = incidents.incidents ?? [];
    /* Los totales salen del libro, no de la suma de la tabla: es el mismo número que audita el backend. */
    state.totals = incidents.totals ?? {
      chargedCents: state.couriers.reduce((sum, row) => sum + Number(row.charged_cents ?? 0), 0),
      remittedCents: state.couriers.reduce((sum, row) => sum + Number(row.remitted_cents ?? 0), 0),
      pendingCents: state.couriers.reduce((sum, row) => sum + Number(row.pending_cents ?? 0), 0),
    };
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    renderCards();
    renderTable();
    renderIncidents();
    $('#updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-DO')}`;
    notice('Custodia actualizada.');
    if (state.selected) {
      state.selected = state.couriers.find((row) => row.courier_id === state.selected.courier_id) ?? null;
      if (state.selected) renderDrawer();
    }
  } catch (error) {
    notice(error.message);
    if (error.status === 401 || error.status === 403) {
      $('#login').hidden = false;
      $('#workspace').hidden = true;
    }
  }
}

$('#login').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/login', { username: event.target.username.value, password: event.target.password.value });
    event.target.password.value = '';
    await load();
  } catch (error) { notice(error.message); }
};
$('#refresh').onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await load(); } finally { button.disabled = false; }
};
$('#search').oninput = renderTable;
$('#filter').onchange = renderTable;
$('#couriers').addEventListener('click', (event) => {
  const id = event.target.closest('[data-courier]')?.dataset.courier;
  if (!id) return;
  state.selected = state.couriers.find((row) => String(row.courier_id) === id) ?? null;
  renderDrawer();
});
$('#d-close').onclick = () => cerrarCajon();
/*
 * EL CAJÓN SE CIERRA COMO CUALQUIER OTRO DEL PANEL: con Escape y tocando fuera.
 * Antes solo se cerraba con el botón, que en el teléfono queda lejos del pulgar.
 */
function cerrarCajon() {
  $('#drawer').removeAttribute('open');
}
$('#drawer').addEventListener('click', (event) => {
  if (event.target === $('#drawer')) cerrarCajon();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#drawer').hasAttribute('open')) cerrarCajon();
});
$('#remittance').addEventListener('input', () => {
  const row = state.selected;
  if (!row) return;
  const raw = String($('#remittance').elements.amount.value || '').replace(',', '.').trim();
  const cents = /^\d{1,9}(\.\d{1,2})?$/.test(raw) ? Math.round(Number(raw) * 100) : null;
  const pending = Number(row.pending_cents || 0);
  $('#r-preview').textContent = cents === null
    ? `Saldo pendiente: ${money(pending)} · Escribe un monto válido (máx. 2 decimales).`
    : `Saldo pendiente: ${money(pending)} · Nuevo saldo: ${money(pending - cents)}`;
});
$('#remittance').onsubmit = async (event) => {
  event.preventDefault();
  const row = state.selected;
  if (!row) return;
  const form = event.target;
  const button = form.querySelector('button[type=submit]');
  const raw = String(form.elements.amount.value || '').replace(',', '.').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
    $('#r-result').textContent = 'Escribe un monto mayor que cero, con hasta dos decimales.';
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/api/admin/delivery-cash/remittance', {
      courierAccountId: row.courier_id,
      amountCents: Math.round(Number(raw) * 100),
      note: form.elements.note.value.trim() || undefined,
    });
    form.elements.amount.value = '';
    form.elements.note.value = '';
    $('#r-result').textContent = `Rendición registrada. Saldo anterior ${money(row.pending_cents)} · nuevo ${money(result.pending_cents ?? 0)}.`;
    await load();
  } catch (error) {
    $('#r-result').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

await load();
