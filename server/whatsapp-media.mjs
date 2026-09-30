/**
 * SERVICIO DE MEDIA DE WHATSAPP (Meta / Graph) — SOLO Meta.
 *
 * SEPARACIÓN DE RESPONSABILIDADES (decidida con el negocio)
 *   whatsapp-media.mjs  → hablar con Graph (metadata, descarga, subida, envío)
 *   storage.mjs         → hablar con R2 (binarios)
 *   media.mjs           → hablar con PostgreSQL (metadata y estado)
 *   media-routes.mjs    → hablar con el navegador (HTTP del CRM)
 * Ninguno de estos módulos conoce a los demás por dentro: se les pasa lo que
 * necesitan. Así ninguno crece hasta ser inmantenible.
 *
 * EL TOKEN VIVE AQUÍ Y SOLO AQUÍ
 * Nunca se devuelve, nunca se registra, nunca viaja al navegador. Las URLs de
 * Graph que llevan credenciales tampoco se guardan: caducan en minutos.
 */
/// <reference types="node" />

/**
 * Mensajes por código de Graph. NO se reenvía nunca el texto crudo de Meta: en
 * una respuesta de error puede venir la URL firmada de descarga (que lleva
 * credenciales), así que se traduce a algo corto, en español y sin filtrar nada.
 */
const MENSAJE_POR_CODIGO = {
  190: 'La credencial de WhatsApp no es válida o ha caducado.',
  100: 'Meta rechazó la petición por datos no válidos.',
  200: 'La app no tiene permiso para esa operación en WhatsApp.',
  131047: 'La ventana de 24 horas está cerrada: hace falta una plantilla aprobada.',
  131053: 'WhatsApp no pudo procesar el archivo.',
  131026: 'El mensaje no se pudo entregar a ese número.',
  131000: 'Meta no pudo procesar el envío.',
  90001: 'Meta no pudo procesar la descarga.',
};

/**
 * Error sanitizado: código y subcódigo de Meta, y un texto NUESTRO. Sin secretos.
 *
 * Ademas dice si el resultado es AMBIGUO, que es el dato que decide si se puede
 * reintentar:
 *   - 4xx  → Meta rechazó la petición: NO creó ningún mensaje. Reintentar es seguro.
 *   - 5xx, timeout o red caída → Meta PUDO haberla aceptado. NUNCA reintentar solo.
 */
function safeError(error, httpStatus = 0) {
  const status = Number(httpStatus) || 0;
  const code = error?.code ?? (status || 'graph_error');
  return {
    code,
    subcode: error?.error_subcode ?? null,
    message: MENSAJE_POR_CODIGO[code] ?? (status ? 'Meta rechazó la operación.' : 'No se pudo contactar con Meta.'),
    httpStatus: status,
    ambiguous: status === 0 || status >= 500,
  };
}

/** Error de red/timeout: nunca se sabe si la petición llegó a entrar. */
function netError(error, what) {
  return {
    code: error?.name === 'TimeoutError' ? 'timeout' : 'network',
    subcode: null,
    message: `No se pudo completar la operación con Meta (${what}).`,
    httpStatus: 0,
    ambiguous: true,
  };
}

/**
 * @param {{ accessToken?: string, phoneNumberId?: string, graphVersion?: string,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createWhatsAppMedia(options = {}) {
  const accessToken = String(options.accessToken ?? '');
  const phoneNumberId = String(options.phoneNumberId ?? '');
  const graphVersion = String(options.graphVersion ?? 'v21.0');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs ?? 20000);
  const enabled = Boolean(accessToken && phoneNumberId);
  const base = 'https://graph.facebook.com';

  const signalOf = () =>
    typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;

  /** Convierte la respuesta en `{ok, status, json}` sin filtrar el token. */
  async function json(response) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }

  /** Cuerpo multipart a mano: no hace falta un paquete para dos partes. */
  function multipart(boundary, fields, file) {
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
      );
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(chunks);
  }

  return {
    enabled,

    /**
     * Metadatos del archivo: URL temporal (caduca en minutos) + tipo real + tamaño.
     * @param {string} mediaId
     */
    async getMediaMetadata(mediaId) {
      if (!enabled) return { ok: false, error: { code: 'not_configured', message: 'WhatsApp no configurado', subcode: null } };
      if (!mediaId) return { ok: false, error: { code: 'missing_media_id', message: 'sin media_id', subcode: null } };
      try {
        const response = await fetchImpl(`${base}/${graphVersion}/${encodeURIComponent(mediaId)}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: signalOf(),
        });
        const result = await json(response);
        if (!result.ok) return { ok: false, status: result.status, error: safeError(result.body?.error ?? result.body, result.status) };
        return {
          ok: true,
          status: result.status,
          media: {
            id: result.body?.id ?? mediaId,
            url: result.body?.url ?? null,
            mimeType: result.body?.mime_type ?? null,
            sha256: result.body?.sha256 ?? null,
            fileSize: Number(result.body?.file_size ?? 0) || null,
          },
        };
      } catch (error) {
        return { ok: false, status: 0, error: netError(error, 'metadata') };
      }
    },

    /**
     * Descarga el binario en dos pasos: primero la URL temporal y luego el archivo.
     * Devuelve el buffer y el MIME que declara Meta (que se validará aparte).
     * @param {string} mediaId
     */
    async downloadMedia(mediaId) {
      const meta = await this.getMediaMetadata(mediaId);
      if (!meta.ok) return meta;
      if (!meta.media.url) {
        return { ok: false, status: 0, error: { code: 'no_url', message: 'Meta no devolvió URL de descarga', subcode: null } };
      }
      try {
        const response = await fetchImpl(meta.media.url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: signalOf(),
        });
        if (!response.ok) {
          return { ok: false, status: response.status, error: { code: `http_${response.status}`, message: 'No se pudo descargar el archivo de Meta.', subcode: null, httpStatus: response.status, ambiguous: response.status >= 500 } };
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          ok: true,
          status: response.status,
          buffer,
          mimeType: response.headers.get('content-type') ?? meta.media.mimeType ?? null,
          declaredMimeType: meta.media.mimeType,
          declaredSha256: meta.media.sha256,
          declaredSize: meta.media.fileSize,
        };
      } catch (error) {
        return { ok: false, status: 0, error: netError(error, 'descarga') };
      }
    },

    /**
     * Sube un archivo ya validado y devuelve su `media_id` de Meta.
     * @param {{ buffer: Buffer, mimeType: string, filename?: string }} input
     */
    async uploadMedia(input) {
      if (!enabled) return { ok: false, error: { code: 'not_configured', message: 'WhatsApp no configurado', subcode: null } };
      const boundary = `----phyto${Date.now().toString(16)}`;
      const payload = multipart(
        boundary,
        { messaging_product: 'whatsapp', type: input.mimeType },
        { buffer: input.buffer, filename: input.filename ?? 'archivo', contentType: input.mimeType },
      );
      try {
        const response = await fetchImpl(`${base}/${graphVersion}/${encodeURIComponent(phoneNumberId)}/media`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          body: payload,
          signal: signalOf(),
        });
        const result = await json(response);
        if (!result.ok) return { ok: false, status: result.status, error: safeError(result.body?.error ?? result.body, result.status) };
        const mediaId = String(result.body?.id ?? '');
        if (!mediaId) {
          // Meta respondió 200 pero sin `id`: el archivo puede existir. Ambiguo.
          return { ok: false, status: result.status, error: { code: 'missing_media_id', subcode: null, message: 'Meta no devolvió el identificador del archivo.', httpStatus: result.status, ambiguous: true } };
        }
        return { ok: true, status: result.status, mediaId };
      } catch (error) {
        return { ok: false, status: 0, error: netError(error, 'subida') };
      }
    },

    /**
     * Envía una imagen ya subida (por su `media_id`). El envío es SIEMPRE una
     * acción humana: esto no se llama solo.
     */
    async sendImage(to, { mediaId, caption = null, link = null }) {
      return this.sendMessage(to, {
        type: 'image',
        image: link ? { link } : { id: mediaId },
      }, caption);
    },

    /** Envía un audio ya subido (nota de voz o archivo). Nunca autoplay en origen. */
    async sendAudio(to, { mediaId, link = null }) {
      return this.sendMessage(to, { type: 'audio', audio: link ? { link } : { id: mediaId } });
    },

    /** Envío genérico de un mensaje con archivo (una sola puerta). */
    async sendMessage(to, payload, caption = null) {
      if (!enabled) return { ok: false, error: { code: 'not_configured', message: 'WhatsApp no configurado', subcode: null } };
      const body = { messaging_product: 'whatsapp', to, ...payload };
      if (caption && body.image) body.image.caption = caption;
      try {
        const response = await fetchImpl(`${base}/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: signalOf(),
        });
        const result = await json(response);
        if (!result.ok) return { ok: false, status: result.status, error: safeError(result.body?.error ?? result.body, result.status) };
        const wamid = result.body?.messages?.[0]?.id ? String(result.body.messages[0].id) : null;
        if (!wamid) {
          // 200 sin `messages[0].id`: NO se puede afirmar que el mensaje se creó.
          // Tratarlo como éxito silencioso es exactamente lo que luego duplica.
          return {
            ok: false,
            status: result.status,
            error: {
              code: 'missing_wamid',
              subcode: null,
              message: 'Meta aceptó la petición pero no devolvió el identificador del mensaje.',
              httpStatus: result.status,
              ambiguous: true,
            },
          };
        }
        return { ok: true, status: result.status, waMessageId: wamid };
      } catch (error) {
        return { ok: false, status: 0, error: netError(error, 'envío') };
      }
    },
  };
}
