import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/net/event_stream.dart';

void main() {
  group('decodificador SSE', () {
    test('lee un evento completo', () {
      final decoder = SseDecoder();
      final events = decoder.feed('event: message.created\nid: 42\ndata: {"id":"m1"}\n\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'message.created');
      expect(events.single.id, '42');
      expect(events.single.json['id'], 'm1');
    });

    test('tolera eventos partidos por la mitad', () {
      final decoder = SseDecoder();
      expect(decoder.feed('event: order.upd'), isEmpty);
      expect(decoder.feed('ated\ndata: {"order":1}'), isEmpty);
      final events = decoder.feed('\n\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'order.updated');
      expect(events.single.json['order'], 1);
    });

    test('ignora los comentarios de keep-alive', () {
      final decoder = SseDecoder();
      expect(decoder.feed(': ping\n\n'), isEmpty);
      final events = decoder.feed('data: {}\n\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'message');
    });

    test('varios eventos en un mismo trozo', () {
      final decoder = SseDecoder();
      final events = decoder.feed('id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"a":2}\n\n');
      expect(events.map((row) => row.id), ['1', '2']);
    });

    test('reconoce el aviso de resync', () {
      final decoder = SseDecoder();
      final events = decoder.feed('event: resync\ndata: {"oldest":10}\n\n');
      expect(events.single.isResync, isTrue);
      expect(events.single.json['oldest'], 10);
    });

    test('un JSON roto no lanza excepción', () {
      final decoder = SseDecoder();
      final events = decoder.feed('data: no-es-json\n\n');
      expect(events.single.json, isEmpty);
    });

    test('data multilínea se une con salto de línea', () {
      final decoder = SseDecoder();
      final events = decoder.feed('data: linea1\ndata: linea2\n\n');
      expect(events.single.data, 'linea1\nlinea2');
    });
  });

  group('reconexión del canal', () {
    test('la espera crece y tiene techo', () {
      expect(RealtimePolicy.delayForAttempt(0), const Duration(seconds: 1));
      expect(RealtimePolicy.delayForAttempt(1), const Duration(seconds: 2));
      expect(RealtimePolicy.delayForAttempt(2), const Duration(seconds: 4));
      expect(RealtimePolicy.delayForAttempt(3), const Duration(seconds: 8));
      expect(RealtimePolicy.delayForAttempt(9).inSeconds, lessThanOrEqualTo(RealtimePolicy.maxDelay.inSeconds));
    });

    test('las recargas se agrupan (no una por evento)', () {
      expect(RealtimePolicy.refreshDebounce.inMilliseconds, greaterThan(0));
    });
  });
}
