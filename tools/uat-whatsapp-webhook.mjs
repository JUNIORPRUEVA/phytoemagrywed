#!/usr/bin/env node
/**
 * MATRIZ DE SEGURIDAD DEL WEBHOOK DE WHATSAPP (SOLO UAT LOCAL).
 *
 * Comprueba que un evento firmado por Meta SOLO entra si era para el número
 * configurado (`metadata.phone_number_id`), y que un evento de otro número no
 * crea ni cambia nada. También cubre duplicados, estados, lote mixto, firma
 * inválida y lecturas sin sesión.
 *
 * Reglas:
 *  · Solo habla con 127.0.0.1 y exige `/api/health` con `uat:true`.
 *  · Firma con el MISMO secreto que usa la UAT (`scripts/uat-env.mjs`).
 *  · Todo es sintético: teléfonos 1809-000-xxxx y textos con sello de tiempo.
 *  · Devuelve código ≠ 0 si CUALQUIER aserción falla (un PROBLEMA de seguridad
 *    nunca puede quedar en EXIT=0).
 *
 * Uso:
 *   node tools/uat-whatsapp-webhook.mjs --base=http://127.0.0.1:8791
 *   node tools/uat-whatsapp-webhook.mjs --base=... --destino=PN-UAT
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [clave, ...resto] = arg.replace(/^--/, '').split('=');
    return [clave, resto.join('=')];
  }),
);

const BASE = args.get('base') ?? 'http://127.0.0.1:8791';
const USUARIO = args.get('user') ?? 'admin@uat.local';
const CLAVE = args.get('password') ?? 'UatLocal-123';
const AJENO = args.get('ajeno') ?? 'PN-AJENO-SINTETICO';

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`[webhook-uat] RECHAZADO: la base debe ser local, llegó ${BASE}`);
  process.exit(2);
}

const resultados = [];
let fallos = 0;

function comprobar(nombre, ok, detalle) {
  resultados.push({ prueba: nombre, ok, detalle });
  if (!ok) fallos += 1;
  console.log(`${ok ? 'OK   ' : 'FALLO'} · ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

const dormir = (ms) => new Promise((listo) => setTimeout(listo, ms));

async function leerConfigUat() {
  try {
    const fuente = await readFile(new URL('../scripts/uat-env.mjs', import.meta.url), 'utf8');
    return {
      secreto: fuente.match(/const SECRETO_WEBHOOK = '([^']+)'/)?.[1] ?? '',
      destino: fuente.match(/phoneNumberId: '([^']+)'/)?.[1] ?? '',
    };
  } catch {
    return { secreto: '', destino: '' };
  }
}

const config = await leerConfigUat();
const SECRETO = args.get('secreto') ?? config.secreto;
const DESTINO = args.get('destino') ?? config.destino;

if (!SECRETO || !DESTINO) {
  console.error('[webhook-uat] RECHAZADO: no se pudo leer el secreto o el número de destino de la UAT.');
  process.exit(2);
}

let cookie = '';

async function pedir(ruta, { method = 'GET', body } = {}) {
  const headers = { cookie };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(new URL(ruta, BASE), { method, headers, body: payload });
  for (const linea of res.headers.getSetCookie?.() ?? []) {
    if (linea.startsWith('pe_crm=')) cookie = linea.split(';')[0];
  }
  const texto = await res.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
  return { status: res.status, json, texto };
}

/// POST al webhook firmado como lo haría Meta.
async function webhook(payload, { firmaValida = true } = {}) {
  const cuerpo = JSON.stringify(payload);
  const firma = createHmac('sha256', SECRETO).update(Buffer.from(cuerpo)).digest('hex');
  const res = await fetch(new URL('/api/webhooks/whatsapp', BASE), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': firmaValida ? `sha256=${firma}` : `sha256=${'0'.repeat(64)}`,
    },
    body: cuerpo,
  });
  return { status: res.status };
}

function change({ destino, waId, nombre, mensajes = [], estados = [], sinMetadata = false, metadataRara = false }) {
  const metadata = sinMetadata
    ? {}
    : metadataRara
      ? { phone_number_id: { id: destino } }
      : { phone_number_id: destino, display_phone_number: '18095550999' };
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      ...(Object.keys(metadata).length ? { metadata } : {}),
      contacts: [{ wa_id: waId, profile: { name: nombre } }],
      ...(mensajes.length ? { messages: mensajes } : {}),
      ...(estados.length ? { statuses: estados } : {}),
    },
  };
}

const entrada = (waId, wamid, texto, timestamp) => ({
  from: waId,
  id: wamid,
  timestamp,
  type: 'text',
  text: { body: texto },
});

const estadoDe = (wamid, estado, waId, timestamp) => ({
  id: wamid,
  status: estado,
  recipient_id: waId,
  timestamp,
});

const cuerpo = (changes) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-uat-sintetica', changes }],
});

async function estado(telefono) {
  const digitos = String(telefono).replace(/\D/g, '');
  const aguja = digitos.slice(-7);
  const lista = await pedir(`/api/admin/conversations?filter=todos&q=${encodeURIComponent(aguja)}`);
  const filas = Array.isArray(lista.json?.conversations) ? lista.json.conversations : [];
  const conversacion = filas.find((fila) => {
    const cliente = fila.customer ?? {};
    const tel = String(cliente.phone ?? cliente.phone_e164 ?? '').replace(/\D/g, '');
    return tel.endsWith(aguja);
  });
  if (!conversacion) return { conversacion: null, mensajes: [] };
  const detalle = await pedir(`/api/admin/conversations/${encodeURIComponent(conversacion.id)}/messages`);
  return { conversacion, mensajes: Array.isArray(detalle.json?.messages) ? detalle.json.messages : [] };
}

async function esperarMensaje(telefono, texto, intentos = 24) {
  let ultimo = { conversacion: null, mensajes: [] };
  for (let i = 0; i < intentos; i += 1) {
    ultimo = await estado(telefono);
    if (ultimo.mensajes.some((m) => String(m.body ?? '') === texto)) return ultimo;
    await dormir(250);
  }
  return ultimo;
}

const cuantos = (lista, texto) => lista.filter((m) => String(m.body ?? '') === texto).length;

async function principal() {
  const salud = await fetch(new URL('/api/health', BASE)).then((r) => r.json()).catch(() => null);
  if (!salud?.ok || salud.uat !== true) {
    console.error('[webhook-uat] RECHAZADO: /api/health no dice uat:true', salud);
    process.exit(2);
  }
  comprobar('UAT aislada (uat:true, sqlite)', true, `items=${salud.items}`);
  console.log(`      destino autorizado = ${DESTINO} · destino ajeno de prueba = ${AJENO}`);

  const acceso = await pedir('/api/admin/login', { method: 'POST', body: { username: USUARIO, password: CLAVE } });
  if (acceso.status !== 200 || !acceso.json?.ok || !cookie) {
    comprobar('login del administrador de la UAT', false, `HTTP ${acceso.status}`);
    return;
  }
  comprobar('login del administrador de la UAT', true, 'cookie pe_crm');

  const sello = Date.now();
  const waId = `1809000${String(sello).slice(-4)}`;
  const nombre = `Cliente Sintético ${sello}`;
  const ahora = Math.floor(sello / 1000);
  const msg = entrada(waId, `wamid.UAT.${sello}`, `Prueba ${sello}`, ahora);

  // B1 · firma válida + destino autorizado
  const b1 = await webhook(cuerpo([change({ destino: DESTINO, waId, nombre, mensajes: [msg] })]));
  const trasB1 = await esperarMensaje(waId, msg.text.body);
  comprobar(
    'B1 mensaje autorizado persiste exactamente una vez',
    b1.status === 200 && cuantos(trasB1.mensajes, msg.text.body) === 1,
    `HTTP ${b1.status}, ${cuantos(trasB1.mensajes, msg.text.body)} mensaje(s)`,
  );
  const conversacionId = trasB1.conversacion?.id ?? null;
  comprobar(
    'B1b queda en dirección entrante y en la conversación del remitente',
    trasB1.mensajes.find((m) => m.body === msg.text.body)?.direction === 'inbound' && Boolean(conversacionId),
    `conversación=${conversacionId ?? 'n/a'}`,
  );

  // B2 · duplicado del mismo evento
  const b2 = await webhook(cuerpo([change({ destino: DESTINO, waId, nombre, mensajes: [msg] })]));
  await dormir(800);
  const trasB2 = await estado(waId);
  comprobar(
    'B2 el MISMO evento no se duplica',
    b2.status === 200 && cuantos(trasB2.mensajes, msg.text.body) === 1,
    `HTTP ${b2.status}, ${cuantos(trasB2.mensajes, msg.text.body)} mensaje(s)`,
  );

  // B3 · destino ajeno: no puede crear ni tocar nada
  const waAjeno = `1809001${String(sello).slice(-4)}`;
  const textoAjeno = `Ajeno ${sello}`;
  const b3 = await webhook(
    cuerpo([change({ destino: AJENO, waId: waAjeno, nombre: 'Intruso Sintético', mensajes: [entrada(waAjeno, `wamid.UAT.AJENO.${sello}`, textoAjeno, ahora)] })]),
  );
  await dormir(900);
  const trasB3 = await estado(waAjeno);
  comprobar(
    'B3 destino ajeno: cero cliente/conversación/mensaje',
    b3.status === 200 && trasB3.conversacion === null && trasB3.mensajes.length === 0,
    `HTTP ${b3.status}, conversación=${trasB3.conversacion?.id ?? 'ninguna'}, mensajes=${trasB3.mensajes.length}`,
  );

  // B4 · sin metadata de destino (fail-closed)
  const waSinMeta = `1809002${String(sello).slice(-4)}`;
  const b4 = await webhook(
    cuerpo([change({ destino: DESTINO, waId: waSinMeta, nombre: 'Sin metadata', mensajes: [entrada(waSinMeta, `wamid.UAT.SINMETA.${sello}`, `SinMeta ${sello}`, ahora)], sinMetadata: true })]),
  );
  await dormir(700);
  const trasB4 = await estado(waSinMeta);
  comprobar(
    'B4 evento sin metadata de destino: se descarta',
    b4.status === 200 && trasB4.conversacion === null,
    `HTTP ${b4.status}, conversación=${trasB4.conversacion?.id ?? 'ninguna'}`,
  );

  // B5 · metadata malformada
  const waRara = `1809003${String(sello).slice(-4)}`;
  const b5 = await webhook(
    cuerpo([change({ destino: DESTINO, waId: waRara, nombre: 'Metadata rara', mensajes: [entrada(waRara, `wamid.UAT.RARA.${sello}`, `Rara ${sello}`, ahora)], metadataRara: true })]),
  );
  await dormir(700);
  const trasB5 = await estado(waRara);
  comprobar(
    'B5 metadata malformada: se descarta',
    b5.status === 200 && trasB5.conversacion === null,
    `HTTP ${b5.status}, conversación=${trasB5.conversacion?.id ?? 'ninguna'}`,
  );

  // B6/B7 · mismo remitente, destino ajeno: no toca la conversación legítima
  const antesB6 = cuantos((await estado(waId)).mensajes, textoAjeno);
  const b6 = await webhook(
    cuerpo([change({ destino: AJENO, waId, nombre, mensajes: [entrada(waId, `wamid.UAT.MISMO.${sello}`, textoAjeno, ahora)] })]),
  );
  await dormir(900);
  const trasB6 = await estado(waId);
  comprobar(
    'B6 mismo remitente con destino ajeno: no se asocia a la conversación propia',
    b6.status === 200 && cuantos(trasB6.mensajes, textoAjeno) === antesB6,
    `HTTP ${b6.status}, ${cuantos(trasB6.mensajes, textoAjeno)} mensaje(s) ajenos en la conversación propia`,
  );
  comprobar(
    'B7 las dos conversaciones siguen aisladas por destino',
    trasB6.conversacion?.id === conversacionId && cuantos(trasB6.mensajes, msg.text.body) === 1,
    `legítima=${conversacionId}`,
  );

  // B8 · estado del destino autorizado
  const b8 = await webhook(
    cuerpo([change({ destino: DESTINO, waId, nombre, estados: [estadoDe(msg.id, 'delivered', waId, ahora + 1)] })]),
  );
  await dormir(500);
  const trasB8 = await estado(waId);
  comprobar(
    'B8 estado autorizado aceptado sin crear mensajes',
    b8.status === 200 && trasB8.mensajes.length === trasB6.mensajes.length,
    `HTTP ${b8.status}, ${trasB6.mensajes.length} → ${trasB8.mensajes.length}`,
  );

  // B9 · estado con destino ajeno: no puede mutar el mensaje propio
  const estadoAntes = trasB8.mensajes.find((m) => m.body === msg.text.body)?.status ?? null;
  const b9 = await webhook(
    cuerpo([change({ destino: AJENO, waId, nombre, estados: [estadoDe(msg.id, 'read', waId, ahora + 2)] })]),
  );
  await dormir(700);
  const trasB9 = await estado(waId);
  const estadoDespues = trasB9.mensajes.find((m) => m.body === msg.text.body)?.status ?? null;
  comprobar(
    'B9 estado con destino ajeno: no muta el mensaje propio',
    b9.status === 200 && estadoAntes === estadoDespues && trasB9.mensajes.length === trasB8.mensajes.length,
    `status ${estadoAntes} → ${estadoDespues}`,
  );

  // B10 · estado duplicado (idempotente)
  await webhook(cuerpo([change({ destino: DESTINO, waId, nombre, estados: [estadoDe(msg.id, 'delivered', waId, ahora + 1)] })]));
  await dormir(600);
  const trasB10 = await estado(waId);
  comprobar(
    'B10 estado duplicado: sin transición ni mensaje nuevo',
    trasB10.mensajes.length === trasB9.mensajes.length,
    `${trasB9.mensajes.length} → ${trasB10.mensajes.length}`,
  );

  // B11 · estados fuera de orden: el servidor decide, no crea mensajes
  const b11 = await webhook(
    cuerpo([change({ destino: DESTINO, waId, nombre, estados: [estadoDe(msg.id, 'sent', waId, ahora - 5)] })]),
  );
  await dormir(500);
  const trasB11 = await estado(waId);
  comprobar(
    'B11 estado fuera de orden no crea mensajes',
    b11.status === 200 && trasB11.mensajes.length === trasB10.mensajes.length,
    `HTTP ${b11.status}`,
  );

  // B12 · firma inválida
  const waFirma = `1809004${String(sello).slice(-4)}`;
  const b12 = await webhook(
    cuerpo([change({ destino: DESTINO, waId: waFirma, nombre: 'Firma mala', mensajes: [entrada(waFirma, `wamid.UAT.FIRMA.${sello}`, `Firma ${sello}`, ahora)] })]),
    { firmaValida: false },
  );
  await dormir(600);
  const trasB12 = await estado(waFirma);
  comprobar(
    'B12 firma inválida: 401 y cero mutación',
    b12.status === 401 && trasB12.conversacion === null,
    `HTTP ${b12.status}`,
  );

  // B13 · lote con dos destinos en el mismo cuerpo
  const waLote = `1809005${String(sello).slice(-4)}`;
  const textoLoteOk = `Lote ok ${sello}`;
  const textoLoteAjeno = `Lote ajeno ${sello}`;
  const b13 = await webhook(
    cuerpo([
      change({ destino: DESTINO, waId: waLote, nombre: 'Lote', mensajes: [entrada(waLote, `wamid.UAT.LOTE.OK.${sello}`, textoLoteOk, ahora)] }),
      change({ destino: AJENO, waId: waLote, nombre: 'Lote', mensajes: [entrada(waLote, `wamid.UAT.LOTE.AJENO.${sello}`, textoLoteAjeno, ahora)] }),
    ]),
  );
  const trasB13 = await esperarMensaje(waLote, textoLoteOk);
  comprobar(
    'B13 lote mixto: entra solo el evento del destino autorizado',
    b13.status === 200 && cuantos(trasB13.mensajes, textoLoteOk) === 1 && cuantos(trasB13.mensajes, textoLoteAjeno) === 0,
    `ok=${cuantos(trasB13.mensajes, textoLoteOk)}, ajenos=${cuantos(trasB13.mensajes, textoLoteAjeno)}`,
  );

  // B14 · lectura sin sesión
  const sinSesion = await fetch(new URL(`/api/admin/conversations/${encodeURIComponent(conversacionId ?? 'cnv_x')}/messages`, BASE));
  comprobar('B14 sin sesión no se leen mensajes', sinSesion.status === 401 || sinSesion.status === 403, `HTTP ${sinSesion.status}`);

  // B15 · conversación inexistente / ajena: no revela datos
  const inexistente = await pedir('/api/admin/conversations/cnv_no_existe_uat/messages');
  comprobar(
    'B15 conversación inexistente no revela datos',
    [403, 404].includes(inexistente.status) && !inexistente.json?.messages?.length,
    `HTTP ${inexistente.status}`,
  );

  // B18 · la bandeja sigue mostrando el mensaje válido una sola vez
  const final = await estado(waId);
  comprobar(
    'B18 el mensaje válido sigue en la bandeja, una sola vez',
    cuantos(final.mensajes, msg.text.body) === 1,
    `${cuantos(final.mensajes, msg.text.body)} mensaje(s)`,
  );

  // ---------------------------------------------------------------- FASE C
  // Salida de texto por el transporte MOCK con clave de operación.
  const salida = `Salida ${sello}`;
  const clave = `wa_out_${sello}`;
  const enviarSalida = (operationKey) =>
    fetch(new URL(`/api/admin/conversations/${encodeURIComponent(conversacionId)}/messages`, BASE), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-fulltech-operation': operationKey },
      body: JSON.stringify({ body: salida }),
    });

  const c1 = await enviarSalida(clave);
  await dormir(700);
  const trasC1 = await estado(waId);
  comprobar(
    'C1 mensaje saliente: se persiste exactamente uno',
    [200, 201, 202].includes(c1.status) && cuantos(trasC1.mensajes, salida) === 1,
    `HTTP ${c1.status}, ${cuantos(trasC1.mensajes, salida)} mensaje(s)`,
  );
  comprobar(
    'C1b el saliente queda en dirección outbound en la misma conversación',
    trasC1.mensajes.find((m) => m.body === salida)?.direction === 'outbound',
    `direction=${trasC1.mensajes.find((m) => m.body === salida)?.direction ?? 'n/a'}`,
  );

  // C2 · misma clave: no se duplica
  const c2 = await enviarSalida(clave);
  await dormir(700);
  const trasC2 = await estado(waId);
  comprobar(
    'C2 reintento con la MISMA clave no crea un segundo mensaje',
    [200, 201, 202].includes(c2.status) && cuantos(trasC2.mensajes, salida) === 1,
    `HTTP ${c2.status}, ${cuantos(trasC2.mensajes, salida)} mensaje(s)`,
  );

  // C3 · clave distinta: es otro envío lógico y sí se registra
  const c3 = await enviarSalida(`${clave}_b`);
  await dormir(700);
  const trasC3 = await estado(waId);
  comprobar(
    'C3 con clave distinta el envío es otro y se registra',
    [200, 201, 202].includes(c3.status) && cuantos(trasC3.mensajes, salida) === 2,
    `HTTP ${c3.status}, ${cuantos(trasC3.mensajes, salida)} mensaje(s)`,
  );

  // C4 · sin sesión no se puede enviar a la conversación
  const c4 = await fetch(new URL(`/api/admin/conversations/${encodeURIComponent(conversacionId)}/messages`, BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'sin sesion' }),
  });
  comprobar('C4 sin sesión no se puede enviar', c4.status === 401 || c4.status === 403, `HTTP ${c4.status}`);

  console.log(
    '\nRESUMEN',
    JSON.stringify(
      { base: BASE, destino: DESTINO, ajeno: AJENO, waId, conversacionId, pruebas: resultados.length, fallos },
      null,
      2,
    ),
  );
  process.exitCode = fallos === 0 ? 0 : 1;
}

principal().catch((error) => {
  console.error('[webhook-uat] error inesperado:', error?.message ?? error);
  process.exitCode = 1;
});
