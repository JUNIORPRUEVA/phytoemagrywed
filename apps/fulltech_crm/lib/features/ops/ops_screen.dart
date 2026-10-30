import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

typedef OpsBundle = ({Map<String, dynamic> summary, List<Map<String, dynamic>> inbox, List<Map<String, dynamic>> agents});

/// Centro de operaciones: resumen de los agentes IA y su bandeja.
class OpsScreen extends StatelessWidget {
  const OpsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Agentes IA', subtitle: 'Centro de operaciones y bandeja interna'),
        Expanded(
          child: RemoteLoader<OpsBundle>(
            loadingLabel: 'Cargando centro de operaciones',
            load: () async {
              final summary = await state.repository.opsSummary();
              final inboxFuture = state.repository.opsInbox();
              final agentsFuture = state.repository.opsAgents();
              return (summary: summary, inbox: await inboxFuture, agents: await agentsFuture);
            },
            builder: (context, bundle, reload) {
              final summary = bundle.summary;
              final tickets = bundle.inbox;
              final agents = bundle.agents;
              final counters = mapv(summary['counts']).isEmpty ? summary : mapv(summary['counts']);

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  StatGrid(
                    children: [
                      StatTile(label: 'Tickets abiertos', value: '${intv(counters['open'], tickets.length)}', icon: Icons.confirmation_number_outlined),
                      StatTile(label: 'Sin leer', value: '${intv(counters['unread'])}', tone: p.danger, icon: Icons.mark_email_unread_outlined),
                      StatTile(label: 'Agentes activos', value: '${agents.where((row) => boolv(row['enabled'], true)).length}', tone: p.success, icon: Icons.smart_toy_outlined),
                      StatTile(label: 'Resueltos hoy', value: '${intv(counters['resolved'])}', icon: Icons.task_alt_rounded),
                    ],
                  ),
                  SectionCard(title: 'Resumen', child: KeyValueList(data: summary, skipKeys: const ['ok', 'tickets'])),
                  SectionCard(
                    title: 'Bandeja',
                    trailing: Text('${tickets.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                    child: tickets.isEmpty
                        ? Text('No hay tickets internos.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                        : Column(
                            children: [
                              for (final ticket in tickets.take(40))
                                MapListTile(
                                  data: ticket,
                                  titleKeys: const ['title', 'subject', 'order_number', 'name', 'id'],
                                  subtitleKeys: const ['status', 'priority', 'created_at', 'customer_name'],
                                  trailingKeys: const ['total', 'amount'],
                                  leadingIcon: Icons.confirmation_number_outlined,
                                ),
                            ],
                          ),
                  ),
                  SectionCard(
                    title: 'Agentes',
                    child: agents.isEmpty
                        ? Text('Sin agentes configurados.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                        : Column(
                            children: [
                              for (final agent in agents)
                                CrmListTile(
                                  title: str(agent['name'], 'Agente'),
                                  subtitle: str(agent['description'], str(agent['role'], '')),
                                  leading: CrmAvatar(label: str(agent['name'], 'A'), icon: Icons.smart_toy_outlined),
                                  trailing: StatusPill(
                                    label: boolv(agent['enabled'], true) ? 'activo' : 'apagado',
                                    dense: true,
                                    color: boolv(agent['enabled'], true) ? p.success : p.inkSecondary,
                                  ),
                                ),
                            ],
                          ),
                  ),
                  const CrmNotice(
                    message: 'Conversar con un agente, aprobar propuestas y editar sus reglas se hace en el Centro IA del panel web.',
                    tone: CrmColors.info,
                    icon: Icons.info_outline_rounded,
                  ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
