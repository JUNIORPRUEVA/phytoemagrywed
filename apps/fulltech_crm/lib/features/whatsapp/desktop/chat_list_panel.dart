import 'package:flutter/material.dart';

import '../../../core/format/crm_format.dart';
import '../../../data/models/crm_models.dart';
import 'chat_desktop_theme.dart';

/// Filtros reales de la bandeja (ya existían en el CRM móvil).
const List<String> chatFilters = ['todos', 'sin_leer', 'pendientes', 'finalizadas'];

const Map<String, String> chatFilterLabels = {
  'todos': 'Todos',
  'sin_leer': 'Sin leer',
  'pendientes': 'Pendientes',
  'finalizadas': 'Finalizadas',
};

/// Panel izquierdo de conversaciones (342 px en la captura): título, menú,
/// acción circular, buscador, chips de filtro y lista.
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
            height: 62,
            child: Padding(
              padding: const EdgeInsets.only(left: 18, right: 10),
              child: Row(
                children: [
                  Expanded(child: Text('Chats', style: t.title)),
                  _IconAction(
                    icon: Icons.more_vert_rounded,
                    tooltip: 'Opciones de la bandeja',
                    onTap: () => _openMenu(context),
                  ),
                  const SizedBox(width: 4),
                  _RoundAction(
                    tooltip: 'Buscar conversación',
                    onTap: () => _searchFocus.requestFocus(),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
            child: Container(
              height: ChatDesktopMetrics.searchHeight,
              decoration: BoxDecoration(
                color: c.fieldBg,
                borderRadius: BorderRadius.circular(18),
              ),
              child: Row(
                children: [
                  const SizedBox(width: 12),
                  Icon(Icons.search_rounded, size: 18, color: c.textSecondary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: widget.search,
                      focusNode: _searchFocus,
                      onChanged: widget.onSearchChanged,
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
                        hintText: 'Buscar o iniciar un chat',
                        hintStyle: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 13.5,
                          color: c.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  if (widget.search.text.isNotEmpty)
                    IconButton(
                      tooltip: 'Limpiar',
                      iconSize: 16,
                      color: c.textSecondary,
                      onPressed: () {
                        widget.search.clear();
                        widget.onSearchChanged('');
                      },
                      icon: const Icon(Icons.close_rounded),
                    ),
                ],
              ),
            ),
          ),
          _FilterChips(
            value: widget.filter,
            onChanged: widget.onFilterChanged,
          ),
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
    final offset = renderBox == null ? Offset.zero : renderBox.localToGlobal(Offset(260, 52));
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

class _FilterChips extends StatelessWidget {
  const _FilterChips({required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 10),
        itemCount: chatFilters.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final option = chatFilters[index];
          final selected = option == value;
          return InkWell(
            onTap: () => onChanged(option),
            borderRadius: BorderRadius.circular(999),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: selected ? c.rowSelected : c.fieldBg,
                borderRadius: BorderRadius.circular(999),
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

/// Fila de conversación: avatar, nombre, vista previa, hora y no leídos.
class ConversationListTile extends StatefulWidget {
  const ConversationListTile({
    super.key,
    required this.conversation,
    required this.selected,
    required this.onTap,
  });

  final Conversation conversation;
  final bool selected;
  final VoidCallback onTap;

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
          height: ChatDesktopMetrics.rowHeight,
          color: background,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              _ListAvatar(label: conversation.name),
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
                            style: t.rowName,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          CrmFormat.chatStamp(conversation.lastAt),
                          style: t.stamp.copyWith(
                            color: unread ? c.accent : c.textSecondary,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        if (conversation.lastDirection == 'outbound' || conversation.lastDirection == 'out')
                          Padding(
                            padding: EdgeInsets.only(right: 4),
                            child: Icon(Icons.done_all_rounded, size: 14, color: c.textSecondary),
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
                              width: 8,
                              height: 8,
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
            ],
          ),
        ),
      ),
    );
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
      child: Icon(icon, size: 14, color: c.textSecondary),
    );
  }
}

class _ListAvatar extends StatelessWidget {
  const _ListAvatar({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final initials = _initials(label);
    return Container(
      width: ChatDesktopMetrics.avatarList,
      height: ChatDesktopMetrics.avatarList,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.fieldBg, shape: BoxShape.circle),
      child: Text(
        initials,
        style: TextStyle(
          fontFamily: ChatDesktopMetrics.fontFamily,
          fontSize: 15,
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

class _IconAction extends StatefulWidget {
  const _IconAction({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_IconAction> createState() => _IconActionState();
}

class _IconActionState extends State<_IconAction> {
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
            width: 32,
            height: 32,
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

class _RoundAction extends StatefulWidget {
  const _RoundAction({required this.tooltip, required this.onTap});

  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_RoundAction> createState() => _RoundActionState();
}

class _RoundActionState extends State<_RoundAction> {
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
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _hovered ? c.rowSelected : c.fieldBg,
            ),
            child: Icon(Icons.chat_rounded, size: 17, color: c.textPrimary),
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
            const SizedBox(height: 10),
            Text(
              'Sin conversaciones con este filtro',
              textAlign: TextAlign.center,
              style: t.rowPreview.copyWith(color: c.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}