// @vitest-environment node
/**
 * EXPEDIENTE DE DOCUMENTOS DEL REPARTIDOR.
 *
 * Lo que se fija aquí es lo que no puede fallar:
 *   · sin el recibo de la solicitud no se sube ni se lista nada,
 *   · se valida el CONTENIDO real (renombrar un ejecutable no lo convierte en PDF),
 *   · el binario no se sirve nunca desde una ruta pública ni con la ruta de disco,
 *   · solo la central revisa y descarga,
 *   · se piden únicamente los documentos que aplican al vehículo,
 *   · reemplazar un documento no deja dos vigentes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'courier-docs-uat';
// PNG de 1×1 transparente (cabecera real, no un texto con extensión .png).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
// Cabecera de ejecutable Windows: no debe aceptarse aunque se llame «licencia.pdf».
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]).toString('base64');

let app; let dir; let admin; let operador; let applicationId; let receipt;

const login = async (body) => {
  const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
};
const adminCall = async (route, { cookie = admin, method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, { method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const upload = async (payload) => {
  const response = await fetch(`${app.url}/api/courier/applications/${applicationId}/documents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-courier-docs-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'docs.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  admin = await login({ token: TOKEN });
  const created = await adminCall('users', { method: 'POST', body: {
    username: 'oficina-docs', displayName: 'Oficina Docs', role: 'OPERADOR', password: 'Oficina-Uat-123' } });
  expect(created.status).toBe(201);
  operador = await login({ username: 'oficina-docs', password: 'Oficina-Uat-123' });
  const applied = await fetch(`${app.url}/api/courier/applications`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: 'phytoemagry',
      name: 'Repartidor Docs', phone: '+18095560001', vehicleType: 'MOTO',
      zone: 'Zona Docs', termsAccepted: true }) });
  expect(applied.status).toBe(202);
  const data = await applied.json();
  applicationId = data.applicationId;
  receipt = data.receipt;
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('expediente de documentos', () => {
  it('pide solo lo que aplica al vehículo y no entrega binarios en el JSON', async () => {
    const listed = await fetch(`${app.url}/api/courier/applications/${applicationId}/documents?receipt=${receipt}`);
    expect(listed.status).toBe(200);
    const body = await listed.json();
    // MOTO: identidad y documento del vehículo. La licencia es solo para carro.
    expect(body.vehicle_type).toBe('MOTO');
    expect(body.required).toEqual(['IDENTITY', 'VEHICLE']);
    expect(body.missing).toEqual(['IDENTITY', 'VEHICLE']);
    expect(body.operational_access).toBe(false);

    const subido = await upload({ receipt, kind: 'IDENTITY', dataBase64: PNG });
    expect(subido.status).toBe(201);
    expect(subido.data.document.kind).toBe('IDENTITY');
    expect(subido.data.document).not.toHaveProperty('file');
    expect(subido.data.missing).toEqual(['VEHICLE']);
  });

  it('rechaza ejecutables y archivos demasiado grandes aunque se disfracen', async () => {
    const exe = await upload({ receipt, kind: 'IDENTITY', dataBase64: EXE });
    expect(exe.status).toBe(422);
    expect(exe.data.error).toBe('unsupported_type');
    const grande = Buffer.alloc(4 * 1024 * 1024 + 8);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(grande);
    const tooBig = await upload({ receipt, kind: 'IDENTITY', dataBase64: grande.toString('base64') });
    expect([413, 422]).toContain(tooBig.status);
    expect(['too_large', 'missing_content']).toContain(tooBig.data.error);
    // Nada de lo rechazado quedó registrado.
    expect(((await app.ctx.db.list('courier_documents', { limit: 10 })) ?? []).length).toBe(0);
  });

  it('sin recibo no se sube ni se lista; una solicitud cerrada no admite documentos', async () => {
    expect((await upload({ kind: 'IDENTITY', dataBase64: PNG })).status).toBe(404);
    expect((await upload({ receipt: 'otro', kind: 'IDENTITY', dataBase64: PNG })).status).toBe(404);
    const listed = await fetch(`${app.url}/api/courier/applications/${applicationId}/documents`);
    expect(listed.status).toBe(404);
    // Cerrar la solicitud (rechazo) impide seguir subiendo.
    await adminCall(`courier-applications/${applicationId}/review`, { method: 'POST',
      body: { companyId: 'phytoemagry', decision: 'rejected', note: 'Prueba' } });
    expect((await upload({ receipt, kind: 'IDENTITY', dataBase64: PNG })).status).toBe(409);
  });

  it('la revisión y la descarga son solo de la central y quedan auditadas', async () => {
    const subido = await upload({ receipt, kind: 'DRIVING_LICENSE', dataBase64: PDF });
    expect(subido.status).toBe(201);
    const docId = subido.data.document.id;
    expect((await adminCall(`courier-applications/${applicationId}/documents`, { cookie: operador })).status).toBe(403);
    expect((await adminCall(`courier-documents/${docId}/file`, { cookie: operador })).status).toBe(403);
    const listado = await adminCall(`courier-applications/${applicationId}/documents`);
    expect(listado.status).toBe(200);
    expect(listado.data.documents.map((row) => row.kind)).toEqual(['DRIVING_LICENSE']);
    expect(listado.data.documents[0]).not.toHaveProperty('file');
    const file = await fetch(`${app.url}/api/admin/courier-documents/${docId}/file`, { headers: { cookie: admin } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('cache-control')).toContain('no-store');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    const reviewed = await adminCall(`courier-documents/${docId}/review`, { method: 'POST',
      body: { decision: 'replacement', note: 'Se ve borroso' } });
    expect(reviewed.status).toBe(200);
    const audit = await app.ctx.audit.list({ entity: 'courier_document', entityId: docId, limit: 20 });
    expect(audit.some((row) => row.action === 'courier.document_replacement')).toBe(true);
  });

  it('reemplazar deja un solo documento vigente por tipo', async () => {
    const first = await upload({ receipt, kind: 'IDENTITY', dataBase64: PNG });
    const second = await upload({ receipt, kind: 'IDENTITY', dataBase64: PDF });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const vigentes = ((await app.ctx.db.list('courier_documents', { limit: 20 })) ?? [])
      .filter((row) => row.application_id === applicationId && row.kind === 'IDENTITY' && row.status !== 'replaced');
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0].id).toBe(second.data.document.id);
  });

  it('un vehículo sin motor no exige licencia ni papeles del vehículo', async () => {
    const applied = await fetch(`${app.url}/api/courier/applications`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: 'phytoemagry',
        name: 'Repartidor Bici', phone: '+18095560002', vehicleType: 'BICICLETA',
        zone: 'Zona Docs', termsAccepted: true }) });
    const data = await applied.json();
    const listed = await fetch(`${app.url}/api/courier/applications/${data.applicationId}/documents?receipt=${data.receipt}`);
    const body = await listed.json();
    expect(body.required).toEqual(['IDENTITY']);
    expect(body.missing).toEqual(['IDENTITY']);
  });
});
