import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../clientes/cliente_detail_screen.dart';
import '../common/crm_ui.dart';
import '../pedidos/pedido_detail_screen.dart';
import '../whatsapp/chat_screen.dart';

/// «Hoy»: los recuentos del día y lo que hay que atender ahora mismo.
class HoyScreen extends StatelessWidget {
  const HoyScreen({super.key, this.onNavigate});

  final ValueChanged<String>? onNavigate;

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final stats = state.stats;
    final waiting = state.conversations.where((row) => row.pending).toList()
      ..sort((a, b) => b.lastAt.compareTo(a.lastAt));
    final openOrders = state.orders.where((row) => row.isOpen).toList()
      ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));
    final followupToday = listOfFollowups(state.followups['today']);
    final overdue = listOfFollowups(state.followups['overdue']);

    return RefreshIndicator(
      onRefresh: state.refresh,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 26),
        children: [
          CrmPageHeader(
            title: 'Hoy',
            subtitle: stats['today'] == null ? 'Resumen del día' : 'Jornada del ${CrmFormat.dayFull('${stats['today']}T12:00:00')}',
            actions: [
              IconButton(
                tooltip: 'Actualizar',
                onPressed: state.loading ? null : () => state.refresh(),
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
          StatGrid(
            children: [
              StatTile(
                label: 'Pedidos abiertos',
                value: '${intOf(stats['pedidos'])}',
                hint: '${intOf(stats['nuevos'])} nuevos',
                icon: Icons.receipt_long_outlined,
                onTap: () => onNavigate?.call('pedidos'),
              ),
              StatTile(
                label: 'Sin leer',
                value: '${state.unreadTotal}',
                hint: '${waiting.length} esperando respuesta',
                icon: Icons.mark_chat_unread_outlined,
                tone: p.danger,
                onTap: () => onNavigate?.call('whatsapp'),
              ),
              StatTile(
                label: 'Clientes',
                value: '${state.customers.length}',
                hint: '${intOf(stats['entregados'])} compras entregadas',
                icon: Icons.people_outline_rounded,
                tone: p.success,
                onTap: () => onNavigate?.call('clientes'),
              ),
              StatTile(
                label: 'Dinero abierto',
                value: CrmFormat.money(numOf(stats['valorAbierto']), short: true),
                hint: 'Cobrado ${CrmFormat.money(numOf(stats['valorCobrado']), short: true)}',
                icon: Icons.payments_outlined,
                tone: p.warning,
                onTap: () => onNavigate?.call('cierre'),
              ),
              StatTile(
                label: 'Seguimientos hoy',
                value: '${followupToday.length}',
                hint: '${overdue.length} atrasados',
                icon: Icons.event_repeat_outlined,
                tone: p.danger,
                onTap: () => onNavigate?.call('seguimientos'),
              ),
              StatTile(
                label: 'Repartos en vivo',
                value: '${state.deliveryTracking.length}',
                hint: 'Sesiones activas',
                icon: Icons.delivery_dining_outlined,
                onTap: () => onNavigate?.call('mapa'),
              ),
            ],
          ),
          SectionCard(
            title: 'Esperando tu respuesta',
            trailing: TextButton(onPressed: () => onNavigate?.call('whatsapp'), child: const Text('Ver bandeja')),
            child: waiting.isEmpty
                ? const _MiniEmpty(text: 'Nadie está esperando respuesta. Buen trabajo.')
                : Column(
                    children: [
                      for (final conversation in waiting.take(6))
                        CrmListTile(
                          title: conversation.name,
                          subtitle: conversation.preview,
                          leading: CrmAvatar(label: conversation.name),
                          badge: conversation.unread > 0 ? '${conversation.unread}' : null,
                          trailing: Text(CrmFormat.ago(conversation.lastAt), style: TextStyle(fontSize: 11, color: p.inkSecondary)),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(builder: (_) => ChatScreen(conversationId: conversation.id, title: conversation.name)),
                          ),
                        ),
                      if (waiting.length > 6)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text('y ${waiting.length - 6} más', style: TextStyle(fontSize: 12, color: p.inkSecondary)),
                        ),
                    ],
                  ),
          ),
          SectionCard(
            title: 'Pedidos abiertos',
            trailing: TextButton(onPressed: () => onNavigate?.call('pedidos'), child: const Text('Ver todos')),
            child: openOrders.isEmpty
                ? const _MiniEmpty(text: 'No hay pedidos abiertos.')
                : Column(
                    children: [
                      for (final order in openOrders.take(6))
                        CrmListTile(
                          title: '${order.name} · ${order.label}',
                          subtitle: '${order.variantName} x${order.quantity} · ${order.location}',
                          leading: CrmAvatar(label: order.name, icon: Icons.shopping_bag_outlined),
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
            title: 'Accesos rápidos',
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final entry in const [
                  ('pos', 'Vender', Icons.point_of_sale_rounded),
                  ('catalogo', 'Facturar', Icons.point_of_sale_outlined),
                  ('inventario', 'Stock', Icons.inventory_2_outlined),
                  ('recogidas', 'Recogidas', Icons.shopping_bag_outlined),
                  ('reportes', 'Reportes', Icons.insert_chart_outlined),
                  ('ops', 'Agentes IA', Icons.smart_toy_outlined),
                  ('ajustes', 'Configuración', Icons.settings_outlined),
                ])
                  ActionChip(
                    avatar: Icon(entry.$3, size: 17, color: p.primary),
                    label: Text(entry.$2),
                    onPressed: () => onNavigate?.call(entry.$1),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static List<FollowupRow> listOfFollowups(Object? value) =>
      (value is List ? value : const []).map((row) => FollowupRow.fromJson(mapv(row))).toList();

  static int intOf(Object? value) => intv(value);

  static double numOf(Object? value) => dub(value);
}

class _MiniEmpty extends StatelessWidget {
  const _MiniEmpty({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(
        children: [
          Icon(Icons.check_circle_outline_rounded, size: 18, color: p.success),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, color: p.inkSecondary))),
        ],
      ),
    );
  }
}

/// Fila de cliente reutilizada por varias pantallas.
class CustomerTile extends StatelessWidget {
  const CustomerTile({super.key, required this.customer});

  final Customer customer;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return CrmListTile(
      title: customer.name,
      subtitle: [
        if (customer.phone.isNotEmpty) customer.phone,
        if (customer.city.isNotEmpty) customer.city,
        if (customer.orders > 0) '${customer.orders} pedidos',
      ].join(' · '),
      leading: CrmAvatar(label: customer.name),
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          StatusPill(label: customer.stage.toLowerCase(), dense: true),
          if (customer.totalSpent > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(CrmFormat.money(customer.totalSpent, short: true), style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
            ),
        ],
      ),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ClienteDetailScreen(customerId: customer.id))),
    );
  }
}

/// Espacio reservado (por si una pantalla necesita el estilo del panel).
const EdgeInsets kCrmPagePadding = EdgeInsets.fromLTRB(CrmSpace.md, 0, CrmSpace.md, CrmSpace.xl);
