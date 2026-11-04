import { randomUUID } from 'node:crypto';
import { assignedToCourier, isCourierUsable } from './courier-app.mjs';
import { courierCompanies } from './logistics-tenancy.mjs';

const closed = new Set(['entregado', 'cancelado', 'perdido']);
const closedDelivery = new Set(['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'REASSIGNED']);
const safeText = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Contexto de la conversación; el contacto privado nunca entra en la respuesta. */
export async function storeContactContext(db, order, companyId) {
  const pickup = order?.delivery?.pickup;
  const supplierId = String(pickup?.supplier_id ?? '').trim();
  if (!supplierId || !companyId) return { ok: false, status: 409, error: 'pickup_store_required' };
  const supplier = await db.get('suppliers', supplierId);
  if (!supplier || supplier.company_id !== companyId)
    return { ok: false, status: 409, error: 'pickup_store_unavailable' };
  return { ok: true, supplierId, store: { id: supplierId,
    name: safeText(pickup.name ?? supplier.name, 120),
    address: safeText(pickup.address ?? supplier.address, 240) },
    writable: !closed.has(String(order.status ?? '').toLowerCase()) &&
      !closedDelivery.has(String(order.delivery?.lifecycle ?? '').toUpperCase()) };
}

export async function currentStoreContactCourier(db, order, companyId) {
  const accounts = await db.list('courier_accounts', { limit: 20000 });
  for (const account of accounts) {
    if (isCourierUsable(account).ok && assignedToCourier(account, order) &&
        (await courierCompanies(db, account)).includes(companyId)) return account;
  }
  return null;
}

export async function listStoreContactMessages(db, { companyId, orderId, supplierId, courierId }) {
  const rows = await db.list('store_contact_messages', { limit: 20000 });
  return rows.filter((row) => row.company_id === companyId && row.order_id === orderId &&
    row.supplier_id === supplierId && (!courierId || row.courier_account_id === courierId))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(({ id, role, text, author_name, created_at, courier_account_id }) =>
      ({ id, role, text, author_name, created_at, courier_account_id }));
}

/** Solo guarda un mensaje dentro del CRM. La tienda externa requiere mediación. */
export async function writeStoreContactMessage(db, { companyId, orderId, supplierId,
  courierId, role, authorId, authorName, message, idempotencyKey, now = new Date() }) {
  const rawText = String(message ?? '').trim().replace(/\s+/g, ' ');
  const text = rawText;
  const key = safeText(idempotencyKey, 120);
  if (!text || text.length > 1000) return { ok: false, status: 422, error: 'message_required' };
  if (key.length < 8) return { ok: false, status: 422, error: 'idempotency_key_required' };
  const seen = await db.findBy('store_contact_messages', 'idempotency_key', key);
  if (seen) {
    if (seen.company_id !== companyId || seen.order_id !== orderId ||
        seen.supplier_id !== supplierId || seen.courier_account_id !== courierId ||
        seen.author_id !== authorId || seen.text !== text)
      return { ok: false, status: 409, error: 'idempotency_key_reused' };
    return { ok: true, duplicate: true, message: publicMessage(seen) };
  }
  const document = { id: `scm_${randomUUID().replaceAll('-', '')}`, company_id: companyId,
    order_id: orderId, supplier_id: supplierId, courier_account_id: courierId,
    role, author_id: authorId, author_name: safeText(authorName, 120), text,
    idempotency_key: key, created_at: now.toISOString() };
  const inserted = await db.insert('store_contact_messages', document);
  if (inserted?.duplicate) {
    const raced = await db.findBy('store_contact_messages', 'idempotency_key', key);
    if (raced && raced.company_id === companyId && raced.order_id === orderId &&
        raced.supplier_id === supplierId && raced.courier_account_id === courierId &&
        raced.author_id === authorId && raced.text === text)
      return { ok: true, duplicate: true, message: publicMessage(raced) };
    return { ok: false, status: 409, error: 'idempotency_key_reused' };
  }
  return { ok: true, duplicate: false, message: publicMessage(inserted?.doc ?? document) };
}

const publicMessage = ({ id, role, text, author_name, created_at }) =>
  ({ id, role, text, author_name, created_at });
