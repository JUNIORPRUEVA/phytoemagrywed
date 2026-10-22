# Bandeja: filtros por etapa, prioridad y búsqueda en el historial (2026-10-22)

**Alcance:** local + UAT aislada. **Sin deploy, sin push, sin commit.** No se tocó producción ni el
historial de mensajes.

---

## 1. Arquitectura actual (lo que ya había y se reutiliza)

- **Fila**: dos líneas de 56 px (`waRow`): icono + nombre / hora arriba; mensaje / responsable · etapa
  abajo. Sin avatares falsos.
- **Backend**: `GET /api/admin/conversations?filter=&q=&from=&to=` → `conversationPage()` →
  `filterConversationRows()` sobre filas ya decoradas. Una sola lectura de clientes, pedidos,
  seguimientos y los últimos 5.000 mensajes (`loadInboxData`).
- **Ciclo del cliente**: `resolveCustomerStage()` con 4 etapas (Prospecto / Interesado / Cliente /
  Recompra), implementado y probado (`tests/customer-lifecycle.test.js`, 33/33).
- **Conversación**: abierta / finalizada / archivada / asignada, con su propia auditoría. Archivar no
  toca la etapa.

## 2. Etapas en la fila

Etiqueta con **punto de color + texto** (nunca color solo):

| Etapa | Color claro | Color oscuro |
| --- | --- | --- |
| Prospecto | gris azulado `#6b7785` | `#9aa6b2` |
| Interesado | azul `#1f6feb` | `#7fb0ff` |
| Cliente | verde `#1f8f5b` | `#6fd3a1` |
| Recompra | violeta `#7150cf` | `#b6a4ff` |

Responsable: texto secundario normal; «Sin asignar» en **ámbar contenido** (`#a5691a` / `#e0b269`).
Nada de píldoras grandes ni fondos de color en la fila.

## 3. Panel de filtros (rediseñado)

Cajón de 82 % de ancho (máx. 340 px en móvil; en escritorio se queda en su columna), con grupos y
**filas rectangulares de 38-40 px, radio 7 px**, separadas por un título pequeño en mayúsculas:

- **Bandeja**: Todos · Míos · Sin asignar · Nuevos · Pendientes (con su cuenta).
- **Etapa del cliente**: Prospectos · Interesados · Clientes · Recompra (punto de color + cuenta real
  del servidor).
- **Fecha**: una fila que abre el selector (Hoy / Ayer / 7 días / Este mes / rango personalizado).
- **Orden**: Recientes · Atención.
- **Archivados**: bloque separado abajo, con su cuenta. Es un estado de la conversación, no una etapa:
  al elegirlo se limpia la etapa para no mezclar ejes.
- **Pie**: «Limpiar filtros» y, en pequeño, «Notificaciones» y «Sonido» (ya no parecen filtros).

La selección usa un **azul FULLTECH suave** (no el verde de WhatsApp). Los filtros **se combinan**: etapa
+ fecha, etapa + sin asignar, etapa + orden; «Limpiar filtros» los apaga todos. Se recuerdan entre
visitas (`pe_tema`/preferencias) y el estado vive en la URL lógica del panel (sin recargar la página).

## 4. Prioridad de venta (explicable, opcional)

`sort=priority` puntúa con hechos y devuelve **el porqué** en `priority.razones`:

| Hecho | Puntos |
| --- | --- |
| Pide una persona (`HUMAN_REQUIRED`) | 45 |
| Espera respuesta | 30 |
| Mensaje sin leer | +15 |
| Etapa Interesado | 25 |
| Pedido por confirmar (nuevo/confirmado) | 20 |
| Seguimiento vencido o de hoy | 18 |
| Sin asignar | 12 |
| Más de 24 h esperando | 8 |

El orden por defecto **sigue siendo actividad reciente**: solo cambia si la persona elige «Atención».
Ese motivo aparece como `title`/`aria-label` de la fila (nada de cajas negras).

## 5. Búsqueda en el historial (sin IA)

- Busca en **nombre, teléfono, historial de mensajes y número de pedido**, con varias palabras (todas
  deben aparecer) y sin distinguir acentos ni mayúsculas.
- Reutiliza los 5.000 mensajes que la bandeja ya lee: índice acotado de **200 cuerpos por
  conversación**. No hay una consulta por pulsación ni se recorre la base entera.
- Devuelve **una fila por conversación** (nunca una por mensaje) con `match`: `campo`
  (`cliente`/`mensaje`/`pedido`), `snippet`, `message_id` y fecha. La fila muestra el fragmento con una
  lupa delante.
- Buscar sigue siendo **global** (también archivadas), por diseño y documentado: los filtros no recortan
  mientras se busca y vuelven al borrar el texto.
- El campo conserva **el foco y el cursor** aunque llegue un refresco (se corregía al repintar la barra).
  Cero llamadas a modelos.

## 6. Fechas

`Hoy` / `Ayer` / rango con `from`/`to` inclusivos, calculados con `America/Santo_Domingo` sobre
`last_message_at` (nunca la fecha de modificación del cliente). Rango inválido → **422**. Las
archivadas se filtran por fecha del último mensaje (misma regla, documentado).

## 7. Índices y rendimiento

`wa_messages` se lee **una vez** por carga (`limit 5000`) y ya está indexada por conversación y fecha;
el índice de búsqueda se construye en memoria en esa misma pasada (200 cuerpos por conversación), así
que el coste de buscar es el de filtrar cadenas, no el de consultar la base. Medición de la UAT: la
bandeja responde en **~40-60 ms** en local con 15 conversaciones; el panel no hizo más de **1 petición
por búsqueda** (comprobado en la consola de red durante la UAT).

## 8. Evidencia

| Prueba | Resultado |
| --- | --- |
| `tests/wa-inbox-filtros.test.js` (nuevo) | **13/13** |
| Bandeja + archivado + ciclo + paneles | **166/169** (3 fallos ajenos ya clasificados) |
| UAT navegador 360/390/430/1440 × claro/oscuro | **105/105** |

Capturas: `docs/capturas/filtros-{bandeja,panel,interesados,archivados,busqueda,vacio}-{ancho}-{tema}.png`.
Script: `.tmp/uat-bandeja-filtros.mjs`.

## 9. Riesgos / pendientes

1. La búsqueda mira los **últimos 5.000 mensajes** (200 por conversación). Un mensaje muy antiguo de un
   hilo muy largo no aparecerá; para eso haría falta FTS en la base (otra tarea).
2. En escritorio el cajón de filtros mantiene el ancho de su columna (no el 82 %); es el diseño actual.
3. Buscar ignora los filtros (decisión documentada desde antes: «buscar es buscar en todas»).
4. Los 3 fallos de `panel-conv-list-uat` («Pedir confirmación» ×2 y preferencias del pedido) siguen
   siendo ajenos a esto.

**GO** en UAT para filtros, prioridad y búsqueda; **NO-GO para desplegar** sin autorización.
