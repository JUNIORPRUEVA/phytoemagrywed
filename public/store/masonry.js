/** Ordered shortest-column grid: DOM, keyboard and increasing visual Y order agree. */
export function mountMasonry(root){
  let frame=0,disposed=false;
  const observed=new Set();
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  function layout(){
    frame=0;if(disposed)return;
    root.querySelectorAll('.product-grid,.ft-grid').forEach(grid=>{
      if(!grid.children.length)return;
      grid.classList.add('ft-masonry');
      if(!observed.has(grid)){observed.add(grid);resize?.observe(grid);}
      const css=getComputedStyle(grid),columns=css.gridTemplateColumns.split(' ').length,row=parseFloat(css.gridAutoRows)||4,gap=parseFloat(css.rowGap)||8;
      const heights=Array(columns).fill(0);
      for(const card of grid.children){
        if(!observed.has(card)){observed.add(card);resize?.observe(card);}
        const col=heights.indexOf(Math.min(...heights)),span=Math.max(1,Math.ceil((card.getBoundingClientRect().height+gap)/(row+gap)));
        card.style.gridColumn=String(col+1);card.style.gridRow=`${heights[col]+1} / span ${span}`;heights[col]+=span;
      }
    });
    for(const node of observed)if(!node.isConnected){resize?.unobserve(node);observed.delete(node);}
  }
  function schedule(){if(!frame&&!disposed)frame=requestAnimationFrame(layout);}
  const mutations=new MutationObserver(schedule);mutations.observe(root,{childList:true,subtree:true});
  window.addEventListener('resize',schedule);layout();
  return {layout,dispose(){disposed=true;cancelAnimationFrame(frame);resize?.disconnect();mutations.disconnect();window.removeEventListener('resize',schedule);}};
}
