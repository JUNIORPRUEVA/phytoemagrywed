/**
 * UAT LOCAL DEL PANEL CON MULTIMEDIA (S1/S2/S3 + S4/S5/S6).
 *
 * Levanta el CRM de verdad (el mismo `startCrmServer` de producción) con dobles
 * SOLO en los bordes que no se pueden tocar desde aquí:
 *
 *   · almacén de archivos (R2) → memoria, para no usar credenciales reales;
 *   · Graph de WhatsApp (descarga/subida/envío) → dobles, para NO mandar nada;
 *   · cliente de texto → doble, para NO escribirle a nadie.
 *
 * Siembra una conversación con texto, imagen y nota de voz, un pedido entregado
 * y un envío ambiguo pendiente de revisión, y deja el servidor en marcha.
 *
 * Uso: node .tmp/s3-uat/panel-uat.mjs [puerto]
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCrmServer } from '../../server/crm-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const DATA_DIR = path.join(HERE, 'data');
const PORT = Number(process.argv[2] ?? 4210);
const TOKEN = 'uat-local-multimedia';
const APP_SECRET = 'uat-local-secreto';
const PHONE = '18095559090';

const png = readFileSync(path.join(FIXTURES, 'frasco.png'));
const ogg = readFileSync(path.join(FIXTURES, 'nota-de-voz.ogg'));

/* ------------------------------------------------------------------ dobles */

const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'uat-local',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

/** Graph de mentira: nada sale de este ordenador. */
const graph = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  businessAccountId: 'WABA1',
  ambiguity: false,
  enviados: [],
  async downloadMedia(waMediaId) {
    if (String(waMediaId).includes('IMG')) return { ok: true, buffer: png, mimeType: 'image/png' };
    return { ok: true, buffer: ogg, mimeType: 'audio/ogg' };
  },
  async uploadMedia() {
    return { ok: true, mediaId: `meta_uat_${(graph.enviados.length + 1).toString(36)}` };
  },
  async sendImage() {
    if (graph.ambiguity) return { ok: false, error: {} };
    graph.enviados.push('image');
    return { ok: true, waMessageId: `wamid.UATSENT${graph.enviados.length}` };
  },
  async sendAudio() {
    if (graph.ambiguity) return { ok: false, error: {} };
    graph.enviados.push('audio');
    return { ok: true, waMessageId: `wamid.UATSENT${graph.enviados.length}` };
  },
};

const textClient = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  businessAccountId: 'WABA1',
  enviados: [],
  async sendText(to, body) {
    textClient.enviados.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.UATTXT${textClient.enviados.length}` };
  },
  async sendTemplate(to, template) {
    textClient.enviados.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.UATTPL${textClient.enviados.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

/* ------------------------------------------------------------- siembra UAT */

async function webhook(baseUrl, node) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana UAT' }, wa_id: PHONE }],
              messages: [{ from: PHONE, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  return response.status;
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ arranque */

if (!existsSync(FIXTURES)) {
  console.error('Faltan las fixtures. Ejecuta antes: python .tmp/s3-uat/fixtures.py');
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });
const dataFile = path.join(DATA_DIR, 'uat.sqlite');
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dataFile + suffix)) rmSync(dataFile + suffix);
}

const app = await startCrmServer({
  port: PORT,
  host: '127.0.0.1',
  dataFile,
  token: TOKEN,
  metaAppSecret: APP_SECRET,
  storage,
  whatsappMedia: graph,
  whatsapp: textClient,
  schedulerEnabled: false,
  quiet: true,
});

const login = await fetch(`${app.url}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: TOKEN }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

await webhook(app.url, { id: 'wamid.UAT-TXT-1', type: 'text', text: { body: 'Hola, vi el de 10 cápsulas. ¿Cuánto cuesta?' } });
await webhook(app.url, {
  id: 'wamid.UAT-IMG-1',
  type: 'image',
  image: { id: 'IMG-UAT-1', mime_type: 'image/png', caption: 'Así llegó el frasco' },
});
await webhook(app.url, { id: 'wamid.UAT-VOZ-1', type: 'voice', voice: { id: 'VOZ-UAT-1', mime_type: 'audio/ogg' } });
await webhook(app.url, { id: 'wamid.UAT-TXT-2', type: 'text', text: { body: 'Quiero 2 frascos de 10, por favor' } });
await esperar(700);

const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
const row = (data.conversations ?? []).find((item) => item.customer?.phone_e164 === `+${PHONE}`);
if (!row) {
  console.error('no se creó la conversación de UAT');
  process.exit(1);
}

const order = await (
  await fetch(`${app.url}/api/admin/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      customerId: row.customer_id,
      conversationId: row.id,
      channel: 'whatsapp',
      items: [{ variantId: 'capsules_10', quantity: 2 }],
      status: 'entregado',
      notes: 'Pagó en efectivo en el negocio',
      delivery: { city: 'Higüey', address: 'Retira en el negocio' },
    }),
  })
).json();

await fetch(`${app.url}/api/admin/scheduled`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    customerId: row.customer_id,
    conversationId: row.id,
    scheduledAt: new Date(Date.now() + 120000).toISOString(),
    text: 'Hola Ana, ¿te ayudo con algo más?',
    idempotencyKey: 'uat:media:seed:1',
  }),
});

// Un envío que quedó AMBIGUO (pudo salir o no): la cola de revisión de Ajustes.
graph.ambiguity = true;
const ambiguo = await fetch(`${app.url}/api/admin/conversations/${row.id}/media?kind=image&key=uat:ambiguo:1&caption=Prueba`, {
  method: 'POST',
  headers: { 'content-type': 'image/png', cookie, 'x-phyto-filename': 'ambiguo.png' },
  body: png,
});
graph.ambiguity = false;
const ambiguoBody = await ambiguo.json().catch(() => ({}));

const final = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();

console.log('--- UAT LISTA ---');
console.log('panel:', `${app.url}/admin/?token=${TOKEN}`);
console.log('clave:', TOKEN);
console.log('conversación:', row.id, '· cliente:', row.customer_id);
console.log('pedido:', order.order?.order_number, '· total:', order.order?.total);
console.log('envío ambiguo:', ambiguo.status, ambiguoBody.error ?? '');
console.log('cola de revisión:', final.media?.needsReview ?? 0, '· multimedia activa:', final.media?.enabled);
console.log('archivos enviados a Meta (dobles):', graph.enviados.length, '· textos enviados:', textClient.enviados.length);
console.log('url base:', app.url);
