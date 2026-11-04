import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Los tres enlaces públicos siguen el mismo origen que el PWA. Las opciones
/// del negocio se leen y guardan en las mismas rutas que usa el chat.
class CompartirScreen extends StatefulWidget {
  const CompartirScreen({super.key, this.manageOnly = false});

  final bool manageOnly;

  @override
  State<CompartirScreen> createState() => _CompartirScreenState();
}

class _CompartirScreenState extends State<CompartirScreen> {
  Map<String, dynamic> _sharing = const {};
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    if (!CrmScope.of(context, listen: false).session.can('chats.reply')) {
      setState(() => _loading = false);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await CrmScope.of(
        context,
        listen: false,
      ).repository.chatSharing();
      if (mounted) setState(() => _sharing = data);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // El PWA usa el origen actual; en la app de pruebas ese origen puede ser
  // 127.0.0.1. Los enlaces destinados a clientes deben ser públicos.
  String _publicUrl(String path) => 'https://phytoemagryrd.lat$path';

  String _locationUrl(Map<String, dynamic> row) =>
      'https://www.google.com/maps?q=${Uri.encodeComponent('${row['latitude']},${row['longitude']}')}';

  Future<void> _copy(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) crmToast(context, 'Enlace copiado');
  }

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null || !{'http', 'https'}.contains(uri.scheme)) return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      crmToast(context, 'No se pudo abrir el enlace');
    }
  }

  Future<void> _edit(String kind, [Map<String, dynamic>? existing]) async {
    final admin = CrmScope.of(context, listen: false).session.isAdmin;
    if (!admin || _saving) return;
    final fields = switch (kind) {
      'locations' => const [
        ('name', 'Nombre'),
        ('address', 'Dirección'),
        ('latitude', 'Latitud'),
        ('longitude', 'Longitud'),
      ],
      'banks' => const [
        ('bank', 'Banco'),
        ('holder', 'Titular'),
        ('number', 'Número de cuenta'),
        ('type', 'Tipo'),
        ('currency', 'Moneda'),
        ('note', 'Nota'),
      ],
      _ => const [
        ('name', 'Nombre'),
        ('url', 'Página web'),
        ('message', 'Texto para compartir'),
      ],
    };
    final controllers = {
      for (final field in fields)
        field.$1: TextEditingController(
          text: str(existing?[field.$1], field.$1 == 'currency' ? 'DOP' : ''),
        ),
    };
    var disposalScheduled = false;
    final edited = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        if (!disposalScheduled) {
          disposalScheduled = true;
          ModalRoute.of(dialogContext)?.completed.then((_) {
            for (final controller in controllers.values) {
              controller.dispose();
            }
          });
        }
        return AlertDialog(
          title: Text(
            existing == null
                ? 'Agregar ${_singular(kind)}'
                : 'Editar ${_singular(kind)}',
          ),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final field in fields)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 9),
                      child: field.$1 == 'currency'
                          ? DropdownButtonFormField<String>(
                              initialValue:
                                  const [
                                    'DOP',
                                    'USD',
                                    'EUR',
                                  ].contains(controllers['currency']!.text)
                                  ? controllers['currency']!.text
                                  : 'DOP',
                              decoration: InputDecoration(
                                labelText: field.$2,
                                isDense: true,
                              ),
                              items: const [
                                DropdownMenuItem(
                                  value: 'DOP',
                                  child: Text('DOP'),
                                ),
                                DropdownMenuItem(
                                  value: 'USD',
                                  child: Text('USD'),
                                ),
                                DropdownMenuItem(
                                  value: 'EUR',
                                  child: Text('EUR'),
                                ),
                              ],
                              onChanged: (value) =>
                                  controllers['currency']!.text =
                                      value ?? 'DOP',
                            )
                          : TextField(
                              controller: controllers[field.$1],
                              keyboardType:
                                  {'latitude', 'longitude'}.contains(field.$1)
                                  ? const TextInputType.numberWithOptions(
                                      decimal: true,
                                      signed: true,
                                    )
                                  : field.$1 == 'url'
                                  ? TextInputType.url
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
                final row = {
                  for (final field in fields)
                    field.$1: controllers[field.$1]!.text.trim(),
                };
                final valid = switch (kind) {
                  'locations' =>
                    row['name']!.isNotEmpty &&
                        double.tryParse(row['latitude']!) != null &&
                        double.tryParse(row['longitude']!) != null &&
                        double.parse(row['latitude']!).abs() <= 90 &&
                        double.parse(row['longitude']!).abs() <= 180,
                  'banks' =>
                    row['bank']!.isNotEmpty &&
                        row['holder']!.isNotEmpty &&
                        row['number']!.isNotEmpty,
                  _ =>
                    row['name']!.isNotEmpty &&
                        Uri.tryParse(row['url']!)?.scheme == 'https' &&
                        (Uri.tryParse(row['url']!)?.hasAuthority ?? false),
                };
                if (!valid) {
                  crmToast(
                    dialogContext,
                    'Revisa los campos obligatorios y el enlace o coordenadas',
                  );
                  return;
                }
                Navigator.pop(dialogContext, {
                  if (existing != null) 'id': existing['id'],
                  ...row,
                });
              },
              child: const Text('Guardar'),
            ),
          ],
        );
      },
    );
    if (edited == null || !mounted) return;
    final rows = listv(_sharing[kind]);
    final index = existing == null
        ? -1
        : rows.indexWhere((row) => str(row['id']) == str(existing['id']));
    if (index < 0) {
      rows.add(edited);
    } else {
      rows[index] = edited;
    }
    await _save(kind, rows);
  }

  Future<void> _delete(String kind, Map<String, dynamic> row) async {
    if (!CrmScope.of(context, listen: false).session.isAdmin) return;
    final confirmed = await crmConfirm(
      context,
      title: 'Quitar ${_singular(kind)}',
      message: 'Esta opción dejará de aparecer al compartir desde el chat.',
    );
    if (!confirmed || !mounted) return;
    await _save(
      kind,
      listv(
        _sharing[kind],
      ).where((item) => str(item['id']) != str(row['id'])).toList(),
    );
  }

  Future<void> _save(String kind, List<Map<String, dynamic>> rows) async {
    setState(() => _saving = true);
    try {
      final next = {
        for (final key in const ['locations', 'banks', 'catalogs'])
          key: key == kind ? rows : listv(_sharing[key]),
      };
      final saved = await CrmScope.of(
        context,
        listen: false,
      ).repository.saveChatSharing(next);
      if (!mounted) return;
      setState(() => _sharing = saved);
      crmToast(context, 'Opciones para compartir guardadas');
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _singular(String kind) => switch (kind) {
    'locations' => 'ubicación',
    'banks' => 'cuenta bancaria',
    _ => 'catálogo',
  };

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final session = CrmScope.of(context).session;
    final admin = session.isAdmin;
    final canReadSharing = session.can('chats.reply');
    final public = [
      (
        'Página PHYTOEMAGRY',
        'Web pública',
        Icons.language_rounded,
        _publicUrl('/'),
      ),
      (
        'Tienda online',
        'Catálogo y pedidos',
        Icons.storefront_outlined,
        _publicUrl('/store/'),
      ),
      (
        'Panel CRM',
        'Acceso con usuario propio',
        Icons.desktop_windows_outlined,
        _publicUrl('/admin/'),
      ),
    ];
    return Column(
      children: [
        if (!widget.manageOnly)
          Container(
            height: 48,
            padding: const EdgeInsets.symmetric(horizontal: 18),
            alignment: Alignment.centerLeft,
            decoration: BoxDecoration(
              color: p.surface,
              border: Border(bottom: BorderSide(color: p.border)),
            ),
            child: Text(
              'Compartir',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w800,
                color: p.ink,
              ),
            ),
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, limits) => ListView(
              padding: const EdgeInsets.fromLTRB(18, 15, 18, 26),
              children: [
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 900),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (!widget.manageOnly) ...[
                          _GroupTitle(
                            label: 'Enlaces',
                            hint:
                                'Solo se comparte el enlace, nunca una clave.',
                          ),
                          LayoutBuilder(
                            builder: (context, box) {
                              final columns = box.maxWidth >= 680
                                  ? 3
                                  : box.maxWidth >= 440
                                  ? 2
                                  : 1;
                              final width =
                                  (box.maxWidth - (columns - 1) * 8) / columns;
                              return Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final link in public)
                                    SizedBox(
                                      width: width,
                                      child: _LinkTile(
                                        title: link.$1,
                                        subtitle: link.$2,
                                        icon: link.$3,
                                        onCopy: () => _copy(link.$4),
                                        onOpen: () => _open(link.$4),
                                      ),
                                    ),
                                ],
                              );
                            },
                          ),
                          const SizedBox(height: 20),
                        ],
                        if (canReadSharing)
                          _GroupTitle(
                            label: 'Opciones del negocio',
                            hint: admin
                                ? 'Disponibles también en el chat · administración puede editarlas.'
                                : 'Datos guardados por administración para compartir en el chat.',
                          ),
                        if (canReadSharing && _loading)
                          const Center(
                            child: Padding(
                              padding: EdgeInsets.all(24),
                              child: CircularProgressIndicator(),
                            ),
                          )
                        else if (canReadSharing && _error != null)
                          TextButton.icon(
                            onPressed: _load,
                            icon: const Icon(Icons.refresh_rounded),
                            label: Text(_error!),
                          )
                        else if (canReadSharing)
                          for (final group in const [
                            ('locations', 'Ubicaciones', Icons.place_outlined),
                            (
                              'banks',
                              'Cuentas bancarias',
                              Icons.account_balance_outlined,
                            ),
                            (
                              'catalogs',
                              'Catálogos y páginas',
                              Icons.menu_book_outlined,
                            ),
                          ]) ...[
                            const SizedBox(height: 10),
                            Row(
                              children: [
                                Icon(group.$3, size: 17, color: p.primary),
                                const SizedBox(width: 7),
                                Expanded(
                                  child: Text(
                                    group.$2,
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: p.ink,
                                    ),
                                  ),
                                ),
                                if (admin)
                                  TextButton.icon(
                                    onPressed:
                                        _saving ||
                                            listv(_sharing[group.$1]).length >=
                                                10
                                        ? null
                                        : () => _edit(group.$1),
                                    icon: const Icon(
                                      Icons.add_rounded,
                                      size: 17,
                                    ),
                                    label: const Text('Agregar'),
                                  ),
                              ],
                            ),
                            if (listv(_sharing[group.$1]).isEmpty)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  24,
                                  4,
                                  0,
                                  10,
                                ),
                                child: Text(
                                  'Sin opciones guardadas',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: p.inkSecondary,
                                  ),
                                ),
                              )
                            else
                              for (final row in listv(_sharing[group.$1]))
                                _SavedTile(
                                  kind: group.$1,
                                  row: row,
                                  admin: admin,
                                  onCopy: () => _copy(
                                    group.$1 == 'locations'
                                        ? _locationUrl(row)
                                        : str(
                                            row[group.$1 == 'banks'
                                                ? 'number'
                                                : 'url'],
                                          ),
                                  ),
                                  onOpen: group.$1 == 'catalogs'
                                      ? () => _open(str(row['url']))
                                      : group.$1 == 'locations'
                                      ? () => _open(_locationUrl(row))
                                      : null,
                                  onEdit: () => _edit(group.$1, row),
                                  onDelete: () => _delete(group.$1, row),
                                ),
                          ],
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
  }
}

class _GroupTitle extends StatelessWidget {
  const _GroupTitle({required this.label, required this.hint});
  final String label;
  final String hint;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w800,
              color: p.ink,
            ),
          ),
          Text(hint, style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
        ],
      ),
    );
  }
}

class _LinkTile extends StatelessWidget {
  const _LinkTile({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.onCopy,
    required this.onOpen,
  });
  final String title;
  final String subtitle;
  final IconData icon;
  final VoidCallback onCopy;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      height: 84,
      padding: const EdgeInsets.fromLTRB(11, 9, 5, 9),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border.all(color: p.border),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: p.primarySoft,
              borderRadius: BorderRadius.circular(7),
            ),
            child: Icon(icon, size: 17, color: p.primary),
          ),
          const SizedBox(width: 8),
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
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: p.inkSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Copiar enlace',
            onPressed: onCopy,
            icon: const Icon(Icons.copy_rounded, size: 17),
            visualDensity: VisualDensity.compact,
          ),
          IconButton(
            tooltip: 'Abrir',
            onPressed: onOpen,
            icon: const Icon(Icons.open_in_new_rounded, size: 17),
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}

class _SavedTile extends StatelessWidget {
  const _SavedTile({
    required this.kind,
    required this.row,
    required this.admin,
    required this.onCopy,
    required this.onOpen,
    required this.onEdit,
    required this.onDelete,
  });
  final String kind;
  final Map<String, dynamic> row;
  final bool admin;
  final VoidCallback onCopy;
  final VoidCallback? onOpen;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final name = str(row[kind == 'banks' ? 'bank' : 'name']);
    final detail = kind == 'banks'
        ? '${str(row['holder'])} · ${str(row['number'])}'
        : kind == 'locations'
        ? str(row['address'])
        : str(row['url']);
    return Container(
      constraints: const BoxConstraints(minHeight: 52),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: p.border)),
      ),
      child: Row(
        children: [
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
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
                  detail,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Copiar',
            onPressed: onCopy,
            icon: const Icon(Icons.copy_rounded, size: 16),
            visualDensity: VisualDensity.compact,
          ),
          if (onOpen != null)
            IconButton(
              tooltip: 'Abrir',
              onPressed: onOpen,
              icon: const Icon(Icons.open_in_new_rounded, size: 16),
              visualDensity: VisualDensity.compact,
            ),
          if (admin) ...[
            IconButton(
              tooltip: 'Editar',
              onPressed: onEdit,
              icon: const Icon(Icons.edit_outlined, size: 16),
              visualDensity: VisualDensity.compact,
            ),
            IconButton(
              tooltip: 'Quitar',
              onPressed: onDelete,
              icon: Icon(Icons.close_rounded, size: 16, color: p.danger),
              visualDensity: VisualDensity.compact,
            ),
          ],
        ],
      ),
    );
  }
}
