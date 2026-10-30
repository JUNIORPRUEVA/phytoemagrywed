import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/crm_app.dart';
import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/local/outbox.dart';
import '../../data/models/partial_data_notice.dart';
import '../ajustes/ajustes_screen.dart';
import '../cierre/cierre_screen.dart';
import '../clientes/clientes_screen.dart';
import '../common/crm_ui.dart';
import '../common/pwa_icon.dart';
import '../entregas/custodia_screen.dart';
import '../entregas/mapa_screen.dart';
import '../entregas/repartidores_screen.dart';
import '../hoy/hoy_screen.dart';
import '../ops/ops_screen.dart';
import '../pedidos/pedidos_screen.dart';
import '../perfil/perfil_screen.dart';
import '../reportes/reportes_screen.dart';
import '../seguimiento/mensajes_screen.dart';
import '../seguimiento/seguimientos_screen.dart';
import '../usuarios/usuarios_screen.dart';
import '../ventas/catalogo_screen.dart';
import '../ventas/cotizaciones_screen.dart';
import '../ventas/inventario_screen.dart';
import '../ventas/pos_screen.dart';
import '../ventas/recogidas_screen.dart';
import '../ventas/recuento_screen.dart';
import '../ventas/solicitudes_screen.dart';
import '../ventas/tiendas_screen.dart';
import '../whatsapp/chats_desktop.dart';
import '../whatsapp/whatsapp_screen.dart';
import 'crm_menu_drawer.dart';
import '../../core/config/app_config.dart';
import 'pwa_shell.dart';

/// Un destino del menú (`data-tab` del panel). [image] es el **icono original
/// del PWA**; [icon] queda solo para la barra inferior del móvil.
class CrmDestination {
  const CrmDestination(this.tab, this.label, this.icon, {this.image = PwaIcons.orders, this.group = ''});

  final String tab;
  final String label;
  final IconData icon;
  final String image;
  final String group;
}

/// Los mismos módulos del CRM, con los grupos y los iconos del PWA.
///
/// El primer grupo es **«Punto de Ventas (POS)»**: agrupa los seis módulos
/// comerciales que en FullPOS Cloud cuelgan del menú «Ventas». Los duplicados
/// de esos seis se han retirado de sus grupos anteriores (la ruta sigue
/// existiendo, solo cambia dónde aparece).
const List<CrmDestination> crmDestinations = [
  CrmDestination('whatsapp', 'WhatsApp', Icons.forum_outlined, image: PwaIcons.support),
  CrmDestination('pedidos', 'Pedidos', Icons.receipt_long_outlined, image: PwaIcons.orders),
  CrmDestination('clientes', 'Clientes', Icons.people_outline_rounded, image: PwaIcons.clientes),
  CrmDestination('pos', 'Facturación', Icons.point_of_sale_rounded, image: PwaIcons.billing, group: 'Ventas'),
  CrmDestination('inventario', 'Ajuste de stock', Icons.inventory_2_outlined, image: PwaIcons.orders, group: 'Ventas'),
  CrmDestination('cotizaciones', 'Cotizaciones', Icons.description_outlined, image: PwaIcons.billing, group: 'Ventas'),
  CrmDestination('solicitudes', 'Archivo de solicitudes', Icons.folder_copy_outlined, image: PwaIcons.orders, group: 'Ventas'),
  CrmDestination('recuento', 'Recuento', Icons.fact_check_outlined, image: PwaIcons.orders, group: 'Ventas'),
  CrmDestination('recogidas', 'Recogidas', Icons.shopping_bag_outlined, image: PwaIcons.cart, group: 'Ventas'),
  CrmDestination('tiendas', 'Tiendas', Icons.storefront_rounded, image: PwaIcons.cart, group: 'Ventas'),
  CrmDestination('catalogo', 'Tienda en línea', Icons.storefront_outlined, image: PwaIcons.cart, group: 'Ventas'),
  CrmDestination('mapa', 'Mapa', Icons.map_outlined, image: PwaIcons.delivery, group: 'Entregas'),
  CrmDestination('custodia', 'Custodia y rendiciones', Icons.account_balance_wallet_outlined, image: PwaIcons.custody, group: 'Entregas'),
  CrmDestination('repartidores', 'Repartidores', Icons.delivery_dining_outlined, image: PwaIcons.couriers, group: 'Entregas'),
  CrmDestination('ops', 'Agentes IA', Icons.smart_toy_outlined, image: PwaIcons.robot),
  CrmDestination('cierre', 'Cierre actual', Icons.check_circle_outline_rounded, image: PwaIcons.chart, group: 'Cierre diario'),
  CrmDestination('reportes', 'Reportes', Icons.insert_chart_outlined, image: PwaIcons.chart),
  CrmDestination('seguimientos', 'Seguimientos', Icons.event_repeat_outlined, image: PwaIcons.share, group: 'Operación'),
  CrmDestination('mensajes', 'Mensajes programados', Icons.schedule_send_outlined, image: PwaIcons.bell, group: 'Operación'),
  CrmDestination('ajustes', 'Configuración', Icons.settings_outlined, image: PwaIcons.filter),
  CrmDestination('usuarios', 'Usuarios', Icons.group_add_outlined, image: PwaIcons.usersadd, group: 'Operación'),
  CrmDestination('perfil', 'Mi perfil', Icons.person_outline_rounded, image: PwaIcons.user),
];

/// Esqueleto del panel, reconstruido sobre el **CRM PWA**.
///
/// · **Escritorio (≥ 980 px)**: botón de menú flotante arriba a la izquierda,
///   barra superior flotante de 56 px y lienzo centrado de 1320 px. No hay menú
///   lateral fijo: el PWA no lo tiene.
/// · **Móvil**: cabecera compacta de 52 px y barra inferior de 4 destinos, que
///   el PWA muestra **solo en Hoy** (`body:not([data-tab='hoy']) .tabs`).
class CrmShell extends StatefulWidget {
  const CrmShell({super.key, this.initialTab = 'whatsapp', this.initialMenuOpen = false});

  /// Módulo inicial (el arnés de diseño lo usa para capturar pantalla por
  /// pantalla).
  final String initialTab;

  /// Abre el menú al arrancar (lo usa el arnés de capturas).
  final bool initialMenuOpen;

  @override
  State<CrmShell> createState() => _CrmShellState();
}

class _CrmShellState extends State<CrmShell> {
  late String _tab = widget.initialTab;
  late bool _menuOpen = widget.initialMenuOpen;
  void _go(String tab) {
    setState(() {
      _tab = tab;
      _menuOpen = false;
    });
  }

  Widget _body(bool desktop) => switch (_tab) {
        'hoy' => HoyScreen(onNavigate: _go),
        // En escritorio los chats ocupan el rail + la lista + el hilo.
        'whatsapp' => desktop
            ? ChatsDesktopScreen(onNavigate: _go, showRail: false)
            : const WhatsappScreen(),
        'pedidos' => const PedidosScreen(),
        'clientes' => const ClientesScreen(),
        'catalogo' => const CatalogoScreen(),
        'pos' => PosScreen(embedded: desktop, desktop: desktop),
        'inventario' => const InventarioScreen(),
        'cotizaciones' => const CotizacionesScreen(),
        'solicitudes' => const SolicitudesScreen(),
        'recuento' => const RecuentoScreen(),
        'recogidas' => const RecogidasScreen(),
        'tiendas' => const TiendasScreen(),
        'mapa' => const MapaScreen(),
        'custodia' => const CustodiaScreen(),
        'repartidores' => const RepartidoresScreen(),
        'ops' => const OpsScreen(),
        'seguimientos' => const SeguimientosScreen(),
        'mensajes' => const MensajesScreen(),
        'cierre' => const CierreScreen(),
        'reportes' => const ReportesScreen(),
        'usuarios' => const UsuariosScreen(),
        'ajustes' => const AjustesScreen(),
        _ => const PerfilScreen(),
      };

  String get _subtitle => crmDestinations.firstWhere((d) => d.tab == _tab, orElse: () => crmDestinations.first).label;

  /// Grupos del menú en el orden del PWA; los destinos sin grupo van sueltos.
  /// Secciones del menú en el ORDEN exacto de `crmDestinations`: mezcla
  /// destinos sueltos y grupos tal como aparecen (grupo, suelto, grupo…).
  List<CrmNavSection> get _navSections {
    final sections = <CrmNavSection>[];
    final seen = <String>{};
    for (final destination in crmDestinations) {
      if (destination.group.isEmpty) {
        sections.add(CrmNavSection.item(PwaNavItem(destination.tab, destination.label, destination.image)));
        continue;
      }
      if (!seen.add(destination.group)) continue;
      sections.add(
        CrmNavSection.group(
          PwaNavGroup(
            destination.group,
            [
              for (final row in crmDestinations.where((r) => r.group == destination.group))
                PwaNavItem(row.tab, row.label, row.image),
            ],
          ),
        ),
      );
    }
    return sections;
  }

  /// Entradas del rail permanente: un icono por módulo y por grupo.
  ///
  /// Los grupos (Ventas, Entregas, Operación…) no navegan solos: abren el menú
  /// lateral para elegir la opción concreta.
  List<CrmRailEntry> _railEntries(Map<String, String> badges) {
    final entries = <CrmRailEntry>[];
    for (final section in _navSections) {
      final item = section.item;
      if (item != null) {
        if (_railFooterTabs.contains(item.tab)) continue;
        entries.add(
          CrmRailEntry(
            asset: item.icon,
            label: item.label,
            selected: item.tab == _tab,
            badge: badges[item.tab] ?? item.badge,
            onTap: () => _go(item.tab),
          ),
        );
        continue;
      }
      final group = section.group!;
      entries.add(
        CrmRailEntry(
          asset: group.items.first.icon,
          label: group.label,
          selected: group.items.any((row) => row.tab == _tab),
          opensMenu: true,
          onTap: () => setState(() => _menuOpen = true),
        ),
      );
    }
    return entries;
  }

  /// Configuración, Compartir y Mi perfil: van al pie del rail, separados.
  static const Set<String> _railFooterTabs = {'ajustes', 'perfil'};

  List<CrmRailEntry> _railFooter() {
    final items = <PwaNavItem>[];
    for (final section in _navSections) {
      if (section.item != null) {
        items.add(section.item!);
      } else {
        items.addAll(section.group!.items);
      }
    }
    return [
      for (final item in items)
        if (item.tab == 'ajustes')
          CrmRailEntry(
            asset: item.icon,
            label: item.label,
            selected: item.tab == _tab,
            onTap: () => _go(item.tab),
          ),
      CrmRailEntry(
        asset: PwaIcons.share,
        label: 'Compartir',
        onTap: _sharePanelLink,
      ),
      for (final item in items)
        if (item.tab == 'perfil')
          CrmRailEntry(
            asset: item.icon,
            label: item.label,
            selected: item.tab == _tab,
            onTap: () => _go(item.tab),
          ),
    ];
  }

  String _initials(CrmState state) {
    final name = (state.session.user?.displayName ?? 'Equipo FullTECH').trim();
    final parts = name.split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    if (parts.isEmpty) return 'FT';
    if (parts.length == 1) {
      return parts.first.substring(0, parts.first.length >= 2 ? 2 : 1).toUpperCase();
    }
    return '${parts.first[0]}${parts[1][0]}'.toUpperCase();
  }

  /// Compartir: copia el enlace real del panel al portapapeles.
  Future<void> _sharePanelLink() async {
    final url = AppConfig.apiBaseUrl;
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    crmToast(context, 'Enlace copiado: $url');
  }

  List<PwaNavGroup> get _navGroups {
    final groups = <String>[];
    for (final destination in crmDestinations) {
      if (destination.group.isNotEmpty && !groups.contains(destination.group)) {
        groups.add(destination.group);
      }
    }
    final result = <PwaNavGroup>[];
    for (final group in groups) {
      result.add(
        PwaNavGroup(
          group,
          [
            for (final destination in crmDestinations.where((row) => row.group == group))
              PwaNavItem(destination.tab, destination.label, destination.image),
          ],
        ),
      );
    }
    final loose = [
      for (final destination in crmDestinations.where((row) => row.group.isEmpty))
        PwaNavItem(destination.tab, destination.label, destination.image),
    ];
    if (loose.isNotEmpty) result.add(PwaNavGroup('', loose, collapsible: false));
    return result;
  }

  String get _themeLabel => switch (CrmScope.of(context).themeMode) {
        ThemeMode.light => 'Claro',
        ThemeMode.dark => 'Oscuro',
        ThemeMode.system => 'Automático',
      };

  void _cycleTheme() {
    final state = CrmScope.of(context);
    final next = switch (state.themeMode) {
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
      ThemeMode.system => ThemeMode.light,
    };
    state.setThemeMode(next);
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final desktop = context.isDesktop;
    final badges = <String, String>{
      if (state.unreadTotal > 0) 'whatsapp': '${state.unreadTotal}',
    };

    final content = Column(
      children: [
        _ShellBanners(state: state),
        Expanded(child: _body(desktop)),
      ],
    );

    // ------------------------------------------------------------- escritorio
    // Un solo sistema visual: menú lateral y barra superior que siguen el tema
    // del usuario, con el POS y el chat dentro del mismo marco.
    if (desktop) {
      final destination =
          crmDestinations.firstWhere((row) => row.tab == _tab, orElse: () => crmDestinations.first);
      // En la bandeja la barra muestra la marca (el módulo ya se llama WhatsApp
      // en el panel de la lista); en el resto, el módulo y su grupo.
      final isWhatsapp = _tab == 'whatsapp';
      final title = isWhatsapp ? 'FULLTECH CRM' : destination.label;
      final subtitle = isWhatsapp ? '' : destination.group;
      return Scaffold(
        backgroundColor: context.crm.pageBg,
        body: Stack(
          children: [
            Column(
              children: [
                CrmLightTopbar(
                  title: title,
                  subtitle: subtitle,
                  onMenu: () => setState(() => _menuOpen = !_menuOpen),
                  menuOpen: _menuOpen,
                  unread: state.unreadTotal,
                  onBell: () => _go('whatsapp'),
                  online: !state.offline,
                  loading: state.loading,
                ),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Rail permanente: todos los iconos del menú a la vista.
                      CrmIconRail(
                        entries: _railEntries(badges),
                        bottom: _railFooter(),
                      ),
                      Expanded(child: content),
                    ],
                  ),
                ),
              ],
            ),
            if (_menuOpen) ...[
              Positioned(
                left: 0,
                right: 0,
                top: 56,
                bottom: 0,
                child: GestureDetector(
                  onTap: () => setState(() => _menuOpen = false),
                  child: Container(color: CrmColors.scrim),
                ),
              ),
              Positioned(
                left: 0,
                top: 56,
                bottom: 0,
                child: CrmDrawerEntrance(
                  child: Material(
                    elevation: 12,
                    child: CrmMenuDrawer(
                    sections: _navSections,
                    current: _tab,
                    onSelect: _go,
                    onClose: () => setState(() => _menuOpen = false),
                    onShare: _sharePanelLink,
                    userName: state.session.user?.displayName ?? 'Equipo FullTECH',
                    userRole: _roleLabel(state),
                    initials: _initials(state),
                    isDark: Theme.of(context).brightness == Brightness.dark,
                    onThemeChanged: (dark) =>
                        state.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light),
                    onLogout: () => state.logout(),
                    badges: badges,
                  ),
                ),
                ),
              ),
            ],
          ],
        ),
      );
    }

    return Stack(
      children: [
        Positioned.fill(
          child: PwaBackground(
            child: desktop
                ? Column(
                    children: [
                      const SizedBox(height: CrmShellMetrics.canvasTop),
                      // El POS ocupa TODO el ancho (como FullPOS): el lienzo
                      // centrado del PWA dejaría la rejilla en 4 columnas.
                      Expanded(
                        child: _tab == 'pos' ? content : PwaCanvas(child: content),
                      ),
                    ],
                  )
                : Column(
                    children: [
                      Padding(
                        padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top),
                        child: _MobileHeader(subtitle: _subtitle, onMenu: () => setState(() => _menuOpen = true), state: state),
                      ),
                      Expanded(child: content),
                      if (_tab == 'hoy') _MobileTabs(current: _tab, onSelect: _go, state: state),
                    ],
                  ),
          ),
        ),
        if (desktop) ...[
          Positioned(
            left: CrmShellMetrics.menuButtonLeft,
            top: CrmShellMetrics.menuButtonTop,
            child: PwaMenuButton(expanded: _menuOpen, onPressed: () => setState(() => _menuOpen = !_menuOpen)),
          ),
          Positioned(
            left: CrmShellMetrics.menuButtonLeft + CrmShellMetrics.menuButtonSize + 12,
            right: CrmShellMetrics.topbarRight,
            top: CrmShellMetrics.topbarTop,
            child: PwaTopbar(
              subtitle: _subtitle,
              online: !state.offline,
              trailing: state.loading
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : null,
            ),
          ),
        ],
        if (_menuOpen) ...[
          Positioned.fill(
            child: GestureDetector(
              onTap: () => setState(() => _menuOpen = false),
              child: Container(color: const Color(0x61000000)),
            ),
          ),
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(boxShadow: CrmShadows.drawer),
              child: PwaDrawer(
                groups: _navGroups,
                current: _tab,
                onSelect: _go,
                onClose: () => setState(() => _menuOpen = false),
                userName: state.session.user?.displayName ?? 'Equipo FullTECH',
                userRole: _roleLabel(state),
                themeLabel: _themeLabel,
                onThemeCycle: _cycleTheme,
                onLogout: () => state.logout(),
                badges: badges,
              ),
            ),
          ),
        ],
      ],
    );
  }

  String _roleLabel(CrmState state) {
    final role = state.session.user?.role ?? '';
    return switch (role) {
      'ADMIN' || 'OWNER' => 'Administrador',
      'AGENT' => 'Agente',
      'DELIVERY' => 'Reparto',
      'OPERATOR' => 'Operador',
      _ => 'CRM',
    };
  }
}

/// Cabecera del móvil: 52 px, marca, módulo y acciones.
class _MobileHeader extends StatelessWidget {
  const _MobileHeader({required this.subtitle, required this.onMenu, required this.state});

  final String subtitle;
  final VoidCallback onMenu;
  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: CrmColors.hairline)),
      ),
      child: Row(
        children: [
          IconButton(onPressed: onMenu, tooltip: 'Abrir menú', icon: PwaIcon(PwaIcons.menu, size: 20, color: p.primary)),
          Image.asset(PwaIcons.brandLogo, width: 22, height: 22),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              'FullTECH',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, letterSpacing: -0.4, color: p.ink),
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              subtitle.toUpperCase(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, letterSpacing: 1.2, color: p.inkSecondary),
            ),
          ),
          const Spacer(),
          if (EnvironmentScope.maybeOf(context)?.showEnvironmentBadge == true) const EnvBadge(),
          IconButton(
            onPressed: state.loading ? null : () => state.refresh(),
            tooltip: 'Actualizar',
            icon: state.loading
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(Icons.refresh_rounded, size: 20, color: p.primary),
          ),
        ],
      ),
    );
  }
}

/// Barra inferior del móvil: solo se pinta en Hoy, como en el PWA.
class _MobileTabs extends StatelessWidget {
  const _MobileTabs({required this.current, required this.onSelect, required this.state});

  final String current;
  final ValueChanged<String> onSelect;
  final CrmState state;

  static const _items = [
    ('hoy', 'Hoy', Icons.wb_sunny_outlined, PwaIcons.sun),
    ('whatsapp', 'Chats', Icons.forum_outlined, PwaIcons.support),
    ('pedidos', 'Pedidos', Icons.receipt_long_outlined, PwaIcons.orders),
    ('clientes', 'Clientes', Icons.people_outline_rounded, PwaIcons.clientes),
  ];

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      height: CrmShellMetrics.mobileTabbar + MediaQuery.paddingOf(context).bottom,
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      decoration: BoxDecoration(
        color: p.surface.withValues(alpha: 0.98),
        border: Border(top: BorderSide(color: CrmColors.hairline)),
      ),
      child: Row(
        children: [
          for (final item in _items)
            Expanded(
              child: InkWell(
                onTap: () => onSelect(item.$1),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        PwaIcon(item.$4, size: 24, color: current == item.$1 ? p.primary : p.inkSecondary),
                        if (item.$1 == 'whatsapp' && state.unreadTotal > 0)
                          Positioned(
                            right: -8,
                            top: -4,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                              decoration: BoxDecoration(color: p.danger, borderRadius: BorderRadius.circular(999)),
                              child: Text(
                                '${state.unreadTotal}',
                                style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, color: Colors.white),
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      item.$2,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: current == item.$1 ? FontWeight.w700 : FontWeight.w600,
                        color: current == item.$1 ? p.primary : p.inkSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Distintivo de entorno (solo dev/UAT). En producción no se pinta.
class EnvBadge extends StatelessWidget {
  const EnvBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final environment = EnvironmentScope.maybeOf(context);
    if (environment == null || !environment.showEnvironmentBadge) return const SizedBox.shrink();
    final p = context.crm;
    final isUat = environment.environmentLabel == 'UAT';
    final tone = isUat ? p.warning : p.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(CrmRadii.pill),
        border: Border.all(color: tone.withValues(alpha: 0.4)),
      ),
      child: Text(
        environment.environmentLabel,
        style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: tone),
      ),
    );
  }
}

/// Banners del shell: sin conexión, cola pendiente, datos recortados y errores.
class _ShellBanners extends StatelessWidget {
  const _ShellBanners({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (state.offline)
          CrmNotice(
            message: 'Sin conexión: estás viendo la copia guardada en este aparato.',
            tone: p.warning,
            icon: Icons.cloud_off_rounded,
          ),
        if (state.pendingCount > 0) _PendingBanner(state: state),
        if (state.ordersTruncated)
          _TruncatedBanner(
            message: PartialDataNotice.message(
              partial: state.partial,
              customersComplete: state.customersComplete,
              conversationsComplete: state.conversationsComplete,
            ),
            onLoadMore: () => state.ensureFullLists(),
          ),
        if ((state.error ?? '').isNotEmpty) CrmNotice(message: state.error!, tone: p.danger, icon: Icons.error_outline_rounded),
      ],
    );
  }
}

class _TruncatedBanner extends StatelessWidget {
  const _TruncatedBanner({required this.message, required this.onLoadMore});

  final String message;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: p.primarySoft,
        borderRadius: BorderRadius.circular(CrmRadii.md),
        border: Border.all(color: p.primary.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(Icons.filter_alt_outlined, size: 18, color: p.primaryDark),
          const SizedBox(width: 8),
          Expanded(child: Text(message, style: TextStyle(fontSize: 12.5, color: p.ink, height: 1.3))),
          TextButton(onPressed: onLoadMore, child: const Text('Cargar completos', style: TextStyle(fontSize: 12))),
        ],
      ),
    );
  }
}

/// Aviso de acciones pendientes de red, con reintento y descarte.
class _PendingBanner extends StatelessWidget {
  const _PendingBanner({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final count = state.pendingCount;
    final blocked = state.outboxNeedsHuman;
    final tone = blocked.isNotEmpty ? p.danger : p.warning;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
      decoration: BoxDecoration(
        color: blocked.isNotEmpty ? p.dangerSoft : p.warnBg,
        borderRadius: BorderRadius.circular(CrmRadii.md),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          Icon(blocked.isNotEmpty ? Icons.error_outline_rounded : Icons.schedule_send_outlined, size: 18, color: tone),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              blocked.isNotEmpty
                  ? '$count pendiente(s); ${blocked.length} necesitan revisión.'
                  : (count == 1 ? '1 acción esperando red.' : '$count acciones esperando red.'),
              style: TextStyle(fontSize: 12.5, color: p.ink),
            ),
          ),
          if (blocked.isNotEmpty)
            TextButton(onPressed: () => _showBlocked(context), child: const Text('Revisar', style: TextStyle(fontSize: 12.5)))
          else
            TextButton(
              onPressed: state.flushing ? null : () => state.flushOutbox(manual: true),
              child: Text(state.flushing ? 'Enviando…' : 'Reintentar', style: const TextStyle(fontSize: 12.5)),
            ),
        ],
      ),
    );
  }

  void _showBlocked(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                'Estas acciones no se reintentan solas: hay que decidir qué hacer.',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            for (final op in state.outboxNeedsHuman)
              ListTile(
                leading: const Icon(Icons.report_problem_outlined, size: 20),
                title: Text(
                  op.kind == OutboxKind.message ? 'Mensaje a un cliente' : 'Cambio de estado de conversación',
                  style: const TextStyle(fontSize: 13.5),
                ),
                subtitle: Text('${op.lastError}\nIntento ${op.attempts}', style: const TextStyle(fontSize: 11.5)),
                isThreeLine: true,
                trailing: Wrap(
                  spacing: 4,
                  children: [
                    IconButton(
                      tooltip: 'Reintentar',
                      icon: const Icon(Icons.refresh_rounded, size: 20),
                      onPressed: () {
                        state.retryOperation(op.id);
                        Navigator.pop(sheetContext);
                      },
                    ),
                    IconButton(
                      tooltip: 'Descartar',
                      icon: const Icon(Icons.delete_outline_rounded, size: 20),
                      onPressed: () {
                        state.discardOperation(op.id);
                        Navigator.pop(sheetContext);
                      },
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
