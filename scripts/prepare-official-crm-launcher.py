"""
ICONO DE LANZADOR DEL CRM — arte 3D aprobado.

Qué hace y por qué:

  * Toma el arte nuevo (`Icono azul 3D de chat y contacto.png`) y lo guarda como
    original del CRM, junto a su maestro de 1024.
  * Recorta el aire negro que trae alrededor (con umbral, porque el halo tenue
    agrandaría el recorte) y compone la marca centrada sobre `#0b1424`, que es
    justo el `background_color`/`theme_color` del manifest: así el icono se funde
    con el arranque de la app y no aparece un cuadro negro dentro del icono.
  * Genera SOLO los iconos de instalación y el favicon (32, 180, 192, 512 y el
    maskable). La marca de la barra y el splash (`fulltech-crm-256.png` y
    `fulltech-crm-mark.png`) no se tocan: son la versión plana sobre blanco, que
    es la que se integra bien dentro de la interfaz.

Uso:  python scripts/prepare-official-crm-launcher.py
"""
from pathlib import Path
import shutil

from PIL import Image

root = Path(__file__).resolve().parents[1]
source = Path('C:/Users/pc/Downloads/Icono azul 3D de chat y contacto.png')
original = root / 'assets/branding/official-apps/crm'
out = root / 'public/admin/assets/branding'

if not source.exists():
    raise SystemExit(f'Falta el arte original: {source}')

original.mkdir(parents=True, exist_ok=True)
out.mkdir(parents=True, exist_ok=True)
shutil.copy2(source, original / 'source.png')

# El mismo azul marino del manifest y del tema oscuro del panel.
BG = (11, 20, 36)

image = Image.open(source).convert('RGB')
image.resize((1024, 1024), Image.Resampling.LANCZOS).save(original / 'master-1024.png', optimize=True)

# ---------------------------------------------------------------------------
# DEL NEGRO AL TRANSPARENTE.
#
# El arte viene sobre negro puro. Pegado tal cual sobre el azul marino del
# manifest se veía un CUADRADO NEGRO dentro del icono. Aquí el negro se vuelve
# transparencia con una rampa corta (negro puro → 0, cualquier azul del logo →
# opaco), así el hueco de la burbuja deja ver el fondo del icono y el halo del
# 3D se mezcla sin cortes.
# ---------------------------------------------------------------------------
lum = image.convert('L')
alpha = lum.point(
    lambda v: 0 if v <= 6 else (255 if v >= 34 else round((v - 6) * 255 / 28))
)
art = image.convert('RGBA')
art.putalpha(alpha)
bbox = alpha.getbbox()
if not bbox:
    raise SystemExit('No se pudo recortar el arte: la imagen parece estar en negro.')
art = art.crop(bbox)


def compose(size: int, fill: float) -> Image.Image:
    """Marca centrada sobre el azul marino del manifest, con su margen."""
    canvas = Image.new('RGB', (size, size), BG)
    inner = max(1, round(size * fill))
    scale = inner / max(art.size)
    width = max(1, round(art.width * scale))
    height = max(1, round(art.height * scale))
    pieza = art.resize((width, height), Image.Resampling.LANCZOS)
    canvas.paste(pieza, ((size - width) // 2, (size - height) // 2), pieza)
    return canvas


for size in (32, 180, 192, 512):
    # El favicon y el icono del teléfono van con la marca grande y legible.
    compose(size, 0.86).save(out / f'fulltech-crm-{size}.png', optimize=True)

# Maskable: la marca dentro de la zona segura (70 %) para que ningún recorte la coma.
compose(512, 0.70).save(out / 'fulltech-crm-maskable-512.png', optimize=True)

print('Icono de lanzador del CRM actualizado (32, 180, 192, 512 y maskable).')
