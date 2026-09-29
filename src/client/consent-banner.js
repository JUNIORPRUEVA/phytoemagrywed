/**
 * Banner de consentimiento + navegación móvil.
 *
 * El banner solo existe si hay algo que consentir (Pixel ID o dataLayer).
 * Sin configuración publicitaria no se muestra ningún banner.
 */

import { on, qs } from './dom.js';

/** @param {object} ctx */
export function initConsentBanner(ctx) {
  const banner = qs('[data-consent]');
  if (!banner) return null;

  if (!ctx.consent.hasDecided()) banner.hidden = false;
  else banner.hidden = true;

  on(banner, 'click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-consent="accept"], [data-consent="reject"]') : null;
    if (!target) return;
    const decision = target.getAttribute('data-consent') === 'accept' ? 'accept' : 'reject';
    ctx.consent.set(decision);
    banner.hidden = true;
    if (decision === 'accept') ctx.enableAds({ reason: 'aceptado por el usuario' });
  });

  return { banner };
}

/** Menú de navegación en móvil (accesible, con aria-expanded). */
export function initNav() {
  const toggle = qs('[data-nav-toggle]');
  const header = qs('[data-header]');
  if (!toggle || !header) return null;

  function setOpen(open) {
    header.setAttribute('data-nav-open', open ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  on(toggle, 'click', () => {
    const isOpen = header.getAttribute('data-nav-open') === 'true';
    setOpen(!isOpen);
  });

  on(document, 'keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  // Al pulsar un enlace del menú, se cierra.
  on(qs('[data-nav]'), 'click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
  });

  return { setOpen };
}
