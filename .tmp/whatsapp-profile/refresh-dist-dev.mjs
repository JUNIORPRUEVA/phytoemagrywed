/*
 * Regenera `dist-dev/` (lo que sirve `npm run dev`) SIN arrancar el servidor.
 *
 * Hace lo mismo que el arranque de `scripts/dev.mjs`:
 *   1. carga `.env` + `.env.local` (overrides de desarrollo),
 *   2. compila el cliente y los estilos con esbuild,
 *   3. copia `public/`,
 *   4. renderiza el HTML en un proceso nuevo.
 *
 * Uso: node .tmp/whatsapp-profile/refresh-dist-dev.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import * as esbuild from 'esbuild';

import { copyPublic, envObject, loadEnv, ROOT } from '../../scripts/build.mjs';

const DIST_DEV = path.join(ROOT, 'dist-dev');

await loadEnv({ includeLocal: true });

const common = {
  bundle: true,
  minify: false,
  sourcemap: 'linked',
  target: ['es2020'],
  define: { __PHYTO_ENV__: JSON.stringify(envObject()) },
  outdir: path.join(DIST_DEV, 'assets'),
  entryNames: '[name]',
  logLevel: 'warning',
};

await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'client', 'main.js')], format: 'esm' });
await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'styles', 'main.css')] });
await copyPublic(DIST_DEV);
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'render-once.mjs'), DIST_DEV], { stdio: 'inherit' });

console.log('dist-dev regenerado (cliente + estilos + public/ + HTML)');
