# ============================================================================
#  Phytoemagry — imagen de producción
#
#  Sitio estático generado en build (esbuild) y servido por nginx.
#  Etapa 1: compila y verifica el sitio (tests + revisión de contenido + build).
#  Etapa 2: solo nginx con los archivos ya generados (~50 MB menos de imagen).
#
#  Uso rápido:
#    docker build -t phytoemagry .
#    docker run -d --name phytoemagry -p 8080:80 --restart unless-stopped phytoemagry
#
#  O con compose (ya trae los valores y el reinicio automático):
#    docker compose up -d --build
#
#  Los valores de abajo son PÚBLICOS: acaban en el HTML/JS que recibe el
#  navegador (el número de WhatsApp se ve en la página). No pongas aquí ningún
#  secreto: esta imagen no lleva ninguno.
#  Guía completa: docs/DESPLIEGUE.md
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

# Config del contenedor (root en /usr/share/nginx/html, compresión, cachés y
# cabeceras de seguridad).
COPY nginx/phytoemagry.conf /etc/nginx/conf.d/default.conf

# Solo los archivos generados: ni fuentes, ni tests, ni node_modules.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
