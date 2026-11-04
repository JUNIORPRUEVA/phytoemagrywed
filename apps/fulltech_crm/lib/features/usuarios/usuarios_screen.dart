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
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

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
    final form = await showEditUserDialog(
      context,
      user: user,
      repository: repository,
    );
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

    if (!canCreate) {
      return const Center(
        child: Text('Usuarios está disponible para administración.'),
      );
    }
    return RemoteLoader<List<Map<String, dynamic>>>(
      key: ValueKey(_reload),
      load: state.repository.users,
      builder: (context, rows, reload) {
        final query = _search.text.trim().toLowerCase();
        final filtered = rows
            .where(
              (row) =>
                  query.isEmpty ||
                  '${str(row['display_name'])} ${str(row['username'])} ${str(row['role'])} ${str(row['personal_phone'])}'
                      .toLowerCase()
                      .contains(query),
            )
            .toList();
        return Column(
          children: [
            Container(
              height: 48,
              padding: const EdgeInsets.symmetric(horizontal: 18),
              decoration: BoxDecoration(
                color: p.surface,
                border: Border(bottom: BorderSide(color: p.border)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Usuarios',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                        color: p.ink,
                      ),
                    ),
                  ),
                  Text(
                    '${rows.length} cuentas',
                    style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                  ),
                  const SizedBox(width: 10),
                  IconButton(
                    tooltip: 'Actualizar',
                    onPressed: reload,
                    icon: const Icon(Icons.refresh_rounded, size: 19),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, limits) => ListView(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                  children: [
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 900),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: SizedBox(
                                    height: 39,
                                    child: TextField(
                                      controller: _search,
                                      onChanged: (_) => setState(() {}),
                                      decoration: const InputDecoration(
                                        isDense: true,
                                        prefixIcon: Icon(
                                          Icons.search_rounded,
                                          size: 18,
                                        ),
                                        hintText:
                                            'Buscar por nombre, usuario o rol',
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                FilledButton.icon(
                                  onPressed: _createUser,
                                  icon: const Icon(
                                    Icons.person_add_alt_1_outlined,
                                    size: 17,
                                  ),
                                  label: const Text('Nuevo usuario'),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            if (filtered.isEmpty)
                              Padding(
                                padding: const EdgeInsets.all(25),
                                child: Text(
                                  query.isEmpty
                                      ? 'Aún no hay usuarios.'
                                      : 'No hay resultados.',
                                  style: TextStyle(color: p.inkSecondary),
                                ),
                              )
                            else
                              Container(
                                decoration: BoxDecoration(
                                  color: p.surface,
                                  border: Border.all(color: p.border),
                                  borderRadius: BorderRadius.circular(9),
                                ),
                                child: Column(
                                  children: [
                                    for (
                                      var i = 0;
                                      i < filtered.length;
                                      i++
                                    ) ...[
                                      if (i > 0)
                                        Divider(
                                          height: 1,
                                          indent: 50,
                                          color: p.border,
                                        ),
                                      _UserRow(
                                        row: filtered[i],
                                        onTap: () => _editUser(filtered[i]),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _UserRow extends StatelessWidget {
  const _UserRow({required this.row, required this.onTap});
  final Map<String, dynamic> row;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final name = str(row['display_name'], str(row['username'], 'Usuario'));
    final active = boolv(row['active'], true);
    final phone = str(row['personal_phone'], str(row['fleet_phone']));
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        child: Row(
          children: [
            CrmAvatar(label: name, size: 33),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: p.ink,
                    ),
                  ),
                  Text(
                    [
                      str(row['username']),
                      if (phone.isNotEmpty) phone,
                    ].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 90,
              child: Text(
                str(row['role'], 'AGENT').toLowerCase(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
              ),
            ),
            if (MediaQuery.sizeOf(context).width > 900)
              SizedBox(
                width: 115,
                child: Text(
                  str(row['last_login_at']).isEmpty
                      ? 'Sin acceso'
                      : CrmFormat.ago(row['last_login_at']),
                  style: TextStyle(fontSize: 11, color: p.inkSecondary),
                ),
              ),
            SizedBox(
              width: 73,
              child: Text(
                active ? 'Activo' : 'Inactivo',
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w700,
                  color: active ? p.success : p.inkSecondary,
                ),
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 17, color: p.inkSecondary),
          ],
        ),
      ),
    );
  }
}
