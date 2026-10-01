"""
Iconos del panel (PWA) de Phytoemagry.

Genera los PNG que necesita una app instalable usando el emblema oficial del
panel (`public/admin/logo-phytoemagry.png`) como fuente.

    python scripts/generate-admin-icons.py

Salida (se sirven desde /admin/, junto a la app):
    icon-192.png            → icono normal (Android/escritorio)
    icon-512.png            → icono normal en grande
    icon-maskable-512.png   → con margen de seguridad (Android lo recorta)
    apple-touch-icon.png    → iPhone/iPad (sin transparencia)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "admin"
SOURCE = OUT_DIR / "logo-phytoemagry.png"

BRAND_DARK = (7, 61, 46)  # --pe-brand-900


def square_crop(source: Image.Image, zoom: float = 0.76, y_bias: float = -0.04) -> Image.Image:
    """Recorta el centro para que el launcher se vea lleno y no como medallón."""
    bbox = source.getchannel("A").getbbox() or source.getbbox()
    image = source.crop(bbox)
    side = int(min(image.size) * zoom)
    x = (image.width - side) // 2
    y = (image.height - side) // 2 + int(image.height * y_bias)
    y = max(0, min(image.height - side, y))
    return image.crop((x, y, x + side, y + side))


def cover(source: Image.Image, size: int, *, maskable: bool = False) -> Image.Image:
    """Compone un icono cuadrado, lleno, sin aro blanco ni transparencia."""
    crop = square_crop(source, zoom=0.7 if maskable else 0.76, y_bias=-0.03 if maskable else -0.04)

    background = crop.copy()
    background.thumbnail((size, size), Image.Resampling.LANCZOS)
    background = background.resize((size, size), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(size * 0.035))
    base = Image.new("RGBA", (size, size), BRAND_DARK + (255,))
    base.alpha_composite(background)

    draw = ImageDraw.Draw(base, "RGBA")
    draw.rectangle((0, 0, size, size), fill=(7, 61, 46, 22))

    foreground = crop.copy()
    padding = int(size * (0.1 if maskable else 0.0))
    box_size = size - padding * 2
    foreground = foreground.resize((box_size, box_size), Image.Resampling.LANCZOS)
    base.alpha_composite(foreground, (padding, padding))
    return base


def contain(source: Image.Image, size: int, padding_ratio: float) -> Image.Image:
    """Escala el emblema completo dentro de un lienzo cuadrado transparente."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    padding = int(size * padding_ratio)
    box_size = size - padding * 2
    image = source.copy()
    image.thumbnail((box_size, box_size), Image.Resampling.LANCZOS)
    x = (size - image.width) // 2
    y = (size - image.height) // 2
    canvas.alpha_composite(image, (x, y))
    return canvas


def draw_icon(source: Image.Image, size: int, *, maskable: bool = False, apple: bool = False) -> Image.Image:
    image = cover(source, size, maskable=maskable)
    if apple:
        return image.convert("RGB")
    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not SOURCE.exists():
        raise SystemExit(f"No existe la fuente del logo: {SOURCE}")
    source = Image.open(SOURCE).convert("RGBA")
    outputs = {
        "icon-192.png": draw_icon(source, 192),
        "icon-512.png": draw_icon(source, 512),
        "icon-maskable-512.png": draw_icon(source, 512, maskable=True),
        # iPhone no admite transparencia en el icono: va con fondo.
        "apple-touch-icon.png": draw_icon(source, 180, apple=True),
    }
    for name, image in outputs.items():
        path = OUT_DIR / name
        image.save(path, "PNG", optimize=True)
        print(f"✔ {path.relative_to(OUT_DIR.parent.parent.parent)} ({path.stat().st_size / 1024:.1f} kB)")


if __name__ == "__main__":
    main()
