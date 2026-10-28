import 'package:flutter/material.dart';

import '../../../core/format/crm_format.dart';
import '../../../core/theme/crm_tokens.dart';
import '../../../data/models/crm_models.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';
import 'conversation_actions.dart';

/// Filtros reales de la bandeja (ya existían en el CRM móvil).
const List<String> chatFilters = ['todos', 'sin_leer', 'pendientes', 'finalizadas'];

const Map<String, String> chatFilterLabels = {
  'todos': 'Todos',
  'sin_leer': 'Sin leer',
  'pendientes': 'Pendientes',
  'finalizadas': 'Finalizadas',
};

/// Panel izquierdo de conversaciones (342 px en la captura): título, menú,
/// buscador cuadrado, chips de filtro y lista.
///
/// La lista es deliberadamente limpia: sin foto/avatar, con el autor del último
/// mensaje («Tú» o «Cliente») y un botón de acciones por fila con las mismas
/// opciones que la app móvil.
class ChatListPanel extends StatefulWidget {
  const ChatListPanel({
    super.key,
    required this.conversations,
    required this.selectedId,
    required this.onSelect,
    required this.search,
    required this.onSearchChanged,
    required this.filter,
    required this.onFilterChanged,
    required this.onRefresh,
    this.onAction,
    this.unreadTotal = 0,
  });

  final List<Conversation> conversations;
  final String? selectedId;
  final ValueChanged<String> onSelect;
  final TextEditingController search;
  final ValueChanged<String> onSearchChanged;
  final String filter;
  final ValueChanged<String> onFilterChanged;
  final VoidCallback onRefresh;

  /// Acciones por fila (abrir, marcar leído, finalizar, asignación…).
  final void Function(Conversation conversation, String action)? onAction;
  final int unreadTotal;

  @override
  State<ChatListPanel> createState() => _ChatListPanelState();
}

class _ChatListPanelState extends State<ChatListPanel> {
  final _searchFocus = FocusNode();
  bool _newestFirst = true;

  @override
  void dispose() {
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final rows = List<Conversation>.of(widget.conversations)
      ..sort((a, b) => _newestFirst ? b.lastAt.compareTo(a.lastAt) : a.lastAt.compareTo(b.lastAt));

    return Container(
      width: ChatDesktopMetrics.listWidth,
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(right: BorderSide(color: c.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(18, 0, 8, 0),
              child: Row(
                children: [
                  Expanded(child: Text('WhatsApp', style: t.title.copyWith(fontSize: 20))),
                  _PanelAction(
                    icon: Icons.more_vert_rounded,
                    tooltip: 'Opciones de la bandeja',
                    onTap: () => _openMenu(context),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
            child: _SearchBox(
              controller: widget.search,
              focusNode: _searchFocus,
              hint: 'Buscar o iniciar un chat',
              onChanged: widget.onSearchChanged,
              onClear: () {
                widget.search.clear();
                widget.onSearchChanged('');
              },
            ),
          ),
          _FilterChips(value: widget.filter, onChanged: widget.onFilterChanged),
          Divider(height: 1, thickness: 1, color: c.divider),
          Expanded(
            child: rows.isEmpty
                ? const _EmptyList()
                : ListView.builder(
                    itemCount: rows.length,
                    itemBuilder: (context, index) {
                      final row = rows[index];
                      return ConversationListTile(
                        conversation: row,
                        selected: row.id == widget.selectedId,
                        onTap: () => widget.onSelect(row.id),
                        onAction: widget.onAction == null
                            ? null
                            : (action) => widget.onAction!(row, action),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  void _openMenu(BuildContext context) {
    final c = ChatPalette.of(context);
    final renderBox = context.findRenderObject() as RenderBox?;
    final offset = renderBox == null ? Offset.zero : renderBox.localToGlobal(Offset(280, 48));
    showMenu<String>(
      context: context,
      color: c.fieldBg,
      position: RelativeRect.fromLTRB(offset.dx, offset.dy, offset.dx, offset.dy),
      items: [
        PopupMenuItem(
          value: 'refresh',
          child: Text('Actualizar bandeja', style: TextStyle(color: c.textPrimary, fontSize: 13)),
        ),
        PopupMenuItem(
          value: 'sort',
          child: Text(
            _newestFirst ? 'Ordenar: más antiguas primero' : 'Ordenar: más recientes primero',
            style: TextStyle(color: c.textPrimary, fontSize: 13),
          ),
        ),
      ],
    ).then((value) {
      if (!mounted) return;
      if (value == 'refresh') widget.onRefresh();
      if (value == 'sort') setState(() => _newestFirst = !_newestFirst);
    });
  }
}

/// Buscador cuadrado (radio 10) con el icono original del panel.
class _SearchBox extends StatelessWidget {
  const _SearchBox({
    required this.controller,
    required this.focusNode,
    required this.hint,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final String hint;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      height: ChatDesktopMetrics.searchHeight,
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: c.divider),
      ),
      child: Row(
        children: [
          const SizedBox(width: 10),
          PwaIcon(PwaIcons.search, size: 15, color: c.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              onChanged: onChanged,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 13.5,
                color: c.textPrimary,
              ),
              cursorColor: c.accent,
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                hintText: hint,
                hintStyle: TextStyle(
                  fontFamily: ChatDesktopMetrics.fontFamily,
                  fontSize: 13.5,
                  color: c.textSecondary,
                ),
              ),
            ),
          ),
          if (controller.text.isNotEmpty)
            IconButton(
              tooltip: 'Limpiar',
              iconSize: 15,
              color: c.textSecondary,
              onPressed: onClear,
              icon: const Icon(Icons.close_rounded),
            ),
        ],
      ),
    );
  }
}

class _FilterChips extends StatelessWidget {
  const _FilterChips({required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return SizedBox(
      height: 42,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
        itemCount: chatFilters.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final option = chatFilters[index];
          final selected = option == value;
          return InkWell(
            onTap: () => onChanged(option),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: selected ? c.rowSelected : c.fieldBg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: selected ? c.accent.withValues(alpha: 0.5) : Colors.transparent,
                ),
              ),
              alignment: Alignment.center,
              child: Text(
                chatFilterLabels[option] ?? option,
                style: t.chip.copyWith(
                  color: selected ? c.accent : c.textSecondary,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Fila de conversación sin avatar: nombre, hora, autor del último mensaje,
/// vista previa, no leídos y botón de acciones.
class ConversationListTile extends StatefulWidget {
  const ConversationListTile({
    super.key,
    required this.conversation,
    required this.selected,
    required this.onTap,
    this.onAction,
  });

  final Conversation conversation;
  final bool selected;
  final VoidCallback onTap;

  /// Abre el menú de acciones de la fila (se pasa la acción elegida).
  final ValueChanged<String>? onAction;

  @override
  State<ConversationListTile> createState() => _ConversationListTileState();
}

class _ConversationListTileState extends State<ConversationListTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final conversation = widget.conversation;
    final unread = conversation.unread > 0;
    final outbound = conversation.lastDirection == 'outbound' || conversation.lastDirection == 'out';
    final background = widget.selected
        ? c.rowSelected
        : (_hovered ? c.rowHover : Colors.transparent);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: 64,
          color: background,
          child: Row(
            children: [
              // Barra de acento de la fila activa (sustituye a la foto).
              Container(
                width: 3,
                height: double.infinity,
                color: widget.selected ? c.accent : Colors.transparent,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            conversation.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.rowName.copyWith(
                              fontWeight: unread ? FontWeight.w700 : FontWeight.w600,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          CrmFormat.chatStamp(conversation.lastAt),
                          style: t.stamp.copyWith(
                            color: unread ? c.accent : c.textSecondary,
                            fontWeight: unread ? FontWeight.w600 : FontWeight.w400,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          margin: const EdgeInsets.only(right: 6),
                          decoration: BoxDecoration(
                            color: outbound
                                ? c.accent.withValues(alpha: 0.14)
                                : c.fieldBg,
                            borderRadius: BorderRadius.circular(5),
                          ),
                          child: Text(
                            outbound ? 'Tú' : 'Cliente',
                            style: TextStyle(
                              fontFamily: ChatDesktopMetrics.fontFamily,
                              fontSize: 10,
                              fontWeight: FontWeight.w700,
                              color: outbound ? c.accent : c.textSecondary,
                            ),
                          ),
                        ),
                        _TypeGlyph(type: conversation.lastType),
                        Expanded(
                          child: Text(
                            conversation.lastBody.isEmpty ? '—' : conversation.lastBody,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.rowPreview,
                          ),
                        ),
                        if (unread)
                          Container(
                            constraints: const BoxConstraints(minWidth: 20),
                            height: 20,
                            margin: const EdgeInsets.only(left: 6),
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: c.accent,
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              '${conversation.unread}',
                              style: const TextStyle(
                                fontFamily: ChatDesktopMetrics.fontFamily,
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF0B1F16),
                              ),
                            ),
                          ),
                        if (!unread && (conversation.awaitingReply || conversation.isResolved))
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: conversation.isResolved
                                    ? c.textSecondary
                                    : c.warning,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              if (widget.onAction != null)
                // Siempre visible en tenue; se ilumina al pasar el ratón.
                AnimatedOpacity(
                  duration: const Duration(milliseconds: 120),
                  opacity: (_hovered || widget.selected) ? 1 : 0.45,
                  child: _PanelAction(
                    icon: Icons.more_vert_rounded,
                    tooltip: 'Acciones del chat',
                    onTap: () => _openActions(context),
                  ),
                )
              else
                const SizedBox(width: 8),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openActions(BuildContext context) async {
    final c = ChatPalette.of(context);
    final box = context.findRenderObject() as RenderBox?;
    final offset = box == null ? Offset.zero : box.localToGlobal(Offset(box.size.width - 190, 40));
    final action = await showMenu<String>(
      context: context,
      color: c.fieldBg,
      position: RelativeRect.fromLTRB(offset.dx, offset.dy, offset.dx, offset.dy),
      items: [
        for (final option in ConversationActions.options(widget.conversation))
          PopupMenuItem(
            value: option,
            child: Row(
              children: [
                Icon(
                  ConversationActions.icon(option),
                  size: 16,
                  color: option == 'resolve' ? c.danger : c.textSecondary,
                ),
                const SizedBox(width: 10),
                Text(
                  ConversationActions.label(option),
                  style: TextStyle(
                    fontSize: 13,
                    color: option == 'resolve' ? c.danger : c.textPrimary,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
    if (action == null || !mounted) return;
    widget.onAction?.call(action);
  }
}

class _TypeGlyph extends StatelessWidget {
  const _TypeGlyph({required this.type});

  final String type;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final icon = switch (type) {
      'image' => Icons.photo_outlined,
      'audio' => Icons.mic_none_rounded,
      'document' => Icons.description_outlined,
      'video' => Icons.videocam_outlined,
      'location' => Icons.place_outlined,
      'sticker' => Icons.emoji_emotions_outlined,
      _ => null,
    };
    if (icon == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Icon(icon, size: 13, color: c.textSecondary),
    );
  }
}

class _PanelAction extends StatefulWidget {
  const _PanelAction({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_PanelAction> createState() => _PanelActionState();
}

class _PanelActionState extends State<_PanelAction> {
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
            width: 30,
            height: 30,
            margin: const EdgeInsets.only(right: 8),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _hovered ? c.rowSelected : Colors.transparent,
            ),
            child: Icon(widget.icon, size: 18, color: c.textSecondary),
          ),
        ),
      ),
    );
  }
}

class _EmptyList extends StatelessWidget {
  const _EmptyList();

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 34, color: c.textSecondary),
            const SizedBox(height: 12),
            Text('Sin conversaciones', style: t.rowName.copyWith(fontSize: 14)),
            const SizedBox(height: 6),
            Text(
              'Cuando un cliente escriba, aparecerá aquí.',
              textAlign: TextAlign.center,
              style: t.rowPreview,
            ),
          ],
        ),
      ),
    );
  }
}
