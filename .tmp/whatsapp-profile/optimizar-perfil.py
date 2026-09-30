"""
Busca el margen ÓPTIMO para la foto de perfil: el mayor contenido posible sin que
el recorte circular de WhatsApp corte el logo.

Para cada escala calcula:
  · qué % del contenido (arte) quedaría fuera del círculo,
  · qué % de los píxeles del LOGO (texto azul oscuro) quedaría fuera,
  · el grosor del anillo de fondo (el "blanco") que se vería.

Después genera la copia derivada con la escala elegida y una previsualización.

Uso: python .tmp/whatsapp-profile/optimizar-perfil.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parents[2]
ORIGEN = RAIZ / "assets" / "perfilwhatsapp.png"
SALIDA = RAIZ / ".tmp" / "whatsapp-profile-ready.png"
PREVIEW = Path(__file__).resolve().parent / "preview-elegida-circular.png"
LADO = 1024
ESCALAS = [0.80, 0.86, 0.90, 0.94, 0.96, 0.98, 1.00]


def fondo_de_borde(imagen: Image.Image) -> tuple[int, int, int]:
    ancho, alto = imagen.size
    sumas = [0, 0, 0]
    cuenta = 0
    for x in range(ancho):
        for y in (0, alto - 1):
            p = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += p[i]
            cuenta += 1
    for y in range(alto):
        for x in (0, ancho - 1):
            p = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += p[i]
            cuenta += 1
    return tuple(round(s / cuenta) for s in sumas)


def es_logo(pixel) -> bool:
    """Texto del logo: azul oscuro saturado (no las hojas verdes ni el blanco)."""
    r, g, b = pixel[:3]
    return b > 90 and b - r > 45 and b - g > 30


def contenido(imagen: Image.Image, fondo) -> tuple[set, set]:
    """Devuelve (píxeles de arte, píxeles de logo) que NO son fondo."""
    ancho, alto = imagen.size
    pixeles = imagen.load()
    arte, logo = set(), set()
    for y in range(alto):
        for x in range(ancho):
            p = pixeles[x, y]
            if abs(p[0] - fondo[0]) + abs(p[1] - fondo[1]) + abs(p[2] - fondo[2]) > 45:
                arte.add((x, y))
                if es_logo(p):
                    logo.add((x, y))
    return arte, logo


def perdida(puntos: set, centro, radio) -> float:
    if not puntos:
        return 0.0
    fuera = sum(1 for (x, y) in puntos if math.dist((x, y), centro) > radio)
    return fuera / len(puntos)


def main() -> None:
    original = Image.open(ORIGEN).convert("RGB")
    fondo = fondo_de_borde(original)
    lado_origen = original.size[0]
    arte, logo = contenido(original, fondo)

    print(f"original {original.size} · fondo RGB{fondo} · arte {len(arte)} px · logo {len(logo)} px")
    print(f"{'escala':>7} {'arte fuera':>11} {'logo fuera':>11} {'anillo':>7}")

    mejor = None
    for escala in ESCALAS:
        contenido_px = round(LADO * escala)
        aire = (LADO - contenido_px) // 2
        # Paso de coordenadas del original a la derivada.
        factor = contenido_px / lado_origen
        def transformar(puntos):
            return {(round(x * factor) + aire, round(y * factor) + aire) for (x, y) in puntos}
        centro = (LADO / 2, LADO / 2)
        radio = LADO / 2
        arte_fuera = perdida(transformar(arte), centro, radio)
        logo_fuera = perdida(transformar(logo), centro, radio)
        anillo = aire
        print(f"{escala:7.2f} {arte_fuera:10.2%} {logo_fuera:10.2%} {anillo:5d}px")
        # Criterio: el logo NO puede perder nada; el arte puede perder un poco en
        # las esquinas decorativas (hasta 0.8%) para que el anillo de fondo quede
        # fino. Así la foto se ve lo más grande posible sin comerse el logo.
        if logo_fuera == 0 and arte_fuera <= 0.008:
            mejor = escala

    if mejor is None:
        mejor = 0.80
    print(f"\nescala elegida: {mejor:.2f} (logo intacto y arte casi sin pérdida)")

    contenido_px = round(LADO * mejor)
    aire = (LADO - contenido_px) // 2
    derivada = Image.new("RGB", (LADO, LADO), fondo)
    derivada.paste(original.resize((contenido_px, contenido_px), Image.LANCZOS), (aire, aire))
    derivada.save(SALIDA, format="PNG", optimize=True)

    copia = derivada.resize((512, 512), Image.LANCZOS).copy()
    dibujo = ImageDraw.Draw(copia)
    dibujo.ellipse([0, 0, 511, 511], outline=(255, 0, 0), width=3)
    copia.save(PREVIEW, format="PNG", optimize=True)

    print(f"derivada: {SALIDA.name} {derivada.size} · {SALIDA.stat().st_size / 1024:.0f} KB · aire {aire}px")
    print(f"preview: {PREVIEW.name}")


if __name__ == "__main__":
    main()
