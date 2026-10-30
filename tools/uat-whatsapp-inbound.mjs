// Envía un entrante de WhatsApp FIRMADO (como Meta) a la UAT local.
// Uso: node tools/_tmp-sse-inbound.mjs <waId> "<texto>"
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const waId = process.argv[2];
const texto = process.argv[3] ?? 'Durante el corte';
const BASE = 'http://127.0.0.1:8791';

const fuente = await readFile(new URL('../scripts/uat-env.mjs', import.meta.url), 'utf8');
const secreto = fuente.match(/const SECRETO_WEBHOOK = '([^']+)'/)?.[1] ?? '';
const destino = fuente.match(/phoneNumberId: '([^']+)'/)?.[1] ?? '';
if (!secreto || !destino || !waId) {
  console.error('faltan datos', { secreto: Boolean(secreto), destino: Boolean(destino), waId });
  process.exit(2);
}

const sello = Date.now();
const cuerpo = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-uat-sse',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: destino, display_phone_number: '18095550999' },
        contacts: [{ wa_id: waId, profile: { name: 'QA SSE' } }],
        messages: [{
          from: waId,
          id: `wamid.SSE.${sello}`,
          timestamp: Math.floor(sello / 1000),
          type: 'text',
          text: { body: texto },
        }],
      },
    }],
  }],
});

const firma = createHmac('sha256', secreto).update(Buffer.from(cuerpo)).digest('hex');
const res = await fetch(new URL('/api/webhooks/whatsapp', BASE), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${firma}` },
  body: cuerpo,
});
console.log('webhook HTTP', res.status, await res.text());
