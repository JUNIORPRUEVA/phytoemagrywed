// Sonda: pipeline saliente con dobles (sin red).
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../../server/crm-server.mjs';

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'phyto-uat',
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

let n = 0;
const whatsappMedia = {
  enabled: true,
  async downloadMedia() {
    return { ok: true, buffer: png(), mimeType: 'image/png' };
  },
  async uploadMedia() {
    n += 1;
    return { ok: true, mediaId: `meta_${n}` };
  },
  async sendImage() {
    return { ok: true, waMessageId: `wamid.${n}` };
  },
  async sendAudio() {
    return { ok: true, waMessageId: `wamid.${n}` };
  },
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-out-'));
const app = await startCrmServer({
  port: 0,
  host: '127.0.0.1',
  dataFile: path.join(dir, 'probe.sqlite'),
  token: 'probe-token',
  quiet: false,
  storage,
  whatsappMedia,
  schedulerEnabled: false,
});

const { createHmac } = await import('node:crypto');
const appSecret = 'probe-secret';
const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA1',
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ profile: { name: 'Ana' }, wa_id: '18095559000' }],
            messages: [{ from: '18095559000', id: 'wamid.P1', timestamp: '1700000000', type: 'text', text: { body: 'hola' } }],
          },
        },
      ],
    },
  ],
};
const raw = JSON.stringify(payload);
await fetch(`${app.url}/api/webhooks/whatsapp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`,
  },
  body: raw,
});
// El CRM no tiene META_APP_SECRET en esta sonda: se ejecuta igual (avisa).

await new Promise((r) => setTimeout(r, 400));
const login = await fetch(`${app.url}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'probe-token' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
console.log('media capabilities:', JSON.stringify(data.media));
const conversation = data.conversations[0];
console.log('conversación:', conversation?.id, 'cliente:', conversation?.customer_id);

const response = await fetch(
  `${app.url}/api/admin/conversations/${conversation.id}/media?kind=image&key=probe:1&caption=hola`,
  { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png() },
);
console.log('upload status:', response.status, await response.text());

const thread = await (await fetch(`${app.url}/api/admin/conversations/${conversation.id}/messages`, { headers: { cookie } })).json();
console.log('byKey:', JSON.stringify(await app.media.store.byIdempotencyKey('probe:1')));
console.log('todas:', JSON.stringify((await app.media.store.listByStatus('STORED', 10)).map((r) => ({ t: r.media_type, m: r.message_id, k: r.idempotency_key, s: r.send_status }))));
console.log('mensajes:', thread.messages.length, JSON.stringify(thread.messages.at(-1)?.type));
await app.close();
