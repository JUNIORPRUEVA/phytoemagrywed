import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart' as mk;

import '../../../core/files/file_opener.dart';
import '../../../core/net/api_client.dart';
import 'chat_desktop_theme.dart';

/// Reproduce una nota privada dentro del hilo. Los bytes ya llegaron por la
/// ruta autenticada; se guardan temporalmente solo al pulsar reproducir.
class ChatInlineAudio extends StatefulWidget {
  const ChatInlineAudio({super.key, required this.file, this.maxWidth = 250});

  final ApiFile file;
  final double maxWidth;

  @override
  State<ChatInlineAudio> createState() => _ChatInlineAudioState();
}

class _ChatInlineAudioState extends State<ChatInlineAudio> {
  static _ChatInlineAudioState? _active;

  final AudioPlayer _player = AudioPlayer();
  mk.Player? _windowsPlayer;
  final List<StreamSubscription<dynamic>> _windowsSubscriptions = [];
  StreamSubscription<PlayerState>? _stateSubscription;
  StreamSubscription<Duration>? _durationSubscription;
  StreamSubscription<Duration>? _positionSubscription;
  StreamSubscription<void>? _completeSubscription;
  String? _path;
  String? _error;
  Duration _duration = Duration.zero;
  Duration _position = Duration.zero;
  bool _busy = false;
  bool _playing = false;
  bool _paused = false;

  @override
  void initState() {
    super.initState();
    _stateSubscription = _player.onPlayerStateChanged.listen((state) {
      if (mounted) setState(() => _playing = state == PlayerState.playing);
    });
    _durationSubscription = _player.onDurationChanged.listen((value) {
      if (mounted) setState(() => _duration = value);
    });
    _positionSubscription = _player.onPositionChanged.listen((value) {
      if (mounted) setState(() => _position = value);
    });
    _completeSubscription = _player.onPlayerComplete.listen((_) {
      if (mounted)
        setState(() {
          _playing = false;
          _paused = false;
          _position = Duration.zero;
        });
      if (identical(_active, this)) _active = null;
    });
  }

  void _initializeWindowsPlayer() {
    if (_windowsPlayer != null) return;
    mk.MediaKit.ensureInitialized();
    final player = mk.Player();
    _windowsPlayer = player;
    _windowsSubscriptions.addAll([
      player.stream.playing.listen((value) {
        if (mounted) setState(() => _playing = value);
      }),
      player.stream.duration.listen((value) {
        if (mounted) setState(() => _duration = value);
      }),
      player.stream.position.listen((value) {
        if (mounted) setState(() => _position = value);
      }),
      player.stream.completed.listen((value) {
        if (!value) return;
        if (mounted)
          setState(() {
            _playing = false;
            _paused = false;
            _position = Duration.zero;
          });
        if (identical(_active, this)) _active = null;
      }),
      player.stream.error.listen((value) {
        if (mounted) {
          setState(() {
            _playing = false;
            _paused = false;
            _error = 'No se pudo reproducir esta nota aquí.';
          });
        }
      }),
    ]);
  }

  @override
  void dispose() {
    if (identical(_active, this)) _active = null;
    unawaited(_release());
    super.dispose();
  }

  Future<void> _release() async {
    await Future.wait([
      _stateSubscription?.cancel() ?? Future<void>.value(),
      _durationSubscription?.cancel() ?? Future<void>.value(),
      _positionSubscription?.cancel() ?? Future<void>.value(),
      _completeSubscription?.cancel() ?? Future<void>.value(),
      ..._windowsSubscriptions.map((subscription) => subscription.cancel()),
    ]);
    await _player.dispose();
    await _windowsPlayer?.dispose();
    final path = _path;
    if (path != null) {
      try {
        await File(path).delete();
      } catch (_) {
        // Windows puede retener el archivo unos instantes; purgeOld lo limpia.
      }
    }
  }

  Future<void> _toggle() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_playing) {
        if (Platform.isWindows) {
          await _windowsPlayer?.pause();
        } else {
          await _player.pause();
        }
        _paused = true;
      } else {
        if (_active != null && !identical(_active, this)) {
          await _active!._stopPlayback();
        }
        _active = this;
        if (_path == null) {
          final saved = await FileOpener.saveForPreview(widget.file);
          if (!mounted) {
            try {
              await File(saved).delete();
            } catch (_) {
              /* Se limpiará después. */
            }
            return;
          }
          _path = saved;
        }
        if (Platform.isWindows) {
          _initializeWindowsPlayer();
          if (_paused) {
            await _windowsPlayer!.play();
          } else {
            await _windowsPlayer!.open(mk.Media(Uri.file(_path!).toString()));
          }
        } else if (_paused) {
          await _player.resume();
        } else {
          await _player.setReleaseMode(ReleaseMode.stop);
          await _player.play(DeviceFileSource(_path!));
        }
        _paused = false;
      }
    } catch (_) {
      if (mounted)
        setState(() => _error = 'No se pudo reproducir esta nota aquí.');
      if (identical(_active, this)) _active = null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stopPlayback() async {
    if (Platform.isWindows) {
      await _windowsPlayer?.stop();
    } else {
      await _player.stop();
    }
    if (mounted)
      setState(() {
        _playing = false;
        _paused = false;
        _position = Duration.zero;
      });
  }

  Future<void> _seek(TapDownDetails details, double width) async {
    if (_duration <= Duration.zero || width <= 0) return;
    final ratio = (details.localPosition.dx / width).clamp(0.0, 1.0);
    final position = Duration(
      milliseconds: (_duration.inMilliseconds * ratio).round(),
    );
    try {
      if (Platform.isWindows) {
        await _windowsPlayer?.seek(position);
      } else {
        await _player.seek(position);
      }
      if (mounted) setState(() => _position = position);
    } catch (_) {
      // El audio sigue reproduciéndose aunque este formato no admita avance.
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final duration = _duration.inMilliseconds > 0 ? _duration : _position;
    final progress = duration.inMilliseconds > 0
        ? (_position.inMilliseconds / duration.inMilliseconds).clamp(0.0, 1.0)
        : 0.0;
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: widget.maxWidth),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: _playing ? 'Pausar audio' : 'Reproducir audio',
                onPressed: _busy || widget.file.bytes.isEmpty ? null : _toggle,
                icon: _busy
                    ? SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: c.accent,
                        ),
                      )
                    : Icon(
                        _playing
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded,
                        color: c.textPrimary,
                      ),
                iconSize: 24,
                constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                padding: EdgeInsets.zero,
              ),
              const SizedBox(width: 3),
              Expanded(
                child: LayoutBuilder(
                  builder: (context, limits) => GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTapDown: (details) => _seek(details, limits.maxWidth),
                    child: SizedBox(
                      height: 30,
                      child: CustomPaint(
                        painter: _AudioWavePainter(
                          played: progress,
                          color: c.textSecondary,
                          playedColor: c.accent,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _stamp(_playing ? _position : duration),
                style: TextStyle(
                  fontSize: 11.5,
                  color: c.textSecondary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          if (_error != null)
            TextButton.icon(
              onPressed: _busy ? null : _toggle,
              icon: const Icon(Icons.refresh_rounded, size: 15),
              label: Text('$_error Reintentar'),
              style: TextButton.styleFrom(
                foregroundColor: c.danger,
                padding: EdgeInsets.zero,
              ),
            ),
        ],
      ),
    );
  }

  String _stamp(Duration value) =>
      '${value.inMinutes.toString().padLeft(2, '0')}:${(value.inSeconds % 60).toString().padLeft(2, '0')}';
}

class _AudioWavePainter extends CustomPainter {
  const _AudioWavePainter({
    required this.played,
    required this.color,
    required this.playedColor,
  });

  final double played;
  final Color color;
  final Color playedColor;

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 34;
    final step = size.width / bars;
    for (var i = 0; i < bars; i++) {
      final height = 5 + ((i * 37) % 14).toDouble();
      final paint = Paint()
        ..color = i / bars <= played
            ? playedColor
            : color.withValues(alpha: 0.7)
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round;
      final x = step * i + step / 2;
      canvas.drawLine(
        Offset(x, (size.height - height) / 2),
        Offset(x, (size.height + height) / 2),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _AudioWavePainter old) =>
      old.played != played ||
      old.color != color ||
      old.playedColor != playedColor;
}
