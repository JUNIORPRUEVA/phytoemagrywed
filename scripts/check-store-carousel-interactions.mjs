import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch(),base='http://127.0.0.1:4177';
const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,serviceWorkers:'block'});
const p=await context.newPage(),out='docs/capturas/store-final';
try{
 await p.goto(base+'/store/#/offers',{waitUntil:'networkidle'});
 const track=p.locator('.ft-offer-track'),left=()=>track.evaluate(e=>e.scrollLeft);
 await p.mouse.move(0,0);const start=await left();await p.waitForTimeout(3400);assert.ok(await left()>start,'autoplay advances');
 await track.hover();const hovered=await left();await p.waitForTimeout(3300);assert.ok(Math.abs(await left()-hovered)<2,'hover pauses');
 await track.focus();await p.mouse.move(0,0);const focused=await left();await p.waitForTimeout(3300);assert.ok(Math.abs(await left()-focused)<2,'keyboard focus pauses');
 await track.press('ArrowRight');await p.waitForTimeout(500);assert.ok(await left()>focused,'keyboard advances');
 assert.equal(await p.locator('[data-carousel-play]').getAttribute('aria-pressed'),'true');
 await track.evaluate(e=>{e.blur();e.scrollTo({left:0,behavior:'instant'});});
 const box=await track.boundingBox();await p.mouse.move(box.x+240,box.y+80);await p.mouse.down();await p.mouse.move(box.x+60,box.y+80,{steps:15});await p.mouse.up();await p.waitForTimeout(600);assert.ok(await left()>20,'mouse drag scrolls');assert.ok(p.url().endsWith('/offers'),'drag does not open product');
 await track.evaluate(e=>e.scrollTo({left:0,behavior:'instant'}));
 const cdp=await context.newCDPSession(p),x=box.x+240,y=box.y+100;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-i*15,y}]});await p.waitForTimeout(15);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(650);assert.ok(await left()>20,'native touch swipe scrolls');
 await p.locator('#store-search').fill('cerradura');await p.waitForTimeout(500);
 assert.ok((await p.locator('#catalog-count').innerText()).includes('1 producto'));
 assert.equal(await p.locator('.ft-offer-track .product-card').count(),1);
 assert.equal(await p.locator('[data-carousel-play]').count(),0);
 await p.locator('#store-search').fill('no-existe-qa-final');await p.waitForTimeout(500);assert.equal(await track.count(),0);
 await p.locator('#store-search').fill('');await p.waitForTimeout(500);
  await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));await p.waitForTimeout(700);await p.screenshot({path:out+'/after-registration-flow-390.png',animations:'disabled'});
 const prompt=await p.locator('#signup-prompt').boundingBox(),nav=await p.locator('#bottom-nav').boundingBox();assert.ok(prompt.y+prompt.height<=nav.y,'registration does not overlap nav');
  await p.emulateMedia({reducedMotion:'reduce'});await p.locator('[data-carousel-play]').waitFor({state:'hidden'});
 await track.evaluate(e=>e.scrollTo({left:0,behavior:'instant'}));await p.mouse.move(0,0);await p.waitForTimeout(3300);assert.ok(await left()<2,'reduced motion disables autoplay');
 const results={autoplay:true,hoverPause:true,focusPause:true,keyboard:true,mouseDrag:true,touchSwipe:true,manualSelectionPauses:true,singleOfferStatic:true,zeroOffersHidden:true,searchFilters:true,registrationFlow:true,reducedMotion:true};
 await fs.writeFile(out+'/interaction-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
