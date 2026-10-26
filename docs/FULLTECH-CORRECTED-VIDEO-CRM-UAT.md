# Store — vídeo corregido; CRM — logo oficial

Cambios locales solicitados, sin despliegue, commit o push. No se modifica Delivery en esta corrección. No se alteran reglas de negocio, datos, navegación ni dimensiones de la interfaz CRM.

## Vídeo correcto

- Fuente recibida: `C:/Users/pc/Downloads/opengen-9e7ca7be-9ee1-4fab-a492-81f248bc7ede.mp4`.
- Copia intacta: `assets/branding/official-apps/store/source-welcome-corrected.mp4`.
- Entrada: H.264, 496 × 864, 4,041667 s, sin audio, 839.059 bytes.
- Salida activa: `public/store/assets/welcome/first-launch-v2.mp4`, H.264/yuv420p/faststart, mismas dimensiones y duración, sin audio, **305.694 bytes**.
- Fotograma: `public/store/assets/welcome/poster-v2.jpg`.
- Se inspeccionó toda la secuencia mediante hojas de fotogramas. El grupo logo/moto quedaba aproximadamente 108 px por debajo del centro vertical. Se retiraron 108 px de fondo superior vacío y se continuó el fondo inferior usando las últimas filas del propio vídeo, sin deformar ni recortar el logo o el repartidor. La entrada/salida lateral de la moto pertenece a la animación original y se conserva.
- El vídeo anterior dejó de estar conectado y sus archivos optimizados públicos se retiraron. La fuente anterior permanece preservada como historial.
- `object-fit: contain` conserva la proporción y el encuadre; las áreas seguras se respetan en Omitir. Comprobación visual a 390 × 850: grupo logo/moto centrado, sin recorte añadido.

Comando reproducible:

```powershell
ffmpeg -i assets/branding/official-apps/store/source-welcome-corrected.mp4 -filter_complex "[0:v]split=2[main][edge];[main]crop=496:756:0:108[top];[edge]crop=496:2:0:862,scale=496:108:flags=neighbor[bottom];[top][bottom]vstack,setsar=1[v]" -map "[v]" -an -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart public/store/assets/welcome/first-launch-v2.mp4
```

## Primera apertura y caché

Se conserva la clave `fulltech_store_welcome_seen_v1`: quienes ya vieron u omitieron la bienvenida no la reciben de nuevo por este cambio. Para revisar la corrección se utiliza un contexto nuevo/ventana privada o la URL directa del vídeo. No se borró almacenamiento del cliente.

Módulo `first-launch.js?v=2`, SW Store v102 y nombre de vídeo nuevo para evitar utilizar el archivo anterior de la caché. El vídeo continúa fuera del precache y solo se solicita durante una apertura elegible. Se mantienen Omitir, movimiento reducido, fallback por error/bloqueo/offline y persistencia.

## Logo CRM

- Fuente: `Logotipo futurista FULLTECH CRM (1).png`, preservada en `assets/branding/official-apps/crm/source.png` (SHA-256 idéntico al original).
- Máster: `assets/branding/official-apps/crm/master-1024.png`.
- Recursos: `public/admin/assets/branding/fulltech-crm-{32,180,192,256,512}.png` y `fulltech-crm-maskable-512.png`.
- El arte se conserva sin rediseño ni generación por IA. La máscara mantiene margen y continúa el fondo de la fuente, sin marcos añadidos.
- Referencias actualizadas en arranque, acceso, cabecera/perfil, drawer, pseudoelementos de marca, favicon, Apple Touch Icon, manifest y notificaciones de la interfaz. Se conservan los tamaños existentes (54 px en el acceso; 26 px en el drawer).
- Solo se cambiaron rutas de imagen en `app.js` y CSS; no se tocaron eventos de acceso ni de navegación. Versiones de recursos actualizadas y SW CRM `crm-v272-official-branding-20261024`.
- Los archivos antiguos del logo CRM permanecen preservados; la interfaz utiliza rutas nuevas para evitar caché antigua.

## Validación

- `node scripts/check-official-branding.mjs`: Chromium 360/390/430/768/1280, WebKit 390; reproducción hasta finalizar, no repetición ni nuevas solicitudes tras recarga/navegación. Omitir, movimiento reducido, error, storage bloqueado, carga detenida, offline, checkout y autoplay denegado aprobados.
- Service worker Store: recursos de arranque en caché, vídeo excluido y reapertura offline aprobada.
- `node scripts/check-corrected-crm-branding.mjs`: acceso CRM en 360/390/430/1280 con claro/oscuro, imágenes cargadas y manifest válido; drawer autenticado local verificado. Las sesiones se crearon solo en UAT, sin modificar registros de negocio.
- `npm run build`: aprobado, con avisos de contenido de landing preexistentes.
- `npx vitest run tests/mobile-startup.test.js tests/panel-shell-uat.test.js`: **37 aprobadas, 1 fallo previo**. El caso del drawer espera `data-tab="delivery"`; ese atributo tampoco existe en `HEAD:public/admin/index.html`, anterior a este cambio. No se alteró el menú para acomodar una prueba ajena al reemplazo del logo.
- Archivos originales verificados; sintaxis JS y `git diff --check` correctos.

Capturas: `docs/capturas/corrected-store-crm-branding/` (vídeo centrado, acceso claro/oscuro, drawer y resultados CRM). Resultados completos de Store: `docs/capturas/official-app-branding/results.json`.

**GO para revisión local/UAT** de la corrección. Verificación física en Android/iPhone y publicación permanecen pendientes; WebKit de escritorio no equivale a Safari ejecutado en un iPhone. No se desplegó a producción.
