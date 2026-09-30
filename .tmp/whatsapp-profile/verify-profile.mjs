/*
 * VERIFICACIÓN FINAL del perfil + descarga de la foto REAL para compararla con
 * la que subimos.
 *
 *   · Vuelve a leer el perfil por la API oficial.
 *   · Descarga `profile_picture_url` (la URL llega firmada: NO se imprime) a
 *     `.tmp/whatsapp-profile/whatsapp-profile-actual.png` para poder comparar.
 *
 * Uso: node .tmp/whatsapp-profile/verify-profile.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SALIDA = path.join(RAIZ, '.tmp', 'whatsapp-profile', 'whatsapp-profile-actual.png');

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
  console.log('VERIFICACIÓN = BLOCKED (faltan credenciales)');
  process.exit(3);
}

const headers = { Authorization: `Bearer ${token}` };
const base = `https://graph.facebook.com/${version}`;
const errorSeguro = (json) =>
  json?.error ? `code=${json.error.code} subcode=${json.error.error_subcode ?? '-'}` : 'sin detalle';

const numero = await (await fetch(`${base}/${numeroId}?fields=display_phone_number,verified_name,name_status,status,platform_type,code_verification_status,quality_rating`, { headers })).json();
console.log(`PHONE: ${numero.display_phone_number ?? '(sin dato)'}`);
console.log(`STATUS: ${numero.status ?? '(sin dato)'} · PLATFORM: ${numero.platform_type ?? '(sin dato)'}`);
console.log(`VERIFICATION: ${numero.code_verification_status ?? '(sin dato)'} · QUALITY: ${numero.quality_rating ?? '(sin dato)'}`);
console.log(`DISPLAY NAME: ${numero.verified_name ?? '(sin dato)'} · STATUS: ${numero.name_status ?? '(sin dato)'}`);

const perfil = await (await fetch(`${base}/${numeroId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`, { headers })).json();
if (perfil.error) {
  console.log(`perfil: FAIL · ${errorSeguro(perfil)}`);
  process.exit(1);
}
const p = perfil.data?.[0] ?? {};
console.log(`ABOUT: ${p.about ?? '(vacío)'}`);
console.log(`DESCRIPTION: ${p.description ?? '(vacío)'}`);
console.log(`WEBSITES: ${(p.websites ?? []).join(', ') || '(vacío)'}`);
console.log(`EMAIL (sin tocar): ${p.email ?? '(vacío)'}`);
console.log(`ADDRESS (sin tocar): ${p.address ?? '(vacío)'}`);
console.log(`VERTICAL (sin tocar): ${p.vertical ?? '(sin dato)'}`);
console.log(`PROFILE PICTURE: ${p.profile_picture_url ? 'CONFIGURED' : 'NOT CONFIGURED'}`);

if (p.profile_picture_url) {
  const imagen = await fetch(p.profile_picture_url);
  if (!imagen.ok) {
    console.log(`descarga de la foto: FAIL (http ${imagen.status})`);
  } else {
    const bytes = Buffer.from(await imagen.arrayBuffer());
    writeFileSync(SALIDA, bytes);
    console.log(`foto descargada: ${bytes.length} bytes → .tmp/whatsapp-profile/whatsapp-profile-actual.png`);
  }
}
