/* El chat sigue el espacio visible cuando el teclado reduce o desplaza la pantalla. */
(() => {
  'use strict';
  const body = document.body;
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 979px)');
  const thread = document.getElementById('thread');
  let frame = 0;
  let stickToBottom = true;
  let baselineHeight = window.innerHeight;
  let lastWidth = window.innerWidth;

  function update() {
    frame = 0;
    const active = mobile.matches && body.dataset.tab === 'whatsapp' && body.dataset.waView === 'chat';
    if (!active || (viewport && Math.abs(viewport.scale - 1) > .05)) {
      delete body.dataset.waViewport;
      delete body.dataset.waKeyboard;
      body.style.removeProperty('--wa-viewport-height');
      body.style.removeProperty('--wa-viewport-top');
      return;
    }
    const height = viewport?.height ?? window.innerHeight;
    if (Math.abs(window.innerWidth - lastWidth) > 80) {
      baselineHeight = window.innerHeight;
      lastWidth = window.innerWidth;
    }
    baselineHeight = Math.max(baselineHeight, window.innerHeight, height);
    const editing = document.activeElement?.matches('#wa-text, #wa-thread-search-input');
    body.dataset.waViewport = 'true';
    body.dataset.waKeyboard = editing && baselineHeight - height > 100 ? 'open' : 'closed';
    body.style.setProperty('--wa-viewport-height', `${Math.round(height)}px`);
    body.style.setProperty('--wa-viewport-top', `${Math.max(0, Math.round(viewport?.offsetTop ?? 0))}px`);
    // Quien lee mensajes anteriores conserva su posición al abrir el teclado.
    if (thread && stickToBottom) thread.scrollTop = thread.scrollHeight;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  thread?.addEventListener('scroll', () => {
    stickToBottom = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 72;
  }, { passive: true });
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('input', (event) => { if (event.target.id === 'wa-text') schedule(); });
  // Tocar Enviar conserva el foco; adjuntos y diálogos conservan su interacción normal.
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !window.matchMedia('(pointer: coarse)').matches) return;
    const send = event.target.closest('#wa-send');
    if (send && !send.disabled && document.activeElement?.id === 'wa-text') event.preventDefault();
  });
  new MutationObserver(schedule).observe(body, { attributes: true, attributeFilter: ['data-tab', 'data-wa-view'] });
  schedule();
})();
