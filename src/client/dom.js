/** Helpers mínimos de DOM (sin framework, sin dependencias). */

/** @param {string} selector @param {ParentNode} [scope] */
export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

/** @param {string} selector @param {ParentNode} [scope] */
export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

/**
 * @param {EventTarget} target
 * @param {string} type
 * @param {(event: any) => void} handler
 * @param {AddEventListenerOptions} [options]
 */
export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Muestra un mensaje de error en un campo del formulario. */
export function setFieldError(scope, field, message) {
  const input = qs(`[data-field="${field}"]`, scope);
  const box = qs(`[data-error-for="${field}"]`, scope);
  if (input) {
    if (input instanceof HTMLElement) {
      input.setAttribute('aria-invalid', 'true');
      if (box) {
        if (!box.id) box.id = `${input.id || field}-error`;
        input.setAttribute('aria-describedby', box.id);
      }
    }
  }
  if (box) {
    box.textContent = message ?? '';
    box.hidden = !message;
  }
}

/** Limpia los errores (todos o los de un campo concreto). */
export function clearFieldErrors(scope, field = null) {
  const boxes = field ? qsa(`[data-error-for="${field}"]`, scope) : qsa('[data-error-for]', scope);
  for (const box of boxes) {
    box.textContent = '';
    box.hidden = true;
  }
  const inputs = field ? qsa(`[data-field="${field}"]`, scope) : qsa('[data-field]', scope);
  for (const input of inputs) {
    input.removeAttribute('aria-invalid');
  }
}

/** @param {HTMLElement|null} element */
export function showElement(element) {
  if (element) element.hidden = false;
}

/** @param {HTMLElement|null} element */
export function hideElement(element) {
  if (element) element.hidden = true;
}

/** @param {HTMLElement} element @param {string} message */
export function setAlert(element, message) {
  if (!element) return;
  element.textContent = message ?? '';
  element.hidden = !message;
}

/** @param {string} id */
export function focusById(id) {
  const element = document.getElementById(id);
  if (element instanceof HTMLElement) element.focus({ preventScroll: false });
}

/** ¿El usuario prefiere menos movimiento? */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
