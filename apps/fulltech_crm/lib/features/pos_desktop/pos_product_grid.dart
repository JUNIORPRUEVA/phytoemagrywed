import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_tokens.dart';
import '../../core/net/api_client.dart';
import '../../data/models/crm_models.dart';
import '../common/pwa_icon.dart';
import 'pos_category_rail.dart';
import 'pos_tokens.dart';

final NumberFormat _catalogPriceFormat = NumberFormat('#,##0.00', 'en_US');

class PosStockInfo {
  const PosStockInfo.units(this.units) : service = false;
  const PosStockInfo.service() : units = null, service = true;

  final int? units;
  final bool service;
  bool get canAdd => service || (units != null && units! > 0);
  String get label => service
      ? 'Servicio'
      : units == null
      ? 'Por verificar'
      : units! > 0
      ? 'Disp. $units'
      : 'Sin stock';
}

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
    this.onQuickSale,
    this.favoriteProductIds = const {},
    this.onToggleFavorite,
    this.onAddFromCard,
    this.stockByVariant = const {},
  });

  final List<CatalogProduct> products;
  final void Function(CatalogProduct product, CatalogPresentation presentation)
  onAdd;
  final bool loading;
  final String query;

  /// Filtro del rail de categorías (categoría real + existencia).
  final PosRailFilter filter;

  /// Venta rápida (como en FullPOS Cloud): la PRIMERA tarjeta de la rejilla,
  /// sin imagen, que abre una venta fuera de inventario.
  final VoidCallback? onQuickSale;
  final Set<String> favoriteProductIds;
  final ValueChanged<CatalogProduct>? onToggleFavorite;
  final void Function(CatalogProduct, CatalogPresentation, Rect)? onAddFromCard;
  final Map<String, PosStockInfo> stockByVariant;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    if (loading && products.isEmpty) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: p.primary),
        ),
      );
    }
    final needle = query.trim().toLowerCase();
    final rows =
        products.where((product) {
          if (needle.isNotEmpty &&
              !product.name.toLowerCase().contains(needle) &&
              !product.id.toLowerCase().contains(needle) &&
              !product.presentations.any(
                (row) =>
                    row.id.toLowerCase().contains(needle) ||
                    row.name.toLowerCase().contains(needle),
              )) {
            return false;
          }
          if (filter.category.isNotEmpty) {
            final category = product.category.toLowerCase();
            if (category != filter.category.toLowerCase()) return false;
          }
          final availability = _availability(product, stockByVariant);
          return switch (filter.availability) {
            PosAvailability.all => true,
            PosAvailability.inStock => availability == _Availability.inStock,
            PosAvailability.outOfStock =>
              availability == _Availability.outOfStock,
          };
        }).toList()..sort((a, b) {
          final favoriteOrder =
              (favoriteProductIds.contains(b.id) ? 1 : 0) -
              (favoriteProductIds.contains(a.id) ? 1 : 0);
          return favoriteOrder != 0 ? favoriteOrder : a.name.compareTo(b.name);
        });
    if (rows.isEmpty && onQuickSale == null) {
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
      itemCount: rows.length + (onQuickSale == null ? 0 : 1),
      itemBuilder: (context, index) {
        if (onQuickSale != null) {
          if (index == 0) return PosQuickSaleCard(onTap: onQuickSale!);
          index -= 1;
        }
        final product = rows[index];
        final presentation = _sellable(product);
        return PosProductCard(
          product: product,
          presentation: presentation,
          stock: presentation == null
              ? const PosStockInfo.units(null)
              : stockByVariant[presentation.id] ??
                    const PosStockInfo.units(null),
          isFavorite: favoriteProductIds.contains(product.id),
          onToggleFavorite: onToggleFavorite == null
              ? null
              : () => onToggleFavorite!(product),
          onAddFromCard: onAddFromCard,
          onAdd:
              presentation == null ||
                  !(stockByVariant[presentation.id]?.canAdd ?? false)
              ? null
              : () => onAdd(product, presentation),
        );
      },
    );
  }

  /// Primera presentación vendible (activa y con existencias si el endpoint las
  /// informa). Si no hay, la tarjeta queda deshabilitada: no se inventa stock.
  static CatalogPresentation? _sellable(CatalogProduct product) {
    for (final presentation in product.presentations) {
      if (presentation.available) return presentation;
    }
    return null;
  }

  static _Availability _availability(
    CatalogProduct product,
    Map<String, PosStockInfo> stocks,
  ) {
    final sellable = _sellable(product);
    if (sellable == null) return _Availability.outOfStock;
    if (!(stocks[sellable.id]?.canAdd ?? false)) {
      return _Availability.outOfStock;
    }
    return _Availability.inStock;
  }
}

enum _Availability { inStock, outOfStock }

class PosProductCard extends StatefulWidget {
  const PosProductCard({
    super.key,
    required this.product,
    required this.presentation,
    this.stock,
    this.onAdd,
    this.isFavorite = false,
    this.onToggleFavorite,
    this.onAddFromCard,
  });

  final CatalogProduct product;
  final CatalogPresentation? presentation;
  final PosStockInfo? stock;
  final VoidCallback? onAdd;
  final bool isFavorite;
  final VoidCallback? onToggleFavorite;
  final void Function(CatalogProduct, CatalogPresentation, Rect)? onAddFromCard;

  @override
  State<PosProductCard> createState() => _PosProductCardState();
}

class _PosProductCardState extends State<PosProductCard> {
  bool _hovered = false;
  Future<ApiFile>? _image;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadImage();
  }

  @override
  void didUpdateWidget(PosProductCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.product.imageUrl != widget.product.imageUrl) _loadImage();
  }

  void _loadImage() {
    final url = widget.product.imageUrl;
    _image = url.isEmpty
        ? null
        : CrmScope.of(context, listen: false).repository.api.getFile(url);
  }

  void _add() {
    final presentation = widget.presentation;
    if (presentation == null) return;
    final addFromCard = widget.onAddFromCard;
    final renderObject = context.findRenderObject();
    if (addFromCard != null && renderObject is RenderBox) {
      addFromCard(
        widget.product,
        presentation,
        renderObject.localToGlobal(Offset.zero) & renderObject.size,
      );
      return;
    }
    widget.onAdd?.call();
  }

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final presentation = widget.presentation;
    final fallbackStock = presentation?.stock ?? 0;
    final stockLabel =
        widget.stock?.label ??
        (presentation == null || !presentation.available || fallbackStock <= 0
            ? 'Sin stock'
            : 'Stock $fallbackStock');
    final outOfStock =
        presentation == null ||
        !presentation.available ||
        !(widget.stock?.canAdd ?? (fallbackStock > 0));
    final price = presentation == null
        ? ''
        : _catalogPriceFormat.format(presentation.price);

    final card = AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(PosMetrics.radiusCard),
        border: Border.all(color: _hovered ? p.primaryBorder : p.borderSoft),
        boxShadow: _hovered
            ? [
                BoxShadow(
                  color: p.primary.withValues(alpha: 0.10),
                  blurRadius: 14,
                  offset: const Offset(0, 6),
                ),
              ]
            : null,
      ),
      padding: const EdgeInsets.all(8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Foto real si el catálogo la trae; si no, marcador neutro.
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: SizedBox(
              height: 103,
              width: double.infinity,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Container(
                    color: p.surface,
                    child: widget.product.imageUrl.isEmpty
                        ? Icon(
                            Icons.image_outlined,
                            size: 28,
                            color: p.inkSecondary.withValues(alpha: 0.6),
                          )
                        : FutureBuilder<ApiFile>(
                            future: _image,
                            builder: (context, snapshot) => snapshot.hasData
                                ? Image.memory(
                                    Uint8List.fromList(snapshot.data!.bytes),
                                    fit: BoxFit.contain,
                                  )
                                : Icon(
                                    Icons.image_outlined,
                                    size: 28,
                                    color: p.inkSecondary.withValues(
                                      alpha: 0.6,
                                    ),
                                  ),
                          ),
                  ),
                  if (widget.onToggleFavorite != null)
                    Positioned(
                      top: 6,
                      right: 6,
                      child: Material(
                        color: p.surface.withValues(alpha: 0.92),
                        shape: const CircleBorder(),
                        child: IconButton(
                          tooltip: widget.isFavorite
                              ? 'Quitar de fijados'
                              : 'Fijar primero',
                          onPressed: widget.onToggleFavorite,
                          icon: Icon(
                            widget.isFavorite
                                ? Icons.check_circle_rounded
                                : Icons.circle_outlined,
                            size: 17,
                            color: widget.isFavorite
                                ? p.primary
                                : p.inkSecondary,
                          ),
                          visualDensity: VisualDensity.compact,
                          constraints: const BoxConstraints.tightFor(
                            width: 32,
                            height: 32,
                          ),
                          padding: EdgeInsets.zero,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 5),
          SizedBox(
            height: 31,
            child: Text(
              widget.product.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: t.cardName,
            ),
          ),
          const SizedBox(height: 6),
          Text(price, maxLines: 1, style: t.cardPrice.copyWith(fontSize: 13)),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
            decoration: BoxDecoration(
              color: p.primarySoft,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    stockLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.pill.copyWith(
                      color: outOfStock ? p.ink : p.primary,
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                _AddButton(onTap: outOfStock ? null : _add),
              ],
            ),
          ),
        ],
      ),
    );

    // Toda la tarjeta es zona de clic: no hay que acertarle al «+».
    return MouseRegion(
      cursor: outOfStock ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: outOfStock ? null : _add,
        behavior: HitTestBehavior.opaque,
        child: card,
      ),
    );
  }
}

/// Primera tarjeta de la rejilla: venta rápida, sin imagen (como FullPOS).
class PosQuickSaleCard extends StatefulWidget {
  const PosQuickSaleCard({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  State<PosQuickSaleCard> createState() => _PosQuickSaleCardState();
}

class _PosQuickSaleCardState extends State<PosQuickSaleCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final p = PosPalette.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          decoration: BoxDecoration(
            color: const Color(0xFFEDEEF0),
            borderRadius: BorderRadius.circular(PosMetrics.radiusCard),
            border: Border.all(
              color: _hovered ? p.primary : const Color(0xFFD6D9DF),
            ),
            boxShadow: _hovered
                ? [
                    BoxShadow(
                      color: p.primary.withValues(alpha: 0.14),
                      blurRadius: 16,
                      offset: const Offset(0, 6),
                    ),
                  ]
                : null,
          ),
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFFE1E4E9),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  'Rápido',
                  style: p.text.pill.copyWith(color: const Color(0xFF334155)),
                ),
              ),
              const Spacer(),
              Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.shopping_cart_rounded,
                      size: 40,
                      color: Color(0xFF263344),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'VENTA RÁPIDA',
                      textAlign: TextAlign.center,
                      style: p.text.cardName.copyWith(
                        color: const Color(0xFF263344),
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
              const Spacer(),
              Align(
                alignment: Alignment.centerRight,
                child: CircleAvatar(
                  radius: 14,
                  backgroundColor: const Color(0xFFE0E9FA),
                  child: const Icon(
                    Icons.add,
                    color: Color(0xFF1957E6),
                    size: 19,
                  ),
                ),
              ),
            ],
          ),
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
