import 'package:flutter/material.dart';

import '../common/pwa_icon.dart';
import 'pwa_shell.dart';

/// Paleta del menú resuelta por tema, para que funcione en claro y oscuro.
class _Palette {
  const _Palette({
    required this.background,
    required this.surface,
    required this.line,
    required this.tile,
    required this.ink,
    required this.muted,
    required this.primary,
    required this.activeFill,
    required this.activeLine,
  });

  final Color background;
  final Color surface;
  final Color line;
  final Color tile;
  final Color ink;
  final Color muted;
  final Color primary;
  final Color activeFill;
  final Color activeLine;

  static const light = _Palette(
    background: Color(0xFFF4F7FB),
    surface: Color(0xFFFFFFFF),
    line: Color(0xFFE6EAF0),
    tile: Color(0xFFEEF1F5),
    ink: Color(0xFF102235),
    muted: Color(0xFF6B7A90),
    primary: Color(0xFF1957E6),
    activeFill: Color(0xFFEAF1FF),
    activeLine: Color(0xFF1957E6),
  );

  static const dark = _Palette(
    background: Color(0xFF161717),
    surface: Color(0xFF1C1D1D),
    line: Color(0xFF2E2F2F),
    tile: Color(0xFF262727),
    ink: Color(0xFFFAFAFA),
    muted: Color(0xFFC0C1C1),
    primary: Color(0xFF7EA8FF),
    activeFill: Color(0xFF16233C),
    activeLine: Color(0xFF1957E6),
  );

  static _Palette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// Una sección del menú: o un destino suelto, o un grupo plegable. Permite
/// respetar el orden exacto de la referencia (grupo, suelto, grupo, suelto…).
class CrmNavSection {
  const CrmNavSection.item(PwaNavItem this.item) : group = null;
  const CrmNavSection.group(PwaNavGroup this.group) : item = null;

  final PwaNavItem? item;
  final PwaNavGroup? group;
}

/// Menú lateral de escritorio con el diseño del panel web del CRM:
/// cabecera con avatar/nombre/rol, grupos con azulejo de icono y chevron, submenú
/// con línea guía, y pie con el conmutador Claro/Oscuro y salir.
class CrmMenuDrawer extends StatefulWidget {
  const CrmMenuDrawer({
    super.key,
    required this.sections,
    required this.current,
    required this.onSelect,
    required this.onClose,
    required this.userName,
    required this.userRole,
    required this.initials,
    required this.isDark,
    required this.onThemeChanged,
    required this.onLogout,
    this.badges = const {},
    this.width = 318,
  });

  final List<CrmNavSection> sections;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onClose;
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
  late final Set<String> _open = {
    for (final section in widget.sections)
      if (section.group != null &&
          (section.group!.items.any((item) => item.tab == widget.current) ||
              widget.sections.firstWhere((s) => s.group != null).group == section.group))
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
            _header(c),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
                children: [
                  for (final section in widget.sections)
                    if (section.item != null)
                      _looseRow(section.item!, c)
                    else if (section.group!.label.trim().isNotEmpty)
                      _groupBlock(section.group!, c),
                ],
              ),
            ),
            _footer(c),
          ],
        ),
      ),
    );
  }

  Widget _header(_Palette c) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 10, 4, 10),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color.alphaBlend(c.primary.withValues(alpha: 0.10), c.surface), c.surface],
          ),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: c.line),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: c.primary, borderRadius: BorderRadius.circular(12)),
              child: const Icon(Icons.forum_rounded, color: Colors.white, size: 21),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.userName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink, height: 1.15),
                  ),
                  Text(
                    widget.userRole,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: c.muted),
                  ),
                ],
              ),
            ),
            Container(
              width: 32,
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.tile,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: c.line),
              ),
              child: Text(
                widget.initials,
                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: c.ink),
              ),
            ),
            IconButton(
              tooltip: 'Cerrar menú',
              onPressed: widget.onClose,
              iconSize: 17,
              color: c.muted,
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
      ),
    );
  }

  Widget _groupBlock(PwaNavGroup group, _Palette c) {
    final expanded = _open.contains(group.label);
    final activeGroup = group.items.any((item) => item.tab == widget.current);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(
        children: [
          Material(
            color: c.surface,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => setState(() => expanded ? _open.remove(group.label) : _open.add(group.label)),
              child: Container(
                padding: const EdgeInsets.fromLTRB(8, 8, 10, 8),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: expanded ? c.activeLine : c.line, width: expanded ? 1.4 : 1),
                ),
                child: Row(
                  children: [
                    _tile(group.items.first.icon, c, active: activeGroup),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        group.label,
                        style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: c.ink),
                      ),
                    ),
                    AnimatedRotation(
                      turns: expanded ? 0.5 : 0,
                      duration: const Duration(milliseconds: 160),
                      child: Icon(
                        Icons.keyboard_arrow_down_rounded,
                        size: 20,
                        color: expanded ? c.primary : c.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 0, 2),
              child: Container(
                decoration: BoxDecoration(border: Border(left: BorderSide(color: c.line))),
                padding: const EdgeInsets.only(left: 10),
                child: Column(children: [for (final item in group.items) _subRow(item, c)]),
              ),
            ),
        ],
      ),
    );
  }

  Widget _looseRow(PwaNavItem item, _Palette c) {
    final selected = item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: c.surface,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => widget.onSelect(item.tab),
          child: Container(
            padding: const EdgeInsets.fromLTRB(8, 8, 10, 8),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: selected ? c.activeLine : c.line, width: selected ? 1.4 : 1),
            ),
            child: Row(
              children: [
                _tile(item.icon, c, active: selected),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    item.label,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: selected ? c.primary : c.ink,
                    ),
                  ),
                ),
                if ((badge ?? '').isNotEmpty) _badge(badge!),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _subRow(PwaNavItem item, _Palette c) {
    final selected = item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return InkWell(
      onTap: () => widget.onSelect(item.tab),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
        margin: const EdgeInsets.only(bottom: 2),
        decoration: BoxDecoration(
          color: selected ? c.activeFill : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            PwaIcon(item.icon, size: 15, color: selected ? c.primary : c.muted),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                item.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  color: selected ? c.primary : c.ink,
                ),
              ),
            ),
            if ((badge ?? '').isNotEmpty) _badge(badge!),
          ],
        ),
      ),
    );
  }

  Widget _tile(String asset, _Palette c, {bool active = false}) {
    return Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: active ? c.activeFill : c.tile,
        borderRadius: BorderRadius.circular(10),
      ),
      child: PwaIcon(asset, size: 17, color: active ? c.primary : c.ink, opacity: active ? 1 : 0.85),
    );
  }

  Widget _badge(String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: const Color(0xFF25D366), borderRadius: BorderRadius.circular(999)),
      child: Text(
        value,
        style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Color(0xFF0B1F16)),
      ),
    );
  }

  Widget _footer(_Palette c) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      decoration: BoxDecoration(color: c.background, border: Border(top: BorderSide(color: c.line))),
      child: Row(
        children: [
          Expanded(
            child: Container(
              height: 38,
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: c.surface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: c.line),
              ),
              child: Row(
                children: [
                  _themeOption('Claro', Icons.light_mode_outlined, !widget.isDark, c, () => widget.onThemeChanged(false)),
                  _themeOption('Oscuro', Icons.dark_mode_outlined, widget.isDark, c, () => widget.onThemeChanged(true)),
                ],
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: c.surface,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: c.line),
            ),
            child: IconButton(
              tooltip: 'Cerrar sesión',
              onPressed: widget.onLogout,
              iconSize: 18,
              color: const Color(0xFFE05252),
              icon: const Icon(Icons.logout_rounded),
            ),
          ),
        ],
      ),
    );
  }

  Widget _themeOption(String label, IconData icon, bool selected, _Palette c, VoidCallback onTap) {
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? c.activeFill : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 14, color: selected ? c.primary : c.muted),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  color: selected ? c.primary : c.muted,
                ),
              ),
            ],
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
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border(bottom: BorderSide(color: c.line)),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: c.activeFill,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: c.line),
            ),
            child: IconButton(
              tooltip: 'Menú',
              onPressed: onMenu,
              iconSize: 20,
              color: c.primary,
              icon: const Icon(Icons.menu_rounded),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, color: c.ink),
                ),
                if (subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: c.muted),
                  ),
              ],
            ),
          ),
          if (loading)
            SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2, color: c.primary))
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: c.tile,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: c.line),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 7, color: online ? const Color(0xFF16A34A) : const Color(0xFFDC2626)),
                  const SizedBox(width: 6),
                  Text(
                    online ? 'En línea' : 'Sin conexión',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
