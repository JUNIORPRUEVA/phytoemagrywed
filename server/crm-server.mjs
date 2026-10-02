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
 *    PHYTO_META_PURCHASE_STATUS       compatibilidad Meta; la compra completada de negocio es `entregado`
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
import webpush from 'web-push';

import { buildUserData, createMetaCapi } from './meta-capi.mjs';
import { createCollections } from './collections.mjs';
import {
  createCustomerService,
  AUTOMATION_STATES,
  COMMERCIAL_STATES,
  MANUAL_COMMERCIAL_STATES,
  CUSTOMER_STAGES,
  CUSTOMER_STAGE_LABELS,
} from './customers.mjs';
import { addDays, createFollowupEngine, dayIn, resolveDailyCapsules, resolvePlan } from './followups.mjs';
import { createAuditLog } from './audit.mjs';
import { createUserService, SYSTEM_ACTOR, hasPermission, permissionsForRole } from './users.mjs';
import { createInventoryService, centsToMoney } from './inventory.mjs';
import { createScheduler } from './scheduler.mjs';
import { createSettingsService } from './settings.mjs';
import { createSqlQuery } from './sql-query.mjs';
import { createMediaStore, MEDIA_STATUS, SEND_STATUS } from './media.mjs';
import { ffmpegInfo } from './audio-normalize.mjs';
import { createStorageService } from './storage.mjs';
import { createWhatsAppMedia } from './whatsapp-media.mjs';
import { createMediaPipeline } from './media-pipeline.mjs';
import { createMediaRoutes } from './media-routes.mjs';
import {
  ORDER_STATUS_LABELS,
  BUSINESS_COMPLETED_PURCHASE_STATUS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  buildOrder,
  buildReceipt,
  isCompletedPurchaseStatus,
  isOrderStatus,
  normalizePaymentMethod,
  orderOf,
  receiptHtml,
  receiptPdf,
} from './orders.mjs';
import {
  SOURCE_LABELS,
  captureMetaReferral,
  hasAutomaticMetaEvidence,
  manualAttribution,
  orderAttributionSnapshot,
  readOrderAttribution,
  sourceFromAttribution,
} from './sales-attribution.mjs';
import {
  LOCATION_SOURCES,
  describeLocation,
  locationAgeLabel,
  mapUrl,
  normalizeLocation,
  orderLocationSnapshot,
  publicLocation,
} from './locations.mjs';
import {
  ACTIVE_TRACKING_STATUS,
  buildSession as buildTrackingSession,
  orderDestination,
  publicTrackingSession,
  shouldStorePoint,
  suspiciousJump,
  validateLocationUpdate,
} from './delivery-tracking.mjs';

const saleCancellationLocks = new Map();
import { catalogItems, computeOrderTotals } from '../src/lib/catalog.js';
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
const BOOTSTRAP_ADMIN_USER = (process.env.PHYTO_CRM_BOOTSTRAP_ADMIN_USER ?? '').trim();
const BOOTSTRAP_ADMIN_PASSWORD = (process.env.PHYTO_CRM_BOOTSTRAP_ADMIN_PASSWORD ?? '').trim();
const ALLOWED_ORIGIN = (process.env.PHYTO_CRM_ALLOWED_ORIGIN ?? '').trim();
const TIME_ZONE = (process.env.PHYTO_CRM_TZ ?? 'America/Santo_Domingo').trim();
const WEB_PUSH_PUBLIC_KEY = (process.env.PHYTO_WEB_PUSH_PUBLIC_KEY ?? process.env.VAPID_PUBLIC_KEY ?? '').trim();
const WEB_PUSH_PRIVATE_KEY = (process.env.PHYTO_WEB_PUSH_PRIVATE_KEY ?? process.env.VAPID_PRIVATE_KEY ?? '').trim();
const WEB_PUSH_SUBJECT = (process.env.PHYTO_WEB_PUSH_SUBJECT ?? 'mailto:admin@phytoemagry.local').trim();
if (WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY) {
  webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY);
}
const DELIVERY_OPERATIONAL_STATUSES = Object.freeze({
  PENDING_CONTACT: 'PENDING_CONTACT',
  CONTACTED: 'CONTACTED',
  READY_FOR_DELIVERY: 'READY_FOR_DELIVERY',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
});

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
 * Compatibilidad de configuración histórica para Meta.
 *
 * La fuente de verdad de negocio vive en `isCompletedPurchaseStatus()`:
 * `entregado` es el único estado que cierra el pedido con cobro. Esta variable
 * no redefine customerStage, ventas ni inventario.
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

// ------------------------------------------------- Almacén de archivos (R2)
/*
 * Multimedia de WhatsApp: la METADATA vive en la base de datos y el BINARIO en
 * Cloudflare R2 (o cualquier S3 compatible). Si estas variables no están, la
 * multimedia queda desactivada y **el CRM sigue funcionando igual**: se registran
 * pedidos, clientes y mensajes de texto, y el panel lo dice sin inventar nada.
 * Los valores no se imprimen nunca.
 */
const R2_ENDPOINT = (process.env.R2_ENDPOINT ?? '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME ?? '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID ?? '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY ?? '').trim();
/** Cápsulas por día: 1 es el uso aprobado del producto. */
const DAILY_CAPSULES = resolveDailyCapsules(productConfig.usage, (process.env.PHYTO_DAILY_CAPSULES ?? '').trim());
/** Plan de seguimiento (días configurables sin tocar código). */
const FOLLOWUP_PLAN = resolvePlan(process.env.PHYTO_FOLLOWUP_PLAN);

/**
 * Catálogo comercial publicado al panel. Sale de `src/lib/catalog.js` (fuente
 * única derivada de `product.config.js`): ninguna pantalla repite un precio.
 */
const CATALOG = catalogItems();

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
  en_preparacion: 'En preparación',
  enviado: 'Enviado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
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

function wantsHtml(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') && !accept.includes('application/json');
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
  const sourceEvidence = sourceFromAttribution(payload.attribution ?? payload.meta_attribution ?? null);
  const saleSource = sourceEvidence?.source ?? (payload.sale_source ? manualAttribution(payload).source : null);
  const sourceOrigin = sourceEvidence?.source_origin ?? (saleSource ? manualAttribution(payload).source_origin : null);
  const storedPayload = {
    ...payload,
    ...(saleSource ? { sale_source: saleSource } : {}),
    ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
    ...(sourceEvidence?.source === 'META_ADS' && payload.attribution ? { meta_attribution: payload.attribution } : {}),
  };

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
    payload: JSON.stringify(storedPayload),
  };
}

/**
 * Fila de un PEDIDO registrado desde el panel (o desde una conversación).
 *
 * Delega en `buildOrder` (`server/orders.mjs`) para que exista UNA sola forma de
 * calcular un pedido: misma aritmética para la web, el panel y el chat. `items[]`
 * permite varias líneas; si no viene, se usa el frasco + cantidad de siempre
 * (compatibilidad con el formulario antiguo).
 *
 * @param {any} input
 */
function purchaseRow(input) {
  const lines =
    Array.isArray(input.items) && input.items.length
      ? input.items
      : [{ variantId: input.variantId, quantity: input.quantity, unitPrice: input.unitPrice }];
  try {
    return buildOrder({ ...input, items: lines, channel: input.channel ?? 'manual' });
  } catch (error) {
    const wrapped = /** @type {any} */ (new Error(error?.code ?? 'invalid_order'));
    wrapped.status = 422;
    throw wrapped;
  }
}

function csvCell(value) {
  const raw = String(value);
  return /[",;\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

/**
 * Resuelve la ubicación de entrega de un pedido.
 *
 * Acepta dos formas, porque hay dos formas de elegirla de verdad:
 *   · la ID de una ubicación ya guardada (la que mandó el cliente, o una que vio
 *     el operador en el historial) → se reutiliza ESA fila, no se duplica;
 *   · coordenadas directas (el dispositivo del operador o escritas a mano).
 *
 * Reglas que no se rompen:
 *   · la ubicación de un cliente NUNCA se puede aplicar al pedido de otro (§9);
 *   · `null` / `''` / `false` significa «sin ubicación», y es válido (§40);
 *   · las coordenadas se validan aquí, antes de guardar nada (§32).
 *
 * @param {any} ctx
 * @param {{ customerId?: string|null, body?: any }} input
 */
async function resolveOrderLocation(ctx, input) {
  const body = input?.body ?? {};
  const reference = body.deliveryLocation ?? body.delivery_location ?? null;
  if (reference === null || reference === undefined || reference === '' || reference === false) {
    // «Sin ubicación» EXPLÍCITO: se marca como provisto para poder quitarla al
    // editar. Distinto de «no me han dicho nada», que conserva la que tenía.
    return { ok: true, provided: true, location: null };
  }
  if (typeof reference === 'string' || typeof reference === 'number') {
    const stored = await ctx.customers.getLocation(String(reference));
    if (!stored) return { ok: false, code: 'unknown_location', message: 'Esa ubicación ya no existe.' };
    if (input.customerId && stored.customer_id && stored.customer_id !== input.customerId) {
      return {
        ok: false,
        code: 'location_from_other_customer',
        message: 'Esa ubicación es de otro cliente: no se puede usar en este pedido.',
      };
    }
    return { ok: true, provided: true, location: { ...stored, source_location_id: stored.id } };
  }
  if (typeof reference === 'object') {
    const normalized = normalizeLocation(reference);
    if (!normalized.ok) return { ok: false, code: normalized.code, message: normalized.message };
    return { ok: true, provided: true, location: normalized.location };
  }
  return { ok: false, code: 'invalid_coordinates', message: 'La ubicación de entrega no es válida.' };
}

/**
 * Guarda (si hace falta) la ubicación que el operador eligió para un pedido, para
 * que quede en el historial del cliente con su procedencia.
 *
 * @param {any} ctx
 * @param {{ location: any, customerId: string|null, conversationId?: string|null, orderId: string|null }} input
 */
async function rememberOrderLocation(ctx, input) {
  if (!input.location) return null;
  const saved = await ctx.customers.saveLocation({
    location: input.location,
    customerId: input.customerId,
    conversationId: input.conversationId ?? null,
    orderId: input.orderId,
    // Reutilizar una ubicación existente no crea otra fila: ya está guardada.
    idempotencyKey: input.location.id
      ? `loc:reuse:${input.location.id}:${input.orderId ?? 'sin-pedido'}`
      : `loc:order:${input.orderId ?? newId('pedido')}`,
  });
  return saved.ok ? saved.location : null;
}

async function findOrderItem(store, orderId) {
  const items = await store.listAdmin({ limit: 5000 });
  const item = items.find((entry) => entry.id === orderId) ?? null;
  return item?.type === 'order_intent' ? item : null;
}

async function updateOrderStatus(store, item, status, actor = null) {
  const current = orderOf(item);
  if (!current) return null;
  const next = {
    ...current,
    status,
    updated_by_user_id: actor?.actor_type === 'USER' ? actor.id : current.updated_by_user_id ?? null,
    updated_by_display_name_snapshot:
      actor?.actor_type === 'USER' ? actor.display_name : current.updated_by_display_name_snapshot ?? null,
    updated_at: new Date().toISOString(),
  };
  const updated = await store.update(item.id, { status, orderJson: JSON.stringify(next) });
  return { item: updated, order: orderOf(updated) ?? next };
}

function canReadTracking(actor, session) {
  return hasPermission(actor, 'delivery.location.read_all') || session.delivery_user_id === actor?.id;
}

function canUpdateTracking(actor, session) {
  return hasPermission(actor, 'delivery.tracking.manage_all') || session.delivery_user_id === actor?.id;
}

async function publicSessionWithOrder(ctx, session) {
  const item = await findOrderItem(ctx.store, session.order_id);
  const order = orderOf(item);
  const customer = order?.customer_id ? await ctx.customers.get(order.customer_id) : null;
  return {
    ...publicTrackingSession(session, { destination: session.destination ?? orderDestination(order) }),
    order: order
      ? {
          id: order.id,
          order_number: order.order_number,
          status: order.status,
          total: order.total,
          customer_id: order.customer_id,
          conversation_id: order.conversation_id,
        }
      : null,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          phone_e164: customer.phone_e164,
        }
      : null,
  };
}

async function emitDeliveryEvent(ctx, type, session) {
  if (!ctx.deliveryEventClients?.size || !session) return;
  const payload = await publicSessionWithOrder(ctx, session);
  const event = `event: ${type}\ndata: ${JSON.stringify({ ok: true, type, session: payload })}\n\n`;
  for (const client of [...ctx.deliveryEventClients]) {
    if (!canReadTracking(client.actor, session)) continue;
    try {
      client.res.write(event);
    } catch {
      ctx.deliveryEventClients.delete(client);
    }
  }
}

async function listVisibleTracking(ctx, actor) {
  const rows = await ctx.db.list('delivery_tracking_sessions', { by: 'started_at', order: 'desc', limit: 500 });
  const visible = rows.filter((row) => canReadTracking(actor, row));
  const out = [];
  for (const row of visible) out.push(await publicSessionWithOrder(ctx, row));
  return out;
}

async function assignDeliveryToOrder(ctx, item, deliveryUser, actor = null) {
  const current = orderOf(item);
  if (!current) return null;
  const previousUserId = text(current.delivery?.delivery_user_id, 80);
  const sameDelivery = previousUserId && previousUserId === deliveryUser?.id;
  const assignmentVersion = sameDelivery
    ? Number(current.delivery?.delivery_assignment_version ?? 1)
    : Number(current.delivery?.delivery_assignment_version ?? 0) + 1;
  const status =
    previousUserId && previousUserId !== deliveryUser?.id
      ? DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT
      : current.delivery?.delivery_status ?? DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT;
  const next = {
    ...current,
    delivery: {
      ...(current.delivery ?? {}),
      delivery_user_id: deliveryUser?.id ?? null,
      delivery_user_name_snapshot: deliveryUser?.display_name ?? null,
      delivery_assigned_at: deliveryUser ? ctx.clock().toISOString() : null,
      delivery_assigned_by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
      delivery_status: status,
      delivery_contacted_at: previousUserId && previousUserId !== deliveryUser?.id ? null : current.delivery?.delivery_contacted_at ?? null,
      delivery_assignment_version: assignmentVersion,
      delivery_previous_user_id: previousUserId && previousUserId !== deliveryUser?.id ? previousUserId : current.delivery?.delivery_previous_user_id ?? null,
    },
    updated_at: ctx.clock().toISOString(),
  };
  const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
  const order = orderOf(updated) ?? next;
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: previousUserId && previousUserId !== deliveryUser?.id ? 'order.delivery_reassigned' : 'order.delivery_assigned',
    actor: actor?.display_name ?? null,
    summary: `Delivery asignado a ${deliveryUser?.display_name ?? 'sin asignar'}`,
    data: {
      previous_delivery_user_id: previousUserId ?? null,
      delivery_user_id: deliveryUser?.id ?? null,
      assignment_version: assignmentVersion,
    },
    idempotencyKey: `delivery-assignment-audit:${item.id}:${deliveryUser?.id ?? 'none'}:${assignmentVersion}`,
  });
  if (deliveryUser && !sameDelivery) {
    await createDeliveryAssignmentNotification(ctx, { item: updated, order, deliveryUser, actor, reassigned: Boolean(previousUserId && previousUserId !== deliveryUser.id) });
  }
  return { item: updated, order };
}

function deliveryStatusOf(order) {
  return order?.delivery?.delivery_status ?? DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT;
}

function canOpenDeliveryOrder(actor, order) {
  return hasPermission(actor, 'delivery.tracking.manage_all') || order?.delivery?.delivery_user_id === actor?.id;
}

function orderDeliveryDeepLink(orderId) {
  return `/admin/?v=delivery&order=${encodeURIComponent(orderId)}`;
}

function publicDeliveryOrder(item, order, customer = null, conversation = null) {
  return {
    id: item.id,
    order_id: item.id,
    order_number: order?.order_number ?? item.order_number ?? item.id,
    status: order?.status ?? item.status ?? 'nuevo',
    total: order?.total ?? item.total ?? null,
    currency: order?.currency ?? item.currency ?? 'DOP',
    payment_method: order?.payment_method ?? null,
    payment_method_label: order?.payment_method_label ?? null,
    items: order?.items ?? [],
    notes: order?.notes ?? item.notes ?? null,
    customer_id: order?.customer_id ?? item.customer_id ?? null,
    conversation_id: order?.conversation_id ?? item.conversation_id ?? conversation?.id ?? null,
    customer: customer
      ? { id: customer.id, name: customer.name, phone_e164: customer.phone_e164 }
      : { id: order?.customer_id ?? item.customer_id ?? null, name: item.name ?? null, phone_e164: item.phone ?? null },
    delivery: order?.delivery ?? {},
    delivery_status: deliveryStatusOf(order),
    deep_link: orderDeliveryDeepLink(item.id),
  };
}

async function visibleDeliveryOrders(ctx, actor) {
  const items = await ctx.store.listAdmin({ limit: 5000 });
  const orders = [];
  for (const item of items.filter((row) => row.type === 'order_intent')) {
    const order = orderOf(item);
    if (!order?.delivery?.location) continue;
    if (['entregado', 'cancelado', 'perdido'].includes(order.status)) continue;
    if (!canOpenDeliveryOrder(actor, order)) continue;
    const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
    const conversation = order.conversation_id ? await findConversation(ctx, order.conversation_id) : null;
    orders.push(publicDeliveryOrder(item, order, customer, conversation));
  }
  return orders;
}

async function createUserNotification(ctx, input) {
  const at = ctx.clock().toISOString();
  const doc = {
    id: newId('not'),
    recipient_user_id: input.recipientUserId,
    type: input.type,
    title: input.title,
    body: input.body,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    deep_link: input.deepLink ?? null,
    data: input.data ?? null,
    status: 'unread',
    read_at: null,
    created_at: at,
    updated_at: at,
    idempotency_key: input.idempotencyKey ?? null,
  };
  const result = await ctx.db.insert('user_notifications', doc);
  return result.duplicate ? { duplicate: true, notification: await ctx.db.findBy('user_notifications', 'idempotency_key', doc.idempotency_key) } : { duplicate: false, notification: result.doc };
}

async function listUserNotifications(ctx, actor, options = {}) {
  if (!actor?.id) return [];
  const rows = await ctx.db.list('user_notifications', { by: 'created_at', order: 'desc', limit: options.limit ?? 100 });
  return rows
    .filter((row) => hasPermission(actor, 'delivery.tracking.manage_all') || row.recipient_user_id === actor.id)
    .map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      deep_link: row.deep_link,
      data: row.data ?? null,
      status: row.status,
      read_at: row.read_at ?? null,
      created_at: row.created_at,
    }));
}

async function sendPushForNotification(ctx, notification) {
  const subscriptions = (await ctx.db.list('push_subscriptions', { limit: 1000 })).filter(
    (row) => row.user_id === notification.recipient_user_id && row.active !== false,
  );
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    orderId: notification.entity_type === 'order' ? notification.entity_id : null,
    conversationId: notification.entity_type === 'conversation' ? notification.entity_id : notification.data?.conversation_id ?? null,
    deepLink: notification.deep_link,
    type: notification.type,
    vibrate: notification.data?.vibrate ?? null,
  });
  for (const subscription of subscriptions) {
    const key = `push:${notification.id}:${subscription.endpoint}`;
    const existing = await ctx.db.findBy('push_jobs', 'idempotency_key', key);
    if (existing) continue;
    let status = 'not_configured';
    let error = null;
    if (WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys ?? {},
          },
          payload,
        );
        status = 'sent';
        await ctx.db.update('push_subscriptions', subscription.id, { last_used_at: ctx.clock().toISOString(), active: true });
      } catch (err) {
        status = err?.statusCode === 404 || err?.statusCode === 410 ? 'expired' : 'failed';
        error = { statusCode: err?.statusCode ?? null, message: err?.message ?? 'push_failed' };
        if (status === 'expired') await ctx.db.update('push_subscriptions', subscription.id, { active: false, disabled_at: ctx.clock().toISOString(), last_error: error });
      }
    }
    await ctx.db.insert('push_jobs', {
      id: newId('psh'),
      notification_id: notification.id,
      user_id: notification.recipient_user_id,
      endpoint: subscription.endpoint,
      status,
      error,
      idempotency_key: key,
      created_at: ctx.clock().toISOString(),
      updated_at: ctx.clock().toISOString(),
    });
  }
}

function whatsappDeepLink(conversationId) {
  return `/admin/?v=whatsapp&conversation=${encodeURIComponent(conversationId)}`;
}

function notificationSafeName(customer, fallback = 'Cliente') {
  return String(customer?.name ?? customer?.phone_e164 ?? customer?.phone ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
}

function whatsappMessagePreview(message) {
  const type = String(message?.type ?? 'text').toLowerCase();
  if (type === 'image') return 'Foto';
  if (type === 'audio' || type === 'voice') return 'Nota de voz';
  if (type === 'video') return 'Video';
  if (type === 'location') return 'Ubicación';
  if (type === 'document') return 'Documento';
  if (type === 'sticker') return 'Sticker';
  const clean = String(message?.body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 120) : 'Nuevo mensaje';
}

async function whatsappNotificationRecipients(ctx, conversation) {
  if (!conversation?.id) return [];
  const users = (await ctx.users.listUsers()).filter((user) => user.active !== false && hasPermission(user, 'chats.read'));
  if (conversation.assigned_user_id) {
    return users.filter((user) => user.id === conversation.assigned_user_id);
  }
  return users.filter((user) => user.role === 'ADMIN' || hasPermission(user, 'chats.take_unassigned'));
}

async function notifyWhatsappInboundMessage(ctx, result) {
  const conversation = result.conversation?.id ? (await findConversation(ctx, result.conversation.id)) ?? result.conversation : result.conversation;
  const message = result.message;
  if (!conversation?.id || !message?.wa_message_id || message.direction !== 'inbound') return [];
  const customer = result.customer ?? (conversation.customer_id ? await ctx.customers.get(conversation.customer_id) : null);
  const recipients = await whatsappNotificationRecipients(ctx, conversation);
  const customerName = notificationSafeName(customer, 'Cliente');
  const created = [];
  for (const user of recipients) {
    const note = await createUserNotification(ctx, {
      recipientUserId: user.id,
      type: 'WHATSAPP_MESSAGE_RECEIVED',
      title: `Nuevo mensaje · ${customerName}`,
      body: whatsappMessagePreview(message),
      entityType: 'conversation',
      entityId: conversation.id,
      deepLink: whatsappDeepLink(conversation.id),
      data: {
        conversation_id: conversation.id,
        customer_id: customer?.id ?? conversation.customer_id ?? null,
        message_id: message.id,
        wa_message_id: message.wa_message_id,
        vibrate: [150, 80, 150],
      },
      idempotencyKey: `whatsapp-inbound:${message.wa_message_id}:${user.id}`,
    });
    if (note.notification && !note.duplicate) {
      await sendPushForNotification(ctx, note.notification);
      created.push(note.notification);
    }
  }
  return created;
}

async function createDeliveryAssignmentNotification(ctx, { item, order, deliveryUser, actor, reassigned = false }) {
  const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
  const version = order.delivery?.delivery_assignment_version ?? 1;
  const title = reassigned ? 'Pedido reasignado para entregar' : 'Nuevo pedido para entregar';
  const body = `${customer?.name ?? item.name ?? 'Cliente'} · Pendiente de contactar`;
  const created = await createUserNotification(ctx, {
    recipientUserId: deliveryUser.id,
    type: reassigned ? 'DELIVERY_ORDER_REASSIGNED' : 'DELIVERY_ORDER_ASSIGNED',
    title,
    body,
    entityType: 'order',
    entityId: item.id,
    deepLink: orderDeliveryDeepLink(item.id),
    data: {
      order_id: item.id,
      order_number: order.order_number ?? item.order_number ?? null,
      customer_name: customer?.name ?? item.name ?? null,
      delivery_status: deliveryStatusOf(order),
      assignment_version: version,
      assigned_by_user_id: actor?.id ?? null,
    },
    idempotencyKey: `delivery-order-assigned:${item.id}:${deliveryUser.id}:${version}`,
  });
  if (created.notification && !created.duplicate) await sendPushForNotification(ctx, created.notification);
  return created.notification;
}

async function notifyDeliveryOrderCancelled(ctx, item, order, actor = null) {
  const deliveryUserId = order?.delivery?.delivery_user_id;
  if (!deliveryUserId) return null;
  const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
  const created = await createUserNotification(ctx, {
    recipientUserId: deliveryUserId,
    type: 'DELIVERY_ORDER_CANCELLED',
    title: 'Pedido cancelado',
    body: `${customer?.name ?? item.name ?? 'Cliente'} · Ya no debes entregar este pedido`,
    entityType: 'order',
    entityId: item.id,
    deepLink: orderDeliveryDeepLink(item.id),
    data: {
      order_id: item.id,
      order_number: order.order_number ?? item.order_number ?? null,
      delivery_status: DELIVERY_OPERATIONAL_STATUSES.CANCELLED,
      cancelled_by_user_id: actor?.id ?? null,
    },
    idempotencyKey: `delivery-order-cancelled:${item.id}:${deliveryUserId}`,
  });
  if (created.notification && !created.duplicate) await sendPushForNotification(ctx, created.notification);
  return created.notification;
}

function deliveryIdentityHeader(user) {
  const name = text(user?.display_name, 120) ?? 'Delivery';
  return `*${name} · Delivery*`;
}

function messageNeedsDeliveryIdentity(order, actor) {
  if (!order || actor?.role !== 'DELIVERY') return false;
  if (order.delivery?.delivery_user_id !== actor.id) return false;
  return order.delivery?.delivery_contacted_by_user_id !== actor.id;
}

function withDeliveryIdentity(body, actor) {
  const header = deliveryIdentityHeader(actor);
  const clean = longText(body, 1200) ?? '';
  if (clean.trim().startsWith(header)) return clean;
  return `${header}\n${clean}`.slice(0, 1200);
}

async function deliveryOrderForConversation(ctx, conversation, actor) {
  if (!conversation?.id || actor?.role !== 'DELIVERY') return null;
  const items = await ctx.store.listAdmin({ limit: 5000 });
  const candidates = [];
  for (const item of items.filter((row) => row.type === 'order_intent' && row.conversation_id === conversation.id)) {
    const order = orderOf(item);
    if (order?.delivery?.delivery_user_id === actor.id && !['entregado', 'cancelado', 'perdido'].includes(order.status)) {
      candidates.push({ item, order });
    }
  }
  return (
    candidates.sort((a, b) => {
      const date = String(b.order.created_at ?? b.item.received_at ?? '').localeCompare(String(a.order.created_at ?? a.item.received_at ?? ''));
      if (date !== 0) return date;
      const pendingA = deliveryStatusOf(a.order) === DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT ? 1 : 0;
      const pendingB = deliveryStatusOf(b.order) === DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT ? 1 : 0;
      return pendingB - pendingA;
    })[0] ?? null
  );
}

async function markDeliveryContacted(ctx, item, order, actor) {
  if (!item || !order || actor?.role !== 'DELIVERY' || order.delivery?.delivery_user_id !== actor.id) return null;
  if (order.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.CONTACTED && order.delivery?.delivery_contacted_by_user_id === actor.id) return order;
  const next = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      delivery_status: DELIVERY_OPERATIONAL_STATUSES.CONTACTED,
      delivery_contacted_at: ctx.clock().toISOString(),
      delivery_contacted_by_user_id: actor.id,
      delivery_contacted_by_display_name_snapshot: actor.display_name ?? null,
    },
    updated_at: ctx.clock().toISOString(),
  };
  const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'order.delivery_contacted',
    actor: actor.display_name ?? null,
    summary: 'Delivery contactó al cliente',
    data: { delivery_user_id: actor.id, conversation_id: order.conversation_id ?? null },
    idempotencyKey: `delivery-contacted:${item.id}:${actor.id}:${order.delivery?.delivery_assignment_version ?? 1}`,
  });
  return orderOf(updated) ?? next;
}

/** Identificador aleatorio corto (mismo patrón que el resto del CRM). */
function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

async function ensureInventoryForSale(ctx, item) {
  if (!ctx.inventory) return { ok: true };
  const order = orderOf(item);
  const required =
    Number(order?.total_capsules) ||
    (order?.items ?? []).reduce((sum, line) => sum + (Number(line.totalCapsules) || 0), 0);
  const stock = await ctx.inventory.stock();
  if (stock.initialized && stock.current < required) {
    return {
      ok: false,
      status: 409,
      error: 'insufficient_stock',
      message: `Stock insuficiente: hay ${stock.current} cápsulas disponibles y este pedido requiere ${required}.`,
      available: stock.current,
      required,
    };
  }
  return { ok: true };
}

async function withSaleCancellationLock(orderId, work) {
  const previous = saleCancellationLocks.get(orderId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  saleCancellationLocks.set(orderId, queued);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (saleCancellationLocks.get(orderId) === queued) saleCancellationLocks.delete(orderId);
  }
}

function paymentMethodLabel(value) {
  return value ? PAYMENT_METHOD_LABELS[value] ?? value : null;
}

async function cancelSale(ctx, orderId, input = {}, actor = null) {
  return withSaleCancellationLock(orderId, async () => {
    const reason = longText(input.reason, 500);
    if (!reason) return { ok: false, status: 422, error: 'missing_reason', message: 'Escribe el motivo de cancelación.' };

    const rows = await ctx.store.listAdmin({ limit: 5000 });
    const current = rows.find((entry) => entry.id === orderId) ?? null;
    if (!current || current.type !== 'order_intent') return { ok: false, status: 404, error: 'not_found' };
    const order = orderOf(current);
    if (!order) return { ok: false, status: 422, error: 'invalid_order' };
    if (current.status === 'cancelado' || order.cancelled_at || order.inventory_restored_at) {
      return { ok: false, status: 409, error: 'already_cancelled', message: 'La venta ya fue cancelada.' };
    }
    if (!isCompletedPurchaseStatus(current.status)) {
      return { ok: false, status: 409, error: 'not_delivered_sale', message: 'Solo una venta entregada se cancela por esta ruta.' };
    }

    const inventory = ctx.inventory ? await ctx.inventory.reverseSale(current, `Cancelación de venta: ${reason}`) : { ok: true };
    if (!inventory.ok) {
      return {
        ok: false,
        status: inventory.error === 'insufficient_stock' ? 409 : 422,
        error: inventory.error ?? 'inventory_error',
        message: 'No se pudo restaurar el inventario.',
        inventory,
      };
    }

    const now = new Date().toISOString();
    const cancelledOrder = {
      ...order,
      status: 'cancelado',
      cancelled_at: now,
      cancelled_by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
      cancelled_by_display_name_snapshot: actor?.display_name ?? null,
      cancel_reason: reason,
      inventory_restored_at: now,
      payment_status: 'void',
      status_history: [...(order.status_history ?? []), { status: 'cancelado', at: now, reason }],
    };
    const updated = await ctx.store.update(orderId, {
      status: 'cancelado',
      notes: current.notes ?? order.notes ?? null,
      orderJson: JSON.stringify(cancelledOrder),
    });
    if (!updated) return { ok: false, status: 404, error: 'not_found' };

    if (current.customer_id) {
      await ctx.customers.refreshTotals(current.customer_id);
    }

    const inventoryLinesRestored = (order.items ?? []).map((line) => ({
      productId: line.product_id ?? line.variantId ?? 'phytoemagry',
      variantId: line.variantId ?? null,
      quantity: Number(line.quantity) || 0,
      capsules: Number(line.totalCapsules) || 0,
    }));
    await ctx.audit?.record({
      entity: 'sale',
      entityId: orderId,
      action: 'sale.cancelled',
      actor: actor?.display_name ?? null,
      summary: `Venta ${order.order_number ?? orderId} cancelada`,
      data: {
        saleId: orderId,
        cancelledBy: actor?.id ?? null,
        cancelledAt: now,
        reason,
        paymentMethod: order.payment_method ?? null,
        total: order.total ?? current.total ?? null,
        inventoryLinesRestored,
        inventoryMovementId: inventory.movement?.id ?? null,
      },
      idempotencyKey: `sale.cancelled:${orderId}`,
    });
    if (cancelledOrder.delivery?.delivery_user_id) {
      const deliveryCancelledOrder = {
        ...cancelledOrder,
        delivery: {
          ...(cancelledOrder.delivery ?? {}),
          delivery_status: DELIVERY_OPERATIONAL_STATUSES.CANCELLED,
        },
      };
      await ctx.store.update(orderId, { orderJson: JSON.stringify(deliveryCancelledOrder) });
      await notifyDeliveryOrderCancelled(ctx, updated, deliveryCancelledOrder, actor);
      return { ok: true, item: updated, order: deliveryCancelledOrder, inventory, inventoryLinesRestored };
    }
    return { ok: true, item: updated, order: cancelledOrder, inventory, inventoryLinesRestored };
  });
}

function orderFinancials(order) {
  const lines = order?.items ?? [];
  const productRevenueCents = lines.reduce(
    (sum, line) => sum + (Number(line.subtotal_snapshot_cents) || Math.trunc(Number(line.subtotal) || 0) * 100),
    0,
  );
  const productCostCents = lines.reduce((sum, line) => sum + (Number(line.product_cost_snapshot_cents) || 0), 0);
  const deliveryRevenueCents = Math.trunc(Number(order?.delivery_fee ?? order?.delivery?.fee ?? 0) || 0) * 100;
  return {
    product_revenue_cents: productRevenueCents,
    delivery_revenue_cents: deliveryRevenueCents,
    total_collected_cents: productRevenueCents + deliveryRevenueCents,
    product_cost_cents: productCostCents,
    gross_product_profit_cents: productRevenueCents - productCostCents,
  };
}

const SENSITIVE_FINANCIAL_KEY = /(^|_)(cost|profit|margin)(_|$)|purchaseCost|unitCost|grossProfit|netProfit|inventory_value/i;

function stripSensitiveFinancials(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveFinancials);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FINANCIAL_KEY.test(key)) continue;
    out[key] = stripSensitiveFinancials(item);
  }
  return out;
}

function sanitizeItemForPermissions(item, actor) {
  if (hasPermission(actor, 'cost.view')) return item;
  const clean = stripSensitiveFinancials(item);
  if (typeof clean.order_json === 'string') {
    try {
      clean.order_json = JSON.stringify(stripSensitiveFinancials(JSON.parse(clean.order_json)));
    } catch {
      clean.order_json = null;
    }
  }
  if (typeof clean.orderJson === 'string') {
    try {
      clean.orderJson = JSON.stringify(stripSensitiveFinancials(JSON.parse(clean.orderJson)));
    } catch {
      clean.orderJson = null;
    }
  }
  return clean;
}

function sanitizeOrderForPermissions(order, actor) {
  return hasPermission(actor, 'cost.view') ? order : stripSensitiveFinancials(order);
}

function sanitizeInventoryForPermissions(inventory, actor, extra = {}) {
  const payload = { ...inventory, ...extra };
  return hasPermission(actor, 'cost.view') ? payload : stripSensitiveFinancials(payload);
}

function conversationDateRange(query, clock = () => new Date()) {
  const validDay = (value) => {
    const textValue = String(value ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return null;
    const [year, month, date] = textValue.split('-').map(Number);
    const built = new Date(Date.UTC(year, month - 1, date));
    return built.toISOString().slice(0, 10) === textValue ? textValue : null;
  };
  const today = dayIn(clock(), TIME_ZONE);
  const requested = String(query.get('date') ?? '').trim().toLowerCase();
  if (requested && !['today', 'hoy', 'yesterday', 'ayer', '7d', 'last7', 'month', 'mes'].includes(requested)) {
    return { ok: false, error: 'invalid_date_filter' };
  }
  if (query.has('from') && !validDay(query.get('from'))) return { ok: false, error: 'invalid_from' };
  if (query.has('to') && !validDay(query.get('to'))) return { ok: false, error: 'invalid_to' };
  let from = validDay(query.get('from'));
  let to = validDay(query.get('to'));
  if (requested === 'today' || requested === 'hoy') from = to = today;
  if (requested === 'yesterday' || requested === 'ayer') from = to = addDays(today, -1);
  if (requested === '7d' || requested === 'last7') {
    from = addDays(today, -6);
    to = today;
  }
  if (requested === 'month' || requested === 'mes') {
    from = `${today.slice(0, 7)}-01`;
    to = today;
  }
  if (from && to && from > to) return { ok: false, error: 'invalid_date_range', from, to };
  return { ok: true, from, to };
}

/**
 * Crea un PEDIDO. Lo comparten `POST /api/admin/orders` (panel y conversación) y
 * `POST /api/admin/purchases` (compatibilidad): UNA sola forma de crear un pedido.
 *
 * Resuelve el cliente (por id o por teléfono), enlaza la conversación de la que
 * nace si procede, calcula el total con el catálogo y deja la traza de auditoría.
 * Si el pedido nace ya «entregado», dispara los efectos de una venta (Meta,
 * totales y plan de seguimiento), igual que al cambiar el estado a mano.
 *
 * @param {any} ctx
 * @param {any} body
 */
async function createOrder(ctx, body = {}, actor = null) {
  /** @type {any} */
  let customer = null;
  const customerId = text(body.customerId, 80);
  if (customerId) customer = await ctx.customers.get(customerId);
  if (!customer) {
    const found = await ctx.customers.findOrCreateByPhone({
      phone: body.phone,
      name: body.name,
      location: body.location,
      source: body.channel === 'whatsapp' ? 'whatsapp' : 'manual',
    });
    if (!found.ok) {
      return {
        ok: false,
        status: 422,
        error: 'invalid_phone',
        message: 'Escribe un teléfono válido (por ejemplo 809 555 1234).',
      };
    }
    customer = found.customer;
  }

  // La conversación solo se enlaza si es DE ESE cliente (nunca se cruza a otro).
  let conversation = null;
  let conversationId = text(body.conversationId, 80);
  if (conversationId) {
    conversation = await ctx.db.get('conversations', conversationId);
    conversationId = conversation && conversation.customer_id === customer.id ? conversation.id : null;
    if (!conversationId) conversation = null;
  }

  const paymentMethod = normalizePaymentMethod(body.paymentMethod ?? body.payment_method);
  if (!paymentMethod) {
    return {
      ok: false,
      status: 422,
      error: 'payment_method_required',
      message: 'Elige un método de pago.',
      methods: PAYMENT_METHODS,
    };
  }

  /** @type {{row: any, order: any}} */
  let built;
  /*
   * UBICACIÓN DE ENTREGA (opcional). Se resuelve ANTES de construir el pedido y
   * se guarda un snapshot dentro del pedido: si el cliente manda otra ubicación
   * después, este pedido sigue representando la que se usó (§14).
   */
  const entrega = await resolveOrderLocation(ctx, { customerId: customer.id, body });
  if (!entrega.ok) {
    return { ok: false, status: 422, error: entrega.code, message: entrega.message };
  }
  const manual = manualAttribution(body, actor);
  const automatic = conversation?.meta_attribution ? sourceFromAttribution(conversation.meta_attribution) : null;
  const attribution = automatic && !body.source && !body.saleSource && !body.orderSource ? automatic : manual;
  const snapshot = orderAttributionSnapshot({
    source: attribution.source,
    source_origin: attribution.source_origin,
    meta_attribution: automatic
      ? conversation.meta_attribution
      : manual.meta_attribution ?? (attribution.source === 'META_ADS' ? null : undefined),
  });

  try {
    built = purchaseRow({
      ...body,
      paymentMethod,
      customerId: customer.id,
      conversationId,
      name: customer.name ?? body.name,
      phone: customer.phone_e164 ?? customer.phone,
      location: customer.location ?? body.location,
      source: snapshot.source,
      sourceOrigin: snapshot.source_origin,
      metaAttributionSnapshot: snapshot.meta_attribution_snapshot,
      // GPS: nombre propio para no confundirlo con la ciudad heredada.
      gpsLocation: entrega.location,
    });
  } catch (error) {
    return {
      ok: false,
      status: 422,
      error: /** @type {any} */ (error).message,
      message: 'Elige un frasco del catálogo.',
    };
  }
  /*
   * La ubicación elegida queda en el HISTORIAL del cliente con su procedencia
   * (dispositivo del operador, coordenadas a mano o reutilizada), para poder
   * elegirla la próxima vez. Reutilizar una que ya existía no duplica filas.
   */
  await rememberOrderLocation(ctx, {
    location: entrega.location,
    customerId: customer.id,
    conversationId,
    orderId: built.row.id,
  });

  const requested = text(body.status, 20);
  const status = requested && isOrderStatus(requested) ? requested : 'nuevo';
  built.order.created_by_user_id = actor?.actor_type === 'USER' ? actor.id : null;
  built.order.created_by_display_name_snapshot = actor?.actor_type === 'USER' ? actor.display_name : null;
  built.order.updated_by_user_id = actor?.actor_type === 'USER' ? actor.id : null;
  built.row.orderJson = JSON.stringify(built.order);
  // Si el pedido nace ya ENTREGADO, queda registrada también su fecha de entrega.
  if (isCompletedPurchaseStatus(status)) {
    built.order.delivered_at = new Date().toISOString();
    built.row.orderJson = JSON.stringify(built.order);
    const check = await ensureInventoryForSale(ctx, { ...built.row, status, order_json: built.row.orderJson });
    if (!check.ok) return check;
  }
  const saved = await ctx.store.save(built.row);
  const item = await ctx.store.update(built.row.id, {
    status,
    notes: built.order.notes,
    customerId: customer.id,
    conversationId,
    createdByUserId: actor?.actor_type === 'USER' ? actor.id : null,
    createdByDisplayNameSnapshot: actor?.actor_type === 'USER' ? actor.display_name : null,
  });
  const finalItem = item ?? built.row;

  if (!customer.acquisition_source && snapshot.source) {
    customer = (await ctx.customers.update(customer.id, {
      acquisition_source: snapshot.source,
      acquisition_source_origin: snapshot.source_origin,
      acquisition_meta_attribution: snapshot.source === 'META_ADS' ? snapshot.meta_attribution_snapshot : null,
    })) ?? customer;
  }

  await ctx.audit?.record({
    entity: 'order',
    entityId: built.row.id,
    action: 'order.created',
    summary: `Pedido ${built.order.order_number} · ${built.order.units} frasco(s) · ${built.order.total} ${built.order.currency}`,
    data: {
      customer_id: customer.id,
      conversation_id: conversationId,
      total: built.order.total,
      payment_method: paymentMethod,
      status,
      origin: conversationId ? 'conversation' : 'panel',
      source: snapshot.source,
      source_origin: snapshot.source_origin,
      created_by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
    },
    idempotencyKey: `order.created:${built.row.id}`,
  });

  let delivered = null;
  if (isCompletedPurchaseStatus(status)) {
    delivered = await afterPurchaseDelivered(ctx, finalItem);
    await ctx.audit?.record({
      entity: 'order',
      entityId: built.row.id,
      action: 'order.status_changed',
      summary: `Pedido ${built.order.order_number} → entregado`,
      idempotencyKey: `order.status:${built.row.id}:entregado`,
    });
  }

  console.log(
    `[crm] pedido ${built.order.order_number} creado · ${customer.name ?? customer.phone_e164} · estado ${status}`,
  );
  const responseItem = delivered?.item ?? finalItem;
  return {
    ok: true,
    duplicate: saved.duplicate === true,
    item: responseItem,
    order: orderOf(responseItem) ?? built.order,
    customer,
    delivered,
    status,
  };
}

function typeLabel(type) {
  return type === 'order_intent' ? 'Pedido' : 'Contacto';
}

function messageActorFields(actor) {
  if (!actor) return { sentBy: 'panel', sentByUserId: null, sentByDisplayName: null, actorType: 'LEGACY' };
  if (actor.actor_type === 'USER') {
    return {
      sentBy: actor.display_name,
      sentByUserId: actor.id,
      sentByDisplayName: actor.display_name,
      actorType: 'USER',
    };
  }
  if (actor.actor_type === 'SYSTEM') {
    return { sentBy: 'system', sentByUserId: null, sentByDisplayName: 'Sistema', actorType: 'SYSTEM' };
  }
  return { sentBy: 'panel', sentByUserId: null, sentByDisplayName: actor.display_name ?? null, actorType: 'LEGACY' };
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

function revenueBySourceReport(items = []) {
  const groups = new Map();
  const ensure = (source) => {
    const key = SOURCE_LABELS[source] ? source : 'OTHER';
    if (!groups.has(key)) {
      groups.set(key, {
        source: key,
        label: SOURCE_LABELS[key] ?? key,
        orders: 0,
        completed_sales: 0,
        revenue: 0,
        average_ticket: 0,
        attributed_to_meta: 0,
        manually_marked_meta: 0,
      });
    }
    return groups.get(key);
  };
  for (const source of Object.keys(SOURCE_LABELS)) ensure(source);
  const metaCampaigns = new Map();
  const addBreakdown = (kind, id, row) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    const current = metaCampaigns.get(key) ?? { kind, id, sales: 0, revenue: 0 };
    current.sales += 1;
    current.revenue += Number(row.total) || 0;
    metaCampaigns.set(key, current);
  };
  for (const row of items.filter((item) => item.type === 'order_intent')) {
    const attr = readOrderAttribution(row);
    const group = ensure(attr.source);
    group.orders += 1;
    const completed = isCompletedPurchaseStatus(row.status);
    if (completed) {
      group.completed_sales += 1;
      group.revenue += Number(row.total) || 0;
      if (attr.source === 'META_ADS' && attr.source_origin === 'AUTO') group.attributed_to_meta += 1;
      if (attr.source === 'META_ADS' && attr.source_origin === 'MANUAL') group.manually_marked_meta += 1;
      const meta = attr.meta_attribution_snapshot ?? {};
      addBreakdown('campaign', meta.campaign_id ?? meta.utm_campaign, row);
      addBreakdown('adset', meta.adset_id, row);
      addBreakdown('ad', meta.ad_id ?? meta.utm_content, row);
    }
  }
  const sources = [...groups.values()].map((group) => ({
    ...group,
    average_ticket: group.completed_sales ? Math.round(group.revenue / group.completed_sales) : 0,
  }));
  const metaRevenue = groups.get('META_ADS')?.revenue ?? 0;
  return {
    sources,
    meta: {
      attributed_revenue: metaRevenue,
      ad_spend: null,
      roas: null,
      roas_status: 'WAITING_FOR_AD_SPEND',
      breakdown_available: metaCampaigns.size > 0,
      breakdown: [...metaCampaigns.values()].sort((a, b) => b.revenue - a.revenue),
    },
    rule: 'Interno: se agrupa por order.source; ingresos solo de pedidos con estado entregado. Meta decide su atribución publicitaria con su propia configuración.',
  };
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
 * @param {any} [input.audit]
 * @param {string} [input.source] motivo (diagnóstico)
 */
export async function sendPurchaseToMeta({ store, metaCapi, item, audit = null, source = 'estado' }) {
  if (!metaCapi?.enabled) return { ok: false, skipped: true, reason: 'not_configured' };
  // Idempotencia: si ya se envió, no se vuelve a enviar jamás.
  if (item.meta_purchase_sent_at) return { ok: false, skipped: true, reason: 'already_sent' };

  const eventId = purchaseEventId(item);
  const payload = parsePayload(item);
  const attribution = payload.attribution ?? {};
  const attempts = Number(item.meta_purchase_attempts ?? 0);
  await audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'meta.purchase_queued',
    summary: `Purchase ${eventId} en cola para Meta`,
    data: { order_id: item.id, event_id: eventId, attempt: attempts + 1, source },
    idempotencyKey: `meta.purchase_queued:${item.id}:${attempts + 1}`,
  });
  await store.update(item.id, {
    metaPurchaseEventId: eventId,
    metaPurchaseStatus: 'pending',
    metaPurchaseError: null,
  });
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
  await audit?.record({
    entity: 'order',
    entityId: item.id,
    action: result.ok ? 'meta.purchase_sent' : 'meta.purchase_failed',
    summary: result.ok ? `Purchase ${eventId} enviado a Meta` : `Purchase ${eventId} falló en Meta`,
    data: {
      order_id: item.id,
      event_id: eventId,
      attempt: attempts + 1,
      status: result.status ?? null,
      error: result.ok ? null : result.error ?? null,
      response: result.response ?? null,
    },
    idempotencyKey: `meta.purchase_${result.ok ? 'sent' : 'failed'}:${item.id}:${attempts + 1}`,
  });
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
async function retryPendingPurchases(store, metaCapi, log = console.log, audit = null) {
  if (!metaCapi?.enabled || !store?.listAdmin) return;
  const items = await store.listAdmin({ limit: 200 });
  const pending = items.filter(
    (item) =>
      item.type === 'order_intent' &&
      isCompletedPurchaseStatus(item.status) &&
      !item.meta_purchase_sent_at &&
      Number(item.meta_purchase_attempts ?? 0) < META_PURCHASE_MAX_ATTEMPTS,
  );
  if (pending.length === 0) return;
  log(`[crm] Meta: reintentando ${pending.length} venta(s) pendiente(s)`);
  for (const item of pending.slice(0, 10)) {
    await sendPurchaseToMeta({ store, metaCapi, item, audit, source: 'reintento' });
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
    (item) => item.type === 'order_intent' && isCompletedPurchaseStatus(item.status) && item.customer_id,
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
  const result = { meta: null, totals: null, followups: null, nextFollowupAt: null, inventory: null, item };
  if (ctx.inventory) {
    const inventory = await ctx.inventory.recordSale(item);
    if (!inventory.ok) {
      const error = Object.assign(new Error(inventory.error ?? 'inventory_error'), { inventory });
      throw error;
    }
    result.inventory = inventory;
    if (inventory.order) {
      const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(inventory.order) });
      if (updated) {
        item = updated;
        result.item = updated;
      }
    }
  }
  if (ctx.metaCapi?.enabled && !item.meta_purchase_sent_at) {
    result.meta = await sendPurchaseToMeta({ store: ctx.store, metaCapi: ctx.metaCapi, item, audit: ctx.audit, source: 'estado' });
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
    conversationId: item.conversation_id ?? null,
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
    const metaAttribution = captureMetaReferral(inbound, inbound.receivedAt);
    if (metaAttribution && hasAutomaticMetaEvidence(metaAttribution)) {
      if (result.conversation?.id) {
        await ctx.db.update('conversations', result.conversation.id, {
          source: 'META_ADS',
          source_origin: 'AUTO',
          meta_attribution: metaAttribution,
          updated_at: new Date().toISOString(),
        });
      }
      if (result.customer?.id && !result.customer.acquisition_source) {
        await ctx.customers.update(result.customer.id, {
          acquisition_source: 'META_ADS',
          acquisition_source_origin: 'AUTO',
          acquisition_meta_attribution: metaAttribution,
        });
      }
      await ctx.audit?.record({
        entity: 'conversation',
        entityId: result.conversation?.id ?? result.message?.conversation_id ?? inbound.waMessageId,
        action: 'conversation.meta_attribution_detected',
        summary: 'Conversación atribuida automáticamente a Meta Ads',
        data: {
          customer_id: result.customer?.id ?? null,
          wa_message_id: inbound.waMessageId,
          evidence: Object.keys(metaAttribution).filter((key) => key !== 'referral_payload'),
        },
        idempotencyKey: `conversation.meta-attribution:${inbound.waMessageId}`,
      });
    }
    try {
      await notifyWhatsappInboundMessage(ctx, result);
    } catch (error) {
      console.error('[crm] notificación WhatsApp:', error?.message ?? error);
    }
    const who = result.customer?.name ?? result.customer?.phone_e164 ?? inbound.fromE164;
    console.log(
      `[crm] WhatsApp entrante de ${who} · intención ${result.intent}` +
        (result.optOut ? ' · pidió NO CONTACTAR' : '') +
        (result.cancelledFollowups ? ` · ${result.cancelledFollowups} seguimiento(s) cancelado(s)` : ''),
    );
    if (result.humanRequired) console.log('[crm] esa conversación queda para una persona (no es una pregunta simple)');
    /*
     * MULTIMEDIA: el mensaje y la conversación ya están guardados. El archivo se
     * descarga DESPUÉS y en segundo plano, así que un R2 lento o caído no puede
     * hacer que Meta reintente el webhook ni retrasar la respuesta. Si algo falla,
     * la fila de media queda en FAILED, el mensaje sigue en la conversación y el
     * panel ofrece reintentar.
     */
    if (inbound.media?.waMediaId && ctx.media?.pipeline) {
      const contexto = { messageId: result.message.id, conversationId: result.conversation?.id ?? null, media: inbound.media };
      ctx.media.pipeline
        .processInbound(contexto)
        .then((outcome) => {
          if (!outcome.ok) {
            console.warn(`[media] ${inbound.media.kind} de ${who} no se pudo guardar: ${outcome.error?.code ?? 'error'}`);
          }
        })
        .catch((error) => console.error('[media] entrante:', error?.message ?? error));
    }
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

function signUserSession(sessionId, userId, expiresAt, secret) {
  return createHmac('sha256', secret).update(`user:${sessionId}:${userId}:${expiresAt}`).digest('base64url');
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

function createUserSessionValue(session, secret) {
  const expiresAt = Math.floor(Date.parse(session.expires_at) / 1000);
  const signature = signUserSession(session.id, session.user_id, expiresAt, secret);
  return `v2.${session.id}.${session.user_id}.${expiresAt}.${signature}`;
}

function parseUserSessionValue(value, secret) {
  if (!secret || typeof value !== 'string' || !value.startsWith('v2.')) return null;
  const [, sessionId, userId, rawExpires, signature] = value.split('.');
  const expiresAt = Number.parseInt(rawExpires ?? '', 10);
  if (!sessionId || !userId || !Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return null;
  const expected = signUserSession(sessionId, userId, expiresAt, secret);
  if (!tokenOk(signature, expected)) return null;
  return { sessionId, userId, expiresAt };
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

  const cookieValue = readCookie(req, COOKIE);
  const parsedUserSession = parseUserSessionValue(cookieValue, token);
  const sessionIdentity = parsedUserSession ? await ctx.users.sessionUser(parsedUserSession.sessionId) : null;
  const legacyAuthenticated = !sessionIdentity && sessionValid(cookieValue, token);
  const authenticated = Boolean(sessionIdentity || legacyAuthenticated);
  const currentUser = sessionIdentity?.user ?? null;
  const actor = currentUser
    ? { id: currentUser.id, role: currentUser.role, display_name: currentUser.display_name, actor_type: 'USER' }
    : legacyAuthenticated
      ? { id: 'LEGACY_PANEL', role: 'ADMIN', display_name: 'Panel legacy', actor_type: 'LEGACY' }
      : null;

  const forbid = (message = 'No tienes permiso para esta acción.') =>
    json(res, 403, { ok: false, error: 'forbidden', message });
  const can = (permission) => hasPermission(actor, permission);
  const requirePermission = (permission, message) => {
    if (can(permission)) return true;
    forbid(message);
    return false;
  };
  const requireAdmin = () => {
    if (can('admin.full')) return true;
    forbid();
    return false;
  };
  const authPayload = () => ({
    user: currentUser,
    legacy: Boolean(legacyAuthenticated),
    permissions: permissionsForRole(actor?.role),
  });

  // ------------------------------------------------------------- el panel
  if ((route === '/api/admin/login' || route === '/api/admin/auth/login') && req.method === 'POST') {
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
    if (body.username !== undefined || body.password !== undefined) {
      const result = await ctx.users.login({
        username: body.username,
        password: body.password,
        ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      if (!result.ok) {
        registerLoginFailure(ip);
        json(res, 401, { ok: false, error: 'invalid_credentials', message: 'Usuario o contraseña incorrectos.', storage: store.kind });
        return;
      }
      loginAttempts.delete(ip);
      setSessionCookie(req, res, createUserSessionValue(result.session, token));
      json(res, 200, { ok: true, storage: store.kind, user: result.user });
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

  if ((route === '/api/admin/logout' || route === '/api/admin/auth/logout') && req.method === 'POST') {
    if (sessionIdentity?.session?.id) await ctx.users.revokeSession(sessionIdentity.session.id, currentUser);
    setSessionCookie(req, res, '');
    json(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/session') {
    json(res, 200, {
      ok: authenticated,
      storage: store.kind,
      timeZone: TIME_ZONE,
      ...authPayload(),
    });
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
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      const origin = String(req.headers.origin ?? '').trim();
      const host = String(req.headers.host ?? '').trim();
      const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').trim();
      if (origin) {
        let okOrigin = false;
        try {
          const originHost = new URL(origin).host;
          okOrigin = [host, forwardedHost].filter(Boolean).includes(originHost);
        } catch {
          okOrigin = false;
        }
        if (!okOrigin) {
          json(res, 403, { ok: false, error: 'csrf', message: 'Origen no permitido.' });
          return;
        }
      }
    }

    if (route === '/api/admin/auth/me' && req.method === 'GET') {
      json(res, 200, { ok: true, ...authPayload() });
      return;
    }

    if (route === '/api/admin/users' && req.method === 'GET') {
      if (!requireAdmin()) return;
      json(res, 200, { ok: true, users: await ctx.users.listUsers() });
      return;
    }

    if (route === '/api/admin/users' && req.method === 'POST') {
      if (!requireAdmin()) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.users.createUser({
        username: body.username ?? body.email,
        password: body.password,
        firstName: body.firstName ?? body.first_name,
        lastName: body.lastName ?? body.last_name,
        displayName: body.displayName ?? body.display_name,
        role: ['ADMIN', 'AGENT', 'DELIVERY', 'OPERADOR'].includes(String(body.role)) ? String(body.role) : 'AGENT',
        active: body.active !== false,
        createdBy: actor?.id ?? null,
        actorName: actor?.display_name ?? null,
      });
      if (!result.ok) {
        json(res, result.error === 'duplicate_user' ? 409 : 422, { ok: false, error: result.error });
        return;
      }
      json(res, 201, { ok: true, user: result.user });
      return;
    }

    if (route === '/api/admin/users/me/password' && req.method === 'POST') {
      if (!currentUser) {
        json(res, 409, { ok: false, error: 'legacy_session', message: 'Entra con usuario y contraseña para cambiar tu clave.' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      if (body.newPassword !== body.confirmPassword) {
        json(res, 422, { ok: false, error: 'password_mismatch' });
        return;
      }
      const result = await ctx.users.changeOwnPassword(currentUser.id, body.currentPassword, body.newPassword, currentUser);
      if (!result.ok) {
        /*
         * Una contraseña actual equivocada NO es una sesión caducada: 401 haría
         * que el panel cerrara la sesión y echara a la persona a la pantalla de
         * entrada. Es un dato inválido del formulario (422).
         */
        json(res, 422, {
          ok: false,
          error: result.error,
          message:
            result.error === 'invalid_password'
              ? 'La contraseña actual no es correcta.'
              : 'La contraseña nueva necesita al menos 10 caracteres.',
        });
        return;
      }
      setSessionCookie(req, res, '');
      json(res, 200, { ok: true });
      return;
    }

    /*
     * MI PERFIL: quien tiene la sesión cambia SUS datos (nombre visible, nombre y
     * apellido). Es el ÚNICO camino para que un agente toque un usuario — y solo
     * el suyo: el id sale de la sesión, nunca del cuerpo. Rol, estado y clave no
     * existen en esta ruta a propósito (nadie se asciende a sí mismo).
     */
    if (route === '/api/admin/users/me' && (req.method === 'PATCH' || req.method === 'POST')) {
      if (!currentUser) {
        json(res, 409, {
          ok: false,
          error: 'legacy_session',
          message: 'Entra con tu usuario y tu contraseña para tener tu propio perfil.',
        });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const patch = {};
      if (body.displayName !== undefined || body.display_name !== undefined) {
        patch.displayName = body.displayName ?? body.display_name;
      }
      if (body.firstName !== undefined || body.first_name !== undefined) {
        patch.firstName = body.firstName ?? body.first_name;
      }
      if (body.lastName !== undefined || body.last_name !== undefined) {
        patch.lastName = body.lastName ?? body.last_name;
      }
      if (!Object.keys(patch).length) {
        json(res, 422, { ok: false, error: 'nothing_to_update', message: 'No hay nada que cambiar.' });
        return;
      }
      const result = await ctx.users.updateUser(currentUser.id, patch, actor);
      if (!result.ok) {
        json(res, result.error === 'not_found' ? 404 : 422, {
          ok: false,
          error: result.error,
          message: result.error === 'invalid_user' ? 'El nombre visible no puede quedar vacío.' : null,
        });
        return;
      }
      json(res, 200, { ok: true, user: result.user });
      return;
    }

    if (route.startsWith('/api/admin/users/') && (req.method === 'PATCH' || req.method === 'POST')) {
      if (!requireAdmin()) return;
      const userId = decodeURIComponent(route.slice('/api/admin/users/'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.users.updateUser(userId, body, actor);
      if (!result.ok) {
        json(res, result.error === 'last_admin' ? 409 : result.error === 'not_found' ? 404 : 422, {
          ok: false,
          error: result.error,
        });
        return;
      }
      json(res, 200, { ok: true, user: result.user });
      return;
    }

    /*
     * MULTIMEDIA (S3): `GET /api/admin/media/:id`, `POST /api/admin/media/retry/:id`
     * y `POST /api/admin/conversations/:id/media`. Va ANTES del resto de rutas de
     * conversaciones porque comparte su prefijo; el módulo decide si la petición es
     * suya y, si lo es, la atiende (y vuelve a comprobar la sesión).
     */
    if (ctx.handleMediaRoute && (await ctx.handleMediaRoute({ route, req, res, url }))) return;

    // Todo lo que necesita el panel en una sola petición (móvil con mala señal).
    if (route === '/api/admin/data' && req.method === 'GET') {
      const items = (await store.listAdmin({ limit: 500 })).map((item) => sanitizeItemForPermissions(item, actor));
      const messages = await store.messages().list();
      const customerList = await ctx.customers.list({});
      const conversationList = await ctx.customers.listConversations({});
      const conversationCounts = await ctx.customers.conversationCounts();
      await ctx.customers.ensureInitialTags();
      const buckets = await ctx.followups.buckets();
      const outbound = await ctx.db.list('wa_messages', { limit: 500 });
      const failed = outbound.filter((row) => row.status === 'failed');
      /*
       * Operaciones de archivo que quedaron AMBIGUAS (se intentó enviar y no hay
       * confirmación) o a medias por una caída. Lista corta, saneada y solo para
       * administración: un envío ambiguo NO se reintenta solo ni se ofrece como
       * botón en la conversación.
       */
      /** @type {any[]} */
      const mediaNeedsReview = [];
      if (ctx.media?.store?.listBySendStatus) {
        for (const status of [SEND_STATUS.SEND_UNKNOWN, SEND_STATUS.SENDING]) {
          const rows = await ctx.media.store.listBySendStatus(status, 10);
          for (const row of rows) {
            mediaNeedsReview.push({
              id: row.id,
              message_id: row.message_id,
              media_type: row.media_type,
              send_status: row.send_status,
              send_attempted_at: row.send_attempted_at,
              sent_at: row.sent_at,
              http_status: row.http_status,
              safe_code: row.safe_code,
              error_at: row.error_at,
              created_at: row.created_at,
            });
          }
        }
      }
      const inventory = sanitizeInventoryForPermissions(await ctx.inventory.catalog(), actor);
      json(res, 200, {
        ok: true,
        storage: store.kind,
        timeZone: TIME_ZONE,
        auth: authPayload(),
        statuses: STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] ?? value })),
        items,
        messages,
        stats: computeStats(items, TIME_ZONE),
        salesAttribution: revenueBySourceReport(items),
        pendientes: dueToday(items, TIME_ZONE).map((item) => item.id),
        // Estado de Meta SIN secretos: el panel solo necesita saber si está activo.
        meta: {
          configured: Boolean(ctx.metaCapi?.enabled),
          testEventCode: Boolean(ctx.metaCapi?.hasTestEventCode),
          purchaseStatus: ctx.purchaseStatus,
          businessCompletedPurchaseStatus: BUSINESS_COMPLETED_PURCHASE_STATUS,
          graphVersion: ctx.metaCapi?.graphVersion ?? null,
        },
        // ------------------------------------------------ clientes y WhatsApp
        customers: customerList,
        conversations: conversationList,
        conversationCounts,
        followups: {
          reference: buckets.reference,
          today: buckets.today,
          overdue: buckets.overdue,
          upcoming: buckets.upcoming,
          completed: buckets.completed.slice(-20),
          // Plan base + interruptores: los Ajustes los usan tal cual.
          plan: ctx.followups.plan,
          enabled: (await ctx.settings.followup()).enabled,
        },
        // --------------------------------------- ventas: programados y ajustes
        scheduled: await ctx.scheduler.summary(),
        settings: { followup: (await ctx.settings.followup()).enabled },
        commercial: {
          states: COMMERCIAL_STATES,
          manual: MANUAL_COMMERCIAL_STATES,
          deprecated: 'commercial_state se mantiene por compatibilidad; la UI nueva debe usar customerStage.',
        },
        customerStages: CUSTOMER_STAGES.map((value) => ({ value, label: CUSTOMER_STAGE_LABELS[value] ?? value })),
        customerTags: await ctx.customers.listTags(),
        deliveryTracking: await listVisibleTracking(ctx, actor),
        deliveryOrders: await visibleDeliveryOrders(ctx, actor),
        deliveryUsers: can('delivery.tracking.manage_all') ? (await ctx.users.listUsers()).filter((user) => user.role === 'DELIVERY' && user.active !== false) : [],
        notifications: await listUserNotifications(ctx, actor),
        push: {
          publicKey: WEB_PUSH_PUBLIC_KEY || null,
          configured: Boolean(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY),
        },
        paymentMethods: PAYMENT_METHODS.map((value) => ({ value, label: paymentMethodLabel(value) })),
        // Catálogo, inventario y estado comercial, sin repetir precios ni estados en el panel.
        catalog: inventory.presentations,
        inventory,
        orderStatuses: Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label })),
        audit: await ctx.audit.summary(),
        // Pantalla HOY: lo que una persona tiene que mirar al abrir el panel.
        hoy: {
          reference: buckets.reference,
          seguimientosHoy: buckets.today.length,
          seguimientosVencidos: buckets.overdue.length,
          sinResponder: conversationList.filter((row) => row.awaiting_reply === true).length,
          humanoRequerido: conversationList.filter((row) => row.status === 'HUMAN_REQUIRED').length,
          pedidosPendientes: items.filter(
            (item) => item.type === 'order_intent' && !isCompletedPurchaseStatus(item.status) && item.status !== 'perdido',
          ).length,
          entregadosRecientes: items
            .filter((item) => item.type === 'order_intent' && isCompletedPurchaseStatus(item.status))
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
        /*
         * MULTIMEDIA: qué se puede hacer y qué quedó a medias. La cola de
         * recuperación es información de ADMINISTRACIÓN (un envío ambiguo no se
         * reintenta solo): se muestra en Ajustes, nunca como botón en el chat, y
         * va saneada (sin bucket, sin `object_key`, sin código del proveedor).
         */
        media: {
          enabled: Boolean(ctx.media?.store && ctx.media?.storage?.enabled),
          storageConfigured: Boolean(ctx.media?.storage?.enabled),
          graphConfigured: Boolean(ctx.media?.whatsapp?.enabled),
          imageLimitMb: 5,
          audioLimitMb: 16,
          /*
           * ¿Este servidor puede convertir audio (WebM/Vorbis → Ogg/Opus) antes de
           * enviarlo? El panel lo necesita para decidir si ofrece el envío de una
           * nota grabada en WebM o si tiene que pedir otro formato.
           */
          audioNormalize: ffmpegInfo().available,
          needsReview: mediaNeedsReview.length,
          review: mediaNeedsReview,
        },
      });
      return;
    }

    // Números del negocio (clientes, seguimientos, mensajes, ventas).
    // `period` = hoy | 7d | 30d (por defecto 30d): todo lo que se cuenta respeta
    // el período, sin doble conteo (un pedido entra UNA vez por su fecha).
    if (route === '/api/admin/metrics' && req.method === 'GET') {
      const period = ['hoy', '7d', '30d'].includes(url.searchParams.get('period') ?? '')
        ? String(url.searchParams.get('period'))
        : '30d';
      json(res, 200, { ok: true, metrics: await ctx.customers.metrics({ period }) });
      return;
    }

    if (route === '/api/admin/reports/sales-by-source' && req.method === 'GET') {
      const rows = await store.listAdmin({ limit: 5000 });
      json(res, 200, { ok: true, report: revenueBySourceReport(rows) });
      return;
    }

    if (route === '/api/admin/inventory' && req.method === 'GET') {
      const snapshot = await ctx.inventory.catalog();
      const stock = await ctx.inventory.stock();
      json(res, 200, {
        ok: true,
        ...sanitizeInventoryForPermissions(snapshot, actor, {
          current_unit_cost: centsToMoney(snapshot.product.current_unit_cost_cents),
          movements: stock.movements.slice(-100).reverse(),
        }),
      });
      return;
    }

    if (route === '/api/admin/inventory/restock' && req.method === 'POST') {
      if (!requireAdmin()) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.inventory.addStock({
        quantity: body.quantity,
        unitCost: body.unitCost,
        reason: longText(body.reason ?? 'Reposición', 300),
        idempotencyKey: text(body.idempotencyKey, 160),
        createdBy: actor?.id ?? null,
        actorName: actor?.display_name ?? null,
      });
      if (!result.ok) {
        json(res, result.error === 'insufficient_stock' ? 409 : 422, { ok: false, ...result });
        return;
      }
      json(res, 201, { ok: true, result, inventory: await ctx.inventory.catalog() });
      return;
    }

    if (route === '/api/admin/inventory/adjust' && req.method === 'POST') {
      if (!requireAdmin()) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.inventory.adjust({
        direction: body.direction === 'out' ? 'out' : 'in',
        quantity: body.quantity,
        unitCost: body.unitCost,
        reason: longText(body.reason ?? 'Ajuste manual', 300),
        idempotencyKey: text(body.idempotencyKey, 160),
        createdBy: actor?.id ?? null,
        actorName: actor?.display_name ?? null,
      });
      if (!result.ok) {
        json(res, result.error === 'insufficient_stock' ? 409 : 422, { ok: false, ...result });
        return;
      }
      json(res, 200, { ok: true, result, inventory: await ctx.inventory.catalog() });
      return;
    }

    if (route === '/api/admin/inventory/cost' && req.method === 'POST') {
      if (!requireAdmin()) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.inventory.updateCost(body.unitCost, { actorName: actor?.display_name ?? null });
      if (!result.ok) {
        json(res, 422, { ok: false, ...result });
        return;
      }
      json(res, 200, { ok: true, product: result.product, inventory: await ctx.inventory.catalog() });
      return;
    }

    if (route === '/api/admin/reports/sales' && req.method === 'GET') {
      if (!requirePermission('reports.profit.view', 'Solo ADMIN puede ver reportes de ganancia.')) return;
      const period = url.searchParams.get('period') ?? 'hoy';
      const report = await ctx.inventory.report({
        period,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: 500,
      });
      json(res, 200, { ok: true, report });
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
    const result = await sendPurchaseToMeta({ store, metaCapi: ctx.metaCapi, item, audit: ctx.audit, source: 'manual' });
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
      if (!requirePermission('orders.update_operational')) return;
      const id = decodeURIComponent(route.slice('/api/admin/items/'.length));
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const beforeRows = await store.listAdmin({ limit: 1000 });
      const before = beforeRows.find((row) => row.id === id);
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
      if (before?.type === 'order_intent' && (body.source !== undefined || body.saleSource !== undefined || body.orderSource !== undefined)) {
        const currentOrder = orderOf(before);
        if (!currentOrder) {
          json(res, 422, { ok: false, error: 'invalid_order' });
          return;
        }
        const previousAttribution = readOrderAttribution(currentOrder);
        const manual = manualAttribution(body, actor);
        const nextAttribution = orderAttributionSnapshot({
          source: manual.source,
          source_origin: 'MANUAL',
          meta_attribution: manual.meta_attribution ?? currentOrder.meta_attribution_snapshot ?? null,
        });
        currentOrder.source = nextAttribution.source;
        currentOrder.source_origin = nextAttribution.source_origin;
        currentOrder.meta_attribution_snapshot = nextAttribution.meta_attribution_snapshot;
        currentOrder.source_updated_at = new Date().toISOString();
        currentOrder.source_updated_by_user_id = actor?.actor_type === 'USER' ? actor.id : null;
        currentOrder.source_updated_by_display_name_snapshot = actor?.display_name ?? null;
        patch.orderJson = JSON.stringify(currentOrder);
        patch.payload = JSON.stringify({
          ...parsePayload(before),
          sale_source: nextAttribution.source,
          source_origin: nextAttribution.source_origin,
          meta_attribution: nextAttribution.meta_attribution_snapshot,
        });
        await ctx.audit?.record({
          entity: 'order',
          entityId: id,
          action: 'order.source_changed',
          actor: actor?.display_name ?? null,
          summary: `Origen: ${previousAttribution.source_label} → ${nextAttribution.source_label}`,
          data: {
            order_id: id,
            from_source: previousAttribution.source,
            to_source: nextAttribution.source,
            changed_by: actor?.display_name ?? null,
            reason: longText(body.reason ?? body.sourceReason ?? body.source_note ?? '', 500),
          },
          idempotencyKey: `order.source:${id}:${previousAttribution.source}:${nextAttribution.source}:${Date.now()}`,
        });
      }
      if (body.contacted) {
        patch.lastContactAt = new Date().toISOString();
        if (patch.status === undefined && before?.type !== 'order_intent') patch.status = 'contactado';
      }
      /*
       * Fechas de transición del pedido: se guardan DENTRO del detalle del pedido
       * (no se inventan fechas a posteriori) para poder contar «confirmados del
       * período», «entregados del período» y «cancelados» sin doble conteo.
       */
      if (before?.type === 'order_intent' && ['contactado', 'interesado'].includes(String(patch.status ?? ''))) {
        json(res, 422, {
          ok: false,
          error: 'legacy_order_status',
          message: 'Contactado/Interesado son estados de conversación o cliente; no se guardan como estado de pedido.',
        });
        return;
      }
      if (before?.type === 'order_intent' && patch.status === 'cancelado' && before.status !== 'cancelado') {
        json(res, 409, {
          ok: false,
          error: 'use_sale_cancel',
          message: 'Cancela ventas desde la acción protegida de ADMIN e indicando motivo.',
        });
        return;
      }
      if (patch.status && before?.type === 'order_intent' && before.status !== patch.status) {
        const order = orderOf(before);
        if (order) {
          const stamp = new Date().toISOString();
          if (patch.status === 'confirmado') order.confirmed_at = stamp;
          if (isCompletedPurchaseStatus(patch.status)) order.delivered_at = stamp;
          if (patch.status === 'cancelado') order.cancelled_at = stamp;
          order.status = patch.status;
          order.status_history = [...(order.status_history ?? []), { status: patch.status, at: stamp }];
          order.updated_by_user_id = actor?.actor_type === 'USER' ? actor.id : order.updated_by_user_id ?? null;
          order.updated_by_display_name_snapshot =
            actor?.actor_type === 'USER' ? actor.display_name : order.updated_by_display_name_snapshot ?? null;
          patch.orderJson = JSON.stringify(order);
        }
        if (isCompletedPurchaseStatus(patch.status)) {
          const check = await ensureInventoryForSale(ctx, { ...before, status: patch.status, order_json: patch.orderJson ?? before.order_json });
          if (!check.ok) {
            json(res, check.status ?? 409, { ok: false, error: check.error, message: check.message, available: check.available, required: check.required });
            return;
          }
        }
      }
      const updated = await store.update(id, patch);
      if (!updated) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (patch.status && before && before.status !== patch.status) {
        await ctx.audit?.record({
          entity: before.type === 'order_intent' ? 'order' : 'item',
          entityId: id,
          action: patch.status === 'cancelado' ? 'order.cancelled' : 'order.status_changed',
          actor: actor?.display_name ?? null,
          summary: `Estado: ${before.status ?? 'nuevo'} → ${patch.status}`,
          data: { from: before.status ?? null, to: patch.status },
          idempotencyKey: `status:${id}:${before.status ?? 'nuevo'}:${patch.status}`,
        });
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
        isCompletedPurchaseStatus(updated.status) &&
        isCompletedPurchaseStatus(patch.status)
      ) {
        try {
          const delivered = await afterPurchaseDelivered(ctx, updated);
          json(res, 200, {
            ok: true,
            item: sanitizeItemForPermissions(delivered.item ?? updated, actor),
            delivered: hasPermission(actor, 'cost.view') ? delivered : stripSensitiveFinancials(delivered),
          });
          return;
        } catch (error) {
          const inventory = /** @type {any} */ (error).inventory ?? null;
          if (inventory?.error === 'insufficient_stock') {
            json(res, 409, {
              ok: false,
              error: 'insufficient_stock',
              message: `Stock insuficiente: hay ${inventory.available} cápsulas disponibles y este pedido requiere ${inventory.required}.`,
              available: inventory.available,
              required: inventory.required,
            });
            return;
          }
          console.error('[crm] venta entregada:', error?.message ?? error);
        }
      }
      if (
        before?.type === 'order_intent' &&
        isCompletedPurchaseStatus(before.status) &&
        patch.status &&
        !isCompletedPurchaseStatus(patch.status) &&
        ['cancelado', 'perdido'].includes(String(patch.status))
      ) {
        await ctx.inventory.reverseSale(before, `Estado ${patch.status}`);
      }
      json(res, 200, { ok: true, item: sanitizeItemForPermissions(updated, actor) });
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

    if (route === '/api/admin/customers/stage-dry-run' && req.method === 'GET') {
      if (!requirePermission('clients.read')) return;
      const report = await ctx.customers.customerStageDryRun({ limit: Number(url.searchParams.get('limit') || 1000) });
      json(res, 200, {
        ok: true,
        rule: `CUSTOMER = cliente con al menos un pedido order_intent en estado ${BUSINESS_COMPLETED_PURCHASE_STATUS}; INTERESTED e INACTIVE son manuales mientras no exista compra completada.`,
        report,
      });
      return;
    }

    if (route === '/api/admin/customer-tags' && req.method === 'GET') {
      if (!requirePermission('clients.read')) return;
      await ctx.customers.ensureInitialTags();
      json(res, 200, { ok: true, tags: await ctx.customers.listTags({ activeOnly: false }) });
      return;
    }

    if (route === '/api/admin/customer-tags' && req.method === 'POST') {
      if (!requirePermission('admin.full', 'Solo ADMIN puede crear etiquetas.')) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.customers.createTag(body);
      if (!result.ok) {
        json(res, 422, { ok: false, error: result.error });
        return;
      }
      await ctx.audit?.record({
        entity: 'customer_tag',
        entityId: result.tag.id,
        action: 'customer.tag_created',
        actor: actor?.display_name ?? null,
        summary: `Etiqueta creada: ${result.tag.label}`,
      });
      json(res, 201, { ok: true, tag: result.tag });
      return;
    }

    if (route.startsWith('/api/admin/customer-tags/') && req.method === 'PATCH') {
      if (!requirePermission('admin.full', 'Solo ADMIN puede editar etiquetas.')) return;
      const tagId = decodeURIComponent(route.slice('/api/admin/customer-tags/'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.customers.updateTag(tagId, body);
      if (!result.ok) {
        json(res, result.error === 'not_found' ? 404 : 422, { ok: false, error: result.error });
        return;
      }
      await ctx.audit?.record({
        entity: 'customer_tag',
        entityId: tagId,
        action: 'customer.tag_updated',
        actor: actor?.display_name ?? null,
        summary: `Etiqueta actualizada: ${result.tag.label}`,
      });
      json(res, 200, { ok: true, tag: result.tag });
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

      if (!action && req.method === 'DELETE') {
        if (!requirePermission('clients.delete', 'Solo ADMIN puede eliminar clientes.')) return;
        json(res, 501, { ok: false, error: 'not_implemented', message: 'La eliminación definitiva de clientes no está implementada.' });
        return;
      }

      // Perfil 360: compras, chat, seguimiento, consentimiento y ventana de 24 h.
      if (!action && req.method === 'GET') {
        const profile = await ctx.customers.profile(customerId);
        json(res, 200, { ok: true, ...profile });
        return;
      }

      /*
       * UBICACIONES del cliente: historial completo con procedencia y edad
       * («Compartida hoy» / «ayer» / fecha). Es una ruta de ADMINISTRACIÓN: va con
       * sesión y nunca se expone a nadie sin autenticar.
       */
      if (action === 'locations' && req.method === 'GET') {
        const locations = await ctx.customers.listLocations(customerId, { limit: 100 });
        json(res, 200, { ok: true, customerId, locations });
        return;
      }

      if (action === 'stage' && req.method === 'POST') {
        if (!requirePermission('customer.stage.update')) return;
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const requested = text(body.stage ?? body.customerStage, 30)?.toUpperCase() ?? null;
        if (requested === 'INACTIVE' && !can('admin.full')) {
          forbid('Solo ADMIN puede marcar un cliente como inactivo.');
          return;
        }
        const result =
          body.stage === null || body.customerStage === null
            ? await ctx.customers.clearCustomerStage(customerId, { reason: body.reason, actor })
            : await ctx.customers.setCustomerStage(customerId, requested, { reason: body.reason, actor });
        if (!result.ok) {
          const status = result.error === 'not_found' ? 404 : result.error === 'completed_purchase_stage_conflict' ? 409 : 422;
          json(res, status, {
            ok: false,
            error: result.error,
            message: result.message ?? null,
            stages: result.stages ?? CUSTOMER_STAGES,
          });
          return;
        }
        await ctx.audit?.record({
          entity: 'customer',
          entityId: customerId,
          action: 'customer.stage_changed',
          actor: actor?.display_name ?? null,
          summary: `Etapa: ${result.from} → ${result.to}`,
          data: {
            customer_id: customerId,
            from_stage: result.from,
            to_stage: result.to,
            changed_by_user_id: actor?.id ?? null,
            changed_by_display_name: actor?.display_name ?? null,
            reason: longText(body.reason, 500),
            timestamp: result.history.timestamp,
          },
        });
        json(res, 200, { ok: true, customer: result.customer, from: result.from, to: result.to, history: result.history });
        return;
      }

      if (action === 'tags' && req.method === 'GET') {
        if (!requirePermission('clients.read')) return;
        json(res, 200, { ok: true, customerId, tags: await ctx.customers.tagsForCustomer(customerId), catalog: await ctx.customers.listTags() });
        return;
      }

      if (action === 'tags' && req.method === 'POST') {
        if (!requirePermission('customer.tags.assign')) return;
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const tagId = text(body.tagId ?? body.tag_id, 80);
        const result = await ctx.customers.assignTag(customerId, tagId, { actor });
        if (!result.ok) {
          json(res, result.error === 'tag_not_found' || result.error === 'customer_not_found' ? 404 : 422, { ok: false, error: result.error });
          return;
        }
        await ctx.audit?.record({
          entity: 'customer',
          entityId: customerId,
          action: 'customer.tag_assigned',
          actor: actor?.display_name ?? null,
          summary: `Etiqueta asignada: ${result.tag.label}`,
          data: { customer_id: customerId, tag_id: tagId, label: result.tag.label },
          idempotencyKey: `audit:customer-tag:${customerId}:${tagId}:assigned`,
        });
        json(res, 200, {
          ok: true,
          duplicate: result.duplicate,
          reactivated: result.reactivated === true,
          tag: result.tag,
          assignment: result.assignment,
        });
        return;
      }

      if (action === 'tags' && req.method === 'DELETE') {
        if (!requirePermission('customer.tags.assign')) return;
        const tagId = text(url.searchParams.get('tagId') ?? url.searchParams.get('tag_id'), 80);
        const result = await ctx.customers.removeTag(customerId, tagId, { actor });
        if (result.removed === true) {
          await ctx.audit?.record({
            entity: 'customer',
            entityId: customerId,
            action: 'customer.tag_removed',
            actor: actor?.display_name ?? null,
            summary: `Etiqueta removida: ${tagId}`,
            data: { customer_id: customerId, tag_id: tagId },
          });
        }
        json(res, 200, { ok: true, removed: result.removed, status: result.removed ? 'removed' : 'not_found' });
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
        // Estado comercial A MANO (INTERESADO / PERDIDO). Con `null` vuelve al derivado.
        if (body.commercialState !== undefined) {
          const result = await ctx.customers.setCommercialState(customerId, body.commercialState);
          if (!result.ok) {
            json(res, 422, { ok: false, error: result.error, manual: result.manual ?? null });
            return;
          }
          await ctx.audit?.record({
            entity: 'customer',
            entityId: customerId,
            action: 'customer.status_changed',
            summary: `Estado comercial → ${result.commercial_state}`,
            data: { manual: body.commercialState ?? null },
          });
          if (Object.keys(patch).length === 0) {
            json(res, 200, { ok: true, customer: result.customer });
            return;
          }
        }
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

    // --------------------------------- compras/pedidos registrados desde el panel
    // El teléfono identifica al cliente: si ya existe, se suma a su historial.
    if (route === '/api/admin/purchases' && req.method === 'POST') {
      if (!requirePermission('orders.create')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await createOrder(ctx, body, actor);
      if (!result.ok) {
        json(res, result.status ?? 422, {
          ok: false,
          error: result.error,
          message: result.message ?? 'Elige un frasco del catálogo.',
          methods: result.methods,
          available: result.available,
          required: result.required,
        });
        return;
      }
      json(res, 201, {
        ok: true,
        duplicate: result.duplicate,
        item: sanitizeItemForPermissions(result.item, actor),
        order: sanitizeOrderForPermissions(result.order, actor),
        customer: result.customer,
        delivered: hasPermission(actor, 'cost.view') ? result.delivered : stripSensitiveFinancials(result.delivered),
      });
      return;
    }

    // ------------------------------------------------ pedido desde la conversación
    // Mismo camino que la compra a mano, pero puede nacer de un chat y enlazarlo.
    if (route === '/api/admin/orders' && req.method === 'POST') {
      if (!requirePermission('orders.create')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await createOrder(ctx, body, actor);
      if (!result.ok) {
        json(res, result.status ?? 422, {
          ok: false,
          error: result.error,
          message: result.message ?? 'No se pudo crear el pedido.',
          methods: result.methods,
          available: result.available,
          required: result.required,
        });
        return;
      }
      const receipt = buildReceipt({
        order: orderOf(result.item) ?? result.order,
        customer: result.customer,
      });
      json(res, 201, {
        ok: true,
        duplicate: result.duplicate,
        item: sanitizeItemForPermissions(result.item, actor),
        order: sanitizeOrderForPermissions(orderOf(result.item) ?? result.order, actor),
        receipt,
        customer: result.customer,
        delivered: hasPermission(actor, 'cost.view') ? result.delivered : stripSensitiveFinancials(result.delivered),
      });
      return;
    }

    if (route === '/api/admin/delivery-tracking' && req.method === 'GET') {
      if (!requirePermission('delivery.location.read_own')) return;
      const sessions = await listVisibleTracking(ctx, actor);
      json(res, 200, { ok: true, sessions });
      return;
    }

    if (route === '/api/admin/notifications' && req.method === 'GET') {
      const notifications = await listUserNotifications(ctx, actor);
      json(res, 200, {
        ok: true,
        notifications,
        unread: notifications.filter((row) => row.status !== 'read').length,
      });
      return;
    }

    if (route.startsWith('/api/admin/notifications/') && route.endsWith('/read') && req.method === 'POST') {
      const id = decodeURIComponent(route.slice('/api/admin/notifications/'.length, -'/read'.length));
      const current = await ctx.db.get('user_notifications', id);
      if (!current) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!hasPermission(actor, 'delivery.tracking.manage_all') && current.recipient_user_id !== actor?.id) {
        forbid();
        return;
      }
      const updated = await ctx.db.update('user_notifications', id, {
        status: 'read',
        read_at: current.read_at ?? ctx.clock().toISOString(),
        updated_at: ctx.clock().toISOString(),
      });
      json(res, 200, { ok: true, notification: updated });
      return;
    }

    if (route === '/api/admin/push-subscriptions' && req.method === 'POST') {
      if (!currentUser) {
        forbid();
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const endpoint = text(body.endpoint ?? body.subscription?.endpoint, 600);
      const keys = body.keys ?? body.subscription?.keys ?? null;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        json(res, 422, { ok: false, error: 'invalid_subscription', message: 'Subscription inválida.' });
        return;
      }
      const existing = await ctx.db.findBy('push_subscriptions', 'endpoint', endpoint);
      const doc = {
        user_id: currentUser.id,
        endpoint,
        keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
        active: true,
        user_agent: text(req.headers['user-agent'], 240),
        last_used_at: ctx.clock().toISOString(),
        updated_at: ctx.clock().toISOString(),
      };
      const subscription = existing
        ? await ctx.db.update('push_subscriptions', existing.id, doc)
        : (await ctx.db.insert('push_subscriptions', { id: newId('sub'), ...doc, created_at: ctx.clock().toISOString() })).doc;
      json(res, 200, { ok: true, subscription: { id: subscription.id, active: subscription.active }, publicKey: WEB_PUSH_PUBLIC_KEY || null });
      return;
    }

    if (route.startsWith('/api/admin/delivery/orders/') && req.method === 'GET') {
      const orderId = decodeURIComponent(route.slice('/api/admin/delivery/orders/'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      if (!canOpenDeliveryOrder(actor, order)) {
        forbid();
        return;
      }
      const customer = order?.customer_id ? await ctx.customers.get(order.customer_id) : null;
      const conversation = order?.conversation_id ? await findConversation(ctx, order.conversation_id) : null;
      const notificationId = url.searchParams.get('notification');
      if (notificationId) {
        const note = await ctx.db.get('user_notifications', notificationId);
        if (note && (note.recipient_user_id === actor?.id || hasPermission(actor, 'delivery.tracking.manage_all'))) {
          await ctx.db.update('user_notifications', note.id, { status: 'read', read_at: note.read_at ?? ctx.clock().toISOString(), updated_at: ctx.clock().toISOString() });
        }
      }
      json(res, 200, { ok: true, order: publicDeliveryOrder(item, order, customer, conversation) });
      return;
    }

    if (route === '/api/admin/delivery-tracking/events' && req.method === 'GET') {
      if (!requirePermission('delivery.location.read_own')) return;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const client = { res, actor };
      ctx.deliveryEventClients.add(client);
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const heartbeat = setInterval(() => {
        try {
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        } catch {
          clearInterval(heartbeat);
          ctx.deliveryEventClients.delete(client);
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        ctx.deliveryEventClients.delete(client);
      });
      return;
    }

    if (route.startsWith('/api/admin/delivery-tracking/')) {
      const rest = decodeURIComponent(route.slice('/api/admin/delivery-tracking/'.length));
      const [sessionId, action = ''] = rest.split('/');
      const session = await ctx.db.get('delivery_tracking_sessions', sessionId);
      if (!session) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (req.method === 'GET' && !action) {
        if (!canReadTracking(actor, session)) {
          forbid();
          return;
        }
        const points = canReadTracking(actor, session)
          ? await ctx.db.list('delivery_location_points', { by: 'recorded_at', order: 'desc', limit: 100 })
          : [];
        json(res, 200, {
          ok: true,
          session: await publicSessionWithOrder(ctx, session),
          points: points
            .filter((point) => point.tracking_session_id === session.id)
            .map((point) => ({
              latitude: point.latitude,
              longitude: point.longitude,
              accuracy: point.accuracy ?? null,
              heading: point.heading ?? null,
              speed: point.speed ?? null,
              recorded_at: point.recorded_at,
              suspicious_location: point.suspicious_location === true,
            })),
        });
        return;
      }
      if (req.method === 'POST' && action === 'location') {
        if (!canUpdateTracking(actor, session)) {
          forbid();
          return;
        }
        if (!requirePermission('delivery.location.update_own')) return;
        if (session.status !== ACTIVE_TRACKING_STATUS) {
          json(res, 409, { ok: false, error: 'tracking_not_active', message: 'La entrega no está activa.' });
          return;
        }
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const valid = validateLocationUpdate(body, { now: ctx.clock() });
        if (!valid.ok) {
          json(res, 422, { ok: false, error: valid.code, message: valid.message });
          return;
        }
        const previous =
          session.last_latitude !== null && session.last_longitude !== null
            ? {
                latitude: Number(session.last_latitude),
                longitude: Number(session.last_longitude),
                recorded_at: session.last_position_at ?? session.updated_at ?? session.started_at,
              }
            : null;
        const suspicious = suspiciousJump(previous, valid.point);
        const updated = await ctx.db.update('delivery_tracking_sessions', session.id, {
          last_latitude: valid.point.latitude,
          last_longitude: valid.point.longitude,
          last_accuracy: valid.point.accuracy,
          last_heading: valid.point.heading,
          last_speed: valid.point.speed,
          last_position_at: valid.point.recorded_at,
          updated_at: ctx.clock().toISOString(),
          suspicious_location: suspicious,
        });
        if (shouldStorePoint(previous, valid.point)) {
          await ctx.db.insert('delivery_location_points', {
            id: newId('dlp'),
            tracking_session_id: session.id,
            delivery_user_id: session.delivery_user_id,
            order_id: session.order_id,
            latitude: valid.point.latitude,
            longitude: valid.point.longitude,
            accuracy: valid.point.accuracy,
            heading: valid.point.heading,
            speed: valid.point.speed,
            suspicious_location: suspicious,
            recorded_at: valid.point.recorded_at,
            created_at: ctx.clock().toISOString(),
          });
        }
        await emitDeliveryEvent(ctx, 'delivery.location_updated', updated);
        json(res, 200, { ok: true, session: await publicSessionWithOrder(ctx, updated) });
        return;
      }
      if (req.method === 'POST' && (action === 'stop' || action === 'complete')) {
        if (!canUpdateTracking(actor, session)) {
          forbid();
          return;
        }
        const required = action === 'complete' ? 'delivery.tracking.stop' : 'delivery.tracking.stop';
        if (!requirePermission(required)) return;
        const status = action === 'complete' ? 'COMPLETED' : 'CANCELLED';
        const ended = await ctx.db.update('delivery_tracking_sessions', session.id, {
          status,
          ended_at: ctx.clock().toISOString(),
          updated_at: ctx.clock().toISOString(),
        });
        let order = null;
        if (action === 'complete') {
          const item = await findOrderItem(store, session.order_id);
          if (item) {
            const updatedStatus = await updateOrderStatus(store, item, BUSINESS_COMPLETED_PURCHASE_STATUS, actor);
            order = updatedStatus?.order ?? null;
            if (order) {
              order = {
                ...order,
                delivery: {
                  ...(order.delivery ?? {}),
                  delivery_status: DELIVERY_OPERATIONAL_STATUSES.DELIVERED,
                },
                updated_at: ctx.clock().toISOString(),
              };
              await store.update(item.id, { orderJson: JSON.stringify(order) });
            }
          }
        }
        await emitDeliveryEvent(ctx, action === 'complete' ? 'delivery.completed' : 'delivery.tracking_stopped', ended);
        json(res, 200, { ok: true, session: await publicSessionWithOrder(ctx, ended), order });
        return;
      }
    }

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/assign') && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all', 'Solo ADMIN puede asignar delivery.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/assign'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const deliveryUserId = text(body.deliveryUserId ?? body.delivery_user_id, 80);
      const deliveryUser = deliveryUserId ? await ctx.users.get(deliveryUserId) : null;
      if (!deliveryUser || deliveryUser.role !== 'DELIVERY') {
        json(res, 422, { ok: false, error: 'invalid_delivery_user', message: 'Asigna un usuario DELIVERY.' });
        return;
      }
      const assigned = await assignDeliveryToOrder(ctx, item, deliveryUser, actor);
      json(res, 200, { ok: true, order: assigned.order, deliveryUser });
      return;
    }

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/start') && req.method === 'POST') {
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/start'.length));
      const canStartOwn = can('delivery.tracking.start');
      const canManageAll = can('delivery.tracking.manage_all');
      if (!canStartOwn && !canManageAll) {
        forbid();
        return;
      }
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      const destination = orderDestination(order);
      if (!destination) {
        json(res, 422, { ok: false, error: 'missing_destination', message: 'El pedido no tiene ubicación de entrega.' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const requestedUserId = text(body.deliveryUserId ?? body.delivery_user_id, 80);
      const assignedUserId = text(order.delivery?.delivery_user_id, 80);
      const deliveryUser =
        canManageAll && requestedUserId ? await ctx.users.get(requestedUserId) : currentUser;
      if (!deliveryUser || deliveryUser.role !== 'DELIVERY') {
        json(res, 422, { ok: false, error: 'invalid_delivery_user', message: 'Asigna un usuario DELIVERY.' });
        return;
      }
      if (assignedUserId && deliveryUser.id !== assignedUserId && !canManageAll) {
        forbid('Este pedido está asignado a otro delivery.');
        return;
      }
      if (!assignedUserId && !canManageAll) {
        json(res, 409, { ok: false, error: 'delivery_not_assigned', message: 'Un ADMIN debe asignar este pedido antes de iniciar entrega.' });
        return;
      }
      if (!canManageAll && deliveryStatusOf(order) === DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT) {
        json(res, 409, {
          ok: false,
          error: 'delivery_contact_required',
          message: 'Primero contacta al cliente y confirma la entrega.',
        });
        return;
      }
      if (!canManageAll && deliveryUser.id !== actor?.id) {
        forbid();
        return;
      }
      const existing = (await ctx.db.list('delivery_tracking_sessions', { limit: 1000 })).find(
        (row) => row.order_id === orderId && row.status === ACTIVE_TRACKING_STATUS,
      );
      if (existing) {
        if (!canReadTracking(actor, existing)) {
          forbid();
          return;
        }
        json(res, 200, { ok: true, duplicate: true, session: await publicSessionWithOrder(ctx, existing) });
        return;
      }
      let effectiveOrder = order;
      if (!assignedUserId || assignedUserId !== deliveryUser.id) {
        effectiveOrder = (await assignDeliveryToOrder(ctx, item, deliveryUser, actor))?.order ?? order;
      }
      if (effectiveOrder.delivery?.delivery_status !== DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT) {
        effectiveOrder = {
          ...effectiveOrder,
          delivery: {
            ...(effectiveOrder.delivery ?? {}),
            delivery_status: DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT,
          },
          updated_at: ctx.clock().toISOString(),
        };
        await ctx.store.update(orderId, { orderJson: JSON.stringify(effectiveOrder) });
      }
      const session = buildTrackingSession({ orderId, deliveryUser, order: effectiveOrder, now: ctx.clock() });
      const inserted = await ctx.db.insert('delivery_tracking_sessions', session);
      const freshItem = await findOrderItem(store, orderId);
      const statusUpdate = effectiveOrder.status === 'entregado' || !freshItem ? null : await updateOrderStatus(store, freshItem, 'enviado', actor);
      await emitDeliveryEvent(ctx, 'delivery.tracking_started', inserted.doc);
      json(res, 201, {
        ok: true,
        session: await publicSessionWithOrder(ctx, inserted.doc),
        order: statusUpdate?.order ?? order,
      });
      return;
    }

    // Detalle de un pedido + comprobante (para la vista dentro del CRM).
    if (route.startsWith('/api/admin/orders/') && req.method === 'GET') {
      const rest = decodeURIComponent(route.slice('/api/admin/orders/'.length));
      const [orderId, action = ''] = rest.split('/');
      const items = await store.listAdmin({ limit: 1000 });
      const item = items.find((entry) => entry.id === orderId) ?? null;
      if (!item || item.type !== 'order_intent') {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      const customer = item.customer_id ? await ctx.customers.get(item.customer_id) : null;
      const receipt = buildReceipt({ order, customer });

      // Documento compartible de la factura.
      if (action === 'factura' || action === 'receipt.pdf' || action === 'receipt-pdf') {
        const pdf = receiptPdf(receipt, { timeZone: TIME_ZONE });
        const filename = `${receipt.order_number || orderId}-factura.pdf`;
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': pdf.length,
          'content-disposition': `inline; filename="${filename}"`,
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        });
        res.end(pdf);
        return;
      }

      // Documento HTML ligero con acciones móviles (volver + compartir factura).
      if (action === 'receipt') {
        const html = receiptHtml(receipt, { timeZone: TIME_ZONE });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        });
        res.end(html);
        return;
      }

      if (!action && wantsHtml(req)) {
        const location = `/api/admin/orders/${encodeURIComponent(orderId)}/receipt`;
        res.writeHead(302, {
          location,
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        });
        res.end();
        return;
      }

      const followupRows = await ctx.db.list('followups', { limit: 2000 });
      json(res, 200, {
        ok: true,
        item: sanitizeItemForPermissions(item, actor),
        order: sanitizeOrderForPermissions(order, actor),
        ...(can('cost.view') ? { financials: orderFinancials(order) } : {}),
        receipt,
        customer,
        followups: followupRows.filter((row) => row.order_id === orderId || row.purchase_id === orderId),
        scheduled: (await ctx.scheduler.list()).filter((row) => row.order_id === orderId),
      });
      return;
    }

    if (route.startsWith('/api/admin/orders/') && req.method === 'POST') {
      const rest = decodeURIComponent(route.slice('/api/admin/orders/'.length));
      const [orderId, action = ''] = rest.split('/');
      if (action === 'cancel') {
        if (!requirePermission('sales.cancel', 'Solo ADMIN puede cancelar ventas.')) return;
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const result = await cancelSale(ctx, orderId, body, actor);
        if (!result.ok) {
          json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message, inventory: result.inventory ?? null });
          return;
        }
        json(res, 200, {
          ok: true,
          item: sanitizeItemForPermissions(result.item, actor),
          order: sanitizeOrderForPermissions(result.order, actor),
          inventory: hasPermission(actor, 'cost.view') ? result.inventory : stripSensitiveFinancials(result.inventory),
          inventoryLinesRestored: result.inventoryLinesRestored,
        });
        return;
      }
    }

    // Modificar un pedido (frascos, descuento, notas, entrega). Recalcula el total.
    if (route.startsWith('/api/admin/orders/') && (req.method === 'PATCH' || req.method === 'POST')) {
      if (!requirePermission('orders.update_operational')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length));
      const items = await store.listAdmin({ limit: 1000 });
      const item = items.find((entry) => entry.id === orderId) ?? null;
      if (!item || item.type !== 'order_intent') {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const current = orderOf(item);
      const currentFirst = current?.items?.[0] ?? null;
      /*
       * UBICACIÓN DE ENTREGA: si se manda una, se resuelve y se comprueba que es
       * de ESE cliente. Si no se manda nada, se CONSERVA la que ya tenía el pedido
       * (los pedidos antiguos no pierden su dirección/ciudad al editarse).
       */
      const entrega =
        body.deliveryLocation === undefined
          ? { ok: true, provided: false, location: current.delivery?.location ?? null }
          : await resolveOrderLocation(ctx, { customerId: current.customer_id ?? item.customer_id, body });
      if (!entrega.ok) {
        json(res, 422, { ok: false, error: entrega.code, message: entrega.message });
        return;
      }
      /** @type {any} */
      let totals;
      try {
        totals = computeOrderTotals(Array.isArray(body.items) ? body.items : current.items, {
          discount: body.discount !== undefined ? body.discount : current.discount,
          // El delivery es OPCIONAL e independiente de la ubicación (§26).
          deliveryFee: body.deliveryFee !== undefined ? body.deliveryFee : current.delivery_fee ?? current.delivery?.fee,
        });
      } catch (error) {
        json(res, 422, { ok: false, error: /** @type {any} */ (error).code ?? 'invalid_order' });
        return;
      }
      const first = totals.items[0];
      const nextPaymentMethod =
        body.paymentMethod !== undefined || body.payment_method !== undefined
          ? normalizePaymentMethod(body.paymentMethod ?? body.payment_method)
          : current.payment_method ?? null;
      if ((body.paymentMethod !== undefined || body.payment_method !== undefined) && !nextPaymentMethod) {
        json(res, 422, { ok: false, error: 'invalid_payment_method', methods: PAYMENT_METHODS });
        return;
      }
      const nextOrder = {
        ...current,
        items: totals.items,
        item_count: totals.itemCount,
        units: totals.units,
        total_capsules: totals.totalCapsules,
        subtotal: totals.subtotal,
        discount: totals.discount,
        delivery_fee: totals.deliveryFee,
        total: totals.total,
        notes: body.notes !== undefined ? longText(body.notes, 2000) : current.notes,
        delivery: {
          ...(current.delivery ?? {}),
          ...(body.delivery !== undefined ? body.delivery : {}),
          fee: totals.deliveryFee,
          // GPS: se manda la elegida o se conserva la suya (nunca se borra sola).
          location: entrega.provided ? entrega.location : current.delivery?.location ?? null,
        },
        payment_method: nextPaymentMethod,
        payment_method_label: paymentMethodLabel(nextPaymentMethod),
        updated_by_user_id: actor?.actor_type === 'USER' ? actor.id : current.updated_by_user_id ?? null,
        updated_by_display_name_snapshot:
          actor?.actor_type === 'USER' ? actor.display_name : current.updated_by_display_name_snapshot ?? null,
      };
      /*
       * La ubicación nueva se guarda además en el historial del cliente, para
       * poder reutilizarla en pedidos siguientes sin volver a pedírsela.
       */
      if (entrega.provided && entrega.location) {
        await rememberOrderLocation(ctx, {
          location: entrega.location,
          customerId: nextOrder.customer_id ?? null,
          conversationId: nextOrder.conversation_id ?? null,
          orderId,
        });
      }
      const updated = await store.update(orderId, {
        notes: nextOrder.notes,
        orderJson: JSON.stringify(nextOrder),
        // La primera línea se refleja en las columnas de siempre.
        variantId: first.variantId,
        variantName: first.variantName,
        capsules: first.capsules,
        quantity: first.quantity,
        unitPrice: first.unitPrice,
        total: nextOrder.total,
      });
      if (isCompletedPurchaseStatus(item.status)) {
        const synced = await ctx.inventory.syncSale(
          { ...updated, order_json: JSON.stringify(nextOrder) },
          nextOrder,
          current,
          `Edición de pedido ${nextOrder.order_number ?? orderId}`,
        );
        if (!synced.ok) {
          await store.update(orderId, {
            notes: current.notes,
            orderJson: JSON.stringify(current),
            variantId: currentFirst?.variantId ?? item.variant_id,
            variantName: currentFirst?.variantName ?? item.variant_name,
            capsules: currentFirst?.capsules ?? item.capsules,
            quantity: currentFirst?.quantity ?? item.quantity,
            unitPrice: currentFirst?.unitPrice ?? item.unit_price,
            total: current.total ?? item.total,
          });
          json(res, synced.error === 'insufficient_stock' ? 409 : 422, {
            ok: false,
            error: synced.error,
            message:
              synced.error === 'insufficient_stock'
                ? `Stock insuficiente: hay ${synced.available} cápsulas disponibles y este cambio requiere ${synced.required}.`
                : 'No se pudo sincronizar inventario.',
            available: synced.available,
            required: synced.required,
          });
          return;
        }
      }
      await ctx.audit?.record({
        entity: 'order',
        entityId: orderId,
        action: 'order.updated',
        actor: actor?.display_name ?? null,
        summary: `Pedido ${nextOrder.order_number} modificado · total ${nextOrder.total}`,
        data: { total: nextOrder.total, items: nextOrder.item_count },
      });
      json(res, 200, {
        ok: true,
        item: sanitizeItemForPermissions(updated, actor),
        order: sanitizeOrderForPermissions(nextOrder, actor),
      });
      return;
    }

    /*
     * COMPARTIR UNA UBICACIÓN CON OTRA CONVERSACIÓN.
     *
     * Es una acción DELIBERADA y con aviso: la ubicación puede ser el domicilio de
     * una persona, así que hay que confirmar a quién se le manda (§21). Nunca se
     * copia nada más del cliente original (ni nombre, ni teléfono, ni pedido):
     * solo las coordenadas, y la auditoría deja constancia de origen y destino.
     */
    if (route.startsWith('/api/admin/locations/') && req.method === 'POST') {
      const rest = decodeURIComponent(route.slice('/api/admin/locations/'.length));
      const [locationId, action = ''] = rest.split('/');
      if (action !== 'share') {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const source = await ctx.customers.getLocation(locationId);
      if (!source) {
        json(res, 404, { ok: false, error: 'unknown_location', message: 'Esa ubicación ya no existe.' });
        return;
      }
      const destination = await findConversation(ctx, text(body.conversationId, 80) ?? '');
      if (!destination) {
        json(res, 404, { ok: false, error: 'unknown_conversation', message: 'Elige una conversación de destino.' });
        return;
      }
      if (body.confirmed !== true) {
        json(res, 409, {
          ok: false,
          error: 'not_confirmed',
          message: 'Confirma con quién vas a compartir la ubicación: no se envía nada sin tu confirmación.',
        });
        return;
      }
      const destinoCustomer = await ctx.customers.get(destination.customer_id);
      if (destinoCustomer?.do_not_contact || destinoCustomer?.whatsapp_opt_out_at) {
        json(res, 409, {
          ok: false,
          error: 'do_not_contact',
          message: 'El cliente de destino pidió no recibir mensajes. Respétalo.',
        });
        return;
      }
      if (!ctx.whatsapp?.enabled) {
        json(res, 503, {
          ok: false,
          error: 'whatsapp_not_configured',
          message: 'WhatsApp no está configurado en el servidor: la ubicación NO se ha enviado.',
        });
        return;
      }
      if (!ctx.customers.canSendFreeText(destination)) {
        json(res, 409, {
          ok: false,
          error: 'outside_window',
          message:
            'Han pasado más de 24 h desde el último mensaje del cliente de destino: WhatsApp solo permite enviar una plantilla aprobada.',
        });
        return;
      }
      const compartida = { ...source, source: LOCATION_SOURCES.REUSED_LOCATION };
      const sendResult = await ctx.whatsapp.sendLocation(destinoCustomer.phone_e164, compartida);
        const recorded = await ctx.customers.recordOutbound({
          customer: destinoCustomer,
          conversation: destination,
          type: 'location',
          body: source.address ?? '[ubicación]',
          location: compartida,
          waMessageId: sendResult.messageId ?? null,
          status: sendResult.ok ? 'sent' : 'failed',
          error: sendResult.ok ? null : sendResult.error,
          ...messageActorFields(actor),
        });
      await ctx.audit?.record({
        entity: 'location',
        entityId: source.id,
        action: 'location.shared',
        summary: `Ubicación compartida con ${destinoCustomer.name ?? destinoCustomer.phone_e164}`,
        data: {
          location_id: source.id,
          from_conversation_id: source.conversation_id ?? null,
          to_conversation_id: destination.id,
          to_customer_id: destinoCustomer.id,
          operator: actor?.display_name ?? 'panel',
          ok: sendResult.ok === true,
        },
      });
      if (!sendResult.ok) {
        json(res, 502, {
          ok: false,
          error: 'send_failed',
          message: sendResult.error?.message ?? 'WhatsApp rechazó la ubicación.',
          message_record: recorded.message,
        });
        return;
      }
      json(res, 201, { ok: true, message: recorded.message, location: recorded.location });
      return;
    }

    // ------------------------------------------------------------- bandeja
    if (route === '/api/admin/conversations' && req.method === 'GET') {
      const filter = text(url.searchParams.get('filter'), 30) ?? 'todos';
      const order = text(url.searchParams.get('order'), 30) ?? null;
      const q = text(url.searchParams.get('q'), 120) ?? '';
      const dateRange = conversationDateRange(url.searchParams, ctx.clock ?? (() => new Date()));
      if (!dateRange.ok) {
        json(res, 422, { ok: false, error: dateRange.error, message: 'El rango de fechas no es válido.' });
        return;
      }
      const conversations = await ctx.customers.listConversations({
        filter,
        order,
        q,
        from: dateRange.from,
        to: dateRange.to,
        currentUserId: actor?.actor_type === 'USER' ? actor.id : null,
      });
      const counts = await ctx.customers.conversationCounts();
      json(res, 200, { ok: true, conversations, counts, dateRange: { from: dateRange.from, to: dateRange.to }, whatsapp: { configured: Boolean(ctx.whatsapp?.enabled) } });
      return;
    }

    if (route === '/api/admin/conversations/start' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const phone = text(body.phone, 40);
      const name = text(body.name, 120);
      const draft = longText(body.body, 1200);
      if (!phone) {
        json(res, 422, { ok: false, error: 'missing_phone', message: 'Escribe el teléfono del cliente.' });
        return;
      }
      const found = await ctx.customers.findOrCreateByPhone({
        phone,
        name,
        source: 'panel_whatsapp',
        optIn: false,
      });
      if (!found.ok || !found.customer) {
        json(res, 422, { ok: false, error: found.error ?? 'invalid_phone', message: 'Ese teléfono no parece válido.' });
        return;
      }
      const conversation = await ctx.customers.conversationFor(found.customer.id);
      await ctx.audit?.record({
        entity: 'conversation',
        entityId: conversation?.id ?? null,
        action: found.created ? 'conversation.started' : 'conversation.opened',
        actor: actor?.display_name ?? null,
        summary: `Conversación abierta con ${found.customer.name ?? found.customer.phone_e164}`,
        data: {
          customer_id: found.customer.id,
          has_draft: Boolean(draft),
          created_customer: found.created === true,
        },
      });
      json(res, 200, {
        ok: true,
        created: found.created === true,
        customer: found.customer,
        conversation,
        canSendFreeText: ctx.customers.canSendFreeText(conversation),
      });
      return;
    }

    if (route === '/api/admin/conversations/bulk' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const action = text(body.action, 40);
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => text(id, 80)).filter(Boolean).slice(0, 100) : [];
      if (!ids.length || !['mark_read', 'archive', 'unarchive', 'message_preview'].includes(action)) {
        json(res, 422, { ok: false, error: 'invalid_bulk_action' });
        return;
      }
      const results = [];
      for (const id of ids) {
        const conversation = await findConversation(ctx, id);
        if (!conversation) {
          results.push({ id, ok: false, error: 'not_found' });
          continue;
        }
        if (action === 'mark_read') {
          const updated = await ctx.customers.markConversationRead(id);
          results.push({ id, ok: Boolean(updated) });
          continue;
        }
        if (action === 'archive' || action === 'unarchive') {
          const updated = await ctx.customers.archiveConversation(id, action === 'archive');
          results.push({ id, ok: Boolean(updated) });
          continue;
        }
        const customer = await ctx.customers.get(conversation.customer_id);
        const canSendFreeText = ctx.customers.canSendFreeText(conversation);
        results.push({
          id,
          ok: true,
          eligible: customer?.do_not_contact || customer?.whatsapp_opt_out_at ? false : true,
          reason: customer?.do_not_contact || customer?.whatsapp_opt_out_at ? 'do_not_contact' : canSendFreeText ? 'free_text_24h' : 'template_required',
          customer_id: customer?.id ?? null,
          phone_e164: customer?.phone_e164 ?? null,
        });
      }
      json(res, 200, {
        ok: true,
        action,
        selected: ids.length,
        processed: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok).length,
        results,
      });
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

      if (['take', 'release', 'assign'].includes(action) && req.method === 'POST') {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        if (!currentUser && action !== 'assign') {
          json(res, 409, { ok: false, error: 'legacy_session', message: 'Entra con usuario para asignarte conversaciones.' });
          return;
        }
        if (action === 'assign' && !requireAdmin()) return;
        const targetUserId =
          action === 'release'
            ? null
            : action === 'take'
              ? currentUser.id
              : text(body.userId, 80) ?? null;
        const targetUser = targetUserId ? await ctx.users.get(targetUserId) : null;
        if (targetUserId && (!targetUser || targetUser.active === false)) {
          json(res, 422, { ok: false, error: 'unknown_user' });
          return;
        }
        const result = await ctx.customers.assignConversation(conversation.id, {
          mode: action,
          userId: targetUserId,
          displayName: targetUser?.display_name ?? null,
          byUserId: actor?.actor_type === 'USER' ? actor.id : null,
          byDisplayName: actor?.display_name ?? null,
          force: action === 'assign' || actor?.role === 'ADMIN',
        });
        if (!result.ok) {
          json(res, result.error === 'already_assigned' ? 403 : result.error === 'not_owner' ? 403 : 404, {
            ok: false,
            error: result.error,
            message:
              result.error === 'already_assigned'
                ? `Esta conversación ya fue asignada a ${result.assigned_display_name_snapshot ?? 'otro agente'}.`
                : 'No se pudo cambiar la asignación.',
            assigned_user_id: result.assigned_user_id ?? null,
          });
          return;
        }
        const auditAction =
          action === 'release'
            ? 'conversation_released'
            : result.old_user_id && result.old_user_id !== result.new_user_id
              ? 'conversation_reassigned'
              : 'conversation_assigned';
        await ctx.audit?.record({
          entity: 'conversation',
          entityId: conversation.id,
          action: auditAction,
          actor: actor?.display_name ?? null,
          summary:
            action === 'release'
              ? 'Conversación liberada'
              : `Conversación asignada a ${targetUser?.display_name ?? 'sin asignar'}`,
          data: {
            old_user_id: result.old_user_id ?? null,
            new_user_id: result.new_user_id ?? null,
            changed_by: actor?.id ?? null,
          },
        });
        json(res, 200, { ok: true, conversation: result.conversation });
        return;
      }

      if (action === 'messages' && req.method === 'GET') {
        const messages = await ctx.customers.messagesFor(conversation.id, { limit: 200 });
        const stage = customer ? await ctx.customers.customerStage(customer.id) : null;
        const tags = customer ? await ctx.customers.tagsForCustomer(customer.id) : [];
        const followups = customer ? await ctx.followups.listForCustomer(customer.id) : [];
        const nextFollowup = followups.find((row) => row.status === 'pending') ?? null;
        json(res, 200, {
          ok: true,
          conversation,
          customer: customer
            ? { ...customer, customerStage: stage?.stage ?? 'PROSPECT', customer_stage: stage?.stage ?? 'PROSPECT', tags }
            : null,
          messages,
          nextFollowup,
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

      if ((action === 'archive' || action === 'unarchive') && req.method === 'POST') {
        const updated = await ctx.customers.archiveConversation(conversation.id, action === 'archive');
        await ctx.audit?.record({
          entity: 'conversation',
          entityId: conversation.id,
          action: action === 'archive' ? 'conversation.archived' : 'conversation.unarchived',
          summary: action === 'archive' ? 'Conversación archivada' : 'Conversación desarchivada',
          data: { customer_id: conversation.customer_id },
        });
        json(res, 200, { ok: true, conversation: updated });
        return;
      }

      /*
       * ENVIAR UNA UBICACIÓN al cliente.
       *
       * Se exige `confirmed: true` (además de un clic humano en el panel): así es
       * IMPOSIBLE que una ubicación salga sola (§19). Y las reglas son las mismas
       * que para cualquier mensaje: si el cliente pidió no recibir mensajes se
       * rechaza, y fuera de la ventana de 24 h también (una ubicación es contenido
       * libre, no una plantilla).
       *
       * La ubicación puede ser la que YA existe (se reutiliza esa fila) o unas
       * coordenadas nuevas del dispositivo del operador. NUNCA se puede reenviar a
       * este chat una ubicación que sea de OTRO cliente: eso es «compartir» y tiene
       * su propia ruta, con su confirmación y su auditoría.
       */
      if (action === 'location' && req.method === 'POST') {
        if (!requirePermission('chats.reply')) return;
        if (
          conversation.assigned_user_id &&
          conversation.assigned_user_id !== currentUser?.id &&
          !can('chats.force_reassign')
        ) {
          json(res, 403, {
            ok: false,
            error: 'conversation_assigned',
            message: `Esta conversación ya está asignada a ${conversation.assigned_display_name_snapshot ?? 'otro agente'}.`,
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
        if (body.confirmed !== true) {
          json(res, 409, {
            ok: false,
            error: 'not_confirmed',
            message: 'Confirma el envío de la ubicación: no se envía nada sin tu confirmación.',
          });
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
            message: 'WhatsApp no está configurado en el servidor: la ubicación NO se ha enviado.',
          });
          return;
        }
        if (!ctx.customers.canSendFreeText(conversation)) {
          json(res, 409, {
            ok: false,
            error: 'outside_window',
            message:
              'Han pasado más de 24 h desde el último mensaje del cliente: WhatsApp solo permite enviar una plantilla aprobada.',
          });
          return;
        }

        /** @type {any} */
        let location = null;
        const reference = text(body.locationId, 80);
        if (reference) {
          const stored = await ctx.customers.getLocation(reference);
          if (!stored) {
            json(res, 422, { ok: false, error: 'unknown_location', message: 'Esa ubicación ya no existe.' });
            return;
          }
          if (stored.customer_id && customer?.id && stored.customer_id !== customer.id) {
            json(res, 422, {
              ok: false,
              error: 'location_from_other_customer',
              message: 'Esa ubicación es de otro cliente. Para compartirla, usa «Compartir ubicación» con confirmación.',
            });
            return;
          }
          location = stored;
        } else {
          const normalized = normalizeLocation({
            latitude: body.latitude,
            longitude: body.longitude,
            name: body.name,
            address: body.address,
            source: body.source ?? LOCATION_SOURCES.BROWSER_GEOLOCATION,
          });
          if (!normalized.ok) {
            json(res, 422, { ok: false, error: normalized.code, message: normalized.message });
            return;
          }
          location = normalized.location;
        }

        const sendResult = await ctx.whatsapp.sendLocation(customer.phone_e164, location);
        const recorded = await ctx.customers.recordOutbound({
          customer,
          conversation,
          type: 'location',
          // Sin dirección de verdad, el cuerpo es la etiqueta de siempre (no se inventa nada).
          body: location.address ?? '[ubicación]',
          locationId: location.id ?? null,
          location: location.id ? undefined : location,
          waMessageId: sendResult.messageId ?? null,
          status: sendResult.ok ? 'sent' : 'failed',
          error: sendResult.ok ? null : sendResult.error,
          idempotencyKey: text(body.idempotencyKey, 120),
          ...messageActorFields(actor),
          meta: { phoneNumberId: ctx.whatsapp.phoneNumberId },
        });
        await ctx.customers.markConversationRead(conversation.id);
        // Auditoría SIN coordenadas: solo qué ubicación, a quién y desde qué chat.
        await ctx.audit?.record({
          entity: 'location',
          entityId: recorded.location?.id ?? location.id ?? null,
          action: 'location.sent',
          summary: `Ubicación enviada a ${customer.name ?? customer.phone_e164}`,
          data: {
            location_id: recorded.location?.id ?? location.id ?? null,
            conversation_id: conversation.id,
            customer_id: customer.id,
            source: location.source ?? null,
            ok: sendResult.ok === true,
          },
        });
        if (!sendResult.ok) {
          json(res, 502, {
            ok: false,
            error: 'send_failed',
            message: sendResult.error?.message ?? 'WhatsApp rechazó la ubicación.',
            message_record: recorded.message,
          });
          return;
        }
        json(res, 201, { ok: true, message: recorded.message, location: recorded.location });
        return;
      }

      /*
       * ENVÍO MANUAL. Nunca automático: esto solo se ejecuta cuando una persona
       * pulsa ENVIAR en el panel, y antes se comprueban las reglas de WhatsApp:
       *   - el cliente no puede haber pedido no recibir mensajes;
       *   - fuera de la ventana de 24 h solo se puede mandar una plantilla APROBADA.
       */
      if (action === 'messages' && req.method === 'POST') {
        if (!requirePermission('chats.reply')) return;
        if (
          conversation.assigned_user_id &&
          conversation.assigned_user_id !== currentUser?.id &&
          !can('chats.force_reassign')
        ) {
          json(res, 403, {
            ok: false,
            error: 'conversation_assigned',
            message: `Esta conversación ya está asignada a ${conversation.assigned_display_name_snapshot ?? 'otro agente'}.`,
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
        const rawMessageBody = longText(body.body, 1200);
        const templateName = text(body.template, 60);
        if (!rawMessageBody && !templateName) {
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

        const deliveryOrderContext = await deliveryOrderForConversation(ctx, conversation, actor);
        const messageBody =
          !template && deliveryOrderContext && messageNeedsDeliveryIdentity(deliveryOrderContext.order, actor)
            ? withDeliveryIdentity(rawMessageBody, actor)
            : rawMessageBody;

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
            ...messageActorFields(actor),
          });
          console.error(`[crm] WhatsApp rechazó un mensaje a ${customer.id}: ${sendResult.error?.message ?? 'error'}`);
          await ctx.audit?.record({
            entity: 'message',
            entityId: recorded.message?.id ?? null,
            action: 'message.failed',
            actor: actor?.display_name ?? null,
            summary: `Mensaje a ${customer.id} rechazado: ${sendResult.error?.message ?? 'error'}`,
            data: { customer_id: customer.id, template: template?.name ?? null },
          });
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
          ...messageActorFields(actor),
        });
        let deliveryOrder = null;
        if (!template && deliveryOrderContext) {
          deliveryOrder = await markDeliveryContacted(ctx, deliveryOrderContext.item, deliveryOrderContext.order, actor);
        }
        await ctx.customers.markConversationRead(conversation.id);
        // Una persona acaba de escribir: la conversación pasa a manos humanas.
        await ctx.customers.setAutomationState(customer.id, 'HUMAN_ACTIVE');

        const followupId = text(body.followupId, 80);
        const followup = followupId
          ? await ctx.followups.complete(followupId, {
              by: 'panel',
              byUserId: actor?.actor_type === 'USER' ? actor.id : null,
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
        await ctx.audit?.record({
          entity: 'message',
          entityId: recorded.message?.id ?? null,
          action: 'message.sent',
          actor: actor?.display_name ?? null,
          summary: `Mensaje a ${customer.name ?? customer.phone_e164}${template ? ` (plantilla ${template.name})` : ''}`,
          data: { customer_id: customer.id, followup_id: followupId ?? null },
          idempotencyKey: recorded.message?.id ? `message.sent:${recorded.message.id}` : null,
        });
        json(res, 200, {
          ok: true,
          message: recorded.message,
          duplicate: recorded.duplicate === true,
          followup,
          deliveryOrder,
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
        // Plan EFECTIVO (el de Ajustes, ya filtrado) + el plan base para editar.
        plan: await ctx.followups.planNow(),
        basePlan: ctx.followups.plan,
        enabled: (await ctx.settings.followup()).enabled,
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
      // La tarea puede colgar de la conversación y del pedido de los que nace.
      let conversationId = text(body.conversationId, 80) ?? null;
      if (conversationId) {
        const conversation = await ctx.db.get('conversations', conversationId);
        conversationId = conversation && conversation.customer_id === customer.id ? conversation.id : null;
      }
      const followup = await ctx.followups.createManual({
        customerId: customer.id,
        purchaseId: text(body.purchaseId, 80) ?? null,
        orderId: text(body.orderId, 80) ?? null,
        conversationId,
        type: text(body.type, 30) ?? 'manual',
        reason: longText(body.reason, 200) ?? 'Seguimiento manual',
        scheduledAt: day(body.scheduledAt) ?? undefined,
        template: text(body.template, 60) ?? null,
        assignedUserId: text(body.assignedUserId, 80) ?? (actor?.actor_type === 'USER' ? actor.id : null),
        createdByUserId: actor?.actor_type === 'USER' ? actor.id : null,
        createdByDisplayName: actor?.actor_type === 'USER' ? actor.display_name : null,
        idempotencyKey: text(body.idempotencyKey, 120) ?? null,
      });
      await ctx.audit?.record({
        entity: 'followup',
        entityId: followup.id,
        action: 'followup.created',
        summary: `Seguimiento para ${followup.scheduled_at} · ${followup.reason}`,
        data: {
          customer_id: customer.id,
          order_id: followup.order_id ?? null,
          conversation_id: followup.conversation_id ?? null,
        },
        idempotencyKey: `followup.created:${followup.id}`,
      });
      json(res, 201, { ok: true, followup, duplicate: followup.duplicate === true });
      return;
    }

    // Decidir una tarea: completar, omitir, cancelar, posponer o cambiar la fecha.
    if (route.startsWith('/api/admin/followups/') && req.method === 'DELETE') {
      if (!requirePermission('followups.delete', 'Solo ADMIN puede eliminar seguimientos.')) return;
      json(res, 501, { ok: false, error: 'not_implemented', message: 'La eliminación definitiva de seguimientos no está implementada.' });
      return;
    }

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
      if (['skip', 'cancel'].includes(action) && !requirePermission('followups.delete', 'Solo ADMIN puede cancelar u omitir seguimientos.')) return;
      /** @type {any} */
      let followup = null;
      if (action === 'complete') followup = await ctx.followups.complete(followupId, { by: actor?.display_name ?? 'panel', byUserId: actor?.actor_type === 'USER' ? actor.id : null, outcome: 'hecho' });
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
      // Traza comercial: cada decisión sobre una tarea queda escrita.
      const auditAction =
        action === 'complete'
          ? 'followup.completed'
          : action === 'cancel'
            ? 'followup.cancelled'
            : action === 'postpone' || action === 'reschedule'
              ? 'followup.postponed'
              : null;
      if (auditAction) {
        await ctx.audit?.record({
          entity: 'followup',
          entityId: followupId,
          action: auditAction,
          summary: `Seguimiento ${action} (${current.reason ?? current.type ?? ''})`,
          data: { customer_id: current.customer_id, order_id: current.order_id ?? null, next: followup?.scheduled_at ?? null },
        });
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
      if (!requirePermission('settings.manage')) return;
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

    /*
     * RESPUESTAS RÁPIDAS / plantillas de TEXTO del panel.
     *
     * Es UNA sola lista, con un solo sitio donde se guarda: la que ya existía.
     * Se abre desde la conversación (menú de acciones → Respuesta rápida) para
     * no obligar a salir del chat, pero los datos son los mismos que edita el
     * menú lateral. Una respuesta rápida NO es una plantilla de Meta: es texto
     * que se escribe en el compositor y que una persona envía si quiere.
     */
    if (route === '/api/admin/messages' && req.method === 'GET') {
      json(res, 200, { ok: true, messages: await store.messages().list() });
      return;
    }

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
      // Alta o edición: el `id` decide. Al crear se coloca AL FINAL de la lista
      // (`position` = mayor + 1) para que el orden sea predecible y no se
      // reordene sola cada vez que alguien añade una respuesta.
      const current = await store.messages().list();
      const id = text(body.id, 60) ?? messageId(name);
      const existing = current.find((row) => row.id === id) ?? null;
      const message = {
        id,
        name,
        body: messageBody,
        position:
          existing?.position ??
          (Number.isFinite(Number(body.position))
            ? Math.trunc(Number(body.position))
            : current.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0) + 1),
      };
      await store.messages().save(message);
      console.log(`[crm] ${existing ? 'respuesta rápida actualizada' : 'respuesta rápida creada'}: ${message.name}`);
      // Traza administrativa: quién, qué acción y el NOMBRE. El cuerpo no se
      // registra (es largo y no aporta nada al rastro comercial).
      await ctx.audit?.record({
        entity: 'quick_reply',
        entityId: message.id,
        action: existing ? 'quick_reply_updated' : 'quick_reply_created',
        actor: 'panel',
        summary: message.name,
      });
      json(res, 200, { ok: true, message, messages: await store.messages().list() });
      return;
    }

    if (route.startsWith('/api/admin/messages/') && req.method === 'DELETE') {
      const id = decodeURIComponent(route.slice('/api/admin/messages/'.length));
      // Se lee ANTES de borrar para poder dejar constancia de qué se borró.
      const existing = (await store.messages().list()).find((row) => row.id === id) ?? null;
      await store.messages().remove(id);
      if (existing) {
        console.log(`[crm] respuesta rápida borrada: ${existing.name}`);
        await ctx.audit?.record({
          entity: 'quick_reply',
          entityId: id,
          action: 'quick_reply_deleted',
          actor: 'panel',
          summary: existing.name,
        });
      }
      // Borrar un texto guardado NO toca nada más: los mensajes ya enviados
      // siguen en su conversación y el cliente sigue existiendo.
      json(res, 200, { ok: true, messages: await store.messages().list() });
      return;
    }

    // -------------------------------------------------- catálogo (fuente única)
    if (route === '/api/admin/catalog' && req.method === 'GET') {
      const inventory = await ctx.inventory.catalog();
      json(res, 200, { ok: true, currency: 'DOP', catalog: inventory.presentations, inventory });
      return;
    }

    // ------------------------------------------------------- ajustes del negocio
    if (route === '/api/admin/settings' && req.method === 'GET') {
      if (!requirePermission('settings.manage')) return;
      json(res, 200, { ok: true, ...(await ctx.settings.snapshot()) });
      return;
    }

    // Interruptores del plan de postventa (día 1, 3, 7, 14, 21, 30).
    if (route === '/api/admin/settings/followup' && req.method === 'POST') {
      if (!requirePermission('settings.manage')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const saved = await ctx.settings.saveFollowup(body);
      const plan = await ctx.settings.followupPlan();
      console.log(`[crm] ajustes de seguimiento: ${plan.length} día(s) activos de ${ctx.followups.plan.length}`);
      json(res, 200, { ok: true, followup: saved, plan });
      return;
    }

    // -------------------------------------------- mensajes programados (S5)
    if (route === '/api/admin/scheduled' && req.method === 'GET') {
      const rows = await ctx.scheduler.list();
      const customers = await ctx.customers.list({});
      const byId = new Map(customers.map((row) => [row.id, row]));
      json(res, 200, {
        ok: true,
        summary: await ctx.scheduler.summary(),
        scheduled: rows.map((row) => ({
          ...row,
          customer: byId.has(row.customer_id)
            ? {
                id: row.customer_id,
                name: byId.get(row.customer_id).name,
                phone_e164: byId.get(row.customer_id).phone_e164,
              }
            : null,
        })),
      });
      return;
    }

    // Programar un mensaje (nunca se envía al crear: lo intenta el scheduler).
    if (route === '/api/admin/scheduled' && req.method === 'POST') {
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const customerId = text(body.customerId, 80);
      const customer = customerId ? await ctx.customers.get(customerId) : null;
      if (!customer) {
        json(res, 422, { ok: false, error: 'unknown_customer' });
        return;
      }
      const result = await ctx.scheduler.schedule({
        customerId: customer.id,
        conversationId: text(body.conversationId, 80) ?? null,
        orderId: text(body.orderId, 80) ?? null,
        scheduledAt: body.scheduledAt,
        type: body.type === 'template' ? 'template' : 'text',
        text: body.text,
        template: body.template,
        createdBy: actor?.display_name ?? 'panel',
        scheduledByUserId: actor?.actor_type === 'USER' ? actor.id : null,
        idempotencyKey: text(body.idempotencyKey, 120) ?? null,
      });
      if (!result.ok) {
        json(res, 422, {
          ok: false,
          error: result.error,
          message:
            result.error === 'invalid_date'
              ? 'Elige una fecha y hora válidas.'
              : 'Escribe el mensaje (o elige una plantilla).',
        });
        return;
      }
      json(res, 201, { ok: true, duplicate: result.duplicate, message: result.message });
      return;
    }

    // Cancelar o reprogramar un mensaje que todavía no ha salido.
    if (route.startsWith('/api/admin/scheduled/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const rest = decodeURIComponent(route.slice('/api/admin/scheduled/'.length));
      const [scheduledId, actionInPath = ''] = rest.split('/');
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const action = actionInPath || text(body.action, 20) || 'reschedule';
      const current = await ctx.db.get('scheduled_messages', scheduledId);
      if (!current) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      /** @type {any} */
      let updated = null;
      if (action === 'cancel') updated = await ctx.scheduler.cancel(scheduledId, { reason: text(body.reason, 200) });
      else if (action === 'reschedule') updated = await ctx.scheduler.reschedule(scheduledId, body.scheduledAt);
      else {
        json(res, 422, { ok: false, error: 'invalid_action', actions: ['cancel', 'reschedule'] });
        return;
      }
      json(res, 200, { ok: true, message: updated });
      return;
    }

    // ------------------------------------------------- auditoría comercial
    if (route === '/api/admin/audit' && req.method === 'GET') {
      const entityId = url.searchParams.get('entityId');
      json(res, 200, {
        ok: true,
        summary: await ctx.audit.summary(),
        entries: await ctx.audit.list({
          limit: Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500),
          entity: url.searchParams.get('entity'),
          entityId,
        }),
      });
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
        'metodo_pago',
        'origen',
        'recordatorio',
        'notas',
        'ultimo_contacto',
        'meta_venta',
        'meta_enviada',
      ];
      const lines = rows.map((row) => {
        const order = row.type === 'order_intent' ? orderOf(row) : null;
        return [
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
          paymentMethodLabel(order?.payment_method) ?? '',
          row.source,
          row.next_action_at,
          row.notes,
          row.last_contact_at,
          row.meta_purchase_status,
          row.meta_purchase_sent_at,
        ]
          .map(csvCell)
          .join(',');
      });
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
 * Describe (sin secretos) si la multimedia puede funcionar y qué falta.
 * Un CRM sin R2 o sin credenciales de WhatsApp sigue siendo un CRM completo:
 * simplemente no hay archivos, y el log lo dice para que nadie lo busque a ciegas.
 */
function descripcionMultimedia(mediaStore, storage, whatsappMedia) {
  const falta = [];
  if (!mediaStore) falta.push('sin base de datos SQL');
  if (!storage?.enabled) falta.push('faltan R2_ENDPOINT/R2_BUCKET_NAME/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY');
  if (!whatsappMedia?.enabled) falta.push('faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
  if (falta.length) return `desactivada (${falta.join(' · ')})`;
  return 'activa · metadata en la base de datos, archivos en S3 (R2) privado';
}

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
 * @param {string} [config.purchaseStatus] compatibilidad de configuración Meta
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
   * Ajustes del negocio (hoy: qué días del plan de postventa están activos).
   * El plan EFECTIVO sale de aquí, no solo de la variable de entorno: el negocio
   * lo cambia desde Ajustes y el motor de seguimiento lo respeta al crear tareas.
   */
  const followupsBasePlan = config.followupPlan ?? FOLLOWUP_PLAN;
  const settingsService = createSettingsService({ db, plan: followupsBasePlan, clock: config.clock });

  /*
   * MULTIMEDIA (imagen y audio).
   *
   * Reparto: la METADATA en la misma base de datos del CRM (tabla propia
   * `phytoemagry_wa_media`, aditiva) y el BINARIO en R2. El `?` de SQLite y el
   * `$1` de PostgreSQL los unifica `server/sql-query.mjs`, así que el almacén de
   * media es EL MISMO en los dos motores (una sola fuente de verdad del esquema).
   *
   * Si R2 no está configurado, `storage.enabled` es false y el pipeline devuelve
   * un error claro sin tumbar nada; si no hay SQL (JSONL), la multimedia queda
   * desactivada y el CRM sigue igual.
   */
  const sqlQuery = createSqlQuery({ backend: db.kind, handle: store.handle ?? null });
  const mediaEnabled = sqlQuery.enabled;
  const mediaStore = config.mediaStore ?? (mediaEnabled ? createMediaStore(sqlQuery) : null);
  const storage =
    config.storage ??
    createStorageService({
      endpoint: R2_ENDPOINT,
      bucket: R2_BUCKET_NAME,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    });
  const whatsappMedia =
    config.whatsappMedia ??
    createWhatsAppMedia({
      accessToken: config.whatsappAccessToken ?? WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.whatsappPhoneNumberId ?? WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: config.whatsappGraphVersion ?? WHATSAPP_GRAPH_VERSION,
    });
  const mediaPipelineBase =
    mediaStore && config.media !== false
      ? createMediaPipeline({
          mediaStore,
          storage,
          whatsappMedia,
          logger: settings.quiet ? () => {} : (message) => console.log(message),
        })
      : null;

  /*
   * Seguimiento: crea y fecha tareas. NO envía nada por su cuenta; el envío
   * siempre lo pulsa una persona en el panel.
   */
  const followups = createFollowupEngine({
    db,
    plan: followupsBasePlan,
    planProvider: () => settingsService.followupPlan(),
    timeZone: TIME_ZONE,
    dailyCapsules: DAILY_CAPSULES,
    clock: config.clock,
  });

  /*
   * Traza comercial: quién creó/canceló/entregó qué y cuándo. Es la fuente de
   * verdad para explicar cualquier número del panel.
   */
  const audit = createAuditLog({ db, clock: config.clock });
  const users = createUserService({ db, audit, clock: config.clock, sessionSeconds: SESSION_SECONDS });
  await users.ensureBootstrapAdmin({
    username: config.bootstrapAdminUser ?? BOOTSTRAP_ADMIN_USER,
    password:
      config.bootstrapAdminPassword ||
      BOOTSTRAP_ADMIN_PASSWORD ||
      ((config.bootstrapAdminUser ?? BOOTSTRAP_ADMIN_USER) ? settings.token : ''),
    firstName: config.bootstrapAdminFirstName ?? 'Ana',
    lastName: config.bootstrapAdminLastName ?? 'Admin',
    displayName: config.bootstrapAdminDisplayName ?? 'Ana Admin',
  });
  const inventory = createInventoryService({ db, store, audit, timeZone: TIME_ZONE, clock: config.clock });

  /*
   * La reconciliación de un envío AMBIGUO es una decisión humana excepcional, así
   * que se envuelve aquí (no dentro del módulo de media) para dejar la traza de
   * auditoría con quién lo revisó, cuándo, qué archivo y qué eligió. El envío en sí
   * no cambia: el pipeline sigue siendo el único que decide.
   */
  const mediaPipeline = mediaPipelineBase
    ? {
        ...mediaPipelineBase,
        async reconcileOutbound(input) {
          const result = await mediaPipelineBase.reconcileOutbound(input);
          if (result?.ok) {
            await audit.record({
              entity: 'message',
              entityId: result.media?.id ?? input.mediaId ?? null,
              action: 'message.reconciled',
              summary: `Envío de archivo revisado: ${input.outcome === 'sent' ? 'sí salió' : 'no salió'}`,
              data: {
                media_id: result.media?.id ?? input.mediaId ?? null,
                media_type: result.mediaType ?? null,
                outcome: input.outcome,
                wa_message_id: input.waMessageId ?? null,
              },
            });
          }
          return result;
        },
      }
    : null;

  // El servicio de clientes puede necesitar los mensajes programados (ficha 360).
  // Se crea ANTES que el scheduler, así que se resuelve con una referencia diferida.
  /** @type {{ current: any }} */
  const schedulerRef = { current: null };
  /** @type {{ current: any }} */
  const ctxRef = { current: null };
  const customers = createCustomerService({
    db,
    store,
    followups,
    timeZone: TIME_ZONE,
    clock: config.clock,
    // El hilo de la conversación necesita el estado de cada archivo (imagen/audio)
    // para poder pintarlo: se consulta en UNA sola vez por hilo.
    media: mediaStore,
    scheduled: { listForCustomer: (id) => (schedulerRef.current ? schedulerRef.current.listForCustomer(id) : Promise.resolve([])) },
  });

  /*
   * Cola persistente de mensajes programados + scheduler. El trabajo vive en la
   * base de datos: sobrevive a un reinicio y no puede enviarse dos veces.
   */
  const scheduler = createScheduler({
    db,
    customers,
    whatsapp,
    followups,
    audit,
    // La plantilla se resuelve contra el mismo criterio que el envío manual.
    resolveTemplate: (name) => approvedTemplate(ctxRef.current, name),
    clock: config.clock,
    intervalMs: config.schedulerIntervalMs,
    log: settings.quiet ? () => {} : (message) => console.log(message),
  });
  schedulerRef.current = scheduler;

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
    audit,
    users,
    inventory,
    settings: settingsService,
    scheduler,
    // Multimedia: metadata (BD), binario (R2), Graph y el pipeline que los une.
    media: { store: mediaStore, storage, whatsapp: whatsappMedia, pipeline: mediaPipeline },
    whatsapp,
    whatsappPhoneNumber: (config.whatsappPhoneNumber ?? WHATSAPP_PHONE_NUMBER).trim(),
    whatsappWebhookUrl: (config.whatsappWebhookUrl ?? WHATSAPP_WEBHOOK_URL).trim(),
    whatsappVerifyToken: (config.whatsappVerifyToken ?? WHATSAPP_VERIFY_TOKEN).trim(),
    appSecret: (config.metaAppSecret ?? META_APP_SECRET).trim(),
    deliveryEventClients: new Set(),
    timeZone: TIME_ZONE,
    clock: config.clock ?? (() => new Date()),
  };
  ctxRef.current = ctx;

  /*
   * RUTAS DE MULTIMEDIA (S3) — se registran con el MISMO guard de sesión que el
   * resto de `/api/admin/*`. Sin sesión no se sirve ni un byte, y la respuesta
   * nunca incluye bucket, `object_key`, endpoint de R2, tokens ni la URL de Graph.
   *
   * `persistOutbound` guarda el mensaje saliente con la MISMA función que usa el
   * envío de texto (`recordOutbound`): una sola forma de escribir en el hilo.
   */
  ctx.handleMediaRoute =
    mediaPipeline && mediaStore && storage
      ? createMediaRoutes({
          mediaStore,
          storage,
          pipeline: mediaPipeline,
          isAuthorized: (req) => {
            const value = readCookie(req, COOKIE);
            return Boolean(parseUserSessionValue(value, settings.token) || sessionValid(value, settings.token));
          },
          resolveConversation: async (conversationId) => {
            const conversation = await findConversation(ctx, conversationId);
            if (!conversation) return null;
            const customer = await ctx.customers.get(conversation.customer_id);
            return customer ? { conversation, customer } : null;
          },
          persistOutbound: async (input) => {
            const mediaCookie = readCookie(input.req, COOKIE);
            const mediaSession = parseUserSessionValue(mediaCookie, settings.token);
            const mediaIdentity = mediaSession ? await users.sessionUser(mediaSession.sessionId) : null;
            const mediaActor = mediaIdentity?.user
              ? {
                  id: mediaIdentity.user.id,
                  role: mediaIdentity.user.role,
                  display_name: mediaIdentity.user.display_name,
                  actor_type: 'USER',
                }
              : sessionValid(mediaCookie, settings.token)
                ? { id: 'LEGACY_PANEL', role: 'ADMIN', display_name: 'Panel legacy', actor_type: 'LEGACY' }
                : null;
            const recorded = await ctx.customers.recordOutbound({
              customer: input.customer,
              conversation: input.conversation,
              body: input.caption ?? null,
              type: input.type,
              status: 'sent',
              waMessageId: input.waMessageId ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              ...messageActorFields(mediaActor),
              meta: { phoneNumberId: ctx.whatsapp?.phoneNumberId ?? null },
            });
            /*
             * ENLACE. La operación de media nace ANTES que el mensaje (así una
             * caída no pierde la intención de envío), por eso su `message_id` es
             * provisional. Aquí se reapunta al mensaje de verdad para que el hilo
             * pueda pintar la foto o el audio con su estado real. Si esto fallara,
             * el mensaje sigue existiendo: solo se perdería el archivo en pantalla.
             */
            try {
              const fila =
                (input.idempotencyKey ? await ctx.media.store.byIdempotencyKey(input.idempotencyKey) : null) ??
                (input.waMessageId ? await ctx.media.store.byWaMessageId(input.waMessageId) : null);
              if (fila && recorded.message?.id && fila.message_id !== recorded.message.id) {
                await ctx.media.store.update(fila.id, { messageId: recorded.message.id });
              }
            } catch (error) {
              console.warn(`[media] no se pudo enlazar la operación con el mensaje: ${error?.message ?? error}`);
            }
            await ctx.customers.markConversationRead(input.conversation.id);
            await ctx.audit?.record({
              entity: 'message',
              entityId: recorded.message?.id ?? null,
              action: 'message.sent',
              summary: `Archivo (${input.type}) a ${input.customer.name ?? input.customer.phone_e164}`,
              data: { customer_id: input.customer.id, media_type: input.type },
              idempotencyKey: recorded.message?.id ? `message.sent:${recorded.message.id}` : null,
            });
            return recorded;
          },
          findMessageByKey: (key) => ctx.db.findBy('wa_messages', 'idempotency_key', key),
          logger: settings.quiet ? () => {} : (message) => console.log(message),
        })
      : null;

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
      } · compra completada = estado "${BUSINESS_COMPLETED_PURCHASE_STATUS}"`,
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
    console.log(
      `[crm] multimedia: ${descripcionMultimedia(mediaStore, storage, whatsappMedia)}`,
    );
  }

  // Reintento de ventas pendientes en segundo plano: no retrasa el arranque.
  retryPendingPurchases(store, metaCapi, console.log, audit).catch(() => {});
  // Y se asegura de que las ventas entregadas tengan su plan de seguimiento.
  ensureFollowupsForDelivered(ctx).catch(() => {});

  /*
   * El scheduler arranca por defecto (cada 30 s) porque es lo que hace que un
   * mensaje programado SOBREVIVA a un reinicio: al arrancar recupera lo pendiente
   * de la base de datos y lo intenta cuando le toca. Con `schedulerIntervalMs: 0`
   * no arranca nada (los tests llaman a `tick()` a mano).
   */
  const schedulerInterval =
    config.schedulerIntervalMs ?? (config.schedulerEnabled === false ? 0 : 30_000);
  const stopScheduler = scheduler.start({ intervalMs: schedulerInterval });
  if (schedulerInterval && !settings.quiet) {
    console.log(
      `[crm] mensajes programados: scheduler cada ${Math.round(schedulerInterval / 1000)}s · el trabajo vive en la base de datos (sobrevive reinicios)`,
    );
  }

  // Cierre idempotente: cerrar dos veces (un test, un reinicio, dos señales)
  // no puede lanzar "database is not open".
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    stopScheduler();
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
    audit,
    settings: settingsService,
    scheduler,
    // Multimedia (metadatos en la base, binarios en R2, Graph para el archivo).
    media: { store: mediaStore, storage, whatsapp: whatsappMedia, pipeline: mediaPipeline },
    whatsapp,
    purchaseStatus: ctx.purchaseStatus,
    businessCompletedPurchaseStatus: BUSINESS_COMPLETED_PURCHASE_STATUS,
    ctx,
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
