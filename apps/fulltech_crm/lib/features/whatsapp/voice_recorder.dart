import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/theme/crm_theme.dart';

/// Nota de voz grabada y lista para enviar.
class RecordedVoice {
  const RecordedVoice({required this.bytes, required this.filename, required this.seconds});

  final Uint8List bytes;
  final String filename;
  final int seconds;
}

/// Hoja de grabación de una nota de voz: graba, se escucha y se envía (o se
/// cancela). Pide el permiso del micrófono y, si la persona lo niega, lo dice
/// sin romper nada: el chat sigue funcionando con texto, fotos y archivos.
Future<RecordedVoice?> showVoiceRecorder(BuildContext context) {
  return showModalBottomSheet<RecordedVoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => const _VoiceRecorderSheet(),
  );
}

class _VoiceRecorderSheet extends StatefulWidget {
  const _VoiceRecorderSheet();

  @override
  State<_VoiceRecorderSheet> createState() => _VoiceRecorderSheetState();
}

class _VoiceRecorderSheetState extends State<_VoiceRecorderSheet> {
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

  Timer? _ticker;
  String? _path;
  String? _error;
  Uint8List? _bytes;
  bool _recording = false;
  bool _playing = false;
  int _seconds = 0;

  @override
  void initState() {
    super.initState();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _recorder.dispose();
    _player.dispose();
    super.dispose();
  }

  /// Windows no tiene codificador AAC en el paquete: se graba WAV. El servidor
  /// convierte el audio si hace falta antes de mandarlo a WhatsApp.
  RecordConfig get _config => RecordConfig(
        encoder: Platform.isWindows ? AudioEncoder.wav : AudioEncoder.aacLc,
        bitRate: 64 * 1024,
        sampleRate: 44100,
        numChannels: 1,
      );

  String get _extension => Platform.isWindows ? 'wav' : 'm4a';

  Future<void> _start() async {
    setState(() => _error = null);
    try {
      final allowed = await _recorder.hasPermission();
      if (!allowed) {
        setState(() => _error = 'Sin permiso al micrófono. Actívalo en los ajustes del teléfono para grabar notas de voz.');
        return;
      }
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/nota_${DateTime.now().millisecondsSinceEpoch}.$_extension';
      await _recorder.start(_config, path: path);
      if (!mounted) return;
      setState(() {
        _recording = true;
        _seconds = 0;
        _bytes = null;
        _path = path;
      });
      _ticker?.cancel();
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted && _recording) setState(() => _seconds += 1);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = 'No se pudo empezar a grabar: $error');
    }
  }

  Future<void> _stop() async {
    _ticker?.cancel();
    try {
      final path = await _recorder.stop();
      final target = path ?? _path;
      if (target == null) {
        setState(() {
          _recording = false;
          _error = 'La grabación quedó vacía.';
        });
        return;
      }
      final file = File(target);
      final bytes = await file.exists() ? await file.readAsBytes() : Uint8List(0);
      if (!mounted) return;
      setState(() {
        _recording = false;
        _path = target;
        _bytes = bytes.isEmpty ? null : bytes;
        _error = bytes.isEmpty ? 'La grabación salió vacía.' : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _recording = false;
        _error = 'No se pudo terminar la grabación: $error';
      });
    }
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    final path = _path;
    if (path == null) return;
    try {
      await _player.play(DeviceFileSource(path));
      if (mounted) setState(() => _playing = true);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = 'No se pudo escuchar la nota: $error');
    }
  }

  void _cancel() {
    _ticker?.cancel();
    if (_recording) _recorder.stop().catchError((_) async => '');
    Navigator.pop(context);
  }

  Future<void> _send() async {
    final bytes = _bytes;
    if (bytes == null || bytes.isEmpty) return;
    await _player.stop();
    final filename = 'nota-${DateTime.now().millisecondsSinceEpoch}.$_extension';
    if (!mounted) return;
    Navigator.pop(context, RecordedVoice(bytes: bytes, filename: filename, seconds: _seconds));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final hasTake = _bytes != null && !_recording;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Nota de voz', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, color: p.ink)),
            const SizedBox(height: 6),
            Text(
              _recording ? 'Grabando…' : hasTake ? 'Listo para enviar' : 'Pulsa el micrófono para grabar',
              style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
            ),
            const SizedBox(height: 18),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton.filledTonal(
                  iconSize: 34,
                  tooltip: _recording ? 'Detener' : 'Grabar',
                  onPressed: _recording ? _stop : _start,
                  icon: Icon(_recording ? Icons.stop_rounded : Icons.mic_rounded),
                  style: IconButton.styleFrom(
                    backgroundColor: _recording ? p.danger.withValues(alpha: 0.15) : p.primarySoft,
                    foregroundColor: _recording ? p.danger : p.primary,
                    minimumSize: const Size(74, 74),
                  ),
                ),
                if (hasTake) ...[
                  const SizedBox(width: 14),
                  IconButton.filledTonal(
                    iconSize: 26,
                    tooltip: _playing ? 'Pausar' : 'Escuchar',
                    onPressed: _togglePlay,
                    icon: Icon(_playing ? Icons.pause_rounded : Icons.play_arrow_rounded),
                  ),
                  const SizedBox(width: 8),
                  Text(_durationLabel(_seconds), style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: p.ink)),
                ] else if (_recording) ...[
                  const SizedBox(width: 14),
                  Text(_durationLabel(_seconds), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: p.danger)),
                ],
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: p.danger)),
            ],
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _cancel,
                    child: const Text('Cancelar'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: hasTake && _seconds <= 0 ? null : (hasTake ? _send : null),
                    icon: const Icon(Icons.send_rounded, size: 18),
                    label: const Text('Enviar'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _durationLabel(int seconds) {
    final minutes = (seconds ~/ 60).toString().padLeft(2, '0');
    final rest = (seconds % 60).toString().padLeft(2, '0');
    return '$minutes:$rest';
  }
}
