import sharp from 'sharp';
// Preserve the approved transparent artwork; no background is composited.
const source = 'public/store/assets/branding/fulltech-store-header-transparent-432.png';
for (const size of [192,512]) {
  await sharp(source).resize(size,size,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toFile(`public/store/launcher-${size}.png`);
}
