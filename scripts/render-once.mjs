/**
 * Renderiza el HTML una sola vez en un PROCESO NUEVO.
 *
 * ¿Por qué un proceso aparte? Node cachea los módulos ESM importados, así que
 * el servidor de desarrollo (que vive en un proceso de larga duración) seguiría
 * usando versiones antiguas de `src/render/**` y `src/config/**`. Lanzar el
 * render en un proceso hijo garantiza que cada regeneración lea el código real
 * que acabas de guardar.
 *
 * Uso: node scripts/render-once.mjs [carpeta-destino]
 */

import path from 'node:path';
import { buildPages, loadEnv, ROOT } from './build.mjs';

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist-dev');

try {
  // En desarrollo se aplican los overrides locales (.env.local).
  await loadEnv({ includeLocal: true });
  await buildPages({ css: '/assets/main.css', js: '/assets/main.js' }, outDir);
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}
