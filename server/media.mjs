/**
 * MEDIA DE WHATSAPP — metadata en PostgreSQL, binario en S3 (Cloudflare R2).
 *
 * REPARTO (aprobado con el negocio)
 *   PostgreSQL → metadata, relaciones y estado
 *   R2 (S3)    → el archivo
 * Aquí NO se guarda ni un byte del binario: se guarda el `object_key`, que es la
 * referencia persistente. El día que haya que mover los archivos a otro bucket o
 * proveedor no se toca ni la UI ni el modelo de conversaciones.
 *
 * NADA DE ESTO ES UN SECRETO GUARDABLE
 * No se guardan claves de acceso, ni URLs firmadas permanentes, ni la URL de
 * Graph con token: la URL del endpoint de Meta caduca en minutos y el token no
 * puede vivir en una fila de la base.
 *
 * LA TABLA ES NUEVA Y ADITIVA
 * `CREATE TABLE IF NOT EXISTS` + índices `IF NOT EXISTS`. No toca
 * `phytoemagry_wa_messages` (mensajes), ni `phytoemagry_messages` (la legacy de
 * plantillas del CRM), ni ninguna tabla del trabajo comercial S4/S5/S6.
 *
 * EL FALLO DE STORAGE NO PUEDE PERDER LA CONVERSACIÓN
 * El mensaje y la conversación se guardan SIEMPRE (los escribe `customers.mjs`);
 * esta tabla solo añade el estado del archivo. Si R2 falla, la fila queda en
 * `FAILED` y la UI ofrece reintentar: el mensaje "Hola + imagen" sigue existiendo.
 */

/** Tipos de contenido que el modelo sabe representar. */
export const MEDIA_TYPES = Object.freeze([
  'image',
  'audio',
  'voice',
  'document',
  'video',
  'sticker',
  'receipt',
  'other',
]);

/**
 * Estados del ARCHIVO (dónde vive el binario).
 *
 * Entrante: PENDING→DOWNLOADING→STORED   Saliente: UPLOADING→STORED
 * `SENDING` se conserva solo por compatibilidad con filas ya escritas: el envío
 * ya NO vive aquí, vive en `send_status` (ver abajo).
 */
export const MEDIA_STATUS = Object.freeze({
  PENDING: 'PENDING',
  DOWNLOADING: 'DOWNLOADING',
  STORED: 'STORED',
  UPLOADING: 'UPLOADING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
});

/**
 * Estados de ENTREGA (máquina de estados distinta, en su propia columna).
 *
 * Mezclar "¿dónde está el archivo?" con "¿llegó el mensaje?" es lo que provoca
 * que un fallo de envío parezca un fallo de archivo y que un reintento reenvíe.
 *
 *   PREPARING → READY_TO_SEND → SENDING → SENT
 *                                  │
 *                                  └→ SEND_UNKNOWN  (Meta pudo recibirlo: NO se reintenta solo)
 *
 * `SENDING` se escribe ANTES de la llamada irreversible a Meta. Por eso, si el
 * proceso cae en ese punto, el estado en disco lo dice: hubo un intento de envío
 * y no hay respuesta fiable. Eso es `SEND_UNKNOWN`, y NO se reintenta nunca solo.
 */
export const SEND_STATUS = Object.freeze({
  PREPARING: 'PREPARING',
  READY_TO_SEND: 'READY_TO_SEND',
  SENDING: 'SENDING',
  SENT: 'SENT',
  SEND_UNKNOWN: 'SEND_UNKNOWN',
  FAILED: 'FAILED',
});

/** Estados desde los que un reintento automático NUNCA es seguro. */
export const UNSAFE_TO_RETRY = Object.freeze([SEND_STATUS.SENDING, SEND_STATUS.SEND_UNKNOWN]);

/** Estados en los que el mensaje ya salió Sí o Sí. */
export const ALREADY_DELIVERED = Object.freeze([SEND_STATUS.SENT]);

const STATUSES = Object.freeze(Object.values(MEDIA_STATUS));

/** SQL del esquema (aditivo e idempotente). Se ejecuta tal cual en Postgres. */
export const MEDIA_DDL = `
CREATE TABLE IF NOT EXISTS __TABLE__ (
  id             text PRIMARY KEY,
  message_id     text NOT NULL,
  wa_message_id  text,
  wa_media_id    text,
  media_type     text NOT NULL,
  mime_type      text,
  safe_filename  text,
  original_filename text,
  storage_provider text,
  bucket         text,
  object_key     text,
  size_bytes     integer,
  sha256         text,
  width          integer,
  height         integer,
  duration_ms    integer,
  direction      text NOT NULL,
  status         text NOT NULL,
  error_code     text,
  error_message  text,
  idempotency_key text,
  send_status    text,
  send_attempted_at text,
  sent_at        text,
  provider       text,
  operation      text,
  http_status    integer,
  safe_code      text,
  error_at       text,
  created_at     text NOT NULL,
  updated_at     text NOT NULL
);
CREATE INDEX IF NOT EXISTS __TABLE___message ON __TABLE__ (message_id);
CREATE INDEX IF NOT EXISTS __TABLE___status ON __TABLE__ (status);
CREATE INDEX IF NOT EXISTS __TABLE___wamid ON __TABLE__ (wa_message_id);
CREATE INDEX IF NOT EXISTS __TABLE___send ON __TABLE__ (send_status);
CREATE UNIQUE INDEX IF NOT EXISTS __TABLE___dedup ON __TABLE__ (message_id, media_type);
-- Clave de idempotencia: una operación de envío = una fila, pase lo que pase.
CREATE UNIQUE INDEX IF NOT EXISTS __TABLE___idem ON __TABLE__ (idempotency_key);
`;

/**
 * MIGRACIÓN ADITIVA para bases que ya tienen la tabla creada (producción).
 * `ADD COLUMN IF NOT EXISTS` no reescribe datos ni rompe filas existentes, y en
 * PostgreSQL los índices únicos admiten varios NULL, así que todas las filas
 * anteriores (con `idempotency_key` nulo) siguen siendo válidas.
 */
export const MEDIA_MIGRATIONS = `
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS send_status text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS send_attempted_at text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS sent_at text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS safe_code text;
ALTER TABLE __TABLE__ ADD COLUMN IF NOT EXISTS error_at text;
CREATE INDEX IF NOT EXISTS __TABLE___send ON __TABLE__ (send_status);
CREATE UNIQUE INDEX IF NOT EXISTS __TABLE___idem ON __TABLE__ (idempotency_key);
`;

/** `mrd_<aleatorio>`: identificador propio, nunca un nombre que venga de fuera. */
const randomId = () =>
  `mrd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Crea el repositorio de media sobre el pool de PostgreSQL.
 *
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} pool
 * @param {{ table?: string }} [options]
 */
export function createMediaStore(pool, options = {}) {
  const table = options.table ?? 'phytoemagry_wa_media';
  let ready = null;

  /** Crea la tabla y aplica la migración aditiva una sola vez por proceso. */
  const ensure = () => {
    ready ??= (async () => {
      await pool.query(MEDIA_DDL.replaceAll('__TABLE__', table));
      await pool.query(MEDIA_MIGRATIONS.replaceAll('__TABLE__', table));
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  };

  const toRow = (record) => ({
    // El identificador se genera aquí si quien llama no lo trae: el pipeline crea
    // la operación ANTES de saber el resultado, y la fila necesita una clave
    // primaria estable desde el primer momento (sin ella no se puede reanudar).
    id: record.id ?? randomId(),
    message_id: record.messageId,
    wa_message_id: record.waMessageId ?? null,
    wa_media_id: record.waMediaId ?? null,
    media_type: record.mediaType,
    mime_type: record.mimeType ?? null,
    safe_filename: record.safeFilename ?? null,
    original_filename: record.originalFilename ?? null,
    storage_provider: record.storageProvider ?? null,
    bucket: record.bucket ?? null,
    object_key: record.objectKey ?? null,
    size_bytes: record.sizeBytes ?? null,
    sha256: record.sha256 ?? null,
    width: record.width ?? null,
    height: record.height ?? null,
    duration_ms: record.durationMs ?? null,
    direction: record.direction,
    status: record.status,
    error_code: record.errorCode ?? null,
    error_message: record.errorMessage ?? null,
    idempotency_key: record.idempotencyKey ?? null,
    send_status: record.sendStatus ?? null,
    send_attempted_at: record.sendAttemptedAt ?? null,
    sent_at: record.sentAt ?? null,
    provider: record.provider ?? null,
    operation: record.operation ?? null,
    http_status: record.httpStatus ?? null,
    safe_code: record.safeCode ?? null,
    error_at: record.errorAt ?? null,
    created_at: record.createdAt ?? new Date().toISOString(),
    updated_at: record.updatedAt ?? new Date().toISOString(),
  });

  return {
    table,
    ensure,

    /**
     * Registra la intención de guardar/descargar. Es idempotente por
     * (mensaje, tipo): repetir no crea una segunda fila.
     */
    async create(record) {
      await ensure();
      const row = toRow(record);
      const result = await pool.query(
        `INSERT INTO ${table} (id, message_id, wa_message_id, wa_media_id, media_type, mime_type, safe_filename, original_filename,
           storage_provider, bucket, object_key, size_bytes, sha256, width, height, duration_ms, direction, status,
           error_code, error_message, idempotency_key, send_status, send_attempted_at, sent_at, provider, operation,
           http_status, safe_code, error_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          row.id, row.message_id, row.wa_message_id, row.wa_media_id, row.media_type, row.mime_type, row.safe_filename,
          row.original_filename, row.storage_provider, row.bucket, row.object_key, row.size_bytes, row.sha256,
          row.width, row.height, row.duration_ms, row.direction, row.status, row.error_code, row.error_message,
          row.idempotency_key, row.send_status, row.send_attempted_at, row.sent_at, row.provider, row.operation,
          row.http_status, row.safe_code, row.error_at, row.created_at, row.updated_at,
        ],
      );
      if (result.rows[0]) return { ok: true, duplicate: false, media: result.rows[0] };
      // `ON CONFLICT DO NOTHING` sin objetivo cubre las DOS unicidades (mensaje+tipo
      // y clave de idempotencia): así una clave repetida no puede crear otra fila.
      const porClave = row.idempotency_key ? await this.byIdempotencyKey(row.idempotency_key) : null;
      const existing = porClave ?? (await this.byMessage(row.message_id, row.media_type));
      return { ok: true, duplicate: true, media: existing };
    },

    /** Actualiza el estado/la referencia (nunca crea filas nuevas por cambiar de estado). */
    async update(id, patch) {
      await ensure();
      const fields = [];
      const values = [];
      const map = {
        // `message_id` se puede reapuntar: en un envío saliente la operación nace
        // ANTES que el mensaje del CRM (para no perder la intención si el proceso
        // cae), así que al persistirlo hay que enlazarlos.
        message_id: patch.messageId,
        status: patch.status,
        wa_message_id: patch.waMessageId,
        wa_media_id: patch.waMediaId,
        object_key: patch.objectKey,
        bucket: patch.bucket,
        storage_provider: patch.storageProvider,
        mime_type: patch.mimeType,
        safe_filename: patch.safeFilename,
        size_bytes: patch.sizeBytes,
        sha256: patch.sha256,
        width: patch.width,
        height: patch.height,
        duration_ms: patch.durationMs,
        error_code: patch.errorCode,
        error_message: patch.errorMessage,
        idempotency_key: patch.idempotencyKey,
        send_status: patch.sendStatus,
        send_attempted_at: patch.sendAttemptedAt,
        sent_at: patch.sentAt,
        provider: patch.provider,
        operation: patch.operation,
        http_status: patch.httpStatus,
        safe_code: patch.safeCode,
        error_at: patch.errorAt,
      };
      for (const [column, value] of Object.entries(map)) {
        if (value === undefined) continue;
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      }
      if (!fields.length) return { ok: true, media: await this.get(id) };
      values.push(new Date().toISOString());
      fields.push(`updated_at = $${values.length}`);
      values.push(id);
      const result = await pool.query(
        `UPDATE ${table} SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values,
      );
      return { ok: Boolean(result.rows[0]), media: result.rows[0] ?? null };
    },

    async get(id) {
      await ensure();
      const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      return result.rows[0] ?? null;
    },

    async byMessage(messageId, mediaType = null) {
      await ensure();
      const result = mediaType
        ? await pool.query(`SELECT * FROM ${table} WHERE message_id = $1 AND media_type = $2`, [messageId, mediaType])
        : await pool.query(`SELECT * FROM ${table} WHERE message_id = $1 ORDER BY created_at`, [messageId]);
      return mediaType ? result.rows[0] ?? null : result.rows;
    },

    /**
     * Media de VARIOS mensajes a la vez (una consulta, no N).
     *
     * Lo necesita la bandeja: al pintar un hilo de 100 mensajes no se puede
     * preguntar 100 veces por el archivo de cada uno. `= ANY($1)` es PostgreSQL y
     * el adaptador del CRM lo traduce a `IN (…, …)` en SQLite, así que la consulta
     * es la misma en los dos motores.
     *
     * @param {string[]} messageIds
     * @returns {Promise<any[]>}
     */
    async byMessageIds(messageIds) {
      const ids = [...new Set((messageIds ?? []).filter(Boolean).map(String))];
      if (ids.length === 0) return [];
      await ensure();
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE message_id = ANY($1) ORDER BY created_at`,
        [ids],
      );
      return result.rows;
    },

    /**
     * La operación de envío por su clave de idempotencia. Es la consulta que
     * evita depender de que el CRM haya llegado a guardar el mensaje: la
     * intención se guarda ANTES de llamar a Meta, así que sobrevive a una caída.
     */
    async byIdempotencyKey(key) {
      if (!key) return null;
      await ensure();
      const result = await pool.query(`SELECT * FROM ${table} WHERE idempotency_key = $1`, [String(key)]);
      return result.rows[0] ?? null;
    },

    /** La operación de un mensaje ya enviado, por el identificador de Meta. */
    async byWaMessageId(waMessageId) {
      if (!waMessageId) return null;
      await ensure();
      const result = await pool.query(`SELECT * FROM ${table} WHERE wa_message_id = $1`, [String(waMessageId)]);
      return result.rows[0] ?? null;
    },

    /** Operaciones salientes en un estado de entrega concreto (para vigilancia manual). */
    async listBySendStatus(sendStatus, limit = 50) {
      await ensure();
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE send_status = $1 ORDER BY created_at LIMIT $2`,
        [sendStatus, limit],
      );
      return result.rows;
    },

    /** Media pendientes de descargar/subir (para reintentos manuales o un barrido). */
    async listByStatus(status, limit = 50) {
      await ensure();
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE status = $1 ORDER BY created_at LIMIT $2`,
        [status, limit],
      );
      return result.rows;
    },

    /** Marca un fallo sin borrar nada: el mensaje y la conversación siguen ahí. */
    async markFailed(id, { code = null, message = null } = {}) {
      return this.update(id, {
        status: MEDIA_STATUS.FAILED,
        errorCode: code ? String(code).slice(0, 40) : null,
        errorMessage: message ? String(message).slice(0, 200) : null,
      });
    },

    /**
     * Registra un fallo ESTRUCTURADO y SANEADO. Los cuatro datos que se guardan
     * son los que sirven para diagnosticar (proveedor, operación, HTTP, código
     * seguro) más la marca de tiempo. El texto crudo del proveedor NO se guarda:
     * puede traer URLs firmadas con credenciales dentro.
     *
     * @param {string} id
     * @param {{ provider?: string, operation?: string, httpStatus?: number|null,
     *           safeCode?: string|null, message?: string|null, status?: string }} input
     */
    async recordFailure(id, input = {}) {
      const limpio = (value, max = 40) =>
        value === null || value === undefined || value === '' ? null : String(value).replace(/[^\w.-]/g, '').slice(0, max) || null;
      return this.update(id, {
        status: input.status ?? MEDIA_STATUS.FAILED,
        sendStatus: input.sendStatus,
        provider: limpio(input.provider),
        operation: limpio(input.operation),
        httpStatus: Number.isFinite(Number(input.httpStatus)) && Number(input.httpStatus) > 0 ? Number(input.httpStatus) : null,
        safeCode: limpio(input.safeCode, 60),
        errorCode: limpio(input.safeCode ?? input.errorCode),
        errorMessage: null,
        errorAt: new Date().toISOString(),
      });
    },
  };
}

/** ¿Es un estado válido? (validación barata antes de tocar la base) */
export const isKnownStatus = (value) => STATUSES.includes(String(value ?? '').toUpperCase());
/** ¿Es un tipo válido? */
export const isKnownType = (value) => MEDIA_TYPES.includes(String(value ?? '').toLowerCase());
