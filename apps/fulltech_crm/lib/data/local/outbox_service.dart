import '../../core/net/api_client.dart';
import '../crm_repository.dart';
import 'outbox.dart';

/// Lo que la cola necesita del mundo exterior. Se abstrae para poder probarla
/// con un doble: ninguna prueba de esta capa toca la red ni el servidor.
abstract class OutboxTransport {
  Future<void> sendMessage(String conversationId, String body, {required String operationKey});
  Future<void> setResolved(String conversationId, {required bool resolved, required String operationKey});

  /// Estado de las operaciones en el servidor (`/offline-operations/status`).
  /// Devuelve `clave → estado` (`completada`, `en_proceso`, `no_recibida`…).
  Future<Map<String, String>> verify(List<String> keys);
}

class RepoOutboxTransport implements OutboxTransport {
  RepoOutboxTransport(this._repository);

  final CrmRepository _repository;

  @override
  Future<void> sendMessage(String conversationId, String body, {required String operationKey}) =>
      _repository.sendMessage(conversationId, body, operationKey: operationKey);

  @override
  Future<void> setResolved(String conversationId, {required bool resolved, required String operationKey}) =>
      _repository.setResolved(conversationId, resolved, operationKey: operationKey);

  @override
  Future<Map<String, String>> verify(List<String> keys) => _repository.operationStatuses(keys);
}

class OutboxFlushResult {
  const OutboxFlushResult({required this.sent, required this.remaining, required this.needsHuman});

  final int sent;
  final List<OutboxOp> remaining;
  final List<OutboxOp> needsHuman;

  bool get hasWork => remaining.isNotEmpty;
}

/// Máquina de estados de la cola offline.
///
/// Reglas que NO se saltan:
/// 1. Solo se encolan mensajes y abrir/cerrar conversación (nunca dinero).
/// 2. Cada operación tiene una clave estable que viaja en `x-fulltech-operation`:
///    el servidor no la ejecuta dos veces aunque el móvil reintente.
/// 3. Si una operación falla de forma permanente, NO se reintenta sola: queda
///    marcada para que una persona la revise o la descarte.
class OutboxService {
  OutboxService({required OutboxStore store, required OutboxTransport transport})
      : _store = store,
        _transport = transport;

  final OutboxStore _store;
  final OutboxTransport _transport;

  static const Set<OutboxKind> allowedKinds = {OutboxKind.message, OutboxKind.resolve, OutboxKind.reopen};

  List<OutboxOp> _ops = const [];

  List<OutboxOp> get ops => List.unmodifiable(_ops);
  int get count => _ops.length;
  List<OutboxOp> get needsHuman => _ops.where((op) => op.state == OutboxState.permanent).toList();
  List<OutboxOp> get ready => _ops.where((op) => op.canRetry).toList();

  Future<List<OutboxOp>> load() async {
    _ops = await _store.load();
    // Operaciones de la versión anterior (v1): se conservan, pero si su clave no
    // cumple el contrato del servidor no se pueden deduplicar → revisión humana.
    _ops = _ops.map((op) {
      if (!ApiClient.operationKeyPattern.hasMatch(op.id)) {
        op.state = OutboxState.permanent;
        op.lastError = 'Clave de operación no válida: no se puede garantizar que no se duplique.';
      }
      return op;
    }).toList();
    await _store.save(_ops);
    return _ops;
  }

  Future<OutboxOp> enqueue({
    required OutboxKind kind,
    required String conversationId,
    String body = '',
    String? operationKey,
  }) async {
    if (!allowedKinds.contains(kind)) {
      throw ArgumentError('Operación no permitida en la cola offline: $kind');
    }
    final key = operationKey ?? _newKey(kind);
    if (!ApiClient.operationKeyPattern.hasMatch(key)) {
      throw ArgumentError('La clave de operación no cumple el contrato del servidor.');
    }
    final op = OutboxOp(
      id: key,
      kind: kind,
      conversationId: conversationId,
      body: body,
      createdAt: DateTime.now().toIso8601String(),
    );
    _ops = [..._ops, op];
    await _store.save(_ops);
    return op;
  }

  /// Intenta enviar lo que esté listo. Devuelve el resumen.
  ///
  /// `manual` solo cambia una cosa: un reintento manual ignora el límite de
  /// intentos (la persona está delante y decide).
  Future<OutboxFlushResult> flush({bool manual = false}) async {
    var sent = 0;

    // Se recorre una COPIA: durante el envío la lista real cambia (se quitan
    // las que ya salieron).
    for (final op in List<OutboxOp>.of(_ops)) {
      if (!_ops.contains(op)) continue;
      if (op.state == OutboxState.permanent) continue;
      if (!manual && !op.canRetry) continue;
      if (!ApiClient.operationKeyPattern.hasMatch(op.id)) {
        op.state = OutboxState.permanent;
        op.lastError = 'Clave de operación no válida.';
        continue;
      }
      op.state = OutboxState.sending;
      op.attempts += 1;
      await _store.save(_ops);
      try {
        switch (op.kind) {
          case OutboxKind.message:
            await _transport.sendMessage(op.conversationId, op.body, operationKey: op.id);
          case OutboxKind.resolve:
            await _transport.setResolved(op.conversationId, resolved: true, operationKey: op.id);
          case OutboxKind.reopen:
            await _transport.setResolved(op.conversationId, resolved: false, operationKey: op.id);
        }
        _ops.remove(op);
        sent++;
      } on ApiException catch (error) {
        op.lastStatus = error.statusCode;
        op.lastError = error.message;
        op.state = OutboxPolicy.nextState(attempts: op.attempts, statusCode: error.statusCode);
        if (op.state == OutboxState.permanent) {
          // Nada de martillear al servidor con algo que ya sabemos que falla.
          op.lastError = '${error.message} (revisión necesaria)';
        }
      }
    }

    await _store.save(_ops);
    return OutboxFlushResult(sent: sent, remaining: List.of(_ops), needsHuman: needsHuman);
  }

  /// Antes de reenviar una operación incierta se pregunta al servidor qué pasó.
  ///
  /// Si el servidor dice `completada`, la operación se da por hecha y se quita
  /// (no se duplica). Si dice `no_recibida`, se queda lista para reintentar.
  Future<Map<String, String>> verifyWithServer() async {
    final uncertain = _ops.where((op) => op.lastStatus == 0 && op.state != OutboxState.permanent).toList();
    if (uncertain.isEmpty) return const {};
    final states = await _transport.verify(uncertain.map((op) => op.id).toList());
    final working = <OutboxOp>[..._ops];
    for (final op in uncertain) {
      final state = states[op.id] ?? '';
      if (state == 'completada') {
        working.remove(op);
      } else if (state == 'no_recibida') {
        op.state = OutboxState.queued;
        op.lastError = 'El servidor no la recibió: se puede reintentar.';
      }
    }
    _ops = working;
    await _store.save(_ops);
    return states;
  }

  Future<void> retry(String id) async {
    final op = _ops.where((row) => row.id == id).firstOrNull;
    if (op == null) return;
    op.state = OutboxState.queued;
    op.attempts = 0;
    await _store.save(_ops);
    await flush(manual: true);
  }

  Future<void> discard(String id) async {
    _ops = _ops.where((row) => row.id != id).toList();
    await _store.save(_ops);
  }

  Future<void> clear() async {
    _ops = await _store.clear();
  }

  static int _sequence = 0;

  static String _newKey(OutboxKind kind) {
    final prefix = switch (kind) {
      OutboxKind.message => 'msg',
      OutboxKind.resolve => 'res',
      OutboxKind.reopen => 'reo',
    };
    final stamp = DateTime.now().microsecondsSinceEpoch.toString();
    // Contador + ruido: dos operaciones del mismo microsegundo NO pueden
    // compartir clave (el servidor las trataría como la misma).
    final sequence = (++_sequence).toRadixString(36);
    final noise = (DateTime.now().hashCode & 0xffff).toRadixString(36);
    return '${prefix}_${stamp}_${sequence}_$noise';
  }
}
