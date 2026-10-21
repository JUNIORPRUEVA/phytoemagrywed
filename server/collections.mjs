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
  pos_documents: {
    indexed: { kind: 'text', customer_id: 'text', created_at: 'text', status: 'text' },
  },
  customers: {
    indexed: { phone_e164: 'text', do_not_contact: 'text', automation_state: 'text', created_at: 'text' },
    unique: ['phone_e164'],
  },
  conversations: {
    indexed: { customer_id: 'text', status: 'text', assigned_user_id: 'text', last_message_at: 'text', created_at: 'text' },
  },
  /*
   * MENSAJES REALES DE WHATSAPP — la tabla física es `${prefijo}wa_messages`
   * (`phytoemagry_wa_messages`).
   *
   * OJO: NO puede llamarse `messages`, y por eso lleva el prefijo `wa_`.
   * `phytoemagry_messages` ya existía desde antes de esta fase como tabla LEGACY
   * de PLANTILLAS del CRM (`id, name, body, position, updated_at`). Como el DDL
   * usa `CREATE TABLE IF NOT EXISTS`, compartir nombre no daba ningún error al
   * arrancar: el esquema nuevo se descartaba en silencio y el primer uso
   * reventaba con un SQL crudo («column "wa_message_id" does not exist»),
   * perdiendo los mensajes entrantes de WhatsApp y rompiendo `/api/admin/data`.
   * Pasó en producción el 30/09/2026.
   */
  wa_messages: {
    indexed: {
      conversation_id: 'text',
      customer_id: 'text',
      wa_message_id: 'text',
      idempotency_key: 'text',
      direction: 'text',
      status: 'text',
      sent_by_user_id: 'text',
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
  /*
   * UBICACIONES GPS (`phytoemagry_locations`).
   *
   * Una ubicación NO es multimedia: es un dato estructurado (latitud/longitud +
   * procedencia), así que vive aquí y NO pasa por R2 ni por la tabla de media.
   *
   * Se guarda HISTORIAL: si el cliente manda otra ubicación después, la anterior
   * no se toca (los pedidos viejos siguen apuntando a la suya).
   *
   * `idempotency_key` es ÚNICO porque Meta reintenta webhooks: el mismo mensaje
   * de ubicación dos veces no puede crear dos ubicaciones.
   */
  locations: {
    indexed: {
      customer_id: 'text',
      conversation_id: 'text',
      wa_message_id: 'text',
      order_id: 'text',
      source: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key', 'wa_message_id'],
  },
  content: {
    indexed: { status: 'text', type: 'text', created_at: 'text' },
  },
  wa_templates: {
    indexed: { name: 'text', status: 'text', updated_at: 'text' },
    unique: ['name'],
  },
  /*
   * MENSAJES PROGRAMADOS — la cola persistente que sobrevive a un reinicio.
   *
   * `idempotency_key` es ÚNICO: aunque el proceso se reinicie a mitad de un envío
   * o el scheduler vuelva a ver el mismo trabajo, el mensaje no puede salir dos
   * veces (ni existir dos veces en la cola).
   */
  scheduled_messages: {
    indexed: {
      customer_id: 'text',
      conversation_id: 'text',
      order_id: 'text',
      status: 'text',
      scheduled_at: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /* AUDITORÍA COMERCIAL: quién hizo qué, sobre qué y cuándo. Nunca se borra. */
  audit: {
    indexed: { entity: 'text', entity_id: 'text', action: 'text', created_at: 'text' },
  },
  customer_tags: {
    indexed: { label: 'text', active: 'text', created_at: 'text' },
    unique: ['label'],
  },
  customer_tag_assignments: {
    indexed: { customer_id: 'text', tag_id: 'text', idempotency_key: 'text', created_at: 'text' },
    unique: ['idempotency_key'],
  },
  customer_stage_history: {
    indexed: { customer_id: 'text', created_at: 'text' },
  },
  crm_users: {
    indexed: { username: 'text', role: 'text', active: 'text', created_at: 'text' },
    unique: ['username'],
  },
  crm_sessions: {
    indexed: { user_id: 'text', expires_at: 'text', revoked_at: 'text', created_at: 'text' },
  },
  /* AJUSTES del negocio (plan de seguimiento, etc.). Un documento por clave. */
  settings: {
    indexed: { key: 'text', updated_at: 'text' },
    unique: ['key'],
  },
  /*
   * TIENDAS PROVEEDORAS (`phytoemagry_suppliers`).
   *
   * Un producto de terceros se compra en una tienda concreta; la tienda lleva
   * su ubicación GPS porque el repartidor tiene que llegar. `name_key` es la
   * llave para no duplicar la misma tienda escrita de dos formas.
   */
  suppliers: {
    indexed: { name: 'text', name_key: 'text', active: 'text', updated_at: 'text', created_at: 'text' },
  },
  /*
   * PRODUCTO ↔ TIENDA: costo en ESA tienda, disponibilidad verificada y tiempo
   * de recogida. `link_key` (`producto:tienda`) es único: no se repite el par.
   */
  product_suppliers: {
    indexed: { product_id: 'text', supplier_id: 'text', link_key: 'text', updated_at: 'text' },
    unique: ['link_key'],
  },
  /*
   * RECOGIDAS DE UN PEDIDO, agrupadas por tienda (`order_pickups`).
   * `idempotency_key` = `pickup:<pedido>:<tienda>`: volver a calcular los grupos
   * no crea recogidas nuevas.
   */
  order_pickups: {
    indexed: { order_id: 'text', supplier_id: 'text', status: 'text', idempotency_key: 'text', created_at: 'text' },
    unique: ['idempotency_key'],
  },
  /*
   * FACTURAS DE PROVEEDOR (`supplier_invoices`): el comprobante ORIGINAL de la
   * tienda donde se compró un producto de terceros. Es documentación interna y
   * NUNCA se adjunta al PDF ni al WhatsApp que recibe el cliente.
   * El archivo vive en el almacén de documentos (R2/S3 o disco), no aquí: en el
   * documento solo van los metadatos y la referencia.
   */
  supplier_invoices: {
    indexed: {
      customer_id: 'text',
      order_id: 'text',
      supplier_id: 'text',
      invoice_number: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * GARANTÍAS (`warranty_claims`): reclamación ligada a un artículo vendido, su
   * factura FULLTECH y (si existe) la factura del proveedor. Sin fechas y
   * condiciones reales no se calcula ningún plazo automáticamente.
   */
  warranty_claims: {
    indexed: { customer_id: 'text', order_id: 'text', product_id: 'text', status: 'text', created_at: 'text' },
  },
  products: {
    indexed: { product_id: 'text', updated_at: 'text' },
    unique: ['product_id'],
  },
  inventory_movements: {
    indexed: {
      product_id: 'text',
      type: 'text',
      order_id: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  delivery_tracking_sessions: {
    indexed: {
      order_id: 'text',
      delivery_user_id: 'text',
      status: 'text',
      started_at: 'text',
      ended_at: 'text',
      last_position_at: 'text',
      created_at: 'text',
    },
  },
  /*
   * BITÁCORA DEL SUPERVISOR DE DELIVERY (`delivery_supervision_events`).
   *
   * Cada recordatorio, escalamiento, respuesta del repartidor, posposición y
   * conciliación diaria queda aquí. Es la memoria que permite NO duplicar un
   * aviso (clave de idempotencia ÚNICA) y saber cuántos intentos lleva un
   * pedido, aunque el proceso se reinicie o Meta reintente el webhook.
   */
  delivery_supervision_events: {
    indexed: { order_id: 'text', kind: 'text', stage: 'text', status: 'text', created_at: 'text', idempotency_key: 'text' },
    unique: ['idempotency_key'],
  },
  delivery_location_points: {
    indexed: {
      tracking_session_id: 'text',
      delivery_user_id: 'text',
      order_id: 'text',
      recorded_at: 'text',
      suspicious_location: 'text',
    },
  },
  user_notifications: {
    indexed: {
      recipient_user_id: 'text',
      type: 'text',
      status: 'text',
      read_at: 'text',
      entity_type: 'text',
      entity_id: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * LO QUE SE BORRÓ, BORRADO SE QUEDA — Y EN EL SERVIDOR, NO EN EL TELÉFONO.
   *
   * Borrar un aviso solo en el teléfono (una lista de ids en `localStorage`) deja
   * el aviso VIVO en el CRM: vuelve a aparecer en cuanto el panel se abre desde
   * otro contexto (el icono instalado y el navegador no comparten almacén), en
   * otro teléfono, o después de limpiar los datos del sitio. Y si el suceso que
   * lo creó se vuelve a procesar, se crea OTRA fila con otro `id` y el borrado
   * del teléfono ya no coincide con nada.
   *
   * Aquí se apunta el borrado por `notification_id` y por `event_key` (la clave
   * de idempotencia del suceso). Con eso, `listUserNotifications` filtra los dos
   * casos: el aviso que se borró y el mismo suceso recreado.
   *
   * `idempotency_key` es la marca única (`notif-del:<usuario>:<aviso>`): borrar
   * dos veces el mismo aviso no duplica nada.
   */
  notification_deletions: {
    indexed: {
      user_id: 'text',
      notification_id: 'text',
      event_key: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  push_subscriptions: {
    indexed: {
      user_id: 'text',
      endpoint: 'text',
      active: 'text',
      created_at: 'text',
      last_used_at: 'text',
    },
    unique: ['endpoint'],
  },
  push_jobs: {
    indexed: {
      notification_id: 'text',
      user_id: 'text',
      endpoint: 'text',
      status: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * CENTRO DE OPERACIONES — TICKETS INTERNOS (`phytoemagry_ops_tickets`).
   *
   * NO tiene nada que ver con las conversaciones de WhatsApp del cliente: aquí
   * se trabaja puertas adentro (pedidos, entregas, incidencias, asignaciones) y
   * cada ticket es un hilo propio. Son colecciones SEPARADAS a propósito: una
   * consulta del chat del cliente no puede ver jamás un mensaje interno, y
   * viceversa.
   *
   * `active_key` es ÚNICO pero se pone a NULL al cerrar el ticket. Postgres y
   * SQLite permiten muchos NULL en un índice único, así que:
   *   - no puede existir DOS VECES el mismo flujo activo (un pedido, una
   *     incidencia por pedido…),
   *   - pero sí puede haber varios tickets históricos ya cerrados del mismo
   *     asunto, que es lo correcto.
   */
  ops_tickets: {
    indexed: {
      number: 'text',
      type: 'text',
      entity_type: 'text',
      entity_id: 'text',
      status: 'text',
      waiting_on: 'text',
      priority: 'text',
      assigned_user_id: 'text',
      assigned_agent_id: 'text',
      parent_ticket_id: 'text',
      due_at: 'text',
      follow_up_at: 'text',
      last_message_at: 'text',
      active_key: 'text',
      created_at: 'text',
    },
    unique: ['number', 'active_key'],
  },
  /*
   * MENSAJES INTERNOS DEL TICKET (`phytoemagry_ops_ticket_messages`).
   *
   * `client_key` es ÚNICA: un doble toque, un reintento de red o un reenvío del
   * agente no escriben dos veces el mismo mensaje.
   *
   * `seq` ordena el hilo y `seq_key` es el mismo número con ceros delante para
   * que ordenar por la columna indexada (texto) dé el MISMO resultado que
   * ordenar por número. Sin eso, «10» quedaría antes que «9».
   */
  ops_ticket_messages: {
    indexed: {
      ticket_id: 'text',
      seq_key: 'text',
      author_type: 'text',
      author_id: 'text',
      kind: 'text',
      client_key: 'text',
      created_at: 'text',
    },
    unique: ['client_key'],
  },
  /*
   * PARTICIPANTES DEL TICKET: quién puede leerlo y hasta dónde ha leído.
   *
   * `last_read_seq` y `last_ack_seq` son estados DISTINTOS a propósito: leer un
   * mensaje no es acusar recibo y ninguna de las dos cosas completa la tarea
   * (regla de la Fase 6).
   */
  ops_ticket_participants: {
    indexed: {
      ticket_id: 'text',
      participant_type: 'text',
      participant_id: 'text',
      role: 'text',
      last_read_seq: 'text',
      last_ack_seq: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * LÍNEA DE TIEMPO ESTRUCTURADA (transiciones, acuses, creación).
   * Los mensajes viven en la colección de mensajes; aquí van los HECHOS, para
   * poder reconstruir la historia del ticket sin interpretar texto libre.
   */
  ops_ticket_events: {
    indexed: {
      ticket_id: 'text',
      kind: 'text',
      actor_id: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * AGENTES AUTORIZADOS (Etapa D).
   *
   * `key` es la identidad estable (`delivery_supervisor`). `tools` es la lista
   * blanca de herramientas y `version` sube en cada cambio de configuración:
   * así se sabe con qué contrato se ejecutó un run antiguo.
   */
  ops_agents: {
    indexed: { key: 'text', enabled: 'text', kind: 'text', version: 'text', updated_at: 'text' },
    unique: ['key'],
  },
  /*
   * EJECUCIONES DURABLES. Un run es «un agente trabajando en un ticket».
   * El estado vive en la BASE: un reinicio no pierde trabajo. `lease_until`
   * marca quién lo tiene tomado y hasta cuándo (recuperación de huérfanos).
   */
  ops_agent_runs: {
    indexed: {
      agent_key: 'text',
      ticket_id: 'text',
      workflow_key: 'text',
      status: 'text',
      next_run_at: 'text',
      lease_until: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /* PASOS: append-only, uno por vuelta. `step_key` único = no se repite un paso. */
  ops_agent_steps: {
    indexed: { run_id: 'text', step_key: 'text', kind: 'text', status: 'text', created_at: 'text' },
    unique: ['step_key'],
  },
  /* INVOCACIONES DE HERRAMIENTA (con su resultado, para no repetir efectos). */
  ops_tool_calls: {
    indexed: {
      run_id: 'text',
      ticket_id: 'text',
      tool: 'text',
      status: 'text',
      approval_id: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
  },
  /*
   * APROBACIONES HUMANAS. Guardan los PARÁMETROS EXACTOS propuestos: aprobar
   * vale solo para eso, una vez, y caduca.
   */
  ops_agent_approvals: {
    indexed: {
      ticket_id: 'text',
      run_id: 'text',
      agent_key: 'text',
      tool: 'text',
      status: 'text',
      expires_at: 'text',
      idempotency_key: 'text',
      created_at: 'text',
    },
    unique: ['idempotency_key'],
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

/** Columnas que esta colección necesita que existan en su tabla. */
function expectedColumns(name) {
  return ['id', 'doc', ...Object.keys(schemaOf(name).indexed)];
}

/**
 * Comprueba que una tabla que YA EXISTÍA tiene el esquema que la colección espera.
 *
 * `CREATE TABLE IF NOT EXISTS` no toca una tabla preexistente: si esa tabla es de
 * otra cosa (pasó en producción: `phytoemagry_messages` era la tabla legacy de
 * plantillas), el esquema nuevo se descarta en silencio y el primer uso revienta
 * con un error de SQL que no explica nada. Aquí se falla ANTES, con el diagnóstico
 * exacto y sin tocar la tabla ajena.
 *
 * @param {{ collection: string, table: string, expected: string[], actual: string[] }} input
 */
function assertTableShape({ collection, table, expected, actual }) {
  const missing = expected.filter((column) => !actual.includes(column));
  if (missing.length === 0) return;
  throw new Error(
    `la tabla "${table}" ya existe con un esquema incompatible con la colección "${collection}" ` +
      `(le faltan: ${missing.join(', ')}). No se ha modificado nada: renombra la colección o la ` +
      'tabla heredada para que no compartan nombre.',
  );
}

function missingColumns(expected, actual) {
  return expected.filter((column) => !actual.includes(column));
}

function orderDirection(value) {
  return String(value ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
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
    let actualColumns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name);
    if (actualColumns.includes('id') && actualColumns.includes('doc')) {
      for (const column of missingColumns(expectedColumns(name), actualColumns)) {
        const type = schema.indexed[column];
        if (type) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      actualColumns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name);
    }
    assertTableShape({
      collection: name,
      table,
      expected: expectedColumns(name),
      actual: actualColumns,
    });
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (id)`);
    for (const column of Object.keys(schema.indexed)) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_i_${column} ON ${table} (${column})`);
    }
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
      ordered: new Map(),
      filtered: new Map(),
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
      const built = statementsFor(name);
      const schema = schemaOf(name);
      const by = String(options.by ?? '');
      const indexed = Object.prototype.hasOwnProperty.call(schema.indexed, by);
      /*
       * FILTRAR POR COLUMNA EN SQL (no en JavaScript).
       * `where` solo se resuelve en SQL si TODAS sus columnas están indexadas;
       * si no, se filtra después. Sin esto, pedir los mensajes de una
       * conversación obligaba a leer y deserializar la tabla entera.
       */
      const where = sqlWhere(schema, options.where);
      if (where) {
        const key = `w:${where.map(([column]) => column).join(',')}|${indexed ? `${by}:${orderDirection(options.order)}` : ''}`;
        if (!built.filtered.has(key)) {
          const clause = where.map(([column]) => `${column} = ?`).join(' AND ');
          const order = indexed ? ` ORDER BY ${by} ${orderDirection(options.order)}` : '';
          built.filtered.set(key, db.prepare(`SELECT doc FROM ${built.table} WHERE ${clause}${order}`));
        }
        const docs = built.filtered
          .get(key)
          .all(...where.map(([, value]) => value))
          .map((row) => JSON.parse(row.doc));
        return sortAndLimit(docs, options);
      }
      let statement = built.all;
      if (indexed) {
        const key = `${by}:${orderDirection(options.order)}`;
        if (!built.ordered.has(key)) {
          built.ordered.set(key, db.prepare(`SELECT doc FROM ${built.table} ORDER BY ${by} ${orderDirection(options.order)}`));
        }
        statement = built.ordered.get(key);
      }
      const docs = statement
        .all()
        .map((row) => JSON.parse(row.doc))
        .filter((doc) => matchesWhere(doc, options.where));
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
  const initializing = new Map();

  const ensureOnce = async (name) => {
    if (ready.has(name)) return;
    const schema = schemaOf(name);
    const table = `${prefix}${name}`;
    const indexColumns = Object.entries(schema.indexed)
      .map(([column, type]) => `${column} ${type}`)
      .join(', ');
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, doc jsonb NOT NULL${indexColumns ? `, ${indexColumns}` : ''})`,
    );
    let existing = await pool.query(
      `SELECT attname AS column_name FROM pg_catalog.pg_attribute
        WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
      [table],
    );
    let actualColumns = existing.rows.map((row) => row.column_name);
    if (actualColumns.includes('id') && actualColumns.includes('doc')) {
      for (const column of missingColumns(expectedColumns(name), actualColumns)) {
        const type = schema.indexed[column];
        if (type) await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      }
      existing = await pool.query(
        `SELECT attname AS column_name FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
        [table],
      );
      actualColumns = existing.rows.map((row) => row.column_name);
    }
    assertTableShape({
      collection: name,
      table,
      expected: expectedColumns(name),
      actual: actualColumns,
    });
    for (const column of schema.unique ?? []) {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_u_${column} ON ${table} (${column}) WHERE ${column} IS NOT NULL`,
      );
    }
    for (const column of Object.keys(schema.indexed)) {
      await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_i_${column} ON ${table} (${column})`);
    }
    ready.add(name);
  };
  const ensure = (name) => {
    if (ready.has(name)) return Promise.resolve();
    if (!initializing.has(name)) initializing.set(name, ensureOnce(name).finally(() => initializing.delete(name)));
    return initializing.get(name);
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
      const by = String(options.by ?? '');
      const indexed = Object.prototype.hasOwnProperty.call(schemaOf(name).indexed, by);
      /* Igual que en SQLite: `where` se resuelve en SQL si sus columnas están indexadas. */
      const where = sqlWhere(schemaOf(name), options.where);
      const values = [];
      const conditions = [];
      for (const [column, value] of where ?? []) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
      const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const orderSql = indexed ? ` ORDER BY ${by} ${orderDirection(options.order)}` : '';
      /*
       * EL LÍMITE SE PIDE A POSTGRES, NO SE APLICA DESPUÉS.
       *
       * Antes se traía la tabla ENTERA (`wa_messages` incluida) y se recortaba
       * en JavaScript. Con 20.000 mensajes, cada apertura del panel leía y
       * deserializaba la tabla completa varias veces. Solo se limita en SQL
       * cuando el orden es por una columna indexada y el filtro también se ha
       * resuelto en SQL; si no, recortar antes de filtrar cambiaría el
       * resultado y prevalecen las filas correctas sobre la velocidad.
       */
      const limit = Number(options.limit);
      const useSqlLimit = Number.isFinite(limit) && limit > 0 && indexed && (!options.where || where);
      let sql = `SELECT doc FROM ${prefix}${name}${whereSql}${orderSql}`;
      if (useSqlLimit) {
        values.push(limit);
        sql += ` LIMIT $${values.length}`;
      }
      const result = await pool.query(sql, values);
      const docs = result.rows.map((row) => row.doc);
      return sortAndLimit(where ? docs : docs.filter((doc) => matchesWhere(doc, options.where)), options);
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
      return sortAndLimit(read(name).filter((doc) => matchesWhere(doc, options.where)), options);
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
 * Columnas de `where` que se pueden resolver en SQL.
 * Devuelve `null` si no hay filtro o si alguna columna no está indexada (entonces
 * se filtra en JavaScript, que también es correcto pero más lento).
 * @param {any} schema
 * @param {any} where
 * @returns {[string, any][]|null}
 */
function sqlWhere(schema, where) {
  if (!where || typeof where !== 'object') return null;
  const entries = Object.entries(where).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  return entries.every(([column]) => Object.prototype.hasOwnProperty.call(schema.indexed, column)) ? entries : null;
}

/** Filtro en JavaScript para las columnas que no se pueden consultar en SQL. */
function matchesWhere(doc, where) {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([key, value]) => value === undefined || value === null || doc[key] === value);
}

/**
 * Orden por defecto: lo más reciente primero (`created_at` o `at`).
 * @param {any[]} docs
 * @param {{ limit?: number, order?: 'asc'|'desc', by?: string, where?: any }} [options]
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
