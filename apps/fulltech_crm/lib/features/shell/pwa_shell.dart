import 'package:flutter/material.dart';

import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../common/pwa_icon.dart';

/// Fondo del panel: las **dos capas** que usa el `body` del PWA.
///
/// `radial-gradient(at 90% 0%, #dcecff, transparent 48%)` encima de
/// `linear-gradient(160deg, #fff, #f4f7fd 65%, #edf4ff)`. El resultado es el
/// azul pálido que se ve en todas las pantallas del CRM.
class PwaBackground extends StatelessWidget {
  const PwaBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    if (dark) {
      return DecoratedBox(
        decoration: const BoxDecoration(gradient: CrmGradients.darkPage),
        child: child,
      );
    }
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: CrmGradients.page),
      child: Stack(
        children: [
          const DecoratedBox(
            decoration: BoxDecoration(gradient: CrmGradients.pageGlow),
            child: SizedBox.expand(),
          ),
          child,
        ],
      ),
    );
  }
}

/// Botón de menú flotante del PWA: 54×54, blanco, radio 18, sombra azulada.
class PwaMenuButton extends StatelessWidget {
  const PwaMenuButton({super.key, required this.onPressed, this.expanded = false});

  final VoidCallback onPressed;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Semantics(
      button: true,
      label: expanded ? 'Cerrar menú' : 'Abrir menú',
      child: Material(
        color: p.surface,
        borderRadius: BorderRadius.circular(CrmRadii.lg),
        child: InkWell(
          borderRadius: BorderRadius.circular(CrmRadii.lg),
          onTap: onPressed,
          child: Container(
            width: CrmShellMetrics.menuButtonSize,
            height: CrmShellMetrics.menuButtonSize,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(CrmRadii.lg),
              border: Border.all(color: CrmColors.borderStrong),
              boxShadow: CrmShadows.menuButton,
            ),
            child: Center(
              child: expanded
                  ? Icon(Icons.close_rounded, size: 22, color: p.primary)
                  : PwaIcon(PwaIcons.menu, size: 22, color: p.primary),
            ),
          ),
        ),
      ),
    );
  }
}

/// Barra superior flotante del PWA: 56 px, radio 20, vítrea y con sombra suave.
class PwaTopbar extends StatelessWidget {
  const PwaTopbar({
    super.key,
    required this.subtitle,
    this.online = true,
    this.trailing,
    this.leading,
  });

  /// Segundo rótulo (`topbar__sub`): el módulo activo, en mayúsculas.
  final String subtitle;
  final bool online;
  final Widget? trailing;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      height: CrmShellMetrics.topbarHeight,
      padding: const EdgeInsets.only(left: 22, right: 12),
      decoration: BoxDecoration(
        color: p.surface.withValues(alpha: 0.86),
        borderRadius: BorderRadius.circular(CrmRadii.xl),
        border: Border.all(color: CrmColors.topbarBorder),
        boxShadow: CrmShadows.topbar,
      ),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 10)],
          Image.asset(PwaIcons.brandLogo, width: 26, height: 26, filterQuality: FilterQuality.medium),
          const SizedBox(width: 10),
          Flexible(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Flexible(
                  child: Text(
                    'FullTECH',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.63, color: p.ink),
                  ),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    subtitle.toUpperCase(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 1.76,
                      color: p.inkSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const Spacer(),
          if (trailing != null) ...[trailing!, const SizedBox(width: 8)],
          if (online) const PwaPresencePill(),
        ],
      ),
    );
  }
}

/// Píldora «En línea» del panel (`#state-pill`).
class PwaPresencePill extends StatelessWidget {
  const PwaPresencePill({super.key, this.label = 'En línea', this.tone});

  final String label;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final color = tone ?? p.success;
    return Container(
      padding: const EdgeInsets.fromLTRB(11, 8, 13, 8),
      decoration: BoxDecoration(
        color: CrmColors.surfaceSubtle,
        borderRadius: BorderRadius.circular(CrmRadii.pill),
        border: Border.all(color: CrmColors.borderStrong),
        boxShadow: const [BoxShadow(color: Color(0x1A143C78), blurRadius: 24, offset: Offset(0, 10))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: p.primary),
          ),
        ],
      ),
    );
  }
}

/// Lienzo del contenido: máx. 1320 px, centrado, con el padding del panel.
class PwaCanvas extends StatelessWidget {
  const PwaCanvas({super.key, required this.child, this.maxWidth = CrmShellMetrics.canvasMaxWidth, this.padding});

  final Widget child;
  final double maxWidth;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: Padding(
          padding: padding ??
              const EdgeInsets.fromLTRB(
                CrmShellMetrics.canvasPadSide,
                CrmShellMetrics.canvasPadTop,
                CrmShellMetrics.canvasPadSide,
                CrmShellMetrics.canvasPadBottom,
              ),
          child: child,
        ),
      ),
    );
  }
}

/// Un destino del menú lateral del PWA.
class PwaNavItem {
  const PwaNavItem(this.tab, this.label, this.icon, {this.badge});

  final String tab;
  final String label;
  final String icon;
  final String? badge;
}

/// Un grupo del menú (con sus ítems).
class PwaNavGroup {
  const PwaNavGroup(this.label, this.items, {this.collapsible = true, this.startCollapsed = false});

  final String label;
  final List<PwaNavItem> items;
  final bool collapsible;
  final bool startCollapsed;
}

/// Menú lateral del PWA: 318 px, cabecera de 72, grupos plegables e ítems de 44.
class PwaDrawer extends StatefulWidget {
  const PwaDrawer({
    super.key,
    required this.groups,
    required this.current,
    required this.onSelect,
    required this.onClose,
    required this.userName,
    required this.userRole,
    required this.themeLabel,
    required this.onThemeCycle,
    required this.onLogout,
    this.badges = const {},
  });

  final List<PwaNavGroup> groups;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onClose;
  final String userName;
  final String userRole;
  final String themeLabel;
  final VoidCallback onThemeCycle;
  final VoidCallback onLogout;
  final Map<String, String> badges;

  @override
  State<PwaDrawer> createState() => _PwaDrawerState();
}

class _PwaDrawerState extends State<PwaDrawer> {
  final Set<String> _collapsed = {};

  bool _isCollapsed(PwaNavGroup group) =>
      group.collapsible && (_collapsed.contains(group.label) || group.startCollapsed && !_collapsed.contains('!${group.label}'));

  void _toggle(PwaNavGroup group) {
    setState(() {
      if (_isCollapsed(group)) {
        _collapsed.remove(group.label);
        _collapsed.add('!${group.label}');
      } else {
        _collapsed.add(group.label);
        _collapsed.remove('!${group.label}');
      }
    });
  }

  String get _initials {
    final parts = widget.userName.trim().split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    if (parts.isEmpty) return 'FT';
    if (parts.length == 1) return parts.first.characters.take(2).toString().toUpperCase();
    return (parts.first.characters.take(1).toString() + parts[1].characters.take(1).toString()).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      width: CrmShellMetrics.drawerWidth,
      color: p.surface,
      child: Column(
        children: [
          _head(p),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(bottom: 8),
              children: [
                for (final group in widget.groups) ...[
                  _groupHeader(p, group),
                  if (!_isCollapsed(group))
                    for (final item in group.items) _item(p, item),
                  const SizedBox(height: 2),
                ],
              ],
            ),
          ),
          _footer(p),
        ],
      ),
    );
  }

  Widget _head(CrmPalette p) {
    return Container(
      height: CrmShellMetrics.drawerHeadHeight,
      padding: const EdgeInsets.fromLTRB(14, 10, 13, 10),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: p.primarySoft,
              borderRadius: BorderRadius.circular(13),
              border: Border.all(color: p.primary.withValues(alpha: 0.18)),
            ),
            child: Center(
              child: Text(
                _initials,
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: p.primary),
              ),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.userName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: p.ink),
                ),
                Text(
                  widget.userRole,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: p.inkSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Cerrar menú',
            onPressed: widget.onClose,
            icon: Icon(Icons.close_rounded, size: 20, color: p.inkSecondary),
          ),
        ],
      ),
    );
  }

  Widget _groupHeader(CrmPalette p, PwaNavGroup group) {
    final collapsed = _isCollapsed(group);
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 10, 8, 4),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(CrmRadii.md),
          onTap: group.collapsible ? () => _toggle(group) : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    group.label.toUpperCase(),
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.2, color: p.inkSecondary),
                  ),
                ),
                if (group.collapsible)
                  AnimatedRotation(
                    turns: collapsed ? 0 : 0.5,
                    duration: const Duration(milliseconds: 180),
                    child: Icon(Icons.keyboard_arrow_down_rounded, size: 18, color: p.inkSecondary),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _item(CrmPalette p, PwaNavItem item) {
    final active = item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 1, 8, 1),
      child: Material(
        color: active ? p.primarySoft : Colors.transparent,
        borderRadius: const BorderRadius.horizontal(left: Radius.circular(CrmRadii.md), right: Radius.circular(5)),
        child: InkWell(
          borderRadius: const BorderRadius.horizontal(left: Radius.circular(CrmRadii.md), right: Radius.circular(5)),
          onTap: () => widget.onSelect(item.tab),
          child: Container(
            height: CrmShellMetrics.drawerItemHeight,
            padding: const EdgeInsets.symmetric(horizontal: 9),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(color: active ? p.primary : Colors.transparent, width: 3),
                top: BorderSide(color: active ? p.primary.withValues(alpha: 0.22) : Colors.transparent),
                right: BorderSide(color: active ? p.primary.withValues(alpha: 0.22) : Colors.transparent),
                bottom: BorderSide(color: active ? p.primary.withValues(alpha: 0.22) : Colors.transparent),
              ),
              borderRadius: const BorderRadius.horizontal(left: Radius.circular(CrmRadii.md), right: Radius.circular(5)),
            ),
            child: Row(
              children: [
                PwaIcon(item.icon, size: 20, color: active ? p.primary : p.ink),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    item.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.28,
                      color: active ? p.primary : p.ink,
                    ),
                  ),
                ),
                if (badge != null && badge.isNotEmpty)
                  Container(
                    constraints: const BoxConstraints(minWidth: 28),
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: p.danger,
                      borderRadius: BorderRadius.circular(CrmRadii.pill),
                    ),
                    child: Text(
                      badge,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Colors.white),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _footer(CrmPalette p) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: CrmColors.hairline)),
      ),
      child: Row(
        children: [
          Expanded(
            child: _themeButton(p),
          ),
          const SizedBox(width: 8),
          _iconAction(
            p,
            icon: Icons.dark_mode_outlined,
            tooltip: 'Cambiar tema',
            onTap: widget.onThemeCycle,
          ),
          const SizedBox(width: 8),
          _iconAction(
            p,
            icon: Icons.logout_rounded,
            tooltip: 'Cerrar sesión',
            tone: p.danger,
            onTap: widget.onLogout,
          ),
        ],
      ),
    );
  }

  Widget _themeButton(CrmPalette p) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(CrmRadii.md),
        onTap: widget.onThemeCycle,
        child: Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(CrmRadii.md),
            border: Border.all(color: CrmColors.borderStrong),
          ),
          child: Row(
            children: [
              Icon(Icons.light_mode_outlined, size: 17, color: p.inkSecondary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.themeLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.ink),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _iconAction(CrmPalette p, {required IconData icon, required String tooltip, required VoidCallback onTap, Color? tone}) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(CrmRadii.md),
          onTap: onTap,
          child: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(CrmRadii.md),
              border: Border.all(color: CrmColors.borderStrong),
            ),
            child: Icon(icon, size: 18, color: tone ?? p.inkSecondary),
          ),
        ),
      ),
    );
  }
}
