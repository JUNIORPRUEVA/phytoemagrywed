#!/usr/bin/env python3
"""
Genera las imágenes de MARCA de la landing (no fotos de producto).

    python scripts/generate-placeholder-images.py            # og + apple-touch-icon
    python scripts/generate-placeholder-images.py --product  # además, placeholders de producto

Las imágenes de producto NUNCA se generan por defecto: mientras no exista una
foto real (`productConfig.images.hero` en null) la web muestra un marcador
honesto. Con `--product` se crean imágenes TEMPORALES de demostración que sirven
para comprobar el pipeline AVIF/WebP/JPG.

Requiere Pillow (`pip install pillow`).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    print("Falta Pillow. Instálalo con:  pip install pillow", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "assets" / "img"

BRAND_TOP = (18, 140, 104)
BRAND_BOTTOM = (7, 61, 46)
INK = (14, 27, 22)
WHITE = (255, 255, 255)
ACCENT = (201, 226, 101)

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_REGULAR_CANDIDATES = [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size: int, candidates: list[str]):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def gradient(size: tuple[int, int], angle: float = 45.0) -> Image.Image:
    """Degradado diagonal entre los dos colores de marca."""
    width, height = size
    base = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(base)
    steps = max(width, height)
    for i in range(steps):
        ratio = i / max(steps - 1, 1)
        color = tuple(
            round(BRAND_TOP[c] + (BRAND_BOTTOM[c] - BRAND_TOP[c]) * ratio) for c in range(3)
        )
        draw.line([(i, 0), (0, i)], fill=color, width=2)
    draw.rectangle([0, 0, width, height], outline=None)
    # Relleno del resto del lienzo
    for i in range(steps):
        ratio = min(1.0, i / max(steps - 1, 1))
        color = tuple(
            round(BRAND_TOP[c] + (BRAND_BOTTOM[c] - BRAND_TOP[c]) * ratio) for c in range(3)
        )
        draw.line([(i, height), (width, i)], fill=color, width=2)
    return base


def draw_leaf(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    draw.arc([x0, y0, x1, y1], start=200, end=20, fill=WHITE, width=max(3, (x1 - x0) // 12))
    draw.arc(
        [x0 + (x1 - x0) // 6, y0 + (y1 - y0) // 5, x1 - (x1 - x0) // 8, y1 - (y1 - y0) // 6],
        start=200,
        end=20,
        fill=ACCENT,
        width=max(2, (x1 - x0) // 20),
    )


def centered_text(draw, text, font, y, fill, width) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(((width - (right - left)) / 2 - left, y), text, font=font, fill=fill)


def build_og(width: int = 1200, height: int = 630) -> Image.Image:
    image = gradient((width, height))
    draw = ImageDraw.Draw(image)
    draw_leaf(draw, (900, 120, 1160, 380))

    title_font = load_font(96, FONT_CANDIDATES)
    sub_font = load_font(40, FONT_REGULAR_CANDIDATES)

    draw.text((90, 210), "Phytoemagry", font=title_font, fill=WHITE)
    draw.text((92, 330), "Información, presentación y compra directa.", font=sub_font, fill=(223, 242, 233))
    draw.rectangle([92, 400, 292, 406], fill=ACCENT)
    return image


def build_icon(size: int = 180) -> Image.Image:
    image = gradient((size, size))
    draw = ImageDraw.Draw(image)
    draw_leaf(draw, (int(size * 0.18), int(size * 0.18), int(size * 0.86), int(size * 0.86)))
    return image


def build_product_placeholder(width: int, height: int, label: str) -> Image.Image:
    image = gradient((width, height))
    draw = ImageDraw.Draw(image)
    font = load_font(max(20, width // 14), FONT_CANDIDATES)
    small = load_font(max(14, width // 26), FONT_REGULAR_CANDIDATES)
    centered_text(draw, "IMAGEN PENDIENTE", font, height // 2 - width // 9, WHITE, width)
    centered_text(draw, label, small, height // 2 + width // 16, (223, 242, 233), width)
    return image


def save_formats(image: Image.Image, base: Path, widths: list[int]) -> None:
    for width in widths:
        height = round(image.height * (width / image.width))
        resized = image.resize((width, height), Image.LANCZOS)
        stem = f"{base.name}-{width}"
        resized.save(base.parent / f"{stem}.jpg", quality=82, optimize=True, progressive=True)
        resized.save(base.parent / f"{stem}.webp", quality=80, method=6)
        try:
            resized.save(base.parent / f"{stem}.avif", quality=60)
        except (OSError, ValueError) as error:  # pragma: no cover
            print(f"  ! AVIF no disponible para {stem}: {error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Genera imágenes de marca de la landing")
    parser.add_argument("--product", action="store_true", help="Genera también placeholders de producto")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    og = build_og()
    og.save(OUT_DIR / "og-phytoemagry.png", optimize=True)
    print(f"  ✔ og-phytoemagry.png ({og.width}×{og.height})")

    icon = build_icon()
    icon.save(OUT_DIR / "apple-touch-icon.png", optimize=True)
    print(f"  ✔ apple-touch-icon.png ({icon.width}×{icon.height})")

    if args.product:
        hero = build_product_placeholder(1024, 1024, "Fotografía del producto")
        save_formats(hero, OUT_DIR / "producto-hero", [640, 1024])
        presentation = build_product_placeholder(1024, 1024, "Fotografía de presentación")
        save_formats(presentation, OUT_DIR / "producto-presentacion", [640, 1024])
        print("  ✔ placeholders de producto (avif/webp/jpg × 640/1024)")

    print(f"\nImágenes escritas en {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
