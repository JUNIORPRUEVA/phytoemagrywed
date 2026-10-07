/**
 * ============================================================================
 *  Almacenes del CRM: PostgreSQL, SQLite o un archivo JSONL.
 *
 *  Los tres exponen la MISMA interfaz, así que el API y el panel no saben (ni
 *  les importa) dónde están los datos:
 *
 *    save(row)                 → guarda un `lead`/`order_intent` (sin duplicar)
 *    list({limit,type})        → últimos registros (API pública / CSV)
 *    listAdmin(filtros)        → registros + campos de gestión (el panel)
 *    update(id, patch)         → estado, notas y recordatorio
 *    stats()                   → cuenta por estado y "hoy"
 *    messages().{list,save,remove} → plantillas de WhatsApp
 *    count()                   → total
 *    close()
 *
 *  Postgres es el recomendado en producción; SQLite (con `node:sqlite`, dentro
 *  de Node) es el modo sin configuración y JSONL la red de seguridad.
 * ============================================================================
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BUSINESS_COMPLETED_PURCHASE_STATUS, isCompletedPurchaseStatus } from './orders.mjs';

/** Tabla de registros (nombre propio: no choca con otras apps del servidor). */
export const TABLE = 'phytoemagry_items';
/** Tabla de plantillas de mensajes de WhatsApp. */
export const MESSAGES_TABLE = 'phytoemagry_messages';

/**
 * Estados por los que pasa un contacto o un pedido.
 *
 * Los tres primeros (`nuevo`, `contactado`, `interesado`) describen la RELACIÓN;
 * los de entrega describen el PEDIDO. Se añadieron `en_preparacion`, `enviado` y
 * `cancelado` porque el proceso de entrega no los tenía; no se duplican los que ya
 * existían (`confirmado`, `entregado`, `perdido`).
 */
export const STATUSES = [
  'nuevo',
  'contactado',
  'interesado',
  'confirmado',
  'en_preparacion',
  'enviado',
  'entregado',
  'cancelado',
  'perdido',
];
/** Estados que cierran el seguimiento (no piden recordatorio). */
export const CLOSED_STATUSES = [BUSINESS_COMPLETED_PURCHASE_STATUS, 'cancelado', 'perdido'];

/** Plantillas iniciales: se pueden editar y borrar desde el panel. */
export const DEFAULT_MESSAGES = [
  {
    id: 'msg-saludo',
    name: 'Saludo inicial',
    body:
      'Hola {nombre}, te escribo de {negocio}. Vi que te interesaste por el frasco de {frasco}. ' +
      '¿Te ayudo con alguna duda?',
  },
  {
    id: 'msg-pedido',
    name: 'Confirmar pedido',
    body:
      'Hola {nombre}, recibí tu pedido: {cantidad} frasco(s) de {frasco} ({total}). ' +
      '¿Lo confirmo y te digo cómo coordinamos la entrega?',
  },
  {
    id: 'msg-recordatorio',
    name: 'Recordatorio',
    body: 'Hola {nombre}, ¿seguimos con tu pedido de {frasco}? Te lo dejo apartado sin compromiso.',
  },
  {
    id: 'msg-seguimiento',
    name: 'Seguimiento (sin respuesta)',
    body:
      'Hola {nombre}, te escribí hace unos días por el frasco de {frasco}. ' +
      'Si quieres te resuelvo cualquier duda por aquí.',
  },
  {
    id: 'msg-gracias',
    name: 'Agradecimiento',
    body: '¡Gracias por tu compra, {nombre}! Cualquier cosa que necesites me escribes por aquí.',
  },
  {
    id: 'msg-precios-phyto',
    name: 'Precios Phytoemagry',
    body:
      '*Precios Phytoemagry*\n\n' +
      '5 cápsulas - RD$1,250\n' +
      '7 cápsulas - RD$1,750\n' +
      '10 cápsulas - RD$2,500\n' +
      '15 cápsulas - RD$3,750\n' +
      '20 cápsulas - RD$5,000\n' +
      '30 cápsulas - RD$6,000\n' +
      '60 cápsulas - RD$10,000\n\n' +
      'Dime cuál frasco deseas y te ayudo con tu pedido.',
  },
  {
    id: 'msg-bienvenida-phyto',
    name: 'Bienvenida + grupos',
    body:
      'Saludos {nombre}, bienvenida a *Phytoemagry*.\n\n' +
      'Phytoemagry es un producto fitoterápico en cápsulas para integrarlo a tu rutina diaria.\n\n' +
      '*Modo de uso*\n' +
      '1 cápsula al día después del desayuno.\n\n' +
      '*Grupos de apoyo*\n' +
      'Puedes unirte para ver testimonios, resultados y hacer tus preguntas con más confianza:\n\n' +
      'Grupo 5\n' +
      'https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4\n\n' +
      'Grupo 1\n' +
      'https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t\n\n' +
      'Grupo 2\n' +
      'https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t\n\n' +
      'Grupo 3\n' +
      'https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK\n\n' +
      'Grupo 4\n' +
      'https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
  },
  {
    id: 'msg-grupos-phyto',
    name: 'Grupos de apoyo',
    body:
      '*Grupos de apoyo Phytoemagry*\n\n' +
      'Puedes unirte para ver testimonios, resultados y hacer todas tus preguntas durante tu proceso.\n\n' +
      'Grupo 5\n' +
      'https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4\n\n' +
      'Grupo 1\n' +
      'https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t\n\n' +
      'Grupo 2\n' +
      'https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t\n\n' +
      'Grupo 3\n' +
      'https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK\n\n' +
      'Grupo 4\n' +
      'https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
  },
  {
    id: 'msg-cuentas-banco',
    name: 'Cuentas de banco',
    body:
      '*Cuentas disponibles*\n\n' +
      'Banco Popular\n' +
      'FULLTECH SRL\n' +
      '0841088008\n\n' +
      'BHD\n' +
      'Yunior Lopez de la Rosa\n' +
      '28726660019\n\n' +
      'Banreservas\n' +
      'Yunior Lopez de la Rosa\n' +
      '9600921403\n\n' +
      'Cuando realices el pago, envíame el comprobante por aquí, por favor.',
  },
  {
    id: 'msg-modo-uso',
    name: 'Uso recomendado',
    body:
      '*Uso recomendado*\n\n' +
      'Tomar 1 cápsula al día después del desayuno.\n\n' +
      'Si deseas, dime cuál frasco te interesa y te ayudo con tu pedido.',
  },
  {
    id: 'msg-como-pedir',
    name: 'Cómo pedir',
    body:
      '*Para hacer tu pedido*\n\n' +
      'Envíame estos datos:\n' +
      'Nombre\n' +
      'Frasco que deseas\n' +
      'Ubicación o sector\n\n' +
      'Con eso te confirmo disponibilidad, total y forma de entrega antes de cerrar.',
  },
  {
    id: 'msg-pago-entrega',
    name: 'Pago y entrega',
    body:
      '*Pago y entrega*\n\n' +
      'Por WhatsApp coordinamos todo contigo.\n\n' +
      'Primero te confirmo el total del pedido. Luego coordinamos el pago y enviamos tu pedido con el mensajero cuando esté listo.',
  },
];

const LEGACY_DEFAULT_MESSAGE_BODIES = new Map([
  [
    'msg-precios-phyto',
    [
      'Precios por frasco:\n' +
        '5 cápsulas: RD$1,250\n' +
        '7 cápsulas: RD$1,750\n' +
        '10 cápsulas: RD$2,500\n' +
        '15 cápsulas: RD$3,750\n' +
        '20 cápsulas: RD$5,000\n' +
        '30 cápsulas: RD$6,000\n' +
        '60 cápsulas: RD$10,000\n\n' +
        'Dime cuál deseas y te ayudo con el pedido.',
    ],
  ],
  [
    'msg-bienvenida-phyto',
    [
      'Saludos {nombre}, bienvenida a Phytoemagry. Es un producto fitoterápico en cápsulas para integrarlo a tu rutina diaria. Se toma 1 cápsula al día después del desayuno.\n\n' +
        'También puedes unirte a nuestros grupos para ver resultados, testimonios y hacer tus preguntas con más confianza:\n' +
        'Grupo 5: https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4\n' +
        'Grupo 1: https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t\n' +
        'Grupo 2: https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t\n' +
        'Grupo 3: https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK\n' +
        'Grupo 4: https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
    ],
  ],
  [
    'msg-grupos-phyto',
    [
      'Si deseas, puedes unirte a uno de nuestros grupos de WhatsApp para ver resultados, testimonios y hacer tus preguntas. Son grupos de apoyo durante tu proceso.\n\n' +
        'Grupo 5: https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4\n' +
        'Grupo 1: https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t\n' +
        'Grupo 2: https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t\n' +
        'Grupo 3: https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK\n' +
        'Grupo 4: https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
    ],
  ],
  [
    'msg-cuentas-banco',
    [
      'Cuentas disponibles:\n' +
        'Popular: 0841088008 - FULLTECH SRL\n' +
        'BHD: 28726660019 - Yunior Lopez de la Rosa\n' +
        'Banreservas: 9600921403 - Yunior Lopez de la Rosa\n\n' +
        'Cuando realices el pago, envíame el comprobante por aquí, por favor.',
    ],
  ],
  [
    'msg-modo-uso',
    [
      'Modo de uso: 1 cápsula al día después del desayuno. Si deseas, dime cuál frasco te interesa y te ayudo con el pedido.',
    ],
  ],
  [
    'msg-como-pedir',
    [
      'Para hacer tu pedido solo dime el frasco que deseas, tu nombre y tu ubicación. Te confirmo disponibilidad, total y forma de entrega antes de cerrar.',
    ],
  ],
  [
    'msg-pago-entrega',
    [
      'Por WhatsApp coordinamos pago y entrega. Te confirmo el total primero, y luego enviamos tu pedido con el mensajero cuando esté listo.',
    ],
  ],
]);

function shouldUpgradeDefaultMessage(current, next) {
  if (!current) return false;
  return (LEGACY_DEFAULT_MESSAGE_BODIES.get(next.id) ?? []).includes(String(current.body ?? ''));
}

function seedMissingDefaultMessages(store) {
  const current = store.messages().list();
  const currentById = new Map(current.map((message) => [message.id, message]));
  const known = new Set(currentById.keys());
  let nextPosition = current.reduce((max, message) => Math.max(max, Number(message.position ?? -1)), -1) + 1;
  for (const [index, message] of DEFAULT_MESSAGES.entries()) {
    const existing = currentById.get(message.id);
    if (existing && shouldUpgradeDefaultMessage(existing, message)) {
      store.messages().save({ ...message, position: existing.position ?? index });
      continue;
    }
    if (known.has(message.id)) continue;
    store.messages().save({ ...message, position: nextPosition || index });
    nextPosition += 1;
  }
}

async function seedMissingDefaultMessagesAsync(store) {
  const current = await store.messages().list();
  const currentById = new Map(current.map((message) => [message.id, message]));
  const known = new Set(currentById.keys());
  let nextPosition = current.reduce((max, message) => Math.max(max, Number(message.position ?? -1)), -1) + 1;
  for (const [index, message] of DEFAULT_MESSAGES.entries()) {
    const existing = currentById.get(message.id);
    if (existing && shouldUpgradeDefaultMessage(existing, message)) {
      await store.messages().save({ ...message, position: existing.position ?? index });
      continue;
    }
    if (known.has(message.id)) continue;
    await store.messages().save({ ...message, position: nextPosition || index });
    nextPosition += 1;
  }
}

// ------------------------------------------------------------------ utilidades

/** Texto corto y sin saltos de línea, para la tabla y el CSV. */
export function text(value, max = 120) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Texto largo (notas y plantillas): conserva los saltos de línea. */
export function longText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\r\n/g, '\n').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Entero o null (los precios viajan en unidades enteras de la moneda). */
export function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

/** Fecha `YYYY-MM-DD` o null. Se guarda por DÍAS: un recordatorio no necesita hora. */
export function day(value) {
  const raw = text(value, 10);
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** `` `YYYY-MM-DD` '' de hoy en la zona del negocio (no en UTC). */
export function todayIn(timeZone = 'America/Santo_Domingo') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** Rows del archivo JSONL, saltando las líneas corruptas. */
export function readRows(file) {
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
 * Fila tal y como se guarda (misma forma en los tres almacenes).
 * @param {ReturnType<typeof toRow>} row
 */
export function record(row) {
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
    /** Cliente unificado (por teléfono). Null si el pedido aún no tiene cliente. */
    customer_id: row.customerId ?? null,
    // ---- Pedido comercial (fase S4) ----
    // `order_json` guarda el detalle completo (varias líneas, descuento, entrega).
    // Las columnas de siempre siguen copiando la PRIMERA línea: lo que ya leía el
    // CSV, las estadísticas y Meta sigue funcionando igual.
    conversation_id: row.conversationId ?? null,
    order_number: row.orderNumber ?? null,
    order_json: row.orderJson ?? null,
    payload: row.payload,
    status: row.status ?? 'nuevo',
    notes: row.notes ?? null,
    next_action_at: row.nextActionAt ?? null,
    last_contact_at: row.lastContactAt ?? null,
    updated_at: row.updatedAt ?? row.receivedAt,
    // ---- Envío de la venta a Meta (API de conversiones) ----
    // Vive en la misma fila que el pedido: así la idempotencia sobrevive a un
    // reinicio (una variable en memoria no lo haría) y el CSV lo puede mostrar.
    meta_purchase_event_id: row.metaPurchaseEventId ?? null,
    meta_purchase_sent_at: row.metaPurchaseSentAt ?? null,
    meta_purchase_status: row.metaPurchaseStatus ?? null,
    meta_purchase_attempts: row.metaPurchaseAttempts ?? 0,
    meta_purchase_error: row.metaPurchaseError ?? null,
  };
}

/** Redondea un registro leído de un almacén que no tiene los campos nuevos. */
function normalize(item) {
  return {
    ...item,
    status: item?.status ?? 'nuevo',
    notes: item?.notes ?? null,
    next_action_at: item?.next_action_at ?? null,
    last_contact_at: item?.last_contact_at ?? null,
    updated_at: item?.updated_at ?? item?.received_at ?? null,
    customer_id: item?.customer_id ?? null,
    conversation_id: item?.conversation_id ?? null,
    order_number: item?.order_number ?? null,
    order_json: item?.order_json ?? null,
    meta_purchase_event_id: item?.meta_purchase_event_id ?? null,
    meta_purchase_sent_at: item?.meta_purchase_sent_at ?? null,
    meta_purchase_status: item?.meta_purchase_status ?? null,
    meta_purchase_attempts: Number.isFinite(Number(item?.meta_purchase_attempts))
      ? Number(item.meta_purchase_attempts)
      : 0,
    meta_purchase_error: item?.meta_purchase_error ?? null,
  };
}

/** Filtro común del panel (se aplica en memoria y en SQL). */
function matches(item, { type = null, status = null, view = null, q = null }) {
  if (type && item.type !== type) return false;
  if (status && item.status !== status) return false;
  if (view === 'nuevos' && item.status !== 'nuevo') return false;
  if (view === 'pedidos' && item.type !== 'order_intent') return false;
  if (view === 'abiertos' && CLOSED_STATUSES.includes(item.status)) return false;
  if (view === 'recordatorio' && !item.next_action_at) return false;
  if (q) {
    const needle = String(q).toLowerCase();
    const haystack = [item.name, item.phone, item.location, item.variant_name, item.notes]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Cuentas del panel (mismo resultado en los tres almacenes). */
export function computeStats(items, timeZone) {
  const today = todayIn(timeZone);
  const open = items.filter((item) => !CLOSED_STATUSES.includes(item.status));
  const withReminder = open.filter((item) => item.next_action_at);
  return {
    today,
    total: items.length,
    nuevos: items.filter((item) => item.status === 'nuevo').length,
    hoy: withReminder.filter((item) => item.next_action_at <= today).length,
    atrasados: withReminder.filter((item) => item.next_action_at < today).length,
    pedidos: open.filter((item) => item.type === 'order_intent').length,
    entregados: items.filter((item) => isCompletedPurchaseStatus(item.status)).length,
    valorAbierto: open.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    valorCobrado: items
      .filter((item) => isCompletedPurchaseStatus(item.status))
      .reduce((sum, item) => sum + (Number(item.total) || 0), 0),
  };
}

/** Los pendientes de hoy: recordatorio vencido o de hoy, sin cerrar. */
export function dueToday(items, timeZone) {
  const today = todayIn(timeZone);
  return items
    .filter((item) => !CLOSED_STATUSES.includes(item.status) && item.next_action_at && item.next_action_at <= today)
    .sort((a, b) => String(a.next_action_at).localeCompare(String(b.next_action_at)));
}

// --------------------------------------------------------------------- SQLite

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

  // Migración: los campos de gestión del panel se añaden si no están.
  const existing = db.prepare('PRAGMA table_info(items)').all().map((column) => column.name);
  const addColumn = (name, ddl) => {
    if (!existing.includes(name)) db.exec(`ALTER TABLE items ADD COLUMN ${ddl}`);
  };
  addColumn('status', "status TEXT NOT NULL DEFAULT 'nuevo'");
  addColumn('notes', 'notes TEXT');
  addColumn('next_action_at', 'next_action_at TEXT');
  addColumn('last_contact_at', 'last_contact_at TEXT');
  addColumn('updated_at', 'updated_at TEXT');
  addColumn('meta_purchase_event_id', 'meta_purchase_event_id TEXT');
  addColumn('meta_purchase_sent_at', 'meta_purchase_sent_at TEXT');
  addColumn('meta_purchase_status', 'meta_purchase_status TEXT');
  addColumn('meta_purchase_attempts', 'meta_purchase_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('meta_purchase_error', 'meta_purchase_error TEXT');
  addColumn('customer_id', 'customer_id TEXT');
  addColumn('conversation_id', 'conversation_id TEXT');
  addColumn('order_number', 'order_number TEXT');
  addColumn('order_json', 'order_json TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS items_customer ON items (customer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS items_conversation ON items (conversation_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    )
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO items (
      id, type, received_at, name, phone, location, variant_id, variant_name,
      capsules, quantity, unit_price, total, currency, source, session_id, payload,
      status, notes, next_action_at, last_contact_at, updated_at,
      meta_purchase_attempts, customer_id, conversation_id, order_number, order_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const count = db.prepare('SELECT COUNT(*) AS n FROM items');
  const allItems = db.prepare('SELECT * FROM items ORDER BY received_at DESC LIMIT ?');
  const byId = db.prepare('SELECT * FROM items WHERE id = ?');
  const updateItem = db.prepare(
    `UPDATE items SET status = ?, notes = ?, next_action_at = ?, last_contact_at = ?, updated_at = ?,
       meta_purchase_event_id = ?, meta_purchase_sent_at = ?, meta_purchase_status = ?,
       meta_purchase_attempts = ?, meta_purchase_error = ?, customer_id = ?,
       conversation_id = ?, order_number = ?, order_json = ?,
       variant_id = ?, variant_name = ?, capsules = ?, quantity = ?, unit_price = ?, total = ?
     WHERE id = ?`,
  );
  const allMessages = db.prepare('SELECT * FROM messages ORDER BY position, name');
  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body,
      position = excluded.position, updated_at = excluded.updated_at
  `);
  const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?');
  const deleteItem = db.prepare('DELETE FROM items WHERE id = ?');

  const store = {
    kind: 'sqlite',
    file,
    /** Conexión viva: la reutilizan otras tablas (una sola base de datos). */
    handle: db,
    timeZone: undefined,
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
        'nuevo',
        null,
        null,
        null,
        row.receivedAt,
        0,
        row.customerId ?? null,
        row.conversationId ?? null,
        row.orderNumber ?? null,
        row.orderJson ?? null,
      );
      return { duplicate: Number(result.changes) === 0 };
    },
    list({ limit, type }) {
      const rows = allItems.all(limit);
      return type ? rows.filter((row) => row.type === type) : rows;
    },
    listAdmin({ limit = 500, ...filters }) {
      return allItems
        .all(limit)
        .map(normalize)
        .filter((item) => matches(item, filters));
    },
    update(id, patch) {
      const current = byId.get(id);
      if (!current) return null;
      const item = normalize(current);
      const next = {
        status: patch.status ?? item.status,
        notes: patch.notes !== undefined ? patch.notes : item.notes,
        next_action_at:
          patch.nextActionAt !== undefined ? patch.nextActionAt : item.next_action_at,
        last_contact_at: patch.lastContactAt !== undefined ? patch.lastContactAt : item.last_contact_at,
        updated_at: new Date().toISOString(),
        meta_purchase_event_id:
          patch.metaPurchaseEventId !== undefined ? patch.metaPurchaseEventId : item.meta_purchase_event_id,
        meta_purchase_sent_at:
          patch.metaPurchaseSentAt !== undefined ? patch.metaPurchaseSentAt : item.meta_purchase_sent_at,
        meta_purchase_status:
          patch.metaPurchaseStatus !== undefined ? patch.metaPurchaseStatus : item.meta_purchase_status,
        meta_purchase_attempts: Number.isFinite(Number(patch.metaPurchaseAttempts))
          ? Number(patch.metaPurchaseAttempts)
          : item.meta_purchase_attempts,
        meta_purchase_error:
          patch.metaPurchaseError !== undefined ? patch.metaPurchaseError : item.meta_purchase_error,
        customer_id: patch.customerId !== undefined ? patch.customerId : item.customer_id,
        conversation_id:
          patch.conversationId !== undefined ? patch.conversationId : item.conversation_id,
        order_number: patch.orderNumber !== undefined ? patch.orderNumber : item.order_number,
        order_json: patch.orderJson !== undefined ? patch.orderJson : item.order_json,
        // Primera línea del pedido (compatibilidad con CSV, estadísticas y Meta).
        variant_id: patch.variantId !== undefined ? patch.variantId : item.variant_id,
        variant_name: patch.variantName !== undefined ? patch.variantName : item.variant_name,
        capsules: patch.capsules !== undefined ? patch.capsules : item.capsules,
        quantity: patch.quantity !== undefined ? patch.quantity : item.quantity,
        unit_price: patch.unitPrice !== undefined ? patch.unitPrice : item.unit_price,
        total: patch.total !== undefined ? patch.total : item.total,
      };
      updateItem.run(
        next.status,
        next.notes,
        next.next_action_at,
        next.last_contact_at,
        next.updated_at,
        next.meta_purchase_event_id,
        next.meta_purchase_sent_at,
        next.meta_purchase_status,
        next.meta_purchase_attempts,
        next.meta_purchase_error,
        next.customer_id,
        next.conversation_id,
        next.order_number,
        next.order_json,
        next.variant_id,
        next.variant_name,
        next.capsules,
        next.quantity,
        next.unit_price,
        next.total,
        id,
      );
      return { ...item, ...next };
    },
    remove(id) {
      return Number(deleteItem.run(id).changes) > 0;
    },
    messages() {
      return {
        list: () => allMessages.all(),
        save(message) {
          upsertMessage.run(message.id, message.name, message.body, message.position, new Date().toISOString());
          return message;
        },
        remove(id) {
          deleteMessage.run(id);
        },
      };
    },
    count() {
      return Number(count.get().n);
    },
    close() {
      db.close();
    },
  };

  seedMissingDefaultMessages(store);
  return store;
}

// ----------------------------------------------------------------------- JSONL

function createJsonlStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const messagesFile = `${file}.messages.jsonl`;

  const readMessages = () => readRows(messagesFile).map((row) => ({ position: 0, ...row }));
  const writeMessages = (list) => {
    // Reescritura completa: son unas pocas líneas, no merece la pena nada más listo.
    writeFileSync(messagesFile, list.map((message) => `${JSON.stringify(message)}\n`).join(''), 'utf8');
  };

  const store = {
    kind: 'jsonl',
    file,
    /** Sin conexión: las colecciones viven en archivos de este mismo directorio. */
    handle: null,
    save(row) {
      if (readRows(file).some((item) => item.id === row.id)) return { duplicate: true };
      appendFileSync(file, `${JSON.stringify(record(row))}\n`, 'utf8');
      return { duplicate: false };
    },
    list({ limit, type }) {
      const rows = readRows(file)
        .map(normalize)
        .slice(-limit)
        .reverse();
      return type ? rows.filter((row) => row.type === type) : rows;
    },
    listAdmin({ limit = 500, ...filters }) {
      return readRows(file)
        .map(normalize)
        .slice(-limit)
        .reverse()
        .filter((item) => matches(item, filters));
    },
    update(id, patch) {
      const rows = readRows(file);
      const index = rows.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const item = normalize(rows[index]);
      const next = {
        ...item,
        status: patch.status ?? item.status,
        notes: patch.notes !== undefined ? patch.notes : item.notes,
        next_action_at: patch.nextActionAt !== undefined ? patch.nextActionAt : item.next_action_at,
        last_contact_at: patch.lastContactAt !== undefined ? patch.lastContactAt : item.last_contact_at,
        updated_at: new Date().toISOString(),
        meta_purchase_event_id:
          patch.metaPurchaseEventId !== undefined ? patch.metaPurchaseEventId : item.meta_purchase_event_id,
        meta_purchase_sent_at:
          patch.metaPurchaseSentAt !== undefined ? patch.metaPurchaseSentAt : item.meta_purchase_sent_at,
        meta_purchase_status:
          patch.metaPurchaseStatus !== undefined ? patch.metaPurchaseStatus : item.meta_purchase_status,
        meta_purchase_attempts: Number.isFinite(Number(patch.metaPurchaseAttempts))
          ? Number(patch.metaPurchaseAttempts)
          : item.meta_purchase_attempts,
        meta_purchase_error:
          patch.metaPurchaseError !== undefined ? patch.metaPurchaseError : item.meta_purchase_error,
        customer_id: patch.customerId !== undefined ? patch.customerId : item.customer_id,
        conversation_id: patch.conversationId !== undefined ? patch.conversationId : item.conversation_id,
        order_number: patch.orderNumber !== undefined ? patch.orderNumber : item.order_number,
        order_json: patch.orderJson !== undefined ? patch.orderJson : item.order_json,
        variant_id: patch.variantId !== undefined ? patch.variantId : item.variant_id,
        variant_name: patch.variantName !== undefined ? patch.variantName : item.variant_name,
        capsules: patch.capsules !== undefined ? patch.capsules : item.capsules,
        quantity: patch.quantity !== undefined ? patch.quantity : item.quantity,
        unit_price: patch.unitPrice !== undefined ? patch.unitPrice : item.unit_price,
        total: patch.total !== undefined ? patch.total : item.total,
      };
      rows[index] = next;
      writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
      return next;
    },
    remove(id) {
      const rows = readRows(file);
      const next = rows.filter((item) => item.id !== id);
      if (next.length === rows.length) return false;
      writeFileSync(file, next.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
      return true;
    },
    messages() {
      const list = () => {
        const current = readMessages();
        if (current.length > 0) return current.sort((a, b) => a.position - b.position);
        return DEFAULT_MESSAGES.map((message, index) => ({ ...message, position: index }));
      };
      return {
        list,
        save(message) {
          const current = list().filter((item) => item.id !== message.id);
          current.push(message);
          writeMessages(current.sort((a, b) => a.position - b.position));
          return message;
        },
        remove(id) {
          writeMessages(list().filter((item) => item.id !== id));
        },
      };
    },
    count() {
      return readRows(file).length;
    },
    close() {},
  };
  seedMissingDefaultMessages(store);
  return store;
}

// -------------------------------------------------------------------- Postgres

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
        variant_name  text,
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

    // Campos de gestión del panel (el negocio los usa a diario).
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'nuevo'`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS notes text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS next_action_at text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS last_contact_at text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS updated_at text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS meta_purchase_event_id text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS meta_purchase_sent_at text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS meta_purchase_status text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS meta_purchase_attempts integer NOT NULL DEFAULT 0`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS meta_purchase_error text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS customer_id text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS conversation_id text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS order_number text`);
    await first.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS order_json text`);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_customer ON ${TABLE} (customer_id)`);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_conversation ON ${TABLE} (conversation_id)`);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_next_action ON ${TABLE} (next_action_at)`);
    await first.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_status ON ${TABLE} (status)`);
    await first.query(`
      CREATE TABLE IF NOT EXISTS ${MESSAGES_TABLE} (
        id text PRIMARY KEY,
        name text NOT NULL,
        body text NOT NULL,
        position integer NOT NULL DEFAULT 0,
        updated_at text
      )
    `);
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
  /** El payload como texto: mismo formato que SQLite y JSONL. */
  const SELECT = `${COLUMNS.filter((c) => c !== 'payload').join(', ')}, payload::text AS payload`;
  const SELECT_ADMIN = `${SELECT}, status, notes, next_action_at, last_contact_at, updated_at,
    meta_purchase_event_id, meta_purchase_sent_at, meta_purchase_status,
    meta_purchase_attempts, meta_purchase_error, customer_id,
    conversation_id, order_number, order_json`;
  const MESSAGE_COLUMNS = 'id, name, body, position, updated_at';

  const store = {
    kind: 'postgres',
    /** Pool vivo: lo reutilizan otras tablas (una sola base de datos). */
    handle: pool,
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
        `INSERT INTO ${TABLE} (${COLUMNS.join(', ')}, status, updated_at, conversation_id, order_number, order_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'nuevo', $17, $18, $19, $20)
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
          row.receivedAt,
          row.conversationId ?? null,
          row.orderNumber ?? null,
          row.orderJson ?? null,
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
    /**
     * Listado del panel: filtra en SQL lo que puede (tipo, estado, texto) y deja
     * el resto al filtro común, así los tres almacenes devuelven lo mismo.
     */
    async listAdmin({ limit = 500, type = null, status = null, view = null, q = null }) {
      const where = [];
      const values = [];
      if (type) {
        values.push(type);
        where.push(`type = $${values.length}`);
      }
      if (status) {
        values.push(status);
        where.push(`status = $${values.length}`);
      }
      if (q) {
        values.push(`%${String(q).toLowerCase()}%`);
        where.push(
          `(lower(coalesce(name,'')) LIKE $${values.length} OR lower(coalesce(phone,'')) LIKE $${values.length}` +
            ` OR lower(coalesce(location,'')) LIKE $${values.length} OR lower(coalesce(variant_name,'')) LIKE $${values.length}` +
            ` OR lower(coalesce(notes,'')) LIKE $${values.length})`,
        );
      }
      values.push(Math.min(limit * 2, 5000));
      const result = await pool.query(
        `SELECT ${SELECT_ADMIN} FROM ${TABLE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY received_at DESC LIMIT $${values.length}`,
        values,
      );
      return result.rows.map(normalize).filter((item) => matches(item, { type, status, view, q })).slice(0, limit);
    },
    async update(id, patch) {
      const current = await pool.query(`SELECT ${SELECT_ADMIN} FROM ${TABLE} WHERE id = $1`, [id]);
      if (current.rowCount === 0) return null;
      const item = normalize(current.rows[0]);
      const next = {
        status: patch.status ?? item.status,
        notes: patch.notes !== undefined ? patch.notes : item.notes,
        next_action_at: patch.nextActionAt !== undefined ? patch.nextActionAt : item.next_action_at,
        last_contact_at: patch.lastContactAt !== undefined ? patch.lastContactAt : item.last_contact_at,
        updated_at: new Date().toISOString(),
        meta_purchase_event_id:
          patch.metaPurchaseEventId !== undefined ? patch.metaPurchaseEventId : item.meta_purchase_event_id,
        meta_purchase_sent_at:
          patch.metaPurchaseSentAt !== undefined ? patch.metaPurchaseSentAt : item.meta_purchase_sent_at,
        meta_purchase_status:
          patch.metaPurchaseStatus !== undefined ? patch.metaPurchaseStatus : item.meta_purchase_status,
        meta_purchase_attempts: Number.isFinite(Number(patch.metaPurchaseAttempts))
          ? Number(patch.metaPurchaseAttempts)
          : item.meta_purchase_attempts,
        meta_purchase_error:
          patch.metaPurchaseError !== undefined ? patch.metaPurchaseError : item.meta_purchase_error,
        customer_id: patch.customerId !== undefined ? patch.customerId : item.customer_id,
        conversation_id:
          patch.conversationId !== undefined ? patch.conversationId : item.conversation_id,
        order_number: patch.orderNumber !== undefined ? patch.orderNumber : item.order_number,
        order_json: patch.orderJson !== undefined ? patch.orderJson : item.order_json,
        variant_id: patch.variantId !== undefined ? patch.variantId : item.variant_id,
        variant_name: patch.variantName !== undefined ? patch.variantName : item.variant_name,
        capsules: patch.capsules !== undefined ? patch.capsules : item.capsules,
        quantity: patch.quantity !== undefined ? patch.quantity : item.quantity,
        unit_price: patch.unitPrice !== undefined ? patch.unitPrice : item.unit_price,
        total: patch.total !== undefined ? patch.total : item.total,
      };
      await pool.query(
        `UPDATE ${TABLE} SET status = $1, notes = $2, next_action_at = $3, last_contact_at = $4, updated_at = $5,
           meta_purchase_event_id = $6, meta_purchase_sent_at = $7, meta_purchase_status = $8,
           meta_purchase_attempts = $9, meta_purchase_error = $10, customer_id = $11,
           conversation_id = $12, order_number = $13, order_json = $14,
           variant_id = $15, variant_name = $16, capsules = $17, quantity = $18, unit_price = $19, total = $20
         WHERE id = $21`,
        [
          next.status,
          next.notes,
          next.next_action_at,
          next.last_contact_at,
          next.updated_at,
          next.meta_purchase_event_id,
          next.meta_purchase_sent_at,
          next.meta_purchase_status,
          next.meta_purchase_attempts,
          next.meta_purchase_error,
          next.customer_id,
          next.conversation_id,
          next.order_number,
          next.order_json,
          next.variant_id,
          next.variant_name,
          next.capsules,
          next.quantity,
          next.unit_price,
          next.total,
          id,
        ],
      );
      return { ...item, ...next };
    },
    async remove(id) {
      const result = await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
      return result.rowCount > 0;
    },
    messages() {
      return {
        list: async () => (await pool.query(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGES_TABLE} ORDER BY position, name`)).rows,
        save: async (message) => {
          await pool.query(
            `INSERT INTO ${MESSAGES_TABLE} (${MESSAGE_COLUMNS}) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body,
               position = excluded.position, updated_at = excluded.updated_at`,
            [message.id, message.name, message.body, message.position, new Date().toISOString()],
          );
          return message;
        },
        remove: async (id) => {
          await pool.query(`DELETE FROM ${MESSAGES_TABLE} WHERE id = $1`, [id]);
        },
      };
    },
    async count() {
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
      return Number(result.rows[0]?.n ?? 0);
    },
    async close() {
      await pool.end();
    },
  };

  await seedMissingDefaultMessagesAsync(store);
  return store;
}

/**
 * Crea el almacén configurado. Si Postgres no responde, sigue con SQLite: nunca
 * se pierde un pedido por un problema de base de datos.
 */
export async function createStore(options = {}) {
  const { databaseUrl = '', dataFile } = options;

  if (databaseUrl) {
    try {
      return await createPostgresStore(databaseUrl);
    } catch (error) {
      console.error(`[crm] PostgreSQL configurado pero no responde (${error.message}).`);
      console.error('[crm] Se guardará en SQLite para no perder ningún pedido o contacto.');
    }
  }

  if (String(dataFile).toLowerCase().endsWith('.jsonl')) return createJsonlStore(dataFile);
  try {
    return await createSqliteStore(dataFile);
  } catch (error) {
    const fallback = String(dataFile).replace(/\.sqlite$/i, '') + '.jsonl';
    console.warn(
      `[crm] SQLite no disponible (${error.message}); se usa el archivo ${fallback}. ` +
        'En Node 22 hace falta arrancar con --experimental-sqlite.',
    );
    return createJsonlStore(fallback);
  }
}

/** Genera un id de mensaje a partir del nombre (o aleatorio si queda vacío). */
export function messageId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug ? `msg-${slug}` : `msg-${randomBytes(6).toString('hex')}`;
}
