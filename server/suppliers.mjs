/**
 * TIENDAS PROVEEDORAS Y PRODUCTOS DE TERCEROS.
 *
 * QUÉ RESUELVE
 * En FullTECH no todo lo que se vende está en el almacén: hay artículos que se
 * compran en una tienda concreta cuando el cliente los pide. Para venderlos sin
 * inventar existencias hacen falta tres cosas:
 *
 *   1. Un registro de TIENDAS con su ubicación real (latitud/longitud).
 *   2. La relación PRODUCTO ↔ TIENDA (costo en esa tienda, disponibilidad,
 *      tiempo de recogida, observaciones).
 *   3. Agrupar los artículos de un pedido POR TIENDA, para que el repartidor
 *      haga UNA recogida por establecimiento y no una por artículo.
 *
 * REGLAS QUE NO SE ROMPEN
 *   - No se inventan coordenadas: si faltan, la tienda queda «Ubicación
 *     pendiente» y así se dice en la interfaz.
 *   - «Disponibilidad» es lo que alguien confirmó, no lo que se supone: sin
 *     fecha de verificación es `unknown`.
 *   - Los productos de terceros NO descuentan stock propio.
 *   - Las recogidas son idempotentes: pedir dos veces los grupos del mismo
 *     pedido no crea recogidas duplicadas.
 */

export const PRODUCT_TYPES = Object.freeze(['own', 'third_party', 'quick_sale']);

export const PICKUP_STATUSES = Object.freeze([
  'pending_purchase',
  'assigned',
  'on_the_way',
  'purchased',
  'to_customer',
  'delivered',
  'issue',
]);

const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });

const clean = (value, max = 160) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Un número dentro de un rango, o null. Nunca «0» por defecto: 0 es una coordenada válida. */
function coordinate(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

/**
 * Saca coordenadas de un enlace de Google Maps, si las lleva.
 * Se aceptan las formas habituales y NO se inventa nada: si no hay números
 * claros, devuelve null y la interfaz pedirá marcarlas en el mapa.
 */
export function coordinatesFromMapsLink(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const patterns = [
    /@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/, // .../@19.123,-70.456,17z
    /[?&]q=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i, // ?q=19.123,-70.456
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/, // !3d19.123!4d-70.456
    /ll=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i, // ll=19.123,-70.456
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const lat = coordinate(match[1], -90, 90);
    const lng = coordinate(match[2], -180, 180);
    if (lat !== null && lng !== null) return { lat, lng };
  }
  return null;
}

/** Normaliza lo que llega de la interfaz. Devuelve solo campos conocidos. */
export function normalizeSupplier(input = {}) {
  const name = clean(input.name, 120);
  if (name.length < 2) throw fail('invalid_name', 'Escribe el nombre de la tienda.');
  const phone = clean(input.phone, 40);
  const address = clean(input.address, 200);
  const province = clean(input.province, 80);
  const municipality = clean(input.municipality, 80);
  const sector = clean(input.sector, 80);
  const mapsUrl = clean(input.maps_url ?? input.mapsUrl, 500);
  const references = clean(input.references, 300);
  const hours = clean(input.hours, 160);
  const notes = clean(input.notes, 500);

  let lat = coordinate(input.lat, -90, 90);
  let lng = coordinate(input.lng, -180, 180);
  if ((lat === null || lng === null) && mapsUrl) {
    const fromLink = coordinatesFromMapsLink(mapsUrl);
    if (fromLink) {
      lat = fromLink.lat;
      lng = fromLink.lng;
    }
  }
  if ((lat === null) !== (lng === null)) {
    throw fail('invalid_coordinates', 'La ubicación necesita latitud y longitud juntas.');
  }
  if (mapsUrl && !/^https?:\/\//i.test(mapsUrl)) throw fail('invalid_maps_url', 'El enlace de Maps debe empezar por http.');

  return {
    name,
    phone,
    address,
    province,
    municipality,
    sector,
    lat,
    lng,
    maps_url: mapsUrl || null,
    references,
    hours,
    notes,
    active: input.active === undefined ? true : Boolean(input.active),
  };
}

/** ¿Se puede llevar al repartidor a esta tienda? Sin coordenadas, no. */
export function locationStatus(supplier) {
  return supplier && Number.isFinite(supplier.lat) && Number.isFinite(supplier.lng) ? 'ok' : 'pending';
}

/** Clave para no duplicar tiendas: nombre y teléfono, sin mayúsculas ni acentos. */
export function supplierKey(input = {}) {
  const normal = (value) =>
    String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${normal(input.name)}|${String(input.phone ?? '').replace(/\D/g, '')}`;
}

/** Normaliza la relación producto ↔ tienda. */
export function normalizeProductSupplier(input = {}) {
  const supplierId = clean(input.supplier_id ?? input.supplierId, 80);
  if (!supplierId) throw fail('missing_supplier', 'Elige la tienda.');
  const cost = input.cost_cents ?? input.costCents;
  const costCents = cost === null || cost === undefined || cost === '' ? null : Math.round(Number(cost));
  if (costCents !== null && (!Number.isFinite(costCents) || costCents < 0 || costCents > 1e10)) {
    throw fail('invalid_cost', 'El costo en esa tienda no es válido.');
  }
  const availability = ['available', 'unavailable', 'unknown'].includes(input.availability)
    ? input.availability
    : 'unknown';
  // «Disponible» sin fecha de verificación no es una confirmación.
  const verifiedAt = availability === 'available' ? clean(input.verified_at ?? input.verifiedAt, 40) || null : null;
  return {
    supplier_id: supplierId,
    cost_cents: costCents,
    supplier_code: clean(input.supplier_code ?? input.supplierCode, 80),
    availability: availability === 'available' && !verifiedAt ? 'unknown' : availability,
    verified_at: verifiedAt,
    pickup_eta_minutes:
      input.pickup_eta_minutes === null || input.pickup_eta_minutes === undefined || input.pickup_eta_minutes === ''
        ? null
        : Math.max(0, Math.round(Number(input.pickup_eta_minutes))),
    notes: clean(input.notes, 300),
  };
}

/**
 * AGRUPACIÓN POR TIENDA — el corazón de la recogida.
 *
 * Recibe las líneas del pedido y devuelve un grupo por tienda con sus artículos,
 * cantidades y costo estimado. Las líneas sin tienda (venta rápida sin proveedor
 * o producto propio) NO entran: no hay nada que recoger.
 *
 * `items` espera, por línea: { name, quantity, product_type, supplier_id,
 * supplier_name, cost_cents }. Es tolerante con los nombres del carrito
 * (`manual.name`, `variantName`) para no duplicar estructuras.
 */
export function groupItemsBySupplier(items = []) {
  const groups = new Map();
  for (const item of items) {
    const supplierId = clean(item.supplier_id ?? item.supplierId, 80);
    const type = item.product_type ?? item.productType ?? '';
    // Solo se recoge lo que viene de una tienda.
    if (!supplierId || (type && type !== 'third_party' && type !== 'quick_sale')) continue;
    const quantity = Math.max(0, Math.round(Number(item.quantity ?? 1)));
    if (!quantity) continue;
    const name = clean(item.name ?? item.manual?.name ?? item.variantName ?? item.productName, 160);
    const unitCost = Math.round(
      Number(
        item.supplier_cost_cents ??
          item.supplierCostCents ??
          item.cost_cents ??
          item.costCents ??
          item.manual?.cost_cents ??
          0,
      ) || 0,
    );
    const key = supplierId;
    if (!groups.has(key)) {
      groups.set(key, {
        supplier_id: supplierId,
        supplier_name: clean(item.supplier_name ?? item.supplierName, 120) || null,
        items: [],
        quantity: 0,
        cost_cents: 0,
      });
    }
    const group = groups.get(key);
    group.items.push({ name, quantity, unit_cost_cents: unitCost });
    group.quantity += quantity;
    group.cost_cents += unitCost * quantity;
  }
  return [...groups.values()].sort((a, b) => a.supplier_id.localeCompare(b.supplier_id));
}

/** Crea/actualiza las recogidas de un pedido sin duplicarlas (por tienda). */
export async function syncOrderPickups(db, { order, suppliers, clock = () => new Date() }) {
  const groups = groupItemsBySupplier(order?.items ?? []);
  const created = [];
  for (const group of groups) {
    const key = `pickup:${order.id}:${group.supplier_id}`;
    const existing = await db.findBy('order_pickups', 'idempotency_key', key);
    const supplier = suppliers.find((row) => row.id === group.supplier_id) ?? null;
    const doc = {
      id: key,
      order_id: order.id,
      customer_id: order.customer_id ?? existing?.customer_id ?? null,
      supplier_id: group.supplier_id,
      supplier_name: supplier?.name ?? group.supplier_name,
      items: group.items,
      quantity: group.quantity,
      cost_cents: group.cost_cents,
      location_status: locationStatus(supplier),
      status: existing?.status ?? 'pending_purchase',
      assigned_to: existing?.assigned_to ?? null,
      invoice_attached: existing?.invoice_attached ?? false,
      invoice_id: existing?.invoice_id ?? null,
      paid: existing?.paid === true,
      paid_at: existing?.paid_at ?? null,
      paid_by: existing?.paid_by ?? null,
      note: existing?.note ?? '',
      idempotency_key: key,
      created_at: existing?.created_at ?? clock().toISOString(),
      updated_at: clock().toISOString(),
    };
    if (existing) {
      const sameItems = JSON.stringify(existing.items) === JSON.stringify(doc.items);
      if (sameItems && existing.cost_cents === doc.cost_cents) continue;
      await db.update('order_pickups', key, doc);
      created.push(doc);
      continue;
    }
    await db.insert('order_pickups', doc);
    created.push(doc);
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * FACTURAS DE PROVEEDOR
 *
 * El comprobante ORIGINAL de la tienda. Es documentación interna:
 * nunca viaja al cliente ni al PDF de la venta FULLTECH.
 * Se aceptan PDF, JPG y PNG, y el tipo se decide mirando los bytes
 * (no la cabecera que manda el navegador, que puede mentir).
 * ------------------------------------------------------------------ */

export const INVOICE_MAX_BYTES = 4 * 1024 * 1024;

const INVOICE_SIGNATURES = [
  { mime: 'application/pdf', ext: 'pdf', test: (bytes) => bytes.subarray(0, 4).toString('latin1') === '%PDF' },
  { mime: 'image/jpeg', ext: 'jpg', test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
];

/** Comprueba el archivo real (magic bytes). Devuelve `{mime, ext, size, base64}`. */
export function detectInvoiceFile(input = {}) {
  const raw = String(input.base64 ?? input.data_url ?? input.dataUrl ?? '').trim();
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw fail('invalid_file', 'No se ha podido leer el archivo. Vuelve a elegirlo.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw fail('invalid_file', 'El archivo está vacío.');
  if (bytes.length > INVOICE_MAX_BYTES) {
    throw fail('too_large', 'El archivo supera 4 MB. Escanéalo en blanco y negro o guárdalo en JPG.');
  }
  const signature = INVOICE_SIGNATURES.find((entry) => entry.test(bytes));
  if (!signature) throw fail('unsupported_type', 'Solo se aceptan facturas en PDF, JPG o PNG.');
  return { mime: signature.mime, ext: signature.ext, size: bytes.length, base64: bytes.toString('base64') };
}

/**
 * Normaliza la factura que llega del panel. Una factura puede cubrir VARIAS
 * recogidas (varias líneas del mismo pedido compradas en la misma tienda).
 */
export function normalizeSupplierInvoice(input = {}) {
  const orderId = clean(input.order_id ?? input.orderId, 80);
  if (!orderId) throw fail('missing_order', 'La factura tiene que ir ligada a un pedido.');
  const supplierId = clean(input.supplier_id ?? input.supplierId, 80);
  if (!supplierId) throw fail('missing_supplier', 'Elige la tienda de esa factura.');
  const file = detectInvoiceFile(input);
  const total = input.total_cents ?? input.totalCents;
  const totalCents = total === null || total === undefined || total === '' ? null : Math.round(Number(total));
  if (totalCents !== null && (!Number.isFinite(totalCents) || totalCents < 0)) {
    throw fail('invalid_total', 'El total de la factura no es válido.');
  }
  const pickupIds = Array.isArray(input.pickup_ids ?? input.pickupIds) ? input.pickup_ids ?? input.pickupIds : [];
  return {
    order_id: orderId,
    supplier_id: supplierId,
    invoice_number: clean(input.invoice_number ?? input.invoiceNumber, 60) || null,
    total_cents: totalCents,
    note: clean(input.note, 300),
    file,
    pickup_ids: [...new Set(pickupIds.map((value) => clean(value, 120)).filter(Boolean))],
  };
}
