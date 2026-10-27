import 'package:flutter/material.dart';

import 'chat_desktop_theme.dart';

/// Rail vertical ultra estrecho de la izquierda (58 px en la captura).
///
/// Solo contiene acciones **reales** del CRM: cambiar de módulo (delegado en
/// `onNavigate`), abrir el perfil y cerrar sesión. No hay botones decorativos.
class ChatNavigationRail extends StatelessWidget {
  const ChatNavigationRail({
    super.key,
    required this.currentTab,
    required this.onNavigate,
    required this.onLogout,
    this.unread = 0,
    this.initials = 'FT',
  });

  /// Pestaña activa del shell (para pintar el indicador verde).
  final String currentTab;
  final ValueChanged<String> onNavigate;
  final VoidCallback onLogout;
  final int unread;
  final String initials;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: ChatDesktopMetrics.railWidth,
      decoration: const BoxDecoration(
        color: ChatDesktopColors.railBg,
        border: Border(right: BorderSide(color: ChatDesktopColors.divider)),
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          _RailAvatar(label: _initials(initials), onTap: () => onNavigate('perfil')),
          const SizedBox(height: 8),
          const _RailDivider(),
          const SizedBox(height: 8),
          _RailButton(
            icon: Icons.forum_rounded,
            tooltip: 'Chats',
            selected: currentTab == 'whatsapp',
            badge: unread,
            onTap: () => onNavigate('whatsapp'),
          ),
          _RailButton(
            icon: Icons.receipt_long_outlined,
            tooltip: 'Pedidos',
            selected: currentTab == 'pedidos',
            onTap: () => onNavigate('pedidos'),
          ),
          _RailButton(
            icon: Icons.people_alt_outlined,
            tooltip: 'Clientes',
            selected: currentTab == 'clientes',
            onTap: () => onNavigate('clientes'),
          ),
          _RailButton(
            icon: Icons.map_outlined,
            tooltip: 'Mapa de entregas',
            selected: currentTab == 'mapa',
            onTap: () => onNavigate('mapa'),
          ),
          _RailButton(
            icon: Icons.point_of_sale_outlined,
            tooltip: 'Punto de venta',
            selected: currentTab == 'pos',
            onTap: () => onNavigate('pos'),
          ),
          const Spacer(),
          const _RailDivider(),
          _RailButton(
            icon: Icons.tune_rounded,
            tooltip: 'Configuración',
            selected: currentTab == 'ajustes',
            onTap: () => onNavigate('ajustes'),
          ),
          _RailButton(
            icon: Icons.logout_rounded,
            tooltip: 'Cerrar sesión',
            onTap: onLogout,
          ),
          const SizedBox(height: 10),
        ],
      ),
    );
  }
}

/// Iniciales para el avatar del rail (máximo dos letras).
String _initials(String value) {
  final parts = value.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return 'FT';
  if (parts.length == 1) {
    return parts.first.substring(0, parts.first.length >= 2 ? 2 : 1).toUpperCase();
  }
  return '${parts.first[0]}${parts[1][0]}'.toUpperCase();
}

class _RailDivider extends StatelessWidget {
  const _RailDivider();
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 1,
      width: 30,
      color: ChatDesktopColors.divider,
    );
  }
}

class _RailAvatar extends StatelessWidget {
  const _RailAvatar({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Mi perfil',
      waitDuration: const Duration(milliseconds: 400),
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: ChatDesktopMetrics.avatarRail,
          height: ChatDesktopMetrics.avatarRail,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: ChatDesktopColors.fieldBg,
            shape: BoxShape.circle,
          ),
          child: Text(
            label,
            style: const TextStyle(
              fontFamily: ChatDesktopMetrics.fontFamily,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: ChatDesktopColors.textPrimary,
            ),
          ),
        ),
      ),
    );
  }
}

class _RailButton extends StatefulWidget {
  const _RailButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.selected = false,
    this.badge = 0,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool selected;
  final int badge;

  @override
  State<_RailButton> createState() => _RailButtonState();
}

class _RailButtonState extends State<_RailButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final color = widget.selected
        ? ChatDesktopColors.accent
        : (_hovered ? ChatDesktopColors.textPrimary : ChatDesktopColors.textSecondary);
    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: InkWell(
          onTap: widget.onTap,
          child: SizedBox(
            height: 46,
            child: Stack(
              alignment: Alignment.center,
              children: [
                if (_hovered || widget.selected)
                  Positioned.fill(
                    child: Container(
                      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                      decoration: BoxDecoration(
                        color: ChatDesktopColors.rowHover,
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                if (widget.selected)
                  Positioned(
                    left: 0,
                    child: Container(
                      width: 3,
                      height: 22,
                      decoration: BoxDecoration(
                        color: ChatDesktopColors.accent,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                Icon(widget.icon, size: 20, color: color),
                if (widget.badge > 0)
                  Positioned(
                    right: 8,
                    top: 8,
                    child: Container(
                      constraints: const BoxConstraints(minWidth: 16),
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      decoration: BoxDecoration(
                        color: ChatDesktopColors.accent,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        widget.badge > 99 ? '99+' : '${widget.badge}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 9.5,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF0B1F16),
                        ),
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
