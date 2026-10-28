import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'chat_screen.dart';
import 'desktop/chat_desktop_theme.dart';
import 'desktop/chat_doodle_background.dart';
import 'desktop/chat_filters.dart';
import 'desktop/chat_filter_panel.dart';
import 'desktop/chat_list_panel.dart';
import 'desktop/chat_navigation_rail.dart';
import 'desktop/conversation_actions.dart';

/// Bandeja de conversaciones de **escritorio**, con la composición de la
/// referencia aportada (WhatsApp Desktop): rail estrecho + panel de chats +
/// hilo con patrón de fondo.
///
/// La pantalla no habla con la API: lee del `CrmState` (igual que la versión
/// móvil) y delega el hilo en `ChatScreen(desktop: true)`, que conserva todas
/// las acciones del CRM (texto, adjuntos, plantillas, asignación, cierre, cola
/// offline).
///
/// La implementación anterior de tres paneles (lista + hilo + ficha del
/// cliente) se conserva en `chats_desktop_anterior.dart.txt`, fuera del árbol
/// de compilación, porque el panel contextual se ha movido al menú del
/// encabezado (la referencia no tiene tercera columna).
class ChatsDesktopScreen extends StatefulWidget {
  const ChatsDesktopScreen({super.key, this.onNavigate, this.showRail = true});

  /// Cambio de módulo desde el rail; lo provee el shell.
  final ValueChanged<String>? onNavigate;

  /// `false` cuando el shell ya pinta el menú lateral (nada de dos rails).
  final bool showRail;

  @override
  State<ChatsDesktopScreen> createState() => _ChatsDesktopScreenState();
}

class _ChatsDesktopScreenState extends State<ChatsDesktopScreen> {
  final _search = TextEditingController();
  ChatFilters _filters = const ChatFilters();
  String? _selectedId;
  bool _selecting = false;
  final Set<String> _selectedIds = {};

  /// Columna lateral de filtros (ocupa todo el alto).
  bool _showFilters = false;

  /// Adjunto que debe abrirse al entrar en el hilo (acción «Enviar una foto»).
  String? _pendingAttach;
  int _attachRequest = 0;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Conversation> _filtered(List<Conversation> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      if (query.isNotEmpty) {
        final match =
            row.name.toLowerCase().contains(query) ||
            row.phone.toLowerCase().contains(query) ||
            row.lastBody.toLowerCase().contains(query);
        if (!match) return false;
      }
      return _filters.matches(row);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final state = CrmScope.of(context);
    final conversations = _filtered(state.conversations);
    final selectedId =
        _selectedId != null && conversations.any((row) => row.id == _selectedId)
        ? _selectedId
        : (conversations.isEmpty ? null : conversations.first.id);
    final user = state.session.user;

    final width = MediaQuery.sizeOf(context).width;
    final railWidth = ChatDesktopMetrics.railWidth;
    final listWidth = math.min(
      ChatDesktopMetrics.listWidth,
      math.max(272.0, (width - railWidth) * 0.3),
    );
    // 20 % del ancho, con suelo y techo para que siga siendo usable.
    final filterWidth = (width * 0.20).clamp(240.0, 360.0);

    // Todo el módulo (lista incluida) sigue la luminosidad configurada.
    return Theme(
      data: buildChatDesktopTheme(context),
      child: Material(
        color: c.panelBg,
        child: Row(
          children: [
            if (widget.showRail)
              ChatNavigationRail(
                currentTab: 'whatsapp',
                unread: state.unreadTotal,
                initials: (user?.initials.isNotEmpty ?? false)
                    ? user!.initials
                    : 'FT',
                onNavigate: (tab) => widget.onNavigate?.call(tab),
                onLogout: state.logout,
              ),
            SizedBox(
              width: listWidth,
              child: ChatListPanel(
                conversations: conversations,
                selectedId: selectedId,
                onSelect: (id) => setState(() => _selectedId = id),
                onAction: _runAction,
                onNewConversation: _newMessage,
                search: _search,
                onSearchChanged: (_) => setState(() {}),
                filters: _filters,
                onFiltersChanged: (value) => setState(() => _filters = value),
                onOpenFilters: () => setState(() => _showFilters = !_showFilters),
                onRefresh: () => state.refresh(),
                selecting: _selecting,
                selectedIds: _selectedIds,
                onSelectingChanged: (value) => setState(() {
                  _selecting = value;
                  if (!value) _selectedIds.clear();
                }),
                onToggleSelected: (id) => setState(() {
                  if (!_selectedIds.remove(id)) _selectedIds.add(id);
                }),
                onBulkAction: _runBulk,
                unreadTotal: state.unreadTotal,
              ),
            ),
            Expanded(
              child: selectedId == null
                  ? const ChatDoodleBackground(child: _NoConversation())
                  : ChatScreen(
                      key: ValueKey('$selectedId-$_attachRequest'),
                      conversationId: selectedId,
                      title:
                          state.conversationById(selectedId)?.name ??
                          'Conversación',
                      desktop: true,
                      autoAttach: _pendingAttach,
                    ),
            ),
            // Columna de filtros: todo el alto y ~20 % del ancho (nunca un
            // diálogo en el centro). Se desliza abriendo y cerrando.
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOutCubic,
              width: _showFilters ? filterWidth : 0,
              child: ClipRect(
                child: OverflowBox(
                  alignment: Alignment.centerLeft,
                  minWidth: filterWidth,
                  maxWidth: filterWidth,
                  child: ChatFilterPanel(
                    width: filterWidth,
                    filters: _filters,
                    conversations: state.conversations,
                    onChanged: (value) => setState(() => _filters = value),
                    onClose: () => setState(() => _showFilters = false),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Acciones de una fila de la bandeja (las mismas del hilo móvil + archivar,
  /// seguimiento, foto y selección).
  Future<void> _runAction(Conversation conversation, String action) async {
    final state = CrmScope.of(context, listen: false);
    switch (action) {
      case 'open':
        setState(() => _selectedId = conversation.id);
        return;
      case 'photo':
        setState(() {
          _selectedId = conversation.id;
          _pendingAttach = 'image';
          _attachRequest++;
        });
        // Se limpia en el siguiente fotograma: el hilo ya lo consumió al montarse.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _pendingAttach != null) setState(() => _pendingAttach = null);
        });
        return;
      case 'followup':
        // El seguimiento se crea desde su módulo; aquí se abre con el cliente a la vista.
        crmToast(context, 'Abre el seguimiento de ${conversation.name} en Seguimientos.');
        widget.onNavigate?.call('seguimientos');
        return;
      case 'select':
        setState(() {
          _selecting = true;
          _selectedIds
            ..clear()
            ..add(conversation.id);
        });
        return;
      case 'archive':
      case 'unarchive':
        try {
          await state.repository.archiveConversation(conversation.id, action == 'archive');
          await state.refresh(quiet: true);
          if (!mounted) return;
          crmToast(context, action == 'archive' ? 'Conversación archivada.' : 'Conversación desarchivada.');
        } on ApiException catch (error) {
          if (mounted) crmToast(context, error.message);
        }
        return;
    }
    final refresh = await ConversationActions.run(context, action, conversation);
    if (!mounted || !refresh) return;
    await state.refresh(quiet: true);
  }

  /// Acciones en lote del modo de selección.
  Future<void> _runBulk(String action) async {
    if (action == 'cancel') {
      setState(() {
        _selecting = false;
        _selectedIds.clear();
      });
      return;
    }
    if (_selectedIds.isEmpty) return;
    final state = CrmScope.of(context, listen: false);
    final ids = _selectedIds.toList();
    setState(() => _selecting = false);
    try {
      await state.repository.bulkConversations(ids, action);
      await state.refresh(quiet: true);
      if (!mounted) return;
      setState(_selectedIds.clear);
      crmToast(context, switch (action) {
        'mark_read' => '${ids.length} conversación(es) marcadas como leídas.',
        'resolve' => '${ids.length} conversación(es) finalizadas.',
        'archive' => '${ids.length} conversación(es) archivadas.',
        _ => 'Listo.',
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      crmToast(context, error.message);
    }
  }

  /// «Nuevo mensaje»: abre (o crea) la conversación de un teléfono y la muestra.
  Future<void> _newMessage() async {
    final id = await showNewConversationDialog(context);
    if (!mounted || id == null) return;
    await CrmScope.of(context, listen: false).refresh(quiet: true);
    if (!mounted) return;
    setState(() => _selectedId = id);
  }
}

class _NoConversation extends StatelessWidget {
  const _NoConversation();

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.forum_outlined,
            size: 38,
            color: c.textSecondary,
          ),
          const SizedBox(height: 12),
          Text(
            'Elige una conversación',
            style: t.title.copyWith(
              fontSize: 16,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'A la izquierda están los chats del negocio.',
            style: t.rowPreview,
          ),
        ],
      ),
    );
  }
}