import 'package:flutter/material.dart';

import '../../../core/theme/crm_tokens.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';

/// Encabezado del hilo: versión fina (46 px) sin foto, con la información
/// compacta y las acciones a la derecha.
///
/// Las acciones del CRM llegan desde fuera (`menu`) para no duplicar lógica;
/// la de «nuevo mensaje» se inyecta con [onNewMessage].
class ChatHeader extends StatelessWidget {
  const ChatHeader({
    super.key,
    required this.name,
    required this.subtitle,
    required this.menu,
    this.onCall,
    this.onNewMessage,
    this.searching = false,
    this.searchController,
    this.onSearchChanged,
    this.onToggleSearch,
  });

  final String name;
  final String subtitle;
  final List<Widget> menu;
  final VoidCallback? onCall;

  /// Abre el diálogo de nuevo mensaje (crear/recuperar cliente por teléfono).
  final VoidCallback? onNewMessage;
  final bool searching;
  final TextEditingController? searchController;
  final ValueChanged<String>? onSearchChanged;
  final VoidCallback? onToggleSearch;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      height: 46,
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(bottom: BorderSide(color: c.divider)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        children: [
          Expanded(
            child: searching
                ? _HeaderSearch(
                    controller: searchController,
                    onChanged: onSearchChanged,
                    onClose: onToggleSearch,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.headerName.copyWith(fontSize: 14.5, fontWeight: FontWeight.w700),
                      ),
                      if (subtitle.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: Text(
                            subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.headerSubtitle.copyWith(fontSize: 11.5),
                          ),
                        ),
                    ],
                  ),
          ),
          if (onToggleSearch != null)
            _HeaderButton(
              asset: PwaIcons.search,
              tooltip: searching ? 'Cerrar búsqueda' : 'Buscar en la conversación',
              onTap: onToggleSearch!,
            ),
          if (onCall != null)
            _HeaderButton(icon: Icons.call_outlined, tooltip: 'Llamar', onTap: onCall!),
          if (onNewMessage != null)
            _HeaderButton(
              asset: PwaIcons.plus,
              tooltip: 'Nuevo mensaje a un cliente',
              onTap: onNewMessage!,
              highlighted: true,
            ),
          ...menu,
        ],
      ),
    );
  }
}

/// Buscador del hilo: cuadrado (radio 8) y con el icono original del panel.
class _HeaderSearch extends StatelessWidget {
  const _HeaderSearch({required this.controller, required this.onChanged, this.onClose});

  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      height: 32,
      constraints: const BoxConstraints(maxWidth: 420),
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: c.divider),
      ),
      child: Row(
        children: [
          const SizedBox(width: 9),
          PwaIcon(PwaIcons.search, size: 14, color: c.textSecondary),
          const SizedBox(width: 7),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              autofocus: true,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 13,
                color: c.textPrimary,
              ),
              cursorColor: c.accent,
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                hintText: 'Buscar en la conversación',
                hintStyle: TextStyle(
                  fontFamily: ChatDesktopMetrics.fontFamily,
                  fontSize: 13,
                  color: c.textSecondary,
                ),
              ),
            ),
          ),
          if (onClose != null)
            IconButton(
              tooltip: 'Cerrar búsqueda',
              iconSize: 14,
              color: c.textSecondary,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              onPressed: onClose,
              icon: const Icon(Icons.close_rounded),
            ),
        ],
      ),
    );
  }
}

class _HeaderButton extends StatefulWidget {
  const _HeaderButton({
    required this.tooltip,
    required this.onTap,
    this.icon,
    this.asset,
    this.highlighted = false,
  });

  final IconData? icon;
  final String? asset;
  final String tooltip;
  final VoidCallback onTap;

  /// Acento suave para la acción principal (nuevo mensaje).
  final bool highlighted;

  @override
  State<_HeaderButton> createState() => _HeaderButtonState();
}

class _HeaderButtonState extends State<_HeaderButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final tint = widget.highlighted ? c.accent : (_hovered ? c.textPrimary : c.textSecondary);
    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: InkWell(
          onTap: widget.onTap,
          borderRadius: BorderRadius.circular(7),
          child: Container(
            width: 30,
            height: 30,
            margin: const EdgeInsets.only(left: 4),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(7),
              color: _hovered ? c.rowHover : Colors.transparent,
            ),
            child: widget.asset != null
                ? PwaIcon(widget.asset!, size: 15, color: tint)
                : Icon(widget.icon, size: 18, color: tint),
          ),
        ),
      ),
    );
  }
}
