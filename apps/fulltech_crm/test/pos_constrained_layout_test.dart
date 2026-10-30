import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:fulltech_crm/core/pos/pos_sale.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/pos_desktop/pos_cart_panel.dart';
import 'package:fulltech_crm/features/pos_desktop/pos_line_editors.dart';

/// Regresión del POS a una ventana COMPACTA real: 1264x681 lógicos, que es
/// justo el tamaño en el que la aceptación nativa de Windows destapó el
/// desbordamiento y las claves globales duplicadas.
///
/// Aquí no se toca red ni backend: solo se comprueba que los diálogos del POS
/// caben, no lanzan excepciones de framework y dejan accesibles sus botones.
void main() {
  void ventanaCompacta(WidgetTester tester) {
    tester.view.physicalSize = const Size(1264, 681);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }

  Widget host(WidgetBuilder builder) => MaterialApp(
        theme: CrmTheme.build(Brightness.light),
        home: Builder(builder: builder),
      );

  final linea = PosLine(
    variantId: 'var_1',
    productName: 'Servicio QA',
    presentationName: 'Unidad',
    unitPriceCents: 10000,
    quantity: 1,
  );

  testWidgets('descuento de línea: cabe en 1264x681 y aplica el 10 %', (tester) async {
    ventanaCompacta(tester);
    PosLine? resultado;

    await tester.pumpWidget(
      host(
        (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async {
                resultado = await showLineDiscountDialog(context, line: linea);
              },
              child: const Text('abrir'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('abrir'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull, reason: 'El diálogo no puede lanzar excepciones');
    expect(find.text('Porcentaje'), findsOneWidget);
    expect(find.text('Cancelar'), findsOneWidget);
    expect(find.text('Aplicar'), findsOneWidget);

    await tester.enterText(
      find.ancestor(of: find.text('Porcentaje'), matching: find.byType(TextField)).first,
      '10',
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Queda en'), findsWidgets);

    await tester.tap(find.text('Aplicar'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(resultado, isNotNull);
    expect(resultado!.discountType, 'percent');
    expect(resultado!.discountValue, 10);
    // La fórmula del dinero es la del servidor (`pos-math.js`): 100,00 − 10 %.
    expect(resultado!.netCents, 9000);
  });

  _pieDeCobroAlcanzable();

  testWidgets('venta fuera de inventario: cabe en 1264x681 y se puede cancelar', (tester) async {
    ventanaCompacta(tester);

    await tester.pumpWidget(
      host(
        (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => showManualSaleDialog(context),
              child: const Text('abrir'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('abrir'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull, reason: 'El diálogo no puede lanzar excepciones');
    expect(find.text('Venta fuera de inventario'), findsWidgets);
    expect(find.text('Descripción'), findsOneWidget);
    expect(find.text('Cantidad'), findsOneWidget);
    expect(find.text('Precio unitario'), findsOneWidget);
    expect(find.text('Agregar al ticket'), findsOneWidget);
    expect(find.text('Cancelar'), findsOneWidget);

    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}

/// Regresión del PIE DE COBRO: a la ventana real de la aceptación nativa
/// (1264x681 lógicos) el botón de cobro debe ser SIEMPRE pulsable, aunque el
/// ticket venga reanudado con cliente, líneas, descuento y datos de entrega.
void _pieDeCobroAlcanzable() {
  testWidgets('el pie de cobro es pulsable a 1264x681 con carrito completo', (tester) async {
    tester.view.physicalSize = const Size(1264, 681);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    var cobros = 0;
    final lineas = <PosLine>[
      PosLine(
        variantId: 'manual_a',
        productName: 'Servicio QA Ticket',
        presentationName: 'Fuera de inventario',
        unitPriceCents: 3500,
        quantity: 2,
        discountType: 'percent',
        discountValue: 10,
        manualName: 'Servicio QA Ticket',
        manualKind: 'product',
        manualPrice: 35,
      ),
      PosLine(
        variantId: 'manual_b',
        productName: 'Servicio QA Extra',
        presentationName: 'Fuera de inventario',
        unitPriceCents: 1200,
        quantity: 1,
        manualName: 'Servicio QA Extra',
        manualKind: 'service',
        manualPrice: 12,
      ),
    ];

    await tester.pumpWidget(
      MaterialApp(
        theme: CrmTheme.build(Brightness.light),
        home: Builder(
          builder: (context) => Scaffold(
            body: Row(
            children: [
              const Expanded(child: SizedBox()),
              SizedBox(
                width: 380,
                child: PosCartPanel(
                  lines: lineas,
                  customer: Customer(
                    id: 'cus_1',
                    name: 'QA F16',
                    phone: '8090000000',
                    email: '',
                    stage: '',
                    tags: [],
                    city: '',
                    createdAt: '',
                    orders: 0,
                    totalSpent: 0,
                    notes: '',
                    delivered: 0,
                  ),
                  mode: 'order',
                  method: 'CASH',
                  paid: false,
                  deliveryFee: 0,
                  saving: false,
                  onQuantity: (_, _) {},
                  onRemove: (_) {},
                  onLineDiscount: (_) {},
                  onPickCustomer: () {},
                  onClear: () {},
                  onModeChanged: (_) {},
                  onMethodChanged: (_) {},
                  onPaidChanged: (_) {},
                  onDeliveryFeeChanged: (_) {},
                  onCheckout: () => cobros += 1,
                ),
              ),
            ],
          ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull, reason: 'El panel no puede desbordar');
    // La prueba clave: el botón está EN PANTALLA y recibe el toque.
    final cobrar = find.text('Crear pedido');
    expect(cobrar.hitTestable(), findsOneWidget,
        reason: 'El botón de cobro debe ser alcanzable con el ratón a 1264x681');
    await tester.tap(cobrar.hitTestable());
    await tester.pumpAndSettle();
    expect(cobros, 1, reason: 'El clic en la barra de cobro debe disparar el cobro');
  });
}


