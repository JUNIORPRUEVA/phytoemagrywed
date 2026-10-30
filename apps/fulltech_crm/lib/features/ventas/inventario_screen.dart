import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';
import 'inventory_actions.dart';
import 'inventory_fields.dart';

/// Ajuste de stock: existencias reales y los últimos movimientos.
class InventarioScreen extends StatelessWidget {
  const InventarioScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    // Las cuatro escrituras del inventario son de ADMIN en el servidor
    // (`requireAdmin()`). El botón se oculta sin el permiso, pero la decisión
    // real es del servidor: si llegara la petición, responderá 403.
    final canWrite = state.session.can('admin.full');

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
              final capsules = sharedCapsuleStock(data);
              final value = inventoryValueCents(data);
              final unitCost = numv(mapv(data['product'])['current_unit_cost_cents'], 0).toDouble() / 100;

              Future<void> act(InventoryAction action) async {
                final ok = await runInventoryAction(
                  context,
                  repository: state.repository,
                  action: action,
                  currentStock: capsules,
                  currentUnitCost: unitCost,
                );
                if (ok && context.mounted) reload();
              }

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  SectionCard(
                    title: 'Inventario compartido',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          // Una sola cifra de cápsulas para todo el catálogo: es
                          // lo que descuenta el servidor al cobrar.
                          inventoryInitialized(data) ? '$capsules cápsulas en stock' : 'Sin recuento inicial',
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: p.ink),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          inventoryInitialized(data)
                              ? 'Valor del inventario: ${CrmFormat.money(value / 100)}'
                              : 'El servidor no bloquea ventas por stock hasta que exista el primer recuento.',
                          style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                        ),
                        if (canWrite) ...[
                          const SizedBox(height: 10),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (final action in InventoryAction.values)
                                CrmButton(
                                  label: inventoryActionLabel(action),
                                  icon: switch (action) {
                                    InventoryAction.restock => Icons.add_box_outlined,
                                    InventoryAction.adjustIn => Icons.arrow_downward_rounded,
                                    InventoryAction.adjustOut => Icons.arrow_upward_rounded,
                                    InventoryAction.count => Icons.fact_check_outlined,
                                    InventoryAction.cost => Icons.price_change_outlined,
                                  },
                                  filled: false,
                                  onPressed: () => act(action),
                                ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
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
                                Expanded(child: Text(presentationLabel(row), style: TextStyle(fontSize: 13, color: p.ink))),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    // Modelo LEGACY: cápsulas que consume cada unidad.
                                    Text(
                                      '${presentationCapsules(row)} cápsulas/u',
                                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: p.ink),
                                    ),
                                    // Modelo NUEVO: existencias propias de la variante, si las lleva.
                                    if (presentationStock(row) != null)
                                      Text(
                                        '${presentationStock(row)} uds. propias',
                                        style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                                      ),
                                  ],
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
