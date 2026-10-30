import 'package:flutter/material.dart';

import '../../../core/format/crm_format.dart';
import '../../../core/theme/crm_tokens.dart';
import '../../../data/models/crm_models.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';
import 'chat_filters.dart';

/// Panel izquierdo de conversaciones: título, acciones (nuevo chat, filtros,
/// menú), buscador cuadrado y lista.
///
/// La lista es limpia y funcional: sin foto, con el autor del último mensaje,
/// la asignación y la etapa del cliente, y un menú por fila con todas las
/// acciones (incluido el modo de selección múltiple).
class ChatListPanel extends StatefulWidget {
  const ChatListPanel({
    super.key,
    required this.conversations,
    required this.selectedId,
    required this.onSelect,
    required this.search,
    required this.onSearchChanged,
    required this.filters,
    required this.onFiltersChanged,
    required this.onOpenFilters,
    required this.onRefresh,
    required this.onNewConversation,
    this.onAction,
    this.selecting = false,
    this.selectedIds = const {},
    this.onSelectingChanged,
    this.onToggleSelected,
    this.onBulkAction,
    this.unreadTotal = 0,
  });

  final List<Conversation> conversations;
  final String? selectedId;
  final ValueChanged<String> onSelect;
  final TextEditingController search;
  final ValueChanged<String> onSearchChanged;
  final ChatFilters filters;
  final ValueChanged<ChatFilters> onFiltersChanged;

  /// Abre/cierra la columna lateral de filtros.
  final VoidCallback onOpenFilters;
  final VoidCallback onRefresh;

  /// Abre el diálogo de «nuevo mensaje».
  final VoidCallback onNewConversation;

  /// Acciones por fila (abrir, leído, foto, seguimiento, asignación,
  /// finalizar, archivar, seleccionar).
  final void Function(Conversation conversation, String action)? onAction;

  /// Modo de selección múltiple.
  final bool selecting;
  final Set<String> selectedIds;
  final ValueChanged<bool>? onSelectingChanged;
  final ValueChanged<String>? onToggleSelected;

  /// Acción en lote: `mark_read` | `archive` | `resolve` | `cancel`.
  final ValueChanged<String>? onBulkAction;
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
            height: 52,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 6, 0),
              child: Row(
                children: [
                  Expanded(child: Text('WhatsApp', style: t.title.copyWith(fontSize: 19))),
                  _PanelAction(
                    asset: PwaIcons.plus,
                    tooltip: 'Nuevo mensaje',
                    accent: true,
                    onTap: widget.onNewConversation,
                  ),
                  _FilterButton(
                    active: !widget.filters.isDefault,
                    onTap: widget.onOpenFilters,
                  ),
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
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
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
          if (!widget.filters.isDefault)
            _ActiveFiltersBar(
              filters: widget.filters,
              onClear: () => widget.onFiltersChanged(const ChatFilters()),
            ),
          if (widget.selecting)
            _SelectionBar(
              count: widget.selectedIds.length,
              onCancel: () => widget.onSelectingChanged?.call(false),
              onAction: (action) => widget.onBulkAction?.call(action),
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
                        selecting: widget.selecting,
                        checked: widget.selectedIds.contains(row.id),
                        onToggleCheck: widget.onToggleSelected == null
                            ? null
                            : () => widget.onToggleSelected!(row.id),
                        onTap: widget.selecting
                            ? () => widget.onToggleSelected?.call(row.id)
                            : () => widget.onSelect(row.id),
                        onAction: widget.onAction == null || widget.selecting
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
    final offset = renderBox == null ? Offset.zero : renderBox.localToGlobal(Offset(300, 46));
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
        PopupMenuItem(
          value: 'select',
          child: Text('Seleccionar conversaciones', style: TextStyle(color: c.textPrimary, fontSize: 13)),
        ),
      ],
    ).then((value) {
      if (!mounted) return;
      if (value == 'refresh') widget.onRefresh();
      if (value == 'sort') setState(() => _newestFirst = !_newestFirst);
      if (value == 'select') widget.onSelectingChanged?.call(true);
    });
  }
}

/// Botón de filtros: abre una tarjeta con estado, etapa y fecha.
/// Botón de filtros: abre la columna lateral con estado, etapa y fecha.
class _FilterButton extends StatelessWidget {
  const _FilterButton({required this.active, required this.onTap});

  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        _PanelAction(
          asset: PwaIcons.filter,
          tooltip: 'Filtros',
          onTap: onTap,
          active: active,
        ),
        if (active)
          Positioned(
            right: 6,
            top: 4,
            child: Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
            ),
          ),
      ],
    );
  }
}

class _ActiveFiltersBar extends StatelessWidget {
  const _ActiveFiltersBar({required this.filters, required this.onClear});

  final ChatFilters filters;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final parts = [
      if (filters.status != ChatStatusFilter.todos) chatStatusLabels[filters.status]!,
      if (filters.stage != ChatStageFilter.todas) chatStageLabels[filters.stage]!,
      if (filters.date != ChatDateFilter.cualquiera) chatDateLabels[filters.date]!,
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              parts.join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 11.5,
                color: c.textSecondary,
              ),
            ),
          ),
          InkWell(
            onTap: onClear,
            child: Text(
              'Quitar',
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: c.accent,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Barra del modo de selección múltiple.
class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.count, required this.onCancel, required this.onAction});

  final int count;
  final VoidCallback onCancel;
  final ValueChanged<String> onAction;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    Widget action(String label, String value, {bool danger = false}) => InkWell(
      onTap: count == 0 ? null : () => onAction(value),
      borderRadius: BorderRadius.circular(7),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: ChatDesktopMetrics.fontFamily,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: count == 0
                ? c.textSecondary.withValues(alpha: 0.5)
                : (danger ? c.danger : c.accent),
          ),
        ),
      ),
    );
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: c.divider),
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: 'Salir de la selección',
            iconSize: 16,
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
            color: c.textSecondary,
            onPressed: onCancel,
            icon: const Icon(Icons.close_rounded),
          ),
          Text(
            '$count seleccionado${count == 1 ? '' : 's'}',
            style: TextStyle(
              fontFamily: ChatDesktopMetrics.fontFamily,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: c.textPrimary,
            ),
          ),
          const Spacer(),
          action('Leído', 'mark_read'),
          action('Finalizar', 'resolve'),
          action('Archivar', 'archive', danger: true),
        ],
      ),
    );
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
        borderRadius: BorderRadius.circular(9),
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

/// Fila de conversación: nombre, etiqueta del autor, vista previa, asignación,
/// etapa, no leídos y menú de acciones. Sin foto.
class ConversationListTile extends StatefulWidget {
  const ConversationListTile({
    super.key,
    required this.conversation,
    required this.selected,
    required this.onTap,
    this.selecting = false,
    this.checked = false,
    this.onToggleCheck,
    this.onAction,
  });

  final Conversation conversation;
  final bool selected;
  final VoidCallback onTap;
  final bool selecting;
  final bool checked;
  final VoidCallback? onToggleCheck;
  final ValueChanged<String>? onAction;

  @override
  State<ConversationListTile> createState() => _ConversationListTileState();
}

class _ConversationListTileState extends State<ConversationListTile> {
  bool _hovered = false;

  static const _stageLabels = {
    'NUEVO': 'Nuevo',
    'EN_CONVERSACION': 'En conversación',
    'PROSPECT': 'Prospecto',
    'PROSPECTOS': 'Prospecto',
    'INTERESADO': 'Interesado',
    'INTERESTED': 'Interesado',
    'PEDIDO_CREADO': 'Pedido creado',
    'CONFIRMADO': 'Confirmado',
    'ENTREGADO': 'Entregado',
    'SEGUIMIENTO': 'En seguimiento',
    'RECOMPRA': 'Recompra',
    'REPEAT_CUSTOMER': 'Recompra',
    'CUSTOMER': 'Cliente',
    'PERDIDO': 'Perdido',
    'INACTIVE': 'Inactivo',
  };

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final conversation = widget.conversation;
    final unread = conversation.unread > 0;
    final outbound = conversation.lastDirection == 'outbound' || conversation.lastDirection == 'out';
    final background = widget.checked
        ? c.accent.withValues(alpha: 0.10)
        : (widget.selected ? c.rowSelected : (_hovered ? c.rowHover : Colors.transparent));
    final stage = _stageLabels[conversation.stage.toUpperCase()] ?? conversation.stage;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: 82,
          color: background,
          child: Row(
            children: [
              Container(
                width: 3,
                height: double.infinity,
                color: widget.selected && !widget.selecting ? c.accent : Colors.transparent,
              ),
              if (widget.selecting)
                Padding(
                  padding: const EdgeInsets.only(left: 8, right: 2),
                  child: _Check(
                    checked: widget.checked,
                    onTap: widget.onToggleCheck,
                  ),
                )
              else
                const SizedBox(width: 13),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Nombre + etiqueta diminuta del autor + hora.
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            conversation.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.rowName.copyWith(
                              fontSize: 14,
                              fontWeight: unread ? FontWeight.w700 : FontWeight.w600,
                            ),
                          ),
                        ),
                        const SizedBox(width: 5),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                          decoration: BoxDecoration(
                            color: outbound
                                ? c.accent.withValues(alpha: 0.16)
                                : c.fieldBg,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            outbound ? 'Tú' : 'Cliente',
                            style: TextStyle(
                              fontFamily: ChatDesktopMetrics.fontFamily,
                              fontSize: 8.5,
                              height: 1.1,
                              fontWeight: FontWeight.w700,
                              color: outbound ? c.accent : c.textSecondary,
                            ),
                          ),
                        ),
                        const Spacer(),
                        Text(
                          CrmFormat.chatStamp(conversation.lastAt),
                          style: t.stamp.copyWith(
                            color: unread ? c.accent : c.textSecondary,
                            fontSize: 10.5,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        _TypeGlyph(type: conversation.lastType),
                        Expanded(
                          child: Text(
                            conversation.lastBody.isEmpty ? '—' : conversation.lastBody,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t.rowPreview.copyWith(fontSize: 12.5),
                          ),
                        ),
                        if (unread)
                          Container(
                            constraints: const BoxConstraints(minWidth: 18),
                            height: 18,
                            margin: const EdgeInsets.only(left: 6),
                            padding: const EdgeInsets.symmetric(horizontal: 5),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: c.accent,
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              '${conversation.unread}',
                              style: TextStyle(
                                fontFamily: ChatDesktopMetrics.fontFamily,
                                fontSize: 10.5,
                                fontWeight: FontWeight.w700,
                                color: c.onAccent,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    // Asignación + etapa del cliente.
                    Row(
                      children: [
                        _MetaChip(
                          icon: conversation.assigned
                              ? Icons.person_outline_rounded
                              : Icons.person_off_outlined,
                          label: conversation.assigned
                              ? 'Asignado: ${conversation.assignedName.isEmpty ? 'Compañero' : conversation.assignedName}'
                              : 'Sin asignar',
                          color: conversation.assigned ? c.accent : c.textSecondary,
                        ),
                        const SizedBox(width: 5),
                        Flexible(
                          child: _MetaChip(
                            icon: Icons.sell_outlined,
                            label: stage,
                            color: c.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              if (widget.onAction != null)
                AnimatedOpacity(
                  duration: const Duration(milliseconds: 120),
                  opacity: (_hovered || widget.selected) ? 1 : 0.4,
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
    final offset = box == null ? Offset.zero : box.localToGlobal(Offset(box.size.width - 235, 40));
    final actions = <(String, IconData, String, bool)>[
      ('open', Icons.forum_outlined, 'Abrir conversación', false),
      if (widget.conversation.unread > 0) ('read', Icons.mark_chat_read_outlined, 'Marcar como leído', false),
      ('photo', Icons.image_outlined, 'Enviar una foto', false),
      ('followup', Icons.event_repeat_outlined, 'Crear seguimiento', false),
      ('assign', Icons.assignment_ind_outlined, 'Asignación…', false),
      widget.conversation.isResolved
          ? ('reopen', Icons.restart_alt_rounded, 'Reabrir conversación', false)
          : ('resolve', Icons.task_alt_rounded, 'Finalizar conversación', true),
      widget.conversation.archived
          ? ('unarchive', Icons.unarchive_outlined, 'Desarchivar', false)
          : ('archive', Icons.archive_outlined, 'Archivar', false),
      ('select', Icons.checklist_rounded, 'Seleccionar', false),
    ];
    final action = await showMenu<String>(
      context: context,
      color: c.fieldBg,
      position: RelativeRect.fromLTRB(offset.dx, offset.dy, offset.dx, offset.dy),
      items: [
        for (final item in actions)
          PopupMenuItem(
            value: item.$1,
            child: Row(
              children: [
                Icon(item.$2, size: 16, color: item.$4 ? c.danger : c.textSecondary),
                const SizedBox(width: 10),
                Text(
                  item.$3,
                  style: TextStyle(fontSize: 13, color: item.$4 ? c.danger : c.textPrimary),
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

class _MetaChip extends StatelessWidget {
  const _MetaChip({required this.icon, required this.label, required this.color});

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 11, color: color),
          const SizedBox(width: 3),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 9.5,
                fontWeight: FontWeight.w600,
                color: color,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Check extends StatelessWidget {
  const _Check({required this.checked, this.onTap});

  final bool checked;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 18,
        height: 18,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: checked ? c.accent : Colors.transparent,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: checked ? c.accent : c.textSecondary, width: 1.5),
        ),
        child: checked
            ? Icon(Icons.check_rounded, size: 13, color: c.onAccent)
            : null,
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
      child: Icon(icon, size: 12.5, color: c.textSecondary),
    );
  }
}

class _PanelAction extends StatefulWidget {
  const _PanelAction({
    required this.tooltip,
    required this.onTap,
    this.icon,
    this.asset,
    this.accent = false,
    this.active = false,
  });

  final IconData? icon;
  final String? asset;
  final String tooltip;
  final VoidCallback onTap;
  final bool accent;
  final bool active;

  @override
  State<_PanelAction> createState() => _PanelActionState();
}

class _PanelActionState extends State<_PanelAction> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final tint = widget.accent || widget.active ? c.accent : c.textSecondary;
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
            margin: const EdgeInsets.only(right: 4),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(7),
              color: _hovered ? c.rowSelected : Colors.transparent,
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
              'Ajusta los filtros o espera un mensaje.',
              textAlign: TextAlign.center,
              style: t.rowPreview,
            ),
          ],
        ),
      ),
    );
  }
}