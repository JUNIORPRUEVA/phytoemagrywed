/**
 * OPERACIONES ASISTIDAS DEL ASISTENTE IA — propuesta, confirmación y ejecución.
 *
 * QUÉ ES
 * El modelo NUNCA escribe. Como mucho interpreta la petición y devuelve una
 * INTENCIÓN (`order`, `quote`, `note`, `followup`) con datos en texto. Aquí se
 * valida contra los servicios reales, se calcula el total con la MISMA función
 * del punto de venta (`calculateSale`) y se guarda una PROPUESTA pendiente.
 *
 * CONFIRMACIÓN HUMANA
 * Ejecutar exige `POST /api/admin/assistant/actions/:id/confirm` del usuario
 * autenticado. La propuesta:
 *   - caduca a los 10 minutos;
 *   - es de un solo uso (pending → executing → executed);
 *   - se compara el `fingerprint` recalculado: si cambió el catálogo, el stock o
 *     los parámetros, NO se ejecuta (`proposal_changed`);
 *   - vuelve a comprobar permisos y acceso a la conversación al ejecutar;
 *   - usa un identificador determinista (`ast_<propuesta>`) para que un
 *     reintento no cree un pedido o una cotización duplicados;
 *   - deja traza en auditoría (preparada, confirmada, fallida).
 */
import { randomBytes } from 'node:crypto';
import { calculateSale } from '../public/admin/pos-math.js';

export const PROPOSAL_TYPES = Object.freeze(['order', 'quote', 'note', 'followup']);
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20;
const MAX_QUANTITY = 99;

const LABELS = Object.freeze({
  order: 'Pedido',
  quote: 'Cotización',
  note: 'Nota del cliente',
  followup: 'Seguimiento',
});

const PERMISSION = Object.freeze({
  order: 'orders.create',
  quote: 'orders.create',
  note: 'clients.update',
  followup: 'chats.reply',
});

function newId(prefix = 'prop') {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function text(value, max = 400) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : '';
}

function day(value) {
  const raw = String(value ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

/** Huella estable de los parámetros: si cambia algo, la confirmación se invalida. */
export function fingerprintOf(type, params) {
  return `${type}:${JSON.stringify(params)}`;
}

/**
 * Huella de la PROPUESTA COMPLETA: incluye lo que se le enseñó a la persona
 * (importes, líneas y fecha). Si el catálogo cambia de precio o de existencias
 * entre preparar y confirmar, la huella deja de coincidir y NO se ejecuta.
 */
function fingerprintOfBuilt(built) {
  const preview = built.preview ?? {};
  return fingerprintOf(built.type, {
    params: built.params,
    items: preview.items ?? null,
    total: preview.total ?? null,
    text: preview.text ?? null,
    date: preview.date ?? null,
  });
}

/** Propuesta pública (sin datos internos) para el panel. */
export function publicProposal(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    type: doc.type,
    label: LABELS[doc.type] ?? doc.type,
    status: doc.status,
    customer: doc.preview?.customer ?? null,
    preview: doc.preview ?? null,
    expiresAt: doc.expires_at,
    created_at: doc.created_at,
    result: doc.result ?? null,
  };
}

/**
 * Resuelve un producto escrito por la IA contra el catálogo REAL.
 * Solo se aceptan coincidencias verificables: id, nombre exacto o cápsulas.
 */
function resolveVariant(products, token) {
  const raw = String(token ?? '').trim().toLowerCase();
  if (!raw) return null;
  const byId = products.find((product) => String(product.id).toLowerCase() === raw);
  if (byId) return byId;
  const byName = products.find((product) => String(product.name ?? '').toLowerCase() === raw);
  if (byName) return byName;
  const caps = raw.match(/(\d{1,4})\s*(c[áa]psulas?|caps?)\b/);
  if (caps) {
    const valor = Number(caps[1]);
    const byCaps = products.find((product) => Number(product.capsules) === valor);
    if (byCaps) return byCaps;
  }
  // Último recurso: el nombre del catálogo contenido en el texto («frasco de 30»).
  return products.find((product) => {
    const name = String(product.name ?? product.label ?? '').toLowerCase();
    return name && (raw.includes(name) || name.includes(raw));
  }) ?? null;
}

/** Normaliza las líneas que propone el modelo (texto) a variantes REALES. */
export function resolveLines(products, items) {
  const lines = [];
  const unknown = [];
  for (const item of Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []) {
    const quantity = Math.max(1, Math.min(MAX_QUANTITY, Number(item?.cantidad ?? item?.quantity ?? 1) || 1));
    const product = resolveVariant(products, item?.producto ?? item?.productId ?? item?.variantId ?? '');
    if (!product) {
      unknown.push(text(item?.producto ?? item?.productId, 60) || 'producto');
      continue;
    }
    const existing = lines.find((line) => line.variantId === product.id);
    if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
    else lines.push({ variantId: product.id, quantity });
  }
  return { lines, unknown };
}

async function catalogOf(ctx) {
  if (ctx.assistantOps?.catalog) return ctx.assistantOps.catalog();
  return ctx.storeCatalog?.list?.() ?? [];
}

/**
 * Construye y valida la propuesta. Devuelve `{ok:false,...}` con el motivo
 * exacto (producto inexistente, stock, fecha…) o la propuesta lista.
 */
export async function buildProposal({ ctx, actor, conversation, customer, type, params }) {
  if (!PROPOSAL_TYPES.includes(type)) return { ok: false, status: 422, error: 'invalid_proposal_type' };
  if (!customer?.id) return { ok: false, status: 409, error: 'customer_missing' };
  const customerFacts = { id: customer.id, name: customer.name ?? 'Cliente' };
  const products = type === 'order' || type === 'quote' ? await catalogOf(ctx) : [];

  if (type === 'order' || type === 'quote') {
    const { lines, unknown } = resolveLines(products, params?.items);
    if (unknown.length) {
      return { ok: false, status: 422, error: 'unknown_product', message: `No encontré en el catálogo: ${unknown.join(', ')}.`, products: unknown };
    }
    if (!lines.length) return { ok: false, status: 422, error: 'empty_items', message: 'La propuesta no tiene productos.' };
    let sale;
    try {
      sale = calculateSale(lines, products, 0, 0);
    } catch (error) {
      return { ok: false, status: 422, error: 'invalid_sale', message: error?.message ?? 'No se pudo calcular el total.' };
    }
    const payment = params?.payment === 'TRANSFER' ? 'TRANSFER' : 'CASH';
    const finalParams = { items: lines, paymentMethod: payment, note: text(params?.note, 300) };
    if (type === 'order' && ctx.assistantOps?.checkStock) {
      const stock = await ctx.assistantOps.checkStock(sale).catch(() => ({ ok: true }));
      if (stock && stock.ok === false) {
        return { ok: false, status: 409, error: 'insufficient_stock', message: stock.message ?? 'No hay existencias suficientes.' };
      }
    }
    return {
      ok: true,
      type,
      params: finalParams,
      preview: {
        customer: customerFacts,
        items: sale.items.map((line) => ({ variantId: line.variantId, name: line.name ?? line.variantName, quantity: line.quantity, unitPrice: line.unit_price_cents / 100 })),
        total: sale.total_cents / 100,
        currency: 'DOP',
        paymentMethod: payment,
        paymentLabel: payment === 'TRANSFER' ? 'Transferencia' : 'Efectivo',
        note: finalParams.note || null,
      },
    };
  }

  if (type === 'note') {
    const value = text(params?.text ?? params?.note, 2000);
    if (!value) return { ok: false, status: 422, error: 'empty_note', message: 'La nota está vacía.' };
    return { ok: true, type, params: { text: value }, preview: { customer: customerFacts, text: value } };
  }

  // Seguimiento: la fecha es obligatoria y no puede estar en el pasado.
  const scheduled = day(params?.date ?? params?.scheduledAt);
  if (!scheduled) return { ok: false, status: 422, error: 'missing_date', message: 'Necesito la fecha del seguimiento (AAAA-MM-DD).' };
  const today = new Date().toISOString().slice(0, 10);
  if (scheduled < today) return { ok: false, status: 422, error: 'date_in_past', message: 'Esa fecha ya pasó: dime cuándo lo programamos.' };
  const reason = text(params?.reason ?? params?.text, 300) || 'Seguimiento';
  return {
    ok: true,
    type,
    params: { date: scheduled, reason },
    preview: { customer: customerFacts, date: scheduled, reason },
  };
}

async function audit(ctx, action, proposal, actor, extra = {}) {
  await ctx.audit?.record?.({
    entity: 'assistant_proposal',
    entityId: proposal.id,
    action,
    actor: actor?.display_name ?? actor?.id ?? null,
    summary: `${LABELS[proposal.type] ?? proposal.type} · ${proposal.status}`,
    data: { type: proposal.type, customer_id: proposal.customer_id, conversation_id: proposal.conversation_id, user_id: actor?.id ?? null, ...extra },
  }).catch?.(() => {});
}

/** Guarda la propuesta pendiente (NO ejecuta nada). */
export async function prepareProposal({ ctx, actor, conversation, customer, type, params }) {
  const built = await buildProposal({ ctx, actor, conversation, customer, type, params });
  if (!built.ok) return built;
  const now = Date.now();
  const doc = {
    id: newId(),
    type: built.type,
    status: 'pending',
    customer_id: customer.id,
    conversation_id: conversation?.id ?? null,
    created_by: actor?.id ?? null,
    created_by_display_name: actor?.display_name ?? null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    params: built.params,
    preview: built.preview,
    fingerprint: fingerprintOfBuilt(built),
    result: null,
  };
  await ctx.db.insert('assistant_proposals', doc);
  await audit(ctx, 'assistant.action_prepared', doc, actor);
  return { ok: true, proposal: publicProposal(doc) };
}

const locks = new Map();

async function withLock(key, fn) {
  while (locks.has(key)) await locks.get(key);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  locks.set(key, gate);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

async function execute(ctx, proposal, actor, options = {}) {
  const { type, params } = proposal;
  if (type === 'order') {
    if (!ctx.assistantOps?.createOrder) return { ok: false, error: 'executor_unavailable', message: 'No se puede crear pedidos desde aquí.' };
    const created = await ctx.assistantOps.createOrder({
      // Id determinista: un reintento no duplica el pedido.
      id: `ast_${proposal.id}`.slice(0, 40),
      customerId: proposal.customer_id,
      conversationId: proposal.conversation_id ?? undefined,
      paymentMethod: params.paymentMethod,
      items: params.items,
      notes: params.note || '',
      origin: 'ASSISTANT',
    }, actor);
    if (!created?.ok) return { ok: false, error: created?.error ?? 'order_failed', message: created?.message ?? 'No se pudo crear el pedido.' };
    return {
      ok: true,
      duplicate: created.duplicate === true,
      ref: { type: 'order', id: created.order?.id ?? created.item?.id ?? null, number: created.order?.order_number ?? null, status: created.order?.status ?? null },
      summary: `Pedido ${created.order?.order_number ?? ''}`.trim(),
    };
  }

  if (type === 'quote') {
    if (!ctx.assistantOps?.createQuote) return { ok: false, error: 'executor_unavailable', message: 'No se puede crear cotizaciones desde aquí.' };
    return ctx.assistantOps.createQuote({ proposal, actor, cookie: options.cookie });
  }

  if (type === 'note') {
    if (!ctx.assistantOps?.setCustomerNotes) return { ok: false, error: 'executor_unavailable' };
    const customer = await ctx.customers.get(proposal.customer_id);
    if (!customer) return { ok: false, error: 'customer_missing' };
    const before = String(customer.notes ?? '').trim();
    const next = before ? `${before}\n${params.text}`.slice(0, 2000) : params.text;
    await ctx.assistantOps.setCustomerNotes(proposal.customer_id, next);
    return { ok: true, ref: { type: 'customer', id: proposal.customer_id }, summary: 'Nota guardada en el expediente' };
  }

  if (type === 'followup') {
    if (!ctx.assistantOps?.createFollowup) return { ok: false, error: 'executor_unavailable' };
    const followup = await ctx.assistantOps.createFollowup({
      customerId: proposal.customer_id,
      conversationId: proposal.conversation_id ?? null,
      scheduledAt: params.date,
      reason: params.reason,
      origin: 'assistant',
      createdByUserId: actor?.id ?? null,
      createdByDisplayName: actor?.display_name ?? null,
      idempotencyKey: `fu:assistant:${proposal.id}`,
    });
    return { ok: true, duplicate: followup?.duplicate === true, ref: { type: 'followup', id: followup?.id ?? null, date: params.date }, summary: `Seguimiento ${params.date}` };
  }

  return { ok: false, error: 'invalid_proposal_type' };
}

/**
 * Confirma y ejecuta. Revalida TODO en el servidor: usuario, permiso, acceso a
 * la conversación, vigencia, estado y parámetros.
 */
export async function confirmProposal({ ctx, actor, can, canOpen, proposalId, fingerprint, cookie }) {
  const id = String(proposalId ?? '').trim();
  if (!id) return { ok: false, status: 422, error: 'proposal_required' };
  return withLock(`proposal:${id}`, async () => {
    const proposal = await ctx.db.get('assistant_proposals', id);
    if (!proposal) return { ok: false, status: 404, error: 'proposal_not_found' };
    // Reintento: ya se ejecutó → se devuelve el resultado, sin repetir nada.
    if (proposal.status === 'executed') return { ok: true, duplicate: true, proposal: publicProposal(proposal), result: proposal.result };
    if (proposal.status !== 'pending') return { ok: false, status: 409, error: 'proposal_not_pending', status_actual: proposal.status };
    if (proposal.created_by && actor?.id && proposal.created_by !== actor.id && !can('settings.manage')) {
      return { ok: false, status: 403, error: 'proposal_from_another_user' };
    }
    if (Date.parse(proposal.expires_at) < Date.now()) {
      await ctx.db.update('assistant_proposals', id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'expired' });
      return { ok: false, status: 410, error: 'proposal_expired' };
    }
    if (!can(PERMISSION[proposal.type])) return { ok: false, status: 403, error: 'forbidden' };
    const conversation = proposal.conversation_id ? await ctx.db.get('conversations', proposal.conversation_id) : null;
    if (conversation && !(await canOpen(conversation))) return { ok: false, status: 403, error: 'conversation_not_accessible' };
    const customer = await ctx.customers.get(proposal.customer_id);
    if (!customer) return { ok: false, status: 409, error: 'customer_missing' };

    // Revalidación de parámetros: productos, precios, stock y fecha de hoy.
    const rebuilt = await buildProposal({ ctx, actor, conversation, customer, type: proposal.type, params: proposal.params });
    if (!rebuilt.ok) {
      await audit(ctx, 'assistant.action_failed', proposal, actor, { error: rebuilt.error, phase: 'revalidate' });
      return { ok: false, status: rebuilt.status ?? 409, error: rebuilt.error, message: rebuilt.message };
    }
    const currentFingerprint = fingerprintOfBuilt(rebuilt);
    if (currentFingerprint !== proposal.fingerprint) {
      return { ok: false, status: 409, error: 'proposal_changed', message: 'Los datos cambiaron desde que se preparó. Vuelve a prepararlo.' };
    }
    if (fingerprint && fingerprint !== proposal.fingerprint) return { ok: false, status: 409, error: 'proposal_changed' };

    // Un solo uso: se marca ANTES de ejecutar.
    await ctx.db.update('assistant_proposals', id, { status: 'executing', started_at: new Date().toISOString() });
    try {
      const result = await execute(ctx, proposal, actor, { cookie });
      if (!result.ok) {
        await ctx.db.update('assistant_proposals', id, { status: 'failed', error: result.error ?? 'failed', finished_at: new Date().toISOString() });
        const failed = { ...proposal, status: 'failed' };
        await audit(ctx, 'assistant.action_failed', failed, actor, { error: result.error ?? null });
        return { ok: false, status: 409, error: result.error ?? 'action_failed', message: result.message ?? 'No se pudo ejecutar la operación.' };
      }
      const done = {
        status: 'executed',
        executed_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        result: { ...result.ref, summary: result.summary ?? null, duplicate: result.duplicate === true },
      };
      await ctx.db.update('assistant_proposals', id, done);
      const executed = { ...proposal, ...done };
      await audit(ctx, 'assistant.action_confirmed', executed, actor, { ref: result.ref ?? null, duplicate: result.duplicate === true });
      return { ok: true, duplicate: result.duplicate === true, proposal: publicProposal(executed), result: executed.result };
    } catch (error) {
      await ctx.db.update('assistant_proposals', id, { status: 'failed', error: 'execution_error', finished_at: new Date().toISOString() });
      await audit(ctx, 'assistant.action_failed', { ...proposal, status: 'failed' }, actor, { error: 'execution_error' });
      return { ok: false, status: 500, error: 'execution_error', message: 'La operación falló. Revisa Pedidos antes de reintentar.' };
    }
  });
}

/** Cancela una propuesta pendiente (no toca nada más). */
export async function cancelProposal({ ctx, actor, can, proposalId }) {
  const id = String(proposalId ?? '').trim();
  if (!id) return { ok: false, status: 422, error: 'proposal_required' };
  return withLock(`proposal:${id}`, async () => {
    const proposal = await ctx.db.get('assistant_proposals', id);
    if (!proposal) return { ok: false, status: 404, error: 'proposal_not_found' };
    if (proposal.status === 'executed') return { ok: false, status: 409, error: 'proposal_already_executed' };
    if (proposal.status !== 'pending') return { ok: true, proposal: publicProposal(proposal) };
    if (proposal.created_by && actor?.id && proposal.created_by !== actor.id && !can('settings.manage')) {
      return { ok: false, status: 403, error: 'proposal_from_another_user' };
    }
    const cancelled = { status: 'cancelled', cancelled_at: new Date().toISOString() };
    await ctx.db.update('assistant_proposals', id, cancelled);
    const doc = { ...proposal, ...cancelled };
    await audit(ctx, 'assistant.action_cancelled', doc, actor);
    return { ok: true, proposal: publicProposal(doc) };
  });
}

export { LABELS as PROPOSAL_LABELS, PERMISSION as PROPOSAL_PERMISSION };
