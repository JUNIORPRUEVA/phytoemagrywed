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

/// Franja horizontal de categorías, debajo del buscador.
///
/// Se construye SOLO con datos que existen: las categorías que traiga el
/// catálogo (`CatalogProduct.category`) y dos filtros reales de existencia; si
/// el API no las envía, muestra «Todos / Con stock / Agotados».
///
/// Cada categoría es una píldora con la miniatura del producto, su nombre y el
/// estado de selección. Los colores salen de `PosPalette.of(context)`.
class PosCategoryStrip extends StatelessWidget {
  const PosCategoryStrip({
    super.key,
    required this.entries,
    required this.selected,
    required this.onSelect,
  });

  final List<PosRailEntry> entries;
  final PosRailFilter selected;
  final ValueChanged<PosRailFilter> onSelect;

  /// Entradas de la franja a partir de las categorías reales del catálogo.
  ///
  /// Cada categoría lleva la foto del primer producto que la tenga; si no hay
  /// foto, la píldora muestra las iniciales.
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

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    return Container(
      height: 58,
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: p.border)),
      ),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        itemCount: entries.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final entry = entries[index];
          return _StripChip(
            entry: entry,
            selected: entry.filter == selected,
            onTap: () => onSelect(entry.filter),
          );
        },
      ),
    );
  }
}

class _StripChip extends StatefulWidget {
  const _StripChip({required this.entry, required this.selected, required this.onTap});

  final PosRailEntry entry;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_StripChip> createState() => _StripChipState();
}

class _StripChipState extends State<_StripChip> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final selected = widget.selected;
    final ink = selected ? p.primary : p.ink;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 130),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: selected
                ? p.primarySoft
                : (_hovered ? p.surfaceMuted : Colors.transparent),
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: selected ? p.primaryBorder : p.border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.entry.filter.availability == PosAvailability.all)
                PosRailThumb(entry: widget.entry, palette: p, selected: selected, ink: ink, size: 26)
              else
                SizedBox(
                  width: 26,
                  height: 26,
                  child: Center(child: PwaIcon(widget.entry.icon, size: 15, color: ink)),
                ),
              const SizedBox(width: 7),
              Text(
                widget.entry.label,
                style: TextStyle(
                  fontFamily: PosMetrics.fontFamily,
                  fontSize: 11.5,
                  fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                  color: ink,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Miniatura de la categoría: foto del producto si el catálogo la trae y, si
/// no, una baldosa con las iniciales (nunca un icono genérico cuando hay foto).
class PosRailThumb extends StatelessWidget {
  const PosRailThumb({
    super.key,
    required this.entry,
    required this.palette,
    required this.selected,
    required this.ink,
    this.size = 34,
  });

  final PosRailEntry entry;
  final PosPalette palette;
  final bool selected;
  final Color ink;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (entry.imageUrl.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(7),
        child: Image.network(
          entry.imageUrl,
          width: size,
          height: size,
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
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected
            ? palette.onCheckout.withValues(alpha: 0.18)
            : palette.surfaceMuted,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(
          color: selected ? palette.onCheckout.withValues(alpha: 0.35) : palette.border,
        ),
      ),
      child: Text(
        initials,
        style: TextStyle(
          fontFamily: PosMetrics.fontFamily,
          fontSize: size <= 26 ? 9.5 : 12,
          fontWeight: FontWeight.w800,
          color: ink,
        ),
      ),
    );
  }
}
