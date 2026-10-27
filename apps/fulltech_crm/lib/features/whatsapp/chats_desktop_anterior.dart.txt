import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../clientes/cliente_detail_screen.dart';
import '../common/crm_ui.dart';
import '../pedidos/pedido_detail_screen.dart';
import 'chat_screen.dart';

/// Bandeja de conversaciones de **escritorio**.
///
/// Tres zonas, como WhatsApp Desktop pero con los colores y medidas del POS:
///   · izquierda: buscador, filtros y lista de chats;
///   · centro: el hilo (el mismo [ChatScreen], en modo `embedded`);
///   · derecha: información del cliente, sus pedidos y acciones reales.
///
/// Por debajo de 1366 px la tercera zona se sustituye por el acceso a la ficha
/// del cliente, para no comerse el ancho del chat. En móvil no se usa: allí se
/// mantiene la lista que abre el hilo a pantalla completa.
class ChatsDesktopScreen extends StatefulWidget {
  const ChatsDesktopScreen({super.key});

  @override
  State<ChatsDesktopScreen> createState() => _ChatsDesktopScreenState();
}

class _ChatsDesktopScreenState extends State<ChatsDesktopScreen> {
  final _search = TextEditingController();
  String _filter = 'todos';
  String? _selectedId;
  bool _showContext = true;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Conversation> _filtered(List<Conversation> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      if (_filter == 'sin_leer' && row.unread <= 0) return false;
      if (_filter == 'pendientes' && !row.pending) return false;
      if (_filter == 'finalizadas' && !row.isResolved) return false;
      if (query.isEmpty) return true;
      return row.name.toLowerCase().contains(query) ||
          row.phone.toLowerCase().contains(query) ||
          row.lastBody.toLowerCase().contains(query);
    }).toList()
      ..sort((a, b) => b.lastAt.compareTo(a.lastAt));
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final conversations = _filtered(state.conversations);
    final selectedId = _selectedId != null && conversations.any((row) => row.id == _selectedId)
        ? _selectedId
        : (conversations.isEmpty ? null : conversations.first.id);
    final selected = selectedId == null ? null : state.conversationById(selectedId);
    final threePane = MediaQuery.sizeOf(context).width >= CrmSpace.chatThreePaneBreakpoint;

    return Row(
      children: [
        SizedBox(
          width: CrmShellMetrics.chatListWidth,
          child: _ListPane(
            search: _search,
            filter: _filter,
            conversations: conversations,
            selectedId: selectedId,
            totalUnread: state.unreadTotal,
            onSearch: (_) => setState(() {}),
            onFilter: (value) => setState(() => _filter = value),
            onSelect: (id) => setState(() => _selectedId = id),
            onToggleContext: threePane
                ? () => setState(() => _showContext = !_showContext)
                : null,
            contextOpen: _showContext,
          ),
        ),
        VerticalDivider(width: 1, color: p.line),
        Expanded(
          child: selectedId == null
              ? const EmptyState(
                  title: 'Elige una conversación',
                  message: 'A la izquierda están los chats del negocio.',
                  icon: Icons.forum_outlined,
                )
              : ChatScreen(
                  key: ValueKey(selectedId),
                  conversationId: selectedId,
                  title: selected?.name ?? 'Conversación',
                  embedded: true,
                ),
        ),
        if (threePane && _showContext) ...[
          VerticalDivider(width: 1, color: p.line),
          SizedBox(
            width: CrmShellMetrics.chatContextWidth,
            child: _ContextPane(conversation: selected, onClose: () => setState(() => _showContext = false)),
          ),
        ],
      ],
    );
  }
}

/// Zona izquierda: buscador, filtros y lista.
class _ListPane extends StatelessWidget {
  const _ListPane({
    required this.search,
    required this.filter,
    required this.conversations,
    required this.selectedId,
    required this.totalUnread,
    required this.onSearch,
    required this.onFilter,
    required this.onSelect,
    required this.onToggleContext,
    required this.contextOpen,
  });

  final TextEditingController search;
  final String filter;
  final List<Conversation> conversations;
  final String? selectedId;
  final int totalUnread;
  final ValueChanged<String> onSearch;
  final ValueChanged<String> onFilter;
  final ValueChanged<String> onSelect;
  final VoidCallback? onToggleContext;
  final bool contextOpen;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      color: p.surface,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 8, 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    totalUnread > 0 ? 'Conversaciones · $totalUnread sin leer' : 'Conversaciones',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: p.ink),
                  ),
                ),
                if (onToggleContext != null)
                  IconButton(
                    tooltip: contextOpen ? 'Ocultar detalles' : 'Mostrar detalles',
                    iconSize: 18,
                    color: contextOpen ? p.primary : p.inkSecondary,
                    onPressed: onToggleContext,
                    icon: Icon(contextOpen ? Icons.view_sidebar_rounded : Icons.view_sidebar_outlined),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: CrmSearchField(
              controller: search,
              hint: 'Buscar conversación',
              onChanged: onSearch,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
            /*
             * Filtros en dos líneas: en 340 px no caben cuatro chips y el
             * desplazamiento horizontal dejaba uno cortado por la mitad.
             */
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final entry in const {
                  'todos': 'Todos',
                  'sin_leer': 'Sin leer',
                  'pendientes': 'Pendientes',
                  'finalizadas': 'Finalizadas',
                }.entries)
                  ChoiceChip(
                    label: Text(entry.value),
                    selected: filter == entry.key,
                    showCheckmark: false,
                    onSelected: (_) => onFilter(entry.key),
                    labelStyle: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: filter == entry.key
                          ? (Theme.of(context).brightness == Brightness.dark ? const Color(0xFF0B1424) : Colors.white)
                          : p.ink,
                    ),
                  ),
              ],
            ),
          ),
          Divider(color: p.line, height: 1),
          Expanded(
            child: conversations.isEmpty
                ? const EmptyState(title: 'Sin conversaciones', icon: Icons.forum_outlined)
                : ListView.builder(
                    itemCount: conversations.length,
                    itemBuilder: (context, index) {
                      final row = conversations[index];
                      return _ChatRow(
                        conversation: row,
                        selected: row.id == selectedId,
                        onTap: () => onSelect(row.id),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _ChatRow extends StatelessWidget {
  const _ChatRow({required this.conversation, required this.selected, required this.onTap});

  final Conversation conversation;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final unread = conversation.unread > 0;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        color: selected ? p.primarySoft : Colors.transparent,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CrmAvatar(label: conversation.name, size: 40),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          conversation.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: unread ? FontWeight.w800 : FontWeight.w600,
                            color: p.ink,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        CrmFormat.chatStamp(conversation.lastAt),
                        style: TextStyle(fontSize: 10.5, color: unread ? p.success : p.inkSecondary),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      if (conversation.lastDirection == 'outbound')
                        Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: Icon(Icons.done_all_rounded, size: 14, color: p.success),
                        ),
                      Expanded(
                        child: Text(
                          conversation.lastBody.isEmpty ? '—' : conversation.lastBody,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: p.inkSecondary),
                        ),
                      ),
                      if (unread)
                        Container(
                          margin: const EdgeInsets.only(left: 6),
                          constraints: const BoxConstraints(minWidth: 18),
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(color: p.success, borderRadius: BorderRadius.circular(CrmRadii.pill)),
                          child: Text(
                            '${conversation.unread}',
                            textAlign: TextAlign.center,
                            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Colors.white),
                          ),
                        ),
                    ],
                  ),
                  if (conversation.pending || conversation.isResolved)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: StatusPill(
                        label: conversation.isResolved ? 'finalizada' : 'espera respuesta',
                        dense: true,
                        color: conversation.isResolved ? p.inkSecondary : p.warning,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Zona derecha: información real del cliente y sus pedidos. Nada inventado: si
/// el paquete no trae un dato, no se pinta.
class _ContextPane extends StatelessWidget {
  const _ContextPane({required this.conversation, required this.onClose});

  final Conversation? conversation;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final current = conversation;
    if (current == null) {
      return Container(color: p.surface, child: const EmptyState(title: 'Sin conversación', icon: Icons.info_outline_rounded));
    }
    final customer = state.customerById(current.customerId);
    final orders = state.orders.where((row) => row.customerId == current.customerId).take(6).toList();
    final phone = current.phone.isNotEmpty ? current.phone : (customer?.phone ?? '');

    return Container(
      color: p.surface,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 18),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 6, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text('Información', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: p.ink)),
                ),
                IconButton(
                  tooltip: 'Cerrar',
                  iconSize: 18,
                  onPressed: onClose,
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Divider(color: p.line, height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            child: Row(
              children: [
                CrmAvatar(label: current.name, size: 42),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        current.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: p.ink),
                      ),
                      if (phone.isNotEmpty)
                        Text(phone, style: TextStyle(fontSize: 12, color: p.inkSecondary)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (current.tags.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [for (final tag in current.tags.take(6)) StatusPill(label: tag, dense: true)],
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (phone.isNotEmpty)
                  CrmButton(
                    label: 'Llamar',
                    icon: Icons.call_outlined,
                    filled: false,
                    onPressed: () => launchUrl(Uri.parse('tel:$phone')),
                  ),
                CrmButton(
                  label: 'Ficha del cliente',
                  icon: Icons.person_outline_rounded,
                  filled: false,
                  onPressed: current.customerId.isEmpty
                      ? null
                      : () => Navigator.of(context).push(
                            MaterialPageRoute(builder: (_) => ClienteDetailScreen(customerId: current.customerId)),
                          ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            child: Text(
              'PEDIDOS',
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.9, color: p.inkSecondary),
            ),
          ),
          if (orders.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Text('Este cliente no tiene pedidos en el paquete actual.', style: TextStyle(fontSize: 12, color: p.inkSecondary)),
            )
          else
            for (final order in orders)
              CrmListTile(
                title: '${order.label} · ${CrmFormat.money(order.total, short: true)}',
                subtitle: '${order.status} · ${CrmFormat.ago(order.receivedAt)}',
                leading: CrmAvatar(label: order.status, icon: Icons.receipt_long_outlined),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => PedidoDetailScreen(orderId: order.id)),
                ),
              ),
        ],
      ),
    );
  }
}
