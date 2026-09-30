/**
 * COLECCIONES — almacén de documentos uniforme para los tres backends.
 *
 * POR QUÉ EXISTE
 * El CRM (pedidos y plantillas) ya funciona con Postgres, SQLite o JSONL. Esta
 * fase añade seis entidades nuevas (clientes, conversaciones, mensajes,
 * seguimientos, contenido y plantillas de WhatsApp). Escribir ese modelo tres
 * veces —una por backend— multiplicaría por tres cada cambio y cada error.
 *
 * Aquí se implementa UNA vez un almacén de documentos con las mismas garantías
 * en los tres backends:
 *   - `id` obligatorio (clave primaria).
 *   - columnas indexadas para lo que se consulta de verdad (teléfono normalizado,
 *     conversación, fecha de programación, estado…).
 *   - claves ÚNICAS donde hace falta idempotencia: un `idempotency_key` no puede
 *     entrar dos veces (un reinicio no puede duplicar un mensaje ni un
 *     seguimiento), y un teléfono normalizado no puede crear dos clientes.
 *
 * Lo que NO es: un ORM. Guarda y devuelve documentos; las reglas de negocio
 * viven en `server/followups.mjs`, `server/whatsapp.mjs` y compañía.
 */

/** Colecciones del dominio WhatsApp/CRM y sus índices. */
export const COLLECTIONS = Object.freeze({
  customers: {
    indexed: { phone_e164: 'text', do_not_contact: 'text', automation_state: 'text', created_at: 'text' },
    unique: ['phone_e164'],
  },
  conversations: {
    indexed: { customer_id: 'text', status: 'text', last_message_at: 'text', created_at: 'text' },
  },
  messages: {
    indexed: {
      conversation_id: 'text',
      customer_id: 'text',
      wa_message_id: 'text',
      idempotency_key: 'text',
      direction: 'text',
      status: 'text',
      created_at: 'text',
    },
    unique: ['wa_message_id', 'idempotency_key'],
  },
  followups: {
    indexed: {
      customer_id: 'text',
      purchase_id: 'text',
      status: 'text',
      scheduled_at: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  content: {
    indexed: { status: 'text', type: 'text', created_at: 'text' },
  },
  wa_templates: {
    indexed: { name: 'text', status: 'text', updated_at: 'text' },
    unique: ['name'],
  },
});

/** Nombres reales de colección (valida contra la definición). */
const NAMES = Object.keys(COLLECTIONS);

/** @param {string} name */
function schemaOf(name) {
  const schema = COLLECTIONS[name];
  if (!schema) throw new Error(`colección desconocida: ${name}`);
  return schema;
}

/** `undefined` nunca debe guardarse: el JSON no lo soporta. */
function cleanValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'string' && value === '') return null;
  return value;
}

/**
 * Prepara el documento para guardarlo: sin `undefined` y con las columnas
 * indexadas extraídas para poder consultarlas.
 *
 * @param {string} name
 * @param {any} doc
 */
function prepare(name, doc) {
  const schema = schemaOf(name);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(doc)) out[key] = cleanValue(value);
  /** @type {Record<string, any>} */
  const columns = {};
  for (const field of Object.keys(schema.indexed)) {
    const value = out[field] ?? null;
    // El documento conserva el booleano; la columna guarda 0/1 porque SQLite no
    // sabe enlazar `true`/`false` como parámetro.
    columns[field] = typeof value === 'boolean' ? Number(value) : value;
  }
  return { doc: out, columns };
}

// --------------------------------------------------------------------- SQLite

async function createSqliteCollections(db, prefix) {
  /** @type {Map<string, any>} */
  const statements = new Map();

  const statementsFor = (name) => {
    const cached = statements.get(name);
    if (cached) return cached;
    const schema = schemaOf(name);
    const table = `${prefix}${name}`;
    const indexColumns = Object.entries(schema.indexed)
      .map(([column, type]) => `${column} ${type}`)
      .join(', ');
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL${indexColumns ? `, ${indexColumns}` : ''})`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (id)`);
    for (const column of schema.unique ?? []) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_u_${column} ON ${table} (${column}) WHERE ${column} IS NOT NULL`);
    }
    const allColumns = ['id', 'doc', ...Object.keys(schema.indexed)];
    /** Columnas indexadas (son una copia del documento para poder consultarlas). */
    const columnUpdates = Object.keys(schema.indexed).map((column) => ({
      column,
      statement: db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`),
    }));
    const built = {
      table,
      insert: db.prepare(
        `INSERT OR IGNORE INTO ${table} (${allColumns.join(', ')})
         VALUES (${allColumns.map(() => '?').join(', ')})`,
      ),
      get: db.prepare(`SELECT doc FROM ${table} WHERE id = ?`),
      all: db.prepare(`SELECT doc FROM ${table}`),
      update: db.prepare(`UPDATE ${table} SET doc = ? WHERE id = ?`),
      columnUpdates,
      remove: db.prepare(`DELETE FROM ${table} WHERE id = ?`),
    };
    statements.set(name, built);
    return built;
  };

  return {
    kind: 'sqlite',
    async insert(name, doc) {
      const { doc: clean, columns } = prepare(name, doc);
      const built = statementsFor(name);
      const result = built.insert.run(clean.id, JSON.stringify(clean), ...Object.keys(schemaOf(name).indexed).map((key) => columns[key]));
      return { duplicate: Number(result.changes) === 0, doc: clean };
    },
    async get(name, id) {
      const row = statementsFor(name).get.get(id);
      return row ? JSON.parse(row.doc) : null;
    },
    async findBy(name, field, value) {
      if (value === null || value === undefined) return null;
      for (const row of statementsFor(name).all.all()) {
        const doc = JSON.parse(row.doc);
        if (doc[field] === value) return doc;
      }
      return null;
    },
    async list(name, options = {}) {
      const docs = statementsFor(name)
        .all.all()
        .map((row) => JSON.parse(row.doc));
      return sortAndLimit(docs, options);
    },
    async update(name, id, patch) {
      const current = await this.get(name, id);
      if (!current) return null;
      const { doc: clean, columns } = prepare(name, { ...current, ...patch });
      const built = statementsFor(name);
      built.update.run(JSON.stringify(clean), clean.id);
      for (const entry of built.columnUpdates) {
        entry.statement.run(columns[entry.column] ?? null, clean.id);
      }
      return clean;
    },
    async remove(name, id) {
      const result = statementsFor(name).remove.run(id);
      return Number(result.changes) > 0;
    },
    async count(name) {
      return statementsFor(name).all.all().length;
    },
  };
}

// ------------------------------------------------------------------- Postgres

async function createPostgresCollections(pool, prefix) {
  const ready = new Set();

  const ensure = async (name) => {
    if (ready.has(name)) return;
    const schema = schemaOf(name);
    const table = `${prefix}${name}`;
    const indexColumns = Object.entries(schema.indexed)
      .map(([column, type]) => `${column} ${type}`)
      .join(', ');
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, doc jsonb NOT NULL${indexColumns ? `, ${indexColumns}` : ''})`,
    );
    for (const column of schema.unique ?? []) {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_u_${column} ON ${table} (${column}) WHERE ${column} IS NOT NULL`,
      );
    }
    ready.add(name);
  };

  return {
    kind: 'postgres',
    async insert(name, doc) {
      await ensure(name);
      const schema = schemaOf(name);
      const { doc: clean, columns } = prepare(name, doc);
      const fields = ['id', 'doc', ...Object.keys(schema.indexed)];
      const values = [clean.id, JSON.stringify(clean), ...Object.keys(schema.indexed).map((key) => columns[key])];
      const result = await pool.query(
        `INSERT INTO ${prefix}${name} (${fields.join(', ')})
         VALUES (${fields.map((_, index) => `$${index + 1}`).join(', ')})
         ON CONFLICT DO NOTHING`,
        values,
      );
      return { duplicate: result.rowCount === 0, doc: clean };
    },
    async get(name, id) {
      await ensure(name);
      const result = await pool.query(`SELECT doc FROM ${prefix}${name} WHERE id = $1`, [id]);
      return result.rows[0]?.doc ?? null;
    },
    async findBy(name, field, value) {
      if (value === null || value === undefined) return null;
      await ensure(name);
      const usesColumn = field in schemaOf(name).indexed;
      const result = usesColumn
        ? await pool.query(`SELECT doc FROM ${prefix}${name} WHERE ${field} = $1 LIMIT 1`, [value])
        : await pool.query(`SELECT doc FROM ${prefix}${name} WHERE doc->>$1 = $2 LIMIT 1`, [field, value]);
      return result.rows[0]?.doc ?? null;
    },
    async list(name, options = {}) {
      await ensure(name);
      const result = await pool.query(`SELECT doc FROM ${prefix}${name}`);
      return sortAndLimit(result.rows.map((row) => row.doc), options);
    },
    async update(name, id, patch) {
      await ensure(name);
      const current = await this.get(name, id);
      if (!current) return null;
      const schema = schemaOf(name);
      const { doc: clean, columns } = prepare(name, { ...current, ...patch });
      const assignments = ['doc = $2', ...Object.keys(schema.indexed).map((column, index) => `${column} = $${index + 3}`)];
      await pool.query(`UPDATE ${prefix}${name} SET ${assignments.join(', ')} WHERE id = $1`, [
        clean.id,
        JSON.stringify(clean),
        ...Object.keys(schema.indexed).map((key) => columns[key]),
      ]);
      return clean;
    },
    async remove(name, id) {
      await ensure(name);
      const result = await pool.query(`DELETE FROM ${prefix}${name} WHERE id = $1`, [id]);
      return result.rowCount > 0;
    },
    async count(name) {
      await ensure(name);
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${prefix}${name}`);
      return Number(result.rows[0]?.n ?? 0);
    },
  };
}

// ---------------------------------------------------------------------- JSONL

async function createJsonlCollections(dir, prefix) {
  const { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
  const path = await import('node:path');
  mkdirSync(dir, { recursive: true });
  const fileOf = (name) => path.join(dir, `${prefix}${name}.jsonl`);

  const read = (name) => {
    const file = fileOf(name);
    if (!existsSync(file)) return [];
    const rows = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* línea corrupta: se ignora, como en el resto del proyecto */
      }
    }
    return rows;
  };
  const writeAll = (name, rows) =>
    writeFileSync(fileOf(name), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');

  return {
    kind: 'jsonl',
    async insert(name, doc) {
      const schema = schemaOf(name);
      const { doc: clean, columns } = prepare(name, doc);
      const rows = read(name);
      if (rows.some((row) => row.id === clean.id)) return { duplicate: true, doc: clean };
      for (const column of schema.unique ?? []) {
        const value = columns[column];
        if (value !== null && rows.some((row) => row[column] === value)) return { duplicate: true, doc: clean };
      }
      appendFileSync(fileOf(name), `${JSON.stringify(clean)}\n`, 'utf8');
      return { duplicate: false, doc: clean };
    },
    async get(name, id) {
      return read(name).find((row) => row.id === id) ?? null;
    },
    async findBy(name, field, value) {
      if (value === null || value === undefined) return null;
      return read(name).find((row) => row[field] === value) ?? null;
    },
    async list(name, options = {}) {
      return sortAndLimit(read(name), options);
    },
    async update(name, id, patch) {
      const rows = read(name);
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return null;
      const next = prepare(name, { ...rows[index], ...patch }).doc;
      rows[index] = next;
      writeAll(name, rows);
      return next;
    },
    async remove(name, id) {
      const rows = read(name);
      const next = rows.filter((row) => row.id !== id);
      if (next.length === rows.length) return false;
      writeAll(name, next);
      return true;
    },
    async count(name) {
      return read(name).length;
    },
  };
}

/**
 * Orden por defecto: lo más reciente primero (`created_at` o `at`).
 * @param {any[]} docs
 * @param {{ limit?: number, order?: 'asc'|'desc', by?: string }} [options]
 */
function sortAndLimit(docs, options = {}) {
  const by = options.by ?? 'created_at';
  const order = options.order ?? 'desc';
  const sorted = [...docs].sort((a, b) => String(a[by] ?? '').localeCompare(String(b[by] ?? '')));
  if (order === 'desc') sorted.reverse();
  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

/**
 * Crea el almacén de documentos del backend que toque.
 *
 * @param {{ backend: 'sqlite'|'postgres'|'jsonl', handle: any, dir?: string, prefix?: string }} options
 */
export async function createCollections(options) {
  const prefix = options.prefix ?? 'phytoemagry_';
  if (options.backend === 'sqlite') return createSqliteCollections(options.handle, prefix);
  if (options.backend === 'postgres') return createPostgresCollections(options.handle, prefix);
  if (options.backend === 'jsonl') return createJsonlCollections(options.dir, prefix);
  throw new Error(`backend de colecciones no soportado: ${options.backend}`);
}

export { NAMES as COLLECTION_NAMES };
