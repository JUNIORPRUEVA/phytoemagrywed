/*
 * BIENVENIDA DE FULLTECH STORE (video de arranque).
 *
 * Reglas de esta pantalla:
 *  1. Se muestra CADA vez que se abre la app, en la web y en la PWA instalada.
 *     Ya no se guarda ninguna marca de «visto»: abrir la app = ver el video.
 *  2. NO tiene botón de omitir: el video se va solo al terminar.
 *  3. Funciona sin conexión: el archivo se guarda en la caché del service
 *     worker (`sw.js`), así la PWA instalada lo reproduce igual que la web.
 *  4. Nunca deja la app bloqueada: si el teléfono no puede reproducirlo, la
 *     pantalla se retira sola.
 */
const SOURCE = '/store/assets/welcome/first-launch-v2.mp4';
const POSTER = '/store/assets/welcome/poster-v2.jpg';

function welcome() {
  // Enlaces profundos, checkout y vueltas de OAuth abren directo.
  if (location.hash && !['#', '#/', '#/home'].includes(location.hash)) return;
  if (document.visibilityState === 'hidden') return;
  // Quien pidió menos movimiento en el sistema no ve el video.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

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

/*
 * VOLVER A ENTRAR CUENTA.
 *
 * En el teléfono la PWA suele quedar viva en segundo plano: al tocar el icono
 * se reanuda sin recargar y, sin esto, el video solo se vería la primera vez
 * del día. Si la app estuvo fuera 10 minutos o más y se vuelve al inicio, se
 * muestra otra vez. Nunca interrumpe una compra ni una ficha de producto.
 */
const AWAY_MS = 10 * 60 * 1000;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  const home = !location.hash || ['#', '#/', '#/home'].includes(location.hash);
  const away = hiddenAt && Date.now() - hiddenAt >= AWAY_MS;
  hiddenAt = 0;
  if (away && home && !document.querySelector('.ft-welcome')) welcome();
});
