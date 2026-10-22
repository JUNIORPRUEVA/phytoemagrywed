/**
 * HERRAMIENTAS DE CONSULTA DEL AGENTE DE SEGUIMIENTO (solo lectura).
 *
 * Qué son
 *   Consultas TIPADAS que el modelo puede pedir para investigar antes de
 *   responder. El modelo no ve la base: pide, por ejemplo, «clientes_buscar» con
 *   un texto y el servidor devuelve como mucho 10 filas ya filtradas por permisos.
 *
 * Reglas que no se negocian
 *   - SOLO lectura: ninguna herramienta escribe, envía ni cambia estados.
 *   - Autorización POR RECURSO: sin `chats.force_reassign` solo se ven los
 *     clientes de las conversaciones asignadas a esa persona.
 *   - Parámetros validados y acotados (límites máximos por herramienta).
 *   - Nada de SQL libre: cada herramienta es una consulta concreta.
 *   - Los clientes con «no contactar» o baja de WhatsApp se marcan y NO se
 *     proponen para escribirles.
 *   - Un nombre ambiguo devuelve las opciones en vez de adivinar.
 */
import { commercialSnapshot } from './commercial.mjs';

const TZ = 'America/Santo_Domingo';

const dia = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};

const texto = (value, max = 60) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const entero = (value, min, max, porDefecto) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const diasDesde = (value, ahora) => {
  const t = Date.parse(String(value ?? ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((ahora - t) / 86400000));
};
const horasDesde = (value, ahora) => {
  const t = Date.parse(String(value ?? ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((ahora - t) / 3600000));
};

function ordenar(value) {
  const raw = value?.order_json ?? value?.orderJson ?? null;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Catálogo de herramientas + ejecución. Se construye por petición (con permisos). */
export function createReadTools({ ctx, can, actor }) {
  const ahora = (ctx?.clock ?? (() => new Date()))().getTime();
  const veTodo = can('chats.force_reassign') || !actor?.id || actor.actor_type !== 'USER';

  const spec = [
    {
      type: 'function',
      function: {
        name: 'clientes_buscar',
        description:
          'Busca clientes por nombre o teléfono y devuelve como mucho 10 con su etapa, etiquetas, si compró y cuándo, y si tiene pedido abierto. Úsalo para localizar a un cliente concreto por su nombre.',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Nombre o parte del nombre del cliente (mínimo 2 letras).' },
            limite: { type: 'integer', minimum: 1, maximum: 10, description: 'Cuántos devolver (por defecto 5).' },
          },
          required: ['q'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cliente_ficha',
        description:
          'Ficha comercial de UN cliente: compras (número, total, última fecha y productos), seguimientos, último mensaje y si pidió no ser contactado.',
        parameters: {
          type: 'object',
          properties: {
            cliente: { type: 'string', description: 'Identificador del cliente o su nombre exacto.' },
          },
          required: ['cliente'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'compras_recompra',
        description:
          'Clientes que compraron antes y NO tienen pedido abierto, con los días transcurridos desde su última compra. Sirve para oportunidades de recompra.',
        parameters: {
          type: 'object',
          properties: {
            dias: { type: 'integer', minimum: 7, maximum: 180, description: 'Días mínimos desde la última compra (por defecto 21).' },
            limite: { type: 'integer', minimum: 1, maximum: 10, description: 'Cuántos devolver (por defecto 8).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pedidos_pendientes',
        description:
          'Pedidos que quedaron sin terminar (estado nuevo o confirmado) con sus días de antigüedad, total y cliente. Excluye cancelados y perdidos.',
        parameters: {
          type: 'object',
          properties: {
            dias: { type: 'integer', minimum: 1, maximum: 60, description: 'Antigüedad mínima en días (por defecto 2).' },
            limite: { type: 'integer', minimum: 1, maximum: 10, description: 'Cuántos devolver (por defecto 8).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'conversaciones_sin_responder',
        description:
          'Conversaciones donde el último mensaje lo escribió el cliente y todavía nadie contestó, con las horas transcurridas y un extracto.',
        parameters: {
          type: 'object',
          properties: {
            horas: { type: 'integer', minimum: 1, maximum: 240, description: 'Horas mínimas esperando (por defecto 24).' },
            limite: { type: 'integer', minimum: 1, maximum: 10, description: 'Cuántos devolver (por defecto 8).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'catalogo_precios',
        description:
          'Presentaciones y productos con su precio vigente y si hay existencias. Úsalo cuando haga falta citar precio o disponibilidad.',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Texto a buscar en el nombre (opcional).' },
            limite: { type: 'integer', minimum: 1, maximum: 12, description: 'Cuántos devolver (por defecto 8).' },
          },
        },
      },
    },
  ];

  /* ---------------------------------------------------------------- datos */

  const leerConversaciones = async () => {
    const filas = await ctx.customers.listConversations({});
    return (filas ?? [])
      .filter((row) => !row.deleted_at && !row.empty && !row.archived_at)
      .filter((row) => veTodo || String(row.assigned_user_id ?? row.assigned_to ?? '') === String(actor?.id ?? ''));
  };

  const comprasPorCliente = async () => {
    const filas = await Promise.resolve(ctx.store.listAdmin({ limit: 5000 }));
    const mapa = new Map();
    for (const row of filas ?? []) {
      if (row.type !== 'order_intent') continue;
      const order = ordenar(row);
      const clientId = order?.customer_id ?? row.customer_id ?? null;
      if (!clientId) continue;
      const estado = String(order?.status ?? row.status ?? '').toLowerCase();
      const lista = mapa.get(clientId) ?? [];
      lista.push({
        pedido: order?.order_number ?? row.order_number ?? row.id,
        estado,
        total: Number(order?.total ?? row.total ?? 0) || 0,
        cuando: order?.delivered_at ?? row.received_at ?? null,
        lineas: (order?.items ?? []).map((line) => `${line.quantity ?? 1} × ${line.variantName ?? line.name ?? 'Producto'}`),
        productos: (order?.items ?? []).map((line) => String(line.variantName ?? line.name ?? 'Producto')),
      });
      mapa.set(clientId, lista);
    }
    return mapa;
  };

  /* ------------------------------------------------------------ ejecución */

  const noAutorizado = { ok: false, error: 'no_autorizado', nota: 'Ese cliente no está a tu alcance.' };
  const parametros = { ok: false, error: 'parametros', nota: 'Faltan datos para esa consulta.' };

  const ejecutar = {
    async clientes_buscar(args = {}) {
      const q = texto(args.q, 60);
      if (q.length < 2) return parametros;
      const limite = entero(args.limite, 1, 10, 5);
      const filas = await leerConversaciones();
      const busca = q.toLowerCase();
      const coincidencias = filas.filter((row) => String(row.customer?.name ?? '').toLowerCase().includes(busca));
      const encontrados = coincidencias
        .slice(0, limite)
        .map((row) => ({
          customerId: row.customer_id,
          nombre: row.customer?.name ?? 'Cliente',
          etapa: row.customer_stage ?? null,
          etiquetas: (row.tags ?? []).slice(0, 5),
          compras: row.has_purchase === true,
          ultimaCompra: row.last_purchase_at ?? null,
          diasDesdeUltimaCompra: diasDesde(row.last_purchase_at, ahora),
          pedidoAbierto: row.active_order ? { pedido: row.active_order.order_number, estado: row.active_order.status } : null,
          sinResponder: row.awaiting_reply === true,
          noContactar: Boolean(row.customer?.do_not_contact || row.customer?.whatsapp_opt_out_at),
        }));
      return {
        ok: true,
        /* `total` es todo lo que coincide; `datos` es la página pedida. */
        total: coincidencias.length,
        datos: encontrados,
        nota: encontrados.length ? 'Solo clientes que puedes ver.' : 'Ningún cliente visible coincide con esa búsqueda.',
      };
    },

    async cliente_ficha(args = {}) {
      const clave = texto(args.cliente, 80);
      if (!clave) return parametros;
      const filas = await leerConversaciones();
      let fila = filas.find((row) => String(row.customer_id) === clave);
      if (!fila) {
        const busca = clave.toLowerCase();
        const coincidencias = filas.filter((row) => String(row.customer?.name ?? '').toLowerCase() === busca);
        if (coincidencias.length > 1) {
          return {
            ok: false,
            error: 'ambiguo',
            nota: 'Hay varios clientes con ese nombre; elige uno por su customerId.',
            opciones: coincidencias.slice(0, 6).map((row) => ({ customerId: row.customer_id, nombre: row.customer?.name ?? '' })),
          };
        }
        fila = coincidencias[0] ?? filas.find((row) => String(row.customer?.name ?? '').toLowerCase().includes(busca));
      }
      if (!fila) return noAutorizado;

      const compras = (await comprasPorCliente()).get(fila.customer_id) ?? [];
      const entregadas = compras.filter((row) => row.estado === 'entregado');
      const productos = new Map();
      for (const compra of entregadas) {
        for (const nombre of compra.productos) productos.set(nombre, (productos.get(nombre) ?? 0) + 1);
      }
      return {
        ok: true,
        datos: {
          customerId: fila.customer_id,
          nombre: fila.customer?.name ?? 'Cliente',
          etapa: fila.customer_stage ?? null,
          etiquetas: (fila.tags ?? []).slice(0, 6),
          contacto: {
            noContactar: Boolean(fila.customer?.do_not_contact || fila.customer?.whatsapp_opt_out_at),
            motivo: fila.customer?.do_not_contact ? 'pidió no ser contactado' : fila.customer?.whatsapp_opt_out_at ? 'se dio de baja de WhatsApp' : null,
          },
          compras: {
            pedidos: entregadas.length,
            total: Math.round(entregadas.reduce((suma, row) => suma + row.total, 0) * 100) / 100,
            ultima: entregadas.map((row) => row.cuando).filter(Boolean).sort().at(-1) ?? null,
            diasDesdeUltima: diasDesde(entregadas.map((row) => row.cuando).filter(Boolean).sort().at(-1), ahora),
            productos: [...productos.entries()].slice(0, 8).map(([nombre, veces]) => ({ nombre, veces })),
          },
          pedidoAbierto: fila.active_order ? { pedido: fila.active_order.order_number, estado: fila.active_order.status } : null,
          seguimiento: fila.next_followup ? { motivo: fila.next_followup.reason ?? null, fecha: fila.next_followup.scheduled_at ?? null } : null,
          ultimoMensaje: fila.last_message
            ? {
                cuando: fila.last_message.at ?? null,
                de: fila.last_message.direction === 'inbound' ? 'cliente' : 'negocio',
                extracto: String(fila.last_message.body ?? '').slice(0, 120),
                sinResponder: fila.awaiting_reply === true,
              }
            : null,
        },
        nota: 'Compras = pedidos entregados. El sistema no sabe si el cliente consumió el producto.',
      };
    },

    async compras_recompra(args = {}) {
      const dias = entero(args.dias, 7, 180, 21);
      const limite = entero(args.limite, 1, 10, 8);
      const comercial = await commercialSnapshot({ ctx, can, actor, limits: { rows: limite, reposicionDias: dias } });
      return {
        ok: true,
        total: comercial.recompra.total,
        datos: comercial.recompra.filas,
        excluidosSinContacto: comercial.excluidos.sinContacto,
        criterio: comercial.recompra.criterio,
        nota: 'Recomendación: compró antes y no tiene pedido abierto. No implica que necesite el producto.',
      };
    },

    async pedidos_pendientes(args = {}) {
      const minimo = entero(args.dias, 1, 60, 2);
      const limite = entero(args.limite, 1, 10, 8);
      const filas = await leerConversaciones();
      const visibles = new Set(filas.map((row) => String(row.customer_id)));
      const compras = await comprasPorCliente();
      const pendientes = [];
      for (const [clientId, lista] of compras) {
        if (!veTodo && !visibles.has(String(clientId))) continue;
        for (const compra of lista) {
          if (!['nuevo', 'confirmado'].includes(compra.estado)) continue;
          const edad = diasDesde(compra.cuando, ahora);
          if (Number(edad ?? 0) < minimo) continue;
          const fila = filas.find((row) => String(row.customer_id) === String(clientId));
          pendientes.push({
            cliente: fila?.customer?.name ?? 'Cliente',
            customerId: clientId,
            pedido: compra.pedido,
            estado: compra.estado,
            dias: edad,
            total: compra.total,
            lineas: compra.lineas.slice(0, 4),
          });
        }
      }
      pendientes.sort((a, b) => Number(b.dias ?? 0) - Number(a.dias ?? 0));
      return {
        ok: true,
        total: pendientes.length,
        datos: pendientes.slice(0, limite),
        nota: 'Pedidos sin terminar hace al menos 2 días.',
      };
    },

    async conversaciones_sin_responder(args = {}) {
      const minimo = entero(args.horas, 1, 240, 24);
      const limite = entero(args.limite, 1, 10, 8);
      const filas = (await leerConversaciones()).filter((row) => row.awaiting_reply === true);
      const datos = filas
        .map((row) => ({
          cliente: row.customer?.name ?? 'Cliente',
          customerId: row.customer_id,
          horas: horasDesde(row.last_inbound_at ?? row.last_message?.at, ahora),
          extracto: String(row.last_message?.body ?? '').slice(0, 120),
          etapa: row.customer_stage ?? null,
          noContactar: Boolean(row.customer?.do_not_contact || row.customer?.whatsapp_opt_out_at),
        }))
        .filter((row) => Number(row.horas ?? 0) >= minimo)
        .sort((a, b) => Number(b.horas ?? 0) - Number(a.horas ?? 0));
      return { ok: true, total: datos.length, datos: datos.slice(0, limite), nota: 'El último mensaje es del cliente.' };
    },

    async catalogo_precios(args = {}) {
      const q = texto(args.q, 40).toLowerCase();
      const limite = entero(args.limite, 1, 12, 8);
      const catalogo = await ctx.inventory.catalog();
      const coincidencias = (catalogo?.presentations ?? []).filter(
        (row) => !q || String(row.name ?? '').toLowerCase().includes(q),
      );
      const presentaciones = coincidencias
        .slice(0, limite)
        .map((row) => ({
          nombre: row.name ?? row.label ?? row.id,
          capsulas: row.capsule_quantity ?? row.capsules ?? null,
          precio: Math.round((Number(row.sale_price_cents ?? 0) || 0) / 100),
          disponible: row.active !== false,
        }));
      return {
        ok: true,
        /* `total` es el catálogo que coincide; `datos` es la página pedida. */
        total: coincidencias.length,
        datos: presentaciones,
        existencias: Number(catalogo?.stock ?? 0) || 0,
        nota: 'Precios vigentes del catálogo. No se inventan promociones.',
      };
    },
  };

  /** Ejecuta una herramienta por nombre, con validación previa. */
  async function run(name, args = {}) {
    const limpio = String(name ?? '').trim();
    if (!Object.prototype.hasOwnProperty.call(ejecutar, limpio)) {
      return { ok: false, error: 'herramienta_no_autorizada', nota: 'Esa consulta no está registrada.' };
    }
    try {
      return await ejecutar[limpio](args && typeof args === 'object' ? args : {});
    } catch {
      return { ok: false, error: 'consulta_fallida', nota: 'No se pudo completar la consulta.' };
    }
  }

  return { spec, run, nombres: Object.keys(ejecutar) };
}

export { TZ as READ_TOOLS_TZ, dia as readToolsDay };
