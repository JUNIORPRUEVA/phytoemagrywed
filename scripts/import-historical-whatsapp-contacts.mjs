#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { createCollections } from '../server/collections.mjs';
import { createCustomerService } from '../server/customers.mjs';
import { createStore } from '../server/stores.mjs';
import { toE164 } from '../server/whatsapp.mjs';

const IMPORT_SOURCE = 'Importación histórica de contactos WhatsApp';
const EXPECTED_COUNT = 34;
const BUYER_MARK = 'Compró (indicado)';
const NO_BUY_PHONES = new Set(['+18096738255', '+18098556095']);
const STATUS_VALUES = Object.freeze(['COMPRO_REPORTADO', 'NO_COMPRO', 'INTERESADO', 'POR_VERIFICAR']);
const STATUS_LABELS = Object.freeze({
  COMPRO_REPORTADO: 'COMPRÓ — compra reportada',
  NO_COMPRO: 'NO COMPRÓ — sin compra reportada',
  INTERESADO: 'INTERESADO — manifestó interés',
  POR_VERIFICAR: 'POR VERIFICAR — información insuficiente',
});

const REFERENCE = [
  ['Fransheska', '829-812-9422'],
  ['Cliente PHYTOEMAGRY 002', '809-666-0781'],
  ['Berneris', '829-358-3945'],
  ['Auri', '809-660-9420'],
  ['Anyeli Ruiz', '809-750-3756'],
  ['Ani Leisi', '829-460-3051'],
  ['Eneroliza', '829-856-9365'],
  ['Amarilis', '809-391-6368'],
  ['Andreisy', '809-843-3832'],
  ['Angélica', '809-664-6310'],
  ['Yajaira', '829-321-1283'],
  ['Chavelis', '849-439-8553'],
  ['Bernarda', '829-670-0804'],
  ['Rosa', '829-491-3834'],
  ['Rafael Areche', '809-790-3806'],
  ['Patricio', '809-834-0908'],
  ['Nicauris', '829-766-3754'],
  ['Nelly', '829-784-4431'],
  ['Cliente PHYTOEMAGRY MC', '809-769-3155'],
  ['Pastilla (nombre pendiente)', '849-247-3063'],
  ['Cliente PHYTOEMAGRY 021', '829-228-8005'],
  ['Yeira', '849-438-5650'],
  ['Juana', '829-368-1942'],
  ['Laura', '829-705-9045'],
  ['Noemí', '849-507-3819'],
  ['Stefanie', '386-318-6375'],
  ['Lisa', '809-678-2906'],
  ['Cliente PHYTOEMAGRY 027', '829-986-6761'],
  ['Cliente PHYTOEMAGRY 028', '849-475-1238'],
  ['Cliente PHYTOEMAGRY 029', '809-495-4012'],
  ['Massiel', '809-235-5610'],
  ['Lic. Esterlina Perozo', '809-673-8255'],
  ['Yahaira Lizandry', '809-855-6095'],
  ['Dania', '829-350-2403'],
].map(([name, phone]) => ({ name, phone, phone_e164: toE164(phone) }));

function usage() {
  return `Uso:
  node scripts/import-historical-whatsapp-contacts.mjs --csv <archivo.csv> [--dry-run]
  node scripts/import-historical-whatsapp-contacts.mjs --csv <archivo.csv> --apply

Opciones:
  --csv <ruta>       CSV PHYTOEMAGRY_clientes_acumulado_lotes_01_05.csv
  --data <ruta>      SQLite/JSONL local (por defecto PHYTO_CRM_DATA o data/phytoemagry.sqlite)
  --database-url     PostgreSQL (por defecto PHYTO_CRM_DATABASE_URL)
  --apply            Escribe clientes/actualizaciones. Sin esto solo simula.
  --json             Imprime el reporte en JSON.
`;
}

function argsOf(argv) {
  const args = { apply: false, json: false, csv: '', data: '', databaseUrl: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--json') args.json = true;
    else if (arg === '--csv') args.csv = argv[++i] ?? '';
    else if (arg === '--data') args.data = argv[++i] ?? '';
    else if (arg === '--database-url') args.databaseUrl = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`opción desconocida: ${arg}`);
    }
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [headers, ...body] = rows.filter((entry) => entry.some((value) => String(value).trim()));
  if (!headers) return [];
  return body.map((values) => {
    const out = {};
    headers.forEach((header, index) => {
      out[String(header).trim()] = String(values[index] ?? '').trim();
    });
    return out;
  });
}

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function first(row, names) {
  const normalized = new Map(Object.keys(row).map((key) => [fold(key), key]));
  for (const name of names) {
    const key = normalized.get(fold(name));
    if (key && row[key]) return row[key];
  }
  return '';
}

function inferStatus(row, phone) {
  const explicit = fold(first(row, ['clasificacion', 'clasificación', 'estado comercial', 'estado', 'compra', 'status']));
  if (NO_BUY_PHONES.has(phone)) return 'NO_COMPRO';
  if (explicit.includes('no compro') || explicit.includes('no compra')) return 'NO_COMPRO';
  if (explicit.includes(fold(BUYER_MARK)) || (explicit.includes('compro') && !explicit.includes('no compro'))) return 'COMPRO_REPORTADO';
  if (explicit.includes('interes')) return 'INTERESADO';
  if (explicit.includes('verificar') || explicit.includes('pendiente')) return 'POR_VERIFICAR';
  return 'POR_VERIFICAR';
}

function genericName(value = '') {
  const clean = fold(value);
  return /^cliente phytoemagry/.test(clean) || clean.includes('nombre pendiente') || clean === 'pastilla';
}

function observationOf(row) {
  const parts = [
    first(row, ['observaciones', 'observacion', 'observación', 'observaciones / evidencia', 'notas', 'nota']),
    first(row, ['evidencia', 'evidencias']),
  ].filter(Boolean);
  return [...new Set(parts)].join(' | ');
}

function appendNote(existing, addition) {
  const clean = String(addition ?? '').trim();
  if (!clean) return existing ?? null;
  const current = String(existing ?? '').trim();
  if (current.includes(clean)) return current || null;
  return current ? `${current}\n\n${clean}` : clean;
}

function newCustomerId() {
  return `cus_${randomBytes(8).toString('hex')}`;
}

function short(value, max = 200) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

async function createHistoricalCustomer(db, contact, importDoc, importNote) {
  const now = new Date().toISOString();
  const doc = {
    id: newCustomerId(),
    name: short(contact.name, 120),
    phone: short(contact.phone || contact.phone_e164, 40),
    phone_e164: contact.phone_e164,
    email: null,
    location: null,
    source: IMPORT_SOURCE,
    acquisition_source: IMPORT_SOURCE,
    created_at: now,
    updated_at: now,
    whatsapp_opt_in: false,
    whatsapp_opt_in_at: null,
    whatsapp_opt_out_at: null,
    do_not_contact: false,
    automation_state: 'AUTOMATIC',
    notes: appendNote(null, importNote),
    last_contact_at: null,
    next_followup_at: null,
    last_purchase_at: null,
    total_purchases: 0,
    total_spent: 0,
    customer_stage_manual: null,
    historicalWhatsAppImport: importDoc,
    ...(contact.status === 'INTERESADO' ? { commercial_state_manual: 'INTERESADO' } : {}),
  };
  const inserted = await db.insert('customers', doc);
  if (!inserted.duplicate) return doc;
  return db.findBy('customers', 'phone_e164', contact.phone_e164);
}

function buildImportDoc(contact, existing) {
  const previous = existing?.historicalWhatsAppImport ?? null;
  return {
    source: IMPORT_SOURCE,
    imported_at: previous?.imported_at ?? new Date().toISOString(),
    status: contact.status,
    status_label: STATUS_LABELS[contact.status],
    purchase_pending_verification: contact.status === 'COMPRO_REPORTADO',
    original_name: contact.name,
    original_phone: contact.phone,
    normalized_phone: contact.phone_e164,
    csv_state: contact.csvState || null,
    observations: contact.observations || null,
  };
}

function contactFromRow(row) {
  const phoneRaw = first(row, ['whatsapp internacional', 'telefono', 'teléfono', 'teléfono rd', 'phone', 'celular', 'whatsapp']);
  const phone_e164 = toE164(phoneRaw);
  const fallback = REFERENCE.find((entry) => phone_e164 && phone_e164 === entry.phone_e164);
  const name = first(row, ['nombre de cliente', 'nombre', 'name', 'cliente']) || fallback?.name || '';
  const csvState = first(row, ['clasificacion', 'clasificación', 'estado comercial', 'estado', 'compra', 'status']);
  return {
    raw: row,
    name,
    phone: phoneRaw || fallback?.phone || '',
    phone_e164,
    csvState,
    status: inferStatus(row, phone_e164),
    observations: observationOf(row),
  };
}

function validate(contacts) {
  const errors = [];
  if (contacts.length !== EXPECTED_COUNT) errors.push(`el CSV tiene ${contacts.length} filas; se esperaban ${EXPECTED_COUNT}`);
  const phones = new Map();
  for (const contact of contacts) {
    if (!contact.phone_e164) errors.push(`teléfono inválido: ${contact.name || JSON.stringify(contact.raw)}`);
    phones.set(contact.phone_e164, (phones.get(contact.phone_e164) ?? 0) + 1);
    if (!STATUS_VALUES.includes(contact.status)) errors.push(`estado inválido para ${contact.phone_e164}: ${contact.status}`);
  }
  const duplicates = [...phones.entries()].filter(([phone, count]) => phone && count > 1);
  for (const [phone, count] of duplicates) errors.push(`teléfono duplicado en CSV: ${phone} (${count} filas)`);
  const missingReference = REFERENCE.filter((ref) => !phones.has(ref.phone_e164));
  for (const ref of missingReference) errors.push(`falta teléfono de referencia: ${ref.name} ${ref.phone_e164}`);
  const counts = contacts.reduce((acc, contact) => {
    acc[contact.status] = (acc[contact.status] ?? 0) + 1;
    return acc;
  }, {});
  if ((counts.COMPRO_REPORTADO ?? 0) !== 16) errors.push(`compradores reportados: ${counts.COMPRO_REPORTADO ?? 0}; se esperaban 16`);
  if ((counts.NO_COMPRO ?? 0) !== 2) errors.push(`no compradores: ${counts.NO_COMPRO ?? 0}; se esperaban 2`);
  if (((counts.INTERESADO ?? 0) + (counts.POR_VERIFICAR ?? 0)) !== 16) {
    errors.push(`interesados/por verificar: ${(counts.INTERESADO ?? 0) + (counts.POR_VERIFICAR ?? 0)}; se esperaban 16`);
  }
  return { errors, counts };
}

async function main() {
  const args = argsOf(process.argv);
  if (!args.csv) throw new Error('falta --csv <archivo>');
  const csvPath = path.resolve(args.csv);
  if (!existsSync(csvPath)) throw new Error(`no existe el CSV: ${csvPath}`);

  const contacts = parseCsv(readFileSync(csvPath, 'utf8')).map(contactFromRow);
  const validation = validate(contacts);
  const dataFile = path.resolve(args.data || process.env.PHYTO_CRM_DATA || path.join('data', 'phytoemagry.sqlite'));
  const databaseUrl = args.databaseUrl || process.env.PHYTO_CRM_DATABASE_URL || '';
  const store = await createStore({ databaseUrl, dataFile });
  const db = await createCollections({
    backend: store.kind === 'postgres' ? 'postgres' : store.kind === 'sqlite' ? 'sqlite' : 'jsonl',
    handle: store.handle ?? null,
    dir: path.dirname(dataFile),
    prefix: 'phytoemagry_',
  });
  const customers = createCustomerService({ db, store });
  const allOrders = store.listAdmin ? await store.listAdmin({ limit: 5000 }) : [];

  const operations = [];
  let found = 0;
  let toCreate = 0;
  let toUpdate = 0;
  let realPurchaseConflicts = 0;

  for (const contact of contacts) {
    const existing = contact.phone_e164 ? await customers.findByPhone(contact.phone_e164) : null;
    const customerOrders = existing ? allOrders.filter((row) => row.customer_id === existing.id && row.type === 'order_intent') : [];
    const delivered = customerOrders.filter((row) => row.status === 'entregado');
    const importDoc = buildImportDoc(contact, existing);
    const importNote = [IMPORT_SOURCE, STATUS_LABELS[contact.status], contact.observations].filter(Boolean).join(' — ');
    const patch = {};
    if (existing) {
      found += 1;
      if (!existing.name && contact.name) patch.name = contact.name;
      if (existing.name && contact.name && genericName(existing.name) && !genericName(contact.name)) patch.name = contact.name;
      if (!existing.source) patch.source = IMPORT_SOURCE;
      if (existing.source && !String(existing.source).includes('Importación histórica')) patch.acquisition_source = IMPORT_SOURCE;
      if (JSON.stringify(existing.historicalWhatsAppImport ?? null) !== JSON.stringify(importDoc)) patch.historicalWhatsAppImport = importDoc;
      const nextNotes = appendNote(existing.notes, importNote);
      if (nextNotes !== (existing.notes ?? null)) patch.notes = nextNotes;
      if (contact.status === 'INTERESADO' && !existing.commercial_state_manual && delivered.length === 0 && customerOrders.length === 0) {
        patch.commercial_state_manual = 'INTERESADO';
      }
      if (Object.keys(patch).length) toUpdate += 1;
      if (delivered.length > 0 && contact.status !== 'COMPRO_REPORTADO') realPurchaseConflicts += 1;
      operations.push({
        action: Object.keys(patch).length ? 'update' : 'noop',
        phone: contact.phone_e164,
        name: existing.name || contact.name,
        csvName: contact.name,
        status: contact.status,
        statusLabel: STATUS_LABELS[contact.status],
        existingCustomerId: existing.id,
        deliveredPurchases: delivered.length,
        openOrders: customerOrders.length - delivered.length,
        patchFields: Object.keys(patch),
      });
      if (args.apply && Object.keys(patch).length) await customers.update(existing.id, patch);
      continue;
    }
    toCreate += 1;
    operations.push({
      action: 'create',
      phone: contact.phone_e164,
      name: contact.name,
      status: contact.status,
      statusLabel: STATUS_LABELS[contact.status],
      existingCustomerId: null,
      deliveredPurchases: 0,
      openOrders: 0,
      patchFields: ['customer', 'historicalWhatsAppImport', 'notes'],
    });
    if (args.apply) {
      await createHistoricalCustomer(db, contact, importDoc, importNote);
    }
  }

  const uniquePhones = new Set(contacts.map((row) => row.phone_e164).filter(Boolean)).size;
  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    csv: csvPath,
    storage: { kind: store.kind, file: store.file ?? dataFile },
    validation,
    summary: {
      totalRows: contacts.length,
      uniquePhones,
      found,
      toCreate,
      toUpdate,
      noop: operations.filter((row) => row.action === 'noop').length,
      duplicateRowsAvoided: contacts.length - uniquePhones,
      realPurchaseConflicts,
      byStatus: validation.counts,
    },
    operations,
    goNoGo: validation.errors.length === 0 ? 'GO para dry-run; NO-GO para escritura hasta autorización expresa' : 'NO-GO',
    safeguards: [
      'No crea pedidos, pagos, facturas ni mensajes.',
      'No crea conversaciones vacías ni borra clientes, conversaciones o historial.',
      'La clave idempotente operativa es phone_e164 dentro de customers.',
      'COMPRÓ se guarda como compra reportada pendiente de verificación, no como venta real.',
    ],
  };

  await store.close?.();
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Modo: ${report.mode}`);
  console.log(`CSV: ${report.csv}`);
  console.log(`Almacén: ${report.storage.kind} ${report.storage.file ?? ''}`);
  console.log(`Filas: ${report.summary.totalRows}; teléfonos únicos: ${report.summary.uniquePhones}`);
  console.log(`Existentes: ${found}; crear: ${toCreate}; actualizar: ${toUpdate}; sin cambios: ${report.summary.noop}`);
  console.log(`Estados: ${JSON.stringify(report.summary.byStatus)}`);
  if (validation.errors.length) {
    console.log('Errores:');
    for (const error of validation.errors) console.log(`- ${error}`);
  }
  console.table(operations.map(({ action, phone, name, status, deliveredPurchases, openOrders, patchFields }) => ({
    action,
    phone,
    name,
    status,
    deliveredPurchases,
    openOrders,
    patchFields: patchFields.join(','),
  })));
  console.log(`GO/NO-GO: ${report.goNoGo}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
