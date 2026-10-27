# FullTECH CRM — app nativa (Flutter)

App del **panel CRM** (antes solo web) hecha en Flutter para Android, iOS y Windows.
Consume **la misma API** del panel (`/api/admin/...`), así que **la PWA no se toca**:
`public/admin` y `server/` quedan exactamente igual y siguen funcionando.

> Nota: `apps/phytoemagry_panel` era un primer esbozo (login + bandeja + cuenta). Esta app
> lo sustituye con el panel completo. Se deja intacto para no borrar nada sin autorización.

## Qué hay portado

| Grupo | Pantallas |
|---|---|
| Principal | Hoy, Chats (bandeja + hilo con envío), Pedidos (+ detalle), Clientes (+ ficha) |
| Ventas | Facturación (catálogo), Ajuste de stock, Cotizaciones, Archivo de solicitudes, Recuento, Recogidas, Tiendas |
| Entregas | Mapa (repartos en vivo), Custodia y rendiciones, Repartidores |
| Operación | Agentes IA (resumen, bandeja, agentes), Seguimientos, Mensajes programados |
| Cierre y reportes | Cierre actual, Reportes por periodo |
| Administración | Usuarios, Configuración (ajustes, auditoría, tema), Mi perfil |

Todo el sistema visual (colores, radios, tema claro/oscuro, menú lateral, barra inferior de
4 destinos, tarjetas de recuento, píldoras de estado) está reimplementado en Flutter a partir
de `public/admin/admin.css` y `public/admin/shell-v2-tema.css`
(ver `lib/core/theme/crm_tokens.dart` y `lib/core/theme/crm_theme.dart`).

## Arranque

```powershell
cd apps/fulltech_crm
flutter pub get
flutter run --dart-define=APP_ENV=dev --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

### Entornos (fail-closed)

`APP_ENV` es obligatorio para todo lo que no sea producción:

| APP_ENV | URL | Resultado |
| --- | --- | --- |
| *(vacío)* | *(vacía)* | **prod** contra el dominio canónico (`https://phytoemagryrd.lat`) |
| `prod` | URL local | **se bloquea** (build mal etiquetado) |
| `dev` / `uat` | URL de producción | **se bloquea** (una compilación de pruebas no puede tocar el CRM real) |
| `dev` / `uat` | sin URL | **se bloquea** con la instrucción exacta |
| `dev` / `uat` | servidor propio | permitido; el panel lleva el distintivo **DESARROLLO** / **UAT** |

Si la combinación es incoherente la app **no arranca**: muestra una pantalla de
configuración con el comando correcto (`lib/features/config/config_error_screen.dart`).

## Etapa 0 — protecciones implementadas

**Dinero (POS).** `lib/core/pos/pos_sale.dart` replica el cálculo del servidor
(`public/admin/pos-math.js`): precio unitario en centavos, envío redondeado y
`expectedTotal` como entero. El `requestId` se conserva mientras el ticket no
cambie y solo se renueva al cobrar o al modificar datos; además viaja
`x-fulltech-operation`. Consecuencias:

- reintentar tras un timeout **no duplica** la venta (el servidor devuelve el mismo documento);
- `price_changed` → no se registra nada y se puede recargar el catálogo;
- `open_orders` → confirmación explícita (`acknowledgeOpen`);
- sin respuesta → estado **INCIERTO**: no se reenvía solo, se consulta
  `/api/admin/offline-operations/status` y decide la persona.

**Cola offline.** `lib/data/local/outbox.dart` + `outbox_service.dart`: máquina de
estados persistente (`queued → sending → retryable | permanent`), máximo 5
intentos, errores permanentes que no se reintentan solos, reintento y descarte
manuales. Solo admite `message`, `resolve` y `reopen`: **ningún cobro, venta,
devolución ni cambio de estado de pedido entra en la cola**.
Cada operación lleva su clave `x-fulltech-operation` — el mecanismo de
idempotencia que ya existe en `server/offline-operations.mjs` — así que un
reintento no duplica ni el mensaje ni el cambio de estado.

**Listados incompletos.** `GET /api/admin/data?light=1` corta en 150 registros.
La app lo dice (`lib/data/models/partial_data_notice.dart` + banner del shell) y
pide completos los clientes (`/api/admin/customers`) y la bandeja
(`/api/admin/conversations`). Los **pedidos** todavía no tienen endpoint
paginado: contrato necesario documentado abajo.

**Seguridad local.** La cookie `pe_crm` vive en el almacén seguro del sistema
(`flutter_secure_storage`), con migración y borrado de la copia en
`SharedPreferences`. Al cerrar sesión se vacía la cola y se **borran** los
documentos descargados (`crm_docs`, purga a los 2 días). No se registran cookies,
cuerpos ni nombres de cliente en los logs.

## Contrato pendiente (servidor, no aplicado)

Para dejar de mostrar el aviso de «pedidos recortados» hace falta un endpoint
paginado, por ejemplo:

```
GET /api/admin/orders?status=<estado>&from=<iso>&to=<iso>&page=1&limit=50
→ { ok, items:[...], page:{ page, limit, total, pages } }
```

No se ha tocado el servidor: queda preparado para hacerse en una rama aparte y
sin afectar a la PWA (que hoy usa el paquete completo).

## Pruebas

```powershell
flutter test
```

Cubren entorno fail-closed, totales en centavos, idempotencia del POS,
clasificación de errores (timeout / `price_changed` / `open_orders`), cola
persistente y sus estados, deduplicación por clave, almacén de sesión con
migración, listados parciales, permisos y cabeceras del cliente.

## Sesión

El servidor identifica la sesión del panel con la cookie `pe_crm` (HttpOnly).
La app guarda su valor y lo reenvía en la cabecera `Cookie`, igual que el cliente de la
tienda con `ft_store_session`. No hay token ni `X-CSRF`: el contrato es el mismo del panel.

## Datos

`GET /api/admin/data?light=1` trae en una sola petición pedidos, clientes, bandeja,
recuentos, seguimientos, entregas y avisos. Cada pantalla añade su detalle con su propia
llamada (`/api/admin/conversations/:id/messages`, `/api/admin/orders/:id`,
`/api/admin/catalog`, `/api/admin/inventory`, `/api/admin/pos/quotes`, `/api/admin/pickups`,
`/api/admin/store/requests`, `/api/admin/suppliers`, `/api/admin/delivery-tracking`,
`/api/admin/delivery-cash`, `/api/admin/courier-applications`, `/api/admin/ops/*`,
`/api/admin/reports/sales`, `/api/admin/metrics`, `/api/admin/users`, `/api/admin/settings`,
`/api/admin/audit`).

## Acciones reales (no solo lectura)

- **Pedido**: confirmar, finalizar (entregado), cambiar estado manual, asignar
  reparto, registrar cobro (efectivo/transferencia) y abrir el recibo en PDF.
- **Punto de venta**: cliente (buscar o crear) + artículos del catálogo + cobro →
  pedido, factura o cotización (`POST /api/admin/pos/checkout` / `pos/quotes`).
- **Cotizaciones**: ver el PDF y enviarla al cliente por la plantilla oficial de
  WhatsApp (`POST /api/admin/pos/quotes/:id/send-whatsapp`).
- **Repartidores**: aprobar / rechazar / pedir información del expediente y
  revisar documento a documento, con descarga autenticada del archivo.
- **Mapa con calles** (OpenStreetMap + `flutter_map`): repartos en vivo y pedidos
  de reparto como marcadores, encuadre automático y salto al mapa del sistema.
- **Sin conexión**: el panel abre con la última copia guardada, avisa y guarda en
  una **cola** los mensajes de chat y el abrir/cerrar conversación; al volver la
  red se envían solos (botón «Reintentar» en el aviso). El dinero **nunca** se
  encola: un cobro repetido es peor que un cobro tardío.

Los PDF y los documentos se descargan **con la cookie de sesión** (`pe_crm`) y se
abren con el visor del sistema: no hay enlaces públicos ni `wa.me`.

## Etapa 1 — chat nativo y avisos en vivo

- **Chat completo**: texto, foto, PDF, nota de voz, vista previa del adjunto y del PDF,
  ubicación del negocio, plantillas aprobadas (pide los datos de los huecos `{{1}}`…),
  asignación (pedir / ponerse al frente / soltar / asignar a otro), cerrar y reabrir.
  La multimedia va por bytes crudos a `POST /api/admin/conversations/:id/media` con la
  clave de operación, así un reintento no duplica el archivo.
- **Tiempo real**: un solo SSE por sesión (`GET /api/admin/events`) con cursor (`?since=`),
  espera creciente, `resync` cuando el búfer se queda corto y pausa al pasar a segundo
  plano (vuelve a conectar al reanudar).
- **UAT contra backend aislado**: `tool/uat_etapa0.mjs` (dinero e idempotencia),
  `tool/uat_etapa1.mjs` (chat) y `tool/uat_realtime.mjs` (canal en vivo).
- **Push**: sólo la propuesta escrita, sin configurar nada — ver
  [`docs/PUSH-NOTIFICACIONES.md`](docs/PUSH-NOTIFICACIONES.md).

## Etapa 2 — dinero, custodia, cierre y pendientes operativos

Detalle completo en [`docs/ETAPA-2-DINERO.md`](docs/ETAPA-2-DINERO.md) (matriz
action → endpoint → PWA → app nativa).

- **Cobros**: parciales, efectivo/transferencia, `expectedDue` (saldo que vio la
  persona) e idempotencia por clave. Verificar o rechazar un cobro declarado es
  solo de administración.
- **Rendiciones**: por pedido (`/payments/handover`) y por cuenta de repartidor
  (`/delivery-cash/remittance`, en centavos). El efectivo del reparto **nunca** se
  cuenta como dinero de caja.
- **Custodia**: resumen, libro de movimientos, conciliación e incidencias y
  registro de revisiones (que no mueve dinero).
- **Pedidos**: editar líneas/descuento/envío/notas, cancelar (con motivo) o borrar,
  reparto interno y externo, incidencias con su resolución, factura por WhatsApp e
  historial de estados.
- **Cierre del día** con las mismas fuentes que la PWA (ventas, cobrado, por cobrar
  y efectivo en custodia). El cierre formal con bloqueo sigue siendo de la PWA
  porque el servidor no expone un endpoint para él.
- **Notas de voz grabadas en la app** (`record` + reproducción), con permiso de
  micrófono pedido en el momento y mensaje claro si se deniega.
- **Paginación real de pedidos** con `GET /api/admin/orders?limit=&cursor=`
  (extensión aditiva del backend): el aviso de datos parciales desaparece solo
  cuando se han cargado todas las páginas.
- UAT: `tool/uat_etapa2.mjs` (35 comprobaciones de dinero, custodia, cierre y
  paginación contra el backend aislado).

## Permisos y red (Android)

`android/app/src/main/AndroidManifest.xml` declara `INTERNET` y usa
`res/xml/network_security_config.xml`: HTTPS siempre, texto plano **solo** en
`10.0.2.2`, `127.0.0.1` y `localhost` (servidor de UAT en el emulador).
iOS usa el mismo `API_BASE_URL` por `--dart-define`.

## Pendiente

- Push de notificaciones (FCM/APNs): propuesta en `docs/PUSH-NOTIFICACIONES.md`, sin
  credenciales ni proyecto creado.
- Cierre formal del día con bloqueo: no hay endpoint; se completa en la PWA.
- Verificación de transferencia declarada por el repartidor (`/payment/transfer`):
  pertenece al flujo del repartidor y hoy se hace en la PWA.
- Edición de direcciones del pedido desde la app (hoy se editan líneas, descuento,
  envío y notas).
