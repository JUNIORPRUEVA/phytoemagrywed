/*
 * MOTOR ÚNICO DE SINCRONIZACIÓN.
 *
 * QUÉ PROBLEMA RESUELVE
 *
 * Cada cambio se guardaba en una cola y el envío dependía de que alguien —o un
 * temporizador— se acordara de mandarla. Había tres temporizadores distintos, dos
 * colas (la del panel y la del diario de operaciones) y varias comprobaciones del
 * tipo «el móvil dice que no hay red», «la cuenta lleva más de 24 h» o «la otra
 * cola tiene algo pendiente». Cualquiera de esas condiciones dejaba el cambio
 * guardado en el aparato y sin llegar al servidor: había que pulsar «Sincronizar».
 *
 * CÓMO FUNCIONA AHORA (como WhatsApp: el mensaje sale solo)
 *
 *  · Un solo motor decide CUÁNDO se envía, para las dos colas.
 *  · Se intenta SIEMPRE que hay algo pendiente: ningún aviso del navegador
 *    (`navigator.onLine`), ni la antigüedad de la cuenta, ni el estado de la otra
 *    cola impiden intentarlo. Quien decide es el servidor.
 *  · Si falla, reintenta solo con espera creciente (2, 4, 8, 15, 30 y 60 s) y
 *    sigue intentándolo indefinidamente: no se rinde ni se queda dormido.
 *  · Se despierta con cualquier señal de vida: cambio nuevo, volver a la app,
 *    recuperar el foco, evento `online`, `pageshow` y aviso del service worker
 *    (Background Sync, que el sistema lanza aunque la app estuviera parada).
 *  · Nunca hay dos envíos a la vez: es un único escritor.
 *  · El estado (pendientes, último intento, último envío, motivo del fallo) se
 *    publica en `fulltech:sync-status` para poder verlo en pantalla.
 */
(() => {
  'use strict';
  if (window.FulltechSync) return;
  const BACKOFF = [2000, 4000, 8000, 15000, 30000, 60000];
  const BG_TAG = 'fulltech-outbox';
  let config = null;
  let running = null;
  let timer = null;
  let attempts = 0;
  const state = {
    pending: 0,
    reason: '',
    lastAttempt: 0,
    lastSuccess: 0,
    lastError: '',
    attempts: 0,
    nextAt: 0,
    online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  };

  const emit = () => {
    state.attempts = attempts;
    try {
      window.dispatchEvent(new CustomEvent('fulltech:sync-status', { detail: { ...state } }));
    } catch {
      /* sin CustomEvent (entorno de prueba) no hay nada que avisar */
    }
  };
  const emitiendo = () => emit();

  const delayFor = (n) => BACKOFF[Math.min(Math.max(n, 1) - 1, BACKOFF.length - 1)];

  async function count() {
    if (!config || typeof config.pending !== 'function') return 0;
    try {
      return Math.max(0, Number(await config.pending()) || 0);
    } catch {
      return 0;
    }
  }

  function programar(ms, motivo) {
    clearTimeout(timer);
    timer = null;
    if (!(ms > 0)) return;
    timer = setTimeout(() => {
      timer = null;
      run(motivo);
    }, ms);
  }

  /*
   * EL INTENTO DE VERDAD.
   *
   * `config.flush()` recorre las DOS colas y devuelve `{ sent, pending, error }`.
   * Si queda algo, se programa el siguiente intento aquí mismo: nadie tiene que
   * acordarse de volver a llamar.
   */
  async function run(reason = 'cambio') {
    if (!config) return { sent: 0, pending: 0 };
    if (running) return running;
    running = (async () => {
      state.lastAttempt = Date.now();
      state.reason = reason;
      emitiendo();
      let sent = 0;
      let error = '';
      try {
        const antes = await count();
        state.pending = antes;
        if (!antes) {
          attempts = 0;
          state.nextAt = 0;
          state.lastError = '';
          emitiendo();
          return { sent: 0, pending: 0 };
        }
        const resultado = (await config.flush()) || {};
        sent = Number(resultado.sent) || 0;
        error = resultado.error ? String(resultado.error) : '';
        state.pending = await count();
        if (!state.pending) {
          attempts = 0;
          state.lastSuccess = Date.now();
          state.lastError = '';
          state.nextAt = 0;
        } else {
          if (resultado.retry) attempts = 0;
          attempts += 1;
          if (error) state.lastError = error;
          else if (!state.lastError) state.lastError = 'Quedan cambios sin confirmar por el servidor.';
          state.nextAt = Date.now() + delayFor(attempts);
        }
      } catch (e) {
        attempts += 1;
        state.pending = await count();
        state.lastError = String(e?.message || 'Sin conexión con el servidor');
        state.nextAt = Date.now() + delayFor(attempts);
      } finally {
        emitiendo();
        if (state.pending) {
          /* Hay algo pendiente: se sigue solo. Nunca se abandona la cola. */
          programar(Math.max(1000, (state.nextAt || 0) - Date.now()) || 1000, 'reintento');
          registrarSegundoPlano();
        } else if (typeof config.after === 'function') {
          try {
            config.after(sent);
          } catch {
            /* el trabajo posterior no debe romper el motor */
          }
        }
      }
      return { sent, pending: state.pending, error: state.lastError };
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /*
   * BACKGROUND SYNC: el navegador despierta al service worker cuando vuelve la
   * red, aunque la app estuviera cerrada, y este avisa a la página para que
   * envíe en el acto. Es lo más parecido a WhatsApp que permite una PWA sin
   * depender de notificaciones push.
   */
  function registrarSegundoPlano() {
    try {
      navigator.serviceWorker?.ready
        ?.then((registro) => {
          registro.sync?.register(BG_TAG).catch(() => {});
        })
        .catch(() => {});
    } catch {
      /* navegador sin Background Sync: los demás disparadores siguen valiendo */
    }
  }

  function kick(reason = 'cambio') {
    if (!config) return running || Promise.resolve({ sent: 0, pending: 0 });
    return run(reason);
  }

  /* Cualquier señal de vida manda un intento (si no hay nada, no cuesta nada). */
  function despertar(reason) {
    state.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    attempts = 0; // se da otra oportunidad inmediata: la red pudo volver
    state.nextAt = 0;
    kick(reason);
  }

  window.addEventListener('online', () => despertar('online'));
  window.addEventListener('focus', () => kick('foco'));
  window.addEventListener('pageshow', () => kick('pageshow'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') despertar('visible');
  });
  try {
    navigator.serviceWorker?.addEventListener?.('message', (event) => {
      if (event.data?.type === 'FULLTECH_FLUSH_OUTBOX') despertar('service worker');
    });
  } catch {
    /* sin service worker */
  }

  window.FulltechSync = {
    /**
     * @param {{pending:()=>number|Promise<number>, flush:()=>Promise<{sent?:number,pending?:number,error?:string,retry?:boolean}>, after?:(sent:number)=>void}} opciones
     */
    configure(opciones) {
      config = opciones || null;
      count().then((n) => {
        state.pending = n;
        emitiendo();
        if (n) kick('arranque');
      });
    },
    start() {
      kick('arranque');
    },
    kick,
    /** Se llama al guardar un cambio: envío inmediato, sin esperas ni avisos. */
    ahora() {
      return kick('cambio');
    },
    state: () => ({ ...state }),
    /** Cuenta de nuevo lo pendiente (para la pantalla). */
    async refresh() {
      state.pending = await count();
      emitiendo();
      return state.pending;
    },
  };
})();
