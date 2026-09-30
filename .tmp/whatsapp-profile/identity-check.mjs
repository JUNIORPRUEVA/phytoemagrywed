/*
 * VERIFICACIÓN DE IDENTIDAD antes de tocar nada.
 *
 * Compara las variables del entorno contra los identificadores esperados de
 * PHYTOEMAGRY Cloud API y publica SOLO «MATCH» o «MISMATCH». Nunca imprime
 * valores, ni longitudes, ni prefijos: solo el resultado de la comparación.
 *
 * Uso: node .tmp/whatsapp-profile/identity-check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ESPERADO = {
  PHONE_NUMBER_ID: '1410599278794907',
  WABA: '2559517617897858',
  META_APP_ID: '998220578866944',
  PHONE: '18494240621',
};

const VARIABLES = {
  PHONE_NUMBER_ID: 'WHATSAPP_PHONE_NUMBER_ID',
  WABA: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
  META_APP_ID: 'META_APP_ID',
  PHONE: 'WHATSAPP_PHONE_NUMBER',
};

const SECRETOS = ['WHATSAPP_ACCESS_TOKEN', 'META_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_GRAPH_VERSION'];

const leer = (nombre) => String(process.env[nombre] ?? '').trim();
const digitos = (valor) => valor.replace(/\D/g, '');

if (Object.values(VARIABLES).some((nombre) => !leer(nombre))) {
  try {
    process.loadEnvFile(path.join(RAIZ, '.env'));
  } catch {
    /* sin .env: se queda con el entorno */
  }
}

console.log('--- PRESENCIA (nombres, sin valores) ---');
for (const nombre of [...Object.values(VARIABLES), ...SECRETOS]) {
  console.log(`${nombre}: ${leer(nombre) ? 'PRESENTE' : 'AUSENTE'}`);
}

console.log('\n--- IDENTIDAD ---');
let bloqueante = false;
for (const [etiqueta, esperado] of Object.entries(ESPERADO)) {
  const obtenido = leer(VARIABLES[etiqueta]);
  if (!obtenido) {
    console.log(`${etiqueta} = SIN VALOR EN EL ENTORNO`);
    if (etiqueta === 'PHONE_NUMBER_ID' || etiqueta === 'WABA') bloqueante = true;
    continue;
  }
  const coincide = etiqueta === 'PHONE' ? digitos(obtenido).endsWith(digitos(esperado)) : obtenido === esperado;
  console.log(`${etiqueta} = ${coincide ? 'MATCH' : 'MISMATCH'}`);
  if (!coincide && (etiqueta === 'PHONE_NUMBER_ID' || etiqueta === 'WABA')) bloqueante = true;
}

console.log(`\nIDENTIDAD = ${bloqueante ? 'NO CONFIRMADA → DETENERSE' : 'CONFIRMADA (se puede continuar)'}`);
process.exitCode = bloqueante ? 2 : 0;
