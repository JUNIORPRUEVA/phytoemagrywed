import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/local/key_value_store.dart';
import 'package:fulltech_crm/data/local/outbox.dart';
import 'package:fulltech_crm/data/local/outbox_service.dart';

import 'support/fakes.dart';

OutboxService buildService(TestHarness harness, FakeTransport transport) => OutboxService(
      store: OutboxStore(harness.store),
      transport: transport,
    );

void main() {
  group('cola offline: estados', () {
    test('un mensaje encolado se guarda y sobrevive a reiniciar la app', () async {
      final harness = TestHarness();
      final first = buildService(harness, FakeTransport());
      await first.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      // Otra instancia con el mismo almacén = app reabierta.
      final second = buildService(harness, FakeTransport());
      final ops = await second.load();
      expect(ops, hasLength(1));
      expect(ops.single.body, 'hola');
      expect(ops.single.state, OutboxState.queued);
    });

    test('si se envía bien, la operación desaparece', () async {
      final harness = TestHarness();
      final transport = FakeTransport();
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      final result = await service.flush();
      expect(result.sent, 1);
      expect(service.count, 0);
      expect(transport.messages.single.body, 'hola');
    });

    test('sin red queda reintentable y NO se pierde', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(0, 'sin red'));
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      final result = await service.flush();
      expect(result.sent, 0);
      expect(service.count, 1);
      expect(service.ops.single.state, OutboxState.retryable);
      expect(service.ops.single.attempts, 1);
    });

    test('un error permanente no se reintenta solo', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(409, 'Fuera de la ventana de 24 h.'));
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      await service.flush();
      expect(service.ops.single.state, OutboxState.permanent);
      expect(service.needsHuman, hasLength(1));

      // Un flush más NO lo vuelve a intentar.
      await service.flush();
      expect(transport.messages, isEmpty);
      expect(service.count, 1);
    });

    test('tras demasiados intentos pasa a revisión humana', () async {
      final harness = TestHarness();
      final transport = FakeTransport();
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      for (var attempt = 0; attempt < OutboxPolicy.maxAttempts; attempt++) {
        transport.failures.add(ApiException(0, 'sin red'));
        await service.flush();
      }
      expect(service.ops.single.state, OutboxState.permanent);
      expect(service.ops.single.attempts, OutboxPolicy.maxAttempts);
    });

    test('reintento manual desde la revisión vuelve a encolarse', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(403, 'sin permiso'));
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');
      await service.flush();
      final id = service.ops.single.id;
      expect(service.ops.single.state, OutboxState.permanent);

      await service.retry(id);
      expect(service.count, 0);
      expect(transport.messages.single.body, 'hola');
    });

    test('descartar quita la operación sin enviarla', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(422, 'dato inválido'));
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');
      await service.flush();
      final id = service.ops.single.id;

      await service.discard(id);
      expect(service.count, 0);
      expect(transport.messages, isEmpty);
    });

    test('cerrar sesión vacía la cola', () async {
      final harness = TestHarness();
      final service = buildService(harness, FakeTransport());
      await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');
      await service.clear();
      expect(service.count, 0);
      expect(await service.load(), isEmpty);
    });
  });

  group('deduplicación de mensajes', () {
    test('un reintento reutiliza la MISMA clave de operación', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(0, 'timeout'));
      final service = buildService(harness, transport);
      final op = await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      await service.flush(); // falla
      await service.flush(); // reintenta

      expect(transport.messages, hasLength(1));
      expect(transport.messages.single.operationKey, op.id);
      expect(ApiClient.operationKeyPattern.hasMatch(op.id), isTrue);
    });

    test('la clave se guarda y se reutiliza tras reabrir la app', () async {
      final harness = TestHarness();
      final first = buildService(harness, FakeTransport());
      final op = await first.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');

      final transport = FakeTransport();
      final second = buildService(harness, transport);
      await second.load();
      await second.flush();

      expect(transport.messages.single.operationKey, op.id);
    });

    test('una clave que no cumple el contrato no se envía a ciegas', () async {
      final harness = TestHarness();
      await harness.store.write(OutboxStore.storageKey, '[{"id":"corta","kind":"message","conversationId":"c1","body":"x","createdAt":"","attempts":0,"state":"queued"}]');
      final transport = FakeTransport();
      final service = buildService(harness, transport);

      await service.load();
      expect(service.ops.single.state, OutboxState.permanent);

      await service.flush();
      expect(transport.messages, isEmpty);
    });

    test('si el servidor dice «completada», no se reenvía', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(0, 'timeout'));
      final service = buildService(harness, transport);
      final op = await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');
      await service.flush();

      transport.serverStatuses = {op.id: 'completada'};
      await service.verifyWithServer();
      expect(service.count, 0);
      expect(transport.verifyCalls, 1);
    });

    test('si el servidor dice «no_recibida», queda lista para enviar', () async {
      final harness = TestHarness();
      final transport = FakeTransport()..failures.add(ApiException(0, 'timeout'));
      final service = buildService(harness, transport);
      final op = await service.enqueue(kind: OutboxKind.message, conversationId: 'c1', body: 'hola');
      await service.flush();

      transport.serverStatuses = {op.id: 'no_recibida'};
      await service.verifyWithServer();
      expect(service.ops.single.state, OutboxState.queued);
    });
  });

  group('protección de dinero', () {
    test('la cola solo admite mensajes y abrir/cerrar conversación', () {
      expect(OutboxService.allowedKinds, {OutboxKind.message, OutboxKind.resolve, OutboxKind.reopen});
      // No existe ningún tipo de cobro, venta o devolución que encolar.
      expect(OutboxKind.values, hasLength(3));
    });

    test('abrir/cerrar conversación también viaja con clave', () async {
      final harness = TestHarness();
      final transport = FakeTransport();
      final service = buildService(harness, transport);
      await service.enqueue(kind: OutboxKind.resolve, conversationId: 'c1');

      await service.flush();
      expect(transport.resolutions, hasLength(1));
      expect(transport.resolutions.single, startsWith('c1:resolve:'));
    });
  });

  group('política de reintentos', () {
    test('5xx y timeout se reintentan; 4xx de dominio no', () {
      expect(OutboxPolicy.isRetryable(0), isTrue);
      expect(OutboxPolicy.isRetryable(502), isTrue);
      expect(OutboxPolicy.isRetryable(503), isTrue);
      expect(OutboxPolicy.isRetryable(429), isTrue);
      expect(OutboxPolicy.isRetryable(409), isFalse);
      expect(OutboxPolicy.isRetryable(422), isFalse);
      expect(OutboxPolicy.isRetryable(403), isFalse);
      expect(OutboxPolicy.isRetryable(null), isFalse);
    });
  });

  group('almacén', () {
    test('un JSON corrupto no rompe la app', () async {
      final harness = TestHarness();
      await harness.store.write(OutboxStore.storageKey, 'no-soy-json');
      final service = buildService(harness, FakeTransport());
      expect(await service.load(), isEmpty);
    });

    test('MemoryKeyValueStore conserva lo escrito', () async {
      final store = MemoryKeyValueStore();
      await store.write('k', 'v');
      expect(await store.read('k'), 'v');
      await store.remove('k');
      expect(await store.read('k'), isNull);
    });
  });
}
