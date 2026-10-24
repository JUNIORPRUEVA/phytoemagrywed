"""Install the approved CRM artwork without modifying Store or Delivery icons."""
from pathlib import Path
from PIL import Image
import shutil
root=Path(__file__).resolve().parents[1]
source=Path('C:/Users/pc/Downloads/Logotipo futurista FULLTECH CRM (1).png')
original=root/'assets/branding/official-apps/crm'
out=root/'public/admin/assets/branding'
original.mkdir(parents=True,exist_ok=True)
out.mkdir(parents=True,exist_ok=True)
shutil.copy2(source,original/'source.png')
image=Image.open(source).convert('RGB')
image.resize((1024,1024),Image.Resampling.LANCZOS).save(original/'master-1024.png',optimize=True)
for size in [32,180,192,256,512]:
    image.resize((size,size),Image.Resampling.LANCZOS).save(out/f'fulltech-crm-{size}.png',optimize=True)
# Continue the source background into the safe margin without adding a border.
size=512; inner=410; edge=(size-inner)//2
small=image.resize((inner,inner),Image.Resampling.LANCZOS)
maskable=Image.new('RGB',(size,size))
for y in range(size):
    sy=max(0,min(inner-1,y-edge))
    maskable.paste(small.crop((0,sy,1,sy+1)).resize((edge,1)),(0,y))
    maskable.paste(small.crop((0,sy,inner,sy+1)),(edge,y))
    maskable.paste(small.crop((inner-1,sy,inner,sy+1)).resize((size-edge-inner,1)),(edge+inner,y))
maskable.save(out/'fulltech-crm-maskable-512.png',optimize=True)
print('CRM original, master and six display/install assets prepared.')
