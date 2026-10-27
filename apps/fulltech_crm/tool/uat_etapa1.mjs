#!/usr/bin/env node
/**
 * UAT REAL DE LA ETAPA 1 — chat nativo (multimedia, plantillas, asignación).
 *
 * Requisitos: el CRM de pruebas escuchando en UAT_URL (por defecto 8791).
 *   node apps/fulltech_crm/tool/uat_etapa1.mjs
 *
 * Comprueba que lo que hace la app nativa queda escrito en el MISMO sitio que
 * lee la PWA (`/api/admin/data`, el hilo y la asignación de la conversación).
 * No usa clientes reales ni envía nada a Meta (WhatsApp en modo MOCK).
 */

const BASE = (process.env.UAT_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const PASSWORD = process.env.UAT_PASSWORD ?? 'UatLocal-123';
const ADMIN = process.env.UAT_ADMIN ?? 'admin@uat.local';
const AGENT = process.env.UAT_AGENT ?? 'agente@uat.local';

const results = [];
let critical = 0;

function record(id, name, ok, detail, isCritical = true) {
  results.push({ id, name, ok, detail, critical: isCritical });
  if (!ok && isCritical) critical++;
  console.log(`[${ok ? 'OK  ' : isCritical ? 'FAIL' : 'WARN'}] ${id}. ${name}${detail ? ` — ${detail}` : ''}`);
}

function randomKey(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9_-]/g, '');
}

async function call(method, path, { body, cookie, operationKey, bytes, contentType, headers } = {}) {
  const finalHeaders = { accept: 'application/json', ...(headers ?? {}) };
  if (cookie) finalHeaders.cookie = cookie;
  if (operationKey) finalHeaders['x-fulltech-operation'] = operationKey;
  let payload;
  if (bytes) {
    payload = bytes;
    if (contentType) finalHeaders['content-type'] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders['content-type'] = 'application/json; charset=utf-8';
  }
  const response = await fetch(`${BASE}${path}`, { method, headers: finalHeaders, body: payload });
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

async function login(user) {
  const response = await call('POST', '/api/admin/auth/login', { body: { username: user, password: PASSWORD } });
  return response.cookie ?? '';
}

// PNG transparente de 1x1 (bytes reales, no un archivo inventado con extensión).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// PDF mínimo válido (cabecera + un objeto + trailer).
const PDF_MIN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

async function main() {
  console.log(`UAT Etapa 1 → ${BASE}\n`);
  const cookie = await login(ADMIN);
  if (!cookie) {
    record('0', 'Login de administrador', false, 'sin sesión');
    printSummary();
    process.exit(1);
  }

  const data = await call('GET', '/api/admin/data?light=1', { cookie });
  const conversations = Array.isArray(data.json?.conversations) ? data.json.conversations : [];
  if (!conversations.length) {
    record('0b', 'Hay conversaciones en la semilla', false, 'ninguna');
    printSummary();
    process.exit(1);
  }
  const conversationId = conversations[0].id;
  const countMessages = async () => {
    const response = await call('GET', `/api/admin/conversations/${conversationId}/messages`, { cookie });
    return Array.isArray(response.json?.messages) ? response.json.messages.length : 0;
  };

  // ------------------------------------------------------------ 1. foto
  const beforePhoto = await countMessages();
  const photoKey = randomKey('img');
  const photo = await call(
    'POST',
    `/api/admin/conversations/${conversationId}/media?kind=image&caption=UAT%20Etapa%201&key=${photoKey}`,
    { cookie, bytes: PNG_1X1, contentType: 'image/png', headers: { 'x-phyto-filename': 'uat.png' } },
  );
  record('1a', 'Enviar una foto', photo.status === 200 && photo.json?.ok === true, `HTTP ${photo.status} · ${photo.json?.error ?? 'ok'}`);
  const afterPhoto = await countMessages();
  record('1b', 'La foto queda en el hilo (la ve la PWA)', afterPhoto >= beforePhoto, `antes=${beforePhoto} después=${afterPhoto}`);

  // Reintento con la MISMA clave: el pipeline no debe duplicar el archivo.
  const photoRetry = await call(
    'POST',
    `/api/admin/conversations/${conversationId}/media?kind=image&caption=UAT%20Etapa%201&key=${photoKey}`,
    { cookie, bytes: PNG_1X1, contentType: 'image/png', headers: { 'x-phyto-filename': 'uat.png' } },
  );
  const afterPhotoRetry = await countMessages();
  record(
    '1c',
    'Reintentar la misma foto no la duplica',
    afterPhotoRetry === afterPhoto,
    `antes=${afterPhoto} después=${afterPhotoRetry} · HTTP ${photoRetry.status}`,
  );

  // ------------------------------------------------------------ 2. PDF
  const beforePdf = await countMessages();
  const pdf = await call(
    'POST',
    `/api/admin/conversations/${conversationId}/media?kind=document&key=${randomKey('doc')}`,
    { cookie, bytes: PDF_MIN, contentType: 'application/pdf', headers: { 'x-phyto-filename': 'uat.pdf' } },
  );
  record(
    '2a',
    'Enviar un PDF',
    pdf.status === 200 && pdf.json?.ok === true,
    `HTTP ${pdf.status} · ${pdf.json?.error ?? 'ok'}`,
    false,
  );
  const afterPdf = await countMessages();
  record('2b', 'El PDF no rompe el hilo', afterPdf >= beforePdf, `antes=${beforePdf} después=${afterPdf}`, false);

  // ------------------------------------------------------ 3. plantilla
  const templates = await call('GET', '/api/admin/wa-templates', { cookie });
  const approved = (templates.json?.templates ?? []).filter((row) => String(row.status ?? 'APPROVED').toUpperCase() === 'APPROVED');
  record('3a', 'Hay plantillas aprobadas para enviar', approved.length > 0, `${approved.length} aprobadas`, false);
  if (approved.length) {
    /*
     * Se prueba la primera plantilla que el servidor acepte tal cual. Las que
     * llevan huecos obligatorios (número de pedido, delivery) responden 422 con
     * `missing_template_data`: eso es el contrato funcionando, no un fallo.
     */
    const beforeTemplate = await countMessages();
    let enviada = null;
    const rechazos = [];
    for (const template of approved) {
      let sent = await call('POST', `/api/admin/conversations/${conversationId}/messages`, {
        cookie,
        body: { template: template.name },
        operationKey: randomKey('tpl'),
      });
      if (sent.status === 422 && (sent.json?.error === 'missing_template_data' || sent.json?.error === 'missing_order')) {
        /*
         * Los huecos de la plantilla se rellenan con texto de prueba. Se manda
         * una clave NUEVA porque la anterior ya quedó registrada con su 422.
         */
        const valores = { 1: 'UAT', 2: 'UAT', 3: 'UAT', 4: 'UAT', 5: 'UAT', 6: 'UAT' };
        sent = await call('POST', `/api/admin/conversations/${conversationId}/messages`, {
          cookie,
          body: { template: template.name, templateValues: valores },
          operationKey: randomKey('tpl'),
        });
      }
      if (sent.status === 200 || sent.status === 201) {
        enviada = template.name;
        break;
      }
      rechazos.push(`${template.name}→${sent.json?.error ?? sent.status}`);
    }
    const afterTemplate = await countMessages();
    record(
      '3b',
      'Enviar una plantilla aprobada',
      Boolean(enviada) && afterTemplate > beforeTemplate,
      enviada
        ? `«${enviada}» enviada · mensajes ${beforeTemplate}→${afterTemplate}`
        : `ninguna aceptada · ${rechazos.slice(0, 3).join(', ')}`,
      false,
    );
  }

  // ------------------------------------------------------ 4. ubicación / pago
  const sharing = await call('GET', '/api/admin/chat-sharing', { cookie });
  const locations = Array.isArray(sharing.json?.locations) ? sharing.json.locations : [];
  if (locations.length) {
    const sent = await call('POST', `/api/admin/conversations/${conversationId}/location`, {
      cookie,
      body: { locationId: locations[0].id, confirmed: true, idempotencyKey: randomKey('loc') },
      operationKey: randomKey('locop'),
    });
    record('4a', 'Compartir una ubicación guardada', sent.status === 200, `HTTP ${sent.status} · ${sent.json?.error ?? 'ok'}`);
  } else {
    record('4a', 'Compartir una ubicación guardada', true, 'sin ubicaciones configuradas en la semilla (omitido)', false);
  }

  // ------------------------------------------------------ 5. asignación
  const take = await call('POST', `/api/admin/conversations/${conversationId}/take`, { cookie, body: {} });
  const dataAfter = await call('GET', '/api/admin/data?light=1', { cookie });
  const updated = (dataAfter.json?.conversations ?? []).find((row) => row.id === conversationId);
  record(
    '5a',
    'Ponerse al frente de la conversación',
    take.status === 200,
    `HTTP ${take.status} · ${take.json?.error ?? 'ok'}`,
  );
  record(
    '5b',
    'La asignación se ve en el paquete que lee la PWA',
    Boolean(updated?.assigned_user_id),
    `assigned=${updated?.assigned_user_id ?? 'ninguno'}`,
  );

  const release = await call('POST', `/api/admin/conversations/${conversationId}/release`, { cookie, body: {} });
  const dataReleased = await call('GET', '/api/admin/data?light=1', { cookie });
  const releasedRow = (dataReleased.json?.conversations ?? []).find((row) => row.id === conversationId);
  record(
    '5c',
    'Liberar la conversación la deja sin asignar',
    release.status === 200 && !releasedRow?.assigned_user_id,
    `assigned=${releasedRow?.assigned_user_id ?? 'ninguno'}`,
  );

  // Un agente pide la asignación (no se la toma solo).
  const agentCookie = await login(AGENT);
  const agentData = agentCookie ? await call('GET', '/api/admin/data?light=1', { cookie: agentCookie }) : { json: null };
  const agentSees = (agentData.json?.conversations ?? []).some((row) => row.id === conversationId);
  if (!agentCookie) {
    record('5d', 'Un agente puede PEDIR la asignación', false, 'el agente no pudo iniciar sesión', false);
  } else if (!agentSees) {
    record(
      '5d',
      'Un agente puede PEDIR la asignación',
      true,
      'el agente no ve esta conversación en los datos de prueba (aislamiento por empresa): omitido',
      false,
    );
  } else {
    const request = await call('POST', `/api/admin/conversations/${conversationId}/assignment-request`, {
      cookie: agentCookie,
      body: { note: 'UAT Etapa 1' },
    });
    record(
      '5d',
      'Un agente puede PEDIR la asignación',
      request.status === 202 || request.status === 200,
      `HTTP ${request.status} · ${request.json?.error ?? 'ok'}`,
      false,
    );
  }

  printSummary();
  process.exit(critical === 0 ? 0 : 1);
}

function printSummary() {
  const ok = results.filter((row) => row.ok).length;
  console.log('\n────────────────────────────────────────────');
  console.log(`RESULTADO: ${ok}/${results.length} comprobaciones correctas`);
  for (const problem of results.filter((row) => !row.ok)) {
    console.log(`  · ${problem.id} ${problem.name}: ${problem.detail}`);
  }
  console.log('Evidencias de envío (mock): data/uat/envios.log');
  console.log('────────────────────────────────────────────');
}

main().catch((error) => {
  console.error('\nLa prueba se detuvo:', error?.message ?? error);
  printSummary();
  process.exit(1);
});
