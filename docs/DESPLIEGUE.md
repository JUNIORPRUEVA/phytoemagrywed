# Despliegue con Docker

Guía completa para publicar la landing en un servidor. La imagen es un sitio
estático generado en el build (esbuild) y servido por **nginx**: no hay base de
datos, ni proceso Node en producción, ni secretos dentro de la imagen.

- Repositorio: `https://github.com/JUNIORPRUEVA/phytoemagrywed.git`
- Dockerfile: raíz del proyecto (dos etapas: build + nginx). **Lleva dentro la configuración del servidor web**, así que no hay que copiar ningún archivo de configuración a mano
- Compose: `docker-compose.yml` (opcional pero recomendado: trae los valores y el healthcheck)
- `nginx/phytoemagry.conf`: la misma configuración, para un servidor con nginx del sistema (sin Docker)
- **Easypanel**: ver §3 (no hace falta terminal: el panel clona, construye y da el HTTPS)

> **Requisito**: Docker 23 o superior (2019+ con Compose v2). Comprueba con
> `docker --version`. Si tienes uno más antiguo, arranca el build con
> `DOCKER_BUILDKIT=1 docker build -t phytoemagry .`.

---

## 1. Lo que hace la imagen

| Etapa | Qué pasa |
| --- | --- |
| `build` (node:22-alpine) | `npm ci` → `npm run verify:deploy` (**revisión de contenido + build**) |
| `runtime` (node:22-alpine + nginx) | nginx sirve `dist/` y el **API del CRM** (`server/crm-server.mjs`) guarda los pedidos y los contactos en **PostgreSQL** (`PHYTO_CRM_DATABASE_URL`) o, si no hay, en SQLite (`/data/phytoemagry.sqlite`). Dentro del contenedor corren dos procesos: nginx (el principal) y Node |

Si los tests fallan, falta una foto de frasco, un precio no cuadra o el número de
atención no coincide, **la imagen no se construye**: no se puede publicar una web
rota por accidente.

Tamaño aproximado de la imagen final: ~180 MB (Node + nginx; el API usa
`node:sqlite`, que ya viene dentro de Node y no añade ninguna librería). Peso real
de la página: ~150 kB al cargar (todo lo demás se carga en diferido).

> **Los datos NO van dentro de la imagen**: con `PHYTO_CRM_DATABASE_URL` viven en
> el servidor de base de datos (lo recomendado); sin esa variable, en el volumen
> `/data`. Si usas SQLite y no montas el volumen, cada actualización empieza con
> la base de datos vacía.

---

## 2. Despliegue en el servidor (recomendado: Compose)

```bash
# 1) Traer el proyecto
git clone https://github.com/JUNIORPRUEVA/phytoemagrywed.git
cd phytoemagrywed

# 2) (una vez) la clave para leer los pedidos y los contactos
echo "PHYTO_CRM_TOKEN=$(openssl rand -hex 24)" > .env

# 3) Construir y levantar (el primer build tarda unos minutos: instala y prueba)
docker compose up -d --build

# 4) Comprobar
docker compose ps          # debe decir "healthy"
curl -I http://localhost:8080
```

La web queda en **http://IP-del-servidor:8080** y el panel del negocio (mini-CRM)
en **`http://IP-del-servidor:8080/admin/`** (se entra con la clave
`PHYTO_CRM_TOKEN`; el enlace antiguo `/panel?token=…` también funciona y redirige).
Guía del panel: [`PANEL.md`](PANEL.md).

La clave del `.env` es `PHYTO_CRM_TOKEN`: guárdala, porque es lo único que impide
que un desconocido lea los teléfonos de tus clientes. Los datos (el volumen
`phytoemagry-data`) sobreviven a `docker compose up -d --build`.

### Copia de seguridad de los datos

```bash
docker run --rm -v phytoemagry-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/phytoemagry-datos.tar.gz -C /data .
```

(En Windows/PowerShell: cambia `-v "$PWD":/backup` por `-v "${PWD}:/backup"`.)

### Actualizar a la última versión

```bash
cd phytoemagrywed
git pull
docker compose up -d --build
```

Docker reutiliza las capas que no cambian, así que las siguientes veces es mucho
más rápido. El contenedor anterior se reemplaza sin cortar el servicio más de
unos segundos, y los datos se conservan en el volumen.

### Ver logs / parar

```bash
# Logs de nginx y del API del CRM (cada registro guardado sale aquí)
docker compose logs -f --tail=50

# Parar (los datos NO se pierden: están en el volumen)
docker compose down

# Parar Y borrar los datos (cuidado: irreversible)
docker compose down -v
```

---

## 3. Easypanel (con el panel, sin terminal)

Si tu servidor ya tiene Easypanel, este es el camino más rápido: el panel clona
el repositorio, construye la imagen y te da el HTTPS automático.

1. **Crear el servicio**: proyecto → **+ Service** → **App**.
2. **Source** → *Git*:
   - Repository: `https://github.com/JUNIORPRUEVA/phytoemagrywed.git`
   - Branch: `main`
3. **Build** → *Dockerfile*, con la ruta `Dockerfile` (está en la raíz del repo).
   El panel se encarga del `docker build`; no hay que escribir ningún comando.
4. **Environment** (variables públicas; se pasan al build y al runtime). Pega
   esto en la pestaña y cambia el dominio:

   ```bash
   PHYTO_WHATSAPP_NUMBER=18494240621
   SEO_SITE_URL=https://tudominio.com
   APP_ENV=production
   ```

   Opcionales (déjalas fuera si no las usas):

   ```bash
   PHYTO_META_PIXEL_ID=     # Meta Pixel (si no, sin medición publicitaria)
   CONTACT_EMAIL=           # email visible en el footer
   ```

   **La base de datos de los pedidos** (recomendado dejarlo así):

   ```bash
   PHYTO_CRM_TOKEN=pon-una-clave-larga-y-solo-tuya   # clave para entrar al panel /admin/
   PHYTO_CRM_DATABASE_URL=postgres://usuario:clave@servicio-db:5432/phytoemagry
   ```

   El endpoint ya apunta solo a `/api/crm` (el API que trae la imagen), así que no
   hay que definir nada más. Si algún día quieres enviar los datos a **otro** CRM,
   pon ahí su URL completa: `PHYTO_CRM_ENDPOINT=https://...`.

   > **Ojo con `PHYTO_CRM_ENDPOINT`**: si lo dejas declarado pero **vacío**, la web
   > no enviará nada al API (solo guardará en el navegador del visitante).
   > Bórralo o ponlo en `/api/crm`.

   | Variable | Para qué sirve | Si no la pones |
   | --- | --- | --- |
   | `PHYTO_WHATSAPP_NUMBER` | Número que recibe pedidos y consultas | Se usa el valor por defecto del Dockerfile (el número real) |
   | `SEO_SITE_URL` | Dominio final: activa `canonical`, `sitemap.xml` y la **vista previa con imagen** al compartir por WhatsApp | Se publica sin canonical ni sitemap |
   | `PHYTO_CRM_TOKEN` | Clave para entrar al panel `/admin/` (móvil) y para leer los datos en CSV | Se siguen guardando, pero **no se pueden consultar** |
   | `PHYTO_CRM_DATABASE_URL` | Base de datos PostgreSQL donde se guardan los pedidos y los contactos | Se usa SQLite en `/data/phytoemagry.sqlite` (necesita volumen) |
   | `APP_ENV` | `production` | `production` por defecto |

   > **No pongas `PORT`** salvo que el panel te lo pida (ver el punto 5). Tampoco
   > `WEB_PORT`: esa es solo para Docker Compose.
   >
   > Si escribes `SEO_SITE_URL=https://$(PRIMARY_DOMAIN)` (variable especial de
   > Easypanel), añade **antes** el dominio en la pestaña *Domains*: si la variable
   > queda a medias (`https://`), la web lo detecta y **no publica** un canonical
   > roto.

5. **Domains** → añade tu dominio y pon el **puerto del proxy = 80** (es donde
   escucha nginx). Easypanel emite el certificado Let's Encrypt por su cuenta.

   > **Si el panel define la variable `PORT`** (algunos paneles lo hacen), la
   > imagen escucha en ese puerto: pon **el mismo número** en el puerto del proxy.
   > Sin `PORT`, escucha en el 80. Nunca hay que tocar el Dockerfile.

6. **Mounts** → solo si NO usas PostgreSQL: añade un **Volume** montado en
   **`/data`** (ahí vive el archivo de SQLite). Con `PHYTO_CRM_DATABASE_URL`
   configurado, la base de datos está fuera del contenedor y no hace falta.
7. **Deploy**.

Cuando termine, abre **`https://tudominio.com/admin/`** en tu móvil, escribe la
clave y añádela a la pantalla de inicio: ahí están los pedidos, los contactos, los
recordatorios y los mensajes para clientes (ver [`PANEL.md`](PANEL.md)).
Cada vez que hagas `git push`, en Easypanel solo tienes que pulsar **Deploy**
(o activar el *auto deploy* del servicio). Los datos no se tocan.

---

## 4. Sin Compose (con `docker` a secas)

```bash
docker build -t phytoemagry .
docker run -d --name phytoemagry \
  -p 8080:80 \
  -v phytoemagry-data:/data \
  -e PHYTO_CRM_TOKEN=pon-una-clave-larga-y-solo-tuya \
  --restart unless-stopped \
  phytoemagry
```

Sin `-v phytoemagry-data:/data` funciona igual, pero los pedidos y los contactos
se pierden en cuanto recrees el contenedor. Sin `-e PHYTO_CRM_TOKEN` se siguen
guardando, pero no se pueden leer en `/panel`.

---

## 5. Cambiar los datos públicos (número, dominio, pixel…)

Todas las variables de la web son **públicas** (acaban en el HTML/JS): no hay
secretos que proteger y por eso viajan como *build args*. El API del CRM es la
excepción: `PHYTO_CRM_TOKEN` se pasa **en tiempo de ejecución** (`-e` / Environment
del panel) y nunca se escribe en el build.

| Variable | Para qué | Valor actual |
| --- | --- | --- |
| `PHYTO_WHATSAPP_NUMBER` | Número que recibe pedidos y consultas | `18494240621` |
| `SEO_SITE_URL` | Dominio final (activa canonical, sitemap y la vista previa con imagen al compartir). Sin barra al final | vacío |
| `PHYTO_CRM_ENDPOINT` | Endpoint del CRM (ver `CRM-CONTRACT.md`) | `/api/crm` (el API que trae la imagen) |
| `PHYTO_META_PIXEL_ID` | Píxel de Meta (medición de anuncios). **Se incrusta en el build**: necesita Deploy, no solo reinicio | vacío |
| `PHYTO_META_CAPI_ACCESS_TOKEN` | **Secreto** de la API de conversiones (enviar la venta desde el servidor). Solo en Environment, nunca en el repositorio | vacío |
| `PHYTO_META_CAPI_TEST_EVENT_CODE` | Código `TEST…` para ver eventos en vivo. **En producción debe quedar vacío** (con `APP_ENV=production` se ignora igualmente) | vacío |
| `PHYTO_META_GRAPH_VERSION` | Versión de la Graph API (opcional) | `v21.0` |
| `PHYTO_META_PURCHASE_STATUS` | Estado del CRM que cuenta como venta | `entregado` |
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

## 6. Dominio y HTTPS

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

## 7. Comprobaciones después de publicar

```bash
# La página responde y trae el número real de WhatsApp
curl -s http://localhost:8080 | grep -o 'wa.me/[0-9]*' | sort -u

# Los archivos de SEO están
curl -sI http://localhost:8080/robots.txt
curl -sI http://localhost:8080/sitemap.xml   # solo si SEO_SITE_URL está puesto

# Caché correcta de los assets (1 año, immutable)
curl -sI http://localhost:8080/assets/ | head -3

# La base de datos de pedidos y contactos está viva (sin datos personales)
# `storage` dice dónde se está guardando: postgres o sqlite
curl -s http://localhost:8080/api/health
# → {"ok":true,"storage":"postgres","items":0}

# Leer los datos con la clave (debe responder 401 si la clave es incorrecta)
curl -s "http://localhost:8080/api/crm/items?token=LA-CLAVE" | head -c 200

# El panel del negocio y su app instalable
curl -sI http://localhost:8080/admin/            # 200 + X-Robots-Tag: noindex
curl -s  http://localhost:8080/admin/manifest.json | head -c 120
```

Y en el navegador, la prueba que importa: pulsar **Pedir por WhatsApp** en un
frasco y ver que el chat abre con el pedido escrito y el número correcto.
Después, **hacer un pedido de prueba** desde el móvil y comprobar que aparece en
`/panel?token=...` (y borrarlo luego con `DELETE` directo al SQLite si quieres
dejarlo limpio: `docker exec -it phytoemagry node -e "..."`, o simplemente
ignorarlo: los registros de prueba no molestan).

---

## 8. Problemas típicos

| Síntoma | Causa y solución |
| --- | --- |
| El contenedor arranca y se reinicia solo | Mira `docker compose logs web`; si es un error de sintaxis de nginx, la config está mal montada: `docker compose config` para validar el compose |
| La web carga pero **no aparece ningún botón de WhatsApp** | La imagen se construyó sin número: reconstruye con `--build-arg PHYTO_WHATSAPP_NUMBER=...` o revisa el `.env` del compose |
| Al cambiar una variable no veo el cambio | Hay que reconstruir: `docker compose up -d --build` (los valores van dentro del HTML) |
| El build falla en `npm run verify:deploy` | Es intencionado: hay un precio incoherente, una foto que falta, un número de atención que no coincide o un error de build. El propio mensaje dice qué arreglar |
| Error raro al leer el Dockerfile (`unknown instruction`, heredoc) | Docker demasiado antiguo: `DOCKER_BUILDKIT=1 docker build -t phytoemagry .` o actualiza Docker (`docker --version` debe ser 23 o superior) |
| Easypanel: el dominio responde **502** o "no hay servicio escuchando" | El **puerto del proxy** no es el que usa la app. Por defecto es **80**; si el panel define la variable `PORT`, pon ese mismo número en el dominio (`docker logs` lo confirma: nginx registra en qué puerto escucha) |
| Quiero ver la web sin publicar | `docker run --rm -p 8080:80 phytoemagry` en tu máquina, o `npm run preview` en local |
| `/panel` responde **401** «La clave no es correcta» | La clave del enlace no es la de `PHYTO_CRM_TOKEN`. Cópiala del `.env` (o del panel de Easypanel) y vuelve a entrar |
| `/panel` responde **503** «Para leer los datos define PHYTO_CRM_TOKEN» | No has puesto la variable: los datos SÍ se están guardando, solo hace falta la clave para leerlos. Define `PHYTO_CRM_TOKEN` y reinicia |
| `/api/health` responde 404 o 502 | El API del CRM no está arrancado o nginx no lo encuentra. `docker logs` debe mostrar `[crm] escuchando en http://127.0.0.1:8787`. Si no aparece, revisa que el contenedor use el `ENTRYPOINT` del Dockerfile (no lo sobrescribas con `command:`) |
| `/panel` **funciona pero está vacío tras un Deploy** | No montaste el volumen en `/data`: la base de datos se recrea con la imagen. Añade Mounts → Volume → `/data` |
| El panel dice «**El CRM no está respondiendo en el puerto 8787**» | El proceso Node del API no está vivo (o no es el de este contenedor). En local: arranca `npm run dev` (que ya levanta el CRM) o `npm run crm`. En el servidor: `docker logs` debe mostrar `[crm] escuchando en http://127.0.0.1:8787`; si no, el `ENTRYPOINT` del Dockerfile se está sobrescribiendo |
| El píxel no dispara (`PageView` y nada más) | Falta `PHYTO_META_PIXEL_ID` en el **build** (los valores públicos van dentro del HTML). Con `tracking.consentRequired: true` podría ser que el visitante no haya aceptado el aviso; hoy NO hay aviso. Si el panel muestra `meta.configured: false`, falta además el token de CAPI |
| `Purchase` nunca llega a Meta | El pedido no está en `entregado` (o en el estado de `PHYTO_META_PURCHASE_STATUS`), o el token de CAPI no está definido. La ficha del pedido dice `sent` / `failed` / pendiente y permite reenviar |
| Los eventos aparecen en *Probar eventos* pero no cuentan en los informes | El `PHYTO_META_CAPI_TEST_EVENT_CODE` sigue puesto en ese entorno: déjalo vacío en producción |
| El panel dice «**El panel no está conectado con el CRM (respuesta 404)**» | Estás entrando por un servidor que sirve el panel pero no reenvía `/api/` (típico: abrir `dist/admin/` con un servidor de ficheros). Entra por el dominio de la web o por `http://localhost:5173/admin/` |
| El píxel no dispara (`PageView` y nada más) | Falta `PHYTO_META_PIXEL_ID` en el **build** (los valores públicos van dentro del HTML). Con `tracking.consentRequired: true` podría ser que el visitante no haya aceptado el aviso; hoy NO hay aviso. Si el panel muestra `meta.configured: false`, falta el token de CAPI |
| `Purchase` nunca llega a Meta | El pedido no está en `entregado` (o en el estado de `PHYTO_META_PURCHASE_STATUS`), o el token de CAPI no está definido. La ficha del pedido en el panel dice `sent` / `failed` / pendiente y permite reenviar |
| Los eventos aparecen en *Probar eventos* pero no cuentan | El `PHYTO_META_CAPI_TEST_EVENT_CODE` sigue puesto en ese entorno: déjalo vacío en producción |
| El **despliegue falla** y el contenedor nuevo sale con código 1: `nginx: [emerg] duplicate location ...` | Hay dos bloques `location` iguales en la config de nginx: nginx se niega a arrancar y Swarm deja la versión vieja sirviendo (el panel nuevo nunca aparece). Quita el duplicado (`tests/render.test.js` lo detecta antes de subir) y vuelve a desplegar |
| `/api/health` dice `"storage":"sqlite"` aunque hay `PHYTO_CRM_DATABASE_URL` | PostgreSQL rechazó el usuario (clave distinta entre la base y la variable) y el CRM siguió guardando en SQLite para no perder pedidos. Los logs del contenedor lo dicen con todas las letras. Alinea la clave: `ALTER ROLE <usuario> WITH LOGIN PASSWORD '<la del servicio>'` en la base, y reinicia el servicio |
| Tras un `Deploy`, la **web va pero el panel sale vacío** con pedidos ya hechos | Falta `PHYTO_CRM_ENDPOINT` en el **build** (los valores públicos van dentro del HTML): la imagen trae `/api/crm` por defecto; si lo pasaste vacío, los pedidos solo quedaron en la cola del navegador. Reconstruye con `PHYTO_CRM_ENDPOINT=/api/crm` |

---

## 9. Alternativa sin Docker

```bash
npm ci
npm run verify      # tests + revisión + build
npm run verify:deploy # revisión + build (lo que usa EasyPanel)
# copiar dist/ a /var/www/phytoemagry y usar nginx/phytoemagry.conf
# (cambiando `root` y `server_name` como indica el propio archivo)

# Y, si quieres la base de datos de pedidos y contactos, el API en paralelo:
PHYTO_CRM_TOKEN=una-clave-larga npm run crm
```

Sin el API, la web sigue funcionando: los pedidos y los contactos llegan a
WhatsApp como siempre (y quedan en la cola local del navegador si el envío falla).
Lo único que se pierde es el registro ordenado en el panel.
