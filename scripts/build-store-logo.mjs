import sharp from 'sharp';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source=process.argv[2] || 'assets/branding/fulltech-store-approved-original.png';
const archived='assets/branding/fulltech-store-approved-original.png';
const out='public/store/assets/branding';
await mkdir(out,{recursive:true});
if(source!==archived)await copyFile(source,archived);
// Coordinates retain the approved highlights, lettering, shadows and reflection.
const full=await sharp(archived).extract({left:28,top:232,width:1604,height:562}).png().toBuffer();
const emblem=await sharp(archived).extract({left:28,top:232,width:510,height:562}).png().toBuffer();
const lettering=await sharp(archived).extract({left:556,top:330,width:1076,height:324}).resize({height:562,kernel:'lanczos3'}).png().toBuffer();
const letterMeta=await sharp(lettering).metadata();
const compact=await sharp({create:{width:510+18+letterMeta.width,height:562,channels:3,background:'#ffffff'}}).composite([{input:emblem,left:0,top:0},{input:lettering,left:528,top:0}]).png().toBuffer();
const assets=[];
for(const [name,buffer,widths] of [['horizontal',full,[240,480,720]],['compact',compact,[192,384,576]]]){
 await writeFile(`assets/branding/fulltech-store-${name}-master.png`,buffer);
 for(const width of widths)for(const format of ['png','webp']){
  const file=`${out}/fulltech-store-${name}-${width}.${format}`;
  const pipeline=sharp(buffer).resize({width,kernel:'lanczos3'});
  await (format==='webp'?pipeline.webp({lossless:true,effort:6}):pipeline.png({compressionLevel:9})).toFile(file);
  assets.push({file,bytes:(await stat(file)).size,...await sharp(file).metadata().then(({width,height})=>({width,height}))});
 }
}
await writeFile('assets/branding/fulltech-store-assets.json',JSON.stringify({source:archived,sha256:createHash('sha256').update(await readFile(archived)).digest('hex'),fullCrop:{left:28,top:232,width:1604,height:562},compact:{width:510+18+letterMeta.width,height:562},assets},null,2));
console.log(JSON.stringify(assets));
