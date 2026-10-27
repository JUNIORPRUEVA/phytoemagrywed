// Harness de diseño (NO forma parte del producto).
//
// Levanta los WIDGETS REALES del CRM con datos de mentira para poder capturar
// pantallas sin backend y sin tocar producción. Se elige la vista con
// `--dart-define=VIEW=shell|chats|gallery`.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/core/theme/crm_tokens.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/common/crm_ui.dart';
import 'package:fulltech_crm/features/shell/crm_desktop_shell.dart';
import 'package:fulltech_crm/features/shell/crm_shell.dart';
import 'package:fulltech_crm/features/cierre/cierre_screen.dart';
import 'package:fulltech_crm/features/clientes/clientes_screen.dart';
import 'package:fulltech_crm/features/entregas/custodia_screen.dart';
import 'package:fulltech_crm/features/entregas/repartidores_screen.dart';
import 'package:fulltech_crm/features/hoy/hoy_screen.dart';
import 'package:fulltech_crm/features/pedidos/pedidos_screen.dart';
import 'package:fulltech_crm/features/reportes/reportes_screen.dart';
import 'package:fulltech_crm/features/usuarios/usuarios_screen.dart';
import 'package:fulltech_crm/features/ventas/inventario_screen.dart';
import 'package:fulltech_crm/features/ventas/pos_screen.dart';
import 'package:fulltech_crm/features/whatsapp/chats_desktop.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final String _view = Platform.environment['HARNESS_VIEW'] ?? const String.fromEnvironment('VIEW', defaultValue: 'shell');
final String _mode = Platform.environment['HARNESS_MODE'] ?? const String.fromEnvironment('MODE', defaultValue: 'light');

String _at(int minutesAgo) =>
    DateTime.now().subtract(Duration(minutes: minutesAgo)).toUtc().toIso8601String();

Map<String, dynamic> _snapshot() => {
      'ok': true,
      'partial': false,
      'stats': {
        'pedidos': 12,
        'entregados': 7,
        'nuevos': 3,
        'atrasados': 2,
        'valorAbierto': 48250,
        'valorCobrado': 137900,
      },
      'conversationCounts': {'todos': 3, 'no_leidos': 4, 'pendientes': 2, 'sin_asignar': 1, 'unread_total': 4},
      'customers': [
        {'id': 'cus_1', 'name': 'María Rodríguez', 'phone_e164': '+18095551010', 'stage': 'CUSTOMER'},
        {'id': 'cus_2', 'name': 'Luis Peña', 'phone_e164': '+18095551011', 'stage': 'INTERESTED'},
        {'id': 'cus_3', 'name': 'Ana Batista', 'phone_e164': '+18095551012', 'stage': 'PROSPECT'},
      ],
      'conversations': [
        {
          'id': 'cnv_1',
          'customer_id': 'cus_1',
          'customer': {'id': 'cus_1', 'name': 'María Rodríguez', 'phone_e164': '+18095551010', 'stage': 'CUSTOMER'},
          'name': 'María Rodríguez',
          'phone': '+18095551010',
          'stage': 'CUSTOMER',
          'tags': ['cliente', 'recompra'],
          'unread_count': 3,
          'awaiting_reply': true,
          'status': 'HUMAN_ACTIVE',
          'last_message': {'body': 'Dame dos frascos de 30, por favor', 'direction': 'inbound', 'created_at': _at(4)},
        },
        {
          'id': 'cnv_2',
          'customer_id': 'cus_2',
          'customer': {'id': 'cus_2', 'name': 'Luis Peña', 'phone_e164': '+18095551011', 'stage': 'INTERESTED'},
          'name': 'Luis Peña',
          'phone': '+18095551011',
          'stage': 'INTERESTED',
          'unread_count': 1,
          'awaiting_reply': true,
          'last_message': {'body': '¿Todavía tienen el de 60 cápsulas?', 'direction': 'inbound', 'created_at': _at(52)},
        },
        {
          'id': 'cnv_3',
          'customer_id': 'cus_3',
          'customer': {'id': 'cus_3', 'name': 'Ana Batista', 'phone_e164': '+18095551012', 'stage': 'PROSPECT'},
          'name': 'Ana Batista',
          'phone': '+18095551012',
          'stage': 'PROSPECT',
          'unread_count': 0,
          'awaiting_reply': false,
          'resolved_at': _at(300),
          'last_message': {'body': 'Gracias, ya recibí el pedido', 'direction': 'inbound', 'created_at': _at(320)},
        },
      ],
      'items': [
        {
          'id': 'pos_1',
          'type': 'order_intent',
          'name': 'María Rodríguez',
          'phone': '+18095551010',
          'status': 'nuevo',
          'total': 2500,
          'variantName': 'Frasco 30 cápsulas',
          'quantity': 1,
          'received_at': _at(8),
          'order_number': 'PE-1042',
          'customer_id': 'cus_1',
          'payment_method': 'CASH',
        },
        {
          'id': 'pos_2',
          'type': 'order_intent',
          'name': 'Luis Peña',
          'phone': '+18095551011',
          'status': 'confirmado',
          'total': 4375,
          'variantName': 'Frasco 60 cápsulas',
          'quantity': 1,
          'received_at': _at(70),
          'order_number': 'PE-1041',
          'customer_id': 'cus_2',
          'payment_method': 'TRANSFER',
        },
        {
          'id': 'pos_3',
          'type': 'order_intent',
          'name': 'Ana Batista',
          'phone': '+18095551012',
          'status': 'entregado',
          'total': 1250,
          'variantName': 'Frasco 10 cápsulas',
          'quantity': 1,
          'received_at': _at(400),
          'order_number': 'PE-1040',
          'customer_id': 'cus_3',
          'payment_method': 'CASH',
        },
      ],
      'messages': <Map<String, dynamic>>[],
      'followups': {'items': []},
      'notifications': <Map<String, dynamic>>[],
      'scheduled': {'items': []},
    };

Map<String, dynamic> _messages() => {
      'ok': true,
      'messages': [
        {
          'id': 'm1',
          'direction': 'inbound',
          'type': 'text',
          'body': 'Hola, buenos días 👋',
          'created_at': _at(120),
        },
        {
          'id': 'm2',
          'direction': 'outbound',
          'type': 'text',
          'body': 'Buenos días, María. ¿En qué te ayudo?',
          'created_at': _at(118),
          'status': 'read',
        },
        {
          'id': 'm3',
          'direction': 'inbound',
          'type': 'text',
          'body': 'Dame dos frascos de 30, por favor',
          'created_at': _at(6),
        },
        {
          'id': 'm4',
          'direction': 'outbound',
          'type': 'text',
          'body': 'Listo: te preparo el pedido y te paso la factura por aquí.',
          'created_at': _at(4),
          'status': 'delivered',
        },
      ],
    };

http.Client _client() => MockClient((request) async {
      final path = request.url.path;
      Map<String, dynamic> body;
      if (path.contains('/auth/login')) {
        body = {
          'ok': true,
          'authenticated': true,
          'user': {
            'id': 'usr_demo',
            'username': 'demo',
            'display_name': 'Ana Pérez',
            'role': 'ADMIN',
            'active': true,
          },
          'permissions': ['admin.full', 'orders.read', 'chats.reply', 'sales.cancel'],
        };
      } else if (path.endsWith('/messages')) {
        body = _messages();
      } else if (path.endsWith('/api/admin/data')) {
        body = _snapshot();
      } else {
        body = {'ok': true};
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Igual que `main.dart` del CRM: sin esto, los `DateFormat('es')` fallan.
  await initializeDateFormatting('es', null);
  final api = ApiClient(
    httpClient: _client(),
    baseUrl: 'http://127.0.0.1:8791',
    sessionStore: MemorySessionStore('harness-session'),
  );
  final state = CrmState(CrmRepository(api));
  await state.login('demo', 'demo');

  runApp(_HarnessApp(state: state));
}

class _HarnessApp extends StatelessWidget {
  const _HarnessApp({required this.state});

  final CrmState state;

  @override
  Widget build(BuildContext context) {
    return CrmScope(
      state: state,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: CrmTheme.build(Brightness.light),
        darkTheme: CrmTheme.build(Brightness.dark),
        themeMode: _mode == 'dark' ? ThemeMode.dark : ThemeMode.light,
        home: const _HarnessHome(),
      ),
    );
  }
}

class _HarnessHome extends StatefulWidget {
  const _HarnessHome();

  @override
  State<_HarnessHome> createState() => _HarnessHomeState();
}

class _HarnessHomeState extends State<_HarnessHome> {
  late String _tab = _initialTab();
  bool _collapsed = false;

  static String _initialTab() {
    final value = Platform.environment['HARNESS_MODULE'] ?? '';
    return value.isEmpty ? 'hoy' : value;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final state = CrmScope.of(context);

    switch (_view) {
      case 'chats':
        return Scaffold(backgroundColor: p.pageBg, body: const ChatsDesktopScreen());
      case 'gallery':
        return Scaffold(backgroundColor: p.pageBg, body: const _Gallery());
      default:
        return Scaffold(
          backgroundColor: p.pageBg,
          body: Row(
            children: [
              CrmSidebar(
                current: _tab,
                onSelect: (value) => setState(() => _tab = value),
                collapsed: _collapsed,
                unread: state.unreadTotal,
              ),
              Expanded(
                child: Column(
                  children: [
                    CrmTopbar(
                      title: crmDestinations.firstWhere((row) => row.tab == _tab).label,
                      subtitle: crmTopbarSubtitle(_tab, state),
                      collapsed: _collapsed,
                      onToggleSidebar: () => setState(() => _collapsed = !_collapsed),
                      state: state,
                    ),
                    Expanded(
                      child: _tab == 'hoy'
                          ? _Dashboard(tab: _tab)
                          : _ModuleBody(tab: _tab),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
    }
  }
}

/// Contenido de muestra con los componentes compartidos reales.
class _Dashboard extends StatelessWidget {
  const _Dashboard({required this.tab});

  final String tab;

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final orders = state.orders;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      children: [
        const CrmPageHeader(title: 'Hoy', subtitle: 'Lo que hay que atender ahora mismo'),
        StatGrid(
          children: [
            StatTile(label: 'Pedidos abiertos', value: '${orders.length}', icon: Icons.receipt_long_outlined),
            StatTile(label: 'Entregados', value: '7', tone: p.success, icon: Icons.local_shipping_outlined),
            StatTile(label: 'Cobrado', value: 'RD\$ 1,379', tone: p.success, icon: Icons.payments_outlined),
            StatTile(label: 'Por cobrar', value: 'RD\$ 482', tone: p.warning, icon: Icons.hourglass_bottom_rounded),
          ],
        ),
        SectionCard(
          title: 'Pedidos recientes',
          trailing: const StatusPill(label: 'en vivo', dense: true),
          child: Column(
            children: [
              for (final order in orders)
                CrmListTile(
                  title: '${order.name} · ${order.label}',
                  subtitle: '${order.status} · ${order.variantName}',
                  leading: CrmAvatar(label: order.name, icon: Icons.shopping_bag_outlined),
                  trailing: Text(order.total.toStringAsFixed(2)),
                ),
            ],
          ),
        ),
        const CrmNotice(message: 'Vista de diseño con datos de mentira: no hay backend detrás.'),
      ],
    );
  }
}

class _Gallery extends StatelessWidget {
  const _Gallery();

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const CrmPageHeader(title: 'Sistema de diseño', subtitle: 'Componentes compartidos'),
        SectionCard(
          title: 'Botones',
          child: Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              CrmButton(label: 'Guardar', icon: Icons.check_rounded, onPressed: () {}),
              CrmButton(label: 'Cancelar', filled: false, onPressed: () {}),
              CrmButton(label: 'Peligro', tone: p.danger, onPressed: () {}),
              CrmButton(label: 'Deshabilitado', onPressed: null),
            ],
          ),
        ),
        SectionCard(
          title: 'Estados',
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              StatusPill(label: 'nuevo'),
              StatusPill(label: 'confirmado', color: p.primary),
              StatusPill(label: 'entregado', color: p.success),
              StatusPill(label: 'por verificar', color: p.warning),
              StatusPill(label: 'cancelado', color: p.danger),
            ],
          ),
        ),
        SectionCard(
          title: 'Formulario',
          child: Column(
            children: [
              const TextField(decoration: InputDecoration(labelText: 'Nombre del cliente')),
              const SizedBox(height: 12),
              const TextField(decoration: InputDecoration(labelText: 'Teléfono', hintText: '+1 809 000 0000')),
              const SizedBox(height: 12),
              CrmSearchField(controller: TextEditingController(), hint: 'Buscar pedido'),
            ],
          ),
        ),
        SectionCard(
          title: 'Listas',
          child: Column(
            children: [
              CrmListTile(
                title: 'María Rodríguez · #PE-1042',
                subtitle: 'nuevo · Frasco 30 cápsulas',
                leading: const CrmAvatar(label: 'MR'),
                trailing: const StatusPill(label: 'abierto', color: CrmColors.success),
              ),
              CrmListTile(
                title: 'Luis Peña · #PE-1041',
                subtitle: 'confirmado · Transferencia',
                leading: const CrmAvatar(label: 'LP'),
                trailing: const StatusPill(label: 'por cobrar', color: CrmColors.warning),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Módulos REALES del producto (no rejilla de muestra) para capturas por
/// pantalla con los mismos datos de mentira.
class _ModuleBody extends StatelessWidget {
  const _ModuleBody({required this.tab});

  final String tab;

  @override
  Widget build(BuildContext context) {
    return switch (tab) {
      'whatsapp' => const ChatsDesktopScreen(),
      'pedidos' => const PedidosScreen(),
      'clientes' => const ClientesScreen(),
      'pos' => const PosScreen(embedded: true),
      'inventario' => const InventarioScreen(),
      'custodia' => const CustodiaScreen(),
      'repartidores' => const RepartidoresScreen(),
      'cierre' => const CierreScreen(),
      'reportes' => const ReportesScreen(),
      'usuarios' => const UsuariosScreen(),
      'hoy' => HoyScreen(onNavigate: (_) {}),
      _ => HoyScreen(onNavigate: (_) {}),
    };
  }
}


