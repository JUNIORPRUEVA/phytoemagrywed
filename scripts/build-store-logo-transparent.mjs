// Deterministic alpha extraction from the approved compact master; no generation.
import sharp from 'sharp';
import {writeFile,stat} from 'node:fs/promises';
const source='assets/branding/fulltech-store-compact-master.png';
const {data,info}=await sharp(source).removeAlpha().raw().toBuffer({resolveWithObject:true});
const {width:w,height:h}=info, count=w*h;
const mask=new Uint8Array(count), queue=new Int32Array(count);let head=0,tail=0;
const eligible=i=>{const p=i*3;const lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);return lo>=160&&hi-lo<=100};
const add=i=>{if(!mask[i]&&eligible(i)){mask[i]=1;queue[tail++]=i}};
for(let x=0;x<w;x++){add(x);add((h-1)*w+x)}for(let y=0;y<h;y++){add(y*w);add(y*w+w-1)}
// Interior background openings in the emblem and STORE O/R, not highlights.
for(const [x,y] of [[221,140],[1431,461],[1627,445]])add(y*w+x);
while(head<tail){const i=queue[head++],x=i%w;if(x)add(i-1);if(x<w-1)add(i+1);if(i>=w)add(i-w);if(i<count-w)add(i+w)}
const rgba=Buffer.alloc(count*4);
for(let i=0;i<count;i++){
 const p=i*3,q=i*4;let alpha=1;
 if(mask[i]){const lo=Math.min(data[p],data[p+1],data[p+2]);alpha=lo>=247?0:(255-lo)/255;}
 for(let c=0;c<3;c++)rgba[q+c]=alpha?Math.max(0,Math.min(255,Math.round((data[p+c]-255*(1-alpha))/alpha))):0;
 rgba[q+3]=Math.round(alpha*255);
}
// Trim only fully transparent outer rows/columns, retaining reflections.
let left=w,top=h,right=0,bottom=0;
for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(rgba[(y*w+x)*4+3]>0){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
const master=await sharp(rgba,{raw:{width:w,height:h,channels:4}}).extract({left,top,width:right-left+1,height:bottom-top+1}).png().toBuffer();
await writeFile('assets/branding/fulltech-store-header-transparent-master.png',master);
const assets=[];
for(const width of [144,288,432])for(const format of ['png','webp']){
 const file=`public/store/assets/branding/fulltech-store-header-transparent-${width}.${format}`;
 const p=sharp(master).resize({width});await (format==='png'?p.png({compressionLevel:9}):p.webp({lossless:true,effort:6})).toFile(file);
 assets.push({file,bytes:(await stat(file)).size,...await sharp(file).metadata().then(({width,height,hasAlpha})=>({width,height,hasAlpha}))});
}
await writeFile('assets/branding/fulltech-store-header-transparent.json',JSON.stringify({source,crop:{left,top,width:right-left+1,height:bottom-top+1},assets},null,2));console.log(assets);
for(const [name,background] of [['dark','#111b2a'],['light','#f5f7fb']])await sharp('public/store/assets/branding/fulltech-store-header-transparent-432.png').flatten({background}).png().toFile(`docs/capturas/fulltech-logo-refinement/alpha-${name}.png`);
