/**
 * UAT VISUAL de RESPUESTAS RÁPIDAS (SOLO para capturas). NO toca producción.
 *
 * Levanta el CRM con una base SQLite TEMPORAL, un cliente de WhatsApp FALSO (no
 * se manda nada a Meta) y siembra una conversación real + tres respuestas rápidas
 * para poder fotografiar la pantalla tal como la ve el negocio.
 *
 * Uso:  node .tmp/quick-replies-uat/panel.mjs
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../../server/crm-server.mjs';

const TOKEN = 'uat-respuestas-rapidas';
const APP_SECRET = 'uat-secreto-respuestas';
const WABA = 'WABA-UAT';
const FROM = '18095558888';
const PORT = Number(process.env.UAT_PORT ?? 4321);

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  businessAccountId: WABA,
  sent: [],
  read: [],
  async sendText() {
    // Nunca envía: este UAT solo mira la pantalla.
    return { ok: false, skipped: true, error: { code: 'uat_no_send', message: 'UAT' } };
  },
  async sendTemplate() {
    return { ok: false, skipped: true, error: { code: 'uat_no_send', message: 'UAT' } };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-qr-uat-'));

const app = await startCrmServer({
  port: PORT,
  host: '127.0.0.1',
  dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
  token: TOKEN,
  quiet: true,
  metaAppSecret: APP_SECRET,
  whatsappPhoneNumber: '+18095550000',
  whatsapp: mockWhatsApp,
});

const login = await fetch(`${app.url}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: TOKEN }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

/** Un cliente escribiendo: crea cliente, conversación y mensaje de verdad. */
const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA,
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ profile: { name: 'María Pérez' }, wa_id: FROM }],
            messages: [
              {
                from: FROM,
                id: `wamid.UAT${Date.now()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Hola, ¿cuánto cuesta el frasco?' },
              },
            ],
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
    'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
  },
  body: raw,
});

/* Respuestas de ejemplo para la captura: texto de ORGANIZACIÓN, sin ninguna
 * afirmación médica ni comercial inventada (el negocio escribe las suyas). */
const EJEMPLOS = [
  {
    name: 'Precio y presentación',
    body: 'Tenemos presentaciones desde RD$1,250. Dime cuántas cápsulas necesitas y te digo el precio exacto.',
  },
  {
    name: 'Modo de uso',
    body: 'Modo de uso: tomar 1 cápsula al día después del desayuno. Cualquier duda me escribes por aquí.',
  },
  {
    name: 'Envíos',
    body: 'Podemos coordinar la entrega en Higüey y zonas cercanas. ¿En qué zona estás?',
  },
];

for (const row of EJEMPLOS) {
  await fetch(`${app.url}/api/admin/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(row),
  });
}

console.log(`[uat] panel listo en ${app.url}/admin/  (base temporal: ${tmpDir})`);
