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
    required this.onPickCustomer,
    required this.onClear,
    required this.onModeChanged,
    required this.onMethodChanged,
    required this.onPaidChanged,
    required this.onDeliveryFeeChanged,
    required this.onCheckout,
    this.deliveryMethod = 'delivery',
    this.onDeliveryMethodChanged,
    this.addressController,
    this.notesController,
    this.onAddressChanged,
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
  final VoidCallback onPickCustomer;
  final VoidCallback onClear;
  final ValueChanged<String> onModeChanged;
  final ValueChanged<String> onMethodChanged;
  final ValueChanged<bool> onPaidChanged;
  final ValueChanged<double> onDeliveryFeeChanged;
  final VoidCallback onCheckout;

  /// `delivery` (a domicilio) o `pickup` (retiro en tienda).
  final String deliveryMethod;
  final ValueChanged<String>? onDeliveryMethodChanged;

  /// Dirección de entrega: obligatoria para pedidos y facturas a domicilio.
  final TextEditingController? addressController;

  /// Notas del pedido (opcionales).
  final TextEditingController? notesController;

  /// Avisa de que cambió la dirección (para recalcular el borrador).
  final VoidCallback? onAddressChanged;

  int get _subtotalCents =>
      lines.fold<int>(0, (sum, line) => sum + line.grossCents);
  int get _totalCents => _subtotalCents + (deliveryFee * 100).round();

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
          Divider(height: 1, color: p.borderSoft),
          Expanded(
            child: lines.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Text(
                        'El ticket está vacío.\nAgrega productos desde la rejilla.',
                        textAlign: TextAlign.center,
                        style: t.secondary,
                      ),
                    ),
                  )
                : ListView.separated(
                    itemCount: lines.length,
                    separatorBuilder: (_, _) => Divider(height: 1, color: p.borderSoft),
                    itemBuilder: (context, index) => _line(context, lines[index]),
                  ),
          ),
          Divider(height: 1, color: p.border),
          _documentBar(context),
          _paymentBar(context),
          _deliveryBar(context),
          _totalsBar(context),
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
                CrmFormat.money(line.grossCents / 100),
                style: t.body.copyWith(fontWeight: FontWeight.w800),
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
                  '${line.presentationName} · ${CrmFormat.money(line.unitPriceCents / 100)}',
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

  Widget _checkoutBar(BuildContext context) {
    final p = PosPalette.of(context);
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
