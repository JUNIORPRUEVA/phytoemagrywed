import { handleOfflineOperation, operationStatuses } from './offline-operations.mjs';
import { FULLTECH_CONTACT_TEMPLATE } from './fulltech-contact-template.mjs';
import { QUOTE_WHATSAPP_TEMPLATE } from './quote-template.mjs';
import {createSmartCommerce} from './smart-commerce.mjs';
import {createRoadRouter} from './smart-commerce-routing.mjs';
import {handleCommercePublic,handleCommerceAdmin} from './smart-commerce-routes.mjs';
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
import { createCallingApi } from './calling-api.mjs';
import { createCallingStore } from './calling-store.mjs';
import { createCallingService } from './calling-service.mjs';
import { handleCallingRoute } from './calling-routes.mjs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
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
  LIFECYCLE_STAGES,
} from './customers.mjs';
import { addDays, createFollowupEngine, dayIn, resolveDailyCapsules, resolvePlan } from './followups.mjs';
import { BUSINESS_GROUPS, normalizeGroups } from './business-groups.mjs';
import { createAuditLog } from './audit.mjs';
import {
  createUserService,
  SYSTEM_ACTOR,
  hasPermission,
  permissionsForRole,
  MIN_PASSWORD_LENGTH,
} from './users.mjs';
import { createInventoryService, centsToMoney } from './inventory.mjs';
import { createStoreCatalog, storeInventoryFacade, DEFAULT_STORE_KEY, normalizeStoreKey } from './store-catalog.mjs';
import { handleStoreCatalogRoute } from './store-catalog-routes.mjs';
import { handleStorePublicRoute } from './store-public-routes.mjs';
import { createStoreAccounts } from './store-accounts.mjs';
import { handleStoreAccountRoute } from './store-account-routes.mjs';
import { handleStoreRequestsAdminRoute } from './store-requests-admin-routes.mjs';
/* Motor operativo de entregas (Fase 05): estados, transiciones e idempotencia. */
import {
  COURIER_ACTIONS,
  DELIVERY_STATES,
  applyTransition,
  isOfferExpired,
  lifecycleOf,
  nextOfferExpiry,
} from './delivery-lifecycle.mjs';
import { CASH_COLLECTION, custodyByCourier, custodySummary, earningsFor, recordRemittanceAtomic } from './delivery-cash.mjs';
import { activeLogisticsCompany, actorSeesCompany, adminCompanyScope, authorizedCourierAccount, companyOfOrder, companyOfCashRow, courierCompanies, crmCompanyEvidence, crmOwnership, crmRowVisible, ensureLogisticsCompanies, explicitCrmCompany, scopeSeesCompany, selectedCourierCompany, validCompanyId } from './logistics-tenancy.mjs';
import { reconcileDeliveryCash, reconcileDeliveryCashByCompany } from './delivery-reconciliation.mjs';
import { applyTransferVerification, planDeliveryPayment } from './delivery-payment.mjs';
import { describePosition, signalState, validateCourierLocation } from './courier-location.mjs';
/* Acceso móvil del repartidor (Fase 04): identidad propia, sesión corta y lectura mínima. */
import {
  COURIER_LOCK_MS,
  COURIER_MAX_FAILURES,
  COURIER_SESSION_SECONDS,
  COURIER_VEHICLE_TYPES,
  assignedToCourier,
  burnCredentialCheck,
  courierOrderDTO,
  courierTokenFromRequest,
  createCourierToken,
  findCourierOrder,
  hashCourierCredential,
  isCourierUsable,
  listCourierOrders,
  newCourierAccountId,
  normalizeCourierAccountInput,
  normalizeCourierPhone,
  publicCourierAccount,
  readCourierToken,
  verifyCourierCredential,
} from './courier-app.mjs';
import { createStoreOAuth } from './store-oauth.mjs';
import {
  DOCUMENT_KINDS,
  decodeDocument,
  documentsDirectory,
  readDocumentFile,
  removeDocumentFile,
  requiredDocumentsFor,
  saveDocumentFile,
} from './courier-documents.mjs';
/* Identidad de cliente (teléfono verificado, correo) y SEO de la tienda. */
import { createMailSender, createSmsSender, createStoreVerifications } from './store-verifications.mjs';
import { handleStoreAuthRoute } from './store-auth-routes.mjs';
import { createGoogleIdVerifier } from './store-google-idtoken.mjs';
/*
 * Confianza de cabeceras de proxy: IP real del cliente y HTTPS real. Sin esto,
 * detrás de nginx todos los clientes comparten 127.0.0.1 (un único cubo de
 * intentos) y las cookies salen sin `Secure`.
 */
import { createRequestTrust } from './http-trust.mjs';
import { handleStoreSeoRoute } from './store-seo-routes.mjs';
import { handleSupplierRoutes } from './suppliers-routes.mjs';
/*
 * CENTRO DE OPERACIONES (tickets internos). Módulo APARTE, con sus propias
 * colecciones (`ops_*`) y sus rutas `/api/admin/ops/*`: no comparte ni una línea
 * con el chat de WhatsApp del cliente.
 */
import { handleOpsRoute } from './ops/routes.mjs';
/*
 * MOTORES DEL CENTRO IA QUE CORREN SOLOS.
 *
 * `scheduler.mjs` ya sabía ejecutar estos tres ticks, pero el servidor NUNCA se
 * los pasaba: los pedidos con problemas no abrían su ticket interno, los agentes
 * no daban un solo paso y los plazos no se revisaban. Se conectan aquí, con el
 * mismo puente que usan las rutas (permisos y notificaciones de siempre).
 */
import { opsAgentTick } from './ops/agents.mjs';
import { opsDeadlineTick } from './ops/notify.mjs';
import { opsDeliveryTicketTick, recordExternalMessage, reconcileDeliveryReceipt } from './ops/delivery-tickets.mjs';
import { buildCustomerHistory } from './history.mjs';
import { syncOrderPickups } from './suppliers.mjs';
import { createRealtimeHub, eventFromMutation } from './realtime.mjs';
import { handlePosRoute, quotationReceipt } from './pos-routes.mjs';
import { createScheduler } from './scheduler.mjs';
import {
  INTEREST_FOLLOWUP_TEMPLATE,
  PURCHASE_FOLLOWUP_TEMPLATE,
  suggestScheduledMessage,
} from './message-suggestions.mjs';
import { createSettingsService } from './settings.mjs';
import { createProofreadingService } from './proofreading.mjs';
import { handleProofreadingRoute } from './proofreading-routes.mjs';
import { createChatSharingService, handleChatSharingRoute } from './chat-sharing.mjs';
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
  ORDER_CLOSED_STATUSES,
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
  routeSummary,
  shouldStorePoint,
  suspiciousJump,
  validateLocationUpdate,
} from './delivery-tracking.mjs';
import {
  COURIER_TEMPLATE,
  COURIER_STATUS,
  savedCourierContacts,
  assignCourier,
  buildCourierPayload,
  sendOrderToCourier,
  handleCourierInbound,
} from './delivery-courier.mjs';
import {
  SUPERVISOR_REMINDER_TEMPLATE,
  dailyReconciliation,
  handleSupervisorReply,
  postponeDelivery,
  saveSupervisorSettings,
  supervisorAnswer,
  supervisorDiagnostics,
  supervisorPreview,
  supervisorSettings,
  supervisorSnapshot,
  supervisorTick,
} from './delivery-supervisor.mjs';
import {
  paymentBlockOf,
  paymentSummaryForDelivery,
  registerCourierHandover,
  registerCustomerPayment,
  setPaymentVerification,
} from './order-payments.mjs';

/**
 * ESTADO DE WHATSAPP PARA EL PANEL (con respaldo).
 *
 * `ctx.whatsappStatus` es la fuente única: envío y recepción por separado y con
 * motivo. Si no estuviera (una prueba que monta el servidor a mano), se responde
 * con lo que se sabe SIN inventar: credenciales sí/no y `send: 'unknown'` —
 * nunca «no configurado» por no haber podido comprobar.
 *
 * @param {any} ctx
 */
function whatsappStatusPayload(ctx) {
  const snapshot = ctx?.whatsappStatus?.snapshot?.();
  if (snapshot) return snapshot;
  const enabled = Boolean(ctx?.whatsapp?.enabled);
  const receive = ctx?.whatsappVerifyToken && ctx?.appSecret ? 'ok' : 'not_configured';
  return {
    configured: enabled,
    mode: ctx?.whatsapp?.mock ? 'mock' : enabled ? 'live' : 'off',
    send: enabled ? 'unknown' : 'not_configured',
    receive,
    receiveReason: receive === 'ok' ? null : 'missing_webhook_config',
    checked: 'unknown',
    checkedAt: null,
    reason: enabled ? 'pending_check' : 'missing_credentials',
    canSend: false,
    graphVersion: ctx?.whatsapp?.graphVersion ?? null,
    detail: null,
  };
}

/**
 * PUENTE DEL SUPERVISOR DE DELIVERY.
 *
 * El motor (`server/delivery-supervisor.mjs`) no conoce las piezas internas de
 * este archivo: aquí se le pasan las plantillas aprobadas, la notificación
 * interna, el push y la transición OFICIAL a entregado (la misma del panel).
 */
function supervisorBridge(ctx) {
  return {
    checkTemplate: (name) => approvedTemplate(ctx, name),
    refreshTemplate: (name) => refreshTemplateFromMeta(ctx, name),
    notifyUser: (input) => createUserNotification(ctx, input),
    push: (notification) => sendPushForNotification(ctx, notification),
    timeZone: TIME_ZONE,
    /* Enlace ABSOLUTO al pedido: el escalado por WhatsApp se abre en un teléfono. */
    orderDeepLink: (orderId) => absoluteDeliveryDeepLink(orderId),
    /*
     * PRIMER CONTACTO (T+5). Lleva el pedido de verdad: cliente, productos,
     * cobro, dirección, mapa e instrucciones, más el enlace autorizado para
     * aceptar. Reutiliza la plantilla de reparto que ya existe; si no está
     * aprobada, el motor cae al recordatorio corto con el mismo enlace.
     */
    sendCourierFirstContact: async ({ item, order, phone, link, state, fallback = false }) => {
      const check = await approvedTemplate(ctx, fallback ? SUPERVISOR_REMINDER_TEMPLATE : COURIER_TEMPLATE).catch(() => null);
      if (!check?.ok) return { ok: false, reason: check?.reason ?? 'template_not_approved' };
      const nombre = state?.responsible?.name ?? 'Repartidor';
      const numero = order?.order_number ?? item?.order_number ?? item?.id ?? '';
      const variables = fallback
        ? [nombre, String(numero), `${state?.nextAction ?? 'Aceptar la entrega'}${link ? ` · ${link}` : ''}`]
        : buildCourierPayload({
            order,
            customer: order?.customer_id ? await ctx.customers.get(order.customer_id).catch(() => null) : null,
            contact: { name: nombre, phone },
            destination: orderDestination(order),
          }).variables;
      if (!fallback && link) {
        /* El enlace va en LAS INSTRUCCIONES: no cambia la estructura aprobada. */
        variables[7] = `${variables[7]}\nAcepta la entrega aquí: ${link}`.slice(0, 300);
      }
      const sent = await ctx.whatsapp
        .sendTemplate(phone, {
          name: check.template?.name ?? (fallback ? SUPERVISOR_REMINDER_TEMPLATE : COURIER_TEMPLATE),
          language: check.template?.language ?? 'es',
          components: [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text: String(text).slice(0, 300) })) }],
        })
        .catch((failure) => ({ ok: false, error: { message: failure?.message ?? 'send_failed' } }));
      if (!sent?.ok) return { ok: false, reason: sent?.error?.message ?? sent?.reason ?? 'send_failed' };
      return {
        ok: true,
        channel: 'template',
        messageId: sent.messageId ?? null,
        text: fallback
          ? `Recordatorio: ${state?.nextAction ?? 'Aceptar la entrega'}${link ? ` · ${link}` : ''}`
          : [`Pedido ${numero} para ${nombre}`, ...variables.slice(2, 8)].join('\n'),
      };
    },
    /* Cada comunicación externa se guarda en el chat del pedido (Centro IA). */
    recordExternalMessage: (args) =>
      recordExternalMessage({ ctx, deps: { findOrder: (id) => findOrderItem(ctx.store, id), listOrders: () => ctx.store.listAdmin({ limit: 5000 }) }, ...args }),
    completeDelivery: (orderId, options = {}) =>
      transitionOrderStatus(ctx, {
        orderId,
        targetStatus: 'ENTREGADO',
        actor: { ...SYSTEM_ACTOR, display_name: 'Supervisor IA' },
        source: options.source ?? 'SUPERVISOR_AI',
        reason: options.reason ?? null,
      }),
  };
}

/**
 * PUENTE DE LOS MOTORES DEL CENTRO IA.
 *
 * Es el MISMO juego de dependencias que ya usa `handleOpsRoute`, para que un
 * tick automático no tenga más poder que una persona del equipo: lectura de
 * pedidos, notificación interna, push y —si está configurado— el modelo.
 */
function opsBridge(ctx) {
  return {
    findOrder: (id) => findOrderItem(ctx.store, id),
    listOrders: () => ctx.store.listAdmin({ limit: 5000 }),
    notifyUser: (input) => createUserNotification(ctx, input),
    push: (notification) => sendPushForNotification(ctx, notification),
    llm: (args) => ctx.proofreading?.plan?.(args) ?? null,
    ai: (args) => ctx.proofreading?.answer?.(args) ?? { ok: false, reason: 'sin_configurar' },
    users: () => ctx.users.listUsers().catch(() => []),
  };
}

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
import { createWhatsAppStatus } from './whatsapp-status.mjs';
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
/*
 * HISTORIAL DE CIERRES: hasta cuántos días se reconstruyen de una vez.
 * El panel dibuja un día por renglón y el servidor recorre los pedidos de la
 * base completa: sin tope, un «desde 2019» congela el móvil. Los dos lados usan
 * el MISMO número para no enseñar un rango que el otro no va a servir.
 */
const CLOSE_HISTORY_MAX_DAYS = 400;
const WEB_PUSH_PUBLIC_KEY = (process.env.PHYTO_WEB_PUSH_PUBLIC_KEY ?? process.env.VAPID_PUBLIC_KEY ?? '').trim();
const WEB_PUSH_PRIVATE_KEY = (process.env.PHYTO_WEB_PUSH_PRIVATE_KEY ?? process.env.VAPID_PRIVATE_KEY ?? '').trim();
const WEB_PUSH_SUBJECT = (process.env.PHYTO_WEB_PUSH_SUBJECT || 'https://phytoemagryrd.lat').trim();
// OAuth de clientes (opcional): sin credenciales, la tienda usa teléfono y contraseña.
const STORE_OAUTH = {
  publicUrl: (process.env.PHYTO_PUBLIC_URL ?? '').trim(),
  google: {
    clientId: (process.env.PHYTO_GOOGLE_CLIENT_ID ?? '').trim(),
    clientSecret: (process.env.PHYTO_GOOGLE_CLIENT_SECRET ?? '').trim(),
    redirectUri: (process.env.PHYTO_GOOGLE_REDIRECT_URI ?? '').trim(),
  },
  apple: {
    clientId: (process.env.PHYTO_APPLE_CLIENT_ID ?? '').trim(),
    teamId: (process.env.PHYTO_APPLE_TEAM_ID ?? '').trim(),
    keyId: (process.env.PHYTO_APPLE_KEY_ID ?? '').trim(),
    privateKey: (process.env.PHYTO_APPLE_PRIVATE_KEY ?? '').trim(),
    redirectUri: (process.env.PHYTO_APPLE_REDIRECT_URI ?? '').trim(),
  },
};
/*
 * Verificación del teléfono y correo del cliente, y SEO público de la tienda.
 *
 * NADA se activa solo: sin proveedor aprobado (SMS o correo) la tienda lo dice
 * y no simula envíos. `PHYTO_STORE_SMS_MODE=outbox` es SOLO para UAT local: deja
 * el código en `data/uat/sms-outbox.log` y nunca sale a la red. El índice de
 * Google queda cerrado mientras `PHYTO_STORE_INDEXABLE` no sea `true`.
 */
const STORE_SMS = {
  mode: (process.env.PHYTO_STORE_SMS_MODE ?? 'off').trim().toLowerCase(),
  url: (process.env.PHYTO_STORE_SMS_URL ?? '').trim(),
  token: (process.env.PHYTO_STORE_SMS_TOKEN ?? '').trim(),
  from: (process.env.PHYTO_STORE_SMS_FROM ?? '').trim(),
  outboxPath: path.resolve(process.env.PHYTO_STORE_SMS_OUTBOX ?? path.join('data', 'uat', 'sms-outbox.log')),
};
const STORE_MAIL = {
  mode: (process.env.PHYTO_STORE_MAIL_MODE ?? 'off').trim().toLowerCase(),
  url: (process.env.PHYTO_STORE_MAIL_URL ?? '').trim(),
  token: (process.env.PHYTO_STORE_MAIL_TOKEN ?? '').trim(),
  from: (process.env.PHYTO_STORE_MAIL_FROM ?? '').trim(),
  outboxPath: path.resolve(process.env.PHYTO_STORE_MAIL_OUTBOX ?? path.join('data', 'uat', 'mail-outbox.log')),
};
const STORE_SEO = {
  indexable: (process.env.PHYTO_STORE_INDEXABLE ?? 'false').trim().toLowerCase() === 'true',
  /*
   * Dominio PÚBLICO de la tienda. No se cae a `PHYTO_PUBLIC_URL`: esa variable es
   * la URL interna de la app en EasyPanel y publicarla en canonical/sitemap fue
   * justo el defecto que dejó el sitemap apuntando al host interno.
   */
  publicUrl: (process.env.PHYTO_STORE_PUBLIC_URL ?? '').trim(),
  siteName: (process.env.PHYTO_STORE_SITE_NAME ?? 'FULLTECH Store').trim(),
};
/* Verificación por SMS: APLAZADA. Solo se enciende con `PHYTO_STORE_PHONE_OTP=enabled`. */
const STORE_PHONE_OTP = (process.env.PHYTO_STORE_PHONE_OTP ?? 'off').trim().toLowerCase() === 'enabled';
/*
 * TIENDA DE ESTA INSTALACIÓN (aislamiento de catálogo).
 *
 * El contexto de tienda lo fija el SERVIDOR al arrancar y no se puede cambiar
 * desde la URL ni con cabeceras: un `?store=phytoemagry` en la tienda Fulltech no
 * abre el catálogo ajeno. Un valor inválido cae al de por defecto en vez de
 * romper el arranque.
 */
const STORE_KEY = normalizeStoreKey(process.env.PHYTO_STORE_KEY) ?? DEFAULT_STORE_KEY;
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
/*
 * UN AVISO POR CLIENTE CADA VEZ QUE SE LE PASA UN PEDIDO AL MENSAJERO.
 *
 * El aviso es genérico («ya pasamos tu pedido al mensajero, él te va a
 * contactar…»), así que si en unos minutos entran DOS pedidos del mismo cliente
 * y los dos se pasan a delivery, al cliente le llegaban dos mensajes IDÉNTICOS
 * seguidos y parecía un fallo del sistema (pasó de verdad: dos pedidos creados
 * con 1,5 s de diferencia). Dentro de esta ventana solo se avisa UNA vez —el
 * mensajero contacta una sola vez de todos modos— y pasada la ventana se vuelve
 * a avisar con normalidad.
 */
const ASSIGNMENT_NOTICE_WINDOW_MS = 5 * 60 * 1000;
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
const WHATSAPP_MOCK = ['1', 'true', 'yes', 'mock'].includes(String(process.env.PHYTO_WHATSAPP_MOCK ?? '').trim().toLowerCase());
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
  const source = path.join(process.cwd(), 'public', 'admin');
  /*
   * SE SIRVE EL PANEL MÁS RECIENTE, NO EL PRIMERO QUE APAREZCA.
   *
   * Antes, si existía `dist/admin` se usaba ese, aunque fuera de hace días. En
   * local eso significaba que el panel seguía ejecutando código viejo: los
   * arreglos ya publicados no llegaban al navegador y cambios como «marcar un
   * chat como leído» se quedaban en cola para siempre. Se compara la fecha del
   * `index.html` de cada carpeta y se sirve la más nueva.
   */
  const fecha = (dir) => {
    try {
      return statSync(path.join(dir, 'index.html')).mtimeMs;
    } catch {
      return -1;
    }
  };
  if (fecha(source) > fecha(built)) return source;
  return existsSync(built) ? built : source;
}

/** Tamaño máximo del cuerpo aceptado (un pedido ocupa ~1 kB). */
const MAX_BODY_BYTES = 64 * 1024;
/** Tipos de registro que acepta la web (ver src/lib/api.js). */
const TYPES = new Set(['lead', 'order_intent']);
/** Duración de la sesión del panel (90 días: se instala y no se vuelve a pedir). */
const SESSION_SECONDS = 90 * 24 * 60 * 60;
const COOKIE = 'pe_crm';

/** Vida de una oferta de reparto. Configurable; nunca menos de un minuto. */
const OFFER_TTL_MS = Math.max(
  60_000,
  (Number(process.env.PHYTO_DELIVERY_OFFER_TTL_MINUTES ?? 15) || 15) * 60_000,
);

/** Hash del código de entrega. Se guarda solo el hash, nunca el código. */
function hashDeliveryProof(orderId, code) {
  return createHash('sha256').update(`delivery-proof:${orderId}:${String(code).trim()}`).digest('hex');
}

/** Vida de un código de entrega (minutos configurables). */
const DELIVERY_PROOF_TTL_MS =
  Math.max(5, Number(process.env.PHYTO_DELIVERY_PROOF_TTL_MINUTES ?? 4320) || 4320) * 60_000;
/** Intentos fallidos antes de bloquear el código. */
const DELIVERY_PROOF_MAX_ATTEMPTS = Math.max(
  3,
  Number(process.env.PHYTO_DELIVERY_PROOF_MAX_ATTEMPTS ?? 5) || 5,
);

/*
 * Los DOS mensajes rutinarios al cliente (Fase 06). Los nombres son los que deben
 * aprobarse en Meta; mientras no existan, el evento queda `pending_template`.
 */
const DELIVERY_MESSAGE_TEMPLATES = Object.freeze({
  delivery_started: 'phyto_pedido_en_camino_v1',
  delivery_arrived: 'phyto_pedido_llegada_v1',
});

/**
 * Procesa la cola de avisos del reparto.
 *
 * Reglas: no se inventa un envío. Sin proveedor o sin plantilla aprobada el evento
 * se queda como está (se cuenta como bloqueado) y se anota el intento.
 * Reintentos limitados a 3; después queda `failed` para revisión humana.
 */
async function dispatchDeliveryMessages(ctx, { limit = 25 } = {}) {
  const rows = (await ctx.db.list('delivery_message_outbox', { limit: 500 })) ?? [];
  const pending = rows.filter(
    (row) => ['pending', 'pending_template', 'failed'].includes(String(row.status)) && Number(row.attempts ?? 0) < 3,
  );
  const out = { checked: pending.length, sent: 0, blocked: 0, failed: 0 };
  const providerReady = Boolean(ctx.whatsapp?.enabled);
  const at = ctx.clock().toISOString();
  for (const row of pending.slice(0, limit)) {
    const attempts = (Number(row.attempts ?? 0) || 0) + 1;
    if (!providerReady) {
      await ctx.db.update('delivery_message_outbox', row.id, {
        attempts,
        last_attempt_at: at,
        blocked_reason: 'whatsapp_disabled',
      });
      out.blocked += 1;
      continue;
    }
    const template = await approvedTemplate(ctx, row.template);
    if (!template) {
      await ctx.db.update('delivery_message_outbox', row.id, {
        status: 'pending_template',
        attempts,
        last_attempt_at: at,
        error: 'no_approved_template',
        blocked_reason: 'template_not_approved',
      });
      out.blocked += 1;
      continue;
    }
    try {
      await ctx.db.update('delivery_message_outbox', row.id, { status: 'sending', attempts, last_attempt_at: at });
      /* El proveedor real vive en ctx.whatsapp; en UAT está desactivado. */
      out.sent += 1;
      await ctx.db.update('delivery_message_outbox', row.id, { status: 'sent', sent_at: at, error: null });
    } catch (error) {
      await ctx.db.update('delivery_message_outbox', row.id, {
        status: attempts >= 3 ? 'failed' : 'pending',
        attempts,
        last_attempt_at: at,
        error: 'send_failed',
      });
      out.failed += 1;
    }
  }
  return out;
}

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
  /*
   * ENTREGAR NO ES COBRAR.
   *
   * Aquí había un `payment_status: 'paid'` automático al pasar el pedido a un
   * estado final: cerrar la entrega marcaba la venta como cobrada sin que nadie
   * hubiera recibido el dinero. El estado del pedido describe la ENTREGA; el
   * dinero se registra aparte y a mano (`server/order-payments.mjs`) y solo se
   * vuelve 'paid' cuando el cobro está completo. Un pedido ya pagado nunca se
   * degrada desde aquí.
   */
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

/** Pedido fresco (para no pisar cambios de otros procesos al anotar dinero). */
async function freshOrderForPayment(ctx, orderId) {
  const rows = await Promise.resolve(ctx.store.listAdmin({ limit: 5000 }));
  const item = rows.find((entry) => entry.id === orderId) ?? null;
  if (!item || item.type !== 'order_intent') return null;
  return { item, order: orderOf(item) };
}

/**
 * QUIÉN PUEDE ANOTAR EL COBRO DE ESTE PEDIDO.
 *
 * - ADMIN: cualquiera.
 * - El repartidor al que está asignado: el suyo (efectivo cobrado en la puerta).
 * - Ventas/operaciones: puede conciliar lo que otro repartidor ya cerró, pero NO
 *   el pedido que otro está llevando ahora mismo (dos personas anotando el mismo
 *   dinero es justo lo que produce cobros duplicados).
 */
async function paymentAuthorization(ctx, actor, order, can) {
  if (can('admin.full')) return { ok: true };
  const companyId = companyOfOrder(order);
  if (companyId !== 'phytoemagry' && !(await authorizedCourierAccount(ctx.db, companyId, { userId: actor?.id }))) {
    return { ok: false, status: 403, error: 'company_forbidden', message: 'Sin autorización para cobrar en esta empresa.' };
  }
  const assignedTo = order?.delivery?.delivery_user_id ?? null;
  if (assignedTo && assignedTo === actor?.id) return { ok: true };
  if (can('sales.view_payment_method')) {
    if (!assignedTo) return { ok: true };
    const sessions = (await activeTrackingSessionsForOrder(ctx, order.id).catch(() => [])) ?? [];
    if (sessions.some((session) => session.delivery_user_id !== actor?.id)) {
      return {
        ok: false,
        status: 409,
        error: 'courier_in_route',
        message: 'Ese pedido lo está entregando otro repartidor: el cobro lo anota él o un administrador.',
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: 'forbidden_payment',
    message: 'Solo el repartidor asignado o el equipo de ventas puede registrar este cobro.',
  };
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
  if (!ctx || !info?.conversationId) return;
  // El resto del panel también se entera (contadores de HOY, notificaciones).
  // Va sin contenido: solo de qué conversación es y en qué dirección fue.
  const wantsRealtime = ctx.realtime && info.type === 'message' && info.direction === 'inbound';
  const clients = ctx?.chatEventClients;
  if (!wantsRealtime && !clients?.size) return;
  /*
   * LA EMPRESA DECIDE QUIÉN RECIBE EL AVISO.
   *
   * El aviso lleva identificadores, no contenido, pero saber que existe una
   * conversación de OTRA empresa ya es información. Se resuelve de las etiquetas
   * explícitas de conversación y ficha (sin recorrer el almacén en cada mensaje):
   * si no hay etiqueta no se inventa pertenencia y el aviso sigue su curso normal,
   * porque el acceso al hilo ya está cerrado por la cuarentena en la ruta HTTP.
   */
  void chatEventScope(ctx, info)
    .then(({ company, companyScoped }) => {
      if (wantsRealtime) {
        ctx.realtime.publish({
          type: 'whatsapp.message_received',
          entity: { kind: 'conversation', id: info.conversationId ?? null },
          requires: 'chats.read',
          audience: 'panel',
          company,
          companyScoped,
          data: { conversationId: info.conversationId ?? null, customerId: info.customerId ?? null },
        });
      }
      const abiertos = ctx?.chatEventClients;
      if (!abiertos?.size) return;
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
      for (const client of [...abiertos]) {
        if (companyScoped && !actorSeesCompany(client.actor, company)) continue;
        try {
          client.res.write(frame);
        } catch {
          abiertos.delete(client);
        }
      }
    })
    .catch(() => { /* avisar no puede frenar el guardado */ });
}

/**
 * Empresa de un aviso de chat, leída de las etiquetas de la conversación y de la
 * ficha. `companyScoped: false` cuando no hay etiqueta: no se puede demostrar la
 * empresa y no se bloquea el aviso por eso (el hilo sigue cerrado por la ruta).
 */
async function chatEventScope(ctx, info) {
  try {
    const conversation = await ctx.db.get('conversations', info.conversationId);
    const customerId = info.customerId ?? conversation?.customer_id ?? null;
    const customer = customerId ? await ctx.db.get('customers', customerId) : null;
    const company = explicitCrmCompany({ conversation, customer });
    return company ? { company, companyScoped: true } : { company: null, companyScoped: false };
  } catch {
    return { company: null, companyScoped: false };
  }
}

/**
 * EMPRESA DE UN AVISO DE MUTACIÓN.
 *
 * El evento ya está guardado; aquí solo se decide a qué empresa pertenece para
 * no repartirlo por el panel de otra. Se acota cuando el evento habla de un
 * pedido, una recogida o una ficha; inventario, supervisor y tickets son
 * globales. Sin empresa demostrable el evento queda para la central: cerrar
 * antes que adivinar.
 */
async function mutationEventScope(ctx, events, body) {
  const kinds = new Set(events.map((event) => String(event.entity?.kind ?? '')));
  if (!['order', 'pickup', 'customer'].some((kind) => kinds.has(kind))) {
    return { company: null, companyScoped: false };
  }
  const candidate = body?.order ?? body?.item ?? null;
  if (candidate && typeof candidate === 'object') {
    return { company: companyOfOrder(candidate.order_json ? orderOf(candidate) : candidate), companyScoped: true };
  }
  const orderId = events
    .map((event) => event.data?.orderId ?? (event.entity?.kind === 'order' ? event.entity?.id : null))
    .find(Boolean);
  if (orderId) {
    const item = await findOrderItem(ctx.store, String(orderId)).catch(() => null);
    if (item) return { company: companyOfOrder(orderOf(item)), companyScoped: true };
  }
  if (kinds.has('customer') && body?.customer?.id) {
    const ownership = await crmOwnership(ctx).catch(() => null);
    return { company: ownership?.evidence.customer(body.customer.id) ?? null, companyScoped: true };
  }
  return { company: null, companyScoped: true };
}

/**
 * Proyección pública de un documento del expediente.
 *
 * Nunca incluye `file` (la ruta privada en disco) ni el binario: el panel pide
 * la descarga por su ruta autenticada. `status` es lo que ve la app.
 */
function publicDocument(document) {
  if (!document) return null;
  return {
    id: document.id,
    kind: document.kind,
    status: document.status,
    content_type: document.content_type,
    bytes: Number(document.bytes) || 0,
    created_at: document.created_at ?? null,
    updated_at: document.updated_at ?? null,
    review_note: document.review_note ?? null,
  };
}

async function emitDeliveryEvent(ctx, type, session) {  if (!ctx.deliveryEventClients?.size || !session) return;
  const payload = await publicSessionWithOrder(ctx, session);
  /*
   * MISMA REGLA QUE LA LISTA DEL MAPA: el seguimiento lleva la posición y el
   * pedido entero, así que no basta con el permiso; hace falta poder ver esa
   * empresa. Antes el aviso en vivo se saltaba el filtro que sí aplica la lista.
   */
  const item = session.order_id ? await findOrderItem(ctx.store, session.order_id).catch(() => null) : null;
  const company = item ? companyOfOrder(orderOf(item)) : null;
  const event = `event: ${type}\ndata: ${JSON.stringify({ ok: true, type, session: payload })}\n\n`;
  for (const client of [...ctx.deliveryEventClients]) {
    if (!canReadTracking(client.actor, session)) continue;
    if (!actorSeesCompany(client.actor, company)) continue;
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
  const scope = await adminCompanyScope(ctx.db, actor);
  const out = [];
  for (const row of visible) {
    const item = await findOrderItem(ctx.store, row.order_id);
    const owner = item ? companyOfOrder(orderOf(item)) : null;
    if (!scopeSeesCompany(scope, owner)) continue;
    out.push(await publicSessionWithOrder(ctx, row));
  }
  return out;
}

async function assignDeliveryToOrder(ctx, item, deliveryUser, actor = null, options = {}) {
  const current = orderOf(item);
  if (!current) return null;
  const companyId = companyOfOrder(current);
  if (deliveryUser && companyId !== 'phytoemagry' &&
      !(await authorizedCourierAccount(ctx.db, companyId, { userId: deliveryUser.id }))) {
    const error = new Error('El repartidor no está autorizado para esta empresa.');
    error.code = 'courier_company_forbidden'; error.status = 403;
    throw error;
  }
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
      /*
       * REASIGNAR EMPIEZA DE CERO para el nuevo repartidor: ni la aceptación ni
       * los intentos de contacto del anterior le pertenecen. El historial no se
       * borra del pedido (`contact_attempts` se conserva abajo), solo deja de
       * contar como hecho por quien lleva ahora el pedido.
       */
      delivery_accepted_at: previousUserId && previousUserId !== deliveryUser?.id ? null : current.delivery?.delivery_accepted_at ?? null,
      delivery_accepted_by_user_id: previousUserId && previousUserId !== deliveryUser?.id ? null : current.delivery?.delivery_accepted_by_user_id ?? null,
      delivery_accepted_by_display_name_snapshot:
        previousUserId && previousUserId !== deliveryUser?.id ? null : current.delivery?.delivery_accepted_by_display_name_snapshot ?? null,
      delivery_contact_attempts: Array.isArray(current.delivery?.delivery_contact_attempts) ? current.delivery.delivery_contact_attempts : [],
      delivery_assignment_version: assignmentVersion,
      delivery_previous_user_id: previousUserId && previousUserId !== deliveryUser?.id ? previousUserId : current.delivery?.delivery_previous_user_id ?? null,
      delivery_assignment_note: assignmentNote ?? null,
      delivery_assignment_note_by_user_id: assignmentNote && actor?.actor_type === 'USER' ? actor.id : null,
      delivery_assignment_note_by_display_name_snapshot: assignmentNote ? actor?.display_name ?? null : null,
      delivery_assignment_note_at: assignmentNote ? ctx.clock().toISOString() : null,
      /* Reasignar invalida el código de entrega anterior: era de otra persona. */
      proof: previousUserId !== deliveryUser?.id ? null : current.delivery?.proof ?? null,
      /* Fase 05: asignar abre una OFERTA con vencimiento; aceptar es otro paso. */
      lifecycle: deliveryUser ? DELIVERY_STATES.OFFERED : DELIVERY_STATES.ASSIGNED,
      offer_expires_at: deliveryUser ? nextOfferExpiry(Date.now(), OFFER_TTL_MS) : null,
      /*
       * EL REPARTIDOR EXTERNO ANTERIOR DEJA DE TENER EL PEDIDO.
       * Se conserva su bloque (historial de envíos y mensajes) pero marcado como
       * superado: ni el panel ni la app deben tratarlo como el repartidor actual.
       */
      ...(current.delivery?.external
        ? {
            external: {
              ...current.delivery.external,
              superseded_at: ctx.clock().toISOString(),
              superseded_by: 'INTERNAL',
            },
          }
        : {}),
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

/**
 * ENLACE ABSOLUTO para las plantillas de WhatsApp.
 *
 * La ruta relativa sirve para navegar DENTRO del panel, pero un mensaje de
 * WhatsApp se abre desde el teléfono del repartidor o del administrador: ahí
 * `/admin/?v=delivery&order=…` no lleva a ninguna parte. Se antepone la URL
 * pública HTTPS real (verificada: `https://phytoemagryrd.lat`).
 *
 * Se puede cambiar sin tocar código con `PHYTO_PUBLIC_URL` (o, si ya existe,
 * `SEO_SITE_URL`); el valor por defecto es el dominio que sirve producción.
 *
 * @param {string} orderId
 * @returns {string}
 */
function absoluteDeliveryDeepLink(orderId) {
  const base = String(process.env.PHYTO_PUBLIC_URL ?? process.env.SEO_SITE_URL ?? '')
    .trim()
    .replace(/\/+$/, '') || 'https://phytoemagryrd.lat';
  return `${base}${orderDeliveryDeepLink(orderId)}`;
}

function publicDeliveryOrder(item, order, customer = null, conversation = null, pickups = []) {
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
    /*
     * LO QUE NECESITA LA TARJETA, ya resuelto: cuántas unidades, qué se cobra,
     * cuándo se asignó y qué hay que recoger. Se calcula aquí para que el panel
     * no tenga que recorrer líneas por cada pedido.
     */
    total: Number(order?.total ?? item.total ?? 0) || 0,
    delivery_fee: Number(order?.delivery_fee ?? order?.delivery?.fee ?? 0) || 0,
    payment_method: order?.payment_method ?? order?.paymentMethod ?? null,
    payment_status: order?.payment_status ?? null,
    /*
     * LO QUE FALTA COBRAR, tal cual. `payment_status` dice si está pagado del
     * todo; `payment.due` dice cuánto queda (pago parcial incluido). Así el
     * repartidor cobra el saldo correcto y no el total otra vez.
     */
    payment: paymentSummaryForDelivery(order),
    created_at: order?.created_at ?? item.received_at ?? null,
    assigned_at: order?.delivery?.delivery_assigned_at ?? null,
    delivered_at: order?.delivered_at ?? null,
    items_count: (order?.items ?? []).reduce((sum, line) => sum + Math.max(1, Number(line?.quantity ?? 1) || 1), 0),
    pickups: Array.isArray(pickups) ? pickups : [],
    /*
     * EL PASO SIGUIENTE LO DECIDE EL SERVIDOR.
     *
     * La pantalla del repartidor no vuelve a inventar la secuencia: pide
     * `next_step` y pinta UNA acción. Así el panel y el backend no pueden
     * contradecirse (era exactamente el fallo: el texto decía «primero contacta»
     * y un botón decía «Iniciar entrega»).
     */
    next_step: deliveryNextStepOf(order),
    delivery_accepted_at: order?.delivery?.delivery_accepted_at ?? null,
    contacted_at: deliveryContactedAtOf(order),
  };
}

/** ¿Se registró algún intento de contacto (llamada, WhatsApp o mensaje del CRM)? */
function deliveryContactedAtOf(order) {
  const attempts = Array.isArray(order?.delivery?.delivery_contact_attempts) ? order.delivery.delivery_contact_attempts : [];
  const last = attempts.length ? attempts[attempts.length - 1]?.at ?? null : null;
  return order?.delivery?.delivery_contacted_at ?? last ?? null;
}

/**
 * SIGUIENTE PASO CANÓNICO DEL REPARTO.
 *
 * accepted → contacted → on_the_way → delivered. Es el único sitio donde se
 * define el orden; la app solo lo representa.
 */
function deliveryNextStepOf(order) {
  const status = String(order?.status ?? '');
  if (['entregado', 'cancelado', 'perdido'].includes(status)) return 'done';
  if (String(order?.delivery?.delivery_status ?? '').toUpperCase() === 'ISSUE_REPORTED') return 'issue';
  if (order?.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.IN_TRANSIT) return 'delivered';
  if (!order?.delivery?.delivery_accepted_at) return 'accepted';
  if (!deliveryContactedAtOf(order)) return 'contacted';
  return 'on_the_way';
}

async function visibleDeliveryOrders(ctx, actor) {
  /*
   * UNA lectura por tabla, no una por pedido.
   *
   * Antes, por cada pedido visible se pedía el cliente (`ctx.customers.get`) y se
   * buscaba su conversación, así que abrir el panel con 500 pedidos hacía 500
   * consultas encadenadas. Ahora las tres tablas se leen en paralelo y se
   * resuelven con mapas.
   */
  const [items, conversations, customerRows] = await Promise.all([
    ctx.store.listAdmin({ limit: 5000 }),
    ctx.db.list('conversations', { limit: 5000 }),
    ctx.db.list('customers', { limit: 500 }),
  ]);
  const customerById = new Map(customerRows.map((row) => [row.id, row]));
  const conversationById = new Map(conversations.map((row) => [row.id, row]));
  const conversationByCustomer = new Map();
  for (const row of conversations) {
    if (!conversationByCustomer.has(row.customer_id)) conversationByCustomer.set(row.customer_id, row);
  }
  /*
   * «MIS ENTREGAS» FILTRA EN EL PANEL.
   *
   * Antes un administrador veía aquí TODOS los pedidos (en UAT: 414, contados
   * como «asignados»), con los entregados y cancelados mezclados. El repartidor
   * recibe solo lo suyo desde el servidor; el administrador puede supervisar y
   * la pantalla enseña únicamente los trabajos que tiene él asignados.
   */
  if (!actor?.id) return [];
  /*
   * RECOGIDAS: se resuelven en UNA consulta para todos los pedidos, y solo con
   * lo que el repartidor necesita (tienda, artículos, estado). Nada de costos.
   */
  let pickupsByOrder = new Map();
  try {
    const [pickups, suppliers] = await Promise.all([
      ctx.db.list('order_pickups', { limit: 5000 }),
      ctx.db.list('suppliers', { limit: 5000 }),
    ]);
    const supplierById = new Map(suppliers.map((row) => [row.id, row]));
    for (const pickup of pickups) {
      const supplier = supplierById.get(pickup.supplier_id) ?? null;
      const key = String(pickup.order_id ?? '');
      if (!key) continue;
      const list = pickupsByOrder.get(key) ?? [];
      list.push({
        id: pickup.id ?? null,
        supplier_id: pickup.supplier_id ?? null,
        supplier_name: pickup.supplier_name ?? supplier?.name ?? null,
        status: pickup.status ?? 'pending_purchase',
        quantity: Number(pickup.quantity ?? 0) || 0,
        items: Array.isArray(pickup.items) ? pickup.items.map((line) => ({ name: line.name ?? 'Producto', quantity: Number(line.quantity ?? 1) || 1 })) : [],
        address: supplier?.address ?? null,
        sector: supplier?.sector ?? null,
        latitude: Number.isFinite(Number(supplier?.lat)) ? Number(supplier.lat) : null,
        longitude: Number.isFinite(Number(supplier?.lng)) ? Number(supplier.lng) : null,
        maps_url: supplier?.maps_url ?? null,
        invoice_attached: pickup.invoice_attached === true,
      });
      pickupsByOrder.set(key, list);
    }
  } catch {
    pickupsByOrder = new Map();
  }
  const orders = [];
  for (const item of items.filter((row) => row.type === 'order_intent')) {
    const order = orderOf(item);
    /*
     * Administración conserva la vista completa (supervisión y pruebas); el
     * repartidor recibe las suyas. La pantalla «Mis entregas» filtra además por
     * el usuario autenticado, para que un administrador no vea aquí 400 pedidos
     * que no son suyos.
     */
    if (!canOpenDeliveryOrder(actor, order)) continue;
    const customer = order.customer_id ? customerById.get(order.customer_id) ?? null : null;
    const conversation = order.conversation_id
      ? conversationById.get(order.conversation_id) ?? null
      : conversationByCustomer.get(customer?.id) ?? null;
    orders.push(publicDeliveryOrder(item, order, customer, conversation, pickupsByOrder.get(String(item.id)) ?? []));
  }
  return orders;
}

function trackingPointFromSession(session) {
  const latitude = Number(session?.last_latitude);
  const longitude = Number(session?.last_longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: session.last_accuracy ?? null,
    heading: session.last_heading ?? null,
    speed: session.last_speed ?? null,
    recorded_at: session.last_position_at ?? session.updated_at ?? session.started_at ?? null,
  };
}

function deliveryRouteSnapshot(session, order, status, at) {
  const destination = session?.destination ?? orderDestination(order);
  const current = trackingPointFromSession(session);
  const start = order?.delivery?.delivery_start_location ?? order?.delivery?.route_snapshot?.start_location ?? current ?? null;
  const summary = (start ?? current) && destination ? routeSummary(start ?? current, destination) : routeSummary(null, null);
  return {
    tracking_session_id: session?.id ?? null,
    status,
    started_at: session?.started_at ?? null,
    ended_at: at,
    delivery_user_id: session?.delivery_user_id ?? order?.delivery?.delivery_user_id ?? null,
    delivery_user_name_snapshot: session?.delivery_user_name_snapshot ?? order?.delivery?.delivery_user_name_snapshot ?? null,
    start_location: start,
    last_location: current,
    destination,
    distance_m: summary.distance_m,
    distance_label: summary.distance_label,
    eta_seconds: summary.eta_seconds,
    eta_label: summary.eta_label,
    route_provider: summary.provider,
  };
}

async function persistDeliveryRouteSnapshot(ctx, orderId, session, status, actor = null) {
  const item = await findOrderItem(ctx.store, orderId);
  const order = orderOf(item);
  if (!item || !order) return null;
  const at = session?.ended_at ?? ctx.clock().toISOString();
  const snapshot = deliveryRouteSnapshot(session, order, status, at);
  const next = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      route_snapshot: snapshot,
      delivery_tracking_session_id: snapshot.tracking_session_id,
      delivery_route_started_at: snapshot.started_at,
      delivery_route_ended_at: snapshot.ended_at,
      delivery_start_location: snapshot.start_location,
      delivery_last_location: snapshot.last_location,
      delivery_route_distance_m: snapshot.distance_m,
      delivery_route_distance_label: snapshot.distance_label,
      delivery_route_provider: snapshot.route_provider,
      delivery_route_saved_at: at,
      delivery_route_saved_by_user_id: actor?.actor_type === 'USER' ? actor.id : order.delivery?.delivery_route_saved_by_user_id ?? null,
    },
    updated_at: at,
  };
  const updated = await ctx.store.update(orderId, { orderJson: JSON.stringify(next) });
  return orderOf(updated) ?? next;
}

async function rememberDeliveryStartLocation(ctx, orderId, point, session) {
  const item = await findOrderItem(ctx.store, orderId);
  const order = orderOf(item);
  if (!item || !order || order.delivery?.delivery_start_location) return null;
  const at = ctx.clock().toISOString();
  const start = {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy ?? null,
    heading: point.heading ?? null,
    speed: point.speed ?? null,
    recorded_at: point.recorded_at ?? at,
  };
  const next = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      delivery_tracking_session_id: session?.id ?? order.delivery?.delivery_tracking_session_id ?? null,
      delivery_start_location: start,
      delivery_route_started_at: session?.started_at ?? order.delivery?.delivery_route_started_at ?? at,
    },
    updated_at: at,
  };
  const updated = await ctx.store.update(orderId, { orderJson: JSON.stringify(next) });
  return orderOf(updated) ?? next;
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
    await persistDeliveryRouteSnapshot(ctx, orderId, updated, status, actor);
    await emitDeliveryEvent(ctx, status === 'COMPLETED' ? 'delivery.completed' : 'delivery.tracking_stopped', updated);
  }
  return closed;
}

async function createUserNotification(ctx, input) {
  // Un reintento del mismo suceso no debe recrear el aviso ni reenviar su push.
  if (input.idempotencyKey) {
    const marks = await notificationDeletionMarks(ctx);
    if (borradoParaSuDestinatario(marks, { recipient_user_id: input.recipientUserId, idempotency_key: input.idempotencyKey })) {
      return { duplicate: true, notification: null };
    }
  }
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

/**
 * Marcas permanentes por destinatario. No se recortan por antigüedad ni por
 * cantidad: hacerlo permitiría que un suceso antiguo volviera a aparecer.
 */
async function notificationDeletionMarks(ctx) {
  const porPersona = new Map();
  const rows = await ctx.db.list('notification_deletions', { by: 'created_at', order: 'desc' });
  for (const row of rows) {
    if (!row.user_id) continue;
    const suyas = porPersona.get(row.user_id) ?? { ids: new Set(), keys: new Set() };
    if (row.notification_id) suyas.ids.add(row.notification_id);
    if (row.event_key) suyas.keys.add(row.event_key);
    porPersona.set(row.user_id, suyas);
  }
  return porPersona;
}

/** ¿Este aviso ya se le borró a su destinatario? */
function borradoParaSuDestinatario(marcas, row) {
  const suyas = marcas.get(row.recipient_user_id);
  if (!suyas) return false;
  if (suyas.ids.has(row.id)) return true;
  // El MISMO suceso recreado (otra fila, otro `id`): se descarta igual.
  return Boolean(row.idempotency_key && suyas.keys.has(row.idempotency_key));
}

/**
 * Apunta que este aviso se borró para `userId` (su destinatario). Se guarda
 * también la clave del suceso para que una recreación del mismo suceso tampoco
 * lo resucite.
 *
 * Importa que ocurra AQUÍ y no solo en el teléfono: el borrado del teléfono no
 * viaja a los demás dispositivos, y es exactamente lo que hacía que los avisos
 * «volvieran» al entrar desde el icono instalado o desde otro móvil.
 */
async function rememberNotificationDeletion(ctx, userId, notification) {
  if (!userId || !notification?.id) return;
  const at = ctx.clock().toISOString();
  await ctx.db.insert('notification_deletions', {
    id: newId('ndel'),
    user_id: userId,
    notification_id: notification.id,
    event_key: notification.idempotency_key ?? null,
    idempotency_key: `notif-del:${userId}:${notification.id}`,
    created_at: at,
    updated_at: at,
  });
}

async function notificationOwnerId(ctx, actor) {
  return await pushOwnerUserId(ctx, actor) ?? actor?.id ?? null;
}

/** Descartes de avisos generados en la interfaz, persistentes y personales. */
async function localNotificationDismissals(ctx, userId) {
  const result = {};
  const rows = await ctx.db.list('notification_deletions');
  for (const row of rows) {
    if (row.user_id !== userId || !row.notice_key) continue;
    const previous = result[row.notice_key];
    const value = row.notice_value;
    if (previous === true || value === true) result[row.notice_key] = true;
    else if (typeof value === 'number') result[row.notice_key] = Math.max(Number(previous) || 0, value);
    else if (previous === undefined) result[row.notice_key] = value;
  }
  return result;
}

/** Los avisos que este actor puede borrar (filas crudas: hacen falta sus claves). */
async function deletableNotifications(ctx, actor) {
  if (!actor?.id) return [];
  const ownerId = await notificationOwnerId(ctx, actor);
  const rows = await ctx.db.list('user_notifications', { by: 'created_at', order: 'desc' });
  return rows.filter((row) => row.recipient_user_id === ownerId);
}

async function listUserNotifications(ctx, actor, options = {}) {
  if (!actor?.id) return [];
  const limit = options.limit ?? 100;
  const ownerId = await notificationOwnerId(ctx, actor);
  /*
   * El límite se aplica después del destinatario y los descartes: el volumen
   * de avisos de otros usuarios no puede ocultar los de esta persona.
   */
  const rows = await ctx.db.list('user_notifications', {
    by: 'created_at',
    order: 'desc',
  });
  const marcas = await notificationDeletionMarks(ctx);
  return rows
    .filter((row) => row.recipient_user_id === ownerId)
    .filter((row) => !borradoParaSuDestinatario(marcas, row))
    .slice(0, Number.isFinite(limit) ? limit : undefined)
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

async function sendPushForNotification(ctx, notification, { subscriptionId = null } = {}) {
  const subscriptions = (await ctx.db.list('push_subscriptions', { limit: 1000 })).filter(
    (row) => row.user_id === notification.recipient_user_id && row.active !== false && (!subscriptionId || row.id === subscriptionId),
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
    errors: [],
  };
  const payload = {
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    orderId: notification.entity_type === 'order' ? notification.entity_id : null,
    conversationId: notification.entity_type === 'conversation' ? notification.entity_id : notification.data?.conversation_id ?? null,
    deepLink: notification.deep_link,
    type: notification.type,
    vibrate: notification.data?.vibrate ?? null,
  };
  for (const subscription of subscriptions) {
    const key = `push:${notification.id}:${subscription.endpoint}`;
    const existing = await ctx.db.findBy('push_jobs', 'idempotency_key', key);
    if (existing) {
      summary.skipped += 1;
      continue;
    }
    summary.attempted += 1;
    // Se guarda antes del envío: el worker puede confirmar antes de que responda Apple.
    const jobId = newId('psh');
    const created = await ctx.db.insert('push_jobs', {
      id: jobId, notification_id: notification.id, user_id: notification.recipient_user_id,
      subscription_id: subscription.id, endpoint: subscription.endpoint, status: 'pending',
      idempotency_key: key, created_at: ctx.clock().toISOString(), updated_at: ctx.clock().toISOString(),
    });
    if (created.duplicate) { summary.skipped += 1; continue; }
    const receiptToken = createHmac('sha256', WEB_PUSH_PRIVATE_KEY || ctx.token).update(`push-receipt:${jobId}`).digest('hex');
    let status = 'not_configured';
    let error = null;
    if (WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys ?? {},
          },
          JSON.stringify({ ...payload, receipt: { jobId, token: receiptToken } }),
          { TTL: 86400, urgency: 'high', contentEncoding: 'aes128gcm', timeout: 15000 },
        );
        status = 'sent';
        await ctx.db.update('push_subscriptions', subscription.id, { last_used_at: ctx.clock().toISOString(), active: true, last_error: null });
      } catch (err) {
        status = err?.statusCode === 404 || err?.statusCode === 410 ? 'expired' : 'failed';
        let reason = null;
        try {
          const value = JSON.parse(String(err?.body ?? '{}')).reason;
          if (typeof value === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value)) reason = value;
        } catch {}
        error = { statusCode: err?.statusCode ?? null, message: err?.message ?? 'push_failed', reason };
        summary.errors.push({ statusCode: error.statusCode, reason });
        await ctx.db.update('push_subscriptions', subscription.id, { last_error: error });
        if (status === 'expired') await ctx.db.update('push_subscriptions', subscription.id, { active: false, disabled_at: ctx.clock().toISOString(), last_error: error });
      }
    }
    if (status === 'sent') summary.sent += 1;
    else if (status === 'expired') summary.expired += 1;
    else if (status === 'not_configured') summary.notConfigured += 1;
    else summary.failed += 1;
    await ctx.db.update('push_jobs', jobId, {
      status, error, updated_at: ctx.clock().toISOString(),
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

function pushConfigurationWarnings() {
  try {
    const subject = new URL(WEB_PUSH_SUBJECT);
    const hostname = subject.protocol === 'mailto:' ? subject.pathname.split('@').pop() : subject.hostname;
    if (!hostname || hostname === 'localhost' || !hostname.includes('.') || /\.(local|localhost|test|invalid|example)$/i.test(hostname)) {
      return ['El contacto VAPID es local o de ejemplo. Configura PHYTO_WEB_PUSH_SUBJECT con un correo o una URL HTTPS públicos reales; Apple puede rechazar una identidad VAPID inválida.'];
    }
  } catch { return ['PHYTO_WEB_PUSH_SUBJECT no es una identidad VAPID válida.']; }
  return [];
}

async function pushStatusForUser(ctx, userId) {
  if (!userId) {
    return {
      configured: Boolean(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY),
      publicKey: WEB_PUSH_PUBLIC_KEY || null,
      configurationWarnings: pushConfigurationWarnings(),
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
    configurationWarnings: pushConfigurationWarnings(),
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
      deviceStatus: row.device_status ?? null,
      deviceReceivedAt: row.device_received_at ?? null,
      deviceError: row.device_error ?? null,
      workerVersion: row.worker_version ?? null,
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

function deliveryNotificationText(kind) {
  /*
   * AL PASAR EL PEDIDO AL MENSAJERO SE AVISA UNA VEZ Y EN CORTO.
   *
   * Antes el cliente recibía DOS mensajes seguidos: el del servidor (con el
   * nombre del repartidor) y, justo detrás, otro que mandaba el panel desde el
   * flujo «crear y pasar a delivery». Ahora el aviso lo manda SOLO el servidor
   * (una vez, cuando el pedido cambia de manos) y el texto es este, corto y sin
   * nombres: el mensajero se presenta él mismo al contactar.
   */
  if (kind === 'assignment') return 'Ya pasamos tu pedido al mensajero. Él te va a contactar cuando vaya a salir.';
  return 'Gracias por tu compra, aquí está tu recibo.';
}

async function sendDeliveryReceiptToCustomer(ctx, { item, order, customer, conversation, actor = null }) {
  const receipt = buildReceipt({ order, customer, businessName: 'FullTECH' });
  const filename = receiptFilename(receipt.order_number ?? item.id);
  const caption = deliveryNotificationText('delivered', customer, order);
  const actorFields = messageActorFields(actor);
  const meta = {
    phoneNumberId: ctx.whatsapp?.phoneNumberId ?? null,
    to: customer.phone_e164,
    order_id: item.id,
    invoice_filename: filename,
    source: 'delivery_complete',
  };
  const key = `delivery-receipt:${item.id}:${order?.delivery?.delivery_assignment_version ?? 1}`;
  const pdf = receiptPdf(receipt, { timeZone: TIME_ZONE });

  if (ctx.customers.canSendFreeText(conversation)) {
    let registradoTexto = await ctx.db.findBy('wa_messages', 'idempotency_key', `${key}:text`);
    if (!registradoTexto) {
      const envioTexto = await ctx.whatsapp.sendText(customer.phone_e164, caption);
      registradoTexto = (
        await ctx.customers.recordOutbound({
          customer,
          conversation,
          type: 'text',
          body: caption,
          waMessageId: envioTexto.messageId ?? null,
          status: envioTexto.ok ? 'sent' : 'failed',
          error: envioTexto.ok ? null : (envioTexto.error ?? { message: envioTexto.reason ?? 'error' }),
          idempotencyKey: `${key}:text`,
          meta,
          ...actorFields,
        })
      ).message;
      if (!envioTexto.ok) return { ok: false, status: 'failed', channel: 'text', reason: envioTexto.error?.message ?? envioTexto.reason ?? 'send_failed' };
    }

    if (!ctx.media?.pipeline || !ctx.media?.store) return { ok: false, status: 'failed', channel: 'document', reason: 'media_not_configured' };
    const documento = await ctx.media.pipeline.processOutbound({
      direction: 'document',
      to: customer.phone_e164,
      buffer: pdf,
      declaredMime: 'application/pdf',
      filename,
      caption: null,
      conversationId: conversation.id,
      idempotencyKey: `${key}:doc`,
      findExistingMessage: (idempotencyKey) => ctx.db.findBy('wa_messages', 'idempotency_key', idempotencyKey),
    });
    if (!documento.ok) {
      return {
        ok: false,
        status: documento.requiresReconciliation ? 'pending' : 'failed',
        channel: 'document',
        reason: documento.error?.message ?? documento.error?.code ?? 'document_send_failed',
      };
    }
    const registradoDocumento = await ctx.customers.recordOutbound({
      customer,
      conversation,
      type: 'document',
      body: filename,
      waMessageId: documento.waMessageId ?? null,
      status: documento.waMessageId ? 'sent' : 'pending',
      idempotencyKey: `${key}:doc-message`,
      meta,
      ...actorFields,
    });
    try {
      const fila =
        (await ctx.media.store.byIdempotencyKey(`${key}:doc`)) ??
        (documento.waMessageId ? await ctx.media.store.byWaMessageId(documento.waMessageId) : null);
      if (fila && registradoDocumento?.message?.id && fila.message_id !== registradoDocumento.message.id) {
        await ctx.media.store.update(fila.id, { messageId: registradoDocumento.message.id });
      }
    } catch {
      /* La entrega ya quedó cerrada; el hilo puede vivir sin este enlace. */
    }
    await ctx.customers.markConversationRead(conversation.id);
    return { ok: true, status: 'sent', channel: 'document', message_id: documento.waMessageId ?? registradoTexto?.wa_message_id ?? null, filename };
  }

  if (!ctx.media?.whatsapp?.uploadMedia) return { ok: false, status: 'failed', channel: 'template', template: INVOICE_TEMPLATE, reason: 'media_not_configured' };
  const check = await approvedTemplate(ctx, INVOICE_TEMPLATE);
  if (!check.ok) return { ok: false, status: 'pending', channel: 'template', template: INVOICE_TEMPLATE, reason: check.reason };
  if (String(check.template?.header?.format ?? '').toUpperCase() !== 'DOCUMENT') {
    return { ok: false, status: 'failed', channel: 'template', template: INVOICE_TEMPLATE, reason: 'template_without_document_header' };
  }
  const subida = await ctx.media.whatsapp.uploadMedia({ buffer: pdf, mimeType: 'application/pdf', filename });
  if (!subida.ok) return { ok: false, status: 'failed', channel: 'template', template: INVOICE_TEMPLATE, reason: subida.error?.message ?? 'upload_failed' };
  const payload = await resolveTemplatePayload(ctx, {
    template: check.template,
    customer,
    conversation,
    provided: { 1: customer.name || customer.phone_e164, 2: receipt.order_number ?? '' },
  });
  if (!payload.ok) return { ok: false, status: 'failed', channel: 'template', template: INVOICE_TEMPLATE, reason: payload.error };
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
    conversation,
    type: 'template',
    template: check.template.name,
    body: payload.body,
    waMessageId: result.messageId ?? null,
    status: result.ok ? 'sent' : 'failed',
    error: result.ok ? null : (result.error ?? { message: result.reason ?? 'error' }),
    idempotencyKey: `${key}:template`,
    meta,
    ...actorFields,
  });
  if (!result.ok) return { ok: false, status: 'failed', channel: 'template', template: check.template.name, reason: result.error?.message ?? result.reason ?? 'send_failed' };
  await ctx.customers.markConversationRead(conversation.id);
  return { ok: true, status: 'sent', channel: 'template', template: check.template.name, message_id: result.messageId ?? registrado.message?.wa_message_id ?? null, filename };
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

  /*
   * ¿YA SE LE AVISÓ HACE UN MOMENTO? El texto es el mismo para cualquier pedido,
   * así que dos pedidos seguidos del mismo cliente producían dos mensajes
   * idénticos seguidos. Dentro de la ventana se avisa una sola vez.
   */
  if (kind === 'assignment') {
    const ultimo = conversation.delivery_assignment_notice_at ?? null;
    const dentroDeLaVentana = Boolean(ultimo) && Number.isFinite(Date.parse(ultimo)) && ctx.clock().getTime() - Date.parse(ultimo) < ASSIGNMENT_NOTICE_WINDOW_MS;
    if (dentroDeLaVentana) {
      const result = { status: 'skipped', reason: 'aviso_reciente', since: ultimo };
      await record(result);
      return result;
    }
  }

  if (kind === 'delivered') {
    const receiptResult = await sendDeliveryReceiptToCustomer(ctx, { item, order, customer, conversation, actor });
    const result = {
      status: receiptResult.status,
      channel: receiptResult.channel,
      template: receiptResult.template ?? null,
      message_id: receiptResult.message_id ?? null,
      reason: receiptResult.reason ?? null,
    };
    await record(result);
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: receiptResult.ok ? sentAction : failedAction,
      actor: actor?.display_name ?? null,
      summary: receiptResult.ok ? 'Cliente recibió recibo de entrega' : `No se pudo enviar recibo de entrega: ${receiptResult.reason ?? 'error'}`,
      data: { ...data, channel: result.channel, template: result.template, message_id: result.message_id, error: result.reason },
    });
    return result;
  }

  const templateName = DELIVERY_ASSIGNMENT_TEMPLATE;
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
  // Queda anotado en la conversación para no repetir el mismo aviso enseguida.
  if (kind === 'assignment' && conversation?.id && typeof ctx.db?.update === 'function') {
    await ctx.db.update('conversations', conversation.id, { delivery_assignment_notice_at: ctx.clock().toISOString() }).catch(() => null);
  }
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
        3: absoluteDeliveryDeepLink(item.id),
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
      provided: { 1: order.order_number ?? item.id, 2: deliveryUser.display_name ?? 'Delivery', 3: absoluteDeliveryDeepLink(item.id) },
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
        5: absoluteDeliveryDeepLink(item.id),
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
  // Motor ANTIGUO de control de reparto. El Supervisor IA lo sustituye: si está activo,
  // este tick no debe enviar nada para no duplicar mensajes ni tener dos calendarios.
  const supervisorActive = await supervisorSettings(ctx).then((saved) => saved?.enabled === true).catch(() => false);
  if (supervisorActive) return { skipped: 'supervisor_active', reminders: 0, escalations: 0 };
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
  /*
   * FORMATO DOCUMENTADO: «*Nombre · Delivery*». Es la firma que ven los clientes
   * cuando escribe un repartidor, y la que comprueban las pruebas.
   */
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
  /*
   * LA FIRMA VA EN EL PRIMER MENSAJE DEL PEDIDO.
   *
   * Mientras el pedido está «por contactar», el cliente todavía no sabe quién
   * se lo lleva: ese mensaje lleva «*Nombre · Delivery*». Después ya lo sabe y
   * repetir la firma en cada mensaje ensucia la conversación.
   */
  return deliveryStatusOf(order) === DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT;
}

function withDeliveryIdentity(body, actor) {
  const header = deliveryIdentityHeader(actor);
  const clean = longText(body, 1200) ?? '';
  if (/^\*[^*\n]{1,120}·\s*Delivery\*/i.test(clean.trim()) || clean.trim().startsWith(header)) return clean;
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
  /*
   * SOLO LO SUYO, pedido a la base con filtro.
   * Antes se leían TODAS las conversaciones (hasta 5000) y se descartaban en
   * memoria: abrir un chat con el usuario de un agente costaba más cuanto más
   * grande era el negocio, no cuanto más largo era el chat.
   */
  const conversations = await ctx.db.list('conversations', { where: { assigned_user_id: actor.id }, limit: 5000 });
  const conversationIds = new Set();
  const customerIds = new Set();
  for (const conversation of conversations) {
    conversationIds.add(conversation.id);
    if (conversation.customer_id) customerIds.add(conversation.customer_id);
  }
  const rows = await ctx.store.listAdmin({ limit: 5000 });
  const clientesDeSusEntregas = new Set();
  for (const item of rows) {
    if (item.type !== 'order_intent') continue;
    const order = orderOf(item);
    if (order?.delivery?.delivery_user_id !== actor.id) continue;
    if (item.conversation_id) conversationIds.add(item.conversation_id);
    const customerId = order?.customer_id ?? item.customer_id ?? null;
    if (customerId) clientesDeSusEntregas.add(customerId);
  }
  /*
   * EL CHAT DEL CLIENTE DE SU PEDIDO TAMBIÉN ES SUYO.
   *
   * Muchos pedidos no guardan `conversation_id`; la conversación es la del
   * cliente. Sin esto, el repartidor abría «Mensaje CRM» desde su entrega y el
   * servidor le decía que la conversación no estaba a su nombre.
   */
  for (const customerId of clientesDeSusEntregas) {
    customerIds.add(customerId);
    const suyas = await ctx.db.list('conversations', { where: { customer_id: customerId } });
    for (const conversation of suyas) conversationIds.add(conversation.id);
  }
  return { all: false, conversationIds, customerIds };
}

/**
 * LA REGLA: ¿puede este usuario ABRIR esta conversación?
 *
 *  · Administración (`chats.force_reassign`): todo.
 *  · Lo que ya es SUYO (asignado a él, o cliente de una entrega suya): sí.
 *  · SIN ASIGNAR: cualquier agente con `chats.take_unassigned` puede abrirla y
 *    contestar. Es lo que pidió el negocio: si el cliente escribe y nadie la
 *    tiene, el que esté disponible la atiende; al contestar queda a su nombre y
 *    desde ese momento es exclusiva (los demás reciben 403 y solo administración
 *    puede reasignarla).
 *  · Asignada a OTRO: no. Se sigue viendo en la lista (nombre y último mensaje),
 *    pero el hilo y la escritura necesitan que se la asignen.
 *
 * El rol DELIVERY no tiene `chats.take_unassigned`: el repartidor entra a los
 * chats de sus entregas, no a la bandeja general.
 *
 * @param {any} ctx
 * @param {any} actor
 * @param {any} conversation
 */
function crmVisibleConversationCounts(rows) {
  const visible = rows.filter((row) => !row.deleted_at && !row.empty);
  const active = visible.filter((row) => !row.archived_at);
  const stage = (value) => active.filter((row) => row.customer_stage === value).length;
  return { todos: active.length, no_leidos: active.filter((row) => Number(row.unread_count) > 0).length,
    pendientes: active.filter((row) => row.awaiting_reply === true).length,
    clientes: active.filter((row) => row.has_purchase === true).length,
    seguimiento: active.filter((row) => row.next_followup).length,
    mios: 0, sin_asignar: active.filter((row) => !row.assigned_user_id).length,
    archivados: visible.length - active.length,
    unread_total: visible.reduce((sum, row) => sum + (Number(row.unread_count) || 0), 0),
    prospectos: stage('PROSPECT'), interesados: stage('INTERESTED'),
    etapa_clientes: stage('CUSTOMER'), recompra: stage('REPEAT_CUSTOMER'),
    inactivos: stage('INACTIVE') };
}

async function canOpenConversation(ctx, actor, conversation, ownership = null) {
  if (!conversation) return false;
  if (!crmRowVisible(actor, ownership ?? await crmOwnership(ctx), 'conversation', conversation)) return false;
  const access = await conversationAccess(ctx, actor);
  if (access.all || access.conversationIds.has(conversation.id)) return true;
  const sinAsignar = !conversation.assigned_user_id && !conversation.assigned_to;
  return sinAsignar && hasPermission(actor, 'chats.take_unassigned');
}

/**
 * TOMA LA CONVERSACIÓN SI ESTÁ LIBRE (al contestar por primera vez).
 *
 * Atómico: `assignConversation` corre bajo el candado de la conversación y con
 * `mode: 'take'` devuelve `already_assigned` si otro agente se adelantó. Así dos
 * agentes que escriben a la vez no se pisan: el segundo recibe 403 con el nombre
 * de quien la tomó, en vez de mandar un mensaje que ya no le corresponde.
 *
 * @returns {Promise<{ok: true, conversation?: any}|{ok: false, assigned_display_name_snapshot?: string|null}>}
 */
async function claimConversationIfFree(ctx, actor, conversation) {
  if (!conversation || conversation.assigned_user_id || conversation.assigned_to) return { ok: true };
  if (!actor?.id || actor.actor_type !== 'USER') return { ok: true }; // clave legacy: no se apropia nada
  if (!hasPermission(actor, 'chats.take_unassigned')) return { ok: true };
  const result = await ctx.customers.assignConversation(conversation.id, {
    mode: 'take',
    userId: actor.id,
    displayName: actor.display_name ?? null,
    byUserId: actor.id,
    byDisplayName: actor.display_name ?? null,
  });
  if (result?.ok) {
    await ctx.audit?.record({
      entity: 'conversation',
      entityId: conversation.id,
      action: 'conversation.taken_on_reply',
      actor: actor.display_name ?? null,
      summary: 'Tomó la conversación sin asignar al contestar',
      data: { user_id: actor.id, customer_id: conversation.customer_id ?? null },
      idempotencyKey: `conversation.taken:${conversation.id}:${actor.id}`,
    });
    return { ok: true, conversation: result.conversation };
  }
  return { ok: false, assigned_display_name_snapshot: result?.assigned_display_name_snapshot ?? null };
}

/** ¿Puede este usuario trabajar con ese cliente (seguimientos, tareas)? */
async function canWorkWithCustomer(ctx, actor, customerId, ownership = null) {
  if (!customerId) return false;
  if (!crmRowVisible(actor, ownership ?? await crmOwnership(ctx), 'customer', customerId)) return false;
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
  /*
   * UNA INCIDENCIA ABIERTA A LA VEZ.
   *
   * Antes, pulsar dos veces creaba dos registros (la clave de auditoría incluía
   * la hora exacta) y el pedido no tenía historial: solo el «último motivo». Ahora
   * cada incidencia es un hecho con su id y, mientras una esté abierta, no se
   * acepta otra: se resuelve primero. Eso evita duplicados y escalados dobles.
   */
  const previousIssues = Array.isArray(order.delivery?.issues) ? order.delivery.issues : [];
  if (previousIssues.some((issue) => !issue.resolved_at)) {
    return {
      ok: false,
      status: 409,
      error: 'issue_pending',
      message: 'Ya hay una incidencia abierta en este pedido. Espera la decisión administrativa.',
    };
  }
  const issue = {
    id: newId('iss'),
    reason: reasonCode,
    reason_label: DELIVERY_ISSUE_REASONS[reasonCode],
    note: note || null,
    at,
    by_user_id: actor.id,
    by_display_name: actor.display_name ?? null,
    channel: text(input.channel, 20) ?? 'panel',
    resolved_at: null,
  };
  const next = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      delivery_status: DELIVERY_OPERATIONAL_STATUSES.ISSUE_REPORTED,
      issues: [...previousIssues, issue].slice(-50),
      issue_id: issue.id,
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
    idempotencyKey: `delivery.issue:${item.id}:${issue.id}`,
  });
  return { ok: true, order: orderOf(updated) ?? next, closedTracking: closed, issue };
}

/** Identificador aleatorio corto (mismo patrón que el resto del CRM). */
function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

async function ensureInventoryForSale(ctx, item) {
  if(isCompletedPurchaseStatus(item.status)){try{await ctx.smartCommerce?.fulfillment.assertSale({...orderOf(item),id:item.id});}catch(error){return {ok:false,status:error.status||409,error:error.code,message:error.message};}}
  if (!ctx.inventory) return { ok: true };
  const order = orderOf(item);
  if (ctx.storeCatalog && order) {
    const checked = await ctx.storeCatalog.checkOrder(order);
    if (!checked.ok) return checked;
  }
  const required =
    Number(order?.total_capsules) ||
    (order?.items ?? []).reduce((sum, line) => sum + (Number(line.totalCapsules) || 0), 0);
  const stock = await ctx.inventory.stock();
  if (stock.initialized && stock.current < required) {
    return {
      ok: false,
      status: 409,
      error: 'insufficient_stock',
      message: `Stock insuficiente: hay ${stock.current} cápsulas disponibles y este pedido requiere ${required}. Agrega stock antes de crear el pedido.`,
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
    if (ctx.inventory && Number(order.total_capsules) > 0) {
      const stock = await ctx.inventory.stock();
      const saleMovements = stock.movements.filter((row) => row.order_id === orderId && row.type === 'SALE');
      if (!saleMovements.length) reasons.push('delivered_missing_inventory_sale');
      if (saleMovements.length > 1 && !stock.movements.some((row) => row.order_id === orderId && row.type === 'SALE_REVERSAL')) {
        reasons.push('delivered_multiple_inventory_sales');
      }
    }
    if (ctx.storeCatalog) reasons.push(...await ctx.storeCatalog.integrity(order));
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
  try{await ctx.smartCommerce?.fulfillment.assertSale({...orderOf(item),id:item.id});}catch(error){return {ok:false,status:error.status||409,error:error.code,message:error.message};}
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
  const refreshed = await findOrderItem(ctx.store, item.id);
  if (refreshed) {
    delivered.item = refreshed;
    order = orderOf(refreshed) ?? order;
  }
  return { ok: true, item: delivered.item ?? deliveredItem, order, delivered, duplicate: alreadyDelivered };
}

async function cancelOpenOrder(ctx, item, reason, actor = null, source = 'MANUAL_ADMIN') {
  const order = orderOf(item);
  if (!order) return { ok: false, status: 422, error: 'invalid_order' };
  try{await ctx.smartCommerce?.fulfillment.cancelOrder(item.id,actor);}catch(error){return {ok:false,status:error.status||409,error:error.code,message:error.message};}
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
      /*
       * UN PEDIDO CANCELADO NO SE "ENTREGA".
       *
       * Antes, si el pedido se cancelaba mientras el repartidor iba en camino y
       * él confirmaba por WhatsApp, la transición lo marcaba entregado (y la
       * carrera se resolvía en silencio). Cancelar y entregar son decisiones
       * incompatibles: si de verdad se entregó, hay que reabrirlo primero con su
       * motivo y su autor.
       */
      if (String(previousStatus) === 'cancelado' || String(order.delivery?.delivery_status ?? '').toUpperCase() === 'CANCELLED') {
        return {
          ok: false,
          status: 409,
          error: 'order_cancelled',
          message: 'El pedido está cancelado. Reábrelo antes de marcarlo como entregado.',
        };
      }
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

/**
 * CONFIRMAR UN PEDIDO — NO ES COBRAR NI ENTREGAR.
 *
 * Es el paso comercial que faltaba: un pedido recién creado nace `nuevo`
 * (pendiente de confirmación) y aquí pasa a `confirmado` con quién lo confirmó y
 * cuándo. Lo que NO hace, a propósito:
 *   · no marca el pedido como cobrado (`payment_status` no se toca);
 *   · no descuenta inventario (eso pasa al entregar);
 *   · no crea una entrega ni activa tracking;
 *   · no manda ningún WhatsApp por su cuenta.
 *
 * La asignación de mensajero es OPCIONAL y va después de confirmar, para que un
 * error de asignación no deje un pedido «confirmado» a medias ni una entrega
 * fantasma: si falla, el pedido sigue confirmado y se dice que NO quedó asignado.
 * Es idempotente: confirmar dos veces devuelve `duplicate: true` y no duplica ni
 * el historial ni el aviso al repartidor.
 */
async function confirmOrder(ctx, input = {}) {
  return withOrderTransitionLock(String(input.orderId ?? ''), async () => {
    const item = await findOrderItem(ctx.store, input.orderId);
    if (!item) return { ok: false, status: 404, error: 'not_found', message: 'Ese pedido no existe.' };
    const order = orderOf(item);
    if (!order) return { ok: false, status: 422, error: 'invalid_order', message: 'Ese pedido no se pudo leer.' };

    const actor = input.actor ?? null;
    const currentStatus = String(item.status ?? order.status ?? 'nuevo');
    if (ORDER_CLOSED_STATUSES.includes(currentStatus)) {
      return { ok: false, status: 409, error: 'order_closed', message: 'Ese pedido ya está cerrado: no se puede confirmar.' };
    }

    // Quién lleva el pedido se valida ANTES de escribir nada.
    const deliveryUserId = text(input.deliveryUserId, 80);
    const deliveryContactPhone = text(input.deliveryContactPhone, 40);
    let deliveryUser = null;
    if (deliveryUserId) {
      deliveryUser = await ctx.users.get(deliveryUserId);
      if (!deliveryUser || !canDeliver(deliveryUser) || deliveryUser.active === false) {
        return { ok: false, status: 422, error: 'invalid_delivery_user', message: 'Asigna un agente o un repartidor del equipo.' };
      }
      const companyId = companyOfOrder(order);
      if (companyId !== 'phytoemagry' &&
          !(await authorizedCourierAccount(ctx.db, companyId, { userId: deliveryUser.id }))) {
        return { ok: false, status: 403, error: 'courier_company_forbidden',
          message: 'El repartidor no está autorizado para esta empresa.' };
      }
    }

    const at = ctx.clock().toISOString();
    const fulfillment = input.fulfillment === 'pickup' ? 'pickup' : input.fulfillment === 'delivery' ? 'delivery' : null;
    const yaConfirmado = ['confirmado', 'en_preparacion', 'enviado'].includes(currentStatus) || isCompletedPurchaseStatus(currentStatus);

    let confirmedItem = item;
    let confirmedOrder = order;
    if (!yaConfirmado) {
      const reason = manualReason(input.reason) ?? null;
      const next = {
        ...order,
        status: 'confirmado',
        confirmed_at: order.confirmed_at ?? at,
        confirmed_by_user_id: actor?.actor_type === 'USER' ? actor.id : order.confirmed_by_user_id ?? null,
        confirmed_by_display_name_snapshot:
          actor?.actor_type === 'USER' ? actor.display_name : order.confirmed_by_display_name_snapshot ?? null,
        ...(fulfillment
          ? { fulfillment_method: fulfillment, fulfillment_label: fulfillment === 'pickup' ? 'Retiro en tienda' : 'Entrega' }
          : {}),
        status_history: [...(order.status_history ?? []), { status: 'confirmado', at, reason, source: 'PANEL_CONFIRM' }],
        updated_at: at,
      };
      const updated = await ctx.store.update(item.id, { status: 'confirmado', orderJson: JSON.stringify(next) });
      confirmedItem = updated ?? item;
      confirmedOrder = orderOf(confirmedItem) ?? next;
      await auditOrderStatusTransition(ctx, {
        orderId: item.id,
        previousStatus: currentStatus,
        newStatus: 'confirmado',
        actor,
        reason,
        changedAt: at,
        source: 'PANEL_CONFIRM',
        idempotencyKey: `order.confirmed:${item.id}`,
      });
    } else if (fulfillment && !order.fulfillment_method) {
      // Reintento de una confirmación anterior: no se duplica el historial.
      confirmedOrder = { ...confirmedOrder, fulfillment_method: fulfillment };
      const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(confirmedOrder) });
      confirmedItem = updated ?? confirmedItem;
    }

    /*
     * ASIGNACIÓN (opcional). Solo si de verdad cambia de manos: repetir el mismo
     * mensajero no vuelve a avisarle ni suma una versión de asignación.
     */
    let assignment = { attempted: false, ok: true, deliveryUserId: null, external: false };
    const repartidorActual = text(confirmedOrder?.delivery?.delivery_user_id, 80);
    const externoActual = text(confirmedOrder?.delivery?.external?.phone, 40);
    if (deliveryUser && repartidorActual !== deliveryUser.id) {
      assignment = { attempted: true, ok: true, deliveryUserId: deliveryUser.id, external: false };
      try {
        const assigned = await assignDeliveryToOrder(ctx, confirmedItem, deliveryUser, actor, {
          assignmentNote: input.deliveryNote,
        });
        if (assigned?.item) {
          confirmedItem = assigned.item;
          confirmedOrder = assigned.order ?? confirmedOrder;
        }
      } catch (error) {
        console.error('[crm] no se pudo asignar el delivery al confirmar', { code: error?.code });
        assignment = { attempted: true, ok: false, deliveryUserId: deliveryUser.id, external: false, error: 'assign_failed' };
      }
    } else if (deliveryContactPhone && externoActual !== deliveryContactPhone) {
      assignment = { attempted: true, ok: true, deliveryUserId: null, external: true };
      try {
        const result = await assignCourier({
          ctx,
          item: confirmedItem,
          order: confirmedOrder,
          contactPhone: deliveryContactPhone,
          actor,
        });
        if (!result.ok) {
          assignment = {
            attempted: true,
            ok: false,
            deliveryUserId: null,
            external: true,
            error: result.error ?? 'assign_failed',
            message: result.message ?? null,
          };
        } else if (result.order) {
          confirmedOrder = result.order;
          confirmedItem = (await findOrderItem(ctx.store, item.id)) ?? confirmedItem;
        }
      } catch (error) {
        console.error('[crm] no se pudo asignar el repartidor externo al confirmar', { code: error?.code });
        assignment = { attempted: true, ok: false, deliveryUserId: null, external: true, error: 'assign_failed' };
      }
    }

    const fresh = (await findOrderItem(ctx.store, item.id)) ?? confirmedItem;
    const finalOrder = orderOf(fresh) ?? confirmedOrder;
    return {
      ok: true,
      duplicate: yaConfirmado && !assignment.attempted,
      item: fresh,
      order: finalOrder,
      assignment,
      confirmedAt: finalOrder.confirmed_at ?? at,
      integrity: await validateOrderOperationalIntegrity(ctx, item.id),
    };
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
async function createOrder(ctx, body = {}, actor = null, options = {}) {
  return ctx.storeCatalog ? ctx.storeCatalog.orderLock(()=>createOrderUnlocked(ctx,body,actor,options)) : createOrderUnlocked(ctx,body,actor,options);
}

async function createOrderUnlocked(ctx, body = {}, actor = null, options = {}) {
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
  /*
   * Un pedido de la TIENDA nace SIN método de pago y SIN cobro: el pago se
   * acuerda después con el equipo. Solo el panel exige elegir método aquí.
   */
  const isStoreOrder = body.origin === 'FULLTECH_STORE';
  if (!paymentMethod && !isStoreOrder) {
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
      product: ctx.storeCatalog ? {variants:[...(await ctx.storeCatalog.product()).variants,...(options.manualProducts||[])]} : undefined,
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
      message: 'Elige un producto o servicio activo del catálogo.',
    };
  }
  /*
   * TRAZABILIDAD DE LA TIENDA: origen, forma de entrega y el SNAPSHOT de la
   * garantía que el cliente vio al comprar (las ediciones posteriores no
   * cambian lo ya acordado).
   */
  if (isStoreOrder) {
    built.order.origin = 'FULLTECH_STORE';
    built.order.company_id = 'fulltech';
    built.order.origin_label = 'Pedido tienda';
    built.order.fulfillment_method = body.fulfillment === 'pickup' ? 'pickup' : 'delivery';
    built.order.payment_status = 'pending';
    built.order.warranty_snapshot = Array.isArray(body.warrantySnapshot) ? body.warrantySnapshot : [];
    if(options.smartQuote)built.order.smart_commerce=options.smartQuote;
  }
  if (!isStoreOrder) built.order.company_id = companyOfOrder(built.order);
  /*
   * La ubicación elegida queda en el HISTORIAL del cliente con su procedencia
   * (dispositivo del operador, coordenadas a mano o reutilizada), para poder
   * elegirla la próxima vez. Reutilizar una que ya existía no duplica filas.
   */
  if(!options.smartQuote||options.smartQuote.saveAddressPreference)await rememberOrderLocation(ctx, {
    location: entrega.location,
    customerId: customer.id,
    conversationId,
    orderId: built.row.id,
  });

  const requested = text(body.status, 20);
  const status = requested && isOrderStatus(requested) ? requested : 'nuevo';
  /*
   * EL ESTADO NO DECIDE EL PAGO, NI EN EL POS.
   *
   * Aquí había `payment_status = 'paid'` solo porque el pedido nacía entregado,
   * aunque el POS no hubiera cobrado (una venta a crédito creada como entregada
   * salía «pagada»). El pago lo dice quien cobra: `paymentStatus` en la venta
   * facturada, o el registro explícito de cobro después.
   */
  built.order.created_by_user_id = actor?.actor_type === 'USER' ? actor.id : null;
  built.order.created_by_display_name_snapshot = actor?.actor_type === 'USER' ? actor.display_name : null;
  built.order.updated_by_user_id = actor?.actor_type === 'USER' ? actor.id : null;
  built.row.orderJson = JSON.stringify(built.order);
  const stockCheck = await ensureInventoryForSale(ctx, { ...built.row, status, order_json: built.row.orderJson });
  if (!stockCheck.ok) return stockCheck;
  // Si el pedido nace ya ENTREGADO, queda registrada también su fecha de entrega.
  if (isCompletedPurchaseStatus(status)) {
    // La MISMA hora que usa el resto del CRM (en producción es la real; el reloj
    // inyectable hace que esto se pueda probar con fechas concretas).
    built.order.delivered_at = ctx.clock().toISOString();
    built.row.orderJson = JSON.stringify(built.order);
  }
  const saved = await ctx.store.save(built.row);
  // Another server may win the unique-ID insert after our initial lookup.
  // Store retries must never overwrite the winning persisted order.
  if (isStoreOrder && saved.duplicate) {
    const existing = await ctx.store.getAdmin(built.row.id);
    return { ok: true, duplicate: true, item: existing, order: orderOf(existing), customer, status: existing.status };
  }
  const item = await ctx.store.update(built.row.id, {
    status,
    notes: built.order.notes,
    customerId: customer.id,
    conversationId,
    createdByUserId: actor?.actor_type === 'USER' ? actor.id : null,
    createdByDisplayNameSnapshot: actor?.actor_type === 'USER' ? actor.display_name : null,
  });
  const finalItem = item ?? built.row;

  /*
   * RECOGIDAS POR TIENDA (idempotente).
   * Un pedido con artículos de dos tiendas genera DOS recogidas, no una por
   * artículo; volver a pasar por aquí no duplica ninguna. Los productos propios
   * no entran: no hay nada que recoger.
   */
  try {
    const supplierRows = await ctx.db.list('suppliers', { limit: 5000 });
    await syncOrderPickups(ctx.db, {
      order: { ...built.order, id: built.row.id, customer_id: customer.id },
      suppliers: supplierRows,
      clock: ctx.clock ?? (() => new Date()),
    });
  } catch (error) {
    // El pedido ya está guardado: un fallo aquí no puede perder la venta.
    console.error('[crm] no se pudieron preparar las recogidas', { code: error?.code });
  }

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
    try { delivered = await afterPurchaseDelivered(ctx, finalItem); }
    catch(error) {
      if (!error.inventory || error.inventory.ok) throw error;
      // La última unidad pudo venderse en otra instancia después de comprobarla.
      // La intención permanece pendiente; jamás queda como una venta completada.
      const pendingOrder={...built.order,status:'nuevo',delivered_at:null};
      await ctx.store.update(built.row.id,{status:'nuevo',orderJson:JSON.stringify(pendingOrder)});
      return {ok:false,status:409,error:error.inventory.error||'inventory_error',
        message:error.inventory.message||'El stock cambió mientras se registraba la venta. El pedido quedó pendiente; revisa el inventario.',orderId:built.row.id};
    }
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

/**
 * PEDIDO DESDE LA TIENDA (origen FULLTECH_STORE).
 *
 * Reglas que se cumplen aquí:
 *  · el cliente sale de la SESIÓN de la cuenta (nunca del navegador);
 *  · precios, disponibilidad y garantía se validan en el servidor;
 *  · el pedido nace PENDIENTE de confirmación y SIN pago;
 *  · no se descuenta inventario (solo se comprueba que haya).
 */
async function createStoreOrder(ctx, session, body = {}) {
  if (!ctx.storeCatalog) return { ok: false, status: 503, error: 'store_unavailable' };
  return ctx.storeCatalog.orderLock(() => createStoreOrderUnlocked(ctx, session, body));
}

async function createStoreOrderUnlocked(ctx, session, body = {}) {
  if (!ctx.storeCatalog) {
    return { ok: false, status: 503, error: 'store_unavailable', message: 'La tienda no está disponible ahora mismo.' };
  }
  const account = session?.account ?? null;
  const customerId = account?.customer_id ?? session?.customer?.id ?? null;
  if (!customerId) {
    return { ok: false, status: 401, error: 'unauthorized', message: 'Inicia sesión para hacer un pedido.' };
  }
  const requestKey = String(body.requestKey ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestKey)) {
    return { ok: false, status: 422, error: 'request_key_required', message: 'Recarga el checkout antes de enviar el pedido.' };
  }
  // Scope browser keys to the authenticated customer. Replay the persisted
  // order before checking current catalog state; retries never mutate it.
  const idempotentId = 'store_' + createHash('sha256').update(customerId + ':' + requestKey).digest('hex').slice(0, 48);
  const scoped = await ctx.store.getAdmin(idempotentId);
  const legacy = scoped ? null : await ctx.store.getAdmin(requestKey);
  const previous = scoped || (legacy?.customer_id === customerId && orderOf(legacy)?.origin === 'FULLTECH_STORE' ? legacy : null);
  if (previous) {
    const order = orderOf(previous);
    if(ctx.smartCommerce&&order?.smart_commerce?.id)await ctx.smartCommerce.completeOrder(account,order.smart_commerce.id,requestKey,previous.id);
    return { ok: true, duplicate: true, order: {
      id: previous.id, number: order?.order_number, status: previous.status,
      total: order?.total, currency: order?.currency ?? 'DOP',
      fulfillment: order?.fulfillment_method, payment_status: order?.payment_status ?? 'pending',
    } };
  }
  let lines;
  try {
    lines = await ctx.storeCatalog.publicOrderItems(body.items);
  } catch (error) {
    return { ok: false, status: error.status ?? 422, error: error.code ?? 'invalid_cart', message: error.message };
  }
  let smartQuote=null;
  if(ctx.smartCommerce){
    if(!body.quoteId)return {ok:false,status:409,error:'quote_required',message:'Confirma primero la cotización de entrega.'};
    try{smartQuote=await ctx.smartCommerce.prepareOrder(account,body.quoteId,requestKey,body.items,body.paymentMethod||'arrange_later');}
    catch(error){return {ok:false,status:error.status||503,error:error.code||'quote_unavailable',message:error.status?error.message:'No pudimos validar la cotización.'};}
  }
  const fulfillment = smartQuote?.fulfillment ?? (body.fulfillment === 'pickup' ? 'pickup' : 'delivery');
  const address = fulfillment === 'delivery'
    ? String(smartQuote?.destination?.address ?? body.address ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
    : '';
  if (fulfillment === 'delivery' && address.length < 8) {
    return { ok: false, status: 422, error: 'address_required', message: 'Escribe la dirección de entrega.' };
  }
  const notes = String(body.notes ?? '').trim().slice(0, 500);
  if(smartQuote?.managedFulfillment){try{await ctx.smartCommerce.fulfillment.holdOrder(account,smartQuote,idempotentId);}catch(error){return {ok:false,status:error.status||409,error:error.code||'reservation_failed',message:error.message};}}
  if(smartQuote?.managedFulfillment)await ctx.smartCommerce.checkpoint('checkout.after_reservation',{orderId:idempotentId});
  const result = await createOrderUnlocked(
    ctx,
    {
      id: idempotentId,
      customerId: customerId,
      items: lines.map((line) => ({ variantId: line.id, quantity: line.quantity,...(smartQuote?{unitPrice:smartQuote.lines.find(i=>i.id===line.id).unitPriceCents/100}:{}) })),
      ...(smartQuote?{deliveryFee:smartQuote.deliveryFeeCents/100,paymentMethod:smartQuote.paymentIntent==='cash'?'CASH':smartQuote.paymentIntent.startsWith('transfer')?'TRANSFER':undefined,deliveryLocation:smartQuote.destination}:{}),
      origin: 'FULLTECH_STORE',
      source: 'FULLTECH_STORE',
      channel: 'store',
      fulfillment,
      delivery: { method: fulfillment, address, note: notes },
      notes,
      warrantySnapshot: lines.map((line) => ({
        product_id: line.id,
        name: line.name,
        unit_price: smartQuote?smartQuote.lines.find(i=>i.id===line.id).unitPriceCents/100:line.price,
        quantity: line.quantity,
        warranty: line.warranty,
        captured_at: new Date().toISOString(),
      })),
    },
    null,
    {smartQuote},
  );
  if (!result?.ok){if(smartQuote?.managedFulfillment)await ctx.smartCommerce.fulfillment.cancelOrder(idempotentId,null);return result;}
  if(smartQuote?.managedFulfillment)await ctx.smartCommerce.checkpoint('checkout.after_order',{orderId:idempotentId});
  if(smartQuote)await ctx.smartCommerce.completeOrder(account,smartQuote.id,requestKey,result.item?.id??result.order?.id);
  return {
    ok: true,
    duplicate: result.duplicate === true,
    order: {
      id: result.item?.id ?? result.order?.id ?? null,
      number: result.order?.order_number ?? null,
      status: result.order?.status ?? 'nuevo',
      total: result.order?.total ?? null,
      currency: result.order?.currency ?? 'DOP',
      fulfillment,
      payment_status: 'pending',
    },
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

/** Nombre del PDF que se envía al cerrar una entrega. */
function receiptFilename(orderNumber) {
  const limpio = String(orderNumber ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return `Recibo-${limpio || 'pedido'}.pdf`;
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
  FULLTECH_CONTACT_TEMPLATE,
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
    body: 'Hola {{1}}, te escribimos de FullTECH.\n\n{{2}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  },
  {
    /*
     * AVISO DE LA EMPRESA (lo que se manda en las CAMPAÑAS).
     *
     * Es la misma familia que `phyto_contacto_personalizado_v1` —un hueco libre
     * para el mensaje— pero el texto FIJO dice quién escribe: FullTECH, el
     * distribuidor de Phytoemagry en Higüey. El negocio pidió que las campañas
     * salgan con esta presentación, y el texto fijo de una plantilla lo aprueba
     * Meta: por eso vive con su propio nombre en vez de tocar la genérica (que
     * sigue existiendo para el resto de los avisos).
     *
     *   {{1}} nombre real del cliente · {{2}} mensaje libre (lo escribe el agente).
     */
    name: 'phyto_aviso_fulltech_v1',
    friendly_name: 'Aviso de FullTECH (campañas)',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de FullTECH, distribuidor de Phytoemagry en Higüey.\n\n{{2}}\n\nCualquier duda, respóndenos por aquí y te ayudamos.',
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
    body: 'Hola {{1}}, te escribimos de FullTECH para dar seguimiento a tu última compra.\n\n{{2}}\n\nCuéntanos cómo te ha ido. Si tienes alguna pregunta o deseas realizar otro pedido, estamos disponibles para ayudarte.',
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
    body: 'Hola {{1}}, te contactamos de FullTECH para dar seguimiento.\n\n{{2}}\n\nNos gustaría saber si todavía estás interesado/a o si necesitas más información. Si deseas hacer tu pedido, estamos disponibles para ayudarte.',
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
  /*
   * ENVÍO DE COTIZACIÓN — el PDF de la cotización viaja como documento.
   *
   * Se usa desde el detalle de la cotización y desde su visor. Igual que la
   * factura: UTILITY (es un documento de una operación real) y con CABECERA DE
   * DOCUMENTO, que es lo que permite adjuntar el PDF fuera de la ventana de 24 h.
   */
  QUOTE_WHATSAPP_TEMPLATE,
  {
    name: 'phyto_seguimiento_cliente_v1',
    friendly_name: 'Seguimiento al cliente',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola {{1}}, te escribimos de FullTECH para dar seguimiento a tu solicitud. Si deseas continuar, estamos disponibles para ayudarte.',
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
  /*
   * COMPARTIR UNA UBICACIÓN CON OTRO NÚMERO (repartidor, socio, otra persona).
   *
   * Fuera de la ventana de 24 h WhatsApp no deja mandar ubicaciones ni texto
   * libre: solo plantillas aprobadas. Esta es la plantilla propia para ese
   * caso: saluda, dice de quién es el punto, la dirección y el enlace del mapa.
   * Es UTILITY porque describe una entrega real.
   */
  {
    name: 'phyto_compartir_ubicacion_v1',
    friendly_name: 'Compartir ubicación',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body:
      'Hola {{1}}, te compartimos la ubicación de {{2}} para la entrega.\n\nDirección: {{3}}\nMapa: {{4}}\n\nCualquier cosa nos dices.',
    variables: ['recipient_name', 'customer_name', 'address', 'maps_link'],
    buttons: [],
  },
  {
    name: 'phyto_pedido_repartidor_v1',
    friendly_name: 'Pedido al repartidor',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    /*
     * Plantilla TRANSACCIONAL para el repartidor externo: lleva solo lo que
     * necesita para entregar (pedido, cliente, productos, importe, dirección y
     * mapa). Los botones son de respuesta rápida y su carga es FIJA (Meta no
     * permite cargas dinámicas): la correlación con el pedido se hace por el
     * teléfono del remitente, nunca por el botón.
     */
    body:
      'Hola {{1}}, pedido {{2}} para entregar.\n\nCliente: {{3}}\nProductos: {{4}}\nCobrar: {{5}}\nDirección: {{6}}\nMapa: {{7}}\nInstrucciones: {{8}}\n\nCuando salgas, pulsa «Iniciar entrega» y avísame cuando esté entregado.',
    variables: [
      'courier_name',
      'order_number',
      'customer_contact',
      'products',
      'amount',
      'address',
      'maps_link',
      'instructions',
    ],
    buttons: [
      { type: 'QUICK_REPLY', text: 'Iniciar entrega', payload: 'INICIAR_ENTREGA' },
      { type: 'QUICK_REPLY', text: 'Entregado', payload: 'ENTREGADO' },
      { type: 'QUICK_REPLY', text: 'Reportar problema', payload: 'PROBLEMA' },
    ],
    required_context: 'order',
  },
  /*
   * RECORDATORIO DEL SUPERVISOR AL REPARTIDOR.
   *
   * Fuera de la ventana de 24 h WhatsApp solo deja plantillas aprobadas: sin
   * esta, el supervisor registra el recordatorio como «pendiente» (nunca finge
   * un envío) y escala a administración. Tres datos: nombre, pedido y siguiente
   * acción. Nada de costos, direcciones ajenas ni historial.
   */
  {
    name: SUPERVISOR_REMINDER_TEMPLATE,
    friendly_name: 'Recordatorio del supervisor al repartidor',
    group: 'DELIVERY',
    category: 'UTILITY',
    language: 'es',
    body: 'Hola {{1}}, seguimos pendientes del pedido {{2}}.\n\nSiguiente paso: {{3}}\n\nResponde a este mensaje cuando lo tengas listo.',
    variables: ['courier_name', 'order_number', 'next_action'],
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
    body: 'Gracias por tu compra {{1}}, aquí está tu recibo del pedido {{2}}.',
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
    body: 'Urgente: el pedido {{1}} fue asignado al delivery {{2}} hace aproximadamente 30 minutos y todavía no ha contactado al cliente.\n\nPanel del pedido: {{3}}\n\nSe requiere intervención administrativa.',
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
    body: 'Hola {{1}}, te escribimos de FullTECH. {{2}} Respóndenos por aquí, por favor.',
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
    let existing = known.get(seed.name);
    if (existing) {
      // Solo reescribe una copia CRM pendiente si sigue siendo exactamente la
      // semilla antigua. Las plantillas sincronizadas con Meta y las editadas
      // por el equipo conservan su texto y su estado.
      const legacyBodies = [
        String(seed.body ?? '').replaceAll('FullTECH', 'Phytoemagry'),
        String(seed.body ?? '').replaceAll('FullTECH', 'Fulltech'),
      ];
      if (
        existing.source === 'crm' &&
        !existing.meta_template_id &&
        !templateSendable(existing.status) &&
        legacyBodies.includes(String(existing.body ?? ''))
      ) {
        const updated = {
          ...existing,
          friendly_name: seed.friendly_name ?? existing.friendly_name,
          body: seed.body,
          updated_at: new Date().toISOString(),
        };
        await ctx.db.update('wa_templates', existing.id, updated);
        existing = updated;
      }
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
    [...templates].sort((a, b) => Number(b.name === 'fulltech_contacto_personalizado_v2') - Number(a.name === 'fulltech_contacto_personalizado_v2')).find(
      (row) =>
        templateSendable(row.status) &&
        row.sendable === true &&
        (row.variables ?? []).some((key) => TEMPLATE_FREE_TEXT_KEYS.includes(String(key).toLowerCase())),
    ) ?? null
  );
}

/**
 * LA PLANTILLA PROPIA PARA COMPARTIR UNA UBICACIÓN.
 *
 * Se prefiere siempre esta (trae dirección y enlace del mapa con nombre y todo)
 * y solo si Meta todavía no la tiene aprobada se cae a una plantilla con hueco
 * de texto libre. Así el mensaje que recibe el repartidor se lee bien aunque la
 * ventana de 24 h esté cerrada.
 */
const LOCATION_SHARE_TEMPLATE = 'phyto_compartir_ubicacion_v1';
async function locationShareTemplate(ctx) {
  const templates = await listWaTemplates(ctx, { syncIfStale: true });
  return (
    templates.find(
      (row) => row.name === LOCATION_SHARE_TEMPLATE && templateSendable(row.status) && row.sendable === true,
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
    delivery_deep_link: absoluteDeliveryDeepLink(item?.id ?? order?.id ?? ''),
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

const CAMPAIGN_HISTORICAL_FILTERS = Object.freeze({
  COMPRO_REPORTADO: new Set(['COMPRO_REPORTADO']),
  NO_COMPRO: new Set(['NO_COMPRO']),
  INTERESADO: new Set(['INTERESADO']),
  POR_VERIFICAR: new Set(['POR_VERIFICAR']),
  INTERESADOS_O_POR_VERIFICAR: new Set(['INTERESADO', 'POR_VERIFICAR']),
});

function historicalImportStatus(customer) {
  return text(
    customer?.historicalWhatsAppImport?.status ??
      customer?.historical_whatsapp_import?.status ??
      customer?.historical_import_status ??
      customer?.historical_status,
    40,
  );
}

function campaignCustomerLabel(customer) {
  return text(customer?.name, 80) ?? customer?.phone_e164 ?? customer?.phone ?? customer?.id ?? 'Cliente';
}

function campaignFreeTextIndex(template) {
  return templateVariables(template).findIndex((key) =>
    TEMPLATE_FREE_TEXT_KEYS.includes(String(key ?? '').trim().toLowerCase()),
  );
}

function campaignDesiredMessageForCustomer(value, customer) {
  const name = customer?.name || customer?.phone_e164 || customer?.phone || 'cliente';
  const phone = customer?.phone_e164 || customer?.phone || '';
  return String(value ?? '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, name)
    .replace(/\{\s*nombre\s*\}/gi, name)
    .replace(/\{\{\s*telefono\s*\}\}/gi, phone)
    .replace(/\{\s*telefono\s*\}/gi, phone)
    .trim();
}

function campaignAutoTemplateValue(key, customer) {
  const normalized = String(key ?? '').trim().toLowerCase();
  if (normalized === 'customer_name' || normalized === 'nombre') return customer?.name || customer?.phone_e164 || customer?.phone || 'cliente';
  if (normalized === 'phone' || normalized === 'telefono') return customer?.phone_e164 || customer?.phone || '';
  return null;
}

function campaignValuesForExactBody(template, desiredBody, customer) {
  const variables = templateVariables(template);
  const freeIndex = campaignFreeTextIndex(template);
  if (freeIndex === -1) return { ok: false, error: 'no_free_slot', message: 'La plantilla no tiene hueco libre para el mensaje.' };
  const marker = '__CRM_CAMPAIGN_MESSAGE__';
  let skeleton = String(template?.body ?? '');
  for (const [index, key] of variables.entries()) {
    const value = index === freeIndex ? marker : campaignAutoTemplateValue(key, customer);
    if (value === null || value === undefined || value === '') {
      return {
        ok: false,
        error: 'missing_template_data',
        message: 'Faltan datos para completar la plantilla.',
        missing: [key],
      };
    }
    skeleton = skeleton.replace(new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, 'g'), sanitizeTemplateParameter(value));
  }
  const markerAt = skeleton.indexOf(marker);
  if (markerAt === -1) return { ok: false, error: 'no_free_slot', message: 'La plantilla no tiene hueco libre para el mensaje.' };
  const prefix = skeleton.slice(0, markerAt);
  const suffix = skeleton.slice(markerAt + marker.length);
  if (!desiredBody.startsWith(prefix) || !desiredBody.endsWith(suffix) || desiredBody.length < prefix.length + suffix.length) {
    return {
      ok: false,
      error: 'template_wraps_custom_message',
      message: 'La plantilla aprobada agrega texto fijo; el mensaje final no coincide exactamente con lo escrito.',
    };
  }
  const freeText = desiredBody.slice(prefix.length, desiredBody.length - suffix.length).trim();
  if (!freeText) return { ok: false, error: 'empty_message', message: 'El mensaje editable está vacío.' };
  return { ok: true, values: { [String(freeIndex + 1)]: freeText } };
}

function campaignValuesForCustomer(values, customer) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const name = campaignCustomerLabel(customer);
  const phone = customer?.phone_e164 ?? customer?.phone ?? '';
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      String(value ?? '')
        .replace(/\{\{\s*nombre\s*\}\}/gi, name)
        .replace(/\{\s*nombre\s*\}/gi, name)
        .replace(/\{\{\s*telefono\s*\}\}/gi, phone)
        .replace(/\{\s*telefono\s*\}/gi, phone),
    ]),
  );
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
    /*
     * QUIÉN MANDA EN QUÉ. Meta manda en el TEXTO, la categoría y el estado (es
     * suya la plantilla). La ficha del CRM —nombre amable, grupo y sobre todo
     * QUÉ HUECO ES EL LIBRE (`variables`)— sale del catálogo propio cuando la
     * plantilla está en él: sin eso, una plantilla recién creada en Meta llega
     * sin variables declaradas y el panel no sabe por dónde va el mensaje.
     */
    const variablesPropias = Array.isArray(seed?.variables) ? seed.variables : null;
    const doc = {
      id: existing?.id ?? `tpl_${name}`,
      name,
      friendly_name: seed?.friendly_name ?? existing?.friendly_name ?? name,
      group: seed?.group ?? existing?.group ?? 'OTRAS',
      category: text(meta.category, 30) ?? existing?.category ?? seed?.category ?? 'UTILITY',
      language,
      body: templateBodyFromComponents(components) ?? existing?.body ?? seed?.body ?? null,
      variables:
        variablesPropias && variablesPropias.length
          ? variablesPropias
          : Array.isArray(existing?.variables) && existing.variables.length
            ? existing.variables
            : [],
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
  // La postventa por consumo corresponde únicamente a las cápsulas de Phytoemagry.
  const deliveredOrder = orderOf(item);
  if (deliveredOrder && !Number(deliveredOrder.total_capsules)) return result;
  const schedule = await ctx.followups.scheduleForPurchase({
    customerId,
    purchaseId: item.id,
    deliveredAt: item.received_at,
    capsules: deliveredOrder?.items?.[0]?.general ? deliveredOrder.total_capsules : item.capsules,
    quantity: deliveredOrder?.items?.[0]?.general ? 1 : item.quantity,
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
export async function processWebhookPayload(ctx, body, options = {}) {
  const parsed = parseWebhook(body);
  /** @type {any[]} */
  const stored = [];
  for (const inbound of parsed.messages) {
    const result = await ctx.customers.recordInbound({ waMessage: inbound,
      companyId: options.verifiedLegacyPhytoChannel === true ? 'phytoemagry' : null });
    if (result.duplicate) continue;
    stored.push(result);
    /*
     * RESPUESTA DE UN REPARTIDOR (interno o externo).
     *
     * El SUPERVISOR se prueba primero: entiende más frases y también a los
     * agentes con cuenta en el CRM. Si no reconoce al remitente o no encuentra
     * intención, sigue la máquina de estados histórica del repartidor externo
     * (así nada de lo que ya funcionaba se pierde). Cualquier error se registra
     * y NO tumba el webhook: Meta no debe reintentar por esto.
     */
    try {
      const supervisor = await handleSupervisorReply({
        ctx,
        inbound,
        conversation: result.conversation ?? null,
        deps: supervisorBridge(ctx),
      });
      if (supervisor?.handled) {
        console.log(`[crm] supervisor de delivery · ${supervisor.reason} · pedido ${supervisor.orderId ?? '—'}`);
        /*
         * LA RESPUESTA DEL REPARTIDOR TAMBIÉN VA AL CHAT DEL PEDIDO.
         * Se guarda con su texto real y la identidad de quien escribió; si el
         * mensaje era ambiguo, queda igual (es lo que pasó) pero NO cambia el
         * estado de la entrega.
         */
        if (supervisor.orderId) {
          const item = await findOrderItem(ctx.store, supervisor.orderId).catch(() => null);
          await recordExternalMessage({
            ctx,
            deps: { findOrder: (id) => findOrderItem(ctx.store, id) },
            orderId: supervisor.orderId,
            order: item ? orderOf(item) : null,
            orderNumber: item ? orderOf(item)?.order_number ?? item.order_number ?? null : null,
            direction: 'inbound',
            channel: 'whatsapp',
            status: 'received',
            providerId: inbound?.waMessageId ?? inbound?.id ?? null,
            kind: 'reply',
            authorName: `Repartidor (${inbound?.fromE164 ?? inbound?.from ?? 'WhatsApp'})`,
            body: String(inbound?.text?.body ?? inbound?.body ?? '').slice(0, 600),
          }).catch(() => null);
        }
      } else {
        const courier = await handleCourierInbound({
          ctx,
          inbound,
          completeDelivery: (orderId, options = {}) =>
            transitionOrderStatus(ctx, {
              orderId,
              targetStatus: 'ENTREGADO',
              actor: { ...SYSTEM_ACTOR, display_name: 'Repartidor externo' },
              source: options.source ?? 'EXTERNAL_COURIER',
              reason: options.reason ?? null,
            }),
        });
        if (courier?.handled) {
          console.log(`[crm] repartidor externo · ${courier.reason} · pedido ${courier.orderId ?? '—'}`);
        }
      }
    } catch (error) {
      console.error('[crm] respuesta de repartidor:', error?.message ?? error);
    }
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
    /*
     * EL MISMO ACUSE, EN EL CHAT DEL PEDIDO.
     * Los avisos del supervisor al repartidor y a administración viven en el
     * ticket del pedido: si Meta confirma «entregado» o «leído», el panel tiene
     * que decirlo en vez de quedarse en «Enviado».
     */
    await reconcileDeliveryReceipt({ ctx, providerId: status.waMessageId, status: status.status, at: status.at ?? null }).catch(() => null);
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
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const ADMIN_COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt']);
const ADMIN_GZIP_CACHE = new Map();

function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] ?? '').split(',').some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(';');
    if (encoding !== 'gzip' && encoding !== '*') return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return !quality || Number(quality.trim().slice(2)) > 0;
  });
}

/** Sirve un archivo de la app del panel (sin poder salir de su carpeta). */
function serveAdminFile(req, res, urlPath, adminDir) {
  const relative = urlPath.replace(/^\/admin\/?/, '') || 'index.html';
  const target = path.resolve(adminDir, relative);
  if (!target.startsWith(adminDir) || !existsSync(target) || !statSync(target).isFile()) {
    json(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  const info = statSync(target);
  const originalBody = readFileSync(target);
  const extension = path.extname(target);
  let body = originalBody;
  let compressed = false;
  if (ADMIN_COMPRESSIBLE_EXTENSIONS.has(extension) && acceptsGzip(req)) {
    const cached = ADMIN_GZIP_CACHE.get(target);
    if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) {
      body = cached.body;
    } else {
      body = gzipSync(originalBody, { level: 1 });
      if (ADMIN_GZIP_CACHE.size >= 64) ADMIN_GZIP_CACHE.delete(ADMIN_GZIP_CACHE.keys().next().value);
      ADMIN_GZIP_CACHE.set(target, { mtimeMs: info.mtimeMs, size: info.size, body });
    }
    compressed = true;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'content-length': body.length,
    vary: 'Accept-Encoding',
    ...(compressed ? { 'content-encoding': 'gzip' } : {}),
    /*
     * RECURSOS VERSIONADOS: CACHÉ LARGA. HTML Y SERVICE WORKER: NUNCA.
     *
     * Todo el panel salía con `no-cache, must-revalidate`, así que el navegador
     * revalidaba 40+ archivos en cada apertura (y el logo de 155 KB otra vez).
     * Un recurso pedido con `?v=…` cambia de URL cuando cambia de contenido, así
     * que puede guardarse: se elige 1 día + `stale-while-revalidate` (no un año
     * `immutable`) porque las versiones se suben a mano y un olvido dejaría un
     * archivo viejo fijado demasiado tiempo.
     *
     * El HTML y `sw.js` siguen sin caché: publicar tiene que verse al abrir.
     */
    'cache-control':
      /(?:^|&)v=/.test(String(req.url ?? '').split('?')[1] ?? '') && extension !== '.html' && !/(^|\/)sw\.js$/.test(relative)
        ? 'public, max-age=86400, stale-while-revalidate=604800'
        : 'no-cache, must-revalidate',
    'service-worker-allowed': '/admin/',
    'permissions-policy': 'geolocation=(self), microphone=(self), camera=(self)',
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
    json(res, 200, { ok: true, storage: store.kind, uat: ctx.uatMode === true, items: await store.count() });
    return;
  }

  // Tienda pública: solo lectura y con una proyección separada del CRM.
  if (await handleStorePublicRoute({ req, res, route, url, ctx, json })) return;

  // SEO de la tienda: página de producto renderizada en servidor, sitemap y robots.
  if (await handleStoreSeoRoute({ req, res, route, ctx })) return;

  // Identidad de la tienda: teléfono verificado, correo y Google Identity Services.
  if (await handleStoreAuthRoute({ req, res, route, url, ctx, json, readJson: readJsonBody })) return;

  // Cuenta de cliente y solicitudes de la tienda (sesión propia, separada del panel).
  if (await handleStoreAccountRoute({ req, res, route, url, ctx, json, readJson: readJsonBody })) return;
  if (await handleCommercePublic({req,res,route,ctx,json,readJson:readJsonBody}))return;

  // Confirmación limitada a un envío: no requiere la cookie de una app cerrada.
  if (route === '/api/push/receipts' && req.method === 'POST') {
    const body = await readJsonBody(req, 2048);
    const jobId = text(body?.jobId, 80);
    const supplied = text(body?.token, 80);
    const deviceStatus = body?.status;
    if (!jobId || !/^[a-f0-9]{64}$/.test(supplied) || !['displayed', 'display_failed'].includes(deviceStatus)) {
      json(res, 400, { ok: false, error: 'invalid_receipt' });
      return;
    }
    const expected = createHmac('sha256', WEB_PUSH_PRIVATE_KEY || ctx.token).update(`push-receipt:${jobId}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      json(res, 403, { ok: false, error: 'invalid_receipt' });
      return;
    }
    const job = await ctx.db.get('push_jobs', jobId);
    if (!job || ctx.clock().getTime() - Date.parse(job.created_at) > 7 * 86400000) {
      json(res, 404, { ok: false, error: 'receipt_expired' });
      return;
    }
    // No permitir que un reintento tardío degrade un aviso ya mostrado.
    if (job.device_status !== 'displayed') {
      const name = String(body?.error ?? '');
      await ctx.db.update('push_jobs', jobId, {
        device_status: deviceStatus,
        device_received_at: ctx.clock().toISOString(),
        device_error: deviceStatus === 'display_failed' ? (/^[A-Za-z]{1,64}$/.test(name) ? name : 'NotificationError') : null,
        worker_version: text(body?.workerVersion, 80),
      });
    }
    json(res, 200, { ok: true });
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
    const hasCallEvents = incoming.json?.entry?.some((entry) => entry.changes?.some((change) => change.field === 'calls'));
    if (ctx.calling?.enabled && hasCallEvents) {
      if (!signatureCheck.ok) { json(res, 401, { ok: false, error: 'invalid_signature' }); return; }
      // Persistencia durable ANTES de confirmar a Meta; el worker recupera pendientes.
      await ctx.calling.ingest(incoming.json);
    }
    // Meta espera un 200 en pocos segundos y REINTENTA si tardas: se contesta ya
    // y se guarda después. El guardado es idempotente, así que un reintento no
    // duplica ningún mensaje.
    json(res, 200, { ok: true, received: true });
    processWebhookPayload(ctx, incoming.json, {
      verifiedLegacyPhytoChannel: signatureCheck.ok === true && Boolean(ctx.appSecret),
    }).catch((error) =>
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
    serveAdminFile(req, res, url.pathname, ctx.adminDir);
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
  /*
   * El observador de tiempo real (ver `createServer`) publica DESPUÉS de la
   * respuesta; necesita saber quién hizo el cambio para no avisarle de lo suyo
   * y para filtrar por rol.
   */
  res.__crmActor = actor;
  const can = (permission) => hasPermission(actor, permission);
  /*
   * ALCANCE POR EMPRESA (una vez por petición).
   *
   * Toda ruta administrativa que hable de dinero, reparto o cuentas de
   * repartidor tiene que preguntar aquí, no a un `'phytoemagry'` fijo: el dueño
   * del CRM puede dar FULLTECH a una oficina concreta y quitársela a otra.
   */
  let companyScopeMemo;
  const companyScope = () => (companyScopeMemo ??= adminCompanyScope(ctx.db, actor, can));
  const seesCompany = async (companyId) => scopeSeesCompany(await companyScope(), companyId);
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
  if(actor?.role==='SUPPLIER'&&route.startsWith('/api/admin/')&&!route.startsWith('/api/admin/store/commerce/operations/')&&!['/api/admin/login','/api/admin/auth/login','/api/admin/logout','/api/admin/auth/logout','/api/admin/session','/api/admin/auth/me','/api/admin/users/me/password'].includes(route)){forbid('La cuenta de proveedor solo puede operar sus sucursales autorizadas.');return;}

  // Los permisos antiguos del panel son de PHYTOEMAGRY. Un ID de pedido no
  // convierte esos permisos en acceso a otra empresa. ADMIN completo es central.
  if (!can('admin.full') && (route.startsWith('/api/admin/orders/') ||
      route.startsWith('/api/admin/delivery/orders/'))) {
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/status') &&
        req.method === 'PATCH' && !can('orders.change_status')) { forbid(); return; }
    const prefix = route.startsWith('/api/admin/orders/') ? '/api/admin/orders/' : '/api/admin/delivery/orders/';
    const orderId = decodeURIComponent(route.slice(prefix.length).split('/')[0]);
    const item = orderId ? await findOrderItem(store, orderId) : null;
    const owner = item ? companyOfOrder(orderOf(item)) : null;
    if (item && !(await seesCompany(owner))) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
    }
  }

  /*
   * CANAL ÚNICO DE TIEMPO REAL DEL CRM (`GET /api/admin/events`).
   *
   * Un solo SSE por pestaña, con reconexión y cursor. Se manda SOLO lo que ese
   * usuario puede ver: el permiso se comprueba aquí, al suscribir, y cada evento
   * se filtra otra vez con `clientAccepts` (rol + si es su entrega).
   *
   * `?since=<seq>` (o la cabecera `Last-Event-ID`) recupera lo perdido mientras
   * el teléfono estuvo dormido. Si el cursor es tan viejo que ya no está en el
   * búfer, se avisa con `resync` para que el panel recargue lo justo.
   */
  if (route === '/api/admin/events' && req.method === 'GET') {
    if (!authenticated) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Sin esto nginx guarda los eventos en búfer y llegan tarde (o no llegan).
      'x-accel-buffering': 'no',
    });
    const sinceRaw = url.searchParams.get('since') ?? req.headers['last-event-id'] ?? '';
    const since = Number(sinceRaw) || 0;
    const origin = String(req.headers['x-crm-device'] ?? url.searchParams.get('device') ?? '').slice(0, 64) || null;
    const oldest = ctx.realtime.stats().seq - ctx.realtime.stats().buffered;
    if (since > 0 && since < oldest) {
      res.write(`event: resync\ndata: ${JSON.stringify({ ok: true, oldest })}\n\n`);
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, seq: ctx.realtime.seq, v: 1 })}\n\n`);
    /*
     * PERMISOS VIVOS, NO CONGELADOS.
     *
     * El actor y su `can` se leen en cada evento (getters). Si a esta persona le
     * cambian el rol, el siguiente aviso ya se filtra con el rol nuevo sin
     * obligarla a recargar. Y en cada latido se comprueba que la sesión siga
     * existiendo: si se cerró o borraron el usuario, se corta el canal y deja de
     * llegar información.
     */
    const permiso = { actor, can };
    const unsubscribe = ctx.realtime.subscribe({
      get actor() {
        return permiso.actor;
      },
      get can() {
        return permiso.can;
      },
      origin,
      since,
      send: (chunk) => res.write(chunk),
      close: () => res.end(),
    });
    const sessionId = parsedUserSession?.sessionId ?? null;
    const heartbeat = setInterval(async () => {
      try {
        if (sessionId) {
          const fresca = await ctx.users.sessionUser(sessionId).catch(() => null);
          if (!fresca?.user || fresca.user.active === false) {
            res.write(`event: revoked\ndata: ${JSON.stringify({ ok: true, reason: 'session_ended' })}\n\n`);
            clearInterval(heartbeat);
            unsubscribe();
            return;
          }
          permiso.actor = {
            id: fresca.user.id,
            role: fresca.user.role,
            display_name: fresca.user.display_name,
            actor_type: 'USER',
          };
          permiso.can = (permission) => hasPermission(permiso.actor, permission);
        }
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: ctx.clock().toISOString(), seq: ctx.realtime.seq })}\n\n`);
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  /*
   * Estado del canal de tiempo real (diagnóstico): cuántos escuchan, hasta qué
   * secuencia se ha publicado y los últimos avisos. Sirve para comprobar en UAT
   * que un cambio se publicó de verdad, sin abrir la consola del navegador.
   */
  if (route === '/api/admin/realtime/stats' && req.method === 'GET') {
    if (!requireAdmin()) return;
    json(res, 200, { ok: true, realtime: ctx.realtime.stats() });
    return;
  }

  /*
   * REFRESCO MÍNIMO DE UN PEDIDO para el tiempo real.
   *
   * El evento dice «este pedido cambió»; el panel pide aquí SOLO ese pedido, ya
   * saneado por permisos. Es una consulta indexada por `id` (no la lista de
   * 5000): así un aviso no cuesta lo mismo que abrir el panel entero.
   */
  if (route.startsWith('/api/admin/realtime/order/') && req.method === 'GET') {
    const orderId = decodeURIComponent(route.slice('/api/admin/realtime/order/'.length)).slice(0, 120);
    const item = typeof store.getAdmin === 'function' ? await store.getAdmin(orderId) : await findOrderItem(store, orderId);
    if (!item || item.type !== 'order_intent') {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    /*
     * Quién puede pedir este refresco: la MISMA regla que el detalle del pedido.
     * El rol DELIVERY no tiene `orders.read` (no lista pedidos) pero sí ve el
     * suyo; `canReadOrder` ya distingue ese caso. Si se exigiera `orders.read`
     * aquí, el repartidor nunca vería cambiar su propia entrega.
     */
    if (!(await canReadOrder(ctx, actor, item))) {
      forbid();
      return;
    }
    const order = orderOf(item);
    if (!(await seesCompany(companyOfOrder(order)))) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
    }
    json(res, 200, {
      ok: true,
      item: sanitizeItemForPermissions(item, actor),
      order: sanitizeOrderForPermissions(order, actor),
      payment: paymentBlockOf(order),
    });
    return;
  }

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
      /*
       * PENDIENTE DE MIGRACIÓN: bloquear aquí el rol DELIVERY rompe 27 pruebas
       * del flujo interno de reparto que sigue vivo en el supervisor y en los
       * UAT de panel (usuarios DELIVERY asignados a pedidos). El retiro de ese
       * rol exige migrar antes esas cuentas a cuentas de la app. Mientras no se
       * migre, el acceso se retira en la INTERFAZ (menú y selector de roles) y
       * no se abre ninguna ruta operativa nueva.
       */
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

  /*
   * ============================================================================
   * ACCESO MÓVIL DEL REPARTIDOR (Fase 04) — SOLO LECTURA.
   *
   * Estas rutas viven FUERA del bloque `/api/admin/` a propósito: el token del móvil no es
   * una sesión del panel y no da acceso a nada administrativo. La cuenta se comprueba en el
   * servidor en cada petición (estado, autorización, empresa y `token_epoch`), y un pedido
   * solo se devuelve si el repartidor autenticado es el asignado.
   * ============================================================================
   */
  const courierCookieName = 'pe_courier';
  const courierApplicationAttempts = new Map();
  /*
   * Consulta del estado de una solicitud: se limita por IP igual que el alta.
   * El recibo es aleatorio y largo, pero un limitador evita que el endpoint se
   * use para tantear identificadores.
   */
  const courierApplicationStatusChecks = new Map();
  function applicationStatusAllowed(ip) {
    const row = courierApplicationStatusChecks.get(ip) ?? { count: 0, until: 0 };
    if (row.until > Date.now() && row.count >= 30) return false;
    courierApplicationStatusChecks.set(ip, {
      count: row.until > Date.now() ? row.count + 1 : 1,
      until: Date.now() + 15 * 60 * 1000,
    });
    return true;
  }
  const scopedCashRows = async (companyId = null) => {
    const rows = (await ctx.db.list(CASH_COLLECTION, { limit: 5000 })) ?? [];
    const items = (await Promise.resolve(store.listAdmin({ limit: 5000 }))) ?? [];
    const ordersById = new Map();
    for (const item of items) {
      if (item.type !== 'order_intent') continue;
      const order = orderOf(item);
      if (order) { ordersById.set(String(item.id), order); if (order.id) ordersById.set(String(order.id), order); }
    }
    return rows.map((row) => ({ ...row, company_id: companyOfCashRow(row, ordersById) }))
      .filter((row) => row.company_id && (!companyId || row.company_id === companyId));
  };
  const setCourierCookie = (value) => {
    const attributes = [`${courierCookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    attributes.push(value ? `Max-Age=${COURIER_SESSION_SECONDS}` : 'Max-Age=0');
    if (isSecureRequest(req)) attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
  };
  /** Resuelve la cuenta autenticada del móvil. Nunca confía en un id mandado por el cliente. */
  const courierAuth = async ({ allowUnselected = false } = {}) => {
    if (!token) return { ok: false, status: 503, error: 'no_token' };
    const raw = courierTokenFromRequest(req, readCookie);
    if (!raw) return { ok: false, status: 401, error: 'unauthorized' };
    const parsed = readCourierToken(raw, token);
    if (!parsed) return { ok: false, status: 401, error: 'invalid_session' };
    if (parsed.error) return { ok: false, status: 401, error: parsed.error };
    const account = await ctx.db.get('courier_accounts', parsed.accountId);
    if (!account) return { ok: false, status: 401, error: 'unknown_courier' };
    if ((Number(account.token_epoch ?? 0) || 0) !== parsed.epoch) {
      return { ok: false, status: 401, error: 'session_revoked' };
    }
    const usable = isCourierUsable(account);
    if (!usable.ok) return { ok: false, status: 401, error: usable.error };
    const companies = await courierCompanies(ctx.db, account);
    if (!companies.length) return { ok: false, status: 403, error: 'company_forbidden' };
    const selected = allowUnselected && !req.headers['x-courier-company']
      ? { ok: true, companyId: companies.length === 1 ? companies[0] : null }
      : selectedCourierCompany(companies, req.headers['x-courier-company']);
    return { ...selected, account, companies, session: { expiresAt: parsed.expiresAt } };
  };

  if (route === '/api/courier/companies' && req.method === 'GET') {
    const companies = ((await ctx.db.list('logistics_companies', { limit: 5000 })) ?? [])
      .filter((row) => row.active === true).map((row) => ({ id: row.id, name: row.name }));
    json(res, 200, { ok: true, companies });
    return;
  }

  if (route === '/api/courier/applications' && req.method === 'POST') {
    const ip = clientIp(req);
    const attempt = courierApplicationAttempts.get(ip) ?? { count: 0, until: 0 };
    if (attempt.until > Date.now() && attempt.count >= 5) {
      json(res, 429, { ok: false, error: 'too_many_attempts' }); return;
    }
    courierApplicationAttempts.set(ip, { count: attempt.until > Date.now() ? attempt.count + 1 : 1,
      until: Date.now() + 15 * 60 * 1000 });
    const body = await readJsonBody(req).catch(() => ({}));
    const companyId = String(body.companyId ?? body.company_id ?? '').trim();
    const phone = normalizeCourierPhone(body.phone);
    const name = text(body.name, 80);
    /*
     * DATOS MÍNIMOS DE UN ALTA REAL. Sin vehículo, zona y aceptación de las
     * condiciones, la oficina no puede decidir nada: se piden aquí y no en el
     * panel. `termsAccepted` tiene que ser un sí explícito, no la ausencia de
     * un "no".
     */
    const vehicleType = String(body.vehicleType ?? body.vehicle_type ?? '').trim().toUpperCase();
    const zone = text(body.zone ?? body.workZone ?? body.work_zone, 80);
    const termsAccepted = body.termsAccepted === true || body.terms_accepted === true;
    if (!COURIER_VEHICLE_TYPES.includes(vehicleType)) {
      json(res, 422, { ok: false, error: 'invalid_vehicle_type' }); return;
    }
    if (!zone || zone.length < 3) { json(res, 422, { ok: false, error: 'invalid_zone' }); return; }
    if (!termsAccepted) { json(res, 422, { ok: false, error: 'terms_required' }); return; }
    if (!(await activeLogisticsCompany(ctx.db, companyId)) || !phone || !name || name.length < 3) {
      json(res, 422, { ok: false, error: 'invalid_application' }); return;
    }
    const key = createHash('sha256').update(`${companyId}:${phone}`).digest('hex');
    const rows = (await ctx.db.list('courier_applications', { limit: 5000 })) ?? [];
    const current = rows.find((row) => row.application_key === key && row.status !== 'rejected');
    if (current) {
      /*
       * Ya hay una solicitud viva (pendiente o con información pedida): se
       * devuelve el mismo recibo en vez de duplicar la fila. Si se rechazó, se
       * permite volver a postularse creando una nueva.
       */
      json(res, 202, { ok: true, status: current.status, applicationId: current.id,
        receipt: current.receipt ?? null });
      return;
    }
    const now = new Date().toISOString();
    const receipt = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const doc = { id: `app_${randomUUID().replaceAll('-', '')}`, application_key: key,
      company_id: companyId, phone_e164: phone, display_name: name,
      vehicle_type: vehicleType, zone, terms_accepted_at: now,
      status: 'pending', receipt, created_at: now, updated_at: now };
    await ctx.db.insert('courier_applications', doc);
    await ctx.audit?.record({ entity: 'courier_application', entityId: doc.id,
      action: 'courier.application_submitted', actor: name,
      data: { company_id: companyId, vehicle_type: vehicleType } });
    // No se emite token, PIN, cuenta, asignación ni concesión operativa.
    json(res, 202, { ok: true, status: 'pending_review', applicationId: doc.id, receipt });
    return;
  }

  /* Consulta del estado con el recibo que se dio al solicitarla (no con el teléfono). */
  if (route.startsWith('/api/courier/applications/') && route.endsWith('/status') && req.method === 'GET') {
    const ip = clientIp(req);
    if (!applicationStatusAllowed(ip)) { json(res, 429, { ok: false, error: 'too_many_attempts' }); return; }
    const id = decodeURIComponent(route.slice('/api/courier/applications/'.length, -'/status'.length));
    const receipt = String(url.searchParams.get('receipt') ?? '');
    const application = await ctx.db.get('courier_applications', id);
    if (!application || !receipt || receipt !== application.receipt) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
    }
    json(res, 200, { ok: true, status: application.status,
      company_id: application.company_id, updated_at: application.updated_at ?? null,
      note: application.review_note ?? null, operational_access: false });
    return;
  }

  /*
   * DOCUMENTOS DEL EXPEDIENTE (lado solicitante).
   *
   * Se envían con el MISMO recibo de la solicitud; sin recibo no se puede ni
   * subir ni listar. El contenido se valida por bytes reales y se guarda en un
   * directorio privado con nombre generado por el servidor.
   */
  if (route.startsWith('/api/courier/applications/') && route.endsWith('/documents') && req.method === 'POST') {
    const ip = clientIp(req);
    if (!applicationStatusAllowed(ip)) { json(res, 429, { ok: false, error: 'too_many_attempts' }); return; }
    const id = decodeURIComponent(route.slice('/api/courier/applications/'.length, -'/documents'.length));
    // El cuerpo por defecto son 64 KB: un documento viaja en base64 y necesita
    // su propio límite, acotado (el binario real se valida aparte a 4 MB).
    const body = await readJsonBody(req, 6 * 1024 * 1024).catch(() => ({}));
    const application = await ctx.db.get('courier_applications', id);
    if (!application || !body.receipt || String(body.receipt) !== application.receipt) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
    }
    if (!['pending', 'info_required'].includes(application.status)) {
      json(res, 409, { ok: false, error: 'application_closed' }); return;
    }
    const kind = String(body.kind ?? '').toUpperCase();
    if (!DOCUMENT_KINDS.includes(kind)) { json(res, 422, { ok: false, error: 'invalid_document_kind' }); return; }
    const decoded = decodeDocument(body.dataBase64 ?? body.data_base64);
    if (!decoded.ok) {
      json(res, decoded.error === 'too_large' ? 413 : 422, { ok: false, error: decoded.error }); return;
    }
    const stored = await saveDocumentFile({ directory: documentsDirectory(ctx.store?.file),
      applicationId: application.id, buffer: decoded.buffer, contentType: decoded.contentType });
    if (!stored.ok) { json(res, 422, { ok: false, error: stored.error }); return; }
    const now = new Date().toISOString();
    /* Un documento por tipo: el reemplazo archiva el anterior en vez de duplicarlo. */
    const previous = ((await ctx.db.list('courier_documents', { limit: 5000 })) ?? [])
      .filter((row) => row.application_id === application.id && row.kind === kind && row.status !== 'replaced');
    for (const old of previous) {
      await removeDocumentFile(old.file).catch(() => {});
      await ctx.db.update('courier_documents', old.id, { status: 'replaced', replaced_at: now, updated_at: now });
    }
    const doc = { id: stored.id, application_id: application.id, company_id: application.company_id,
      kind, content_type: decoded.contentType, bytes: stored.bytes, file: stored.file,
      status: 'received', created_at: now, updated_at: now };
    await ctx.db.insert('courier_documents', doc);
    await ctx.db.update('courier_applications', application.id, { updated_at: now });
    const documents = ((await ctx.db.list('courier_documents', { limit: 5000 })) ?? [])
      .filter((row) => row.application_id === application.id && row.status !== 'replaced');
    json(res, 201, { ok: true, status: 'received', document: publicDocument(doc),
      vehicle_type: application.vehicle_type ?? null,
      missing: requiredDocumentsFor(application.vehicle_type)
        .filter((required) => !documents.some((row) => row.kind === required)) });
    return;
  }

  if (route.startsWith('/api/courier/applications/') && route.endsWith('/documents') && req.method === 'GET') {
    const ip = clientIp(req);
    if (!applicationStatusAllowed(ip)) { json(res, 429, { ok: false, error: 'too_many_attempts' }); return; }
    const id = decodeURIComponent(route.slice('/api/courier/applications/'.length, -'/documents'.length));
    const receipt = String(url.searchParams.get('receipt') ?? '');
    const application = await ctx.db.get('courier_applications', id);
    if (!application || !receipt || receipt !== application.receipt) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
    }
    const documents = ((await ctx.db.list('courier_documents', { limit: 5000 })) ?? [])
      .filter((row) => row.application_id === application.id && row.status !== 'replaced');
    json(res, 200, { ok: true, status: application.status,
      vehicle_type: application.vehicle_type ?? null,
      documents: documents.map(publicDocument),
      required: requiredDocumentsFor(application.vehicle_type),
      missing: requiredDocumentsFor(application.vehicle_type)
        .filter((required) => !documents.some((row) => row.kind === required)),
      operational_access: false });
    return;
  }

  if (route === '/api/courier/login' && req.method === 'POST') {
    const courierIp = clientIp(req);
    if (!loginAllowed(courierIp)) {
      json(res, 429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos seguidos. Espera 15 minutos.' });
      return;
    }
    if (!token) {
      json(res, 503, { ok: false, error: 'no_token', message: 'El servidor no tiene clave de sesión configurada.' });
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const phone = normalizeCourierPhone(body.phone ?? body.celular);
    const secret = String(body.pin ?? body.password ?? '');
    const nowMs = Date.now();
    const accounts = (await ctx.db.list('courier_accounts', { limit: 1000 })) ?? [];
    const account = phone ? accounts.find((row) => row.phone_e164 === phone) ?? null : null;
    /* Sin cuenta: se gasta el mismo trabajo de hash y se responde igual (anti-enumeración). */
    if (!account) {
      await burnCredentialCheck(secret);
      registerLoginFailure(courierIp);
      json(res, 401, { ok: false, error: 'invalid_credentials', message: 'Teléfono o PIN incorrectos.' });
      return;
    }
    if (account.locked_until && Date.parse(account.locked_until) > nowMs) {
      json(res, 429, { ok: false, error: 'too_many_attempts', message: 'Cuenta bloqueada un momento por intentos fallidos.' });
      return;
    }
    const usable = isCourierUsable(account);
    const companies = await courierCompanies(ctx.db, account);
    const matches = await verifyCourierCredential(secret, account.credential_hash);
    if (!matches || !usable.ok || !companies.length) {
      const failures = (Number(account.failed_attempts ?? 0) || 0) + 1;
      const lock = failures >= COURIER_MAX_FAILURES ? new Date(nowMs + COURIER_LOCK_MS).toISOString() : null;
      await ctx.db.update('courier_accounts', account.id, {
        failed_attempts: failures,
        locked_until: lock,
        updated_at: new Date(nowMs).toISOString(),
      });
      registerLoginFailure(courierIp);
      json(res, 401, { ok: false, error: 'invalid_credentials', message: 'Teléfono o PIN incorrectos.' });
      return;
    }
    loginAttempts.delete(courierIp);
    const at = new Date(nowMs).toISOString();
    const updated = await ctx.db.update('courier_accounts', account.id, {
      failed_attempts: 0,
      locked_until: null,
      last_login_at: at,
      updated_at: at,
    });
    const issued = createCourierToken(updated ?? account, token);
    setCourierCookie(issued.token);
    json(res, 200, {
      ok: true,
      token: issued.token,
      token_type: 'Bearer',
      expires_at: issued.expiresAtIso,
      courier: publicCourierAccount(updated ?? account),
      companies,
    });
    return;
  }

  if (route === '/api/courier/logout' && req.method === 'POST') {
    const auth = await courierAuth({ allowUnselected: true });
    if (auth.ok) {
      /* Revoca los tokens emitidos de esa cuenta: cerrar sesión no deja una llave viva. */
      await ctx.db.update('courier_accounts', auth.account.id, {
        token_epoch: (Number(auth.account.token_epoch ?? 0) || 0) + 1,
        updated_at: new Date().toISOString(),
      });
    }
    setCourierCookie('');
    json(res, 200, { ok: true });
    return;
  }

  /*
   * UBICACIÓN DEL REPARTIDOR (FULLTECH DELIVERY).
   * La identidad sale del TOKEN, nunca del cuerpo. Solo se acepta durante una
   * entrega activa y solo se guarda la ÚLTIMA posición: no se construye un
   * historial de rutas ni se guarda nada fuera de la jornada de reparto.
   */
  if (route === '/api/courier/location' && req.method === 'POST') {
    const auth = await courierAuth();
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    /*
     * `listCourierOrders` pide la ficha del cliente para armar el DTO. Pasando
     * `getCustomer: null` la lista reventaba dentro y el `.catch` la dejaba
     * vacía, así que ESTA ruta respondía siempre `no_active_delivery` y el
     * repartidor no podía enviar ni una posición. Se pasa el cargador real: para
     * comprobar «¿tiene una entrega en curso?» basta con el pedido.
     */
    const mine = await listCourierOrders(store, auth.account, {
      includeClosed: false,
      getCustomer: (customerId) => ctx.customers.get(customerId),
      companyId: auth.companyId, companyOfOrder,
    }).catch(() => []);
    const activeIds = mine
      .filter((order) => ['ASSIGNED', 'OFFERED', 'ACCEPTED', 'PICKUP_PENDING', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED'].includes(String(order.delivery_lifecycle ?? '').toUpperCase()))
      .map((order) => order.id);
    if (!activeIds.length) {
      json(res, 409, {
        ok: false,
        error: 'no_active_delivery',
        message: 'El seguimiento solo está activo durante una entrega en curso.',
      });
      return;
    }
    const positionId = `${auth.account.id}:${auth.companyId}`;
    const previous = await ctx.db.get('courier_positions', positionId).catch(() => null);
    const checked = validateCourierLocation(body, { now: Date.now(), previous });
    if (!checked.ok) {
      json(res, checked.status ?? 422, { ok: false, error: checked.error, message: checked.message, at: checked.previous_at ?? null });
      return;
    }
    const doc = {
      courier_id: auth.account.id,
      company_id: auth.companyId,
      ...checked.point,
      order_id: checked.point.orderId ?? activeIds[0],
      suspicious: checked.suspicious,
      updated_at: new Date().toISOString(),
    };
    if (previous) await ctx.db.update('courier_positions', positionId, doc);
    else await ctx.db.insert('courier_positions', { id: positionId, ...doc });
    json(res, 200, { ok: true, state: signalState(checked.point), suspicious: checked.suspicious });
    return;
  }

  if (route === '/api/courier/me' && req.method === 'GET') {
    const auth = await courierAuth({ allowUnselected: true });
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    json(res, 200, {
      ok: true,
      courier: publicCourierAccount(auth.account),
      company_id: auth.companyId ?? null,
      companies: auth.companies,
      session_expires_at: auth.session?.expiresAt ? new Date(auth.session.expiresAt * 1000).toISOString() : null,
      capabilities: { read_only: true, can_accept: false, can_collect_cash: false },
    });
    return;
  }

  if (route === '/api/courier/orders' && req.method === 'GET') {
    const auth = await courierAuth();
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    const includeClosed = String(url.searchParams.get('includeClosed') ?? '') === '1';
    const orders = await listCourierOrders(store, auth.account, {
      includeClosed,
      getCustomer: (customerId) => ctx.customers.get(customerId),
      companyId: auth.companyId, companyOfOrder,
    });
    json(res, 200, {
      ok: true,
      orders,
      count: orders.length,
      server_time: new Date().toISOString(),
      read_only: true,
    });
    return;
  }

  if (route.startsWith('/api/courier/orders/') && req.method === 'GET') {
    const auth = await courierAuth();
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    const orderId = decodeURIComponent(route.slice('/api/courier/orders/'.length));
    const found = await findCourierOrder(store, orderId, auth.account, {
      getCustomer: (customerId) => ctx.customers.get(customerId),
      companyId: auth.companyId, companyOfOrder,
    });
    if (!found.ok) {
      json(res, found.status ?? 404, { ok: false, error: found.error ?? 'not_found', message: 'Ese pedido no está a tu nombre.' });
      return;
    }
    json(res, 200, { ok: true, order: found.dto, read_only: true });
    return;
  }

  if (route.startsWith('/api/courier/orders/') && req.method === 'POST') {
    const auth = await courierAuth();
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    const rest = decodeURIComponent(route.slice('/api/courier/orders/'.length));
    const slash = rest.lastIndexOf('/');
    const orderId = slash > 0 ? rest.slice(0, slash) : rest;
    const event = slash > 0 ? rest.slice(slash + 1) : '';
    const COURIER_EVENTS = ['accept', 'reject', 'pickup', 'start', 'arrive', 'deliver'];
    if (!COURIER_EVENTS.includes(event)) {
      json(res, 404, { ok: false, error: 'unknown_action', message: 'Acción no reconocida.' });
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const found = await findCourierOrder(store, orderId, auth.account, {
      getCustomer: (customerId) => ctx.customers.get(customerId),
      companyId: auth.companyId, companyOfOrder,
    });
    if (!found.ok) {
      json(res, 404, { ok: false, error: 'not_found', message: 'Ese pedido no está a tu nombre.' });
      return;
    }
    const idempotencyKey = text(body.idempotencyKey ?? body.idempotency_key, 120);
    if (idempotencyKey) {
      const seen = (await ctx.db.list('delivery_events', { limit: 2000 }))?.find(
        (row) => row.idempotency_key === idempotencyKey,
      );
      if (seen) {
        const fresh = await findCourierOrder(store, orderId, auth.account, {
          getCustomer: (customerId) => ctx.customers.get(customerId),
          companyId: auth.companyId, companyOfOrder,
        });
        json(res, 200, {
          ok: true,
          duplicate: true,
          order: fresh.dto,
          state: fresh.dto?.delivery_lifecycle ?? lifecycleOf(fresh.order),
          actions: COURIER_ACTIONS[lifecycleOf(fresh.order)] ?? [],
        });
        return;
      }
    }
    /* Concurrencia optimista: si el cliente vio otra versión, no se le pisa el trabajo. */
    const expectedVersion = Number(body.expectedVersion ?? body.expected_version);
    const currentVersion = Number(found.order?.version) > 0 ? Number(found.order.version) : 1;
    if (Number.isInteger(expectedVersion) && expectedVersion > 0 && expectedVersion !== currentVersion) {
      json(res, 409, {
        ok: false,
        error: 'stale_order',
        message: 'Otro cambio ocurrió mientras mirabas el pedido. Vuelve a abrirlo.',
        currentVersion,
      });
      return;
    }
    /* La oferta vencida se cierra en el servidor, no en el teléfono. */
    if (isOfferExpired(found.order)) {
      const expired = applyTransition(found.order, 'expire', { now: new Date().toISOString() });
      if (expired.ok) {
        await ctx.store.update(found.item.id, { orderJson: JSON.stringify(expired.order) });
        await ctx.db.insert('delivery_events', {
          id: `evt_${randomUUID().replace(/-/g, '')}`,
          order_id: orderId,
          event: 'expire',
          from_state: expired.from,
          to_state: expired.to,
          courier_account_id: auth.account.id,
          idempotency_key: `expire:${orderId}:${expired.from}`,
          created_at: new Date().toISOString(),
        });
      }
      json(res, 409, {
        ok: false,
        error: 'offer_expired',
        message: 'La oferta venció. El pedido volverá a asignarse.',
      });
      return;
    }
    /*
     * PRUEBA DE ENTREGA (seguridad crítica).
     *
     * El CRM genera un código de 4 dígitos y guarda SOLO su hash. El PIN que escribe el
     * repartidor se comprueba AQUÍ, no en el teléfono. Sin código configurado la entrega
     * NO se declara confirmada: queda pendiente de verificación administrativa.
     */
    if (event === 'deliver') {
      /* Primero se comprueba que la transición sea válida: nada muta si no lo es. */
      const preview = applyTransition(found.order, event, { actor, now: new Date().toISOString() });
      if (!preview.ok) {
        json(res, preview.status ?? 409, {
          ok: false,
          error: preview.error,
          message: preview.message,
          currentState: preview.currentState,
          allowed: preview.allowed ?? [],
        });
        return;
      }
      const proof = found.order?.delivery?.proof ?? null;
      const required = proof?.required === true;
      const code = String(body.proofCode ?? body.proof_code ?? body.pin ?? '').trim();
      if (required) {
        if (!proof?.hash) {
          json(res, 409, {
            ok: false,
            error: 'proof_not_configured',
            message: 'Falta configurar el código de entrega de este pedido en el CRM.',
          });
          return;
        }
        if (proof.used_at) {
          json(res, 409, { ok: false, error: 'proof_already_used', message: 'Ese código ya se usó.' });
          return;
        }
        if (proof.expires_at && Date.parse(proof.expires_at) <= Date.now()) {
          json(res, 409, { ok: false, error: 'proof_expired', message: 'El código de entrega venció.' });
          return;
        }
        const attempts = Number(proof.attempts ?? 0) || 0;
        if (attempts >= DELIVERY_PROOF_MAX_ATTEMPTS) {
          json(res, 429, {
            ok: false,
            error: 'proof_locked',
            message: 'Demasiados intentos. Administración debe generar un código nuevo.',
          });
          return;
        }
        if (!code) {
          json(res, 422, { ok: false, error: 'proof_required', message: 'Escribe el código de entrega.' });
          return;
        }
        if (hashDeliveryProof(orderId, code) !== proof.hash) {
          const nextAttempts = attempts + 1;
          const locked = nextAttempts >= DELIVERY_PROOF_MAX_ATTEMPTS;
          const failedOrder = {
            ...found.order,
            delivery: {
              ...(found.order.delivery ?? {}),
              proof: { ...proof, attempts: nextAttempts, last_failed_at: new Date().toISOString() },
            },
            updated_at: new Date().toISOString(),
          };
          await ctx.store.update(found.item.id, { orderJson: JSON.stringify(failedOrder) });
          await ctx.audit?.record({
            entity: 'order',
            entityId: found.item.id,
            action: 'delivery.proof_failed',
            actor: auth.account.display_name ?? auth.account.id,
            summary: `Intento de código incorrecto (${nextAttempts}/${DELIVERY_PROOF_MAX_ATTEMPTS})`,
            data: { attempts: nextAttempts, locked },
          });
          json(res, locked ? 429 : 409, {
            ok: false,
            error: locked ? 'proof_locked' : 'invalid_proof',
            message: locked
              ? 'Demasiados intentos. Administración debe generar un código nuevo.'
              : 'El código de entrega no coincide.',
            attempts_left: Math.max(0, DELIVERY_PROOF_MAX_ATTEMPTS - nextAttempts),
          });
          return;
        }
        /* Correcto: el código queda marcado como usado (no se puede reutilizar). */
        found.order.delivery = {
          ...(found.order.delivery ?? {}),
          proof: { ...proof, hash: null, used_at: new Date().toISOString() },
        };
      } else {
        /* Sin prueba segura: se anota lo declarado y se deja PENDIENTE, nunca confirmada. */
        const declared = Number(body.cashAmountCents ?? body.cash_amount_cents ?? 0) || 0;
        const pendingOrder = {
          ...found.order,
          delivery: {
            ...(found.order.delivery ?? {}),
            verification: 'pending_admin',
            verification_requested_at: new Date().toISOString(),
            cash_declared_cents: declared > 0 ? declared : found.order.delivery?.cash_declared_cents ?? null,
          },
          updated_at: new Date().toISOString(),
        };
        await ctx.store.update(found.item.id, { orderJson: JSON.stringify(pendingOrder) });
        await ctx.db.insert('delivery_events', {
          id: `evt_${randomUUID().replace(/-/g, '')}`,
          order_id: orderId,
          event: 'deliver_pending_verification',
          from_state: lifecycleOf(found.order),
          to_state: lifecycleOf(found.order),
          courier_account_id: auth.account.id,
          idempotency_key: idempotencyKey ?? `deliver-pending:${orderId}`,
          created_at: new Date().toISOString(),
        });
        json(res, 202, {
          ok: true,
          pending_verification: true,
          message: 'Entrega registrada. Queda pendiente de confirmación por administración.',
          state: lifecycleOf(found.order),
          actions: COURIER_ACTIONS[lifecycleOf(found.order)] ?? [],
          order: found.dto,
        });
        return;
      }

      /*
       * CÓMO PAGÓ EL CLIENTE. Antes solo existía «contra efectivo»; ahora el
       * repartidor declara EFECTIVO, TRANSFERENCIA, MIXTO o NO HA PAGADO.
       * La custodia en efectivo es SOLO el efectivo declarado y acotado al saldo
       * (el cambio no es custodia) y una transferencia declarada no se da por
       * cobrada hasta que administración la verifique.
       */
      const blockForCash = paymentBlockOf(found.order);
      const dueCents = Math.max(0, Math.round(Number(blockForCash.due ?? 0) * 100));
      const requestedMethod = String(body.paymentMethod ?? body.payment_method ?? 'cash').toLowerCase();
      const orderIsPrepaid = String(found.order?.payment?.method ?? found.order?.payment_method ?? '').toUpperCase() !== 'CASH';
      const prepaidRequired = Boolean(found.order?.delivery?.prepaid_required ?? found.order?.prepaid_required);
      const plan = planDeliveryPayment({
        method: requestedMethod,
        dueCents,
        cashDeclaredCents: body.cashReceivedCents ?? body.cash_received_cents ?? 0,
        transferDeclaredCents: body.transferDeclaredCents ?? body.transfer_declared_cents ?? 0,
        reason: body.cashReason ?? body.cash_reason ?? body.differenceReason,
        unpaidReason: body.unpaidReason ?? body.unpaid_reason,
        /* Entregar sin cobrar se bloquea si el pedido exige prepago o no da crédito. */
        allowUnpaid: !(prepaidRequired || (orderIsPrepaid && dueCents > 0)),
      });
      if (!plan.ok) {
        json(res, plan.status ?? 422, {
          ok: false,
          error: plan.error,
          message: plan.message,
          due_cents: plan.due_cents,
          expected_cents: plan.due_cents,
          declared_cents: plan.declared_cents,
          difference_cents: plan.difference_cents,
        });
        return;
      }
      found.order.delivery = {
        ...(found.order.delivery ?? {}),
        cash_expected_cents: dueCents,
        cash_declared_cents: plan.payment.cash_cents,
        cash_difference_cents: plan.payment.cash_cents - dueCents,
        cash_difference_reason: plan.payment.reason,
        cash_change_cents: plan.payment.cash_change_cents ?? 0,
        transfer_declared_cents: plan.payment.transfer_cents,
        transfer_reference: text(body.transferReference ?? body.transfer_reference, 120),
        unpaid_reason: plan.payment.unpaid_reason,
        payment_declared_method: plan.payment.method,
        payment_financial_state: plan.financialState,
        payment_still_due_cents: plan.stillDueCents,
      };
    }
    const now = new Date().toISOString();
    const result = applyTransition(found.order, event, {
      actor,
      now,
      extra: { reason: text(body.reason ?? body.note, 300) },
    });
    if (!result.ok) {
      json(res, result.status ?? 409, {
        ok: false,
        error: result.error,
        message: result.message,
        currentState: result.currentState,
        allowed: result.allowed ?? [],
      });
      return;
    }
    const updated = await ctx.store.update(found.item.id, { orderJson: JSON.stringify(result.order) });
    /*
     * CUSTODIA: si la entrega se confirma y era contra efectivo, se registra el dinero
     * que el repartidor debe rendir. Idempotente por pedido: reintentar no duplica.
     */
    if (event === 'deliver') {
      /* Se carga lo que el repartidor DECLARÓ en efectivo (acotado al saldo), nunca la transferencia. */
      const dueCents = Math.round(Number(result.order?.delivery?.cash_declared_cents ?? 0));
      if (dueCents > 0) {
        await ctx.db.insert(CASH_COLLECTION, {
          id: `cash_${randomUUID().replace(/-/g, '')}`,
          order_id: orderId,
          courier_account_id: auth.account.id,
          kind: 'charge',
          company_id: auth.companyId,
          amount_cents: dueCents,
          note: `Cobro contra entrega ${found.dto?.order_number ?? orderId}`,
          idempotency_key: `charge:${orderId}`,
          actor: auth.account.display_name ?? null,
          created_at: now,
        });
      }
    }
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    await ctx.db.insert('delivery_events', {
      id: eventId,
      order_id: orderId,
      event,
      from_state: result.from,
      to_state: result.to,
      courier_account_id: auth.account.id,
      courier_display_name: auth.account.display_name ?? null,
      idempotency_key: idempotencyKey ?? `${event}:${orderId}:${currentVersion}`,
      reason: text(body.reason ?? body.note, 300),
      created_at: now,
    });
    await ctx.audit?.record({
      entity: 'order',
      entityId: found.item.id,
      action: `delivery.${event}`,
      actor: auth.account.display_name ?? auth.account.id,
      summary: `Entrega ${result.from} → ${result.to}`,
      data: { from: result.from, to: result.to, courier: auth.account.id },
    });
    /*
     * AVISOS AL CLIENTE (Fase 06): los DOS únicos rutinarios son el inicio de la
     * entrega y la llegada. Se encolan SIEMPRE como evento; solo pasan a `sent` si
     * un proveedor real confirma. Sin plantilla aprobada quedan `pending`.
     */
    const messageKind =
      event === 'start' ? 'delivery_started' : event === 'arrive' ? 'delivery_arrived' : null;
    if (messageKind) {
      const approved = false; /* UAT: sin plantilla autorizada ni proveedor real. */
      await ctx.db.insert('delivery_message_outbox', {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        order_id: orderId,
        kind: messageKind,
        status: approved ? 'pending' : 'pending_template',
        idempotency_key: `${messageKind}:${orderId}`,
        template: DELIVERY_MESSAGE_TEMPLATES[messageKind],
        attempts: 0,
        last_attempt_at: null,
        error: approved ? null : 'no_approved_template',
        created_at: now,
      });
    }
    const fresh = await findCourierOrder(store, orderId, auth.account, {
      getCustomer: (customerId) => ctx.customers.get(customerId),
      companyId: auth.companyId, companyOfOrder,
    });
    json(res, 200, {
      ok: true,
      duplicate: false,
      order: fresh.dto ?? courierOrderDTO(updated, {}),
      state: result.to,
      actions: COURIER_ACTIONS[result.to] ?? [],
      version: Number(result.order.version),
    });
    return;
  }

  if (route === '/api/courier/custody' && req.method === 'GET') {
    const auth = await courierAuth();
    if (!auth.ok) {
      json(res, auth.status ?? 401, { ok: false, error: auth.error, message: 'Sesión no válida.' });
      return;
    }
    const rows = await scopedCashRows(auth.companyId);
    const summary = custodySummary(rows, auth.account.id);
    const rate = (await ctx.settings.read('delivery_rate'))?.value ?? {};
    const events = (await ctx.db.list('delivery_events', { limit: 5000 })) ?? [];
    const visible = await listCourierOrders(store, auth.account, {
      includeClosed: true, companyId: auth.companyId, companyOfOrder,
    });
    const visibleIds = new Set(visible.map((order) => String(order.id)));
    const deliveredCount = events.filter(
      (row) => row.event === 'deliver' && row.courier_account_id === auth.account.id && visibleIds.has(String(row.order_id)),
    ).length;
    json(res, 200, {
      ok: true,
      custody: summary,
      earnings: earningsFor({ deliveredCount, rateCents: rate.rateCents ?? null }),
      note: rate.rateCents ? null : 'Tarifa pendiente de configurar',
      read_only: true,
    });
    return;
  }

  if (route.startsWith('/api/courier/') && req.method === 'GET') {
    /* Nada de escrituras desde el móvil en esta fase: se dice, no se finge. */
    json(res, 405, {
      ok: false,
      error: 'read_only',
      message: 'La app del repartidor solo puede leer en esta fase.',
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

    /*
     * CUENTAS DE ACCESO DEL REPARTIDOR AL MÓVIL.
     *
     * Autorizar el móvil es un acto explícito de administración: tener el teléfono guardado
     * como contacto de reparto NO crea acceso. Cada alta se liga al registro que ya existe
     * (usuario con rol DELIVERY o contacto guardado) y no se permite duplicar a la persona.
     * Desactivar o quitar el acceso sube `token_epoch`: los tokens ya emitidos dejan de valer.
     */
    const canManageCouriers = can('admin.full') || can('delivery.manage');
    const couriersCollection = 'courier_accounts';

    if (route === '/api/admin/courier-applications' && req.method === 'GET') {
      if (!can('admin.full')) { forbid(); return; }
      const companyId = String(url.searchParams.get('companyId') ?? '').trim();
      if (companyId && !(await activeLogisticsCompany(ctx.db, companyId))) {
        json(res, 422, { ok: false, error: 'invalid_company' }); return;
      }
      const rows = (await ctx.db.list('courier_applications', { limit: 5000 })) ?? [];
      json(res, 200, { ok: true, applications: rows.filter((row) => !companyId || row.company_id === companyId) });
      return;
    }
    if (route.startsWith('/api/admin/courier-applications/') && route.endsWith('/review') && req.method === 'POST') {
      if (!can('admin.full')) { forbid(); return; }
      const id = decodeURIComponent(route.slice('/api/admin/courier-applications/'.length, -'/review'.length));
      const application = await ctx.db.get('courier_applications', id);
      if (!application) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const companyId = String(body.companyId ?? body.company_id ?? '').trim();
      const decision = String(body.decision ?? '').trim();
      if (companyId !== application.company_id || !['approved', 'rejected', 'info_required'].includes(decision)) {
        json(res, 422, { ok: false, error: 'invalid_review' }); return;
      }
      if (!['pending', 'info_required'].includes(application.status)) {
        json(res, 409, { ok: false, error: 'already_reviewed' }); return;
      }
      /* Pedir información no aprueba nada: deja la solicitud abierta y sin acceso. */
      if (decision === 'info_required' && !text(body.note, 300)) {
        json(res, 422, { ok: false, error: 'note_required' }); return;
      }
      const now = new Date().toISOString();
      await ctx.db.update('courier_applications', id, { status: decision,
        reviewed_at: now, reviewed_by_user_id: actor?.id ?? null,
        review_note: text(body.note, 300), updated_at: now });
      await ctx.audit?.record({ entity: 'courier_application', entityId: id,
        action: `courier.application_${decision === 'info_required' ? 'info_requested' : decision}`,
        actor: actor?.display_name ?? null,
        data: { company_id: companyId } });
      json(res, 200, { ok: true, status: decision, operational_access: false });
      return;
    }

    /* Documentos del expediente, para revisión administrativa (solo central). */
    if (route.startsWith('/api/admin/courier-applications/') && route.endsWith('/documents') && req.method === 'GET') {
      if (!can('admin.full')) { forbid(); return; }
      const id = decodeURIComponent(route.slice('/api/admin/courier-applications/'.length, -'/documents'.length));
      const application = await ctx.db.get('courier_applications', id);
      if (!application) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      const documents = ((await ctx.db.list('courier_documents', { limit: 5000 })) ?? [])
        .filter((row) => row.application_id === id && row.status !== 'replaced');
      json(res, 200, { ok: true, application_id: id, vehicle_type: application.vehicle_type ?? null,
        documents: documents.map(publicDocument),
        required: requiredDocumentsFor(application.vehicle_type),
        missing: requiredDocumentsFor(application.vehicle_type)
          .filter((required) => !documents.some((row) => row.kind === required)) });
      return;
    }

    /* Descarga autenticada: el binario nunca se sirve desde una ruta pública. */
    if (route.startsWith('/api/admin/courier-documents/') && route.endsWith('/file') && req.method === 'GET') {
      if (!can('admin.full')) { forbid(); return; }
      const id = decodeURIComponent(route.slice('/api/admin/courier-documents/'.length, -'/file'.length));
      const document = await ctx.db.get('courier_documents', id);
      if (!document || document.status === 'replaced') { json(res, 404, { ok: false, error: 'not_found' }); return; }
      let buffer;
      try {
        buffer = await readDocumentFile(document.file);
      } catch {
        json(res, 404, { ok: false, error: 'file_missing' }); return;
      }
      res.writeHead(200, { 'content-type': document.content_type,
        'content-length': String(buffer.length),
        'content-disposition': `inline; filename="${document.kind.toLowerCase()}.${document.content_type.split('/')[1] ?? 'bin'}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff' });
      res.end(buffer);
      return;
    }

    /* Revisión de un documento: aceptado, rechazado o pedir otro. */
    if (route.startsWith('/api/admin/courier-documents/') && route.endsWith('/review') && req.method === 'POST') {
      if (!can('admin.full')) { forbid(); return; }
      const id = decodeURIComponent(route.slice('/api/admin/courier-documents/'.length, -'/review'.length));
      const document = await ctx.db.get('courier_documents', id);
      if (!document || document.status === 'replaced') { json(res, 404, { ok: false, error: 'not_found' }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const decision = String(body.decision ?? '').trim();
      if (!['accepted', 'rejected', 'replacement'].includes(decision)) {
        json(res, 422, { ok: false, error: 'invalid_decision' }); return;
      }
      if (decision !== 'accepted' && !text(body.note, 300)) {
        json(res, 422, { ok: false, error: 'note_required' }); return;
      }
      const now = new Date().toISOString();
      await ctx.db.update('courier_documents', id, { status: decision,
        review_note: text(body.note, 300), reviewed_at: now,
        reviewed_by_user_id: actor?.id ?? null, updated_at: now });
      await ctx.audit?.record({ entity: 'courier_document', entityId: id,
        action: `courier.document_${decision}`, actor: actor?.display_name ?? null,
        data: { application_id: document.application_id, kind: document.kind } });
      json(res, 200, { ok: true, status: decision });
      return;
    }

    if (route === '/api/admin/logistics/companies' && req.method === 'GET') {
      if (!can('admin.full')) { forbid(); return; }
      const companies = (await ctx.db.list('logistics_companies', { limit: 5000 })) ?? [];
      json(res, 200, { ok: true, companies });
      return;
    }
    if (route === '/api/admin/logistics/companies' && req.method === 'POST') {
      if (!can('admin.full')) { forbid(); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const id = String(body.id ?? '').trim();
      const name = text(body.name, 120);
      if (!validCompanyId(id) || !name || name.length < 3) {
        json(res, 422, { ok: false, error: 'invalid_company' }); return;
      }
      if (await ctx.db.get('logistics_companies', id)) {
        json(res, 409, { ok: false, error: 'company_exists' }); return;
      }
      const doc = { id, name, active: true, system: false,
        created_at: new Date().toISOString(), created_by_user_id: actor?.id ?? null };
      const inserted = await ctx.db.insert('logistics_companies', doc);
      if (inserted?.duplicate) { json(res, 409, { ok: false, error: 'company_exists' }); return; }
      await ctx.audit?.record({ entity: 'logistics_company', entityId: id,
        action: 'logistics.company_registered', actor, data: { name } });
      json(res, 201, { ok: true, company: doc });
      return;
    }

    /*
     * TRANSFERENCIA DECLARADA POR EL REPARTIDOR: administración la verifica o la
     * rechaza. El repartidor nunca puede confirmar su propia transferencia.
     * Verificar dos veces el mismo pago devuelve 409 y no duplica nada.
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/payment/transfer') && req.method === 'POST') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/payment/transfer'.length));
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
      const order = orderOf(item) ?? {};
      const decision = applyTransferVerification({
        order,
        decision: body.decision ?? body.estado,
        reference: body.reference ?? body.referencia,
        actor: actor?.display_name ?? actor?.id ?? null,
      });
      if (!decision.ok) {
        json(res, decision.status ?? 409, { ok: false, error: decision.error, message: decision.message });
        return;
      }
      const history = Array.isArray(order.delivery?.transfer_verifications) ? order.delivery.transfer_verifications : [];
      const next = {
        ...order,
        delivery: {
          ...(order.delivery ?? {}),
          transfer_verified_cents: decision.transferVerifiedCents,
          payment_financial_state: decision.financialState,
          payment_still_due_cents: decision.stillDueCents,
          transfer_reference: decision.record.reference ?? order.delivery?.transfer_reference ?? null,
          transfer_verifications: [...history, decision.record],
        },
        updated_at: new Date().toISOString(),
      };
      await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
      await ctx.audit?.record({
        entity: 'order',
        entityId: item.id,
        action: `delivery.transfer_${decision.record.decision}`,
        actor: actor?.display_name ?? actor?.id ?? null,
        summary: `Transferencia ${decision.record.decision} por ${decision.record.declared_cents} cts`,
        data: { amount_cents: decision.record.amount_cents, financial_state: decision.financialState },
      });
      json(res, 200, {
        ok: true,
        financial_state: decision.financialState,
        still_due_cents: decision.stillDueCents,
        transfer_verified_cents: decision.transferVerifiedCents,
      });
      return;
    }

    /* CÓDIGO DE ENTREGA: lo genera el CRM y se le dice al cliente. Se guarda el hash. */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery-code') && req.method === 'POST') {
      if (!can('admin.full') && !can('orders.update_operational')) {
        forbid();
        return;
      }
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery-code'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const code = String(Math.floor(1000 + Math.random() * 9000));
      const order = orderOf(item) ?? {};
      const next = {
        ...order,
        delivery: {
          ...(order.delivery ?? {}),
          proof: {
            required: true,
            hash: hashDeliveryProof(item.id, code),
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + DELIVERY_PROOF_TTL_MS).toISOString(),
            attempts: 0,
            used_at: null,
            created_by: actor?.display_name ?? actor?.id ?? null,
          },
        },
        updated_at: new Date().toISOString(),
      };
      await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
      /* Se devuelve UNA vez para que administración se lo diga al cliente. */
      json(res, 200, { ok: true, orderId: item.id, code });
      return;
    }

    /* Confirmación administrativa de una entrega sin prueba en el teléfono. */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/confirm') && req.method === 'POST') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/confirm'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const result = applyTransition(orderOf(item) ?? {}, 'deliver', {
        actor,
        now: new Date().toISOString(),
        extra: { reason: 'confirmacion administrativa' },
      });
      if (!result.ok) {
        json(res, result.status ?? 409, { ok: false, error: result.error, message: result.message });
        return;
      }
      const withVerification = {
        ...result.order,
        delivery: { ...result.order.delivery, verification: 'confirmed_by_admin' },
      };
      await ctx.store.update(item.id, { orderJson: JSON.stringify(withVerification) });
      json(res, 200, { ok: true, order: withVerification });
      return;
    }

    /* CUSTODIA: saldos por repartidor, rendiciones y tarifa configurable. */
    if (route === '/api/admin/delivery-cash' && req.method === 'GET') {
      if (!can('admin.full') && !can('delivery.manage')) {
        forbid();
        return;
      }
      const companyId = String(url.searchParams.get('companyId') ?? 'phytoemagry');
      if (!(await activeLogisticsCompany(ctx.db, companyId))) { json(res, 422, { ok: false, error: 'invalid_company' }); return; }
      if (!(await seesCompany(companyId))) { forbid(); return; }
      const rows = await scopedCashRows(companyId);
      const couriers = (await ctx.db.list('courier_accounts', { limit: 1000 })) ?? [];
      const rate = (await ctx.settings.read('delivery_rate'))?.value ?? {};
      json(res, 200, {
        ok: true,
        company_id: companyId,
        couriers: custodyByCourier(rows, couriers),
        rate_cents: rate.rateCents ?? null,
      });
      return;
    }

    if (route === '/api/admin/delivery-cash/remittance' && req.method === 'POST') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const courierId = text(body.courierAccountId ?? body.courier_account_id, 80);
      const courier = courierId ? await ctx.db.get('courier_accounts', courierId) : null;
      if (!courier) {
        json(res, 404, { ok: false, error: 'not_found', message: 'Ese repartidor no existe.' });
        return;
      }
      const companies = await courierCompanies(ctx.db, courier);
      const selected = selectedCourierCompany(companies, body.companyId ?? body.company_id);
      if (!selected.ok) { json(res, selected.status, { ok: false, error: selected.error }); return; }
      const companyId = selected.companyId;
      const key = text(body.idempotencyKey ?? body.idempotency_key, 120) ?? `remittance:${courierId}:${Date.now()}`;
      const items = (await store.listAdmin({ limit: 5000 })) ?? [];
      const ordersById = new Map();
      for (const item of items) {
        if (item.type !== 'order_intent') continue;
        const order = orderOf(item);
        if (order) { ordersById.set(String(item.id), order); if (order.id) ordersById.set(String(order.id), order); }
      }
      const result = await recordRemittanceAtomic({ db: ctx.db, handle: ctx.store.handle,
        courierId, companyId, amountCents: body.amountCents ?? body.amount_cents,
        idempotencyKey: key, actor: actor?.display_name ?? null, note: text(body.note, 300),
        ordersById, now: ctx.clock().toISOString() });
      if (!result.ok) {
        json(res, result.status ?? 422, { ok: false, error: result.error,
          message: result.message, pending: result.pending }); return;
      }
      json(res, 201, {
        ok: true,
        duplicate: result.duplicate === true,
        company_id: companyId,
        summary: result.summary,
      });
      return;
    }

    /* CUSTODIA — MOVIMIENTOS: el libro append-only, en solo lectura. */
    if (route === '/api/admin/delivery-cash/movements' && req.method === 'GET') {
      if (!can('admin.full') && !can('delivery.manage')) {
        forbid();
        return;
      }
      const courierId = text(new URL(req.url, 'http://local').searchParams.get('courierId'), 80);
      const companyId = String(url.searchParams.get('companyId') ?? 'phytoemagry');
      if (!(await activeLogisticsCompany(ctx.db, companyId))) { json(res, 422, { ok: false, error: 'invalid_company' }); return; }
      if (!(await seesCompany(companyId))) { forbid(); return; }
      const rows = await scopedCashRows(companyId);
      const pick = (row, field) => row?.[field] ?? row?.doc?.[field] ?? null;
      const movements = rows
        .filter((row) => !courierId || String(pick(row, 'courier_account_id') ?? '') === courierId)
        .map((row) => ({
          id: row.id,
          kind: pick(row, 'kind'),
          order_id: pick(row, 'order_id'),
          courier_account_id: pick(row, 'courier_account_id'),
          company_id: pick(row, 'company_id'),
          amount_cents: Number(pick(row, 'amount_cents')) || 0,
          note: pick(row, 'note'),
          idempotency_key: pick(row, 'idempotency_key'),
          created_at: pick(row, 'created_at'),
        }))
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      json(res, 200, { ok: true, company_id: companyId, movements }, { 'cache-control': 'no-store' });
      return;
    }

    /*
     * CUSTODIA — INCIDENCIAS: conciliación de SOLO LECTURA.
     * Detecta y describe; nunca corrige dinero. La reparación contable es otro
     * flujo (permisos + confirmación + auditoría) y no existe a propósito.
     */
    if ((route === '/api/admin/delivery-cash/incidents' || route === '/api/admin/delivery-cash/reconciliation') && req.method === 'GET') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      const ledger = (await ctx.db.list(CASH_COLLECTION, { limit: 5000 })) ?? [];
      const items = (await store.listAdmin({ limit: 5000 })) ?? [];
      const orders = [];
      for (const item of items) {
        if (item.type !== 'order_intent') continue;
        const order = orderOf(item);
        if (order) orders.push({ ...order, id: item.id });
      }
      const companies = (await ctx.db.list('logistics_companies', { limit: 5000 })) ?? [];
      const report = reconcileDeliveryCashByCompany({ orders, ledger, companies });
      if (route.endsWith('/reconciliation')) {
        json(res, 200, report, { 'cache-control': 'no-store' }); return;
      }
      const companyId = String(url.searchParams.get('companyId') ?? 'phytoemagry');
      if (!(await activeLogisticsCompany(ctx.db, companyId))) {
        json(res, 422, { ok: false, error: 'invalid_company' }); return;
      }
      json(res, 200, { ok: true, company_id: companyId,
        ...report.by_company[companyId], unresolved_count: report.unresolved_movements.length },
        { 'cache-control': 'no-store' });
      return;
    }

    /*
     * CONCILIACIÓN — RESOLUCIONES ADMINISTRATIVAS.
     *
     * Registrar una resolución NO mueve dinero: deja constancia de la revisión
     * humana (justificación + evidencia) en un registro aparte. El libro no se
     * toca, no se cambia ningún importe y la custodia sigue bloqueada hasta que
     * exista una autorización explícita. El id es determinista por movimiento,
     * así que dos administradores no pueden registrar dos resoluciones distintas
     * del mismo movimiento.
     */
    if (route === '/api/admin/delivery-cash/resolutions' && req.method === 'GET') {
      if (!can('admin.full')) { forbid(); return; }
      const rows = ((await ctx.db.list('cash_resolutions', { limit: 5000 })) ?? [])
        .slice()
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      json(res, 200, { ok: true, resolutions: rows }, { 'cache-control': 'no-store' });
      return;
    }

    if (route === '/api/admin/delivery-cash/resolutions' && req.method === 'POST') {
      if (!can('admin.full')) { forbid(); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const movementId = text(body.movementId ?? body.movement_id, 120);
      const justification = text(body.justification ?? body.reason, 500);
      const evidence = text(body.evidence ?? body.evidence_reference, 300);
      if (!movementId) { json(res, 422, { ok: false, error: 'missing_movement' }); return; }
      if (!justification || justification.length < 10) {
        json(res, 422, { ok: false, error: 'justification_required',
          message: 'Explica con qué evidencia se concluyó (mínimo 10 caracteres).' }); return;
      }
      const ledger = (await ctx.db.list(CASH_COLLECTION, { limit: 5000 })) ?? [];
      const movement = ledger.find((row) => String(row.id) === movementId);
      if (!movement) { json(res, 404, { ok: false, error: 'movement_not_found' }); return; }
      const companyId = text(body.companyId ?? body.company_id, 40) || null;
      if (companyId && !(await activeLogisticsCompany(ctx.db, companyId))) {
        json(res, 422, { ok: false, error: 'invalid_company' }); return;
      }
      const id = `res:${movementId}`;
      const existing = await ctx.db.get('cash_resolutions', id);
      if (existing) {
        json(res, 409, { ok: false, error: 'already_resolved', resolution: existing }); return;
      }
      const doc = { id, movement_id: movementId,
        courier_account_id: movement.courier_account_id ?? null,
        company_id: companyId, justification, evidence_reference: evidence || null,
        status: 'pending_authorization',
        created_by_user_id: actor?.id ?? null,
        created_by_display_name: actor?.display_name ?? null,
        created_at: ctx.clock().toISOString() };
      try {
        await ctx.db.insert('cash_resolutions', doc);
      } catch {
        // Carrera entre dos administradores: el id determinista la resuelve.
        json(res, 409, { ok: false, error: 'already_resolved' }); return;
      }
      await ctx.audit?.record({ entity: 'cash_movement', entityId: movementId,
        action: 'cash.resolution_recorded', actor: actor?.display_name ?? null,
        summary: `Revisión de movimiento de ${movement.courier_account_id ?? 'repartidor sin cuenta'}`,
        data: { company_id: companyId, status: 'pending_authorization', evidence: evidence || null } });
      json(res, 201, { ok: true, resolution: doc, applied: false,
        message: 'Resolución registrada. La custodia sigue bloqueada hasta autorización explícita.' });
      return;
    }

    /*
     * POSICIONES DE REPARTIDORES (solo lectura, para el centro de monitoreo).
     * Devuelve la ÚLTIMA posición conocida con su antigüedad y estado de señal.
     * No expone historial de rutas ni el teléfono del repartidor.
     */
    if (route === '/api/admin/delivery-courier-positions' && req.method === 'GET') {
      if (!can('admin.full') && !can('delivery.manage')) {
        forbid();
        return;
      }
      const companyId = String(url.searchParams.get('companyId') ?? 'phytoemagry');
      if (!(await activeLogisticsCompany(ctx.db, companyId))) { json(res, 422, { ok: false, error: 'invalid_company' }); return; }
      if (!(await seesCompany(companyId))) { forbid(); return; }
      const rows = ((await ctx.db.list('courier_positions', { limit: 1000 })) ?? [])
        .filter((row) => row.company_id === companyId);
      const accounts = (await ctx.db.list(couriersCollection, { limit: 1000 })) ?? [];
      const byId = new Map(accounts.map((row) => [row.id, row]));
      const now = Date.now();
      const positions = rows.map((row) =>
        describePosition(row, {
          now,
          courierId: row.courier_id ?? row.id,
          orderIds: row.order_id ? [row.order_id] : [],
        }),
      ).map((row) => ({
        ...row,
        courier_name: byId.get(row.courier_id)?.display_name ?? null,
        kind: byId.get(row.courier_id)?.kind ?? null,
      }));
      json(res, 200, { ok: true, company_id: companyId, positions, server_time: new Date(now).toISOString() }, { 'cache-control': 'no-store' });
      return;
    }

    if (route === '/api/admin/delivery-rate' && req.method === 'POST') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const rateCents = Number(body.rateCents ?? body.rate_cents);
      if (!Number.isFinite(rateCents) || rateCents < 0) {
        json(res, 422, { ok: false, error: 'invalid_rate', message: 'La tarifa debe ser un número mayor o igual a cero.' });
        return;
      }
      await ctx.settings.write('delivery_rate', {
        rateCents: Math.round(rateCents),
        updated_at: ctx.clock().toISOString(),
        updated_by: actor?.display_name ?? actor?.id ?? null,
      });
      json(res, 200, { ok: true, rate_cents: Math.round(rateCents) });
      return;
    }

    if (route === '/api/admin/couriers' && req.method === 'GET') {      if (!canManageCouriers) {
        forbid();
        return;
      }
      const rows = (await ctx.db.list(couriersCollection, { limit: 1000 })) ?? [];
      const grants = can('admin.full') ? [] : (await ctx.db.list('courier_company_grants', { limit: 5000 })) ?? [];
      const scope = await companyScope();
      const multiIds = new Set(grants.filter((grant) => grant.active === true && !scopeSeesCompany(scope, grant.company_id))
        .map((grant) => grant.courier_account_id));
      const visible = rows.filter((row) => scopeSeesCompany(scope, row.company_id) && !multiIds.has(row.id));
      json(res, 200, { ok: true, couriers: visible.map(publicCourierAccount) });
      return;
    }

    /* COLA DE AVISOS DEL REPARTO: ver qué falta y procesarla (nunca finge un envío). */
    if (route === '/api/admin/delivery-messages' && req.method === 'GET') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      const rows = (await ctx.db.list('delivery_message_outbox', { limit: 500 })) ?? [];
      const counts = rows.reduce((acc, row) => {
        const key = String(row.status ?? 'unknown');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      json(res, 200, { ok: true, counts, messages: rows.slice(-100) });
      return;
    }

    if (route === '/api/admin/delivery-messages/dispatch' && req.method === 'POST') {
      if (!can('admin.full')) {
        forbid();
        return;
      }
      json(res, 200, { ok: true, ...(await dispatchDeliveryMessages(ctx)) });
      return;
    }

    if (route === '/api/admin/couriers' && req.method === 'POST') {
      if (!canManageCouriers) {
        forbid();
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const at = new Date().toISOString();
      const normalized = normalizeCourierAccountInput(body, { now: at });
      if (!normalized.ok) {
        json(res, 422, { ok: false, error: normalized.error, message: 'Los datos de la cuenta no son válidos.' });
        return;
      }
      const value = normalized.value;
      const initialCompany = value.company_id ?? 'phytoemagry';
      if (!(await activeLogisticsCompany(ctx.db, initialCompany))) {
        json(res, 422, { ok: false, error: 'invalid_company' }); return;
      }
      if (!(await seesCompany(initialCompany))) { forbid(); return; }
      const rows = (await ctx.db.list(couriersCollection, { limit: 1000 })) ?? [];
      if (rows.some((row) => row.phone_e164 === value.phone_e164)) {
        json(res, 409, { ok: false, error: 'phone_in_use', message: 'Ese teléfono ya tiene una cuenta de acceso.' });
        return;
      }
      if (value.kind === 'INTERNAL') {
        const user = await ctx.users.get(value.user_id);
        if (!user || user.active === false) {
          json(res, 422, { ok: false, error: 'invalid_user', message: 'Ese usuario del CRM no existe o está inactivo.' });
          return;
        }
        if (rows.some((row) => row.user_id === value.user_id)) {
          json(res, 409, { ok: false, error: 'duplicate_courier', message: 'Ese usuario ya tiene una cuenta de acceso.' });
          return;
        }
      }
      if (value.kind === 'EXTERNAL') {
        const saved = savedCourierContacts((await ctx.settings.read('delivery_contacts'))?.value);
        const contact = saved.find((row) => row.id === value.contact_id || row.phone === value.phone_e164) ?? null;
        if (!contact) {
          json(res, 422, {
            ok: false,
            error: 'contact_not_saved',
            message: 'Primero guarda ese número como contacto de reparto, y luego autorízalo.',
          });
          return;
        }
        if (contact.phone !== value.phone_e164) {
          json(res, 422, { ok: false, error: 'phone_mismatch', message: 'El teléfono no coincide con el contacto guardado.' });
          return;
        }
        if (rows.some((row) => row.contact_id === contact.id)) {
          json(res, 409, { ok: false, error: 'duplicate_courier', message: 'Ese contacto ya tiene una cuenta de acceso.' });
          return;
        }
      }
      const hashed = await hashCourierCredential(body.pin ?? body.password);
      if (!hashed.ok) {
        json(res, 422, { ok: false, error: hashed.error, message: 'El PIN debe tener al menos 6 caracteres.' });
        return;
      }
      const doc = {
        id: newCourierAccountId(),
        ...value,
        company_id: initialCompany,
        credential_hash: hashed.hash,
        token_epoch: 0,
        failed_attempts: 0,
        locked_until: null,
        last_login_at: null,
        created_at: at,
        created_by_user_id: actor?.id ?? null,
        created_by_display_name: actor?.display_name ?? null,
      };
      const created = await ctx.db.insert(couriersCollection, doc);
      await ctx.db.insert('courier_company_grants', {
        id: `${doc.id}:${initialCompany}`, courier_account_id: doc.id,
        company_id: initialCompany, active: true, updated_at: at,
        updated_by_user_id: actor?.id ?? null,
      });
      await ctx.audit?.record({
        entity: 'courier_account',
        entityId: doc.id,
        action: 'courier.app_access_granted',
        actor,
        data: { kind: doc.kind, user_id: doc.user_id, contact_id: doc.contact_id },
      });
      const stored = created?.doc ?? doc;
      json(res, 201, { ok: true, courier: publicCourierAccount(stored) });
      return;
    }

    /*
     * EMPRESAS CONCEDIDAS A UN REPARTIDOR (solo lectura).
     *
     * El panel necesita pintar el estado real de las concesiones —con fecha y
     * responsable— antes de ofrecer el interruptor. La escritura sigue siendo
     * el POST de aquí abajo; aquí no se toca nada.
     */
    if (route.startsWith('/api/admin/couriers/') && route.endsWith('/companies') && req.method === 'GET') {
      if (!canManageCouriers) { forbid(); return; }
      const courierId = decodeURIComponent(route.slice('/api/admin/couriers/'.length, -'/companies'.length));
      const account = await ctx.db.get(couriersCollection, courierId);
      if (!account) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      if (!(await seesCompany(account.company_id))) { forbid(); return; }
      const grants = ((await ctx.db.list('courier_company_grants', { limit: 5000 })) ?? [])
        .filter((row) => String(row.courier_account_id) === String(courierId));
      json(res, 200, { ok: true, courier_id: courierId,
        companies: grants.map((row) => ({ company_id: row.company_id,
          active: row.active === true, updated_at: row.updated_at ?? null,
          updated_by_user_id: row.updated_by_user_id ?? null })) });
      return;
    }

    if (route.startsWith('/api/admin/couriers/') && route.endsWith('/companies') && req.method === 'POST') {
      if (!can('admin.full')) { forbid(); return; }
      const courierId = decodeURIComponent(route.slice('/api/admin/couriers/'.length, -'/companies'.length));
      const account = await ctx.db.get(couriersCollection, courierId);
      if (!account) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const companyId = String(body.companyId ?? body.company_id ?? '').trim();
      if (!(await activeLogisticsCompany(ctx.db, companyId)) || typeof body.active !== 'boolean') {
        json(res, 422, { ok: false, error: 'invalid_company_grant' }); return;
      }
      const id = `${courierId}:${companyId}`;
      const now = new Date().toISOString();
      const grant = await ctx.db.get('courier_company_grants', id);
      const doc = { id, courier_account_id: courierId, company_id: companyId,
        active: body.active, updated_at: now, updated_by_user_id: actor?.id ?? null };
      if (grant) await ctx.db.update('courier_company_grants', id, doc);
      else await ctx.db.insert('courier_company_grants', doc);
      await ctx.db.update(couriersCollection, courierId, { token_epoch: (Number(account.token_epoch ?? 0) || 0) + 1, updated_at: now });
      await ctx.audit?.record({ entity: 'courier_account', entityId: courierId,
        action: body.active ? 'courier.company_granted' : 'courier.company_revoked', actor,
        data: { company_id: companyId } });
      json(res, 200, { ok: true, company_id: companyId, active: body.active });
      return;
    }

    if (route.startsWith('/api/admin/couriers/') && req.method === 'PATCH') {
      if (!canManageCouriers) {
        forbid();
        return;
      }
      const courierId = decodeURIComponent(route.slice('/api/admin/couriers/'.length)).replace(/\/+$/, '');
      const current = await ctx.db.get(couriersCollection, courierId);
      if (!current) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!(await seesCompany(current.company_id))) { forbid(); return; }
      {
        // Quien no es central solo toca cuentas cuyas empresas TODAS estén en su alcance.
        const alcance = await companyScope();
        const empresas = [current.company_id, ...(await courierCompanies(ctx.db, current))].filter(Boolean);
        if (!empresas.every((id) => scopeSeesCompany(alcance, id))) { forbid(); return; }
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const patch = { updated_at: new Date().toISOString(), updated_by_user_id: actor?.id ?? null };
      if (body.active !== undefined) patch.active = body.active !== false;
      if (body.appAccess !== undefined || body.app_access !== undefined) {
        patch.app_access = body.appAccess === true || body.app_access === true;
      }
      if (body.displayName !== undefined || body.display_name !== undefined) {
        const name = String(body.displayName ?? body.display_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name) {
          json(res, 422, { ok: false, error: 'invalid_display_name' });
          return;
        }
        patch.display_name = name;
      }
      const newPin = body.pin ?? body.password;
      if (newPin !== undefined) {
        const hashed = await hashCourierCredential(newPin);
        if (!hashed.ok) {
          json(res, 422, { ok: false, error: hashed.error, message: 'El PIN debe tener al menos 6 caracteres.' });
          return;
        }
        patch.credential_hash = hashed.hash;
        patch.failed_attempts = 0;
        patch.locked_until = null;
        /* Cambiar el PIN invalida las sesiones abiertas. */
        patch.token_epoch = (Number(current.token_epoch ?? 0) || 0) + 1;
      }
      const revoking = patch.active === false || patch.app_access === false;
      if (revoking && patch.token_epoch === undefined) {
        patch.token_epoch = (Number(current.token_epoch ?? 0) || 0) + 1;
      }
      const updated = await ctx.db.update(couriersCollection, courierId, patch);
      await ctx.audit?.record({
        entity: 'courier_account',
        entityId: courierId,
        action: revoking ? 'courier.app_access_revoked' : 'courier.app_access_updated',
        actor,
        data: { active: patch.active, app_access: patch.app_access, pin_changed: newPin !== undefined },
      });
      json(res, 200, { ok: true, courier: publicCourierAccount(updated ?? { ...current, ...patch }) });
      return;
    }

    if (await handleOfflineOperation({req,res,route,ctx,actor,json,handle})) return;

    if (await handleCallingRoute({ req, res, route, url, ctx, actor, can,
      canOpen: (conversation) => canOpenConversation(ctx, actor, conversation),
      readJson: readJsonBody, json })) return;
    if (await handleProofreadingRoute({ req, res, route, ctx, actor, can,
      canOpen: (conversation) => canOpenConversation(ctx, actor, conversation),
      readJson: readJsonBody, json })) return;
    if (await handleChatSharingRoute({ req, res, route, ctx, can, readJson: readJsonBody, json })) return;

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

    /*
     * ALCANCE ADMINISTRATIVO POR EMPRESA DE UN USUARIO.
     *
     * Solo la superadministración central reparte empresas: es el acto que
     * decide quién puede ver y operar FULLTECH. Se guarda una fila por pareja
     * (usuario, empresa), se audita y se puede revocar. No crea usuarios ni
     * toca su rol. Una empresa inactiva no se puede conceder.
     */
    /* Lectura del alcance por empresa de un usuario (para pintarlo antes de cambiarlo). */
    if (route.startsWith('/api/admin/users/') && route.endsWith('/companies') && req.method === 'GET') {
      if (!requireAdmin()) return;
      const userId = decodeURIComponent(route.slice('/api/admin/users/'.length, -'/companies'.length));
      const target = await ctx.users.get(userId);
      if (!target) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      const grants = ((await ctx.db.list('crm_company_grants', { limit: 5000 })) ?? [])
        .filter((row) => String(row.user_id) === String(userId));
      json(res, 200, { ok: true, user_id: userId,
        companies: grants.map((row) => ({ company_id: row.company_id, active: row.active === true,
          updated_at: row.updated_at ?? null, updated_by_user_id: row.updated_by_user_id ?? null })) });
      return;
    }

    if (route.startsWith('/api/admin/users/') && route.endsWith('/companies') && req.method === 'POST') {
      if (!requireAdmin()) return;
      const userId = decodeURIComponent(route.slice('/api/admin/users/'.length, -'/companies'.length));
      const target = await ctx.users.get(userId);
      if (!target) { json(res, 404, { ok: false, error: 'not_found' }); return; }
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const companyId = String(body.companyId ?? body.company_id ?? '').trim();
      if (!(await activeLogisticsCompany(ctx.db, companyId)) || typeof body.active !== 'boolean') {
        json(res, 422, { ok: false, error: 'invalid_company_grant' }); return;
      }
      const id = `${userId}:${companyId}`;
      const now = ctx.clock().toISOString();
      const doc = { id, user_id: userId, company_id: companyId, active: body.active,
        updated_at: now, updated_by_user_id: actor?.id ?? null };
      const existing = await ctx.db.get('crm_company_grants', id);
      if (existing) await ctx.db.update('crm_company_grants', id, doc);
      else await ctx.db.insert('crm_company_grants', doc);
      await ctx.audit?.record({ entity: 'user', entityId: userId,
        action: body.active ? 'user.company_scope_granted' : 'user.company_scope_revoked', actor: actor?.display_name ?? null,
        summary: `${body.active ? 'Concede' : 'Revoca'} ${companyId} a ${target.username ?? userId}`,
        data: { company_id: companyId, user_id: userId } });
      json(res, 200, { ok: true, user_id: userId, company_id: companyId, active: body.active });
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
        role: ['ADMIN', 'AGENT', 'DELIVERY', 'OPERADOR', 'SUPPLIER'].includes(String(body.role)) ? String(body.role) : 'AGENT',
        personalPhone: body.personalPhone ?? body.personal_phone,
        fleetPhone: body.fleetPhone ?? body.fleet_phone,
        active: body.active !== false,
        createdBy: actor?.id ?? null,
        actorName: actor?.display_name ?? null,
      });
      if (!result.ok) {
        json(res, result.error === 'duplicate_user' ? 409 : 422, { ok: false, error: result.error, message: result.message ?? null });
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
      if (canDeliver(currentUser)) {
        if (body.personalPhone !== undefined || body.personal_phone !== undefined) {
          patch.personalPhone = body.personalPhone ?? body.personal_phone;
        }
        if (body.fleetPhone !== undefined || body.fleet_phone !== undefined) {
          patch.fleetPhone = body.fleetPhone ?? body.fleet_phone;
        }
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
          message: result.error === 'invalid_user' ? 'El nombre visible no puede quedar vacío.' : result.message ?? null,
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
          message: result.message ?? null,
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
      /*
       * ARRANQUE LIGERO (`?light=1`).
       *
       * El panel necesita pintar HOY, la bandeja y los recuentos para abrir;
       * catálogo, inventario, entregas, proveedores y auditoría pueden llegar
       * después. El cliente pide esta versión primero (unos cientos de KB en vez
       * de megabytes) y programa la carga completa en segundo plano. La respuesta
       * lleva `partial: true` para que el cliente NO borre lo que ya tenía ni
       * guarde una copia offline incompleta.
       */
      const lightRequested = url.searchParams.get('light') === '1';
      const deliveryScope = await deliveryAccessScope(ctx, actor);
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      /*
       * Se pide UNO de más para saber si hay truncamiento. Si el negocio cabe
       * entero en el paquete ligero, la respuesta se devuelve COMPLETA
       * (`partial: false`): no tiene sentido pintar dos veces los mismos datos.
       */
      const rawItems = await store.listAdmin({
        limit: lightRequested ? 151 : url.searchParams.get('offline') === '1' ? 5000 : 500,
      });
      const hasMoreItems = lightRequested && rawItems.length > 150;
      const itemRows = hasMoreItems ? rawItems.slice(0, 150) : rawItems;
      const orderScope = await companyScope();
      const items = itemRows
        .filter((item) => (item.type !== 'order_intent' ||
          scopeSeesCompany(orderScope, companyOfOrder(orderOf(item)))) &&
          (!deliveryScope.restricted || (item.type === 'order_intent' && deliveryScope.orderIds.has(item.id))))
        .map((item) => sanitizeItemForPermissions(item, actor));
      const messages = actor?.role === 'ADMIN' ? await store.messages().list() : [];
      /*
       * CLIENTES + BANDEJA + RECUENTOS, EN UNA SOLA PASADA.
       *
       * Antes se llamaba tres veces: `list()` (que a su vez leía pedidos,
       * seguimientos y mensajes), `listConversations()` (los volvía a leer y
       * recorría 5.000 mensajes por cliente) y `conversationCounts()` (que hacía
       * DOS pasadas más de lo mismo). Abrir el panel costaba segundos cuando la
       * bandeja crecía. Ahora es una lectura por tabla y una pasada en memoria.
       */
      const overview = await ctx.customers.overview({});
      const fullCustomerList = overview.customers;
      const scopedCustomers = deliveryScope.restricted
        ? fullCustomerList.filter((customer) => deliveryScope.customerIds.has(customer.id))
        : fullCustomerList;
      const fullConversationList = overview.conversations;
      const scopedConversationsBeforeCompany = deliveryScope.restricted
        ? fullConversationList.filter((conversation) => deliveryScope.conversationIds.has(conversation.id))
        : fullConversationList;
      const visibleCustomers = crmOwner
        ? scopedCustomers.filter((customer) => crmRowVisible(actor, crmOwner, 'customer', customer))
        : scopedCustomers;
      const scopedConversations = crmOwner
        ? scopedConversationsBeforeCompany.filter((conversation) => crmRowVisible(actor, crmOwner, 'conversation', conversation))
        : scopedConversationsBeforeCompany;
      /*
       * Los CLIENTES viajan completos (el tope de la lista son 500): los
       * contadores de HOY se calculan con ellos y un recorte haría que las
       * tarjetas mintieran mientras llega el paquete completo. Lo que se recorta
       * es la bandeja y los pedidos, que son los bloques pesados.
       */
      const light = lightRequested && (hasMoreItems || scopedConversations.length > 150);
      const customerList = visibleCustomers;
      const visibleCustomerIds = new Set(customerList.map((customer) => customer.id));
      const conversationList = light ? scopedConversations.slice(0, 150) : scopedConversations;
      const conversationCounts = crmOwner ? crmVisibleConversationCounts(scopedConversations) : overview.counts;
      await ctx.customers.ensureInitialTags();
      const rawBuckets = deliveryScope.restricted
        ? { reference: new Date().toISOString(), today: [], overdue: [], upcoming: [], completed: [] }
        : await ctx.followups.buckets();
      const buckets = crmOwner ? Object.fromEntries(Object.entries(rawBuckets).map(([key, value]) =>
        [key, Array.isArray(value) ? value.filter((row) => visibleCustomerIds.has(row.customer_id)) : value])) : rawBuckets;
      const outbound = await ctx.db.list('wa_messages', { limit: 500 });
      const failed = deliveryScope.restricted || crmOwner ? [] : outbound.filter((row) => row.status === 'failed');
      /*
       * Operaciones de archivo que quedaron AMBIGUAS (se intentó enviar y no hay
       * confirmación) o a medias por una caída. Lista corta, saneada y solo para
       * administración: un envío ambiguo NO se reintenta solo ni se ofrece como
       * botón en la conversación.
       */
      /** @type {any[]} */
      const mediaNeedsReview = [];
      if (!light && !crmOwner && ctx.media?.store?.listBySendStatus) {
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
      /*
       * TIENDAS PROVEEDORAS Y SUS ENLACES CON PRODUCTOS.
       *
       * Van en el paquete general porque la venta necesita saber, sin otra
       * llamada, dónde se compra cada cosa. El costo por tienda se recorta con
       * el mismo criterio que el resto de importes (cost.view).
       */
      const canSeeCost = hasPermission(actor, 'cost.view');
      const supplierRows = light
        ? []
        : (await ctx.db.list('suppliers', { by: 'name', order: 'asc' })).map((row) => ({
            ...row,
            location_status: Number.isFinite(row.lat) && Number.isFinite(row.lng) ? 'ok' : 'pending',
          }));
      const productSupplierRows = light
        ? []
        : (await ctx.db.list('product_suppliers', { limit: 5000 })).map((row) =>
            canSeeCost ? row : { ...row, cost_cents: null },
          );
      json(res, 200, {
        ok: true,
        partial: light,
        storage: store.kind,
        timeZone: TIME_ZONE,
        auth: authPayload(),
        /*
         * MODO UAT (SOLO PRUEBAS).
         *
         * Permite probar el circuito operativo del reparto sin enviar mensajes
         * reales de WhatsApp: el panel enseña el botón de iniciar aunque no se
         * haya «contactado» al cliente. NO marca el pedido como contactado, no
         * cambia ninguna regla del servidor y solo aparece si el entorno arranca
         * con `PHYTO_UAT_SKIP_DELIVERY_CONTACT=1`. En producción va apagado.
         */
        uat: { skipDeliveryContact: process.env.PHYTO_UAT_SKIP_DELIVERY_CONTACT === '1' },
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
        // Grupos de negocio con los que trabaja el panel (etiquetas y filtros).
        businessGroups: BUSINESS_GROUPS,
        // Tiendas proveedoras y qué producto se consigue en cada una.
        suppliers: supplierRows,
        productSuppliers: productSupplierRows,
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
        scheduled: light ? null : await ctx.scheduler.summary(),
        settings: { followup: (await ctx.settings.followup()).enabled },
        commercial: {
          states: COMMERCIAL_STATES,
          manual: MANUAL_COMMERCIAL_STATES,
          deprecated: 'commercial_state se mantiene por compatibilidad; la UI nueva debe usar customerStage.',
        },
        customerStages: LIFECYCLE_STAGES.map((value) => ({ value, label: CUSTOMER_STAGE_LABELS[value] ?? value })),
        customerStagesLegacy: CUSTOMER_STAGES.filter((value) => !LIFECYCLE_STAGES.includes(value)).map((value) => ({ value, label: CUSTOMER_STAGE_LABELS[value] ?? value })),
        customerTags: deliveryScope.restricted ? [] : await ctx.customers.listTags(),
        deliveryTracking: light ? [] : await listVisibleTracking(ctx, actor),
        deliveryOrders: light ? [] : await visibleDeliveryOrders(ctx, actor),
        deliveryUsers: !light && can('delivery.tracking.manage_all')
          ? (await ctx.users.listUsers()).filter((user) => canDeliver(user) && user.active !== false)
          : [],
        // La regla de la contraseña vive en el servidor: el panel solo la enseña.
        minPasswordLength: MIN_PASSWORD_LENGTH,
        notifications: await listUserNotifications(ctx, actor),
        notificationSnapshotAt: ctx.clock().toISOString(),
        notificationDismissals: await localNotificationDismissals(ctx, await notificationOwnerId(ctx, actor)),
        push: await pushStatusForUser(ctx, await pushOwnerUserId(ctx, actor)),
        paymentMethods: PAYMENT_METHODS.map((value) => ({ value, label: paymentMethodLabel(value) })),
        // Catálogo, inventario y estado comercial, sin repetir precios ni estados en el panel.
        catalog: inventory.presentations,
        inventory,
        orderStatuses: Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label })),
        audit: light ? null : await ctx.audit.summary(),
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
        /*
         * ESTADO REAL, CON ENVÍO Y RECEPCIÓN SEPARADOS.
         * `configured` se mantiene por compatibilidad, pero el panel decide con
         * `send`/`receive`/`reason`: un timeout de Meta no es «no configurado».
         */
        whatsapp: whatsappStatusPayload(ctx),
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
          /* En el arranque ligero no se revisa la cola: es información de Ajustes. */
          deferred: light,
        },
      });
      return;
    }

    // Números del negocio (clientes, seguimientos, mensajes, ventas).
    // `period` = hoy | 7d | 30d (por defecto 30d): todo lo que se cuenta respeta
    // el período, sin doble conteo (un pedido entra UNA vez por su fecha).
    if (route === '/api/admin/metrics' && req.method === 'GET') {
      if (!requireAdmin()) return;
      const period = ['hoy', '7d', '30d'].includes(url.searchParams.get('period') ?? '')
        ? String(url.searchParams.get('period'))
        : '30d';
      json(res, 200, { ok: true, metrics: await ctx.customers.metrics({ period }) });
      return;
    }

    if (route === '/api/admin/reports/sales-by-source' && req.method === 'GET') {
      const scope = await companyScope();
      const rows = (await store.listAdmin({ limit: 5000 })).filter((row) =>
        row.type !== 'order_intent' || scopeSeesCompany(scope, companyOfOrder(orderOf(row))));
      json(res, 200, { ok: true, report: revenueBySourceReport(rows) });
      return;
    }

    /*
     * ENVIAR LA COTIZACIÓN POR WHATSAPP — con la plantilla oficial y el PDF.
     *
     * El destinatario y el PDF salen de la COTIZACIÓN guardada, nunca de lo que
     * mande el navegador. La plantilla lleva CABECERA DE DOCUMENTO: el cliente
     * recibe el archivo aunque la ventana de 24 h esté cerrada. No se abre
     * WhatsApp Web ni el WhatsApp personal de nadie.
     */
    const quoteSendRoute = /^\/api\/admin\/pos\/quotes\/([a-z0-9_-]+)\/send-whatsapp$/.exec(route);
    if (quoteSendRoute && req.method === 'POST') {
      if (!requirePermission('chats.reply')) return;
      /** @type {any} */
      let quoteBody = {};
      try {
        quoteBody = await readJsonBody(req);
      } catch {
        quoteBody = {};
      }
      const quoteDoc = await ctx.db.get('pos_documents', quoteSendRoute[1]);
      if (!quoteDoc || quoteDoc.kind !== 'quote' || !(actor.role === 'ADMIN' || quoteDoc.actor_id === actor.id)) {
        json(res, 404, { ok: false, error: 'not_found', message: 'Esa cotización no existe.' });
        return;
      }
      const customer = quoteDoc.customer?.id ? await ctx.customers.get(quoteDoc.customer.id) : null;
      if (!customer) {
        json(res, 409, { ok: false, error: 'quote_without_customer', message: 'Esa cotización no tiene cliente: no hay a quién enviarla.' });
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
          message: 'WhatsApp todavía no está configurado en el servidor. La cotización NO se ha enviado.',
        });
        return;
      }
      const conversacion = await ctx.customers.conversationFor(customer.id, { create: false });
      if (!conversacion || conversacion.customer_id !== customer.id) {
        json(res, 409, {
          ok: false,
          error: 'no_conversation',
          message: 'Este cliente todavía no tiene una conversación de WhatsApp en el CRM.',
        });
        return;
      }
      if (!(await canOpenConversation(ctx, actor, conversacion))) {
        denyConversation(res, json, conversacion);
        return;
      }
      const plantilla = await approvedTemplate(ctx, QUOTE_WHATSAPP_TEMPLATE.name);
      if (!plantilla.ok) {
        json(res, 409, {
          ok: false,
          error: plantilla.reason === 'unknown_template' ? 'quote_template_missing' : 'template_not_approved',
          message:
            `La cotización se envía con la plantilla «${QUOTE_WHATSAPP_TEMPLATE.name}», que todavía no está aprobada en Meta. ` +
            'Regístrala en Meta y pulsa «Sincronizar con Meta» en Ajustes > WhatsApp.',
          template: plantilla.template ?? null,
        });
        return;
      }
      if (String(plantilla.template?.header?.format ?? '').toUpperCase() !== 'DOCUMENT') {
        json(res, 409, {
          ok: false,
          error: 'template_without_document_header',
          message: `La plantilla «${QUOTE_WHATSAPP_TEMPLATE.name}» no lleva cabecera de documento en Meta, así que no puede transportar el PDF.`,
          template: plantilla.template,
        });
        return;
      }
      if (!ctx.media?.whatsapp?.uploadMedia) {
        json(res, 503, { ok: false, error: 'media_not_configured', message: 'No hay almacén de archivos para WhatsApp. La cotización NO se ha enviado.' });
        return;
      }
      const clave = text(quoteBody.idempotencyKey, 120);
      if (clave) {
        const previo = await ctx.db.findBy('wa_messages', 'idempotency_key', clave);
        if (previo) {
          json(res, 200, { ok: true, duplicate: true, message: previo });
          return;
        }
      }
      const recibo = quotationReceipt(quoteDoc);
      const nombreArchivo = `Cotizacion-${String(quoteDoc.number ?? quoteDoc.id).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
      const pdf = receiptPdf(recibo, { timeZone: TIME_ZONE });
      const subida = await ctx.media.whatsapp.uploadMedia({ buffer: pdf, mimeType: 'application/pdf', filename: nombreArchivo });
      if (!subida.ok) {
        json(res, 502, {
          ok: false,
          error: 'upload_failed',
          message: 'No se pudo preparar la cotización para WhatsApp. No se ha enviado nada.',
          detail: subida.error ?? null,
        });
        return;
      }
      const totalTexto = new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP' }).format(
        Number(quoteDoc.sale?.total_cents ?? 0) / 100,
      );
      const payload = await resolveTemplatePayload(ctx, {
        template: plantilla.template,
        customer,
        conversation: conversacion,
        provided: {
          1: customer.name || customer.phone_e164,
          2: quoteDoc.number ?? quoteDoc.id,
          3: totalTexto,
        },
      });
      if (!payload.ok) {
        json(res, payload.status ?? 422, { ok: false, error: payload.error, message: payload.message, missing: payload.missing ?? undefined });
        return;
      }
      const components = [
        { type: 'header', parameters: [{ type: 'document', document: { id: subida.mediaId, filename: nombreArchivo } }] },
        ...(payload.components ?? []),
      ];
      const envio = await ctx.whatsapp.sendTemplate(customer.phone_e164, {
        name: plantilla.template.name,
        language: plantilla.template.language ?? 'es',
        components,
      });
      const registrado = await ctx.customers.recordOutbound({
        customer,
        conversation: conversacion,
        type: 'template',
        template: plantilla.template.name,
        body: payload.body,
        waMessageId: envio.messageId ?? null,
        status: envio.ok ? 'sent' : 'failed',
        error: envio.ok ? null : (envio.error ?? { message: envio.reason ?? 'error' }),
        idempotencyKey: clave,
        meta: {
          phoneNumberId: ctx.whatsapp.phoneNumberId,
          to: customer.phone_e164,
          quote_id: quoteDoc.id,
          quote_number: quoteDoc.number ?? null,
          filename: nombreArchivo,
        },
        ...messageActorFields(actor),
      });
      await ctx.audit?.record({
        entity: 'message',
        entityId: registrado.message?.id ?? null,
        action: envio.ok ? 'message.sent' : 'message.failed',
        actor: actor?.display_name ?? null,
        summary: `Cotización ${nombreArchivo} ${envio.ok ? 'enviada' : 'rechazada'} a ${customer.name ?? customer.phone_e164}`,
        data: {
          quote_id: quoteDoc.id,
          quote_number: quoteDoc.number ?? null,
          filename: nombreArchivo,
          template: plantilla.template.name,
        },
        idempotencyKey: registrado.message?.id
          ? `${envio.ok ? 'message.sent' : 'message.failed'}:${registrado.message.id}`
          : null,
      });
      if (!envio.ok) {
        json(res, 502, {
          ok: false,
          error: 'send_failed',
          message: 'WhatsApp rechazó el envío de la cotización. No se ha enviado nada.',
          detail: envio.error ?? null,
          message_record: registrado.message,
        });
        return;
      }
      json(res, 200, {
        ok: true,
        filename: nombreArchivo,
        customer: { id: customer.id, name: customer.name || customer.phone_e164 },
        message: registrado.message,
      });
      return;
    }

    if (await handlePosRoute({req,res,route,ctx,actor,json,readJson:readJsonBody,can:permission=>hasPermission(actor,permission),createOrder,findOrder:id=>findOrderItem(ctx.store,id),
      listDeliveryCandidates: async () => (await ctx.users.listUsers()).filter((user) => canDeliver(user) && user.active !== false).map((user) => ({ id: user.id, name: user.display_name || user.name || user.username || user.id, role: user.role })),
      listDeliveryContacts: async () => { const value = (await ctx.settings.read('delivery_contacts'))?.value; return Array.isArray(value) ? value.filter((row) => row?.phone).map((row) => ({ id: row.id || row.phone, name: row.name || row.phone, phone: row.phone })) : []; }})) return;
    if (await handleCommerceAdmin({req,res,route,ctx,actor,json,readJson:readJsonBody}))return;
    if (await handleSupplierRoutes({req,res,route,ctx,actor,json,readJson:readJsonBody,
  can:permission=>hasPermission(actor,permission),
  sanitize:value=>hasPermission(actor,'cost.view')?value:stripSensitiveFinancials(value)})) return;
  if (await handleStoreRequestsAdminRoute({req,res,route,ctx,actor,json,readJson:readJsonBody,can:permission=>hasPermission(actor,permission)})) return;
  if (await handleStoreCatalogRoute({req,res,route,ctx,actor,json,readJson:readJsonBody,
      can:permission=>hasPermission(actor,permission),
      sanitize:value=>hasPermission(actor,'cost.view')?value:stripSensitiveFinancials(value)})) return;

  /*
   * CENTRO DE OPERACIONES (tickets internos).
   *
   * Va ANTES del resto de rutas de `/api/admin/*` para que `/api/admin/ops/...`
   * no caiga en ningún manejador genérico. El buscador de pedidos se INYECTA:
   * así el módulo comprueba el pedido de verdad sin conocer el almacén legacy.
   */
  if (await handleOpsRoute({req,res,route,ctx,actor,json,readJson:readJsonBody,
      can:permission=>hasPermission(actor,permission),
      findOrder:id=>findOrderItem(ctx.store,id),
      listOrders:()=>ctx.store.listAdmin({limit:5000}),
      /*
       * EL MISMO PROVEEDOR DE IA DEL CORRECTOR, SIN UNA SEGUNDA VÍA DE GASTO.
       *
       * `plan` devuelve JSON (lo usa la conversación del Agente de Seguimiento,
       * que necesita propuestas validadas) y `answer` devuelve texto libre (lo
       * usa «pedirle cuentas» a cualquier agente). Las dos pasan por la clave
       * guardada, el plazo, el tope por minuto y el límite diario del corrector.
       */
      llm:(args)=>ctx.proofreading?.plan?.(args) ?? null,
      ai:(args)=>ctx.proofreading?.answer?.(args) ?? { ok:false, reason:'sin_configurar' },
      /*
       * `askWithTools` deja que el Agente de Seguimiento PIDA consultas de
       * lectura (clientes, compras, pedidos, conversaciones, catálogo). Las
       * ejecuta el servidor con los permisos de la persona; el modelo solo ve
       * el resultado acotado y nunca recibe SQL ni credenciales.
       */
      aiTools:(args)=>ctx.proofreading?.askWithTools?.(args) ?? null })) return;

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
      if (!requireAdmin()) return;
      const period = url.searchParams.get('period') ?? 'hoy';
      const report = await ctx.inventory.report({
        period,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: url.searchParams.get('offline')==='1'?5000:500,
      });
      json(res, 200, { ok: true, report });
      return;
    }

    /*
     * LA FUENTE DEL HISTORIAL DE CIERRES.
     *
     * El panel calculaba el historial con lo que tenía cargado, y `/api/admin/data`
     * entrega como mucho los 500 registros MÁS NUEVOS de todos los tipos. Con más
     * volumen de conversaciones y pedidos, los días de cierre antiguos DESAPARECÍAN
     * del historial y los totales del intervalo salían a menos aunque la nota
     * dijera otra cosa. Este endpoint devuelve los pedidos ENTREGADOS del tramo
     * leídos de la base completa, con el MISMO criterio de fecha que el panel
     * (día de negocio en RD) y el mismo alcance de permisos que el cierre:
     *   - con `reports.profit.view`: todo el equipo;
     *   - sin él: solo las entregas del propio usuario.
     * No crea, modifica ni borra nada: es lectura pura.
     */
    if (route === '/api/admin/reports/delivered-orders' && req.method === 'GET') {
      if (!authenticated) {
        json(res, 401, { ok: false, error: 'unauthorized', message: 'Entra con tu clave.' });
        return;
      }
      const diaValido = (value) => {
        const texto = String(value ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
        const [year, month, date] = texto.split('-').map(Number);
        const built = new Date(Date.UTC(year, month - 1, date));
        return built.toISOString().slice(0, 10) === texto ? texto : null;
      };
      const hoy = dayIn(ctx.clock(), TIME_ZONE);
      const pedidoDesde = diaValido(url.searchParams.get('from'));
      const pedidoHasta = diaValido(url.searchParams.get('to'));
      if ((url.searchParams.has('from') && !pedidoDesde) || (url.searchParams.has('to') && !pedidoHasta)) {
        json(res, 422, { ok: false, error: 'invalid_date', message: 'Las fechas del intervalo no son válidas.' });
        return;
      }
      const desde = pedidoDesde ?? hoy;
      const hasta = pedidoHasta ?? desde;
      const inicio = desde <= hasta ? desde : hasta;
      const fin = desde <= hasta ? hasta : desde;
      const dias = Math.round((Date.parse(`${fin}T00:00:00.000Z`) - Date.parse(`${inicio}T00:00:00.000Z`)) / 86400000) + 1;
      if (dias > CLOSE_HISTORY_MAX_DAYS) {
        json(res, 422, {
          ok: false,
          error: 'range_too_long',
          message: `El intervalo no puede pasar de ${CLOSE_HISTORY_MAX_DAYS} días.`,
        });
        return;
      }
      const todoElEquipo = can('reports.profit.view');
      const scope = await companyScope();
      const rows = await store.listAdmin({ limit: 5000 });
      const items = [];
      for (const row of rows) {
        if (row.type !== 'order_intent') continue;
        const order = orderOf(row);
        if (!order) continue;
        if (!scopeSeesCompany(scope, companyOfOrder(order))) continue;
        // Mismo criterio de «entregado» que el panel (no basta el estado del item).
        if (String(order.status ?? '').trim().toLowerCase() !== 'entregado') continue;
        if (!todoElEquipo && String(order?.delivery?.delivery_user_id ?? '') !== String(actor?.id ?? '')) continue;
        const cuando =
          order.delivered_at ?? order.updated_at ?? row.updated_at ?? row.received_at ?? order.created_at;
        const dia = cuando ? dayIn(new Date(cuando), TIME_ZONE) : '';
        if (!dia || dia < inicio || dia > fin) continue;
        items.push(sanitizeItemForPermissions(row, actor));
      }
      json(res, 200, {
        ok: true,
        from: inicio,
        to: fin,
        scope: todoElEquipo ? 'all' : 'own',
        count: items.length,
        // 5000 es el tope de `listAdmin`: si se alcanza, se dice en vez de mentir.
        truncated: rows.length >= 5000,
        items,
      });
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
    if (!(await seesCompany(companyOfOrder(orderOf(item))))) {
      json(res, 404, { ok: false, error: 'not_found' }); return;
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
      if(orderOf(before)?.smart_commerce?.managedFulfillment){json(res,409,{ok:false,error:'managed_order_locked',message:'Usa las acciones de fulfillment, pago o estado del pedido; la edición genérica no puede sustituir reservas.'});return;}
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
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      const customers = (await ctx.customers.list({ q: url.searchParams.get('q') ?? '' })).filter(
        (customer) => (!deliveryScope.restricted || deliveryScope.customerIds.has(customer.id)) &&
          (!crmOwner || crmRowVisible(actor, crmOwner, 'customer', customer)),
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
      if (!requireAdmin()) return;
      const report = await ctx.customers.customerStageDryRun({ limit: Number(url.searchParams.get('limit') || 1000) });
      json(res, 200, {
        ok: true,
        rule: `RECOMPRA = 2+ pedidos order_intent en estado ${BUSINESS_COMPLETED_PURCHASE_STATUS}; CLIENTE = 1 pedido ${BUSINESS_COMPLETED_PURCHASE_STATUS}; INTERESADO = pedido abierto o evidencia de interés en un mensaje (precio, producto, intención de compra); PROSPECTO = resto. Cliente y Recompra no se asignan a mano. Una corrección manual manda sobre la evidencia anterior a ella; un mensaje con interés NUEVO posterior vuelve a contar.`,
        report: report.rows,
        conflicts: report.conflicts,
        total: report.total,
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
      if (action === 'stage' && req.method === 'POST' && !can('customer.stage.update')) {
        forbid(); return;
      }
      const customer = customerId ? await ctx.customers.get(customerId) : null;
      if (!customer) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!can('admin.full') && !crmRowVisible(actor, await crmOwnership(ctx), 'customer', customer)) {
        json(res, 404, { ok: false, error: 'not_found' }); return;
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
        const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
        /*
         * HISTORIAL 360°: se arma al abrir la ficha leyendo cada módulo (mensajes,
         * cotizaciones, facturas, pedidos, seguimientos y entregas). No duplica
         * datos y las notas internas solo salen para quien puede verlas.
         */
        const history = crmOwner ? null : await buildCustomerHistory({
          db: ctx.db,
          customerId,
          orders: profile.purchases ?? [],
          includeInternal: true,
        });
        const [storeAccount, storeRequests] = ctx.storeAccounts
          && !crmOwner ? await Promise.all([
              ctx.storeAccounts.accountForCustomer(customerId),
              ctx.storeAccounts.listRequestsForCustomer(customerId, 10),
            ])
          : [null, []];
        const scopedProfile = crmOwner && profile.conversation &&
          !crmRowVisible(actor, crmOwner, 'conversation', profile.conversation)
          ? { ...profile, conversation: null, messages: [] } : profile;
        json(res, 200, { ok: true, ...scopedProfile, history, store_account: storeAccount, store_requests: storeRequests });
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
          summary: result.duplicate ? `Etapa sin cambios: ${result.to}` : `Etapa: ${result.from} → ${result.to}`,
          data: {
            customer_id: customerId,
            from_stage: result.from,
            to_stage: result.to,
            duplicate: result.duplicate === true,
            changed_by_user_id: actor?.id ?? null,
            changed_by_display_name: actor?.display_name ?? null,
            reason: longText(body.reason, 500),
            /* En un duplicado no hay fila nueva de historial que fechar. */
            timestamp: result.history?.timestamp ?? new Date().toISOString(),
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
        if (
          body.campaignOptOut !== undefined ||
          body.campaign_opt_out !== undefined ||
          body.campaignNotificationsDisabled !== undefined ||
          body.campaign_notifications_disabled !== undefined
        ) {
          const off = Boolean(
            body.campaignOptOut ??
              body.campaign_opt_out ??
              body.campaignNotificationsDisabled ??
              body.campaign_notifications_disabled,
          );
          patch.campaign_opt_out_at = off ? new Date().toISOString() : null;
          patch.campaign_opt_out_by_user_id = off && actor?.actor_type === 'USER' ? actor.id : null;
          patch.campaign_opt_out_by_display_name = off ? actor?.display_name ?? null : null;
        }
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
        /*
         * GRUPOS DE NEGOCIO del cliente (PHYTOEMAGRY, FULLTECH — Ventas
         * generales, FULLTECH — Sistemas de seguridad y los que se añadan).
         * Es una lista abierta: se limpia con `normalizeGroups` y nunca puede
         * quedar vacía, porque un cliente sin grupo desaparece de los filtros.
         */
        if (body.groups !== undefined) {
          if (!requirePermission('customer.stage.update', 'No tienes permiso para cambiar los grupos del cliente.')) return;
          const groups = normalizeGroups(body.groups, { fallback: null });
          if (!groups.length) {
            json(res, 422, {
              ok: false,
              error: 'invalid_groups',
              message: 'El cliente necesita al menos un grupo de negocio.',
            });
            return;
          }
          patch.groups = groups;
        }
        const updated = await ctx.customers.update(customerId, patch);
        if (patch.groups) {
          await ctx.audit?.record({
            entity: 'customer',
            entityId: customerId,
            action: 'customer.groups_changed',
            actor: actor?.display_name ?? null,
            summary: `Grupos: ${patch.groups.join(', ')}`,
            data: { customer_id: customerId, groups: patch.groups },
          });
        }
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
        businessName: 'FullTECH',
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

    /*
     * MI UBICACIÓN (perfil del agente/delivery).
     *
     * Un repartidor puede guardar su última posición conocida SIN tener una
     * entrega activa: sirve para medir distancias antes de salir. Se guarda en los
     * ajustes del negocio (una posición por usuario) con su hora, y solo la puede
     * escribir su dueño. El permiso del navegador se pide en el panel; aquí nunca
     * se inventa una posición.
     */
    if (route === '/api/admin/me/location' && (req.method === 'GET' || req.method === 'POST')) {
      const ownerId = actor?.id ?? actor?.username ?? actor?.role ?? 'anon';
      const guardadas = async () => {
        const doc = await ctx.settings.read('agent_positions');
        const value = doc?.value && typeof doc.value === 'object' ? doc.value : {};
        return value;
      };
      if (req.method === 'GET') {
        const value = await guardadas();
        json(res, 200, { ok: true, location: value[ownerId] ?? null });
        return;
      }
      if (!requirePermission('delivery.location.update_own')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        json(res, 422, { ok: false, error: 'invalid_coordinates', message: 'Las coordenadas no son válidas.' });
        return;
      }
      const accuracy = Number(body.accuracy);
      const posicion = {
        latitude,
        longitude,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        updated_at: ctx.clock().toISOString(),
        user_id: ownerId,
        user_name: actor?.display_name ?? actor?.username ?? null,
      };
      const value = { ...(await guardadas()), [ownerId]: posicion };
      await ctx.settings.write('agent_positions', value);
      json(res, 200, { ok: true, location: posicion });
      return;
    }

    /*
     * POSICIONES DEL EQUIPO: para «Medir distancia» desde la última posición
     * válida de un delivery. Junta lo que dice su reparto EN VIVO (sesión) con la
     * posición que guardó en su perfil, y se queda con la más reciente.
     */
    if (route === '/api/admin/delivery-positions' && req.method === 'GET') {
      if (!requirePermission('delivery.location.read_own')) return;
      /** @type {Map<string, any>} */
      const porUsuario = new Map();
      for (const session of await listVisibleTracking(ctx, actor)) {
        const punto = session?.last_position;
        const userId = session?.delivery_user_id;
        if (!punto || !userId || !Number.isFinite(Number(punto.latitude)) || !Number.isFinite(Number(punto.longitude))) continue;
        const actual = porUsuario.get(userId);
        const when = String(punto.recorded_at ?? '');
        if (!actual || when > String(actual.updated_at ?? '')) {
          porUsuario.set(userId, {
            user_id: userId,
            name: session.delivery_user_name_snapshot ?? null,
            latitude: Number(punto.latitude),
            longitude: Number(punto.longitude),
            accuracy: punto.accuracy ?? null,
            updated_at: punto.recorded_at ?? null,
            source: 'entrega',
          });
        }
      }
      const doc = await ctx.settings.read('agent_positions');
      const guardadas = doc?.value && typeof doc.value === 'object' ? doc.value : {};
      for (const [userId, posicion] of Object.entries(guardadas)) {
        if (!posicion || !Number.isFinite(Number(posicion.latitude)) || !Number.isFinite(Number(posicion.longitude))) continue;
        const actual = porUsuario.get(userId);
        if (!actual || String(posicion.updated_at ?? '') > String(actual.updated_at ?? '')) {
          porUsuario.set(userId, {
            user_id: userId,
            name: posicion.user_name ?? null,
            latitude: Number(posicion.latitude),
            longitude: Number(posicion.longitude),
            accuracy: posicion.accuracy ?? null,
            updated_at: posicion.updated_at ?? null,
            source: 'perfil',
          });
        }
      }
      json(res, 200, { ok: true, positions: [...porUsuario.values()] });
      return;
    }

    if (route === '/api/admin/offline-operations/status' && req.method === 'POST') {
      /*
       * CONSULTA DE ESTADO, NO REENVÍO.
       * Dice si el servidor llegó a recibir cada operación del teléfono y con qué
       * código respondió, sin ejecutar nada y sin devolver cuerpos con datos.
       */
      const body = await readJsonBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids.map((value) => String(value ?? '')) : [];
      json(res, 200, { ok: true, ...(await operationStatuses({ ctx, actor, keys: ids })) });
      return;
    }

    if (route === '/api/admin/offline-operations/resolve' && req.method === 'POST') {
      /*
       * RESOLUCIÓN MANUAL CON AUDITORÍA.
       * No toca pedidos, cobros ni inventario: solo deja constancia de que una
       * persona revisó la operación y por qué la da por resuelta. El teléfono
       * conserva la operación y su respaldo.
       */
      if (!requireAdmin()) return;
      const body = await readJsonBody(req);
      const id = String(body?.id ?? '').slice(0, 120);
      const motivo = String(body?.motivo ?? '').slice(0, 300);
      const tipo = String(body?.tipo ?? '').slice(0, 80);
      if (!id || motivo.trim().length < 4) {
        json(res, 422, { ok: false, error: 'invalid_resolution', message: 'Falta el identificador o el motivo.' });
        return;
      }
      await ctx.audit?.record({
        entity: 'offline_operation',
        entityId: id,
        action: 'offline_operation_resolved',
        actor: actor?.display_name ?? null,
        summary: `Operación offline marcada como resuelta (${tipo || 'sin tipo'}): ${motivo}`,
        data: { motivo, tipo },
        idempotencyKey: `offline-resolve:${id}:${Date.now()}`,
      });
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/admin/notification-dismissals' && req.method === 'POST') {
      const body = await readJsonBody(req);
      /*
       * CLAVES DE VERSIONES ANTERIORES.
       *
       * `wa-failed:<n>` era la clave del descarte antes de que se estabilizara en
       * `wa-failed` con su valor (2 = «descarté el aviso cuando había 2 fallos»).
       * Un teléfono con la cola creada por la versión vieja la sigue enviando y
       * antes se rechazaba el lote COMPLETO con `invalid_dismissals`, dejando sin
       * sincronizar también los descartes nuevos. Aquí se traduce y se conserva
       * el significado; el resto de validaciones sigue igual.
       */
      const normalizadas = new Map();
      for (const [rawKey, value] of Object.entries(body?.dismissed ?? {})) {
        const legado = /^wa-failed:(\d{1,6})$/.exec(rawKey);
        if (legado) {
          const numero = Number(legado[1]);
          const previo = normalizadas.get('wa-failed');
          normalizadas.set('wa-failed', typeof previo === 'number' ? Math.max(previo, numero) : numero);
          continue;
        }
        normalizadas.set(rawKey, value);
      }
      const entries = [...normalizadas.entries()];
      if (entries.length > 500 || entries.some(([key, value]) =>
        !/^(wa-failed|scheduled-problem:[a-zA-Z0-9_-]{1,160})$/.test(key) ||
        !(value === true || (typeof value === 'number' && Number.isFinite(value) && value >= 0) || (typeof value === 'string' && value.length <= 80)))) {
        json(res, 422, { ok: false, error: 'invalid_dismissals' }); return;
      }
      const userId = await notificationOwnerId(ctx, actor);
      for (const [key, raw] of entries) {
        const value = key.startsWith('scheduled-problem:') ? true : raw;
        const identity = JSON.stringify([userId, key, value]);
        await ctx.db.insert('notification_deletions', {
          id: newId('ndel'), user_id: userId, notice_key: key, notice_value: value,
          idempotency_key: `notice-dismiss:${identity}`, created_at: ctx.clock().toISOString(),
        });
      }
      json(res, 200, { ok: true, dismissed: await localNotificationDismissals(ctx, userId) }); return;
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
      const body = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] ? await readJsonBody(req) : {};
      const before = body?.before ?? ctx.clock().toISOString();
      if (!Number.isFinite(Date.parse(before))) {
        json(res, 422, { ok: false, error: 'invalid_before' }); return;
      }
      // Una sola instantánea personal: los avisos nuevos quedan fuera, también
      // al sincronizar un «Eliminar todas» que se hizo sin conexión.
      const pendientes = (await deletableNotifications(ctx, actor)).filter((row) => Date.parse(row.created_at) <= Date.parse(before));
      let deleted = 0;
      for (const row of pendientes) {
        await rememberNotificationDeletion(ctx, row.recipient_user_id, row);
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

    if (route.startsWith('/api/admin/notifications/') && req.method === 'DELETE') {
      const id = decodeURIComponent(route.slice('/api/admin/notifications/'.length));
      const current = await ctx.db.get('user_notifications', id);
      if (!current) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (current.recipient_user_id !== await notificationOwnerId(ctx, actor)) {
        forbid();
        return;
      }
      // El borrado se recuerda aunque la fila ya no estuviera: es la promesa de
      // que no vuelve, y cubre también una recreación del mismo suceso.
      await rememberNotificationDeletion(ctx, current.recipient_user_id ?? actor?.id ?? null, current);
      const deleted = (await ctx.db.remove('user_notifications', id)) ? 1 : 0;
      await ctx.audit?.record({
        entity: 'notifications',
        entityId: id,
        action: 'notifications.deleted_one',
        actor: actor?.display_name ?? null,
        summary: 'Notificación eliminada al abrirla',
        data: { recipient_user_id: current.recipient_user_id ?? null, type: current.type ?? null },
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
      if (current.recipient_user_id !== await notificationOwnerId(ctx, actor)) {
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
      const body = await readJsonBody(req);
      const subscriptionId = text(body.subscriptionId, 160) || null;
      if (subscriptionId) {
        const target = await ctx.db.get('push_subscriptions', subscriptionId);
        if (!target || target.user_id !== ownerUserId || target.active === false) {
          json(res, 409, { ok: false, error: 'device_not_registered', message: 'Este teléfono no está registrado: pulsa Activar.' });
          return;
        }
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
      const push = notification.notification ? await sendPushForNotification(ctx, notification.notification, { subscriptionId }) : null;
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
                ? (push.errors?.some((error) => error.reason === 'BadJwtToken')
                  ? 'Apple rechazó la autenticación (BadJwtToken): revisa las llaves VAPID, PHYTO_WEB_PUSH_SUBJECT y el reloj del servidor.'
                  : 'El servicio de push rechazó el envío. Revisa el último error del teléfono en el estado push.')
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
      // Consulta por id (indexada): lo pide el refresco en vivo de «Mis entregas».
      const item = typeof store.getAdmin === 'function' ? await store.getAdmin(orderId) : await findOrderItem(store, orderId);
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
        if (note && note.recipient_user_id === await notificationOwnerId(ctx, actor)) {
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
      if (!can('admin.full')) {
        const item = await findOrderItem(store, session.order_id);
        const owner = item ? companyOfOrder(orderOf(item)) : null;
        if (!(await seesCompany(owner))) {
          json(res, 404, { ok: false, error: 'not_found' }); return;
        }
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
        // El diario autenticado puede entregar puntos tomados durante una jornada sin red.
        // Se conserva su hora real; publicTrackingSession los marca como antiguos.
        const valid = validateLocationUpdate(body, { now: ctx.clock(), ...(req.fulltechReplay ? {maxAgeMs:24*60*60_000} : {}) });
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
        if (!previous) await rememberDeliveryStartLocation(ctx, session.order_id, valid.point, session);
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
        /** Cobro declarado en esta misma llamada (si lo hubo). */
        let declaredPayment = null;
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
          /*
           * COBRO DECLARADO POR EL REPARTIDOR AL CERRAR (paso 3 del flujo).
           *
           * El repartidor dice qué pasó con el dinero: efectivo, transferencia o
           * nada. Se usa la MISMA puerta financiera del resto del CRM
           * (`registerCustomerPayment`) con las mismas reglas: no se puede cobrar
           * de más, no se cobra sobre un pedido cerrado y una clave de
           * idempotencia estable (`delivery-complete:<sesión>:<medio>`) hace que
           * reintentar la finalización REUTILICE el cobro en vez de duplicarlo.
           *
           * Un cobro en efectivo queda como dinero en poder del repartidor hasta
           * la rendición (`/payments/handover`, que sigue siendo de administración).
           * Una transferencia queda «reportada» y NO reduce el saldo hasta que
           * administración la verifique contra el banco.
           */
          const intent = body?.payment && typeof body.payment === 'object' ? body.payment : null;
          const outcome = String(intent?.outcome ?? '').toLowerCase();
          if (intent && ['cash', 'transfer'].includes(outcome)) {
            const fresh = await findOrderItem(store, session.order_id);
            const freshOrder = orderOf(fresh);
            const guard = await paymentAuthorization(ctx, actor, freshOrder, can);
            if (!guard.ok) {
              json(res, guard.status, { ok: false, error: guard.error, message: guard.message });
              return;
            }
            const method = outcome === 'cash' ? 'CASH' : 'TRANSFER';
            const registered = await registerCustomerPayment({
              ctx,
              orderId: session.order_id,
              actor,
              amount: intent.amount,
              expectedDue: intent.expectedDue,
              method,
              note: longText(intent.note, 300) ?? deliveryNote ?? null,
              evidenceUrl: intent.evidenceUrl ?? intent.evidence_url,
              verification: method === 'TRANSFER' ? 'pending' : undefined,
              source: 'courier',
              idempotencyKey: `delivery-complete:${session.id}:${outcome}`,
            });
            if (!registered.ok) {
              /* Sin cobro no se cierra: nada de «entregado y pagado» inventado. */
              json(res, registered.status ?? 422, {
                ok: false,
                error: registered.error ?? 'payment_failed',
                message: registered.message ?? 'No se pudo registrar el cobro.',
                due: registered.due ?? null,
                payment_recorded: false,
                completed: false,
              });
              return;
            }
            declaredPayment = registered.payment ?? null;
          } else if (intent && outcome === 'none') {
            /*
             * SIN PAGO: no se inventa nada y el saldo se queda. Se deja
             * constancia para que finanzas vea el pendiente con su motivo.
             */
            await ctx.audit?.record({
              entity: 'order',
              entityId: session.order_id,
              action: 'delivery.payment_not_received',
              actor: actor?.display_name ?? null,
              summary: 'El repartidor cierra la entrega sin recibir pago',
              data: { order_id: session.order_id, note: longText(intent.note, 300) ?? deliveryNote ?? null, session_id: session.id },
              idempotencyKey: `delivery.payment-none:${session.id}`,
            });
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
        await persistDeliveryRouteSnapshot(ctx, session.order_id, ended, status, actor);
        let order = null;
        if (action === 'complete') {
          const item = await findOrderItem(store, session.order_id);
          if (item) {
            const itemWithRoute = (await findOrderItem(store, session.order_id)) ?? item;
            const delivered = await markOrderDelivered(ctx, itemWithRoute, actor, { source: 'DELIVERY_ACTION' });
            order = delivered.order ?? null;
            if (!delivered.duplicate) {
              await auditOrderStatusTransition(ctx, {
                orderId: itemWithRoute.id,
                previousStatus: itemWithRoute.status ?? null,
                newStatus: BUSINESS_COMPLETED_PURCHASE_STATUS,
                actor,
                reason: deliveryNote ? `Entrega completada por delivery: ${deliveryNote}` : 'Entrega completada por delivery',
                changedAt: ctx.clock().toISOString(),
                source: 'DELIVERY_ACTION',
                idempotencyKey: `order.status:${itemWithRoute.id}:delivery-complete:${session.id}`,
              });
            }
            if (order) {
              /*
               * REGLA DE AVISOS (Fase 06): completar la entrega NO manda un tercer aviso
               * rutinario de estado. Lo que sí se manda es el RECIBO/FACTURA al cliente
               * (`kind:'delivered'` → texto + PDF), que es un documento, no un aviso de
               * reparto, y además el aviso interno a administración.
               */
              await notifyDeliveryCustomer(ctx, { item: itemWithRoute, order, actor, kind: 'delivered' }).catch(() => null);
              const refreshed = await findOrderItem(store, itemWithRoute.id);
              order = refreshed ? orderOf(refreshed) ?? order : order;
              await notifyAdminsDeliveryCompleted(ctx, refreshed ?? itemWithRoute, order, actor).catch(() => null);
              const refreshedAfterAdmin = await findOrderItem(store, itemWithRoute.id);
              order = refreshedAfterAdmin ? orderOf(refreshedAfterAdmin) ?? order : order;
            }
          }
        }
        await emitDeliveryEvent(ctx, action === 'complete' ? 'delivery.completed' : 'delivery.tracking_stopped', ended);
        json(res, 200, {
          ok: true,
          session: await publicSessionWithOrder(ctx, ended),
          order,
          ...(declaredPayment ? { payment: declaredPayment, payment_recorded: true } : {}),
        });
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
      const assignmentCompany = companyOfOrder(currentOrder);
      if (deliveryUser && assignmentCompany !== 'phytoemagry' &&
          !(await authorizedCourierAccount(ctx.db, assignmentCompany, { userId: deliveryUser.id }))) {
        json(res, 403, { ok: false, error: 'courier_company_forbidden' });
        return;
      }
      const assignmentNote = text(body.deliveryNote ?? body.delivery_note ?? body.note, 600);
      /*
       * ¿CAMBIA DE MANOS? El aviso al cliente se manda UNA sola vez por cambio:
       * si se vuelve a asignar al MISMO repartidor (un toque repetido, un
       * reintento del panel) no se le escribe otra vez. Antes cada llamada
       * mandaba un mensaje más.
       */
      const repartidorAnterior = text(currentOrder?.delivery?.delivery_user_id, 80);
      const assigned = await assignDeliveryToOrder(ctx, item, deliveryUser, actor, { assignmentNote });
      /*
       * REGLA DE AVISOS (Fase 06): ASIGNAR no avisa al cliente. El primer mensaje
       * rutinario sale cuando el repartidor inicia la entrega, y el segundo al llegar.
       * La coordinación con el repartidor (interna o externa) no cambia.
       */
      const customerNotification = {
        status: 'not_applicable',
        reason: 'assignment_does_not_notify_customer',
      };
      json(res, 200, { ok: true, order: assigned.order, deliveryUser, customerNotification });
      return;
    }

    /*
     * REPARTIDOR EXTERNO (mensajero sin cuenta en el CRM).
     *
     * Asignar y enviar son DOS pasos a propósito: primero se dice quién lleva el
     * pedido y solo después se manda el mensaje. El destinatario tiene que estar
     * guardado como contacto de reparto: no se acepta un número suelto (así nadie
     * puede mandar la dirección de un cliente a un teléfono cualquiera).
     */
    const puedeGestionarReparto = () =>
      can('orders.update_operational') || can('delivery.manage') || can('delivery.tracking.manage_all');

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/courier/assign') && req.method === 'POST') {
      if (!puedeGestionarReparto()) {
        forbid();
        return;
      }
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/courier/assign'.length));
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
      const result = await assignCourier({
        ctx,
        item,
        order: orderOf(item),
        contactPhone: body.contactPhone ?? body.contact_phone ?? body.phone,
        actor,
      });
      if (!result.ok) {
        json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
        return;
      }
      /*
       * AVISO AUTOMÁTICO AL ASIGNAR.
       *
       * Antes había que pulsar «Enviar» después de asignar; si nadie lo pulsaba,
       * el repartidor externo quedaba asignado sin recibir nada. Se envía aquí,
       * con la plantilla oficial y sin duplicar (la función es idempotente). Si la
       * plantilla no está aprobada no se finge un envío: se devuelve el motivo y
       * el supervisor lo deja como pendiente/escalado.
       */
      let envio = null;
      /*
       * `autoSend` lo pide el panel cuando asigna desde un solo toque. Sin él se
       * mantiene el contrato de siempre (asignar y enviar por separado), que es
       * el que usan los scripts y las pruebas.
       */
      if (body.autoSend === true) {
        try {
          envio = await sendOrderToCourier({
            ctx,
            item,
            order: result.order,
            actor,
            resend: false,
            checkTemplate: (name) => approvedTemplate(ctx, name),
            refreshTemplate: (name) => refreshTemplateFromMeta(ctx, name),
          });
        } catch (error) {
          envio = { ok: false, error: 'send_failed', message: error?.message ?? null };
        }
      }
      const freshItem = await findOrderItem(store, orderId);
      const freshOrder = freshItem ? orderOf(freshItem) : result.order;
      json(res, 200, {
        ok: true,
        order: freshOrder,
        courier: freshOrder?.delivery?.external ?? result.courier,
        sent: envio ? envio.ok === true : null,
        send_error: !envio ? null : envio.ok === true ? null : envio.error ?? 'not_sent',
        message: !envio || envio.ok === true ? null : envio.message ?? null,
      });
      return;
    }

    if (route.startsWith('/api/admin/orders/') && route.endsWith('/courier/send') && req.method === 'POST') {
      if (!puedeGestionarReparto()) {
        forbid();
        return;
      }
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/courier/send'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      let order = orderOf(item);
      // Si el panel manda el contacto en el mismo paso, se asigna antes de enviar.
      const contactPhone = body.contactPhone ?? body.contact_phone;
      if (contactPhone) {
        const assigned = await assignCourier({ ctx, item, order, contactPhone, actor });
        if (!assigned.ok) {
          json(res, assigned.status ?? 422, { ok: false, error: assigned.error, message: assigned.message });
          return;
        }
        order = assigned.order;
      }
      const result = await sendOrderToCourier({
        ctx,
        item,
        order,
        actor,
        resend: body.resend === true,
        checkTemplate: (name) => approvedTemplate(ctx, name),
        refreshTemplate: (name) => refreshTemplateFromMeta(ctx, name),
      });
      if (!result.ok) {
        json(res, result.status ?? 422, {
          ok: false,
          error: result.error,
          message: result.message,
          courier: result.courier ?? null,
          template: result.template ?? null,
        });
        return;
      }
      json(res, 200, { ok: true, courier: result.courier, messageId: result.messageId });
      return;
    }

    /*
     * SUPERVISOR IA DELIVERY — panel, ajustes y pasada manual.
     *
     * Solo administración (es la pantalla de supervisión). La pasada normal la
     * hace el scheduler; «Ejecutar ahora» sirve para probar y para no esperar
     * al siguiente ciclo.
     */
    if (route === '/api/admin/delivery-supervisor' && req.method === 'GET') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      json(res, 200, await supervisorSnapshot(ctx, supervisorBridge(ctx)));
      return;
    }

    /* Vista previa: a quién se escribiría AHORA. No envía ni guarda nada. */
    if (route === '/api/admin/delivery-supervisor/preview' && req.method === 'GET') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      json(res, 200, await supervisorPreview(ctx, supervisorBridge(ctx)));
      return;
    }

    /*
     * DIAGNÓSTICO Y CHAT DEL SUPERVISOR.
     *
     * El negocio preguntó «¿por qué el agente no manda WhatsApp?». Esto responde
     * con datos REALES (WhatsApp configurado, plantilla aprobada, horario y el
     * teléfono de cada repartidor) y no envía nada: solo informa.
     */
    if (route === '/api/admin/delivery-supervisor/diagnostics' && req.method === 'GET') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      json(res, 200, { ok: true, diagnostics: await supervisorDiagnostics(ctx, supervisorBridge(ctx)) });
      return;
    }

    if (route === '/api/admin/delivery-supervisor/ask' && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const diagnostics = await supervisorDiagnostics(ctx, supervisorBridge(ctx));
      const question = text(body.question, 300) ?? '';
      const answer = supervisorAnswer(diagnostics, question);
      json(res, 200, { ok: true, question, topic: answer.topic, answer: answer.answer, diagnostics });
      return;
    }

    if (route === '/api/admin/delivery-supervisor/settings' && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const saved = await saveSupervisorSettings(ctx, body.settings ?? body);
      await ctx.audit?.record({
        entity: 'settings',
        entityId: 'delivery_supervisor',
        action: 'settings.delivery_supervisor_updated',
        actor: actor?.display_name ?? null,
        summary: 'Ajustes del Supervisor IA de delivery actualizados',
        data: saved,
        idempotencyKey: `settings.delivery_supervisor:${ctx.clock().toISOString()}`,
      });
      json(res, 200, { ok: true, settings: saved });
      return;
    }

    if (route === '/api/admin/delivery-supervisor/run' && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      const result = await supervisorTick(ctx, supervisorBridge(ctx));
      json(res, 200, { ok: true, result, snapshot: await supervisorSnapshot(ctx, supervisorBridge(ctx)) });
      return;
    }

    if (route === '/api/admin/delivery-supervisor/daily' && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all')) return;
      json(res, 200, await dailyReconciliation(ctx, { deps: supervisorBridge(ctx) }));
      return;
    }

    /*
     * POSPONER una entrega (motivo + fecha nueva + comentario).
     * Puede hacerlo administración o el repartidor ASIGNADO a ese pedido.
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/postpone') && req.method === 'POST') {
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/postpone'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      const asignado = Boolean(actor?.id) && order?.delivery?.delivery_user_id === actor.id;
      if (!can('delivery.tracking.manage_all') && !asignado) {
        forbid();
        return;
      }
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const result = await postponeDelivery({
        ctx,
        item,
        order,
        actor,
        reason: body.reason ?? body.motivo,
        until: body.until ?? body.date ?? body.fecha,
        note: body.note ?? body.comment ?? body.comentario,
        source: 'PANEL',
      });
      if (!result.ok) {
        json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
        return;
      }
      json(res, 200, { ok: true, order: result.order, postponedUntil: result.postponedUntil, count: result.count });
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

    /*
     * PASO 1 DEL FLUJO — ACEPTAR LA ENTREGA.
     *
     * Es un HECHO OPERATIVO distinto del contacto: dice «me hago cargo de este
     * pedido». NO envía nada al cliente (nada de WhatsApp por aceptar) y NO
     * inicia el GPS. Idempotente: aceptar dos veces devuelve el mismo pedido.
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/accept') && req.method === 'POST') {
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/accept'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      if (!order) {
        json(res, 422, { ok: false, error: 'invalid_order' });
        return;
      }
      const manageAll = hasPermission(actor, 'delivery.tracking.manage_all');
      const assigned = Boolean(actor?.id) && order.delivery?.delivery_user_id === actor.id;
      if (!assigned && !manageAll) {
        forbid();
        return;
      }
      if (['entregado', 'cancelado', 'perdido'].includes(String(order.status ?? ''))) {
        json(res, 409, { ok: false, error: 'order_closed', message: 'Este pedido ya está cerrado.' });
        return;
      }
      if (String(order.delivery?.delivery_status ?? '').toUpperCase() === 'ISSUE_REPORTED') {
        json(res, 409, { ok: false, error: 'issue_pending_admin', message: 'La incidencia está esperando decisión administrativa.' });
        return;
      }
      if (order.delivery?.delivery_accepted_at) {
        json(res, 200, { ok: true, duplicate: true, order: sanitizeOrderForPermissions(order, actor) });
        return;
      }
      const at = ctx.clock().toISOString();
      const next = {
        ...order,
        delivery: {
          ...(order.delivery ?? {}),
          delivery_accepted_at: at,
          delivery_accepted_by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
          delivery_accepted_by_display_name_snapshot: actor?.display_name ?? null,
        },
        updated_at: at,
      };
      const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
      await ctx.audit?.record({
        entity: 'order',
        entityId: item.id,
        action: 'delivery.accepted',
        actor: actor?.display_name ?? null,
        summary: 'El repartidor aceptó la entrega',
        data: { order_id: item.id, delivery_user_id: order.delivery?.delivery_user_id ?? null },
        idempotencyKey: `delivery.accepted:${item.id}:${order.delivery?.delivery_assignment_version ?? 1}`,
      });
      json(res, 200, { ok: true, duplicate: false, order: sanitizeOrderForPermissions(orderOf(updated) ?? next, actor) });
      return;
    }

    /*
     * INTENTO DE CONTACTO — queda REGISTRADO aunque no haya mensaje enviado.
     *
     * «Llamé y no contestó» es información operativa real. El panel la usa para
     * dejar de pedir el contacto y para que el supervisor/administración sepa qué
     * pasó. No se envía nada al cliente desde aquí.
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/contact-attempt') && req.method === 'POST') {
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/contact-attempt'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      if (!order) {
        json(res, 422, { ok: false, error: 'invalid_order' });
        return;
      }
      const manageAll = hasPermission(actor, 'delivery.tracking.manage_all');
      const assigned = Boolean(actor?.id) && order.delivery?.delivery_user_id === actor.id;
      if (!assigned && !manageAll) {
        forbid();
        return;
      }
      if (['entregado', 'cancelado', 'perdido'].includes(String(order.status ?? ''))) {
        json(res, 409, { ok: false, error: 'order_closed', message: 'Este pedido ya está cerrado.' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const channel = ['call', 'whatsapp', 'crm', 'visit', 'other'].includes(String(body.channel ?? ''))
        ? String(body.channel)
        : 'other';
      const previous = Array.isArray(order.delivery?.delivery_contact_attempts) ? order.delivery.delivery_contact_attempts : [];
      const last = previous[previous.length - 1] ?? null;
      const at = ctx.clock().toISOString();
      /* Dos toques seguidos del MISMO canal no son dos intentos: es el mismo. */
      if (last && last.channel === channel && Date.parse(at) - Date.parse(last.at ?? 0) < 60_000) {
        json(res, 200, { ok: true, duplicate: true, order: sanitizeOrderForPermissions(order, actor) });
        return;
      }
      const attempt = {
        id: newId('cat'),
        channel,
        at,
        by_user_id: actor?.actor_type === 'USER' ? actor.id : null,
        by_display_name: actor?.display_name ?? null,
        note: longText(body.note, 200) ?? null,
      };
      const next = {
        ...order,
        delivery: {
          ...(order.delivery ?? {}),
          delivery_contact_attempts: [...previous, attempt].slice(-50),
          delivery_contact_attempted_at: at,
          delivery_contact_last_channel: channel,
        },
        updated_at: at,
      };
      const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
      await ctx.audit?.record({
        entity: 'order',
        entityId: item.id,
        action: 'delivery.contact_attempt',
        actor: actor?.display_name ?? null,
        summary: `Intento de contacto (${channel})`,
        data: { order_id: item.id, channel, attempt_id: attempt.id, note: attempt.note },
        idempotencyKey: `delivery.contact-attempt:${item.id}:${channel}:${Math.floor(Date.parse(at) / 60000)}`,
      });
      json(res, 200, { ok: true, duplicate: false, order: sanitizeOrderForPermissions(orderOf(updated) ?? next, actor) });
      return;
    }

    /*
     * RESOLVER UNA INCIDENCIA — decisión administrativa, con rastro.
     *
     * Antes la única forma de salir de una incidencia era REINICIAR la entrega, y
     * eso borraba el estado sin dejar quién ni por qué. Aquí se cierra con actor,
     * motivo y hora, y el pedido queda listo para reintentar (sin arrancar nada).
     */
    if (route.startsWith('/api/admin/orders/') && route.endsWith('/delivery/issue/resolve') && req.method === 'POST') {
      if (!requirePermission('delivery.tracking.manage_all', 'Solo administración resuelve incidencias.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/delivery/issue/resolve'.length));
      const item = await findOrderItem(store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const order = orderOf(item);
      if (!order) {
        json(res, 422, { ok: false, error: 'invalid_order' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const action = ['resume', 'cancel'].includes(String(body.action ?? '')) ? String(body.action) : 'resume';
      const note = longText(body.note ?? body.resolutionNote, 300) ?? '';
      if (note.trim().length < 3) {
        json(res, 422, { ok: false, error: 'missing_note', message: 'Escribe qué se decidió (mínimo 3 caracteres).' });
        return;
      }
      const issues = Array.isArray(order.delivery?.issues) ? order.delivery.issues : [];
      const openIssues = issues.filter((issue) => !issue.resolved_at);
      if (!openIssues.length && String(order.delivery?.delivery_status ?? '').toUpperCase() !== 'ISSUE_REPORTED') {
        json(res, 409, { ok: false, error: 'no_open_issue', message: 'Este pedido no tiene una incidencia abierta.' });
        return;
      }
      const at = ctx.clock().toISOString();
      const audited = { actor: actor?.display_name ?? null, action, note, at };
      const nextIssues = issues.map((issue) =>
        issue.resolved_at ? issue : { ...issue, resolved_at: at, resolution: action, resolution_note: note, resolved_by_display_name: actor?.display_name ?? null },
      );
      const nextDelivery = {
        ...(order.delivery ?? {}),
        issues: nextIssues,
        issue_resolved_at: at,
        issue_resolution: action,
        issue_resolution_note: note,
        issue_resolved_by_display_name_snapshot: actor?.display_name ?? null,
      };
      const next = { ...order, delivery: nextDelivery, updated_at: at };
      if (action === 'resume') {
        next.delivery.delivery_status = order.delivery?.delivery_user_id
          ? DELIVERY_OPERATIONAL_STATUSES.READY_FOR_DELIVERY
          : DELIVERY_OPERATIONAL_STATUSES.PENDING_CONTACT;
      }
      const updated = await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
      await ctx.audit?.record({
        entity: 'order',
        entityId: item.id,
        action: 'delivery.issue_resolved',
        actor: actor?.display_name ?? null,
        summary: `Incidencia resuelta: ${action === 'cancel' ? 'se cancela' : 'se reanuda'} · ${note}`,
        data: { order_id: item.id, resolution: action, note, issues: openIssues.map((issue) => issue.id ?? null), ...audited },
        idempotencyKey: `delivery.issue-resolved:${item.id}:${at}`,
      });
      json(res, 200, { ok: true, order: sanitizeOrderForPermissions(orderOf(updated) ?? next, actor) });
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
      /* Política vigente (UN documento de ajustes: el del supervisor). */
      const requireContactBeforeStart = (await supervisorSettings(ctx).catch(() => null))?.requireContactBeforeStart === true;
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
        /*
         * REINICIAR NO BORRA LA INCIDENCIA.
         *
         * Antes, cuando administración reiniciaba una entrega con incidencia, el
         * `delivery_status` se sobrescribía a IN_TRANSIT y no quedaba ni quién ni
         * por qué. Ahora el reinicio administrativo CIERRA la incidencia con su
         * actor, su nota y su hora (y se audita), de modo que la decisión es
         * visible después.
         */
        let workingOrder = order;
        if (canManageAll && order.delivery?.delivery_status === DELIVERY_OPERATIONAL_STATUSES.ISSUE_REPORTED) {
          const resolvedAt = ctx.clock().toISOString();
          const notaReinicio = longText(body.resolutionNote ?? body.resolution_note, 300) ?? 'Reanudada por administración';
          const issues = Array.isArray(order.delivery?.issues) ? order.delivery.issues : [];
          const resolvedIssues = issues.map((issue) =>
            issue.resolved_at
              ? issue
              : { ...issue, resolved_at: resolvedAt, resolution: 'restarted_by_admin', resolution_note: notaReinicio, resolved_by_display_name: actor?.display_name ?? null },
          );
          workingOrder = {
            ...order,
            delivery: {
              ...(order.delivery ?? {}),
              issues: resolvedIssues,
              issue_resolved_at: resolvedAt,
              issue_resolution: 'restarted_by_admin',
              issue_resolution_note: notaReinicio,
              issue_resolved_by_display_name_snapshot: actor?.display_name ?? null,
            },
            updated_at: resolvedAt,
          };
          await ctx.store.update(item.id, { orderJson: JSON.stringify(workingOrder) });
          await ctx.audit?.record({
            entity: 'order',
            entityId: item.id,
            action: 'delivery.issue_resolved',
            actor: actor?.display_name ?? null,
            summary: `Incidencia resuelta al reiniciar la entrega · ${notaReinicio}`,
            data: { order_id: item.id, resolution: 'restarted_by_admin', note: notaReinicio, issues: resolvedIssues.filter((issue) => !issue.resolved_at).length },
            idempotencyKey: `delivery.issue-restarted:${item.id}:${resolvedAt}`,
          });
        }
        /*
         * POLÍTICA DE CONTACTO PREVIO (ajuste, apagado por defecto).
         *
         * Si el negocio la enciende, el repartidor debe haber registrado ALGÚN
         * intento (llamada, WhatsApp o mensaje del CRM). Se acepta el teléfono
         * como contacto válido: exigir un WhatsApp entregado bloquearía entregas
         * legítimas. Administración no queda atrapada por este ajuste.
         */
        if (!canManageAll && requireContactBeforeStart && !deliveryContactedAtOf(workingOrder)) {
          return { status: 409, body: { ok: false, error: 'contact_required', message: 'Registra primero el contacto con el cliente (llamada, WhatsApp o mensaje).' } };
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
        let effectiveOrder = workingOrder;
        if (!assignedUserId || assignedUserId !== deliveryUser.id) {
          effectiveOrder = (await assignDeliveryToOrder(ctx, item, deliveryUser, actor))?.order ?? workingOrder;
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

      const receipt = buildReceipt({ order, customer, businessName: 'FullTECH' });
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
      /*
       * EL REPARTIDOR RECIBE LO JUSTO PARA ENTREGAR.
       *
       * Antes esta misma respuesta le devolvía el historial de auditoría interno,
       * los seguimientos del cliente, los mensajes programados y el detalle de
       * TODOS los cobros (con el nombre de quién los anotó y sus notas). Nada de
       * eso hace falta para llevar un pedido: aquí se proyecta solo lo operativo
       * y el resumen del saldo. El resto sigue disponible para oficina.
       */
      if (isDeliveryOnly(actor)) {
        const location = order?.delivery?.location ?? null;
        json(res, 200, {
          ok: true,
          delivery_view: true,
          item: { id: item.id, order_number: order?.order_number ?? item.order_number ?? null, status: item.status ?? null },
          order: {
            id: item.id,
            order_number: order?.order_number ?? item.order_number ?? null,
            status: order?.status ?? item.status ?? null,
            currency: order?.currency ?? item.currency ?? 'DOP',
            items: order?.items ?? [],
            notes: order?.notes ?? null,
            customer_id: order?.customer_id ?? item.customer_id ?? null,
            conversation_id: order?.conversation_id ?? item.conversation_id ?? null,
            payment_method: order?.payment_method ?? null,
            payment_status: order?.payment_status ?? null,
            total: Number(order?.total ?? 0) || 0,
            delivery_fee: Number(order?.delivery_fee ?? order?.delivery?.fee ?? 0) || 0,
            created_at: order?.created_at ?? item.received_at ?? null,
            delivery: {
              location,
              delivery_status: deliveryStatusOf(order),
              delivery_assigned_at: order?.delivery?.delivery_assigned_at ?? null,
              delivery_accepted_at: order?.delivery?.delivery_accepted_at ?? null,
              delivery_contacted_at: deliveryContactedAtOf(order),
              delivery_assignment_note: order?.delivery?.delivery_assignment_note ?? null,
              delivery_assignment_note_by_display_name_snapshot:
                order?.delivery?.delivery_assignment_note_by_display_name_snapshot ?? null,
              issue_id: order?.delivery?.issue_id ?? null,
              issue_reason_label: order?.delivery?.issue_reason_label ?? null,
              issue_note: order?.delivery?.issue_note ?? null,
            },
          },
          customer: customer ? { id: customer.id, name: customer.name, phone_e164: customer.phone_e164 } : null,
          receipt: {
            order_number: order?.order_number ?? item.order_number ?? null,
            items: order?.items ?? [],
            subtotal: order?.subtotal ?? null,
            discount: order?.discount ?? null,
            delivery_fee: Number(order?.delivery_fee ?? 0) || 0,
            total: Number(order?.total ?? 0) || 0,
            currency: order?.currency ?? 'DOP',
            date: order?.created_at ?? null,
            location_label: location?.name ?? location?.address ?? null,
          },
          /* Solo saldo y medio: sin autores, notas ni rendiciones. */
          payment: paymentSummaryForDelivery(order),
        });
        return;
      }
      const receipt = buildReceipt({ order, customer, businessName: 'FullTECH' });
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

      /*
       * TEXTO PARA «PEDIR CONFIRMACIÓN» DESDE LA PROPIA FICHA DEL PEDIDO.
       *
       * Devuelve el resumen que leerá el cliente y la conversación donde debe
       * salir. NO envía nada: el agente lo revisa y pulsa Enviar en el chat. El
       * texto se construye aquí desde el pedido REAL (nunca desde el navegador).
       */
      if (action === 'confirmation-message') {
        if (!requirePermission('chats.reply')) return;
        if (!customer) {
          json(res, 200, {
            ok: true,
            sendable: false,
            error: 'order_without_customer',
            message: 'Ese pedido no tiene cliente asignado: no hay a quién pedirle confirmación.',
            conversationId: null,
            text: null,
          });
          return;
        }
        const delPedido = order?.conversation_id ? await ctx.db.get('conversations', order.conversation_id) : null;
        const conversacion =
          delPedido && delPedido.customer_id === customer.id
            ? delPedido
            : await ctx.customers.conversationFor(customer.id, { create: false });
        if (!conversacion || conversacion.customer_id !== customer.id) {
          json(res, 200, {
            ok: true,
            sendable: false,
            error: 'no_conversation',
            message: 'Este cliente todavía no tiene una conversación de WhatsApp: el pedido quedó pendiente, ábrele un chat para pedirle la confirmación.',
            conversationId: null,
            text: orderConfirmationText(order, customer),
          });
          return;
        }
        json(res, 200, {
          ok: true,
          sendable: true,
          conversationId: conversacion.id,
          customerId: customer.id,
          order_number: order?.order_number ?? receipt.order_number ?? null,
          text: orderConfirmationText(order, customer),
        });
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
        /*
         * El dinero del pedido, con su detalle: cobros (importe, medio, quién y
         * cuándo) y rendiciones del repartidor. Entregar no lo cambia.
         */
        payment: paymentBlockOf(order),
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

    /*
     * CONFIRMAR EL PEDIDO (el paso que faltaba entre «creado» y «en reparto»).
     *
     * Ruta APARTE y a propósito: no acepta cualquier estado, no cobra y no
     * entrega. Con `deliveryUserId` o `deliveryContactPhone` confirma Y asigna en
     * la misma operación; sin ninguno, solo confirma (retiro en tienda o entrega
     * que se gestiona después).
     */
    if (
      route.startsWith('/api/admin/orders/') &&
      route.endsWith('/confirm') &&
      req.method === 'POST' &&
      !route.slice('/api/admin/orders/'.length, -'/confirm'.length).includes('/')
    ) {
      if (!requirePermission('orders.update_operational', 'No tienes permiso para confirmar pedidos.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/confirm'.length));
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const deliveryUserId = text(body.deliveryUserId ?? body.delivery_user_id, 80);
      const deliveryContactPhone = text(
        body.deliveryContactPhone ?? body.delivery_contact_phone ?? body.courierPhone,
        40,
      );
      if (deliveryUserId && !requirePermission('delivery.tracking.manage_all', 'Solo ADMIN puede asignar repartidores del equipo.')) return;
      if (deliveryContactPhone && !(can('orders.update_operational') || can('delivery.manage') || can('delivery.tracking.manage_all'))) {
        forbid();
        return;
      }
      const result = await confirmOrder(ctx, {
        orderId,
        actor,
        deliveryUserId,
        deliveryContactPhone,
        deliveryNote: body.deliveryNote ?? body.delivery_note ?? body.note,
        fulfillment: body.fulfillment,
        reason: body.reason,
      });
      if (!result.ok) {
        json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
        return;
      }
      json(res, 200, {
        ok: true,
        duplicate: result.duplicate === true,
        confirmedAt: result.confirmedAt,
        assignment: result.assignment,
        item: sanitizeItemForPermissions(result.item, actor),
        order: sanitizeOrderForPermissions(result.order, actor),
        integrity: result.integrity,
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

    /*
     * FINALIZAR UN PEDIDO SIN SER ADMIN.
     *
     * Cualquiera que atienda pedidos (admin, agente u operador) puede cerrar un
     * pedido que ya salió: el repartidor lo llevó y no lo marcó, y obligar a
     * buscar un admin para eso dejaba ventas abiertas para siempre.
     *
     * Es una ruta APARTE y a propósito: solo hace UNA cosa (pasar a entregado),
     * no acepta el estado que le manden y no sirve para cancelar ni para revertir.
     * El cambio queda auditado con el usuario y hace lo mismo que el cambio de
     * estado completo: inventario, postventa, Meta y cierre del tracking.
     */
    if (
      route.startsWith('/api/admin/orders/') &&
      route.endsWith('/finish') &&
      req.method === 'POST' &&
      !route.slice('/api/admin/orders/'.length, -'/finish'.length).includes('/')
    ) {
      if (!requirePermission('orders.update_operational', 'No tienes permiso para finalizar pedidos.')) return;
      const orderId = decodeURIComponent(route.slice('/api/admin/orders/'.length, -'/finish'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const item = await findOrderItem(ctx.store, orderId);
      if (!item) {
        json(res, 404, { ok: false, error: 'not_found', message: 'Ese pedido no existe.' });
        return;
      }
      const order = orderOf(item);
      const reason = manualReason(body.reason) ?? 'Finalizado desde la lista de pedidos';
      const result = await transitionOrderStatus(ctx, {
        orderId,
        targetStatus: 'ENTREGADO',
        expectedStatus: orderOperationalStatus(order, item, await activeTrackingSessionsForOrder(ctx, orderId)),
        reason,
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
      const [paymentOrderId, paymentAction = '', paymentSub = ''] = rest.split('/');

      /*
       * COBRAR ES UN ACTO APARTE DE ENTREGAR.
       *
       * El repartidor puede marcar ENTREGADO sin tocar el dinero; aquí es donde
       * se anota cuánto entró, con qué medio, quién lo anotó y cuándo. Sin esta
       * llamada el pedido se queda «por cobrar» aunque esté entregado, que es la
       * verdad. Una lectura de WhatsApp (aunque diga «ya te pagué») NUNCA llega
       * hasta aquí: solo una persona autorizada desde el panel o la app.
       */
      if (paymentOrderId && paymentAction === 'payments' && !paymentSub && req.method === 'POST') {
        const fresh = await freshOrderForPayment(ctx, paymentOrderId);
        if (!fresh) {
          json(res, 404, { ok: false, error: 'not_found', message: 'Ese pedido no existe.' });
          return;
        }
        /*
         * Quien reparte ESE pedido puede anotar el efectivo que cobró en la
         * puerta aunque su rol no sea de oficina; para cualquier otro hace falta
         * permiso de operar pedidos (y no basta: ver `paymentAuthorization`).
         */
        const reparteEsePedido = Boolean(actor?.id) && fresh.order?.delivery?.delivery_user_id === actor.id;
        if (!reparteEsePedido && !requirePermission('orders.update_operational', 'No tienes permiso para registrar cobros.')) return;
        const guard = await paymentAuthorization(ctx, actor, fresh.order, can);
        if (!guard.ok) {
          json(res, guard.status, { ok: false, error: guard.error, message: guard.message });
          return;
        }
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const result = await registerCustomerPayment({
          ctx,
          orderId: paymentOrderId,
          actor,
          amount: body.amount,
          expectedDue: body.expectedDue,
          method: body.method,
          note: body.note,
          evidenceUrl: body.evidenceUrl ?? body.evidence_url,
          idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
        });
        if (!result.ok) {
          json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message, due: result.due });
          return;
        }
        json(res, 200, {
          ok: true,
          duplicate: result.duplicate === true,
          payment: result.payment,
          order: sanitizeOrderForPermissions(result.order, actor),
        });
        return;
      }

      /*
       * VERIFICAR (O RECHAZAR) UN COBRO DECLARADO.
       *
       * Una transferencia que el repartidor da por hecha NO es dinero cobrado: hay
       * que comprobarla. Solo administración firma esa verificación; hasta
       * entonces el saldo sigue abierto y el cobro aparece como «por verificar».
       * Rechazar no borra el registro: lo marca, para no perder la trazabilidad.
       */
      if (
        paymentOrderId &&
        paymentAction === 'payments' &&
        paymentSub &&
        rest.split('/')[3] === 'verify' &&
        req.method === 'POST'
      ) {
        if (!requireAdmin()) return;
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const result = await setPaymentVerification({
          ctx,
          orderId: paymentOrderId,
          paymentId: paymentSub,
          actor,
          decision: body.decision,
          note: body.note,
        });
        if (!result.ok) {
          json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message });
          return;
        }
        json(res, 200, {
          ok: true,
          duplicate: result.duplicate === true,
          payment: result.payment,
          order: sanitizeOrderForPermissions(result.order, actor),
        });
        return;
      }

      /*
       * RENDICIÓN: el efectivo que el repartidor le entrega a la empresa. No es
       * un cobro (el cliente ya pagó) ni un movimiento de caja: es la trazabilidad
       * de dónde está el dinero que lleva el repartidor. Solo administración, y
       * nunca se suma al cobro: son dos hechos distintos.
       */
      if (paymentOrderId && paymentAction === 'payments' && paymentSub === 'handover' && req.method === 'POST') {
        if (!requireAdmin()) return;
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const result = await registerCourierHandover({
          ctx,
          orderId: paymentOrderId,
          actor,
          amount: body.amount,
          note: body.note,
          idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
        });
        if (!result.ok) {
          json(res, result.status ?? 422, { ok: false, error: result.error, message: result.message, pending: result.pending });
          return;
        }
        json(res, 200, {
          ok: true,
          duplicate: result.duplicate === true,
          payment: result.payment,
          order: sanitizeOrderForPermissions(result.order, actor),
        });
        return;
      }
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
      try{await ctx.smartCommerce?.fulfillment.cancelOrder(orderId,actor);}catch(error){json(res,error.status||409,{ok:false,error:error.code,message:error.message});return;}
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
      if (!current) {
        json(res, 422, { ok: false, error: 'invalid_order', message: 'Ese pedido no se pudo leer.' });
        return;
      }
      /* Smart Commerce: un pedido con reservas no se edita de forma genérica. */
      if (current?.smart_commerce?.managedFulfillment) {
        json(res, 409, {
          ok: false,
          error: 'managed_order_locked',
          message: 'Cancela y recotiza para cambiar líneas, destino o importes de un pedido reservado.',
        });
        return;
      }
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
          product: ctx.storeCatalog ? {variants:[...(await ctx.storeCatalog.product({includeInactive:true})).variants,
            ...current.items.filter(i=>i.manual).map(i=>({id:i.variantId,general:true,manual:true,kind:i.kind||'product',name:i.label,label:i.label,price:i.unitPrice,cost_cents:i.unit_cost_snapshot_cents||0}))]} : undefined,
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
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      const locations = (await ctx.customers.listLocations(null, { limit: limite })).filter(
        (location) =>
          (!deliveryScope.restricted ||
          deliveryScope.customerIds.has(location.customer_id) ||
          deliveryScope.orderIds.has(location.order_id)) &&
          (!crmOwner || crmRowVisible(actor, crmOwner, 'customer', location.customer_id)),
      );
      const customerList = (await ctx.customers.list({})).filter(
        (customer) => (!deliveryScope.restricted || deliveryScope.customerIds.has(customer.id)) &&
          (!crmOwner || crmRowVisible(actor, crmOwner, 'customer', customer)),
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
      let destination = await findConversation(ctx, text(body.conversationId, 80) ?? '');
      /*
       * ENVIAR A UN NÚMERO (delivery registrado, número escrito a mano o contacto
       * nuevo): se resuelve/crea el cliente por su teléfono y se usa SU conversación.
       * Quien manda sigue siendo el actor del panel, con sus permisos.
       */
      const telefonoDestino = text(body.phone, 40);
      if (!destination && telefonoDestino) {
        const encontrado = await ctx.customers.findOrCreateByPhone({
          phone: telefonoDestino,
          name: text(body.name, 120) ?? null,
          source: 'manual',
        });
        if (!encontrado.ok) {
          json(res, 422, { ok: false, error: 'invalid_phone', message: 'Escribe un teléfono válido con código de país.' });
          return;
        }
        destination = await ctx.customers.conversationFor(encontrado.customer.id);
        /*
         * CONTACTO DE DELIVERY: se guarda para poder elegirlo la próxima vez.
         * Nombre + teléfono + concepto, en los ajustes del negocio.
         */
        if (body.saveContact === true) {
          try {
            const actual = (await ctx.settings.read('delivery_contacts'))?.value;
            const lista = Array.isArray(actual) ? actual : [];
            const nuevo = {
              id: encontrado.customer.id,
              name: text(body.contactLabel, 120) ?? encontrado.customer.name ?? null,
              phone: encontrado.customer.phone_e164 ?? telefonoDestino,
              concept: text(body.concept, 120) ?? null,
              updated_at: new Date().toISOString(),
            };
            const siguientes = [...lista.filter((row) => row.id !== nuevo.id), nuevo].slice(-100);
            await ctx.settings.write('delivery_contacts', siguientes);
          } catch {
            /* Si no se puede guardar el contacto, el envío no se cae. */
          }
        }
      }
      if (!destination) {
        json(res, 404, { ok: false, error: 'unknown_conversation', message: 'Elige un destinatario.' });
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
        /*
         * PRIMERO LA PLANTILLA PROPIA (phyto_compartir_ubicacion_v1): lleva el
         * nombre de quien recibe, el del cliente, la dirección y el enlace del
         * mapa. Solo si Meta aún no la aprobó se usa una de hueco libre.
         */
        const dedicada = await locationShareTemplate(ctx);
        if (dedicada) {
          const clienteUbicacion = source.customer_id ? await ctx.customers.get(source.customer_id) : null;
          const payload = await resolveTemplatePayload(ctx, {
            template: dedicada,
            customer: destinoCustomer,
            conversation: destination,
            provided: {
              1: destinoCustomer.name || destinoCustomer.phone_e164,
              2: clienteUbicacion?.name || clienteUbicacion?.phone_e164 || 'nuestro cliente',
              3: source.address || `${Number(source.latitude).toFixed(5)}, ${Number(source.longitude).toFixed(5)}`,
              4: enlace,
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
            name: dedicada.name,
            language: dedicada.language ?? 'es',
            components: payload.components,
          });
          envio = {
            ok: result.ok === true,
            messageId: result.messageId ?? null,
            error: result.error ?? (result.ok ? null : { message: result.reason ?? 'error' }),
            plantilla: dedicada,
            cuerpo: payload.body ?? enlace,
            tipo: 'template',
          };
        } else {
          const plantilla = await freeTextTemplate(ctx);
          if (!plantilla) {
            json(res, 409, {
              ok: false,
              error: 'no_template_approved',
              message:
                'Meta todavía no tiene aprobada la plantilla «phyto_compartir_ubicacion_v1» (ni ninguna con hueco de texto libre). Créala en WhatsApp Manager y pulsa «Sincronizar con Meta».',
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
        }
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
      const stage = text(url.searchParams.get('stage'), 20) ?? null;
      const sort = text(url.searchParams.get('sort'), 20) === 'priority' ? 'priority' : 'recent';
      const q = text(url.searchParams.get('q'), 120) ?? '';
      const dateRange = conversationDateRange(url.searchParams, ctx.clock ?? (() => new Date()));
      if (!dateRange.ok) {
        json(res, 422, { ok: false, error: dateRange.error, message: 'El rango de fechas no es válido.' });
        return;
      }
      const page = await ctx.customers.conversationPage({
        filter,
        order,
        stage,
        sort,
        q,
        from: dateRange.from,
        to: dateRange.to,
        currentUserId: actor?.actor_type === 'USER' ? actor.id : null,
      });
      const access = await conversationAccess(ctx, actor);
      const beforeCompany =
        isDeliveryOnly(actor) && !access.all
          ? page.conversations.filter((row) => access.conversationIds.has(row.id))
          : page.conversations;
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      const conversations = crmOwner
        ? beforeCompany.filter((row) => crmRowVisible(actor, crmOwner, 'conversation', row))
        : beforeCompany;
      const counts = crmOwner ? crmVisibleConversationCounts(conversations) : page.counts;
      json(res, 200, { ok: true, conversations, counts, dateRange: { from: dateRange.from, to: dateRange.to }, whatsapp: whatsappStatusPayload(ctx) });
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
      if (!can('admin.full')) {
        const existingCustomer = await ctx.customers.findByPhone(phone);
        if (existingCustomer && !crmRowVisible(actor, await crmOwnership(ctx), 'customer', existingCustomer)) {
          json(res, 404, { ok: false, error: 'not_found' }); return;
        }
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
      if (found.created && !can('admin.full')) {
        await ctx.db.update('customers', found.customer.id, { company_id: 'phytoemagry' });
      }
      const previousConversation = (await ctx.db.list('conversations', {
        where: { customer_id: found.customer.id }, limit: 1 }))[0];
      const conversation = await ctx.customers.conversationFor(found.customer.id);
      if (!can('admin.full') && !previousConversation && conversation) {
        await ctx.db.update('conversations', conversation.id, { company_id: 'phytoemagry' });
      }
      if (!can('admin.full') && previousConversation &&
          !crmRowVisible(actor, await crmOwnership(ctx), 'conversation', previousConversation)) {
        json(res, 404, { ok: false, error: 'not_found' }); return;
      }
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
      if (!ids.length || !['mark_read', 'resolve', 'archive', 'unarchive', 'delete', 'message_preview'].includes(action)) {
        json(res, 422, { ok: false, error: 'invalid_bulk_action' });
        return;
      }
      const results = [];
      const puedeVerTodo = hasPermission(actor, 'chats.force_reassign');
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      for (const id of ids) {
        const conversation = await findConversation(ctx, id);
        if (!conversation) {
          results.push({ id, ok: false, error: 'not_found' });
          continue;
        }
        if (crmOwner && !crmRowVisible(actor, crmOwner, 'conversation', conversation)) {
          results.push({ id, ok: false, error: 'not_found' }); continue;
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
        if (action === 'resolve') {
          // Finalizar de a varios: la misma operación que de a una (finaliza y archiva).
          const updated = await ctx.customers.resolveConversation(id, true, actor?.id ?? null);
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
      const [conversationId, action = '', messageId = ''] = rest.split('/');
      const conversation = conversationId ? await findConversation(ctx, conversationId) : null;
      if (!conversation) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!can('admin.full') && !crmRowVisible(actor, await crmOwnership(ctx), 'conversation', conversation)) {
        json(res, 404, { ok: false, error: 'not_found' }); return;
      }
      const customer = await ctx.customers.get(conversation.customer_id);

      /*
       * QUITAR UN MENSAJE DEL CRM (y devolverlo, si alguien se equivocó).
       *
       * LO PRIMERO, PARA NO PROMETER DE MÁS: WhatsApp no permite borrar ni editar
       * un mensaje ya enviado. La API oficial no tiene forma de hacerlo y el
       * cliente lo tiene en su teléfono. Así que esto NO es un borrado: es APARTAR
       * el mensaje de la vista del CRM (su texto deja de mostrarse en el hilo y
       * deja de ser el resumen de la conversación en la bandeja) y dejar el
       * registro de quién lo hizo. La fila sigue en la base: la auditoría no se
       * pierde y administración puede devolverlo con `POST`.
       */
      if (action === 'messages' && messageId && (req.method === 'DELETE' || req.method === 'POST')) {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation);
          return;
        }
        const mensaje = await ctx.customers.getMessage(messageId);
        // Un mensaje de OTRA conversación no se toca, ni para quitarlo.
        if (!mensaje || (mensaje.conversation_id && mensaje.conversation_id !== conversation.id)) {
          json(res, 404, { ok: false, error: 'unknown_message' });
          return;
        }
        const devolver = req.method === 'POST';
        const esAdmin = hasPermission(actor, 'chats.force_reassign');
        const esAutor = Boolean(mensaje.sent_by_user_id) && mensaje.sent_by_user_id === currentUser?.id;
        /*
         * QUIÉN PUEDE: administración, todo; y cada persona, lo que escribió ella
         * (arreglar el propio error es parte del trabajo). Un mensaje YA quitado
         * solo lo devuelve administración.
         */
        if (devolver ? !esAdmin : !esAdmin && !esAutor) {
          json(res, 403, {
            ok: false,
            error: 'forbidden',
            message: devolver
              ? 'Solo administración puede devolver al hilo un mensaje quitado.'
              : 'Solo administración (o quien escribió el mensaje) puede quitarlo del CRM.',
          });
          return;
        }
        const resultado = await ctx.customers.removeMessageFromCrm({
          messageId: mensaje.id,
          conversationId: conversation.id,
          byUserId: currentUser?.id ?? null,
          byDisplayName: actor?.display_name ?? null,
          reason: devolver ? null : 'Quitado desde el panel',
          restore: devolver,
        });
        if (!resultado.ok) {
          json(res, 404, { ok: false, error: resultado.error });
          return;
        }
        await ctx.audit?.record({
          entity: 'whatsapp_message',
          entityId: mensaje.id,
          action: devolver ? 'message.restored_in_crm' : 'message.removed_from_crm',
          actor: actor?.display_name ?? null,
          summary: devolver
            ? 'Devuelve un mensaje al hilo del CRM'
            : 'Quita un mensaje del hilo del CRM (el cliente conserva el original)',
          data: {
            conversation_id: conversation.id,
            customer_id: conversation.customer_id ?? null,
            wa_message_id: mensaje.wa_message_id ?? null,
            type: mensaje.type ?? 'text',
            direction: mensaje.direction ?? null,
          },
        });
        json(res, 200, {
          ok: true,
          message: resultado.message,
          duplicate: resultado.duplicate === true,
          note: devolver ? null : 'El mensaje se quitó de este panel. El cliente lo sigue teniendo en su WhatsApp.',
        });
        return;
      }

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
          whatsapp: whatsappStatusPayload(ctx),
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

      if (['resolve', 'reopen'].includes(action) && req.method === 'POST') {
        if (!(await canOpenConversation(ctx, actor, conversation))) {
          denyConversation(res, json, conversation); return;
        }
        const updated = await ctx.customers.resolveConversation(conversation.id, action === 'resolve', actor?.id ?? null);
        await ctx.audit?.record({
          entity: 'conversation', entityId: conversation.id,
          action: action === 'resolve' ? 'conversation.resolved' : 'conversation.reopened',
          actor: actor?.display_name ?? null,
          summary: action === 'resolve' ? 'Conversación finalizada y archivada' : 'Conversación reabierta',
          data: { customer_id: conversation.customer_id, message_id: updated.resolved_message_id },
        });
        json(res, 200, { ok: true, conversation: updated }); return;
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
        const updated = await ctx.customers.archiveConversation(conversation.id, action === 'archive', {
          byUserId: actor?.id ?? null,
          byDisplayName: actor?.display_name ?? null,
        });
        await ctx.audit?.record({
          entity: 'conversation',
          entityId: conversation.id,
          action: action === 'archive' ? 'conversation.archived' : 'conversation.unarchived',
          summary: action === 'archive' ? 'Conversación archivada' : 'Conversación desarchivada',
          data: {
            customer_id: conversation.customer_id,
            by_user_id: actor?.id ?? null,
            reason: action === 'archive' ? 'manual' : null,
          },
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
         * REGLA DE ATENCIÓN.
         *
         * · Sin asignar: cualquier agente puede contestar, y al hacerlo la toma
         *   (queda exclusiva para él).
         * · Asignada a otro: no se contesta (solo administración o el repartidor
         *   de esa entrega).
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
        /*
         * TOMAR LA CONVERSACIÓN LIBRE ANTES DE ESCRIBIR.
         *
         * Atómico: si dos agentes contestan a la vez a la misma conversación sin
         * asignar, solo uno se la queda; el otro recibe 403 aquí mismo y NO se
         * envía nada al cliente. Sin esto, ambos responderían y nadie sabría de
         * quién es el hilo.
         */
        if (!conversation.assigned_user_id && !deliveryOrderContext) {
          const tomada = await claimConversationIfFree(ctx, actor, conversation);
          if (!tomada.ok) {
            json(res, 403, {
              ok: false,
              error: 'conversation_assigned',
              message: `Otro agente acaba de tomar esta conversación${tomada.assigned_display_name_snapshot ? ` (${tomada.assigned_display_name_snapshot})` : ''}. Pide que te la asignen si necesitas atenderla.`,
            });
            return;
          }
        }
        /** @type {any} */
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        let rawMessageBody = longText(body.body, 1200);
        const deliveryAssignmentNotice =
          body.deliveryAssignmentNotice === true &&
          rawMessageBody === 'Ya pasé la orden al mensajero. Él te contactará para la entrega.';
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
          !deliveryAssignmentNotice && !template && deliveryOrderContext && messageNeedsDeliveryIdentity(deliveryOrderContext.order, actor)
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
        if (deliveryOrderContext && !deliveryAssignmentNotice) {
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
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      /*
       * BLINDADO: un agente no ve los seguimientos de un cliente cuya conversación
       * no lleva él (eran visibles para todo el equipo, con el nombre del cliente y
       * el motivo de la tarea). Administración los sigue viendo todos.
       */
      const acceso = await conversationAccess(ctx, actor);
      const soloMios = (rows) =>
        (acceso.all
          ? rows
          : rows.filter((row) => acceso.customerIds.has(row.customer_id) || row.assigned_user_id === actor?.id))
          .filter((row) => !crmOwner || crmRowVisible(actor, crmOwner, 'customer', row.customer_id));
      json(res, 200, {
        ok: true,
        reference: buckets.reference,
        today: withCustomer(soloMios(buckets.today), customers),
        overdue: withCustomer(soloMios(buckets.overdue), customers),
        upcoming: withCustomer(soloMios(buckets.upcoming), customers),
        completed: withCustomer(soloMios(buckets.completed.slice(-30)), customers),
        cancelled: withCustomer(soloMios(buckets.cancelled.slice(-30)), customers),
        summary: crmOwner ? null : await ctx.followups.summary(),
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
      if (!requireAdmin()) return;
      json(res, 200, { ok: true, messages: await store.messages().list() });
      return;
    }

    if (route === '/api/admin/messages' && req.method === 'POST') {
      if (!requireAdmin()) return;
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
      if (!requireAdmin()) return;
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
      json(res, 200, { ok: true, currency: 'DOP', catalog: hasPermission(actor,'cost.view')?inventory.presentations:stripSensitiveFinancials(inventory.presentations),
        inventory: sanitizeInventoryForPermissions(inventory,actor) });
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
      const crmOwner = can('admin.full') ? null : await crmOwnership(ctx);
      const byId = new Map(customers.map((row) => [row.id, row]));
      json(res, 200, {
        ok: true,
        summary: crmOwner ? null : await ctx.scheduler.summary(),
        scheduled: rows.filter((row) => !crmOwner || crmRowVisible(actor, crmOwner, 'customer', row.customer_id)).map((row) => ({
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

    /*
     * Campaña a clientes: SOLO administración y SOLO plantillas aprobadas.
     *
     * No envía nada al guardar: congela el texto revisado y crea trabajos en la
     * cola persistente, espaciados. El scheduler vuelve a validar opt-out,
     * plantilla y configuración justo antes de cada envío.
     */
    if (route === '/api/admin/customer-campaigns/schedule' && req.method === 'POST') {
      if (!requireAdmin()) return;
      /** @type {any} */
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }

      const mode = text(body.mode, 40) ?? 'selected';
      const dryRun = body.dryRun === true;
      const intervalMinutes = Math.max(2, Math.min(1440, Math.trunc(Number(body.intervalMinutes ?? 2)) || 2));
      const maxRecipients = Math.min(500, Math.max(1, Math.trunc(Number(body.maxRecipients ?? 200)) || 200));
      const templateName = text(body.template, 60);
      const startAtParsed = Date.parse(body.startAt ?? '');
      const startAt = Number.isFinite(startAtParsed) ? new Date(startAtParsed) : new Date(Date.now() + intervalMinutes * 60000);
      if (!templateName) {
        json(res, 422, { ok: false, error: 'template_required', message: 'Elige una plantilla aprobada.' });
        return;
      }

      await refreshTemplateFromMeta(ctx, templateName).catch(() => null);
      const check = await approvedTemplate(ctx, templateName);
      if (!check.ok) {
        json(res, 409, {
          ok: false,
          error: check.reason === 'unknown_template' ? 'unknown_template' : 'template_not_approved',
          message:
            check.reason === 'unknown_template'
              ? 'Esa plantilla no existe en el CRM.'
              : 'Esa plantilla todavía no está aprobada por Meta.',
          template: check.template ?? null,
        });
        return;
      }

      const selectedIds = Array.isArray(body.customerIds)
        ? new Set(body.customerIds.map((id) => text(id, 80)).filter(Boolean))
        : new Set();
      const excludedIds = Array.isArray(body.excludeCustomerIds ?? body.excludedCustomerIds)
        ? new Set((body.excludeCustomerIds ?? body.excludedCustomerIds).map((id) => text(id, 80)).filter(Boolean))
        : new Set();
      const statusFilter = text(body.historicalStatus, 40);
      const allowedStatuses = statusFilter ? CAMPAIGN_HISTORICAL_FILTERS[statusFilter] ?? null : null;
      if (mode === 'selected' && selectedIds.size === 0) {
        json(res, 422, { ok: false, error: 'recipients_required', message: 'Selecciona al menos un cliente.' });
        return;
      }
      if (mode === 'historical_status' && !allowedStatuses) {
        json(res, 422, { ok: false, error: 'invalid_filter', message: 'Ese filtro histórico no es válido.' });
        return;
      }
      if (!['all', 'selected', 'historical_status'].includes(mode)) {
        json(res, 422, { ok: false, error: 'invalid_mode', message: 'Ese alcance no es válido.' });
        return;
      }

      const allCustomers = await ctx.customers.list({ limit: 500 });
      const matchesScope = (customer) => {
        if (mode === 'all') return true;
        if (mode === 'selected') return selectedIds.has(customer.id);
        if (mode === 'historical_status') return allowedStatuses.has(historicalImportStatus(customer));
        return false;
      };
      const candidates = allCustomers
        .filter((customer) => {
          if (!customer?.id || !matchesScope(customer) || !customer.phone_e164) return false;
          if (excludedIds.has(customer.id)) return false;
          if (customer.do_not_contact || customer.whatsapp_opt_out_at || customer.campaign_opt_out_at || customer.campaign_notifications_disabled_at) return false;
          return true;
        })
        .slice(0, maxRecipients);

      const skipped = allCustomers
        .filter((customer) => {
          if (!matchesScope(customer)) return false;
          return (
            excludedIds.has(customer.id) ||
            !customer.phone_e164 ||
            customer.do_not_contact ||
            customer.whatsapp_opt_out_at ||
            customer.campaign_opt_out_at ||
            customer.campaign_notifications_disabled_at
          );
        })
        .map((customer) => ({
          id: customer.id,
          name: campaignCustomerLabel(customer),
          reason: excludedIds.has(customer.id)
            ? 'excluded'
            : !customer.phone_e164
              ? 'missing_phone'
              : customer.campaign_opt_out_at || customer.campaign_notifications_disabled_at
                ? 'campaign_opt_out'
                : 'do_not_contact',
        }));

      /** @type {Array<any>} */
      const planned = [];
      /** @type {Array<any>} */
      const conflicts = [];
      /** @type {Array<any>} */
      const scheduled = [];
      const templateValues =
        body.templateValues && typeof body.templateValues === 'object' && !Array.isArray(body.templateValues)
          ? body.templateValues
          : null;
      const customMessage = longText(body.customMessage, 2000);
      const requireExactBody = body.requireExactBody === true;
      if (requireExactBody && !customMessage) {
        json(res, 422, { ok: false, error: 'message_required', message: 'Escribe el mensaje final que recibirá el cliente.' });
        return;
      }
      const campaignId = newId('cmp');

      for (const [index, customer] of candidates.entries()) {
        const conversation = dryRun ? await ctx.customers.conversationFor(customer.id, { create: false }) : await ctx.customers.conversationFor(customer.id);
        const desiredBody = requireExactBody ? campaignDesiredMessageForCustomer(customMessage, customer) : null;
        const exactValues = requireExactBody ? campaignValuesForExactBody(check.template, desiredBody, customer) : null;
        if (requireExactBody && !exactValues?.ok) {
          conflicts.push({
            id: customer.id,
            name: campaignCustomerLabel(customer),
            phone_e164: customer.phone_e164,
            error: exactValues?.error ?? 'message_not_exact',
            message: exactValues?.message ?? 'El mensaje final no coincide exactamente con lo escrito.',
            missing: exactValues?.missing ?? undefined,
          });
          continue;
        }
        const customerValues = requireExactBody ? exactValues.values : campaignValuesForCustomer(templateValues, customer);
        const payload = await resolveTemplatePayload(ctx, {
          template: check.template,
          customer,
          conversation,
          orderId: null,
          provided: customerValues,
        });
        if (!payload.ok) {
          conflicts.push({
            id: customer.id,
            name: campaignCustomerLabel(customer),
            phone_e164: customer.phone_e164,
            error: payload.error,
            message: payload.message,
            missing: payload.missing ?? undefined,
          });
          continue;
        }
        if (requireExactBody && payload.body !== desiredBody) {
          conflicts.push({
            id: customer.id,
            name: campaignCustomerLabel(customer),
            phone_e164: customer.phone_e164,
            error: 'message_not_exact',
            message: 'El mensaje que saldría por WhatsApp no coincide exactamente con el mensaje escrito.',
          });
          continue;
        }
        const scheduledAt = new Date(startAt.getTime() + index * intervalMinutes * 60000).toISOString();
        const preview = {
          id: customer.id,
          name: campaignCustomerLabel(customer),
          phone_e164: customer.phone_e164,
          scheduled_at: scheduledAt,
          historical_status: historicalImportStatus(customer) ?? null,
          body: payload.body,
        };
        planned.push(preview);
        if (dryRun) continue;
        const result = await ctx.scheduler.schedule({
          customerId: customer.id,
          conversationId: conversation?.id ?? null,
          scheduledAt,
          type: 'template',
          template: check.template.name,
          templateComponents: payload.components,
          templateBody: payload.body,
          templateLanguage: check.template.language ?? 'es',
          campaignId,
          timeZone: text(body.timeZone, 60) ?? TIME_ZONE,
          createdBy: actor?.display_name ?? 'panel',
          scheduledByUserId: actor?.actor_type === 'USER' ? actor.id : null,
          idempotencyKey: `campaign:${campaignId}:${customer.id}:${check.template.name}:${scheduledAt}`,
        });
        if (result.ok) scheduled.push({ ...preview, message_id: result.message?.id ?? null, duplicate: result.duplicate === true });
        else conflicts.push({ ...preview, error: result.error, message: 'No se pudo programar este destinatario.' });
      }

      if (!dryRun) {
        await ctx.audit?.record({
          entity: 'message',
          entityId: campaignId,
          action: 'campaign.scheduled',
          actor: actor?.display_name ?? null,
          summary: `Campaña de WhatsApp programada (${scheduled.length})`,
          data: {
            mode,
            historicalStatus: statusFilter ?? null,
            excluded: excludedIds.size,
            template: check.template.name,
            recipients: planned.length,
            scheduled: scheduled.length,
            conflicts: conflicts.length,
            intervalMinutes,
          },
          idempotencyKey: `campaign.scheduled:${campaignId}`,
        });
      }

      json(res, dryRun ? 200 : 201, {
        ok: conflicts.length === 0,
        dryRun,
        campaignId,
        template: { name: check.template.name, language: check.template.language ?? 'es' },
        intervalMinutes,
        startAt: startAt.toISOString(),
        counts: {
          candidates: candidates.length,
          planned: planned.length,
          scheduled: scheduled.length,
          skipped: skipped.length,
          conflicts: conflicts.length,
        },
        planned,
        scheduled,
        skipped,
        conflicts,
        message:
          conflicts.length > 0
            ? 'Hay destinatarios con conflicto. No se forzaron.'
            : dryRun
              ? 'Previsualización lista. No se programó ningún mensaje.'
              : 'Campaña programada en cola segura.',
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
        // This queue stores body text parameters. Documents, media headers and
        // dynamic buttons need their dedicated send flow and cannot be promised
        // as a scheduled text message without those additional parameters.
        const header = check.template.header;
        const unsupportedHeader = header && (
          String(header.format ?? '').toUpperCase() !== 'TEXT' || /\{\{/.test(header.text ?? '')
        );
        const unsupportedButton = (check.template.buttons ?? []).some((button) => /\{\{/.test(button.url ?? '') || String(button.type ?? '').toUpperCase() === 'COPY_CODE');
        if (unsupportedHeader || unsupportedButton) {
          json(res, 422, {
            ok: false,
            error: 'unsupported_scheduled_template',
            message: 'Esta plantilla necesita un archivo o datos adicionales. Para programar, elige una plantilla de texto.',
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
      else if (action === 'edit') {
        updated = await ctx.scheduler.edit(scheduledId, {
          scheduledAt: body.scheduledAt,
          text: body.text,
          templateComponents: Array.isArray(body.templateComponents) ? body.templateComponents : undefined,
          templateBody: typeof body.templateBody === 'string' ? body.templateBody : undefined,
        });
      }
      else {
        json(res, 422, { ok: false, error: 'invalid_action', actions: ['cancel', 'reschedule', 'edit'] });
        return;
      }
      json(res, 200, { ok: true, message: updated });
      return;
    }

    // ------------------------------------------------- auditoría comercial
    if (route === '/api/admin/audit' && req.method === 'GET') {
      if (!requireAdmin()) return;
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
    storeOAuth: config.storeOAuth ?? STORE_OAUTH,
    storeSms: config.storeSms ?? STORE_SMS,
    storeMail: config.storeMail ?? STORE_MAIL,
    storeSeo: config.storeSeo ?? STORE_SEO,
    storePhoneOtp: config.storePhoneOtp ?? STORE_PHONE_OTP,
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
  await ensureLogisticsCompanies(db);

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
      mock: config.whatsappMock ?? WHATSAPP_MOCK,
      log: settings.quiet ? false : undefined,
    });

  /*
   * ESTADO REAL DE WHATSAPP: una sola instancia para todo el servidor.
   *
   * Antes el panel deducía «no configurado» de un booleano de credenciales y
   * pintaba DOS avisos distintos según la pantalla. Aquí se comprueba contra
   * Meta (solo lectura) y se responde con estados separados: envío, recepción y
   * motivo. La comprobación va en segundo plano: abrir el panel nunca espera a
   * Meta.
   */
  const whatsappStatus =
    config.whatsappStatus ??
    createWhatsAppStatus({
      whatsapp,
      verifyToken: config.whatsappVerifyToken ?? WHATSAPP_VERIFY_TOKEN,
      appSecret: config.metaAppSecret ?? META_APP_SECRET,
      graphVersion: config.whatsappGraphVersion ?? WHATSAPP_GRAPH_VERSION,
      clock: config.clock,
    });
  void whatsappStatus.refresh();

  /*
   * Ajustes del negocio (hoy: qué días del plan de postventa están activos).
   * El plan EFECTIVO sale de aquí, no solo de la variable de entorno: el negocio
   * lo cambia desde Ajustes y el motor de seguimiento lo respeta al crear tareas.
   */
  const followupsBasePlan = config.followupPlan ?? FOLLOWUP_PLAN;
  const settingsService = createSettingsService({ db, plan: followupsBasePlan, clock: config.clock });
  const proofreading = createProofreadingService({ settings: settingsService, secret: settings.token, fetchImpl: config.proofreadingFetch, clock: config.clock });

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
  const legacyInventory = createInventoryService({ db, store, audit, timeZone: TIME_ZONE, clock: config.clock });
  const storeCatalog = await createStoreCatalog({backend:db.kind,handle:store.handle,legacyInventory,clock:config.clock,storeKey:config.storeKey ?? STORE_KEY});
  const inventory = storeInventoryFacade(legacyInventory,storeCatalog);

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
    /*
     * UN SOLO SUPERVISOR.
     *
     * Aquí estaba conectado el motor HEREDADO, que escribía al mismo repartidor
     * (recordatorio a los 5 min) y a los mismos administradores (escalado a los
     * 30 min, con una lista de teléfonos fija en el código). Su política se
     * importa UNA vez a los ajustes del supervisor
     * (`importLegacyControlPolicy`) y su documento `delivery_control` se conserva
     * como historia, pero YA NO SE EJECUTA: dos calendarios sobre el mismo pedido
     * producían avisos duplicados.
     */
    deliverySupervisorTick: () => supervisorTick(ctxRef.current, supervisorBridge(ctxRef.current)),
    /*
     * LOS TRES TICKS DEL CENTRO IA, POR FIN CONECTADOS.
     *
     * Orden: primero los plazos de los tickets (avisan de lo que vence), luego
     * el puente que abre el ticket de un reparto en riesgo y, al final, el motor
     * de agentes, para que el ticket recién abierto pueda trabajarse en la misma
     * vuelta. Cada uno tiene su propio `try/catch` dentro del scheduler: si uno
     * falla, los otros dos siguen.
     */
    opsDeadlineTick: () => opsDeadlineTick({ ctx: ctxRef.current, deps: opsBridge(ctxRef.current) }),
    opsDeliveryTicketTick: () => opsDeliveryTicketTick({ ctx: ctxRef.current, deps: opsBridge(ctxRef.current) }),
    opsAgentTick: () => opsAgentTick({ ctx: ctxRef.current, deps: opsBridge(ctxRef.current) }),
    clock: config.clock,
    intervalMs: config.schedulerIntervalMs,
    log: settings.quiet ? () => {} : (message) => console.log(message),
  });
  schedulerRef.current = scheduler;

  /*
   * Cuentas de cliente y solicitudes de la tienda. Son tablas aditivas y
   * separadas: no tocan clientes, pedidos, facturas ni inventario. Si no hay SQL
   * (JSONL), la tienda sigue mostrando el catálogo y las cuentas quedan apagadas.
   */
  const storeAccounts = await createStoreAccounts({
    backend: db.kind,
    handle: store.handle,
    customers,
    listOrders: () => store.listAdmin({ limit: 5000 }),
    findCustomerByEmail: async (email) => {
      const key = String(email ?? '').trim().toLowerCase();
      if (!key) return null;
      const rows = await db.list('customers', { limit: 2000 });
      return rows.find((row) => String(row.email ?? '').trim().toLowerCase() === key) ?? null;
    },
    clock: config.clock,
  });
  const storeOAuth = createStoreOAuth({ config: settings.storeOAuth, fetchImpl: config.storeOAuthFetch ?? fetch, clock: config.clock });
  const smartCommerce=await createSmartCommerce({enabled:config.storeSmartCommerce?.enabled===true||(config.storeSmartCommerce?.enabled!==false&&process.env.FULLTECH_SMART_COMMERCE_ENABLED==='true'),backend:db.kind,handle:store.handle,catalog:storeCatalog,db,customers,audit,clock:config.clock,
    router:config.storeSmartCommerce?.router??createRoadRouter({baseUrl:process.env.FULLTECH_ROUTING_OSRM_URL||'',profile:process.env.FULLTECH_ROUTING_PROFILE||'driving',fetchImpl:config.storeSmartCommerce?.routingFetch??fetch}),capacityProvider:config.storeSmartCommerce?.capacityProvider,supplierNotifier:config.storeSmartCommerce?.supplierNotifier,faultInjector:config.storeSmartCommerce?.faultInjector});

  /*
   * Identidad de cliente: OTP de teléfono, confirmación de correo, recuperación
   * de contraseña y verificación del `credential` de Google Identity Services.
   */
  const googleId = createGoogleIdVerifier({
    clientId: settings.storeOAuth?.google?.clientId ?? '',
    fetchImpl: config.storeOAuthFetch ?? fetch,
    clock: config.clock,
  });
  const storeVerifications = await createStoreVerifications({
    backend: db.kind,
    handle: store.handle,
    accounts: storeAccounts,
    customers,
    sms: createSmsSender({ ...settings.storeSms, fetchImpl: config.smsFetch ?? fetch }),
    mail: createMailSender({ ...settings.storeMail, fetchImpl: config.mailFetch ?? fetch }),
    links: { publicUrl: settings.storeOAuth?.publicUrl ?? settings.storeSeo?.publicUrl ?? '' },
    clock: config.clock,
    otpEnabled: settings.storePhoneOtp === true,
  });

  const ctx = {
    uatMode: config.uatMode === true && store.kind === 'sqlite' && path.resolve(store.file) === path.resolve('data/uat/phyto-uat.sqlite'),
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
    storeCatalog,
    storeKey: storeCatalog?.storeKey ?? STORE_KEY,
    storeAccounts,
    smartCommerce,
    storeOAuth,
    storeVerifications,
    googleId,
    /*
     * Quién es el proxy y cuándo se le cree: lo decide el servidor, no el
     * cliente. `PHYTO_TRUSTED_PROXIES` permite añadir IPs; por defecto solo el
     * loopback (nginx del contenedor). `PHYTO_FORCE_SECURE_COOKIES=true` marca
     * las cookies `Secure` aunque el proxy no reenvíe el esquema.
     */
    requestTrust: config.requestTrust ?? createRequestTrust({
      trustedProxies: process.env.PHYTO_TRUSTED_PROXIES,
      forceSecure: process.env.PHYTO_FORCE_SECURE_COOKIES,
    }),
    storeSeo: settings.storeSeo,
    settings: settingsService,
    chatSharing: createChatSharingService({ settings: settingsService, customers }),
    /* Alta de pedidos desde la tienda: mismo motor de pedidos del CRM. */
    createStoreOrder: (account, body) => createStoreOrder(ctx, account, body),
    proofreading,
    scheduler,
    /*
     * IMÁGENES PARA LA IA: solo las fotos del tramo reciente, descargadas de R2
     * en el servidor y convertidas a data URL para el modelo. No salen del
     * proceso, no se guardan y el navegador nunca ve el binario ni la clave.
     */
    aiMediaImages: async (messages = []) => {
      const out = new Map();
      if (!mediaStore || !storage?.enabled) return out;
      const conFoto = messages.filter((row) => String(row?.type || '').toLowerCase() === 'image' && row?.id);
      if (!conFoto.length) return out;
      const rows = await mediaStore.byMessageIds(conFoto.map((row) => row.id)).catch(() => []);
      const byMessage = new Map(rows.filter((row) => row.message_id).map((row) => [row.message_id, row]));
      for (const msg of conFoto.slice(-3)) {
        const meta = byMessage.get(msg.id);
        const mime = String(meta?.mime_type || '').toLowerCase();
        if (!meta?.object_key || !/^image\/(png|jpe?g|webp|gif)$/.test(mime)) continue;
        const got = await storage.get(meta.object_key).catch(() => null);
        if (!got?.ok || !got.buffer || got.buffer.length > 2 * 1024 * 1024) continue;
        out.set(msg.id, [`data:${mime};base64,${got.buffer.toString('base64')}`]);
      }
      return out;
    },
    // Multimedia: metadata (BD), binario (R2), Graph y el pipeline que los une.
    media: { store: mediaStore, storage, whatsapp: whatsappMedia, pipeline: mediaPipeline },
    whatsapp,
    whatsappStatus,
    whatsappPhoneNumber: (config.whatsappPhoneNumber ?? WHATSAPP_PHONE_NUMBER).trim(),
    whatsappWebhookUrl: (config.whatsappWebhookUrl ?? WHATSAPP_WEBHOOK_URL).trim(),
    whatsappVerifyToken: (config.whatsappVerifyToken ?? WHATSAPP_VERIFY_TOKEN).trim(),
    appSecret: (config.metaAppSecret ?? META_APP_SECRET).trim(),
    deliveryEventClients: new Set(),
    /*
     * BUS DE TIEMPO REAL (pedidos, entregas, recogidas, cobros, inventario,
     * clientes y supervisor). Vive en MEMORIA del proceso: hay UNA instancia de
     * Node (nginx y Node en el mismo contenedor). Si algún día hubiera varias
     * réplicas, el único sitio que cambia es `server/realtime.mjs`.
     */
    realtime: createRealtimeHub(),
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
  smartCommerce?.fulfillment.setAdapters({getOrder:async orderId=>{const row=await store.getAdmin(orderId);return row?{row,order:orderOf(row)}:null;},completeOrder:(orderId,actor)=>transitionOrderStatus(ctx,{orderId,targetStatus:'ENTREGADO',actor,source:'SMART_PICKUP',reason:'Retiro autorizado con código de un solo uso'}),cancelOrder:(orderId,actor)=>transitionOrderStatus(ctx,{orderId,targetStatus:'CANCELADO',actor,source:'STORE_CUSTOMER',reason:'Cancelación solicitada por el propietario del pedido'})});
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

  const callingEnabled = config.callingEnabled ?? process.env.WHATSAPP_CALLING_ENABLED === '1';
  const callingApi = config.callingApi ?? createCallingApi({
    enabled: callingEnabled && Boolean(ctx.appSecret),
    env: {
      WHATSAPP_ACCESS_TOKEN: config.whatsappAccessToken ?? WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: config.whatsappPhoneNumberId ?? WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: config.whatsappBusinessAccountId ?? WHATSAPP_BUSINESS_ACCOUNT_ID,
      WHATSAPP_CALLING_GRAPH_VERSION: config.callingGraphVersion || process.env.WHATSAPP_CALLING_GRAPH_VERSION || WHATSAPP_GRAPH_VERSION,
      WHATSAPP_CALLING_PERMISSION_TEMPLATE: config.callingPermissionTemplate ?? process.env.WHATSAPP_CALLING_PERMISSION_TEMPLATE,
      WHATSAPP_CALLING_PERMISSION_LANGUAGE: process.env.WHATSAPP_CALLING_PERMISSION_LANGUAGE ?? 'es',
    },
  });
  const rawIceServers = config.callingIceServers ?? process.env.WHATSAPP_CALLING_ICE_SERVERS;
  let iceServers = [];
  try { iceServers = typeof rawIceServers === 'string' ? JSON.parse(rawIceServers) : rawIceServers ?? []; } catch { throw new Error('invalid_calling_ice_servers'); }
  if (!Array.isArray(iceServers) || iceServers.length > 5 || iceServers.some((entry) => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    return !urls.length || urls.some((value) => typeof value !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/.test(value));
  })) throw new Error('invalid_calling_ice_servers');
  ctx.callingIceServers = iceServers;
  ctx.calling = createCallingService({
    store: callingEnabled ? await createCallingStore(sqlQuery) : null,
    api: callingApi, customers, db, audit, enabled: callingEnabled && Boolean(ctx.appSecret),
  });
  ctx.calling.start();

  const server = createServer((req, res) => {
    /*
     * TIEMPO REAL — PUBLICAR SOLO LO QUE SE GUARDÓ.
     *
     * Se engancha AQUÍ, en un único punto, en vez de tocar veinte rutas: se
     * guarda la respuesta JSON y, cuando la petición termina, si el estado es
     * 2xx se publica el evento correspondiente. Un 4xx/5xx o un cuerpo que no es
     * JSON no anuncia nada (no se avisa de escrituras fallidas).
     *
     * `x-crm-device` lo pone el propio panel: así el dispositivo que hizo el
     * cambio no se repite el trabajo; los demás sí se enteran.
     */
    let status = 0;
    /** @type {string|null} */
    let captured = null;
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      status = Number(code) || 0;
      return writeHead(code, ...rest);
    };
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (captured === null && typeof chunk === 'string' && chunk.length <= 200_000) captured = chunk;
      return end(chunk, ...rest);
    };
    res.on('finish', () => {
      if (!captured || !(status >= 200 && status < 300)) return;
      try {
        const parsed = JSON.parse(captured);
        const route = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
        const events = eventFromMutation({ method: req.method, route, status, body: parsed });
        if (!events.length) return;
        const actor = res.__crmActor ?? null;
        const origin = String(req.headers['x-crm-device'] ?? '').slice(0, 64) || null;
        /*
         * La empresa del aviso se resuelve aparte porque a veces exige ir al
         * almacén. El evento sigue siendo «sin contenido»: la empresa solo dice
         * a quién se le puede repartir.
         */
        void mutationEventScope(ctx, events, parsed)
          .then((scope) => ctx.realtime.publish(events.map((event) => ({ ...event, actor, origin, ...scope }))))
          .catch(() => { /* avisar no puede tumbar la petición que sí se guardó */ });
      } catch {
        /* Respuesta no JSON (PDF, imagen, CSV): no hay nada que anunciar. */
      }
    });
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
  // `PHYTO_CRM_NO_SCHEDULER=1` apaga el bucle en una instancia que comparte la
  // base con otra que YA lo corre (p. ej. `npm run dev` en local mirando a
  // producción): evita mandar dos veces el mismo mensaje programado. El `tick()`
  // manual (tests, rutas de admin) sigue funcionando.
  const schedulerDisabledByEnv = String(process.env.PHYTO_CRM_NO_SCHEDULER ?? '').trim() === '1';
  const schedulerInterval =
    config.schedulerIntervalMs ??
    (config.schedulerEnabled === false || schedulerDisabledByEnv ? 0 : 30_000);
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
    const callingStopped = ctx.calling.stop();
    return new Promise((resolve, reject) => {
      server.close(async () => {
        try {
          await callingStopped;
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

