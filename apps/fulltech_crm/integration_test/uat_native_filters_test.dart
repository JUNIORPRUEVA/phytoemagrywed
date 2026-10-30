import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fulltech_crm/features/pedidos/pedidos_screen.dart';

import 'support/native_harness.dart';

/// Escenario 5: filtros de estado de pedidos con datos SINTÉTICOS reales.
///
///   flutter test integration_test/uat_native_filters_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
///
/// Se crean dos ventas por la UI nativa del POS, se mueven por las
/// transiciones REALES del servidor (`finish` y cambio de estado) y luego se
/// comprueban los filtros de la pantalla de Pedidos.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('pedidos: filtros entregados y cancelados con datos sinteticos', (tester) async {
    final estado = await arrancar(tester);
    await entrarComoAdmin(tester);

    final sello = DateTime.now().millisecondsSinceEpoch.toString();
    final nombreEntregado = await ventaManualEnPos(
      tester,
      sello: sello,
      descripcion: 'Servicio entregado QA',
      precio: 50,
    );
    final nombreCancelado = await ventaManualEnPos(
      tester,
      sello: '${sello.substring(sello.length - 6)}9',
      descripcion: 'Servicio cancelado QA',
      precio: 40,
    );

    // Identificación por nombre único en el estado autoritativo del servidor.
    Future<String> idDe(String nombre) async {
      final pagina = await estado.repository.ordersPage(limit: 50);
      final fila = pagina.orders.firstWhere(
        (row) => (row['name'] ?? '').toString() == nombre,
        orElse: () => <String, dynamic>{},
      );
      return (fila['id'] ?? '').toString();
    }

    final idEntregado = await idDe(nombreEntregado);
    final idCancelado = await idDe(nombreCancelado);
    expect(idEntregado, isNotEmpty, reason: 'No encuentro la venta «$nombreEntregado»');
    expect(idCancelado, isNotEmpty, reason: 'No encuentro la venta «$nombreCancelado»');

    // Transiciones REALES del backend (las mismas que usa la app).
    await estado.repository.finishOrder(idEntregado);
    await estado.repository.changeOrderStatus(idCancelado, 'cancelado', reason: 'QA F15 filtros');

    final entregados = await estado.repository.ordersPage(limit: 5, status: 'entregado');
    final cancelados = await estado.repository.ordersPage(limit: 5, status: 'cancelado');
    expect(entregados.orders.any((row) => row['id'] == idEntregado), isTrue,
        reason: 'El servidor debe listar la venta como entregada');
    expect(cancelados.orders.any((row) => row['id'] == idCancelado), isTrue,
        reason: 'El servidor debe listar la venta como cancelada');

    // ── Filtros desde la UI nativa ──────────────────────────────────────────
    await irA(tester, 'Pedidos');
    expect(await esperarAsentando(tester, find.byType(PedidosScreen)), isTrue,
        reason: 'Pedidos no abrió. En pantalla: ${textos(tester)}');
    expect(await esperarAsentando(tester, find.textContaining('pedidos de')), isTrue);

    await tester.tap(find.text('Entregados'));
    await asentar(tester);
    expect(find.text('Sin pedidos con este filtro'), findsNothing,
        reason: 'Con pedidos entregados reales el filtro no puede quedar vacío');
    expect(find.textContaining(nombreEntregado), findsWidgets,
        reason: 'El filtro «Entregados» debe mostrar la venta entregada. '
            'En pantalla: ${textos(tester)}');
    expect(find.textContaining(nombreCancelado), findsNothing,
        reason: 'El filtro «Entregados» no puede mostrar la venta cancelada');

    await tester.tap(find.text('Cancelados'));
    await asentar(tester);
    expect(find.textContaining(nombreCancelado), findsWidgets,
        reason: 'El filtro «Cancelados» debe mostrar la venta cancelada. '
            'En pantalla: ${textos(tester)}');
    expect(find.textContaining(nombreEntregado), findsNothing,
        reason: 'Al cambiar de filtro no pueden quedar filas del filtro anterior');

    await tester.tap(find.text('Abiertos'));
    await asentar(tester);
    expect(find.textContaining(nombreEntregado), findsNothing,
        reason: 'Una venta entregada no es un pedido abierto');
    expect(find.textContaining(nombreCancelado), findsNothing,
        reason: 'Una venta cancelada no es un pedido abierto');
    expect(await esperarAsentando(tester, find.textContaining('pedidos de')), isTrue);

    debugPrint(
      'FILTROS OK: entregado=$idEntregado cancelado=$idCancelado '
      'totalEntregados=${entregados.total} totalCancelados=${cancelados.total}',
    );
  });
}
