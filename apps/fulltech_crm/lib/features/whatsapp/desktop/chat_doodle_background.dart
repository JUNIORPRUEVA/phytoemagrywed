import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'chat_desktop_theme.dart';

/// Fondo del hilo de conversación: base oscura con un patrón continuo de
/// dibujos tenues, como en la referencia.
///
/// **El patrón es original**: se ha dibujado aquí con primitivas (círculos,
/// arcos, hojas, tazas, notas) porque el recurso gráfico de la referencia es
/// propietario y no está disponible con licencia en el proyecto. Se reproduce
/// la *densidad y el tono*, no el dibujo exacto.
class ChatDoodleBackground extends StatelessWidget {
  const ChatDoodleBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    // El color base va DEBAJO del patrón y el contenido encima: si el
    // `ColoredBox` fuese hijo del `CustomPaint`, taparía los dibujos.
    return RepaintBoundary(
      child: Stack(
        children: [
          const Positioned.fill(child: ColoredBox(color: ChatDesktopColors.panelBg)),
          Positioned.fill(
            child: CustomPaint(painter: const _DoodlePainter(), isComplex: true, willChange: false),
          ),
          Positioned.fill(child: child),
        ],
      ),
    );
  }
}

class _DoodlePainter extends CustomPainter {
  const _DoodlePainter();

  static const double _tile = 86;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..strokeCap = StrokeCap.round
      ..color = ChatDesktopColors.doodle;

    final cols = (size.width / _tile).ceil() + 1;
    final rows = (size.height / _tile).ceil() + 1;
    final rnd = math.Random(20261027);

    for (var row = 0; row < rows; row++) {
      for (var col = 0; col < cols; col++) {
        final dx = col * _tile + rnd.nextDouble() * 22;
        final dy = row * _tile + rnd.nextDouble() * 22;
        canvas.save();
        canvas.translate(dx, dy);
        canvas.rotate((rnd.nextDouble() - 0.5) * 0.6);
        switch (rnd.nextInt(7)) {
          case 0:
            _cup(canvas, stroke);
            break;
          case 1:
            _leaf(canvas, stroke);
            break;
          case 2:
            _note(canvas, stroke);
            break;
          case 3:
            _star(canvas, stroke);
            break;
          case 4:
            _bubble(canvas, stroke);
            break;
          case 5:
            _flower(canvas, stroke);
            break;
          default:
            _spiral(canvas, stroke);
        }
        canvas.restore();
      }
    }
  }

  void _cup(Canvas canvas, Paint p) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(const Rect.fromLTWH(0, 4, 16, 12), const Radius.circular(3)),
      p,
    );
    canvas.drawArc(const Rect.fromLTWH(14, 6, 8, 8), -1.2, 2.4, false, p);
    canvas.drawLine(const Offset(8, 0), const Offset(10, -4), p);
  }

  void _leaf(Canvas canvas, Paint p) {
    final path = Path()
      ..moveTo(0, 0)
      ..quadraticBezierTo(12, -8, 18, 6)
      ..quadraticBezierTo(4, 12, 0, 0);
    canvas.drawPath(path, p);
    canvas.drawLine(const Offset(3, 2), const Offset(13, 3), p);
  }

  void _note(Canvas canvas, Paint p) {
    canvas.drawCircle(const Offset(4, 12), 3.2, p);
    canvas.drawLine(const Offset(7, 12), const Offset(7, 0), p);
    canvas.drawLine(const Offset(7, 0), const Offset(15, 3), p);
  }

  void _star(Canvas canvas, Paint p) {
    final path = Path();
    for (var i = 0; i < 5; i++) {
      final a = -math.pi / 2 + i * 2 * math.pi / 5;
      final point = Offset(8 + 8 * math.cos(a), 8 + 8 * math.sin(a));
      if (i == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    path.close();
    canvas.drawPath(path, p);
  }

  void _bubble(Canvas canvas, Paint p) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 20, 13), const Radius.circular(6)),
      p,
    );
    canvas.drawLine(const Offset(4, 13), const Offset(3, 18), p);
  }

  void _flower(Canvas canvas, Paint p) {
    for (var i = 0; i < 6; i++) {
      final a = i * math.pi / 3;
      canvas.drawCircle(Offset(8 + 5 * math.cos(a), 8 + 5 * math.sin(a)), 3.4, p);
    }
  }

  void _spiral(Canvas canvas, Paint p) {
    final path = Path();
    for (var t = 0.0; t < 3.2 * math.pi; t += 0.22) {
      final r = 1.6 * t;
      final point = Offset(9 + r * math.cos(t), 9 + r * math.sin(t));
      if (t == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    canvas.drawPath(path, p);
  }

  @override
  bool shouldRepaint(covariant _DoodlePainter oldDelegate) => false;
}
