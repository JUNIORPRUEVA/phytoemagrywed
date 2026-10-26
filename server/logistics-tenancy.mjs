// Identidad empresarial compartida por el CRM y la app de reparto.
import { hasPermission } from './users.mjs';

export const BOOTSTRAP_COMPANIES = Object.freeze({
  phytoemagry: 'PHYTOEMAGRY',
  fulltech: 'FULLTECH Store',
});

export const validCompanyId = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{2,39}$/.test(value);

export async function ensureLogisticsCompanies(db) {
  for (const [id, name] of Object.entries(BOOTSTRAP_COMPANIES)) {
    await db.insert('logistics_companies', { id, name, active: true, system: true,
      created_at: new Date().toISOString() });
  }
}

export async function activeLogisticsCompany(db, id) {
  if (!validCompanyId(id)) return null;
  const row = await db.get('logistics_companies', id);
  return row?.active === true ? row : null;
}

export function companyOfOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const explicit = String(order.company_id ?? '').trim();
  if (explicit) {
    if (order.origin === 'FULLTECH_STORE' && explicit !== 'fulltech') return null;
    return validCompanyId(explicit) ? explicit : null;
  }
  if (order.origin === 'FULLTECH_STORE') return 'fulltech';
  // Pedidos históricos de cápsulas: evidencia en el snapshot, no en el repartidor.
  const lines = order.items;
  if (Array.isArray(lines) && lines.length && lines.every((line) =>
    /^capsules_\d+$/.test(String(line.variantId ?? '')) && Number(line.capsules) > 0)) return 'phytoemagry';
  return null;
}

export function companyOfCashRow(row, ordersById) {
  if (row?.company_id) {
    if (!validCompanyId(row.company_id)) return null;
    const order = row.order_id ? ordersById?.get(String(row.order_id)) : null;
    if (order && companyOfOrder(order) !== row.company_id) return null;
    return row.company_id;
  }
  if (row?.order_id) return companyOfOrder(ordersById?.get(String(row.order_id)));
  // No inferir la empresa de una rendición histórica sin referencia a un pedido.
  return null;
}

// CRM histórico: una ficha solo se atribuye cuando toda su evidencia coincide.
// La conversación necesita vínculo propio al pedido o etiqueta explícita: ser
// del mismo cliente no demuestra de qué empresa trataba ese chat.
export function crmCompanyEvidence(items) {
  const customerOwners = new Map();
  const conversationOwners = new Map();
  const record = (map, id, owner) => {
    if (!id) return;
    const key = String(id);
    const current = map.get(key);
    map.set(key, current === undefined ? owner : current === owner ? owner : null);
  };
  for (const item of items ?? []) {
    if (item.type !== 'order_intent') continue;
    let order = item.order_json ?? item.orderJson ?? null;
    if (typeof order === 'string') {
      try { order = JSON.parse(order); } catch { order = null; }
    }
    if (!order) {
      let payload = item.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      order = { origin: payload?.origin ?? null,
        customer_id: item.customer_id ?? null,
        conversation_id: item.conversation_id ?? null,
        items: [{ variantId: item.variant_id ?? item.variantId ?? null,
          capsules: Number(item.capsules) || null }] };
    }
    const owner = companyOfOrder(order);
    record(customerOwners, order?.customer_id ?? item.customer_id, owner);
    record(conversationOwners, order?.conversation_id ?? item.conversation_id, owner);
  }
  const resolve = (map, rowOrId) => {
    const row = typeof rowOrId === 'object' ? rowOrId : null;
    const id = row?.id ?? rowOrId;
    const evidence = map.get(String(id));
    const explicit = row?.company_id;
    if (explicit && !validCompanyId(explicit)) return null;
    if (explicit && evidence !== undefined && evidence !== explicit) return null;
    return explicit ?? evidence ?? null;
  };
  return {
    customer: (rowOrId) => resolve(customerOwners, rowOrId),
    conversation: (rowOrId) => resolve(conversationOwners, rowOrId),
  };
}

export async function courierCompanies(db, account) {
  const [rows, companies] = await Promise.all([
    db.list('courier_company_grants', { limit: 5000 }),
    db.list('logistics_companies', { limit: 5000 }),
  ]);
  const active = new Set((companies ?? []).filter((row) => row.active === true).map((row) => row.id));
  const own = (rows ?? []).filter((row) => row.courier_account_id === account.id);
  if (own.length) return own.filter((row) => row.active === true && active.has(row.company_id)).map((row) => row.company_id);
  // Compatibilidad de una cuenta antigua, nunca para cuentas nuevas o revocadas.
  return account.company_id === 'phytoemagry' && active.has('phytoemagry') ? ['phytoemagry'] : [];
}

/*
 * QUIÉN VE QUÉ DENTRO DEL CRM — UNA SOLA REGLA.
 *
 * Esta política la usan por igual las rutas HTTP, los canales en vivo (SSE) y
 * las herramientas de consulta del agente. Si viviera copiada en cada sitio,
 * tarde o temprano dos copias dirían cosas distintas y una de ellas abriría una
 * puerta: por eso está aquí, en un único lugar.
 *
 * Regla: la superadministración central (`admin.full`) ve todo para investigar;
 * el resto solo ve registros cuya empresa esté DEMOSTRADA y sea `phytoemagry`.
 * Sin evidencia (o con evidencia contradictoria) el registro está en cuarentena.
 */
export async function crmOwnership(ctx) {
  const items = await ctx.store.listAdmin({ limit: 5001 });
  const customers = await ctx.db.list('customers', { limit: 5001 });
  const conversations = await ctx.db.list('conversations', { limit: 5001 });
  // Un corte incompleto podría ocultar un pedido ajeno más antiguo. Cerrar.
  const evidence = crmCompanyEvidence(items);
  const customerById = new Map(customers.map((row) => [row.id, row]));
  const conversationById = new Map(conversations.map((row) => [row.id, row]));
  const conversationsByCustomer = new Map();
  for (const row of conversations) {
    const linked = conversationsByCustomer.get(row.customer_id) ?? [];
    linked.push(row);
    conversationsByCustomer.set(row.customer_id, linked);
  }
  return {
    complete: items.length < 5001 && customers.length < 5001 && conversations.length < 5001,
    evidence: {
      customer: (rowOrId) => {
        const row = typeof rowOrId === 'object' ? rowOrId : customerById.get(rowOrId);
        const owner = evidence.customer(row ?? rowOrId);
        if (!owner) return null;
        return (conversationsByCustomer.get(row?.id ?? rowOrId) ?? []).every((conversation) => {
          const linkedOwner = evidence.conversation(conversation);
          return !linkedOwner || linkedOwner === owner;
        }) ? owner : null;
      },
      conversation: (rowOrId) => evidence.conversation(typeof rowOrId === 'object'
        ? rowOrId : conversationById.get(rowOrId) ?? rowOrId),
    },
  };
}

/** ¿El actor puede ver esta fila del CRM? (`kind`: `customer` o `conversation`). */
export function crmRowVisible(actor, ownership, kind, row, can = (permission) => hasPermission(actor, permission)) {
  return can('admin.full') || (Boolean(ownership?.complete) && ownership.evidence[kind](row) === 'phytoemagry');
}

/*
 * ALCANCE ADMINISTRATIVO POR EMPRESA.
 *
 * `delivery.manage` era global: quien lo tenía veía la custodia, las posiciones
 * y las cuentas de reparto de cualquier empresa. Ahora cada persona tiene un
 * alcance explícito (`crm_company_grants`):
 *
 *   - `null`  → superadministración central: todas las empresas.
 *   - Set     → solo las empresas concedidas.
 *
 * Sin concesiones se mantiene el comportamiento histórico (PHYTOEMAGRY), así
 * que este cambio no abre ni cierra nada a quien ya existía. Una empresa que no
 * se puede demostrar (`null`) NO está dentro de ningún alcance parcial.
 */
export async function adminCompanyScope(db, actor, can = (permission) => hasPermission(actor, permission)) {
  if (can('admin.full')) return null;
  const [rows, companies] = await Promise.all([
    db.list('crm_company_grants', { limit: 5000 }),
    db.list('logistics_companies', { limit: 5000 }),
  ]);
  const active = new Set((companies ?? []).filter((row) => row.active === true).map((row) => row.id));
  const own = (rows ?? []).filter((row) => String(row.user_id) === String(actor?.id) && row.active === true);
  if (!own.length) return new Set(active.has('phytoemagry') ? ['phytoemagry'] : []);
  return new Set(own.map((row) => row.company_id).filter((id) => active.has(id)));
}

/** ¿El alcance (de `adminCompanyScope`) incluye esa empresa? */
export function scopeSeesCompany(scope, companyId) {
  if (scope === null) return true;
  if (!companyId || !validCompanyId(companyId)) return false;
  return scope.has(companyId);
}

/**
 * ¿El actor puede recibir avisos de esta empresa?
 *
 * Se usa en los canales EN VIVO, donde no hay una fila que consultar sino un
 * identificador. `null` (empresa no demostrable) NO se reparte al panel
 * ordinario: si no se puede probar de quién es, solo lo ve la central.
 */
export function actorSeesCompany(actor, company, can = (permission) => hasPermission(actor, permission)) {
  return can('admin.full') || company === 'phytoemagry';
}

/**
 * Empresa demostrable de una conversación o de una ficha, SIN recorrer el
 * almacén entero (lo llama el aviso en vivo de cada mensaje).
 *
 * Solo cuenta la etiqueta explícita: si las dos existen y no coinciden, o si no
 * hay ninguna, devuelve `null` (cuarentena). Nunca inventa pertenencia.
 */
export function explicitCrmCompany({ conversation = null, customer = null } = {}) {
  const explicit = [conversation?.company_id, customer?.company_id]
    .map((value) => (value ? String(value) : ''))
    .filter(Boolean);
  if (!explicit.length) return null;
  if (new Set(explicit).size > 1) return null;
  return validCompanyId(explicit[0]) ? explicit[0] : null;
}

export async function authorizedCourierAccount(db, companyId, identity = {}) {
  if (!companyId || !(await activeLogisticsCompany(db, companyId))) return null;
  const accounts = (await db.list('courier_accounts', { limit: 5000 })) ?? [];
  const account = accounts.find((row) => row.active !== false && row.app_access === true && (
    (identity.userId && row.user_id === identity.userId) ||
    (identity.contactId && row.contact_id === identity.contactId) ||
    (identity.phone && row.phone_e164 === identity.phone)
  ));
  if (!account) return null;
  return (await courierCompanies(db, account)).includes(companyId) ? account : null;
}

export function selectedCourierCompany(companies, requested) {
  const id = String(requested ?? '').trim();
  if (id && !companies.includes(id)) return { ok: false, status: 403, error: 'company_forbidden' };
  if (!id && companies.length > 1) return { ok: false, status: 409, error: 'company_selection_required' };
  if (!id && companies.length === 0) return { ok: false, status: 403, error: 'company_forbidden' };
  return { ok: true, companyId: id || companies[0] };
}
