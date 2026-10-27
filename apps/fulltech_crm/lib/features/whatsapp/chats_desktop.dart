import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../data/models/crm_models.dart';
import 'chat_screen.dart';
import 'desktop/chat_desktop_theme.dart';
import 'desktop/chat_doodle_background.dart';
import 'desktop/chat_list_panel.dart';
import 'desktop/chat_navigation_rail.dart';

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
  const ChatsDesktopScreen({super.key, this.onNavigate});

  /// Cambio de módulo desde el rail; lo provee el shell.
  final ValueChanged<String>? onNavigate;

  @override
  State<ChatsDesktopScreen> createState() => _ChatsDesktopScreenState();
}

class _ChatsDesktopScreenState extends State<ChatsDesktopScreen> {
  final _search = TextEditingController();
  String _filter = 'todos';
  String? _selectedId;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Conversation> _filtered(List<Conversation> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      if (_filter == 'sin_leer' && row.unread <= 0) return false;
      if (_filter == 'pendientes' && !row.awaitingReply) return false;
      if (_filter == 'finalizadas' && !row.isResolved) return false;
      if (query.isEmpty) return true;
      return row.name.toLowerCase().contains(query) ||
          row.phone.toLowerCase().contains(query) ||
          row.lastBody.toLowerCase().contains(query);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final conversations = _filtered(state.conversations);
    final selectedId = _selectedId != null && conversations.any((row) => row.id == _selectedId)
        ? _selectedId
        : (conversations.isEmpty ? null : conversations.first.id);
    final user = state.session.user;

    final width = MediaQuery.sizeOf(context).width;
    final railWidth = ChatDesktopMetrics.railWidth;
    final listWidth = math.min(
      ChatDesktopMetrics.listWidth,
      math.max(272.0, (width - railWidth) * 0.3),
    );

    return ColoredBox(
      color: ChatDesktopColors.panelBg,
      child: Row(
        children: [
          ChatNavigationRail(
            currentTab: 'whatsapp',
            unread: state.unreadTotal,
            initials: (user?.initials.isNotEmpty ?? false) ? user!.initials : 'FT',
            onNavigate: (tab) => widget.onNavigate?.call(tab),
            onLogout: state.logout,
          ),
          SizedBox(
            width: listWidth,
            child: ChatListPanel(
              conversations: conversations,
              selectedId: selectedId,
              onSelect: (id) => setState(() => _selectedId = id),
              search: _search,
              onSearchChanged: (_) => setState(() {}),
              filter: _filter,
              onFilterChanged: (value) => setState(() => _filter = value),
              onRefresh: () => state.refresh(),
              unreadTotal: state.unreadTotal,
            ),
          ),
          Expanded(
            child: selectedId == null
                ? const ChatDoodleBackground(child: _NoConversation())
                : ChatScreen(
                    key: ValueKey(selectedId),
                    conversationId: selectedId,
                    title: state.conversationById(selectedId)?.name ?? 'Conversación',
                    desktop: true,
                  ),
          ),
        ],
      ),
    );
  }
}

class _NoConversation extends StatelessWidget {
  const _NoConversation();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.forum_outlined, size: 38, color: ChatDesktopColors.textSecondary),
          const SizedBox(height: 12),
          Text(
            'Elige una conversación',
            style: ChatDesktopText.title.copyWith(fontSize: 16, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 6),
          Text('A la izquierda están los chats del negocio.', style: ChatDesktopText.rowPreview),
        ],
      ),
    );
  }
}
