import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import 'pos_tokens.dart';

/// Confirmación de caja para facturas. El servidor registra el importe del
/// ticket; el efectivo recibido solo calcula la devolución en esta pantalla.
Future<String?> showPosCheckoutDialog(
  BuildContext context, {
  required int totalCents,
  required String initialMethod,
}) async {
  final controller = TextEditingController(
    text: (totalCents / 100).toStringAsFixed(2),
  );
  var method = initialMethod;
  String? error;
  final chosen = await showDialog<String>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, update) {
        final p = PosPalette.of(dialogContext);
        final paid = double.tryParse(
          controller.text.trim().replaceAll(',', ''),
        );
        final change = paid == null
            ? null
            : ((paid * 100).round() - totalCents);
        return Dialog(
          backgroundColor: p.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.all(22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.point_of_sale_rounded, color: p.primary),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Cobrar venta', style: p.text.title),
                              Text(
                                'Confirma el pago y genera la factura',
                                style: p.text.secondary,
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.pop(dialogContext),
                          tooltip: 'Cerrar',
                          icon: const Icon(Icons.close_rounded),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        border: Border.all(color: p.border),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Column(
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Total a pagar',
                                  style: p.text.body,
                                ),
                              ),
                              Text(
                                CrmFormat.money(totalCents / 100),
                                style: p.text.title.copyWith(fontSize: 25),
                              ),
                            ],
                          ),
                          if (method == 'CASH') ...[
                            Divider(height: 24, color: p.border),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    'Cliente paga con',
                                    style: p.text.body,
                                  ),
                                ),
                                SizedBox(
                                  width: 160,
                                  child: TextField(
                                    controller: controller,
                                    textAlign: TextAlign.right,
                                    keyboardType:
                                        const TextInputType.numberWithOptions(
                                          decimal: true,
                                        ),
                                    decoration: const InputDecoration(
                                      prefixText: 'RD\$ ',
                                      isDense: true,
                                      border: OutlineInputBorder(),
                                    ),
                                    onChanged: (_) =>
                                        update(() => error = null),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: () => update(() {
                                  controller.text = (totalCents / 100)
                                      .toStringAsFixed(2);
                                  error = null;
                                }),
                                child: const Text('Exacto'),
                              ),
                            ),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    'Devolución',
                                    style: p.text.secondary,
                                  ),
                                ),
                                Text(
                                  CrmFormat.money(
                                    ((change ?? 0).clamp(0, 1 << 62)) / 100,
                                  ),
                                  style: p.text.body.copyWith(
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'Método de pago',
                      style: p.text.body.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        for (final option in const [
                          ('CASH', 'Efectivo', Icons.payments_outlined),
                          (
                            'TRANSFER',
                            'Transferencia',
                            Icons.account_balance_outlined,
                          ),
                        ]) ...[
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () => update(() {
                                method = option.$1;
                                error = null;
                              }),
                              icon: Icon(option.$3, size: 18),
                              label: Text(option.$2),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: method == option.$1
                                    ? p.onCheckout
                                    : p.ink,
                                backgroundColor: method == option.$1
                                    ? p.checkout
                                    : p.surface,
                                minimumSize: const Size(0, 42),
                              ),
                            ),
                          ),
                          if (option.$1 == 'CASH') const SizedBox(width: 8),
                        ],
                      ],
                    ),
                    if (error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          error!,
                          style: p.text.secondary.copyWith(color: p.danger),
                        ),
                      ),
                    const SizedBox(height: 20),
                    Row(
                      children: [
                        const Spacer(),
                        TextButton(
                          onPressed: () => Navigator.pop(dialogContext),
                          child: const Text('Cancelar'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton.icon(
                          onPressed: () {
                            if (method == 'CASH' &&
                                (change == null || change < 0)) {
                              update(
                                () => error =
                                    'El efectivo recibido debe cubrir el total.',
                              );
                              return;
                            }
                            Navigator.pop(dialogContext, method);
                          },
                          icon: const Icon(
                            Icons.receipt_long_rounded,
                            size: 18,
                          ),
                          label: const Text('Cobrar y facturar'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    ),
  );
  // La ruta aún termina su animación después de que showDialog devuelve.
  await Future<void>.delayed(const Duration(milliseconds: 300));
  controller.dispose();
  return chosen;
}
