/* ==========================================================================
   iPHONE / iPAD — medidas del teclado y foco dentro de las hojas
   ==========================================================================

   Sólo se activa si `<html data-ios="true">`, que pone el script mínimo del
   <head> (index.html). En Android y en escritorio este archivo no hace NADA:
   ni escucha eventos ni escribe variables.

   PARA QUÉ SIRVE
   --------------
   En iOS el teclado no encoge el viewport de maquetación: los elementos
   `fixed` se quedan donde estaban y el campo enfocado puede acabar detrás del
   teclado. `window.visualViewport` sí dice el alto realmente visible, así que:

     --ios-vvh  alto visible (px) con el teclado descontado
     --ios-kb   alto que ocupa el teclado (0 cuando está cerrado)
     body[data-ios-kb]  'open' | 'closed'  -> lo usa ios.css

   Al cerrar el teclado (o al perder el foco, girar el teléfono o cambiar de
   pestaña) todo vuelve a 0 y el diseño original queda exactamente igual: no se
   deja ningún desplazamiento permanente.

   El chat ya tiene su propio seguimiento del teclado (composer-mobile.js) y
   ahí NO se toca: es el que mueve el compositor y la lista de mensajes.
   ========================================================================== */
(() => {
  'use strict';

  const root = document.documentElement;
  if (root.dataset.ios !== 'true') return;

  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 979px)');
  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

  let frame = 0;
  let base = window.innerHeight;
  let lastWidth = window.innerWidth;

  function editableFocused() {
    const el = document.activeElement;
    return !!el && el.matches && el.matches(EDITABLE);
  }

  function reset() {
    delete document.body.dataset.iosKb;
    root.style.setProperty('--ios-kb', '0px');
    root.style.setProperty('--ios-vvh', `${Math.round(window.innerHeight)}px`);
  }

  function update() {
    frame = 0;

    // En escritorio ancho o girando el teléfono no hay teclado que seguir.
    if (!mobile.matches) {
      reset();
      return;
    }

    const height = viewport ? viewport.height : window.innerHeight;
    const offsetTop = viewport ? viewport.offsetTop : 0;

    // Girar el teléfono o salir de pantalla completa cambia la referencia:
    // si el ancho se movió de golpe, o el alto creció, se toma el nuevo.
    if (Math.abs(window.innerWidth - lastWidth) > 80) {
      base = window.innerHeight;
      lastWidth = window.innerWidth;
    }
    base = Math.max(base, window.innerHeight, height);

    const keyboard = Math.max(0, Math.round(base - height - offsetTop));
    root.style.setProperty('--ios-vvh', `${Math.round(height)}px`);

    // 100 px de diferencia no es un teclado: es la barra de Safari plegándose.
    const open = editableFocused() && keyboard > 100;
    root.style.setProperty('--ios-kb', `${open ? keyboard : 0}px`);
    document.body.dataset.iosKb = open ? 'open' : 'closed';
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  /*
   * EL CAMPO ENFOCADO SE VE. Dentro de una hoja, `scrollIntoView` con
   * `block: 'nearest'` sólo desplaza la caja interna (.sheet__body) lo justo
   * para que el campo quede a la vista; no mueve la página ni salta al
   * principio. Se espera un instante a que iOS termine de animar el teclado.
   */
  function revealFocused(event) {
    const el = event.target;
    if (!el || !el.matches || !el.matches(EDITABLE)) return;
    if (!el.closest('#sheet .sheet__panel')) return;
    window.setTimeout(() => {
      try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (_) {
        /* Navegadores sin opciones en scrollIntoView: no es crítico. */
      }
    }, 260);
  }

  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('focusin', (event) => { schedule(); revealFocused(event); });
  document.addEventListener('focusout', schedule);

  // Al cambiar de pestaña o cerrar la hoja, el teclado ya no manda.
  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-tab', 'data-wa-view'],
  });

  update();
})();
