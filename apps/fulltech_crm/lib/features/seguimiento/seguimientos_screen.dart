import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Seguimientos: hoy, atrasados y próximos, directo del paquete de datos.
class SeguimientosScreen extends StatelessWidget {
  const SeguimientosScreen({super.key});

  static List<FollowupRow> _rows(Object? value) =>
      (value is List ? value : const []).map((row) => FollowupRow.fromJson(mapv(row))).toList();

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final buckets = state.followups;
    final today = _rows(buckets['today']);
    final overdue = _rows(buckets['overdue']);
    final upcoming = _rows(buckets['upcoming']);
    final completed = _rows(buckets['completed']);

    return Column(
      children: [
        CrmPageHeader(
          title: 'Seguimientos',
          subtitle: '${today.length} para hoy · ${overdue.length} atrasados',
          actions: [
            IconButton(
              tooltip: 'Actualizar',
              onPressed: state.loading ? null : () => state.refresh(),
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refresh,
            child: ListView(
              padding: const EdgeInsets.only(top: 4, bottom: 26),
              children: [
                StatGrid(
                  children: [
                    StatTile(label: 'Hoy', value: '${today.length}', icon: Icons.today_outlined),
                    StatTile(label: 'Atrasados', value: '${overdue.length}', tone: p.danger, icon: Icons.schedule_outlined),
                    StatTile(label: 'Próximos', value: '${upcoming.length}', tone: p.primary, icon: Icons.event_available_outlined),
                    StatTile(label: 'Hechos', value: '${completed.length}', tone: p.success, icon: Icons.task_alt_rounded),
                  ],
                ),
                _Bucket(title: 'Atrasados', rows: overdue, tone: p.danger),
                _Bucket(title: 'Para hoy', rows: today),
                _Bucket(title: 'Próximos', rows: upcoming, tone: p.primary),
                _Bucket(title: 'Completados', rows: completed, tone: p.success),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Bucket extends StatelessWidget {
  const _Bucket({required this.title, required this.rows, this.tone});

  final String title;
  final List<FollowupRow> rows;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return SectionCard(
      title: title,
      trailing: StatusPill(label: '${rows.length}', color: tone ?? p.inkSecondary, dense: true),
      child: rows.isEmpty
          ? Text('Nada aquí.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
          : Column(
              children: [
                for (final row in rows.take(40))
                  CrmListTile(
                    title: row.customerName,
                    subtitle: [CrmFormat.ago(row.scheduledAt), if (row.note.isNotEmpty) row.note].join(' · '),
                    leading: CrmAvatar(label: row.customerName, icon: Icons.event_repeat_outlined, tone: tone),
                    trailing: StatusPill(label: row.status, dense: true),
                  ),
              ],
            ),
    );
  }
}
