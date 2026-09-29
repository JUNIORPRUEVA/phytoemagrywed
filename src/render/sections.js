/**
 * Secciones de la landing (render en build-time → HTML estático, bueno para SEO).
 * Cada sección decide si se muestra a partir de `view.flags`, de modo que
 * nunca aparece información vacía o inventada.
 */

import { attr, escapeHtml } from './html.js';
import { icon } from './icons.js';
import { HERO_SIZES, VARIANT_SIZES, renderPicture, renderImagePlaceholder } from './media.js';
import { buyAction, whatsAppAction } from './parts.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from '../lib/whatsapp.js';

const mediaHero = (view) =>
  view.images.hero
    ? renderPicture(view.images.hero, {
        loading: 'eager',
        fetchPriority: 'high',
        sizes: HERO_SIZES,
        className: 'pe-hero__picture',
      })
    : renderImagePlaceholder('Fotografía del producto pendiente');

/**
 * Bloque de precio.
 * @param {{ from?: boolean, size?: string }} [options] `from: true` muestra
 *   "Desde RD$1,250" (presentación más económica REAL, no un precio inventado).
 */
export function priceBlock(view, { size = 'md', from = false } = {}) {
  const { pricing, content } = view;
  const label = from ? pricing.fromLabel : pricing.unitPriceLabel;
  if (label) {
    return `<div class="pe-price-block pe-price-block--${size}">
        ${from ? `<span class="pe-price__from">${escapeHtml(content.hero.labels.from)}</span>` : ''}
        <span class="pe-price">${escapeHtml(label)}</span>
        ${pricing.availabilityLabel ? `<span class="pe-badge pe-badge--ok">${escapeHtml(pricing.availabilityLabel)}</span>` : ''}
      </div>`;
  }
  if (!view.flags.priceOnRequest) return '';
  return `<div class="pe-price-block pe-price-block--${size}">
      <span class="pe-price pe-price--on-request" aria-label="${escapeHtml(content.a11y.priceOnRequestAria)}">${escapeHtml(pricing.onRequestLabel)}</span>
      ${pricing.availabilityLabel ? `<span class="pe-badge pe-badge--ok">${escapeHtml(pricing.availabilityLabel)}</span>` : ''}
    </div>`;
}

/**
 * PORTADA PRINCIPAL.
 *
 * La imagen (panorámica con la línea completa de frascos) es la protagonista:
 * ya contiene el nombre del producto y los tamaños, así que NO se repite encima
 * ni se acumulan tarjetas, badges ni párrafos.
 *
 * El `<h1>` existe para SEO y lectores de pantalla, pero no se muestra: el
 * nombre ya está dentro de la imagen.
 */
export function renderHero(view) {
  const { product, content, flags } = view;

  return `<section class="pe-hero" id="inicio" aria-labelledby="pe-hero-title">
      <h1 class="pe-sr-only" id="pe-hero-title">${escapeHtml(product.name)}</h1>

      <div class="pe-hero__media">
        ${mediaHero(view)}
      </div>

      <div class="pe-container pe-hero__content">
        ${content.hero.lead ? `<p class="pe-hero__lead">${escapeHtml(content.hero.lead)}</p>` : ''}
        ${priceBlock(view, { size: 'lg', from: true })}
        <div class="pe-hero__cta">
          ${flags.variants && content.hero.ctaPrimary
            ? `<a class="pe-btn pe-btn--primary pe-btn--lg" href="#frascos" data-action="scroll-to-variants">${icon('arrowRight', { size: 20 })}<span>${escapeHtml(content.hero.ctaPrimary)}</span></a>`
            : ''}
          ${whatsAppAction(view, { source: 'hero', label: content.hero.ctaSecondary, size: 'lg' })}
        </div>
      </div>
    </section>`;
}

/**
 * Tarjeta de frasco: la unidad comercial del carrusel.
 *
 * Estructura (clave para que el botón de WhatsApp no interfiera con la
 * selección):
 *
 *   .pe-variant              contenedor de la tarjeta
 *     label.pe-variant__body  toda la tarjeta selecciona (el radio va dentro)
 *     a.pe-variant__cta       "Pedir por WhatsApp" DE ESE frasco (fuera del label)
 *
 * Muestra la foto real, "Frasco de N cápsulas" y el precio. La selección se marca
 * con borde de marca + check, sin badges de "mejor opción".
 *
 * El enlace de pedido se construye AQUÍ con esa misma presentación y cantidad 1,
 * así que el pedido sale completo aunque el visitante no tenga JavaScript; el
 * cliente lo recalcula con la cantidad elegida.
 */
function variantCard(view, variant) {
  const { content, pricing } = view;
  const selector = content.selector;
  const selected = variant.id === pricing.defaultVariantId;
  const badge = variant.completeBottle
    ? `<span class="pe-variant__badge">${escapeHtml(selector.completeBottleLabel)}</span>`
    : '';
  const image = variant.image
    ? `<span class="pe-variant__media">${renderPicture(variant.image, {
        sizes: VARIANT_SIZES,
        className: 'pe-variant__picture',
      })}</span>`
    : '';
  const orderUrl = variantOrderUrl(view, variant);

  return `<div class="pe-variant" data-variant-card="${escapeHtml(variant.id)}"${attr('data-selected', selected ? 'true' : 'false')}>
      <label class="pe-variant__body">
        <input class="pe-variant__input" type="radio" name="pe-variant" value="${escapeHtml(variant.id)}" data-variant-input${attr('checked', selected)}>
        <span class="pe-variant__check" aria-hidden="true">${icon('check', { size: 14 })}</span>
        ${image}
        <span class="pe-variant__info">
          <span class="pe-variant__prefix">${escapeHtml(selector.cardPrefix)}</span>
          <span class="pe-variant__capsules">${escapeHtml(variant.name)}</span>
          <span class="pe-variant__price">${escapeHtml(variant.priceLabel ?? selector.priceOnRequest)}</span>
          ${badge}
        </span>
      </label>
      ${
        orderUrl
          ? `<a class="pe-btn pe-btn--whatsapp pe-btn--sm pe-variant__cta" href="${escapeHtml(orderUrl)}" target="_blank" rel="noopener noreferrer" data-action="whatsapp-order" data-variant="${escapeHtml(variant.id)}" data-source="frascos">${icon('whatsapp', { size: 18 })}<span>${escapeHtml(selector.cardCta)}</span></a>`
          : ''
      }
    </div>`;
}

/**
 * Pedido de UN frasco en WhatsApp, con todos los datos ya escritos.
 * Se usa para el enlace estático de cada tarjeta (sin JavaScript): producto,
 * frasco, cápsulas del frasco, cantidad, precio por frasco y total.
 * @param {any} view
 * @param {any} variant
 * @param {number} [quantity]
 * @returns {string|null} null si no hay número de WhatsApp configurado
 */
function variantOrderUrl(view, variant, quantity = 1) {
  if (!view.whatsapp.enabled) return null;
  const totals = view.pricing.forVariant(variant.id, quantity);
  const message = buildWhatsAppMessage({
    template: view.content.whatsapp.checkout,
    data: {
      labels: view.whatsapp.labels,
      productName: view.product.name,
      variantName: variant.name,
      capsules: variant.capsules,
      quantity: totals.quantity,
      unitPriceLabel: totals.hasPrice ? totals.unitPriceLabel : null,
      totalLabel: totals.hasPrice ? totals.totalLabel : null,
      totalCapsules: totals.totalCapsules,
    },
  });
  return buildWhatsAppUrl({ number: view.whatsapp.number, message });
}

/**
 * SECCIÓN DE FRASCOS — el corazón comercial de la landing.
 *
 * Carrusel HORIZONTAL: se desliza de lado para ver las 7 fotos con su precio y
 * cada tarjeta tiene su propio botón "Pedir por WhatsApp" con el pedido completo.
 * Debajo, el resumen del pedido (cantidad de frascos y total) sirve para pedir
 * más de una unidad del frasco elegido.
 *
 * NO mezcla cápsulas con frascos: son dos cosas distintas.
 */
export function renderVariantSelector(view) {
  const { content, pricing, flags } = view;
  if (!flags.variants) return '';
  const selector = content.selector;
  const labels = selector.labels;
  const multiple = pricing.variants.length > 1;
  const defaultVariant = pricing.variants.find((variant) => variant.id === pricing.defaultVariantId) ?? pricing.variants[0];
  const totals = pricing.forQuantity(1);
  const max = pricing.bounds.max;

  // Enlace de WhatsApp ya construido para la presentación por defecto: así
  // funciona incluso sin JavaScript. El cliente lo recalcula al cambiar.
  const waUrl = variantOrderUrl(view, defaultVariant, 1);

  return `<section class="pe-section pe-section--variants" id="frascos" aria-labelledby="pe-frascos-title">
      <div class="pe-container">
        <h2 class="pe-section__title" id="pe-frascos-title">${escapeHtml(selector.title)}</h2>
        ${selector.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(selector.subtitle)}</p>` : ''}

        ${
          multiple
            ? `<div class="pe-carousel__head">
          <p class="pe-carousel__hint">${icon('arrowRight', { size: 16, className: 'pe-carousel__hint-icon' })}<span>${escapeHtml(selector.swipeHint)}</span></p>
          <div class="pe-carousel__nav" hidden>
            <button type="button" class="pe-carousel__btn" data-carousel-prev aria-label="${escapeHtml(selector.carousel.prev)}">${icon('chevronLeft', { size: 20 })}</button>
            <button type="button" class="pe-carousel__btn" data-carousel-next aria-label="${escapeHtml(selector.carousel.next)}">${icon('chevronRight', { size: 20 })}</button>
          </div>
        </div>`
            : ''
        }

        <fieldset class="pe-variants" data-variants${attr('data-carousel', multiple)}>
          <legend class="pe-sr-only">${escapeHtml(selector.title)}</legend>
          ${pricing.variants.map((variant) => variantCard(view, variant)).join('')}
        </fieldset>

        <div class="pe-order" data-order>
          <dl class="pe-order__summary">
            <div class="pe-order__row">
              <dt>${escapeHtml(labels.selected)}</dt>
              <dd data-summary-variant>${escapeHtml(defaultVariant.name)}</dd>
            </div>
            <div class="pe-order__row">
              <dt>${escapeHtml(labels.unitPrice)}</dt>
              <dd data-summary-unit>${escapeHtml(defaultVariant.priceLabel ?? selector.priceOnRequest)}</dd>
            </div>
            <div class="pe-order__row pe-order__row--qty">
              <dt>${escapeHtml(labels.quantity)}</dt>
              <dd>
                <div class="pe-stepper">
                  <button type="button" class="pe-stepper__btn" data-qty-decrease aria-label="${escapeHtml(labels.decrease)}">−</button>
                  <input class="pe-stepper__input" id="pe-qty" type="number" inputmode="numeric" min="${pricing.bounds.min}" max="${max}" step="1" value="1" data-qty-input aria-label="${escapeHtml(labels.quantity)}">
                  <button type="button" class="pe-stepper__btn" data-qty-increase aria-label="${escapeHtml(labels.increase)}">+</button>
                </div>
              </dd>
            </div>
            <div class="pe-order__row">
              <dt>${escapeHtml(labels.totalCapsules)}</dt>
              <dd data-summary-capsules>${escapeHtml(String(totals.totalCapsules ?? ''))}</dd>
            </div>
            <div class="pe-order__row pe-order__row--total">
              <dt>${escapeHtml(labels.total)}</dt>
              <dd data-summary-total>${escapeHtml(totals.totalLabel ?? selector.priceOnRequest)}</dd>
            </div>
          </dl>
          <p class="pe-hint">${escapeHtml(labels.quantityHint(max))}</p>

          <div class="pe-order__cta">
            ${buyAction({ source: 'selector', label: selector.ctaBuy, size: 'lg' })}
            ${
              waUrl
                ? `<a class="pe-btn pe-btn--whatsapp pe-btn--lg" href="${escapeHtml(waUrl)}" target="_blank" rel="noopener noreferrer" data-action="whatsapp-order" data-source="selector">${icon('whatsapp', { size: 20 })}<span>${escapeHtml(selector.ctaWhatsApp)}</span></a>`
                : ''
            }
          </div>
          ${selector.note ? `<p class="pe-note pe-note--small">${escapeHtml(selector.note)}</p>` : ''}
          ${/* Enlace discreto para quien todavía no está listo para comprar. */ ''}
          ${selector.communityLink && view.flags.community
            ? `<p class="pe-order__community">${icon('chat', { size: 18, className: 'pe-order__community-icon' })}<span>${escapeHtml(selector.communityLink.lead)}</span> <a class="pe-link" href="${escapeHtml(selector.communityLink.href)}" data-action="scroll-to-community">${escapeHtml(selector.communityLink.label)}</a></p>`
            : ''}
          ${
            // Cliente potencial: quien no quiere pedir hoy deja su contacto aquí
            // mismo, sin tener que bajar hasta el formulario.
            selector.contactLink && flags.leadForm
              ? `<p class="pe-order__contact">${icon('user', { size: 18, className: 'pe-order__contact-icon' })}<span>${escapeHtml(selector.contactLink.lead)}</span> <a class="pe-link" href="${escapeHtml(selector.contactLink.href)}" data-action="scroll-to-contact">${escapeHtml(selector.contactLink.label)}</a></p>`
              : ''
          }
        </div>
      </div>
    </section>`;
}

export function renderFeatures(view) {
  if (!view.flags.features) return '';
  const { content, lists } = view;
  const cards = lists.features
    .map(
      (item) => `<li class="pe-card">
        <span class="pe-card__icon">${icon(item.icon ?? 'leaf', { size: 24 })}</span>
        <h3 class="pe-card__title">${escapeHtml(item.title)}</h3>
        ${item.text ? `<p class="pe-card__text">${escapeHtml(item.text)}</p>` : ''}
      </li>`,
    )
    .join('');

  return `<section class="pe-section pe-section--alt" id="caracteristicas" aria-labelledby="pe-caracteristicas-title">
      <div class="pe-container">
        <h2 class="pe-section__title" id="pe-caracteristicas-title">${escapeHtml(content.features.title)}</h2>
        ${content.features.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(content.features.subtitle)}</p>` : ''}
        <ul class="pe-cards">${cards}</ul>
      </div>
    </section>`;
}

/**
 * FICHA DEL PRODUCTO: información del producto + modo de uso destacado +
 * ficha técnica. La selección de frasco vive en su propia sección.
 */
export function renderProductInfo(view) {
  if (!view.flags.productInfo) return '';
  const { product, content, flags, lists } = view;
  const labels = content.presentation.labels;
  const paragraphs = [product.description, ...lists.blocks.map((block) => block.text)].filter(Boolean);

  // El modo de uso se muestra destacado (no como una fila más de la ficha).
  const usage = product.usage
    ? `<p class="pe-usage"><span class="pe-usage__label">${escapeHtml(labels.usage)}</span><strong class="pe-usage__value">${escapeHtml(product.usage)}</strong></p>`
    : '';

  // Afirmación de confianza aprobada por el negocio (línea discreta, con icono).
  const trust = view.trust?.claim
    ? `<p class="pe-trust"><span class="pe-trust__icon" aria-hidden="true">${icon('users', { size: 20 })}</span><span>${escapeHtml(view.trust.claim)}</span></p>`
    : '';

  const rows = [
    [labels.presentation, product.presentation],
    [labels.contents, product.contents],
    [labels.netWeight, product.netWeight],
    [labels.ingredients, product.ingredients],
    [labels.origin, product.origin],
    [labels.manufacturer, product.manufacturer],
    [labels.regulatory, product.regulatory],
  ]
    .filter(([, value]) => Boolean(value))
    .map(
      ([label, value]) => `<div class="pe-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    );

  const certifications =
    Array.isArray(product.certifications) && product.certifications.length > 0
      ? `<ul class="pe-tags">${product.certifications.map((c) => `<li class="pe-tag">${escapeHtml(c)}</li>`).join('')}</ul>`
      : '';

  const gallery = flags.gallery
    ? `<ul class="pe-gallery">${view.images.gallery
        .map(
          (image) =>
            `<li class="pe-gallery__item">${renderPicture(image, { sizes: '(min-width: 768px) 280px, 45vw', className: 'pe-gallery__picture' })}</li>`,
        )
        .join('')}</ul>`
    : '';

  const media = view.images.presentation
    ? renderPicture(view.images.presentation, { sizes: '(min-width: 1024px) 480px, 92vw', className: 'pe-presentation__picture' })
    : '';

  const hasBody =
    paragraphs.length > 0 || rows.length > 0 || usage !== '' || trust !== '' || media !== '' || gallery !== '';
  if (!hasBody) {
    // Sin información oficial todavía: se avisa de forma honesta (nada inventado).
    return `<section class="pe-section" id="producto" aria-labelledby="pe-producto-title">
        <div class="pe-container">
          <h2 class="pe-section__title" id="pe-producto-title">${escapeHtml(content.product.title)}</h2>
          <p class="pe-note pe-note--info">${escapeHtml(content.product.pendingNotice)}</p>
        </div>
      </section>`;
  }

  return `<section class="pe-section" id="producto" aria-labelledby="pe-producto-title">
      <div class="pe-container pe-presentation">
        ${media || gallery ? `<div class="pe-presentation__media">${media}${gallery}</div>` : ''}
        <div class="pe-presentation__content">
          <h2 class="pe-section__title" id="pe-producto-title">${escapeHtml(content.product.title)}</h2>
          ${paragraphs.length > 0
            ? `<div class="pe-products__body">${paragraphs
                .map((text, index) => `<p class="pe-prose${index === 0 ? ' pe-prose--lead' : ''}">${escapeHtml(text)}</p>`)
                .join('')}</div>`
            : `<p class="pe-note pe-note--info">${escapeHtml(content.product.pendingNotice)}</p>`}
          ${trust}
          ${usage}
          ${rows.length > 0 ? `<dl class="pe-facts pe-facts--stacked">${rows.join('')}</dl>` : ''}
          ${certifications}
          ${product.warnings ? `<p class="pe-note pe-note--warn">${escapeHtml(product.warnings)}</p>` : ''}
        </div>
      </div>
    </section>`;
}

/**
 * COMUNIDAD — uno de los bloques de confianza de la landing.
 *
 * - Se coloca ANTES del CTA final: es el camino para quien todavía no está
 *   listo para comprar (no es un Lead ni una compra).
 * - Un solo enlace (el grupo disponible de mayor prioridad), elegido en config.
 * - Sin avatares ni fotos que aparenten clientes reales.
 * - La cifra de miembros solo se publica si está verificada en configuración.
 */
export function renderCommunity(view) {
  if (!view.flags.community) return '';
  const { content, community, lists } = view;
  const group = community.active;
  const c = content.community;

  const cards = view.flags.communityCards
    ? `<ul class="pe-community__cards">${lists.communityCards
        .map(
          (card) => `<li class="pe-community__card">
        <span class="pe-community__card-icon" aria-hidden="true">${icon(card.icon ?? 'chat', { size: 22 })}</span>
        <h3 class="pe-community__card-title">${escapeHtml(card.title)}</h3>
        ${card.text ? `<p class="pe-community__card-text">${escapeHtml(card.text)}</p>` : ''}
      </li>`,
        )
        .join('')}</ul>`
    : '';

  return `<section class="pe-section pe-section--community" id="comunidad" aria-labelledby="pe-comunidad-title">
      <div class="pe-container">
        <div class="pe-community">
          <div class="pe-community__intro">
            <span class="pe-community__icon" aria-hidden="true">${icon('users', { size: 26 })}</span>
            ${c.eyebrow ? `<p class="pe-eyebrow pe-community__eyebrow">${escapeHtml(c.eyebrow)}</p>` : ''}
            <h2 class="pe-section__title pe-community__title" id="pe-comunidad-title">${escapeHtml(c.title)}</h2>
            ${c.text ? `<p class="pe-community__text">${escapeHtml(c.text)}</p>` : ''}
            ${c.secondText ? `<p class="pe-community__text pe-community__text--soft">${escapeHtml(c.secondText)}</p>` : ''}
            ${community.memberClaim ? `<p class="pe-community__claim">${escapeHtml(String(community.memberClaim))}</p>` : ''}
          </div>

          <div class="pe-community__action">
            <a class="pe-btn pe-btn--whatsapp pe-btn--lg pe-btn--block" href="${escapeHtml(group.url)}" target="_blank" rel="noopener noreferrer" data-action="community" data-group="${escapeHtml(group.id)}" data-group-name="${escapeHtml(group.name)}" data-source-section="comunidad">${icon('whatsapp', { size: 20 })}<span>${escapeHtml(c.cta)}</span></a>
            ${c.ctaNote ? `<p class="pe-community__micro">${escapeHtml(c.ctaNote)}</p>` : ''}
          </div>

          ${cards}

          ${c.disclaimer ? `<p class="pe-note pe-note--small pe-community__disclaimer">${escapeHtml(c.disclaimer)}</p>` : ''}
        </div>
      </div>
    </section>`;
}

export function renderHowToBuy(view) {
  if (!view.flags.steps) return '';
  const { content, lists } = view;
  const steps = lists.steps
    .map(
      (step, index) => `<li class="pe-step">
        <span class="pe-step__num" aria-hidden="true">${index + 1}</span>
        <h3 class="pe-step__title"><span class="pe-sr-only">Paso ${index + 1}: </span>${escapeHtml(step.title)}</h3>
        ${step.text ? `<p class="pe-step__text">${escapeHtml(step.text)}</p>` : ''}
      </li>`,
    )
    .join('');

  return `<section class="pe-section pe-section--alt" id="como-comprar" aria-labelledby="pe-como-comprar-title">
      <div class="pe-container">
        <h2 class="pe-section__title" id="pe-como-comprar-title">${escapeHtml(content.howToBuy.title)}</h2>
        ${content.howToBuy.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(content.howToBuy.subtitle)}</p>` : ''}
        <ol class="pe-steps">${steps}</ol>
        ${content.howToBuy.note ? `<p class="pe-note">${escapeHtml(content.howToBuy.note)}</p>` : ''}
      </div>
    </section>`;
}

export function renderFaq(view) {
  if (!view.flags.faq) return '';
  const { content, lists } = view;
  const items = lists.faqItems
    .map(
      (item, index) => `<details class="pe-faq__item"${index === 0 ? ' open' : ''}>
        <summary class="pe-faq__question">
          <span>${escapeHtml(item.question)}</span>
          ${icon('chevronDown', { size: 20, className: 'pe-faq__chevron' })}
        </summary>
        <div class="pe-faq__answer"><p>${escapeHtml(item.answer)}</p></div>
      </details>`,
    )
    .join('');

  return `<section class="pe-section" id="preguntas" aria-labelledby="pe-preguntas-title">
      <div class="pe-container pe-container--narrow">
        <h2 class="pe-section__title" id="pe-preguntas-title">${escapeHtml(content.faq.title)}</h2>
        ${content.faq.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(content.faq.subtitle)}</p>` : ''}
        <div class="pe-faq">${items}</div>
      </div>
    </section>`;
}

export function renderTestimonials(view) {
  if (!view.flags.testimonials) return '';
  const { content, lists } = view;
  const cards = lists.testimonials
    .map((item) => {
      const photo = item.photo
        ? `<img class="pe-testimonial__photo" src="${escapeHtml(item.photo)}" alt="" width="48" height="48" loading="lazy" decoding="async">`
        : `<span class="pe-testimonial__avatar" aria-hidden="true">${escapeHtml((item.name ?? '?').trim().charAt(0).toUpperCase())}</span>`;
      return `<li class="pe-testimonial">
        ${photo}
        <blockquote class="pe-testimonial__text">${escapeHtml(item.text)}</blockquote>
        <p class="pe-testimonial__meta">
          ${item.name ? `<span class="pe-testimonial__name">${escapeHtml(item.name)}</span>` : ''}
          ${item.date ? `<time class="pe-testimonial__date" datetime="${escapeHtml(item.date)}">${escapeHtml(item.date)}</time>` : ''}
        </p>
      </li>`;
    })
    .join('');

  return `<section class="pe-section pe-section--alt" id="opiniones" aria-labelledby="pe-opiniones-title">
      <div class="pe-container">
        <h2 class="pe-section__title" id="pe-opiniones-title">${escapeHtml(content.testimonials.title)}</h2>
        ${content.testimonials.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(content.testimonials.subtitle)}</p>` : ''}
        <ul class="pe-testimonials">${cards}</ul>
        ${content.testimonials.disclaimer ? `<p class="pe-note">${escapeHtml(content.testimonials.disclaimer)}</p>` : ''}
      </div>
    </section>`;
}

export function renderLeadForm(view) {
  // Bloque desactivable desde `site.config.js` → features.sections.leadForm.
  if (!view.flags.leadForm) return '';
  const { content, flags } = view;
  const f = content.leadForm;

  // Enlace de reserva (sin datos del visitante todavía): el cliente lo reescribe
  // con el nombre, el teléfono y la ubicación al enviar el formulario.
  const leadWaUrl = view.whatsapp.enabled
    ? buildWhatsAppUrl({
        number: view.whatsapp.number,
        message: buildWhatsAppMessage({
          template: content.whatsapp.lead,
          data: { labels: view.whatsapp.labels },
        }),
      })
    : null;

  return `<section class="pe-section" id="contacto" aria-labelledby="pe-contacto-title">
      <div class="pe-container pe-container--narrow">
        <h2 class="pe-section__title" id="pe-contacto-title">${escapeHtml(f.title)}</h2>
        ${f.subtitle ? `<p class="pe-section__subtitle">${escapeHtml(f.subtitle)}</p>` : ''}

        <form class="pe-form" id="pe-lead-form" novalidate data-lead-form>
          <p class="pe-form__alert" data-lead-alert role="alert" hidden></p>

          <div class="pe-field">
            <label class="pe-label" for="pe-lead-name">${escapeHtml(f.labels.name)}</label>
            <input class="pe-input" id="pe-lead-name" name="name" type="text" autocomplete="name" required maxlength="80" placeholder="${escapeHtml(f.placeholders.name)}" data-field="name">
            <p class="pe-error" data-error-for="name" hidden></p>
          </div>

          <div class="pe-field">
            <label class="pe-label" for="pe-lead-phone">${escapeHtml(f.labels.phone)}</label>
            <input class="pe-input" id="pe-lead-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="24" placeholder="${escapeHtml(f.placeholders.phone)}" data-field="phone">
            <p class="pe-error" data-error-for="phone" hidden></p>
          </div>

          <div class="pe-field">
            <label class="pe-label" for="pe-lead-location">${escapeHtml(f.labels.location)} <span class="pe-muted">(${escapeHtml(f.labels.locationOptional)})</span></label>
            <input class="pe-input" id="pe-lead-location" name="location" type="text" autocomplete="address-level2" maxlength="120" placeholder="${escapeHtml(f.placeholders.location)}" data-field="location">
            <p class="pe-error" data-error-for="location" hidden></p>
          </div>

          <!-- Honeypot anti-spam: invisible para personas, visible para bots. -->
          <div class="pe-honeypot" aria-hidden="true">
            <label for="pe-lead-website">${escapeHtml(f.labels.honeypot)}</label>
            <input id="pe-lead-website" name="website" type="text" tabindex="-1" autocomplete="off">
          </div>

          <div class="pe-field pe-field--check">
            <input class="pe-checkbox" id="pe-lead-consent" name="consent" type="checkbox" required data-field="consent">
            <label class="pe-label pe-label--check" for="pe-lead-consent">
              ${escapeHtml(f.labels.consent)}
              <span class="pe-muted">${escapeHtml(f.labels.privacyPrefix)} <a class="pe-link" href="${escapeHtml(view.site.privacy.privacyPath)}">${escapeHtml(f.labels.privacyLink)}</a>.</span>
            </label>
            <p class="pe-error" data-error-for="consent" hidden></p>
          </div>

          <button type="submit" class="pe-btn pe-btn--primary pe-btn--lg pe-btn--block" data-lead-submit>
            ${icon('arrowRight', { size: 20 })}
            <span>${escapeHtml(f.labels.submit)}</span>
          </button>
          <p class="pe-form__note">${escapeHtml(content.checkout.note)}</p>
        </form>

        ${
          // Camino directo para quien no quiere dejar datos todavía: ve el número
          // real y decide. Es la vía más rápida para resolver una duda.
          flags.whatsapp && f.direct
            ? `<p class="pe-direct">${icon('chat', { size: 18, className: 'pe-direct__icon' })}<span>${escapeHtml(f.direct.lead)}</span> ${whatsAppAction(view, { source: 'contacto', label: `${f.direct.cta}${view.whatsapp.displayNumber ? `: ${view.whatsapp.displayNumber}` : ''}`, className: 'pe-btn pe-btn--whatsapp pe-btn--sm pe-direct__cta' })}</p>`
            : ''
        }

        <div class="pe-success" data-lead-success hidden role="status" tabindex="-1">
          <h3 class="pe-success__title">${escapeHtml(f.success.title)}</h3>
          <p class="pe-success__text">${escapeHtml(f.success.text)}</p>
          ${
            // El enlace se reconstruye en el cliente con los datos que escribió el
            // visitante: así el contacto llega al WhatsApp del negocio con nombre,
            // teléfono y ubicación, y se puede responder.
            flags.whatsapp && f.success.cta
              ? `<a class="pe-btn pe-btn--whatsapp pe-btn--lg" href="${escapeHtml(leadWaUrl ?? '#')}" target="_blank" rel="noopener noreferrer" data-action="whatsapp" data-source="lead_success" data-lead-whatsapp>${icon('whatsapp', { size: 20 })}<span>${escapeHtml(f.success.cta)}</span></a>
                ${f.success.fallbackNote ? `<p class="pe-note pe-note--small">${escapeHtml(f.success.fallbackNote)}</p>` : ''}`
              : ''
          }
        </div>

        <noscript>
          <p class="pe-note pe-note--warn">Para enviar el formulario activa JavaScript, o escríbenos directamente${
            flags.email ? ` a <a class="pe-link" href="mailto:${escapeHtml(view.site.contact.email)}">${escapeHtml(view.site.contact.email)}</a>` : ' por WhatsApp'
          }.</p>
        </noscript>
      </div>
    </section>`;
}

export function renderFinalCta(view) {
  // Bloque desactivable desde `site.config.js` → features.sections.finalCta.
  if (!view.flags.finalCta) return '';
  const { content, product, flags } = view;
  return `<section class="pe-final" id="comprar" aria-labelledby="pe-final-title">
      <div class="pe-container pe-final__inner">
        <h2 class="pe-final__title" id="pe-final-title">${escapeHtml(content.finalCta.title)}</h2>
        <p class="pe-final__text">${escapeHtml(content.finalCta.text)}</p>
        ${priceBlock(view, { size: 'md', from: true })}
        <div class="pe-final__cta">
          ${buyAction({ source: 'final', label: content.finalCta.ctaPrimary, size: 'lg' })}
          ${whatsAppAction(view, { source: 'final', label: content.finalCta.ctaSecondary, size: 'lg' })}
        </div>
        ${flags.variants && content.finalCta.linkToSelector ? `<p class="pe-final__link"><a class="pe-link" href="#frascos" data-action="scroll-to-variants">${escapeHtml(content.finalCta.linkToSelector)}</a></p>` : ''}
        ${product.disclaimer ? `<p class="pe-note pe-note--small">${escapeHtml(product.disclaimer)}</p>` : ''}      </div>
    </section>`;
}
