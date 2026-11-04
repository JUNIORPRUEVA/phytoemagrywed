import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Repartidores: solicitudes de ingreso, revisión del expediente y documentos.
class RepartidoresScreen extends StatefulWidget {
  const RepartidoresScreen({super.key});

  @override
  State<RepartidoresScreen> createState() => _RepartidoresScreenState();
}

class _RepartidoresScreenState extends State<RepartidoresScreen> {
  int _reloadToken = 0;
  bool _showAccounts = true;
  Future<List<Map<String, dynamic>>>? _accountsFuture;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accountsFuture ??= CrmScope.of(
      context,
      listen: false,
    ).repository.phytoCourierAccounts();
  }

  void _reload() {
    setState(() {
      _reloadToken++;
      _accountsFuture = CrmScope.of(
        context,
        listen: false,
      ).repository.phytoCourierAccounts();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final session = state.session;

    return Column(
      children: [
        Container(
          height: 42,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Text(
                'Repartidores',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: p.ink,
                ),
              ),
              const Spacer(),
              if (session.isAdmin)
                IconButton(
                  tooltip: 'Autorizar repartidor externo',
                  onPressed: _createExternalCourier,
                  icon: const Icon(Icons.person_add_alt_1_outlined, size: 19),
                ),
              IconButton(
                tooltip: 'Actualizar',
                onPressed: _reload,
                icon: const Icon(Icons.refresh_rounded, size: 19),
              ),
            ],
          ),
        ),
        Expanded(
          child: RemoteLoader<List<Map<String, dynamic>>>(
            key: ValueKey(_reloadToken),
            load: state.repository.courierApplications,
            loadingLabel: 'Cargando repartidores',
            builder: (context, rows, reload) {
              final pending = rows
                  .where(
                    (row) => !const {
                      'approved',
                      'rejected',
                    }.contains(str(row['status'])),
                  )
                  .toList();
              return Column(
                children: [
                  Container(
                    height: 38,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                      color: p.surface,
                      border: Border(bottom: BorderSide(color: p.border)),
                    ),
                    child: Row(
                      children: [
                        TextButton(
                          onPressed: () => setState(() => _showAccounts = true),
                          child: Text(
                            'Cuentas',
                            style: TextStyle(
                              color: _showAccounts ? p.primary : p.inkSecondary,
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: () =>
                              setState(() => _showAccounts = false),
                          child: Text(
                            'Solicitudes · ${pending.length} por revisar',
                            style: TextStyle(
                              color: !_showAccounts
                                  ? p.primary
                                  : p.inkSecondary,
                            ),
                          ),
                        ),
                        const Spacer(),
                        Text(
                          '${state.deliveryTracking.where((row) => row.status.toUpperCase() == 'ACTIVE').length} en ruta',
                          style: TextStyle(fontSize: 11, color: p.inkSecondary),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: _showAccounts
                        ? FutureBuilder<List<Map<String, dynamic>>>(
                            future: _accountsFuture,
                            builder: (context, snapshot) {
                              if (snapshot.hasError)
                                return Center(
                                  child: Text(
                                    'No se pudieron cargar las cuentas.',
                                    style: TextStyle(color: p.warning),
                                  ),
                                );
                              if (!snapshot.hasData)
                                return const Center(
                                  child: CircularProgressIndicator(),
                                );
                              final accounts = snapshot.data!;
                              if (accounts.isEmpty)
                                return Center(
                                  child: Text(
                                    'No hay cuentas de reparto.',
                                    style: TextStyle(color: p.inkSecondary),
                                  ),
                                );
                              return ListView.builder(
                                itemCount: accounts.length,
                                itemBuilder: (context, index) {
                                  final row = accounts[index];
                                  return ListTile(
                                    dense: true,
                                    visualDensity: const VisualDensity(
                                      vertical: -2,
                                    ),
                                    leading: Icon(
                                      Icons.delivery_dining_outlined,
                                      size: 20,
                                      color: p.primary,
                                    ),
                                    title: Text(
                                      str(row['display_name'], 'Repartidor'),
                                      style: TextStyle(
                                        fontSize: 12.5,
                                        fontWeight: FontWeight.w700,
                                        color: p.ink,
                                      ),
                                    ),
                                    subtitle: Text(
                                      [
                                            str(row['kind']) == 'INTERNAL'
                                                ? 'Equipo'
                                                : 'Externo',
                                            str(row['phone']),
                                            row['app_access'] == true
                                                ? 'Con acceso'
                                                : 'Sin acceso',
                                          ]
                                          .where((part) => part.isNotEmpty)
                                          .join(' · '),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 11.5,
                                        color: p.inkSecondary,
                                      ),
                                    ),
                                    trailing: StatusPill(
                                      label: row['active'] == true
                                          ? 'Activa'
                                          : 'Inactiva',
                                      dense: true,
                                    ),
                                  );
                                },
                              );
                            },
                          )
                        : rows.isEmpty
                        ? Center(
                            child: Text(
                              'No hay solicitudes.',
                              style: TextStyle(color: p.inkSecondary),
                            ),
                          )
                        : ListView.builder(
                            itemCount: rows.length,
                            itemBuilder: (context, index) => _ApplicationTile(
                              row: rows[index],
                              onOpen: () =>
                                  _openApplication(rows[index], reload),
                            ),
                          ),
                  ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Future<void> _createExternalCourier() async {
    final name = TextEditingController();
    final phone = TextEditingController();
    final pin = TextEditingController();
    var busy = false;
    String? error;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, update) => AlertDialog(
          title: const Text('Autorizar repartidor externo'),
          content: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 460,
              maxHeight: MediaQuery.sizeOf(dialogContext).height * 0.65,
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Se creará su contacto de reparto y su acceso a FULLTECH Delivery.',
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: name,
                    decoration: const InputDecoration(
                      labelText: 'Nombre completo',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: phone,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Teléfono',
                      hintText: '+18095551234',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: pin,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'PIN de acceso',
                      helperText: 'Entre 6 y 64 caracteres',
                    ),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    Text(error!, style: TextStyle(color: context.crm.danger)),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(dialogContext),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      final digits = phone.text.replaceAll(RegExp(r'\D'), '');
                      if (name.text.trim().isEmpty ||
                          digits.length < 10 ||
                          digits.length > 15 ||
                          pin.text.length < 6 ||
                          pin.text.length > 64) {
                        update(
                          () => error =
                              'Completa el nombre, un teléfono válido y un PIN de 6 a 64 caracteres.',
                        );
                        return;
                      }
                      update(() {
                        busy = true;
                        error = null;
                      });
                      try {
                        await CrmScope.of(
                          context,
                          listen: false,
                        ).repository.createExternalCourier(
                          name: name.text.trim(),
                          phone: phone.text.trim(),
                          pin: pin.text,
                        );
                        if (!dialogContext.mounted) return;
                        Navigator.pop(dialogContext);
                        if (mounted) {
                          _reload();
                          crmToast(
                            context,
                            'Repartidor autorizado. Ya puede entrar con su teléfono y PIN.',
                          );
                        }
                      } on ApiException catch (failure) {
                        if (dialogContext.mounted)
                          update(() {
                            error = failure.message;
                            busy = false;
                          });
                      }
                    },
              child: Text(busy ? 'Guardando…' : 'Autorizar'),
            ),
          ],
        ),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));
    name.dispose();
    phone.dispose();
    pin.dispose();
  }

  Future<void> _openApplication(
    Map<String, dynamic> row,
    VoidCallback reload,
  ) async {
    final state = CrmScope.of(context, listen: false);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.78,
        maxChildSize: 0.94,
        builder: (sheetContext, controller) => _ApplicationSheet(
          application: row,
          scrollController: controller,
          onChanged: () {
            reload();
            state.refresh(quiet: true);
          },
        ),
      ),
    );
  }
}

class _ApplicationTile extends StatelessWidget {
  const _ApplicationTile({required this.row, required this.onOpen});

  final Map<String, dynamic> row;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final status = str(row['status'], 'pending');
    final name = str(
      row['full_name'],
      str(row['name'], str(row['phone'], 'Repartidor')),
    );
    return ListTile(
      dense: true,
      visualDensity: const VisualDensity(vertical: -2),
      title: Text(
        name,
        style: TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
          color: p.ink,
        ),
      ),
      subtitle: Text(
        [
          if (str(row['phone']).isNotEmpty) str(row['phone']),
          if (str(row['vehicle_type']).isNotEmpty) str(row['vehicle_type']),
          CrmFormat.ago(row['created_at']),
        ].join(' · '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
      ),
      leading: Icon(Icons.delivery_dining_outlined, size: 20, color: p.primary),
      trailing: StatusPill(
        label: status,
        dense: true,
        color: status == 'approved'
            ? p.success
            : (status == 'rejected' ? p.danger : null),
      ),
      onTap: onOpen,
    );
  }
}

/// Expediente: datos, decisión de la solicitud y revisión documento a documento.
class _ApplicationSheet extends StatefulWidget {
  const _ApplicationSheet({
    required this.application,
    required this.scrollController,
    required this.onChanged,
  });

  final Map<String, dynamic> application;
  final ScrollController scrollController;
  final VoidCallback onChanged;

  @override
  State<_ApplicationSheet> createState() => _ApplicationSheetState();
}

class _ApplicationSheetState extends State<_ApplicationSheet> {
  Map<String, dynamic>? _documents;
  bool _loading = true;
  bool _busy = false;
  String? _error;

  String get _applicationId => str(widget.application['id']);
  String get _companyId => str(widget.application['company_id']);
  String get _status => str(widget.application['status'], 'pending');

  @override
  void initState() {
    super.initState();
    _loadDocuments();
  }

  Future<void> _loadDocuments() async {
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await repo.courierDocuments(_applicationId);
      if (!mounted) return;
      setState(() {
        _documents = data;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<void> _decide(String decision) async {
    if (_busy) return;
    final label = decision == 'approved'
        ? 'Aprobar'
        : decision == 'rejected'
        ? 'Rechazar'
        : 'Pedir información';
    String? note;
    if (decision != 'approved') {
      final controller = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(label),
          content: TextField(
            controller: controller,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Motivo (obligatorio)',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Enviar'),
            ),
          ],
        ),
      );
      note = controller.text.trim();
      controller.dispose();
      if (confirmed != true) return;
      if (note.isEmpty) {
        if (mounted) crmToast(context, 'Escribe el motivo.');
        return;
      }
    } else {
      final confirmed = await crmConfirm(
        context,
        title: 'Aprobar solicitud',
        message:
            'El repartidor quedará aprobado. Los documentos se revisan por separado.',
        confirmLabel: 'Aprobar',
      );
      if (!confirmed) return;
    }
    if (!mounted) return;
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() => _busy = true);
    try {
      await repo.reviewCourierApplication(
        _applicationId,
        decision: decision,
        companyId: _companyId,
        note: note,
      );
      if (!mounted) return;
      crmToast(context, 'Solicitud: $label.');
      widget.onChanged();
      Navigator.pop(context);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openDocument(Map<String, dynamic> document) async {
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      final file = await repo.courierDocumentFile(str(document['id']));
      await FileOpener.saveAndOpen(file);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  Future<void> _reviewDocument(Map<String, dynamic> document) async {
    final decision = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.check_circle_outline_rounded),
              title: const Text('Aceptar'),
              onTap: () => Navigator.pop(sheetContext, 'accepted'),
            ),
            ListTile(
              leading: const Icon(Icons.cancel_outlined),
              title: const Text('Rechazar'),
              onTap: () => Navigator.pop(sheetContext, 'rejected'),
            ),
            ListTile(
              leading: const Icon(Icons.upload_file_outlined),
              title: const Text('Pedir otro'),
              onTap: () => Navigator.pop(sheetContext, 'replacement'),
            ),
          ],
        ),
      ),
    );
    if (decision == null || !mounted) return;
    String? note;
    if (decision != 'accepted') {
      final controller = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Motivo'),
          content: TextField(
            controller: controller,
            maxLines: 2,
            decoration: const InputDecoration(labelText: 'Explica qué falta'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Guardar'),
            ),
          ],
        ),
      );
      note = controller.text.trim();
      controller.dispose();
      if (confirmed != true) return;
      if (note.isEmpty) {
        if (mounted) crmToast(context, 'Escribe el motivo.');
        return;
      }
    }
    if (!mounted) return;
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      await repo.reviewCourierDocument(
        str(document['id']),
        decision: decision,
        note: note,
      );
      if (!mounted) return;
      crmToast(context, 'Documento revisado.');
      await _loadDocuments();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final application = widget.application;
    final documents = listv(_documents?['documents']);
    final missing = listv(
      _documents?['required'],
    ).map((row) => str(row)).where((value) => value.isNotEmpty).toList();
    final name = str(
      application['full_name'],
      str(application['name'], str(application['phone'], 'Repartidor')),
    );
    final canReview = _status == 'pending' || _status == 'info_required';

    return ListView(
      controller: widget.scrollController,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      children: [
        Row(
          children: [
            CrmAvatar(label: name, size: 46),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: Theme.of(context).textTheme.titleMedium),
                  Text(
                    [
                      str(application['phone']),
                      str(application['vehicle_type']),
                      _status,
                    ].where((part) => part.isNotEmpty).join(' · '),
                    style: TextStyle(fontSize: 12, color: p.inkSecondary),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Text('Ficha', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        KeyValueList(
          data: application,
          skipKeys: const ['id', 'documents', 'file', 'token'],
        ),
        if (canReview) ...[
          const SizedBox(height: 16),
          Text('Decisión', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              CrmButton(
                label: 'Aprobar',
                icon: Icons.check_rounded,
                onPressed: _busy ? null : () => _decide('approved'),
              ),
              CrmButton(
                label: 'Pedir información',
                icon: Icons.help_outline_rounded,
                filled: false,
                onPressed: _busy ? null : () => _decide('info_required'),
              ),
              CrmButton(
                label: 'Rechazar',
                icon: Icons.close_rounded,
                filled: false,
                tone: p.danger,
                onPressed: _busy ? null : () => _decide('rejected'),
              ),
            ],
          ),
        ],
        const SizedBox(height: 18),
        Text('Documentos', style: Theme.of(context).textTheme.titleSmall),
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 18),
            child: LoadingState(),
          )
        else if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _error!,
                    style: TextStyle(fontSize: 12.5, color: p.danger),
                  ),
                ),
                TextButton(
                  onPressed: _loadDocuments,
                  child: const Text('Reintentar'),
                ),
              ],
            ),
          )
        else if (documents.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              'No hay documentos subidos.',
              style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
            ),
          )
        else
          Column(
            children: [
              for (final document in documents)
                CrmListTile(
                  title: str(document['kind'], 'Documento'),
                  subtitle: [
                    str(document['status'], 'pendiente'),
                    CrmFormat.ago(document['created_at']),
                  ].join(' · '),
                  leading: CrmAvatar(
                    label: str(document['kind'], 'D'),
                    icon: Icons.attach_file_rounded,
                  ),
                  trailing: PopupMenuButton<String>(
                    onSelected: (value) {
                      if (value == 'open') _openDocument(document);
                      if (value == 'review') _reviewDocument(document);
                    },
                    itemBuilder: (menuContext) => const [
                      PopupMenuItem(value: 'open', child: Text('Abrir')),
                      PopupMenuItem(value: 'review', child: Text('Revisar')),
                    ],
                  ),
                ),
            ],
          ),
        if (missing.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              'Faltan: ${missing.join(', ')}',
              style: TextStyle(
                fontSize: 12,
                color: p.warning,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
      ],
    );
  }
}
