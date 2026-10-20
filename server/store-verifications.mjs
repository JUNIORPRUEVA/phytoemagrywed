/**
 * VERIFICACIÓN DE IDENTIDAD DE CLIENTES — teléfono (OTP), correo y recuperación.
 *
 * REGLAS QUE NO SE ROMPEN
 *  - Nada se considera «verificado» por lo que escriba el navegador: el estado
 *    vive en tablas propias del servidor (`fulltech_store_phone_v1`, …).
 *  - Un código nunca se guarda en claro: se guarda su hash con sal.
 *  - Sin proveedor de SMS configurado no se SIMULA un envío. La operación
 *    responde «no disponible» y la tienda lo dice con claridad.
 *  - Este módulo NO manda WhatsApp no oficial: el canal es SMS o correo
 *    transaccional aprobado.
 *
 * Todo es aditivo: tablas nuevas, sin tocar clientes, pedidos ni inventario.
 */
import { createHash, randomInt as cryptoRandomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { createSqlQuery } from './sql-query.mjs';

const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

/** Códigos de área móviles/fijos de República Dominicana (NANP). */
export const DR_AREA_CODES = Object.freeze(['809', '829', '849']);
const DR_AREAS = new Set(DR_AREA_CODES);

/** Vigencia del código, espera entre envíos y límites antiabuso. */
export const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
export const PHONE_RESEND_COOLDOWN_MS = 60 * 1000;
export const PHONE_LIMITS = Object.freeze({
  perAccountHour: 5,
  perPhoneHour: 5,
  perIpHour: 15,
  maxAttempts: 5,
});

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

// ------------------------------------------------------------ utilidades puras

/**
 * Valida un teléfono de República Dominicana.
 *
 * NO se asume que todo +1 sea dominicano: solo 809/829/849 son DR. Un +1 212
 * (Nueva York) se rechaza con `not_dr` en vez de aceptarse a ciegas.
 *
 * @param {unknown} raw
 * @returns {{ok:true, e164:string, national:string, area:string} | {ok:false, reason:string}}
 */
export function normalizeDnPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'empty' };
  const withoutPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  let national = '';
  if (/^\d{10}$/.test(withoutPrefix)) national = withoutPrefix;
  else if (/^1\d{10}$/.test(withoutPrefix)) national = withoutPrefix.slice(1);
  else return { ok: false, reason: 'length' };
  const area = national.slice(0, 3);
  if (!DR_AREAS.has(area)) return { ok: false, reason: 'not_dr' };
  const exchange = national.slice(3, 6);
  if (!/^[2-9]\d{2}$/.test(exchange)) return { ok: false, reason: 'invalid' };
  return { ok: true, e164: `+1${national}`, national, area };
}

/** Teléfono enmascarado para mostrar: `+1 ••• ••• 4567`. */
export function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `+${digits.slice(0, 1)} ••• ••• ${digits.slice(-4)}`;
}

/**
 * REGLA DE FASE 1: para pedir o solicitar hace falta un TELÉFONO GUARDADO, no
 * verificado. La verificación por SMS está aplazada.
 *
 * @param {{phone_e164?: string|null}} account
 */
export function phoneRequirement(account) {
  const phone = String(account?.phone_e164 ?? '').trim();
  if (phone) return { ok: true, phone };
  return {
    ok: false,
    code: 'phone_required',
    message: 'Agrega tu número de teléfono para continuar.',
  };
}

/** Código de 6 dígitos (sin ceros a la izquierda para que no se pierdan). */
export function generateCode(randomInt = cryptoRandomInt) {
  return String(randomInt(100000, 1000000));
}

export function hashCode(code, salt) {
  return createHash('sha256').update(`${salt}:${String(code).trim()}`).digest('hex');
}

/** Comparación en tiempo constante (no filtra el código por el tiempo). */
export function codeMatches(code, salt, expected) {
  const left = Buffer.from(hashCode(code, salt), 'hex');
  const right = Buffer.from(String(expected ?? ''), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const tokenHash = (value) => createHash('sha256').update(String(value)).digest('hex');

/** Enlace de verificación/cambio de contraseña; solo se guarda su hash. */
function newToken() {
  return cryptoRandomInt(0, 2 ** 48).toString(36) + randomUUID().replace(/-/g, '');
}

// ---------------------------------------------------------------- proveedores

function writeOutbox(file, line) {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* Un buzón local ilegible no debe tumbar la petición del cliente. */
  }
}

/**
 * Envío de SMS.
 *
 *   off    → apagado (sin PHYTO_STORE_SMS_URL): la verificación está cerrada.
 *   http   → POST JSON `{ to, text }` al endpoint aprobado (Twilio, Meta u otro
 *            con puerta HTTP). El token va en `Authorization: Bearer`.
 *   outbox → SOLO UAT: escribe el código en `data/uat/sms-outbox.log` y nunca
 *            sale a la red. Es el modo con el que se prueban los flujos.
 */
export function createSmsSender({ mode = 'off', url = '', token = '', from = '', outboxPath = '', fetchImpl = fetch } = {}) {
  const normalized = ['http', 'outbox'].includes(mode) ? mode : 'off';
  const configured = normalized === 'http' ? Boolean(url && token) : normalized === 'outbox';
  return {
    mode: normalized,
    configured,
    /** En UAT el código se puede leer para probar; en `http` jamás. */
    exposesCodes: configured && normalized === 'outbox',
    async send({ to, code, purpose = 'login' }) {
      if (!configured) throw fail('sms_unavailable', 'La verificación por SMS todavía no está activa.', 503);
      const text = `FULLTECH: tu código es ${code}. Vence en 10 minutos. No lo compartas.`;
      if (normalized === 'outbox') {
        writeOutbox(outboxPath, `sms to=${maskPhone(to)} purpose=${purpose} code=${code}`);
        return { ok: true, provider: 'outbox' };
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, from: from || undefined, text }),
      });
      if (!response.ok) {
        // Nunca se registra el destino ni el texto: solo el estado.
        throw fail('sms_failed', 'No pudimos enviar el código. Inténtalo de nuevo.', 502);
      }
      return { ok: true, provider: 'http' };
    },
  };
}

/**
 * Envío de correo transaccional.
 *
 *   off    → apagado: ni verificación de correo ni recuperación de contraseña.
 *   http   → POST JSON `{ to, subject, text }` a la puerta aprobada.
 *   outbox → SOLO UAT: escribe en `data/uat/mail-outbox.log`.
 */
export function createMailSender({ mode = 'off', url = '', token = '', from = '', outboxPath = '', fetchImpl = fetch } = {}) {
  const normalized = ['http', 'outbox'].includes(mode) ? mode : 'off';
  const configured = normalized === 'http' ? Boolean(url && token) : normalized === 'outbox';
  return {
    mode: normalized,
    configured,
    exposesCodes: configured && normalized === 'outbox',
    async send({ to, subject, text }) {
      if (!configured) throw fail('mail_unavailable', 'El envío de correos todavía no está activo.', 503);
      if (normalized === 'outbox') {
        writeOutbox(outboxPath, `mail to=${to} subject="${subject}" ${text.replace(/\s+/g, ' ')}`);
        return { ok: true, provider: 'outbox' };
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, from: from || undefined, subject, text }),
      });
      if (!response.ok) throw fail('mail_failed', 'No pudimos enviar el correo. Inténtalo de nuevo.', 502);
      return { ok: true, provider: 'http' };
    },
  };
}

// -------------------------------------------------------------------- motor

/**
 * @param {object} deps
 * @param {'postgres'|'sqlite'|'jsonl'} deps.backend
 * @param {any} deps.handle  conexión (SQLite) o pool (PostgreSQL)
 * @param {any} deps.accounts  `createStoreAccounts(...)` (para correo y contraseña)
 * @param {any} [deps.customers] clientes del CRM (para no pisar identidades)
 * @param {ReturnType<typeof createSmsSender>} [deps.sms]
 * @param {ReturnType<typeof createMailSender>} [deps.mail]
 * @param {() => Date} [deps.clock]
 * @param {{publicUrl?:string}} [deps.links]
 */
export async function createStoreVerifications({
  backend,
  handle,
  accounts,
  customers,
  sms = createSmsSender(),
  mail = createMailSender(),
  clock = () => new Date(),
  links = {},
  limits = PHONE_LIMITS,
  /*
   * VERIFICACIÓN POR SMS: APLAZADA en la Fase 1. Se puede reactivar sin tocar
   * código con `PHYTO_STORE_PHONE_OTP=enabled`, pero por defecto está apagada y
   * ninguno de los flujos de compra la exige.
   */
  otpEnabled = false,
} = {}) {
  const sql = createSqlQuery({ backend, handle });
  if (!sql.enabled || !accounts) return null;

  await sql.query(`
    CREATE TABLE IF NOT EXISTS fulltech_store_phone_v1 (
      account_id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      verified_at TEXT,
      updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulltech_store_phone_codes_v1 (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      ip_hash TEXT);
    CREATE INDEX IF NOT EXISTS fulltech_store_phone_codes_account_idx ON fulltech_store_phone_codes_v1(account_id, sent_at);
    CREATE INDEX IF NOT EXISTS fulltech_store_phone_codes_phone_idx ON fulltech_store_phone_codes_v1(phone_e164, sent_at);
    CREATE TABLE IF NOT EXISTS fulltech_store_email_tokens_v1 (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      email_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT);
    CREATE INDEX IF NOT EXISTS fulltech_store_email_tokens_account_idx ON fulltech_store_email_tokens_v1(account_id, kind);
    CREATE TABLE IF NOT EXISTS fulltech_store_email_v1 (
      account_id TEXT PRIMARY KEY,
      email_key TEXT NOT NULL,
      verified_at TEXT NOT NULL)`);

  const now = () => clock();
  const iso = (date) => date.toISOString();
  const sinceIso = (ms) => iso(new Date(now().getTime() - ms));

  async function count(statement, values) {
    const row = (await sql.query(statement, values)).rows[0];
    return Number(row?.n ?? row?.count ?? 0);
  }

  async function phoneRow(accountId) {
    return (await sql.query('SELECT * FROM fulltech_store_phone_v1 WHERE account_id=$1', [accountId])).rows[0] ?? null;
  }

  /**
   * Estado público del teléfono: nunca devuelve el código ni el número completo.
   *
   * `saved` es lo único que exige la Fase 1 para comprar. `verified` solo es
   * `true` si alguien confirmó el código con ese MISMO número.
   */
  async function phoneStatus(accountId, currentPhone = null) {
    const row = await phoneRow(accountId);
    const phone = String(currentPhone ?? row?.phone_e164 ?? '').trim();
    const last = (await sql.query('SELECT sent_at, expires_at, consumed_at FROM fulltech_store_phone_codes_v1 WHERE account_id=$1 ORDER BY sent_at DESC LIMIT 1', [accountId])).rows[0] ?? null;
    const cooldownUntil = last ? new Date(last.sent_at).getTime() + PHONE_RESEND_COOLDOWN_MS : 0;
    const verified = Boolean(row?.verified_at) && Boolean(phone) && row.phone_e164 === phone;
    return {
      otp_enabled: otpEnabled,
      channel: otpEnabled && sms.configured ? (sms.mode === 'http' ? 'sms' : sms.mode) : 'off',
      saved: Boolean(phone),
      verified,
      /* El número completo NUNCA sale al navegador: solo la versión enmascarada. */
      masked: phone ? maskPhone(phone) : null,
      verified_at: verified ? row.verified_at : null,
      pending: Boolean(last && !last.consumed_at && new Date(last.expires_at).getTime() > now().getTime()),
      resend_in_seconds: Math.max(0, Math.ceil((cooldownUntil - now().getTime()) / 1000)),
    };
  }

  async function verifiedPhone(accountId) {
    const row = await phoneRow(accountId);
    return row?.verified_at ? row : null;
  }

  /**
   * Deja constancia del número con estado **unverified** (verified_at NULL).
   * Si el número cambia, la verificación anterior deja de valer.
   */
  async function markPhoneUnverified(account, phone) {
    const e164 = String(phone ?? account?.phone_e164 ?? '').trim();
    if (!account?.id || !e164) return null;
    const row = await phoneRow(account.id);
    const at = iso(now());
    if (row && row.phone_e164 === e164) {
      if (!row.verified_at) await sql.query('UPDATE fulltech_store_phone_v1 SET updated_at=$1 WHERE account_id=$2', [at, account.id]);
      return { phone_e164: e164, verified_at: row.verified_at ?? null };
    }
    if (row) {
      await sql.query('UPDATE fulltech_store_phone_v1 SET phone_e164=$1, verified_at=NULL, updated_at=$2 WHERE account_id=$3', [e164, at, account.id]);
    } else {
      await sql.query('INSERT INTO fulltech_store_phone_v1(account_id,phone_e164,verified_at,updated_at) VALUES($1,$2,NULL,$3)', [account.id, e164, at]);
    }
    return { phone_e164: e164, verified_at: null };
  }

  /**
   * Pide un código para el número indicado. El número puede ser el de la cuenta
   * (alta) o uno nuevo (cambio), pero nunca uno que ya pertenezca a otra cuenta
   * o a un cliente con historial: eso permitiría apropiarse de compras ajenas.
   */
  async function requestPhoneCode({ account, phone, ip = '' }) {
    if (!otpEnabled) {
      /* Aplazado a propósito: no se envía ningún mensaje en la Fase 1. */
      throw fail('otp_disabled', 'La confirmación por mensaje todavía no está activa.', 409);
    }
    if (!account?.id) throw fail('unauthorized', 'Inicia sesión para continuar.', 401);
    const parsed = normalizeDnPhone(phone);
    if (!parsed.ok) {
      throw fail(
        'invalid_phone',
        parsed.reason === 'not_dr'
          ? 'Por ahora verificamos solo números de República Dominicana (809, 829 y 849).'
          : 'Escribe un número dominicano válido, por ejemplo 809 000 0000.',
      );
    }
    if (!sms.configured) {
      throw fail('sms_unavailable', 'La verificación por SMS todavía no está activa. Escríbenos y te ayudamos a completar tu cuenta.', 503);
    }

    const latest = (await sql.query('SELECT sent_at FROM fulltech_store_phone_codes_v1 WHERE account_id=$1 ORDER BY sent_at DESC LIMIT 1', [account.id])).rows[0] ?? null;
    if (latest) {
      const wait = PHONE_RESEND_COOLDOWN_MS - (now().getTime() - new Date(latest.sent_at).getTime());
      if (wait > 0) {
        throw Object.assign(fail('resend_too_soon', `Espera ${Math.ceil(wait / 1000)} segundos para pedir otro código.`, 429), {
          retryAfter: Math.ceil(wait / 1000),
        });
      }
    }

    const hourAgo = sinceIso(60 * 60 * 1000);
    if ((await count('SELECT COUNT(*) AS n FROM fulltech_store_phone_codes_v1 WHERE account_id=$1 AND sent_at>$2', [account.id, hourAgo])) >= limits.perAccountHour) {
      throw fail('too_many_codes', 'Pediste varios códigos en la última hora. Espera un rato o escríbenos.', 429);
    }
    if ((await count('SELECT COUNT(*) AS n FROM fulltech_store_phone_codes_v1 WHERE phone_e164=$1 AND sent_at>$2', [parsed.e164, hourAgo])) >= limits.perPhoneHour) {
      throw fail('too_many_codes', 'Ese número recibió varios códigos en la última hora. Espera un rato o escríbenos.', 429);
    }
    const hashedIp = ip ? tokenHash(ip) : '';
    if (hashedIp && (await count('SELECT COUNT(*) AS n FROM fulltech_store_phone_codes_v1 WHERE ip_hash=$1 AND sent_at>$2', [hashedIp, hourAgo])) >= limits.perIpHour) {
      throw fail('too_many_codes', 'Hay demasiados intentos desde esta conexión. Espera unos minutos.', 429);
    }

    const code = generateCode();
    const salt = randomUUID();
    const sentAt = now();
    const expiresAt = new Date(sentAt.getTime() + PHONE_CODE_TTL_MS);
    await sql.query('DELETE FROM fulltech_store_phone_codes_v1 WHERE expires_at<$1', [sinceIso(2 * 24 * 60 * 60 * 1000)]);
    await sql.query(
      'INSERT INTO fulltech_store_phone_codes_v1(id,account_id,phone_e164,code_salt,code_hash,attempts,sent_at,expires_at,consumed_at,ip_hash) VALUES($1,$2,$3,$4,$5,0,$6,$7,NULL,$8)',
      [`pc_${randomUUID()}`, account.id, parsed.e164, salt, hashCode(code, salt), iso(sentAt), iso(expiresAt), hashedIp],
    );
    await sms.send({ to: parsed.e164, code, purpose: 'verify' });
    return {
      ok: true,
      phone: maskPhone(parsed.e164),
      expires_in: Math.round(PHONE_CODE_TTL_MS / 1000),
      resend_in: Math.round(PHONE_RESEND_COOLDOWN_MS / 1000),
    };
  }

  /**
   * Confirma el código. Al validarlo se marca el número como verificado para
   * ESA cuenta; si el número es distinto del guardado, se actualiza la cuenta
   * solo cuando no choca con otra identidad.
   */
  async function confirmPhoneCode({ account, code, password = '' }) {
    if (!account?.id) throw fail('unauthorized', 'Inicia sesión para continuar.', 401);
    const row = (await sql.query('SELECT * FROM fulltech_store_phone_codes_v1 WHERE account_id=$1 AND consumed_at IS NULL ORDER BY sent_at DESC LIMIT 1', [account.id])).rows[0] ?? null;
    if (!row) throw fail('code_expired', 'El código caducó. Pide uno nuevo.', 410);
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      throw fail('code_expired', 'El código caducó. Pide uno nuevo.', 410);
    }
    if (Number(row.attempts) >= limits.maxAttempts) {
      await sql.query('UPDATE fulltech_store_phone_codes_v1 SET consumed_at=$1 WHERE id=$2', [iso(now()), row.id]);
      throw fail('too_many_attempts', 'Demasiados intentos con ese código. Pide uno nuevo.', 429);
    }
    if (!/^\d{6}$/.test(String(code ?? '').trim()) || !codeMatches(code, row.code_salt, row.code_hash)) {
      await sql.query('UPDATE fulltech_store_phone_codes_v1 SET attempts=attempts+1 WHERE id=$1', [row.id]);
      throw fail('invalid_code', 'El código no coincide. Revisa el mensaje y vuelve a escribirlo.', 422);
    }

    const previous = await phoneRow(account.id);
    const isChange = Boolean(previous?.phone_e164) && previous.phone_e164 !== row.phone_e164;
    if (isChange) await assertPhoneAssignable(row.phone_e164, account);

    await sql.query('UPDATE fulltech_store_phone_codes_v1 SET consumed_at=$1 WHERE id=$2', [iso(now()), row.id]);
    if (previous) {
      await sql.query('UPDATE fulltech_store_phone_v1 SET phone_e164=$1, verified_at=$2, updated_at=$2 WHERE account_id=$3', [row.phone_e164, iso(now()), account.id]);
    } else {
      await sql.query('INSERT INTO fulltech_store_phone_v1(account_id,phone_e164,verified_at,updated_at) VALUES($1,$2,$3,$3)', [account.id, row.phone_e164, iso(now())]);
    }
    if (isChange) {
      await sql.query('UPDATE fulltech_customer_accounts_v1 SET phone_e164=$1, updated_at=$2 WHERE id=$3', [row.phone_e164, iso(now()), account.id]);
    }
    /*
     * Verificar el número NO cierra la sesión: el cliente acaba de demostrar que
     * controla el teléfono desde este mismo dispositivo. Cerrar aquí lo dejaría
     * fuera del pedido que estaba completando.
     */
    return { ok: true, verified: true, phone: maskPhone(row.phone_e164) };
  }

  async function assertPhoneAssignable(phone, account) {
    const other = (await sql.query('SELECT id FROM fulltech_customer_accounts_v1 WHERE phone_e164=$1 AND id<>$2 LIMIT 1', [phone, account.id])).rows[0];
    if (other) throw fail('phone_in_use', 'Ese número ya está asociado a otra cuenta. Inicia sesión con ella.', 409);
    if (typeof customers?.findByPhone === 'function') {
      const customer = await customers.findByPhone(phone);
      if (customer && customer.id !== account.customer_id) {
        throw fail('phone_in_use', 'Ese número ya tiene historial con nosotros. Verifícalo desde la cuenta original.', 409);
      }
    }
  }

  /** Solo UAT: último código enviado a esta cuenta (nunca con SMS real). */
  async function peekLastCode(accountId) {
    if (!sms.exposesCodes) throw fail('not_available', 'Función no disponible.', 404);
    const row = (await sql.query('SELECT id FROM fulltech_store_phone_codes_v1 WHERE account_id=$1 AND consumed_at IS NULL ORDER BY sent_at DESC LIMIT 1', [accountId])).rows[0];
    // El código no se puede recuperar del hash: el buzón de UAT es la fuente.
    return { available: Boolean(row), outbox: 'data/uat/sms-outbox.log' };
  }

  // ---------------------------------------------------------------- correo

  async function issueEmailToken(accountId, kind, emailKey, ttlMs) {
    const token = newToken();
    const at = now();
    await sql.query('DELETE FROM fulltech_store_email_tokens_v1 WHERE expires_at<$1', [sinceIso(2 * 24 * 60 * 60 * 1000)]);
    await sql.query('INSERT INTO fulltech_store_email_tokens_v1(token_hash,account_id,kind,email_key,created_at,expires_at,used_at) VALUES($1,$2,$3,$4,$5,$6,NULL)', [
      tokenHash(token), accountId, kind, emailKey ?? null, iso(at), iso(new Date(at.getTime() + ttlMs)),
    ]);
    return token;
  }

  async function consumeEmailToken(token, kind) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token ?? ''))) throw fail('invalid_token', 'El enlace no es válido.', 400);
    const row = (await sql.query('SELECT * FROM fulltech_store_email_tokens_v1 WHERE token_hash=$1', [tokenHash(token)])).rows[0] ?? null;
    if (!row || row.kind !== kind) throw fail('invalid_token', 'El enlace no es válido.', 400);
    if (row.used_at) throw fail('token_used', 'Ese enlace ya se usó. Pide uno nuevo.', 410);
    if (new Date(row.expires_at).getTime() <= now().getTime()) throw fail('token_expired', 'El enlace caducó. Pide uno nuevo.', 410);
    await sql.query('UPDATE fulltech_store_email_tokens_v1 SET used_at=$1 WHERE token_hash=$2', [iso(now()), row.token_hash]);
    return row;
  }

  /** Envía el enlace de confirmación al correo (no al teléfono). */
  async function requestEmailVerification(account) {
    if (!account?.id) throw fail('unauthorized', 'Inicia sesión para continuar.', 401);
    const email = clean(account.email, 160);
    if (!email || !isEmail(email)) throw fail('invalid_email', 'Escribe un correo válido en tus datos.', 422);
    if (!mail.configured) throw fail('mail_unavailable', 'La confirmación por correo todavía no está activa.', 503);
    const token = await issueEmailToken(account.id, 'email_verify', email.toLowerCase(), EMAIL_TOKEN_TTL_MS);
    const base = String(links.publicUrl ?? '').replace(/\/+$/, '');
    const url = `${base}/store/#/account/email?token=${encodeURIComponent(token)}`;
    await mail.send({
      to: email,
      subject: 'Confirma tu correo en FULLTECH Store',
      text: `Abre este enlace para confirmar tu correo: ${url}. Caduca en 24 horas.`,
    });
    return { ok: true, email: email.replace(/^(.).*(.@)/, '$1•••$2') };
  }

  async function confirmEmailVerification(token) {
    const row = await consumeEmailToken(token, 'email_verify');
    const account = await accounts.accountBy('id', row.account_id);
    if (!account) throw fail('invalid_token', 'El enlace no es válido.', 400);
    /* El enlace de un correo anterior no debe validar el correo nuevo. */
    const current = clean(account.email, 160).toLowerCase();
    if (!current || current !== String(row.email_key ?? '')) {
      throw fail('email_changed', 'Tu correo cambió después de enviar el enlace. Pide uno nuevo.', 409);
    }
    const at = iso(now());
    await sql.query('DELETE FROM fulltech_store_email_v1 WHERE account_id=$1', [account.id]);
    await sql.query('INSERT INTO fulltech_store_email_v1(account_id,email_key,verified_at) VALUES($1,$2,$3)', [account.id, current, at]);
    return { ok: true, email: account.email ?? null };
  }

  /** ¿El correo actual de la cuenta está confirmado? */
  async function emailVerified(account) {
    if (!account?.id || !account.email) return false;
    const row = (await sql.query('SELECT email_key FROM fulltech_store_email_v1 WHERE account_id=$1', [account.id])).rows[0] ?? null;
    return Boolean(row) && row.email_key === clean(account.email, 160).toLowerCase();
  }

  /**
   * Recuperación de contraseña. La respuesta pública es SIEMPRE la misma, haya
   * o no cuenta, para no revelar qué correos están registrados.
   */
  async function requestPasswordReset({ identifier }) {
    const raw = clean(identifier, 160);
    const generic = { ok: true, message: 'Si el dato coincide con una cuenta, te enviamos un enlace para recuperar el acceso.' };
    if (!raw || !isEmail(raw) || !mail.configured) return generic;
    const account = await accounts.accountBy('email_key', raw.toLowerCase());
    if (!account || account.status !== 'active') return generic;
    const token = await issueEmailToken(account.id, 'password_reset', raw.toLowerCase(), RESET_TOKEN_TTL_MS);
    const base = String(links.publicUrl ?? '').replace(/\/+$/, '');
    const url = `${base}/store/#/account/reset?token=${encodeURIComponent(token)}`;
    try {
      await mail.send({
        to: raw,
        subject: 'Recupera tu acceso a FULLTECH Store',
        text: `Abre este enlace para crear una contraseña nueva: ${url}. Caduca en 30 minutos. Si no fuiste tú, ignora este mensaje.`,
      });
    } catch {
      /* Nunca se filtra al público si el correo salió o no. */
    }
    return generic;
  }

  async function resetPassword(token, password) {
    const value = String(password ?? '');
    if (value.length < 8 || value.length > 200) throw fail('invalid_password', 'La contraseña debe tener al menos 8 caracteres.', 422);
    const row = await consumeEmailToken(token, 'password_reset');
    await accounts.setPassword(row.account_id, value);
    return { ok: true };
  }

  return {
    sms,
    mail,
    otpEnabled,
    phoneStatus,
    verifiedPhone,
    markPhoneUnverified,
    requestPhoneCode,
    confirmPhoneCode,
    peekLastCode,
    requestEmailVerification,
    confirmEmailVerification,
    emailVerified,
    requestPasswordReset,
    resetPassword,
  };
}
