/**
 * Prueba decisiva: ¿el HEAD devuelve el tamaño de SU objeto o el de la respuesta
 * anterior que quedó sin leer en la conexión?
 *
 * Tras el PUT se hacen DOS HEAD (y un GET) seguidos sobre la misma key. Si el
 * primero dice 0 y el segundo dice el tamaño real, es un desfase de respuesta
 * reutilizando la conexión (la respuesta del PUT, que no tiene cuerpo, se leyó
 * como si fuera la del HEAD).
 *
 * Uso: node --env-file=.env .tmp/s3-uat/r2-head-desync.mjs
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
  console.log('R2 HEAD DESYNC = BLOCKED (faltan variables)');
  process.exit(3);
}

const storage = createStorageService(cfg);
const key = `uat/phytoemagry-storage-test/${new Date().toISOString().slice(0, 10)}/desync-${randomUUID()}.txt`;
const cuerpo = Buffer.from(`desfase ${randomUUID()}\n`, 'utf8');

const subida = await storage.put(key, cuerpo, 'text/plain');
console.log(`PUT ok=${subida.ok} · enviado=${cuerpo.length}`);

const a = await storage.getMetadata(key);
const b = await storage.getMetadata(key);
const c = await storage.getMetadata(key);
console.log(`HEAD #1: ok=${a.ok} size=${Number(a.size)}`);
console.log(`HEAD #2: ok=${b.ok} size=${Number(b.size)}`);
console.log(`HEAD #3: ok=${c.ok} size=${Number(c.size)}`);

const lectura = await storage.get(key);
console.log(`GET: ok=${lectura.ok} bytes=${lectura.buffer?.length ?? 0}`);

const d = await storage.getMetadata(key);
console.log(`HEAD tras GET: ok=${d.ok} size=${Number(d.size)}`);

const borrado = await storage.remove(key);
console.log(`DELETE ok=${borrado.ok}`);
const despues = await storage.exists(key);
console.log(`ABSENT (404 esperado): status=${despues.status} ok=${despues.ok}`);
console.log(`CLEANUP: ${borrado.ok ? 'PASS' : 'FAIL'}`);
if (!borrado.ok) console.log(`CLEANUP aviso: quedó sin borrar ${key}`);
