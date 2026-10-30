import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/core/theme/crm_tokens.dart';

/// CONTRATO DEL SISTEMA VISUAL DEL CRM.
///
/// **Fuente de verdad**: `public/admin/admin.css` (`:root`, líneas 10–31) y el
/// tema de la app (`lib/core/theme/crm_theme.dart`). La app nativa no inventa
/// colores: los importa del panel PWA, que es el que sigue en producción.
///
/// Historia de este archivo (importante para no repetir el error):
/// la versión anterior afirmaba los valores del **rediseño FullPOS**
/// (`#1957E6`, `#EFF5F8`, radios 10/14/16/18/20, corte 1100, fuente Manrope).
/// Ese rediseño se revirtió a la identidad del panel, así que 9 pruebas
/// quedaron en rojo **por expectativas obsoletas, no por defectos del código**.
/// Aquí se reescriben contra el contrato real y se añaden invariantes que no
/// dependen de duplicar números.
///
/// Las paletas del **POS** (`PosPalette`) y del **chat** (`ChatPalette`) son
/// deliberadamente propias y NO se validan aquí: tienen sus propias pruebas
/// (`pos_desktop_widgets_test.dart`, `chat_desktop_widgets_test.dart`).
void main() {
  group('tokens alineados con el panel PWA (public/admin/admin.css :root)', () {
    test('la marca y los estados son los del :root del panel', () {
      // --phyto-primary / --phyto-primary-soft / --surface-muted
      expect(CrmColors.primary, const Color(0xFF145BD7));
      expect(CrmColors.primarySoft, const Color(0xFFE5EFFF));
      expect(CrmColors.pageBg, const Color(0xFFF4F7FD));
      // --text-primary / --border / --danger / --success
      expect(CrmColors.ink, const Color(0xFF14243D));
      expect(CrmColors.border, const Color(0xFFDCE5F2));
      expect(CrmColors.danger, const Color(0xFFB3261E));
      expect(CrmColors.success, const Color(0xFF128C68));
    });

    test('la escala de radios es creciente y coherente (--radius-sm|md|lg)', () {
      // Valores del CSS (8/12/18) + el campo del panel y la píldora.
      expect(CrmRadii.sm, 8);
      expect(CrmRadii.md, 12);
      expect(CrmRadii.lg, 18);
      expect(CrmRadii.field, 12);
      expect(CrmRadii.xl, greaterThanOrEqualTo(CrmRadii.lg));
      expect(CrmRadii.pill, 999);
      // Invariante: la escala nunca se cruza.
      expect(CrmRadii.sm, lessThan(CrmRadii.md));
      expect(CrmRadii.md, lessThan(CrmRadii.lg));
    });

    test('el escritorio empieza en el mismo corte que el CSS (980)', () {
      expect(CrmSpace.desktopBreakpoint, 980);
      expect(CrmSpace.chatThreePaneBreakpoint, 1366);
      // Barra superior del escritorio (CrmLightTopbar).
      expect(CrmShellMetrics.topbarHeight, 56);
    });
  });

  group('medidas del menú lateral', () {
    test('el cajón mide lo del panel: 318 de ancho y 44 de ítem', () {
      expect(CrmShellMetrics.drawerWidth, 318);
      expect(CrmShellMetrics.drawerItemHeight, 44);
      expect(CrmShellMetrics.drawerHeadHeight, 72);
      // Compatibilidad: las funciones del shell anterior devuelven el cajón.
      for (final width in [1100.0, 1366.0, 1920.0]) {
        expect(CrmShellMetrics.sidebarWidth(width), CrmShellMetrics.drawerWidth);
      }
      for (final height in [768.0, 900.0, 1080.0]) {
        expect(
          CrmShellMetrics.menuItemHeight(height, collapsed: false),
          CrmShellMetrics.drawerItemHeight,
        );
      }
    });

    test('el rail permanente del escritorio es estrecho (52 px)', () {
      // Si cambia, la columna deja de ser un rail y hay que revisar el layout
      // del POS y del chat (los dos viven a su derecha).
      expect(CrmShellMetrics.railWidth, 52);
      expect(CrmShellMetrics.railWidth, lessThan(CrmShellMetrics.drawerWidth));
    });

    test('el chat de tres paneles cabe a 1366 dejando sitio al hilo', () {
      const list = CrmShellMetrics.chatListWidth;
      const contextPane = CrmShellMetrics.chatContextWidth;
      const screen = 1366.0;
      const borders = 2;
      final chat = screen - list - contextPane - borders;
      expect(chat, greaterThanOrEqualTo(CrmShellMetrics.chatPaneMinWidth));
    });
  });

  group('tema', () {
    test('claro y oscuro se construyen con la fuente del sistema', () {
      final light = CrmTheme.build(Brightness.light);
      final dark = CrmTheme.build(Brightness.dark);
      // El panel no carga tipografía propia (`--pe-font` es la del sistema).
      expect(CrmTypography.fontFamily, isNull);
      // Material rellena con su fuente por defecto cuando no se fija familia
      // ('Roboto' en el motor de pruebas): lo que se comprueba es que el CRM
      // NO impone una familia propia como hacía el rediseño FullPOS.
      for (final text in [light.textTheme.bodyMedium, dark.textTheme.bodyMedium]) {
        expect(text?.fontFamily, isNot('Manrope'));
      }
      expect(light.scaffoldBackgroundColor, CrmPalette.light.pageBg);
      expect(dark.scaffoldBackgroundColor, CrmPalette.dark.pageBg);
    });

    test('las extensiones de paleta son la del tema que se pide', () {
      final light = CrmTheme.build(Brightness.light).extension<CrmPalette>();
      final dark = CrmTheme.build(Brightness.dark).extension<CrmPalette>();
      expect(light?.primary, CrmColors.primary);
      expect(dark?.primary, CrmColors.darkPrimary);
      // Claro y oscuro no comparten tinta ni fondo: si coincidieran, el
      // conmutador de tema no estaría aplicándose.
      expect(light?.ink, isNot(dark?.ink));
      expect(light?.pageBg, isNot(dark?.pageBg));
    });

    test('la barra de aplicación del móvil mide 52 y la del escritorio 56', () {
      final theme = CrmTheme.build(Brightness.light);
      // `--pe-topbar` del panel móvil.
      expect(theme.appBarTheme.toolbarHeight, 52);
      expect(theme.appBarTheme.elevation, 0);
      // La barra del shell de escritorio es otra pieza (CrmLightTopbar).
      expect(CrmShellMetrics.topbarHeight, 56);
    });

    test('los campos y los diálogos usan la escala real del sistema', () {
      final theme = CrmTheme.build(Brightness.light);
      final border = theme.inputDecorationTheme.border! as OutlineInputBorder;
      expect(border.borderRadius.topLeft.x, CrmRadii.field);
      final dialog = theme.dialogTheme.shape! as RoundedRectangleBorder;
      expect(dialog.borderRadius.resolve(TextDirection.ltr).topLeft.x, CrmRadii.lg);
    });

    test('el texto principal cumple contraste AA sobre el fondo en ambos temas', () {
      double luminance(Color color) {
        double channel(double value) =>
            value <= 0.03928 ? value / 12.92 : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      }

      double contrast(Color a, Color b) {
        final la = luminance(a);
        final lb = luminance(b);
        final light = math.max(la, lb);
        final dark = math.min(la, lb);
        return (light + 0.05) / (dark + 0.05);
      }

      expect(contrast(CrmPalette.light.ink, CrmPalette.light.pageBg), greaterThanOrEqualTo(4.5));
      expect(contrast(CrmPalette.dark.ink, CrmPalette.dark.pageBg), greaterThanOrEqualTo(4.5));
    });
  });
}
