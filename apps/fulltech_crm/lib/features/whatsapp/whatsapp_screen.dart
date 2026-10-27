import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'chat_screen.dart';

/// Bandeja de conversaciones (la misma lista de WhatsApp del panel).
class WhatsappScreen extends StatefulWidget {
  const WhatsappScreen({super.key});

  @override
  State<WhatsappScreen> createState() => _WhatsappScreenState();
}

class _WhatsappScreenState extends State<WhatsappScreen> {
  final _search = TextEditingController();
  String _filter = 'todos';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Conversation> _filtered(List<Conversation> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      switch (_filter) {
        case 'no-leidos':
          if (row.unread <= 0) return false;
        case 'pendientes':
          if (!row.pending) return false;
        case 'resueltos':
          if (!row.isResolved) return false;
      }
      if (query.isEmpty) return true;
      return row.name.toLowerCase().contains(query) ||
          row.phone.toLowerCase().contains(query) ||
          row.preview.toLowerCase().contains(query);
    }).toList()
      ..sort((a, b) => b.lastAt.compareTo(a.lastAt));
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    // Bandeja completa cuando el paquete ligero llegó recortado.
    if (state.partial && !state.conversationsComplete) {
      WidgetsBinding.instance.addPostFrameCallback((_) => state.ensureFullLists(includeCustomers: false));
    }
    final rows = _filtered(state.conversations);
    final desktop = context.isDesktop;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: Row(
            children: [
              Expanded(child: CrmSearchField(controller: _search, hint: 'Buscar cliente, teléfono o mensaje', onChanged: (_) => setState(() {}))),
              const SizedBox(width: 8),
              IconButton(
                tooltip: 'Actualizar bandeja',
                onPressed: state.loading ? null : () => state.refresh(),
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        ),
        FilterChips(
          options: const ['todos', 'no-leidos', 'pendientes', 'resueltos'],
          value: _filter,
          onChanged: (value) => setState(() => _filter = value),
          labels: const {'todos': 'Todos', 'no-leidos': 'Sin leer', 'pendientes': 'Pendientes', 'resueltos': 'Resueltos'},
        ),
        const SizedBox(height: 8),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refresh,
            child: rows.isEmpty
                ? ListView(
                    children: const [
                      SizedBox(height: 40),
                      EmptyState(
                        title: 'No hay conversaciones aquí',
                        message: 'Cuando un cliente escriba por WhatsApp, la conversación aparece en esta bandeja.',
                        icon: Icons.forum_outlined,
                      ),
                    ],
                  )
                : Container(
                    margin: EdgeInsets.symmetric(horizontal: desktop ? 16 : 0),
                    decoration: BoxDecoration(
                      color: p.surface,
                      borderRadius: BorderRadius.circular(desktop ? 14 : 0),
                      border: desktop ? Border.all(color: p.border) : null,
                    ),
                    child: ListView.separated(
                      itemCount: rows.length,
                      separatorBuilder: (_, _) => Divider(height: 1, color: p.line, indent: 66),
                      itemBuilder: (context, index) {
                        final row = rows[index];
                        return CrmListTile(
                          title: row.name,
                          subtitle: row.preview,
                          leading: CrmAvatar(label: row.name, size: 42, tone: row.pending ? p.primary : p.inkSecondary),
                          badge: row.unread > 0 ? '${row.unread}' : null,
                          trailing: Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(CrmFormat.chatStamp(row.lastAt), style: TextStyle(fontSize: 11, color: p.inkSecondary)),
                              const SizedBox(height: 6),
                              if (row.stage.isNotEmpty) StatusPill(label: row.stage.toLowerCase(), dense: true),
                            ],
                          ),
                          highlight: row.unread > 0,
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(builder: (_) => ChatScreen(conversationId: row.id, title: row.name)),
                          ),
                        );
                      },
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}
