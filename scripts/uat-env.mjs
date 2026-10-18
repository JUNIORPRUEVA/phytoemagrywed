#!/usr/bin/env node
/**
 * AMBIENTE DE PRUEBAS (UAT) — una base de datos APARTE, con datos de ejemplo.
 *
 * PARA QUÉ SIRVE
 *   Probar el CRM y el panel de punta a punta sin tocar NADA de producción:
 *   pedidos, reparto con GPS, WhatsApp, plantillas, factura, inventario,
 *   seguimiento, mensajes programados, usuarios y roles.
 *
 * QUÉ GARANTIZA (todo verificado por este mismo script al arrancar)
 *   1. BASE DE DATOS PROPIA: `data/uat/phyto-uat.sqlite`. Nunca abre la de
 *      producción (`data/phytoemagry.sqlite`) ni Postgres.
 *   2. NADA SALE A INTERNET: WhatsApp va en modo MOCK (los mensajes se registran
 *      en `data/uat/envios.log` en vez de enviarse), la API de conversiones de
 *      Meta queda APAGADA y las notificaciones push quedan DESACTIVADAS.
 *   3. LOS ARCHIVOS (fotos, audios, PDFs) se guardan en `data/uat/media/`, un
 *      "R2 de mentira" local: se pueden abrir desde el hilo y se borran con
 *      `--reset`.
 *
 * CÓMO SE USA
 *   npm run uat                 → arranca (sembrando los datos la primera vez)
 *   npm run uat:reset           → borra la base de pruebas y la vuelve a sembrar
 *   node scripts/uat-env.mjs --port=8800 --sin-scheduler
 *
 *   Panel:  http://127.0.0.1:8790/admin/
 *   Entra con el usuario y la contraseña que imprime al arrancar.
 *
 * NO MODIFICA PRODUCCIÓN: solo crea y escribe dentro de `data/uat/` (ignorada
 * por git). Se puede borrar la carpeta entera sin consecuencias.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// El total de una cotización se calcula con la MISMA función que usan el panel y
// el servidor: si la semilla inventara importes, el POST fallaría por precio.
import { calculateSale } from '../public/admin/pos-math.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const tieneFlag = (nombre) => args.includes(`--${nombre}`);

if (tieneFlag('help') || args.includes('-h')) {
  console.log(`
AMBIENTE DE PRUEBAS de Phytoemagry (base de datos aparte, sin envíos reales)

  npm run uat                     arranca y siembra si hace falta
  npm run uat:reset               borra la base de pruebas y vuelve a sembrar

  node scripts/uat-env.mjs [opciones]

    --reset          borra data/uat/ (base, archivos y registro) y siembra de cero
    --port=8790      puerto del panel y de la API
    --copiar-datos   trabaja con una COPIA de la base de verdad (no la toca)
    --sembrar        fuerza volver a sembrar aunque ya haya datos
    --solo-sembrar   prepara los datos y sale (no deja el servidor abierto)
    --sin-scheduler  apaga el motor de mensajes programados
    --json           salida corta (para scripts)
    --help, -h       esta ayuda

  Lo normal para SEGUIR DESARROLLANDO con tus datos:
    node scripts/uat-env.mjs --copiar-datos     (o: npm run dev:datos)
      → copia tu base real a data/uat/, levanta el panel con TUS clientes y
        pedidos, y deja WhatsApp simulado. Tu base original no se abre para
        escribir: solo se lee para copiarla.

  Todo vive en data/uat/ (ignorada por git). Borrar esa carpeta no rompe nada.
`);
  process.exit(0);
}

const PUERTO = Number(args.find((arg) => arg.startsWith('--port='))?.split('=')[1] ?? 8790);
const RESET = tieneFlag('reset');
const COPIAR_DATOS = tieneFlag('copiar-datos');
const SEMBRAR_SIEMPRE = tieneFlag('sembrar');
const SOLO_SEMBRAR = tieneFlag('solo-sembrar');
const SILENCIOSO = tieneFlag('json');
const SCHEDULER = !tieneFlag('sin-scheduler');

// ------------------------------------------------------------------ ubicación
const DIR_UAT = path.join(ROOT, 'data', 'uat');
const DB_FILE = path.join(DIR_UAT, 'phyto-uat.sqlite');
const MEDIA_DIR = path.join(DIR_UAT, 'media');
const LOG_ENVIOS = path.join(DIR_UAT, 'envios.log');
/** La base "de verdad" del equipo (producción). SOLO se lee, jamás se escribe. */
const DB_REAL = path.join(ROOT, 'data', 'phytoemagry.sqlite');

const TOKEN_UAT = 'phyto-uat';
const SECRETO_WEBHOOK = 'secreto-uat-solo-local';
const CLAVE_USUARIOS = 'UatLocal-123';
const USUARIOS = [
  { clave: 'admin', username: 'admin@uat.local', displayName: 'Admin UAT', role: 'ADMIN' },
  { clave: 'agente', username: 'agente@uat.local', displayName: 'Ana Agente', role: 'AGENT' },
  { clave: 'reparto', username: 'reparto@uat.local', displayName: 'Carlos Reparto', role: 'DELIVERY' },
  { clave: 'operador', username: 'operador@uat.local', displayName: 'Olga Operadora', role: 'OPERADOR' },
];

// ------------------------------------------------------- guardas de seguridad
/*
 * ESTAS COMPROBACIONES VAN ANTES DE CARGAR EL SERVIDOR.
 *
 * El CRM lee `.env` al importarse y esa `.env` tiene las credenciales REALES de
 * WhatsApp/Meta y la cadena de Postgres de producción. Aquí se deja el entorno
 * limpio de todo lo que podría sacar algo a internet o escribir fuera del
 * ambiente de pruebas; el servidor respeta lo que ya esté en `process.env` y NO
 * lo pisa con el `.env`.
 */
function limpiarEntornoPeligroso() {
  // Postgres de producción: fuera. Vacío = el CRM usa el archivo SQLite que le
  // pasamos por configuración.
  process.env.PHYTO_CRM_DATABASE_URL = '';
  // Archivo de datos: SIEMPRE el de pruebas, pase lo que pase en `.env`.
  process.env.PHYTO_CRM_DATA = DB_FILE;
  // Credenciales de WhatsApp/Meta: vacías para que el cliente real no pueda
  // construirse ni por descuido (los mocks se pasan explícitos más abajo).
  for (const clave of [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'META_APP_SECRET',
    'META_APP_ID',
    'PHYTO_META_CAPI_ACCESS_TOKEN',
    'PHYTO_META_PIXEL_ID',
    'PHYTO_META_CAPI_TEST_EVENT_CODE',
    'PHYTO_WEB_PUSH_PUBLIC_KEY',
    'PHYTO_WEB_PUSH_PRIVATE_KEY',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_ENDPOINT',
  ]) {
    process.env[clave] = '';
  }
  // El motor de mensajes programados: se manda explícito para que no lo apague
  // un `PHYTO_CRM_NO_SCHEDULER` heredado del entorno.
  process.env.PHYTO_CRM_NO_SCHEDULER = SCHEDULER ? '' : '1';
  process.env.APP_ENV = 'development';
}

/** Comprueba que una ruta está DENTRO de `data/uat/` (nunca fuera). */
function dentroDeUat(ruta) {
  const relativa = path.relative(DIR_UAT, path.resolve(ruta));
  return relativa !== '' && !relativa.startsWith('..') && !path.isAbsolute(relativa);
}

function vigilarRutas() {
  const problemas = [];
  if (!dentroDeUat(DB_FILE)) problemas.push(`la base de datos queda fuera de data/uat/: ${DB_FILE}`);
  if (!dentroDeUat(MEDIA_DIR)) problemas.push(`la carpeta de archivos queda fuera de data/uat/: ${MEDIA_DIR}`);
  const produccion = path.join(ROOT, 'data', 'phytoemagry.sqlite');
  if (path.resolve(DB_FILE) === path.resolve(produccion)) problemas.push('la base de pruebas apunta a la de producción');
  if (problemas.length) {
    console.error('\n⛔ El ambiente de pruebas no puede arrancar:\n');
    for (const problema of problemas) console.error(`   · ${problema}`);
    console.error('');
    process.exit(1);
  }
}

function banner() {
  const linea = '─'.repeat(72);
  console.log(`\n${linea}`);
  console.log('  AMBIENTE DE PRUEBAS · NO PRODUCCIÓN');
  console.log(linea);
  console.log(`  base de datos : ${path.relative(ROOT, DB_FILE)}`);
  console.log(`  archivos      : ${path.relative(ROOT, MEDIA_DIR)}/   (R2 de mentira, local)`);
  console.log(`  Postgres      : IGNORADO (producción no se toca)`);
  console.log(`  WhatsApp      : MOCK — no se envía nada; se registra en ${path.relative(ROOT, LOG_ENVIOS)}`);
  console.log(`  Meta (CAPI)   : APAGADA — no se avisa a Meta de ninguna compra`);
  console.log(`  Push          : DESACTIVADO — no se avisa a ningún teléfono`);
  console.log(linea);
}

// ------------------------------------------------------------------ utilidades
const ahoraMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const minutos = (n) => n * 60_000;
const horas = (n) => n * 60 * 60_000;

function log(...partes) {
  if (!SILENCIOSO) console.log(...partes);
}

/** Anota TODO lo que WhatsApp "habría enviado" (sin salir a la red). */
function registrarEnvio(tipo, destino, detalle) {
  try {
    mkdirSync(DIR_UAT, { recursive: true });
    appendFileSync(
      LOG_ENVIOS,
      `${new Date().toISOString()}  ${tipo.padEnd(10)} → ${destino}  ${detalle}\n`,
      'utf8',
    );
  } catch {
    /* el registro es una comodidad: si falla, no puede tumbar el ambiente */
  }
}

/** Cabecera de la consola para cada bloque de datos sembrados. */
function paso(titulo) {
  log(`\n▸ ${titulo}`);
}

function dato(texto, valor) {
  log(`   ${texto.padEnd(34)} ${valor}`);
}

// -------------------------------------------------------------------- arranque
mkdirSync(DIR_UAT, { recursive: true });
mkdirSync(MEDIA_DIR, { recursive: true });

function pasoBorraTodo() {
  const borrar = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, LOG_ENVIOS];
  let borrados = 0;
  /*
   * En Windows, si OTRA instancia del ambiente de pruebas sigue abierta, el
   * archivo está bloqueado y borrarlo falla. Se dice claro en vez de reventar
   * con un error de sistema que no explica nada.
   */
  const fallos = [];
  for (const fichero of borrar) {
    if (!existsSync(fichero)) continue;
    try {
      rmSync(fichero, { force: true });
      borrados += 1;
    } catch {
      fallos.push(fichero);
    }
  }
  if (existsSync(MEDIA_DIR)) {
    try {
      rmSync(MEDIA_DIR, { recursive: true, force: true });
      borrados += 1;
    } catch {
      fallos.push(MEDIA_DIR);
    }
  }
  mkdirSync(MEDIA_DIR, { recursive: true });
  banner();
  if (fallos.length) {
    console.error('\n⛔ No se pudieron borrar estos archivos (están en uso):');
    for (const fichero of fallos) console.error(`   · ${path.relative(ROOT, fichero)}`);
    console.error('\n   Lo normal es que el ambiente de pruebas esté ABIERTO en otra');
    console.error('   terminal. Ciérralo con Ctrl+C y vuelve a ejecutar: npm run uat:reset\n');
    process.exit(1);
  }
  console.log(`  --reset: ${borrados} elemento(s) borrados. Se siembra de cero.\n`);
}

vigilarRutas();
limpiarEntornoPeligroso();

/**
 * COPIA LA BASE "DE VERDAD" A LA DE PRUEBAS.
 *
 * Para SEGUIR DESARROLLANDO con los datos reales sin tocar producción: se abre la
 * original en MODO SOLO LECTURA y se copia con `VACUUM INTO`, que es la forma
 * correcta de sacar una copia coherente de una base SQLite que puede estar en uso
 * (por ejemplo, con el CRM abierto en otra terminal). Nada de copiar el archivo a
 * mano: con el diario WAL activo eso puede dar una copia a medias. Si la copia
 * falla, el script PARA: nunca arranca apuntando a la base de producción.
 */
async function copiarDatosReales() {
  if (!existsSync(DB_REAL)) {
    console.error(`\n⛔ No encuentro la base de datos real en ${path.relative(ROOT, DB_REAL)}.`);
    console.error('   Sin ella no hay nada que copiar. Arranca sin `--copiar-datos` para usar');
    console.error('   los datos de ejemplo del ambiente de pruebas.\n');
    process.exit(1);
  }
  for (const fichero of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, LOG_ENVIOS]) {
    if (!existsSync(fichero)) continue;
    try {
      rmSync(fichero, { force: true });
    } catch {
      console.error(`\n⛔ No se pudo preparar ${path.relative(ROOT, fichero)}: ¿está el ambiente de`);
      console.error('   pruebas abierto en otra terminal? Ciérralo (Ctrl+C) y vuelve a intentarlo.\n');
      process.exit(1);
    }
  }
  mkdirSync(DIR_UAT, { recursive: true });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const origen = new DatabaseSync(DB_REAL, { readOnly: true });
    try {
      origen.exec(`VACUUM INTO '${DB_FILE.replaceAll("'", "''")}'`);
    } finally {
      origen.close();
    }
  } catch (error) {
    console.error(`\n⛔ No se pudo copiar la base de datos real: ${error?.message ?? error}`);
    console.error('   Se para aquí a propósito: mejor no arrancar con datos a medias.\n');
    process.exit(1);
  }
  const megas = (statSync(DB_FILE).size / 1024 / 1024).toFixed(1);
  console.log('\n  COPIA de tus datos reales:');
  console.log(`     origen  ${path.relative(ROOT, DB_REAL)}   (abierto SOLO para leer: no se toca)`);
  console.log(`     copia   ${path.relative(ROOT, DB_FILE)}   (${megas} MB · desde aquí se trabaja)`);
  console.log('     las fotos y audios viejos vivían en R2 y no están en la copia; lo que');
  console.log('     envíes desde este entorno sí se guarda y se ve.\n');
}

if (RESET) {
  pasoBorraTodo();
} else if (COPIAR_DATOS) {
  banner();
  await copiarDatosReales();
} else {
  banner();
}

// El servidor se importa DESPUÉS de limpiar el entorno: así ya no ve las
// credenciales reales ni la cadena de Postgres.
const { startCrmServer } = await import('../server/crm-server.mjs');
const { createWhatsAppClient } = await import('../server/whatsapp.mjs');

// ----------------------------------------------------------------------- mocks
/**
 * "R2" local: guarda los archivos en `data/uat/media/`. La clave del objeto
 * trae barras (`phytoemagry/whatsapp/2026/10/...`), así que se convierte en
 * carpetas; nada sale de `data/uat/media/`.
 */
const almacen = {
  enabled: true,
  provider: 'uat-local',
  bucket: 'uat',
  async put(objectKey, buffer) {
    const destino = path.join(MEDIA_DIR, String(objectKey).replaceAll('/', path.sep));
    if (!dentroDeUat(destino)) return { ok: false, error: 'ruta_invalida' };
    mkdirSync(path.dirname(destino), { recursive: true });
    writeFileSync(destino, Buffer.from(buffer));
    registrarEnvio('archivo', objectKey, `${buffer.length} bytes guardados en data/uat/media/`);
    return { ok: true, objectKey, size: buffer.length };
  },
  async get(objectKey) {
    const origen = path.join(MEDIA_DIR, String(objectKey).replaceAll('/', path.sep));
    if (!dentroDeUat(origen) || !existsSync(origen)) return { ok: false, error: 'not_found' };
    return { ok: true, buffer: readFileSync(origen) };
  },
};

/** PNG de 1×1 válido (para que la validación por bytes lo acepte de verdad). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAI/wH+2wAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * WhatsApp de ARCHIVOS en modo local: los "envíos" devuelven un identificador
 * creíble y se anotan en el registro; NADA viaja a Meta.
 */
const whatsappMedia = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  async getMediaMetadata(mediaId) {
    return { ok: true, media: { id: mediaId, mimeType: 'image/png', fileSize: PNG_1X1.length, sha256: null } };
  },
  async downloadMedia(mediaId) {
    registrarEnvio('descarga', mediaId, 'archivo de ejemplo (PNG 1×1)');
    return { ok: true, buffer: PNG_1X1, mimeType: 'image/png', declaredMimeType: 'image/png' };
  },
  async uploadMedia(input) {
    const mediaId = `mid.UAT.${randomBytes(6).toString('hex')}`;
    registrarEnvio('subida', input.filename ?? '(sin nombre)', `${input.mimeType} · ${input.buffer.length} bytes → ${mediaId}`);
    return { ok: true, status: 200, mediaId };
  },
  async sendImage(to, input) {
    registrarEnvio('imagen', to, `media_id=${input.mediaId}${input.caption ? ` · pie: ${input.caption}` : ''}`);
    return { ok: true, status: 200, waMessageId: `wamid.UAT.IMG.${randomBytes(5).toString('hex')}` };
  },
  async sendAudio(to, input) {
    registrarEnvio('audio', to, `media_id=${input.mediaId}`);
    return { ok: true, status: 200, waMessageId: `wamid.UAT.AUD.${randomBytes(5).toString('hex')}` };
  },
  async sendDocument(to, input) {
    registrarEnvio('documento', to, `${input.filename ?? '(sin nombre)'} · media_id=${input.mediaId}`);
    return { ok: true, status: 200, waMessageId: `wamid.UAT.DOC.${randomBytes(5).toString('hex')}` };
  },
  async sendMessage(to, payload) {
    registrarEnvio('mensaje', to, JSON.stringify(payload).slice(0, 120));
    return { ok: true, status: 200, waMessageId: `wamid.UAT.MSG.${randomBytes(5).toString('hex')}` };
  },
  async listTemplates() {
    return { ok: true, status: 200, templates: [] };
  },
  async markAsRead() {
    return { ok: true };
  },
};

/**
 * WhatsApp de TEXTO/PLANTILLA: se usa el cliente REAL del CRM en su modo mock
 * (código de producción, cero red) y se le añade el registro en `envios.log`
 * para poder ver qué se habría enviado y cuándo.
 */
const whatsappBase = createWhatsAppClient({
  mock: true,
  accessToken: 'token-de-pruebas',
  phoneNumberId: 'PN-UAT',
  businessAccountId: 'WABA-UAT',
  graphVersion: 'v21.0',
  log: (mensaje) => log(`   ${mensaje}`),
});

const whatsapp = {
  ...whatsappBase,
  async sendText(to, body, options = {}) {
    registrarEnvio('texto', to, String(body).replace(/\s+/g, ' ').slice(0, 160));
    return whatsappBase.sendText(to, body, options);
  },
  async sendTemplate(to, template = {}) {
    registrarEnvio('plantilla', to, template.name ?? '(sin nombre)');
    return whatsappBase.sendTemplate(to, template);
  },
  async sendInteractive(to, interactive = {}) {
    registrarEnvio('interactivo', to, JSON.stringify(interactive).slice(0, 120));
    return whatsappBase.sendInteractive(to, interactive);
  },
  async sendLocation(to, location = {}) {
    registrarEnvio('ubicación', to, `${location.latitude},${location.longitude}`);
    return whatsappBase.sendLocation(to, location);
  },
};

// ------------------------------------------------------------ servidor + API
const app = await startCrmServer({
  port: PUERTO,
  host: '127.0.0.1',
  dataFile: DB_FILE,
  databaseUrl: '', // nunca Postgres
  token: TOKEN_UAT,
  quiet: !SILENCIOSO,
  // La landing local (npm run dev, puerto 5173) puede mandar leads y pedidos
  // aquí: es el otro extremo del ambiente de pruebas.
  allowedOrigin: 'http://localhost:5173',
  // Firma del webhook: la de pruebas, no la de producción.
  metaAppSecret: SECRETO_WEBHOOK,
  whatsappVerifyToken: 'verificacion-uat',
  whatsappPhoneNumber: '+18095550999',
  // Los tres clientes externos van mockeados/apagados a propósito.
  whatsapp,
  whatsappMedia,
  storage: almacen,
  metaCapi: { enabled: false, graphVersion: 'v21.0' },
  schedulerEnabled: SCHEDULER,
  adminDir: path.join(ROOT, 'public', 'admin'),
  bootstrapAdminUser: 'admin@uat.local',
  bootstrapAdminPassword: CLAVE_USUARIOS,
  bootstrapAdminDisplayName: 'Admin UAT',
});

const sesiones = {};

async function pedir(route, options = {}, quien = 'admin') {
  const cookie = sesiones[quien] ?? '';
  const respuesta = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
  const texto = await respuesta.text();
  let cuerpo = null;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  return { status: respuesta.status, ok: respuesta.ok, body: cuerpo };
}

async function entrar(quien, credenciales) {
  const respuesta = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credenciales),
  });
  if (!respuesta.ok) throw new Error(`no se pudo entrar como ${quien} (${respuesta.status})`);
  sesiones[quien] = (respuesta.headers.get('set-cookie') ?? '').split(';')[0];
}

/**
 * Entra como administrador sirviéndose de la clave de este entorno.
 *
 * Con los datos de ejemplo existe `admin@uat.local`; con una COPIA de los datos
 * reales los usuarios son los de siempre, así que se entra con la clave del panel
 * (la misma que imprime el arranque). Vale para los dos casos.
 */
async function entrarComoAdmin() {
  try {
    await entrar('admin', { username: 'admin@uat.local', password: CLAVE_USUARIOS });
    return 'usuario';
  } catch {
    await entrar('admin', { token: TOKEN_UAT });
    return 'clave';
  }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- semilla
/*
 * ¿Había datos ANTES de arrancar? Se mira aquí y no después: el servidor crea
 * el archivo (con sus tablas) nada más arrancar, así que a partir de ese momento
 * el fichero siempre "existe" y ya no se puede distinguir una base vacía recién
 * creada de una con datos.
 */
const habiaDatos = existsSync(DB_FILE) && statSync(DB_FILE).size > 0;

async function sembrar() {
  log('\n▸ Sembrando datos de prueba (clientes, pedidos, reparto, plantillas)…');
  await entrar('admin', { username: 'admin@uat.local', password: CLAVE_USUARIOS });

  // 1) Usuarios de cada rol, para probar permisos y el reparto de verdad.
  paso('Usuarios (los 4 roles)');
  for (const usuario of USUARIOS) {
    const existentes = (await pedir('/api/admin/users')).body?.users ?? [];
    if (existentes.some((row) => row.username === usuario.username)) {
      dato(usuario.username, 'ya existía');
      continue;
    }
    const creado = await pedir('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: usuario.username,
        password: CLAVE_USUARIOS,
        displayName: usuario.displayName,
        role: usuario.role,
      }),
    });
    dato(usuario.username, `${creado.status} · ${usuario.role}${creado.status === 201 ? '' : ` ${creado.body?.error ?? ''}`}`);
  }
  await entrar('agente', { username: 'agente@uat.local', password: CLAVE_USUARIOS });
  await entrar('reparto', { username: 'reparto@uat.local', password: CLAVE_USUARIOS });

  // 2) Inventario: sin stock cargado, un pedido entregado sale "INVALID" en la
  //    comprobación de integridad (falso positivo que ya existe en el producto).
  paso('Inventario');
  const inventario = await pedir('/api/admin/inventory');
  if (inventario.body?.inventory?.initialized !== true) {
    const carga = await pedir('/api/admin/inventory/restock', {
      method: 'POST',
      body: JSON.stringify({ quantity: 600, unitCost: 0, reason: 'Carga inicial del ambiente de pruebas' }),
    });
    dato('cápsulas cargadas', carga.status === 201 ? '600' : `no se pudo (${carga.status})`);
  } else {
    dato('inventario', `ya inicializado (${inventario.body.inventory.stock} cápsulas)`);
  }

  // 3) Plantillas: se siembran las oficiales y se marcan aprobadas SOLO aquí,
  //    para poder probar los flujos que Meta exige (fuera de ventana, factura,
  //    ubicación y confirmación de pedido).
  paso('Plantillas (aprobadas SOLO en esta base de pruebas)');
  await pedir('/api/admin/wa-templates');
  const APROBADAS = [
    'phyto_contacto_personalizado_v1',
    'phyto_ubicacion_entrega_v1',
    'phyto_confirmacion_pedido_v1',
    'phyto_envio_factura_v1',
    'phyto_delivery_asignado_v1',
    'phyto_envio_cotizacion_v1',
  ];
  const plantillas = (await pedir('/api/admin/wa-templates')).body?.templates ?? [];
  for (const nombre of APROBADAS) {
    const plantilla = plantillas.find((row) => row.name === nombre);
    if (!plantilla) continue;
    if (String(plantilla.status).toUpperCase() === 'APPROVED') {
      dato(nombre, 'ya aprobada');
      continue;
    }
    const marcada = await pedir('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({ name: nombre, status: 'approved', metaTemplateId: `uat_${nombre}` }),
    });
    dato(nombre, marcada.status === 200 ? 'APROBADA (solo en pruebas)' : `error ${marcada.status}`);
  }

  // 4) Clientes y conversaciones, con los casos que hacen falta para probar:
  //    ventana abierta, ventana cerrada, opt-out y ubicación compartida.
  paso('Clientes y conversaciones');
  const perfiles = [
    { nombre: 'Prueba Uno', telefono: '18095551001', ventana: 'abierta', comparteUbicacion: [18.4861, -69.9312] },
    { nombre: 'Prueba Dos', telefono: '18095551002', ventana: 'abierta' },
    { nombre: 'Prueba Tres', telefono: '18095551003', ventana: 'abierta', comparteUbicacion: [18.5601, -68.3725] },
    { nombre: 'Prueba Cuatro', telefono: '18095551004', ventana: 'abierta', comparteUbicacion: [18.4700, -69.9000] },
    { nombre: 'Prueba Cinco', telefono: '18095551005', ventana: 'abierta' },
    { nombre: 'Prueba Seis', telefono: '18095551006', ventana: 'abierta' },
    { nombre: 'Prueba Siete', telefono: '18095551007', ventana: 'abierta' },
    { nombre: 'Prueba Ocho', telefono: '18095551008', ventana: 'cerrada', comparteUbicacion: [18.6157, -68.7071] },
    { nombre: 'Prueba Nueve', telefono: '18095551009', ventana: 'abierta', optOut: true },
    { nombre: 'Prueba Diez', telefono: '18095551010', ventana: 'abierta', comparteUbicacion: [18.4200, -68.9700] },
  ];

  const clientes = {};
  for (const [indice, perfil] of perfiles.entries()) {
    const encontrado = await app.customers.findOrCreateByPhone({
      phone: perfil.telefono,
      name: perfil.nombre,
      source: 'ambiente-de-pruebas',
      optIn: !perfil.optOut,
    });
    if (!encontrado.ok) throw new Error(`teléfono inválido: ${perfil.telefono}`);
    const cliente = encontrado.customer;
    clientes[perfil.nombre] = cliente;

    const conversacion = await app.customers.conversationFor(cliente.id);
    // El mensaje del cliente: deja la ventana de 24 h ABIERTA y el hilo con vida.
    if ((await app.customers.messagesFor(conversacion.id, { limit: 5 })).length === 0) {
      await app.customers.recordInbound({
        waMessage: {
          waMessageId: `wamid.UAT-IN-${indice + 1}`,
          from: perfil.telefono,
          profileName: perfil.nombre,
          type: 'text',
          body: [
            'Hola, quiero información del frasco de 10 cápsulas.',
            'Buenas, ¿tienen delivery hoy?',
            'Hola, quiero hacer un pedido.',
            'Buenas tardes, ¿cuánto cuesta el de 30?',
          ][indice % 4],
          receivedAt: iso(ahoraMs() - minutos(5 + indice)),
        },
      });
    }
    // El cliente comparte su ubicación por WhatsApp (queda en el mapa).
    if (perfil.comparteUbicacion) {
      const yaTiene = (await app.customers.listLocations(cliente.id, { limit: 5 })).length > 0;
      if (!yaTiene) {
        await app.customers.recordInbound({
          waMessage: {
            waMessageId: `wamid.UAT-LOC-${indice + 1}`,
            from: perfil.telefono,
            profileName: perfil.nombre,
            type: 'location',
            body: null,
            location: {
              latitude: perfil.comparteUbicacion[0],
              longitude: perfil.comparteUbicacion[1],
              name: 'Casa',
              address: `Calle de ${perfil.nombre}, referencia de prueba`,
            },
            receivedAt: iso(ahoraMs() - minutos(4 + indice)),
          },
        });
      }
    }
    // Ventana CERRADA: el cliente escribió hace 30 h (solo plantillas aprobadas).
    if (perfil.ventana === 'cerrada') {
      await app.collections.update('conversations', conversacion.id, { last_inbound_at: iso(ahoraMs() - horas(30)) });
    }
    if (perfil.optOut) {
      // Pidió no recibir mensajes: cualquier envío debe quedar bloqueado.
      await app.customers.update(cliente.id, {
        do_not_contact: true,
        whatsapp_opt_out_at: iso(ahoraMs() - horas(2)),
        whatsapp_opt_in: false,
      });
    }
    dato(perfil.nombre, `${conversacion.id}${perfil.ventana === 'cerrada' ? ' · ventana CERRADA' : ''}${perfil.optOut ? ' · NO CONTACTAR' : ''}`);
  }

  const ubicacionDe = async (nombre) => {
    const filas = await app.customers.listLocations(clientes[nombre].id, { limit: 5 });
    return filas[0]?.id ?? null;
  };

  // 5) Pedidos: uno por estado del flujo real, más los casos límite.
  paso('Pedidos (un caso por estado y por situación)');
  const crearPedido = async (nombre, opciones = {}) => {
    const respuesta = await pedir('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: clientes[nombre].id,
        conversationId: opciones.conversationId,
        items: [{ variantId: opciones.variantId ?? 'capsules_10', quantity: opciones.quantity ?? 1 }],
        paymentMethod: opciones.paymentMethod ?? 'CASH',
        deliveryFee: opciones.deliveryFee ?? 0,
        deliveryLocation: opciones.locationId ?? null,
        status: opciones.status ?? 'nuevo',
        notes: opciones.notes ?? 'Pedido de ejemplo del ambiente de pruebas.',
      }),
    });
    if (respuesta.status !== 201) throw new Error(`no se pudo crear el pedido de ${nombre}: ${JSON.stringify(respuesta.body)}`);
    return respuesta.body.item.id;
  };

  const conversacionDe = async (nombre) => (await app.customers.conversationFor(clientes[nombre].id)).id;

  const pedidos = {};
  pedidos.nuevo = await crearPedido('Prueba Uno', { locationId: await ubicacionDe('Prueba Uno'), deliveryFee: 150 });
  pedidos.sinUbicacion = await crearPedido('Prueba Dos', { conversationId: await conversacionDe('Prueba Dos') });
  pedidos.confirmado = await crearPedido('Prueba Dos', { status: 'confirmado' });
  pedidos.enPreparacion = await crearPedido('Prueba Tres', {
    status: 'en_preparacion',
    locationId: await ubicacionDe('Prueba Tres'),
    deliveryFee: 200,
  });
  pedidos.asignado = await crearPedido('Prueba Cinco', {
    status: 'confirmado',
    locationId: null,
    deliveryFee: 150,
  });
  pedidos.enCamino = await crearPedido('Prueba Cuatro', {
    locationId: await ubicacionDe('Prueba Cuatro'),
    deliveryFee: 150,
  });
  pedidos.entregado = await crearPedido('Prueba Cinco', { quantity: 3, variantId: 'capsules_30', paymentMethod: 'TRANSFER' });
  pedidos.cancelado = await crearPedido('Prueba Seis', {});
  pedidos.perdido = await crearPedido('Prueba Siete', { status: 'perdido' });
  dato('creados', `nuevo, sin ubicación, confirmado, en preparación, asignado, en camino, entregado, cancelado, perdido`);

  // 6) Reparto: uno asignado y listo para "Iniciar entrega", y otro EN VIVO con
  //    puntos de GPS para ver el mapa funcionando.
  paso('Reparto');
  const repartoId = (await pedir('/api/admin/users')).body.users.find((row) => row.username === 'reparto@uat.local').id;

  const asignar = await pedir(`/api/admin/orders/${pedidos.asignado}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: repartoId }),
  });
  dato('pedido asignado al reparto', `${asignar.status} · listo para «Iniciar entrega»`);

  await pedir(`/api/admin/orders/${pedidos.enCamino}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: repartoId }),
  });
  const inicio = await pedir(`/api/admin/orders/${pedidos.enCamino}/delivery/start`, { method: 'POST', body: '{}' }, 'reparto');
  if (inicio.status === 201) {
    const sesion = inicio.body.session.id;
    const destino = inicio.body.session.destination ?? { latitude: 18.47, longitude: -69.9 };
    // Tres puntos acercándose al destino: el mapa enseña la entrega en vivo.
    for (const [indice, factor] of [1.6, 1.2, 0.7].entries()) {
      await pedir(
        `/api/admin/delivery-tracking/${sesion}/location`,
        {
          method: 'POST',
          body: JSON.stringify({
            latitude: destino.latitude + 0.01 * factor,
            longitude: destino.longitude - 0.01 * factor,
            accuracy: 12 + indice * 6,
            speed: 8,
            timestamp: new Date(ahoraMs() - minutos(6 - indice * 2)).toISOString(),
          }),
        },
        'reparto',
      );
      await esperar(20);
    }
    dato('entrega EN VIVO', `sesión ${sesion} con 3 puntos de GPS`);
  } else {
    dato('entrega EN VIVO', `no se pudo iniciar (${inicio.status} ${inicio.body?.error ?? ''})`);
  }

  // 7) Estados finales por la vía oficial (así el inventario y la postventa
  //    quedan como en la vida real, no a mano).
  paso('Cierres (entregado y cancelado por la vía oficial)');
  const entrega = await pedir(`/api/admin/orders/${pedidos.entregado}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'ENTREGADO', reason: 'Cierre de ejemplo del ambiente de pruebas' }),
  });
  dato('pedido entregado', `${entrega.status} · inventario y postventa aplicados`);
  const cancelacion = await pedir(`/api/admin/orders/${pedidos.cancelado}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'CANCELADO', reason: 'Cliente canceló: ejemplo del ambiente de pruebas' }),
  });
  dato('pedido cancelado', `${cancelacion.status}`);

  // 8) Mensajes programados: uno que sale en unos minutos (para verlo funcionar)
  //    y otro a un cliente que pidió no recibir mensajes (debe quedar BLOQUEADO).
  paso('Mensajes programados');
  const programado = await pedir('/api/admin/scheduled', {
    method: 'POST',
    body: JSON.stringify({
      customerId: clientes['Prueba Ocho'].id,
      conversationId: await conversacionDe('Prueba Ocho'),
      type: 'template',
      template: 'phyto_contacto_personalizado_v1',
      scheduledAt: iso(ahoraMs() + minutos(3)),
      // Los valores de plantilla van POR POSICIÓN del hueco (como el panel):
      // {{1}} nombre del cliente (lo pone el CRM) y {{2}} el texto (lo escribimos).
      templateValues: { 2: 'Te escribimos para retomar tu pedido de prueba.' },
      timeZone: 'America/Santo_Domingo',
    }),
  });
  dato(
    'programado (en ~3 min)',
    programado.status === 201 ? 'se enviará solo (modo mock)' : `error ${programado.status} ${programado.body?.error ?? ''} ${programado.body?.message ?? ''}`,
  );

  const bloqueado = await pedir('/api/admin/scheduled', {
    method: 'POST',
    body: JSON.stringify({
      customerId: clientes['Prueba Nueve'].id,
      conversationId: await conversacionDe('Prueba Nueve'),
      type: 'template',
      template: 'phyto_contacto_personalizado_v1',
      scheduledAt: iso(ahoraMs() + minutos(1)),
      templateValues: { 2: 'Este cliente pidió no recibir mensajes: debe quedar BLOQUEADO.' },
      timeZone: 'America/Santo_Domingo',
    }),
  });
  dato(
    'programado a cliente con opt-out',
    bloqueado.status === 201
      ? 'creado: el motor lo BLOQUEARÁ al llegar la hora (pidió no recibir mensajes)'
      : `error ${bloqueado.status} ${bloqueado.body?.error ?? ''} ${bloqueado.body?.message ?? ''}`,
  );

  return { clientes, pedidos };
}

// ------------------------------------------------------------------ resumen
async function resumen() {
  const data = await pedir('/api/admin/data');
  const items = (data.body?.items ?? []).filter((row) => row.type === 'order_intent');
  const porEstado = items.reduce((cuenta, fila) => {
    cuenta[fila.status] = (cuenta[fila.status] ?? 0) + 1;
    return cuenta;
  }, {});
  const sesionesVivas = (await pedir('/api/admin/delivery-tracking')).body?.sessions?.filter((row) => row.status === 'ACTIVE') ?? [];
  const programados = (await pedir('/api/admin/scheduled')).body?.scheduled ?? [];
  const plantillas = (await pedir('/api/admin/wa-templates')).body?.templates ?? [];
  const usuarios = (await pedir('/api/admin/users')).body?.users ?? [];

  console.log(`\n${'─'.repeat(72)}`);
  console.log(COPIAR_DATOS ? '  LISTO — sigues desarrollando con tus datos (copia local)' : '  LISTO — abre el panel y prueba lo que quieras');
  console.log('─'.repeat(72));
  console.log(`  Panel        http://127.0.0.1:${PUERTO}/admin/`);
  console.log(`  Web pública  npm run dev (en otra terminal) · apúntala aquí con`);
  console.log(`               PHYTO_CRM_PORT=${PUERTO} PHYTO_CRM_NO_AUTO=1`);
  console.log('');
  console.log(COPIAR_DATOS ? '  Entra con TUS usuarios de siempre:' : '  Usuarios (todos con la misma contraseña):');
  if (usuarios.length) {
    for (const usuario of usuarios.slice(0, 8)) {
      const nombre = String(usuario.username ?? '');
      const clave = COPIAR_DATOS && nombre === 'admin@uat.local' ? `  clave: ${CLAVE_USUARIOS}` : COPIAR_DATOS ? '' : ` clave: ${CLAVE_USUARIOS}`;
      console.log(
        `     ${nombre.padEnd(24)} ${String(usuario.role ?? '').padEnd(9)}${clave}${usuario.active === false ? ' (inactivo)' : ''}`,
      );
    }
    if (usuarios.length > 8) console.log(`     … y ${usuarios.length - 8} usuario(s) más`);
  } else {
    for (const usuario of USUARIOS) {
      console.log(`     ${usuario.username.padEnd(24)} ${usuario.role.padEnd(9)} clave: ${CLAVE_USUARIOS}`);
    }
  }
  console.log(`     clave del panel (token)  ${TOKEN_UAT}`);
  console.log('');
  console.log(COPIAR_DATOS ? '  Tus datos (copia; la original no se toca):' : '  Datos de ejemplo:');
  console.log(`     clientes         ${(data.body?.customers ?? []).length}`);
  console.log(`     pedidos          ${items.length}  ${JSON.stringify(porEstado)}`);
  console.log(`     entregas vivas   ${sesionesVivas.length}`);
  console.log(`     programados      ${programados.length}`);
  console.log(
    `     plantillas       ${plantillas.filter((row) => String(row.status).toUpperCase() === 'APPROVED').length} aprobadas`,
  );
  console.log('');
  console.log('  Qué puedes tocar (sin efectos reales):');
  console.log('     · Pedidos → abrir un pedido → botón flotante → Estado / Pasar a un delivery / Enviar factura');
  console.log('     · Mapa → las entregas que asignes aquí y, si levantas una, su GPS en vivo');
  console.log('     · WhatsApp → responder, enviar foto/nota de voz y ver los bloqueos (opt-out)');
  console.log('     · Mensajes → programados, y Ajustes → métricas y auditoría');
  console.log('');
  console.log(`  Todo lo que "se envía" queda anotado en ${path.relative(ROOT, LOG_ENVIOS)}`);
  console.log('  Código del panel: public/admin/ (se sirve tal cual: guarda y recarga).');
  if (COPIAR_DATOS) {
    console.log('  Para volver a esta misma copia sin reemplazarla:  npm run uat');
    console.log('  Ojo: `npm run dev:datos` otra vez REEMPLAZA la copia por los datos de ahora.');
  } else {
    console.log('  Reiniciar de cero:  npm run uat:reset');
  }
  console.log(`${'─'.repeat(72)}\n`);
  return { sesionesVivas };
}

// -------------------------------------------------------------- marcha y cierre
/*
 * Se siembra los datos de EJEMPLO cuando: lo pide el usuario (`--sembrar`), o la
 * base no existía, o existe pero está vacía (un intento anterior que falló a
 * medias). Con `--copiar-datos` NO se siembra nada: ya hay datos de verdad.
 */
async function haceFaltaSembrar() {
  if (COPIAR_DATOS) return false;
  if (SEMBRAR_SIEMPRE || !habiaDatos) return true;
  const data = await pedir('/api/admin/data');
  return ((data.body?.customers ?? []).length === 0 && (data.body?.items ?? []).length === 0);
}

/*
 * COTIZACIONES DE PRUEBA.
 *
 * La pantalla de cotizaciones se prueba con datos de verdad: seis cotizaciones
 * con clientes, importes y descuentos distintos, y UNA ya facturada, para poder
 * ver los dos estados del filtro. Se crean por la API (la misma que usa el
 * panel), así que el total lo calcula el servidor: nada se escribe a mano en la
 * base. Es idempotente: si ya hay cotizaciones, no toca nada.
 */
async function sembrarCotizaciones() {
  if (COPIAR_DATOS) return;
  const existentes = await pedir('/api/admin/pos/quotes');
  const ya = (existentes.body?.quotes ?? []).length;
  if (ya > 0) {
    log(`\n▸ Cotizaciones: ya hay ${ya} en esta base (no se siembran más).`);
    return;
  }
  const catalogo = (await pedir('/api/admin/store/products')).body?.products ?? [];
  const productos = catalogo.filter((row) => row.active !== false && Number.isInteger(row.price_cents));
  const clientes = (await pedir('/api/admin/pos/customers')).body?.customers ?? [];
  if (!productos.length || !clientes.length) {
    log('\n▸ Cotizaciones: faltan productos o clientes en esta base; no se siembran.');
    return;
  }

  log('\n▸ Sembrando cotizaciones de prueba (lista, filtros, detalle y PDF)…');
  paso('Cotizaciones');
  // Cada línea es [índice de producto, cantidad]; los índices se reparten sobre
  // lo que haya en el catálogo, así que la semilla no depende de los IDs.
  const plan = [
    { cliente: 0, lineas: [[0, 1]], envio: 250, descuento: null, nota: 'Pidió precio para 1 frasco; confirma el lunes.', convertir: true },
    { cliente: 1, lineas: [[1, 2]], envio: 0, descuento: { type: 'percent', value: 10 }, nota: 'Se le ofreció 10% si cierra esta semana.' },
    { cliente: 2, lineas: [[2, 1], [0, 1]], envio: 0, descuento: null, nota: '' },
    { cliente: 3, lineas: [[0, 3]], envio: 150, descuento: null, nota: 'Envío a Santiago; se cobra al recibir.' },
    { cliente: 4, lineas: [[2, 1]], envio: 0, descuento: { type: 'amount', value: 300 }, nota: '' },
    { cliente: 5, lineas: [[1, 1], [2, 1]], envio: 350, descuento: null, nota: 'Reposición mensual.' },
  ];

  for (const [indice, fila] of plan.entries()) {
    const cliente = clientes[fila.cliente % clientes.length];
    const items = fila.lineas.map(([posicion, cantidad]) => ({
      variantId: productos[posicion % productos.length].id,
      quantity: cantidad,
      discount: {},
    }));
    const descuento = fila.descuento ?? {};
    // El total lo calcula la MISMA función que el panel y el servidor.
    const venta = calculateSale(items, productos, descuento, fila.envio);
    const creada = await pedir('/api/admin/pos/quotes', {
      method: 'POST',
      body: JSON.stringify({
        requestId: randomBytes(12).toString('hex'),
        customerId: cliente.id,
        items,
        discount: descuento,
        deliveryFee: fila.envio,
        expectedTotal: venta.total_cents,
        paymentMethod: 'CASH',
        notes: fila.nota,
      }),
    });
    const id = creada.body?.document?.id ?? creada.body?.quoteId ?? null;
    dato(`${creada.body?.document?.number ?? `cotización ${indice + 1}`} · ${cliente.name}`, creada.ok ? `${venta.total_cents} céntimos` : `error ${creada.status} ${creada.body?.message ?? ''}`);
    if (!fila.convertir || !id) continue;
    // Una cotización se lleva a factura: así el filtro «Facturadas» tiene algo.
    const factura = await pedir('/api/admin/pos/checkout', {
      method: 'POST',
      body: JSON.stringify({
        quoteId: id,
        customerId: cliente.id,
        mode: 'invoice',
        items,
        discount: descuento,
        deliveryFee: fila.envio,
        expectedTotal: venta.total_cents,
        paymentMethod: 'CASH',
        notes: fila.nota,
        acknowledgeOpen: true,
        requestId: randomBytes(12).toString('hex'),
      }),
    });
    dato('una cotización pasada a factura', factura.ok ? `pedido ${factura.body?.number ?? ''}` : `no se pudo (${factura.status} ${factura.body?.message ?? ''})`);
  }
}


if (await haceFaltaSembrar()) {
  await sembrar();
} else {
  await entrarComoAdmin();
  if (!COPIAR_DATOS) {
    log('\n▸ Ya había datos: no se vuelve a sembrar (usa `npm run uat:reset` para empezar de cero).');
  }
}
await sembrarCotizaciones();
await resumen();

let cerrando = false;
async function cerrar() {
  if (cerrando) return;
  cerrando = true;
  console.log('\nCerrando el ambiente de pruebas…');
  try {
    await app.close();
  } finally {
    console.log('Listo. Los datos quedan guardados en data/uat/ (no se toca producción).');
    process.exit(0);
  }
}

process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);

/*
 * `--solo-sembrar`: deja los datos preparados y sale. Sirve para verificar la
 * siembra en un script o para preparar la base antes de arrancar el servidor.
 */
if (SOLO_SEMBRAR) {
  await cerrar();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (entrada) => {
  const orden = String(entrada).trim().toLowerCase();
  if (orden === 'q') cerrar();
  if (orden === 'r') console.log('Para reiniciar de cero: Ctrl+C y `npm run uat:reset`.');
});
