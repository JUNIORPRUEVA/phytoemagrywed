import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('cabeceras del cliente', () {
    test('envía la cookie de sesión y la clave de operación', () async {
      late Map<String, String> captured;
      final client = MockClient((request) async {
        captured = request.headers;
        return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
      });
      final api = ApiClient(
        httpClient: client,
        baseUrl: 'http://localhost:4000',
        sessionStore: MemorySessionStore('sesion-de-prueba'),
      );
      await api.restoreSession();
      await api.post('/api/admin/conversations/c1/messages', {'body': 'hola'}, operationKey: 'msg_1234567890abcdef');

      expect(captured['cookie'], 'pe_crm=sesion-de-prueba');
      expect(captured[ApiClient.operationHeader], 'msg_1234567890abcdef');
      // El panel NO elige empresa desde el cliente: lo decide el servidor por rol.
      expect(captured.keys.where((key) => key.toLowerCase().contains('company')), isEmpty);
    });

    test('sin clave de operación no se manda la cabecera', () async {
      late Map<String, String> captured;
      final client = MockClient((request) async {
        captured = request.headers;
        return http.Response('{}', 200);
      });
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore());
      await api.get('/api/admin/data');

      expect(captured.containsKey(ApiClient.operationHeader), isFalse);
    });

    test('guarda la cookie que devuelve el servidor', () async {
      final store = MemorySessionStore();
      final client = MockClient((request) async => http.Response(
            jsonEncode({'ok': true, 'user': {'id': 'u1', 'username': 'ana', 'role': 'ADMIN'}}),
            200,
            headers: {'set-cookie': 'pe_crm=nueva-sesion; Path=/; HttpOnly; Max-Age=3600'},
          ));
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: store);

      await api.post('/api/admin/auth/login', {'username': 'ana', 'password': 'x'});
      expect(store.value, 'nueva-sesion');
    });

    test('el cierre de sesión (Max-Age=0) borra la cookie guardada', () async {
      final store = MemorySessionStore('vieja');
      final client = MockClient((request) async => http.Response(
            jsonEncode({'ok': true}),
            200,
            headers: {'set-cookie': 'pe_crm=; Path=/; Max-Age=0'},
          ));
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: store);

      await api.post('/api/admin/auth/logout', const {});
      expect(store.value, isNull);
    });
  });

  group('errores', () {
    test('401 se marca como no autorizado', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({'ok': false, 'error': 'unauthorized', 'message': 'Sesion terminada'}),
            401,
          ));
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore());

      await expectLater(
        api.get('/api/admin/session'),
        throwsA(isA<ApiException>()
            .having((e) => e.isUnauthorized, 'isUnauthorized', isTrue)
            .having((e) => e.statusCode, 'statusCode', 401)
            .having((e) => e.message, 'message', 'Sesion terminada')),
      );
    });

    test('un fallo de red es INCIERTO y no se confunde con un rechazo', () async {
      final client = MockClient((request) async => throw const SocketExceptionFake());
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore());

      await expectLater(
        api.post('/api/admin/pos/checkout', const {}),
        throwsA(isA<ApiException>().having((e) => e.isUncertain, 'isUncertain', isTrue)),
      );
    });

    test('el código de error del servidor viaja para decidir qué hacer', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({'ok': false, 'error': 'price_changed', 'message': 'Los precios cambiaron.'}),
            409,
          ));
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore());

      await expectLater(
        api.post('/api/admin/pos/checkout', const {}),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'price_changed')),
      );
    });
  });

  group('contrato de la clave de operación', () {
    test('acepta 16–100 caracteres alfanuméricos', () {
      expect(ApiClient.operationKeyPattern.hasMatch('msg_1234567890abcdef'), isTrue);
      expect(ApiClient.operationKeyPattern.hasMatch('abcdefghijklmnop'), isTrue);
      expect(ApiClient.operationKeyPattern.hasMatch('corta'), isFalse);
      expect(ApiClient.operationKeyPattern.hasMatch('con espacios aqui 1234'), isFalse);
      expect(ApiClient.operationKeyPattern.hasMatch('a' * 101), isFalse);
    });
  });

  group('permisos y aislamiento', () {
    test('un administrador puede todo', () {
      const session = CrmSession(permissions: {}, legacy: false);
      expect(session.isAdmin, isFalse);
      const admin = CrmSession(permissions: {}, legacy: true);
      expect(admin.can('settings.manage'), isTrue);
    });

    test('un permiso no concedido se niega', () {
      final session = CrmSession(permissions: {'chats.reply'});
      expect(session.can('chats.reply'), isTrue);
      expect(session.can('settings.manage'), isFalse);
      expect(session.can('admin.full'), isFalse);
    });

    test('un permiso desconocido nunca se concede por accidente', () {
      final session = CrmSession(permissions: {'chats.reply'});
      expect(session.can('dinero.cobrar'), isFalse);
      expect(session.can(''), isFalse);
    });

    test('sin sesión no hay permisos', () {
      const session = CrmSession();
      expect(session.authenticated, isFalse);
      expect(session.can('orders.read'), isFalse);
    });
  });
}

/// Excepción de red simulada (no depende de `dart:io` para poder correr en VM).
class SocketExceptionFake implements Exception {
  const SocketExceptionFake();

  @override
  String toString() => 'sin red';
}
