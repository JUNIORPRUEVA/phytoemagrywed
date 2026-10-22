/**
 * CENTRO DE OPERACIONES — bandeja y conversación de tickets internos.
 *
 * QUÉ ES
 * El espacio de trabajo interno del equipo: cada pedido, incidencia o asignación
 * es un ticket con su hilo. NO es el chat del cliente (ese vive en `app.js` y en
 * sus propias hojas): aquí no se habla con nadie de fuera, se trabaja puertas
 * adentro.
 *
 * CÓMO ESTÁ HECHO
 * Módulo propio (ESM) que se pinta en `#view-ops` y escucha `fulltech:tab`, igual
 * que `supervisor.js`. `app.js` solo registra la pestaña; así este archivo crece
 * sin tocar el archivo de 26.000 líneas que comparten varias manos.
 *
 * REGLAS DE LA PANTALLA
 *   - El servidor manda: la lista ya viene recortada por permisos y este módulo
 *     no decide quién ve qué.
 *   - Leer NO acusa recibo ni cierra nada: son tres botones/estados distintos.
 *   - Nada de temporizadores de envío: los avisos llegan por SSE
 *     (`fulltech:crm-event`); al volver a la pestaña se refresca una vez.
 */

/* ------------------------------------------------------------------ iconos */

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-6-7-2z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5l11 6.5-11 6.5z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5L22 20H2z"/><path d="M12 9.5v4.5M12 17h.01"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V6.5a1.5 1.5 0 013 0V12"/><path d="M11 11V5.5a1.5 1.5 0 013 0V12"/><path d="M14 12V7.5a1.5 1.5 0 013 0V15a5 5 0 01-5 5h-1a5 5 0 01-4.6-3L5 14.5a1.6 1.6 0 012.8-1.5L8 14"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.4"/><path d="M4.5 20c0-3.6 3.2-5.8 7.5-5.8s7.5 2.2 7.5 5.8"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
  /* Etapa D: bandeja de aprobaciones y registro de agentes. */
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12.2l2.2 2.2L15.5 10"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4.5V8M8.5 14h.01M15.5 14h.01M9.5 17h5"/></svg>',
};

/** Acciones de seguimiento del trabajo (las mismas que valida el servidor). */
const TASK_ACTIONS = [
  { id: 'acknowledge', label: 'Acusar recibo', icon: 'check', needsNote: false, permission: 'ack' },
  { id: 'start', label: 'Iniciar trabajo', icon: 'play', needsNote: false, permission: 'reply' },
  { id: 'progress', label: 'Registrar avance', icon: 'clock', needsNote: true, permission: 'reply' },
  { id: 'issue', label: 'Reportar un problema', icon: 'alert', needsNote: true, permission: 'reply' },
  { id: 'help', label: 'Pedir ayuda', icon: 'hand', needsNote: true, permission: 'reply' },
  { id: 'complete', label: 'Marcar trabajo completado', icon: 'check', needsNote: false, permission: 'complete' },
  { id: 'escalate', label: 'Escalar el ticket', icon: 'up', needsNote: true, permission: 'reply' },
];

/** ¿Puede esta persona hacer esta acción según lo que dijo el servidor? */
function taskAllowed(actionKey) {
  const permissions = state.permissions ?? {};
  if (permissions[actionKey]) return true;
  if (actionKey === 'complete') return Boolean(permissions.ack || permissions.update);
  return false;
}

/** Un icono por TIPO de ticket: una letra repetida («I» de Incidencia e
 *  Inventario) no distingue nada y parece un error. */
const TYPE_ICONS = {
  order: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/></svg>',
  delivery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7h10v9h-10z"/><path d="M12.5 10.5h4l3 3.2V16h-7z"/><circle cx="6.5" cy="17.5" r="1.7"/><circle cx="16.5" cy="17.5" r="1.7"/></svg>',
  incident: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5L22 20H2z"/><path d="M12 9.5v4.5M12 17h.01"/></svg>',
  assignment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="8.5" r="3.2"/><path d="M3.5 20c0-3.3 2.7-5.4 6-5.4 1.4 0 2.7.4 3.7 1.1"/><path d="M15.5 17l2 2 4-4"/></svg>',
  sales_followup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 20V4M3.5 20H21"/><path d="M7 15.5l4-4.5 3 2.5 4.5-5.5"/></svg>',
  inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h16V20H4z"/><path d="M4 8.5L7 4h10l3 4.5M9.5 13h5"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4 4V20H6z"/><path d="M9 12h6M9 16h4"/></svg>',
  agent_task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.3l5-.7z"/></svg>',
};

const FILTERS = [  { id: 'abiertos', label: 'Abiertos' },
  { id: 'esperando', label: 'En espera' },
  { id: 'mios', label: 'Míos' },
  { id: 'sin-asignar', label: 'Sin asignar' },
  { id: 'urgentes', label: 'Urgentes' },
  { id: 'resueltos', label: 'Cerrados' },
  { id: 'todos', label: 'Todos' },
];

const TICKET_TYPES = [
  { id: 'incident', label: 'Incidencia' },
  { id: 'delivery', label: 'Entrega' },
  { id: 'order', label: 'Pedido' },
  { id: 'assignment', label: 'Asignación' },
  { id: 'sales_followup', label: 'Seguimiento comercial' },
  { id: 'inventory', label: 'Inventario' },
  { id: 'admin', label: 'Administrativo' },
  { id: 'agent_task', label: 'Tarea de agente' },
];

/* ------------------------------------------------------------------- estado */

const state = {
  tab: '',
  booted: false,
  session: null,
  items: [],
  filter: 'abiertos',
  q: '',
  loading: false,
  error: '',
  selectedId: '',
  ticket: null,
  messages: [],
  events: [],
  participants: [],
  permissions: null,
  sending: false,
  menuOpen: false,
  panel: '',
  composer: '',
  searchOpen: false,
  searchTimer: null,
  activeThreadAt: 0,
  orderQuery: '',
  orderResults: [],
  newOpen: false,
  newBusy: false,
  newError: '',
  newPicked: null,
  resolveOpen: false,
  /* Etapa C */
  detailOpen: false,
  directory: [],
  taskMenu: false,
  mentionMenu: false,
  taskSheet: null,
  sheetMode: '',
  hasMore: false,
  oldestSeq: null,
  loadingOlder: false,
  totalUnread: 0,
  /* Etapa D */
  approvals: [],
  runs: [],
  agents: [],
  agentTools: [],
  approving: '',
  /* Bandeja global de aprobaciones y registro de agentes (R4, R5, R7). */
  inboxApprovals: [],
  pendingApprovalCount: 0,
  approvalsOpen: false,
  agentsOpen: false,
  agentEditing: '',
  agentBusy: false,
  agentError: '',
  rejectOpen: false,
  rejectTarget: '',
  rejectBusy: false,
  /* Centro IA: equipo → oficina → tickets (la conversación es la de siempre). */
  screen: 'agents',
  centro: null,
  centroLoading: false,
  centroError: '',
  office: null,
  officeKey: '',
  officeError: '',
  officeTab: 'tickets',
  /* Agente de Seguimiento */
  workTab: 'chat',
  workChat: [],
  workBusy: '',
  returnTo: null,
};

const VIEW = () => document.getElementById('view-ops');

/*
 * ¿Sigue habiendo documento? Una petición puede volver cuando la pestaña ya se
 * descargó (o cuando el UAT cerró la ventana): tocar el DOM ahí lanza un error
 * que nadie recoge. Es la misma guarda que usa `app.js`.
 */
const domAlive = () => typeof document !== 'undefined' && Boolean(document?.body);

/* --------------------------------------------------------------- utilidades */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function toast(message) {
  if (!domAlive()) return;
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
    error.payload = data;
    throw error;
  }
  return data;
}

/* ADMIN llega con el comodín `*`: hay que tratarlo como «todos los permisos». */
const can = (permission) => {
  const list = Array.isArray(state.session?.permissions) ? state.session.permissions : [];
  return list.includes('*') || list.includes(permission);
};
const isAdmin = () => String(state.session?.user?.role ?? '') === 'ADMIN';

function clientKey(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}`;
}

/**
 * Valor de un campo del formulario POR NOMBRE.
 *
 * OJO: `form.title` NO es el campo «Asunto»: es la propiedad `title` del propio
 * `<form>` (una cadena vacía), que tiene prioridad sobre el acceso por nombre.
 * Con `form.title` la validación decía siempre «escribe un asunto» aunque
 * estuviera escrito. Se lee siempre por selector.
 */
function fieldValue(form, name) {
  return String(form?.querySelector?.(`[name="${name}"]`)?.value ?? '');
}

const timeFmt = new Intl.DateTimeFormat('es-DO', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: '2-digit', month: '2-digit' });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «14:32» hoy · «Ayer 14:32» · «lun 20/10 14:32» · fecha corta. */
function stamp(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (sameDay(date, now)) return timeFmt.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Ayer ${timeFmt.format(date)}`;
  if (now.getTime() - date.getTime() < 6 * 24 * 60 * 60 * 1000) return `${weekdayFmt.format(date)} ${timeFmt.format(date)}`;
  return dayFmt.format(date);
}

function dayLabel(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (sameDay(date, now)) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Ayer';
  return dayFmt.format(date);
}

/* ------------------------------------------------------------------ armazón */

/**
 * Barra de administración del centro: bandeja de aprobaciones y registro de
 * agentes. Solo se pinta a quien puede usarla (cerrar tickets / administrar).
 */
function adminBarHtml() {
  const approvals = can('tickets.close');
  const agents = can('admin.full');
  if (!approvals && !agents) return '';
  const pending = Number(state.pendingApprovalCount ?? 0) || 0;
  return `
    <div class="ops-adminbar" id="ops-adminbar">
      ${
        approvals
          ? `<button class="ops-adminbar__btn" data-ops-approvals type="button">${ICONS.shield}<span>Aprobaciones</span>${
              pending > 0 ? `<span class="ops-adminbar__count" aria-label="${pending} pendientes">${pending > 99 ? '99+' : pending}</span>` : ''
            }</button>`
          : ''
      }
      ${agents ? `<button class="ops-adminbar__btn" data-ops-agents type="button">${ICONS.bot}<span>Agentes IA</span></button>` : ''}
    </div>`;
}

function shellHtml() {
  return `
    <div class="ops" data-ops-view="list">
      <aside class="ops-list" aria-label="Tickets">
        <div class="ops-list__tools">
          <button class="ops-iconbtn" data-centro-nav="agents" type="button" aria-label="Volver al equipo de agentes">${ICONS.back}</button>
          <label class="ops-search">
            <span aria-hidden="true">${ICONS.search}</span>
            <input id="ops-search" type="search" placeholder="Buscar ticket, pedido…" autocomplete="off" />
          </label>
          <button class="ops-iconbtn ops-iconbtn--new" data-ops-new type="button" aria-label="Nuevo ticket">${ICONS.plus}</button>
        </div>
        ${adminBarHtml()}
        <div class="ops-chips" id="ops-chips">
          ${FILTERS.map(
            (filter) =>
              `<button class="ops-chipbtn" data-ops-filter="${filter.id}" type="button" aria-pressed="${filter.id === state.filter}">${filter.label}</button>`,
          ).join('')}
        </div>
        <div class="ops-rows" id="ops-rows"></div>
      </aside>

      <section class="ops-chat" aria-label="Conversación del ticket">
        <header class="ops-chat__head" id="ops-chat-head"></header>
        <div class="ops-thread" id="ops-thread"></div>
        <footer class="ops-composer" id="ops-composer"></footer>
      </section>
    </div>

    <div class="ops-sheet" id="ops-sheet" hidden>
      <div class="ops-sheet__backdrop" data-ops-sheet-close></div>
      <div class="ops-sheet__card" role="dialog" aria-modal="true" aria-labelledby="ops-sheet-title"></div>
    </div>
  `;
}

function ensureShell() {
  const view = VIEW();
  if (!view) return;
  const shell = state.screen === 'tickets' ? 'tickets' : 'centro';
  if (view.dataset.shell === shell) return;
  view.innerHTML = shell === 'tickets' ? shellHtml() : centroShellHtml();
  view.dataset.shell = shell;
  view.dataset.ready = '1';
  /* El armazón nuevo puede cambiar de vista: la barra se pinta después. */
  renderCentroTools();
}

/* ====================================================== CENTRO IA — EQUIPO */

/*
 * El Centro IA tiene TRES pantallas sobre ESTE mismo módulo:
 *
 *   agents   la oficina virtual: quién es cada agente y cómo está (entrada)
 *   agent    la oficina de UN agente: sus tickets, su trabajo y sus herramientas
 *   tickets  la bandeja de siempre (lista + conversación)
 *
 * La conversación NO se duplica: al abrir un ticket se usa el mismo chat de la
 * bandeja, y el botón de volver regresa a la oficina de la que se vino.
 */

const isCentroScreen = () => state.screen !== 'tickets';

const initialsOf = (name) => {
  const parts = String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? '');
  return parts.join('').toUpperCase() || 'IA';
};

const OFFICE_TABS = [
  ['tickets', 'Asignados'],
  ['activity', 'Actividad'],
  ['tools', 'Herramientas'],
  ['delegations', 'Ayuda'],
];

const DELEGATION_LABELS = {
  pending: 'Pendiente',
  accepted: 'En curso',
  completed: 'Completada',
  rejected: 'Rechazada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

const STATE_LABELS = {
  working: 'Trabajando',
  waiting_human: 'Esperando aprobación',
  waiting: 'En espera',
  idle: 'En reposo',
  paused: 'Desactivado',
};

/** Armazón del centro: cabecera con la marca, las secciones y las herramientas. */
function centroShellHtml() {
  return `
    <div class="centro" data-centro-screen="${esc(state.screen)}">
      <header class="centro__top">
        <div class="centro__brand">
          <span class="centro__logo" aria-hidden="true">IA</span>
          <span class="centro__brandtext"><strong>Centro IA</strong><small>Equipo de agentes</small></span>
        </div>
        <nav class="centro__seg" aria-label="Secciones del Centro IA">
          <button class="centro__segbtn" data-centro-nav="agents" type="button" aria-current="${state.screen === 'agents'}">Agentes</button>
          <button class="centro__segbtn" data-centro-nav="tickets" type="button" aria-current="false">Tickets</button>
        </nav>
        <div class="centro__tools" id="centro-tools"></div>
      </header>
      <div class="centro__body" id="centro-body"></div>
    </div>`;
}

/** Aprobaciones y administración: los MISMOS botones de siempre, sin duplicar. */
function centroToolsHtml() {
  const approvals = can('tickets.close');
  const admin = can('admin.full');
  if (!approvals && !admin) return '';
  const pending = Number(state.pendingApprovalCount ?? 0) || 0;
  return `
    ${approvals ? `<button class="centro-tool" data-ops-approvals type="button" aria-label="Aprobaciones pendientes">${ICONS.shield}<span>Aprobaciones</span>${pending > 0 ? `<span class="centro-tool__count">${pending > 99 ? '99+' : pending}</span>` : ''}</button>` : ''}
    ${admin ? `<button class="centro-tool" data-ops-agents type="button" aria-label="Administrar agentes">${ICONS.bot}<span>Agentes</span></button>` : ''}`;
}

function renderCentroTools() {
  if (!domAlive()) return;
  const host = document.getElementById('centro-tools');
  if (!host) return;
  host.innerHTML = centroToolsHtml();
}

/* ------------------------------------------------------------ el equipo */

function centroStatHtml(label, value, hint) {
  return `<li class="centro-stat"><span class="centro-stat__value">${esc(value)}</span><span class="centro-stat__label">${esc(label)}</span><span class="centro-stat__hint">${esc(hint)}</span></li>`;
}

function agentCardHtml(agent) {
  const pending = Number(agent.pending ?? 0) || 0;
  const unread = Number(agent.unread ?? 0) || 0;
  const role = agent.role || (agent.responsibilities ?? [])[0] || 'Sin responsabilidad asignada';
  return `
    <li class="centro-team__item">
      <button class="centro-card" data-centro-agent="${esc(agent.key)}" type="button">
        <span class="centro-ava" data-state="${esc(agent.state)}" aria-hidden="true">${esc(initialsOf(agent.name))}</span>
        <span class="centro-card__body">
          <span class="centro-card__line">
            <strong class="centro-card__name">${esc(agent.name)}</strong>
            <span class="centro-state" data-state="${esc(agent.state)}"><i aria-hidden="true"></i>${esc(STATE_LABELS[agent.state] ?? agent.state)}</span>
          </span>
          <span class="centro-card__role">${esc(role)}</span>
          <span class="centro-card__meta">
            ${pending > 0 ? `<span class="centro-meta" data-kind="pending">${pending} en curso</span>` : ''}
            ${unread > 0 ? `<span class="centro-meta" data-kind="unread">${unread} sin leer</span>` : ''}
            ${agent.assigned > 0 ? `<span class="centro-meta">${esc(agent.assigned)} ticket(s)</span>` : ''}
            <span class="centro-meta" data-kind="tools">${esc(agent.toolCount ?? 0)} herramientas</span>
            ${agent.planner === 'llm' ? '<span class="centro-meta" data-kind="llm">con modelo</span>' : ''}
          </span>
        </span>
        <span class="centro-chev" aria-hidden="true">›</span>
      </button>
    </li>`;
}

/**
 * Listón de un agente que el centro conoce pero todavía no está dado de alta.
 *
 * Se pinta como una fila más (mismo sitio, mismo orden) para que la lista
 * siempre tenga los dos agentes; si falta uno se ve el hueco con su botón, no
 * una pantalla con un solo listón y sin explicación.
 */
function pendingAgentRowHtml(entry) {
  const altaTrabajo = entry.alta === 'work';
  const boton = altaTrabajo
    ? '<button class="centro-btn centro-btn--xs" data-work-seed type="button">Dar de alta</button>'
    : `<button class="centro-btn centro-btn--xs" data-agent-seed="${esc(entry.key)}" type="button">Dar de alta</button>`;
  return `
    <li class="centro-team__item">
      <div class="centro-pending" data-agent-pending="${esc(entry.key)}">
        <span class="centro-ava" data-state="paused" aria-hidden="true">${esc(initialsOf(entry.name))}</span>
        <span class="centro-card__body">
          <span class="centro-card__line">
            <strong class="centro-card__name">${esc(entry.name)}</strong>
            <span class="centro-state" data-state="paused"><i aria-hidden="true"></i>Sin dar de alta</span>
          </span>
          <span class="centro-card__role">${esc(entry.summary ?? entry.role ?? '')}</span>
        </span>
        <span class="centro-card__actions">${boton}</span>
      </div>
    </li>`;
}

function directoryHtml() {
  if (state.centroError) {
    return `<div class="centro-empty centro-empty--error">
      <strong>No se pudo cargar el equipo</strong>
      <span>${esc(state.centroError)}</span>
      <button class="centro-btn" data-centro-reload type="button">Reintentar</button>
    </div>`;
  }
  if (!state.centro) return '<div class="centro-empty"><strong>Cargando el equipo…</strong></div>';
  const data = state.centro;
  const agents = data.agents ?? [];
  const totals = data.totals ?? {};
  /* Los agentes que el centro conoce y aún no están dados de alta. */
  const faltan = data.canAdmin ? (data.knownAgents ?? []).filter((entry) => !entry.ready) : [];
  const pendientes = faltan.map(pendingAgentRowHtml).join('');
  const empty = `
    <div class="centro-empty">
      <strong>Todavía no hay agentes</strong>
      <span>Cuando se registre un agente aparecerá aquí, sin tocar el código.</span>
      ${data.canAdmin ? '<button class="centro-btn" data-ops-agents type="button">Registrar el primero</button>' : ''}
    </div>`;
  return `
    <section class="centro-dir">
      <div class="centro-dir__head">
        <h2 class="centro-dir__title">Agentes</h2>
        <button class="centro-link" data-centro-nav="tickets" type="button">Todos los tickets <span aria-hidden="true">→</span></button>
      </div>
      <ul class="centro-stats">
        ${centroStatHtml('Agentes', totals.active ?? 0, 'activos')}
        ${centroStatHtml('Trabajando', totals.working ?? 0, 'ahora')}
        ${centroStatHtml('Pendientes', totals.pending ?? 0, 'ejecuciones')}
        ${centroStatHtml('Sin leer', totals.unread ?? 0, 'para agentes')}
      </ul>
      ${
        agents.length || pendientes
          ? `<ul class="centro-team">${agents.map(agentCardHtml).join('')}${pendientes}</ul>`
          : empty
      }
      <p class="centro-note">El estado y los contadores salen de las ejecuciones reales de cada agente.</p>
    </section>`;
}

async function loadCentro({ silent = false } = {}) {
  if (!can('tickets.read')) return;
  if (!silent) {
    state.centroLoading = true;
    state.centroError = '';
    renderCentro();
  }
  try {
    const data = await api('/api/admin/ops/centro');
    state.centro = data;
    state.pendingApprovalCount = Number(data.totals?.pendingApprovals ?? 0) || 0;
    state.centroError = '';
  } catch (error) {
    state.centroError = error.message;
  } finally {
    state.centroLoading = false;
    renderCentro();
  }
}

/* ------------------------------------------------------- oficina del agente */

function officeTicketHtml(row) {
  const unread = Number(row.unread ?? 0) || 0;
  return `
    <button class="ops-row${unread ? ' is-unread' : ''}" data-centro-ticket="${esc(row.id)}" type="button">
      <span class="ops-row__mark" data-type="${esc(row.type)}" aria-hidden="true">${TYPE_ICONS[row.type] ?? TYPE_ICONS.admin}</span>
      <span class="ops-row__body">
        <span class="ops-row__line1">
          <span class="ops-row__num">${esc(row.number)}</span>
          <span class="ops-row__type">${esc(row.typeLabel)}</span>
          <span class="ops-row__time">${esc(stamp(row.lastMessageAt))}</span>
        </span>
        <span class="ops-row__title">${esc(row.title)}</span>
        <span class="ops-row__line2">
          <span class="ops-chip" data-status="${esc(row.status)}">${esc(row.statusLabel)}</span>
          <span class="ops-chip" data-priority="${esc(row.priority)}">${esc(row.priorityLabel)}</span>
          ${row.requiresAck ? '<span class="ops-tag ops-tag--ack">Acuse</span>' : ''}
        </span>
      </span>
      ${unread > 0 ? `<span class="ops-row__count" aria-label="${unread} sin leer">${unread > 99 ? '99+' : unread}</span>` : '<span class="ops-row__count is-empty"></span>'}
    </button>`;
}

function officeTicketsHtml(data) {
  const pending = data.pending ?? [];
  const assigned = data.assigned ?? [];
  const pendingHtml = pending.length
    ? `<div class="centro-block">
        <h3 class="centro-block__title">Trabajo en curso</h3>
        <ul class="centro-work">
          ${pending
            .map(
              (row) => `<li class="centro-work__item">
                <span class="centro-work__num">${esc(row.ticketNumber ?? row.ticketId)}</span>
                <span class="centro-work__what">${esc(row.title ?? '')}</span>
                <span class="centro-chip" data-status="${esc(row.status)}">${esc(RUN_STATE_LABELS[row.status] ?? row.status)}</span>
                ${row.lastError ? `<span class="centro-work__err">${esc(row.lastError.code ?? 'error')}</span>` : ''}
              </li>`,
            )
            .join('')}
        </ul>
      </div>`
    : '';
  const listHtml = assigned.length
    ? `<div class="centro-block">
        <h3 class="centro-block__title">Tickets asignados</h3>
        <div class="centro-tickets">${assigned.map(officeTicketHtml).join('')}</div>
      </div>`
    : `<div class="centro-empty centro-empty--soft">
        <strong>Sin tickets asignados</strong>
        <span>Cuando se le asigne trabajo aparecerá aquí, con su conversación.</span>
      </div>`;
  return pendingHtml + listHtml;
}

function officeActivityHtml(data) {
  const rows = data.activity ?? [];
  if (!rows.length) {
    return '<div class="centro-empty centro-empty--soft"><strong>Sin actividad todavía</strong><span>Los pasos de cada ejecución se verán aquí.</span></div>';
  }
  return `<ul class="centro-feed">
    ${rows
      .map(
        (row) => `<li class="centro-feed__item" data-status="${esc(row.status)}">
          <span class="centro-feed__dot" aria-hidden="true"></span>
          <span class="centro-feed__body">
            <span class="centro-feed__line">
              <strong>${esc(row.summary ?? row.kind ?? 'paso')}</strong>
              <span class="centro-feed__time">${esc(stamp(row.at))}</span>
            </span>
            <span class="centro-feed__meta">
              ${row.ticketNumber ? `<span>${esc(row.ticketNumber)}</span>` : ''}
              <span>${esc(row.kind ?? '')}</span>
              ${row.planner ? `<span>${row.planner === 'llm' ? 'modelo' : 'pauta'}</span>` : ''}
            </span>
          </span>
        </li>`,
      )
      .join('')}
  </ul>`;
}

function officeToolsHtml(data) {
  const tools = data.agent?.tools ?? [];
  if (!tools.length) {
    return '<div class="centro-empty centro-empty--soft"><strong>Sin herramientas</strong><span>Este agente no puede ejecutar nada.</span></div>';
  }
  return `<ul class="centro-tools">
    ${tools
      .map(
        (tool) => `<li class="centro-toolrow">
          <span class="centro-toolrow__head">
            <code class="centro-toolrow__name">${esc(tool.name)}</code>
            <span class="centro-badge" data-risk="${esc(tool.risk)}">${esc(tool.risk === 'high' ? 'riesgo alto' : tool.risk === 'medium' ? 'riesgo medio' : 'riesgo bajo')}</span>
            ${tool.requiresApproval ? '<span class="centro-badge" data-approval="1">con aprobación</span>' : ''}
          </span>
          <span class="centro-toolrow__desc">${esc(tool.description)}</span>
          <span class="centro-toolrow__meta">
            ${tool.permission ? `<span>${esc(tool.permission)}</span>` : ''}
            <span>${Number(tool.timeoutMs ?? 0) / 1000} s</span>
            <span>${tool.idempotent ? 'idempotente' : 'no idempotente'}</span>
          </span>
        </li>`,
      )
      .join('')}
  </ul>`;
}

function officeDelegationsHtml(data) {
  const rows = data.delegations ?? [];
  if (!rows.length) {
    return '<div class="centro-empty centro-empty--soft"><strong>Sin colaboraciones</strong><span>Aquí se ven las ayudas pedidas y recibidas.</span></div>';
  }
  return `<ul class="centro-dels">
    ${rows
      .map(
        (row) => `<li class="centro-del" data-status="${esc(row.status)}">
          <span class="centro-del__head">
            <span class="centro-badge" data-direction="${esc(row.direction)}">${row.direction === 'out' ? 'pidió ayuda' : 'recibió ayuda'}</span>
            <span class="centro-chip" data-status="${esc(row.status)}">${esc(DELEGATION_LABELS[row.status] ?? row.status)}</span>
            ${row.ticketNumber ? `<span class="centro-del__ticket">${esc(row.ticketNumber)}</span>` : ''}
          </span>
          <span class="centro-del__text">${esc(row.question)}</span>
          <span class="centro-del__meta">${esc(row.direction === 'out' ? `a ${row.toName}` : `de ${row.fromName}`)} · ${esc(stamp(row.requestedAt))}</span>
        </li>`,
      )
      .join('')}
  </ul>`;
}

function officeHtml() {
  if (state.officeError) {
    return `<section class="centro-off">
      <button class="centro-back" data-centro-nav="agents" type="button"><span aria-hidden="true">←</span> Agentes</button>
      <div class="centro-empty centro-empty--error">
        <strong>No se pudo abrir la oficina</strong>
        <span>${esc(state.officeError)}</span>
        <button class="centro-btn" data-centro-reload type="button">Reintentar</button>
      </div>
    </section>`;
  }
  const data = state.office;
  if (!data) {
    return `<section class="centro-off">
      <button class="centro-back" data-centro-nav="agents" type="button"><span aria-hidden="true">←</span> Agentes</button>
      <div class="centro-empty"><strong>Abriendo la oficina…</strong></div>
    </section>`;
  }
  /* El Agente de Seguimiento tiene su propia oficina (sin tickets). */
  if (data.work) return workOfficeHtml(data);
  const agent = data.agent;
  const stats = data.stats ?? {};
  const alerts = data.alerts?.length
    ? `<div class="centro-alerts">${data.alerts
        .map((alert) => `<p class="centro-alert" data-tone="${esc(alert.tone)}">${esc(alert.text)}</p>`)
        .join('')}</div>`
    : '';
  const tabs = OFFICE_TABS.map(([key, label]) => {
    const count = key === 'tickets' ? Number(stats.assigned ?? 0) : key === 'tools' ? Number(stats.tools ?? 0) : key === 'delegations' ? Number(stats.delegations ?? 0) : 0;
    return `<button class="centro-tab" data-centro-office-tab="${key}" type="button" aria-current="${state.officeTab === key}">${esc(label)}${count > 0 ? `<span class="centro-tab__count">${count}</span>` : ''}</button>`;
  }).join('');
  const body =
    state.officeTab === 'activity'
      ? officeActivityHtml(data)
      : state.officeTab === 'tools'
        ? officeToolsHtml(data)
        : state.officeTab === 'delegations'
          ? officeDelegationsHtml(data)
          : officeTicketsHtml(data);
  return `
    <section class="centro-off">
      <button class="centro-back" data-centro-nav="agents" type="button"><span aria-hidden="true">←</span> Agentes</button>

      <div class="centro-id">
        <span class="centro-ava centro-ava--lg" data-state="${esc(agent.state)}" aria-hidden="true">${esc(initialsOf(agent.name))}</span>
        <div class="centro-id__main">
          <h2 class="centro-id__name">${esc(agent.name)}<span class="centro-state" data-state="${esc(agent.state)}"><i aria-hidden="true"></i>${esc(STATE_LABELS[agent.state] ?? agent.state)}</span></h2>
          <p class="centro-id__role">${esc(agent.role ?? 'Agente interno')} · v${esc(agent.version)}${agent.planner === 'llm' ? ' · con modelo' : ' · pauta determinista'}</p>
          ${(agent.responsibilities ?? []).length ? `<ul class="centro-id__resp">${agent.responsibilities.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="centro-id__actions">
          <span class="centro-meta" data-kind="pending">${esc(stats.pending ?? 0)} en curso</span>
          <span class="centro-meta" data-kind="unread">${esc(stats.unread ?? 0)} sin leer</span>
          <!-- Su pantalla de siempre se abre DESDE aquí: en el centro no hay un acceso aparte que lo duplique. -->
          ${agent.key === 'delivery_supervisor' ? `<button class="centro-btn centro-btn--ghost" data-centro-nav="supervisor" type="button">Pantalla del supervisor</button>` : ''}
          <button class="centro-btn centro-btn--ghost" data-centro-nav="tickets" type="button">Bandeja completa</button>
        </div>
      </div>

      ${alerts}
      <nav class="centro-tabs" aria-label="Secciones del agente">${tabs}</nav>
      <div class="centro-off__body">${body}</div>
    </section>`;
}

/* ------------------------------------- AGENTE DE SEGUIMIENTO (oficina) */

/*
 * La oficina del Agente de Seguimiento no son tickets: son cuatro secciones
 * sobre el trabajo comercial real (seguimientos y mensajes programados).
 *
 *   Conversar    se pregunta en lenguaje natural; el modelo consulta y PROPONE
 *   Seguimientos listado real con acciones de una persona
 *   Programados  cola real con su estado de envío
 *   Aprobaciones propuestas pendientes + lo último ejecutado o rechazado
 *
 * Las acciones de las listas las hace la PERSONA que está en el panel (por eso
 * no piden aprobación: ella es la aprobación). Las del modelo llegan aquí como
 * propuestas y hay que aprobarlas.
 */

const WORK_TABS = [
  ['chat', 'Conversar'],
  ['followups', 'Seguimientos'],
  ['scheduled', 'Programados'],
  ['approvals', 'Aprobaciones'],
];

function workDayLabel(value) {
  if (!value) return '—';
  const text = String(value);
  const date = new Date(text.length <= 10 ? `${text}T12:00:00` : text);
  if (Number.isNaN(date.getTime())) return '—';
  return dayFmt.format(date);
}

function workWhenLabel(value) {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '—';
  return `${dayFmt.format(date)} · ${timeFmt.format(date)}`;
}

const SCHEDULED_LABELS = {
  SCHEDULED: 'Programado',
  PROCESSING: 'Enviando',
  SENT: 'Enviado',
  DELIVERED: 'Entregado',
  READ: 'Leído',
  FAILED: 'Falló',
  CANCELLED: 'Cancelado',
  BLOCKED: 'Bloqueado',
};

function proposalSummary(params = {}) {
  const bits = [];
  if (params.customerName) bits.push(params.customerName);
  if (params.date) bits.push(`fecha ${params.date}`);
  if (params.scheduledAt) bits.push(workWhenLabel(params.scheduledAt));
  if (params.reason) bits.push(params.reason);
  if (params.text) bits.push(`«${String(params.text).slice(0, 80)}»`);
  return bits.join(' · ');
}

function workChatHtml() {
  const rows = state.workChat
    .map((entry) => {
      if (entry.role === 'user') {
        return `<article class="ops-msg is-mine">
          <p class="ops-msg__who">Tú · ${esc(entry.at)}</p>
          <div class="ops-msg__bubble">${esc(entry.text).replace(/\n/g, '<br>')}</div>
        </article>`;
      }
      const meta = [entry.model ? esc(entry.model) : '', entry.ms ? `${esc(entry.ms)} ms` : ''].filter(Boolean).join(' · ');
      return `<article class="ops-msg ops-msg--agent">
        <p class="ops-msg__who"><span class="ops-chip ops-chip--ai">IA</span> Agente de Seguimiento${meta ? ` · ${meta}` : ''}</p>
        <div class="ops-msg__bubble">${esc(entry.text).replace(/\n/g, '<br>')}</div>
        ${entry.proposals?.length ? `<p class="centro-note">${entry.proposals.length} propuesta(s) enviadas a Aprobaciones. Nada se ha creado todavía.</p>` : ''}
        ${entry.rejected?.length ? `<p class="centro-note">${entry.rejected.length} propuesta(s) descartada(s): ${esc(entry.rejected.map((row) => row.error).join(', '))}</p>` : ''}
      </article>`;
    })
    .join('');
  return `
    <div class="centro-chat">
      ${rows || `<div class="centro-empty centro-empty--soft"><strong>Pregúntame por el trabajo comercial</strong><span>Por ejemplo: «¿qué clientes necesitan seguimiento hoy?» o «prepara un mensaje para recordar la recompra».</span></div>`}
    </div>
    <form class="centro-ask" data-work-ask>
      <textarea id="work-ask" name="message" rows="2" placeholder="Escribe qué necesitas…" ${state.workBusy ? 'disabled' : ''}></textarea>
      <button class="centro-btn" type="submit" ${state.workBusy ? 'disabled' : ''}>${state.workBusy ? 'Pensando…' : 'Preguntar'}</button>
    </form>
    <p class="centro-note">El agente consulta tus datos reales y solo <strong>propone</strong>. Nada se crea, se reprograma ni se envía sin tu aprobación.</p>`;
}

function workFollowupsHtml(work) {
  const groups = [
    ['Vencidos', work.followups.overdue, 'overdue'],
    ['Hoy', work.followups.today, 'today'],
    ['Próximos', work.followups.upcoming, 'upcoming'],
  ].filter(([, rows]) => rows.length);
  const canCancel = can('followups.delete');
  if (!groups.length) {
    return `<div class="centro-empty centro-empty--soft"><strong>Sin seguimientos pendientes</strong><span>Cuando haya tareas de seguimiento aparecerán aquí, con su cliente y su motivo.</span></div>`;
  }
  return groups
    .map(
      ([label, rows]) => `<div class="centro-block">
        <h3 class="centro-block__title">${esc(label)} (${rows.length})</h3>
        <ul class="centro-work">
          ${rows
            .map(
              (row) => `<li class="centro-work__item">
                <span class="centro-work__num">${esc(row.customerName)}</span>
                <span class="centro-work__what">${esc(row.reason ?? 'Seguimiento')}</span>
                <span class="centro-chip" data-status="${esc(row.status ?? 'open')}">${esc(workDayLabel(row.scheduledAt))}</span>
                <span class="centro-work__actions">
                  <button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-fu="complete" data-work-id="${esc(row.id)}" type="button">Completar</button>
                  <button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-fu="postpone" data-work-id="${esc(row.id)}" type="button">+1 día</button>
                  ${canCancel ? `<button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-fu="cancel" data-work-id="${esc(row.id)}" type="button">Cancelar</button>` : ''}
                </span>
              </li>`,
            )
            .join('')}
        </ul>
      </div>`,
    )
    .join('');
}

function workScheduledHtml(work) {
  const rows = work.scheduled.rows.filter((row) => ['SCHEDULED', 'PROCESSING', 'FAILED', 'BLOCKED'].includes(row.status));
  const recent = work.scheduled.rows
    .filter((row) => ['SENT', 'DELIVERED', 'READ', 'CANCELLED'].includes(row.status))
    .slice(-6)
    .reverse();
  const canCancel = can('followups.delete');
  const head = `<div class="centro-block">
    <h3 class="centro-block__title">Cola de envío</h3>
    <p class="centro-note">${esc(work.scheduled.pending)} pendiente(s) · ${esc(work.scheduled.failed)} con problema. El programador los envía por su cuenta, sin depender del navegador ni del modelo.</p>
  </div>`;
  const queue = rows.length
    ? `<ul class="centro-work">
    ${rows
      .map(
        (row) => `<li class="centro-work__item" data-work-status="${esc(row.status)}">
          <span class="centro-work__num">${esc(row.customerName)}</span>
          <span class="centro-work__what">${esc(row.preview ?? 'Sin vista previa')}${row.error ? ` · <span class="centro-work__err">${esc(row.error)}</span>` : ''}</span>
          <span class="centro-chip" data-status="${esc(row.status === 'SCHEDULED' ? 'waiting' : row.status === 'FAILED' || row.status === 'BLOCKED' ? 'resolved' : 'open')}">${esc(SCHEDULED_LABELS[row.status] ?? row.status)}</span>
          <span class="centro-meta">${esc(workWhenLabel(row.scheduledAt))}</span>
          <span class="centro-work__actions">
            ${row.status === 'SCHEDULED' ? `<button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-sch="reschedule" data-work-id="${esc(row.id)}" type="button">+1 hora</button>` : ''}
            ${canCancel && ['SCHEDULED'].includes(row.status) ? `<button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-sch="cancel" data-work-id="${esc(row.id)}" type="button">Cancelar</button>` : ''}
          </span>
        </li>`,
      )
      .join('')}
  </ul>`
    : `<div class="centro-empty centro-empty--soft"><strong>Nada en la cola</strong><span>Los mensajes programados aparecerán aquí con su estado de envío real.</span></div>`;
  /* Historial: lo que YA salió (o se canceló) no se mezcla con lo pendiente. */
  const history = recent.length
    ? `<div class="centro-block">
        <h3 class="centro-block__title">Historial reciente</h3>
        <ul class="centro-work">
          ${recent
            .map(
              (row) => `<li class="centro-work__item" data-work-status="${esc(row.status)}">
                <span class="centro-work__num">${esc(row.customerName)}</span>
                <span class="centro-work__what">${esc(row.preview ?? 'Sin vista previa')}</span>
                <span class="centro-chip" data-status="resolved">${esc(SCHEDULED_LABELS[row.status] ?? row.status)}</span>
                <span class="centro-meta">${esc(workWhenLabel(row.sentAt ?? row.scheduledAt))}</span>
              </li>`,
            )
            .join('')}
        </ul>
      </div>`
    : '';
  return `${head}${queue}${history}`;
}

function workApprovalsHtml(work) {
  const pending = work.proposals ?? [];
  const recent = work.recentProposals ?? [];
  const pendingHtml = pending.length
    ? `<ul class="centro-dels">
        ${pending
          .map(
            (row) => `<li class="centro-del" data-status="pending">
              <span class="centro-del__head">
                <span class="centro-badge${row.risk === 'medium' ? '' : ''}">${esc(row.label)}</span>
                <span class="centro-chip" data-status="waiting">Pendiente</span>
                <span class="centro-del__ticket">${esc(row.decidedAt ? '' : workWhenLabel(row.requestedAt))}</span>
              </span>
              <span class="centro-del__text">${esc(proposalSummary(row.params))}</span>
              ${row.justification ? `<span class="centro-del__meta">${esc(row.justification)}</span>` : ''}
              <span class="centro-work__actions">
                <button class="centro-btn centro-btn--xs" data-work-approve="${esc(row.id)}" type="button" ${state.workBusy ? 'disabled' : ''}>Aprobar</button>
                <button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-reject="${esc(row.id)}" type="button" ${state.workBusy ? 'disabled' : ''}>Rechazar</button>
              </span>
            </li>`,
          )
          .join('')}
      </ul>`
    : `<div class="centro-empty centro-empty--soft"><strong>Sin propuestas pendientes</strong><span>Lo que proponga el agente en la conversación aparecerá aquí para que lo apruebes.</span></div>`;
  const recentHtml = recent.length
    ? `<div class="centro-block">
        <h3 class="centro-block__title">Actividad reciente</h3>
        <ul class="centro-feed">
          ${recent
            .map(
              (row) => `<li class="centro-feed__item" data-status="${row.status === 'consumed' ? 'ok' : row.status === 'rejected' ? 'error' : 'waiting'}">
                <span class="centro-feed__dot" aria-hidden="true"></span>
                <span class="centro-feed__body">
                  <span class="centro-feed__line">
                    <strong>${esc(row.label)}</strong>
                    <span class="centro-feed__time">${esc(workWhenLabel(row.decidedAt))}</span>
                  </span>
                  <span class="centro-feed__meta">
                    <span>${esc(row.statusLabel)}</span>
                    <span>${esc(proposalSummary(row.params))}</span>
                    ${row.decidedByName ? `<span>por ${esc(row.decidedByName)}</span>` : ''}
                  </span>
                </span>
              </li>`,
            )
            .join('')}
        </ul>
      </div>`
    : '';
  return `<div class="centro-block">
      <h3 class="centro-block__title">Propuestas pendientes (${pending.length})</h3>
    </div>${pendingHtml}${recentHtml}`;
}

function workOfficeHtml(data) {
  const agent = data.agent;
  const work = data.work;
  const counts = work.followups.counts;
  const tabs = WORK_TABS.map(([key, label]) => {
    const count =
      key === 'followups'
        ? counts.today + counts.overdue
        : key === 'scheduled'
          ? work.scheduled.pending + work.scheduled.failed
          : key === 'approvals'
            ? work.proposals.length
            : 0;
    return `<button class="centro-tab" data-work-tab="${key}" type="button" aria-current="${state.workTab === key}">${esc(label)}${count > 0 ? `<span class="centro-tab__count">${count}</span>` : ''}</button>`;
  }).join('');
  const body =
    state.workTab === 'followups'
      ? workFollowupsHtml(work)
      : state.workTab === 'scheduled'
        ? workScheduledHtml(work)
        : state.workTab === 'approvals'
          ? workApprovalsHtml(work)
          : workChatHtml(work);
  const link = state.workTab === 'scheduled' ? 'mensajes' : 'seguimientos';
  return `
    <section class="centro-off">
      <button class="centro-back" data-centro-nav="agents" type="button"><span aria-hidden="true">←</span> Agentes</button>

      <div class="centro-id">
        <span class="centro-ava centro-ava--lg" data-state="${esc(agent.state)}" aria-hidden="true">${esc(initialsOf(agent.name))}</span>
        <div class="centro-id__main">
          <h2 class="centro-id__name">${esc(agent.name)}<span class="centro-state" data-state="${esc(agent.state)}"><i aria-hidden="true"></i>${esc(STATE_LABELS[agent.state] ?? agent.state)}</span></h2>
          <p class="centro-id__role">${esc(agent.role ?? 'Seguimientos y mensajes programados')}${agent.planner === 'llm' ? ' · con modelo' : ' · pauta determinista'}</p>
          <ul class="centro-id__resp">
            <li>${esc(counts.today)} para hoy</li>
            <li>${esc(counts.overdue)} vencidos</li>
            <li>${esc(work.scheduled.pending)} programados</li>
            <li>${esc(work.proposals.length)} propuestas</li>
          </ul>
        </div>
        <div class="centro-id__actions">
          <button class="centro-btn centro-btn--ghost centro-btn--xs" data-work-full="${esc(link)}" type="button">Pantalla completa</button>
        </div>
      </div>

      <nav class="centro-tabs" aria-label="Secciones del agente">${tabs}</nav>
      <div class="centro-off__body">${body}</div>
    </section>`;
}

/** Repinta SOLO el cuerpo del centro (la cabecera no se toca). */
function renderCentro() {
  if (!domAlive()) return;
  const host = document.getElementById('centro-body');
  if (!host) return;
  host.innerHTML = state.screen === 'agent' ? officeHtml() : directoryHtml();
  const view = VIEW();
  if (view) view.dataset.centroScreen = state.screen;
  document.querySelectorAll('[data-centro-nav]').forEach((button) => {
    const nav = button.dataset.centroNav;
    if (nav === 'agents' || nav === 'tickets') {
      button.setAttribute('aria-current', String(nav === 'agents' ? state.screen === 'agents' : false));
    }
  });
  renderCentroTools();
}

async function loadOffice(key, { silent = false } = {}) {
  if (!key) return;
  if (!silent) {
    state.office = null;
    state.officeError = '';
    renderCentro();
  }
  try {
    const data = await api(`/api/admin/ops/agents/${encodeURIComponent(key)}/office`);
    state.office = data;
    state.officeError = '';
    if (data?.work && state.workTab === 'tickets') state.workTab = 'chat';
  } catch (error) {
    state.office = null;
    state.officeError = error.message;
  } finally {
    renderCentro();
  }
}

async function openOffice(key) {
  state.screen = 'agent';
  state.officeKey = key;
  state.officeTab = 'tickets';
  state.office = null;
  state.officeError = '';
  ensureShell();
  renderCentro();
  await loadOffice(key);
}

/**
 * Abre un ticket desde el Centro IA.
 *
 * Reutiliza la conversación de siempre: cambia a la pantalla de tickets y deja
 * marcado de dónde se vino, para que el botón de volver regrese a la oficina.
 */
function openTicketFromCentro(id) {
  state.returnTo = state.screen === 'agent' ? 'agent' : 'agents';
  state.screen = 'tickets';
  ensureShell();
  renderRows();
  loadTicket(id);
}

/**
 * Abre el ticket ABIERTO de un pedido (enlace desde una ficha de reparto o de
 * pedido). Si el pedido no tiene ticket, se dice; no se inventa uno.
 */
async function openOrderTicket(orderId) {
  if (!orderId) return;
  try {
    const data = await api(`/api/admin/ops/orders/${encodeURIComponent(orderId)}/ticket`);
    if (data?.ticket?.id) {
      state.returnTo = null;
      state.screen = 'tickets';
      ensureShell();
      renderRows();
      await loadTicket(data.ticket.id);
      return;
    }
    toast('Ese pedido no tiene ticket abierto');
  } catch (error) {
    toast(error.message);
  }
}

/** Lo que el panel pide desde cualquier módulo: «abre el Centro IA en…». */
function onOpenRequest(event) {
  const detail = event?.detail ?? {};
  if (state.tab !== 'ops') return;
  if (detail.orderId) {
    boot().then(() => openOrderTicket(detail.orderId));
    return;
  }
  if (detail.ticketId) {
    boot().then(() => loadTicket(detail.ticketId));
  }
}

/** Vuelve del chat a la oficina (o al equipo) sin perder el contexto. */
function backToCentro() {
  const target = state.returnTo;
  state.returnTo = null;
  state.selectedId = '';
  state.ticket = null;
  state.messages = [];
  state.events = [];
  state.menuOpen = false;
  if (target === 'agent' && state.officeKey) {
    state.screen = 'agent';
    ensureShell();
    renderCentro();
    loadOffice(state.officeKey, { silent: true });
    return;
  }
  state.screen = 'agents';
  ensureShell();
  renderCentro();
  loadCentro({ silent: true });
}

/* ------------------------- acciones del Agente de Seguimiento */

/** Refresca la oficina de trabajo (seguimientos, cola y propuestas). */
async function refreshWorkOffice() {
  if (!state.officeKey) return;
  await loadOffice(state.officeKey, { silent: true });
}

/**
 * Pregunta al agente.
 *
 * La respuesta es texto + PROPUESTAS validadas por el servidor. Aquí no se
 * escribe nada: si algo hay que hacer, se aprueba en «Aprobaciones».
 */
async function submitWorkAsk(rawText) {
  const message = String(rawText ?? '').trim();
  if (!message || state.workBusy) return;
  state.workBusy = 'ask';
  state.workChat.push({ role: 'user', text: message, at: timeFmt.format(new Date()) });
  renderCentro();
  try {
    const data = await api('/api/admin/ops/work/chat', { method: 'POST', body: JSON.stringify({ message }) });
    state.workChat.push({
      role: 'agent',
      text: data.reply ?? 'No tengo una respuesta para eso.',
      proposals: data.proposals ?? [],
      rejected: data.rejected ?? [],
      model: data.model ?? null,
      ms: data.ms ?? null,
      at: timeFmt.format(new Date()),
    });
  } catch (error) {
    /* Si el modelo no está, se dice: las listas y la cola siguen funcionando. */
    state.workChat.push({ role: 'agent', text: error.message, at: timeFmt.format(new Date()) });
  } finally {
    state.workBusy = '';
    await refreshWorkOffice();
  }
}

/** Aprueba o rechaza una propuesta (la persona es quien decide). */
async function decideWorkProposalUi(proposalId, approve) {
  if (!proposalId || state.workBusy) return;
  state.workBusy = 'decide';
  renderCentro();
  try {
    const data = await api(`/api/admin/ops/work/proposals/${encodeURIComponent(proposalId)}/${approve ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: JSON.stringify({ note: approve ? '' : 'Rechazada desde el Centro IA' }),
    });
    if (approve) toast(data.executed ? 'Aprobada y ejecutada' : 'Aprobada, pero no se pudo ejecutar');
    else toast('Propuesta rechazada');
  } catch (error) {
    toast(error.message);
  } finally {
    state.workBusy = '';
    await refreshWorkOffice();
  }
}

/** Acción de una persona sobre un seguimiento (usa la ruta de siempre). */
async function workFollowupAction(action, followupId) {
  if (!followupId) return;
  const payload =
    action === 'postpone'
      ? { action: 'postpone', days: 1 }
      : action === 'cancel'
        ? { action: 'cancel', reason: 'Cancelado desde el Centro IA' }
        : { action: 'complete' };
  try {
    await api(`/api/admin/followups/${encodeURIComponent(followupId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast(action === 'complete' ? 'Seguimiento completado' : action === 'postpone' ? 'Movido un día' : 'Seguimiento cancelado');
    await refreshWorkOffice();
  } catch (error) {
    toast(error.message);
  }
}

/** Acción de una persona sobre un mensaje programado (ruta de siempre). */
async function workScheduledAction(action, scheduledId) {
  if (!scheduledId) return;
  const payload =
    action === 'cancel'
      ? { action: 'cancel', reason: 'Cancelado desde el Centro IA' }
      : { action: 'reschedule', scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  try {
    await api(`/api/admin/scheduled/${encodeURIComponent(scheduledId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast(action === 'cancel' ? 'Mensaje cancelado' : 'Reprogramado una hora más tarde');
    await refreshWorkOffice();
  } catch (error) {
    toast(error.message);
  }
}

/* --------------------------------------------------------------- bandeja */

function rowsHtml() {
  if (state.loading && !state.items.length) return `<p class="ops-empty">Cargando tickets…</p>`;
  if (state.error) return `<p class="ops-empty ops-empty--error">${esc(state.error)}</p>`;
  if (!state.items.length) {
    return `<div class="ops-empty"><strong>Sin tickets aquí</strong><span>${esc(
      state.filter === 'resueltos' ? 'Todavía no hay tickets cerrados.' : 'Cuando algo necesite seguimiento, aparecerá en esta lista.',
    )}</span>${can('tickets.create') ? '<button class="ops-btn ops-btn--ghost" data-ops-new type="button">Abrir el primero</button>' : ''}</div>`;
  }
  return state.items
    .map((item) => {
      const unread = item.unread ? ' is-unread' : '';
      const active = item.id === state.selectedId ? ' is-active' : '';
      const assigned = item.assignedUserName ? `<span class="ops-tag">${esc(item.assignedUserName)}</span>` : '';
      const due = item.dueState === 'overdue' ? '<span class="ops-tag ops-tag--due">Vencido</span>' : '';
      const ack =
        item.requiresAck && !item.task?.acknowledgedAt ? '<span class="ops-tag ops-tag--ack">Acuse</span>' : '';
      const done = item.task?.completedAt ? '<span class="ops-tag ops-tag--done">Hecho</span>' : '';
      const count = Number(item.unreadCount ?? 0) || 0;
      return `
        <button class="ops-row${unread}${active}" data-ops-open="${esc(item.id)}" type="button"
          aria-current="${item.id === state.selectedId}">
          <span class="ops-row__mark" data-type="${esc(item.type)}" aria-hidden="true">${TYPE_ICONS[item.type] ?? TYPE_ICONS.admin}</span>
          <span class="ops-row__body">
            <span class="ops-row__line1">
              <span class="ops-row__num">${esc(item.number)}</span>
              <span class="ops-row__type">${esc(item.typeLabel)}</span>
              <span class="ops-row__time">${esc(stamp(item.lastMessageAt ?? item.createdAt))}</span>
            </span>
            <span class="ops-row__title">${esc(item.title)}</span>
            <span class="ops-row__line2">
              <span class="ops-chip" data-status="${esc(item.status)}">${esc(item.statusLabel)}</span>
              <span class="ops-chip" data-priority="${esc(item.priority)}">${esc(item.priorityLabel)}</span>
              ${assigned}
              ${due}
              ${ack}
              ${done}
            </span>
            <span class="ops-row__preview">${esc(item.lastMessagePreview ?? item.description ?? 'Sin mensajes todavía')}</span>
          </span>
          ${count > 0 ? `<span class="ops-row__count" aria-label="${count} sin leer">${count > 99 ? '99+' : count}</span>` : '<span class="ops-row__count is-empty"></span>'}
        </button>`;
    })
    .join('');
}

function renderRows() {
  if (!domAlive()) return;
  const host = document.getElementById('ops-rows');
  if (!host) return;
  host.innerHTML = rowsHtml();
  document.querySelectorAll('[data-ops-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.opsFilter === state.filter));
  });
  renderAdminBar();
  pintarBadge();
}

/** Repinta la barra de administración (el contador de aprobaciones cambia). */
function renderAdminBar() {
  if (!domAlive()) return;
  const current = document.getElementById('ops-adminbar');
  const html = adminBarHtml();
  if (!current) {
    if (!html) return;
    const tools = document.querySelector('.ops-list__tools');
    if (tools) tools.insertAdjacentHTML('afterend', html);
    return;
  }
  if (!html) {
    current.remove();
    return;
  }
  current.outerHTML = html;
}

/** Distintivo del menú lateral: total de mensajes sin leer (lo lee `app.js`). */
function pintarBadge() {
  if (!domAlive()) return;
  const badge = document.querySelector('[data-drawer-badge="ops"]');
  const total = state.items.reduce((sum, item) => sum + (Number(item.unreadCount ?? 0) || 0), 0);
  state.totalUnread = total;
  if (!badge) return;
  badge.hidden = total === 0;
  badge.textContent = total > 99 ? '99+' : String(total);
}

async function loadInbox({ silent = false } = {}) {
  if (!can('tickets.read')) return;
  if (!silent) {
    state.loading = true;
    state.error = '';
    renderRows();
  }
  try {
    const params = new URLSearchParams({ filter: state.filter });
    if (state.q) params.set('q', state.q);
    const data = await api(`/api/admin/ops/inbox?${params}`);
    state.items = data.items ?? [];
    state.pendingApprovalCount = Number(data.pendingApprovals ?? 0) || 0;
    state.error = '';
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    renderRows();
  }
}

/* ----------------------------------------------------------- conversación */

function chatHeadHtml() {
  const ticket = state.ticket;
  if (!ticket) {
    return `<div class="ops-chat__empty">${ICONS.info}<span>Elige un ticket de la lista</span></div>`;
  }
  const menu = state.menuOpen ? menuHtml(ticket) : '';
  const unread = Number(ticket.unreadCount ?? 0) || 0;
  /* Si el ticket se abrió desde la oficina de un agente, volver vuelve allí. */
  const fromOffice = state.returnTo === 'agent';
  return `
    <button class="ops-iconbtn ops-back" data-ops-back type="button" aria-label="${fromOffice ? 'Volver a la oficina del agente' : 'Volver a la lista'}">${ICONS.back}</button>
    <div class="ops-chat__who">
      <p class="ops-chat__num">${esc(ticket.number)}<span class="ops-chip" data-status="${esc(ticket.status)}">${esc(ticket.statusLabel)}</span>${
        unread > 0 ? `<span class="ops-chip ops-chip--unread">${unread} sin leer</span>` : ''
      }${
        ticket.assignedAgentId ? `<span class="ops-chip ops-chip--ai">IA · ${esc(ticket.assignedAgentName ?? ticket.assignedAgentId)}</span>` : ''
      }</p>
      <h2 class="ops-chat__title">${esc(ticket.title)}</h2>
    </div>
    <button class="ops-iconbtn" data-ops-detail type="button" aria-label="Ficha del ticket">${ICONS.info}</button>
    <button class="ops-iconbtn" data-ops-menu type="button" aria-label="Acciones del ticket" aria-expanded="${state.menuOpen}">${ICONS.more}</button>
    ${menu}`;
}

function menuHtml(ticket) {
  const items = [];
  if (state.permissions?.update) {
    items.push(`<button class="ops-menu__item" data-ops-act="in_progress" type="button">${ICONS.check}<span>Marcar en curso</span></button>`);
    items.push(`<button class="ops-menu__item" data-ops-act="waiting-human" type="button">${ICONS.clock}<span>Esperando a una persona</span></button>`);
    items.push(`<button class="ops-menu__item" data-ops-act="waiting-agent" type="button">${ICONS.clock}<span>Esperando a un agente</span></button>`);
    items.push(`<button class="ops-menu__item" data-ops-act="waiting-external" type="button">${ICONS.clock}<span>Esperando respuesta externa</span></button>`);
    items.push(
      `<button class="ops-menu__item" data-ops-act="claim" type="button">${ICONS.check}<span>${
        ticket.assignedUserId === state.session?.user?.id ? 'Ya está a tu nombre' : 'Asignármelo'
      }</span></button>`,
    );
  }
  items.push(`<button class="ops-menu__item" data-ops-act="detail" type="button">${ICONS.info}<span>Ficha del ticket</span></button>`);
  if (state.permissions?.close) {
    items.push(`<button class="ops-menu__item ops-menu__item--danger" data-ops-act="resolve" type="button">${ICONS.check}<span>Resolver el ticket</span></button>`);
  }
  if (!items.length) return '<div class="ops-menu"><p class="ops-menu__note">Solo lectura para tu rol.</p></div>';
  return `<div class="ops-menu" role="menu">${items.join('')}</div>`;
}

function threadHtml() {
  const ticket = state.ticket;
  if (!ticket) {
    return `<div class="ops-thread__empty">
      <p><strong>Centro de operaciones</strong></p>
      <p>Cada pedido, entrega o incidencia es un ticket con su conversación. Elige uno a la izquierda.</p>
    </div>`;
  }
  const rows = [];
  if (state.hasMore) {
    rows.push(
      `<div class="ops-older"><button class="ops-btn ops-btn--ghost" data-ops-older type="button" ${state.loadingOlder ? 'disabled' : ''}>${
        state.loadingOlder ? 'Cargando…' : 'Ver mensajes anteriores'
      }</button></div>`,
    );
  }
  let lastDay = '';
  for (const message of state.messages) {
    const day = dayLabel(message.createdAt);
    if (day && day !== lastDay) {
      rows.push(`<div class="ops-day"><span>${esc(day)}</span></div>`);
      lastDay = day;
    }
    const mine = message.authorId && message.authorId === state.session?.user?.id;
    const isAgent = message.authorType === 'agent';
    rows.push(`
      <article class="ops-msg${mine ? ' is-mine' : ''}${isAgent ? ' ops-msg--agent' : ''}" data-seq="${message.seq}">
        <p class="ops-msg__who">${
          isAgent ? `<span class="ops-chip ops-chip--ai">IA</span> ${esc(message.authorName ?? 'Agente')}` : esc(message.authorName ?? 'Equipo')
        } · ${esc(stamp(message.createdAt))}</p>
        <div class="ops-msg__bubble">${esc(message.body).replace(/\n/g, '<br>')}</div>
        ${message.kind === 'approval_request' ? approvalCardHtml(message) : ''}
      </article>`);
  }
  /* Un aviso de aprobación cuyo mensaje no llegó a pintarse (hilo paginado). */
  for (const approval of pendingApprovals().filter((row) => !state.messages.some((m) => m.meta?.approvalId === row.id))) {
    rows.push(`<article class="ops-msg ops-msg--agent">${approvalCardHtml(null, approval)}</article>`);
  }
  /* La línea de tiempo (acuses, cambios de estado) se pinta como hechos sueltos. */
  for (const event of state.events) {
    rows.push(
      `<div class="ops-event"><span>${esc(event.actorName ?? 'Sistema')} · ${esc(event.summary ?? event.kind)} · ${esc(stamp(event.at))}</span></div>`,
    );
  }
  if (!state.messages.length && !state.events.length) {
    rows.push(`<div class="ops-thread__empty"><p>Todavía no hay mensajes. Escribe el primero para dejar constancia.</p></div>`);
  }
  return rows.join('');
}

/** Chips del estado de la TAREA (distinto del estado del ticket y del mensaje). */
function taskChipsHtml(ticket) {
  const task = ticket?.task ?? {};
  const chips = [];
  if (ticket?.requiresAck && !task.acknowledgedAt) {
    chips.push('<span class="ops-chip" data-status="waiting" title="Alguien tiene que confirmar que lo vio">Acuse pendiente</span>');
  }
  if (task.acknowledgedAt) {
    chips.push(
      `<span class="ops-chip" data-status="in_progress" title="${esc(`Acusó ${task.acknowledgedByName ?? ''} · ${stamp(task.acknowledgedAt)}`)}">Acusado</span>`,
    );
  }
  if (task.completedAt) {
    chips.push(
      `<span class="ops-chip" data-status="resolved" title="${esc(`Completó ${task.completedByName ?? ''} · ${stamp(task.completedAt)}`)}">Trabajo hecho</span>`,
    );
  }
  if (task.escalatedAt) {
    chips.push('<span class="ops-chip" data-priority="urgent" title="Escalado para que lo revise una persona">Escalado</span>');
  }
  return chips.join('');
}

function taskMenuHtml() {
  return `<div class="ops-taskmenu" role="menu">
    ${TASK_ACTIONS.filter((action) => taskAllowed(action.permission))
      .map((action) => `<button class="ops-menu__item" data-ops-task="${action.id}" type="button">${ICONS[action.icon] ?? ICONS.check}<span>${action.label}</span></button>`)
      .join('')}
  </div>`;
}

function mentionMenuHtml() {
  const rows = (state.participants ?? []).filter((row) => row.userId && row.userId !== state.session?.user?.id);
  if (!rows.length) return '<div class="ops-taskmenu"><p class="ops-menu__note">No hay otros participantes.</p></div>';
  return `<div class="ops-taskmenu" role="menu">
    ${rows
      .map(
        (row) => `<button class="ops-menu__item" data-ops-mention-user="${esc(row.name)}" type="button">${ICONS.user}<span>${esc(row.name)}</span></button>`,
      )
      .join('')}
  </div>`;
}

function composerHtml() {
  const ticket = state.ticket;
  if (!ticket) return '';
  if (!state.permissions?.reply) {
    return `<p class="ops-composer__note">Tu rol puede leer este ticket pero no escribir en él.</p>`;
  }
  if (['resolved', 'cancelled'].includes(ticket.status)) {
    return `<p class="ops-composer__note">${ICONS.check} Ticket ${esc(ticket.statusLabel.toLowerCase())}: el hilo queda como histórico.</p>`;
  }
  const ack =
    state.permissions?.ack && ticket.ackPending
      ? `<button class="ops-ack" data-ops-ack type="button" title="Acusar recibo sin cerrar el ticket">${ICONS.check}<span>Acusar recibo</span></button>`
      : '';
  return `
    <div class="ops-taskbar">
      <span class="ops-taskbar__chips">${taskChipsHtml(ticket)}</span>
      <button class="ops-taskbar__btn" data-ops-task-menu type="button" aria-expanded="${state.taskMenu}">
        ${ICONS.check}<span>Trabajo</span>
      </button>
      ${state.taskMenu ? taskMenuHtml() : ''}
    </div>
    ${ack}
    <form class="ops-composer__bar" data-ops-compose>
      <textarea id="ops-text" rows="1" placeholder="Escribe al equipo…" autocomplete="off" aria-label="Mensaje interno"></textarea>
      <button class="ops-iconbtn ops-mention" data-ops-mention type="button" aria-label="Mencionar a alguien" aria-expanded="${state.mentionMenu}">@</button>
      <button class="ops-send" type="submit" aria-label="Enviar" ${state.sending ? 'disabled' : ''}>${ICONS.send}</button>
      ${state.mentionMenu ? mentionMenuHtml() : ''}
    </form>`;
}

function renderChat() {
  if (!domAlive()) return;
  const head = document.getElementById('ops-chat-head');
  const thread = document.getElementById('ops-thread');
  const composer = document.getElementById('ops-composer');
  if (!head || !thread || !composer) return;
  head.innerHTML = chatHeadHtml();
  thread.innerHTML = threadHtml();
  composer.innerHTML = composerHtml();
  const root = document.querySelector('.ops');
  const view = state.ticket ? 'chat' : 'list';
  if (root) root.dataset.opsView = view;
  /* En móvil la cabecera general se retira en la conversación (su propio ← basta). */
  document.body.dataset.opsView = view;
  if (state.detailOpen) renderDetail();
  autoGrow();
  scrollThread();
}

function scrollThread() {
  if (!domAlive()) return;
  const thread = document.getElementById('ops-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function autoGrow() {
  if (!domAlive()) return;
  const field = document.getElementById('ops-text');
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
}

async function loadTicket(id, { silent = false } = {}) {
  if (!id) return;
  if (!silent) {
    state.ticket = state.ticket?.id === id ? state.ticket : null;
    renderChat();
  }
  try {
    const data = await api(`/api/admin/ops/tickets/${encodeURIComponent(id)}`);
    if (!domAlive()) return;
    state.selectedId = id;
    state.ticket = data.ticket;
    state.messages = data.messages ?? [];
    state.events = data.events ?? [];
    state.participants = data.participants ?? [];
    state.permissions = data.permissions ?? null;
    state.hasMore = Boolean(data.hasMore);
    state.oldestSeq = data.oldestSeq ?? null;
    state.approvals = data.approvals ?? [];
    state.runs = data.runs ?? [];
    state.activeThreadAt = Date.now();
    renderChat();
    renderRows();
    if (state.detailOpen) renderDetail();
    markRead(data.ticket?.lastSeq ?? 0);
  } catch (error) {
    toast(error.message);
    if (error.status === 403 || error.status === 404) {
      state.selectedId = '';
      state.ticket = null;
      renderChat();
    }
  }
}

/** Página anterior de mensajes (se antepone sin perder el hilo actual). */
async function loadOlder() {
  const ticket = state.ticket;
  if (!ticket || !state.hasMore || state.loadingOlder) return;
  state.loadingOlder = true;
  renderChat();
  const thread = document.getElementById('ops-thread');
  const before = thread ? thread.scrollHeight : 0;
  try {
    const data = await api(
      `/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}?before=${encodeURIComponent(state.oldestSeq ?? '')}`,
    );
    const older = data.messages ?? [];
    if (older.length) state.messages = [...older, ...state.messages];
    state.hasMore = Boolean(data.hasMore);
    state.oldestSeq = data.oldestSeq ?? state.oldestSeq;
  } catch (error) {
    toast(error.message);
  } finally {
    state.loadingOlder = false;
    renderChat();
    /* Se mantiene la posición de lectura: lo nuevo queda por encima. */
    const after = document.getElementById('ops-thread');
    if (after) after.scrollTop = after.scrollHeight - before;
  }
}

async function markRead(seq) {
  const ticket = state.ticket;
  if (!ticket || !seq) return;
  try {
    const result = await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}/read`, {
      method: 'POST',
      body: JSON.stringify({ seq }),
    });
    if (!domAlive()) return;
    ticket.myReadSeq = result.lastReadSeq ?? seq;
    ticket.myAckSeq = result.lastAckSeq ?? ticket.myAckSeq;
    ticket.unread = false;
    ticket.unreadCount = 0;
    ticket.ackPending = Number(ticket.lastSeq) > Number(ticket.myAckSeq);
    const row = state.items.find((item) => item.id === ticket.id);
    if (row) {
      row.unread = false;
      row.unreadCount = 0;
      row.myReadSeq = ticket.myReadSeq;
      row.ackPending = ticket.ackPending;
    }
    renderRows();
    composerRefresh();
  } catch {
    /* leer no es crítico: si falla, la próxima apertura lo reintenta */
  }
}

function composerRefresh() {
  if (!domAlive()) return;
  const composer = document.getElementById('ops-composer');
  if (!composer) return;
  composer.innerHTML = composerHtml();
  autoGrow();
}

/* --------------------------------------------------------------- acciones */

async function sendMessage() {
  const field = document.getElementById('ops-text');
  const ticket = state.ticket;
  if (!field || !ticket || state.sending) return;
  const body = field.value.trim();
  if (!body) return;
  state.sending = true;
  const key = clientKey(`opm-${ticket.id}`);
  try {
    const result = await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, clientKey: key }),
    });
    field.value = '';
    autoGrow();
    state.sending = false;
    if (result.message) {
      state.messages.push(result.message);
      if (result.ticket) state.ticket = { ...state.ticket, ...result.ticket };
      renderChat();
      field.focus();
      /*
       * Lo que acabo de escribir lo he visto: se marca leído en el servidor.
       * Sin esto, la proyección que vuelve del envío trae `myReadSeq: 0` y el
       * botón «Acusar recibo» no aparecería nunca en un hilo propio.
       */
      await markRead(result.ticket?.lastSeq ?? state.ticket?.lastSeq ?? 0);
    } else {
      await loadTicket(ticket.id, { silent: true });
    }
  } catch (error) {
    state.sending = false;
    toast(error.message);
    composerRefresh();
  }
}

async function ackReceipt() {
  const ticket = state.ticket;
  if (!ticket) return;
  try {
    await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ seq: ticket.lastSeq }),
    });
    toast('Acuse registrado. El ticket sigue abierto.');
    await loadTicket(ticket.id, { silent: true });
  } catch (error) {
    toast(error.message);
  }
}

async function patchTicket(patch) {
  const ticket = state.ticket;
  if (!ticket) return;
  try {
    await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    state.menuOpen = false;
    await loadTicket(ticket.id, { silent: true });
    await loadInbox({ silent: true });
  } catch (error) {
    toast(error.message);
  }
}

function openResolve() {
  state.menuOpen = false;
  state.resolveOpen = true;
  state.sheetMode = 'resolve';
  state.detailOpen = false;
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  card.innerHTML = `
    <header class="ops-sheet__head">
      <h2 id="ops-sheet-title">Resolver ${esc(state.ticket?.number ?? '')}</h2>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <form class="ops-sheet__body" data-ops-resolve-form>
      <label class="ops-field">
        <span>Cómo quedó (opcional)</span>
        <textarea name="resolution" rows="3" placeholder="Ej.: se entregó y se cobró en efectivo"></textarea>
      </label>
      <p class="ops-hint">Cerrar libera el flujo: ese pedido podrá tener otro ticket más adelante. El historial de este no se borra.</p>
      <footer class="ops-sheet__foot">
        <button class="ops-btn ops-btn--ghost" data-ops-sheet-close type="button">Cancelar</button>
        <button class="ops-btn ops-btn--primary" type="submit">Resolver</button>
      </footer>
    </form>`;
  sheet.hidden = false;
  card.querySelector('textarea')?.focus();
  renderChat();
}

/* ------------------------------------------------------- ficha del ticket */

const chip = (label, status = null, priority = null) =>
  `<span class="ops-chip"${status ? ` data-status="${esc(status)}"` : ''}${priority ? ` data-priority="${esc(priority)}"` : ''}>${esc(label)}</span>`;

const dateStamp = (value) => (value ? `${stamp(value)} · ${dayFmt.format(new Date(value))}` : '—');

/** Hora legible con día, para plazos y fechas de la ficha. */
function fullStamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${dayFmt.format(date)} ${timeFmt.format(date)}`;
}

function personState(row) {
  const bits = [];
  if (row.unreadCount > 0) bits.push(`${row.unreadCount} sin leer`);
  bits.push(row.lastReadSeq > 0 ? `leyó #${row.lastReadSeq}` : 'no ha abierto');
  if (row.lastAckSeq > 0) bits.push(`acusó #${row.lastAckSeq}`);
  if (row.lastNotifiedSeq > 0) bits.push(`avisado #${row.lastNotifiedSeq}`);
  return bits.join(' · ');
}

function detailHtml() {
  const ticket = state.ticket;
  if (!ticket) return '';
  const task = ticket.task ?? {};
  const myId = state.session?.user?.id ?? '';
  const rows = [
    ['Estado', chip(ticket.statusLabel, ticket.status)],
    ['Prioridad', chip(ticket.priorityLabel, null, ticket.priority)],
    ['Tipo', esc(ticket.typeLabel)],
    ['Responsable', ticket.assignedUserName ? esc(ticket.assignedUserName) : '<span class="ops-muted">Sin asignar</span>'],
    ['Agentes IA', ticket.assignedAgentId ? esc(ticket.assignedAgentId) : '<span class="ops-muted">Ninguno autorizado todavía</span>'],
    [
      'Pedido',
      ticket.orderNumber || ticket.entityId
        ? `${esc(ticket.orderNumber ?? ticket.entityId)}${ticket.orderStatus ? ` · ${esc(ticket.orderStatus)}` : ''}${
            ticket.customerName ? ` · ${esc(ticket.customerName)}` : ''
          }`
        : '<span class="ops-muted">Sin vincular</span>',
    ],
    ['Abierto', `${fullStamp(ticket.createdAt)}${ticket.createdByName ? ` · ${esc(ticket.createdByName)}` : ''}`],
    ['Plazo', ticket.dueAt ? `${fullStamp(ticket.dueAt)}${ticket.dueState === 'overdue' ? ' · vencido' : ''}` : '—'],
    ['Seguimiento', ticket.followUpAt ? fullStamp(ticket.followUpAt) : '—'],
  ];

  const taskRows = [
    ['Acuse', task.acknowledgedAt ? `${fullStamp(task.acknowledgedAt)} · ${esc(task.acknowledgedByName ?? '')}` : ticket.requiresAck ? '<span class="ops-muted">Pendiente</span>' : 'No requiere'],
    ['Inicio', task.startedAt ? `${fullStamp(task.startedAt)} · ${esc(task.startedByName ?? '')}` : '—'],
    ['Último avance', task.lastProgressAt ? `${fullStamp(task.lastProgressAt)} · ${esc(task.lastProgressByName ?? '')}` : '—'],
    ['Incidencias', task.issueCount ? `${task.issueCount}${task.lastIssueAt ? ` · última ${fullStamp(task.lastIssueAt)}` : ''}` : '—'],
    ['Ayuda', task.helpCount ? `${task.helpCount} solicitud(es)` : '—'],
    ['Completado', task.completedAt ? `${fullStamp(task.completedAt)} · ${esc(task.completedByName ?? '')}` : '<span class="ops-muted">Sin completar</span>'],
    ['Escalado', task.escalatedAt ? `${fullStamp(task.escalatedAt)} · ${esc(task.escalatedByName ?? '')}` : '—'],
  ];
  if (task.escalationReason) taskRows.push(['Motivo', esc(task.escalationReason)]);

  /* Los agentes NO se mezclan con las personas: tienen su propio bloque. */
  const participants = (state.participants ?? []).filter((row) => (row.type ?? 'user') !== 'agent');
  const present = new Set(participants.map((row) => row.userId));
  const candidates = (state.directory ?? []).filter((user) => !present.has(user.id));

  const activity = (state.events ?? []).slice(-12).reverse();

  return `
    <header class="ops-sheet__head">
      <div class="ops-detail__title">
        <p class="ops-chat__num">${esc(ticket.number)} ${chip(ticket.statusLabel, ticket.status)} ${chip(ticket.priorityLabel, null, ticket.priority)}</p>
        <h2 id="ops-sheet-title">${esc(ticket.title)}</h2>
      </div>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <div class="ops-sheet__body ops-detail">
      ${ticket.description ? `<p class="ops-detail__desc">${esc(ticket.description)}</p>` : ''}
      <dl class="ops-facts">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>

      <h3 class="ops-detail__h">Trabajo</h3>
      <dl class="ops-facts">${taskRows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>
      <div class="ops-detail__actions">
        ${state.permissions?.ack ? `<button class="ops-btn" data-ops-task="acknowledge" type="button">Acusar recibo</button>` : ''}
        <button class="ops-btn" data-ops-task="start" type="button">Iniciar</button>
        <button class="ops-btn" data-ops-task="progress" type="button">Avance</button>
        <button class="ops-btn" data-ops-task="issue" type="button">Problema</button>
        <button class="ops-btn" data-ops-task="complete" type="button">Completar</button>
        <button class="ops-btn" data-ops-task="escalate" type="button">Escalar</button>
      </div>

      <h3 class="ops-detail__h">Participantes <span class="ops-muted">(${participants.length})</span></h3>
      <ul class="ops-people">
        ${
          participants.length
            ? participants
                .map(
                  (row) => `<li class="ops-person">
                    <span class="ops-person__avatar" aria-hidden="true">${esc((row.name ?? '?').slice(0, 1).toUpperCase())}</span>
                    <span class="ops-person__body">
                      <span class="ops-person__name">${esc(row.name)}${row.userId === myId ? ' <span class="ops-muted">(tú)</span>' : ''}</span>
                      <span class="ops-person__meta">${esc(row.role)} · ${esc(personState(row))}</span>
                    </span>
                    ${
                      state.permissions?.manageParticipants && row.userId !== ticket.assignedUserId && participants.length > 1
                        ? `<button class="ops-iconbtn ops-person__drop" data-ops-drop-user="${esc(row.userId)}" type="button" aria-label="Quitar del ticket">${ICONS.close}</button>`
                        : ''
                    }
                  </li>`,
                )
                .join('')
            : '<li class="ops-muted">Sin participantes.</li>'
        }
      </ul>
      ${
        state.permissions?.manageParticipants
          ? `<div class="ops-add">
               <select id="ops-add-user" aria-label="Añadir participante">
                 <option value="">Añadir a alguien…</option>
                 ${candidates.map((user) => `<option value="${esc(user.id)}">${esc(user.name)} · ${esc(user.role)}</option>`).join('')}
               </select>
               <button class="ops-btn" data-ops-add-user type="button">Añadir</button>
             </div>`
          : ''
      }

      <h3 class="ops-detail__h">Agentes <span class="ops-muted">(${(state.approvals ?? []).filter((row) => row.status === 'pending').length} ${
        (state.approvals ?? []).filter((row) => row.status === 'pending').length === 1 ? 'pendiente' : 'pendientes'
      })</span></h3>
      ${agentBoxHtml()}

      <h3 class="ops-detail__h">Actividad</h3>
      <ul class="ops-activity">
        ${
          activity.length
            ? activity
                .map(
                  (event) => `<li><span class="ops-activity__when">${esc(stamp(event.at))}</span>
                    <span class="ops-activity__what"><strong>${esc(event.actorName ?? 'Sistema')}</strong> ${esc(event.summary ?? event.kind)}</span></li>`,
                )
                .join('')
            : '<li class="ops-muted">Todavía no hay actividad registrada.</li>'
        }
      </ul>
      <footer class="ops-sheet__foot">
        ${state.permissions?.update ? `<button class="ops-btn" data-ops-act="claim" type="button">Asignármelo</button>` : ''}
        ${state.permissions?.close ? `<button class="ops-btn ops-btn--primary" data-ops-act="resolve" type="button">Resolver</button>` : ''}
      </footer>
    </div>`;
}

const RUN_STATE_LABELS = {
  pending: 'En cola',
  running: 'Trabajando',
  waiting_human: 'Espera tu aprobación',
  waiting_event: 'En espera',
  succeeded: 'Terminado',
  failed: 'Con error',
  cancelled: 'Cancelado',
};

/**
 * Bloque de agentes de la ficha: quién trabaja el ticket, cuántas aprobaciones
 * hay pendientes y en qué estado está su última ejecución.
 */
function agentBoxHtml() {
  const ticket = state.ticket;
  const runs = state.runs ?? [];
  const lastRun = runs[0] ?? null;
  const approvals = state.approvals ?? [];
  const pending = approvals.filter((row) => row.status === 'pending');
  const candidates = (state.agents ?? []).filter(
    (agent) => agent.enabled !== false && (agent.ticketTypes ?? []).includes(ticket.type),
  );
  const rows = [];
  if (ticket.assignedAgentId) {
    rows.push(
      `<li class="ops-person ops-agent-run" data-agent="${esc(ticket.assignedAgentId)}">
        <span class="ops-person__avatar ops-person__avatar--ai" aria-hidden="true">IA</span>
        <span class="ops-person__body">
          <span class="ops-person__name">${esc(ticket.assignedAgentName ?? ticket.assignedAgentId)}</span>
          <span class="ops-person__meta">${esc(lastRun ? RUN_STATE_LABELS[lastRun.status] ?? lastRun.status : 'Sin ejecuciones')}${
            lastRun?.step ? ` · paso ${lastRun.step}` : ''
          }${lastRun?.lastError?.code ? ` · ${esc(lastRun.lastError.code)}` : ''}</span>
        </span>
      </li>`,
    );
  }
  return `
    ${rows.length ? `<ul class="ops-people">${rows.join('')}</ul>` : '<p class="ops-muted">Ningún agente asignado a este ticket.</p>'}
    ${
      state.permissions?.manageAgents
        ? `<div class="ops-add">
             <select id="ops-agent-pick" aria-label="Asignar agente">
               <option value="">Asignar un agente…</option>
               ${candidates
                 .map((agent) => `<option value="${esc(agent.key)}">${esc(agent.name)}${agent.assigned ? '' : ''}</option>`)
                 .join('')}
             </select>
             <button class="ops-btn" data-ops-assign-agent type="button">Asignar</button>
           </div>`
        : ''
    }
    ${
      pending.length
        ? `<ul class="ops-activity">${pending
            .map(
              (row) => `<li><span class="ops-activity__when">${esc(stamp(row.requestedAt))}</span>
                <span class="ops-activity__what"><strong>${esc(row.agentName ?? row.agentKey)}</strong> pide permiso para ${esc(row.tool)}</span></li>`,
            )
            .join('')}</ul>`
        : ''
    }`;
}

async function ensureDirectory() {
  if (state.directory.length || !state.permissions?.manageParticipants) return;
  try {
    const data = await api('/api/admin/ops/users');
    state.directory = data.users ?? [];
  } catch {
    state.directory = [];
  }
}

/* --------------------------------------- bandeja de aprobaciones (Etapa D) */

/** Busca una aprobación en lo que ya está cargado (ticket o bandeja). */
function findApproval(approvalId) {
  return (
    (state.approvals ?? []).find((row) => row.id === approvalId) ??
    (state.inboxApprovals ?? []).find((row) => row.id === approvalId) ??
    null
  );
}

/**
 * Bandeja de aprobaciones pendientes.
 *
 * Es la pantalla que faltaba: hasta ahora una petición de un agente solo se
 * veía entrando al ticket concreto. Aquí están todas juntas, con el ticket al
 * que pertenecen, y se decide sin salir.
 */
async function openApprovals({ silent = false } = {}) {
  state.menuOpen = false;
  state.taskMenu = false;
  state.mentionMenu = false;
  state.detailOpen = false;
  state.agentsOpen = false;
  state.approvalsOpen = true;
  state.sheetMode = 'approvals';
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  if (!silent) {
    card.className = 'ops-sheet__card ops-approvals-card';
    card.innerHTML = `<header class="ops-sheet__head">
        <h2 id="ops-sheet-title">Aprobaciones</h2>
        <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
      </header>
      <div class="ops-sheet__body"><p class="ops-muted">Cargando…</p></div>`;
    sheet.hidden = false;
  }
  try {
    const data = await api('/api/admin/ops/approvals?status=pending');
    state.inboxApprovals = data.approvals ?? [];
    state.pendingApprovalCount = state.inboxApprovals.length;
  } catch (error) {
    toast(error.message);
    state.inboxApprovals = [];
  }
  if (!domAlive()) return;
  const target = document.getElementById('ops-sheet');
  const box = target?.querySelector('.ops-sheet__card');
  if (!target || !box) return;
  box.className = 'ops-sheet__card ops-approvals-card';
  box.innerHTML = approvalsSheetHtml();
  target.hidden = false;
  renderAdminBar();
}

function approvalsSheetHtml() {
  const rows = state.inboxApprovals ?? [];
  return `
    <header class="ops-sheet__head">
      <div class="ops-detail__title">
        <p class="ops-chat__num">${ICONS.shield} Pendientes de tu decisión</p>
        <h2 id="ops-sheet-title">${rows.length ? `${rows.length} aprobaci${rows.length === 1 ? 'ón' : 'ones'}` : 'Aprobaciones'}</h2>
      </div>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <div class="ops-sheet__body">
      ${
        rows.length
          ? rows
              .map(
                (row) => `
          <article class="ops-inbox-approval">
            <p class="ops-inbox-approval__ticket">
              <button class="ops-linkbtn" data-ops-open="${esc(row.ticketId)}" type="button">${esc(row.ticketNumber ?? row.ticketId)}</button>
              <span class="ops-muted">${esc(row.ticketTitle ?? '')}</span>
            </p>
            ${approvalCardHtml(null, row)}
          </article>`,
              )
              .join('')
          : `<div class="ops-empty"><strong>Nada pendiente</strong><span>Cuando un agente pida permiso para algo irreversible, aparecerá aquí.</span></div>`
      }
    </div>
    <footer class="ops-sheet__foot">
      <button class="ops-btn ops-btn--ghost" data-ops-approvals-refresh type="button">Actualizar</button>
      <button class="ops-btn" data-ops-sheet-close type="button">Cerrar</button>
    </footer>`;
}

/* -------------------------------------- registro de agentes (Etapa D, R4) */

/** Alta y edición de agentes. Sin esto, el registro solo se podía tocar por API. */
async function openAgents({ silent = false } = {}) {
  state.menuOpen = false;
  state.taskMenu = false;
  state.mentionMenu = false;
  state.detailOpen = false;
  state.approvalsOpen = false;
  state.agentsOpen = true;
  state.sheetMode = 'agents';
  state.agentError = '';
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  if (!silent) {
    card.className = 'ops-sheet__card ops-agents-card';
    card.innerHTML = `<header class="ops-sheet__head">
        <h2 id="ops-sheet-title">Agentes IA</h2>
        <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
      </header>
      <div class="ops-sheet__body"><p class="ops-muted">Cargando…</p></div>`;
    sheet.hidden = false;
  }
  try {
    const data = await api('/api/admin/ops/agents');
    state.agents = data.agents ?? [];
    state.agentTools = data.tools ?? [];
  } catch (error) {
    toast(error.message);
    state.agents = [];
  }
  if (!domAlive()) return;
  const target = document.getElementById('ops-sheet');
  const box = target?.querySelector('.ops-sheet__card');
  if (!target || !box) return;
  box.className = 'ops-sheet__card ops-agents-card';
  box.innerHTML = agentsSheetHtml();
  target.hidden = false;
}

const EFFECT_LABELS = {
  read: 'solo lee',
  write: 'escribe en el ticket',
  high_impact: 'necesita aprobación',
};

function agentsSheetHtml() {
  const agents = state.agents ?? [];
  const editing = (state.agents ?? []).find((row) => row.key === state.agentEditing) ?? null;
  return `
    <header class="ops-sheet__head">
      <div class="ops-detail__title">
        <p class="ops-chat__num">${ICONS.bot} Registro</p>
        <h2 id="ops-sheet-title">Agentes IA</h2>
      </div>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <div class="ops-sheet__body">
      <h3 class="ops-detail__h">Dados de alta <span class="ops-muted">(${agents.length})</span></h3>
      <ul class="ops-people">
        ${
          agents.length
            ? agents
                .map(
                  (agent) => `<li class="ops-person ops-agent-row">
                    <span class="ops-person__avatar ops-person__avatar--ai" aria-hidden="true">IA</span>
                    <span class="ops-person__body">
                      <span class="ops-person__name">${esc(agent.name)}${agent.enabled === false ? ' <span class="ops-tag ops-tag--due">Apagado</span>' : ''}</span>
                      <span class="ops-person__meta">${esc(agent.key)} · v${agent.version} · ${agent.tools.length} herramienta(s)${
                        agent.activeRuns ? ` · ${agent.activeRuns} en curso` : ''
                      }</span>
                    </span>
                    <button class="ops-btn ops-btn--ghost ops-person__edit" data-ops-agent-edit="${esc(agent.key)}" type="button">Editar</button>
                  </li>`,
                )
                .join('')
            : '<li class="ops-muted">Todavía no hay agentes. Crea el primero abajo.</li>'
        }
      </ul>

      <h3 class="ops-detail__h">${editing ? `Editar «${esc(editing.name)}»` : 'Nuevo agente'}</h3>
      ${state.agentError ? `<p class="ops-error">${esc(state.agentError)}</p>` : ''}
      ${agentFormHtml(editing)}
    </div>`;
}

function agentFormHtml(agent) {
  const tools = (state.agentTools ?? []).filter((tool) => tool.enabled && tool.effect !== 'forbidden');
  const chosen = new Set(agent?.tools ?? []);
  const types = new Set(agent?.ticketTypes ?? ['delivery']);
  return `
    <form class="ops-agentform" data-ops-agent-form data-editing="${esc(agent?.key ?? '')}">
      <div class="ops-agentform__row">
        <label class="ops-field">
          <span>Clave (minúsculas y guiones bajos)</span>
          <input name="key" value="${esc(agent?.key ?? '')}" ${agent ? 'disabled' : ''} placeholder="asistente_reparto" autocomplete="off" required />
        </label>
        <label class="ops-field">
          <span>Nombre visible</span>
          <input name="name" value="${esc(agent?.name ?? '')}" placeholder="Asistente de reparto" autocomplete="off" required />
        </label>
      </div>
      <label class="ops-field">
        <span>Para qué sirve (opcional)</span>
        <input name="role" value="${esc(agent?.role ?? '')}" placeholder="Apoyo a la operación" autocomplete="off" />
      </label>

      <p class="ops-field__label">Tipos de ticket en los que puede trabajar</p>
      <div class="ops-agentform__chips">
        ${TICKET_TYPES.map(
          (type) => `<label class="ops-check">
            <input type="checkbox" name="ticketTypes" value="${esc(type.id)}" ${types.has(type.id) ? 'checked' : ''} />
            <span>${esc(type.label)}</span>
          </label>`,
        ).join('')}
      </div>

      <p class="ops-field__label">Herramientas autorizadas</p>
      <div class="ops-agentform__tools">
        ${
          tools.length
            ? tools
                .map(
                  (tool) => `<label class="ops-check ops-check--tool">
                    <input type="checkbox" name="tools" value="${esc(tool.name)}" ${chosen.has(tool.name) ? 'checked' : ''} />
                    <span>
                      <strong>${esc(tool.name)}</strong>
                      <em>${esc(EFFECT_LABELS[tool.effect] ?? tool.effect)}${tool.requiresApproval ? ' · con aprobación humana' : ''}</em>
                    </span>
                  </label>`,
                )
                .join('')
            : '<p class="ops-muted">No se pudo leer el catálogo de herramientas.</p>'
        }
      </div>

      <div class="ops-agentform__row">
        <label class="ops-field">
          <span>Minutos entre revisiones</span>
          <input name="followUpMinutes" type="number" min="1" max="720" value="${esc(agent?.config?.followUpMinutes ?? 30)}" />
        </label>
        <label class="ops-check">
          <input type="checkbox" name="enabled" ${agent?.enabled === false ? '' : 'checked'} />
          <span>Activo</span>
        </label>
        <label class="ops-check">
          <input type="checkbox" name="autoEnroll" ${agent?.config?.autoEnroll ? 'checked' : ''} />
          <span>Entrar solo en los tickets nuevos de esos tipos</span>
        </label>
        <label class="ops-check">
          <input type="checkbox" name="planner" ${agent?.config?.planner === 'llm' ? 'checked' : ''} />
          <span>Redactar con IA (modelo de lenguaje)</span>
        </label>
      </div>

      <footer class="ops-sheet__foot">
        ${agent ? '<button class="ops-btn ops-btn--ghost" data-ops-agent-new type="button">Cancelar edición</button>' : ''}
        <button class="ops-btn ops-btn--primary" type="submit" ${state.agentBusy ? 'disabled' : ''}>${agent ? 'Guardar cambios' : 'Dar de alta'}</button>
      </footer>
    </form>`;
}

async function submitAgentForm(form) {
  if (state.agentBusy) return;
  const editing = String(form.dataset.editing ?? '');
  const tools = [...form.querySelectorAll('input[name="tools"]:checked')].map((input) => input.value);
  const ticketTypes = [...form.querySelectorAll('input[name="ticketTypes"]:checked')].map((input) => input.value);
  const body = {
    key: fieldValue(form, 'key') || editing,
    name: fieldValue(form, 'name').trim(),
    role: fieldValue(form, 'role').trim(),
    tools,
    ticketTypes,
    enabled: Boolean(form.querySelector('input[name="enabled"]')?.checked),
    config: {
      followUpMinutes: Number(fieldValue(form, 'followUpMinutes')) || 30,
      autoEnroll: Boolean(form.querySelector('input[name="autoEnroll"]')?.checked),
      /* Etapa E: quién redacta. Sin marcar, la pauta fija de siempre. */
      planner: form.querySelector('input[name="planner"]')?.checked ? 'llm' : 'deterministic',
    },
  };
  state.agentBusy = true;
  state.agentError = '';
  try {
    await api('/api/admin/ops/agents', {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    toast(editing ? 'Agente actualizado' : 'Agente dado de alta');
    state.agentEditing = '';
    /* Si el ticket abierto tiene ese agente, la ficha debe verlo al instante. */
    if (state.ticket?.assignedAgentId === body.key) await loadTicket(state.ticket.id, { silent: true });
    await openAgents({ silent: true });
  } catch (error) {
    state.agentError = error.message;
    if (domAlive()) {
      const box = document.querySelector('.ops-agents-card');
      if (box) box.innerHTML = agentsSheetHtml();
    }
  } finally {
    state.agentBusy = false;
  }
}

/* ------------------------------- motivo del rechazo, sin diálogo del sistema */

/**
 * Pide el motivo del rechazo en una hoja del propio panel.
 *
 * `window.prompt` no se puede estilar, en móvil sale pegado al teclado y su
 * resultado es una cadena que no se puede validar. La decisión queda igual:
 * rechazar NO ejecuta nada.
 */
function openRejectSheet(approvalId) {
  const approval = findApproval(approvalId);
  if (!approval) {
    toast('Esa aprobación ya no está pendiente.');
    return;
  }
  state.rejectOpen = true;
  state.rejectTarget = approvalId;
  state.sheetMode = 'reject';
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  card.className = 'ops-sheet__card';
  card.innerHTML = `<header class="ops-sheet__head">
      <h2 id="ops-sheet-title">Rechazar «${esc(approval.tool)}»</h2>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <form class="ops-sheet__body" data-ops-reject-form>
      <p class="ops-muted">Al rechazar no se ejecuta nada: el ticket sigue como está y el agente se queda esperando a una persona.</p>
      <label class="ops-field">
        <span>Motivo (se guarda en el histórico)</span>
        <textarea name="note" rows="3" placeholder="Falta la firma del cliente, etc."></textarea>
      </label>
      <footer class="ops-sheet__foot">
        <button class="ops-btn ops-btn--ghost" data-ops-sheet-close type="button">Cancelar</button>
        <button class="ops-btn ops-btn--primary" type="submit" ${state.rejectBusy ? 'disabled' : ''}>Rechazar</button>
      </footer>
    </form>`;
  sheet.hidden = false;
  card.querySelector('textarea[name="note"]')?.focus();
}


function renderDetail() {
  if (!domAlive() || !state.detailOpen) return;
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  card.className = 'ops-sheet__card ops-detail-card';
  card.innerHTML = detailHtml();
}

async function openDetail() {
  if (!state.ticket) return;
  state.menuOpen = false;
  state.taskMenu = false;
  state.mentionMenu = false;
  state.approvalsOpen = false;
  state.agentsOpen = false;
  state.rejectOpen = false;
  state.rejectTarget = '';
  state.detailOpen = true;
  state.sheetMode = 'detail';
  await ensureDirectory();
  await ensureAgents();
  renderDetail();
  const sheet = document.getElementById('ops-sheet');
  if (sheet) sheet.hidden = false;
  renderChat();
}

/* ------------------------------------------------ acciones de seguimiento */

async function postTask(action, note = '') {
  const ticket = state.ticket;
  if (!ticket) return;
  try {
    const result = await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}/task`, {
      method: 'POST',
      body: JSON.stringify({ action, note, idempotencyKey: clientKey(`optask-${action}`) }),
    });
    const spec = TASK_ACTIONS.find((row) => row.id === action);
    toast(result.duplicate ? 'Eso ya estaba registrado' : `${spec?.label ?? 'Acción'} registrada`);
    state.taskSheet = null;
    state.taskMenu = false;
    await loadTicket(ticket.id, { silent: true });
    if (state.detailOpen) {
      await openDetail();
    } else if (state.sheetMode === 'task') {
      closeSheet();
    }
  } catch (error) {
    toast(error.message);
  }
}

function runTaskAction(action) {
  const spec = TASK_ACTIONS.find((row) => row.id === action);
  if (!spec) return;
  state.taskMenu = false;
  state.mentionMenu = false;
  if (spec.needsNote) {
    state.taskSheet = action;
    state.sheetMode = 'task';
    renderTaskSheet();
    const sheet = document.getElementById('ops-sheet');
    if (sheet) sheet.hidden = false;
    return;
  }
  postTask(action, '');
}

function renderTaskSheet() {
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  const spec = TASK_ACTIONS.find((row) => row.id === state.taskSheet);
  if (!card || !spec) return;
  card.className = 'ops-sheet__card';
  card.innerHTML = `
    <header class="ops-sheet__head">
      <h2 id="ops-sheet-title">${esc(spec.label)}</h2>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <form class="ops-sheet__body" data-ops-task-form data-action="${esc(spec.id)}">
      <label class="ops-field">
        <span>Detalle (opcional)</span>
        <textarea name="note" rows="3" placeholder="${
          spec.id === 'issue' ? 'Qué pasó, qué hace falta' : spec.id === 'escalate' ? 'Por qué hay que escalarlo' : 'Contexto para el equipo'
        }"></textarea>
      </label>
      <footer class="ops-sheet__foot">
        <button class="ops-btn ops-btn--ghost" data-ops-sheet-close type="button">Cancelar</button>
        <button class="ops-btn ops-btn--primary" type="submit">Registrar</button>
      </footer>
    </form>`;
}

/** Aprobaciones pendientes del ticket (las que aún se pueden decidir). */
function pendingApprovals() {
  return (state.approvals ?? []).filter((row) => row.status === 'pending');
}

const APPROVAL_STATE_LABELS = {
  pending: 'Espera tu decisión',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  expired: 'Caducada',
  consumed: 'Ejecutada',
};

/**
 * Tarjeta de una petición de aprobación.
 *
 * Se pinta DENTRO del hilo, junto al mensaje del agente, porque es donde la va a
 * buscar la persona. Los parámetros se muestran tal cual: aprobar sin ver qué se
 * autoriza no es aprobar.
 */
function approvalCardHtml(message, approvalOverride = null) {
  const meta = message?.meta ?? {};
  const approvalId = meta.approvalId ?? approvalOverride?.id ?? '';
  const approval = approvalOverride ?? (state.approvals ?? []).find((row) => row.id === approvalId) ?? null;
  if (!approvalId) return '';
  const status = approval?.status ?? 'pending';
  /*
   * Se mira el permiso de SESIÓN, no el de la ficha: la bandeja de aprobaciones
   * se abre sin ningún ticket seleccionado y ahí `state.permissions` es null.
   */
  const canDecide = can('tickets.close') && status === 'pending';
  let params = {};
  try {
    params = approval?.params ?? meta.params ?? {};
  } catch {
    params = {};
  }
  const pairs = Object.entries(params)
    .map(([key, value]) => `<li><span>${esc(key)}</span><strong>${esc(value)}</strong></li>`)
    .join('');
  const busy = state.approving === approvalId;
  return `
    <div class="ops-approval" data-approval="${esc(approvalId)}" data-state="${esc(status)}">
      <p class="ops-approval__head">${ICONS.hand}<span>Permiso para «${esc(approval?.tool ?? meta.tool ?? 'acción')}»</span></p>
      ${approval?.justification ? `<p class="ops-approval__note">${esc(approval.justification)}</p>` : ''}
      ${pairs ? `<ul class="ops-approval__params">${pairs}</ul>` : ''}
      <p class="ops-approval__state">${esc(APPROVAL_STATE_LABELS[status] ?? status)}${
        approval?.decidedByName ? ` · ${esc(approval.decidedByName)}` : ''
      }</p>
      ${
        canDecide
          ? `<div class="ops-approval__actions">
               <button class="ops-btn ops-btn--primary" data-ops-approve="${esc(approvalId)}" type="button" ${busy ? 'disabled' : ''}>Aprobar y ejecutar</button>
               <button class="ops-btn ops-btn--ghost" data-ops-reject="${esc(approvalId)}" type="button" ${busy ? 'disabled' : ''}>Rechazar</button>
             </div>`
          : status === 'pending'
            ? '<p class="ops-approval__hint">Solo quien puede cerrar tickets puede decidir esto.</p>'
            : ''
      }
    </div>`;
}

/**
 * Decide una aprobación (aprobar ejecuta UNA vez, con esos parámetros).
 *
 * `note` es el motivo del rechazo y llega desde la hoja del panel, no de un
 * diálogo del sistema. Al terminar se refresca lo que esté abierto: la bandeja,
 * la ficha o el hilo del ticket al que pertenece la aprobación.
 */
async function decideApprovalRequest(approvalId, approve, { note = '' } = {}) {
  if (!approvalId || state.approving) return;
  const target = findApproval(approvalId);
  const ticketId = target?.ticketId ?? state.ticket?.id ?? '';
  state.approving = approvalId;
  state.rejectBusy = true;
  if (domAlive()) renderChat();
  if (state.detailOpen) renderDetail();
  try {
    await api(`/api/admin/ops/approvals/${encodeURIComponent(approvalId)}/${approve ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    toast(approve ? 'Aprobado y ejecutado' : 'Rechazado');
  } catch (error) {
    toast(error.message);
  } finally {
    state.approving = '';
    state.rejectBusy = false;
    state.rejectOpen = false;
    state.rejectTarget = '';
    /* El ticket abierto solo se recarga si la aprobación era SUYA. */
    if (ticketId && ticketId === state.selectedId) await loadTicket(ticketId, { silent: true });
    if (state.approvalsOpen) await openApprovals({ silent: true });
    else if (state.detailOpen) await openDetail();
    await loadInbox({ silent: true });
  }
}

/** Asigna un agente al ticket (queda como participante y arranca su run). */
async function assignAgent(agentKey) {
  const ticket = state.ticket;
  if (!ticket || !agentKey) return;
  try {
    await api(`/api/admin/ops/tickets/${encodeURIComponent(ticket.id)}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agentKey }),
    });
    toast('Agente asignado');
    await loadTicket(ticket.id, { silent: true });
    if (state.detailOpen) await openDetail();
  } catch (error) {
    toast(error.message);
  }
}

/** Catálogo de agentes dados de alta (solo administración puede leerlo). */
async function ensureAgents() {
  if ((state.agents ?? []).length || !state.permissions?.manageAgents) return;
  try {
    const data = await api('/api/admin/ops/agents');
    state.agents = data.agents ?? [];
    state.agentTools = data.tools ?? [];
  } catch {
    state.agents = [];
  }
}

function insertMention(name) {
  const field = document.getElementById('ops-text');
  state.mentionMenu = false;
  if (!field) {
    composerRefresh();
    return;
  }
  const value = field.value;
  const needsSpace = value && !/\s$/.test(value);
  field.value = `${value}${needsSpace ? ' ' : ''}@${name} `;
  composerRefresh();
  const next = document.getElementById('ops-text');
  if (next) {
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  }
}

async function addParticipantFromDetail() {
  const select = document.getElementById('ops-add-user');
  const userId = select?.value ?? '';
  if (!userId || !state.ticket) return;
  try {
    await api(`/api/admin/ops/tickets/${encodeURIComponent(state.ticket.id)}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    state.directory = [];
    await loadTicket(state.ticket.id, { silent: true });
    await openDetail();
    toast('Participante añadido');
  } catch (error) {
    toast(error.message);
  }
}

async function dropParticipant(userId) {
  if (!state.ticket) return;
  try {
    await api(`/api/admin/ops/tickets/${encodeURIComponent(state.ticket.id)}/participants/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    await loadTicket(state.ticket.id, { silent: true });
    await openDetail();
    toast('Participante quitado');
  } catch (error) {
    toast(error.message);
  }
}


/* -------------------------------------------------------------- alta ticket */

function sheetHtmlNew() {
  const types = TICKET_TYPES.filter((type) => (type.id === 'agent_task' ? isAdmin() : true));
  return `
    <header class="ops-sheet__head">
      <h2 id="ops-sheet-title">Nuevo ticket</h2>
      <button class="ops-iconbtn" data-ops-sheet-close type="button" aria-label="Cerrar">${ICONS.close}</button>
    </header>
    <form class="ops-sheet__body" data-ops-new-form>
      <div class="ops-field-row">
        <label class="ops-field">
          <span>Tipo</span>
          <select name="type">${types.map((type) => `<option value="${type.id}">${type.label}</option>`).join('')}</select>
        </label>
        <label class="ops-field">
          <span>Prioridad</span>
          <select name="priority">
            <option value="normal">Normal</option>
            <option value="low">Baja</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
        </label>
      </div>
      <label class="ops-field">
        <span>Asunto</span>
        <input name="title" required minlength="3" maxlength="140" placeholder="Qué hay que hacer" />
      </label>
      <label class="ops-field">
        <span>Detalle (opcional)</span>
        <textarea name="description" rows="3" placeholder="Contexto para quien lo abra"></textarea>
      </label>
      <div class="ops-field">
        <span>Pedido relacionado (opcional)</span>
        <label class="ops-search ops-search--inline">
          <span aria-hidden="true">${ICONS.search}</span>
          <input id="ops-order-q" type="search" placeholder="Número de pedido o cliente" autocomplete="off" />
        </label>
        <div class="ops-orderlist" id="ops-orderlist">${
          state.newPicked
            ? `<button class="ops-orderpick is-picked" type="button" data-ops-order-clear>
                 <span><strong>${esc(state.newPicked.orderNumber ?? state.newPicked.id)}</strong> · ${esc(state.newPicked.status ?? '')}</span>
                 <span class="ops-orderpick__x">Quitar</span>
               </button>`
            : state.orderResults.length
              ? state.orderResults
                  .map(
                    (row) => `<button class="ops-orderpick" type="button" data-ops-order-pick="${esc(row.id)}">
                        <span><strong>${esc(row.orderNumber ?? row.id)}</strong> · ${esc(row.customerName ?? 'Cliente')}</span>
                        <span class="ops-orderpick__meta">${esc(row.status ?? '')}</span>
                      </button>`,
                  )
                  .join('')
              : state.orderQuery && !state.newPicked
                ? '<p class="ops-hint">Sin coincidencias.</p>'
                : ''
        }</div>
      </div>
      ${state.newError ? `<p class="ops-error">${esc(state.newError)}</p>` : ''}
      <footer class="ops-sheet__foot">
        <button class="ops-btn ops-btn--ghost" data-ops-sheet-close type="button">Cancelar</button>
        <button class="ops-btn ops-btn--primary" type="submit" ${state.newBusy ? 'disabled' : ''}>
          ${state.newBusy ? 'Creando…' : 'Crear ticket'}
        </button>
      </footer>
    </form>`;
}

function openNewTicket() {
  if (!can('tickets.create')) {
    toast('Tu rol no puede crear tickets.');
    return;
  }
  state.newOpen = true;
  state.newError = '';
  state.newBusy = false;
  state.orderQuery = '';
  state.orderResults = [];
  state.newPicked = null;
  const sheet = document.getElementById('ops-sheet');
  const card = sheet?.querySelector('.ops-sheet__card');
  if (!sheet || !card) return;
  card.innerHTML = sheetHtmlNew();
  sheet.hidden = false;
  card.querySelector('input[name="title"]')?.focus();
}

function rerenderNewSheet({ focusOrder = false } = {}) {
  const card = document.getElementById('ops-sheet')?.querySelector('.ops-sheet__card');
  if (!card || !state.newOpen) return;
  const form = card.querySelector('[data-ops-new-form]');
  const snapshot = form
    ? {
        type: fieldValue(form, 'type'),
        priority: fieldValue(form, 'priority'),
        title: fieldValue(form, 'title'),
        description: fieldValue(form, 'description'),
      }
    : {};
  card.innerHTML = sheetHtmlNew();
  const next = card.querySelector('[data-ops-new-form]');
  if (next && snapshot.title !== undefined) {
    next.querySelector('[name="type"]').value = snapshot.type ?? 'incident';
    next.querySelector('[name="priority"]').value = snapshot.priority ?? 'normal';
    next.querySelector('[name="title"]').value = snapshot.title ?? '';
    next.querySelector('[name="description"]').value = snapshot.description ?? '';
  }
  if (focusOrder) card.querySelector('#ops-order-q')?.focus();
}
  state.approvalsOpen = false;
  state.agentsOpen = false;
  state.agentEditing = '';
  state.agentError = '';
  state.rejectOpen = false;
  state.rejectTarget = '';

function closeSheet() {
  const sheet = document.getElementById('ops-sheet');
  if (sheet) sheet.hidden = true;
  state.newOpen = false;
  state.resolveOpen = false;
  state.panel = '';
  state.detailOpen = false;
  state.taskSheet = null;
  state.sheetMode = '';
}

async function searchOrders(query) {
  state.orderQuery = query;
  if (!query || query.trim().length < 2) {
    state.orderResults = [];
    rerenderNewSheet({ focusOrder: true });
    return;
  }
  try {
    const data = await api(`/api/admin/ops/orders?q=${encodeURIComponent(query.trim())}&limit=8`);
    state.orderResults = data.orders ?? [];
  } catch {
    state.orderResults = [];
  }
  rerenderNewSheet({ focusOrder: true });
  const field = document.getElementById('ops-order-q');
  if (field) {
    field.value = query;
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

async function submitNewTicket(form) {
  if (state.newBusy) return;
  const title = fieldValue(form, 'title').trim();
  if (title.length < 3) {
    state.newError = 'Escribe un asunto (al menos 3 letras).';
    rerenderNewSheet();
    return;
  }
  state.newBusy = true;
  state.newError = '';
  rerenderNewSheet();
  const payload = {
    type: fieldValue(form, 'type') || 'incident',
    priority: fieldValue(form, 'priority') || 'normal',
    title,
    description: fieldValue(form, 'description').trim(),
    /* El mismo formulario enviado dos veces devuelve el mismo ticket. */
    idempotencyKey: state.newPicked ? null : clientKey('opticket'),
  };
  if (state.newPicked) {
    payload.entityType = 'order';
    payload.entityId = state.newPicked.id;
    if (payload.type === 'incident') payload.type = 'delivery';
  }
  try {
    const result = await api('/api/admin/ops/tickets', { method: 'POST', body: JSON.stringify(payload) });
    closeSheet();
    await loadInbox({ silent: true });
    await loadTicket(result.ticket.id);
    toast(`${result.ticket.number} abierto`);
  } catch (error) {
    state.newBusy = false;
    if (error.code === 'duplicate_ticket' && error.payload?.ticket) {
      /* Ya existía: se abre el que hay en vez de crear otro. */
      closeSheet();
      await loadInbox({ silent: true });
      await loadTicket(error.payload.ticket.id);
      toast(`Ese pedido ya tenía el ticket ${error.payload.ticket.number}`);
      return;
    }
    state.newError = error.message;
    rerenderNewSheet();
  }
}

/* ---------------------------------------------------------------- eventos */

function onViewClick(event) {
  const target = event.target.closest(
    '[data-ops-open],[data-ops-filter],[data-ops-new],[data-ops-back],[data-ops-menu],[data-ops-act],[data-ops-ack],' +
      '[data-ops-sheet-close],[data-ops-order-pick],[data-ops-order-clear],[data-ops-detail],[data-ops-task],[data-ops-task-menu],' +
      '[data-ops-mention],[data-ops-mention-user],[data-ops-older],[data-ops-add-user],[data-ops-drop-user],' +
      '[data-ops-approve],[data-ops-reject],[data-ops-assign-agent],[data-ops-approvals],[data-ops-approvals-refresh],' +
      '[data-ops-agents],[data-ops-agent-edit],[data-ops-agent-new],' +
      '[data-centro-nav],[data-centro-agent],[data-centro-ticket],[data-centro-office-tab],[data-centro-reload],' +
      '[data-work-tab],[data-work-approve],[data-work-reject],[data-work-fu],[data-work-sch],[data-work-full],[data-work-seed],[data-agent-seed]',
  );
  if (!target) {
    /* Un clic fuera cierra los menús flotantes (sin cerrar la ficha). */
    const cambio =
      (state.menuOpen && !event.target.closest('.ops-menu')) ||
      (state.taskMenu && !event.target.closest('.ops-taskmenu')) ||
      (state.mentionMenu && !event.target.closest('.ops-taskmenu'));
    if (cambio) {
      state.menuOpen = false;
      state.taskMenu = false;
      state.mentionMenu = false;
      renderChat();
    }
    return;
  }

  if (target.dataset.centroNav) {
    event.preventDefault();
    const nav = target.dataset.centroNav;
    if (nav === 'supervisor') {
      /* La pantalla del supervisor es ÚNICA: se navega a ella, no se copia. */
      window.dispatchEvent(new CustomEvent('fulltech:navigate', { detail: { tab: 'supervisor' } }));
      return;
    }
    if (nav === 'tickets') {
      state.returnTo = null;
      state.screen = 'tickets';
      ensureShell();
      renderRows();
      loadInbox();
      return;
    }
    state.returnTo = null;
    state.screen = 'agents';
    state.officeKey = '';
    state.office = null;
    ensureShell();
    renderCentro();
    loadCentro();
    return;
  }
  if (target.dataset.centroAgent) {
    event.preventDefault();
    openOffice(target.dataset.centroAgent);
    return;
  }
  if (target.dataset.centroTicket) {
    event.preventDefault();
    openTicketFromCentro(target.dataset.centroTicket);
    return;
  }
  if (target.dataset.centroOfficeTab) {
    state.officeTab = target.dataset.centroOfficeTab;
    renderCentro();
    return;
  }
  /* ---------------- Agente de Seguimiento (oficina de trabajo) ---------------- */
  if (target.dataset.workTab) {
    state.workTab = target.dataset.workTab;
    renderCentro();
    /* Al cambiar de sección se piden los datos frescos: la cola y las
       propuestas cambian solas (las mueve el programador, no la pantalla). */
    refreshWorkOffice();
    return;
  }
  if (target.dataset.workApprove) {
    decideWorkProposalUi(target.dataset.workApprove, true);
    return;
  }
  if (target.dataset.workReject) {
    decideWorkProposalUi(target.dataset.workReject, false);
    return;
  }
  if (target.dataset.workFu) {
    workFollowupAction(target.dataset.workFu, target.dataset.workId);
    return;
  }
  if (target.dataset.workSch) {
    workScheduledAction(target.dataset.workSch, target.dataset.workId);
    return;
  }
  if (target.dataset.workFull) {
    /* Las pantallas completas siguen existiendo: el centro es la puerta principal. */
    window.dispatchEvent(new CustomEvent('fulltech:navigate', { detail: { tab: target.dataset.workFull } }));
    return;
  }
  if (target.dataset.agentSeed) {
    /*
     * Alta de un agente conocido desde su propio listón.
     *
     * Se envía la definición que manda el servidor (misma que usa el panel de
     * agentes): no se inventa nada en el navegador y sigue siendo una acción
     * explícita de una persona.
     */
    event.preventDefault();
    const entry = (state.centro?.knownAgents ?? []).find((row) => row.key === target.dataset.agentSeed);
    if (!entry?.defaults) {
      toast('Ese agente se da de alta desde su propia oficina.');
      return;
    }
    const boton = target;
    boton.disabled = true;
    api('/api/admin/ops/agents', { method: 'POST', body: JSON.stringify(entry.defaults) })
      .then(() => {
        toast(`${entry.name} dado de alta`);
        return loadCentro();
      })
      .catch((error) => {
        boton.disabled = false;
        toast(error.message);
      });
    return;
  }
  if (target.hasAttribute('data-work-seed')) {
    event.preventDefault();
    api('/api/admin/ops/work/agent', { method: 'POST', body: JSON.stringify({}) })
      .then((data) => {
        toast(data.existing ? 'El agente ya existía' : 'Agente de Seguimiento dado de alta');
        return loadCentro();
      })
      .catch((error) => toast(error.message));
    return;
  }
  if (target.hasAttribute('data-centro-reload')) {
    if (state.screen === 'agent' && state.officeKey) loadOffice(state.officeKey);
    else loadCentro();
    return;
  }
  if (target.dataset.opsOpen) {
    event.preventDefault();
    /* Desde la bandeja de aprobaciones se salta AL ticket: la hoja se cierra. */
    if (state.approvalsOpen || state.agentsOpen) closeSheet();
    loadTicket(target.dataset.opsOpen);
    return;
  }
  if (target.dataset.opsFilter) {
    state.filter = target.dataset.opsFilter;
    loadInbox();
    return;
  }
  if (target.hasAttribute('data-ops-new')) {
    openNewTicket();
    return;
  }
  if (target.hasAttribute('data-ops-back')) {
    /* Si el ticket se abrió desde una oficina, se vuelve a esa oficina. */
    if (state.returnTo) {
      backToCentro();
      return;
    }
    state.selectedId = '';
    state.ticket = null;
    state.messages = [];
    state.events = [];
    state.menuOpen = false;
    renderChat();
    renderRows();
    return;
  }
  if (target.hasAttribute('data-ops-menu')) {
    state.menuOpen = !state.menuOpen;
    renderChat();
    return;
  }
  if (target.hasAttribute('data-ops-ack')) {
    ackReceipt();
    return;
  }
  if (target.hasAttribute('data-ops-sheet-close')) {
    closeSheet();
    return;
  }
  if (target.dataset.opsOrderPick) {
    const picked = state.orderResults.find((row) => row.id === target.dataset.opsOrderPick);
    state.newPicked = picked ?? null;
    state.orderResults = [];
    rerenderNewSheet();
    return;
  }
  if (target.hasAttribute('data-ops-detail')) {
    openDetail();
    return;
  }
  if (target.dataset.opsTask) {
    runTaskAction(target.dataset.opsTask);
    return;
  }
  if (target.hasAttribute('data-ops-task-menu')) {
    state.taskMenu = !state.taskMenu;
    state.mentionMenu = false;
    renderChat();
    return;
  }
  if (target.hasAttribute('data-ops-mention')) {
    state.mentionMenu = !state.mentionMenu;
    state.taskMenu = false;
    renderChat();
    return;
  }
  if (target.dataset.opsMentionUser) {
    insertMention(target.dataset.opsMentionUser);
    return;
  }
  if (target.hasAttribute('data-ops-older')) {
    loadOlder();
    return;
  }
  if (target.hasAttribute('data-ops-add-user')) {
    addParticipantFromDetail();
    return;
  }
  if (target.dataset.opsDropUser) {
    dropParticipant(target.dataset.opsDropUser);
    return;
  }
  if (target.dataset.opsReject) {
    openRejectSheet(target.dataset.opsReject);
    return;
  }
  if (target.hasAttribute('data-ops-assign-agent')) {
    const select = document.getElementById('ops-agent-pick');
    assignAgent(select?.value ?? '');
    return;
  }
  if (target.hasAttribute('data-ops-approvals') || target.hasAttribute('data-ops-approvals-refresh')) {
    openApprovals();
    return;
  }
  if (target.hasAttribute('data-ops-agents')) {
    state.agentEditing = '';
    openAgents();
    return;
  }
  if (target.dataset.opsAgentEdit) {
    state.agentEditing = target.dataset.opsAgentEdit;
    state.agentError = '';
    const box = document.querySelector('.ops-agents-card');
    if (box) box.innerHTML = agentsSheetHtml();
    return;
  }
  if (target.hasAttribute('data-ops-agent-new')) {
    state.agentEditing = '';
    state.agentError = '';
    const box = document.querySelector('.ops-agents-card');
    if (box) box.innerHTML = agentsSheetHtml();
    return;
  }
  if (target.dataset.opsApprove) {
    decideApprovalRequest(target.dataset.opsApprove, true);
    return;
  }
  if (target.hasAttribute('data-ops-order-clear')) {
    state.newPicked = null;
    rerenderNewSheet({ focusOrder: true });
    return;
  }
  const act = target.dataset.opsAct;
  if (!act) return;
  if (act === 'in_progress') return patchTicket({ status: 'in_progress' });
  if (act === 'waiting-human') return patchTicket({ status: 'waiting', waitingOn: 'human' });
  if (act === 'waiting-agent') return patchTicket({ status: 'waiting', waitingOn: 'agent' });
  if (act === 'waiting-external') return patchTicket({ status: 'waiting', waitingOn: 'external' });
  if (act === 'claim') return patchTicket({ assignedUserId: state.session?.user?.id ?? null });
  if (act === 'resolve') return openResolve();
  if (act === 'detail') return openDetail();
}

function bind() {
  const view = VIEW();
  if (!view || view.dataset.bound === '1') return;
  view.dataset.bound = '1';
  view.addEventListener('click', onViewClick);

  view.addEventListener('input', (event) => {
    const search = event.target.closest('#ops-search');
    if (search) {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.q = search.value.trim();
        loadInbox();
      }, 220);
      return;
    }
    const orderField = event.target.closest('#ops-order-q');
    if (orderField) {
      clearTimeout(state.searchTimer);
      const value = orderField.value;
      state.searchTimer = setTimeout(() => searchOrders(value), 260);
    }
  });

  view.addEventListener('keydown', (event) => {
    if (event.target.id === 'ops-text' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  view.addEventListener('submit', (event) => {
    if (event.target.matches('[data-ops-compose]')) {
      event.preventDefault();
      sendMessage();
      return;
    }
    if (event.target.matches('[data-ops-new-form]')) {
      event.preventDefault();
      submitNewTicket(event.target);
      return;
    }
    if (event.target.matches('[data-ops-agent-form]')) {
      event.preventDefault();
      submitAgentForm(event.target);
      return;
    }
    if (event.target.matches('[data-work-ask]')) {
      event.preventDefault();
      const field = event.target.querySelector('textarea[name="message"], #work-ask');
      submitWorkAsk(field?.value ?? '');
      return;
    }
    if (event.target.matches('[data-ops-reject-form]')) {
      event.preventDefault();
      const note = fieldValue(event.target, 'note').trim();
      decideApprovalRequest(state.rejectTarget, false, { note });
      return;
    }
    if (event.target.matches('[data-ops-task-form]')) {
      event.preventDefault();
      const action = event.target.dataset.action;
      const note = fieldValue(event.target, 'note').trim();
      postTask(action, note);
      return;
    }
    if (event.target.matches('[data-ops-resolve-form]')) {
      event.preventDefault();
      const resolution = fieldValue(event.target, 'resolution').trim();
      closeSheet();
      api(`/api/admin/ops/tickets/${encodeURIComponent(state.ticket.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution }),
      })
        .then(async () => {
          toast('Ticket resuelto');
          await loadTicket(state.ticket.id, { silent: true });
          await loadInbox({ silent: true });
        })
        .catch((error) => toast(error.message));
    }
  });

  /* Teclado del móvil: el compositor no debe quedar debajo. */
  if (window.visualViewport) {
    const sync = () => {
      const root = document.documentElement;
      const inset = Math.max(0, window.inn || state.rejectOpen || state.agentsOpen || state.approvalsOpenerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      root.style.setProperty('--ops-keyboard', `${Math.round(inset)}px`);
    };
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
    sync();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.newOpen || state.resolveOpen) {
      closeSheet();
      return;
    }
    if (state.menuOpen) {
      state.menuOpen = false;
      renderChat();
    }
  });
}

/** Al volver a la pestaña o a la pestaña del navegador, refrescar una vez. */
function refreshIfVisible() {
  if (state.tab !== 'ops' || !state.booted) return;
  if (isCentroScreen()) {
    loadCentro({ silent: true });
    if (state.screen === 'agent' && state.officeKey) loadOffice(state.officeKey, { silent: true });
    return;
  }
  loadInbox({ silent: true });
  if (state.selectedId && Date.now() - state.activeThreadAt > 1500) {
    loadTicket(state.selectedId, { silent: true });
  }
}

async function boot() {
  if (state.booted) return;
  try {
    state.session = await api('/api/admin/session');
  } catch {
    state.session = null;
  }
  if (!can('tickets.read')) {
    const view = VIEW();
    if (view) {
      view.innerHTML = `<div class="ops-empty ops-empty--error"><strong>Sin acceso</strong><span>Tu rol no tiene acceso al centro de operaciones.</span></div>`;
      view.dataset.ready = '1';
    }
    state.booted = true;
    return;
  }
  ensureShell();
  bind();
  await loadInbox();
  state.booted = true;
  /* Enlace de un aviso: `?v=ops&ticket=<id>` abre ESE ticket. */
  const params = new URLSearchParams(location.search);
  const deep = params.get('ticket');
  const deepOrder = params.get('order');
  if (deep) {
    state.returnTo = null;
    state.screen = 'tickets';
    ensureShell();
    renderRows();
    await loadTicket(deep);
    return;
  }
  /* Enlace desde una ficha de reparto/pedido: `?v=ops&order=<id>`. */
  if (deepOrder) {
    await openOrderTicket(deepOrder);
    return;
  }
  /* La entrada del Centro IA es el EQUIPO, no una bandeja abierta. */
  if (isCentroScreen()) await loadCentro();
}

function onTab(event) {
  const tab = String(event?.detail?.tab ?? '');
  state.tab = tab;
  const view = VIEW();
  if (view && tab !== 'ops') view.dataset.opsView = state.ticket ? 'chat' : 'list';
  if (tab !== 'ops') {
    state.menuOpen = false;
    state.taskMenu = false;
    state.mentionMenu = false;
    closeSheet();
    return;
  }
  boot().then(() => {
    if (event?.detail?.orderId) {
      openOrderTicket(event.detail.orderId);
      return;
    }
    if (event?.detail?.ticketId) {
      loadTicket(event.detail.ticketId);
      return;
    }
    if (isCentroScreen()) loadCentro({ silent: true });
    else loadInbox({ silent: true });
  });
  renderChat();
}

window.addEventListener('fulltech:tab', onTab);
window.addEventListener('fulltech:ops-open', onOpenRequest);

/* Avisos de la propia app: solo se recargan los tickets afectados. */
window.addEventListener('fulltech:crm-event', (event) => {
  const type = String(event?.detail?.type ?? '');
  /* `message.*`, `task.*` y `agent.*` son los nombres canónicos (Etapas C y D). */
  if (!/^(ticket|message|task|agent)\./.test(type)) return;
  const ticketId = event?.detail?.data?.ticketId ?? event?.detail?.entity?.id ?? '';
  if (state.tab !== 'ops') {
    if (ticketId) loadInbox({ silent: true });
    return;
  }
  loadInbox({ silent: true });
  if (ticketId && ticketId === state.selectedId) loadTicket(ticketId, { silent: true });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshIfVisible();
});
window.addEventListener('focus', refreshIfVisible);

/* Si el panel arranca ya en esta pestaña (enlace directo `?v=ops`). */
if (document.body?.dataset?.tab === 'ops') {
  state.tab = 'ops';
  boot();
}
