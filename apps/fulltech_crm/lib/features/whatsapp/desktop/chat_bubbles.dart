import 'dart:convert';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/crm_scope.dart';
import '../../../core/files/file_opener.dart';
import '../../../core/format/crm_format.dart';
import '../../../core/net/api_client.dart';
import '../../../data/models/crm_models.dart';
import 'chat_desktop_theme.dart';
import 'chat_inline_audio.dart';
import 'chat_inline_video.dart';

/// Separa días en el hilo con la píldora centrada de WhatsApp.
class ChatDateDivider extends StatelessWidget {
  const ChatDateDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: c.fieldBg,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: c.divider.withValues(alpha: 0.55)),
          ),
          child: Text(label, style: t.dateDivider),
        ),
      ),
    );
  }
}

/// Burbuja del hilo. Entrante a la izquierda (gris antracita), saliente a la
/// derecha (verde oscuro), como en la captura.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.maxWidth,
    this.phone = '',
  });

  final ChatMessage message;
  final double maxWidth;

  /// Teléfono del cliente del hilo (por defecto, el destinatario al compartir).
  final String phone;

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
        margin: const EdgeInsets.only(bottom: 3),
        constraints: BoxConstraints(maxWidth: maxWidth),
        padding: const EdgeInsets.fromLTRB(7, 4, 7, 3),
        decoration: BoxDecoration(
          color: outgoing ? c.bubbleOut : c.bubbleIn,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(ChatDesktopMetrics.bubbleRadius),
            topRight: const Radius.circular(ChatDesktopMetrics.bubbleRadius),
            bottomLeft: Radius.circular(outgoing ? radius : tail),
            bottomRight: Radius.circular(outgoing ? tail : radius),
          ),
          // Borde fino y sombra sutil: la tarjeta se recorta del lienzo.
          border: Border.all(color: c.divider.withValues(alpha: 0.55)),
          boxShadow: [
            BoxShadow(
              color: const Color(0x14000000),
              blurRadius: 2,
              offset: const Offset(0, 1),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (outgoing && message.author.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(message.author, style: t.author),
              ),
            if (message.hasCoordinates)
              _LocationContent(message: message, phone: phone)
            else if (message.hasMedia)
              _MediaContent(message: message)
            else if (message.type != 'text' &&
                message.type.isNotEmpty &&
                message.body.isEmpty)
              // Sin adjunto ni texto: solo el icono. Nada de rótulos («Foto»,
              // «Vídeo»…) debajo del contenido.
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Icon(
                  _iconFor(message.type),
                  size: 16,
                  color: c.textSecondary,
                ),
              ),
            if (message.body.isNotEmpty &&
                !message.hasCoordinates &&
                _conTextoPropio(message))
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: _MessageBody(
                  text: message.body,
                  style: t.bubbleBody,
                  linkStyle: t.bubbleBody.copyWith(
                    color: c.link,
                    decoration: TextDecoration.underline,
                    decorationColor: c.link.withValues(alpha: 0.5),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text(CrmFormat.chatStamp(message.at), style: t.bubbleMeta),
                  if (outgoing) ...[
                    const SizedBox(width: 4),
                    Icon(
                      message.status == 'failed'
                          ? Icons.error_outline_rounded
                          : Icons.done_all_rounded,
                      size: 13,
                      color: message.status == 'failed'
                          ? c.danger
                          : c.textSecondary,
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
    'voice' => Icons.mic_none_rounded,
    'video' => Icons.videocam_outlined,
    'document' => Icons.description_outlined,
    'location' => Icons.place_outlined,
    'sticker' => Icons.emoji_emotions_outlined,
    _ => Icons.chat_bubble_outline_rounded,
  };

  /// ¿El texto aporta algo o solo describe el adjunto?
  ///
  /// En imágenes y vídeos el servidor manda cosas como «El cliente envió una
  /// imagen» o el nombre del archivo: como el contenido ya se ve, ese rótulo
  /// sobra y solo hacía la burbuja más alta.
  static bool _conTextoPropio(ChatMessage message) {
    final body = message.body.trim();
    if (body.isEmpty) return false;
    /*
     * WhatsApp manda etiquetas entre corchetes cuando el archivo no lleva pie
     * de foto: «[video]», «[imagen]», «[sticker]»… El contenido ya se ve, así
     * que esa etiqueta no se escribe debajo (era lo que salía como «[video]»).
     */
    if (RegExp(r'^\[[^\]]{0,40}\]$').hasMatch(body)) return false;
    if (!message.hasMedia) return true;
    final low = body.toLowerCase();
    // Audio, documentos y stickers no llevan rótulo: ya se ven.
    if (message.type == 'audio' ||
        message.type == 'voice' ||
        message.type == 'document' ||
        message.type == 'sticker') {
      return body.length > 60;
    }
    if (RegExp(
      r'\.(png|jpe?g|gif|webp|heic|bmp|pdf|mp4|mov|webm|m4a|ogg|opus|docx?|xlsx?|csv)$',
    ).hasMatch(low)) {
      return false;
    }
    return !RegExp(
      r'^(el cliente |se |te )?(envi[oó]|enviado|enviaste|adjunt\w*|comparti\w*)[^.]{0,60}'
      r'(imagen|foto|v[ií]deo|archivo|documento|audio|nota de voz|sticker)',
    ).hasMatch(low);
  }
}

/// Texto del mensaje con los enlaces detectados, resaltados y clicables.
///
/// Los reconocedores se crean una sola vez (al cambiar el texto o el estilo) y
/// se liberan al reconstruir o al desmontar: crearlos dentro de `build` deja
/// gestos vivos sobre widgets que ya no existen.
class _MessageBody extends StatefulWidget {
  const _MessageBody({
    required this.text,
    required this.style,
    required this.linkStyle,
  });

  final String text;
  final TextStyle style;
  final TextStyle linkStyle;

  @override
  State<_MessageBody> createState() => _MessageBodyState();
}

class _MessageBodyState extends State<_MessageBody> {
  static final RegExp _url = RegExp(
    r'(https?://[^\s<>\"]+|www\.[^\s<>\"]+)',
    caseSensitive: false,
  );

  final List<TapGestureRecognizer> _recognizers = [];
  List<InlineSpan> _spans = const [];

  @override
  void initState() {
    super.initState();
    _rebuild();
  }

  @override
  void didUpdateWidget(covariant _MessageBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text ||
        oldWidget.style != widget.style ||
        oldWidget.linkStyle != widget.linkStyle) {
      _rebuild();
    }
  }

  void _rebuild() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();

    final spans = <InlineSpan>[];
    var index = 0;
    for (final match in _url.allMatches(widget.text)) {
      if (match.start > index) {
        spans.add(TextSpan(text: widget.text.substring(index, match.start)));
      }
      final raw = match.group(0)!;
      final target = raw.toLowerCase().startsWith('www.')
          ? 'https://$raw'
          : raw;
      final recognizer = TapGestureRecognizer()..onTap = () => _open(target);
      _recognizers.add(recognizer);
      spans.add(
        TextSpan(text: raw, style: widget.linkStyle, recognizer: recognizer),
      );
      index = match.end;
    }
    if (index < widget.text.length) {
      spans.add(TextSpan(text: widget.text.substring(index)));
    }
    _spans = spans;
  }

  void _open(String target) {
    final uri = Uri.tryParse(target);
    if (uri != null) launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  void dispose() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Text.rich(TextSpan(style: widget.style, children: _spans));
}

/// Mensaje que está en la cola offline: mismo estilo, con aviso real.
class QueuedMessageBubble extends StatelessWidget {
  const QueuedMessageBubble({
    super.key,
    required this.body,
    required this.maxWidth,
  });

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

/// Adjunto privado: imagen, video y audio se presentan dentro del hilo.
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
      _future = CrmScope.of(
        context,
        listen: false,
      ).repository.mediaBytes(widget.message.mediaId);
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
            height: 72,
            width: 110,
            child: Center(
              child: SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: c.accent,
                ),
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
              borderRadius: BorderRadius.circular(5),
              // Ancho máximo 260 px y proporción ORIGINAL: antes la foto se
              // estiraba a 300 px con `cover` y recortaba los bordes.
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: ChatDesktopMetrics.mediaMaxWidth,
                  maxHeight: ChatDesktopMetrics.mediaMaxHeight,
                ),
                child: Image.memory(
                  Uint8List.fromList(file.bytes),
                  fit: BoxFit.contain,
                  alignment: Alignment.topCenter,
                  errorBuilder: (context, error, stack) => Text(
                    'Imagen no válida',
                    style: t.bubbleMeta.copyWith(color: c.danger),
                  ),
                ),
              ),
            ),
          );
        }
        if (file.isPdf) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.description_outlined,
                size: 17,
                color: c.textSecondary,
              ),
              const SizedBox(width: 6),
              TextButton(
                onPressed: () => FileOpener.saveAndOpen(file),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  minimumSize: const Size(0, 24),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  foregroundColor: c.link,
                ),
                child: const Text('Abrir', style: TextStyle(fontSize: 12)),
              ),
            ],
          );
        }
        if (widget.message.type == 'video' ||
            file.contentType.startsWith('video/')) {
          return ChatInlineVideo(file: file);
        }
        if (widget.message.type == 'audio' ||
            widget.message.type == 'voice' ||
            file.contentType.startsWith('audio/')) {
          return ChatInlineAudio(file: file);
        }
        return TextButton.icon(
          onPressed: () => FileOpener.saveAndOpen(file),
          icon: const Icon(Icons.attach_file_rounded, size: 16),
          label: Text(file.fileName, overflow: TextOverflow.ellipsis),
        );
      },
    );
  }
}

class _LocationContent extends StatefulWidget {
  const _LocationContent({required this.message, this.phone = ''});

  final ChatMessage message;

  /// Teléfono del cliente: se propone como destinatario al compartir.
  final String phone;

  @override
  State<_LocationContent> createState() => _LocationContentState();
}

class _LocationContentState extends State<_LocationContent> {
  /// Geocodificación inversa ya resuelta (`lat,lng` → «sector · vía»).
  /// Vive en memoria: abrir dos veces la misma conversación no vuelve a pedirla.
  static final Map<String, String> _sectors = {};

  String? _sector;

  double get _lat => widget.message.latitude!;
  double get _lng => widget.message.longitude!;

  /// Dirección que manda WhatsApp junto a las coordenadas (si la manda).
  String get _address {
    final raw = widget.message.body.trim();
    // WhatsApp añade etiquetas como «[ubicación]»: no aportan nada al usuario.
    final clean = raw
        .replaceAll(RegExp(r'\[[^\]]*\]'), '')
        .replaceAll(
          RegExp(
            r'https?://(?:www\.)?maps\.google\.com/\?q=[^\s]+',
            caseSensitive: false,
          ),
          '',
        )
        .replaceFirst(RegExp(r'^📍\s*'), '')
        .trim();
    if (clean.isEmpty) return '';
    if (RegExp(
      r'^(ubicaci[oó]n|location)$',
      caseSensitive: false,
    ).hasMatch(clean))
      return '';
    return clean.length > 120 ? '${clean.substring(0, 117)}…' : clean;
  }

  String get _coords =>
      '${_lat.toStringAsFixed(5)}, ${_lng.toStringAsFixed(5)}';

  /// Texto para compartir: sector/dirección + enlace al mapa.
  String get _shareText {
    final where = (_sector?.isNotEmpty ?? false) ? _sector! : _address;
    final link = 'https://maps.google.com/?q=$_lat,$_lng';
    return where.isEmpty ? '📍 $link' : '📍 $where\n$link';
  }

  @override
  void initState() {
    super.initState();
    _resolveSector();
  }

  Future<void> _resolveSector() async {
    final key = '${_lat.toStringAsFixed(4)},${_lng.toStringAsFixed(4)}';
    final cached = _sectors[key];
    if (cached != null) {
      _sector = cached;
      return;
    }
    final text = await _reverseGeocode(_lat, _lng);
    if (!mounted || text.isEmpty) return;
    _sectors[key] = text;
    setState(() => _sector = text);
  }

  /// Sector del punto con Nominatim (OpenStreetMap): suburbio, barrio, pueblo,
  /// ciudad y, si existe, la vía. Es el dato «automático» que pedía el equipo
  /// cuando el mensaje llega solo con coordenadas.
  static Future<String> _reverseGeocode(double lat, double lng) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
    try {
      final uri = Uri.parse(
        'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16'
        '&accept-language=es&lat=$lat&lon=$lng',
      );
      final request = await client.getUrl(uri);
      request.headers.set(
        HttpHeaders.userAgentHeader,
        'FullTECH-CRM/1.0 (soporte@fulltech.do)',
      );
      final response = await request.close();
      if (response.statusCode != 200) return '';
      final raw = await response.transform(utf8.decoder).join();
      final json = jsonDecode(raw);
      if (json is! Map) return '';
      final address = json['address'];
      if (address is! Map) return '';
      String clean(Object? value) => value is String ? value.trim() : '';
      final sector = [
        clean(address['suburb']),
        clean(address['neighbourhood']),
        clean(address['quarter']),
        clean(address['village']),
        clean(address['town']),
        clean(address['city']),
        clean(address['county']),
      ].firstWhere((value) => value.isNotEmpty, orElse: () => '');
      if (sector.isEmpty) return '';
      final road = [
        clean(address['road']),
        clean(address['house_number']),
      ].where((value) => value.isNotEmpty).join(' ');
      return road.isEmpty ? sector : '$sector · $road';
    } catch (_) {
      return '';
    } finally {
      client.close(force: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final sector = _sector ?? '';
    final address = _address;
    final main = sector.isNotEmpty
        ? sector
        : (address.isNotEmpty ? address : _coords);
    return SizedBox(
      // La tarjeta se ajusta al mapa: sin ancho de sobra.
      width: ChatMapPreview.defaultWidth,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            // Abre el mapa DENTRO de la app (no sale a Google Maps).
            onTap: () => _openBigMap(context),
            child: Stack(
              children: [
                ChatMapPreview(lat: _lat, lng: _lng),
                // Botón de opciones en la esquina superior.
                Positioned(
                  right: 4,
                  top: 4,
                  child: _MapMenuButton(onPressed: () => _openMapMenu(context)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 5),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.place_rounded, size: 13, color: c.accent),
              const SizedBox(width: 4),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      main,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: t.bubbleMeta.copyWith(
                        color: c.textPrimary,
                        fontSize: 11.6,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (sector.isNotEmpty &&
                        address.isNotEmpty &&
                        address != sector)
                      Padding(
                        padding: const EdgeInsets.only(top: 1),
                        child: Text(
                          address,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: t.bubbleMeta.copyWith(fontSize: 10.4),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 4),
              Icon(Icons.open_in_new_rounded, size: 12, color: c.textSecondary),
            ],
          ),
        ],
      ),
    );
  }

  /// Abre el mapa en GRANDE dentro de la app (no sale a Google Maps).
  Future<void> _openBigMap(BuildContext context) async {
    final c = ChatPalette.of(context);
    final screen = MediaQuery.sizeOf(context);
    final address = _sector?.isNotEmpty == true ? _sector! : _address;
    await showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Mapa de la ubicación',
      barrierColor: const Color(0xAA000000),
      transitionDuration: const Duration(milliseconds: 160),
      pageBuilder: (dialogContext, _, _) => Center(
        child: Material(
          color: c.panelBg,
          borderRadius: BorderRadius.circular(14),
          clipBehavior: Clip.antiAlias,
          child: SizedBox(
            width: (screen.width * 0.68).clamp(420.0, 900.0),
            height: (screen.height * 0.72).clamp(320.0, 720.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 6, 8),
                  child: Row(
                    children: [
                      Icon(Icons.place_rounded, size: 16, color: c.accent),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          address.isEmpty ? _coords : address,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: c.text.headerName,
                        ),
                      ),
                      IconButton(
                        tooltip: 'Cerrar',
                        iconSize: 18,
                        onPressed: () => Navigator.pop(dialogContext),
                        icon: Icon(Icons.close_rounded, color: c.textSecondary),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, box) => ChatMapPreview(
                      lat: _lat,
                      lng: _lng,
                      width: box.maxWidth,
                      height: box.maxHeight,
                      zoom: 17,
                      interactive: true,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.fromLTRB(14, 6, 10, 8),
                  child: Row(
                    children: [
                      Expanded(child: Text(_coords, style: c.text.bubbleMeta)),
                      TextButton.icon(
                        onPressed: () => _open(
                          dialogContext,
                          'https://maps.google.com/?q=$_lat,$_lng',
                        ),
                        icon: Icon(
                          Icons.open_in_new_rounded,
                          size: 15,
                          color: c.link,
                        ),
                        label: Text(
                          'Google Maps',
                          style: c.text.bubbleMeta.copyWith(color: c.link),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Columna lateral con las opciones del mapa (como un cajón, a la derecha).
  void _openMapMenu(BuildContext context) {
    final c = ChatPalette.of(context);
    final address = _sector ?? _address;
    showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Opciones de la ubicación',
      barrierColor: const Color(0x55000000),
      transitionDuration: const Duration(milliseconds: 180),
      pageBuilder: (dialogContext, _, _) => Align(
        alignment: Alignment.centerRight,
        child: Material(
          color: c.panelBg,
          child: SizedBox(
            width: 300,
            height: double.infinity,
            child: SafeArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 14, 8, 10),
                    child: Row(
                      children: [
                        Icon(Icons.place_rounded, size: 16, color: c.accent),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text('Ubicación', style: c.text.headerName),
                        ),
                        IconButton(
                          tooltip: 'Cerrar',
                          iconSize: 18,
                          onPressed: () => Navigator.pop(dialogContext),
                          icon: Icon(
                            Icons.close_rounded,
                            color: c.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (address.isNotEmpty)
                          Text(
                            address,
                            style: c.text.bubbleMeta.copyWith(
                              color: c.textPrimary,
                              fontSize: 11.8,
                            ),
                          ),
                        const SizedBox(height: 2),
                        Text(_coords, style: c.text.bubbleMeta),
                        const SizedBox(height: 10),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: ChatMapPreview(
                            lat: _lat,
                            lng: _lng,
                            width: 272,
                            height: 150,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  Divider(height: 1, color: c.divider),
                  _MapOption(
                    icon: Icons.map_outlined,
                    label: 'Abrir en Google Maps',
                    onTap: () => _open(
                      dialogContext,
                      'https://maps.google.com/?q=$_lat,$_lng',
                    ),
                  ),
                  _MapOption(
                    icon: Icons.directions_rounded,
                    label: 'Cómo llegar',
                    onTap: () => _open(
                      dialogContext,
                      'https://www.google.com/maps/dir/?api=1&destination=$_lat,$_lng',
                    ),
                  ),
                  _MapOption(
                    icon: Icons.public_rounded,
                    label: 'Abrir en OpenStreetMap',
                    onTap: () => _open(
                      dialogContext,
                      'https://www.openstreetmap.org/?mlat=$_lat&mlon=$_lng#map=17/$_lat/$_lng',
                    ),
                  ),
                  _MapOption(
                    icon: Icons.send_rounded,
                    label: 'Enviar ubicación por WhatsApp',
                    onTap: () => _sendByApi(dialogContext),
                  ),
                  _MapOption(
                    icon: Icons.link_rounded,
                    label: 'Copiar enlace del mapa',
                    onTap: () => _copy(
                      dialogContext,
                      'https://maps.google.com/?q=$_lat,$_lng',
                    ),
                  ),
                  _MapOption(
                    icon: Icons.copy_rounded,
                    label: 'Copiar coordenadas',
                    onTap: () => _copy(dialogContext, _coords),
                  ),
                  if (address.isNotEmpty)
                    _MapOption(
                      icon: Icons.content_copy_rounded,
                      label: 'Copiar dirección',
                      onTap: () => _copy(dialogContext, address),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
      transitionBuilder: (context, animation, _, child) => SlideTransition(
        position: Tween(begin: const Offset(1, 0), end: Offset.zero).animate(
          CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
        ),
        child: child,
      ),
    );
  }

  /// Comparte la ubicación por WhatsApp como **ubicación nativa** (el cliente la
  /// ve en el mapa del chat) usando el endpoint del panel
  /// `POST /api/admin/locations/{id}/share`.
  ///
  /// Si la ventana de 24 h está cerrada, WhatsApp no admite ubicaciones: el
  /// servidor responde `canUseTemplate` y aquí se ofrece mandarla con la
  /// plantilla aprobada (con el enlace dentro).
  Future<void> _sendByApi(BuildContext context) async {
    final c = ChatPalette.of(context);
    final repo = CrmScope.of(context, listen: false).repository;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final phone = TextEditingController(text: widget.phone);
    final busqueda = TextEditingController();

    final numero = await showGeneralDialog<String>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Compartir ubicación',
      barrierColor: const Color(0x55000000),
      transitionDuration: const Duration(milliseconds: 180),
      pageBuilder: (panelContext, _, _) {
        final width = (MediaQuery.sizeOf(panelContext).width * 0.20).clamp(
          320.0,
          440.0,
        );
        return Align(
          alignment: Alignment.centerLeft,
          child: StatefulBuilder(
            builder: (panelContext, setPanelState) {
              final query = busqueda.text.trim().toLowerCase();
              final clientes = CrmScope.of(panelContext).customers
                  .where(
                    (row) =>
                        query.isEmpty ||
                        row.name.toLowerCase().contains(query) ||
                        row.phone.toLowerCase().contains(query),
                  )
                  .take(40)
                  .toList();
              return Material(
                color: c.panelBg,
                child: SizedBox(
                  width: width,
                  height: MediaQuery.sizeOf(panelContext).height,
                  child: SafeArea(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 14, 8, 8),
                          child: Row(
                            children: [
                              Icon(
                                Icons.send_rounded,
                                size: 16,
                                color: c.accent,
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  'Compartir ubicación',
                                  style: c.text.headerName,
                                ),
                              ),
                              IconButton(
                                tooltip: 'Cerrar',
                                iconSize: 18,
                                onPressed: () => Navigator.pop(panelContext),
                                icon: Icon(
                                  Icons.close_rounded,
                                  color: c.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: ChatMapPreview(
                                  lat: _lat,
                                  lng: _lng,
                                  width: width - 28,
                                  height: 120,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                _sector?.isNotEmpty == true
                                    ? _sector!
                                    : _address,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: c.text.bubbleMeta.copyWith(
                                  color: c.textPrimary,
                                  fontSize: 11.8,
                                ),
                              ),
                              const SizedBox(height: 10),
                              TextField(
                                controller: phone,
                                autofocus: true,
                                keyboardType: TextInputType.phone,
                                decoration: const InputDecoration(
                                  labelText: 'Número del cliente',
                                  hintText: '+18095551234',
                                  isDense: true,
                                ),
                              ),
                              const SizedBox(height: 10),
                              Text(
                                'O elige un cliente del CRM',
                                style: c.text.bubbleMeta.copyWith(
                                  color: c.textSecondary,
                                ),
                              ),
                              const SizedBox(height: 4),
                              TextField(
                                controller: busqueda,
                                onChanged: (_) => setPanelState(() {}),
                                decoration: const InputDecoration(
                                  hintText: 'Buscar por nombre o teléfono',
                                  isDense: true,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 6),
                        Expanded(
                          child: clientes.isEmpty
                              ? Padding(
                                  padding: const EdgeInsets.all(14),
                                  child: Text(
                                    'Sin coincidencias',
                                    style: c.text.bubbleMeta,
                                  ),
                                )
                              : ListView(
                                  children: [
                                    for (final row in clientes)
                                      ListTile(
                                        dense: true,
                                        visualDensity: VisualDensity.compact,
                                        leading: Icon(
                                          Icons.person_outline_rounded,
                                          size: 18,
                                          color: c.textSecondary,
                                        ),
                                        title: Text(
                                          row.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: c.text.rowName.copyWith(
                                            color: c.textPrimary,
                                          ),
                                        ),
                                        subtitle: Text(
                                          row.phone,
                                          style: c.text.bubbleMeta,
                                        ),
                                        onTap: () => setPanelState(
                                          () => phone.text = row.phone,
                                        ),
                                      ),
                                  ],
                                ),
                        ),
                        Divider(height: 1, color: c.divider),
                        Padding(
                          padding: const EdgeInsets.all(10),
                          child: Row(
                            children: [
                              Expanded(
                                child: TextButton(
                                  onPressed: () => Navigator.pop(panelContext),
                                  child: const Text('Cancelar'),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: FilledButton(
                                  onPressed: () => Navigator.pop(
                                    panelContext,
                                    phone.text.trim(),
                                  ),
                                  child: const Text('Enviar'),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        );
      },
      transitionBuilder: (context, animation, _, child) => SlideTransition(
        position: Tween(begin: const Offset(-1, 0), end: Offset.zero).animate(
          CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
        ),
        child: child,
      ),
    );
    phone.dispose();
    busqueda.dispose();
    if (numero == null || numero.isEmpty || !context.mounted) return;

    // La ubicación tiene que ser una GUARDADA en el CRM (el servidor pide su id
    // para dejar auditoría de origen y destino). Se busca por coordenadas.
    String locationId = '';
    try {
      final rows = await repo.locations();
      for (final row in rows) {
        final lat = double.tryParse('${row['latitude']}');
        final lng = double.tryParse('${row['longitude']}');
        if (lat == null || lng == null) continue;
        if ((lat - _lat).abs() < 0.0003 && (lng - _lng).abs() < 0.0003) {
          locationId = '${row['id'] ?? ''}';
          break;
        }
      }
    } on ApiException {
      locationId = '';
    }
    if (!context.mounted) return;

    try {
      if (locationId.isEmpty) {
        // Sin ubicación registrada no hay mapa nativo posible: se manda el
        // enlace, que es lo único que el servidor puede transportar.
        final data = await repo.startConversation(phone: numero);
        final conversation = data['conversation'];
        final id = conversation is Map
            ? (conversation['id']?.toString() ?? '')
            : '';
        if (id.isEmpty) {
          messenger?.showSnackBar(
            const SnackBar(
              content: Text('No pudimos abrir la conversación de ese número.'),
            ),
          );
          return;
        }
        await repo.sendMessage(id, _shareText);
      } else {
        try {
          await repo.shareLocation(locationId: locationId, phone: numero);
        } on ApiException catch (error) {
          final puedePlantilla =
              error.payload['canUseTemplate'] == true ||
              error.code == 'outside_window';
          if (!puedePlantilla) rethrow;
          if (!context.mounted) return;
          final usarPlantilla = await _confirmarPlantilla(context);
          if (usarPlantilla != true) return;
          await repo.shareLocation(
            locationId: locationId,
            phone: numero,
            mode: 'template',
          );
        }
      }
      if (!context.mounted) return;
      Navigator.pop(context); // cierra el cajón
      messenger?.showSnackBar(
        SnackBar(content: Text('Ubicación enviada a $numero')),
      );
    } on ApiException catch (error) {
      messenger?.showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  /// Aviso de que la ventana de 24 h está cerrada y hay que usar plantilla.
  Future<bool?> _confirmarPlantilla(BuildContext context) => showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Ventana de 24 h cerrada'),
      content: const Text(
        'WhatsApp ya no permite enviar una ubicación a este número porque han pasado más de '
        '24 h desde su último mensaje. ¿La enviamos con la plantilla aprobada, que lleva el '
        'enlace del mapa dentro?',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialogContext, true),
          child: const Text('Enviar por plantilla'),
        ),
      ],
    ),
  );

  Future<void> _open(BuildContext context, String url) async {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (context.mounted) Navigator.pop(context);
  }

  Future<void> _copy(BuildContext context, String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (context.mounted) Navigator.pop(context);
  }
}

/// Botón «⋮» que abre las opciones del mapa.
class _MapMenuButton extends StatelessWidget {
  const _MapMenuButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Tooltip(
      message: 'Opciones de la ubicación',
      child: InkWell(
        onTap: onPressed,
        customBorder: const CircleBorder(),
        child: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: c.panelBg.withValues(alpha: 0.94),
            border: Border.all(color: c.divider),
            boxShadow: const [
              BoxShadow(
                color: Color(0x33000000),
                blurRadius: 6,
                offset: Offset(0, 2),
              ),
            ],
          ),
          child: Icon(Icons.more_vert_rounded, size: 19, color: c.textPrimary),
        ),
      ),
    );
  }
}

/// Fila de opción del cajón del mapa.
class _MapOption extends StatelessWidget {
  const _MapOption({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          children: [
            Icon(icon, size: 17, color: c.textSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                label,
                style: c.text.rowPreview.copyWith(
                  color: c.textPrimary,
                  fontSize: 12.4,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Vista previa del mapa (mosaico de teselas de OpenStreetMap).
///
/// Se centra en las coordenadas y se recorta a 220×118 con el alfiler en el
/// centro: es la misma idea que la PWA, pero dibujada dentro de la burbuja (no
/// se abre nada externo hasta que la persona toca el mapa).
class ChatMapPreview extends StatelessWidget {
  const ChatMapPreview({
    super.key,
    required this.lat,
    required this.lng,
    this.width = defaultWidth,
    this.height = defaultHeight,
    this.zoom = 17,
    this.interactive = false,
  });

  final double lat;
  final double lng;
  final double width;
  final double height;

  /// Nivel de detalle: 17 muestra la calle exacta del punto.
  final int zoom;

  /// Mapa real con arrastre y zoom (en el visor grande). En la miniatura no,
  /// para no robar los gestos del hilo.
  final bool interactive;

  static const double defaultWidth = 260;
  static const double defaultHeight = 150;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final point = LatLng(lat, lng);
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: width,
        height: height,
        child: FlutterMap(
          options: MapOptions(
            initialCenter: point,
            initialZoom: zoom.toDouble(),
            backgroundColor: c.fieldBg,
            interactionOptions: InteractionOptions(
              flags: interactive ? InteractiveFlag.all : InteractiveFlag.none,
            ),
          ),
          children: [
            TileLayer(
              // Mapa real (OpenStreetMap), con la app identificada como exige
              // su política de uso.
              urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              userAgentPackageName: 'do.fulltech.crm',
            ),
            MarkerLayer(
              markers: [
                Marker(
                  point: point,
                  width: 36,
                  height: 36,
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.location_pin,
                    size: 34,
                    color: c.accent,
                    shadows: const [
                      Shadow(color: Color(0x66000000), blurRadius: 5),
                    ],
                  ),
                ),
              ],
            ),
            RichAttributionWidget(
              alignment: AttributionAlignment.bottomLeft,
              attributions: [TextSourceAttribution('© OpenStreetMap')],
            ),
          ],
        ),
      ),
    );
  }
}
