/**
 * ESTADO REAL DE WHATSAPP — UNA SOLA FUENTE DE VERDAD.
 *
 * POR QUÉ EXISTE
 * El panel avisaba «WhatsApp no está configurado» basándose en un único booleano
 * (`enabled`) que solo dice que hay credenciales escritas. Con eso no se puede
 * distinguir entre:
 *
 *   - falta configuración,
 *   - el token fue rechazado por Meta,
 *   - Meta no responde (red/timeout),
 *   - se puede enviar pero el webhook de recepción no está configurado,
 *   - todo funciona,
 *   - entorno de pruebas (mock).
 *
 * Un timeout NO es «no configurado», y las conversaciones históricas NO prueban
 * que el servicio funcione ahora. Aquí se comprueba de verdad contra Meta con
 * una llamada de SOLO LECTURA (`listTemplates`, que ya usa el token del cliente)
 * y el resultado se guarda en caché para no frenar `/api/admin/data`.
 *
 * SEGURIDAD: no lee ni devuelve el token. Los errores llegan ya saneados por el
 * cliente de WhatsApp.
 */

/** Códigos de Meta que significan «la credencial no vale» (no es un fallo de red). */
const TOKEN_ERROR_CODES = new Set([102, 190, 463, 467]);
/** Cada cuánto se vuelve a preguntar a Meta como máximo. */
const DEFAULT_TTL_MS = 60_000;

/**
 * @param {object} options
 * @param {any} options.whatsapp Cliente de WhatsApp ya creado por el servidor.
 * @param {string} [options.verifyToken] Token del webhook (para recepción).
 * @param {string} [options.appSecret] Secreto de la app (firma del webhook).
 * @param {string} [options.graphVersion]
 * @param {() => Date} [options.clock]
 * @param {number} [options.ttlMs]
 */
export function createWhatsAppStatus(options = {}) {
  const whatsapp = options.whatsapp ?? null;
  const verifyToken = String(options.verifyToken ?? '').trim();
  const appSecret = String(options.appSecret ?? '').trim();
  const graphVersion = options.graphVersion ?? whatsapp?.graphVersion ?? null;
  const clock = options.clock ?? (() => new Date());
  const ttlMs = Math.max(5_000, Number(options.ttlMs ?? DEFAULT_TTL_MS) || DEFAULT_TTL_MS);

  /** @type {{send: string, reason: string|null, detail: any, checkedAt: string, checked: string, source: string}|null} */
  let last = null;
  /** @type {Promise<any>|null} */
  let running = null;

  /**
   * RECEPCIÓN: es un hecho de CONFIGURACIÓN (webhook + firma), no de red.
   * Sin `verifyToken`/`appSecret` el servidor no puede atender el webhook.
   */
  function receive() {
    if (!whatsapp?.enabled) return { state: 'not_configured', reason: 'missing_credentials' };
    if (!verifyToken || !appSecret) return { state: 'not_configured', reason: 'missing_webhook_config' };
    return { state: 'ok', reason: null };
  }

  function classify(result) {
    if (result?.ok) return { send: 'ok', reason: null, detail: { templates: (result.templates ?? []).length } };
    if (result?.skipped && result.reason === 'mock_mode') return { send: 'mock', reason: 'mock_mode', detail: { mock: true } };
    if (result?.skipped) return { send: 'not_configured', reason: result.reason ?? 'missing_credentials', detail: { mock: false } };
    const status = Number(result?.status ?? result?.error?.status ?? 0) || null;
    const code = Number(result?.error?.code ?? 0) || null;
    if (status === 401 || TOKEN_ERROR_CODES.has(code)) {
      return { send: 'token_invalid', reason: 'token_invalid', detail: { status, code } };
    }
    return {
      send: 'unknown',
      reason: status ? 'meta_error' : 'unreachable',
      detail: { status, code, message: String(result?.error?.message ?? '').slice(0, 160) || null },
    };
  }

  /** Comprobación REAL contra Meta. Nunca lanza. */
  async function probe() {
    const at = clock().toISOString();
    if (!whatsapp?.enabled) {
      last = { send: 'not_configured', reason: 'missing_credentials', detail: { mock: false }, checkedAt: at, checked: 'live', source: 'credentials' };
      return last;
    }
    if (typeof whatsapp.listTemplates !== 'function') {
      last = { send: 'unknown', reason: 'probe_unavailable', detail: {}, checkedAt: at, checked: 'unknown', source: 'probe' };
      return last;
    }
    const result = await whatsapp.listTemplates({ limit: 1 }).catch((error) => ({ ok: false, error: { message: error?.message ?? 'probe_failed' } }));
    const classification = classify(result);
    const now = clock().toISOString();
    last = { ...classification, checkedAt: now, checked: 'live', source: 'meta' };
    return last;
  }

  /**
   * Devuelve el último estado conocido SIN bloquear. Si la comprobación está
   * vieja, se lanza en segundo plano (`refresh`), nunca dentro de la petición.
   */
  function snapshot() {
    const receiveState = receive();
    const stale = !last || clock().getTime() - (Date.parse(last.checkedAt ?? '') || 0) > ttlMs;
    if (stale) void refresh();
    if (!last) {
      return {
        configured: Boolean(whatsapp?.enabled),
        mode: whatsapp?.mock ? 'mock' : whatsapp?.enabled ? 'live' : 'off',
        send: whatsapp?.enabled ? 'unknown' : 'not_configured',
        receive: receiveState.state,
        receiveReason: receiveState.reason,
        checked: 'unknown',
        checkedAt: null,
        reason: whatsapp?.enabled ? 'pending_check' : 'missing_credentials',
        canSend: false,
        graphVersion,
        detail: null,
      };
    }
    const mode = whatsapp?.mock ? 'mock' : whatsapp?.enabled ? 'live' : 'off';
    return {
      configured: Boolean(whatsapp?.enabled),
      mode,
      send: last.send,
      receive: receiveState.state,
      receiveReason: receiveState.reason,
      checked: stale ? 'cached' : 'live',
      checkedAt: last.checkedAt,
      reason: last.reason,
      // En modo local (UAT) el envío «funciona» contra el simulador: no se bloquea.
      canSend: last.send === 'ok' || last.send === 'mock',
      graphVersion,
      detail: last.detail ?? null,
    };
  }

  /** Comprobación en segundo plano, como mucho una a la vez. */
  function refresh() {
    if (running) return running;
    running = probe()
      .catch(() => null)
      .finally(() => {
        running = null;
      });
    return running;
  }

  return { snapshot, refresh, probe, receive };
}
