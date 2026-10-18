#!/usr/bin/env node
/**
 * IMPORTACIÓN FULLTECH (FullPOS) → CRM — idempotente.
 *
 * CÓMO FUNCIONA
 * -------------
 * No vuelve a decidir nada: aplica EXACTAMENTE el plan que dejó el dry-run
 * (`data/uat/import/fullpos/dry-run.json`). Así lo que se revisa es lo que se
 * importa.
 *
 * Es idempotente por construcción: antes de crear nada busca al cliente por
 * `phone_e164` y al producto por `sku`, las dos claves que ya son únicas en el
 * CRM. Ejecutarla dos veces deja la base igual que ejecutarla una vez.
 *
 * GARANTÍAS
 * ---------
 *  - Un cliente que ya existe NO se duplica: solo se le añade el grupo que
 *    falte. Nunca se pisan nombre, teléfono, notas, dirección ni historial.
 *  - `groups` es aditivo: un cliente de PHYTOEMAGRY que también compró en
 *    FULLTECH conserva PHYTOEMAGRY y gana el grupo de FULLTECH.
 *  - Los productos entran con `track_stock: false` («sin control de
 *    inventario») y con existencias 0: el stock de FullPOS NO se traslada.
 *  - Se escribe una fila de auditoría con el origen, la fecha y los totales.
 *
 * USO
 * ---
 *   node scripts/fullpos-import.mjs                      # simulación (no escribe)
 *   node scripts/fullpos-import.mjs --apply              # escribe en la base --db
 *   node scripts/fullpos-import.mjs --apply --db=data/uat/phyto-uat.sqlite
 *
 * La simulación recorre el mismo código y cuenta lo que haría, pero no abre la
 * base en escritura.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createCollections } from '../server/collections.mjs';

/* --------------------------------------------------------------- parámetros */
const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      return [k, v];
    }),
);
const DIR = args.get('dir') || 'data/uat/import/fullpos';
const DB = args.get('db') || 'data/uat/phyto-uat.sqlite';
const APPLY = args.get('apply') === 'true';

const planFile = join(DIR, 'dry-run.json');
if (!existsSync(planFile)) {
  console.error(`Falta el plan del dry-run: ${planFile}\nEjecuta antes: node scripts/fullpos-dry-run.mjs`);
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const detail = plan.detail ?? {};
const newCustomers = detail.customers?.new ?? [];
const matchedCustomers = detail.customers?.matched ?? [];
const newProducts = detail.products?.new ?? [];
const categories = detail.products?.categories ?? [];

/* --------------------------------------------------------------- utilidades */
const now = () => new Date().toISOString();

/** Misma clave de categoría que usa el catálogo (`store-catalog.mjs`). */
const categoryKey = (name) => String(name).trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');

/** SKU estable para los productos que en FullPOS no traen código. */
const syntheticSku = (name) => `FT-${createHash('sha1').update(String(name)).digest('hex').slice(0, 10).toUpperCase()}`;

const toCents = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

/* ------------------------------------------------------------------ resultado */
const result = {
  mode: APPLY ? 'apply' : 'simulate',
  backend: (args.get('backend') || 'sqlite').toLowerCase(),
  database: (args.get('backend') || 'sqlite').toLowerCase() === 'postgres' ? 'postgres (PHYTO_CRM_DATABASE_URL)' : DB,
  started_at: now(),
  customers: { created: 0, groups_added: 0, unchanged: 0, skipped_no_phone: 0 },
  products: { created: 0, skipped_existing: 0 },
  categories: { created: 0, existing: 0 },
  errors: [],
};

/* ------------------------------------------------------------------- escritura */
/*
 * DOS MOTORES, EL MISMO GUION.
 *
 *  - UAT y desarrollo: SQLite (`node:sqlite`). En simulación se trabaja sobre una
 *    COPIA temporal (`VACUUM INTO`), nunca sobre la base real.
 *  - Producción: PostgreSQL. Se conecta con `PHYTO_CRM_DATABASE_URL`, que ya
 *    está en el entorno del contenedor del CRM y NUNCA se imprime.
 *
 * Las consultas se escriben con `?` y el adaptador las traduce a `$1, $2…` para
 * Postgres, así que el resto del archivo es idéntico en los dos motores.
 */
const BACKEND = (args.get('backend') || 'sqlite').toLowerCase();
let simulationCopy = null;
/** @type {any} */
let store;
let selectRows;
let write;
let closeDb;

if (BACKEND === 'postgres') {
  const connectionString = process.env.PHYTO_CRM_DATABASE_URL;
  if (!connectionString) {
    console.error('Falta PHYTO_CRM_DATABASE_URL (en el contenedor del CRM ya viene puesta).');
    process.exit(1);
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 4 });
  store = await createCollections({ backend: 'postgres', handle: pool, prefix: 'phytoemagry_' });
  const toPg = (sql, params = []) => {
    let index = 0;
    return { text: String(sql).replace(/\?/g, () => `$${++index}`), values: params };
  };
  selectRows = async (sql, params) => (await pool.query(toPg(sql, params))).rows;
  write = async (sql, params) => {
    await pool.query(toPg(sql, params));
  };
  closeDb = () => pool.end();
} else {
  const { DatabaseSync } = await import('node:sqlite');
  if (!APPLY) {
    const target = join(tmpdir(), `phyto-sim-${Date.now()}-${process.pid}.sqlite`);
    const source = new DatabaseSync(DB, { readOnly: true });
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    source.close();
    simulationCopy = target;
  }
  const db = new DatabaseSync(APPLY ? DB : simulationCopy, { readOnly: !APPLY });
  store = await createCollections({ backend: 'sqlite', handle: db, prefix: 'phytoemagry_' });
  selectRows = async (sql, params = []) => db.prepare(sql).all(...params);
  write = async (sql, params = []) => {
    db.prepare(sql).run(...params);
  };
  closeDb = () => db.close();
}

/** Conversaciones ya existentes, cargadas una sola vez. */
const conversationsByCustomer = new Set(
  (await store.list('conversations')).map((row) => row.customer_id).filter(Boolean),
);

/** Crea la conversación vacía, igual que `findOrCreateByPhone`. */
async function ensureConversation(customerId) {
  if (conversationsByCustomer.has(customerId)) return;
  conversationsByCustomer.add(customerId);
  const stamp = now();
  await store.insert('conversations', {
    id: `cnv_${randomUUID()}`,
    customer_id: customerId,
    channel: 'whatsapp',
    status: 'AUTOMATIC',
    assigned_to: null,
    assigned_user_id: null,
    assigned_display_name_snapshot: null,
    last_message_at: null,
    last_inbound_at: null,
    unread_count: 0,
    created_at: stamp,
    updated_at: stamp,
  });
}

/* ------------------------------------------------------------------- clientes */
async function importCustomer(client) {
  if (!client.phone_e164) { result.customers.skipped_no_phone += 1; return; }
  const existing = await store.findBy('customers', 'phone_e164', client.phone_e164);

  if (existing) {
    // Ya está: solo se AÑADE el grupo. Nada más se toca.
    const current = Array.isArray(existing.groups) && existing.groups.length ? existing.groups : ['PHYTOEMAGRY'];
    const merged = [...new Set([...current, client.proposed_group])];
    if (merged.length === current.length) { result.customers.unchanged += 1; return; }
    if (APPLY) {
      await store.update('customers', existing.id, { groups: merged, updated_at: now() });
    }
    result.customers.groups_added += 1;
    return;
  }

  const stamp = now();
  const doc = {
    id: `cus_${randomUUID()}`,
    name: client.name ?? null,
    phone: client.phone_raw ?? client.phone_e164,
    phone_e164: client.phone_e164,
    email: client.email ?? null,
    location: client.address ?? null,
    source: 'fullpos',
    groups: [client.proposed_group],
    business_name: client.business_name ?? null,
    tax_id: client.tax_id ?? null,
    external_ids: { fullpos: client.source_ids ?? [client.source_id] },
    notes: client.notes ?? null,
    created_at: stamp,
    updated_at: stamp,
    // Campos que el resto del CRM espera encontrar.
    whatsapp_opt_in: false,
    whatsapp_opt_in_at: null,
    whatsapp_opt_out_at: null,
    do_not_contact: false,
    automation_state: 'AUTOMATIC',
    last_contact_at: null,
    next_followup_at: null,
    last_purchase_at: null,
    total_purchases: 0,
    total_spent: 0,
    customer_stage_manual: null,
    // Trazabilidad de la importación.
    imported_from: 'fullpos-fulltech',
    imported_at: stamp,
    source_created_at: client.created_at ?? null,
  };

  if (APPLY) {
    const inserted = await store.insert('customers', doc);
    if (inserted.duplicate) { result.customers.unchanged += 1; return; }
    await ensureConversation(doc.id);
  }
  result.customers.created += 1;
}

for (const client of newCustomers) await importCustomer(client);
// Los que ya existían en el CRM también ganan el grupo de FULLTECH.
for (const client of matchedCustomers) await importCustomer({
  phone_e164: client.phone_e164,
  name: client.imported_name,
  phone_raw: client.phone_e164,
  proposed_group: client.groups_after?.find((g) => g !== 'PHYTOEMAGRY') ?? 'FULLTECH — Ventas generales',
});

/* ----------------------------------------------------------------- categorías */
async function ensureCategory(name, businessGroup) {
  const key = categoryKey(name);
  const rows = await selectRows('SELECT id FROM fulltech_categories_v1 WHERE category_key = ?', [key]);
  if (rows.length) { result.categories.existing += 1; return rows[0].id; }
  const id = `category_${randomUUID()}`;
  const doc = {
    id,
    name,
    image_url: null,
    business_group: businessGroup,
    created_at: now(),
    imported_from: 'fullpos-fulltech',
  };
  if (APPLY) {
    await write('INSERT INTO fulltech_categories_v1(id, category_key, doc) VALUES(?,?,?) ON CONFLICT(category_key) DO NOTHING', [id, key, JSON.stringify(doc)]);
  }
  result.categories.created += 1;
  return id;
}

const categoryIds = new Map();
for (const category of categories) {
  categoryIds.set(category.name, await ensureCategory(category.name, category.business_group));
}

/* ------------------------------------------------------------------- productos */

for (const product of newProducts) {
  const sku = product.sku || syntheticSku(product.name);
  const existing = await selectRows('SELECT id FROM fulltech_catalog_v1 WHERE sku = ?', [sku]);
  if (existing.length) { result.products.skipped_existing += 1; continue; }

  const id = `prod_${randomUUID()}`;
  const categoryId = categoryIds.get(product.category) ?? null;
  const doc = {
    id,
    sku,
    kind: 'product',
    name: product.name,
    category: product.category,
    category_id: categoryId,
    description: '',
    price_cents: toCents(product.price),
    cost_cents: toCents(product.cost),
    image_url: null,
    active: true,
    // SIN CONTROL DE INVENTARIO: se puede vender sin existencias y no descuenta.
    track_stock: false,
    min_stock: 0,
    unit: product.unit || 'unidad',
    business_group: product.business_group,
    external_ids: { fullpos: product.source_id, fullpos_codigo: product.source_codigo ?? null },
    imported_from: 'fullpos-fulltech',
    created_at: now(),
  };

  if (APPLY) {
    await write('INSERT INTO fulltech_catalog_v1(id, sku, quantity, version, doc) VALUES(?,?,0,1,?) ON CONFLICT(sku) DO NOTHING', [id, sku, JSON.stringify(doc)]);
  }
  result.products.created += 1;
}

/* ------------------------------------------------------------------- auditoría */
result.finished_at = now();
result.source = plan.report?.source ?? 'FullPOS / DaleVentas — FULLTECH, SRL';
result.plan_generated_at = plan.report?.generated_at ?? null;
result.totals = {
  customers_in_plan: newCustomers.length + matchedCustomers.length,
  products_in_plan: newProducts.length,
  categories_in_plan: categories.length,
};

if (APPLY) {
  await store.insert('audit', {
    id: `aud_${randomUUID()}`,
    entity: 'import',
    entity_id: 'fullpos-fulltech',
    action: 'import.run',
    created_at: result.finished_at,
    actor: 'sistema',
    detail: {
      source: result.source,
      plan_generated_at: result.plan_generated_at,
      customers: result.customers,
      products: result.products,
      categories: result.categories,
      mapping: {
        customer_group: 'FullPOS no distingue el negocio: se propone «Ventas generales» salvo palabras de seguridad en nombre o notas.',
        product_group: 'Deducido de la categoría y del nombre del producto.',
        inventory_policy: 'Todos los productos entran como «sin control de inventario»; el stock de FullPOS no se traslada.',
      },
    },
  });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'import-log.json'), JSON.stringify(result, null, 2), 'utf8');
}

console.log(JSON.stringify(result, null, 2));

await closeDb();
if (simulationCopy) rmSync(simulationCopy, { force: true });
