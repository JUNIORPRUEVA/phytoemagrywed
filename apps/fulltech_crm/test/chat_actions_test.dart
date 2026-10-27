import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Cliente con sesión y una respuesta fija, apuntando lo que le llega.
({CrmRepository repo, List<http.BaseRequest> requests}) buildClient(Map<String, dynamic> body, {int status = 200}) {
  final requests = <http.BaseRequest>[];
  final client = MockClient((request) async {
    requests.add(request);
    return http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
  });
  final api = ApiClient(
    httpClient: client,
    baseUrl: 'http://localhost:4000',
    sessionStore: MemorySessionStore('sesion'),
  );
  return (repo: CrmRepository(api), requests: requests);
}

void main() {
  group('multimedia del chat', () {
    test('la subida va con kind, caption y clave en la URL, y bytes crudos', () async {
      final harness = buildClient({'ok': true, 'mediaType': 'image'});
      await harness.repo.api.restoreSession();

      await harness.repo.sendMedia(
        'c1',
        bytes: [1, 2, 3, 4],
        kind: 'image',
        filename: 'foto.jpg',
        caption: 'Hola',
        operationKey: 'img_1234567890abcdef',
      );

      final request = harness.requests.single;
      expect(request.method, 'POST');
      expect(request.url.path, '/api/admin/conversations/c1/media');
      expect(request.url.queryParameters['kind'], 'image');
      expect(request.url.queryParameters['caption'], 'Hola');
      expect(request.url.queryParameters['key'], 'img_1234567890abcdef');
      expect(request.headers['content-type'], 'image/jpeg');
      expect(request.headers['x-phyto-filename'], 'foto.jpg');
      expect(request.headers[ApiClient.operationHeader], 'img_1234567890abcdef');
      expect((request as http.Request).bodyBytes, [1, 2, 3, 4]);
    });

    test('el PDF y el audio se anuncian con su tipo real', () async {
      for (final entry in [
        ('informe.pdf', 'document', 'application/pdf'),
        ('nota.m4a', 'audio', 'audio/mp4'),
        ('nota.ogg', 'audio', 'audio/ogg'),
        ('foto.png', 'image', 'image/png'),
      ]) {
        final harness = buildClient({'ok': true});
        await harness.repo.sendMedia('c1', bytes: [0], kind: entry.$2, filename: entry.$1);
        expect(harness.requests.single.headers['content-type'], entry.$3, reason: entry.$1);
      }
    });

    test('sin nombre de archivo se deduce por el tipo de envío', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.sendMedia('c1', bytes: [0], kind: 'document');
      expect(harness.requests.single.headers['content-type'], 'application/pdf');
    });

    test('la descarga del adjunto usa la ruta autenticada', () async {
      final requests = <http.BaseRequest>[];
      final client = MockClient((request) async {
        requests.add(request);
        return http.Response.bytes([9, 9], 200, headers: {'content-type': 'image/png'});
      });
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore('s'));
      await api.restoreSession();
      final repo = CrmRepository(api);

      final file = await repo.mediaBytes('m1');
      expect(requests.single.url.path, '/api/admin/media/m1');
      expect(requests.single.headers['cookie'], 'pe_crm=s');
      expect(file.bytes, [9, 9]);
      expect(file.isImage, isTrue);
    });
  });

  group('acciones de la conversación', () {
    test('enviar ubicación usa el contrato real', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.sendLocation('c1', locationId: 'loc1', operationKey: 'loc_1234567890abcdef');

      final body = jsonDecode((harness.requests.single as http.Request).body) as Map<String, dynamic>;
      expect(harness.requests.single.url.path, '/api/admin/conversations/c1/location');
      expect(body['locationId'], 'loc1');
      expect(body['confirmed'], isTrue);
      expect(body['idempotencyKey'], 'loc_1234567890abcdef');
    });

    test('plantilla: solo se manda el nombre si no hay valores', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.sendTemplate('c1', 'phyto_bienvenida', operationKey: 'tpl_1234567890abcdef');
      final body = jsonDecode((harness.requests.single as http.Request).body) as Map<String, dynamic>;
      expect(body['template'], 'phyto_bienvenida');
      expect(body.containsKey('templateValues'), isFalse);
    });

    test('las tres acciones de asignación usan su ruta', () async {
      for (final action in ['take', 'release', 'assign']) {
        final harness = buildClient({'ok': true});
        await harness.repo.assignConversation('c1', action: action, userId: action == 'assign' ? 'u9' : null);
        expect(harness.requests.single.url.path, '/api/admin/conversations/c1/$action');
        final body = jsonDecode((harness.requests.single as http.Request).body) as Map<String, dynamic>;
        if (action == 'assign') {
          expect(body['userId'], 'u9');
        } else {
          expect(body.containsKey('userId'), isFalse);
        }
      }
    });

    test('solo se ofrecen usuarios activos y de oficina para asignar', () async {
      final harness = buildClient({
        'ok': true,
        'users': [
          {'id': 'u1', 'username': 'ana', 'display_name': 'Ana', 'role': 'AGENT', 'active': true},
          {'id': 'u2', 'username': 'rui', 'display_name': 'Rui', 'role': 'AGENT', 'active': false},
          {'id': 'u3', 'username': 'rep', 'display_name': 'Rep', 'role': 'DELIVERY', 'active': true},
          {'id': 'u4', 'username': 'adm', 'display_name': 'Adm', 'role': 'ADMIN', 'active': true},
        ],
      });
      final users = await harness.repo.assignableUsers();
      expect(users.map((row) => row['id']), ['u1', 'u4']);
    });

    test('las plantillas se filtran por aprobadas', () async {
      final harness = buildClient({
        'ok': true,
        'templates': [
          {'name': 'ok1', 'status': 'APPROVED'},
          {'name': 'no', 'status': 'PENDING'},
          {'name': 'ok2', 'status': 'approved'},
        ],
      });
      final approved = await harness.repo.waTemplates();
      expect(approved.map((row) => row['name']), ['ok1', 'ok2']);
    });
  });

  group('modelo del mensaje', () {
    test('lee adjunto y coordenadas del hilo', () {
      final withMedia = ChatMessage.fromJson({
        'id': 'm1',
        'direction': 'outbound',
        'type': 'image',
        'media': {'id': 'med1'},
        'body': '',
        'created_at': '2026-10-26T10:00:00Z',
      });
      expect(withMedia.hasMedia, isTrue);
      expect(withMedia.mediaId, 'med1');
      expect(withMedia.outgoing, isTrue);

      final withLocation = ChatMessage.fromJson({
        'id': 'm2',
        'direction': 'inbound',
        'type': 'location',
        'location': {'latitude': 18.4861, 'longitude': -69.9312},
      });
      expect(withLocation.hasCoordinates, isTrue);
      expect(withLocation.latitude, closeTo(18.4861, 0.0001));

      final plain = ChatMessage.fromJson({'id': 'm3', 'direction': 'inbound', 'body': 'hola'});
      expect(plain.hasMedia, isFalse);
      expect(plain.hasCoordinates, isFalse);
    });
  });
}
