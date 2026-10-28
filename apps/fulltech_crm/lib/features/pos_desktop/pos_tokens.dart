import 'package:flutter/material.dart';

/// Paleta del **POS de escritorio**, en dos versiones.
///
/// Regla del sistema: el POS NO tiene tema propio. Si el usuario eligió modo
/// oscuro se ve oscuro y si eligió claro se ve claro, igual que el resto del
/// panel. Los valores oscuros se muestrearon de la captura de FullPOS Cloud;
/// los claros son el mismo lenguaje sobre las superficies del CRM.
abstract final class PosLightColors {
  static const Color primary = Color(0xFF1957E6);
  static const Color primarySoft = Color(0xFFEAF1FF);
  static const Color primaryBorder = Color(0xFFC7DBFF);
  static const Color pageBg = Color(0xFFF4F7FA);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceMuted = Color(0xFFF1F5F9);
  static const Color ink = Color(0xFF102235);
  static const Color inkSecondary = Color(0xFF64748B);
  static const Color border = Color(0xFFDDE7EE);
  static const Color borderSoft = Color(0xFFE8EEF4);
  static const Color success = Color(0xFF12A150);
  static const Color warning = Color(0xFFB45309);
  static const Color danger = Color(0xFFDC2626);
}

abstract final class PosDarkColors {
  static const Color primary = Color(0xFF7EA8FF);
  static const Color primarySoft = Color(0xFF16233C);
  static const Color primaryBorder = Color(0xFF23406B);
  static const Color pageBg = Color(0xFF161717);
  static const Color surface = Color(0xFF1C1D1D);
  static const Color surfaceMuted = Color(0xFF202121);
  static const Color ink = Color(0xFFFAFAFA);
  static const Color inkSecondary = Color(0xFFC0C1C1);
  static const Color border = Color(0xFF2E2F2F);
  static const Color borderSoft = Color(0xFF262727);
  static const Color success = Color(0xFF25D366);
  static const Color warning = Color(0xFFE9A23B);
  static const Color danger = Color(0xFFF15C6D);
}

/// Paleta resuelta para la luminosidad que eligió el usuario.
@immutable
class PosPalette {
  const PosPalette({
    required this.dark,
    required this.primary,
    required this.primarySoft,
    required this.primaryBorder,
    required this.pageBg,
    required this.surface,
    required this.surfaceMuted,
    required this.ink,
    required this.inkSecondary,
    required this.border,
    required this.borderSoft,
    required this.success,
    required this.warning,
    required this.danger,
    required this.checkout,
    required this.onCheckout,
  });

  final bool dark;

  /// Acento para iconos y texto sobre superficies.
  final Color primary;
  final Color primarySoft;
  final Color primaryBorder;
  final Color pageBg;
  final Color surface;
  final Color surfaceMuted;
  final Color ink;
  final Color inkSecondary;
  final Color border;
  final Color borderSoft;
  final Color success;
  final Color warning;
  final Color danger;

  /// Bloque sólido de cobro (azul de marca) y su texto.
  final Color checkout;
  final Color onCheckout;

  static const PosPalette light = PosPalette(
    dark: false,
    primary: PosLightColors.primary,
    primarySoft: PosLightColors.primarySoft,
    primaryBorder: PosLightColors.primaryBorder,
    pageBg: PosLightColors.pageBg,
    surface: PosLightColors.surface,
    surfaceMuted: PosLightColors.surfaceMuted,
    ink: PosLightColors.ink,
    inkSecondary: PosLightColors.inkSecondary,
    border: PosLightColors.border,
    borderSoft: PosLightColors.borderSoft,
    success: PosLightColors.success,
    warning: PosLightColors.warning,
    danger: PosLightColors.danger,
    checkout: PosLightColors.primary,
    onCheckout: Color(0xFFFFFFFF),
  );

  static const PosPalette darkPalette = PosPalette(
    dark: true,
    primary: PosDarkColors.primary,
    primarySoft: PosDarkColors.primarySoft,
    primaryBorder: PosDarkColors.primaryBorder,
    pageBg: PosDarkColors.pageBg,
    surface: PosDarkColors.surface,
    surfaceMuted: PosDarkColors.surfaceMuted,
    ink: PosDarkColors.ink,
    inkSecondary: PosDarkColors.inkSecondary,
    border: PosDarkColors.border,
    borderSoft: PosDarkColors.borderSoft,
    success: PosDarkColors.success,
    warning: PosDarkColors.warning,
    danger: PosDarkColors.danger,
    checkout: PosLightColors.primary,
    onCheckout: Color(0xFFFFFFFF),
  );

  /// Paleta del tema activo (el que el usuario configuró).
  static PosPalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? darkPalette : light;

  /// Escala tipográfica ya coloreada con esta paleta.
  PosText get text => PosText(this);
}

/// Medidas tomadas de la captura (ventana 1920×1080).
abstract final class PosMetrics {
  /// Barra superior con borde inferior.
  static const double toolbarHeight = 56;

  /// Ancho del panel de venta (carrito): 546 px en la captura ≈ 28 % del ancho.
  static double cartWidth(double screenWidth) => (screenWidth * 0.28).clamp(320.0, 480.0);

  /// Columna estrecha de categorías a la izquierda de la rejilla.
  static const double railWidth = 84;

  /// Tarjeta de producto.
  static const double cardHeight = 216;
  static const double cardMaxWidth = 200;
  static const double gridGap = 10;

  static const double searchHeight = 38;
  static const double actionButtonHeight = 36;
  static const double cartLineHeight = 46;
  static const double radiusCard = 10;
  static const double radiusField = 8;
  static const double radiusButton = 8;

  /// Tipografía del POS.
  static const String fontFamily = 'Manrope';
}

/// Tipografía del POS. Se construye con la paleta activa, así que nunca hay
/// texto oscuro sobre fondo oscuro.
@immutable
class PosText {
  const PosText(this.c);

  final PosPalette c;

  TextStyle get title => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 16,
    fontWeight: FontWeight.w800,
    color: c.ink,
  );

  TextStyle get cardName => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w700,
    color: c.ink,
    height: 1.2,
  );

  TextStyle get cardPrice => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 14.5,
    fontWeight: FontWeight.w800,
    color: c.ink,
  );

  TextStyle get pill => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w700,
    color: c.primary,
  );

  TextStyle get body => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    color: c.ink,
  );

  TextStyle get secondary => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12,
    fontWeight: FontWeight.w500,
    color: c.inkSecondary,
  );

  TextStyle get total => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 22,
    fontWeight: FontWeight.w800,
    color: c.onCheckout,
  );

  TextStyle get checkoutLabel => TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 15,
    fontWeight: FontWeight.w800,
    color: c.onCheckout,
  );
}
