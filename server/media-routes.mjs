/**
 * RUTAS DE MEDIA DEL CRM — la única pieza que habla HTTP.
 *
 * ESTE MÓDULO NO CONOCE A NADIE POR DENTRO
 * Todo lo que necesita entra por parámetro (inyección): el almacén de metadata,
 * el de archivos, el pipeline, el servicio de Meta y tres funciones del CRM
 * (autorización, resolución de conversación y persistencia del mensaje). Así se
 * registra desde `crm-server.mjs` con una integración mínima, y se puede probar
 * sin levantar el servidor ni hablar con R2 ni con Meta.
 *
 * DISEÑO DE INTEGRACIÓN (para cuando `crm-server.mjs` quede libre)
 *   const handleMedia = createMediaRoutes({ ...deps });
 *   // dentro del enrutador, antes del 404:
 *   if (await handleMedia({ route, req, res, url })) return;
 *
 * PRIVACIDAD
 * El bucket es privado y no hay URLs públicas ni firmadas: el navegador pide el
 * archivo a este endpoint, que autoriza la sesión del CRM y lo sirve. Las
 * respuestas nunca incluyen bucket, `object_key`, endpoint de R2, tokens ni la
 * URL de Graph.
 */
import { MEDIA_STATUS, SEND_STATUS } from './media.mjs';

const MB = 1024 * 1024;
const MAX_UPLOAD_BYTES = 16 * MB;

/** Respuesta JSON compacta (mismo estilo que el resto del API). */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/** Lee el cuerpo crudo con tope: nunca se confía en el tamaño que diga el cliente. */
function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('payload_too_large');
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Mensaje de error amable por estado del ARCHIVO (sin filtrar nada interno). */
const estadoAmable = {
  [MEDIA_STATUS.PENDING]: 'El archivo todavía no se ha empezado a preparar.',
  [MEDIA_STATUS.DOWNLOADING]: 'El archivo se está descargando todavía.',
  [MEDIA_STATUS.UPLOADING]: 'El archivo se está subiendo todavía.',
  [MEDIA_STATUS.SENDING]: 'El mensaje se está enviando todavía.',
  [MEDIA_STATUS.FAILED]: 'El archivo no está disponible.',
};

/** Mensaje amable por estado de ENTREGA (lo que le importa al que usa el CRM). */
const entregaAmable = {
  [SEND_STATUS.SENDING]: 'El mensaje se está enviando todavía.',
  [SEND_STATUS.SEND_UNKNOWN]: 'No se puede confirmar si el mensaje llegó. Revísalo antes de reintentar.',
  [SEND_STATUS.FAILED]: 'El mensaje no se pudo enviar.',
};

/**
 * Textos por CÓDIGO de error. La respuesta al navegador se construye con esto, no
 * copiando el mensaje que venga de dentro: si algún día un mensaje interno trae
 * una URL firmada con credenciales, no puede acabar en una respuesta HTTP.
 */
const errorAmable = {
  empty_file: 'El archivo está vacío.',
  unrecognized_type: 'Eso no parece una imagen ni un audio.',
  mime_not_allowed: 'Ese tipo de archivo no está permitido.',
  wrong_kind: 'El archivo no es del tipo que se está enviando.',
  too_large: 'El archivo pesa demasiado.',
  storage_failed: 'No se pudo guardar el archivo. No se ha enviado nada.',
  network: 'No se pudo contactar con el servicio. No se ha enviado nada.',
  timeout: 'El servicio tardó demasiado. No se ha enviado nada.',
  not_configured: 'WhatsApp no está configurado.',
  key_conflict: 'Esa operación ya estaba en curso.',
  send_failed: 'No se pudo enviar el archivo.',
  // Conversión de audio (ver `server/audio-normalize.mjs`): se explica QUÉ pasa y
  // qué hacer, en vez de dejar al usuario con un «Meta rechazó el audio».
  converter_missing:
    'WhatsApp no acepta este formato de audio y este servidor no tiene conversor. Prueba con OGG/Opus, M4A o MP3.',
  convert_failed: 'No se pudo convertir el audio a un formato que WhatsApp acepte. Prueba con otra grabación.',
  convert_timeout: 'La conversión del audio tardó demasiado. Prueba con una nota más corta.',
  convert_empty: 'La conversión salió vacía: el audio no tiene sonido aprovechable.',
};

/**
 * @param {{ mediaStore: any, storage: any, pipeline: any, whatsappMedia?: any,
 *           isAuthorized: (req: any) => boolean,
 *           resolveConversation?: (id: string) => Promise<any>,
 *           persistOutbound?: (input: any) => Promise<any>,
 *           findMessageByKey?: (key: string) => Promise<any>,
 *           logger?: (message: string) => void }} deps
 */
export function createMediaRoutes(deps) {
  const { mediaStore, storage, pipeline } = deps;
  const isAuthorized = deps.isAuthorized ?? (() => false);
  const log = deps.logger ?? (() => {});

  /**
   * Sirve el archivo de una fila de media. No se expone el binario por ninguna
   * otra vía: o pasa por aquí (con sesión) o no se ve.
   */
  async function serveMedia(id, res) {
    const media = await mediaStore.get(id);
    if (!media) return json(res, 404, { ok: false, error: 'not_found' });

    if (media.status !== MEDIA_STATUS.STORED) {
      const status = media.status === MEDIA_STATUS.FAILED ? 409 : 409;
      return json(res, status, {
        ok: false,
        error: media.status === MEDIA_STATUS.FAILED ? 'media_failed' : 'media_pending',
        status: media.status,
        message: estadoAmable[media.status] ?? 'El archivo no está listo.',
      });
    }
    if (!media.object_key) return json(res, 404, { ok: false, error: 'not_found' });

    const archivo = await storage.get(media.object_key);
    if (!archivo.ok) {
      // El almacén cayó: es un problema temporal, no un 404 del archivo.
      log(`[media] R2 no respondió sirviendo ${id}: ${archivo.error}`);
      return json(res, 502, { ok: false, error: 'storage_unavailable' });
    }

    const contentType = media.mime_type && /^(image|audio|application)\//.test(media.mime_type)
      ? media.mime_type
      : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(archivo.buffer.length),
      // Media privada del CRM: nada de cachés compartidas ni intermedias.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // Se muestra en la app, no se descarga como archivo suelto.
      'content-disposition': 'inline',
    });
    res.end(archivo.buffer);
    return true;
  }

  /**
   * Reintento / reconciliación de una fila que no está lista.
   *
   * POLÍTICA DE REINTENTO (sin excepciones, porque aquí se juega el doble mensaje)
   *   Fallo ANTES de Meta send (validación, R2)      → reintentar es inocuo
   *   Fallo en la subida a Meta (sin mensaje creado) → reintentar es inocuo
   *   Failo de R2                                    → nunca se contacta con Meta
   *   SENDING / SEND_UNKNOWN                         → NUNCA automático: exige reconciliación
   *   SENT con wa_message_id                         → el envío no se repite jamás
   *
   * La reconciliación (la acción segura de una persona que ya miró WhatsApp) se
   * hace por ESTE mismo endpoint con `?outcome=sent|not_sent`, para no inventar
   * rutas nuevas ni ampliar la superficie pública.
   */
  async function retryMedia(id, res, url) {
    const media = await mediaStore.get(id);
    if (!media) return json(res, 404, { ok: false, error: 'not_found' });

    // Reconciliación explícita de un envío ambiguo: no se llama a Meta.
    const outcome = url?.searchParams?.get('outcome') ?? null;
    if (outcome === 'sent' || outcome === 'not_sent') {
      if (typeof pipeline.reconcileOutbound !== 'function') {
        return json(res, 501, { ok: false, error: 'not_configured' });
      }
      const reconciliado = await pipeline.reconcileOutbound({
        mediaId: media.id,
        outcome,
        waMessageId: (url.searchParams.get('wa_message_id') ?? '').slice(0, 120) || null,
      });
      if (!reconciliado.ok) {
        const code = reconciliado.error?.code ?? 'reconcile_failed';
        return json(res, code === 'missing_wamid' ? 422 : 409, {
          ok: false,
          error: code,
          message: reconciliado.error?.message ?? 'No se pudo reconciliar la operación.',
        });
      }
      return json(res, 200, { ok: true, reconciled: outcome, retryable: Boolean(reconciliado.retryable) });
    }

    // SALIENTE: se decide solo por el estado de ENTREGA, nunca por el del archivo.
    if (media.direction !== 'inbound') {
      if (media.send_status === SEND_STATUS.SENT || media.wa_message_id) {
        return json(res, 200, { ok: true, already: true, sendStatus: SEND_STATUS.SENT });
      }
      if (media.send_status === SEND_STATUS.SENDING || media.send_status === SEND_STATUS.SEND_UNKNOWN) {
        return json(res, 409, {
          ok: false,
          error: 'send_unknown',
          requiresReconciliation: true,
          message: entregaAmable[SEND_STATUS.SEND_UNKNOWN],
        });
      }
      // Falló antes de enviar: el archivo está en el panel de quien lo mandó, así
      // que se repite desde la conversación con la MISMA clave (que reanuda la
      // operación en vez de crear otra).
      return json(res, 409, {
        ok: false,
        error: 'not_retryable',
        requiresReconciliation: false,
        message: 'Se reintenta desde la conversación, con la misma clave.',
      });
    }

    if (media.status === MEDIA_STATUS.STORED) {
      return json(res, 200, { ok: true, already: true, status: media.status });
    }
    // Sin el identificador de Meta no hay nada que reintentar: se conserva la
    // metadata tal cual (no se destruye nada) y se explica.
    if (!media.wa_media_id) {
      return json(res, 409, { ok: false, error: 'not_retryable', message: 'Este archivo no se puede volver a intentar.' });
    }

    const resultado = await pipeline.processInbound({
      messageId: media.message_id,
      conversationId: null,
      media: { kind: media.media_type, waMediaId: media.wa_media_id, mimeType: media.mime_type, durationMs: media.duration_ms },
    });
    if (resultado.ok) return json(res, 200, { ok: true, status: resultado.status });
    return json(res, 409, {
      ok: false,
      error: resultado.error?.code ?? 'retry_failed',
      message: 'No se ha podido recuperar el archivo. El mensaje sigue en la conversación.',
      status: MEDIA_STATUS.FAILED,
    });
  }

  /**
   * Subida desde el panel para enviar imagen o audio. El navegador manda los
   * BYTES CRUDOS (no multipart) para no tener que analizar partes en el servidor:
   * el tipo real se decide mirando el contenido, no la cabecera.
   */
  async function uploadMedia(conversationId, req, res, url) {
    if (typeof deps.resolveConversation !== 'function') {
      return json(res, 501, { ok: false, error: 'not_configured' });
    }
    const contexto = await deps.resolveConversation(conversationId);
    if (!contexto?.conversation || !contexto?.customer) {
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    const telefono = contexto.customer.phone_e164;
    if (!telefono) return json(res, 422, { ok: false, error: 'missing_phone', message: 'Ese cliente no tiene teléfono.' });

    let buffer;
    try {
      buffer = await readRawBody(req);
    } catch (error) {
      return json(res, error.status ?? 400, { ok: false, error: error.message });
    }

    const kind = url.searchParams.get('kind') === 'audio' ? 'audio' : 'image';
    const caption = (url.searchParams.get('caption') ?? '').slice(0, 1024) || null;
    const idempotencyKey = (url.searchParams.get('key') ?? '').slice(0, 80) || null;

    const resultado = await pipeline.processOutbound({
      direction: kind,
      to: telefono,
      buffer,
      declaredMime: req.headers['content-type'] ?? null,
      caption,
      filename: (req.headers['x-phyto-filename'] ?? '').slice(0, 120) || null,
      conversationId: contexto.conversation.id,
      idempotencyKey,
      findExistingMessage: deps.findMessageByKey,
    });

    if (!resultado.ok) {
      const code = resultado.error?.code ?? 'send_failed';
      // Envío AMBIGUO: Meta pudo recibirlo. No es un fallo normal y no puede
      // parecerlo, porque el panel lo reintentaría y duplicaría el mensaje.
      if (resultado.requiresReconciliation) {
        return json(res, 409, {
          ok: false,
          error: 'send_unknown',
          requiresReconciliation: true,
          message: entregaAmable[SEND_STATUS.SEND_UNKNOWN],
        });
      }
      // Ni el bucket, ni el `object_key`, ni el código de Meta salen de aquí.
      // El texto es NUESTRO: no se copia ningún mensaje de dentro del pipeline.
      return json(res, code === 'too_large' ? 413 : 422, {
        ok: false,
        error: code,
        message: errorAmable[code] ?? 'No se pudo enviar el archivo.',
      });
    }
    if (resultado.duplicate) return json(res, 200, { ok: true, duplicate: true, message: resultado.message });

    // El mensaje lo persiste el CRM (una sola forma de guardar mensajes).
    const guardado = typeof deps.persistOutbound === 'function'
      ? await deps.persistOutbound({
          customer: contexto.customer,
          conversation: contexto.conversation,
          type: resultado.mediaType,
          waMessageId: resultado.waMessageId,
          caption,
          idempotencyKey,
        })
      : { ok: true };
    return json(res, 200, {
      ok: true,
      message: guardado?.message ?? null,
      mediaType: resultado.mediaType,
    });
  }

  /**
   * Punto de entrada único. Devuelve `true` si ha atendido la petición, para que
   * el enrutador del CRM pueda seguir con lo suyo si no es suya.
   */
  return async function handleMediaRoute({ route, req, res, url }) {
    const esMedia = route === '/api/admin/media' || route.startsWith('/api/admin/media/');
    const esUpload = /^\/api\/admin\/conversations\/[^/]+\/media$/.test(route);
    if (!esMedia && !esUpload) return false;

    // Nada de rutas públicas: sin sesión del CRM no se sirve ni un byte.
    if (!isAuthorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    if (esMedia && req.method === 'GET') {
      const id = decodeURIComponent(route.slice('/api/admin/media/'.length));
      if (!id) return json(res, 404, { ok: false, error: 'not_found' }), true;
      await serveMedia(id, res);
      return true;
    }

    if (esMedia && req.method === 'POST' && route.startsWith('/api/admin/media/retry/')) {
      const id = decodeURIComponent(route.slice('/api/admin/media/retry/'.length));
      await retryMedia(id, res, url);
      return true;
    }

    if (esUpload && req.method === 'POST') {
      const conversationId = decodeURIComponent(route.split('/')[4]);
      await uploadMedia(conversationId, req, res, url);
      return true;
    }

    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  };
}
