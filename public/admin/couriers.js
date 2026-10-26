/*
 * REPARTIDORES — solicitudes de ingreso y empresas autorizadas.
 *
 * Todo lo que se pinta sale del backend UAT: `/api/admin/courier-applications`,
 * `/api/admin/couriers` y `/api/admin/couriers/:id/companies`. El panel NO
 * decide permisos: aprobar una solicitud no crea cuenta y conceder una empresa
 * es una llamada aparte (auditada). Si el backend dice 403/404, se muestra tal
 * cual; no se inventan datos para «que se vea bien».
 */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, body, method) => {
  const response = await fetch(path, {
    method: method ?? (body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(data.message || data.error || 'No disponible'), { status: response.status });
  return data;
};

const LABEL = { pending: 'Pendiente', info_required: 'Requiere información', approved: 'Aprobada', rejected: 'Rechazada' };
const TAG = { pending: 'warn', info_required: 'warn', approved: 'ok', rejected: 'bad' };
const VEHICLE = { MOTO: 'Moto', CARRO: 'Carro', BICICLETA: 'Bicicleta', A_PIE: 'A pie' };

const state = { applications: [], couriers: [], companies: [], users: [], selecting: null };
const notice = (text) => { $('#status').textContent = text; };

/** El teléfono se muestra parcial: el panel no necesita el número completo para decidir. */
const maskPhone = (value) => {
  const raw = String(value ?? '');
  if (raw.length < 6) return raw;
  return `${raw.slice(0, 4)}•••${raw.slice(-3)}`;
};
const when = (value) => (value ? new Date(value).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function card(label, value, warn = false) {
  return `<div class="card${warn ? ' warn' : ''}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
}

function renderCards() {
  const count = (status) => state.applications.filter((row) => row.status === status).length;
  const active = state.couriers.filter((row) => row.active !== false && row.app_access === true).length;
  const multi = state.couriers.filter((row) => (row.companies ?? []).length > 1).length;
  $('#cards').innerHTML = [
    card('Pendientes', String(count('pending')), count('pending') > 0),
    card('Requiere información', String(count('info_required')), count('info_required') > 0),
    card('Aprobadas', String(count('approved'))),
    card('Con acceso a la app', String(active)),
    card('Multiempresa', String(multi)),
  ].join('');
}

function renderCompanyFilter() {
  const select = $('#company');
  const current = select.value;
  select.innerHTML = ['<option value="">Todas las empresas</option>']
    .concat(state.companies.map((row) => `<option value="${esc(row.id)}">${esc(row.name ?? row.id)}</option>`))
    .join('');
  if (current) select.value = current;
}

function renderUsers() {
  const section = $('#users-section');
  if (!state.users.length) { section.hidden = true; return; }
  section.hidden = false;
  const nameOf = (id) => state.companies.find((row) => row.id === id)?.name ?? id;
  $('#users').innerHTML = state.users.map((row) => {
    const companies = row.companies ?? [];
    const chips = companies.length
      ? companies.map((id) => `<span class="chip">${esc(nameOf(id))}</span>`).join('')
      : '<span class="hint">PHYTOEMAGRY (por defecto)</span>';
    return `<tr>
      <td class="who"><b>${esc(row.display_name || row.username || row.id)}</b><span>${esc(row.username ?? '')}</span></td>
      <td class="hide-sm">${esc(row.role ?? '—')}</td>
      <td><div class="chips">${chips}</div></td>
      <td class="act"><button class="ghost" type="button" data-user="${esc(row.id)}">Empresas</button></td>
    </tr>`;
  }).join('');
}

function renderApplications() {
  const term = $('#search').value.trim().toLowerCase();
  const filter = $('#filter').value;
  const company = $('#company').value;
  const rows = state.applications.filter((row) => {
    if (filter && row.status !== filter) return false;
    if (company && row.company_id !== company) return false;
    if (term && !`${row.display_name ?? ''} ${row.phone_e164 ?? ''} ${row.zone ?? ''}`.toLowerCase().includes(term)) return false;
    return true;
  });
  rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  if (!rows.length) {
    $('#apps').innerHTML = '<tr><td colspan="7" class="empty">No hay solicitudes con ese filtro.</td></tr>';
    return;
  }
  const nameOf = (id) => state.companies.find((row) => row.id === id)?.name ?? id;
  $('#apps').innerHTML = rows.map((row) => `<tr>
    <td class="who"><b>${esc(row.display_name ?? 'Sin nombre')}</b><span>${esc(maskPhone(row.phone_e164))}</span></td>
    <td class="hide-sm">${esc(VEHICLE[row.vehicle_type] ?? row.vehicle_type ?? '—')}</td>
    <td class="hide-sm">${esc(row.zone ?? '—')}</td>
    <td>${esc(nameOf(row.company_id))}</td>
    <td class="hide-sm">${esc(when(row.created_at))}</td>
    <td><span class="tag ${TAG[row.status] ?? 'none'}">${esc(LABEL[row.status] ?? row.status)}</span></td>
    <td class="act"><button class="ghost" type="button" data-app="${esc(row.id)}">Abrir</button></td>
  </tr>`).join('');
}

function renderCouriers() {
  if (!state.couriers.length) {
    $('#couriers').innerHTML = '<tr><td colspan="6" class="empty">Todavía no hay cuentas de reparto.</td></tr>';
    return;
  }
  const nameOf = (id) => state.companies.find((row) => row.id === id)?.name ?? id;
  $('#couriers').innerHTML = state.couriers.map((row) => {
    const companies = row.companies ?? [];
    const chips = companies.length
      ? companies.map((id) => `<span class="chip">${esc(nameOf(id))}</span>`).join('')
      : '<span class="hint">Sin empresa concedida</span>';
    const status = row.active === false
      ? '<span class="tag bad">Suspendido</span>'
      : row.app_access !== true ? '<span class="tag none">Sin acceso</span>' : '<span class="tag ok">Activo</span>';
    return `<tr>
      <td class="who"><b>${esc(row.display_name ?? row.id)}</b><span>${esc(maskPhone(row.phone))}</span></td>
      <td class="hide-sm">${esc(String(row.kind ?? '').toLowerCase() === 'internal' ? 'Interno' : 'Externo')}</td>
      <td class="hide-sm">${esc(maskPhone(row.phone))}</td>
      <td><div class="chips">${chips}</div></td>
      <td>${status}</td>
      <td class="act"><button class="ghost" type="button" data-courier="${esc(row.id)}">Empresas</button></td>
    </tr>`;
  }).join('');
}

function openDrawer(title) {
  $('#d-title').textContent = title;
  $('#drawer').setAttribute('open', '');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  $('#drawer').removeAttribute('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  state.selecting = null;
}

/** Detalle de una solicitud, con las acciones que el backend permite de verdad. */
function openApplication(id) {
  const row = state.applications.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'application', id };
  const nameOf = (value) => state.companies.find((item) => item.id === value)?.name ?? value;
  $('#d-body').innerHTML = `
    <div class="row"><span>Nombre</span><b>${esc(row.display_name ?? '—')}</b></div>
    <div class="row"><span>Teléfono</span><b>${esc(maskPhone(row.phone_e164))}</b></div>
    <div class="row"><span>Vehículo</span><b>${esc(VEHICLE[row.vehicle_type] ?? row.vehicle_type ?? '—')}</b></div>
    <div class="row"><span>Zona</span><b>${esc(row.zone ?? '—')}</b></div>
    <div class="row"><span>Empresa solicitada</span><b>${esc(nameOf(row.company_id))}</b></div>
    <div class="row"><span>Enviada</span><b>${esc(when(row.created_at))}</b></div>
    <div class="row"><span>Estado</span><b>${esc(LABEL[row.status] ?? row.status)}</b></div>
    <div class="row"><span>Condiciones aceptadas</span><b>${esc(when(row.terms_accepted_at))}</b></div>
    ${row.review_note ? `<div class="row"><span>Nota de revisión</span><b>${esc(row.review_note)}</b></div>` : ''}
    ${profileBlock(row)}
    <div id="d-documents"><p class="hint">Cargando expediente…</p></div>
    <p class="hint">Aprobar la solicitud NO crea la cuenta ni concede acceso: el alta del acceso y las empresas autorizadas son pasos administrativos aparte.</p>
    <label class="hint" for="d-note">Motivo / nota (obligatorio al pedir información o rechazar)</label>
    <textarea id="d-note" maxlength="300"></textarea>`;
  const abierta = ['pending', 'info_required'].includes(row.status);
  $('#d-actions').innerHTML = abierta
    ? `<button class="ghost" type="button" data-act="info">Pedir información</button>
       <button type="button" data-act="approve">Aprobar</button>
       <button class="danger" type="button" data-act="reject">Rechazar</button>`
    : '<span class="hint">Solicitud cerrada. Solo lectura.</span>';
  openDrawer(row.display_name ?? 'Solicitud');
  void loadDocuments(id);
}

/*
 * PERFIL AMPLIADO: lo que el asistente del teléfono recogió, tal como llegó.
 *
 * Si la solicitud viene de un cliente antiguo, estos bloques no existen y no se
 * pinta nada: aquí no se inventan datos ni se completan huecos.
 */
function profileBlock(row) {
  const personal = row.profile ?? null;
  const vehicle = row.vehicle_detail ?? null;
  const availability = row.availability ?? null;
  const policy = row.policy ?? null;
  if (!personal && !vehicle && !availability && !policy) return '';
  const line = (label, value) => (value
    ? `<div class="row"><span>${esc(label)}</span><b>${esc(value)}</b></div>` : '');
  const idType = { CEDULA: 'Cédula', PASAPORTE: 'Pasaporte' };
  const personalRows = personal ? [
    line('Documento', [idType[personal.id_type] ?? personal.id_type, personal.id_number].filter(Boolean).join(' ')),
    line('Nacimiento', personal.birth_date),
    line('Correo', personal.email),
    line('Residencia', [personal.address, personal.municipality, personal.province].filter(Boolean).join(', ')),
    line('Contacto de emergencia', [personal.emergency_name, personal.emergency_phone].filter(Boolean).join(' · ')),
  ].join('') : '';
  const vehicleRows = vehicle ? [
    line('Marca / modelo', [vehicle.make, vehicle.model].filter(Boolean).join(' ')),
    line('Placa', vehicle.plate),
    line('Tipo de bicicleta', vehicle.bicycle_type),
  ].join('') : '';
  const availabilityRows = availability ? [
    line('Provincia de operación', availability.province),
    line('Municipio preferido', availability.municipality),
    line('Disponibilidad', availability.availability),
    line('Horario preferido', availability.schedule),
    line('Experiencia', availability.experience),
  ].join('') : '';
  const policyRow = policy && policy.version
    ? `<div class="row"><span>Normas aceptadas</span><b>${esc(policy.version)}</b></div>` : '';
  return `<h2>Datos del solicitante</h2>${personalRows}${vehicleRows}${availabilityRows}${policyRow}`;
}

const DOC_LABEL = {
  IDENTITY: 'Identidad', IDENTITY_BACK: 'Reverso del documento', DRIVING_LICENSE: 'Licencia',
  VEHICLE: 'Documento del vehículo', VEHICLE_PHOTO: 'Foto del vehículo', SELFIE: 'Selfie',
};
const DOC_TAG = { received: ['none', 'Recibido'], accepted: ['ok', 'Aceptado'], rejected: ['bad', 'Rechazado'], replacement: ['warn', 'Pedir otro'] };

/** Expediente del solicitante: lo que hay, lo que falta y la revisión de cada archivo. */
async function loadDocuments(applicationId) {
  const box = document.getElementById('d-documents');
  if (!box) return;
  try {
    const data = await api(`/api/admin/courier-applications/${encodeURIComponent(applicationId)}/documents`);
    const missing = data.missing ?? [];
    box.innerHTML = `
      <h2 style="margin:10px 0 4px">Documentos</h2>
      ${(data.documents ?? []).length ? data.documents.map((doc) => {
        const [tone, label] = DOC_TAG[doc.status] ?? ['none', doc.status];
        return `<div class="row">
          <span>${esc(DOC_LABEL[doc.kind] ?? doc.kind)}<br><small>${esc(when(doc.created_at))} · ${Math.round(Number(doc.bytes || 0) / 1024)} KB</small>
          ${doc.review_note ? `<small> · ${esc(doc.review_note)}</small>` : ''}</span>
          <b><span class="tag ${tone}">${esc(label)}</span></b>
        </div>
        <div style="display:flex;gap:6px;margin:4px 0 8px">
          <button class="ghost" type="button" data-doc="${esc(doc.id)}" data-decision="accepted">Aceptar</button>
          <button class="ghost" type="button" data-doc="${esc(doc.id)}" data-decision="replacement">Pedir otro</button>
          <button class="danger" type="button" data-doc="${esc(doc.id)}" data-decision="rejected">Rechazar</button>
          <a class="back" href="/api/admin/courier-documents/${esc(doc.id)}/file" target="_blank" rel="noopener">Ver</a>
        </div>`;
      }).join('') : '<p class="hint">Sin documentos todavía.</p>'}
      ${missing.length ? `<p class="hint">Falta: ${missing.map((kind) => esc(DOC_LABEL[kind] ?? kind)).join(' · ')}</p>` : '<p class="hint">Expediente completo.</p>'}`;
  } catch (error) {
    box.innerHTML = `<p class="hint">No se pudo leer el expediente: ${esc(error.message)}</p>`;
  }
}

/** Empresas de un repartidor: conceder y revocar, una llamada por cambio. */
async function openCourier(id) {
  const row = state.couriers.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'courier', id };
  openDrawer(row.display_name ?? 'Repartidor');
  $('#d-body').innerHTML = '<p class="hint">Cargando empresas…</p>';
  $('#d-actions').innerHTML = '';
  let grants = [];
  try {
    grants = (await api(`/api/admin/couriers/${encodeURIComponent(id)}/companies`)).companies ?? [];
  } catch (error) {
    $('#d-body').innerHTML = `<p class="hint">No se pudieron leer las concesiones: ${esc(error.message)}</p>`;
    return;
  }
  const byCompany = new Map(grants.map((grant) => [grant.company_id, grant]));
  $('#d-body').innerHTML = `
    <p class="hint">Cada empresa se concede por separado y queda auditada. Revocar corta el acceso en la siguiente petición de la app.</p>
    ${state.companies.map((company) => {
      const grant = byCompany.get(company.id);
      const active = grant?.active === true;
      return `<div class="row">
        <span>${esc(company.name ?? company.id)}<br><small>${active ? `Concedida ${esc(when(grant.updated_at))}` : 'Sin autorización'}</small></span>
        <b><button class="${active ? 'danger' : 'ghost'}" type="button"
          data-company="${esc(company.id)}" data-active="${active ? 'false' : 'true'}">${active ? 'Revocar' : 'Conceder'}</button></b>
      </div>`;
    }).join('')}`;
}

async function review(decision) {
  const selection = state.selecting;
  if (selection?.kind !== 'application') return;
  const application = state.applications.find((row) => row.id === selection.id);
  if (!application) return;
  const note = ($('#d-note')?.value ?? '').trim();
  if (decision !== 'approved' && !note) {
    notice('Escribe el motivo antes de continuar.');
    return;
  }
  notice('Guardando…');
  try {
    await api(`/api/admin/courier-applications/${encodeURIComponent(application.id)}/review`, {
      companyId: application.company_id, decision, note: note || undefined,
    });
    notice('Solicitud actualizada.');
    closeDrawer();
    await load();
  } catch (error) {
    notice(`No se pudo guardar: ${error.message}`);
  }
}

async function toggleCompany(companyId, active) {
  const selection = state.selecting;
  if (selection?.kind !== 'courier') return;
  notice('Guardando…');
  try {
    await api(`/api/admin/couriers/${encodeURIComponent(selection.id)}/companies`, { companyId, active });
    notice('Concesión actualizada.');
    await load();
    await openCourier(selection.id);
  } catch (error) {
    notice(`No se pudo cambiar: ${error.message}`);
  }
}

/** Revisión de un documento: aceptar, pedir otro o rechazar (con motivo). */
async function reviewDocument(documentId, decision) {
  const note = ($('#d-note')?.value ?? '').trim();
  if (decision !== 'accepted' && !note) {
    notice('Escribe el motivo en la nota antes de continuar.');
    return;
  }
  notice('Guardando…');
  try {
    await api(`/api/admin/courier-documents/${encodeURIComponent(documentId)}/review`,
      { decision, note: note || undefined });
    notice('Documento revisado.');
    if (state.selecting?.kind === 'application') await loadDocuments(state.selecting.id);
  } catch (error) {
    notice(`No se pudo revisar: ${error.message}`);
  }
}

/** Empresas que puede operar un usuario del CRM (solo lo ve la central). */
async function openUser(id) {
  const row = state.users.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'user', id };
  openDrawer(row.display_name || row.username || 'Usuario');
  $('#d-body').innerHTML = '<p class="hint">Cargando empresas…</p>';
  $('#d-actions').innerHTML = '';
  let grants = [];
  try {
    grants = (await api(`/api/admin/users/${encodeURIComponent(id)}/companies`)).companies ?? [];
  } catch (error) {
    $('#d-body').innerHTML = `<p class="hint">No se pudo leer el alcance: ${esc(error.message)}</p>`;
    return;
  }
  const byCompany = new Map(grants.map((grant) => [grant.company_id, grant]));
  $('#d-body').innerHTML = `
    <p class="hint">Sin filas, el usuario opera solo PHYTOEMAGRY. Al conceder una empresa, el cambio se aplica en su siguiente petición.</p>
    ${state.companies.map((company) => {
      const grant = byCompany.get(company.id);
      const active = grant?.active === true;
      return `<div class="row">
        <span>${esc(company.name ?? company.id)}<br><small>${active ? `Concedida ${esc(when(grant.updated_at))}` : 'Sin autorización'}</small></span>
        <b><button class="${active ? 'danger' : 'ghost'}" type="button"
          data-usercompany="${esc(company.id)}" data-active="${active ? 'false' : 'true'}">${active ? 'Revocar' : 'Conceder'}</button></b>
      </div>`;
    }).join('')}`;
}

async function toggleUserCompany(companyId, active) {
  const selection = state.selecting;
  if (selection?.kind !== 'user') return;
  notice('Guardando…');
  try {
    await api(`/api/admin/users/${encodeURIComponent(selection.id)}/companies`, { companyId, active });
    notice('Alcance actualizado.');
    await load();
    await openUser(selection.id);
  } catch (error) {
    notice(`No se pudo cambiar: ${error.message}`);
  }
}

async function load() {
  notice('Cargando…');
  try {
    const [applications, couriers, companies, users] = await Promise.all([
      api('/api/admin/courier-applications'),
      api('/api/admin/couriers').catch(() => ({ couriers: [] })),
      api('/api/admin/logistics/companies').catch(() => ({ companies: [] })),
      api('/api/admin/users').catch(() => ({ users: [] })),
    ]);
    state.applications = applications.applications ?? [];
    state.companies = (companies.companies ?? []).filter((row) => row.active !== false);
    const list = couriers.couriers ?? [];
    // Las empresas de cada repartidor se piden aparte: es dato real, no deducido.
    await Promise.all(list.map(async (row) => {
      try {
        const grants = await api(`/api/admin/couriers/${encodeURIComponent(row.id)}/companies`);
        row.companies = (grants.companies ?? []).filter((grant) => grant.active === true).map((grant) => grant.company_id);
      } catch {
        row.companies = row.company_id ? [row.company_id] : [];
      }
      return row;
    }));
    state.couriers = list;
    // Usuarios del CRM con su alcance (solo la central puede leerlo; si no, se oculta).
    const people = (users.users ?? []).filter((row) => row.active !== false);
    await Promise.all(people.map(async (row) => {
      try {
        const grants = await api(`/api/admin/users/${encodeURIComponent(row.id)}/companies`);
        row.companies = (grants.companies ?? []).filter((grant) => grant.active === true).map((grant) => grant.company_id);
      } catch {
        row.companies = [];
      }
      return row;
    }));
    state.users = people;
    renderCompanyFilter();
    renderCards();
    renderApplications();
    renderCouriers();
    renderUsers();
    notice(`Actualizado ${new Date().toLocaleTimeString('es-DO')}`);
  } catch (error) {
    notice(error.status === 403 ? 'Tu usuario no administra repartidores.' : `Error: ${error.message}`);
    $('#apps').innerHTML = `<tr><td colspan="7" class="empty">${esc(error.message)}</td></tr>`;
    $('#couriers').innerHTML = '<tr><td colspan="6" class="empty">—</td></tr>';
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, [data-app], [data-courier], [data-user]');
  if (!target) return;
  if (target.dataset.app) return openApplication(target.dataset.app);
  if (target.dataset.courier) return openCourier(target.dataset.courier);
  if (target.dataset.user) return openUser(target.dataset.user);
  if (target.dataset.company) return toggleCompany(target.dataset.company, target.dataset.active === 'true');
  if (target.dataset.usercompany) return toggleUserCompany(target.dataset.usercompany, target.dataset.active === 'true');
  if (target.dataset.doc) return reviewDocument(target.dataset.doc, target.dataset.decision);
  const act = target.dataset.act;
  if (act === 'info') return review('info_required');
  if (act === 'approve') return review('approved');
  if (act === 'reject') return review('rejected');
  if (target.id === 'd-close') return closeDrawer();
  if (target.id === 'refresh') return load();
});
$('#search').addEventListener('input', renderApplications);
$('#filter').addEventListener('change', renderApplications);
$('#company').addEventListener('change', renderApplications);
load();
