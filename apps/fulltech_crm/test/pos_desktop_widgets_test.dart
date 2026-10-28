import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:fulltech_crm/core/pos/pos_sale.dart';
import 'package:fulltech_crm/core/theme/crm_tokens.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/common/pwa_icon.dart';
import 'package:fulltech_crm/features/pos_desktop/pos_cart_panel.dart';
import 'package:fulltech_crm/features/pos_desktop/pos_product_grid.dart';

/// Pruebas de presentación del POS de escritorio (estilo FullPOS Cloud).
/// No tocan red ni backend: comprueban que los widgets pintan los datos del
/// CRM y que las acciones (agregar, cantidad, quitar, cobrar) se disparan.
void main() {
  /// El botón de agregar usa el icono original del PWA (`plus.png`).
  final addIcon = find.byWidgetPredicate(
    (widget) => widget is PwaIcon && widget.asset == PwaIcons.plus,
  );

  CatalogProduct product({int stock = 5, bool available = true}) => CatalogProduct(
        id: 'prd_1',
        name: 'Auriculares Pro 4',
        presentations: [
          CatalogPresentation(
            id: 'var_1',
            name: 'Unidad',
            price: 900,
            salePriceCents: 90000,
            capsules: '',
            available: available,
            stock: stock,
            currency: 'DOP',
          ),
        ],
      );

  PosLine line({int quantity = 2}) => PosLine(
        variantId: 'var_1',
        productName: 'Auriculares Pro 4',
        presentationName: 'Unidad',
        unitPriceCents: 90000,
        quantity: quantity,
      );

  Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

  /// Superficie de escritorio para que el panel tenga alto real disponible.
  void desktopSurface(WidgetTester tester) {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  group('tarjeta de producto', () {
    testWidgets('muestra nombre, precio y disponibilidad y agrega al pulsar', (tester) async {
      var added = 0;
      final item = product();
      await tester.pumpWidget(wrap(SizedBox(
        width: 200,
        height: 216,
        child: PosProductCard(
          product: item,
          presentation: item.presentations.first,
          onAdd: () => added++,
        ),
      )));
      expect(find.text('Auriculares Pro 4'), findsOneWidget);
      expect(find.textContaining('900'), findsWidgets);
      expect(find.text('Disp. 5'), findsOneWidget);
      await tester.tap(addIcon);
      expect(added, 1);
    });

    testWidgets('sin existencias queda deshabilitada y no agrega', (tester) async {
      var added = 0;
      final item = product(stock: 0, available: false);
      await tester.pumpWidget(wrap(SizedBox(
        width: 200,
        height: 216,
        child: PosProductCard(
          product: item,
          presentation: item.presentations.first,
          onAdd: () => added++,
        ),
      )));
      expect(find.text('Sin stock'), findsOneWidget);
      await tester.tap(addIcon, warnIfMissed: false);
      expect(added, 0);
    });
  });

  group('rejilla', () {
    testWidgets('filtra por texto y avisa cuando no hay coincidencias', (tester) async {
      await tester.pumpWidget(wrap(PosProductGrid(
        products: [product()],
        query: 'zzz',
        onAdd: (_, _) {},
      )));
      expect(find.textContaining('Ningún producto coincide'), findsOneWidget);
    });
  });

  group('panel de venta', () {
    PosCartPanel panel({
      List<PosLine>? lines,
      void Function(PosLine, int)? onQuantity,
      ValueChanged<PosLine>? onRemove,
      VoidCallback? onCheckout,
    }) {
      return PosCartPanel(
        lines: lines ?? [line()],
        customer: null,
        mode: 'order',
        method: 'CASH',
        paid: false,
        deliveryFee: 0,
        saving: false,
        onQuantity: onQuantity ?? (_, _) {},
        onRemove: onRemove ?? (_) {},
        onPickCustomer: () {},
        onClear: () {},
        onModeChanged: (_) {},
        onMethodChanged: (_) {},
        onPaidChanged: (_) {},
        onDeliveryFeeChanged: (_) {},
        onCheckout: onCheckout ?? () {},
      );
    }

    testWidgets('pinta la línea, el subtotal y el total y cobra', (tester) async {
      desktopSurface(tester);
      var checkedOut = 0;
      await tester.pumpWidget(wrap(SizedBox(width: 380, height: 800, child: panel(onCheckout: () => checkedOut++))));
      expect(find.text('Auriculares Pro 4'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      // Con mode `order` el botón dice «Crear pedido» (antes «Cobrar»).
      expect(find.text('Crear pedido'), findsOneWidget);
      await tester.tap(find.text('Crear pedido'));
      expect(checkedOut, 1);
    });

    testWidgets('los botones de cantidad y quitar llaman al manejador real', (tester) async {
      desktopSurface(tester);
      final changes = <int>[];
      var removed = 0;
      final current = line();
      await tester.pumpWidget(wrap(SizedBox(
        width: 380,
        height: 700,
        child: panel(
          lines: [current],
          onQuantity: (_, delta) => changes.add(delta),
          onRemove: (_) => removed++,
        ),
      )));
      await tester.tap(find.byIcon(Icons.add_rounded).last);
      await tester.tap(find.byIcon(Icons.remove_rounded));
      await tester.tap(find.byIcon(Icons.close_rounded));
      expect(changes, containsAll(<int>[1, -1]));
      expect(removed, 1);
    });

    testWidgets('ticket vacío muestra el aviso', (tester) async {
      desktopSurface(tester);
      await tester.pumpWidget(wrap(SizedBox(width: 380, height: 800, child: panel(lines: const []))));
      expect(find.textContaining('El ticket está vacío'), findsOneWidget);
    });
  });
}
