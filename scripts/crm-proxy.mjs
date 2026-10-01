/**
 * Puente entre el servidor de desarrollo y el mini-CRM.
 *
 * POR QUÉ EXISTE
 * El servidor de desarrollo sirve `dist-dev/`, y ahí dentro se copia también el
 * panel (`public/admin` → `dist-dev/admin`). El panel hace `fetch('/api/...')`
 * contra el MISMO origen, así que en local abría la pantalla de entrada pero el
 * POST de `/api/admin/login` acababa en el servidor de ficheros → 404 en HTML →
 * el panel decía "No se pudo entrar." sin explicar nada. Con este proxy, todo lo
 * que empieza por `/api/` se reenvía al CRM (por defecto 127.0.0.1:8787), así que
 * `http://localhost:5173/admin/` funciona igual que el panel de producción.
 *
 * En producción NO se usa: ahí nginx hace de proxy (`location ^~ /api/`).
 */

import { request as httpRequest } from 'node:http';

/** Puerto del CRM si no se dice otra cosa (`PHYTO_CRM_PORT`). */
export const DEFAULT_CRM_PORT = 8787;

/** Interfaz del CRM: solo local, nunca expuesta a la red. */
export const DEFAULT_CRM_HOST = '127.0.0.1';

/**
 * Lee el puerto del CRM del entorno, con el mismo nombre que usa
 * `server/crm-server.mjs` (una sola variable para las dos piezas).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function crmPortFromEnv(env = process.env) {
  const parsed = Number.parseInt(env.PHYTO_CRM_PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CRM_PORT;
}

/**
 * ¿Es una ruta que pertenece al API?
 *
 * Solo `/api` y `/api/...`: el resto (HTML, assets, `/admin/`) lo sirve el
 * propio servidor de desarrollo desde `dist-dev/`.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isCrmPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Copia los encabezados de la respuesta del CRM a la nuestra.
 *
 * `set-cookie` llega como array (login y logout pueden mandar más de una) y
 * `setHeader` lo acepta tal cual; pasarlo por `writeHead` con un objeto lo
 * rompería, y sin esa cabecera el panel nunca guardaría la sesión.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function copyHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) res.setHeader(key, value);
  }
}

/**
 * Respuesta de error cuando el CRM no contesta (mensaje en JSON para que el
 * panel pueda mostrarlo en pantalla en vez de un "error" genérico).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} port
 * @param {string} [detail]
 */
function unavailable(res, port, detail = '') {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    JSON.stringify({
      ok: false,
      message: `El CRM no está respondiendo en el puerto ${port}${detail ? ` (${detail})` : ''}. Arráncalo con «npm run crm» y vuelve a intentarlo.`,
    }),
  );
}

/**
 * Reenvía una petición al CRM.
 *
 * Devuelve una promesa que se resuelve cuando la respuesta terminó, para que
 * quien llama pueda esperarla (y para que los tests sean deterministas).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<void>}
 */
export function proxyToCrm(req, res, url, options = {}) {
  const port = options.port ?? DEFAULT_CRM_PORT;
  const host = options.host ?? DEFAULT_CRM_HOST;

  return new Promise((resolve) => {
    const upstream = httpRequest(
      {
        host,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        // El `host` del navegador (localhost:5173) se sustituye por el del CRM:
        // si no, el servidor vería un Host que no es el suyo.
        headers: {
          ...req.headers,
          host: `${host}:${port}`,
          'x-forwarded-host': req.headers.host ?? '',
          'x-forwarded-proto': 'http',
        },
      },
      (response) => {
        copyHeaders(res, response.headers);
        res.writeHead(response.statusCode ?? 502);
        response.pipe(res);
        response.on('end', resolve);
        response.on('error', resolve);
      },
    );

    upstream.on('error', (error) => {
      unavailable(res, port, error.code === 'ECONNREFUSED' ? 'no está encendido' : error.code);
      resolve();
    });

    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
}

/**
 * Pregunta al CRM si está vivo.
 *
 * Se usa para no arrancar un segundo CRM si ya hay uno escuchando (por ejemplo
 * `npm run crm` en otra terminal) y para comprobar que un CRM recién lanzado ya
 * responde antes de seguir.
 *
 * @param {{ port?: number, host?: string, timeout?: number }} [options]
 * @returns {Promise<null | { ok: boolean, storage?: string, items?: number }>}
 */
export async function probeCrm(options = {}) {
  const port = options.port ?? DEFAULT_CRM_PORT;
  const host = options.host ?? DEFAULT_CRM_HOST;
  const timeout = options.timeout ?? 700;

  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Espera a que el CRM responda (arranque en frío: abre SQLite/Postgres).
 *
 * @param {{ port?: number, host?: string, attempts?: number, delay?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForCrm(options = {}) {
  const attempts = options.attempts ?? 40;
  const delay = options.delay ?? 200;
  for (let tries = 0; tries < attempts; tries += 1) {
    if (await probeCrm({ ...options, timeout: 800 })) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}
