// SEGURIDAD DE LA CONCILIACIÓN DE MEDIOS (fase 9B).
//
// La conciliación es la ÚNICA salida de un envío ambiguo: una persona dice si el
// archivo salió o no. Este archivo comprueba que el servidor NO permite usarla
// para «arreglar» operaciones que no están en duda, ni para inventar un envío.
//
// Qué se protege:
//   · solo se concilia lo AMBIGUO (SENDING / SEND_UNKNOWN); el resto se rechaza
//     y NO se toca la fila,
//   · «salió» exige un identificador de Meta con su formato (wamid.…),
//   · repetir la misma conciliación es idempotente (doble clic no rompe nada),
//   · un archivo entrante no tiene envío que conciliar,
//   · «no salió» deja la operación reintentable con la MISMA clave,
//   · cualquier rechazo deja el estado EXACTAMENTE como estaba.
import { describe, it, expect, beforeEach } from 'vitest';

import { createMediaPipeline } from '../server/media-pipeline.mjs';
import { SEND_STATUS } from '../server/media.mjs';

/** Almacén de mentira con las filas que interesan a cada caso. */
function almacen(filas) {
  const mapa = new Map(filas.map((fila) => [fila.id, { ...fila }]));
  return {
    mapa,
    async get(id) {
      const fila = mapa.get(id);
      return fila ? { ...fila } : null;
    },
    async byIdempotencyKey(key) {
      for (const fila of mapa.values()) if (fila.idempotency_key === key) return { ...fila };
      return null;
    },
    async update(id, patch) {
      const fila = mapa.get(id);
      if (!fila) return { ok: false };
      if (patch.sendStatus !== undefined) fila.send_status = patch.sendStatus;
      if (patch.waMessageId !== undefined) fila.wa_message_id = patch.waMessageId;
      if (patch.sentAt !== undefined) fila.sent_at = patch.sentAt;
      return { ok: true, media: { ...fila } };
    },
  };
}

const base = {
  id: 'mrd_prueba',
  direction: 'outbound',
  media_type: 'image',
  idempotency_key: 'op-1',
  wa_message_id: null,
  sent_at: null,
};

function pipelineCon(filas) {
  const store = almacen(filas);
  const avisos = [];
  const pipeline = createMediaPipeline({
    mediaStore: store,
    storage: {},
    whatsappMedia: {},
    logger: (linea) => avisos.push(linea),
  });
  return { pipeline, store, avisos };
}

describe('conciliación de medios: máquina de estados y evidencias', () => {
  let ctx;
  beforeEach(() => {
    ctx = pipelineCon([{ ...base, send_status: SEND_STATUS.SEND_UNKNOWN }]);
  });

  it('operación inexistente se rechaza', async () => {
    const { pipeline } = ctx;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_no_existe', outcome: 'sent', waMessageId: 'wamid.ABC123' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('not_found');
  });

  it('un estado NUNCA ambiguo (READY_TO_SEND) no se puede conciliar y no cambia', async () => {
    const { pipeline, store } = pipelineCon([{ ...base, send_status: SEND_STATUS.READY_TO_SEND }]);
    const antes = (await store.get('mrd_prueba')).send_status;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'wamid.ABC123' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('not_ambiguous');
    expect((await store.get('mrd_prueba')).send_status).toBe(antes);
  });

  it('lo ya ENVIADO no se vuelve a conciliar con otro identificador', async () => {
    const { pipeline, store } = pipelineCon([
      { ...base, send_status: SEND_STATUS.SENT, wa_message_id: 'wamid.YAENVIADO' },
    ]);
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'wamid.OTRO999' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('not_ambiguous');
    expect((await store.get('mrd_prueba')).wa_message_id).toBe('wamid.YAENVIADO');
  });

  it('repetir la MISMA conciliación es idempotente', async () => {
    const { pipeline } = pipelineCon([{ ...base, send_status: SEND_STATUS.SENT, wa_message_id: 'wamid.IGUAL1' }]);
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'wamid.IGUAL1' });
    expect(r.ok).toBe(true);
    expect(r.already).toBe(true);
  });

  it('«salió» sin identificador se rechaza', async () => {
    const { pipeline, store } = ctx;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent' });
    expect(r.error.code).toBe('missing_wamid');
    expect((await store.get('mrd_prueba')).send_status).toBe(SEND_STATUS.SEND_UNKNOWN);
  });

  it('«salió» con un identificador inventado se rechaza', async () => {
    const { pipeline, store } = ctx;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'me-lo-invento' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('invalid_wamid');
    expect((await store.get('mrd_prueba')).send_status).toBe(SEND_STATUS.SEND_UNKNOWN);
  });

  it('un archivo ENTRANTE no tiene envío que conciliar', async () => {
    const { pipeline } = pipelineCon([{ ...base, direction: 'inbound', send_status: SEND_STATUS.SEND_UNKNOWN }]);
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'not_sent' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('not_reconcilable');
  });

  it('SEND_UNKNOWN + «salió» con wamid válido pasa a SENT', async () => {
    const { pipeline, store } = ctx;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'wamid.ABCDEF123456' });
    expect(r.ok).toBe(true);
    expect(r.from).toBe(SEND_STATUS.SEND_UNKNOWN);
    const fila = await store.get('mrd_prueba');
    expect(fila.send_status).toBe(SEND_STATUS.SENT);
    expect(fila.wa_message_id).toBe('wamid.ABCDEF123456');
  });

  it('SENDING + «no salió» vuelve a READY_TO_SEND y es reintentable', async () => {
    const { pipeline, store } = pipelineCon([{ ...base, send_status: SEND_STATUS.SENDING }]);
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'not_sent' });
    expect(r.ok).toBe(true);
    expect(r.retryable).toBe(true);
    expect((await store.get('mrd_prueba')).send_status).toBe(SEND_STATUS.READY_TO_SEND);
  });

  it('tras «no salió», una SEGUNDA conciliación ya no es ambigua', async () => {
    const { pipeline } = pipelineCon([{ ...base, send_status: SEND_STATUS.SENDING }]);
    expect((await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'not_sent' })).ok).toBe(true);
    const segunda = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'sent', waMessageId: 'wamid.ABCDEF123456' });
    expect(segunda.ok).toBe(false);
    expect(segunda.error.code).toBe('not_ambiguous');
  });

  it('una decisión que no es sent/not_sent se rechaza', async () => {
    const { pipeline } = ctx;
    const r = await pipeline.reconcileOutbound({ mediaId: 'mrd_prueba', outcome: 'quizas' });
    expect(r.error.code).toBe('invalid_outcome');
  });
});
