import 'package:file_picker/file_picker.dart';

/// Archivo elegido por una persona: nombre y bytes.
///
/// Es lo mínimo que necesita el envío. El tipo real (imagen, PDF, audio) NO se
/// decide aquí: lo decide el servidor mirando los bytes del archivo.
class PickedMediaFile {
  const PickedMediaFile({required this.name, required this.bytes});

  final String name;
  final List<int> bytes;
}

/// Selector de archivos del chat.
///
/// En producción abre el diálogo **nativo del sistema** (`file_picker`), que es
/// el que debe seguir usándose. La aceptación automática en Windows no puede
/// conducir un diálogo del sistema operativo, así que existe un único punto de
/// sustitución (`override`) que solo rellenan las pruebas. Si nadie lo rellena,
/// el comportamiento es exactamente el de antes.
abstract final class MediaPicker {
  /// Sustitución usada SOLO por las pruebas de aceptación nativa.
  static Future<PickedMediaFile?> Function(List<String> allowed)? override;

  /// Abre el diálogo del sistema y devuelve el archivo, o `null` si se cancela.
  static Future<PickedMediaFile?> pick(List<String> allowed) async {
    final custom = override;
    if (custom != null) return custom(allowed);
    final picked = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: allowed,
      withData: true,
    );
    if (picked == null || picked.files.isEmpty) return null;
    final file = picked.files.first;
    final bytes = file.bytes;
    if (bytes == null) return null;
    return PickedMediaFile(name: file.name, bytes: bytes);
  }
}
