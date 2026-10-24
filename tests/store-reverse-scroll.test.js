import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mountReverseScroll} from '../public/store/reverse-scroll.js';
let dispose;
beforeEach(()=>{document.body.innerHTML='<main><input><div class="track"></div></main>';vi.stubGlobal('matchMedia',()=>({matches:true}));vi.spyOn(window,'scrollBy').mockImplementation(()=>{});dispose=mountReverseScroll();});
afterEach(()=>{dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
function wheel(target=document.body,props={}){const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100,...props});target.dispatchEvent(e);return e;}
function touch(type,x,y){const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:type==='touchend'?[]:[{clientX:x,clientY:y}]});document.body.dispatchEvent(e);return e;}
it('reverses vertical wheel and accounts for line units',()=>{expect(wheel().defaultPrevented).toBe(true);expect(window.scrollBy).toHaveBeenLastCalledWith({top:-100,left:0,behavior:'instant'});wheel(document.body,{deltaMode:1,deltaY:-2});expect(window.scrollBy).toHaveBeenLastCalledWith({top:32,left:0,behavior:'instant'});});
it('leaves horizontal gestures, zoom and editable fields native',()=>{for(const e of [wheel(document.body,{deltaX:200}),wheel(document.body,{ctrlKey:true}),wheel(document.querySelector('input'))])expect(e.defaultPrevented).toBe(false);expect(window.scrollBy).not.toHaveBeenCalled();});
it('moves toward the top when the finger moves upward',()=>{touch('touchstart',100,300);expect(touch('touchmove',100,250).defaultPrevented).toBe(true);expect(window.scrollBy).toHaveBeenLastCalledWith({top:-50,left:0,behavior:'instant'});touch('touchend');});
it('preserves horizontal swipe and removes listeners on dispose',()=>{touch('touchstart',200,300);expect(touch('touchmove',100,303).defaultPrevented).toBe(false);expect(window.scrollBy).not.toHaveBeenCalled();dispose();expect(wheel().defaultPrevented).toBe(false);});
