import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';
import 'pos_screen.dart';

/// Facturación: el catálogo real con precios y existencias.
class CatalogoScreen extends StatefulWidget {
  const CatalogoScreen({super.key});

  @override
  State<CatalogoScreen> createState() => _CatalogoScreenState();
}

class _CatalogoScreenState extends State<CatalogoScreen> {
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final desktop = context.isDesktop;

    return Column(
      children: [
        CrmPageHeader(
          title: 'Facturación',
          subtitle: 'Catálogo, precios y existencias',
          actions: const [PosLaunchButton()],
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          child: CrmSearchField(controller: _search, hint: 'Buscar producto', onChanged: (_) => setState(() {})),
        ),
        Expanded(
          child: RemoteLoader<Map<String, dynamic>>(
            load: state.repository.catalog,
            loadingLabel: 'Cargando catálogo',
            builder: (context, data, reload) {
              final products = listv(data['catalog']).map(CatalogProduct.fromJson).toList();
              final query = _search.text.trim().toLowerCase();
              final visible = products.where((product) {
                if (query.isEmpty) return true;
                return product.name.toLowerCase().contains(query) ||
                    product.presentations.any((row) => row.name.toLowerCase().contains(query));
              }).toList();

              if (visible.isEmpty) {
                return ListView(children: const [SizedBox(height: 40), EmptyState(title: 'Sin productos', icon: Icons.inventory_2_outlined)]);
              }

              return ListView(
                padding: const EdgeInsets.only(bottom: 24),
                children: [
                  for (final product in visible)
                    SectionCard(
                      title: product.name,
                      trailing: Text(
                        '${product.presentations.length} presentaciones',
                        style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                      ),
                      child: Column(
                        children: [
                          for (final presentation in product.presentations)
                            Container(
                              margin: const EdgeInsets.only(bottom: 6),
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                              decoration: BoxDecoration(
                                color: p.surfaceMuted,
                                borderRadius: BorderRadius.circular(CrmRadii.sm),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(presentation.name, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: p.ink)),
                                        if (presentation.capsules.isNotEmpty)
                                          Text('${presentation.capsules} cápsulas', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                                      ],
                                    ),
                                  ),
                                  StatusPill(
                                    label: presentation.available ? 'disponible' : 'agotado',
                                    dense: true,
                                    color: presentation.available ? p.success : p.danger,
                                  ),
                                  const SizedBox(width: 10),
                                  SizedBox(
                                    width: 84,
                                    child: Text(
                                      CrmFormat.money(presentation.salePriceCents / 100),
                                      textAlign: TextAlign.right,
                                      style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: p.ink),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  if (desktop)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Text(
                        'Para cobrar una venta usa el POS del panel web o crea el pedido desde la conversación.',
                        style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
