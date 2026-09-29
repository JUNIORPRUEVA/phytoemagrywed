"""
Optimiza la portada principal (panorámica) para web.

Entrada:  assets/portadaprincipal.png   (original, NO se modifica)
Salida:   public/assets/img/portada-principal-<ancho>.{avif,webp}
          public/assets/img/portada-principal-<mayor>.jpg   (fallback)

Convenio del proyecto (`src/render/media.js`): una ruta base
`/assets/img/portada-principal` con sufijos `-<ancho>` por formato.

La imagen es horizontal (1672x941), así que se generan varios anchos para que
en móvil no se descargue un archivo innecesariamente grande. No se recorta ni
se deforma: solo se escala proporcionalmente.

Uso:  python scripts/optimize-hero-image.py
"""

from pathlib import Path

from PIL import Image

# Anchos útiles: móvil (DPR 1 y 2), tablet y desktop.
WIDTHS = (480, 768, 1200, 1672)
# AVIF/WebP con calidad moderada: la foto es la candidata a LCP en móvil, así que
# cada kB cuenta. Comprobado visualmente: sin artefactos en el degradado.
WEBP_QUALITY = 80
AVIF_QUALITY = 55
JPEG_QUALITY = 80

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "portadaprincipal.png"
OUT_DIR = ROOT / "public" / "assets" / "img"
BASE = "portada-principal"


def main() -> int:
    if not SOURCE.exists():
        print(f"❌ No existe el original: {SOURCE}")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    original = Image.open(SOURCE)
    original.load()
    width, height = original.size
    print(f"Original: {SOURCE.name} · {width}x{height} · {original.mode}")

    # RGB sin canal alfa (WebP/AVIF/JPEG no lo necesitan aquí).
    source = original.convert("RGB")

    largest_width = min(max(WIDTHS), width)
    generated = 0

    for target in WIDTHS:
        if target > width:
            # Nunca se escala hacia arriba: se perdería nitidez.
            continue
        target_height = round(height * (target / width))
        resized = source.resize((target, target_height), Image.LANCZOS)

        webp_path = OUT_DIR / f"{BASE}-{target}.webp"
        resized.save(webp_path, format="WEBP", quality=WEBP_QUALITY, method=6)
        generated += 1

        avif_path = OUT_DIR / f"{BASE}-{target}.avif"
        try:
            resized.save(avif_path, format="AVIF", quality=AVIF_QUALITY)
        except (ValueError, OSError) as error:  # Pillow sin soporte AVIF
            print(f"  ⚠️  AVIF no disponible ({error}); se omite {avif_path.name}")

        print(
            f"  {target}x{target_height}  "
            f"webp {webp_path.stat().st_size // 1024} kB"
            + (f" · avif {avif_path.stat().st_size // 1024} kB" if avif_path.exists() else "")
        )

    # Fallback JPG: solo el mayor (los navegadores sin WebP/AVIF son residuales).
    fallback = source.resize(
        (largest_width, round(height * (largest_width / width))), Image.LANCZOS
    )
    jpg_path = OUT_DIR / f"{BASE}-{largest_width}.jpg"
    fallback.save(jpg_path, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    print(f"  fallback {jpg_path.name}: {jpg_path.stat().st_size // 1024} kB")

    print(f"\n✅ {generated} anchos generados en {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
