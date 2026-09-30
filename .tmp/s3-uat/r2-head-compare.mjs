/**
 * Sonda fina: ¿la misma petición HEAD da resultados distintos según cómo se
 * construya? Compara, con la MISMA key:
 *
 *   1) HEAD firmado a mano (signRequest + fetch)
 *   2) HEAD a través de createS3Client().head()
 *
 * Imprime solo: estado, NOMBRES de cabeceras, content-length y si las dos URLs
 * son exactamente iguales (booleano). Nada de endpoint, bucket ni credenciales.
 *
 * Uso: node --env-file=.env .tmp/s3-uat/r2-head-compare.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { createS3Client, signRequest } from '../../server/s3.mjs';
import { createStorageService } from '../../server/storage.mjs';

const endpoint = String(process.env.R2_ENDPOINT ?? '').trim();
const bucket = String(process.env.R2_BUCKET_NAME ?? '').trim();
const accessKeyId = String(process.env.R2_ACCESS_KEY_ID ?? '').trim();
const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY ?? '').trim();
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.log('R2 HEAD COMPARE = BLOCKED (faltan variables)');
  process.exit(3);
}

const config = { endpoint, bucket, accessKeyId, secretAccessKey };
const client = createS3Client(config);
const storage = createStorageService({ ...config, client });

const key = `uat/phytoemagry-storage-test/${new Date().toISOString().slice(0, 10)}/compare-${randomUUID()}.txt`;
const cuerpo = Buffer.from(`contenido de prueba ${randomUUID()}\n`, 'utf8'); // 57 bytes

const subida = await client.put(key, cuerpo, 'text/plain');
console.log(`PUT ok=${subida.ok} · enviado=${cuerpo.length}`);

// 1) HEAD a mano.
const base = endpoint.replace(/\/+$/, '');
const url = `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
const firmado = signRequest({
  method: 'HEAD',
  path: new URL(url).pathname,
  headers: { host: new URL(url).host },
  payloadHash: createHash('sha256').update('').digest('hex'),
  accessKeyId,
  secretAccessKey,
  region: 'auto',
});
const manual = await fetch(url, { method: 'HEAD', headers: firmado });
console.log('HEAD manual → status', manual.status);
console.log('HEAD manual → cabeceras:', [...manual.headers.keys()].sort().join(', '));
console.log('HEAD manual → content-length:', manual.headers.get('content-length') ?? '(ausente)');

// 2) HEAD por el cliente.
const porCliente = await client.head(key);
console.log(`HEAD cliente → ok=${porCliente.ok} status=${porCliente.status} size=${Number(porCliente.size)} tipo=${porCliente.contentType ?? '(nulo)'}`);

// 3) ¿Misma URL? (booleano, sin imprimirla)
const urlCliente = (() => {
  const piezas = key.split('/').map(encodeURIComponent).join('/');
  return `${base}/${bucket}/${piezas}`;
})();
console.log('¿misma URL en las dos?', urlCliente === url ? 'sí' : 'no');

const borrado = await client.remove(key);
console.log(`DELETE ok=${borrado.ok} · CLEANUP ${borrado.ok ? 'PASS' : 'FAIL'}`);
if (!borrado.ok) console.log(`CLEANUP aviso: quedó sin borrar ${key}`);
void storage;
