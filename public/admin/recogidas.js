/**
 * TIENDAS PROVEEDORAS Y RECOGIDAS — pantallas del panel.
 *
 * DOS PANTALLAS, UNA IDEA: lo que se compra fuera del almacén tiene que poder
 * seguirse hasta la tienda.
 *
 *   · TIENDAS      → alta/edición de la tienda con su ubicación real. Sin
 *                    coordenadas la tienda queda «Ubicación pendiente» y el
 *                    repartidor no puede llegar: se dice, no se disimula.
 *   · RECOGIDAS    → una tarjeta por compra y tienda: qué hay que traer, a
 *                    quién se le asigna, cuánto costó, si ya está pagada y su
 *                    factura (PDF/JPG/PNG). La factura es INTERNA: nunca va al
 *                    cliente ni al PDF de FULLTECH.
 *
 * REGLAS
 *   - Solo lectura para quien puede leer pedidos; crear/editar, solo ADMIN.
 *   - No se da por pagada una compra sin comprobante: lo impide el servidor y
 *     la interfaz ni siquiera lo ofrece.
 *   - Los estados son los del pedido real (pendiente, asignada, en camino,
 *     comprada, hacia el cliente, entregada, incidencia), no invenciones.
 */
const STATUS = {
  pending_purchase: 'Pendiente de comprar',
  assigned: 'Asignada',
  on_the_way: 'En camino',
  purchased: 'Comprada',
  to_customer: 'Hacia el cliente',
  delivered: 'Entregada',
  issue: 'Incidencia',
};

const state = {
  tab: '',
  pickups: [],
  suppliers: [],
  invoices: [],
  quickSales: [],
  manage: false,
  loading: false,
  error: '',
  filter: 'todas',
  openNote: null,
  busy: '',
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const money = (cents) => {
  const value = Number(cents);
  if (!Number.isFinite(value) || !value) return '—';
  return `RD$${(value / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const day = (iso) => {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-DO', { day: '2-digit', month: 'short' });
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.message || 'No se pudo completar la operación.');
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

function toast(message) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    box.hidden = true;
  }, 3200);
}

/* -------------------------------------------------------------- CARGA */

async function loadPickups() {
  state.loading = true;
  state.error = '';
  try {
    const [pickups, invoices, quick] = await Promise.all([
      api('/api/admin/pickups'),
      api('/api/admin/supplier-invoices').catch(() => ({ invoices: [] })),
      api('/api/admin/quick-sales').catch(() => ({ lines: [] })),
    ]);
    state.pickups = pickups.pickups ?? [];
    state.manage = Boolean(pickups.canManage);
    state.invoices = invoices.invoices ?? [];
    state.quickSales = quick.lines ?? [];
    if (!state.suppliers.length) state.suppliers = (await api('/api/admin/suppliers').catch(() => ({ suppliers: [] }))).suppliers ?? [];
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
  }
  renderPickups();
}

async function loadSuppliers() {
  state.loading = true;
  state.error = '';
  try {
    const result = await api('/api/admin/suppliers');
    state.suppliers = result.suppliers ?? [];
    state.manage = state.manage || Boolean(result.canManage);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
  }
  renderSuppliers();
}

/* ------------------------------------------------------------ RECOGIDAS */

function filteredPickups() {
  if (state.filter === 'todas') return state.pickups;
  if (state.filter === 'pendientes') return state.pickups.filter((row) => ['pending_purchase', 'assigned', 'on_the_way'].includes(row.status));
  if (state.filter === 'pagadas') return state.pickups.filter((row) => row.paid === true);
  if (state.filter === 'sinfactura') return state.pickups.filter((row) => !row.invoice_attached);
  return state.pickups.filter((row) => row.status === state.filter);
}

function invoiceFor(pickup) {
  if (!pickup.invoice_id) return null;
  return state.invoices.find((row) => row.id === pickup.invoice_id) ?? null;
}

function storeFor(pickup) {
  return state.suppliers.find((row) => row.id === pickup.supplier_id) ?? null;
}

function pickupCard(pickup) {
  const store = storeFor(pickup);
  const invoice = invoiceFor(pickup);
  const pendiente = store && store.location_status !== 'ok';
  const maps = store?.lat != null && store?.lng != null
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${store.lat},${store.lng}`)}`
    : store?.maps_url || '';
  const items = (pickup.items ?? [])
    .map((item) => `<li>${esc(item.name)} <span class="rc-muted">×${Number(item.quantity) || 1}</span></li>`)
    .join('');
  return `<article class="rc-card" data-pickup="${esc(pickup.id)}">
    <header class="rc-card__head">
      <div>
        <strong>${esc(pickup.supplier_name ?? store?.name ?? 'Tienda')}</strong>
        <span class="rc-muted">${pickup.order_number ? `Pedido ${esc(pickup.order_number)}` : `Pedido ${esc(String(pickup.order_id ?? '').slice(0, 8))}`} · ${esc(day(pickup.created_at))}</span>
      </div>
      <span class="rc-tag rc-tag--${esc(pickup.status)}">${esc(STATUS[pickup.status] ?? pickup.status)}</span>
    </header>
    <ul class="rc-items">${items || '<li class="rc-muted">Sin artículos</li>'}</ul>
    <p class="rc-meta">
      <span>${Number(pickup.quantity) || 0} artículo(s)</span>
      <span>Costo ${money(pickup.cost_cents)}</span>
      ${pickup.paid ? '<span class="rc-ok">Pagada</span>' : '<span class="rc-warn">Sin pagar</span>'}
      ${pickup.invoice_attached ? '<span class="rc-ok">Con factura</span>' : '<span class="rc-warn">Sin factura</span>'}
      ${pendiente ? '<span class="rc-warn">Ubicación de la tienda pendiente</span>' : ''}
    </p>
    ${state.manage
      ? `<div class="rc-controls">
          <label class="rc-field"><span>Estado</span>
            <select data-pickup-status="${esc(pickup.id)}">${Object.entries(STATUS)
              .map(([value, label]) => `<option value="${value}"${value === pickup.status ? ' selected' : ''}>${label}</option>`)
              .join('')}</select>
          </label>
          <label class="rc-field"><span>Asignada a</span>
            <input data-pickup-assign="${esc(pickup.id)}" value="${esc(pickup.assigned_to ?? '')}" placeholder="Repartidor o encargado" maxlength="80">
          </label>
          <label class="rc-field rc-field--wide"><span>Instrucciones</span>
            <input data-pickup-note="${esc(pickup.id)}" value="${esc(pickup.note ?? '')}" placeholder="Ej.: preguntar por el pedido a nombre de FullTECH" maxlength="300">
          </label>
          <div class="rc-actions">
            <button class="btn btn--primary btn--sm" type="button" data-pickup-save="${esc(pickup.id)}">Guardar</button>
            <button class="btn btn--ghost btn--sm" type="button" data-pickup-paid="${esc(pickup.id)}" ${pickup.paid ? 'disabled' : ''} ${pickup.invoice_attached ? '' : 'title="Necesita factura o comprobante"'}>Marcar pagada</button>
            <label class="btn btn--ghost btn--sm rc-upload">${pickup.invoice_attached ? 'Cambiar factura' : 'Adjuntar factura'}
              <input type="file" accept="application/pdf,image/jpeg,image/png" data-pickup-invoice="${esc(pickup.id)}" hidden>
            </label>
            ${maps ? `<a class="btn btn--ghost btn--sm" href="${esc(maps)}" target="_blank" rel="noopener">Ir a la tienda</a>` : ''}
            ${invoice ? `<a class="btn btn--ghost btn--sm" href="/api/admin/supplier-invoices/${encodeURIComponent(invoice.id)}/file" target="_blank" rel="noopener">Ver factura</a>` : ''}
          </div>
        </div>`
      : pickup.assigned_to
        ? `<p class="rc-meta">Asignada a <strong>${esc(pickup.assigned_to)}</strong></p>`
        : ''}
  </article>`;
}

function renderPickups() {
  const host = document.getElementById('admin-recogidas');
  if (!host) return;
  const rows = filteredPickups();
  const chips = [
    ['todas', 'Todas'],
    ['pendientes', 'Pendientes'],
    ['sinfactura', 'Sin factura'],
    ['pagadas', 'Pagadas'],
    ['delivered', 'Entregadas'],
  ]
    .map(
      ([value, label]) =>
        `<button class="chip" type="button" data-pickup-filter="${value}" aria-pressed="${state.filter === value}">${label}</button>`,
    )
    .join('');
  const quick = state.manage && state.quickSales.length
    ? `<details class="rc-quick">
        <summary>Ventas fuera de inventario (${state.quickSales.length})</summary>
        <p class="rc-muted">Se vendieron sin crear producto. Si se van a repetir, conviértelas en producto permanente.</p>
        <ul class="rc-quick__list">${state.quickSales
          .map(
            (line, index) =>
              `<li><span>${esc(line.name)} <span class="rc-muted">×${line.quantity}${line.order_number ? ` · ${esc(line.order_number)}` : ''}</span></span>
                <button class="btn btn--ghost btn--sm" type="button" data-quick-promote="${index}">Crear producto</button></li>`,
          )
          .join('')}</ul>
      </details>`
    : '';
  host.innerHTML = `
    <div class="rc-head">
      <div class="chips">${chips}</div>
      <button class="btn btn--ghost btn--sm" type="button" data-pickups-refresh>Actualizar</button>
    </div>
    ${state.error ? `<p class="rc-error" role="alert">${esc(state.error)}</p>` : ''}
    ${quick}
    ${state.loading && !rows.length ? '<p class="rc-muted">Cargando recogidas…</p>' : ''}
    ${!state.loading && !rows.length ? '<p class="rc-muted">No hay recogidas con ese filtro. Una recogida se crea sola al vender un producto de una tienda.</p>' : ''}
    <div class="rc-list">${rows.map(pickupCard).join('')}</div>`;
}

/**
 * VENTA RÁPIDA → PRODUCTO PERMANENTE.
 *
 * Crear un producto cambia el catálogo de la empresa, así que la acción la hace
 * un ADMIN y con los datos a la vista: nombre, código, precio, costo e imagen.
 * Nunca se convierte nada solo.
 */
function openQuickProductForm(line) {
  const dialog = document.createElement('dialog');
  dialog.className = 'store-dialog';
  const skuSugerido = String(line.name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  dialog.innerHTML = `
    <form class="rc-form" method="dialog">
      <h2>Crear producto permanente</h2>
      <p class="rc-muted">Venía de una venta fuera de inventario. No se modifica el pedido: solo se crea el artículo para las próximas.</p>
      <label class="field"><span class="field__label">Nombre</span>
        <input class="field__input" name="name" required maxlength="120" value="${esc(line.name ?? '')}"></label>
      <div class="rc-form__row">
        <label class="field"><span class="field__label">Código (SKU)</span>
          <input class="field__input" name="sku" required maxlength="60" value="${esc(skuSugerido)}"></label>
        <label class="field"><span class="field__label">Tipo</span>
          <select class="field__input" name="product_type">
            <option value="third_party">De terceros (sin existencias)</option>
            <option value="own">Propio (controla existencias)</option>
          </select></label>
      </div>
      <div class="rc-form__row">
        <label class="field"><span class="field__label">Precio (RD$)</span>
          <input class="field__input" name="price" type="number" min="0" step="0.01" required value="${(Number(line.price_cents || 0) / 100).toFixed(2)}"></label>
        <label class="field"><span class="field__label">Costo (RD$)</span>
          <input class="field__input" name="cost" type="number" min="0" step="0.01" value="${(Number(line.cost_cents || 0) / 100).toFixed(2)}"></label>
      </div>
      <label class="field"><span class="field__label">Imagen del producto</span>
        <input class="field__input" name="image" type="file" accept="image/png,image/jpeg,image/webp" required></label>
      <label class="field"><span class="field__label">Categoría</span>
        <input class="field__input" name="category" maxlength="60" value="General"></label>
      <p class="rc-error" role="alert"></p>
      <div class="rc-actions">
        <button class="btn btn--primary btn--sm" type="submit">Crear producto</button>
        <button class="btn btn--ghost btn--sm" type="button" data-quick-cancel>Cancelar</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const errorBox = form.querySelector('.rc-error');
  dialog.querySelector('[data-quick-cancel]').addEventListener('click', () => {
    dialog.close();
    dialog.remove();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const file = form.image.files?.[0];
    if (!file) {
      errorBox.textContent = 'Elige una imagen: el catálogo la pide para los productos.';
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      errorBox.textContent = 'La imagen supera 3 MB.';
      return;
    }
    try {
      const image = await readFile(file);
      await api('/api/admin/store/products', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value,
          sku: form.sku.value,
          kind: 'product',
          price: form.price.value,
          cost: form.cost.value,
          image,
          category: form.category.value,
          product_type: form.product_type.value,
          track_stock: form.product_type.value === 'own',
          quantity: 0,
          min_stock: 0,
        }),
      });
      dialog.close();
      dialog.remove();
      await loadPickups();
      toast('Producto creado');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
  dialog.showModal();
}

async function patchPickup(id, patch) {
  state.busy = id;
  try {
    await api(`/api/admin/pickups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await loadPickups();
    toast('Recogida actualizada');
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

async function uploadInvoice(pickupId, file) {
  const pickup = state.pickups.find((row) => row.id === pickupId);
  if (!pickup) return;
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast('El archivo supera 4 MB. Escanéalo en blanco y negro o guárdalo en JPG.');
    return;
  }
  try {
    state.busy = pickupId;
    const dataUrl = await readFile(file);
    await api('/api/admin/supplier-invoices', {
      method: 'POST',
      body: JSON.stringify({
        order_id: pickup.order_id,
        supplier_id: pickup.supplier_id,
        pickup_ids: [pickup.id],
        filename: file.name,
        base64: dataUrl,
      }),
    });
    await loadPickups();
    toast('Factura guardada');
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = '';
  }
}

/* -------------------------------------------------------------- TIENDAS */

function supplierCard(store) {
  const maps = store.lat != null && store.lng != null
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${store.lat},${store.lng}`)}`
    : store.maps_url || '';
  return `<article class="rc-card" data-supplier="${esc(store.id)}">
    <header class="rc-card__head">
      <div>
        <strong>${esc(store.name)}</strong>
        <span class="rc-muted">${esc(store.phone || 'Sin teléfono')}${store.address ? ` · ${esc(store.address)}` : ''}</span>
      </div>
      <span class="rc-tag ${store.location_status === 'ok' ? 'rc-tag--ok' : 'rc-tag--warn'}">${store.location_status === 'ok' ? 'Ubicación lista' : 'Ubicación pendiente'}</span>
    </header>
    ${store.hours ? `<p class="rc-meta">${esc(store.hours)}</p>` : ''}
    ${store.references ? `<p class="rc-meta">${esc(store.references)}</p>` : ''}
    ${state.manage
      ? `<div class="rc-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-supplier-edit="${esc(store.id)}">Editar</button>
          ${maps ? `<a class="btn btn--ghost btn--sm" href="${esc(maps)}" target="_blank" rel="noopener">Ver en mapa</a>` : ''}
        </div>`
      : maps
        ? `<div class="rc-actions"><a class="btn btn--ghost btn--sm" href="${esc(maps)}" target="_blank" rel="noopener">Ver en mapa</a></div>`
        : ''}
  </article>`;
}

function renderSuppliers() {
  const host = document.getElementById('admin-tiendas');
  if (!host) return;
  host.innerHTML = `
    <div class="rc-head">
      <p class="rc-muted">Una tienda sin ubicación no se puede visitar. Se marca como pendiente hasta que tenga coordenadas.</p>
      ${state.manage ? '<button class="btn btn--primary btn--sm" type="button" data-supplier-new>Nueva tienda</button>' : ''}
    </div>
    ${state.error ? `<p class="rc-error" role="alert">${esc(state.error)}</p>` : ''}
    ${state.loading && !state.suppliers.length ? '<p class="rc-muted">Cargando tiendas…</p>' : ''}
    ${!state.loading && !state.suppliers.length ? '<p class="rc-muted">Todavía no hay tiendas registradas.</p>' : ''}
    <div class="rc-list">${state.suppliers.map(supplierCard).join('')}</div>`;
}

function openSupplierForm(store = null) {
  const dialog = document.createElement('dialog');
  dialog.className = 'store-dialog';
  dialog.innerHTML = `
    <form class="rc-form" method="dialog">
      <h2>${store ? 'Editar tienda' : 'Nueva tienda'}</h2>
      <label class="field"><span class="field__label">Nombre</span>
        <input class="field__input" name="name" required maxlength="120" value="${esc(store?.name ?? '')}"></label>
      <label class="field"><span class="field__label">Teléfono</span>
        <input class="field__input" name="phone" maxlength="40" value="${esc(store?.phone ?? '')}"></label>
      <label class="field"><span class="field__label">Dirección</span>
        <input class="field__input" name="address" maxlength="200" value="${esc(store?.address ?? '')}"></label>
      <div class="rc-form__row">
        <label class="field"><span class="field__label">Latitud</span>
          <input class="field__input" name="lat" inputmode="decimal" value="${store?.lat ?? ''}"></label>
        <label class="field"><span class="field__label">Longitud</span>
          <input class="field__input" name="lng" inputmode="decimal" value="${store?.lng ?? ''}"></label>
      </div>
      <label class="field"><span class="field__label">Enlace de Google Maps (opcional)</span>
        <input class="field__input" name="maps_url" maxlength="500" value="${esc(store?.maps_url ?? '')}"></label>
      <label class="field"><span class="field__label">Referencias</span>
        <input class="field__input" name="references" maxlength="300" value="${esc(store?.references ?? '')}"></label>
      <label class="field"><span class="field__label">Horario</span>
        <input class="field__input" name="hours" maxlength="160" value="${esc(store?.hours ?? '')}"></label>
      <p class="rc-error" role="alert"></p>
      <div class="rc-actions">
        <button class="btn btn--ghost btn--sm" type="button" data-supplier-locate>Usar mi ubicación</button>
        <button class="btn btn--primary btn--sm" type="submit">Guardar</button>
        <button class="btn btn--ghost btn--sm" type="button" data-supplier-cancel>Cancelar</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const errorBox = form.querySelector('.rc-error');
  dialog.querySelector('[data-supplier-cancel]').addEventListener('click', () => {
    dialog.close();
    dialog.remove();
  });
  dialog.querySelector('[data-supplier-locate]').addEventListener('click', () => {
    if (!navigator.geolocation) {
      errorBox.textContent = 'Este dispositivo no da la ubicación.';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        form.lat.value = position.coords.latitude.toFixed(6);
        form.lng.value = position.coords.longitude.toFixed(6);
      },
      () => {
        errorBox.textContent = 'No se ha podido obtener la ubicación.';
      },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const body = {
      name: form.name.value,
      phone: form.phone.value,
      address: form.address.value,
      lat: form.lat.value === '' ? null : Number(form.lat.value),
      lng: form.lng.value === '' ? null : Number(form.lng.value),
      maps_url: form.maps_url.value,
      references: form.references.value,
      hours: form.hours.value,
    };
    try {
      await api(store ? `/api/admin/suppliers/${encodeURIComponent(store.id)}` : '/api/admin/suppliers', {
        method: store ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      dialog.close();
      dialog.remove();
      await loadSuppliers();
      toast(store ? 'Tienda actualizada' : 'Tienda creada');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
  dialog.showModal();
}

/* ------------------------------------------------------------- EVENTOS */

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-pickups-refresh]')) return void loadPickups();
  const filter = target.closest('[data-pickup-filter]');
  if (filter) {
    state.filter = filter.dataset.pickupFilter;
    renderPickups();
    return;
  }
  const save = target.closest('[data-pickup-save]');
  if (save) {
    const id = save.dataset.pickupSave;
    const status = document.querySelector(`[data-pickup-status="${CSS.escape(id)}"]`)?.value;
    const assign = document.querySelector(`[data-pickup-assign="${CSS.escape(id)}"]`)?.value ?? '';
    const note = document.querySelector(`[data-pickup-note="${CSS.escape(id)}"]`)?.value ?? '';
    return void patchPickup(decodeURIComponent(id), { status, assigned_to: assign, note });
  }
  const paid = target.closest('[data-pickup-paid]');
  if (paid) {
    const id = decodeURIComponent(paid.dataset.pickupPaid);
    const pickup = state.pickups.find((row) => row.id === id);
    if (pickup && !pickup.invoice_attached) {
      toast('Adjunta la factura o el comprobante antes de dar por pagada la compra.');
      return;
    }
    return void patchPickup(id, { paid: true });
  }

  if (target.closest('[data-supplier-new]')) return void openSupplierForm(null);
  const edit = target.closest('[data-supplier-edit]');
  if (edit) {
    const store = state.suppliers.find((row) => row.id === edit.dataset.supplierEdit);
    if (store) openSupplierForm(store);
  }
  const promote = target.closest('[data-quick-promote]');
  if (promote) {
    const line = state.quickSales[Number(promote.dataset.quickPromote)];
    if (line) openQuickProductForm(line);
  }
});

document.addEventListener('change', (event) => {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  if (!input) return;
  const id = input.dataset.pickupInvoice;
  if (id && input.files && input.files[0]) {
    uploadInvoice(decodeURIComponent(id), input.files[0]).catch(() => {});
  }
});

window.addEventListener('fulltech:tab', (event) => {
  const tab = event.detail?.tab ?? '';
  state.tab = tab;
  if (tab === 'recogidas') loadPickups().catch(() => {});
  else if (tab === 'tiendas') loadSuppliers().catch(() => {});
});

/*
 * TIEMPO REAL: si alguien cambia una recogida (estado, repartidor, factura,
 * pago) o entra un pedido nuevo con productos de tienda, esta pantalla se
 * actualiza sola. Solo mientras está abierta y agrupando la ráfaga.
 */
let recogidasVivoTimer = null;
window.addEventListener('fulltech:crm-event', (event) => {
  const tipo = String(event.detail?.type ?? '');
  const interesa =
    tipo.startsWith('pickup.') ||
    tipo === 'order.created' ||
    tipo === 'order.status_changed' ||
    tipo === 'delivery.completed';
  if (!interesa || document.body.dataset.tab !== 'recogidas') return;
  if (recogidasVivoTimer) clearTimeout(recogidasVivoTimer);
  recogidasVivoTimer = setTimeout(() => {
    recogidasVivoTimer = null;
    loadPickups().catch(() => {});
  }, 400);
});

/**
 * ENLACE DIRECTO: si el panel se abrió ya en esta pantalla (por ejemplo al
 * recargar), no llega ningún evento `fulltech:tab` y la pantalla quedaría en
 * blanco. Se mira la pestaña activa al arrancar.
 */
function bootFromCurrentTab() {
  const active = document.querySelector('.view:not([hidden])')?.id ?? '';
  if (active === 'view-recogidas') loadPickups().catch(() => {});
  if (active === 'view-tiendas') loadSuppliers().catch(() => {});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFromCurrentTab, { once: true });
else setTimeout(bootFromCurrentTab, 0);
