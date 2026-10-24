// @vitest-environment node
/**
 * SUPERVISOR + CICLO LOGÍSTICO DEL MÓVIL.
 *
 * Regla que se prueba aquí (y que faltaba): una entrega YA TERMINADA en el móvil
 * deja de supervisarse, así que no se le pueden seguir enviando recordatorios de
 * «inicia la entrega». El estado logístico se EXPONE en el resultado pero no
 * reinterpreta el calendario de avisos, que tiene sus propias pruebas.
 *
 * Sin servidor, sin WhatsApp y sin red: objetos planos.
 */
import { describe, expect, it } from 'vitest';

import {
  SUPERVISOR_STAGES,
  lifecycleSupervisionOf,
  supervisionEligibility,
  supervisionOf,
} from '../server/delivery-supervisor.mjs';

/** Pedido mínimo asignado a un usuario interno, con el ciclo que se pida. */
const orderWith = (lifecycle) => ({
  id: 'ped_1',
  status: 'enviado',
  created_at: new Date('2026-10-24T12:00:00Z').toISOString(),
  delivery: {
    delivery_status: 'ASSIGNED',
    delivery_user_id: 'usr_delivery',
    delivery_assigned_at: new Date('2026-10-24T12:00:00Z').toISOString(),
    ...(lifecycle ? { lifecycle } : {}),
  },
});

const settings = { activationMode: 'all' };

describe('una entrega terminada no se supervisa', () => {
  for (const finished of ['DELIVERED', 'CANCELLED', 'REJECTED', 'EXPIRED']) {
    it(`cierra la supervisión en ${finished}`, () => {
      const order = orderWith(finished);
      expect(lifecycleSupervisionOf(order)).toEqual({ stage: SUPERVISOR_STAGES.CLOSED, finished: true });

      const eligibility = supervisionEligibility(order, settings);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reason).toBe('delivery_finished');

      const state = supervisionOf(order, { settings, now: Date.parse('2026-10-24T13:00:00Z') });
      expect(state.closed).toBe(true);
      expect(state.stage).toBe(SUPERVISOR_STAGES.CLOSED);
      /* Ni siquiera se propone una acción de reparto. */
      expect(state.nextAction).not.toBe('Iniciar la entrega');
      expect(state.responsible).toBeNull();
    });
  }

  it('un pedido entregado por estado comercial tampoco entra', () => {
    const order = { ...orderWith('EN_ROUTE'), status: 'entregado' };
    expect(supervisionEligibility(order, settings)).toEqual({ eligible: false, reason: 'closed' });
  });
});

describe('una entrega en curso sigue supervisándose', () => {
  for (const active of ['ASSIGNED', 'OFFERED', 'ACCEPTED', 'PICKUP_PENDING', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED']) {
    it(`no cierra la supervisión en ${active}`, () => {
      const order = orderWith(active);
      expect(lifecycleSupervisionOf(order).finished).toBe(false);
      expect(supervisionEligibility(order, settings).eligible).toBe(true);

      const state = supervisionOf(order, { settings, now: Date.parse('2026-10-24T12:30:00Z') });
      expect(state.closed).toBeUndefined();
      expect(state.stage).not.toBe(SUPERVISOR_STAGES.CLOSED);
      /* El paso real del móvil se expone, sin cambiar el calendario. */
      expect(state.lifecycle).toBe(active);
    });
  }

  it('REASSIGNED no cierra: el pedido sigue vivo con otro responsable', () => {
    const order = orderWith('REASSIGNED');
    expect(lifecycleSupervisionOf(order).finished).toBe(false);
    expect(supervisionEligibility(order, settings).eligible).toBe(true);
  });
});

describe('pedidos anteriores al ciclo logístico', () => {
  it('sin `delivery.lifecycle` se comporta exactamente como antes', () => {
    const legacy = orderWith(null);
    expect(lifecycleSupervisionOf(legacy)).toEqual({ stage: null, finished: false });
    expect(supervisionEligibility(legacy, settings).eligible).toBe(true);

    const state = supervisionOf(legacy, { settings, now: Date.parse('2026-10-24T12:30:00Z') });
    expect(state.lifecycle).toBeNull();
    expect(state.stage).not.toBe(SUPERVISOR_STAGES.CLOSED);
  });

  it('una cadena desconocida no se interpreta como entregada', () => {
    expect(lifecycleSupervisionOf(orderWith('INVENTADO'))).toEqual({ stage: null, finished: false });
  });
});
