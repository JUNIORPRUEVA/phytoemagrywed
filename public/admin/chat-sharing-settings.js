(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const definitions={
    locations:[['name','Nombre','Ej. Oficina principal',120],['address','Dirección','Dirección del negocio',300],['latitude','Latitud','Ej. 18.4861',null,'number'],['longitude','Longitud','Ej. -69.9312',null,'number']],
    banks:[['bank','Banco','Nombre del banco',100],['holder','Titular','Nombre de la persona o empresa',160],['number','Número de cuenta','Conserva los ceros iniciales',64],['type','Tipo de cuenta','Ej. Ahorros o corriente',80],['currency','Moneda','',null,'select'],['note','Nota opcional','Ej. Envíanos el comprobante al transferir',250]],
    catalogs:[['name','Nombre del catálogo','Ej. Phytoemagry o FullTECH',100],['url','Página web','https://…',1200,'url'],['message','Texto del mensaje (opcional)','Ej. Mira nuestros productos y precios:',500]],
  };
  const labels={locations:'Ubicación',banks:'Cuenta bancaria',catalogs:'Catálogo'};
  let busy=false,sequence=0,disposeMap=null,lastPage='';
  const pageKinds={'compartir-ubicaciones':'locations','compartir-bancos':'banks','compartir-catalogos':'catalogs'};
  function updatePage(){
    const page=document.body.dataset.settingsPage;
    if(page!==lastPage){disposeMap?.();lastPage=page;}
    const kind=pageKinds[page];
    $('sharing-settings-home').hidden=Boolean(kind);
    $('chat-sharing-form').hidden=!kind;
    for(const entry of Object.keys(definitions)){
      const group=$('sharing-edit-'+entry).closest('section');group.hidden=entry!==kind;
      group.querySelectorAll('input,select,button,textarea').forEach(node=>node.disabled=busy||entry!==kind);
    }
  }
  function selectMap(row){
    disposeMap?.();
    if(!window.L){feedback('No se pudo abrir el mapa. Puedes usar tu ubicación actual o escribir las coordenadas.');return;}
    const panel=document.createElement('section');panel.className='sharing-map-picker';
    panel.innerHTML='<p>Toca el lugar del negocio en el mapa o arrastra el marcador. Después confirma la ubicación.</p><div class="sharing-map-canvas" role="region" aria-label="Seleccionar ubicación del negocio"></div><p data-map-coordinates role="status"></p><div class="sharing-actions"><button class="btn btn--primary" data-map-confirm type="button" disabled>Usar esta ubicación</button><button class="btn btn--ghost" data-map-cancel type="button">Cancelar</button></div>';
    row.append(panel);
    const lat=row.querySelector('[data-sharing-field="latitude"]'),lng=row.querySelector('[data-sharing-field="longitude"]');
    const existing=lat.value.trim()&&lng.value.trim()&&Number.isFinite(Number(lat.value))&&Number.isFinite(Number(lng.value));
    const map=window.L.map(panel.querySelector('.sharing-map-canvas')).setView(existing?[Number(lat.value),Number(lng.value)]:[18.7357,-70.1627],existing?17:8);
    const tiles=window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    let point=null,marker=null;
    const select=value=>{
      point={lat:value.lat,lng:value.lng};
      if(!marker){marker=window.L.marker(point,{draggable:true}).addTo(map);marker.on('dragend',()=>select(marker.getLatLng()));}else marker.setLatLng(point);
      panel.querySelector('[data-map-coordinates]').textContent=`Ubicación seleccionada: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
      panel.querySelector('[data-map-confirm]').disabled=false;
    };
    map.on('click',event=>select(event.latlng));
    tiles.on('tileerror',()=>{panel.querySelector('[data-map-coordinates]').textContent='No se pudo cargar parte del mapa. Revisa tu conexión o usa tu ubicación actual.';});
    if(existing)select({lat:Number(lat.value),lng:Number(lng.value)});
    const close=()=>{map.remove();panel.remove();disposeMap=null;};disposeMap=close;
    panel.querySelector('[data-map-cancel]').addEventListener('click',close);
    panel.querySelector('[data-map-confirm]').addEventListener('click',()=>{
      if(!point)return;lat.value=point.lat.toFixed(6);lng.value=point.lng.toFixed(6);row.dispatchEvent(new Event('input',{bubbles:true}));close();feedback('Ubicación seleccionada. Pulsa Guardar para conservarla.');
    });
    map.invalidateSize();
  }
  const feedback=text=>{$('sharing-settings-feedback').textContent=text;};
  function setBusy(value){busy=value;$('chat-sharing-form').querySelectorAll('input,select,button,textarea').forEach(node=>{node.disabled=value||Boolean(node.closest('.sharing-editor-group')?.hidden);});}
  async function request(body){
    const response=await fetch(body?'/api/admin/settings/chat-sharing':'/api/admin/chat-sharing',{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.message||'No se pudo completar la operación.');return result.sharing;
  }
  function addRow(kind,value={}){
    const container=$('sharing-edit-'+kind);
    if(container.children.length>=10){feedback('Puedes guardar hasta 10 opciones por grupo.');return;}
    const row=document.createElement('article');row.className='sharing-editor-row';
    row.dataset.id=value.id||`${kind}-${Date.now()}-${++sequence}`;
    const uid=`sharing-field-${++sequence}`;
    row.innerHTML=`<header><h4>${labels[kind]}</h4><button class="btn btn--ghost" data-sharing-remove type="button" aria-label="Eliminar ${labels[kind].toLowerCase()}">Eliminar</button></header><div class="sharing-fields">${definitions[kind].map(([key,label,placeholder,max,type],i)=>`<label class="field" for="${uid}-${i}"><span>${label}</span>${type==='select'?`<select class="field__select" id="${uid}-${i}" data-sharing-field="${key}">${['DOP','USD','EUR'].map(currency=>`<option value="${currency}" ${currency===(value[key]||'DOP')?'selected':''}>${currency}</option>`).join('')}</select>`:`<input class="field__input" id="${uid}-${i}" data-sharing-field="${key}" type="${type||'text'}" ${max?`maxlength="${max}"`:''} ${type==='number'?`step="any" min="${key==='latitude'?-90:-180}" max="${key==='latitude'?90:180}"`:''} ${['name','bank','holder','number','url','latitude','longitude'].includes(key)?'required':''} placeholder="${esc(placeholder)}" value="${esc(value[key])}" />`}</label>`).join('')}</div>${kind==='locations'?'<button class="btn btn--primary" data-sharing-select-map type="button">Seleccionar en el mapa</button><button class="btn btn--ghost" data-sharing-current type="button">Usar mi ubicación actual</button><a class="btn btn--ghost" data-sharing-map target="_blank" rel="noopener noreferrer" hidden>Ver ubicación en el mapa</a>':''}`;
    row.querySelector('[data-sharing-remove]').addEventListener('click',()=>{disposeMap?.();row.remove();});
    if(kind==='locations'){
      row.querySelector('[data-sharing-select-map]').addEventListener('click',()=>selectMap(row));
      const coordinates=()=>({lat:row.querySelector('[data-sharing-field="latitude"]'),lng:row.querySelector('[data-sharing-field="longitude"]')});
      const preview=()=>{const{lat,lng}=coordinates(),a=Number(lat.value),b=Number(lng.value),link=row.querySelector('[data-sharing-map]');const valid=lat.value.trim()&&lng.value.trim()&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a)<=90&&Math.abs(b)<=180;link.hidden=!valid;if(valid)link.href=`https://www.google.com/maps?q=${encodeURIComponent(a+','+b)}`;};
      row.addEventListener('input',preview);preview();
      row.querySelector('[data-sharing-current]').addEventListener('click',event=>{
        if(!navigator.geolocation){feedback('Este dispositivo no ofrece ubicación. Escribe las coordenadas.');return;}
        const button=event.currentTarget;button.disabled=true;button.textContent='Buscando ubicación…';
        const done=()=>{button.disabled=false;button.textContent='Usar mi ubicación actual';};
        navigator.geolocation.getCurrentPosition(position=>{if(row.isConnected){const{lat,lng}=coordinates();lat.value=position.coords.latitude;lng.value=position.coords.longitude;preview();}done();},()=>{feedback('No se pudo obtener la ubicación. Puedes escribir las coordenadas.');done();},{timeout:10000,maximumAge:0,enableHighAccuracy:true});
      });
    }
    container.append(row);row.querySelectorAll('input,select,button').forEach(node=>node.disabled=busy||container.closest('section').hidden);return row;
  }
  function render(data){disposeMap?.();for(const kind of Object.keys(definitions)){$('sharing-edit-'+kind).replaceChildren();for(const value of data[kind]||[])addRow(kind,value);}}
  async function load(){if(busy||!$('config-chat-sharing')||$('config-chat-sharing').hidden)return;setBusy(true);feedback('');try{render(await request());}catch(error){feedback(error.message);}finally{setBusy(false);}}
  document.addEventListener('DOMContentLoaded',()=>{
    const card=$('config-chat-sharing');if(!card)return;
    if(card.dataset.sharingInitialized==='true')return;
    card.dataset.sharingInitialized='true';
    window.addEventListener('fulltech:sharing-page',updatePage);
    updatePage();
    let hidden=card.hidden;
    new MutationObserver(()=>{if(hidden&&!card.hidden)load();hidden=card.hidden;}).observe(card,{attributes:true,attributeFilter:['hidden']});
    document.querySelectorAll('[data-sharing-add]').forEach(button=>button.addEventListener('click',()=>{
      const kind=button.dataset.sharingAdd;
      const defaults=kind==='catalogs'&&!$('sharing-edit-catalogs').children.length?{name:'Phytoemagry',url:'https://phytoemagryrd.lat/'}:{};
      const row=addRow(kind,defaults);row?.querySelector('input')?.focus({preventScroll:true});
    }));
    $('chat-sharing-form').addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      const data={};for(const kind of Object.keys(definitions))data[kind]=[...$('sharing-edit-'+kind).children].map(row=>Object.fromEntries([['id',row.dataset.id],...[...row.querySelectorAll('[data-sharing-field]')].map(input=>[input.dataset.sharingField,input.value])]));
      setBusy(true);feedback('Guardando…');
      try{await request(data);render(await request());feedback('Opciones guardadas. Ya están disponibles en el botón + del chat.');}
      catch(error){feedback(error.message);}
      finally{setBusy(false);}
    });
    load();
  });
})();
