import 'package:flutter/material.dart';

import '../../core/theme/crm_tokens.dart';
import '../common/pwa_icon.dart';
import 'pos_tokens.dart';

/// Disponibilidad que se puede filtrar en el rail (datos reales del catálogo).
enum PosAvailability { all, inStock, outOfStock }

/// Filtro activo del rail de categorías.
class PosRailFilter {
  const PosRailFilter({this.category = '', this.availability = PosAvailability.all});

  /// Categoría real del catálogo (`category` / `kind` del producto). '' = todas.
  final String category;
  final PosAvailability availability;

  bool get isAll => category.isEmpty && availability == PosAvailability.all;

  @override
  bool operator ==(Object other) =>
      other is PosRailFilter && other.category == category && other.availability == availability;

  @override
  int get hashCode => Object.hash(category, availability);
}

/// Una entrada del rail: etiqueta, icono del PWA y filtro que aplica.
class PosRailEntry {
  const PosRailEntry(this.label, this.icon, this.filter);

  final String label;
  final String icon;
  final PosRailFilter filter;
}

/// Columna estrecha de categorías al estilo FullPOS Cloud.
///
/// Se construye SOLO con datos que existen: las categorías que traiga el
/// catálogo (`CatalogProduct.category`) y dos filtros reales de existencia.
/// No se inventan categorías: si el API no las envía, el rail muestra
/// «Todos / Disponibles / Agotados».
class PosCategoryRail extends StatelessWidget {
  const PosCategoryRail({
    super.key,
    required this.entries,
    required this.selected,
    required this.onSelect,
  });

  final List<PosRailEntry> entries;
  final PosRailFilter selected;
  final ValueChanged<PosRailFilter> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: PosMetrics.railWidth,
      decoration: const BoxDecoration(
        color: PosColors.surface,
        border: Border(right: BorderSide(color: PosColors.border)),
      ),
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
        itemCount: entries.length,
        itemBuilder: (context, index) {
          final entry = entries[index];
          return _RailTile(
            entry: entry,
            selected: entry.filter == selected,
            onTap: () => onSelect(entry.filter),
          );
        },
      ),
    );
  }

  /// Rail por defecto a partir de las categorías reales del catálogo.
  static List<PosRailEntry> buildEntries(List<String> categories) {
    const categoryIcons = [
      PwaIcons.billing,
      PwaIcons.delivery,
      PwaIcons.custody,
      PwaIcons.chart,
      PwaIcons.clientes,
      PwaIcons.couriers,
      PwaIcons.tickets,
      PwaIcons.robot,
      PwaIcons.support,
      PwaIcons.user,
      PwaIcons.usersadd,
    ];
    return [
      const PosRailEntry('Todos', PwaIcons.cart, PosRailFilter()),
      for (var i = 0; i < categories.length; i++)
        PosRailEntry(
          categories[i],
          categoryIcons[i % categoryIcons.length],
          PosRailFilter(category: categories[i]),
        ),
      const PosRailEntry(
        'Con stock',
        PwaIcons.orders,
        PosRailFilter(availability: PosAvailability.inStock),
      ),
      const PosRailEntry(
        'Agotados',
        PwaIcons.remove,
        PosRailFilter(availability: PosAvailability.outOfStock),
      ),
    ];
  }
}

class _RailTile extends StatefulWidget {
  const _RailTile({required this.entry, required this.selected, required this.onTap});

  final PosRailEntry entry;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_RailTile> createState() => _RailTileState();
}

class _RailTileState extends State<_RailTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    final ink = selected
        ? Colors.white
        : (_hovered ? PosColors.ink : PosColors.inkSecondary);
    return Tooltip(
      message: widget.entry.label,
      waitDuration: const Duration(milliseconds: 500),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: widget.onTap,
          behavior: HitTestBehavior.opaque,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            margin: const EdgeInsets.only(bottom: 4),
            padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 2),
            decoration: BoxDecoration(
              color: selected
                  ? PosColors.primary
                  : (_hovered ? PosColors.surfaceMuted : Colors.transparent),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                PwaIcon(widget.entry.icon, size: 19, color: ink),
                const SizedBox(height: 4),
                Text(
                  widget.entry.label,
                  maxLines: 2,
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: PosMetrics.fontFamily,
                    fontSize: 9.5,
                    height: 1.05,
                    fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                    color: ink,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
