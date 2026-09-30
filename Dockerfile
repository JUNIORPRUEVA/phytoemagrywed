# syntax=docker/dockerfile:1
# ============================================================================
#  Phytoemagry — imagen de producción (este archivo es TODO el despliegue)
#
#  No hace falta copiar nada a mano ni instalar Node en el servidor: el
#  Dockerfile compila la web, la sirve con nginx y guarda los pedidos y los
#  contactos con su propio API.
#
#  EN EL SERVIDOR (2 comandos):
#    git clone https://github.com/JUNIORPRUEVA/phytoemagrywed.git
#    cd phytoemagrywed && docker build -t phytoemagry . && docker run -d \
#      --name phytoemagry -p 8080:80 --restart unless-stopped \
#      -e PHYTO_CRM_TOKEN=una-clave-larga \
#      -e PHYTO_CRM_DATABASE_URL=postgres://usuario:clave@host:5432/phytoemagry \
#      tu-phytoemagry
#
#  (Si nada más usa el puerto 80, cambia `-p 8080:80` por `-p 80:80` y ya no
#  hace falta ningún proxy delante. Con dominio y HTTPS, deja 8080 y pon el
#  certificado en el proxy: ver docs/DESPLIEGUE.md.)
#
#  O con Compose (trae los valores y el healthcheck):
#    docker compose up -d --build
#
#  EASYPANEL / DOKPLOY / COOLIFY (paneles con Docker):
#    Service → App → Source: Git (este repo, branch main)
#    Build: Dockerfile (ruta `Dockerfile`)  ·  Domains: puerto del proxy 80
#    Environment: PHYTO_WHATSAPP_NUMBER, SEO_SITE_URL, PHYTO_CRM_TOKEN,
#                 PHYTO_CRM_DATABASE_URL, ...  (los públicos llegan al build)
#
#  DÓNDE QUEDAN LOS DATOS: en la base de datos PostgreSQL que indiques en
#  PHYTO_CRM_DATABASE_URL. Si no la configuras, se guardan en
#  `/data/phytoemagry.sqlite` (dentro del contenedor: monta ahí un volumen o se
#  pierden en cada actualización). En los dos casos se leen entrando en
#  `/panel?token=TU_CLAVE` (o se descargan en CSV desde ahí).
#  Ver docs/CRM-CONTRACT.md.
#
#  NOTA: el Dockerfile necesita el CÓDIGO del proyecto (src/, public/,
#  package.json...), que ya viaja en el repositorio. No es un archivo suelto:
#  `docker build` se ejecuta sobre la carpeta del proyecto.
#
#  Los valores de abajo son PÚBLICOS: acaban en el HTML/JS que recibe el
#  navegador (el número de WhatsApp se ve en la página). PHYTO_CRM_TOKEN se pasa
#  EN TIEMPO DE EJECUCIÓN (`docker run -e`), nunca aquí: el build no lleva
#  secretos. Guía completa: docs/DESPLIEGUE.md
# ============================================================================

# ---------------------------------------------------------------- etapa 1: build
FROM node:22-alpine AS build

WORKDIR /app

# Dependencias primero: si no cambian, Docker reutiliza esta capa (build rápido).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Se pueden sobrescribir sin tocar el archivo:
#   docker build --build-arg PHYTO_WHATSAPP_NUMBER=18091234567 .
#   docker build --build-arg SEO_SITE_URL=https://phytoemagry.com .
ARG PHYTO_WHATSAPP_NUMBER="18297853794"
ARG SEO_SITE_URL=""
# `/api/crm` es la ruta del API que ya trae esta imagen (mismo dominio): así los
# contactos quedan guardados en /data/phytoemagry.sqlite sin configurar nada. Si
# prefieres otro CRM (Sheets, Make, tu propio backend), pásale su URL completa.
ARG PHYTO_CRM_ENDPOINT="/api/crm"
ARG PHYTO_META_PIXEL_ID=""
ARG CONTACT_EMAIL=""
ARG APP_ENV="production"
ENV PHYTO_WHATSAPP_NUMBER=$PHYTO_WHATSAPP_NUMBER \
    SEO_SITE_URL=$SEO_SITE_URL \
    PHYTO_CRM_ENDPOINT=$PHYTO_CRM_ENDPOINT \
    PHYTO_META_PIXEL_ID=$PHYTO_META_PIXEL_ID \
    CONTACT_EMAIL=$CONTACT_EMAIL \
    APP_ENV=$APP_ENV

# Verificación + build. Si algo no cuadra (precios, fotos que faltan, número de
# atención incoherente o tests en rojo) la imagen NO se construye: nunca se
# publica una web rota.
RUN npm run verify

# ------------------------------------------- etapa 2: dependencias de ejecución
# Solo lo que necesita el API en marcha (hoy: `pg`, el cliente de PostgreSQL).
# Las de desarrollo (esbuild, vitest, jsdom) se quedan en la etapa de build: la
# imagen final no las lleva.
FROM node:22-alpine AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------- etapa 3: nginx + API del CRM
FROM node:22-alpine AS runtime

# nginx sirve la web (estática, rápida) y delante del API que guarda los datos.
RUN apk add --no-cache nginx

# Puerto de escucha de la web. 80 por defecto para `docker run -p 8080:80`.
# Los paneles (Easypanel, Dokploy, Coolify...) suelen definir `PORT` en tiempo de
# ejecución: si lo hacen, nginx escucha ahí y solo hay que poner ese mismo número
# en el puerto del proxy/dominio. Ver docs/DESPLIEGUE.md.
ENV PORT=80 \
    PHYTO_CRM_PORT=8787 \
    PHYTO_CRM_HOST=127.0.0.1 \
    PHYTO_CRM_DATA=/data/phytoemagry.sqlite \
    PHYTO_CRM_DATABASE_URL="" \
    PHYTO_CRM_TOKEN=""

# Config de nginx, escrita aquí mismo: este Dockerfile no depende de ningún otro
# archivo de configuración. (Para un servidor con nginx del sistema, el
# equivalente está en nginx/phytoemagry.conf.)
#
# La plantilla es la configuración COMPLETA de nginx (no un trozo para incluir):
# el entrypoint le fija el puerto y la escribe como /etc/nginx/nginx.conf. Se
# sustituye solo ${PORT}, así que $uri, $host y compañía quedan intactos.
COPY <<'NGINX_CONF' /etc/nginx/templates/default.conf.template
worker_processes auto;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /dev/stdout;
    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    server_tokens off;
    client_max_body_size 256k;

    server {
        listen ${PORT};
        listen [::]:${PORT};
        server_name _;

        root /usr/share/nginx/html;
        index index.html;
        charset utf-8;

        # -------------------------------------------------------- seguridad
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
        # HSTS: descomentar cuando el HTTPS funcione delante (proxy/certificado).
        # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        # CSP: pega aquí el valor de dist/csp-header.txt (se genera en cada build).
        # add_header Content-Security-Policy "default-src 'self'; ..." always;

        # ------------------------------------------------------ compresión
        gzip on;
        gzip_vary on;
        gzip_comp_level 6;
        gzip_min_length 512;
        gzip_types text/plain text/css text/xml application/javascript application/json application/xml image/svg+xml;

        # -------------------------------------------------- API del CRM (Node)
        # Guarda los `lead` y los `order_intent` en PostgreSQL
        # (PHYTO_CRM_DATABASE_URL) o, si no hay, en /data/phytoemagry.sqlite.
        # `^~` evita que lo capturen las reglas de abajo (map/md/json).
        location ^~ /api/ {
            proxy_pass http://127.0.0.1:8787;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # --------------------------------------------- app del panel (PWA)
        # El negocio la instala en el móvil. Los archivos son estáticos, pero
        # nunca se cachean: publicar tiene que verse al instante.
        #
        # `/panel` es el enlace antiguo (llevaba la clave en la URL): se
        # redirige a `/admin/`, que pide la clave una vez y guarda la sesión.
        # OJO: un solo `location = /panel` por servidor; dos iguales hacen que
        # nginx aborte con `duplicate location` y el contenedor no arranca.
        location = /panel { return 302 /admin/; }

        location ^~ /admin/ {
            try_files $uri $uri/ /admin/index.html;
            expires -1;
            add_header X-Content-Type-Options "nosniff" always;
            add_header X-Frame-Options "DENY" always;
            add_header Referrer-Policy "strict-origin-when-cross-origin" always;
            add_header X-Robots-Tag "noindex, nofollow" always;
            add_header Service-Worker-Allowed "/admin/" always;
        }

        # ----------------------------------------------------------- rutas
        # Páginas legales: /privacidad y /terminos (sin .html)
        location = /privacidad { try_files /privacidad.html =404; }
        location = /terminos   { try_files /terminos.html   =404; }

        # Assets con hash de contenido: caché inmutable de 1 año
        location /assets/ {
            add_header Cache-Control "public, max-age=31536000, immutable" always;
            access_log off;
            try_files $uri =404;
        }

        # Imágenes y fuentes sin hash: caché de 30 días
        location ~* \.(?:png|jpe?g|webp|avif|svg|ico|woff2?)$ {
            add_header Cache-Control "public, max-age=2592000" always;
            access_log off;
            try_files $uri =404;
        }

        # El HTML y los archivos de SEO nunca se cachean (publicar = ver el cambio ya)
        location ~* \.(?:html|xml|txt)$ {
            add_header Cache-Control "no-cache, must-revalidate" always;
        }

        location / {
            try_files $uri $uri/ =404;
            add_header Cache-Control "no-cache, must-revalidate" always;
        }

        # Endurecimiento básico
        location ~ /\.(?!well-known) { deny all; }
        location ~* \.(?:map|md|json)$ { deny all; }
    }
}
NGINX_CONF

# Entrypoint: prepara la carpeta de datos, escribe el puerto real en la config de
# nginx y arranca los dos procesos (API del CRM + nginx, que se queda en primer
# plano para que el contenedor siga vivo y reciba las señales).
COPY <<'ENTRYPOINT' /usr/local/bin/entrypoint.sh
#!/bin/sh
set -e

: "${PORT:=80}"
: "${PHYTO_CRM_DATA:=/data/phytoemagry.sqlite}"

mkdir -p "$(dirname "$PHYTO_CRM_DATA")" /var/lib/nginx /var/log/nginx

# La plantilla es la configuración completa de nginx: solo hay que fijar el puerto.
sed "s/\${PORT}/${PORT}/g" /etc/nginx/templates/default.conf.template > /etc/nginx/nginx.conf

# API del CRM en segundo plano. `--experimental-sqlite` habilita la base de datos
# incluida en Node (en versiones más nuevas el flag se acepta igual y sobra).
node --experimental-sqlite /app/server/crm-server.mjs &

# nginx en primer plano: es el proceso principal del contenedor.
exec nginx -g 'daemon off;'
ENTRYPOINT

# CRLF → LF (por si el build se lanza desde un Windows con saltos de línea CRLF).
RUN tr -d '\015' < /etc/nginx/templates/default.conf.template > /tmp/conf \
    && mv /tmp/conf /etc/nginx/templates/default.conf.template \
    && tr -d '\015' < /usr/local/bin/entrypoint.sh > /tmp/entrypoint \
    && mv /tmp/entrypoint /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data

# Solo los archivos generados (+ el servidor del API y sus dependencias): ni
# fuentes, ni tests, ni las dependencias de desarrollo.
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/server /app/server
# La app del panel también viaja al API: así funciona aunque no haya nginx
# delante (desarrollo, pruebas) y no depende de una ruta del host.
COPY --from=build /app/dist/admin /app/admin
# `src/config` lo importa el API en tiempo de ejecución (el catálogo de precios
# oficial, `server/crm-server.mjs` → `../src/config/product.config.js`). Sin
# esto, la imagen construye y los tests pasan, pero el contenedor NO ARRANCA
# (ERR_MODULE_NOT_FOUND) y Swarm hace rollback: pasó en producción el 30/09.
COPY --from=build /app/src /app/src
COPY --from=runtime-deps /app/node_modules /app/node_modules

# Guarda de RUNTIME: comprueba que el API puede resolver TODOS sus imports
# dentro de esta imagen final (no solo que compila). `import()` aquí no arranca
# el servidor ni toca la base de datos: `isEntryPoint` es falso al venir de
# `node -e`, así que solo se recorre el grafo de módulos. Si falta algo
# (por ejemplo `src/`), el BUILD falla en vez de fallar en el despliegue.
# (crm-server.mjs importa a los demás, así que este solo import basta.)
RUN node --input-type=module -e "await import('/app/server/crm-server.mjs')"

ENV PHYTO_ADMIN_DIR=/app/admin

# Los datos viven aquí: monta un volumen para que sobrevivan a las actualizaciones
# (Easypanel → Mounts → Volume → /data). Solo se usa si NO hay PostgreSQL
# configurado (PHYTO_CRM_DATABASE_URL): con Postgres, los datos están en el
# servidor de base de datos y este volumen sobra.
VOLUME ["/data"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
