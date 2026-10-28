import 'package:flutter/material.dart';

import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
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

/// Una entrada del rail: etiqueta, icono del PWA, foto del producto y filtro.
class PosRailEntry {
  const PosRailEntry(this.label, this.icon, this.filter, {this.imageUrl = ''});

  final String label;
  final String icon;

  /// Foto representativa del producto (vacía si el catálogo no la envía).
  final String imageUrl;
  final PosRailFilter filter;
}

/// Columna estrecha de categorías al estilo FullPOS Cloud.
///
/// Se construye SOLO con datos que existen: las categorías que traiga el
/// catálogo (`CatalogProduct.category`) y dos filtros reales de existencia.
/// No se inventan categorías: si el API no las envía, el rail muestra
/// «Todos / Con stock / Agotados».
///
/// Los colores salen de `PosPalette.of(context)`, así que el rail es claro u
/// oscuro según el tema que haya elegido el usuario.
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
    final p = PosPalette.of(context);
    return Container(
      width: PosMetrics.railWidth,
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(right: BorderSide(color: p.border)),
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
  ///
  /// Cada categoría lleva la foto del primer producto que la tenga; así la
  /// columna se ve como la referencia (miniaturas de producto) y no como una
  /// fila de iconos genéricos.
  static List<PosRailEntry> buildEntries(
    List<CatalogProduct> products,
    List<String> categories,
  ) {
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
    String photoOf(String category) {
      for (final product in products) {
        if (product.category.toLowerCase() != category.toLowerCase()) continue;
        if (product.imageUrl.isNotEmpty) return product.imageUrl;
      }
      return '';
    }

    return [
      PosRailEntry(
        'Todos',
        PwaIcons.cart,
        const PosRailFilter(),
        imageUrl: products.isEmpty ? '' : products.first.imageUrl,
      ),
      for (var i = 0; i < categories.length; i++)
        PosRailEntry(
          categories[i],
          categoryIcons[i % categoryIcons.length],
          PosRailFilter(category: categories[i]),
          imageUrl: photoOf(categories[i]),
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
    final p = PosPalette.of(context);
    final selected = widget.selected;
    // Sobre el acento sólido el icono va en blanco; si no, tinta del tema.
    final ink = selected
        ? p.onCheckout
        : (_hovered ? p.ink : p.inkSecondary);
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
                  ? p.checkout
                  : (_hovered ? p.surfaceMuted : Colors.transparent),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Categorías con miniatura de producto; los filtros de
                // existencia siguen con su icono.
                if (widget.entry.filter.availability == PosAvailability.all)
                  _RailThumb(
                    entry: widget.entry,
                    palette: p,
                    selected: selected,
                    ink: ink,
                  )
                else
                  SizedBox(
                    height: 34,
                    child: Center(
                      child: PwaIcon(widget.entry.icon, size: 19, color: ink),
                    ),
                  ),
                const SizedBox(height: 4),
                Text(
                  widget.entry.label,
                  maxLines: 2,
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: PosMetrics.fontFamily,
                    fontSize: 9.2,
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

/// Miniatura de la categoría: foto del producto si el catálogo la trae y, si
/// no, una baldosa con las iniciales (nunca un icono genérico cuando hay foto).
class _RailThumb extends StatelessWidget {
  const _RailThumb({
    required this.entry,
    required this.palette,
    required this.selected,
    required this.ink,
  });

  final PosRailEntry entry;
  final PosPalette palette;
  final bool selected;
  final Color ink;

  static const double _size = 34;

  @override
  Widget build(BuildContext context) {
    if (entry.imageUrl.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Image.network(
          entry.imageUrl,
          width: _size,
          height: _size,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stack) => _initials(),
        ),
      );
    }
    return _initials();
  }

  Widget _initials() {
    final label = entry.label.trim();
    final initials = label.isEmpty
        ? '?'
        : label
              .split(RegExp(r'\s+'))
              .take(2)
              .map((word) => word[0].toUpperCase())
              .join();
    return Container(
      width: _size,
      height: _size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected
            ? palette.onCheckout.withValues(alpha: 0.18)
            : palette.surfaceMuted,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: selected ? palette.onCheckout.withValues(alpha: 0.35) : palette.border,
        ),
      ),
      child: Text(
        initials,
        style: TextStyle(
          fontFamily: PosMetrics.fontFamily,
          fontSize: 12,
          fontWeight: FontWeight.w800,
          color: ink,
        ),
      ),
    );
  }
}
