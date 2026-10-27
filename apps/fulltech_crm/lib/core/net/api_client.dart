import 'dart:convert';

import 'package:http/http.dart' as http;

import '../auth/session_store.dart';
import '../config/app_config.dart';
import 'event_stream.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.message, {this.code = '', this.payload = const {}});

  final int statusCode;
  final String message;
  final String code;

  /// Cuerpo del error (sin datos sensibles más allá de lo que ya devuelve el CRM).
  final Map<String, dynamic> payload;

  bool get isUnauthorized => statusCode == 401;

  /// Sin respuesta del servidor: timeout, DNS, red caída. El resultado es
  /// DESCONOCIDO y nunca se debe repetir a ciegas una operación de dinero.
  bool get isUncertain => statusCode == 0;

  @override
  String toString() => message;
}

/// Archivo descargado de la API con la sesión del panel.
class ApiFile {
  const ApiFile({required this.bytes, required this.contentType, required this.fileName});

  final List<int> bytes;
  final String contentType;
  final String fileName;

  bool get isPdf => contentType == 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  bool get isImage => contentType.startsWith('image/');
}

/// Cliente HTTP del panel.
///
/// · Sesión: cookie `pe_crm` guardada en el almacén seguro del sistema.
/// · Idempotencia: cualquier POST puede llevar `x-fulltech-operation`, que el
///   servidor usa para no ejecutar dos veces la misma operación (ver
///   `server/offline-operations.mjs`).
/// · Nunca registra cookies, cuerpos ni tokens en los logs.
class ApiClient {
  ApiClient({http.Client? httpClient, String? baseUrl, SessionStore? sessionStore})
      : _http = httpClient ?? http.Client(),
        baseUrl = (baseUrl ?? AppConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), ''),
        _store = sessionStore ?? SecureSessionStore();

  static const String cookieName = 'pe_crm';
  static const String operationHeader = 'x-fulltech-operation';
  static const Duration _timeout = Duration(seconds: 30);

  /// La clave de operación debe cumplir el patrón del servidor: 16–100
  /// caracteres `[A-Za-z0-9_-]`.
  static final RegExp operationKeyPattern = RegExp(r'^[A-Za-z0-9_-]{16,100}$');

  final http.Client _http;
  final String baseUrl;
  final SessionStore _store;
  String? _sessionCookie;

  bool get hasSession => (_sessionCookie ?? '').isNotEmpty;

  Future<void> restoreSession() async {
    final value = await _store.read();
    _sessionCookie = (value ?? '').isEmpty ? null : value;
  }

  Future<void> clearSession() async {
    _sessionCookie = null;
    await _store.clear();
  }

  Uri _uri(String path, Map<String, String?> query) {
    final params = <String, String>{
      for (final entry in query.entries)
        if (entry.value != null && entry.value!.isNotEmpty) entry.key: entry.value!,
    };
    final target = path.startsWith('/') ? path : '/$path';
    return Uri.parse('$baseUrl$target').replace(queryParameters: params.isEmpty ? null : params);
  }

  Map<String, String> _headers({bool json = false, String? operationKey}) => {
        'accept': 'application/json',
        if (json) 'content-type': 'application/json; charset=utf-8',
        if ((_sessionCookie ?? '').isNotEmpty) 'cookie': '$cookieName=$_sessionCookie',
        if (operationKey != null && operationKey.isNotEmpty) operationHeader: operationKey,
      };

  /// Descarga autenticada de un archivo (PDF de recibo, documento de repartidor).
  Future<ApiFile> getFile(String path, {String fallbackName = 'documento'}) async {
    final uri = _uri(path, const {});
    late final http.Response response;
    try {
      response = await _http.get(uri, headers: _headers()).timeout(_timeout);
    } catch (_) {
      throw ApiException(0, 'No pudimos conectar con el CRM. Revisa tu conexión.');
    }
    await _rememberCookie(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(response.statusCode, _fallbackMessage(response.statusCode));
    }
    final disposition = response.headers['content-disposition'] ?? '';
    final nameMatch = RegExp(r'filename="?([^";]+)"?').firstMatch(disposition);
    final rawName = (nameMatch?.group(1) ?? fallbackName).trim();
    final type = (response.headers['content-type'] ?? '').split(';').first.trim();
    final extension = switch (type) {
      'application/pdf' => 'pdf',
      'text/html' => 'html',
      'image/png' => 'png',
      'image/jpeg' => 'jpg',
      _ => '',
    };
    final hasExtension = rawName.contains('.');
    return ApiFile(
      bytes: response.bodyBytes,
      contentType: type,
      fileName: hasExtension || extension.isEmpty ? rawName : '$rawName.$extension',
    );
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, String?> query = const {}}) =>
      _send('GET', path, query: query);

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body, {String? operationKey}) =>
      _send('POST', path, body: body, operationKey: operationKey);

  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic> body, {String? operationKey}) =>
      _send('PATCH', path, body: body, operationKey: operationKey);

  Future<Map<String, dynamic>> delete(String path, {Map<String, dynamic> body = const {}, String? operationKey}) =>
      _send('DELETE', path, body: body, operationKey: operationKey);

  /// Sube bytes CRUDOS (foto, PDF, nota de voz).
  ///
  /// El servidor del CRM recibe el cuerpo tal cual en
  /// `POST /api/admin/conversations/:id/media` y decide el tipo mirando el
  /// contenido, no la cabecera: no se usa multipart.
  Future<Map<String, dynamic>> postBytes(
    String path,
    List<int> bytes, {
    String? contentType,
    String? filename,
    Map<String, String?> query = const {},
    String? operationKey,
    Duration? timeout,
  }) async {
    final uri = _uri(path, query);
    late final http.Response response;
    try {
      final request = http.Request('POST', uri);
      request.headers.addAll({
        'accept': 'application/json',
        'content-type': ?contentType,
        if ((filename ?? '').isNotEmpty) 'x-phyto-filename': filename!,
        if ((_sessionCookie ?? '').isNotEmpty) 'cookie': '$cookieName=$_sessionCookie',
        if (operationKey != null && operationKey.isNotEmpty) operationHeader: operationKey,
      });
      request.bodyBytes = bytes;
      final streamed = await _http.send(request).timeout(timeout ?? const Duration(seconds: 90));
      response = await http.Response.fromStream(streamed);
    } catch (_) {
      throw ApiException(0, 'No pudimos enviar el archivo. Revisa tu conexión.');
    }
    return _decode(response);
  }

  /// Canal de eventos del servidor (`/api/admin/events`).
  ///
  /// Devuelve el flujo de eventos ya decodificados. Si la conexión se corta, el
  /// flujo termina: quien lo escucha decide cuándo reconectar.
  Stream<ServerSentEvent> openEventStream(String path, {Map<String, String?> query = const {}}) async* {
    final uri = _uri(path, query);
    final request = http.Request('GET', uri);
    request.headers.addAll({
      ..._headers(),
      'accept': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-crm-device': 'flutter-crm',
    });
    late final http.StreamedResponse response;
    try {
      response = await _http.send(request).timeout(_timeout);
    } catch (_) {
      throw ApiException(0, 'No pudimos abrir el canal en vivo.');
    }
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, _fallbackMessage(response.statusCode));
    }
    final decoder = SseDecoder();
    await for (final chunk in response.stream.transform(utf8.decoder)) {
      for (final event in decoder.feed(chunk)) {
        yield event;
      }
    }
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, String?> query = const {},
    Map<String, dynamic>? body,
    String? operationKey,
  }) async {
    final uri = _uri(path, query);
    late final http.Response response;
    try {
      response = switch (method) {
        'GET' => await _http.get(uri, headers: _headers()).timeout(_timeout),
        'POST' => await _http
            .post(uri, headers: _headers(json: true, operationKey: operationKey), body: jsonEncode(body ?? const {}))
            .timeout(_timeout),
        'PATCH' => await _http
            .patch(uri, headers: _headers(json: true, operationKey: operationKey), body: jsonEncode(body ?? const {}))
            .timeout(_timeout),
        'DELETE' => await _http
            .delete(uri, headers: _headers(json: true, operationKey: operationKey), body: jsonEncode(body ?? const {}))
            .timeout(_timeout),
        _ => throw ApiException(400, 'Método no soportado: $method'),
      };
    } on ApiException {
      rethrow;
    } catch (_) {
      // Timeout, DNS o red caída: NO sabemos si el servidor llegó a ejecutar.
      throw ApiException(0, 'No pudimos conectar con el CRM. Revisa tu conexión.');
    }
    return _decode(response);
  }

  Future<Map<String, dynamic>> _decode(http.Response response) async {
    await _rememberCookie(response);
    final text = utf8.decode(response.bodyBytes, allowMalformed: true);
    var data = <String, dynamic>{};
    if (text.isNotEmpty) {
      try {
        final decoded = jsonDecode(text);
        if (decoded is Map<String, dynamic>) data = decoded;
      } catch (_) {
        // Respuesta no JSON (por ejemplo un 502 del proxy): se informa por estado.
      }
    }
    final status = response.statusCode;
    if (status >= 200 && status < 300) return data;
    final message = (data['message'] as String?) ?? _fallbackMessage(status);
    throw ApiException(
      status,
      message,
      code: (data['error'] as String?) ?? '',
      payload: data,
    );
  }

  /// Lee `Set-Cookie` y guarda/borra la sesión en el almacén seguro.
  Future<void> _rememberCookie(http.Response response) async {
    final raw = response.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;
    final match = RegExp('$cookieName=([^;,]*)').firstMatch(raw);
    if (match == null) return;
    final value = (match.group(1) ?? '').trim();
    final revoked = RegExp('max-age=0', caseSensitive: false).hasMatch(raw);
    if (value.isEmpty || revoked) {
      _sessionCookie = null;
      await _store.clear();
    } else {
      _sessionCookie = value;
      await _store.write(value);
    }
  }

  String _fallbackMessage(int status) => switch (status) {
        0 => 'No pudimos conectar con el CRM. Revisa tu conexión.',
        401 => 'Tu sesión terminó. Inicia sesión de nuevo.',
        403 => 'No tienes permiso para esta acción.',
        404 => 'No encontramos lo que buscabas.',
        409 => 'La operación no se pudo completar por el estado actual del CRM.',
        422 => 'Revisa los datos: hay algo que no es válido.',
        429 => 'Demasiados intentos. Espera unos minutos.',
        503 => 'El CRM está en mantenimiento. Intenta más tarde.',
        _ => 'No pudimos completar la operación. Intenta de nuevo.',
      };

  void close() => _http.close();
}
