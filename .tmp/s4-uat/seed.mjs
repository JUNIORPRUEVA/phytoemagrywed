/**
 * UAT (local) del centro de ventas: siembra un cliente de WhatsApp y un pedido
 * para poder recorrer el panel en el navegador. NO toca producción ni Meta.
 *
 * Uso: node .tmp/s4-uat/seed.mjs <baseUrl> <appSecret> <token>
 */
import { createHmac } from 'node:crypto';

const [baseUrl, appSecret, token] = process.argv.slice(2);
const PHONE = '18095559090';

async function webhook(body, id) {
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
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  const response = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  return response.status;
}

const login = await fetch(`${baseUrl}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

console.log('webhook mensaje 1:', await webhook('Hola, vi el de 10 cápsulas. ¿Cuánto cuesta?', 'wamid.UAT1'));
console.log('webhook mensaje 2:', await webhook('Quiero 2 frascos de 10, por favor', 'wamid.UAT2'));
await new Promise((resolve) => setTimeout(resolve, 400));

const data = await (
  await fetch(`${baseUrl}/api/admin/data`, { headers: { cookie } })
).json();
const row = (data.conversations ?? []).find((item) => item.customer?.phone_e164 === `+${PHONE}`);
if (!row) {
  console.error('no se creó la conversación');
  process.exit(1);
}
console.log('conversación:', row.id, 'cliente:', row.customer_id);

// Un pedido entregado para que HOY tenga seguimientos y la ficha historial.
const order = await (
  await fetch(`${baseUrl}/api/admin/orders`, {
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
console.log('pedido:', order.order?.order_number, 'total:', order.order?.total, 'id:', order.item?.id);

// Un mensaje programado a 2 minutos (para verlo en la cola).
const scheduled = await (
  await fetch(`${baseUrl}/api/admin/scheduled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      customerId: row.customer_id,
      conversationId: row.id,
      scheduledAt: new Date(Date.now() + 120000).toISOString(),
      text: 'Hola Ana, ¿te ayudo con algo más?',
      idempotencyKey: 'uat:seed:1',
    }),
  })
).json();
console.log('programado:', scheduled.message?.status);
