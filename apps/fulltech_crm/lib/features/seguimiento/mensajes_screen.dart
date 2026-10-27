import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../data/models/crm_models.dart';
import '../common/remote_view.dart';

/// Mensajes programados: lo que sale solo (seguimientos y campañas).
class MensajesScreen extends StatelessWidget {
  const MensajesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    return RemoteListScreen(
      title: 'Mensajes programados',
      subtitle: 'Seguimientos y envíos con hora',
      load: () async {
        final data = await state.repository.scheduled();
        final rows = listv(data['items']).isEmpty ? listv(data['scheduled']) : listv(data['items']);
        return rows;
      },
      icon: Icons.schedule_send_outlined,
      emptyTitle: 'Sin mensajes programados',
      emptyMessage: 'Cuando programes un mensaje desde una conversación, aparecerá aquí.',
      itemBuilder: (context, row) => MapListTile(
        data: row,
        titleKeys: const ['customer_name', 'name', 'phone', 'to'],
        subtitleKeys: const ['body', 'message', 'note', 'kind'],
        trailingKeys: const [],
        leadingIcon: Icons.schedule_send_outlined,
      ),
    );
  }
}
