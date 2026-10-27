import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Tiendas proveedoras y dónde se consigue cada producto.
class TiendasScreen extends StatelessWidget {
  const TiendasScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final productSuppliers = listv(state.snapshot['productSuppliers']);

    return RemoteListScreen(
      title: 'Tiendas',
      subtitle: 'Proveedores del catálogo',
      load: state.repository.suppliers,
      icon: Icons.storefront_outlined,
      emptyTitle: 'Sin tiendas registradas',
      emptyMessage: 'Las tiendas proveedoras se dan de alta desde el panel web.',
      header: (context, rows) => productSuppliers.isEmpty
          ? const SizedBox.shrink()
          : CrmNotice(
              message: '${productSuppliers.length} enlaces producto–tienda cargados en el paquete de datos.',
              tone: p.primary,
              icon: Icons.link_rounded,
            ),
      itemBuilder: (context, row) => MapListTile(
        data: row,
        titleKeys: const ['name', 'store', 'supplier'],
        subtitleKeys: const ['address', 'phone', 'notes', 'location_status'],
        trailingKeys: const ['total', 'amount'],
        leadingIcon: Icons.storefront_outlined,
      ),
    );
  }
}
