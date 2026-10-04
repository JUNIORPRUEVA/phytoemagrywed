/**
 * MENSAJES PROGRAMADOS — QUÉ SE SUGIERE Y POR QUÉ.
 *
 * UN mensaje programado es un mensaje CONCRETO que el sistema intentará enviar a
 * una fecha y hora. Para que salga aunque la ventana de 24 h esté cerrada, tiene
 * que ir SIEMPRE dentro de una plantilla aprobada. Aquí vive la decisión de CUÁL
 * plantilla y QUÉ texto se propone; el agente puede cambiarlo antes de programar.
 *
 * DOS CASOS, NADA MÁS:
 *   - ya compró  → `phyto_seguimiento_compra_v1` (seguimiento de su compra),
 *   - no compró  → `phyto_seguimiento_interes_v1` (seguimiento de su interés).
 *
 * REGLA DE ORO: NO SE INVENTA NADA.
 *   · «6 frascos o más» solo se aplica si el CRM PUEDE saberlo (`units` del pedido
 *     o la suma de las cantidades de sus líneas). Si no lo sabe, usa el mensaje
 *     general y lo DICE (`bottles.known === false`), en vez de suponer una cifra.
 *   · «formas parte de nuestro grupo» NO se usa nunca hoy: el CRM no guarda la
 *     pertenencia al grupo de WhatsApp de ningún cliente. La variante existe en
 *     `SUGGESTED_TEXT.interestGroup` y solo se elige si alguien pasa
 *     `groupMember: true` con un dato REAL (hoy nadie lo hace).
 */

import { isCompletedPurchaseStatus } from './orders.mjs';

/** Plantilla de seguimiento de una compra. */
export const PURCHASE_FOLLOWUP_TEMPLATE = 'phyto_seguimiento_compra_v1';
/** Plantilla de seguimiento de un interesado que todavía no ha comprado. */
export const INTEREST_FOLLOWUP_TEMPLATE = 'phyto_seguimiento_interes_v1';

/**
 * A partir de cuántos frascos se usa el mensaje «largo».
 *
 * El negocio lo pidió así: quien compró 6 frascos o más es un cliente de volumen
 * y se le habla distinto que a quien compró uno. Se cuenta FRASCOS, no cápsulas
 * (un frasco de 10 cápsulas y otro de 120 son un frasco cada uno).
 */
export const MANY_BOTTLES = 6;

/** Textos sugeridos. El agente puede dejarlos, editarlos o reemplazarlos. */
export const SUGGESTED_TEXT = Object.freeze({
  purchaseMany:
    'Ya ha pasado un tiempo desde tu última compra y queríamos saber cómo vas. Si deseas continuar y hacer tu próximo pedido, escríbenos y con gusto te ayudamos.',
  purchaseFew:
    'Esperamos que todo vaya bien con tu compra. Queríamos saber cómo te ha ido y recordarte que, si deseas continuar o realizar otro pedido, estamos disponibles para ayudarte.',
  interestGeneral:
    'Queríamos saber si pudiste revisar la información que te compartimos y si podemos ayudarte con alguna duda.',
  interestGroup:
    'Vimos que formas parte de nuestro grupo y queríamos saber si has podido revisar la información. Si tienes alguna pregunta o deseas conocer más, escríbenos y con gusto te ayudamos.',
});

/**
 * FRASCOS de un pedido, con honestidad sobre lo que se sabe.
 *
 * Se mira EN ESTE ORDEN, de lo más fiable a lo menos:
 *   1. `order_json.units` — el total de frascos que el CRM calculó al crear el
 *      pedido (una sola fuente, escrita por `buildOrder`).
 *   2. La suma de las cantidades de sus líneas (`order_json.items[].quantity`).
 *   3. La cantidad de la columna plana (`quantity`), que es la de la PRIMERA línea:
 *      vale para pedidos de una sola línea, no para los de varias.
 *
 * Si no se puede saber, se dice que no se sabe: NO se devuelve un 1 inventado.
 * «Frasco» = envase (un frasco de 10 cápsulas y otro de 120 son un frasco cada
 * uno). NO se cuentan cápsulas ni unidades internas.
 *
 * @param {any} item fila de pedido tal como vive en el almacén
 * @returns {{ known: boolean, units: number|null, source: 'units'|'lines'|null }}
 */
export function bottlesOfOrder(item) {
  if (!item) return { known: false, units: null, source: null };
  let detalle = null;
  const raw = item.order_json ?? item.orderJson;
  if (raw) {
    try {
      detalle = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      detalle = null;
    }
  }
  const declarado = Number(detalle?.units);
  if (Number.isFinite(declarado) && declarado > 0) return { known: true, units: declarado, source: 'units' };
  const lineas = Array.isArray(detalle?.items) ? detalle.items : [];
  const suma = lineas.reduce((total, line) => total + (Number(line?.quantity) || 0), 0);
  if (suma > 0) return { known: true, units: suma, source: 'lines' };
  const primeraLinea = Number(item.quantity);
  if (Number.isFinite(primeraLinea) && primeraLinea > 0) {
    return { known: true, units: primeraLinea, source: 'lines' };
  }
  return { known: false, units: null, source: null };
}

/** ¿Este pedido cuenta como compra hecha? Solo ENTREGADO: lo demás es promesa. */
export function isPurchase(item) {
  return isCompletedPurchaseStatus(item?.status);
}

/**
 * Última compra ENTREGADA de una lista de pedidos (la más reciente).
 * @param {any[]} orders
 */
export function lastPurchaseOf(orders = []) {
  return (
    orders
      .filter((item) => isPurchase(item))
      .sort((a, b) => String(b?.received_at ?? b?.closed_at ?? '').localeCompare(String(a?.received_at ?? a?.closed_at ?? '')))[0] ??
    null
  );
}

/**
 * QUÉ SE SUGIERE para este cliente.
 *
 * Función PURA: no toca la base de datos ni el reloj. Se le pasa lo que el CRM ya
 * sabe y devuelve la decisión, para poder probarla sin arrancar nada.
 *
 * @param {object} input
 * @param {any} input.customer                 cliente (para el nombre)
 * @param {any[]} [input.orders]               pedidos de ESE cliente
 * @param {boolean} [input.groupMember]        ¿se SABE que está en el grupo? (hoy siempre false)
 */
export function suggestScheduledMessage({ customer = null, orders = [], groupMember = false } = {}) {
  const compra = lastPurchaseOf(orders);
  const bottles = bottlesOfOrder(compra);
  /** @type {string[]} */
  const notes = [];

  if (compra) {
    if (!bottles.known) {
      // No se sabe cuántos frascos: mensaje GENERAL y se dice qué falta.
      notes.push(
        'No se pudo saber cuántos frascos tenía esa compra (el pedido no trae la cantidad), así que se propone el mensaje general.',
      );
    }
    const many = bottles.known && bottles.units >= MANY_BOTTLES;
    return {
      type: 'compra',
      templateName: PURCHASE_FOLLOWUP_TEMPLATE,
      hasPurchase: true,
      bottles,
      manyBottles: many,
      groupMember: false,
      message: many ? SUGGESTED_TEXT.purchaseMany : SUGGESTED_TEXT.purchaseFew,
      // Las dos opciones viajan para poder cambiar de idea sin volver al servidor.
      alternatives: [
        { type: 'compra', label: 'Compra · 6 frascos o más', message: SUGGESTED_TEXT.purchaseMany },
        { type: 'compra', label: 'Compra · menos de 6 frascos', message: SUGGESTED_TEXT.purchaseFew },
        { type: 'interes', label: 'Interés · sin compra', message: SUGGESTED_TEXT.interestGeneral },
      ],
      notes,
      firstName: customer?.name ?? null,
    };
  }

  // Sin compra entregada: seguimiento del interés.
  if (groupMember) {
    return {
      type: 'interes',
      templateName: INTEREST_FOLLOWUP_TEMPLATE,
      hasPurchase: false,
      bottles: { known: false, units: 0, source: null },
      manyBottles: false,
      groupMember: true,
      message: SUGGESTED_TEXT.interestGroup,
      alternatives: [
        { type: 'interes', label: 'Interés · general', message: SUGGESTED_TEXT.interestGeneral },
        { type: 'interes', label: 'Interés · está en el grupo', message: SUGGESTED_TEXT.interestGroup },
      ],
      notes,
      firstName: customer?.name ?? null,
    };
  }

  return {
    type: 'interes',
    templateName: INTEREST_FOLLOWUP_TEMPLATE,
    hasPurchase: false,
    bottles: { known: false, units: 0, source: null },
    manyBottles: false,
    groupMember: false,
    message: SUGGESTED_TEXT.interestGeneral,
    alternatives: [
      { type: 'interes', label: 'Interés · general', message: SUGGESTED_TEXT.interestGeneral },
      { type: 'compra', label: 'Compra · 6 frascos o más', message: SUGGESTED_TEXT.purchaseMany },
      { type: 'compra', label: 'Compra · menos de 6 frascos', message: SUGGESTED_TEXT.purchaseFew },
    ],
    notes,
    firstName: customer?.name ?? null,
  };
}
