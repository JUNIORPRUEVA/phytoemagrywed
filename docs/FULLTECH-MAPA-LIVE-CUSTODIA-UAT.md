# FULLTECH — Custodia compacta y base del monitoreo GPS

Rama `integracion/smart-commerce-delivery` · worktree `C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato`.
**Sin push, sin merge, sin despliegue.** Nada de esto está en producción.

---

## 1. Auditoría (qué había antes)

| Pieza | Estado real |
|---|---|
| Pantalla de custodia (`custody.html`) | Propia, funcional, pero con cabecera alta y tarjetas grandes: mucho aire |
| Endpoints `delivery-cash`, `/movements`, `/incidents` | **Funcionales** (probados por HTTP) |
| `delivery-tracking.mjs` (`validateLocationUpdate`, `isLocationStale`, `shouldStorePoint`, `suspiciousJump`) | **Funcional**, pero atado al flujo interno del CRM (`delivery_user_id`) |
| Rutas `/api/admin/delivery-tracking[/events]` | **Existen** (sesiones + stream), para el flujo interno antiguo |
| `POST /api/courier/location` | **AUSENTE** — la app no tenía por dónde enviar su posición |
| Mapa de pedidos (`#view-mapa`) | **Existe**, pero no consume posiciones de la app |
| GPS en Flutter | **AUSENTE** (sin `geolocator`, sin permisos de ubicación, sin servicio en primer plano) |

Conclusión honesta: **el mapa no era un centro de monitoreo real** porque la app no enviaba ubicación y no había endpoint de repartidor.

## 2. Custodia rediseñada (hecho)

`public/admin/custody.html` + `custody.js` reescritos con criterio compacto:

- **Cabecera baja** (título 16 px) con acciones alineadas: *Actualizar*, *← CRM*. Sin banner ni descripción decorativa.
- **Cinco tarjetas** de altura fija y homogénea (bajo custodia, pendiente, rendido, con saldo, incidencias), en 5 columnas en escritorio, 3 en tablet y 2 en móvil.
- **Tabla protagonista**: Repartidor · Pedidos · Efectivo · Rendido · Pendiente · Estado · acción «Ver». Importes alineados a la derecha con `font-variant-numeric: tabular-nums`.
- **Una sola barra** de búsqueda + filtro + «actualizado».
- **Panel lateral** de 380 px con saldos, formulario de rendición (saldo antes/después) y movimientos con su pedido y fecha.
- **Incidencias** debajo, en tarjetas planas de borde ámbar.
- Responsive real: se ocultan columnas secundarias antes de permitir scroll horizontal.

Lógica financiera **intacta**: mismos endpoints, mismas validaciones, cero cambios en `delivery-cash.mjs`.

## 3. GPS del repartidor (backend implementado)

### Nuevo módulo `server/courier-location.mjs` (reglas puras)

| Regla | Detalle |
|---|---|
| Coordenadas | numéricas, en rango, y **rechaza (0,0)** («null island») |
| Precisión | `accuracy > 200 m` → `422 low_accuracy` |
| Tiempo | rechaza timestamps inválidos, futuros (>60 s) y de más de 10 min |
| Orden | **una posición vieja nunca pisa una nueva** → `409 out_of_order` |
| Saltos | velocidad > 55 m/s se acepta pero se marca `suspicious` (descartarla bloquearía el seguimiento) |
| Señal | `live` ≤ 2 min · `delayed` ≤ 10 min · `no_signal` · `no_location` |

### Endpoints

- **`POST /api/courier/location`** (nuevo): identidad **desde el token** (nunca del cuerpo), exige **entrega activa** (`409 no_active_delivery`), guarda **solo la última posición** por repartidor. No se construye historial de rutas.
- **`GET /api/admin/delivery-courier-positions`** (nuevo): solo `admin.full` o `delivery.manage`; devuelve última posición + antigüedad + estado de señal + pedido asociado. Verificado que **sin sesión responde 401**.
- Colección nueva `courier_positions`, **una fila por repartidor** (retención mínima por diseño).

## 4. Pruebas (ejecutadas en esta pasada)

| Grupo | Resultado |
|---|---|
| `tests/courier-location.test.js` (14 casos: coordenadas, tiempo, orden, saltos, señal) | **14/14** |
| `tests/custody-panel.test.js` (16 casos: métricas, columnas, barra única, rendición, datos reales) | **16/16** |
| `courier-access` + `delivery-payment` (regresión) | 40/40 |
| HTTP: `/admin/custody.html` | **200**, estructura nueva servida |
| HTTP: `/api/admin/delivery-courier-positions` sin sesión | **401** (no es público) |

## 5. Lo que **no** está hecho (y no lo doy por hecho)

1. **El mapa de pedidos no se reconstruyó** como centro de monitoreo: no consume aún `/api/admin/delivery-courier-positions`, no tiene clustering, ni filtros nuevos, ni ruta estimada.
2. **Flutter no envía ubicación**: faltan `geolocator`, permisos `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`, servicio en primer plano y la llamada al endpoint. Sin eso **no hay posiciones reales** y el mapa no puede mostrar repartidores.
3. **Sin dispositivo ni emulador conectado**: cero evidencia de GPS en vivo. Declarado explícitamente.
4. Ruta estimada / ETA: no implementadas (requiere el router de Smart Commerce o un servicio autorizado).

## 6. Riesgos

| Riesgo | Severidad |
|---|---|
| El mapa puede sugerir tiempo real sin datos (no debe publicarse así) | Alta |
| `courier_positions` sin retención programada todavía (se sobrescribe, pero no se purga al cerrar jornada) | Media |
| Endpoint de posiciones devuelve coordenadas a quien tenga `delivery.manage` | Media |
| Saltos sospechosos se guardan (marcados) — decisión consciente | Baja |

## 7. GO / NO-GO

- **Custodia: GO** (compacta, funcional, sin tocar reglas financieras).
- **Backend GPS: GO técnico** (validado y probado).
- **Mapa en vivo: NO-GO** — sin app enviando GPS no hay nada que mostrar; construir el mapa ahora sería una maqueta.
- **Integración global: NO-GO** hasta completar Flutter GPS + mapa y verificar posiciones reales.

## 8. Siguiente paso concreto

1. Flutter: `geolocator` + permisos + servicio en primer plano + `POST /api/courier/location` al iniciar entrega y detenerla al finalizar.
2. Mapa: consumir `/api/admin/delivery-courier-positions` cada 10–15 s (o SSE) con `state` → marcador verde/ámbar/gris.
3. Purga de `courier_positions` al cerrar la última entrega activa.
