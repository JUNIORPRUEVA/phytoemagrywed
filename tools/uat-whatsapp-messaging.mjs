#!/usr/bin/env node
/**
 * MULTIMEDIA Y OPERACIONES DE CONVERSACIÓN — ACEPTACIÓN CONTRA LA UAT LOCAL.
 *
 * Sube ARCHIVOS DE VERDAD (bytes reales, con su firma), comprueba que se guardan
 * y que se pueden volver a descargar con el MISMO hash, y ejerce las mutaciones
 * de conversación (asignar, resolver, reabrir, archivar, desarchivar, leído y
 * lote) verificando el estado autoritativo del servidor después de cada una.
 *
 * Solo 127.0.0.1 + `uat:true`. WhatsApp en MOCK: nada sale a Meta.
 * Devuelve código ≠ 0 si cualquier aserción falla.
 *
 * Uso:
 *   node tools/uat-whatsapp-messaging.mjs --base=http://127.0.0.1:8791
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [clave, ...resto] = arg.replace(/^--/, '').split('=');
    return [clave, resto.join('=')];
  }),
);

const BASE = args.get('base') ?? 'http://127.0.0.1:8791';
const USUARIO = args.get('user') ?? 'admin@uat.local';
const CLAVE = args.get('password') ?? 'UatLocal-123';

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`[mensajeria-uat] RECHAZADO: la base debe ser local, llegó ${BASE}`);
  process.exit(2);
}

let fallos = 0;
let pruebas = 0;
function comprobar(nombre, ok, detalle) {
  pruebas += 1;
  if (!ok) fallos += 1;
  console.log(`${ok ? 'OK   ' : 'FALLO'} · ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

let cookie = '';
/// Un cuerpo grande rechazado puede dejar muerta la conexión reutilizada:
/// se reintenta una vez para no confundir un corte con un fallo funcional.
async function fetchSeguro(url, opciones, intentos = 2) {
  for (let i = 0; i < intentos; i += 1) {
    try {
      return await fetch(url, opciones);
    } catch (error) {
      if (i === intentos - 1) throw error;
      await new Promise((listo) => setTimeout(listo, 400));
    }
  }
  throw new Error('fetch imposible');
}

async function pedir(ruta, { method = 'GET', body, json = true } = {}) {
  const headers = { cookie };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetchSeguro(new URL(ruta, BASE), { method, headers, body: payload });
  for (const linea of res.headers.getSetCookie?.() ?? []) {
    if (linea.startsWith('pe_crm=')) cookie = linea.split(';')[0];
  }
  const texto = await res.text();
  if (!json) return { status: res.status, texto };
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = null; }
  return { status: res.status, json: datos };
}

// ------------------------------------------------------------- archivos reales
// PNG 1×1 real (bytes de verdad, con su firma completa).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`,
  'latin1',
);

function wav() {
  const datos = Buffer.alloc(1600); // 100 ms de silencio a 8 kHz, 16 bits
  const cabecera = Buffer.alloc(44);
  cabecera.write('RIFF', 0, 'ascii');
  cabecera.writeUInt32LE(36 + datos.length, 4);
  cabecera.write('WAVE', 8, 'ascii');
  cabecera.write('fmt ', 12, 'ascii');
  cabecera.writeUInt32LE(16, 16);
  cabecera.writeUInt16LE(1, 20);
  cabecera.writeUInt16LE(1, 22);
  cabecera.writeUInt32LE(8000, 24);
  cabecera.writeUInt32LE(16000, 28);
  cabecera.writeUInt16LE(2, 32);
  cabecera.writeUInt16LE(16, 34);
  cabecera.write('data', 36, 'ascii');
  cabecera.writeUInt32LE(datos.length, 40);
  return Buffer.concat([cabecera, datos]);
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const cbString = (valor) => (valor === null || valor === undefined ? '' : String(valor));

async function subirMedia(conversationId, { bytes, kind, filename, contentType, caption = '', key }) {
  const url = new URL(`/api/admin/conversations/${encodeURIComponent(conversationId)}/media`, BASE);
  url.searchParams.set('kind', kind);
  if (caption) url.searchParams.set('caption', caption);
  if (key) url.searchParams.set('key', key);
  const res = await fetchSeguro(url, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': contentType,
      'x-phyto-filename': filename,
      ...(key ? { 'x-fulltech-operation': key } : {}),
    },
    body: bytes,
  });
  const texto = await res.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
  return { status: res.status, json, texto };
}

async function estadoConversacion(telefono) {
  const aguja = String(telefono).replace(/\D/g, '').slice(-7);
  const lista = await pedir(`/api/admin/conversations?filter=todos&q=${encodeURIComponent(aguja)}`);
  const filas = Array.isArray(lista.json?.conversations) ? lista.json.conversations : [];
  return filas.find((fila) => {
    const cliente = fila.customer ?? {};
    const tel = String(cliente.phone ?? cliente.phone_e164 ?? '').replace(/\D/g, '');
    return tel.endsWith(aguja);
  }) ?? null;
}

async function mensajes(conversationId) {
  const detalle = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`);
  return Array.isArray(detalle.json?.messages) ? detalle.json.messages : [];
}

/// Entrante sintético firmado como Meta: abre la ventana de servicio (24 h).
async function enviarEntrante(waId, texto) {
  const fuente = await readFile(new URL('../scripts/uat-env.mjs', import.meta.url), 'utf8');
  const secreto = fuente.match(/const SECRETO_WEBHOOK = '([^']+)'/)?.[1] ?? '';
  const destino = fuente.match(/phoneNumberId: '([^']+)'/)?.[1] ?? '';
  if (!secreto || !destino) return { status: 0 };
  const sello = Date.now();
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-uat-mensajeria',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: destino, display_phone_number: '18095550999' },
          contacts: [{ wa_id: waId, profile: { name: 'Sintético' } }],
          messages: [{ from: waId, id: `wamid.MSG.${sello}`, timestamp: Math.floor(sello / 1000), type: 'text', text: { body: texto } }],
        },
      }],
    }],
  });
  const firma = createHmac('sha256', secreto).update(Buffer.from(cuerpo)).digest('hex');
  const res = await fetchSeguro(new URL('/api/webhooks/whatsapp', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${firma}` },
    body: cuerpo,
  });
  return { status: res.status };
}

async function principal() {
  const salud = await fetch(new URL('/api/health', BASE)).then((r) => r.json()).catch(() => null);
  if (!salud?.ok || salud.uat !== true) {
    console.error('[mensajeria-uat] RECHAZADO: /api/health no dice uat:true', salud);
    process.exit(2);
  }
  comprobar('UAT aislada (uat:true)', true, `sqlite items=${salud.items}`);

  const acceso = await pedir('/api/admin/login', { method: 'POST', body: { username: USUARIO, password: CLAVE } });
  if (acceso.status !== 200 || !acceso.json?.ok || !cookie) {
    comprobar('login del administrador', false, `HTTP ${acceso.status}`);
    return;
  }
  comprobar('login del administrador', true, 'cookie pe_crm');

  // Conversación sintética: se prefiere una de los clientes creados por el
  // webhook sintético (tiene cliente y mensajes reales). `start` queda de
  // respaldo. Ojo: el servidor NO deja adjuntar medios a una conversación que
  // no tiene cliente resoluble, así que se exige `customer.phone`.
  const sello = Date.now();
  let conversationId = null;
  let telefono = '';
  let nombre = '';
  const buscar = await pedir('/api/admin/conversations?filter=todos&q=Cliente%20Sint');
  const candidatas = (Array.isArray(buscar.json?.conversations) ? buscar.json.conversations : [])
    .filter((fila) => !fila.archived_at && fila.customer?.phone);
  if (candidatas.length) {
    conversationId = candidatas[0].id;
    telefono = cbString(candidatas[0].customer.phone);
    nombre = cbString(candidatas[0].customer.name);
  } else {
    telefono = `1809002${String(sello).slice(-4)}`;
    nombre = `Cliente Media ${sello}`;
    const inicio = await pedir('/api/admin/conversations/start', {
      method: 'POST',
      body: { phone: telefono, name: nombre, body: `Hola, prueba ${sello}` },
    });
    conversationId = inicio.json?.conversation?.id ?? inicio.json?.conversationId ?? null;
  }
  comprobar('conversación sintética disponible', Boolean(conversationId), `id=${conversationId ?? 'n/a'} · ${nombre}`);
  if (!conversationId) return;

  /*
   * PRIMERO SE TOMA LA CONVERSACIÓN.
   * El servidor no deja mandar una foto ni un audio a una conversación que no
   * es tuya (o que está sin asignar): es la misma regla que el texto.
   */
  const tomar = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/take`, { method: 'POST', body: {} });
  const trasTomar = await estadoConversacion(telefono);
  comprobar(
    'E1 tomar la conversación queda persistido',
    tomar.status === 200 && Boolean(trasTomar?.assigned_user_id),
    `HTTP ${tomar.status}, asignada=${trasTomar?.assigned_user_id ?? 'nadie'}`,
  );

  // ------------------------------------------------------------------ MEDIA
  const antes = (await mensajes(conversationId)).length;

  const png = await subirMedia(conversationId, {
    bytes: PNG,
    kind: 'image',
    filename: `prueba-${sello}.png`,
    contentType: 'image/png',
    caption: 'Prueba PNG',
    key: `img_${sello}`,
  });
  const trasPng = await mensajes(conversationId);
  const mensajePng = trasPng.find((m) => m.type === 'image');
  comprobar('B1 PNG real subido (bytes con firma)', png.status === 200 || png.status === 201, `HTTP ${png.status}`);
  comprobar(
    'B2 el PNG crea UN mensaje de tipo imagen en la conversación',
    trasPng.length === antes + 1 && Boolean(mensajePng),
    `${antes} → ${trasPng.length}, type=${mensajePng?.type ?? 'n/a'}`,
  );
  const mediaIdPng = mensajePng?.media?.id ?? mensajePng?.media_id ?? null;
  comprobar('B3 el mensaje guarda la referencia del medio', Boolean(mediaIdPng), `media=${mediaIdPng ?? 'n/a'}`);

  if (mediaIdPng) {
    const descarga = await fetch(new URL(`/api/admin/media/${encodeURIComponent(mediaIdPng)}`, BASE), {
      headers: { cookie },
    });
    const bytes = Buffer.from(await descarga.arrayBuffer());
    const mismo = bytes.length === PNG.length && sha(bytes) === sha(PNG);
    comprobar('B4 descarga autenticada del PNG con el MISMO hash', descarga.status === 200 && mismo,
      `HTTP ${descarga.status}, ${bytes.length} bytes, sha=${sha(bytes).slice(0, 12)}…`);

    const sinSesion = await fetch(new URL(`/api/admin/media/${encodeURIComponent(mediaIdPng)}`, BASE));
    comprobar('B5 sin sesión NO se descarga el medio', [401, 403, 404].includes(sinSesion.status), `HTTP ${sinSesion.status}`);
  }

  const pdf = await subirMedia(conversationId, {
    bytes: PDF,
    kind: 'document',
    filename: `informe-${sello}.pdf`,
    contentType: 'application/pdf',
    key: `doc_${sello}`,
  });
  const trasPdf = await mensajes(conversationId);
  const mensajePdf = trasPdf.find((m) => m.type === 'document');
  comprobar('B6 PDF real subido', pdf.status === 200 || pdf.status === 201, `HTTP ${pdf.status}`);
  comprobar('B7 el PDF crea un mensaje de tipo documento', Boolean(mensajePdf), `type=${mensajePdf?.type ?? 'n/a'}`);

  const audio = await subirMedia(conversationId, {
    bytes: wav(),
    kind: 'audio',
    filename: `nota-${sello}.wav`,
    contentType: 'audio/wav',
    key: `aud_${sello}`,
  });
  const trasAudio = await mensajes(conversationId);
  comprobar(
    'D1 audio WAV real subido y registrado',
    (audio.status === 200 || audio.status === 201) && trasAudio.some((m) => ['audio', 'voice'].includes(m.type)),
    `HTTP ${audio.status}, tipos=${trasAudio.map((m) => m.type).join(',')}`,
  );

  // Formato no permitido: ejecutable (firma MZ) disfrazado.
  const exe = await subirMedia(conversationId, {
    bytes: Buffer.from('MZ\x90\x00este no es un archivo permitido, es una prueba', 'latin1'),
    kind: 'document',
    filename: `virus-${sello}.exe`,
    contentType: 'application/octet-stream',
    key: `exe_${sello}`,
  });
  const trasExe = await mensajes(conversationId);
  comprobar(
    'B8 formato no permitido rechazado y sin mensaje huérfano',
    exe.status >= 400 && !trasExe.some((m) => String(m.media?.filename ?? m.body ?? '').includes('.exe')),
    `HTTP ${exe.status}`,
  );

  // Tipo declarado que no coincide con el contenido.
  const mentira = await subirMedia(conversationId, {
    bytes: PNG,
    kind: 'document',
    filename: `mentira-${sello}.pdf`,
    contentType: 'application/pdf',
    key: `ment_${sello}`,
  });
  comprobar('B9 tipo declarado que no coincide con los bytes se rechaza', mentira.status >= 400, `HTTP ${mentira.status}`);

  // Tamaño excesivo: 17 MB (> límite de 16 MB), sin guardar nada.
  const grande = Buffer.alloc(17 * 1024 * 1024, 0x41);
  const sobredimension = await subirMedia(conversationId, {
    bytes: grande,
    kind: 'document',
    filename: `grande-${sello}.pdf`,
    contentType: 'application/pdf',
    key: `big_${sello}`,
  });
  comprobar('B10 archivo por encima del límite rechazado', sobredimension.status >= 400, `HTTP ${sobredimension.status}`);

  // Reintento con la MISMA clave: no debe crear un segundo mensaje lógico.
  const antesReintento = (await mensajes(conversationId)).length;
  const reintento = await subirMedia(conversationId, {
    bytes: PNG,
    kind: 'image',
    filename: `prueba-${sello}.png`,
    contentType: 'image/png',
    caption: 'Prueba PNG',
    key: `img_${sello}`,
  });
  const trasReintento = await mensajes(conversationId);
  comprobar(
    'B11 reintento del mismo envío no duplica el mensaje',
    trasReintento.length === antesReintento,
    `${antesReintento} → ${trasReintento.length} (HTTP ${reintento.status})`,
  );

  // ------------------------------------------- A · conversación NUEVA (regresión)
  // Una conversación creada con `conversations/start` tiene que poder recibir
  // medios: antes daba 404 porque el actor se pasaba sin esperar (promesa).
  const telefonoNuevo = `1809006${String(sello).slice(-4)}`;
  const nueva = await pedir('/api/admin/conversations/start', {
    method: 'POST',
    body: { phone: telefonoNuevo, name: `Nueva ${sello}`, body: '' },
  });
  const idNueva = nueva.json?.conversation?.id ?? null;
  comprobar('A1 conversación nueva creada', Boolean(idNueva), `HTTP ${nueva.status} id=${idNueva ?? 'n/a'}`);
  if (idNueva) {
    /*
     * VENTANA CERRADA: la conversación acaba de crearse y el cliente NUNCA ha
     * escrito. Una foto es un mensaje LIBRE, así que Meta no la aceptaría:
     * el servidor tiene que decir `409 outside_window` y no subir nada.
     */
    const pngNueva = await subirMedia(idNueva, {
      bytes: PNG,
      kind: 'image',
      filename: `nueva-${sello}.png`,
      contentType: 'image/png',
      key: `nueva_${sello}`,
    });
    const mensajesNueva = await mensajes(idNueva);
    comprobar(
      'A2 sin mensaje del cliente: medio rechazado con 409 outside_window',
      pngNueva.status === 409 && pngNueva.json?.error === 'outside_window' && mensajesNueva.length === 0,
      `HTTP ${pngNueva.status}, mensajes=${mensajesNueva.length}`,
    );

    // Se abre la ventana con un entrante firmado (como Meta) y se reintenta.
    const textoEntrante = `Hola ${sello}`;
    const alta = await enviarEntrante(telefonoNuevo, textoEntrante);
    // El webhook contesta 200 ANTES de guardar: se espera a que exista.
    let persistido = false;
    for (let intento = 0; intento < 24 && !persistido; intento += 1) {
      const filas = await mensajes(idNueva);
      persistido = filas.some((m) => String(m.body ?? '') === textoEntrante);
      if (!persistido) await new Promise((listo) => setTimeout(listo, 250));
    }
    comprobar('A3a el mensaje entrante del cliente queda guardado', persistido, `HTTP ${alta.status}`);
    /*
     * CLAVE NUEVA para el segundo intento: `x-fulltech-operation` guarda también
     * los rechazos de dominio, así que repetir la MISMA clave devolvería el 409
     * anterior sin volver a ejecutar nada (eso es lo correcto: es otra operación).
     */
    const pngConVentana = await subirMedia(idNueva, {
      bytes: PNG,
      kind: 'image',
      filename: `nueva-${sello}.png`,
      contentType: 'image/png',
      key: `nueva2_${sello}`,
    });
    const mensajesVentana = await mensajes(idNueva);
    comprobar(
      'A3b con la ventana abierta el mismo medio se acepta',
      alta.status === 200 && pngConVentana.status === 200 && mensajesVentana.some((m) => m.type === 'image'),
      `entrante HTTP ${alta.status}, medio HTTP ${pngConVentana.status}, mensajes=${mensajesVentana.length} ${JSON.stringify(pngConVentana.json)}`,
    );
    const repetidoNueva = await subirMedia(idNueva, {
      bytes: PNG,
      kind: 'image',
      filename: `nueva-${sello}.png`,
      contentType: 'image/png',
      key: `nueva2_${sello}`,
    });
    const trasRepetirNueva = await mensajes(idNueva);
    comprobar(
      'A3c reintento con la misma clave en conversación nueva no duplica',
      repetidoNueva.status === 200 && trasRepetirNueva.length === mensajesVentana.length,
      `${mensajesVentana.length} → ${trasRepetirNueva.length}`,
    );
    const desconocida = await subirMedia('cnv_no_existe_uat', {
      bytes: PNG, kind: 'image', filename: 'x.png', contentType: 'image/png', key: `nexiste_${sello}`,
    });
    comprobar('A4 conversación inexistente sigue dando 404', desconocida.status === 404,
      `HTTP ${desconocida.status} · ${String(desconocida.texto ?? '').slice(0, 140)}`);
  }

  // ------------------------------------------------- OPERACIONES DE CONVERSACIÓN
  const leer = async () => estadoConversacion(telefono);
  const inicial = await leer();
  comprobar('E1b estado leído tras tomarla', Boolean(inicial), `asignada=${inicial?.assigned_user_id ?? 'nadie'}`);

  const liberar = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/release`, { method: 'POST', body: {} });
  const trasLiberar = await leer();
  comprobar('E3 liberar la conversación vuelve a dejarla sin dueño',
    liberar.status === 200 && !trasLiberar?.assigned_user_id, `HTTP ${liberar.status}`);

  const resolver = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/resolve`, { method: 'POST', body: {} });
  const trasResolver = await leer();
  comprobar('E4 resolver queda persistido', resolver.status === 200 && Boolean(trasResolver?.is_resolved),
    `HTTP ${resolver.status}, resuelta=${trasResolver?.is_resolved}`);

  const reabrir = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/reopen`, { method: 'POST', body: {} });
  const trasReabrir = await leer();
  comprobar('E5 reabrir queda persistido', reabrir.status === 200 && trasReabrir?.is_resolved === false,
    `HTTP ${reabrir.status}, resuelta=${trasReabrir?.is_resolved}`);

  const archivar = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/archive`, { method: 'POST', body: {} });
  const trasArchivar = await leer();
  comprobar('E6 archivar saca la conversación de la bandeja',
    archivar.status === 200 && (trasArchivar === null || Boolean(trasArchivar?.archived_at)),
    `HTTP ${archivar.status}`);

  const desarchivar = await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/unarchive`, { method: 'POST', body: {} });
  const trasDesarchivar = await leer();
  comprobar('E7 desarchivar la devuelve', desarchivar.status === 200 && Boolean(trasDesarchivar) && !trasDesarchivar?.archived_at,
    `HTTP ${desarchivar.status}`);

  await pedir(`/api/admin/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST', body: {} });
  const trasLeido = await leer();
  comprobar('E8 marcar leído deja el contador a cero', Number(trasLeido?.unread_count ?? 0) === 0,
    `no leídos=${trasLeido?.unread_count ?? 'n/a'}`);

  const lote = await pedir('/api/admin/conversations/bulk', {
    method: 'POST',
    body: { ids: [conversationId], action: 'mark_read' },
  });
  comprobar('E9 acción en lote aceptada', lote.status === 200, `HTTP ${lote.status}`);

  const solicitud = await pedir(
    `/api/admin/conversations/${encodeURIComponent(conversationId)}/assignment-request`,
    { method: 'POST', body: { note: 'Prueba UAT' } },
  );
  comprobar('E10 solicitud de asignación aceptada (200/201/202) o rechazada con motivo (409/422)',
    [200, 201, 202, 409, 422].includes(solicitud.status), `HTTP ${solicitud.status}`);

  // Cierre: estado final coherente y accesible.
  const final = await leer();
  comprobar('E11 la conversación sigue accesible al final', Boolean(final), `id=${final?.id ?? 'n/a'}`);

  console.log('\nRESUMEN', JSON.stringify({ base: BASE, conversationId, telefono, pruebas, fallos }, null, 2));
  process.exitCode = fallos === 0 ? 0 : 1;
}

principal().catch((error) => {
  console.error('[mensajeria-uat] error inesperado:', error?.message ?? error);
  process.exitCode = 1;
});
