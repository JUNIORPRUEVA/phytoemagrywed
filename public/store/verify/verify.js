/**
 * CONFIRMACIÓN DEL TELÉFONO — paso previo a pedir o solicitar en FULLTECH Store.
 *
 * El navegador NUNCA decide si el número está confirmado: pregunta al servidor
 * (`/api/store/account/verification`) y solo muestra el éxito cuando la API
 * devuelve `verified: true`. Si el envío de SMS no está activo, se dice con
 * claridad en vez de simular un código enviado.
 */
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const panel = $('#verify-panel');
const loading = $('#verify-loading');
const params = new URLSearchParams(location.search);

/* Solo rutas internas de la tienda: nunca un destino externo. */
const rawNext = params.get('next') || '';
const next = /^\/store\//.test(rawNext) ? rawNext : '';

const state = {
  phone: null,
  orderNumber: '',
  busy: false,
};

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'No pudimos completar la operación. Inténtalo de nuevo.');
    error.code = data.error || '';
    error.data = data;
    throw error;
  }
  return data;
}

function show(html) {
  loading.hidden = true;
  panel.hidden = false;
  panel.innerHTML = html;
}


function renderLogin() {
  show(`<div class="verify-head"><span class="eyebrow">FULLTECH STORE</span><h1>Entra para guardar tu número</h1><p>Necesitamos identificarte antes de guardar tus datos de contacto.</p></div>
    <div class="verify-card"><div class="account-actions" style="margin:0">
      <a class="button" href="/store/#/account/login">Entrar</a>
      <a class="button button-outline" href="/store/#/account/register">Crear cuenta</a>
    </div></div>`);
}

function renderSaved() {
  const target = next || '/store/#/account';
  show(`<div class="verify-done">
    <span class="success-icon" aria-hidden="true">✓</span>
    <h1>Número guardado</h1>
    <p>${state.phone?.masked ? `Guardamos ${esc(state.phone.masked)}.` : 'Ya tenemos tu número.'} Lo usaremos para coordinar tu entrega.</p>
    <span class="verify-badge">Sin confirmar</span>
    <p class="verify-hint">Puedes comprar y solicitar productos con este número. No te pediremos un código.</p>
    <div class="account-actions" style="justify-content:center">
      <a class="button" href="${esc(target)}">Continuar</a>
      <button class="button button-outline" type="button" id="change-phone">Cambiar número</button>
    </div>
  </div>`);
  $('#change-phone').onclick = () => renderForm('');
}

function renderForm(message = '', needsProof = false) {
  const masked = state.phone?.masked;
  show(`<div class="verify-head"><span class="eyebrow">FULLTECH STORE</span><h1>${needsProof ? 'Confirma que es tu número' : 'Agrega tu número de teléfono'}</h1>
    <p>${needsProof ? 'Ese número ya tiene historial con nosotros. Para enlazar tus pedidos, escribe el número de uno de ellos.' : 'Lo necesitamos para coordinar la entrega de tu pedido.'}</p></div>
  <div class="verify-card">
    <form class="verify-form" id="phone-form" novalidate>
      <label class="field"><span class="field__label">Número de celular</span>
        <input class="field__input" id="phone-input" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="809 000 0000" aria-describedby="phone-hint">
      </label>
      <small class="field-help" id="phone-hint">República Dominicana: 809, 829 y 849.</small>
      <label class="field" id="proof-field" ${needsProof ? '' : 'hidden'}><span class="field__label">Número de un pedido anterior</span>
        <input class="field__input" id="proof-input" name="orderNumber" maxlength="60" placeholder="Ej. PE-123456">
      </label>
      <p class="verify-error" id="verify-error" role="alert">${esc(message)}</p>
      <button class="button button-block" type="submit" id="phone-submit">Guardar número</button>
    </form>
    <p class="verify-hint">No enviamos códigos por ahora. Guardar el número no confirma que sea tuyo: eso vendrá después.</p>
    ${masked ? `<p class="verify-hint">Número actual: ${esc(masked)}.</p>` : ''}
  </div>`);

  const form = $('#phone-form');
  const input = $('#phone-input');
  input.focus();
  if (needsProof) $('#proof-input').value = state.orderNumber || '';

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const value = input.value.trim();
    if (!/\d{7,}/.test(value)) {
      $('#verify-error').textContent = 'Escribe tu número de teléfono.';
      input.focus();
      return;
    }
    const orderNumber = ($('#proof-input')?.value || '').trim();
    state.orderNumber = orderNumber;
    state.busy = true;
    const button = $('#phone-submit');
    button.disabled = true;
    button.textContent = 'Guardando…';
    $('#verify-error').textContent = '';
    try {
      const data = await request('/api/store/account/phone', { method: 'POST', body: { phone: value, orderNumber } });
      state.phone = { ...(state.phone || {}), saved: true, verified: false, masked: data.phone_masked || state.phone?.masked };
      if (data.needs_proof) {
        state.busy = false;
        renderForm(data.message || 'Escribe el número de un pedido tuyo para enlazar tus compras.', true);
        return;
      }
      renderSaved();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Guardar número';
      $('#verify-error').textContent = error.message;
    } finally {
      state.busy = false;
    }
  };
}
async function start() {
  try {
    const data = await request('/api/store/account/verification');
    if (!data.account) return renderLogin();
    state.phone = data.phone || { saved: false, verified: false, masked: null };
    if (state.phone.saved) return renderSaved();
    return renderForm('');
  } catch (error) {
    show(`<div class="verify-head"><h1>No pudimos abrir tus datos</h1><p>${esc(error.message)}</p></div>
      <div class="verify-card"><a class="button button-block" href="/store/#/account">Volver a mi cuenta</a></div>`);
  }
}

start();
