import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import 'crm_ui.dart';

/// Carga un futuro y pinta cargando / error / vacío / contenido.
///
/// Así todas las pantallas que piden datos al servidor se comportan igual: una
/// rueda, un botón de reintentar y el vacío con su explicación.
class RemoteLoader<T> extends StatefulWidget {
  const RemoteLoader({
    super.key,
    required this.load,
    required this.builder,
    this.loadingLabel,
    this.emptyCheck,
    this.emptyBuilder,
  });

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, VoidCallback reload) builder;
  final String? loadingLabel;
  final bool Function(T data)? emptyCheck;
  final WidgetBuilder? emptyBuilder;

  @override
  State<RemoteLoader<T>> createState() => _RemoteLoaderState<T>();
}

class _RemoteLoaderState<T> extends State<RemoteLoader<T>> {
  T? _data;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await widget.load();
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'No pudimos cargar esta pantalla.';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _data == null) return LoadingState(label: widget.loadingLabel);
    if (_error != null && _data == null) return ErrorState(message: _error!, onRetry: _run);
    final data = _data;
    if (data == null) return ErrorState(message: 'Sin datos.', onRetry: _run);
    if (widget.emptyCheck?.call(data) == true && widget.emptyBuilder != null) {
      return RefreshIndicator(onRefresh: _run, child: ListView(children: [widget.emptyBuilder!(context)]));
    }
    return RefreshIndicator(onRefresh: _run, child: widget.builder(context, data, _run));
  }
}

/// Fila genérica para listas del servidor cuyo esquema no está tipado todavía
/// (cotizaciones, recogidas, solicitudes, agentes…). Busca el título y el
/// subtítulo entre los campos habituales en lugar de inventarse uno.
class MapListTile extends StatelessWidget {
  const MapListTile({
    super.key,
    required this.data,
    this.titleKeys = const ['name', 'title', 'customer_name', 'client', 'phone', 'id'],
    this.subtitleKeys = const ['description', 'notes', 'address', 'status', 'created_at', 'date'],
    this.trailingKeys = const ['total', 'amount', 'price'],
    this.leadingIcon = Icons.chevron_right_rounded,
    this.onTap,
  });

  final Map<String, dynamic> data;
  final List<String> titleKeys;
  final List<String> subtitleKeys;
  final List<String> trailingKeys;
  final IconData leadingIcon;
  final VoidCallback? onTap;

  String? _first(List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value == null) continue;
      if (value is Map || value is List) continue;
      final text = str(value);
      if (text.trim().isEmpty) continue;
      return text;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final title = _first(titleKeys) ?? 'Sin título';
    final subtitle = _first(subtitleKeys) ?? '';
    final status = str(data['status']);
    final amount = _first(trailingKeys);
    final date = CrmFormat.ago(data['created_at'] ?? data['scheduled_at'] ?? data['date']);

    return CrmListTile(
      title: title,
      subtitle: [if (subtitle.isNotEmpty) subtitle, if (date.isNotEmpty) date].join(' · '),
      leading: CrmAvatar(label: title, icon: leadingIcon),
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (amount != null)
            Text(
              num.tryParse(amount.replaceAll(RegExp(r'[^0-9.]'), '')) == null
                  ? amount
                  : CrmFormat.money(num.tryParse(amount.replaceAll(RegExp(r'[^0-9.]'), ''))!),
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: p.ink),
            )
          else if (status.isNotEmpty)
            StatusPill(label: status, dense: true),
          if (amount != null && status.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: StatusPill(label: status, dense: true)),
        ],
      ),
      onTap: onTap,
    );
  }
}

/// Volcado ordenado de un objeto (ajustes, resúmenes, cobros) sin inventarse
/// campos: muestra lo que el servidor manda, en castellano cuando se conoce.
class KeyValueList extends StatelessWidget {
  const KeyValueList({super.key, required this.data, this.skipKeys = const []});

  final Map<String, dynamic> data;
  final List<String> skipKeys;

  static const Map<String, String> labels = {
    'enabled': 'Activo',
    'status': 'Estado',
    'total': 'Total',
    'amount': 'Importe',
    'count': 'Cantidad',
    'pending': 'Pendiente',
    'active': 'Activo',
    'created_at': 'Creado',
    'updated_at': 'Actualizado',
    'name': 'Nombre',
    'phone': 'Teléfono',
    'address': 'Dirección',
    'notes': 'Notas',
    'balance': 'Saldo',
    'cash': 'Efectivo',
    'delivered': 'Entregado',
    'orders': 'Pedidos',
    'customers': 'Clientes',
    'open': 'Abiertos',
    'resolved': 'Resueltos',
  };

  String _label(String key) => labels[key] ?? key.replaceAll('_', ' ');

  String _value(Object? value) {
    if (value == null) return '—';
    if (value is bool) return value ? 'Sí' : 'No';
    if (value is num) return value is int ? CrmFormat.integer(value) : CrmFormat.money(value);
    if (value is List) return '${value.length} elemento(s)';
    if (value is Map) return '${value.length} campo(s)';
    final text = value.toString();
    final date = DateTime.tryParse(text);
    if (date != null && text.length > 12) return CrmFormat.dayFull(date);
    return text;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final entries = data.entries
        .where((entry) => !skipKeys.contains(entry.key))
        .where((entry) => entry.value is! List || (entry.value as List).isEmpty)
        .toList();
    if (entries.isEmpty) {
      return Text('Sin datos.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary));
    }
    return Column(
      children: [
        for (final entry in entries)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3.5),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 130,
                  child: Text(_label(entry.key), style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                ),
                Expanded(
                  child: Text(_value(entry.value), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.ink)),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Pantalla de la app con lista remota ya envuelta en el esqueleto del panel.
class RemoteListScreen extends StatelessWidget {
  const RemoteListScreen({
    super.key,
    required this.title,
    required this.subtitle,
    required this.load,
    required this.itemBuilder,
    this.emptyTitle = 'Sin datos todavía',
    this.emptyMessage,
    this.icon = Icons.inbox_rounded,
    this.header,
  });

  final String title;
  final String subtitle;
  final Future<List<Map<String, dynamic>>> Function() load;
  final Widget Function(BuildContext context, Map<String, dynamic> row) itemBuilder;
  final String emptyTitle;
  final String? emptyMessage;
  final IconData icon;
  final Widget Function(BuildContext context, List<Map<String, dynamic>> rows)? header;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final desktop = context.isDesktop;
    return Column(
      children: [
        CrmPageHeader(title: title, subtitle: subtitle),
        Expanded(
          child: RemoteLoader<List<Map<String, dynamic>>>(
            load: load,
            loadingLabel: 'Cargando $title',
            emptyCheck: (rows) => rows.isEmpty,
            emptyBuilder: (context) => EmptyState(title: emptyTitle, message: emptyMessage, icon: icon),
            builder: (context, rows, reload) => ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                if (header != null) header!(context, rows),
                Container(
                  margin: EdgeInsets.symmetric(horizontal: desktop ? 16 : 0),
                  decoration: BoxDecoration(
                    color: p.surface,
                    borderRadius: BorderRadius.circular(desktop ? 14 : 0),
                    border: desktop ? Border.all(color: p.border) : null,
                  ),
                  child: Column(
                    children: [
                      for (var index = 0; index < rows.length; index++) ...[
                        if (index > 0) Divider(height: 1, color: p.line),
                        itemBuilder(context, rows[index]),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
