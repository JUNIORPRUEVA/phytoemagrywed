/**
 * SMOKE REAL CONTRA R2 (Fase final pre-push) — seguro y reversible.
 *
 * Qué hace, en este orden y sin saltarse pasos:
 *
 *   PUT → HEAD → GET → SHA-256 → DELETE → confirmar que YA NO existe
 *
 *Reglas que cumple a rajatabla:
 *
 *  · Un ÚNICO objeto, con nombre aleatorio, bajo `uat/phytoemagry-storage-test/`.
 *  · Contenido ficticio generado aquí (no toca clientes, mensajes, pedidos ni
 *    comprobantes).
 *  · Nada de listar, nada de borrados por prefijo ni comodines: solo la key creada.
 *  · `try/finally`: si falla cualquier etapa, se intenta borrar igualmente.
 *  · NUNCA imprime endpoint, bucket, access key, secret, ni respuestas crudas:
 *    de un fallo solo dice la etapa y un código seguro.
 *
 * Uso (las credenciales vienen del entorno, nunca por argumentos):
 *
 *   node --env-file=.env .tmp/s3-uat/r2-smoke.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { createStorageService } from '../../server/storage.mjs';

const CLAVES = ['R2_ENDPOINT', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const ETIQUETA = {
  R2_ENDPOINT: 'ENDPOINT',
  R2_BUCKET_NAME: 'BUCKET',
  R2_ACCESS_KEY_ID: 'ACCESS KEY',
  R2_SECRET_ACCESS_KEY: 'SECRET',
};

/** Solo presencia: ni valor, ni longitud, ni prefijo, ni sufijo. */
const presente = (nombre) => Boolean(String(process.env[nombre] ?? '').trim());

console.log('--- R2 ENV (solo presencia) ---');
for (const clave of CLAVES) console.log(`${ETIQUETA[clave]}: ${presente(clave) ? 'PRESENTE' : 'AUSENTE'}`);

const faltan = CLAVES.filter((clave) => !presente(clave));
if (faltan.length) {
  console.log(`R2 ENV SOURCE: this-process (faltan ${faltan.length})`);
  console.log('R2 SMOKE = BLOCKED');
  process.exit(3);
}

const storage = createStorageService({
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
});

console.log('R2 ENV SOURCE: this-process (.env cargado con --env-file)');
console.log('STORAGE ENABLED:', storage.enabled ? 'sí' : 'no');

/** Traduce un fallo a una categoría segura (sin volcar la respuesta). */
function clasificar(etapa, resultado) {
  const status = Number(resultado?.status ?? 0);
  const error = String(resultado?.error ?? '');
  if (error === 'timeout') return `TIMEOUT (${etapa})`;
  if (error === 'network') return `NETWORK (${etapa})`;
  if (error === 'storage_disabled') return 'UNKNOWN (desactivado)';
  if (status === 401) return `AUTH (${etapa})`;
  if (status === 403) return `AUTH O SIGNATURE (${etapa})`;
  if (status === 404) return `BUCKET o KEY INEXISTENTE (${etapa})`;
  if (status === 400) return `SIGNATURE o PETICIÓN INVÁLIDA (${etapa})`;
  if (status === 0) return `UNKNOWN (${etapa})`;
  return `${etapa.toUpperCase()} (http ${status})`;
}

const fecha = new Date().toISOString().slice(0, 10);
const key = `uat/phytoemagry-storage-test/${fecha}/${randomUUID()}.txt`;
const cuerpo = Buffer.from(`phytoemagry smoke ${randomUUID()} ${Date.now()}\n`, 'utf8');
const sha256 = createHash('sha256').update(cuerpo).digest('hex');

const etapas = {};
let borrado = false;
let creado = false;
let fallo = null; // { etapa, detalle } seguro: sin cuerpos de respuesta
const marcar = (etapa, ok, detalle) => {
  etapas[etapa] = ok ? (etapa === 'SHA256' ? 'MATCH' : 'PASS') : 'FAIL';
  if (!ok && !fallo) fallo = { etapa, detalle };
};
console.log(`--- clave lógica: ${key} (carga ficticia de ${cuerpo.length} bytes) ---`);

// 1) PUT
const subida = await storage.put(key, cuerpo, 'text/plain');
creado = subida.ok;
marcar('PUT', subida.ok, clasificar('PUT', subida));

if (creado) {
  // 2) HEAD: existencia (y tamaño cuando el proveedor lo manda)
  const cabeza = await storage.getMetadata(key);
  const declarado = cabeza.size === null || cabeza.size === undefined ? null : Number(cabeza.size);
  const tamanoOk = declarado === null ? true : declarado === cuerpo.length;
  console.log(
    `  · HEAD: existe=${cabeza.ok ? 'sí' : 'no'} · content-length=${declarado === null ? 'no lo manda el proveedor' : declarado} · enviado=${cuerpo.length}`,
  );
  marcar('HEAD', cabeza.ok && tamanoOk, cabeza.ok ? `el tamaño no coincide (${declarado} vs ${cuerpo.length})` : clasificar('HEAD', cabeza));

  // 3) GET
  const lectura = await storage.get(key);
  marcar('GET', lectura.ok, clasificar('GET', lectura));

  // 3b) Tamaño REAL de lo descargado (no depende de que el proveedor anuncie nada)
  if (lectura.ok) {
    const bytes = lectura.buffer?.length ?? 0;
    marcar('SIZE', bytes === cuerpo.length, `descargados ${bytes} y enviados ${cuerpo.length}`);
  }

  // 4) SHA-256 del contenido devuelto
  if (lectura.ok) {
    const shaLeido = createHash('sha256').update(lectura.buffer).digest('hex');
    marcar('SHA256', shaLeido === sha256, 'el contenido no coincide');
  }

  // 5) DELETE (solo esta key)
  const borradoResultado = await storage.remove(key);
  borrado = Boolean(borradoResultado.ok);
  marcar('DELETE', borrado, clasificar('DELETE', borradoResultado));

  // 6) Confirmar que ya NO existe
  if (borrado) {
    const despues = await storage.exists(key);
    const ausente = !despues.ok && Number(despues.status) === 404;
    marcar('ABSENT AFTER DELETE', ausente, despues.ok ? 'el objeto sigue ahí' : clasificar('ABSENT', despues));
  }
}

if (fallo) {
  console.log(`R2 SMOKE = FAIL en ${fallo.etapa}`);
  console.log(`CLASIFICACIÓN: ${fallo.detalle ?? 'UNKNOWN'}`);
}

// Limpieza: SIEMPRE, y solo esta key.
if (creado && !borrado) {
  const intento = await storage.remove(key).catch(() => ({ ok: false, status: 0 }));
  borrado = Boolean(intento.ok);
  etapas.DELETE = intento.ok ? 'PASS' : 'FAIL';
}

console.log('--- resultado ---');
for (const nombre of ['PUT', 'HEAD', 'GET', 'SIZE', 'SHA256', 'DELETE', 'ABSENT AFTER DELETE']) {
  console.log(`${nombre}: ${etapas[nombre] ?? 'NO EJECUTADO'}`);
}
console.log(`CLEANUP: ${creado ? (borrado ? 'PASS' : 'FAIL') : 'NO HACÍA FALTA'}`);
if (creado && !borrado) console.log(`CLEANUP aviso: quedó sin borrar ${key}`);

const todoOk =
  etapas.PUT === 'PASS' &&
  etapas.HEAD === 'PASS' &&
  etapas.GET === 'PASS' &&
  etapas.SIZE === 'PASS' &&
  etapas.SHA256 === 'MATCH' &&
  etapas.DELETE === 'PASS' &&
  etapas['ABSENT AFTER DELETE'] === 'PASS';
console.log(`R2 SMOKE = ${todoOk ? 'PASS' : 'FAIL'}`);
process.exitCode = todoOk ? 0 : 1;
