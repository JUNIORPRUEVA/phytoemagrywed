import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

typedef CloseBundle = ({Map<String, dynamic> metrics, Map<String, dynamic> report, Map<String, dynamic> cash});

/// Cierre del día: lo vendido, lo cobrado, lo que falta y el efectivo que aún
/// lleva el reparto. Se calcula con las MISMAS fuentes que el panel web
/// (`/api/admin/metrics`, `/api/admin/reports/sales` y `/api/admin/delivery-cash`),
/// así los números coinciden con la PWA.
class CierreScreen extends StatelessWidget {
  const CierreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final stats = state.stats;

    return Column(
      children: [
        const CrmPageHeader(title: 'Cierre actual', subtitle: 'Lo que ha pasado hoy'),
        Expanded(
          child: RemoteLoader<CloseBundle>(
            loadingLabel: 'Cerrando el día',
            load: () async {
              final metrics = await state.repository.metrics('hoy');
              final today = DateTime.now();
              final iso =
                  '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
              final report = await state.repository.salesReport(from: iso, to: iso);
              Map<String, dynamic> cash;
              try {
                cash = await state.repository.deliveryCash();
              } catch (_) {
                // La custodia necesita `delivery.manage`: si el rol no lo tiene,
                // el cierre sigue mostrando ventas y cobros.
                cash = const {};
              }
              return (metrics: metrics, report: report, cash: cash);
            },
            builder: (context, bundle, reload) {
              final metrics = mapv(bundle.metrics['metrics']).isEmpty ? bundle.metrics : mapv(bundle.metrics['metrics']);
              final report = mapv(bundle.report['report']).isEmpty ? bundle.report : mapv(bundle.report['report']);
              final couriers = listv(bundle.cash['couriers']);

              var chargedCash = 0;
              var remitted = 0;
              var courierPending = 0;
              for (final row in couriers) {
                chargedCash += intv(row['charged_cents']);
                remitted += intv(row['remitted_cents']);
                courierPending += intv(row['pending_cents']);
              }

              return ListView(
                padding: const EdgeInsets.only(top: 4, bottom: 26),
                children: [
                  StatGrid(
                    children: [
                      StatTile(label: 'Pedidos abiertos', value: '${intv(stats['pedidos'])}', icon: Icons.receipt_long_outlined),
                      StatTile(
                        label: 'Entregados',
                        value: '${intv(stats['entregados'])}',
                        tone: p.success,
                        icon: Icons.local_shipping_outlined,
                      ),
                      StatTile(
                        label: 'Cobrado',
                        value: CrmFormat.money(dub(stats['valorCobrado']), short: true),
                        tone: p.success,
                        icon: Icons.payments_outlined,
                      ),
                      StatTile(
                        label: 'Por cobrar',
                        value: CrmFormat.money(dub(stats['valorAbierto']), short: true),
                        tone: p.warning,
                        icon: Icons.hourglass_bottom_rounded,
                      ),
                      StatTile(label: 'Nuevos', value: '${intv(stats['nuevos'])}', icon: Icons.fiber_new_outlined),
                      StatTile(
                        label: 'Atrasados',
                        value: '${intv(stats['atrasados'])}',
                        tone: p.danger,
                        icon: Icons.warning_amber_rounded,
                      ),
                    ],
                  ),
                  if (couriers.isNotEmpty)
                    SectionCard(
                      title: 'Efectivo y custodia',
                      child: Column(
                        children: [
                          _Row(label: 'Cobrado en efectivo', value: CrmFormat.money(chargedCash / 100)),
                          _Row(label: 'Rendido a la empresa', value: CrmFormat.money(remitted / 100), tone: p.success),
                          _Row(
                            label: 'Aún en manos del reparto',
                            value: CrmFormat.money(courierPending / 100),
                            tone: courierPending > 0 ? p.warning : p.success,
                            strong: true,
                          ),
                          Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Text(
                              'Ese pendiente NO cuenta como dinero en caja hasta que se registre la rendición.',
                              style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                            ),
                          ),
                        ],
                      ),
                    ),
                  SectionCard(title: 'Métricas del día', child: KeyValueList(data: metrics, skipKeys: const ['ok'])),
                  SectionCard(title: 'Ventas del día', child: KeyValueList(data: report, skipKeys: const ['ok', 'rows', 'items'])),
                  const CrmNotice(
                    message: 'El cierre formal con bloqueo del día, arqueo firmado e impresión se completa en el panel web. '
                        'Estas cifras salen de las mismas fuentes, así que coinciden con la PWA.',
                    tone: Color(0xFF0D4F6C),
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

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.strong = false, this.tone});

  final String label;
  final String value;
  final bool strong;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(child: Text(label, style: TextStyle(fontSize: 12.5, color: p.inkSecondary))),
          Text(
            value,
            style: TextStyle(
              fontSize: strong ? 15 : 13,
              fontWeight: strong ? FontWeight.w800 : FontWeight.w600,
              color: tone ?? p.ink,
            ),
          ),
        ],
      ),
    );
  }
}
