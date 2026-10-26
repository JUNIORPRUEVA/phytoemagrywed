/*
 * BACKEND UAT HTTPS PARA TELÉFONO FÍSICO (misma red local).
 *
 * Qué hace:
 *   · Arranca el CRM UAT aislado (SQLite temporal, sin WhatsApp, sin Meta).
 *   · Publica un proxy HTTPS en la interfaz indicada (por defecto todas) para que
 *     un teléfono de la misma Wi-Fi pueda llegar.
 *   · Comprueba el certificado ANTES de arrancar: que exista, que esté vigente y
 *     que cubra por SAN la IP/host que se va a usar. Si no lo cubre, avisa y no
 *     promete compatibilidad.
 *
 * Qué NO hace:
 *   · No expone PostgreSQL (no hay PostgreSQL: es SQLite temporal).
 *   · No toca producción ni lee ninguna URL productiva.
 *   · No abre puertos en el router: solo escucha en la LAN.
 *   · No desactiva TLS ni acepta certificados arbitrarios.
 *
 * Uso:
 *   $env:FULLTECH_UAT_TLS_KEY='C:\uat\lan-key.pem'
 *   $env:FULLTECH_UAT_TLS_CERT='C:\uat\lan-cert.pem'
 *   node scripts/uat-https-lan.mjs            # arranca
 *   node scripts/uat-https-lan.mjs --check    # solo valida certificado y red
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

const checkOnly = process.argv.includes('--check');
const keyPath = process.env.FULLTECH_UAT_TLS_KEY;
const certPath = process.env.FULLTECH_UAT_TLS_CERT;
const bindHost = process.env.FULLTECH_UAT_BIND ?? '0.0.0.0';
const port = Number(process.env.FULLTECH_UAT_PORT ?? 8443);
/* Token del panel SOLO para este arnés: no es una credencial de producción. */
const panelToken = process.env.FULLTECH_UAT_TOKEN ?? 'lan-uat-only';

if (!keyPath || !certPath) {
  process.stderr.write('Faltan FULLTECH_UAT_TLS_KEY / FULLTECH_UAT_TLS_CERT\n');
  process.exit(2);
}

/** IPv4 de la LAN (descarta loopback y adaptadores virtuales habituales). */
function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (/^(vEthernet|VirtualBox|VMware|Loopback|docker|br-)/i.test(name)) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

let certificate;
let key;
try {
  certificate = new X509Certificate(readFileSync(certPath));
  key = readFileSync(keyPath);
} catch (error) {
  process.stderr.write(`No se pudo leer el certificado o la clave: ${error.message}\n`);
  process.exit(2);
}

const validFrom = Date.parse(certificate.validFrom);
const validTo = Date.parse(certificate.validTo);
const now = Date.now();
const fingerprint = certificate.fingerprint256;
const san = String(certificate.subjectAltName ?? '');

const addresses = lanAddresses();
const covered = addresses.filter(({ address }) => san.includes(`IP Address:${address}`) || san.includes(`IPAddress:${address}`));

console.log('CERT_SUBJECT', certificate.subject.replace(/\n/g, ' '));
console.log('CERT_SAN', san || '(sin SAN)');
console.log('CERT_VALID_FROM', new Date(validFrom).toISOString());
console.log('CERT_VALID_TO', new Date(validTo).toISOString());
console.log('CERT_SHA256', fingerprint);
console.log('LAN_ADDRESSES', addresses.map(({ name, address }) => `${name}=${address}`).join(' ') || '(ninguna)');
console.log('LAN_COVERED_BY_CERT', covered.map((row) => row.address).join(' ') || '(ninguna)');

if (now < validFrom || now > validTo) {
  process.stderr.write('El certificado no está vigente ahora mismo: el teléfono lo rechazará.\n');
  process.exit(3);
}
if (!covered.length) {
  process.stderr.write(
    'AVISO: el certificado no cubre ninguna IP de la LAN por SAN. Genera uno con ' +
    'subjectAltName=IP:<ip> antes de usarlo en un teléfono físico.\n',
  );
  if (checkOnly) process.exit(4);
}
if (checkOnly) {
  console.log('LAN_UAT_CHECK_OK');
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), 'fulltech-lan-uat-'));
const crm = await startCrmServer({
  port: 0,
  host: '127.0.0.1',
  dataFile: join(directory, 'logistics.sqlite'),
  token: panelToken,
  quiet: true,
  schedulerEnabled: false,
  whatsapp: { enabled: false },
  metaCapi: { enabled: false },
});
const target = new URL(crm.url);
const server = createHttpsServer({ key, cert: readFileSync(certPath) }, (req, res) => {
  const upstream = httpRequest(
    { host: '127.0.0.1', port: Number(target.port), path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, bindHost, resolve);
});

const urls = (covered.length ? covered : addresses).map((row) => `https://${row.address}:${port}`);
console.log('LAN_UAT_URLS', urls.join(' ') || `https://<ip-lan>:${port}`);
console.log('LAN_UAT_SQLITE', directory);
console.log('LAN_UAT_STATE isolated-sqlite no-production no-whatsapp');
process.stdout.write(
  `\nCompila la APK con:\n  flutter build apk --debug --dart-define=DELIVERY_ENV=uat ` +
  `--dart-define=DELIVERY_API_BASE_URL=${urls[0] ?? `https://<ip-lan>:${port}`} ` +
  `--dart-define=DELIVERY_DEMO_DATA=false\n\n`,
);

const shutdown = async () => {
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
  await crm.close().catch(() => {});
};
process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
