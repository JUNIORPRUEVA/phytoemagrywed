import 'package:flutter/widgets.dart';

/// Tokens del panel — **fuente de verdad: el CRM PWA** (`public/admin`).
///
/// Los valores salen del CSS real y de `getComputedStyle` medido sobre el panel
/// servido por el backend UAT (1920×1080), no de estimaciones: `admin.css`
/// (`:root`), `shell-v2-tema.css`, `navigation.css`, `drawer-menu.css`,
/// `panel-desktop.css`, `wa-lista.css`, `pos.css`.
///
/// FullPOS Cloud **ya no es la referencia**: si un valor de aquí contradice al
/// POS, manda el PWA.
///
/// Regla de la casa: ninguna pantalla escribe un color, un radio o un alto a
/// mano. Todo pasa por este archivo.
class CrmColors {
  const CrmColors._();

  // ------------------------------------------------------------------ marca
  /// `--phyto-primary` (claro).
  static const Color primary = Color(0xFF145BD7);

  /// `--phyto-primary-dark`.
  static const Color primaryDark = Color(0xFF103E91);

  /// `--phyto-primary-soft`.
  static const Color primarySoft = Color(0xFFE5EFFF);

  /// `--phyto-primary-tint`.
  static const Color primaryTint = Color(0xFFF1F6FF);

  /// Borde suave de la marca (`color-mix(primary 22%)` sobre claro).
  static const Color primaryBorder = Color(0x38145BD7);

  /// `--pe-brand-800`.
  static const Color brand800 = Color(0xFF124BAA);

  /// Acento secundario (avisos «en vivo»).
  static const Color accent = Color(0xFF128C68);

  // ------------------------------------------------------------- superficies
  /// `--surface`.
  static const Color surface = Color(0xFFFFFFFF);

  /// `--surface-muted` / `--pe-page-bg`.
  static const Color surfaceAlt = Color(0xFFF4F7FC);
  static const Color surfaceMuted = Color(0xFFF4F7FC);

  /// `--pe-chip-bg` (`#edf3fc`): fondo de filtros y píldoras.
  static const Color surfaceSubtle = Color(0xFFEDF3FC);

  /// Fondo de página (en la práctica lo cubre [CrmGradients.page]).
  static const Color pageBg = Color(0xFFF4F7FD);

  static const Color chipBg = Color(0xFFEDF3FC);

  /// `--surface-tint`.
  static const Color surfaceTint = Color(0xFFEDF4FF);

  // ------------------------------------------------------------------- texto
  /// `--text-primary`.
  static const Color ink = Color(0xFF14243D);

  /// Cifra grande de una métrica (medido: `#071126`).
  static const Color inkStrong = Color(0xFF071126);

  /// `--pe-ink-700`.
  static const Color ink700 = Color(0xFF34465F);

  /// `--text-secondary` (rótulo de métrica medido: `#3b5061`).
  static const Color inkSecondary = Color(0xFF53647D);

  static const Color inkMuted = Color(0xFF53647D);

  /// `--border`.
  static const Color border = Color(0xFFDCE5F2);

  /// `--pe-line`.
  static const Color borderStrong = Color(0xFFDFE7F4);

  /// `--border-soft`: `rgba(23, 43, 77, 0.08)`.
  static const Color line = Color(0x14172B4D);

  /// `--pe-hairline`: `rgba(23, 43, 77, 0.06)` — la raya que solo se intuye.
  static const Color hairline = Color(0x0F172B4D);

  /// Borde del topbar flotante: `rgba(20, 91, 215, 0.09)`.
  static const Color topbarBorder = Color(0x17145BD7);

  // ----------------------------------------------------------------- estados
  /// `--danger`.
  static const Color danger = Color(0xFFB3261E);
  static const Color dangerSoft = Color(0xFFFDEAEA);
  static const Color dangerBorder = Color(0xFFF3C9C6);

  /// `--warning` (`#7a4c00`) y `--pe-warn-bg`.
  static const Color warning = Color(0xFF7A4C00);
  static const Color warnBg = Color(0xFFFFF6E5);
  static const Color warningBorder = Color(0xFFF0DDB8);

  /// `--success`.
  static const Color success = Color(0xFF128C68);

  /// `--order-bg` de un pedido entregado (`#ebf7ef`).
  static const Color successSoft = Color(0xFFEBF7EF);
  static const Color successBorder = Color(0x1C145BD7);

  /// `--pe-info-bg` / `--pe-info`.
  static const Color infoBg = Color(0xFFEAF5FA);
  static const Color info = Color(0xFF0D4F6C);

  /// `--pe-whatsapp`.
  static const Color whatsapp = Color(0xFF0E7A3D);

  /// `--pe-audio-out-bg` (`#d3f0df`) y burbuja saliente.
  static const Color whatsappSoft = Color(0xFFD3F0DF);

  // ------------------------------------------------- pedidos (tintes reales)
  static const Color orderPendingBg = Color(0xFFFDF0EF);
  static const Color orderPendingLine = Color(0x1FC93D3D);
  static const Color orderPendingTone = Color(0xFFC93D3D);

  static const Color orderConfirmedBg = Color(0xFFEEF3FE);
  static const Color orderConfirmedLine = Color(0x1F1C56D6);
  static const Color orderConfirmedTone = Color(0xFF1C56D6);

  static const Color orderRouteBg = Color(0xFFFFF3E8);
  static const Color orderRouteLine = Color(0x1FC05621);
  static const Color orderRouteTone = Color(0xFFC05621);

  static const Color orderDeliveredBg = Color(0xFFEBF7EF);
  static const Color orderDeliveredLine = Color(0x1C145BD7);
  static const Color orderDeliveredTone = Color(0xFF145BD7);

  static const Color orderCancelledBg = Color(0xFFF4F5F5);
  static const Color orderCancelledLine = Color(0x247C8481);
  static const Color orderCancelledTone = Color(0xFF7C8481);

  // ------------------------------------------------------- oscuro (PWA real)
  /// `:root[data-theme='dark']`.
  static const Color darkPrimary = Color(0xFF8DBBFF);
  static const Color darkPrimaryDark = Color(0xFFB3D2FF);
  static const Color darkPrimarySoft = Color(0xFF203B60);
  static const Color darkPrimaryTint = Color(0xFF152B47);

  static const Color darkPageBg = Color(0xFF0B1626);
  static const Color darkSurface = Color(0xFF111D30);
  static const Color darkSurfaceMuted = Color(0xFF18263C);
  static const Color darkCard = Color(0xFF152339);
  static const Color darkChipBg = Color(0xFF1E304A);

  static const Color darkInk = Color(0xFFEAF1FD);
  static const Color darkInkSecondary = Color(0xFFAFC0D9);
  static const Color darkBorder = Color(0xFF354866);
  static const Color darkDanger = Color(0xFFFF7A6E);
  static const Color darkWarning = Color(0xFFF0C274);
  static const Color darkSuccess = Color(0xFF54DDA2);
  static const Color darkWhatsapp = Color(0xFF54DDA2);

  // --------------------------------------------------------- burbujas (chat)
  /// `--pe-bubble-in` / `--pe-bubble-out`.
  static const Color bubbleIn = Color(0xFFFFFFFF);
  static const Color bubbleOut = Color(0xFFE4F3EA);
  static const Color darkBubbleIn = Color(0xFF1C2A40);
  static const Color darkBubbleOut = Color(0xFF1C4170);

  /// Fondo del hilo (`wa-lista.css`) y su versión oscura.
  static const Color threadBg = Color(0xFFEFEAE3);
  static const Color darkThreadBg = Color(0xFF0B1626);
}

/// Radios reales del panel: campo **12** · píldora de icono **11** · tarjeta de
/// pedido **14** · tarjeta/métrica **18** · barra flotante **20** · círculo 999.
class CrmRadii {
  const CrmRadii._();
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 18;
  static const double xl = 20;
  static const double field = 12;
  static const double pill = 999;
}

/// Espaciado, alturas y medidas del shell **medidas sobre el PWA**.
class CrmSpace {
  const CrmSpace._();
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;

  /// `--space-1..5` del PWA: 4 / 8 / 12 / 16 / 24.
  static double pad(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    if (width >= 980) return 24;
    return 16;
  }

  /// Alto mínimo de un control táctil (regla de la casa: nunca menos de 44 px).
  static const double touch = 44;

  /// Breakpoint del PWA: por debajo es móvil, por encima es «vista PC».
  /// Todas las media queries del panel usan **980 px**.
  static const double desktopBreakpoint = 980;

  /// A partir de aquí las listas de tarjetas van a dos columnas
  /// (`panel-desktop.css`).
  static const double twoColumnBreakpoint = 1200;

  /// El chat del PWA ya es de dos paneles desde 980 px.
  static const double chatThreePaneBreakpoint = 1366;
}

/// Geometría del shell del PWA (medida en el panel real).
class CrmShellMetrics {
  const CrmShellMetrics._();

  /// Topbar flotante: 56 px de alto, radio 20, a 18 px del borde superior.
  static const double topbarHeight = 56;
  static const double topbarTop = 18;
  static const double topbarRight = 28;

  /// Botón de menú flotante: 54×54, radio 18, en (28, 20).
  static const double menuButtonSize = 54;
  static const double menuButtonLeft = 28;
  static const double menuButtonTop = 20;

  /// Lienzo del contenido: máx. 1320, padding 20/24/48, empieza en y=92.
  static const double canvasMaxWidth = 1320;
  static const double canvasTop = 92;
  static const double canvasPadTop = 20;
  static const double canvasPadSide = 24;
  static const double canvasPadBottom = 48;

  /// Menú lateral: 318 px, cabecera 72, ítem 44.
  static const double drawerWidth = 318;
  static const double drawerHeadHeight = 72;
  static const double drawerItemHeight = 44;

  /// Rejilla de métricas de Hoy: 5 columnas a 1920, 14 px de separación.
  static const double statGridGap = 14;
  static const double statCardMinWidth = 240;
  static const double statCardHeight = 110;
  static const double statIconBox = 42;

  /// Barra inferior del móvil (`--pe-tabbar`).
  static const double mobileTabbar = 64;

  /// Chat: la lista del PWA ocupa 430 px a 1920.
  static const double chatListWidth = 430;
  static const double chatListMinWidth = 320;
  static const double chatContextWidth = 320;
  static const double chatPaneMinWidth = 380;

  // Compatibilidad con el shell anterior (FullPOS): el menú ya no es fijo.
  static double sidebarWidth(double screenWidth) => drawerWidth;
  static double sidebarCollapsedWidth(double screenWidth) => drawerWidth;
  static double menuItemHeight(double screenHeight, {required bool collapsed}) => drawerItemHeight;

  /// Nº de columnas de la rejilla de métricas para un ancho dado.
  static int statColumns(double availableWidth) {
    if (availableWidth >= 1200) return 5;
    if (availableWidth >= 900) return 4;
    return 2;
  }

  /// Columnas de una lista de tarjetas (`panel-desktop.css` ≥ 1200 → 2).
  static int cardColumns(double availableWidth) => availableWidth >= 1200 ? 2 : 1;
}

/// Sombras exactas del panel (medidas con `getComputedStyle`).
class CrmShadows {
  const CrmShadows._();

  static const List<BoxShadow> none = [];

  /// Topbar flotante: `0 14px 34px rgba(14, 27, 22, 0.09)`.
  static const List<BoxShadow> topbar = [
    BoxShadow(color: Color(0x17140E1B), blurRadius: 34, offset: Offset(0, 14)),
  ];

  /// Botón de menú: `0 14px 32px rgba(20, 60, 120, 0.13)`.
  static const List<BoxShadow> menuButton = [
    BoxShadow(color: Color(0x21143C78), blurRadius: 32, offset: Offset(0, 14)),
  ];

  /// Tarjeta de pedido: `0 8px 20px rgba(14, 27, 22, 0.05)`.
  static const List<BoxShadow> card = [
    BoxShadow(color: Color(0x0D140E1B), blurRadius: 20, offset: Offset(0, 8)),
  ];

  /// Métrica: `0 16px 34px` con el tinte de su propio estado
  /// (medido en la tarjeta ámbar: `rgba(146, 64, 14, 0.14)`).
  static List<BoxShadow> statTinted(Color tone) => [
        BoxShadow(color: tone.withValues(alpha: 0.14), blurRadius: 34, offset: const Offset(0, 16)),
      ];

  static const List<BoxShadow> stat = [
    BoxShadow(color: Color(0x2492400E), blurRadius: 34, offset: Offset(0, 16)),
  ];
  /// Menú lateral: `10px 0 34px rgba(0,0,0,0.14)`.
  static const List<BoxShadow> drawer = [
    BoxShadow(color: Color(0x24000000), blurRadius: 34, offset: Offset(10, 0)),
  ];

  static const List<BoxShadow> sm = [
    BoxShadow(color: Color(0x0D140E1B), blurRadius: 8, offset: Offset(0, 2)),
  ];

  static const List<BoxShadow> md = [
    BoxShadow(color: Color(0x17140E1B), blurRadius: 20, offset: Offset(0, 6)),
  ];
}

/// Degradados del panel.
class CrmGradients {
  const CrmGradients._();

  /// Fondo medido del `body` (dos capas):
  /// `radial-gradient(at 90% 0%, #dcecff, transparent 48%)` +
  /// `linear-gradient(160deg, #fff 0%, #f4f7fd 65%, #edf4ff 100%)`.
  static const RadialGradient pageGlow = RadialGradient(
    center: Alignment(0.8, -1.0),
    radius: 0.9,
    colors: [Color(0xFFDCECFF), Color(0x00DCECFF)],
    stops: [0.0, 0.48],
  );

  static const LinearGradient page = LinearGradient(
    begin: Alignment(-0.68, -0.94),
    end: Alignment(0.68, 0.94),
    colors: [Color(0xFFFFFFFF), Color(0xFFF4F7FD), Color(0xFFEDF4FF)],
    stops: [0.0, 0.65, 1.0],
  );

  /// Botón principal del PWA:
  /// `linear-gradient(125deg, #124baa 0%, #1766e8 58%, #1c6cdb 100%)`.
  static const LinearGradient primaryButton = LinearGradient(
    begin: Alignment(-0.82, -0.57),
    end: Alignment(0.82, 0.57),
    colors: [Color(0xFF124BAA), Color(0xFF1766E8), Color(0xFF1C6CDB)],
    stops: [0.0, 0.58, 1.0],
  );

  /// Fondo oscuro del panel.
  static const LinearGradient darkPage = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0B1626), Color(0xFF0E1B2E)],
  );
}

/// Iconos **originales del PWA** (`public/admin/assets/icons`), copiados tal cual
/// a `assets/pwa/icons`. Son siluetas negras con transparencia: se pintan con
/// `PwaIcon` para seguir el tema sin inventar iconos.
class PwaIcons {
  const PwaIcons._();

  static const String base = 'assets/pwa/icons/';

  static const String sun = '${base}sun.png';
  static const String support = '${base}support.png';
  static const String orders = '${base}orders.png';
  static const String user = '${base}user.png';
  static const String clientes = '${base}clientes.png';
  static const String cart = '${base}cart.png';
  static const String billing = '${base}billing.png';
  static const String delivery = '${base}delivery.png';
  static const String custody = '${base}custody.png';
  static const String couriers = '${base}couriers.png';
  static const String robot = '${base}robot.png';
  static const String chart = '${base}chart.png';
  static const String share = '${base}share.png';
  static const String usersadd = '${base}usersadd.png';
  static const String menu = '${base}menu.png';
  static const String back = '${base}back.png';
  static const String bell = '${base}bell.png';
  static const String filter = '${base}filter.png';
  static const String logout = '${base}logout.png';
  static const String moon = '${base}moon.png';
  static const String refresh = '${base}refresh.png';
  static const String search = '${base}search.png';
  static const String plus = '${base}plus.png';
  static const String chevronDown = '${base}chevron-down.png';
  static const String chevronUp = '${base}chevron-up.png';
  static const String tickets = '${base}tickets.png';
  static const String remove = '${base}remove.png';
  static const String whatsapp = '${base}whatsapp.png';
  static const String chatSearch = '${base}chat-search.png';
  static const String chatSend = '${base}chat-send.png';
  static const String chatCall = '${base}chat-call.png';
  static const String chatMic = '${base}chat-microphone.png';

  /// Logotipo de marca (PNG con color propio, no se tiñe).
  static const String brandLogo = 'assets/pwa/branding/fulltech-crm-256.png';
}
