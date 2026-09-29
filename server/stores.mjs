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

/** Tabla de registros (nombre propio: no choca con otras apps del servidor). */
export const TABLE = 'phytoemagry_items';
/** Tabla de plantillas de mensajes de WhatsApp. */
export const MESSAGES_TABLE = 'phytoemagry_messages';

/** Estados por los que pasa un contacto o un pedido. */
export const STATUSES = ['nuevo', 'contactado', 'interesado', 'confirmado', 'entregado', 'perdido'];
/** Estados que cierran el seguimiento (no piden recordatorio). */
export const CLOSED_STATUSES = ['entregado', 'perdido'];

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
];

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
    payload: row.payload,
    status: row.status ?? 'nuevo',
    notes: row.notes ?? null,
    next_action_at: row.nextActionAt ?? null,
    last_contact_at: row.lastContactAt ?? null,
    updated_at: row.updatedAt ?? row.receivedAt,
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
    entregados: items.filter((item) => item.status === 'entregado').length,
    valorAbierto: open.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    valorCobrado: items
      .filter((item) => item.status === 'entregado')
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
      status, notes, next_action_at, last_contact_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const count = db.prepare('SELECT COUNT(*) AS n FROM items');
  const allItems = db.prepare('SELECT * FROM items ORDER BY received_at DESC LIMIT ?');
  const byId = db.prepare('SELECT * FROM items WHERE id = ?');
  const updateItem = db.prepare(
    'UPDATE items SET status = ?, notes = ?, next_action_at = ?, last_contact_at = ?, updated_at = ? WHERE id = ?',
  );
  const allMessages = db.prepare('SELECT * FROM messages ORDER BY position, name');
  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body,
      position = excluded.position, updated_at = excluded.updated_at
  `);
  const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?');

  const store = {
    kind: 'sqlite',
    file,
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
      };
      updateItem.run(next.status, next.notes, next.next_action_at, next.last_contact_at, next.updated_at, id);
      return { ...item, ...next };
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

  if (store.messages().list().length === 0) {
    DEFAULT_MESSAGES.forEach((message, index) => store.messages().save({ ...message, position: index }));
  }
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
      };
      rows[index] = next;
      writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
      return next;
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
  const SELECT_ADMIN = `${SELECT}, status, notes, next_action_at, last_contact_at, updated_at`;
  const MESSAGE_COLUMNS = 'id, name, body, position, updated_at';

  const store = {
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
        `INSERT INTO ${TABLE} (${COLUMNS.join(', ')}, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'nuevo', $17)
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
      };
      await pool.query(
        `UPDATE ${TABLE} SET status = $1, notes = $2, next_action_at = $3, last_contact_at = $4, updated_at = $5
         WHERE id = $6`,
        [next.status, next.notes, next.next_action_at, next.last_contact_at, next.updated_at, id],
      );
      return { ...item, ...next };
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

  const existing = await store.messages().list();
  if (existing.length === 0) {
    for (const [index, message] of DEFAULT_MESSAGES.entries()) {
      await store.messages().save({ ...message, position: index });
    }
  }
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
