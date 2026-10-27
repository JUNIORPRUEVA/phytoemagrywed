import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../hoy/hoy_screen.dart' show CustomerTile;

/// Clientes: búsqueda por nombre o teléfono y filtro por etapa.
class ClientesScreen extends StatefulWidget {
  const ClientesScreen({super.key});

  @override
  State<ClientesScreen> createState() => _ClientesScreenState();
}

class _ClientesScreenState extends State<ClientesScreen> {
  final _search = TextEditingController();
  String _stage = 'todas';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Customer> _filtered(List<Customer> rows) {
    final query = _search.text.trim().toLowerCase();
    return rows.where((row) {
      if (_stage != 'todas' && row.stage.toLowerCase() != _stage) return false;
      if (query.isEmpty) return true;
      return row.name.toLowerCase().contains(query) ||
          row.phone.toLowerCase().contains(query) ||
          row.city.toLowerCase().contains(query);
    }).toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    // Si el paquete vino recortado, se piden los clientes completos una vez.
    if (state.partial && !state.customersComplete) {
      WidgetsBinding.instance.addPostFrameCallback((_) => state.ensureFullLists(includeConversations: false));
    }
    final rows = _filtered(state.customers);
    final desktop = context.isDesktop;
    final stages = [
      'todas',
      for (final row in state.customerStages) str(row['value'], '').toLowerCase(),
    ].where((value) => value.isNotEmpty).toSet().toList();

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: CrmSearchField(controller: _search, hint: 'Buscar cliente o teléfono', onChanged: (_) => setState(() {})),
        ),
        FilterChips(
          options: stages,
          value: _stage,
          onChanged: (value) => setState(() => _stage = value),
          labels: {for (final stage in stages) stage: stage == 'todas' ? 'Todas' : stage},
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
          child: Row(
            children: [
              Text('${rows.length} clientes', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.ink)),
              const Spacer(),
              Text(
                '${rows.where((row) => row.orders > 0).length} con compras',
                style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
              ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refresh,
            child: rows.isEmpty
                ? ListView(children: const [SizedBox(height: 40), EmptyState(title: 'Sin clientes con este filtro', icon: Icons.people_outline_rounded)])
                : Container(
                    margin: EdgeInsets.symmetric(horizontal: desktop ? 16 : 0),
                    decoration: BoxDecoration(
                      color: p.surface,
                      borderRadius: BorderRadius.circular(desktop ? 14 : 0),
                      border: desktop ? Border.all(color: p.border) : null,
                    ),
                    child: ListView.separated(
                      itemCount: rows.length,
                      separatorBuilder: (_, _) => Divider(height: 1, color: p.line, indent: 66),
                      itemBuilder: (context, index) => CustomerTile(customer: rows[index]),
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}
