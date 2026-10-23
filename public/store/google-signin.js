/**
 * «Continuar con Google» — botón oficial de Google Identity Services.
 *
 * Se monta solo cuando la pantalla de acceso está visible (`#google-signin`) y
 * el servidor tiene `PHYTO_GOOGLE_CLIENT_ID`. Si no está configurado, no pinta
 * nada: nunca se simula un acceso.
 *
 * El `credential` que devuelve Google se envía al servidor, que verifica firma y
 * reclamaciones. Aquí no se lee ni se guarda nada de la identidad.
 */
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let loading = null;
let initializedFor = '';

function loadScript() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error('google_script_failed'));
    document.head.appendChild(script);
  });
  return loading;
}

function readCookie(name) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';
}

function cartHasItems() {
  try {
    const rows = JSON.parse(localStorage.getItem('fulltech_cart_v1') ?? '[]');
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

function reportError(message) {
  const box = document.querySelector('#auth-error');
  if (box) box.textContent = message;
  else console.warn('[google]', message);
}

async function handleCredential(credential, clientId) {
  try {
    const response = await fetch('/api/store/account/google/credential', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ credential, g_csrfToken: readCookie('g_csrf_token'), clientId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      reportError(data.message || 'No pudimos entrar con Google. Inténtalo de nuevo.');
      return;
    }
    if (data.pending && data.pending_token) {
      const mode = data.needs_proof === 'password' ? '&modo=clave' : '';
      location.assign(`/store/#/account/complete?token=${encodeURIComponent(data.pending_token)}${mode}`);
      return;
    }
    location.assign(cartHasItems() ? '/store/#/checkout' : '/store/#/account');
  } catch {
    reportError('No pudimos entrar con Google. Revisa tu conexión.');
  }
}

async function mount() {
  const host = document.querySelector('#google-signin');
  if (!host || host.dataset.mounted === '1') return;
  let config;
  try {
    const response = await fetch('/api/store/account/auth-config', { headers: { accept: 'application/json' } });
    config = await response.json();
  } catch {
    return;
  }
  if (!config?.google?.enabled || !config.google.client_id) return;

  try {
    const google = await loadScript();
    if (!google?.accounts?.id) return;
    if (initializedFor !== config.google.client_id) {
      google.accounts.id.initialize({
        client_id: config.google.client_id,
        ux_mode: 'popup',
        auto_select: false,
        cancel_on_tap_outside: true,
        callback: (response) => handleCredential(response?.credential ?? '', config.google.client_id),
      });
      initializedFor = config.google.client_id;
    }
    google.accounts.id.renderButton(host, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      logo_alignment: 'center',
      locale: 'es',
      width: Math.min(360, host.clientWidth || 320),
    });
    host.hidden = false;
    host.dataset.mounted = '1';
  } catch {
    /* Sin red a Google: se queda el acceso por correo, que funciona igual. */
  }
}

function schedule() {
  /* La pantalla de acceso se repinta al cambiar de ruta: se reintenta. */
  setTimeout(mount, 60);
}

window.addEventListener('hashchange', schedule);
window.addEventListener('load', schedule);
document.addEventListener('DOMContentLoaded', schedule);
schedule();
