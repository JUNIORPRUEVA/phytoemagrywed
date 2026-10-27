#!/usr/bin/env node
/**
 * UAT REAL DE LA ETAPA 0 — contra el CRM de pruebas (no producción).
 *
 * Requisitos:
 *   1. `node scripts/uat-env.mjs --port=8791 --sin-scheduler` en otra terminal
 *      (base `data/uat/phyto-uat.sqlite`, WhatsApp en MOCK).
 *   2. Ejecutar desde la raíz del repo:
 *        node apps/fulltech_crm/tool/uat_etapa0.mjs
 *
 * Qué comprueba (las 10 cosas del plan):
 *   1. login y recuperación de sesión        6. reintentos sin duplicar ventas
 *   2. seguridad de credenciales             7. precios modificados
 *   3. aislamiento por rol/empresa           8. mensajes offline sin duplicación
 *   4. lectura de pedidos y clientes         9. errores permanentes
 *   5. registro de ventas de prueba         10. recuperación tras desconexión
 *
 * No usa clientes reales: los datos salen de la semilla de UAT.
 * Sale con código 1 si algún chequeo crítico falla.
 */

const BASE = (process.env.UAT_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const PASSWORD = process.env.UAT_PASSWORD ?? 'UatLocal-123';
const USERS = {
  admin: process.env.UAT_ADMIN ?? 'admin@uat.local',
  agent: process.env.UAT_AGENT ?? 'agente@uat.local',
};

const results = [];
let failed = 0;

function record(id, name, ok, detail, critical = true) {
  results.push({ id, name, ok, detail, critical });
  if (!ok && critical) failed++;
  const mark = ok ? 'OK  ' : (critical ? 'FAIL' : 'WARN');
  console.log(`[${mark}] ${id}. ${name}${detail ? ` — ${detail}` : ''}`);
}

function randomKey(prefix) {
  const stamp = Date.now().toString();
  const noise = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${stamp}_${noise}`.replace(/[^A-Za-z0-9_-]/g, '');
}

async function call(method, path, { body, cookie, operationKey } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (cookie) headers.cookie = cookie;
  if (operationKey) headers['x-fulltech-operation'] = operationKey;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = /pe_crm=([^;]*)/.exec(setCookie);
  return { status: response.status, json, text, cookie: match ? `pe_crm=${match[1]}` : null };
}

async function login(user, password) {
  const response = await call('POST', '/api/admin/auth/login', { body: { username: user, password } });
  return { ...response, cookie: response.cookie };
}

async function main() {
  console.log(`UAT Etapa 0 → ${BASE}\n`);

  // ---------------------------------------------------------------- 1. login
  const bad = await login(USERS.admin, 'clave-incorrecta');
  record('1a', 'Login con contraseña incorrecta se rechaza', bad.status === 401, `HTTP ${bad.status}`);

  const admin = await login(USERS.admin, PASSWORD);
  const sessionOk = admin.status === 200 && Boolean(admin.cookie);
  record('1b', 'Login del administrador devuelve sesión', sessionOk, `HTTP ${admin.status}`);
  if (!sessionOk) {
    console.error('\nNo se puede continuar sin sesión de administrador.');
    printSummary();
    process.exit(1);
  }

  const session = await call('GET', '/api/admin/session', { cookie: admin.cookie });
  const sessionUser = session.json?.user?.username ?? '';
  record(
    '1c',
    'La cookie recupera la sesión (usuario correcto)',
    session.status === 200 && session.json?.ok === true && sessionUser === USERS.admin,
    `usuario=${sessionUser || '—'}`,
  );

  const noCookie = await call('GET', '/api/admin/session');
  record('1d', 'Sin cookie la sesión no es válida', noCookie.json?.ok === false, `HTTP ${noCookie.status}`);

  // --------------------------------------------------- 2. credenciales seguras
  record(
    '2a',
    'La cookie de sesión no contiene la contraseña',
    !admin.cookie.includes(PASSWORD) && !admin.text.includes(PASSWORD),
    'cookie y cuerpo revisados',
  );
  const logoutOnce = await call('POST', '/api/admin/auth/logout', { cookie: admin.cookie, body: {} });
  record('2b', 'Cerrar sesión invalida la cookie', logoutOnce.status === 200, `HTTP ${logoutOnce.status}`);
  const afterLogout = await call('GET', '/api/admin/session', { cookie: admin.cookie });
  record('2c', 'La cookie cerrada ya no autentica', afterLogout.json?.ok === false, `ok=${afterLogout.json?.ok}`);

  // Sesión nueva para el resto
  const adminSession = await login(USERS.admin, PASSWORD);
  const cookie = adminSession.cookie;

  // ------------------------------------------------- 3. aislamiento por rol
  const agent = await login(USERS.agent, PASSWORD);
  const agentSettings = await call('GET', '/api/admin/settings', { cookie: agent.cookie ?? '' });
  record(
    '3a',
    'Un AGENT no puede leer la configuración del negocio',
    agentSettings.status === 403,
    `HTTP ${agentSettings.status}`,
  );
  const agentUsers = await call('GET', '/api/admin/users', { cookie: agent.cookie ?? '' });
  record('3b', 'Un AGENT no puede listar usuarios', agentUsers.status === 403, `HTTP ${agentUsers.status}`);
  const agentData = await call('GET', '/api/admin/data?light=1', { cookie: agent.cookie ?? '' });
  record('3c', 'Un AGENT sí puede leer su panel', agentData.status === 200 && agentData.json?.ok === true, `HTTP ${agentData.status}`);

  // ------------------------------------------- 4. lectura de pedidos/clientes
  const data = await call('GET', '/api/admin/data?light=1', { cookie });
  const items = Array.isArray(data.json?.items) ? data.json.items : [];
  const customers = Array.isArray(data.json?.customers) ? data.json.customers : [];
  const conversations = Array.isArray(data.json?.conversations) ? data.json.conversations : [];
  record('4a', 'Pedidos legibles', items.length > 0, `${items.length} registros`);
  record('4b', 'Clientes legibles', customers.length > 0, `${customers.length} clientes`);
  record('4c', 'Bandeja legible', conversations.length > 0, `${conversations.length} conversaciones`);

  const catalogue = await call('GET', '/api/admin/catalog', { cookie });
  const presentations = Array.isArray(catalogue.json?.catalog) ? catalogue.json.catalog : [];
  const presentation = presentations.find((row) => row.active !== false && Number(row.sale_price_cents) > 0);
  record('4d', 'Catálogo con al menos una presentación vendible', Boolean(presentation), presentation ? presentation.name : 'sin presentaciones');

  // ------------------------------------------------ 5. venta de prueba (POS)
  if (!presentation || customers.length === 0) {
    record('5', 'Venta de prueba', false, 'faltan datos de la semilla', true);
  } else {
    const customer = customers[0];
    const unitCents = Number(presentation.sale_price_cents);
    const quantity = 2;
    const expectedTotal = unitCents * quantity;
    const requestId = randomKey('uatpos');
    const operationKey = requestId;
    const saleBody = {
      mode: 'invoice',
      requestId,
      customerId: customer.id,
      items: [{ variantId: presentation.id, quantity }],
      deliveryFee: 0,
      paymentMethod: 'CASH',
      paymentStatus: 'paid',
      deliveryMethod: 'pickup',
      notes: 'UAT Etapa 0 — venta de prueba automatizada',
      address: '',
      // El cliente ya puede tener pedidos abiertos de la propia UAT: se confirma.
      acknowledgeOpen: true,
      expectedTotal,
    };

    /*
     * El recuento se hace con la lista PAGINADA (`total`), no con el paquete
     * ligero: ese recorta a 150 y, con muchos pedidos, no distinguiría +1.
     */
    const countBefore = Number((await call('GET', '/api/admin/orders?limit=1', { cookie })).json?.total ?? 0);
    const sale = await call('POST', '/api/admin/pos/checkout', { cookie, body: saleBody, operationKey });
    const saleOk = (sale.status === 200 || sale.status === 201) && sale.json?.ok === true;
    record('5a', 'Venta de prueba registrada', saleOk, `HTTP ${sale.status}${sale.json?.document?.number ? ` · ${sale.json.document.number}` : ''}`);

    // ------------------------------------- 6. reintento idéntico (idempotencia)
    const retry = await call('POST', '/api/admin/pos/checkout', { cookie, body: saleBody, operationKey });
    const retryOk = (retry.status === 200 || retry.status === 201) && retry.json?.ok === true;
    const sameDoc = retry.json?.duplicate === true || retry.json?.document?.number === sale.json?.document?.number;
    record('6a', 'El reintento responde sin error', retryOk, `HTTP ${retry.status}`);
    record('6b', 'El reintento NO crea otro documento', sameDoc, `duplicate=${retry.json?.duplicate === true}`);

    const dataAfter = await call('GET', '/api/admin/data?light=1', { cookie });
    const countAfter = Number((await call('GET', '/api/admin/orders?limit=1', { cookie })).json?.total ?? 0);
    record(
      '6c',
      'El número de pedidos no aumenta con el reintento',
      countAfter === countBefore + 1,
      `antes=${countBefore} después=${countAfter}`,
    );

    // -------------------------------------------- 7. precio distinto → rechazo
    const changedId = randomKey('uatprice');
    const priceChanged = await call('POST', '/api/admin/pos/checkout', {
      cookie,
      operationKey: changedId,
      body: { ...saleBody, requestId: changedId, expectedTotal: expectedTotal + 100 },
    });
    record(
      '7a',
      'Un total distinto se rechaza con price_changed',
      priceChanged.status === 409 && priceChanged.json?.error === 'price_changed',
      `HTTP ${priceChanged.status} · ${priceChanged.json?.error ?? '—'}`,
    );

    const countAfterPrice = Number((await call('GET', '/api/admin/orders?limit=1', { cookie })).json?.total ?? 0);
    record('7b', 'El rechazo por precio no registra nada', countAfterPrice === countAfter, `pedidos=${countAfterPrice}`);

    // Cotización: mismo contrato de totales
    const quoteId = randomKey('uatquote');
    const quote = await call('POST', '/api/admin/pos/quotes', {
      cookie,
      operationKey: quoteId,
      body: { ...saleBody, requestId: quoteId, mode: 'invoice' },
    });
    record(
      '8a',
      'Cotización con el mismo expectedTotal se acepta',
      quote.status === 200 || quote.status === 201,
      `HTTP ${quote.status}`,
    );
  }

  // ------------------------------- 9. mensajes: deduplicación por clave de operación
  if (conversations.length > 0) {
    const conversationId = conversations[0].id;
    const messageKey = randomKey('uatmsg');
    const body = { body: `UAT Etapa 0 · mensaje ${messageKey}` };

    const before = await call('GET', `/api/admin/conversations/${conversationId}/messages`, { cookie });
    const countBefore = (before.json?.messages ?? []).length;

    const first = await call('POST', `/api/admin/conversations/${conversationId}/messages`, { cookie, body, operationKey: messageKey });
    const second = await call('POST', `/api/admin/conversations/${conversationId}/messages`, { cookie, body, operationKey: messageKey });

    const after = await call('GET', `/api/admin/conversations/${conversationId}/messages`, { cookie });
    const sent = (after.json?.messages ?? []).filter((row) => String(row.body ?? '').includes(messageKey));
    record(
      '9a',
      'El mensaje se envía (mock) y el reintento responde igual',
      (first.status === 200 || first.status === 201) && second.status === first.status,
      `1º HTTP ${first.status} · 2º HTTP ${second.status}`,
    );
    record('9b', 'El reintento NO duplica el mensaje', sent.length === 1, `${sent.length} copia(s) en el hilo`);
    record(
      '9c',
      'El hilo crece como mucho en un mensaje',
      (after.json?.messages ?? []).length <= countBefore + 1,
      `antes=${countBefore} después=${(after.json?.messages ?? []).length}`,
    );

    const statusCheck = await call('POST', '/api/admin/offline-operations/status', { cookie, body: { ids: [messageKey] } });
    const state = (statusCheck.json?.estados ?? [])[0]?.estado ?? '—';
    record(
      '10a',
      'La consulta de estado ve la operación en el servidor',
      ['completada', 'en_proceso'].includes(state),
      `estado=${state}`,
    );

    const unknownKey = randomKey('uatnone');
    const unknownStatus = await call('POST', '/api/admin/offline-operations/status', { cookie, body: { ids: [unknownKey] } });
    const unknownState = (unknownStatus.json?.estados ?? [])[0]?.estado ?? '—';
    record(
      '10b',
      'Una operación que nunca llegó se informa como no recibida',
      unknownState === 'no_recibida',
      `estado=${unknownState}`,
    );

    // Error permanente: misma clave con otros datos → el servidor no re-ejecuta.
    const reused = await call('POST', `/api/admin/conversations/${conversationId}/messages`, {
      cookie,
      operationKey: messageKey,
      body: { body: 'UAT Etapa 0 · cuerpo distinto con la misma clave' },
    });
    record(
      '9d',
      'Reutilizar la clave con otros datos se rechaza',
      reused.status === 409,
      `HTTP ${reused.status} · ${reused.json?.error ?? '—'}`,
    );

    const afterReuse = await call('GET', `/api/admin/conversations/${conversationId}/messages`, { cookie });
    const leaked = (afterReuse.json?.messages ?? []).filter((row) => String(row.body ?? '').includes('cuerpo distinto con la misma clave'));
    record('9e', 'Ese rechazo no deja ningún mensaje nuevo', leaked.length === 0, `${leaked.length} mensaje(s)`);
  } else {
    record('9', 'Pruebas de mensajes', false, 'no hay conversaciones en la semilla', true);
  }

  printSummary();
  process.exit(failed === 0 ? 0 : 1);
}

function printSummary() {
  const ok = results.filter((row) => row.ok).length;
  const total = results.length;
  console.log('\n────────────────────────────────────────────');
  console.log(`RESULTADO: ${ok}/${total} comprobaciones correctas`);
  const problems = results.filter((row) => !row.ok);
  if (problems.length) {
    console.log('Fallos:');
    for (const problem of problems) console.log(`  · ${problem.id} ${problem.name}: ${problem.detail}`);
  }
  console.log('Evidencias de envío (mock): data/uat/envios.log');
  console.log('────────────────────────────────────────────');
}

main().catch((error) => {
  console.error('\nLa prueba se detuvo:', error?.message ?? error);
  printSummary();
  process.exit(1);
});
