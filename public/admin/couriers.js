/*
 * REPARTIDORES — vistas, listas finas y alta/edición de cuentas.
 *
 * Qué hace:
 *   · Las TARJETAS de arriba son la puerta a cada vista (pendientes, requiere
 *     información, aprobadas, con acceso, multiempresa). Cada una es su propia
 *     «página» con su título y su lista; no hay que buscar nada en una lista
 *     mezclada.
 *   · Por defecto solo se ven los repartidores que YA están en la app.
 *   · Se crea y se edita aquí mismo (nombre, teléfono, PIN, acceso, activo) y las
 *     empresas se conceden con su interruptor.
 *
 * Todo lo que se pinta sale del backend: `/api/admin/courier-applications`,
 * `/api/admin/couriers` y `/api/admin/couriers/:id/companies`. Si el backend dice
 * 403/404 se muestra tal cual; no se inventan datos.
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

/**
 * LAS VISTAS. `tipo` dice qué lista pinta cada una; `estado` filtra solicitudes y
 * `reparto` filtra cuentas. `inicio` además enseña las tarjetas.
 */
const VISTAS = {
  inicio: { titulo: 'Repartidores', tipo: 'repartidores', reparto: 'en-app', tarjetas: true },
  pendientes: { titulo: 'Solicitudes pendientes', tipo: 'solicitudes', estado: 'pending' },
  info: { titulo: 'Requiere información', tipo: 'solicitudes', estado: 'info_required' },
  aprobadas: { titulo: 'Solicitudes aprobadas', tipo: 'solicitudes', estado: 'approved' },
  rechazadas: { titulo: 'Solicitudes rechazadas', tipo: 'solicitudes', estado: 'rejected' },
  solicitudes: { titulo: 'Todas las solicitudes', tipo: 'solicitudes' },
  acceso: { titulo: 'En la app', tipo: 'repartidores', reparto: 'en-app' },
  multi: { titulo: 'Multiempresa', tipo: 'repartidores', reparto: 'multi' },
  todos: { titulo: 'Todos los repartidores', tipo: 'repartidores', reparto: 'todos' },
};

const state = {
  applications: [],
  couriers: [],
  companies: [],
  users: [],
  selecting: null,
  view: 'inicio',
  q: '',
  filters: { estado: '', empresa: '', tipo: '', acceso: '' },
};

const notice = (text) => {
  const box = $('#status');
  if (box) box.textContent = text;
};

/** El teléfono se muestra parcial: el panel no necesita el número completo para decidir. */
const maskPhone = (value) => {
  const raw = String(value ?? '');
  if (raw.length < 6) return raw;
  return `${raw.slice(0, 4)}•••${raw.slice(-3)}`;
};
const when = (value) => (value ? new Date(value).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const nameOfCompany = (id) => state.companies.find((row) => row.id === id)?.name ?? id ?? '—';
const empresasDe = (row) => [row.company_id, ...(row.companies ?? [])].filter(Boolean);

/* --------------------------------------------------------------- navegación */

function vistaActual() {
  const clave = String(location.hash ?? '').replace(/^#\/?/, '');
  return VISTAS[clave] ? clave : 'inicio';
}

function irA(vista, { reemplazar = false } = {}) {
  const destino = VISTAS[vista] ? vista : 'inicio';
  const url = destino === 'inicio' ? location.pathname + location.search : `#${destino}`;
  if (reemplazar) history.replaceState({ vista: destino }, '', url);
  else history.pushState({ vista: destino }, '', url);
  state.view = destino;
  render();
}

/* ------------------------------------------------------------------ filtros */

const filtroPuesto = (clave) => state.filters[clave] ?? '';

/** Cuántas filas quedan si se elige esa opción (con el resto de filtros puestos). */
function cuenta(clave, valor, base, aplicar) {
  const previo = state.filters[clave];
  state.filters[clave] = valor;
  const total = base.filter(aplicar).length;
  state.filters[clave] = previo;
  return total;
}

function opcion(clave, valor, texto, total) {
  return `<button class="fopt" type="button" data-f-clave="${clave}" data-f-valor="${esc(valor)}" aria-pressed="${
    filtroPuesto(clave) === valor ? 'true' : 'false'
  }">${esc(texto)}<em>${total}</em></button>`;
}

function aplicaSolicitud(row) {
  if (state.filters.estado && row.status !== state.filters.estado) return false;
  if (state.filters.empresa && row.company_id !== state.filters.empresa) return false;
  if (state.q && !`${row.display_name ?? ''} ${row.phone_e164 ?? ''} ${row.zone ?? ''}`.toLowerCase().includes(state.q)) return false;
  return true;
}

function aplicaReparto(row) {
  if (state.filters.empresa && !empresasDe(row).includes(state.filters.empresa)) return false;
  if (state.filters.tipo && String(row.kind ?? '').toUpperCase() !== state.filters.tipo) return false;
  if (state.filters.acceso) {
    const etiqueta = etiquetaAcceso(row);
    if (etiqueta !== state.filters.acceso) return false;
  }
  if (state.q && !`${row.display_name ?? ''} ${row.phone ?? ''}`.toLowerCase().includes(state.q)) return false;
  return true;
}

/** `activo` (en la app), `sin-acceso` o `suspendido`. */
function etiquetaAcceso(row) {
  if (row.active === false) return 'suspendido';
  if (row.app_access !== true) return 'sin-acceso';
  return 'activo';
}

function renderFilters() {
  const estados = [
    ['', 'Todas las solicitudes'],
    ['pending', 'Pendientes'],
    ['info_required', 'Requiere información'],
    ['approved', 'Aprobadas'],
    ['rejected', 'Rechazadas'],
  ];
  const empresas = [['', 'Todas las empresas'], ...state.companies.map((row) => [row.id, row.name ?? row.id])];
  const reparto = [
    ['tipo', '', 'Todos los tipos'],
    ['tipo', 'INTERNAL', 'Internos (del CRM)'],
    ['tipo', 'EXTERNAL', 'Externos (mensajeros)'],
    ['acceso', '', 'Cualquier acceso'],
    ['acceso', 'activo', 'Con acceso activo'],
    ['acceso', 'sin-acceso', 'Sin acceso a la app'],
    ['acceso', 'suspendido', 'Suspendidos'],
  ];
  const cajaEstado = $('#filter-estado');
  const cajaEmpresa = $('#filter-empresa');
  const cajaReparto = $('#filter-reparto');
  if (cajaEstado) {
    cajaEstado.innerHTML = estados
      .map(([valor, texto]) => opcion('estado', valor, texto, cuenta('estado', valor, state.applications, aplicaSolicitud)))
      .join('');
  }
  if (cajaEmpresa) {
    cajaEmpresa.innerHTML = empresas
      .map(([valor, texto]) => opcion('empresa', valor, texto, cuenta('empresa', valor, state.couriers, aplicaReparto)))
      .join('');
  }
  if (cajaReparto) {
    cajaReparto.innerHTML = reparto
      .map(([clave, valor, texto]) => opcion(clave, valor, texto, cuenta(clave, valor, state.couriers, aplicaReparto)))
      .join('');
  }
  const nota = $('#filters-note');
  if (nota) {
    const activos = Object.values(state.filters).filter(Boolean).length;
    nota.textContent = activos
      ? `${activos} filtro${activos === 1 ? '' : 's'} puesto${activos === 1 ? '' : 's'}`
      : 'Solicitudes de ingreso y repartidores';
  }
}

/* ------------------------------------------------------------------- render */

function tarjeta(vista, etiqueta, valor, warn = false) {
  return `<button class="card${warn ? ' warn' : ''}" type="button" data-ver="${vista}" aria-label="${esc(etiqueta)}: ${esc(valor)}">
    <small>${esc(etiqueta)}</small><b>${esc(String(valor))}</b>
  </button>`;
}

function renderTarjetas() {
  const count = (status) => state.applications.filter((row) => row.status === status).length;
  const enApp = state.couriers.filter((row) => etiquetaAcceso(row) === 'activo').length;
  const multi = state.couriers.filter((row) => empresasDe(row).length > 1).length;
  return `<section class="cards" aria-label="Resumen">
    ${tarjeta('pendientes', 'Pendientes', count('pending'), count('pending') > 0)}
    ${tarjeta('info', 'Requiere info.', count('info_required'), count('info_required') > 0)}
    ${tarjeta('aprobadas', 'Aprobadas', count('approved'))}
    ${tarjeta('acceso', 'En la app', enApp)}
    ${tarjeta('multi', 'Multiempresa', multi)}
  </section>`;
}

function filasSolicitudes(vista) {
  const definicion = VISTAS[vista] ?? {};
  return state.applications
    .filter((row) => (definicion.estado ? row.status === definicion.estado : true))
    .filter(aplicaSolicitud)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

function filasRepartidores(vista) {
  const definicion = VISTAS[vista] ?? {};
  return state.couriers
    .filter((row) => {
      if (definicion.reparto === 'en-app') return etiquetaAcceso(row) === 'activo';
      if (definicion.reparto === 'multi') return empresasDe(row).length > 1;
      return true;
    })
    .filter(aplicaReparto)
    .sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''), 'es'));
}

function listaSolicitudes(rows) {
  if (!rows.length) return '<p class="empty">No hay solicitudes en esta sección.</p>';
  return `<div class="list">${rows
    .map((row) => {
      const meta = [
        maskPhone(row.phone_e164),
        nameOfCompany(row.company_id),
        row.zone ?? null,
        VEHICLE[row.vehicle_type] ?? row.vehicle_type ?? null,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<button class="lrow" type="button" data-app="${esc(row.id)}">
        <span><b>${esc(row.display_name ?? 'Sin nombre')}</b><small>${esc(meta)}</small></span>
        <span class="lrow__side"><span class="tag ${TAG[row.status] ?? 'none'}">${esc(LABEL[row.status] ?? row.status)}</span><span class="lrow__chev" aria-hidden="true">›</span></span>
      </button>`;
    })
    .join('')}</div>`;
}

function listaRepartidores(rows) {
  if (!rows.length) return '<p class="empty">No hay repartidores en esta sección.</p>';
  return `<div class="list">${rows
    .map((row) => {
      const estado = etiquetaAcceso(row);
      const tag =
        estado === 'suspendido'
          ? '<span class="tag bad">Suspendido</span>'
          : estado === 'sin-acceso'
            ? '<span class="tag none">Sin acceso</span>'
            : '<span class="tag ok">Activo</span>';
      const empresas = empresasDe(row);
      const meta = [
        String(row.kind ?? '').toLowerCase() === 'internal' ? 'Interno' : 'Externo',
        maskPhone(row.phone),
        empresas.length ? empresas.map((id) => nameOfCompany(id)).join(' + ') : 'sin empresa',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<button class="lrow" type="button" data-courier="${esc(row.id)}">
        <span><b>${esc(row.display_name ?? row.id)}</b><small>${esc(meta)}</small></span>
        <span class="lrow__side">${tag}<span class="lrow__chev" aria-hidden="true">›</span></span>
      </button>`;
    })
    .join('')}</div>`;
}

function render() {
  state.view = vistaActual();
  const definicion = VISTAS[state.view];
  const titulo = $('#titulo');
  if (titulo) titulo.textContent = definicion.titulo;
  const caja = $('#contenido');
  if (!caja) return;
  const partes = [];
  if (definicion.tarjetas) partes.push(renderTarjetas());

  if (definicion.tipo === 'solicitudes') {
    const rows = filasSolicitudes(state.view);
    partes.push(`<h2>${esc(definicion.titulo)} <span class="n">${rows.length}</span></h2>${listaSolicitudes(rows)}`);
    if (state.view !== 'solicitudes') {
      partes.push('<button class="enlace" type="button" data-ver="solicitudes">Ver todas las solicitudes</button>');
    }
  } else {
    const rows = filasRepartidores(state.view);
    const etiqueta = state.view === 'inicio' || state.view === 'acceso' ? 'En la app' : definicion.titulo;
    partes.push(`<h2>${esc(etiqueta)} <span class="n">${rows.length}</span></h2>${listaRepartidores(rows)}`);
    if (state.view !== 'todos') {
      partes.push('<button class="enlace" type="button" data-ver="todos">Ver todos los repartidores</button>');
    }
  }
  caja.innerHTML = partes.join('');
}

function renderTodo() {
  renderFilters();
  render();
}

/* --------------------------------------------------------------------- cajón */

function abrirCajon(titulo) {
  $('#d-title').textContent = titulo;
  $('#drawer').setAttribute('open', '');
  $('#drawer').setAttribute('aria-hidden', 'false');
  document.body.dataset.sheet = 'open';
}

function cerrarCajon() {
  $('#drawer').removeAttribute('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  delete document.body.dataset.sheet;
  state.selecting = null;
}

/** Detalle de una solicitud, con las acciones que el backend permite de verdad. */
function openApplication(id) {
  const row = state.applications.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'application', id };
  $('#d-body').innerHTML = `
    <div class="row"><span>Nombre</span><b>${esc(row.display_name ?? '—')}</b></div>
    <div class="row"><span>Teléfono</span><b>${esc(maskPhone(row.phone_e164))}</b></div>
    <div class="row"><span>Vehículo</span><b>${esc(VEHICLE[row.vehicle_type] ?? row.vehicle_type ?? '—')}</b></div>
    <div class="row"><span>Zona</span><b>${esc(row.zone ?? '—')}</b></div>
    <div class="row"><span>Empresa solicitada</span><b>${esc(nameOfCompany(row.company_id))}</b></div>
    <div class="row"><span>Enviada</span><b>${esc(when(row.created_at))}</b></div>
    <div class="row"><span>Estado</span><b>${esc(LABEL[row.status] ?? row.status)}</b></div>
    <div class="row"><span>Condiciones aceptadas</span><b>${esc(when(row.terms_accepted_at))}</b></div>
    ${row.review_note ? `<div class="row"><span>Nota de revisión</span><b>${esc(row.review_note)}</b></div>` : ''}
    ${profileBlock(row)}
    <div id="d-documents"><p class="hint">Cargando expediente…</p></div>
    <p class="hint">Aprobar la solicitud NO crea la cuenta ni concede acceso: se dan de alta con «Crear cuenta».</p>
    <label class="hint" for="d-note">Motivo / nota (obligatorio al pedir información o rechazar)</label>
    <textarea id="d-note" maxlength="300" style="width:100%;min-height:64px;border:1px solid var(--line);border-radius:11px;padding:8px 11px;font:inherit;background:var(--page);color:var(--ink)"></textarea>`;
  const abierta = ['pending', 'info_required'].includes(row.status);
  $('#d-actions').innerHTML = abierta
    ? `<button class="ghost" type="button" data-act="info">Pedir información</button>
       <button type="button" data-act="approve">Aprobar</button>
       <button class="danger" type="button" data-act="reject">Rechazar</button>
       <button type="button" data-courier-from-app="${esc(row.id)}">Crear cuenta</button>`
    : `<span class="hint" style="flex:1">Solicitud cerrada. Solo lectura.</span>
       <button type="button" data-courier-from-app="${esc(row.id)}">Crear cuenta</button>`;
  abrirCajon(row.display_name ?? 'Solicitud');
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
  ].join('') : '';
  const vehicleRows = vehicle ? [
    line('Marca / modelo', [vehicle.make, vehicle.model].filter(Boolean).join(' ')),
    line('Matrícula', vehicle.plate),
    line('Tipo de bicicleta', vehicle.bicycle_type),
  ].join('') : '';
  const availabilityRows = availability ? [
    line('Provincia de operación', availability.province),
    line('Zona de reparto', availability.zone),
    line('Cobertura', availability.coverage_km ? `${availability.coverage_km} km` : ''),
    line('Disponibilidad', availability.availability),
    line('Horario', availability.schedule),
    line('Experiencia', availability.experience),
  ].join('') : '';
  const policyRow = policy && policy.version
    ? `<div class="row"><span>Normas aceptadas</span><b>${esc(policy.version)}</b></div>` : '';
  return `<h2>Datos del solicitante</h2>${personalRows}${vehicleRows}${availabilityRows}${policyRow}`;
}

const DOC_LABEL = {
  IDENTITY: 'Identidad', IDENTITY_BACK: 'Reverso del documento', DRIVING_LICENSE: 'Licencia',
  INSURANCE: 'Seguro del vehículo', VEHICLE: 'Documento del vehículo',
  VEHICLE_PHOTO: 'Foto del vehículo', SELFIE: 'Selfie',
};
const DOC_TAG = {
  received: ['none', 'Recibido'],
  accepted: ['ok', 'Aceptado'],
  rejected: ['bad', 'Rechazado'],
  replacement: ['warn', 'Pedir otro'],
};

async function loadDocuments(applicationId) {
  const box = document.getElementById('d-documents');
  if (!box) return;
  try {
    const data = await api(`/api/admin/courier-applications/${encodeURIComponent(applicationId)}/documents`);
    const missing = data.missing ?? [];
    box.innerHTML = `
      <h2>Documentos</h2>
      ${(data.documents ?? []).length ? data.documents.map((doc) => {
        const [tone, label] = DOC_TAG[doc.status] ?? ['none', doc.status];
        return `<div class="row">
          <span>${esc(DOC_LABEL[doc.kind] ?? doc.kind)}<br><small>${esc(when(doc.created_at))} · ${Math.round(Number(doc.bytes || 0) / 1024)} KB</small>
          ${doc.review_note ? `<small> · ${esc(doc.review_note)}</small>` : ''}</span>
          <b><span class="tag ${tone}">${esc(label)}</span></b>
        </div>
        <div style="display:flex;gap:6px;margin:4px 0 8px;flex-wrap:wrap">
          <button class="ghost sm" type="button" data-doc="${esc(doc.id)}" data-decision="accepted">Aceptar</button>
          <button class="ghost sm" type="button" data-doc="${esc(doc.id)}" data-decision="replacement">Pedir otro</button>
          <button class="danger sm" type="button" data-doc="${esc(doc.id)}" data-decision="rejected">Rechazar</button>
          <a class="ghost sm" style="display:inline-flex;align-items:center;padding:0 10px;border:1px solid var(--line);border-radius:9px;text-decoration:none;color:var(--brand);font-size:11.5px;font-weight:700" href="/api/admin/courier-documents/${esc(doc.id)}/file" target="_blank" rel="noopener">Ver</a>
        </div>`;
      }).join('') : '<p class="hint">Sin documentos todavía.</p>'}
      ${missing.length ? `<p class="hint">Falta: ${missing.map((kind) => esc(DOC_LABEL[kind] ?? kind)).join(' · ')}</p>` : '<p class="hint">Expediente completo.</p>'}`;
  } catch (error) {
    box.innerHTML = `<p class="hint">No se pudo leer el expediente: ${esc(error.message)}</p>`;
  }
}

/** Detalle de un repartidor: sus datos y el interruptor de cada empresa. */
async function openCourier(id) {
  const row = state.couriers.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'courier', id };
  abrirCajon(row.display_name ?? 'Repartidor');
  $('#d-body').innerHTML = '<p class="hint">Cargando empresas…</p>';
  $('#d-actions').innerHTML = `<button class="ghost" type="button" data-courier-edit="${esc(id)}">Editar datos</button>`;
  let grants = [];
  try {
    grants = (await api(`/api/admin/couriers/${encodeURIComponent(id)}/companies`)).companies ?? [];
  } catch (error) {
    $('#d-body').innerHTML = `<p class="hint">No se pudieron leer las concesiones: ${esc(error.message)}</p>`;
    return;
  }
  const byCompany = new Map(grants.map((grant) => [grant.company_id, grant]));
  const estado = etiquetaAcceso(row);
  const textoEstado = estado === 'activo' ? 'Activo (en la app)' : estado === 'sin-acceso' ? 'Sin acceso a la app' : 'Suspendido';
  $('#d-body').innerHTML = `
    <div class="row"><span>Tipo</span><b>${esc(String(row.kind ?? '').toLowerCase() === 'internal' ? 'Interno (usuario del CRM)' : 'Externo (mensajero)')}</b></div>
    <div class="row"><span>Teléfono</span><b>${esc(row.phone ?? '—')}</b></div>
    <div class="row"><span>Estado</span><b>${esc(textoEstado)}</b></div>
    <div class="row"><span>Último acceso</span><b>${esc(row.last_login_at ? when(row.last_login_at) : 'nunca')}</b></div>
    <div class="row"><span>Creado</span><b>${esc(when(row.created_at))}</b></div>
    <h2>Empresas</h2>
    <p class="hint">Cada empresa se concede por separado y queda auditada. Revocar corta el acceso en la siguiente petición de la app.</p>
    ${state.companies
      .map((company) => {
        const grant = byCompany.get(company.id);
        const active = grant?.active === true;
        return `<div class="row">
          <span>${esc(company.name ?? company.id)}<br><small>${active ? `Concedida ${esc(when(grant.updated_at))}` : 'Sin autorización'}</small></span>
          <b><button class="${active ? 'danger' : 'ghost'} sm" type="button" data-company="${esc(company.id)}" data-active="${active ? 'false' : 'true'}">${active ? 'Revocar' : 'Conceder'}</button></b>
        </div>`;
      })
      .join('')}`;
}

/* --------------------------------------------------------- alta y edición */

/*
 * TELÉFONO COMO LO ESPERA EL SERVIDOR.
 *
 * Si se escribe 8095551234 (10 dígitos) se completa a +18095551234: sin el
 * código de país el alta se rechaza y el mensaje no lo explicaba.
 */
function normalizarTelefono(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function openCourierForm(id = null, prefill = null) {
  const row = id ? state.couriers.find((item) => item.id === id) : null;
  state.selecting = { kind: 'form', id };
  abrirCajon(row ? 'Editar repartidor' : 'Nuevo repartidor');
  const esInterno = row ? String(row.kind ?? '').toLowerCase() === 'internal' : (prefill?.kind ?? 'EXTERNAL') === 'INTERNAL';
  const usuarios = state.users.filter((user) => user.active !== false);
  const yaTiene = new Set(state.couriers.map((item) => item.user_id).filter(Boolean));
  $('#d-body').innerHTML = `
    ${
      row
        ? `<p class="hint">El tipo de una cuenta no se cambia: si necesitas otro, crea una nueva y desactiva esta.</p>`
        : `<label class="field"><span>Tipo de repartidor</span>
            <select id="f-kind">
              <option value="EXTERNAL"${esInterno ? '' : ' selected'}>Externo (mensajero sin cuenta en el CRM)</option>
              <option value="INTERNAL"${esInterno ? ' selected' : ''}>Interno (usuario del CRM)</option>
            </select>
          </label>`
    }
    <label class="field"><span>Nombre</span>
      <input id="f-name" type="text" maxlength="80" value="${esc(row?.display_name ?? prefill?.display_name ?? '')}" placeholder="Nombre y apellido">
    </label>
    <label class="field"><span>Teléfono (con código de país)</span>
      <input id="f-phone" type="tel" inputmode="tel" value="${esc(row?.phone ?? prefill?.phone_e164 ?? '')}" placeholder="+18095551234">
    </label>
    ${
      row
        ? ''
        : `<label class="field" id="f-user-field"${esInterno ? '' : ' hidden'}><span>Usuario del CRM</span>
            <select id="f-user">
              <option value="">Elige el usuario…</option>
              ${usuarios
                .map(
                  (user) =>
                    `<option value="${esc(user.id)}">${esc(user.display_name || user.username)}${yaTiene.has(user.id) ? ' · ya tiene cuenta' : ''}</option>`,
                )
                .join('')}
            </select>
          </label>
          <label class="field"><span>Empresa principal</span>
            <select id="f-company">
              ${state.companies.map((company) => `<option value="${esc(company.id)}"${(prefill?.company_id ?? 'phytoemagry') === company.id ? ' selected' : ''}>${esc(company.name ?? company.id)}</option>`).join('')}
            </select>
          </label>`
    }
    <label class="field"><span>${row ? 'PIN nuevo (déjalo vacío para no cambiarlo)' : 'PIN de acceso a la app (mínimo 6)'}</span>
      <input id="f-pin" type="text" inputmode="numeric" autocomplete="off" placeholder="••••••">
    </label>
    <div class="sep"></div>
    <label class="field--check"><input id="f-access" type="checkbox"${row ? (row.app_access === true ? ' checked' : '') : ' checked'}><span>Acceso a la app</span></label>
    <label class="field--check"><input id="f-active" type="checkbox"${row ? (row.active !== false ? ' checked' : '') : ' checked'}><span>Cuenta activa</span></label>
    <p class="hint">${row ? 'Cambiar el PIN o quitar el acceso cierra las sesiones abiertas del teléfono.' : 'El PIN es lo que el repartidor escribe en la app para entrar. Se guarda cifrado: no se puede ver después.'}</p>
    <p class="hint" id="f-error" role="alert" hidden></p>`;
  $('#d-actions').innerHTML = `
    <button class="ghost" type="button" data-form-cancel>Cancelar</button>
    <button type="button" data-form-save>${row ? 'Guardar cambios' : 'Crear repartidor'}</button>`;
  if (!row) {
    const select = $('#f-kind');
    select?.addEventListener('change', () => {
      const campo = $('#f-user-field');
      if (campo) campo.hidden = select.value !== 'INTERNAL';
    });
  }
  setTimeout(() => $('#f-name')?.focus?.({ preventScroll: true }), 30);
}

async function saveCourierForm(button) {
  const selection = state.selecting;
  if (selection?.kind !== 'form') return;
  const nombre = ($('#f-name')?.value ?? '').trim();
  const telefono = normalizarTelefono($('#f-phone')?.value ?? '');
  const pin = ($('#f-pin')?.value ?? '').trim();
  const acceso = $('#f-access')?.checked === true;
  const activo = $('#f-active')?.checked === true;
  if (nombre.length < 3) return notice('Escribe el nombre del repartidor (mínimo 3 letras).');
  if (!/^\+?\d{8,15}$/.test(telefono.replace(/[\s()-]/g, ''))) return notice('Escribe el teléfono con código de país, por ejemplo +18095551234.');
  if (!selection.id && pin.length < 6) return notice('El PIN debe tener al menos 6 caracteres.');
  if (pin && pin.length < 6) return notice('El PIN debe tener al menos 6 caracteres.');
  button.disabled = true;
  notice('Guardando…');
  const errorBox = $('#f-error');
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
  try {
    if (selection.id) {
      const body = { displayName: nombre, phone: telefono, appAccess: acceso, active: activo };
      if (pin) body.pin = pin;
      await api(`/api/admin/couriers/${encodeURIComponent(selection.id)}`, body, 'PATCH');
      notice('Repartidor actualizado.');
      cerrarCajon();
      await load();
      await openCourier(selection.id);
    } else {
      const kind = ($('#f-kind')?.value ?? 'EXTERNAL').toUpperCase();
      const body = {
        kind,
        displayName: nombre,
        phone: telefono,
        pin,
        appAccess: acceso,
        active: activo,
        companyId: $('#f-company')?.value || 'phytoemagry',
      };
      if (kind === 'INTERNAL') {
        const userId = $('#f-user')?.value ?? '';
        if (!userId) throw Error('Elige el usuario del CRM para la cuenta interna.');
        body.userId = userId;
      }
      const created = await api('/api/admin/couriers', body);
      notice('Repartidor creado.');
      cerrarCajon();
      await load();
      if (created?.courier?.id) await openCourier(created.courier.id);
    }
  } catch (error) {
    /*
     * El error se pinta DENTRO del cajón: la barra de estado queda tapada por el
     * propio cajón y el alta parecía "no hacer nada".
     */
    const mensaje = `No se pudo guardar: ${error.message}`;
    notice(mensaje);
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = mensaje;
      errorBox.style.color = 'var(--bad, #b91c1c)';
      errorBox.scrollIntoView({ block: 'nearest' });
    }
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------ revisión y permisos */

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
      companyId: application.company_id,
      decision,
      note: note || undefined,
    });
    notice('Solicitud actualizada.');
    cerrarCajon();
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

async function reviewDocument(documentId, decision) {
  const note = ($('#d-note')?.value ?? '').trim();
  if (decision !== 'accepted' && !note) {
    notice('Escribe el motivo en la nota antes de continuar.');
    return;
  }
  notice('Guardando…');
  try {
    await api(`/api/admin/courier-documents/${encodeURIComponent(documentId)}/review`, {
      decision,
      note: note || undefined,
    });
    notice('Documento revisado.');
    if (state.selecting?.kind === 'application') await loadDocuments(state.selecting.id);
  } catch (error) {
    notice(`No se pudo revisar: ${error.message}`);
  }
}

async function openUser(id) {
  const row = state.users.find((item) => item.id === id);
  if (!row) return;
  state.selecting = { kind: 'user', id };
  abrirCajon(row.display_name || row.username || 'Usuario');
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
    ${state.companies
      .map((company) => {
        const grant = byCompany.get(company.id);
        const active = grant?.active === true;
        return `<div class="row">
          <span>${esc(company.name ?? company.id)}<br><small>${active ? `Concedida ${esc(when(grant.updated_at))}` : 'Sin autorización'}</small></span>
          <b><button class="${active ? 'danger' : 'ghost'} sm" type="button" data-usercompany="${esc(company.id)}" data-active="${active ? 'false' : 'true'}">${active ? 'Revocar' : 'Conceder'}</button></b>
        </div>`;
      })
      .join('')}`;
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

/* ------------------------------------------------------------------- carga */

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
    await Promise.all(
      list.map(async (row) => {
        try {
          const grants = await api(`/api/admin/couriers/${encodeURIComponent(row.id)}/companies`);
          row.companies = (grants.companies ?? []).filter((grant) => grant.active === true).map((grant) => grant.company_id);
        } catch {
          row.companies = row.company_id ? [row.company_id] : [];
        }
        return row;
      }),
    );
    state.couriers = list;
    const people = (users.users ?? []).filter((row) => row.active !== false);
    await Promise.all(
      people.map(async (row) => {
        try {
          const grants = await api(`/api/admin/users/${encodeURIComponent(row.id)}/companies`);
          row.companies = (grants.companies ?? []).filter((grant) => grant.active === true).map((grant) => grant.company_id);
        } catch {
          row.companies = [];
        }
        return row;
      }),
    );
    state.users = people;
    renderTodo();
    notice(`Actualizado ${new Date().toLocaleTimeString('es-DO')}`);
  } catch (error) {
    notice(error.status === 403 ? 'Tu usuario no administra repartidores.' : `Error: ${error.message}`);
    const caja = $('#contenido');
    if (caja) caja.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ eventos */

$('#refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await load();
  } finally {
    button.disabled = false;
  }
});

$('#search').addEventListener('input', (event) => {
  state.q = String(event.target.value ?? '').trim().toLowerCase();
  renderFilters();
  render();
});

document.querySelector('[data-volver]')?.addEventListener('click', () => {
  // Dentro de una sección, «volver» devuelve a la pantalla principal.
  if (state.view !== 'inicio') {
    irA('inicio');
    return;
  }
  location.href = '/admin/';
});

window.addEventListener('popstate', () => render());

document.addEventListener('click', (event) => {
  const ver = event.target.closest('[data-ver]');
  if (ver) {
    irA(ver.dataset.ver);
    return;
  }
  const filtro = event.target.closest('[data-f-clave]');
  if (filtro) {
    const clave = filtro.dataset.fClave;
    const valor = filtro.dataset.fValor ?? '';
    // Volver a pulsar la opción puesta la quita.
    state.filters[clave] = state.filters[clave] === valor ? '' : valor;
    /*
     * Si la sección ya está fijada a un estado (por ejemplo «Pendientes») y se
     * elige otro en el cajón, la lista saldría vacía. Se salta a «Todas las
     * solicitudes» con ese filtro puesto: es lo que la persona espera ver.
     */
    if (clave === 'estado' && state.filters.estado && VISTAS[state.view]?.estado) {
      irA('solicitudes');
      renderFilters();
      return;
    }
    renderFilters();
    render();
    return;
  }
  if (event.target.closest('[data-filters-clear]')) {
    state.filters = { estado: '', empresa: '', tipo: '', acceso: '' };
    renderFilters();
    render();
    notice('Filtros quitados.');
    return;
  }
  if (event.target.closest('[data-courier-new]')) return openCourierForm(null);
  const desdeSolicitud = event.target.closest('[data-courier-from-app]');
  if (desdeSolicitud) {
    const application = state.applications.find((row) => row.id === desdeSolicitud.dataset.courierFromApp);
    if (!application) return;
    cerrarCajon();
    return openCourierForm(null, {
      kind: 'EXTERNAL',
      display_name: application.display_name,
      phone_e164: application.phone_e164,
      company_id: application.company_id,
    });
  }
  const editar = event.target.closest('[data-courier-edit]');
  if (editar) return openCourierForm(editar.dataset.courierEdit);
  if (event.target.closest('[data-form-cancel]')) return cerrarCajon();
  const guardar = event.target.closest('[data-form-save]');
  if (guardar) return saveCourierForm(guardar);

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
  if (target.id === 'd-close') return cerrarCajon();
});

state.view = vistaActual();
if (!location.hash && state.view === 'inicio') history.replaceState({ vista: 'inicio' }, '');
render();
load();
