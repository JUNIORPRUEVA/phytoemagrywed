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

  int get _subtotalCents =>
      lines.fold<int>(0, (sum, line) => sum + line.grossCents);
  int get _totalCents => _subtotalCents + (deliveryFee * 100).round();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: PosColors.surface,
        border: Border(left: BorderSide(color: PosColors.border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _customerBar(),
          const Divider(height: 1, color: PosColors.borderSoft),
          Expanded(
            child: lines.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Text(
                        'El ticket está vacío.\nAgrega productos desde la rejilla.',
                        textAlign: TextAlign.center,
                        style: PosText.secondary,
                      ),
                    ),
                  )
                : ListView.separated(
                    itemCount: lines.length,
                    separatorBuilder: (_, _) =>
                        const Divider(height: 1, color: PosColors.borderSoft),
                    itemBuilder: (context, index) => _line(lines[index]),
                  ),
          ),
          const Divider(height: 1, color: PosColors.border),
          _documentBar(),
          _paymentBar(),
          _totalsBar(),
          _checkoutBar(),
        ],
      ),
    );
  }

  Widget _customerBar() {
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
                      color: PosColors.primarySoft,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    child: const Icon(
                      Icons.person_outline_rounded,
                      size: 15,
                      color: PosColors.primary,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      customer?.name ?? 'Agregar cliente',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: PosText.body.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                  const Icon(
                    Icons.add_circle_outline_rounded,
                    size: 16,
                    color: PosColors.primary,
                  ),
                ],
              ),
            ),
          ),
          if (lines.isNotEmpty)
            TextButton(
              onPressed: onClear,
              style: TextButton.styleFrom(
                foregroundColor: PosColors.inkSecondary,
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

  Widget _line(PosLine line) {
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
                  style: PosText.body.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                CrmFormat.money(line.grossCents / 100),
                style: PosText.body.copyWith(fontWeight: FontWeight.w800),
              ),
              IconButton(
                tooltip: 'Quitar',
                onPressed: () => onRemove(line),
                iconSize: 14,
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                color: PosColors.inkSecondary,
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
                  style: PosText.secondary.copyWith(fontSize: 10.5),
                ),
              ),
              _stepButton(Icons.remove_rounded, () => onQuantity(line, -1)),
              SizedBox(
                width: 24,
                child: Text(
                  '${line.quantity}',
                  textAlign: TextAlign.center,
                  style: PosText.body.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              _stepButton(Icons.add_rounded, () => onQuantity(line, 1)),
              const SizedBox(width: 4),
            ],
          ),
        ],
      ),
    );
  }

  Widget _stepButton(IconData icon, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          color: PosColors.surfaceMuted,
          borderRadius: BorderRadius.circular(5),
          border: Border.all(color: PosColors.border),
        ),
        child: Icon(icon, size: 14, color: PosColors.ink),
      ),
    );
  }

  Widget _documentBar() {
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
            _chip(entry.$2, mode == entry.$1, () => onModeChanged(entry.$1)),
        ],
      ),
    );
  }

  Widget _paymentBar() {
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
            _chip(
              entry.$2,
              method == entry.$1,
              () => onMethodChanged(entry.$1),
            ),
          _chip(
            paid ? 'Pagado' : 'Por cobrar',
            paid,
            () => onPaidChanged(!paid),
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, bool selected, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? PosColors.primarySoft : PosColors.surfaceMuted,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          border: Border.all(
            color: selected ? PosColors.primaryBorder : PosColors.border,
          ),
        ),
        child: Text(
          label,
          style: PosText.pill.copyWith(
            color: selected ? PosColors.primary : PosColors.inkSecondary,
            fontSize: 11,
          ),
        ),
      ),
    );
  }

  Widget _totalsBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(child: Text('Subtotal', style: PosText.secondary)),
              Text(
                CrmFormat.money(_subtotalCents / 100),
                style: PosText.body.copyWith(fontWeight: FontWeight.w800),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(child: Text('Envío', style: PosText.secondary)),
              SizedBox(
                width: 92,
                height: 30,
                child: TextFormField(
                  initialValue: deliveryFee == 0
                      ? ''
                      : deliveryFee.toStringAsFixed(2),
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  textAlign: TextAlign.right,
                  style: PosText.body,
                  decoration: const InputDecoration(
                    isDense: true,
                    hintText: '0.00',
                    contentPadding: EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 8,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.all(Radius.circular(6)),
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

  Widget _checkoutBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
      child: SizedBox(
        height: 58,
        child: Material(
          color: PosColors.checkout,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          child: InkWell(
            borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
            onTap: saving ? null : onCheckout,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: PosColors.surface,
                          ),
                        )
                      : const Text('Cobrar', style: PosText.checkoutLabel),
                  const SizedBox(width: 8),
                  const Spacer(),
                  Flexible(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerRight,
                      child: Text(
                        CrmFormat.money(_totalCents / 100),
                        style: PosText.total,
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
