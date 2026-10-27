import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../common/remote_view.dart';

/// Recogidas: lo que hay que retirar en cada tienda.
class RecogidasScreen extends StatelessWidget {
  const RecogidasScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    return RemoteListScreen(
      title: 'Recogidas',
      subtitle: 'Pendientes de retirar en tienda',
      load: state.repository.pickups,
      icon: Icons.shopping_bag_outlined,
      emptyTitle: 'Sin recogidas',
      emptyMessage: 'No hay recogidas pendientes ahora mismo.',
      itemBuilder: (context, row) => MapListTile(
        data: row,
        titleKeys: const ['supplier_name', 'store', 'name', 'supplier', 'id'],
        subtitleKeys: const ['status', 'notes', 'created_at', 'scheduled_at'],
        trailingKeys: const ['total', 'amount'],
        leadingIcon: Icons.shopping_bag_outlined,
      ),
    );
  }
}
