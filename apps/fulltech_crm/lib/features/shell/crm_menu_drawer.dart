import 'package:flutter/material.dart';

import '../../core/theme/crm_tokens.dart';
import '../common/pwa_icon.dart';
import 'pwa_shell.dart';

/// Paleta del menú por tema.
class _Palette {
  const _Palette({
    required this.background,
    required this.line,
    required this.hover,
    required this.ink,
    required this.muted,
    required this.primary,
    required this.activeFill,
  });

  final Color background;
  final Color line;
  final Color hover;
  final Color ink;
  final Color muted;
  final Color primary;
  final Color activeFill;

  static const light = _Palette(
    background: Color(0xFFFAF9F6),
    line: Color(0xFFD9D2C4),
    hover: Color(0xFFF1EEE6),
    ink: Color(0xFF102235),
    muted: Color(0xFF64748B),
    primary: Color(0xFF1957E6),
    activeFill: Color(0xFFEAF1FF),
  );

  static const dark = _Palette(
    background: Color(0xFF181919),
    line: Color(0xFF2A2B2B),
    hover: Color(0xFF232424),
    ink: Color(0xFFFAFAFA),
    muted: Color(0xFFB9BBBB),
    primary: Color(0xFF7EA8FF),
    activeFill: Color(0xFF1D2942),
  );

  static _Palette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// Una sección del menú: destino suelto o grupo plegable, en el orden real.
class CrmNavSection {
  const CrmNavSection.item(PwaNavItem this.item) : group = null;
  const CrmNavSection.group(PwaNavGroup this.group) : item = null;

  final PwaNavItem? item;
  final PwaNavGroup? group;
}

/// Menú lateral compacto (224 px = 70 % del anterior).
///
/// Sin tarjetas dentro de tarjetas: filas finas con hover y barra de acento.
/// Arriba la marca y el usuario; en medio la navegación; al pie una zona fija
/// con Configuración, Compartir y Usuario, y el conmutador de tema + salir.
class CrmMenuDrawer extends StatefulWidget {
  const CrmMenuDrawer({
    super.key,
    required this.sections,
    required this.current,
    required this.onSelect,
    required this.onClose,
    required this.onShare,
    required this.userName,
    required this.userRole,
    required this.initials,
    required this.isDark,
    required this.onThemeChanged,
    required this.onLogout,
    this.badges = const {},
    this.width = 224,
  });

  final List<CrmNavSection> sections;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onClose;
  final VoidCallback onShare;
  final String userName;
  final String userRole;
  final String initials;
  final bool isDark;
  final ValueChanged<bool> onThemeChanged;
  final VoidCallback onLogout;
  final Map<String, String> badges;
  final double width;

  @override
  State<CrmMenuDrawer> createState() => _CrmMenuDrawerState();
}

class _CrmMenuDrawerState extends State<CrmMenuDrawer> {
  /// Tabs que viven en la zona fija del pie, no en la lista desplazable.
  static const _footerTabs = {'ajustes', 'perfil'};

  late final Set<String> _open = {
    for (final section in widget.sections)
      if (section.group != null && section.group!.items.any((item) => item.tab == widget.current))
        section.group!.label,
  };

  @override
  void didUpdateWidget(covariant CrmMenuDrawer oldWidget) {
    super.didUpdateWidget(oldWidget);
    for (final section in widget.sections) {
      if (section.group?.items.any((item) => item.tab == widget.current) ?? false) {
        _open.add(section.group!.label);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _Palette.of(context);
    return Container(
      width: widget.width,
      decoration: BoxDecoration(
        color: c.background,
        border: Border(right: BorderSide(color: c.line)),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _brand(c),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                children: [
                  for (final section in widget.sections)
                    if (section.item != null)
                      if (!_footerTabs.contains(section.item!.tab))
                        _item(section.item!, c, group: false)
                      else
                        const SizedBox.shrink()
                    else if (section.group!.items.any((i) => !_footerTabs.contains(i.tab)))
                      _group(section.group!, c),
                ],
              ),
            ),
            _footer(c),
          ],
        ),
      ),
    );
  }

  Widget _brand(_Palette c) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 10, 6, 10),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: c.primary, borderRadius: BorderRadius.circular(9)),
            child: const Icon(Icons.forum_rounded, size: 16, color: Colors.white),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  widget.userName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.ink, height: 1.15),
                ),
                Text(
                  widget.userRole,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: c.muted),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Cerrar',
            onPressed: widget.onClose,
            iconSize: 16,
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            color: c.muted,
            icon: const PwaIcon(PwaIcons.back, size: 15),
          ),
        ],
      ),
    );
  }

  Widget _group(PwaNavGroup group, _Palette c) {
    final expanded = _open.contains(group.label);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _item(
          PwaNavItem(group.label, group.label, group.items.first.icon),
          c,
          group: true,
          expanded: expanded,
          onTap: () => setState(() => expanded ? _open.remove(group.label) : _open.add(group.label)),
        ),
        if (expanded)
          Padding(
            padding: const EdgeInsets.only(left: 11, bottom: 2),
            child: Container(
              decoration: BoxDecoration(border: Border(left: BorderSide(color: c.line))),
              child: Column(
                children: [
                  for (final item in group.items)
                    if (!_footerTabs.contains(item.tab)) _item(item, c, group: false, sub: true),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _item(
    PwaNavItem item,
    _Palette c, {
    required bool group,
    bool sub = false,
    bool expanded = false,
    VoidCallback? onTap,
  }) {
    final selected = !group && item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return _HoverRow(
      palette: c,
      selected: selected,
      height: sub ? 32 : 38,
      padding: EdgeInsets.only(left: sub ? 10 : 8, right: 6),
      onTap: onTap ?? () => widget.onSelect(item.tab),
      builder: (hovered) => Row(
        children: [
          if (selected)
            Container(
              width: 2.5,
              height: 16,
              margin: const EdgeInsets.only(right: 7),
              decoration: BoxDecoration(color: c.primary, borderRadius: BorderRadius.circular(2)),
            ),
          PwaIcon(
            item.icon,
            size: sub ? 13 : 15.5,
            color: selected ? c.primary : (hovered ? c.ink : c.muted),
            opacity: 1,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              item.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: sub ? 12.5 : 13.5,
                fontWeight: selected || group ? FontWeight.w600 : FontWeight.w500,
                color: selected ? c.primary : c.ink,
              ),
            ),
          ),
          if ((badge ?? '').isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              decoration: BoxDecoration(color: const Color(0xFF25D366), borderRadius: BorderRadius.circular(999)),
              child: Text(
                badge!,
                style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, color: Color(0xFF0B1F16)),
              ),
            ),
          if (group)
            AnimatedRotation(
              turns: expanded ? 0.5 : 0,
              duration: const Duration(milliseconds: 150),
              child: PwaIcon(PwaIcons.chevronDown, size: 14, color: c.muted),
            ),
        ],
      ),
    );
  }

  Widget _footer(_Palette c) {
    final config = widget.sections
        .expand<Object>((section) => section.item != null ? [section.item!] : section.group!.items)
        .whereType<PwaNavItem>()
        .where((item) => item.tab == 'ajustes')
        .toList();
    final profile = widget.sections
        .expand<Object>((section) => section.item != null ? [section.item!] : section.group!.items)
        .whereType<PwaNavItem>()
        .where((item) => item.tab == 'perfil')
        .toList();
    return Container(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: c.line)),
        color: c.background,
      ),
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
      child: Column(
        children: [
          if (config.isNotEmpty) _item(config.first, c, group: false),
          _HoverRow(
            palette: c,
            selected: false,
            height: 38,
            padding: const EdgeInsets.only(left: 8, right: 6),
            onTap: widget.onShare,
            builder: (hovered) => Row(
              children: [
                PwaIcon(PwaIcons.share, size: 15, color: hovered ? c.ink : c.muted),
                const SizedBox(width: 8),
                Text(
                  'Compartir',
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: c.ink),
                ),
              ],
            ),
          ),
          if (profile.isNotEmpty) _item(profile.first, c, group: false),
          const SizedBox(height: 4),
          Container(
            height: 34,
            padding: const EdgeInsets.symmetric(horizontal: 4),
            decoration: BoxDecoration(
              color: c.hover,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                _themeToggle(PwaIcons.sun, !widget.isDark, c, () => widget.onThemeChanged(false)),
                _themeToggle(PwaIcons.moon, widget.isDark, c, () => widget.onThemeChanged(true)),
                const Spacer(),
                IconButton(
                  tooltip: 'Cerrar sesión',
                  onPressed: widget.onLogout,
                  iconSize: 16,
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                  color: const Color(0xFFE05252),
                  icon: const PwaIcon(PwaIcons.logout, size: 15, color: Color(0xFFE05252)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _themeToggle(String icon, bool selected, _Palette c, VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(7),
      onTap: onTap,
      child: Container(
        width: 30,
        height: 26,
        margin: const EdgeInsets.symmetric(horizontal: 1, vertical: 4),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? c.background : Colors.transparent,
          borderRadius: BorderRadius.circular(7),
          border: selected ? Border.all(color: c.line) : null,
        ),
        child: PwaIcon(icon, size: 14, color: selected ? c.primary : c.muted),
      ),
    );
  }
}

/// Fila plana con hover; sin bordes ni tarjetas.
class _HoverRow extends StatefulWidget {
  const _HoverRow({
    required this.palette,
    required this.selected,
    required this.height,
    required this.padding,
    required this.onTap,
    required this.builder,
  });

  final _Palette palette;
  final bool selected;
  final double height;
  final EdgeInsets padding;
  final VoidCallback onTap;
  final Widget Function(bool hovered) builder;

  @override
  State<_HoverRow> createState() => _HoverRowState();
}

class _HoverRowState extends State<_HoverRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = widget.palette;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: widget.height,
          padding: widget.padding,
          decoration: BoxDecoration(
            color: widget.selected
                ? c.activeFill
                : (_hovered ? c.hover : Colors.transparent),
            borderRadius: BorderRadius.circular(6),
          ),
          child: widget.builder(_hovered),
        ),
      ),
    );
  }
}

/// Entrada suave del menú: 22 px desde la izquierda + desvanecido, 200 ms.
class CrmDrawerEntrance extends StatefulWidget {
  const CrmDrawerEntrance({super.key, required this.child, this.offset = 22});

  final Widget child;
  final double offset;

  @override
  State<CrmDrawerEntrance> createState() => _CrmDrawerEntranceState();
}

class _CrmDrawerEntranceState extends State<CrmDrawerEntrance> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 200),
  )..forward();

  late final Animation<double> _curve = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _curve,
      builder: (context, child) => Opacity(
        opacity: _curve.value,
        child: Transform.translate(
          offset: Offset(-(1 - _curve.value) * widget.offset, 0),
          child: child,
        ),
      ),
      child: widget.child,
    );
  }
}

/// Una entrada del rail de iconos.
class CrmRailEntry {
  const CrmRailEntry({
    required this.asset,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.opensMenu = false,
    this.badge,
  });

  final String asset;
  final String label;
  final VoidCallback onTap;
  final bool selected;

  /// Al pulsar se abre el menú lateral (es un grupo, no un destino suelto).
  final bool opensMenu;
  final String? badge;
}

/// Rail estrecho y permanente con TODOS los iconos del menú.
///
/// Va siempre visible en escritorio, ocupando solo 52 px: el profesional entra
/// a cualquier módulo con un clic. Los iconos que corresponden a un grupo abren
/// el menú lateral para elegir la opción concreta.
class CrmIconRail extends StatelessWidget {
  const CrmIconRail({super.key, required this.entries, this.bottom = const []});

  /// Módulos y grupos (parte de arriba).
  final List<CrmRailEntry> entries;

  /// Configuración, Compartir y Mi perfil: van abajo, separados.
  final List<CrmRailEntry> bottom;

  static const double width = 52;

  @override
  Widget build(BuildContext context) {
    final c = _Palette.of(context);
    return Container(
      width: width,
      decoration: BoxDecoration(
        color: c.background,
        border: Border(right: BorderSide(color: c.line)),
      ),
      child: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 6),
              children: [
                for (final entry in entries) _RailTile(entry: entry, palette: c, width: width),
              ],
            ),
          ),
          if (bottom.isNotEmpty) ...[
            Divider(height: 1, thickness: 1, color: c.line),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                children: [
                  for (final entry in bottom) _RailTile(entry: entry, palette: c, width: width),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _RailTile extends StatefulWidget {
  const _RailTile({required this.entry, required this.palette, required this.width});

  final CrmRailEntry entry;
  final _Palette palette;
  final double width;

  @override
  State<_RailTile> createState() => _RailTileState();
}

class _RailTileState extends State<_RailTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = widget.palette;
    final entry = widget.entry;
    final active = entry.selected;
    final tint = active ? c.primary : (_hovered ? c.ink : c.muted);
    return Tooltip(
      message: entry.label,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: entry.onTap,
          behavior: HitTestBehavior.opaque,
          child: Container(
            height: 42,
            margin: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            decoration: BoxDecoration(
              color: active ? c.activeFill : (_hovered ? c.hover : Colors.transparent),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Stack(
              alignment: Alignment.center,
              children: [
                if (active)
                  Positioned(
                    left: 0,
                    top: 9,
                    bottom: 9,
                    child: Container(
                      width: 2.5,
                      decoration: BoxDecoration(
                        color: c.primary,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                PwaIcon(entry.asset, size: 18, color: tint, opacity: 1),
                if ((entry.badge ?? '').isNotEmpty)
                  Positioned(
                    right: 6,
                    top: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      decoration: BoxDecoration(
                        color: const Color(0xFF25D366),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        entry.badge!,
                        style: const TextStyle(
                          fontSize: 8.5,
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF0B1F16),
                        ),
                      ),
                    ),
                  ),
                // Los grupos se reconocen por el puntito: abren el menú.
                if (entry.opensMenu)
                  Positioned(
                    right: 8,
                    bottom: 7,
                    child: Container(
                      width: 4,
                      height: 4,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: active ? c.primary : c.muted.withValues(alpha: 0.6),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Barra superior de 56 px, clara u oscura según el tema.
class CrmLightTopbar extends StatelessWidget {
  const CrmLightTopbar({
    super.key,
    required this.title,
    required this.subtitle,
    required this.onMenu,
    required this.online,
    this.menuOpen = false,
    this.unread = 0,
    this.onBell,
    this.loading = false,
  });

  final String title;
  final String subtitle;
  final VoidCallback onMenu;
  final bool online;
  final bool menuOpen;

  /// Mensajes sin leer: si hay, la campana lleva un punto de aviso.
  final int unread;

  /// Acción de la campana (abre la bandeja). Sin acción, no se dibuja.
  final VoidCallback? onBell;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final c = _Palette.of(context);
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: c.background,
        border: Border(bottom: BorderSide(color: c.line)),
      ),
      child: Row(
        children: [
          CrmDrawerButton(
            open: menuOpen,
            onPressed: onMenu,
            color: c.primary,
            tint: c.hover,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                ),
                if (subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: c.muted),
                  ),
              ],
            ),
          ),
          if (onBell != null)
            _BellButton(
              palette: c,
              unread: unread,
              onPressed: onBell!,
            ),
          const SizedBox(width: 6),
          if (loading)
            SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: c.primary))
          else
            Row(
              children: [
                Icon(Icons.circle, size: 7, color: online ? const Color(0xFF16A34A) : const Color(0xFFDC2626)),
                const SizedBox(width: 6),
                Text(
                  online ? 'En línea' : 'Sin conexión',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// Campana de notificaciones con el PNG del panel y punto de aviso.
class _BellButton extends StatefulWidget {
  const _BellButton({required this.palette, required this.unread, required this.onPressed});

  final _Palette palette;
  final int unread;
  final VoidCallback onPressed;

  @override
  State<_BellButton> createState() => _BellButtonState();
}

class _BellButtonState extends State<_BellButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = widget.palette;
    return Tooltip(
      message: widget.unread > 0 ? '${widget.unread} mensaje(s) sin leer' : 'Notificaciones',
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: widget.onPressed,
          behavior: HitTestBehavior.opaque,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: _hovered ? c.hover : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Stack(
              children: [
                Center(child: PwaIcon(PwaIcons.bell, size: 17, color: _hovered ? c.ink : c.muted)),
                if (widget.unread > 0)
                  Positioned(
                    right: 5,
                    top: 5,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: const Color(0xFF25D366),
                        shape: BoxShape.circle,
                        border: Border.all(color: c.background, width: 1.5),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Botón del menú con el **icono oficial del panel** (`menu.png`) y animación
/// de apertura: el icono se funde en una ✕ que gira 45°, 240 ms `easeOutCubic`.
class CrmDrawerButton extends StatefulWidget {
  const CrmDrawerButton({
    super.key,
    required this.open,
    required this.onPressed,
    required this.color,
    required this.tint,
    this.size = 34,
  });

  final bool open;
  final VoidCallback onPressed;

  /// Color de las barras.
  final Color color;

  /// Relleno suave al pasar el ratón o con el menú abierto.
  final Color tint;
  final double size;

  @override
  State<CrmDrawerButton> createState() => _CrmDrawerButtonState();
}

class _CrmDrawerButtonState extends State<CrmDrawerButton> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
    value: widget.open ? 1 : 0,
  );
  late final Animation<double> _turn = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic);

  bool _hovered = false;

  @override
  void didUpdateWidget(covariant CrmDrawerButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.open != oldWidget.open) {
      widget.open ? _controller.forward() : _controller.reverse();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = _hovered || widget.open;
    return Tooltip(
      message: widget.open ? 'Cerrar menú' : 'Menú',
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: widget.onPressed,
          behavior: HitTestBehavior.opaque,
          child: AnimatedScale(
            scale: _hovered ? 1.04 : 1,
            duration: const Duration(milliseconds: 140),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              width: widget.size,
              height: widget.size,
              decoration: BoxDecoration(
                color: active ? widget.tint : Colors.transparent,
                borderRadius: BorderRadius.circular(9),
              ),
              child: AnimatedBuilder(
                animation: _turn,
                builder: (context, _) {
                  final t = _turn.value;
                  return SizedBox.expand(
                    child: Center(
                      child: SizedBox(
                        width: 18,
                        height: 18,
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            // Icono original (cerrado).
                            Opacity(
                              opacity: (1 - t).clamp(0.0, 1.0),
                              child: Transform.rotate(
                                angle: 0.6 * t,
                                child: PwaIcon(PwaIcons.menu, size: 18, color: widget.color),
                              ),
                            ),
                            // ✕ que aparece al abrir.
                            Opacity(
                              opacity: t.clamp(0.0, 1.0),
                              child: Transform.rotate(
                                angle: -0.7854 * (1 - t),
                                child: Stack(
                                  alignment: Alignment.center,
                                  children: [
                                    _bar(width: 16, angle: 0.7854, color: widget.color),
                                    _bar(width: 16, angle: -0.7854, color: widget.color),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _bar({required double width, required Color color, double offset = 0, double angle = 0}) {
    return Transform.translate(
      offset: Offset(0, offset),
      child: Transform.rotate(
        angle: angle,
        child: Container(
          width: width,
          height: 2.2,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}
