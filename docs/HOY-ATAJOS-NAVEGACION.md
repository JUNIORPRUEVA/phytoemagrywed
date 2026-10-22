# HOY · atajos que no secuestran el trabajo (2026-10-22)

Pantalla **Hoy** del CRM (`public/admin/`). Dos reglas nuevas:

1. Un indicador en **cero** no lleva a una lista vacía: se queda donde está y dice por qué.
2. Un atajo **no** cambia las preferencias de la persona: abre su lista con el filtro puesto y, al
   volver, devuelve el filtro, la etapa, las fechas, la búsqueda, la conversación y el borrador
   que había.

Nada de esto toca reglas de negocio (etapa del cliente, archivado, facturación) ni datos: es
navegación y estado de pantalla.

---

## 1. Causa raíz del filtro que se quedaba pegado

`abrirDesdeTarjeta()` escribía el filtro del atajo **en el mismo `state`** que las preferencias de
la persona y después llamaba a `setTab()`. Y `setTab()` termina guardando los filtros puestos:

```js
// antes
guardarFiltrosActuales();   // → localStorage['pe_prefs'].waFilter = 'pendientes'
```

Consecuencia: pulsar «Mensajes sin responder» una vez dejaba la bandeja filtrada por «Pendientes»
**para siempre** —también después de recargar— aunque la persona nunca hubiera elegido ese filtro.

Segundo escape, encontrado en la auditoría: el manejador global de `document` reconoce
`[data-order-filter]` y `[data-order-date]` (son los chips de la pantalla de Pedidos) y las
tarjetas del tablero llevan esos mismos atributos para saber a dónde ir. Un clic en «Pedidos
pendientes» se interpretaba **además** como «la persona eligió el filtro» y lo guardaba. Ahora ese
manejador ignora lo que está dentro de `#stats [data-goto]`; de las tarjetas se ocupa solo `#stats`.

## 2. Indicadores auditados y comportamiento en cero

Los ocho indicadores del tablero (`#stats`, `renderStats()`):

| Indicador | Destino | Atajo | Mensaje si está en cero |
|---|---|---|---|
| Sin responder | WhatsApp | filtro `pendientes`, sin etapa, todas las fechas | «Sin mensajes pendientes» |
| Sin asignar | WhatsApp | filtro `sin-asignar` | «Nada por asignar» |
| Pedidos pendientes | Pedidos | estado `pendiente` + fecha **hoy** | «Sin pedidos pendientes» |
| Seguimientos vencidos | Seguimientos | bloque `vencidos` | «Ninguno vencido» |
| Seguimientos de hoy | Seguimientos | bloque `hoy` | «Nada agendado para hoy» |
| Clientes | Clientes | chip `todos` | «Sin clientes registrados» |
| Interesados | Clientes | chip `interesados` | «Sin interesados» |
| Con compra | Clientes | chip `clientes` | «Sin clientes con compra» |

En cero la tarjeta:

- conserva su número real (`0`), su icono y su sitio;
- se pinta apagada (`stat--empty`: borde punteado, sin sombra, sin el halo azul);
- cambia la flecha por una línea corta y neutra (`.stat__hint`);
- se marca `disabled` + `aria-disabled="true"` y **no navega**, no pide datos y no toca filtros.

Ninguna tarjeta mezcla «ver el cero» con «crear algo»: no hay acciones independientes dentro de
ellas, así que la regla es la misma para las ocho (una sola política, sin casos especiales).

## 3. Cómo se guarda y se devuelve el contexto

```
state.hoyContexto[destino] = { instantanea: {...}, aplicado: 'huella', at }
```

- `instantanea` — lo que la persona tenía puesto **antes** de aplicar el atajo:
  - WhatsApp: `filter`, `stage`, `q`, `date`, `selectedId`, `draft`, punto de lectura de la lista.
  - Pedidos: `pedidosFilter`, `pedidosDate`, `pedidosSearch`.
  - Seguimientos: `followupsFilter`. Clientes: `filter`, `q`.
- `aplicado` — huella (firma) de los campos que el atajo cambió. Al volver:
  - si la huella **coincide**, se restaura la instantánea;
  - si **no** coincide, la persona tocó algo dentro del viaje (otro filtro, un chat): manda su
    elección y no se pisa nada.
- El viaje de ida se hace con `setTab(destino, { temporal: true })`, que **no** llama a
  `guardarFiltrosActuales()`. Lo temporal nunca llega a `localStorage`.
- Hay un contexto por pestaña, así que dos atajos seguidos no se pisan: si ya había un viaje
  abierto a esa pantalla se conserva **su** instantánea (la de la persona, no la del atajo anterior).
- Si los permisos impiden entrar (repartidor, roles), `setTab` redirige: se deshace el filtro del
  atajo y no se apunta nada.

## 4. Qué se recupera exactamente

- Rama de WhatsApp («Pendientes»), etapa comercial, orden, rango de fechas y ámbito de **Archivados**.
- Texto de búsqueda y, si había una, el buscador **abierto con su texto** (se deduce del propio
  texto: la bandera de «buscador abierto» se apaga al salir de la pestaña).
- Conversación abierta: se **reabre** con `selectConversation()` (el hilo se relee del servidor) y
  con el **borrador** que se estaba escribiendo.
- Punto de lectura de la lista. Se apunta en `setTab` **antes** de ocultar la pantalla, porque al
  ocultarse Chromium devuelve `scrollTop` a 0.
- Pedidos: estado, fecha y búsqueda. Seguimientos: bloque. Clientes: chip y búsqueda.

Lo que **no** se restaura, a propósito: los datos. Al volver se piden otra vez (`refreshWhatsapp()`
y la lista server-side con el filtro restaurado), así que un chat nuevo o un contador distinto se
ven tal y como están ahora. Se restaura la preferencia de la persona, no los números de hace un rato.

## 5. Archivos tocados

| Archivo | Cambio |
|---|---|
| `public/admin/app.js` | `CONTEXTO_HOY`, `leerRuta/escribirRuta`, `huellaDeRutas`, `instantaneaDelDestino`, `abrirConContextoDeHoy`, `cerrarContextoDeHoy`; `abrirDesdeTarjeta` reescrito; guarda de cero en las tarjetas; `stat__hint`; `setTab` (contexto temporal + punto de lectura antes de ocultar); `renderWaList` (punto de lectura al volver); guarda `#stats` en el manejador global de clic. |
| `public/admin/admin.css` | `.stat--empty` (claro y oscuro) y `.stat__hint`. |
| `public/admin/index.html` | Versiones de caché (`admin.css`, `app.js`). |
| `public/admin/sw.js` | `VERSION = 'crm-v269-hoy-cero-contexto-20261022'`. |
| `tests/panel-hoy-atajos-uat.test.js` | **Nuevo**: 14 pruebas del cero y de la vuelta exacta. |
| `tests/panel-hoy-uat.test.js` | Aserciones puestas al día (`aria-checked` del panel de filtros, contenido real de las listas, tarjeta en cero). |

No se tocó ningún archivo del servidor, ni la etapa del cliente, ni el archivado, ni la facturación.

## 6. Verificación

**Automatizada (jsdom, panel real + CRM real, datos ficticios aislados)**

- `tests/panel-hoy-atajos-uat.test.js` · **14/14**.
- `tests/panel-hoy-uat.test.js` · 14/15 (el que falla usa `#wa-actions`, un botón del compositor
  que ya no existe: falla igual sin estos cambios).
- `tests/panel-whatsapp.test.js`, `tests/panel-shell-uat.test.js`, `tests/panel-outreach-uat.test.js` ·
  **65/65**.
- `tests/panel-conv-list-uat.test.js` · 42/45 (los 3 fallos de «Pedir confirmación»/preferencias son
  previos y ajenos).

**Navegador real (Chromium) · `.tmp/uat-hoy-navegacion.mjs` · 33/33**

- 360·390·430·1440, claro y oscuro: toda tarjeta en cero apagada y con su mensaje entero, sin
  desbordamiento horizontal, y pulsarla no navega.
- Sobre el UAT (390): `sin-asignar` → atajo «Sin responder» → vuelta = `sin-asignar`; la preferencia
  guardada no se contamina; tras recargar sigue `sin-asignar`; el punto de lectura vuelve a 320 px.
- Sin errores de consola.

Capturas en `docs/capturas/`:

- `hoy-cero-360-light.png`, `hoy-cero-390-light.png`, `hoy-cero-390-dark.png`, `hoy-cero-430-light.png`,
  `hoy-cero-1440-light.png`
- `hoy-vuelta-1-propio.png` → `hoy-vuelta-2-atajo.png` → `hoy-vuelta-3-temporal.png` →
  `hoy-vuelta-4-de-vuelta.png` → `hoy-vuelta-5-final.png` → `hoy-vuelta-6-lectura.png`

## 7. Riesgos conocidos

- **Volver** se dispara al entrar de nuevo en la pantalla, no por historial: el panel no crea
  entradas de historial al cambiar de sección (salvo `catalogo/inventario/recuento/cotizaciones`),
  así que Atrás/Adelante del navegador siguen funcionando como antes. Recargar en mitad del viaje
  abre con la preferencia guardada, no con el filtro del atajo.
- Si la persona escribe en el buscador y el viaje caduca (recarga), el texto se pierde: es estado de
  pantalla, no un borrador guardado.
- El punto de lectura se sostiene 4 s durante el regreso (la lista se repinta dos veces: memoria y
  servidor). Pasado ese tiempo no se vuelve a aplicar.
- Las tarjetas no muestran contadores inventados: si el panel está mostrando una copia guardada, el
  número es el de esa copia, como antes.

## 8. Decisión

**GO** para UAT/producción de este cambio, con las comprobaciones hechas y sin commit, push ni
despliegue: el defecto reportado está cerrado (el filtro del atajo no se guarda), la vuelta
devuelve el sitio exacto y los indicadores en cero ya no llevan a ninguna parte.
