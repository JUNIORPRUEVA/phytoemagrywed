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

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "admin"
SOURCE = OUT_DIR / "logo-phytoemagry.png"

BRAND_DARK = (7, 61, 46)  # --pe-brand-900
WHITE = (255, 255, 255)


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


def brand_backplate(size: int, radius_ratio: float = 0.24) -> Image.Image:
    """Fondo sólido para plataformas que no respetan transparencia (iOS)."""
    image = Image.new("RGBA", (size, size), WHITE + (255,))
    draw = ImageDraw.Draw(image)
    inset = int(size * 0.04)
    draw.rounded_rectangle(
        (inset, inset, size - inset - 1, size - inset - 1),
        radius=int(size * radius_ratio),
        fill=WHITE + (255,),
        outline=BRAND_DARK + (32,),
        width=max(1, size // 96),
    )
    return image


def draw_icon(source: Image.Image, size: int, *, maskable: bool = False, apple: bool = False) -> Image.Image:
    padding = 0.18 if maskable else 0.04
    logo = contain(source, size, padding)
    if not apple:
        return logo
    image = brand_backplate(size)
    image.alpha_composite(contain(source, size, 0.08))
    return image.convert("RGB")


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
