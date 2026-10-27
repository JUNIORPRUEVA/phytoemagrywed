import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/crm_scope.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/crm_repository.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Estados del pedido que acepta el servidor (`ORDER_STATUSES`).
const List<(String, String)> kOrderStatuses = [
  ('nuevo', 'Pendiente'),
  ('contactado', 'Contactado'),
  ('interesado', 'Interesado'),
  ('confirmado', 'Confirmado'),
  ('en_preparacion', 'En preparación'),
  ('enviado', 'Enviado'),
  ('entregado', 'Entregado'),
  ('cancelado', 'Cancelado'),
  ('perdido', 'Perdido'),
];

/// Motivos de incidencia de entrega (`DELIVERY_ISSUE_REASONS` del servidor).
const List<(String, String)> kDeliveryIssueReasons = [
  ('no_response', 'Cliente no responde'),
  ('wrong_address', 'Dirección incorrecta'),
  ('customer_rejected', 'El cliente rechazó el pedido'),
  ('not_home', 'Nadie en el domicilio'),
  ('rescheduled', 'El cliente pidió otro día'),
  ('payment_problem', 'Problema con el pago'),
  ('product_problem', 'Problema con el producto'),
  ('other', 'Otro motivo'),
];

/// Acciones del pedido: estado, confirmar, finalizar, reparto interno y externo,
/// cobrar, rendir efectivo, verificar cobros, incidencias, factura por WhatsApp,
/// cancelar y borrar. Cada botón respeta el permiso REAL de la sesión: si el
/// servidor va a decir que no, aquí ni se ofrece.
class OrderActionsPanel extends StatefulWidget {
  const OrderActionsPanel({
    super.key,
    required this.orderId,
    required this.order,
    this.payment = const {},
    this.detailOrder = const {},
    required this.onChanged,
  });

  final String orderId;
  final OrderItem? order;

  /// Bloque de cobro tal cual lo devuelve `GET /api/admin/orders/:id`.
  final Map<String, dynamic> payment;

  /// Pedido completo (historial de estados, incidencias, líneas).
  final Map<String, dynamic> detailOrder;

  final VoidCallback onChanged;

  @override
  State<OrderActionsPanel> createState() => _OrderActionsPanelState();
}

class _OrderActionsPanelState extends State<OrderActionsPanel> {
  bool _busy = false;

  CrmRepository get _repo => CrmScope.of(context, listen: false).repository;

  /// Ejecuta una acción, muestra el resultado y refresca la pantalla.
  Future<void> _run(Future<String?> Function(CrmRepository repo) action) async {
    if (_busy) return;
    final repo = _repo;
    setState(() => _busy = true);
    String? message;
    try {
      message = await action(repo);
    } on ApiException catch (error) {
      message = error.message;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted) return;
    if ((message ?? '').isNotEmpty) crmToast(context, message!);
    widget.onChanged();
  }

  bool get _closed => const {'entregado', 'cancelado', 'perdido'}.contains(widget.order?.status ?? '');

  double get _due => dub(widget.payment['due']);

  bool get _hasOpenIssue =>
      listv(mapv(widget.detailOrder['delivery'])['issues']).any((row) => str(row['resolved_at']).isEmpty);

  /// La entrega está en camino (es cuando el servidor acepta confirmarla a mano).
  bool get _deliveryInTransit =>
      str(mapv(widget.detailOrder['delivery'])['delivery_status']).toUpperCase() == 'IN_TRANSIT';

  @override
  Widget build(BuildContext context) {
    final session = CrmScope.of(context).session;
    final p = context.crm;
    final canStatus = session.can('orders.change_status');
    final canOperate = session.can('orders.update_operational');
    final canAssign = session.can('delivery.tracking.manage_all');
    final canCancel = session.can('sales.cancel');
    final isAdmin = session.can('admin.full');
    final canInvoice = session.can('chats.reply');

    return Column(
      children: [
        SectionCard(
          title: 'Acciones',
          trailing: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (canOperate && !_closed) ...[
                    CrmButton(label: 'Confirmar', icon: Icons.verified_outlined, filled: false, onPressed: () => _run(_confirm)),
                    CrmButton(label: 'Finalizar', icon: Icons.task_alt_rounded, filled: false, onPressed: () => _run(_finish)),
                  ],
                  if (canAssign && !_closed)
                    CrmButton(label: 'Asignar reparto', icon: Icons.delivery_dining_outlined, filled: false, onPressed: () => _run(_assign)),
                  if (canAssign && !_closed)
                    CrmButton(
                      label: 'Reparto externo',
                      icon: Icons.local_shipping_outlined,
                      filled: false,
                      onPressed: () => _run(_externalCourier),
                    ),
                  if (canOperate) CrmButton(label: 'Registrar cobro', icon: Icons.payments_outlined, onPressed: () => _run(_payment)),
                  if (canOperate && !_closed)
                    CrmButton(label: 'Editar pedido', icon: Icons.edit_outlined, filled: false, onPressed: () => _run(_edit)),
                  if (canStatus)
                    CrmButton(
                      label: 'Cambiar estado',
                      icon: Icons.swap_horiz_rounded,
                      filled: false,
                      tone: p.inkSecondary,
                      onPressed: () => _run(_changeStatus),
                    ),
                  if (canInvoice && !_closed)
                    CrmButton(
                      label: 'Factura por WhatsApp',
                      icon: Icons.send_outlined,
                      filled: false,
                      onPressed: () => _run(_invoiceWhatsapp),
                    ),
                  if (canAssign && !_closed && !_hasOpenIssue)
                    CrmButton(
                      label: 'Incidencia',
                      icon: Icons.report_problem_outlined,
                      filled: false,
                      tone: p.warning,
                      onPressed: () => _run(_reportIssue),
                    ),
                  if (canAssign && _hasOpenIssue)
                    CrmButton(label: 'Resolver incidencia', icon: Icons.rule_rounded, onPressed: () => _run(_resolveIssue)),
                  /*
                   * La confirmación administrativa solo tiene sentido cuando la
                   * entrega ya está EN CAMINO: el servidor no permite «deliver»
                   * desde ASSIGNED (las transiciones las decide él). Para el resto
                   * de casos está «Finalizar».
                   */
                  if (isAdmin && _deliveryInTransit)
                    CrmButton(
                      label: 'Confirmar entrega',
                      icon: Icons.verified_user_outlined,
                      filled: false,
                      onPressed: () => _run(_confirmDelivery),
                    ),
                  CrmButton(label: 'Ver factura', icon: Icons.picture_as_pdf_outlined, filled: false, tone: p.inkSecondary, onPressed: () => _run(_receipt)),
                  if (canCancel && !_closed)
                    CrmButton(label: 'Cancelar', icon: Icons.cancel_outlined, filled: false, tone: p.danger, onPressed: () => _run(_cancel)),
                  if (canCancel)
                    CrmButton(label: 'Borrar', icon: Icons.delete_outline_rounded, filled: false, tone: p.danger, onPressed: () => _run(_delete)),
                ],
              ),
              if (!canOperate && !canStatus && !canAssign)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    'Tu rol puede consultar este pedido, pero no cambiarlo.',
                    style: TextStyle(fontSize: 12, color: p.inkSecondary),
                  ),
                ),
            ],
          ),
        ),
        _PaymentCard(
          payment: widget.payment,
          canOperate: canOperate,
          isAdmin: isAdmin,
          busy: _busy,
          onPay: () => _run(_payment),
          onVerify: (paymentId, decision) => _run((_) => _verify(paymentId, decision)),
          onHandover: () => _run(_handover),
        ),
        _HistoryCard(detailOrder: widget.detailOrder),
      ],
    );
  }

  // ------------------------------------------------------------------ pedido
  Future<String?> _confirm(CrmRepository repo) async {
    if (!await crmConfirm(context, title: 'Confirmar pedido', message: 'El pedido pasa a confirmado. No se cobra ni se entrega.', confirmLabel: 'Confirmar')) {
      return null;
    }
    await repo.confirmOrder(widget.orderId);
    return 'Pedido confirmado.';
  }

  Future<String?> _finish(CrmRepository repo) async {
    if (!await crmConfirm(context, title: 'Finalizar pedido', message: 'El pedido se marca como ENTREGADO. Afecta inventario y postventa.', confirmLabel: 'Marcar entregado')) {
      return null;
    }
    await repo.finishOrder(widget.orderId, reason: 'Finalizado desde la app');
    return 'Pedido entregado.';
  }

  Future<String?> _changeStatus(CrmRepository repo) async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final entry in kOrderStatuses)
              ListTile(
                leading: Icon(
                  entry.$1 == widget.order?.status ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded,
                  size: 20,
                ),
                title: Text(entry.$2),
                subtitle: Text(entry.$1, style: const TextStyle(fontSize: 11.5)),
                enabled: entry.$1 != widget.order?.status,
                onTap: () => Navigator.pop(sheetContext, entry.$1),
              ),
          ],
        ),
      ),
    );
    if (selected == null || !mounted) return null;
    final confirmed = await crmConfirm(
      context,
      title: 'Cambiar estado',
      message: 'El pedido pasará a «$selected». Queda auditado con tu usuario.',
      confirmLabel: 'Cambiar',
    );
    if (!confirmed) return null;
    await repo.changeOrderStatus(widget.orderId, selected, expectedStatus: widget.order?.status);
    return 'Estado actualizado a $selected.';
  }

  Future<String?> _assign(CrmRepository repo) async {
    List<Map<String, dynamic>> assignees;
    try {
      assignees = await repo.assignees();
    } on ApiException catch (error) {
      return error.message;
    }
    if (!mounted) return null;
    if (assignees.isEmpty) return 'No hay repartidores disponibles para asignar.';
    final picked = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final row in assignees)
              ListTile(
                leading: CrmAvatar(
                  label: str(row['display_name'], str(row['name'], str(row['username']))),
                  icon: Icons.delivery_dining_outlined,
                ),
                title: Text(str(row['display_name'], str(row['name'], str(row['username'], 'Repartidor')))),
                subtitle: Text(str(row['role'], str(row['phone'], ''))),
                onTap: () => Navigator.pop(sheetContext, row),
              ),
          ],
        ),
      ),
    );
    if (picked == null) return null;
    final id = str(picked['id'], str(picked['user_id']));
    if (id.isEmpty) return 'Ese repartidor no tiene identificador.';
    await repo.assignDelivery(widget.orderId, deliveryUserId: id);
    return 'Pedido asignado.';
  }

  /// Reparto EXTERNO: se escribe el teléfono de la mensajería. Con «enviar
  /// ahora», el servidor asigna y manda el pedido en la misma operación.
  Future<String?> _externalCourier(CrmRepository repo) async {
    final phoneController = TextEditingController();
    var autoSend = true;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Reparto externo'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: phoneController,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Teléfono del repartidor externo'),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Enviarle el pedido ahora'),
                subtitle: const Text('Si la plantilla no está aprobada, el servidor dirá por qué.'),
                value: autoSend,
                onChanged: (value) => setDialogState(() => autoSend = value),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Asignar')),
          ],
        ),
      ),
    );
    final phone = phoneController.text.trim();
    phoneController.dispose();
    if (confirmed != true) return null;
    if (phone.length < 6) return 'Escribe un teléfono válido del repartidor externo.';
    final result = await repo.assignExternalCourier(widget.orderId, contactPhone: phone, autoSend: autoSend);
    if (autoSend && result['sent'] == false) {
      return 'Asignado, pero no se pudo enviar: ${str(result['message'], str(result['send_error'], 'revisar la plantilla'))}';
    }
    return autoSend ? 'Asignado y enviado al repartidor externo.' : 'Asignado al repartidor externo.';
  }

  /// Editar líneas, descuento, envío y notas. El total lo recalcula el servidor.
  Future<String?> _edit(CrmRepository repo) async {
    final lines = listv(widget.detailOrder['items'])
        .map((row) => <String, dynamic>{
              'variantId': str(row['variantId'], str(row['variant_id'])),
              'name': str(row['variantName'], str(row['label'], str(row['variantId']))),
              'quantity': intv(row['quantity'], 1),
              'unitPrice': dub(row['unitPrice'], dub(row['unit_price'])),
            })
        .toList();
    if (lines.isEmpty) return 'Este pedido no tiene líneas que editar.';

    final discount = TextEditingController(text: dub(widget.detailOrder['discount']).toStringAsFixed(2));
    final deliveryFee = TextEditingController(
      text: dub(widget.detailOrder['delivery_fee'], dub(widget.detailOrder['deliveryFee'])).toStringAsFixed(2),
    );
    final notes = TextEditingController(text: str(widget.detailOrder['notes']));

    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Editar pedido'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in lines)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              '${line['name']} · ${CrmFormat.money(dub(line['unitPrice']))}',
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          IconButton(
                            iconSize: 18,
                            tooltip: 'Quitar uno',
                            onPressed: intv(line['quantity'], 1) <= 1
                                ? null
                                : () => setDialogState(() => line['quantity'] = intv(line['quantity'], 1) - 1),
                            icon: const Icon(Icons.remove_circle_outline_rounded),
                          ),
                          Text('${intv(line['quantity'], 1)}', style: const TextStyle(fontWeight: FontWeight.w700)),
                          IconButton(
                            iconSize: 18,
                            tooltip: 'Añadir uno',
                            onPressed: () => setDialogState(() => line['quantity'] = intv(line['quantity'], 1) + 1),
                            icon: const Icon(Icons.add_circle_outline_rounded),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: discount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                    decoration: const InputDecoration(labelText: 'Descuento'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: deliveryFee,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                    decoration: const InputDecoration(labelText: 'Costo de envío'),
                  ),
                  const SizedBox(height: 8),
                  TextField(controller: notes, maxLines: 2, decoration: const InputDecoration(labelText: 'Notas')),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar')),
          ],
        ),
      ),
    );
    final payload = [
      for (final line in lines)
        {'variantId': line['variantId'], 'quantity': line['quantity'], 'unitPrice': line['unitPrice']},
    ];
    final nextDiscount = double.tryParse(discount.text.replaceAll(',', '.'));
    final nextFee = double.tryParse(deliveryFee.text.replaceAll(',', '.'));
    final nextNotes = notes.text.trim();
    discount.dispose();
    deliveryFee.dispose();
    notes.dispose();
    if (saved != true) return null;
    if (nextDiscount == null || nextDiscount < 0) return 'Escribe un descuento válido.';
    if (nextFee == null || nextFee < 0) return 'Escribe un costo de envío válido.';
    /*
     * Clave de operación: si el móvil pierde la respuesta, el reintento no
     * aplica dos veces la misma edición.
     */
    final result = await repo.updateOrder(
      widget.orderId,
      items: payload,
      discount: nextDiscount,
      deliveryFee: nextFee,
      notes: nextNotes,
      operationKey: newOperationKey('ord'),
    );
    final total = dub(mapv(result['order'])['total'], widget.order?.total ?? 0);
    return 'Pedido actualizado · total ${CrmFormat.money(total)}.';
  }

  /// Cancelar: una venta ENTREGADA se cancela con motivo (restaura inventario y
  /// anula el pago). Un pedido que aún no se entregó se cancela cambiando estado.
  Future<String?> _cancel(CrmRepository repo) async {
    final reasonController = TextEditingController();
    final delivered = (widget.order?.status ?? '') == 'entregado';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(delivered ? 'Cancelar venta entregada' : 'Cancelar pedido'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              delivered
                  ? 'Se restaura el inventario y el pago queda anulado. Queda auditado con tu usuario.'
                  : 'El pedido pasará a CANCELADO. Queda auditado con tu usuario.',
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: reasonController,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Motivo (obligatorio)'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Volver')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Cancelar el pedido')),
        ],
      ),
    );
    final reason = reasonController.text.trim();
    reasonController.dispose();
    if (confirmed != true) return null;
    if (reason.length < 6) return 'Escribe el motivo (al menos 6 caracteres).';
    if (delivered) {
      await repo.cancelDeliveredSale(widget.orderId, reason: reason, operationKey: newOperationKey('cnl'));
      return 'Venta cancelada. Inventario restaurado y pago anulado.';
    }
    await repo.changeOrderStatus(widget.orderId, 'cancelado', expectedStatus: widget.order?.status, reason: reason);
    return 'Pedido cancelado.';
  }

  Future<String?> _delete(CrmRepository repo) async {
    if (!await crmConfirm(
      context,
      title: 'Borrar pedido',
      message: 'Solo se borran pedidos sin historial comercial. Si ya lo tiene, el servidor lo impide y hay que cancelar.',
      confirmLabel: 'Borrar',
    )) {
      return null;
    }
    await repo.deleteOrder(widget.orderId);
    return 'Pedido borrado.';
  }

  Future<String?> _reportIssue(CrmRepository repo) async {
    final reason = await showModalBottomSheet<(String, String)>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final entry in kDeliveryIssueReasons)
              ListTile(title: Text(entry.$2), onTap: () => Navigator.pop(sheetContext, entry)),
          ],
        ),
      ),
    );
    if (reason == null || !mounted) return null;
    final noteController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Incidencia · ${reason.$2}'),
        content: TextField(
          controller: noteController,
          maxLines: 3,
          decoration: InputDecoration(
            labelText: reason.$1 == 'other' ? 'Explica qué pasó (obligatorio)' : 'Nota (opcional)',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Volver')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar')),
        ],
      ),
    );
    final note = noteController.text.trim();
    noteController.dispose();
    if (confirmed != true) return null;
    await repo.reportDeliveryIssue(widget.orderId, reason: reason.$1, note: note.isEmpty ? null : note);
    return 'Incidencia registrada. Administración debe resolverla.';
  }

  Future<String?> _resolveIssue(CrmRepository repo) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              leading: const Icon(Icons.play_arrow_rounded),
              title: const Text('Reanudar la entrega'),
              onTap: () => Navigator.pop(sheetContext, 'resume'),
            ),
            ListTile(
              leading: const Icon(Icons.cancel_outlined),
              title: const Text('Cancelar la entrega'),
              onTap: () => Navigator.pop(sheetContext, 'cancel'),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return null;
    final noteController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Qué se decidió?'),
        content: TextField(
          controller: noteController,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Nota de la decisión (obligatoria)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Volver')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar')),
        ],
      ),
    );
    final note = noteController.text.trim();
    noteController.dispose();
    if (confirmed != true) return null;
    if (note.length < 3) return 'Escribe qué se decidió.';
    await repo.resolveDeliveryIssue(widget.orderId, action: action, note: note);
    return action == 'resume' ? 'Incidencia resuelta: la entrega se reanuda.' : 'Incidencia resuelta: la entrega se cancela.';
  }

  /// Factura por WhatsApp: primero se pregunta al servidor SI SE PUEDE (ventana
  /// de 24 h, plantilla de documento, opt-out) y solo después se envía.
  Future<String?> _invoiceWhatsapp(CrmRepository repo) async {
    final preview = await repo.invoiceWhatsappPreview(widget.orderId);
    if (preview['sendable'] != true) {
      return str(preview['message'], 'No se puede enviar la factura por WhatsApp.');
    }
    if (!mounted) return null;
    final confirmed = await crmConfirm(
      context,
      title: 'Enviar la factura',
      message: '${str(preview['greeting'], 'Se enviará la factura del pedido.')}\n\nSe enviará por WhatsApp al cliente.',
      confirmLabel: 'Enviar',
    );
    if (!confirmed) return null;
    final result = await repo.sendInvoiceWhatsapp(widget.orderId, operationKey: newOperationKey('inv'));
    return result['duplicate'] == true ? 'Esa factura ya se había enviado.' : 'Factura enviada por WhatsApp.';
  }

  // ------------------------------------------------------------------ dinero
  Future<String?> _payment(CrmRepository repo) async {
    final due = _due;
    final amountController = TextEditingController(
      text: due > 0 ? due.toStringAsFixed(2) : (widget.order?.total ?? 0).toStringAsFixed(2),
    );
    final noteController = TextEditingController();
    final evidenceController = TextEditingController();
    var method = 'CASH';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Registrar cobro'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Saldo pendiente: ${CrmFormat.money(due)}', style: const TextStyle(fontSize: 12.5)),
              const SizedBox(height: 8),
              TextField(
                controller: amountController,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                decoration: const InputDecoration(labelText: 'Importe cobrado'),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'CASH', label: Text('Efectivo'), icon: Icon(Icons.payments_outlined, size: 16)),
                  ButtonSegment(value: 'TRANSFER', label: Text('Transferencia'), icon: Icon(Icons.account_balance_outlined, size: 16)),
                ],
                selected: {method},
                onSelectionChanged: (value) => setDialogState(() => method = value.first),
              ),
              const SizedBox(height: 12),
              TextField(controller: noteController, decoration: const InputDecoration(labelText: 'Nota (opcional)')),
              if (method == 'TRANSFER') ...[
                const SizedBox(height: 12),
                TextField(
                  controller: evidenceController,
                  decoration: const InputDecoration(
                    labelText: 'Comprobante (referencia o enlace)',
                    helperText: 'Nº de transferencia, captura o enlace. Queda guardado con el cobro.',
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar')),
          ],
        ),
      ),
    );
    final amount = double.tryParse(amountController.text.replaceAll(',', '.'));
    final note = noteController.text.trim();
    final evidence = evidenceController.text.trim();
    amountController.dispose();
    noteController.dispose();
    evidenceController.dispose();
    if (confirmed != true) return null;
    if (amount == null || amount <= 0) return 'Escribe un importe válido.';
    /*
     * El saldo que vio la persona viaja como `expectedDue`: si otro cobró
     * mientras tanto, el servidor responde 409 y NO anota nada.
     */
    try {
      final result = await repo.registerPayment(
        widget.orderId,
        amount: amount,
        method: method,
        expectedDue: due > 0 ? due : null,
        note: note.isEmpty ? null : note,
        evidenceUrl: evidence.isEmpty ? null : evidence,
        operationKey: newOperationKey('pay'),
      );
      if (result['duplicate'] == true) return 'Ese cobro ya estaba registrado.';
      final after = dub(mapv(result['payment'])['due']);
      return 'Cobro registrado (${CrmFormat.money(amount)}) · queda ${CrmFormat.money(after)}.';
    } on ApiException catch (error) {
      /*
       * SIN RESPUESTA NO SE SABE SI ENTRÓ. No se marca nada como confirmado ni se
       * reintenta a ciegas: la clave de esta operación se descarta y se pide
       * revisar el pedido, que es donde el servidor dirá la verdad.
       */
      if (error.isUncertain) {
        return 'No sabemos si el cobro llegó al CRM (se cortó la conexión). Revisa los cobros del pedido antes de volver a registrarlo.';
      }
      rethrow;
    }
  }

  Future<String?> _verify(String paymentId, String decision) async {
    final noteController = TextEditingController();
    final rejected = decision == 'rejected';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(rejected ? 'Rechazar el cobro' : 'Verificar el cobro'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              rejected
                  ? 'El cobro se marca como rechazado (no se borra) y el saldo sigue abierto.'
                  : 'Confirmas que el dinero está: el saldo baja y el pedido puede quedar pagado.',
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: noteController,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Nota (opcional)'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Volver')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(rejected ? 'Rechazar' : 'Verificar'),
          ),
        ],
      ),
    );
    final note = noteController.text.trim();
    noteController.dispose();
    if (confirmed != true) return null;
    await _repo.verifyPayment(widget.orderId, paymentId, decision: decision, note: note.isEmpty ? null : note);
    return rejected ? 'Cobro rechazado. El saldo sigue abierto.' : 'Cobro verificado.';
  }

  /// Rendir el efectivo que lleva el repartidor en ESTE pedido. El dinero del
  /// repartidor no es dinero de caja hasta que se registra aquí.
  Future<String?> _handover(CrmRepository repo) async {
    final pending = dub(mapv(widget.payment['courier'])['pending']);
    if (pending <= 0) return 'Este pedido no tiene efectivo pendiente de rendir.';
    final amountController = TextEditingController(text: pending.toStringAsFixed(2));
    final noteController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Rendición del repartidor'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Efectivo pendiente: ${CrmFormat.money(pending)}', style: const TextStyle(fontSize: 12.5)),
            const SizedBox(height: 8),
            TextField(
              controller: amountController,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
              decoration: const InputDecoration(labelText: 'Importe entregado a la empresa'),
            ),
            const SizedBox(height: 10),
            TextField(controller: noteController, decoration: const InputDecoration(labelText: 'Nota (opcional)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar rendición')),
        ],
      ),
    );
    final amount = double.tryParse(amountController.text.replaceAll(',', '.'));
    final note = noteController.text.trim();
    amountController.dispose();
    noteController.dispose();
    if (confirmed != true) return null;
    if (amount == null || amount <= 0) return 'Escribe un importe válido.';
    final result = await repo.registerHandover(
      widget.orderId,
      amount: amount,
      expectedPending: pending,
      note: note.isEmpty ? null : note,
      operationKey: newOperationKey('hov'),
    );
    if (result['duplicate'] == true) return 'Esa rendición ya estaba registrada.';
    final left = dub(mapv(mapv(result['payment'])['courier'])['pending']);
    return 'Rendición registrada · queda por rendir ${CrmFormat.money(left)}.';
  }

  Future<String?> _receipt(CrmRepository repo) async {
    final file = await repo.orderReceiptFile(widget.orderId);
    final path = await FileOpener.saveAndOpen(file);
    return path == null ? 'No pudimos abrir la factura.' : null;
  }

  /// Confirmación administrativa de una entrega que no tiene prueba en el
  /// teléfono del repartidor. Es la firma de administración: queda auditada.
  Future<String?> _confirmDelivery(CrmRepository repo) async {
    if (!await crmConfirm(
      context,
      title: 'Confirmar la entrega',
      message: 'Úsalo solo cuando la entrega ocurrió y no hay prueba en el teléfono. Queda auditado con tu usuario.',
      confirmLabel: 'Confirmar entrega',
    )) {
      return null;
    }
    await repo.confirmDeliveryByAdmin(widget.orderId);
    return 'Entrega confirmada por administración.';
  }
}

/// Cobros del pedido: saldo, cobros declarados (verificar / rechazar) y el
/// efectivo que lleva el repartidor (rendir). El dinero del repartidor NO es
/// dinero de caja: se muestra en su propio bloque.
class _PaymentCard extends StatelessWidget {
  const _PaymentCard({
    required this.payment,
    required this.canOperate,
    required this.isAdmin,
    required this.busy,
    required this.onPay,
    required this.onVerify,
    required this.onHandover,
  });

  final Map<String, dynamic> payment;
  final bool canOperate;
  final bool isAdmin;
  final bool busy;
  final VoidCallback onPay;
  final void Function(String paymentId, String decision) onVerify;
  final VoidCallback onHandover;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final entries = listv(payment['entries']);
    final courier = mapv(payment['courier']);
    final due = dub(payment['due']);
    final received = dub(payment['received']);
    final pendingVerify = dub(payment['pendingVerification']);
    final courierPending = dub(courier['pending']);
    final status = str(payment['status'], 'sin cobros');

    return SectionCard(
      title: 'Cobros y dinero',
      trailing: StatusPill(label: status, dense: true, color: due <= 0 ? p.success : p.warning),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 18,
            runSpacing: 6,
            children: [
              _Figure(label: 'Cobrado', value: CrmFormat.money(received), tone: p.success),
              _Figure(label: 'Pendiente', value: CrmFormat.money(due), tone: due > 0 ? p.warning : p.success),
              if (pendingVerify > 0) _Figure(label: 'Por verificar', value: CrmFormat.money(pendingVerify), tone: p.warning),
              if (courierPending > 0)
                _Figure(label: 'En manos del reparto', value: CrmFormat.money(courierPending), tone: p.inkSecondary),
            ],
          ),
          if (entries.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text('Todavía no hay cobros anotados.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
            )
          else
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Column(
                children: [
                  for (final entry in entries)
                    _PaymentRow(
                      entry: entry,
                      canVerify: isAdmin && str(entry['verification'], 'verified') == 'pending',
                      busy: busy,
                      onVerify: (decision) => onVerify(str(entry['id']), decision),
                    ),
                ],
              ),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (canOperate) CrmButton(label: 'Anotar cobro', icon: Icons.payments_outlined, onPressed: busy ? null : onPay),
              if (isAdmin && courierPending > 0)
                CrmButton(
                  label: 'Registrar rendición',
                  icon: Icons.account_balance_wallet_outlined,
                  filled: false,
                  onPressed: busy ? null : onHandover,
                ),
            ],
          ),
          if (courierPending > 0)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: CrmNotice(
                message: 'Ese efectivo lo lleva el repartidor: no está en caja hasta que se rinda.',
                tone: p.inkSecondary,
              ),
            ),
        ],
      ),
    );
  }
}

class _PaymentRow extends StatelessWidget {
  const _PaymentRow({required this.entry, required this.canVerify, required this.busy, required this.onVerify});

  final Map<String, dynamic> entry;
  final bool canVerify;
  final bool busy;
  final void Function(String decision) onVerify;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final verification = str(entry['verification'], 'verified');
    final rejected = verification == 'rejected';
    final pending = verification == 'pending';
    final method = str(entry['method'], 'CASH') == 'TRANSFER' ? 'Transferencia' : 'Efectivo';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                rejected
                    ? Icons.cancel_outlined
                    : (pending ? Icons.hourglass_bottom_rounded : Icons.check_circle_outline_rounded),
                size: 16,
                color: rejected ? p.danger : (pending ? p.warning : p.success),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '$method · ${CrmFormat.money(dub(entry['amount']))}',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
              StatusPill(
                label: rejected ? 'rechazado' : (pending ? 'por verificar' : 'confirmado'),
                dense: true,
                color: rejected ? p.danger : (pending ? p.warning : p.success),
              ),
            ],
          ),
          if (str(entry['note']).isNotEmpty || str(entry['verification_note']).isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 24, top: 2),
              child: Text(
                [str(entry['note']), str(entry['verification_note'])].where((row) => row.isNotEmpty).join(' · '),
                style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
              ),
            ),
          if (canVerify)
            Padding(
              padding: const EdgeInsets.only(left: 24, top: 6),
              child: Wrap(
                spacing: 8,
                children: [
                  CrmButton(label: 'Verificar', icon: Icons.done_rounded, onPressed: busy ? null : () => onVerify('verified')),
                  CrmButton(
                    label: 'Rechazar',
                    icon: Icons.close_rounded,
                    filled: false,
                    tone: p.danger,
                    onPressed: busy ? null : () => onVerify('rejected'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, this.tone});

  final String label;
  final String value;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 11, color: p.inkSecondary)),
        Text(value, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: tone ?? p.ink)),
      ],
    );
  }
}

/// Historial: cambios de estado e incidencias tal como quedaron en el servidor.
class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.detailOrder});

  final Map<String, dynamic> detailOrder;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final history = listv(detailOrder['status_history']);
    final issues = listv(mapv(detailOrder['delivery'])['issues']);
    if (history.isEmpty && issues.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: 'Historial',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final row in history.reversed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(Icons.circle, size: 6, color: p.inkSecondary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${str(row['status'], '—')} · ${CrmFormat.ago(row['at'])}'
                      '${str(row['reason']).isEmpty ? '' : ' · ${str(row['reason'])}'}',
                      style: TextStyle(fontSize: 12.5, color: p.ink),
                    ),
                  ),
                ],
              ),
            ),
          for (final issue in issues)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(
                    Icons.report_problem_outlined,
                    size: 14,
                    color: str(issue['resolved_at']).isEmpty ? p.warning : p.success,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${str(issue['reason_label'], str(issue['reason'], 'Incidencia'))} · ${CrmFormat.ago(issue['at'])}'
                      '${str(issue['resolved_at']).isEmpty ? ' · abierta' : ' · resuelta'}',
                      style: TextStyle(fontSize: 12.5, color: p.ink),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
