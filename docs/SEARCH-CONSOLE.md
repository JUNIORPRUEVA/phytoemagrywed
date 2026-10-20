# Google Search Console — auditoría y plan de integración

Fecha: 2026-10-20 · Estado: **implementado en modo mock, sin credenciales, sin despliegue**

## 1. Resumen ejecutivo

| Pregunta | Respuesta |
| --- | --- |
| ¿Hace falta una clave JSON? | **Sí**, para un servidor externo. La autenticación sin clave no es viable en este VPS sin montar una infraestructura de identidad propia más costosa que la clave. |
| ¿Dónde debe correr? | **En el backend** (lecturas programadas o bajo demanda). Localmente solo para diagnóstico con `--mock` o con la cuenta de un operador. |
| ¿Qué se implementó? | `server/search-console.mjs` (cliente de solo lectura + auditoría SEO) y `scripts/search-console.mjs` (CLI). 21 pruebas con credenciales simuladas. |
| ¿Se puede enviar el sitemap? | **NO**. La auditoría real de `https://fulltechrd.com` falla en 3 puntos (ver §7). El envío está bloqueado por doble interruptor. |
| ¿Se tocó producción? | No. Solo lecturas HTTP públicas para la auditoría y pruebas locales. |

## 2. ¿Local, backend o ambos?

**Backend.** Los datos de Search Console son del negocio, no del portátil de nadie:

- La integración necesita ejecutarse cuando el equipo no está conectado (informes semanales, alertas de sitemap con errores, URLs que pasan a `noindex`).
- Una credencial en un portátil hay que copiarla, sincronizarla y revocarla a mano; en el servidor tiene un único dueño y una única rotación.
- El servidor ya es el origen canónico del sitio (`fulltechrd.com`), así que la verificación de propiedad y de canonical se comparan contra el mismo sitio que ve Google.

**Local solo para dos cosas concretas:** `--mock` (desarrollo, cero credenciales) y `audit` contra el dominio (HTTP público, sin credenciales). No se debe instalar la clave de producción en un equipo personal.

## 3. Evaluación de autenticación sin clave (keyless)

Google solo acepta credenciales sin clave cuando la identidad del proceso la emite una plataforma en la que confía:

| Mecanismo | ¿Aplica a este VPS? | Por qué |
| --- | --- | --- |
| Cuenta de servicio adjunta a la instancia (GCE/GKE/Cloud Run) | **No** | El servidor no es de Google Cloud; no hay servidor de metadatos `metadata.google.internal`. |
| Workload Identity Federation con AWS/Azure | **No** | El VPS no está en AWS ni Azure; no hay identidad de nube que federar. |
| Workload Identity Federation con OIDC propio | **Técnicamente sí, en la práctica no** | Exigiría publicar un emisor OIDC con JWKS estable, canjear el token en STS de Google y custodiar la clave de firma de ese emisor. Esa clave viviría en el mismo VPS: un compromiso del servidor compromete igual el emisor y el token. Se añadiría complejidad sin ganar seguridad. |
| OIDC de GitHub Actions | **No** | Solo sirve para CI, no para un servicio en ejecución. |
| `gcloud auth application-default login` (ADC de usuario) | **No recomendado** | Es una credencial personal de una cuenta humana con refresh token en disco, depende de MFA y de que esa persona siga en la empresa. No es rotable ni auditable como una cuenta de servicio. |
| **Clave JSON de cuenta de servicio** | **Sí** | Es el único método que funciona en un VPS neutro, permite rotación, revocación y alcance mínimo. |

**Conclusión:** keyless no es práctico aquí. La clave JSON **es necesaria**.

Mitigaciones obligatorias al usar clave:

1. Alcance de solo lectura: `https://www.googleapis.com/auth/webmasters.readonly` (ya es el único que usa el módulo).
2. Una cuenta de servicio dedicada (`fulltech-seo@…`) usada solo por esta integración, no compartida con otros servicios.
3. La clave se guarda **fuera de Git** y con el menor número de copias posible (ver §5).
4. Rotación cada 90 días: crear clave nueva → desplegar → verificar → borrar la anterior.
5. La clave nunca se registra: el módulo no imprime credenciales, y las pruebas lo comprueban.

## 4. Qué se implementó (módulos aislados)

| Archivo | Contenido |
| --- | --- |
| `server/search-console.mjs` | Proveedor de token (JWT RS256 con `node:crypto`, sin dependencias), cliente de Search Console (`listSites`, `verifyAccess`, `searchAnalytics`, `listSitemaps`, `inspectUrl`), `submitSitemap` **bloqueado**, lector de configuración, transporte mock y `auditSeoReadiness`. No importa nada del CRM. |
| `scripts/search-console.mjs` | CLI con `config`, `access`, `analytics`, `sitemaps`, `inspect`, `audit`, `submit-sitemap`. `--mock` para datos simulados, `--env-file` para leer un `.env`. |
| `tests/search-console.test.js` | 21 pruebas: firma y verificación del JWT con un par RSA generado en memoria (nunca en el repo), caché de token, codificación de la propiedad, errores 401/403/429, bloqueo de escritura, lectura de credenciales y auditoría SEO. |

**Prueba de que funciona con credenciales simuladas:**

```
node scripts/search-console.mjs access --mock      → permissionLevel siteFullUser
node scripts/search-console.mjs analytics --mock   → 2 filas de rendimiento
node scripts/search-console.mjs sitemaps --mock    → 1 sitemap, 0 errores
node scripts/search-console.mjs inspect --mock     → verdict PASS
node scripts/search-console.mjs submit-sitemap --mock → ✖ bloqueado (exit 2)
```

Ninguna de esas ejecuciones usa la red de Google: el transporte mock responde en memoria.

## 5. Variables de entorno (nombres exactos)

```dotenv
# Interruptor principal. Valores: disabled | service_account | mock
PHYTO_GSC_AUTH_MODE=disabled

# Propiedad EXACTA tal como aparece en Search Console.
# Para una propiedad de dominio empieza por sc-domain:
PHYTO_GSC_SITE_URL=sc-domain:fulltechrd.com

# Cuenta de servicio (no es secreta, sirve para verificar que la clave coincide)
PHYTO_GSC_SERVICE_ACCOUNT_EMAIL=fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com

# Credencial: elige UNA de las dos
PHYTO_GSC_KEY_FILE=/etc/fulltech/gsc-service-account.json
# PHYTO_GSC_KEY_JSON={"type":"service_account",...}

# Opcionales
PHYTO_GSC_TIMEOUT_MS=15000

# Doble interruptor de escritura. Los DOS deben ser 1 para enviar sitemaps.
PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=0
PHYTO_GSC_SEO_AUDIT_OK=0
```

Reglas del lector de configuración:

- `disabled` no toca la red y no lanza excepciones.
- `service_account` exige `PHYTO_GSC_SITE_URL` y una credencial; si falta algo, la integración queda **apagada** con la lista de problemas.
- Si `PHYTO_GSC_KEY_FILE` y `PHYTO_GSC_KEY_JSON` están los dos, gana el archivo y se avisa del conflicto.
- La cuenta de la clave debe coincidir con `PHYTO_GSC_SERVICE_ACCOUNT_EMAIL`; si no, error `gsc_key_mismatch` (evita una clave equivocada silenciosa).
- **No** aparecen en el repositorio: `.env` y `.env.local` ya están en `.gitignore`.

## 6. Despliegue seguro de la credencial en Easypanel

Dos opciones, de más a menos recomendable:

### Opción A — archivo montado (recomendada)

1. En Google Cloud: *IAM → Cuentas de servicio → `fulltech-seo` → Claves → Crear clave → JSON*. La descarga es la única copia; no la subas a Git ni a Drive.
2. En el VPS, fuera del árbol del proyecto:
   ```bash
   install -d -m 0750 /etc/fulltech
   # copiar el JSON con scp, nunca con echo/heredoc en la shell remota
   chmod 0400 /etc/fulltech/gsc-service-account.json
   chown root:root /etc/fulltech/gsc-service-account.json
   ```
3. En el servicio de EasyPanel, montar el archivo de solo lectura:
   - Origen (host): `/etc/fulltech/gsc-service-account.json`
   - Destino (contenedor): `/run/secrets/gsc-service-account.json`
   - Modo: solo lectura
4. Variables del servicio:
   ```
   PHYTO_GSC_AUTH_MODE=service_account
   PHYTO_GSC_SITE_URL=sc-domain:fulltechrd.com
   PHYTO_GSC_SERVICE_ACCOUNT_EMAIL=fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com
   PHYTO_GSC_KEY_FILE=/run/secrets/gsc-service-account.json
   PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=0
   PHYTO_GSC_SEO_AUDIT_OK=0
   ```
5. Verificar dentro del contenedor:
   ```bash
   docker service inspect <servicio> --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Source}} -> {{.Target}} readonly={{.ReadOnly}}{{println}}{{end}}'
   docker exec <contenedor> ls -l /run/secrets/gsc-service-account.json   # debe ser -r-------- o similar
   ```
   Si el montaje no aparece, la clave **no** está disponible y la integración queda apagada (falla cerrado).

### Opción B — JSON en variable de entorno

Aceptable si el panel no permite montar archivos, pero **peor**: la variable es visible en `docker inspect` y en los volcados de entorno del proceso (`/proc/<pid>/environ`). Si se usa:

- Pegar el JSON completo en una sola línea en `PHYTO_GSC_KEY_JSON` (los `\n` de la clave pueden ir escapados; el módulo los normaliza).
- Limitar el acceso al panel y a la API de Docker del servidor.
- Rotar la clave si alguien con acceso al host pudo leer el entorno.
- Preferir siempre la Opción A cuando esté disponible.

### Lo que NUNCA se hace

- Commitear el JSON, subirlo a `public/`, a un adjunto de WhatsApp o a un bucket público.
- Poner la clave en el frontend (`public/store/*`) o en un build de esbuild.
- Reutilizar la misma clave para otros servicios o para escritura.
- Activar `PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1` antes de la auditoría de §7.

## 7. Auditoría SEO real (evidencia del 2026-10-20)

Ejecutado contra producción, solo lecturas públicas:

```
node scripts/search-console.mjs audit --origin https://fulltechrd.com
```

**Resultado: NO-GO (3 bloqueos).**

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| `robots.txt` responde | OK | 200 |
| `robots.txt` permite rastreo | OK | `Allow: /` |
| `robots.txt` anuncia sitemap | **FALLA** | El archivo dice literalmente `# PENDIENTE: define SEO_SITE_URL para publicar el sitemap.` y no tiene línea `Sitemap:` |
| `sitemap.xml` válido | OK | 200, XML con 8 URLs |
| Sitemap del mismo origen | **FALLA** | Las URLs son `https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host/store/…` (host interno de EasyPanel) en vez de `https://fulltechrd.com/store/…` |
| Página `/store/` sin `noindex` | OK | Sin `meta robots` |
| Página `/store/` con canonical | **FALLA** | La portada de la tienda es la SPA y no declara `<link rel="canonical">` |
| Página de producto `/store/p/capsules_5` | **FALLA** | Responde con `noindex` y canonical hacia `https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host/…` |

Causas exactas en el código desplegado:

- `PHYTO_STORE_PUBLIC_URL` no está definida en el servicio, así que el origen del canonical y del sitemap se toma de la petición (`PHYTO_PUBLIC_URL` / host interno) → sale el dominio interno de EasyPanel.
- `PHYTO_STORE_INDEXABLE` no es `true` → todas las páginas de producto salen `noindex` por diseño (protección de entorno).
- `robots.txt` de la raíz lo genera `scripts/build.mjs` y solo publica `Sitemap:` cuando `SEO_SITE_URL` está definido.

**Orden correcto para desbloquear (ningún paso se puede saltar):**

1. `PHYTO_STORE_PUBLIC_URL=https://fulltechrd.com` en el servicio de la tienda (y reiniciar para que lo tome).
2. `SEO_SITE_URL=https://fulltechrd.com` en el build de la landing, para que `robots.txt` anuncie `https://fulltechrd.com/store/sitemap.xml`.
3. Publicar el contenido definitivo y revisar precios/descripciones (indexar borradores deja huella difícil de borrar).
4. `PHYTO_STORE_INDEXABLE=true` en el servicio (esto quita el `noindex` de las páginas de producto).
5. Volver a ejecutar `node scripts/search-console.mjs audit --origin https://fulltechrd.com --sample-path /store/p/<id>` hasta que **todo** salga `ok`.
6. Solo entonces: `PHYTO_GSC_SEO_AUDIT_OK=1` y `PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1`.
7. `node scripts/search-console.mjs submit-sitemap --sitemap https://fulltechrd.com/store/sitemap.xml`.

## 8. Uso diario (solo lectura)

```bash
node scripts/search-console.mjs config                 # diagnóstico sin secretos
node scripts/search-console.mjs access                 # ¿la cuenta ve la propiedad?
node scripts/search-console.mjs analytics --days 28 --limit 25
node scripts/search-console.mjs sitemaps               # estado, errores y avisos
node scripts/search-console.mjs inspect --url https://fulltechrd.com/store/p/<id>
node scripts/search-console.mjs audit --origin https://fulltechrd.com
```

Códigos de salida: `0` correcto, `1` fallo de datos (propiedad no visible, auditoría no pasa), `2` configuración incompleta o comando inválido. Todos los errores salen con su código (`gsc_forbidden`, `gsc_quota`, `gsc_sitemap_locked`…) y **sin** credenciales.

Cuotas de Google a tener en cuenta: URL Inspection está limitada a ~2000 inspecciones/día por propiedad y las consultas de rendimiento devuelven datos con 2–3 días de retraso. El cliente traduce 429 a `gsc_quota` con `retryAfter`.

## 9. Verificación antes de activar en producción

- [ ] `node scripts/search-console.mjs config` sin problemas y `modo: service_account`.
- [ ] `access` devuelve `permissionLevel: siteFullUser`.
- [ ] `analytics --days 7` devuelve filas (si devuelve 0, puede ser normal en un sitio aún sin clics).
- [ ] `inspect --url https://fulltechrd.com/store/p/<id>` responde `verdict` y `robotsTxtState: ALLOWED`.
- [ ] `audit` con **todas** las comprobaciones en `ok`.
- [ ] Los dos interruptores de escritura siguen en `0` hasta que el punto anterior esté verde.

## 10. Archivos y alcance del cambio

- Nuevos: `server/search-console.mjs`, `scripts/search-console.mjs`, `tests/search-console.test.js`, `docs/SEARCH-CONSOLE.md`.
- Modificados: **ninguno** de los existentes (`crm-server.mjs`, `store-seo*.mjs`, `package.json` intactos).
- Sin commit, sin push, sin despliegue, sin credenciales creadas, sin cambios en producción.

## 11. Activación real verificada (2026-10-20, servidor `srv902744` / 31.97.99.70)

Credencial instalada y validada contra Google **sin modificar el servicio de producción**.

### Propiedad real

`listSites` devolvió **una sola** propiedad:

```json
[{ "siteUrl": "sc-domain:fulltechrd.com", "permissionLevel": "siteFullUser" }]
```

El valor correcto de `PHYTO_GSC_SITE_URL` es **`sc-domain:fulltechrd.com`**. `sc-domain.com` (como se indicó en la solicitud) no existe como propiedad: con ese valor la API responde 403. `siteFullUser` equivale a acceso **Full**.

### Instalación en el servidor

| Elemento | Ruta | Permisos | Contenido |
| --- | --- | --- | --- |
| Credencial | `/etc/fulltech/gsc-service-account.json` | `0400 root:root` (directorio `0700`) | JSON del service account (SHA-256 `743b749813110248…`) |
| Configuración | `/etc/fulltech/gsc.env` | `0600 root:root` | Variables `PHYTO_GSC_*` (sin secretos) |
| Código | `/opt/fulltech-gsc/{server,scripts}` | `0700/0644` | Módulo + CLI (solo lectura en el contenedor) |
| Ejecutor | `/opt/fulltech-gsc/run.sh` | `0755` | `docker run --rm --env-file …` con montajes `:ro` |

La transferencia se hizo por `scp` sobre la clave SSH existente, aterrizó en `/root` (0700), se movió con `install -m 0400` y el archivo temporal se borró con `shred -u`.

### Pruebas de seguridad ejecutadas

| Prueba | Resultado |
| --- | --- |
| Credencial parseable dentro del contenedor | `type=service_account`, `email=fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com`, PEM válido de 29 líneas |
| Sobrescritura del archivo montado | `sh: can't create …: Read-only file system` |
| Integridad host ↔ contenedor | `sha256 = 743b749813110248` en ambos |
| Acceso por HTTP | `/gsc-service-account.json`, `/store/gsc-service-account.json`, `/etc/fulltech/gsc-service-account.json` → **403** (nginx, sin contenido) |
| La imagen no contiene la credencial | El JSON vive solo en `/etc/fulltech`; no se copió al contexto de build ni al runner |
| Repositorio | Sin cambios de Git; el JSON nunca entró al árbol de trabajo |

### Operaciones reales contra Google (todas correctas)

| Operación | Endpoint | Resultado |
| --- | --- | --- |
| `listSites` / `verifyAccess` | `GET /webmasters/v3/sites` | 1 propiedad, `siteFullUser`, `pending: false` |
| Search Analytics (28 días) | `POST …/searchAnalytics/query` | 200 OK, **0 filas** (el sitio aún no tiene impresiones registradas) |
| Sitemaps | `GET …/sitemaps` | 1 sitemap: `https://fullpos.fulltechrd.com/sitemap-index.xml`, enviado 2026-07-10, descargado 2026-08-31, **1 error y 3 avisos** |
| URL Inspection | `POST searchconsole.googleapis.com/v1/urlInspection/index:inspect` | `verdict: NEUTRAL`, `"Google no reconoce esta URL"` para `/store/` y `/store/p/capsules_5` |
| `submitSitemap` | `PUT …/sitemaps/{feed}` | **Bloqueado (exit 2)** por `PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=0` |

Latencia observada: ~0,8 s por invocación incluida la creación del contenedor. El token se cachea por proceso (1 h).

### Impacto en producción

- **Ninguno sobre el servicio en ejecución**: `ventas_phytoemagrywed` no se actualizó, no se reinició, no cambió su imagen, su entorno ni sus montajes.
- La validación corrió en contenedores **efímeros** (`docker run --rm`) de la misma imagen, con la credencial montada `:ro`.
- Respaldo del estado actual del servicio: `/root/phyto-deploy/backups/svc-ventas_phytoemagrywed-20261020T182234Z.json`.
- Rollback disponible si en el futuro se toca el servicio: `docker service rollback ventas_phytoemagrywed`.
- La imagen desplegada **no incluye** `server/search-console.mjs` (código sin commitear), así que conectar el CRM exige un despliegue real; por eso no se tocó el entorno del servicio.

### Uso en el servidor

```bash
/opt/fulltech-gsc/run.sh config
/opt/fulltech-gsc/run.sh access
/opt/fulltech-gsc/run.sh analytics --days 28 --limit 25
/opt/fulltech-gsc/run.sh sitemaps
/opt/fulltech-gsc/run.sh inspect --url https://fulltechrd.com/store/p/<id>
/opt/fulltech-gsc/run.sh audit --origin https://fulltechrd.com
```

### Hallazgos que bloquean el envío del sitemap (reconfirmados)

1. `robots.txt` de la raíz no anuncia `Sitemap:` (sigue el comentario `PENDIENTE: define SEO_SITE_URL`).
2. El `/store/sitemap.xml` publica URLs con el host interno `ventas-fulltech-tienda-pwa.gcdndd.easypanel.host`.
3. Las páginas de producto salen con `noindex` (`PHYTO_STORE_INDEXABLE` distinto de `true`) y canonical al host interno.
4. Existe un sitemap antiguo de `fullpos.fulltechrd.com` con **1 error y 3 avisos**; conviene limpiarlo antes de añadir el de la tienda.
5. La propiedad es de **dominio** (`sc-domain:`), así que cubre todos los subdominios: cualquier envío debe apuntar solo a URLs canónicas de `fulltechrd.com`.

### Configuración pendiente (no aplicada, requiere autorización)

Para que el CRM use la integración dentro de su propio contenedor hacen falta dos cosas, **en este orden**:

1. Desplegar la imagen que incluya `server/search-console.mjs` (commit + build + deploy: no autorizado todavía).
2. Añadir al servicio, tras verificar respaldo y rollback:
   ```bash
   docker service update \
     --mount-add type=bind,source=/etc/fulltech/gsc-service-account.json,target=/run/secrets/gsc-service-account.json,readonly \
     --env-add PHYTO_GSC_AUTH_MODE=service_account \
     --env-add PHYTO_GSC_SITE_URL=sc-domain:fulltechrd.com \
     --env-add PHYTO_GSC_SERVICE_ACCOUNT_EMAIL=fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com \
     --env-add PHYTO_GSC_KEY_FILE=/run/secrets/gsc-service-account.json \
     --env-add PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=0 \
     --env-add PHYTO_GSC_SEO_AUDIT_OK=0 \
     --update-order start-first --detach=false ventas_phytoemagrywed
   ```

Mientras eso no ocurra, la integración se usa desde `/opt/fulltech-gsc/run.sh`, que no toca el servicio.

### Higiene de la copia local

La copia descargada sigue en `C:\Users\pc\Downloads\imprimerapido-cloud-731b1ecb1eb6.json`. Ya está instalada en el servidor; se recomienda **borrarla del equipo** (o moverla a un gestor de secretos) y no dejarla en Descargas.

