/// Generador de claves de operación (`x-fulltech-operation`).
///
/// El servidor exige 16–100 caracteres `[A-Za-z0-9_-]` y usa la clave para no
/// ejecutar dos veces la misma acción (ver `server/offline-operations.mjs`).
library;

final RegExp operationKeyPattern = RegExp(r'^[A-Za-z0-9_-]{16,100}$');

int _sequence = 0;

String newOperationKey(String prefix) {
  final clean = prefix.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');
  final stamp = DateTime.now().microsecondsSinceEpoch.toString();
  // Contador: dos claves del mismo microsegundo no pueden coincidir.
  final sequence = (++_sequence).toRadixString(36);
  final noise = (DateTime.now().hashCode & 0xffffff).toRadixString(36);
  final candidate = '${clean}_${stamp}_${sequence}_$noise';
  if (operationKeyPattern.hasMatch(candidate)) return candidate;
  // Solo puede fallar si se quedó corta: se rellena hasta 16.
  return candidate.padRight(16, '0');
}
