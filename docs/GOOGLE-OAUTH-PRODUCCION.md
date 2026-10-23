# Google Sign-In en producción — guía de paso a producción

> Estado: **release candidate aislada y probada en local** (rama
> `release/google-oauth-20261023`, cortada de `main` @ `5f80d38`).
> **No desplegado, no publicado en Google Cloud, sin secretos rotados.** Este
> documento describe lo que falta hacer y cómo revertirlo.

## 0. Composición de esta release (17 archivos, sin trabajo ajeno)

**Nuevos (4):** `server/http-trust.mjs` · `scripts/oauth-preflight.mjs` ·
`tests/google-oauth-hardening.test.js` · `docs/GOOGLE-OAUTH-PRODUCCION.md`

**Modificados (13):** `server/crm-server.mjs` · `server/store-account-routes.mjs` ·
`server/store-accounts.mjs` · `server/store-auth-routes.mjs` ·
`public/store/store.js` · `public/store/google-signin.js` ·
`public/store/index.html` · `public/store/sw.js` · `Dockerfile` ·
`nginx/phytoemagry.conf` · `src/render/pages.js` · `.env.example` ·
`tests/store-auth-uat.test.js` (fixture SEO)

Quedan **fuera** a propósito (trabajo de otras sesiones): pantalla de arranque
(`startup.css`, `renderStartup`), separación de tienda, `ops/*`,
`delivery-supervisor`, `store-catalog`, `admin/*` y sus pruebas.

## 1. Qué fallaba y qué se corrigió

| # | Fallo real (auditoría 2026-10-22) | Archivo(s) | Corrección |
|---|---|---|---|
| S1 | `www.fulltechrd.com` servía la tienda, pero el `redirect_uri` está fijado al dominio raíz: la cookie `ft_oauth_state` se emitía en `www` y el callback volvía al apex **sin ella** ⇒ `invalid_state` siempre. | `Dockerfile`, `nginx/phytoemagry.conf` | Redirección canónica `www → fulltechrd.com` con **308**, conservando ruta y query (`$request_uri`). |
| S2 | Las cookies de sesión y del `state` salían **sin `Secure`** en producción: nginx pisaba `X-Forwarded-Proto` con `$scheme` (= `http` detrás de Traefik). | `Dockerfile`, `nginx/phytoemagry.conf`, `server/http-trust.mjs`, `store-account-routes.mjs`, `store-auth-routes.mjs` | `map $http_x_forwarded_proto $phyto_forwarded_proto` (usa el esquema real del proxy y cae a `$scheme` si no hay proxy) + detección de HTTPS que **solo cree la cabecera si el par es un proxy de confianza**. |
| S3 | El límite de intentos usaba `req.socket.remoteAddress` = `127.0.0.1` para todos ⇒ **20 intentos bloqueaban a todo el sitio**. | `server/http-trust.mjs`, `store-account-routes.mjs`, `store-auth-routes.mjs` | IP real por cadena `X-Forwarded-For` recorrida **de derecha a izquierda** (lo que escribe el cliente no cuenta). Cubo por cliente. |
| S4 | `oauthLogin()` enlazaba Google a cualquier cuenta con el mismo correo aunque ese correo **nunca se hubiera verificado** ⇒ robo de cuenta (la contraseña del atacante seguía valiendo). También ataba la cuenta a la ficha del CRM solo por correo. | `server/store-accounts.mjs` | Cuenta **con contraseña** ⇒ no se enlaza nada: enlace pendiente + **prueba de contraseña**. Cuenta **sin contraseña** ⇒ enlace directo (no hay credencial que robar). Se elimina el enlace automático por correo del CRM: se pide teléfono y, si hay historial, número de pedido. |
| S5 | `ventas_phytoemagrywed` tiene un **client secret guardado en `PHYTO_GOOGLE_CLIENT_ID`** y le faltan las otras dos variables. | fuera del repo (EasyPanel) | Ver §4. **Rotar el secreto**: quedó expuesto en la salida de una terminal durante la auditoría. |
| S6 | El botón decía «Google estará disponible muy pronto» para siempre. | `public/store/store.js`, `sw.js`, `index.html` | Tres estados honestos: enlace real / «Comprobando…» / «no disponible ahora» + «Sin conexión» si `navigator.onLine === false`. Se sube la versión del SW (`fulltech-store-v64`) para que la PWA instalada lo recoja. |
| S7 | La política de privacidad no mencionaba Google. | `src/render/pages.js` | Sección **7. Acceso con Google** (datos recibidos, permisos `openid email profile`, Uso Limitado). |
| S8 | Test del sitemap en rojo desde que se añadió `purchaseable`. | `tests/store-auth-uat.test.js` | Al fixture le faltaba `purchaseable: true` y el conteo de `<url>` era 2 (con el producto elegible son 3). |

## 2. Variables de entorno (sin valores)

| Variable | Dónde | Obligatoria |
|---|---|---|
| `PHYTO_GOOGLE_CLIENT_ID` | deployment | sí |
| `PHYTO_GOOGLE_CLIENT_SECRET` | deployment (secreto) | sí |
| `PHYTO_GOOGLE_REDIRECT_URI` | deployment | sí — `https://fulltechrd.com/api/store/account/auth/google/callback` |
| `PHYTO_TRUSTED_PROXIES` | deployment | no (por defecto `127.0.0.1,::1`) |
| `PHYTO_FORCE_SECURE_COOKIES` | deployment | no (`true` fuerza `Secure`) |

Comprobación previa (no imprime secretos):

```bash
node scripts/oauth-preflight.mjs            # entorno del proceso
node scripts/oauth-preflight.mjs .env.prod  # archivo KEY=VALUE
```

Sale `1` (fallo) si el `CLIENT_ID` contiene lo que parece un secreto (`GOCSPX-`),
si falta el secreto, o si el `redirect_uri` no es HTTPS, no apunta al callback o
apunta a `www`/host interno.

## 3. Pruebas

```bash
npx vitest run --no-file-parallelism tests/google-oauth-hardening.test.js
npm run check        # puerta del build (contenido y afirmaciones)
```

Validación real de nginx (no requiere el proyecto levantado):

```bash
node .tmp/extract-nginx.mjs   # o extraer el heredoc a mano
docker run --rm -v "$PWD/.tmp:/w:ro" nginx:alpine nginx -t -c /w/nginx-full.conf
```

## 4. Rotación del secreto y limpieza del despliegue antiguo

> **Nada de esto se ha ejecutado.** Requiere autorización explícita.

El secreto de Google que estaba guardado en `PHYTO_GOOGLE_CLIENT_ID` (servicio
`ventas_phytoemagrywed`) **apareció en la salida de una terminal** durante la
auditoría. Debe considerarse comprometido.

Orden seguro (sin cortar el acceso, Google permite dos secretos por cliente):

1. **Google Cloud Console** → proyecto `644090613221` → *APIs y servicios* →
   *Credenciales* → cliente OAuth de tipo **Aplicación web** (el que empieza por
   `644090613221-…`).
2. **Agregar secreto** (no «Restablecer»): Google admite dos activos. Copia el
   nuevo valor **directamente al gestor de variables**, nunca a un chat, ticket
   ni commit.
3. En el servicio que sirve `fulltechrd.com`, actualizar
   `PHYTO_GOOGLE_CLIENT_SECRET` con el valor nuevo y **redesplegar**.
4. Verificar: `GET /api/store/account/providers` → `google:true`, y
   `GET /auth/google/start` → 302 a `accounts.google.com` con el
   `redirect_uri` correcto.
5. Esperar 24–48 h sin errores `invalid_client` en los logs.
6. **Eliminar el secreto viejo** en la consola (el que estaba mal ubicado).

Limpieza del despliegue antiguo (`phytoemagryrd.lat`), que hoy responde
`providers.google = false`:

```bash
# Quita la variable mal puesta (contiene un secreto, no un client ID).
docker service update --env-rm PHYTO_GOOGLE_CLIENT_ID ventas_phytoemagrywed
```

Con eso, ese servicio queda sin Google **como ya está de facto** (`clientId &&
clientSecret` = `false`), sin tocar nada más. Si en el futuro debe ofrecer
Google, se le añaden las **tres** variables correctas apuntando a **su** propio
`redirect_uri`.

## 5. Despliegue y rollback

Despliegue (cuando se autorice):

1. `npm run verify:deploy` → `check` + `build` (es la puerta del Dockerfile; **no**
   ejecuta tests, así que un test heredado en rojo no bloquea la imagen).
2. Construir imagen y `docker service update` del servicio que sirve
   `fulltechrd.com` (EasyPanel también vale, es un Deploy normal).
3. Verificar en caliente:
   - `https://www.fulltechrd.com/store/` → **308** a `https://fulltechrd.com/store/`.
   - `https://fulltechrd.com/api/store/account/providers` → `google:true`.
   - `curl -I https://fulltechrd.com/api/store/account/auth/google/start` →
     `302` + `Set-Cookie: ft_oauth_state=…; HttpOnly; SameSite=Lax; Secure`.
   - Entrar con una cuenta Google **que no sea test user** (así se detecta si el
     consent screen sigue en *Testing*).

Rollback: volver a la imagen anterior con
`docker service update --image <imagen-anterior> <servicio>` (EasyPanel guarda la
versión previa). Los cambios son de aplicación; **no hay migración destructiva**
de datos: la tabla de enlaces solo gana dos columnas anulables (`provider`, `sub`)
y el código funciona con enlaces antiguos (sin identidad ⇒ no enlaza, solo pide
teléfono).

## 5 bis. Checklist de despliegue (verificado 2026-10-23, solo lectura)

**Hechos del entorno (no cambian con esta release):**

| Dato | Valor |
|---|---|
| Servicio que sirve `fulltechrd.com` | `ventas_fulltech-tienda-pwa` |
| Imagen actual (etiqueta **mutable**) | `easypanel/ventas/fulltech-tienda-pwa:latest` |
| **Identificador inmutable actual** | `sha256:35816c658a28b828ddec8543ddff45d6bb1576a3c12b045d4697a107f8675740` |
| Otro servicio con la MISMA imagen | `ventas_phytoemagrywed` (phytoemagryrd.lat) |
| Volumen persistente | `fe109db8c83d…` → `/data` |
| Base de datos | contenedor `ventas_studio-db.1.*` (Postgres **17.11**) |

> Ojo: `:latest` es **mutable** y hoy ambos servicios comparten la misma imagen.
> Para desplegar y para volver atrás hay que fijar el **ID de imagen**
> (`sha256:…`), nunca la etiqueta, o se puede arrastrar un cambio ajeno.

**Antes de desplegar**

1. `node scripts/oauth-preflight.mjs` → `0 fallo(s)` (no imprime valores).
2. Rotar el secreto (§4) y ponerlo en el servicio **antes** de publicar el botón.
3. Respaldo y **validación real** del respaldo (el 2026-10-19 hubo un
   `database-before-ERRONEA-video_studio.dump` de 58 KB: existía, pero estaba mal):
   ```bash
   docker exec ventas_studio-db.1.* pg_dump -U video_studio_user -d phytoemagry \
     -Fc -f /tmp/before-google-oauth.dump
   docker exec ventas_studio-db.1.* pg_restore -l /tmp/before-google-oauth.dump | wc -l   # >300 objetos
   docker exec ventas_studio-db.1.* pg_restore -l /tmp/before-google-oauth.dump | grep -c fulltech_customer_accounts_v1  # >=1
   ```
   El respaldo es válido si lista >300 objetos y **contiene** las tablas
   `fulltech_customer_*`. Tamaño esperado: ~0,7 MB.
4. Anotar el ID de la imagen que corre AHORA (arriba) como destino de rollback.
5. Construir la imagen nueva y etiquetarla con **commit + fecha**:
   `easypanel/ventas/fulltech-tienda-pwa:google-oauth-<commit>`.

**Durante**

6. `docker service update --image easypanel/ventas/fulltech-tienda-pwa:google-oauth-<commit> --update-order start-first --update-failure-action rollback ventas_fulltech-tienda-pwa`.
7. Esperar `UpdateStatus=completed` y `1/1`.

**Después (smoke tests, todos de solo lectura o con una cuenta de prueba)**

8. `GET /api/health` → 200 y `storage: postgres`.
9. `GET /api/store/account/providers` → `google: true`.
10. `GET https://www.fulltechrd.com/store/` → 308 al apex conservando la query.
11. `GET /api/store/account/auth/google/start` → 302 + cookie `Secure`.
12. Login real con una cuenta Google fuera de *test users*.
13. Login con contraseña de una cuenta existente (compatibilidad).
14. Revisar logs: sin `[store-oauth] callback failed` ni `invalid_client`.

**Rollback**

```bash
docker service update --image sha256:35816c658a28b828ddec8543ddff45d6bb1576a3c12b045d4697a107f8675740 \
  ventas_fulltech-tienda-pwa
```

- No hay que deshacer datos: las dos columnas nuevas son anulables y el código
  antiguo las ignora.
- La redirección `www` y el `map` del esquema son inocuos: pueden quedarse.
- Si hubo que restaurar la base: `pg_restore -c -d phytoemagry <dump>` **solo**
  tras confirmar el alcance; es una operación destructiva.

## 6. Pendiente manual en Google Cloud (no automatizable)

Google **no expone API pública** del OAuth consent screen. Todo esto se hace en
`console.cloud.google.com` con el proyecto **644090613221** (se elige con el
selector de proyectos, arriba; muestra «Número de proyecto: 644090613221»).

### 6.1 Añadir un secreto nuevo (rotación sin caída)

1. *APIs y servicios* → *Credenciales*.
2. En «ID de cliente de OAuth 2.0», abrir el cliente **tipo Aplicación web** cuyo
   ID empieza por `644090613221-`.
3. **AGREGAR SECRETO** (no «Restablecer secreto»: restablecer invalida el
   anterior al instante y tumba el acceso).
4. Copiar el valor nuevo **directamente** al gestor de variables del servicio
   (`PHYTO_GOOGLE_CLIENT_SECRET`). Nunca a un chat, ticket, issue ni commit.
5. Desplegar. Verificar `providers → google:true` y un login real.

### 6.2 Revocar el secreto expuesto

1. Mismo cliente OAuth → lista de secretos.
2. Localizar el que **no** es el que acaba de desplegarse (el antiguo).
3. **Eliminar** (icono de papelera). Google lo invalida en segundos.
4. Confirmar después que el login sigue funcionando (si falla con
   `invalid_client`, se borró el equivocado: volver a crear otro y desplegar).
5. Además, quitar la variable mal ubicada del despliegue antiguo:
   `docker service update --env-rm PHYTO_GOOGLE_CLIENT_ID ventas_phytoemagrywed`.

### 6.3 Publicar la aplicación (para todos los clientes)

1. *APIs y servicios* → *Pantalla de consentimiento de OAuth*.
2. Comprobar **Tipo de usuario: Externo** y **Estado de publicación**.
3. Si dice *Testing*: **PUBLICAR APLICACIÓN** → confirmar. Con los scopes
   `openid email profile` (no sensibles) la publicación es inmediata y **no**
   requiere revisión de Google.
4. *Dominios autorizados* → `fulltechrd.com`.
5. *(Opcional)* logo 120×120 + *Verificar marca*.
6. Confirmar en el cliente OAuth que el URI autorizado es exactamente
   `https://fulltechrd.com/api/store/account/auth/google/callback` (un solo URI,
   sin `www`, sin query).

> Mientras el estado sea *Testing*, el botón funciona pero Google responde
> «Error 403: access_denied» a cualquier cuenta que no esté en *Usuarios de
> prueba*. Ese es el síntoma que delata que falta el paso 3.
