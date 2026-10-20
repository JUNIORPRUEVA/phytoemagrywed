"""Genera los iconos de instalación web desde el logo Fulltech transparente."""
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'admin'
SOURCE = ROOT / 'assets' / 'branding' / 'fulltech-logo-source.png'

def icon(source, size, fraction=.98):
    base = Image.new('RGB', (size, size))
    pixels = base.load()
    for y in range(size):
        for x in range(size):
            t = (x+y) / max(1, (size-1)*2)
            pixels[x,y] = tuple(round(a+(b-a)*t) for a,b in zip((255,255,255),(217,234,255)))
    logo = source.copy()
    logo.thumbnail((round(size*fraction),round(size*fraction)),Image.Resampling.LANCZOS)
    base.paste(logo,((size-logo.width)//2,(size-logo.height)//2),logo)
    return base

def main():
    source = Image.open(SOURCE).convert('RGBA')
    source = source.crop(source.getchannel('A').getbbox())
    web_logo = source.copy()
    web_logo.thumbnail((512,512),Image.Resampling.LANCZOS)
    web_logo.save(OUT/'fulltech-logo.png',optimize=True)
    # Ignora píxeles casi transparentes del resplandor al calcular el tamaño.
    source = source.crop(source.getchannel('A').point(lambda a: 255 if a >= 128 else 0).getbbox())
    # El adaptable conserva margen para la máscara del launcher, sin el aire anterior.
    for name,size,fraction in [('fulltech-icon-192.png',192,.98),('fulltech-icon-512.png',512,.98),('fulltech-icon-maskable-512.png',512,.80),('fulltech-apple-touch-icon.png',180,.98),('fulltech-favicon.png',32,.98)]:
        icon(source,size,fraction).save(OUT/name,optimize=True)
        print(f'{name}: {size}x{size}')
if __name__ == '__main__':
    main()
