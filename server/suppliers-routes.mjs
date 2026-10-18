/**
 * RUTAS DE TIENDAS PROVEEDORAS, ENLACES CON PRODUCTOS Y RECOGIDAS.
 *
 * Mismo patrón que `store-catalog-routes.mjs`: se registran antes del resto de
 * rutas del catálogo, leen el permiso del actor y responden con `{ok:true}`.
 *
 * LECTURA  → `orders.read` (quien puede vender tiene que saber dónde se compra).
 * ESCRITURA → solo ADMIN, igual que editar un producto o su stock.
 */
import {
  PICKUP_STATUSES,
  groupItemsBySupplier,
  locationStatus,
  normalizeProductSupplier,
  normalizeSupplier,
  normalizeSupplierInvoice,
  supplierKey,
  syncOrderPickups,
} from './suppliers.mjs';

const ID = '[a-zA-Z0-9_.:%-]+';

/** Texto corto y sin basura, para los filtros de la URL. */
const limpiar = (value, max = 120) => String(value ?? '').trim().slice(0, max);

export async function handleSupplierRoutes({ req, res, route, ctx, actor, json, readJson, can, sanitize }) {
  /*
   * Rutas propias: tiendas, recogidas, enlaces de producto y tipo de producto.
   * OJO: las recogidas cuelgan de `/orders/:id/pickups`, así que el filtro de
   * entrada tiene que incluirlas o el manejador no se ejecuta nunca.
   */
  const esRuta =
    /^\/api\/admin\/(suppliers|pickups|supplier-invoices|quick-sales)\b/.test(route) ||
    /^\/api\/admin\/products\//.test(route) ||
    /^\/api\/admin\/orders\/[^/]+\/pickups$/.test(route);
  if (!esRuta) return false;
  const send = (status, body) => {
    json(res, status, body);
    return true;
  };
  /*
   * EL REPARTIDOR ENTRA A SUS RECOGIDAS.
   *
   * Antes estas rutas exigían `orders.read`, que un DELIVERY no tiene: desde
   * «Mis entregas» no podía ni ver las recogidas de su propio pedido. Ahora
   * entra quien tiene `orders.read` (administración/agentes) o quien puede
   * iniciar una entrega (repartidor), y cada acción comprueba que el pedido sea
   * SUYO.
   */
  const canReadOrders = can('orders.read');
  const canDeliverOwn = can('delivery.tracking.start');
  if (!canReadOrders && !canDeliverOwn) return send(403, { ok: false, error: 'forbidden' });
  const db = ctx.db;
  const clock = ctx.clock ?? (() => new Date());
  const isAdmin = actor?.role === 'ADMIN';

  /** El pedido REAL y si este usuario es quien lo lleva. */
  const orderForActor = async (orderId) => {
    if (!orderId) return null;
    const rows = await ctx.store.listAdmin({ limit: 5000 });
    const row = rows.find((candidate) => candidate.id === orderId);
    if (!row) return null;
    let order = null;
    try {
      order = JSON.parse(row.order_json ?? row.orderJson ?? 'null');
    } catch {
      order = null;
    }
    if (!order) return null;
    order.id = order.id ?? orderId;
    return { row, order, mine: String(order?.delivery?.delivery_user_id ?? '') === String(actor?.id ?? '') };
  };

  /** Quien no administra no ve costos ni el estado de pago de la compra. */
  const publicPickups = (rows) =>
    isAdmin ? rows : rows.map(({ cost_cents, paid, paid_at, paid_by, ...rest }) => rest);

  const supplierMatch = new RegExp(`^/api/admin/suppliers/(${ID})$`).exec(route);
  const linkMatch = new RegExp(`^/api/admin/products/(${ID})/suppliers(?:/(${ID}))?$`).exec(route);
  const typeMatch = new RegExp(`^/api/admin/products/(${ID})/type$`).exec(route);
  const pickupListMatch = new RegExp(`^/api/admin/orders/(${ID})/pickups$`).exec(route);
  const pickupMatch = new RegExp(`^/api/admin/pickups/(${ID})$`).exec(route);

  try {
    // ------------------------------------------- tipo comercial del producto
    if (typeMatch) {
      if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
      if (req.method !== 'PATCH') return send(405, { ok: false, error: 'method_not_allowed' });
      if (!ctx.storeCatalog) return send(503, { ok: false, error: 'catalog_unavailable' });
      const body = await readJson(req, 8000);
      const product = await ctx.storeCatalog.setProductType(typeMatch[1], body.product_type, actor);
      return send(200, { ok: true, product });
    }
    // ------------------------------------------------------------- tiendas
    if (route === '/api/admin/suppliers' && req.method === 'GET') {
      const suppliers = (await db.list('suppliers', { by: 'name', order: 'asc' })).map((row) => ({
        ...row,
        location_status: locationStatus(row),
      }));
      return send(200, { ok: true, suppliers: sanitize ? sanitize(suppliers) : suppliers, canManage: isAdmin });
    }

    if (route === '/api/admin/suppliers' && req.method === 'POST') {
      if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
      const body = normalizeSupplier(await readJson(req, 40000));
      const key = supplierKey(body);
      const all = await db.list('suppliers', { limit: 5000 });
      const duplicate = all.find((row) => supplierKey(row) === key);
      if (duplicate) {
        return send(409, {
          ok: false,
          error: 'duplicate_supplier',
          message: `Ya existe «${duplicate.name}» con ese teléfono.`,
          supplier: duplicate,
        });
      }
      const supplier = {
        ...body,
        name_key: key,
        id: `sup_${clock().getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        created_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      };
      await db.insert('suppliers', supplier);
      return send(201, { ok: true, supplier: { ...supplier, location_status: locationStatus(supplier) } });
    }

    if (supplierMatch) {
      const id = supplierMatch[1];
      if (req.method === 'GET') {
        const supplier = await db.get('suppliers', id);
        if (!supplier) return send(404, { ok: false, error: 'not_found' });
        const links = (await db.list('product_suppliers', { limit: 5000 })).filter((row) => row.supplier_id === id);
        return send(200, {
          ok: true,
          supplier: { ...supplier, location_status: locationStatus(supplier) },
          links: sanitize ? sanitize(links) : links,
        });
      }
      if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
      if (req.method === 'DELETE') {
        const removed = await db.remove('suppliers', id);
        if (!removed) return send(404, { ok: false, error: 'not_found' });
        return send(200, { ok: true });
      }
      if (req.method !== 'PATCH') return send(405, { ok: false, error: 'method_not_allowed' });
      const current = await db.get('suppliers', id);
      if (!current) return send(404, { ok: false, error: 'not_found' });
      const body = normalizeSupplier({ ...current, ...(await readJson(req, 40000)) });
      const key = supplierKey(body);
      const all = await db.list('suppliers', { limit: 5000 });
      const duplicate = all.find((row) => row.id !== id && supplierKey(row) === key);
      if (duplicate) {
        return send(409, {
          ok: false,
          error: 'duplicate_supplier',
          message: `Ya existe «${duplicate.name}» con ese teléfono.`,
        });
      }
      const supplier = await db.update('suppliers', id, {
        ...body,
        name_key: key,
        updated_at: clock().toISOString(),
      });
      return send(200, { ok: true, supplier: { ...supplier, location_status: locationStatus(supplier) } });
    }

    // ------------------------------------------- producto ↔ tienda
    if (linkMatch) {
      const productId = linkMatch[1];
      const supplierId = linkMatch[2];
      if (req.method === 'GET') {
        const links = (await db.list('product_suppliers', { limit: 5000 }))
          .filter((row) => row.product_id === productId)
          .map((row) => ({ ...row }));
        return send(200, { ok: true, links: sanitize ? sanitize(links) : links });
      }
      if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
      if (req.method === 'DELETE') {
        if (!supplierId) return send(400, { ok: false, error: 'missing_supplier' });
        const all = await db.list('product_suppliers', { limit: 5000 });
        const link = all.find((row) => row.product_id === productId && row.supplier_id === supplierId);
        if (!link) return send(404, { ok: false, error: 'not_found' });
        await db.remove('product_suppliers', link.id);
        return send(200, { ok: true });
      }
      if (req.method !== 'POST' && req.method !== 'PATCH') return send(405, { ok: false, error: 'method_not_allowed' });
      const body = normalizeProductSupplier({
        ...(await readJson(req, 40000)),
        ...(supplierId ? { supplier_id: supplierId } : {}),
      });
      const supplier = await db.get('suppliers', body.supplier_id);
      if (!supplier) return send(422, { ok: false, error: 'unknown_supplier', message: 'Esa tienda no existe.' });
      const all = await db.list('product_suppliers', { limit: 5000 });
      const existing = all.find((row) => row.product_id === productId && row.supplier_id === body.supplier_id);
      const doc = {
        ...body,
        id: existing?.id ?? `psup_${productId}_${body.supplier_id}`,
        product_id: productId,
        supplier_name: supplier.name,
        link_key: `${productId}:${body.supplier_id}`,
        created_at: existing?.created_at ?? clock().toISOString(),
        updated_at: clock().toISOString(),
      };
      if (existing) await db.update('product_suppliers', doc.id, doc);
      else await db.insert('product_suppliers', doc);
      return send(existing ? 200 : 201, { ok: true, link: doc });
    }

    // ------------------------------------------------- recogidas del pedido
    if (route === '/api/admin/quick-sales' && req.method === 'GET') {
      /*
       * VENTAS FUERA DE INVENTARIO.
       *
       * Se vendió algo que no estaba en el catálogo. Si se repite, interesa
       * convertirlo en producto permanente: aquí se listan las líneas que
       * todavía no son un producto para que alguien (ADMIN) decida.
       */
      let orders = [];
      try {
        orders = await ctx.store.listAdmin({ limit: 500 });
      } catch {
        orders = [];
      }
      const lines = [];
      for (const row of orders) {
        let order = null;
        try {
          order = JSON.parse(row.order_json ?? row.orderJson ?? 'null');
        } catch {
          order = null;
        }
        for (const item of order?.items ?? []) {
          const manual = item.manual === true || item.product_type === 'quick_sale' || /^manual_/.test(String(item.variantId ?? ''));
          if (!manual) continue;
          lines.push({
            order_id: order.id ?? row.id,
            order_number: order.order_number ?? row.order_number ?? null,
            created_at: order.created_at ?? row.created_at ?? null,
            variant_id: item.variantId ?? null,
            name: item.label ?? item.variantName ?? '',
            quantity: Number(item.quantity) || 1,
            price_cents: Math.round(Number(item.unitPrice ?? 0) * 100),
            cost_cents: Number(item.unit_cost_snapshot_cents ?? 0),
            supplier_id: item.supplier_id ?? null,
            supplier_name: item.supplier_name ?? null,
          });
        }
      }
      return send(200, { ok: true, lines: lines.slice(0, 200), canManage: isAdmin });
    }

    // ------------------------------------------------- recogidas del pedido
    if (route === '/api/admin/pickups' && req.method === 'GET') {
      /*
       * TABLERO DE RECOGIDAS: todas las compras pendientes en tiendas, con el
       * número de pedido para poder hablar de ellas sin buscar el id interno.
       */
      const url = new URL(req.url ?? route, 'http://local');
      const status = limpiar(url.searchParams.get('status'), 40);
      const rows = (await db.list('order_pickups', { limit: 5000 }))
        .filter((row) => !status || row.status === status)
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      let orderNumbers = new Map();
      try {
        const orders = await ctx.store.listAdmin({ limit: 2000 });
        orderNumbers = new Map(orders.map((row) => [row.id, row.order_number ?? null]));
      } catch {
        orderNumbers = new Map();
      }
      return send(200, {
        ok: true,
        pickups: rows.map((row) => ({ ...row, order_number: orderNumbers.get(row.order_id) ?? null })),
        canManage: isAdmin,
      });
    }

    // ------------------------------------------- facturas de proveedor
    if (/^\/api\/admin\/supplier-invoices\b/.test(route)) {
      const invoiceFileMatch = new RegExp(`^/api/admin/supplier-invoices/(${ID})/file$`).exec(route);
      const invoiceMatch = new RegExp(`^/api/admin/supplier-invoices/(${ID})$`).exec(route);

      if (invoiceFileMatch) {
        if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
        const row = await db.get('supplier_invoices', decodeURIComponent(invoiceFileMatch[1]));
        if (!row || !row.data_base64) return send(404, { ok: false, error: 'not_found' });
        if (!isAdmin) {
          const found = await orderForActor(row.order_id);
          if (!found || !found.mine) return send(403, { ok: false, error: 'forbidden' });
        }
        const bytes = Buffer.from(row.data_base64, 'base64');
        res.writeHead(200, {
          'content-type': row.mime ?? 'application/octet-stream',
          'content-length': String(bytes.length),
          // Documento interno: se descarga, no se cachea ni se comparte.
          'content-disposition': `attachment; filename="${encodeURIComponent(row.filename ?? `factura.${row.ext ?? 'pdf'}`)}"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
        return true;
      }

      if (invoiceMatch) {
        if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
        const id = decodeURIComponent(invoiceMatch[1]);
        if (req.method === 'DELETE') {
          const current = await db.get('supplier_invoices', id);
          if (!current) return send(404, { ok: false, error: 'not_found' });
          await db.remove('supplier_invoices', id);
          const pickups = await db.list('order_pickups', { limit: 5000 });
          for (const pickup of pickups) {
            if (pickup.invoice_id === id) {
              await db.update('order_pickups', pickup.id, {
                invoice_attached: false,
                invoice_id: null,
                updated_at: clock().toISOString(),
              });
            }
          }
          return send(200, { ok: true });
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
        const row = await db.get('supplier_invoices', id);
        if (!row) return send(404, { ok: false, error: 'not_found' });
        const { data_base64: _omit, ...meta } = row;
        return send(200, { ok: true, invoice: meta });
      }

      if (req.method === 'GET') {
        const url = new URL(req.url ?? route, 'http://local');
        const orderId = limpiar(url.searchParams.get('order_id'), 80);
        /* Sin administración, solo las facturas de pedidos propios. */
        let propias = null;
        if (!isAdmin) {
          const rows = await ctx.store.listAdmin({ limit: 5000 });
          propias = new Set(
            rows
              .filter((row) => {
                if (row.type && row.type !== 'order_intent') return false;
                try {
                  const order = JSON.parse(row.order_json ?? row.orderJson ?? 'null');
                  return String(order?.delivery?.delivery_user_id ?? '') === String(actor?.id ?? '');
                } catch {
                  return false;
                }
              })
              .map((row) => row.id),
          );
        }
        const rows = (await db.list('supplier_invoices', { limit: 5000 }))
          .filter((row) => !orderId || row.order_id === orderId)
          .filter((row) => !propias || propias.has(row.order_id))
          .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
          .map(({ data_base64: _omit, ...meta }) => meta);
        return send(200, { ok: true, invoices: rows, canManage: isAdmin });
      }

      if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' });
      const body = await readJson(req, 9_000_000);
      const invoice = normalizeSupplierInvoice(body);
      /*
       * FACTURA DESDE «MIS ENTREGAS».
       *
       * El repartidor puede adjuntar la factura del proveedor de SU pedido; no
       * puede subir comprobantes de pedidos ajenos. El archivo se guarda en el
       * almacén privado de documentos (nunca en una URL pública).
       */
      if (!isAdmin) {
        if (!canDeliverOwn) return send(403, { ok: false, error: 'forbidden' });
        const found = await orderForActor(invoice.order_id);
        if (!found || !found.mine) return send(403, { ok: false, error: 'forbidden' });
      }
      /*
       * Una factura cubre UNA compra en UNA tienda. Si ya estaba subida (mismo
       * pedido, tienda y número), se devuelve la que hay: subir dos veces la
       * misma foto no puede duplicar el comprobante.
       */
      const sameKey = `invoice:${invoice.order_id}:${invoice.supplier_id}:${
        invoice.invoice_number ?? invoice.file.size
      }`;
      const existingKey = await db.findBy('supplier_invoices', 'idempotency_key', sameKey);
      const id = existingKey?.id ?? `inv_${clock().getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const doc = {
        id,
        order_id: invoice.order_id,
        supplier_id: invoice.supplier_id,
        invoice_number: invoice.invoice_number,
        total_cents: invoice.total_cents,
        note: invoice.note,
        filename: String(body.filename ?? `factura.${invoice.file.ext}`).slice(0, 120),
        mime: invoice.file.mime,
        ext: invoice.file.ext,
        size: invoice.file.size,
        data_base64: invoice.file.base64,
        idempotency_key: sameKey,
        uploaded_by: actor?.email ?? actor?.id ?? null,
        created_at: existingKey?.created_at ?? clock().toISOString(),
        updated_at: clock().toISOString(),
      };
      if (existingKey) await db.update('supplier_invoices', id, doc);
      else await db.insert('supplier_invoices', doc);

      // Las recogidas de esa tienda en ese pedido quedan con comprobante.
      const pickups = (await db.list('order_pickups', { limit: 5000 })).filter(
        (row) => row.order_id === invoice.order_id && row.supplier_id === invoice.supplier_id,
      );
      for (const pickup of pickups) {
        await db.update('order_pickups', pickup.id, {
          invoice_attached: true,
          invoice_id: id,
          updated_at: clock().toISOString(),
        });
      }
      const { data_base64: _omit, ...meta } = doc;
      return send(existingKey ? 200 : 201, { ok: true, invoice: meta, pickups: pickups.length });
    }

    // ------------------------------------------------- recogidas del pedido
    if (pickupListMatch) {
      const orderId = pickupListMatch[1];
      /*
       * El pedido se lee de SU almacén (`ctx.store.listAdmin`), no del almacén de
       * documentos: ahí no vive. Se toma el `order_json`, que es el pedido real
       * con sus líneas (y con la tienda elegida en cada una).
       */
      const found = await orderForActor(orderId);
      if (!found) return send(404, { ok: false, error: 'not_found' });
      const { order, row: orderRow } = found;
      if (!isAdmin && !found.mine) return send(403, { ok: false, error: 'forbidden' });
      order.customer_id = order.customer_id ?? orderRow.customer_id ?? null;
      if (req.method === 'POST') {
        if (!isAdmin) return send(403, { ok: false, error: 'forbidden' });
        const suppliers = await db.list('suppliers', { limit: 5000 });
        const created = await syncOrderPickups(db, { order, suppliers, clock });
        const pickups = (await db.list('order_pickups', { limit: 5000 })).filter((row) => row.order_id === orderId);
        return send(200, { ok: true, created: created.length, pickups: publicPickups(pickups) });
      }
      if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
      let stored = (await db.list('order_pickups', { limit: 5000 })).filter((row) => row.order_id === orderId);
      const suppliersAll = await db.list('suppliers', { limit: 5000 });
      /*
       * SI AÚN NO HAY RECOGIDAS, SE CREAN AHORA (idempotente).
       *
       * El repartidor no puede ejecutar el alta (es de administración), pero
       * necesita poder marcar la suya. `syncOrderPickups` no duplica nada: si ya
       * existen, no crea ninguna.
       */
      if (!stored.length && found.mine) {
        await syncOrderPickups(db, { order, suppliers: suppliersAll, clock });
        stored = (await db.list('order_pickups', { limit: 5000 })).filter((row) => row.order_id === orderId);
      }
      const supplierById = new Map(suppliersAll.map((row) => [row.id, row]));
      const groups = (stored.length
        ? stored
        : groupItemsBySupplier(order.items ?? []).map((group) => ({
            ...group,
            order_id: orderId,
            customer_id: order.customer_id,
            status: 'pending_purchase',
            location_status: 'pending',
          }))
      ).map((pickup) => {
        const supplier = supplierById.get(pickup.supplier_id) ?? null;
        return {
          ...pickup,
          supplier_name: pickup.supplier_name ?? supplier?.name ?? null,
          address: supplier?.address ?? null,
          sector: supplier?.sector ?? null,
          latitude: Number.isFinite(Number(supplier?.lat)) ? Number(supplier.lat) : null,
          longitude: Number.isFinite(Number(supplier?.lng)) ? Number(supplier.lng) : null,
          maps_url: supplier?.maps_url ?? null,
        };
      });
      return send(200, { ok: true, pickups: publicPickups(groups), stored: stored.length > 0 });
    }

    if (pickupMatch) {
      const id = decodeURIComponent(pickupMatch[1]);
      if (req.method !== 'PATCH') return send(405, { ok: false, error: 'method_not_allowed' });
      const current = await db.get('order_pickups', id);
      if (!current) return send(404, { ok: false, error: 'not_found' });
      const body = await readJson(req, 20000);
      /*
       * EL REPARTIDOR MUEVE SU RECOGIDA, NO LA CAJA.
       *
       * Puede marcarla en camino, comprada o con incidencia, y dejar una nota.
       * NO puede reasignarla ni tocar el dinero de la compra (`paid`): eso sigue
       * siendo de administración. El pedido tiene que ser SUYO.
       */
      if (!isAdmin) {
        if (!canDeliverOwn) return send(403, { ok: false, error: 'forbidden' });
        const found = await orderForActor(current.order_id);
        if (!found || !found.mine) return send(403, { ok: false, error: 'forbidden' });
        if (body.paid !== undefined || body.assigned_to !== undefined || body.invoice_attached !== undefined) {
          return send(403, { ok: false, error: 'forbidden', message: 'Ese cambio lo hace administración.' });
        }
        if (body.status !== undefined && !['on_the_way', 'purchased', 'issue'].includes(body.status)) {
          return send(403, { ok: false, error: 'forbidden', message: 'Ese estado de recogida lo pone administración.' });
        }
      }
      const patch = { updated_at: clock().toISOString() };
      if (body.status !== undefined) {
        if (!PICKUP_STATUSES.includes(body.status)) {
          return send(422, { ok: false, error: 'invalid_status', message: 'Ese estado de recogida no existe.' });
        }
        patch.status = body.status;
      }
      if (body.assigned_to !== undefined) patch.assigned_to = body.assigned_to ? String(body.assigned_to).slice(0, 80) : null;
      if (body.note !== undefined) patch.note = String(body.note ?? '').slice(0, 500);
      if (body.invoice_attached !== undefined) patch.invoice_attached = Boolean(body.invoice_attached);
      // Dinero: no se marca pagado sin comprobante.
      if (body.paid !== undefined && body.paid === true && !body.invoice_attached && !current.invoice_attached) {
        return send(422, {
          ok: false,
          error: 'invoice_required',
          message: 'Adjunta la factura o el comprobante antes de dar por pagada la compra.',
        });
      }
      /*
       * El pago se guarda CON quién lo dio por pagado y cuándo: es dinero, y un
       * cambio de estado sin autor no sirve para cuadrar después.
       */
      if (body.paid !== undefined) {
        patch.paid = Boolean(body.paid);
        patch.paid_at = body.paid ? clock().toISOString() : null;
        patch.paid_by = body.paid ? (actor?.email ?? actor?.id ?? null) : null;
      }
      const pickup = await db.update('order_pickups', id, patch);
      /*
       * EVENTO DE RECOGIDA en la auditoría: es el rastro que después podrá leer
       * el Supervisor Inteligente de Delivery (quién movió qué y cuándo), sin
       * mezclarlo con el estado de la entrega ni con el del pago.
       */
      await ctx.audit?.record({
        entity: 'order',
        entityId: pickup.order_id ?? current.order_id ?? null,
        action: 'delivery.pickup_status',
        actor: actor?.display_name ?? null,
        summary: `Recogida: ${patch.status ?? current.status ?? ''}${patch.paid ? ' · pagada' : ''}`.trim(),
        data: {
          pickup_id: id,
          supplier_id: current.supplier_id ?? null,
          previous_status: current.status ?? null,
          status: pickup.status ?? null,
          paid: pickup.paid === true,
        },
        idempotencyKey: `pickup.status:${id}:${patch.status ?? current.status ?? ''}:${current.updated_at ?? ''}`,
      });
      return send(200, { ok: true, pickup: isAdmin ? pickup : publicPickups([pickup])[0] });
    }

    return false;
  } catch (error) {
    if (error?.status) return send(error.status, { ok: false, error: error.code ?? 'invalid', message: error.message });
    console.error('[suppliers] operation failed', { code: error?.code, name: error?.name });
    return send(500, { ok: false, error: 'suppliers_error', message: 'No se pudo completar la operación.' });
  }
}
