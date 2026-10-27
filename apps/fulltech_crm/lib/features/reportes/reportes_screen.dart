import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

typedef ReportBundle = ({Map<String, dynamic> metrics, Map<String, dynamic> report});

/// Reportes: ventas y actividad por periodo.
class ReportesScreen extends StatefulWidget {
  const ReportesScreen({super.key});

  @override
  State<ReportesScreen> createState() => _ReportesScreenState();
}

class _ReportesScreenState extends State<ReportesScreen> {
  String _period = '7d';

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Reportes', subtitle: 'Ventas y actividad por periodo'),
        FilterChips(
          options: const ['hoy', '7d', '30d'],
          value: _period,
          onChanged: (value) => setState(() => _period = value),
          labels: const {'hoy': 'Hoy', '7d': '7 días', '30d': '30 días'},
        ),
        const SizedBox(height: 8),
        Expanded(
          child: RemoteLoader<ReportBundle>(
            key: ValueKey(_period),
            loadingLabel: 'Preparando el reporte',
            load: () async {
              final metrics = await state.repository.metrics(_period);
              final report = await state.repository.salesReport();
              return (metrics: metrics, report: report);
            },
            builder: (context, bundle, reload) {
              final metrics = mapv(bundle.metrics['metrics']).isEmpty ? bundle.metrics : mapv(bundle.metrics['metrics']);
              final report = mapv(bundle.report['report']).isEmpty ? bundle.report : mapv(bundle.report['report']);
              final bySource = listv(report['bySource']).isEmpty ? listv(report['sources']) : listv(report['bySource']);

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  SectionCard(title: 'Métricas (${_period == 'hoy' ? 'hoy' : _period})', child: KeyValueList(data: metrics, skipKeys: const ['ok'])),
                  SectionCard(
                    title: 'Resumen de ventas',
                    child: report.isEmpty
                        ? Text('El servidor no devolvió el reporte.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                        : KeyValueList(data: report, skipKeys: const ['ok', 'bySource', 'sources', 'rows', 'items']),
                  ),
                  if (bySource.isNotEmpty)
                    SectionCard(
                      title: 'Por origen',
                      child: Column(
                        children: [
                          for (final row in bySource)
                            CrmListTile(
                              title: str(row['source'], str(row['name'], 'Origen')),
                              subtitle: '${intv(row['orders'], intv(row['count']))} pedidos',
                              leading: CrmAvatar(label: str(row['source'], 'O'), icon: Icons.trending_up_rounded),
                              trailing: Text(
                                CrmFormat.money(dub(row['total'], dub(row['revenue'])), short: true),
                                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: p.ink),
                              ),
                            ),
                        ],
                      ),
                    ),
                  SectionCard(
                    title: 'Filas del reporte',
                    trailing: Text('${listv(report['rows']).length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                    child: listv(report['rows']).isEmpty
                        ? Text('Sin filas detalladas.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                        : Column(
                            children: [
                              for (final row in listv(report['rows']).take(40))
                                MapListTile(
                                  data: row,
                                  titleKeys: const ['name', 'customer_name', 'order_number', 'id'],
                                  subtitleKeys: const ['status', 'created_at', 'date'],
                                  trailingKeys: const ['total', 'amount'],
                                  leadingIcon: Icons.receipt_long_outlined,
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
