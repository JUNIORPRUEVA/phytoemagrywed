/**
 * Abrir WhatsApp en una pestaña nueva.
 *
 * Se usa en el modal de pedido y en el formulario de contacto. Dos reglas:
 *
 *  1. **Síncrono**: hay que llamarlo dentro del gesto del usuario (submit/click).
 *     Si se llama después de un `await`, el navegador bloquea la pestaña.
 *  2. **Sin `noopener` en las opciones**: cuando se pasa `noopener` a
 *     `window.open`, el navegador devuelve `null` aunque la pestaña SÍ se haya
 *     abierto, así que no se puede distinguir "abierta" de "bloqueada" y la
 *     medición queda mintiendo. Se abre normal y se corta el acceso al
 *     `opener` a mano, que es exactamente lo que hace `noopener`.
 *
 * @param {string|null} url
 * @returns {boolean} true si la pestaña se abrió (false = bloqueada por el navegador)
 */
export function openWhatsAppWindow(url) {
  if (!url || typeof window === 'undefined' || typeof window.open !== 'function') return false;
  let opened = null;
  try {
    opened = window.open(url, '_blank');
  } catch {
    return false;
  }
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    /* algunos navegadores no dejan tocarlo: la pestaña sigue abierta */
  }
  return true;
}
