/**
 * Formulario "quiero recibir información".
 *
 * - Validación en frontend (nombre, teléfono, ubicación, consentimiento).
 * - Sanitiza la entrada antes de construir el payload.
 * - **El contacto llega al WhatsApp del negocio** con nombre, teléfono y
 *   ubicación: es donde se puede responderle. Sin esto, el formulario solo
 *   dejaba el dato en el navegador del visitante y se perdía.
 * - Además se envía al CRM si hay endpoint; si no, queda en la cola local.
 * - Honeypot anti-spam (los bots rellenan el campo oculto).
 */

import { buildLeadPayload } from '../lib/api.js';
import { EVENTS, newEventId } from '../lib/tracking.js';
import { FIELD_LIMITS, sanitizeText, validateLead } from '../lib/validation.js';
import { clearFieldErrors, focusById, hideElement, on, qs, setAlert, setFieldError, showElement } from './dom.js';
import { buildLeadWhatsAppUrl } from './order-message.js';
import { openWhatsAppWindow } from './whatsapp-open.js';

/** @param {object} ctx */
export function initLeadForm(ctx) {
  const { tracker, view, crm } = ctx;
  const form = /** @type {HTMLFormElement|null} */ (qs('[data-lead-form]'));
  if (!form) return null;

  const alertBox = qs('[data-lead-alert]', form);
  const successPanel = qs('[data-lead-success]');
  const honeypot = /** @type {HTMLInputElement|null} */ (qs('#pe-lead-website', form));
  const submitButton = /** @type {HTMLButtonElement|null} */ (qs('[data-lead-submit]', form));
  /** Botón de WhatsApp del panel de éxito (lleva los datos ya escritos). */
  const leadLink = /** @type {HTMLAnchorElement|null} */ (qs('[data-lead-whatsapp]', successPanel ?? document));

  const FOCUS_IDS = {
    name: 'pe-lead-name',
    phone: 'pe-lead-phone',
    location: 'pe-lead-location',
    consent: 'pe-lead-consent',
  };

  on(form, 'submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    setAlert(alertBox, '');

    // Honeypot: si un bot lo rellena, simulamos éxito sin enviar nada.
    if (honeypot && honeypot.value.trim() !== '') {
      hideElement(form);
      showElement(successPanel);
      return;
    }

    const data = new FormData(form);
    const result = validateLead(
      {
        name: data.get('name'),
        phone: data.get('phone'),
        location: data.get('location'),
        consent: data.get('consent') === 'on',
      },
      { requireLocation: false },
    );

    if (!result.ok) {
      for (const [field, code] of Object.entries(result.errors)) {
        setFieldError(form, field, view.content.errors[code] ?? view.content.errors.generic);
      }
      setAlert(alertBox, view.content.leadForm.errorSummary);
      const first = Object.keys(result.errors)[0];
      if (FOCUS_IDS[first]) focusById(FOCUS_IDS[first]);
      tracker.trackEvent('form_error', { form: 'lead', fields: Object.keys(result.errors) });
      return;
    }

    if (submitButton) submitButton.disabled = true;

    const lead = {
      name: result.values.name,
      phone: result.values.phone,
      location: sanitizeText(result.values.location, FIELD_LIMITS.location),
    };

    /*
     * `event_id` del `Lead`: se genera AQUÍ, antes de enviar al CRM, para que el
     * mismo identificador viaje en el payload y en el píxel del navegador. Con
     * eso Meta deduplica las dos copias (píxel + API de conversiones).
     */
    const leadEventId = newEventId(EVENTS.LEAD);

    const payload = buildLeadPayload({
      name: lead.name,
      phone: lead.phone,
      location: lead.location,
      source: 'formulario',
      consent: true,
      consentVersion: view.site.crm.consentTextVersion,
      attribution: ctx.getAttribution(),
      productId: view.product.id,
      sessionId: ctx.sessionId(),
      // El `event_id` viaja con el lead: el CRM reenvía el mismo `Lead` por CAPI.
      meta: { events: { lead: leadEventId }, sourceUrl: ctx.currentUrl?.() ?? null },
    });

    // 1) WhatsApp: SÍNCRONO y antes de cualquier `await`, para conservar el gesto
    //    del usuario (si se abre después de esperar al CRM, el navegador lo
    //    bloquea). El botón del panel de éxito lleva el mismo enlace, así que si
    //    el navegador bloqueó la pestaña el contacto sale igual al pulsarlo.
    const url = buildLeadWhatsAppUrl(ctx, lead);
    if (url && leadLink) leadLink.href = url;
    const opened = openWhatsAppWindow(url);

    if (url) {
      tracker.trackEvent(EVENTS.CLICK_WHATSAPP, {
        source: 'formulario',
        context: 'lead_form',
        leadId: payload.id,
        ref: ctx.getAttributionRef(),
        opened,
      });
    }

    // 2) Lead al CRM (o a la cola local mientras no haya endpoint).
    const response = await crm.submitLead(payload);

    tracker.trackEvent(
      EVENTS.LEAD,
      {
        source: 'formulario',
        channel: 'form',
        productId: view.product.id,
        productName: view.product.name,
        leadId: payload.id,
        queued: response.queued,
        consent: true,
      },
      { eventId: leadEventId },
    );

    if (submitButton) submitButton.disabled = false;

    hideElement(form);
    showElement(successPanel);
    if (successPanel instanceof HTMLElement) successPanel.focus();
  });

  return { form };
}
