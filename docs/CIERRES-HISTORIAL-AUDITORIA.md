# Historial de cierres — auditoría forense, integridad y filtros Hoy / Ayer / Intervalo

**Fecha:** 2026-10-22 · **Alcance:** lectura + UAT aislada (`data/uat/`, servidor local) · **Producción:** no tocada.
**Sin commit, sin push, sin despliegue.**

---

## 1. Arquitectura real del cierre (lo primero que hay que decir)

El «cierre diario» de este sistema **no es un registro persistido**. No existe una tabla de cierres, ni un
endpoint que guarde un cierre, ni un «confirmar cierre» que escriba nada:

- `state.tab === 'cierre'` → `renderDailyClose()` (`public/admin/app.js`) **calcula** el día en el navegador.
- `state.tab === 'historial-cierres'` → `renderCloseHistory()` **recalcula** cada día del intervalo.
- La fuente son los pedidos con estado **`entregado`** (`order_intent`), agrupados por **día de negocio**
  en `America/Santo_Domingo`.
- «Hacer corte» (`[data-daily-close-now]`) **no guarda nada**: vuelve a pintar el cálculo y avisa
  «Corte calculado con las entregas de hoy».

Búsqueda hecha para confirmarlo: `close_history|cash_close|daily_close|'closings'` en `server/**` → **0
resultados**. Tablas de la base: `items`, `messages`, `phytoemagry_*` (clientes, conversaciones,
inventario, sesiones de reparto, auditoría…) — **ninguna de cierres**.

### Qué es, entonces

| Concepto del encargo | ¿Existe? | Qué hay de verdad |
| --- | --- | --- |
| Caja / turno / cajero | No | No hay caja registradora ni turnos: se cierra por **día natural** |
| Apertura de caja | No | No hay saldo inicial |
| Efectivo contado | No | No se pide contar nada |
| Diferencia (faltante/sobrante) | No | No aplica: no hay conteo |
| Cierre confirmado por un usuario | No | No hay acción de cierre ni autor del cierre |
| Instantánea inmutable | No | El «cierre» es una **vista calculada**: si se corrige un pedido, el cierre del día cambia |
| Cuadre con el repartidor | **Sí** | `Efectivo en mano − (delivery cobrado + comisión)` → «El delivery entrega X a la empresa» |
| Historial por días | **Sí** | Suma de los modelos diarios del intervalo |

**Conclusión estructural:** el módulo es un **cuadre operativo de entregas por día**, no un arqueo de caja
fiscal. Todo lo que el encargo pide sobre apertura/contado/diferencia/inmutabilidad **no se puede auditar
porque no existe**; lo que sí existe se audita y se corrige abajo. Cambiar el modelo (cierres persistidos
con instantánea y autor) es una decisión de negocio, no un arreglo: queda propuesto, **no ejecutado**.

## 2. Registros y relaciones que se usan

```
items (id, type='order_intent', status, received_at, updated_at, order_json)
   order_json → { status:'entregado', delivered_at, total, delivery_fee, discount,
                  payment_method:'CASH'|'TRANSFER', delivery:{ delivery_user_id, fee },
                  items:[{ quantity, capsules, totalCapsules, price }] }
phytoemagry_delivery_tracking_sessions (order_id, status)   → solo para el estado «en camino»
phytoemagry_crm_users (id, role, display_name)              → a quién pertenece la entrega
```

Métodos de pago posibles: **solo `CASH` y `TRANSFER`** (`server/orders.mjs: PAYMENT_METHODS`), así que
«tarjeta» u «otros» no aplican: `total vendido = efectivo + transferencia` siempre.

## 3. Fórmulas verificadas (las reales, no las del enunciado)

```
ventas del día        = Σ total de pedidos entregados ese día de negocio
efectivo en mano      = Σ total de esos pedidos con pago CASH  (solo los que tienen repartidor)
transferencia         = Σ total de esos pedidos con pago TRANSFER
ganancia del delivery = delivery_fee + comisión por frascos
   comisión: 5 cáps.→150 · 10 y 60→200 · >10→250 · otro→0  (× cantidad de la línea)
cuadre                = efectivo en mano − ganancia del delivery
   >0 «El delivery entrega X a la empresa» · <0 «La empresa le entrega X al delivery» · 0 «Cierre cuadrado»
```

`Expected Cash = Apertura + Entradas − Salidas` y `Diferencia = Contado − Esperado` **no existen** en este
modelo. No se han inventado ni se han añadido.

## 4. Defectos confirmados y corregidos

### D1 — El historial se calculaba sobre una copia truncada (crítico)

`/api/admin/data` devuelve **los 500 registros más nuevos de todos los tipos**
(`SELECT * FROM items ORDER BY received_at DESC LIMIT ?`, `limit: 500`; 150 con `?light=1`). El historial
recorría esa copia, así que **con más volumen los cierres antiguos desaparecían** del historial y los
totales del intervalo salían a menos **aunque la nota dijera otra cosa**.

| | Valor |
| --- | --- |
| Esperado | El día con cierre aparece en el historial |
| Real (antes) | El día no aparece; el intervalo suma menos |
| Diferencia | El día completo (1 venta / DOP 1,250.50 en la reproducción) |
| Causa raíz | Fuente de datos truncada en el cliente |
| Corrección | Endpoint `GET /api/admin/reports/delivered-orders?from&to` (lee la base completa, mismo criterio de día y mismo permiso) y el historial lo usa |
| Prueba añadida | `tests/panel-historial-cierres-paginacion-uat.test.js` (505 registros de relleno más nuevos; la venta **no** llega en `/api/admin/data` y **sí** aparece en el historial) |

### D2 — Abrir un cierre antiguo desde el historial podía salir vacío (alto)

Misma causa: `renderDailyClose()` leía `state.items`. Con la fila visible en el historial, al entrar en el
día el detalle podía no tener ni una venta. **Corregido:** un día pasado se lee del endpoint (con la copia
local como respaldo inmediato y repintado al llegar).

### D3 — Recorte silencioso de 400 días que enseñaba los días más viejos (medio)

`closeHistoryDays(from, to, 400)` recorría **de `from` a `to`** y cortaba a los 400: un intervalo de dos
años mostraba los primeros 400 días y **ocultaba los recientes**, sin decirlo. **Corregido:** se recorre de
más nuevo a más viejo y la nota dice «se muestran los últimos 400 días» cuando se recorta. El servidor
rechaza el mismo rango con `422 range_too_long`.

### D4 — Intervalo con la fecha final antes que la inicial (bajo)

Se intercambiaban en silencio: se pedía 1–15 y se listaba 15–1. **Corregido en el historial**: se avisa
«La fecha «hasta» no puede ser anterior a la fecha «desde»» y **no se aplica nada**. Los reportes de ventas
conservan el intercambio porque tienen una prueba que lo exige (`panel-reportes-intervalo-uat`).

## 5. Duplicados y concurrencia

**No hay riesgo de cierre duplicado porque no hay cierre que escribir.** Las dos pantallas son de solo
lectura: pulsar dos veces «Hacer corte» solo repinta. Lo que sí es concurrente es el **cobro** de un pedido
(`order-payments.mjs`, con autorización por repartidor y `idempotencyKey`), que no se ha tocado.

Riesgo real que queda (documentado, no corregido): dos personas mirando el mismo intervalo ven el mismo
número porque se calcula igual, pero **no hay un «cerrado» que impida que un pedido se edite después** y
mueva el cierre de un día pasado.

## 6. Fechas y zona horaria (verificado)

- El día de negocio se calcula con `Intl.DateTimeFormat` en `America/Santo_Domingo` (`businessDayISO`).
- El servidor usa el mismo criterio (`dayIn(ctx.clock(), TIME_ZONE)`), y el endpoint nuevo repite la cadena
  exacta del cliente: `order.delivered_at ?? order.updated_at ?? item.updated_at ?? item.received_at ?? order.created_at`.
- Filtros de calendario: comparación de cadenas `YYYY-MM-DD` (día de negocio), equivalente a
  `[inicio 00:00 AST, fin+1 00:00 AST)` — sin conversiones UTC de por medio.
- **Hoy** y **Ayer** se calculan con `todayISO()` (hora de RD), no con la del dispositivo.
- Prueba: la UAT entrega a las **12:00 RD** (16:00 UTC) y el día cae donde debe; otro día distinto (hace 3
  días) se lista aparte.

## 7. Filtros implementados: Hoy | Ayer | Intervalo

Control segmentado, **siempre a la vista** (antes los filtros vivían en el panelito del embudo, que en el
móvil está escondido tras un botón):

- **Hoy** → `from = to = día de negocio actual`.
- **Ayer** → `from = to = hoy − 1`.
- **Intervalo** → abre el calendario (Desde / Hasta), valida, y la nota y el botón muestran el rango elegido
  (`Intervalo · 16/10/2026 – 22/10/2026`). Los rangos rápidos anteriores (7 días / 30 días / Este mes)
  siguen disponibles en el embudo, ahora como atajos del mismo intervalo.
- Al volver del detalle de un día **se conserva el filtro** elegido.
- Si el intervalo no tiene cierres, se dice («No hay cierres en estos días…») y la página mantiene nota y
  resumen: nunca queda en blanco.
- Sin conexión: se pinta con la copia local y la nota avisa «sin conexión: solo lo cargado en el panel».

## 8. Reconciliación (UAT aislada, navegador real)

Servidor UAT (`127.0.0.1:8790`, base `data/uat/phyto-uat.sqlite`). Ventas entregadas reales del entorno:

| Filtro | Panel | Pedidos entregados del servidor | Cuadre |
| --- | --- | --- | --- |
| Hoy | 1 cierre · 1 venta · DOP 2,500 | 1 pedido · 2,500 | ✅ |
| Ayer | 1 cierre · 1 venta · DOP 1,250.5 | 1 pedido · 1,250.5 | ✅ |
| Intervalo 16–22/10 | 3 cierres · 4 ventas · DOP 23,250.5 | 3 días, 4 pedidos | ✅ |

## 9. Permisos y auditoría (comprobado en el backend)

- `GET /api/admin/reports/delivered-orders` **exige sesión** → sin cookie: **401** (probado).
- Alcance: con `reports.profit.view` devuelve `scope:'all'`; sin él, filtra a las entregas del propio
  usuario (mismo criterio que la pantalla: `order.delivery.delivery_user_id === actor.id`).
- Fechas inválidas → **422**; intervalo > 400 días → **422 range_too_long** (probado).
- Los importes sensibles pasan por `sanitizeItemForPermissions` como el resto del panel.

## 10. Archivos modificados

| Archivo | Qué cambió |
| --- | --- |
| `server/crm-server.mjs` | Endpoint nuevo `/api/admin/reports/delivered-orders` + constante `CLOSE_HISTORY_MAX_DAYS` |
| `public/admin/app.js` | Filtros Hoy/Ayer/Intervalo, fuente remota con caché y avisos, día pasado desde el servidor, días de más nuevo a más viejo, validación del intervalo, `dailyCloseModel(clave, fuente)` |
| `public/admin/daily-close.css` | Control segmentado (claro y oscuro), aviso de error del intervalo, rangos rápidos al embudo |
| `public/admin/index.html` | Versiones: `daily-close.css?v=close-filtros-3`, `app.js?v=premium-38` |
| `public/admin/sw.js` | `VERSION = 'crm-v260-cierres-hoy-ayer-intervalo-20261022'` |
| `tests/panel-historial-cierres-uat.test.js` | 4 casos nuevos (Hoy/Ayer/Intervalo, intervalo invertido, cuadre contra el servidor, rechazos del endpoint) |
| `tests/panel-historial-cierres-paginacion-uat.test.js` | **Nuevo**: reproduce el defecto D1 y demuestra la corrección |

## 11. Pruebas automáticas

- `panel-historial-cierres-uat` → **12/12** (antes 8).
- `panel-historial-cierres-paginacion-uat` → **3/3**.
- Lote relacionado: `panel-reportes-intervalo-uat`, `pos-panel`, `store-panel` → **72/72 en total**.
- `offline-24h` → 2 fallos **preexistentes** («prepara los módulos y navega…», «aísla rechazos
  históricos…»). Verificado ejecutando el mismo archivo sobre un worktree de `HEAD` sin mis cambios:
  **los mismos 2 fallos**. No son de este trabajo.

## 12. Capturas (navegador real, Chromium)

`docs/capturas/cierres-hoy-movil-390.png` · `cierres-historial-movil-390-oscuro.png` ·
`cierres-intervalo-movil-390.png` · `cierres-intervalo-error-movil-390.png` ·
`cierres-hoy-movil-360.png` · `cierres-hoy-movil-430.png` · `cierres-historial-escritorio.png` ·
`cierres-historial-escritorio-oscuro.png`

Comprobado en 360 / 390 / 430 px y escritorio, claro y oscuro: **0 px de desborde horizontal**, los tres
botones pulsables, calendario dentro de pantalla y **consola sin errores** (17/17 comprobaciones).

## 13. Riesgos que quedan (sin tocar)

1. **No hay cierre persistido**: sin instantánea ni autor, un pedido editado cambia el cierre de un día
   pasado. Propuesta (no ejecutada): tabla `phytoemagry_daily_closures` con `built_at`, `built_by`,
   `payload_json` y una marca de «cerrado», más una corrección explícita y auditada para reabrir.
2. **Tope de 5.000 registros** en `store.listAdmin` (igual que el resto del servidor): con más de 5.000
   items el endpoint responde `truncated: true` — el panel no lo dice aún en pantalla.
3. **Sin efectivo contado**: si el negocio quiere arqueo (faltante/sobrante), falta el paso de conteo.
4. **El cierre es del negocio entero**, no por caja, turno ni empleado: los roles sin
   `reports.profit.view` solo ven sus entregas, pero no existe «cierre de caja 1».

## 14. Conclusión GO / NO-GO

- **GO** para publicar esta entrega: historial y detalle conciliados contra los pedidos de origen, filtros
  Hoy/Ayer/Intervalo funcionando en móvil y escritorio, permisos comprobados en el backend, sin regresiones
  en las pruebas relacionadas.
- **NO-GO** para declararlo «arqueo de caja / cierre fiscal inmutable»: eso **no existe hoy**. Para
  afirmarlo haría falta persistir el cierre con su instantánea y su autor, y un procedimiento de corrección
  auditado (punto 13.1). Mientras no se haga, este módulo debe presentarse como **cuadre diario de
  entregas**, que es lo que de verdad calcula.
