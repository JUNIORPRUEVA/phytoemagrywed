import fs from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const phase = process.argv[2] || 'after';
const out = 'docs/capturas/store-mobile';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
for (const [width, height, scale = 1] of [[320,568],[375,667],[390,844],[412,915],[430,932],[768,1024],[844,390],[320,568,1.25],[1280,800]]) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await context.route('**/*', route => ['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  if (process.env.VISUAL_FIXTURE === '1') await context.route('**/api/store/home', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.dailyOffers = [1,2].map(id => ({id:`visual-${id}`,name:`Producto visual ${id}`,price:1000,compareAtPrice:2000,discountPercent:50,currency:'DOP',imageUrl:'/store/icon.svg'}));
    await route.fulfill({json:data});
  });
  await page.goto('http://localhost:4175/store/index.html', { waitUntil: 'networkidle' });
  if (scale !== 1) await page.addStyleTag({ content: `html {font-size:${scale*100}% !important}` });
  await page.screenshot({path:`${out}/${phase}-${width}x${height}-${scale}.png`});
  const metrics = await page.evaluate(() => {
    const box = s => {const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return {width:r.width,height:r.height};};
    const visible = e => e.getBoundingClientRect().width && e.getBoundingClientRect().height && getComputedStyle(e).visibility !== 'hidden';
    const controls = [...document.querySelectorAll('.ft-header__row > .ft-iconbtn, .ft-header__actions > :not([hidden]), .ft-nav__item')].filter(visible);
    const overlaps = controls.flatMap((a,i)=>controls.slice(i+1).filter(b=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top;}).map(b=>[a.getAttribute('aria-label')||a.textContent.trim(),b.getAttribute('aria-label')||b.textContent.trim()]));
    const hitTargets = controls.map(e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:e.getAttribute('aria-label')||e.textContent.trim(),width:r.width,height:r.height,reachable:e===hit||e.contains(hit)};});
    return {overlaps,hitTargets,overflow:document.documentElement.scrollWidth>innerWidth,header:box('.ft-header'),logo:box('.ft-logo'),nav:box('.ft-nav'),target:box('.ft-nav__item'),search:box('.ft-search'),hero:box('.ft-hero'),offers:[...document.querySelectorAll('.ft-hero-offer')].map(e=>({href:e.getAttribute('href'),width:e.clientWidth,height:e.clientHeight}))};
  });
  results.push({width,height,scale,...metrics});
  for(const route of ['catalog','cart','request']) {
    await page.goto(`http://localhost:4175/store/#/${route}`,{waitUntil:'networkidle'});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) results.push({width,height,route,overflow:true});
  }
  await context.close();
}
await browser.close();
await fs.writeFile(`${out}/${phase}-metrics.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
if(results.some(r=>r.overflow||r.overlaps?.length||r.hitTargets?.some(t=>!t.reachable)))process.exitCode=1;
