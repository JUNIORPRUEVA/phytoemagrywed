import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Ajuste de stock: existencias reales y los últimos movimientos.
class InventarioScreen extends StatelessWidget {
  const InventarioScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Ajuste de stock', subtitle: 'Existencias y movimientos del inventario'),
        Expanded(
          child: RemoteLoader<Map<String, dynamic>>(
            load: state.repository.inventory,
            loadingLabel: 'Cargando inventario',
            builder: (context, data, reload) {
              final product = mapv(data['product']);
              final presentations = listv(data['presentations']).isEmpty ? listv(product['presentations']) : listv(data['presentations']);
              final movements = listv(data['movements']);

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  SectionCard(
                    title: 'Producto',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          str(product['name'], 'Producto principal'),
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: p.ink),
                        ),
                        const SizedBox(height: 8),
                        for (final row in presentations)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: Row(
                              children: [
                                Expanded(child: Text(str(row['name'], 'Presentación'), style: TextStyle(fontSize: 13, color: p.ink))),
                                Text(
                                  '${intv(row['stock'], intv(row['quantity']))}',
                                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: p.ink),
                                ),
                              ],
                            ),
                          ),
                        if (presentations.isEmpty)
                          Text('El servidor no devolvió presentaciones.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                      ],
                    ),
                  ),
                  SectionCard(
                    title: 'Últimos movimientos',
                    trailing: Text('${movements.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                    child: movements.isEmpty
                        ? Text('Sin movimientos registrados.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                        : Column(
                            children: [
                              for (final row in movements.take(40))
                                CrmListTile(
                                  title: str(row['reason'], str(row['type'], 'Movimiento')),
                                  subtitle: [
                                    CrmFormat.ago(row['created_at'] ?? row['at']),
                                    if (str(row['actor'], str(row['user'])).isNotEmpty) str(row['actor'], str(row['user'])),
                                  ].join(' · '),
                                  leading: CrmAvatar(
                                    label: str(row['type'], 'M'),
                                    icon: intv(row['quantity']) >= 0 ? Icons.add_circle_outline : Icons.remove_circle_outline,
                                    tone: intv(row['quantity']) >= 0 ? p.success : p.danger,
                                  ),
                                  trailing: Text(
                                    '${intv(row['quantity']) >= 0 ? '+' : ''}${intv(row['quantity'])}',
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w800,
                                      color: intv(row['quantity']) >= 0 ? p.success : p.danger,
                                    ),
                                  ),
                                ),
                            ],
                          ),
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
