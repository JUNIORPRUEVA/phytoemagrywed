/*
 * CUSTODIA Y RENDICIONES — panel administrativo (dato real, sin maqueta).
 *
 * Reglas que esta pantalla respeta:
 *  - El servidor es la autoridad: los saldos vienen de /api/admin/delivery-cash,
 *    el historial del libro append-only y las incidencias de la conciliación.
 *  - No se corrige dinero aquí. Rendir es lo único que escribe, y lo hace el
 *    endpoint ya existente (idempotente y con permiso admin.full).
 *  - El efectivo DECLARADO por el repartidor no se presenta como verificado.
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

let state = { couriers: [], incidents: [], movements: [], selected: null };

function notice(text) { $('#status').textContent = text; }

function renderMetrics(data) {
  const totals = data.totals ?? {};
  const cards = [
    ['Bajo custodia', money(totals.chargedCents)],
    ['Pendiente de rendir', money(totals.pendingCents)],
    ['Rendido', money(totals.remittedCents)],
    ['Repartidores con saldo', String((data.couriers ?? []).filter((row) => row.pending_cents > 0).length)],
    ['Cobros sin cargo', money(totals.declaredWithoutChargeCents)],
    ['Incidencias', String((data.incidents ?? []).length)],
  ];
  $('#metrics').innerHTML = cards.map(([label, value], index) =>
    `<div class="metric${index === 5 && Number(value) > 0 ? ' metric--warn' : ''}"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
}

function badge(row) {
  if (row.pending_cents < 0) return '<span class="badge badge--warn">Sobrerrendido</span>';
  if (row.pending_cents > 0) return '<span class="badge badge--warn">Pendiente</span>';
  if (row.charged_cents > 0 && row.pending_cents === 0) return '<span class="badge badge--ok">Conciliado</span>';
  return '<span class="badge">Sin movimientos</span>';
}

function renderCouriers() {
  const term = $('#search').value.trim().toLowerCase();
  const filter = $('#filter').value;
  const rows = state.couriers.filter((row) => {
    if (term && !`${row.courier_name ?? ''} ${row.courier_id ?? ''}`.toLowerCase().includes(term)) return false;
    if (filter === 'pending') return row.pending_cents > 0;
    if (filter === 'settled') return row.pending_cents === 0;
    if (filter === 'risk') return row.pending_cents < 0;
    return true;
  });
  if (!rows.length) {
    $('#couriers').innerHTML = '<tr><td colspan="6" class="muted">No hay repartidores con movimientos de custodia.</td></tr>';
    return;
  }
  $('#couriers').innerHTML = rows.map((row) => `
    <tr data-courier="${esc(row.courier_id)}">
      <td><strong>${esc(row.courier_name || row.courier_id)}</strong><br><span class="muted">${esc(row.courier_id)}</span></td>
      <td>${esc(String(row.kind ?? '').toLowerCase() === 'internal' ? 'Interno' : row.kind ?? '—')}</td>
      <td class="num">${money(row.charged_cents)}</td>
      <td class="num">${money(row.remitted_cents)}</td>
      <td class="num"><strong>${money(row.pending_cents)}</strong></td>
      <td>${badge(row)}</td>
    </tr>`).join('');
}

function renderIncidents() {
  if (!state.incidents.length) {
    $('#incidents').innerHTML = '<p class="muted">Sin discrepancias entre pedidos entregados y el libro de custodia.</p>';
    return;
  }
  $('#incidents').innerHTML = state.incidents.map((row) => `
    <article>
      <span class="type">${esc(row.type)}</span>
      <div class="muted">${row.orderId ? `Pedido <code>${esc(row.orderId)}</code>` : row.courierId ? `Repartidor <code>${esc(row.courierId)}</code>` : 'Sin referencia'} · ${money(row.amountCents)}</div>
      <p class="action">${esc(row.action)}</p>
    </article>`).join('');
}

function renderDetail() {
  const row = state.selected;
  if (!row) return;
  $('#detail-name').textContent = row.courier_name || row.courier_id;
  $('#detail-meta').textContent = `${row.courier_id} · ${String(row.kind ?? '').toLowerCase() === 'internal' ? 'interno' : row.kind ?? '—'}`;
  $('#detail-totals').innerHTML = [
    ['Cargado', money(row.charged_cents)],
    ['Rendido', money(row.remitted_cents)],
    ['Saldo pendiente', money(row.pending_cents)],
  ].map(([label, value]) => `<div class="row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');

  const movements = state.movements.filter((m) => String(m.courier_account_id) === String(row.courier_id));
  $('#detail-movements').innerHTML = movements.length
    ? movements.slice().reverse().map((m) => `
      <div class="row"><span>${esc(m.kind)}${m.order_id ? ` · <code>${esc(m.order_id)}</code>` : ''}<br><span class="muted">${esc(new Date(m.created_at).toLocaleString('es-DO'))}${m.note ? ` · ${esc(m.note)}` : ''}</span></span><strong>${money(m.amount_cents)}</strong></div>`).join('')
    : '<p class="muted">Sin movimientos.</p>';

  const pending = Number(row.pending_cents || 0);
  $('#remittance-preview').textContent = `Saldo pendiente: ${money(pending)} · Nuevo saldo: ${money(pending)}`;
  $('#detail').setAttribute('open', '');
}

async function load() {
  try {
    const [cash, movements, incidents] = await Promise.all([
      api('/api/admin/delivery-cash'),
      api('/api/admin/delivery-cash/movements'),
      api('/api/admin/delivery-cash/incidents').catch(() => ({ incidents: [], totals: {} })),
    ]);
    state.couriers = cash.couriers ?? [];
    state.movements = movements.movements ?? [];
    state.incidents = incidents.incidents ?? [];
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    renderMetrics({ ...cash, incidents: state.incidents });
    renderCouriers();
    renderIncidents();
    $('#updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-DO')}`;
    notice('Custodia actualizada.');
    if (state.selected) {
      state.selected = state.couriers.find((row) => row.courier_id === state.selected.courier_id) ?? null;
      if (state.selected) renderDetail();
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
$('#refresh').onclick = load;
$('#search').oninput = renderCouriers;
$('#filter').onchange = renderCouriers;
$('#couriers').addEventListener('click', (event) => {
  const tr = event.target.closest('[data-courier]');
  if (!tr) return;
  state.selected = state.couriers.find((row) => String(row.courier_id) === tr.dataset.courier) ?? null;
  renderDetail();
});
$('#close-detail').onclick = () => $('#detail').removeAttribute('open');
$('#remittance').addEventListener('input', () => {
  const row = state.selected;
  if (!row) return;
  const raw = String($('#remittance').elements.amount.value || '').replace(',', '.').trim();
  const cents = /^\d{1,9}(\.\d{1,2})?$/.test(raw) ? Math.round(Number(raw) * 100) : null;
  const pending = Number(row.pending_cents || 0);
  $('#remittance-preview').textContent = cents === null
    ? `Saldo pendiente: ${money(pending)} · Escribe un monto válido (hasta 2 decimales).`
    : `Saldo pendiente: ${money(pending)} · Nuevo saldo: ${money(pending - cents)}`;
});
$('#remittance').onsubmit = async (event) => {
  event.preventDefault();
  const row = state.selected;
  if (!row) return;
  const form = event.target;
  const button = form.querySelector('button[type=submit]');
  const raw = String(form.elements.amount.value || '').replace(',', '.').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) {
    $('#remittance-result').textContent = 'Escribe un monto con hasta dos decimales.';
    return;
  }
  const amountCents = Math.round(Number(raw) * 100);
  if (amountCents <= 0) {
    $('#remittance-result').textContent = 'El monto debe ser mayor que cero.';
    return;
  }
  const pending = Number(row.pending_cents || 0);
  /* Doble pulsación: el botón se bloquea y el servidor valida otra vez. */
  button.disabled = true;
  try {
    const result = await api('/api/admin/delivery-cash/remittance', {
      courierAccountId: row.courier_id,
      amountCents,
      note: form.elements.note.value.trim() || undefined,
    });
    form.elements.amount.value = '';
    form.elements.note.value = '';
    $('#remittance-result').textContent =
      `Rendición registrada. Saldo anterior ${money(pending)} · nuevo saldo ${money(result.pending_cents ?? pending - amountCents)}.`;
    await load();
  } catch (error) {
    $('#remittance-result').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

await load();
