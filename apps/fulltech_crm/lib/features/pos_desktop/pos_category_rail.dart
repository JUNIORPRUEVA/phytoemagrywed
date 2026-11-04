import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';

import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';

/// Disponibilidad que se puede filtrar en el rail (datos reales del catálogo).
enum PosAvailability { all, inStock, outOfStock }

/// Filtro activo del rail de categorías.
class PosRailFilter {
  const PosRailFilter({
    this.category = '',
    this.availability = PosAvailability.all,
  });

  /// Categoría real del catálogo (`category` / `kind` del producto). '' = todas.
  final String category;
  final PosAvailability availability;

  bool get isAll => category.isEmpty && availability == PosAvailability.all;

  @override
  bool operator ==(Object other) =>
      other is PosRailFilter &&
      other.category == category &&
      other.availability == availability;

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
      for (var i = 0; i < categories.length; i++)
        PosRailEntry(
          categories[i],
          categoryIcons[i % categoryIcons.length],
          PosRailFilter(category: categories[i]),
          imageUrl: photoOf(categories[i]),
        ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final availabilityEntries = entries
        .where((entry) => entry.filter.category.isEmpty)
        .toList();
    final categoryEntries = entries
        .where((entry) => entry.filter.category.isNotEmpty)
        .toList();
    const gap = 6.0;
    const moreWidth = 96.0;

    double chipWidth(PosRailEntry entry) {
      final label = TextPainter(
        text: TextSpan(
          text: entry.label,
          style: const TextStyle(
            fontFamily: PosMetrics.fontFamily,
            fontSize: 11.5,
            fontWeight: FontWeight.w800,
          ),
        ),
        textDirection: Directionality.of(context),
        maxLines: 1,
      )..layout();
      if (entry.filter.category.isEmpty) {
        return switch (entry.label) {
          'Todos' => 54,
          'Con stock' => 78,
          _ => 78,
        };
      }
      return label.width + 60;
    }

    return SizedBox(
      height: 48,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final statusWidth =
              availabilityEntries.fold<double>(
                0,
                (sum, entry) => sum + chipWidth(entry),
              ) +
              gap * (availabilityEntries.length - 1);
          final categorySpace = (constraints.maxWidth - statusWidth - gap)
              .clamp(0, double.infinity);
          final compactMoreWidth = categorySpace < moreWidth ? 40.0 : moreWidth;
          final visibleCategories = <PosRailEntry>[];
          var usedWidth = 0.0;
          for (final entry in categoryEntries) {
            final nextWidth =
                chipWidth(entry) + (visibleCategories.isEmpty ? 0 : gap);
            if (usedWidth + nextWidth > categorySpace) break;
            visibleCategories.add(entry);
            usedWidth += nextWidth;
          }
          while (visibleCategories.isNotEmpty &&
              visibleCategories.length < categoryEntries.length &&
              usedWidth + gap + compactMoreWidth > categorySpace) {
            final removed = visibleCategories.removeLast();
            usedWidth -=
                chipWidth(removed) + (visibleCategories.isEmpty ? 0 : gap);
          }
          final hiddenCategories = categoryEntries
              .skip(visibleCategories.length)
              .toList();

          return Row(
            children: [
              for (
                var index = 0;
                index < availabilityEntries.length;
                index++
              ) ...[
                if (index > 0) const SizedBox(width: gap),
                _StripChip(
                  entry: availabilityEntries[index],
                  selected: availabilityEntries[index].filter == selected,
                  onTap: () => onSelect(availabilityEntries[index].filter),
                ),
              ],
              if (categoryEntries.isNotEmpty) const SizedBox(width: gap),
              for (
                var index = 0;
                index < visibleCategories.length;
                index++
              ) ...[
                if (index > 0) const SizedBox(width: gap),
                _StripChip(
                  entry: visibleCategories[index],
                  selected: visibleCategories[index].filter == selected,
                  onTap: () => onSelect(visibleCategories[index].filter),
                ),
              ],
              if (hiddenCategories.isNotEmpty) ...[
                if (visibleCategories.isNotEmpty) const SizedBox(width: gap),
                PopupMenuButton<PosRailFilter>(
                  tooltip: 'Ver más categorías',
                  onSelected: onSelect,
                  itemBuilder: (context) => [
                    for (final entry in hiddenCategories)
                      PopupMenuItem(
                        value: entry.filter,
                        child: Text(entry.label),
                      ),
                  ],
                  child: Container(
                    height: PosMetrics.actionButtonHeight,
                    padding: EdgeInsets.symmetric(
                      horizontal: compactMoreWidth < moreWidth ? 6 : 8,
                    ),
                    decoration: BoxDecoration(
                      color: p.surface,
                      borderRadius: BorderRadius.circular(
                        PosMetrics.radiusButton,
                      ),
                      border: Border.all(color: p.border),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (compactMoreWidth >= moreWidth) ...[
                          Text(
                            'Ver más',
                            style: p.text.pill.copyWith(fontSize: 11.5),
                          ),
                          const SizedBox(width: 3),
                        ],
                        Icon(
                          Icons.expand_more_rounded,
                          size: 16,
                          color: p.inkSecondary,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _StripChip extends StatefulWidget {
  const _StripChip({
    required this.entry,
    required this.selected,
    required this.onTap,
  });

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
          width: widget.entry.filter.category.isEmpty
              ? switch (widget.entry.label) {
                  'Todos' => 54,
                  'Con stock' => 78,
                  _ => 78,
                }
              : null,
          padding: EdgeInsets.symmetric(
            horizontal: widget.entry.filter.category.isEmpty ? 4 : 8,
            vertical: 4,
          ),
          decoration: BoxDecoration(
            color: selected
                ? p.primarySoft
                : (_hovered ? p.surfaceMuted : Colors.transparent),
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: selected ? p.primaryBorder : p.border),
          ),
          child: Row(
            mainAxisSize: widget.entry.filter.category.isEmpty
                ? MainAxisSize.max
                : MainAxisSize.min,
            mainAxisAlignment: widget.entry.filter.category.isEmpty
                ? MainAxisAlignment.center
                : MainAxisAlignment.start,
            children: [
              if (widget.entry.filter.category.isNotEmpty)
                PosRailThumb(
                  entry: widget.entry,
                  palette: p,
                  selected: selected,
                  ink: ink,
                  size: 26,
                )
              else
                const SizedBox.shrink(),
              if (widget.entry.filter.category.isNotEmpty)
                const SizedBox(width: 7),
              if (widget.entry.filter.category.isEmpty)
                Flexible(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      widget.entry.label,
                      style: TextStyle(
                        fontFamily: PosMetrics.fontFamily,
                        fontSize: 11.5,
                        fontWeight: selected
                            ? FontWeight.w800
                            : FontWeight.w600,
                        color: ink,
                      ),
                    ),
                  ),
                )
              else
                Text(
                  widget.entry.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
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
        child: FutureBuilder<ApiFile>(
          future: CrmScope.of(
            context,
            listen: false,
          ).repository.api.getFile(entry.imageUrl),
          builder: (context, snapshot) => snapshot.hasData
              ? Image.memory(
                  Uint8List.fromList(snapshot.data!.bytes),
                  width: size,
                  height: size,
                  fit: BoxFit.contain,
                )
              : _initials(),
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
          color: selected
              ? palette.onCheckout.withValues(alpha: 0.35)
              : palette.border,
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
