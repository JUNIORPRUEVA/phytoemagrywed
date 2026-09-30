"""
Fixtures de la UAT local (NO son archivos de producción):

  · frasco.png       → PNG real (Pillow) para ver la miniatura y el visor.
  · nota-de-voz.ogg  → Ogg SINTÉTICO: bytes con la firma «OggS» para que el
                       pipeline lo acepte como audio/ogg. NO es audio
                       reproducible: en este equipo no hay FFmpeg ni encoder
                       Vorbis, así que no se finge audio real.

Uso: python .tmp/s3-uat/fixtures.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def frasco() -> None:
    width, height = 900, 1200
    image = Image.new("RGB", (width, height), "#eef3ea")
    draw = ImageDraw.Draw(image)

    # Fondo con degradado suave.
    for y in range(height):
        t = y / height
        color = (
            int(238 - 18 * t),
            int(243 - 10 * t),
            int(234 - 16 * t),
        )
        draw.line([(0, y), (width, y)], fill=color)

    # Frasco (cuerpo + tapa).
    draw.rounded_rectangle([300, 380, 600, 1020], radius=60, fill="#ffffff", outline="#c9d4c4", width=6)
    draw.rounded_rectangle([345, 300, 555, 400], radius=24, fill="#2f5d3a")
    draw.rectangle([330, 392, 570, 430], fill="#24472e")

    # Etiqueta.
    draw.rounded_rectangle([330, 560, 570, 860], radius=18, fill="#f7fbf4", outline="#dfe7da", width=4)
    draw.ellipse([400, 600, 500, 700], fill="#7fb069")
    draw.text((360, 730), "PHYTOEMAGRY", fill="#2f5d3a")
    draw.text((412, 760), "10 capsulas", fill="#5b6b57")
    draw.text((404, 800), "R.D. 1250", fill="#2f5d3a")

    image.save(OUT / "frasco.png", format="PNG", optimize=True)


def nota_de_voz() -> None:
    # Página Ogg mínima: «OggS» + versión + cabecera + relleno.
    # NO es audio reproducible (ver la nota del fichero).
    page = bytearray()
    page += b"OggS"
    page += b"\x00"                      # versión de flujo
    page += b"\x02"                      # tipo de página (BOS)
    page += b"\x00" * 8                  # granule position
    page += b"\x01\x00\x00\x00"          # serial
    page += b"\x00\x00\x00\x00"          # secuencia
    page += b"\x00\x00\x00\x00"          # CRC (a 0: nadie reproduce esto)
    page += b"\x01"                      # número de segmentos
    page += b"\x1e"                      # tamaño del segmento
    page += b"\x01vorbis" + b"\x00" * 23  # identificación vorbis incompleta
    page += b"\x00" * 400                 # relleno (peso razonable)
    (OUT / "nota-de-voz.ogg").write_bytes(bytes(page))


if __name__ == "__main__":
    frasco()
    nota_de_voz()
    for name in ("frasco.png", "nota-de-voz.ogg"):
        path = OUT / name
        print(f"{name}: {path.stat().st_size} bytes")
