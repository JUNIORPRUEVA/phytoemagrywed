import 'package:flutter/material.dart';

import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';

/// Icono del panel dibujado con el **PNG original del PWA**.
///
/// Los iconos de `public/admin/assets/icons` son siluetas negras con
/// transparencia, así que se tiñen con [color] igual que el panel (que los usa
/// como máscara). Nunca se sustituyen por iconos Material si existe el original.
class PwaIcon extends StatelessWidget {
  const PwaIcon(
    this.asset, {
    super.key,
    this.size = 20,
    this.color,
    this.opacity = 1,
  });

  final String asset;
  final double size;
  final Color? color;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? context.crm.ink;
    return SizedBox(
      width: size,
      height: size,
      child: Opacity(
        opacity: opacity,
        child: Image.asset(
          asset,
          width: size,
          height: size,
          fit: BoxFit.contain,
          color: tint,
          colorBlendMode: BlendMode.srcIn,
          filterQuality: FilterQuality.medium,
          isAntiAlias: true,
        ),
      ),
    );
  }
}

/// Icono dentro de la píldora de color de una métrica del PWA
/// (42×42, radio 11, fondo suave, glifo del color del estado).
class PwaIconTile extends StatelessWidget {
  const PwaIconTile(this.asset, {super.key, required this.tint, required this.background, this.size = CrmShellMetrics.statIconBox});

  final String asset;
  final Color tint;
  final Color background;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(11)),
      child: Center(child: PwaIcon(asset, size: size * 0.5, color: tint)),
    );
  }
}
