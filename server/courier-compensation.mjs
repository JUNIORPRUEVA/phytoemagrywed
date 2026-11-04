/**
 * COMPENSACIÓN DEL REPARTIDOR — cálculo determinista y por empresa.
 *
 * Reglas de diseño (no negociables):
 *   · El servidor es la autoridad: la app solo muestra lo que aquí se calcula.
 *   · Sin política configurada NO hay importe: se devuelve `null` y la app dice
 *     «pendiente». Nunca se inventa un pago.
 *   · Todo es determinista: mismas entradas → mismo resultado (idempotente).
 *   · El efectivo del cliente NO es ingreso del repartidor: se calculan y se
 *     guardan por separado.
 *
 * Estructura de la política (colección `courier_compensation_policies`):
 * {
 *   company_id,
 *   active: true,
 *   base_model: 'DELIVERY_FEE' | 'FIXED' | 'ZONE',
 *   fixed_fee_cents: int,          // base FIXED
 *   zones: [{ match: 'HIGUEY', label: 'Higüey', fee_cents: 15000 }],
 *   delivery_bonus_cents: int,     // bono fijo por entrega completada
 *   incentives: {
 *     product_fixed:    { enabled: bool },   // usa el monto del producto
 *     product_percent:  { enabled: bool },   // usa el % del producto
 *   },
 *   max_incentive_cents: int|null, // tope de incentivos (no de la base)
 * }
 */

export const BASE_MODELS = new Set(['DELIVERY_FEE', 'FIXED', 'ZONE', 'DISTANCE']);
export const INCENTIVE_TYPES = new Set(['FIXED', 'PERCENTAGE']);

const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

const int = (value) => {
  const n = Math.trunc(Number(value) || 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (value) => Number(Number(value ?? 0).toFixed(2)) || 0;

/** Normaliza la política guardada (tolerante a datos incompletos). */
export function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = fold(raw.base_model ?? raw.baseModel ?? raw.base);
  if (!BASE_MODELS.has(base)) return null;
  const zones = Array.isArray(raw.zones)
    ? raw.zones
        .map((zone) => ({
          match: fold(zone?.match ?? zone?.zone),
          label: String(zone?.label ?? zone?.match ?? '').trim(),
          fee_cents: int(zone?.fee_cents ?? zone?.feeCents),
        }))
        .filter((zone) => zone.match && zone.fee_cents >= 0)
    : [];
  const incentives = raw.incentives ?? {};
  /*
   * PORCENTAJE DEL DELIVERY QUE SE LLEVA EL REPARTIDOR (solo modelo DELIVERY_FEE).
   * 100 = la tarifa completa. Acotado a 0..100: una política no puede pagar más
   * del envío cobrado por esta vía (un extra va por bono, que es explícito).
   */
  const rawPercent = raw.fee_percent ?? raw.feePercent;
  const feePercent =
    rawPercent == null || rawPercent === ''
      ? 100
      : Math.min(100, Math.max(0, Number(rawPercent)));
  const salePercentRaw = raw.product_sale_percent ?? raw.productSalePercent ?? 0;
  const salePercent = Number(salePercentRaw);
  if (!Number.isFinite(salePercent) || salePercent < 0 || salePercent > 100) return null;
  const distancePerKm = raw.distance_per_km_cents ?? raw.distancePerKmCents;
  const distanceBase = raw.distance_base_cents ?? raw.distanceBaseCents;
  if (base === 'DISTANCE' &&
      (!Number.isSafeInteger(distancePerKm) || distancePerKm < 0 ||
       !Number.isSafeInteger(distanceBase) || distanceBase < 0)) return null;
  if (base === 'DISTANCE' && raw.active !== false && distancePerKm === 0) return null;
  return {
    companyId: String(raw.company_id ?? raw.companyId ?? '').trim() || null,
    active: raw.active !== false,
    base,
    feePercent: Number.isFinite(feePercent) ? feePercent : 100,
    fixedFeeCents: int(raw.fixed_fee_cents ?? raw.fixedFeeCents),
    distanceBaseCents: int(raw.distance_base_cents ?? raw.distanceBaseCents),
    distancePerKmCents: int(raw.distance_per_km_cents ?? raw.distancePerKmCents),
    distanceMinimumCents: int(raw.distance_min_cents ?? raw.distanceMinCents),
    productSalePercent: salePercent,
    zones,
    bonusCents: int(raw.delivery_bonus_cents ?? raw.bonusCents),
    productFixedEnabled:
      incentives.product_fixed?.enabled === true || raw.productFixedEnabled === true,
    productPercentEnabled:
      incentives.product_percent?.enabled === true || raw.productPercentEnabled === true,
    maxIncentiveCents:
      (raw.max_incentive_cents ?? raw.maxIncentiveCents) == null
        ? null
        : int(raw.max_incentive_cents ?? raw.maxIncentiveCents),
    /*
     * GUARDIA DE DESPACHO.
     *
     * Apagada por defecto para no romper la asignación de pedidos históricos.
     * Al encenderla, el CRM NO deja asignar un pedido sin local de recogida ni
     * sin política activa: es preferible no despachar a inventar un origen o un
     * importe. Los pedidos ya asignados no se tocan.
     */
    requirePickup: raw.require_pickup === true || raw.requirePickup === true,
    /*
     * CIERRE DE TURNO.
     *   · `shiftRequireApproval` (por defecto SÍ): el cierre del repartidor queda
     *     pendiente hasta que administración lo aprueba.
     *   · `shiftRequireZeroCustody` (por defecto NO): si se enciende, no se cierra
     *     el turno mientras el repartidor deba efectivo.
     */
    shiftRequireApproval: raw.shift_require_approval !== false && raw.shiftRequireApproval !== false,
    shiftRequireZeroCustody:
      raw.shift_require_zero_custody === true || raw.shiftRequireZeroCustody === true,
  };
}

/** La base que cobra el repartidor, según el modelo de la empresa. */
export function baseCompensationCents(order, policy) {
  if (!policy) return 0;
  const deliveryFee = int(
    Math.round(money(order?.delivery_fee ?? order?.delivery?.fee ?? 0) * 100),
  );
  switch (policy.base) {
    case 'DELIVERY_FEE': {
      /* Por defecto la tarifa completa; `fee_percent` permite una parte pactada. */
      const percent = policy.feePercent == null ? 100 : policy.feePercent;
      return Math.max(0, Math.round((deliveryFee * percent) / 100));
    }
    case 'FIXED':
      return Math.max(0, policy.fixedFeeCents);
    case 'ZONE': {
      const zoneName = fold(
        order?.delivery?.zone ??
          order?.delivery?.city ??
          order?.delivery?.location?.city,
      );
      if (!zoneName) return 0;
      const zone =
        policy.zones.find((row) => row.match === zoneName) ??
        policy.zones.find((row) => zoneName.includes(row.match)) ??
        null;
      /* Zona no configurada: 0, no un valor adivinado. */
      return zone ? Math.max(0, zone.fee_cents) : 0;
    }
    case 'DISTANCE': {
      const route = order?.delivery?.route;
      const meters = route?.meters;
      if (!Number.isSafeInteger(meters) || meters <= 0 || !String(route?.provider ?? '').trim()) return 0;
      return Math.max(policy.distanceMinimumCents,
        policy.distanceBaseCents + Math.ceil(meters * policy.distancePerKmCents / 1000));
    }
    default:
      return 0;
  }
}

/**
 * Incentivos por producto.
 *
 * Base del porcentaje: importe de la LÍNEA (precio unitario × cantidad) menos su
 * descuento, excluyendo envío, impuestos y líneas canceladas o devueltas. Nunca
 * se aplica el porcentaje sobre el total del pedido.
 */
export function productIncentives(order, policy) {
  if (!policy) return { cents: 0, lines: [] };
  const items = Array.isArray(order?.items) ? order.items : [];
  const lines = [];
  for (const item of items) {
    const incentive = item?.courier_incentive ?? item?.courierIncentive ?? null;
    if (!incentive || incentive.enabled === false) continue;
    const type = String(incentive.type ?? incentive.incentive_type ?? '').toUpperCase();
    if (!INCENTIVE_TYPES.has(type)) continue;
    if (item?.cancelled === true || item?.refunded === true) continue;

    const quantity = Math.max(0, int(item.quantity ?? item.qty));
    if (quantity === 0) continue;

    const unitPrice = money(item.unitPrice ?? item.price ?? 0);
    const lineDiscount = item.lineDiscountCents != null || item.discount_cents != null
      ? money(Number(item.lineDiscountCents ?? item.discount_cents) / 100)
      : money(item.discount ?? 0);
    const lineNet = Math.max(0, unitPrice * quantity - lineDiscount);

    if (type === 'FIXED' && !policy.productFixedEnabled) continue;
    if (type === 'PERCENTAGE' && !policy.productPercentEnabled) continue;

    const value = Number(incentive.value ?? incentive.amount ?? 0) || 0;
    if (value <= 0) continue;

    const perUnit = incentive.per_unit !== false && incentive.perUnit !== false;
    let cents =
      type === 'FIXED'
        ? Math.round(value * 100) * (perUnit ? quantity : 1)
        : Math.round((lineNet * value) / 100) * 100;

    const cap = incentive.max_amount ?? incentive.maxAmount ?? incentive.max_incentive;
    if (cap != null) {
      const capCents = Math.round(Number(cap) * 100);
      if (capCents > 0) cents = Math.min(cents, capCents);
    }
    if (cents <= 0) continue;

    lines.push({
      name: String(item.label ?? item.name ?? item.productName ?? 'Producto'),
      quantity,
      type,
      value,
      per_unit: perUnit,
      cents,
    });
  }
  return { cents: lines.reduce((sum, line) => sum + line.cents, 0), lines };
}

/** Base neta de productos; excluye envío, impuestos informados y líneas devueltas. */
export function productSaleBaseCents(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  let net = 0;
  for (const item of items) {
    if (item?.cancelled === true || item?.refunded === true) continue;
    const quantity = Number(item?.quantity ?? item?.qty);
    if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
    const unit = item?.unit_price_cents != null
      ? Number(item.unit_price_cents) : Math.round(money(item?.unitPrice ?? item?.price) * 100);
    const discount = item?.lineDiscountCents ?? item?.discount_cents ??
      Math.round(money(item?.discount) * 100);
    const tax = Number(item?.tax_cents ?? 0);
    if (![unit, discount, tax].every(Number.isSafeInteger) || unit < 0 || discount < 0 || tax < 0) return null;
    net += Math.max(0, unit * quantity - discount - tax);
  }
  const generalDiscount = order?.discount_cents != null
    ? Number(order.discount_cents) : Math.round(money(order?.discount) * 100);
  if (!Number.isSafeInteger(generalDiscount) || generalDiscount < 0) return null;
  return Number.isSafeInteger(net) ? Math.max(0, net - generalDiscount) : null;
}

/**
 * Cálculo completo. Devuelve `null` cuando la empresa no tiene política activa:
 * así la app muestra «pendiente» en vez de un cero falso.
 */
export function computeCourierCompensation({ order, policy, confirmed = false } = {}) {
  const normalized = normalizePolicy(policy);
  if (!normalized || normalized.active !== true) return null;
  if (normalized.base === 'DISTANCE' &&
      (!Number.isSafeInteger(order?.delivery?.route?.meters) || order.delivery.route.meters <= 0 ||
       !String(order.delivery.route.provider ?? '').trim())) return null;

  const baseCents = baseCompensationCents(order, normalized);
  const incentives = productIncentives(order, normalized);
  const saleBaseCents = normalized.productSalePercent > 0 ? productSaleBaseCents(order) : 0;
  if (saleBaseCents === null) return null;
  const saleCommissionCents = Math.round(saleBaseCents * normalized.productSalePercent / 100);
  let incentiveCents = incentives.cents + saleCommissionCents;
  if (
    normalized.maxIncentiveCents != null &&
    normalized.maxIncentiveCents > 0 &&
    incentiveCents > normalized.maxIncentiveCents
  ) {
    incentiveCents = normalized.maxIncentiveCents;
  }
  const bonusCents = Math.max(0, normalized.bonusCents);
  const totalCents = baseCents + incentiveCents + bonusCents;

  return {
    base_cents: baseCents,
    incentive_cents: incentiveCents,
    bonus_cents: bonusCents,
    total_cents: totalCents,
    /* La app distingue estimado (oferta) de definitivo (entrega validada). */
    estimated: confirmed !== true,
    breakdown: {
      base_model: normalized.base,
      incentive_lines: incentives.lines,
      product_sale_base_cents: saleBaseCents,
      product_sale_commission_cents: saleCommissionCents,
      incentive_capped:
        incentives.cents > incentiveCents && incentiveCents !== incentives.cents,
      max_incentive_cents: normalized.maxIncentiveCents,
      policy_snapshot: {
        base_model: normalized.base,
        fee_percent: normalized.feePercent,
        fixed_fee_cents: normalized.fixedFeeCents,
        distance_base_cents: normalized.distanceBaseCents,
        distance_per_km_cents: normalized.distancePerKmCents,
        distance_min_cents: normalized.distanceMinimumCents,
        product_sale_percent: normalized.productSalePercent,
        route: normalized.base === 'DISTANCE' ? { ...order.delivery.route } : null,
        bonus_cents: normalized.bonusCents,
        product_fixed: normalized.productFixedEnabled,
        product_percent: normalized.productPercentEnabled,
        max_incentive_cents: normalized.maxIncentiveCents,
      },
    },
  };
}
