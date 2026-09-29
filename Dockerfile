# syntax=docker/dockerfile:1
# ============================================================================
#  Phytoemagry — imagen de producción (este archivo es TODO el despliegue)
#
#  No hace falta copiar nada a mano ni instalar Node en el servidor: el
#  Dockerfile compila la web y sirve el resultado con nginx.
#
#  EN EL SERVIDOR (2 comandos):
#    git clone https://github.com/JUNIORPRUEVA/phytoemagrywed.git
#    cd phytoemagrywed && docker build -t phytoemagry . && docker run -d \
#      --name phytoemagry -p 8080:80 --restart unless-stopped phytoemagry
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
#    Environment: PHYTO_WHATSAPP_NUMBER, SEO_SITE_URL, ... (llegan al build)
#
#  NOTA: el Dockerfile necesita el CÓDIGO del proyecto (src/, public/,
#  package.json...), que ya viaja en el repositorio. No es un archivo suelto:
#  `docker build` se ejecuta sobre la carpeta del proyecto.
#
#  Los valores de abajo son PÚBLICOS: acaban en el HTML/JS que recibe el
#  navegador (el número de WhatsApp se ve en la página). Esta imagen no lleva
#  ningún secreto. Guía completa: docs/DESPLIEGUE.md
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
ARG PHYTO_CRM_ENDPOINT=""
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

# ---------------------------------------------------------------- etapa 2: nginx
FROM nginx:1.27-alpine AS runtime

# Puerto de escucha. 80 por defecto para `docker run -p 8080:80`.
# Los paneles (Easypanel, Dokploy, Coolify...) suelen definir `PORT` en tiempo de
# ejecución: si lo hacen, nginx escucha ahí y solo hay que poner ese mismo número
# en el puerto del proxy/dominio. Ver docs/DESPLIEGUE.md.
ENV PORT=80

# Config del servidor web, escrita aquí mismo: este Dockerfile no depende de
# ningún otro archivo de configuración. (Para un servidor con nginx del sistema,
# el equivalente está en nginx/phytoemagry.conf.)
#
# Se guarda como PLANTILLA: el entrypoint oficial de nginx sustituye ${PORT} al
# arrancar (solo variables de entorno, así que $uri, $host y compañía quedan
# intactos).
COPY <<'NGINX_TEMPLATE' /etc/nginx/templates/default.conf.template
server {
    listen ${PORT};
    listen [::]:${PORT};
    server_name _;

    root /usr/share/nginx/html;
    index index.html;
    charset utf-8;

    # ------------------------------------------------------------ seguridad
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    # HSTS: descomentar cuando el HTTPS funcione delante (proxy/certificado).
    # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    # CSP: pega aquí el valor de dist/csp-header.txt (se genera en cada build).
    # add_header Content-Security-Policy "default-src 'self'; ..." always;

    # ---------------------------------------------------------- compresión
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 512;
    gzip_types text/plain text/css text/xml application/javascript application/json application/xml image/svg+xml;

    # --------------------------------------------------------------- rutas
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
NGINX_TEMPLATE

# CRLF → LF (por si el build se lanza desde un Windows con saltos de línea CRLF).
RUN tr -d '\015' < /etc/nginx/templates/default.conf.template > /tmp/conf \
    && mv /tmp/conf /etc/nginx/templates/default.conf.template

# Solo los archivos generados: ni fuentes, ni tests, ni node_modules.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
