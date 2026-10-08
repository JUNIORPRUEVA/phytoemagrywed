import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startCrmServer } from '../server/crm-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.tmp', 'local-crm-demo');
const DATA_FILE = path.join(DATA_DIR, 'phytoemagry.sqlite');
const TOKEN = process.env.PHYTO_CRM_TOKEN || 'phyto-local';
const ADMIN_USER = process.env.PHYTO_CRM_BOOTSTRAP_ADMIN_USER || 'admin@local.test';
const ADMIN_PASS = process.env.PHYTO_CRM_BOOTSTRAP_ADMIN_PASSWORD || 'AdminLocal-123';

const CLIENTS = [
  ['Yahaira prueba', '8494240621', 'COMPRO_REPORTADO', 'Compra reportada', 'Higuey'],
  ['Maria Rodriguez', '8095550101', 'COMPRO_REPORTADO', 'Compra reportada', 'La Otra Banda'],
  ['Ana Perez', '8095550102', 'COMPRO_REPORTADO', 'Compra reportada', 'Bavaro'],
  ['Luis Martinez', '8095550103', 'NO_COMPRO', 'No compro', 'Veron'],
  ['Rosa Jimenez', '8095550104', 'INTERESADO', 'Interesado', 'Higuey'],
  ['Carla Gomez', '8095550105', 'POR_VERIFICAR', 'Por verificar', 'Punta Cana'],
  ['Jose Batista', '8095550106', 'COMPRO_REPORTADO', 'Compra reportada', 'Higuey'],
  ['Nadia Santos', '8095550107', 'POR_VERIFICAR', 'Por verificar', 'Miches'],
  ['Pedro Diaz', '8095550108', 'NO_COMPRO', 'No compro', 'Hato Mayor'],
  ['Luz Fernandez', '8095550109', 'COMPRO_REPORTADO', 'Compra reportada', 'El Seibo'],
  ['Carmen Alcantara', '8095550110', 'INTERESADO', 'Interesado', 'Higuey'],
  ['Rafael Mejia', '8095550111', 'POR_VERIFICAR', 'Por verificar', 'Bavaro'],
  ['Elena Cruz', '8095550112', 'COMPRO_REPORTADO', 'Compra reportada', 'La Romana'],
  ['Miguel Arias', '8095550113', 'POR_VERIFICAR', 'Por verificar', 'Higuey'],
  ['Patricia Mendez', '8095550114', 'COMPRO_REPORTADO', 'Compra reportada', 'Veron'],
  ['Victor Nunez', '8095550115', 'POR_VERIFICAR', 'Por verificar', 'Higuey'],
  ['Sonia Reyes', '8095550116', 'COMPRO_REPORTADO', 'Compra reportada', 'Bavaro'],
  ['Daniel Castillo', '8095550117', 'INTERESADO', 'Interesado', 'Punta Cana'],
  ['Gloria Pena', '8095550118', 'POR_VERIFICAR', 'Por verificar', 'Miches'],
  ['Andres Morales', '8095550119', 'COMPRO_REPORTADO', 'Compra reportada', 'Higuey'],
];

const BARE_CLIENTS = [
  ['Cliente Sin Contacto 01', '8095550201', 'Higuey'],
  ['Cliente Sin Contacto 02', '8095550202', 'Bavaro'],
  ['Cliente Sin Contacto 03', '8095550203', 'Veron'],
  ['Cliente Sin Contacto 04', '8095550204', 'Punta Cana'],
  ['Cliente Sin Contacto 05', '8095550205', 'La Otra Banda'],
  ['Cliente Sin Contacto 06', '8095550206', 'Miches'],
  ['Cliente Sin Contacto 07', '8095550207', 'El Seibo'],
  ['Cliente Sin Contacto 08', '8095550208', 'La Romana'],
  ['Cliente Sin Contacto 09', '8095550209', 'Hato Mayor'],
  ['Cliente Sin Contacto 10', '8095550210', 'Higuey'],
];

const inboundSamples = [
  'Hola, quiero saber precio y delivery.',
  'Buenas, me interesa pedir un frasco.',
  'Hola, me puedes confirmar disponibilidad?',
  'Quiero informacion de las pastillas.',
  'Tengo una duda antes de comprar.',
];

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: DATA_FILE,
    token: TOKEN,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    bootstrapAdminDisplayName: 'Admin Local',
    quiet: true,
    schedulerEnabled: false,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!login.ok) throw new Error(`No se pudo entrar al CRM local (${login.status})`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const api = async (route, options = {}) => {
    const response = await fetch(`${app.url}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`${route}: ${response.status} ${data.message ?? data.error ?? text}`);
    return data;
  };

  let created = 0;
  let updated = 0;
  for (const [index, [name, phone, status, label, location]] of CLIENTS.entries()) {
    const found = await app.customers.findOrCreateByPhone({
      phone,
      name,
      location,
      source: 'demo-local',
      optIn: true,
    });
    if (!found.ok) throw new Error(`Telefono invalido en demo: ${phone}`);
    if (found.created) created += 1;
    else updated += 1;

    await app.customers.update(found.customer.id, {
      historicalWhatsAppImport: {
        status,
        status_label: label,
        notes: 'Dato local de demostracion para revisar filtros y campanas.',
        imported_at: new Date().toISOString(),
      },
      notes: 'Cliente demo local. Puede editarse libremente durante pruebas.',
    });

    const conversation = await app.customers.conversationFor(found.customer.id);
    const hasMessages = (await app.customers.messagesFor(conversation.id, { limit: 10 })).length > 0;
    if (!hasMessages) {
      await app.customers.recordInbound({
        waMessage: {
          waMessageId: `wamid.LOCAL-DEMO-${index + 1}`,
          from: phone,
          profileName: name,
          type: 'text',
          body: inboundSamples[index % inboundSamples.length],
          receivedAt: new Date(Date.now() - (index + 1) * 30 * 60_000).toISOString(),
        },
      });
    }

    if (index < 10) {
      const profile = await api(`/api/admin/customers/${found.customer.id}`);
      if ((profile.purchases ?? []).length === 0) {
        const variantId = ['capsules_5', 'capsules_10', 'capsules_15', 'capsules_30'][index % 4];
        const orderStatus = ['nuevo', 'en_preparacion', 'en_camino', 'cancelado'][index % 4];
        await api('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({
            customerId: found.customer.id,
            items: [{ variantId, quantity: 1 }],
            paymentMethod: index % 2 === 0 ? 'CASH' : 'TRANSFER',
            status: orderStatus,
            date: new Date(Date.now() - index * 24 * 60 * 60_000).toISOString(),
            notes: 'Pedido demo local para revisar pantallas.',
          }),
        });
      }
    }

    if (status === 'INTERESADO') {
      await api(`/api/admin/customers/${found.customer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ commercialState: 'INTERESADO' }),
      }).catch(() => null);
    }
  }

  let bareCreated = 0;
  let bareUpdated = 0;
  for (const [name, phone, location] of BARE_CLIENTS) {
    const found = await app.customers.findOrCreateByPhone({
      phone,
      name,
      location,
      source: 'demo-local-sin-contacto',
      optIn: false,
    });
    if (!found.ok) throw new Error(`Telefono invalido en demo sin contacto: ${phone}`);
    if (found.created) bareCreated += 1;
    else bareUpdated += 1;
    await app.customers.update(found.customer.id, {
      notes: 'Cliente demo local creado sin mensajes, sin pedidos y sin conversaciones activas.',
      historicalWhatsAppImport: null,
      last_contact_at: null,
      next_followup_at: null,
      last_purchase_at: null,
      total_purchases: 0,
      total_spent: 0,
    });
    const conversation = await app.customers.conversationFor(found.customer.id, { create: false });
    if (conversation?.id) await app.collections.remove('conversations', conversation.id);
  }

  const data = await api('/api/admin/data');
  console.log(
    JSON.stringify(
      {
        ok: true,
        dataFile: DATA_FILE,
        created,
        updated,
        bareCreated,
        bareUpdated,
        customers: data.customers?.length ?? 0,
        orders: (data.items ?? []).filter((item) => item.type === 'order_intent').length,
        adminUser: ADMIN_USER,
        adminPassword: ADMIN_PASS,
      },
      null,
      2,
    ),
  );
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
