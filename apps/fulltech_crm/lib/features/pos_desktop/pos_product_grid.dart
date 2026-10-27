import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';

/// Rejilla de productos del POS de escritorio, con la densidad de la captura
/// de FullPOS Cloud: tarjetas blancas compactas, precio y disponibilidad.
///
/// **Limitación real:** el catálogo que expone la API del CRM a este módulo
/// (`CatalogProduct` / `CatalogPresentation`) no trae imagen ni categoría, así
/// que la tarjeta muestra un marcador neutro (no se inventan fotos) y no hay
/// rail de categorías (no se inventan categorías).
class PosProductGrid extends StatelessWidget {
  const PosProductGrid({
    super.key,
    required this.products,
    required this.onAdd,
    this.loading = false,
    this.query = '',
  });

  final List<CatalogProduct> products;
  final void Function(CatalogProduct product, CatalogPresentation presentation) onAdd;
  final bool loading;
  final String query;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(
        child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: PosColors.primary)),
      );
    }
    final rows = query.isEmpty
        ? products
        : products.where((p) => p.name.toLowerCase().contains(query.toLowerCase())).toList();
    if (rows.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.inventory_2_outlined, size: 34, color: PosColors.inkSecondary),
            const SizedBox(height: 10),
            Text(
              query.isEmpty ? 'El catálogo está vacío.' : 'Ningún producto coincide con «$query».',
              style: PosText.secondary,
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
}

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
    final presentation = widget.presentation;
    final stock = presentation?.stock ?? 0;
    final stockKnown = widget.product.presentations.any((p) => p.stock > 0);
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
          color: PosColors.surface,
          borderRadius: BorderRadius.circular(PosMetrics.radiusCard),
          border: Border.all(color: _hovered ? PosColors.primaryBorder : PosColors.borderSoft),
          boxShadow: _hovered
              ? [BoxShadow(color: PosColors.primary.withValues(alpha: 0.10), blurRadius: 14, offset: const Offset(0, 6))]
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
                color: PosColors.surfaceMuted,
                borderRadius: BorderRadius.circular(6),
              ),
              child: const Icon(Icons.image_outlined, size: 26, color: Color(0xFFC3CDDB)),
            ),
            const SizedBox(height: 6),
            Expanded(
              child: Text(
                widget.product.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: PosText.cardName,
              ),
            ),
            Text(price, style: PosText.cardPrice, maxLines: 1),
            const SizedBox(height: 6),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: outOfStock ? const Color(0xFFFDECEE) : PosColors.primarySoft,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    outOfStock ? 'Sin stock' : (stockKnown ? 'Disp. $stock' : 'Disponible'),
                    style: PosText.pill.copyWith(color: outOfStock ? PosColors.danger : PosColors.primary),
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
            color: enabled ? PosColors.primarySoft : PosColors.surfaceMuted,
            border: Border.all(color: enabled ? PosColors.primaryBorder : PosColors.border),
          ),
          child: Icon(
            Icons.add_rounded,
            size: 16,
            color: enabled ? PosColors.primary : PosColors.inkSecondary,
          ),
        ),
      ),
    );
  }
}
