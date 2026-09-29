"""
Optimiza las fotos individuales de cada frasco (tarjetas del carrusel).

Entrada:  assets/fasco <N> capsula.png   (originales, NO se modifican)
Salida:   public/assets/img/frascos/frasco-<N>-<ancho>.{avif,webp}
          public/assets/img/frascos/frasco-<N>-<mayor>.jpg   (fallback)

Convenio del proyecto (`src/render/media.js`): una ruta base
`/assets/img/frascos/frasco-10` con sufijos `-<ancho>` por formato.

Por qué se recorta a cuadrado: las 7 fotos son casi cuadradas (1254x1254, salvo
la de 5 cápsulas, 1327x1185) y el frasco está centrado con fondo de sobra en los
lados. Recortando al centro a un cuadrado uniforme, las 7 tarjetas del carrusel
quedan exactamente del mismo alto: nada salta y ninguna foto se deforma
(no se escala en un eje distinto del otro).

Uso:  python scripts/optimize-variant-images.py
"""

import re
from pathlib import Path

from PIL import Image

# La tarjeta mide 240 px: 320 px cubre pantallas normales y 480 px las de alta
# densidad (240 × 2 = 480). Más ancho solo engorda la página.
WIDTHS = (320, 480)
WEBP_QUALITY = 80
AVIF_QUALITY = 50
JPEG_QUALITY = 80

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets"
OUT_DIR = ROOT / "public" / "assets" / "img" / "frascos"

# "fasco  15 capsula.png" / "fasco 10  capsula.png" (los originales traen
# espacios dobles y erratas en el nombre).
NAME_RE = re.compile(r"^fasco\s+(\d+)\s*capsula\.png$", re.IGNORECASE)


def square(image: Image.Image) -> Image.Image:
    """Recorte central a cuadrado (no deforma: solo quita fondo de los lados)."""
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def main() -> int:
    if not SOURCE_DIR.exists():
        print(f"❌ No existe la carpeta de originales: {SOURCE_DIR}")
        return 1

    sources = []
    for path in sorted(SOURCE_DIR.glob("*.png")):
        match = NAME_RE.match(path.name)
        if match:
            sources.append((int(match.group(1)), path))
    sources.sort()

    if not sources:
        print("❌ No se encontró ninguna foto 'fasco <N> capsula.png' en assets/")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Originales: {len(sources)} fotos · salida en {OUT_DIR.relative_to(ROOT)}\n")

    total = 0
    report = []
    for capsules, path in sources:
        original = Image.open(path)
        original.load()
        photo = square(original.convert("RGB"))
        sizes = []
        for target in WIDTHS:
            if target > photo.size[0]:
                continue
            resized = photo.resize((target, target), Image.LANCZOS)

            webp_path = OUT_DIR / f"frasco-{capsules}-{target}.webp"
            resized.save(webp_path, format="WEBP", quality=WEBP_QUALITY, method=6)
            size_webp = webp_path.stat().st_size

            avif_path = OUT_DIR / f"frasco-{capsules}-{target}.avif"
            size_avif = 0
            try:
                resized.save(avif_path, format="AVIF", quality=AVIF_QUALITY)
                size_avif = avif_path.stat().st_size
            except (ValueError, OSError) as error:  # Pillow sin soporte AVIF
                print(f"  ⚠️  AVIF no disponible ({error}); se omite {avif_path.name}")

            total += size_webp + size_avif
            sizes.append(
                f"{target}px: webp {size_webp // 1024} kB" + (f" · avif {size_avif // 1024} kB" if size_avif else "")
            )

        largest = min(max(WIDTHS), photo.size[0])
        fallback = photo.resize((largest, largest), Image.LANCZOS)
        jpg_path = OUT_DIR / f"frasco-{capsules}-{largest}.jpg"
        fallback.save(jpg_path, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        total += jpg_path.stat().st_size

        report.append(f"  frasco-{capsules}  " + " · ".join(sizes) + f" · jpg {jpg_path.stat().st_size // 1024} kB")

    print("\n".join(report))
    print(f"\n✅ {len(sources)} frascos · {total // 1024} kB en total (cada tarjeta carga solo su tamaño)")
    print("   Recuerda: `npm run check` valida que las rutas declaradas existen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
