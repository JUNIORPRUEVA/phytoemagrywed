import 'package:flutter/material.dart';

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
import '../compartir/compartir_screen.dart';
import '../entregas/custodia_screen.dart';
import '../entregas/liquidaciones_screen.dart';
import '../entregas/mapa_screen.dart';
import '../entregas/repartidores_screen.dart';
import '../entregas/reglas_entrega_screen.dart';
import '../entregas/supervisor_screen.dart';
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
import '../ventas/pos_launch_context.dart';
import '../ventas/recogidas_screen.dart';
import '../ventas/recuento_screen.dart';
import '../ventas/solicitudes_screen.dart';
import '../ventas/tiendas_screen.dart';
import '../whatsapp/chats_desktop.dart';
import '../whatsapp/whatsapp_screen.dart';
import 'crm_menu_drawer.dart';
import 'pwa_shell.dart';

/// Un destino del menú (`data-tab` del panel). [image] es el **icono original
/// del PWA**; [icon] queda solo para la barra inferior del móvil.
class CrmDestination {
  const CrmDestination(
    this.tab,
    this.label,
    this.icon, {
    this.image = PwaIcons.orders,
    this.group = '',
  });

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
  CrmDestination(
    'whatsapp',
    'WhatsApp',
    Icons.forum_outlined,
    image: PwaIcons.whatsapp,
  ),
  // Ventas va SEGUNDO en el rail y entra directo a Facturación (no abre menú).
  CrmDestination(
    'pos',
    'Facturación',
    Icons.point_of_sale_rounded,
    image: PwaIcons.billing,
    group: 'Ventas',
  ),
  CrmDestination(
    'pedidos',
    'Pedidos',
    Icons.receipt_long_outlined,
    image: PwaIcons.orders,
  ),
  CrmDestination(
    'clientes',
    'Clientes',
    Icons.people_outline_rounded,
    image: PwaIcons.clientes,
  ),
  CrmDestination(
    'inventario',
    'Ajuste de stock',
    Icons.inventory_2_outlined,
    image: PwaIcons.orders,
    group: 'Ventas',
  ),
  CrmDestination(
    'cotizaciones',
    'Cotizaciones',
    Icons.description_outlined,
    image: PwaIcons.billing,
    group: 'Ventas',
  ),
  CrmDestination(
    'solicitudes',
    'Archivo de solicitudes',
    Icons.folder_copy_outlined,
    image: PwaIcons.orders,
    group: 'Ventas',
  ),
  CrmDestination(
    'recuento',
    'Recuento',
    Icons.fact_check_outlined,
    image: PwaIcons.orders,
    group: 'Ventas',
  ),
  CrmDestination(
    'recogidas',
    'Recogidas',
    Icons.shopping_bag_outlined,
    image: PwaIcons.cart,
    group: 'Ventas',
  ),
  CrmDestination(
    'tiendas',
    'Tiendas de recogida',
    Icons.storefront_rounded,
    image: PwaIcons.cart,
    group: 'Entregas',
  ),
  CrmDestination(
    'catalogo',
    'Tienda en línea',
    Icons.storefront_outlined,
    image: PwaIcons.cart,
    group: 'Ventas',
  ),
  CrmDestination(
    'mapa',
    'Mapa',
    Icons.map_outlined,
    image: PwaIcons.delivery,
    group: 'Entregas',
  ),
  CrmDestination(
    'custodia',
    'Custodia y rendiciones',
    Icons.account_balance_wallet_outlined,
    image: PwaIcons.custody,
    group: 'Entregas',
  ),
  CrmDestination(
    'liquidaciones',
    'Liquidaciones',
    Icons.payments_outlined,
    group: 'Entregas',
  ),
  CrmDestination(
    'repartidores',
    'Repartidores',
    Icons.delivery_dining_outlined,
    image: PwaIcons.couriers,
    group: 'Entregas',
  ),
  CrmDestination(
    'reglas_entrega',
    'Reglas de entrega',
    Icons.tune_rounded,
    image: PwaIcons.delivery,
    group: 'Entregas',
  ),
  CrmDestination(
    'supervisor_entregas',
    'Supervisor IA',
    Icons.smart_toy_outlined,
    image: PwaIcons.robot,
    group: 'Entregas',
  ),
  CrmDestination(
    'ops',
    'Agentes IA',
    Icons.smart_toy_outlined,
    image: PwaIcons.robot,
  ),
  CrmDestination(
    'cierre',
    'Cierre actual',
    Icons.check_circle_outline_rounded,
    image: PwaIcons.cierre,
    group: 'Cierre diario',
  ),
  CrmDestination(
    'reportes',
    'Reportes',
    Icons.insert_chart_outlined,
    image: PwaIcons.chart,
  ),
  CrmDestination(
    'seguimientos',
    'Seguimientos',
    Icons.event_repeat_outlined,
    image: PwaIcons.share,
    group: 'Operación',
  ),
  CrmDestination(
    'mensajes',
    'Mensajes programados',
    Icons.schedule_send_outlined,
    image: PwaIcons.bell,
    group: 'Operación',
  ),
  CrmDestination(
    'ajustes',
    'Configuración',
    Icons.settings_outlined,
    image: PwaIcons.settings,
  ),
  CrmDestination(
    'usuarios',
    'Usuarios',
    Icons.group_add_outlined,
    image: PwaIcons.usuarios,
    group: 'Operación',
  ),
  CrmDestination(
    'perfil',
    'Mi perfil',
    Icons.person_outline_rounded,
    image: PwaIcons.user,
  ),
];

/// Esqueleto del panel, reconstruido sobre el **CRM PWA**.
///
/// · **Escritorio (≥ 980 px)**: botón de menú flotante arriba a la izquierda,
///   barra superior flotante de 56 px y lienzo centrado de 1320 px. No hay menú
///   lateral fijo: el PWA no lo tiene.
/// · **Móvil**: cabecera compacta de 52 px y barra inferior de 4 destinos, que
///   el PWA muestra **solo en Hoy** (`body:not([data-tab='hoy']) .tabs`).
class CrmShell extends StatefulWidget {
  const CrmShell({
    super.key,
    this.initialTab = 'whatsapp',
    this.initialMenuOpen = false,
  });

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
  PosLaunchContext? _posLaunch;
  int _posLaunchVersion = 0;
  String? _chatReturnConversationId;

  void _openSale(PosLaunchContext launch) {
    setState(() {
      _posLaunch = launch;
      _chatReturnConversationId = launch.conversationId;
      _posLaunchVersion++;
      _tab = 'pos';
      _menuOpen = false;
    });
  }

  void _go(String tab) {
    if ((tab == 'usuarios' || tab == 'liquidaciones') &&
        !CrmScope.of(context).session.isAdmin)
      return;
    setState(() {
      _posLaunch = null;
      _tab = tab;
      _menuOpen = false;
    });
  }

  Widget _body(bool desktop) {
    final screen = _screen(desktop);
    if (!desktop) return screen;
    // Sin menús laterales: cada familia muestra sus pantallas como secciones
    // pequeñas encima del contenido.
    final family = _family(_tab);
    if (family == null) return screen;
    return Column(
      children: [
        _SectionTiles(entries: family, current: _tab, onSelect: _go),
        Expanded(child: screen),
      ],
    );
  }

  /// Pantallas de una misma familia (las que antes vivían en un menú).
  static List<_SectionEntry>? _family(String tab) {
    const entregas = [
      _SectionEntry('mapa', 'Mapa', Icons.map_outlined),
      _SectionEntry('tiendas', 'Tiendas de recogida', Icons.storefront_rounded),
      _SectionEntry(
        'repartidores',
        'Repartidores',
        Icons.delivery_dining_outlined,
      ),
      _SectionEntry(
        'custodia',
        'Custodia',
        Icons.account_balance_wallet_outlined,
      ),
      _SectionEntry('liquidaciones', 'Liquidaciones', Icons.payments_outlined),
      _SectionEntry('reglas_entrega', 'Reglas de entrega', Icons.tune_rounded),
      _SectionEntry(
        'supervisor_entregas',
        'Supervisor IA',
        Icons.smart_toy_outlined,
      ),
    ];
    const operacion = [
      _SectionEntry(
        'seguimientos',
        'Seguimientos',
        Icons.event_repeat_outlined,
      ),
      _SectionEntry(
        'mensajes',
        'Mensajes programados',
        Icons.schedule_send_outlined,
      ),
      _SectionEntry('usuarios', 'Usuarios', Icons.group_add_outlined),
    ];
    const cierre = [
      _SectionEntry(
        'cierre',
        'Cierre actual',
        Icons.check_circle_outline_rounded,
      ),
      _SectionEntry('reportes', 'Reportes', Icons.insert_chart_outlined),
    ];
    const ventas = [
      _SectionEntry('pos', 'Facturación', Icons.point_of_sale_rounded),
      _SectionEntry(
        'inventario',
        'Ajuste de stock',
        Icons.inventory_2_outlined,
      ),
      _SectionEntry('cotizaciones', 'Cotizaciones', Icons.description_outlined),
      _SectionEntry('recuento', 'Recuento', Icons.fact_check_outlined),
      _SectionEntry('recogidas', 'Recogidas', Icons.shopping_bag_outlined),
      _SectionEntry('catalogo', 'Tienda en línea', Icons.storefront_outlined),
    ];
    return switch (tab) {
      'mapa' ||
      'repartidores' ||
      'custodia' ||
      'liquidaciones' ||
      'tiendas' ||
      'reglas_entrega' ||
      'supervisor_entregas' => entregas,
      'seguimientos' || 'mensajes' || 'usuarios' => operacion,
      'cierre' || 'reportes' => cierre,
      'inventario' ||
      'cotizaciones' ||
      'recuento' ||
      'recogidas' ||
      'catalogo' => ventas,
      _ => null,
    };
  }

  Widget _screen(bool desktop) => switch (_tab) {
    'hoy' => HoyScreen(onNavigate: _go),
    // En escritorio los chats ocupan el rail + la lista + el hilo.
    'whatsapp' =>
      desktop
          ? ChatsDesktopScreen(
              onNavigate: _go,
              onOpenSale: _openSale,
              initialConversationId: _chatReturnConversationId,
              showRail: false,
            )
          : const WhatsappScreen(),
    'pedidos' => const PedidosScreen(),
    'clientes' => const ClientesScreen(),
    'catalogo' => const CatalogoScreen(),
    'pos' => PosScreen(
      key: ValueKey(_posLaunchVersion),
      embedded: desktop,
      desktop: desktop,
      initialSale: _posLaunch,
      onNavigate: _go,
    ),
    'inventario' => const InventarioScreen(),
    'cotizaciones' => const CotizacionesScreen(),
    'solicitudes' => const SolicitudesScreen(),
    'recuento' => const RecuentoScreen(),
    'recogidas' => const RecogidasScreen(),
    'tiendas' => const TiendasScreen(),
    'reglas_entrega' => const ReglasEntregaScreen(),
    'mapa' => const MapaScreen(),
    'custodia' => const CustodiaScreen(),
    'liquidaciones' => const LiquidacionesScreen(),
    'repartidores' => const RepartidoresScreen(),
    'supervisor_entregas' => const SupervisorScreen(),
    'ops' => const OpsScreen(),
    'seguimientos' => const SeguimientosScreen(),
    'mensajes' => const MensajesScreen(),
    'cierre' => const CierreScreen(),
    'reportes' => const ReportesScreen(),
    'usuarios' => const UsuariosScreen(),
    'ajustes' => const AjustesScreen(),
    'compartir' => const CompartirScreen(),
    _ => const PerfilScreen(),
  };

  String get _subtitle => _tab == 'compartir'
      ? 'Compartir'
      : crmDestinations
            .firstWhere(
              (d) => d.tab == _tab,
              orElse: () => crmDestinations.first,
            )
            .label;

  /// Grupos del menú en el orden del PWA; los destinos sin grupo van sueltos.
  /// Secciones del menú en el ORDEN exacto de `crmDestinations`: mezcla
  /// destinos sueltos y grupos tal como aparecen (grupo, suelto, grupo…).
  List<CrmNavSection> get _navSections {
    final sections = <CrmNavSection>[];
    final seen = <String>{};
    for (final destination in crmDestinations) {
      if ((destination.tab == 'usuarios' ||
              destination.tab == 'liquidaciones') &&
          !CrmScope.of(context).session.isAdmin) {
        continue;
      }
      if (destination.group.isEmpty) {
        sections.add(
          CrmNavSection.item(
            PwaNavItem(destination.tab, destination.label, destination.image),
          ),
        );
        continue;
      }
      if (!seen.add(destination.group)) continue;
      sections.add(
        CrmNavSection.group(
          PwaNavGroup(destination.group, [
            for (final row in crmDestinations.where(
              (r) => r.group == destination.group,
            ))
              PwaNavItem(row.tab, row.label, row.image),
          ]),
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
            icon: _railGlyph(item.tab),
            onTap: () => _go(item.tab),
          ),
        );
        continue;
      }
      final group = section.group!;
      // NINGÚN grupo abre menú: cada uno entra directo a su pantalla principal
      // (allí mismo están las secciones pequeñas para las demás).
      final entry = _groupEntry(group);
      if (entry != null) {
        entries.add(entry);
        continue;
      }
      // «Operación» no se muestra en el rail (su contenido se abre desde otro
      // sitio). Sus pantallas siguen existiendo y son navegables.
      if (group.label == 'Operación') continue;
      entries.add(
        CrmRailEntry(
          asset: group.items.first.icon,
          label: group.label,
          selected: group.items.any((row) => row.tab == _tab),
          icon: _groupGlyph(group.label),
          opensMenu: true,
          onTap: () => setState(() => _menuOpen = true),
        ),
      );
    }
    return entries;
  }

  /// Glifos elegidos por el equipo para el rail (persona para clientes).
  /// No hay PNG con esa forma en el panel, así que se dibujan con Material.
  static IconData? _railGlyph(String tab) => switch (tab) {
    'clientes' => Icons.person_outline_rounded,
    _ => null,
  };

  /// Entrada del rail para un grupo: navega DIRECTO a su pantalla principal.
  CrmRailEntry? _groupEntry(PwaNavGroup group) {
    final main = switch (group.label) {
      'Ventas' => 'pos',
      'Entregas' => 'mapa',
      'Cierre diario' => 'cierre',
      _ => '',
    };
    if (main.isEmpty) return null;
    return CrmRailEntry(
      asset: group.items.first.icon,
      label: switch (group.label) {
        'Cierre diario' => 'Cierre',
        _ => group.label,
      },
      selected: group.items.any((row) => row.tab == _tab),
      icon: _groupGlyph(group.label),
      onTap: () => _go(main),
    );
  }

  /// Carrito para «Ventas» y moto para «Entregas».
  static IconData? _groupGlyph(String group) => switch (group) {
    'Ventas' => Icons.shopping_cart_outlined,
    'Entregas' => Icons.moped,
    _ => null,
  };

  /// Configuración y Usuarios: van a pie del rail. «Mi perfil» no lleva icono
  /// propio porque ya lo abre el avatar del usuario.
  static const Set<String> _railFooterTabs = {'ajustes', 'perfil', 'usuarios'};

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
        selected: _tab == 'compartir',
        onTap: () => _go('compartir'),
      ),
      for (final item in items)
        if (item.tab == 'usuarios')
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
    final parts = name
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty)
        .toList();
    if (parts.isEmpty) return 'FT';
    if (parts.length == 1) {
      return parts.first
          .substring(0, parts.first.length >= 2 ? 2 : 1)
          .toUpperCase();
    }
    return '${parts.first[0]}${parts[1][0]}'.toUpperCase();
  }

  void _sharePanelLink() => _go('compartir');

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
        PwaNavGroup(group, [
          for (final destination in crmDestinations.where(
            (row) => row.group == group,
          ))
            PwaNavItem(destination.tab, destination.label, destination.image),
        ]),
      );
    }
    final loose = [
      for (final destination in crmDestinations.where(
        (row) => row.group.isEmpty,
      ))
        PwaNavItem(destination.tab, destination.label, destination.image),
    ];
    if (loose.isNotEmpty)
      result.add(PwaNavGroup('', loose, collapsible: false));
    return result;
  }

  /// Módulos de venta que ya se abren DESDE el POS (junto al buscador): en
  /// escritorio no se repiten en el menú lateral.
  static const Set<String> _movedToPos = {
    'inventario',
    'cotizaciones',
    'recuento',
    'recogidas',
    'tiendas',
    'catalogo',
    'solicitudes',
  };

  List<CrmNavSection> get _desktopSections {
    final sections = <CrmNavSection>[];
    for (final section in _navSections) {
      final item = section.item;
      if (item != null) {
        if (_movedToPos.contains(item.tab)) continue;
        sections.add(section);
        continue;
      }
      final group = section.group!;
      final rest = group.items
          .where((row) => !_movedToPos.contains(row.tab))
          .toList();
      if (rest.isEmpty) continue;
      sections.add(CrmNavSection.group(PwaNavGroup(group.label, rest)));
    }
    return sections;
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
    // Sin barra superior: el rail de iconos y el contenido ocupan todo el alto
    // (estilo WhatsApp). El menú lateral se abre desde los iconos de grupo.
    if (desktop) {
      return Scaffold(
        backgroundColor: context.crm.pageBg,
        body: Stack(
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Rail permanente: todos los iconos del menú a la vista.
                CrmIconRail(
                  entries: _railEntries(badges),
                  bottom: _railFooter(),
                  avatar: CrmRailAvatar(
                    initials: _initials(state),
                    photoUrl: state.session.user?.photoUrl ?? '',
                    onTap: () => _go('perfil'),
                  ),
                ),
                Expanded(child: content),
              ],
            ),
            if (_menuOpen) ...[
              Positioned(
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                child: GestureDetector(
                  onTap: () => setState(() => _menuOpen = false),
                  child: Container(color: CrmColors.scrim),
                ),
              ),
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                child: CrmDrawerEntrance(
                  child: Material(
                    elevation: 12,
                    child: CrmMenuDrawer(
                      sections: _desktopSections,
                      current: _tab,
                      onSelect: _go,
                      onClose: () => setState(() => _menuOpen = false),
                      onShare: _sharePanelLink,
                      userName:
                          state.session.user?.displayName ?? 'Equipo FullTECH',
                      userRole: _roleLabel(state),
                      initials: _initials(state),
                      isDark: Theme.of(context).brightness == Brightness.dark,
                      onThemeChanged: (dark) => state.setThemeMode(
                        dark ? ThemeMode.dark : ThemeMode.light,
                      ),
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
                        child: _tab == 'pos'
                            ? content
                            : PwaCanvas(child: content),
                      ),
                    ],
                  )
                : Column(
                    children: [
                      Padding(
                        padding: EdgeInsets.only(
                          top: MediaQuery.paddingOf(context).top,
                        ),
                        child: _MobileHeader(
                          subtitle: _subtitle,
                          onMenu: () => setState(() => _menuOpen = true),
                          state: state,
                        ),
                      ),
                      Expanded(child: content),
                      if (_tab == 'hoy')
                        _MobileTabs(current: _tab, onSelect: _go, state: state),
                    ],
                  ),
          ),
        ),
        if (desktop) ...[
          Positioned(
            left: CrmShellMetrics.menuButtonLeft,
            top: CrmShellMetrics.menuButtonTop,
            child: PwaMenuButton(
              expanded: _menuOpen,
              onPressed: () => setState(() => _menuOpen = !_menuOpen),
            ),
          ),
          Positioned(
            left:
                CrmShellMetrics.menuButtonLeft +
                CrmShellMetrics.menuButtonSize +
                12,
            right: CrmShellMetrics.topbarRight,
            top: CrmShellMetrics.topbarTop,
            child: PwaTopbar(
              subtitle: _subtitle,
              online: !state.offline,
              trailing: state.loading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
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

/// Una sección pequeña: pantalla hermana de la familia abierta.
class _SectionEntry {
  const _SectionEntry(this.tab, this.label, this.icon);

  final String tab;
  final String label;
  final IconData icon;
}

/// Franja de secciones pequeñas que sustituye al menú lateral en escritorio.
///
/// Se pinta encima del contenido cuando la pantalla pertenece a una familia
/// (Entregas, Operación, Cierre o Ventas): un clic cambia de pantalla sin abrir
/// ningún menú.
class _SectionTiles extends StatelessWidget {
  const _SectionTiles({
    required this.entries,
    required this.current,
    required this.onSelect,
  });

  final List<_SectionEntry> entries;
  final String current;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final delivery = entries.any((entry) => entry.tab == 'supervisor_entregas');
    return Container(
      height: 44,
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: p.border)),
      ),
      child: Row(
        children: [
          if (delivery)
            Padding(
              padding: const EdgeInsets.only(left: 16, right: 8),
              child: Text(
                'Entregas',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: p.ink,
                ),
              ),
            ),
          Expanded(
            child: LayoutBuilder(
              builder: (context, limits) => SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                reverse: delivery,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minWidth: (limits.maxWidth - 20).clamp(
                      0.0,
                      double.infinity,
                    ),
                  ),
                  child: Row(
                    mainAxisAlignment: delivery
                        ? MainAxisAlignment.end
                        : MainAxisAlignment.start,
                    children: [
                      for (final entry in entries)
                        if (entry.tab != 'liquidaciones' ||
                            CrmScope.of(context).session.isAdmin)
                          _tile(context, p, entry, delivery: delivery),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tile(
    BuildContext context,
    CrmPalette p,
    _SectionEntry entry, {
    bool delivery = false,
  }) {
    final active = entry.tab == current;
    return InkWell(
      onTap: () => onSelect(entry.tab),
      child: Container(
        height: delivery ? 44 : 30,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: active && !delivery ? p.primarySoft : Colors.transparent,
          borderRadius: delivery ? null : BorderRadius.circular(9),
          border: delivery
              ? Border(
                  bottom: BorderSide(
                    color: active ? p.primary : Colors.transparent,
                    width: 2,
                  ),
                )
              : Border.all(
                  color: active
                      ? p.primary.withValues(alpha: 0.35)
                      : Colors.transparent,
                ),
        ),
        child: Row(
          children: [
            Icon(
              entry.icon,
              size: 15,
              color: active ? p.primary : p.inkSecondary,
            ),
            const SizedBox(width: 6),
            Text(
              entry.label,
              style: TextStyle(
                fontSize: 11.8,
                fontWeight: active ? FontWeight.w700 : FontWeight.w600,
                color: active ? p.primary : p.inkSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Cabecera del móvil: 52 px, marca, módulo y acciones.
class _MobileHeader extends StatelessWidget {
  const _MobileHeader({
    required this.subtitle,
    required this.onMenu,
    required this.state,
  });

  final String subtitle;
  final VoidCallback onMenu;
  final CrmState state;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        // Mismo azul claro de marca que la barra de escritorio.
        color: CrmColors.primarySoft,
        border: Border(bottom: BorderSide(color: CrmColors.border)),
      ),
      child: Row(
        children: [
          IconButton(
            onPressed: onMenu,
            tooltip: 'Abrir menú',
            icon: const PwaIcon(
              PwaIcons.menu,
              size: 20,
              color: CrmColors.primary,
            ),
          ),
          Image.asset(PwaIcons.brandLogo, width: 22, height: 22),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              'FullTECH',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 15.5,
                fontWeight: FontWeight.w700,
                letterSpacing: -0.4,
                color: CrmColors.ink,
              ),
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              subtitle.toUpperCase(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
                color: CrmColors.inkSecondary,
              ),
            ),
          ),
          const Spacer(),
          if (EnvironmentScope.maybeOf(context)?.showEnvironmentBadge == true)
            const EnvBadge(),
          IconButton(
            onPressed: state.loading ? null : () => state.refresh(),
            tooltip: 'Actualizar',
            icon: state.loading
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: CrmColors.primary,
                    ),
                  )
                : const Icon(
                    Icons.refresh_rounded,
                    size: 20,
                    color: CrmColors.primary,
                  ),
          ),
        ],
      ),
    );
  }
}

/// Barra inferior del móvil: solo se pinta en Hoy, como en el PWA.
class _MobileTabs extends StatelessWidget {
  const _MobileTabs({
    required this.current,
    required this.onSelect,
    required this.state,
  });

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
      height:
          CrmShellMetrics.mobileTabbar + MediaQuery.paddingOf(context).bottom,
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
                        PwaIcon(
                          item.$4,
                          size: 24,
                          color: current == item.$1
                              ? p.primary
                              : p.inkSecondary,
                        ),
                        if (item.$1 == 'whatsapp' && state.unreadTotal > 0)
                          Positioned(
                            right: -8,
                            top: -4,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 4,
                                vertical: 1,
                              ),
                              decoration: BoxDecoration(
                                color: p.danger,
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                '${state.unreadTotal}',
                                style: const TextStyle(
                                  fontSize: 9.5,
                                  fontWeight: FontWeight.w800,
                                  color: Colors.white,
                                ),
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
                        fontWeight: current == item.$1
                            ? FontWeight.w700
                            : FontWeight.w600,
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
    if (environment == null || !environment.showEnvironmentBadge)
      return const SizedBox.shrink();
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
        style: TextStyle(
          fontSize: 9.5,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
          color: tone,
        ),
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
            message:
                'Sin conexión: estás viendo la copia guardada en este aparato.',
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
        if ((state.error ?? '').isNotEmpty)
          CrmNotice(
            message: state.error!,
            tone: p.danger,
            icon: Icons.error_outline_rounded,
          ),
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
          Expanded(
            child: Text(
              message,
              style: TextStyle(fontSize: 12.5, color: p.ink, height: 1.3),
            ),
          ),
          TextButton(
            onPressed: onLoadMore,
            child: const Text(
              'Cargar completos',
              style: TextStyle(fontSize: 12),
            ),
          ),
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
          Icon(
            blocked.isNotEmpty
                ? Icons.error_outline_rounded
                : Icons.schedule_send_outlined,
            size: 18,
            color: tone,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              blocked.isNotEmpty
                  ? '$count pendiente(s); ${blocked.length} necesitan revisión.'
                  : (count == 1
                        ? '1 acción esperando red.'
                        : '$count acciones esperando red.'),
              style: TextStyle(fontSize: 12.5, color: p.ink),
            ),
          ),
          if (blocked.isNotEmpty)
            TextButton(
              onPressed: () => _showBlocked(context),
              child: const Text('Revisar', style: TextStyle(fontSize: 12.5)),
            )
          else
            TextButton(
              onPressed: state.flushing
                  ? null
                  : () => state.flushOutbox(manual: true),
              child: Text(
                state.flushing ? 'Enviando…' : 'Reintentar',
                style: const TextStyle(fontSize: 12.5),
              ),
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
                  op.kind == OutboxKind.message
                      ? 'Mensaje a un cliente'
                      : 'Cambio de estado de conversación',
                  style: const TextStyle(fontSize: 13.5),
                ),
                subtitle: Text(
                  '${op.lastError}\nIntento ${op.attempts}',
                  style: const TextStyle(fontSize: 11.5),
                ),
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
