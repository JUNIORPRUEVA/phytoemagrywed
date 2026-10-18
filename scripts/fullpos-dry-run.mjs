#!/usr/bin/env node
/**
 * DRY-RUN — Importación de FULLTECH (FullPOS / DaleVentas) al CRM.
 *
 * QUÉ HACE Y QUÉ NO HACE
 * ----------------------
 * Lee los volcados de solo lectura de FullPOS (`data/uat/import/fullpos/*.ndjson`),
 * los normaliza, los clasifica y los compara con los clientes y productos que YA
 * existen en el CRM. Deja un informe con las cuentas exactas.
 *
 * NO ESCRIBE EN NINGUNA BASE DE DATOS. Ni en la del CRM ni, por supuesto, en la
 * de FullPOS. Este archivo solo sirve para decidir; la importación real es otro
 * paso y necesita autorización.
 *
 * REGLAS QUE APLICA
 * -----------------
 *  - Teléfonos: se reutiliza `normalizePhone` del propio CRM (quita todo lo que
 *    no sea dígito, descarta el prefijo `00`, añade el país 1 a los números de
 *    10 dígitos y rechaza los de menos de 8). Un número que no identifica a
 *    nadie se marca, no se inventa.
 *  - Un cliente por teléfono: dentro del volcado se consolida en la ficha más
 *    antigua; los campos se completan, nunca se pisan con vacíos.
 *  - Si el teléfono YA existe en el CRM, no se crea otro cliente: se propone
 *    añadirle el grupo de FULLTECH y se conserva su `id` (y con él su
 *    conversación, pedidos e historial).
 *  - Productos: clave por código (SKU) y, si no hay, por nombre normalizado
 *    (sin acentos, sin espacios de más, sin mayúsculas).
 *  - Inventario: NO se da por hecho. El volcado de FullPOS no es el almacén
 *    físico de PHYTOEMAGRY, así que la propuesta por defecto es «sin control de
 *    inventario» y todo producto que en FullPOS lleve control de stock se marca
 *    para revisión.
 *
 * USO
 * ---
 *   node scripts/fullpos-dry-run.mjs
 *   node scripts/fullpos-dry-run.mjs --db=data/uat/phyto-uat.sqlite --out=data/uat/import/fullpos
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizePhone } from '../server/meta-capi.mjs';

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
const OUT = args.get('out') || DIR;
const QUIET = args.get('quiet') === 'true';

/* ------------------------------------------------------------------ utilidades */
/** Texto comparable: sin acentos, sin mayúsculas y con espacios simples. */
const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

/** Teléfono a E.164 usando el mismo criterio que el CRM (`+` + dígitos). */
const toE164 = (raw) => {
  const digits = normalizePhone(raw);
  return digits ? `+${digits}` : null;
};

function readNdjson(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* Una línea corrupta no debe tumbar el análisis: se cuenta aparte. */
      rows.push({ __invalid: true, raw: trimmed.slice(0, 120) });
    }
  }
  return rows;
}

/**
 * Palabras que delatan el negocio de sistemas de seguridad. Se comparan sobre el
 * texto plegado (sin acentos) y con raíces, para que «cámaras» y «camara» cuenten
 * igual.
 */
const SECURITY_ROOTS = [
  'camara', 'cctv', 'dvr', 'nvr', 'alarma', 'seguridad', 'vigilancia',
  'cerco electrico', 'monitoreo', 'biometrico', 'control de acceso',
  'videoportero', 'intercom', 'sensor de movimiento', 'detector de humo',
];
const isSecurity = (text) => {
  const folded = fold(text);
  return SECURITY_ROOTS.some((root) => folded.includes(root));
};

const GROUPS = Object.freeze({
  PHYTO: 'PHYTOEMAGRY',
  GENERAL: 'FULLTECH — Ventas generales',
  SECURITY: 'FULLTECH — Sistemas de seguridad',
});

/* ---------------------------------------------------------------- volcados FP */
const rawClients = readNdjson(join(DIR, 'clients.ndjson'));
const rawProducts = readNdjson(join(DIR, 'products.ndjson'));

const issues = { corruptLines: 0 };

/* -------------------------------------------------------------- CLIENTES: CRM */
/** Clientes que ya existen en el CRM, indexados por teléfono normalizado. */
function loadExistingCustomers(file) {
  const index = new Map();
  if (!existsSync(file)) return { index, total: 0, error: `no existe ${file}` };
  const db = new DatabaseSync(file, { readOnly: true });
  let rows = [];
  try {
    rows = db.prepare('select id, doc from phytoemagry_customers').all();
  } catch (error) {
    return { index, total: 0, error: String(error?.message || error) };
  } finally {
    db.close();
  }
  for (const row of rows) {
    const doc = JSON.parse(row.doc);
    const e164 = doc.phone_e164 || toE164(doc.phone);
    if (!e164) continue;
    index.set(e164, {
      id: row.id,
      name: doc.name ?? null,
      groups: Array.isArray(doc.groups) ? doc.groups : [GROUPS.PHYTO],
    });
  }
  return { index, total: rows.length };
}

const existing = loadExistingCustomers(DB);

/*
 * CONTRA QUIÉN SE COMPARA
 * -----------------------
 * Lo normal es comparar contra la base del CRM que se le pasa con `--db`.
 * Cuando esa base es la de UAT (datos de prueba), el resultado no sirve para
 * decidir una importación real: por eso se puede pasar una lista de teléfonos
 * ya normalizados del CRM DE PRODUCCIÓN (`--existing-phones`). En ese caso se
 * compara SOLO contra esa lista, y no se mezclan los clientes de demostración.
 *
 * La lista contiene únicamente números E.164: ni nombres, ni direcciones, ni
 * historial.
 */
const phonesFile = args.get('existing-phones');
if (phonesFile) {
  if (!existsSync(phonesFile)) {
    console.error(`No existe la lista de teléfonos: ${phonesFile}`);
    process.exit(1);
  }
  existing.index.clear();
  existing.total = 0;
  existing.error = null;
  const text = readFileSync(phonesFile, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const e164 = toE164(line.trim());
    if (!e164) continue;
    if (existing.index.has(e164)) continue;
    existing.index.set(e164, { id: null, name: null, groups: [GROUPS.PHYTO], from: 'produccion' });
  }
  existing.total = existing.index.size;
  existing.basis = `producción (${phonesFile})`;
} else {
  existing.basis = DB;
}

/* ---------------------------------------------------------- clientes: normalizar */
const clients = [];
for (const row of rawClients) {
  if (row.__invalid) { issues.corruptLines++; continue; }
  const phoneRaw = row.telefono || row.phone_normalized || '';
  const e164 = toE164(phoneRaw);
  const flags = [];
  if (!e164) flags.push('telefono_invalido');
  if (String(row.nombre ?? '').trim().length < 2) flags.push('sin_nombre');
  if (!row.direccion) flags.push('sin_direccion');

  const haystack = [row.nombre, row.business_name, row.notas].filter(Boolean).join(' | ');
  const proposedGroup = isSecurity(haystack) ? GROUPS.SECURITY : GROUPS.GENERAL;

  clients.push({
    source_id: row.source_id,
    name: clean(row.nombre, 120),
    business_name: clean(row.business_name, 120),
    tax_id: clean(row.tax_id, 40),
    phone_raw: clean(phoneRaw, 40),
    phone_e164: e164,
    email: clean(row.email, 160),
    address: clean(row.direccion, 240),
    notes: clean(row.notas, 600),
    location_url: clean(row.location_url, 300),
    created_at: row.created_at ?? null,
    is_deleted: row.is_deleted === true,
    proposed_group: proposedGroup,
    // El volcado de FullPOS no distingue «ventas generales» de «seguridad»: el
    // grupo es una PROPUESTA y siempre se marca para revisión.
    group_confidence: 'propuesta',
    flags,
  });
}

/* ------------------------------------------------- clientes: unificar duplicados */
function mergeClient(target, incoming) {
  target.duplicates = (target.duplicates ?? 0) + 1;
  target.source_ids = [...(target.source_ids ?? [target.source_id]), incoming.source_id];
  if (!target.name && incoming.name) target.name = incoming.name;
  if (!target.business_name && incoming.business_name) target.business_name = incoming.business_name;
  if (!target.tax_id && incoming.tax_id) target.tax_id = incoming.tax_id;
  if (!target.email && incoming.email) target.email = incoming.email;
  if ((incoming.address?.length ?? 0) > (target.address?.length ?? 0)) target.address = incoming.address;
  if ((incoming.notes?.length ?? 0) > (target.notes?.length ?? 0)) target.notes = incoming.notes;
  if (!target.location_url && incoming.location_url) target.location_url = incoming.location_url;
  // Discrepancia de nombre: dos fichas distintas con el mismo teléfono.
  if (target.name && incoming.name && fold(target.name) !== fold(incoming.name)) {
    target.flags = new Set([...(target.flags ?? []), 'nombre_discrepante']);
  }
  // El grupo más específico gana (seguridad sobre general).
  if (incoming.proposed_group === GROUPS.SECURITY) target.proposed_group = GROUPS.SECURITY;
  target.flags = new Set([...(target.flags ?? []), ...(incoming.flags ?? [])]);
}

const invalidClients = [];
const byPhone = new Map();
for (const client of clients) {
  if (!client.phone_e164) { invalidClients.push(client); continue; }
  const current = byPhone.get(client.phone_e164);
  if (!current) {
    byPhone.set(client.phone_e164, { ...client, flags: new Set(client.flags), duplicates: 0 });
    continue;
  }
  // Gana la ficha más antigua (conserva la identidad histórica).
  const older = (current.created_at ?? '9999') <= (client.created_at ?? '9999') ? current : client;
  const newer = older === current ? client : current;
  if (older === client) {
    byPhone.set(client.phone_e164, { ...client, flags: new Set(client.flags), duplicates: current.duplicates ?? 0 });
  }
  mergeClient(byPhone.get(client.phone_e164), newer);
}

const uniqueClients = [...byPhone.values()];

/* ------------------------------------------------- clientes: contra el CRM real */
const matched = [];
const fresh = [];
for (const client of uniqueClients) {
  const hit = existing.index.get(client.phone_e164);
  if (hit) {
    const groups = new Set([...(hit.groups ?? [GROUPS.PHYTO]), client.proposed_group]);
    matched.push({
      phone_e164: client.phone_e164,
      existing_customer_id: hit.id,
      existing_name: hit.name,
      imported_name: client.name,
      name_conflict: Boolean(hit.name && client.name && fold(hit.name) !== fold(client.name)),
      groups_after: [...groups],
      adds_group: !hit.groups?.includes(client.proposed_group),
      keeps_existing_fields: true,
      source_ids: client.source_ids ?? [client.source_id],
    });
  } else {
    fresh.push(client);
  }
}

/* ------------------------------------------------------------------- PRODUCTOS */
/** Catálogo actual del CRM (para no duplicar por nombre o código). */
function loadExistingProducts(file) {
  const bySku = new Map();
  const byName = new Map();
  if (!existsSync(file)) return { bySku, byName, total: 0, error: `no existe ${file}` };
  const db = new DatabaseSync(file, { readOnly: true });
  let rows = [];
  try {
    rows = db.prepare('select id, sku, doc from fulltech_catalog_v1').all();
  } catch (error) {
    return { bySku, byName, total: 0, error: String(error?.message || error) };
  } finally {
    db.close();
  }
  for (const row of rows) {
    const doc = JSON.parse(row.doc);
    if (row.sku) bySku.set(fold(row.sku), { id: row.id, sku: row.sku, name: doc.name, track_stock: doc.track_stock !== false });
    if (doc.name) byName.set(fold(doc.name), { id: row.id, sku: row.sku, name: doc.name, track_stock: doc.track_stock !== false });
  }
  return { bySku, byName, total: rows.length };
}

const catalog = loadExistingProducts(DB);

/*
 * Igual que con los clientes: si la base que se pasa es la de UAT (que ya tiene
 * los productos importados), comparar contra ella diría «no hay nada nuevo».
 * Con `--existing-products` se compara contra el catálogo REAL, exportado como
 * JSON `[{ "sku": "...", "name": "..." }]` (solo código y nombre).
 */
const productsFile = args.get('existing-products');
if (productsFile) {
  if (!existsSync(productsFile)) {
    console.error(`No existe el catálogo de referencia: ${productsFile}`);
    process.exit(1);
  }
  // Acepta las dos formas: un array JSON o una línea JSON por producto (NDJSON).
  const rawProductsFile = readFileSync(productsFile, 'utf8').replace(/^\uFEFF/, '').trim();
  let rows = [];
  try {
    const parsed = JSON.parse(rawProductsFile);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = readNdjson(productsFile);
  }
  catalog.bySku.clear();
  catalog.byName.clear();
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = { id: row.id ?? null, sku: row.sku, name: row.name, track_stock: row.track_stock !== false };
    if (row.sku) catalog.bySku.set(fold(row.sku), entry);
    if (row.name) catalog.byName.set(fold(row.name), entry);
  }
  catalog.total = Array.isArray(rows) ? rows.length : 0;
  catalog.error = null;
  catalog.basis = `producción (${productsFile})`;
}

const products = [];
let archivedSkipped = 0;
/*
 * En FullPOS el campo `codigo` no siempre es un código de producto: en 99 de
 * los 110 artículos de FULLTECH es un UUID interno. Un SKU así no se le puede
 * enseñar a nadie en el catálogo, así que:
 *   - se guarda siempre el original (`source_codigo`),
 *   - se usa como SKU solo si es un código legible (números o texto corto),
 *   - y si no, el importador genera uno estable a partir del nombre.
 */
const isInternalId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '').trim());
for (const row of rawProducts) {
  if (row.__invalid) { issues.corruptLines++; continue; }
  if (row.archived_at) { archivedSkipped += 1; continue; }
  const name = clean(row.nombre, 200);
  const sourceCode = clean(row.codigo, 60);
  const sku = sourceCode && !isInternalId(sourceCode) ? sourceCode : null;
  const key = sku ? `sku:${fold(sku)}` : `nom:${fold(name)}`;
  const category = clean(row.categoria, 120) || 'Sin categoría';
  const group = isSecurity(`${category} ${name}`) ? GROUPS.SECURITY : GROUPS.GENERAL;
  products.push({
    source_id: row.source_id,
    key,
    name,
    sku,
    source_codigo: sourceCode,
    category,
    category_key: fold(category),
    business_group: group,
    cost: row.costo === null ? null : Number(row.costo),
    price: row.precio === null ? null : Number(row.precio),
    stock_fullpos: row.stock === null ? null : Number(row.stock),
    track_inventory_fullpos: row.track_inventory === true,
    unit: clean(row.item_type, 40),
    // Propuesta: sin control de inventario. El stock de FullPOS no se traslada.
    proposed_track_stock: false,
    review: row.track_inventory === true ? 'revisar_politica_inventario' : null,
  });
}

const byProductKey = new Map();
for (const product of products) {
  const current = byProductKey.get(product.key);
  if (!current) { byProductKey.set(product.key, { ...product, duplicates: 0 }); continue; }
  current.duplicates += 1;
  if (!current.sku && product.sku) current.sku = product.sku;
  if ((product.price ?? 0) > (current.price ?? 0)) current.price = product.price;
}
const uniqueProducts = [...byProductKey.values()];

const productsNew = [];
const productsMatched = [];
for (const product of uniqueProducts) {
  const bySku = product.sku ? catalog.bySku.get(fold(product.sku)) : null;
  const byName = catalog.byName.get(fold(product.name));
  const hit = bySku || byName;
  if (hit) productsMatched.push({ ...product, existing_id: hit.id, existing_name: hit.name, matched_by: bySku ? 'sku' : 'nombre' });
  else productsNew.push(product);
}

/* --------------------------------------------------------------- categorías */
const categories = new Map();
for (const product of uniqueProducts) {
  const entry = categories.get(product.category_key) ?? {
    name: product.category,
    key: product.category_key,
    business_group: product.business_group,
    products: 0,
  };
  entry.products += 1;
  categories.set(product.category_key, entry);
}

/* ------------------------------------------------------------------ resultados */
const countBy = (list, field) => list.reduce((acc, item) => {
  const key = item[field] ?? '(sin valor)';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

/*
 * Dos clases de aviso, porque no significan lo mismo:
 *  - REVISAR: hay que tomar una decisión antes de importar (no hay teléfono, no
 *    hay nombre, dos fichas con nombres distintos para el mismo número).
 *  - INFORMATIVO: solo falta un dato que se puede completar después (la
 *    dirección), y no impide importar al cliente.
 */
const REVIEW_FLAGS = new Set(['telefono_invalido', 'sin_nombre', 'nombre_discrepante']);
const needsReview = (client) => [...(client.flags ?? [])].some((f) => REVIEW_FLAGS.has(f));

const report = {
  generated_at: new Date().toISOString(),
  source: 'FullPOS / DaleVentas — empresa FULLTECH, SRL (RNC 133080206)',
  dry_run: true,
  writes: 0,
  inputs: {
    clients_file: join(DIR, 'clients.ndjson'),
    products_file: join(DIR, 'products.ndjson'),
    crm_database: DB,
    compared_against: existing.basis ?? DB,
  },
  customers: {
    rows_read: rawClients.length,
    invalid_phone: invalidClients.length,
    unique_by_phone: uniqueClients.length,
    duplicates_inside_source: uniqueClients.reduce((n, c) => n + (c.duplicates ?? 0), 0),
    already_in_crm_matched: matched.length,
    new_to_crm: fresh.length,
    groups: {
      ...countBy(uniqueClients, 'proposed_group'),
      [GROUPS.PHYTO]: existing.index.size,
    },
    name_conflicts: matched.filter((m) => m.name_conflict).length,
    flagged_for_review: uniqueClients.filter(needsReview).length,
    missing_address: uniqueClients.filter((c) => [...(c.flags ?? [])].includes('sin_direccion')).length,
  },
  products: {
    rows_read: rawProducts.length,
    archived_skipped: archivedSkipped,
    unique: uniqueProducts.length,
    duplicates_inside_source: uniqueProducts.reduce((n, p) => n + (p.duplicates ?? 0), 0),
    new_to_crm: productsNew.length,
    matched_in_crm: productsMatched.length,
    categories: categories.size,
    groups: countBy(uniqueProducts, 'business_group'),
    policy_proposed: countBy(uniqueProducts, 'proposed_track_stock'),
    pending_inventory_review: uniqueProducts.filter((p) => p.review).length,
  },
  existing_crm: {
    customers: existing.total,
    customers_with_phone: existing.index.size,
    products: catalog.total,
    error: existing.error || catalog.error || null,
  },
  issues,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'dry-run.json'), JSON.stringify({
  report,
  detail: {
    customers: {
      matched,
      new: fresh.map(({ flags, ...c }) => ({ ...c, flags: [...flags] })),
      invalid: invalidClients,
    },
    products: {
      matched: productsMatched,
      new: productsNew,
      categories: [...categories.values()],
    },
  },
}, null, 2), 'utf8');

const md = `# Dry-run · FULLTECH (FullPOS) → PHYTOEMAGRY

Generado: ${report.generated_at}
Base comparada: \`${report.inputs.compared_against}\`
**Sin escrituras: este informe no ha modificado ninguna base de datos.**

## Clientes

| Concepto | Valor |
| --- | --- |
| Filas leídas | ${report.customers.rows_read} |
| Teléfono inválido (no identifican a nadie) | ${report.customers.invalid_phone} |
| Clientes únicos por teléfono | ${report.customers.unique_by_phone} |
| Filas repetidas dentro del origen (consolidadas) | ${report.customers.duplicates_inside_source} |
| Ya existen en el CRM (se les añade grupo) | ${report.customers.already_in_crm_matched} |
| Nuevos | ${report.customers.new_to_crm} |
| Conflictos de nombre con el CRM | ${report.customers.name_conflicts} |
| Marcados para revisar | ${report.customers.flagged_for_review} |
| Sin dirección (informativo) | ${report.customers.missing_address} |

Grupos propuestos:
${Object.entries(report.customers.groups).map(([g, n]) => `- ${g}: ${n}`).join('\n')}

## Productos

| Concepto | Valor |
| --- | --- |
| Filas leídas | ${report.products.rows_read} |
| Archivados en FullPOS (no se importan) | ${report.products.archived_skipped} |
| Únicos (SKU o nombre normalizado) | ${report.products.unique} |
| Repetidos en el origen (consolidados) | ${report.products.duplicates_inside_source} |
| Nuevos en el CRM | ${report.products.new_to_crm} |
| Ya existen | ${report.products.matched_in_crm} |
| Categorías distintas | ${report.products.categories} |
| Con política de inventario a revisar | ${report.products.pending_inventory_review} |

Grupos propuestos:
${Object.entries(report.products.groups).map(([g, n]) => `- ${g}: ${n}`).join('\n')}

Política propuesta (\`track_stock\`):
${Object.entries(report.products.policy_proposed).map(([g, n]) => `- ${g}: ${n}`).join('\n')}

## Acciones que se aplicarían con la autorización

1. Añadir \`groups\` a los clientes nuevos (PHYTOEMAGRY no cambia en los existentes).
2. Añadir el grupo FULLTECH a los ${matched.length} clientes ya existentes **sin tocar su id, nombre, teléfono, conversación ni pedidos**.
3. Crear las ${categories.size} categorías con su grupo de negocio.
4. Crear ${productsNew.length} productos con \`track_stock: false\` (sin control de inventario) y sin importar existencias de FullPOS.
`;
writeFileSync(join(OUT, 'dry-run.md'), md, 'utf8');

/*
 * LOS RECHAZADOS, EN UN ARCHIVO APARTE. Se excluyen de la importación porque su
 * teléfono no identifica a nadie, pero NO se pierden: quedan aquí con todos los
 * datos que traía FullPOS para revisarlos a mano y corregirlos cuando se sepan.
 * El archivo vive en `data/` (ignorado por git): contiene datos personales.
 */
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
writeFileSync(
  join(OUT, 'revision-telefonos-invalidos.csv'),
  [
    'nombre,razon_social,telefono,direccion,notas,origen_id',
    ...invalidClients.map((client) =>
      [client.name, client.business_name, client.phone_raw, client.address, client.notes, client.source_id]
        .map(csvCell)
        .join(','),
    ),
  ].join('\r\n'),
  'utf8',
);

if (!QUIET) {
  console.log(`Dry-run listo (0 escrituras). Informe: ${join(OUT, 'dry-run.md')}`);
  console.log(`Clientes: ${rawClients.length} filas → ${uniqueClients.length} por teléfono | ya en CRM: ${matched.length} | nuevos: ${fresh.length} | inválidos: ${invalidClients.length}`);
  console.log(`Productos: ${rawProducts.length} filas → ${uniqueProducts.length} únicos | nuevos: ${productsNew.length} | existentes: ${productsMatched.length} | categorías: ${categories.size}`);
}
