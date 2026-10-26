import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createSqlQuery } from './sql-query.mjs';
import { parseProductImage } from './store-catalog.mjs';
import { orderOf } from './orders.mjs';
import { moneyToCents } from './inventory.mjs';
import { normalizeDnPhone } from './store-verifications.mjs';

const scryptAsync = promisify(scrypt);
const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const emailKey = (value) => String(value ?? '').trim().toLowerCase();
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const tokenHash = (value) => createHash('sha256').update(String(value)).digest('hex');
const safeJson = (value, fallback = {}) => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
};
const normProof = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/*
 * Nombre de respaldo cuando el proveedor no lo envía (p. ej. un token sin
 * `name`): se usa la parte local del correo, nunca se inventa un nombre.
 */
const nameFromEmail = (value) => {
  const local = String(value ?? '').split('@')[0].replace(/[._-]+/g, ' ').trim().slice(0, 120);
  return local.length >= 2 ? local : 'Cliente';
};
const normTitle = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/*
 * Mensaje ÚNICO para un alta que no se puede completar: no confirma si el
 * teléfono ya existe ni a qué cuenta pertenece (evita enumerar cuentas).
 */
const GENERIC_EXISTS = 'No pudimos crear la cuenta con esos datos. Si ya tienes una, inicia sesión o recupera tu acceso.';

export const STORE_REQUEST_STATUSES = ['nuevo', 'en_revision', 'cotizado', 'aprobado', 'anticipo_pendiente', 'en_proceso', 'completado', 'rechazado', 'cancelado'];

/**
 * Cuentas de cliente de FULLTECH Store.
 *
 * - La identidad fuerte sigue siendo el TELÉFONO del CRM (E.164): una cuenta
 *   solo se vincula a un cliente existente con prueba de propiedad (número de
 *   pedido). Así nadie puede apropiarse del historial de otra persona.
 * - Las sesiones son propias (`ft_store_session`) y no comparten cookie ni
 *   permisos con el panel administrativo.
 * - Todo es aditivo: tablas nuevas, sin tocar pedidos, facturas ni inventario.
 */
export async function createStoreAccounts({ backend, handle, customers, listOrders, findCustomerByEmail, clock = () => new Date() }) {
  const sql = createSqlQuery({ backend, handle });
  if (!sql.enabled || !customers) return null;

  await sql.query(`
    CREATE TABLE IF NOT EXISTS fulltech_customer_accounts_v1 (
      id TEXT PRIMARY KEY,
      customer_id TEXT UNIQUE,
      phone_e164 TEXT UNIQUE,
      email TEXT,
      email_key TEXT UNIQUE,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      apple_sub TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      profile TEXT NOT NULL DEFAULT '{}',
      preferences TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulltech_customer_sessions_v1 (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT);
    CREATE INDEX IF NOT EXISTS fulltech_customer_sessions_account_idx ON fulltech_customer_sessions_v1(account_id);
    CREATE TABLE IF NOT EXISTS fulltech_customer_favorites_v1 (
      account_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(account_id, product_id));
    CREATE TABLE IF NOT EXISTS fulltech_store_requests_v1 (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      account_id TEXT,
      request_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      title_key TEXT NOT NULL,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fulltech_store_requests_customer_idx ON fulltech_store_requests_v1(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS fulltech_store_requests_status_idx ON fulltech_store_requests_v1(status, created_at);
    CREATE TABLE IF NOT EXISTS fulltech_store_request_images_v1 (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      mime TEXT NOT NULL,
      data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fulltech_store_request_images_request_idx ON fulltech_store_request_images_v1(request_id, position);
    CREATE TABLE IF NOT EXISTS fulltech_customer_account_links_v1 (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider TEXT,
      sub TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL)`);

  /*
   * COLUMNAS NUEVAS, ADITIVAS: el enlace que se guarda al entrar con Google
   * necesita recordar QUÉ identidad va a enlazarse (`provider` + `sub`).
   * El error de «ya existe» se ignora para que el mismo código sirva en SQLite
   * y en Postgres y una base ya creada se actualice sin tocar una sola fila.
   */
  for (const column of ['provider TEXT', 'sub TEXT']) {
    try {
      await sql.query(`ALTER TABLE fulltech_customer_account_links_v1 ADD COLUMN ${column}`);
    } catch {
      /* la columna ya existe en esta base */
    }
  }

  async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const derived = await scryptAsync(password, salt, 64);
    return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
  }

  async function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = Buffer.from(await scryptAsync(password, salt, 64));
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  const accountFromRow = (row) =>
    row
      ? {
          id: row.id,
          customer_id: row.customer_id ?? null,
          phone_e164: row.phone_e164 ?? null,
          email: row.email ?? null,
          has_password: Boolean(row.password_hash),
          google: Boolean(row.google_sub),
          apple: Boolean(row.apple_sub),
          status: row.status,
          profile: safeJson(row.profile),
          preferences: safeJson(row.preferences),
          created_at: row.created_at,
          updated_at: row.updated_at,
        }
      : null;

  const accountBy = async (column, value) => {
    if (value === null || value === undefined || value === '') return null;
    return accountFromRow((await sql.query(`SELECT * FROM fulltech_customer_accounts_v1 WHERE ${column}=$1 LIMIT 1`, [value])).rows[0]);
  };

  function publicAccount(account, customer) {
    const profile = account?.profile && typeof account.profile === 'string' ? safeJson(account.profile) : account?.profile ?? {};
    const preferences = account?.preferences && typeof account.preferences === 'string' ? safeJson(account.preferences) : account?.preferences ?? {};
    return {
      id: account.id,
      status: account.status,
      phone: account.phone_e164,
      email: account.email,
      name: customer?.name ?? profile.name ?? '',
      city: profile.city ?? customer?.location ?? '',
      onboarding: profile.onboarding ?? null,
      providers: { password: account.has_password, google: account.google, apple: account.apple },
      preferences: {
        contact: preferences.contact ?? 'whatsapp',
        marketing: preferences.marketing === true,
        language: preferences.language ?? 'es',
      },
      created_at: account.created_at,
    };
  }

  async function createSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date(clock());
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await sql.query('DELETE FROM fulltech_customer_sessions_v1 WHERE expires_at<$1 OR revoked_at IS NOT NULL', [now.toISOString()]);
    await sql.query('INSERT INTO fulltech_customer_sessions_v1(token_hash,account_id,created_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$5)', [
      tokenHash(token), accountId, now.toISOString(), expires.toISOString(), now.toISOString(),
    ]);
    return { token, expiresAt: expires.toISOString() };
  }

  async function session(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    const row = (await sql.query('SELECT * FROM fulltech_customer_sessions_v1 WHERE token_hash=$1', [hash])).rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= clock().getTime()) return null;
    const account = await accountBy('id', row.account_id);
    if (!account || account.status !== 'active') return null;
    await sql.query('UPDATE fulltech_customer_sessions_v1 SET last_seen_at=$1 WHERE token_hash=$2', [clock().toISOString(), hash]);
    const customer = account.customer_id ? await customers.get(account.customer_id) : null;
    return { account, customer, tokenHash: hash };
  }

  async function revokeSession(hash) {
    if (!hash) return;
    await sql.query('UPDATE fulltech_customer_sessions_v1 SET revoked_at=$1 WHERE token_hash=$2', [clock().toISOString(), hash]);
  }

  async function orderMatchesCustomer(customerId, proof) {
    const target = normProof(proof);
    if (!target || typeof listOrders !== 'function') return false;
    const rows = await listOrders();
    return rows.some(
      (row) =>
        row?.type === 'order_intent' &&
        row.customer_id === customerId && orderOf(row)?.origin === 'FULLTECH_STORE' &&
        [row.order_number, row.id, row.reference, row.payment_reference].some((value) => normProof(value) === target),
    );
  }

  async function assertEmailAvailable(email, accountId = null) {
    if (!email) return null;
    const key = emailKey(email);
    const found = (await sql.query('SELECT id FROM fulltech_customer_accounts_v1 WHERE email_key=$1', [key])).rows[0];
    if (found && found.id !== accountId) throw fail('email_in_use', 'Ese correo ya está asociado a otra cuenta.', 409);
    return key;
  }

  async function register(input = {}) {
    const name = clean(input.name, 120);
    const phone = customers.normalizePhone(input.phone);
    const password = String(input.password ?? '');
    if (name.length < 2) throw fail('invalid_name', 'Escribe tu nombre.');
    if (!phone && clean(input.phone)) throw fail('invalid_phone', 'Escribe un teléfono válido.');
    if (password.length < 8 || password.length > 200) throw fail('invalid_password', 'La contraseña debe tener al menos 8 caracteres.');
    const email = clean(input.email, 160);
    if (email && !isEmail(email)) throw fail('invalid_email', 'Escribe un correo válido.');
    const key = await assertEmailAvailable(email);

    // Email-only accounts have no CRM identity until contact ownership is resolved.
    if (!phone) {
      if (!email) throw fail('invalid_email', 'Escribe tu correo electrónico.');
      const id = `acc_${randomUUID()}`, now = clock().toISOString();
      await sql.query('INSERT INTO fulltech_customer_accounts_v1(id,customer_id,phone_e164,email,email_key,password_hash,google_sub,apple_sub,status,profile,preferences,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [id,null,null,email,key,await hashPassword(password),null,null,'active',JSON.stringify({name,email,onboarding:'pending'}),JSON.stringify({contact:'whatsapp',marketing:false,language:'es'}),now,now]);
      return {account:publicAccount(await accountBy('id',id),null),customer:null};
    }

    if (await accountBy('phone_e164', phone)) throw fail('account_exists', GENERIC_EXISTS, 409);

    const existing = await customers.findByPhone(phone);
    let customer = existing;
    if (existing) {
      if (await accountBy('customer_id', existing.id)) throw fail('account_exists', GENERIC_EXISTS, 409);
      /*
       * Vincular una cuenta a un cliente que ya está en el CRM exige prueba de
       * propiedad. Sin ella, cualquiera que conozca un teléfono podría ver su
       * historial. El número de pedido es una prueba que el cliente ya tiene.
       */
      if (!(await orderMatchesCustomer(existing.id, input.orderNumber))) {
        throw fail('verification_required', 'Ese teléfono ya tiene historial. Escribe el número de uno de tus pedidos para vincular la cuenta.', 403);
      }
    } else {
      const created = await customers.findOrCreateByPhone({ phone, name, source: 'tienda' });
      if (!created.ok) throw fail(created.error ?? 'invalid_phone', 'No pudimos crear tu cuenta con ese teléfono.');
      customer = created.customer;
    }

    const now = clock().toISOString();
    const account = {
      id: `acc_${randomUUID()}`, customer_id: customer.id, phone_e164: phone,
      email: email || null, email_key: key, password_hash: await hashPassword(password),
      google_sub: null, apple_sub: null, status: 'active',
      profile: JSON.stringify({ name, email: email || null, onboarding: 'pending' }),
      preferences: JSON.stringify({ contact: input.preferences?.contact === 'phone' ? 'phone' : 'whatsapp', marketing: input.preferences?.marketing === true, language: 'es' }),
      created_at: now, updated_at: now,
    };
    try {
      await sql.query(
        'INSERT INTO fulltech_customer_accounts_v1(id,customer_id,phone_e164,email,email_key,password_hash,google_sub,apple_sub,status,profile,preferences,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [account.id, account.customer_id, account.phone_e164, account.email, account.email_key, account.password_hash, null, null, account.status, account.profile, account.preferences, account.created_at, account.updated_at],
      );
    } catch (error) {
      if (['23505', 'SQLITE_CONSTRAINT_UNIQUE'].includes(error.code) || /UNIQUE constraint failed/i.test(error.message ?? '')) {
        throw fail('account_exists', 'Ya existe una cuenta con esos datos. Inicia sesión.', 409);
      }
      throw error;
    }
    if (email && !customer.email) await customers.update(customer.id, { email });
    const stored = accountFromRow((await sql.query('SELECT * FROM fulltech_customer_accounts_v1 WHERE id=$1', [account.id])).rows[0]);
    return { account: publicAccount(stored, await customers.get(customer.id)), customer };
  }

  async function login(input = {}) {
    const identifier = clean(input.identifier, 160);
    const password = String(input.password ?? '');
    if (!identifier || !password) throw fail('invalid_credentials', 'Escribe tu teléfono o correo y tu contraseña.', 401);
    const phone = customers.normalizePhone(identifier);
    const account = phone ? await accountBy('phone_e164', phone) : await accountBy('email_key', emailKey(identifier));
    if (!account) throw fail('invalid_credentials', 'El teléfono o la contraseña no coinciden.', 401);
    if (!account.has_password) throw fail('password_not_set', 'Esta cuenta usa Google o Apple. Entra con ese método.', 409);
    const row = (await sql.query('SELECT password_hash FROM fulltech_customer_accounts_v1 WHERE id=$1', [account.id])).rows[0];
    if (!(await verifyPassword(password, row?.password_hash))) throw fail('invalid_credentials', 'El teléfono o la contraseña no coinciden.', 401);
    if (account.status !== 'active') throw fail('account_inactive', 'Esta cuenta está pendiente de verificación.', 403);
    const customer = account.customer_id ? await customers.get(account.customer_id) : null;
    return { account: publicAccount(account, customer), customer };
  }

  /** Contraseña nueva tras una recuperación verificada. Cierra las sesiones. */  async function setPassword(accountId, password) {
    const value = String(password ?? '');
    if (value.length < 8 || value.length > 200) throw fail('invalid_password', 'La contraseña debe tener al menos 8 caracteres.');
    const row = (await sql.query('SELECT id FROM fulltech_customer_accounts_v1 WHERE id=$1', [accountId])).rows[0];
    if (!row) throw fail('not_found', 'La cuenta ya no existe.', 404);
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET password_hash=$1, status=$2, updated_at=$3 WHERE id=$4', [await hashPassword(value), 'active', now, accountId]);
    /*
     * Una contraseña nueva invalida lo anterior: si alguien tenía una sesión
     * abierta con el acceso robado, deja de servir.
     */
    await sql.query('UPDATE fulltech_customer_sessions_v1 SET revoked_at=$1 WHERE account_id=$2 AND revoked_at IS NULL', [now, accountId]);
    return { ok: true };
  }

  /**
   * GUARDA EL TELÉFONO EN LA CUENTA — estado NO verificado.
   *
   * La Fase 1 no verifica por SMS: el número se guarda como dato de contacto y
   * queda marcado como `unverified` (ver `store-verifications.mjs`). Aquí solo
   * se comprueba que no pertenezca ya a otra cuenta de la tienda, para que dos
   * personas no compartan identidad por un número mal escrito.
   */
  async function setPhone(accountId, rawPhone) {
    const account = await accountBy('id', accountId);
    if (!account) throw fail('not_found', 'La cuenta no existe.', 404);
    const e164 = customers.normalizePhone(rawPhone);
    if (!e164) throw fail('invalid_phone', 'Escribe un teléfono válido.');
    const other = (await sql.query('SELECT id FROM fulltech_customer_accounts_v1 WHERE phone_e164=$1 AND id<>$2 LIMIT 1', [e164, accountId])).rows[0];
    if (other) throw fail('phone_in_use', 'Ese número ya está asociado a otra cuenta. Inicia sesión con ella.', 409);
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET phone_e164=$1, updated_at=$2 WHERE id=$3', [e164, now, accountId]);
    if (account.customer_id) {
      const customer = await customers.get(account.customer_id);
      /*
       * El cliente del CRM se actualiza SOLO si el número no pertenece a otro:
       * escribir un teléfono no puede apropiarse de un historial ajeno.
       */
      const clash = await customers.findByPhone(e164);
      if (customer && (!clash || clash.id === customer.id) && customer.phone_e164 !== e164) {
        await customers.update(customer.id, { phone_e164: e164, phone: e164 });
      }
    }
    return { ...account, phone_e164: e164 };
  }

  /**
   * Vincula la cuenta con un cliente del CRM cuando es SEGURO.
   *
   * - Si ya está vinculada, no hace nada.
   * - Si el teléfono no existe en el CRM, se crea el cliente (`source: tienda`).
   * - Si el teléfono YA tiene historial, se exige el número de un pedido: sin esa
   *   prueba no se enlaza y tampoco se enseña nada del historial ajeno.
   */
  async function ensureCustomerForPhone(account, orderNumber) {
    if (!account?.id) return { linked: false, reason: 'no_account' };
    if (account.customer_id) return { linked: true, customer_id: account.customer_id };
    const phone = customers.normalizePhone(account.phone_e164);
    if (!phone) return { linked: false, reason: 'no_phone' };
    const name = clean(account.profile?.name, 120);
    try {
      const customer = await resolveCustomerForAccount(name, phone, orderNumber);
      await sql.query('UPDATE fulltech_customer_accounts_v1 SET customer_id=$1, status=$2, updated_at=$3 WHERE id=$4', [
        customer.id, 'active', clock().toISOString(), account.id,
      ]);
      return { linked: true, customer_id: customer.id };
    } catch (error) {
      if (error?.code === 'verification_required') return { linked: false, reason: 'needs_proof' };
      if (error?.code === 'account_exists') return { linked: false, reason: 'account_exists' };
      throw error;
    }
  }

  async function updateProfile(account, input = {}) {
    const current = account.customer_id ? await customers.get(account.customer_id) : null;
    const patch = {};
    if (input.name !== undefined) {
      const name = clean(input.name, 120);
      if (name.length < 2) throw fail('invalid_name', 'Escribe tu nombre.');
      patch.name = name;
    }
    let accountEmail = account.email;
    let accountEmailKey = account.email ? emailKey(account.email) : null;
    if (input.email !== undefined) {
      const email = clean(input.email, 160);
      if (email && !isEmail(email)) throw fail('invalid_email', 'Escribe un correo válido.');
      accountEmail = email || null;
      accountEmailKey = await assertEmailAvailable(email, account.id);
      patch.email = email || null;
    }
    if (input.preferences !== undefined) {
      const prefs = safeJson(account.preferences);
      if (['whatsapp', 'phone', 'email'].includes(input.preferences?.contact)) prefs.contact = input.preferences.contact;
      if (typeof input.preferences?.marketing === 'boolean') prefs.marketing = input.preferences.marketing;
      account = { ...account, preferences: prefs };
    }
    const profile = { ...safeJson(account.profile), ...(patch.name ? { name: patch.name } : {}), email: accountEmail };
    if (input.city !== undefined) {
      const city = String(input.city ?? '').trim();
      if (city.length > 80 || (city && city.length < 2)) throw fail('invalid_city', 'Escribe una ciudad válida de hasta 80 caracteres.');
      profile.city = city;
    }
    let phone = null;
    if (input.phone !== undefined && String(input.phone).trim()) {
      phone = normalizeDnPhone(input.phone);
      if (!phone.ok) throw fail('invalid_phone', 'Escribe un WhatsApp válido, por ejemplo +1 809 555 1234.');
      const other = await accountBy('phone_e164', phone.e164);
      if (other && other.id !== account.id) throw fail('phone_in_use', 'Ese número ya está asociado a otra cuenta.', 409);
    }
    if (input.onboarding !== undefined) {
      if (!['completed','skipped'].includes(input.onboarding)) throw fail('invalid_onboarding', 'Opción de bienvenida inválida.');
      profile.onboarding = input.onboarding;
    }
    // Validate all fields before updating anything; a failed phone save never completes onboarding.
    if (phone) {
      await setPhone(account.id, phone.e164);
      account = {...account,phone_e164:phone.e164};
      await ensureCustomerForPhone(account);
    }
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET email=$1,email_key=$2,profile=$3,preferences=$4,updated_at=$5 WHERE id=$6', [accountEmail, accountEmailKey, JSON.stringify(profile), JSON.stringify(account.preferences ?? {}), now, account.id]);
    if (current && Object.keys(patch).length) await customers.update(current.id, patch);
    const refreshed = await accountBy('id', account.id);
    return publicAccount(refreshed, current ? await customers.get(current.id) : null);
  }

  async function accountForCustomer(customerId) {
    const account = await accountBy('customer_id', customerId);
    if (!account) return null;
    const customer = await customers.get(customerId);
    return { ...publicAccount(account, customer), last_seen_at: account.updated_at };
  }

  async function ordersForCustomer(customerId) {
    if (!customerId) return [];
    if (typeof listOrders !== 'function') return [];
    const rows = await listOrders();
    return rows
      .filter((row) => row?.type === 'order_intent' && row.customer_id === customerId && orderOf(row)?.origin === 'FULLTECH_STORE')
      .map((item) => {
        const order = orderOf(item);
        return {
          id: item.id,
          order_number: order?.order_number ?? item.order_number ?? item.id,
          status: item.status ?? order?.status ?? 'nuevo',
          received_at: item.received_at ?? order?.created_at ?? null,
          total: Number(order?.total ?? item.total) || 0,
          currency: order?.currency ?? item.currency ?? 'DOP',
          items: (order?.items ?? []).map((line) => ({
            name: line.variantName ?? line.label ?? line.name ?? 'Artículo',
            quantity: Number(line.quantity) || 1,
            unitPrice: Number(line.unitPrice) || 0,
            subtotal: Number(line.subtotal) || 0,
          })),
          delivery_status: item.delivery?.status ?? order?.delivery?.status ?? null,
        };
      })
      .sort((a, b) => String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')));
  }

  const requestFromRow = (row) => (row ? { ...safeJson(row.doc), status: row.status } : null);

  function publicRequest(doc, { includeInternal = false } = {}) {
    if (!doc) return null;
    return {
      id: doc.id,
      customer_id: doc.customer_id ?? null,
      kind: doc.kind,
      title: doc.title,
      details: doc.details ?? '',
      reference_url: doc.reference_url ?? null,
      status: doc.status,
      quote: doc.quote ? {
        amount: Number(doc.quote.amount_cents) / 100,
        currency: doc.quote.currency ?? 'DOP',
        notes: doc.quote.notes ?? '',
        valid_until: doc.quote.valid_until ?? null,
        advance_percent: Number(doc.quote.advance_percent ?? 0),
        advance_amount: Number(doc.quote.advance_amount_cents ?? 0) / 100,
        eta: doc.quote.eta ?? '',
        terms: doc.quote.terms ?? '',
        warranty: doc.quote.warranty ?? '',
      } : null,
      /*
       * PAGO: el cliente ve lo que él mismo reportó y si administración lo
       * confirmó. Un comprobante NUNCA se toma como pago confirmado.
       */
      payment: doc.payment ? {
        status: doc.payment.status ?? 'reported',
        reported_at: doc.payment.reported_at ?? null,
        amount: Number(doc.payment.amount_cents ?? 0) / 100,
        reference: doc.payment.reference ?? '',
        verified_at: doc.payment.verified_at ?? null,
        reason: doc.payment.reason ?? null,
        has_proof: Boolean(doc.payment.proof),
      } : null,
      images: Number(doc.image_count ?? 0),
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      events: (doc.events ?? []).filter((event) => includeInternal || event.visible !== false).map((event) => ({ at: event.at, status: event.status, by: event.by, note: event.note ?? null })),
      ...(includeInternal ? { admin_notes: doc.admin_notes ?? '' } : {}),
    };
  }

  async function createRequest(account, input = {}) {
    throw fail('sourcing_retired', 'El servicio de solicitudes fue retirado.', 410);
    if (!account?.customer_id) throw fail('account_not_linked', 'Completa tu cuenta para enviar una solicitud.', 403);
    const kind = input.kind === 'service' ? 'service' : 'product';
    const title = clean(input.title, 120);
    const details = clean(input.details, 2000);
    const referenceUrl = clean(input.referenceUrl, 500);
    if (title.length < 3) throw fail('invalid_title', 'Cuéntanos qué necesitas (al menos 3 caracteres).');
    if (referenceUrl && !/^https?:\/\/\S+$/i.test(referenceUrl)) throw fail('invalid_reference', 'El enlace debe empezar por http:// o https://.');
    const key = clean(input.requestKey, 100);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw fail('invalid_request_key', 'Actualiza la página y vuelve a intentarlo.');
    const existingKey = (await sql.query('SELECT * FROM fulltech_store_requests_v1 WHERE request_key=$1', [key])).rows[0];
    if (existingKey) {
      if (existingKey.customer_id !== account.customer_id) throw fail('duplicate_key', 'Esa solicitud ya fue registrada.', 409);
      return { request: publicRequest(requestFromRow(existingKey)), duplicate: true };
    }
    const recent = (await sql.query('SELECT * FROM fulltech_store_requests_v1 WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20', [account.customer_id])).rows.map(requestFromRow);
    const titleKey = normTitle(title);
    const duplicate = recent.find((row) => row.title_key === titleKey && Date.now() - new Date(row.created_at).getTime() < 10 * 60 * 1000 && !['cancelado', 'rechazado'].includes(row.status));
    if (duplicate) return { request: publicRequest(duplicate), duplicate: true };

    const images = Array.isArray(input.images) ? input.images.slice(0, 3) : [];
    const parsed = images.map((value) => parseProductImage(value));
    const now = clock().toISOString();
    const doc = {
      id: `sreq_${randomUUID()}`, customer_id: account.customer_id, account_id: account.id,
      request_key: key, kind, title, title_key: titleKey, details, reference_url: referenceUrl || null,
      status: 'nuevo', image_count: parsed.length, quote: null, admin_notes: '',
      events: [{ at: now, status: 'nuevo', by: 'Cliente', note: null }],
      created_at: now, updated_at: now,
    };
    await sql.query('INSERT INTO fulltech_store_requests_v1(id,customer_id,account_id,request_key,status,kind,title_key,doc,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      doc.id, doc.customer_id, doc.account_id, doc.request_key, doc.status, doc.kind, doc.title_key, JSON.stringify(doc), doc.created_at, doc.updated_at,
    ]);
    for (const [index, image] of parsed.entries()) {
      await sql.query('INSERT INTO fulltech_store_request_images_v1(id,request_id,position,mime,data) VALUES($1,$2,$3,$4,$5)', [`reqimg_${randomUUID()}`, doc.id, index, image.mime, image.data]);
    }
    return { request: publicRequest(doc), duplicate: false };
  }

  async function listRequestsForCustomer(customerId, limit = 50) {
    if (!customerId) return [];
    const rows = (await sql.query('SELECT doc FROM fulltech_store_requests_v1 WHERE customer_id=$1 ORDER BY created_at DESC LIMIT $2', [customerId, Number(limit)])).rows;
    return rows.map((row) => publicRequest(safeJson(row.doc)));
  }

  async function getRequest(id, account = null) {
    const row = (await sql.query('SELECT * FROM fulltech_store_requests_v1 WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    if (account && row.customer_id !== account.customer_id) return null;
    return publicRequest(requestFromRow(row));
  }

  async function requestForAccount(id, account) {
    const row = (await sql.query('SELECT * FROM fulltech_store_requests_v1 WHERE id=$1', [id])).rows[0];
    if (!row || row.customer_id !== account?.customer_id) return null;
    return requestFromRow(row);
  }

  async function requestImage(requestId, index, account = null) {
    const row = (await sql.query('SELECT customer_id FROM fulltech_store_requests_v1 WHERE id=$1', [requestId])).rows[0];
    if (!row) return null;
    if (account && row.customer_id !== account.customer_id) return null;
    const image = (await sql.query('SELECT mime,data FROM fulltech_store_request_images_v1 WHERE request_id=$1 AND position=$2', [requestId, Number(index)])).rows[0];
    return image ?? null;
  }

  async function decideRequest(id, account, input = {}) {
    throw fail('sourcing_retired', 'El archivo de solicitudes es de solo lectura.', 410);
    const doc = await requestForAccount(id, account);
    if (!doc) throw fail('not_found', 'La solicitud no existe.', 404);
    if (doc.status !== 'cotizado') throw fail('not_quoted', 'Esta solicitud todavía no tiene una cotización para responder.', 409);
    const decision = input.decision === 'accept' ? 'aprobado' : input.decision === 'decline' ? 'cancelado' : null;
    if (!decision) throw fail('invalid_decision', 'Elige aceptar o rechazar la cotización.');
    const now = clock().toISOString();
    const advance = Number(doc.quote?.advance_amount_cents ?? 0);
    doc.status = decision === 'aprobado' && advance > 0 ? 'anticipo_pendiente' : decision;
    doc.events = [...(doc.events ?? []), { at: now, status: doc.status, by: 'Cliente', note: clean(input.note, 300) || null, visible: true }];
    doc.updated_at = now;
    await sql.query('UPDATE fulltech_store_requests_v1 SET status=$1,doc=$2,updated_at=$3 WHERE id=$4', [doc.status, JSON.stringify(doc), now, id]);
    return publicRequest(doc);
  }

  /**
   * El cliente REPORTA una transferencia. Nunca se marca como pagada: queda
   * «reported» hasta que un administrador verifique el dinero.
   */
  async function reportTransfer(id, account, input = {}) {
    throw fail('sourcing_retired', 'El archivo de solicitudes es de solo lectura.', 410);
    const doc = await requestForAccount(id, account);
    if (!doc) throw fail('not_found', 'La solicitud no existe.', 404);
    if (!doc.quote?.amount_cents) throw fail('not_quoted', 'Todavía no hay una propuesta para esta solicitud.', 409);
    if (!['aprobado', 'anticipo_pendiente', 'en_proceso'].includes(doc.status)) {
      throw fail('not_accepted', 'Acepta la propuesta antes de reportar el pago.', 409);
    }
    if (doc.payment?.verified_at) throw fail('payment_already_verified', 'Ese pago ya fue verificado.', 409);
    const now = clock().toISOString();
    const expected = Number(doc.quote.advance_amount_cents ?? 0);
    const amount = moneyToCents(input.amount) ?? expected;
    if (amount === null || amount <= 0) throw fail('invalid_amount', 'Escribe el monto transferido.');
    if (expected > 0 && amount > expected) throw fail('amount_too_high', 'El monto no puede superar el anticipo acordado.');
    let proof = null;
    if (input.proof) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(input.proof));
      if (!match) throw fail('invalid_proof', 'El comprobante debe ser una imagen JPG, PNG o WebP.');
      if (match[2].length > 700000) throw fail('proof_too_large', 'El comprobante es demasiado grande (máx. 500 KB).');
      proof = `data:image/${match[1]};base64,${match[2]}`;
    }
    doc.payment = {
      status: 'reported',
      reported_at: now,
      amount_cents: amount,
      reference: clean(input.reference, 120),
      note: clean(input.note, 300),
      proof,
    };
    doc.events = [...(doc.events ?? []), { at: now, status: doc.status, by: 'Cliente', note: 'Transferencia reportada (pendiente de verificación)', visible: true }];
    doc.updated_at = now;
    await sql.query('UPDATE fulltech_store_requests_v1 SET doc=$1,updated_at=$2 WHERE id=$3', [JSON.stringify(doc), now, id]);
    return publicRequest(doc);
  }

  async function adminListRequests({ status = '', q = '', limit = 200 } = {}) {
    const rows = (await sql.query('SELECT doc FROM fulltech_store_requests_v1 ORDER BY created_at DESC LIMIT $1', [Number(limit)])).rows.map((row) => safeJson(row.doc));
    const needle = String(q ?? '').trim().toLowerCase();
    return rows
      .filter((doc) => (status ? doc.status === status : true))
      .filter((doc) => (needle ? `${doc.title} ${doc.details} ${doc.id}`.toLowerCase().includes(needle) : true))
      .map((doc) => publicRequest(doc, { includeInternal: true }));
  }

  async function adminUpdateRequest(id, input = {}) {
    throw fail('sourcing_retired', 'El archivo de solicitudes es de solo lectura.', 410);
    const row = (await sql.query('SELECT * FROM fulltech_store_requests_v1 WHERE id=$1', [id])).rows[0];
    if (!row) throw fail('not_found', 'La solicitud no existe.', 404);
    const doc = requestFromRow(row);
    const now = clock().toISOString();
    let nextStatus = doc.status;
    if (input.status !== undefined) {
      if (!STORE_REQUEST_STATUSES.includes(input.status)) throw fail('invalid_status', 'Elige un estado válido.');
      nextStatus = input.status;
    }
    if (input.admin_notes !== undefined) doc.admin_notes = clean(input.admin_notes, 2000);
    if (input.quote !== undefined) {
      const amount = moneyToCents(input.quote?.amount);
      if (amount === null || amount <= 0) throw fail('invalid_quote', 'Escribe un monto válido para la cotización.');
      const percent = input.quote?.advance_percent === undefined || input.quote?.advance_percent === ''
        ? 30
        : Number(input.quote.advance_percent);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw fail('invalid_advance', 'El anticipo debe estar entre 0 y 100%.');
      doc.quote = {
        amount_cents: amount,
        currency: 'DOP',
        notes: clean(input.quote?.notes, 1000),
        valid_until: input.quote?.valid_until ? clean(input.quote.valid_until, 40) : null,
        advance_percent: Math.round(percent),
        advance_amount_cents: Math.round(amount * percent / 100),
        eta: clean(input.quote?.eta, 120),
        terms: clean(input.quote?.terms, 2000),
        warranty: clean(input.quote?.warranty, 500),
        created_at: now,
      };
      /* Una propuesta nueva invalida la aceptación y el pago anteriores. */
      doc.payment = null;
      doc.accepted_at = null;
      if (input.status === undefined) nextStatus = 'cotizado';
    }
    /*
     * VERIFICACIÓN DEL ADMINISTRADOR. Confirmar un anticipo NO marca pagado todo
     * el pedido ni crea una venta: solo deja constancia de que el dinero llegó.
     */
    if (input.payment !== undefined) {
      const decision = input.payment?.decision;
      if (!['confirmed', 'rejected'].includes(decision)) throw fail('invalid_payment_decision', 'Elige confirmar o rechazar el pago.');
      if (!doc.payment?.reported_at) throw fail('no_payment_report', 'El cliente todavía no ha reportado la transferencia.');
      if (doc.payment?.verified_at) throw fail('payment_already_verified', 'Ese pago ya fue verificado.', 409);
      doc.payment = {
        ...doc.payment,
        status: decision,
        verified_at: now,
        verified_by: 'Administración',
        reason: clean(input.payment?.reason, 300) || null,
      };
      if (decision === 'confirmed') {
        if (['anticipo_pendiente', 'aprobado'].includes(nextStatus)) nextStatus = 'en_proceso';
        doc.events = [...(doc.events ?? []), { at: now, status: nextStatus, by: 'Administración', note: 'Anticipo confirmado', visible: true }];
      } else {
        nextStatus = 'anticipo_pendiente';
        doc.events = [...(doc.events ?? []), { at: now, status: nextStatus, by: 'Administración', note: 'Transferencia rechazada', visible: true }];
      }
    }
    if (nextStatus === 'cotizado' && !doc.quote) throw fail('quote_required', 'Agrega el monto de la cotización antes de marcarla como cotizada.');
    if (nextStatus !== doc.status || input.admin_notes !== undefined || input.quote !== undefined) {
      doc.status = nextStatus;
      doc.events = [...(doc.events ?? []), { at: now, status: nextStatus, by: 'Administración', note: input.note ? clean(input.note, 300) : null, visible: true }];
      doc.updated_at = now;
      await sql.query('UPDATE fulltech_store_requests_v1 SET status=$1,doc=$2,updated_at=$3 WHERE id=$4', [nextStatus, JSON.stringify(doc), now, id]);
    }
    return publicRequest(doc, { includeInternal: true });
  }

  async function resolveCustomerForAccount(name, phone, orderNumber, city = '') {
    const existing = await customers.findByPhone(phone);
    if (existing) {
      if (await accountBy('customer_id', existing.id)) throw fail('account_exists', 'Ese teléfono ya tiene una cuenta. Inicia sesión.', 409);
      if (!(await orderMatchesCustomer(existing.id, orderNumber))) {
        throw fail('verification_required', 'Ese teléfono ya tiene historial. Escribe el número de uno de tus pedidos para vincular la cuenta.', 403);
      }
      /* La ciudad es dato de contacto: se completa si falta, nunca se pisa. */
      if (city && !existing.location) {
        const patched = await customers.update(existing.id, { location: city });
        return patched ?? existing;
      }
      return existing;
    }
    const created = await customers.findOrCreateByPhone({ phone, name, location: city || null, source: 'tienda' });
    if (!created.ok) throw fail(created.error ?? 'invalid_phone', 'No pudimos crear tu cuenta con ese teléfono.');
    return created.customer;
  }

  async function issueLinkToken(accountId, identity = {}) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date(clock());
    const provider = identity.provider === 'apple' ? 'apple' : identity.provider === 'google' ? 'google' : null;
    const sub = provider ? clean(identity.sub, 200) || null : null;
    await sql.query('DELETE FROM fulltech_customer_account_links_v1 WHERE expires_at<$1', [now.toISOString()]);
    await sql.query('INSERT INTO fulltech_customer_account_links_v1(token_hash,account_id,provider,sub,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [
      tokenHash(token), accountId, provider, sub, now.toISOString(), new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    ]);
    return token;
  }

  /**
   * Enlaza la identidad del proveedor (`sub`) a la cuenta, con guarda de
   * unicidad: un `sub` no puede colgar de dos cuentas de la tienda.
   */
  async function attachProvider(accountId, provider, sub) {
    const column = provider === 'apple' ? 'apple_sub' : 'google_sub';
    const owner = await accountBy(column, sub);
    if (owner && owner.id !== accountId) {
      throw fail('provider_already_linked', 'Esa cuenta ya está vinculada a otra cuenta de la tienda. Inicia sesión con ella.', 409);
    }
    await sql.query(`UPDATE fulltech_customer_accounts_v1 SET ${column}=$1, updated_at=$2 WHERE id=$3`, [sub, clock().toISOString(), accountId]);
    return accountBy('id', accountId);
  }

  /**
   * Entrada con Google/Apple. La cuenta se identifica por `sub` (estable) y,
   * cuando el proveedor confirma el correo, se enlaza con una cuenta o cliente
   * existente. Si no hay forma segura de enlazarla, queda PENDIENTE y se pide el
   * teléfono (con prueba de pedido si ese teléfono ya tiene historial).
   */
  async function oauthLogin(identity = {}) {
    const provider = identity.provider === 'apple' ? 'apple' : 'google';
    const column = provider === 'apple' ? 'apple_sub' : 'google_sub';
    const sub = clean(identity.sub, 200);
    if (!sub) throw fail('invalid_provider_identity', 'No pudimos verificar tu identidad.', 400);
    const now = clock().toISOString();
    const bySub = await accountBy(column, sub);
    if (bySub) {
      if (bySub.status !== 'active') {
        return { pending: true, pendingToken: await issueLinkToken(bySub.id), account: bySub };
      }
      const customer = bySub.customer_id ? await customers.get(bySub.customer_id) : null;
      return { account: publicAccount(bySub, customer), customer };
    }

    const email = identity.email && identity.emailVerified !== false ? clean(identity.email, 160) : '';
    if (email) {
      const byEmail = await accountBy('email_key', emailKey(email));
      if (byEmail) {
        /*
         * ENLACE SEGURO — aquí estaba el fallo real.
         *
         * Antes, si el correo ya existía se pegaba el `sub` de Google y se
         * entraba sin más. Pero las cuentas manuales NO verifican el correo
         * (`PHYTO_STORE_MAIL_*` está apagado), así que cualquiera puede
         * registrarse con el correo de otra persona: al entrar esa persona con
         * Google, quedaba DENTRO de la cuenta del otro, que además conservaba
         * su contraseña y veía sus pedidos (robo de cuenta).
         *
         * Regla nueva:
         *  · Cuenta SIN contraseña (solo Google/Apple): enlazar es seguro,
         *    no hay credencial de nadie que robar.
         *  · Cuenta CON contraseña: no se toca nada; se devuelve un enlace
         *    pendiente y hay que demostrar propiedad con esa contraseña.
         */
        if (!byEmail.has_password) {
          const updated = await attachProvider(byEmail.id, provider, sub);
          if (updated.status !== 'active') {
            return { pending: true, pendingToken: await issueLinkToken(updated.id, { provider, sub }), account: updated };
          }
          const customer = updated.customer_id ? await customers.get(updated.customer_id) : null;
          return { account: publicAccount(updated, customer), customer };
        }
        return {
          pending: true,
          pendingToken: await issueLinkToken(byEmail.id, { provider, sub }),
          needsProof: 'password',
          account: publicAccount(byEmail, null),
        };
      }
      /*
       * SIN ENLACE AUTOMÁTICO AL CLIENTE DEL CRM POR CORREO.
       *
       * Antes, si el correo coincidía con la ficha de un cliente, la cuenta
       * nacía YA atada a esa ficha y heredaba su historial de pedidos. El correo
       * del CRM lo escribe el equipo: un error de tecleo (o un correo
       * compartido) le mostraba los pedidos a quien no era. Ahora se sigue el
       * camino normal de cuenta nueva: se pide teléfono y, si ese teléfono ya
       * tiene historial, la prueba del número de pedido.
       */
    }

    const id = `acc_${randomUUID()}`;
    const profile = JSON.stringify({ name: clean(identity.name, 120), email: email || null, onboarding: 'pending' });
    await sql.query(
      'INSERT INTO fulltech_customer_accounts_v1(id,customer_id,phone_e164,email,email_key,password_hash,google_sub,apple_sub,status,profile,preferences,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id, null, null, email || null, email ? emailKey(email) : null, null,
        provider === 'google' ? sub : null, provider === 'apple' ? sub : null, 'active', profile,
        JSON.stringify({ contact: 'whatsapp', marketing: false, language: 'es' }), now, now],
    );
    const pending = await accountBy('id', id);
    return { account: publicAccount(pending, null), customer: null };
  }

  async function completePendingLink(token, input = {}) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token ?? ''))) throw fail('invalid_link_token', 'El enlace de la cuenta ya no es válido.', 400);
    const row = (await sql.query('SELECT * FROM fulltech_customer_account_links_v1 WHERE token_hash=$1', [tokenHash(token)])).rows[0];
    if (!row || new Date(row.expires_at).getTime() <= clock().getTime()) throw fail('link_expired', 'El enlace caducó. Vuelve a entrar con Google o Apple.', 410);
    const account = await accountBy('id', row.account_id);
    if (!account) throw fail('link_expired', 'El enlace caducó. Vuelve a entrar con Google o Apple.', 410);

    /* Identidad que este enlace va a vincular (vacía en los enlaces antiguos). */
    const provider = row.provider === 'apple' ? 'apple' : row.provider === 'google' ? 'google' : null;
    const sub = provider ? clean(row.sub, 200) : '';

    /*
     * PRUEBA DE PROPIEDAD OBLIGATORIA cuando el enlace apunta a una cuenta con
     * contraseña: nadie enlaza Google a una cuenta ajena sin conocerla. Es lo
     * que convierte el antiguo «enlace por correo» en un enlace consentido.
     */
    if (sub && account.has_password) {
      const stored = (await sql.query('SELECT password_hash FROM fulltech_customer_accounts_v1 WHERE id=$1', [account.id])).rows[0]?.password_hash ?? '';
      const ok = await verifyPassword(String(input.password ?? ''), stored);
      if (!ok) throw fail('invalid_credentials', 'Escribe la contraseña de tu cuenta para vincular este acceso.', 401);
      const linked = await attachProvider(account.id, provider, sub);
      await sql.query('DELETE FROM fulltech_customer_account_links_v1 WHERE token_hash=$1', [row.token_hash]);
      const customer = linked.customer_id ? await customers.get(linked.customer_id) : null;
      return { account: publicAccount(linked, customer), customer };
    }

    if (account.status === 'active' && account.customer_id) {
      const linked = sub ? await attachProvider(account.id, provider, sub) : account;
      return { account: publicAccount(linked, await customers.get(linked.customer_id)) };
    }

    const provided = clean(input.name, 120) || clean(account.profile?.name, 120);
    const name = provided.length >= 2 ? provided : nameFromEmail(account.email);
    const phone = customers.normalizePhone(input.phone);
    const city = clean(input.city, 80);
    if (!phone) throw fail('invalid_phone', 'Escribe tu número de WhatsApp.');
    if (city.length < 2) throw fail('invalid_city', 'Escribe tu ciudad.');
    if (await accountBy('phone_e164', phone)) {
      const other = await accountBy('phone_e164', phone);
      if (other && other.id !== account.id) throw fail('account_exists', 'Ese teléfono ya tiene una cuenta. Inicia sesión con ella.', 409);
    }
    const customer = await resolveCustomerForAccount(name, phone, input.orderNumber, city);
    const profile = { ...safeJson(account.profile), name, email: account.email, city };
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET customer_id=$1,phone_e164=$2,status=$3,profile=$4,updated_at=$5 WHERE id=$6', [
      customer.id, phone, 'active', JSON.stringify(profile), now, account.id,
    ]);
    /* La cuenta ya es del cliente demostrado: ahora sí se enlaza el proveedor. */
    if (sub) await attachProvider(account.id, provider, sub);
    await sql.query('DELETE FROM fulltech_customer_account_links_v1 WHERE token_hash=$1', [row.token_hash]);
    const updated = await accountBy('id', account.id);
    return { account: publicAccount(updated, await customers.get(customer.id)), customer };
  }

  async function favoriteIds(accountId) {
    return (await sql.query('SELECT product_id FROM fulltech_customer_favorites_v1 WHERE account_id=$1 ORDER BY created_at DESC, product_id', [accountId])).rows.map(row => row.product_id);
  }
  async function setFavorite(accountId, productId, selected) {
    if (selected) {
      const ids = await favoriteIds(accountId);
      if (ids.length >= 250 && !ids.includes(productId)) throw fail('favorites_limit', 'Puedes guardar hasta 250 favoritos.', 422);
      await sql.query('INSERT INTO fulltech_customer_favorites_v1(account_id,product_id,created_at) VALUES($1,$2,$3) ON CONFLICT(account_id,product_id) DO NOTHING', [accountId, productId, clock().toISOString()]);
    } else {
      await sql.query('DELETE FROM fulltech_customer_favorites_v1 WHERE account_id=$1 AND product_id=$2', [accountId, productId]);
    }
    return favoriteIds(accountId);
  }

  return {
    register, login, session, revokeSession, createSession, updateProfile, setPassword,
    setPhone, ensureCustomerForPhone,
    accountForCustomer, ordersForCustomer, oauthLogin, completePendingLink,
    createRequest, listRequestsForCustomer, getRequest, requestImage, decideRequest, reportTransfer,
    adminListRequests, adminUpdateRequest,
    accountBy,
    favoriteIds, setFavorite,
    viewAccount: (account, customer) => publicAccount(account, customer),
    providers: { password: true },
  };
}
