/**
 * DATOS DE PRUEBA DE REPARTIDORES (solo entorno local).
 *
 * Qué crea, y por qué así:
 *   · 10 cuentas de reparto (`courier_accounts`): 3 INTERNAS ligadas a los
 *     usuarios AGENT que ya existen y 7 EXTERNAS, con sus concesiones de empresa
 *     (`courier_company_grants`) para poder probar el caso multiempresa.
 *   · 6 solicitudes de ingreso (`courier_applications`) con TODOS los estados que
 *     pinta el panel: pendiente, requiere información, aprobada y rechazada.
 *
 * Escribe el MISMO formato que el servidor (documento completo en `doc` y las
 * columnas indexadas aparte, con los booleanos en 0/1), así que todo se lee
 * exactamente igual que si se hubiera dado de alta desde el panel.
 *
 * Es IDEMPOTENTE: antes de insertar borra lo suyo (`demo_*`). No toca ninguna
 * fila real.
 *
 * Uso:  node --experimental-sqlite scripts/seed-couriers-demo.mjs [--clean]
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashCourierCredential } from '../server/courier-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.PHYTO_DB_FILE || path.join(root, 'data', 'phytoemagry.sqlite');
const prefix = 'phytoemagry_';
const onlyClean = process.argv.includes('--clean');

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');

const now = new Date().toISOString();
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

/** El PIN de todas las cuentas de prueba: sirve para entrar en la app del reparto. */
const DEMO_PIN = 'reparto123';
const { hash } = await hashCourierCredential(DEMO_PIN);

const accounts = [
  // --- Internas: usan un usuario AGENT que ya existe en el CRM ---
  { id: 'demo_courier_01', kind: 'INTERNAL', name: 'Luis Manuel Peña', phone: '+18095550101',
    userId: 'usr_29662bdd88327528e412ff31', company: 'phytoemagry', active: true, access: true, login: daysAgo(0.2) },
  { id: 'demo_courier_02', kind: 'INTERNAL', name: 'Yordani Ramírez', phone: '+18095550102',
    userId: 'usr_5d6b8b3c2baebbdd6d1ea286', company: 'phytoemagry', active: true, access: true, login: daysAgo(1) },
  { id: 'demo_courier_03', kind: 'INTERNAL', name: 'Wascar Jiménez', phone: '+18095550103',
    userId: 'usr_063b8a2c739e4bfce5a46858', company: 'phytoemagry', active: false, access: false, login: null },
  // --- Externas: mensajeros sin cuenta en el CRM (contacto guardado) ---
  { id: 'demo_courier_04', kind: 'EXTERNAL', name: 'Carlos Batista', phone: '+18095550104', company: 'phytoemagry', active: true, access: true, login: daysAgo(2) },
  { id: 'demo_courier_05', kind: 'EXTERNAL', name: 'Ramón Estévez', phone: '+18095550105', company: 'phytoemagry', active: true, access: true, login: daysAgo(0.5) },
  { id: 'demo_courier_06', kind: 'EXTERNAL', name: 'José Alberto Núñez', phone: '+18095550106', company: 'phytoemagry', active: true, access: false, login: null },
  { id: 'demo_courier_07', kind: 'EXTERNAL', name: 'Franklin De los Santos', phone: '+18095550107', company: 'fulltech', active: true, access: true, login: daysAgo(3) },
  { id: 'demo_courier_08', kind: 'EXTERNAL', name: 'Manuel Antonio Cruz', phone: '+18095550108', company: 'fulltech', active: true, access: true, login: daysAgo(4) },
  { id: 'demo_courier_09', kind: 'EXTERNAL', name: 'Eddy Santana', phone: '+18095550109', company: 'fulltech', active: false, access: false, login: null },
  { id: 'demo_courier_10', kind: 'EXTERNAL', name: 'Yeison Merán', phone: '+18095550110', company: 'phytoemagry', active: true, access: true, login: daysAgo(6) },
];

/** Quién opera más de una empresa (para probar el caso multiempresa del panel). */
const extraGrants = [
  { id: 'demo_courier_02', company: 'fulltech' },
  { id: 'demo_courier_04', company: 'fulltech' },
  { id: 'demo_courier_10', company: 'fulltech' },
];

const applications = [
  { id: 'app_demo_01', name: 'Jhairon Polanco', phone: '+18095550201', company: 'phytoemagry',
    vehicle: 'MOTO', zone: 'Distrito Nacional', status: 'pending', created: daysAgo(0.3) },
  { id: 'app_demo_02', name: 'Rafaelito Ortiz', phone: '+18095550202', company: 'phytoemagry',
    vehicle: 'CARRO', zone: 'Santo Domingo Este', status: 'pending', created: daysAgo(1.2) },
  { id: 'app_demo_03', name: 'Kelvin Rosario', phone: '+18095550203', company: 'fulltech',
    vehicle: 'MOTO', zone: 'Santiago de los Caballeros', status: 'pending', created: daysAgo(2.4) },
  { id: 'app_demo_04', name: 'Darwin Castillo', phone: '+18095550204', company: 'phytoemagry',
    vehicle: 'BICICLETA', zone: 'Distrito Nacional', status: 'info_required', created: daysAgo(4),
    note: 'Falta la foto de la licencia y el número de contacto de emergencia.' },
  { id: 'app_demo_05', name: 'Alexander Beltré', phone: '+18095550205', company: 'fulltech',
    vehicle: 'MOTO', zone: 'San Pedro de Macorís', status: 'approved', created: daysAgo(9) },
  { id: 'app_demo_06', name: 'Wilkin Santos', phone: '+18095550206', company: 'phytoemagry',
    vehicle: 'A_PIE', zone: 'La Vega', status: 'rejected', created: daysAgo(12),
    note: 'Sin vehículo propio para la zona solicitada.' },
];

db.exec(`
  CREATE TABLE IF NOT EXISTS ${prefix}courier_company_grants (
    id TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    courier_account_id TEXT,
    company_id TEXT,
    active TEXT,
    updated_at TEXT
  )`);

// --- Limpieza de lo anterior (solo lo suyo) ---
for (const table of ['courier_accounts', 'courier_applications', 'courier_company_grants']) {
  db.exec(`DELETE FROM ${prefix}${table} WHERE id LIKE 'demo_%' OR id LIKE 'app_demo_%'`);
}
console.log('· filas demo anteriores borradas');
if (onlyClean) {
  console.log('Listo (solo limpieza).');
  process.exit(0);
}

// --- Cuentas de reparto ---
const insertAccount = db.prepare(
  `INSERT OR REPLACE INTO ${prefix}courier_accounts
   (id, doc, phone_e164, user_id, contact_id, active, app_access, company_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const row of accounts) {
  const doc = {
    id: row.id,
    kind: row.kind,
    phone_e164: row.phone,
    display_name: row.name,
    user_id: row.kind === 'INTERNAL' ? row.userId : null,
    contact_id: row.kind === 'EXTERNAL' ? `demo_contact_${row.id}` : null,
    active: row.active,
    app_access: row.access,
    company_id: row.company,
    credential_hash: hash,
    token_epoch: 0,
    failed_attempts: 0,
    locked_until: null,
    last_login_at: row.login,
    created_at: daysAgo(30 + accounts.indexOf(row)),
    updated_at: now,
    created_by_user_id: 'usr_ba9fdb103d80a9d2cb766fc5',
    created_by_display_name: 'Ana Admin',
    demo: true,
  };
  insertAccount.run(doc.id, JSON.stringify(doc), doc.phone_e164, doc.user_id, doc.contact_id,
    Number(doc.active), Number(doc.app_access), doc.company_id, doc.created_at);
}
console.log(`· ${accounts.length} cuentas de reparto`);

// --- Concesiones de empresa (la propia + las extra) ---
const insertGrant = db.prepare(
  `INSERT OR REPLACE INTO ${prefix}courier_company_grants
   (id, doc, courier_account_id, company_id, active, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
const grants = [
  ...accounts.map((row) => ({ id: row.id, company: row.company, active: row.active })),
  ...extraGrants.map((row) => ({ ...row, active: true })),
];
for (const grant of grants) {
  const id = `${grant.id}:${grant.company}`;
  const doc = {
    id,
    courier_account_id: grant.id,
    company_id: grant.company,
    active: grant.active,
    updated_at: now,
    updated_by_user_id: 'usr_ba9fdb103d80a9d2cb766fc5',
    demo: true,
  };
  insertGrant.run(id, JSON.stringify(doc), grant.id, grant.company, Number(grant.active), now);
}
console.log(`· ${grants.length} concesiones de empresa`);

// --- Solicitudes de ingreso ---
const insertApplication = db.prepare(
  `INSERT OR REPLACE INTO ${prefix}courier_applications
   (id, doc, company_id, phone_e164, status, application_key, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
for (const row of applications) {
  const doc = {
    id: row.id,
    application_key: `demo-${row.id}`,
    company_id: row.company,
    phone_e164: row.phone,
    display_name: row.name,
    vehicle_type: row.vehicle,
    zone: row.zone,
    terms_accepted_at: row.created,
    status: row.status,
    receipt: row.id.replace('app_demo_', '').padEnd(12, '0'),
    review_note: row.note ?? null,
    reviewed_at: row.status === 'pending' ? null : daysAgo(1),
    reviewed_by_user_id: row.status === 'pending' ? null : 'usr_ba9fdb103d80a9d2cb766fc5',
    created_at: row.created,
    updated_at: now,
    demo: true,
  };
  insertApplication.run(doc.id, JSON.stringify(doc), doc.company_id, doc.phone_e164, doc.status,
    doc.application_key, doc.created_at);
}
console.log(`· ${applications.length} solicitudes de ingreso`);
console.log(`\nListo. PIN de las cuentas de prueba: ${DEMO_PIN}`);
db.close();
