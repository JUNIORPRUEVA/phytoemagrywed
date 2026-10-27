import 'package:flutter/material.dart';

/// Tokens EXCLUSIVOS del módulo de conversaciones de escritorio.
///
/// Referencia visual: captura de WhatsApp Desktop aportada por el usuario
/// (1920×1080). Los valores se muestrearon pixel a pixel sobre la captura:
/// no son estimaciones de una imagen que no se haya podido abrir.
///
/// Ámbito: **solo** `features/whatsapp/desktop`. El resto del CRM mantiene su
/// tema; este módulo es deliberadamente oscuro porque la referencia lo es.
abstract final class ChatDesktopColors {
  /// Fondo del rail de navegación (muestreado en x=14).
  static const Color railBg = Color(0xFF1D1F1F);

  /// Fondo de paneles: lista, encabezado del hilo y lienzo del chat.
  static const Color panelBg = Color(0xFF161717);

  /// Líneas de 1 px entre zonas (y=35, x=58, x=400 en la captura).
  static const Color divider = Color(0xFF2E2F2F);

  /// Campo de búsqueda y caja de redacción.
  static const Color fieldBg = Color(0xFF2E2F2F);

  /// Composer inferior (burbuja de escritura).
  static const Color composerBg = Color(0xFF242626);

  /// Burbuja entrante.
  static const Color bubbleIn = Color(0xFF242626);

  /// Burbuja saliente (verde oscuro muestreado en la captura).
  static const Color bubbleOut = Color(0xFF144D37);

  /// Texto principal.
  static const Color textPrimary = Color(0xFFFAFAFA);

  /// Texto secundario (hora, vista previa, teléfono).
  static const Color textSecondary = Color(0xFFC0C1C1);

  /// Acento de la referencia (badges, indicador activo, chip seleccionado).
  static const Color accent = Color(0xFF25D366);

  /// Fila bajo el cursor.
  static const Color rowHover = Color(0xFF202121);

  /// Fila seleccionada.
  static const Color rowSelected = Color(0xFF2A2B2B);

  /// Trazo del patrón del fondo (original, no es el recurso propietario).
  static const Color doodle = Color(0xFF262727);

  /// Aviso de estado pendiente / error.
  static const Color warning = Color(0xFFE9A23B);
  static const Color danger = Color(0xFFF15C6D);
}

/// Medidas tomadas de la captura (px lógicos con la ventana a 1920×1080).
abstract final class ChatDesktopMetrics {
  /// Ancho del rail: la zona `0..57` es #1D1F1F y en `x=58` está la línea.
  static const double railWidth = 58;

  /// Ancho del panel de conversaciones: `x=59..399`, línea en `x=400`.
  static const double listWidth = 342;

  /// Alto del encabezado del hilo: `y=36..91` (línea en `y=35`).
  static const double headerHeight = 56;

  /// Alto del área de redacción.
  static const double composerHeight = 104;

  static const double avatarRail = 34;
  static const double avatarList = 48;
  static const double avatarHeader = 40;
  static const double rowHeight = 72;
  static const double searchHeight = 38;
  static const double chipHeight = 28;
  static const double bubbleRadius = 8;
  static const double bubbleRadiusTail = 2;
  static const double maxBubbleWidthFactor = 0.62;

  /// WhatsApp Desktop en Windows usa la tipografía del sistema.
  static const String fontFamily = 'Segoe UI';
}

/// Escala tipográfica deducida de la captura (nombre 15, vista previa 13,
/// hora 11, título "Chats" 22).
/// Tema oscuro del módulo de chat (toda la pantalla, no solo el hilo).
ThemeData buildChatDesktopTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    fontFamily: ChatDesktopMetrics.fontFamily,
    scaffoldBackgroundColor: ChatDesktopColors.panelBg,
    colorScheme: const ColorScheme.dark(
      primary: ChatDesktopColors.accent,
      surface: ChatDesktopColors.fieldBg,
      onSurface: ChatDesktopColors.textPrimary,
    ),
    inputDecorationTheme: const InputDecorationTheme(filled: false),
    chipTheme: const ChipThemeData(
      backgroundColor: ChatDesktopColors.fieldBg,
      selectedColor: ChatDesktopColors.rowSelected,
      side: BorderSide.none,
      labelStyle: TextStyle(
        fontFamily: ChatDesktopMetrics.fontFamily,
        fontSize: 12.5,
        color: ChatDesktopColors.textPrimary,
      ),
    ),
    popupMenuTheme: const PopupMenuThemeData(color: ChatDesktopColors.fieldBg),
    dialogTheme: const DialogThemeData(
      backgroundColor: ChatDesktopColors.fieldBg,
    ),
  );
}

abstract final class ChatDesktopText {
  static const TextStyle title = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 22,
    fontWeight: FontWeight.w600,
    color: ChatDesktopColors.textPrimary,
    height: 1.2,
  );
  static const TextStyle rowName = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 15,
    fontWeight: FontWeight.w600,
    color: ChatDesktopColors.textPrimary,
    height: 1.25,
  );
  static const TextStyle rowPreview = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 13,
    fontWeight: FontWeight.w400,
    color: ChatDesktopColors.textSecondary,
    height: 1.25,
  );
  static const TextStyle stamp = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w400,
    color: ChatDesktopColors.textSecondary,
  );
  static const TextStyle headerName = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 16,
    fontWeight: FontWeight.w600,
    color: ChatDesktopColors.textPrimary,
  );
  static const TextStyle headerSubtitle = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w400,
    color: ChatDesktopColors.textSecondary,
  );
  static const TextStyle bubbleBody = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 14,
    fontWeight: FontWeight.w400,
    color: ChatDesktopColors.textPrimary,
    height: 1.35,
  );
  static const TextStyle bubbleMeta = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w400,
    color: ChatDesktopColors.textSecondary,
  );
  static const TextStyle author = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12,
    fontWeight: FontWeight.w600,
    color: ChatDesktopColors.accent,
  );
  static const TextStyle chip = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
  );
  static const TextStyle dateDivider = TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11.5,
    fontWeight: FontWeight.w500,
    color: ChatDesktopColors.textSecondary,
  );
}
