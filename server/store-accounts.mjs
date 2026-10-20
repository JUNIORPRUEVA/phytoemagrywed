import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createSqlQuery } from './sql-query.mjs';
import { parseProductImage } from './store-catalog.mjs';
import { orderOf } from './orders.mjs';
import { moneyToCents } from './inventory.mjs';

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
const normTitle = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const STORE_REQUEST_STATUSES = ['nuevo', 'en_revision', 'cotizado', 'aprobado', 'en_proceso', 'completado', 'rechazado', 'cancelado'];

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
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL)`);

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
        row.customer_id === customerId &&
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
    if (!phone) throw fail('invalid_phone', 'Escribe un teléfono válido.');
    if (password.length < 8 || password.length > 200) throw fail('invalid_password', 'La contraseña debe tener al menos 8 caracteres.');
    const email = clean(input.email, 160);
    if (email && !isEmail(email)) throw fail('invalid_email', 'Escribe un correo válido.');
    const key = await assertEmailAvailable(email);

    if (await accountBy('phone_e164', phone)) throw fail('account_exists', 'Ya existe una cuenta con ese teléfono. Inicia sesión.', 409);

    const existing = await customers.findByPhone(phone);
    let customer = existing;
    if (existing) {
      if (await accountBy('customer_id', existing.id)) throw fail('account_exists', 'Ya existe una cuenta con ese teléfono. Inicia sesión.', 409);
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
      profile: JSON.stringify({ name, email: email || null }),
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

  async function updateProfile(account, input = {}) {
    const current = await customers.get(account.customer_id);
    if (!current) throw fail('not_found', 'La cuenta no tiene un cliente asociado.', 404);
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
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET email=$1,email_key=$2,profile=$3,preferences=$4,updated_at=$5 WHERE id=$6', [accountEmail, accountEmailKey, JSON.stringify(profile), JSON.stringify(account.preferences ?? {}), now, account.id]);
    if (Object.keys(patch).length) await customers.update(current.id, patch);
    const refreshed = await accountBy('id', account.id);
    return publicAccount(refreshed, await customers.get(current.id));
  }

  async function accountForCustomer(customerId) {
    const account = await accountBy('customer_id', customerId);
    if (!account) return null;
    const customer = await customers.get(customerId);
    return { ...publicAccount(account, customer), last_seen_at: account.updated_at };
  }

  async function ordersForCustomer(customerId) {
    if (typeof listOrders !== 'function') return [];
    const rows = await listOrders();
    return rows
      .filter((row) => row?.type === 'order_intent' && row.customer_id === customerId)
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
      quote: doc.quote ? { amount: Number(doc.quote.amount_cents) / 100, currency: doc.quote.currency ?? 'DOP', notes: doc.quote.notes ?? '', valid_until: doc.quote.valid_until ?? null } : null,
      images: Number(doc.image_count ?? 0),
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      events: (doc.events ?? []).filter((event) => includeInternal || event.visible !== false).map((event) => ({ at: event.at, status: event.status, by: event.by, note: event.note ?? null })),
      ...(includeInternal ? { admin_notes: doc.admin_notes ?? '' } : {}),
    };
  }

  async function createRequest(account, input = {}) {
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
    const doc = await requestForAccount(id, account);
    if (!doc) throw fail('not_found', 'La solicitud no existe.', 404);
    if (doc.status !== 'cotizado') throw fail('not_quoted', 'Esta solicitud todavía no tiene una cotización para responder.', 409);
    const decision = input.decision === 'accept' ? 'aprobado' : input.decision === 'decline' ? 'cancelado' : null;
    if (!decision) throw fail('invalid_decision', 'Elige aceptar o rechazar la cotización.');
    const now = clock().toISOString();
    doc.status = decision;
    doc.events = [...(doc.events ?? []), { at: now, status: decision, by: 'Cliente', note: clean(input.note, 300) || null }];
    doc.updated_at = now;
    await sql.query('UPDATE fulltech_store_requests_v1 SET status=$1,doc=$2,updated_at=$3 WHERE id=$4', [decision, JSON.stringify(doc), now, id]);
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
      doc.quote = {
        amount_cents: amount,
        currency: 'DOP',
        notes: clean(input.quote?.notes, 1000),
        valid_until: input.quote?.valid_until ? clean(input.quote.valid_until, 40) : null,
        created_at: now,
      };
      if (input.status === undefined) nextStatus = 'cotizado';
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

  async function resolveCustomerForAccount(name, phone, orderNumber) {
    const existing = await customers.findByPhone(phone);
    if (existing) {
      if (await accountBy('customer_id', existing.id)) throw fail('account_exists', 'Ese teléfono ya tiene una cuenta. Inicia sesión.', 409);
      if (!(await orderMatchesCustomer(existing.id, orderNumber))) {
        throw fail('verification_required', 'Ese teléfono ya tiene historial. Escribe el número de uno de tus pedidos para vincular la cuenta.', 403);
      }
      return existing;
    }
    const created = await customers.findOrCreateByPhone({ phone, name, source: 'tienda' });
    if (!created.ok) throw fail(created.error ?? 'invalid_phone', 'No pudimos crear tu cuenta con ese teléfono.');
    return created.customer;
  }

  async function issueLinkToken(accountId) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date(clock());
    await sql.query('DELETE FROM fulltech_customer_account_links_v1 WHERE expires_at<$1', [now.toISOString()]);
    await sql.query('INSERT INTO fulltech_customer_account_links_v1(token_hash,account_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [
      tokenHash(token), accountId, now.toISOString(), new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    ]);
    return token;
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
        await sql.query(`UPDATE fulltech_customer_accounts_v1 SET ${column}=$1, updated_at=$2 WHERE id=$3`, [sub, now, byEmail.id]);
        const updated = await accountBy('id', byEmail.id);
        if (updated.status !== 'active') return { pending: true, pendingToken: await issueLinkToken(updated.id), account: updated };
        const customer = updated.customer_id ? await customers.get(updated.customer_id) : null;
        return { account: publicAccount(updated, customer), customer };
      }
      const customer = typeof findCustomerByEmail === 'function' ? await findCustomerByEmail(email) : null;
      if (customer) {
        const existing = await accountBy('customer_id', customer.id);
        if (existing) {
          await sql.query(`UPDATE fulltech_customer_accounts_v1 SET ${column}=$1, updated_at=$2 WHERE id=$3`, [sub, now, existing.id]);
          return { account: publicAccount({ ...existing, [provider]: true }, customer), customer };
        }
        const id = `acc_${randomUUID()}`;
        const profile = JSON.stringify({ name: customer.name ?? clean(identity.name, 120), email });
        await sql.query(
          'INSERT INTO fulltech_customer_accounts_v1(id,customer_id,phone_e164,email,email_key,password_hash,google_sub,apple_sub,status,profile,preferences,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [id, customer.id, customer.phone_e164 ?? null, email, emailKey(email), null,
            provider === 'google' ? sub : null, provider === 'apple' ? sub : null, 'active', profile,
            JSON.stringify({ contact: 'whatsapp', marketing: false, language: 'es' }), now, now],
        );
        const account = await accountBy('id', id);
        return { account: publicAccount(account, customer), customer };
      }
    }

    const id = `acc_${randomUUID()}`;
    const profile = JSON.stringify({ name: clean(identity.name, 120), email: email || null });
    await sql.query(
      'INSERT INTO fulltech_customer_accounts_v1(id,customer_id,phone_e164,email,email_key,password_hash,google_sub,apple_sub,status,profile,preferences,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id, null, null, email || null, email ? emailKey(email) : null, null,
        provider === 'google' ? sub : null, provider === 'apple' ? sub : null, 'pending_link', profile,
        JSON.stringify({ contact: 'whatsapp', marketing: false, language: 'es' }), now, now],
    );
    const pending = await accountBy('id', id);
    return { pending: true, pendingToken: await issueLinkToken(id), account: pending };
  }

  async function completePendingLink(token, input = {}) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token ?? ''))) throw fail('invalid_link_token', 'El enlace de la cuenta ya no es válido.', 400);
    const row = (await sql.query('SELECT * FROM fulltech_customer_account_links_v1 WHERE token_hash=$1', [tokenHash(token)])).rows[0];
    if (!row || new Date(row.expires_at).getTime() <= clock().getTime()) throw fail('link_expired', 'El enlace caducó. Vuelve a entrar con Google o Apple.', 410);
    const account = await accountBy('id', row.account_id);
    if (!account) throw fail('link_expired', 'El enlace caducó. Vuelve a entrar con Google o Apple.', 410);
    if (account.status === 'active' && account.customer_id) return { account: publicAccount(account, await customers.get(account.customer_id)) };

    const name = clean(input.name, 120) || clean(account.profile?.name, 120);
    const phone = customers.normalizePhone(input.phone);
    if (name.length < 2) throw fail('invalid_name', 'Escribe tu nombre.');
    if (!phone) throw fail('invalid_phone', 'Escribe un teléfono válido.');
    if (await accountBy('phone_e164', phone)) {
      const other = await accountBy('phone_e164', phone);
      if (other && other.id !== account.id) throw fail('account_exists', 'Ese teléfono ya tiene una cuenta. Inicia sesión con ella.', 409);
    }
    const customer = await resolveCustomerForAccount(name, phone, input.orderNumber);
    const profile = { ...safeJson(account.profile), name, email: account.email };
    const now = clock().toISOString();
    await sql.query('UPDATE fulltech_customer_accounts_v1 SET customer_id=$1,phone_e164=$2,status=$3,profile=$4,updated_at=$5 WHERE id=$6', [
      customer.id, phone, 'active', JSON.stringify(profile), now, account.id,
    ]);
    await sql.query('DELETE FROM fulltech_customer_account_links_v1 WHERE token_hash=$1', [row.token_hash]);
    const updated = await accountBy('id', account.id);
    return { account: publicAccount(updated, await customers.get(customer.id)), customer };
  }

  return {
    register, login, session, revokeSession, createSession, updateProfile,
    accountForCustomer, ordersForCustomer, oauthLogin, completePendingLink,
    createRequest, listRequestsForCustomer, getRequest, requestImage, decideRequest,
    adminListRequests, adminUpdateRequest,
    accountBy,
    viewAccount: (account, customer) => publicAccount(account, customer),
    providers: { password: true },
  };
}
