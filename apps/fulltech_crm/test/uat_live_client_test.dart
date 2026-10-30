@Tags(['uat'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';

/// PRUEBA DE INTEGRACIÓN CONTRA LA UAT LOCAL (no es un test de backend en Node:
/// aquí el cliente Flutter real —`ApiClient` + `CrmRepository`— habla HTTP).
///
/// Solo corre si se le pasa la dirección:
///
/// ```powershell
/// $env:UAT_BASE_URL='http://127.0.0.1:8791'
/// flutter test test/uat_live_client_test.dart
/// ```
///
/// Sin la variable se SALTA (no falla): así `flutter test` sigue siendo verde en
/// cualquier máquina sin UAT. La UAT es la local de `scripts/uat-env.mjs`
/// (SQLite desechable, WhatsApp mock, sin push ni Meta), nunca producción.
///
/// Credenciales: las del sembrador del propio repositorio (`scripts/uat-env.mjs`
/// crea `admin@uat.local`). Son datos de prueba públicos, no secretos.
void main() {
  final base = Platform.environment['UAT_BASE_URL'];
  final user = Platform.environment['UAT_USER'] ?? 'admin@uat.local';
  final pass = Platform.environment['UAT_PASSWORD'] ?? 'UatLocal-123';
  final skip = base == null ? 'Sin UAT_BASE_URL: prueba de integración omitida.' : null;

  CrmRepository repo(String url) => CrmRepository(
        ApiClient(baseUrl: url, sessionStore: MemorySessionStore('')),
      );

  test('la sesión de la UAT se abre con el cliente Flutter', () async {
    final r = repo(base!);
    final session = await r.login(username: user, password: pass);
    expect(session.user?.role, isNotNull);
    expect(session.can('admin.full'), isTrue, reason: 'el usuario sembrado es ADMIN');
  }, skip: skip);

  test('el inventario real se decodifica con el contrato de la pantalla', () async {
    final r = repo(base!);
    await r.login(username: user, password: pass);
    final data = await r.inventory();
    expect(data['stock'], isA<num>());
    expect(data['initialized'], isA<bool>());
    final presentations = (data['presentations'] as List).cast<Map<String, dynamic>>();
    expect(presentations, isNotEmpty);
    // Campos que la pantalla usa de verdad (antes leía `name`/`stock` dentro de
    // la presentación y pintaba 0 en todas las filas).
    expect(presentations.first.containsKey('capsule_quantity'), isTrue);
    expect(presentations.first.containsKey('label'), isTrue);
  }, skip: skip);

  test('los pedidos llegan por la ruta que usa la pantalla, sin mentir sobre el total', () async {
    final r = repo(base!);
    await r.login(username: user, password: pass);
    final all = await r.allOrders();
    expect(all.orders, isNotEmpty);
    expect(all.total, all.orders.length);
    expect(all.orders.every((row) => row['type'] == 'order_intent'), isTrue);
    final ids = all.orders.map((row) => row['id']).toSet();
    expect(ids.length, all.orders.length, reason: 'sin duplicados al fusionar');
    // El servidor topa el paquete completo en 500 y con más pedidos devuelve
    // `partial: false` igualmente: si llegan 500 filas NO se puede afirmar que
    // sean todas, y el cliente debe decirlo.
    if (all.orders.length >= CrmRepository.serverOrderCeiling) {
      expect(all.complete, isFalse, reason: 'con el tope alcanzado no se declara completa');
    } else {
      expect(all.complete, isTrue);
    }
  }, skip: skip);

  test('el listado paginado devuelve TODOS los pedidos sin duplicados (1.000+)', () async {
    final r = repo(base!);
    await r.login(username: user, password: pass);
    final ids = <String>{};
    String? cursor;
    var total = 0;
    var pages = 0;
    var hasMore = true;
    while (hasMore && pages < 60) {
      final page = await r.ordersPage(limit: 200, cursor: cursor);
      pages += 1;
      total = page.total;
      for (final row in page.orders) {
        ids.add('${row['id']}');
      }
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
    expect(pages, greaterThan(1), reason: 'la UAT debe tener más de una página');
    expect(ids.length, total, reason: 'todas las filas del total, sin duplicados ni huecos');
    // El paquete de arranque sigue recortado: por eso existe este endpoint.
    final full = await r.allOrders();
    expect(full.orders.length, lessThanOrEqualTo(CrmRepository.serverOrderCeiling));
  }, skip: skip);
}
