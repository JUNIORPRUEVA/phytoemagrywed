import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../common/remote_view.dart';

/// Archivo de solicitudes que llegan desde la tienda.
class SolicitudesScreen extends StatelessWidget {
  const SolicitudesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    return RemoteListScreen(
      title: 'Archivo de solicitudes',
      subtitle: 'Pedidos y solicitudes recibidas de la tienda',
      load: state.repository.storeRequests,
      icon: Icons.folder_copy_outlined,
      emptyTitle: 'Sin solicitudes',
      emptyMessage: 'Cuando un cliente pida algo desde la tienda, se verá aquí.',
      itemBuilder: (context, row) => MapListTile(
        data: row,
        titleKeys: const ['customer_name', 'name', 'phone', 'id'],
        subtitleKeys: const ['kind', 'status', 'notes', 'created_at'],
        trailingKeys: const ['total', 'amount'],
        leadingIcon: Icons.folder_copy_outlined,
      ),
    );
  }
}
