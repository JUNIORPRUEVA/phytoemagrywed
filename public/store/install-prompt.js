/*
 * INVITACIÓN A INSTALAR LA APP DE LA TIENDA.
 *
 * ESTRATEGIA POR DISPOSITIVO (no todos los teléfonos instalan igual):
 *  - Android / escritorio con Chrome: se guarda `beforeinstallprompt` y el botón
 *    lanza el diálogo del sistema. Botón circular animado (aro, sonar, brillo).
 *  - iPhone / iPad: NO existe ese diálogo. El botón es una píldora estática
 *    «Instalar app» y al tocarla se abren los 3 pasos manuales (Compartir →
 *    Añadir a pantalla de inicio → Añadir).
 *  - Navegador dentro de otra app (WhatsApp, Instagram, Facebook…): primero hay
 *    que salir al navegador, así que el primer paso lo explica.
 *
 * Guion:
 *  1. UN SOLO anuncio a los 7 s (si no está instalada), con aspa para quitarlo.
 *  2. Después queda el botón flotante abajo a la derecha hasta que instalen.
 *     Cada 50 s asoma el texto durante 2 s (en iPhone se menea no: es estático).
 *  3. Al instalar, el botón desaparece y se ofrece «Abrir app en el teléfono».
 *
 * Clases con prefijo propio: `.ft-install` ya existe en `discovery.css`.
 */
const MEMORY_KEY = 'ft_install_prompt_v1';
const ICON = '/store/assets/app-icons/icon-192.png';
const PIN_ART = '/store/assets/icons/custom/instalar-app.png';
const HOME_HASHES = ['#', '#/', '#/home'];
const FIRST_DELAY = 7000;
const HINT_FIRST = 6000;
const HINT_EVERY = 50000;
const HINT_VISIBLE = 2000;
const ROOT = 'ft-installprompt';
const PIN = 'ft-installpin';

const UA = navigator.userAgent || '';
const IS_IOS = /iP(hone|ad|od)/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
/* Navegadores dentro de otra app: no se puede instalar sin salir a Safari/Chrome. */
const IS_IN_APP = /(FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Snapchat|Twitter)/i.test(UA);

let deferredPrompt = null;
let installed = isStandalone();
let overlay = null;
let phase = 'idle'; // idle | first | guide | installed
let firstTimer = null;
let pin = null;
let hintTimer = null;
let hintTimeout = null;
let announced = false;
let observer = null;
let rebuildTimer = null;

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    window.navigator.standalone === true
  );
}

function memory() {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
  } catch {
    return {};
  }
}

function remember(patch) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify({ ...memory(), ...patch }));
  } catch {
    /* Sin Storage se comporta igual; solo volvería a preguntar en otra visita. */
  }
}

function atHome() {
  return !location.hash || HOME_HASHES.includes(location.hash);
}

function cardPending() {
  if (installed) return false;
  return memory().state !== 'announced' && memory().state !== 'installed';
}

function pinWanted() {
  if (installed) return false;
  return announced || memory().state === 'announced';
}

function canPrompt() {
  return Boolean(deferredPrompt);
}

/* ------------------------------------------------------------------ tarjeta */

function whenWelcomeGone(callback) {
  if (!document.querySelector('.ft-welcome')) {
    callback();
    return;
  }
  const watcher = new MutationObserver(() => {
    if (document.querySelector('.ft-welcome')) return;
    watcher.disconnect();
    callback();
  });
  watcher.observe(document.body, { childList: true });
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function markup({ title, text = '', list = [], steps = [], action, hint = '' }) {
  const items = list.length
    ? `<ul class="${ROOT}__list">${list.map((item) => `<li>${CHECK_ICON}<span>${item}</span></li>`).join('')}</ul>`
    : '';
  const guide = steps.length
    ? `<ol class="${ROOT}__guide">${steps.map((step) => `<li><span>${step}</span></li>`).join('')}</ol>`
    : '';
  return `
    <div class="${ROOT}__card">
      <button class="${ROOT}__close" type="button" aria-label="Quitar este anuncio">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
      <img class="${ROOT}__logo" src="${ICON}" alt="" width="52" height="52" decoding="async" />
      <h2 class="${ROOT}__title" id="ft-install-title">${title}</h2>
      ${text ? `<p class="${ROOT}__text">${text}</p>` : ''}
      ${items}
      ${guide}
      <button class="${ROOT}__action" type="button">${action}</button>
      ${hint ? `<p class="${ROOT}__hint">${hint}</p>` : ''}
    </div>`;
}

/* Pasos reales de cada escenario. */
function guideSteps() {
  if (IS_IN_APP) {
    return [
      'Toca el botón ⋯ o el menú de arriba y elige «Abrir en el navegador».',
      IS_IOS
        ? 'Ya en Safari, sigue los 3 pasos: Compartir → Añadir a pantalla de inicio → Añadir.'
        : 'Ya en Chrome, toca el menú ⋮ y elige «Instalar app».',
    ];
  }
  if (IS_IOS) {
    return [
      'Toca el botón Compartir de Safari (el cuadrado con la flecha hacia arriba).',
      'Baja en la lista y elige «Añadir a pantalla de inicio».',
      'Toca «Añadir» arriba a la derecha. Listo.',
    ];
  }
  if (IS_ANDROID) {
    return [
      'Toca el menú ⋮ de Chrome, arriba a la derecha.',
      'Elige «Instalar app» o «Añadir a pantalla de inicio».',
      'Confirma con «Instalar». Listo.',
    ];
  }
  return [
    'En la barra de direcciones busca el icono de instalar.',
    'Elige «Instalar» y confirma. Listo.',
  ];
}

const CARDS = {
  first: () =>
    markup({
      title: 'Lleva la tienda en tu teléfono',
      text: 'Instálala en 10 segundos y entra con un solo toque, sin buscar la página.',
      action: canPrompt() ? 'Instalar la app' : 'Ver cómo instalarla',
    }),
  guide: () =>
    markup({
      title: IS_IOS ? 'Instálala en 3 pasos' : 'Instálala en 2 pasos',
      text: IS_IOS
        ? 'En iPhone se hace desde el menú Compartir de Safari.'
        : 'Queda como un icono más en tu pantalla de inicio.',
      steps: guideSteps(),
      action: 'Entendido',
    }),
  installed: () =>
    markup({
      title: '¡App instalada!',
      text: 'Ya está en tu pantalla de inicio.',
      action: 'Abrir app en el teléfono',
      hint: 'Si no abre sola, toca el icono de FULLTECH en tu pantalla de inicio.',
    }),
};

function mount(kind) {
  if (overlay || !CARDS[kind]) return;
  phase = kind;
  overlay = document.createElement('section');
  overlay.className = ROOT;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'ft-install-title');
  overlay.innerHTML = CARDS[kind]();
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss(kind);
  });
  overlay.querySelector(`.${ROOT}__close`)?.addEventListener('click', () => dismiss(kind));
  overlay.querySelector(`.${ROOT}__action`)?.addEventListener('click', () => onAction(kind));
  document.body.append(overlay);
  requestAnimationFrame(() => overlay?.classList.add('is-in'));
  overlay.querySelector(`.${ROOT}__close`)?.focus({ preventScroll: true });
}

function unmount() {
  const node = overlay;
  overlay = null;
  phase = 'idle';
  if (!node) return;
  node.classList.remove('is-in');
  node.classList.add('is-out');
  setTimeout(() => node.remove(), 200);
}

function dismiss(kind = phase) {
  unmount();
  if (kind === 'first') {
    /* Anuncio visto: no se repite y desde aquí queda el botón flotante. */
    announced = true;
    remember({ state: 'announced', at: Date.now() });
    ensurePin();
  }
}

async function onAction(kind = phase) {
  if (kind === 'installed') {
    location.assign('/store/');
    return;
  }
  if (kind === 'guide') {
    dismiss(kind);
    return;
  }
  await runInstall();
}

/* --------------------------------------------------------------- instalación */

async function runInstall() {
  if (!deferredPrompt) {
    unmount();
    mount('guide');
    return;
  }
  const prompt = deferredPrompt;
  deferredPrompt = null;
  try {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome !== 'accepted') {
      /* Dijo que no en el diálogo del sistema: queda el botón, sin repetir el anuncio. */
      announced = true;
      remember({ state: 'announced', at: Date.now() });
      unmount();
      ensurePin();
    }
  } catch {
    unmount();
    mount('guide');
  }
}

function showInstalled() {
  installed = true;
  remember({ state: 'installed', at: Date.now() });
  clearTimeout(firstTimer);
  removePin();
  unmount();
  mount('installed');
}

/* --------------------------------------------------------------- botón fijo */

function removePin() {
  clearInterval(hintTimer);
  clearTimeout(hintTimeout);
  hintTimer = null;
  hintTimeout = null;
  pin?.remove();
  pin = null;
}

function showHint() {
  if (!pin) return;
  pin.classList.add('is-hinting');
  clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => pin?.classList.remove('is-hinting'), HINT_VISIBLE);
}

function scheduleHint() {
  clearInterval(hintTimer);
  clearTimeout(hintTimeout);
  /* En iPhone no hay animación: el botón es una píldora que se lee sola. */
  if (IS_IOS) return;
  hintTimeout = setTimeout(showHint, HINT_FIRST);
  hintTimer = setInterval(showHint, HINT_EVERY);
}

function pinMarkup() {
  const art = `<span class="${PIN}__glyph" style="--pin-icon:url('${PIN_ART}')" aria-hidden="true"></span>`;
  if (IS_IOS) {
    return `${art}<span class="${PIN}__text">Instalar app</span>`;
  }
  return (
    `<span class="${PIN}__art" aria-hidden="true">` +
    `<span class="${PIN}__sonar"></span>` +
    `<span class="${PIN}__sheen"></span>` +
    art +
    `</span>` +
    `<span class="${PIN}__label" aria-hidden="true">Instálalo ahora</span>`
  );
}

function ensurePin() {
  if (!pinWanted() || !atHome()) {
    removePin();
    return;
  }
  if (pin?.isConnected) return;
  removePin();
  pin = document.createElement('button');
  pin.type = 'button';
  pin.className = IS_IOS ? `${PIN} is-ios` : PIN;
  pin.setAttribute('aria-label', 'Instalar la app');
  pin.innerHTML = pinMarkup();
  pin.addEventListener('click', () => runInstall());
  document.body.append(pin);
  scheduleHint();
}

/* El panel repinta el inicio al navegar: el botón se vuelve a colocar. */
function watchRenders() {
  if (observer) return;
  observer = new MutationObserver(() => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(ensurePin, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------ arranque */

function boot() {
  if (installed) return;
  watchRenders();
  if (cardPending()) {
    clearTimeout(firstTimer);
    firstTimer = setTimeout(() => {
      firstTimer = null;
      if (!cardPending() || !atHome()) return;
      whenWelcomeGone(() => mount('first'));
    }, FIRST_DELAY);
    return;
  }
  ensurePin();
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
});

window.addEventListener('appinstalled', showInstalled);

window.addEventListener('hashchange', () => {
  ensurePin();
  if (cardPending() && !firstTimer && !overlay && atHome()) boot();
});

boot();
