import 'package:flutter/material.dart';

/// Tokens EXCLUSIVOS del módulo de conversaciones de escritorio.
///
/// Referencia visual: captura de WhatsApp Desktop aportada por el usuario
/// (1920×1080). Los valores oscuros se muestrearon pixel a pixel sobre la
/// captura; los claros son el mismo lenguaje sobre la paleta clara de WhatsApp
/// Web, de modo que el módulo respeta el modo (claro/oscuro) que haya elegido
/// el usuario en el panel.
///
/// Ámbito: **solo** `features/whatsapp/desktop`.
@immutable
class ChatPalette {
  const ChatPalette({
    required this.dark,
    required this.railBg,
    required this.panelBg,
    required this.canvas,
    required this.divider,
    required this.fieldBg,
    required this.composerBg,
    required this.bubbleIn,
    required this.bubbleOut,
    required this.textPrimary,
    required this.textSecondary,
    required this.accent,
    required this.rowHover,
    required this.rowSelected,
    required this.doodle,
    required this.warning,
    required this.danger,
  });

  final bool dark;

  /// Fondo del rail de navegación.
  final Color railBg;

  /// Fondo de paneles: lista, encabezado del hilo.
  final Color panelBg;

  /// Lienzo del hilo: distinto del panel para que las burbujas se lean.
  final Color canvas;

  /// Líneas de 1 px entre zonas.
  final Color divider;

  /// Campo de búsqueda y caja de redacción.
  final Color fieldBg;

  /// Composer inferior (burbuja de escritura).
  final Color composerBg;

  /// Burbuja entrante.
  final Color bubbleIn;

  /// Burbuja saliente.
  final Color bubbleOut;

  /// Texto principal.
  final Color textPrimary;

  /// Texto secundario (hora, vista previa, teléfono).
  final Color textSecondary;

  /// Acento de la referencia (badges, indicador activo, chip seleccionado).
  final Color accent;

  /// Fila bajo el cursor.
  final Color rowHover;

  /// Fila seleccionada.
  final Color rowSelected;

  /// Trazo del patrón del fondo (original, no es el recurso propietario).
  final Color doodle;

  /// Aviso de estado pendiente / error.
  final Color warning;
  final Color danger;

  /// Tema oscuro: la referencia original, con superficies algo más profundas.
  static const ChatPalette darkPalette = ChatPalette(
    dark: true,
    railBg: Color(0xFF14181A),
    panelBg: Color(0xFF171A1B),
    canvas: Color(0xFF101314),
    divider: Color(0xFF262B2C),
    fieldBg: Color(0xFF202425),
    composerBg: Color(0xFF202425),
    bubbleIn: Color(0xFF202425),
    bubbleOut: Color(0xFF124C3A),
    textPrimary: Color(0xFFF1F3F3),
    textSecondary: Color(0xFF98A2A6),
    accent: Color(0xFF25D366),
    rowHover: Color(0xFF1C2021),
    rowSelected: Color(0xFF24292A),
    doodle: Color(0xFF191D1E),
    warning: Color(0xFFE9A23B),
    danger: Color(0xFFF15C6D),
  );

  /// Tema claro al estilo WhatsApp: lienzo beige, lista blanca y bordes visibles.
  static const ChatPalette light = ChatPalette(
    dark: false,
    railBg: Color(0xFFF0F2F5),
    panelBg: Color(0xFFFFFFFF),
    canvas: Color(0xFFEFEAE2),
    divider: Color(0xFFD3DBE0),
    fieldBg: Color(0xFFF0F2F5),
    composerBg: Color(0xFFFFFFFF),
    bubbleIn: Color(0xFFFFFFFF),
    bubbleOut: Color(0xFFD9FDD3),
    textPrimary: Color(0xFF111B21),
    textSecondary: Color(0xFF667781),
    accent: Color(0xFF00A884),
    rowHover: Color(0xFFF5F6F6),
    rowSelected: Color(0xFFEBEDEF),
    doodle: Color(0xFFE4DED2),
    warning: Color(0xFFB45309),
    danger: Color(0xFFDC2626),
  );

  /// Paleta del tema que eligió el usuario.
  static ChatPalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? darkPalette : light;

  /// Escala tipográfica ya coloreada con esta paleta.
  ChatText get text => ChatText(this);
}

/// Medidas tomadas de la captura (px lógicos con la ventana a 1920×1080).
abstract final class ChatDesktopMetrics {
  /// Ancho del rail: la zona `0..57` es #1D1F1F y en `x=58` está la línea.
  static const double railWidth = 58;

  /// Ancho del panel de conversaciones: `x=59..399`, línea en `x=400`.
  /// Se amplía a 408 px para que quepan asignación y etapa en cada fila.
  static const double listWidth = 408;

  /// Alto del encabezado del hilo (versión fina y compacta).
  static const double headerHeight = 46;

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
@immutable
class ChatText {
  const ChatText(this.c);

  final ChatPalette c;

  TextStyle get title => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 22,
    fontWeight: FontWeight.w600,
    color: c.textPrimary,
    height: 1.2,
  );

  TextStyle get rowName => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 15,
    fontWeight: FontWeight.w600,
    color: c.textPrimary,
    height: 1.25,
  );

  TextStyle get rowPreview => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 13,
    fontWeight: FontWeight.w400,
    color: c.textSecondary,
    height: 1.25,
  );

  TextStyle get stamp => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w400,
    color: c.textSecondary,
  );

  TextStyle get headerName => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 16,
    fontWeight: FontWeight.w600,
    color: c.textPrimary,
  );

  TextStyle get headerSubtitle => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w400,
    color: c.textSecondary,
  );

  TextStyle get bubbleBody => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 14,
    fontWeight: FontWeight.w400,
    color: c.textPrimary,
    height: 1.35,
  );

  TextStyle get bubbleMeta => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11,
    fontWeight: FontWeight.w400,
    color: c.textSecondary,
  );

  TextStyle get author => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12,
    fontWeight: FontWeight.w600,
    color: c.accent,
  );

  TextStyle get chip => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
  );

  TextStyle get dateDivider => TextStyle(
    fontFamily: ChatDesktopMetrics.fontFamily,
    fontSize: 11.5,
    fontWeight: FontWeight.w500,
    color: c.textSecondary,
  );
}

/// Tema Material del módulo, con la luminosidad activa.
ThemeData buildChatDesktopTheme(BuildContext context) {
  final c = ChatPalette.of(context);
  return ThemeData(
    useMaterial3: true,
    brightness: c.dark ? Brightness.dark : Brightness.light,
    fontFamily: ChatDesktopMetrics.fontFamily,
    scaffoldBackgroundColor: c.panelBg,
    colorScheme: (c.dark ? const ColorScheme.dark() : const ColorScheme.light()).copyWith(
      primary: c.accent,
      surface: c.fieldBg,
      onSurface: c.textPrimary,
    ),
    inputDecorationTheme: const InputDecorationTheme(filled: false),
    chipTheme: ChipThemeData(
      backgroundColor: c.fieldBg,
      selectedColor: c.rowSelected,
      side: BorderSide.none,
      labelStyle: TextStyle(
        fontFamily: ChatDesktopMetrics.fontFamily,
        fontSize: 12.5,
        color: c.textPrimary,
      ),
    ),
    popupMenuTheme: PopupMenuThemeData(color: c.fieldBg),
    dialogTheme: DialogThemeData(backgroundColor: c.fieldBg),
  );
}
