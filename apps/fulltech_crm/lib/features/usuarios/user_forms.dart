import 'package:flutter/material.dart';

import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/crm_repository.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Formularios de usuarios y de contraseña propia.
///
/// Todo lo que se envía aquí es lo que el servidor ya acepta
/// (`POST /api/admin/users`, `POST /api/admin/users/me/password`). El cliente no
/// decide permisos: el servidor exige rol ADMIN para crear usuarios y cierra la
/// sesión al cambiar la contraseña.
///
/// Nunca se envía ni se muestra ningún hash, token ni contraseña ajena.

class NewUserForm {
  const NewUserForm({
    required this.username,
    required this.password,
    required this.displayName,
    required this.role,
    this.firstName = '',
    this.lastName = '',
    this.personalPhone = '',
  });

  final String username;
  final String password;
  final String displayName;
  final String role;
  final String firstName;
  final String lastName;
  final String personalPhone;
}

/// Devuelve los datos o `null` si se cancela.
Future<NewUserForm?> showNewUserDialog(BuildContext context) {
  final p = context.crm;
  final username = TextEditingController();
  final password = TextEditingController();
  final displayName = TextEditingController();
  final firstName = TextEditingController();
  final lastName = TextEditingController();
  final phone = TextEditingController();
  var role = 'AGENT';
  String? error;

  return showDialog<NewUserForm>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: const Text('Nuevo usuario'),
        content: SizedBox(
          width: 440,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: username,
                  autofocus: true,
                  decoration: const InputDecoration(labelText: 'Usuario (correo)'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: displayName,
                  maxLength: 80,
                  decoration: const InputDecoration(labelText: 'Nombre visible'),
                ),
                DropdownButtonFormField<String>(
                  initialValue: role,
                  decoration: const InputDecoration(labelText: 'Rol'),
                  items: const [
                    DropdownMenuItem(value: 'ADMIN', child: Text('Administración')),
                    DropdownMenuItem(value: 'AGENT', child: Text('Agente')),
                    DropdownMenuItem(value: 'OPERADOR', child: Text('Operador')),
                    DropdownMenuItem(value: 'DELIVERY', child: Text('Reparto')),
                    DropdownMenuItem(value: 'SUPPLIER', child: Text('Proveedor')),
                  ],
                  onChanged: (value) => setDialogState(() => role = value ?? 'AGENT'),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(child: TextField(controller: firstName, decoration: const InputDecoration(labelText: 'Nombre'))),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(controller: lastName, decoration: const InputDecoration(labelText: 'Apellido'))),
                  ],
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono personal (opcional)'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: password,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Contraseña inicial'),
                ),
                const SizedBox(height: 6),
                Text(
                  'La contraseña la elige quien crea la cuenta y se le comunica por un canal seguro. '
                  'El CRM no muestra contraseñas ni hashes.',
                  style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(error!, style: TextStyle(fontSize: 12.5, color: p.danger)),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () {
              final user = username.text.trim();
              final name = displayName.text.trim();
              final pass = password.text;
              if (user.isEmpty) {
                setDialogState(() => error = 'Escribe el usuario.');
                return;
              }
              if (name.isEmpty) {
                setDialogState(() => error = 'Escribe el nombre visible.');
                return;
              }
              if (pass.isEmpty) {
                setDialogState(() => error = 'Escribe una contraseña inicial.');
                return;
              }
              Navigator.of(dialogContext).pop(
                NewUserForm(
                  username: user,
                  password: pass,
                  displayName: name,
                  role: role,
                  firstName: firstName.text.trim(),
                  lastName: lastName.text.trim(),
                  personalPhone: phone.text.trim(),
                ),
              );
            },
            child: const Text('Crear'),
          ),
        ],
      ),
    ),
  );
}

/// Crea el usuario y deja el resultado en un aviso. Devuelve `true` si se creó.
Future<bool> createUserFromForm(
  BuildContext context, {
  required CrmRepository repository,
  required NewUserForm form,
}) async {
  try {
    await repository.createUser(
      username: form.username,
      password: form.password,
      displayName: form.displayName,
      role: form.role,
      firstName: form.firstName,
      lastName: form.lastName,
      personalPhone: form.personalPhone,
    );
    if (!context.mounted) return true;
    crmToast(context, 'Usuario creado. Comunícale la contraseña por un canal seguro.');
    return true;
  } on ApiException catch (error) {
    if (!context.mounted) return false;
    await crmConfirm(
      context,
      title: 'No se pudo crear',
      message: error.code == 'duplicate_user'
          ? 'Ya existe un usuario con ese nombre.'
          : (error.message.isEmpty ? 'Revisa los datos.' : error.message),
      confirmLabel: 'Entendido',
    );
    return false;
  }
}

class EditUserForm {
  const EditUserForm({required this.displayName, required this.role, required this.active});

  final String displayName;
  final String role;
  final bool active;
}

/// Edición de un usuario existente.
///
/// Campos que acepta el servidor: nombre visible, rol y activo. El servidor
/// rechaza un rol desconocido (422 `invalid_role`) y **no permite** degradar ni
/// desactivar al último administrador (409 `last_admin`): el aviso al usuario
/// nace de esa respuesta, nunca de una regla inventada en Dart.
Future<EditUserForm?> showEditUserDialog(
  BuildContext context, {
  required Map<String, dynamic> user,
  required CrmRepository repository,
}) {
  final p = context.crm;
  final displayName = TextEditingController(text: str(user['display_name'], str(user['displayName'])));
  var role = str(user['role'], 'AGENT').toUpperCase();
  var active = user['active'] != false;
  const roles = ['ADMIN', 'AGENT', 'OPERADOR', 'DELIVERY', 'SUPPLIER'];
  if (!roles.contains(role)) role = 'AGENT';

  return showDialog<EditUserForm>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: Text('Editar ${str(user['username'], 'usuario')}'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: displayName,
                maxLength: 120,
                decoration: const InputDecoration(labelText: 'Nombre visible'),
              ),
              DropdownButtonFormField<String>(
                initialValue: role,
                decoration: const InputDecoration(labelText: 'Rol'),
                items: const [
                  DropdownMenuItem(value: 'ADMIN', child: Text('Administración')),
                  DropdownMenuItem(value: 'AGENT', child: Text('Agente')),
                  DropdownMenuItem(value: 'OPERADOR', child: Text('Operador')),
                  DropdownMenuItem(value: 'DELIVERY', child: Text('Reparto')),
                  DropdownMenuItem(value: 'SUPPLIER', child: Text('Proveedor')),
                ],
                onChanged: (value) => setDialogState(() => role = value ?? role),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                value: active,
                onChanged: (value) => setDialogState(() => active = value),
                contentPadding: EdgeInsets.zero,
                title: const Text('Cuenta activa', style: TextStyle(fontSize: 13.5)),
                subtitle: const Text('Desactivada no puede entrar, pero no se borra su historial.', style: TextStyle(fontSize: 11.5)),
              ),
              Text(
                'El servidor no permite dejar el CRM sin administración activa: lo dirá él si se intenta.',
                style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
              ),
              const SizedBox(height: 4),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.apartment_outlined, size: 16),
                  label: const Text('Empresas permitidas', style: TextStyle(fontSize: 12.5)),
                  onPressed: () => showCompaniesSheet(
                    context,
                    repository: repository,
                    userId: str(user['id']),
                  ),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () async {
              final name = displayName.text.trim();
              if (name.isEmpty) return;
              final roleChanged = role != str(user['role'], 'AGENT').toUpperCase();
              final deactivating = user['active'] != false && !active;
              if (roleChanged || deactivating) {
                final ok = await crmConfirm(
                  dialogContext,
                  title: 'Confirmar cambio de acceso',
                  message: [
                    if (roleChanged) 'El rol pasará a $role.',
                    if (deactivating) 'La cuenta quedará desactivada y no podrá entrar.',
                  ].join(' '),
                  confirmLabel: 'Aplicar',
                );
                if (!ok) return;
              }
              if (dialogContext.mounted) {
                Navigator.of(dialogContext).pop(EditUserForm(displayName: name, role: role, active: active));
              }
            },
            child: const Text('Guardar'),
          ),
        ],
      ),
    ),
  );
}

/// Aplica la edición y avisa del resultado del servidor.
Future<bool> saveUserEdit(
  BuildContext context, {
  required CrmRepository repository,
  required String userId,
  required EditUserForm form,
}) async {
  try {
    await repository.updateUser(userId, displayName: form.displayName, role: form.role, active: form.active);
    if (!context.mounted) return true;
    crmToast(context, 'Usuario actualizado.');
    return true;
  } on ApiException catch (error) {
    if (!context.mounted) return false;
    final message = switch (error.code) {
      'last_admin' => 'No se puede dejar el CRM sin ningún administrador activo.',
      'invalid_role' => 'Ese rol no existe en el CRM.',
      'not_found' => 'Ese usuario ya no existe. Recarga la lista.',
      _ => error.message.isEmpty ? 'No se pudo guardar el cambio.' : error.message,
    };
    await crmConfirm(context, title: 'No se pudo guardar', message: message, confirmLabel: 'Entendido');
    return false;
  }
}

/// Cambio de la contraseña propia. El servidor cierra la sesión al terminar, así
/// que el llamador debe devolver a la pantalla de entrada.
Future<bool> changeOwnPasswordDialog(
  BuildContext context, {
  required CrmRepository repository,
}) async {
  final p = context.crm;
  final current = TextEditingController();
  final next = TextEditingController();
  final confirm = TextEditingController();
  String? error;
  var busy = false;

  final changed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: const Text('Cambiar mi contraseña'),
        content: SizedBox(
          width: 380,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: current,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Contraseña actual'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: next,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Contraseña nueva'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: confirm,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Repite la contraseña nueva'),
              ),
              const SizedBox(height: 8),
              Text(
                'Al cambiarla se cierra la sesión en este dispositivo y tendrás que entrar de nuevo.',
                style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(error!, style: TextStyle(fontSize: 12.5, color: p.danger)),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: busy ? null : () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: busy
                ? null
                : () async {
                    if (next.text != confirm.text) {
                      setDialogState(() => error = 'Las contraseñas nuevas no coinciden.');
                      return;
                    }
                    setDialogState(() {
                      busy = true;
                      error = null;
                    });
                    try {
                      await repository.changeOwnPassword(
                        currentPassword: current.text,
                        newPassword: next.text,
                        confirmPassword: confirm.text,
                      );
                      if (dialogContext.mounted) Navigator.of(dialogContext).pop(true);
                    } on ApiException catch (exception) {
                      setDialogState(() {
                        busy = false;
                        error = exception.message.isEmpty ? 'No se pudo cambiar la contraseña.' : exception.message;
                      });
                    }
                  },
            child: busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Cambiar'),
          ),
        ],
      ),
    ),
  );
  return changed == true;
}


/// Empresas del usuario: concesiones reales del servidor y catálogo para elegir.
///
/// Cada casilla es una concesión (`POST /users/:id/companies` con
/// `{companyId, active}`). El servidor valida que la empresa exista y registra
/// el cambio en auditoría; aquí solo se muestra su estado.
///
/// Ciclo de vida: la carga va en `initState` de un `StatefulWidget` real, NUNCA
/// dentro del `build`. Antes se lanzaba desde el builder con
/// `if (loading && …) load();`, y `load()` hacía `setState` en mitad del build:
/// error de Flutter y peticiones repetidas en cada reconstrucción.
Future<void> showCompaniesSheet(
  BuildContext context, {
  required CrmRepository repository,
  required String userId,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _CompaniesSheet(repository: repository, userId: userId),
  );
}

class _CompaniesSheet extends StatefulWidget {
  const _CompaniesSheet({required this.repository, required this.userId});

  final CrmRepository repository;
  final String userId;

  @override
  State<_CompaniesSheet> createState() => _CompaniesSheetState();
}

class _CompaniesSheetState extends State<_CompaniesSheet> {
  List<Map<String, dynamic>> _companies = const [];
  List<Map<String, dynamic>> _grants = const [];
  final Set<String> _busy = {};
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    // `_loading` ya nace en true: la primera carga no necesita avisar al build.
    _load(notify: false);
  }

  /// Lee catálogo y concesiones del SERVIDOR. Si falla, se conserva lo que ya se
  /// mostraba: nunca se pinta un permiso que no se ha confirmado.
  Future<void> _load({bool notify = true}) async {
    if (notify && mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final catalog = await widget.repository.logisticsCompanies();
      final own = await widget.repository.userCompanyGrants(widget.userId);
      if (!mounted) return;
      setState(() {
        _companies = catalog;
        _grants = own;
        _loading = false;
        _error = null;
      });
    } on ApiException catch (exception) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = exception.message.isEmpty ? 'No se pudieron cargar las empresas.' : exception.message;
      });
    }
  }

  bool _granted(String companyId) => _grants.any(
        (row) => str(row['company_id']) == companyId && row['active'] == true,
      );

  /// Un solo envío por empresa: el interruptor afectado se deshabilita mientras
  /// viaja y se releen las concesiones al terminar.
  Future<void> _toggle(String companyId, bool value) async {
    if (_busy.contains(companyId)) return;
    setState(() => _busy.add(companyId));
    try {
      await widget.repository.setUserCompany(widget.userId, companyId: companyId, active: value);
      final own = await widget.repository.userCompanyGrants(widget.userId);
      if (!mounted) return;
      setState(() {
        _grants = own;
        _busy.remove(companyId);
        _error = null;
      });
    } on ApiException catch (exception) {
      if (!mounted) return;
      setState(() {
        _busy.remove(companyId);
        _error = exception.message.isEmpty ? 'No se pudo guardar el cambio.' : exception.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Empresas permitidas', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: p.ink)),
              const SizedBox(height: 4),
              Text(
                'Solo afecta al alcance de reparto. El servidor decide qué ve cada rol; '
                'estas casillas no otorgan permisos de administración.',
                style: TextStyle(fontSize: 12, color: p.inkSecondary),
              ),
              const SizedBox(height: 8),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      Expanded(child: Text(_error!, style: TextStyle(fontSize: 12.5, color: p.danger))),
                      TextButton(onPressed: _loading ? null : () => _load(), child: const Text('Reintentar')),
                    ],
                  ),
                ),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                )
              else if (_companies.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text('No hay empresas logísticas creadas.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                )
              else
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final company in _companies)
                        Builder(builder: (context) {
                          final id = str(company['id']);
                          final inactive = company['active'] == false;
                          final busy = _busy.contains(id);
                          return SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            value: _granted(id),
                            title: Text(str(company['name'], id), style: const TextStyle(fontSize: 13.5)),
                            subtitle: inactive
                                ? Text('Empresa inactiva', style: TextStyle(fontSize: 11.5, color: p.inkSecondary))
                                : (busy
                                    ? Text('Guardando…', style: TextStyle(fontSize: 11.5, color: p.inkSecondary))
                                    : null),
                            onChanged: busy || inactive ? null : (value) => _toggle(id, value),
                          );
                        }),
                    ],
                  ),
                ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cerrar'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
