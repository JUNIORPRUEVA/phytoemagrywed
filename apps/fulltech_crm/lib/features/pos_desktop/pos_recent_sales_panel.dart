import 'dart:convert';

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';

/// Ventas guardadas como pedidos por el POS. La factura se reconoce por el
/// identificador del documento, no por el estado del pedido.
class PosRecentSalesPanel extends StatefulWidget {
  const PosRecentSalesPanel({
    super.key,
    required this.onOpenOrder,
    required this.onOpenHistory,
    required this.onClose,
  });

  final ValueChanged<String> onOpenOrder;
  final VoidCallback onOpenHistory;
  final VoidCallback onClose;

  @override
  State<PosRecentSalesPanel> createState() => _PosRecentSalesPanelState();
}

class _PosRecentSalesPanelState extends State<PosRecentSalesPanel> {
  List<_RecentSale> _sales = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await CrmScope.of(
        context,
        listen: false,
      ).repository.allOrders();
      if (!mounted) return;
      final rows =
          response.orders
              .map(_RecentSale.fromJson)
              .where((row) => row.id.isNotEmpty)
              .toList()
            ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));
      setState(() {
        _sales = rows.take(20).toList();
        _loading = false;
      });
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _error = error.message;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 2, 8, 10),
          child: Row(
            children: [
              Icon(Icons.receipt_long_rounded, color: p.primary, size: 22),
              const SizedBox(width: 10),
              Expanded(child: Text('Ventas recientes', style: t.title)),
              IconButton(
                onPressed: _load,
                tooltip: 'Actualizar ventas',
                icon: Icon(Icons.refresh_rounded, color: p.inkSecondary),
              ),
              IconButton(
                onPressed: widget.onClose,
                tooltip: 'Cerrar ventas recientes',
                icon: Icon(Icons.close_rounded, color: p.inkSecondary),
              ),
            ],
          ),
        ),
        Divider(height: 1, color: p.border),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Expanded(
                flex: 5,
                child: Text(
                  'Venta',
                  style: t.secondary.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              Expanded(
                flex: 3,
                child: Text(
                  'Total',
                  textAlign: TextAlign.right,
                  style: t.secondary.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 86,
                child: Text(
                  'Estado',
                  style: t.secondary.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: _loading
              ? Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: p.primary,
                  ),
                )
              : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: t.secondary,
                    ),
                  ),
                )
              : _sales.isEmpty
              ? Center(
                  child: Text(
                    'Todavía no hay ventas registradas.',
                    style: t.secondary,
                  ),
                )
              : ListView.builder(
                  itemCount: _sales.length,
                  itemBuilder: (context, index) {
                    final sale = _sales[index];
                    return Material(
                      color: index.isEven
                          ? p.primarySoft.withValues(alpha: 0.45)
                          : p.surface,
                      child: InkWell(
                        onTap: () => widget.onOpenOrder(sale.id),
                        child: Container(
                          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                          decoration: BoxDecoration(
                            border: Border(
                              bottom: BorderSide(color: p.borderSoft),
                            ),
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                flex: 5,
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      '${sale.isInvoice ? 'Factura' : 'Pedido'} ${sale.number}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: t.body.copyWith(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    const SizedBox(height: 3),
                                    Text(
                                      '${CrmFormat.dayFull(sale.receivedAt)}  ${CrmFormat.time(sale.receivedAt)}',
                                      style: t.secondary.copyWith(fontSize: 11),
                                    ),
                                  ],
                                ),
                              ),
                              Expanded(
                                flex: 3,
                                child: Text(
                                  CrmFormat.money(sale.total),
                                  textAlign: TextAlign.right,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: t.body.copyWith(
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              SizedBox(
                                width: 62,
                                child: Text(
                                  sale.status,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: t.secondary.copyWith(
                                    color: p.primary,
                                    fontSize: 11.5,
                                  ),
                                ),
                              ),
                              Icon(
                                Icons.visibility_outlined,
                                size: 18,
                                color: p.inkSecondary,
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
        ),
        Divider(height: 1, color: p.border),
        Padding(
          padding: const EdgeInsets.all(14),
          child: OutlinedButton.icon(
            onPressed: widget.onOpenHistory,
            icon: const Icon(Icons.arrow_forward_rounded, size: 17),
            label: const Text('Ir al historial de pedidos'),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(42),
              foregroundColor: p.ink,
            ),
          ),
        ),
      ],
    );
  }
}

class _RecentSale {
  const _RecentSale(
    this.id,
    this.number,
    this.total,
    this.status,
    this.receivedAt,
    this.isInvoice,
  );

  final String id;
  final String number;
  final double total;
  final String status;
  final String receivedAt;
  final bool isInvoice;

  static _RecentSale fromJson(Map<String, dynamic> row) {
    Map<String, dynamic> order = const {};
    final raw = row['order_json'];
    if (raw is String && raw.isNotEmpty) {
      try {
        order = mapv(jsonDecode(raw));
      } catch (_) {
        /* Use top-level fields. */
      }
    } else {
      order = mapv(raw);
    }
    return _RecentSale(
      str(row['id']),
      str(
        order['invoice_number'],
        str(row['order_number'], str(order['order_number'], str(row['id']))),
      ),
      numv(order['total'], numv(row['total'])).toDouble(),
      str(row['status'], str(order['status'], 'nuevo')),
      str(row['received_at'], str(order['created_at'])),
      str(order['invoice_id']).isNotEmpty,
    );
  }
}
