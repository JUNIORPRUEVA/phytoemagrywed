/**
 * ¿Por qué el HEAD devolvió tamaño 0 justo después del PUT?
 *
 * Repite el patrón exacto del smoke (PUT → getMetadata inmediato) varias veces y
 * una vez con una pausa, para saber si es un comportamiento del proveedor justo
 * después de subir o un fallo nuestro. Solo imprime tamaños: nada sensible.
 *
 * Uso: node --env-file=.env .tmp/s3-uat/r2-head-timing.mjs
 */
import { randomUUID } from 'node:crypto';
import { createStorageService } from '../../server/storage.mjs';

const cfg = {
  endpoint: String(process.env.R2_ENDPOINT ?? '').trim(),
  bucket: String(process.env.R2_BUCKET_NAME ?? '').trim(),
  accessKeyId: String(process.env.R2_ACCESS_KEY_ID ?? '').trim(),
  secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY ?? '').trim(),
};
if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
  console.log('R2 HEAD TIMING = BLOCKED (faltan variables)');
  process.exit(3);
}

const storage = createStorageService(cfg);
const prefijo = `uat/phytoemagry-storage-test/${new Date().toISOString().slice(0, 10)}`;
const claves = [];

async function prueba(etiqueta, pausaMs) {
  const key = `${prefijo}/timing-${randomUUID()}.txt`;
  claves.push(key);
  const cuerpo = Buffer.from(`contenido de prueba ${randomUUID()}\n`, 'utf8');
  const subida = await storage.put(key, cuerpo, 'text/plain');
  if (!subida.ok) {
    console.log(`${etiqueta}: PUT FAIL`);
    return;
  }
  if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs));
  const meta = await storage.getMetadata(key);
  console.log(`${etiqueta}: enviado=${cuerpo.length} · head.ok=${meta.ok} · head.size=${Number(meta.size)}`);
}

await prueba('PUT → HEAD inmediato (1ª)', 0);
await prueba('PUT → HEAD inmediato (2ª)', 0);
await prueba('PUT → HEAD inmediato (3ª)', 0);
await prueba('PUT → pausa 1s → HEAD', 1000);

let limpias = 0;
for (const key of claves) {
  const borrado = await storage.remove(key).catch(() => ({ ok: false }));
  if (borrado.ok) limpias += 1;
  else console.log(`CLEANUP aviso: quedó sin borrar ${key}`);
}
console.log(`CLEANUP: ${limpias === claves.length ? 'PASS' : 'FAIL'} (${limpias}/${claves.length})`);
