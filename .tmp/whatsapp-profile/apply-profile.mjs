/*
 * PERFIL COMERCIAL DE WHATSAPP — auditoría y aplicación (Graph API oficial).
 *
 * POR DEFECTO NO CAMBIA NADA: hace solo lectura y, si no hay credenciales,
 * informa BLOCKED. Para aplicar cambios hace falta pedirlo explícitamente:
 *
 *   node .tmp/whatsapp-profile/apply-profile.mjs                  (auditoría)
 *   node .tmp/whatsapp-profile/apply-profile.mjs --apply          (aplica about, descripción y web)
 *   node .tmp/whatsapp-profile/apply-profile.mjs --apply --with-picture   (además, la foto)
 *
 * Credenciales: SIEMPRE del entorno (`WHATSAPP_ACCESS_TOKEN`,
 * `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`; `META_APP_ID` solo para la
 * foto). Nunca se imprimen, ni el token, ni la URL firmada de la foto, ni el
 * `handle` de subida: de todo eso se informa únicamente presencia/éxito.
 *
 * Lo que NO toca, por diseño: display name, categoría/vertical, email, dirección,
 * número, plantillas, webhook, tokens, permisos.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const APLICAR = args.has('--apply');
const CON_FOTO = args.has('--with-picture');

const CLAVES = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_GRAPH_VERSION', 'META_APP_ID'];
const presente = (nombre) => Boolean(String(process.env[nombre] ?? '').trim());

if (CLAVES.some((clave) => !presente(clave))) {
  try {
    process.loadEnvFile(path.join(RAIZ, '.env'));
  } catch {
    /* sin .env: se queda con lo que traiga el entorno */
  }
}

console.log('--- CREDENCIALES (solo presencia) ---');
for (const clave of CLAVES) console.log(`${clave}: ${presente(clave) ? 'PRESENTE' : 'AUSENTE'}`);

const token = String(process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
const numeroId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
const version = String(process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0').trim() || 'v21.0';
const appId = String(process.env.META_APP_ID ?? '').trim();

if (!token || !numeroId) {
  console.log('\nPERFIL WHATSAPP = BLOCKED');
  console.log('  · falta WHATSAPP_ACCESS_TOKEN y/o WHATSAPP_PHONE_NUMBER_ID en ESTE entorno.');
  console.log('  · en el servidor sí están configurados (docs/WHATSAPP_INTEGRATION.md §12);');
  console.log('  · ejecuta este mismo script allí para auditar/aplicar, o define las variables aquí.');
  console.log('  · NO se ha consultado ni modificado nada.');
  process.exit(3);
}

const base = `https://graph.facebook.com/${version}`;
const cabeceras = { Authorization: `Bearer ${token}` };

/** Llama a Graph y devuelve {ok, status, json} sin volcar nunca la respuesta cruda. */
async function graph(ruta, { method = 'GET', body = null } = {}) {
  const respuesta = await fetch(`${base}${ruta}`, {
    method,
    headers: body ? { ...cabeceras, 'content-type': 'application/json' } : cabeceras,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await respuesta.json();
  } catch {
    json = null;
  }
  return { ok: respuesta.ok, status: respuesta.status, json };
}

/** Error de Meta en formato seguro (código y subcódigo, sin mensajes que citen datos). */
const errorSeguro = (json) =>
  json?.error ? `code=${json.error.code} subcode=${json.error.error_subcode ?? '-'} type=${json.error.type ?? '-'}` : 'sin detalle';

/* ------------------------------------------------------------------ AUDITORÍA */

console.log('\n--- AUDITORÍA DEL PERFIL (solo lectura) ---');

const numero = await graph(
  `/${numeroId}?fields=display_phone_number,verified_name,name_status,quality_rating,platform_type,code_verification_status,status,account_mode,is_official_business_account`,
);
if (!numero.ok) {
  console.log(`número: FAIL (http ${numero.status}) · ${errorSeguro(numero.json)}`);
} else {
  const d = numero.json;
  console.log(`PHONE: ${d.display_phone_number ?? '(sin dato)'}`);
  console.log(`STATUS: ${d.status ?? '(sin dato)'}`);
  console.log(`PLATFORM: ${d.platform_type ?? '(sin dato)'} · MODE: ${d.account_mode ?? '(sin dato)'}`);
  console.log(`VERIFICATION: ${d.code_verification_status ?? '(sin dato)'}`);
  console.log(`DISPLAY NAME (verified_name): ${d.verified_name ?? '(sin dato)'}`);
  console.log(`DISPLAY NAME STATUS (name_status): ${d.name_status ?? '(sin dato)'}`);
  console.log(`QUALITY: ${d.quality_rating ?? '(sin dato)'} · OBA: ${d.is_official_business_account ?? '(sin dato)'}`);
}

// Webhook: en una llamada aparte, porque según los permisos del token puede no
// estar disponible y no queremos que eso tumbe la auditoría del perfil.
const webhook = await graph(`/${numeroId}?fields=webhook_configuration`);
if (webhook.ok) {
  const url = String(webhook.json?.webhook_configuration?.application ?? '');
  const esperado = String(process.env.PHYTO_EXPECTED_WEBHOOK ?? 'https://phytoemagryrd.lat/api/webhooks/whatsapp');
  console.log(`WEBHOOK: ${url ? (url === esperado ? 'MATCH' : 'MISMATCH') : '(sin dato)'} (no se modifica)`);
} else {
  console.log(`WEBHOOK: no consultable con este token (http ${webhook.status}) · no se modifica`);
}

const perfil = await graph(
  `/${numeroId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
);
if (!perfil.ok) {
  console.log(`perfil: FAIL (http ${perfil.status}) · ${errorSeguro(perfil.json)}`);
} else {
  const p = perfil.json?.data?.[0] ?? {};
  console.log(`ABOUT: ${p.about ?? '(vacío)'}`);
  console.log(`DESCRIPTION: ${p.description ?? '(vacío)'}`);
  console.log(`WEBSITE(S): ${(p.websites ?? []).join(', ') || '(vacío)'}`);
  console.log(`EMAIL: ${p.email ?? '(vacío)'}`);
  console.log(`ADDRESS: ${p.address ?? '(vacío)'}`);
  console.log(`CATEGORY/VERTICAL: ${p.vertical ?? '(sin dato)'}  (se lista aparte; no se modifica)`);
  // La URL de la foto llega firmada: NO se imprime; solo si existe.
  console.log(`PROFILE PICTURE: ${p.profile_picture_url ? 'configurada (URL firmada no mostrada)' : '(sin foto)'}`);
}

if (!APLICAR) {
  console.log('\nMODO: auditoría (no se cambia nada). Añade --apply para aplicar about/descripción/web.');
  process.exit(0);
}

/* ------------------------------------------------------------- APLICACIÓN */

const ABOUT = 'Información y pedidos de Phytoemagry 🌿';
const DESCRIPTION =
  'Phytoemagry RD 🌿 | Producto fitoterápico en cápsulas. Información, pedidos y atención personalizada.';
const WEBSITE = 'https://phytoemagryrd.lat';

const cambios = { about: ABOUT, description: DESCRIPTION, websites: [WEBSITE] };
console.log('\n--- APLICANDO (solo estos campos) ---');
console.log(JSON.stringify(cambios, null, 2));

const aplicar = await graph(`/${numeroId}/whatsapp_business_profile`, {
  method: 'POST',
  body: { messaging_product: 'whatsapp', ...cambios },
});
console.log(aplicar.ok ? 'POST perfil: OK' : `POST perfil: FAIL (http ${aplicar.status}) · ${errorSeguro(aplicar.json)}`);

if (CON_FOTO) {
  if (!appId) {
    console.log('FOTO: no aplicada · falta META_APP_ID (necesario para la subida oficial).');
  } else {
    const rutaPng = path.join(RAIZ, '.tmp', 'whatsapp-profile-ready.png');
    const bytes = readFileSync(rutaPng);
    // 1) Sesión de subida (Resumable Upload API).
    const sesion = await graph(`/${appId}/uploads?file_length=${bytes.length}&file_type=image%2Fpng`, { method: 'POST' });
    if (!sesion.ok) {
      console.log(`FOTO: sesión de subida FAIL (http ${sesion.status}) · ${errorSeguro(sesion.json)}`);
    } else {
      const idSubida = sesion.json?.id;
      // 2) Envío del binario con el token en la cabecera OAuth.
      const subida = await fetch(`${base}/${idSubida}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'content-type': 'image/png' },
        body: bytes,
      });
      const jsonSubida = await subida.json().catch(() => null);
      if (!subida.ok || !jsonSubida?.h) {
        console.log(`FOTO: subida FAIL (http ${subida.status}) · ${errorSeguro(jsonSubida)}`);
      } else {
        const conFoto = await graph(`/${numeroId}/whatsapp_business_profile`, {
          method: 'POST',
          body: { messaging_product: 'whatsapp', profile_picture_handle: jsonSubida.h },
        });
        console.log(conFoto.ok ? 'FOTO: aplicada (handle aceptado, no se imprime)' : `FOTO: FAIL (http ${conFoto.status}) · ${errorSeguro(conFoto.json)}`);
      }
    }
  }
}

/* ----------------------------------------------------------- VERIFICACIÓN */

console.log('\n--- VERIFICACIÓN (volviendo a leer el perfil) ---');
const despues = await graph(
  `/${numeroId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
);
if (!despues.ok) {
  console.log(`verificación FAIL (http ${despues.status}) · ${errorSeguro(despues.json)}`);
} else {
  const p = despues.json?.data?.[0] ?? {};
  const compara = (etiqueta, esperado, obtenido) => {
    const ok = esperado === undefined || String(obtenido ?? '') === String(esperado ?? '');
    console.log(`${etiqueta}: ${ok ? 'CONFIRMADO' : `DISTINTO (esperado «${esperado}», Meta devuelve «${obtenido ?? ''}»)`}`);
  };
  compara('ABOUT', ABOUT, p.about);
  compara('DESCRIPTION', DESCRIPTION, p.description);
  compara('WEBSITE', WEBSITE, (p.websites ?? [])[0]);
  if (CON_FOTO) console.log(`PROFILE PICTURE: ${p.profile_picture_url ? 'presente' : 'AUSENTE'}`);
  console.log(`EMAIL (sin tocar): ${p.email ?? '(vacío)'}`);
  console.log(`ADDRESS (sin tocar): ${p.address ?? '(vacío)'}`);
  console.log(`VERTICAL (sin tocar): ${p.vertical ?? '(sin dato)'}`);
}
