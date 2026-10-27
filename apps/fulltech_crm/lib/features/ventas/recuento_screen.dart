import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Recuento: cuadre entre lo que dice el sistema y lo que hay.
class RecuentoScreen extends StatelessWidget {
  const RecuentoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Recuento', subtitle: 'Cuadre de existencias del inventario'),
        Expanded(
          child: RemoteLoader<Map<String, dynamic>>(
            load: state.repository.reconciliation,
            loadingLabel: 'Cuadrando inventario',
            builder: (context, data, reload) {
              final reconciliation = mapv(data['reconciliation']);
              final rows = listv(reconciliation['rows']).isEmpty
                  ? listv(data['rows']).isEmpty
                      ? listv(reconciliation['items'])
                      : listv(data['rows'])
                  : listv(reconciliation['rows']);

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  SectionCard(
                    title: 'Resumen del cuadre',
                    child: KeyValueList(
                      data: reconciliation.isEmpty ? Map.fromEntries(data.entries.where((e) => e.key != 'rows')) : reconciliation,
                      skipKeys: const ['rows', 'items', 'ok'],
                    ),
                  ),
                  SectionCard(
                    title: 'Diferencias',
                    trailing: Text('${rows.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                    child: rows.isEmpty
                        ? Row(
                            children: [
                              Icon(Icons.verified_outlined, size: 18, color: p.success),
                              const SizedBox(width: 8),
                              Text('Todo cuadra: no hay diferencias.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                            ],
                          )
                        : Column(
                            children: [
                              for (final row in rows.take(60))
                                MapListTile(
                                  data: row,
                                  titleKeys: const ['presentation', 'name', 'variant', 'product'],
                                  subtitleKeys: const ['kind', 'reason', 'notes'],
                                  trailingKeys: const ['difference', 'quantity', 'expected'],
                                  leadingIcon: Icons.compare_arrows_rounded,
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
