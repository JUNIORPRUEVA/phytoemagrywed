import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../core/pos/pos_sale.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';

/// Panel derecho de venta (carrito + cobro) con la jerarquía de la captura de
/// FullPOS Cloud: líneas compactas con contador, subtotal, total grande y el
/// bloque azul de cobro.
///
/// No calcula dinero: recibe las líneas del `PosScreen` (que a su vez usa
/// `PosSaleDraft`, la misma fórmula del servidor).
///
/// Los colores salen de `PosPalette.of(context)`: el panel sigue el modo
/// claro/oscuro que haya elegido el usuario.
class PosCartPanel extends StatelessWidget {
  const PosCartPanel({
    super.key,
    required this.lines,
    required this.customer,
    required this.mode,
    required this.method,
    required this.paid,
    required this.deliveryFee,
    required this.saving,
    required this.onQuantity,
    required this.onRemove,
    required this.onLineDiscount,
    required this.onPickCustomer,
    required this.onClear,
    required this.onModeChanged,
    required this.onMethodChanged,
    required this.onPaidChanged,
    required this.onDeliveryFeeChanged,
    required this.onCheckout,
    this.onAskCustomerData,
    this.deliveryMethod = 'delivery',
    this.onDeliveryMethodChanged,
    this.addressController,
    this.notesController,
    this.onAddressChanged,
    this.discountType = 'none',
    this.discountValue = 0,
    this.onDiscountChanged,
    this.openOrders = const [],
    this.loadingContext = false,
    this.contextError,
    this.onReloadContext,
    this.scheduledAt,
    this.onScheduleChanged,
    this.referenceController,
  });

  final List<PosLine> lines;
  final Customer? customer;
  final String mode;
  final String method;
  final bool paid;
  final double deliveryFee;
  final bool saving;
  final void Function(PosLine line, int delta) onQuantity;
  final ValueChanged<PosLine> onRemove;

  /// Descuento de UNA línea: la pantalla abre el diálogo (`%` o importe).
  final ValueChanged<PosLine> onLineDiscount;
  final VoidCallback onPickCustomer;
  final VoidCallback onClear;
  final ValueChanged<String> onModeChanged;
  final ValueChanged<String> onMethodChanged;
  final ValueChanged<bool> onPaidChanged;
  final ValueChanged<double> onDeliveryFeeChanged;
  final VoidCallback onCheckout;

  /// «Pedir datos al cliente» con IA (solo con cliente elegido).
  final VoidCallback? onAskCustomerData;

  /// `delivery` (a domicilio) o `pickup` (retiro en tienda).
  final String deliveryMethod;
  final ValueChanged<String>? onDeliveryMethodChanged;

  /// Dirección de entrega: obligatoria para pedidos y facturas a domicilio.
  final TextEditingController? addressController;

  /// Notas del pedido (opcionales).
  final TextEditingController? notesController;

  /// Avisa de que cambió la dirección (para recalcular el borrador).
  final VoidCallback? onAddressChanged;

  /// Descuento general del ticket (`none` | `percent` | `amount`).
  final String discountType;
  final double discountValue;
  final void Function(String type, double value)? onDiscountChanged;

  /// Pedidos abiertos del cliente (`GET /api/admin/pos/context/:id`).
  final List<Map<String, dynamic>> openOrders;
  final bool loadingContext;
  final String? contextError;
  final VoidCallback? onReloadContext;

  /// Entrega programada (hora local del equipo, enviada en ISO con zona).
  final DateTime? scheduledAt;
  final ValueChanged<DateTime?>? onScheduleChanged;

  /// Referencia del lugar (texto libre, junto a la dirección).
  final TextEditingController? referenceController;

  int get _subtotalCents =>
      lines.fold<int>(0, (sum, line) => sum + line.grossCents);

  /// Misma regla que `discountCents()` de `pos-math.js`: el descuento se aplica
  /// sobre el subtotal y el total lo confirma el servidor al cobrar.
  int get _discountCents {
    if (discountType == 'none' || discountValue <= 0) return 0;
    final cents = discountType == 'percent'
        ? (_subtotalCents * discountValue / 100).round()
        : (discountValue * 100).round();
    return cents.clamp(0, _subtotalCents);
  }

  int get _totalCents =>
      _subtotalCents - _discountCents + (deliveryFee * 100).round();

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(left: BorderSide(color: p.border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _customerBar(context),
          if (openOrders.isNotEmpty || contextError != null) _openOrdersNotice(context),
          Divider(height: 1, color: p.borderSoft),
          // Líneas + documento + cobro + entrega + totales comparten UN solo
          // desplazamiento vertical; el botón de cobro queda SIEMPRE visible
          // como pie fijo. Antes, con la ventana a 681 px de alto, el pie podía
          // quedar tapado por las secciones y el cobro no recibía el clic.
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                if (lines.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text(
                      'El ticket está vacío.\nAgrega productos desde la rejilla.',
                      textAlign: TextAlign.center,
                      style: t.secondary,
                    ),
                  )
                else
                  for (var index = 0; index < lines.length; index += 1) ...[
                    if (index > 0) Divider(height: 1, color: p.borderSoft),
                    _line(context, lines[index]),
                  ],
                Divider(height: 1, color: p.border),
                _documentBar(context),
                _paymentBar(context),
                _deliveryBar(context),
                _totalsBar(context),
              ],
            ),
          ),
          _checkoutBar(context),
        ],
      ),
    );
  }

  Widget _customerBar(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    return SizedBox(
      height: 46,
      child: Row(
        children: [
          const SizedBox(width: 10),
          Expanded(
            child: InkWell(
              onTap: onPickCustomer,
              child: Row(
                children: [
                  Container(
                    width: 26,
                    height: 26,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: p.primarySoft,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    child: Icon(Icons.person_outline_rounded, size: 15, color: p.primary),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      customer?.name ?? 'Agregar cliente',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.body.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                  Icon(Icons.add_circle_outline_rounded, size: 16, color: p.primary),
                ],
              ),
            ),
          ),
          if (customer != null && onAskCustomerData != null)
            Tooltip(
              message: 'Pedir datos al cliente con IA',
              child: InkWell(
                onTap: onAskCustomerData,
                borderRadius: BorderRadius.circular(7),
                child: Container(
                  width: 26,
                  height: 26,
                  margin: const EdgeInsets.only(right: 4),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: p.primarySoft,
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Icon(Icons.auto_awesome_outlined, size: 15, color: p.primary),
                ),
              ),
            ),
          if (lines.isNotEmpty)
            TextButton(
              onPressed: onClear,
              style: TextButton.styleFrom(
                foregroundColor: p.inkSecondary,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 30),
              ),
              child: const Text('Vaciar', style: TextStyle(fontSize: 11.5)),
            ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }

  Widget _line(BuildContext context, PosLine line) {
    final p = PosPalette.of(context);
    final t = p.text;
    // Sin alto fijo: la fila mide lo que mide su contenido y nunca desborda.
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  line.productName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.body.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                CrmFormat.money(line.netCents / 100),
                style: t.body.copyWith(fontWeight: FontWeight.w800),
              ),
              IconButton(
                tooltip: line.discountType == 'none' ? 'Descuento en esta línea' : 'Descuento de la línea',
                onPressed: () => onLineDiscount(line),
                iconSize: 14,
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                color: line.discountType == 'none' ? p.inkSecondary : p.primary,
                icon: const Icon(Icons.percent_rounded),
              ),
              IconButton(
                tooltip: 'Quitar',
                onPressed: () => onRemove(line),
                iconSize: 14,
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                color: p.inkSecondary,
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
          Row(
            children: [
              Expanded(
                child: Text(
                  [
                    if (line.isManual) 'Fuera de inventario' else line.presentationName,
                    CrmFormat.money(line.unitPriceCents / 100),
                    if (line.lineDiscountCents > 0)
                      'desc. −${CrmFormat.money(line.lineDiscountCents / 100)}'
                          '${line.discountType == 'percent' ? ' (${line.discountValue.toStringAsFixed(line.discountValue % 1 == 0 ? 0 : 1)} %)' : ''}',
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.secondary.copyWith(fontSize: 10.5),
                ),
              ),
              _stepButton(context, Icons.remove_rounded, () => onQuantity(line, -1)),
              SizedBox(
                width: 24,
                child: Text(
                  '${line.quantity}',
                  textAlign: TextAlign.center,
                  style: t.body.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              _stepButton(context, Icons.add_rounded, () => onQuantity(line, 1)),
              const SizedBox(width: 4),
            ],
          ),
        ],
      ),
    );
  }

  Widget _stepButton(BuildContext context, IconData icon, VoidCallback onTap) {
    final p = PosPalette.of(context);
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          color: p.surfaceMuted,
          borderRadius: BorderRadius.circular(5),
          border: Border.all(color: p.border),
        ),
        child: Icon(icon, size: 14, color: p.ink),
      ),
    );
  }

  Widget _documentBar(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final entry in const [
            ('order', 'Pedido'),
            ('invoice', 'Factura'),
            ('quote', 'Cotización'),
          ])
            _chip(context, entry.$2, mode == entry.$1, () => onModeChanged(entry.$1)),
        ],
      ),
    );
  }

  Widget _paymentBar(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final entry in const [
            ('CASH', 'Efectivo'),
            ('TRANSFER', 'Transferencia'),
          ])
            _chip(context, entry.$2, method == entry.$1, () => onMethodChanged(entry.$1)),
          _chip(context, paid ? 'Pagado' : 'Por cobrar', paid, () => onPaidChanged(!paid)),
        ],
      ),
    );
  }

  Widget _chip(BuildContext context, String label, bool selected, VoidCallback onTap) {
    final p = PosPalette.of(context);
    final t = p.text;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? p.primarySoft : p.surfaceMuted,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          border: Border.all(color: selected ? p.primaryBorder : p.border),
        ),
        child: Text(
          label,
          style: t.pill.copyWith(
            color: selected ? p.primary : p.inkSecondary,
            fontSize: 11,
          ),
        ),
      ),
    );
  }

  /// Entrega: domicilio o retiro, dirección y notas.
  Widget _deliveryBar(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final domicilio = deliveryMethod != 'pickup';
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              _chip(context, 'Domicilio', domicilio, () => onDeliveryMethodChanged?.call('delivery')),
              _chip(context, 'Retiro', !domicilio, () => onDeliveryMethodChanged?.call('pickup')),
            ],
          ),
          if (domicilio && addressController != null) ...[
            const SizedBox(height: 6),
            SizedBox(
              height: 34,
              child: TextField(
                controller: addressController,
                style: t.body,
                decoration: InputDecoration(
                  isDense: true,
                  filled: false,
                  hintText: 'Dirección de entrega',
                  hintStyle: t.secondary,
                  prefixIcon: Icon(Icons.place_outlined, size: 16, color: p.inkSecondary),
                  prefixIconConstraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.border),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.border),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.primary),
                  ),
                ),
                onChanged: (_) => onAddressChanged?.call(),
              ),
            ),
            if (referenceController != null) ...[
              const SizedBox(height: 6),
              SizedBox(
                height: 32,
                child: TextField(
                  controller: referenceController,
                  style: t.body,
                  maxLength: 240,
                  buildCounter: (_, {required currentLength, required isFocused, maxLength}) => null,
                  decoration: InputDecoration(
                    isDense: true,
                    filled: false,
                    hintText: 'Referencia (portón, color, piso…)',
                    hintStyle: t.secondary,
                    prefixIcon: Icon(Icons.flag_outlined, size: 15, color: p.inkSecondary),
                    prefixIconConstraints: const BoxConstraints(minWidth: 32, minHeight: 30),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(6),
                      borderSide: BorderSide(color: p.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(6),
                      borderSide: BorderSide(color: p.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(6),
                      borderSide: BorderSide(color: p.primary),
                    ),
                  ),
                  onChanged: (_) => onAddressChanged?.call(),
                ),
              ),
            ],
            _scheduleRow(context),
          ],
          if (notesController != null) ...[
            const SizedBox(height: 6),
            SizedBox(
              height: 32,
              child: TextField(
                controller: notesController,
                style: t.body,
                decoration: InputDecoration(
                  isDense: true,
                  filled: false,
                  hintText: 'Notas del pedido (opcional)',
                  hintStyle: t.secondary,
                  prefixIcon: Icon(Icons.notes_rounded, size: 15, color: p.inkSecondary),
                  prefixIconConstraints: const BoxConstraints(minWidth: 32, minHeight: 30),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.border),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.border),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                    borderSide: BorderSide(color: p.primary),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// Programación de la entrega. Se elige fecha y hora LOCALES; se envía en
  /// ISO-8601 con la zona del equipo (el servidor valida que no esté en el
  /// pasado y responde `schedule_in_past` en el caso guiado).
  Widget _scheduleRow(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final at = scheduledAt;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Icon(Icons.event_outlined, size: 16, color: p.inkSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              at == null
                  ? 'Entrega sin programar'
                  : 'Programada: ${CrmFormat.dayFull(at.toIso8601String())} · ${CrmFormat.time(at.toIso8601String())}',
              style: t.secondary.copyWith(fontSize: 11.5),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (at != null)
            IconButton(
              tooltip: 'Quitar programación',
              onPressed: () => onScheduleChanged?.call(null),
              iconSize: 16,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              color: p.inkSecondary,
              icon: const Icon(Icons.close_rounded),
            ),
          TextButton(
            onPressed: () async {
              final now = DateTime.now();
              final date = await showDatePicker(
                context: context,
                initialDate: at ?? now,
                firstDate: DateTime(now.year, now.month, now.day),
                lastDate: now.add(const Duration(days: 365)),
                helpText: 'Fecha de entrega',
              );
              if (date == null || !context.mounted) return;
              final time = await showTimePicker(
                context: context,
                initialTime: TimeOfDay.fromDateTime(at ?? now.add(const Duration(hours: 2))),
                helpText: 'Hora de entrega',
              );
              if (time == null) return;
              onScheduleChanged?.call(DateTime(date.year, date.month, date.day, time.hour, time.minute));
            },
            child: Text(at == null ? 'Programar' : 'Cambiar', style: const TextStyle(fontSize: 11.5)),
          ),
        ],
      ),
    );
  }

  Widget _totalsBar(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(child: Text('Subtotal', style: t.secondary)),
              Text(
                CrmFormat.money(_subtotalCents / 100),
                style: t.body.copyWith(fontWeight: FontWeight.w800),
              ),
            ],
          ),
          const SizedBox(height: 4),
          _discountRow(context),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(child: Text('Envío', style: t.secondary)),
              SizedBox(
                width: 92,
                height: 30,
                child: TextFormField(
                  initialValue: deliveryFee == 0 ? '' : deliveryFee.toStringAsFixed(2),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  textAlign: TextAlign.right,
                  style: t.body,
                  decoration: InputDecoration(
                    isDense: true,
                    filled: false,
                    hintText: '0.00',
                    hintStyle: t.secondary,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    border: OutlineInputBorder(
                      borderRadius: const BorderRadius.all(Radius.circular(6)),
                      borderSide: BorderSide(color: p.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: const BorderRadius.all(Radius.circular(6)),
                      borderSide: BorderSide(color: p.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: const BorderRadius.all(Radius.circular(6)),
                      borderSide: BorderSide(color: p.primary),
                    ),
                  ),
                  onChanged: (value) => onDeliveryFeeChanged(
                    double.tryParse(value.replaceAll(',', '.')) ?? 0,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Descuento general: dos modos (porcentaje o pesos) y el valor.
  /// El descuento NUNCA se calcula aquí como cifra definitiva: viaja al servidor,
  /// que aplica `discountCents()` y devuelve el total real.
  Widget _discountRow(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final percent = discountType == 'percent';
    final amount = discountType == 'amount';
    Widget chip(String label, bool active, VoidCallback onTap) => InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: active ? p.primary : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: active ? p.primary : p.border),
            ),
            child: Text(
              label,
              style: t.body.copyWith(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: active ? p.onCheckout : p.inkSecondary,
              ),
            ),
          ),
        );
    return Row(
      children: [
        Expanded(child: Text('Descuento', style: t.secondary)),
        if (onDiscountChanged != null) ...[
          chip('%', percent, () => onDiscountChanged!(percent ? 'none' : 'percent', discountValue)),
          const SizedBox(width: 4),
          chip('\$', amount, () => onDiscountChanged!(amount ? 'none' : 'amount', discountValue)),
          const SizedBox(width: 4),
        ],
        SizedBox(
          width: 78,
          height: 30,
          child: TextFormField(
            initialValue: discountValue == 0
                ? ''
                : (percent ? discountValue.toStringAsFixed(discountValue % 1 == 0 ? 0 : 1) : discountValue.toStringAsFixed(2)),
            enabled: discountType != 'none' && onDiscountChanged != null,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textAlign: TextAlign.right,
            style: t.body,
            decoration: InputDecoration(
              isDense: true,
              filled: false,
              hintText: '0',
              hintStyle: t.secondary,
              contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              border: OutlineInputBorder(
                borderRadius: const BorderRadius.all(Radius.circular(6)),
                borderSide: BorderSide(color: p.border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: const BorderRadius.all(Radius.circular(6)),
                borderSide: BorderSide(color: p.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: const BorderRadius.all(Radius.circular(6)),
                borderSide: BorderSide(color: p.primary),
              ),
            ),
            onChanged: (value) => onDiscountChanged?.call(
              discountType == 'none' ? 'percent' : discountType,
              double.tryParse(value.replaceAll(',', '.')) ?? 0,
            ),
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 74,
          child: Text(
            _discountCents == 0 ? '—' : '-${CrmFormat.money(_discountCents / 100)}',
            textAlign: TextAlign.right,
            style: t.body.copyWith(fontSize: 11.5, color: _discountCents == 0 ? p.inkSecondary : p.danger),
          ),
        ),
      ],
    );
  }

  /// Aviso de pedidos abiertos del cliente. Es INFORMATIVO: quien impide el
  /// doble cobro es el servidor (`409 open_orders` + confirmación explícita).
  Widget _openOrdersNotice(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    if (contextError != null) {
      return Container(
        width: double.infinity,
        color: p.surfaceMuted,
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'No se pudo consultar si el cliente tiene pedidos abiertos: $contextError',
                style: t.pill.copyWith(fontSize: 11.5),
              ),
            ),
            if (onReloadContext != null)
              TextButton(
                onPressed: onReloadContext,
                child: const Text('Reintentar', style: TextStyle(fontSize: 11.5)),
              ),
          ],
        ),
      );
    }
    final numbers = [
      for (final row in openOrders.take(3))
        str(row['order_number'], str(row['number'], str(row['id']))),
    ];
    final extra = openOrders.length > 3 ? ' y ${openOrders.length - 3} más' : '';
    return Container(
      width: double.infinity,
      color: p.surfaceMuted,
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      child: Row(
        children: [
          Icon(Icons.info_outline_rounded, size: 16, color: p.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              openOrders.length == 1
                  ? 'Este cliente ya tiene un pedido abierto (${numbers.join(', ')})$extra. Al cobrar se pedirá confirmación.'
                  : 'Este cliente tiene ${openOrders.length} pedidos abiertos (${numbers.join(', ')})$extra. Al cobrar se pedirá confirmación.',
              style: t.pill.copyWith(fontSize: 11.5),
            ),
          ),
        ],
      ),
    );
  }

  Widget _checkoutBar(BuildContext context) {    final p = PosPalette.of(context);
    final t = p.text;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
      child: SizedBox(
        height: 58,
        child: Material(
          color: p.checkout,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          child: InkWell(
            borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
            onTap: saving ? null : onCheckout,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  saving
                      ? SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: p.onCheckout,
                          ),
                        )
                      : Text(
                          switch (mode) {
                            'quote' => 'Guardar cotización',
                            'order' => 'Crear pedido',
                            _ => 'Cobrar',
                          },
                          style: t.checkoutLabel,
                        ),
                  const SizedBox(width: 8),
                  const Spacer(),
                  Flexible(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerRight,
                      child: Text(
                        CrmFormat.money(_totalCents / 100),
                        style: t.total,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
