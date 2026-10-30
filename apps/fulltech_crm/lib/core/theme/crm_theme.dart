import 'package:flutter/material.dart';

import 'crm_tokens.dart';

/// Paleta resuelta para la luminosidad actual. Los widgets preguntan aquí en
/// lugar de escribir colores: es lo que permite que el tema oscuro del panel
/// (que ya existe en la PWA) se vea igual en la app.
@immutable
class CrmPalette extends ThemeExtension<CrmPalette> {
  const CrmPalette({
    required this.primary,
    required this.primaryDark,
    required this.primarySoft,
    required this.primaryTint,
    required this.surface,
    required this.surfaceMuted,
    required this.pageBg,
    required this.chipBg,
    required this.surfaceTint,
    required this.ink,
    required this.inkSecondary,
    required this.border,
    required this.line,
    required this.danger,
    required this.dangerSoft,
    required this.warning,
    required this.warnBg,
    required this.success,
    required this.shadow,
    required this.bubbleIn,
    required this.bubbleOut,
    required this.whatsapp,
  });

  final Color primary;
  final Color primaryDark;
  final Color primarySoft;
  final Color primaryTint;
  final Color surface;
  final Color surfaceMuted;
  final Color pageBg;
  final Color chipBg;
  final Color surfaceTint;
  final Color ink;
  final Color inkSecondary;
  final Color border;
  final Color line;
  final Color danger;
  final Color dangerSoft;
  final Color warning;
  final Color warnBg;
  final Color success;
  final List<BoxShadow> shadow;
  final Color bubbleIn;
  final Color bubbleOut;
  final Color whatsapp;

  static const CrmPalette light = CrmPalette(
    primary: CrmColors.primary,
    primaryDark: CrmColors.primaryDark,
    primarySoft: CrmColors.primarySoft,
    primaryTint: CrmColors.primaryTint,
    surface: CrmColors.surface,
    surfaceMuted: CrmColors.surfaceMuted,
    pageBg: CrmColors.pageBg,
    chipBg: CrmColors.chipBg,
    surfaceTint: CrmColors.surfaceTint,
    ink: CrmColors.ink,
    inkSecondary: CrmColors.inkSecondary,
    border: CrmColors.border,
    line: CrmColors.line,
    danger: CrmColors.danger,
    dangerSoft: CrmColors.dangerSoft,
    warning: CrmColors.warning,
    warnBg: CrmColors.warnBg,
    success: CrmColors.success,
    shadow: CrmShadows.sm,
    bubbleIn: CrmColors.bubbleIn,
    bubbleOut: CrmColors.bubbleOut,
    whatsapp: CrmColors.whatsapp,
  );

  static const CrmPalette dark = CrmPalette(
    primary: CrmColors.darkPrimary,
    primaryDark: CrmColors.darkPrimaryDark,
    primarySoft: CrmColors.darkPrimarySoft,
    primaryTint: CrmColors.darkPrimaryTint,
    surface: CrmColors.darkSurface,
    surfaceMuted: CrmColors.darkSurfaceMuted,
    pageBg: CrmColors.darkPageBg,
    chipBg: CrmColors.darkChipBg,
    surfaceTint: CrmColors.darkSurfaceMuted,
    ink: CrmColors.darkInk,
    inkSecondary: CrmColors.darkInkSecondary,
    border: CrmColors.darkBorder,
    line: CrmColors.darkBorder,
    danger: CrmColors.darkDanger,
    dangerSoft: Color(0xFF3A1F1E),
    warning: CrmColors.darkWarning,
    warnBg: Color(0xFF3A2F16),
    success: CrmColors.darkSuccess,
    shadow: [BoxShadow(color: Color(0x80000000), blurRadius: 12, offset: Offset(0, 4))],
    bubbleIn: CrmColors.darkBubbleIn,
    bubbleOut: CrmColors.darkBubbleOut,
    whatsapp: CrmColors.darkWhatsapp,
  );

  @override
  CrmPalette copyWith({Color? primary, Color? ink, Color? surface}) => CrmPalette(
        primary: primary ?? this.primary,
        primaryDark: primaryDark,
        primarySoft: primarySoft,
        primaryTint: primaryTint,
        surface: surface ?? this.surface,
        surfaceMuted: surfaceMuted,
        pageBg: pageBg,
        chipBg: chipBg,
        surfaceTint: surfaceTint,
        ink: ink ?? this.ink,
        inkSecondary: inkSecondary,
        border: border,
        line: line,
        danger: danger,
        dangerSoft: dangerSoft,
        warning: warning,
        warnBg: warnBg,
        success: success,
        shadow: shadow,
        bubbleIn: bubbleIn,
        bubbleOut: bubbleOut,
        whatsapp: whatsapp,
      );

  @override
  CrmPalette lerp(ThemeExtension<CrmPalette>? other, double t) {
    if (other is! CrmPalette) return this;
    return t < 0.5 ? this : other;
  }
}

/// Atajo: `context.crm` devuelve la paleta del tema activo.
extension CrmThemeX on BuildContext {
  CrmPalette get crm => Theme.of(this).extension<CrmPalette>() ?? CrmPalette.light;
  bool get isDesktop => MediaQuery.sizeOf(this).width >= CrmSpace.desktopBreakpoint;
  bool get isThreePaneChat => MediaQuery.sizeOf(this).width >= CrmSpace.chatThreePaneBreakpoint;
}

/// Tipografía del panel. El PWA usa la pila del sistema
/// (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto…`), así que la
/// app NO carga una fuente propia: usa la del sistema (Segoe UI en Windows,
/// Roboto en Android). La escala son las medidas reales del panel.
abstract final class CrmTypography {
  /// Sin familia propia: `null` = fuente del sistema, igual que el PWA.
  static const String? fontFamily = null;

  static TextTheme textTheme(CrmPalette p, TextStyle? base) {
    TextStyle s(double size, FontWeight weight, {double height = 1.3, Color? color, double spacing = 0}) => TextStyle(
          fontSize: size,
          fontWeight: weight,
          height: height,
          letterSpacing: spacing,
          color: color ?? p.ink,
        );

    final seeded = Typography.material2021().black;
    return seeded.copyWith(
      displayLarge: s(32, FontWeight.w700, height: 1.15, spacing: -0.64),
      headlineLarge: s(26, FontWeight.w700, height: 1.2, spacing: -0.4),
      headlineMedium: s(22, FontWeight.w700, height: 1.2, spacing: -0.3),
      // `.view__title` del panel: 1.5rem (24 px), 700, -0.02em.
      headlineSmall: s(24, FontWeight.w700, height: 1.2, spacing: -0.48),
      titleLarge: s(18, FontWeight.w700, height: 1.25, spacing: -0.36),
      titleMedium: s(16, FontWeight.w700, height: 1.3),
      titleSmall: s(14, FontWeight.w700, height: 1.3, spacing: -0.28),
      bodyLarge: s(16, FontWeight.w400, height: 1.45),
      bodyMedium: s(14, FontWeight.w400, height: 1.45),
      // Texto secundario del panel: 11.7 px con 1.35 de interlínea.
      bodySmall: s(11.7, FontWeight.w500, height: 1.35, color: p.inkSecondary),
      labelLarge: s(14.4, FontWeight.w700, height: 1.25),
      labelMedium: s(13.44, FontWeight.w700, height: 1.25, color: p.ink),
      labelSmall: s(11, FontWeight.w600, height: 1.2, spacing: 0.4, color: p.inkSecondary),
    );
  }
}

class CrmTheme {
  const CrmTheme._();

  static ThemeData build(Brightness brightness) {
    final p = brightness == Brightness.dark ? CrmPalette.dark : CrmPalette.light;
    final isDark = brightness == Brightness.dark;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: p.primary,
      onPrimary: isDark ? CrmColors.onPrimaryDark : Colors.white,
      primaryContainer: p.primarySoft,
      onPrimaryContainer: p.primaryDark,
      secondary: p.whatsapp,
      onSecondary: Colors.white,
      surface: p.surface,
      onSurface: p.ink,
      error: p.danger,
      onError: Colors.white,
      outline: p.border,
    );
    final text = CrmTypography.textTheme(p, null);
    final buttonText = text.labelLarge?.copyWith(letterSpacing: 0);
    final outlineSoft = p.border;

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: p.pageBg,
      canvasColor: p.surface,
      fontFamily: CrmTypography.fontFamily,
      textTheme: text,
      primaryTextTheme: text,
      iconTheme: IconThemeData(color: CrmColors.inkMuted, size: 20),
      visualDensity: VisualDensity.standard,
      splashFactory: InkSparkle.splashFactory,
      extensions: [p],

      // Barra superior del PWA: 52 px, superficie del tema y una raya fina
      // (`--pe-hairline`), no un borde dibujado.
      appBarTheme: AppBarTheme(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        foregroundColor: p.ink,
        elevation: 0,
        scrolledUnderElevation: 0,
        shadowColor: Colors.transparent,
        toolbarHeight: 52,
        centerTitle: false,
        shape: Border(bottom: BorderSide(color: isDark ? p.border : CrmColors.hairline)),
        titleTextStyle: text.titleMedium?.copyWith(fontWeight: FontWeight.w700, color: p.ink),
        iconTheme: IconThemeData(color: p.ink, size: 22),
        actionsIconTheme: IconThemeData(color: p.ink, size: 22),
      ),

      cardTheme: CardThemeData(
        color: p.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(CrmRadii.lg),
          side: BorderSide(color: p.border),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? p.surfaceMuted : Colors.white,
        contentPadding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
        hintStyle: TextStyle(color: CrmColors.inkMuted, fontSize: 14, fontWeight: FontWeight.w400),
        labelStyle: TextStyle(color: p.inkSecondary, fontSize: 13, fontWeight: FontWeight.w600),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CrmRadii.field),
          borderSide: BorderSide(color: outlineSoft),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CrmRadii.field),
          borderSide: BorderSide(color: outlineSoft),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CrmRadii.field),
          borderSide: BorderSide(color: p.primary, width: 1.8),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CrmRadii.field),
          borderSide: BorderSide(color: p.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(CrmRadii.field),
          borderSide: BorderSide(color: p.danger, width: 2),
        ),
        prefixIconColor: CrmColors.inkMuted,
        suffixIconColor: CrmColors.inkMuted,
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 18),
          minimumSize: const Size(40, 40),
          iconSize: 20,
          textStyle: buttonText,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.md)),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
          minimumSize: const Size(40, 40),
          elevation: 0,
          iconSize: 20,
          textStyle: buttonText,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.field)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: p.primary,
          side: BorderSide(color: p.primary.withValues(alpha: 0.78)),
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
          minimumSize: const Size(40, 40),
          iconSize: 20,
          textStyle: buttonText,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.field)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: p.primary,
          textStyle: buttonText,
          minimumSize: const Size(40, 40),
          iconSize: 20,
        ),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: p.primary,
        textColor: p.ink,
        titleTextStyle: text.bodyMedium?.copyWith(fontWeight: FontWeight.w600, color: p.ink),
        subtitleTextStyle: text.bodySmall,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.field)),
      ),

      dividerTheme: DividerThemeData(color: p.line, thickness: 1, space: 1),

      dialogTheme: DialogThemeData(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.lg)),
        titleTextStyle: text.titleMedium?.copyWith(fontWeight: FontWeight.w700),
        contentTextStyle: text.bodyMedium,
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(CrmRadii.lg)),
        ),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: p.surface,
        selectedColor: p.primarySoft,
        side: BorderSide(color: p.primary.withValues(alpha: 0.10)),
        labelStyle: TextStyle(fontSize: 13.33, fontWeight: FontWeight.w600, color: p.primaryDark),
        secondaryLabelStyle: TextStyle(fontSize: 13.33, fontWeight: FontWeight.w700, color: p.primary),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
      ),

      popupMenuTheme: PopupMenuThemeData(
        color: p.surface,
        surfaceTintColor: Colors.transparent,
        textStyle: text.bodyMedium?.copyWith(fontWeight: FontWeight.w500),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.md)),
      ),

      tooltipTheme: TooltipThemeData(
        textStyle: text.labelSmall?.copyWith(color: Colors.white),
        decoration: BoxDecoration(color: p.ink, borderRadius: BorderRadius.circular(8)),
        waitDuration: const Duration(milliseconds: 450),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: isDark ? p.surfaceMuted : const Color(0xFF0B1220),
        contentTextStyle: const TextStyle(color: Colors.white, fontSize: 13.5),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.field)),
      ),

      dataTableTheme: DataTableThemeData(
        headingTextStyle: text.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        dataTextStyle: text.bodyMedium?.copyWith(fontWeight: FontWeight.w500),
        headingRowColor: WidgetStatePropertyAll(p.surfaceMuted),
        dividerThickness: 1,
      ),

      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: p.surface,
        selectedIconTheme: IconThemeData(color: p.primary, size: 20),
        unselectedIconTheme: const IconThemeData(color: CrmColors.inkMuted, size: 20),
        selectedLabelTextStyle: text.labelMedium?.copyWith(color: p.primary, fontWeight: FontWeight.w600),
        unselectedLabelTextStyle: text.labelMedium?.copyWith(color: p.inkSecondary),
      ),

      drawerTheme: DrawerThemeData(backgroundColor: p.surface, surfaceTintColor: Colors.transparent),
    );
  }
}
