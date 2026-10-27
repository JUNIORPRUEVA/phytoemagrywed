import 'package:flutter/material.dart';

import '../common/pwa_icon.dart';
import 'pwa_shell.dart';

/// Paleta **oscura única** del shell de escritorio.
///
/// Es la misma que ya usaba el chat estilo WhatsApp (`features/whatsapp/desktop`)
/// para que toda la app se vea igual: barra, menú y contenido comparten estos
/// valores. Se declara aquí para que el shell no dependa del módulo de chat.
abstract final class CrmDark {
  static const Color rail = Color(0xFF1D1F1F);
  static const Color panel = Color(0xFF161717);
  static const Color divider = Color(0xFF2E2F2F);
  static const Color field = Color(0xFF2E2F2F);
  static const Color card = Color(0xFF1C1D1D);
  static const Color hover = Color(0xFF202121);
  static const Color selected = Color(0xFF2A2B2B);
  static const Color ink = Color(0xFFFAFAFA);
  static const Color inkSecondary = Color(0xFFC0C1C1);
  static const Color accent = Color(0xFF1957E6);
  static const Color accentSoft = Color(0xFF16233C);
  static const Color online = Color(0xFF25D366);
  static const Color danger = Color(0xFFF15C6D);
  static const String font = 'Segoe UI';
}

/// Menú lateral fijo de escritorio, con el mismo lenguaje visual del chat:
/// fondo oscuro, grupos plegables, ítem activo con barra de acento.
///
/// El primer grupo (`Punto de Ventas (POS)`) se abre por defecto para que
/// Ventas, Pedidos, Cotizaciones, Clientes, Cierre diario y Reportes estén a un
/// clic.
class CrmDarkSidebar extends StatefulWidget {
  const CrmDarkSidebar({
    super.key,
    required this.groups,
    required this.current,
    required this.onSelect,
    required this.userName,
    required this.userRole,
    required this.themeLabel,
    required this.onThemeCycle,
    required this.onLogout,
    this.badges = const {},
    this.width = 268,
  });

  final List<PwaNavGroup> groups;
  final String current;
  final ValueChanged<String> onSelect;
  final String userName;
  final String userRole;
  final String themeLabel;
  final VoidCallback onThemeCycle;
  final VoidCallback onLogout;
  final Map<String, String> badges;
  final double width;

  @override
  State<CrmDarkSidebar> createState() => _CrmDarkSidebarState();
}

class _CrmDarkSidebarState extends State<CrmDarkSidebar> {
  late final Set<String> _open = {
    if (widget.groups.isNotEmpty) widget.groups.first.label,
  };

  @override
  void didUpdateWidget(covariant CrmDarkSidebar oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Al cambiar de módulo se abre el grupo donde vive el destino.
    for (final group in widget.groups) {
      if (group.items.any((item) => item.tab == widget.current)) {
        _open.add(group.label);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: widget.width,
      decoration: const BoxDecoration(
        color: CrmDark.rail,
        border: Border(right: BorderSide(color: CrmDark.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 10),
              children: [
                for (final group in widget.groups) ...[
                  if (group.collapsible)
                    _groupHeader(group)
                  else
                    const SizedBox(height: 6),
                  if (!group.collapsible || _open.contains(group.label))
                    for (final item in group.items) _item(item),
                ],
              ],
            ),
          ),
          const Divider(height: 1, color: CrmDark.divider),
          _footer(),
        ],
      ),
    );
  }

  Widget _header() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: CrmDark.divider)),
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: CrmDark.accent,
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Icon(Icons.storefront_rounded, size: 18, color: Colors.white),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                Text(
                  'FullTECH',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: CrmDark.font,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: CrmDark.ink,
                    height: 1.1,
                  ),
                ),
                Text(
                  'CRM',
                  style: TextStyle(
                    fontFamily: CrmDark.font,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.2,
                    color: CrmDark.inkSecondary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _groupHeader(PwaNavGroup group) {
    final expanded = _open.contains(group.label);
    return InkWell(
      onTap: () => setState(() => expanded ? _open.remove(group.label) : _open.add(group.label)),
      borderRadius: BorderRadius.circular(7),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 9, 6, 5),
        child: Row(
          children: [
            Expanded(
              child: Text(
                group.label.toUpperCase(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: CrmDark.font,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.9,
                  color: CrmDark.inkSecondary,
                ),
              ),
            ),
            AnimatedRotation(
              turns: expanded ? 0 : -0.25,
              duration: const Duration(milliseconds: 160),
              child: const Icon(Icons.expand_more_rounded, size: 15, color: CrmDark.inkSecondary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _item(PwaNavItem item) {
    final selected = item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return _SidebarRow(
      selected: selected,
      label: item.label,
      asset: item.icon,
      badge: badge,
      onTap: () => widget.onSelect(item.tab),
    );
  }

  Widget _footer() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 6, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.userName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontFamily: CrmDark.font,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: CrmDark.ink,
                      ),
                    ),
                    Text(
                      widget.userRole,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontFamily: CrmDark.font,
                        fontSize: 10.5,
                        color: CrmDark.inkSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              Tooltip(
                message: 'Tema: ${widget.themeLabel}',
                child: IconButton(
                  iconSize: 17,
                  color: CrmDark.inkSecondary,
                  onPressed: widget.onThemeCycle,
                  icon: const Icon(Icons.brightness_6_outlined),
                ),
              ),
              Tooltip(
                message: 'Cerrar sesión',
                child: IconButton(
                  iconSize: 17,
                  color: CrmDark.danger,
                  onPressed: widget.onLogout,
                  icon: const Icon(Icons.logout_rounded),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SidebarRow extends StatefulWidget {
  const _SidebarRow({
    required this.selected,
    required this.label,
    required this.asset,
    required this.onTap,
    this.badge,
  });

  final bool selected;
  final String label;
  final String asset;
  final String? badge;
  final VoidCallback onTap;

  @override
  State<_SidebarRow> createState() => _SidebarRowState();
}

class _SidebarRowState extends State<_SidebarRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    final color = selected ? CrmDark.ink : (_hovered ? CrmDark.ink : CrmDark.inkSecondary);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: 40,
          margin: const EdgeInsets.symmetric(vertical: 1),
          decoration: BoxDecoration(
            color: selected ? CrmDark.selected : (_hovered ? CrmDark.hover : Colors.transparent),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Container(
                width: 3,
                height: 18,
                margin: const EdgeInsets.only(right: 9),
                decoration: BoxDecoration(
                  color: selected ? CrmDark.accent : Colors.transparent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              PwaIcon(widget.asset, size: 17, color: color, opacity: selected ? 1 : 0.85),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: CrmDark.font,
                    fontSize: 13,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    color: color,
                  ),
                ),
              ),
              if ((widget.badge ?? '').isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: CrmDark.online,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    widget.badge!,
                    style: const TextStyle(
                      fontFamily: CrmDark.font,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF0B1F16),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Barra superior oscura de 56 px: título del módulo, estado de sincronización
/// y acciones. Sustituye a la barra flotante clara del PWA en escritorio.
class CrmDarkTopbar extends StatelessWidget {
  const CrmDarkTopbar({
    super.key,
    required this.title,
    required this.subtitle,
    required this.online,
    this.loading = false,
    this.actions = const [],
  });

  final String title;
  final String subtitle;
  final bool online;
  final bool loading;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: const BoxDecoration(
        color: CrmDark.panel,
        border: Border(bottom: BorderSide(color: CrmDark.divider)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: CrmDark.font,
                    fontSize: 15.5,
                    fontWeight: FontWeight.w700,
                    color: CrmDark.ink,
                  ),
                ),
                if (subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontFamily: CrmDark.font,
                      fontSize: 11.5,
                      color: CrmDark.inkSecondary,
                    ),
                  ),
              ],
            ),
          ),
          if (loading)
            const SizedBox(
              width: 15,
              height: 15,
              child: CircularProgressIndicator(strokeWidth: 2, color: CrmDark.online),
            )
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: CrmDark.field,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 7, color: online ? CrmDark.online : CrmDark.danger),
                  const SizedBox(width: 6),
                  Text(
                    online ? 'En línea' : 'Sin conexión',
                    style: const TextStyle(
                      fontFamily: CrmDark.font,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: CrmDark.inkSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ...actions,
        ],
      ),
    );
  }
}
