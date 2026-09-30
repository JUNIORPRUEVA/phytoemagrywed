// Sonda: prueba el media store sobre SQLite con el adaptador del CRM.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSqlQuery } from '../../server/sql-query.mjs';
import { createMediaStore, MEDIA_STATUS, SEND_STATUS } from '../../server/media.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-media-'));
const db = new DatabaseSync(path.join(dir, 'probe.sqlite'));
const sql = createSqlQuery({ backend: 'sqlite', handle: db });
const store = createMediaStore(sql);

await store.ensure();
console.log('tabla creada');

const created = await store.create({
  messageId: 'msg_1',
  mediaType: 'image',
  direction: 'inbound',
  status: MEDIA_STATUS.PENDING,
});
console.log('create →', created.ok, created.duplicate, created.media?.id);

const updated = await store.update(created.media.id, { status: MEDIA_STATUS.STORED, objectKey: 'k/1.png', sizeBytes: 12 });
console.log('update →', updated.ok, updated.media?.status);

const saliente = await store.create({
  messageId: 'out_1',
  mediaType: 'image',
  direction: 'outbound',
  status: MEDIA_STATUS.UPLOADING,
  sendStatus: SEND_STATUS.PREPARING,
  idempotencyKey: 'key-1',
});
console.log('create saliente →', saliente.ok, saliente.media?.id);

const porClave = await store.byIdempotencyKey('key-1');
console.log('byIdempotencyKey →', porClave?.id);

const repetido = await store.create({
  messageId: 'out_2',
  mediaType: 'image',
  direction: 'outbound',
  status: MEDIA_STATUS.UPLOADING,
  idempotencyKey: 'key-1',
});
console.log('create repetido →', repetido.ok, repetido.duplicate, repetido.media?.id);

const lote = await store.byMessageIds(['msg_1', 'out_1']);
console.log('byMessageIds →', lote.length);

const fallo = await store.recordFailure(created.media.id, { provider: 'r2', operation: 'put', safeCode: 'storage_failed', httpStatus: 502 });
console.log('recordFailure →', fallo.ok, fallo.media?.status, fallo.media?.safe_code);

const enRevision = await store.listBySendStatus(SEND_STATUS.SEND_UNKNOWN, 5);
const porEstado = await store.listByStatus(MEDIA_STATUS.STORED, 5);
console.log('listas →', enRevision.length, porEstado.length);
console.log('OK');
