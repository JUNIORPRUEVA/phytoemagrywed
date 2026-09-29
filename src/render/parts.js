/**
 * Partes fijas de la página: skip link, header, barra móvil, footer,
 * modal de pedido y banner de consentimiento.
 */

import { attr, escapeHtml } from './html.js';
import { icon } from './icons.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from '../lib/whatsapp.js';

/** Botón/enlace de WhatsApp (funciona sin JS: href ya construido). */
export function whatsAppAction(view, { source, message, className = 'pe-btn pe-btn--whatsapp', label, size = null, block = false }) {
  if (!view.whatsapp.enabled) return '';
  const url = buildWhatsAppUrl({
    number: view.whatsapp.number,
    message: buildWhatsAppMessage({
      template: message ?? view.whatsapp.defaultMessage,
      data: { labels: view.whatsapp.labels },
    }),
  });
  if (!url) return '';
  return `<a class="${className}${size ? ` pe-btn--${size}` : ''}${block ? ' pe-btn--block' : ''}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-action="whatsapp" data-source="${escapeHtml(source)}">${icon('whatsapp', { size: 20 })}<span>${escapeHtml(label ?? view.content.hero.ctaSecondary)}</span></a>`;
}

/** Botón "Comprar" (abre el modal de pedido). */
export function buyAction({ source, label, className = 'pe-btn pe-btn--primary', size = null, block = false }) {
  return `<button type="button" class="${className}${size ? ` pe-btn--${size}` : ''}${block ? ' pe-btn--block' : ''}" data-action="buy" data-source="${source}">${icon('cart', { size: 20 })}<span>${label}</span></button>`;
}

export function renderSkipLink(view) {
  return `<a class="pe-skip" href="#contenido">${escapeHtml(view.content.a11y.skipToContent)}</a>`;
}

export function renderHeader(view) {
  const { content } = view;
  const links = content.nav.links
    // Los enlaces con `requires` solo se muestran si esa sección se publica
    // (p. ej. "Comunidad" cuando la comunidad está activada).
    .filter((link) => !link.requires || view.flags[link.requires] === true)
    .map(
      (link) =>
        `<li><a class="pe-nav__link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`,
    )
    .join('');

  const logo = view.site.brand.logo
    ? `<img src="${escapeHtml(view.site.brand.logo)}" alt="${escapeHtml(view.site.brand.logoAlt)}" width="140" height="36" decoding="async">`
    : `<span class="pe-logo__text">${escapeHtml(view.site.brand.name)}</span>`;

  return `<header class="pe-header" data-header>
      <div class="pe-container pe-header__inner">
        <a class="pe-logo" href="/" aria-label="${escapeHtml(view.site.brand.name)} — inicio">${logo}</a>

        <nav class="pe-nav" id="pe-nav" aria-label="Navegación principal" data-nav>
          <ul class="pe-nav__list">${links}</ul>
        </nav>

        <div class="pe-header__actions">
          ${buyAction({ source: 'header', label: content.nav.cta, size: 'sm' })}
          <button type="button" class="pe-nav-toggle" data-nav-toggle aria-expanded="false" aria-controls="pe-nav" aria-label="${escapeHtml(content.nav.menuLabel)}">
            ${icon('menu', { size: 22, className: 'pe-nav-toggle__open' })}
            ${icon('close', { size: 22, className: 'pe-nav-toggle__close' })}
          </button>
        </div>
      </div>
    </header>`;
}

export function renderMobileBar(view) {
  if (!view.flags.mobileCtaBar) return '';
  return `<div class="pe-mobile-bar" data-mobile-bar role="group" aria-label="Acciones rápidas">
      ${buyAction({ source: 'mobilebar', label: view.content.nav.cta, className: 'pe-btn pe-btn--primary pe-btn--block' })}
      ${whatsAppAction(view, { source: 'mobilebar', label: 'WhatsApp', className: 'pe-btn pe-btn--whatsapp pe-btn--block' })}
    </div>`;
}

export function renderFooter(view) {
  const { content, site, flags } = view;

  const commerceItems = [];
  if (flags.payments) {
    commerceItems.push(
      `<li><strong>Métodos de pago:</strong> ${site.commerce.paymentMethods.map((m) => escapeHtml(m)).join(', ')}</li>`,
    );
  }
  if (flags.delivery) commerceItems.push(`<li><strong>Entrega:</strong> ${escapeHtml(site.commerce.delivery)}</li>`);
  if (site.commerce.deliveryCoverage) {
    commerceItems.push(`<li><strong>Cobertura:</strong> ${escapeHtml(site.commerce.deliveryCoverage)}</li>`);
  }
  if (flags.returns) commerceItems.push(`<li><strong>Cambios y devoluciones:</strong> ${escapeHtml(site.commerce.returns)}</li>`);

  const contactItems = [
    view.whatsapp.enabled
      ? `<li><a class="pe-link" href="${escapeHtml(
          buildWhatsAppUrl({
            number: view.whatsapp.number,
            message: buildWhatsAppMessage({
              template: view.whatsapp.defaultMessage,
              data: { labels: view.whatsapp.labels },
            }),
          }) ?? '#',
        )}" target="_blank" rel="noopener noreferrer" data-action="whatsapp" data-source="footer">${
          // Con el número a la vista la confianza es mayor: se ve que hay alguien
          // detrás y se puede guardar/copiar para escribir más tarde.
          view.whatsapp.displayNumber
            ? `WhatsApp: ${escapeHtml(view.whatsapp.displayNumber)}`
            : 'WhatsApp'
        }</a></li>`
      : '',
    flags.email ? `<li><a class="pe-link" href="mailto:${escapeHtml(site.contact.email)}">${escapeHtml(site.contact.email)}</a></li>` : '',
    view.whatsapp.hours ? `<li>${escapeHtml(view.whatsapp.hours)}</li>` : '',
  ];

  const legalItems = [
    `<li><a class="pe-link" href="${escapeHtml(site.privacy.privacyPath)}">${escapeHtml(content.legal.privacyTitle)}</a></li>`,
    `<li><a class="pe-link" href="${escapeHtml(site.privacy.termsPath)}">${escapeHtml(content.legal.termsTitle)}</a></li>`,
    content.footer.disclaimer ? `<li>${escapeHtml(content.footer.disclaimer)}</li>` : '',
  ];

  return `<footer class="pe-footer" id="pie">
      <div class="pe-container pe-footer__grid">
        <div class="pe-footer__col">
          <p class="pe-footer__brand">${escapeHtml(site.brand.name)}</p>
          ${content.footer.about ? `<p class="pe-footer__text">${escapeHtml(content.footer.about)}</p>` : ''}
        </div>
        ${contactItems.some(Boolean) ? `<div class="pe-footer__col"><h2 class="pe-footer__title">${escapeHtml(content.footer.contactTitle)}</h2><ul class="pe-footer__list">${contactItems.join('')}</ul></div>` : ''}
        ${commerceItems.length > 0 ? `<div class="pe-footer__col"><h2 class="pe-footer__title">${escapeHtml(content.footer.commerceTitle)}</h2><ul class="pe-footer__list">${commerceItems.join('')}</ul></div>` : ''}
        <div class="pe-footer__col"><h2 class="pe-footer__title">${escapeHtml(content.footer.legalTitle)}</h2><ul class="pe-footer__list">${legalItems.join('')}</ul></div>
      </div>
      <div class="pe-container pe-footer__bottom">
        <p class="pe-footer__rights">${escapeHtml(content.footer.rights)}</p>
      </div>
    </footer>`;
}

export function renderConsentBanner(view) {
  if (!view.flags.consentBanner) return '';
  const { consent } = view.content;
  return `<div class="pe-consent" data-consent hidden role="region" aria-label="${escapeHtml(consent.title)}">
      <div class="pe-consent__inner">
        <p class="pe-consent__text"><strong>${escapeHtml(consent.title)}.</strong> ${escapeHtml(consent.text)} <a class="pe-link" href="${escapeHtml(view.site.privacy.privacyPath)}">${escapeHtml(consent.privacyLink)}</a></p>
        <div class="pe-consent__actions">
          <button type="button" class="pe-btn pe-btn--ghost pe-btn--sm" data-consent="reject">${escapeHtml(consent.reject)}</button>
          <button type="button" class="pe-btn pe-btn--primary pe-btn--sm" data-consent="accept">${escapeHtml(consent.accept)}</button>
        </div>
      </div>
    </div>`;
}

/**
 * Modal de pedido. Usa <dialog> nativo (ESC + foco + inert de fondo gratis).
 * Solo pide lo mínimo: nombre, teléfono, ubicación y cantidad.
 */
export function renderCheckoutDialog(view) {
  const { content, product, pricing } = view;
  const c = content.checkout;
  const max = view.maxQuantity;
  const defaultVariant =
    pricing.variants.find((variant) => variant.id === pricing.defaultVariantId) ?? pricing.variants[0] ?? null;
  const initialTotals = pricing.forQuantity(1);

  const row = (label, value, extra = '') =>
    `<div class="pe-summary__row"><dt>${escapeHtml(label)}</dt><dd>${value}${extra}</dd></div>`;

  const summaryRows = [
    row(
      c.labels.presentation,
      `<span data-summary-variant>${escapeHtml(defaultVariant?.name ?? c.labels.priceOnRequest)}</span>`,
      defaultVariant && view.flags.variants
        ? `<button type="button" class="pe-summary__change" data-change-variant>${escapeHtml(c.labels.changeVariant)}</button>`
        : '',
    ),
    row(
      c.labels.unitPrice,
      `<span data-summary-unit>${escapeHtml(defaultVariant?.priceLabel ?? c.labels.priceOnRequest)}</span>`,
    ),
    row(c.labels.quantity, `<span data-summary-qty>1</span>`),
    defaultVariant
      ? row(c.labels.totalCapsules, `<span data-summary-capsules>${initialTotals.totalCapsules}</span>`)
      : '',
  ]
    .filter(Boolean)
    .join('');

  return `<dialog class="pe-dialog" id="pe-checkout" aria-labelledby="pe-checkout-title" data-checkout>
      <header class="pe-dialog__head">
        <h2 class="pe-dialog__title" id="pe-checkout-title">${escapeHtml(c.title)}</h2>
        <button type="button" class="pe-dialog__close" data-checkout-close aria-label="${escapeHtml(c.closeLabel)}">${icon('close', { size: 22 })}</button>
      </header>

      <form class="pe-dialog__form" id="pe-checkout-form" novalidate>
        <div class="pe-dialog__body">
          <p class="pe-dialog__intro">${escapeHtml(c.intro)}</p>

          <dl class="pe-summary" data-summary>
            ${summaryRows}
            <div class="pe-summary__row pe-summary__row--total"><dt>${escapeHtml(c.labels.total)}</dt><dd><span data-summary-total>${escapeHtml(initialTotals.totalLabel ?? c.labels.priceOnRequest)}</span></dd></div>
          </dl>

          <div class="pe-field">
            <label class="pe-label" for="pe-co-name">${escapeHtml(c.labels.name)}</label>
            <input class="pe-input" id="pe-co-name" name="name" type="text" autocomplete="name" required maxlength="80" data-field="name">
            <p class="pe-error" data-error-for="name" hidden></p>
          </div>

          <div class="pe-field">
            <label class="pe-label" for="pe-co-phone">${escapeHtml(c.labels.phone)}</label>
            <input class="pe-input" id="pe-co-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="24" data-field="phone">
            <p class="pe-error" data-error-for="phone" hidden></p>
          </div>

          <div class="pe-field">
            <label class="pe-label" for="pe-co-location">${escapeHtml(c.labels.location)}</label>
            <input class="pe-input" id="pe-co-location" name="location" type="text" autocomplete="address-level2" required maxlength="120" data-field="location">
            <p class="pe-error" data-error-for="location" hidden></p>
          </div>

          <div class="pe-field">
            <label class="pe-label" for="pe-co-quantity">${escapeHtml(c.labels.quantity)}</label>
            <input class="pe-input pe-input--qty" id="pe-co-quantity" name="quantity" type="number" inputmode="numeric" min="1" max="${max}" step="1" value="1" required data-field="quantity">
            <p class="pe-hint">${escapeHtml(c.quantityHint(max))}</p>
            <p class="pe-error" data-error-for="quantity" hidden></p>
          </div>

          <div class="pe-field pe-field--check">
            <input class="pe-checkbox" id="pe-co-consent" name="consent" type="checkbox" required data-field="consent">
            <label class="pe-label pe-label--check" for="pe-co-consent">${escapeHtml(c.labels.consent)} <span class="pe-muted">(<a class="pe-link" href="${escapeHtml(view.site.privacy.privacyPath)}">${escapeHtml(content.leadForm.labels.privacyLink)}</a>)</span></label>
            <p class="pe-error" data-error-for="consent" hidden></p>
          </div>
        </div>

        <div class="pe-dialog__actions">
          <p class="pe-form__alert" data-form-alert role="alert" hidden></p>
          <button type="submit" class="pe-btn pe-btn--whatsapp pe-btn--block pe-btn--lg" data-checkout-submit${attr('data-whatsapp-enabled', view.whatsapp.enabled ? 'true' : 'false')}>
            ${icon('whatsapp', { size: 20 })}
            <span data-submit-label>${escapeHtml(view.whatsapp.enabled ? c.submit : c.submitFallback)}</span>
          </button>
          <p class="pe-dialog__note">${escapeHtml(c.note)}</p>
          ${view.whatsapp.enabled ? '' : `<p class="pe-dialog__note pe-warning">${escapeHtml(c.whatsappUnavailable)}</p>`}
        </div>
      </form>

      <div class="pe-success" data-checkout-success hidden role="status" tabindex="-1">
        <h3 class="pe-success__title">${escapeHtml(c.successTitle ?? 'Pedido preparado')}</h3>
        <p class="pe-success__text">${escapeHtml(c.successMessage)}</p>
        <p class="pe-success__fallback" data-whatsapp-fallback hidden>
          <a class="pe-btn pe-btn--whatsapp pe-btn--block" href="#" target="_blank" rel="noopener noreferrer" data-whatsapp-fallback-link>
            ${icon('whatsapp', { size: 20 })}<span>${escapeHtml(c.submit)}</span>
          </a>
        </p>
        <p class="pe-dialog__note pe-dialog__note--center">
          <button type="button" class="pe-btn pe-btn--ghost pe-btn--sm" data-checkout-close>${escapeHtml(c.closeLabel)}</button>
        </p>
      </div>
    </dialog>`;
}
