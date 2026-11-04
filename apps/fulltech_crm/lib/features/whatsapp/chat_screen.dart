import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show kDebugMode, debugPrint;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/config/app_config.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/text/local_corrector.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../ventas/pos_launch_context.dart';
import '../ventas/pos_screen.dart';
import 'desktop/chat_composer.dart';
import 'desktop/chat_desktop_theme.dart';
import 'desktop/chat_assistant_sheet.dart';
import 'desktop/chat_options_panel.dart';
import 'desktop/chat_header.dart';
import 'desktop/chat_thread.dart';
import 'desktop/chat_bubbles.dart' show ChatMapPreview;
import 'desktop/chat_media_reconcile_dialog.dart';
import 'desktop/chat_correction_sheet.dart';
import 'desktop/chat_live_suggestion.dart';
import 'desktop/chat_inline_video.dart';
import 'desktop/chat_inline_audio.dart';
import 'desktop/chat_quick_panel.dart';
import 'desktop/chat_ai_panel.dart';
import 'desktop/chat_ai_draft.dart';
import 'desktop/chat_customer_panels.dart';
import 'media_picker.dart';
import 'voice_recorder.dart';

/// Hilo de WhatsApp con todo lo que permite el CRM: texto, fotos, PDF, notas de
/// voz, ubicaciones, plantillas, asignación a un compañero y cierre.
class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.conversationId,
    required this.title,
    this.embedded = false,
    this.desktop = false,
    this.onNewMessage,
    this.autoAttach,
    this.onNavigate,
    this.onOpenSale,
    this.aiEnabled = false,
    this.aiLoaded = false,
    this.aiBusy = false,
    this.aiUnavailable = false,
    this.onToggleAi,
    this.onSelectAiMode,
    this.aiMode = 'inherit',
    this.aiGlobalEnabled = false,
    this.aiTooltip = 'Asistente IA',
  });

  final String conversationId;
  final String title;

  /// Cuando es `true` el hilo se pinta como **panel central** (sin `Scaffold` ni
  /// barra de aplicación): es lo que usa el chat de tres paneles de escritorio.
  /// En móvil se sigue abriendo como pantalla completa.
  final bool embedded;

  /// Presentación de escritorio (estilo WhatsApp Desktop): encabezado, hilo con
  /// patrón de fondo y barra de redacción nuevos. La lógica es la misma.
  final bool desktop;

  /// Acción «nuevo mensaje» del encabezado (crear/abrir chat de un cliente).
  /// La implementa el contenedor de escritorio, que es quien conoce la lista.
  final VoidCallback? onNewMessage;

  /// Adjunto que se abre al entrar (`image`, `document`, `audio`). Lo usa la
  /// acción «Enviar una foto» de la bandeja de escritorio.
  final String? autoAttach;

  /// Cambio de módulo desde las acciones del chat (p. ej. «Crear pedido»).
  final ValueChanged<String>? onNavigate;
  final ValueChanged<PosLaunchContext>? onOpenSale;
  final bool aiEnabled;
  final bool aiLoaded;
  final bool aiBusy;
  final bool aiUnavailable;
  final VoidCallback? onToggleAi;
  final ValueChanged<String>? onSelectAiMode;
  final String aiMode;
  final bool aiGlobalEnabled;
  final String aiTooltip;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  bool _followMobile = true;
  int _followRevision = 0;
  int _loadGeneration = 0;
  final _threadSearch = TextEditingController();
  bool _searching = false;
  String _threadQuery = '';

  /// Texto ya corregido que espera el SEGUNDO Enter para salir.
  String _confirmadoParaEnviar = '';
  List<ChatMessage> _messages = const [];
  final List<String> _queued = <String>[];
  bool _loading = true;
  bool _sending = false;
  String? _error;
  String? _uploadLabel;

  /// Columna de acciones (IA + ventas) del modo escritorio.
  bool _optionsOpen = false;
  bool _quickOpen = false;
  bool _aiOpen = false;
  bool _ordersOpen = false;
  bool _profileOpen = false;
  String _aiResumen = '';
  bool _aiBusy = false;
  String _aiSuggestion = '';
  String _aiDraftTitle = 'Borrador sugerido';
  String _aiError = '';

  @override
  void initState() {
    super.initState();
    _load();
    _composer.addListener(_alEscribir);
    _scroll.addListener(_trackMobileScroll);
    // Acción «Enviar una foto» desde la bandeja: abre el selector de archivos.
    final attach = widget.autoAttach;
    if (attach != null && attach.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _pickAndSendMedia(attach);
      });
    }
  }

  @override
  void dispose() {
    _revisionTimer?.cancel();
    _iaTimer?.cancel();
    _composer.removeListener(_alEscribir);
    _estadoEscuchado?.removeListener(_alCambiarEstado);
    _composer.dispose();
    _scroll.dispose();
    _threadSearch.dispose();
    super.dispose();
  }

  /*
   * REVISIÓN MIENTRAS SE ESCRIBE (como la PWA).
   *
   * La pasada local corre sola con un retardo corto (no en cada tecla) y, si hay
   * algo que arreglar, aparece una franja con la propuesta. Nunca reemplaza el
   * texto ni envía nada: se aplica si la persona lo pide. Si ignora la sugerencia,
   * no se le vuelve a insistir con el mismo texto.
   */
  static const Duration _revisionDebounce = Duration(milliseconds: 450);
  Timer? _revisionTimer;
  LocalReview? _sugerencia;
  String _ignorado = '';

  /*
   * SEGUNDA OPINIÓN CON IA (la misma que ya usa el panel).
   *
   * El diccionario local es instantáneo pero solo conoce un puñado de errores;
   * la IA corrige tildes, concordancia y puntuación. Se consulta con una espera
   * más larga, UNA petición a la vez y descartando la respuesta si el borrador ya
   * cambió: nunca se encola ni se pisa lo que la persona sigue escribiendo.
   *
   * Tampoco se gasta cuota dos veces por el mismo texto, ni cuando la persona
   * ignoró la sugerencia, ni en frases de una o dos palabras.
   */
  static const Duration _iaDebounce = Duration(milliseconds: 900);
  Timer? _iaTimer;
  bool _iaEnCurso = false;
  String _iaConsultando = '';
  String _iaUltimoTexto = '';

  void _alEscribir() {
    _revisionTimer?.cancel();
    final texto = _composer.text;
    /* Si se edita después de corregir, la confirmación pendiente deja de valer. */
    if (_confirmadoParaEnviar.isNotEmpty &&
        texto.trim() != _confirmadoParaEnviar) {
      _confirmadoParaEnviar = '';
    }
    if (texto.trim().isEmpty) {
      _iaTimer?.cancel();
      if (_sugerencia != null) setState(() => _sugerencia = null);
      return;
    }
    _revisionTimer = Timer(_revisionDebounce, () {
      if (!mounted) return;
      final textoActual = _composer.text;
      if (textoActual == _ignorado) return;
      final revision = revisarTexto(textoActual);
      final mostrar = revision.hasChanges ? revision : null;
      if (mostrar?.corrected == _sugerencia?.corrected) return;
      setState(() => _sugerencia = mostrar);
    });
    _programarIA(texto);
  }

  void _programarIA(String texto) {
    _iaTimer?.cancel();
    /*
     * Con dos palabras ya hay dónde meter la pata («ola ke ase»); se exige eso y
     * no tres, porque el corrector local se queda corto justo en los mensajes
     * cortos del chat.
     */
    final palabras = texto
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .length;
    if (texto.trim().length < 4 || palabras < 2) return;
    if (texto == _iaUltimoTexto || texto == _iaConsultando) return;
    if (kDebugMode) debugPrint('[IA] programada · $palabras palabras');
    _iaTimer = Timer(_iaDebounce, () => unawaited(_revisarConIA()));
  }

  Future<void> _revisarConIA() async {
    if (_iaEnCurso || !mounted) return;
    final texto = _composer.text;
    if (texto.trim().length < 4 ||
        texto == _iaUltimoTexto ||
        texto == _iaConsultando)
      return;
    _iaEnCurso = true;
    _iaConsultando = texto;
    try {
      final resultado = await _state.repository.proofread(
        conversationId: widget.conversationId,
        text: texto,
      );
      if (!mounted) return;
      /*
       * Se marca DESPUÉS de tener respuesta: antes se marcaba al salir de aquí y
       * un fallo de red dejaba ese texto vetado para siempre (no se volvía a
       * consultar nunca).
       */
      _iaUltimoTexto = texto;
      if (kDebugMode) {
        debugPrint(
          '[IA] respuesta · ${resultado.available ? 'IA' : 'sin IA'} · '
          '${resultado.hasChanges ? 'corrige ${resultado.correctedText.length} chars' : 'sin cambios'}',
        );
      }
      /* Si el borrador cambió mientras viajaba, la propuesta ya no sirve. */
      if (_composer.text != texto) return;
      if (texto == _ignorado || !resultado.hasChanges) return;
      final propuesta = LocalReview(
        original: texto,
        corrected: resultado.correctedText,
        edits: const [
          LocalEdit(
            kind: 'ia',
            before: '',
            after: '',
            reason: 'ortografía y puntuación (IA)',
          ),
        ],
      );
      if (_sugerencia?.corrected == propuesta.corrected) return;
      setState(() => _sugerencia = propuesta);
    } on ApiException catch (error) {
      /*
       * Es una ayuda, no un aviso: sin clave de IA, sin red o con el límite del
       * día agotado, el chat sigue igual y no se interrumpe a quien escribe.
       */
      if (kDebugMode)
        debugPrint('[IA] fallo · ${error.message} (${error.statusCode})');
    } catch (error) {
      /* Cualquier otra cosa tampoco puede tumbar el compositor. */
      if (kDebugMode) debugPrint('[IA] error inesperado · $error');
    } finally {
      _iaEnCurso = false;
      _iaConsultando = '';
      /*
       * Se siguió escribiendo mientras la IA pensaba: se vuelve a programar para
       * el texto actual. Sin esto, la última frase se quedaba sin revisar.
       */
      if (mounted && _composer.text != texto) _programarIA(_composer.text);
    }
  }

  void _aplicarSugerencia() {
    final revision = _sugerencia;
    if (revision == null) return;
    setState(() {
      // Antes de tocar el campo: así el listener no vuelve a preguntar por el
      // mismo texto recién corregido (no se gasta cuota dos veces).
      _iaUltimoTexto = revision.corrected;
      _composer.text = revision.corrected;
      _composer.selection = TextSelection.collapsed(
        offset: revision.corrected.length,
      );
      _sugerencia = null;
    });
  }

  void _ignorarSugerencia() {
    setState(() {
      _ignorado = _composer.text;
      _sugerencia = null;
    });
  }

  CrmState get _state => CrmScope.of(context, listen: false);
  Conversation? get _conversation =>
      _state.conversationById(widget.conversationId);

  void _openSale(String mode) {
    final customerId = _conversation?.customerId ?? '';
    if (customerId.isEmpty) {
      crmToast(context, 'Este chat todavía no tiene un cliente vinculado.');
      return;
    }
    final launch = PosLaunchContext(
      customerId: customerId,
      conversationId: widget.conversationId,
      mode: mode,
    );
    setState(() => _optionsOpen = false);
    final open = widget.onOpenSale;
    if (open != null) {
      open(launch);
    } else {
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => PosScreen(initialSale: launch),
      ));
    }
  }

  /*
   * EL HILO ABIERTO SE ENTERA DE LO QUE LLEGA.
   *
   * Antes solo se cargaba al abrir el chat y al enviar: si el canal en vivo se
   * caía y volvía (o el cliente escribía mientras tanto), el mensaje existía en
   * el servidor pero la persona no lo veía hasta recargar a mano. Ahora se escucha
   * el estado: si cambia el último mensaje o el contador de no leídos, se vuelve
   * a pedir el hilo. La marca evita recargar dos veces por el mismo cambio.
   */
  CrmState? _estadoEscuchado;
  String _selloHilo = '';

  String _selloDe(Conversation? conversation) => conversation == null
      ? ''
      : '${conversation.lastAt}/${conversation.unread}/${conversation.lastBody}';

  void _alCambiarEstado() {
    if (!mounted) return;
    final sello = _selloDe(_conversation);
    if (sello == _selloHilo) return;
    _selloHilo = sello;
    _load();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final estado = CrmScope.of(context, listen: false);
    if (identical(estado, _estadoEscuchado)) return;
    _estadoEscuchado?.removeListener(_alCambiarEstado);
    _estadoEscuchado = estado..addListener(_alCambiarEstado);
    _selloHilo = _selloDe(_conversation);
  }

  Future<void> _load() async {
    final generation = ++_loadGeneration;
    final state = _state;
    setState(() {
      // Una recarga de fondo conserva el hilo y su posición. El cargador solo
      // aparece al abrir esta instancia de conversación por primera vez.
      _error = null;
    });
    try {
      final messages = await state.repository.messages(widget.conversationId);
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _messages = messages;
        _loading = false;
        if (state.pendingCount == 0) _queued.clear();
      });
      await state.repository.markRead(widget.conversationId).catchError((_) {});
      _jumpToBottom();
    } on ApiException catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        if (_messages.isEmpty) _error = error.message;
        _loading = false;
      });
    }
  }

  void _trackMobileScroll() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    _followMobile = position.maxScrollExtent - position.pixels <= 100;
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients || !_followMobile) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
      );
    });
  }

  // ------------------------------------------------------------------- envíos
  ///
  /// ENTER CON REVISIÓN: el primer Enter, si hay algo que corregir, NO envía.
  /// Aplica la propuesta, la deja escrita y pide una segunda pulsación. El
  /// segundo Enter envía el texto corregido. Si no hay nada que corregir, envía
  /// al primer toque; el botón de enviar sigue enviando directo.
  Future<void> _enviarConRevision() async {
    final body = _composer.text.trim();
    if (body.isEmpty || _sending) return;
    if (body == _confirmadoParaEnviar) {
      _confirmadoParaEnviar = '';
      await _send();
      return;
    }
    /*
     * Se prefiere la propuesta que ya está a la vista (IA o diccionario) y, si
     * no hay ninguna, se calcula la local al momento: nunca se envía con una
     * falta que ya se sabía cómo arreglar.
     */
    final revision = _sugerencia ?? revisarTexto(body);
    final corregido = revision.corrected.trim();
    if (!revision.hasChanges || corregido.isEmpty || corregido == body) {
      await _send();
      return;
    }
    setState(() {
      _iaUltimoTexto = corregido;
      _composer.text = revision.corrected;
      _composer.selection = TextSelection.collapsed(
        offset: revision.corrected.length,
      );
      _sugerencia = null;
      _confirmadoParaEnviar = corregido;
    });
    crmToast(
      context,
      'Corregido. Pulsa Enter otra vez para enviarlo (o el botón de enviar).',
      tone: CrmToastTone.info,
    );
  }

  Future<void> _send() async {
    final body = _composer.text.trim();
    if (body.isEmpty || _sending) return;
    final state = _state;
    final operationKey = newOperationKey('msg');
    _followMobile = true;
    setState(() => _followRevision++);
    setState(() => _sending = true);
    try {
      await state.repository.sendMessage(
        widget.conversationId,
        body,
        operationKey: operationKey,
      );
      if (_composer.text.trim() == body) _composer.clear();
      _confirmadoParaEnviar = '';
      _sugerencia = null;
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 0) {
        await state.enqueueMessage(
          widget.conversationId,
          body,
          operationKey: operationKey,
        );
        if (!mounted) return;
        setState(() {
          _queued.add(body);
          _composer.clear();
        });
        _jumpToBottom();
        crmToast(
          context,
          'Sin conexión: el mensaje se enviará cuando vuelva la red (sin duplicarse).',
        );
      } else {
        crmToast(context, error.message);
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _recordVoice() async {
    if (_sending) return;
    final recorded = await showVoiceRecorder(context);
    if (recorded == null || !mounted) return;
    final state = _state;
    final operationKey = newOperationKey('voc');
    setState(() {
      _sending = true;
      _uploadLabel = 'Enviando nota de voz…';
    });
    try {
      await state.repository.sendMedia(
        widget.conversationId,
        bytes: recorded.bytes,
        kind: 'audio',
        filename: recorded.filename,
        operationKey: operationKey,
      );
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'send_unknown') {
        crmToast(
          context,
          'No podemos confirmar si la nota llegó. Revísalo en el hilo antes de reintentar.',
        );
      } else {
        crmToast(context, error.message);
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
          _uploadLabel = null;
        });
      }
    }
  }

  Future<void> _pickAndSendMedia(String kind) async {
    if (_sending) return;
    final allowed = switch (kind) {
      'image' => const ['jpg', 'jpeg', 'png', 'webp'],
      'document' => const ['pdf'],
      'video' => const ['mp4', '3gp'],
      _ => const ['m4a', 'mp3', 'ogg', 'opus', 'aac', 'wav'],
    };
    // Selector del sistema (en pruebas se sustituye; nunca se falsea la subida).
    final file = await MediaPicker.pick(allowed);
    if (file == null || !mounted) return;
    final bytes = file.bytes;
    if (bytes.isEmpty) {
      crmToast(context, 'No pudimos leer el archivo.');
      return;
    }
    if (bytes.length > 16 * 1024 * 1024) {
      crmToast(context, 'El archivo supera el límite de 16 MB.');
      return;
    }
    final caption = kind == 'image' || kind == 'video'
        ? await _askCaption()
        : null;
    if (!mounted) return;

    final state = _state;
    final operationKey = newOperationKey(
      kind == 'image'
          ? 'img'
          : kind == 'document'
          ? 'doc'
          : kind == 'video'
          ? 'vid'
          : 'voc',
    );
    setState(() {
      _sending = true;
      _uploadLabel = kind == 'image'
          ? 'Enviando foto…'
          : kind == 'document'
          ? 'Enviando PDF…'
          : kind == 'video'
          ? 'Enviando video…'
          : 'Enviando nota de voz…';
    });
    try {
      await state.repository.sendMedia(
        widget.conversationId,
        bytes: bytes,
        kind: kind,
        filename: file.name,
        caption: (caption ?? '').isEmpty ? null : caption,
        operationKey: operationKey,
      );
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'send_unknown') {
        await crmConfirm(
          context,
          title: 'No sabemos si el archivo salió',
          message:
              '${error.message}\n\nRevisa el hilo antes de volver a enviarlo: el CRM evita duplicados por sí mismo mientras use la misma operación.',
          confirmLabel: 'Entendido',
        );
      } else {
        crmToast(context, error.message);
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
          _uploadLabel = null;
        });
      }
    }
  }

  Future<String?> _askCaption() {
    /*
     * El `TextEditingController` lo posee el diálogo.
     *
     * Antes se creaba aquí y se destruía al volver `showDialog`: mientras la ruta
     * se animaba fuera, sus `TextField` se reconstruían con un controlador ya
     * destruido («A TextEditingController was used after being disposed»), que
     * rompía la interfaz justo después de adjuntar una foto.
     */
    return showDialog<String>(
      context: context,
      builder: (dialogContext) => const _PhotoCaptionDialog(),
    );
  }

  Future<void> _openShareSheet() async {
    final state = _state;
    Map<String, dynamic> data;
    try {
      data = await state.repository.chatSharing();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
      return;
    }
    if (!mounted) return;
    final locations = listv(data['locations']);
    final banks = listv(data['banks']);
    final catalogs = listv(data['catalogs']);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            const _SheetTitle('Ubicación actual'),
            ListTile(
              leading: const Icon(Icons.my_location_rounded),
              title: const Text('Compartir mi ubicación GPS'),
              subtitle: const Text('Requiere permiso y confirmación'),
              onTap: () {
                Navigator.pop(sheetContext);
                _sendCurrentLocation();
              },
            ),
            if (locations.isEmpty && banks.isEmpty && catalogs.isEmpty)
              const ListTile(
                title: Text('No hay otros datos configurados para compartir.'),
              ),
            if (locations.isNotEmpty) const _SheetTitle('Ubicaciones'),
            for (final row in locations)
              ListTile(
                leading: const Icon(Icons.place_outlined),
                title: Text(str(row['name'], 'Ubicación')),
                subtitle: Text(str(row['address'], '')),
                onTap: () {
                  /*
                   * El servidor guarda la ubicación del negocio y devuelve DOS
                   * identificadores: `id` (la opción de la lista compartida) y
                   * `referenceId` (la fila real de `locations`). El envío nativo
                   * necesita el segundo: con `id` responde 422 `unknown_location`.
                   */
                  final referencia = str(row['referenceId']);
                  final idUbicacion = referencia.isNotEmpty
                      ? referencia
                      : str(row['id']);
                  Navigator.pop(sheetContext);
                  _sendLocation(idUbicacion);
                },
              ),
            if (banks.isNotEmpty) const _SheetTitle('Datos de pago'),
            for (final row in banks)
              ListTile(
                leading: const Icon(Icons.account_balance_outlined),
                title: Text('${str(row['bank'])} · ${str(row['currency'])}'),
                subtitle: Text('${str(row['holder'])} · ${str(row['number'])}'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _sendText(
                    [
                      'Banco: ${str(row['bank'])}',
                      'Titular: ${str(row['holder'])}',
                      if (str(row['type']).isNotEmpty)
                        'Tipo: ${str(row['type'])}',
                      'Cuenta: ${str(row['number'])}',
                      'Moneda: ${str(row['currency'])}',
                      if (str(row['note']).isNotEmpty) str(row['note']),
                    ].join('\n'),
                  );
                },
              ),
            if (catalogs.isNotEmpty) const _SheetTitle('Catálogos'),
            for (final row in catalogs)
              ListTile(
                leading: const Icon(Icons.link_rounded),
                title: Text(str(row['name'], 'Catálogo')),
                subtitle: Text(str(row['url'])),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _sendText(
                    str(row['message']).isEmpty
                        ? str(row['url'])
                        : '${str(row['message'])}\n${str(row['url'])}',
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  /// Abre la conciliación de un envío de archivo con resultado desconocido.
  /// No reenvía nada: corrige el estado con datos que la persona ya verificó.
  Future<void> _reconciliarMedia() async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) =>
          ChatMediaReconcileDialog(repository: _state.repository),
    );
    if (mounted) await _load();
  }

  Future<void> _sendLocation(String locationId) async {
    final state = _state;
    final operationKey = newOperationKey('loc');
    setState(() => _sending = true);
    try {
      await state.repository.sendLocation(
        widget.conversationId,
        locationId: locationId,
        operationKey: operationKey,
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendCurrentLocation() async {
    if (_sending) return;
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        if (mounted)
          crmToast(
            context,
            'Activa la ubicación del dispositivo para compartirla.',
          );
        return;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied)
        permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        if (mounted)
          crmToast(context, 'El dispositivo no concedió permiso de ubicación.');
        return;
      }
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
      if (!mounted) return;
      final confirmed = await crmConfirm(
        context,
        title: 'Compartir ubicación actual',
        message:
            'Se enviarán estas coordenadas al cliente: ${position.latitude.toStringAsFixed(5)}, ${position.longitude.toStringAsFixed(5)}.',
        confirmLabel: 'Enviar ubicación',
      );
      if (confirmed != true || !mounted) return;
      setState(() => _sending = true);
      await _state.repository.sendCurrentLocation(
        widget.conversationId,
        latitude: position.latitude,
        longitude: position.longitude,
        operationKey: newOperationKey('gps'),
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } catch (_) {
      if (mounted) crmToast(context, 'No se pudo obtener la ubicación actual.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendText(String body) async {
    if (body.trim().isEmpty) return;
    _composer.text = body;
    await _send();
  }

  /// ACCIONES RÁPIDAS EN MÓVIL: hoja desde abajo, 80 % de la altura.
  ///
  /// En pantalla pequeña una columna lateral se comería el chat; la hoja se
  /// cierra deslizando y no toca ni la lista ni el hilo.
  Future<void> _abrirAccionesRapidasMovil() {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: 0.8,
        child: ChatQuickPanel(
          width: double.infinity,
          onClose: () => Navigator.pop(sheetContext),
          onUseReply: (texto) {
            Navigator.pop(sheetContext);
            _usarRespuestaRapida(texto);
          },
          onShareWeb: () {
            Navigator.pop(sheetContext);
            _compartirWeb();
          },
          onShareStore: () {
            Navigator.pop(sheetContext);
            _compartirTienda();
          },
          onShareData: () {
            Navigator.pop(sheetContext);
            _openShareSheet();
          },
        ),
      ),
    );
  }

  /// Sitio público del negocio, sin barra final. En desarrollo apunta al local.
  String _sitioWeb() => AppConfig.apiBaseUrl.replaceAll(RegExp(r'/+$'), '');

  /// Una respuesta rápida se ESCRIBE en el compositor: no se envía sola.
  void _usarRespuestaRapida(String texto) {
    setState(() {
      _quickOpen = false;
      // Ya lo escribimos nosotros: no hace falta que la IA lo revise otra vez.
      _iaUltimoTexto = texto;
      _composer.text = texto;
      _composer.selection = TextSelection.collapsed(offset: texto.length);
    });
  }

  Future<void> _compartirWeb() async {
    setState(() => _quickOpen = false);
    await _sendText(_sitioWeb());
  }

  Future<void> _compartirTienda() async {
    setState(() => _quickOpen = false);
    await _sendText('${_sitioWeb()}/store/');
  }

  Future<void> _openTemplates() async {
    final state = _state;
    List<Map<String, dynamic>> templates;
    try {
      templates = await state.repository.waTemplates();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
      return;
    }
    if (!mounted) return;
    if (templates.isEmpty) {
      crmToast(context, 'No hay plantillas aprobadas.');
      return;
    }
    final picked = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final template in templates)
              ListTile(
                leading: const Icon(Icons.article_outlined),
                title: Text(str(template['name'], 'Plantilla')),
                subtitle: Text(
                  str(template['category'], str(template['language'], '')),
                ),
                onTap: () => Navigator.pop(sheetContext, template),
              ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    final name = str(picked['name']);
    if (name.isEmpty) return;
    /*
     * Una plantilla con huecos (`{{1}}`, `{{2}}`…) no se puede enviar a ciegas:
     * el servidor responde 422 `missing_template_data`. Se piden aquí los textos
     * que falten, con el número de hueco que trae el propio cuerpo de la
     * plantilla, y se envían como `templateValues`.
     */
    final huecos = <int>{
      for (final match in RegExp(
        r'\{\{\s*(\d+)\s*\}\}',
      ).allMatches(str(picked['body'])))
        if (int.tryParse(match.group(1) ?? '') != null)
          int.parse(match.group(1)!),
    }.toList()..sort();
    Map<String, dynamic>? values;
    if (huecos.isNotEmpty) {
      values = await _askTemplateValues(name, huecos);
      if (values == null || !mounted) return;
    }
    final operationKey = newOperationKey('tpl');
    setState(() => _sending = true);
    try {
      await state.repository.sendTemplate(
        widget.conversationId,
        name,
        operationKey: operationKey,
        values: values,
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Pide el texto de cada hueco de la plantilla. Devuelve `null` si se cancela.
  Future<Map<String, dynamic>?> _askTemplateValues(
    String templateName,
    List<int> huecos,
  ) {
    /*
     * Los controladores los posee el DIÁLOGO, no este método.
     *
     * Antes se creaban aquí y se destruían al volver `showDialog`: mientras la
     * ruta se animaba fuera, sus `TextField` se reconstruían y usaban un
     * controlador ya destruido («A TextEditingController was used after being
     * disposed»). Con el diálogo como dueño, la vida útil es la correcta.
     */
    return showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) =>
          _TemplateValuesDialog(templateName: templateName, huecos: huecos),
    );
  }

  Future<void> _toggleResolved() async {
    final state = _state;
    final resolved = !(_conversation?.isResolved ?? false);
    try {
      await state.repository.setResolved(widget.conversationId, resolved);
      await state.refresh(quiet: true);
      if (mounted)
        crmToast(
          context,
          resolved ? 'Conversación finalizada.' : 'Conversación reabierta.',
        );
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 0) {
        await state.enqueueResolved(widget.conversationId, resolved: resolved);
        if (mounted)
          crmToast(context, 'Sin conexión: se aplicará cuando vuelva la red.');
        return;
      }
      crmToast(context, error.message);
    }
  }

  Future<void> _assignment() async {
    final state = _state;
    final session = state.session;
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.front_hand_outlined),
              title: const Text('Pedir que me la asignen'),
              subtitle: const Text('El pedido llega a administración'),
              onTap: () => Navigator.pop(sheetContext, 'request'),
            ),
            if (session.can('chats.take_unassigned'))
              ListTile(
                leading: const Icon(Icons.person_add_alt_rounded),
                title: const Text('Ponerme al frente'),
                onTap: () => Navigator.pop(sheetContext, 'take'),
              ),
            ListTile(
              leading: const Icon(Icons.lock_open_rounded),
              title: const Text('Liberar conversación'),
              onTap: () => Navigator.pop(sheetContext, 'release'),
            ),
            if (session.can('admin.full'))
              ListTile(
                leading: const Icon(Icons.assignment_ind_outlined),
                title: const Text('Asignar a un compañero…'),
                onTap: () => Navigator.pop(sheetContext, 'assign'),
              ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    try {
      switch (action) {
        case 'request':
          await state.repository.requestConversationAssignment(
            widget.conversationId,
          );
          if (mounted) crmToast(context, 'Pedido enviado a administración.');
        case 'take':
        case 'release':
          await state.repository.assignConversation(
            widget.conversationId,
            action: action,
          );
          await state.refresh(quiet: true);
          if (mounted)
            crmToast(
              context,
              action == 'take'
                  ? 'Conversación tomada.'
                  : 'Conversación liberada.',
            );
        case 'assign':
          final users = await state.repository.assignableUsers();
          if (!mounted) return;
          final picked = await showModalBottomSheet<Map<String, dynamic>>(
            context: context,
            showDragHandle: true,
            isScrollControlled: true,
            builder: (sheetContext) => SafeArea(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final user in users)
                    ListTile(
                      leading: CrmAvatar(
                        label: str(user['display_name'], str(user['username'])),
                      ),
                      title: Text(
                        str(
                          user['display_name'],
                          str(user['username'], 'Usuario'),
                        ),
                      ),
                      subtitle: Text(str(user['role'])),
                      onTap: () => Navigator.pop(sheetContext, user),
                    ),
                ],
              ),
            ),
          );
          if (picked == null || !mounted) return;
          await state.repository.assignConversation(
            widget.conversationId,
            action: 'assign',
            userId: str(picked['id']),
          );
          await state.refresh(quiet: true);
          if (mounted) crmToast(context, 'Conversación asignada.');
      }
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  /// Presentación de escritorio del hilo (estilo WhatsApp Desktop).
  ///
  /// Reutiliza exactamente los mismos manejadores (`_send`, `_pickAndSendMedia`,
  /// `_openShareSheet`, `_recordVoice`, `_menuButton`) y los mismos datos; solo
  /// cambia la capa visual.
  Widget _buildDesktop(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    final conversation = _conversation;
    final phone = (conversation?.phone ?? '').trim();
    final stage = _etapaEnEspanol(conversation?.stage ?? '');
    final subtitle = [
      if (phone.isNotEmpty) phone,
      if (stage.isNotEmpty) stage,
      if (conversation?.isResolved == true) 'finalizada',
    ].join(' · ');

    // Misma luminosidad que eligió el usuario (claro u oscuro).
    final theme = buildChatDesktopTheme(context);

    final Widget body;
    if (_loading) {
      body = Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
        ),
      );
    } else if (_error != null) {
      body = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 30, color: c.danger),
            const SizedBox(height: 10),
            Text(_error!, textAlign: TextAlign.center, style: t.rowPreview),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _load,
              child: Text('Reintentar', style: TextStyle(color: c.accent)),
            ),
          ],
        ),
      );
    } else {
      body = ChatThread(
        messages: _messages,
        queued: _queued,
        followRevision: _followRevision,
        search: _threadQuery,
        customerPhone: _conversation?.phone ?? '',
      );
    }

    return Theme(
      data: theme,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final panelWidth = (constraints.maxWidth * 0.30).clamp(280.0, 460.0);
          /*
           * ACCIONES RÁPIDAS: columna ANCLADA A LA DERECHA, con ancho fijo.
           *
           * Antes se dibujaba encima del hilo y tapaba los mensajes. Ahora
           * EMPUJA el contenido: la lista de chats queda intacta, el hilo se
           * encoge y el compositor sigue visible.
           */
          final quickWidth = constraints.maxWidth >= 1180 ? 360.0 : 320.0;
          /*
           * Anchos de las columnas de pedidos y ficha: 30 % y 40 % del área del
           * chat, con un tope absoluto y otro RELATIVO (62 % / 80 %), para que en
           * una ventana pequeña no se coman el hilo entero.
           */
          final ordersWidth = math.min(
            (constraints.maxWidth * 0.30).clamp(280.0, 480.0),
            constraints.maxWidth * 0.62,
          );
          final profileWidth = math.min(
            (constraints.maxWidth * 0.40).clamp(320.0, 640.0),
            constraints.maxWidth * 0.80,
          );
          return Stack(
            children: [
              Positioned.fill(
                child: Row(
                  children: [
                    /*
                     * La columna del chat se envuelve en un detector de toques:
                     * con un panel lateral abierto (acciones rápidas), tocar
                     * FUERA de la columna la cierra, como un cajón. Con el panel
                     * cerrado no intercepta nada: los botones y los mensajes
                     * siguen funcionando igual.
                     */
                    Expanded(
                      child: GestureDetector(
                        behavior: HitTestBehavior.translucent,
                        onTap: _quickOpen
                            ? () => setState(() => _quickOpen = false)
                            : null,
                        child: Column(
                          children: [
                            ChatHeader(
                              name: conversation?.name ?? widget.title,
                              subtitle: subtitle,
                              menu: _menuButton(conversation),
                              aiEnabled: widget.aiEnabled,
                              aiLoaded: widget.aiLoaded,
                              aiBusy: widget.aiBusy,
                              aiUnavailable: widget.aiUnavailable,
                              onToggleAi: widget.onToggleAi,
                              onSelectAiMode: widget.onSelectAiMode,
                              aiMode: widget.aiMode,
                              aiGlobalEnabled: widget.aiGlobalEnabled,
                              aiTooltip: widget.aiTooltip,
                              aiConversation: conversation,
                              onOpenAiAssistant: _asistenteContextual,
                              onNewMessage: widget.onNewMessage,
                              onCall: phone.isEmpty
                                  ? null
                                  : () => launchUrl(Uri.parse('tel:$phone')),
                              searching: _searching,
                              searchController: _threadSearch,
                              onSearchChanged: (value) =>
                                  setState(() => _threadQuery = value),
                              onToggleSearch: () => setState(() {
                                _searching = !_searching;
                                if (!_searching) {
                                  _threadSearch.clear();
                                  _threadQuery = '';
                                }
                              }),
                              onOrders: () => setState(() {
                                _profileOpen = false;
                                _quickOpen = false;
                                _optionsOpen = false;
                                _aiOpen = false;
                                _ordersOpen = !_ordersOpen;
                              }),
                              onProfile: () => setState(() {
                                _ordersOpen = false;
                                _quickOpen = false;
                                _optionsOpen = false;
                                _aiOpen = false;
                                _profileOpen = !_profileOpen;
                              }),
                            ),
                            Expanded(child: body),
                            if (_sugerencia != null && _aiSuggestion.isEmpty)
                              ChatLiveSuggestion(
                                review: _sugerencia!,
                                accent: c.accent,
                                background: c.dark
                                    ? const Color(0xFF1E3A31)
                                    : const Color(0xFFE8F5EF),
                                foreground: c.dark
                                    ? const Color(0xFFBFE8D8)
                                    : const Color(0xFF0E3A2B),
                                onApply: _aplicarSugerencia,
                                onOpen: _proofread,
                                onDismiss: _ignorarSugerencia,
                              ),
                            if (_aiSuggestion.isNotEmpty)
                              ChatAiDraft(
                                text: _aiSuggestion,
                                title: _aiDraftTitle,
                                onUse: _useAiSuggestion,
                                onDiscard: _discardAiSuggestion,
                              ),
                            if (_aiBusy && !_aiOpen)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  12,
                                  5,
                                  12,
                                  5,
                                ),
                                child: Row(
                                  children: [
                                    SizedBox(
                                      width: 13,
                                      height: 13,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: c.accent,
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      'Preparando borrador…',
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: c.textSecondary,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            if (_aiError.isNotEmpty && !_aiOpen)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  12,
                                  5,
                                  12,
                                  5,
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        _aiError,
                                        softWrap: true,
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: c.danger,
                                        ),
                                      ),
                                    ),
                                    IconButton(
                                      tooltip: 'Cerrar aviso',
                                      onPressed: () =>
                                          setState(() => _aiError = ''),
                                      icon: Icon(
                                        Icons.close_rounded,
                                        size: 16,
                                        color: c.textSecondary,
                                      ),
                                      visualDensity: VisualDensity.compact,
                                    ),
                                  ],
                                ),
                              ),
                            ChatComposer(
                              controller: _composer,
                              sending: _sending,
                              uploadLabel: _uploadLabel,
                              onSend: () => _send(),
                              onAttach: (kind) => _pickAndSendMedia(kind),
                              onShareLocation: () => _openShareSheet(),
                              onRecord: () => _recordVoice(),
                              onSendKey: _enviarConRevision,
                              onProofread: _proofread,
                              onReplySuggestion: _replySuggestion,
                              onMoreAiTools: () => setState(() {
                                _optionsOpen = false;
                                _quickOpen = false;
                                _ordersOpen = false;
                                _profileOpen = false;
                                _aiOpen = !_aiOpen;
                              }),
                              aiBusy: _aiBusy,
                              onQuickActions: () => setState(() {
                                _optionsOpen = false;
                                _aiOpen = false;
                                _ordersOpen = false;
                                _profileOpen = false;
                                _quickOpen = !_quickOpen;
                              }),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (_quickOpen)
                      ChatQuickPanel(
                        width: quickWidth,
                        onClose: () => setState(() => _quickOpen = false),
                        onUseReply: _usarRespuestaRapida,
                        onShareWeb: _compartirWeb,
                        onShareStore: _compartirTienda,
                        onShareData: () {
                          _openShareSheet();
                        },
                      ),
                  ],
                ),
              ),
              // Las opciones comerciales siguen accesibles sin ocupar el editor.
              Positioned(
                right: 16,
                bottom: 120,
                child: _ChatFab(
                  icon: Icons.tune_rounded,
                  tooltip: 'Opciones del chat',
                  onTap: () => setState(() {
                    _quickOpen = false;
                    _aiOpen = false;
                    _ordersOpen = false;
                    _profileOpen = false;
                    _optionsOpen = true;
                  }),
                ),
              ),
              // Columna de acciones: ENCIMA del hilo, con el fondo desenfocado.
              if (_optionsOpen)
                Positioned.fill(
                  child: GestureDetector(
                    onTap: () => setState(() => _optionsOpen = false),
                    child: BackdropFilter(
                      filter: ui.ImageFilter.blur(sigmaX: 6, sigmaY: 6),
                      child: Container(
                        color: c.dark
                            ? const Color(0x55000000)
                            : const Color(0x220B1D24),
                      ),
                    ),
                  ),
                ),
              if (_optionsOpen)
                Positioned(
                  top: 0,
                  bottom: 0,
                  right: 0,
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: 1),
                    duration: const Duration(milliseconds: 200),
                    curve: Curves.easeOutCubic,
                    builder: (context, value, child) => Transform.translate(
                      offset: Offset(panelWidth * (1 - value), 0),
                      child: Opacity(
                        opacity: value.clamp(0.0, 1.0),
                        child: child,
                      ),
                    ),
                    child: ChatOptionsPanel(
                      width: panelWidth,
                      onClose: () => setState(() => _optionsOpen = false),
                      onNewOrder: () => _openSale('order'),
                      onNewQuote: () => _openSale('quote'),
                      onTemplate: () {
                        setState(() => _optionsOpen = false);
                        _openTemplates();
                      },
                      onShareData: () {
                        setState(() => _optionsOpen = false);
                        _openShareSheet();
                      },
                      onAssign: () {
                        setState(() => _optionsOpen = false);
                        _assignment();
                      },
                      onResolveToggle: () {
                        setState(() => _optionsOpen = false);
                        _toggleResolved();
                      },
                      onRefresh: _load,
                      onReconcile: () {
                        setState(() => _optionsOpen = false);
                        _reconciliarMedia();
                      },
                      isResolved: conversation?.isResolved ?? false,
                    ),
                  ),
                ),
              /*
               * PEDIDOS Y FICHA: columna pegada al borde derecho y A TODO EL ALTO,
               * por encima de la cabecera y del compositor (antes nacía debajo del
               * encabezado y quedaba un corte feo). Velo detrás para cerrar
               * tocando fuera.
               */
              if (_ordersOpen || _profileOpen)
                Positioned.fill(
                  child: GestureDetector(
                    onTap: () => setState(() {
                      _ordersOpen = false;
                      _profileOpen = false;
                    }),
                    child: BackdropFilter(
                      filter: ui.ImageFilter.blur(sigmaX: 6, sigmaY: 6),
                      child: Container(
                        color: c.dark
                            ? const Color(0x55000000)
                            : const Color(0x220B1D24),
                      ),
                    ),
                  ),
                ),
              if (_ordersOpen || _profileOpen)
                Positioned(
                  top: 0,
                  bottom: 0,
                  right: 0,
                  child: _profileOpen
                      ? ChatCustomerPanel(
                          width: profileWidth,
                          onClose: () => setState(() => _profileOpen = false),
                          repository: _state.repository,
                          customerId: conversation?.customerId ?? '',
                        )
                      : ChatOrdersPanel(
                          width: ordersWidth,
                          onClose: () => setState(() => _ordersOpen = false),
                          repository: _state.repository,
                          customerId: conversation?.customerId ?? '',
                          customerName: conversation?.name ?? widget.title,
                          /*
                           * Editar: lleva a la pantalla de facturación/ventas.
                           * El POS todavía no acepta abrir un pedido existente,
                           * así que se abre el módulo y el usuario lo busca ahí.
                           */
                          onEditOrder: (_) => _openSale('order'),
                        ),
                ),
              // Herramientas ampliadas: flotan sobre los mensajes y dejan el editor libre.
              if (_aiOpen)
                Positioned(
                  top: 54,
                  bottom: math.max(120, constraints.maxHeight * 0.18),
                  right: 8,
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: 1),
                    duration: const Duration(milliseconds: 200),
                    curve: Curves.easeOutCubic,
                    builder: (context, value, child) => Transform.translate(
                      offset: Offset(panelWidth * (1 - value), 0),
                      child: Opacity(
                        opacity: value.clamp(0.0, 1.0),
                        child: child,
                      ),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: ChatAiPanel(
                        width: panelWidth,
                        onClose: () => setState(() => _aiOpen = false),
                        busy: _aiBusy,
                        suggestion: _aiSuggestion,
                        error: _aiError,
                        summary: _aiResumen,
                        onProofread: () {
                          setState(() => _aiOpen = false);
                          _proofread();
                        },
                        onReplySuggestion: _replySuggestion,
                        onAssistant: () {
                          setState(() => _aiOpen = false);
                          _asistenteContextual();
                        },
                        onSummary: _resumenCliente,
                        onUseSuggestion: _useAiSuggestion,
                        onDiscardSuggestion: _discardAiSuggestion,
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  /// Etapa del cliente en español, para la cabecera del hilo.
  static String _etapaEnEspanol(String stage) {
    switch (stage.trim().toUpperCase()) {
      case 'NUEVO':
        return 'Nuevo';
      case 'EN_CONVERSACION':
        return 'En conversación';
      case 'PROSPECT':
      case 'PROSPECTOS':
        return 'Prospecto';
      case 'INTERESTED':
      case 'INTERESADO':
        return 'Interesado';
      case 'PEDIDO_CREADO':
        return 'Pedido creado';
      case 'CONFIRMADO':
        return 'Confirmado';
      case 'ENTREGADO':
        return 'Entregado';
      case 'SEGUIMIENTO':
        return 'En seguimiento';
      case 'RECOMPRA':
      case 'REPEAT_CUSTOMER':
        return 'Recompra';
      case 'CUSTOMER':
        return 'Cliente';
      case 'PERDIDO':
        return 'Perdido';
      case 'INACTIVE':
        return 'Inactivo';
      default:
        return stage.trim().isEmpty ? '' : stage.trim().toLowerCase();
    }
  }

  /// RESUMEN DEL CLIENTE: datos reales del expediente, sin inventar nada.
  ///
  /// Se lee del servidor con los permisos de quien está en el chat; si el
  /// cliente no tiene ficha (registro sin teléfono) se dice y no se muestra aire.
  Future<void> _resumenCliente() async {
    final conversacion = _conversation;
    final customerId = conversacion?.customerId ?? '';
    if (customerId.isEmpty) {
      setState(() => _aiError = 'Esta conversación no tiene cliente asociado.');
      return;
    }
    setState(() {
      _aiBusy = true;
      _aiError = '';
      _aiResumen = '';
    });
    try {
      final perfil = await _state.repository.customer(customerId);
      final cliente = mapv(perfil['customer']);
      final compras = listv(perfil['purchases']).map(mapv).toList();
      num total = 0;
      for (final compra in compras) {
        total += num.tryParse('${compra['total'] ?? 0}') ?? 0;
      }
      final partes = <String>[
        if (str(cliente['name']).isNotEmpty) 'Nombre: ${str(cliente['name'])}',
        if (str(cliente['phone_e164']).isNotEmpty)
          'Teléfono: ${str(cliente['phone_e164'])}',
        if (str(cliente['stage']).isNotEmpty) 'Etapa: ${str(cliente['stage'])}',
        'Compras: ${compras.length}',
        if (compras.isNotEmpty) 'Total comprado: ${CrmFormat.money(total)}',
        if (conversacion != null && conversacion.lastBody.isNotEmpty)
          'Último mensaje: ${conversacion.lastBody}',
      ];
      if (!mounted) return;
      setState(() => _aiResumen = partes.join('\n'));
    } on ApiException catch (error) {
      if (mounted) setState(() => _aiError = error.message);
    } finally {
      if (mounted) setState(() => _aiBusy = false);
    }
  }

  /// CORREGIR EL BORRADOR.
  ///
  /// Primero la pasada LOCAL (instantánea, sin red y sin IA) y después, si la
  /// persona quiere, la IA del servidor. Antes esto solo llamaba al servidor y se
  /// quedaba en silencio cuando no había IA configurada: el botón parecía roto.
  Future<void> _proofread() async {
    final texto = _composer.text;
    if (texto.trim().isEmpty) {
      crmToast(context, 'Escribe primero el mensaje que quieres corregir.');
      return;
    }
    final propuesta = await showDialog<String>(
      context: context,
      builder: (_) => ChatCorrectionSheet(
        original: texto,
        repository: _state.repository,
        conversationId: widget.conversationId,
      ),
    );
    if (!mounted || propuesta == null || propuesta == texto) return;
    setState(() {
      _aiSuggestion = propuesta;
      _aiDraftTitle = 'Corrección propuesta';
      _aiError = '';
    });
    crmToast(context, 'Corrección lista para revisar junto al mensaje.');
  }

  Future<void> _replySuggestion() async {
    if (_aiBusy) return;
    final actual = _conversation;
    if (actual == null) return;
    setState(() {
      _optionsOpen = false;
      _aiOpen = false;
      _quickOpen = false;
      _ordersOpen = false;
      _profileOpen = false;
      _aiBusy = true;
      _aiSuggestion = '';
      _aiDraftTitle = 'Respuesta sugerida';
      _aiError = '';
    });
    try {
      final data = await _state.repository.replySuggestionDetailed(
        widget.conversationId,
      );
      if (!mounted) return;
      setState(() {
        _aiBusy = false;
        _aiSuggestion = data.text;
        if (data.text.isEmpty) _aiError = data.explain();
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _aiBusy = false;
        _aiError = error.message;
      });
    }
  }

  /// Asistente IA contextual: la MISMA ruta del Centro IA del panel web.
  ///
  /// Devuelve análisis y borrador (no envía nada). Si prepara una operación,
  /// la persona la confirma dentro del propio diálogo: el servidor vuelve a
  /// comprobar permiso y estado del recurso antes de ejecutar.
  Future<void> _asistenteContextual() async {
    final actual = _conversation;
    if (actual == null) return;
    setState(() => _optionsOpen = false);
    await showDialog<void>(
      context: context,
      builder: (_) => ChatAssistantSheet(
        conversationId: actual.id,
        customerName: actual.name,
        onUseDraft: (texto) {
          if (!mounted) return;
          setState(() => _composer.text = texto);
        },
      ),
    );
  }

  /// Rellena el compositor con la propuesta. NUNCA envía sola.
  void _useAiSuggestion() {
    _iaUltimoTexto = _aiSuggestion;
    _composer.text = _aiSuggestion;
    _composer.selection = TextSelection.collapsed(offset: _aiSuggestion.length);
    setState(() {
      _optionsOpen = false;
      _aiOpen = false;
      _aiSuggestion = '';
      _sugerencia = null;
    });
    crmToast(
      context,
      'Propuesta puesta en el mensaje. Revísala antes de enviar.',
    );
  }

  void _discardAiSuggestion() {
    setState(() {
      _aiSuggestion = '';
      _aiError = '';
    });
  }

  /// Menú de acciones del hilo. Se usa igual en la barra de la app y en el
  /// encabezado del chat embebido de escritorio (una sola definición).
  List<Widget> _menuButton(Conversation? conversation) => [
    PopupMenuButton<String>(
      onSelected: (value) {
        switch (value) {
          case 'resolver':
            _toggleResolved();
          case 'asignar':
            _assignment();
          case 'refrescar':
            _load();
          case 'plantilla':
            _openTemplates();
          case 'compartir':
            _openShareSheet();
        }
      },
      itemBuilder: (menuContext) => [
        PopupMenuItem(
          value: 'resolver',
          child: Text(
            (conversation?.isResolved ?? false) ? 'Reabrir' : 'Finalizar',
          ),
        ),
        const PopupMenuItem(value: 'asignar', child: Text('Asignación')),
        const PopupMenuItem(
          value: 'plantilla',
          child: Text('Plantilla de WhatsApp'),
        ),
        const PopupMenuItem(
          value: 'compartir',
          child: Text('Compartir datos de pago/ubicación'),
        ),
        const PopupMenuItem(
          value: 'refrescar',
          child: Text('Recargar mensajes'),
        ),
      ],
    ),
  ];

  // -------------------------------------------------------------------- UI
  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final state = CrmScope.of(context);
    final conversation = state.conversationById(widget.conversationId);
    final phone = conversation?.phone ?? '';

    if (widget.desktop) return _buildDesktop(context);

    return Scaffold(
      backgroundColor: p.pageBg,
      appBar: widget.embedded
          ? null
          : AppBar(
              backgroundColor: p.surface,
              surfaceTintColor: Colors.transparent,
              titleSpacing: 0,
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    conversation?.name ?? widget.title,
                    style: TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w800,
                      color: p.ink,
                    ),
                  ),
                  Text(
                    [
                      if (phone.isNotEmpty) phone,
                      if ((conversation?.stage ?? '').isNotEmpty)
                        conversation!.stage.toLowerCase(),
                    ].join(' · '),
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500,
                      color: p.inkSecondary,
                    ),
                  ),
                ],
              ),
              actions: [
                if (phone.isNotEmpty)
                  IconButton(
                    tooltip: 'Llamar',
                    icon: const Icon(Icons.call_outlined),
                    onPressed: () => launchUrl(Uri.parse('tel:$phone')),
                  ),
                ..._menuButton(conversation),
              ],
            ),
      body: Column(
        children: [
          if (widget.embedded)
            _EmbeddedChatHeader(
              conversation: conversation,
              fallbackTitle: widget.title,
              phone: phone,
              unread: 0,
              onCall: phone.isEmpty
                  ? null
                  : () => launchUrl(Uri.parse('tel:$phone')),
              menu: _menuButton(conversation),
            ),
          if (state.pendingCount > 0)
            CrmNotice(
              message: state.outboxNeedsHuman.isEmpty
                  ? '${state.pendingCount} acción(es) esperando red. Se enviarán solas sin duplicarse.'
                  : '${state.pendingCount} pendiente(s); ${state.outboxNeedsHuman.length} necesitan revisión.',
              tone: state.outboxNeedsHuman.isEmpty ? p.warning : p.danger,
              icon: Icons.schedule_send_outlined,
            ),
          Expanded(
            child: _loading
                ? const LoadingState(label: 'Cargando mensajes')
                : (_error != null
                      ? ErrorState(message: _error!, onRetry: _load)
                      : (_messages.isEmpty && _queued.isEmpty
                            ? const EmptyState(
                                title: 'Sin mensajes',
                                message:
                                    'Esta conversación todavía no tiene mensajes.',
                                icon: Icons.chat_bubble_outline_rounded,
                              )
                            : ListView.builder(
                                controller: _scroll,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 14,
                                ),
                                itemCount: _messages.length + _queued.length,
                                itemBuilder: (context, index) {
                                  if (index < _messages.length)
                                    return _Bubble(message: _messages[index]);
                                  return _QueuedBubble(
                                    body: _queued[index - _messages.length],
                                  );
                                },
                              ))),
          ),
          if (_uploadLabel != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              color: p.primarySoft,
              child: Row(
                children: [
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: p.primary,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    _uploadLabel!,
                    style: TextStyle(
                      fontSize: 12.5,
                      color: p.primaryDark,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          if (_sugerencia != null)
            ChatLiveSuggestion(
              review: _sugerencia!,
              onApply: _aplicarSugerencia,
              onOpen: _proofread,
              onDismiss: _ignorarSugerencia,
            ),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(6, 8, 10, 10),
              decoration: BoxDecoration(
                color: p.surface,
                border: Border(top: BorderSide(color: p.line)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  PopupMenuButton<String>(
                    tooltip: 'Adjuntar',
                    enabled: !_sending,
                    icon: Icon(
                      Icons.add_circle_outline_rounded,
                      color: p.inkSecondary,
                    ),
                    onSelected: (value) {
                      if (value == 'location' || value == 'share') {
                        _openShareSheet();
                      } else {
                        _pickAndSendMedia(value);
                      }
                    },
                    itemBuilder: (menuContext) => const [
                      PopupMenuItem(
                        value: 'image',
                        child: ListTile(
                          leading: Icon(Icons.image_outlined),
                          title: Text('Foto'),
                        ),
                      ),
                      PopupMenuItem(
                        value: 'document',
                        child: ListTile(
                          leading: Icon(Icons.picture_as_pdf_outlined),
                          title: Text('Documento PDF'),
                        ),
                      ),
                      PopupMenuItem(
                        value: 'audio',
                        child: ListTile(
                          leading: Icon(Icons.mic_none_rounded),
                          title: Text('Nota de voz (archivo)'),
                        ),
                      ),
                      PopupMenuItem(
                        value: 'video',
                        child: ListTile(
                          leading: Icon(Icons.videocam_outlined),
                          title: Text('Video MP4'),
                        ),
                      ),
                      PopupMenuItem(
                        value: 'location',
                        child: ListTile(
                          leading: Icon(Icons.place_outlined),
                          title: Text('Ubicación o datos de pago'),
                        ),
                      ),
                    ],
                  ),
                  IconButton(
                    tooltip: 'Acciones rápidas',
                    onPressed: _sending ? null : _abrirAccionesRapidasMovil,
                    icon: Icon(Icons.touch_app_rounded, color: p.inkSecondary),
                  ),
                  PopupMenuButton<String>(
                    tooltip: 'Insertar emoji',
                    enabled: !_sending,
                    icon: Icon(
                      Icons.emoji_emotions_outlined,
                      color: p.inkSecondary,
                    ),
                    onSelected: (emoji) => insertChatEmoji(_composer, emoji),
                    itemBuilder: (_) => chatEmojis
                        .map(
                          (emoji) => PopupMenuItem(
                            value: emoji,
                            child: Text(
                              emoji,
                              style: const TextStyle(fontSize: 20),
                            ),
                          ),
                        )
                        .toList(),
                  ),
                  Expanded(
                    child: TextField(
                      controller: _composer,
                      minLines: 1,
                      maxLines: 5,
                      textCapitalization: TextCapitalization.sentences,
                      style: TextStyle(fontSize: 14, color: p.ink),
                      decoration: const InputDecoration(
                        hintText: 'Escribe un mensaje',
                        isDense: true,
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 12,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: CrmSpace.touch,
                    width: CrmSpace.touch,
                    child: IconButton.filledTonal(
                      tooltip: 'Grabar nota de voz',
                      onPressed: _sending ? null : _recordVoice,
                      icon: const Icon(Icons.mic_rounded, size: 20),
                      style: IconButton.styleFrom(
                        backgroundColor: p.primarySoft,
                        foregroundColor: p.primary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  SizedBox(
                    height: CrmSpace.touch,
                    width: CrmSpace.touch,
                    child: FilledButton(
                      onPressed: _sending ? null : _send,
                      style: FilledButton.styleFrom(
                        padding: EdgeInsets.zero,
                        backgroundColor: p.whatsapp,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(CrmRadii.md),
                        ),
                      ),
                      child: _sending
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.send_rounded, size: 19),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Diálogo del texto que acompaña a una foto (opcional).
class _PhotoCaptionDialog extends StatefulWidget {
  const _PhotoCaptionDialog();

  @override
  State<_PhotoCaptionDialog> createState() => _PhotoCaptionDialogState();
}

class _PhotoCaptionDialogState extends State<_PhotoCaptionDialog> {
  final _texto = TextEditingController();

  @override
  void dispose() {
    _texto.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Texto del adjunto'),
      content: TextField(
        controller: _texto,
        maxLines: 3,
        decoration: const InputDecoration(hintText: 'Opcional'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Sin texto'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, _texto.text.trim()),
          child: const Text('Enviar'),
        ),
      ],
    );
  }
}

/// Diálogo que pide el texto de cada hueco `{{n}}` de una plantilla.
///
/// Es un `StatefulWidget` para que los `TextEditingController` vivan EXACTAMENTE
/// lo que vive el diálogo: destruirlos al cerrar la ruta provocaba que sus
/// `TextField` los usaran durante la animación de salida.
class _TemplateValuesDialog extends StatefulWidget {
  const _TemplateValuesDialog({
    required this.templateName,
    required this.huecos,
  });

  final String templateName;
  final List<int> huecos;

  @override
  State<_TemplateValuesDialog> createState() => _TemplateValuesDialogState();
}

class _TemplateValuesDialogState extends State<_TemplateValuesDialog> {
  late final Map<int, TextEditingController> _controllers = {
    for (final index in widget.huecos) index: TextEditingController(),
  };

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Datos de «${widget.templateName}»'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final index in widget.huecos)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: TextField(
                  controller: _controllers[index],
                  autofocus: index == widget.huecos.first,
                  decoration: InputDecoration(labelText: 'Dato $index'),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, {
            for (final entry in _controllers.entries)
              '${entry.key}': entry.value.text.trim(),
          }),
          child: const Text('Enviar'),
        ),
      ],
    );
  }
}

class _SheetTitle extends StatelessWidget {
  const _SheetTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.8,
          color: context.crm.inkSecondary,
        ),
      ),
    );
  }
}

/// Burbuja de un mensaje ya guardado en el CRM.
class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final outgoing = message.outgoing;
    return Align(
      alignment: outgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.8,
        ),
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 7),
        decoration: BoxDecoration(
          color: outgoing ? p.bubbleOut : p.bubbleIn,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(CrmRadii.md),
            topRight: const Radius.circular(CrmRadii.md),
            bottomLeft: Radius.circular(outgoing ? CrmRadii.md : 3),
            bottomRight: Radius.circular(outgoing ? 3 : CrmRadii.md),
          ),
          border: Border.all(color: p.border.withValues(alpha: 0.7)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (outgoing && message.author.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  message.author,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                    color: p.inkSecondary,
                  ),
                ),
              ),
            if (message.hasCoordinates)
              _LocationCard(message: message)
            else if (message.hasMedia)
              _MediaCard(message: message)
            else if (message.type != 'text' && message.type.isNotEmpty)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(_iconFor(message.type), size: 14, color: p.inkSecondary),
                  const SizedBox(width: 5),
                  Text(
                    _labelFor(message.type),
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: p.inkSecondary,
                    ),
                  ),
                ],
              ),
            if (message.body.isNotEmpty && !message.hasCoordinates)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  message.body,
                  style: TextStyle(fontSize: 13.8, color: p.ink, height: 1.35),
                ),
              ),
            const SizedBox(height: 3),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  CrmFormat.chatStamp(message.at),
                  style: TextStyle(fontSize: 10.5, color: p.inkSecondary),
                ),
                if (outgoing && message.status.isNotEmpty) ...[
                  const SizedBox(width: 5),
                  Icon(
                    message.status == 'failed'
                        ? Icons.error_outline_rounded
                        : Icons.done_all_rounded,
                    size: 12,
                    color: message.status == 'failed'
                        ? p.danger
                        : p.inkSecondary,
                  ),
                ],
              ],
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

  static String _labelFor(String type) => switch (type) {
    'image' => 'Foto',
    'audio' => 'Nota de voz',
    'voice' => 'Nota de voz',
    'video' => 'Vídeo',
    'document' => 'Documento',
    'location' => 'Ubicación',
    'sticker' => 'Sticker',
    _ => 'Mensaje',
  };
}

/// Adjunto privado del hilo; el audio se reproduce sin salir de la app.
class _MediaCard extends StatefulWidget {
  const _MediaCard({required this.message});

  final ChatMessage message;

  @override
  State<_MediaCard> createState() => _MediaCardState();
}

class _MediaCardState extends State<_MediaCard> {
  Future<ApiFile>? _future;

  @override
  void initState() {
    super.initState();
    if (widget.message.mediaId.isNotEmpty) _start();
  }

  void _start() {
    final repo = CrmScope.of(context, listen: false).repository;
    _future = repo.mediaBytes(widget.message.mediaId);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final type = widget.message.type;
    if (_future == null) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.attachment_rounded, size: 14, color: p.inkSecondary),
          const SizedBox(width: 5),
          Text(
            'Adjunto no disponible',
            style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
          ),
        ],
      );
    }
    return FutureBuilder<ApiFile>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return SizedBox(
            height: 120,
            width: 180,
            child: Center(
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: p.primary,
                ),
              ),
            ),
          );
        }
        if (snapshot.hasError || snapshot.data == null) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline_rounded, size: 14, color: p.danger),
              const SizedBox(width: 5),
              Text(
                'No pudimos abrir el adjunto',
                style: TextStyle(fontSize: 11.5, color: p.danger),
              ),
            ],
          );
        }
        final file = snapshot.data!;
        if (type == 'image' || file.isImage) {
          return ClipRRect(
            borderRadius: BorderRadius.circular(CrmRadii.sm),
            child: Image.memory(
              Uint8List.fromList(file.bytes),
              width: 200,
              fit: BoxFit.cover,
              errorBuilder: (context, error, stack) => Text(
                'Imagen no válida',
                style: TextStyle(fontSize: 11.5, color: p.danger),
              ),
            ),
          );
        }
        if (type == 'video' || file.contentType.startsWith('video/')) {
          return ChatInlineVideo(file: file, maxWidth: 230);
        }
        if (type == 'audio' ||
            type == 'voice' ||
            file.contentType.startsWith('audio/')) {
          return ChatInlineAudio(file: file, maxWidth: 220);
        }
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              type == 'video'
                  ? Icons.videocam_outlined
                  : file.isPdf
                  ? Icons.picture_as_pdf_outlined
                  : Icons.audiotrack_rounded,
              size: 18,
              color: p.primary,
            ),
            const SizedBox(width: 8),
            Text(
              type == 'video'
                  ? 'Video'
                  : file.isPdf
                  ? 'Documento PDF'
                  : 'Nota de voz',
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: p.ink,
              ),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: () => FileOpener.saveAndOpen(file),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 32),
              ),
              child: const Text('Abrir', style: TextStyle(fontSize: 12)),
            ),
          ],
        );
      },
    );
  }
}

class _LocationCard extends StatelessWidget {
  const _LocationCard({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final lat = message.latitude!;
    final lng = message.longitude!;
    return InkWell(
      onTap: () => showDialog<void>(
        context: context,
        builder: (dialogContext) {
          final size = MediaQuery.sizeOf(dialogContext);
          return Dialog(
            child: SizedBox(
              width: size.width * 0.9,
              height: size.height * 0.7,
              child: Column(
                children: [
                  ListTile(
                    title: const Text('Ubicación en el mapa'),
                    trailing: IconButton(
                      tooltip: 'Cerrar mapa',
                      onPressed: () => Navigator.pop(dialogContext),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, box) => ChatMapPreview(
                        lat: lat,
                        lng: lng,
                        width: box.maxWidth,
                        height: box.maxHeight,
                        interactive: true,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () => launchUrl(
                      Uri.parse('https://maps.google.com/?q=$lat,$lng'),
                      mode: LaunchMode.externalApplication,
                    ),
                    icon: const Icon(Icons.open_in_new_rounded),
                    label: const Text('Abrir en Google Maps'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          ChatMapPreview(lat: lat, lng: lng, width: 230, height: 130),
          const SizedBox(height: 6),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.place_outlined, size: 17, color: p.primary),
              const SizedBox(width: 5),
              Text(
                '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}',
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w700,
                  color: p.ink,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _QueuedBubble extends StatelessWidget {
  const _QueuedBubble({required this.body});

  final String body;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 7),
        decoration: BoxDecoration(
          color: p.bubbleOut,
          borderRadius: BorderRadius.circular(CrmRadii.md),
          border: Border.all(color: p.warning.withValues(alpha: 0.5)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              body,
              style: TextStyle(fontSize: 13.8, color: p.ink, height: 1.35),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.schedule_rounded, size: 12, color: p.warning),
                const SizedBox(width: 4),
                Text(
                  'Pendiente de enviar',
                  style: TextStyle(
                    fontSize: 10.5,
                    color: p.warning,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Encabezado del hilo cuando se usa como panel central (escritorio): mismo
/// patrón que la barra del POS, con avatar, nombre, estado real y acciones.
class _EmbeddedChatHeader extends StatelessWidget {
  const _EmbeddedChatHeader({
    required this.conversation,
    required this.fallbackTitle,
    required this.phone,
    required this.unread,
    required this.menu,
    this.onCall,
  });

  final Conversation? conversation;
  final String fallbackTitle;
  final String phone;
  final int unread;
  final List<Widget> menu;
  final VoidCallback? onCall;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final name = conversation?.name ?? fallbackTitle;
    final stage = (conversation?.stage ?? '').toLowerCase();
    final resolved = conversation?.isResolved ?? false;
    return Container(
      height: 60,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: p.line)),
      ),
      child: Row(
        children: [
          CrmAvatar(label: name, size: 36),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w800,
                    color: p.ink,
                  ),
                ),
                Text(
                  [
                    if (phone.isNotEmpty) phone,
                    if (stage.isNotEmpty) stage,
                    // Solo se muestra lo que el backend dice de verdad.
                    if (resolved) 'finalizada',
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w500,
                    color: p.inkSecondary,
                  ),
                ),
              ],
            ),
          ),
          if (onCall != null)
            IconButton(
              tooltip: 'Llamar',
              icon: const Icon(Icons.call_outlined, size: 20),
              onPressed: onCall,
            ),
          ...menu,
        ],
      ),
    );
  }
}

/// Acceso compacto a las acciones comerciales del hilo.
class _ChatFab extends StatefulWidget {
  const _ChatFab({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_ChatFab> createState() => _ChatFabState();
}

class _ChatFabState extends State<_ChatFab> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: widget.onTap,
          child: AnimatedScale(
            scale: _hovered ? 1.06 : 1,
            duration: const Duration(milliseconds: 130),
            child: Container(
              width: 44,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.panelBg,
                shape: BoxShape.circle,
                border: Border.all(color: c.divider),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: c.dark ? 0.40 : 0.12),
                    blurRadius: 14,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Icon(widget.icon, size: 20, color: c.textPrimary),
            ),
          ),
        ),
      ),
    );
  }
}
