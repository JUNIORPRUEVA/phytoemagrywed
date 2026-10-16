#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createCallingDiagnostics } from '../server/whatsapp-calling.mjs';

// Solo formato KEY=value de una línea. No ejecuta ni expande el archivo.
export function parseCallingEnv(source) {
  const env = Object.create(null);
  for (const line of String(source).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!/^(WHATSAPP_|META_APP_|PHYTO_META_GRAPH_VERSION$)/.test(key)) continue;
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    if (quoted && (raw.length < 2 || raw.at(-1) !== raw[0])) throw new Error('invalid_env_format');
    env[key] = quoted ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, '').trim();
  }
  return env;
}

export async function checkCalling({ env = {}, online = false, fetchImpl } = {}) {
  const client = createCallingDiagnostics({ env, fetchImpl });
  const configuration = client.configuration();
  const report = { mode: online ? 'read_only_online' : 'local', configuration };
  if (!online || !configuration.configured) return report;
  // Secuencial: son pocas consultas y no hace falta presionar la API de Meta.
  report.settings = await client.settings();
  report.subscriptions = await client.subscriptions();
  return report;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      'env-file': { type: 'string' },
      online: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    } }));
  } catch {
    console.error('Opciones inválidas. Usa --help.');
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log('Uso: node scripts/check-whatsapp-calling.mjs [--env-file archivo] [--online]\nSin --online no usa la red. Con --online solo consulta GET /settings, GET /subscribed_apps y, si hay app secret, GET /subscriptions.\nNo activa llamadas, no envía mensajes y no modifica bases de datos.');
    return;
  }
  let fileEnv = {};
  if (values['env-file']) {
    try { fileEnv = parseCallingEnv(await readFile(values['env-file'], 'utf8')); }
    catch {
      console.error('No se pudo leer el archivo de entorno o su formato no es válido.');
      process.exitCode = 1;
      return;
    }
  }
  const report = await checkCalling({ env: { ...fileEnv, ...process.env }, online: values.online });
  console.log(JSON.stringify(report, null, 2));
  if (!report.configuration.configured || (values.online && (!report.settings?.ok || !report.subscriptions?.ok))) process.exitCode = 1;
  // Código 2: diagnóstico válido, pero todavía faltan condiciones verificables.
  else if (values.online && (report.settings.blockers.length || !report.subscriptions.currentAppSubscribed || !report.subscriptions.callsFieldVerified)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('No se pudo completar el diagnóstico.'); process.exitCode = 1; });
}
