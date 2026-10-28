import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/crm_scope.dart';
import '../../../core/files/file_opener.dart';
import '../../../core/format/crm_format.dart';
import '../../../core/net/api_client.dart';
import '../../../data/models/crm_models.dart';
import 'chat_desktop_theme.dart';

/// Separa días en el hilo con el rótulo centrado de la referencia.
class ChatDateDivider extends StatelessWidget {
  const ChatDateDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(child: Text(label, style: t.dateDivider)),
    );
  }
}

/// Burbuja del hilo. Entrante a la izquierda (gris antracita), saliente a la
/// derecha (verde oscuro), como en la captura.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message, required this.maxWidth});

  final ChatMessage message;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final outgoing = message.outgoing;
    final radius = ChatDesktopMetrics.bubbleRadius;
    final tail = ChatDesktopMetrics.bubbleRadiusTail;

    return Align(
      alignment: outgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        constraints: BoxConstraints(maxWidth: maxWidth),
        padding: const EdgeInsets.fromLTRB(9, 6, 9, 5),
        decoration: BoxDecoration(
          color: outgoing ? c.bubbleOut : c.bubbleIn,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(ChatDesktopMetrics.bubbleRadius),
            topRight: const Radius.circular(ChatDesktopMetrics.bubbleRadius),
            bottomLeft: Radius.circular(outgoing ? radius : tail),
            bottomRight: Radius.circular(outgoing ? tail : radius),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (outgoing && message.author.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(message.author, style: t.author),
              ),
            if (message.hasCoordinates)
              _LocationContent(message: message)
            else if (message.hasMedia)
              _MediaContent(message: message)
            else if (message.type != 'text' && message.type.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(_iconFor(message.type), size: 15, color: c.textSecondary),
                    const SizedBox(width: 6),
                    Text(_labelFor(message.type), style: t.bubbleMeta),
                  ],
                ),
              ),
            if (message.body.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Text(message.body, style: t.bubbleBody),
              ),
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text(CrmFormat.chatStamp(message.at), style: t.bubbleMeta),
                  if (outgoing) ...[
                    const SizedBox(width: 4),
                    Icon(
                      message.status == 'failed' ? Icons.error_outline_rounded : Icons.done_all_rounded,
                      size: 13,
                      color: message.status == 'failed' ? c.danger : c.textSecondary,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static IconData _iconFor(String type) => switch (type) {
        'image' => Icons.image_outlined,
        'audio' => Icons.mic_none_rounded,
        'video' => Icons.videocam_outlined,
        'document' => Icons.description_outlined,
        'location' => Icons.place_outlined,
        'sticker' => Icons.emoji_emotions_outlined,
        _ => Icons.chat_bubble_outline_rounded,
      };

  static String _labelFor(String type) => switch (type) {
        'image' => 'Foto',
        'audio' => 'Nota de voz',
        'video' => 'Vídeo',
        'document' => 'Documento',
        'location' => 'Ubicación',
        'sticker' => 'Sticker',
        _ => 'Mensaje',
      };
}

/// Mensaje que está en la cola offline: mismo estilo, con aviso real.
class QueuedMessageBubble extends StatelessWidget {
  const QueuedMessageBubble({super.key, required this.body, required this.maxWidth});

  final String body;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        constraints: BoxConstraints(maxWidth: maxWidth),
        padding: const EdgeInsets.fromLTRB(9, 6, 9, 6),
        decoration: BoxDecoration(
          color: c.bubbleOut,
          borderRadius: BorderRadius.circular(ChatDesktopMetrics.bubbleRadius),
          border: Border.all(color: c.warning.withValues(alpha: 0.55)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(body, style: t.bubbleBody),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.schedule_rounded, size: 12, color: c.warning),
                const SizedBox(width: 4),
                Text(
                  'Pendiente de enviar',
                  style: t.bubbleMeta.copyWith(color: c.warning),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Adjunto: la imagen se pinta dentro del hilo; el PDF y el audio se abren con
/// el visor del sistema. Los bytes se piden con sesión (no hay URL pública).
class _MediaContent extends StatefulWidget {
  const _MediaContent({required this.message});

  final ChatMessage message;

  @override
  State<_MediaContent> createState() => _MediaContentState();
}

class _MediaContentState extends State<_MediaContent> {
  Future<ApiFile>? _future;

  @override
  void initState() {
    super.initState();
    if (widget.message.mediaId.isNotEmpty) {
      _future = CrmScope.of(context, listen: false).repository.mediaBytes(widget.message.mediaId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    if (_future == null) {
      return Text('Adjunto no disponible', style: t.bubbleMeta);
    }
    return FutureBuilder<ApiFile>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return SizedBox(
            height: 90,
            width: 150,
            child: Center(
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
              ),
            ),
          );
        }
        if (snapshot.hasError || snapshot.data == null) {
          return Text(
            'No pudimos abrir el adjunto',
            style: t.bubbleMeta.copyWith(color: c.danger),
          );
        }
        final file = snapshot.data!;
        if (widget.message.type == 'image' || file.isImage) {
          return GestureDetector(
            onTap: () => FileOpener.saveAndOpen(file),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Image.memory(
                Uint8List.fromList(file.bytes),
                width: 300,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stack) => Text(
                  'Imagen no válida',
                  style: t.bubbleMeta.copyWith(color: c.danger),
                ),
              ),
            ),
          );
        }
        if (file.isPdf) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.description_outlined, size: 20, color: c.textSecondary),
              const SizedBox(width: 8),
              Text('Documento PDF', style: t.bubbleBody),
              const SizedBox(width: 10),
              TextButton(
                onPressed: () => FileOpener.saveAndOpen(file),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(0, 30),
                  foregroundColor: c.accent,
                ),
                child: const Text('Abrir', style: TextStyle(fontSize: 12.5)),
              ),
            ],
          );
        }
        return AudioMessageBubble(onOpen: () => FileOpener.saveAndOpen(file));
      },
    );
  }
}

/// Nota de voz: botón de reproducción real (abre el audio con el visor del
/// sistema) + onda estática derivada del id del mensaje.
///
/// No se dibuja una barra de progreso animada porque la app no reproduce audio
/// en línea: mostrar un progreso falso sería un indicador sin soporte real.
class AudioMessageBubble extends StatelessWidget {
  const AudioMessageBubble({super.key, required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: onOpen,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: 34,
            height: 34,
            child: Icon(Icons.play_arrow_rounded, size: 24, color: c.textPrimary),
          ),
        ),
        const SizedBox(width: 4),
        SizedBox(
          width: 168,
          height: 22,
          child: CustomPaint(painter: _WavePainter(c.textSecondary)),
        ),
        const SizedBox(width: 8),
        Text('Nota de voz', style: t.bubbleMeta),
      ],
    );
  }
}

class _WavePainter extends CustomPainter {
  const _WavePainter(this.waveColor);

  final Color waveColor;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = waveColor.withValues(alpha: 0.75)
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    const bars = 34;
    final step = size.width / bars;
    for (var i = 0; i < bars; i++) {
      // Amplitud determinista (no aleatoria) para que no "parpadee" al rebuild.
      final h = 4 + ((i * 37) % 14).toDouble();
      final x = step * i + step / 2;
      canvas.drawLine(Offset(x, (size.height - h) / 2), Offset(x, (size.height + h) / 2), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _WavePainter oldDelegate) => oldDelegate.waveColor != waveColor;
}

class _LocationContent extends StatelessWidget {
  const _LocationContent({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final lat = message.latitude!;
    final lng = message.longitude!;
    return InkWell(
      onTap: () => launchUrl(
        Uri.parse('https://maps.google.com/?q=$lat,$lng'),
        mode: LaunchMode.externalApplication,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.place_outlined, size: 18, color: c.accent),
          const SizedBox(width: 8),
          Text(
            '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}',
            style: t.bubbleBody.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(width: 6),
          Icon(Icons.open_in_new_rounded, size: 14, color: c.textSecondary),
        ],
      ),
    );
  }
}