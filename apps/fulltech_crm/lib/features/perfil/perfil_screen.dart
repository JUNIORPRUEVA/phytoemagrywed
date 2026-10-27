import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../common/crm_ui.dart';

/// Mi perfil: identidad, apariencia y salida.
class PerfilScreen extends StatelessWidget {
  const PerfilScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final user = state.session.user;

    return ListView(
      padding: const EdgeInsets.only(bottom: 26),
      children: [
        const CrmPageHeader(title: 'Mi perfil', subtitle: 'Tu cuenta en el CRM'),
        SectionCard(
          child: Column(
            children: [
              CrmAvatar(label: user?.initials ?? 'FT', size: 64),
              const SizedBox(height: 12),
              Text(user?.displayName ?? 'Panel legacy', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(
                user == null ? 'Acceso con el token del panel' : '${user.role.toLowerCase()} · ${user.username}',
                style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                alignment: WrapAlignment.center,
                children: [
                  StatusPill(label: state.session.isAdmin ? 'administrador' : 'agente', dense: true),
                  if (state.session.legacy) const StatusPill(label: 'legacy', dense: true, color: Colors.orange),
                  StatusPill(label: '${state.session.permissions.length} permisos', dense: true, color: p.inkSecondary),
                ],
              ),
            ],
          ),
        ),
        SectionCard(
          title: 'Datos de la sesión',
          child: Column(
            children: [
              _Row(label: 'Usuario', value: user?.username ?? '—'),
              _Row(label: 'Rol', value: user?.role ?? 'ADMIN (legacy)'),
              _Row(label: 'Identificador', value: (user?.id ?? '—')),
              _Row(label: 'Última sincronización', value: state.lastSync == null ? 'Sin sincronizar' : CrmFormat.ago(state.lastSync)),
              _Row(label: 'Datos', value: state.partial ? 'Paquete ligero' : 'Paquete completo'),
            ],
          ),
        ),
        SectionCard(
          title: 'Apariencia',
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final entry in const [
                (ThemeMode.light, 'Claro', Icons.light_mode_outlined),
                (ThemeMode.dark, 'Oscuro', Icons.dark_mode_outlined),
                (ThemeMode.system, 'Auto', Icons.brightness_auto_outlined),
              ])
                ChoiceChip(
                  avatar: Icon(entry.$3, size: 16),
                  label: Text(entry.$2),
                  selected: state.themeMode == entry.$1,
                  onSelected: (_) => state.setThemeMode(entry.$1),
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Column(
            children: [
              CrmButton(
                label: 'Actualizar datos',
                icon: Icons.refresh_rounded,
                filled: false,
                expand: true,
                onPressed: () => state.refresh(),
              ),
              const SizedBox(height: 8),
              CrmButton(
                label: 'Cerrar sesión',
                icon: Icons.logout_rounded,
                tone: p.danger,
                expand: true,
                onPressed: () async {
                  if (await crmConfirm(context, title: 'Cerrar sesión', message: '¿Quieres salir del CRM en este dispositivo?')) {
                    await state.logout();
                  }
                },
              ),
              const SizedBox(height: 16),
              Text(
                'FullTECH CRM · app nativa sobre la misma API del panel web',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11, color: p.inkSecondary),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 150, child: Text(label, style: TextStyle(fontSize: 12.5, color: p.inkSecondary))),
          Expanded(child: Text(value, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.ink))),
        ],
      ),
    );
  }
}

/// Espacio reservado para reutilizar el alto táctil de la casa.
const double kPerfilTouch = CrmSpace.touch;
