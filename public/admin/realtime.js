/**
 * TIEMPO REAL EN EL PANEL (cliente del bus de eventos).
 *
 * Un solo canal SSE por pestaña contra `/api/admin/events`. Cuando el servidor
 * confirma un cambio (pedido, entrega, recogida, cobro, inventario, cliente,
 * supervisor) llega un evento pequeño y cada pantalla pide SOLO lo suyo.
 *
 * LO QUE ESTE ARCHIVO NO HACE
 *   - No pinta nada: reparte eventos (`fulltech:crm-event`) y quien sabe de cada
 *     módulo decide qué recargar.
 *   - No inventa estado: un evento nunca dice «esto es lo que hay», dice «esto
 *     cambió»; los datos se piden por la ruta normal, que aplica permisos.
 *
 * REANUDAR SIN PERDER NADA
 * El último `seq` se guarda en el teléfono. Al reconectar se pide `?since=<seq>`
 * y el servidor reenvía lo perdido. Si el cursor es demasiado viejo (el búfer ya
 * lo soltó), el servidor manda `resync` y el panel recarga de forma controlada.
 *
 * IMPORTANTE (PWA/iOS): al volver a primer plano o al recuperar red se comprueba
 * el canal. iOS suspende la página y el EventSource queda muerto sin avisar.
 */
(() => {
  const SEQ_KEY = 'pe_crm_rt_seq';
  const DEVICE_KEY = 'pe_crm_rt_device';
  const MAX_BACKOFF = 30_000;

  const state = {
    source: null,
    seq: 0,
    started: false,
    attempts: 0,
    timer: null,
    lastEventAt: 0,
    latencies: [],
    received: 0,
    readyAt: 0,
    errors: 0,
  };

  const deviceId = (() => {
    try {
      const saved = localStorage.getItem(DEVICE_KEY);
      if (saved) return saved;
      const made = `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_KEY, made);
      return made;
    } catch {
      return `dev_${Math.random().toString(36).slice(2, 10)}`;
    }
  })();

  try {
    state.seq = Number(localStorage.getItem(SEQ_KEY)) || 0;
  } catch {
    state.seq = 0;
  }

  function rememberSeq(value) {
    const seq = Number(value);
    if (!Number.isFinite(seq) || seq <= state.seq) return;
    state.seq = seq;
    try {
      localStorage.setItem(SEQ_KEY, String(seq));
    } catch {
      /* sin almacenamiento: el cursor se pierde al cerrar, no es crítico */
    }
  }

  /*
   * Todas las escrituras del panel llevan el identificador de ESTA pestaña. El
   * servidor lo devuelve en el evento y así el dispositivo que hizo el cambio no
   * se repite el trabajo (los demás sí se enteran).
   */
  const previousFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? '', location.href);
      const method = String(init.method ?? (typeof input === 'object' ? input?.method : '') ?? 'GET').toUpperCase();
      if (url.origin === location.origin && url.pathname.startsWith('/api/admin/') && method !== 'GET') {
        const headers = new Headers(init.headers ?? (typeof input === 'object' ? input.headers : undefined) ?? undefined);
        if (!headers.has('x-crm-device')) headers.set('x-crm-device', deviceId);
        return previousFetch(input, { ...init, headers });
      }
    } catch {
      /* si algo raro pasa con la URL, se pide igual que siempre */
    }
    return previousFetch(input, init);
  };

  function emit(payload) {
    state.received += 1;
    state.lastEventAt = Date.now();
    const sentAt = Date.parse(payload?.at ?? '');
    if (Number.isFinite(sentAt)) {
      const latency = Math.max(0, Date.now() - sentAt);
      state.latencies.push(latency);
      if (state.latencies.length > 200) state.latencies.shift();
    }
    rememberSeq(payload?.seq);
    window.dispatchEvent(new CustomEvent('fulltech:crm-event', { detail: payload }));
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }

  function clearTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function scheduleReconnect() {
    if (!state.started) return;
    clearTimer();
    const base = Math.min(MAX_BACKOFF, 800 * 2 ** Math.min(state.attempts, 6));
    const wait = Math.round(base * (0.7 + Math.random() * 0.6));
    state.attempts += 1;
    state.timer = setTimeout(() => start({ silent: true }), wait);
  }

  function close() {
    if (state.source) {
      try {
        state.source.close();
      } catch {
        /* ya estaba cerrado */
      }
      state.source = null;
    }
  }

  /**
   * Abre (o reabre) el canal. Es idempotente: si ya hay uno abierto, no hace
   * nada salvo que se pida `force`.
   */
  function start(options = {}) {
    state.started = true;
    if (typeof EventSource !== 'function') return stats();
    if (state.source && !options.force) return stats();
    close();
    clearTimer();
    const since = state.seq > 0 ? `&since=${encodeURIComponent(state.seq)}` : '';
    let source;
    try {
      source = new EventSource(`/api/admin/events?device=${encodeURIComponent(deviceId)}${since}`);
    } catch {
      scheduleReconnect();
      return stats();
    }
    state.source = source;
    source.addEventListener('ready', (event) => {
      state.attempts = 0;
      state.readyAt = Date.now();
      /*
       * PUNTO DE PARTIDA DEL CURSOR.
       *
       * Si es la primera conexión de este dispositivo no hay cursor guardado y
       * una desconexión posterior reabriría el canal «desde cero»: lo publicado
       * en ese hueco se perdía en silencio. El `ready` trae la secuencia actual
       * del servidor y sirve de marca: al reconectar se pide `?since=` y llega lo
       * que faltó.
       */
      try {
        const saludo = JSON.parse(event.data ?? '{}');
        if (state.seq === 0 && Number(saludo.seq) > 0) {
          state.seq = Number(saludo.seq);
          localStorage.setItem(SEQ_KEY, String(state.seq));
        }
      } catch {
        /* saludo ilegible: se sigue sin cursor */
      }
    });
    source.addEventListener('resync', () => {
      // El búfer del servidor ya no tiene nuestro cursor: recargar lo justo.
      rememberSeq(0);
      window.dispatchEvent(new CustomEvent('fulltech:crm-resync'));
    });
    source.addEventListener('revoked', () => {
      // La sesión se cerró o el usuario ya no existe: se deja de recibir.
      stop();
      window.dispatchEvent(new CustomEvent('fulltech:crm-revoked'));
    });
    source.onmessage = (event) => {
      try {
        emit(JSON.parse(event.data));
      } catch {
        /* evento ilegible: no se inventa nada */
      }
    };
    // Los eventos llegan con `event: <tipo>`; hay que escuchar cada tipo.
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        try {
          emit(JSON.parse(event.data));
        } catch {
          /* evento ilegible */
        }
      });
    }
    source.onerror = () => {
      state.errors += 1;
      close();
      if (state.started) scheduleReconnect();
    };
    return stats();
  }

  function stop() {
    state.started = false;
    clearTimer();
    close();
    state.attempts = 0;
  }

  function stats() {
    return {
      running: Boolean(state.source),
      started: state.started,
      seq: state.seq,
      received: state.received,
      readyAt: state.readyAt || null,
      errors: state.errors,
      lastEventAt: state.lastEventAt || null,
      latencyP50: percentile(state.latencies, 50),
      latencyP95: percentile(state.latencies, 95),
      samples: state.latencies.length,
      device: deviceId,
    };
  }

  const EVENT_TYPES = [
    'order.created',
    'order.updated',
    'order.status_changed',
    'order.assigned',
    'order.deleted',
    'delivery.started',
    'delivery.completed',
    'delivery.postponed',
    'delivery.issue',
    'pickup.status_changed',
    'pickup.created',
    'payment.recorded',
    'payment.handover_recorded',
    'inventory.changed',
    'customer.updated',
    'supervisor.changed',
    'whatsapp.message_received',
  ];

  window.CrmRealtime = { start, stop, stats, get deviceId() { return deviceId; } };

  // Arranca cuando el panel ya sabe quién es (sin cortar una conexión ya abierta).
  window.addEventListener('fulltech:startup-ready', () => start());
  // Al volver a la app (iPhone suspende el EventSource sin avisar) se revisa.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.started) start();
    else if (!state.source) start({ force: true });
  });
  window.addEventListener('online', () => {
    if (state.started) start({ force: true });
  });
  // Cerrar sesión corta el canal: nadie sigue recibiendo datos de la cuenta.
  window.addEventListener('phyto:calling-logout', stop);
  window.addEventListener('fulltech:logout', stop);
})();
