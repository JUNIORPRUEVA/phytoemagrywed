"""Genera tamaños de instalación desde el logo Fulltech transparente.

Los iconos opacos funcionan en iOS; el maskable conserva el logo en la zona
segura central. No cambia los identificadores de instalación ni del bridge.
"""
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
    android = ROOT/'apps/phyto_printer/android/app/src/main/res'
    for density,size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
        icon(source,size,.98).save(android/f'mipmap-{density}'/'ic_launcher.png',optimize=True)
        launch_dir = android/f'drawable-{density}'
        launch_dir.mkdir(exist_ok=True)
        icon(source,size*3,.82).save(launch_dir/'fulltech_launch.png',optimize=True)

if __name__ == '__main__':
    main()
