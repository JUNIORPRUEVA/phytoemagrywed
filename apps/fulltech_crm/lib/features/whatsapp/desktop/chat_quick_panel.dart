import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'chat_desktop_theme.dart';

/// Respuestas rápidas guardadas EN EL DISPOSITIVO.
///
/// El equipo las edita desde el propio panel (agregar, editar, eliminar) y se
/// conservan al cerrar la app. Si nunca se han tocado se usan las de siempre.
abstract final class QuickReplies {
  static const String _key = 'crm.quickReplies.v1';

  static const List<String> defaults = [
    '¡Hola! ¿En qué te puedo ayudar?',
    'El frasco de 20 cápsulas cuesta RD\$5,000. ¿Te lo aparto?',
    'Sí, tenemos entrega a domicilio. ¿En qué zona estás?',
    'Puedes pagar en efectivo o por transferencia, como prefieras.',
    'Horario: lunes a sábado, de 8:00 a.m. a 6:00 p.m.',
    '¡Gracias por tu compra! Cualquier cosa, aquí estoy.',
  ];

  static Future<List<String>> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final guardadas = prefs.getStringList(_key);
      if (guardadas == null) return List<String>.of(defaults);
      return guardadas.where((texto) => texto.trim().isNotEmpty).toList();
    } catch (_) {
      return List<String>.of(defaults);
    }
  }

  static Future<void> save(List<String> values) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_key, values);
  }
}

/// Columna de ACCIONES RÁPIDAS del chat (ANCLADA A LA DERECHA, todo el alto).
///
/// Reúne lo que se repite todo el día: las respuestas de siempre y los datos que
/// se comparten (web, tienda, ubicación, cuentas y catálogos). Se abre desde el
/// botón de la barra de escritura y EMPUJA el hilo en vez de taparlo: la lista de
/// chats y los mensajes siguen visibles.
///
/// Nada se envía solo: una respuesta rápida rellena el compositor y la persona
/// decide si la manda, la cambia o la borra.
///
/// Las respuestas se pueden **agregar, editar y eliminar** desde el botón
/// flotante de la esquina inferior derecha.
class ChatQuickPanel extends StatefulWidget {
  const ChatQuickPanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.onUseReply,
    required this.onShareWeb,
    required this.onShareStore,
    required this.onShareData,
  });

  final double width;
  final VoidCallback onClose;
  final ValueChanged<String> onUseReply;
  final VoidCallback onShareWeb;
  final VoidCallback onShareStore;
  final VoidCallback onShareData;

  @override
  State<ChatQuickPanel> createState() => _ChatQuickPanelState();
}

class _ChatQuickPanelState extends State<ChatQuickPanel> {
  List<String> _respuestas = const [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final lista = await QuickReplies.load();
    if (!mounted) return;
    setState(() {
      _respuestas = lista;
      _cargando = false;
    });
  }

  Future<void> _guardar(List<String> nueva) async {
    setState(() => _respuestas = nueva);
    await QuickReplies.save(nueva);
  }

  /// Alta y edición comparten el mismo formulario.
  Future<void> _formulario({int? indice}) async {
    final controller = TextEditingController(text: indice == null ? '' : _respuestas[indice]);
    final texto = await showDialog<String>(
      context: context,
      builder: (context) {
        final c = ChatPalette.of(context);
        return AlertDialog(
          title: Text(
            indice == null ? 'Agregar respuesta' : 'Editar respuesta',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
          content: SizedBox(
            width: 420,
            child: TextField(
              controller: controller,
              autofocus: true,
              minLines: 2,
              maxLines: 5,
              maxLength: 400,
              style: const TextStyle(fontSize: 13.5, height: 1.35),
              decoration: const InputDecoration(
                hintText: 'Escribe la respuesta que quieres tener a mano…',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
            FilledButton(
              onPressed: () {
                final limpio = controller.text.trim();
                if (limpio.isEmpty) return;
                Navigator.pop(context, limpio);
              },
              style: FilledButton.styleFrom(backgroundColor: c.accent, foregroundColor: Colors.white),
              child: Text(indice == null ? 'Agregar' : 'Guardar'),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (texto == null || texto.isEmpty) return;
    final nueva = List<String>.of(_respuestas);
    if (indice == null) {
      nueva.add(texto);
    } else {
      nueva[indice] = texto;
    }
    await _guardar(nueva);
  }

  /// Selector para editar o eliminar: se toca la respuesta y se actúa sobre ella.
  Future<void> _elegir({required bool eliminar}) async {
    if (_respuestas.isEmpty) return;
    final indice = await showDialog<int>(
      context: context,
      builder: (context) {
        final c = ChatPalette.of(context);
        return AlertDialog(
          title: Text(
            eliminar ? 'Eliminar respuesta' : 'Editar respuesta',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
          content: SizedBox(
            width: 460,
            height: 320,
            child: ListView.separated(
              itemCount: _respuestas.length,
              separatorBuilder: (_, _) => Divider(height: 1, color: c.divider),
              itemBuilder: (context, i) => InkWell(
                onTap: () => Navigator.pop(context, i),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _respuestas[i],
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12.8, height: 1.3),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Icon(
                        eliminar ? Icons.delete_outline_rounded : Icons.edit_outlined,
                        size: 18,
                        color: eliminar ? c.danger : c.accent,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar'))],
        );
      },
    );
    if (indice == null) return;
    if (!eliminar) {
      await _formulario(indice: indice);
      return;
    }
    if (!mounted) return;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('¿Eliminar esta respuesta?', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
        content: Text(_respuestas[indice], style: const TextStyle(fontSize: 13, height: 1.3)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(backgroundColor: ChatPalette.of(context).danger, foregroundColor: Colors.white),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );
    if (confirmado != true) return;
    final nueva = List<String>.of(_respuestas)..removeAt(indice);
    await _guardar(nueva);
  }

  Future<void> _menuAcciones(BuildContext context) async {
    final c = ChatPalette.of(context);
    final box = context.findRenderObject() as RenderBox?;
    final origen = box == null
        ? const Rect.fromLTWH(0, 0, 0, 0)
        : Rect.fromPoints(
            box.localToGlobal(Offset(box.size.width - 8, box.size.height - 8)),
            box.localToGlobal(Offset(box.size.width - 8, box.size.height - 8)),
          );
    final opcion = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(origen, Offset.zero & MediaQuery.sizeOf(context)),
      items: [
        PopupMenuItem(
          value: 'add',
          child: Row(
            children: [
              Icon(Icons.add_comment_outlined, size: 17, color: c.accent),
              const SizedBox(width: 10),
              const Text('Agregar respuesta', style: TextStyle(fontSize: 13)),
            ],
          ),
        ),
        PopupMenuItem(
          value: 'edit',
          enabled: _respuestas.isNotEmpty,
          child: Row(
            children: [
              Icon(Icons.edit_outlined, size: 17, color: _respuestas.isEmpty ? c.textSecondary : c.accent),
              const SizedBox(width: 10),
              const Text('Editar respuesta', style: TextStyle(fontSize: 13)),
            ],
          ),
        ),
        PopupMenuItem(
          value: 'delete',
          enabled: _respuestas.isNotEmpty,
          child: Row(
            children: [
              Icon(Icons.delete_outline_rounded, size: 17, color: _respuestas.isEmpty ? c.textSecondary : c.danger),
              const SizedBox(width: 10),
              const Text('Eliminar respuesta', style: TextStyle(fontSize: 13)),
            ],
          ),
        ),
      ],
    );
    if (opcion == 'add') await _formulario();
    if (opcion == 'edit') await _elegir(eliminar: false);
    if (opcion == 'delete') await _elegir(eliminar: true);
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Material(
      color: c.panelBg,
      child: Container(
        width: widget.width.isFinite ? widget.width : null,
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: c.divider)),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.18), blurRadius: 26, offset: const Offset(-6, 0))],
        ),
        child: Stack(
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 10, 10),
                  child: Row(
                    children: [
                      Icon(Icons.touch_app_rounded, size: 18, color: c.accent),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Acciones rápidas',
                          style: TextStyle(
                            fontFamily: ChatDesktopMetrics.fontFamily,
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: c.textPrimary,
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Cerrar',
                        visualDensity: VisualDensity.compact,
                        iconSize: 18,
                        color: c.textSecondary,
                        onPressed: widget.onClose,
                        icon: const Icon(Icons.close_rounded),
                      ),
                    ],
                  ),
                ),
                Divider(height: 1, color: c.divider),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 82),
                    children: [
                      _SectionTitle(label: 'Respuestas rápidas', icon: Icons.bolt_rounded, color: c.accent),
                      const SizedBox(height: 8),
                      if (_cargando)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 14),
                          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                        )
                      else if (_respuestas.isEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          child: Text(
                            'Todavía no hay respuestas. Añade la primera con el botón de abajo.',
                            style: t.bubbleMeta.copyWith(color: c.textSecondary, height: 1.3),
                          ),
                        )
                      else
                        for (var i = 0; i < _respuestas.length; i++)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: _QuickTile(
                              icon: Icons.chat_bubble_outline_rounded,
                              title: _respuestas[i],
                              onTap: () => widget.onUseReply(_respuestas[i]),
                            ),
                          ),
                      const SizedBox(height: 10),
                      _SectionTitle(label: 'Compartir', icon: Icons.ios_share_rounded, color: c.accent),
                      const SizedBox(height: 8),
                      _QuickTile(icon: Icons.language_rounded, title: 'Página web', onTap: widget.onShareWeb),
                      _QuickTile(icon: Icons.storefront_outlined, title: 'Tienda online', onTap: widget.onShareStore),
                      _QuickTile(
                        icon: Icons.account_balance_outlined,
                        title: 'Ubicación, cuentas y catálogos',
                        onTap: widget.onShareData,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'La respuesta se escribe en el mensaje: la revisas y la envías tú.',
                        style: t.bubbleMeta.copyWith(color: c.textSecondary, height: 1.3),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            // Un solo botón flotante con las tres acciones de las respuestas.
            Positioned(
              right: 16,
              bottom: 16,
              child: Builder(
                builder: (context) => FloatingActionButton.small(
                  heroTag: 'quick-replies-actions',
                  tooltip: 'Agregar, editar o eliminar respuestas',
                  backgroundColor: c.accent,
                  foregroundColor: Colors.white,
                  elevation: 3,
                  onPressed: () => _menuAcciones(context),
                  child: const Icon(Icons.playlist_add_rounded, size: 22),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.label, required this.icon, required this.color});

  final String label;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Row(
      children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 6),
        Text(
          label.toUpperCase(),
          style: TextStyle(
            fontFamily: ChatDesktopMetrics.fontFamily,
            fontSize: 10.5,
            letterSpacing: 0.8,
            fontWeight: FontWeight.w700,
            color: c.textSecondary,
          ),
        ),
      ],
    );
  }
}

class _QuickTile extends StatelessWidget {
  const _QuickTile({required this.icon, required this.title, required this.onTap});

  final IconData icon;
  final String title;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Material(
      color: c.fieldBg,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
          child: Row(
            children: [
              Icon(icon, size: 16, color: c.accent),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  title,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 12.6,
                    height: 1.3,
                    color: c.textPrimary,
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
