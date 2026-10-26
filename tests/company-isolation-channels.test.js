// @vitest-environment node
/**
 * AISLAMIENTO POR EMPRESA EN LOS CANALES QUE NO SON UNA LISTA.
 *
 * Las listas y las rutas por ID ya estaban cerradas, pero un registro puede
 * escaparse por sitios que no parecen «una consulta»:
 *   · el bus de eventos en vivo (SSE) que refresca el panel,
 *   · el aviso en vivo del chat,
 *   · las herramientas de consulta del agente de seguimiento.
 *
 * Aquí se fija la regla única: la superadministración central (`admin.full`) ve
 * todo; el panel ordinario solo recibe aquello cuya empresa está DEMOSTRADA y
 * es PHYTOEMAGRY. Si no se puede demostrar, se cierra.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientAccepts, createRealtimeHub } from '../server/realtime.mjs';
import { actorSeesCompany, crmRowVisible, explicitCrmCompany } from '../server/logistics-tenancy.mjs';
import { hasPermission } from '../server/users.mjs';
import { createReadTools } from '../server/ops/read-tools.mjs';
import { startCrmServer } from '../server/crm-server.mjs';

const agente = { id: 'u-agent', role: 'AGENT', actor_type: 'USER' };
const central = { id: 'u-admin', role: 'ADMIN', actor_type: 'USER' };
const repartidor = { id: 'u-rep', role: 'DELIVERY', actor_type: 'USER' };
const puede = (actor) => (permission) => hasPermission(actor, permission);

const eventoPanel = (extra = {}) => ({
  type: 'order.created',
  requires: 'orders.read',
  audience: 'panel',
  data: {},
  ...extra,
});

describe('bus de eventos: la empresa decide quién recibe el aviso', () => {
  it('un evento de otra empresa no llega al panel ordinario ni se puede inferir', () => {
    const evento = eventoPanel({ company: 'fulltech', companyScoped: true });
    expect(clientAccepts(evento, { actor: agente, can: puede(agente) })).toBe(false);
    expect(clientAccepts(evento, { actor: central, can: puede(central) })).toBe(true);
  });

  it('un registro sin empresa demostrable queda solo para la central', () => {
    const evento = eventoPanel({ company: null, companyScoped: true });
    expect(clientAccepts(evento, { actor: agente, can: puede(agente) })).toBe(false);
    expect(clientAccepts(evento, { actor: central, can: puede(central) })).toBe(true);
  });

  it('un evento de PHYTOEMAGRY sigue llegando al panel', () => {
    const evento = eventoPanel({ company: 'phytoemagry', companyScoped: true });
    expect(clientAccepts(evento, { actor: agente, can: puede(agente) })).toBe(true);
  });

  it('un evento global (sin empresa asociada) no se filtra por empresa', () => {
    // Inventario y supervisor son globales: la empresa solo acota lo que tiene
    // empresa. Aquí se usa un permiso que el agente SÍ tiene, para comprobar que
    // el filtro nuevo no bloquea eventos que no hablan de una empresa.
    const evento = eventoPanel({ company: null, companyScoped: false });
    expect(clientAccepts(evento, { actor: agente, can: puede(agente) })).toBe(true);
  });

  it('el aviso dirigido a una persona concreta se rige por identidad, no por empresa', () => {
    // Un repartidor autorizado a dos empresas tiene que enterarse de SU entrega
    // aunque el pedido sea de la otra empresa.
    const evento = { type: 'order.assigned', requires: null, audience: 'assignee', company: 'fulltech', companyScoped: true, data: { delivery_user_id: 'u-rep' } };
    expect(clientAccepts(evento, { actor: repartidor, can: puede(repartidor) })).toBe(true);
    expect(clientAccepts(evento, { actor: agente, can: puede(agente) })).toBe(false);
  });

  it('el hub entrega el evento al central y no al agente, sin cambiar el formato', () => {
    const hub = createRealtimeHub();
    const recibidos = { agente: [], central: [] };
    hub.subscribe({ actor: agente, can: puede(agente), origin: null, since: 0,
      send: (chunk) => recibidos.agente.push(chunk), close: () => {} });
    hub.subscribe({ actor: central, can: puede(central), origin: null, since: 0,
      send: (chunk) => recibidos.central.push(chunk), close: () => {} });
    hub.publish(eventoPanel({ company: 'fulltech', companyScoped: true, entity: { kind: 'order', id: 'o1' } }));
    hub.publish(eventoPanel({ company: 'phytoemagry', companyScoped: true, entity: { kind: 'order', id: 'o2' } }));
    expect(recibidos.agente).toHaveLength(1);
    expect(recibidos.agente[0]).toContain('"id":"o2"');
    expect(recibidos.central).toHaveLength(2);
    expect(recibidos.central[0]).toContain('"company":"fulltech"');
  });
});

describe('la regla de empresa es la misma en todos los sitios', () => {
  it('sin empresa demostrable no se ve; con PHYTOEMAGRY sí; otra empresa no', () => {
    expect(actorSeesCompany(agente, null)).toBe(false);
    expect(actorSeesCompany(agente, 'fulltech')).toBe(false);
    expect(actorSeesCompany(agente, 'phytoemagry')).toBe(true);
    expect(actorSeesCompany(central, 'fulltech')).toBe(true);
  });

  it('una etiqueta contradictoria entre ficha y conversación no demuestra nada', () => {
    expect(explicitCrmCompany({ conversation: { company_id: 'phytoemagry' }, customer: { company_id: 'fulltech' } })).toBeNull();
    expect(explicitCrmCompany({ conversation: { company_id: 'phytoemagry' }, customer: null })).toBe('phytoemagry');
    expect(explicitCrmCompany({ conversation: {}, customer: {} })).toBeNull();
  });

  it('crmRowVisible exige corte completo y evidencia PHYTOEMAGRY para el panel', () => {
    const ownership = { complete: true, evidence: { conversation: () => 'phytoemagry', customer: () => 'phytoemagry' } };
    expect(crmRowVisible(agente, ownership, 'conversation', { id: 'c1' })).toBe(true);
    expect(crmRowVisible(agente, { ...ownership, complete: false }, 'conversation', { id: 'c1' })).toBe(false);
    expect(crmRowVisible(agente, { complete: true, evidence: { conversation: () => null, customer: () => null } }, 'conversation', { id: 'c1' })).toBe(false);
    expect(crmRowVisible(central, { complete: false, evidence: { conversation: () => null } }, 'conversation', { id: 'c1' })).toBe(true);
  });
});

describe('herramientas del agente: no son una puerta trasera a otra empresa', () => {
  let app; let dir; let agentId;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crm-company-channels-'));
    app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'uat.sqlite'),
      token: 'channels-uat', quiet: true, schedulerEnabled: false,
      whatsapp: { enabled: false }, metaCapi: { enabled: false } });
    const login = async (body) => {
      const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const adminCookie = await login({ token: 'channels-uat' });
    const created = await fetch(`${app.url}/api/admin/users`, { method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'agent-channels', displayName: 'Agente Canales',
        role: 'AGENT', password: 'Channels-Uat-123' }) });
    expect(created.status).toBe(201);
    agentId = (await created.json()).user.id;
  });
  afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

  const chatDe = async (phone, name, companyId) => {
    const made = await app.ctx.customers.findOrCreateByPhone({ phone, name, source: 'uat', optIn: false });
    const conversation = await app.ctx.customers.conversationFor(made.customer.id);
    await app.ctx.db.update('customers', made.customer.id, { company_id: companyId });
    await app.ctx.db.update('conversations', conversation.id, { company_id: companyId });
    await app.ctx.customers.assignConversation(conversation.id, { userId: agentId });
    return { customer: made.customer, conversation };
  };

  it('el agente no ve por el agente de IA una conversación de otra empresa asignada a él', async () => {
    await chatDe('8095558101', 'Cliente Compartido Phyto', 'phytoemagry');
    await chatDe('8095558102', 'Cliente Compartido Fulltech', 'fulltech');
    const actor = { id: agentId, role: 'AGENT', actor_type: 'USER' };
    const tools = createReadTools({ ctx: app.ctx, can: puede(actor), actor });
    const encontrados = await tools.run('clientes_buscar', { q: 'Cliente Compartido', limite: 10 });
    expect(encontrados.ok).toBe(true);
    const nombres = encontrados.datos.map((row) => row.nombre);
    expect(nombres).toContain('Cliente Compartido Phyto');
    expect(nombres).not.toContain('Cliente Compartido Fulltech');
  });
});
