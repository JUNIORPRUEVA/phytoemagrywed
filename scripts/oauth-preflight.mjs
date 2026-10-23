#!/usr/bin/env node
/**
 * PREFLIGHT DE GOOGLE OAUTH — comprueba la configuración sin enseñar secretos.
 *
 * Uso:
 *   node scripts/oauth-preflight.mjs                 # entorno del proceso
 *   node scripts/oauth-preflight.mjs .env.production  # una archivo KEY=VALUE
 *
 * QUÉ HACE: verifica forma y coherencia de las tres variables de Google
 * (`CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI`) y avisa del error real que se
 * encontró en producción: un CLIENT SECRET guardado en la casilla del CLIENT_ID
 * (eso dejaba el botón de Google apagado para siempre).
 *
 * QUÉ NO HACE: no imprime ningún valor. Solo dice si está puesto, cuánto mide y
 * si su FORMA es la correcta. Nunca escribe, nunca despliega, nunca llama a
 * Google.
 */
import { readFileSync } from 'node:fs';

const expectations = {
  callbackPath: '/api/store/account/auth/google/callback',
  apex: 'fulltechrd.com',
};

/** Formas conocidas (no son secretos: son formatos públicos de Google). */
const CLIENT_ID_SHAPE = /^\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/i;
const CLIENT_SECRET_PREFIX = 'GOCSPX-';

const results = [];
const pass = (label, detail) => results.push({ level: 'PASS', label, detail });
const warn = (label, detail) => results.push({ level: 'WARN', label, detail });
const fail = (label, detail) => results.push({ level: 'FAIL', label, detail });

const readEnvFile = (file) => {
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
};

const file = process.argv[2];
const env = file ? readEnvFile(file) : process.env;
const source = file ?? 'entorno del proceso';

const clientId = String(env.PHYTO_GOOGLE_CLIENT_ID ?? '').trim();
const clientSecret = String(env.PHYTO_GOOGLE_CLIENT_SECRET ?? '').trim();
const redirectUri = String(env.PHYTO_GOOGLE_REDIRECT_URI ?? '').trim();

/* ── CLIENT ID ─────────────────────────────────────────────────────────── */
if (!clientId) {
  fail('PHYTO_GOOGLE_CLIENT_ID', 'no está definido');
} else if (clientId.startsWith(CLIENT_SECRET_PREFIX)) {
  /* El fallo real de producción: el secreto ocupa la casilla del ID. */
  fail(
    'PHYTO_GOOGLE_CLIENT_ID',
    `contiene lo que parece un CLIENT SECRET (prefijo ${CLIENT_SECRET_PREFIX}), no un client ID`,
  );
} else if (!CLIENT_ID_SHAPE.test(clientId)) {
  warn('PHYTO_GOOGLE_CLIENT_ID', `forma inesperada (len=${clientId.length}); se espera <proyecto>-<hash>.apps.googleusercontent.com`);
} else {
  pass('PHYTO_GOOGLE_CLIENT_ID', `forma correcta (proyecto ${clientId.split('-')[0]})`);
}

/* ── CLIENT SECRET ─────────────────────────────────────────────────────── */
if (!clientSecret) {
  fail('PHYTO_GOOGLE_CLIENT_SECRET', 'no está definido (sin él, el proveedor queda apagado)');
} else if (CLIENT_ID_SHAPE.test(clientSecret)) {
  fail('PHYTO_GOOGLE_CLIENT_SECRET', 'contiene un client ID, no el secreto');
} else if (!clientSecret.startsWith(CLIENT_SECRET_PREFIX)) {
  warn('PHYTO_GOOGLE_CLIENT_SECRET', `forma inesperada (len=${clientSecret.length}); se espera el valor que da Google Cloud`);
} else {
  pass('PHYTO_GOOGLE_CLIENT_SECRET', `definido (len=${clientSecret.length})`);
}

/* ── REDIRECT URI ──────────────────────────────────────────────────────── */
if (!redirectUri) {
  warn(
    'PHYTO_GOOGLE_REDIRECT_URI',
    'no está definido: se deriva del host de la petición (con varios dominios eso rompe el `state`)',
  );
} else {
  let parsed = null;
  try {
    parsed = new URL(redirectUri);
  } catch {
    fail('PHYTO_GOOGLE_REDIRECT_URI', 'no es una URL válida');
  }
  if (parsed) {
    if (parsed.protocol !== 'https:') fail('PHYTO_GOOGLE_REDIRECT_URI', 'debe usar https');
    if (parsed.pathname !== expectations.callbackPath) {
      fail('PHYTO_GOOGLE_REDIRECT_URI', `la ruta debe ser ${expectations.callbackPath}`);
    }
    if (/^www\./i.test(parsed.hostname)) {
      fail('PHYTO_GOOGLE_REDIRECT_URI', `debe ser el dominio canónico (${expectations.apex}), no www`);
    } else if (/easypanel\.host$/i.test(parsed.hostname) || parsed.hostname === 'localhost') {
      fail('PHYTO_GOOGLE_REDIRECT_URI', 'apunta a un host interno: Google lo rechazaría');
    } else if (parsed.hostname !== expectations.apex) {
      warn('PHYTO_GOOGLE_REDIRECT_URI', `host distinto del esperado (${expectations.apex}); confirma que está registrado en Google Cloud`);
    }
    if (parsed.search || parsed.hash) fail('PHYTO_GOOGLE_REDIRECT_URI', 'no debe llevar query ni fragmento');
    if (!results.some((row) => row.label === 'PHYTO_GOOGLE_REDIRECT_URI' && row.level === 'FAIL')) {
      pass('PHYTO_GOOGLE_REDIRECT_URI', `correcta (${parsed.hostname}${parsed.pathname})`);
    }
  }
}

/* ── COHERENCIA ENTRE LAS TRES ─────────────────────────────────────────── */
if (clientId && clientSecret && redirectUri && !redirectUri.startsWith('https://')) {
  fail('conjunto', 'las cookies `Secure` necesitan HTTPS: revisa el esquema del callback');
}

/* ── INFORME ───────────────────────────────────────────────────────────── */
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
console.log(`\nGoogle OAuth · preflight (${source})\n`);
for (const row of results) {
  counts[row.level] += 1;
  console.log(`  ${row.level.padEnd(4)} ${row.label.padEnd(28)} ${row.detail}`);
}
console.log(`\n  ${counts.PASS} ok · ${counts.WARN} aviso(s) · ${counts.FAIL} fallo(s)\n`);
process.exit(counts.FAIL > 0 ? 1 : 0);
