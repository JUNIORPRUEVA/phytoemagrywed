/**
 * Servidor de desarrollo.
 *
 *  - Compila JS y CSS en modo watch (sin hash, sin minificar).
 *  - Re-renderiza el HTML cuando cambian config/render/lib.
 *  - Sirve `dist/` con recarga automática del navegador (polling de revisión).
 *
 *  - Reenvía `/api/...` al mini-CRM y lo arranca si no está encendido, para que
 *    el panel (`/admin/`) funcione en local sin abrir dos terminales.
 *
 * Sin dependencias externas: solo Node + esbuild.
 *
 *   npm run dev            → http://localhost:5173  · panel: /admin/
 *   npm run dev -- --port 4000
 */

import { createServer } from 'node:http';
import { existsSync, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
import { copyPublic, DIST, DIST_DEV, envObject, loadEnv, ROOT } from './build.mjs';
import { crmPortFromEnv, isCrmPath, probeCrm, proxyToCrm, waitForCrm } from './crm-proxy.mjs';

/**
 * Clave del panel en desarrollo.
 *
 * El CRM de verdad se niega a abrir el panel sin `PHYTO_CRM_TOKEN` (obligatoria
 * en el servidor). En local sería incómodo tener que inventarse una clave para
 * ver el panel, así que el dev server la pone por ti y la imprime. Solo se usa
 * aquí: el contenedor de producción ejecuta `server/crm-server.mjs` a secas.
 */
const DEV_CRM_TOKEN = 'phyto-local';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const RELOAD_SNIPPET = `<script>
(function(){var rev=null;setInterval(function(){fetch('/__rev',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(rev===null){rev=d.rev}else if(d.rev!==rev){location.reload()}}).catch(function(){})},900)})();
</script>`;

/**
 * Regenera el HTML en un PROCESO NUEVO.
 *
 * Node cachea los módulos ESM ya importados, así que reutilizar el proceso del
 * servidor haría que los cambios en `src/render/**` o `src/config/**` no se
 * aplicaran nunca. El proceso hijo siempre lee el código recién guardado.
 *
 * @param {string} outDir
 * @returns {Promise<void>}
 */
function renderInChildProcess(outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'render-once.mjs'), outDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `el render terminó con código ${code}`));
    });
  });
}

/**
 * Deja un CRM escuchando en `port`.
 *
 * Si ya hay uno (por ejemplo `npm run crm` en otra terminal) no toca nada.
 * Si no, lo arranca como proceso hijo e imprime la clave para entrar al panel,
 * porque el CRM real se niega a abrir el panel sin `PHYTO_CRM_TOKEN`.
 *
 * @param {number} port
 * @returns {Promise<import('node:child_process').ChildProcess | null>}
 */
async function ensureCrm(port) {
  if (await probeCrm({ port })) {
    console.log(`🧩 CRM ya encendido en http://127.0.0.1:${port} (se reutiliza)`);
    return null;
  }
  if (process.env.PHYTO_CRM_NO_AUTO === '1') {
    console.log('🧩 CRM no arrancado (PHYTO_CRM_NO_AUTO=1): el panel dará aviso de que no responde');
    return null;
  }

  const usingOwnKey = !process.env.PHYTO_CRM_TOKEN;
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join('server', 'crm-server.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PHYTO_CRM_PORT: String(port),
      PHYTO_CRM_TOKEN: process.env.PHYTO_CRM_TOKEN || DEV_CRM_TOKEN,
    },
  });
  child.on('exit', (code, signal) => {
    // Si lo matamos nosotros (o lo cierras tú), `signal` viene informado y no
    // hay nada que avisar: solo interesa un cierre anómalo por sí mismo.
    if (!signal && code) console.error(`🧩 el CRM se cerró con código ${code}`);
  });

  if (!(await waitForCrm({ port }))) {
    console.error(`🧩 el CRM no respondió en el puerto ${port}: el panel lo avisará al entrar`);
    return child;
  }

  const health = await probeCrm({ port });
  console.log(
    `🧩 CRM encendido en http://127.0.0.1:${port} · almacén ${health?.storage ?? '?'}` +
      (typeof health?.items === 'number' ? ` · ${health.items} registro(s)` : ''),
  );
  console.log(`   panel local: http://localhost:${port}/admin/`);
  if (usingOwnKey) console.log(`   clave local: ${DEV_CRM_TOKEN}   (cámbiala con PHYTO_CRM_TOKEN en .env.local)`);
  return child;
}

async function main() {
  // En desarrollo SÍ se aplican los overrides locales (.env.local).
  await loadEnv({ includeLocal: true });
  /**
   * Sin endpoint, la landing no manda los pedidos a ningún sitio: el panel
   * saldría siempre vacío y parecería roto. En local el CRM lo levanta este
   * mismo servidor y `/api/` se reenvía a él, así que el valor correcto es
   * `/api/crm` (el mismo que trae la imagen Docker). Si ya hay uno definido en
   * `.env`/`.env.local`, se respeta.
   */
  const crmEndpointFromEnv = Boolean((process.env.PHYTO_CRM_ENDPOINT ?? '').trim());
  if (!crmEndpointFromEnv) process.env.PHYTO_CRM_ENDPOINT = '/api/crm';
  const preview = process.argv.includes('--dist');
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : preview ? 4173 : 5173;
  /** Puerto del CRM (`PHYTO_CRM_PORT`, 8787 por defecto): el mismo en el proxy y en el hijo. */
  const crmPort = crmPortFromEnv();
  /** @type {import('node:child_process').ChildProcess | null} */
  let crmChild = null;

  let rev = 0;
  const assets = { css: '/assets/main.css', js: '/assets/main.js' };
  /** El modo dev sirve `dist-dev/`; el preview sirve el `dist/` publicable. */
  const serveDir = preview ? DIST : DIST_DEV;
  /** @type {import('esbuild').BuildContext[]} */
  const contexts = [];

  if (preview) {
    console.log('\n👁  Modo preview: sirviendo `dist/` tal cual (sin recompilar).');
  } else {
    const rerender = async () => {
      await renderInChildProcess(DIST_DEV);
      rev += 1;
      console.log(`   ↻ HTML regenerado (rev ${rev})`);
    };

    /** Recompila y avisa al navegador de cada cambio. */
    const reloadPlugin = {
      name: 'reload-on-end',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error('   ✖ error de compilación');
            return;
          }
          rev += 1;
        });
      },
    };

    const common = {
      bundle: true,
      minify: false,
      sourcemap: 'linked',
      target: ['es2020'],
      define: { __PHYTO_ENV__: JSON.stringify(envObject()) },
      outdir: path.join(DIST_DEV, 'assets'),
      entryNames: '[name]',
      logLevel: 'info',
      plugins: [reloadPlugin],
    };

    contexts.push(
      await esbuild.context({ ...common, entryPoints: [path.join(ROOT, 'src', 'client', 'main.js')], format: 'esm' }),
      await esbuild.context({ ...common, entryPoints: [path.join(ROOT, 'src', 'styles', 'main.css')] }),
    );

    await Promise.all(contexts.map((context) => context.watch()));
    await copyPublic(DIST_DEV);
    await rerender();

    // Re-render del HTML cuando cambia cualquier archivo que no sea cliente/estilos.
    let debounce = null;
    watch(path.join(ROOT, 'src'), { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.startsWith('client') || filename.startsWith('styles')) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        rerender().catch((error) => console.error('   ✖ no se pudo regenerar el HTML:', error.message));
      }, 80);
    });

    // `public/` (imágenes) se copia UNA vez al arrancar: si se generan fotos
    // nuevas (npm run images:hero / images:frascos) el servidor no las vería y
    // daría 404. Se vigila la carpeta para copiarlas al vuelo.
    let copyDebounce = null;
    watch(path.join(ROOT, 'public'), { recursive: true }, () => {
      clearTimeout(copyDebounce);
      copyDebounce = setTimeout(() => {
        copyPublic(DIST_DEV).catch((error) => console.error('   ✖ no se pudo copiar public/:', error.message));
      }, 120);
    });
  }

  // El CRM antes que el servidor: así el panel ya está listo cuando abras /admin/.
  crmChild = await ensureCrm(crmPort);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/__rev') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ rev }));
      return;
    }

    // El API y el panel viven en el CRM: se reenvía ANTES de buscar ficheros.
    if (isCrmPath(url.pathname)) {
      await proxyToCrm(request, response, url, { port: crmPort });
      return;
    }

    // Mismo atajo que en producción (`location = /panel`), para que un enlace
    // antiguo `?token=...` no se convierta en un 404 raro en local.
    if (url.pathname === '/panel') {
      response.writeHead(302, { location: `/admin/${url.search}` });
      response.end();
      return;
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let filePath = path.join(serveDir, relative || 'index.html');
    if (!filePath.startsWith(serveDir)) {
      response.writeHead(403).end('Prohibido');
      return;
    }

    try {
      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) filePath = path.join(filePath, 'index.html');

      const body = await readFile(filePath);

      // Recarga automática solo en HTML (no en preview del build de producción).
      if (filePath.endsWith('.html') && !preview) {
        const html = body.toString('utf8').replace('</body>', `${RELOAD_SNIPPET}</body>`);
        response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        response.end(html);
        return;
      }

      response.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      const missing = `${relative}`;
      response.writeHead(404, { 'content-type': MIME['.html'] });
      response.end(
        `<!DOCTYPE html><html lang="es"><meta charset="utf-8"><title>404</title><body style="font:16px system-ui;padding:2rem">
         <h1>404 — /${missing.replace(/</g, '')}</h1>
         <p>Archivo no encontrado en <code>${path.basename(serveDir)}/</code>.</p>
         <p><a href="/">Volver al inicio</a></p></body></html>`,
      );
    }
  });

  server.listen(port, () => {
    console.log(`\n🚀 ${preview ? 'Preview del build' : 'Dev server'}: http://localhost:${port}`);
    if (!preview) console.log(`   (sirviendo ${path.basename(serveDir)}/ — el dist/ publicable no se toca)`);
    if (!existsSync(path.join(ROOT, '.env'))) {
      console.log('   (sin .env: WhatsApp/SEO/CRM se muestran desactivados)');
    }
    console.log(`📱 panel del CRM (app instalable): http://localhost:${port}/admin/`);
    if (!crmEndpointFromEnv) {
      console.log('   (PHYTO_CRM_ENDPOINT estaba vacío: en local los pedidos se guardan en /api/crm → CRM local)');
    }
    console.log('   Ctrl+C para parar\n');
  });

  const shutdown = async () => {
    if (crmChild) crmChild.kill();
    await Promise.all(contexts.map((context) => context.dispose()));
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('❌ Error en el dev server:', error);
  process.exit(1);
});
