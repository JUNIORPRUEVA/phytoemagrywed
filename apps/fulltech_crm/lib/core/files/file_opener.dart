import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../net/api_client.dart';

/// Abre documentos del CRM (recibos, expedientes) con el visor del sistema.
///
/// SEGURIDAD (Etapa 0):
/// · Los binarios se descargan con la cookie de sesión: nunca por URL pública.
/// · Se guardan en una carpeta propia (`crm_docs`) dentro del temporal, con
///   nombre saneado, y se **borran** en cuanto dejan de ser recientes (2 días)
///   o al cerrar sesión (`purgeAll`).
/// · No se registra ni el nombre del cliente ni el contenido: solo el resultado.
class FileOpener {
  const FileOpener._();

  static const String _folder = 'crm_docs';
  static const String _prefix = 'crm_';
  static const Duration _maxAge = Duration(days: 2);

  static Future<Directory> _directory() async {
    final base = await getTemporaryDirectory();
    final directory = Directory('${base.path}${Platform.pathSeparator}$_folder');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return directory;
  }

  /// Guarda el archivo y lo abre. Devuelve la ruta, o `null` si no se pudo abrir.
  static Future<String?> saveAndOpen(ApiFile file) async {
    await purgeOld();
    final directory = await _directory();
    final safeName = file.fileName.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    final target = File(
      '${directory.path}${Platform.pathSeparator}$_prefix${DateTime.now().millisecondsSinceEpoch}_$safeName',
    );
    await target.writeAsBytes(file.bytes, flush: true);
    if (kIsWeb) return target.path;
    final result = await OpenFilex.open(target.path);
    if (kDebugMode) {
      // Solo el resultado: ni rutas con nombres de cliente ni contenido.
      debugPrint('[crm] abrir documento: ${result.type}');
    }
    return result.type == ResultType.done ? target.path : null;
  }

  /// Borra los archivos que ya no hace falta conservar.
  static Future<int> purgeOld({Duration? olderThan}) async {
    if (kIsWeb) return 0;
    try {
      final directory = await _directory();
      final limit = DateTime.now().subtract(olderThan ?? _maxAge);
      var removed = 0;
      await for (final entity in directory.list()) {
        if (entity is! File) continue;
        final name = entity.uri.pathSegments.last;
        if (!name.startsWith(_prefix)) continue;
        try {
          final stat = await entity.stat();
          if (stat.modified.isBefore(limit)) {
            await entity.delete();
            removed++;
          }
        } catch (_) {
          // Un archivo bloqueado por el visor se reintenta en la próxima pasada.
        }
      }
      return removed;
    } catch (_) {
      return 0;
    }
  }

  /// Al cerrar sesión: no queda ningún documento de cliente en el aparato.
  static Future<void> purgeAll() => purgeOld(olderThan: Duration.zero);
}
