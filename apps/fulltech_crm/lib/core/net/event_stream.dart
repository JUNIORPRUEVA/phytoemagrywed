import 'dart:convert';

/// Decodificador de Server-Sent Events (SSE).
///
/// Se usa para `/api/admin/events`. Es una clase pura (sin red) para poder
/// probarla: entra texto y salen eventos completos, tal y como los manda el
/// servidor (`event:`, `id:`, `data:` y una línea en blanco de cierre).
class ServerSentEvent {
  const ServerSentEvent({required this.event, required this.data, required this.id});

  final String event;
  final String data;
  final String id;

  /// El servidor avisa de que nos hemos perdido eventos (buffer desbordado):
  /// hay que recargar todo en lugar de confiar en el incremental.
  bool get isResync => event == 'resync';

  Map<String, dynamic> get json {
    try {
      final decoded = jsonDecode(data);
      return decoded is Map ? decoded.map((key, value) => MapEntry(key.toString(), value)) : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  @override
  String toString() => 'ServerSentEvent($event, id=$id)';
}

class SseDecoder {
  final StringBuffer _data = StringBuffer();
  String _event = 'message';
  String _id = '';
  String _pending = '';

  /// Alimenta texto y devuelve los eventos que se hayan completado.
  ///
  /// Las líneas incompletas se guardan: por la red un evento puede llegar
  /// partido en dos trozos y procesar media línea corrompería el nombre del
  /// evento (fallo real detectado por las pruebas de esta etapa).
  List<ServerSentEvent> feed(String chunk) {
    final events = <ServerSentEvent>[];
    _pending += chunk;
    while (true) {
      final index = _pending.indexOf('\n');
      if (index == -1) break;
      var line = _pending.substring(0, index);
      _pending = _pending.substring(index + 1);
      if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
      _handleLine(line, events);
    }
    return events;
  }

  void _handleLine(String line, List<ServerSentEvent> events) {
    if (line.isEmpty) {
      final payload = _data.toString();
      if (payload.isNotEmpty) {
        events.add(ServerSentEvent(event: _event, data: payload, id: _id));
      }
      _data.clear();
      _event = 'message';
      _id = '';
      return;
    }
    if (line.startsWith(':')) return; // comentario / keep-alive
    final separator = line.indexOf(':');
    final field = separator == -1 ? line : line.substring(0, separator);
    var value = separator == -1 ? '' : line.substring(separator + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
      case 'id':
        _id = value;
      case 'data':
        if (_data.isNotEmpty) _data.write('\n');
        _data.write(value);
      default:
      // `retry:` y campos desconocidos se ignoran, como pide la especificación.
    }
  }
}

/// Reglas de reconexión del canal en vivo.
///
/// Puras y probadas: qué hacer cuando se cae la conexión, cuándo rendirse y
/// cómo no machacar al servidor con reintentos seguidos.
class RealtimePolicy {
  const RealtimePolicy._();

  static const Duration initialDelay = Duration(seconds: 1);
  static const Duration maxDelay = Duration(seconds: 30);

  /// Espera entre intentos: 1, 2, 4, 8… con techo.
  static Duration delayForAttempt(int attempt) {
    if (attempt <= 0) return initialDelay;
    final seconds = initialDelay.inSeconds * (1 << (attempt.clamp(0, 5)));
    final capped = seconds.clamp(initialDelay.inSeconds, maxDelay.inSeconds);
    return Duration(seconds: capped);
  }

  /// Un evento de negocio no debe provocar una recarga por cada línea: se agrupa.
  static const Duration refreshDebounce = Duration(milliseconds: 900);
}
