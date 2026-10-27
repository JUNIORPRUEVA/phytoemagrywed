import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'desktop/chat_composer.dart';
import 'desktop/chat_desktop_theme.dart';
import 'desktop/chat_header.dart';
import 'desktop/chat_thread.dart';
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

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  final _threadSearch = TextEditingController();
  bool _searching = false;
  String _threadQuery = '';
  List<ChatMessage> _messages = const [];
  final List<String> _queued = <String>[];
  bool _loading = true;
  bool _sending = false;
  String? _error;
  String? _uploadLabel;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    _threadSearch.dispose();
    super.dispose();
  }

  CrmState get _state => CrmScope.of(context, listen: false);
  Conversation? get _conversation => _state.conversationById(widget.conversationId);

  Future<void> _load() async {
    final state = _state;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final messages = await state.repository.messages(widget.conversationId);
      if (!mounted) return;
      setState(() {
        _messages = messages;
        _loading = false;
        if (state.pendingCount == 0) _queued.clear();
      });
      await state.repository.markRead(widget.conversationId).catchError((_) {});
      _jumpToBottom();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 180), curve: Curves.easeOut);
    });
  }

  // ------------------------------------------------------------------- envíos
  Future<void> _send() async {
    final body = _composer.text.trim();
    if (body.isEmpty || _sending) return;
    final state = _state;
    final operationKey = newOperationKey('msg');
    setState(() => _sending = true);
    try {
      await state.repository.sendMessage(widget.conversationId, body, operationKey: operationKey);
      _composer.clear();
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 0) {
        await state.enqueueMessage(widget.conversationId, body, operationKey: operationKey);
        if (!mounted) return;
        setState(() {
          _queued.add(body);
          _composer.clear();
        });
        _jumpToBottom();
        crmToast(context, 'Sin conexión: el mensaje se enviará cuando vuelva la red (sin duplicarse).');
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
        crmToast(context, 'No podemos confirmar si la nota llegó. Revísalo en el hilo antes de reintentar.');
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
      _ => const ['m4a', 'mp3', 'ogg', 'opus', 'aac', 'wav'],
    };
    final picked = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: allowed,
      withData: true,
    );
    if (picked == null || picked.files.isEmpty || !mounted) return;
    final file = picked.files.first;
    final bytes = file.bytes;
    if (bytes == null) {
      crmToast(context, 'No pudimos leer el archivo.');
      return;
    }
    final caption = kind == 'image' ? await _askCaption() : null;
    if (!mounted) return;

    final state = _state;
    final operationKey = newOperationKey(kind == 'image' ? 'img' : kind == 'document' ? 'doc' : 'voc');
    setState(() {
      _sending = true;
      _uploadLabel = kind == 'image' ? 'Enviando foto…' : kind == 'document' ? 'Enviando PDF…' : 'Enviando nota de voz…';
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
          message: '${error.message}\n\nRevisa el hilo antes de volver a enviarlo: el CRM evita duplicados por sí mismo mientras use la misma operación.',
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

  Future<String?> _askCaption() async {
    final controller = TextEditingController();
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Texto de la foto'),
        content: TextField(
          controller: controller,
          maxLines: 3,
          decoration: const InputDecoration(hintText: 'Opcional'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Sin texto')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Enviar')),
        ],
      ),
    );
    final value = controller.text.trim();
    controller.dispose();
    if (result != true) return null;
    return value;
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
    if (locations.isEmpty && banks.isEmpty && catalogs.isEmpty) {
      crmToast(context, 'No hay datos para compartir. Se configuran en el panel web.');
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            if (locations.isNotEmpty) const _SheetTitle('Ubicaciones'),
            for (final row in locations)
              ListTile(
                leading: const Icon(Icons.place_outlined),
                title: Text(str(row['name'], 'Ubicación')),
                subtitle: Text(str(row['address'], '')),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _sendLocation(str(row['id']));
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
                      if (str(row['type']).isNotEmpty) 'Tipo: ${str(row['type'])}',
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
                  _sendText(str(row['message']).isEmpty ? str(row['url']) : '${str(row['message'])}\n${str(row['url'])}');
                },
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _sendLocation(String locationId) async {
    final state = _state;
    final operationKey = newOperationKey('loc');
    setState(() => _sending = true);
    try {
      await state.repository.sendLocation(widget.conversationId, locationId: locationId, operationKey: operationKey);
      await _load();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendText(String body) async {
    if (body.trim().isEmpty) return;
    _composer.text = body;
    await _send();
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
                subtitle: Text(str(template['category'], str(template['language'], ''))),
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
      for (final match in RegExp(r'\{\{\s*(\d+)\s*\}\}').allMatches(str(picked['body'])))
        if (int.tryParse(match.group(1) ?? '') != null) int.parse(match.group(1)!),
    }.toList()
      ..sort();
    Map<String, dynamic>? values;
    if (huecos.isNotEmpty) {
      values = await _askTemplateValues(name, huecos);
      if (values == null || !mounted) return;
    }
    final operationKey = newOperationKey('tpl');
    setState(() => _sending = true);
    try {
      await state.repository.sendTemplate(widget.conversationId, name, operationKey: operationKey, values: values);
      await _load();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Pide el texto de cada hueco de la plantilla. Devuelve `null` si se cancela.
  Future<Map<String, dynamic>?> _askTemplateValues(String templateName, List<int> huecos) async {
    final controllers = {for (final index in huecos) index: TextEditingController()};
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Datos de «$templateName»'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final index in huecos)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: TextField(
                    controller: controllers[index],
                    autofocus: index == huecos.first,
                    decoration: InputDecoration(labelText: 'Dato $index'),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, {
              for (final entry in controllers.entries) '${entry.key}': entry.value.text.trim(),
            }),
            child: const Text('Enviar'),
          ),
        ],
      ),
    );
    for (final controller in controllers.values) {
      controller.dispose();
    }
    return result;
  }

  Future<void> _toggleResolved() async {
    final state = _state;
    final resolved = !(_conversation?.isResolved ?? false);
    try {
      await state.repository.setResolved(widget.conversationId, resolved);
      await state.refresh(quiet: true);
      if (mounted) crmToast(context, resolved ? 'Conversación finalizada.' : 'Conversación reabierta.');
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 0) {
        await state.enqueueResolved(widget.conversationId, resolved: resolved);
        if (mounted) crmToast(context, 'Sin conexión: se aplicará cuando vuelva la red.');
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
          await state.repository.requestConversationAssignment(widget.conversationId);
          if (mounted) crmToast(context, 'Pedido enviado a administración.');
        case 'take':
        case 'release':
          await state.repository.assignConversation(widget.conversationId, action: action);
          await state.refresh(quiet: true);
          if (mounted) crmToast(context, action == 'take' ? 'Conversación tomada.' : 'Conversación liberada.');
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
                      leading: CrmAvatar(label: str(user['display_name'], str(user['username']))),
                      title: Text(str(user['display_name'], str(user['username'], 'Usuario'))),
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
    final conversation = _conversation;
    final phone = (conversation?.phone ?? '').trim();
    final stage = (conversation?.stage ?? '').toLowerCase();
    final subtitle = [
      if (phone.isNotEmpty) phone,
      if (stage.isNotEmpty) stage,
      if (conversation?.isResolved == true) 'finalizada',
    ].join(' · ');

    final dark = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      fontFamily: ChatDesktopMetrics.fontFamily,
      colorScheme: const ColorScheme.dark(
        primary: ChatDesktopColors.accent,
        surface: ChatDesktopColors.fieldBg,
        onSurface: ChatDesktopColors.textPrimary,
      ),
      popupMenuTheme: const PopupMenuThemeData(color: ChatDesktopColors.fieldBg),
      dialogTheme: const DialogThemeData(backgroundColor: ChatDesktopColors.fieldBg),
    );

    final Widget body;
    if (_loading) {
      body = const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: ChatDesktopColors.accent),
        ),
      );
    } else if (_error != null) {
      body = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 30, color: ChatDesktopColors.danger),
            const SizedBox(height: 10),
            Text(_error!, textAlign: TextAlign.center, style: ChatDesktopText.rowPreview),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _load,
              child: const Text('Reintentar', style: TextStyle(color: ChatDesktopColors.accent)),
            ),
          ],
        ),
      );
    } else {
      body = ChatThread(messages: _messages, queued: _queued, search: _threadQuery);
    }

    return Theme(
      data: dark,
      child: Column(
        children: [
          ChatHeader(
            name: conversation?.name ?? widget.title,
            subtitle: subtitle,
            menu: _menuButton(conversation),
            onCall: phone.isEmpty ? null : () => launchUrl(Uri.parse('tel:$phone')),
            searching: _searching,
            searchController: _threadSearch,
            onSearchChanged: (value) => setState(() => _threadQuery = value),
            onToggleSearch: () => setState(() {
              _searching = !_searching;
              if (!_searching) {
                _threadSearch.clear();
                _threadQuery = '';
              }
            }),
          ),
          Expanded(child: body),
          ChatComposer(
            controller: _composer,
            sending: _sending,
            uploadLabel: _uploadLabel,
            onSend: () => _send(),
            onAttach: (kind) => _pickAndSendMedia(kind),
            onShareLocation: () => _openShareSheet(),
            onRecord: () => _recordVoice(),
          ),
        ],
      ),
    );
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
            PopupMenuItem(value: 'resolver', child: Text((conversation?.isResolved ?? false) ? 'Reabrir' : 'Finalizar')),
            const PopupMenuItem(value: 'asignar', child: Text('Asignación')),
            const PopupMenuItem(value: 'plantilla', child: Text('Plantilla de WhatsApp')),
            const PopupMenuItem(value: 'compartir', child: Text('Compartir datos de pago/ubicación')),
            const PopupMenuItem(value: 'refrescar', child: Text('Recargar mensajes')),
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
            Text(conversation?.name ?? widget.title, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, color: p.ink)),
            Text(
              [
                if (phone.isNotEmpty) phone,
                if ((conversation?.stage ?? '').isNotEmpty) conversation!.stage.toLowerCase(),
              ].join(' · '),
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w500, color: p.inkSecondary),
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
              onCall: phone.isEmpty ? null : () => launchUrl(Uri.parse('tel:$phone')),
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
                            message: 'Esta conversación todavía no tiene mensajes.',
                            icon: Icons.chat_bubble_outline_rounded,
                          )
                        : ListView.builder(
                            controller: _scroll,
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                            itemCount: _messages.length + _queued.length,
                            itemBuilder: (context, index) {
                              if (index < _messages.length) return _Bubble(message: _messages[index]);
                              return _QueuedBubble(body: _queued[index - _messages.length]);
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
                  SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: p.primary)),
                  const SizedBox(width: 10),
                  Text(_uploadLabel!, style: TextStyle(fontSize: 12.5, color: p.primaryDark, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(6, 8, 10, 10),
              decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  PopupMenuButton<String>(
                    tooltip: 'Adjuntar',
                    enabled: !_sending,
                    icon: Icon(Icons.add_circle_outline_rounded, color: p.inkSecondary),
                    onSelected: (value) {
                      if (value == 'location' || value == 'share') {
                        _openShareSheet();
                      } else {
                        _pickAndSendMedia(value);
                      }
                    },
                    itemBuilder: (menuContext) => const [
                      PopupMenuItem(value: 'image', child: ListTile(leading: Icon(Icons.image_outlined), title: Text('Foto'))),
                      PopupMenuItem(value: 'document', child: ListTile(leading: Icon(Icons.picture_as_pdf_outlined), title: Text('Documento PDF'))),
                      PopupMenuItem(value: 'audio', child: ListTile(leading: Icon(Icons.mic_none_rounded), title: Text('Nota de voz (archivo)'))),
                      PopupMenuItem(value: 'location', child: ListTile(leading: Icon(Icons.place_outlined), title: Text('Ubicación o datos de pago'))),
                    ],
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
                        contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.md)),
                      ),
                      child: _sending
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
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

class _SheetTitle extends StatelessWidget {  const _SheetTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: context.crm.inkSecondary),
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
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
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
                child: Text(message.author, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: p.inkSecondary)),
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
                  Text(_labelFor(message.type), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: p.inkSecondary)),
                ],
              ),
            if (message.body.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(message.body, style: TextStyle(fontSize: 13.8, color: p.ink, height: 1.35)),
              ),
            const SizedBox(height: 3),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(CrmFormat.chatStamp(message.at), style: TextStyle(fontSize: 10.5, color: p.inkSecondary)),
                if (outgoing && message.status.isNotEmpty) ...[
                  const SizedBox(width: 5),
                  Icon(
                    message.status == 'failed' ? Icons.error_outline_rounded : Icons.done_all_rounded,
                    size: 12,
                    color: message.status == 'failed' ? p.danger : p.inkSecondary,
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

/// Adjunto: la imagen se ve dentro del hilo; el PDF y el audio se abren con el
/// visor del sistema. Los bytes se piden CON sesión (no hay URL pública).
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
          Text('Adjunto no disponible', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
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
            child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: p.primary))),
          );
        }
        if (snapshot.hasError || snapshot.data == null) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline_rounded, size: 14, color: p.danger),
              const SizedBox(width: 5),
              Text('No pudimos abrir el adjunto', style: TextStyle(fontSize: 11.5, color: p.danger)),
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
              errorBuilder: (context, error, stack) => Text('Imagen no válida', style: TextStyle(fontSize: 11.5, color: p.danger)),
            ),
          );
        }
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(file.isPdf ? Icons.picture_as_pdf_outlined : Icons.audiotrack_rounded, size: 18, color: p.primary),
            const SizedBox(width: 8),
            Text(
              file.isPdf ? 'Documento PDF' : 'Nota de voz',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.ink),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: () => FileOpener.saveAndOpen(file),
              style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8), minimumSize: const Size(0, 32)),
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
      onTap: () => launchUrl(
        Uri.parse('https://maps.google.com/?q=$lat,$lng'),
        mode: LaunchMode.externalApplication,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.place_outlined, size: 18, color: p.primary),
          const SizedBox(width: 8),
          Text(
            '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}',
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.ink),
          ),
          const SizedBox(width: 6),
          Icon(Icons.open_in_new_rounded, size: 14, color: p.inkSecondary),
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
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 7),
        decoration: BoxDecoration(
          color: p.bubbleOut,
          borderRadius: BorderRadius.circular(CrmRadii.md),
          border: Border.all(color: p.warning.withValues(alpha: 0.5)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(body, style: TextStyle(fontSize: 13.8, color: p.ink, height: 1.35)),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.schedule_rounded, size: 12, color: p.warning),
                const SizedBox(width: 4),
                Text('Pendiente de enviar', style: TextStyle(fontSize: 10.5, color: p.warning, fontWeight: FontWeight.w600)),
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
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: p.ink),
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
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w500, color: p.inkSecondary),
                ),
              ],
            ),
          ),
          if (onCall != null)
            IconButton(tooltip: 'Llamar', icon: const Icon(Icons.call_outlined, size: 20), onPressed: onCall),
          ...menu,
        ],
      ),
    );
  }
}
