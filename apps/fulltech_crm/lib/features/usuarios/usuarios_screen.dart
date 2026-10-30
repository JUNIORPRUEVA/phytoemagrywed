import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';
import 'user_forms.dart';

/// Usuarios del panel y su rol.
///
/// Solo ADMIN puede crear cuentas (`requireAdmin()` en el servidor). Aquí se
/// oculta el botón sin ese permiso, pero la decisión sigue siendo del servidor.
class UsuariosScreen extends StatefulWidget {
  const UsuariosScreen({super.key});

  @override
  State<UsuariosScreen> createState() => _UsuariosScreenState();
}

class _UsuariosScreenState extends State<UsuariosScreen> {
  /// Cambiar la clave obliga a `RemoteListScreen` a volver a pedir la lista.
  int _reload = 0;

  Future<void> _createUser() async {
    final form = await showNewUserDialog(context);
    if (form == null || !mounted) return;
    final created = await createUserFromForm(
      context,
      repository: CrmScope.of(context, listen: false).repository,
      form: form,
    );
    if (created && mounted) setState(() => _reload += 1);
  }

  Future<void> _editUser(Map<String, dynamic> user) async {
    final repository = CrmScope.of(context, listen: false).repository;
    final form = await showEditUserDialog(context, user: user, repository: repository);
    if (form == null || !mounted) return;
    final saved = await saveUserEdit(
      context,
      repository: repository,
      userId: str(user['id']),
      form: form,
    );
    if (saved && mounted) setState(() => _reload += 1);
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final canCreate = state.session.can('admin.full');

    return RemoteListScreen(
      key: ValueKey(_reload),
      title: 'Usuarios',
      subtitle: 'Quién entra al CRM y con qué rol',
      load: state.repository.users,
      icon: Icons.group_add_outlined,
      emptyTitle: 'Sin usuarios',
      emptyMessage: 'El panel todavía no tiene usuarios con cuenta propia.',
      header: (context, rows) => SectionCard(
        title: 'Resumen',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
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
            if (canCreate) ...[
              const SizedBox(height: 10),
              CrmButton(
                label: 'Nuevo usuario',
                icon: Icons.person_add_alt_1_outlined,
                expand: true,
                onPressed: _createUser,
              ),
            ],
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
          onTap: canCreate ? () => _editUser(row) : null,
        );
      },
    );
  }
}
