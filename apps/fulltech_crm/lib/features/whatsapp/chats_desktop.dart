import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import '../ventas/pos_launch_context.dart';

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
import 'desktop/chat_new_message_panel.dart';
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
/// Columna lateral que se pinta ENCIMA del contenido (con desenfoque detrás).
enum _SidePanel { none, filters, newMessage }

class ChatsDesktopScreen extends StatefulWidget {
  const ChatsDesktopScreen({super.key, this.onNavigate, this.onOpenSale, this.showRail = true});

  /// Cambio de módulo desde el rail; lo provee el shell.
  final ValueChanged<String>? onNavigate;
  final ValueChanged<PosLaunchContext>? onOpenSale;

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

  /// Columna lateral abierta (se pinta ENCIMA del contenido, con desenfoque).
  _SidePanel _side = _SidePanel.none;

  /// Adjunto que debe abrirse al entrar en el hilo (acción «Enviar una foto»).
  String? _pendingAttach;
  int _attachRequest = 0;

  /// Conversaciones ARCHIVADAS, pedidas al servidor cuando se filtra por ellas.
  ///
  /// El estado general del CRM no las trae (no son bandeja), así que el filtro
  /// «Archivados» se quedaba vacío y una conversación archivada no se podía
  /// recuperar desde la app. Se piden aparte, solo cuando hace falta.
  List<Conversation> _archivedRows = const [];
  bool _loadingArchived = false;
  bool _aiGlobalEnabled = false;
  bool _aiGlobalLoaded = false;
  bool _aiGlobalUnavailable = false;
  bool _aiGlobalBusy = false;
  bool _aiConversationLoaded = false;
  bool _aiConversationUnavailable = false;
  bool _aiConversationBusy = false;
  bool _aiLoadErrorShown = false;
  String _aiConversationMode = 'inherit';
  String? _aiLoadedConversationId;
  String? _aiScheduledConversationId;

  bool get _aiEffective => _aiConversationMode == 'on' ||
      (_aiConversationMode != 'off' && _aiGlobalEnabled);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAiGlobal());
  }

  Future<void> _loadAiGlobal() async {
    if (mounted) {
      setState(() {
        _aiGlobalLoaded = false;
        _aiGlobalUnavailable = false;
      });
    }
    try {
      final state = CrmScope.of(context, listen: false);
      final data = await state.repository.aiChatGlobalControl();
      if (mounted) {
        setState(() {
          _aiGlobalEnabled = data['enabled'] == true;
          _aiGlobalLoaded = true;
          _aiLoadErrorShown = false;
        });
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _aiGlobalUnavailable = true);
      if (mounted) _showAiLoadError(error);
    }
  }

  Future<void> _loadAiConversation(String id) async {
    if (mounted) {
      setState(() {
        _aiLoadedConversationId = id;
        _aiConversationLoaded = false;
        _aiConversationUnavailable = false;
      });
    }
    try {
      final state = CrmScope.of(context, listen: false);
      final data = await state.repository.aiChatConversationControl(id);
      if (mounted && _aiLoadedConversationId == id) {
        setState(() {
          _aiConversationMode = data['mode'] as String? ?? 'inherit';
          _aiConversationLoaded = true;
          _aiGlobalEnabled = data['globalEnabled'] == true;
          _aiGlobalLoaded = true;
          _aiLoadErrorShown = false;
        });
      }
    } on ApiException catch (error) {
      if (mounted && _aiLoadedConversationId == id) {
        setState(() => _aiConversationUnavailable = true);
      }
      if (mounted && _aiLoadedConversationId == id) _showAiLoadError(error);
    }
  }

  void _showAiLoadError(ApiException error) {
    if (_aiLoadErrorShown) return;
    _aiLoadErrorShown = true;
    crmToast(context, error.statusCode == 404
        ? 'El servidor local aún no cargó los controles de IA. Reinicia el backend UAT.'
        : error.message);
  }

  Future<void> _toggleAiGlobal() async {
    if (_aiGlobalBusy || !_aiGlobalLoaded) return;
    setState(() => _aiGlobalBusy = true);
    try {
      final state = CrmScope.of(context, listen: false);
      final data = await state.repository.setAiChatGlobalControl(!_aiGlobalEnabled);
      if (mounted) {
        setState(() => _aiGlobalEnabled = data['enabled'] == true);
        crmToast(context, _aiGlobalEnabled
            ? 'IA preparada para todos los chats. Todavía no responde automáticamente.'
            : 'IA general desactivada. Las excepciones de cada chat se conservan.');
      }
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _aiGlobalBusy = false);
    }
  }

  Future<void> _setAiConversationMode(String id, String mode) async {
    if (_aiConversationBusy || !_aiConversationLoaded) return;
    if (mode == _aiConversationMode) return;
    setState(() => _aiConversationBusy = true);
    try {
      final state = CrmScope.of(context, listen: false);
      final data = await state.repository.setAiChatConversationControl(id, mode);
      if (mounted && _aiLoadedConversationId == id) {
        setState(() {
          _aiConversationMode = data['mode'] as String? ?? mode;
          _aiGlobalEnabled = data['globalEnabled'] == true;
        });
        crmToast(context, mode == 'inherit'
            ? 'Este chat vuelve a usar el ajuste general de IA.'
            : (_aiEffective
                ? 'IA preparada en este chat. Todavía no responde automáticamente.'
                : 'IA desactivada en este chat.'));
      }
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _aiConversationBusy = false);
    }
  }

  Future<void> _cargarArchivadas() async {
    if (_loadingArchived) return;
    final state = CrmScope.of(context, listen: false);
    _loadingArchived = true;
    try {
      final data = await state.repository.conversations(filter: 'archivados');
      final rows = (data['conversations'] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .map(Conversation.fromJson)
          .toList();
      if (mounted) setState(() => _archivedRows = rows);
      debugPrint('ARCHIVADAS: ${rows.length} filas');
    } on ApiException catch (error) {
      debugPrint('ARCHIVADAS error: ${error.message}');
      if (!mounted) return;
      crmToast(context, error.message);
    } finally {
      _loadingArchived = false;
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// Cambia los filtros de la bandeja. «Archivados» necesita su propia consulta.
  void _cambiarFiltros(ChatFilters value) {
    setState(() => _filters = value);
    if (value.status == ChatStatusFilter.archivados) _cargarArchivadas();
  }

  List<Conversation> _filtered(List<Conversation> rows) {    final query = _search.text.trim().toLowerCase();
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
    // «Archivados» se alimenta de su propia consulta al servidor.
    final base =
        _filters.status == ChatStatusFilter.archivados ? _archivedRows : state.conversations;
    final conversations = _filtered(base);
    final selectedId =
        _selectedId != null && conversations.any((row) => row.id == _selectedId)
        ? _selectedId
        : (conversations.isEmpty ? null : conversations.first.id);
    if (selectedId != null && selectedId != _aiLoadedConversationId &&
        selectedId != _aiScheduledConversationId) {
      _aiScheduledConversationId = selectedId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _aiScheduledConversationId == selectedId) {
          _aiScheduledConversationId = null;
          _loadAiConversation(selectedId);
        }
      });
    }
    final user = state.session.user;

    final width = MediaQuery.sizeOf(context).width;
    final railWidth = ChatDesktopMetrics.railWidth;
    final listWidth = math.min(
      ChatDesktopMetrics.listWidth,
      math.max(272.0, (width - railWidth) * 0.3),
    );
    // Columnas laterales: 20 % del ancho (filtros) y algo más para el formulario.
    final filterWidth = (width * 0.20).clamp(260.0, 380.0);
    final formWidth = (width * 0.24).clamp(320.0, 440.0);
    final sideWidth = _side == _SidePanel.filters ? filterWidth : formWidth;

    final content = Row(
      children: [
        if (widget.showRail)
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
            onAction: _runAction,
            onNewConversation: _newMessage,
            aiEnabled: _aiGlobalEnabled,
            aiLoaded: _aiGlobalLoaded,
            aiBusy: _aiGlobalBusy,
            aiUnavailable: _aiGlobalUnavailable,
            aiTooltip: _aiGlobalUnavailable
                ? 'IA no disponible: recarga el servidor y haz clic para reintentar'
                : !_aiGlobalLoaded
                ? 'Consultando estado de la IA'
                : _aiGlobalEnabled
                ? 'IA preparada para todos los chats. Aún no responde sola.'
                : 'Preparar IA para todos los chats. Aún no responde sola.',
            onToggleAi: state.session.can('settings.manage') && _aiGlobalLoaded ? _toggleAiGlobal : null,
            onRetryAi: _aiGlobalUnavailable ? _loadAiGlobal : null,
            search: _search,
            onSearchChanged: (_) => setState(() {}),
            filters: _filters,
            onFiltersChanged: _cambiarFiltros,
            onOpenFilters: () => _toggleSide(_SidePanel.filters),
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
                  title: state.conversationById(selectedId)?.name ?? 'Conversación',
                  desktop: true,
                  aiEnabled: selectedId == _aiLoadedConversationId && _aiConversationLoaded && _aiEffective,
                  aiLoaded: selectedId == _aiLoadedConversationId && _aiConversationLoaded,
                  aiBusy: _aiConversationBusy,
                  aiUnavailable: selectedId == _aiLoadedConversationId && _aiConversationUnavailable,
                  aiTooltip: selectedId == _aiLoadedConversationId && _aiConversationUnavailable
                      ? 'IA no disponible: recarga el servidor y haz clic para reintentar'
                      : selectedId == _aiLoadedConversationId && _aiConversationLoaded
                      ? (_aiEffective
                          ? 'IA preparada en este chat. Aún no responde sola.'
                          : 'Preparar IA en este chat. Aún no responde sola.')
                      : 'Cargando estado de la IA',
                  aiMode: _aiConversationMode,
                  aiGlobalEnabled: _aiGlobalEnabled,
                  onToggleAi: selectedId == _aiLoadedConversationId && _aiConversationUnavailable
                      ? () => _loadAiConversation(selectedId) : null,
                  onSelectAiMode: state.session.can('chats.reply') &&
                          selectedId == _aiLoadedConversationId && _aiConversationLoaded
                      ? (mode) => _setAiConversationMode(selectedId, mode) : null,
                  autoAttach: _pendingAttach,
                  onNavigate: widget.onNavigate,
                  onOpenSale: widget.onOpenSale,
                ),
        ),
      ],
    );

    // El módulo sigue la luminosidad configurada.
    return Theme(
      data: buildChatDesktopTheme(context),
      child: Material(
        color: c.panelBg,
        child: Stack(
          children: [
            Positioned.fill(child: content),
            // Capa de desenfoque: la columna va ENCIMA y el contenido no se mueve.
            if (_side != _SidePanel.none)
              Positioned.fill(
                child: GestureDetector(
                  onTap: () => setState(() => _side = _SidePanel.none),
                  child: BackdropFilter(
                    filter: ui.ImageFilter.blur(sigmaX: 7, sigmaY: 7),
                    child: Container(
                      color: c.dark ? const Color(0x66000000) : const Color(0x2E0B1D24),
                    ),
                  ),
                ),
              ),
            if (_side != _SidePanel.none)
              Positioned(
                top: 0,
                bottom: 0,
                right: 0,
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOutCubic,
                  builder: (context, value, child) => Transform.translate(
                    offset: Offset(sideWidth * (1 - value), 0),
                    child: Opacity(opacity: value.clamp(0.0, 1.0), child: child),
                  ),
                  child: _side == _SidePanel.filters
                      ? ChatFilterPanel(
                          width: filterWidth,
                          filters: _filters,
                          conversations: state.conversations,
                          onChanged: _cambiarFiltros,
                          onClose: () => setState(() => _side = _SidePanel.none),
                        )
                      : ChatNewMessagePanel(
                          width: formWidth,
                          onClose: () => setState(() => _side = _SidePanel.none),
                          onCreated: (id) => setState(() {
                            _side = _SidePanel.none;
                            _selectedId = id;
                          }),
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _toggleSide(_SidePanel panel) {
    setState(() => _side = _side == panel ? _SidePanel.none : panel);
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
          // La lista de archivadas es su propia consulta: se vuelve a pedir.
          if (_filters.status == ChatStatusFilter.archivados) await _cargarArchivadas();
        } on ApiException catch (error) {
          if (!mounted) return;
          crmToast(context, error.message);
        }
        return;
    }
    if (!mounted) return;
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

  /// «Nuevo mensaje»: abre el formulario en la columna lateral.
  Future<void> _newMessage() async {
    _toggleSide(_SidePanel.newMessage);
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
