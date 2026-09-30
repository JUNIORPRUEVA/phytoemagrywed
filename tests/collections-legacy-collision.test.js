// @vitest-environment node
/**
 * REGRESIÓN — colisión con la tabla legacy `phytoemagry_messages`.
 *
 * QUÉ PASÓ EN PRODUCCIÓN (30/09/2026)
 * La colección nueva de mensajes reales de WhatsApp se llamaba `messages` y por
 * tanto su tabla física era `phytoemagry_messages`… que YA existía desde antes
 * como tabla LEGACY de PLANTILLAS del CRM (`id, name, body, position, updated_at`).
 * Como el DDL usa `CREATE TABLE IF NOT EXISTS`, no hubo ningún error al arrancar:
 * el esquema nuevo se descartó en silencio y el primer mensaje real se perdió con
 * `column "wa_message_id" does not exist`, además de tumbar `GET /api/admin/data`
 * con un 500.
 *
 * QUÉ FIJA ESTE TEST
 * Reproduce el escenario desde cero —tabla legacy con datos, CRM levantado sobre
 * la MISMA base, webhook real firmado— y comprueba que:
 *   1. existe previamente la tabla legacy `phytoemagry_messages` con datos;
 *   2. el CRM se inicializa sobre esa misma base;
 *   3. NO altera la tabla legacy (ni sus filas ni su esquema);
 *   4. usa su propia tabla `phytoemagry_wa_messages`;
 *   5. procesa el webhook inbound: cliente + conversación + mensaje;
 *   6. repetir el MISMO webhook (Meta reintenta) no duplica el mensaje.
 * Y, además, que un esquema incompatible falla con un diagnóstico explícito.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { createCollections } from '../server/collections.mjs';

const TOKEN = 'clave-colision-123';
const APP_SECRET = 'app-secreto-colision';
const PHONE = '18095551234';
const WAMID = 'wamid.LEGADO1';
const WAMID2 = 'wamid.LEGADO2';

/** Las 5 plantillas que la tabla legacy tiene en producción. */
const LEGACY_ROWS = [
  ['msg-saludo', 'Saludo inicial', 'Hola {nombre}, te escribo de {negocio}.', 0],
  ['msg-pedido', 'Confirmar pedido', 'Hola {nombre}, recibi tu pedido.', 1],
  ['msg-recordatorio', 'Recordatorio', 'Hola {nombre}, seguimos con tu pedido?', 2],
  ['msg-seguimiento', 'Seguimiento (sin respuesta)', 'Hola {nombre}, te escribi hace unos dias.', 3],
  ['msg-gracias', 'Agradecimiento', 'Gracias por tu compra, {nombre}!', 4],
];

let tmpDir;
let dbFile;
let app;
let cookie = '';
let legacySnapshot = [];

/** Cliente falso de WhatsApp: en esta prueba nadie envía, solo se marca leído. */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  read: [],
  async sendText() {
    return { ok: false, skipped: true };
  },
  async sendTemplate() {
    return { ok: false, skipped: true };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
    return { ok: true };
  },
};

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

/** Espera a que el CRM termine el trabajo asíncrono del webhook. */
async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* la tabla aún no existe: se reintenta */
    }
    if (Date.now() - start > timeout) throw new Error('timeout: el CRM no terminó de procesar');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Abre la MISMA base que usa el CRM (segunda conexión, solo lectura de hecho).
 * SQLite en Windows puede devolver `SQLITE_BUSY` si coincide con una escritura:
 * se reintenta unas cuantas veces.
 */
async function withDb(fn) {
  const { DatabaseSync } = await import('node:sqlite');
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(dbFile);
      return fn(db);
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(String(error?.message ?? ''))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      try {
        db?.close();
      } catch {
        /* ya cerrada */
      }
    }
  }
  throw lastError;
}

const legacyRows = () =>
  withDb((db) => db.prepare('SELECT id, name, body, position FROM phytoemagry_messages ORDER BY position').all());

const legacyColumns = () =>
  withDb((db) => db.prepare('SELECT name FROM pragma_table_info(?)').all('phytoemagry_messages').map((row) => row.name));

const waMessages = () =>
  withDb((db) =>
    db
      .prepare('SELECT doc FROM phytoemagry_wa_messages')
      .all()
      .map((row) => JSON.parse(row.doc)),
  );

const sqliteNames = (type) =>
  withDb((db) => db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((row) => row.name));

const countOf = (table) => withDb((db) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n));

/** Webhook entrante como el que manda Meta, firmado como es debido. */
async function inbound(id, body, from = PHONE) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana WhatsApp' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-legacy-'));
  dbFile = path.join(tmpDir, 'phytoemagry.sqlite');

  // (1) La tabla legacy, con sus datos, ANTES de arrancar nada.
  const { DatabaseSync } = await import('node:sqlite');
  const seed = new DatabaseSync(dbFile);
  seed.exec(`CREATE TABLE IF NOT EXISTS phytoemagry_messages (
    id text PRIMARY KEY,
    name text NOT NULL,
    body text NOT NULL,
    position integer NOT NULL DEFAULT 0,
    updated_at text
  )`);
  const insert = seed.prepare(
    'INSERT INTO phytoemagry_messages (id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [id, name, body, position] of LEGACY_ROWS) {
    insert.run(id, name, body, position, '2026-01-01T00:00:00.000Z');
  }
  seed.close();
  legacySnapshot = await legacyRows();

  // (2) El CRM sobre la MISMA base + (3) un webhook inbound real.
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: dbFile,
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const response = await inbound(WAMID, 'Hola');
  expect(response.status).toBe(200);
  await waitFor(async () => (await waMessages()).length === 1);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('colisión con la tabla legacy phytoemagry_messages', () => {
  it('la tabla legacy sigue existiendo con sus 5 plantillas y su esquema intactos', async () => {
    expect(legacySnapshot).toHaveLength(5);
    expect(await legacyRows()).toEqual(legacySnapshot);
    expect(await legacyColumns()).toEqual(['id', 'name', 'body', 'position', 'updated_at']);
  });

  it('usa su propia tabla, separada de la legacy', async () => {
    const tables = await sqliteNames('table');
    expect(tables).toContain('phytoemagry_messages');
    expect(tables).toContain('phytoemagry_wa_messages');
  });

  it('guarda el mensaje entrante en phytoemagry_wa_messages', async () => {
    const rows = await waMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wa_message_id: WAMID,
      direction: 'inbound',
      status: 'received',
      body: 'Hola',
      type: 'text',
    });
  });

  it('crea el cliente y la conversación', async () => {
    expect(await countOf('phytoemagry_customers')).toBe(1);
    expect(await countOf('phytoemagry_conversations')).toBe(1);

    const data = await json(await call('/api/admin/conversations'));
    const conversation = data.conversations.find((row) => row.customer?.phone_e164 === '+18095551234');
    expect(conversation).toBeTruthy();
    expect(conversation.last_message).toMatchObject({ body: 'Hola', direction: 'inbound' });
  });

  it('tiene el índice único que deduplica por wa_message_id', async () => {
    expect(await sqliteNames('index')).toContain('phytoemagry_wa_messages_u_wa_message_id');
  });

  it('un reintento del MISMO webhook no duplica el mensaje', async () => {
    const again = await inbound(WAMID, 'Hola');
    expect(again.status).toBe(200);

    // Señal de que el reintento ya se procesó: después llega uno distinto.
    const second = await inbound(WAMID2, 'Segundo mensaje');
    expect(second.status).toBe(200);
    await waitFor(async () => (await waMessages()).length === 2);

    const rows = await waMessages();
    expect(rows.filter((row) => row.wa_message_id === WAMID)).toHaveLength(1);
    expect(rows.filter((row) => row.wa_message_id === WAMID2)).toHaveLength(1);
    // Y la conversación no se ha duplicado tampoco.
    expect(await countOf('phytoemagry_conversations')).toBe(1);
  });

  it('GET /api/admin/data responde 200 (antes devolvía 500)', async () => {
    const response = await call('/api/admin/data');
    expect(response.status).toBe(200);
    const data = await json(response);
    expect(data.ok).toBe(true);
    expect(data.storage).toBe('sqlite');
  });
});

describe('validación defensiva de esquema', () => {
  it('falla con un diagnóstico explícito si la tabla ya existe con otro esquema', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    // Una tabla con el nombre de la colección pero con OTRO esquema.
    db.exec(`CREATE TABLE phytoemagry_wa_messages (
      id text PRIMARY KEY,
      name text NOT NULL,
      body text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      updated_at text
    )`);
    const store = await createCollections({ backend: 'sqlite', handle: db, prefix: 'phytoemagry_' });

    await expect(store.list('wa_messages')).rejects.toThrow(/esquema incompatible/);
    // El diagnóstico nombra la tabla, la colección y lo que falta.
    await expect(store.list('wa_messages')).rejects.toThrow(/phytoemagry_wa_messages/);
    await expect(store.list('wa_messages')).rejects.toThrow(/wa_message_id/);
    // Y no ha tocado la tabla ajena.
    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('phytoemagry_wa_messages')
      .map((row) => row.name);
    expect(columns).toEqual(['id', 'name', 'body', 'position', 'updated_at']);

    db.close();
  });
});
