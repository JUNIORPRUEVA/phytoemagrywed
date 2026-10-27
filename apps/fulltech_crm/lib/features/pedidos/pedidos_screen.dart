import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'pedido_detail_screen.dart';

/// Pedidos: primero lo que trae el paquete ligero (hasta 150) y, si hay más,
/// el resto se pide por páginas con `GET /api/admin/orders?limit=&cursor=`.
/// El aviso de «datos parciales» NO se quita hasta que se han cargado todos.
class PedidosScreen extends StatefulWidget {
  const PedidosScreen({super.key});

  @override
  State<PedidosScreen> createState() => _PedidosScreenState();
}

class _PedidosScreenState extends State<PedidosScreen> {
  final _search = TextEditingController();
  String _filter = 'abiertos';
  final List<OrderItem> _paged = [];
  String? _cursor;
  int _total = 0;
  bool _paging = false;
  bool _allLoaded = false;
  String? _pageError;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadMore() async {
    if (_paging) return;
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() {
      _paging = true;
      _pageError = null;
    });
    try {
      final page = await repo.ordersPage(limit: 100, cursor: _cursor);
      if (!mounted) return;
      setState(() {
        final known = {for (final row in _paged) row.id};
        for (final row in page.orders) {
          final item = OrderItem.fromJson(row);
          if (item.id.isNotEmpty && known.add(item.id)) _paged.add(item);
        }
        _cursor = page.nextCursor;
        _total = page.total;
        _allLoaded = page.nextCursor == null;
        _paging = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _pageError = error.message;
        _paging = false;
      });
    }
  }

  List<OrderItem> _all(List<OrderItem> snapshot) {
    final byId = <String, OrderItem>{};
    for (final row in snapshot) {
      byId[row.id] = row;
    }
    for (final row in _paged) {
      byId[row.id] = row;
    }
    return byId.values.toList();
  }

  List<OrderItem> _filtered(List<OrderItem> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      if (_filter == 'abiertos' && !row.isOpen) return false;
      if (_filter == 'entregados' && row.status != 'entregado') return false;
      if (_filter == 'cancelados' && row.status != 'cancelado') return false;
      if (query.isEmpty) return true;
      return row.name.toLowerCase().contains(query) ||
          row.phone.toLowerCase().contains(query) ||
          row.location.toLowerCase().contains(query) ||
          row.variantName.toLowerCase().contains(query) ||
          row.orderNumber.toLowerCase().contains(query);
    }).toList()
      ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final rows = _filtered(_all(state.orders));
    final total = rows.fold<double>(0, (sum, row) => sum + row.total);
    final desktop = context.isDesktop;
    final truncated = state.ordersTruncated && !_allLoaded;
    final shown = _all(state.orders).length;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: CrmSearchField(controller: _search, hint: 'Buscar por cliente, teléfono o número', onChanged: (_) => setState(() {})),
        ),
        FilterChips(
          options: const ['abiertos', 'entregados', 'cancelados', 'todos'],
          value: _filter,
          onChanged: (value) => setState(() => _filter = value),
          labels: const {'abiertos': 'Abiertos', 'entregados': 'Entregados', 'cancelados': 'Cancelados', 'todos': 'Todos'},
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
          child: Row(
            children: [
              Text(
                truncated && _total > 0 ? '${rows.length} de $_total pedidos' : '${rows.length} pedidos',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.ink),
              ),
              const Spacer(),
              Text(CrmFormat.money(total, short: true), style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: p.primary)),
            ],
          ),
        ),
        if (truncated)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: CrmNotice(
              message: _pageError == null
                  ? 'Se están mostrando $shown pedidos de $_total. Pulsa «Cargar más» para traer el resto.'
                  : 'No se pudo traer el resto: $_pageError',
              icon: Icons.filter_alt_outlined,
            ),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refresh,
            child: rows.isEmpty
                ? ListView(children: const [SizedBox(height: 40), EmptyState(title: 'Sin pedidos con este filtro', icon: Icons.receipt_long_outlined)])
                : Container(
                    margin: EdgeInsets.symmetric(horizontal: desktop ? 16 : 0),
                    decoration: BoxDecoration(
                      color: p.surface,
                      borderRadius: BorderRadius.circular(desktop ? 14 : 0),
                      border: desktop ? Border.all(color: p.border) : null,
                    ),
                    child: ListView.separated(
                      itemCount: rows.length + (truncated ? 1 : 0),
                      separatorBuilder: (_, _) => Divider(height: 1, color: p.line),
                      itemBuilder: (context, index) {
                        if (index >= rows.length) {
                          return Padding(
                            padding: const EdgeInsets.all(12),
                            child: Center(
                              child: _paging
                                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))
                                  : CrmButton(
                                      label: _pageError == null ? 'Cargar más pedidos' : 'Reintentar',
                                      icon: Icons.expand_more_rounded,
                                      filled: false,
                                      onPressed: _loadMore,
                                    ),
                            ),
                          );
                        }
                        final order = rows[index];
                        return CrmListTile(
                          title: '${order.name} · ${order.label}',
                          subtitle: [
                            if (order.variantName.isNotEmpty) '${order.variantName} x${order.quantity}',
                            if (order.location.isNotEmpty) order.location,
                            CrmFormat.ago(order.receivedAt),
                          ].join(' · '),
                          leading: CrmAvatar(label: order.name, icon: Icons.shopping_bag_outlined),
                          trailing: Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(CrmFormat.money(order.total, short: true), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: p.ink)),
                              const SizedBox(height: 5),
                              StatusPill(label: order.status, dense: true),
                            ],
                          ),
                          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PedidoDetailScreen(orderId: order.id))),
                        );
                      },
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}
