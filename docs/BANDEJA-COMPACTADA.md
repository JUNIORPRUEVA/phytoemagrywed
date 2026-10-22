# Bandeja de WhatsApp: archivado íntegro y lista compacta (2026-10-22)

**Alcance:** solo lectura sobre datos reales + cambios en el CRM local/UAT. **Sin deploy, sin push,
sin commit.** No se ha tocado ninguna base de producción.

---

## 1. Qué se encontró en la auditoría (antes de cambiar nada)

**No existe ningún proceso que archive conversaciones por su cuenta.** Se revisaron todas las
escrituras de `archived_at` en el servidor (`server/customers.mjs`, `server/crm-server.mjs`) y solo hay
dos, las dos detrás de una acción humana y de `canOpenConversation`:

| Ruta | Qué hace | Quién la llama |
| --- | --- | --- |
| `customers.archiveConversation(id, archived)` | archiva / desarchiva una conversación | `POST /api/admin/conversations/:id/archive` y `…/unarchive` (menú «⋯» y panel de selección) |
| `customers.resolveConversation(id, resolved)` | finaliza **y** archiva (`archived_at = now`) | `POST …/resolve` y `POST /api/admin/conversations/bulk` con `action: 'resolve'` |

No hay temporizadores, webhooks, tareas del planificador, cambios de asignación ni cierres de la
ventana de 24 h que escriban ese campo. `recordInbound` hace lo contrario: **limpia** `archived_at`.

### Tres defectos reales que sí se corrigieron

1. **Archivar no dejaba rastro.** `conversation.archived` y `conversation.unarchived` **no estaban** en
   la lista blanca de `server/audit.mjs`, y `record()` descarta en silencio las acciones que no
   conoce. La ruta «registraba» el evento y no se guardaba nada: era imposible saber quién sacó un
   chat de la bandeja.
2. **El archivo no tenía autor ni motivo.** Solo se guardaba `archived_at`, así que «archivado a mano»
   y «archivado al finalizar» eran indistinguibles.
3. **Aviso de archivados en la bandeja.** El contador «N archivados · Ver» y el número del chip
   convertían la bandeja en un tablero y hacían que un chat «desapareciera» sin explicación visible.

### Por qué parece que se archiva solo

- **Finalizar archiva con el mismo clic.** «Marcar como finalizado» (menú «⋯» y panel de selección)
  saca el chat de la bandeja: es intencionado y está escrito en la propia UI, pero se percibe como
  archivado automático si se pulsa pensando que solo «marca como leído».
- **Copia local del panel.** Si el `POST` de archivar no llega al servidor, `aplicarArchivoLocal` deja
  la fila archivada en la copia del teléfono: desaparece de la lista aunque el servidor nunca la
  archivó. Al refrescar con red, la copia se sustituye por la real.
- **No hay evidencia en las bases locales:** `data/uat`, `phytoemagry`, `phyto-local-preview` y
  `demo-panel` tienen **0 conversaciones archivadas**. La base de producción (PostgreSQL) no se ha
  inspeccionado: haría falta autorización y sería solo lectura.

---

## 2. Cambios

### Archivado (servidor)

- `server/customers.mjs`
  - `archiveConversation(id, archived, { byUserId, byDisplayName })` guarda `archived_reason`
    (`manual`), `archived_by_user_id`, `archived_by_display_name_snapshot`, y al desarchivar
    `unarchived_at` / `unarchived_by_user_id`.
  - `resolveConversation` marca `archived_reason: 'finalize'` y el autor.
  - `recordInbound` deja `reopened_at` y `reopen_reason: 'inbound_message'` cuando devuelve a la
    bandeja un chat archivado o finalizado (misma conversación, mismo hilo, sin duplicar).
- `server/crm-server.mjs`: la ruta de archivar pasa el actor real a la auditoría (`by_user_id`,
  `reason`).
- `server/audit.mjs`: se añaden `conversation.archived` y `conversation.unarchived` a la lista blanca.

### Bandeja (panel)

- **Fuera el contador de archivados**: se elimina el aviso `wa-archived-hint` de la lista y de los
  estados vacíos, y el chip «Archivados» deja de mostrar número (sigue existiendo como acceso).
- **Fuera los avatares falsos**: solo se pinta `.conv__avatar` cuando hay foto real
  (`customerPhotoUrl`); si no, no hay columna ni hueco (la rejilla pasa de `42px 1fr` a `1fr`, el
  nombre empieza a 16 px del borde). Ni iniciales ni círculos de color.
- **Fila compacta de tres líneas** (76 px): nombre + sello · vista previa + no leídos · responsable ·
  etapa. Separador fino desde el margen del texto, sin sangría de 78 px.
- **Sello con fecha Y hora**: hoy `10:42 AM` · ayer `Ayer · 4:25 PM` · antiguo `20 oct. · 3:12 PM`,
  en `America/Santo_Domingo` y `es-DO`. Fuente: `last_message_at` (solo se mueve con un mensaje), no
  `updated_at` ni la fecha de la ficha.
- **Responsable**: `assigned_user_id` + `assigned_display_name_snapshot` («Sin asignar» si no hay).
- **Estado**: la etapa real del CRM (`customer_stage`: Prospecto / Interesado / Cliente / Inactivo).
  No se usa el estado de la conversación, ni el del pedido, ni `commercial_state`.
- **Iconos**: lupa (círculo + mango), tres barras decrecientes (filtro), chevron suelto (volver) y
  cruz (botón nuevo), dibujados como SVG inline con los mismos trazos que las imágenes aportadas.
- **Botón flotante**: 52 px, radio 18, degradado FULLTECH, `+` blanco y sombra de dos capas; en oscuro
  se mantiene azul profundo (el degradado de marca se aclara y perdía contraste).

---

## 3. Verificación

| Qué | Resultado |
| --- | --- |
| `tests/wa-archivado-integridad.test.js` (nuevo, servidor real y base temporal) | **12/12** |
| `tests/conversation-resolution.test.js` | **6/6** |
| `tests/wa-inbox`, `panel-shell-uat`, `panel-whatsapp`, `panel-conv-list-uat` | **120/123** |
| UAT navegador (Chromium, 360/390/430/1440 × claro/oscuro) | **116/116** |

Los **3 fallos** de `panel-conv-list-uat` son los ya clasificados y ajenos a esto: «Pedir
confirmación» (2 casos) y «preferencias del pedido», que dependen del flujo POS/pedido.

Pruebas del archivado: mensaje del cliente, respuesta del equipo y marcar leído dejan el chat activo;
un mes después (ventana de 24 h cerrada) sigue activo; el planificador no archiva; tomar/liberar no
archiva; archivar a mano guarda autor, motivo y auditoría; archivar dos veces no duplica el hilo;
desarchivar lo devuelve a la bandeja; sin sesión, 401; un mensaje nuevo reabre la MISMA conversación y
conserva los mensajes; un webhook repetido no crea otra conversación; el estado sobrevive al reinicio
del backend; una prueba de código falla si aparece otra escritura de `archived_at`.

Capturas: `docs/capturas/bandeja-{movil-360,movil-390,movil-430,escritorio}-{light,dark}.png` y
`bandeja-vuelta-lista-390.png`. Script: `.tmp/uat-bandeja-compacta.mjs`.

---

## 4. Pendiente

- Los 3 fallos ajenos de `panel-conv-list-uat`.
- Revisar la base de **producción** (solo lectura) para confirmar si hay conversaciones archivadas con
  patrón de finalización; requiere autorización.
- Un `POST` de archivado que no llega al servidor deja la fila archivada solo en la copia local del
  panel hasta el siguiente refresco con red (se documenta, no se cambió el motor offline aquí).

---

## 5. Refinamiento a DOS líneas (2026-10-22, segunda pasada)

La fila de tres líneas medía 76 px. Ahora son **dos líneas de 56 px** repartidas en una rejilla de
2 columnas × 2 filas:

```
[icono]  Nombre del cliente ..................  20 oct · 10:52 PM
         Hola, este es tu pedido: ………            Sin asignar · Prospecto   (1)
```

- **Izquierda**: icono de cliente + nombre (línea 1) y último mensaje (línea 2).
- **Derecha**: hora (línea 1) y, justo debajo, responsable · etapa y el contador de no leídos.
- El bloque derecho se limita con `max-width: min(46vw, 190px)`. Un `max-width` en **porcentaje** se
  resolvía contra la propia columna `auto` y la dejaba en 74 px: el responsable salía como «s…».

### Icono de cliente

`clientes.png` (512×512, 17 KB) se optimizó a **64×64 monocromo con transparencia (≈2,7 KB)**: se
recortó el margen, se pasó el trazo a alfa y se guardó en `public/admin/assets/icons/ui/clientes.png`.
Se muestra a 17 px, `opacity: .5`, delante del nombre y centrado con su tipografía; en modo oscuro se
invierte a blanco (`filter: invert(1)`). Si hay foto real verificada, la foto ocupa ese mismo hueco y
el icono genérico no se pinta (nunca los dos).

### Otros ajustes de esta pasada

- `conversation-list.css` fijaba `min-height: 76px` con un selector por id (ganaba a `wa-lista.css`):
  ahora 56 px. El nombre pasa de 600 a **500** (los no leídos siguen a 600) para que la jerarquía se
  note.
- Contador de no leídos dentro de la segunda línea (17 px de alto): no añade renglón ni empuja la hora.
- Piezas retiradas: `.conv__line--meta` (tercera línea) y el avatar de 42 px.
- Versiones nuevas: `wa-lista.css?v=lista-dos-lineas-1`, `conversation-list.css?v=lista-dos-lineas-1`,
  `app.js?v=premium-40`, `sw.js` → `crm-v264-bandeja-dos-lineas-20261022`.

### Verificación de esta pasada

| Qué | Resultado |
| --- | --- |
| `tests/panel-conv-list-uat.js` + `panel-whatsapp` + `wa-inbox` + archivado + resolución | **120/123** |
| UAT navegador (360/390/430/1440 × claro/oscuro) | **164/164** |

Mediciones reales en 390 px: fila 56 px · icono 17 px a 24 px del borde (antes del nombre) · nombre
20 px de alto · hora 88 px alineada a la derecha · mensaje 16 px · bloque de gestión 127 px a la
derecha sin solaparse con el mensaje (`preview.right 241 < meta.left 251`) · desborde horizontal 0 px
en las cuatro anchuras. Capturas «antes/después»: `bandeja-*` (tres líneas, 76 px) y `bandeja-2l-*`
(dos líneas, 56 px).

