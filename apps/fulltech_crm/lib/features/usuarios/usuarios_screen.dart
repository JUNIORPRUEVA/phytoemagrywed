import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Usuarios del panel y su rol.
class UsuariosScreen extends StatelessWidget {
  const UsuariosScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return RemoteListScreen(
      title: 'Usuarios',
      subtitle: 'Quién entra al CRM y con qué rol',
      load: state.repository.users,
      icon: Icons.group_add_outlined,
      emptyTitle: 'Sin usuarios',
      emptyMessage: 'El panel todavía no tiene usuarios con cuenta propia.',
      header: (context, rows) => SectionCard(
        title: 'Resumen',
        child: Column(
          children: [
            for (final role in const ['ADMIN', 'AGENT', 'DELIVERY', 'SUPPLIER'])
              Builder(builder: (context) {
                final count = rows.where((row) => str(row['role']).toUpperCase() == role).length;
                if (count == 0) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(
                    children: [
                      StatusPill(label: role.toLowerCase(), dense: true),
                      const SizedBox(width: 10),
                      Text('$count usuario(s)', style: TextStyle(fontSize: 12.5, color: p.ink)),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
      itemBuilder: (context, row) {
        final name = str(row['display_name'], str(row['username'], 'Usuario'));
        final active = boolv(row['active'], true);
        return CrmListTile(
          title: name,
          subtitle: [
            str(row['username']),
            str(row['role'], 'AGENT').toLowerCase(),
            if (boolv(row['must_change_password'])) 'debe cambiar la contraseña',
            if (str(row['last_login_at']).isNotEmpty) 'entró ${CrmFormat.ago(row['last_login_at'])}',
          ].join(' · '),
          leading: CrmAvatar(label: name),
          trailing: StatusPill(label: active ? 'activo' : 'inactivo', dense: true, color: active ? p.success : p.inkSecondary),
        );
      },
    );
  }
}
