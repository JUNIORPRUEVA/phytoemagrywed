import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../whatsapp/chat_screen.dart';
import 'pedido_actions.dart';

/// Detalle de un pedido: lo que hay, a quién se entrega y cómo se cobra.
class PedidoDetailScreen extends StatefulWidget {
  const PedidoDetailScreen({super.key, required this.orderId});

  final String orderId;

  @override
  State<PedidoDetailScreen> createState() => _PedidoDetailScreenState();
}

class _PedidoDetailScreenState extends State<PedidoDetailScreen> {
  Map<String, dynamic>? _detail;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final detail = await repo.order(widget.orderId);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final order = state.orderById(widget.orderId);
    final p = context.crm;
    final item = mapv(_detail?['item']);
    final detailOrder = mapv(_detail?['order']);
    final payment = mapv(_detail?['payment']);
    final lines = listv(detailOrder['items']).isEmpty ? listv(mapv(item['order_json'])['items']) : listv(detailOrder['items']);

    final name = order?.name ?? str(item['name'], 'Pedido');
    final phone = order?.phone ?? str(item['phone']);
    final address = order?.deliveryAddress ?? str(detailOrder['delivery'] is Map ? mapv(detailOrder['delivery'])['address'] : '');
    final status = order?.status ?? str(item['status'], str(detailOrder['status'], 'nuevo'));

    return Scaffold(
      backgroundColor: p.pageBg,
      appBar: AppBar(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        title: Text(order?.label ?? 'Pedido', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: p.ink)),
        actions: [
          IconButton(onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh_rounded), tooltip: 'Recargar'),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.only(top: 12, bottom: 26),
        children: [
          SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    CrmAvatar(label: name, size: 46),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(name, style: Theme.of(context).textTheme.titleMedium),
                          if (phone.isNotEmpty)
                            Text(phone, style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                        ],
                      ),
                    ),
                    StatusPill(label: status, dense: true),
                  ],
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: CrmButton(
                        label: 'Llamar',
                        icon: Icons.call_outlined,
                        filled: false,
                        onPressed: phone.isEmpty ? null : () => launchUrl(Uri.parse('tel:$phone')),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: CrmButton(
                        label: 'WhatsApp',
                        icon: Icons.forum_outlined,
                        onPressed: phone.isEmpty
                            ? null
                            : () => launchUrl(
                                  Uri.parse('https://wa.me/${phone.replaceAll(RegExp(r'[^0-9]'), '')}'),
                                  mode: LaunchMode.externalApplication,
                                ),
                      ),
                    ),
                  ],
                ),
                if ((order?.conversationId ?? '').isNotEmpty) ...[
                  const SizedBox(height: 8),
                  CrmButton(
                    label: 'Abrir la conversación',
                    icon: Icons.chat_bubble_outline_rounded,
                    filled: false,
                    expand: true,
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => ChatScreen(conversationId: order!.conversationId, title: name)),
                    ),
                  ),
                ],
              ],
            ),
          ),
          OrderActionsPanel(
            orderId: widget.orderId,
            order: order,
            payment: payment,
            detailOrder: detailOrder,
            onChanged: () {
              _load();
              CrmScope.of(context, listen: false).refresh(quiet: true);
            },
          ),
          SectionCard(
            title: 'Producto',
            child: _loading
                ? const LoadingState()
                : (_error != null
                    ? ErrorState(message: _error!, onRetry: _load)
                    : Column(
                        children: [
                          if (lines.isEmpty)
                            CrmListTile(
                              title: order?.variantName ?? str(item['variantName'], 'Producto'),
                              subtitle: 'x${order?.quantity ?? 1} · ${CrmFormat.money(order?.unitPrice)}',
                              leading: CrmAvatar(label: 'P', icon: Icons.medication_outlined),
                              trailing: Text(CrmFormat.money(order?.total), style: const TextStyle(fontWeight: FontWeight.w800)),
                            )
                          else
                            for (final line in lines)
                              CrmListTile(
                                title: str(line['variantName'], str(line['name'], 'Producto')),
                                subtitle: 'x${intv(line['quantity'], 1)} · ${CrmFormat.money(dub(line['unitPrice'], dub(line['price'])))}',
                                leading: CrmAvatar(label: 'P', icon: Icons.medication_outlined),
                                trailing: Text(
                                  CrmFormat.money(dub(line['total'], dub(line['unitPrice']) * intv(line['quantity'], 1))),
                                  style: const TextStyle(fontWeight: FontWeight.w800),
                                ),
                              ),
                          Divider(height: 20, color: p.line),
                          _Row(label: 'Subtotal', value: CrmFormat.money(order?.total ?? dub(detailOrder['subtotal']))),
                          if (dub(detailOrder['discount']) > 0)
                            _Row(label: 'Descuento', value: '- ${CrmFormat.money(dub(detailOrder['discount']))}', tone: p.success),
                          _Row(
                            label: 'Total',
                            value: CrmFormat.money(order?.total ?? dub(detailOrder['total'])),
                            strong: true,
                          ),
                        ],
                      )),
          ),
          SectionCard(
            title: 'Entrega y cobro',
            child: Column(
              children: [
                _Row(label: 'Dirección', value: address.isEmpty ? 'Sin dirección' : address),
                _Row(label: 'Zona', value: order?.location ?? str(item['location'], '—')),
                _Row(label: 'Forma de pago', value: (order?.paymentMethod ?? str(detailOrder['paymentMethod'], '')).isEmpty ? 'No definida' : (order?.paymentMethod ?? str(detailOrder['paymentMethod']))),
                _Row(label: 'Origen', value: (order?.source ?? '').isEmpty ? 'Panel' : order!.source),
                _Row(label: 'Recibido', value: CrmFormat.ago(order?.receivedAt)),
                if (payment.isNotEmpty) _Row(label: 'Cobro', value: str(payment['status'], '—')),
              ],
            ),
          ),
          if ((order?.notes ?? '').isNotEmpty)
            SectionCard(
              title: 'Notas',
              child: Text(order!.notes, style: TextStyle(fontSize: 13.5, color: p.ink, height: 1.4)),
            ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.strong = false, this.tone});

  final String label;
  final String value;
  final bool strong;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 118,
            child: Text(label, style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: strong ? 15 : 13,
                fontWeight: strong ? FontWeight.w800 : FontWeight.w600,
                color: tone ?? p.ink,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
