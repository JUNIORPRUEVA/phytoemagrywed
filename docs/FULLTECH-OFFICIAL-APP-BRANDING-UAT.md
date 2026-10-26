# FULLTECH Store + Delivery — iconos oficiales y bienvenida

> Actualización: el usuario sustituyó el vídeo por el archivo vertical correcto y añadió la identidad CRM. El estado vigente está documentado en [FULLTECH-CORRECTED-VIDEO-CRM-UAT.md](FULLTECH-CORRECTED-VIDEO-CRM-UAT.md). Las especificaciones del vídeo horizontal que figuran abajo corresponden a la primera entrega y quedan como historial; ese vídeo ya no está conectado ni publicado en los recursos de bienvenida.

Implementación local, sin commit, push, despliegue ni cambios de reglas de negocio o bases de datos. Store y Delivery mantienen identidades separadas. No se modifica el logo del AppBar, la navegación, el catálogo, el carrito, el checkout ni la lógica de GPS/entregas.

## 1. Archivos realmente recibidos

El texto adjunto usa nombres y dimensiones diferentes a los archivos adjuntos disponibles. Se utilizaron los archivos proporcionados en Downloads, identificados por su contenido:

| Uso | Fuente preservada | Copia de trabajo |
|---|---|---|
| Icono Store | `Logotipo futurista Fulltech Store (1).png` | `assets/branding/official-apps/store/source.png` |
| Icono Delivery | `Repartidor futurista en scooter azul.png` | `../FULLTECH-DELIVERY/assets/branding/official/source.png` |
| Bienvenida exclusiva Store | `opengen-62903ecf-e226-432f-9667-fb1703740944.mp4` | `assets/branding/official-apps/store/source-welcome.mp4` |

El ZIP de iconos y `android_512.png` se preservan como material suplementario en `../FULLTECH-DELIVERY/assets/branding/official/`; se generaron los iconos desde la fuente de mayor resolución. Se verificó que las copias PNG coinciden por SHA-256 con los originales. No se regeneraron mediante IA ni se reinterpretaron los logotipos.

## 2. Iconos y configuraciones

**Store — PWA existente**

- Máster 1024 px en `assets/branding/official-apps/store/master-1024.png`.
- `public/store/assets/app-icons/`: PNG RGB de 32, 120, 152, 167, 180, 192, 512 y 1024 px; variantes maskable 192 y 512 px.
- `manifest.webmanifest`: iconos any y maskable separados; identidad, scope y start_url existentes conservados.
- `index.html`: favicon PNG 32 y apple-touch-icon 180. El logo del encabezado conserva su archivo original.
- No se encontró un contenedor Flutter/nativo de Store; su instalación Android/iOS sigue siendo PWA. No se inventó una configuración nativa adicional.

**Delivery — Flutter existente, repositorio `../FULLTECH-DELIVERY`**

- Máster 1024 px preservado en `assets/branding/official/master-1024.png`.
- `assets/icon/launcher.png`, `launcher_foreground.png`, fondo Android `#031A41` y máscara de referencia `maskable-1024.png`.
- Android legacy: 48, 72, 96, 144, 192 px (mdpi a xxxhdpi), nombre `ic_fulltech_delivery`.
- Android adaptativo: foreground a 108, 162, 216, 324, 432 px más XML v26 y fondo en `colors.xml`. El contenido tiene margen seguro antes de aplicar las máscaras; no se agregan marcos decorativos.
- iOS: AppIcon existente actualizado, 25 entradas, 21 archivos PNG, incluidos 120, 152, 167, 180 y 1024 px; sin canal alfa.
- `pubspec.yaml` y AndroidManifest apuntan a la configuración oficial. El recurso nuevo evita un archivo `ic_launcher.png` antiguo bloqueado por Windows. Los cambios parciales del generador en los legacy antiguos se restauraron; los nuevos son los utilizados por la app.
- `tool/prepare_official_icons.py` y `tool/generate_launcher_icons.ps1` permiten regenerar la fuente aprobada sin volver al icono anterior de camión.
- No se añade animación a Delivery. Sus cambios previos en README, configuración y login se preservan.

## 3. Vídeo y centrado

El archivo real es H.264 **horizontal de 864 × 496**, 4,04 segundos, con pista AAC y tamaño 1.583.606 bytes. No es el archivo vertical descrito en el texto.

Se inspeccionaron fotogramas a lo largo de la secuencia: el logo inicial y el repartidor permanecen dentro del encuadre. Se conserva todo el ancho; no se recorta para llenar una pantalla vertical. FFmpeg escala proporcionalmente a 720 × 414 y centra el cuadro en un lienzo 720 × 1280, con 433 px arriba y abajo, fondo `#031A41`.

Salida `public/store/assets/welcome/first-launch.mp4`: H.264, yuv420p, faststart, sin audio, 4,04 s, **565.052 bytes** (reducción del 64,3%). `poster.jpg` queda como fotograma de referencia; no se descarga al reabrir. El vídeo se adapta con `object-fit: contain` al viewport y mantiene su proporción. El botón Omitir respeta las áreas seguras.

Comando reproducible:

```powershell
ffmpeg -i assets/branding/official-apps/store/source-welcome.mp4 -vf "scale=720:414:flags=lanczos,pad=720:1280:0:433:color=0x031a41,setsar=1" -an -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart public/store/assets/welcome/first-launch.mp4
```

## 4. Primer inicio

`first-launch.js` y `first-launch.css` son exclusivos de Store. La inicialización de la aplicación continúa detrás de la bienvenida.

- Solo se considera una apertura inicial de la portada; enlaces a productos, autenticación y checkout entran directamente.
- Vídeo silenciado, playsinline, sin audio, descarga bajo demanda; sin precarga en el service worker.
- Al terminar u omitir: `fulltech_store_welcome_seen_v1=1` en localStorage, con respaldo en sessionStorage y memoria.
- Refrescar, navegar o reabrir con la marca guardada no reproduce ni solicita el vídeo.
- Reducir movimiento: se omite y se guarda la marca. Sin conexión: se entra a la tienda directamente.
- Error o autoplay denegado: salida inmediata. Carga bloqueada: salida a 1,8 s; máximo total 7 s. La marca no se guarda si falla, para permitir un primer visionado correcto más adelante.
- Si todo almacenamiento está prohibido, la protección en memoria evita repetirlo en la misma página; entre recargas puede volver a aparecer porque no existe persistencia disponible.
- Cambio de ruta o pestaña oculta: no se mantiene una bienvenida atrapada. El foco y el estado inert se restauran; Escape y Omitir permiten salir.
- SW v101 almacena scripts/estilos/iconos y excluye el vídeo para evitar descargas innecesarias y problemas con respuestas Range.

## 5. Validación ejecutada

- `python scripts/check-official-icons.py`: 10 iconos PWA, tamaños Android y las 25 entradas iOS correctas; RGB iOS, originales conservados. Vistas de máscara cuadrada, redondeada y circular inspeccionadas.
- `dart run flutter_launcher_icons`: generación correcta.
- `flutter test`: suite completa aprobada, incluidos flujos de reparto, navegación, mapas externos, errores de transporte y layouts.
- `flutter build apk --debug --no-pub`: APK local compilado. `aapt dump badging` confirma `com.fulltech.delivery` con `ic_fulltech_delivery.xml`.
- `npm run build`: correcto. Advertencias de contenido preexistente de la landing, ajenas a este cambio.
- Chromium: 360, 390, 430, 768 y 1280 px. WebKit: 390 px. Reproducción real hasta finalizar, persistencia, reapertura y navegación sin nuevas solicitudes del vídeo.
- Casos de Omitir, movimiento reducido, fallo de vídeo, almacenamiento denegado, reproducción bloqueada, carga detenida, entrada a checkout y ausencia de conexión aprobados.
- Service worker real: 79 recursos iniciales en caché, script de bienvenida incluido, vídeo excluido; reapertura offline sin bienvenida ni vídeo aprobada.
- Sin pruebas en teléfonos físicos, sin simulador iOS y sin compilación Xcode en Windows. El APK de desarrollo no se publica ni se instala automáticamente.

Capturas y resultados: `docs/capturas/official-app-branding/` (`icon-masks.png`, primeras aperturas, pantallas posteriores, `results.json`, `webkit-results.json`, `sw-results.json`).

## 6. Pendientes y decisión

**GO para revisión en desarrollo/UAT. NO-GO para publicación final** hasta verificar instalación nueva y actualización en Android/iPhone reales, máscaras y tamaño de iconos en sus launchers, safe areas con notch/Dynamic Island, Safari/PWA instalada, recuperación offline y una ronda real de autenticación/carrito/checkout/GPS. Compilar y firmar iOS con Xcode; preparar la firma de publicación Android según el proceso existente.

No se ejecuta despliegue ni se cambian credenciales. La diferencia de formato del MP4 queda documentada: si se desea contenido vertical que llene la pantalla, hace falta el archivo vertical original; esta integración mantiene íntegro el vídeo horizontal recibido.
