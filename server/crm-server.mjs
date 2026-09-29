/**
 * ============================================================================
 *  API del CRM — recibe los `lead` y los `order_intent` de la web y los guarda
 *  en una base de datos.
 *
 *  Dos almacenes, el que diga el entorno:
 *    1. PostgreSQL  → PHYTO_CRM_DATABASE_URL (recomendado en producción: los
 *       datos viven en el servidor de base de datos, no en el contenedor).
 *    2. SQLite      → PHYTO_CRM_DATA (por defecto; usa `node:sqlite`, que ya
 *       viene dentro de Node: cero dependencias y cero configuración).
 *
 *  Si Postgres está configurado pero no responde, se avisa en los logs y se
 *  sigue guardando en SQLite: perder datos nunca es una opción.
 *
 *  Rutas:
 *    POST /api/crm                  → guarda un `lead` o un `order_intent`
 *    GET  /api/health               → estado (público, sin datos personales)
 *    GET  /api/crm/items?token=...  → JSON con los registros (más nuevo primero)
 *    GET  /api/crm/export.csv?token=... → el mismo listado en CSV (Excel/Sheets)
 *    GET  /panel?token=...          → panel HTML para leerlos desde el móvil
 *
 *  Variables de entorno (todas opcionales):
 *    PHYTO_CRM_DATABASE_URL  cadena de PostgreSQL (activa el almacén Postgres)
 *    PHYTO_CRM_PORT      puerto (por defecto 8787)
 *    PHYTO_CRM_HOST      interfaz (por defecto 127.0.0.1: solo lo alcanza nginx)
 *    PHYTO_CRM_DATA      archivo de datos (por defecto ./data/phytoemagry.sqlite)
 *                        con extensión .jsonl usa el almacén JSONL
 *    PHYTO_CRM_TOKEN     clave para LEER los datos. Sin ella, leer está
 *                        desactivado (escribir sigue funcionando).
 *    PHYTO_CRM_ALLOWED_ORIGIN  origen permitido por CORS, si la web se sirve
 *                        desde otro dominio (por defecto: mismo origen)
 *
 *  Documentación: docs/CRM-CONTRACT.md y docs/DESPLIEGUE.md
 * ============================================================================
 */

import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PHYTO_CRM_PORT ?? '8787', 10);
const HOST = process.env.PHYTO_CRM_HOST ?? '127.0.0.1';
const DATA_FILE = path.resolve(process.env.PHYTO_CRM_DATA ?? path.join('data', 'phytoemagry.sqlite'));
const DATABASE_URL = (process.env.PHYTO_CRM_DATABASE_URL ?? '').trim();
const TOKEN = (process.env.PHYTO_CRM_TOKEN ?? '').trim();
const ALLOWED_ORIGIN = (process.env.PHYTO_CRM_ALLOWED_ORIGIN ?? '').trim();

/** Tabla donde se guardan los registros (nombre propio: no choca con otras apps). */
const TABLE = 'phytoemagry_items';

/** Tamaño máximo del cuerpo aceptado (un pedido ocupa ~1 kB). */
const MAX_BODY_BYTES = 64 * 1024;
/** Tipos de registro que acepta la web (ver src/lib/api.js). */
const TYPES = new Set(['lead', 'order_intent']);

// --------------------------------------------------------------------- datos

/**
 * Almacén SQLite. Es el modo normal: permite consultar, exportar y crecer sin
 * cargar todo el archivo en memoria.
 */
async function createSqliteStore(file) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      location TEXT,
      variant_id TEXT,
      variant_name TEXT,
      capsules INTEGER,
      quantity INTEGER,
      unit_price INTEGER,
      total INTEGER,
      currency TEXT,
      source TEXT,
      session_id TEXT,
      payload TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS items_received_at ON items (received_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS items_type ON items (type)');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO items (
      id, type, received_at, name, phone, location, variant_id, variant_name,
      capsules, quantity, unit_price, total, currency, source, session_id, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const count = db.prepare('SELECT COUNT(*) AS n FROM items');

  return {
    kind: 'sqlite',
    file,
    /** @param {ReturnType<typeof toRow>} row */
    save(row) {
      const result = insert.run(
        row.id,
        row.type,
        row.receivedAt,
        row.name,
        row.phone,
        row.location,
        row.variantId,
        row.variantName,
        row.capsules,
        row.quantity,
        row.unitPrice,
        row.total,
        row.currency,
        row.source,
        row.sessionId,
        row.payload,
      );
      return { duplicate: Number(result.changes) === 0 };
    },
    /** @param {{limit:number, type:string|null}} options */
    list({ limit, type }) {
      const rows = type
        ? db.prepare('SELECT * FROM items WHERE type = ? ORDER BY received_at DESC LIMIT ?').all(type, limit)
        : db.prepare('SELECT * FROM items ORDER BY received_at DESC LIMIT ?').all(limit);
      return rows;
    },
    count() {
      return Number(count.get().n);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Almacén JSONL: red de seguridad para versiones de Node sin `node:sqlite`.
 * Una línea por registro, se añade al final (nunca reescribe).
 */
function createJsonlStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });

  return {
    kind: 'jsonl',
    file,
    /** @param {ReturnType<typeof toRow>} row */
    save(row) {
      // Sin base de datos la deduplicación se hace comparando el id ya escrito.
      if (readRows(file).some((item) => item.id === row.id)) return { duplicate: true };
      appendFileSync(file, `${JSON.stringify(record(row))}\n`, 'utf8');
      return { duplicate: false };
    },
    /** @param {{limit:number, type:string|null}} options */
    list({ limit, type }) {
      return readRows(file)
        .filter((item) => (type ? item.type === type : true))
        .slice(-limit)
        .reverse();
    },
    count() {
      return readRows(file).length;
    },
    close() {},
  };
}

/**
 * Almacén PostgreSQL (producción: los datos viven en el servidor de base de
 * datos y sobreviven a cualquier despliegue). Usa un pool, así que si la
 * conexión se cae, la siguiente consulta la vuelve a abrir sola.
 * @param {string} url cadena `postgres://usuario:clave@host:puerto/base`
 */
async function createPostgresStore(url) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: 'phytoemagry-crm',
  });

  // Detecta credenciales/red mal configuradas AL ARRANCAR, no en el primer pedido.
  const first = await pool.connect();
  try {
    await first.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id            text PRIMARY KEY,
        type          text NOT NULL,
        received_at   text NOT NULL,
        name          text,
        phone         text,
        location      text,
        variant_id    text,
        variant_name   text,
        capsules      integer,
        quantity      integer,
        unit_price    integer,
        total         integer,
        currency      text,
        source        text,
        session_id    text,
        payload       jsonb NOT NULL,
        stored_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_received_at ON ${TABLE} (received_at DESC)`);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_type ON ${TABLE} (type)`);
  } finally {
    first.release();
  }

  const COLUMNS = [
    'id',
    'type',
    'received_at',
    'name',
    'phone',
    'location',
    'variant_id',
    'variant_name',
    'capsules',
    'quantity',
    'unit_price',
    'total',
    'currency',
    'source',
    'session_id',
    'payload',
  ];
  /** Columnas que se devuelven al panel/JSON (el payload como texto: mismo formato que SQLite). */
  const SELECT = `${COLUMNS.filter((c) => c !== 'payload').join(', ')}, payload::text AS payload`;

  return {
    kind: 'postgres',
    /** Sin usuario ni clave: esta cadena acaba en los logs. */
    file: (() => {
      try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
      } catch {
        return 'postgres';
      }
    })(),
    /** @param {ReturnType<typeof toRow>} row */
    async save(row) {
      const result = await pool.query(
        `INSERT INTO ${TABLE} (${COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.type,
          row.receivedAt,
          row.name,
          row.phone,
          row.location,
          row.variantId,
          row.variantName,
          row.capsules,
          row.quantity,
          row.unitPrice,
          row.total,
          row.currency,
          row.source,
          row.sessionId,
          row.payload,
        ],
      );
      // ON CONFLICT DO NOTHING → rowCount 0 significa "ya estaba" (la cola reintenta).
      return { duplicate: result.rowCount === 0 };
    },
    /** @param {{limit:number, type:string|null}} options */
    async list({ limit, type }) {
      const result = type
        ? await pool.query(
            `SELECT ${SELECT} FROM ${TABLE} WHERE type = $1 ORDER BY received_at DESC LIMIT $2`,
            [type, limit],
          )
        : await pool.query(`SELECT ${SELECT} FROM ${TABLE} ORDER BY received_at DESC LIMIT $1`, [limit]);
      return result.rows;
    },
    async count() {
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
      return Number(result.rows[0]?.n ?? 0);
    },
    async close() {
      await pool.end();
    },
  };
}

/** Lee el archivo JSONL y descarta las líneas corruptas (nunca revienta). */
function readRows(file) {
  if (!existsSync(file)) return [];
  /** @type {any[]} */
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.warn('[crm] línea ilegible en el archivo JSONL: se ignora');
    }
  }
  return rows;
}

/**
 * Fila tal y como se guarda y se devuelve (misma forma en los dos almacenes:
 * si SQLite está disponible los datos no cambian de forma al exportarlos).
 * @param {ReturnType<typeof toRow>} row
 */
function record(row) {
  return {
    id: row.id,
    type: row.type,
    received_at: row.receivedAt,
    name: row.name,
    phone: row.phone,
    location: row.location,
    variant_id: row.variantId,
    variant_name: row.variantName,
    capsules: row.capsules,
    quantity: row.quantity,
    unit_price: row.unitPrice,
    total: row.total,
    currency: row.currency,
    source: row.source,
    session_id: row.sessionId,
    payload: row.payload,
  };
}

async function createStore(options = {}) {
  const { databaseUrl = '', dataFile = DATA_FILE } = options;

  if (databaseUrl) {
    try {
      return await createPostgresStore(databaseUrl);
    } catch (error) {
      console.error(`[crm] PostgreSQL configurado pero no responde (${error.message}).`);
      console.error('[crm] Se guardará en SQLite para no perder ningún pedido o contacto.');
    }
  }

  if (dataFile.toLowerCase().endsWith('.jsonl')) return createJsonlStore(dataFile);
  try {
    return await createSqliteStore(dataFile);
  } catch (error) {
    const fallback = dataFile.replace(/\.sqlite$/i, '') + '.jsonl';
    console.warn(
      `[crm] SQLite no disponible (${error.message}); se usa el archivo ${fallback}. ` +
        'En Node 22 hace falta arrancar con --experimental-sqlite.',
    );
    return createJsonlStore(fallback);
  }
}

// ------------------------------------------------------------------ utilidades

/** Texto corto y sin saltos de línea, para la tabla y el CSV. */
function text(value, max = 120) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Entero o null (los precios viajan en unidades enteras de la moneda). */
function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  return /[",;\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

/** ¿La clave recibida es la configurada? Comparación en tiempo constante. */
function tokenOk(candidate, expectedToken) {
  if (!expectedToken || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function html(res, status, body) {
  const payload = `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>Pedidos y contactos · Phytoemagry</title>` +
    `<style>${PANEL_CSS}</style></head><body>${body}</body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function cors(res, allowedOrigin) {
  if (!allowedOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-crm-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
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
 * No rechaza campos desconocidos: se guarda el payload completo en `payload`.
 */
function toRow(payload) {
  const type = text(payload.type, 40);
  if (!TYPES.has(type)) {
    const error = /** @type {any} */ (new Error('invalid_type'));
    error.status = 422;
    throw error;
  }
  const customer = payload.customer ?? {};
  const id = text(payload.id, 80) ?? randomBytes(16).toString('hex');

  return {
    id,
    type,
    receivedAt: text(payload.createdAt, 40) ?? new Date().toISOString(),
    name: text(payload.name, 120) ?? text(customer.name, 120),
    phone: text(payload.phone, 40) ?? text(customer.phone, 40),
    location: text(payload.location, 120) ?? text(customer.location, 120),
    variantId: text(payload.variantId, 60),
    variantName: text(payload.variantName, 60) ?? text(payload.product?.presentation, 60),
    capsules: int(payload.capsules),
    quantity: int(payload.quantity),
    unitPrice: int(payload.unitPrice),
    total: int(payload.total),
    currency: text(payload.currency, 8) ?? text(payload.product?.currency, 8),
    source: text(payload.source, 40),
    sessionId: text(payload.sessionId, 80),
    payload: JSON.stringify(payload),
  };
}

function money(value, currency) {
  if (value === null || value === undefined) return '';
  const formatted = new Intl.NumberFormat('es-DO', { maximumFractionDigits: 0 }).format(value);
  return `${currency ?? 'DOP'} ${formatted}`;
}

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso ?? '';
  return new Intl.DateTimeFormat('es-DO', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Santo_Domingo',
  }).format(date);
}

function typeLabel(type) {
  return type === 'order_intent' ? 'Pedido' : 'Contacto';
}

// ---------------------------------------------------------------------- panel

const PANEL_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:16px;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f8f7;color:#14231c}
h1{font-size:1.3rem;margin:0 0 4px}
p.sub{margin:0 0 16px;color:#4a5b53}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.card{background:#fff;border:1px solid #dfe7e2;border-radius:12px;padding:12px 16px;min-width:140px}
.card b{display:block;font-size:1.6rem;line-height:1.2}
.card span{color:#4a5b53;font-size:.85rem}
a.btn{display:inline-block;background:#16613f;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:600}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dfe7e2;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eef2ef;vertical-align:top;font-size:.92rem;white-space:nowrap}
td:first-child,th:first-child{white-space:normal;min-width:120px}
th{background:#eef4f0;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#3c4b44}
tr:last-child td{border-bottom:0}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:700}
.tag--order{background:#e3f0ff;color:#134b8a}
.tag--lead{background:#eaf7ee;color:#16613f}
.empty{background:#fff;border:1px dashed #c9d6ce;border-radius:12px;padding:24px;text-align:center;color:#4a5b53}
code{background:#eef2ef;padding:2px 6px;border-radius:6px;font-size:.85rem}
.warn{background:#fff6e5;border:1px solid #f0dcb4;border-radius:12px;padding:12px 16px;margin-bottom:16px}
/* La tabla se desliza sola: la página nunca scrollea en horizontal (se lee en el móvil). */
.table-wrap{overflow-x:auto;border-radius:12px;box-shadow:0 1px 2px rgba(20,35,28,.04)}
.table-wrap table{border-radius:12px;min-width:720px}
`;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function panelPage(rows, total, token, query) {
  const orders = rows.filter((row) => row.type === 'order_intent');
  const sum = orders.reduce((acc, row) => acc + (Number(row.total) || 0), 0);
  const list = rows
    .map(
      (row) => `<tr>
      <td>${escapeHtml(when(row.received_at))}</td>
      <td><span class="tag tag--${row.type === 'order_intent' ? 'order' : 'lead'}">${escapeHtml(typeLabel(row.type))}</span></td>
      <td>${escapeHtml(row.name ?? '—')}</td>
      <td>${escapeHtml(row.phone ?? '—')}</td>
      <td>${escapeHtml(row.variant_name ?? '—')}${row.quantity ? ` ×${escapeHtml(row.quantity)}` : ''}</td>
      <td>${escapeHtml(money(row.total, row.currency))}</td>
      <td>${escapeHtml(row.location ?? '—')}</td>
    </tr>`,
    )
    .join('');

  return `
  <h1>Pedidos y contactos</h1>
  <p class="sub">Todo lo que llega por WhatsApp queda también aquí, dentro de tu servidor.</p>
  <div class="cards">
    <div class="card"><b>${total}</b><span>registros guardados</span></div>
    <div class="card"><b>${orders.length}</b><span>pedidos en esta vista</span></div>
    <div class="card"><b>${escapeHtml(money(sum, 'DOP'))}</b><span>facturado (pedidos de la vista)</span></div>
  </div>
  <p><a class="btn" href="/api/crm/export.csv?token=${encodeURIComponent(token)}">Descargar CSV</a></p>
  ${
    rows.length === 0
      ? '<div class="empty">Todavía no hay nada guardado.<br>Los pedidos y los contactos aparecen aquí en cuanto alguien usa la web.</div>'
      : `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Nombre</th><th>Teléfono</th><th>Frasco</th><th>Total</th><th>Ciudad</th></tr></thead><tbody>${list}</tbody></table></div>`
  }
  <p class="sub" style="margin-top:16px">
    ${
      query
        ? `Filtrado por <code>${escapeHtml(query)}</code> · <a href="/panel?token=${encodeURIComponent(token)}">ver todo</a> · `
        : ''
    }
    <a href="/api/crm/items?token=${encodeURIComponent(token)}">JSON</a>
  </p>`;
}

// --------------------------------------------------------------------- rutas

async function handle(req, res, ctx) {
  const { store, token: expectedToken } = ctx;
  cors(res, ctx.allowedOrigin);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

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
      json(res, /** @type {any} */ (error).status ?? 400, {
        ok: false,
        error: error.message,
        saved,
      });
      return;
    }
    json(res, 202, { ok: true, saved, storage: store.kind });
    return;
  }

  const wantsData = route === '/api/crm/items' || route === '/api/crm/export.csv' || route === '/panel';
  if (wantsData) {
    const token = url.searchParams.get('token') ?? req.headers['x-crm-token'];
    if (!ctx.token) {
      json(res, 503, {
        ok: false,
        error: 'read_disabled',
        message:
          'Para leer los datos define PHYTO_CRM_TOKEN en el servidor. Mientras no lo hagas, la web sigue guardando los registros.',
      });
      return;
    }
    if (!tokenOk(typeof token === 'string' ? token : '', ctx.token)) {
      json(res, 401, { ok: false, error: 'invalid_token', message: 'La clave (?token=) no es correcta.' });
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
    const type = url.searchParams.get('type');
    const rows = await store.list({ limit, type: type === 'lead' || type === 'order_intent' ? type : null });

    if (route === '/panel') {
      html(res, 200, panelPage(rows, await store.count(), ctx.token, type));
      return;
    }

    if (route === '/api/crm/export.csv') {
      const header = [
        'fecha',
        'tipo',
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
        'sesion',
      ];
      const lines = rows.map((row) =>
        [
          row.received_at,
          typeLabel(row.type),
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
          row.session_id,
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
 * Levanta la API. Se exporta para poder arrancarla en los tests con un puerto
 * efímero y un archivo temporal.
 * @param {object} [config]
 * @param {number} [config.port] 0 = puerto libre (lo elige el sistema)
 * @param {string} [config.host]
 * @param {string} [config.dataFile]
 * @param {string} [config.databaseUrl] cadena de PostgreSQL (vacía = SQLite)
 * @param {string} [config.token] clave para leer (vacía = leer desactivado)
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
    quiet: config.quiet ?? false,
  };

  const store = await createStore({ databaseUrl: settings.databaseUrl, dataFile: settings.dataFile });
  const ctx = { store, token: settings.token, allowedOrigin: settings.allowedOrigin };

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
    if (!settings.token) {
      console.warn('[crm] PHYTO_CRM_TOKEN sin definir: guardar funciona, leer está desactivado.');
    } else {
      console.log('[crm] panel: /panel?token=<tu clave> · CSV: /api/crm/export.csv?token=<tu clave>');
    }
  }

  return {
    port,
    url: `http://${settings.host}:${port}`,
    storage: store.kind,
    file: store.file,
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
