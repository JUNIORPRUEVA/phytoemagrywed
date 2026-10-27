import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Configuración: ajustes del negocio, apariencia y auditoría reciente.
class AjustesScreen extends StatelessWidget {
  const AjustesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Configuración', subtitle: 'Ajustes del negocio y de la app'),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(top: 4, bottom: 26),
            children: [
              SectionCard(
                title: 'Apariencia',
                child: Column(
                  children: [
                    for (final entry in const [
                      (ThemeMode.light, 'Claro', Icons.light_mode_outlined),
                      (ThemeMode.dark, 'Oscuro', Icons.dark_mode_outlined),
                      (ThemeMode.system, 'Como el teléfono', Icons.brightness_auto_outlined),
                    ])
                      ListTile(
                        onTap: () => state.setThemeMode(entry.$1),
                        leading: Icon(entry.$3, size: 20, color: p.inkSecondary),
                        title: Text(entry.$2, style: TextStyle(fontSize: 13.5, color: p.ink)),
                        trailing: state.themeMode == entry.$1
                            ? Icon(Icons.check_circle_rounded, size: 20, color: p.primary)
                            : Icon(Icons.circle_outlined, size: 20, color: p.border),
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                      ),
                  ],
                ),
              ),
              SectionCard(
                title: 'Seguimiento',
                child: Row(
                  children: [
                    Icon(Icons.event_repeat_outlined, size: 18, color: p.primary),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        boolv(state.snapshot['settings'] is Map ? mapv(state.snapshot['settings'])['followup'] : false)
                            ? 'El agente de seguimiento está activo.'
                            : 'El agente de seguimiento está apagado.',
                        style: TextStyle(fontSize: 13, color: p.ink),
                      ),
                    ),
                  ],
                ),
              ),
              _BusinessSettings(state: state),
              _AuditCard(state: state),
              SectionCard(
                title: 'Sesión',
                child: Column(
                  children: [
                    CrmListTile(
                      title: state.session.user?.displayName ?? 'Panel legacy',
                      subtitle: '${state.session.user?.role ?? 'ADMIN'} · ${state.session.user?.username ?? 'token del panel'}',
                      leading: CrmAvatar(label: state.session.user?.initials ?? 'FT'),
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
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _BusinessSettings extends StatelessWidget {
  const _BusinessSettings({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final repo = state.repository;
    return RemoteLoader<Map<String, dynamic>>(
      load: repo.settings,
      loadingLabel: 'Cargando ajustes',
      builder: (context, data, reload) => SectionCard(
        title: 'Ajustes del negocio',
        child: data.isEmpty
            ? Text('El servidor no devolvió ajustes.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
            : KeyValueList(data: data, skipKeys: const ['ok', 'followup']),
      ),
    );
  }
}

class _AuditCard extends StatelessWidget {
  const _AuditCard({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final repo = state.repository;
    return RemoteLoader<List<Map<String, dynamic>>>(
      load: repo.audit,
      loadingLabel: 'Cargando auditoría',
      builder: (context, rows, reload) => SectionCard(
        title: 'Auditoría reciente',
        trailing: Text('${rows.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
        child: rows.isEmpty
            ? Text('Sin eventos recientes.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
            : Column(
                children: [
                  for (final row in rows.take(12))
                    CrmListTile(
                      title: str(row['summary'], str(row['action'], 'Evento')),
                      subtitle: [str(row['entity'], ''), CrmFormat.ago(row['created_at'] ?? row['at'])].where((part) => part.isNotEmpty).join(' · '),
                      leading: CrmAvatar(label: 'A', icon: Icons.history_rounded),
                    ),
                ],
              ),
      ),
    );
  }
}
