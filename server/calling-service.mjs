import { createHash, randomUUID } from 'node:crypto';
import { validCallSdp } from './calling-api.mjs';

const FINAL = new Set(['completed', 'failed', 'rejected', 'missed']);
const RANK = { starting: 0, ringing: 1, connecting: 2, active: 3 };
const fail = (error, status = 409, code = null) => ({ ok: false, error, status, code });
const digits = (v) => String(v ?? '').replace(/\D/g, '');

export function publicCall(call, actor, includeSession = false) {
  if (!call) return null;
  const { remoteSdp, version, ...safe } = call;
  // Un agente distinto no puede tomar la sesión multimedia de quien respondió.
  if (includeSession && (!call.ownerId || call.ownerId === actor?.id)) safe.remoteSession = remoteSdp ?? null;
  return safe;
}

export function createCallingService({ store, api, customers, db, audit, enabled, clock = () => Date.now() }) {
  let processing = false;
  let lastPruned = 0;
  let timer;
  const ready = Boolean(enabled && store && api.enabled);
  async function finish(id, status, patch = {}) {
    const call = await store.change(id, (c) => ({ ...c, ...patch, status: FINAL.has(c.status) ? c.status : status,
      remoteSdp: null, updatedAt: clock(), endedAt: c.endedAt ?? clock() }));
    await store.release(id);
    return call;
  }
  async function eventToCall(e) {
    let call = e.reference ? await store.get(e.reference) : null;
    call ??= await store.byMeta(e.metaId);
    if (!call) {
      if (e.direction !== 'USER_INITIATED' || !/^\d{8,15}$/.test(e.phone ?? '')) return false;
      const found = await customers.findOrCreateByPhone({ phone: e.phone, name: e.name, source: 'whatsapp' });
      if (!found.ok) return true;
      const conversation = await db.findBy('conversations', 'customer_id', found.customer.id);
      if (!conversation) return false;
      call = await store.insert({ id: `incoming:${e.metaId}`, metaId: e.metaId, conversationId: conversation.id,
        customerId: found.customer.id, customerName: found.customer.name ?? found.customer.phone_e164,
        direction: 'inbound', status: 'ringing', ownerId: null, createdAt: clock(), updatedAt: clock(),
        lastEventAt: 0, heartbeatAt: clock(), remoteSdp: null });
    }
    const status = e.event === 'terminate' ? (e.failed ? 'failed' : 'completed') :
      ({ RINGING: 'ringing', ACCEPTED: 'active', REJECTED: 'rejected' }[e.status] ?? (e.session ? 'connecting' : null));
    const updated = await store.change(call.id, (c) => {
      if (FINAL.has(c.status)) {
        if (e.event !== 'terminate' || e.timestamp < (c.lastEventAt ?? 0)) return null;
        return { ...c, duration: e.duration ?? c.duration ?? null, lastEventAt: e.timestamp,
          status: c.status === 'completed' && e.failed ? 'failed' : c.status, remoteSdp: null, updatedAt: clock() };
      }
      if (e.timestamp < (c.lastEventAt ?? 0) && !e.session) return null;
      return { ...c, metaId: e.metaId, lastEventAt: Math.max(e.timestamp, c.lastEventAt ?? 0), updatedAt: clock(),
        ...(status && (FINAL.has(status) || (RANK[status] ?? 0) >= (RANK[c.status] ?? 0))
          ? { status: status === 'completed' && c.direction === 'inbound' && !c.ownerId ? 'missed' : status } : {}),
        ...(e.session && !FINAL.has(status) ? { remoteSdp: e.session, sdpExpiresAt: clock() + 120000 } : {}),
        ...(FINAL.has(status) ? { remoteSdp: null, endedAt: clock(), duration: e.duration ?? null } : {}),
      };
    });
    if (FINAL.has(updated.status)) await store.release(updated.id);
    return true;
  }
  const service = {
    enabled: ready,
    async ingest(body) {
      if (!ready) return;
      for (const entry of body?.entry ?? []) {
        if (String(entry.id) !== api.businessAccountId) continue;
        for (const change of entry.changes ?? []) {
          const value = change.value;
          if (change.field !== 'calls' || String(value?.metadata?.phone_number_id) !== api.phoneNumberId) continue;
          for (const raw of [...(value.calls ?? []), ...(value.statuses ?? [])]) {
            if (!/^[\w.:-]{1,250}$/.test(raw.id ?? '')) continue;
            if (!['connect', 'terminate'].includes(raw.event) && !['RINGING', 'ACCEPTED', 'REJECTED'].includes(raw.status)) continue;
            const inbound = raw.direction === 'USER_INITIATED' || raw.session?.sdp_type === 'offer';
            const session = raw.session && validCallSdp(raw.session.sdp) && ['offer', 'answer'].includes(raw.session.sdp_type)
              ? { type: raw.session.sdp_type, sdp: raw.session.sdp } : null;
            const e = { metaId: raw.id, reference: typeof raw.biz_opaque_callback_data === 'string' ? raw.biz_opaque_callback_data : null,
              event: raw.event ?? null, status: raw.status ?? null,
              direction: inbound ? 'USER_INITIATED' : 'BUSINESS_INITIATED',
              phone: digits(inbound ? raw.from : raw.to ?? raw.recipient_id),
              name: String(value.contacts?.[0]?.profile?.name ?? '').slice(0, 120),
              timestamp: Number(raw.timestamp) || 0, session,
              failed: String(raw.status).toUpperCase().includes('FAILED'), duration: Number(raw.duration) || null };
            await store.enqueue(createHash('sha256').update(JSON.stringify(e)).digest('hex'), e);
          }
        }
      }
    },
    async tick() {
      if (!ready || processing) return;
      processing = true;
      try {
        for (const row of await store.pending()) {
          // No se intenta recuperar audio de una oferta que ya caducó en la cola.
          if (row.event.event === 'connect' && clock() - row.createdAt > 120000) { await store.done(row.id); continue; }
          if (await eventToCall(row.event) || clock() - row.createdAt > 120000) await store.done(row.id);
        }
        for (const c of await store.active()) {
          if (c.sdpExpiresAt && c.sdpExpiresAt < clock() && c.remoteSdp) {
            await store.change(c.id, (r) => ({ ...r, remoteSdp: null }));
          }
          const timeout = c.ownerId ? 45000 : 65000;
          if (clock() - (c.heartbeatAt ?? c.createdAt) > timeout) {
            if (c.metaId) {
              const result = await api.action('terminate', { callId: c.metaId });
              if (!result.ok && result.uncertain) continue;
            }
            await finish(c.id, c.ownerId ? 'failed' : 'missed');
          }
        }
        if (clock() - lastPruned > 3600000) { await store.prune(clock()); lastPruned = clock(); }
      } finally { processing = false; }
    },
    start() { if (ready && !timer) { timer = setInterval(() => service.tick().catch(() => {}), 1000); timer.unref?.(); } },
    async stop() { clearInterval(timer); timer = null; while (processing) await new Promise((r) => setTimeout(r, 10)); },
    async list(conversationId, actor) {
      if (!ready) return { ok: true, enabled: false, calls: [] };
      return { ok: true, enabled: true, calls: (await store.list(conversationId)).map((c) => publicCall(c, actor)) };
    },
    async incoming() { return ready ? (await store.active()).filter((c) => c.direction === 'inbound' && !c.ownerId) : []; },
    async perform({ action, conversation, customer, actor, body = {}, canSendFreeText }) {
      if (!ready) return fail('calling_disabled', 503);
      const phone = digits(customer?.phone_e164);
      if (!/^\d{8,15}$/.test(phone)) return fail('invalid_phone', 422);
      if (action === 'permission-state') return api.permission(phone);
      if (['permission', 'connect'].includes(action)) {
        if (customer.do_not_contact || customer.whatsapp_opt_out_at) return fail('do_not_contact');
        const p = await api.permission(phone);
        if (!p.ok) return p;
        if (action === 'permission') {
          if (!canSendFreeText && !api.hasPermissionTemplate) return fail('permission_requires_open_window');
          if (!p.permission.canRequest) return fail('permission_request_limit');
          const key = `permission:${customer.id}`;
          const owner = randomUUID();
          if (!(await store.lock(key, owner, 86400000, clock()))) return fail('permission_request_limit');
          const r = await api.requestPermission(phone, { freeForm: Boolean(canSendFreeText) });
          if (!r.ok && !r.uncertain) await store.release(owner);
          if (r.ok) {
            await customers.recordOutbound({ customer, conversation, type: 'interactive',
              body: 'Solicitud de permiso para llamar por WhatsApp', status: 'sent', waMessageId: r.messageId,
              sentByUserId: actor.id, sentByDisplayName: actor.display_name });
          }
          return r;
        }
        if (!p.permission.canCall) return fail('call_permission_required');
        if (!validCallSdp(body.sdp)) return fail('invalid_sdp', 422);
        if (!/^[a-f0-9-]{36}$/.test(body.requestId ?? '')) return fail('invalid_request_id', 422);
        const id = `out:${actor.id}:${body.requestId}`;
        const previous = await store.get(id);
        if (previous) return previous.conversationId === conversation.id
          ? { ok: true, call: publicCall(previous, actor, true), duplicate: true } : fail('invalid_request_id', 422);
        const doc = { id, conversationId: conversation.id, customerId: customer.id,
          customerName: customer.name ?? customer.phone_e164, ownerId: actor.id, ownerName: actor.display_name,
          direction: 'outbound', status: 'starting', createdAt: clock(), updatedAt: clock(), heartbeatAt: clock(), remoteSdp: null };
        await store.insert(doc);
        // Reserva de operación evita doble POST incluso en un reintento simultáneo.
        if (!(await store.lock(`operation:${id}`, randomUUID(), 86400000, clock()))) return fail('call_in_progress');
        for (const resource of [`conversation:${conversation.id}`, `agent:${actor.id}`]) {
          if (!(await store.lock(resource, id, 90000, clock()))) { await finish(id, 'failed'); return fail('call_busy'); }
        }
        const r = await api.action('connect', { phone, sdp: body.sdp, reference: id });
        if (!r.ok) {
          if (!r.uncertain) await finish(id, 'failed');
          return { ...r, call: publicCall(await store.get(id), actor, true) };
        }
        const call = await store.change(id, (c) => ({ ...c, metaId: r.callId, updatedAt: clock() }));
        await audit?.record({ entity: 'call', entityId: id, action: 'call.started', actor: actor.display_name,
          summary: 'Llamada de WhatsApp iniciada', data: { conversation_id: conversation.id } });
        return { ok: true, call: publicCall(call, actor, true) };
      }
      const call = await store.get(body.id);
      if (!call || call.conversationId !== conversation.id) return fail('call_not_found', 404);
      if (action === 'state') return { ok: true, call: publicCall(call, actor, true) };
      if (call.ownerId && call.ownerId !== actor.id) return fail('call_owned_by_other_agent', 403);
      if (FINAL.has(call.status)) return { ok: true, call: publicCall(call, actor) };
      if (action === 'heartbeat') {
        if (call.ownerId !== actor.id) return fail('call_not_owned', 403);
        await store.change(call.id, (c) => ({ ...c, heartbeatAt: clock() }));
        for (const key of [`conversation:${conversation.id}`, `agent:${actor.id}`]) await store.lock(key, call.id, 90000, clock());
        return { ok: true };
      }
      if (['pre_accept', 'accept'].includes(action)) {
        if (call.direction !== 'inbound' || !validCallSdp(body.sdp)) return fail('invalid_call', 422);
        const claimOwner = `answer:${call.id}:${actor.id}`;
        if (!(await store.lock(`answer:${call.id}`, claimOwner, 90000, clock()))) return fail('call_busy');
        for (const key of [`conversation:${conversation.id}`, `agent:${actor.id}`]) {
          if (!(await store.lock(key, call.id, 90000, clock()))) {
            await store.release(claimOwner); await store.release(call.id); return fail('call_busy');
          }
        }
        const reserved = await store.change(call.id, (c) => c.ownerId && c.ownerId !== actor.id ? null :
          { ...c, ownerId: actor.id, ownerName: actor.display_name, heartbeatAt: clock(), updatedAt: clock() });
        if (reserved.ownerId !== actor.id) return fail('call_busy');
        const r = await api.action(action, { callId: call.metaId, sdp: body.sdp });
        if (!r.ok) return r;
        const updated = await store.change(call.id, (c) => ({ ...c, status: FINAL.has(c.status) ? c.status : action === 'accept' ? 'active' : 'connecting', updatedAt: clock() }));
        return { ok: true, call: publicCall(updated, actor, true) };
      }
      if (!['reject', 'terminate'].includes(action)) return fail('invalid_action', 422);
      if (action === 'reject' && call.direction !== 'inbound') return fail('invalid_action', 422);
      if (!call.metaId) return fail('call_start_unconfirmed');
      const r = await api.action(action, { callId: call.metaId });
      if (!r.ok) return r;
      return { ok: true, call: publicCall(await finish(call.id, action === 'reject' ? 'rejected' : 'completed'), actor) };
    },
  };
  return service;
}
