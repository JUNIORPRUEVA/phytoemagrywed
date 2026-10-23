/**
 * CONFIANZA DE CABECERAS DE PROXY — una sola fuente de verdad.
 *
 * La app NUNCA está en primera línea: delante van nginx (mismo contenedor) y
 * Traefik (EasyPanel). De ahí dos fallos reales que este módulo corrige:
 *
 *  1. `req.socket.remoteAddress` es SIEMPRE el proxy (127.0.0.1), nunca el
 *     cliente. Usarlo como clave del límite de intentos convertía «20 por IP»
 *     en «20 para TODO el sitio»: al vigésimo intento bloqueábamos a todos.
 *  2. `x-forwarded-proto` lo escribe nginx. Si lo pisa con `$scheme` y el TLS lo
 *     termina Traefik, el valor que llega es `http` ⇒ la sesión y el `state` de
 *     OAuth salían SIN `Secure` justo en producción.
 *
 * REGLA DE ORO: las cabeceras `X-Forwarded-*` SOLO se creen cuando la conexión
 * viene de un proxy de confianza (por defecto el loopback, que es lo que hay en
 * el contenedor). Si alguien llega directo al puerto del Node, o el proxy no es
 * de los nuestros, su `X-Forwarded-For: 1.2.3.4` se IGNORA y se usa su IP real:
 * así una cabecera inventada por el cliente no puede saltarse ni suplantar el
 * límite de intentos.
 *
 * No hay dependencias: solo comparación de direcciones ya normalizadas.
 */

/** Proxies de confianza por defecto: nginx del contenedor (loopback). */
export const DEFAULT_TRUSTED_PROXIES = Object.freeze(['127.0.0.1', '::1']);

/**
 * Normaliza una dirección para poder compararla: quita corchetes de IPv6,
 * el puerto si lo trae y el prefijo `::ffff:` de las IPv4 mapeadas.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeIp(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  /* `[::1]:443` / `[::1]` → `::1` */
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.replace(/:\d+$/, '');
  if (text.startsWith('::ffff:')) text = text.slice('::ffff:'.length);
  return text;
}

const chainOf = (value) =>
  String(value ?? '')
    .split(',')
    .map((part) => normalizeIp(part))
    .filter(Boolean);

/**
 * Construye el verificador de proxy de este proceso.
 *
 * @param {{trustedProxies?: string|string[], forceSecure?: boolean|string}} [options]
 *   `trustedProxies`: lista (texto separado por comas o array) de IPs de proxy
 *   que SÍ pueden escribir `X-Forwarded-*`.
 *   `forceSecure`: marca las cookies `Secure` aunque no llegue ninguna cabecera
 *   (útil si el despliegue termina TLS en otro sitio y no reenvía el esquema).
 */
export function createRequestTrust({ trustedProxies, forceSecure = false } = {}) {
  const list = Array.isArray(trustedProxies)
    ? trustedProxies
    : String(trustedProxies ?? '').split(',');
  const normalized = list.map((ip) => normalizeIp(ip)).filter(Boolean);
  const trusted = new Set(normalized.length ? normalized : DEFAULT_TRUSTED_PROXIES);
  const forced = forceSecure === true || String(forceSecure).trim().toLowerCase() === 'true' || String(forceSecure).trim() === '1';

  /** ¿La conexión viene de uno de nuestros proxies? */
  const isTrustedPeer = (req) => trusted.has(normalizeIp(req?.socket?.remoteAddress));

  /**
   * IP real del cliente.
   *
   * Con nginx delante, `X-Forwarded-For` es `<lo que mandó el cliente>, <IP que
   * vio nginx>`. Se recorre de DERECHA a IZQUIERDA y se devuelve el primer salto
   * que NO es un proxy de confianza: lo que el cliente escriba a la izquierda no
   * puede suplantar a nadie.
   *
   * @param {any} req
   * @returns {string} IP del cliente o `'unknown'`
   */
  function clientIp(req) {
    const peer = normalizeIp(req?.socket?.remoteAddress);
    if (!trusted.has(peer)) return peer || 'unknown';
    const chain = chainOf(req?.headers?.['x-forwarded-for']);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (!trusted.has(chain[index])) return chain[index];
    }
    /* Toda la cadena es de proxies nuestros (o viene vacía): el salto más
       cercano es la mejor referencia que tenemos. */
    return chain.at(-1) ?? peer ?? 'unknown';
  }

  /**
   * ¿La petición llegó por HTTPS?
   *
   * `x-forwarded-proto` solo cuenta si viene de un proxy de confianza; se usa el
   * ÚLTIMO valor (el salto más cercano a nosotros), no el primero.
   */
  function isSecure(req) {
    if (forced) return true;
    if (req?.socket?.encrypted === true) return true;
    if (!isTrustedPeer(req)) return false;
    const raw = req?.headers?.['x-forwarded-proto'];
    if (raw === undefined) return false;
    const proto = String(raw).split(',').at(-1)?.trim().toLowerCase();
    return proto === 'https';
  }

  return {
    trusted,
    isTrustedPeer,
    clientIp,
    isSecure,
    /** Atributos que solo tienen sentido sobre HTTPS. */
    secureAttributes: (req) => (isSecure(req) ? ['Secure'] : []),
  };
}

/** Verificador por defecto del proceso, configurado por entorno. */
export const requestTrust = createRequestTrust({
  trustedProxies: process.env.PHYTO_TRUSTED_PROXIES,
  forceSecure: process.env.PHYTO_FORCE_SECURE_COOKIES,
});

/*
 * Confianza POR PETICIÓN.
 *
 * Los manejadores de ruta ya resuelven `ctx.requestTrust` (lo inyecta
 * `crm-server` y las pruebas), pero las utilidades internas —`throttle`,
 * `storeCookie`— reciben solo `req`. Un `WeakMap` guarda la confianza de esa
 * petición sin cambiar 20 firmas ni usar estado global compartido (la clave es
 * el propio `req`, así que no se mezclan peticiones concurrentes y no se
 * retiene memoria).
 */
const BY_REQUEST = new WeakMap();

/** Ata la confianza resuelta a esta petición. */
export function bindRequestTrust(req, trust) {
  if (req && typeof req === 'object') BY_REQUEST.set(req, trust ?? requestTrust);
  return trust ?? requestTrust;
}

/** Confianza de esta petición (o la del proceso). */
export function trustOf(req) {
  return BY_REQUEST.get(req) ?? requestTrust;
}
