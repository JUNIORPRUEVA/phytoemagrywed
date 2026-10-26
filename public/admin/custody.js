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

const state = { couriers: [], movements: [], incidents: [], totals: {}, selected: null,
  unresolved: [], resolutions: [], reconciliationVisible: false, companies: [] };
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

/*
 * CONCILIACIÓN: solo lectura del libro + registro de la revisión.
 *
 * La tabla de movimientos sin empresa sale del reporte del backend; aquí no se
 * calcula ni se supone nada. «Revisar» pide justificación y evidencia y llama al
 * endpoint, que guarda la resolución en un registro aparte y deja el bloqueo.
 */
function renderReconciliation() {
  const section = $('#reconciliation');
  if (!state.reconciliationVisible) { section.hidden = true; return; }
  section.hidden = false;
  const nameOf = (id) => state.companies.find((row) => row.id === id)?.name ?? id ?? '—';
  if (!state.unresolved.length) {
    $('#unresolved').innerHTML = '<tr><td colspan="6" class="empty">No hay movimientos ambiguos pendientes.</td></tr>';
  } else {
    $('#unresolved').innerHTML = state.unresolved.map((row) => `
      <tr>
        <td class="who"><b>${esc(row.courier_account_id || 'Sin cuenta')}</b><span>${esc(row.kind ?? '')}</span></td>
        <td class="hide">${esc(row.order_id || '—')}</td>
        <td>${esc(row.kind ?? '—')}</td>
        <td class="num">${money(row.amount_cents)}</td>
        <td><span class="tag warn">Sin empresa</span></td>
        <td class="act"><button class="ghost" type="button" data-review="${esc(row.id)}">Revisar</button></td>
      </tr>`).join('');
  }
  if (!state.resolutions.length) {
    $('#resolutions').innerHTML = '<tr><td colspan="5" class="empty">Sin resoluciones registradas.</td></tr>';
  } else {
    $('#resolutions').innerHTML = state.resolutions.map((row) => `
      <tr>
        <td class="who"><b>${esc(String(row.movement_id).slice(0, 14))}</b><span>${esc(new Date(row.created_at).toLocaleString('es-DO'))}</span></td>
        <td>${row.company_id ? esc(nameOf(row.company_id)) : '<span class="hint">Sin empresa propuesta</span>'}</td>
        <td>${esc(row.justification ?? '')}${row.evidence_reference ? `<br><small>Evidencia: ${esc(row.evidence_reference)}</small>` : ''}</td>
        <td>${esc(row.created_by_display_name || row.created_by_user_id || '—')}</td>
        <td><span class="tag warn">Pendiente de autorización</span></td>
      </tr>`).join('');
  }
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
    const [cash, movements, incidents, reconciliation, resolutions, companies] = await Promise.all([
      api('/api/admin/delivery-cash'),
      api('/api/admin/delivery-cash/movements'),
      api('/api/admin/delivery-cash/incidents').catch(() => ({ incidents: [] })),
      api('/api/admin/delivery-cash/reconciliation').catch(() => null),
      api('/api/admin/delivery-cash/resolutions').catch(() => null),
      api('/api/admin/logistics/companies').catch(() => null),
    ]);
    state.couriers = cash.couriers ?? [];
    state.movements = movements.movements ?? [];
    state.incidents = incidents.incidents ?? [];
    state.reconciliationVisible = Boolean(reconciliation && resolutions);
    state.unresolved = reconciliation?.unresolved_movements ?? [];
    state.resolutions = resolutions?.resolutions ?? [];
    state.companies = (companies?.companies ?? []).filter((row) => row.active !== false);
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
    renderReconciliation();
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
$('#refresh').onclick = load;
$('#search').oninput = renderTable;
$('#filter').onchange = renderTable;
$('#couriers').addEventListener('click', (event) => {
  const id = event.target.closest('[data-courier]')?.dataset.courier;
  if (!id) return;
  state.selected = state.couriers.find((row) => String(row.courier_id) === id) ?? null;
  renderDrawer();
});
$('#d-close').onclick = () => $('#drawer').removeAttribute('open');

/*
 * REGISTRAR LA REVISIÓN DE UN MOVIMIENTO AMBIGUO.
 *
 * La justificación es obligatoria (lo exige el backend) y no se toca ningún
 * importe: la resolución queda como propuesta pendiente de autorización.
 */
$('#unresolved').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-review]')?.dataset.review;
  if (!id) return;
  const justification = window.prompt('¿Con qué evidencia se concluye la empresa de este movimiento? (obligatorio)');
  if (!justification || justification.trim().length < 10) return;
  const evidence = window.prompt('Referencia de la evidencia (pedido, comprobante, nota). Opcional:') ?? '';
  const opciones = ['(sin empresa propuesta)', ...state.companies.map((row) => row.name ?? row.id)];
  const elegida = window.prompt(`Empresa propuesta (número):\n${opciones.map((name, index) => `${index} · ${name}`).join('\n')}`);
  const index = Number(elegida);
  const companyId = Number.isInteger(index) && index > 0 ? state.companies[index - 1]?.id : null;
  try {
    await api('/api/admin/delivery-cash/resolutions', { movementId: id,
      companyId: companyId ?? undefined, justification: justification.trim(), evidence: evidence.trim() || undefined });
    notice('Resolución registrada. La custodia sigue bloqueada hasta autorización explícita.');
    await load();
  } catch (error) {
    notice(error.status === 409 ? 'Ese movimiento ya tiene una resolución registrada.' : error.message);
  }
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
