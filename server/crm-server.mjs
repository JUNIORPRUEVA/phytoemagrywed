/**
 * ============================================================================
 *  API del CRM + panel de administración (PWA).
 *
 *  Público (lo usa la web):
 *    POST /api/crm                  → guarda un `lead` o un `order_intent`
 *    GET  /api/health               → estado (sin datos personales)
 *
 *  Panel (lo usa el negocio, con sesión):
 *    GET  /admin/                   → la app instalable (PWA)
 *    POST /api/admin/login          → cambia la clave por una cookie de sesión
 *    POST /api/admin/logout
 *    GET  /api/admin/data           → items + cuentas + plantillas (una petición)
 *    PATCH /api/admin/items/:id     → estado, notas y recordatorio
 *    POST/DELETE /api/admin/messages[/:id] → plantillas de WhatsApp
 *
 *  Compatibilidad (curl, enlaces antiguos): `/api/crm/items?token=…`,
 *  `/api/crm/export.csv?token=…` y `/panel?token=…` siguen funcionando.
 *
 *  Variables de entorno:
 *    PHYTO_CRM_DATABASE_URL  Postgres (recomendado) · si no, SQLite · si no, JSONL
 *    PHYTO_CRM_DATA          archivo de SQLite/JSONL
 *    PHYTO_CRM_TOKEN         clave del panel (obligatoria para administrar)
 *    PHYTO_CRM_PORT/HOST     puerto e interfaz (por defecto 8787 / 127.0.0.1)
 *    PHYTO_ADMIN_DIR         carpeta de la app del panel (por defecto: dist/admin)
 *    PHYTO_CRM_ALLOWED_ORIGIN  CORS, solo si la web vive en otro dominio
 *    PHYTO_CRM_TZ            zona horaria del negocio (por defecto America/Santo_Domingo)
 *
 *  Documentación: docs/CRM-CONTRACT.md y docs/PANEL.md
 * ============================================================================
 */

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CLOSED_STATUSES,
  STATUSES,
  computeStats,
  createStore,
  day,
  dueToday,
  longText,
  messageId,
  text,
} from './stores.mjs';

const PORT = Number.parseInt(process.env.PHYTO_CRM_PORT ?? '8787', 10);
const HOST = process.env.PHYTO_CRM_HOST ?? '127.0.0.1';
const DATA_FILE = path.resolve(process.env.PHYTO_CRM_DATA ?? path.join('data', 'phytoemagry.sqlite'));
const DATABASE_URL = (process.env.PHYTO_CRM_DATABASE_URL ?? '').trim();
const TOKEN = (process.env.PHYTO_CRM_TOKEN ?? '').trim();
const ALLOWED_ORIGIN = (process.env.PHYTO_CRM_ALLOWED_ORIGIN ?? '').trim();
const TIME_ZONE = (process.env.PHYTO_CRM_TZ ?? 'America/Santo_Domingo').trim();

/**
 * Carpeta de la app del panel. Se resuelve al arrancar (no al importar) para
 * poder apuntarla desde los tests o desde otro directorio con `PHYTO_ADMIN_DIR`.
 */
function resolveAdminDir(configured) {
  if (configured) return path.resolve(configured);
  if (process.env.PHYTO_ADMIN_DIR) return path.resolve(process.env.PHYTO_ADMIN_DIR);
  const built = path.join(process.cwd(), 'dist', 'admin');
  return existsSync(built) ? built : path.join(process.cwd(), 'public', 'admin');
}

/** Tamaño máximo del cuerpo aceptado (un pedido ocupa ~1 kB). */
const MAX_BODY_BYTES = 64 * 1024;
/** Tipos de registro que acepta la web (ver src/lib/api.js). */
const TYPES = new Set(['lead', 'order_intent']);
/** Duración de la sesión del panel (90 días: se instala y no se vuelve a pedir). */
const SESSION_SECONDS = 90 * 24 * 60 * 60;
const COOKIE = 'pe_crm';

const STATUS_LABELS = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  confirmado: 'Confirmado',
  entregado: 'Entregado',
  perdido: 'Perdido',
};

// ------------------------------------------------------------------ utilidades

/** ¿La clave recibida es la configurada? Comparación en tiempo constante. */
function tokenOk(candidate, expectedToken) {
  if (!expectedToken || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function cors(res, allowedOrigin) {
  if (!allowedOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-crm-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

/** Lee el cuerpo con tope de tamaño. @returns {Promise<any>} */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
  });
}

/**
 * Convierte el payload de la web (ver docs/CRM-CONTRACT.md) en una fila.
 * No rechaza campos desconocidos: se guarda el payload completo.
 */
function toRow(payload) {
  const type = text(payload.type, 40);
  if (!TYPES.has(type)) {
    const error = /** @type {any} */ (new Error('invalid_type'));
    error.status = 422;
    throw error;
  }
  const customer = payload.customer ?? {};
  const number = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null);

  return {
    id: text(payload.id, 80) ?? randomBytes(16).toString('hex'),
    type,
    receivedAt: text(payload.createdAt, 40) ?? new Date().toISOString(),
    name: text(payload.name, 120) ?? text(customer.name, 120),
    phone: text(payload.phone, 40) ?? text(customer.phone, 40),
    location: text(payload.location, 120) ?? text(customer.location, 120),
    variantId: text(payload.variantId, 60),
    variantName: text(payload.variantName, 60) ?? text(payload.product?.presentation, 60),
    capsules: number(payload.capsules),
    quantity: number(payload.quantity),
    unitPrice: number(payload.unitPrice),
    total: number(payload.total),
    currency: text(payload.currency, 8) ?? text(payload.product?.currency, 8),
    source: text(payload.source, 40),
    sessionId: text(payload.sessionId, 80),
    payload: JSON.stringify(payload),
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  return /[",;\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function typeLabel(type) {
  return type === 'order_intent' ? 'Pedido' : 'Contacto';
}

// ------------------------------------------------------------------ sesiones

/*
 * Sesión sin estado en el servidor: la cookie lleva la caducidad y una firma
 * HMAC hecha con la propia clave del panel. Así no hay tabla de sesiones, aguanta
 * un reinicio y, si cambias PHYTO_CRM_TOKEN, todas las sesiones dejan de valer.
 */
function signSession(expiresAt, secret) {
  return createHmac('sha256', secret).update(`admin:${expiresAt}`).digest('base64url');
}

function createSessionValue(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${expiresAt}.${signSession(expiresAt, secret)}`;
}

function sessionValid(value, secret) {
  if (!secret || typeof value !== 'string') return false;
  const [rawExpires, signature] = value.split('.');
  const expiresAt = Number.parseInt(rawExpires ?? '', 10);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  return tokenOk(signature, signSession(expiresAt, secret));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isSecureRequest(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, value) {
  const attributes = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  attributes.push(value ? `Max-Age=${SESSION_SECONDS}` : 'Max-Age=0');
  if (isSecureRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

/** Límite de intentos de clave por IP: frena la fuerza bruta sin molestar. */
const loginAttempts = new Map();

function loginAllowed(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || entry.until < Date.now()) return true;
  return entry.count < 10;
}

function registerLoginFailure(ip) {
  const entry = loginAttempts.get(ip) ?? { count: 0, until: 0 };
  loginAttempts.set(ip, { count: entry.count + 1, until: Date.now() + 15 * 60 * 1000 });
}

// ------------------------------------------------------------------ estáticos

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sirve un archivo de la app del panel (sin poder salir de su carpeta). */
function serveAdminFile(res, urlPath, adminDir) {
  const relative = urlPath.replace(/^\/admin\/?/, '') || 'index.html';
  const target = path.resolve(adminDir, relative);
  if (!target.startsWith(adminDir) || !existsSync(target) || !statSync(target).isFile()) {
    json(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
    // El panel y su service worker nunca se cachean: publicar = ver el cambio ya.
    'cache-control': 'no-cache, must-revalidate',
    'service-worker-allowed': '/admin/',
    'x-robots-tag': 'noindex, nofollow',
  });
  res.end(body);
}

// -------------------------------------------------------------------- rutas

async function handle(req, res, ctx) {
  const { store, token } = ctx;
  cors(res, ctx.allowedOrigin);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // --------------------------------------------------------------- público
  if (route === '/api/health') {
    json(res, 200, { ok: true, storage: store.kind, items: await store.count() });
    return;
  }

  if (route === '/api/crm' && req.method === 'POST') {
    /** @type {any} */
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, /** @type {any} */ (error).status ?? 400, { ok: false, error: error.message });
      return;
    }
    const payload = Array.isArray(body) ? body : [body];
    /** @type {{id:string, duplicate:boolean}[]} */
    const saved = [];
    try {
      for (const item of payload.slice(0, 25)) {
        const row = toRow(item ?? {});
        const result = await store.save(row);
        saved.push({ id: row.id, duplicate: result.duplicate });
        if (!result.duplicate) {
          console.log(`[crm] guardado ${row.type} ${row.id}${row.variantName ? ` · ${row.variantName}` : ''}`);
        }
      }
    } catch (error) {
      json(res, /** @type {any} */ (error).status ?? 400, { ok: false, error: error.message, saved });
      return;
    }
    json(res, 202, { ok: true, saved, storage: store.kind });
    return;
  }

  // --------------------------------------------------- app instalable (PWA)
  if (route === '/admin' || route.startsWith('/admin/')) {
    serveAdminFile(res, url.pathname, ctx.adminDir);
    return;
  }

  // Enlace antiguo con la clave en la URL: entra y limpia la barra de direcciones.
  if (route === '/panel') {
    const candidate = url.searchParams.get('token');
    if (candidate && tokenOk(candidate, token)) setSessionCookie(req, res, createSessionValue(token));
    res.writeHead(302, { location: '/admin/', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  const authenticated = sessionValid(readCookie(req, COOKIE), token);

  // ------------------------------------------------------------- el panel
  if (route === '/api/admin/login' && req.method === 'POST') {
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?');
    if (!loginAllowed(ip)) {
      json(res, 429, {
        ok: false,
        error: 'too_many_attempts',
        message: 'Demasiados intentos seguidos. Espera 15 minutos.',
      });
      return;
    }
    /** @type {any} */
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'no_token',
        message: 'Define PHYTO_CRM_TOKEN en el servidor para poder entrar al panel.',
      });
      return;
    }
    if (!tokenOk(text(body.token, 200) ?? '', token)) {
      registerLoginFailure(ip);
      json(res, 401, { ok: false, error: 'invalid_token', message: 'La clave no es correcta.' });
      return;
    }
    loginAttempts.delete(ip);
    setSessionCookie(req, res, createSessionValue(token));
    json(res, 200, { ok: true, storage: store.kind });
    return;
  }

  if (route === '/api/admin/logout' && req.method === 'POST') {
    setSessionCookie(req, res, '');
    json(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/session') {
    json(res, 200, { ok: authenticated, storage: store.kind, timeZone: TIME_ZONE });
    return;
  }

  if (route.startsWith('/api/admin/')) {
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'no_token',
        message: 'Define PHYTO_CRM_TOKEN en el servidor para poder usar el panel.',
      });
      return;
    }
    if (!authenticated) {
      json(res, 401, { ok: false, error: 'unauthorized', message: 'Entra con tu clave.' });
      return;
    }

    // Todo lo que necesita el panel en una sola petición (móvil con mala señal).
    if (route === '/api/admin/data' && req.method === 'GET') {
      const items = await store.listAdmin({ limit: 500 });
      const messages = await store.messages().list();
      json(res, 200, {
        ok: true,
        storage: store.kind,
        timeZone: TIME_ZONE,
        statuses: STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] ?? value })),
        items,
        messages,
        stats: computeStats(items, TIME_ZONE),
        pendientes: dueToday(items, TIME_ZONE).map((item) => item.id),
      });
      return;
    }

    if (route.startsWith('/api/admin/items/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const id = decodeURIComponent(route.slice('/api/admin/items/'.length));
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      /** @type {Record<string, unknown>} */
      const patch = {};
      if (body.status !== undefined) {
        const status = text(body.status, 20);
        if (!STATUSES.includes(status)) {
          json(res, 422, { ok: false, error: 'invalid_status' });
          return;
        }
        patch.status = status;
      }
      if (body.notes !== undefined) patch.notes = longText(body.notes, 2000);
      if (body.nextActionAt !== undefined) patch.nextActionAt = day(body.nextActionAt);
      if (body.contacted) {
        patch.lastContactAt = new Date().toISOString();
        if (patch.status === undefined) patch.status = 'contactado';
      }
      const updated = await store.update(id, patch);
      if (!updated) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      console.log(`[crm] actualizado ${id}${patch.status ? ` → ${patch.status}` : ''}`);
      json(res, 200, { ok: true, item: updated });
      return;
    }

    if (route === '/api/admin/messages' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const name = text(body.name, 60);
      const messageBody = longText(body.body, 1200);
      if (!name || !messageBody) {
        json(res, 422, { ok: false, error: 'invalid_message', message: 'La plantilla necesita nombre y texto.' });
        return;
      }
      const message = {
        id: text(body.id, 60) ?? messageId(name),
        name,
        body: messageBody,
        position: Number.isFinite(Number(body.position)) ? Math.trunc(Number(body.position)) : 99,
      };
      await store.messages().save(message);
      console.log(`[crm] plantilla guardada: ${message.name}`);
      json(res, 200, { ok: true, message, messages: await store.messages().list() });
      return;
    }

    if (route.startsWith('/api/admin/messages/') && req.method === 'DELETE') {
      const id = decodeURIComponent(route.slice('/api/admin/messages/'.length));
      await store.messages().remove(id);
      json(res, 200, { ok: true, messages: await store.messages().list() });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  // --------------------------------------- lectura por clave (curl / scripts)
  if (route === '/api/crm/items' || route === '/api/crm/export.csv') {
    const candidate = url.searchParams.get('token') ?? req.headers['x-crm-token'];
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'read_disabled',
        message:
          'Para leer los datos define PHYTO_CRM_TOKEN en el servidor. Mientras no lo hagas, la web sigue guardando los registros.',
      });
      return;
    }
    // Vale la clave (`?token=`, para curl) o la sesión del panel (la cookie).
    if (!tokenOk(typeof candidate === 'string' ? candidate : '', token) && !authenticated) {
      json(res, 401, { ok: false, error: 'invalid_token', message: 'La clave (?token=) no es correcta.' });
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
    const type = url.searchParams.get('type');
    const rows = await store.list({ limit, type: type === 'lead' || type === 'order_intent' ? type : null });

    if (route === '/api/crm/export.csv') {
      const header = [
        'fecha',
        'tipo',
        'estado',
        'nombre',
        'telefono',
        'ciudad',
        'frasco',
        'capsulas',
        'cantidad',
        'precio_unitario',
        'total',
        'moneda',
        'origen',
        'recordatorio',
        'notas',
        'ultimo_contacto',
      ];
      const lines = rows.map((row) =>
        [
          row.received_at,
          typeLabel(row.type),
          STATUS_LABELS[row.status ?? 'nuevo'] ?? row.status,
          row.name,
          row.phone,
          row.location,
          row.variant_name,
          row.capsules,
          row.quantity,
          row.unit_price,
          row.total,
          row.currency,
          row.source,
          row.next_action_at,
          row.notes,
          row.last_contact_at,
        ]
          .map(csvCell)
          .join(','),
      );
      const csv = `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="pedidos-phytoemagry.csv"',
        'cache-control': 'no-store',
      });
      res.end(csv);
      return;
    }

    json(res, 200, {
      ok: true,
      storage: store.kind,
      total: await store.count(),
      count: rows.length,
      items: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not_found' });
}

// ------------------------------------------------------------------ arranque

/**
 * Levanta la API y el panel.
 * @param {object} [config]
 * @param {number} [config.port] 0 = puerto libre (lo elige el sistema)
 * @param {string} [config.host]
 * @param {string} [config.dataFile]
 * @param {string} [config.databaseUrl] cadena de PostgreSQL (vacía = SQLite)
 * @param {string} [config.token] clave del panel (vacía = panel desactivado)
 * @param {string} [config.adminDir] carpeta de la app del panel
 * @param {string} [config.allowedOrigin] origen permitido por CORS
 * @param {boolean} [config.quiet] no imprimir el banner de arranque
 */
export async function startCrmServer(config = {}) {
  const settings = {
    port: config.port ?? PORT,
    host: config.host ?? HOST,
    dataFile: config.dataFile ?? DATA_FILE,
    databaseUrl: config.databaseUrl ?? DATABASE_URL,
    token: config.token ?? TOKEN,
    allowedOrigin: config.allowedOrigin ?? ALLOWED_ORIGIN,
    adminDir: resolveAdminDir(config.adminDir),
    quiet: config.quiet ?? false,
  };

  const store = await createStore({ databaseUrl: settings.databaseUrl, dataFile: settings.dataFile });
  const ctx = {
    store,
    token: settings.token,
    allowedOrigin: settings.allowedOrigin,
    adminDir: settings.adminDir,
  };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((error) => {
      console.error('[crm] error:', error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'server_error' });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : settings.port;

  if (!settings.quiet) {
    console.log(`[crm] escuchando en http://${settings.host}:${port} · almacén ${store.kind} → ${store.file}`);
    console.log(`[crm] panel: http://${settings.host}:${port}/admin/ · app instalable (PWA)`);
    if (!settings.token) {
      console.warn('[crm] PHYTO_CRM_TOKEN sin definir: guardar funciona, el panel está desactivado.');
    }
  }

  return {
    port,
    url: `http://${settings.host}:${port}`,
    storage: store.kind,
    file: store.file,
    adminDir: settings.adminDir,
    server,
    store,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(async () => {
          try {
            await store.close();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
  };
}

// Solo arranca sola cuando se ejecuta directamente (`node server/crm-server.mjs`).
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const app = await startCrmServer();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[crm] ${signal}: cerrando…`);
      await app.close();
      process.exit(0);
    });
  }
}

export { CLOSED_STATUSES, STATUSES };
