// Disposable local HTTPS CRM for Android emulator UAT. Never reads production URLs.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { startCrmServer } from '../server/crm-server.mjs';

const keyPath = process.env.FULLTECH_UAT_TLS_KEY;
const certPath = process.env.FULLTECH_UAT_TLS_CERT;
if (!keyPath || !certPath) throw new Error('UAT TLS certificate paths are required');
const directory = mkdtempSync(join(tmpdir(), 'fulltech-android-uat-'));
const crm = await startCrmServer({ port: 0, host: '127.0.0.1',
  dataFile: join(directory, 'logistics.sqlite'), token: 'android-uat-only',
  quiet: true, schedulerEnabled: false, whatsapp: { enabled: false },
  metaCapi: { enabled: false } });
const target = new URL(crm.url);
const server = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const upstream = httpRequest({ host: '127.0.0.1', port: Number(target.port),
      path: req.url, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
await new Promise((resolve) => server.listen(8443, '127.0.0.1', resolve));
process.stdout.write('FULLTECH_ANDROID_UAT_HTTPS https://10.0.2.2:8443 isolated-sqlite no-real-accounts\n');
const shutdown = async () => { await new Promise((resolve) => server.close(resolve)); await crm.close(); };
process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
