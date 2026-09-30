/**
 * PIPELINE DE MEDIA — la orquestación, sin HTTP y sin SDKs.
 *
 * Cuatro piezas, cada una con su oficio (ver `whatsapp-media.mjs`):
 *   media.mjs (PostgreSQL) → media-routes.mjs (HTTP) → este archivo → storage.mjs (R2)
 *
 * AQUÍ NO HAY `req` NI `res`: todo entra y sale por parámetros, así que se puede
 * probar sin levantar un servidor y se puede llamar desde el webhook de Meta sin
 * obligar a mantener la respuesta HTTP abierta.
 *
 * REGLA DE ORO
 * Si el almacén falla, el MENSAJE SIGUE EXISTIENDO. Un "Hola + imagen" con R2
 * caído tiene que aparecer igual en la conversación, con la imagen marcada como
 * no disponible y un botón para reintentar. Nunca se pierde la conversación por
 * culpa del almacenamiento.
 */
import { createHash } from 'node:crypto';
import { LIMITS, buildObjectKey, isAllowedMime, sniffMime } from './storage.mjs';
import { MEDIA_STATUS, SEND_STATUS, UNSAFE_TO_RETRY } from './media.mjs';

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
const kb = (bytes) => `${Math.round(Number(bytes ?? 0) / 1024)} KB`;

/** Límite según el tipo de contenido. */
function limitFor(mediaType) {
  return mediaType === 'image' || mediaType === 'sticker' ? LIMITS.imageMaxBytes : LIMITS.audioMaxBytes;
}

/**
 * Valida un binario ANTES de guardarlo o enviarlo.
 * No se fía del `Content-Type` del navegador, ni de la extensión, ni del nombre:
 * mira los primeros bytes. Un HTML disfrazado de JPEG no pasa.
 *
 * @returns {{ ok: true, mimeType: string } | { ok: false, code: string, message: string }}
 */
export function validateBinary(buffer, { declaredMime = null, expect = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: 'empty_file', message: 'El archivo está vacío.' };
  }
  const real = sniffMime(buffer);
  if (!real) {
    return { ok: false, code: 'unrecognized_type', message: 'El contenido del archivo no es una imagen ni un audio válidos.' };
  }
  if (!isAllowedMime(real)) {
    return { ok: false, code: 'mime_not_allowed', message: 'Ese tipo de archivo no está permitido.' };
  }
  // Si el navegador declara algo distinto de lo real, avisa pero manda lo real.
  if (declaredMime && String(declaredMime).toLowerCase() !== real && !String(declaredMime).startsWith('audio/')) {
    // Se acepta igualmente (los navegadores mienten a menudo), pero lo guardado es lo real.
  }
  if (expect && !real.startsWith(expect)) {
    return { ok: false, code: 'wrong_kind', message: expect === 'image' ? 'Eso no es una imagen.' : 'Eso no es un audio.' };
  }
  const limite = limitFor(real.startsWith('image') ? 'image' : 'audio');
  if (buffer.length > limite) {
    return { ok: false, code: 'too_large', message: `El archivo pesa demasiado (máximo ${Math.round(limite / 1024 / 1024)} MB).` };
  }
  return { ok: true, mimeType: real };
}

/**
 * ¿Qué se puede hacer con una operación de envío que YA existe?
 *
 * Esta es LA función que impide el doble mensaje, así que vive en un solo sitio
 * y con nombre propio:
 *
 *   'done'     → ya salió, o tiene `wa_message_id`: NUNCA se reenvía.
 *   'unknown'  → hubo un intento y no hay confirmación (`SENDING` de una caída,
 *                o un `SEND_UNKNOWN` ya declarado): NUNCA se reintenta solo.
 *   'continue' → no se llegó a enviar (PREPARING, READY_TO_SEND o FAILED de
 *                antes del envío): se puede retomar la MISMA operación.
 */
export function resumeActionFor(row) {
  if (!row) return 'continue';
  if (row.send_status === SEND_STATUS.SENT || row.wa_message_id) return 'done';
  if (UNSAFE_TO_RETRY.includes(row.send_status)) return 'unknown';
  return 'continue';
}

/**
 * @param {{ mediaStore: any, storage: any, whatsappMedia: any, logger?: any, now?: () => Date }} deps
 */
export function createMediaPipeline(deps) {
  const { mediaStore, storage, whatsappMedia } = deps;
  const log = deps.logger ?? (() => {});
  const now = deps.now ?? (() => new Date());

  /**
   * ENTRANTE. Se llama DESPUÉS de que el mensaje y la conversación ya existan
   * (los guarda el CRM) y sin bloquear la respuesta a Meta.
   *
   *   PENDING → DOWNLOADING → [Graph] → validar → [R2] → STORED
   *                                    (si algo falla → FAILED, y el mensaje sigue)
   *
   * Es idempotente (la fila es única por mensaje+tipo) y reintentable: si está
   * en FAILED, volver a llamar lo intenta otra vez con el mismo `media_id`.
   *
   * @param {{ messageId: string, conversationId: string|null, media: any }} input
   */
  async function processInbound(input) {
    const { messageId, media } = input;
    if (!messageId || !media?.waMediaId) {
      return { ok: false, error: { code: 'missing_data', message: 'Falta el mensaje o el media_id.' } };
    }
    const mediaType = media.kind === 'voice' ? 'voice' : String(media.kind ?? 'other');

    // 1) La fila existe desde el primer momento: así la UI ya sabe que hay algo en camino.
    const created = await mediaStore.create({
      messageId,
      mediaType,
      waMediaId: media.waMediaId,
      mimeType: media.mimeType ?? null,
      originalFilename: media.filename ?? null,
      durationMs: media.durationMs ?? null,
      direction: 'inbound',
      status: MEDIA_STATUS.PENDING,
      createdAt: now().toISOString(),
    });
    const row = created.media;
    if (row?.status === MEDIA_STATUS.STORED) return { ok: true, duplicate: true, media: row };

    await mediaStore.update(row.id, { status: MEDIA_STATUS.DOWNLOADING, errorCode: null, errorMessage: null });

    // 2) Descarga desde Graph (dos pasos: URL temporal y luego el archivo).
    const descarga = await whatsappMedia.downloadMedia(media.waMediaId);
    if (!descarga.ok) {
      const marcado = await mediaStore.markFailed(row.id, descarga.error);
      log(`[media] no se pudo descargar ${mediaType} de ${messageId}: ${descarga.error?.code}`);
      return { ok: false, status: MEDIA_STATUS.FAILED, media: marcado.media, error: descarga.error };
    }

    // 3) Validación real del contenido (MIME por bytes + tamaño).
    const valido = validateBinary(descarga.buffer, {
      declaredMime: descarga.declaredMimeType ?? descarga.mimeType,
      expect: mediaType === 'image' || mediaType === 'sticker' ? 'image' : mediaType === 'document' ? null : 'audio',
    });
    if (!valido.ok) {
      const marcado = await mediaStore.markFailed(row.id, { code: valido.code, message: valido.message });
      log(`[media] ${mediaType} rechazado en ${messageId}: ${valido.code}`);
      return { ok: false, status: MEDIA_STATUS.FAILED, media: marcado.media, error: { code: valido.code, message: valido.message } };
    }

    // 4) Almacén (R2). Si esto falla, el mensaje ya está guardado: no se toca.
    const objectKey = buildObjectKey({
      domain: 'whatsapp',
      at: now(),
      conversationId: input.conversationId,
      messageId,
      mime: valido.mimeType,
    });
    const subida = await storage.put(objectKey, descarga.buffer, valido.mimeType);
    if (!subida.ok) {
      const marcado = await mediaStore.markFailed(row.id, { code: subida.error ?? 'storage_failed', message: 'No se pudo guardar el archivo.' });
      log(`[media] almacén caído guardando ${mediaType} de ${messageId}: ${subida.error}`);
      return { ok: false, status: MEDIA_STATUS.FAILED, media: marcado.media, error: { code: subida.error ?? 'storage_failed', message: 'No se pudo guardar el archivo.' } };
    }

    // 5) Listo: metadata en PostgreSQL, binario en R2.
    const guardado = await mediaStore.update(row.id, {
      status: MEDIA_STATUS.STORED,
      objectKey: subida.objectKey ?? objectKey,
      bucket: storage.bucket,
      storageProvider: storage.provider,
      mimeType: valido.mimeType,
      sizeBytes: descarga.buffer.length,
      sha256: sha256hex(descarga.buffer),
      durationMs: media.durationMs ?? row.duration_ms ?? null,
      errorCode: null,
      errorMessage: null,
    });
    log(`[media] ${mediaType} guardado (${kb(descarga.buffer.length)}) para ${messageId}`);
    return { ok: true, status: MEDIA_STATUS.STORED, media: guardado.media };
  }

  /**
   * SALIENTE. La INTENCIÓN se persiste ANTES de tocar Meta, y el envío se graba
   * como "en curso" ANTES de la única llamada irreversible.
   *
   *   PREPARING → validar → R2 → READY_TO_SEND → subir a Meta → SENDING
   *                                                              │
   *                                    ┌─────────────────────────┴───────────────────────┐
   *                              respuesta clara                                sin respuesta fiable
   *                                    │                                               │
   *                    SENT (con wa_message_id)  o  FAILED (Meta rechazó, 4xx)   SEND_UNKNOWN
   *                                                                        (NO se reintenta solo)
   *
   * Por qué esto evita el doble mensaje:
   *   · La operación existe con su `idempotency_key` desde el paso 3, así que un
   *     proceso que muere se puede retomar sin crear otra operación.
   *   · R2 y la subida a Meta se SALTAN si ya se hicieron (están anotadas en la fila).
   *   · `SENDING` se graba justo antes del `send`. Si el proceso cae en ese punto,
   *     lo que queda en disco es "hubo un intento y no sé el resultado", que es
   *     exactamente `SEND_UNKNOWN`: se marca y NO se reenvía.
   *   · Un rechazo claro de Meta (4xx) sí se puede reintentar, porque Meta no creó
   *     ningún mensaje. Un timeout o un 5xx NO: pudo crearlo.
   *   · Con `wa_message_id` conocido, `resumeActionFor` responde 'done' siempre.
   *
   * Si Meta acepta el envío pero la persistencia del mensaje en el CRM falla, la
   * fila queda en SENT con el `wa_message_id`: se completa la persistencia sin
   * volver a mandar nada.
   *
   * @param {{ direction: 'image'|'audio', to: string, buffer: Buffer, declaredMime?: string|null,
   *           caption?: string|null, filename?: string|null, conversationId: string|null,
   *           messageId?: string|null, idempotencyKey?: string|null, findExistingMessage?: Function }} input
   */
  async function processOutbound(input) {
    const kind = input.direction === 'audio' ? 'audio' : 'image';
    const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 80) : null;

    /** La operación ya salió: se devuelve lo que hay, sin tocar Meta. */
    const yaEnviado = (fila) => ({
      ok: true,
      duplicate: true,
      waMessageId: fila.wa_message_id ?? null,
      mediaType: fila.media_type,
      mediaId: fila.id,
      media: fila,
    });

    /**
     * Hubo un intento de envío y no hay confirmación. Se declara el estado
     * ambiguo y se PARA: reintentar aquí es arriesgarse a mandar el mensaje dos
     * veces, que es peor que no mandarlo.
     */
    const ambiguo = async (fila) => {
      const marcado = fila.send_status === SEND_STATUS.SEND_UNKNOWN
        ? fila
        : (await mediaStore.update(fila.id, {
            sendStatus: SEND_STATUS.SEND_UNKNOWN,
            errorAt: now().toISOString(),
          })).media;
      log(`[media] envío ambiguo en ${fila.id}: no se reintenta solo`);
      return {
        ok: false,
        requiresReconciliation: true,
        media: marcado,
        error: {
          code: 'send_unknown',
          message: 'No se puede confirmar si el mensaje llegó. Hay que revisarlo antes de reintentar.',
        },
      };
    };

    // 1) LA INTENCIÓN MANDA. Se busca la operación por su clave antes que nada:
    //    si ya existe, no se crea otra ni se envía nada.
    let row = key ? await mediaStore.byIdempotencyKey(key) : null;
    if (!row && key && typeof input.findExistingMessage === 'function') {
      const previo = await input.findExistingMessage(key);
      if (previo) return { ok: true, duplicate: true, waMessageId: previo.wa_message_id ?? null, message: previo };
    }
    if (row) {
      const accion = resumeActionFor(row);
      if (accion === 'done') return yaEnviado(row);
      if (accion === 'unknown') return ambiguo(row);
      if (row.direction !== 'outbound') {
        return { ok: false, error: { code: 'key_conflict', message: 'Esa clave ya se usó para una operación distinta.' } };
      }
      if (row.media_type !== kind) {
        return { ok: false, error: { code: 'key_conflict', message: 'Esa clave ya se usó para otro tipo de archivo.' } };
      }
    }

    // 2) Validación real del contenido: ni R2 ni Meta, solo bytes.
    const valido = validateBinary(input.buffer, { declaredMime: input.declaredMime, expect: kind });
    if (!valido.ok) {
      if (row) {
        await mediaStore.recordFailure(row.id, {
          provider: 'local', operation: 'validate', safeCode: valido.code,
          status: MEDIA_STATUS.FAILED, sendStatus: SEND_STATUS.FAILED,
        });
      }
      return { ok: false, error: { code: valido.code, message: valido.message } };
    }

    // 3) La fila: es la prueba escrita de que hay una intención de envío.
    if (!row) {
      const creada = await mediaStore.create({
        messageId: input.messageId ?? (key ? `out_${key}` : `out_${Date.now().toString(36)}`),
        mediaType: kind,
        mimeType: valido.mimeType,
        originalFilename: input.filename ?? null,
        direction: 'outbound',
        status: MEDIA_STATUS.UPLOADING,
        sendStatus: SEND_STATUS.PREPARING,
        idempotencyKey: key,
        createdAt: now().toISOString(),
      });
      row = creada.media;
      // Otra ejecución (o un reintento a la vez) ya había creado la operación.
      if (creada.duplicate) {
        const accion = resumeActionFor(row);
        if (accion === 'done') return yaEnviado(row);
        if (accion === 'unknown') return ambiguo(row);
      }
    }

    // 4) R2. Si el archivo ya estaba guardado (caída justo después), no se repite.
    const huella = sha256hex(input.buffer);
    // La clave se ancla a la fecha de creación de la operación y al hash del
    // contenido: un reintento escribe en el MISMO objeto (no deja huérfanos).
    const creadoEn = row.created_at ? new Date(row.created_at) : now();
    const objectKey = row.object_key ?? buildObjectKey({
      domain: 'whatsapp',
      at: Number.isNaN(creadoEn.getTime()) ? now() : creadoEn,
      conversationId: input.conversationId,
      messageId: row.message_id,
      mime: valido.mimeType,
      token: huella.slice(0, 32),
    });
    if (!row.object_key) {
      const subida = await storage.put(objectKey, input.buffer, valido.mimeType);
      if (!subida.ok) {
        // Ni se envió nada ni se contactó con Meta: reintentar es inocuo.
        const marcado = await mediaStore.recordFailure(row.id, {
          provider: 'r2', operation: 'put', safeCode: subida.error ?? 'storage_failed',
          status: MEDIA_STATUS.FAILED, sendStatus: SEND_STATUS.FAILED,
        });
        log(`[media] almacén caído guardando ${kind} de ${row.id}: ${subida.error}`);
        return {
          ok: false,
          error: { code: subida.error ?? 'storage_failed', message: 'No se pudo guardar el archivo. No se ha enviado nada.' },
          media: marcado.media,
        };
      }
      row = (await mediaStore.update(row.id, {
        status: MEDIA_STATUS.STORED,
        sendStatus: SEND_STATUS.READY_TO_SEND,
        objectKey: subida.objectKey ?? objectKey,
        bucket: storage.bucket,
        storageProvider: storage.provider,
        sizeBytes: input.buffer.length,
        sha256: huella,
      })).media;
    } else if (row.send_status !== SEND_STATUS.READY_TO_SEND) {
      row = (await mediaStore.update(row.id, {
        status: MEDIA_STATUS.STORED,
        sendStatus: SEND_STATUS.READY_TO_SEND,
      })).media;
    }

    // 5) Subida a Meta. Si ya se había subido (caída entre subida y envío) se
    //    reutiliza el MISMO media_id: ni archivo nuevo ni envío nuevo.
    let metaMediaId = row.wa_media_id;
    if (!metaMediaId) {
      const enMeta = await whatsappMedia.uploadMedia({
        buffer: input.buffer,
        mimeType: valido.mimeType,
        filename: input.filename ?? undefined,
      });
      if (!enMeta.ok) {
        // OJO: el archivo SÍ está en R2, así que `status` se queda en STORED. Lo
        // que falló es la entrega, y eso se dice en `send_status`. Antes se
        // marcaba toda la fila como FAILED y el archivo guardado parecía perdido.
        const marcado = await mediaStore.recordFailure(row.id, {
          provider: 'graph', operation: 'upload',
          httpStatus: enMeta.error?.httpStatus ?? enMeta.status ?? null,
          safeCode: enMeta.error?.code ?? 'upload_failed',
          status: MEDIA_STATUS.STORED, sendStatus: SEND_STATUS.FAILED,
        });
        log(`[media] Meta no aceptó el archivo de ${row.id}: ${enMeta.error?.code}`);
        return { ok: false, error: enMeta.error, media: marcado.media };
      }
      metaMediaId = enMeta.mediaId;
      row = (await mediaStore.update(row.id, {
        waMediaId: metaMediaId,
        sendStatus: SEND_STATUS.READY_TO_SEND,
      })).media;
    }

    // 6) LA PUERTA. Se graba SENDING (con marca de tiempo) ANTES de la llamada
    //    irreversible: si el proceso muere después, la fila lo cuenta.
    await mediaStore.update(row.id, {
      sendStatus: SEND_STATUS.SENDING,
      sendAttemptedAt: now().toISOString(),
    });

    // 7) El envío, UNA sola vez.
    const envio =
      kind === 'audio'
        ? await whatsappMedia.sendAudio(input.to, { mediaId: metaMediaId })
        : await whatsappMedia.sendImage(input.to, { mediaId: metaMediaId, caption: input.caption ?? null });

    if (!envio.ok) {
      const error = envio.error ?? {};
      const ambiguoElError = error.ambiguous === true || !error.code;
      if (ambiguoElError) {
        // Meta pudo recibirlo. No se reintenta: se marca y lo decide una persona.
        const marcado = await mediaStore.update(row.id, {
          sendStatus: SEND_STATUS.SEND_UNKNOWN,
          provider: 'graph',
          operation: 'send',
          httpStatus: Number(error.httpStatus) > 0 ? Number(error.httpStatus) : null,
          safeCode: String(error.code ?? 'send_failed').slice(0, 60),
          errorCode: String(error.code ?? 'send_failed').slice(0, 40),
          errorMessage: null,
          errorAt: now().toISOString(),
        });
        log(`[media] envío ambiguo en ${row.id}: ${error.code}`);
        return {
          ok: false,
          requiresReconciliation: true,
          media: marcado.media,
          error: {
            code: 'send_unknown',
            message: 'No se puede confirmar si el mensaje llegó. Hay que revisarlo antes de reintentar.',
          },
        };
      }
      // Rechazo claro de Meta (4xx): no creó ningún mensaje, reintentar es seguro.
      const marcado = await mediaStore.recordFailure(row.id, {
        provider: 'graph', operation: 'send',
        httpStatus: error.httpStatus ?? null,
        safeCode: error.code ?? 'send_failed',
        status: MEDIA_STATUS.STORED, sendStatus: SEND_STATUS.FAILED,
      });
      return { ok: false, error, media: marcado.media };
    }

    // 8) Éxito. El wa_message_id se graba INMEDIATAMENTE: a partir de aquí, ni una
    //    caída ni un reintento pueden provocar un segundo mensaje.
    const enviado = await mediaStore.update(row.id, {
      status: MEDIA_STATUS.STORED,
      sendStatus: SEND_STATUS.SENT,
      waMessageId: envio.waMessageId,
      sentAt: now().toISOString(),
      errorAt: null,
      safeCode: null,
    });
    return {
      ok: true,
      waMessageId: envio.waMessageId,
      metaMediaId,
      objectKey,
      mimeType: valido.mimeType,
      sizeBytes: input.buffer.length,
      mediaType: kind,
      mediaId: enviado.media?.id ?? row.id,
    };
  }

  /**
   * RECONCILIACIÓN de un envío ambiguo: es la ÚNICA salida de `SEND_UNKNOWN`.
   *
   * No llama a Meta. Solo corrige el estado local con información ya verificada
   * por una persona (o por el CRM, si encuentra el mensaje en el historial):
   *
   *   outcome 'sent'     + waMessageId → pasa a SENT y se puede persistir el mensaje
   *   outcome 'not_sent'               → vuelve a READY_TO_SEND (reintentable con la misma clave)
   *
   * @param {{ mediaId?: string|null, idempotencyKey?: string|null, outcome: 'sent'|'not_sent', waMessageId?: string|null }} input
   */
  async function reconcileOutbound(input = {}) {
    const row = input.mediaId
      ? await mediaStore.get(input.mediaId)
      : await mediaStore.byIdempotencyKey(input.idempotencyKey);
    if (!row) return { ok: false, error: { code: 'not_found', message: 'Esa operación no existe.' } };

    if (input.outcome === 'sent') {
      if (!input.waMessageId) {
        return { ok: false, error: { code: 'missing_wamid', message: 'Para marcarlo como enviado hace falta el identificador del mensaje.' } };
      }
      const actualizado = await mediaStore.update(row.id, {
        sendStatus: SEND_STATUS.SENT,
        waMessageId: input.waMessageId,
        sentAt: now().toISOString(),
        errorAt: null,
        safeCode: null,
        errorCode: null,
      });
      log(`[media] operación ${row.id} reconciliada como ENVIADA`);
      return { ok: true, media: actualizado.media, waMessageId: input.waMessageId, mediaType: row.media_type };
    }

    if (input.outcome === 'not_sent') {
      const actualizado = await mediaStore.update(row.id, {
        sendStatus: SEND_STATUS.READY_TO_SEND,
        errorAt: null,
        safeCode: null,
        errorCode: null,
      });
      log(`[media] operación ${row.id} reconciliada como NO ENVIADA (reintentable con la misma clave)`);
      return { ok: true, media: actualizado.media, retryable: true, mediaType: row.media_type };
    }

    return { ok: false, error: { code: 'invalid_outcome', message: 'Hay que decir si el mensaje salió o no.' } };
  }

  return { processInbound, processOutbound, reconcileOutbound };
}
