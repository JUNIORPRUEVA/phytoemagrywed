/**
 * "Elige primero tu frasco".
 *
 * Cuando el visitante pulsa Comprar (o pedir por WhatsApp) sin haber elegido
 * frasco, no se abre nada: se le pide que elija y se le lleva al carrusel, con
 * el foco en la primera tarjeta. Es más útil que abrir un pedido de un tamaño
 * que no ha decidido — y evita pedidos equivocados.
 */

import { prefersReducedMotion, qs } from './dom.js';

/** Se recuerda el temporizador para que el aviso no se quede pegado. */
let hideTimer = null;

/**
 * Muestra el aviso, lleva el carrusel a la vista y enfoca la primera tarjeta.
 * @param {object} view  view model (para el texto del aviso)
 * @returns {boolean} true si se pudo avisar (siempre que exista la sección)
 */
export function promptChooseVariant(view) {
  const section = qs('#frascos');
  if (!section) return false;

  const alertBox = qs('[data-order-alert]', section);
  const label = view.content.selector.chooseFirst;

  if (alertBox) {
    alertBox.textContent = label;
    alertBox.hidden = false;
    if (hideTimer) clearTimeout(hideTimer);
    // Se esconde solo: el aviso llama la atención, no ocupa sitio para siempre.
    hideTimer = setTimeout(() => {
      alertBox.hidden = true;
    }, 6000);
  }

  // Llevar el carrusel a la vista y dejar el foco en la primera tarjeta.
  const firstCard = /** @type {HTMLInputElement|null} */ (qs('[data-variant-input]', section));
  // jsdom y navegadores antiguos no implementan scrollIntoView: sin la guarda,
  // el error escaparía del handler y rompería el resto de la interacción.
  if (typeof section.scrollIntoView === 'function') {
    try {
      section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch {
      /* se queda donde está: el aviso ya se ve */
    }
  }
  if (firstCard) {
    // `preventScroll` porque el scroll ya lo hemos pedido nosotros.
    try {
      firstCard.focus({ preventScroll: true });
    } catch {
      firstCard.focus();
    }
  }

  if (view.site.tracking.debug) console.info('[frascos] hay que elegir frasco antes de comprar');
  return true;
}
