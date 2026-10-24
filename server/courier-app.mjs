/*
 * ACCESO MÓVIL DEL REPARTIDOR — identidad, sesión y lectura (Fase 04).
 *
 * Qué es y qué NO es:
 *   · Es una identidad PROPIA del móvil (`courier_accounts`), ligada a un registro que YA existe:
 *     un usuario del CRM con rol DELIVERY (repartidor interno) o un contacto de reparto guardado
 *     (repartidor externo). Nunca se duplica la persona.
 *   · NO es una cuenta de administración: el token que emite este módulo solo abre
 *     `/api/courier/*`; no sirve para `/api/admin/*` y no lleva permisos del panel.
 *   · Tener el teléfono NO da acceso: hace falta que un administrador cree la cuenta con
 *     `app_access: true` y un PIN. El teléfono solo sirve para elegir la cuenta.
 *
 * La credencial se guarda con el MISMO esquema que las contraseñas del CRM
 * (pbkdf2-sha256, 210 000 iteraciones, sal de 16 bytes, comparación en tiempo constante).
 * La sesión es un token firmado con HMAC (igual que la cookie del panel) con caducidad corta y
 * `token_epoch`, que al incrementarse revoca TODOS los tokens ya emitidos de esa cuenta.
 */
import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { COURIER_ACTIONS, lifecycleOf, operationalStatusFor } from './delivery-lifecycle.mjs';

const derive = promisify(pbkdf2);

const CREDENTIAL_VERSION = 'pbkdf2-sha256';
const CREDENTIAL_ITERATIONS = 210_000;
const CREDENTIAL_KEYLEN = 32;
const CREDENTIAL_DIGEST = 'sha256';

/** Vida del token del móvil: corta a propósito (se vuelve a entrar). */
export const COURIER_SESSION_SECONDS = 8 * 60 * 60;
/** Fallos seguidos antes de bloquear la cuenta un rato. */
export const COURIER_MAX_FAILURES = 5;
export const COURIER_LOCK_MS = 15 * 60 * 1000;
export const COURIER_KINDS = Object.freeze(['INTERNAL', 'EXTERNAL']);
/** Un pedido en estos estados ya no es trabajo del repartidor. */
export const COURIER_CLOSED_ORDER_STATUSES = Object.freeze(['entregado', 'cancelado', 'perdido']);
const MIN_CREDENTIAL_LENGTH = 6;
const MAX_CREDENTIAL_LENGTH = 64;

const nowIso = (clock) => new Date(clock ? clock() : Date.now()).toISOString();
const text = (value, max) => {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};

/** Teléfono a dígitos para comparar sin formato. NO es prueba de identidad. */
export function digitsOf(value) {
  return String(value ?? '').replace(/[^\d]/g, '');
}

export function normalizeCourierPhone(value) {
  const digits = digitsOf(value);
  if (digits.length < 10 || digits.length > 15) return null;
  /* República Dominicana: 10 dígitos → +1. */
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export async function hashCourierCredential(secret) {
  const value = String(secret ?? '');
  if (value.length < MIN_CREDENTIAL_LENGTH || value.length > MAX_CREDENTIAL_LENGTH) {
    return { ok: false, error: 'weak_credential' };
  }
  const salt = randomBytes(16).toString('base64url');
  const key = await derive(value, salt, CREDENTIAL_ITERATIONS, CREDENTIAL_KEYLEN, CREDENTIAL_DIGEST);
  return {
    ok: true,
    hash: `${CREDENTIAL_VERSION}$${CREDENTIAL_ITERATIONS}$${salt}$${Buffer.from(key).toString('base64url')}`,
  };
}

export async function verifyCourierCredential(secret, stored) {
  const raw = String(stored ?? '');
  const [version, iterationsRaw, salt, expectedRaw] = raw.split('$');
  if (version !== CREDENTIAL_VERSION || !salt || !expectedRaw) return false;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const expected = Buffer.from(expectedRaw, 'base64url');
  const actual = await derive(String(secret ?? ''), salt, iterations, expected.length, CREDENTIAL_DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Gasta el mismo trabajo que una verificación real cuando no hay cuenta o está bloqueada,
 * para que el tiempo de respuesta no diga si el teléfono existe (anti-enumeración).
 */
const DUMMY_HASH = `${CREDENTIAL_VERSION}$${CREDENTIAL_ITERATIONS}$${'x'.repeat(16)}$${'x'.repeat(43)}`;
export async function burnCredentialCheck(secret) {
  await verifyCourierCredential(secret ?? '', DUMMY_HASH);
  return false;
}

/** Lo que se puede contar de una cuenta de reparto (nunca el hash). */
export function publicCourierAccount(account) {
  if (!account) return null;
  const { credential_hash, ...safe } = account;
  return {
    id: account.id,
    kind: account.kind,
    display_name: account.display_name,
    phone: account.phone_e164,
    user_id: account.user_id ?? null,
    contact_id: account.contact_id ?? null,
    active: account.active !== false,
    app_access: account.app_access === true,
    company_id: account.company_id ?? null,
    last_login_at: account.last_login_at ?? null,
    created_at: account.created_at ?? null,
    updated_at: account.updated_at ?? null,
  };
}

/* ------------------------------------------------------------------ sesión */

function signCourierToken(accountId, epoch, expiresAt, secret) {
  return createHmac('sha256', secret).update(`courier:${accountId}:${epoch}:${expiresAt}`).digest('base64url');
}

/** `cv1.<cuenta>.<epoch>.<caduca>.<firma>` — sin estado, revocable por epoch. */
export function createCourierToken(account, secret, { now = Date.now(), ttlSeconds = COURIER_SESSION_SECONDS } = {}) {
  if (!account?.id || !secret) return null;
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const epoch = Number(account.token_epoch ?? 0) || 0;
  const signature = signCourierToken(account.id, epoch, expiresAt, secret);
  return {
    token: `cv1.${account.id}.${epoch}.${expiresAt}.${signature}`,
    expiresAt,
    expiresAtIso: new Date(expiresAt * 1000).toISOString(),
  };
}

export function readCourierToken(token, secret, { now = Date.now() } = {}) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'cv1') return null;
  const [, accountId, rawEpoch, rawExpires, signature] = parts;
  const epoch = Number.parseInt(rawEpoch, 10);
  const expiresAt = Number.parseInt(rawExpires, 10);
  if (!accountId || !Number.isFinite(epoch) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt * 1000 <= now) return { error: 'session_expired', accountId };
  const expected = signCourierToken(accountId, epoch, expiresAt, secret);
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { accountId, epoch, expiresAt };
}

/** Token del móvil: `Authorization: Bearer …` (app) o cookie `pe_courier` (navegador). */
export function courierTokenFromRequest(req, readCookie) {
  const header = String(req?.headers?.authorization ?? '').trim();
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim() || null;
  return readCookie ? readCookie(req, 'pe_courier') : null;
}

/* --------------------------------------------------------------- identidad */

export function isCourierUsable(account, companyId = null) {
  if (!account) return { ok: false, error: 'unknown_courier' };
  if (account.active === false) return { ok: false, error: 'courier_inactive' };
  if (account.app_access !== true) return { ok: false, error: 'courier_without_app_access' };
  if (companyId && account.company_id && account.company_id !== companyId) {
    return { ok: false, error: 'courier_out_of_company' };
  }
  return { ok: true };
}

/**
 * ¿Este pedido está asignado a ESTA cuenta?
 *
 * Interno  → `delivery.delivery_user_id` es el usuario del CRM ligado a la cuenta.
 * Externo  → `delivery.external.contact_id` es el contacto ligado a la cuenta.
 * El teléfono solo se acepta como respaldo si la cuenta no tiene contacto ligado, y siempre
 * comparando con el `phone_e164` que el servidor guardó al asignar (nunca con lo que mande el cliente).
 */
export function assignedToCourier(account, order) {
  if (!account || !order) return false;
  const delivery = order.delivery ?? {};
  /*
   * UN PEDIDO TIENE UN SOLO REPARTIDOR VIGENTE.
   * Si hay asignación interna, la externa anterior queda SUPERADA y no da acceso
   * (antes, al reasignar de externo a interno, el externo seguía viendo el pedido).
   * Y al revés: si el asignado es externo, el usuario interno anterior tampoco entra.
   */
  const internalId = String(delivery.delivery_user_id ?? '').trim();
  const external = delivery.external ?? null;
  const externalVigente = external && !external.superseded_at ? external : null;

  if (internalId) {
    /* Hay repartidor interno: solo él. */
    return Boolean(account.user_id) && account.user_id === internalId;
  }
  if (!externalVigente) return false;
  if (account.contact_id && externalVigente.contact_id && externalVigente.contact_id === account.contact_id) return true;
  if (!account.contact_id && account.phone_e164 && externalVigente.phone_e164) {
    return digitsOf(account.phone_e164) === digitsOf(externalVigente.phone_e164);
  }
  return false;
}

/** Estados del pedido que el móvil puede mostrar. */
export function courierOrderStatus(order) {
  const operational = String(order?.delivery?.delivery_status ?? '').trim().toUpperCase();
  return {
    order_status: String(order?.status ?? '').trim() || null,
    delivery_status: operational || null,
  };
}
/* ------------------------------------------------------------------ lectura */

const money = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
};
const cents = (value) => Math.round(money(value) * 100);

/**
 * Vista mínima del pedido para el repartidor: lo que necesita para entregar.
 * Nada de costos, márgenes, clientes completos, notas internas ni historial de ventas.
 */
export function courierOrderDTO(item, { customer = null } = {}) {
  if (!item) return null;
  let order = null;
  try {
    order = typeof item.order_json === 'string' ? JSON.parse(item.order_json) : item.order;
  } catch {
    return null;
  }
  if (!order) return null;
  const delivery = order.delivery ?? {};
  const location = delivery.location ?? {};
  const payment = order.payment ?? {};
  const entries = Array.isArray(payment.entries) ? payment.entries.filter(Boolean) : [];
  const verified = entries.filter((entry) => String(entry.verification ?? 'verified').toLowerCase() !== 'pending');
  const received = money(verified.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  const pendingVerification = money(
    entries
      .filter((entry) => String(entry.verification ?? 'verified').toLowerCase() === 'pending')
      .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0),
  );
  const total = money(order.total);
  const due = Math.max(0, money(total - received));
  const items = Array.isArray(order.items) ? order.items : [];
  const external = delivery.external ?? null;

  return {
    id: item.id,
    order_number: order.order_number ?? null,
    version: Number.isInteger(order.version) && order.version > 0 ? order.version : 1,
    ...courierOrderStatus(order),
    /* Estado LOGÍSTICO (Fase 05) y acciones que la app puede ofrecer. */
    delivery_lifecycle: lifecycleOf(order),
    available_actions: COURIER_ACTIONS[lifecycleOf(order)] ?? [],
    offer_expires_at: delivery.offer_expires_at ?? null,
    customer: {
      display_name: customer?.name ?? order.customer_name ?? order.name ?? null,
      phone: customer?.phone_e164 ?? customer?.phone ?? order.customer_phone ?? order.phone ?? null,
    },
    delivery: {
      address: delivery.address ?? location.address ?? order.delivery_address ?? null,
      reference: delivery.reference ?? location.reference ?? location.label ?? null,
      city: delivery.city ?? location.city ?? null,
      note: text(delivery.note ?? order.delivery_note, 400),
      fee: delivery.fee ?? order.delivery_fee ?? null,
      assigned_at: external?.assigned_at ?? delivery.assigned_at ?? order.created_at ?? null,
      courier_kind: external ? 'EXTERNAL' : delivery.delivery_user_id ? 'INTERNAL' : null,
    },
    items: items.slice(0, 50).map((row) => ({
      name: row.label ?? row.name ?? row.productName ?? null,
      quantity: Number(row.quantity ?? row.qty ?? 0),
      unit_price: money(row.unitPrice ?? row.price ?? 0),
      unit_price_cents: cents(row.unitPrice ?? row.price ?? 0),
    })),
    total,
    total_cents: cents(total),
    amount_to_collect: due,
    amount_to_collect_cents: cents(due),
    payment: {
      method: payment.method ?? order.payment_method ?? null,
      status: payment.status ?? order.payment_status ?? null,
      received,
      pending_verification: pendingVerification,
      due,
    },
    /* La compensación del repartidor NO existe todavía en el CRM: se dice, no se inventa. */
    courier_compensation: null,
    courier_compensation_unavailable: true,
    created_at: order.created_at ?? item.created_at ?? null,
    updated_at: order.updated_at ?? item.updated_at ?? null,
  };
}

/** Pedido por id: el `orderId` es el del pedido, nunca el de la fila del almacén. */
export async function findCourierOrder(store, orderId, account, { getCustomer = () => null } = {}) {
  const id = String(orderId ?? '').trim();
  if (!id) return { ok: false, status: 404, error: 'not_found' };
  const items = await Promise.resolve(store.listAdmin({ limit: 5000 }));
  const rows = Array.isArray(items) ? items : [];
  /* Acepta el id del pedido y el de la fila. Se comprueba la asignación SIEMPRE. */
  for (const item of rows) {
    let order = null;
    try {
      order = typeof item.order_json === 'string' ? JSON.parse(item.order_json) : item.order;
    } catch {
      continue;
    }
    if (!order) continue;
    const matches = item.id === id || String(order.id ?? '') === id;
    if (!matches) continue;
    if (!assignedToCourier(account, order)) return { ok: false, status: 404, error: 'not_found' };
    const customer = order.customer_id ? await Promise.resolve(getCustomer(order.customer_id)) : null;
    return { ok: true, item, order, dto: courierOrderDTO(item, { customer }) };
  }
  return { ok: false, status: 404, error: 'not_found' };
}

export async function listCourierOrders(store, account, { includeClosed = false, getCustomer = () => null } = {}) {
  const items = await Promise.resolve(store.listAdmin({ limit: 5000 }));
  const rows = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of rows) {
    let order = null;
    try {
      order = typeof item.order_json === 'string' ? JSON.parse(item.order_json) : item.order;
    } catch {
      continue;
    }
    if (!order || !assignedToCourier(account, order)) continue;
    const status = String(order.status ?? item.status ?? '').trim();
    if (!includeClosed && COURIER_CLOSED_ORDER_STATUSES.includes(status)) continue;
    const customer = order.customer_id ? await Promise.resolve(getCustomer(order.customer_id)) : null;
    const dto = courierOrderDTO(item, { customer });
    if (dto) out.push(dto);
  }
  out.sort((a, b) => String(b.delivery?.assigned_at ?? b.updated_at ?? '').localeCompare(String(a.delivery?.assigned_at ?? a.updated_at ?? '')));
  return out;
}

/* ------------------------------------------------------------------ altas */

/** Valida y normaliza el alta/edición de una cuenta de reparto. */
export function normalizeCourierAccountInput(input = {}, { id = null, now = nowIso() } = {}) {
  const kind = String(input.kind ?? '').trim().toUpperCase();
  if (!COURIER_KINDS.includes(kind)) return { ok: false, error: 'invalid_kind' };
  const phone = normalizeCourierPhone(input.phone ?? input.phone_e164);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  const displayName = text(input.displayName ?? input.display_name, 80);
  if (!displayName) return { ok: false, error: 'invalid_display_name' };
  const userId = text(input.userId ?? input.user_id, 80);
  const contactId = text(input.contactId ?? input.contact_id, 80);
  if (kind === 'INTERNAL' && !userId) return { ok: false, error: 'internal_requires_user' };
  if (kind === 'EXTERNAL' && !contactId) return { ok: false, error: 'external_requires_contact' };
  return {
    ok: true,
    value: {
      ...(id ? { id } : {}),
      kind,
      phone_e164: phone,
      display_name: displayName,
      user_id: kind === 'INTERNAL' ? userId : null,
      contact_id: kind === 'EXTERNAL' ? contactId : null,
      active: input.active !== false,
      app_access: input.appAccess === true || input.app_access === true,
      company_id: text(input.companyId ?? input.company_id, 80),
      updated_at: now,
    },
  };
}

export function newCourierAccountId() {
  return `courier_${randomBytes(12).toString('hex')}`;
}
