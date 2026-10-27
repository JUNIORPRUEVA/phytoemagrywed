import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../pedidos/pedido_detail_screen.dart';

/// Ficha del cliente: datos, etiquetas, pedidos y conversaciones.
class ClienteDetailScreen extends StatefulWidget {
  const ClienteDetailScreen({super.key, required this.customerId});

  final String customerId;

  @override
  State<ClienteDetailScreen> createState() => _ClienteDetailScreenState();
}

class _ClienteDetailScreenState extends State<ClienteDetailScreen> {
  Map<String, dynamic>? _profile;
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
      final profile = await repo.customer(widget.customerId);
      if (!mounted) return;
      setState(() {
        _profile = profile;
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
    final p = context.crm;
    final customer = state.customerById(widget.customerId);
    final profileCustomer = mapv(_profile?['customer']);
    final name = customer?.name ?? str(profileCustomer['name'], 'Cliente');
    final phone = customer?.phone ?? str(profileCustomer['phone_e164'], str(profileCustomer['phone']));
    final orders = state.orders.where((row) => row.customerId == widget.customerId).toList()
      ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));
    final conversations = state.conversations.where((row) => row.customerId == widget.customerId).toList();

    return Scaffold(
      backgroundColor: p.pageBg,
      appBar: AppBar(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        title: Text('Ficha del cliente', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: p.ink)),
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh_rounded), tooltip: 'Recargar')],
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
                    CrmAvatar(label: name, size: 52),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(name, style: Theme.of(context).textTheme.titleLarge),
                          if (phone.isNotEmpty) Text(phone, style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                        ],
                      ),
                    ),
                    if (customer != null) StatusPill(label: customer.stage.toLowerCase(), dense: true),
                  ],
                ),
                const SizedBox(height: 12),
                if (customer != null && customer.tags.isNotEmpty)
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final tag in customer.tags) StatusPill(label: tag, dense: true, color: p.primary)],
                  ),
                const SizedBox(height: 12),
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
              ],
            ),
          ),
          SectionCard(
            title: 'Resumen',
            child: _loading
                ? const LoadingState()
                : (_error != null
                    ? ErrorState(message: _error!, onRetry: _load)
                    : Column(
                        children: [
                          _InfoRow(label: 'Pedidos', value: '${customer?.orders ?? orders.length}'),
                          _InfoRow(label: 'Compras entregadas', value: '${customer?.delivered ?? orders.where((row) => row.status == 'entregado').length}'),
                          _InfoRow(label: 'Total comprado', value: CrmFormat.money(customer?.totalSpent ?? orders.fold<double>(0, (sum, row) => sum + row.total))),
                          _InfoRow(label: 'Ciudad', value: (customer?.city ?? '').isEmpty ? '—' : customer!.city),
                          _InfoRow(label: 'Correo', value: (customer?.email ?? '').isEmpty ? '—' : customer!.email),
                          _InfoRow(label: 'Cliente desde', value: CrmFormat.dayFull(customer?.createdAt)),
                          if ((customer?.notes ?? '').isNotEmpty) _InfoRow(label: 'Notas', value: customer!.notes),
                        ],
                      )),
          ),
          SectionCard(
            title: 'Pedidos (${orders.length})',
            child: orders.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text('Este cliente todavía no tiene pedidos.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                  )
                : Column(
                    children: [
                      for (final order in orders)
                        CrmListTile(
                          title: '${order.label} · ${order.variantName}',
                          subtitle: '${CrmFormat.ago(order.receivedAt)} · ${order.location}',
                          leading: CrmAvatar(label: 'P', icon: Icons.shopping_bag_outlined),
                          trailing: Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(CrmFormat.money(order.total, short: true), style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: p.ink)),
                              const SizedBox(height: 4),
                              StatusPill(label: order.status, dense: true),
                            ],
                          ),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(builder: (_) => PedidoDetailScreen(orderId: order.id)),
                          ),
                        ),
                    ],
                  ),
          ),
          SectionCard(
            title: 'Conversaciones (${conversations.length})',
            child: conversations.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text('Sin conversaciones de WhatsApp.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary)),
                  )
                : Column(
                    children: [
                      for (final conversation in conversations)
                        CrmListTile(
                          title: 'WhatsApp',
                          subtitle: conversation.preview,
                          leading: CrmAvatar(label: 'W', icon: Icons.forum_outlined),
                          trailing: Text(CrmFormat.chatStamp(conversation.lastAt), style: TextStyle(fontSize: 11, color: p.inkSecondary)),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 136, child: Text(label, style: TextStyle(fontSize: 12.5, color: p.inkSecondary))),
          Expanded(child: Text(value, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.ink))),
        ],
      ),
    );
  }
}
