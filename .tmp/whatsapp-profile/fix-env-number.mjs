/*
 * Corrige SOLO la línea de `PHYTO_WHATSAPP_NUMBER` en `.env`.
 *
 * Conserva el resto del archivo byte a byte (incluidos los finales de línea) y no
 * imprime ningún valor: solo informa si cambió y si el archivo sigue teniendo las
 * mismas claves que antes.
 *
 * Uso: node .tmp/whatsapp-profile/fix-env-number.mjs [.env|.env.local]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUTA = path.join(RAIZ, process.argv[2] ?? '.env');
const OFICIAL = '18494240621';

const antes = readFileSync(RUTA, 'utf8');
const claves = (texto) =>
  texto
    .split(/\r?\n/)
    .filter((linea) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(linea))
    .map((linea) => linea.split('=')[0].trim())
    .join(',');

const clavesAntes = claves(antes);
const lineasAntes = antes.split(/\r?\n/).length;

// Solo la línea de la variable; el resto (incluido su \r, si lo hay) se respeta.
const despues = antes.replace(/^(\s*PHYTO_WHATSAPP_NUMBER\s*=)[^\r\n]*/m, `$1${OFICIAL}`);

const clavesDespues = claves(despues);
const lineasDespues = despues.split(/\r?\n/).length;

console.log(`fichero: ${path.basename(RUTA)}`);
console.log(`¿cambió?: ${antes === despues ? 'NO (ya estaba)' : 'SÍ'}`);
console.log(`claves antes/después: ${clavesAntes === clavesDespues ? 'IDÉNTICAS' : 'CAMBIARON (revisar)'}`);
console.log(`líneas antes/después: ${lineasAntes} / ${lineasDespues}`);

if (clavesAntes !== clavesDespues || lineasAntes !== lineasDespues) {
  console.log('NO se escribe nada: la verificación no cuadra.');
  process.exit(1);
}

if (antes !== despues) {
  writeFileSync(RUTA, despues, 'utf8');
  console.log('escrito: .env (solo esa línea)');
}
