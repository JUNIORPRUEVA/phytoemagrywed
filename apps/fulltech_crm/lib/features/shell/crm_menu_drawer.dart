import 'package:flutter/material.dart';

import '../common/pwa_icon.dart';
import 'pwa_shell.dart';

/// Menú lateral de escritorio con el diseño de **FullPOS Cloud** que aportó el
/// dueño: panel claro de 318 px, tarjeta de marca arriba, grupos con azulejo de
/// icono y chevron, submenú indentado y tarjeta informativa al pie.
///
/// Es la única navegación de escritorio (no hay rail duplicado). El primer
/// destino es **Chats (WhatsApp)**, que es la pantalla principal del CRM.
class CrmMenuDrawer extends StatefulWidget {
  const CrmMenuDrawer({
    super.key,
    required this.groups,
    required this.loose,
    required this.current,
    required this.onSelect,
    required this.onClose,
    required this.userName,
    required this.userRole,
    required this.onLogout,
    this.badges = const {},
    this.width = 318,
  });

  final List<PwaNavGroup> groups;

  /// Destinos sin grupo (se pintan arriba, sin cabecera). Chats va aquí.
  final List<PwaNavItem> loose;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onClose;
  final String userName;
  final String userRole;
  final VoidCallback onLogout;
  final Map<String, String> badges;
  final double width;

  @override
  State<CrmMenuDrawer> createState() => _CrmMenuDrawerState();
}

class _CrmMenuDrawerState extends State<CrmMenuDrawer> {
  late final Set<String> _open = {
    if (widget.groups.isNotEmpty) widget.groups.first.label,
  };

  static const _ink = Color(0xFF1F2937);
  static const _muted = Color(0xFF6B7A90);
  static const _line = Color(0xFFE6EAF0);
  static const _tile = Color(0xFFEEF1F5);
  static const _soft = Color(0xFFF4F8FB);
  static const _activeBg = Color(0xFFEAF1FF);
  static const _primary = Color(0xFF1957E6);

  @override
  void didUpdateWidget(covariant CrmMenuDrawer oldWidget) {
    super.didUpdateWidget(oldWidget);
    for (final group in widget.groups) {
      if (group.items.any((item) => item.tab == widget.current)) _open.add(group.label);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: widget.width,
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(right: BorderSide(color: _line)),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _brandCard(),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
                children: [
                  for (final item in widget.loose) _row(item, tileIcon: true),
                  for (final group in widget.groups)
                    // El grupo sin etiqueta son los destinos sueltos: ya se
                    // pintaron arriba, así que no se repiten aquí.
                    if (group.label.trim().isNotEmpty) ...[
                      if (group.collapsible) _groupRow(group) else const SizedBox(height: 4),
                      if (!group.collapsible || _open.contains(group.label))
                        for (final item in group.items) _row(item, indent: group.collapsible),
                    ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: _footerCard(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _brandCard() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _line),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Color(0xFF10233F), Color(0xFF1B3A6B)]),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(Icons.storefront_rounded, color: Colors.white, size: 22),
            ),
            const SizedBox(width: 12),
            const Expanded(
              child: Text(
                'FullTECH CRM',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w700,
                  color: _ink,
                  letterSpacing: -0.2,
                ),
              ),
            ),
            Tooltip(
              message: 'Cerrar menú',
              child: IconButton(
                onPressed: widget.onClose,
                iconSize: 18,
                color: _muted,
                icon: const Icon(Icons.close_rounded),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _groupRow(PwaNavGroup group) {
    final expanded = _open.contains(group.label);
    final active = group.items.any((item) => item.tab == widget.current);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: active && expanded ? _activeBg : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => setState(() => expanded ? _open.remove(group.label) : _open.add(group.label)),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
            child: Row(
              children: [
                _tileBox(group.items.first.icon, size: 36, active: active && expanded),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    group.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: active && expanded ? _primary : _ink,
                    ),
                  ),
                ),
                AnimatedRotation(
                  turns: expanded ? 0.25 : 0,
                  duration: const Duration(milliseconds: 160),
                  child: Icon(
                    Icons.chevron_right_rounded,
                    size: 19,
                    color: active && expanded ? _primary : _muted,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _row(PwaNavItem item, {bool indent = false, bool tileIcon = false}) {
    final selected = item.tab == widget.current;
    final badge = widget.badges[item.tab] ?? item.badge;
    return Padding(
      padding: EdgeInsets.only(left: indent ? 14 : 0, bottom: 3),
      child: Material(
        color: selected ? _activeBg : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => widget.onSelect(item.tab),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(6, 5, 8, 5),
            child: Row(
              children: [
                if (indent)
                  Container(
                    width: 3,
                    height: 16,
                    margin: const EdgeInsets.only(right: 8),
                    decoration: BoxDecoration(
                      color: selected ? _primary : Colors.transparent,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                if (tileIcon)
                  _tileBox(item.icon, size: 36, active: selected)
                else ...[
                  const SizedBox(width: 4),
                  PwaIcon(item.icon, size: 16, color: selected ? _primary : _muted),
                  const SizedBox(width: 8),
                ],
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    item.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: indent ? 13.5 : 14.5,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                      color: selected ? _primary : _ink,
                    ),
                  ),
                ),
                if ((badge ?? '').isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: const Color(0xFF25D366),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      badge!,
                      style: const TextStyle(
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
      ),
    );
  }

  Widget _tileBox(String asset, {required double size, bool active = false}) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: active ? _primary : _tile,
        borderRadius: BorderRadius.circular(size * 0.28),
      ),
      child: PwaIcon(asset, size: size * 0.5, color: active ? Colors.white : const Color(0xFF334155), opacity: 1),
    );
  }

  Widget _footerCard() {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: _soft,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _line),
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: _activeBg,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.cloud_done_rounded, size: 18, color: _primary),
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
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _ink),
                    ),
                    Text(
                      widget.userRole,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: _muted),
                    ),
                  ],
                ),
              ),
              Tooltip(
                message: 'Cerrar sesión',
                child: IconButton(
                  onPressed: widget.onLogout,
                  iconSize: 17,
                  color: const Color(0xFFDC2626),
                  icon: const Icon(Icons.logout_rounded),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Barra superior clara de 56 px que acompaña al menú (mismo lenguaje).
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
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(bottom: BorderSide(color: Color(0xFFE6EAF0))),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: const Color(0xFFEAF1FF),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFCFE0FF)),
            ),
            child: IconButton(
              tooltip: 'Menú',
              onPressed: onMenu,
              iconSize: 20,
              color: const Color(0xFF1957E6),
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
                  style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, color: Color(0xFF102235)),
                ),
                if (subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11.5, color: Color(0xFF6B7A90)),
                  ),
              ],
            ),
          ),
          if (loading)
            const SizedBox(
              width: 15,
              height: 15,
              child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF1957E6)),
            )
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: const Color(0xFFF4F8FB),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: const Color(0xFFE6EAF0)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 7, color: online ? const Color(0xFF16A34A) : const Color(0xFFDC2626)),
                  const SizedBox(width: 6),
                  Text(
                    online ? 'En línea' : 'Sin conexión',
                    style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF52667C)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
