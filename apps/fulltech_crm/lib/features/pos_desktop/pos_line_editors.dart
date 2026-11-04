import 'dart:math';

import 'package:flutter/material.dart';

import '../../core/pos/pos_sale.dart';
import 'pos_tokens.dart';

/// Editor compacto para el doble clic en una línea del ticket.
Future<PosLine?> showPosLineQuickEditDialog(
  BuildContext context, {
  required PosLine line,
}) {
  final quantity = TextEditingController(text: '${line.quantity}');
  final discount = TextEditingController(
    text: line.discountType == 'percent' && line.discountValue > 0
        ? '${line.discountValue}'
        : '0',
  );
  String? error;
  return showDialog<PosLine>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: Text(
          line.productName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        contentPadding: const EdgeInsets.fromLTRB(24, 12, 24, 0),
        content: SizedBox(
          width: 290,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: quantity,
                      autofocus: true,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Cantidad',
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      controller: discount,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: const InputDecoration(
                        labelText: 'Descuento %',
                        isDense: true,
                        suffixText: '%',
                      ),
                    ),
                  ),
                ],
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    error!,
                    style: const TextStyle(color: Colors.red, fontSize: 12),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () {
              final count = int.tryParse(quantity.text.trim());
              final percent = double.tryParse(
                discount.text.trim().replaceAll(',', '.'),
              );
              if (count == null ||
                  count < 1 ||
                  count > 9999 ||
                  percent == null ||
                  !percent.isFinite ||
                  percent < 0 ||
                  percent > 100) {
                setDialogState(
                  () => error = 'Cantidad: 1–9999. Descuento: 0–100%.',
                );
                return;
              }
              Navigator.of(dialogContext).pop(
                line.copyWith(
                  quantity: count,
                  discountType: percent > 0 ? 'percent' : 'none',
                  discountValue: percent,
                ),
              );
            },
            child: const Text('Aplicar'),
          ),
        ],
      ),
    ),
  ).whenComplete(() {
    quantity.dispose();
    discount.dispose();
  });
}

/// Diálogo de descuento de UNA línea del ticket.
///
/// La regla del dinero NO se decide aquí: el servidor aplica
/// `discountCents(gross, line.discount)` de `public/admin/pos-math.js` y vuelve
/// a calcularlo todo al cobrar. Este diálogo solo recoge `{type, value}` y
/// muestra una previsualización con la MISMA fórmula (probada en el fixture
/// compartido `test/fixtures/pos_money_cases.json`).
Future<PosLine?> showLineDiscountDialog(
  BuildContext context, {
  required PosLine line,
}) {
  final p = PosPalette.of(context);
  var type = line.discountType == 'none' ? 'percent' : line.discountType;
  final controller = TextEditingController(
    text: line.discountValue == 0
        ? ''
        : (type == 'percent'
              ? line.discountValue.toStringAsFixed(
                  line.discountValue % 1 == 0 ? 0 : 1,
                )
              : line.discountValue.toStringAsFixed(2)),
  );
  String? error;

  return showDialog<PosLine>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) {
        double value() =>
            double.tryParse(controller.text.replaceAll(',', '.')) ?? 0;
        PosLine preview() => line.copyWith(
          discountType: value() > 0 ? type : 'none',
          discountValue: value() > 0 ? value() : 0,
        );

        return AlertDialog(
          title: Text('Descuento · ${line.productName}'),
          content: SizedBox(
            width: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Precio ${CrmFormatMoney.of(line.unitPriceCents)} × ${line.quantity} = '
                  '${CrmFormatMoney.of(line.grossCents)}',
                  style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    ChoiceChip(
                      label: const Text('%'),
                      selected: type == 'percent',
                      onSelected: (_) => setDialogState(() => type = 'percent'),
                    ),
                    const SizedBox(width: 8),
                    ChoiceChip(
                      label: const Text('\$'),
                      selected: type == 'amount',
                      onSelected: (_) => setDialogState(() => type = 'amount'),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextField(
                        controller: controller,
                        autofocus: true,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: InputDecoration(
                          isDense: true,
                          labelText: type == 'percent' ? 'Porcentaje' : 'Pesos',
                        ),
                        onChanged: (_) => setDialogState(() => error = null),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'Queda en ${CrmFormatMoney.of(preview().netCents)}'
                  '${preview().lineDiscountCents > 0 ? ' (−${CrmFormatMoney.of(preview().lineDiscountCents)})' : ''}',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: p.ink,
                  ),
                ),
                if (value() < 0) const SizedBox.shrink(),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      error!,
                      style: TextStyle(fontSize: 12, color: p.danger),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(
                dialogContext,
              ).pop(line.copyWith(discountType: 'none', discountValue: 0)),
              child: const Text('Sin descuento'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () {
                final percent = type == 'percent';
                final current = value();
                if (current < 0) {
                  setDialogState(
                    () => error = 'El descuento no puede ser negativo.',
                  );
                  return;
                }
                if (percent && current > 100) {
                  setDialogState(
                    () => error = 'El porcentaje no puede superar 100.',
                  );
                  return;
                }
                if (current == 0) {
                  Navigator.of(
                    dialogContext,
                  ).pop(line.copyWith(discountType: 'none', discountValue: 0));
                  return;
                }
                Navigator.of(dialogContext).pop(
                  line.copyWith(discountType: type, discountValue: current),
                );
              },
              child: const Text('Aplicar'),
            ),
          ],
        );
      },
    ),
  );
}

/// Venta FUERA DE INVENTARIO (`manual_*` en `pos-math.js`).
///
/// El servidor exige: `variantId` con forma `manual_[A-Za-z0-9_-]{16,80}`,
/// nombre no vacío de hasta 150 caracteres, precio válido y costo opcional.
/// La línea se crea como producto `track_stock: false`: **no** descuenta
/// cápsulas ni crea un producto en el catálogo. Nunca se inventa stock.
Future<PosLine?> showManualSaleDialog(BuildContext context) {
  final p = PosPalette.of(context);
  final name = TextEditingController();
  final quantity = TextEditingController(text: '1');
  final price = TextEditingController();
  final cost = TextEditingController(text: '0');
  var kind = 'product';
  String? error;

  return showDialog<PosLine>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: const Text('Venta fuera de inventario'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: name,
                autofocus: true,
                maxLength: 150,
                decoration: const InputDecoration(labelText: 'Descripción'),
              ),
              DropdownButtonFormField<String>(
                initialValue: kind,
                // Sin `isExpanded` el desplegable mide lo que mide su texto y
                // desborda la fila en cuanto la etiqueta es larga.
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Tipo'),
                items: const [
                  DropdownMenuItem(
                    value: 'product',
                    child: Text('Producto fuera de inventario'),
                  ),
                  DropdownMenuItem(
                    value: 'service',
                    child: Text('Servicio ocasional'),
                  ),
                ],
                onChanged: (value) =>
                    setDialogState(() => kind = value ?? 'product'),
              ),
              const SizedBox(height: 10),
              // Wrap en vez de Row: en ventanas estrechas (o con métricas de
              // fuente anchas, como en las pruebas de widgets) los tres campos
              // se reacomodan en varias líneas en lugar de desbordar.
              Wrap(
                spacing: 10,
                runSpacing: 8,
                children: [
                  SizedBox(
                    width: 112,
                    child: TextField(
                      controller: quantity,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(labelText: 'Cantidad'),
                    ),
                  ),
                  SizedBox(
                    width: 112,
                    child: TextField(
                      controller: price,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: const InputDecoration(
                        labelText: 'Precio unitario',
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 112,
                    child: TextField(
                      controller: cost,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: const InputDecoration(
                        labelText: 'Costo unitario',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                'Se verá en el comprobante sin crear un producto ni modificar existencias.',
                style: TextStyle(fontSize: 12, color: p.inkSecondary),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    error!,
                    style: TextStyle(fontSize: 12.5, color: p.danger),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () {
              final description = name.text.trim();
              final qty = int.tryParse(quantity.text.trim()) ?? 0;
              final unitPrice = double.tryParse(
                price.text.trim().replaceAll(',', '.'),
              );
              final unitCost =
                  double.tryParse(cost.text.trim().replaceAll(',', '.')) ?? 0;
              if (description.isEmpty) {
                setDialogState(() => error = 'Escribe una descripción.');
                return;
              }
              if (description.length > 150) {
                setDialogState(
                  () =>
                      error = 'La descripción no puede superar 150 caracteres.',
                );
                return;
              }
              if (qty < 1 || qty > 9999) {
                setDialogState(
                  () => error = 'La cantidad debe estar entre 1 y 9999.',
                );
                return;
              }
              if (unitPrice == null || unitPrice < 0) {
                setDialogState(
                  () => error = 'Escribe un precio unitario válido.',
                );
                return;
              }
              if (unitCost < 0) {
                setDialogState(() => error = 'El costo no puede ser negativo.');
                return;
              }
              Navigator.of(dialogContext).pop(
                PosLine(
                  // Misma forma que el PWA: `manual_` + 16-80 caracteres válidos.
                  variantId: 'manual_${randomManualSuffix()}',
                  productName: description,
                  presentationName: kind == 'service'
                      ? 'Servicio'
                      : 'Fuera de inventario',
                  unitPriceCents: (unitPrice * 100).round(),
                  quantity: qty,
                  manualName: description,
                  manualKind: kind,
                  manualPrice: unitPrice,
                  manualCost: unitCost,
                ),
              );
            },
            child: const Text('Agregar al ticket'),
          ),
        ],
      ),
    ),
  );
}

class PosManualSalePanel extends StatefulWidget {
  const PosManualSalePanel({super.key, required this.onAdd});

  final ValueChanged<PosLine> onAdd;

  @override
  State<PosManualSalePanel> createState() => _PosManualSalePanelState();
}

class _PosManualSalePanelState extends State<PosManualSalePanel> {
  final _name = TextEditingController();
  final _quantity = TextEditingController(text: '1');
  final _price = TextEditingController();
  final _cost = TextEditingController(text: '0');
  String _kind = 'product';
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _quantity.dispose();
    _price.dispose();
    _cost.dispose();
    super.dispose();
  }

  void _add() {
    final description = _name.text.trim();
    final quantity = int.tryParse(_quantity.text.trim()) ?? 0;
    final price = double.tryParse(_price.text.trim().replaceAll(',', '.'));
    final cost = double.tryParse(_cost.text.trim().replaceAll(',', '.')) ?? 0;
    if (description.isEmpty) {
      setState(() => _error = 'Escribe una descripción.');
      return;
    }
    if (description.length > 150) {
      setState(
        () => _error = 'La descripción no puede superar 150 caracteres.',
      );
      return;
    }
    if (quantity < 1 || quantity > 9999) {
      setState(() => _error = 'La cantidad debe estar entre 1 y 9999.');
      return;
    }
    if (price == null || price < 0) {
      setState(() => _error = 'Escribe un precio unitario válido.');
      return;
    }
    if (cost < 0) {
      setState(() => _error = 'El costo no puede ser negativo.');
      return;
    }
    widget.onAdd(
      PosLine(
        variantId: 'manual_${randomManualSuffix()}',
        productName: description,
        presentationName: _kind == 'service'
            ? 'Servicio'
            : 'Fuera de inventario',
        unitPriceCents: (price * 100).round(),
        quantity: quantity,
        manualName: description,
        manualKind: _kind,
        manualPrice: price,
        manualCost: cost,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(0, 2, 0, 8),
            children: [
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Descripción'),
              ),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                initialValue: _kind,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Tipo'),
                items: const [
                  DropdownMenuItem(
                    value: 'product',
                    child: Text('Producto fuera de inventario'),
                  ),
                  DropdownMenuItem(
                    value: 'service',
                    child: Text('Servicio ocasional'),
                  ),
                ],
                onChanged: (value) =>
                    setState(() => _kind = value ?? 'product'),
              ),
              const SizedBox(height: 4),
              LayoutBuilder(
                builder: (context, constraints) {
                  final fieldWidth = (constraints.maxWidth - 8) / 2;
                  return Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      SizedBox(
                        width: fieldWidth,
                        child: TextField(
                          controller: _quantity,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Cantidad',
                          ),
                        ),
                      ),
                      SizedBox(
                        width: fieldWidth,
                        child: TextField(
                          controller: _price,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: 'Precio unitario',
                          ),
                        ),
                      ),
                      SizedBox(
                        width: fieldWidth,
                        child: TextField(
                          controller: _cost,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: 'Costo unitario',
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    _error!,
                    style: TextStyle(fontSize: 12.5, color: p.danger),
                  ),
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(0, 4, 0, 8),
          child: FilledButton.icon(
            onPressed: _add,
            icon: const Icon(Icons.add_rounded),
            label: const Text('Agregar al ticket'),
          ),
        ),
      ],
    );
  }
}

/// 32 caracteres hexadecimales, dentro del rango que exige el servidor.
String randomManualSuffix() {
  final random = Random.secure();
  return List.generate(32, (_) => random.nextInt(16).toRadixString(16)).join();
}

/// Formato de dinero local para no arrastrar dependencias de pantalla.
abstract final class CrmFormatMoney {
  static String of(int cents) {
    final whole = (cents.abs() ~/ 100).toString();
    final decimals = (cents.abs() % 100).toString().padLeft(2, '0');
    final grouped = whole.replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]},',
    );
    return '${cents < 0 ? '−' : ''}RD\$ $grouped.$decimals';
  }
}
