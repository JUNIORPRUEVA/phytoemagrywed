"""
Prepara la FOTO DE PERFIL de WhatsApp a partir de `assets/perfilwhatsapp.png`
SIN tocar el original.

Qué hace y por qué:
  · El original (1254x1254) es "a sangre": el contenido llega a los bordes, así
    que el recorte CIRCULAR de WhatsApp se come las esquinas y parte del logo
    que toca el borde inferior.
  · Se crea una COPIA derivada de 1024x1024 con el original reducido al 80% y
    centrado sobre el COLOR DE FONDO tomado del propio archivo (no se inventa
    nada: mismo contenido, mismo color de marca, solo se le da aire).
  · Se generan dos previsualizaciones con la máscara circular de WhatsApp
    (original vs derivada) para poder ver el resultado antes de subir nada.

Salidas (todas en .tmp/, nunca en assets/):
  · .tmp/whatsapp-profile-ready.png
  · .tmp/whatsapp-profile/preview-original-circular.png
  · .tmp/whatsapp-profile/preview-ready-circular.png

Uso: python .tmp/whatsapp-profile/make-profile-ready.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parents[2]
ORIGEN = RAIZ / "assets" / "perfilwhatsapp.png"
SALIDA = RAIZ / ".tmp" / "whatsapp-profile-ready.png"
PREVIEWS = Path(__file__).resolve().parent

LADO = 1024
ESCALA_CONTENIDO = 0.80  # deja ~10% de aire a cada lado para el círculo


def color_de_borde(imagen: Image.Image) -> tuple[int, int, int]:
    """Color medio del marco exterior: es el fondo propio de la imagen."""
    ancho, alto = imagen.size
    grosor = 6
    recortes = [
        (0, 0, ancho, grosor),
        (0, alto - grosor, ancho, alto),
        (0, 0, grosor, alto),
        (ancho - grosor, 0, ancho, alto),
    ]
    sumas = [0, 0, 0]
    cuenta = 0
    for caja in recortes:
        trozo = imagen.crop(caja).convert("RGB")
        for pixel in trozo.getdata():
            for i in range(3):
                sumas[i] += pixel[i]
            cuenta += 1
    return tuple(round(s / cuenta) for s in sumas)


def con_mascara(imagen: Image.Image, destino: Path, diametro_relativo: float) -> None:
    """Guarda una previsualización con el círculo de WhatsApp dibujado encima."""
    copia = imagen.convert("RGB").copy()
    dibujo = ImageDraw.Draw(copia)
    ancho, alto = copia.size
    margen = (1 - diametro_relativo) / 2 * min(ancho, alto)
    dibujo.ellipse(
        [margen, margen, ancho - margen, alto - margen],
        outline=(255, 0, 0),
        width=max(3, ancho // 200),
    )
    copia.save(destino, format="PNG", optimize=True)


def main() -> None:
    original = Image.open(ORIGEN).convert("RGB")
    fondo = color_de_borde(original)

    # Copia derivada: contenido al 80% centrado sobre el fondo propio.
    derivada = Image.new("RGB", (LADO, LADO), fondo)
    contenido = round(LADO * ESCALA_CONTENIDO)
    trozo = original.resize((contenido, contenido), Image.LANCZOS)
    desplazamiento = (LADO - contenido) // 2
    derivada.paste(trozo, (desplazamiento, desplazamiento))
    derivada.save(SALIDA, format="PNG", optimize=True)

    con_mascara(original.resize((512, 512), Image.LANCZOS), PREVIEWS / "preview-original-circular.png", 0.80)
    con_mascara(derivada.resize((512, 512), Image.LANCZOS), PREVIEWS / "preview-ready-circular.png", 0.80)

    print(f"origen: {ORIGEN.name} {original.size} · fondo muestreado (RGB): {fondo}")
    print(f"derivada: {SALIDA} {derivada.size} · {SALIDA.stat().st_size / 1024:.0f} KB")
    print(f"contenido al {ESCALA_CONTENIDO:.0%} ({contenido}px) y {desplazamiento}px de aire")
    print("previews: preview-original-circular.png · preview-ready-circular.png")


if __name__ == "__main__":
    main()
