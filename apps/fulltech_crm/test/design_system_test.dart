import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/core/theme/crm_tokens.dart';

void main() {
  group('tokens alineados con FullPOS Cloud', () {
    test('la marca y los estados son los del POS', () {
      expect(CrmColors.primary, const Color(0xFF1957E6));
      expect(CrmColors.primarySoft, const Color(0xFFEAF1FF));
      expect(CrmColors.pageBg, const Color(0xFFEFF5F8));
      expect(CrmColors.ink, const Color(0xFF102235));
      expect(CrmColors.success, const Color(0xFF16A34A));
      expect(CrmColors.danger, const Color(0xFFDC2626));
      expect(CrmColors.border, const Color(0xFFDDE7EE));
    });

    test('los radios siguen la escala del POS (9/14/16/18/20)', () {
      expect(CrmRadii.sm, 10);
      expect(CrmRadii.md, 14);
      expect(CrmRadii.field, 16);
      expect(CrmRadii.lg, 18);
      expect(CrmRadii.xl, 20);
      expect(CrmRadii.pill, 999);
    });

    test('el escritorio empieza en el mismo breakpoint que el POS', () {
      expect(CrmSpace.desktopBreakpoint, 1100);
      expect(CrmSpace.chatThreePaneBreakpoint, 1366);
      expect(CrmShellMetrics.topbarHeight, 56);
    });
  });

  group('medidas del menú lateral', () {
    test('ancho expandido dentro del rango 176–194', () {
      for (final width in [1100.0, 1366.0, 1440.0, 1920.0, 2560.0]) {
        final value = CrmShellMetrics.sidebarWidth(width);
        expect(value, greaterThanOrEqualTo(176));
        expect(value, lessThanOrEqualTo(194));
      }
    });

    test('ancho colapsado entre 58 y 68', () {
      for (final width in [1100.0, 1440.0, 1920.0]) {
        final value = CrmShellMetrics.sidebarCollapsedWidth(width);
        expect(value, greaterThanOrEqualTo(58));
        expect(value, lessThanOrEqualTo(68));
      }
    });

    test('los ítems caben en cualquier altura razonable', () {
      for (final height in [768.0, 900.0, 1080.0, 1440.0]) {
        expect(CrmShellMetrics.menuItemHeight(height, collapsed: false), inInclusiveRange(35, 42));
        expect(CrmShellMetrics.menuItemHeight(height, collapsed: true), inInclusiveRange(40, 46));
      }
    });

    test('el chat de tres paneles cabe a 1366 dejando sitio al hilo', () {
      const list = CrmShellMetrics.chatListWidth;
      const context = CrmShellMetrics.chatContextWidth;
      const screen = 1366.0;
      const borders = 2;
      final chat = screen - list - context - borders;
      expect(chat, greaterThanOrEqualTo(CrmShellMetrics.chatPaneMinWidth));
    });
  });

  group('tema', () {
    test('claro y oscuro se construyen y usan Manrope', () {
      final light = CrmTheme.build(Brightness.light);
      final dark = CrmTheme.build(Brightness.dark);
      expect(light.textTheme.bodyMedium?.fontFamily, 'Manrope');
      expect(dark.textTheme.bodyMedium?.fontFamily, 'Manrope');
      expect(light.extension<CrmPalette>()?.primary, CrmColors.primary);
      expect(dark.extension<CrmPalette>()?.primary, CrmColors.darkPrimary);
    });

    test('la barra de aplicación mide lo mismo que el POS', () {
      final theme = CrmTheme.build(Brightness.light);
      expect(theme.appBarTheme.toolbarHeight, CrmShellMetrics.topbarHeight);
      expect(theme.appBarTheme.elevation, 0);
    });

    test('los campos y los diálogos usan los radios del sistema', () {
      final theme = CrmTheme.build(Brightness.light);
      final border = theme.inputDecorationTheme.border! as OutlineInputBorder;
      expect(border.borderRadius.topLeft.x, CrmRadii.field);
      final dialog = theme.dialogTheme.shape! as RoundedRectangleBorder;
      expect(dialog.borderRadius.resolve(TextDirection.ltr).topLeft.x, CrmRadii.xl);
    });
  });
}
