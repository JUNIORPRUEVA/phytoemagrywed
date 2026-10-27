# Alineación visual con FullPOS Cloud

Referencia auditada: `C:\Users\pc\DEV\PROYECTOS\INTERNO\FULLTECH\apps\fulltech_app`
(FullPOS Cloud / DaleVentas POS, Flutter Windows, rama `main`, HEAD `91922ec1`).
**Ese repositorio no se ha modificado**: solo se leyó.

> ⚠️ El tema del POS tiene cambios **sin commitear**. El `HEAD` usa
> `primary #0B2A3A` (petróleo); el árbol de trabajo usa `primary #1957E6` (azul).
> Esta adaptación sigue el **árbol de trabajo** (la intención más reciente) y
> todos los valores viven en `lib/core/theme/crm_tokens.dart`: cambiar de
> referencia es editar ese archivo y nada más.

## Tokens adoptados (valores exactos del POS)

| Token | Valor | Uso |
| --- | --- | --- |
| `primary` | `#1957E6` | marca, botones, ítem activo |
| `primaryDark` | `#123A75` | texto sobre superficies suaves |
| `primarySoft` / `primaryBorder` | `#EAF1FF` / `#CFE0FF` | píldoras, cabeceras suaves |
| `pageBg` | `#EFF5F8` | fondo de la aplicación |
| `surfaceSubtle` | `#F2F6F9` | fondo del menú lateral (claro) |
| `ink` / `inkSecondary` / `inkMuted` | `#102235` / `#52667C` / `#64748B` | jerarquía de texto |
| `border` / `topbarBorder` | `#DDE7EE` / `#D3E0E7` | bordes y línea del topbar |
| `success` / `warning` / `danger` | `#16A34A` / `#B45309` / `#DC2626` | estados |
| Radios | 10 / 14 / 16 / 18 / 20 / 999 | ítem, botón, campo, tarjeta, diálogo |
| Tipografía | **Manrope** (`google_fonts`, igual que el POS) | escala 34/28/22/17/15 · 15/14/12 · 14/12/11 |
| Topbar | **56 px**, blanca, borde inferior | `CrmShellMetrics.topbarHeight` |
| Sidebar | **176–194** expandido · **58–68** colapsado | `CrmShellMetrics.sidebarWidth()` |
| Breakpoint escritorio | **1100** | igual que `kDesktopShellBreakpoint` |
| Elevación | **0** (todo plano con borde) | tarjetas, diálogos, appbar |

## Matriz POS → CRM

| Componente POS | Equivalente en el CRM | Estado |
| --- | --- | --- |
| `DesktopSidebar` (grupos, colapso, footer) | `CrmSidebar` (`crm_desktop_shell.dart`) | **Implementado** |
| `DesktopShellAppBar` 56 | `CrmTopbar` (56, título + subtítulo + píldora de usuario) | **Implementado** |
| `AppColors` / `AppTheme` | `CrmColors` / `CrmTheme` (mismos valores) | **Implementado** |
| `AppTypography` (Manrope) | `CrmTypography` | **Implementado** |
| `FulltechPageHeader` | `CrmPageHeader` (se conserva, ya usa tokens) | Adaptado por tokens |
| `FulltechDialog` (radio 20) | `dialogTheme` con radio 20 | Adaptado por tema |
| `PrimaryButton` 48 | `CrmButton` (táctil 44; en escritorio 40) | Adaptado por tema |
| `DataTable` (listados densos) | `CrmListTile` / `CrmDataTable` | **Pendiente** (solo si hace falta densidad) |
| Asistente IA global (dock) | módulo «Agentes IA» como pantalla | Se mantiene (diseño distinto por función) |
| — | `ChatsDesktopScreen` (3 paneles estilo WhatsApp Desktop) | **Implementado** |

## Chat de escritorio

`lib/features/whatsapp/chats_desktop.dart`:

- **Izquierda (340 px)**: búsqueda, filtros (todos/sin leer/pendientes/finalizadas) y
  lista con avatar, nombre, último mensaje, hora, sin leer y estado real
  (`pendiente` / `finalizada` según el backend).
- **Centro**: el MISMO `ChatScreen` en modo `embedded` (texto, fotos, PDF, voz,
  plantillas, ubicación, asignación, IA del CRM). Nada se duplicó: se añadió un
  encabezado compacto y el hilo existente se reutiliza tal cual.
- **Derecha (320 px, cerrable)**: cliente, teléfono, etiquetas, sus pedidos y
  acciones reales (llamar, ficha, abrir pedido). Sin datos inventados.
- Por debajo de **1366 px** la tercera zona no se muestra (no se come el chat);
  por debajo de **1100 px** se usa el móvil de siempre (lista → hilo) sin cambios.

## Verificación

- `flutter analyze` sin problemas.
- `flutter test`: **116 pruebas** (incluye `design_system_test.dart`, que fija los
  tokens, radios, breakpoints y el reparto de anchos del chat).
- `flutter build windows --debug` y `flutter build apk --debug`: OK.

## Capturas reales (arnés de diseño, sin backend)

El arnés vive en `tool/design_harness` (excluido del análisis) y se compila aparte
en una ruta corta (`C:\h\harness`) porque Windows falla con rutas > 260. Levanta
los **widgets reales** del CRM con un `MockClient` que devuelve un `/api/admin/data`
de mentira; la captura se hace con `PrintWindow` (sin robar el foco). Script:
`tool/design_harness/capture.ps1` (`-View shell|chats|gallery -Module <módulo> -Mode light|dark`).

| Captura | Ventana | Qué muestra |
| --- | --- | --- |
| `crm-shell-1920-light.png` | 1900×1040 | menú lateral por grupos, topbar 56, Hoy con métricas |
| `crm-shell-1366-light.png` | 1360×720 | mismo panel a 1366 (sidebar 176, sin recortes) |
| `crm-shell-1920-dark.png` | 1900×1040 | tema oscuro completo |
| `crm-chats-1920-light.png` | 1900×1040 | chat 3 paneles (lista 340 · hilo · contexto 320) |
| `crm-chats-1366-light.png` | 1360×720 | chat a 1366: **la tercera zona se oculta** |
| `crm-chats-1920-dark.png` | 1900×1040 | chat en oscuro (burbujas y composer) |
| `crm-componentes-1920-light.png` | 1900×1040 | galería: botones, estados, formularios, listas |
| `crm-mod-pedidos-1920-light.png` | 1900×1040 | módulo Pedidos real |
| `crm-mod-clientes-1920-light.png` | 1900×1040 | módulo Clientes real |
| `crm-mod-pos-1920-light.png` | 1900×1040 | módulo Punto de venta real |
| `crm-mod-custodia-1920-light.png` | 1900×1040 | Custodia y rendiciones |
| `crm-mod-cierre-1920-light.png` | 1900×1040 | Cierre actual |
| `crm-mod-reportes-1920-light.png` | 1900×1040 | Reportes |
| `crm-login-1440.png` | — | app real (Windows) en la pantalla de acceso |

### Diferencias encontradas con la captura y corregidas

| Defecto visible | Corrección |
| --- | --- |
| Tarjetas de métrica de ~300 px de alto | `StatGrid` con `mainAxisExtent: 96` y `padding` horizontal 12 |
| Tarjetas sin separación superior y desalineadas con la rejilla | `SectionCard` con margen 12 en los cuatro lados |
| Título del módulo repetido (topbar + cabecera) | `CrmPageHeader` oculta el título grande en escritorio |
| Chips de filtro del chat cortados a media palabra | `Wrap` de `ChoiceChip` en dos líneas (340 px no dan para 4) |
| **Punto de venta**: barra de cobro flotando en el centro | `bottomNavigationBar` (ancho completo) en vez de `bottomSheet` |
| **Punto de venta**: título duplicado y `AppBar` interno doble | `PosScreen(embedded: true)` desde el panel de escritorio |
| Chat en rojo (`ErrorWidget`) al capturar | el arnés no llamaba a `initializeDateFormatting('es')` (la app real sí) |

### Revisión módulo a módulo (23 destinos)

Los 23 módulos **heredan** el tema (colores, radios, tipografía, appbar 56, tarjetas
radio 18) y la cabecera del panel; no se reescribió ninguno. Verificados con captura
real: `hoy`, `whatsapp`, `pedidos`, `clientes`, `pos`, `custodia`, `cierre`,
`reportes`. El resto (catalogo, inventario, cotizaciones, solicitudes, recuento,
recogidas, tiendas, mapa, repartidores, ops, seguimientos, mensajes, usuarios,
ajustes, perfil) usa los **mismos componentes compartidos** (`SectionCard`,
`StatGrid`, `CrmListTile`, `CrmButton`, `StatusPill`) y por tanto el mismo estilo,
pero **no se ha capturado uno a uno**: se consideran pendientes de comparación.

### Limitación declarada

No hay captura del POS para comparar lado a lado: su `.exe` requiere su backend
(no se levantan servicios) y el POS no se ha ejecutado. Tampoco se automatizó el
inicio de sesión en el CRM porque el envío de teclas desde el editor roba el foco
a otras ventanas. Por eso **no se declara paridad visual global**: lo verificado es
lo que muestran las capturas de arriba, contra los valores leídos del código del POS.
