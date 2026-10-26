/*
 * BACKEND UAT PARA PROBAR EN EL TELÉFONO (sin tocar producción).
 *
 * Qué hace:
 *   · Arranca el CRM NUEVO (el de multiempresa) con una base SQLite propia en
 *     `data/uat/phone.sqlite`. Esa base no es la de producción.
 *   · Crea un repartidor de prueba con PIN, un cliente y un pedido asignado.
 *   · Escucha SOLO en 127.0.0.1:8791: no abre nada en la LAN ni en el router.
 *
 * Cómo se usa con un teléfono:
 *   1) node scripts/uat-phone-backend.mjs
 *   2) en otra consola: ssh -R 80:localhost:8791 nokey@localhost.run
 *      → imprime una URL https pública con certificado válido
 *   3) compilar el APK con esa URL:
 *      flutter build apk --release --dart-define=DELIVERY_ENV=uat \
 *        --dart-define=DELIVERY_API_BASE_URL=https://<url-del-tunel> \
 *        --dart-define=DELIVERY_DEMO_DATA=false
 *
 * Qué NO hace: no lee ni escribe producción, no envía WhatsApp, no apaga Meta,
 * no abre puertos del router y no deja nada corriendo si se cierra la consola.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCrmServer } from '../server/crm-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'uat');
const PORT = Number(process.env.PHONE_UAT_PORT ?? 8791);
const TOKEN = process.env.PHONE_UAT_TOKEN ?? 'phone-uat-only';
const COURIER_PHONE = process.env.PHONE_UAT_COURIER ?? '+18091234567';
const COURIER_PIN = process.env.PHONE_UAT_PIN ?? '123456';
const COMPANY = process.env.PHONE_UAT_COMPANY ?? 'phytoemagry';
const reset = process.argv.includes('--reset');

mkdirSync(DIR, { recursive: true });
const dataFile = join(DIR, 'phone.sqlite');
if (reset) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dataFile}${suffix}`, { force: true });
}

const app = await startCrmServer({
  port: PORT,
  host: '127.0.0.1',
  dataFile,
  token: TOKEN,
  quiet: true,
  schedulerEnabled: false,
  whatsapp: { enabled: false },
  metaCapi: { enabled: false },
});

const base = `http://127.0.0.1:${PORT}`;

const admin = await (async () => {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  if (response.status !== 200) throw new Error(`admin login ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
})();

const adminCall = async (route, { method = 'GET', body } = {}) => {
  const response = await fetch(`${base}/api/admin/${route}`, {
    method,
    headers: { cookie: admin, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

// Contacto que recibirá los pedidos en la app.
await app.ctx.settings.write('delivery_contacts', [
  { id: 'contact-phone-uat', name: 'Repartidor Teléfono', phone: COURIER_PHONE, shareOrders: true },
]);

// Alta del acceso de repartidor (idempotente: si ya existe, se informa).
let created = await adminCall('couriers', {
  method: 'POST',
  body: {
    kind: 'EXTERNAL',
    phone: COURIER_PHONE,
    displayName: 'Repartidor Teléfono',
    contactId: 'contact-phone-uat',
    appAccess: true,
    pin: COURIER_PIN,
    companyId: COMPANY,
  },
});
if (created.status === 409) created = { status: 409, data: { note: 'la cuenta ya existía' } };

// Un pedido para que la app tenga trabajo real.
let orderId = null;
if (process.argv.includes('--con-pedido') || created.status === 201) {
  const customer = await adminCall('pos/customers', {
    method: 'POST',
    body: { name: 'Cliente Teléfono UAT', phone: '+18095550001' },
  });
  const order = await adminCall('orders', {
    method: 'POST',
    body: {
      name: customer.data.customer?.name ?? 'Cliente Teléfono UAT',
      phone: '+18095550001',
      status: 'nuevo',
      paymentMethod: 'CASH',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
    },
  });
  orderId = order.data.item?.id ?? order.data.order?.id ?? order.data.id ?? null;
  if (orderId) {
    const assigned = await adminCall(`orders/${orderId}/courier/assign`, {
      method: 'POST',
      body: { contactPhone: COURIER_PHONE },
    });
    if (assigned.status >= 300) orderId = `${orderId} (no asignado: ${assigned.status})`;
  }
}

// Comprobación de que el login del repartidor funciona como lo hará la app.
const login = await fetch(`${base}/api/courier/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: COURIER_PHONE, pin: COURIER_PIN }),
});
const session = await login.json().catch(() => ({}));

console.log('');
console.log('==================== BACKEND UAT PARA EL TELÉFONO ====================');
console.log(`base local        : ${base}`);
console.log(`base de datos     : ${dataFile}   (NO es producción)`);
console.log(`repartidor        : ${COURIER_PHONE}  PIN ${COURIER_PIN}  empresa ${COMPANY}`);
console.log(`alta del acceso   : ${created.status === 201 ? 'creada' : created.status === 409 ? 'ya existía' : `HTTP ${created.status}`}`);
console.log(`pedido asignado   : ${orderId ?? '(ninguno)'}`);
console.log(`login repartidor  : HTTP ${login.status} · empresas=${JSON.stringify(session.companies ?? null)}`);
console.log('');
console.log('Siguiente paso (otra consola):');
console.log(`  ssh -R 80:localhost:${PORT} nokey@localhost.run`);
console.log('La URL https que imprima es la que va en DELIVERY_API_BASE_URL.');
console.log('Ctrl+C aquí cierra el backend.');
console.log('======================================================================');
