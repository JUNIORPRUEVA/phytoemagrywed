import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/crm_repository.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';
import '../compartir/compartir_screen.dart';

/// Entrada compacta: cada ajuste se abre por separado, siguiendo la agrupación
/// del PWA. Las opciones del negocio solo aparecen a administración.
class AjustesScreen extends StatefulWidget {
  const AjustesScreen({super.key});

  @override
  State<AjustesScreen> createState() => _AjustesScreenState();
}

class _AjustesScreenState extends State<AjustesScreen> {
  String? _section;

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final admin = state.session.isAdmin;
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
              if (_section != null)
                IconButton(
                  tooltip: 'Volver a Configuración',
                  onPressed: () => setState(() => _section = null),
                  icon: const Icon(Icons.arrow_back_rounded, size: 19),
                  visualDensity: VisualDensity.compact,
                ),
              Text(
                _section ?? 'Configuración',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                  color: p.ink,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: _section == 'Opciones para compartir'
              ? const CompartirScreen(manageOnly: true)
              : LayoutBuilder(
                  builder: (context, limits) => ListView(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                    children: [
                      Center(
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: _section == null ? 900 : 680,
                          ),
                          child: _section == null
                              ? _home(context, state, admin)
                              : _detail(context, state),
                        ),
                      ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }

  Widget _home(BuildContext context, CrmState state, bool admin) {
    return LayoutBuilder(
      builder: (context, limits) {
        final columns = limits.maxWidth >= 660 ? 2 : 1;
        final width = (limits.maxWidth - (columns - 1) * 10) / columns;
        final entries = <(String, String, IconData, String)>[
          (
            'Apariencia',
            'Tema claro, oscuro o del sistema',
            Icons.palette_outlined,
            'En este dispositivo',
          ),
          if (admin) ...[
            (
              'Inteligencia artificial',
              'Clave, estado y consumo',
              Icons.auto_awesome_outlined,
              'Tu negocio',
            ),
            (
              'Opciones para compartir',
              'Ubicaciones, cuentas y catálogos',
              Icons.ios_share_outlined,
              'Tu negocio',
            ),
            (
              'Seguimiento',
              'Estado del agente postventa',
              Icons.event_repeat_outlined,
              'Tu negocio',
            ),
            (
              'Datos del negocio',
              'Ajustes guardados en el servidor',
              Icons.storefront_outlined,
              'Tu negocio',
            ),
            (
              'Actividad reciente',
              'Movimientos del equipo',
              Icons.history_rounded,
              'Información y datos',
            ),
          ],
        ];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _SettingsGroupTitle('En este dispositivo'),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                for (final entry in entries.where(
                  (e) => e.$4 == 'En este dispositivo',
                ))
                  SizedBox(
                    width: width,
                    child: _SettingsRow(
                      title: entry.$1,
                      detail: entry.$2,
                      icon: entry.$3,
                      onTap: () => setState(() => _section = entry.$1),
                    ),
                  ),
              ],
            ),
            if (admin) ...[
              const SizedBox(height: 16),
              _SettingsGroupTitle('Tu negocio'),
              Wrap(
                spacing: 10,
                runSpacing: 8,
                children: [
                  for (final entry in entries.where(
                    (e) => e.$4 == 'Tu negocio',
                  ))
                    SizedBox(
                      width: width,
                      child: _SettingsRow(
                        title: entry.$1,
                        detail: entry.$2,
                        icon: entry.$3,
                        onTap: () => setState(() => _section = entry.$1),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 16),
              _SettingsGroupTitle('Información y datos'),
              Wrap(
                spacing: 10,
                runSpacing: 8,
                children: [
                  for (final entry in entries.where(
                    (e) => e.$4 == 'Información y datos',
                  ))
                    SizedBox(
                      width: width,
                      child: _SettingsRow(
                        title: entry.$1,
                        detail: entry.$2,
                        icon: entry.$3,
                        onTap: () => setState(() => _section = entry.$1),
                      ),
                    ),
                ],
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _detail(BuildContext context, CrmState state) {
    final p = context.crm;
    return switch (_section) {
      'Apariencia' => Column(
        children: [
          for (final entry in const [
            (ThemeMode.light, 'Claro', Icons.light_mode_outlined),
            (ThemeMode.dark, 'Oscuro', Icons.dark_mode_outlined),
            (
              ThemeMode.system,
              'Usar tema del sistema',
              Icons.brightness_auto_outlined,
            ),
          ])
            _SettingsRow(
              title: entry.$2,
              detail: '',
              icon: entry.$3,
              selected: state.themeMode == entry.$1,
              onTap: () => state.setThemeMode(entry.$1),
            ),
        ],
      ),
      'Inteligencia artificial' => _AiSettings(state: state),
      'Seguimiento' => _FollowupSettings(state: state),
      'Datos del negocio' => _BusinessSettings(state: state),
      'Actividad reciente' => _AuditCard(state: state),
      _ => Text(
        'No hay opciones para mostrar.',
        style: TextStyle(color: p.inkSecondary),
      ),
    };
  }
}

class _SettingsGroupTitle extends StatelessWidget {
  const _SettingsGroupTitle(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 7),
    child: Text(
      label,
      style: TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w800,
        color: context.crm.inkSecondary,
      ),
    ),
  );
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.title,
    required this.detail,
    required this.icon,
    required this.onTap,
    this.selected = false,
  });
  final String title;
  final String detail;
  final IconData icon;
  final VoidCallback? onTap;
  final bool selected;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Material(
      color: selected ? p.primarySoft : p.surface,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 58,
          padding: const EdgeInsets.symmetric(horizontal: 11),
          decoration: BoxDecoration(
            border: Border.all(
              color: selected ? p.primary.withValues(alpha: 0.35) : p.border,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(icon, size: 19, color: p.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: p.ink,
                      ),
                    ),
                    if (detail.isNotEmpty)
                      Text(
                        detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11, color: p.inkSecondary),
                      ),
                  ],
                ),
              ),
              Icon(
                selected
                    ? Icons.check_circle_rounded
                    : Icons.chevron_right_rounded,
                size: 18,
                color: selected ? p.primary : p.inkSecondary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BusinessSettings extends StatelessWidget {
  const _BusinessSettings({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _SettingsRow(
          title: 'Clientes',
          detail: state.customersComplete
              ? '${state.customers.length} cargados'
              : 'Lista parcial · abre Clientes para completar',
          icon: Icons.people_outline_rounded,
          onTap: null,
        ),
        const SizedBox(height: 8),
        _SettingsRow(
          title: 'Pedidos',
          detail: state.partial
              ? '${state.orders.length} en el paquete ligero'
              : '${state.orders.length} cargados',
          icon: Icons.receipt_long_outlined,
          onTap: null,
        ),
        const SizedBox(height: 8),
        _SettingsRow(
          title: 'Última sincronización',
          detail: state.lastSync == null
              ? 'Aún no se ha sincronizado'
              : CrmFormat.ago(state.lastSync),
          icon: Icons.sync_rounded,
          onTap: null,
        ),
        const SizedBox(height: 8),
        _SettingsRow(
          title: 'Actualizar datos',
          detail: state.offline
              ? 'Sin conexión · se muestran datos guardados'
              : 'Volver a consultar el servidor',
          icon: Icons.refresh_rounded,
          onTap: () => state.refresh(),
        ),
      ],
    );
  }
}

class _FollowupSettings extends StatefulWidget {
  const _FollowupSettings({required this.state});
  final CrmState state;
  @override
  State<_FollowupSettings> createState() => _FollowupSettingsState();
}

class _FollowupSettingsState extends State<_FollowupSettings> {
  bool _busy = false;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return RemoteLoader<Map<String, dynamic>>(
      load: widget.state.repository.settings,
      loadingLabel: 'Cargando seguimiento',
      builder: (context, data, reload) {
        final plan = listv(data['plan']);
        final enabled = mapv(mapv(data['followup'])['enabled']);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                'Elige los días en que se crean tareas tras entregar una compra. Las tareas existentes se conservan.',
                style: TextStyle(fontSize: 12, color: p.inkSecondary),
              ),
            ),
            for (final entry in plan)
              SwitchListTile(
                dense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 9),
                title: Text(
                  'Día ${entry['day']}',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: p.ink,
                  ),
                ),
                subtitle: Text(
                  str(entry['reason'], str(entry['type'])),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                ),
                value: enabled[str(entry['key'])] != false,
                onChanged: _busy
                    ? null
                    : (value) async {
                        setState(() => _busy = true);
                        try {
                          final next = {
                            for (final row in plan)
                              str(row['key']):
                                  enabled[str(row['key'])] != false,
                            str(entry['key']): value,
                          };
                          await widget.state.repository.saveFollowupSettings(
                            next,
                          );
                          if (context.mounted) {
                            reload();
                            crmToast(context, 'Seguimiento actualizado');
                          }
                        } on ApiException catch (error) {
                          if (context.mounted) crmToast(context, error.message);
                        } finally {
                          if (mounted) setState(() => _busy = false);
                        }
                      },
              ),
            if (plan.isEmpty)
              Text(
                'No hay días configurados.',
                style: TextStyle(fontSize: 12, color: p.inkSecondary),
              ),
          ],
        );
      },
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
        trailing: Text(
          '${rows.length}',
          style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
        ),
        child: rows.isEmpty
            ? Text(
                'Sin eventos recientes.',
                style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
              )
            : Column(
                children: [
                  for (final row in rows.take(12))
                    CrmListTile(
                      title: str(row['summary'], str(row['action'], 'Evento')),
                      subtitle: [
                        str(row['entity'], ''),
                        CrmFormat.ago(row['created_at'] ?? row['at']),
                      ].where((part) => part.isNotEmpty).join(' · '),
                      leading: CrmAvatar(
                        label: 'A',
                        icon: Icons.history_rounded,
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

/*
 * IA DEL CHAT (solo administración).
 *
 * Es la MISMA configuración del panel: se guarda en el servidor y la corrección
 * del chat la usa sin importar desde dónde se haya escrito la clave. Aquí solo se
 * ve el estado y se cambia la clave; el valor guardado nunca se devuelve.
 */
class _AiSettings extends StatelessWidget {
  const _AiSettings({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final repo = state.repository;
    return RemoteLoader<Map<String, dynamic>>(
      load: repo.deepseekStatus,
      loadingLabel: 'Cargando la IA',
      builder: (context, data, reload) {
        final configured = data['configured'] == true;
        final enabled = data['enabled'] == true;
        final model = str(data['model'], 'deepseek-flash');
        final limit = data['dailyLimit'] is num
            ? (data['dailyLimit'] as num).toInt()
            : null;
        final used = data['usedToday'] is num
            ? (data['usedToday'] as num).toInt()
            : 0;
        final estado = !configured
            ? 'Sin clave'
            : (enabled ? 'Activa' : 'Apagada');
        return SectionCard(
          title: 'Inteligencia artificial',
          trailing: Text(
            estado,
            style: TextStyle(
              fontSize: 11.5,
              color: configured && enabled ? p.primary : p.inkSecondary,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Corrige ortografía, tildes y puntuación de tus mensajes mientras escribes. '
                'La clave se guarda cifrada en el servidor: aquí solo se ve si está puesta, nunca el valor.',
                style: TextStyle(
                  fontSize: 12.5,
                  color: p.inkSecondary,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 12),
              _AiRow(label: 'Modelo', value: model),
              _AiRow(
                label: 'Clave',
                value: configured ? 'Guardada' : 'Sin configurar',
              ),
              if (limit != null)
                _AiRow(label: 'Uso de hoy', value: '$used de $limit llamadas'),
              const SizedBox(height: 12),
              CrmButton(
                label: configured
                    ? 'Cambiar la clave de la IA'
                    : 'Configurar la clave de la IA',
                icon: Icons.key_rounded,
                expand: true,
                onPressed: () async {
                  final changed = await showDialog<bool>(
                    context: context,
                    builder: (_) => _DeepseekDialog(
                      repository: repo,
                      configured: configured,
                      enabled: enabled,
                      dailyLimit: limit,
                    ),
                  );
                  if (changed == true) reload();
                },
              ),
              if (configured) ...[
                const SizedBox(height: 8),
                CrmButton(
                  label: 'Probar conexión',
                  icon: Icons.task_alt_rounded,
                  filled: false,
                  expand: true,
                  onPressed: () async {
                    try {
                      final ok = await repo.testDeepseek();
                      if (!context.mounted) return;
                      crmToast(
                        context,
                        ok
                            ? 'La IA responde correctamente.'
                            : 'La IA no respondió. Revisa la clave y el saldo del proveedor.',
                      );
                    } on ApiException catch (error) {
                      if (context.mounted) crmToast(context, error.message);
                    }
                  },
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _AiRow extends StatelessWidget {
  const _AiRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(
              label,
              style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: 12.5,
                color: p.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Formulario de la clave. Un solo envío por vez y el error se queda a la vista.
class _DeepseekDialog extends StatefulWidget {
  const _DeepseekDialog({
    required this.repository,
    required this.configured,
    required this.enabled,
    required this.dailyLimit,
  });

  final CrmRepository repository;
  final bool configured;
  final bool enabled;
  final int? dailyLimit;

  @override
  State<_DeepseekDialog> createState() => _DeepseekDialogState();
}

class _DeepseekDialogState extends State<_DeepseekDialog> {
  late final TextEditingController _key;
  late final TextEditingController _limit;
  late bool _enabled;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _key = TextEditingController();
    _limit = TextEditingController(text: widget.dailyLimit?.toString() ?? '');
    _enabled = widget.enabled;
  }

  @override
  void dispose() {
    _key.dispose();
    _limit.dispose();
    super.dispose();
  }

  Future<void> _guardar({bool removeKey = false}) async {
    if (_busy) return;
    final clave = removeKey ? '' : _key.text.trim();
    if (!removeKey && !widget.configured && clave.isEmpty) {
      setState(() => _error = 'Escribe la clave API del proveedor.');
      return;
    }
    final limite = int.tryParse(_limit.text.trim());
    if (limite != null && (limite < 1 || limite > 2000)) {
      setState(() => _error = 'El límite diario debe estar entre 1 y 2000.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.repository.saveDeepseek(
        enabled: removeKey ? false : _enabled,
        apiKey: clave,
        dailyLimit: limite,
        removeKey: removeKey,
      );
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.message.isEmpty ? 'No se pudo guardar.' : error.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return AlertDialog(
      title: Text(widget.configured ? 'Clave de la IA' : 'Configurar la IA'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Se guarda cifrada en el servidor y no se puede volver a ver. '
                'Solo administración puede cambiarla.',
                style: TextStyle(
                  fontSize: 12.5,
                  color: p.inkSecondary,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 14),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _enabled,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _enabled = value),
                title: Text(
                  'Corregir con IA mientras escribo',
                  style: TextStyle(fontSize: 13.5, color: p.ink),
                ),
                subtitle: Text(
                  'Si la apagas, queda solo el diccionario local.',
                  style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                ),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _key,
                enabled: !_busy,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  labelText: widget.configured
                      ? 'Clave nueva (opcional)'
                      : 'Clave API',
                  hintText: 'sk-…',
                  helperText: widget.configured
                      ? 'Déjala vacía para conservar la actual.'
                      : null,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _limit,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Límite de llamadas al día',
                  helperText: 'Vacío usa el valor del servidor.',
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: TextStyle(fontSize: 12.5, color: p.danger),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (widget.configured)
          TextButton(
            onPressed: _busy ? null : () => _guardar(removeKey: true),
            style: TextButton.styleFrom(foregroundColor: p.danger),
            child: const Text('Quitar clave'),
          ),
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context, false),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: _busy ? null : () => _guardar(),
          child: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Guardar'),
        ),
      ],
    );
  }
}
