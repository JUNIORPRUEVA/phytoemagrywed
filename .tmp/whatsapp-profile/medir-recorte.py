"""
¿Cuánto del LOGO se pierde con el recorte circular de WhatsApp?

Mide, en el original y en la copia derivada, qué fracción de los píxeles del
logo (los claros/azulados de la parte baja, que es el texto «Phytoemagry RD»)
queda DENTRO del círculo que usa WhatsApp al mostrar la foto de perfil.

Solo informa números: no genera ni modifica imágenes.

Uso: python .tmp/whatsapp-profile/medir-recorte.py
"""
import math
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parents[2]
OBJETIVOS = [
    ("original", RAIZ / "assets" / "perfilwhatsapp.png"),
    ("derivada", RAIZ / ".tmp" / "whatsapp-profile-ready.png"),
]


def fondo_del_marco(imagen: Image.Image) -> tuple[int, int, int]:
    """Color medio del marco exterior: el fondo propio del archivo."""
    ancho, alto = imagen.size
    sumas = [0, 0, 0]
    cuenta = 0
    for x in range(ancho):
        for y in (0, alto - 1):
            pixel = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += pixel[i]
            cuenta += 1
    for y in range(alto):
        for x in (0, ancho - 1):
            pixel = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += pixel[i]
            cuenta += 1
    return tuple(round(s / cuenta) for s in sumas)


def medir(etiqueta: str, ruta: Path) -> None:
    imagen = Image.open(ruta).convert("RGB")
    ancho, alto = imagen.size
    fondo = fondo_del_marco(imagen)
    centro = (ancho / 2, alto / 2)
    radio = min(ancho, alto) / 2  # el recorte de WhatsApp es el círculo inscrito
    pixeles = imagen.load()

    total = dentro = 0
    for y in range(alto):
        for x in range(ancho):
            r, g, b = pixeles[x, y]
            if abs(r - fondo[0]) + abs(g - fondo[1]) + abs(b - fondo[2]) <= 45:
                continue  # es fondo: no cuenta como contenido
            total += 1
            if math.dist((x, y), centro) <= radio:
                dentro += 1

    if not total:
        print(f"{etiqueta}: sin contenido detectable")
        return
    fuera = total - dentro
    print(
        f"{etiqueta:9} · fondo RGB{fondo} · contenido {total} px · "
        f"fuera del círculo {fuera} px ({fuera / total:.1%})",
    )


if __name__ == "__main__":
    for etiqueta, ruta in OBJETIVOS:
        if ruta.exists():
            medir(etiqueta, ruta)
        else:
            print(f"{etiqueta}: falta {ruta}")
