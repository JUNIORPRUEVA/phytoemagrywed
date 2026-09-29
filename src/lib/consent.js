/**
 * Consentimiento de cookies/medición publicitaria.
 *
 * Regla: si no hay Pixel ID ni dataLayer configurados, NO existe banner y no se
 * carga nada de terceros. Si existen, el banner aparece y solo tras "Aceptar"
 * se activa la medición publicitaria. La medición propia (analytics interno)
 * no depende de esto.
 */

import { createStorage } from './storage.js';

export const CONSENT_KEY = 'consent.ads';
export const CONSENT_VERSION = 1;

/** @typedef {'granted'|'denied'|null} ConsentState */
/** @typedef {'accept'|'reject'} ConsentDecision */

/**
 * @param {object} [deps]
 */
export function createConsent(deps = {}) {
  const storage = deps.storage ?? createStorage('pe', 'local');
  const now = deps.now ?? (() => new Date());

  return {
    /** @returns {ConsentState} */
    getState() {
      const stored = storage.get(CONSENT_KEY);
      if (!stored || stored.version !== CONSENT_VERSION) return null;
      return stored.state === 'granted' ? 'granted' : 'denied';
    },
    /** @param {ConsentDecision} decision */
    set(decision) {
      const state = decision === 'accept' ? 'granted' : 'denied';
      storage.set(CONSENT_KEY, { state, version: CONSENT_VERSION, decidedAt: now().toISOString() });
      return state;
    },
    /** @returns {boolean} */
    hasDecided() {
      return this.getState() !== null;
    },
    /** Solo la medición publicitaria depende del consentimiento. */
    adsAllowed() {
      return this.getState() === 'granted';
    },
    reset() {
      storage.remove(CONSENT_KEY);
    },
  };
}

export const consentStorage = createStorage('pe', 'local');
