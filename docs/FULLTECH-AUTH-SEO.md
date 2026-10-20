# FULLTECH Store — identidad de cliente, teléfono verificado y SEO

Estado: **2026-10-20**. Rama `main`, mismo worktree. No se ha hecho commit, push ni
despliegue, y no se ha tocado producción, DNS ni dominios.

Este documento describe solo lo que se ha implementado y comprobado. Lo que
depende de credenciales externas se marca como **pendiente** con su requisito.

---

## 1. Arquitectura de identidad

La cuenta de cliente de la tienda sigue apoyándose en el **CRM**: no hay base de
clientes paralela. `fulltech_customer_accounts_v1` enlaza UN cliente del CRM con
la cuenta online, y la identidad fuerte sigue siendo el teléfono E.164.

Módulos (nuevos, sin dependencias externas):

| Archivo | Responsabilidad |
| --- | --- |
| `server/store-verifications.mjs` | Validación de teléfono DR, OTP, tokens de correo y recuperación |
| `server/store-auth-routes.mjs` | Contrato HTTP de identidad (`/api/store/account/*`) |
| `server/store-google-idtoken.mjs` | Verificación en servidor del `credential` de Google Identity |
| `server/store-seo.mjs` | Renderizado de la página de producto, sitemap y robots |
| `server/store-seo-routes.mjs` | Rutas `/store/p/:id`, `/store/sitemap.xml`, `/store/robots.txt` |
| `public/store/verify/*` | Pantalla de confirmación del número (HTML/CSS/JS propios) |
| `tests/store-auth-uat.test.js` | UAT aislada de la lógica de identidad y SEO |

Sesión: cookie `ft_store_session` (`HttpOnly`, `SameSite=Lax`, 30 días, `Secure`
tras proxy HTTPS), token aleatorio guardado como hash SHA-256 en
`fulltech_customer_sessions_v1`. Independiente de la cookie del panel (`pe_crm`).

### Cookies y CSRF

- Todas las escrituras de identidad exigen **mismo origen** (`Origin`/`Host`).
- Google Identity Services: control de CSRF de doble envío con la cookie
  `g_csrf_token` que pone el propio botón; si no coincide se rechaza con 403.
- Recuperación de contraseña devuelve **siempre** la misma respuesta, exista o no
  la cuenta (no se puede enumerar clientes por esa vía).

## 2. Google

Implementado:

- Verificación **en el servidor** del `credential` (JWT firmado por Google):
  firma RS256 contra las claves públicas de Google (caché 1 h), `iss`, `aud`
  exacto, `exp`, `iat` con margen, `sub` obligatorio. Sin firma válida no hay
  identidad: el correo que envíe el navegador no se acepta nunca.
- El `sub` es la clave estable: cliente que vuelve entra en su misma cuenta.
- El enlace con una cuenta o un cliente existente solo ocurre con
  `email_verified === true`; si no hay forma segura, la cuenta queda
  `pending_link` y se completa con nombre y teléfono.
- Flujo de redirección clásico (`/auth/google/start` → callback) ya existente.

**Pendiente de credenciales:** `PHYTO_GOOGLE_CLIENT_ID` (y
`PHYTO_GOOGLE_CLIENT_SECRET` para el flujo de redirección) no están configurados
en este entorno. Con ellos vacíos el proveedor queda **apagado** y `/auth-config`
devuelve `google.enabled = false`. **No se ha probado el flujo real contra
Google**; lo probado es la verificación criptográfica y de reclamaciones con
claves propias (5 casos, incluidos audiencia ajena, emisor falso, token vencido y
firma manipulada).

## 3. Alta manual y acceso

- Nombre, teléfono dominicano, correo opcional y contraseña (mínimo 8).
- Contraseña con `scrypt` y sal aleatoria; comparación en tiempo constante.
- Alta con un teléfono que ya existe devuelve un mensaje **genérico** (no
  confirma si el número pertenece a otra cuenta).
- Teléfono con historial en el CRM: la cuenta solo se vincula con **prueba de
  propiedad** (número de un pedido del cliente). Sin prueba, `403
  verification_required`.
- Límite de intentos por IP en alta, acceso, envío de códigos y recuperación.

Comprobado de extremo a extremo contra el servidor real (base temporal):
alta → `201`, sesión por cookie → `/me` con `phone_verified: false`.

## 4. Teléfono guardado (verificación APLAZADA)

**Decisión vigente:** la Fase 1 **no verifica por SMS**. No se envía ningún
código, no se exige OTP para comprar y **nada se marca como verificado**. Lo único
obligatorio es tener un número **guardado** antes de pedir o solicitar.

Flujo: `/store/verify/` → número → guardado con estado `unverified`.

Reglas aplicadas:

- **Solo República Dominicana**: 809, 829 y 849. Un `+1 212` se rechaza con
  «Escribe un número de República Dominicana» — no se asume que todo `+1` sea
  dominicano. Se valida el prefijo local NANP (no puede empezar por 1 ni por 0).
- El número se guarda en la cuenta (`phone_e164`) y en `fulltech_store_phone_v1`
  con `verified_at = NULL` (**estado explícito «sin confirmar»**).
- El número completo nunca se devuelve al navegador en los estados: se usa
  enmascarado (`+1 ••• ••• 0123`). El dueño lo ve completo solo en «Mis datos».
- Un número no puede pertenecer a dos cuentas (`phone_in_use`).
- Si el número ya tiene historial en el CRM, la cuenta **no se enlaza** y no se
  muestra ningún pedido: se pide el número de un pedido anterior. Guardar un
  teléfono nunca fusiona identidades ni abre historial ajeno.
- Cambiar de número es inmediato y no requiere código; el estado vuelve a
  `unverified`.

Motor de verificación (conservado, **apagado**):

- Sigue completo en `store-verifications.mjs`: código de 6 dígitos, hash con sal,
  TTL 10 min, espera de 60 s, límites por cuenta/número/IP y máximo de intentos.
- `PHYTO_STORE_PHONE_OTP=off` (por defecto) hace que `phone/send` y
  `phone/verify` respondan `409 otp_disabled`. Se puede reactivar sin tocar
  código con `PHYTO_STORE_PHONE_OTP=enabled` (y entonces sí haría falta un
  proveedor de SMS aprobado).
- `PHYTO_STORE_SMS_MODE=off|http|outbox` sigue existiendo para cuando se active.

Cuándo se exige el número: antes de `POST /api/store/orders` y
`POST /api/store/requests`. La respuesta es `403 phone_required` con
`phone_url: /store/verify/`. Si la cuenta no está enlazada al CRM (teléfono con
historial y sin prueba), el mensaje pide el número de un pedido anterior.
El estado viaja en `/api/store/account/me` como `phone_saved`, `phone_verified`
(siempre `false` en Fase 1), `phone_otp_enabled` y `phone_masked`.

## 5. Correo y recuperación

- Confirmación de correo por enlace con token de un solo uso (24 h). Si el correo
  de la cuenta cambia después, el enlace anterior deja de valer.
- Recuperación de contraseña: enlace de 30 min, un solo uso, y al cambiarla se
  **revocan todas las sesiones** abiertas.
- `PHYTO_STORE_MAIL_MODE` (`off` | `http` | `outbox`) igual que el SMS. Sin
  proveedor, ambas funciones responden «no activo» en vez de fingir un envío.

## 6. Enlace con el CRM y aislamiento

- Una cuenta ⇄ un cliente. Nunca se fusiona por nombre, correo o teléfono sin
  prueba de propiedad.
- Un teléfono verificado **no** da acceso al historial por sí solo: el historial
  se obtiene del `customer_id` ya vinculado con prueba previa.
- Toda ruta protegida resuelve el cliente desde la sesión, nunca desde el cuerpo
  de la petición. Una solicitud de otro cliente responde `404`.
- El panel sigue viendo la cuenta dentro de la ficha del cliente; no se exponen
  contraseñas, códigos ni secretos.

## 7. Tablas nuevas (aditivas, sin tocar lo existente)

```
fulltech_store_phone_v1            (account_id PK, phone_e164, verified_at, updated_at)
fulltech_store_phone_codes_v1      (id, account_id, phone_e164, code_salt, code_hash,
                                    attempts, sent_at, expires_at, consumed_at, ip_hash)
fulltech_store_email_tokens_v1     (token_hash PK, account_id, kind, email_key,
                                    created_at, expires_at, used_at)
fulltech_store_email_v1            (account_id PK, email_key, verified_at)
```

No se modificó ninguna tabla de clientes, pedidos, facturas, inventario ni
pagos. No se hace `ALTER TABLE` sobre tablas existentes.

## 8. Pruebas

| Suite | Comando | Resultado |
| --- | --- | --- |
| UAT aislada (teléfono, OTP, Google, SEO) | `npx vitest run tests/store-auth-uat.test.js` | **17/17 OK** |
| Recorrido HTTP real (alta, OTP, sitemap, robots, 404, recuperación) | servidor en puerto aislado con base temporal | **16/16 OK** |

Cubierto: validación DR y rechazo de `+1` ajenos, enmascarado, generación y hash
del código, comparación en tiempo constante, firma y reclamaciones de Google,
alta de cuenta, espera entre envíos (429), código incorrecto (422), confirmación,
estado verificado, `phone_verified` en la cuenta, `robots.txt` cerrado, sitemap,
404 con `noindex` y recuperación genérica.

No cubierto (no hay canal real): envío efectivo de SMS/correo a un proveedor,
flujo real de Google y envío real de enlaces. `npm run uat` falla por un problema
previo ajeno a este trabajo (no se investigó por política de alcance).

## 9. Interfaz

`/store/verify/` — pantalla propia, compacta y accesible: dos pasos con barra de
progreso, campos con etiqueta y ayuda, `autocomplete="one-time-code"`,
`inputmode="numeric"`, mensajes con `role="alert"`, botón de reenvío con cuenta
atrás, cambio de número, modo claro/oscuro por `prefers-color-scheme` y
`prefers-reduced-motion`. Ningún éxito se muestra antes de que el servidor lo
confirme. La pantalla se enlaza desde **Mi cuenta** y desde **Finalizar pedido**
(el carrito se conserva).

## 10. SEO

- URL canónica por artículo publicado: `/store/p/<id>` con HTML **renderizado en
  el servidor** (título propio, `meta description`, canonical, Open Graph,
  `noindex` en entornos no autorizados).
- Datos estructurados `Product` + `Offer` + `BreadcrumbList` + `WebPage`, siempre
  desde el catálogo real y solo para artículos publicados y activos.
  **No se inventan** precio, valoraciones, reseñas ni disponibilidad.
- Sitemap generado solo con artículos publicados (`/store/sitemap.xml`).
- `robots.txt` servido por el servidor: en UAT y vista previa cierra todo
  (`Disallow: /`); con `PHYTO_STORE_INDEXABLE=true` permite `/store/`, bloquea
  `/admin/`, `/api/` y `/store/verify/`, y anuncia el sitemap.
- 404 para lo que no existe; **410** para artículos que existen en el catálogo
  pero están inactivos o sin publicar. Ambos con `noindex`.
- El HTML publicado no lleva CSS/JS externos: solo ~1,5 KB de CSS crítico y los
  enlaces vuelven a la tienda (que hidrata con su propio JS).

### Variables de entorno

```
PHYTO_STORE_INDEXABLE=true|false        # cerrado por defecto
PHYTO_STORE_PUBLIC_URL=https://…        # origen canónico
PHYTO_STORE_SITE_NAME=FULLTECH Store
PHYTO_STORE_SMS_MODE=off|http|outbox
PHYTO_STORE_SMS_URL / _TOKEN / _FROM / _OUTBOX
PHYTO_STORE_MAIL_MODE=off|http|outbox
PHYTO_STORE_MAIL_URL / _TOKEN / _FROM / _OUTBOX
```

### Nginx

Se añadieron tres bloques locales (no desplegados) para enviar al servidor del
CRM solo `/store/robots.txt`, `/store/sitemap.xml` y `/store/p/…`. Las rutas de
CRM y `/admin/` no cambian.

## 11. Estrategia de dominio (evidencia medida el 2026-10-20)

| Dominio | RDAP | DNS público | Lectura |
| --- | --- | --- | --- |
| `fulltechrd.com` | — | `A 31.97.99.70`, NS `registrar-servers.com` | **Ya es del negocio**: apunta al servidor de producción y responde por HTTPS |
| `fulltech.com.do` | 404 (sin registro RDAP) | sin NS, sin A | No delegado; disponibilidad **no confirmada** en un registrador de RD |
| `tiendafulltech.com` | 404 | sin NS, sin A | No delegado; disponibilidad **no confirmada** |
| `fulltechstore.com.do` | 404 | sin NS, sin A | No delegado; disponibilidad **no confirmada** |

**Recomendación:** usar **`fulltechrd.com`** como dominio canónico de FULLTECH
Store. Ya está registrado, con HTTPS funcionando y apuntando a la infraestructura
actual: coste cero, sin migración de DNS y sin riesgo. Estructura de URL:

```
https://fulltechrd.com/store/            catálogo
https://fulltechrd.com/store/p/<id>      página de artículo indexable
https://fulltechrd.com/store/sitemap.xml
```

`fulltech.com.do` sería más «de marca» pero exige registrar, delegar, emitir
certificado y mantener el CRM en otro dominio. Si se quiere, el camino seguro es
comprarlo y redirigir 301 a `fulltechrd.com`, no partir la identidad.

**No comprobado** (requiere registrador/abogado, no se inventa): precio de
renovación real, disponibilidad efectiva en NIC.do y conflictos de marca.

## 12. Credenciales y servicios pendientes

1. `PHYTO_GOOGLE_CLIENT_ID` + `PHYTO_GOOGLE_CLIENT_SECRET` (Google Cloud Console,
   origen autorizado `https://<dominio>` y callback
   `/api/store/account/auth/google/callback`).
2. Proveedor SMS aprobado con cobertura en RD y su coste real por mensaje
   (`PHYTO_STORE_SMS_*`). Nada se activa sin él.
3. Proveedor de correo transaccional (`PHYTO_STORE_MAIL_*`).
4. Aprobación explícita para marcar el entorno como indexable.

## 13. URLs de UAT

```
http://127.0.0.1:8790/api/store/account/verification
http://127.0.0.1:8790/store/p/<id>          (servidor del CRM)
http://127.0.0.1:8790/store/sitemap.xml
http://127.0.0.1:8790/store/robots.txt
http://127.0.0.1:4175/store/verify/         (servidor estático temporal de la tienda)
```

## 14. Archivos compartidos y conflictos

- `server/store-account-routes.mjs` (también lo toca la línea del catálogo):
  se añadieron **tres** bloques pequeños — estado de verificación en `/me` y el
  paso previo en `POST /orders` y `POST /requests`. No se tocó el alta de pedidos.
- `server/crm-server.mjs`: solo imports, configuración, construcción de servicios,
  tres entradas en `ctx` y dos líneas de enrutado. Los cambios de pedidos de la
  otra línea de trabajo quedan intactos.
- `public/store/store.js`: dos inserciones aisladas (aviso en **Mi cuenta** y
  paso previo en **Finalizar pedido**). El carrito no se modifica.
- `server/store-accounts.mjs`: `setPassword` y un mensaje genérico de alta.
- `nginx/phytoemagry.conf`: tres `location` nuevos.

## 15. GO / NO-GO

**GO** para integrar la autenticación con el checkout **ya**: el contrato está
cerrado (`phone_saved` en `/me`, `403 phone_required` con `phone_url`), el
carrito se conserva y la compra no depende de ningún proveedor externo.

**NO-GO** para abrir el índice de Google (`PHYTO_STORE_INDEXABLE=true`) hasta que
exista el dominio canónico decidido, el contenido publicado definitivo y la
validación del sitemap en Search Console.

**NO-GO** para afirmar «Google funciona» sin un `client_id` real probado con una
cuenta de Google de verdad. La verificación del `credential` está implementada y
probada con claves propias, pero no contra Google.

**N/A en Fase 1** la verificación por SMS: no se envía ningún código y nada se
marca como verificado. El motor queda apagado tras `PHYTO_STORE_PHONE_OTP`.

