import 'package:flutter/material.dart';

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
    background: Color(0xFFFFFFFF),
    line: Color(0xFFEDF1F6),
    hover: Color(0xFFF3F6FA),
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
            icon: const Icon(Icons.close_rounded),
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
              child: Icon(Icons.keyboard_arrow_down_rounded, size: 17, color: c.muted),
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
                Icon(Icons.ios_share_rounded, size: 15.5, color: hovered ? c.ink : c.muted),
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
                _themeToggle(Icons.light_mode_outlined, !widget.isDark, c, () => widget.onThemeChanged(false)),
                _themeToggle(Icons.dark_mode_outlined, widget.isDark, c, () => widget.onThemeChanged(true)),
                const Spacer(),
                IconButton(
                  tooltip: 'Cerrar sesión',
                  onPressed: widget.onLogout,
                  iconSize: 16,
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                  color: const Color(0xFFE05252),
                  icon: const Icon(Icons.logout_rounded),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _themeToggle(IconData icon, bool selected, _Palette c, VoidCallback onTap) {
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
        child: Icon(icon, size: 15, color: selected ? c.primary : c.muted),
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

/// Barra superior de 56 px, clara u oscura según el tema.
class CrmLightTopbar extends StatelessWidget {
  const CrmLightTopbar({
    super.key,
    required this.title,
    required this.subtitle,
    required this.onMenu,
    required this.online,
    this.loading = false,
  });

  final String title;
  final String subtitle;
  final VoidCallback onMenu;
  final bool online;
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
          IconButton(
            tooltip: 'Menú',
            onPressed: onMenu,
            iconSize: 19,
            color: c.primary,
            icon: const Icon(Icons.menu_rounded),
          ),
          const SizedBox(width: 4),
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
