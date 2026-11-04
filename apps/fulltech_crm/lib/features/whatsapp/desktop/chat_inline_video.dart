import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../../../core/files/file_opener.dart';
import '../../../core/net/api_client.dart';
import 'chat_desktop_theme.dart';

/// Video privado del hilo: primer fotograma, reproducción y pantalla completa.
class ChatInlineVideo extends StatefulWidget {
  const ChatInlineVideo({super.key, required this.file, this.maxWidth = 260});

  final ApiFile file;
  final double maxWidth;

  @override
  State<ChatInlineVideo> createState() => _ChatInlineVideoState();
}

class _ChatInlineVideoState extends State<ChatInlineVideo> {
  VideoPlayerController? _controller;
  String? _path;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      final path = await FileOpener.saveForPreview(widget.file);
      if (!mounted) return;
      final controller = VideoPlayerController.file(File(path));
      await controller.initialize();
      /*
       * CARÁTULA: se coloca el vídeo en el primer fotograma y se deja en pausa,
       * como hace WhatsApp. Sin este paso algunos archivos se quedaban en negro
       * hasta pulsar «play». Se avanza 30 ms (imperceptible) porque un salto al
       * segundo 0 exacto no siempre obliga al motor a pintar el fotograma.
       */
      await controller.seekTo(const Duration(milliseconds: 30));
      await controller.pause();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() {
        _path = path;
        _controller = controller;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _fullscreen() async {
    final path = _path;
    if (path == null) return;
    await _controller?.pause();
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierColor: Colors.black87,
      builder: (_) => _FullscreenVideo(path: path),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (_failed) {
      return TextButton.icon(
        onPressed: () => FileOpener.saveAndOpen(widget.file),
        icon: const Icon(Icons.open_in_new_rounded),
        label: const Text('Abrir video'),
      );
    }
    if (controller == null) {
      return SizedBox(
        width: widget.maxWidth,
        height: 145,
        child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return ValueListenableBuilder<VideoPlayerValue>(
      valueListenable: controller,
      builder: (context, value, _) {
        final c = ChatPalette.of(context);
        final ratio = value.aspectRatio > 0 ? value.aspectRatio : 16 / 9;
        return ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: widget.maxWidth,
            maxHeight: 230,
          ),
          child: AspectRatio(
            aspectRatio: ratio,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(
                    color: Colors.black,
                    child: VideoPlayer(controller),
                  ),
                  Center(
                    child: IconButton.filledTonal(
                      tooltip: value.isPlaying
                          ? 'Pausar video'
                          : 'Reproducir video',
                      onPressed: value.isPlaying
                          ? controller.pause
                          : controller.play,
                      icon: Icon(
                        value.isPlaying
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded,
                        size: 28,
                      ),
                      style: IconButton.styleFrom(
                        backgroundColor: c.accent,
                        foregroundColor: Colors.white,
                      ),
                    ),
                  ),
                  Positioned(
                    top: 4,
                    right: 4,
                    child: IconButton.filledTonal(
                      tooltip: 'Video a pantalla completa',
                      iconSize: 18,
                      visualDensity: VisualDensity.compact,
                      onPressed: _fullscreen,
                      icon: const Icon(Icons.fullscreen_rounded),
                      style: IconButton.styleFrom(
                        backgroundColor: c.accent.withValues(alpha: 0.85),
                        foregroundColor: Colors.white,
                      ),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: VideoProgressIndicator(
                      controller,
                      allowScrubbing: true,
                      colors: VideoProgressColors(
                        playedColor: c.accent,
                        bufferedColor: Colors.white.withValues(alpha: 0.45),
                        backgroundColor: Colors.white.withValues(alpha: 0.22),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _FullscreenVideo extends StatefulWidget {
  const _FullscreenVideo({required this.path});

  final String path;

  @override
  State<_FullscreenVideo> createState() => _FullscreenVideoState();
}

class _FullscreenVideoState extends State<_FullscreenVideo> {
  VideoPlayerController? _controller;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      final controller = VideoPlayerController.file(File(widget.path));
      await controller.initialize();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() => _controller = controller);
      await controller.play();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Dialog.fullscreen(
      backgroundColor: Colors.black,
      child: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              child: Center(
                child: _failed
                    ? const Text(
                        'No se pudo reproducir este video',
                        style: TextStyle(color: Colors.white),
                      )
                    : controller == null
                    ? const CircularProgressIndicator()
                    : ValueListenableBuilder<VideoPlayerValue>(
                        valueListenable: controller,
                        builder: (context, value, _) => AspectRatio(
                          aspectRatio: value.aspectRatio > 0
                              ? value.aspectRatio
                              : 16 / 9,
                          child: VideoPlayer(controller),
                        ),
                      ),
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton.filledTonal(
                tooltip: 'Cerrar pantalla completa',
                onPressed: () => Navigator.pop(context),
                icon: const Icon(Icons.close_rounded),
                // Sin color heredado del tema: sobre negro se usa blanco.
                style: IconButton.styleFrom(
                  backgroundColor: Colors.white.withValues(alpha: 0.18),
                  foregroundColor: Colors.white,
                ),
              ),
            ),
            if (controller != null)
              Positioned(
                left: 20,
                right: 20,
                bottom: 16,
                child: ValueListenableBuilder<VideoPlayerValue>(
                  valueListenable: controller,
                  builder: (context, value, _) => Row(
                    children: [
                      IconButton(
                        tooltip: value.isPlaying ? 'Pausar' : 'Reproducir',
                        color: Colors.white,
                        onPressed: value.isPlaying
                            ? controller.pause
                            : controller.play,
                        icon: Icon(
                          value.isPlaying
                              ? Icons.pause_rounded
                              : Icons.play_arrow_rounded,
                        ),
                      ),
                      Expanded(
                        child: VideoProgressIndicator(
                          controller,
                          allowScrubbing: true,
                          colors: const VideoProgressColors(
                            playedColor: Colors.white,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _stamp(value.position),
                        style: const TextStyle(color: Colors.white),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _stamp(Duration duration) =>
      '${duration.inMinutes.toString().padLeft(2, '0')}:${(duration.inSeconds % 60).toString().padLeft(2, '0')}';
}
