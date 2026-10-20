# FULLTECH Store — dominio, HTTPS, Google Cloud y SEO de producción

Estado: **2026-10-20**. Documento de preparación. **No se ha cambiado DNS, no se
ha emitido ningún certificado, no se ha desplegado nada y no se ha activado el
índice de Google.**

---

## 1. Auditoría del alojamiento (solo lectura)

| Elemento | Valor real comprobado |
| --- | --- |
| Dominio del negocio | `fulltechrd.com` — `A 31.97.99.70`, NS `registrar-servers.com`, HTTPS operativo |
| Servidor | 31.97.99.70 (Docker/EasyPanel). Producción responde por 443: el TLS lo termina el proxy del panel, no el contenedor |
| Config nginx del contenedor | Escrita dentro de `Dockerfile` (etapa 3), `listen ${PORT}`, `server_name _`, `root /usr/share/nginx/html`, API en `127.0.0.1:8787` |
| `nginx/phytoemagry.conf` | **Solo referencia** para nginx del sistema (`server_name phytoemagry.example`). No es la configuración desplegada |
| PWA de la tienda | `manifest` con `id`, `start_url` y `scope` = `/store/` (rutas absolutas: funciona en cualquier host) |
| Service worker | `/store/sw.js` con `Service-Worker-Allowed: /store/` → alcance limitado a `/store/` |
| Cookie de cliente | `ft_store_session`, `Path=/`, `HttpOnly`, `SameSite=Lax`, **sin atributo `Domain`** → solo el host que la emitió |
| Cookie del panel | `pe_crm`, independiente; `/admin/` envía `X-Robots-Tag: noindex` |
| API de la tienda | `/api/store/*` en el mismo host que la tienda → mismo origen, sin CORS |

Consecuencia: **cualquier hostname nuevo apunta al mismo contenedor** y funciona
sin tocar la aplicación; solo hay que añadir el dominio en el panel para que
emita el certificado.

## 2. Arquitectura recomendada

**Primaria (objetivo): `https://tienda.fulltechrd.com`**

Ventajas:

- Aísla la sesión de cliente: la cookie de la tienda nunca viaja a `/admin/`.
- Separa el alcance del service worker y del manifiesto del CRM.
- `fulltechrd.com` y sus rutas de CRM, `/admin/`, webhooks de WhatsApp y panel
  siguen **exactamente igual**.
- URL profesional y estable (`/store/` deja de ser prefijo obligatorio de marca).

**Alternativa (sin DNS nuevo): `https://fulltechrd.com/store/`**

- Cero cambios de DNS y de certificado: ya funciona hoy.
- Inconveniente: comparte host con el CRM (la cookie de tienda se enviaría
  también en peticiones a `/admin/`; es inocua porque el panel usa otra cookie y
  otra sesión, pero es menos limpio) y la marca queda como subcarpeta.

**Regla de oro:** un solo hostname canónico. Nunca indexar los dos.

Si se elige `tienda.fulltechrd.com`, `fulltechrd.com/store/…` debe responder
**301** hacia el subdominio (redirección a nivel de proxy/panel; no hace falta
tocar el contenedor).

## 3. Plan DNS (no ejecutado)

```
; Antes: bajar el TTL de fulltechrd.com a 300 y esperar el TTL anterior
tienda.fulltechrd.com.   300   IN   CNAME   fulltechrd.com.
; Si el panel no admite CNAME para un subdominio nuevo:
tienda.fulltechrd.com.   300   IN   A       31.97.99.70
```

Pasos:

1. Bajar TTL de los registros actuales a 300 s y esperar a que expire el TTL previo.
2. Crear el registro del subdominio (CNAME preferido; A si el proveedor lo exige).
3. En el panel del servidor: añadir el dominio `tienda.fulltechrd.com` a la
   aplicación de la tienda y dejar que emita el certificado (Let's Encrypt) por
   HTTP-01.
4. Comprobar `https://tienda.fulltechrd.com/store/` (200), `/store/robots.txt`,
   `/store/sitemap.xml` y `/api/health`.
5. Redirección 301 desde `fulltechrd.com/store/` al subdominio (regla del panel).
6. Solo entonces: `PHYTO_STORE_PUBLIC_URL=https://tienda.fulltechrd.com` y
   `PHYTO_STORE_INDEXABLE=true`, y reiniciar el servicio.

Ningún paso anterior se ha ejecutado.

## 4. Nginx / rutas

Ya preparado en código (sin desplegar):

- Contenedor (`Dockerfile`, etapa 3): `/store/p/`, `/store/sitemap.xml` y
  `/store/robots.txt` → `proxy_pass http://127.0.0.1:8787`. El resto de
  `/store/` sigue siendo estático.
- `nginx/phytoemagry.conf` (referencia no-Docker): los mismos tres bloques.

No se requiere ninguna otra ruta: el contenedor acepta cualquier `Host`
(`server_name _`).

## 5. Rollback

| Cambio | Cómo se revierte | Efecto |
| --- | --- | --- |
| Registro DNS | Reponer el TTL/valor anterior (TTL 300) | Tráfico vuelve al host previo en ≤5 min |
| Dominio/certificado en el panel | Quitar el dominio | El host anterior sigue sirviendo |
| Imagen del contenedor | `docker service rollback <servicio>` | Vuelve la versión anterior en segundos |
| Indexación | `PHYTO_STORE_INDEXABLE=false` + reinicio | `robots.txt` cierra todo y las páginas salen con `noindex` |
| Rutas SEO | Quitar los tres `location` | `/store/` estático sigue funcionando; solo se pierden las páginas de producto |

Nada de esto toca pedidos, clientes, facturas ni inventario: las tablas nuevas
son aditivas.

## 6. Google Cloud — valores exactos

No hay credenciales inventadas: hasta que se pegue un `client_id` real, el botón
de Google no se pinta y el servidor responde `provider_not_configured`.

1. **Proyecto** → APIs & Services → OAuth consent screen:
   - Tipo: *External*, estado *Testing* mientras se valida.
   - Nombre de la app: `FULLTECH Store`.
   - Correo de asistencia y de contacto del desarrollador.
   - Dominios autorizados: `fulltechrd.com`.
   - Scopes: `openid`, `email`, `profile` (no se piden más).
2. **Credentials** → *Create credentials* → *OAuth client ID* → **Web application**.
3. **Authorized JavaScript origins** (sin ruta, sin barra final):
   ```
   http://localhost:8790
   http://localhost:4175
   https://tienda.fulltechrd.com
   https://fulltechrd.com        (solo si /store/ sigue accesible ahí)
   ```
4. **Authorized redirect URIs** (solo para el flujo de redirección clásico):
   ```
   http://localhost:8790/api/store/account/auth/google/callback
   https://tienda.fulltechrd.com/api/store/account/auth/google/callback
   ```
5. **¿Hace falta el client secret?**
   - Flujo *Google Identity Services* (botón «Continuar con Google», lo que se
     usa en la tienda): **NO**. Solo se valida el `credential` firmado contra el
     `client_id`.
   - Flujo de redirección del servidor (`/auth/google/start`): **SÍ**, se
     necesita `PHYTO_GOOGLE_CLIENT_SECRET`. Es opcional; sin él, la tienda usa
     únicamente GIS.
6. **Variables de entorno** (solo servidor, nunca en el frontend):
   ```
   PHYTO_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   # Opcional, solo si se quiere también el flujo de redirección:
   PHYTO_GOOGLE_CLIENT_SECRET=...
   PHYTO_GOOGLE_REDIRECT_URI=https://tienda.fulltechrd.com/api/store/account/auth/google/callback
   ```
   El `client_id` sí se publica por `/api/store/account/auth-config` (es público
   por diseño). El secreto nunca sale del servidor.

### Cómo probar

- **Éxito (real):** abrir `/store/#/account/login`, pulsar «Continuar con Google»
  con una cuenta real, aceptar; debe volver a `/store/#/account` con la sesión
  creada y `GET /api/store/account/me` devolviendo la cuenta.
- **Fallo controlado:** `POST /api/store/account/google/credential` con un
  `credential` de otro proyecto → `401 invalid_audience`; token vencido →
  `401 expired_credential`; firma manipulada → `401 invalid_signature`.
  (Estos tres casos ya están cubiertos en `tests/store-auth-uat.test.js` con
  claves propias.)
- **Sin configurar:** `/api/store/account/auth-config` → `google.enabled: false`
  y ningún botón en pantalla.

## 7. Google Search Console

1. Propiedad recomendada: **Dominio** (`fulltechrd.com`), que cubre subdominios.
   Verificación por DNS: `TXT _google-site-verification=<token>` en
   `fulltechrd.com` (DNS, no toca el servidor).
   Alternativa sin DNS: propiedad de prefijo de URL
   `https://tienda.fulltechrd.com/` con archivo HTML en la raíz.
2. Con `PHYTO_STORE_INDEXABLE=true` y el dominio publicado:
   Sitemaps → añadir `https://tienda.fulltechrd.com/store/sitemap.xml`.
3. Inspección de URL sobre un artículo: debe salir «La URL está en Google» tras
   rastrearse; comprobar canonical y datos estructurados (Product, Offer,
   BreadcrumbList).
4. Revisar «Páginas» a las 48–72 h: 0 errores 404/410 en productos publicados.

## 8. OTP por WhatsApp — diseño futuro (no implementado)

- Canal: **WhatsApp Cloud API oficial** (el mismo WABA del CRM), plantilla
  categoría **AUTHENTICATION** con botón **«Copiar código»** (`otp_type:
  COPY_CODE`), idioma `es` / `es_DO`.
- Plantilla sugerida: nombre `fulltech_store_codigo`, cuerpo
  `Tu código de FULLTECH Store es {{1}}. Caduca en 10 minutos.` y botón de copiar.
- Envío (referencia; validar contra la documentación vigente de Meta al
  implementar):
  ```json
  { "messaging_product": "whatsapp", "to": "1809…", "type": "template",
    "template": { "name": "fulltech_store_codigo", "language": { "code": "es" },
      "components": [
        { "type": "body", "parameters": [{ "type": "text", "text": "123456" }] },
        { "type": "button", "sub_type": "copy_code", "index": "0",
          "parameters": [{ "type": "coupon_code", "coupon_code": "123456" }] } ] } }
  ```
- El motor de OTP ya existe (`store-verifications.mjs`: hash con sal, TTL,
  intentos, esperas, límites por cuenta/número/IP) y solo cambia el **transporte**.
- **Flag**: `PHYTO_STORE_PHONE_OTP=enabled` (hoy `off`) + un futuro
  `PHYTO_STORE_WHATSAPP_OTP=on`. Sin ambos, no se envía nada.
- No se ha creado ni enviado ninguna plantilla, y no se ha tocado la integración
  de WhatsApp existente.

## 9. Activación del dominio público — lista de verificación

- [ ] Aprobación explícita para crear el DNS.
- [ ] Registro `tienda.fulltechrd.com` creado y propagado (TTL 300).
- [ ] Dominio añadido en el panel y certificado emitido (HTTPS 200).
- [ ] 301 desde `fulltechrd.com/store/` al subdominio.
- [ ] `PHYTO_STORE_PUBLIC_URL=https://tienda.fulltechrd.com`.
- [ ] `PHYTO_STORE_INDEXABLE=true` (solo tras revisar el catálogo publicado).
- [ ] Humo: `/store/`, `/store/p/<id>`, `/store/sitemap.xml`,
      `/store/robots.txt`, `/api/health`, login, pedido de prueba.
- [ ] Search Console verificado y sitemap enviado.
- [ ] Vigilar 404/410 y «Rastreada: actualmente no indexada» durante una semana.
