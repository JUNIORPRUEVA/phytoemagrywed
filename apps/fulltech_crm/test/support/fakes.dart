import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/local/key_value_store.dart';
import 'package:fulltech_crm/data/local/outbox_service.dart';

/// Caja segura en memoria (sustituye al Keystore en las pruebas).
class FakeSecureBox implements SecureBox {
  final Map<String, String> data = {};

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async => data[key] = value;

  @override
  Future<void> delete(String key) async => data.remove(key);
}

/// Transporte que apunta lo que se envía y permite programar errores.
class FakeTransport implements OutboxTransport {
  FakeTransport();

  final List<SentMessage> messages = [];
  final List<String> resolutions = [];

  /// Error que se lanza en el siguiente envío (se consume una vez por envío).
  ApiException? failWith;

  /// Errores en cola: cada envío consume el primero.
  final List<ApiException> failures = [];

  Map<String, String> serverStatuses = {};

  int verifyCalls = 0;

  String? get lastKey => messages.isEmpty ? null : messages.last.operationKey;
  String? get lastBody => messages.isEmpty ? null : messages.last.body;

  @override
  Future<void> sendMessage(String conversationId, String body, {required String operationKey}) async {
    if (failures.isNotEmpty) throw failures.removeAt(0);
    messages.add(SentMessage(conversationId: conversationId, body: body, operationKey: operationKey));
  }

  @override
  Future<void> setResolved(String conversationId, {required bool resolved, required String operationKey}) async {
    if (failures.isNotEmpty) throw failures.removeAt(0);
    resolutions.add('$conversationId:${resolved ? 'resolve' : 'reopen'}:$operationKey');
  }

  @override
  Future<Map<String, String>> verify(List<String> keys) async {
    verifyCalls++;
    return {
      for (final key in keys)
        if (serverStatuses.containsKey(key)) key: serverStatuses[key]!,
    };
  }
}

class SentMessage {
  const SentMessage({required this.conversationId, required this.body, required this.operationKey});

  final String conversationId;
  final String body;
  final String operationKey;
}

/// Memoria compartida entre pruebas de cola.
class TestHarness {
  TestHarness() : kv = MemoryKeyValueStore();

  final MemoryKeyValueStore kv;

  KeyValueStore get store => kv;
}
