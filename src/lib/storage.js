/**
 * Almacenamiento tolerante a fallos (modo privado, cookies bloqueadas, cuota llena).
 * Nunca lanza: si no se puede guardar, se degrada a memoria.
 */

const memory = new Map();

/** @param {'local'|'session'} kind */
function pick(kind) {
  try {
    const store = kind === 'session' ? window.sessionStorage : window.localStorage;
    const probe = '__pe_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/**
 * Crea un adaptador de almacenamiento con namespace.
 * @param {string} namespace
 * @param {'local'|'session'} [kind]
 */
export function createStorage(namespace, kind = 'local') {
  const store = pick(kind);
  const prefix = `${namespace}:`;

  return {
    available: store !== null,
    /**
     * @param {string} key
     * @returns {any}
     */
    get(key) {
      const full = prefix + key;
      try {
        const raw = store ? store.getItem(full) : memory.get(full);
        if (raw === null || raw === undefined) return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    /**
     * @param {string} key
     * @param {any} value
     * @returns {boolean}
     */
    set(key, value) {
      const full = prefix + key;
      try {
        const raw = JSON.stringify(value);
        if (store) store.setItem(full, raw);
        else memory.set(full, raw);
        return true;
      } catch {
        // Cuota llena o serialización imposible: seguimos en memoria.
        try {
          memory.set(full, JSON.stringify(value));
        } catch {
          /* ignorado a propósito */
        }
        return false;
      }
    },
    /** @param {string} key */
    remove(key) {
      const full = prefix + key;
      try {
        if (store) store.removeItem(full);
        memory.delete(full);
      } catch {
        /* ignorado a propósito */
      }
    },
    /** Lista de claves del namespace (sin prefijo). */
    keys() {
      if (!store) return [...memory.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      /** @type {string[]} */
      const out = [];
      try {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length));
        }
      } catch {
        /* ignorado a propósito */
      }
      return out;
    },
  };
}

/** Almacenamiento en memoria (tests / entornos sin DOM). */
export function createMemoryStorage() {
  /** @type {Map<string,string>} */
  const map = new Map();
  return {
    available: true,
    get(key) {
      const raw = map.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      map.set(key, JSON.stringify(value));
      return true;
    },
    remove(key) {
      map.delete(key);
    },
    keys() {
      return [...map.keys()];
    },
  };
}

export const STORAGE_NAMESPACE = 'pe';
