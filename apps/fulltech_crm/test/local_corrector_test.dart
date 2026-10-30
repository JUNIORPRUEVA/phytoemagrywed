// Corrección local del borrador: lo que arregla y lo que NO debe tocar.
//
// Esta pasada no usa IA ni red: es la que hace que el botón de IA sirva para algo
// aunque no haya clave configurada.
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/text/local_corrector.dart';

void main() {
  group('corrección local', () {
    test('arregla errores de escritura frecuentes', () {
      final r = revisarTexto('ola ke ase');
      final texto = r.corrected.toLowerCase();
      expect(texto, contains('hola'));
      expect(texto, contains('que'));
      expect(texto, contains('hace'));
      expect(r.hasChanges, isTrue);
      expect(r.edits, isNotEmpty);
    });

    test('dos espacios y espacio antes del signo', () {
      final r = revisarTexto('Hola  mundo ,  como estas');
      expect(r.corrected, 'Hola mundo, como estas');
    });

    test('añade el signo de apertura de interrogación', () {
      final r = revisarTexto('Tienes el pedido?');
      expect(r.corrected, '¿Tienes el pedido?');
    });

    test('añade mayúscula al empezar y después de punto', () {
      final r = revisarTexto('hola. como estas');
      expect(r.corrected, 'Hola. Como estas');
    });

    test('corrige acentos de palabras del negocio', () {
      final r = revisarTexto('El telefono y la direccion');
      expect(r.corrected, 'El teléfono y la dirección');
    });

    test('no toca los signos de apertura que ya están', () {
      final r = revisarTexto('¿Tienes el pedido?');
      expect(r.corrected, '¿Tienes el pedido?');
    });

    test('no altera un texto ya correcto', () {
      const texto = 'Buenos días, el pedido sale hoy.';
      final r = revisarTexto(texto);
      expect(r.corrected, texto);
      expect(r.hasChanges, isFalse);
    });

    test('no cambia palabras ambiguas ni números', () {
      final r = revisarTexto('Mándame 3 mas y el 809-555-1234');
      expect(r.corrected, contains('3 mas'));
      expect(r.corrected, contains('809-555-1234'));
    });

    test('respeta mayúsculas del original al reemplazar', () {
      final r = revisarTexto('Ke pasa');
      expect(r.corrected, 'Que pasa');
    });

    test('no inventa contenido en un texto vacío', () {
      final r = revisarTexto('');
      expect(r.corrected, '');
      expect(r.hasChanges, isFalse);
    });
  });
}
