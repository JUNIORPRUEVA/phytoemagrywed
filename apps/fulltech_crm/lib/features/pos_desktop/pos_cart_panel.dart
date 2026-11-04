import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../core/pos/pos_sale.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';
import 'pos_line_editors.dart';

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
    this.onDeliveryFeeChanged,
    required this.onCheckout,
    this.onOpenTickets,
    this.onAskCustomerData,
    this.onParkTicket,
    this.onQuote,
    this.onLatestQuotePdf,
    this.quotePdfLoading = false,
    this.canViewUtility = false,
    this.catalogCostCents = const {},
    this.deliveryMethod = 'delivery',
    this.discountType = 'none',
    this.discountValue = 0,
    this.onDiscountChanged,
    this.openOrders = const [],
    this.loadingContext = false,
    this.contextError,
    this.onReloadContext,
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

  /// Edición rápida de cantidad y descuento de una línea con doble clic.
  final ValueChanged<PosLine> onLineDiscount;
  final VoidCallback onPickCustomer;
  final VoidCallback onClear;
  final ValueChanged<String> onModeChanged;
  final ValueChanged<String> onMethodChanged;
  final ValueChanged<bool> onPaidChanged;
  final ValueChanged<double>? onDeliveryFeeChanged;
  final VoidCallback onCheckout;

  /// Abre la lista de pedidos recientes / tickets (se puede cancelar desde ahí).
  final VoidCallback? onOpenTickets;

  /// «Pedir datos al cliente» con IA (solo con cliente elegido).
  final VoidCallback? onAskCustomerData;
  final VoidCallback? onParkTicket;
  final VoidCallback? onQuote;
  final VoidCallback? onLatestQuotePdf;
  final bool quotePdfLoading;
  final bool canViewUtility;
  final Map<String, int> catalogCostCents;

  /// `delivery` (a domicilio) o `pickup` (retiro en tienda).
  final String deliveryMethod;

  /// Descuento general del ticket (`none` | `percent` | `amount`).
  final String discountType;
  final double discountValue;
  final void Function(String type, double value)? onDiscountChanged;

  /// Pedidos abiertos del cliente (`GET /api/admin/pos/context/:id`).
  final List<Map<String, dynamic>> openOrders;
  final bool loadingContext;
  final String? contextError;
  final VoidCallback? onReloadContext;

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

  /// Costo de lo que se sabe (las líneas manuales guardan su costo).
  /// Las líneas del catálogo no lo traen, así que la utilidad solo se muestra
  /// cuando TODAS las líneas tienen costo conocido: nunca se inventa.
  int? get _utilityCents {
    if (lines.isEmpty) return null;
    var utility = 0;
    for (final line in lines) {
      final costCents = line.isManual
          ? (line.manualCost == null ? null : (line.manualCost! * 100).round())
          : catalogCostCents[line.variantId];
      if (costCents == null) return null;
      utility += line.netCents - costCents * line.quantity;
    }
    return utility - _discountCents;
  }

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
          if (openOrders.isNotEmpty || contextError != null)
            _openOrdersNotice(context),
          Divider(height: 1, color: p.borderSoft),
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
                  for (final line in lines) _line(context, line),
              ],
            ),
          ),
          Divider(height: 1, color: p.border),
          _totalsBar(context),
          _checkoutBar(context),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 5),
            child: Row(
              children: [
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: p.primarySoft,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        '${lines.fold<int>(0, (sum, line) => sum + line.quantity)} productos agregados',
                        style: t.pill.copyWith(
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ),
                ),
                TextButton(
                  onPressed: lines.isEmpty ? null : onClear,
                  child: Text(
                    '× Cancelar venta',
                    style: t.pill.copyWith(fontSize: 11),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _customerBar(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    return SizedBox(
      height: 54,
      child: Row(
        children: [
          const SizedBox(width: 6),
          Expanded(
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: onPickCustomer,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                child: Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: p.primarySoft,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(
                        Icons.person_outline_rounded,
                        size: 19,
                        color: p.primary,
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        customer?.name ?? 'Agregar cliente',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.body.copyWith(fontWeight: FontWeight.w800),
                      ),
                    ),
                    Icon(
                      Icons.add_circle_outline_rounded,
                      size: 18,
                      color: p.primary,
                    ),
                  ],
                ),
              ),
            ),
          ),
          PopupMenuButton<String>(
            tooltip: 'Opciones del ticket',
            color: p.surface,
            surfaceTintColor: p.surface,
            elevation: 10,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: p.border),
            ),
            icon: Icon(Icons.more_vert_rounded, color: p.ink, size: 24),
            onSelected: (value) {
              switch (value) {
                case 'invoice':
                  onModeChanged('invoice');
                case 'order':
                  onModeChanged('order');
                case 'quote':
                  onModeChanged('quote');
                case 'CASH':
                  onMethodChanged('CASH');
                case 'TRANSFER':
                  onMethodChanged('TRANSFER');
                case 'paid':
                  onPaidChanged(!paid);
                case 'discount':
                  onDiscountChanged?.call(
                    discountType == 'none' ? 'percent' : 'none',
                    discountValue,
                  );
                case 'delivery':
                  onPickCustomer();
              }
            },
            itemBuilder: (_) => [
              _menuItem(
                'invoice',
                'Factura · cobrar y cerrar',
                mode == 'invoice',
                Icons.receipt_long_rounded,
                p,
              ),
              _menuItem(
                'order',
                'Pedido · dejar abierto',
                mode == 'order',
                Icons.shopping_bag_outlined,
                p,
              ),
              _menuItem(
                'quote',
                'Cotización · presupuesto',
                mode == 'quote',
                Icons.request_quote_outlined,
                p,
              ),
              const PopupMenuDivider(),
              _menuItem(
                'CASH',
                'Efectivo',
                method == 'CASH',
                Icons.payments_outlined,
                p,
              ),
              _menuItem(
                'TRANSFER',
                'Transferencia',
                method == 'TRANSFER',
                Icons.account_balance_outlined,
                p,
              ),
              if (mode == 'order')
                _menuItem(
                  'paid',
                  paid ? 'Marcar por cobrar' : 'Marcar pagado',
                  false,
                  Icons.price_check_rounded,
                  p,
                ),
              _menuItem(
                'discount',
                discountType == 'none'
                    ? 'Aplicar descuento'
                    : 'Quitar descuento',
                discountType != 'none',
                Icons.sell_outlined,
                p,
              ),
              _menuItem(
                'delivery',
                'Editar entrega',
                false,
                Icons.local_shipping_outlined,
                p,
              ),
            ],
          ),
          if (onLatestQuotePdf != null)
            _customerAction(
              context,
              tooltip: 'Ver PDF de la última cotización',
              icon: Icons.picture_as_pdf_outlined,
              color: p.inkSecondary,
              onPressed: customer == null || quotePdfLoading
                  ? null
                  : onLatestQuotePdf,
            ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }

  PopupMenuItem<String> _menuItem(
    String value,
    String label,
    bool selected,
    IconData icon,
    PosPalette p,
  ) => PopupMenuItem<String>(
    value: value,
    height: 46,
    child: Row(
      children: [
        Icon(icon, size: 20, color: selected ? p.primary : p.inkSecondary),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            label,
            style: p.text.body.copyWith(
              fontSize: 12.5,
              fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
            ),
          ),
        ),
        if (selected) Icon(Icons.check_rounded, size: 17, color: p.primary),
      ],
    ),
  );

  Widget _customerAction(
    BuildContext context, {
    required String tooltip,
    required IconData icon,
    required Color color,
    required VoidCallback? onPressed,
  }) {
    final p = PosPalette.of(context);
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 350),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 1),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          child: InkWell(
            onTap: onPressed,
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(
              width: 36,
              height: 38,
              child: Icon(
                icon,
                size: 21,
                color: onPressed == null
                    ? p.inkSecondary.withValues(alpha: 0.45)
                    : color,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _line(BuildContext context, PosLine line) {
    final p = PosPalette.of(context);
    final t = p.text;
    final presentation = line.presentationName.trim();
    final showPresentation =
        !line.isManual &&
        presentation.isNotEmpty &&
        presentation.toLowerCase() != line.productName.trim().toLowerCase();
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 7, 6, 7),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: p.borderSoft)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Tooltip(
              message: 'Doble clic para editar cantidad y descuento',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onDoubleTap: () => onLineDiscount(line),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      line.productName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.body.copyWith(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (line.isManual ||
                        showPresentation ||
                        line.lineDiscountCents > 0) ...[
                      const SizedBox(height: 3),
                      Row(
                        children: [
                          if (line.isManual)
                            Flexible(
                              child: FittedBox(
                                fit: BoxFit.scaleDown,
                                alignment: Alignment.centerLeft,
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 7,
                                    vertical: 2,
                                  ),
                                  decoration: BoxDecoration(
                                    color: p.primary,
                                    borderRadius: BorderRadius.circular(20),
                                  ),
                                  child: const Text(
                                    'Manual',
                                    style: TextStyle(
                                      color: Colors.white,
                                      fontSize: 10,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                ),
                              ),
                            )
                          else if (showPresentation)
                            Flexible(
                              child: Text(
                                presentation,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: t.secondary.copyWith(fontSize: 10.5),
                              ),
                            ),
                          if (line.lineDiscountCents > 0)
                            Flexible(
                              child: FittedBox(
                                fit: BoxFit.scaleDown,
                                alignment: Alignment.centerLeft,
                                child: Text(
                                  '−${CrmFormat.money(line.lineDiscountCents / 100)}',
                                  style: t.secondary.copyWith(
                                    fontSize: 10,
                                    color: p.danger,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: 52,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerRight,
              child: Text(
                _plainMoney(line.unitPriceCents),
                maxLines: 1,
                style: t.secondary.copyWith(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          const SizedBox(width: 6),
          _quantityStepper(context, line),
          const SizedBox(width: 6),
          SizedBox(
            width: 82,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerRight,
              child: Text(
                _money(line.netCents),
                maxLines: 1,
                style: t.body.copyWith(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
          const SizedBox(width: 2),
          IconButton(
            tooltip: 'Quitar',
            onPressed: () => onRemove(line),
            iconSize: 20,
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
            color: p.ink,
            icon: const Icon(Icons.remove_circle_outline_rounded),
          ),
        ],
      ),
    );
  }

  String _plainMoney(int cents) =>
      CrmFormatMoney.of(cents).replaceFirst(RegExp(r'^RD\$\s*'), '');

  String _money(int cents) => CrmFormatMoney.of(cents);

  Widget _quantityStepper(BuildContext context, PosLine line) {
    final t = PosPalette.of(context).text;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _stepButton(context, Icons.remove_rounded, () => onQuantity(line, -1)),
        SizedBox(
          width: 26,
          child: Text(
            '${line.quantity}',
            textAlign: TextAlign.center,
            style: t.body.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800),
          ),
        ),
        _stepButton(context, Icons.add_rounded, () => onQuantity(line, 1)),
      ],
    );
  }

  Widget _stepButton(BuildContext context, IconData icon, VoidCallback onTap) {
    final p = PosPalette.of(context);
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        width: 26,
        height: 26,
        child: Icon(icon, size: 16, color: p.primary),
      ),
    );
  }

  Widget _totalsBar(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final utility = _utilityCents;
    Widget row(String label, String value, {bool accent = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: t.secondary.copyWith(
                fontSize: 12.5,
                color: p.inkSecondary,
              ),
            ),
          ),
          Text(
            value,
            style: t.body.copyWith(
              fontSize: 13.5,
              fontWeight: FontWeight.w800,
              color: accent ? p.primary : p.ink,
            ),
          ),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Column(
        children: [
          row('Subtotal', _money(_subtotalCents)),
          if (_discountCents > 0)
            row('Descuento', '−${_money(_discountCents)}'),
          if (deliveryFee > 0)
            row('Envío', _money((deliveryFee * 100).round())),
          if (canViewUtility && utility != null)
            row('Utilidad', _money(utility), accent: true),
          if (discountType != 'none') ...[
            const SizedBox(height: 4),
            _discountRow(context),
          ],
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
          chip(
            '%',
            percent,
            () =>
                onDiscountChanged!(percent ? 'none' : 'percent', discountValue),
          ),
          const SizedBox(width: 4),
          chip(
            '\$',
            amount,
            () => onDiscountChanged!(amount ? 'none' : 'amount', discountValue),
          ),
          const SizedBox(width: 4),
        ],
        SizedBox(
          width: 78,
          height: 30,
          child: TextFormField(
            initialValue: discountValue == 0
                ? ''
                : (percent
                      ? discountValue.toStringAsFixed(
                          discountValue % 1 == 0 ? 0 : 1,
                        )
                      : discountValue.toStringAsFixed(2)),
            enabled: discountType != 'none' && onDiscountChanged != null,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textAlign: TextAlign.right,
            style: t.body,
            decoration: InputDecoration(
              isDense: true,
              filled: false,
              hintText: '0',
              hintStyle: t.secondary,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 8,
              ),
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
            _discountCents == 0
                ? '—'
                : '-${CrmFormat.money(_discountCents / 100)}',
            textAlign: TextAlign.right,
            style: t.body.copyWith(
              fontSize: 11.5,
              color: _discountCents == 0 ? p.inkSecondary : p.danger,
            ),
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
                child: const Text(
                  'Reintentar',
                  style: TextStyle(fontSize: 11.5),
                ),
              ),
          ],
        ),
      );
    }
    final numbers = [
      for (final row in openOrders.take(3))
        str(row['order_number'], str(row['number'], str(row['id']))),
    ];
    final extra = openOrders.length > 3
        ? ' y ${openOrders.length - 3} más'
        : '';
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

  Widget _checkoutBar(BuildContext context) {
    final p = PosPalette.of(context);
    final modeLabel = switch (mode) {
      'quote' => 'Guardar cotización',
      'order' => 'Crear pedido',
      _ => 'Cobrar',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 5),
      child: SizedBox(
        height: 68,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Tooltip(
                message: modeLabel,
                child: Material(
                  color: p.checkout,
                  borderRadius: BorderRadius.circular(2),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(2),
                    onTap: saving ? null : onCheckout,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Row(
                        children: [
                          if (saving)
                            SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: p.onCheckout,
                              ),
                            )
                          else
                            Text(
                              modeLabel,
                              style: p.text.checkoutLabel.copyWith(
                                fontSize: 17,
                              ),
                            ),
                          const Spacer(),
                          Flexible(
                            child: FittedBox(
                              fit: BoxFit.scaleDown,
                              alignment: Alignment.centerRight,
                              child: Text(
                                _money(_totalCents),
                                style: p.text.total.copyWith(fontSize: 24),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (onOpenTickets != null) ...[
              const SizedBox(width: 8),
              SizedBox(
                width: 74,
                height: 68,
                child: Material(
                  color: const Color(0xFFEDEEF0),
                  borderRadius: BorderRadius.circular(2),
                  child: InkWell(
                    onTap: onOpenTickets,
                    borderRadius: BorderRadius.circular(2),
                    child: Tooltip(
                      message: 'Ventas recientes',
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.receipt_long_rounded,
                            size: 29,
                            color: const Color(0xFF263344),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Ventas',
                            style: p.text.pill.copyWith(
                              fontSize: 11.5,
                              color: const Color(0xFF263344),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
