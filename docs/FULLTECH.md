# Identidad Fulltech del panel

El panel privado usa Fulltech en el título, instalación, entrada, inicio, menú, compartir y ayudas. La paleta usa azul y blanco con degradados suaves; el modo oscuro usa superficies azul profundo. Los estados operativos conservan sus colores semánticos. Los nombres de productos Phytoemagry, la landing comercial, dominios, datos, sesiones, preferencias y contratos del bridge no cambian.

`public/admin/fulltech.css` contiene la presentación de inicio, entrada y degradados. Los tokens compartidos de `admin.css` y `shell-v2-tema.css` propagan el azul al resto del panel. La presentación se retira cuando se resuelve el inicio de sesión, con un mínimo breve de 650 ms para evitar destellos; si el sistema pide reducir movimiento no se añade esa espera ni animación.

## Logo y exportación

Se usó el logotipo adjunto por el usuario. El editor integrado de imágenes (`image_gen`, habilidad imagegen) quitó el fondo y suelo conservando las letras negras/azules. El original del usuario permanece en Descargas. El resultado transparente de alta resolución está en `assets/branding/fulltech-logo-source.png`; el logo optimizado para la web, en `public/admin/fulltech-logo.png`.

Prompt final utilizado:

> Edit target: the attached Fulltech 3D black and electric-blue logo. Remove ONLY the pale blue/white background, floor and cast/reflected floor shadows, including background visible through letter openings. Preserve the exact interlocking letter shapes, arrangement, proportions, black and electric-blue materials, bevels, highlights and all logo details. No redesign, no new text. Center the complete uncropped logo on a genuinely transparent square canvas with modest padding. Intended use: original brand logo on app splash and launcher icons.

`python scripts/generate-admin-icons.py` exporta el logo web, favicon de 32 px, iconos PWA de 192/512 px, maskable de 512 px y Apple Touch de 180 px. Los iconos de instalación tienen fondo opaco; el maskable inscribe todo el emblema en el círculo seguro central. También genera los iconos y gráficos de arranque de las cinco densidades Android.

El manifest conserva `/admin/` como identidad, inicio y alcance. No se cambia la identidad de instalación Android. El service worker incluye los recursos nuevos y renueva su versión de caché.

## Comprobaciones

- 102 pruebas web pasan en los ocho archivos de tema/contraste, shell, configuración, perfil y push/service worker. Incluyen contraste de texto en cada extremo de los degradados de acciones.
- `npm run verify:deploy` pasa; siguen los siete avisos previos de contenido de la landing.
- `flutter analyze` sin incidencias y 20 pruebas Flutter pasan.
- `flutter build apk --debug` completa la compilación Android. APK local: `apps/phyto_printer/build/app/outputs/flutter-apk/app-debug.apk`.
- Revisión visual en Chrome de claro/oscuro y presentación de inicio; la geometría móvil del arranque no produce desplazamiento horizontal y el logo carga correctamente.

Esta iteración es local. No se ha desplegado, ni se ha instalado/verificado todavía en un iPhone o Android físico. Vista previa UAT con WhatsApp simulado: http://127.0.0.1:8792/admin/.
