/**
 * PLANTILLA OFICIAL PARA ENVIAR UNA COTIZACIÓN POR WHATSAPP.
 *
 * Una cotización es un documento comercial: se envía con una plantilla UTILITY
 * que lleva CABECERA DE DOCUMENTO (el PDF viaja como archivo, no como enlace).
 * Así funciona también cuando la ventana de 24 h está cerrada, y el cliente no
 * recibe una dirección privada del CRM.
 *
 * Variables (en este orden):
 *   {{1}} nombre del cliente
 *   {{2}} número de la cotización (COT-…)
 *   {{3}} total con moneda (RD$…)
 *
 * El texto fijo lo aprueba Meta: no se toca desde el panel. Si el negocio quiere
 * otro texto, se crea otra plantilla con otro nombre (Meta no deja editar una
 * aprobada sin volver a revisarla).
 */
export const QUOTE_WHATSAPP_TEMPLATE = Object.freeze({
  name: 'phyto_envio_cotizacion_v1',
  friendly_name: 'Envío de cotización',
  group: 'COTIZACIONES',
  category: 'UTILITY',
  language: 'es',
  header: { format: 'DOCUMENT' },
  body:
    'Hola {{1}}, te compartimos la cotización {{2}} por un total de {{3}}.\n\n' +
    'Queda guardada a tu nombre. Si deseas confirmarla o tienes alguna duda, respóndenos por aquí.',
  variables: ['customer_name', 'quote_number', 'quote_total'],
  buttons: [],
});
