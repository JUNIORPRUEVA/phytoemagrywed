# Google Sign-In en producción — guía de paso a producción

> Estado: **código preparado y probado en local** (rama `fix/fulltech-google-oauth-ready`).
> **No desplegado, no publicado en Google Cloud, sin secretos rotados.** Este
> documento describe lo que falta hacer y cómo revertirlo.

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

## 6. Pendiente manual en Google Cloud (no automatizable)

Google **no expone API pública** del OAuth consent screen. En
`console.cloud.google.com/apis/credentials/consent?project=644090613221`:

1. **Publishing status** → *PUBLISH APP* (si sigue en *Testing*, solo entran los
   *test users*).
2. **Authorized domains** → `fulltechrd.com`.
3. *(Opcional)* logo 120×120 + *Verify branding*.
4. Confirmar que el cliente OAuth tiene registrado **exactamente**
   `https://fulltechrd.com/api/store/account/auth/google/callback`.
