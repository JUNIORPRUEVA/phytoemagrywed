import 'package:flutter/material.dart';

import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';

/// Piezas compartidas por todas las pantallas del CRM.
///
/// Todo sale de la paleta del tema: si algo se ve mal de noche se arregla en
/// `crm_theme.dart`, no escribiendo un color nuevo aquí.

/// Cabecera de pantalla con título, subtítulo y acciones.
class CrmPageHeader extends StatelessWidget {
  const CrmPageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.actions = const [],
    this.onBack,
  });

  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final theme = Theme.of(context);
    /*
     * En escritorio el nombre del módulo ya está en la barra superior del shell,
     * así que repetirlo aquí en grande era duplicar el título (dos «Hoy»
     * seguidos). Se deja una franja compacta con el subtítulo y las acciones.
     */
    final desktop = context.isDesktop;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, desktop ? 4 : 10, 12, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (onBack != null) ...[
            IconButton(
              onPressed: onBack,
              icon: const Icon(Icons.arrow_back_rounded),
              tooltip: 'Volver',
              color: p.ink,
            ),
            const SizedBox(width: 2),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!desktop) Text(title, style: theme.textTheme.headlineSmall),
                if ((subtitle ?? '').isNotEmpty)
                  Padding(
                    padding: EdgeInsets.only(top: desktop ? 0 : 2),
                    child: Text(subtitle!, style: theme.textTheme.bodySmall),
                  ),
              ],
            ),
          ),
          ...actions,
        ],
      ),
    );
  }
}

/// Tarjeta con título opcional. El contenedor base de casi todo.
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    this.title,
    this.trailing,
    required this.child,
    this.padding = const EdgeInsets.all(14),
    this.margin = const EdgeInsets.fromLTRB(12, 12, 12, 12),
  });

  final String? title;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;
  final EdgeInsets margin;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Container(
      margin: margin,
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(CrmRadii.md),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Padding(
              padding: EdgeInsets.fromLTRB(padding.left, padding.top, padding.right, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Text(title!, style: Theme.of(context).textTheme.titleMedium),
                  ),
                  ?trailing,
                ],
              ),
            ),
          Padding(padding: padding, child: child),
        ],
      ),
    );
  }
}

/// Tarjeta de recuento (las del inicio «Hoy»).
class StatTile extends StatelessWidget {
  const StatTile({
    super.key,
    required this.label,
    required this.value,
    this.hint,
    this.icon,
    this.tone,
    this.onTap,
  });

  final String label;
  final String value;
  final String? hint;
  final IconData? icon;
  final Color? tone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final accent = tone ?? p.primary;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(CrmRadii.md),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(CrmRadii.md),
          border: Border.all(color: p.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (icon != null) ...[
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(color: accent.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(CrmRadii.sm)),
                    child: Icon(icon, size: 17, color: accent),
                  ),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(color: p.inkSecondary),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(value, style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800, color: p.ink, height: 1.1)),
            if ((hint ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(hint!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
              ),
          ],
        ),
      ),
    );
  }
}

/// Etiqueta de estado (etapa del cliente, estado del pedido, avisos).
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, this.color, this.dense = false, this.solid = false});

  final String label;
  final Color? color;
  final bool dense;
  final bool solid;

  static Color toneFor(String value, BuildContext context) {
    final p = context.crm;
    final key = value.toLowerCase();
    if (const {'entregado', 'pagado', 'resuelto', 'activo', 'activa', 'recompra', 'aprobado'}.contains(key)) return p.success;
    if (const {'cancelado', 'devuelto', 'vencido', 'fallido', 'rechazado', 'bloqueado'}.contains(key)) return p.danger;
    if (const {'pendiente', 'por_cobrar', 'espera', 'en_camino', 'nuevo', 'interesado', 'revision'}.contains(key)) return p.warning;
    if (const {'cliente', 'confirmado', 'en_preparacion'}.contains(key)) return p.primary;
    return p.inkSecondary;
  }

  @override
  Widget build(BuildContext context) {
    final accent = color ?? toneFor(label, context);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 8 : 10, vertical: dense ? 3 : 5),
      decoration: BoxDecoration(
        color: solid ? accent : accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(CrmRadii.pill),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: dense ? 11 : 12,
          fontWeight: FontWeight.w700,
          color: solid ? Colors.white : accent,
          height: 1.15,
        ),
      ),
    );
  }
}

/// Aviso interno de una tarjeta o pantalla.
class CrmNotice extends StatelessWidget {
  const CrmNotice({super.key, required this.message, this.tone, this.icon = Icons.info_outline_rounded});

  final String message;
  final Color? tone;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final accent = tone ?? p.warning;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(CrmRadii.md),
        border: Border.all(color: accent.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: accent),
          const SizedBox(width: 8),
          Expanded(child: Text(message, style: TextStyle(fontSize: 12.5, color: p.ink, height: 1.35))),
        ],
      ),
    );
  }
}

/// Fila de lista tipo panel (avatar, título, subtítulo, cola).
class CrmListTile extends StatelessWidget {
  const CrmListTile({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.badge,
    this.highlight = false,
  });

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final String? badge;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final text = Theme.of(context).textTheme;
    return Material(
      color: highlight ? p.primaryTint : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (leading != null) ...[leading!, const SizedBox(width: 12)],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: text.titleSmall?.copyWith(fontSize: 14.5),
                          ),
                        ),
                        if ((badge ?? '').isNotEmpty) ...[
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(color: p.primary, borderRadius: BorderRadius.circular(CrmRadii.pill)),
                            child: Text(badge!, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                          ),
                        ],
                      ],
                    ),
                    if ((subtitle ?? '').isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          subtitle!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodySmall?.copyWith(fontSize: 12.5),
                        ),
                      ),
                  ],
                ),
              ),
              if (trailing != null) ...[const SizedBox(width: 10), trailing!],
            ],
          ),
        ),
      ),
    );
  }
}

/// Círculo con iniciales (clientes y usuarios).
class CrmAvatar extends StatelessWidget {
  const CrmAvatar({super.key, required this.label, this.size = 40, this.tone, this.icon});

  final String label;
  final double size;
  final Color? tone;
  final IconData? icon;

  String get _initials {
    final source = label.trim();
    if (source.isEmpty) return '?';
    final parts = source.split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    if (parts.length == 1) return parts.first.substring(0, parts.first.length >= 2 ? 2 : 1).toUpperCase();
    return '${parts.first.substring(0, 1)}${parts.last.substring(0, 1)}'.toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final accent = tone ?? p.primary;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: accent.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(size / 2.4)),
      child: icon != null
          ? Icon(icon, size: size * 0.5, color: accent)
          : Text(_initials, style: TextStyle(fontSize: size * 0.34, fontWeight: FontWeight.w800, color: accent)),
    );
  }
}

/// Estado vacío con icono, título y explicación.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.message, this.icon = Icons.inbox_rounded, this.action});

  final String title;
  final String? message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 36),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 62,
              height: 62,
              decoration: BoxDecoration(color: p.chipBg, borderRadius: BorderRadius.circular(20)),
              child: Icon(icon, size: 30, color: p.inkSecondary),
            ),
            const SizedBox(height: 14),
            Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
            if ((message ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(message!, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
              ),
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

/// Bloque de error con botón de reintento.
class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 34, color: p.danger),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center, style: TextStyle(color: p.ink, fontSize: 13.5)),
            if (onRetry != null) ...[
              const SizedBox(height: 14),
              FilledButton.tonal(onPressed: onRetry, child: const Text('Reintentar')),
            ],
          ],
        ),
      ),
    );
  }
}

/// Cargando (una sola rueda, sin esqueletos ruidosos).
class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(strokeWidth: 2.4, color: p.primary),
            ),
            if ((label ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(label!, style: Theme.of(context).textTheme.bodySmall),
              ),
          ],
        ),
      ),
    );
  }
}

/// Buscador del panel.
class CrmSearchField extends StatelessWidget {
  const CrmSearchField({
    super.key,
    required this.controller,
    this.hint = 'Buscar',
    this.onChanged,
    this.onClear,
  });

  final TextEditingController controller;
  final String hint;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return TextField(
      controller: controller,
      onChanged: onChanged,
      textInputAction: TextInputAction.search,
      style: TextStyle(fontSize: 14, color: p.ink),
      decoration: InputDecoration(
        hintText: hint,
        prefixIcon: Icon(Icons.search_rounded, size: 20, color: p.inkSecondary),
        suffixIcon: controller.text.isEmpty
            ? null
            : IconButton(
                icon: const Icon(Icons.close_rounded, size: 18),
                onPressed: () {
                  controller.clear();
                  onClear?.call();
                  onChanged?.call('');
                },
              ),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 12),
      ),
    );
  }
}

/// Fila de filtros tipo chips (bandeja, pedidos, clientes).
class FilterChips extends StatelessWidget {
  const FilterChips({super.key, required this.options, required this.value, required this.onChanged, this.labels = const {}});

  final List<String> options;
  final String value;
  final ValueChanged<String> onChanged;
  final Map<String, String> labels;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: options.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final option = options[index];
          final selected = option == value;
          return ChoiceChip(
            selected: selected,
            onSelected: (_) => onChanged(option),
            showCheckmark: false,
            label: Text(labels[option] ?? option),
            labelStyle: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: selected ? (Theme.of(context).brightness == Brightness.dark ? const Color(0xFF0B1424) : Colors.white) : p.ink,
            ),
            selectedColor: p.primary,
            backgroundColor: p.chipBg,
            side: BorderSide.none,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.pill)),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
          );
        },
      ),
    );
  }
}

/// Botón primario del panel (alto mínimo 44 px, regla de la casa).
class CrmButton extends StatelessWidget {
  const CrmButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.filled = true,
    this.tone,
    this.expand = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool filled;
  final Color? tone;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final accent = tone ?? p.primary;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[Icon(icon, size: 18), const SizedBox(width: 8)],
        Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis)),
      ],
    );
    final style = ButtonStyle(
      minimumSize: WidgetStatePropertyAll(Size(0, CrmSpace.touch)),
      padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 16)),
      shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(CrmRadii.md))),
      textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
    );
    if (filled) {
      return FilledButton(
        onPressed: onPressed,
        style: style.copyWith(
          backgroundColor: WidgetStatePropertyAll(accent),
          foregroundColor: WidgetStatePropertyAll(Theme.of(context).brightness == Brightness.dark ? const Color(0xFF0B1424) : Colors.white),
        ),
        child: child,
      );
    }
    return OutlinedButton(
      onPressed: onPressed,
      style: style.copyWith(
        foregroundColor: WidgetStatePropertyAll(accent),
        side: WidgetStatePropertyAll(BorderSide(color: accent.withValues(alpha: 0.45))),
      ),
      child: child,
    );
  }
}

/// Rejilla de tarjetas que se adapta al ancho (1, 2 o 4 columnas).
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.children, this.minTileWidth = 150});

  final List<Widget> children;
  final double minTileWidth;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = (constraints.maxWidth / minTileWidth).floor().clamp(2, 4);
        /*
         * Alto FIJO de la tarjeta (no proporcional al ancho): en 1920 px una
         * rejilla con `childAspectRatio` producía tarjetas de 300 px de alto con
         * medio metro de aire dentro. El POS usa tarjetas compactas y alineadas
         * con el resto de la página, así que se fija la altura y se quita el
         * relleno lateral (la página ya tiene su margen).
         */
        return GridView(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            mainAxisExtent: 96,
          ),
          children: children,
        );
      },
    );
  }
}

/// Diálogo de confirmación simple (acciones destructivas).
Future<bool> crmConfirm(BuildContext context, {required String title, required String message, String confirmLabel = 'Confirmar'}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(confirmLabel)),
      ],
    ),
  );
  return result ?? false;
}

/// Aviso flotante corto.
void crmToast(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 3)));
}
