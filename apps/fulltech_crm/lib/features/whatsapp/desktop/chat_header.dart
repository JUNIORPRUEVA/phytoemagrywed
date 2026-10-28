import 'package:flutter/material.dart';

import 'chat_desktop_theme.dart';

/// Encabezado del hilo (56 px en la captura): avatar, nombre, estado real y
/// acciones. Las acciones del CRM llegan desde fuera (`menu`) para no duplicar
/// lógica.
class ChatHeader extends StatelessWidget {
  const ChatHeader({
    super.key,
    required this.name,
    required this.subtitle,
    required this.menu,
    this.onCall,
    this.searching = false,
    this.searchController,
    this.onSearchChanged,
    this.onToggleSearch,
  });

  final String name;
  final String subtitle;
  final List<Widget> menu;
  final VoidCallback? onCall;
  final bool searching;
  final TextEditingController? searchController;
  final ValueChanged<String>? onSearchChanged;
  final VoidCallback? onToggleSearch;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      height: ChatDesktopMetrics.headerHeight,
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(bottom: BorderSide(color: c.divider)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Row(
        children: [
          _HeaderAvatar(label: name),
          const SizedBox(width: 12),
          Expanded(
            child: searching
                ? SizedBox(
                    height: 32,
                    child: TextField(
                      controller: searchController,
                      onChanged: onSearchChanged,
                      autofocus: true,
                      style: TextStyle(
                        fontFamily: ChatDesktopMetrics.fontFamily,
                        fontSize: 13.5,
                        color: c.textPrimary,
                      ),
                      cursorColor: c.accent,
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        hintText: 'Buscar en la conversación',
                        hintStyle: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 13.5,
                          color: c.textSecondary,
                        ),
                      ),
                    ),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.headerName),
                      if (subtitle.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: Text(
                            subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.headerSubtitle,
                          ),
                        ),
                    ],
                  ),
          ),
          if (onToggleSearch != null)
            _HeaderButton(
              icon: searching ? Icons.close_rounded : Icons.search_rounded,
              tooltip: searching ? 'Cerrar búsqueda' : 'Buscar en la conversación',
              onTap: onToggleSearch!,
            ),
          if (onCall != null)
            _HeaderButton(icon: Icons.call_outlined, tooltip: 'Llamar', onTap: onCall!),
          ...menu,
        ],
      ),
    );
  }
}

class _HeaderAvatar extends StatelessWidget {
  const _HeaderAvatar({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final initials = _initials(label);
    return Container(
      width: ChatDesktopMetrics.avatarHeader,
      height: ChatDesktopMetrics.avatarHeader,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.fieldBg, shape: BoxShape.circle),
      child: Text(
        initials,
        style: TextStyle(
          fontFamily: ChatDesktopMetrics.fontFamily,
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: c.textPrimary,
        ),
      ),
    );
  }

  static String _initials(String value) {
    final parts = value.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, parts.first.length >= 2 ? 2 : 1).toUpperCase();
    return '${parts.first[0]}${parts.last[0]}'.toUpperCase();
  }
}

class _HeaderButton extends StatefulWidget {
  const _HeaderButton({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_HeaderButton> createState() => _HeaderButtonState();
}

class _HeaderButtonState extends State<_HeaderButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: InkWell(
          onTap: widget.onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: 34,
            height: 34,
            margin: const EdgeInsets.only(left: 4),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _hovered ? c.rowHover : Colors.transparent,
            ),
            child: Icon(widget.icon, size: 19, color: c.textSecondary),
          ),
        ),
      ),
    );
  }
}