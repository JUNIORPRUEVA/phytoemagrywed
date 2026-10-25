"""Install the approved CRM artwork without modifying Store or Delivery icons."""
from pathlib import Path
from PIL import Image, ImageChops
import shutil
root=Path(__file__).resolve().parents[1]
source=Path('C:/Users/pc/Downloads/Icono azul de chat y perfil conectado.png')
original=root/'assets/branding/official-apps/crm'
out=root/'public/admin/assets/branding'
original.mkdir(parents=True,exist_ok=True)
out.mkdir(parents=True,exist_ok=True)
shutil.copy2(source,original/'source.png')
image=Image.open(source).convert('RGB')
image.resize((1024,1024),Image.Resampling.LANCZOS).save(original/'master-1024.png',optimize=True)
# La marca viene centrada con mucho aire blanco: se recorta al contenido para que
# el icono se vea grande y nítido en la pantalla del teléfono. El umbral es
# necesario porque el fondo blanco trae ruido de compresión y, sin él, el
# recorte sería la imagen entera y la marca seguiría pequeña.
diff=ImageChops.difference(image,Image.new('RGB',image.size,(255,255,255))).convert('L')
bbox=diff.point(lambda v:255 if v>12 else 0).getbbox()
art=image.crop(bbox)
def compose(size,fill):
    """Marca centrada sobre blanco (el propio fondo del logo) con su margen."""
    canvas=Image.new('RGB',(size,size),(255,255,255))
    inner=max(1,round(size*fill))
    scale=inner/max(art.size)
    width=max(1,round(art.width*scale)); height=max(1,round(art.height*scale))
    canvas.paste(art.resize((width,height),Image.Resampling.LANCZOS),((size-width)//2,(size-height)//2))
    return canvas
for size in [32,180,192,256,512]:
    compose(size,0.84 if size<180 else 0.80).save(out/f'fulltech-crm-{size}.png',optimize=True)
# Maskable: la marca dentro de la zona segura (80 %) para que ningún recorte la coma.
compose(512,0.69).save(out/'fulltech-crm-maskable-512.png',optimize=True)
# Marca recortada al contenido (sin margen): es la del arranque, donde no debe
# quedar espacio vacío alrededor del logo.
mark=Image.new('RGB',(256,256),(255,255,255))
scale=256/max(art.size)
mark_w=max(1,round(art.width*scale)); mark_h=max(1,round(art.height*scale))
mark.paste(art.resize((mark_w,mark_h),Image.Resampling.LANCZOS),((256-mark_w)//2,(256-mark_h)//2))
mark.save(out/'fulltech-crm-mark.png',optimize=True)
print('CRM original, master and seven display/install assets prepared.')
