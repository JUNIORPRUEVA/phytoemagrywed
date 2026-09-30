/*
 * SMOKE REAL DEL ALMACÉN DE ARCHIVOS (R2 / S3 compatible).
 *
 * Para qué sirve: comprobar que las credenciales configuradas funcionan de
 * verdad (subida, metadatos, descarga íntegra y borrado) SIN tocar nada del
 * negocio. Se lanza antes de desplegar o cuando se cambian las claves.
 *
 *   npm run smoke:r2
 *
 * Qué hace, en este orden y sin saltarse pasos:
 *
 *   PUT → HEAD → GET → tamaño → SHA-256 → DELETE → confirmar que ya NO existe
 *
 * Reglas que cumple a rajatabla:
 *
 *   · UN solo objeto, con nombre aleatorio, bajo `uat/phytoemagry-storage-test/`.
 *   · Contenido ficticio generado aquí: no toca clientes, mensajes, pedidos ni
 *     comprobantes.
 *   · Nada de listar, nada de borrados por prefijo ni comodines: solo la key
 *     creada por esta ejecución.
 *   · Si falla cualquier etapa, se intenta borrar igualmente (try/finally) y se
 *     avisa si no se pudo.
 *   · NUNCA imprime endpoint, bucket, claves ni respuestas crudas del proveedor:
 *     de un fallo solo dice la etapa y un código seguro.
 *
 * Lectura de credenciales: primero el entorno del proceso (como en el servidor);
 * si faltan y existe un `.env` al lado del proyecto, se carga ESE archivo sin
 * sobrescribir nada de lo que ya esté definido.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStorageService } from '../server/storage.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAVES = ['R2_ENDPOINT', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const ETIQUETA = {
  R2_ENDPOINT: 'ENDPOINT',
  R2_BUCKET_NAME: 'BUCKET',
  R2_ACCESS_KEY_ID: 'ACCESS KEY',
  R2_SECRET_ACCESS_KEY: 'SECRET',
};

const presente = (nombre) => Boolean(String(process.env[nombre] ?? '').trim());

let origen = 'entorno del proceso';
if (CLAVES.some((clave) => !presente(clave))) {
  try {
    process.loadEnvFile(path.join(RAIZ, '.env'));
    origen = 'entorno del proceso + .env del proyecto';
  } catch {
    origen = 'entorno del proceso (no hay .env legible)';
  }
}

console.log('--- R2 ENV (solo presencia) ---');
for (const clave of CLAVES) console.log(`${ETIQUETA[clave]}: ${presente(clave) ? 'PRESENTE' : 'AUSENTE'}`);
console.log(`R2 ENV SOURCE: ${origen}`);

const faltan = CLAVES.filter((clave) => !presente(clave));
if (faltan.length) {
  console.log(`R2 SMOKE = BLOCKED (faltan ${faltan.map((c) => ETIQUETA[c]).join(', ')})`);
  console.log('  · define esas variables en el entorno (o en .env) y vuelve a intentarlo.');
  process.exit(3);
}

const storage = createStorageService({
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
});
console.log(`STORAGE ENABLED: ${storage.enabled ? 'sí' : 'no'}`);

/** Traduce un fallo a una categoría segura: nunca vuelca la respuesta del proveedor. */
function clasificar(etapa, resultado) {
  const status = Number(resultado?.status ?? 0);
  const error = String(resultado?.error ?? '');
  if (error === 'timeout') return `TIMEOUT (${etapa})`;
  if (error === 'network') return `NETWORK (${etapa})`;
  if (error === 'storage_disabled') return 'UNKNOWN (almacén desactivado)';
  if (status === 401) return `AUTH (${etapa})`;
  if (status === 403) return `AUTH O SIGNATURE (${etapa})`;
  if (status === 404) return `BUCKET o KEY INEXISTENTE (${etapa})`;
  if (status === 400) return `SIGNATURE o PETICIÓN INVÁLIDA (${etapa})`;
  if (status === 0) return `UNKNOWN (${etapa})`;
  return `${etapa.toUpperCase()} (http ${status})`;
}

const fecha = new Date().toISOString().slice(0, 10);
const clave = `uat/phytoemagry-storage-test/${fecha}/${randomUUID()}.txt`;
const carga = Buffer.from(`phytoemagry smoke ${randomUUID()} ${Date.now()}\n`, 'utf8');
const sha256 = createHash('sha256').update(carga).digest('hex');

const etapas = {};
let creado = false;
let borrado = false;
let fallo = null;
const marcar = (etapa, ok, detalle) => {
  etapas[etapa] = ok ? (etapa === 'SHA256' ? 'MATCH' : 'PASS') : 'FAIL';
  if (!ok && !fallo) fallo = { etapa, detalle };
};

console.log(`--- clave lógica: ${clave} (carga ficticia de ${carga.length} bytes) ---`);

// 1) PUT
const subida = await storage.put(clave, carga, 'text/plain');
creado = subida.ok;
marcar('PUT', subida.ok, clasificar('PUT', subida));

if (creado) {
  // 2) HEAD: existencia (y tamaño cuando el proveedor lo anuncia)
  const cabeza = await storage.getMetadata(clave);
  const anunciado = cabeza.size === null || cabeza.size === undefined ? null : Number(cabeza.size);
  const tamanoOk = anunciado === null ? true : anunciado === carga.length;
  console.log(
    `  · HEAD: existe=${cabeza.ok ? 'sí' : 'no'} · content-length=${
      anunciado === null ? 'no lo anuncia el proveedor' : anunciado
    } · enviado=${carga.length}`,
  );
  marcar(
    'HEAD',
    cabeza.ok && tamanoOk,
    cabeza.ok ? `el tamaño no coincide (${anunciado} vs ${carga.length})` : clasificar('HEAD', cabeza),
  );

  // 3) GET: los bytes vuelven
  const lectura = await storage.get(clave);
  marcar('GET', lectura.ok, clasificar('GET', lectura));

  if (lectura.ok) {
    // 4) Tamaño real de lo descargado (no depende de que el proveedor anuncie nada)
    const bytes = lectura.buffer?.length ?? 0;
    marcar('SIZE', bytes === carga.length, `descargados ${bytes} y enviados ${carga.length}`);

    // 5) SHA-256 del contenido devuelto
    const shaLeido = createHash('sha256').update(lectura.buffer).digest('hex');
    marcar('SHA256', shaLeido === sha256, 'el contenido no coincide');
  }

  // 6) DELETE (solo esta key)
  const resultadoBorrado = await storage.remove(clave);
  borrado = Boolean(resultadoBorrado.ok);
  marcar('DELETE', borrado, clasificar('DELETE', resultadoBorrado));

  // 7) Que ya NO existe
  if (borrado) {
    const despues = await storage.exists(clave);
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
  const intento = await storage.remove(clave).catch(() => ({ ok: false }));
  borrado = Boolean(intento.ok);
  etapas.DELETE = intento.ok ? 'PASS' : 'FAIL';
}

console.log('--- resultado ---');
for (const nombre of ['PUT', 'HEAD', 'GET', 'SIZE', 'SHA256', 'DELETE', 'ABSENT AFTER DELETE']) {
  console.log(`${nombre}: ${etapas[nombre] ?? 'NO EJECUTADO'}`);
}
console.log(`CLEANUP: ${creado ? (borrado ? 'PASS' : 'FAIL') : 'NO HACÍA FALTA'}`);
if (creado && !borrado) console.log(`CLEANUP aviso: quedó sin borrar ${clave}`);

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
