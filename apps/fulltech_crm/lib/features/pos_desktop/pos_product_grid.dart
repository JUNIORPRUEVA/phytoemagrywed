import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/pwa_icon.dart';
import 'pos_category_rail.dart';
import 'pos_tokens.dart';

/// Rejilla de productos del POS de escritorio, con la densidad de la captura
/// de FullPOS Cloud: tarjetas compactas, precio y disponibilidad.
///
/// **Limitación real:** el catálogo que expone la API del CRM a este módulo
/// (`CatalogProduct` / `CatalogPresentation`) no trae imagen, así que la tarjeta
/// muestra un marcador neutro (no se inventan fotos).
///
/// Los colores salen de `PosPalette.of(context)`: claro u oscuro según lo que
/// haya configurado el usuario.
class PosProductGrid extends StatelessWidget {
  const PosProductGrid({
    super.key,
    required this.products,
    required this.onAdd,
    this.loading = false,
    this.query = '',
    this.filter = const PosRailFilter(),
  });

  final List<CatalogProduct> products;
  final void Function(CatalogProduct product, CatalogPresentation presentation) onAdd;
  final bool loading;
  final String query;

  /// Filtro del rail de categorías (categoría real + existencia).
  final PosRailFilter filter;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    if (loading) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: p.primary),
        ),
      );
    }
    final needle = query.trim().toLowerCase();
    final rows = products.where((product) {
      if (needle.isNotEmpty && !product.name.toLowerCase().contains(needle)) return false;
      if (filter.category.isNotEmpty) {
        final category = product.category.toLowerCase();
        if (category != filter.category.toLowerCase()) return false;
      }
      final availability = _availability(product);
      return switch (filter.availability) {
        PosAvailability.all => true,
        PosAvailability.inStock => availability == _Availability.inStock,
        PosAvailability.outOfStock => availability == _Availability.outOfStock,
      };
    }).toList();
    if (rows.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            PwaIcon(PwaIcons.orders, size: 30, color: p.inkSecondary),
            const SizedBox(height: 10),
            Text(
              needle.isNotEmpty
                  ? 'Ningún producto coincide con «$query».'
                  : (filter.isAll
                        ? 'El catálogo está vacío.'
                        : 'No hay productos con ese filtro.'),
              style: p.text.secondary,
            ),
          ],
        ),
      );
    }
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 16),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: PosMetrics.cardMaxWidth,
        mainAxisExtent: PosMetrics.cardHeight,
        mainAxisSpacing: PosMetrics.gridGap,
        crossAxisSpacing: PosMetrics.gridGap,
      ),
      itemCount: rows.length,
      itemBuilder: (context, index) {
        final product = rows[index];
        final presentation = _sellable(product);
        return PosProductCard(
          product: product,
          presentation: presentation,
          onAdd: presentation == null ? null : () => onAdd(product, presentation),
        );
      },
    );
  }

  /// Primera presentación vendible (activa y con existencias si el endpoint las
  /// informa). Si no hay, la tarjeta queda deshabilitada: no se inventa stock.
  static CatalogPresentation? _sellable(CatalogProduct product) {
    for (final presentation in product.presentations) {
      if (!presentation.available) continue;
      if (presentation.stock > 0 || presentation.stock == 0 && !_hasStockInfo(product)) return presentation;
    }
    for (final presentation in product.presentations) {
      if (presentation.available) return presentation;
    }
    return null;
  }

  static bool _hasStockInfo(CatalogProduct product) => product.presentations.any((p) => p.stock > 0);

  static _Availability _availability(CatalogProduct product) {
    final sellable = _sellable(product);
    if (sellable == null) return _Availability.outOfStock;
    if (_hasStockInfo(product) && sellable.stock <= 0) return _Availability.outOfStock;
    return _Availability.inStock;
  }
}

enum _Availability { inStock, outOfStock }

class PosProductCard extends StatefulWidget {
  const PosProductCard({super.key, required this.product, required this.presentation, this.onAdd});

  final CatalogProduct product;
  final CatalogPresentation? presentation;
  final VoidCallback? onAdd;

  @override
  State<PosProductCard> createState() => _PosProductCardState();
}

class _PosProductCardState extends State<PosProductCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final presentation = widget.presentation;
    final stock = presentation?.stock ?? 0;
    final stockKnown = widget.product.presentations.any((row) => row.stock > 0);
    final outOfStock = presentation == null ||
        !presentation.available ||
        (stockKnown && stock <= 0);
    final price = presentation == null ? '' : CrmFormat.money(presentation.price);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(PosMetrics.radiusCard),
          border: Border.all(color: _hovered ? p.primaryBorder : p.borderSoft),
          boxShadow: _hovered
              ? [BoxShadow(color: p.primary.withValues(alpha: 0.10), blurRadius: 14, offset: const Offset(0, 6))]
              : null,
        ),
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Marcador de imagen: la API no expone foto para el POS.
            Container(
              height: 96,
              width: double.infinity,
              decoration: BoxDecoration(
                color: p.surfaceMuted,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Icon(Icons.image_outlined, size: 26, color: p.inkSecondary.withValues(alpha: 0.6)),
            ),
            const SizedBox(height: 6),
            Expanded(
              child: Text(
                widget.product.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: t.cardName,
              ),
            ),
            Text(price, style: t.cardPrice, maxLines: 1),
            const SizedBox(height: 6),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: outOfStock ? p.danger.withValues(alpha: 0.14) : p.primarySoft,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    outOfStock ? 'Sin stock' : (stockKnown ? 'Disp. $stock' : 'Disponible'),
                    style: t.pill.copyWith(color: outOfStock ? p.danger : p.primary),
                  ),
                ),
                const Spacer(),
                _AddButton(onTap: outOfStock ? null : widget.onAdd),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AddButton extends StatelessWidget {
  const _AddButton({this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final enabled = onTap != null;
    return Tooltip(
      message: enabled ? 'Agregar al ticket' : 'Sin disponibilidad',
      waitDuration: const Duration(milliseconds: 500),
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: enabled ? p.primarySoft : p.surfaceMuted,
            border: Border.all(color: enabled ? p.primaryBorder : p.border),
          ),
          child: PwaIcon(
            PwaIcons.plus,
            size: 13,
            color: enabled ? p.primary : p.inkSecondary,
          ),
        ),
      ),
    );
  }
}
