"""Recorta la línea de productos del arte de portada para usarla en el héroe.

Entrada:  public/assets/img/portada-principal-1672.jpg (1672x941)
Salida:   public/store/assets/img/hero-productos.jpg    (640x460 aprox.)
No inventa nada: recorta fotografía real ya aprobada del proyecto.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "assets" / "img" / "portada-principal-1672.jpg"
OUT_DIR = ROOT / "public" / "store" / "assets" / "img"
OUT = OUT_DIR / "hero-productos.jpg"

# Zona con los frascos (se descarta el logotipo grande de la parte superior).
CROP = (40, 430, 1640, 941)
TARGET = (720, 420)  # 2x para pantallas retina a ~360x210 CSS


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.open(SRC).convert("RGB")
    art = img.crop(CROP)
    art = art.resize(TARGET, Image.LANCZOS)
    art.save(OUT, "JPEG", quality=82, optimize=True, progressive=True)
    print(f"escrito {OUT.relative_to(ROOT)} · {art.size[0]}x{art.size[1]} · {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
