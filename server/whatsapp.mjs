/**
 * WHATSAPP CLOUD API (oficial de Meta) — cliente aislado y utilidades de webhook.
 *
 * Reglas de esta fase:
 *  - SOLO la API oficial (`graph.facebook.com`). Nada de automatizar WhatsApp Web,
 *    Baileys, Selenium ni APIs no oficiales.
 *  - El `access_token` vive aquí y solo aquí: nunca se registra, nunca se devuelve
 *    al navegador y los errores salen saneados.
 *  - Este módulo NO decide cuándo se envía nada: expone funciones de envío. Quien
 *    envía es el panel, con una persona pulsando el botón.
 *
 * Documentación: docs/WHATSAPP_INTEGRATION.md
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { cleanText, locationFromInbound, parseCoordinates } from './locations.mjs';
import { normalizePhone } from './meta-capi.mjs';

/** Versión de la Graph API para WhatsApp (se puede fijar por entorno). */
export const DEFAULT_GRAPH_VERSION = 'v21.0';

/** Ventana de atención al cliente de WhatsApp (24 h desde el último mensaje del cliente). */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Teléfono en formato E.164 (`+18091234567`) a partir de lo que escriba una
 * persona. Se apoya en la normalización que ya usa la API de conversiones: una
 * sola regla para todo el sistema (809/829/849 → +1…).
 *
 * @param {unknown} raw
 * @param {{ countryCode?: string }} [options]
 * @returns {string|null}
 */
export function toE164(raw, options = {}) {
  const digits = normalizePhone(raw, options);
  return digits ? `+${digits}` : null;
}

/** Solo los dígitos (formato que usa la API de WhatsApp y el CRM). */
export function toWaId(raw, options = {}) {
  return normalizePhone(raw, options);
}

// --------------------------------------------------------------- clasificación

/**
 * ¿El cliente pide no recibir más mensajes?
 *
 * Normaliza el texto (minúsculas, sin acentos ni signos) y busca fórmulas claras.
 * Es deliberadamente conservador: ante la duda NO marca opt-out (marcar de más
 * cortaría una conversación legítima), pero lo evidente siempre se detecta.
 *
 * @param {unknown} text
 */
export function detectOptOut(text) {
  const value = normalizeForMatch(text);
  if (!value) return false;
  return [
    /\bstop\b/,
    /\bparar?\b/,
    /\bno\s+mas\b/,
    /\bno\s+quiero\s+(recibir|mas)\b/,
    /\bcancel\w*\s+(los\s+)?mensajes\b/,
    /\bno\s+me\s+(escribas|molestes)\b/,
    /\bbaja\s+de\s+mensajes\b/,
    // Variantes que la gente escribe de verdad (probadas en el CRM).
    /\bno\s+me\s+(envies|envien|escriban|manden|molesten)\b/,
    /\bno\s+quiero\s+que\s+me\s+(escriban|escribas|envien|manden)\b/,
    /\bno\s+(enviar|mandar|escribir)\s+(mas\s+)?(mensajes|nada)\b/,
    /\bdejen?\s+de\s+(escribir|enviar|mandar|molestar)/,
    /\b(quitar|quiten|eliminar|eliminen|borrar|borren|sacar|saquen)\s+mi\s+numero\b/,
    /\b(desuscrib|unsubscribe)\w*/,
  ].some((pattern) => pattern.test(value));
}

/** ¿El cliente pide hablar con una persona? */
export function detectHumanRequest(text) {
  const value = normalizeForMatch(text);
  if (!value) return false;
  return [
    /\bhablar\s+con\s+(una\s+)?persona\b/,
    /\batencion\s+humana\b/,
    /\bpersona\s+real\b/,
    /\bque\s+me\s+llame\b/,
    /\bquiero\s+hablar\s+con\s+alguien\b/,
    /\bno\s+eres\s+una\s+persona\b/,
  ].some((pattern) => pattern.test(value));
}

/** ¿Menciona salud/efectos (requiere atención humana, no respuesta automática)? */
export function detectHealthConcern(text) {
  const value = normalizeForMatch(text);
  if (!value) return false;
  return [/\befecto\b/, /\bcontraindicac/, /\balergi/, /\bmedicament/, /\bembaraz/, /\bsintoma/].some((pattern) =>
    pattern.test(value),
  );
}

/**
 * Clasificación por REGLAS (sin IA en esta fase).
 *
 * Determinista y auditable: sirve para etiquetar la conversación y decidir si
 * hay que avisar a una persona. No dispara ninguna respuesta automática.
 *
 * @param {unknown} text
 * @returns {'OPT_OUT'|'HUMAN_REQUEST'|'PRICE'|'HOW_TO_USE'|'PRODUCT_INFO'|'ORDER_INTENT'|'GREETING'|'OTHER'}
 */
export function classifyIntent(text) {
  const value = normalizeForMatch(text);
  if (!value) return 'OTHER';
  if (detectOptOut(value)) return 'OPT_OUT';
  if (detectHumanRequest(value)) return 'HUMAN_REQUEST';
  if (/precio|cuanto\s+(cuesta|vale|es)|tarifa/.test(value)) return 'PRICE';
  if (/como\s+(se\s+)?(usa|toma)|dosis|cuantas\s+capsulas|modo\s+de\s+uso/.test(value)) return 'HOW_TO_USE';
  if (/quiero\s+(comprar|pedir|ordenar)|hacer\s+un\s+pedido|lo\s+quiero|me\s+interesa|comprar/.test(value))
    return 'ORDER_INTENT';
  if (/capsulas|frasco|capsula|producto|que\s+es/.test(value)) return 'PRODUCT_INFO';
  if (/^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|saludos)\b/.test(value)) return 'GREETING';
  return 'OTHER';
}

/** Texto comparable: minúsculas, sin acentos y sin signos de puntuación. */
function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s¿?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------------------------------------------------------- cliente

/**
 * Crea el cliente de la API de WhatsApp.
 *
 * Sin `accessToken` o sin `phoneNumberId` queda desactivado y `send()` devuelve
 * `{ ok:false, skipped:true }`: el CRM sigue funcionando (se ve la conversación,
 * se registra todo) y no hace falta llenar el código de condicionales.
 *
 * @param {object} [options]
 * @param {string} [options.accessToken]
 * @param {string} [options.phoneNumberId]
 * @param {string} [options.graphVersion]
 * @param {string} [options.businessAccountId]
 * @param {boolean} [options.mock]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 */
export function createWhatsAppClient(options = {}) {
  const accessToken = String(options.accessToken ?? '').trim();
  const phoneNumberId = String(options.phoneNumberId ?? '').trim();
  const businessAccountId = String(options.businessAccountId ?? '').trim();
  const graphVersion = String(options.graphVersion ?? '').trim() || DEFAULT_GRAPH_VERSION;
  const timeoutMs = Number(options.timeoutMs ?? 8000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const mock = options.mock === true;
  // `log` admite una función, `false` (silencioso) o nada (consola). Pasarlo mal
  // no puede tumbar el arranque del CRM.
  const log =
    typeof options.log === 'function'
      ? options.log
      : options.log === false
        ? () => {}
        : (message) => console.log(message);

  const enabled = mock || Boolean(accessToken && phoneNumberId && typeof fetchImpl === 'function');
  if (mock) log('[wa] API de WhatsApp en modo LOCAL MOCK: no se envía nada a Meta.');
  if (!enabled) log('[wa] API de WhatsApp desactivada: faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID.');

  /**
   * Envía un payload a la API. Nunca lanza y nunca registra el token.
   * @param {Record<string, any>} payload
   */
  async function send(payload) {
    if (mock) {
      return {
        ok: true,
        status: 200,
        messageId: `wamid.LOCAL.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
        waId: String(payload?.to ?? '') || null,
        mock: true,
      };
    }
    if (!enabled) return { ok: false, skipped: true, reason: 'not_configured' };
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      const text = await response.text();
      /** @type {any} */
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok || parsed?.error) {
        return {
          ok: false,
          status: response.status,
          error: sanitizeMetaError(parsed?.error ?? { message: text }, accessToken, response.status),
        };
      }
      return {
        ok: true,
        status: response.status,
        messageId: parsed?.messages?.[0]?.id ?? null,
        waId: parsed?.contacts?.[0]?.wa_id ?? null,
      };
    } catch (error) {
      return { ok: false, error: sanitizeMetaError(error, accessToken) };
    }
  }

  return {
    enabled,
    graphVersion,
    phoneNumberId: enabled ? phoneNumberId : null,
    businessAccountId: businessAccountId || null,
    send,
    /** Texto libre: SOLO dentro de la ventana de 24 h (lo valida el CRM antes). */
    sendText(to, body, options = {}) {
      return send({
        to,
        type: 'text',
        text: { preview_url: options.previewUrl === true, body: String(body).slice(0, 4096) },
        ...(options.replyTo ? { context: { message_id: options.replyTo } } : {}),
      });
    },
    /** Plantilla aprobada por Meta: la única forma de escribir fuera de la ventana. */
    sendTemplate(to, template = {}) {
      return send({
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language ?? 'es' },
          ...(template.components ? { components: template.components } : {}),
        },
      });
    },
    /** Lista plantillas reales del WABA en Meta. Es read-only y no expone tokens. */
    async listTemplates(options = {}) {
      if (mock) return { ok: false, skipped: true, reason: 'mock_mode' };
      if (!enabled || !businessAccountId) return { ok: false, skipped: true, reason: 'not_configured' };
      const fields = encodeURIComponent(
        String(options.fields ?? 'name,id,language,category,status,quality_score,components'),
      );
      const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(250, Number(options.limit))) : 250;
      try {
        const response = await fetchImpl(
          `https://graph.facebook.com/${graphVersion}/${businessAccountId}/message_templates?fields=${fields}&limit=${limit}`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
          },
        );
        const text = await response.text();
        /** @type {any} */
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        if (!response.ok || parsed?.error) {
          return {
            ok: false,
            status: response.status,
            error: sanitizeMetaError(parsed?.error ?? { message: text }, accessToken, response.status),
          };
        }
        return {
          ok: true,
          status: response.status,
          requestId: response.headers?.get?.('x-fb-request-id') ?? null,
          templates: Array.isArray(parsed?.data) ? parsed.data : [],
        };
      } catch (error) {
        return { ok: false, error: sanitizeMetaError(error, accessToken) };
      }
    },
    /** Botones de respuesta rápida (requiere plantilla o ventana abierta). */
    sendInteractive(to, interactive = {}) {
      return send({ to, type: 'interactive', interactive });
    },
    /**
     * UBICACIÓN estática (una sola, no «en vivo»: la Cloud API no permite enviar
     * live location). Obligatorios `latitude`/`longitude`; `name`/`address` son
     * opcionales y algunos clientes no los pintan, así que no se inventan.
     *
     * NUNCA se envía una URL de mapa: la fuente de verdad son las coordenadas, y
     * mandar un enlace externo sería regalar la ubicación a un tercero.
     */
    async sendLocation(to, location = {}) {
      const parsed = parseCoordinates(location);
      if (!parsed.ok) return { ok: false, error: { code: parsed.code, message: parsed.message } };
      const name = cleanText(location.name, 120);
      const address = cleanText(location.address, 300);
      return send({
        to,
        type: 'location',
        location: {
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          ...(name ? { name } : {}),
          ...(address ? { address } : {}),
        },
      });
    },
    /** Marca como leído (dos ticks azules). No es un mensaje. */
    async markAsRead(messageId) {
      if (!enabled || !messageId) return { ok: false, skipped: true };
      return send({ status: 'read', message_id: messageId });
    },
  };
}

/**
 * Error de Meta saneado: SIN token, sin URL con credenciales y recortado.
 *
 * @param {any} error
 * @param {string} [secret]
 * @param {number} [status]
 */
export function sanitizeMetaError(error, secret = '', status = 0) {
  const source =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : 'error';
  let message = source.replace(/\s+/g, ' ').slice(0, 300);
  if (secret) message = message.replaceAll(secret, '[oculto]');
  message = message.replace(/EAA[\w-]{20,}/g, '[oculto]').replace(/access_token=[^&\s]+/gi, 'access_token=[oculto]');
  return {
    status: error?.status ?? status ?? Number(error?.code) ?? null,
    code: error?.code ?? null,
    subcode: error?.error_subcode ?? null,
    type: error?.type ?? null,
    message,
  };
}

// -------------------------------------------------------------------- webhook

/**
 * Verificación del webhook (`GET /api/webhooks/whatsapp`).
 *
 * Meta llama con `hub.mode=subscribe`, `hub.verify_token` y `hub.challenge`. Si
 * el token coincide, hay que devolver el `challenge` en texto plano.
 *
 * @param {{ mode?: string|null, token?: string|null, challenge?: string|null, verifyToken?: string }} input
 */
export function verifyWebhookChallenge(input) {
  const expected = String(input.verifyToken ?? '').trim();
  const received = String(input.token ?? '');
  if (!expected || input.mode !== 'subscribe') return { ok: false, status: 403 };
  if (!safeEqual(received, expected)) return { ok: false, status: 403 };
  return { ok: true, challenge: String(input.challenge ?? '') };
}

/**
 * Firma del webhook (`X-Hub-Signature-256`).
 *
 * Meta firma el CUERPO CRUDO con el App Secret. Se compara en tiempo constante.
 * Sin App Secret configurado, la firma no se puede validar: se devuelve
 * `{ ok:false, reason:'not_configured' }` para que quien llame decida (en local,
 * sin secretos, se acepta el webhook; en producción es obligatorio).
 *
 * @param {{ rawBody: string|Buffer, signature?: string|null, appSecret?: string }} input
 */
export function verifyWebhookSignature(input) {
  const secret = String(input.appSecret ?? '').trim();
  if (!secret) return { ok: false, reason: 'not_configured' };
  const header = String(input.signature ?? '');
  if (!header.startsWith('sha256=')) return { ok: false, reason: 'missing_signature' };
  const expected = createHmac('sha256', secret).update(input.rawBody).digest('hex');
  return { ok: safeEqual(header.slice('sha256='.length), expected), reason: 'invalid_signature' };
}

/** Comparación en tiempo constante de dos cadenas. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Normaliza un evento del webhook a algo plano y seguro.
 *
 * Devuelve mensajes y estados ya limpios. Los eventos desconocidos se cuentan
 * pero se ignoran de forma segura (nunca lanzan).
 *
 * @param {any} body
 */
export function parseWebhook(body) {
  /** @type {any[]} */
  const messages = [];
  /** @type {any[]} */
  const statuses = [];
  let unknown = 0;

  if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) return { messages, statuses, unknown: 0 };

  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const contacts = new Map(
        (value.contacts ?? []).map((contact) => [String(contact.wa_id ?? ''), String(contact.profile?.name ?? '')]),
      );
      for (const message of value.messages ?? []) {
        messages.push(normalizeInboundMessage(message, contacts));
      }
      for (const status of value.statuses ?? []) {
        statuses.push({
          waMessageId: String(status.id ?? ''),
          status: String(status.status ?? ''), // sent | delivered | read | failed
          recipient: status.recipient_id ? String(status.recipient_id) : null,
          timestamp: status.timestamp ? Number(status.timestamp) : null,
          errorCode: status.errors?.[0]?.code ?? null,
          // Nunca se guarda el payload completo: solo el mensaje, ya recortado.
          errorMessage: status.errors?.[0]?.title ? String(status.errors[0].title).slice(0, 200) : null,
        });
      }
      const known = (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);
      if (known === 0) unknown += 1;
    }
  }
  return { messages, statuses, unknown };
}

/**
 * Metadata del archivo de un mensaje entrante. El binario NO viaja aquí: solo el
 * identificador de Meta y lo necesario para descargarlo y validarlo. La URL de
 * Graph caduca en minutos, así que tampoco se guarda.
 *
 * @param {any} message
 * @returns {{ kind: string, waMediaId: string|null, mimeType: string|null, caption: string|null,
 *            filename: string|null, durationMs: number|null, sha256: string|null }|null}
 */
export function mediaOf(message) {
  const type = String(message?.type ?? '');
  const node =
    type === 'image'
      ? message?.image
      : type === 'audio'
        ? message?.audio
        : type === 'voice'
          ? message?.voice
          : type === 'document'
            ? message?.document
            : type === 'video'
              ? message?.video
              : type === 'sticker'
                ? message?.sticker
                : null;
  if (!node || typeof node !== 'object') return null;
  const seconds = Number(node.duration ?? 0);
  return {
    // `voice` es una nota de voz: mismo audio, distinta cosa para el negocio.
    kind: type === 'voice' || node.voice === true ? 'voice' : type,
    waMediaId: node.id ? String(node.id) : null,
    mimeType: node.mime_type ? String(node.mime_type) : null,
    caption: node.caption ? String(node.caption) : null,
    filename: node.filename ? String(node.filename) : null,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    sha256: node.sha256 ? String(node.sha256) : null,
  };
}

/**
 * Mensaje entrante → objeto plano del CRM.
 * @param {any} message
 * @param {Map<string,string>} contacts
 */
export function normalizeInboundMessage(message, contacts = new Map()) {
  const from = String(message?.from ?? '');
  const type = String(message?.type ?? 'unknown');
  /** @type {string|null} */
  let body = null;
  /** @type {string|null} */
  let buttonId = null;

  if (type === 'text') body = String(message?.text?.body ?? '');
  else if (type === 'button') {
    body = String(message?.button?.text ?? '');
    buttonId = String(message?.button?.payload ?? '');
  } else if (type === 'interactive') {
    body = String(message?.interactive?.button_reply?.title ?? message?.interactive?.list_reply?.title ?? '');
    buttonId = String(message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id ?? '');
  } else if (type === 'image') body = message?.image?.caption ? String(message.image.caption) : '[imagen]';
  else if (type === 'audio') body = '[audio]';
  else if (type === 'voice') body = '[nota de voz]';
  else if (type === 'video') body = message?.video?.caption ? String(message.video.caption) : '[video]';
  else if (type === 'document') body = message?.document?.filename ? String(message.document.filename) : '[documento]';
  else if (type === 'location') body = message?.location?.address ? String(message.location.address) : '[ubicación]';
  else if (type === 'sticker') body = '[sticker]';
  else body = `[${type}]`;

  /*
   * UBICACIÓN (`type: 'location'`): se valida en la puerta. NO es multimedia y no
   * se descarga nada. Si las coordenadas vinieran mal, `location` queda `null` y
   * se guarda el motivo: nunca se sustituye por un (0,0) que está en el mar.
   */
  const inboundLocation = locationFromInbound(message);

  return {
    waMessageId: String(message?.id ?? ''),
    from,
    fromE164: toE164(from),
    profileName: contacts.get(from) || null,
    type,
    body: body?.slice(0, 4000) ?? null,
    buttonId: buttonId || null,
    // Archivo (imagen/audio/…): identificador y datos, sin binario ni URL.
    media: mediaOf(message),
    /*
     * UBICACIÓN (type `location`): se valida en la puerta. NO es multimedia y no
     * se descarga nada. Si las coordenadas vinieran mal, `location` queda `null`
     * y se guarda el motivo, en vez de mentir con un (0,0) que está en el mar.
     */
    location: inboundLocation?.ok ? inboundLocation.location : null,
    locationError: inboundLocation && !inboundLocation.ok ? inboundLocation.code : null,
    replyToWaId: message?.context?.id ? String(message.context.id) : null,
    referral: message?.referral && typeof message.referral === 'object' ? message.referral : null,
    timestamp: message?.timestamp ? Number(message.timestamp) : null,
    receivedAt: message?.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
  };
}
