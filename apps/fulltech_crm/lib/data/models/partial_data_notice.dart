/// Avisos de datos incompletos.
///
/// El paquete ligero del panel (`/api/admin/data?light=1`) corta en 150 pedidos
/// y 150 conversaciones. Una lista cortada presentada como completa es una
/// mentira operativa: aquí vive el texto único que lo explica.
library;

class PartialDataNotice {
  const PartialDataNotice._();

  /// Umbral del servidor (se pide «uno de más» y se recorta a este número).
  static const int serverLimit = 150;

  static String message({
    required bool partial,
    required bool customersComplete,
    required bool conversationsComplete,
  }) {
    if (!partial) return '';
    final pending = <String>[
      if (!customersComplete) 'clientes',
      if (!conversationsComplete) 'bandeja',
    ];
    if (pending.isEmpty) {
      return 'El servidor devolvió solo los $serverLimit pedidos más recientes: '
          'la lista de pedidos puede estar incompleta.';
    }
    return 'El servidor devolvió los $serverLimit registros más recientes '
        '(${pending.join(' y ')} sin completar): la lista puede estar incompleta.';
  }
}
