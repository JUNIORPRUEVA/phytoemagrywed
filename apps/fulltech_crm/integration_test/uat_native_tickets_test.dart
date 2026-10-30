import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fulltech_crm/features/pos_desktop/pos_cart_panel.dart';

import 'support/native_harness.dart';

/// Escenarios 11 y 12 (parcial): aparcar ticket, listarlo, reanudarlo y cobrarlo.
///
///   flutter test integration_test/uat_native_tickets_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('ticket: aparcar, reanudar y cobrar una sola vez', (tester) async {
    final estado = await arrancar(tester);
    await entrarComoAdmin(tester);

    final sello = DateTime.now().millisecondsSinceEpoch.toString();
    final cliente = 'QA F15 T $sello';
    final telefono = '809${sello.substring(sello.length - 7)}';
    const descripcion = 'Servicio ticket QA';

    final pedidosAntes = (await estado.repository.ordersPage(limit: 5)).total;

    await irA(tester, 'Facturación');
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Agregar cliente')), isTrue,
        reason: 'El POS no abrió. En pantalla: ${textos(tester)}');

    // Cliente sintético
    await tester.tap(find.text('Agregar cliente').first);
    await asentar(tester);
    await tester.tap(find.text('Nuevo cliente'));
    await asentar(tester);
    final campos = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    await tester.enterText(campos.at(0), telefono);
    await tester.enterText(campos.at(1), cliente);
    await asentar(tester);
    await tester.tap(find.text('Crear'));
    await asentar(tester);

    // Línea manual (sin cobrar todavía)
    await tester.tap(find.text('Venta fuera de inventario').first);
    await asentar(tester);
    final manual = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    await tester.enterText(manual.at(0), descripcion);
    await tester.enterText(manual.at(1), '2');
    await tester.enterText(manual.at(2), '35');
    await asentar(tester);
    await tester.tap(find.text('Agregar al ticket'));
    await asentar(tester);
    expect(await esperarAsentando(tester, find.textContaining(descripcion)), isTrue);

    // ── Escenario 11: aparcar ───────────────────────────────────────────────
    // La barra de acciones se desplaza en horizontal: el botón puede estar
    // fuera del borde visible.
    await tester.ensureVisible(find.text('Aparcar ticket'));
    await asentar(tester);
    await tester.tap(find.text('Aparcar ticket'));
    // El aviso es un SnackBar efímero: la prueba de verdad es el servidor.
    var guardado = false;
    var tickets = <Map<String, dynamic>>[];
    for (var intento = 0; intento < 20 && !guardado; intento += 1) {
      await asentar(tester, segundos: 2);
      tickets = await estado.repository.posTickets();
      guardado = jsonEncode(tickets).contains(sello);
    }
    expect(guardado, isTrue,
        reason: 'El servidor debe guardar el ticket del cliente sintético. '
            'En pantalla: ${textos(tester)}');
    // Datos autoritativos del ticket guardado (escenario 11).
    final ticketSembrado = tickets.firstWhere((row) => jsonEncode(row).contains(sello));
    final clienteId = ((ticketSembrado['draft'] as Map?)?['customerId'] ?? '').toString();
    final versionSembrada = (ticketSembrado['version'] ?? '').toString();
    expect(clienteId.isNotEmpty, isTrue,
        reason: 'El ticket debe guardar el cliente seleccionado');
    expect(versionSembrada.isNotEmpty, isTrue,
        reason: 'El servidor debe entregar una versión de ticket para el cobro');
    debugPrint('TICKET: id=${ticketSembrado['id']} version=$versionSembrada cliente=$clienteId');

    final pedidosTrasAparcar = (await estado.repository.ordersPage(limit: 5)).total;
    expect(pedidosTrasAparcar, pedidosAntes,
        reason: 'Aparcar un ticket NO puede crear pedidos ni cobrar nada');

    // ── Reanudar desde el listado ───────────────────────────────────────────
    await tester.ensureVisible(find.text('Tickets guardados'));
    await asentar(tester);
    await tester.tap(find.text('Tickets guardados'));
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Reanudar')), isTrue,
        reason: 'No aparece el listado de tickets. En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Reanudar').first);
    await asentar(tester);
    // El diálogo debe cerrarse del todo antes de tocar el carrito.
    for (var intento = 0; intento < 20 && find.byType(AlertDialog).evaluate().isNotEmpty; intento += 1) {
      await asentar(tester, segundos: 2);
    }
    expect(find.byType(AlertDialog), findsNothing,
        reason: 'El listado de tickets no se cerró. En pantalla: ${textos(tester)}');

    // ── Escenario 12: cobrar UNA sola vez ───────────────────────────────────
    await tester.tap(find.text('Retiro'));
    await asentar(tester);
    expect(find.text('Dirección de entrega'), findsNothing,
        reason: 'Debe quedar seleccionado «Retiro»');

    // La barra de cobro es un pie FIJO: debe recibir el clic a 1264x681.
    final cobrar = find.text('Crear pedido');
    expect(await esperarAsentando(tester, cobrar), isTrue,
        reason: 'No encuentro el cobro tras reanudar. En pantalla: ${textos(tester)}');
    // El aviso «Ticket guardado» es un SnackBar flotante sobre el pie: se espera
    // a que desaparezca (como haría la persona) antes de cobrar.
    var alcanzable = false;
    for (var intento = 0; intento < 25 && !alcanzable; intento += 1) {
      await asentar(tester, segundos: 2);
      alcanzable = cobrar.hitTestable().evaluate().isNotEmpty;
    }
    expect(alcanzable, isTrue,
        reason: 'El cobro debe ser alcanzable. '
            'Panel=${tester.getRect(find.byType(PosCartPanel))} '
            'Boton=${tester.getRect(cobrar.first)}');
    await tester.tap(cobrar.hitTestable());

    var pedidoNuevo = <String, dynamic>{};
    for (var intento = 0; intento < 30 && pedidoNuevo.isEmpty; intento += 1) {
      await asentar(tester, segundos: 2);
      final pagina = await estado.repository.ordersPage(limit: 5);
      pedidoNuevo = pagina.orders.firstWhere(
        (row) => jsonEncode(row).contains(sello),
        orElse: () => <String, dynamic>{},
      );
    }
    expect(pedidoNuevo, isNotEmpty,
        reason: 'El cobro del ticket reanudado no creó pedido. En pantalla: ${textos(tester)}');
    if (find.text('Listo').evaluate().isNotEmpty) {
      await tester.tap(find.text('Listo'));
      await asentar(tester);
    }

    final despues = await estado.repository.ordersPage(limit: 5);
    expect(despues.total, pedidosAntes + 1,
        reason: 'Exactamente UN pedido (antes=$pedidosAntes, después=${despues.total})');
    final total = double.tryParse(pedidoNuevo['total'].toString()) ?? -1;
    expect(total, closeTo(70, 0.01), reason: '2 × 35,00 = 70,00 (guardó $total)');
    final ticketsTrasCobro = await estado.repository.posTickets();
    // Estado del ticket DESPUES del cobro: se documenta tal cual lo devuelve
    // el servidor (el contrato puede conservarlo con otro estado).
    final restantes = ticketsTrasCobro.where((row) => jsonEncode(row).contains(sello)).toList();
    final estadoTicket = restantes.isEmpty ? '' : ' estado=' + (restantes.first['status'] ?? '(sin status)').toString(); // ignore: prefer_interpolation_to_compose_strings
    debugPrint('TICKET TRAS COBRO: restantes=' + restantes.length.toString() + estadoTicket); // ignore: prefer_interpolation_to_compose_strings
    final claveIdem = 'qa_f16_$sello';
    final cuerpo = <String, dynamic>{
      'mode': 'order',
      'requestId': claveIdem,
      'customerId': clienteId,
      'items': [
        {
          'variantId': 'manual_$claveIdem',
          'quantity': 1,
          'manual': {'name': 'Servicio idempotente QA', 'kind': 'product', 'price': 10},
        },
      ],
      'deliveryFee': 0,
      'paymentMethod': 'CASH',
      'paymentStatus': 'paid',
      'deliveryMethod': 'pickup',
      'notes': '',
      'address': '',
      'expectedTotal': 1000,
      // El cliente ya tiene un pedido abierto: se confirma explícitamente, que
      // es el mecanismo documentado del contrato (no se evade la validación).
      'acknowledgeOpen': true,
    };
    final baseIdem = (await estado.repository.ordersPage(limit: 5)).total;
    final primera = await estado.repository.posCheckout(cuerpo, operationKey: claveIdem);
    final trasPrimera = (await estado.repository.ordersPage(limit: 5)).total;
    final segunda = await estado.repository.posCheckout(cuerpo, operationKey: claveIdem);
    final trasSegunda = (await estado.repository.ordersPage(limit: 5)).total;
    expect(trasPrimera, baseIdem + 1, reason: 'El primer envío crea un pedido');
    expect(trasSegunda, trasPrimera,
        reason: 'El reintento con la MISMA clave NO puede crear otro pedido');
    final idPrimero = jsonEncode(primera);
    final idSegundo = jsonEncode(segunda);
    debugPrint('IDEMPOTENCIA OK: primera=${idPrimero.length}B segunda=${idSegundo.length}B '
        'pedidos=$baseIdem->$trasPrimera->$trasSegunda');

    debugPrint('TICKETS OK: pedido=${pedidoNuevo['id']} total=$total');
  });
  _descuentoDeTicketSobrevive();
}



/// Escenario 11/12 (refuerzo): el DESCUENTO de línea distinto de cero debe
/// sobrevivir al aparcado, a la reanudación y al cobro.
void _descuentoDeTicketSobrevive() {
  testWidgets('ticket con descuento del 10 %: 70,00 -> 63,00 cobrado una vez', (tester) async {
    final estado = await arrancar(tester);
    await entrarComoAdmin(tester);

    final sello = DateTime.now().millisecondsSinceEpoch.toString();
    final cliente = 'QA F17 D $sello';
    final telefono = '809${sello.substring(sello.length - 7)}';
    final pedidosAntes = (await estado.repository.ordersPage(limit: 5)).total;

    await irA(tester, 'Facturación');
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Agregar cliente')), isTrue,
        reason: 'El POS no abrió. En pantalla: ${textos(tester)}');

    // Cliente sintético
    await tester.tap(find.text('Agregar cliente').first);
    await asentar(tester);
    await tester.tap(find.text('Nuevo cliente'));
    await asentar(tester);
    final campos = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    await tester.enterText(campos.at(0), telefono);
    await tester.enterText(campos.at(1), cliente);
    await asentar(tester);
    await tester.tap(find.text('Crear'));
    await asentar(tester);

    // Línea manual: 2 x 35,00 = 70,00
    await tester.tap(find.text('Venta fuera de inventario').first);
    await asentar(tester);
    final manual = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    await tester.enterText(manual.at(0), 'Servicio QA Ticket Discount');
    await tester.enterText(manual.at(1), '2');
    await tester.enterText(manual.at(2), '35');
    await asentar(tester);
    await tester.tap(find.text('Agregar al ticket'));
    await asentar(tester);

    // Descuento de línea del 10 % (la fórmula vive en pos-math.js)
    final botonDescuento = find.byTooltip('Descuento en esta línea');
    expect(await esperarAsentando(tester, botonDescuento), isTrue,
        reason: 'No aparece el descuento de línea. En pantalla: ${textos(tester)}');
    await tester.tap(botonDescuento.first);
    await asentar(tester);
    final campoDesc =
        find.ancestor(of: find.text('Porcentaje'), matching: find.byType(TextField));
    await tester.enterText(campoDesc.first, '10');
    await asentar(tester);
    await tester.tap(find.text('Aplicar'));
    await asentar(tester);
    expect(find.textContaining(RegExp(r'63[.,]00')), findsWidgets,
        reason: 'La previsualización debe mostrar 63,00 (70,00 − 10 %)');

    // Aparcar y comprobar el descuento en el SERVIDOR
    await tester.ensureVisible(find.text('Aparcar ticket'));
    await asentar(tester);
    await tester.tap(find.text('Aparcar ticket'));
    var guardado = false;
    var tickets = <Map<String, dynamic>>[];
    for (var intento = 0; intento < 20 && !guardado; intento += 1) {
      await asentar(tester, segundos: 2);
      tickets = await estado.repository.posTickets();
      guardado = jsonEncode(tickets).contains(sello);
    }
    expect(guardado, isTrue, reason: 'El ticket con descuento no se guardó');

    final ticket = tickets.firstWhere((row) => jsonEncode(row).contains(sello));
    final draft = (ticket['draft'] as Map).cast<String, dynamic>();
    final items = (draft['items'] as List).cast<Map>();
    final item = items.first.cast<String, dynamic>();
    final descuento = (item['discount'] as Map?)?.cast<String, dynamic>() ?? const {};
    expect((item['manual'] as Map?)?['name'], 'Servicio QA Ticket Discount');
    expect((item['manual'] as Map?)?['price'], 35);
    expect(item['quantity'], 2);
    expect(descuento['type'], 'percent', reason: 'El descuento debe guardarse en el ticket');
    expect(descuento['value'], 10);
    debugPrint('TICKET DESCUENTO: id=${ticket['id']} version=${ticket['version']} '
        'descuento=${descuento['type']}:${descuento['value']}');

    // Reanudar y cobrar
    await tester.ensureVisible(find.text('Tickets guardados'));
    await asentar(tester);
    await tester.tap(find.text('Tickets guardados'));
    await asentar(tester);
    await tester.tap(find.text('Reanudar').first);
    for (var intento = 0; intento < 20 && find.byType(AlertDialog).evaluate().isNotEmpty; intento += 1) {
      await asentar(tester, segundos: 2);
    }
    expect(find.textContaining(RegExp(r'63[.,]00')), findsWidgets,
        reason: 'Al reanudar debe verse el mismo total con descuento');
    await tester.tap(find.text('Retiro'));
    await asentar(tester);

    final cobrar = find.text('Crear pedido');
    expect(await esperarAsentando(tester, cobrar), isTrue);
    var alcanzable = false;
    for (var intento = 0; intento < 25 && !alcanzable; intento += 1) {
      await asentar(tester, segundos: 2);
      alcanzable = cobrar.hitTestable().evaluate().isNotEmpty;
    }
    expect(alcanzable, isTrue, reason: 'El cobro debe ser alcanzable');
    await tester.tap(cobrar.hitTestable());

    var pedido = <String, dynamic>{};
    for (var intento = 0; intento < 30 && pedido.isEmpty; intento += 1) {
      await asentar(tester, segundos: 2);
      final pagina = await estado.repository.ordersPage(limit: 5);
      pedido = pagina.orders.firstWhere(
        (row) => jsonEncode(row).contains(sello),
        orElse: () => <String, dynamic>{},
      );
    }
    expect(pedido, isNotEmpty, reason: 'El cobro con descuento no creó pedido');
    if (find.text('Listo').evaluate().isNotEmpty) {
      await tester.tap(find.text('Listo'));
      await asentar(tester);
    }

    final despues = await estado.repository.ordersPage(limit: 5);
    expect(despues.total, pedidosAntes + 1,
        reason: 'Exactamente UN pedido con descuento');
    final total = double.tryParse(pedido['total'].toString()) ?? -1;
    expect(total, closeTo(63, 0.01),
        reason: 'El servidor debe guardar 63,00 tras el 10 % (guardó $total)');
    final payload = (pedido['payload'] ?? '').toString();
    expect(payload.contains('Servicio QA Ticket Discount'), isTrue,
        reason: 'El pedido debe contener la línea manual');
    debugPrint('DESCUENTO OK: pedido=${pedido['id']} total=$total');
  });
}

