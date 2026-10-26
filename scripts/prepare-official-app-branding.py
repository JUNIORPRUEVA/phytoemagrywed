"""Deterministic resizing only; original approved artwork is never regenerated.

Uso:  python scripts/prepare-official-app-branding.py [store] [delivery]
Sin argumentos regenera las dos apps; con "store" solo toca la tienda.
"""
from pathlib import Path
from PIL import Image, ImageChops
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
DELIVERY = ROOT.parent / 'FULLTECH-DELIVERY'
DOWNLOADS = Path('C:/Users/pc/Downloads')
# Logo aprobado de la tienda: «FULLTECH STORE» con el repartidor en la moto.
STORE_SOURCE = DOWNLOADS / 'Logotipo futurista de reparto FULLTECH STORE.png'
DELIVERY_SOURCE = DOWNLOADS / 'Repartidor futurista en scooter azul.png'
NAVY = '#031a41'
TARGETS = {value.lower() for value in sys.argv[1:] if not value.startswith('-')} or {'store', 'delivery'}

def content(source, background=(255, 255, 255)):
    """Recorta el aire alrededor de la marca.

    El umbral no es opcional: el fondo blanco trae ruido de compresión y, sin él,
    el recorte sería la imagen entera y el logo quedaría pequeño en el icono.
    """
    im = Image.open(source).convert('RGB')
    diff = ImageChops.difference(im, Image.new('RGB', im.size, background)).convert('L')
    return im.crop(diff.point(lambda v: 255 if v > 12 else 0).getbbox())

def icon(source, size, fill, background=(255, 255, 255)):
    """Marca recortada, centrada sobre blanco (el propio fondo del logo)."""
    art = content(source)
    canvas = Image.new('RGB', (size, size), background)
    inner = max(1, round(size * fill))
    scale = inner / max(art.size)
    width, height = max(1, round(art.width * scale)), max(1, round(art.height * scale))
    canvas.paste(art.resize((width, height), Image.Resampling.LANCZOS), ((size - width) // 2, (size - height) // 2))
    return canvas

def square(source, size, fraction=1, transparent=False):
    im = Image.open(source).convert('RGBA')
    im.thumbnail((round(size*fraction), round(size*fraction)), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (size,size), (0,0,0,0) if transparent else NAVY)
    x,y=(size-im.width)//2,(size-im.height)//2
    # Continue the source's own edge pixels into the safe margin; no framed square.
    if x and y and not transparent:
        canvas.paste(im.crop((0,0,im.width,1)).resize((im.width,y)),(x,0))
        canvas.paste(im.crop((0,im.height-1,im.width,im.height)).resize((im.width,size-y-im.height)),(x,y+im.height))
        canvas.paste(im.crop((0,0,1,im.height)).resize((x,im.height)),(0,y))
        canvas.paste(im.crop((im.width-1,0,im.width,im.height)).resize((size-x-im.width,im.height)),(x+im.width,y))
        for cx,cy,px,py,w,h in [(0,0,0,0,x,y),(x+im.width,0,im.width-1,0,size-x-im.width,y),(0,y+im.height,0,im.height-1,x,size-y-im.height),(x+im.width,y+im.height,im.width-1,im.height-1,size-x-im.width,size-y-im.height)]:
            canvas.paste(im.getpixel((px,py)),(cx,cy,cx+w,cy+h))
    canvas.alpha_composite(im, (x,y))
    return canvas if transparent else canvas.convert('RGB')

for name, source, root in [('store', STORE_SOURCE, ROOT/'assets/branding/official-apps/store'), ('delivery', DELIVERY_SOURCE, DELIVERY/'assets/branding/official')]:
    if name not in TARGETS:
        continue
    root.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source,root/'source.png')
    square(source,1024).save(root/'master-1024.png',optimize=True)

if 'store' in TARGETS:
    icons=ROOT/'public/store/assets/app-icons'
    icons.mkdir(parents=True,exist_ok=True)
    for size in [32,120,152,167,180,192,512,1024]:
        icon(STORE_SOURCE,size,.88).save(icons/f'icon-{size}.png',optimize=True)
    for size in [192,512]:
        # Maskable: la marca dentro de la zona segura para que el recorte no la coma.
        icon(STORE_SOURCE,size,.72).save(icons/f'maskable-{size}.png',optimize=True)

if 'delivery' in TARGETS:
    delivery_icons=DELIVERY/'assets/icon'
    delivery_icons.mkdir(parents=True,exist_ok=True)
    square(DELIVERY_SOURCE,1024,.80).save(delivery_icons/'launcher.png',optimize=True)
    square(DELIVERY_SOURCE,1024,.44,True).save(delivery_icons/'launcher_foreground.png',optimize=True)
    square(DELIVERY_SOURCE,1024,.68).save(delivery_icons/'maskable-1024.png',optimize=True)
    for size in [192,512]:
        square(DELIVERY_SOURCE,size,.80).save(delivery_icons/f'pwa-{size}.png',optimize=True)
        square(DELIVERY_SOURCE,size,.68).save(delivery_icons/f'pwa-maskable-{size}.png',optimize=True)
print('Store and Delivery icons generated separately from preserved originals.')
