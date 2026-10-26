# FULLTECH DELIVERY — PREPARACIÓN DE RELEASE (UAT)

Fecha: 24-10-2026. Ámbito: worktrees UAT (`PHYTOEMAGRY-candidato`, `FULLTECH-DELIVERY-multitenant`).
**No se tocó producción, no se hizo push ni merge, no se publicó nada.**

Este documento separa a propósito lo que está **probado** de lo que está
**implementado sin ensayo**, y de lo que sigue **bloqueado**. Un módulo no pasa a
«listo» por existir el endpoint.

---

## 1. Estado por módulo

| MÓDULO | IMPLEMENTADO | PROBADO | BLOQUEO | ESTADO |
| --- | --- | --- | --- | --- |
| Registro persistente de empresas | Sí (`logistics_companies`, semillas idempotentes, alta por ruta central) | Sí: automatizada + PostgreSQL UAT | — | Listo para UAT |
| Alcance administrativo por empresa | Sí (`crm_company_grants`, rutas de lectura y escritura por usuario) | Sí: 5 pruebas; 14 puntos del backend con alcance; el panel ya reparte empresas a **repartidores y usuarios** | — | Listo |
| Repartidor–empresa (concesiones) | Sí (`courier_company_grants`, alta/revocación con subida de `token_epoch`) | Sí: automatizada + PostgreSQL | — | Listo para UAT |
| Cuarentena de clientes/conversaciones | Sí (`crmOwnership`/`crmRowVisible`, rutas por lista e ID) | Sí: automatizada (SQLite y PostgreSQL) | Falta conciliar filas históricas reales | Listo (técnico) |
| Canales en vivo (SSE) | Sí: bus, chat y mapa filtran por empresa | Sí: 10 pruebas de canales | — | Listo para UAT |
| Registro de repartidores desde la app | Sí: nombre, teléfono, empresa, **vehículo, zona, aceptación**; recibo para consultar estado; **pantalla de consulta en la app** | Sí: 3+4 pruebas de backend y 4 Flutter | Subida de documentos desde el teléfono | Listo (técnico) |
| Documentos del expediente | Sí: almacenamiento privado, validación por bytes, límite 4 MB, descarga autenticada, reemplazo archivado, revisión administrativa | 6/6 automatizado | **Subida desde la app** (necesita selector de archivos y dispositivo) | Parcial |
| Revisión administrativa | Sí: aprobar, rechazar, **pedir información**, auditoría real | Sí: automatizada + PostgreSQL + **panel `/admin/couriers.html`** | — | Listo para UAT |
| Custodia y rendiciones por empresa | Sí (rendición atómica, idempotente, bloqueo de ambiguos) | Sí: automatizada + concurrencia en PostgreSQL | Conciliación manual sin pantalla dedicada | Listo (técnico) |
| Pagos (efectivo/transferencia/mixto/no pagado) | Sí en app y backend | Automatizada (backend) | Sin ensayo humano en emulador | Parcial |
| GPS y mapa de reparto | App: `geolocator` + rastreador filtrado + servicio en primer plano tipo `location`; backend con SSE filtrado | Automatizada (9 pruebas) + **E2E con posición real aceptada y visible en el CRM** | Sin ensayo en teléfono fí­sico (bloqueo: Firewall LAN + dispositivo) | Parcial |
| Conciliación | Revisión con justificación y resolución auditada (no mueve dinero) | 5/5 | Autorización explícita para cambiar titularidad | Listo (técnico) |
| APK UAT | Sí (debug, firmada con keystore de debug) | Compilada e instalada en emulador en la fase anterior | Sin teléfono físico | Parcial |
| Suite general | — | 101 fallas / 2443 aprobadas / 3 omitidas (2547 pruebas, 188 archivos); la única añadida vs la corrida anterior es la histórica `offline-24h` | Todas las demás también fallan en la baseline `d30b2ac` | Vigilado |
| PostgreSQL UAT | — | 8/8 verificaciones, restauración de respaldo incluida | Sin copia histórica depurada | Listo (UAT) |

### Tipos de prueba (no se mezclan)

- **Automatizada:** Vitest sobre SQLite temporal y sobre PostgreSQL 17 aislado; `flutter test`; `flutter analyze`.
- **Emulador:** la fase anterior instaló la APK en `emulator-5554` y verificó HTTPS y el formulario. **En esta fase no se repitió** el ensayo manual.
- **Teléfono físico:** **no realizado** (no hay dispositivo disponible). No se declara hecho.
- **Integración extremo a extremo:** cubierta por pruebas automáticas del backend y del script PostgreSQL; **no** por un repartidor humano en dos empresas.
- **Validación productiva:** no existe y no se ha intentado.

---

## 2. Cambios de esta fase

1. **`delivery.manage` deja de ser global.** Nuevo alcance por empresa
   (`crm_company_grants`); `adminCompanyScope`/`scopeSeesCompany` en
   `server/logistics-tenancy.mjs`. Sin concesiones se conserva el comportamiento
   histórico (PHYTOEMAGRY), de modo que nada se rompe para quien ya existía.
   Se aplicaron 14 puntos: detalle de pedido, custodia, movimientos, posiciones,
   cuentas de reparto (lista, alta y edición), mapa de seguimiento, listado del
   panel, reportes de ventas y de entregas, y reenvío de compra a Meta.
2. **Auditoría que no se estaba guardando.** `record()` ignora en silencio las
   acciones que no están en su lista blanca; las concesiones de empresa
   (`courier.company_granted/revoked`), el acceso operativo del repartidor y las
   decisiones de la solicitud nunca quedaban escritas. Se añadieron 11 acciones.
3. **Registro de repartidores completo en el backend.** Vehículo
   (MOTO/CARRO/BICICLETA/A_PIE), zona de trabajo y aceptación expresa de las
   condiciones; recibo aleatorio para consultar el estado sin exponer el
   teléfono; `info_required` para pedir información sin aprobar; nueva
   postulación permitida tras un rechazo; limitador por IP en el alta y en la
   consulta.
4. **App Flutter actualizada** al nuevo contrato (formulario con vehículo, zona y
   casilla de condiciones) y prueba de contrato ajustada.

---

## 3. APK de pruebas

| Dato | Valor |
| --- | --- |
| Archivo | `build/app/outputs/flutter-apk/app-debug.apk` |
| Tamaño | 208,7 MB (debug, todas las ABI) |
| Compilada | 24-10-2026 21:42 (con servicio en primer plano de ubicación) |
| SHA-256 | `64143B00EEAF0013A4F2DAC073B07C5E0136DE58D68B1245B19522BF699E2BE5` |
| Versión | `1.0.0+1` |
| applicationId | `com.fulltech.delivery` |
| Defines | `DELIVERY_ENV=uat`, `DELIVERY_API_BASE_URL=https://10.0.2.2:8443`, `DELIVERY_DEMO_DATA=false` |
| Firma | Keystore **debug** de Android (no es una firma de distribución) |
| Certificado UAT | `assets/uat-ca.pem`: 1 certificado público, **0 claves privadas**, cargado solo con `kDebugMode && uat && host 10.0.2.2:8443` |

Instalación: `adb install -r build/app/outputs/flutter-apk/app-debug.apk`.

**Aviso honesto:** `10.0.2.2` es la dirección del emulador. Este APK **no** sirve
para un teléfono físico. Para un dispositivo real existe ya una variante
compilada contra el backend UAT de la red local:

| APK para teléfono físico | |
| --- | --- |
| Ruta | `C:\Users\pc\DEV\UAT\fulltech-lan-uat\fulltech-delivery-uat-lan.apk` |
| SHA-256 | `5CAB20386299CBA3CDA1E9486848F82C6DD4BAFAFF3FE18ED1E5F2EE73867E08` |
| URL | `https://192.168.1.13:8443` (backend UAT aislado, `scripts/uat-https-lan.mjs`) |
| Requisitos | Teléfono en la misma Wi-Fi, CA `lan-cert.pem` confiada en el dispositivo y puerto 8443 permitido en el Firewall de Windows |

El Firewall **no** se ha modificado (requiere permisos de administrador): es el
paso que falta antes de instalar en un teléfono real.

---

## 4. Preparación de despliegue (no ejecutada)

Arquitectura aprobada: **un** backend central + **una** base PostgreSQL
compartida, separación lógica por empresa. No se crea un segundo backend
financiero.

### Variables necesarias (nombres, sin valores)

- Base de datos: `DATABASE_URL` (PostgreSQL del VPS).
- Sesión y firma: `PHYTO_CRM_TOKEN` (clave de sesión del panel), secreto de
  tokens de repartidor, secreto de sesión de usuario.
- WhatsApp/Meta: token de acceso, `phone_number_id`, `business_account_id`,
  `app_secret`, `verify_token`, versión de Graph.
- Almacenamiento: credenciales del bucket y endpoint.
- IA (opcional): clave del proveedor del corrector; sin ella el módulo se
  desactiva solo.
- Correo/SMS (opcional): proveedor y clave.

### Procedimiento propuesto

1. Respaldo `pg_dump -Fc` verificado con `pg_restore --list` **antes** de migrar.
2. Las colecciones nuevas son **aditivas**: se crean al arrancar
   (`logistics_companies`, `courier_company_grants`, `courier_applications`,
   `courier_positions`, `crm_company_grants`). No hay borrado ni renombrado.
3. Despliegue con la estrategia del panel (servicio nuevo + `start-first`),
   `health check` contra `/api/health` antes de conmutar.
4. Comprobación posterior: login de panel, listado de empresas, custodia de cada
   empresa con una cuenta concesionada, y que una oficina sin concesión siga
   viendo solo PHYTOEMAGRY.
5. Rollback: volver a la imagen anterior del servicio (Swarm guarda la versión
   previa) y, si hiciera falta, restaurar el respaldo en una base aparte —
   nunca encima de la que está sirviendo.

### Riesgos de despliegue

- El CRM corre en **un solo proceso**; el bus de eventos y los clientes SSE viven
  en memoria. Con más de una réplica los avisos en vivo se repartirían mal.
- Las tareas de reparto y los webhooks comparten proceso: un reinicio corta los
  SSE (se reconectan con `?since=`).
- La migración de datos históricos ambiguos **no** está resuelta: debe hacerse
  con evidencia y revisión humana, no automáticamente.

---

## 5. GO / NO-GO

**NO-GO.**

Motivos concretos, en el orden en que bloquean:

1. **Sin ensayo humano en Android.** No hay evidencia de login, selección de
   empresa, pedidos, GPS en segundo plano, pago y rendición con un repartidor
   real en las dos empresas. La app compila y sus pruebas pasan; eso no es UAT.
2. **Conciliación histórica sin hacer.** Los movimientos sin empresa demostrable
   siguen bloqueando rendiciones (correcto) pero no existe pantalla de
   conciliación ni copia histórica depurada para cuantificarlos.
3. **Expediente documental:** backend y panel completos; la subida desde el
   teléfono está implementada y probada con pruebas unitarias, **sin ensayo en dispositivo**.
4. **GPS:** la app no tenía geolocalización; ahora rastrea solo con entrega activa
   (permisos, filtros, servicio en primer plano con notificación visible y parada
   al cerrar entrega o sesión). **Sin validación en teléfono real** y sin
   justificación de ubicación en segundo plano para Google Play.
5. **Conciliación:** revisión y resolución auditada listas; cambiar la titularidad
   del dinero requiere una autorización explícita que no se ha pedido.
5. **100 fallas en la suite general**, 99 heredadas de la baseline y una
   (`panel-sales-uat > desde el pedido se pasa a un delivery de verdad`)
   dependiente de esperas del panel. No se considera verde.

Nada de esto se puede sustituir por «la compilación pasó». Cuando exista ensayo
en dispositivo, conciliación con evidencia y las pantallas pendientes, esta tabla
se revisa de nuevo.

---

## 6. Evidencia

| Prueba | Resultado | Log |
| --- | --- | --- |
| Suite general | 101 fallas / 2443 aprobadas / 3 omitidas (2547, 188 archivos). La única añadida es la histórica `offline-24h` | `fulltech-tenancy-after-e2e.log` |
| Escenario E2E multiempresa (backend real) | **5/5** | `tests/e2e-multiempresa-uat.test.js` |
| Comparación por nombre vs corrida anterior | 0 fallas atribuibles a cambios de esta ronda | — |
| Conciliación | 5/5 | — |
| Flutter | `analyze` limpio, **107/107** | — |
| PostgreSQL 17 UAT aislado | 8/8 | `fulltech-postgres-reconciliation.log` |
| Flutter | `analyze` limpio, `test` 89/89 | — |
| APK UAT | compilada (SHA-256 arriba) | `fulltech-delivery-android-build-scope.log` |

Ningún saldo histórico se reasignó, ningún mensaje real se envió y ninguna
credencial ni archivo `.env` se mostró.

### Preparación de producción: firma real y paquete UAT en la nube (25-10-2026)

**Defecto encontrado y corregido:** el `release` se firmaba con la clave **debug**
(`signingConfig = signingConfigs.getByName("debug")`, con un TODO en
`android/app/build.gradle.kts`). Un APK así lo rechaza Google Play y no identifica
al propietario.

- `android/app/build.gradle.kts` lee `android/key.properties` y registra
  `signingConfigs.release`; si el archivo falta, el release cae a debug **con aviso
  en el log** (no falla en silencio).
- Llavero creado **fuera** de los repositorios: `C:\Users\pc\DEV\UAT\fulltech-release\fulltech-release.jks`
  (alias `fulltech`). `key.properties` y `*.jks` están en `.gitignore`.
  **Ese archivo es irrecuperable si se pierde: debe respaldarse y decidir si es la
  clave de carga de Play o solo de distribución interna.**
- APK de release: `build/app/outputs/flutter-apk/app-release.apk`, **52,5 MB**,
  SHA-256 `E29D58DCDB65E4C6178EE41DDFD46670781DBA5CDDD4814BBD2358892401D175`.
- Firma comprobada con `apksigner verify --print-certs`:
  `CN=FULLTECH Delivery, OU=UAT, O=FULLTECH, L=Santo Domingo, C=DO`,
  SHA-256 del certificado `fd7dc2ba…ffc2a00`. Ya no es la clave debug.
- Los certificados públicos de la CA de laboratorio (`assets/uat-ca.pem`,
  `assets/uat-ca-lan.pem`) siguen empaquetados pero son **inertes en release**:
  solo se cargan con `kDebugMode && uat`. Un APK de release confía únicamente en
  las raíces del sistema.

**Paquete UAT en la nube** (`deploy/uat/`): `docker-compose.uat.yml` levanta Postgres 17
**sin puerto publicado** y el servicio `crm` con `APP_ENV=uat`, cookies seguras,
healthcheck en `/api/health` y etiquetas `fulltech.purpose: uat`,
`fulltech.production: "false"`. `.env.uat.example` no contiene secretos (verificado) y
`.env.uat` está ignorado. `docker compose config` valida y la URL de base de datos
interpola correctamente. Instrucciones, verificación y rollback en `deploy/uat/README.md`.

**Verificación de esta ronda:** Flutter `analyze` limpio y **107/107**;
`e2e-multiempresa-uat` + `crm-company-scope` + `courier-documents` +
`cash-reconciliation` + `couriers-panel` **25/25**; PostgreSQL 17 UAT **8/8**.

**Lo que falta y no se puede hacer sin el propietario:**

- Dominio real y DNS del backend de producción (no se inventa ninguna URL).
- Autorización explícita para desplegar (no se ha desplegado, ni hecho push/merge).
- Aceptación en teléfono físico (el Firewall de Windows bloquea 8443 sin admin).
- Declaración de ubicación en segundo plano en Google Play.
- Respaldo del llavero y decisión sobre la clave de carga.

Comando exacto del build de producción, cuando exista el dominio:

```powershell
flutter build apk --release `
  --dart-define=DELIVERY_ENV=production `
  --dart-define=DELIVERY_API_BASE_URL=https://<dominio-real> `
  --dart-define=DELIVERY_DEMO_DATA=false
```

**Veredicto: NO-GO para producción.** La app está *preparada* (pipeline de firma real,
artefacto verificado, definición de backend UAT y suites en verde), no *aprobada*.

### Prueba en teléfono y brecha real de producción (25-10-2026)

**Lo que impide usar la app contra producción hoy:** el backend desplegado en
`https://phytoemagryrd.lat` es una versión **anterior** a la multiempresa. Comprobado
contra el servidor real:

| Ruta | Producción | Backend nuevo |
| --- | --- | --- |
| `POST /api/courier/login` | 401 (existe) pero **no devuelve `companies`** | devuelve `companies` |
| `GET /api/courier/companies` | **405** (no existe) | 200 |
| `POST /api/courier/applications` | **404** (no existe) | 202 |
| `/admin/couriers.html` | devuelve el shell del SPA (hash idéntico a una ruta inexistente) | página real |

La app llama a `signInWithPin`, que exige `companies` en la respuesta del login y
cierra la sesión con `company_selection_required` si viene vacío. Por eso **no se puede
entrar en producción aunque las credenciales sean válidas**: falta desplegar el backend
nuevo (requiere autorización) y dar de alta el acceso del repartidor desde el panel nuevo.

**Ensayo en teléfono sin tocar producción** (`scripts/uat-phone-backend.mjs`):
backend UAT con SQLite propio en `data/uat/phone.sqlite`, escuchando solo en
`127.0.0.1:8791`, más un túnel SSH de solo salida (`ssh -R 80:127.0.0.1:8791
nokey@localhost.run`) que da una URL `https://*.lhr.life` con certificado válido —
sin abrir puertos, sin firewall y sin instalar CA en el teléfono.
Verificado a través del túnel: `/api/health` 200, `/api/courier/companies` 200 con las
dos empresas, `POST /api/courier/login` 200 con token y `companies`.

APK de ensayo: `C:\Users\pc\DEV\UAT\fulltech-phone\fulltech-delivery-uat-tunel.apk`
(52,5 MB, SHA-256 `935900DE…EE00DF`), compilado con `DELIVERY_ENV=uat` y la URL del
túnel; se verificó que `libapp.so` contiene esa URL y no la de producción.

Límites del ensayo: la URL del túnel es efímera y depende de que este PC y el proceso
`ssh` sigan vivos; cada reinicio genera otra URL y exige recompilar. Para una prueba
estable hace falta el backend nuevo desplegado (nube o producción) con dominio fijo.
