from PIL import Image, ImageDraw
from pathlib import Path
import json, hashlib
root=Path(__file__).resolve().parents[1]
delivery=root.parent/'FULLTECH-DELIVERY'
out=root/'docs/capturas/official-app-branding'
out.mkdir(parents=True,exist_ok=True)
panels=[]
for name,icon in [('Store',root/'public/store/assets/app-icons/maskable-512.png'),('Delivery',delivery/'assets/icon/maskable-1024.png')]:
    image=Image.open(icon).convert('RGB').resize((240,240),Image.Resampling.LANCZOS)
    panel=Image.new('RGB',(780,290),'#eef2f8')
    draw=ImageDraw.Draw(panel)
    for index,shape in enumerate(['square','round','circle']):
        mask=Image.new('L',(240,240),0)
        painter=ImageDraw.Draw(mask)
        if shape=='circle':painter.ellipse((0,0,239,239),fill=255)
        else:painter.rounded_rectangle((0,0,239,239),radius=48 if shape=='round' else 0,fill=255)
        panel.paste(image,(index*260,25),mask)
        draw.text((index*260+12,272),f'{name} - {shape}',fill='#142338')
    panels.append(panel)
preview=Image.new('RGB',(780,580),'white')
for i,panel in enumerate(panels):preview.paste(panel,(0,i*290))
preview.save(out/'icon-masks.png')
checked=[]
for asset in (root/'public/store/assets/app-icons').glob('*.png'):
    size=int(asset.stem.split('-')[-1]);image=Image.open(asset)
    assert image.size==(size,size) and image.mode=='RGB',asset
    checked.append(str(asset.relative_to(root)))
ios=delivery/'ios/Runner/Assets.xcassets/AppIcon.appiconset'
entries=json.loads((ios/'Contents.json').read_text())['images']
for entry in entries:
    size=round(float(entry['size'].split('x')[0])*float(entry['scale'].removesuffix('x')))
    image=Image.open(ios/entry['filename'])
    assert image.size==(size,size) and image.mode=='RGB',entry
for density,size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    asset=delivery/f'android/app/src/main/res/mipmap-{density}/ic_fulltech_delivery.png'
    assert Image.open(asset).size==(size,size),asset
for app,original in [(root/'assets/branding/official-apps/store/source.png',Path('C:/Users/pc/Downloads/Logotipo futurista Fulltech Store (1).png')),(delivery/'assets/branding/official/source.png',Path('C:/Users/pc/Downloads/Repartidor futurista en scooter azul.png'))]:
    assert hashlib.sha256(app.read_bytes()).digest()==hashlib.sha256(original.read_bytes()).digest()
print(f'OK: {len(checked)} PWA icons, {len(entries)} iOS entries, 5 Android densities, preserved sources. Masks: {out}/icon-masks.png')
