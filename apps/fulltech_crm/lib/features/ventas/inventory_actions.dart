import 'package:flutter/material.dart';

import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/crm_repository.dart';
import '../common/crm_ui.dart';

/// Diálogos de las escrituras de inventario legacy (cápsulas compartidas).
///
/// Regla de esta capa: **el cliente solo recoge datos y muestra el resultado**.
/// La cantidad resultante, la diferencia del recuento y el valor los calcula
/// `server/inventory.mjs`; aquí no se suma ni se resta stock nunca. Cada envío
/// lleva su `idempotencyKey`, así que un reintento no duplica el movimiento.
///
/// Todas las rutas exigen rol ADMIN: si el usuario no lo es, el botón ni se
/// muestra (`session.can('admin.full')`) y, si aun así se llamara, el servidor
/// responde 403 con su propio mensaje.

enum InventoryAction { restock, adjustIn, adjustOut, count, cost }

String inventoryActionLabel(InventoryAction action) => switch (action) {
      InventoryAction.restock => 'Reponer',
      InventoryAction.adjustIn => 'Ajustar +',
      InventoryAction.adjustOut => 'Ajustar −',
      InventoryAction.count => 'Recuento',
      InventoryAction.cost => 'Costo',
    };

/// Ejecuta la acción elegida. Devuelve `true` si el servidor la aceptó.
Future<bool> runInventoryAction(
  BuildContext context, {
  required CrmRepository repository,
  required InventoryAction action,
  int? currentStock,
  double? currentUnitCost,
}) async {
  final p = context.crm;
  final form = await showDialog<_ActionForm>(
    context: context,
    builder: (dialogContext) => _ActionDialog(
      action: action,
      currentStock: currentStock,
      currentUnitCost: currentUnitCost,
      palette: p,
    ),
  );
  if (form == null || !context.mounted) return false;

  final key = newOperationKey(switch (action) {
    InventoryAction.restock => 'rst',
    InventoryAction.adjustIn => 'adj',
    InventoryAction.adjustOut => 'adj',
    InventoryAction.count => 'cnt',
    InventoryAction.cost => 'cst',
  });

  String? error;
  try {
    final result = await switch (action) {
      InventoryAction.restock => repository.restockInventory(
          quantity: form.quantity!,
          unitCost: form.unitCost,
          reason: form.reason,
          operationKey: key,
        ),
      InventoryAction.adjustIn => repository.adjustInventory(
          incoming: true,
          quantity: form.quantity!,
          unitCost: form.unitCost,
          reason: form.reason,
          operationKey: key,
        ),
      InventoryAction.adjustOut => repository.adjustInventory(
          incoming: false,
          quantity: form.quantity!,
          unitCost: form.unitCost,
          reason: form.reason,
          operationKey: key,
        ),
      InventoryAction.count => repository.countInventory(
          countedQuantity: form.quantity!,
          reason: form.reason,
          operationKey: key,
        ),
      InventoryAction.cost => repository.updateInventoryCost(
          unitCost: form.unitCost!,
          operationKey: key,
        ),
    };
    // El servidor devuelve el inventario ya recalculado: se muestra SU cifra.
    final stock = inventoryStockFromResponse(result);
    if (!context.mounted) return true;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(stock == null
            ? 'Movimiento registrado.'
            : 'Movimiento registrado. El servidor informa de $stock cápsulas en stock.'),
      ),
    );
    return true;
  } on ApiException catch (exception) {
    error = exception.isUncertain
        ? 'No sabemos si el movimiento llegó al servidor. Recarga antes de repetir.'
        : exception.message;
  }
  if (!context.mounted) return false;
  await crmConfirm(
    context,
    title: 'No se pudo registrar',
    message: error,
    confirmLabel: 'Entendido',
  );
  return false;
}

/// `stock` que devuelve el servidor tras un movimiento (`inventory.catalog()`).
int? inventoryStockFromResponse(Map<String, dynamic> result) {
  final inventory = result['inventory'];
  if (inventory is Map) {
    final stock = inventory['stock'];
    if (stock is num) return stock.toInt();
    if (stock is String) return int.tryParse(stock.trim());
  }
  return null;
}

class _ActionForm {
  const _ActionForm({this.quantity, this.unitCost, this.reason});

  final int? quantity;
  final double? unitCost;
  final String? reason;
}

class _ActionDialog extends StatefulWidget {
  const _ActionDialog({
    required this.action,
    required this.palette,
    this.currentStock,
    this.currentUnitCost,
  });

  final InventoryAction action;
  final CrmPalette palette;
  final int? currentStock;
  final double? currentUnitCost;

  @override
  State<_ActionDialog> createState() => _ActionDialogState();
}

class _ActionDialogState extends State<_ActionDialog> {
  final _quantity = TextEditingController();
  final _cost = TextEditingController();
  final _reason = TextEditingController();
  String? _error;

  bool get _needsQuantity => widget.action != InventoryAction.cost;
  bool get _needsCost =>
      widget.action == InventoryAction.restock ||
      widget.action == InventoryAction.adjustIn ||
      widget.action == InventoryAction.cost;

  @override
  void initState() {
    super.initState();
    if (widget.currentUnitCost != null) {
      _cost.text = widget.currentUnitCost!.toStringAsFixed(2);
    }
    _reason.text = switch (widget.action) {
      InventoryAction.restock => 'Reposición',
      InventoryAction.adjustIn => 'Ajuste manual (entrada)',
      InventoryAction.adjustOut => 'Ajuste manual (salida)',
      InventoryAction.count => 'Recuento físico',
      InventoryAction.cost => 'Costo unitario',
    };
  }

  @override
  void dispose() {
    _quantity.dispose();
    _cost.dispose();
    _reason.dispose();
    super.dispose();
  }

  void _submit() {
    final quantity = _needsQuantity ? int.tryParse(_quantity.text.trim()) : null;
    final cost = _needsCost ? double.tryParse(_cost.text.trim().replaceAll(',', '.')) : null;
    if (_needsQuantity && (quantity == null || quantity < 1)) {
      setState(() => _error = 'Escribe una cantidad entera mayor que cero.');
      return;
    }
    if (_needsCost && (cost == null || cost < 0)) {
      setState(() => _error = 'Escribe un costo válido.');
      return;
    }
    Navigator.of(context).pop(_ActionForm(quantity: quantity, unitCost: cost, reason: _reason.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return AlertDialog(
      title: Text(inventoryActionLabel(widget.action)),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (widget.action == InventoryAction.count && widget.currentStock != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  'El servidor informa ahora de ${widget.currentStock} cápsulas. Escribe lo que has contado: la diferencia la calcula él y queda en auditoría.',
                  style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                ),
              ),
            if (widget.action == InventoryAction.adjustOut)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  'Una salida mayor que el stock se rechaza con «stock insuficiente»; no se permite dejar el inventario en negativo.',
                  style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                ),
              ),
            if (_needsQuantity)
              TextField(
                controller: _quantity,
                autofocus: true,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: widget.action == InventoryAction.count ? 'Cápsulas contadas' : 'Cantidad (cápsulas)',
                ),
              ),
            if (_needsCost) ...[
              const SizedBox(height: 10),
              TextField(
                controller: _cost,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Costo por cápsula'),
              ),
            ],
            const SizedBox(height: 10),
            TextField(
              controller: _reason,
              maxLength: 120,
              decoration: const InputDecoration(labelText: 'Motivo (queda en auditoría)'),
            ),
            if (_error != null)
              Text(_error!, style: TextStyle(fontSize: 12.5, color: p.danger, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancelar')),
        FilledButton(onPressed: _submit, child: const Text('Registrar')),
      ],
    );
  }
}
