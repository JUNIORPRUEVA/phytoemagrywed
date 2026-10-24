/* Store-only welcome. Media is requested only for an eligible first opening. */
const KEY = 'fulltech_store_welcome_seen_v1';
function seen() {
  if (window.__fulltechWelcomeSeen) return true;
  for (const name of ['localStorage', 'sessionStorage']) {
    try { if (window[name].getItem(KEY) === '1') return true; } catch {}
  }
  return false;
}
function remember() {
  window.__fulltechWelcomeSeen = true;
  for (const name of ['localStorage', 'sessionStorage']) {
    try { window[name].setItem(KEY, '1'); } catch {}
  }
}
async function welcome() {
  if (seen() || document.visibilityState === 'hidden' || navigator.onLine === false) return;
  // Authentication callbacks, checkout and shared product links open directly.
  if (location.hash && !['#', '#/', '#/home'].includes(location.hash)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { remember(); return; }
  const overlay = document.createElement('section');
  overlay.className = 'ft-welcome';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Bienvenido a FULLTECH Store');
  overlay.innerHTML = '<video muted playsinline preload="none" aria-label="Bienvenida FULLTECH Store"></video><button class="ft-welcome__skip" type="button">Omitir</button>';
  const video = overlay.querySelector('video'), skip = overlay.querySelector('button');
  const roots = [...document.body.children].filter(el => !['SCRIPT', 'LINK'].includes(el.tagName));
  const inertStates = roots.map(el => [el, el.inert]);
  const previousFocus = document.activeElement;
  let done = false, loadTimer, totalTimer;
  function finish(success = false) {
    if (done) return;
    done = true;
    if (success) remember();
    clearTimeout(loadTimer); clearTimeout(totalTimer);
    window.removeEventListener('hashchange', navigate);
    document.removeEventListener('visibilitychange', visibility);
    video.pause(); video.removeAttribute('src'); video.load();
    inertStates.forEach(([el, wasInert]) => { el.inert = wasInert; });
    overlay.classList.add('is-leaving');
    setTimeout(() => overlay.remove(), 200);
    if (document.activeElement === skip) (previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : document.querySelector('#menu-button'))?.focus({ preventScroll: true });
  }
  const navigate = () => finish(false);
  const visibility = () => { if (document.hidden) finish(false); };
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') finish(true);
    if (e.key === 'Tab') { e.preventDefault(); skip.focus(); }
  });
  skip.addEventListener('click', () => finish(true));
  video.addEventListener('ended', () => finish(true));
  video.addEventListener('error', () => finish(false));
  video.addEventListener('playing', () => clearTimeout(loadTimer));
  window.addEventListener('hashchange', navigate);
  document.addEventListener('visibilitychange', visibility);
  document.body.append(overlay);
  roots.forEach(el => { el.inert = true; });
  skip.focus({ preventScroll: true });
  // Bounded fallback for offline, stalled media and autoplay restrictions.
  loadTimer = setTimeout(() => finish(false), 1800);
  totalTimer = setTimeout(() => finish(false), 7000);
  video.muted = true;
  video.src = '/store/assets/welcome/first-launch-v2.mp4';
  try { await video.play(); } catch { finish(false); }
}
welcome();
