# Propiedad de las paletas visuales

El CRM nativo tiene **tres paletas** y no son intercambiables. Cada una es
dueña de un conjunto de pantallas; usar la de otra región es la causa habitual
de que un icono o un borde «no combine».

| Paleta | Archivo | Dueña de | Origen del valor |
| --- | --- | --- | --- |
| `CrmPalette` (light / dark) | `lib/core/theme/crm_theme.dart` | Shell de escritorio, rail de iconos, cajón de menú, Hoy, Clientes, Inventario, Ventas (listado), Reportes, Ajustes, Perfil, y cualquier pantalla nueva por defecto | `public/admin/admin.css` → `:root` (`--phyto-primary #145bd7`, `--surface-muted #f4f7fc`, `--text-primary #14243d`, `--border #dce5f2`, `--danger #b3261e`, `--success #128c68`, `--radius-sm|md|lg 8/12/18`) |
| `PosPalette` (light / dark) | `lib/features/pos_desktop/pos_tokens.dart` | Solo `lib/features/pos_desktop/**`: pantalla de caja, rejilla de productos, panel de carrito, tira de categorías | Identidad propia del POS de escritorio (superficies más densas y cálidas que el panel web). No la usa ninguna pantalla del CRM. |
| `ChatPalette` (light / dark) | `lib/features/whatsapp/desktop/chat_desktop_theme.dart` | Solo `lib/features/whatsapp/desktop/**`: lista de chats, panel de filtros, mensaje nuevo, panel de opciones/IA | Réplica de WhatsApp Desktop (`#00a884`, `#efeae2`, `#d9fdd3` claro; `#14181a`, `#101314`, `#25d366` oscuro) para que el operador reconozca la herramienta. |

## Tokens con significado propio (no son "un color más")

| Token | Valor | Para qué |
| --- | --- | --- |
| `CrmColors.onPrimaryDark` | `#0B1424` | Texto/icono sobre el azul de marca en tema oscuro (el blanco deslumbra). |
| `CrmColors.info` | `#0D4F6C` | Tono de los avisos informativos (`CrmNotice`). |
| `CrmColors.scrim` | `#66000000` | Velo de las capas modales (cajón del menú, panel lateral del chat). Siempre encima de un desenfoque. |
| `ChatPalette.onAccent` | `#0B1F16` | Contador de no leídos, check de selección y badge del rail: van **encima** de `accent`. |

El resto de literales que quedan en `features/` son de tres tipos y se aceptan
conscientemente: sombras concretas de una pantalla (login, mapa, `pwa_shell`),
velos con alfa propio del chat y la pantalla de error de configuración, que se
pinta deliberadamente fuera del tema para que se vea incluso si el tema no carga.

## Código retirado

`docs/legacy/crm_dark_shell.dart` es el shell oscuro antiguo: **nadie lo
importaba** (461 líneas, una cuarta paleta huérfana). Se conserva como referencia
pero queda fuera de `lib/` y excluido del analizador (`analysis_options.yaml`).

## Reglas

1. **Una pantalla nueva del CRM usa `CrmPalette`** vía `Theme.of(context)` o
   `CrmPalette` = `Theme.of(context).extension<CrmPalette>()!`. Los colores
   sueltos (`Color(0xFF…)`) solo se admiten en los tokens
   (`crm_tokens.dart` / `pos_tokens.dart` / `chat_desktop_theme.dart`).
2. **`PosPalette` y `ChatPalette` no se propagan fuera de su carpeta.** El
   contenedor de la pantalla (shell, barra superior, rail) sigue siendo del CRM;
   solo el cuerpo de esas dos vistas cambia de piel.
3. **Los tres respetan claro/oscuro.** Ninguna paleta puede tener un solo modo.
4. **`test/design_system_test.dart` valida únicamente `CrmPalette`** contra
   `admin.css`. `PosPalette` y `ChatPalette` se validan en
   `test/pos_desktop_widgets_test.dart` y `test/chat_desktop_widgets_test.dart`.

## Por qué existe este documento

La migración pasó por un rediseño visual intermedio (FullPOS) que fijó otros
valores en los tokens y dejó 9 pruebas del sistema de diseño afirmando esos
números ya inexistentes. Este documento fija la fuente de verdad para que el
cambio de valores no vuelva a ocurrir por accidente: **el panel PWA manda; el
POS y el chat son excepciones deliberadas y acotadas.**
