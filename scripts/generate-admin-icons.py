"""
Iconos del panel (PWA) de Phytoemagry.

Genera los PNG que necesita una app instalable, sin depender de ningún archivo
externo: el icono se dibuja aquí mismo con los colores de la marca.

    python scripts/generate-admin-icons.py

Salida (se sirven desde /admin/, junto a la app):
    icon-192.png            → icono normal (Android/escritorio)
    icon-512.png            → icono normal en grande
    icon-maskable-512.png   → con margen de seguridad (Android lo recorta)
    apple-touch-icon.png    → iPhone/iPad (sin transparencia)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "admin"

BRAND_DARK = (7, 61, 46)  # --pe-brand-900
BRAND = (11, 107, 79)  # --pe-brand-700
BRAND_LIGHT = (223, 238, 232)  # --pe-brand-100
ACCENT = (201, 226, 101)  # --pe-accent
WHITE = (255, 255, 255)

# Un tipo de letra con cuerpo, probando primero las que suelen estar instaladas.
FONT_CANDIDATES = [
    "arialbd.ttf",
    "Arial Bold.ttf",
    "segoeuib.ttf",
    "DejaVuSans-Bold.ttf",
    "LiberationSans-Bold.ttf",
    "HelveticaNeue-Bold.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    # Pillow ≥ 10.1 trae una fuente escalable por defecto.
    return ImageFont.load_default(size=size)


def rounded_square(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Lienzo cuadrado con las esquinas redondeadas (color de marca + degradado suave)."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        mix = y / max(size - 1, 1)
        color = tuple(
            round(BRAND_DARK[i] + (BRAND[i] - BRAND_DARK[i]) * mix) for i in range(3)
        ) + (255,)
        draw.line([(0, y), (size, y)], fill=color)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255
    )
    image.paste(gradient, (0, 0), mask)
    return image


def draw_icon(size: int, *, maskable: bool = False, transparent: bool = False) -> Image.Image:
    image = (
        Image.new("RGBA", (size, size), (0, 0, 0, 0))
        if transparent
        else rounded_square(size)
    )
    draw = ImageDraw.Draw(image)

    # En maskable el contenido vive dentro del 80% central: Android recorta lo demás.
    padding = size * (0.22 if maskable else 0.14)
    font = load_font(int(size * (0.42 if maskable else 0.5)))
    text = "P"
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((size - (box[2] - box[0])) / 2 - box[0], (size - (box[3] - box[1])) / 2 - box[1] - size * 0.04),
        text,
        font=font,
        fill=WHITE,
    )

    # La cápsula: el detalle de marca, debajo de la letra.
    capsule_width = size - padding * 2
    capsule_height = max(6, int(size * 0.075))
    top = size * 0.7
    draw.rounded_rectangle(
        [padding, top, padding + capsule_width, top + capsule_height],
        radius=capsule_height / 2,
        fill=ACCENT,
    )
    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "icon-192.png": draw_icon(192),
        "icon-512.png": draw_icon(512),
        "icon-maskable-512.png": draw_icon(512, maskable=True),
        # iPhone no admite transparencia en el icono: va con fondo.
        "apple-touch-icon.png": draw_icon(180),
    }
    for name, image in outputs.items():
        path = OUT_DIR / name
        image.save(path, "PNG", optimize=True)
        print(f"✔ {path.relative_to(OUT_DIR.parent.parent.parent)} ({path.stat().st_size / 1024:.1f} kB)")


if __name__ == "__main__":
    main()
