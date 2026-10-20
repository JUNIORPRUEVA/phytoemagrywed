# Identidad Fulltech del panel

El panel privado usa Fulltech en el título, instalación, entrada, inicio, menú, compartir y ayudas. La paleta usa azul y blanco con degradados suaves; el modo oscuro usa superficies azul profundo. Los estados operativos conservan sus colores semánticos. Los nombres de productos Phytoemagry, la landing comercial, dominios, datos, sesiones, preferencias y contratos del bridge no cambian.

`public/admin/fulltech.css` contiene la presentación de inicio, entrada y degradados. Los tokens compartidos de `admin.css` y `shell-v2-tema.css` propagan el azul al resto del panel. La presentación se retira cuando se resuelve el inicio de sesión, con un mínimo breve de 650 ms para evitar destellos; si el sistema pide reducir movimiento no se añade esa espera ni animación.

## Logo y exportación

Se usó el logotipo adjunto por el usuario. El editor integrado de imágenes (`image_gen`, habilidad imagegen) quitó el fondo y suelo conservando las letras negras/azules. El original del usuario permanece en Descargas. El resultado transparente de alta resolución está en `assets/branding/fulltech-logo-source.png`; el logo optimizado para la web, en `public/admin/fulltech-logo.png`.

`python scripts/generate-admin-icons.py` exporta el logo web, favicon de 32 px, iconos PWA de 192/512 px, maskable de 512 px y Apple Touch de 180 px. Los iconos de instalación tienen fondo opaco; el maskable deja margen para el recorte del launcher.

El manifest conserva `/admin/` como identidad, inicio y alcance. No se cambia la identidad de instalación Android. El service worker incluye los recursos nuevos y renueva su versión de caché.

## Comprobaciones

- 102 pruebas web pasan en los ocho archivos de tema/contraste, shell, configuración, perfil y push/service worker. Incluyen contraste de texto en cada extremo de los degradados de acciones.
- `npm run verify:deploy` pasa; siguen los siete avisos previos de contenido de la landing.
- Revisión visual en Chrome de claro/oscuro y presentación de inicio; la geometría móvil del arranque no produce desplazamiento horizontal y el logo carga correctamente.

Esta iteración es local. No se ha desplegado, ni se ha instalado/verificado todavía en un iPhone o Android físico. Vista previa UAT con WhatsApp simulado: http://127.0.0.1:8792/admin/.


## Tema del dispositivo e iconos ampliados (16/10/2026)

- El tema elegido actualiza `theme-color`, `color-scheme` y el esquema CSS desde
  el arranque.
- En PWA, el control final de la barra de tres botones corresponde a Android y
  Chrome. No se puede garantizar un color independiente del sistema en todos
  los equipos. Referencia: https://developer.chrome.com/docs/css-ui/edge-to-edge.
- Iconos normales/Android/iOS: logo al 98% del lienzo útil; adaptable: 80%, frente
  al 54% anterior. Se excluyen píxeles casi transparentes al medir el emblema.
  El launcher aún puede aplicar su propia máscara. Las URLs `?v=2` evitan servir
  iconos anteriores desde caché, manteniendo la identidad de la aplicación.
- Validación: 54 pruebas web y build web aprobado. La comprobación en navegador
  confirma metadatos oscuros. Pendiente comprobar las barras y la actualización
  del icono en el teléfono físico.
- En una PWA, el launcher puede tardar en refrescar el icono instalado; quitar
  únicamente el acceso y reinstalarlo desde Chrome fuerza la actualización, sin
  borrar datos del CRM.


### Seguimiento de barra nativa PWA

La captura del usuario muestra navegación de tres botones clara incluso con
Android en oscuro. Se corrige la base de instalación: `theme_color` y
`background_color` del manifiesto pasan a `#0b1424`. Chrome puede usar el color
del manifiesto para la barra nativa, independientemente del meta dinámico.
Esto fija una base nativa oscura; no promete alternancia de esa barra al cambiar
solo el tema de la web. Las pantallas mantienen sus modos claro/oscuro.
También se pinta explícitamente el fondo raíz antes de cargar el CSS y durante
el cambio de tema, evitando un lienzo transparente con fondo claro por defecto.
Referencia de Chromium: https://chromium.googlesource.com/chromium/src/+/0a6ab4f0e2ce17e572b05400ae6eacd7fc5389f0%5E%21/
Falta verificar el resultado en el dispositivo del usuario y su versión de Chrome;
la actualización del service worker no fuerza una actualización inmediata del
WebAPK ni de su manifiesto de instalación.
