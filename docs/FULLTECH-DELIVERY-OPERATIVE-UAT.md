# FULLTECH DELIVERY — UAT OPERATIVO

Fecha: 24-10-2026. Ámbito: worktrees UAT. **Sin producción, sin push, sin merge, sin deploy.**

Este documento es el registro de la fase de cierre operativo: qué quedó
terminado, qué se probó de verdad y qué sigue sin evidencia. Complementa a
`FULLTECH-LOGISTICA-MULTIEMPRESA-UAT.md` (histórico de fases) y a
`FULLTECH-DELIVERY-RELEASE-READINESS.md` (preparación de release y GO/NO-GO).

---

## 1. Estado inicial

- CRM UAT: rama `integracion/smart-commerce-delivery`, HEAD `d30b2ac`, todo el
  trabajo de las fases anteriores **sin commitear**.
- Flutter UAT: **detached HEAD** `0c83e70`, con los cambios de multiempresa.
- No se ejecutó `reset`, `clean` ni `checkout`; se continuó desde el último
  cambio real.

## 2. Matriz inicial pedida

| FUNCIONALIDAD | BACKEND | CRM UI | FLUTTER UI | PRUEBAS | ESTADO |
| --- | --- | --- | --- | --- | --- |
| Registro de empresas | Sí | Parcial (solo API) | — | Sí | Listo (técnico) |
| Concesiones repartidor–empresa | Sí | **Sí (nuevo panel)** | Sí (selector) | Sí | Listo |
| Alcance administrativo por empresa | Sí | Parcial (API; falta UI de usuarios) | — | Sí | Listo (backend) |
| Solicitudes de ingreso | Sí | **Sí (nuevo panel)** | Sí (formulario) | Sí | Listo |
| Consulta de estado de la solicitud | Sí (con recibo) | — | **No** | Sí (backend) | Parcial |
| Documentos del repartidor | No | No | No | No | **Pendiente** |
| Custodia por empresa | Sí | Sí (`custody.html`) | Sí (saldo propio) | Sí | Listo (técnico) |
| Conciliación de ambiguos | Sí (bloqueo + lectura) | Solo lectura | — | Sí | **Parcial** |
| Mapa de reparto | Sí (SSE + posiciones) | Sí (`#view-mapa`) | Envía GPS | Sí (backend) | Parcial (sin UAT Android) |
| Pagos 4 modos | Sí | Sí | Sí | Sí (backend) | Parcial (sin UAT Android) |
| Cuarentena CRM | Sí | Sí (listas/ID) | — | Sí | Listo |
| Canales en vivo | Sí | — | — | Sí | Listo |

## 3. Cambios de esta fase

1. **Panel de Repartidores en el CRM** (`/admin/couriers.html` + `couriers.js`),
   integrado en el menú «Entregas» junto a Custodia:
   - Tarjetas compactas: pendientes, requiere información, aprobadas, con acceso
     a la app, multiempresa.
   - Tabla de solicitudes con buscador, filtro por estado y por empresa; teléfono
     **parcialmente oculto**.
   - Panel lateral de detalle con los datos reales (vehículo, zona, condiciones,
     fecha, nota de revisión) y acciones **Pedir información / Aprobar / Rechazar**;
     aprobar informa explícitamente de que **no** concede acceso.
   - Tabla de repartidores con acceso y sus empresas concedidas; el botón
     «Empresas» abre el detalle con conceder/revocar por empresa.
   - Responsive: en móvil se ocultan columnas secundarias y el panel lateral
     ocupa el ancho completo. No hay scroll horizontal.
2. **Nueva lectura de concesiones**: `GET /api/admin/couriers/:id/companies`
   (con fecha y responsable), sujeta al mismo alcance por empresa. Sin ella el
   panel solo podría adivinar el estado.
3. **Auditoría completa**: las acciones de concesión y de revisión de solicitud
   ya se escriben (antes se descartaban en silencio por no estar en la lista
   blanca).

## 4. Interfaces terminadas

- `/admin/couriers.html`: solicitudes + repartidores con acceso + concesiones.
- Enlace en el menú lateral (permiso `delivery.manage`) sin crear una segunda
  navegación paralela.
- Reutiliza el lenguaje visual de `custody.html` (misma paleta, tipografía y
  densidad) para no introducir otro estilo en el mismo producto.

## 5. Flujos probados (automatizado)

| Flujo | Resultado |
| --- | --- |
| Solicitud pública con vehículo, zona y condiciones | 202; sin token, sin PIN, sin cuenta |
| Alta sin vehículo / sin zona / sin condiciones | 422 con motivo (`invalid_vehicle_type`, `invalid_zone`, `terms_required`) |
| Consulta de estado con recibo | 200 con estado; 404 sin recibo o con recibo ajeno |
| Repetir solicitud viva | mismo `applicationId` y mismo recibo (no duplica) |
| Pedir información sin motivo | 422; con motivo deja `info_required` y sin acceso |
| Aprobar | 200, `operational_access: false`, no crea cuenta |
| Rechazar y volver a postularse | fila nueva, no reabre la rechazada |
| Concesiones por repartidor | lectura real; conceder/revocar; alcance respetado |
| Operador sin `admin.full` | 403 al administrar solicitudes y al leer concesiones ajenas |
| Página y script servidos desde `/admin` | 200 con contenido correcto |

## 6. Registro de repartidores

Estados en uso (los ya definidos, sin duplicar): `pending`, `info_required`,
`approved`, `rejected`. El estado operativo vive en la cuenta
(`active`, `app_access`), no en la solicitud.

Falta para completar el expediente: **documentos** (identidad, licencia, vehículo)
con almacenamiento privado, validación de tipo real y descarga autenticada; y la
**pantalla de consulta de estado en la app**. Ambos quedan fuera de esta fase y
documentados como bloqueo.

## 7. Autorizaciones empresariales

- El backend es la única fuente de verdad: la app no envía permisos.
- Conceder o revocar sube `token_epoch` de la cuenta, así que la sesión anterior
  deja de servir.
- Revocación con entrega activa: no se reasigna nada en silencio (pendiente de
  política operativa explícita y de prueba en dispositivo).

## 8–13. Custodia, conciliación, GPS, mapa, pagos, Android

Sin cambios en esta fase respecto a lo ya documentado. Siguen vigentes:
custodia y rendiciones por empresa probadas (incluida concurrencia en
PostgreSQL), conciliación de solo lectura con bloqueo de rendiciones ambiguas,
mapa alimentado por posiciones reales con SSE filtrado por empresa, y los cuatro
métodos de pago implementados en app y backend.

**No hay evidencia nueva de Android en esta fase**: no se repitió el ensayo en
emulador ni existe teléfono físico. La APK UAT recompilada en la fase anterior
sigue siendo válida para el código Flutter (que no cambió en esta fase).

## 14. PostgreSQL

`node scripts/check-logistics-postgres-uat.mjs` → **8/8** (registro aditivo,
solicitud sin alta, cuarentena de ficha y chat, reparto multiempresa, rendición
concurrente e idempotente, bloqueo contable con rollback, restauración del
respaldo). Log: `fulltech-postgres-panel.log`.

## 15. Pruebas ejecutadas y fallas

| Prueba | Resultado |
| --- | --- |
| Suite general | **100 fallas / 2428 aprobadas / 3 omitidas** (2531 pruebas, 185 archivos) |
| Nuevas respecto a la corrida anterior | **0** |
| Frente a la baseline `d30b2ac` (104 fallas) | 99 coinciden; 1 conocida (`panel-sales-uat > desde el pedido se pasa a un delivery de verdad`) |
| Bloque dirigido (panel, alcance, registro, acceso, canales, cuarentena, chat SSE) | 47/47 |
| Pruebas nuevas del panel | 4/4 |
| Flutter (fase anterior, sin cambios Flutter ahora) | `analyze` limpio, 89/89 |

## 16. Riesgos y pendientes

1. **Documentos del repartidor**: sin implementar (bloqueo del expediente completo).
2. **UI del panel para repartir empresas a usuarios del CRM**: el backend existe y
   está probado, pero la pantalla de usuarios aún no lo expone.
3. **Conciliación**: no hay pantalla de resolución con justificación; el bloqueo
   funciona y las filas ambiguas se listan en modo lectura.
4. **UAT Android**: sin ensayo humano (login, GPS en segundo plano, pago, rendición).
5. **Catálogo histórico** sin `store` sigue interpretándose como FULLTECH.

## 17–19. Despliegue, rollback y veredicto

El procedimiento (variables requeridas, respaldo verificado, migraciones
aditivas, health check, rollback por versión anterior de Swarm y restauración en
base aparte) está en `FULLTECH-DELIVERY-RELEASE-READINESS.md`. **No se ejecutó
nada de eso.**

**Veredicto: NO-GO** para producción. Se avanzó en lo administrativo (el panel
de repartidores y las concesiones ya se pueden operar sin API a mano) y no hay
fallas nuevas, pero faltan el expediente documental, la conciliación resoluble y
la prueba operativa en Android. Ninguna de las tres se puede sustituir con
documentación.

### Siguiente comando seguro

```powershell
cd C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato
npx vitest run tests/couriers-panel.test.js
node scripts/check-logistics-postgres-uat.mjs
```

---

## Cierre de la sesión: documentos, estado de la app y alcance por usuario

### Documentos del expediente (backend + panel)

`server/courier-documents.mjs` (nuevo) y tres rutas nuevas:

| Ruta | Quién | Qué hace |
| --- | --- | --- |
| `POST /api/courier/applications/:id/documents` | solicitante con **recibo** | sube un documento (base64), valida bytes reales y tamaño |
| `GET /api/courier/applications/:id/documents?receipt=` | solicitante con recibo | lista lo enviado, lo que falta y el estado |
| `GET /api/admin/courier-applications/:id/documents` | central | expediente completo + faltantes |
| `GET /api/admin/courier-documents/:id/file` | central | descarga autenticada (`no-store`, `nosniff`) |
| `POST /api/admin/courier-documents/:id/review` | central | aceptar / pedir otro / rechazar (con motivo) |

Seguridad aplicada y probada: sin recibo no se sube ni se lista (404); se valida
la **cabecera real** del archivo (JPEG/PNG/PDF) y se rechaza un ejecutable
disfrazado (422); límite de 4 MB por archivo y cuerpo acotado a 6 MB; el binario
vive en un directorio privado con nombre generado y la ruta de disco nunca sale
al cliente; un reemplazo archiva el anterior en vez de dejar dos vigentes; los
documentos obligatorios dependen del vehículo (bicicleta/a pie solo identidad).

### Estado de la solicitud en la app (Flutter)

- `CrmCourierClient.applicationStatus()` consulta con el recibo.
- `ApplicationReceiptStore` guarda el acuse en el **almacén seguro** del sistema
  (no en la caché de entregas), separado del de sesión.
- Botón «Consultar mi solicitud» en el acceso: muestra Pendiente / Requiere
  información / Aprobada / Rechazada, la nota del equipo y recuerda que el acceso
  operativo necesita aprobación **y** autorización de empresa.

### Alcance por usuario en el panel

Nueva sección «Usuarios del CRM y empresas que pueden operar» (solo
superadministración) con lectura `GET /api/admin/users/:id/companies` y
conceder/revocar por empresa. El backend ya lo exigía; ahora se puede administrar
sin llamar a la API a mano.

### Evidencia de esta sesión

| Prueba | Resultado |
| --- | --- |
| `courier-documents` (nuevas) | 6/6 |
| `couriers-panel` + `crm-company-scope` + `courier-documents` | 15/15 |
| Suite general | **100 fallas / 2434 aprobadas / 3 omitidas** (2537 pruebas, 186 archivos) |
| Fallas nuevas frente a la corrida anterior | **0** |
| PostgreSQL UAT | 8/8 (sin cambios de esquema financiero) |
| Flutter | `analyze` limpio · **93/93** pruebas (4 nuevas de estado/acuse) |
| APK UAT | recompilada 24-10-2026 21:11 · 170,6 MB · SHA-256 `AE1E576B16743D78E9B812960612FA0EA30AC254296CA9527BA7883AEA404417` |

### Estado final por componente

| Componente | Implementado | Probado | Bloqueo restante | Estado |
| --- | --- | --- | --- | --- |
| Registro de repartidores | Sí (app + backend + panel) | Automatizado + PostgreSQL | — | Listo |
| Documentos del repartidor | Backend + panel completos | 6/6 automatizado | **Subida desde la app** (requiere selector de archivos y prueba en dispositivo) | Parcial |
| Aprobaciones CRM | Sí (`/admin/couriers.html`) | 4/4 + dirigidas | — | Listo |
| Permisos por empresa | Sí (repartidor y usuario) | 5/5 + PostgreSQL | — | Listo |
| Pedidos asignados | Sí | Automatizado | Ensayo humano | Listo (técnico) |
| GPS | App + backend | Automatizado | Sin prueba en dispositivo | Parcial |
| Mapa en vivo | Sí (SSE filtrado) | Automatizado | Sin prueba visual con dos repartidores | Parcial |
| Pagos (4 modos) | Sí | Automatizado | Ensayo humano | Listo (técnico) |
| Custodia | Sí | Concurrencia + idempotencia | — | Listo (técnico) |
| Conciliación | Bloqueo + lectura | Automatizado | Sin pantalla de resolución justificada | Parcial |
| APK | Sí (debug, UAT) | Compilada; emulador en fase anterior | Sin teléfono físico | Parcial |
| Release readiness | Documentada | — | Depende de lo anterior | NO-GO |

### Checklist manual pendiente en Android (no ejecutada)

1. Instalar la APK: `adb install -r build/app/outputs/flutter-apk/app-debug.apk`.
2. Solicitar ingreso con vehículo, zona y condiciones; guardar el recibo.
3. «Consultar mi solicitud» → Pendiente.
4. En el CRM: pedir información → la app debe mostrar «Requiere información» y la nota.
5. Aprobar; crear cuenta con PIN y conceder PHYTOEMAGRY.
6. Login en la app, seleccionar empresa, ver pedidos.
7. Iniciar entrega con GPS; comprobar posición y antigüedad en el mapa del CRM.
8. Minimizar, bloquear pantalla y abrir Google Maps; verificar que las posiciones siguen llegando o que el estado se marca como obsoleto.
9. Cortar datos, finalizar entrega, reconectar y reintentar: sin duplicados.
10. Cobrar efectivo → custodia; repetir con mixto en FULLTECH (transferencia pendiente).
11. Revocar FULLTECH desde el panel: los pedidos FULLTECH deben dejar de verse y PHYTOEMAGRY seguir funcionando.
12. Registrar incidencia y cerrar sesión.

Ninguno de estos pasos se ha ejecutado: no hay dispositivo ni se repitió el ensayo en emulador en esta sesión.

---

## Sprint final: documentos desde la app, GPS real y conciliación (24-10-2026)

### 1. Subida de documentos desde Android

- `file_picker` (mantenido) + pantalla `ApplicationDocumentsScreen`: muestra lo
  que falta, permite **subir y reemplazar** cada documento con el recibo de la
  solicitud, y pinta el resultado de la revisión (recibido / aceptado / debes
  enviar otra copia / rechazado) con la nota del administrador.
- Filtro local antes de gastar red (4 MB y cabecera JPG/PNG/PDF) y el mismo
  filtro en el servidor, que sigue siendo la autoridad.
- No se piden permisos de almacenamiento ni de cámara: el selector del sistema
  decide. No hay enlaces públicos ni caché compartida de documentos.
- Progreso: barra indeterminada durante el POST (el endpoint es un único JSON;
  no se inventa un porcentaje). Ante fallo de red se puede reintentar.

### 2. Conciliación financiera

- Backend: `GET/POST /api/admin/delivery-cash/resolutions` (solo central). La
  resolución es un **registro aparte y auditado** (`cash_resolutions`), con
  justificación obligatoria, evidencia y empresa *propuesta*. **No toca el libro,
  no cambia importes y no desbloquea rendiciones**: el bloqueo sigue hasta una
  autorización explícita (decisión que no me corresponde ejecutar).
- Id determinista `res:<movimiento>`: dos administradores no pueden registrar dos
  conclusiones distintas del mismo movimiento (409 `already_resolved`).
- Panel de custodia: sección «Movimientos por revisar» con repartidor, pedido,
  tipo, importe y acción «Revisar», más «Resoluciones registradas» con quién, qué
  justificó y su estado *pendiente de autorización*.
- 5 pruebas nuevas: bloqueo vigente, resolución auditada sin mover dinero,
  justificación obligatoria, segunda resolución rechazada, permisos.

### 3. GPS: lo que había y lo que faltaba

**Hallazgo importante:** la app **no tenía geolocalización** (ni plugin, ni
permisos, ni envío). El «GPS» existía solo en el backend. En esta sesión:

- `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` en el manifiesto; el permiso
  se pide **en tiempo de ejecución**, al empezar una entrega, no al abrir la app.
- `LocationTracker` con filtros reales: descarta lecturas de más de 2 minutos,
  precisión peor de 200 m, y no repite el mismo punto (25 m / 15 s).
- Se arranca al quedar la entrega activa y se corta al cerrarla/rechazarla o al
  cerrar sesión (`AppServices.stopTracking`). Con la entrega cerrada no se envía
  nada.
- `CrmCourierClient.sendLocation` contra el endpoint existente; `409
  no_active_delivery` se trata como «no enviado» y se reintenta en el próximo pulso.
- **No hay servicio en primer plano**: con la app cerrada no se rastrea. Eso es
  una limitación declarada, no una promesa. Requiere validación en dispositivo.

### 4. Evidencia

| Prueba | Resultado |
| --- | --- |
| Flutter `analyze` | limpio |
| Flutter `test` | **105/105** (subida de documentos y rastreo incluidos) |
| Suite general backend | **100 fallas / 2439 aprobadas / 3 omitidas** (2542 pruebas, 187 archivos) |
| Fallas nuevas vs corrida anterior | **0** |
| PostgreSQL 17 UAT | **8/8** |
| APK UAT | 171,9 MB · 24-10-2026 21:32 · SHA-256 `40374225A834A7720FC5AAAAD3FCCC372B1F582FA970E657530E23145B68806B` |

### 5. Estado final

| Componente | Implementado | Probado | Bloqueo restante | Estado |
| --- | --- | --- | --- | --- |
| Registro de repartidores | Sí | Automatizado + PostgreSQL | — | Listo |
| Documentos (CRM) | Sí | 6/6 | — | Listo |
| Documentos (subida desde la app) | Sí | 6 pruebas Flutter (sin dispositivo) | Ensayo en teléfono | Parcial |
| Aprobaciones CRM | Sí | Automatizado | — | Listo |
| Permisos por empresa | Sí (repartidor y usuario) | 5/5 + PostgreSQL | — | Listo |
| Pedidos asignados | Sí | Automatizado | Ensayo humano | Listo (técnico) |
| GPS | Sí (app + backend) | 7 pruebas de rastreo y envío | **Sin prueba en dispositivo**; sin servicio en segundo plano | Parcial |
| Mapa en vivo | Sí | Automatizado | Prueba visual con dos repartidores | Parcial |
| Pagos (4 modos) | Sí | Automatizado | Ensayo humano | Listo (técnico) |
| Custodia | Sí | Concurrencia + idempotencia | — | Listo (técnico) |
| Conciliación | Sí (revisión + resolución auditada) | 5/5 | Autorización explícita para cambiar titularidad (no solicitada) | Listo (técnico) |
| APK | Sí (debug UAT) | Compilada | Sin teléfono físico | Parcial |
| Release readiness | Documentada | — | Depende de lo anterior | **NO-GO** |

### 6. Checklist manual actualizado (no ejecutado)

Los 12 pasos anteriores más:

13. En «Mis documentos», subir una foto y un PDF; comprobar que el panel los
    muestra y que un `.exe` renombrado se rechaza.
14. Pedir otra copia desde el CRM y verificar que la app lo indica y permite reemplazar.
15. Iniciar entrega con GPS activo, minimizar, bloquear pantalla y abrir Google
    Maps; comprobar en el mapa del CRM la última posición y su antigüedad.
16. Apagar el GPS o revocar el permiso: la app debe dejar de enviar sin inventar
    posiciones y el CRM debe marcar la ubicación como obsoleta.
17. Cerrar sesión con una entrega activa: el seguimiento debe cortarse.

---

## GPS en segundo plano con servicio en primer plano (24-10-2026)

### Qué se implementó

- `flutter_foreground_task` (mantenido) con **tipo de servicio `location`**
  (obligatorio en Android 14) y notificación **visible y permanente**:
  «Entrega en curso — Compartiendo tu ubicación mientras dura la entrega».
- `PlatformForegroundTracking` (`lib/core/tracking/foreground_tracking.dart`):
  inicializa canal/bajo consumo, arranca el servicio y lo para; si el sistema no
  lo permite, **devuelve `false` y no finge** que está corriendo.
- `AppServices.startTracking(orderId)` arranca servicio + lecturas; `stopTracking()`
  para ambos y se invoca al cerrar la entrega, al rechazarla y al cerrar sesión.
- Los filtros de posición siguen igual: descarta lecturas de más de 2 minutos,
  precisión peor de 200 m y no repite el mismo punto (25 m / 15 s).
- `allowWakeLock: false`, `autoRunOnBoot: false`, `allowAutoRestart: false`: el
  servicio no resucita solo ni despierta la CPU. Además se **eliminaron** del
  manifiesto fusionado `WAKE_LOCK` y `RECEIVE_BOOT_COMPLETED`, que el plugin
  añadía aunque la app no los usa.

### Permisos reales del APK (manifiesto fusionado verificado)

```
INTERNET · ACCESS_COARSE_LOCATION · ACCESS_FINE_LOCATION
FOREGROUND_SERVICE · FOREGROUND_SERVICE_LOCATION · POST_NOTIFICATIONS
<service android:foregroundServiceType="location" />
```

Nada de `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, cámara ni almacenamiento.

### Límites que NO se superan (y por tanto no se afirman)

- **No hay validación en dispositivo.** El servicio compila y el manifiesto es
  correcto, pero no se ha ejecutado en un teléfono ni en emulador en esta sesión:
  no se declara «GPS en segundo plano funcionando».
- El temporizador de lecturas vive en el isolate principal. El servicio mantiene
  el proceso vivo; si Android decide matarlo por presión de memoria, la lectura
  se detiene. No hay rastreo con la app forzada a cerrar.
- Google Play exige justificar el acceso a ubicación en segundo plano en la ficha
  de la tienda. **Ese trámite no se ha hecho** y debe hacerse antes de publicar.

### APK UAT

| Dato | Valor |
| --- | --- |
| Ruta | `C:\Users\pc\DEV\UAT\FULLTECH-DELIVERY-multitenant\build\app\outputs\flutter-apk\app-debug.apk` |
| Tamaño | 208,7 MB (debug, todas las ABI) |
| Compilada | 24-10-2026 21:42 |
| SHA-256 | `64143B00EEAF0013A4F2DAC073B07C5E0136DE58D68B1245B19522BF699E2BE5` |
| Versión | `1.0.0+1` · `com.fulltech.delivery` |
| Defines | `DELIVERY_ENV=uat`, `DELIVERY_API_BASE_URL=https://10.0.2.2:8443`, `DELIVERY_DEMO_DATA=false` |

**Este APK es para emulador.** `10.0.2.2` no existe en un teléfono físico. Para
un dispositivo real:

```powershell
flutter build apk --debug `
  --dart-define=DELIVERY_ENV=uat `
  --dart-define=DELIVERY_API_BASE_URL=https://<host-o-IP-LAN>:8443 `
  --dart-define=DELIVERY_DEMO_DATA=false
```

y el certificado de la CA UAT debe ser de confianza para ese host (la raíz local
de `assets/uat-ca.pem` solo se carga en debug y para `10.0.2.2:8443`). **No hay
un endpoint UAT público accesible**: sin él, ninguna APK puede conectar desde un
teléfono, y no se simula lo contrario.

### Verificación de esta ronda

| Prueba | Resultado |
| --- | --- |
| Flutter `analyze` | limpio |
| Flutter `test` | **107/107** (2 nuevas del servicio en primer plano) |
| Manifiesto fusionado | permisos y `foregroundServiceType=location` verificados |
| Suite backend | 100 fallas / 2439 aprobadas / 3 omitidas (sin cambios: no se tocó el CRM) |
| PostgreSQL UAT | 8/8 (sin cambios de esquema) |

---

## Entorno UAT para teléfono físico, E2E real y APK LAN (24-10-2026)

### 1. Backend UAT HTTPS en la red local

`scripts/uat-https-lan.mjs` (nuevo):

- Arranca el CRM UAT **aislado** (SQLite temporal, WhatsApp y Meta desactivados) y
  publica un proxy HTTPS en la interfaz indicada (`FULLTECH_UAT_BIND`, por
  defecto `0.0.0.0`) y puerto `FULLTECH_UAT_PORT` (8443).
- Valida el certificado **antes** de arrancar: vigencia y SAN de la IP usada.
  `--check` hace solo esa validación y sale con código distinto si no cubre la LAN.
- No expone PostgreSQL (no hay PostgreSQL), no abre puertos en el router y no
  lee ninguna URL productiva.
- Certificado de prueba generado con SAN `IP:192.168.1.13, IP:127.0.0.1, DNS:localhost`
  y **30 días** de validez, guardado **fuera de los repositorios** en
  `C:\Users\pc\DEV\UAT\fulltech-lan-uat\`.

Comprobación real ejecutada:

```
CERT_SAN IP Address:192.168.1.13, IP Address:127.0.0.1, DNS:localhost
LAN_ADDRESSES Wi-Fi=192.168.1.13
LAN_COVERED_BY_CERT 192.168.1.13
LAN_UAT_URLS https://192.168.1.13:8443
```

y una petición HTTPS **con la CA** devolvió
`200 {"ok":true,"companies":[{"id":"fulltech"...},{"id":"phytoemagry"...}]}`.

**Bloqueo externo a tener en cuenta:** el Firewall de Windows debe permitir la
entrada al puerto 8443 desde la LAN (requiere permisos de administrador; **no se
ha modificado**). El teléfono debe estar en la misma Wi-Fi y confiar en la CA.

### 2. APK para teléfono físico

- `lib/main.dart`: la raíz TLS de UAT se elige por host. Emulador → `assets/uat-ca.pem`;
  host de la LAN listado en `--dart-define=DELIVERY_UAT_LAN_HOSTS` → `assets/uat-ca-lan.pem`;
  cualquier otro caso → **ninguna** raíz local (release nunca las carga).
- APK compilada para la LAN:

| Dato | Valor |
| --- | --- |
| Ruta | `C:\Users\pc\DEV\UAT\fulltech-lan-uat\fulltech-delivery-uat-lan.apk` |
| Tamaño | 208,7 MB |
| SHA-256 | `5CAB20386299CBA3CDA1E9486848F82C6DD4BAFAFF3FE18ED1E5F2EE73867E08` |
| URL | `https://192.168.1.13:8443` (define de compilación; no hay secretos dentro) |
| Versión / id | `1.0.0+1` · `com.fulltech.delivery` · firma de **debug** |

### 3. Defecto real encontrado y corregido (GPS)

`POST /api/courier/location` llamaba a `listCourierOrders` con
`getCustomer: null`. Al haber cliente, esa lista lanzaba dentro y el `.catch`
la dejaba vacía: **la ruta respondía siempre `409 no_active_delivery`**, así que
el repartidor nunca podía enviar una posición, aunque el GPS y el servicio en
primer plano funcionaran. Se pasa el cargador real de clientes y ahora responde
200 con una entrega en curso.

Lo detectó el escenario E2E nuevo, no una prueba unitaria: es exactamente el tipo
de integración que faltaba verificar.

### 4. Escenario E2E automatizado (sin mocks)

`tests/e2e-multiempresa-uat.test.js` — **5/5** bloques, contra el backend real:

1. Empresas públicas → solicitud con vehículo/zona/condiciones → 3 documentos
   subidos con el recibo → revisión de cada documento → aprobación (sin acceso).
2. Alta de la cuenta de acceso + PIN (acto administrativo separado) → login del
   repartidor con una sola empresa.
3. Pedido creado y asignado → visible en la lista del repartidor.
4. Aceptar → recoger → iniciar → **posición GPS aceptada** → aparece en
   `delivery-courier-positions` del CRM.
5. Llegar → código de entrega → entrega con **efectivo** → custodia
   (`charged_cents` = importe) → rendición → saldo a cero.
6. Concesión de FULLTECH → el mismo repartidor ve ambas empresas, el pedido
   FULLTECH **no** aparece en PHYTOEMAGRY, la custodia de FULLTECH empieza en
   cero → revocación → FULLTECH queda fuera (401/403) y PHYTOEMAGRY sigue en 200.

Lo que **no** cubre: la UI de Flutter, la cámara/selector de archivos, el GPS del
teléfono y el comportamiento en segundo plano. Eso sigue siendo aceptación manual.

### 5. Regresiones de esta ronda

Suite general: **101 fallas / 2443 aprobadas / 3 omitidas** (2547 pruebas, 188
archivos) y 2 errores no controlados. Comparación por nombre con la corrida
anterior: la única falla añadida es
`offline-24h > cobra offline, mantiene el recibo provisional y descuenta stock una sola vez al reconectar`,
que **ya fallaba en la baseline `d30b2ac`** y alterna entre corridas (se
reproduce igual aislada). Los 2 errores no controlados son `panel-plantilla-contacto-uat`
y `panel-centro-ia-chats-uat` (arranque del DOM con jsdom), ajenos a este cambio.
**Ninguna falla se debe a la corrección del GPS.**

### 6. Verificación de esta ronda

| Prueba | Resultado |
| --- | --- |
| E2E multiempresa | 5/5 |
| Suite general | 101 fallas / 2443 aprobadas / 3 omitidas (0 nuevas atribuibles) |
| Flutter `analyze` / `test` | limpio · 107/107 |
| HTTPS LAN + CA | 200 con las dos empresas |
| APK física | compilada, SHA-256 arriba |

### 7. Firma de release y preparación de producción (25-10-2026)

El APK de `release` salía firmado con la clave **debug**. Corregido en
`android/app/build.gradle.kts`: lee `android/key.properties` y usa
`signingConfigs.release`; sin llavero cae a debug **avisando en el log**.

- Llavero: `C:\Users\pc\DEV\UAT\fulltech-release\fulltech-release.jks` (alias `fulltech`),
  fuera de los repositorios y en `.gitignore`. **Respaldar: sin él no hay actualizaciones.**
- `app-release.apk` **52,5 MB**, SHA-256 `E29D58DC…01D175`, firmante
  `CN=FULLTECH Delivery` — confirmado con `apksigner verify --print-certs`.
- CA de laboratorio inertes en release (solo `kDebugMode && uat`).
- `deploy/uat/`: backend UAT en la nube aislado (Postgres sin puerto publicado,
  `APP_ENV=uat`, cookies seguras, healthcheck, `production: "false"`), con verificación y
  rollback documentados. **No se desplegó nada.**

| Prueba | Resultado |
| --- | --- |
| Flutter `analyze` / `test` | limpio · 107/107 |
| Backend dirigido (E2E, alcance, documentos, conciliación, panel) | 25/25 |
| PostgreSQL 17 UAT | 8/8 |
| `docker compose config` del paquete UAT | válido |

Veredicto: **NO-GO** hasta dominio real de producción, autorización de despliegue y
aceptación en teléfono físico.
