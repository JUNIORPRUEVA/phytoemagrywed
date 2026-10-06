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
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
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
import {
  createUserService,
  SYSTEM_ACTOR,
  hasPermission,
  permissionsForRole,
  MIN_PASSWORD_LENGTH,
} from './users.mjs';
import { createInventoryService, centsToMoney } from './inventory.mjs';
import { createScheduler } from './scheduler.mjs';
import {
  INTEREST_FOLLOWUP_TEMPLATE,
  PURCHASE_FOLLOWUP_TEMPLATE,
  suggestScheduledMessage,
} from './message-suggestions.mjs';
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
  orderConfirmationText,
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
const orderTransitionLocks = new Map();
import { catalogItems, computeOrderTotals, findCatalogItem } from '../src/lib/catalog.js';
import {
  createWhatsAppClient,
  parseWebhook,
  toE164,
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

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_APK_PATH = path.resolve(
  process.env.PHYTO_ANDROID_APK_PATH ??
    path.join(PROJECT_ROOT, 'apps', 'phyto_printer', 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'),
);
const DEFAULT_ANDROID_APK_URL =
  'https://github.com/JUNIORPRUEVA/phytoemagrywed/releases/download/v1.01/app-debug.apk';
const ANDROID_APK_URL = (process.env.PHYTO_ANDROID_APK_URL ?? DEFAULT_ANDROID_APK_URL).trim();

function loadServerEnv() {
  if (process.env.NODE_ENV === 'test') return;
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!existsSync(envFile)) return;
  try {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
  } catch {
    /* El entorno real sigue mandando; un .env ilegible solo deja variables sin cargar. */
  }
}

loadServerEnv();

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
  console.log('[push] Web Push configurado (llaves VAPID presentes).');
} else {
  console.log('[push] Web Push DESACTIVADO: faltan PHYTO_WEB_PUSH_PUBLIC_KEY / PHYTO_WEB_PUSH_PRIVATE_KEY.');
}
const DELIVERY_OPERATIONAL_STATUSES = Object.freeze({
  PENDING_CONTACT: 'PENDING_CONTACT',
  CONTACTED: 'CONTACTED',
  READY_FOR_DELIVERY: 'READY_FOR_DELIVERY',
  IN_TRANSIT: 'IN_TRANSIT',
  ISSUE_REPORTED: 'ISSUE_REPORTED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
});
const DELIVERY_ASSIGNMENT_TEMPLATE = 'phyto_delivery_asignado_v1';
const DELIVERY_DELIVERED_TEMPLATE = 'phyto_pedido_entregado_v1';
const DELIVERY_REMINDER_TEMPLATE = 'phyto_delivery_pedido_pendiente_v1';
const DELIVERY_ADMIN_ESCALATION_TEMPLATE = 'phyto_delivery_sin_atender_admin_v1';
const DELIVERY_ADMIN_DELIVERED_TEMPLATE = 'phyto_delivery_entregado_admin_v1';
const DELIVERY_CONTROL_SETTINGS_KEY = 'delivery_control';
const DELIVERY_CONTROL_DEFAULTS = Object.freeze({
  deliveryReminderMinutes: 5,
  deliveryAdminEscalationMinutes: 30,
  deliveryAdminEscalationContacts: [
    { name: 'Yahaira', phone: '8294933332' },
    { name: 'Junior', phone: '8293987826' },
  ],
});
const DELIVERY_ISSUE_REASONS = Object.freeze({
  no_response: 'Cliente no responde',
  not_found: 'Cliente no se encuentra',
  wrong_address: 'Dirección incorrecta',
  rejected: 'Cliente rechazó el pedido',
  other: 'Otro',
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
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

/**
 * EL PEDIDO DE ESTA CONVERSACIÓN, COMPROBADO.
 *
 * Antes de enseñar o enviar el resumen de un pedido se valida la relación
 * cliente → conversación → pedido. Es la única defensa seria contra mandarle a un
 * cliente el pedido de otro, así que es ESTRICTA a propósito:
 *   - el pedido tiene que existir;
 *   - tiene que ser de ESTE cliente (si no trae `customer_id`, no se puede
 *     demostrar que sea suyo: se rechaza);
 *   - si el pedido apunta a una conversación, tiene que ser ESTA.
 */
async function conversationOrder(store, conversation, customer, orderId) {
  const item = await findOrderItem(store, orderId);
  const order = item ? orderOf(item) : null;
  if (!order) {
    return { ok: false, status: 422, error: 'unknown_order', message: 'Ese pedido ya no existe.' };
  }
  if (!customer?.id || order.customer_id !== customer.id) {
    return {
      ok: false,
      status: 422,
      error: 'order_from_other_customer',
      message: 'Ese pedido es de otro cliente: no se envía.',
    };
  }
  if (order.conversation_id && order.conversation_id !== conversation.id) {
    return {
      ok: false,
      status: 422,
      error: 'order_from_other_conversation',
      message: 'Ese pedido pertenece a otra conversación. Ábrelo desde su chat.',
    };
  }
  return { ok: true, item, order };
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

/**
 * AVISO EN VIVO DEL CHAT (SSE).
 *
 * El panel escucha en `/api/admin/whatsapp/events` y así ve un mensaje recién
 * guardado en cuanto pasa, en vez de esperar al sondeo de 8 segundos. Es lo mismo
 * que ya hace el mapa de entregas: un canal por sesión abierta y, si el
 * navegador no lo soporta, el sondeo sigue ahí como red de seguridad.
 *
 * El aviso lleva SOLO lo mínimo (de qué conversación es y qué ha cambiado): quien
 * escucha ya tiene permiso para pedir el hilo, así que no se envía contenido a
 * quien no debería verlo. Y sin `await`: avisar no puede frenar el guardado.
 *
 * @param {any} ctx
 * @param {{ type: string, conversationId?: string|null, customerId?: string|null,
 *           direction?: string|null, status?: string|null, message?: any }} info
 */
function emitChatEvent(ctx, info) {
  const clients = ctx?.chatEventClients;
  if (!clients?.size || !info?.conversationId) return;
  const event = info.type === 'status' ? 'wa.status' : 'wa.message';
  const payload = {
    ok: true,
    type: info.type,
    conversationId: info.conversationId,
    customerId: info.customerId ?? null,
    direction: info.direction ?? null,
    status: info.status ?? info.message?.status ?? null,
    messageId: info.message?.id ?? null,
    at: info.message?.created_at ?? new Date().toISOString(),
  };
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...clients]) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

async function emitDeliveryEvent(ctx, type, session) {  if (!ctx.deliveryEventClients?.size || !session) return;
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

async function assignDeliveryToOrder(ctx, item, deliveryUser, actor = null, options = {}) {
  const current = orderOf(item);
  if (!current) return null;
  const previousUserId = text(current.delivery?.delivery_user_id, 80);
  const sameDelivery = previousUserId && previousUserId === deliveryUser?.id;
  const assignmentNote = text(options.assignmentNote ?? options.assignment_note ?? current.delivery?.delivery_assignment_note, 600);
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
      delivery_assignment_note: assignmentNote ?? null,
      delivery_assignment_note_by_user_id: assignmentNote && actor?.actor_type === 'USER' ? actor.id : null,
      delivery_assignment_note_by_display_name_snapshot: assignmentNote ? actor?.display_name ?? null : null,
      delivery_assignment_note_at: assignmentNote ? ctx.clock().toISOString() : null,
    },
    updated_at: ctx.clock().toISOString(),
  };
  const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
  const order = orderOf(updated) ?? next;
  const action = !deliveryUser
    ? 'delivery.unassigned'
    : previousUserId && previousUserId !== deliveryUser?.id
      ? 'delivery.reassigned'
      : 'delivery.assigned';
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action,
    actor: actor?.display_name ?? null,
    summary: `Delivery asignado a ${deliveryUser?.display_name ?? 'sin asignar'}`,
    data: {
      previous_delivery_user_id: previousUserId ?? null,
      delivery_user_id: deliveryUser?.id ?? null,
      assignment_version: assignmentVersion,
      delivery_assignment_note: assignmentNote ?? null,
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

function isDeliveryOnly(actor) {
  return actor?.actor_type === 'USER' && String(actor?.role ?? '').toUpperCase() === 'DELIVERY';
}

async function canReadOrder(ctx, actor, itemOrOrder) {
  if (!itemOrOrder) return false;
  if (!isDeliveryOnly(actor)) return hasPermission(actor, 'orders.read') || hasPermission(actor, 'orders.update_operational') || hasPermission(actor, 'admin.full') || actor?.actor_type !== 'USER';
  const looksLikeItem = itemOrOrder.order_json || itemOrOrder.orderJson || itemOrOrder.type === 'order_intent';
  const order = looksLikeItem ? orderOf(itemOrOrder) : itemOrOrder;
  return canOpenDeliveryOrder(actor, order);
}

async function deliveryAccessScope(ctx, actor) {
  if (!isDeliveryOnly(actor)) return { restricted: false, orderIds: null, customerIds: null, conversationIds: null };
  const orderIds = new Set();
  const customerIds = new Set();
  const conversationIds = new Set();
  const rows = await ctx.store.listAdmin({ limit: 5000 });
  for (const item of rows) {
    if (item.type !== 'order_intent') continue;
    const order = orderOf(item);
    if (!canOpenDeliveryOrder(actor, order)) continue;
    orderIds.add(item.id);
    if (order?.customer_id ?? item.customer_id) customerIds.add(order?.customer_id ?? item.customer_id);
    if (order?.conversation_id ?? item.conversation_id) conversationIds.add(order?.conversation_id ?? item.conversation_id);
  }
  const conversations = await ctx.db.list('conversations', { limit: 5000 });
  for (const conversation of conversations) {
    if (customerIds.has(conversation.customer_id)) conversationIds.add(conversation.id);
  }
  return { restricted: true, orderIds, customerIds, conversationIds };
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
    currency: order?.currency ?? item.currency ?? 'DOP',
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
  const conversations = await ctx.db.list('conversations', { limit: 5000 });
  const orders = [];
  for (const item of items.filter((row) => row.type === 'order_intent')) {
    const order = orderOf(item);
    if (!canOpenDeliveryOrder(actor, order)) continue;
    const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
    const conversation = order.conversation_id
      ? await findConversation(ctx, order.conversation_id)
      : conversations.find((row) => customer?.id && row.customer_id === customer.id) ?? null;
    orders.push(publicDeliveryOrder(item, order, customer, conversation));
  }
  return orders;
}

async function closeActiveTrackingForOrder(ctx, orderId, status, actor = null) {
  const sessions = await ctx.db.list('delivery_tracking_sessions', { limit: 1000 });
  const active = sessions.filter((row) => row.order_id === orderId && row.status === ACTIVE_TRACKING_STATUS);
  const closed = [];
  for (const session of active) {
    const updated = await ctx.db.update('delivery_tracking_sessions', session.id, {
      status,
      ended_at: session.ended_at ?? ctx.clock().toISOString(),
      updated_at: ctx.clock().toISOString(),
      closed_by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
    });
    closed.push(updated);
    await emitDeliveryEvent(ctx, status === 'COMPLETED' ? 'delivery.completed' : 'delivery.tracking_stopped', updated);
  }
  return closed;
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
  const summary = {
    configured: Boolean(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY),
    subscriptions: subscriptions.length,
    attempted: 0,
    sent: 0,
    failed: 0,
    expired: 0,
    notConfigured: 0,
    skipped: 0,
  };
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
    if (existing) {
      summary.skipped += 1;
      continue;
    }
    summary.attempted += 1;
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
    if (status === 'sent') summary.sent += 1;
    else if (status === 'expired') summary.expired += 1;
    else if (status === 'not_configured') summary.notConfigured += 1;
    else summary.failed += 1;
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
  return summary;
}

function pushEndpointSummary(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.hostname}…${String(endpoint).slice(-10)}`;
  } catch {
    return `endpoint…${String(endpoint ?? '').slice(-10)}`;
  }
}

/**
 * A QUÉ usuario se le apunta el push de esta sesión.
 *
 * El panel se puede abrir con la CLAVE del panel (el actor queda como
 * `Panel legacy`): esa sesión manda como ADMIN pero NO tiene usuario. Al guardar
 * la suscripción se exigía `currentUser`, así que la clave recibía 403, el
 * teléfono no quedaba registrado NUNCA y no llegaba ni una notificación push
 * (verificado en producción: `activeSubscriptions: 0` con el panel en uso).
 *
 * Se resuelve el dueño real: el admin de bootstrap (el dueño del panel) o, si no
 * está, el primer ADMIN activo. Así la suscripción casa con las notificaciones
 * que se crean para los administradores y el teléfono vuelve a recibirlas.
 *
 * @param {any} ctx
 * @param {{ id?: string|null, role?: string|null, actor_type?: string|null }} actor
 */
async function pushOwnerUserId(ctx, actor) {
  if (actor?.actor_type === 'USER' && actor.id) return actor.id;
  if (actor?.actor_type !== 'LEGACY') return null;
  const admins = (await ctx.users.listUsers()).filter((user) => user.active !== false && user.role === 'ADMIN');
  const preferred =
    (BOOTSTRAP_ADMIN_USER ? admins.find((user) => user.username === BOOTSTRAP_ADMIN_USER) : null) ?? admins[0] ?? null;
  return preferred?.id ?? null;
}

async function pushStatusForUser(ctx, userId) {
  if (!userId) {
    return {
      configured: Boolean(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY),
      publicKey: WEB_PUSH_PUBLIC_KEY || null,
      activeSubscriptions: 0,
      inactiveSubscriptions: 0,
      subscriptions: [],
      recentJobs: [],
    };
  }
  const subscriptions = (await ctx.db.list('push_subscriptions', { by: 'updated_at', order: 'desc', limit: 1000 })).filter((row) => row.user_id === userId);
  const jobs = (await ctx.db.list('push_jobs', { by: 'created_at', order: 'desc', limit: 200 })).filter((row) => row.user_id === userId).slice(0, 20);
  return {
    configured: Boolean(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY),
    publicKey: WEB_PUSH_PUBLIC_KEY || null,
    activeSubscriptions: subscriptions.filter((row) => row.active !== false).length,
    inactiveSubscriptions: subscriptions.filter((row) => row.active === false).length,
    subscriptions: subscriptions.slice(0, 5).map((row) => ({
      id: row.id,
      active: row.active !== false,
      endpoint: pushEndpointSummary(row.endpoint),
      user_agent: row.user_agent ?? null,
      last_used_at: row.last_used_at ?? null,
      last_error: row.last_error ?? null,
      updated_at: row.updated_at,
    })),
    recentJobs: jobs.map((row) => ({
      id: row.id,
      notification_id: row.notification_id,
      status: row.status,
      error: row.error ?? null,
      created_at: row.created_at,
    })),
  };
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
    return users.filter((user) => user.id === conversation.assigned_user_id || user.role === 'ADMIN');
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

async function conversationForOrderCustomer(ctx, order) {
  if (order?.conversation_id) {
    const linked = await findConversation(ctx, order.conversation_id);
    if (linked) return linked;
  }
  const customerId = order?.customer_id ?? null;
  if (!customerId) return null;
  const conversations = await ctx.db.list('conversations', { limit: 5000 });
  return conversations
    .filter((row) => row.customer_id === customerId)
    .sort((a, b) => String(b.last_message_at ?? b.updated_at ?? b.created_at ?? '').localeCompare(String(a.last_message_at ?? a.updated_at ?? a.created_at ?? '')))[0] ?? null;
}

function deliveryNotificationText(kind, customer, order) {
  const name = customer?.name || customer?.phone_e164 || 'cliente';
  if (kind === 'assignment') {
    const deliveryName = order?.delivery?.delivery_user_name_snapshot || 'nuestro delivery';
    return `Hola ${name}, tu pedido ha sido asignado a nuestro delivery ${deliveryName}. Te estará contactando para coordinar la entrega.`;
  }
  return `Hola ${name}, hemos registrado tu pedido ${order?.order_number ?? order?.id ?? ''} como entregado. Gracias por elegir Phytoemagry.`;
}

async function rememberDeliveryNotificationResult(ctx, item, order, key, result) {
  const currentItem = (await findOrderItem(ctx.store, item.id)) ?? item;
  const current = orderOf(currentItem) ?? order;
  const next = {
    ...current,
    delivery: {
      ...(current.delivery ?? {}),
      [`${key}_notification`]: {
        status: result.status,
        channel: result.channel ?? null,
        template: result.template ?? null,
        conversation_id: result.conversation_id ?? null,
        message_id: result.message_id ?? null,
        reason: result.reason ?? null,
        attempted_at: ctx.clock().toISOString(),
      },
    },
    updated_at: ctx.clock().toISOString(),
  };
  const updated = await ctx.store.update(currentItem.id, { orderJson: JSON.stringify(next) });
  return orderOf(updated) ?? next;
}

async function notifyDeliveryCustomer(ctx, { item, order, actor = null, kind }) {
  const key = kind === 'assignment' ? 'assignment_customer' : 'delivered_customer';
  const sentAction =
    kind === 'assignment'
      ? 'delivery.customer_assignment_notification_sent'
      : 'delivery.customer_delivery_notification_sent';
  const failedAction =
    kind === 'assignment'
      ? 'delivery.customer_assignment_notification_failed'
      : 'delivery.customer_delivery_notification_failed';
  const existing = order?.delivery?.[`${key}_notification`];
  if (existing?.status === 'sent' || existing?.status === 'pending') return { status: existing.status, duplicate: true };

  const customer = order?.customer_id ? await ctx.customers.get(order.customer_id) : null;
  const conversation = await conversationForOrderCustomer(ctx, order);
  const deliveryUserId = order?.delivery?.delivery_user_id ?? null;
  const data = {
    order_id: item.id,
    customer_id: customer?.id ?? order?.customer_id ?? null,
    conversation_id: conversation?.id ?? null,
    delivery_user_id: deliveryUserId,
    timestamp: ctx.clock().toISOString(),
  };
  const record = (result) => rememberDeliveryNotificationResult(ctx, item, order, key, { ...result, conversation_id: conversation?.id ?? null });

  if (!customer?.phone_e164 || !conversation || !ctx.whatsapp?.enabled) {
    const result = { status: 'not_applicable', reason: !customer?.phone_e164 ? 'missing_phone' : !conversation ? 'missing_conversation' : 'whatsapp_not_configured' };
    await record(result);
    return result;
  }

  const templateName = kind === 'assignment' ? DELIVERY_ASSIGNMENT_TEMPLATE : DELIVERY_DELIVERED_TEMPLATE;
  let sendResult = null;
  let channel = 'text';
  let template = null;
  if (ctx.customers.canSendFreeText(conversation)) {
    sendResult = await ctx.whatsapp.sendText(customer.phone_e164, deliveryNotificationText(kind, customer, order));
  } else {
    await refreshTemplateFromMeta(ctx, templateName);
    const check = await approvedTemplate(ctx, templateName);
    if (!check.ok) {
      const result = { status: 'pending', channel: 'template', template: templateName, reason: check.reason };
      await record(result);
      return result;
    }
    template = check.template;
    const payload = await resolveTemplatePayload(ctx, { template, customer, conversation, orderId: item.id });
    if (!payload.ok) {
      const result = { status: 'failed', channel: 'template', template: templateName, reason: payload.error };
      await record(result);
      await ctx.audit?.record({ entity: 'order', entityId: item.id, action: failedAction, actor: actor?.display_name ?? null, summary: `No se pudo notificar al cliente: ${payload.error}`, data: { ...data, error: payload.error } });
      return result;
    }
    channel = 'template';
    sendResult = await ctx.whatsapp.sendTemplate(customer.phone_e164, {
      name: template.name,
      language: template.language ?? 'es',
      components: payload.components,
    });
  }

  if (!sendResult?.ok) {
    const reason = sendResult?.error?.message ?? sendResult?.reason ?? 'send_failed';
    const result = { status: 'failed', channel, template: template?.name ?? null, reason };
    await record(result);
    await ctx.audit?.record({ entity: 'order', entityId: item.id, action: failedAction, actor: actor?.display_name ?? null, summary: `No se pudo notificar al cliente: ${reason}`, data: { ...data, error: reason } });
    return result;
  }

  const result = { status: 'sent', channel, template: template?.name ?? null, message_id: sendResult.messageId ?? null };
  await record(result);
  await ctx.audit?.record({ entity: 'order', entityId: item.id, action: sentAction, actor: actor?.display_name ?? null, summary: 'Cliente notificado por delivery', data: { ...data, channel, template: template?.name ?? null, message_id: sendResult.messageId ?? null } });
  return result;
}

function normalizeDeliveryControlSettings(raw = null) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const reminder = Number(source.deliveryReminderMinutes ?? source.delivery_reminder_minutes ?? DELIVERY_CONTROL_DEFAULTS.deliveryReminderMinutes);
  const escalation = Number(source.deliveryAdminEscalationMinutes ?? source.delivery_admin_escalation_minutes ?? DELIVERY_CONTROL_DEFAULTS.deliveryAdminEscalationMinutes);
  const contactsRaw = Array.isArray(source.deliveryAdminEscalationContacts ?? source.delivery_admin_escalation_contacts)
    ? source.deliveryAdminEscalationContacts ?? source.delivery_admin_escalation_contacts
    : DELIVERY_CONTROL_DEFAULTS.deliveryAdminEscalationContacts;
  const contacts = contactsRaw
    .map((row) => ({ name: text(row?.name, 80) ?? 'Admin', phone: toE164(row?.phone) }))
    .filter((row) => row.phone);
  return {
    deliveryReminderMinutes: Number.isFinite(reminder) && reminder > 0 ? reminder : DELIVERY_CONTROL_DEFAULTS.deliveryReminderMinutes,
    deliveryAdminEscalationMinutes: Number.isFinite(escalation) && escalation > 0 ? escalation : DELIVERY_CONTROL_DEFAULTS.deliveryAdminEscalationMinutes,
    deliveryAdminEscalationContacts: contacts.length ? contacts : DELIVERY_CONTROL_DEFAULTS.deliveryAdminEscalationContacts.map((row) => ({ ...row, phone: toE164(row.phone) })),
  };
}

async function deliveryControlSettings(ctx) {
  const doc = await ctx.settings.read(DELIVERY_CONTROL_SETTINGS_KEY);
  return normalizeDeliveryControlSettings(doc?.value);
}

function deliveryControlCanEscalate(order) {
  return order?.delivery?.delivery_user_id &&
    order.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT &&
    !['entregado', 'cancelado', 'perdido'].includes(String(order.status ?? ''));
}

function deliveryControlRecipients(user) {
  return [
    { key: 'personal', phone: toE164(user?.personal_phone), label: 'personal' },
    { key: 'fleet', phone: toE164(user?.fleet_phone), label: 'flota' },
  ].filter((row) => row.phone);
}

function deliveryControlStatus(order, key, version) {
  const current = order?.delivery?.[key];
  if (!current || Number(current.assignment_version ?? 0) !== Number(version)) return {};
  return current;
}

async function updateDeliveryControlStatus(ctx, item, order, key, version, recipientKey, result) {
  const currentItem = (await findOrderItem(ctx.store, item.id)) ?? item;
  const current = orderOf(currentItem) ?? order;
  const existing = deliveryControlStatus(current, key, version);
  const nextEntry = {
    ...existing,
    assignment_version: version,
    attempted_at: ctx.clock().toISOString(),
    recipients: {
      ...(existing.recipients ?? {}),
      [recipientKey]: {
        status: result.status,
        phone_masked: result.phone ? `***${String(result.phone).slice(-4)}` : null,
        message_id: result.message_id ?? null,
        error: result.error ?? null,
        at: ctx.clock().toISOString(),
      },
    },
  };
  const next = {
    ...current,
    delivery: { ...(current.delivery ?? {}), [key]: nextEntry },
    updated_at: ctx.clock().toISOString(),
  };
  const updated = await ctx.store.update(currentItem.id, { orderJson: JSON.stringify(next) });
  return orderOf(updated) ?? next;
}

async function sendDeliveryControlTemplate(ctx, { item, order, templateName, to, provided }) {
  if (!ctx.whatsapp?.enabled) return { status: 'failed', error: 'whatsapp_not_configured' };
  await refreshTemplateFromMeta(ctx, templateName);
  const check = await approvedTemplate(ctx, templateName);
  if (!check.ok) return { status: 'pending', error: check.reason };
  const customer = order?.customer_id ? await ctx.customers.get(order.customer_id) : null;
  const payload = await resolveTemplatePayload(ctx, {
    template: check.template,
    customer,
    conversation: await conversationForOrderCustomer(ctx, order),
    orderId: item.id,
    provided,
  });
  if (!payload.ok) return { status: 'failed', error: payload.error };
  const sent = await ctx.whatsapp.sendTemplate(to, {
    name: check.template.name,
    language: check.template.language ?? 'es',
    components: payload.components,
  });
  if (!sent.ok) return { status: 'failed', error: sent.error?.message ?? sent.reason ?? 'send_failed' };
  return { status: 'sent', message_id: sent.messageId ?? null };
}

async function maybeSendDeliveryReminder(ctx, item, order, deliveryUser, version) {
  const recipients = deliveryControlRecipients(deliveryUser);
  if (!recipients.length) return { sent: 0, failed: 0, pending: 0, skipped: true };
  let currentOrder = order;
  let sent = 0;
  let failed = 0;
  let pending = 0;
  const status = deliveryControlStatus(currentOrder, 'reminder_5m', version);
  for (const recipient of recipients) {
    if (status.recipients?.[recipient.key]?.status === 'sent') continue;
    const result = await sendDeliveryControlTemplate(ctx, {
      item,
      order: currentOrder,
      templateName: DELIVERY_REMINDER_TEMPLATE,
      to: recipient.phone,
      provided: {
        1: deliveryUser.display_name ?? 'Delivery',
        2: order.order_number ?? item.id,
        3: orderDeliveryDeepLink(item.id),
      },
    });
    currentOrder = await updateDeliveryControlStatus(ctx, item, currentOrder, 'reminder_5m', version, recipient.key, { ...result, phone: recipient.phone });
    if (result.status === 'sent') sent += 1;
    else if (result.status === 'pending') pending += 1;
    else failed += 1;
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: result.status === 'sent' ? 'delivery.reminder_5m_sent' : 'delivery.reminder_5m_failed',
      actor: 'Sistema',
      summary: result.status === 'sent' ? `Recordatorio enviado al delivery (${recipient.label})` : `Recordatorio delivery pendiente/fallido (${recipient.label})`,
      data: { order_id: item.id, delivery_user_id: deliveryUser.id, assignment_version: version, recipient: recipient.key, template: DELIVERY_REMINDER_TEMPLATE, message_id: result.message_id ?? null, error: result.error ?? null },
      idempotencyKey: `delivery-reminder-5m:${item.id}:${version}:${recipient.key}:${result.status === 'sent' ? 'sent' : ctx.clock().toISOString()}`,
    });
  }
  return { sent, failed, pending };
}

async function maybeSendDeliveryAdminEscalation(ctx, item, order, deliveryUser, version, settings) {
  let currentOrder = order;
  let sent = 0;
  let failed = 0;
  let pending = 0;
  const status = deliveryControlStatus(currentOrder, 'escalation_30m', version);
  for (const contact of settings.deliveryAdminEscalationContacts) {
    const key = contact.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || contact.phone.slice(-4);
    if (status.recipients?.[key]?.status === 'sent') continue;
    const result = await sendDeliveryControlTemplate(ctx, {
      item,
      order: currentOrder,
      templateName: DELIVERY_ADMIN_ESCALATION_TEMPLATE,
      to: contact.phone,
      provided: { 1: order.order_number ?? item.id, 2: deliveryUser.display_name ?? 'Delivery', 3: orderDeliveryDeepLink(item.id) },
    });
    currentOrder = await updateDeliveryControlStatus(ctx, item, currentOrder, 'escalation_30m', version, key, { ...result, phone: contact.phone });
    if (result.status === 'sent') sent += 1;
    else if (result.status === 'pending') pending += 1;
    else failed += 1;
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: result.status === 'sent' ? 'delivery.escalation_30m_sent' : 'delivery.escalation_30m_failed',
      actor: 'Sistema',
      summary: result.status === 'sent' ? `Escalamiento enviado a ${contact.name}` : `Escalamiento pendiente/fallido para ${contact.name}`,
      data: { order_id: item.id, delivery_user_id: deliveryUser.id, assignment_version: version, admin: contact.name, template: DELIVERY_ADMIN_ESCALATION_TEMPLATE, message_id: result.message_id ?? null, error: result.error ?? null },
      idempotencyKey: `delivery-escalation-30m:${item.id}:${version}:${key}:${result.status === 'sent' ? 'sent' : ctx.clock().toISOString()}`,
    });
  }
  return { sent, failed, pending };
}

async function notifyAdminsDeliveryCompleted(ctx, item, order, actor = null) {
  const settings = await deliveryControlSettings(ctx);
  const version = Number(order.delivery?.delivery_assignment_version ?? 1);
  let currentOrder = order;
  const status = deliveryControlStatus(currentOrder, 'admin_delivered_notification', version);
  const deliveryUser = order.delivery?.delivery_user_id ? await ctx.users.get(order.delivery.delivery_user_id) : null;
  const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
  for (const contact of settings.deliveryAdminEscalationContacts) {
    const key = contact.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || contact.phone.slice(-4);
    if (status.recipients?.[key]?.status === 'sent') continue;
    const result = await sendDeliveryControlTemplate(ctx, {
      item,
      order: currentOrder,
      templateName: DELIVERY_ADMIN_DELIVERED_TEMPLATE,
      to: contact.phone,
      provided: {
        1: order.order_number ?? item.id,
        2: deliveryUser?.display_name ?? order.delivery?.delivery_user_name_snapshot ?? 'Delivery',
        3: customer?.name ?? customer?.phone_e164 ?? 'Cliente',
        4: order.delivered_at ? new Date(order.delivered_at).toLocaleString('es-DO') : ctx.clock().toISOString(),
        5: orderDeliveryDeepLink(item.id),
      },
    });
    currentOrder = await updateDeliveryControlStatus(ctx, item, currentOrder, 'admin_delivered_notification', version, key, { ...result, phone: contact.phone });
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: result.status === 'sent' ? 'delivery.admin_delivery_notification_sent' : 'delivery.admin_delivery_notification_failed',
      actor: actor?.display_name ?? 'Sistema',
      summary: result.status === 'sent' ? `Admin notificado de entrega (${contact.name})` : `Aviso de entrega admin pendiente/fallido (${contact.name})`,
      data: { order_id: item.id, delivery_user_id: deliveryUser?.id ?? null, assignment_version: version, admin: contact.name, template: DELIVERY_ADMIN_DELIVERED_TEMPLATE, message_id: result.message_id ?? null, error: result.error ?? null },
      idempotencyKey: `delivery-admin-delivered:${item.id}:${version}:${key}:${result.status === 'sent' ? 'sent' : ctx.clock().toISOString()}`,
    });
  }
}

async function deliveryControlTick(ctx) {
  const settings = await deliveryControlSettings(ctx);
  const now = ctx.clock().getTime();
  const rows = await ctx.store.listAdmin({ limit: 5000 });
  let reminders = 0;
  let escalations = 0;
  for (const item of rows.filter((row) => row.type === 'order_intent')) {
    const order = orderOf(item);
    if (!deliveryControlCanEscalate(order)) continue;
    const assignedAt = Date.parse(order.delivery?.delivery_assigned_at ?? '');
    if (!Number.isFinite(assignedAt)) continue;
    const version = Number(order.delivery?.delivery_assignment_version ?? 1);
    const deliveryUser = await ctx.users.get(order.delivery.delivery_user_id);
    if (!deliveryUser || deliveryUser.active === false) continue;
    const ageMinutes = (now - assignedAt) / 60_000;
    if (ageMinutes >= settings.deliveryReminderMinutes) {
      const result = await maybeSendDeliveryReminder(ctx, item, order, deliveryUser, version);
      reminders += result.sent + result.failed + result.pending;
    }
    const freshItem = await findOrderItem(ctx.store, item.id);
    const freshOrder = orderOf(freshItem) ?? order;
    if (!deliveryControlCanEscalate(freshOrder)) continue;
    if (ageMinutes >= settings.deliveryAdminEscalationMinutes) {
      const result = await maybeSendDeliveryAdminEscalation(ctx, freshItem ?? item, freshOrder, deliveryUser, version, settings);
      escalations += result.sent + result.failed + result.pending;
    }
  }
  return { reminders, escalations };
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

/**
 * ¿Quién puede llevar un pedido en mano?
 *
 * El negocio no tiene un equipo de reparto aparte: el pedido se le pasa a un
 * AGENTE y ese agente lo entrega (por eso el agente también tiene los permisos
 * de reparto «propios»). «DELIVERY» sigue valiendo para las cuentas que ya
 * existen con ese rol. Un administrador NO se pone a repartir: gestiona.
 */
const DELIVERY_CAPABLE_ROLES = Object.freeze(['AGENT', 'DELIVERY']);

function canDeliver(user) {
  return DELIVERY_CAPABLE_ROLES.includes(String(user?.role ?? '').toUpperCase());
}

function messageNeedsDeliveryIdentity(order, actor) {
  if (!order || !canDeliver(actor)) return false;
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
  if (!conversation?.id || !canDeliver(actor)) return null;
  const items = await ctx.store.listAdmin({ limit: 5000 });
  const candidates = [];
  for (const item of items.filter((row) => row.type === 'order_intent')) {
    const order = orderOf(item);
    const sameConversation = (order?.conversation_id ?? item.conversation_id) === conversation.id;
    const sameCustomer = (order?.customer_id ?? item.customer_id) === conversation.customer_id;
    if (!sameConversation && !sameCustomer) continue;
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

/**
 * QUÉ PUEDE ABRIR ESTE USUARIO, resuelto de UNA pasada.
 *
 * Se calcula así (y no conversación a conversación) porque la lista de
 * conversaciones y la de seguimientos lo preguntan muchas veces seguidas:
 *
 *   - administración (o la clave del panel) → todo;
 *   - si no: las conversaciones ASIGNADAS a él, más las de los pedidos que él
 *     lleva repartiendo (el repartidor tiene que poder hablar con su cliente).
 *
 * @param {any} ctx
 * @param {any} actor
 * @returns {Promise<{all: boolean, conversationIds: Set<string>|null, customerIds: Set<string>|null}>}
 */
async function conversationAccess(ctx, actor) {
  if (hasPermission(actor, 'chats.force_reassign') || !actor?.id || actor.actor_type !== 'USER') {
    return { all: true, conversationIds: null, customerIds: null };
  }
  const conversations = await ctx.db.list('conversations', { limit: 5000 });
  const conversationIds = new Set();
  for (const conversation of conversations) {
    if (conversation.assigned_user_id === actor.id) conversationIds.add(conversation.id);
  }
  const rows = await ctx.store.listAdmin({ limit: 5000 });
  for (const item of rows) {
    if (item.type !== 'order_intent' || !item.conversation_id) continue;
    const order = orderOf(item);
    if (order?.delivery?.delivery_user_id === actor.id) conversationIds.add(item.conversation_id);
  }
  const customerIds = new Set();
  for (const conversation of conversations) {
    if (conversationIds.has(conversation.id)) customerIds.add(conversation.customer_id);
  }
  return { all: false, conversationIds, customerIds };
}

/**
 * LA REGLA DE ORO: ¿puede este usuario ABRIR esta conversación?
 *
 * El negocio lo pidió BLINDADO: un agente (o repartidor) que no administra solo
 * entra en lo que es SUYO. Lo demás se sigue viendo en la LISTA (nombre y último
 * mensaje, como en WhatsApp), pero el contenido —hilo, seguimientos, escribir—
 * necesita que alguien se lo asigne. Y para eso está la solicitud, que avisa a
 * administración.
 *
 * @param {any} ctx
 * @param {any} actor
 * @param {any} conversation
 */
async function canOpenConversation(ctx, actor, conversation) {
  if (!conversation) return false;
  const access = await conversationAccess(ctx, actor);
  return access.all || access.conversationIds.has(conversation.id);
}

/** ¿Puede este usuario trabajar con ese cliente (seguimientos, tareas)? */
async function canWorkWithCustomer(ctx, actor, customerId) {
  if (!customerId) return false;
  const access = await conversationAccess(ctx, actor);
  if (access.all || access.customerIds.has(customerId)) return true;
  const deliveryScope = await deliveryAccessScope(ctx, actor);
  return deliveryScope.restricted && deliveryScope.customerIds.has(customerId);
}

/** Respuesta única cuando la conversación no es suya. */
function denyConversation(res, json, conversation) {
  const assigned = conversation?.assigned_display_name_snapshot ?? null;
  json(res, 403, {
    ok: false,
    error: 'not_your_conversation',
    message: assigned
      ? `Esta conversación está al frente de ${assigned}. Pide que te la asignen para verla y contestar.`
      : 'Esta conversación todavía no está asignada a ti. Pide que te la asignen para verla y contestar.',
    assigned_user_id: conversation?.assigned_user_id ?? null,
    assigned_display_name: assigned,
  });
  return true;
}

async function markDeliveryContacted(ctx, item, order, actor) {  if (!item || !order || !canDeliver(actor) || order.delivery?.delivery_user_id !== actor.id) return null;
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

async function reportDeliveryIssue(ctx, item, actor, input = {}) {
  const order = orderOf(item);
  if (!order) return { ok: false, status: 422, error: 'invalid_order' };
  if (!canDeliver(actor) || order.delivery?.delivery_user_id !== actor.id) return { ok: false, status: 403, error: 'forbidden' };
  const status = String(order.status ?? item.status ?? '');
  if (isCompletedPurchaseStatus(status)) return { ok: false, status: 409, error: 'order_delivered', message: 'Este pedido ya fue entregado.' };
  if (['cancelado', 'perdido'].includes(status)) return { ok: false, status: 409, error: 'order_cancelled', message: 'Este pedido ya está cancelado.' };
  const reasonCode = text(input.reason ?? input.issue_reason, 40);
  if (!reasonCode || !DELIVERY_ISSUE_REASONS[reasonCode]) {
    return { ok: false, status: 422, error: 'missing_reason', message: 'Elige un motivo de incidencia.' };
  }
  const note = longText(input.note ?? input.issue_note, 500) ?? '';
  if (reasonCode === 'other' && note.trim().length < 3) {
    return { ok: false, status: 422, error: 'missing_note', message: 'Escribe una nota para explicar la incidencia.' };
  }
  const at = ctx.clock().toISOString();
  const next = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      delivery_status: DELIVERY_OPERATIONAL_STATUSES.ISSUE_REPORTED,
      issue_reason: reasonCode,
      issue_reason_label: DELIVERY_ISSUE_REASONS[reasonCode],
      issue_note: note || null,
      issue_reported_at: at,
      issue_reported_by_user_id: actor.id,
      issue_reported_by_name: actor.display_name ?? null,
    },
    updated_at: at,
  };
  const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
  const closed = await closeActiveTrackingForOrder(ctx, item.id, 'PAUSED', actor);
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'delivery.issue_reported',
    actor: actor?.display_name ?? null,
    summary: `Incidencia de entrega: ${DELIVERY_ISSUE_REASONS[reasonCode]}`,
    data: {
      order_id: item.id,
      customer_id: order.customer_id ?? item.customer_id ?? null,
      conversation_id: order.conversation_id ?? item.conversation_id ?? null,
      delivery_user_id: order.delivery?.delivery_user_id ?? null,
      issue_reason: reasonCode,
      issue_note: note || null,
      timestamp: at,
      tracking_closed: closed.length,
    },
    idempotencyKey: `delivery.issue:${item.id}:${actor.id}:${at}`,
  });
  return { ok: true, order: orderOf(updated) ?? next, closedTracking: closed };
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

async function withOrderTransitionLock(orderId, work) {
  const previous = orderTransitionLocks.get(orderId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  orderTransitionLocks.set(orderId, queued);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (orderTransitionLocks.get(orderId) === queued) orderTransitionLocks.delete(orderId);
  }
}

function paymentMethodLabel(value) {
  return value ? PAYMENT_METHOD_LABELS[value] ?? value : null;
}

function statusLabel(value) {
  return value ? ORDER_STATUS_LABELS[value] ?? String(value) : '—';
}

function manualReason(value) {
  const clean = longText(value, 500);
  if (!clean) return null;
  if (clean.length < 6) return null;
  if (/^[\W_]+$/u.test(clean)) return null;
  if (/^(ok|okay|bien|listo|na|n\/a)$/i.test(clean)) return null;
  return clean;
}

function orderOperationalStatus(order, item = null, activeSessions = []) {
  const status = String(order?.status ?? item?.status ?? '').trim();
  if (status === 'cancelado' || status === 'perdido') return 'CANCELADO';
  if (isCompletedPurchaseStatus(status)) return 'ENTREGADO';
  if (order?.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.ISSUE_REPORTED) return 'INCIDENCIA';
  if (activeSessions.length || status === 'enviado' || order?.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT) return 'EN_CAMINO';
  return 'PENDIENTE';
}

async function activeTrackingSessionsForOrder(ctx, orderId) {
  const sessions = await ctx.db.list('delivery_tracking_sessions', { limit: 1000 });
  return sessions.filter((row) => row.order_id === orderId && row.status === ACTIVE_TRACKING_STATUS);
}

async function validateOrderOperationalIntegrity(ctx, orderId) {
  const item = await findOrderItem(ctx.store, orderId);
  if (!item) return { status: 'INVALID', valid: false, reasons: ['order_not_found'] };
  const order = orderOf(item);
  if (!order) return { status: 'INVALID', valid: false, reasons: ['invalid_order_json'] };
  const activeSessions = await activeTrackingSessionsForOrder(ctx, orderId);
  const operationalStatus = orderOperationalStatus(order, item, activeSessions);
  const reasons = [];
  if (operationalStatus === 'PENDIENTE' && activeSessions.length) reasons.push('pending_has_active_tracking');
  if (operationalStatus === 'EN_CAMINO') {
    if (!order.delivery?.delivery_user_id) reasons.push('in_transit_missing_delivery_assignment');
    if (!orderDestination(order)) reasons.push('in_transit_missing_destination');
    if (!activeSessions.length) reasons.push('in_transit_missing_active_tracking');
  }
  if (operationalStatus === 'ENTREGADO') {
    if (activeSessions.length) reasons.push('delivered_has_active_tracking');
    if (!order.delivered_at) reasons.push('delivered_missing_delivered_at');
    if (!order.delivered_by_user_id && !order.delivery?.delivery_delivered_by_user_id) reasons.push('delivered_missing_delivered_by');
    if (ctx.inventory) {
      const stock = await ctx.inventory.stock();
      const saleMovements = stock.movements.filter((row) => row.order_id === orderId && row.type === 'SALE');
      if (!saleMovements.length) reasons.push('delivered_missing_inventory_sale');
      if (saleMovements.length > 1 && !stock.movements.some((row) => row.order_id === orderId && row.type === 'SALE_REVERSAL')) {
        reasons.push('delivered_multiple_inventory_sales');
      }
    }
  }
  if (operationalStatus === 'CANCELADO' && activeSessions.length) reasons.push('cancelled_has_active_tracking');
  return {
    status: reasons.length ? 'INVALID' : 'VALID',
    valid: reasons.length === 0,
    reasons,
    operationalStatus,
    orderId,
  };
}

async function orderTimeline(ctx, orderId, order = null) {
  const auditRows = await ctx.audit?.list?.({ entity: 'order', entityId: orderId, limit: 100 }) ?? [];
  const rows = [];
  if (order?.created_at) {
    rows.push({
      type: 'created',
      label: 'Pedido creado',
      at: order.created_at,
      by: order.created_by_display_name_snapshot ?? null,
      reason: null,
    });
  }
  for (const row of order?.status_history ?? []) {
    rows.push({
      type: 'status',
      label: `Estado cambiado a ${statusLabel(row.status)}`,
      at: row.at,
      by: row.by ?? null,
      reason: row.reason ?? null,
      source: row.source ?? null,
    });
  }
  for (const row of auditRows) {
    const data = row.data ?? {};
    const label =
      row.action === 'order.delivery_assigned' || row.action === 'order.delivery_reassigned'
        ? 'Delivery asignado'
        : row.action === 'order.status_changed' && data.source === 'MANUAL_ADMIN'
          ? `Estado cambiado de ${statusLabel(data.previous_status)} a ${statusLabel(data.new_status)}`
          : row.action === 'order.cancelled' && data.source === 'MANUAL_ADMIN'
            ? `Estado cambiado de ${statusLabel(data.previous_status)} a Cancelado`
            : row.action === 'order.status_changed'
              ? `Estado cambiado a ${statusLabel(data.new_status)}`
              : row.summary;
    if (!label) continue;
    rows.push({
      type: row.action,
      label,
      at: row.created_at,
      by: row.actor ?? null,
      reason: data.reason ?? null,
      source: data.source ?? null,
    });
  }
  const seen = new Set();
  return rows
    .filter((row) => row.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .filter((row) => {
      const key = `${row.type}:${row.label}:${row.at}:${row.reason ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function auditOrderStatusTransition(ctx, input) {
  await ctx.audit?.record({
    entity: 'order',
    entityId: input.orderId,
    action: input.newStatus === 'cancelado' ? 'order.cancelled' : 'order.status_changed',
    actor: input.actor?.display_name ?? null,
    summary: `Estado: ${input.previousStatus ?? 'nuevo'} → ${input.newStatus}`,
    data: {
      order_id: input.orderId,
      previous_status: input.previousStatus ?? null,
      new_status: input.newStatus,
      changed_by: input.actor?.id ?? null,
      reason: input.reason ?? null,
      changed_at: input.changedAt,
      source: input.source ?? 'SYSTEM',
    },
    idempotencyKey: input.idempotencyKey ?? `order.status:${input.orderId}:${input.previousStatus ?? 'nuevo'}:${input.newStatus}:${input.source ?? 'SYSTEM'}`,
  });
}

async function markOrderDelivered(ctx, item, actor = null, options = {}) {
  const beforeStatus = item.status ?? orderOf(item)?.status ?? 'nuevo';
  const alreadyDelivered = isCompletedPurchaseStatus(beforeStatus);
  const updatedStatus = alreadyDelivered
    ? { item, order: orderOf(item) }
    : await updateOrderStatus(ctx.store, item, BUSINESS_COMPLETED_PURCHASE_STATUS, actor);
  const delivered = updatedStatus?.item && !updatedStatus.item.inventory_deducted_at ? await afterPurchaseDelivered(ctx, updatedStatus.item) : { item: updatedStatus?.item };
  const deliveredItem = delivered.item ?? updatedStatus?.item ?? item;
  let order = orderOf(deliveredItem) ?? updatedStatus?.order ?? orderOf(item);
  if (order) {
    const at = ctx.clock().toISOString();
    order = {
      ...order,
      status: BUSINESS_COMPLETED_PURCHASE_STATUS,
      delivered_at: order.delivered_at ?? at,
      delivered_by_user_id: actor?.actor_type === 'USER' ? actor.id : order.delivered_by_user_id ?? null,
      delivered_by_display_name_snapshot: actor?.display_name ?? order.delivered_by_display_name_snapshot ?? null,
      delivery: {
        ...(order.delivery ?? {}),
        delivery_status: DELIVERY_OPERATIONAL_STATUSES.DELIVERED,
        delivery_delivered_at: order.delivery?.delivery_delivered_at ?? at,
        delivery_delivered_by_user_id: actor?.actor_type === 'USER' ? actor.id : order.delivery?.delivery_delivered_by_user_id ?? null,
        delivery_delivered_by_display_name_snapshot: actor?.display_name ?? order.delivery?.delivery_delivered_by_display_name_snapshot ?? null,
      },
      status_history: [
        ...(order.status_history ?? []),
        ...(alreadyDelivered
          ? []
          : [{ status: BUSINESS_COMPLETED_PURCHASE_STATUS, at, reason: options.reason ?? null, source: options.source ?? 'SYSTEM' }]),
      ],
      updated_at: at,
    };
    const persisted = await ctx.store.update(item.id, {
      status: BUSINESS_COMPLETED_PURCHASE_STATUS,
      orderJson: JSON.stringify(order),
    });
    if (persisted) {
      delivered.item = persisted;
      order = orderOf(persisted) ?? order;
    }
  }
  await closeActiveTrackingForOrder(ctx, item.id, 'COMPLETED', actor);
  return { ok: true, item: delivered.item ?? deliveredItem, order, delivered, duplicate: alreadyDelivered };
}

async function cancelOpenOrder(ctx, item, reason, actor = null, source = 'MANUAL_ADMIN') {
  const order = orderOf(item);
  if (!order) return { ok: false, status: 422, error: 'invalid_order' };
  const at = ctx.clock().toISOString();
  const cancelledOrder = {
    ...order,
    status: 'cancelado',
    cancelled_at: order.cancelled_at ?? at,
    cancelled_by_user_id: actor?.actor_type === 'USER' ? actor.id : order.cancelled_by_user_id ?? null,
    cancelled_by_display_name_snapshot: actor?.display_name ?? order.cancelled_by_display_name_snapshot ?? null,
    cancel_reason: reason,
    delivery: {
      ...(order.delivery ?? {}),
      delivery_status: DELIVERY_OPERATIONAL_STATUSES.CANCELLED,
    },
    status_history: [...(order.status_history ?? []), { status: 'cancelado', at, reason, source }],
    updated_at: at,
  };
  const updated = await ctx.store.update(item.id, { status: 'cancelado', orderJson: JSON.stringify(cancelledOrder) });
  await closeActiveTrackingForOrder(ctx, item.id, 'CANCELLED', actor);
  if (updated?.customer_id) await ctx.customers.refreshTotals(updated.customer_id);
  if (cancelledOrder.delivery?.delivery_user_id) await notifyDeliveryOrderCancelled(ctx, updated ?? item, cancelledOrder, actor);
  return { ok: true, item: updated ?? item, order: cancelledOrder };
}

async function transitionOrderStatus(ctx, input) {
  return withOrderTransitionLock(input.orderId, async () => {
    const target = String(input.targetStatus ?? '').trim().toUpperCase();
    const reason = input.source === 'MANUAL_ADMIN' ? manualReason(input.reason) : longText(input.reason, 500);
    if (input.source === 'MANUAL_ADMIN' && !reason) {
      return { ok: false, status: 422, error: 'invalid_reason', message: 'Escribe un motivo claro de al menos 6 caracteres.' };
    }
    const item = await findOrderItem(ctx.store, input.orderId);
    if (!item) return { ok: false, status: 404, error: 'not_found' };
    const order = orderOf(item);
    if (!order) return { ok: false, status: 422, error: 'invalid_order' };
    const expected = text(input.expectedStatus, 30);
    if (expected && expected !== item.status && expected !== order.status && expected !== orderOperationalStatus(order, item)) {
      return {
        ok: false,
        status: 409,
        error: 'stale_order_status',
        message: 'El pedido cambió de estado. Actualiza e inténtalo nuevamente.',
        currentStatus: item.status,
      };
    }
    const activeSessions = await activeTrackingSessionsForOrder(ctx, item.id);
    const previousOperational = orderOperationalStatus(order, item, activeSessions);
    const previousStatus = item.status ?? order.status ?? 'nuevo';
    if (previousOperational === target) {
      return { ok: true, duplicate: true, item, order, integrity: await validateOrderOperationalIntegrity(ctx, item.id) };
    }
    if (isCompletedPurchaseStatus(previousStatus) && target !== 'ENTREGADO') {
      return {
        ok: false,
        status: 409,
        error: 'delivered_reversal_required',
        message: 'Una venta entregada no puede volver de estado con un cambio simple. Usa una reversión protegida.',
      };
    }

    let result = null;
    if (target === 'PENDIENTE') {
      if (activeSessions.length) {
        return { ok: false, status: 409, error: 'active_tracking_exists', message: 'No se puede volver a Pendiente con tracking activo.' };
      }
      const at = ctx.clock().toISOString();
      const pendingOrder = {
        ...order,
        status: 'nuevo',
        delivery: {
          ...(order.delivery ?? {}),
          delivery_status: order.delivery?.delivery_user_id ? DELIVERY_OPERATIONAL_STATUSES.READY_FOR_DELIVERY : DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT,
        },
        status_history: [...(order.status_history ?? []), { status: 'nuevo', at, reason, source: input.source ?? 'SYSTEM' }],
        updated_at: at,
      };
      const updated = await ctx.store.update(item.id, { status: 'nuevo', orderJson: JSON.stringify(pendingOrder) });
      result = { ok: true, item: updated, order: pendingOrder };
    } else if (target === 'EN_CAMINO') {
      if (!order.delivery?.delivery_user_id) {
        return { ok: false, status: 409, error: 'delivery_not_assigned', message: 'Asigna un delivery antes de marcar En camino.' };
      }
      if (!orderDestination(order)) {
        return { ok: false, status: 422, error: 'missing_destination', message: 'El pedido no tiene ubicación de entrega.' };
      }
      if (!activeSessions.length) {
        return { ok: false, status: 409, error: 'active_tracking_required', message: 'No se puede marcar En camino sin una entrega activa.' };
      }
      const at = ctx.clock().toISOString();
      const inTransitOrder = {
        ...order,
        status: 'enviado',
        delivery: { ...(order.delivery ?? {}), delivery_status: DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT },
        status_history: [...(order.status_history ?? []), { status: 'enviado', at, reason, source: input.source ?? 'SYSTEM' }],
        updated_at: at,
      };
      const updated = await ctx.store.update(item.id, { status: 'enviado', orderJson: JSON.stringify(inTransitOrder) });
      result = { ok: true, item: updated, order: inTransitOrder };
    } else if (target === 'ENTREGADO') {
      if (!isCompletedPurchaseStatus(item.status)) {
        const check = await ensureInventoryForSale(ctx, { ...item, status: BUSINESS_COMPLETED_PURCHASE_STATUS });
        if (!check.ok) return check;
      }
      result = await markOrderDelivered(ctx, item, input.actor, { reason, source: input.source ?? 'SYSTEM' });
    } else if (target === 'CANCELADO') {
      if (isCompletedPurchaseStatus(item.status)) {
        return {
          ok: false,
          status: 409,
          error: 'delivered_reversal_required',
          message: 'Una venta entregada no puede cancelarse con un cambio simple. Usa una reversión protegida.',
        };
      }
      result = await cancelOpenOrder(ctx, item, reason, input.actor, input.source ?? 'SYSTEM');
    } else {
      return { ok: false, status: 422, error: 'invalid_status', message: 'Estado no permitido.' };
    }

    const changedAt = ctx.clock().toISOString();
    await auditOrderStatusTransition(ctx, {
      orderId: item.id,
      previousStatus,
      newStatus: result.order?.status ?? result.item?.status,
      actor: input.actor,
      reason,
      changedAt,
      source: input.source ?? 'SYSTEM',
      idempotencyKey: `order.status:${item.id}:${previousStatus}:${target}:${input.source ?? 'SYSTEM'}:${changedAt}`,
    });
    return { ...result, integrity: await validateOrderOperationalIntegrity(ctx, item.id) };
  });
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
      await closeActiveTrackingForOrder(ctx, orderId, 'CANCELLED', actor);
      await notifyDeliveryOrderCancelled(ctx, updated, deliveryCancelledOrder, actor);
      return { ok: true, item: updated, order: deliveryCancelledOrder, inventory, inventoryLinesRestored };
    }
    await closeActiveTrackingForOrder(ctx, orderId, 'CANCELLED', actor);
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
 * FACTURA POR WHATSAPP.
 *
 * `INVOICE_TEMPLATE` es la plantilla que transporta el PDF cuando la ventana de
 * 24 h está cerrada (lleva CABECERA DE DOCUMENTO). El nombre del archivo se
 * construye SIEMPRE desde el número de pedido del CRM: nunca desde algo que
 * mande el navegador.
 */
const INVOICE_TEMPLATE = 'phyto_envio_factura_v1';

/** Nombre del PDF que recibe el cliente: `Factura-PE-00125.pdf`. */
function invoiceFilename(orderNumber) {
  const limpio = String(orderNumber ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return `Factura-${limpio || 'pedido'}.pdf`;
}

/** Texto corto que acompaña a la factura dentro de la ventana de 24 h. */
function invoiceCaption(customer) {
  const nombre = String(customer?.name ?? '').trim() || customer?.phone_e164 || 'cliente';
  return `Hola ${nombre}, te compartimos la factura de tu pedido.`;
}

/**
 * Plantillas oficiales de WhatsApp: nombres, categoría y variables.
 *
 * NINGUNA nace "aprobada": en Meta las aprueba una persona. Hasta que no estén
 * aprobadas, el panel no deja enviarlas. Así no se promete al cliente algo que
 * WhatsApp todavía no permite (y no se come el error 132001 de Meta).
 */
const WA_TEMPLATE_SEED = [
  {
    /*
     * CONTACTO PERSONALIZADO — la plantilla PRINCIPAL del CHAT DIRECTO.
     *
     * Es la que se usa cuando la ventana de 24 h ya está cerrada y hay que
     * volver a contactar al cliente. Estructura mínima y natural:
     *   {{1}} → nombre real del cliente (lo pone el CRM desde ESA conversación).
     *   {{2}} → hueco LIBRE: el mensaje que escribe el agente.
     *
     * Nada más: sin saludo por hora, sin «solicitud», sin teléfonos. El texto
     * fijo NO se toca nunca (Meta no lo permite); solo se rellenan sus variables.
     *
     * Nace `pending_approval` como todas: hasta que Meta la apruebe de verdad, el
     * panel no deja enviarla (nunca se finge una aprobación).
     */
    name: 'phyto_contacto_personalizado_v1',
    friendly_name: 'Contacto personalizado',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de Phytoemagry.\n\n{{2}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  },
  {
    /*
     * SEGUIMIENTO DE COMPRA — MENSAJE PROGRAMADO para quien YA compró.
     *   {{1}} nombre real · {{2}} mensaje de seguimiento (lo sugiere el CRM).
     */
    name: 'phyto_seguimiento_compra_v1',
    friendly_name: 'Seguimiento de compra',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de Phytoemagry para dar seguimiento a tu última compra.\n\n{{2}}\n\nCuéntanos cómo te ha ido. Si tienes alguna pregunta o deseas realizar otro pedido, estamos disponibles para ayudarte.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  },
  {
    /*
     * SEGUIMIENTO DE INTERÉS — MENSAJE PROGRAMADO para quien NO ha comprado.
     *   {{1}} nombre real · {{2}} mensaje de seguimiento (lo sugiere el CRM).
     */
    name: 'phyto_seguimiento_interes_v1',
    friendly_name: 'Seguimiento de interés',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te contactamos de Phytoemagry para dar seguimiento.\n\n{{2}}\n\nNos gustaría saber si todavía estás interesado/a o si necesitas más información. Si deseas hacer tu pedido, estamos disponibles para ayudarte.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  },
  {
    /*
     * ENVÍO DE FACTURA — la única forma de mandar la factura FUERA de la ventana
     * de 24 h.
     *
     * Lleva CABECERA DE DOCUMENTO: la plantilla transporta el PDF de verdad (no
     * un enlace), que es como el cliente lo ve como archivo descargable.
     *   {{1}} nombre real · {{2}} número de pedido.
     *
     * Categoría UTILITY porque es un mensaje transaccional de un pedido que YA
     * existe (no promoción). Aun así, Meta decide: si la rechaza o la cambia de
     * categoría, el CRM refleja lo que diga Meta y no la da por aprobada.
     */
    name: 'phyto_envio_factura_v1',
    friendly_name: 'Envío de factura',
    group: 'PEDIDOS',
    category: 'UTILITY',
    language: 'es',
    header: { format: 'DOCUMENT' },
    body: 'Hola {{1}}, te compartimos la factura correspondiente a tu pedido {{2}}.',
    variables: ['customer_name', 'order_number'],
    buttons: [],
  },
  {
    name: 'phyto_seguimiento_cliente_v1',
    friendly_name: 'Seguimiento al cliente',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de Phytoemagry para dar seguimiento a tu solicitud. Si deseas continuar, estamos disponibles para ayudarte.',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    name: 'phyto_confirmacion_pedido_v1',
    friendly_name: 'Confirmación de pedido',
    group: 'PEDIDOS',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, recibimos tu pedido {{2}} correctamente.\n\nTotal: {{3}}\nForma de pago: {{4}}\n\nPor favor confirma que los datos de tu pedido son correctos.',
    variables: ['customer_name', 'order_number', 'total', 'payment_method'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: 'phyto_delivery_asignado_v1',
    friendly_name: 'Delivery asignado',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, tu pedido {{2}} ya tiene delivery asignado.\n\n*{{3}} · Delivery* será la persona encargada de coordinar tu entrega.',
    variables: ['customer_name', 'order_number', 'delivery_display_name'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: 'phyto_ubicacion_entrega_v1',
    friendly_name: 'Solicitar ubicación',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, necesitamos confirmar la ubicación donde deseas recibir tu pedido {{2}}.',
    variables: ['customer_name', 'order_number'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: 'phyto_pedido_listo_v1',
    friendly_name: 'Pedido listo',
    group: 'PEDIDOS',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, tu pedido {{2}} está listo para coordinar la entrega.',
    variables: ['customer_name', 'order_number'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: DELIVERY_DELIVERED_TEMPLATE,
    friendly_name: 'Pedido entregado',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, hemos registrado tu pedido {{2}} como entregado. Gracias por elegir Phytoemagry.',
    variables: ['customer_name', 'order_number'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: DELIVERY_REMINDER_TEMPLATE,
    friendly_name: 'Recordatorio delivery pedido pendiente',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, recuerda que tienes un pedido pendiente por atender.\n\nPedido: {{2}}\n\nPor favor contacta al cliente y coordina la entrega lo antes posible.\n\n{{3}}',
    variables: ['delivery_display_name', 'order_number', 'delivery_deep_link'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: DELIVERY_ADMIN_ESCALATION_TEMPLATE,
    friendly_name: 'Delivery sin atender admin',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'URGENTE: el pedido {{1}} fue asignado al delivery {{2}} hace aproximadamente 30 minutos y todavía no ha contactado al cliente.\n\nSe requiere intervención administrativa.\n\n{{3}}',
    variables: ['order_number', 'delivery_display_name', 'delivery_deep_link'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: DELIVERY_ADMIN_DELIVERED_TEMPLATE,
    friendly_name: 'Entrega completada admin',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Pedido {{1}} entregado correctamente.\n\nDelivery: {{2}}\nCliente: {{3}}\nHora: {{4}}\n\n{{5}}',
    variables: ['order_number', 'delivery_display_name', 'customer_name', 'delivered_at', 'delivery_deep_link'],
    buttons: [],
    required_context: 'order',
  },
  {
    name: 'phyto_recompra_cliente_v1',
    friendly_name: 'Recompra',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, esperamos que todo vaya bien con tu compra anterior de Phytoemagry.',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    name: 'phyto_retomar_pedido_v1',
    friendly_name: 'Retomar pedido',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, queremos confirmar si deseas continuar con el pedido que dejaste pendiente.',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    name: 'phyto_purchase_thanks',
    friendly_name: 'Gracias por compra',
    group: 'LEGACY',
    category: 'UTILITY',
    language: 'es',
    body: 'Gracias por tu compra. Si tienes alguna duda sobre cómo usarlo, respóndenos por aquí.',
    variables: [],
    buttons: [],
  },
  {
    name: 'phyto_followup_checkin',
    friendly_name: 'Seguimiento legacy',
    group: 'LEGACY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, ¿cómo te ha ido con tu pedido? Si necesitas algo, escríbenos por aquí.',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    name: 'phyto_weekly_education',
    friendly_name: 'Educación semanal legacy',
    group: 'LEGACY',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te compartimos información aprobada sobre el producto y su forma de uso.',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    name: 'phyto_reorder_reminder',
    friendly_name: 'Recordatorio recompra legacy',
    group: 'LEGACY',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, por si te sirve: se acerca el final de tu frasco. ¿Te ayudamos con el siguiente?',
    variables: ['customer_name'],
    buttons: [],
  },
  {
    /*
     * Plantilla con un hueco LIBRE (`{{2}}`): es la única forma de escribir un
     * mensaje propio fuera de la ventana de 24 h, porque WhatsApp solo admite
     * plantillas aprobadas. Ese hueco se redacta desde el panel.
     */
    name: 'phyto_mensaje_personalizado_v1',
    friendly_name: 'Mensaje personalizado',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de Phytoemagry. {{2}} Cualquier duda, respóndenos por aquí y te ayudamos.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  },
];

const WA_TEMPLATE_STALE_MS = 10 * 60 * 1000;

function normalizeTemplateStatus(value) {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'PENDING' || normalized === 'PENDING_APPROVAL' || normalized === 'IN_REVIEW') return 'PENDING';
  if (normalized === 'APPROVED' || normalized === 'ACTIVE') return 'APPROVED';
  if (normalized === 'REJECTED') return 'REJECTED';
  if (normalized === 'PAUSED') return 'PAUSED';
  if (normalized === 'DISABLED') return 'DISABLED';
  if (normalized === 'LOCAL_ONLY') return 'LOCAL_ONLY';
  if (normalized === 'NOT_FOUND_IN_META') return 'NOT_FOUND_IN_META';
  return normalized;
}

function templateSendable(status) {
  return normalizeTemplateStatus(status) === 'APPROVED';
}

function templateBodyFromComponents(components = []) {
  return components.find((component) => String(component?.type ?? '').toUpperCase() === 'BODY')?.text ?? null;
}

/**
 * CABECERA de una plantilla, tal como la describe Meta.
 *
 * Se lee del componente real (`IMAGE`, `DOCUMENT`, `TEXT`…). Es lo que permite
 * saber si una plantilla puede transportar un archivo: dar por hecho que lleva
 * cabecera de documento cuando no la tiene es el error 132012 de WhatsApp.
 */
function templateHeaderFromComponents(components = []) {
  const header = components.find((component) => String(component?.type ?? '').toUpperCase() === 'HEADER');
  if (!header) return null;
  const format = String(header.format ?? '').toUpperCase() || null;
  if (!format) return null;
  return { format, text: header.text ?? null };
}

function templateButtonsFromComponents(components = []) {
  const buttons = components.find((component) => String(component?.type ?? '').toUpperCase() === 'BUTTONS')?.buttons;
  return Array.isArray(buttons) ? buttons : [];
}

/**
 * Plantillas del plan + las guardadas en la base de datos, sin duplicar nombres.
 * Las nuevas se registran como `pending_approval` (la verdad de Meta manda).
 */
async function listWaTemplates(ctx, options = {}) {
  if (options.syncIfStale) await syncWaTemplatesIfStale(ctx);
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
      friendly_name: seed.friendly_name ?? seed.name,
      group: seed.group ?? 'LEGACY',
      category: seed.category,
      language: seed.language,
      body: seed.body,
      variables: seed.variables,
      buttons: seed.buttons ?? [],
      // Cabecera (TEXT/IMAGE/DOCUMENT…). Importa para saber qué transporte lleva.
      header: seed.header ?? null,
      required_context: seed.required_context ?? 'none',
      status: 'pending_approval',
      sendable: false,
      // Datos que solo puede rellenar Meta cuando la plantilla se registre allí.
      meta_template_id: seed.meta_template_id ?? null,
      last_synced_at: null,
      last_template_sync_at: null,
      components: [],
      quality_score: null,
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
  if (!templateSendable(found.status) || found.sendable !== true) return { ok: false, reason: 'template_not_approved', template: found };
  return { ok: true, template: found };
}

/**
 * HUECO LIBRE (`mensaje`, `texto`, …): el parámetro donde el negocio escribe su
 * propio texto. Es la ÚNICA forma de mandar un mensaje redactado fuera de la
 * ventana de 24 h, porque WhatsApp solo admite plantillas aprobadas.
 */
const TEMPLATE_FREE_TEXT_KEYS = Object.freeze(['mensaje', 'texto', 'mensaje_libre', 'libre', 'personalizado']);

/**
 * Enlace público del punto.
 *
 * Un enlace se abre en CUALQUIER teléfono: sirve para compartir una ubicación
 * dentro de una plantilla (fuera de la ventana no se puede mandar la ubicación
 * nativa de WhatsApp). Nunca inventa coordenadas: sin lat/lng devuelve `null`.
 */
function locationMapsLink(location) {
  const lat = Number(location?.latitude);
  const lng = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

/**
 * La plantilla APROBADA que tiene hueco libre (si la hay).
 *
 * Se elige por lo que DECLARA, no por la posición del hueco: si el negocio
 * reordena los parámetros en Meta, esto sigue funcionando.
 */
async function freeTextTemplate(ctx) {
  const templates = await listWaTemplates(ctx, { syncIfStale: true });
  return (
    templates.find(
      (row) =>
        templateSendable(row.status) &&
        row.sendable === true &&
        (row.variables ?? []).some((key) => TEMPLATE_FREE_TEXT_KEYS.includes(String(key).toLowerCase())),
    ) ?? null
  );
}

/**
 * Refresca UNA plantilla desde Meta si su copia local está vieja.
 *
 * Solo actúa sobre plantillas que vienen de Meta (`source: 'meta'` o con
 * `meta_template_id`): las registradas a mano en el CRM no se tocan. Si Meta no
 * responde (o la plantilla ya no está allí) se sigue con la copia local, para no
 * bloquear un envío legítimo por un fallo puntual de la Graph API.
 *
 * @param {any} ctx
 * @param {string|null} name
 */
async function refreshTemplateFromMeta(ctx, name) {
  if (!ctx.whatsapp?.listTemplates || !name) return null;
  const local = (await ctx.db.findBy('wa_templates', 'name', name)) ?? null;
  if (!local) return null;
  if (local.source !== 'meta' && !local.meta_template_id) return null;
  const syncedAt = Date.parse(local.last_template_sync_at ?? local.last_synced_at ?? '');
  if (syncedAt && Date.now() - syncedAt < WA_TEMPLATE_STALE_MS) return local;
  const metaResult = await ctx.whatsapp.listTemplates().catch(() => null);
  if (!metaResult?.ok) return local;
  const meta = (metaResult.templates ?? []).find((row) => String(row?.name ?? '') === name);
  if (!meta) return local;
  const components = Array.isArray(meta.components) ? meta.components : [];
  const status = normalizeTemplateStatus(meta.status);
  const now = new Date().toISOString();
  const patch = {
    body: templateBodyFromComponents(components) ?? local.body ?? null,
    buttons: templateButtonsFromComponents(components),
    components,
    language: text(meta.language, 20) ?? local.language ?? 'es',
    category: text(meta.category, 30) ?? local.category ?? 'UTILITY',
    status,
    sendable: templateSendable(status),
    meta_template_id: text(meta.id, 80) ?? local.meta_template_id ?? null,
    quality_score: meta.quality_score ?? local.quality_score ?? null,
    last_synced_at: now,
    last_template_sync_at: now,
    source: 'meta',
    updated_at: now,
  };
  return (await ctx.db.update('wa_templates', local.id, patch)) ?? { ...local, ...patch };
}

function templatePlaceholderCount(body) {
  const matches = String(body ?? '').match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
}

/**
 * Nombres de los parámetros, ALINEADOS con los marcadores REALES del cuerpo.
 *
 * Manda el cuerpo que hay en Meta (`Hola {{1}}…`): la lista de `variables` solo
 * aporta la etiqueta de cada hueco. Antes, una lista de nombres vieja decidía
 * CUÁNTOS parámetros se mandaban; si el negocio editaba la plantilla en Meta y
 * la copia local se quedaba atrás, se enviaba otro número y WhatsApp lo
 * rechazaba con «132000 Number of parameters does not match…».
 */
function templateVariables(template) {
  const declared = Array.isArray(template?.variables)
    ? template.variables.map((entry) => String(entry ?? '').trim())
    : [];
  const count = templatePlaceholderCount(template?.body);
  if (!count) return [];
  return Array.from({ length: count }, (_, index) => declared[index] || `param_${index + 1}`);
}

function renderTemplateBody(body, parameters) {
  let rendered = String(body ?? '');
  parameters.forEach((parameter, index) => {
    rendered = rendered.replace(new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, 'g'), parameter.text);
  });
  return rendered || null;
}

/**
 * PREFERENCIAS DE PEDIDO de un cliente.
 *
 * Es lo que pidió el negocio: guardar aparte lo que se repite en CADA pedido
 * (frasco, cantidad, forma de pago, ubicación de entrega y una nota de
 * preferencia) para que la próxima vez solo haya que confirmar la cantidad.
 * No envía nada, no toca precios y no inventa: lo que no viene, no se guarda.
 *
 * @param {unknown} value
 * @param {Array<{id: string}>} [customerLocations] ubicaciones REALES del cliente
 * @returns {object|null|undefined} limpio · `null` para BORRAR · `undefined` = no vale (422)
 */
function normalizeOrderPrefs(value, customerLocations = []) {
  if (value === null || value === '') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const variantId = text(value.variantId ?? value.variant_id, 60);
  // El frasco tiene que existir en el catálogo: nada de ids inventados.
  if (variantId && !findCatalogItem(variantId)) return undefined;

  const cruda = value.quantity ?? value.cantidad;
  const quantity =
    cruda === undefined || cruda === null || cruda === '' ? null : Math.trunc(Number(cruda));
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 1 || quantity > 500)) return undefined;

  const paymentMethod = text(value.paymentMethod ?? value.payment_method, 20)?.toUpperCase() ?? null;
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) return undefined;

  const locationId = text(value.locationId ?? value.location_id, 80);
  // La ubicación de entrega tiene que ser una que el CRM ya tenga de ese cliente.
  if (locationId && !customerLocations.some((row) => row.id === locationId)) return undefined;

  const note = longText(value.note ?? value.nota, 300);
  const limpio = {
    variant_id: variantId ?? null,
    quantity: quantity ?? null,
    payment_method: paymentMethod ?? null,
    location_id: locationId ?? null,
    note: note ?? null,
    updated_at: new Date().toISOString(),
  };
  const vacio =
    !limpio.variant_id && !limpio.quantity && !limpio.payment_method && !limpio.location_id && !limpio.note;
  // Sin nada dentro no son preferencias: se borran (null), no se guarda un hueco.
  return vacio ? null : limpio;
}

/**
 * Texto que va DENTRO de una variable de plantilla.
 *
 * Meta no admite saltos de línea, tabuladores ni espacios repetidos dentro de una
 * variable: si el operador escribe un mensaje de varias líneas, WhatsApp rechaza
 * el envío. Se aplana a UNA línea antes de mandarlo (y se recorta al límite).
 */
function sanitizeTemplateParameter(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

/**
 * Foto del cliente.
 *
 * WhatsApp NO entrega la foto de perfil de los contactos por su API: el webhook
 * de mensajes solo trae `contacts[].profile.name`, `/{phone-number-id}/contacts`
 * no existe y el wa_id del cliente no es un nodo de Graph (las tres cosas están
 * comprobadas contra la Graph API). Así que la foto la pone el equipo desde el
 * panel y vive con el cliente: aparece en la lista, en la cabecera del chat y en
 * su ficha. Se acepta una imagen pequeña en `data:` (el panel la reduce a 192 px
 * antes de mandarla) o una dirección https.
 *
 * @returns {string|null|undefined} lista para guardar · `null` para BORRARLA ·
 *   `undefined` si lo recibido no vale (el llamador responde 422).
 */
const CUSTOMER_PHOTO_LIMIT = 140000;
/** La foto viaja en el cuerpo del PATCH: esa ruta admite más que el resto. */
const CUSTOMER_PHOTO_BODY_BYTES = 256 * 1024;
function normalizeCustomerPhoto(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > CUSTOMER_PHOTO_LIMIT) return undefined;
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)) return raw;
  if (raw.length <= 600 && /^https:\/\/[^\s"'<>]+$/.test(raw)) return raw;
  return undefined;
}

function orderTotalText(order, item) {
  const total = order?.total ?? item?.total ?? null;
  if (total === null || total === undefined || total === '') return null;
  const currency = order?.currency ?? item?.currency ?? 'DOP';
  return `${total} ${currency}`;
}

async function findTemplateOrderContext(ctx, { customer, conversation, orderId }) {
  const items = await ctx.store.listAdmin({ limit: 5000 });
  const candidates = items
    .filter((item) => item.type === 'order_intent')
    .map((item) => ({ item, order: orderOf(item) }))
    .filter(({ item, order }) => {
      if (!order) return false;
      if (orderId) return item.id === orderId || order.id === orderId || order.order_number === orderId;
      if (conversation?.id && (order.conversation_id === conversation.id || item.conversation_id === conversation.id)) return true;
      return customer?.id && (order.customer_id === customer.id || item.customer_id === customer.id);
    });
  return (
    candidates.sort((a, b) => {
      const bDate = String(b.order.updated_at ?? b.order.created_at ?? b.item.received_at ?? '');
      const aDate = String(a.order.updated_at ?? a.order.created_at ?? a.item.received_at ?? '');
      return bDate.localeCompare(aDate);
    })[0] ?? null
  );
}

async function resolveTemplatePayload(ctx, { template, customer, conversation, orderId, provided = null }) {
  // Sin el texto real de Meta no se sabe cuántos (ni cuáles) parámetros espera:
  // mandar una suposición es exactamente el error 132000 de WhatsApp.
  if (!String(template?.body ?? '').trim()) {
    return {
      ok: false,
      status: 422,
      error: 'template_body_missing',
      message:
        'No tenemos el texto de esta plantilla tal como está en Meta. Pulsa «Sincronizar con Meta» y vuelve a intentarlo.',
    };
  }
  const variables = templateVariables(template);
  const placeholderCount = templatePlaceholderCount(template?.body);
  /** ¿Lo escribió la persona en el panel? (manda sobre lo automático) */
  const escrito = (index) => {
    const value = provided?.[String(index + 1)] ?? provided?.[index + 1] ?? null;
    return value !== null && value !== undefined && String(value).trim() !== '';
  };
  // Con TODOS los huecos escritos a mano no hay que buscar ningún pedido.
  const todoEscrito = variables.length > 0 && variables.every((_, index) => escrito(index));
  const requiresOrder =
    !todoEscrito &&
    (template?.required_context === 'order' || variables.some((key) => ['order_number', 'total', 'payment_method', 'delivery_display_name'].includes(key)));
  const context = requiresOrder ? await findTemplateOrderContext(ctx, { customer, conversation, orderId }) : null;
  if (requiresOrder && !context) {
    return { ok: false, status: 422, error: 'missing_order', message: 'Falta seleccionar un pedido para completar esta plantilla.' };
  }
  const { item = null, order = null } = context ?? {};
  const deliveryName =
    order?.delivery?.delivery_user_name_snapshot ??
    order?.delivery?.delivery_assigned_by_display_name_snapshot ??
    item?.delivery_display_name ??
    null;
  const values = {
    customer_name: customer?.name || customer?.phone_e164 || 'cliente',
    nombre: customer?.name || customer?.phone_e164 || 'cliente',
    order_number: order?.order_number ?? item?.order_number ?? item?.id ?? null,
    total: orderTotalText(order, item),
    payment_method: order?.payment_method_label ?? paymentMethodLabel(order?.payment_method ?? item?.payment_method) ?? null,
    delivery_display_name: deliveryName,
    delivery_deep_link: orderDeliveryDeepLink(item?.id ?? order?.id ?? ''),
    delivered_at: order?.delivered_at ? new Date(order.delivered_at).toLocaleString('es-DO') : null,
  };
  if (variables.includes('delivery_display_name') && !values.delivery_display_name && !escrito(variables.indexOf('delivery_display_name'))) {
    return { ok: false, status: 422, error: 'missing_delivery', message: 'Este pedido no tiene delivery asignado para completar esta plantilla.' };
  }
  const missing = [];
  const parameters = variables.map((key, index) => {
    /*
     * Lo que ESCRIBIÓ la persona manda sobre lo automático: es la única forma de
     * poner un mensaje propio fuera de la ventana de 24 h (WhatsApp solo deja
     * texto libre dentro de una plantilla aprobada, en sus huecos). Los huecos sin
     * escribir se rellenan como siempre (nombre del cliente, datos del pedido).
     */
    const written = provided?.[String(index + 1)] ?? provided?.[index + 1] ?? null;
    if (written !== null && written !== undefined && String(written).trim() !== '') {
      return { type: 'text', text: sanitizeTemplateParameter(written) };
    }
    const value = values[key] ?? (key.startsWith('param_') && index === 0 ? values.customer_name : null);
    if (value === null || value === undefined || value === '') missing.push(key);
    return { type: 'text', text: String(value ?? '') };
  });
  if (missing.length) {
    return { ok: false, status: 422, error: 'missing_template_data', message: 'Faltan datos para completar la plantilla.', missing };
  }
  if (parameters.length !== placeholderCount) {
    return {
      ok: false,
      status: 422,
      error: 'template_parameter_mismatch',
      message: `La plantilla espera ${placeholderCount} parámetro(s), pero el CRM tiene ${parameters.length}. Sincroniza la plantilla con Meta.`,
    };
  }
  return {
    ok: true,
    body: renderTemplateBody(template?.body, parameters),
    components: parameters.length ? [{ type: 'body', parameters }] : [],
  };
}

async function syncWaTemplatesIfStale(ctx) {
  if (!ctx.whatsapp?.listTemplates) return null;
  const templates = await ctx.db.list('wa_templates', { limit: 200 });
  const newest = templates
    .map((row) => Date.parse(row.last_template_sync_at ?? row.last_synced_at ?? ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (newest && Date.now() - newest < WA_TEMPLATE_STALE_MS) return null;
  return syncWhatsAppTemplatesFromMeta(ctx);
}

export async function syncWhatsAppTemplatesFromMeta(ctx) {
  if (!ctx.whatsapp?.listTemplates) {
    return { ok: false, error: 'whatsapp_not_configured', message: 'WhatsApp no está configurado para consultar Meta.' };
  }
  await listWaTemplates(ctx, { syncIfStale: false });
  const metaResult = await ctx.whatsapp.listTemplates();
  if (!metaResult.ok) {
    console.error('[crm] Meta templates sync falló:', {
      status: metaResult.status ?? metaResult.error?.status ?? null,
      code: metaResult.error?.code ?? null,
      type: metaResult.error?.type ?? null,
      message: metaResult.error?.message ?? metaResult.reason ?? 'error',
    });
    return { ok: false, error: 'meta_sync_failed', detail: metaResult.error ?? { reason: metaResult.reason ?? 'error' } };
  }
  const now = new Date().toISOString();
  const local = await ctx.db.list('wa_templates', { limit: 500 });
  const byMetaId = new Map(local.filter((row) => row.meta_template_id).map((row) => [String(row.meta_template_id), row]));
  const byNameLanguage = new Map(local.map((row) => [`${row.name}:${row.language ?? ''}`, row]));
  const seenIds = new Set();
  const seenNames = new Set();
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  let updated = 0;
  /** @type {any[]} */
  const synced = [];
  for (const meta of metaResult.templates ?? []) {
    const name = text(meta.name, 80);
    if (!name) continue;
    const language = text(meta.language, 20) ?? 'es';
    const seed = WA_TEMPLATE_SEED.find((row) => row.name === name) ?? null;
    const status = normalizeTemplateStatus(meta.status);
    const sendable = templateSendable(status);
    if (status === 'APPROVED') approved += 1;
    else if (status === 'REJECTED') rejected += 1;
    else pending += 1;
    const components = Array.isArray(meta.components) ? meta.components : [];
    const existing = byMetaId.get(String(meta.id ?? '')) ?? byNameLanguage.get(`${name}:${language}`) ?? byNameLanguage.get(`${name}:`) ?? null;
    const doc = {
      id: existing?.id ?? `tpl_${name}`,
      name,
      friendly_name: existing?.friendly_name ?? seed?.friendly_name ?? name,
      group: existing?.group ?? seed?.group ?? 'OTRAS',
      category: text(meta.category, 30) ?? existing?.category ?? seed?.category ?? 'UTILITY',
      language,
      body: templateBodyFromComponents(components) ?? existing?.body ?? seed?.body ?? null,
      variables: Array.isArray(existing?.variables) && existing.variables.length ? existing.variables : seed?.variables ?? [],
      buttons: templateButtonsFromComponents(components),
      /*
       * La cabecera la manda Meta. Si Meta devolvió sus componentes y ninguno es
       * una cabecera, entonces NO tiene: quedarse con la de la semilla sería
       * creer que la plantilla transporta un archivo que Meta no espera.
       */
      header: components.length ? templateHeaderFromComponents(components) : existing?.header ?? seed?.header ?? null,
      components,
      required_context: existing?.required_context ?? seed?.required_context ?? 'none',
      status,
      sendable,
      meta_template_id: text(meta.id, 80) ?? existing?.meta_template_id ?? null,
      quality_score: meta.quality_score ?? null,
      last_synced_at: now,
      last_template_sync_at: now,
      source: 'meta',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) await ctx.db.update('wa_templates', existing.id, doc);
    else await ctx.db.insert('wa_templates', doc);
    if (doc.meta_template_id) seenIds.add(String(doc.meta_template_id));
    seenNames.add(doc.name);
    updated += 1;
    synced.push(doc);
  }
  for (const row of local) {
    const wasSeen = (row.meta_template_id && seenIds.has(String(row.meta_template_id))) || seenNames.has(row.name);
    if (wasSeen) continue;
    await ctx.db.update('wa_templates', row.id, {
      ...row,
      status: row.source === 'meta' ? 'not_found_in_meta' : 'pending_approval',
      sendable: false,
      last_template_sync_at: now,
      updated_at: now,
    });
  }
  return {
    ok: true,
    foundFromMeta: synced.length,
    found: synced.length,
    approved,
    pending,
    rejected,
    updated,
    requestId: metaResult.requestId ?? null,
    templates: synced,
    syncedAt: now,
  };
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

function androidApkInfo(ctx) {
  const configuredUrl = String(ctx.androidApk?.url ?? '').trim();
  const filePath = path.resolve(String(ctx.androidApk?.path ?? ANDROID_APK_PATH));
  const hasRemoteUrl = /^https?:\/\//i.test(configuredUrl);
  const exists = existsSync(filePath) && statSync(filePath).isFile();
  return {
    available: hasRemoteUrl || exists,
    source: hasRemoteUrl ? 'storage' : exists ? 'local' : 'missing',
    url: hasRemoteUrl ? configuredUrl : '/api/admin/android-apk/download',
    filename: 'phytoemagry-android.apk',
    path: filePath,
    sizeBytes: exists ? statSync(filePath).size : null,
  };
}

function serveAndroidApk(req, res, ctx) {
  const info = androidApkInfo(ctx);
  if (/^https?:\/\//i.test(info.url)) {
    res.writeHead(302, { location: info.url, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (!info.available || !existsSync(info.path)) {
    json(res, 404, {
      ok: false,
      error: 'apk_not_found',
      message: 'El APK Android todavía no está publicado en el servidor.',
    });
    return;
  }
  const size = statSync(info.path).size;
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-length': size,
    'content-disposition': `attachment; filename="${info.filename}"`,
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(info.path).pipe(res);
}

async function deleteConversationFromCrm(ctx, conversation, actor) {
  const messages = await ctx.db.list('wa_messages', { limit: 5000 });
  let deletedMessages = 0;
  for (const message of messages.filter((row) => row.conversation_id === conversation.id)) {
    if (await ctx.db.remove('wa_messages', message.id)) deletedMessages += 1;
  }
  const deletedConversation = await ctx.db.remove('conversations', conversation.id);
  await ctx.audit?.record({
    entity: 'conversation',
    entityId: conversation.id,
    action: 'conversation.deleted',
    actor: actor?.display_name ?? null,
    summary: `Conversación eliminada (${deletedMessages} mensaje(s))`,
    data: { customer_id: conversation.customer_id, messages_deleted: deletedMessages },
  });
  return { deletedConversation, deletedMessages };
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

    if (route === '/api/admin/android-apk/status' && req.method === 'GET') {
      const info = androidApkInfo(ctx);
      json(res, 200, {
        ok: true,
        available: info.available,
        source: info.source,
        url: info.url,
        filename: info.filename,
        sizeBytes: info.sizeBytes,
      });
      return;
    }

    if (route === '/api/admin/android-apk/download' && ['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      serveAndroidApk(req, res, ctx);
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
        personalPhone: body.personalPhone ?? body.personal_phone,
        fleetPhone: body.fleetPhone ?? body.fleet_phone,
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
              : `La contraseña nueva necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
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

    if (route.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      if (!requireAdmin()) return;
      const userId = decodeURIComponent(route.slice('/api/admin/users/'.length));
      const result = await ctx.users.deleteUser(userId, actor);
      if (!result.ok) {
        json(res, result.error === 'not_found' ? 404 : 409, {
          ok: false,
          error: result.error,
          message:
            result.error === 'self_delete'
              ? 'No puedes eliminar tu propio usuario desde la sesión actual.'
              : result.error === 'last_admin'
                ? 'Debe quedar al menos un administrador activo.'
                : 'No se pudo eliminar el usuario.',
        });
        return;
      }
      json(res, 200, { ok: true, deleted: result.deleted, user: result.user });
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
      const deliveryScope = await deliveryAccessScope(ctx, actor);
      const rawItems = await store.listAdmin({ limit: 500 });
      const items = rawItems
        .filter((item) => !deliveryScope.restricted || (item.type === 'order_intent' && deliveryScope.orderIds.has(item.id)))
        .map((item) => sanitizeItemForPermissions(item, actor));
      const messages = deliveryScope.restricted ? [] : await store.messages().list();
      const fullCustomerList = await ctx.customers.list({});
      const customerList = deliveryScope.restricted
        ? fullCustomerList.filter((customer) => deliveryScope.customerIds.has(customer.id))
        : fullCustomerList;
      const fullConversationList = await ctx.customers.listConversations({});
      const conversationList = deliveryScope.restricted
        ? fullConversationList.filter((conversation) => deliveryScope.conversationIds.has(conversation.id))
        : fullConversationList;
      const conversationCounts = await ctx.customers.conversationCounts();
      await ctx.customers.ensureInitialTags();
      const buckets = deliveryScope.restricted
        ? { reference: new Date().toISOString(), today: [], overdue: [], upcoming: [], completed: [] }
        : await ctx.followups.buckets();
      const outbound = await ctx.db.list('wa_messages', { limit: 500 });
      const failed = deliveryScope.restricted ? [] : outbound.filter((row) => row.status === 'failed');
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
        customerTags: deliveryScope.restricted ? [] : await ctx.customers.listTags(),
        deliveryTracking: await listVisibleTracking(ctx, actor),
        deliveryOrders: await visibleDeliveryOrders(ctx, actor),
        deliveryUsers: can('delivery.tracking.manage_all')
          ? (await ctx.users.listUsers()).filter((user) => canDeliver(user) && user.active !== false)
          : [],
        // La regla de la contraseña vive en el servidor: el panel solo la enseña.
        minPasswordLength: MIN_PASSWORD_LENGTH,
        notifications: await listUserNotifications(ctx, actor),
        push: await pushStatusForUser(ctx, await pushOwnerUserId(ctx, actor)),
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
          humanoRequerido: deliveryScope.restricted ? 0 : conversationList.filter((row) => row.status === 'HUMAN_REQUIRED').length,
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

    if (route === '/api/admin/inventory/reconcile' && req.method === 'GET') {
      if (!requireAdmin()) return;
      json(res, 200, { ok: true, reconciliation: await ctx.inventory.reconcileInventory() });
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

    if (route === '/api/admin/inventory/count' && req.method === 'POST') {
      if (!requireAdmin()) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await ctx.inventory.countStock({
        countedQuantity: body.countedQuantity ?? body.quantity,
        reason: longText(body.reason ?? 'Recuento físico', 300),
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
      const legacyDeliveryRollback =
        before?.type === 'order_intent' &&
        isDeliveryOnly(actor) &&
        body.deliveryRollback === true &&
        body.status === 'nuevo' &&
        before.status === 'enviado' &&
        orderOf(before)?.delivery?.delivery_user_id === actor?.id &&
        body.notes === undefined &&
        body.nextActionAt === undefined &&
        body.source === undefined &&
        body.saleSource === undefined &&
        body.orderSource === undefined;
      if (!hasPermission(actor, 'orders.update_operational') && !legacyDeliveryRollback) {
        forbid();
        return;
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
      if (
        before?.type === 'order_intent' &&
        patch.status &&
        before.status !== patch.status &&
        !legacyDeliveryRollback &&
        !hasPermission(actor, 'orders.change_status')
      ) {
        json(res, 403, {
          ok: false,
          error: 'protected_order_status',
          message: 'El estado de un pedido se cambia desde el flujo protegido correspondiente.',
        });
        return;
      }
      if (before?.type === 'order_intent' && patch.status === 'cancelado' && before.status !== 'cancelado') {
        const result = await transitionOrderStatus(ctx, {
          orderId: id,
          targetStatus: 'CANCELADO',
          expectedStatus: before.status,
          reason: patch.reason ?? 'Cambio de estado legacy',
          actor,
          source: 'SYSTEM',
        });
        if (!result.ok) {
          json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
          return;
        }
        json(res, 200, { ok: true, item: sanitizeItemForPermissions(result.item, actor), order: sanitizeOrderForPermissions(result.order, actor) });
        return;
      }
      if (
        before?.type === 'order_intent' &&
        patch.status &&
        before.status !== patch.status &&
        ['nuevo', 'enviado', 'entregado'].includes(String(patch.status))
      ) {
        const result = await transitionOrderStatus(ctx, {
          orderId: id,
          targetStatus: patch.status === 'entregado' ? 'ENTREGADO' : patch.status === 'enviado' ? 'EN_CAMINO' : 'PENDIENTE',
          expectedStatus: before.status,
          reason: patch.reason ?? 'Cambio de estado legacy',
          actor,
          source: 'SYSTEM',
        });
        if (!result.ok) {
          json(res, result.status ?? 422, {
            ok: false,
            error: result.error,
            message: result.message,
            available: result.available,
            required: result.required,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          item: sanitizeItemForPermissions(result.item, actor),
          order: sanitizeOrderForPermissions(result.order, actor),
          delivered: hasPermission(actor, 'cost.view') ? result.delivered : stripSensitiveFinancials(result.delivered),
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
          await closeActiveTrackingForOrder(ctx, updated.id, 'COMPLETED', actor);
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
      if (!requirePermission('clients.read')) return;
      const deliveryScope = await deliveryAccessScope(ctx, actor);
      const customers = (await ctx.customers.list({ q: url.searchParams.get('q') ?? '' })).filter(
        (customer) => !deliveryScope.restricted || deliveryScope.customerIds.has(customer.id),
      );
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
        const [items, conversations, followups, scheduled, locations, tagAssignments, stageHistory] = await Promise.all([
          store.listAdmin({ limit: 5000 }),
          ctx.db.list('conversations', { limit: 5000 }),
          ctx.db.list('followups', { limit: 5000 }),
          ctx.scheduler.list(),
          ctx.db.list('locations', { limit: 5000 }),
          ctx.db.list('customer_tag_assignments', { limit: 5000 }),
          ctx.db.list('customer_stage_history', { limit: 5000 }),
        ]);
        const blockers = {
          orders: items.filter((item) => item.customer_id === customerId).length,
          conversations: conversations.filter((row) => row.customer_id === customerId).length,
          followups: followups.filter((row) => row.customer_id === customerId).length,
          scheduled: scheduled.filter((row) => row.customer_id === customerId).length,
          locations: locations.filter((row) => row.customer_id === customerId).length,
        };
        const totalBlockers = Object.values(blockers).reduce((sum, value) => sum + value, 0);
        if (totalBlockers > 0) {
          json(res, 409, {
            ok: false,
            error: 'customer_has_history',
            message:
              'Este cliente tiene historial vinculado. Para conservar trazabilidad no se elimina: puedes marcarlo como inactivo o No contactar.',
            blockers,
          });
          return;
        }
        for (const row of tagAssignments.filter((entry) => entry.customer_id === customerId)) {
          await ctx.db.remove('customer_tag_assignments', row.id);
        }
        for (const row of stageHistory.filter((entry) => entry.customer_id === customerId)) {
          await ctx.db.remove('customer_stage_history', row.id);
        }
        const deleted = await ctx.db.remove('customers', customerId);
        await ctx.audit?.record({
          entity: 'customer',
          entityId: customerId,
          action: 'customer.deleted',
          actor: actor?.display_name ?? null,
          summary: `Cliente eliminado: ${customer.name ?? customer.phone_e164 ?? customerId}`,
          data: { customer_id: customerId, phone_e164: customer.phone_e164 ?? null },
        });
        json(res, 200, { ok: true, deleted });
        return;
      }

      // Perfil 360: compras, chat, seguimiento, consentimiento y ventana de 24 h.
      if (!action && req.method === 'GET') {
        if (!(await canWorkWithCustomer(ctx, actor, customerId))) {
          forbid();
          return;
        }
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
        if (!(await canWorkWithCustomer(ctx, actor, customerId))) {
          forbid();
          return;
        }
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
          // La foto del cliente puede ocupar bastante más que un pedido normal.
          body = await readJsonBody(req, CUSTOMER_PHOTO_BODY_BYTES);
        } catch {
          body = {};
        }
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (body.name !== undefined) patch.name = text(body.name, 120);
        if (body.location !== undefined) patch.location = text(body.location, 120);
        if (body.notes !== undefined) patch.notes = longText(body.notes, 2000);
        /*
         * Foto del cliente: WhatsApp no la entrega nunca (su API no expone la
         * foto de perfil de los contactos), así que la sube el equipo y se
         * queda guardada con el cliente. `null` la quita.
         */
        if (body.photo_url !== undefined || body.photoUrl !== undefined) {
          // Ojo con `??`: al BORRAR la foto llega `null` a propósito.
          const recibida = body.photo_url !== undefined ? body.photo_url : body.photoUrl;
          const limpia = normalizeCustomerPhoto(recibida);
          if (limpia === undefined) {
            json(res, 422, {
              ok: false,
              error: 'invalid_photo',
              message: 'La foto no vale: usa una imagen JPG, PNG o WebP pequeña, o una dirección https.',
            });
            return;
          }
          patch.photo_url = limpia;
        }
        /*
         * PREFERENCIAS DE PEDIDO: el frasco, la cantidad, la forma de pago, la
         * ubicación de entrega y una nota, guardados CON el cliente para que el
         * próximo pedido venga ya relleno (solo se confirma la cantidad).
         */
        if (body.orderPrefs !== undefined || body.order_prefs !== undefined) {
          const pedidas = body.orderPrefs !== undefined ? body.orderPrefs : body.order_prefs;
          const limpias = normalizeOrderPrefs(pedidas, await ctx.customers.listLocations(customerId, { limit: 100 }));
          if (limpias === undefined) {
            json(res, 422, {
              ok: false,
              error: 'invalid_order_prefs',
              message:
                'Esas preferencias no valen: revisa el frasco (debe existir en el catálogo), la cantidad, la forma de pago y la ubicación (debe ser una del cliente).',
            });
            return;
          }
          patch.orderPrefs = limpias;
        }
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

    if (route === '/api/admin/notifications' && req.method === 'DELETE') {
      const notifications = await listUserNotifications(ctx, actor, { limit: 500 });
      let deleted = 0;
      for (const row of notifications) {
        if (await ctx.db.remove('user_notifications', row.id)) deleted += 1;
      }
      await ctx.audit?.record({
        entity: 'notifications',
        entityId: actor?.id ?? 'legacy',
        action: 'notifications.deleted_all',
        actor: actor?.display_name ?? null,
        summary: `Notificaciones eliminadas: ${deleted}`,
        data: { deleted },
      });
      json(res, 200, { ok: true, deleted });
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
      const ownerUserId = await pushOwnerUserId(ctx, actor);
      if (!ownerUserId) {
        json(res, 409, {
          ok: false,
          error: 'no_push_owner',
          message:
            'No hay un administrador activo al que asociar este teléfono. Crea un usuario ADMIN o entra con usuario y contraseña para activar las notificaciones.',
        });
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
        user_id: ownerUserId,
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

    if (route === '/api/admin/push-status' && req.method === 'GET') {
      json(res, 200, { ok: true, push: await pushStatusForUser(ctx, await pushOwnerUserId(ctx, actor)) });
      return;
    }

    if (route === '/api/admin/push-subscriptions/test' && req.method === 'POST') {
      const ownerUserId = await pushOwnerUserId(ctx, actor);
      if (!ownerUserId) {
        json(res, 409, { ok: false, error: 'no_push_owner', message: 'No hay un administrador activo al que asociar este teléfono.' });
        return;
      }
      const notification = await createUserNotification(ctx, {
        recipientUserId: ownerUserId,
        type: 'PUSH_TEST',
        title: 'Prueba de notificaciones',
        body: 'Si ves esto en el teléfono, este dispositivo está conectado.',
        entityType: 'system',
        entityId: ownerUserId,
        deepLink: '/admin/?v=hoy',
        data: { vibrate: [120, 60, 120] },
        idempotencyKey: `push-test:${ownerUserId}:${ctx.clock().toISOString()}:${randomBytes(4).toString('hex')}`,
      });
      const push = notification.notification ? await sendPushForNotification(ctx, notification.notification) : null;
      const status = await pushStatusForUser(ctx, ownerUserId);
      /*
       * El mensaje dice lo que PASÓ, no lo que se intentó: «sent» significa que el
       * servicio de push del teléfono aceptó el aviso. Con `subscriptions: 1` pero
       * `sent: 0` (llaves ausentes, endpoint caducado o rechazo) el panel necesita
       * saberlo para poder explicarlo en vez de dar la prueba por buena.
       */
      const resumen = !push || !push.subscriptions
        ? 'Este usuario no tiene un teléfono registrado para push.'
        : push.sent > 0
          ? `Prueba enviada al teléfono (${push.sent}).`
          : push.notConfigured > 0
            ? 'El servidor no tiene llaves push: no se envió nada.'
            : push.expired > 0
              ? 'El teléfono registrado ya no acepta avisos: hay que registrarlo otra vez.'
              : push.failed > 0
                ? 'El servicio de push rechazó el envío.'
                : 'No se envió nada: el teléfono ya había recibido esta prueba.';
      json(res, push?.subscriptions ? 200 : 409, {
        ok: Boolean(push?.sent),
        notification: notification.notification ? { id: notification.notification.id } : null,
        push,
        status,
        message: resumen,
      });
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

    if (route === '/api/admin/whatsapp/events' && req.method === 'GET') {
      if (!can('chats.read')) {
        forbid();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Sin esto, nginx guarda la respuesta en búfer y los avisos llegan tarde
        // (o no llegan): justo lo contrario de lo que se busca aquí.
        'x-accel-buffering': 'no',
      });
      const client = { res, actor };
      ctx.chatEventClients.add(client);
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const heartbeat = setInterval(() => {
        try {
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        } catch {
          clearInterval(heartbeat);
          ctx.chatEventClients.delete(client);
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        ctx.chatEventClients.delete(client);
      });
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
        const body = await readJsonBody(req).catch(() => ({}));
        const deliveryNote = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
        const required = action === 'complete' ? 'delivery.tracking.stop' : 'delivery.tracking.stop';
        if (!requirePermission(required)) return;
        if (action === 'complete' && session.status === 'COMPLETED') {
          const item = await findOrderItem(store, session.order_id);
          json(res, 200, {
            ok: true,
            duplicate: true,
            session: await publicSessionWithOrder(ctx, session),
            order: item ? orderOf(item) : null,
          });
          return;
        }
        if (action === 'stop' && session.status !== ACTIVE_TRACKING_STATUS) {
          json(res, 200, { ok: true, duplicate: true, session: await publicSessionWithOrder(ctx, session) });
          return;
        }
        if (action === 'complete') {
          const item = await findOrderItem(store, session.order_id);
          if (item && !isCompletedPurchaseStatus(item.status)) {
            const check = await ensureInventoryForSale(ctx, { ...item, status: BUSINESS_COMPLETED_PURCHASE_STATUS });
            if (!check.ok) {
              json(res, check.status ?? 409, { ok: false, error: check.error, message: check.message, available: check.available, required: check.required });
              return;
            }
          }
        }
        const status = action === 'complete' ? 'COMPLETED' : 'CANCELLED';
        let metadata = {};
        try {
          metadata = session.metadata ? JSON.parse(session.metadata) : {};
        } catch {
          metadata = {};
        }
        const ended = await ctx.db.update('delivery_tracking_sessions', session.id, {
          status,
          ended_at: ctx.clock().toISOString(),
          metadata: JSON.stringify({
            ...metadata,
            ...(deliveryNote ? { completion_note: deliveryNote } : {}),
          }),
          updated_at: ctx.clock().toISOString(),
        });
        let order = null;
        if (action === 'complete') {
          const item = await findOrderItem(store, session.order_id);
          if (item) {
            const delivered = await markOrderDelivered(ctx, item, actor, { source: 'DELIVERY_ACTION' });
            order = delivered.order ?? null;
            if (!delivered.duplicate) {
              await auditOrderStatusTransition(ctx, {
                orderId: item.id,
                previousStatus: item.status ?? null,
                newStatus: BUSINESS_COMPLETED_PURCHASE_STATUS,
                actor,
                reason: deliveryNote ? `Entrega completada por delivery: ${deliveryNote}` : 'Entrega completada por delivery',
                changedAt: ctx.clock().toISOString(),
                source: 'DELIVERY_ACTION',
                idempotencyKey: `order.status:${item.id}:delivery-complete:${session.id}`,
              });
            }
            if (order) {
              await notifyDeliveryCustomer(ctx, { item, order, actor, kind: 'delivered' }).catch(() => null);
              const refreshed = await findOrderItem(store, item.id);
              order = refreshed ? orderOf(refreshed) ?? order : order;
              await notifyAdminsDeliveryCompleted(ctx, refreshed ?? item, order, actor).catch(() => null);
              const refreshedAfterAdmin = await findOrderItem(store, item.id);
              order = refreshedAfterAdmin ? orderOf(refreshedAfterAdmin) ?? order : order;
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
      const currentOrder = orderOf(item);
      if (['entregado', 'cancelado', 'perdido'].includes(String(currentOrder?.status ?? item.status ?? ''))) {
        json(res, 409, { ok: false, error: 'order_closed', message: 'No se puede asignar un pedido cerrado.' });
        return;
      }
      const activeSessions = await activeTrackingSessionsForOrder(ctx, orderId);
      if (activeSessions.length) {
        json(res, 409, { ok: false, error: 'active_tracking_exists', message: 'Detén o completa la entrega activa antes de reasignar.' });
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
      if (deliveryUserId && (!deliveryUser || !canDeliver(deliveryUser) || deliveryUser.active === false)) {
        json(res, 422, { ok: false, error: 'invalid_delivery_user', message: 'Asigna un agente o un repartidor.' });
        return;
      }
      const assignmentNote = text(body.deliveryNote ?? body.delivery_note ?? body.note, 600);
      const assigned = await assignDeliveryToOrder(ctx, item, deliveryUser, actor, { assignmentNote });
      const customerNotification = deliveryUser
        ? await notifyDeliveryCustomer(ctx, { item: assigned.item, order: assigned.order, actor, kind: 'assignment' }).catch((error) => ({
            status: 'failed',
            reason: error?.message ?? 'notification_failed',
          }))
        : { status: 'not_applicable', reason: 'unassigned' };
      json(res, 200, { ok: true, order: assigned.order, deliveryUser, customerNotification });
      return;
    }

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/issue') && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.stop')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/issue'.length));
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
      const result = await reportDeliveryIssue(ctx, item, actor, body);
      if (!result.ok) {
        json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
        return;
      }
      json(res, 200, { ok: true, order: result.order, closedTracking: result.closedTracking.map((session) => publicTrackingSession(session)) });
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
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await withOrderTransitionLock(orderId, async () => {
        const item = await findOrderItem(store, orderId);
        if (!item) return { status: 404, body: { ok: false, error: 'not_found' } };
        const order = orderOf(item);
        if (['entregado', 'cancelado', 'perdido'].includes(order?.status)) {
          return { status: 409, body: { ok: false, error: 'order_closed', message: 'Este pedido ya está cerrado.' } };
        }
        const destination = orderDestination(order);
        if (!destination) {
          return { status: 422, body: { ok: false, error: 'missing_destination', message: 'El pedido no tiene ubicación de entrega.' } };
        }
        const requestedUserId = text(body.deliveryUserId ?? body.delivery_user_id, 80);
        const assignedUserId = text(order.delivery?.delivery_user_id, 80);
        const deliveryUser =
          canManageAll && requestedUserId ? await ctx.users.get(requestedUserId) : currentUser;
        if (!deliveryUser || !canDeliver(deliveryUser) || deliveryUser.active === false) {
          return { status: 422, body: { ok: false, error: 'invalid_delivery_user', message: 'Asigna un agente o un repartidor.' } };
        }
        if (assignedUserId && deliveryUser.id !== assignedUserId && !canManageAll) {
          return { status: 403, body: { ok: false, error: 'forbidden', message: 'Este pedido está asignado a otro delivery.' } };
        }
        if (!assignedUserId && !canManageAll) {
          return { status: 409, body: { ok: false, error: 'delivery_not_assigned', message: 'Un ADMIN debe asignar este pedido antes de iniciar entrega.' } };
        }
        if (!canManageAll && deliveryUser.id !== actor?.id) {
          return { status: 403, body: { ok: false, error: 'forbidden', message: 'No tienes permiso para esta acción.' } };
        }
        if (!canManageAll && order.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.ISSUE_REPORTED) {
          return { status: 409, body: { ok: false, error: 'issue_pending_admin', message: 'La incidencia está esperando decisión administrativa.' } };
        }
        const existing = (await ctx.db.list('delivery_tracking_sessions', { limit: 1000 })).find(
          (row) => row.order_id === orderId && row.status === ACTIVE_TRACKING_STATUS,
        );
        if (existing) {
          if (!canReadTracking(actor, existing)) {
            return { status: 403, body: { ok: false, error: 'forbidden', message: 'No tienes permiso para esta acción.' } };
          }
          return { status: 200, body: { ok: true, duplicate: true, session: await publicSessionWithOrder(ctx, existing) } };
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
        if (statusUpdate?.item) {
          await auditOrderStatusTransition(ctx, {
            orderId,
            previousStatus: freshItem.status ?? null,
            newStatus: 'enviado',
            actor,
            reason: 'Entrega iniciada',
            changedAt: ctx.clock().toISOString(),
            source: 'DELIVERY_ACTION',
            idempotencyKey: `order.status:${orderId}:delivery-start:${inserted.doc.id}`,
          });
          await ctx.audit?.record({
            entity: 'order',
            entityId: orderId,
            action: 'delivery.started',
            actor: actor?.display_name ?? null,
            summary: 'Entrega iniciada',
            data: { order_id: orderId, delivery_user_id: deliveryUser.id, session_id: inserted.doc.id },
            idempotencyKey: `delivery.started:${orderId}:${inserted.doc.id}`,
          });
        }
        await emitDeliveryEvent(ctx, 'delivery.tracking_started', inserted.doc);
        return {
          status: 201,
          body: {
            ok: true,
            session: await publicSessionWithOrder(ctx, inserted.doc),
            order: statusUpdate?.order ?? order,
          },
        };
      });
      json(res, result.status, result.body);
      return;
    }

    /*
     * ENVIAR LA FACTURA POR WHATSAPP — sin salir del CRM.
     *
     * Lo que NO se hace aquí: abrir WhatsApp Web, la app de WhatsApp, el menú de
     * compartir del sistema ni obligar a descargar el PDF. El CRM lo manda él
     * mismo con la API oficial y lo deja escrito en el hilo.
     *
     * La factura NO llega del navegador: se resuelve el PEDIDO por su id (única
     * fuente de verdad) y de ahí salen el cliente, su conversación y el PDF. Nada
     * de lo que manda el panel se usa para decidir a quién se le envía.
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/invoice-whatsapp') && req.method === 'POST') {
      if (!requirePermission('chats.reply')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/invoice-whatsapp'.length)).replace(/\/+$/, '');
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const item = (await store.listAdmin({ limit: 1000 })).find((entry) => entry.id === orderId) ?? null;
      if (!item || item.type !== 'order_intent') {
        json(res, 404, { ok: false, error: 'not_found', message: 'Ese pedido no existe.' });
        return;
      }
      if (!(await canReadOrder(ctx, actor, item))) {
        forbid();
        return;
      }
      // 1) El CLIENTE sale del pedido, nunca de la petición.
      const customer = item.customer_id ? await ctx.customers.get(item.customer_id) : null;
      if (!customer) {
        json(res, 409, {
          ok: false,
          error: 'order_without_customer',
          message: 'Ese pedido no tiene cliente asignado: no hay a quién enviarle la factura.',
        });
        return;
      }
      if (!customer.phone_e164) {
        json(res, 409, { ok: false, error: 'missing_phone', message: 'Ese cliente no tiene teléfono de WhatsApp.' });
        return;
      }
      if (customer.do_not_contact || customer.whatsapp_opt_out_at) {
        json(res, 409, { ok: false, error: 'do_not_contact', message: 'Este cliente pidió no recibir mensajes. Respétalo.' });
        return;
      }
      if (!ctx.whatsapp?.enabled) {
        json(res, 503, {
          ok: false,
          error: 'whatsapp_not_configured',
          message: 'WhatsApp todavía no está configurado en el servidor. La factura NO se ha enviado.',
        });
        return;
      }
      /*
       * 2) La CONVERSACIÓN tiene que ser DE ESTE cliente. Se prefiere la del pedido
       * (de dónde nació), pero solo si de verdad es suya; si no, se usa la del
       * cliente. Si no hay ninguna, no se abre una a la espalda de nadie: se dice.
       */
      const order = orderOf(item);
      const delPedido = order?.conversation_id ? await ctx.db.get('conversations', order.conversation_id) : null;
      const conversacion =
        delPedido && delPedido.customer_id === customer.id
          ? delPedido
          : await ctx.customers.conversationFor(customer.id, { create: false });
      if (!conversacion || conversacion.customer_id !== customer.id) {
        json(res, 409, {
          ok: false,
          error: 'no_conversation',
          message: 'Este cliente todavía no tiene una conversación de WhatsApp en el CRM.',
        });
        return;
      }
      // Misma regla que el texto: sin la conversación a mi nombre no se manda nada.
      if (!(await canOpenConversation(ctx, actor, conversacion))) {
        denyConversation(res, json, conversacion);
        return;
      }

      const receipt = buildReceipt({ order, customer });
      const filename = invoiceFilename(receipt.order_number ?? orderId);
      const dentroDeVentana = ctx.customers.canSendFreeText(conversacion);
      const clave = text(body.idempotencyKey, 120);
      /*
       * DOBLE CLIC / REINTENTO: la clave la manda el panel (una por confirmación).
       * Si esa operación YA existe, se devuelve tal cual sin volver a enviar nada.
       */
      if (clave) {
        const previo = await ctx.db.findBy('wa_messages', 'idempotency_key', clave);
        if (previo) {
          json(res, 200, { ok: true, duplicate: true, message: previo, filename });
          return;
        }
      }

      const actorFields = messageActorFields(actor);
      const meta = { phoneNumberId: ctx.whatsapp.phoneNumberId, to: customer.phone_e164, order_id: item.id, invoice_filename: filename };
      const pdf = receiptPdf(receipt, { timeZone: TIME_ZONE });

      /*
       * ============ FUERA DE LA VENTANA DE 24 H ============
       * WhatsApp no admite texto ni documentos sueltos: solo una plantilla
       * APROBADA. Y para transportar el PDF tiene que ser una plantilla con
       * CABECERA DE DOCUMENTO (comprobado: no se da por hecho).
       */
      if (!dentroDeVentana) {
        const check = await approvedTemplate(ctx, INVOICE_TEMPLATE);
        if (!check.ok) {
          json(res, 409, {
            ok: false,
            error: check.reason === 'unknown_template' ? 'invoice_template_missing' : 'template_not_approved',
            message:
              `La ventana de 24 h de WhatsApp está cerrada, así que la factura solo puede salir con la plantilla «${INVOICE_TEMPLATE}», ` +
              'que todavía no está aprobada en Meta. Regístrala en Meta y pulsa «Sincronizar con Meta» en Ajustes > WhatsApp.',
            template: check.template ?? null,
            outsideWindow: true,
          });
          return;
        }
        if (String(check.template?.header?.format ?? '').toUpperCase() !== 'DOCUMENT') {
          json(res, 409, {
            ok: false,
            error: 'template_without_document_header',
            message:
              `La plantilla «${INVOICE_TEMPLATE}» no lleva cabecera de documento en Meta, así que no puede transportar el PDF. ` +
              'Revísala en Meta y vuelve a sincronizar.',
            template: check.template,
            outsideWindow: true,
          });
          return;
        }
        const subida = await ctx.media.whatsapp.uploadMedia({ buffer: pdf, mimeType: 'application/pdf', filename });
        if (!subida.ok) {
          json(res, 502, {
            ok: false,
            error: 'upload_failed',
            message: 'No se pudo preparar la factura para WhatsApp. No se ha enviado nada.',
            detail: subida.error ?? null,
          });
          return;
        }
        const payload = await resolveTemplatePayload(ctx, {
          template: check.template,
          customer,
          conversation: conversacion,
          provided: { 1: customer.name || customer.phone_e164, 2: receipt.order_number ?? '' },
        });
        if (!payload.ok) {
          json(res, payload.status ?? 422, { ok: false, error: payload.error, message: payload.message, missing: payload.missing ?? undefined });
          return;
        }
        // La cabecera lleva el PDF de verdad; el cuerpo, el nombre y el pedido.
        const components = [
          { type: 'header', parameters: [{ type: 'document', document: { id: subida.mediaId, filename } }] },
          ...(payload.components ?? []),
        ];
        const result = await ctx.whatsapp.sendTemplate(customer.phone_e164, {
          name: check.template.name,
          language: check.template.language ?? 'es',
          components,
        });
        const registrado = await ctx.customers.recordOutbound({
          customer,
          conversation: conversacion,
          type: 'template',
          template: check.template.name,
          body: payload.body,
          waMessageId: result.messageId ?? null,
          status: result.ok ? 'sent' : 'failed',
          error: result.ok ? null : (result.error ?? { message: result.reason ?? 'error' }),
          idempotencyKey: clave,
          meta,
          ...actorFields,
        });
        await ctx.audit?.record({
          entity: 'message',
          entityId: registrado.message?.id ?? null,
          action: result.ok ? 'message.sent' : 'message.failed',
          actor: actor?.display_name ?? null,
          summary: `Factura ${filename} ${result.ok ? 'enviada' : 'rechazada'} (plantilla) a ${customer.name ?? customer.phone_e164}`,
          data: { order_id: item.id, order_number: receipt.order_number ?? null, filename, template: check.template.name, outside_window: true },
          idempotencyKey: registrado.message?.id ? `${result.ok ? 'message.sent' : 'message.failed'}:${registrado.message.id}` : null,
        });
        if (!result.ok) {
          json(res, 502, {
            ok: false,
            error: 'send_failed',
            message: 'WhatsApp rechazó el envío de la factura. No se ha enviado nada.',
            detail: result.error ?? null,
            message_record: registrado.message,
          });
          return;
        }
        await ctx.customers.markConversationRead(conversacion.id);
        json(res, 201, {
          ok: true,
          duplicate: false,
          filename,
          order_number: receipt.order_number ?? null,
          template: check.template.name,
          outsideWindow: true,
          message: registrado.message,
        });
        return;
      }

      /*
       * ============ DENTRO DE LA VENTANA DE 24 H ============
       * Primero el texto corto (una sola vez) y después el PDF como documento
       * NATIVO de WhatsApp, por la MISMA puerta que las fotos y los audios: así
       * hereda el guardado, la idempotencia y el registro del hilo.
       */
      const saludo = invoiceCaption(customer);
      let registradoTexto = clave ? await ctx.db.findBy('wa_messages', 'idempotency_key', `${clave}:text`) : null;
      if (!registradoTexto) {
        const envioTexto = await ctx.whatsapp.sendText(customer.phone_e164, saludo);
        registradoTexto = (
          await ctx.customers.recordOutbound({
            customer,
            conversation: conversacion,
            type: 'text',
            body: saludo,
            waMessageId: envioTexto.messageId ?? null,
            status: envioTexto.ok ? 'sent' : 'failed',
            error: envioTexto.ok ? null : (envioTexto.error ?? { message: envioTexto.reason ?? 'error' }),
            idempotencyKey: clave ? `${clave}:text` : null,
            meta,
            ...actorFields,
          })
        ).message;
        if (!envioTexto.ok) {
          json(res, 502, {
            ok: false,
            error: 'send_failed',
            message: 'WhatsApp rechazó el mensaje. La factura NO se ha enviado.',
            detail: envioTexto.error ?? null,
            message_record: registradoTexto,
          });
          return;
        }
      }

      const documento = await ctx.media.pipeline.processOutbound({
        direction: 'document',
        to: customer.phone_e164,
        buffer: pdf,
        declaredMime: 'application/pdf',
        filename,
        caption: null,
        conversationId: conversacion.id,
        idempotencyKey: clave ? `${clave}:doc` : null,
        findExistingMessage: (key) => ctx.db.findBy('wa_messages', 'idempotency_key', key),
      });
      if (!documento.ok) {
        if (documento.requiresReconciliation) {
          json(res, 409, {
            ok: false,
            error: 'send_unknown',
            message:
              'Se envió la factura pero WhatsApp no confirmó si llegó. NO se ha reenviado para no duplicarla: míralo en el hilo antes de intentarlo otra vez.',
          });
          return;
        }
        const codigo = documento.error?.code ?? 'send_failed';
        json(res, codigo === 'too_large' ? 413 : 422, {
          ok: false,
          error: codigo,
          message: 'No se pudo enviar la factura por WhatsApp. No se ha enviado nada.',
          detail: documento.error ?? null,
        });
        return;
      }

      // El mensaje del documento lo guarda el CRM, y la operación de archivo se
      // reapunta a ese mensaje para que el hilo pueda pintarlo con su estado real.
      const registradoDocumento = documento.duplicate && !clave
        ? null
        : await ctx.customers.recordOutbound({
            customer,
            conversation: conversacion,
            type: 'document',
            body: filename,
            waMessageId: documento.waMessageId ?? null,
            status: documento.waMessageId ? 'sent' : 'pending',
            idempotencyKey: clave,
            meta,
            ...actorFields,
          });
      try {
        const fila =
          (clave ? await ctx.media.store.byIdempotencyKey(`${clave}:doc`) : null) ??
          (documento.waMessageId ? await ctx.media.store.byWaMessageId(documento.waMessageId) : null);
        if (fila && registradoDocumento?.message?.id && fila.message_id !== registradoDocumento.message.id) {
          await ctx.media.store.update(fila.id, { messageId: registradoDocumento.message.id });
        }
      } catch (error) {
        console.warn(`[crm] no se pudo enlazar la factura con su mensaje: ${error?.message ?? error}`);
      }
      await ctx.customers.markConversationRead(conversacion.id);
      await ctx.audit?.record({
        entity: 'message',
        entityId: registradoDocumento?.message?.id ?? null,
        action: 'message.sent',
        actor: actor?.display_name ?? null,
        summary: `Factura ${filename} enviada a ${customer.name ?? customer.phone_e164}`,
        data: { order_id: item.id, order_number: receipt.order_number ?? null, filename, media_type: 'document' },
        idempotencyKey: registradoDocumento?.message?.id ? `message.sent:${registradoDocumento.message.id}` : null,
      });
      json(res, 201, {
        ok: true,
        duplicate: documento.duplicate === true,
        filename,
        order_number: receipt.order_number ?? null,
        outsideWindow: false,
        message: registradoDocumento?.message ?? null,
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
      if (!(await canReadOrder(ctx, actor, item))) {
        forbid();
        return;
      }
      const order = orderOf(item);
      const customer = item.customer_id ? await ctx.customers.get(item.customer_id) : null;
      const receipt = buildReceipt({ order, customer });
      /*
       * VISTA PREVIA del envío de la factura: EXACTAMENTE lo que va a salir, sin
       * enviarlo. El texto, el nombre del archivo y la ventana de 24 h los decide
       * el SERVIDOR (una sola fuente de verdad): el panel solo los enseña, nunca
       * los inventa ni los manda.
       */
      if (action === 'invoice-whatsapp') {
        if (!requirePermission('chats.reply')) return;
        const filename = invoiceFilename(receipt.order_number ?? orderId);
        const base = {
          ok: true,
          filename,
          order_number: receipt.order_number ?? null,
          customer_name: customer?.name ?? null,
        };
        const noSePuede = (error, message) => json(res, 200, { ...base, sendable: false, error, message });
        if (!customer) return noSePuede('order_without_customer', 'Ese pedido no tiene cliente asignado: no hay a quién enviarle la factura.');
        if (!customer.phone_e164) return noSePuede('missing_phone', 'Ese cliente no tiene teléfono de WhatsApp.');
        if (customer.do_not_contact || customer.whatsapp_opt_out_at) return noSePuede('do_not_contact', 'Este cliente pidió no recibir mensajes. Respétalo.');
        if (!ctx.whatsapp?.enabled) return noSePuede('whatsapp_not_configured', 'WhatsApp todavía no está configurado en el servidor.');
        // La conversación, con la MISMA regla que el envío: solo la suya.
        const delPedido = order?.conversation_id ? await ctx.db.get('conversations', order.conversation_id) : null;
        const conversacion =
          delPedido && delPedido.customer_id === customer.id
            ? delPedido
            : await ctx.customers.conversationFor(customer.id, { create: false });
        if (!conversacion || conversacion.customer_id !== customer.id) {
          return noSePuede('no_conversation', 'Este cliente todavía no tiene una conversación de WhatsApp en el CRM.');
        }
        const dentroDeVentana = ctx.customers.canSendFreeText(conversacion);
        if (dentroDeVentana) {
          json(res, 200, {
            ...base,
            sendable: true,
            insideWindow: true,
            conversation_id: conversacion.id,
            greeting: invoiceCaption(customer),
            template: null,
          });
          return;
        }
        /*
         * Cerrada la ventana solo sale con la plantilla APROBADA con cabecera de
         * documento. Si no lo está, se dice ANTES de intentar nada.
         */
        const check = await approvedTemplate(ctx, INVOICE_TEMPLATE);
        if (!check.ok) {
          json(res, 200, {
            ...base,
            sendable: false,
            insideWindow: false,
            conversation_id: conversacion.id,
            error: check.reason === 'unknown_template' ? 'invoice_template_missing' : 'template_not_approved',
            message:
              `La ventana de 24 h de WhatsApp está cerrada, así que la factura solo puede salir con la plantilla «${INVOICE_TEMPLATE}», ` +
              'que todavía no está aprobada en Meta. Regístrala en Meta y pulsa «Sincronizar con Meta» en Ajustes > WhatsApp.',
            template: check.template ?? null,
          });
          return;
        }
        if (String(check.template?.header?.format ?? '').toUpperCase() !== 'DOCUMENT') {
          json(res, 200, {
            ...base,
            sendable: false,
            insideWindow: false,
            conversation_id: conversacion.id,
            error: 'template_without_document_header',
            message:
              `La plantilla «${INVOICE_TEMPLATE}» no lleva cabecera de documento en Meta, así que no puede transportar el PDF. ` +
              'Revísala en Meta y vuelve a sincronizar.',
            template: check.template,
          });
          return;
        }
        // El texto de la plantilla, con los MISMOS datos que usará el envío real.
        const cuerpo = String(check.template.body ?? '')
          .replace(/\{\{1\}\}/g, customer.name || customer.phone_e164)
          .replace(/\{\{2\}\}/g, receipt.order_number ?? '');
        json(res, 200, {
          ...base,
          sendable: true,
          insideWindow: false,
          conversation_id: conversacion.id,
          greeting: cuerpo,
          template: {
            name: check.template.name,
            friendly_name: check.template.friendly_name ?? null,
            category: check.template.category ?? null,
            language: check.template.language ?? null,
            header: check.template.header ?? null,
          },
        });
        return;
      }
      if (action === 'integrity') {
        json(res, 200, { ok: true, integrity: await validateOrderOperationalIntegrity(ctx, orderId) });
        return;
      }

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

      // Documento HTML ligero con acciones móviles (volver + abrir el PDF + enviarlo por WhatsApp).
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
        integrity: await validateOrderOperationalIntegrity(ctx, orderId),
        timeline: await orderTimeline(ctx, orderId, order),
        followups: followupRows.filter((row) => row.order_id === orderId || row.purchase_id === orderId),
        scheduled: (await ctx.scheduler.list()).filter((row) => row.order_id === orderId),
      });
      return;
    }

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/status') && req.method === 'PATCH') {
      if (!requirePermission('orders.change_status', 'Solo ADMIN puede cambiar el estado manualmente.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/status'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await transitionOrderStatus(ctx, {
        orderId,
        targetStatus: body.status,
        expectedStatus: body.expectedStatus ?? body.expected_status,
        reason: body.reason,
        actor,
        source: 'MANUAL_ADMIN',
      });
      if (!result.ok) {
        json(res, result.status ?? 422, {
          ok: false,
          error: result.error,
          message: result.message,
          currentStatus: result.currentStatus,
          available: result.available,
          required: result.required,
        });
        return;
      }
      json(res, 200, {
        ok: true,
        duplicate: result.duplicate === true,
        item: sanitizeItemForPermissions(result.item, actor),
        order: sanitizeOrderForPermissions(result.order, actor),
        delivered: hasPermission(actor, 'cost.view') ? result.delivered : stripSensitiveFinancials(result.delivered),
        integrity: result.integrity,
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

    if (route.startsWith('/api/admin/orders/') && req.method === 'DELETE') {
      if (!requirePermission('sales.cancel', 'Solo ADMIN puede eliminar pedidos.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length)).replace(/\/+$/, '');
      const item = (await store.listAdmin({ limit: 5000 })).find((entry) => entry.id === orderId) ?? null;
      if (!item || item.type !== 'order_intent') {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      const status = String(item.status ?? order?.status ?? '').toLowerCase();
      const blocked =
        isCompletedPurchaseStatus(status) ||
        ['cancelado', 'perdido'].includes(status) ||
        Boolean(order?.delivered_at || order?.cancelled_at || order?.inventory_restored_at || item.meta_purchase_event_id);
      if (blocked) {
        json(res, 409, {
          ok: false,
          error: 'order_has_commercial_history',
          message: 'Este pedido ya tiene historial comercial. No se borra: usa Cancelar venta para conservar trazabilidad.',
        });
        return;
      }
      const deleted = await store.remove(orderId);
      await ctx.audit?.record({
        entity: 'order',
        entityId: orderId,
        action: 'order.deleted',
        actor: actor?.display_name ?? null,
        summary: `Pedido eliminado: ${order?.order_number ?? item.order_number ?? orderId}`,
        data: { customer_id: item.customer_id ?? order?.customer_id ?? null, status },
      });
      json(res, 200, { ok: true, deleted });
      return;
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
      if (
        entrega.provided &&
        (current.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT || (await activeTrackingSessionsForOrder(ctx, orderId)).length)
      ) {
        json(res, 409, {
          ok: false,
          error: 'delivery_in_transit_destination_locked',
          message: 'La entrega está en camino. Para cambiar el destino hace falta detener o resolver la entrega activa.',
        });
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
     * TODAS LAS UBICACIONES EN UNA SOLA PETICIÓN.
     *
     * La pantalla «Mapa de pedidos» necesita TODOS los puntos de una vez. Pedirlos
     * cliente por cliente (lo que hacía el panel con `fetchAllLocations`) eran
     * decenas de viajes sobre red móvil y el mapa tardaba en pintarse. Cada punto
     * sale ya con el nombre del cliente y el número del pedido si lo tiene, para
     * que el panel no tenga que cruzar nada.
     */
    if (route === '/api/admin/locations' && req.method === 'GET') {
      const limite = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 2000);
      const deliveryScope = await deliveryAccessScope(ctx, actor);
      const locations = (await ctx.customers.listLocations(null, { limit: limite })).filter(
        (location) =>
          !deliveryScope.restricted ||
          deliveryScope.customerIds.has(location.customer_id) ||
          deliveryScope.orderIds.has(location.order_id),
      );
      const customerList = (await ctx.customers.list({})).filter(
        (customer) => !deliveryScope.restricted || deliveryScope.customerIds.has(customer.id),
      );
      const clientePorId = new Map(customerList.map((row) => [row.id, row]));
      /** @type {Map<string, any>} */
      const pedidoPorId = new Map();
      for (const item of await store.listAdmin({ limit: 5000 })) {
        if (item.type === 'order_intent') pedidoPorId.set(item.id, item);
      }
      json(res, 200, {
        ok: true,
        locations: locations.map((location) => {
          const customer = clientePorId.get(location.customer_id) ?? null;
          const pedido = location.order_id ? pedidoPorId.get(location.order_id) ?? null : null;
          return {
            ...location,
            customer_name: customer?.name ?? null,
            customer_phone: customer?.phone_e164 ?? customer?.phone ?? null,
            customer_stage: customer?.customerStage ?? customer?.customer_stage ?? null,
            order_number: pedido?.order_number ?? null,
          };
        }),
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
      if (!(await canWorkWithCustomer(ctx, actor, source.customer_id))) {
        forbid();
        return;
      }
      const destination = await findConversation(ctx, text(body.conversationId, 80) ?? '');
      if (!destination) {
        json(res, 404, { ok: false, error: 'unknown_conversation', message: 'Elige una conversación de destino.' });
        return;
      }
      if (!(await canOpenConversation(ctx, actor, destination))) {
        denyConversation(res, json, destination);
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
      /*
       * CÓMO VIAJA LA UBICACIÓN.
       *
       * Dentro de la ventana de 24 h se manda la ubicación NATIVA de WhatsApp (el
       * cliente la abre en el mapa del chat, que es lo natural).
       *
       * Fuera de la ventana WhatsApp NO deja mandar ubicaciones: solo plantillas
       * aprobadas. Entonces se manda la plantilla con hueco libre y dentro va el
       * ENLACE del mapa. Es la única forma legítima de compartirla, y el panel lo
       * dice antes de enviar: nunca se finge que se compartió.
       */
      const dentroDeVentana = ctx.customers.canSendFreeText(destination);
      /*
       * El modo lo elige quien envía. Sin modo, se intenta la ubicación NATIVA (lo
       * natural y lo que el cliente ve como ubicación): si la ventana está cerrada
       * se responde con `canUseTemplate` para que el panel lo ofrezca, en vez de
       * mandar por su cuenta algo distinto de lo que se pidió.
       */
      const modo = text(body.mode, 20) === 'template' ? 'template' : 'location';
      if (modo === 'location' && !dentroDeVentana) {
        json(res, 409, {
          ok: false,
          error: 'outside_window',
          canUseTemplate: true,
          message:
            'Han pasado más de 24 h desde el último mensaje del cliente de destino: WhatsApp ya no deja enviar la ubicación. Puedes mandarla por plantilla, con el enlace del mapa.',
        });
        return;
      }
      const compartida = { ...source, source: LOCATION_SOURCES.REUSED_LOCATION };
      /** @type {{ok: boolean, messageId?: string|null, error?: any, plantilla?: any, cuerpo: string, tipo: string}} */
      let envio = { ok: false, cuerpo: '', tipo: 'location' };
      if (modo === 'template') {
        const enlace = locationMapsLink(compartida);
        if (!enlace) {
          json(res, 422, {
            ok: false,
            error: 'location_without_coordinates',
            message: 'Esta ubicación no trae coordenadas legibles: no hay enlace que mandar.',
          });
          return;
        }
        const plantilla = await freeTextTemplate(ctx);
        if (!plantilla) {
          json(res, 409, {
            ok: false,
            error: 'no_template_with_free_slot',
            message:
              'No hay ninguna plantilla APROBADA con un hueco de texto libre para mandar el enlace. Regístrala en Meta (o edita el nombre del hueco) y pulsa «Sincronizar con Meta».',
          });
          return;
        }
        const payload = await resolveTemplatePayload(ctx, {
          template: plantilla,
          customer: destinoCustomer,
          conversation: destination,
          provided: {
            1: destinoCustomer.name || destinoCustomer.phone_e164,
            2: `Te compartimos la ubicación de entrega: ${enlace}`,
          },
        });
        if (!payload.ok) {
          json(res, payload.status ?? 422, {
            ok: false,
            error: payload.error,
            message: payload.message,
            missing: payload.missing ?? undefined,
          });
          return;
        }
        const result = await ctx.whatsapp.sendTemplate(destinoCustomer.phone_e164, {
          name: plantilla.name,
          language: plantilla.language ?? 'es',
          components: payload.components,
        });
        envio = {
          ok: result.ok === true,
          messageId: result.messageId ?? null,
          error: result.error ?? (result.ok ? null : { message: result.reason ?? 'error' }),
          plantilla,
          cuerpo: payload.body ?? enlace,
          tipo: 'template',
        };
      } else {
        const result = await ctx.whatsapp.sendLocation(destinoCustomer.phone_e164, compartida);
        envio = {
          ok: result.ok === true,
          messageId: result.messageId ?? null,
          error: result.error ?? (result.ok ? null : { message: result.reason ?? 'error' }),
          cuerpo: source.address ?? '[ubicación]',
          tipo: 'location',
        };
      }
      const recorded = await ctx.customers.recordOutbound({
        customer: destinoCustomer,
        conversation: destination,
        type: envio.tipo,
        // Tanto la ubicación como el enlace dejan el punto guardado en el destino:
        // así el mapa de pedidos lo ve sin volver a mirar el chat.
        location: compartida,
        template: envio.plantilla?.name ?? null,
        body: envio.cuerpo,
        waMessageId: envio.messageId,
        status: envio.ok ? 'sent' : 'failed',
        error: envio.ok ? null : envio.error,
        meta: { phoneNumberId: ctx.whatsapp.phoneNumberId, to: destinoCustomer.phone_e164 || null },
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
          mode: modo,
          template: envio.plantilla?.name ?? null,
          operator: actor?.display_name ?? 'panel',
          ok: envio.ok === true,
        },
      });
      if (!envio.ok) {
        json(res, 502, {
          ok: false,
          error: 'send_failed',
          message: envio.error?.message ?? 'WhatsApp rechazó la ubicación.',
          message_record: recorded.message,
        });
        return;
      }
      json(res, 201, { ok: true, mode: modo, message: recorded.message, location: recorded.location });
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
      const listedConversations = await ctx.customers.listConversations({
        filter,
        order,
        q,
        from: dateRange.from,
        to: dateRange.to,
        currentUserId: actor?.actor_type === 'USER' ? actor.id : null,
      });
      const access = await conversationAccess(ctx, actor);
      const conversations =
        isDeliveryOnly(actor) && !access.all
          ? listedConversations.filter((row) => access.conversationIds.has(row.id))
          : listedConversations;
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
      if (!ids.length || !['mark_read', 'archive', 'unarchive', 'delete', 'message_preview'].includes(action)) {
        json(res, 422, { ok: false, error: 'invalid_bulk_action' });
        return;
      }
      const results = [];
      const puedeVerTodo = hasPermission(actor, 'chats.force_reassign');
      for (const id of ids) {
        const conversation = await findConversation(ctx, id);
        if (!conversation) {
          results.push({ id, ok: false, error: 'not_found' });
          continue;
        }
        /*
         * En lote también manda la regla: lo que no es tuyo no se marca leído, no
         * se archiva y no se le manda nada (antes se podía tocar lo ajeno de golpe).
         */
        if (!puedeVerTodo && !(await canOpenConversation(ctx, actor, conversation))) {
          results.push({ id, ok: false, error: 'not_your_conversation' });
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
        if (action === 'delete') {
          const { deletedConversation, deletedMessages } = await deleteConversationFromCrm(ctx, conversation, actor);
          results.push({ id, ok: deletedConversation, deletedMessages });
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

      if ((action === '' || action === 'delete') && req.method === 'DELETE') {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const { deletedConversation, deletedMessages } = await deleteConversationFromCrm(ctx, conversation, actor);
        json(res, 200, { ok: true, deleted: deletedConversation, deletedMessages });
        return;
      }

      /*
       * SOLICITAR QUE ME LA ASIGNEN. Un agente no se asigna conversaciones solo
       * (eso lo pidió el negocio expresamente): pide, y la petición le llega a
       * administración con su aviso y su enlace directo.
       */
      if (action === 'assignment-request' && req.method === 'POST') {
        if (!currentUser) {
          json(res, 409, { ok: false, error: 'legacy_session', message: 'La clave del panel ya puede asignar: no hace falta pedirlo.' });
          return;
        }
        if (conversation.assigned_user_id === currentUser.id) {
          json(res, 409, { ok: false, error: 'already_yours', message: 'Esa conversación ya está a tu nombre.' });
          return;
        }
        const nombre = text(customer?.name, 120) ?? text(customer?.phone_e164, 40) ?? 'un cliente';
        const alFrente = conversation.assigned_display_name_snapshot ?? null;
        const admins = (await ctx.users.listUsers()).filter((user) => user.role === 'ADMIN' && user.active !== false);
        // Una petición por persona y por día: si administración no la atiende, se
        // puede volver a pedir mañana sin llenar el aviso de ruido.
        const hoy = dayIn(ctx.clock(), TIME_ZONE);
        for (const admin of admins) {
          const creada = await createUserNotification(ctx, {
            recipientUserId: admin.id,
            type: 'CONVERSATION_ASSIGNMENT_REQUESTED',
            title: `Piden una conversación · ${nombre}`,
            body: `${actor?.display_name ?? 'Un agente'} pide que le asignes la conversación de ${nombre}${
              alFrente ? ` (ahora la lleva ${alFrente})` : ' (sin asignar)'
            }.`,
            entityType: 'conversation',
            entityId: conversation.id,
            deepLink: `/admin/?v=whatsapp&conversation=${encodeURIComponent(conversation.id)}`,
            data: { customer_id: conversation.customer_id, requested_by_user_id: actor.id, assigned_user_id: conversation.assigned_user_id ?? null },
            idempotencyKey: `conv-request:${conversation.id}:${actor.id}:${hoy}`,
          });
          if (!creada.duplicate) await sendPushForNotification(ctx, creada.notification);
        }
        await ctx.audit?.record({
          entity: 'conversation',
          entityId: conversation.id,
          action: 'conversation.assignment_requested',
          actor: actor?.display_name ?? null,
          summary: `Pide que le asignen la conversación de ${nombre}`,
          data: { requested_by_user_id: actor?.id ?? null, assigned_user_id: conversation.assigned_user_id ?? null },
        });
        json(res, 202, { ok: true, requested: true, notified: admins.length });
        return;
      }

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
        /*
         * NADIE SE ASIGNA NADA SOLO. `take` (ponerse al frente uno mismo) es de
         * administración: un agente lo PIDE (`assignment-request`) y espera. Así el
         * responsable de una conversación no depende de quién llegue primero.
         */
        if (action === 'take' && !requirePermission('chats.take_unassigned', 'Nadie se asigna conversaciones solo: pide que te la asignen.')) return;
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
        // El hilo es de quien la tiene al frente (o de administración).
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const deliveryOrderContext = await deliveryOrderForConversation(ctx, conversation, actor);
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
          deliveryContext: deliveryOrderContext
            ? {
                asDelivery: true,
                orderId: deliveryOrderContext.item.id,
                orderNumber: deliveryOrderContext.order.order_number ?? deliveryOrderContext.item.order_number ?? null,
                deliveryUserName: actor?.display_name ?? deliveryOrderContext.order.delivery?.delivery_user_name_snapshot ?? null,
              }
            : null,
          whatsapp: { configured: Boolean(ctx.whatsapp?.enabled) },
        });
        return;
      }

      /*
       * TEXTO DE «PEDIR CONFIRMACIÓN» (para que el agente lo LEA antes de enviar).
       *
       * Lo construye el servidor desde el pedido REAL de ESTE cliente y ESTA
       * conversación. El panel solo lo enseña; al enviar se vuelve a construir,
       * así que lo que se manda nunca depende del navegador.
       */
      if (action === 'order-confirmation' && req.method === 'GET') {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const encontrado = await conversationOrder(ctx.store, conversation, customer, url.searchParams.get('orderId') ?? '');
        if (!encontrado.ok) {
          json(res, encontrado.status, { ok: false, error: encontrado.error, message: encontrado.message });
          return;
        }
        json(res, 200, {
          ok: true,
          order_number: encontrado.order.order_number ?? null,
          text: orderConfirmationText(encontrado.order, customer),
        });
        return;
      }

      if (action === 'read' && req.method === 'POST') {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const updated = await ctx.customers.markConversationRead(conversation.id);
        json(res, 200, { ok: true, conversation: updated });
        return;
      }

      if ((action === 'archive' || action === 'unarchive') && req.method === 'POST') {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
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
        const deliveryOrderContext = await deliveryOrderForConversation(ctx, conversation, actor);
        if (
          conversation.assigned_user_id &&
          conversation.assigned_user_id !== currentUser?.id &&
          !can('chats.force_reassign') &&
          !deliveryOrderContext
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
        /*
         * BLINDADO: sin la conversación asignada no se contesta. Antes valía con
         * que estuviera SIN asignar (cualquiera podía responder y nadie sabía de
         * quién era); ahora el que quiere atenderla la PIDE y administración decide.
         */
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const deliveryOrderContext = await deliveryOrderForConversation(ctx, conversation, actor);
        if (
          conversation.assigned_user_id &&
          conversation.assigned_user_id !== currentUser?.id &&
          !can('chats.force_reassign') &&
          !deliveryOrderContext
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
        let rawMessageBody = longText(body.body, 1200);
        /*
         * REVALIDACIÓN DE LA CONVERSACIÓN, EN EL SERVIDOR Y JUSTO ANTES DE ENVIAR.
         *
         * La conversación sale del camino de la URL (nunca del cuerpo), así que no
         * hay forma de escribirle a un cliente distinto del de la conversación
         * abierta. Aun así, el panel declara también en qué conversación CREE que
         * está escribiendo: si no coincide —una pestaña vieja, un cambio de cliente
         * a medias— se corta aquí, antes de gastar el mensaje, en vez de mandarlo a
         * quien no toca.
         */
        const claimedConversationId = text(body.conversationId ?? body.conversation_id, 80);
        if (claimedConversationId && claimedConversationId !== conversation.id) {
          json(res, 409, {
            ok: false,
            error: 'conversation_mismatch',
            message:
              'La conversación abierta en el panel ya no es esta. Vuelve a abrirla y reenvía: el mensaje NO se ha enviado.',
          });
          return;
        }
        /*
         * EL DESTINATARIO es, por construcción, el cliente de ESTA conversación
         * (el teléfono sale de aquí, nunca del cuerpo de la petición). Si ese
         * cliente ya no existiera, se corta en vez de enviar a un teléfono suelto.
         */
        if (!customer?.phone_e164) {
          json(res, 409, {
            ok: false,
            error: 'customer_missing',
            message: 'No encontramos el cliente de esta conversación. El mensaje NO se ha enviado.',
          });
          return;
        }
        const templateName = text(body.template, 60);
        /*
         * «PEDIR CONFIRMACIÓN»: cuando llega `orderId`, el texto lo construye el
         * SERVIDOR desde el pedido REAL y se comprueba la relación cliente →
         * conversación → pedido. Lo que mande el navegador en `body` se IGNORA:
         * así no hay forma de enviarle a un cliente el pedido de otro.
         */
        const confirmationOrderId = text(body.orderId ?? body.order_id, 80);
        if (confirmationOrderId) {
          const encontrado = await conversationOrder(ctx.store, conversation, customer, confirmationOrderId);
          if (!encontrado.ok) {
            json(res, encontrado.status, { ok: false, error: encontrado.error, message: encontrado.message });
            return;
          }
          rawMessageBody = longText(orderConfirmationText(encontrado.order, customer), 1200) ?? '';
        }
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
          // La copia local puede haberse quedado vieja porque el negocio editó la
          // plantilla en Meta: se refresca ESA plantilla antes de decidir, o se
          // envía un número de parámetros que Meta ya no espera (error 132000).
          await refreshTemplateFromMeta(ctx, templateName);
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

        const messageBody =
          !template && deliveryOrderContext && messageNeedsDeliveryIdentity(deliveryOrderContext.order, actor)
            ? withDeliveryIdentity(rawMessageBody, actor)
            : rawMessageBody;
        const templatePayload = template
          ? await resolveTemplatePayload(ctx, {
              template,
              customer,
              conversation,
              orderId: text(body.orderId ?? body.order_id, 80),
              provided: body.templateValues && typeof body.templateValues === 'object' && !Array.isArray(body.templateValues) ? body.templateValues : null,
            })
          : null;
        if (templatePayload && !templatePayload.ok) {
          json(res, templatePayload.status ?? 422, {
            ok: false,
            error: templatePayload.error,
            message: templatePayload.message,
            missing: templatePayload.missing ?? undefined,
          });
          return;
        }

        const sendResult = template
          ? await ctx.whatsapp.sendTemplate(customer.phone_e164, {
              name: template.name,
              language: template.language ?? 'es',
              components: templatePayload.components,
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
            body: template ? templatePayload.body : messageBody,
            template: template?.name ?? null,
            status: 'failed',
            error: sendResult.error ?? { message: sendResult.reason ?? 'error' },
            idempotencyKey: text(body.idempotencyKey, 120),
            // A quién iba también cuando falla: es lo primero que se mira al
            // investigar un «no le llegó».
            meta: { phoneNumberId: ctx.whatsapp.phoneNumberId, to: customer.phone_e164 || null },
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
          body: template ? templatePayload.body : messageBody,
          template: template?.name ?? null,
          waMessageId: sendResult.messageId ?? null,
          status: 'sent',
          idempotencyKey: text(body.idempotencyKey, 120),
          // Solo datos públicos del envío: nunca el token ni la cabecera. El
          // destinatario se guarda para poder auditar a quién salió de verdad.
          meta: template
            ? {
                phoneNumberId: ctx.whatsapp.phoneNumberId,
                to: customer.phone_e164 || null,
                template: template.name,
                language: template.language ?? 'es',
              }
            : { phoneNumberId: ctx.whatsapp.phoneNumberId, to: customer.phone_e164 || null },
          ...messageActorFields(actor),
        });
        let deliveryOrder = null;
        if (deliveryOrderContext) {
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
      /*
       * BLINDADO: un agente no ve los seguimientos de un cliente cuya conversación
       * no lleva él (eran visibles para todo el equipo, con el nombre del cliente y
       * el motivo de la tarea). Administración los sigue viendo todos.
       */
      const acceso = await conversationAccess(ctx, actor);
      const soloMios = (rows) =>
        acceso.all
          ? rows
          : rows.filter((row) => acceso.customerIds.has(row.customer_id) || row.assigned_user_id === actor?.id);
      json(res, 200, {
        ok: true,
        reference: buckets.reference,
        today: withCustomer(soloMios(buckets.today), customers),
        overdue: withCustomer(soloMios(buckets.overdue), customers),
        upcoming: withCustomer(soloMios(buckets.upcoming), customers),
        completed: withCustomer(soloMios(buckets.completed.slice(-30)), customers),
        cancelled: withCustomer(soloMios(buckets.cancelled.slice(-30)), customers),
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
      // Un seguimiento es trabajo de alguien: solo lo crea quien lleva ese cliente.
      if (!(await canWorkWithCustomer(ctx, actor, customer.id))) {
        json(res, 403, {
          ok: false,
          error: 'not_your_customer',
          message: 'Ese cliente no está asignado a ti: pide que te lo asignen para programarle seguimientos.',
        });
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
      // Decidir una tarea (completar, posponer…) es de quien lleva ese cliente.
      if (!(await canWorkWithCustomer(ctx, actor, current.customer_id))) {
        json(res, 403, {
          ok: false,
          error: 'not_your_customer',
          message: 'Ese seguimiento es de un cliente que no llevas tú.',
        });
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
      const sync = url.searchParams.get('sync');
      if (sync === '1' || sync === 'true' || sync === 'stale') await syncWaTemplatesIfStale(ctx);
      json(res, 200, { ok: true, templates: await listWaTemplates(ctx) });
      return;
    }

    if (route === '/api/admin/wa-templates/sync' && req.method === 'POST') {
      if (!requirePermission('settings.manage')) return;
      const result = await syncWhatsAppTemplatesFromMeta(ctx);
      if (!result.ok) {
        json(res, 502, {
          ok: false,
          error: result.error ?? 'meta_sync_failed',
          message: result.detail?.message ?? result.message ?? 'No se pudo consultar Meta. Revisa la configuración de WhatsApp.',
          detail: result.detail ?? null,
        });
        return;
      }
      json(res, 200, { ok: true, sync: result, templates: await listWaTemplates(ctx) });
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
      const status = normalizeTemplateStatus(text(body.status, 30) ?? 'PENDING');
      const existing = await ctx.db.findBy('wa_templates', 'name', name);
      const doc = {
        id: existing?.id ?? `tpl_${name}`,
        name,
        friendly_name: text(body.friendlyName ?? body.friendly_name, 80) ?? existing?.friendly_name ?? name,
        group: text(body.group, 30) ?? existing?.group ?? 'OTRAS',
        category: text(body.category, 30) ?? existing?.category ?? 'MARKETING',
        language: text(body.language, 10) ?? existing?.language ?? 'es',
        body: longText(body.body, 1024) ?? existing?.body ?? null,
        variables: Array.isArray(body.variables) ? body.variables.slice(0, 10) : existing?.variables ?? [],
        buttons: Array.isArray(body.buttons) ? body.buttons.slice(0, 5) : existing?.buttons ?? [],
        // La cabecera solo puede venir de Meta (o de la semilla): aquí no se inventa.
        header: body.header && typeof body.header === 'object' ? body.header : existing?.header ?? null,
        components: Array.isArray(body.components) ? body.components : existing?.components ?? [],
        required_context: text(body.requiredContext ?? body.required_context, 30) ?? existing?.required_context ?? 'none',
        status,
        sendable: templateSendable(status),
        // Identificador y fecha que solo pueden venir de Meta (los rellena el
        // negocio a mano tras registrarla allí). Aquí nunca se inventan.
        meta_template_id: text(body.metaTemplateId, 80) ?? existing?.meta_template_id ?? null,
        last_synced_at: text(body.lastSyncedAt, 40) ?? existing?.last_synced_at ?? null,
        last_template_sync_at: text(body.lastTemplateSyncAt, 40) ?? existing?.last_template_sync_at ?? null,
        quality_score: body.qualityScore ?? body.quality_score ?? existing?.quality_score ?? null,
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
    /*
     * QUÉ SE PROPONE PROGRAMAR para este cliente.
     *
     * Lo decide el SERVIDOR (una sola fuente de verdad, la misma que usará el
     * envío) y el panel solo lo enseña. Con compra entregada → seguimiento de
     * compra; sin ella → seguimiento de interés. El mensaje sugerido va calculado
     * y el agente puede dejarlo, editarlo o reemplazarlo.
     */
    if (route === '/api/admin/scheduled/suggestion' && req.method === 'GET') {
      const customerId = text(url.searchParams.get('customerId'), 80);
      const customer = customerId ? await ctx.customers.get(customerId) : null;
      if (!customer) {
        json(res, 404, { ok: false, error: 'unknown_customer', message: 'No encontramos ese cliente.' });
        return;
      }
      const pedidos = (await ctx.store.listAdmin({ limit: 5000 })).filter(
        (item) => item.type === 'order_intent' && item.customer_id === customer.id,
      );
      const suggestion = suggestScheduledMessage({ customer, orders: pedidos });
      const plantillas = await Promise.all(
        [PURCHASE_FOLLOWUP_TEMPLATE, INTEREST_FOLLOWUP_TEMPLATE].map(async (name) => {
          const check = await approvedTemplate(ctx, name);
          const known = await ctx.db.findBy('wa_templates', 'name', name);
          return {
            name,
            friendly_name: known?.friendly_name ?? null,
            ready: check.ok === true,
            status: known?.status ?? 'desconocida',
          };
        }),
      );
      json(res, 200, {
        ok: true,
        customer: { id: customer.id, name: customer.name ?? null, phone_e164: customer.phone_e164 ?? null },
        suggestion,
        templates: {
          purchase: plantillas.find((row) => row.name === PURCHASE_FOLLOWUP_TEMPLATE) ?? null,
          interest: plantillas.find((row) => row.name === INTEREST_FOLLOWUP_TEMPLATE) ?? null,
        },
        timeZone: TIME_ZONE,
      });
      return;
    }

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
        json(res, 422, { ok: false, error: 'unknown_customer', message: 'No encontramos ese cliente.' });
        return;
      }
      /*
       * LA CONVERSACIÓN TIENE QUE SER DE ESTE CLIENTE.
       *
       * Un mensaje programado se guarda con su cliente y su conversación, y al
       * llegar la hora se envía al teléfono de ESE cliente. Si el panel manda una
       * conversación que no es suya (una pestaña vieja, un id cambiado), se corta
       * aquí: nunca se cruzan datos entre clientes.
       */
      const conversationId = text(body.conversationId, 80);
      if (conversationId) {
        const conversacion = await ctx.db.get('conversations', conversationId);
        if (!conversacion) {
          json(res, 404, { ok: false, error: 'unknown_conversation', message: 'Esa conversación ya no existe.' });
          return;
        }
        if (conversacion.customer_id !== customer.id) {
          json(res, 409, {
            ok: false,
            error: 'conversation_mismatch',
            message: 'Esa conversación es de otro cliente: el mensaje NO se ha programado.',
          });
          return;
        }
      }
      const tipo = body.type === 'template' ? 'template' : 'text';
      /** @type {any} */
      let congelado = {};
      if (tipo === 'template') {
        const templateName = text(body.template, 60);
        /*
         * SOLO PLANTILLAS APROBADAS. Programar con una plantilla que Meta todavía
         * no ha aprobado sería prometer un envío que no va a salir: se dice claro
         * y no se guarda nada. (El envío vuelve a comprobarlo: si Meta la retira
         * entre programar y enviar, el mensaje queda BLOQUEADO, nunca se fuerza.)
         */
        const check = templateName ? await approvedTemplate(ctx, templateName) : { ok: false, reason: 'unknown_template' };
        if (!check.ok) {
          json(res, 409, {
            ok: false,
            error: check.reason === 'unknown_template' ? 'unknown_template' : 'template_not_approved',
            message:
              check.reason === 'unknown_template'
                ? 'Esa plantilla no existe en el CRM.'
                : `La plantilla «${templateName}» todavía no está aprobada en Meta: hasta que lo esté no se puede programar un mensaje con ella.`,
            template: check.template ?? null,
          });
          return;
        }
        /*
         * EL CONTENIDO SE CONGELA AQUÍ. Lo que el agente ve y aprueba al programar
         * es EXACTAMENTE lo que se enviará cuando llegue la hora: los parámetros y
         * el texto final quedan guardados. Nada se regenera después (si la compra
         * cambia, este mensaje NO cambia).
         */
        const payload = await resolveTemplatePayload(ctx, {
          template: check.template,
          customer,
          conversation: conversationId ? { id: conversationId } : null,
          orderId: text(body.orderId ?? body.order_id, 80),
          provided:
            body.templateValues && typeof body.templateValues === 'object' && !Array.isArray(body.templateValues)
              ? body.templateValues
              : null,
        });
        if (!payload.ok) {
          json(res, payload.status ?? 422, {
            ok: false,
            error: payload.error,
            message: payload.message,
            missing: payload.missing ?? undefined,
          });
          return;
        }
        congelado = {
          templateComponents: payload.components,
          templateBody: payload.body,
          templateLanguage: check.template.language ?? 'es',
        };
      }
      const result = await ctx.scheduler.schedule({
        customerId: customer.id,
        conversationId,
        orderId: text(body.orderId, 80) ?? null,
        scheduledAt: body.scheduledAt,
        type: tipo,
        text: body.text,
        template: body.template,
        timeZone: text(body.timeZone, 60) ?? TIME_ZONE,
        createdBy: actor?.display_name ?? 'panel',
        scheduledByUserId: actor?.actor_type === 'USER' ? actor.id : null,
        idempotencyKey: text(body.idempotencyKey, 120) ?? null,
        ...congelado,
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
 * @param {string} [config.androidApkPath] APK local para descarga desde el panel
 * @param {string} [config.androidApkUrl] URL de storage/CDN del APK publicado
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
    androidApkPath: path.resolve(config.androidApkPath ?? ANDROID_APK_PATH),
    androidApkUrl: config.androidApkUrl ?? ANDROID_APK_URL,
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
  /**
   * Aviso en vivo del chat: el servicio de clientes llama a este gancho cuando
   * guarda un mensaje. Se resuelve por referencia diferida porque `ctx` se crea
   * después del servicio.
   */
  /** @type {{ current: ((info: any) => void)|null }} */
  const chatEventsRef = { current: null };
  const customers = createCustomerService({
    db,
    store,
    followups,
    timeZone: TIME_ZONE,
    clock: config.clock,
    // Aviso EN VIVO al panel (SSE) de cada mensaje guardado.
    onMessage: (info) => chatEventsRef.current?.(info),
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
    deliveryControlTick: () => deliveryControlTick(ctxRef.current),
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
    androidApk: { path: settings.androidApkPath, url: settings.androidApkUrl },
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
    /*
     * Sesiones que escuchan el chat EN VIVO (SSE). Vive en MEMORIA del proceso:
     * hay UNA instancia de Node (nginx y Node en el mismo contenedor), así que no
     * hace falta un bus compartido tipo Redis. Si algún día hubiera varias
     * instancias, este es el único sitio que habría que cambiar.
     */
    chatEventClients: new Set(),
    timeZone: TIME_ZONE,
    clock: config.clock ?? (() => new Date()),
  };
  ctxRef.current = ctx;
  chatEventsRef.current = (info) => emitChatEvent(ctx, info);

  /**
   * Quién firma una petición de multimedia: la MISMA sesión que el resto del panel
   * (cookie de usuario o la clave vieja, que equivale a administración). Sirve para
   * aplicar a los archivos la misma regla que al texto: sin la conversación
   * asignada no se manda nada.
   */
  async function mediaActorFromRequest(req) {
    if (!req) return null;
    const value = readCookie(req, COOKIE);
    const session = parseUserSessionValue(value, settings.token);
    const identity = session ? await users.sessionUser(session.sessionId) : null;
    if (identity?.user) {
      return {
        id: identity.user.id,
        role: identity.user.role,
        display_name: identity.user.display_name,
        actor_type: 'USER',
      };
    }
    return sessionValid(value, settings.token)
      ? { id: 'LEGACY_PANEL', role: 'ADMIN', display_name: 'Panel legacy', actor_type: 'LEGACY' }
      : null;
  }

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
          resolveConversation: async (conversationId, req = null) => {
            const conversation = await findConversation(ctx, conversationId);
            if (!conversation) return null;
            /*
             * La MISMA regla que el texto: sin la conversación asignada no se manda
             * ni una foto ni un audio. Se resuelve como «no existe» para no dar
             * pistas de lo ajeno, pero no se envía nada.
             */
            if (!(await canOpenConversation(ctx, mediaActorFromRequest(req), conversation))) return null;
            const customer = await ctx.customers.get(conversation.customer_id);
            return customer ? { conversation, customer } : null;
          },
          persistOutbound: async (input) => {
            const mediaActor = mediaActorFromRequest(input.req);
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
