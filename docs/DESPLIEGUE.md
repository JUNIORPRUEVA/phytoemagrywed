# Despliegue con Docker

Guía completa para publicar la landing en un servidor. La imagen es un sitio
estático generado en el build (esbuild) y servido por **nginx**: no hay base de
datos, ni proceso Node en producción, ni secretos dentro de la imagen.

- Repositorio: `https://github.com/JUNIORPRUEVA/phytoemagrywed.git`
- Dockerfile: raíz del proyecto (dos etapas: build + nginx). **Lleva dentro la configuración del servidor web**, así que no hay que copiar ningún archivo de configuración a mano
- Compose: `docker-compose.yml` (opcional pero recomendado: trae los valores y el healthcheck)
- `nginx/phytoemagry.conf`: la misma configuración, para un servidor con nginx del sistema (sin Docker)

> **Requisito**: Docker 23 o superior (2019+ con Compose v2). Comprueba con
> `docker --version`. Si tienes uno más antiguo, arranca el build con
> `DOCKER_BUILDKIT=1 docker build -t phytoemagry .`.

---

## 1. Lo que hace la imagen

| Etapa | Qué pasa |
| --- | --- |
| `build` (node:22-alpine) | `npm ci` → `npm run verify` (**tests + revisión de contenido + build**) |
| `runtime` (nginx:1.27-alpine) | nginx con la config escrita dentro del Dockerfile + solo `dist/`. Nada de Node, ni `node_modules`, ni fuentes |

Si los tests fallan, falta una foto de frasco, un precio no cuadra o el número de
atención no coincide, **la imagen no se construye**: no se puede publicar una web
rota por accidente.

Tamaño aproximado de la imagen final: ~50 MB. Peso real de la página: ~150 kB al
cargar (todo lo demás se carga en diferido).

---

## 2. Despliegue en el servidor (recomendado: Compose)

```bash
# 1) Traer el proyecto
git clone https://github.com/JUNIORPRUEVA/phytoemagrywed.git
cd phytoemagrywed

# 2) Construir y levantar (el primer build tarda unos minutos: instala y prueba)
docker compose up -d --build

# 3) Comprobar
docker compose ps          # debe decir "healthy"
curl -I http://localhost:8080
```

La web queda en **http://IP-del-servidor:8080**.

### Actualizar a la última versión

```bash
cd phytoemagrywed
git pull
docker compose up -d --build
```

Docker reutiliza las capas que no cambian, así que las siguientes veces es mucho
más rápido. El contenedor anterior se reemplaza sin cortar el servicio más de
unos segundos.

### Ver logs / parar

```bash
docker compose logs -f --tail=50
docker compose down          # parar (los datos no se pierden: no hay datos)
```

---

## 3. Sin Compose (con `docker` a secas)

```bash
docker build -t phytoemagry .
docker run -d --name phytoemagry \
  -p 8080:80 \
  --restart unless-stopped \
  phytoemagry
```

---

## 4. Cambiar los datos públicos (número, dominio, pixel…)

Todas las variables de la web son **públicas** (acaban en el HTML/JS): no hay
secretos que proteger y por eso viajan como *build args*.

| Variable | Para qué | Valor actual |
| --- | --- | --- |
| `PHYTO_WHATSAPP_NUMBER` | Número que recibe pedidos y consultas | `18297853794` |
| `SEO_SITE_URL` | Dominio final (activa canonical, sitemap y la vista previa con imagen al compartir). Sin barra al final | vacío |
| `PHYTO_CRM_ENDPOINT` | Endpoint del CRM (ver `CRM-CONTRACT.md`) | vacío |
| `PHYTO_META_PIXEL_ID` | Meta Pixel (medición publicitaria) | vacío |
| `CONTACT_EMAIL` | Email visible en el footer | vacío |
| `APP_ENV` | `production` (los logs de depuración solo salen en dev) | `production` |

Dos formas de cambiarlos, sin editar el Dockerfile:

```bash
# a) Por línea de comandos
docker build -t phytoemagry \
  --build-arg SEO_SITE_URL=https://phytoemagry.com \
  --build-arg PHYTO_META_PIXEL_ID=1234567890 .

# b) Con Compose: crea un archivo `.env` junto al docker-compose.yml
#    (no se sube al repositorio) y pon ahí las claves. Ejemplo:
#      SEO_SITE_URL=https://phytoemagry.com
#      WEB_PORT=8080
docker compose up -d --build
```

> **Importante**: al cambiar cualquier variable hay que **reconstruir** la imagen
> (`--build`), porque los valores se escriben dentro del HTML y del JS.

---

## 5. Dominio y HTTPS

El contenedor escucha en **HTTP:80** y acepta cualquier `Host`. El certificado se
gestiona **delante**, en el proxy del servidor. Dos caminos habituales:

### a) Nginx del sistema como reverse proxy

```nginx
server {
    listen 80;
    server_name phytoemagry.com www.phytoemagry.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Y el certificado con Certbot:

```bash
sudo certbot --nginx -d phytoemagry.com -d www.phytoemagry.com
```

Después de tener HTTPS, en el Dockerfile (bloque de la etapa `runtime`) puedes
descomentar la línea de **HSTS**.

### b) Traefik / otro proxy con certificados automáticos

Apunta el router al puerto `80` del contenedor (`web`) y deja que él gestione el
TLS.

Cuando el dominio funcione, ponlo también en `SEO_SITE_URL` y reconstruye: es lo
que activa el `canonical`, el `sitemap.xml` y la **vista previa con imagen** al
compartir el enlace por WhatsApp.

---

## 6. Comprobaciones después de publicar

```bash
# La página responde y trae el número real de WhatsApp
curl -s http://localhost:8080 | grep -o 'wa.me/[0-9]*' | sort -u

# Los archivos de SEO están
curl -sI http://localhost:8080/robots.txt
curl -sI http://localhost:8080/sitemap.xml   # solo si SEO_SITE_URL está puesto

# Caché correcta de los assets (1 año, immutable)
curl -sI http://localhost:8080/assets/ | head -3
```

Y en el navegador, la prueba que importa: pulsar **Pedir por WhatsApp** en un
frasco y ver que el chat abre con el pedido escrito y el número correcto.

---

## 7. Problemas típicos

| Síntoma | Causa y solución |
| --- | --- |
| El contenedor arranca y se reinicia solo | Mira `docker compose logs web`; si es un error de sintaxis de nginx, la config está mal montada: `docker compose config` para validar el compose |
| La web carga pero **no aparece ningún botón de WhatsApp** | La imagen se construyó sin número: reconstruye con `--build-arg PHYTO_WHATSAPP_NUMBER=...` o revisa el `.env` del compose |
| Al cambiar una variable no veo el cambio | Hay que reconstruir: `docker compose up -d --build` (los valores van dentro del HTML) |
| El build falla en `npm run verify` | Es intencionado: hay un test en rojo, un precio incoherente, una foto que falta o un número de atención que no coincide. El propio mensaje dice qué arreglar |
| Error raro al leer el Dockerfile (`unknown instruction`, heredoc) | Docker demasiado antiguo: `DOCKER_BUILDKIT=1 docker build -t phytoemagry .` o actualiza Docker (`docker --version` debe ser 23 o superior) |
| Quiero ver la web sin publicar | `docker run --rm -p 8080:80 phytoemagry` en tu máquina, o `npm run preview` en local |

---

## 8. Alternativa sin Docker

```bash
npm ci
npm run verify      # tests + revisión + build
# copiar dist/ a /var/www/phytoemagry y usar nginx/phytoemagry.conf
# (cambiando `root` y `server_name` como indica el propio archivo)
```
