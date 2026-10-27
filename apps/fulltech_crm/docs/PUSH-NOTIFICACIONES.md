# Notificaciones push en la app nativa — arquitectura propuesta

> **Estado: propuesta. No hay nada configurado.**
> No se ha creado ningún proyecto de Firebase, no existe `google-services.json`, no hay
> claves APNs, no se ha tocado el backend para esto y la app **no** pide permiso de
> notificaciones. Este documento sólo deja escrito cómo se haría sin duplicar el motor
> de avisos que el negocio ya tiene.

## 1. Regla de oro: un solo motor de avisos

El CRM ya genera los avisos (`notifications`) y ya sabe a quién le toca cada uno. La
app nativa **no** puede tener su propia lógica de «qué se avisa y a quién»: sería la
forma más rápida de que un repartidor reciba avisos de otro, o de avisar dos veces.

```
hecho en el negocio (pedido, mensaje, pago…)
        │
        ▼
 notificación del CRM  ──►  bandeja del panel (ya existe)
        │
        ├─►  web push (PWA, ya existe)   → `push_jobs` / `push-subscriptions`
        └─►  push móvil (nuevo)          → el MISMO registro de suscripciones
```

La pieza nueva es sólo el **transporte**: un `pushToken` por instalación, guardado
junto a la suscripción del panel, y un envío por FCM/APNs. Los permisos, el contenido y
el «quién» siguen decidiéndose en el servidor.

## 2. Lo que ya existe en el backend (reutilizable)

| Pieza | Dónde | Uso para móvil |
| --- | --- | --- |
| Tabla `push_jobs` | base del CRM | cola de avisos pendientes (ya usada por web push) |
| Suscripciones | `/api/admin/push-subscriptions` | añadir `platform: 'android' \| 'ios'` + `token` |
| Estado del push | `/api/admin/push-status` | diagnóstico (cuántos dispositivos, últimos fallos) |
| Claves VAPID | entorno (`PHYTO_WEB_PUSH_*`) | sólo para web; **no** sirven para FCM/APNs |
| `notifications` | base del CRM | origen único del aviso |

Lo que hay que añadir más adelante (cuando se decida):

1. Columnas nuevas y **aditivas** en la tabla de suscripciones: `platform`, `token`,
   `app_version`, `last_seen_at`, `revoked_at`.
2. `POST /api/admin/push-subscriptions` acepta también `{ platform, token }`.
3. Un emisor por plataforma detrás de la misma cola (`push_jobs`):
   - Android → FCM HTTP v1 con **mensaje data-only** (`android.priority: high`).
   - iOS → APNs (token-based, clave `.p8`) o FCM como intermediario.
4. Borrado del token cuando el servicio responde `UNREGISTERED` / `410`. Un token
   muerto que se reintenta para siempre es la causa típica de «el push dejó de
   llegar a todos».

## 3. Android (FCM)

**Configuración (cuando se autorice):**

- Proyecto de Firebase + app Android con el `applicationId` real
  (`com.fulltech.fulltechDelivery` — comprobar en `android/app/build.gradle.kts`).
- `google-services.json` en `android/app/`.
- Plugin `com.google.gms.google-services` en Gradle (nivel de app).
- `POST_NOTIFICATIONS` en el manifiesto (Android 13+) y petición **en contexto**
  (cuando el usuario entra por primera vez a Pedidos o WhatsApp, no al abrir la app).
- Canal de notificación propio (`crm_avisos`, importancia alta) con sonido y
  vibración; un segundo canal silencioso para «cambios de estado» sin ruido.

**Dependencias Flutter previstas:** `firebase_core`, `firebase_messaging`
(no instaladas; añadirlas obliga a compilar con Google Services y a subir el
`minSdk` sólo si hiciera falta).

**Mensajes:** data-only (`{ type, entityId, deepLink }`). La app decide qué pintar y
navega con el `deepLink` (por ejemplo `/?v=pedidos&order=…`). Un mensaje
`notification` lo pinta el sistema con texto duplicado en la bandeja del teléfono.

**Permisos:** el token se registra **después** de que la persona acepte; si dice que
no, la app sigue funcionando igual (el CRM no depende del push).

## 4. iPhone (APNs)

- Cuenta de desarrollador de Apple, `App ID` con la capacidad *Push Notifications*.
- Clave APNs `.p8` (una sola, sirve para todas las apps) + `Key ID` + `Team ID`.
- `aps-environment: development|production` en los entitlements.
- `UNUserNotificationCenter` para pedir permiso y para mostrar la notificación con la
  app en primer plano.
- Si se usa FCM como intermediario: subir la misma `.p8` a la consola de Firebase y
  mapear `FCM token` → `APNs token`.

**Nota práctica:** sin Mac no se puede firmar ni probar el push de iOS. La app puede
compilarse y probarse en Android/Windows mientras tanto; el código de registro del
token debe quedar detrás de una comprobación de plataforma para no romper iOS si aún
no está configurado.

## 5. Qué NO se hará

- No crear un segundo motor de avisos en la app.
- No guardar tokens en texto plano fuera del almacén del servidor.
- No enviar contenido sensible (importes, direcciones, teléfonos) en el cuerpo del
  push: sólo «qué cambió» y un enlace; el contenido se pide con la sesión.
- No activar nada en producción sin autorización expresa (MODO RÁPIDO: sólo se
  documenta).

## 6. Pasos cuando se autorice (orden recomendado)

1. Decidir plataforma prioritaria (Android primero, por volumen de repartidores).
2. Crear proyecto Firebase y subir `google-services.json`.
3. Añadir `platform`/`token` a las suscripciones + endpoint de alta/baja.
4. Implementar el emisor FCM reutilizando `push_jobs` (misma cola, otro transporte).
5. Registrar el token en la app y probar con un aviso real en UAT.
6. Sólo después: APNs/iOS.
