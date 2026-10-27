import 'package:flutter/widgets.dart';

/// Tokens de la **capa POS de escritorio**, calcados de la captura de FullPOS
/// Cloud (1920×1080) y de `apps/fulltech_app/lib/core/theme/app_colors.dart`
/// del repositorio autorizado `PRODUCTOS\DaleVentas POS`.
///
/// Ámbito: solo `features/pos_desktop` y la presentación del POS. El chat tiene
/// sus propios tokens (`features/whatsapp/desktop`) y no se toca.
abstract final class PosColors {
  /// `AppColors.primary` del POS.
  static const Color primary = Color(0xFF1957E6);
  static const Color primaryDark = Color(0xFF123A75);
  static const Color primarySoft = Color(0xFFEAF1FF);
  static const Color primaryBorder = Color(0xFFCFE0FF);

  /// `AppColors.background`.
  static const Color pageBg = Color(0xFFEFF5F8);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceMuted = Color(0xFFF4F8FB);

  static const Color ink = Color(0xFF102235);
  static const Color inkSecondary = Color(0xFF52667C);
  static const Color border = Color(0xFFDDE7EE);
  static const Color borderSoft = Color(0xFFEDF1F6);

  static const Color success = Color(0xFF16A34A);
  static const Color warning = Color(0xFFB45309);
  static const Color danger = Color(0xFFDC2626);

  /// Azul del botón «Cobrar» (bloque grande de la captura).
  static const Color checkout = Color(0xFF1957E6);
}

/// Medidas tomadas de la captura (ventana 1920×1080).
abstract final class PosMetrics {
  /// Barra superior blanca con borde inferior.
  static const double toolbarHeight = 56;

  /// Ancho del panel de venta (carrito): 546 px en la captura ≈ 28 % del ancho.
  static double cartWidth(double screenWidth) => (screenWidth * 0.28).clamp(320.0, 480.0);

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

abstract final class PosText {
  static const TextStyle title = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 16,
    fontWeight: FontWeight.w800,
    color: PosColors.ink,
  );
  static const TextStyle cardName = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w700,
    color: PosColors.ink,
    height: 1.2,
  );
  static const TextStyle cardPrice = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 14.5,
    fontWeight: FontWeight.w800,
    color: PosColors.ink,
  );
  static const TextStyle pill = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w700,
    color: PosColors.primary,
  );
  static const TextStyle body = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    color: PosColors.ink,
  );
  static const TextStyle secondary = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 12,
    fontWeight: FontWeight.w500,
    color: PosColors.inkSecondary,
  );
  static const TextStyle total = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 22,
    fontWeight: FontWeight.w800,
    color: PosColors.surface,
  );
  static const TextStyle checkoutLabel = TextStyle(
    fontFamily: PosMetrics.fontFamily,
    fontSize: 15,
    fontWeight: FontWeight.w800,
    color: PosColors.surface,
  );
}
