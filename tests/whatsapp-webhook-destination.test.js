import { describe, expect, it } from 'vitest';

import { parseWebhook, splitByDestination } from '../server/whatsapp.mjs';

/**
 * AISLAMIENTO POR NÚMERO DE DESTINO DEL WEBHOOK.
 *
 * Una firma válida solo demuestra que el evento lo envió Meta. El destino real
 * viaja en `metadata.phone_number_id`: si el CRM tiene un número configurado y
 * el evento trae otro (o ninguno), no puede tocar la base de datos.
 */
const DESTINO = 'PN-UAT';

function cuerpo({ destino = DESTINO, waId = '18095550101', wamid = 'wamid.T1', texto = 'hola' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              ...(destino === null ? {} : { metadata: { phone_number_id: destino, display_phone_number: '18095550999' } }),
              contacts: [{ wa_id: waId, profile: { name: 'Cliente Prueba' } }],
              messages: [{ from: waId, id: wamid, timestamp: 1790000000, type: 'text', text: { body: texto } }],
            },
          },
        ],
      },
    ],
  };
}

function lote(destinos) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ wa_id: '18095550101', profile: { name: 'Cliente Prueba' } }],
              messages: destinos.map((destino, indice) => ({
                from: '18095550101',
                id: `wamid.LOTE.${indice}`,
                timestamp: 1790000000 + indice,
                type: 'text',
                text: { body: `mensaje ${indice}` },
              })),
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhook arrastra el número de destino', () => {
  it('cada mensaje y cada estado llevan su phoneNumberId', () => {
    const conEstado = cuerpo();
    conEstado.entry[0].changes[0].value.statuses = [
      { id: 'wamid.SALIENTE', status: 'delivered', recipient_id: '18095550101', timestamp: 1790000001 },
    ];
    const parsed = parseWebhook(conEstado);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].phoneNumberId).toBe(DESTINO);
    expect(parsed.statuses).toHaveLength(1);
    expect(parsed.statuses[0].phoneNumberId).toBe(DESTINO);
  });
});

describe('splitByDestination', () => {
  it('acepta el evento del número configurado', () => {
    const parsed = parseWebhook(cuerpo());
    const split = splitByDestination(parsed, { phoneNumberId: DESTINO });
    expect(split.configured).toBe(true);
    expect(split.messages).toHaveLength(1);
    expect(split.ignored).toBe(0);
  });

  it('descarta el evento de un número ajeno', () => {
    const parsed = parseWebhook(cuerpo({ destino: 'PN-AJENO' }));
    const split = splitByDestination(parsed, { phoneNumberId: DESTINO });
    expect(split.messages).toHaveLength(0);
    expect(split.statuses).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });

  it('sin metadata de destino falla cerrado', () => {
    const parsed = parseWebhook(cuerpo({ destino: null }));
    const split = splitByDestination(parsed, { phoneNumberId: DESTINO });
    expect(split.messages).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });

  it('un destino malformado tampoco pasa', () => {
    const parsed = parseWebhook(cuerpo({ destino: { id: DESTINO } }));
    const split = splitByDestination(parsed, { phoneNumberId: DESTINO });
    expect(split.messages).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });

  it('un estado de un número ajeno no puede tocar un mensaje propio', () => {
    const conEstado = cuerpo();
    conEstado.entry[0].changes[0].value.messages = [];
    conEstado.entry[0].changes[0].value.statuses = [
      { id: 'wamid.PROPIO', status: 'read', recipient_id: '18095550101', timestamp: 1790000002 },
    ];
    const ajeno = cuerpo({ destino: null });
    ajeno.entry[0].changes[0].value.messages = [];
    ajeno.entry[0].changes[0].value.statuses = conEstado.entry[0].changes[0].value.statuses;
    const split = splitByDestination(parseWebhook(ajeno), { phoneNumberId: DESTINO });
    expect(split.statuses).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });

  it('en un lote mixto solo pasa lo que era para nuestro número', () => {
    const parsed = parseWebhook(lote([DESTINO, 'PN-AJENO']));
    // Un lote de Meta trae un solo metadata por `value`; se simulan dos valores.
    const mezcla = {
      messages: [
        { ...parsed.messages[0], phoneNumberId: DESTINO },
        { ...parsed.messages[1], phoneNumberId: 'PN-AJENO' },
      ],
      statuses: [],
    };
    const split = splitByDestination(mezcla, { phoneNumberId: DESTINO });
    expect(split.messages).toHaveLength(1);
    expect(split.messages[0].phoneNumberId).toBe(DESTINO);
    expect(split.ignored).toBe(1);
  });

  it('sin número configurado NO se acepta nada (fail-closed)', () => {
    const parsed = parseWebhook(cuerpo({ destino: 'PN-CUALQUIERA' }));
    const split = splitByDestination(parsed, { phoneNumberId: '' });
    expect(split.configured).toBe(false);
    expect(split.blocked).toBe(true);
    expect(split.messages).toHaveLength(0);
    expect(split.statuses).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });

  it('una configuración vacía, con espacios o indefinida también cierra la ingesta', () => {
    const parsed = parseWebhook(cuerpo({ destino: DESTINO }));
    for (const configuracion of ['', '   ', '\t\n', null, undefined]) {
      const split = splitByDestination(parsed, { phoneNumberId: configuracion });
      expect(split.messages, `config=${JSON.stringify(configuracion)}`).toHaveLength(0);
      expect(split.blocked, `config=${JSON.stringify(configuracion)}`).toBe(true);
    }
  });

  it('un número configurado malformado no coincide con eventos válidos', () => {
    const parsed = parseWebhook(cuerpo({ destino: DESTINO }));
    const split = splitByDestination(parsed, { phoneNumberId: { id: DESTINO } });
    expect(split.messages).toHaveLength(0);
    expect(split.ignored).toBe(1);
  });
});
