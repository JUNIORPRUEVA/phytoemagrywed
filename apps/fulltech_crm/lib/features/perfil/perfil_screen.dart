import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../usuarios/user_forms.dart';

class PerfilScreen extends StatefulWidget {
  const PerfilScreen({super.key});
  @override
  State<PerfilScreen> createState() => _PerfilScreenState();
}

class _PerfilScreenState extends State<PerfilScreen> {
  Map<String, dynamic> _details = const {};
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() => _loading = true);
    try {
      final data = await CrmScope.of(
        context,
        listen: false,
      ).repository.profileDetails();
      if (mounted) setState(() => _details = mapv(data['user']));
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _edit() async {
    final state = CrmScope.of(context, listen: false);
    if (state.session.user == null) return;
    final p = context.crm;
    final fields = <String, TextEditingController>{
      'displayName': TextEditingController(
        text: str(_details['display_name'], state.session.user!.displayName),
      ),
      'firstName': TextEditingController(text: str(_details['first_name'])),
      'lastName': TextEditingController(text: str(_details['last_name'])),
      'personalPhone': TextEditingController(
        text: str(_details['personal_phone']),
      ),
      'fleetPhone': TextEditingController(text: str(_details['fleet_phone'])),
    };
    final deliver = const {
      'AGENT',
      'DELIVERY',
    }.contains(state.session.user!.role);
    var disposalScheduled = false;
    final edited = await showDialog<Map<String, String>>(
      context: context,
      builder: (dialogContext) {
        if (!disposalScheduled) {
          disposalScheduled = true;
          ModalRoute.of(dialogContext)?.completed.then((_) {
            for (final controller in fields.values) {
              controller.dispose();
            }
          });
        }
        return AlertDialog(
          title: const Text('Editar mi perfil'),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'El nombre visible aparece como autor de tus mensajes.',
                    style: TextStyle(fontSize: 12, color: p.inkSecondary),
                  ),
                  const SizedBox(height: 10),
                  for (final field in [
                    ('displayName', 'Nombre visible'),
                    ('firstName', 'Nombre'),
                    ('lastName', 'Apellido'),
                    if (deliver) ('personalPhone', 'Teléfono personal'),
                    if (deliver) ('fleetPhone', 'Teléfono de apoyo o flota'),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 9),
                      child: TextField(
                        controller: fields[field.$1],
                        keyboardType: field.$1.contains('Phone')
                            ? TextInputType.phone
                            : TextInputType.text,
                        decoration: InputDecoration(
                          labelText: field.$2,
                          isDense: true,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () {
                if (fields['displayName']!.text.trim().isEmpty) {
                  crmToast(dialogContext, 'Escribe el nombre visible');
                  return;
                }
                Navigator.pop(dialogContext, {
                  for (final entry in fields.entries)
                    entry.key: entry.value.text.trim(),
                });
              },
              child: const Text('Guardar'),
            ),
          ],
        );
      },
    );
    if (edited == null || !mounted) return;
    try {
      await state.repository.updateOwnProfile(
        displayName: edited['displayName']!,
        firstName: edited['firstName']!,
        lastName: edited['lastName']!,
        personalPhone: deliver ? edited['personalPhone'] : null,
        fleetPhone: deliver ? edited['fleetPhone'] : null,
      );
      await state.reloadSession();
      await _load();
      if (mounted) crmToast(context, 'Perfil actualizado');
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  Future<void> _password() async {
    final state = CrmScope.of(context, listen: false);
    final changed = await changeOwnPasswordDialog(
      context,
      repository: state.repository,
    );
    if (changed) await state.logout();
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final user = state.session.user;
    return Column(
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          alignment: Alignment.centerLeft,
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Text(
            'Mi perfil',
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w800,
              color: p.ink,
            ),
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: [
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 850),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Container(
                        padding: const EdgeInsets.all(13),
                        decoration: BoxDecoration(
                          color: p.surface,
                          border: Border.all(color: p.border),
                          borderRadius: BorderRadius.circular(9),
                        ),
                        child: Row(
                          children: [
                            CrmAvatar(label: user?.initials ?? 'FT', size: 42),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    user?.displayName ?? 'Acceso del panel',
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w800,
                                      color: p.ink,
                                    ),
                                  ),
                                  Text(
                                    user == null
                                        ? 'Sin perfil personal'
                                        : '${user.username} · ${user.role}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      color: p.inkSecondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            if (_loading)
                              const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                            if (user != null)
                              TextButton.icon(
                                onPressed: _edit,
                                icon: const Icon(Icons.edit_outlined, size: 16),
                                label: const Text('Editar'),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 15),
                      LayoutBuilder(
                        builder: (context, limits) {
                          final account = _Panel(
                            title: 'Cuenta',
                            children: [
                              _Line(
                                label: 'Usuario',
                                value: user?.username ?? 'Token del panel',
                              ),
                              _Line(
                                label: 'Rol',
                                value: user?.role ?? 'Acceso legacy',
                              ),
                              if (str(_details['personal_phone']).isNotEmpty)
                                _Line(
                                  label: 'Teléfono',
                                  value: str(_details['personal_phone']),
                                ),
                              if (user != null)
                                _Action(
                                  label: 'Cambiar contraseña',
                                  icon: Icons.lock_reset_rounded,
                                  onTap: _password,
                                ),
                            ],
                          );
                          final appearance = _Panel(
                            title: 'Apariencia',
                            children: [
                              for (final entry in const [
                                (
                                  ThemeMode.light,
                                  'Claro',
                                  Icons.light_mode_outlined,
                                ),
                                (
                                  ThemeMode.dark,
                                  'Oscuro',
                                  Icons.dark_mode_outlined,
                                ),
                                (
                                  ThemeMode.system,
                                  'Según Windows',
                                  Icons.brightness_auto_outlined,
                                ),
                              ])
                                _Action(
                                  label: entry.$2,
                                  icon: entry.$3,
                                  checked: state.themeMode == entry.$1,
                                  onTap: () => state.setThemeMode(entry.$1),
                                ),
                            ],
                          );
                          return limits.maxWidth >= 620
                              ? Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Expanded(child: account),
                                    const SizedBox(width: 12),
                                    Expanded(child: appearance),
                                  ],
                                )
                              : Column(
                                  children: [
                                    account,
                                    const SizedBox(height: 12),
                                    appearance,
                                  ],
                                );
                        },
                      ),
                      const SizedBox(height: 12),
                      _Panel(
                        title: 'Sesión',
                        children: [
                          _Action(
                            label: 'Actualizar datos',
                            icon: Icons.refresh_rounded,
                            onTap: () async {
                              await state.refresh();
                              await _load();
                            },
                          ),
                          _Action(
                            label: 'Cerrar sesión',
                            icon: Icons.logout_rounded,
                            danger: true,
                            onTap: () async {
                              if (await crmConfirm(
                                context,
                                title: 'Cerrar sesión',
                                message:
                                    '¿Quieres salir del CRM en este dispositivo?',
                              )) {
                                await state.logout();
                              }
                            },
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        border: Border.all(color: p.border),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 8),
            child: Text(
              title,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: p.ink,
              ),
            ),
          ),
          for (final child in children) child,
          const SizedBox(height: 4),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 3, 12, 3),
      child: Row(
        children: [
          SizedBox(
            width: 76,
            child: Text(
              label,
              style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
            ),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: p.ink,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({
    required this.label,
    required this.icon,
    required this.onTap,
    this.checked = false,
    this.danger = false,
  });
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final bool checked;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            Icon(icon, size: 17, color: danger ? p.danger : p.primary),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  color: danger ? p.danger : p.ink,
                ),
              ),
            ),
            if (checked) Icon(Icons.check_rounded, size: 17, color: p.primary),
          ],
        ),
      ),
    );
  }
}
