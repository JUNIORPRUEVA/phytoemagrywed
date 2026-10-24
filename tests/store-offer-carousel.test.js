import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOfferCarousel } from '../public/store/offer-carousel.js';

let root,track,motion,dispose;
beforeEach(()=>{
  vi.useFakeTimers();
  motion=new EventTarget();motion.matches=false;
  vi.stubGlobal('matchMedia',()=>motion);
  vi.stubGlobal('IntersectionObserver',undefined);
  document.body.innerHTML='<section><button data-carousel-play></button><button data-slide="1">Next</button><div class="ft-offer-track" tabindex="0"><a>One</a><a>Two</a><a>Three</a></div></section>';
  root=document.querySelector('section');track=root.querySelector('.ft-offer-track');
  Object.defineProperties(track,{scrollWidth:{value:900},clientWidth:{value:300}});
  [...track.children].forEach((child,i)=>Object.defineProperty(child,'offsetLeft',{value:i*300}));
  track.scrollTo=vi.fn(({left})=>{track.scrollLeft=left;});
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
});
afterEach(()=>{dispose?.();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();document.body.innerHTML='';});
describe('offers carousel',()=>{
  it('advances every 3 seconds, wraps, and cleans up on unmount',()=>{
    dispose=mountOfferCarousel(root);
    vi.advanceTimersByTime(9000);expect(track.scrollTo.mock.calls.map(([x])=>x.left)).toEqual([300,600,0]);
    dispose();expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);expect(track.scrollTo).toHaveBeenCalledTimes(3);
  });
  it('pauses on hover, focus, hidden document and reduced motion',()=>{
    dispose=mountOfferCarousel(root);
    root.dispatchEvent(new Event('mouseenter'));vi.advanceTimersByTime(3000);expect(track.scrollTo).not.toHaveBeenCalled();
    root.dispatchEvent(new Event('mouseleave'));track.focus();vi.advanceTimersByTime(3000);expect(track.scrollTo).not.toHaveBeenCalled();
    track.blur();Object.defineProperty(document,'hidden',{configurable:true,value:true});vi.advanceTimersByTime(3000);expect(track.scrollTo).not.toHaveBeenCalled();
    Object.defineProperty(document,'hidden',{configurable:true,value:false});motion.matches=true;motion.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(3000);expect(track.scrollTo).not.toHaveBeenCalled();expect(root.querySelector('[data-carousel-play]').hidden).toBe(true);
    motion.matches=false;motion.dispatchEvent(new Event('change'));vi.advanceTimersByTime(3000);expect(track.scrollTo).toHaveBeenCalledTimes(1);
  });
  it('keeps a keyboard selection paused until explicit resume',()=>{
    dispose=mountOfferCarousel(root);
    track.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    expect(track.scrollLeft).toBe(300);expect(root.querySelector('[data-carousel-play]').getAttribute('aria-pressed')).toBe('true');
    vi.advanceTimersByTime(9000);expect(track.scrollTo).toHaveBeenCalledTimes(1);
    root.querySelector('[data-carousel-play]').click();vi.advanceTimersByTime(3000);expect(track.scrollLeft).toBe(600);
  });
  it('does not create duplicate timers when remounted',()=>{
    mountOfferCarousel(root);dispose=mountOfferCarousel(root);expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);expect(track.scrollTo).toHaveBeenCalledTimes(1);
    root.remove();vi.advanceTimersByTime(3000);expect(vi.getTimerCount()).toBe(0);
  });
  it.each([1,2])('keeps %i offer(s) static without an autoplay timer',count=>{
    while(track.children.length>count)track.lastElementChild.remove();
    dispose=mountOfferCarousel(root);expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses on trackpad interaction',()=>{
    dispose=mountOfferCarousel(root);track.dispatchEvent(new WheelEvent('wheel',{deltaX:50}));
    vi.advanceTimersByTime(6000);expect(track.scrollTo).not.toHaveBeenCalled();
  });
});
