// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  PROPOSAL_TTL_MS,
  buildProposal,
  cancelProposal,
  confirmProposal,
  prepareProposal,
} from '../server/assistant-actions.mjs';
import { assistantQuery } from '../server/assistant.mjs';

const PRODUCTS = [
  { id: 'phyto-30', name: 'Frasco de 30 cápsulas', price_cents: 249000, capsules: 30, active: true, track_stock: true },
  { id: 'phyto-60', name: 'Frasco de 60 cápsulas', price_cents: 390000, capsules: 60, active: true, track_stock: true },
];

const CUSTOMER = { id: 'cus_1', name: 'María UAT', notes: 'Nota previa' };
const CONVERSATION = { id: 'cnv_1', customer_id: 'cus_1', assigned_user_id: 'usr_1' };

function makeDb() {
  const rows = new Map();
  return {
    rows,
    insert: vi.fn(async (_name, doc) => {
      if (rows.has(doc.id)) return { duplicate: true };
      rows.set(doc.id, { ...doc });
      return { duplicate: false };
    }),
    get: vi.fn(async (_name, id) => rows.get(id) ?? null),
    update: vi.fn(async (_name, id, patch) => {
      const current = rows.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      rows.set(id, next);
      return next;
    }),
  };
}

function makeCtx(overrides = {}) {
  const db = makeDb();
  const ctx = {
    db,
    customers: { get: vi.fn(async (id) => (id === CUSTOMER.id ? { ...CUSTOMER } : null)) },
    audit: { record: vi.fn(async () => ({})) },
    assistantOps: {
      catalog: vi.fn(async () => PRODUCTS),
      checkStock: vi.fn(async () => ({ ok: true })),
      createOrder: vi.fn(async (body) => ({
        ok: true,
        order: { id: body.id, order_number: 'PE-AST001', status: 'nuevo' },
      })),
      createFollowup: vi.fn(async (input) => ({ id: 'fu_1', ...input })),
      setCustomerNotes: vi.fn(async () => ({ ok: true })),
      createQuote: vi.fn(async () => ({ ok: true, ref: { type: 'quote', id: 'pos_1', number: 'COT-1' } })),
    },
    ...overrides,
  };
  return ctx;
}

const actor = { id: 'usr_1', display_name: 'Luis' };
const canAll = () => true;

async function prepararPedido(ctx, params = { items: [{ producto: 'frasco de 30', cantidad: 2 }] }) {
  return prepareProposal({ ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, type: 'order', params });
}

describe('Asistente IA · operaciones preparadas', () => {
  it('prepara un pedido con precios del catálogo y NO ejecuta nada', async () => {
    const ctx = makeCtx();
    const prepared = await prepararPedido(ctx);
    expect(prepared.ok).toBe(true);
    expect(prepared.proposal).toMatchObject({ type: 'order', status: 'pending' });
    expect(prepared.proposal.preview.items[0]).toMatchObject({ variantId: 'phyto-30', quantity: 2 });
    expect(prepared.proposal.preview.total).toBe(4980);
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'assistant.action_prepared' }));
  });

  it('confirmar ejecuta UNA vez y un reintento devuelve el mismo resultado', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const first = await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: proposal.id });
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ number: 'PE-AST001' });
    expect(ctx.assistantOps.createOrder).toHaveBeenCalledTimes(1);

    const again = await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: proposal.id });
    expect(again.ok).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(ctx.assistantOps.createOrder).toHaveBeenCalledTimes(1);
  });

  it('una huella distinta invalida la confirmación', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const result = await confirmProposal({
      ctx, actor, can: canAll, canOpen: async () => true,
      proposalId: proposal.id, fingerprint: 'otra-cosa',
    });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'proposal_changed' });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
  });

  it('si el catálogo cambia de precio, se revalida y NO se ejecuta', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    ctx.assistantOps.catalog = vi.fn(async () => [{ ...PRODUCTS[0], price_cents: 299000 }, PRODUCTS[1]]);
    const result = await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: proposal.id });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'proposal_changed' });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
  });

  it('una propuesta caducada no se puede ejecutar', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const row = ctx.db.rows.get(proposal.id);
    ctx.db.rows.set(proposal.id, { ...row, expires_at: new Date(Date.now() - PROPOSAL_TTL_MS).toISOString() });
    const result = await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: proposal.id });
    expect(result).toMatchObject({ ok: false, status: 410, error: 'proposal_expired' });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
  });

  it('cancelar deja la propuesta muerta y no ejecuta', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const cancelled = await cancelProposal({ ctx, actor, can: canAll, proposalId: proposal.id });
    expect(cancelled.ok).toBe(true);
    const result = await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: proposal.id });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'proposal_not_pending' });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'assistant.action_cancelled' }));
  });

  it('sin el permiso concreto no se ejecuta', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const result = await confirmProposal({
      ctx, actor, can: (permission) => permission !== 'orders.create', canOpen: async () => true, proposalId: proposal.id,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
  });

  it('una propuesta de otra persona no la confirma cualquiera', async () => {
    const ctx = makeCtx();
    const { proposal } = await prepararPedido(ctx);
    const otro = { id: 'usr_2', display_name: 'Otra' };
    const result = await confirmProposal({
      ctx, actor: otro, can: (permission) => permission !== 'settings.manage',
      canOpen: async () => true, proposalId: proposal.id,
    });
    expect(result).toMatchObject({ ok: false, status: 403, error: 'proposal_from_another_user' });
  });

  it('el stock insuficiente se detecta ANTES de preparar', async () => {
    const ctx = makeCtx();
    ctx.assistantOps.checkStock = vi.fn(async () => ({ ok: false, message: 'Stock insuficiente: hay 10 cápsulas.' }));
    const prepared = await prepararPedido(ctx);
    expect(prepared).toMatchObject({ ok: false, status: 409, error: 'insufficient_stock' });
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it('un producto inventado por el modelo se rechaza', async () => {
    const ctx = makeCtx();
    const prepared = await prepararPedido(ctx, { items: [{ producto: 'crema milagrosa', cantidad: 1 }] });
    expect(prepared).toMatchObject({ ok: false, status: 422, error: 'unknown_product' });
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
  });
});

describe('Asistente IA · nota y seguimiento', () => {
  it('la nota se añade al expediente solo al confirmar', async () => {
    const ctx = makeCtx();
    const prepared = await prepareProposal({
      ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, type: 'note', params: { text: 'Prefiere entregas por la tarde' },
    });
    expect(prepared.ok).toBe(true);
    expect(ctx.assistantOps.setCustomerNotes).not.toHaveBeenCalled();
    await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: prepared.proposal.id });
    expect(ctx.assistantOps.setCustomerNotes).toHaveBeenCalledWith('cus_1', 'Nota previa\nPrefiere entregas por la tarde');
  });

  it('el seguimiento exige una fecha futura', async () => {
    const ctx = makeCtx();
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const malo = await prepareProposal({
      ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, type: 'followup', params: { date: ayer, reason: 'Llamar' },
    });
    expect(malo).toMatchObject({ ok: false, status: 422, error: 'date_in_past' });

    const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const bueno = await prepareProposal({
      ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, type: 'followup', params: { date: manana, reason: 'Llamar' },
    });
    expect(bueno.ok).toBe(true);
    await confirmProposal({ ctx, actor, can: canAll, canOpen: async () => true, proposalId: bueno.proposal.id });
    expect(ctx.assistantOps.createFollowup).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cus_1', scheduledAt: manana, idempotencyKey: `fu:assistant:${bueno.proposal.id}`,
    }));
  });
});

describe('Asistente IA · el modelo solo PROPONE', () => {
  it('una acción del modelo queda como propuesta pendiente, sin ejecutar', async () => {
    const ctx = makeCtx();
    ctx.customers.profile = vi.fn(async () => ({
      customer: CUSTOMER, purchases: [], totals: {}, messages: [], followups: [],
    }));
    ctx.db.list = vi.fn(async () => []);
    ctx.customers.canSendFreeText = vi.fn(() => true);
    const plan = vi.fn(async () => ({
      json: {
        answer: 'Preparé el pedido con dos frascos de 30 cápsulas.',
        bullets: [],
        draft: null,
        suggestions: [],
        action: { type: 'order', items: [{ producto: 'frasco de 30 cápsulas', cantidad: 2 }], payment: 'CASH' },
      },
      model: 'deepseek-flash', ms: 100, usage: { total: 10 },
    }));
    ctx.proofreading = { plan };
    const result = await assistantQuery({ ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, action: 'free', message: 'Prepara un pedido con dos frascos de 30 cápsulas' });
    expect(result.ai).toBe(true);
    expect(result.proposal).toMatchObject({ type: 'order', status: 'pending' });
    expect(result.proposal.preview.total).toBe(4980);
    expect(ctx.assistantOps.createOrder).not.toHaveBeenCalled();
    expect(ctx.db.insert).toHaveBeenCalledTimes(1); // solo la propuesta
  });

  it('si la propuesta no pasa la validación, la respuesta sigue siendo útil', async () => {
    const ctx = makeCtx();
    ctx.customers.profile = vi.fn(async () => ({ customer: CUSTOMER, purchases: [], totals: {}, messages: [], followups: [] }));
    ctx.db.list = vi.fn(async () => []);
    ctx.customers.canSendFreeText = vi.fn(() => true);
    ctx.proofreading = {
      plan: vi.fn(async () => ({
        json: { answer: 'No encuentro ese producto.', action: { type: 'order', items: [{ producto: 'inventado', cantidad: 1 }] } },
        model: 'deepseek-flash', ms: 90, usage: { total: 8 },
      })),
    };
    const result = await assistantQuery({ ctx, actor, conversation: CONVERSATION, customer: CUSTOMER, action: 'free', message: 'prepara' });
    expect(result.ai).toBe(true);
    expect(result.proposal).toBeNull();
    expect(result.proposalError).toMatchObject({ error: 'unknown_product' });
  });
});

describe('Asistente IA · propuesta (cálculo)', () => {
  it('calcula el total con la función compartida del POS', async () => {
    const ctx = makeCtx();
    const built = await buildProposal({
      ctx, actor, conversation: CONVERSATION, customer: CUSTOMER,
      type: 'quote', params: { items: [{ producto: 'frasco de 60', cantidad: 3 }] },
    });
    expect(built.ok).toBe(true);
    expect(built.preview.total).toBe(11700);
    expect(built.preview.items[0]).toMatchObject({ variantId: 'phyto-60', quantity: 3, unitPrice: 3900 });
  });
});
