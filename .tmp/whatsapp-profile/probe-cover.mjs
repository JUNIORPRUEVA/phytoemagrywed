/*
 * ¿Existe algún campo de PORTADA en el perfil de WhatsApp Business?
 *
 * Sonda READ-ONLY sobre el endpoint OFICIAL ya documentado
 * (`/whatsapp_business_profile`), probando nombres plausibles de campo. No se
 * inventa ningún endpoint ni se escribe nada: solo se lee y se informa si Meta
 * acepta el campo o responde que no existe.
 *
 * Nunca imprime valores del perfil, tokens ni URLs: solo el nombre probado y el
 * resultado (EXISTE / NO EXISTE).
 *
 * Uso: node .tmp/whatsapp-profile/probe-cover.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const leer = (nombre) => String(process.env[nombre] ?? '').trim();

if (!leer('WHATSAPP_ACCESS_TOKEN') || !leer('WHATSAPP_PHONE_NUMBER_ID')) {
  try {
    process.loadEnvFile(path.join(RAIZ, '.env'));
  } catch {
    /* sin .env */
  }
}

const token = leer('WHATSAPP_ACCESS_TOKEN');
const numeroId = leer('WHATSAPP_PHONE_NUMBER_ID');
const version = leer('WHATSAPP_GRAPH_VERSION') || 'v21.0';
if (!token || !numeroId) {
  console.log('SONDA PORTADA = BLOCKED (faltan credenciales)');
  process.exit(3);
}

const CANDIDATOS = ['cover_photo', 'cover_photo_url', 'cover_image', 'banner', 'cover_picture_url'];
// Control: un campo que SÍ existe. Si el control no sale, la sonda no vale.
const CONTROL = 'about';

console.log('--- sonda READ-ONLY de campos de portada ---');
console.log('(se compara la CLAVE devuelta, no el código HTTP: Meta responde 200 e ignora campos desconocidos)');

/**
 * Devuelve las CLAVES del objeto devuelto para ese campo (nunca valores).
 * Si Meta ignora el campo, el objeto vuelve vacío.
 */
async function clavesDe(campo) {
  const url = `https://graph.facebook.com/${version}/${numeroId}/whatsapp_business_profile?fields=${campo}`;
  const respuesta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let json = null;
  try {
    json = await respuesta.json();
  } catch {
    json = null;
  }
  if (json?.error) return { error: `code=${json.error.code} subcode=${json.error.error_subcode ?? '-'}` };
  const fila = json?.data?.[0] ?? {};
  return { claves: Object.keys(fila) };
}

const control = await clavesDe(CONTROL);
console.log(`control «${CONTROL}»: ${control.claves?.length ? `devuelve ${control.claves.length} clave(s) → sonda válida` : 'NO devuelve nada → sonda INVÁLIDA'}`);

let alguno = false;
for (const campo of CANDIDATOS) {
  const resultado = await clavesDe(campo);
  const existe = Boolean(resultado.claves?.some((clave) => clave.toLowerCase().includes('cover') || clave.toLowerCase().includes('banner')));
  if (existe) alguno = true;
  console.log(
    `${campo}: ${existe ? 'EXISTE (clave devuelta)' : 'NO EXISTE (Meta lo ignora)'}${
      resultado.error ? ` · ${resultado.error}` : ` · claves: ${resultado.claves?.length ? resultado.claves.join(', ') : '(ninguna)'}`
    }`,
  );
}

console.log(`\nPORTADA POR API = ${alguno ? 'ALGÚN CAMPO DE PORTADA RESPONDIÓ' : 'NO SOPORTADA (ninguno de los campos devuelve nada)'}`);
