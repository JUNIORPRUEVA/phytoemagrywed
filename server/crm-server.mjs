/**
 * ============================================================================
 *  API del CRM + panel de administración (PWA).
 *
 *  Público (lo usa la web):
 *    POST /api/crm                  → guarda un `lead` o un `order_intent`
 *    GET  /api/health               → estado (sin datos personales)
 *
 *  Panel (lo usa el negocio, con sesión):
 *    GET  /admin/                   → la app instalable (PWA)
 *    POST /api/admin/login          → cambia la clave por una cookie de sesión
 *    POST /api/admin/logout
 *    GET  /api/admin/data           → items + clientes + seguimientos (una petición)
 *    PATCH /api/admin/items/:id     → estado, notas y recordatorio
 *    POST/DELETE /api/admin/messages[/:id] → plantillas de WhatsApp
 *
 *  Clientes, conversaciones y seguimiento (panel):
 *    GET  /api/admin/customers              → lista/búsqueda de clientes
 *    GET  /api/admin/customers/:id          → perfil 360 (compras + chat + seguimiento)
 *    PATCH /api/admin/customers/:id         → notas y datos del cliente
 *    POST /api/admin/customers/:id/opt-out|opt-in|automation
 *    POST /api/admin/purchases              → registrar una compra (a mano)
 *    GET  /api/admin/conversations          → bandeja de WhatsApp
 *    GET  /api/admin/conversations/:id/messages
 *    POST /api/admin/conversations/:id/messages  → enviar (con una persona delante)
 *    POST /api/admin/conversations/:id/read
 *    GET|POST|PATCH /api/admin/followups[/:id]   → plan y decisiones del día
 *    GET  /api/admin/wa-templates           → plantillas oficiales de Meta
 *    GET  /api/admin/metrics                → números del negocio
 *
 *  WhatsApp (lo llama Meta, sin sesión):
 *    GET  /api/webhooks/whatsapp            → verificación (hub.challenge)
 *    POST /api/webhooks/whatsapp            → mensajes y estados entrantes
 *
 *  Compatibilidad (curl, enlaces antiguos): `/api/crm/items?token=…`,
 *  `/api/crm/export.csv?token=…` y `/panel?token=…` siguen funcionando.
 *
 *  Variables de entorno:
 *    PHYTO_CRM_DATABASE_URL  Postgres (recomendado) · si no, SQLite · si no, JSONL
 *    PHYTO_CRM_DATA          archivo de SQLite/JSONL
 *    PHYTO_CRM_TOKEN         clave del panel (obligatoria para administrar)
 *    PHYTO_CRM_PORT/HOST     puerto e interfaz (por defecto 8787 / 127.0.0.1)
 *    PHYTO_ADMIN_DIR         carpeta de la app del panel (por defecto: dist/admin)
 *    PHYTO_CRM_ALLOWED_ORIGIN  CORS, solo si la web vive en otro dominio
 *    PHYTO_CRM_TZ            zona horaria del negocio (por defecto America/Santo_Domingo)
 *
 *  Meta (ver docs/META_INTEGRATION.md):
 *    PHYTO_META_PIXEL_ID              ID del píxel/dataset (público)
 *    PHYTO_META_CAPI_ACCESS_TOKEN     token de la API de conversiones (SECRETO)
 *    PHYTO_META_CAPI_TEST_EVENT_CODE  solo UAT; en `APP_ENV=production` se ignora
 *    PHYTO_META_GRAPH_VERSION         versión de la Graph API (por defecto v21.0)
 *    PHYTO_META_PURCHASE_STATUS       estado que representa una VENTA (por defecto `entregado`)
 *
 *  WhatsApp Cloud API (ver docs/WHATSAPP_INTEGRATION.md):
 *    META_APP_ID                    ID de la app de Meta (webhook)
 *    META_APP_SECRET                clave de la app: valida la FIRMA del webhook (SECRETO)
 *    WHATSAPP_BUSINESS_ACCOUNT_ID   cuenta de WhatsApp Business (WABA)
 *    WHATSAPP_PHONE_NUMBER_ID       ID del número que envía
 *    WHATSAPP_PHONE_NUMBER          número visible (público)
 *    WHATSAPP_ACCESS_TOKEN          token de envío (SECRETO)
 *    WHATSAPP_VERIFY_TOKEN          secreto de la verificación del webhook (SECRETO)
 *    WHATSAPP_WEBHOOK_URL           URL pública del webhook
 *    PHYTO_FOLLOWUP_PLAN            plan de seguimiento en JSON (días configurables)
 *    PHYTO_DAILY_CAPSULES           cápsulas por día (por defecto 1, el uso aprobado)
 *
 *  Seguimiento: el servidor CREA Y FECHA las tareas; NUNCA envía solo porque
 *  llegó la fecha. El envío siempre lo pulsa una persona desde el panel.
 *
 *  Documentación: docs/CRM-CONTRACT.md, docs/PANEL.md, docs/META_INTEGRATION.md
 *  y docs/WHATSAPP_INTEGRATION.md
 * ============================================================================
 */

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildUserData, createMetaCapi } from './meta-capi.mjs';
import { createCollections } from './collections.mjs';
import { createCustomerService, AUTOMATION_STATES } from './customers.mjs';
import { createFollowupEngine, resolveDailyCapsules, resolvePlan } from './followups.mjs';
import {
  createWhatsAppClient,
  parseWebhook,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} from './whatsapp.mjs';
import { productConfig } from '../src/config/product.config.js';
import {
  CLOSED_STATUSES,
  STATUSES,
  computeStats,
  createStore,
  day,
  dueToday,
  longText,
  messageId,
  text,
} from './stores.mjs';

const PORT = Number.parseInt(process.env.PHYTO_CRM_PORT ?? '8787', 10);
const HOST = process.env.PHYTO_CRM_HOST ?? '127.0.0.1';
const DATA_FILE = path.resolve(process.env.PHYTO_CRM_DATA ?? path.join('data', 'phytoemagry.sqlite'));
const DATABASE_URL = (process.env.PHYTO_CRM_DATABASE_URL ?? '').trim();
const TOKEN = (process.env.PHYTO_CRM_TOKEN ?? '').trim();
const ALLOWED_ORIGIN = (process.env.PHYTO_CRM_ALLOWED_ORIGIN ?? '').trim();
const TIME_ZONE = (process.env.PHYTO_CRM_TZ ?? 'America/Santo_Domingo').trim();

// ------------------------------------------------------------------- Meta CAPI
/** ID del píxel/dataset. Es público (el navegador lo lleva en el HTML). */
const META_PIXEL_ID = (process.env.PHYTO_META_PIXEL_ID ?? '').trim();
/** Token de la API de conversiones: SECRETO. Solo vive en el servidor. */
const META_CAPI_TOKEN = (process.env.PHYTO_META_CAPI_ACCESS_TOKEN ?? '').trim();
/** Código de eventos de prueba: solo UAT (en producción se ignora). */
const META_TEST_EVENT_CODE = (process.env.PHYTO_META_CAPI_TEST_EVENT_CODE ?? '').trim();
const META_GRAPH_VERSION = (process.env.PHYTO_META_GRAPH_VERSION ?? '').trim();
const APP_ENV = (process.env.APP_ENV ?? 'production').trim();
/**
 * Estado del CRM que representa una VENTA REAL (dinero cobrado).
 *
 * `entregado` es el único que cierra el pedido con cobro: `confirmado` todavía
 * puede caerse (el cliente se arrepiente y no recibe). Si el negocio prefiere
 * otro criterio, se cambia con una variable, sin tocar código.
 */
const META_PURCHASE_STATUS = (process.env.PHYTO_META_PURCHASE_STATUS ?? 'entregado').trim();
/** Reintentos automáticos por venta (evita reintentos infinitos). */
const META_PURCHASE_MAX_ATTEMPTS = 5;

// ------------------------------------------------------ WhatsApp Cloud API
/** ID de la app de Meta (no es secreto). */
const META_APP_ID = (process.env.META_APP_ID ?? '').trim();
/** Clave de la app: valida la firma del webhook. SECRETO. */
const META_APP_SECRET = (process.env.META_APP_SECRET ?? '').trim();
const WHATSAPP_BUSINESS_ACCOUNT_ID = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '').trim();
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
/** Número visible del negocio (público: el panel lo muestra para llamar). */
const WHATSAPP_PHONE_NUMBER = (process.env.WHATSAPP_PHONE_NUMBER ?? '').trim();
/** Token de envío. SECRETO. */
const WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
/** Secreto de la verificación del webhook (`hub.verify_token`). SECRETO. */
const WHATSAPP_VERIFY_TOKEN = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();
const WHATSAPP_WEBHOOK_URL = (process.env.WHATSAPP_WEBHOOK_URL ?? '').trim();
/** Versión de la Graph API: la misma que Meta, salvo que se fije otra. */
const WHATSAPP_GRAPH_VERSION = (process.env.WHATSAPP_GRAPH_VERSION ?? '').trim() || META_GRAPH_VERSION;
/** Cápsulas por día: 1 es el uso aprobado del producto. */
const DAILY_CAPSULES = resolveDailyCapsules(productConfig.usage, (process.env.PHYTO_DAILY_CAPSULES ?? '').trim());
/** Plan de seguimiento (días configurables sin tocar código). */
const FOLLOWUP_PLAN = resolvePlan(process.env.PHYTO_FOLLOWUP_PLAN);

/** Busca una variante del catálogo oficial por id (única fuente de precios). */
function findVariant(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return productConfig.variants.find((variant) => variant.id === key) ?? null;
}

/**
 * Carpeta de la app del panel. Se resuelve al arrancar (no al importar) para
 * poder apuntarla desde los tests o desde otro directorio con `PHYTO_ADMIN_DIR`.
 */
function resolveAdminDir(configured) {
  if (configured) return path.resolve(configured);
  if (process.env.PHYTO_ADMIN_DIR) return path.resolve(process.env.PHYTO_ADMIN_DIR);
  const built = path.join(process.cwd(), 'dist', 'admin');
  return existsSync(built) ? built : path.join(process.cwd(), 'public', 'admin');
}

/** Tamaño máximo del cuerpo aceptado (un pedido ocupa ~1 kB). */
const MAX_BODY_BYTES = 64 * 1024;
/** Tipos de registro que acepta la web (ver src/lib/api.js). */
const TYPES = new Set(['lead', 'order_intent']);
/** Duración de la sesión del panel (90 días: se instala y no se vuelve a pedir). */
const SESSION_SECONDS = 90 * 24 * 60 * 60;
const COOKIE = 'pe_crm';

const STATUS_LABELS = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  confirmado: 'Confirmado',
  entregado: 'Entregado',
  perdido: 'Perdido',
};

// ------------------------------------------------------------------ utilidades

/** ¿La clave recibida es la configurada? Comparación en tiempo constante. */
function tokenOk(candidate, expectedToken) {
  if (!expectedToken || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function cors(res, allowedOrigin) {
  if (!allowedOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-crm-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

/** Lee el cuerpo con tope de tamaño. @returns {Promise<any>} */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
  });
}

/**
 * Lee el cuerpo SIN convertirlo: la firma HMAC de Meta se calcula sobre los
 * bytes exactos que envió, así que no se puede recomponer desde el JSON.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{raw: string, json: any}>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      resolve({ raw, json: parsed });
    });
  });
}

/**
 * Convierte el payload de la web (ver docs/CRM-CONTRACT.md) en una fila.
 * No rechaza campos desconocidos: se guarda el payload completo.
 */
function toRow(payload) {
  const type = text(payload.type, 40);
  if (!TYPES.has(type)) {
    const error = /** @type {any} */ (new Error('invalid_type'));
    error.status = 422;
    throw error;
  }
  const customer = payload.customer ?? {};
  const number = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null);

  return {
    id: text(payload.id, 80) ?? randomBytes(16).toString('hex'),
    type,
    receivedAt: text(payload.createdAt, 40) ?? new Date().toISOString(),
    name: text(payload.name, 120) ?? text(customer.name, 120),
    phone: text(payload.phone, 40) ?? text(customer.phone, 40),
    location: text(payload.location, 120) ?? text(customer.location, 120),
    variantId: text(payload.variantId, 60),
    variantName: text(payload.variantName, 60) ?? text(payload.product?.presentation, 60),
    capsules: number(payload.capsules),
    quantity: number(payload.quantity),
    unitPrice: number(payload.unitPrice),
    total: number(payload.total),
    currency: text(payload.currency, 8) ?? text(payload.product?.currency, 8),
    source: text(payload.source, 40),
    sessionId: text(payload.sessionId, 80),
    payload: JSON.stringify(payload),
  };
}

/**
 * Fila de una COMPRA registrada a mano desde el panel.
 *
 * El precio sale del catálogo oficial (`product.config.js`): el panel elige el
 * frasco y la cantidad, no inventa importes. Si el negocio quiere un precio
 * distinto para ese pedido, puede escribirlo y se respeta.
 *
 * @param {any} input
 */
function purchaseRow(input) {
  const variant = findVariant(input.variantId);
  if (!variant) {
    const error = /** @type {any} */ (new Error('invalid_variant'));
    error.status = 422;
    throw error;
  }
  const requestedQuantity = Number(input.quantity);
  const quantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0 ? Math.trunc(requestedQuantity) : 1;
  const requestedPrice = Number(input.unitPrice);
  const unitPrice =
    Number.isFinite(requestedPrice) && requestedPrice >= 0 ? Math.trunc(requestedPrice) : variant.price;
  const requestedTotal = Number(input.total);
  const total = Number.isFinite(requestedTotal) && requestedTotal >= 0 ? Math.trunc(requestedTotal) : unitPrice * quantity;
  const id = text(input.id, 80) ?? randomBytes(16).toString('hex');
  const createdAt = text(input.date, 40) ?? new Date().toISOString();
  const variantName = text(input.variantName, 60) ?? `${variant.capsules} cápsulas`;
  const payload = {
    type: 'order_intent',
    id,
    createdAt,
    source: 'manual',
    channel: 'manual',
    recordedBy: text(input.recordedBy, 60) ?? 'panel',
    name: text(input.name, 120),
    phone: text(input.phone, 40),
    location: text(input.location, 120),
    variantId: variant.id,
    variantName,
    capsules: variant.capsules,
    quantity,
    unitPrice,
    total,
    currency: text(input.currency, 8) ?? 'DOP',
    customerId: text(input.customerId, 80),
    notes: longText(input.notes, 2000),
    meta: { source: 'manual', recordedBy: text(input.recordedBy, 60) ?? 'panel' },
  };
  return {
    row: {
      id,
      type: 'order_intent',
      receivedAt: createdAt,
      name: payload.name,
      phone: payload.phone,
      location: payload.location,
      variantId: variant.id,
      variantName,
      capsules: variant.capsules,
      quantity,
      unitPrice,
      total,
      currency: payload.currency,
      source: 'manual',
      sessionId: null,
      customerId: payload.customerId,
      payload: JSON.stringify(payload),
    },
    payload,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  return /[",;\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function typeLabel(type) {
  return type === 'order_intent' ? 'Pedido' : 'Contacto';
}

// ------------------------------------------------------------------ Meta CAPI

/**
 * El payload guardado es un JSON en texto. Se lee sin romper si viene mal.
 * @param {any} item
 */
function parsePayload(item) {
  try {
    if (typeof item?.payload === 'string') return JSON.parse(item.payload);
    return item?.payload ?? {};
  } catch {
    return {};
  }
}

/**
 * `event_id` de la venta. Es el MISMO para siempre: si se reintenta, Meta
 * deduplica en lugar de contar dos compras.
 * @param {any} item
 */
export function purchaseEventId(item) {
  if (item?.meta_purchase_event_id) return item.meta_purchase_event_id;
  return `purchase_${item?.id ?? 'sin-id'}`;
}

/**
 * Manda la venta a Meta y deja el resultado escrito EN LA FILA del pedido.
 *
 * Devuelve `{ ok, skipped?, error? }` y nunca lanza: un problema con Meta no
 * puede tumbar el CRM ni deshacer el estado que marcó el negocio.
 *
 * @param {object} input
 * @param {any} input.store
 * @param {any} input.metaCapi
 * @param {any} input.item
 * @param {string} [input.source] motivo (diagnóstico)
 */
export async function sendPurchaseToMeta({ store, metaCapi, item, source = 'estado' }) {
  if (!metaCapi?.enabled) return { ok: false, skipped: true, reason: 'not_configured' };
  // Idempotencia: si ya se envió, no se vuelve a enviar jamás.
  if (item.meta_purchase_sent_at) return { ok: false, skipped: true, reason: 'already_sent' };

  const eventId = purchaseEventId(item);
  const payload = parsePayload(item);
  const attribution = payload.attribution ?? {};
  const attempts = Number(item.meta_purchase_attempts ?? 0);
  const result = await metaCapi.sendPurchase({
    eventId,
    orderId: item.id,
    value: Number(item.total ?? payload.total ?? 0),
    currency: item.currency ?? payload.currency ?? 'DOP',
    eventSourceUrl: payload.meta?.sourceUrl ?? null,
    contentIds: [item.variant_id ?? payload.variantId].filter(Boolean),
    contents: item.variant_id
      ? [{ id: item.variant_id, quantity: Number(item.quantity ?? 1), item_price: Number(item.unit_price ?? 0) }]
      : undefined,
    userData: buildUserData({
      payload,
      phone: item.phone,
      name: item.name,
      externalId: item.session_id ?? item.id,
    }),
  });

  const updated = await store.update(item.id, {
    metaPurchaseEventId: eventId,
    metaPurchaseStatus: result.ok ? 'sent' : 'failed',
    metaPurchaseAttempts: attempts + 1,
    metaPurchaseSentAt: result.ok ? new Date().toISOString() : item.meta_purchase_sent_at ?? null,
    metaPurchaseError: result.ok ? null : describeMetaFailure(result),
  });

  const tag = result.ok ? 'enviada' : result.skipped ? 'no configurada' : 'falló';
  console.log(
    `[crm] venta a Meta (${source}): ${tag}${item.id ? ` · pedido ${item.id}` : ''}` +
      (result.ok || result.skipped ? '' : ` · ${describeMetaFailure(result)}`),
  );
  return { ...result, item: updated };
}

/**
 * Texto corto y sin secretos para guardar en la fila (nunca el token).
 * @param {any} result
 */
function describeMetaFailure(result) {
  if (!result?.error) return 'error desconocido';
  const { status, code, type, message } = result.error;
  return [status ? `HTTP ${status}` : null, code ? `code ${code}` : null, type, message]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 300);
}

/**
 * Reintenta las ventas que quedaron pendientes (caída de Meta, reinicio…).
 *
 * Se ejecuta al arrancar, con un tope de intentos por venta: no hay bucles
 * infinitos y nunca reenvía algo que ya se envió.
 */
async function retryPendingPurchases(store, metaCapi, log = console.log) {
  if (!metaCapi?.enabled || !store?.listAdmin) return;
  const items = await store.listAdmin({ limit: 200 });
  const pending = items.filter(
    (item) =>
      item.type === 'order_intent' &&
      item.status === META_PURCHASE_STATUS &&
      !item.meta_purchase_sent_at &&
      Number(item.meta_purchase_attempts ?? 0) < META_PURCHASE_MAX_ATTEMPTS,
  );
  if (pending.length === 0) return;
  log(`[crm] Meta: reintentando ${pending.length} venta(s) pendiente(s)`);
  for (const item of pending.slice(0, 10)) {
    await sendPurchaseToMeta({ store, metaCapi, item, source: 'reintento' });
  }
}

/**
 * Al arrancar: cada venta ENTREGADA debe tener su plan de seguimiento.
 *
 * Es idempotente (las tareas llevan clave propia), así que se puede ejecutar
 * siempre: repara el historial después de un reinicio y no duplica nada.
 */
async function ensureFollowupsForDelivered(ctx, log = console.log) {
  const items = await ctx.store.listAdmin({ limit: 200 });
  const delivered = items.filter(
    (item) => item.type === 'order_intent' && item.status === ctx.purchaseStatus && item.customer_id,
  );
  if (delivered.length === 0) return 0;
  let created = 0;
  for (const item of delivered.slice(0, 50)) {
    const result = await ctx.followups.scheduleForPurchase({
      customerId: item.customer_id,
      purchaseId: item.id,
      deliveredAt: item.received_at,
      capsules: item.capsules,
      quantity: item.quantity,
    });
    created += result.created.length;
  }
  if (created > 0) log(`[crm] seguimiento: ${created} tarea(s) creadas para ventas entregadas anteriores`);
  return created;
}

// ------------------------------------------- clientes · seguimiento · WhatsApp

/**
 * Plantillas oficiales de WhatsApp: nombres, categoría y variables.
 *
 * NINGUNA nace "aprobada": en Meta las aprueba una persona. Hasta que no estén
 * aprobadas, el panel no deja enviarlas. Así no se promete al cliente algo que
 * WhatsApp todavía no permite (y no se come el error 132001 de Meta).
 */
const WA_TEMPLATE_SEED = [
  {
    name: 'phyto_purchase_thanks',
    category: 'UTILITY',
    language: 'es',
    body: 'Gracias por tu compra. Si tienes alguna duda sobre cómo usarlo, respóndenos por aquí.',
    variables: [],
    buttons: [],
  },
  {
    name: 'phyto_followup_checkin',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, ¿cómo te ha ido con tu pedido? Si necesitas algo, escríbenos por aquí.',
    variables: ['nombre'],
    buttons: [],
  },
  {
    name: 'phyto_weekly_education',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te compartimos información aprobada sobre el producto y su forma de uso.',
    variables: ['nombre'],
    buttons: [],
  },
  {
    name: 'phyto_reorder_reminder',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, por si te sirve: se acerca el final de tu frasco. ¿Te ayudamos con el siguiente?',
    variables: ['nombre'],
    buttons: [],
  },
];

/**
 * Plantillas del plan + las guardadas en la base de datos, sin duplicar nombres.
 * Las nuevas se registran como `pending_approval` (la verdad de Meta manda).
 */
async function listWaTemplates(ctx) {
  const stored = await ctx.db.list('wa_templates', { limit: 200 });
  const known = new Map(stored.map((row) => [row.name, row]));
  /** @type {any[]} */
  const out = [];
  for (const seed of WA_TEMPLATE_SEED) {
    const existing = known.get(seed.name);
    if (existing) {
      out.push(existing);
      continue;
    }
    const doc = {
      id: `tpl_${seed.name}`,
      name: seed.name,
      category: seed.category,
      language: seed.language,
      body: seed.body,
      variables: seed.variables,
      buttons: seed.buttons ?? [],
      status: 'pending_approval',
      sendable: false,
      // Datos que solo puede rellenar Meta cuando la plantilla se registre allí.
      meta_template_id: null,
      last_synced_at: null,
      source: 'crm',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await ctx.db.insert('wa_templates', doc);
    out.push(doc);
  }
  for (const row of stored) if (!out.some((entry) => entry.name === row.name)) out.push(row);
  return out;
}

/** Solo una plantilla APROBADA en Meta se puede enviar. */
async function approvedTemplate(ctx, name) {
  const templates = await listWaTemplates(ctx);
  const found = templates.find((row) => row.name === name) ?? null;
  if (!found) return { ok: false, reason: 'unknown_template' };
  if (found.status !== 'approved') return { ok: false, reason: 'template_not_approved', template: found };
  return { ok: true, template: found };
}

/**
 * Efectos de una compra ENTREGADA (una sola vez por pedido):
 *   1. se le cuenta la venta a Meta (si está configurado),
 *   2. se recalculan los totales del cliente,
 *   3. se crea su plan de seguimiento con fechas.
 *
 * Todo idempotente. Y nada de esto ENVÍA: solo deja tareas preparadas para que
 * una persona decida cuándo escribir.
 *
 * @param {any} ctx
 * @param {any} item
 */
export async function afterPurchaseDelivered(ctx, item) {
  /** @type {{meta: any, totals: any, followups: any, nextFollowupAt: string|null}} */
  const result = { meta: null, totals: null, followups: null, nextFollowupAt: null };
  if (ctx.metaCapi?.enabled && !item.meta_purchase_sent_at) {
    result.meta = await sendPurchaseToMeta({ store: ctx.store, metaCapi: ctx.metaCapi, item, source: 'estado' });
  }
  const customerId = item.customer_id ?? null;
  if (!customerId) return result; // pedido sin cliente enlazado (llegó sin teléfono)
  const refreshed = await ctx.customers.refreshTotals(customerId);
  result.totals = refreshed.totals;
  const schedule = await ctx.followups.scheduleForPurchase({
    customerId,
    purchaseId: item.id,
    deliveredAt: item.received_at,
    capsules: item.capsules,
    quantity: item.quantity,
  });
  const next = await ctx.followups.nextForCustomer(customerId);
  result.followups = {
    created: schedule.created.length,
    supply: schedule.supply,
    nextReorderAt: schedule.nextReorderAt,
  };
  result.nextFollowupAt = next?.scheduled_at ?? null;
  await ctx.customers.update(customerId, { next_followup_at: result.nextFollowupAt });
  console.log(
    `[crm] venta entregada ${item.id}: ${schedule.created.length} tarea(s) de seguimiento para ${customerId}`,
  );
  return result;
}

/** Busca una conversación por id (el negocio maneja un puñado, no millones). */
async function findConversation(ctx, id) {
  const rows = await ctx.db.list('conversations', { limit: 1000 });
  return rows.find((row) => row.id === id) ?? null;
}

/** Añade el cliente a cada tarea: la pantalla HOY dice a QUIÉN atender. */
function withCustomer(rows, customers) {
  const byId = new Map(customers.map((row) => [row.id, row]));
  return rows.map((row) => {
    const customer = byId.get(row.customer_id) ?? null;
    return {
      ...row,
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            phone_e164: customer.phone_e164,
            do_not_contact: customer.do_not_contact === true,
            automation_state: customer.automation_state,
          }
        : null,
    };
  });
}

/**
 * Procesa lo que llegó por el webhook: mensajes entrantes y estados de salientes.
 *
 * Idempotente de punta a punta: Meta reintenta webhooks, y un reintento no puede
 * crear un segundo mensaje, ni duplicar un cliente, ni volver a contar un estado.
 *
 * @param {any} ctx
 * @param {any} body
 */
export async function processWebhookPayload(ctx, body) {
  const parsed = parseWebhook(body);
  /** @type {any[]} */
  const stored = [];
  for (const inbound of parsed.messages) {
    const result = await ctx.customers.recordInbound({ waMessage: inbound });
    if (result.duplicate) continue;
    stored.push(result);
    const who = result.customer?.name ?? result.customer?.phone_e164 ?? inbound.fromE164;
    console.log(
      `[crm] WhatsApp entrante de ${who} · intención ${result.intent}` +
        (result.optOut ? ' · pidió NO CONTACTAR' : '') +
        (result.cancelledFollowups ? ` · ${result.cancelledFollowups} seguimiento(s) cancelado(s)` : ''),
    );
    if (result.humanRequired) console.log('[crm] esa conversación queda para una persona (no es una pregunta simple)');
  }
  /** @type {string[]} */
  const updated = [];
  for (const status of parsed.statuses) {
    if (!status.waMessageId || !status.status) continue;
    const result = await ctx.customers.updateMessageStatus(status);
    if (result.ok) updated.push(status.status);
  }
  return {
    messages: parsed.messages.length,
    statuses: parsed.statuses.length,
    ignored: parsed.unknown,
    stored,
    updated,
  };
}

/** IP del visitante (detrás de nginx llega en `x-forwarded-for`). */
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || null;
}

/**
 * Espejo server-side del `Lead` del navegador.
 *
 * Usa el `event_id` que mandó la landing (mismo identificador → Meta deduplica
 * las dos copias). Si el payload no lo trae (JS desactivado, cliente antiguo),
 * se genera uno estable a partir del registro: nunca se manda dos veces lo mismo.
 *
 * @param {any} ctx
 * @param {any} row
 * @param {import('node:http').IncomingMessage} req
 */
function mirrorLeadToMeta(ctx, row, req) {
  const capi = ctx?.metaCapi;
  if (!capi?.enabled) return;
  const payload = parsePayload({ payload: row.payload });
  const events = payload.meta?.events ?? {};
  const eventId = typeof events.lead === 'string' && events.lead ? events.lead : `lead_${row.id}`;
  const userData = buildUserData({
    payload,
    phone: row.phone,
    name: row.name,
    externalId: row.sessionId ?? row.id,
    ip: clientIp(req),
    userAgent: row.payload ? String(req.headers['user-agent'] ?? '') || null : null,
  });
  capi
    .send({
      eventName: 'Lead',
      eventId,
      eventSourceUrl: payload.meta?.sourceUrl ?? null,
      userData,
      customData: {
        ...(row.variantName ? { content_name: row.variantName } : {}),
        ...(row.currency ? { currency: row.currency } : {}),
      },
    })
    .then((result) => {
      if (!result.ok && !result.skipped) {
        console.log(`[crm] lead a Meta: falló · ${describeMetaFailure(result)}`);
      }
    })
    .catch(() => {
      /* Nunca puede afectar al guardado: el registro ya está a salvo. */
    });
}

// ------------------------------------------------------------------ sesiones

/*
 * Sesión sin estado en el servidor: la cookie lleva la caducidad y una firma
 * HMAC hecha con la propia clave del panel. Así no hay tabla de sesiones, aguanta
 * un reinicio y, si cambias PHYTO_CRM_TOKEN, todas las sesiones dejan de valer.
 */
function signSession(expiresAt, secret) {
  return createHmac('sha256', secret).update(`admin:${expiresAt}`).digest('base64url');
}

function createSessionValue(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${expiresAt}.${signSession(expiresAt, secret)}`;
}

function sessionValid(value, secret) {
  if (!secret || typeof value !== 'string') return false;
  const [rawExpires, signature] = value.split('.');
  const expiresAt = Number.parseInt(rawExpires ?? '', 10);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  return tokenOk(signature, signSession(expiresAt, secret));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isSecureRequest(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, value) {
  const attributes = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  attributes.push(value ? `Max-Age=${SESSION_SECONDS}` : 'Max-Age=0');
  if (isSecureRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

/** Límite de intentos de clave por IP: frena la fuerza bruta sin molestar. */
const loginAttempts = new Map();

function loginAllowed(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || entry.until < Date.now()) return true;
  return entry.count < 10;
}

function registerLoginFailure(ip) {
  const entry = loginAttempts.get(ip) ?? { count: 0, until: 0 };
  loginAttempts.set(ip, { count: entry.count + 1, until: Date.now() + 15 * 60 * 1000 });
}

// ------------------------------------------------------------------ estáticos

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sirve un archivo de la app del panel (sin poder salir de su carpeta). */
function serveAdminFile(res, urlPath, adminDir) {
  const relative = urlPath.replace(/^\/admin\/?/, '') || 'index.html';
  const target = path.resolve(adminDir, relative);
  if (!target.startsWith(adminDir) || !existsSync(target) || !statSync(target).isFile()) {
    json(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
    // El panel y su service worker nunca se cachean: publicar = ver el cambio ya.
    'cache-control': 'no-cache, must-revalidate',
    'service-worker-allowed': '/admin/',
    'x-robots-tag': 'noindex, nofollow',
  });
  res.end(body);
}

// -------------------------------------------------------------------- rutas

async function handle(req, res, ctx) {
  const { store, token } = ctx;
  cors(res, ctx.allowedOrigin);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // --------------------------------------------------------------- público
  if (route === '/api/health') {
    json(res, 200, { ok: true, storage: store.kind, items: await store.count() });
    return;
  }

  // ------------------------------------------------------ webhook de WhatsApp
  /*
   * Verificación (la hace Meta una sola vez, al configurar el webhook): manda
   * `hub.mode=subscribe`, el token secreto y un `challenge` que hay que devolver
   * TAL CUAL. Sin `WHATSAPP_VERIFY_TOKEN` configurado se responde 403: antes no
   * verificar que aceptar cualquier webhook.
   */
  if (route === '/api/webhooks/whatsapp' && req.method === 'GET') {
    const check = verifyWebhookChallenge({
      mode: url.searchParams.get('hub.mode'),
      token: url.searchParams.get('hub.verify_token'),
      challenge: url.searchParams.get('hub.challenge'),
      verifyToken: ctx.whatsappVerifyToken,
    });
    if (!check.ok) {
      console.warn('[crm] verificación de webhook rechazada');
      json(res, check.status ?? 403, { ok: false, error: 'forbidden' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(String(check.challenge));
    return;
  }

  if (route === '/api/webhooks/whatsapp' && req.method === 'POST') {
    /** @type {{raw: string, json: any}} */
    let incoming;
    try {
      incoming = await readRawBody(req);
    } catch (error) {
      json(res, /** @type {any} */ (error).status ?? 400, { ok: false, error: error.message });
      return;
    }
    // La firma se calcula sobre el cuerpo EXACTO: se comprueba antes de procesar.
    const signatureCheck = verifyWebhookSignature({
      rawBody: incoming.raw,
      signature: /** @type {any} */ (req.headers['x-hub-signature-256']),
      appSecret: ctx.appSecret,
    });
    if (!signatureCheck.ok && signatureCheck.reason !== 'not_configured') {
      console.warn(`[crm] webhook con firma no válida (${signatureCheck.reason ?? 'invalid_signature'})`);
      json(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    if (signatureCheck.reason === 'not_configured') {
      // Se atiende el mensaje igual (no se pierde una conversación real), pero se
      // deja claro que falta un secreto para poder comprobar quién llama.
      console.warn('[crm] webhook sin firma comprobada: falta META_APP_SECRET');
    }
    // Meta espera un 200 en pocos segundos y REINTENTA si tardas: se contesta ya
    // y se guarda después. El guardado es idempotente, así que un reintento no
    // duplica ningún mensaje.
    json(res, 200, { ok: true, received: true });
    processWebhookPayload(ctx, incoming.json).catch((error) =>
      console.error('[crm] webhook:', error?.message ?? error),
    );
    return;
  }

  if (route === '/api/crm' && req.method === 'POST') {
    /** @type {any} */
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, /** @type {any} */ (error).status ?? 400, { ok: false, error: error.message });
      return;
    }
    const payload = Array.isArray(body) ? body : [body];
    /** @type {{id:string, duplicate:boolean}[]} */
    const saved = [];
    try {
      for (const item of payload.slice(0, 25)) {
        const row = toRow(item ?? {});
        // Un cliente es una persona, no un canal: si el registro trae teléfono,
        // se enlaza con el cliente unificado (y se crea si es la primera vez).
        if (row.phone) {
          const found = await ctx.customers.findOrCreateByPhone({
            phone: row.phone,
            name: row.name,
            location: row.location,
            source: 'landing',
            optIn: item?.consent === true,
          });
          if (found.ok) row.customerId = found.customer.id;
        }
        const result = await store.save(row);
        saved.push({ id: row.id, duplicate: result.duplicate });
        if (!result.duplicate) {
          console.log(`[crm] guardado ${row.type} ${row.id}${row.variantName ? ` · ${row.variantName}` : ''}`);
          // Espejo del `Lead` del navegador con el MISMO `event_id`: si el píxel
          // no cargó (adblock, iOS), la conversión llega igual y Meta no la cuenta dos veces.
          if (row.type === 'lead') mirrorLeadToMeta(ctx, row, req);
        }
      }
    } catch (error) {
      json(res, /** @type {any} */ (error).status ?? 400, { ok: false, error: error.message, saved });
      return;
    }
    json(res, 202, { ok: true, saved, storage: store.kind });
    return;
  }

  // --------------------------------------------------- app instalable (PWA)
  if (route === '/admin' || route.startsWith('/admin/')) {
    serveAdminFile(res, url.pathname, ctx.adminDir);
    return;
  }

  // Enlace antiguo con la clave en la URL: entra y limpia la barra de direcciones.
  if (route === '/panel') {
    const candidate = url.searchParams.get('token');
    if (candidate && tokenOk(candidate, token)) setSessionCookie(req, res, createSessionValue(token));
    res.writeHead(302, { location: '/admin/', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  const authenticated = sessionValid(readCookie(req, COOKIE), token);

  // ------------------------------------------------------------- el panel
  if (route === '/api/admin/login' && req.method === 'POST') {
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?');
    if (!loginAllowed(ip)) {
      json(res, 429, {
        ok: false,
        error: 'too_many_attempts',
        message: 'Demasiados intentos seguidos. Espera 15 minutos.',
      });
      return;
    }
    /** @type {any} */
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'no_token',
        message: 'Define PHYTO_CRM_TOKEN en el servidor para poder entrar al panel.',
      });
      return;
    }
    if (!tokenOk(text(body.token, 200) ?? '', token)) {
      registerLoginFailure(ip);
      json(res, 401, { ok: false, error: 'invalid_token', message: 'La clave no es correcta.' });
      return;
    }
    loginAttempts.delete(ip);
    setSessionCookie(req, res, createSessionValue(token));
    json(res, 200, { ok: true, storage: store.kind });
    return;
  }

  if (route === '/api/admin/logout' && req.method === 'POST') {
    setSessionCookie(req, res, '');
    json(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/session') {
    json(res, 200, { ok: authenticated, storage: store.kind, timeZone: TIME_ZONE });
    return;
  }

  if (route.startsWith('/api/admin/')) {
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'no_token',
        message: 'Define PHYTO_CRM_TOKEN en el servidor para poder usar el panel.',
      });
      return;
    }
    if (!authenticated) {
      json(res, 401, { ok: false, error: 'unauthorized', message: 'Entra con tu clave.' });
      return;
    }

    // Todo lo que necesita el panel en una sola petición (móvil con mala señal).
    if (route === '/api/admin/data' && req.method === 'GET') {
      const items = await store.listAdmin({ limit: 500 });
      const messages = await store.messages().list();
      const customerList = await ctx.customers.list({});
      const conversationList = await ctx.customers.listConversations({});
      const buckets = await ctx.followups.buckets();
      const outbound = await ctx.db.list('wa_messages', { limit: 500 });
      const failed = outbound.filter((row) => row.status === 'failed');
      json(res, 200, {
        ok: true,
        storage: store.kind,
        timeZone: TIME_ZONE,
        statuses: STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] ?? value })),
        items,
        messages,
        stats: computeStats(items, TIME_ZONE),
        pendientes: dueToday(items, TIME_ZONE).map((item) => item.id),
        // Estado de Meta SIN secretos: el panel solo necesita saber si está activo.
        meta: {
          configured: Boolean(ctx.metaCapi?.enabled),
          testEventCode: Boolean(ctx.metaCapi?.hasTestEventCode),
          purchaseStatus: ctx.purchaseStatus,
          graphVersion: ctx.metaCapi?.graphVersion ?? null,
        },
        // ------------------------------------------------ clientes y WhatsApp
        customers: customerList,
        conversations: conversationList,
        followups: {
          reference: buckets.reference,
          today: buckets.today,
          overdue: buckets.overdue,
          upcoming: buckets.upcoming,
          completed: buckets.completed.slice(-20),
        },
        // Pantalla HOY: lo que una persona tiene que mirar al abrir el panel.
        hoy: {
          reference: buckets.reference,
          seguimientosHoy: buckets.today.length,
          seguimientosVencidos: buckets.overdue.length,
          sinResponder: conversationList.filter((row) => Number(row.unread_count) > 0).length,
          humanoRequerido: conversationList.filter((row) => row.status === 'HUMAN_REQUIRED').length,
          pedidosPendientes: items.filter(
            (item) => item.type === 'order_intent' && item.status !== 'entregado' && item.status !== 'perdido',
          ).length,
          entregadosRecientes: items
            .filter((item) => item.type === 'order_intent' && item.status === 'entregado')
            .slice(0, 5),
          mensajesFallidos: failed.length,
          fallidos: failed.slice(0, 5).map((row) => ({
            id: row.id,
            customer_id: row.customer_id,
            body: row.body,
            error_code: row.error_code,
            error_message: row.error_message,
            failed_at: row.failed_at,
          })),
        },
        // Catálogo oficial: el panel no repite precios, los pide aquí.
        catalog: productConfig.variants.map((variant) => ({
          id: variant.id,
          capsules: variant.capsules,
          price: variant.price,
          currency: 'DOP',
          completeBottle: variant.completeBottle === true,
          label: `${variant.capsules} cápsulas`,
        })),
        // Estado de WhatsApp SIN secretos (solo booleanos y datos públicos).
        whatsapp: {
          configured: Boolean(ctx.whatsapp?.enabled),
          graphVersion: ctx.whatsapp?.graphVersion ?? null,
          phoneNumber: ctx.whatsappPhoneNumber || null,
          phoneNumberIdConfigured: Boolean(ctx.whatsapp?.phoneNumberId),
          webhookUrl: ctx.whatsappWebhookUrl || null,
          verifyTokenConfigured: Boolean(ctx.whatsappVerifyToken),
          appSecretConfigured: Boolean(ctx.appSecret),
          businessAccountConfigured: Boolean(ctx.whatsapp?.businessAccountId),
        },
      });
      return;
    }

    // Números del negocio (clientes, seguimientos, mensajes, ventas).
    if (route === '/api/admin/metrics' && req.method === 'GET') {
      json(res, 200, { ok: true, metrics: await ctx.customers.metrics() });
      return;
    }

    // Reenvío manual de la venta a Meta (lo usa el panel cuando un envío falló).
  // Va ANTES de la ruta del pedido para que `/items/<id>/meta-purchase` no se
  // confunda con el id del registro.
  if (route.startsWith('/api/admin/items/') && route.endsWith('/meta-purchase') && req.method === 'POST') {
    if (!authenticated) {
      json(res, 401, { ok: false, error: 'unauthorized', message: 'Entra con tu clave.' });
      return;
    }
    if (!ctx.metaCapi?.enabled) {
      json(res, 503, {
        ok: false,
        error: 'meta_not_configured',
        message: 'Falta PHYTO_META_CAPI_ACCESS_TOKEN (o PHYTO_META_PIXEL_ID) en el servidor.',
      });
      return;
    }
    const id = decodeURIComponent(route.slice('/api/admin/items/'.length, -'/meta-purchase'.length));
    const items = await store.listAdmin({ limit: 500 });
    const item = items.find((entry) => entry.id === id);
    if (!item) {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (item.type !== 'order_intent') {
      json(res, 409, { ok: false, error: 'not_an_order', message: 'Solo se envía la venta de un pedido.' });
      return;
    }
    const result = await sendPurchaseToMeta({ store, metaCapi: ctx.metaCapi, item, source: 'manual' });
    json(res, result.ok ? 200 : result.skipped ? 409 : 502, {
      ok: result.ok,
      skipped: result.skipped ?? false,
      reason: result.reason ?? null,
      error: result.error ?? null,
      response: result.response ?? null,
      item: result.item ?? item,
    });
    return;
  }

  if (route.startsWith('/api/admin/items/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const id = decodeURIComponent(route.slice('/api/admin/items/'.length));
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      /** @type {Record<string, unknown>} */
      const patch = {};
      if (body.status !== undefined) {
        const status = text(body.status, 20);
        if (!STATUSES.includes(status)) {
          json(res, 422, { ok: false, error: 'invalid_status' });
          return;
        }
        patch.status = status;
      }
      if (body.notes !== undefined) patch.notes = longText(body.notes, 2000);
      if (body.nextActionAt !== undefined) patch.nextActionAt = day(body.nextActionAt);
      if (body.contacted) {
        patch.lastContactAt = new Date().toISOString();
        if (patch.status === undefined) patch.status = 'contactado';
      }
      const updated = await store.update(id, patch);
      if (!updated) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      console.log(`[crm] actualizado ${id}${patch.status ? ` → ${patch.status}` : ''}`);
      /*
       * ¿El negocio acaba de cerrar la venta (estado "entregado")? Solo entonces
       * se le cuenta a Meta, se recalculan los totales del cliente y se crea su
       * plan de seguimiento. Va en segundo plano y es idempotente: si Meta tarda
       * o falla, el panel ya tiene su respuesta y el pedido conserva el resultado.
       */
      if (
        updated.type === 'order_intent' &&
        updated.status === ctx.purchaseStatus &&
        patch.status === ctx.purchaseStatus
      ) {
        afterPurchaseDelivered(ctx, updated).catch((error) => {
          console.error('[crm] venta entregada:', error?.message ?? error);
        });
      }
      json(res, 200, { ok: true, item: updated });
      return;
    }

    // ------------------------------------------------------------- clientes
    // Listado con búsqueda (nombre, teléfono, ciudad) y su próximo seguimiento.
    if (route === '/api/admin/customers' && req.method === 'GET') {
      const customers = await ctx.customers.list({ q: url.searchParams.get('q') ?? '' });
      const followupRows = await ctx.db.list('followups', { limit: 2000 });
      const nextByCustomer = new Map();
      for (const row of followupRows) {
        if (row.status !== 'pending') continue;
        const current = nextByCustomer.get(row.customer_id);
        if (!current || row.scheduled_at < current.scheduled_at) nextByCustomer.set(row.customer_id, row);
      }
      json(res, 200, {
        ok: true,
        customers: customers.map((customer) => ({
          ...customer,
          next_followup: nextByCustomer.get(customer.id) ?? null,
        })),
      });
      return;
    }

    if (route.startsWith('/api/admin/customers/')) {
      const rest = decodeURIComponent(route.slice('/api/admin/customers/'.length));
      const [customerId, action = ''] = rest.split('/');
      const customer = customerId ? await ctx.customers.get(customerId) : null;
      if (!customer) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }

      // Perfil 360: compras, chat, seguimiento, consentimiento y ventana de 24 h.
      if (!action && req.method === 'GET') {
        const profile = await ctx.customers.profile(customerId);
        json(res, 200, { ok: true, ...profile });
        return;
      }

      if (!action && (req.method === 'PATCH' || req.method === 'POST')) {
        /** @type {any} */
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (body.name !== undefined) patch.name = text(body.name, 120);
        if (body.location !== undefined) patch.location = text(body.location, 120);
        if (body.notes !== undefined) patch.notes = longText(body.notes, 2000);
        const updated = await ctx.customers.update(customerId, patch);
        json(res, 200, { ok: true, customer: updated });
        return;
      }

      // "No contactar": manda sobre cualquier plan y cancela lo de marketing.
      if (action === 'opt-out' && req.method === 'POST') {
        const result = await ctx.customers.applyOptOut(customerId, { reason: 'opt_out_panel' });
        console.log(`[crm] ${customerId} marcado como NO CONTACTAR (${result.cancelled} tarea(s) cancelada(s))`);
        json(res, 200, { ok: true, customer: result.customer, cancelled: result.cancelled });
        return;
      }

      if (action === 'opt-in' && req.method === 'POST') {
        const updated = await ctx.customers.clearOptOut(customerId);
        json(res, 200, { ok: true, customer: updated });
        return;
      }

      // AUTOMATIC | HUMAN_REQUIRED | HUMAN_ACTIVE | PAUSED | CLOSED
      if (action === 'automation' && req.method === 'POST') {
        /** @type {any} */
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const state = text(body.state, 30);
        const updated = await ctx.customers.setAutomationState(customerId, state, { note: longText(body.note, 500) });
        if (!updated) {
          json(res, 422, { ok: false, error: 'invalid_state', states: AUTOMATION_STATES });
          return;
        }
        json(res, 200, { ok: true, customer: updated });
        return;
      }

      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    // ------------------------------------------------- compras registradas a mano
    // El teléfono identifica al cliente: si ya existe, se suma a su historial.
    if (route === '/api/admin/purchases' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const found = await ctx.customers.findOrCreateByPhone({
        phone: body.phone,
        name: body.name,
        location: body.location,
        source: 'manual',
      });
      if (!found.ok) {
        json(res, 422, {
          ok: false,
          error: 'invalid_phone',
          message: 'Escribe un teléfono válido (por ejemplo 809 555 1234).',
        });
        return;
      }
      const customer = found.customer;
      /** @type {{row: any, payload: any}} */
      let built;
      try {
        built = purchaseRow({ ...body, customerId: customer.id });
      } catch (error) {
        json(res, 422, {
          ok: false,
          error: /** @type {any} */ (error).message,
          message: 'Elige un frasco del catálogo.',
        });
        return;
      }
      const requested = text(body.status, 20);
      const status = requested && STATUSES.includes(requested) ? requested : 'nuevo';
      const saved = await ctx.store.save(built.row);
      const item = await ctx.store.update(built.row.id, {
        status,
        notes: built.payload.notes,
        customerId: customer.id,
      });
      let delivered = null;
      if (status === ctx.purchaseStatus) delivered = await afterPurchaseDelivered(ctx, item ?? built.row);
      console.log(
        `[crm] compra registrada a mano ${built.row.id} · ${customer.name ?? customer.phone_e164} · estado ${status}`,
      );
      json(res, 201, { ok: true, duplicate: saved.duplicate, item, customer, delivered });
      return;
    }

    // ------------------------------------------------------------- bandeja
    if (route === '/api/admin/conversations' && req.method === 'GET') {
      const conversations = await ctx.customers.listConversations({});
      json(res, 200, { ok: true, conversations, whatsapp: { configured: Boolean(ctx.whatsapp?.enabled) } });
      return;
    }

    if (route.startsWith('/api/admin/conversations/')) {
      const rest = decodeURIComponent(route.slice('/api/admin/conversations/'.length));
      const [conversationId, action = ''] = rest.split('/');
      const conversation = conversationId ? await findConversation(ctx, conversationId) : null;
      if (!conversation) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const customer = await ctx.customers.get(conversation.customer_id);

      if (action === 'messages' && req.method === 'GET') {
        const messages = await ctx.customers.messagesFor(conversation.id, { limit: 200 });
        json(res, 200, {
          ok: true,
          conversation,
          customer,
          messages,
          canSendFreeText: ctx.customers.canSendFreeText(conversation),
          whatsapp: { configured: Boolean(ctx.whatsapp?.enabled) },
        });
        return;
      }

      if (action === 'read' && req.method === 'POST') {
        const updated = await ctx.customers.markConversationRead(conversation.id);
        json(res, 200, { ok: true, conversation: updated });
        return;
      }

      /*
       * ENVÍO MANUAL. Nunca automático: esto solo se ejecuta cuando una persona
       * pulsa ENVIAR en el panel, y antes se comprueban las reglas de WhatsApp:
       *   - el cliente no puede haber pedido no recibir mensajes;
       *   - fuera de la ventana de 24 h solo se puede mandar una plantilla APROBADA.
       */
      if (action === 'messages' && req.method === 'POST') {
        /** @type {any} */
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const messageBody = longText(body.body, 1200);
        const templateName = text(body.template, 60);
        if (!messageBody && !templateName) {
          json(res, 422, { ok: false, error: 'empty_message', message: 'Escribe el mensaje.' });
          return;
        }
        if (customer?.do_not_contact || customer?.whatsapp_opt_out_at) {
          json(res, 409, {
            ok: false,
            error: 'do_not_contact',
            message: 'Este cliente pidió no recibir mensajes. Respétalo.',
          });
          return;
        }
        if (!ctx.whatsapp?.enabled) {
          json(res, 503, {
            ok: false,
            error: 'whatsapp_not_configured',
            message:
              'WhatsApp todavía no está configurado en el servidor (faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID). El mensaje NO se ha enviado.',
          });
          return;
        }
        /** @type {any} */
        let template = null;
        if (templateName) {
          const check = await approvedTemplate(ctx, templateName);
          if (!check.ok) {
            json(res, 409, {
              ok: false,
              error: check.reason,
              message:
                check.reason === 'template_not_approved'
                  ? `La plantilla «${templateName}» todavía no está aprobada en Meta: no se puede enviar.`
                  : `Plantilla desconocida: ${templateName}`,
              template: check.template ?? null,
            });
            return;
          }
          template = check.template;
        }
        if (!template && !ctx.customers.canSendFreeText(conversation)) {
          json(res, 409, {
            ok: false,
            error: 'outside_window',
            message:
              'Han pasado más de 24 h desde el último mensaje del cliente: WhatsApp solo permite enviar una plantilla aprobada.',
          });
          return;
        }

        const sendResult = template
          ? await ctx.whatsapp.sendTemplate(customer.phone_e164, {
              name: template.name,
              language: template.language ?? 'es',
              components: [],
            })
          : await ctx.whatsapp.sendText(customer.phone_e164, messageBody, {
              previewUrl: body.previewUrl === true,
              replyTo: text(body.replyTo, 200) ?? undefined,
            });

        if (!sendResult.ok && sendResult.skipped) {
          json(res, 503, {
            ok: false,
            error: 'whatsapp_not_configured',
            message: 'WhatsApp no está configurado: el mensaje NO se ha enviado.',
          });
          return;
        }
        if (!sendResult.ok) {
          const recorded = await ctx.customers.recordOutbound({
            customer,
            conversation,
            body: template ? null : messageBody,
            template: template?.name ?? null,
            status: 'failed',
            error: sendResult.error ?? { message: sendResult.reason ?? 'error' },
            idempotencyKey: text(body.idempotencyKey, 120),
            sentBy: 'panel',
          });
          console.error(`[crm] WhatsApp rechazó un mensaje a ${customer.id}: ${sendResult.error?.message ?? 'error'}`);
          json(res, 502, {
            ok: false,
            error: 'send_failed',
            message: sendResult.error?.message ?? 'WhatsApp rechazó el mensaje.',
            detail: sendResult.error ?? null,
            message_record: recorded.message,
          });
          return;
        }

        const recorded = await ctx.customers.recordOutbound({
          customer,
          conversation,
          body: template ? null : messageBody,
          template: template?.name ?? null,
          waMessageId: sendResult.messageId ?? null,
          status: 'sent',
          idempotencyKey: text(body.idempotencyKey, 120),
          // Solo datos públicos del envío: nunca el token ni la cabecera.
          meta: { phoneNumberId: ctx.whatsapp.phoneNumberId },
          sentBy: 'panel',
        });
        await ctx.customers.markConversationRead(conversation.id);
        // Una persona acaba de escribir: la conversación pasa a manos humanas.
        await ctx.customers.setAutomationState(customer.id, 'HUMAN_ACTIVE');

        const followupId = text(body.followupId, 80);
        const followup = followupId
          ? await ctx.followups.complete(followupId, {
              by: 'panel',
              messageId: recorded.message?.id ?? null,
              outcome: 'enviado',
            })
          : null;

        // Dos ticks azules para el cliente (no es un mensaje: no cuenta como envío).
        const inbound = (await ctx.customers.messagesFor(conversation.id, { limit: 50 })).filter(
          (row) => row.direction === 'inbound',
        );
        const lastInbound = inbound[inbound.length - 1];
        if (lastInbound?.wa_message_id) {
          ctx.whatsapp.markAsRead(lastInbound.wa_message_id).catch(() => {});
        }

        console.log(`[crm] mensaje enviado a ${customer.id}${template ? ` (plantilla ${template.name})` : ''}`);
        json(res, 200, {
          ok: true,
          message: recorded.message,
          duplicate: recorded.duplicate === true,
          followup,
        });
        return;
      }

      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    // ---------------------------------------------------------- seguimiento
    if (route === '/api/admin/followups' && req.method === 'GET') {
      const buckets = await ctx.followups.buckets();
      const customers = await ctx.customers.list({});
      json(res, 200, {
        ok: true,
        reference: buckets.reference,
        today: withCustomer(buckets.today, customers),
        overdue: withCustomer(buckets.overdue, customers),
        upcoming: withCustomer(buckets.upcoming, customers),
        completed: withCustomer(buckets.completed.slice(-30), customers),
        cancelled: withCustomer(buckets.cancelled.slice(-30), customers),
        summary: await ctx.followups.summary(),
        plan: ctx.followups.plan,
        timeZone: ctx.followups.timeZone,
      });
      return;
    }

    // Tarea creada a mano (fuera del plan automático).
    if (route === '/api/admin/followups' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const customer = body.customerId ? await ctx.customers.get(text(body.customerId, 80) ?? '') : null;
      if (!customer) {
        json(res, 422, { ok: false, error: 'unknown_customer' });
        return;
      }
      const followup = await ctx.followups.createManual({
        customerId: customer.id,
        purchaseId: text(body.purchaseId, 80) ?? null,
        type: text(body.type, 30) ?? 'manual',
        reason: longText(body.reason, 200) ?? 'Seguimiento manual',
        scheduledAt: day(body.scheduledAt) ?? undefined,
        template: text(body.template, 60) ?? null,
      });
      json(res, 201, { ok: true, followup });
      return;
    }

    // Decidir una tarea: completar, omitir, cancelar, posponer o cambiar la fecha.
    if (route.startsWith('/api/admin/followups/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const rest = decodeURIComponent(route.slice('/api/admin/followups/'.length));
      const [followupId, actionInPath = ''] = rest.split('/');
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const action = actionInPath || text(body.action, 20) || 'complete';
      const current = await ctx.db.get('followups', followupId);
      if (!current) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      /** @type {any} */
      let followup = null;
      if (action === 'complete') followup = await ctx.followups.complete(followupId, { by: 'panel', outcome: 'hecho' });
      else if (action === 'skip') followup = await ctx.followups.skip(followupId, { reason: text(body.reason, 200) });
      else if (action === 'cancel') followup = await ctx.followups.cancel(followupId, { reason: text(body.reason, 200) });
      else if (action === 'postpone') followup = await ctx.followups.postpone(followupId, { days: body.days, date: body.date });
      else if (action === 'reschedule' && day(body.date)) followup = await ctx.followups.reschedule(followupId, day(body.date));
      else {
        json(res, 422, { ok: false, error: 'invalid_action', actions: ['complete', 'skip', 'cancel', 'postpone', 'reschedule'] });
        return;
      }
      if (ctx.customers) {
        const next = await ctx.followups.nextForCustomer(current.customer_id);
        await ctx.customers.update(current.customer_id, { next_followup_at: next?.scheduled_at ?? null });
      }
      json(res, 200, { ok: true, followup });
      return;
    }

    // ------------------------------------------------------- plantillas oficiales
    if (route === '/api/admin/wa-templates' && req.method === 'GET') {
      json(res, 200, { ok: true, templates: await listWaTemplates(ctx) });
      return;
    }

    /*
     * Registrar/actualizar una plantilla. El ESTADO lo dicta Meta: hasta que el
     * negocio no marque `approved` (tras aprobarla en Meta), el panel no la deja
     * enviar. Así el CRM nunca intenta un envío que WhatsApp va a rechazar.
     */
    if (route === '/api/admin/wa-templates' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const name = text(body.name, 60);
      if (!name) {
        json(res, 422, { ok: false, error: 'invalid_name' });
        return;
      }
      const allowed = ['pending_approval', 'approved', 'rejected', 'disabled'];
      const status = allowed.includes(text(body.status, 30)) ? text(body.status, 30) : 'pending_approval';
      const existing = await ctx.db.findBy('wa_templates', 'name', name);
      const doc = {
        id: existing?.id ?? `tpl_${name}`,
        name,
        category: text(body.category, 30) ?? existing?.category ?? 'MARKETING',
        language: text(body.language, 10) ?? existing?.language ?? 'es',
        body: longText(body.body, 1024) ?? existing?.body ?? null,
        variables: Array.isArray(body.variables) ? body.variables.slice(0, 10) : existing?.variables ?? [],
        buttons: Array.isArray(body.buttons) ? body.buttons.slice(0, 5) : existing?.buttons ?? [],
        status,
        sendable: status === 'approved',
        // Identificador y fecha que solo pueden venir de Meta (los rellena el
        // negocio a mano tras registrarla allí). Aquí nunca se inventan.
        meta_template_id: text(body.metaTemplateId, 80) ?? existing?.meta_template_id ?? null,
        last_synced_at: text(body.lastSyncedAt, 40) ?? existing?.last_synced_at ?? null,
        source: existing?.source ?? 'crm',
        created_at: existing?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (existing) await ctx.db.update('wa_templates', existing.id, doc);
      else await ctx.db.insert('wa_templates', doc);
      json(res, 200, { ok: true, template: doc, templates: await listWaTemplates(ctx) });
      return;
    }

    // Plantillas de TEXTO del panel (las que se copian en el chat).
    if (route === '/api/admin/messages' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const name = text(body.name, 60);
      const messageBody = longText(body.body, 1200);
      if (!name || !messageBody) {
        json(res, 422, { ok: false, error: 'invalid_message', message: 'La plantilla necesita nombre y texto.' });
        return;
      }
      const message = {
        id: text(body.id, 60) ?? messageId(name),
        name,
        body: messageBody,
        position: Number.isFinite(Number(body.position)) ? Math.trunc(Number(body.position)) : 99,
      };
      await store.messages().save(message);
      console.log(`[crm] plantilla guardada: ${message.name}`);
      json(res, 200, { ok: true, message, messages: await store.messages().list() });
      return;
    }

    if (route.startsWith('/api/admin/messages/') && req.method === 'DELETE') {
      const id = decodeURIComponent(route.slice('/api/admin/messages/'.length));
      await store.messages().remove(id);
      json(res, 200, { ok: true, messages: await store.messages().list() });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  // --------------------------------------- lectura por clave (curl / scripts)
  if (route === '/api/crm/items' || route === '/api/crm/export.csv') {
    const candidate = url.searchParams.get('token') ?? req.headers['x-crm-token'];
    if (!token) {
      json(res, 503, {
        ok: false,
        error: 'read_disabled',
        message:
          'Para leer los datos define PHYTO_CRM_TOKEN en el servidor. Mientras no lo hagas, la web sigue guardando los registros.',
      });
      return;
    }
    // Vale la clave (`?token=`, para curl) o la sesión del panel (la cookie).
    if (!tokenOk(typeof candidate === 'string' ? candidate : '', token) && !authenticated) {
      json(res, 401, { ok: false, error: 'invalid_token', message: 'La clave (?token=) no es correcta.' });
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
    const type = url.searchParams.get('type');
    const rows = await store.list({ limit, type: type === 'lead' || type === 'order_intent' ? type : null });

    if (route === '/api/crm/export.csv') {
      const header = [
        'fecha',
        'tipo',
        'estado',
        'nombre',
        'telefono',
        'ciudad',
        'frasco',
        'capsulas',
        'cantidad',
        'precio_unitario',
        'total',
        'moneda',
        'origen',
        'recordatorio',
        'notas',
        'ultimo_contacto',
        'meta_venta',
        'meta_enviada',
      ];
      const lines = rows.map((row) =>
        [
          row.received_at,
          typeLabel(row.type),
          STATUS_LABELS[row.status ?? 'nuevo'] ?? row.status,
          row.name,
          row.phone,
          row.location,
          row.variant_name,
          row.capsules,
          row.quantity,
          row.unit_price,
          row.total,
          row.currency,
          row.source,
          row.next_action_at,
          row.notes,
          row.last_contact_at,
          row.meta_purchase_status,
          row.meta_purchase_sent_at,
        ]
          .map(csvCell)
          .join(','),
      );
      const csv = `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="pedidos-phytoemagry.csv"',
        'cache-control': 'no-store',
      });
      res.end(csv);
      return;
    }

    json(res, 200, {
      ok: true,
      storage: store.kind,
      total: await store.count(),
      count: rows.length,
      items: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not_found' });
}

// ------------------------------------------------------------------ arranque

/**
 * Levanta la API y el panel.
 * @param {object} [config]
 * @param {number} [config.port] 0 = puerto libre (lo elige el sistema)
 * @param {string} [config.host]
 * @param {string} [config.dataFile]
 * @param {string} [config.databaseUrl] cadena de PostgreSQL (vacía = SQLite)
 * @param {string} [config.token] clave del panel (vacía = panel desactivado)
 * @param {string} [config.adminDir] carpeta de la app del panel
 * @param {string} [config.allowedOrigin] origen permitido por CORS
 * @param {boolean} [config.quiet] no imprimir el banner de arranque
 * @param {any} [config.metaCapi] cliente de CAPI ya construido (tests)
 * @param {string} [config.metaPixelId]
 * @param {string} [config.metaAccessToken]
 * @param {string} [config.metaTestEventCode]
 * @param {string} [config.metaGraphVersion]
 * @param {string} [config.appEnv]
 * @param {string} [config.purchaseStatus] estado que representa una venta
 */
export async function startCrmServer(config = {}) {
  const settings = {
    port: config.port ?? PORT,
    host: config.host ?? HOST,
    dataFile: config.dataFile ?? DATA_FILE,
    databaseUrl: config.databaseUrl ?? DATABASE_URL,
    token: config.token ?? TOKEN,
    allowedOrigin: config.allowedOrigin ?? ALLOWED_ORIGIN,
    adminDir: resolveAdminDir(config.adminDir),
    quiet: config.quiet ?? false,
  };

  const store = await createStore({ databaseUrl: settings.databaseUrl, dataFile: settings.dataFile });

  /*
   * Colecciones nuevas (clientes, conversaciones, mensajes, seguimientos,
   * plantillas oficiales y contenido) sobre el MISMO backend que los pedidos:
   * una sola base de datos que respaldar y una sola forma de consultarla.
   */
  const db = await createCollections({
    backend: store.kind === 'postgres' ? 'postgres' : store.kind === 'sqlite' ? 'sqlite' : 'jsonl',
    handle: store.handle ?? null,
    dir: path.dirname(settings.dataFile),
    prefix: 'phytoemagry_',
  });

  /*
   * Cliente de Meta. Si no hay credenciales queda desactivado y todo sigue
   * funcionando igual: el CRM no puede depender de un tercero para guardar un
   * pedido. El token solo vive aquí (nunca sale en una respuesta HTTP).
   */
  const metaCapi =
    config.metaCapi ??
    createMetaCapi({
      pixelId: config.metaPixelId ?? META_PIXEL_ID,
      accessToken: config.metaAccessToken ?? META_CAPI_TOKEN,
      testEventCode: config.metaTestEventCode ?? META_TEST_EVENT_CODE,
      graphVersion: config.metaGraphVersion ?? META_GRAPH_VERSION,
      appEnv: config.appEnv ?? APP_ENV,
      debug: !settings.quiet,
    });

  /*
   * Cliente de WhatsApp Cloud API. Sin credenciales queda desactivado y el CRM
   * sigue igual (guardar un cliente nunca puede depender de Meta). El token solo
   * vive aquí: nunca sale en una respuesta HTTP.
   */
  const whatsapp =
    config.whatsapp ??
    createWhatsAppClient({
      accessToken: config.whatsappAccessToken ?? WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.whatsappPhoneNumberId ?? WHATSAPP_PHONE_NUMBER_ID,
      businessAccountId: config.whatsappBusinessAccountId ?? WHATSAPP_BUSINESS_ACCOUNT_ID,
      graphVersion: config.whatsappGraphVersion ?? WHATSAPP_GRAPH_VERSION,
      log: settings.quiet ? false : undefined,
    });

  /*
   * Seguimiento: crea y fecha tareas. NO envía nada por su cuenta; el envío
   * siempre lo pulsa una persona en el panel.
   */
  const followups = createFollowupEngine({
    db,
    plan: config.followupPlan ?? FOLLOWUP_PLAN,
    timeZone: TIME_ZONE,
    dailyCapsules: DAILY_CAPSULES,
    clock: config.clock,
  });
  const customers = createCustomerService({ db, store, followups, clock: config.clock });

  const ctx = {
    store,
    db,
    token: settings.token,
    allowedOrigin: settings.allowedOrigin,
    adminDir: settings.adminDir,
    metaCapi,
    purchaseStatus: config.purchaseStatus ?? META_PURCHASE_STATUS,
    followups,
    customers,
    whatsapp,
    whatsappPhoneNumber: (config.whatsappPhoneNumber ?? WHATSAPP_PHONE_NUMBER).trim(),
    whatsappWebhookUrl: (config.whatsappWebhookUrl ?? WHATSAPP_WEBHOOK_URL).trim(),
    whatsappVerifyToken: (config.whatsappVerifyToken ?? WHATSAPP_VERIFY_TOKEN).trim(),
    appSecret: (config.metaAppSecret ?? META_APP_SECRET).trim(),
    timeZone: TIME_ZONE,
  };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((error) => {
      console.error('[crm] error:', error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'server_error' });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : settings.port;

  if (!settings.quiet) {
    console.log(`[crm] escuchando en http://${settings.host}:${port} · almacén ${store.kind} → ${store.file}`);
    console.log(`[crm] panel: http://${settings.host}:${port}/admin/ · app instalable (PWA)`);
    console.log(
      `[crm] Meta: ${
        metaCapi.enabled
          ? `API de conversiones activa (${metaCapi.graphVersion}${metaCapi.hasTestEventCode ? ', modo prueba' : ''})`
          : 'desactivada (faltan PHYTO_META_PIXEL_ID o PHYTO_META_CAPI_ACCESS_TOKEN)'
      } · venta = estado "${ctx.purchaseStatus}"`,
    );
    if (!settings.token) {
      console.warn('[crm] PHYTO_CRM_TOKEN sin definir: guardar funciona, el panel está desactivado.');
    }
    console.log(
      `[crm] WhatsApp: ${
        whatsapp.enabled
          ? `envío activo (${whatsapp.graphVersion})${ctx.whatsappPhoneNumber ? ` · número ${ctx.whatsappPhoneNumber}` : ''}`
          : 'desactivado (faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID): la bandeja y los clientes funcionan igual'
      }`,
    );
    console.log(
      `[crm] webhook: ${
        ctx.whatsappWebhookUrl || `/api/webhooks/whatsapp`
      } · ${ctx.whatsappVerifyToken ? 'verificación configurada' : 'FALTA WHATSAPP_VERIFY_TOKEN'}`,
    );
    console.log(
      `[crm] seguimiento: ${followups.plan.length} tarea(s) por venta entregada · el envío SIEMPRE es manual (nada se envía solo)`,
    );
  }

  // Reintento de ventas pendientes en segundo plano: no retrasa el arranque.
  retryPendingPurchases(store, metaCapi).catch(() => {});
  // Y se asegura de que las ventas entregadas tengan su plan de seguimiento.
  ensureFollowupsForDelivered(ctx).catch(() => {});

  // Cierre idempotente: cerrar dos veces (un test, un reinicio, dos señales)
  // no puede lanzar "database is not open".
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve, reject) => {
      server.close(async () => {
        try {
          await store.close();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  return {
    port,
    url: `http://${settings.host}:${port}`,
    storage: store.kind,
    file: store.file,
    adminDir: settings.adminDir,
    server,
    store,
    metaCapi,
    collections: db,
    followups,
    customers,
    whatsapp,
    purchaseStatus: ctx.purchaseStatus,
    close,
  };
}

// Solo arranca sola cuando se ejecuta directamente (`node server/crm-server.mjs`).
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const app = await startCrmServer();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[crm] ${signal}: cerrando…`);
      await app.close();
      process.exit(0);
    });
  }
}

export { CLOSED_STATUSES, STATUSES };
