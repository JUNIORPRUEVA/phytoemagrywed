import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../pedidos/pedido_detail_screen.dart';

/// Usa los mismos tickets operativos y el snapshot del Supervisor IA del PWA.
/// El hilo distingue WhatsApp real de las notas que nunca salieron al repartidor.
class SupervisorScreen extends StatefulWidget {
  const SupervisorScreen({super.key});

  @override
  State<SupervisorScreen> createState() => _SupervisorScreenState();
}

class _SupervisorScreenState extends State<SupervisorScreen> {
  static const _filters = <(String, String)>[
    ('todas', 'Próximos'),
    ('revision', 'Revisión'),
    ('sin_iniciar', 'Sin iniciar'),
    ('en_camino', 'En camino'),
    ('atrasados', 'Atrasados'),
    ('incidencias', 'Incidencias'),
    ('pospuestos', 'Pospuestos'),
    ('confirmadas', 'Confirmadas'),
  ];

  Timer? _timer;
  Map<String, dynamic>? _snapshot;
  List<Map<String, dynamic>> _chats = const [];
  List<Map<String, dynamic>> _messages = const [];
  String? _selectedTicket;
  String? _error;
  String? _chatsError;
  String? _threadError;
  bool _loading = true;
  bool _threadLoading = false;
  bool _refreshing = false;
  int _view = 0;
  String _bucket = 'todas';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reload());
    _timer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => _reload(silent: true),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    if (!mounted || _refreshing) return;
    _refreshing = true;
    if (!silent) setState(() => _loading = _snapshot == null);
    final repository = CrmScope.of(context, listen: false).repository;
    try {
      final data = await repository.deliverySupervisor();
      if (mounted)
        setState(() {
          _snapshot = data;
          _error = null;
        });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
    try {
      final chats = await repository.deliverySupervisorChats();
      if (!mounted) return;
      setState(() {
        _chats = chats;
        _chatsError = null;
        if (_selectedTicket != null &&
            !chats.any((row) => str(row['ticketId']) == _selectedTicket)) {
          _selectedTicket = null;
          _messages = const [];
        }
      });
      if (_selectedTicket != null)
        await _loadThread(_selectedTicket!, silent: true);
    } on ApiException catch (error) {
      if (mounted) setState(() => _chatsError = error.message);
    } finally {
      _refreshing = false;
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadThread(String ticketId, {bool silent = false}) async {
    if (!silent)
      setState(() {
        _selectedTicket = ticketId;
        _threadLoading = true;
        _threadError = null;
        _messages = const [];
      });
    try {
      final data = await CrmScope.of(
        context,
        listen: false,
      ).repository.deliverySupervisorChat(ticketId);
      if (!mounted || _selectedTicket != ticketId) return;
      setState(() {
        _messages = listv(data['messages']);
        _threadError = null;
      });
    } on ApiException catch (error) {
      if (mounted && _selectedTicket == ticketId)
        setState(() => _threadError = error.message);
    } finally {
      if (mounted && _selectedTicket == ticketId)
        setState(() => _threadLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final data = _snapshot;
    final counts = mapv(data?['counts']);
    final enabled = data?['enabled'] == true;
    return Column(
      children: [
        Container(
          height: 42,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Icon(Icons.smart_toy_outlined, size: 19, color: p.primary),
              const SizedBox(width: 8),
              Text(
                'Supervisor de entregas',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: p.ink,
                ),
              ),
              const SizedBox(width: 12),
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: enabled ? p.success : p.inkSecondary,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 5),
              Text(
                enabled ? 'Activo' : 'Apagado',
                style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
              ),
              const Spacer(),
              if (data != null && str(data['last_run_at']).isNotEmpty)
                Text(
                  'Última revisión ${CrmFormat.ago(data['last_run_at'])}',
                  style: TextStyle(fontSize: 11, color: p.inkSecondary),
                ),
              IconButton(
                tooltip: 'Actualizar',
                onPressed: () => _reload(),
                icon: const Icon(Icons.refresh_rounded, size: 19),
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
        Container(
          height: 38,
          color: p.surface,
          child: Row(
            children: [
              _ViewTab(
                label: 'Conversaciones',
                count: _chats.length,
                selected: _view == 0,
                onTap: () => setState(() => _view = 0),
              ),
              _ViewTab(
                label: 'Pedidos',
                count: intv(counts['sin_iniciar']) + intv(counts['en_camino']),
                selected: _view == 1,
                onTap: () => setState(() => _view = 1),
              ),
              _ViewTab(
                label: 'Actividad',
                count: listv(data?['activity']).length,
                selected: _view == 2,
                onTap: () => setState(() => _view = 2),
              ),
            ],
          ),
        ),
        if (_error != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
            color: p.warning.withValues(alpha: 0.1),
            child: Text(
              _error!,
              style: TextStyle(fontSize: 11.5, color: p.warning),
            ),
          ),
        Expanded(
          child: _loading && data == null
              ? const Center(child: CircularProgressIndicator())
              : switch (_view) {
                  0 => _chatView(context),
                  1 => _ordersView(context, data),
                  _ => _activityView(context, data),
                },
        ),
      ],
    );
  }

  Widget _chatView(BuildContext context) {
    final p = context.crm;
    if (_chatsError != null && _chats.isEmpty) {
      return Center(
        child: Text(_chatsError!, style: TextStyle(color: p.inkSecondary)),
      );
    }
    if (_chats.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 28, color: p.inkSecondary),
            const SizedBox(height: 8),
            Text(
              'Aún no hay conversaciones de reparto',
              style: TextStyle(fontSize: 13, color: p.inkSecondary),
            ),
          ],
        ),
      );
    }
    return LayoutBuilder(
      builder: (context, limits) {
        final narrow = limits.maxWidth < 640;
        final showThread = _selectedTicket != null;
        return Row(
          children: [
            if (!narrow || !showThread)
              SizedBox(
                width: narrow
                    ? limits.maxWidth
                    : (limits.maxWidth * 0.29).clamp(250.0, 340.0),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: p.surface,
                    border: Border(right: BorderSide(color: p.border)),
                  ),
                  child: ListView.builder(
                    itemCount: _chats.length,
                    itemBuilder: (context, index) {
                      final row = _chats[index];
                      final id = str(row['ticketId']);
                      return InkWell(
                        onTap: () => _loadThread(id),
                        child: Container(
                          height: 70,
                          padding: const EdgeInsets.fromLTRB(12, 5, 10, 5),
                          decoration: BoxDecoration(
                            color: id == _selectedTicket
                                ? p.primarySoft.withValues(alpha: 0.55)
                                : null,
                            border: Border(
                              bottom: BorderSide(
                                color: p.border.withValues(alpha: 0.7),
                              ),
                            ),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      str(
                                        row['orderNumber'],
                                        str(row['number'], 'Pedido'),
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 12.5,
                                        fontWeight: FontWeight.w800,
                                        color: p.ink,
                                      ),
                                    ),
                                  ),
                                  Text(
                                    CrmFormat.ago(row['lastActivity']),
                                    style: TextStyle(
                                      fontSize: 10.5,
                                      color: p.inkSecondary,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '${str(row['courierName'], 'Repartidor')} · ${str(row['customerName'], 'Cliente')}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: p.inkSecondary,
                                ),
                              ),
                              Text(
                                str(row['lastPreview'], 'Sin mensajes todavía'),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: p.inkSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            if (!narrow || showThread)
              Expanded(child: _thread(context, narrow: narrow)),
          ],
        );
      },
    );
  }

  Widget _thread(BuildContext context, {required bool narrow}) {
    final p = context.crm;
    final selected = _chats
        .where((row) => str(row['ticketId']) == _selectedTicket)
        .firstOrNull;
    if (selected == null) {
      return Center(
        child: Text(
          'Selecciona un pedido para ver la conversación',
          style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
        ),
      );
    }
    final messages = _messages.reversed.toList();
    return Column(
      children: [
        Container(
          height: 47,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              if (narrow)
                IconButton(
                  onPressed: () => setState(() => _selectedTicket = null),
                  tooltip: 'Volver a conversaciones',
                  icon: const Icon(Icons.arrow_back_rounded, size: 19),
                ),
              Icon(Icons.delivery_dining_outlined, size: 20, color: p.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      str(selected['orderNumber'], 'Pedido'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w800,
                        color: p.ink,
                      ),
                    ),
                    Text(
                      str(selected['courierName'], 'Repartidor'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: p.inkSecondary),
                    ),
                  ],
                ),
              ),
              if (str(selected['orderId']).isNotEmpty)
                IconButton(
                  tooltip: 'Ver pedido',
                  icon: const Icon(Icons.open_in_new_rounded, size: 18),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          PedidoDetailScreen(orderId: str(selected['orderId'])),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: _threadLoading && messages.isEmpty
              ? const Center(child: CircularProgressIndicator())
              : _threadError != null && messages.isEmpty
              ? Center(
                  child: Text(
                    _threadError!,
                    style: TextStyle(color: p.inkSecondary),
                  ),
                )
              : messages.isEmpty
              ? Center(
                  child: Text(
                    'Este pedido todavía no tiene mensajes',
                    style: TextStyle(color: p.inkSecondary),
                  ),
                )
              : ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 12,
                  ),
                  itemCount: messages.length,
                  itemBuilder: (context, index) =>
                      _MessageBubble(message: messages[index]),
                ),
        ),
      ],
    );
  }

  Widget _ordersView(BuildContext context, Map<String, dynamic>? data) {
    final p = context.crm;
    final counts = mapv(data?['counts']);
    final buckets = mapv(data?['buckets']);
    final rows = _bucket == 'todas'
        ? listv(data?['upcoming'])
        : listv(buckets[_bucket]);
    return Column(
      children: [
        SizedBox(
          height: 43,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            children: [
              for (final filter in _filters)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    visualDensity: VisualDensity.compact,
                    label: Text(
                      '${filter.$2} ${_bucket == 'todas' && filter.$1 == 'todas' ? listv(data?['upcoming']).length : intv(counts[filter.$1])}',
                      style: const TextStyle(fontSize: 11),
                    ),
                    selected: _bucket == filter.$1,
                    onSelected: (_) => setState(() => _bucket = filter.$1),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: rows.isEmpty
              ? Center(
                  child: Text(
                    'No hay pedidos en esta vista',
                    style: TextStyle(color: p.inkSecondary),
                  ),
                )
              : ListView.builder(
                  itemCount: rows.length,
                  itemBuilder: (context, index) {
                    final row = rows[index];
                    final orderId = str(row['id']);
                    return ListTile(
                      dense: true,
                      visualDensity: const VisualDensity(vertical: -2),
                      title: Text(
                        '${str(row['order_number'], orderId)} · ${str(row['customer_name'], 'Cliente')}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: p.ink,
                        ),
                      ),
                      subtitle: Text(
                        '${str(mapv(row['responsible'])['name'], 'Sin repartidor')} · ${str(row['next_action'])}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                      ),
                      trailing: Icon(
                        Icons.chevron_right_rounded,
                        size: 19,
                        color: p.inkSecondary,
                      ),
                      onTap: orderId.isEmpty
                          ? null
                          : () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) =>
                                    PedidoDetailScreen(orderId: orderId),
                              ),
                            ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _activityView(BuildContext context, Map<String, dynamic>? data) {
    final p = context.crm;
    final rows = listv(data?['activity']);
    if (rows.isEmpty)
      return Center(
        child: Text(
          'Sin actividad registrada',
          style: TextStyle(color: p.inkSecondary),
        ),
      );
    return ListView.builder(
      itemCount: rows.length,
      itemBuilder: (context, index) {
        final row = rows[index];
        return ListTile(
          dense: true,
          visualDensity: const VisualDensity(vertical: -2),
          leading: Icon(Icons.timeline_rounded, size: 19, color: p.primary),
          title: Text(
            str(row['detail'], str(row['kind'], 'Actividad')),
            style: TextStyle(fontSize: 12.2, color: p.ink),
          ),
          subtitle: Text(
            '${str(row['order_id'])} · ${CrmFormat.ago(row['created_at'])}',
            style: TextStyle(fontSize: 11, color: p.inkSecondary),
          ),
        );
      },
    );
  }
}

class _ViewTab extends StatelessWidget {
  const _ViewTab({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return InkWell(
      onTap: onTap,
      child: Container(
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: selected ? p.primary : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Text(
          '$label  $count',
          style: TextStyle(
            fontSize: 11.8,
            color: selected ? p.primary : p.inkSecondary,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
          ),
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});
  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final meta = mapv(message['meta']);
    final channel = str(meta['channel']);
    final external = const {'whatsapp', 'template', 'text'}.contains(channel);
    final inbound = external && str(meta['direction']) == 'inbound';
    final system = str(meta['direction']) == 'system';
    final agent = str(message['authorType']) == 'agent';
    final label = inbound
        ? 'Recibido · repartidor'
        : external
        ? 'WhatsApp · ${str(meta['status'], 'pendiente')}'
        : system
        ? 'Sistema'
        : 'Nota interna · no enviada';
    return Align(
      alignment: inbound ? Alignment.centerLeft : Alignment.centerRight,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 540),
        child: Container(
          margin: const EdgeInsets.only(bottom: 9),
          padding: const EdgeInsets.fromLTRB(11, 8, 11, 8),
          decoration: BoxDecoration(
            color: inbound
                ? p.surface
                : agent
                ? p.primarySoft
                : p.surfaceMuted,
            border: Border.all(color: p.border),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${str(message['authorName'], agent ? 'Supervisor IA' : 'Equipo')} · $label',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700,
                  color: inbound ? p.success : p.primary,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                str(message['body']),
                style: TextStyle(fontSize: 12.5, color: p.ink),
              ),
              const SizedBox(height: 4),
              Text(
                CrmFormat.ago(message['createdAt']),
                style: TextStyle(fontSize: 10.5, color: p.inkSecondary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
