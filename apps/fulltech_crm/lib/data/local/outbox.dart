import 'dart:convert';

import 'key_value_store.dart';

/// Qué se puede encolar (y qué NO).
///
/// Solo acciones seguras de repetir: mensajes de chat y abrir/cerrar una
/// conversación. **Cobros, devoluciones, ventas y cambios de estado de pedido
/// nunca entran aquí**: esas operaciones mueven dinero o inventario y se
/// resuelven en línea o con revisión humana.
enum OutboxKind { message, resolve, reopen }

enum OutboxState {
  /// Esperando turno.
  queued,

  /// Se está enviando ahora mismo.
  sending,

  /// Falló por algo que puede pasar solo (red, 5xx): se puede reintentar.
  retryable,

  /// Falló por algo que no se arregla reintentando (permisos, ventana de 24 h,
  /// datos inválidos): necesita que una persona decida.
  permanent,
}

/// Política de reintentos. Pura y probada: no depende de la red.
class OutboxPolicy {
  const OutboxPolicy._();

  static const int maxAttempts = 5;

  /// Códigos donde reintentar NO sirve (hay que cambiar algo antes).
  static const Set<int> permanentStatuses = {400, 401, 403, 404, 405, 409, 410, 422};

  /// Sin respuesta se considera reintentable **solo** porque cada operación
  /// lleva `x-fulltech-operation` y el servidor no la ejecuta dos veces.
  static bool isRetryable(int? statusCode) {
    if (statusCode == null) return false;
    if (statusCode == 0) return true; // timeout / sin red
    if (permanentStatuses.contains(statusCode)) return false;
    if (statusCode == 408 || statusCode == 425 || statusCode == 429) return true;
    if (statusCode == 503) return true; // mantenimiento: se reintenta luego
    if (statusCode >= 500) return true;
    return false;
  }

  static OutboxState nextState({required int attempts, required int? statusCode}) {
    if (!isRetryable(statusCode)) return OutboxState.permanent;
    return attempts >= maxAttempts ? OutboxState.permanent : OutboxState.retryable;
  }
}

/// Operación pendiente, tal cual se guarda en el aparato.
class OutboxOp {
  OutboxOp({
    required this.id,
    required this.kind,
    required this.conversationId,
    required this.createdAt,
    this.body = '',
    this.attempts = 0,
    this.state = OutboxState.queued,
    this.lastError = '',
    this.lastStatus,
  });

  /// Doble uso: identificador local y cabecera `x-fulltech-operation`.
  final String id;
  final OutboxKind kind;
  final String conversationId;
  final String body;
  final String createdAt;
  int attempts;
  OutboxState state;
  String lastError;
  int? lastStatus;

  bool get isSending => state == OutboxState.sending;
  bool get needsHuman => state == OutboxState.permanent;
  bool get canRetry => state == OutboxState.queued || state == OutboxState.retryable;

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind.name,
        'conversationId': conversationId,
        'body': body,
        'createdAt': createdAt,
        'attempts': attempts,
        'state': state.name,
        'lastError': lastError,
        'lastStatus': lastStatus,
      };

  factory OutboxOp.fromJson(Map<String, dynamic> json) => OutboxOp(
        id: '${json['id'] ?? ''}',
        kind: OutboxKind.values.firstWhere(
          (value) => value.name == json['kind'],
          orElse: () => OutboxKind.message,
        ),
        conversationId: '${json['conversationId'] ?? ''}',
        body: '${json['body'] ?? ''}',
        createdAt: '${json['createdAt'] ?? ''}',
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        state: OutboxState.values.firstWhere(
          (value) => value.name == json['state'],
          orElse: () => OutboxState.queued,
        ),
        lastError: '${json['lastError'] ?? ''}',
        lastStatus: (json['lastStatus'] as num?)?.toInt(),
      );
}

/// Cola persistente.
///
/// La clave de cada operación se genera UNA vez y se guarda: es lo que permite
/// al servidor deduplicar (`server/offline-operations.mjs`).
class OutboxStore {
  OutboxStore(this._kv);

  static const String storageKey = 'ft_crm_outbox_v2';

  final KeyValueStore _kv;

  Future<List<OutboxOp>> load() async {
    final raw = await _kv.read(storageKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return decoded
          .whereType<Map>()
          .map((row) => OutboxOp.fromJson(row.map((key, value) => MapEntry(key.toString(), value))))
          .where((op) => op.id.isNotEmpty && op.conversationId.isNotEmpty)
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> save(List<OutboxOp> ops) async {
    await _kv.write(storageKey, jsonEncode(ops.map((op) => op.toJson()).toList()));
  }

  Future<List<OutboxOp>> clear() async {
    await _kv.remove(storageKey);
    return [];
  }
}
