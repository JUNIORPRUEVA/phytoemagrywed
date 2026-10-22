/**
 * OPORTUNIDADES COMERCIALES — lectura acotada, con evidencia.
 *
 * Qué es
 *   Un resumen ESTRUCTURADO de lo que se puede ver en el CRM para el Agente de
 *   Seguimiento: quién compró y no ha vuelto, quién escribió y sigue sin
 *   respuesta, qué pedidos quedaron sin confirmar, quién compra seguido.
 *
 * Reglas que respeta a propósito
 *   - SOLO lectura: no crea, no mueve, no envía nada.
 *   - Solo lo que esa persona puede ver: administración todo; un agente, las
 *     conversaciones que lleva (misma regla que la pantalla de seguimientos).
 *   - NO se inventa consumo ni intención: cada fila lleva su EVIDENCIA (fechas,
 *     número de compras, estado del pedido) y se presenta como recomendación.
 *   - NO se incluyen clientes con `do_not_contact` ni con baja de WhatsApp.
 *   - Límites duros: como mucho 5000 pedidos y 8 filas por bloque, para que el
 *     modelo nunca reciba la base entera.
 */

const ORDER_TYPES_DELIVERED = new Set(['entregado']);
const ORDER_OPEN = new Set(['nuevo', 'confirmado', 'en_preparacion', 'enviado']);

const TZ = 'America/Santo_Domingo';

function dayInZone(value, timeZone = TZ) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (tipo) => parts.find((entry) => entry.type === tipo)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const days = (nowMs, iso) => {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86400000));
};

const hours = (nowMs, iso) => {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 3600000));
};

const nameOf = (row) => String(row?.customer?.name ?? row?.name ?? '').trim() || 'Cliente';

/** Un cliente no se contacta si lo pidió o si se dio de baja de WhatsApp. */
const blocked = (customer) =>
  Boolean(customer && (customer.do_not_contact === true || customer.whatsapp_opt_out_at));

/**
 * Foto comercial acotada.
 * @param {{ctx:any, can:(p:string)=>boolean, actor:any, limits?:{rows?:number, reposicionDias?:number}}} input
 */
export async function commercialSnapshot({ ctx, can, actor, limits = {} }) {
  const now = (ctx?.clock ?? (() => new Date()))();
  const nowMs = now.getTime();
  const maxRows = Math.max(1, Math.min(20, Number(limits.rows ?? 8)));
  const reposicionDias = Math.max(1, Number(limits.reposicionDias ?? 21));

  /* Visibilidad: la MISMA regla que la pantalla de seguimientos. */
  const seesAll = can('chats.force_reassign') || !actor?.id || actor.actor_type !== 'USER';
  const visible = (row) =>
    seesAll || String(row.assigned_user_id ?? row.assigned_to ?? '') === String(actor?.id ?? '');

  const [conversations, ordersRaw, buckets] = await Promise.all([
    ctx.customers.listConversations({}),
    /* El almacén local devuelve el array ya hecho: se normaliza con Promise. */
    Promise.resolve(ctx.store.listAdmin({ limit: 5000 })).then((rows) => rows ?? []),
    ctx.followups.buckets(),
  ]);

  const conversaciones = (conversations ?? [])
    .filter((row) => !row.deleted_at && !row.empty && visible(row))
    .filter((row) => !row.archived_at);
  const ordenes = ordersRaw.filter((row) => row.type === 'order_intent');

  const sinContacto = conversaciones.filter((row) => blocked(row.customer)).length;
  const contactables = conversaciones.filter((row) => !blocked(row.customer));

  /* ------------------------------------------------------------ recompra */
  const recompraTodas = contactables
    .filter((row) => row.has_purchase === true && !row.active_order && row.last_purchase_at)
    .map((row) => ({
      customerId: row.customer_id,
      nombre: nameOf(row),
      diasDesdeUltimaCompra: days(nowMs, row.last_purchase_at),
      ultimaCompra: row.last_purchase_at,
      etapa: row.customer_stage ?? null,
      etiquetas: (row.tags ?? []).slice(0, 4),
      motivo: 'Compró antes y no tiene pedido abierto',
    }))
    .filter((row) => Number(row.diasDesdeUltimaCompra ?? 0) >= reposicionDias)
    .sort((a, b) => Number(b.diasDesdeUltimaCompra ?? 0) - Number(a.diasDesdeUltimaCompra ?? 0));

  /* -------------------------------------------------------- recuperación */
  const sinResponder = contactables
    .filter((row) => row.awaiting_reply === true)
    .map((row) => ({
      customerId: row.customer_id,
      nombre: nameOf(row),
      horasSinResponder: hours(nowMs, row.last_inbound_at ?? row.last_message?.at),
      ultimoMensaje: String(row.last_message?.body ?? '').slice(0, 120),
      etapa: row.customer_stage ?? null,
      motivo: 'El último mensaje lo escribió el cliente y nadie contestó',
    }))
    .sort((a, b) => Number(b.horasSinResponder ?? 0) - Number(a.horasSinResponder ?? 0));

  const pedidosSinConfirmar = ordenes
    .filter((row) => {
      const order = parseOrder(row);
      const status = String(order?.status ?? row.status ?? '').toLowerCase();
      if (status !== 'nuevo' && status !== 'confirmado') return false;
      const edad = days(nowMs, row.received_at ?? order?.created_at);
      return Number(edad ?? 0) >= 2;
    })
    .map((row) => {
      const order = parseOrder(row);
      return {
        orderId: row.id,
        numero: order?.order_number ?? row.order_number ?? row.id,
        nombre: String(row.name ?? 'Cliente').slice(0, 60),
        estado: String(order?.status ?? row.status ?? ''),
        dias: days(nowMs, row.received_at ?? order?.created_at),
        total: Number(order?.total ?? row.total ?? 0) || 0,
        motivo: 'Pedido sin terminar hace 2 días o más',
      };
    })
    .sort((a, b) => Number(b.dias ?? 0) - Number(a.dias ?? 0));

  const vencidos = (buckets?.overdue ?? []).filter((row) => visible({ assigned_user_id: row.assigned_user_id }));

  /* --------------------------------------------------------- fidelización */
  const comprasPorCliente = new Map();
  for (const row of ordenes) {
    const order = parseOrder(row);
    const status = String(order?.status ?? row.status ?? '').toLowerCase();
    if (!ORDER_TYPES_DELIVERED.has(status)) continue;
    const customerId = order?.customer_id ?? row.customer_id ?? null;
    if (!customerId) continue;
    const actual = comprasPorCliente.get(customerId) ?? { pedidos: 0, total: 0, ultima: null, nombre: '' };
    actual.pedidos += 1;
    actual.total += Number(order?.total ?? row.total ?? 0) || 0;
    const cuando = order?.delivered_at ?? row.received_at;
    if (!actual.ultima || String(cuando) > String(actual.ultima)) {
      actual.ultima = cuando;
      actual.nombre = String(row.name ?? actual.nombre ?? 'Cliente').slice(0, 60);
    }
    comprasPorCliente.set(customerId, actual);
  }
  const fieles = [...comprasPorCliente.entries()]
    .filter(([, datos]) => datos.pedidos >= 2)
    .map(([customerId, datos]) => ({
      customerId,
      nombre: datos.nombre || 'Cliente',
      pedidos: datos.pedidos,
      total: Math.round(datos.total * 100) / 100,
      diasDesdeUltimaCompra: days(nowMs, datos.ultima),
    }))
    .sort((a, b) => b.pedidos - a.pedidos || b.total - a.total);

  return {
    at: now.toISOString(),
    today: dayInZone(now),
    timeZone: TZ,
    scope: seesAll ? 'all' : 'own',
    revisado: {
      conversaciones: conversaciones.length,
      pedidos: ordenes.length,
      truncado: ordersRaw.length >= 5000,
    },
    recompra: {
      total: recompraTodas.length,
      criterio: `compra anterior, sin pedido abierto y ${reposicionDias}+ días desde la última`,
      filas: recompraTodas.slice(0, maxRows),
    },
    recuperacion: {
      sinResponder: { total: sinResponder.length, filas: sinResponder.slice(0, maxRows) },
      pedidosSinConfirmar: { total: pedidosSinConfirmar.length, filas: pedidosSinConfirmar.slice(0, maxRows) },
      seguimientosVencidos: vencidos.length,
    },
    fidelizacion: { total: fieles.length, filas: fieles.slice(0, maxRows) },
    excluidos: { sinContacto },
    /*
     * Lo que ESTE resumen no sabe: se dice en vez de inventarlo. Las
     * cotizaciones del POS viven en otro almacén (documentos del ticket), así
     * que no se cuentan aquí todavía.
     */
    noIncluido: ['cotizaciones del POS (documento del ticket, no ligado al cliente en este resumen)'],
  };
}

function parseOrder(row) {
  const raw = row?.order_json ?? row?.orderJson ?? null;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { ORDER_OPEN };
