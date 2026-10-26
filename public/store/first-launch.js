/*
 * BIENVENIDA DE FULLTECH STORE (video de arranque).
 *
 * Reglas de esta pantalla:
 *  1. Se muestra SOLO la primera vez de cada apertura: al abrir la app o la
 *     pestaña de cero. Mientras la pestaña siga abierta (navegar dentro de la
 *     tienda, recargar, volver desde otra pestaña) NO se repite: se entra
 *     directo, sin volver a «cargar».
 *  2. NO tiene botón de omitir: el video se va solo al terminar.
 *  3. Funciona sin conexión: el archivo se guarda en la caché del service
 *     worker (`sw.js`), así la PWA instalada lo reproduce igual que la web.
 *  4. Nunca deja la app bloqueada: si el teléfono no puede reproducirlo, la
 *     pantalla se retira sola.
 */
const SOURCE = '/store/assets/welcome/first-launch-v2.mp4';
const POSTER = '/store/assets/welcome/poster-v2.jpg';
/*
 * UNA VEZ POR APERTURA, NO POR RECARGA.
 *
 * La marca vive en `sessionStorage`: se borra sola cuando se cierra la app o
 * la pestaña, y se mantiene mientras la sesión siga viva. Así el video sale al
 * abrir la app y NO vuelve a salir por navegar dentro de la tienda, por recargar
 * ni por volver desde otra pestaña (eso era lo que parecía «cargando otra vez»).
 */
const SESSION_KEY = 'ft_welcome_shown_v1';

function alreadyShown() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markShown() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* Sin Storage el video sale en cada carga: es el mal menor. */
  }
}

function welcome() {
  // Enlaces profundos, checkout y vueltas de OAuth abren directo.
  if (location.hash && !['#', '#/', '#/home'].includes(location.hash)) return;
  if (document.visibilityState === 'hidden') return;
  // Ya se vio en esta apertura de la app: se entra normal, sin «cargar».
  if (alreadyShown()) return;
  // Quien pidió menos movimiento en el sistema no ve el video.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  markShown();

  const overlay = document.createElement('section');
  overlay.className = 'ft-welcome';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Bienvenida FULLTECH Store');
  overlay.innerHTML =
    `<video muted autoplay playsinline webkit-playsinline preload="auto" poster="${POSTER}" ` +
    'aria-label="Bienvenida FULLTECH Store"></video>';
  const video = overlay.querySelector('video');

  const roots = [...document.body.children].filter((el) => !['SCRIPT', 'LINK'].includes(el.tagName));
  const inertStates = roots.map((el) => [el, el.inert]);
  const previousFocus = document.activeElement;
  let done = false;
  let safetyTimer = null;

  function finish() {
    if (done) return;
    done = true;
    clearTimeout(safetyTimer);
    window.removeEventListener('hashchange', finish);
    document.removeEventListener('visibilitychange', onVisibility);
    video.pause();
    inertStates.forEach(([el, wasInert]) => { el.inert = wasInert; });
    overlay.classList.add('is-leaving');
    setTimeout(() => {
      video.removeAttribute('src');
      video.load();
      overlay.remove();
    }, 200);
    if (previousFocus?.isConnected && previousFocus !== document.body) {
      previousFocus.focus({ preventScroll: true });
    }
  }

  function onVisibility() {
    if (document.hidden) finish();
  }

  /* Si el sistema bloquea el arranque automático, el primer toque lo arranca. */
  const play = () => { video.play().catch(() => {}); };
  overlay.addEventListener('pointerdown', play);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finish();
  });

  video.addEventListener('ended', finish);
  video.addEventListener('playing', () => clearTimeout(safetyTimer));
  video.addEventListener('error', finish, { once: true });
  window.addEventListener('hashchange', finish);
  document.addEventListener('visibilitychange', onVisibility);

  document.body.append(overlay);
  roots.forEach((el) => { el.inert = true; });
  overlay.focus({ preventScroll: true });

  video.src = SOURCE;
  video.muted = true;
  play();

  /*
   * Red de seguridad: si a los 12 s el video no ha empezado (archivo dañado,
   * decodificador ocupado, modo de bajo consumo), se retira para que la tienda
   * quede usable. Con el video en marcha este temporizador ya no existe.
   */
  safetyTimer = setTimeout(() => {
    if (video.readyState < 2) finish();
  }, 12000);
}

welcome();
