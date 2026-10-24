// @vitest-environment node
/**
 * UBICACIÓN DEL REPARTIDOR — validación y estado de señal.
 *
 * Lo que se demuestra: el backend no se cree nada del teléfono. Rechaza
 * coordenadas imposibles, precisión basura, posiciones viejas o fuera de orden,
 * y marca los saltos sospechosos sin romper el seguimiento.
 */
import { describe, expect, it } from 'vitest';

import { LOCATION_LIVE_MS, LOCATION_STALE_MS, SIGNAL, describePosition, signalState, validateCourierLocation } from '../server/courier-location.mjs';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const valid = (extra = {}) => ({ latitude: 18.4861, longitude: -69.9312, accuracy: 12, at: at(-5000), ...extra });

describe('coordenadas', () => {
  it('acepta una posición válida', () => {
    const result = validateCourierLocation(valid(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.point).toMatchObject({ lat: 18.4861, lng: -69.9312, accuracy: 12 });
  });

  it('rechaza coordenadas ausentes o no numéricas', () => {
    expect(validateCourierLocation({}, { now: NOW }).error).toBe('invalid_coordinates');
    expect(validateCourierLocation({ latitude: 'x', longitude: 3 }, { now: NOW }).error).toBe('invalid_coordinates');
  });

  it('rechaza coordenadas fuera de rango', () => {
    expect(validateCourierLocation(valid({ latitude: 120 }), { now: NOW }).error).toBe('invalid_coordinates');
    expect(validateCourierLocation(valid({ longitude: -200 }), { now: NOW }).error).toBe('invalid_coordinates');
  });

  it('rechaza el «null island» (GPS sin fix)', () => {
    expect(validateCourierLocation(valid({ latitude: 0, longitude: 0 }), { now: NOW }).error).toBe('invalid_coordinates');
  });

  it('rechaza precisión demasiado baja', () => {
    const result = validateCourierLocation(valid({ accuracy: 900 }), { now: NOW });
    expect(result.error).toBe('low_accuracy');
    expect(result.status).toBe(422);
  });
});

describe('tiempo', () => {
  it('rechaza marcas de tiempo inválidas', () => {
    expect(validateCourierLocation(valid({ at: 'ayer' }), { now: NOW }).error).toBe('invalid_timestamp');
  });

  it('rechaza una posición del futuro', () => {
    expect(validateCourierLocation(valid({ at: at(120000) }), { now: NOW }).error).toBe('future_timestamp');
  });

  it('rechaza una posición demasiado antigua', () => {
    const result = validateCourierLocation(valid({ at: at(-(LOCATION_STALE_MS + 60000)) }), { now: NOW });
    expect(result.error).toBe('stale_location');
    expect(result.status).toBe(409);
  });
});

describe('orden temporal y saltos', () => {
  const previous = { lat: 18.4861, lng: -69.9312, at: at(-60000) };

  it('una posición vieja NO sobrescribe una nueva', () => {
    const result = validateCourierLocation(valid({ at: at(-90000) }), { now: NOW, previous });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('out_of_order');
  });

  it('una posición nueva y cercana se acepta sin sospecha', () => {
    const result = validateCourierLocation(valid({ latitude: 18.487, longitude: -69.9315, at: at(-1000) }), { now: NOW, previous });
    expect(result.ok).toBe(true);
    expect(result.suspicious).toBe(false);
  });

  it('un salto imposible se acepta pero se marca sospechoso', () => {
    const result = validateCourierLocation(valid({ latitude: 19.9, longitude: -70.9, at: at(-1000) }), { now: NOW, previous });
    expect(result.ok).toBe(true);
    expect(result.suspicious).toBe(true);
    expect(result.point.jump.suspicious).toBe(true);
    expect(result.point.jump.speedMps).toBeGreaterThan(55);
  });
});

describe('estado de señal', () => {
  it('sin posición guardada', () => {
    expect(signalState(null, { now: NOW })).toBe(SIGNAL.NO_LOCATION);
  });

  it('en vivo, retrasada y sin señal según la antigüedad', () => {
    expect(signalState({ at: at(-1000) }, { now: NOW })).toBe(SIGNAL.LIVE);
    expect(signalState({ at: at(-(LOCATION_LIVE_MS + 1000)) }, { now: NOW })).toBe(SIGNAL.DELAYED);
    expect(signalState({ at: at(-(LOCATION_STALE_MS + 1000)) }, { now: NOW })).toBe(SIGNAL.NO_SIGNAL);
  });

  it('describe la posición con antigüedad y sin ocultar el retraso', () => {
    const described = describePosition({ lat: 18.4, lng: -69.9, at: at(-60000), accuracy: 15 }, { now: NOW, courierId: 'courier_a', orderIds: ['ped_1'] });
    expect(described).toMatchObject({ courier_id: 'courier_a', order_ids: ['ped_1'], state: SIGNAL.LIVE, age_seconds: 60, accuracy_m: 15 });
  });

  it('sin ubicación no devuelve coordenadas', () => {
    const described = describePosition(null, { now: NOW, courierId: 'courier_a' });
    expect(described.state).toBe(SIGNAL.NO_LOCATION);
    expect(described.latitude).toBeNull();
    expect(described.longitude).toBeNull();
  });
});
