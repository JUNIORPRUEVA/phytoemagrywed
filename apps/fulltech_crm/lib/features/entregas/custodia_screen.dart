import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/crm_repository.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Custodia y rendiciones: el dinero que lleva cada repartidor.
///
/// Regla del negocio que esta pantalla respeta: el efectivo en manos de un
/// repartidor **no** es dinero de caja. Por eso lo pendiente se muestra aparte y
/// la rendición es un acto administrativo explícito (idempotente).
class CustodiaScreen extends StatefulWidget {
  const CustodiaScreen({super.key});

  @override
  State<CustodiaScreen> createState() => _CustodiaScreenState();
}

class _CustodiaScreenState extends State<CustodiaScreen> {
  int _tab = 0;
  bool _busy = false;

  CrmRepository get _repo => CrmScope.of(context, listen: false).repository;

  Future<String?> _remit(Map<String, dynamic> row) async {
    final pendingCents = intv(row['pending_cents']);
    if (pendingCents <= 0) return 'Ese repartidor no tiene efectivo pendiente.';
    final amount = TextEditingController(text: (pendingCents / 100).toStringAsFixed(2));
    final note = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Rendición de ${str(row['courier_name'], 'repartidor')}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Pendiente: ${CrmFormat.money(pendingCents / 100)}', style: const TextStyle(fontSize: 12.5)),
            const SizedBox(height: 8),
            TextField(
              controller: amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
              decoration: const InputDecoration(labelText: 'Efectivo entregado'),
            ),
            const SizedBox(height: 10),
            TextField(controller: note, decoration: const InputDecoration(labelText: 'Nota (opcional)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar')),
        ],
      ),
    );
    final typed = double.tryParse(amount.text.replaceAll(',', '.'));
    final noteText = note.text.trim();
    amount.dispose();
    note.dispose();
    if (confirmed != true) return null;
    if (typed == null || typed <= 0) return 'Escribe un importe válido.';
    final result = await _repo.remitDeliveryCash(
      courierAccountId: str(row['courier_id']),
      amountCents: (typed * 100).round(),
      companyId: str(row['company_id']).isEmpty ? null : str(row['company_id']),
      note: noteText.isEmpty ? null : noteText,
      operationKey: newOperationKey('rem'),
    );
    return result['duplicate'] == true ? 'Esa rendición ya estaba registrada.' : 'Rendición registrada.';
  }

  Future<String?> _resolve(Map<String, dynamic> movement) async {
    final justification = TextEditingController();
    final evidence = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Registrar revisión'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Deja constancia de la revisión. NO mueve dinero ni desbloquea la custodia.',
              style: TextStyle(fontSize: 12.5),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: justification,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Justificación (mínimo 10 caracteres)'),
            ),
            const SizedBox(height: 8),
            TextField(controller: evidence, decoration: const InputDecoration(labelText: 'Evidencia (opcional)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar')),
        ],
      ),
    );
    final reason = justification.text.trim();
    final proof = evidence.text.trim();
    justification.dispose();
    evidence.dispose();
    if (confirmed != true) return null;
    if (reason.length < 10) return 'Explica con qué evidencia se concluyó (mínimo 10 caracteres).';
    await _repo.recordCashResolution(
      movementId: str(movement['id']),
      justification: reason,
      evidence: proof.isEmpty ? null : proof,
      companyId: str(movement['company_id']).isEmpty ? null : str(movement['company_id']),
    );
    return 'Revisión registrada. La custodia sigue bloqueada hasta autorización.';
  }

  Future<void> _report(String? message, VoidCallback reload) async {
    if (!mounted) return;
    if ((message ?? '').isNotEmpty) crmToast(context, message!);
    reload();
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final isAdmin = state.session.can('admin.full');
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Custodia y rendiciones', subtitle: 'Efectivo en manos del reparto'),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          child: SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('Resumen'), icon: Icon(Icons.account_balance_wallet_outlined, size: 16)),
              ButtonSegment(value: 1, label: Text('Movimientos'), icon: Icon(Icons.swap_horiz_rounded, size: 16)),
              ButtonSegment(value: 2, label: Text('Conciliación'), icon: Icon(Icons.rule_rounded, size: 16)),
            ],
            selected: {_tab},
            onSelectionChanged: (value) => setState(() => _tab = value.first),
          ),
        ),
        Expanded(
          child: switch (_tab) {
            0 => RemoteLoader<Map<String, dynamic>>(
                load: state.repository.deliveryCash,
                loadingLabel: 'Cargando custodia',
                builder: (context, data, reload) => _Summary(
                  data: data,
                  isAdmin: isAdmin,
                  busy: _busy,
                  onRemit: (row) async {
                    if (_busy) return;
                    setState(() => _busy = true);
                    String? message;
                    try {
                      message = await _remit(row);
                    } on ApiException catch (error) {
                      message = error.message;
                    } finally {
                      if (mounted) setState(() => _busy = false);
                    }
                    await _report(message, reload);
                  },
                  onOpenMovements: (row) async {
                    final movements = await state.repository.deliveryCashMovements(courierId: str(row['courier_id']));
                    if (!context.mounted) return;
                    await showModalBottomSheet<void>(
                      context: context,
                      showDragHandle: true,
                      isScrollControlled: true,
                      builder: (sheetContext) => SafeArea(
                        child: ListView(
                          shrinkWrap: true,
                          padding: const EdgeInsets.only(bottom: 16),
                          children: [
                            SheetTitle(title: 'Movimientos · ${str(row['courier_name'], 'repartidor')}'),
                            if (movements.isEmpty) const ListTile(title: Text('Sin movimientos.')),
                            for (final movement in movements) _MovementTile(movement: movement),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
            1 => RemoteLoader<List<Map<String, dynamic>>>(
                load: state.repository.deliveryCashMovements,
                loadingLabel: 'Cargando movimientos',
                builder: (context, rows, reload) => ListView(
                  padding: const EdgeInsets.only(top: 4, bottom: 26),
                  children: [
                    SectionCard(
                      title: 'Libro de movimientos',
                      child: rows.isEmpty
                          ? Text('Sin movimientos.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                          : Column(children: [for (final row in rows.take(200)) _MovementTile(movement: row)]),
                    ),
                  ],
                ),
              ),
            _ => RemoteLoader<Map<String, dynamic>>(
                load: state.repository.deliveryCashReconciliation,
                loadingLabel: 'Conciliando',
                builder: (context, report, reload) {
                  final unresolved = listv(report['unresolved_movements']);
                  final byCompany = mapv(report['by_company']);
                  return ListView(
                    padding: const EdgeInsets.only(top: 4, bottom: 26),
                    children: [
                      SectionCard(
                        title: 'Por empresa',
                        child: byCompany.isEmpty
                            ? Text('Sin datos de conciliación.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                            : Column(
                                children: [
                                  for (final entry in byCompany.entries)
                                    CrmListTile(
                                      title: entry.key,
                                      subtitle: 'Cargos ${CrmFormat.money(dub(mapv(entry.value)['charged_cents']) / 100)} · '
                                          'Rendido ${CrmFormat.money(dub(mapv(entry.value)['remitted_cents']) / 100)}',
                                      trailing: Text(
                                        CrmFormat.money(dub(mapv(entry.value)['pending_cents']) / 100),
                                        style: const TextStyle(fontWeight: FontWeight.w800),
                                      ),
                                      leading: const CrmAvatar(label: 'E', icon: Icons.business_outlined),
                                    ),
                                ],
                              ),
                      ),
                      SectionCard(
                        title: 'Movimientos sin resolver (${unresolved.length})',
                        child: unresolved.isEmpty
                            ? Text('Todo conciliado.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                            : Column(
                                children: [
                                  for (final movement in unresolved.take(60))
                                    _MovementTile(
                                      movement: movement,
                                      trailing: isAdmin
                                          ? TextButton(
                                              onPressed: () async {
                                                String? message;
                                                try {
                                                  message = await _resolve(movement);
                                                } on ApiException catch (error) {
                                                  message = error.message;
                                                }
                                                await _report(message, reload);
                                              },
                                              child: const Text('Revisar'),
                                            )
                                          : null,
                                    ),
                                ],
                              ),
                      ),
                      if (isAdmin)
                        const CrmNotice(
                          message: 'La conciliación solo describe. Ninguna pantalla mueve dinero por su cuenta: '
                              'registrar una revisión no corrige saldos.',
                        ),
                    ],
                  );
                },
              ),
          },
        ),
      ],
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({
    required this.data,
    required this.isAdmin,
    required this.busy,
    required this.onRemit,
    required this.onOpenMovements,
  });

  final Map<String, dynamic> data;
  final bool isAdmin;
  final bool busy;
  final Future<void> Function(Map<String, dynamic> row) onRemit;
  final Future<void> Function(Map<String, dynamic> row) onOpenMovements;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final rows = listv(data['couriers']);
    final companyId = str(data['company_id'], 'phytoemagry');
    var charged = 0;
    var remitted = 0;
    var pending = 0;
    for (final row in rows) {
      charged += intv(row['charged_cents']);
      remitted += intv(row['remitted_cents']);
      pending += intv(row['pending_cents']);
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 26),
      children: [
        StatGrid(
          children: [
            StatTile(label: 'Cobrado en efectivo', value: CrmFormat.money(charged / 100, short: true), icon: Icons.payments_outlined),
            StatTile(
              label: 'Rendido',
              value: CrmFormat.money(remitted / 100, short: true),
              tone: p.success,
              icon: Icons.check_circle_outline_rounded,
            ),
            StatTile(
              label: 'Pendiente de rendir',
              value: CrmFormat.money(pending / 100, short: true),
              tone: pending > 0 ? p.danger : p.success,
              icon: Icons.warning_amber_rounded,
            ),
            StatTile(label: 'Repartidores', value: '${rows.length}', icon: Icons.delivery_dining_outlined),
          ],
        ),
        SectionCard(
          title: 'Por repartidor · $companyId',
          child: rows.isEmpty
              ? Text('No hay efectivo en custodia.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
              : Column(
                  children: [
                    for (final row in rows)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            CrmListTile(
                              title: str(row['courier_name'], 'Repartidor'),
                              subtitle: '${intv(row['orders_count'])} pedido(s) · '
                                  'cobrado ${CrmFormat.money(intv(row['charged_cents']) / 100)} · '
                                  'rendido ${CrmFormat.money(intv(row['remitted_cents']) / 100)}',
                              leading: CrmAvatar(label: str(row['courier_name'], 'R'), icon: Icons.delivery_dining_outlined),
                              trailing: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    CrmFormat.money(intv(row['pending_cents']) / 100),
                                    style: TextStyle(
                                      fontWeight: FontWeight.w800,
                                      color: intv(row['pending_cents']) > 0 ? p.danger : p.success,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  // Estado de LIQUIDACIÓN: sin pendiente, la cuenta
                                  // del repartidor con la empresa está saldada.
                                  StatusPill(
                                    label: intv(row['pending_cents']) > 0 ? 'pendiente' : 'liquidado',
                                    dense: true,
                                    color: intv(row['pending_cents']) > 0 ? p.warning : p.success,
                                  ),
                                ],
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.only(left: 4, bottom: 6),
                              child: Wrap(
                                spacing: 8,
                                children: [
                                  CrmButton(
                                    label: 'Movimientos',
                                    icon: Icons.list_alt_rounded,
                                    filled: false,
                                    tone: p.inkSecondary,
                                    onPressed: () => onOpenMovements(row),
                                  ),
                                  if (isAdmin && intv(row['pending_cents']) > 0)
                                    CrmButton(
                                      label: 'Rendir efectivo',
                                      icon: Icons.account_balance_wallet_outlined,
                                      onPressed: busy ? null : () => onRemit(row),
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        const CrmNotice(
          message: 'El efectivo que lleva un repartidor no está en caja: sale de custodia solo con una rendición registrada.',
        ),
      ],
    );
  }
}

class _MovementTile extends StatelessWidget {
  const _MovementTile({required this.movement, this.trailing});

  final Map<String, dynamic> movement;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final kind = str(movement['kind'], 'movimiento');
    final label = switch (kind) {
      'charge' => 'Cargo',
      'remittance' => 'Rendición',
      'adjustment' => 'Ajuste',
      _ => kind,
    };
    final cents = intv(movement['amount_cents']);
    return CrmListTile(
      title: label,
      subtitle: [
        str(movement['order_id']),
        str(movement['courier_account_id']),
        CrmFormat.ago(movement['created_at']),
      ].where((row) => row.isNotEmpty).join(' · '),
      leading: CrmAvatar(
        label: label.substring(0, 1),
        icon: kind == 'remittance' ? Icons.south_west_rounded : Icons.north_east_rounded,
        tone: kind == 'remittance' ? p.success : p.inkSecondary,
      ),
      trailing: trailing ?? Text(CrmFormat.money(cents / 100), style: const TextStyle(fontWeight: FontWeight.w700)),
    );
  }
}

/// Título de una hoja inferior.
class SheetTitle extends StatelessWidget {
  const SheetTitle({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
      child: Text(title, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: p.ink)),
    );
  }
}

/// Utilidad compartida: nombre visible de un repartidor en una fila suelta.
String courierNameOf(Map<String, dynamic> row) => str(
      row['courier_name'],
      str(row['delivery_user_name'], str(row['name'], str(row['user_name'], 'Repartidor'))),
    );

/// Fila de un repartidor (usada por el listado de repartidores).
class CourierTile extends StatelessWidget {
  const CourierTile({super.key, required this.row});

  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final status = str(row['status'], 'pendiente');
    final name = courierNameOf(row);
    return CrmListTile(
      title: name,
      subtitle: [
        if (str(row['phone']).isNotEmpty) str(row['phone']),
        if (str(row['company_name'], str(row['company'])).isNotEmpty) str(row['company_name'], str(row['company'])),
        CrmFormat.ago(row['created_at']),
      ].join(' · '),
      leading: CrmAvatar(label: name, icon: Icons.delivery_dining_outlined),
      trailing: StatusPill(label: status, dense: true, color: status.toLowerCase() == 'aprobado' ? p.success : null),
    );
  }
}

/// Sesión de reparto en vivo (usada por el mapa).
class DeliverySessionTile extends StatelessWidget {
  const DeliverySessionTile({super.key, required this.session});

  final DeliverySession session;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final hasPosition = session.lat != null && session.lng != null;
    return CrmListTile(
      title: session.courierName,
      subtitle: [
        session.orderId.isEmpty ? 'Sin pedido' : 'Pedido ${session.orderId}',
        hasPosition ? '${session.lat!.toStringAsFixed(4)}, ${session.lng!.toStringAsFixed(4)}' : 'Sin posición',
        CrmFormat.ago(session.updatedAt),
      ].join(' · '),
      leading: CrmAvatar(label: session.courierName, icon: Icons.my_location_rounded, tone: hasPosition ? p.success : p.inkSecondary),
      trailing: StatusPill(label: session.status, dense: true),
    );
  }
}
