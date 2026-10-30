/// Corrección LOCAL del texto del chat (sin IA y sin red).
///
/// POR QUÉ EXISTE
///
/// En la PWA la revisión del borrador no depende de la IA: hay una pasada local
/// que arregla lo evidente y marca dudas, y solo después se consulta al servidor.
/// La app nativa no tenía esa pasada, así que sin clave de IA no pasaba
/// absolutamente nada al pulsar «Corregir». Esto cubre ese hueco: es determinista,
/// instantáneo y no envía el texto a ningún sitio.
///
/// REGLAS QUE NO SE ROMPEN
///   · No se reescribe la frase ni se inventa contenido: solo se arreglan cosas
///     objetivas (espacios, mayúsculas, signos de apertura) y errores de escritura
///     de una lista cerrada.
///   · Si algo es ambiguo, se deja como está.
///   · Cada cambio se devuelve explicado para que la persona decida.
library;

/// Un cambio concreto sobre el texto.
class LocalEdit {
  const LocalEdit({
    required this.kind,
    required this.before,
    required this.after,
    required this.reason,
  });

  /// `espacios` | `signos` | `mayuscula` | `palabra`.
  final String kind;
  final String before;
  final String after;
  final String reason;

  @override
  String toString() => '$kind: "$before" -> "$after"';
}

/// Resultado de revisar un texto.
class LocalReview {
  const LocalReview({required this.original, required this.corrected, required this.edits});

  final String original;
  final String corrected;
  final List<LocalEdit> edits;

  bool get hasChanges => corrected != original;
  int get count => edits.length;
}

/// Errores de escritura frecuentes en el chat (clave en minúsculas).
///
/// CORTA y conservadora a propósito: solo entradas cuyo reemplazo no cambia lo
/// que la persona quiso decir. Fuera «pa»/«baya»/«valla», que dependen del
/// contexto, y fuera palabras válidas como «mas», «solo» o «aun».
const Map<String, String> _comunes = {
  'ke': 'que',
  'k': 'que',
  'xq': 'porque',
  'xk': 'porque',
  'porq': 'porque',
  'tb': 'también',
  'tmb': 'también',
  'tmbn': 'también',
  'ola': 'hola',
  'ase': 'hace',
  'aki': 'aquí',
  'aqi': 'aquí',
  'aqui': 'aquí',
  'asi': 'así',
  'alli': 'allí',
  'dnd': 'dónde',
  'dde': 'desde',
  'sta': 'está',
  'stoy': 'estoy',
  'toy': 'estoy',
  'muxo': 'mucho',
  'mxo': 'mucho',
  'nunk': 'nunca',
  'nunka': 'nunca',
  'devo': 'debo',
  'ise': 'hice',
  'hise': 'hice',
  'grasias': 'gracias',
  'grs': 'gracias',
  'grax': 'gracias',
  'xfa': 'por favor',
  'xfavor': 'por favor',
  'porfis': 'por favor',
  'pls': 'por favor',
  'okk': 'ok',
  'okey': 'ok',
  'adios': 'adiós',
  'dia': 'día',
  'dias': 'días',
  'informacion': 'información',
  'direccion': 'dirección',
  'telefono': 'teléfono',
  'envio': 'envío',
  'numero': 'número',
  'articulo': 'artículo',
  'tambien': 'también',
  'estan': 'están',
  'sera': 'será',
  'podre': 'podré',
  'tendra': 'tendrá',
  'habra': 'habrá',
  'cuanto': 'cuánto',
  'cuando': 'cuándo',
  'donde': 'dónde',
  'quien': 'quién',
  'cual': 'cuál',
  'haver': 'haber',
  'llendo': 'yendo',
  'haiga': 'haya',
  'dijistes': 'dijiste',
  'vinistes': 'viniste',
  'fuistes': 'fuiste',
  'hicistes': 'hiciste',
  'aver': 'a ver',
  'aber': 'a ver',
};

/// Revisa y corrige el texto. Nunca lanza.
LocalReview revisarTexto(String original) {
  final edits = <LocalEdit>[];
  var texto = original;

  // 1) Espacios: dobles, al principio y antes de signos de puntuación.
  final sinDobles = texto.replaceAll(RegExp(r'[ \t]{2,}'), ' ');
  if (sinDobles != texto) {
    edits.add(const LocalEdit(kind: 'espacios', before: '  ', after: ' ', reason: 'Espacios repetidos'));
    texto = sinDobles;
  }
  final sinAntes = texto.replaceAllMapped(RegExp(r'[ \t]+([,.;:!?…)])'), (m) => m.group(1)!);
  if (sinAntes != texto) {
    edits.add(const LocalEdit(kind: 'espacios', before: ' ,', after: ',', reason: 'Espacio antes de un signo'));
    texto = sinAntes;
  }
  final recortado = texto.trimLeft();
  if (recortado != texto) {
    edits.add(const LocalEdit(kind: 'espacios', before: ' ', after: '', reason: 'Espacio al principio'));
    texto = recortado;
  }

  // 2) Signos repetidos: «!!» y «???» se quedan en uno (los «...» no se tocan).
  final sinRepetidos = texto.replaceAllMapped(RegExp(r'([!?])\1{1,}'), (m) => m.group(1)!);
  if (sinRepetidos != texto) {
    edits.add(const LocalEdit(kind: 'signos', before: '!!', after: '!', reason: 'Signo repetido'));
    texto = sinRepetidos;
  }

  // 3) Palabras de la lista cerrada. Se recorre palabra por palabra para no
  //    depender de lookbehind (no está disponible en todas las plataformas Dart).
  final resultado = StringBuffer();
  var ultimo = 0;
  for (final match in RegExp(r'[\p{L}\p{N}]+', unicode: true).allMatches(texto)) {
    resultado.write(texto.substring(ultimo, match.start));
    final palabra = match.group(0)!;
    final reemplazo = _comunes[palabra.toLowerCase()];
    if (reemplazo == null) {
      resultado.write(palabra);
    } else {
      final conCaja = _mismaCaja(reemplazo, palabra);
      if (conCaja != palabra) {
        edits.add(LocalEdit(kind: 'palabra', before: palabra, after: conCaja, reason: 'Escritura habitual'));
      }
      resultado.write(conCaja);
    }
    ultimo = match.end;
  }
  resultado.write(texto.substring(ultimo));
  texto = resultado.toString();

  // 4) Signos de apertura (¿ ¡) al empezar la frase, si faltan.
  texto = _abrirSignos(texto, edits);

  // 5) Mayúscula al empezar, después de punto y después de «¿»/«¡».
  final conMayusculas = texto.replaceAllMapped(
    RegExp(r'(^|[.!?…]\s+|[¿¡]\s*)(\p{Ll})', unicode: true),
    (match) => '${match.group(1)}${match.group(2)!.toUpperCase()}',
  );
  if (conMayusculas != texto) {
    edits.add(const LocalEdit(kind: 'mayuscula', before: 'a', after: 'A', reason: 'Mayúscula al empezar la frase'));
    texto = conMayusculas;
  }

  return LocalReview(original: original, corrected: texto, edits: edits);
}

/// Inserta `¿`/`¡` delante de la frase que cierra con `?`/`!` si no los tiene.
String _abrirSignos(String texto, List<LocalEdit> edits) {
  final inserciones = <int, String>{};
  var inicioFrase = 0;
  for (var i = 0; i < texto.length; i += 1) {
    final caracter = texto[i];
    if (caracter == '?' || caracter == '!') {
      final tramo = texto.substring(inicioFrase, i);
      final apertura = caracter == '?' ? '¿' : '¡';
      if (!tramo.contains('¿') && !tramo.contains('¡')) {
        var posicion = inicioFrase;
        while (posicion < i && (texto[posicion] == ' ' || texto[posicion] == '\n')) {
          posicion += 1;
        }
        if (posicion == i) {
          // El signo va solo (por ejemplo «… ?»): no se inventa una frase.
          inserciones[posicion] = apertura;
        } else if (!inserciones.containsKey(posicion)) {
          inserciones[posicion] = apertura;
        } else {
          // Ya había apertura en esta posición: nada que hacer.
        }
        edits.add(LocalEdit(
          kind: 'signos',
          before: caracter,
          after: '$apertura…$caracter',
          reason: 'Falta el signo de apertura',
        ));
      }
      inicioFrase = i + 1;
    } else if (caracter == '.' || caracter == '…' || caracter == '\n') {
      inicioFrase = i + 1;
    }
  }
  if (inserciones.isEmpty) return texto;
  final salida = StringBuffer();
  for (var i = 0; i <= texto.length; i += 1) {
    final extra = inserciones[i];
    if (extra != null) salida.write(extra);
    if (i < texto.length) salida.write(texto[i]);
  }
  return salida.toString();
}

/// Aplica al reemplazo la misma «caja» que traía la palabra original.
String _mismaCaja(String reemplazo, String original) {
  if (original.isEmpty || reemplazo.isEmpty) return reemplazo;
  final todaMayus = original == original.toUpperCase() && original.toUpperCase() != original.toLowerCase();
  if (todaMayus && reemplazo.length > 1) return reemplazo.toUpperCase();
  final empiezaMayus = original[0] == original[0].toUpperCase() && original[0] != original[0].toLowerCase();
  if (empiezaMayus) return reemplazo[0].toUpperCase() + reemplazo.substring(1);
  return reemplazo;
}
