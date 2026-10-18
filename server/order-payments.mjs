/**
 * PAGOS DEL PEDIDO — entrega, cobro y rendición, SEPARADOS.
 *
 * POR QUÉ EXISTE
 * Antes, cerrar una entrega podía poner `payment_status: 'paid'` sin que nadie
 * hubiera cobrado (`updateOrderStatus`). Eso mezclaba tres cosas distintas:
 *
 *   1. la ENTREGA física (el pedido se entregó),
 *   2. el COBRO al cliente (cuánto dinero entró y por qué medio),
 *   3. la RENDICIÓN del repartidor (cuánto de ese efectivo llegó a la empresa).
 *
 * Aquí solo se registran (2) y (3), siempre por una acción EXPLÍCITA y
 * autorizada. La entrega no toca el dinero; una IA tampoco (el supervisor nunca
 * llama a este módulo). No hay contabilidad paralela: se guardan los datos
 * dentro del pedido y se auditan; los movimientos de caja siguen siendo del
 * cierre/POS, que no se modifican.
 *
 * DATOS (dentro de `order_json.payment`; no se toca nada histórico):
 * {
 *   version: 1,
 *   entries: [{ id, amount, method, at, by_user_id, by_display_name, note, evidence_url, idempotency_key }],
 *   received_total, due, status: 'pending'|'partial'|'paid'|'void', last_payment_at,
 *   courier: { user_id, name, collected_total, handed_over_total, pending,
 *              handovers: [{ id, amount, at, by_user_id, by_display_name, note, idempotency_key }] }
 * }
 *
 * COMPATIBILIDAD
 * `payment_status` sigue existiendo con los valores de siempre ('pending',
 * 'paid', 'void'): un pedido ya marcado como pagado NUNCA se degrada, y un pago
 * parcial se queda 'pending' (el saldo vive en `payment.due`) para no romper al
 * cierre, al POS ni a las pruebas existentes.
 */

import { randomUUID } from 'node:crypto';
/*
 * `PAYMENT_METHODS` vive en `server/orders.mjs` (la lista de métodos del
 * pedido). Se importaba de `src/lib/catalog.js`, que NO la exporta: el servidor
 * ni siquiera arrancaba (SyntaxError al cargar el módulo).
 */
import { PAYMENT_METHODS } from './orders.mjs';

const CLOSED_FOR_PAYMENT = Object.freeze(['cancelado', 'perdido']);
const MAX_NOTE = 300;
const MAX_EVIDENCE = 600;

const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
const money2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** Normaliza el método: CASH|TRANSFER (acepta las palabras que usa el negocio). */
export function normalizePaymentMethod(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'CASH' || raw === 'EFECTIVO' || raw === 'CONTRAENTREGA' || raw === 'COD') return 'CASH';
  if (raw === 'TRANSFER' || raw === 'TRANSFERENCIA' || raw === 'TRANSFERENCIA_BANCARIA') return 'TRANSFER';
  return PAYMENT_METHODS.includes(raw) ? raw : null;
}

/** Bloque de pago normalizado (nunca muta el pedido). */
export function paymentBlockOf(order) {
  const source = order?.payment ?? {};
  const entries = Array.isArray(source.entries) ? source.entries.filter(Boolean) : [];
  const total = money2(order?.total ?? 0);
  const received = money2(entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  const legacyPaid = String(order?.payment_status ?? '').toLowerCase() === 'paid' && !entries.length;
  const voided = String(order?.payment_status ?? '').toLowerCase() === 'void';
  const due = voided || legacyPaid ? 0 : money2(Math.max(0, total - received));
  const status = voided ? 'void' : legacyPaid || (total > 0 && due <= 0) ? 'paid' : received > 0 ? 'partial' : 'pending';
  const cashReceived = money2(entries.filter((entry) => normalizePaymentMethod(entry.method) === 'CASH').reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  const handovers = Array.isArray(source.courier?.handovers) ? source.courier.handovers.filter(Boolean) : [];
  const handedOver = money2(handovers.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  return {
    version: 1,
    total,
    received,
    due,
    status,
    legacy: legacyPaid,
    method: normalizePaymentMethod(order?.payment_method) ?? null,
    entries,
    lastPaymentAt: source.last_payment_at ?? null,
    cashReceived,
    courier: {
      user_id: order?.delivery?.delivery_user_id ?? source.courier?.user_id ?? null,
      name: order?.delivery?.delivery_user_name_snapshot ?? order?.delivery?.external?.contact_name ?? source.courier?.name ?? null,
      handovers,
      handed_over_total: handedOver,
      pending: money2(Math.max(0, cashReceived - handedOver)),
    },
  };
}

/** Resumen corto para vistas de reparto (sin nombres internos ni notas). */
export function paymentSummaryForDelivery(order) {
  const block = paymentBlockOf(order);
  return {
    status: block.status,
    due: block.due,
    received: block.received,
    total: block.total,
    method: block.method,
  };
}

/** Fila fresca del almacén (en SQLite `listAdmin` es síncrono). */
async function freshOrder(ctx, orderId) {
  const rows = await Promise.resolve(ctx.store.listAdmin({ limit: 5000 }));
  const row = rows.find((entry) => entry.id === orderId) ?? null;
  if (!row || row.type !== 'order_intent') return null;
  const order = parseOrderJson(row);
  return order ? { row, order } : null;
}

/**
 * El pedido guardado puede venir como `orderJson` o `order_json` según el
 * almacén (SQLite local / Postgres en producción). Se aceptan los dos.
 */
function parseOrderJson(row) {
  const raw = row?.orderJson ?? row?.order_json ?? null;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });

/** Escribe el bloque de pago en el pedido y devuelve el pedido guardado. */
async function persist(ctx, row, order, payment, patch = {}) {
  const at = ctx.clock().toISOString();
  const block = paymentBlockOf({ ...order, ...patch, payment });
  const next = {
    ...order,
    ...patch,
    payment: {
      ...payment,
      version: 1,
      received_total: block.received,
      due: block.due,
      status: block.status,
      last_payment_at: payment.last_payment_at ?? null,
      courier: block.courier,
    },
    updated_at: at,
  };
  const updated = await ctx.store.update(row.id, { orderJson: JSON.stringify(next) });
  const saved = parseOrderJson(updated) ?? next;
  return saved;
}

/**
 * REGISTRA UN COBRO DEL CLIENTE (efectivo o transferencia).
 *
 * Es la única puerta para convertir dinero en «cobrado». No se puede cobrar de
 * más, ni sobre un pedido cancelado, ni dos veces con la misma clave.
 */
export async function registerCustomerPayment(input) {
  const { ctx, orderId, actor = null } = input;
  const fresh = await freshOrder(ctx, orderId);
  if (!fresh) return fail(404, 'not_found', 'Ese pedido no existe.');
  const { row, order } = fresh;
  const status = String(order.status ?? row.status ?? '');
  if (CLOSED_FOR_PAYMENT.includes(status)) return fail(409, 'order_closed', 'Un pedido cancelado o perdido no admite cobros.');
  if (String(order.payment_status ?? '').toLowerCase() === 'void') return fail(409, 'payment_void', 'El pago de este pedido está anulado.');

  const block = paymentBlockOf(order);
  /*
   * REPETICIÓN PRIMERO: si esta clave ya se usó, se devuelve el cobro que ya
   * existe. Comprobarlo antes de validar el saldo es lo que hace que un segundo
   * toque (o un reintento de red) no acabe en «ya está pagado» ni cobre otra vez.
   */
  const idempotencyKey = clean(input.idempotencyKey, 160);
  if (idempotencyKey && block.entries.some((entry) => entry.idempotency_key === idempotencyKey)) {
    return { ok: true, duplicate: true, order, payment: block };
  }
  if (block.legacy) {
    return fail(409, 'already_paid', 'Este pedido ya figura pagado (registro anterior). Para corregirlo usa una reversión autorizada.');
  }

  const amount = money2(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return fail(422, 'invalid_amount', 'Escribe un importe mayor que cero.');
  const method = normalizePaymentMethod(input.method) ?? normalizePaymentMethod(order.payment_method);
  if (!method) return fail(422, 'invalid_method', 'Elige el medio de pago (efectivo o transferencia).');
  if (amount > block.due + 0.005) {
    return fail(422, 'amount_exceeds_due', `El importe supera lo que falta por cobrar (${block.due.toFixed(2)}).`, { due: block.due });
  }

  const at = ctx.clock().toISOString();
  const entry = {
    id: `pay_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    amount,
    method,
    at,
    by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
    by_display_name: clean(actor?.display_name, 120),
    note: clean(input.note, MAX_NOTE),
    evidence_url: clean(input.evidenceUrl ?? input.evidence_url, MAX_EVIDENCE),
    idempotency_key: idempotencyKey,
  };
  const payment = {
    ...(order.payment ?? {}),
    entries: [...block.entries, entry],
    last_payment_at: at,
  };
  const saved = await persist(ctx, row, order, payment, {
    payment_method: order.payment_method ?? method,
    payment_status: money2(block.received + amount) >= block.total ? 'paid' : 'pending',
    ...(money2(block.received + amount) >= block.total ? { paid_at: order.paid_at ?? at } : {}),
  });
  const after = paymentBlockOf(saved);

  await ctx.audit?.record({
    entity: 'order',
    entityId: row.id,
    action: 'order.payment_registered',
    actor: actor?.display_name ?? null,
    summary: `Cobro registrado: ${amount.toFixed(2)} ${method} · queda ${after.due.toFixed(2)}`,
    data: {
      order_id: row.id,
      payment_id: entry.id,
      amount,
      method,
      due_after: after.due,
      received_total: after.received,
      evidence: Boolean(entry.evidence_url),
      note: entry.note,
    },
    idempotencyKey: idempotencyKey ? `order.payment:${row.id}:${idempotencyKey}` : `order.payment:${row.id}:${entry.id}`,
  });

  return { ok: true, duplicate: false, order: saved, payment: after, entry };
}

/**
 * REGISTRA UNA RENDICIÓN: dinero en efectivo que el repartidor entrega a la
 * empresa. Solo administración (no se auto-certifica). No crea movimientos de
 * caja: anota la entrega para poder cuadrar y auditar.
 */
export async function registerCourierHandover(input) {
  const { ctx, orderId, actor = null } = input;
  const fresh = await freshOrder(ctx, orderId);
  if (!fresh) return fail(404, 'not_found', 'Ese pedido no existe.');
  const { row, order } = fresh;
  const block = paymentBlockOf(order);
  if (block.status === 'void') return fail(409, 'payment_void', 'El pago de este pedido está anulado.');
  if (block.cashReceived <= 0) return fail(409, 'no_cash_collected', 'Este pedido no tiene cobros en efectivo que rendir.');
  if (!block.courier.user_id && !block.courier.name) return fail(409, 'no_courier', 'Este pedido no tiene repartidor asignado.');

  const amount = money2(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return fail(422, 'invalid_amount', 'Escribe un importe mayor que cero.');
  if (amount > block.courier.pending + 0.005) {
    return fail(422, 'handover_exceeds', `Solo quedan ${block.courier.pending.toFixed(2)} en efectivo por rendir.`, { pending: block.courier.pending });
  }
  const idempotencyKey = clean(input.idempotencyKey, 160);
  if (idempotencyKey && block.courier.handovers.some((entry) => entry.idempotency_key === idempotencyKey)) {
    return { ok: true, duplicate: true, order, payment: block };
  }

  const at = ctx.clock().toISOString();
  const handover = {
    id: `hov_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    amount,
    at,
    by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
    by_display_name: clean(actor?.display_name, 120),
    note: clean(input.note, MAX_NOTE),
    idempotency_key: idempotencyKey,
  };
  const payment = {
    ...(order.payment ?? {}),
    courier: {
      ...(order.payment?.courier ?? {}),
      user_id: block.courier.user_id,
      name: block.courier.name,
      handovers: [...block.courier.handovers, handover],
    },
  };
  const saved = await persist(ctx, row, order, payment);
  const after = paymentBlockOf(saved);

  await ctx.audit?.record({
    entity: 'order',
    entityId: row.id,
    action: 'order.courier_handover_registered',
    actor: actor?.display_name ?? null,
    summary: `Rendición registrada: ${amount.toFixed(2)} · pendiente ${after.courier.pending.toFixed(2)}`,
    data: {
      order_id: row.id,
      handover_id: handover.id,
      amount,
      courier: after.courier.name,
      courier_user_id: after.courier.user_id,
      cash_collected: after.cashReceived,
      handed_over_total: after.courier.handed_over_total,
      pending: after.courier.pending,
      note: handover.note,
    },
    idempotencyKey: idempotencyKey ? `order.handover:${row.id}:${idempotencyKey}` : `order.handover:${row.id}:${handover.id}`,
  });

  return { ok: true, duplicate: false, order: saved, payment: after, handover };
}
