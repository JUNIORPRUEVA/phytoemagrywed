/**
 * PERFIL DEL SOLICITANTE DE REPARTIDOR.
 *
 * Qué hace: normaliza y valida los datos que la app de onboarding recoge en
 * varios pasos (personales, vehículo y disponibilidad) para que la oficina
 * pueda revisar la solicitud COMPLETA sin pedir nada por teléfono.
 *
 * Reglas:
 *   - NADA se guarda en claro que no se haya validado antes. Los errores salen
 *     con código estable (`invalid_email`, `underage`, …) para que la app pueda
 *     señalar el campo exacto.
 *   - La edad mínima es CONFIGURABLE por argumento: el valor por defecto es una
 *     política del producto, no una afirmación legal.
 *   - No se inventan requisitos legales: los documentos siguen dependiendo del
 *     vehículo y viven en `courier-documents.mjs`.
 *   - Compatibilidad: un cliente antiguo que solo envíe nombre, teléfono,
 *     vehículo, zona y condiciones sigue funcionando (los bloques nuevos son
 *     opcionales). Si un bloque viene, se valida entero.
 */

/** Política del producto por defecto. Configurable en la llamada. */
export const MIN_APPLICANT_AGE = 18;

/** Tipos de identificación aceptados (etiquetas, no números de documento). */
export const ID_TYPES = Object.freeze(['CEDULA', 'PASAPORTE']);

/** Tipos de bicicleta aceptados. */
export const BICYCLE_TYPES = Object.freeze(['URBANA', 'MONTAÑA', 'ELÉCTRICA', 'CARGA']);

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function text(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `YYYY-MM-DD` real (no acepta 31 de febrero ni fechas del futuro lejano). */
export function parseIsoDate(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > MONTH_DAYS[month - 1]) return null;
  if (month === 2 && day === 29 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Años cumplidos a la fecha de referencia (`now` inyectable para pruebas). */
export function ageOn(birthDate, now = new Date()) {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birthDate.getUTCMonth() ||
    (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Normaliza el bloque de datos personales (sin validar). */
export function parsePersonal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id_type: text(raw.idType ?? raw.id_type, 20).toUpperCase(),
    id_number: text(raw.idNumber ?? raw.id_number, 30),
    birth_date: text(raw.birthDate ?? raw.birth_date, 10),
    email: text(raw.email, 120).toLowerCase(),
    province: text(raw.province ?? raw.provincia, 60),
    municipality: text(raw.municipality ?? raw.municipio, 60),
    address: text(raw.address ?? raw.direccion, 160),
    emergency_name: text(raw.emergencyName ?? raw.emergency_name, 80),
    emergency_phone: text(raw.emergencyPhone ?? raw.emergency_phone, 24),
  };
}

/** Normaliza el bloque del vehículo (sin validar contra el tipo). */
export function parseVehicle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    make: text(raw.make ?? raw.marca, 40),
    model: text(raw.model ?? raw.modelo, 40),
    plate: text(raw.plate ?? raw.placa, 16).toUpperCase(),
    bicycle_type: text(raw.bicycleType ?? raw.bicycle_type, 20).toUpperCase(),
  };
}

/** Normaliza el bloque de disponibilidad (sin validar). */
export function parseAvailability(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    province: text(raw.province ?? raw.provincia, 60),
    municipality: text(raw.municipality ?? raw.municipio, 60),
    zone: text(raw.zone ?? raw.zone_name, 80),
    availability: text(raw.availability ?? raw.disponibilidad, 40),
    experience: text(raw.experience ?? raw.experiencia, 160),
    schedule: text(raw.schedule ?? raw.horario, 80),
  };
}

/** `null` si el bloque personal está bien; si no, el código del primer error. */
export function validatePersonal(personal, { minAge = MIN_APPLICANT_AGE, now = new Date() } = {}) {
  if (personal.id_type && !ID_TYPES.includes(personal.id_type)) return 'invalid_id_type';
  if (personal.id_number && personal.id_number.replace(/[^0-9A-Za-z-]/g, '').length < 5) return 'invalid_id_number';
  if (personal.birth_date) {
    const birth = parseIsoDate(personal.birth_date);
    if (!birth) return 'invalid_birth_date';
    const age = ageOn(birth, now);
    if (age < minAge) return 'underage';
    if (age > 100) return 'invalid_birth_date';
  }
  if (personal.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(personal.email)) return 'invalid_email';
  if (personal.emergency_phone && personal.emergency_phone.replace(/[^0-9]/g, '').length < 7) {
    return 'invalid_emergency_phone';
  }
  return null;
}

/** `null` si el bloque del vehículo está bien para ese tipo; si no, el código. */
export function validateVehicle(vehicle, vehicleType) {
  const type = String(vehicleType ?? '').toUpperCase();
  if (type === 'MOTO' || type === 'CARRO') {
    if (!vehicle.make || vehicle.make.length < 2) return 'invalid_vehicle_make';
    if (!vehicle.model || vehicle.model.length < 1) return 'invalid_vehicle_model';
    if (vehicle.plate && !/^[A-Z0-9-]{3,12}$/.test(vehicle.plate)) return 'invalid_vehicle_plate';
  }
  if (type === 'BICICLETA') {
    if (vehicle.bicycle_type && !BICYCLE_TYPES.includes(vehicle.bicycle_type)) return 'invalid_bicycle_type';
  }
  return null;
}

/** `null` si la disponibilidad está bien; si no, el código del primer error. */
export function validateAvailability(availability) {
  if (availability.availability && availability.availability.length < 3) return 'invalid_availability';
  if (availability.schedule && availability.schedule.length < 3) return 'invalid_schedule';
  return null;
}

/**
 * Lee el cuerpo completo de la solicitud ampliada.
 *
 * Devuelve `{ profile, vehicle, availability, policy }` o
 * `{ error, field }` con el primer problema encontrado. Los bloques ausentes
 * quedan en `null` (cliente antiguo).
 */
export function readApplicationProfile(body, { vehicleType, minAge = MIN_APPLICANT_AGE, now = new Date() } = {}) {
  const personal = parsePersonal(body.personal ?? body.profile ?? null);
  const vehicle = parseVehicle(body.vehicleDetail ?? body.vehicle_detail ?? null);
  const availability = parseAvailability(body.availability ?? null);
  const policyRaw = body.policy && typeof body.policy === 'object' ? body.policy : null;

  const personalError = personal ? validatePersonal(personal, { minAge, now }) : null;
  if (personalError) return { error: personalError, field: 'personal' };

  const vehicleError = vehicle ? validateVehicle(vehicle, vehicleType) : null;
  if (vehicleError) return { error: vehicleError, field: 'vehicle' };

  const availabilityError = availability ? validateAvailability(availability) : null;
  if (availabilityError) return { error: availabilityError, field: 'availability' };

  return {
    profile: personal,
    vehicle,
    availability,
    policy: policyRaw
      ? {
        version: text(policyRaw.version, 24) || null,
        accepted_at: text(policyRaw.acceptedAt ?? policyRaw.accepted_at, 32) || null,
      }
      : null,
  };
}
