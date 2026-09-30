/**
 * Sonda de diagnóstico del HEAD contra R2 (fase pre-push).
 *
 * Averigua por qué `head()` devuelve tamaño 0: ¿R2 no manda `content-length` en
 * un HEAD firmado, o lo estamos leyendo mal?
 *
 * Imprime SOLO: estado, NOMBRES de cabeceras y los valores de `content-length`,
 * `content-type` y si hay `etag`. Nunca credenciales, URL firmada ni bucket.
 *
 * Uso: node --env-file=.env .tmp/s3-uat/r2-head-probe.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { signRequest } from '../../server/s3.mjs';
import { createStorageService } from '../../server/storage.mjs';

const endpoint = String(process.env.R2_ENDPOINT ?? '').trim();
const bucket = String(process.env.R2_BUCKET_NAME ?? '').trim();
const accessKeyId = String(process.env.R2_ACCESS_KEY_ID ?? '').trim();
const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY ?? '').trim();

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.log('R2 HEAD PROBE = BLOCKED (faltan variables)');
  process.exit(3);
}

const storage = createStorageService({ endpoint, bucket, accessKeyId, secretAccessKey });
const key = `uat/phytoemagry-storage-test/${new Date().toISOString().slice(0, 10)}/head-${randomUUID()}.txt`;
const cuerpo = Buffer.from(`probe ${randomUUID()}\n`, 'utf8');
const sha = createHash('sha256').update(cuerpo).digest('hex');

const subida = await storage.put(key, cuerpo, 'text/plain');
console.log(`PUT: ${subida.ok ? 'PASS' : 'FAIL'} · bytes enviados: ${cuerpo.length}`);

if (subida.ok) {
  // HEAD firmado a mano, para ver la respuesta cruda (solo cabeceras seguras).
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const signed = signRequest({
    method: 'HEAD',
    path: new URL(url).pathname,
    headers: { host: new URL(url).host },
    payloadHash: createHash('sha256').update('').digest('hex'),
    accessKeyId,
    secretAccessKey,
    region: 'auto',
  });
  const respuesta = await fetch(url, { method: 'HEAD', headers: signed });
  const nombres = [...respuesta.headers.keys()].sort();
  console.log('HEAD status:', respuesta.status);
  console.log('HEAD cabeceras presentes:', nombres.join(', '));
  console.log('HEAD content-length:', respuesta.headers.get('content-length') ?? '(ausente)');
  console.log('HEAD content-type:', respuesta.headers.get('content-type') ?? '(ausente)');
  console.log('HEAD etag:', respuesta.headers.get('etag') ? 'presente' : 'ausente');

  // ¿Y un GET con Range 0-0, que sí trae content-range?
  const rango = await fetch(url, {
    method: 'GET',
    headers: signRequest({
      method: 'GET',
      path: new URL(url).pathname,
      headers: { host: new URL(url).host, range: 'bytes=0-0' },
      payloadHash: createHash('sha256').update('').digest('hex'),
      accessKeyId,
      secretAccessKey,
      region: 'auto',
    }),
  });
  console.log('GET range status:', rango.status);
  console.log('GET range content-range:', rango.headers.get('content-range') ?? '(ausente)');
  console.log('GET range content-length:', rango.headers.get('content-length') ?? '(ausente)');
  await rango.arrayBuffer().catch(() => {});

  // Y lo que ve el servicio.
  const meta = await storage.getMetadata(key);
  console.log(`via StorageService.getMetadata → ok=${meta.ok} size=${Number(meta.size)} (esperado ${cuerpo.length})`);
}

const borrado = await storage.remove(key).catch(() => ({ ok: false }));
console.log(`DELETE: ${borrado.ok ? 'PASS' : 'FAIL'} · CLEANUP ${borrado.ok ? 'PASS' : 'FAIL'}`);
if (!borrado.ok) console.log(`CLEANUP aviso: quedó sin borrar ${key}`);
process.exitCode = 0;
void sha;
