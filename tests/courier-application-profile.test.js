// @vitest-environment node
/**
 * PERFIL AMPLIADO DEL SOLICITANTE — reglas y persistencia real.
 *
 * Dos capas:
 *   1. Unitarias del módulo (fechas imposibles, edad mínima, correo, placas).
 *   2. HTTP contra el servidor de verdad: un alta con perfil se guarda completa
 *      y el panel la recibe tal cual; un alta con fecha imposible se rechaza.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import {
  ageOn,
  parseIsoDate,
  readApplicationProfile,
  validatePersonal,
  validateVehicle,
} from '../server/courier-application-profile.mjs';

const TOKEN = 'courier-profile-uat';

let app; let dir; let cookie;

const post = async (body) => {
  const response = await fetch(`${app.url}/api/courier/applications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const adminList = async () => {
  const response = await fetch(`${app.url}/api/admin/courier-applications`, { headers: { cookie } });
  return (await response.json()).applications ?? [];
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-courier-profile-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'p.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false, whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('reglas del perfil', () => {
  it('rechaza fechas imposibles pero acepta el 29 de febrero de un bisiesto', () => {
    expect(parseIsoDate('1995-02-30')).toBeNull();
    expect(parseIsoDate('1995-13-01')).toBeNull();
    expect(parseIsoDate('29/01/1995')).toBeNull();
    expect(parseIsoDate('1996-02-29')).toBeInstanceOf(Date);
    expect(parseIsoDate('1995-02-29')).toBeNull();
    expect(parseIsoDate('1995-01-31')).toBeInstanceOf(Date);
  });

  it('calcula la edad cumplida, no la del año', () => {
    const birth = parseIsoDate('2008-12-31');
    expect(ageOn(birth, new Date('2026-10-25T12:00:00Z'))).toBe(17);
    expect(ageOn(birth, new Date('2027-01-01T12:00:00Z'))).toBe(18);
  });

  it('aplica la edad mínima configurable', () => {
    const personal = {
      id_type: 'CEDULA', id_number: '402-1234567-8', birth_date: '2010-05-04',
      email: 'ok@ejemplo.do', province: 'Santo Domingo', municipality: 'Este',
      address: 'Calle 1 #2', emergency_name: 'Madre', emergency_phone: '+18095550000',
    };
    expect(validatePersonal(personal, { now: new Date('2026-10-25T12:00:00Z') })).toBe('underage');
    expect(validatePersonal(personal, { minAge: 16, now: new Date('2026-10-25T12:00:00Z') })).toBeNull();
  });

  it('detecta correo y teléfono de emergencia inválidos', () => {
    expect(validatePersonal({ email: 'sin-arroba' })).toBe('invalid_email');
    expect(validatePersonal({ emergency_phone: '123' })).toBe('invalid_emergency_phone');
    expect(validatePersonal({ id_type: 'RUC' })).toBe('invalid_id_type');
    expect(validatePersonal({})).toBeNull();
  });

  it('el vehículo se valida según el tipo elegido', () => {
    expect(validateVehicle({ make: 'Honda', model: 'CB125', plate: 'AB123C' }, 'MOTO')).toBeNull();
    expect(validateVehicle({}, 'MOTO')).toBe('invalid_vehicle_make');
    expect(validateVehicle({ make: 'Honda', model: 'X' }, 'CARRO')).toBeNull();
    // La bicicleta no pide matrícula ni marca.
    expect(validateVehicle({ bicycle_type: 'URBANA' }, 'BICICLETA')).toBeNull();
    expect(validateVehicle({ bicycle_type: 'COHETE' }, 'BICICLETA')).toBe('invalid_bicycle_type');
  });

  it('readApplicationProfile arma los bloques y señala el campo con error', () => {
    const ok = readApplicationProfile({
      personal: { birthDate: '1995-01-31', email: 'A@B.DO', idType: 'cedula' },
      vehicleDetail: { make: 'Honda', model: 'CB125', plate: 'ab123c' },
      availability: { availability: 'Fines de semana', schedule: 'Mañana' },
    }, { vehicleType: 'MOTO' });
    expect(ok.error).toBeUndefined();
    expect(ok.profile.id_type).toBe('CEDULA');
    expect(ok.profile.email).toBe('a@b.do');
    expect(ok.vehicle.plate).toBe('AB123C');

    const bad = readApplicationProfile({ personal: { birthDate: '2015-01-01' } }, { vehicleType: 'MOTO' });
    expect(bad.error).toBe('underage');
    expect(bad.field).toBe('personal');

    const legacy = readApplicationProfile({}, { vehicleType: 'MOTO' });
    expect(legacy.error).toBeUndefined();
    expect(legacy.profile).toBeNull();
  });
});

describe('alta ampliada contra el servidor', () => {
  it('guarda el perfil completo y el panel lo recibe', async () => {
    const created = await post({
      companyId: 'phytoemagry', name: 'Ana Pérez', phone: '+18095550123',
      vehicleType: 'CARRO', zone: 'Distrito Nacional', termsAccepted: true,
      personal: { idType: 'CEDULA', idNumber: '402-0000001-1', birthDate: '1994-03-12',
        email: 'ana@ejemplo.do', province: 'Santo Domingo', municipality: 'Este',
        address: 'Av. Siempre Viva 742', emergencyName: 'Luis Pérez', emergencyPhone: '+18095550124' },
      vehicleDetail: { make: 'Toyota', model: 'Corolla', plate: 'A123456' },
      availability: { province: 'Santo Domingo', municipality: 'Este', zone: 'Distrito Nacional',
        availability: 'Tiempo completo', experience: '2 años en moto', schedule: 'Lunes a viernes' },
      policy: { version: '2026-10', acceptedAt: new Date().toISOString() },
    });
    expect(created.status).toBe(202);

    const rows = await adminList();
    const row = rows.find((item) => item.id === created.data.applicationId);
    expect(row).toBeTruthy();
    expect(row.profile.birth_date).toBe('1994-03-12');
    expect(row.profile.email).toBe('ana@ejemplo.do');
    expect(row.vehicle_detail.make).toBe('Toyota');
    expect(row.availability.availability).toBe('Tiempo completo');
    expect(row.policy.version).toBe('2026-10');
    // El recibo no se reparte en el listado del panel.
    expect(row.receipt).toBeTruthy();
  });

  it('rechaza un alta con fecha imposible o menor de edad', async () => {
    const bad = await post({
      companyId: 'phytoemagry', name: 'Menor de Edad', phone: '+18095550199',
      vehicleType: 'MOTO', zone: 'Santiago', termsAccepted: true,
      personal: { birthDate: '2014-06-01', email: 'x@ejemplo.do' },
    });
    expect(bad.status).toBe(422);
    expect(bad.data.error).toBe('underage');
    expect(bad.data.field).toBe('personal');
  });

  it('un cliente antiguo (sin bloques nuevos) sigue funcionando', async () => {
    const legacy = await post({
      companyId: 'phytoemagry', name: 'Cliente Antiguo', phone: '+18095550150',
      vehicleType: 'BICICLETA', zone: 'Santiago', termsAccepted: true,
    });
    expect(legacy.status).toBe(202);
    const rows = await adminList();
    const row = rows.find((item) => item.id === legacy.data.applicationId);
    expect(row.profile).toBeNull();
    expect(row.vehicle_type).toBe('BICICLETA');
  });
});
