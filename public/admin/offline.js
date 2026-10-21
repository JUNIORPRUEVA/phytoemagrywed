/* Copia privada de 24 horas, descarga anticipada y diario durable de operaciones. */
(() => {
  'use strict';
  const db=window.FulltechOfflineStore, network=window.fetch.bind(window), DAY=86400000;
  let identity=null,warming=null,syncing=null,epoch=0,localTail=Promise.resolve(),storageAvailable=true;
  /*
   * DIAGNÓSTICO DE LO QUE FALLA (últimos 40 eventos, en memoria del panel).
   * Sin esto, «no cargó» era indistinguible de «no hay copia» o «sin permiso»:
   * aquí queda la ruta, la causa (red / tiempo / HTTP) y si había copia local.
   */
  const diag=[];
  function recordDiag(entry){
    try{diag.push({at:Date.now(),...entry});if(diag.length>40)diag.shift();}catch{}
  }
  const ready=db.get('identity').then(value=>{identity=value||null;}).catch(()=>{storageAvailable=false;});
  const valid=()=>storageAvailable&&!!identity&&Date.now()-identity.verifiedAt<=DAY;
  const owner=()=>identity?.key;
  const responseKey=url=>'response:'+owner()+':'+new URL(url,location.href).href;
  const queueKey=()=> 'queue:'+owner();
  const clone=value=>structuredClone(value);
  const uuid=()=>crypto.randomUUID();
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-fulltech-local':'1'}});
  const excluded=url=>/\/(calling|push-subscriptions|proofreading|ai\/reply-suggestion)(\/|$)|\/wa-templates.*sync|\/(send|invoice-whatsapp|meta-purchase|message-send)(\/|$)|\/conversations\/[^/]+\/messages$/.test(url.pathname);
  const protectedWrite=url=>excluded(url)||/\/(auth|login|logout)(\/|$)|\/password(?:\/|$)|\/whatsapp|\/deepseek\/test$|\/locations\/[^/]+\/share$|\/conversations\/[^/]+\/(location|order-confirmation)$|\/customer-campaigns\//.test(url.pathname);
  /*
   * MARCAS DE «LEÍDO» Y SEÑALES DE PRESENCIA: NO SON UN CAMBIO.
   *
   * `POST /conversations/:id/read`, `POST /notifications/:id/read` o el aviso de
   * «escribiendo» solo dicen que alguien miró algo. Guardarlos en la cola hacía
   * que el panel mostrara para siempre «1 cambio pendiente de sincronizar» que,
   * al enviarse tarde, ya no significa nada: era el cambio fantasma que no se
   * aplicaba nunca. Si falla la red, se descarta en silencio y se reintenta la
   * próxima vez que se abra la pantalla.
   */
  const efimeroPath=pathname=>/\/(read|seen|visit|heartbeat|presence|typing)(\/|$)/.test(pathname)||/\/calling(\/|$)/.test(pathname);
  const efimero=url=>efimeroPath(url.pathname);
  function signal(){window.dispatchEvent(new Event('fulltech:offline-status'));}
  /*
   * Avisa a la página de que esa respuesta salió de la COPIA LOCAL. Con eso el
   * panel sabe que lo que está pintando puede estar viejo y vuelve a pedirlo.
   */
  function servedLocal(url,at){
    try{window.dispatchEvent(new CustomEvent('fulltech:served-local',{detail:{path:new URL(url,location.href).pathname,at:at||null}}));}catch{}
  }
  /**
   * ADOPTA LA COLA GUARDADA CON LA CLAVE ANTIGUA (la que incluía los permisos).
   *
   * No se borra nada: se copian las operaciones que falten a la clave nueva y se
   * deja la antigua intacta por si hiciera falta recuperarla.
   */
  async function adoptarColaAntigua(nueva){
    try{
      const entradas=await db.entries();
      for(const [clave,valor] of entradas){
        if(!clave.startsWith('queue:')||clave==='queue:'+nueva)continue;
        let partes=null;
        try{partes=JSON.parse(clave.slice(6));}catch{continue;}
        if(!Array.isArray(partes)||partes.length<2)continue;
        if(JSON.stringify([partes[0],partes[1]])!==nueva)continue;
        if(!Array.isArray(valor)||!valor.length)continue;
        const actual=(await db.get('queue:'+nueva))||[];
        const ids=new Set(actual.map(p=>p.id));
        const fusion=[...actual,...valor.filter(p=>p&&p.id&&!ids.has(p.id))];
        if(fusion.length>actual.length){
          await db.put('queue:'+nueva,fusion);
          recordDiag({path:'/offline/cola',cause:'migrada',status:0});
        }
      }
    }catch{/* si no se puede enumerar, la cola nueva sigue funcionando */}
  }
  async function identify(payload){
    await localTail.catch(()=>{});
    if(!storageAvailable)return;
    try{
    const auth=payload.auth||payload;
    if(!auth.user&&!auth.legacy)return;
    /*
     * LA CLAVE DE LA CUENTA NO LLEVA LOS PERMISOS.
     *
     * Antes era `[usuario, rol, permisos]`. El inicio de sesión responde sin la
     * lista de permisos y `/api/admin/data` con ella, así que la clave cambiaba
     * sola entre dos respuestas: la cola quedaba guardada bajo una clave y el
     * panel leía otra (operaciones «perdidas», copia local borrada y descargas
     * contadas dos veces). Los permisos no identifican a la persona: la clave es
     * usuario + rol.
     */
    const key=(()=>{const id=auth.user?.id||'LEGACY_PANEL';const rol=auth.user?.role||'ADMIN';return JSON.stringify([id,rol]);})();
    if(identity?.key!==key){
      epoch++;
      await adoptarColaAntigua(key);
      localStorage.removeItem('pe_crm_snapshot');
      const previous=localStorage.getItem('fulltech.offline.legacy-owner');
      if(previous&&previous!==key){
        await db.put('legacyQueue:'+previous,{queue:localStorage.getItem('pe_crm_outbox'),problems:localStorage.getItem('pe_crm_outbox_problems')});
        localStorage.removeItem('pe_crm_outbox');localStorage.removeItem('pe_crm_outbox_problems');
      }
      const saved=await db.get('legacyQueue:'+key);
      if(saved&&!localStorage.getItem('pe_crm_outbox')){if(saved.queue)localStorage.setItem('pe_crm_outbox',saved.queue);if(saved.problems)localStorage.setItem('pe_crm_outbox_problems',saved.problems);}
      localStorage.setItem('fulltech.offline.legacy-owner',key);
    }
    identity={key,user:auth.user,role:auth.user?.role||'ADMIN',permissions:auth.permissions||[],verifiedAt:Date.now()};
    await db.put('identity',identity).catch(()=>signal());
    // Primero se respalda y después se clasifican los rechazos antiguos.
    await isolateHistorical().catch(()=>{});
    navigator.serviceWorker?.controller?.postMessage({type:'FULLTECH_OFFLINE_IDENTITY'});
    signal();
    }catch{storageAvailable=false;identity=null;await db.remove('identity').catch(()=>{});signal();}
  }
  async function forget(){
    await localTail.catch(()=>{});
    epoch++;
    try{if(identity)await db.put('legacyQueue:'+identity.key,{queue:localStorage.getItem('pe_crm_outbox'),problems:localStorage.getItem('pe_crm_outbox_problems')}).catch(()=>{});}catch{}
    identity=null;await db.remove('identity').catch(()=>{});
    try{for(const key of ['pe_crm_snapshot','pe_crm_outbox','pe_crm_outbox_problems','fulltech.offline.legacy-owner'])localStorage.removeItem(key);}catch{}
    signal();
  }
  /*
   * BORRAR LA COPIA Y VOLVER A PEDIRLO TODO.
   *
   * Los aparatos con el panel instalado guardan cada respuesta privada para
   * trabajar sin conexión. Si esa copia se queda atrás (o alguien cambia de
   * cuenta), el panel puede seguir enseñando clientes o productos que ya no son
   * los del servidor. Esto tira SOLO esas respuestas guardadas: no toca la
   * sesión, ni las operaciones pendientes de subir, ni la cola.
   */
  async function clearCache(){
    if(!storageAvailable||!owner())return 0;
    const prefixes=['response:'+owner()+':','local-response:'+owner()+':'];
    let removed=0;
    try{
      for(const [key] of await db.entries()){
        if(typeof key==='string'&&prefixes.some(prefix=>key.startsWith(prefix))){await db.remove(key);removed++;}
      }
    }catch{}
    return removed;
  }
  async function remember(url,response,remote=false){
    if(!valid()||!response.ok)return;
    const mine=owner(),copy=response.clone(),body=await copy.arrayBuffer();
    if(mine!==owner())return;
    const headers=[...copy.headers].filter(([name])=>!['set-cookie','content-length','content-encoding'].includes(name));
    const record={owner:mine,url:new URL(url,location.href).href,at:Date.now(),status:copy.status,headers,body};
    if(remote){await db.putRemote(responseKey(url),{...record,source:'remote'},queueKey());await db.remove('local-response:'+mine+':'+record.url);}
    else await db.put('local-response:'+mine+':'+record.url,{...record,source:'local'});
  }
  async function cached(url){
    if(!valid())return null;
    // Permisos cambiados en otra pestaña: la copia privada anterior deja de servir.
    if(identity?.legacyCacheDisabled)return null;
    const requested=new URL(url,location.href);
    const localReceipt=/^\/api\/admin\/(?:pos\/(?:local|quotes)|orders)\/([^/]+)\/(receipt|pdf|receipt\.pdf)$/.exec(requested.pathname);
    if(localReceipt){
      const key='receiptDocument:'+owner()+':'+localReceipt[1];
      let document=await db.get(key);
      if(!document){const entry=(await listQueue()).find(q=>q.localId===localReceipt[1]&&q.local);if(entry)try{document=JSON.parse(entry.local.body).document;}catch{}}
      if(document&&await db.get('receiptPdfReady:'+owner()+':'+document.id)!==2)await saveReceipt(document);
    }
    const localKey='local-response:'+owner()+':'+new URL(url,location.href).href;
    let saved=await db.get(localKey),savedSource=saved?'local':'remote';
    if(!saved)saved=await db.get(responseKey(url));
    if(requested.pathname==='/api/admin/reports/sales'&&identity.role==='ADMIN'){
      const history=await db.get(responseKey('/api/admin/reports/sales?period=custom&from=1900-01-01&to=9999-12-31&offline=1'));
      if(history){
        const all=JSON.parse(new TextDecoder().decode(history.body)).report.sales;
        const pending=(await data('/api/admin/data',{})).items?.filter(i=>i.pending&&i.status==='entregado')||[];
        for(const item of pending){const order=JSON.parse(item.order_json);all.push({id:item.id,date:item.updated_at,customer_name:item.name,order_number:item.order_number,lines:order.items,product_revenue_cents:money(order.total-order.delivery_fee),delivery_revenue_cents:money(order.delivery_fee),total_collected_cents:money(order.total),product_cost_cents:order.items.reduce((n,l)=>n+Number(l.product_cost_snapshot_cents||0),0),gross_product_profit_cents:money(order.total-order.delivery_fee)-order.items.reduce((n,l)=>n+Number(l.product_cost_snapshot_cents||0),0),capsules:order.items.reduce((n,l)=>n+Number(l.totalCapsules||0),0),pending:true});}
        const {offlineReport}=await import('./offline-report.js');
        return json({ok:true,offline:true,report:offlineReport(all,requested.searchParams.get('period')||'hoy',Object.fromEntries(requested.searchParams))});
      }
    }
    if(!saved&&['/api/admin/locations','/api/admin/wa-templates'].includes(requested.pathname)){
      const records=await db.entries();const found=records.find(([key,v])=>(String(key).startsWith('local-response:'+owner()+':')||String(key).startsWith('response:'+owner()+':'))&&v?.owner===owner()&&v.url&&new URL(v.url).pathname===requested.pathname);saved=found?.[1];savedSource=String(found?.[0]||'').startsWith('local-response:')?'local':'remote';
    }
    if(!saved&&requested.pathname==='/api/admin/conversations'){
      const records=await db.entries(),source=records.find(([,v])=>v?.owner===owner()&&v.url&&new URL(v.url).pathname===requested.pathname)?.[1];
      if(source){
        const value=JSON.parse(new TextDecoder().decode(source.body)),q=(requested.searchParams.get('q')||'').toLocaleLowerCase();
        if(q)value.conversations=(value.conversations||[]).filter(c=>JSON.stringify(c).toLocaleLowerCase().includes(q));
        return json(value);
      }
    }
    if(!saved||saved.owner!==owner()){
      /*
       * LA COPIA DEL MISMO MÓDULO SIRVE AUNQUE CAMBIE LA CONSULTA.
       *
       * La descarga anticipada guarda URIs concretas (`?limit=5000`, un período,
       * sin filtros). Al buscar, filtrar o cambiar de día la consulta cambia y la
       * copia ya no aparecía: el panel decía «esta pantalla no está guardada»
       * justo al filtrar, aunque el módulo entero estuviera descargado. Esa es la
       * causa real de los errores intermitentes («no se pudo cargar el reporte /
       * el inventario»). Sin red se devuelve la copia MÁS RECIENTE de esa ruta,
       * con su fecha en `x-fulltech-offline-at` para poder decir de cuándo es.
       */
      const records=await db.entries();
      let newest=null,newestKey='';
      for(const [key,value] of records){
        if(!value||value.owner!==owner()||!value.url||!(String(key).startsWith('local-response:'+owner()+':')||String(key).startsWith('response:'+owner()+':')))continue;
        let path;try{path=new URL(value.url).pathname;}catch{continue;}
        if(path!==requested.pathname)continue;
        if(!newest||(value.at||0)>(newest.at||0)){newest=value;newestKey=String(key);}
      }
      if(!newest)return null;
      saved=newest;savedSource=newestKey.startsWith('local-response:')?'local':'remote';
    }
    if(!saved||saved.owner!==owner())return null;
    const at=saved.at?new Date(saved.at).toISOString():new Date().toISOString();
    if(savedSource==='remote'&&requested.pathname==='/api/admin/store/products'){
      try{
        const snapshot=JSON.parse(new TextDecoder().decode(saved.body));
        const queue=await listQueue();
        for(const op of queue){
          if(op.state!=='pending'||op.path!=='/api/admin/pos/checkout'||op.body?.mode!=='invoice')continue;
          for(const line of op.body.items||[]){const product=snapshot.products?.find(row=>row.id===line.variantId);if(product?.track_stock&&product.quantity!=null){product.quantity=Math.max(0,Number(product.quantity)-Number(line.quantity||0));product.pending=true;}}
        }
        saved={...saved,body:await new Response(JSON.stringify(snapshot)).arrayBuffer()};
      }catch{}
    }
    return new Response(saved.body,{status:saved.status,headers:[...saved.headers,['x-fulltech-offline','1'],['x-fulltech-offline-at',at]]});
  }
  async function data(path,fallback={}){const r=await cached(path);return r?await r.json():clone(fallback);}
  async function save(path,value){await remember(path,json(value));}
  /*
   * LA COLA NO DEJA DE EXISTIR A LAS 24 HORAS.
   *
   * Antes `listQueue()` devolvía [] en cuanto la autorización local caducaba. Los
   * cambios seguían guardados en el aparato, pero el panel no los veía ni los
   * enviaba: parecía que se habían perdido y no había forma de sacarlos sin
   * recargar estando en línea. Lo que caduca son las LECTURAS privadas de 24 h,
   * no el trabajo que la persona ya hizo y está esperando subir.
   */
  async function listQueue(){return owner()?(await db.get(queueKey())||[]):[];}
  const pendientesDeEnviar=async()=>(await listQueue()).filter(p=>p.state==='pending').length;
  async function changeQueue(fn){const list=await db.update(queueKey(),q=>fn(q||[]));signal();return list;}
  const money=n=>Math.round(Number(n||0)*100);
  async function saveCatalog(snapshot){
    await save('/api/admin/store/products',snapshot);
    const catalog=snapshot.products.filter(p=>p.active).map(p=>({...p,price:p.price_cents/100,currency:'DOP',available:p.active,capsule_quantity:p.capsules||0,general:!p.legacy}));
    await save('/api/admin/catalog',{ok:true,catalog});
    const all=await data('/api/admin/data',{});all.catalog=catalog;await save('/api/admin/data',all);
  }
  function localError(message,status=422){return json({ok:false,message},status);}
  /*
   * «No hay copia guardada y la red no respondió». Se dice QUÉ pasó y QUÉ hacer:
   * el mensaje viejo («Este contenido todavía no está descargado») dejaba al
   * usuario sin saber si era la app, el servidor o su conexión.
   * Lleva `error:'offline'` para que las pantallas puedan distinguirlo.
   */
  const SIN_COPIA='Esta pantalla todavía no está guardada en el dispositivo. Conéctate a internet y pulsa «Reintentar» para descargarla.';
  /* Venció la autorización de 24 h: NO es lo mismo que «no hay copia». */
  const SIN_VIGENCIA='El acceso sin conexión de 24 horas venció. Conéctate a internet, inicia sesión y pulsa «Preparar dispositivo» para renovarlo. Los cambios pendientes se conservan.';
  function sinConexion(message=SIN_COPIA){return json({ok:false,error:'offline',message},503);}
  /*
   * DESCARTES DE AVISOS CON FORMATO ANTIGUO.
   *
   * Una versión anterior guardaba la clave del descarte con el número dentro
   * (`wa-failed:2`). El servidor solo acepta `wa-failed` o
   * `scheduled-problem:<id>`, así que el lote entero se rechazaba con
   * `invalid_dismissals` y —peor— la operación quedaba atascada para siempre.
   * Aquí se traduce sin perder el significado: `wa-failed:2` significa «descarté
   * el aviso de fallos con valor 2».
   */
  function sanearDismissals(mapa){
    const salida={};const descartadas=[];
    for(const [clave,valor] of Object.entries(mapa&&typeof mapa==='object'?mapa:{})){
      const legado=/^wa-failed:(\d+)$/.exec(clave);
      if(legado){const numero=Number(legado[1]);if(!(salida['wa-failed']>=numero))salida['wa-failed']=numero;continue;}
      if(clave==='wa-failed'){salida[clave]=valor;continue;}
      if(/^scheduled-problem:[a-zA-Z0-9_-]{1,160}$/.test(clave)){salida[clave]=true;continue;}
      descartadas.push(clave);
    }
    return {limpio:salida,descartadas};
  }
  /** Cuerpo saneado de una operación de descartes (misma id, mismo significado). */
  function sanearCuerpo(body,path){
    if(!/\/notification-dismissals$/.test(String(path)))return body;
    if(!body||typeof body!=='object'||!body.dismissed||typeof body.dismissed!=='object')return body;
    return {...body,dismissed:sanearDismissals(body.dismissed).limpio};
  }
  /**
   * COPIA DE RECUPERACIÓN DE LA COLA — ANTES DE TOCAR NADA.
   *
   * La primera vez que esta versión ve una cola con trabajo guarda una copia
   * ÍNTEGRA en IndexedDB (`respaldo:<cuenta>`) y **nunca la sobrescribe**:
   * aunque la sincronización confirme operaciones y las quite de la cola, el
   * respaldo conserva lo que había ANTES. Se guarda además el último estado
   * (`respaldo-ultimo:<cuenta>`) para poder comparar. Esto no borra ni modifica
   * ninguna operación pendiente.
   */
  async function respaldarCola(){
    const mine=owner();
    const cola=await listQueue();
    if(!cola.length)return null;
    const firma=JSON.stringify(cola.map(q=>[q.id,q.state,q.at]));
    const original=await db.get('respaldo:'+mine);
    if(!original){
      await db.put('respaldo:'+mine,{at:Date.now(),version:1,motivo:'antes-de-la-primera-sincronizacion',firma,operaciones:cola.map(q=>({...q}))});
    }else{
      /*
       * LA COPIA ORIGINAL NO SE PIERDE, PERO NO SE QUEDA CORTA.
       *
       * Si más tarde aparecen operaciones que no estaban (por ejemplo la cola
       * antigua que se adopta al migrar la clave), se AÑADEN a la copia. Nunca
       * se quitan ni se modifican las que ya estaban: es un registro que solo
       * crece, para poder recuperar todo lo que hubo.
       */
      const conocidas=new Set((original.operaciones||[]).map(o=>o.id));
      const faltan=cola.filter(q=>!conocidas.has(q.id));
      if(faltan.length)await db.put('respaldo:'+mine,{...original,firma,actualizadoAt:Date.now(),operaciones:[...(original.operaciones||[]),...faltan.map(q=>({...q}))]});
    }
    const ultimo=await db.get('respaldo-ultimo:'+mine);
    if(ultimo?.firma!==firma)await db.put('respaldo-ultimo:'+mine,{at:Date.now(),version:1,firma,operaciones:cola.map(q=>({...q}))});
    return {original:await db.get('respaldo:'+mine),ultimo:await db.get('respaldo-ultimo:'+mine)};
  }
  /*
   * RECUPERACIÓN DE OPERACIONES RECHAZADAS.
   *
   * Una operación en «revisar» NO se reintenta sola (evita bucles infinitos).
   * Estas son las tres cosas que sí puede hacer una persona, sin perder nada:
   *   · Verificar en el servidor: pregunta si llegó y qué respondió. No reenvía.
   *   · Reintentar reparada: solo con una traducción validada del contenido.
   *   · Resolver manualmente: deja constancia con motivo y auditoría.
   */
  async function anotarReparacion(mine,registro){
    try{
      const previas=(await db.get('reparadas:'+mine))||[];
      await db.put('reparadas:'+mine,[{...registro,at:Date.now()},...previas].slice(0,50));
    }catch{/* el registro es útil, no imprescindible */}
  }
  async function verificarEnServidor(ids){
    const lista=(Array.isArray(ids)?ids:[]).filter(id=>typeof id==='string'&&id.length>=16).slice(0,50);
    if(!lista.length)return { estados: [] };
    const respuesta=await network('/api/admin/offline-operations/status',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ids:lista})});
    if(!respuesta.ok)throw new Error('El servidor no pudo consultar el estado de las operaciones.');
    const datos=await respuesta.json();
    for(const estado of datos.estados||[]){
      await changeQueue(q=>q.map(p=>p.id===estado.key?{...p,servidor:{...estado,at:Date.now()}}:p));
    }
    return datos;
  }
  async function reintentarReparada(id){
    const mine=owner();
    const cola=await listQueue();
    const entrada=cola.find(p=>p.id===id);
    if(!entrada)throw new Error('Esa operación ya no está en la cola.');
    if(entrada.state!=='review')throw new Error('Solo se reintentan operaciones que requieren revisión.');
    const cuerpo=sanearCuerpo(entrada.body,entrada.path);
    if(JSON.stringify(cuerpo)===JSON.stringify(entrada.body))throw new Error('Esta operación no tiene una reparación automática validada. Revísala a mano.');
    /*
     * EL IDENTIFICADOR NO SE INVENTA.
     *
     * Si el servidor ya contestó a esta operación, ese id queda registrado con la
     * huella de su cuerpo: reenviarlo con otro contenido devolvería 409
     * `operation_reused`. Por eso el reintento reparado usa un id DERIVADO,
     * determinista y visible (`<id>-r1`), y el id original se conserva en la
     * entrada y en el registro de reparaciones.
     */
    const idEnvio=/^[a-zA-Z0-9_-]{16,100}$/.test(entrada.id+'-r1')?entrada.id+'-r1':entrada.id;
    await anotarReparacion(mine,{accion:'reintento_reparado',idOriginal:entrada.id,idEnvio,path:entrada.path,motivo:entrada.error??null});
    await changeQueue(q=>q.map(p=>p.id===id?{...p,state:'pending',body:cuerpo,error:null,status:null,attempts:(p.attempts||0)+1,retry:{at:Date.now(),idOriginal:entrada.id,idEnvio,reparada:true}}:p));
    await synchronize().catch(()=>{});
    const despues=(await listQueue()).find(p=>p.id===id);
    return { quedó:despues?despues.state:'confirmada', idEnvio };
  }
  async function resolverOperacion(id,motivo){
    const mine=owner();
    const texto=String(motivo??'').trim();
    if(texto.length<4)throw new Error('Escribe el motivo de la resolución (mínimo 4 caracteres).');
    const entrada=(await listQueue()).find(p=>p.id===id);
    if(!entrada)throw new Error('Esa operación ya no está en la cola.');
    let auditado=false;
    const respuesta=await network('/api/admin/offline-operations/resolve',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id,motivo:texto,tipo:entrada.path})}).catch(()=>null);
    auditado=Boolean(respuesta?.ok);
    /*
     * SIN AUDITORÍA NO HAY RESOLUCIÓN. Si el servidor no confirma la anotación,
     * la operación sigue en revisión: no se borra ni se da por resuelta en local.
     */
    if(!auditado)throw new Error('El servidor no confirmó la resolución. La operación sigue en revisión.');
    await anotarReparacion(mine,{accion:'resuelta_manual',idOriginal:id,path:entrada.path,motivo:texto,auditado});
    await changeQueue(q=>q.map(p=>p.id===id?{...p,state:'resuelto',resuelto:{at:Date.now(),motivo:texto,auditado,error:p.error??null}}:p));
    return { auditado };
  }
  /**
   * HISTÓRICOS: RECHAZOS ANTIGUOS QUE SE QUEDAN PARA REVISIÓN.
   *
   * Se respalda ANTES de marcarlos. No se borra nada, no se reenvían solos y no
   * bloquean las operaciones nuevas. La marca `historical` es una clasificación
   * por evidencia local (estado review + 404/422), no una identificación de qué
   * operación era: eso se decide al revisarla.
   */
  async function isolateHistorical(){
    const mine=owner();
    const cola=await listQueue();
    const viejas=cola.filter(p=>p.state==='review'&&!p.projectionVersion&&!p.historical&&
      (p.status===404||p.status===422||/invalid_dismissals|not_found/i.test(String(p.error||''))));
    if(!viejas.length)return 0;
    if(typeof db.backupQueue==='function')await db.backupQueue(mine).catch(()=>{});
    await changeQueue(q=>q.map(p=>viejas.some(v=>v.id===p.id)?{...p,historical:true}:p));
    return viejas.length;
  }
  /** Exportación completa: original, últimas versiones y cola actual. */
  async function exportRecovery(){
    const mine=owner();
    const original=await db.get('respaldo:'+mine);
    let versiones=[];
    try{versiones=(await db.entries()).filter(([k])=>String(k).startsWith('respaldo-version:'+mine+':')).map(([,v])=>v).sort((a,b)=>(a.sequence||0)-(b.sequence||0));}catch{}
    let legacyPending=[];let legacyProblems=[];
    try{legacyPending=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');legacyProblems=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');}catch{}
    return {version:2,at:new Date().toISOString(),original:original??{version:0,operaciones:[]},ultima:await db.get('respaldo-ultimo:'+mine),versiones,operaciones:await listQueue(),legacyPending,legacyProblems};
  }
  /** Un rechazo del servidor se explica en castellano, no con su código. */
  function mensajeDeRechazo(result,status){
    const codigo=String(result?.error??'');
    const mapa={
      invalid_dismissals:'El servidor no aceptó el formato de los avisos descartados (venían de una versión anterior).',
      invalid_before:'La fecha de borrado no es válida.',
      forbidden:'Tu usuario no tiene permiso para este cambio.',
      unauthorized:'La sesión ya no es válida: vuelve a entrar.',
      invalid_payload:'Los datos del cambio no tienen el formato esperado.',
      invalid_operation:'El identificador del cambio no es válido (venía de una versión anterior).',
      operation_reused:'Ese cambio ya se envió con otros datos: no se repite solo.',
      offline_operation_uncertain:'El servidor no pudo confirmar si el cambio se aplicó. Se conserva para revisión.',
    };
    return mapa[codigo]||result?.message||`El servidor rechazó el cambio (HTTP ${status}).`;
  }
  async function saveReceipt(document){
    const {receiptPdfBytes}=await import('./receipt-pdf.js');
    const {id,number,customer,sale,kind,created_at,input={}}=document,quote=kind==='quote';
    const receipt={business:'FullTECH',document:quote?'Cotización':'Factura de compra',order_number:number,date:created_at,customer_name:customer.name,notes:input.notes||'',...(quote?{customer_phone:customer.phone_e164}:{phone_masked:String(customer.phone_e164||'').slice(0,5)+'••• ••'+String(customer.phone_e164||'').slice(-2)}),
      status_label:quote?'Cotización pendiente de sincronizar':kind==='order'?'Pedido pendiente':'Venta cobrada · pendiente de sincronizar',currency:'DOP',
      payment_method_label:kind==='invoice'?(input.paymentMethod==='TRANSFER'?'Transferencia':'Efectivo'):null,
      items:sale.items.map(i=>({label:i.name,quantity:i.quantity,unitPrice:i.unit_price_cents/100,subtotal:i.subtotal_cents/100,line_discount:i.discount_cents/100})),
      subtotal:sale.subtotal_cents/100,discount:sale.discount_cents/100,delivery_fee:sale.delivery_cents/100,total:sale.total_cents/100,
      thanks:'Gracias por su compra.',note:'Documento provisional pendiente de sincronizar. No es comprobante fiscal.'};
    const receiptUrl='/api/admin/pos/local/'+id+'/receipt',pdfUrl='/api/admin/pos/local/'+id+'/pdf';
    await remember(pdfUrl,new Response(receiptPdfBytes(receipt),{headers:{'content-type':'application/pdf','content-disposition':`inline; filename="${number}.pdf"`}}));
    const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const html=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(number)}</title><style>body{font:15px system-ui;margin:0;padding:12px;background:#e8edf3;color:#14243b}main,nav,p{max-width:900px;margin:12px auto}nav{display:flex;gap:8px;flex-wrap:wrap}a,button{font:inherit;padding:10px 12px;background:white;border:1px solid #ced7e2;border-radius:8px;color:#153c70;text-decoration:none;cursor:pointer}canvas{display:block;margin:12px 0;box-shadow:0 2px 12px #14243b18;background:white}[data-receipt-fallback]{padding:20px;background:white}table{width:100%}td{padding:8px} @media print{body{padding:0;background:white}nav,[data-receipt-status]{display:none}canvas{box-shadow:none;break-after:page;margin:0;width:100%}}</style><nav><a href="/admin/?v=pedidos">Volver al CRM</a><a href="${pdfUrl}" data-receipt-download hidden>Descargar PDF</a><button data-receipt-share>Compartir PDF</button><button data-receipt-print>Imprimir</button></nav><p data-receipt-status role="status">Abriendo PDF guardado…</p><main data-receipt-pages data-pdf="${pdfUrl}" data-filename="${escape(number)}.pdf"></main><main data-receipt-fallback><img src="/admin/fulltech-logo-transparent.png?v=1" alt="FullTECH" width="48" height="48"><h1>FullTECH</h1><h2>${escape(receipt.document)} · ${escape(number)}</h2><p>${escape(customer.name)}</p><table>${sale.items.map(i=>`<tr><td>${escape(i.name)}</td><td>${i.quantity}</td><td>RD$${(i.subtotal_cents/100).toFixed(2)}</td></tr>`).join('')}</table><p>Descuento: RD$${(sale.discount_cents/100).toFixed(2)} · Envío: RD$${(sale.delivery_cents/100).toFixed(2)}</p><h2>Total RD$${(sale.total_cents/100).toFixed(2)}</h2><p>${escape(receipt.note)}</p></main><script src="/admin/receipt-viewer.js" defer></script></html>`;
    await remember(receiptUrl,new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));
    if(quote){await remember('/api/admin/pos/quotes/'+id+'/receipt',new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));await remember('/api/admin/pos/quotes/'+id+'/pdf',new Response(receiptPdfBytes(receipt),{headers:{'content-type':'application/pdf'}}));}
    else{await remember('/api/admin/orders/'+id+'/receipt',new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));await remember('/api/admin/orders/'+id+'/receipt.pdf',new Response(receiptPdfBytes(receipt),{headers:{'content-type':'application/pdf'}}));}
    await db.put('receiptDocument:'+owner()+':'+id,document);await db.put('receiptPdfReady:'+owner()+':'+id,2);
    return {receiptUrl:'/admin/receipt-viewer.html?pdf='+encodeURIComponent(pdfUrl),pdfUrl};
  }
  async function consumeStock(lines){
    const snapshot=await data('/api/admin/store/products',{products:[]}),quantities=new Map();
    for(const line of lines||[])quantities.set(line.variantId,(quantities.get(line.variantId)||0)+Number(line.quantity));
    let capsules=0;
    for(const [id,quantity] of quantities){const p=snapshot.products.find(p=>p.id===id);if(!p)continue;if(p.legacy)capsules+=quantity*p.capsules;else if(p.track_stock&&Number(p.quantity)<quantity)return 'No hay existencias suficientes en la copia local.';}
    const legacy=snapshot.products.find(p=>p.legacy);
    if(capsules&&(!legacy?.stock_initialized||Number(legacy.base_quantity)<capsules))return 'Inicializa el inventario o revisa las cápsulas disponibles antes de facturar.';
    for(const [id,quantity] of quantities){const p=snapshot.products.find(p=>p.id===id);if(p?.track_stock&&!p.legacy&&p.quantity!=null)p.quantity-=quantity;}
    for(const p of snapshot.products.filter(p=>p.legacy))if(p.base_quantity!=null){p.base_quantity-=capsules;p.quantity=Math.floor(p.base_quantity/p.capsules);}
    await saveCatalog(snapshot);
    if(capsules){const inventory=await data('/api/admin/inventory',{});inventory.stock=legacy.base_quantity;inventory.pending=true;await save('/api/admin/inventory',inventory);const all=await data('/api/admin/data',{});all.inventory=inventory;await save('/api/admin/data',all);}
    return null;
  }
  function replace(value,mapping){
    if(typeof value==='string')return Object.entries(mapping).reduce((s,[a,b])=>s.replaceAll(a,b),value);
    if(Array.isArray(value))return value.map(v=>replace(v,mapping));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v,mapping)]));
    return value;
  }
  async function project(path,method,body,operation){
    const now=new Date().toISOString(), id=operation.localId;
    const paymentMatch=path.match(/^\/api\/admin\/orders\/([^/]+)\/payments$/);
    if(paymentMatch&&method==='POST'){
      const orderId=decodeURIComponent(paymentMatch[1]);
      const all=await data('/api/admin/data',{});
      const item=(all.items||[]).find(row=>row.id===orderId);
      const cached=await data('/api/admin/orders/'+orderId,{});
      let order=cached.order;
      if(!order&&item)try{order=JSON.parse(item.order_json||'null');}catch{}
      if(!order)return localError('El pedido no está descargado.');
      const amount=Number(body.amount);
      if(!Number.isFinite(amount)||amount<=0)return localError('Escribe un importe válido.');
      const pendingFinancial=[...(order.pendingFinancial||[]),{
        id,amount,method:String(body.method||''),idempotencyKey:body.idempotencyKey||null,
        created_at:now,state:'pending_sync',
      }];
      const projectedOrder={...order,pendingFinancial};
      if(item){item.order_json=JSON.stringify(projectedOrder);item.pending=true;item.updated_at=now;await save('/api/admin/data',all);}
      const result={...cached,ok:true,order:projectedOrder,pending:true,offline:true};
      await save('/api/admin/orders/'+orderId,result);
      return json(result);
    }
    if(path.startsWith('/api/admin/inventory/')){
      if(identity.role!=='ADMIN')return localError('Solo administración puede cambiar el inventario.',403);
      const value=await data('/api/admin/inventory',{}),inventory=value.inventory||value;
      /*
       * EL AJUSTE NO DEPENDE DE `inventory.product`.
       *
       * Antes, si la copia de `/api/admin/inventory` venía sin el bloque del
       * producto (una copia vieja o guardada antes de abrir Inventario), el
       * ajuste sin conexión se RECHAZABA con «Descarga primero el inventario» y
       * la operación se perdía: parecía que el CRM no dejaba cambiar el stock.
       * Ahora la fuente de la verdad local es el catálogo (el saldo de cápsulas
       * es el que se ve en pantalla) y `inventory.product` solo aporta el costo.
       */
      const snapshot=await data('/api/admin/store/products',{products:[],categories:[],movements:[]});
      const legacy=snapshot.products.find(p=>p.legacy)||null;
      const unitCost=Number(inventory.product?.current_unit_cost_cents??legacy?.cost_cents??0)||0;
      const action=path.split('/').pop(),quantity=Number(body.countedQuantity??body.quantity??0);
      const before=Number(inventory.stock??legacy?.base_quantity??0);
      if(!Number.isSafeInteger(quantity)||quantity<0)return localError('Escribe una cantidad entera válida.');
      const after=action==='count'?quantity:action==='cost'?before:before+(action==='adjust'&&body.direction==='out'?-quantity:quantity);
      if(after<0)return localError('No hay existencias suficientes.');
      if(action!=='cost'&&!legacy&&!inventory.product)return localError('No se puede guardar sin conexión: falta la copia del inventario. Actualiza cuando tengas red.',503);
      inventory.stock=after;inventory.initialized=true;inventory.pending=true;
      if(body.unitCost!==undefined&&body.unitCost!==''){
        const cost=money(body.unitCost);
        if(!Number.isSafeInteger(cost)||cost<0)return localError('Escribe un costo válido.');
        if(inventory.product)inventory.product.current_unit_cost_cents=cost;
      }
      const costCents=Number(inventory.product?.current_unit_cost_cents??unitCost)||0;
      inventory.inventory_value_cents=after*costCents;
      for(const p of snapshot.products.filter(p=>p.legacy)){p.base_quantity=after;p.quantity=Math.floor(after/p.capsules);p.stock_initialized=true;p.cost_cents=costCents*p.capsules;p.pending=true;}
      await saveCatalog(snapshot);await save('/api/admin/inventory',{...inventory,ok:true});
      const all=await data('/api/admin/data',{});all.inventory=inventory;await save('/api/admin/data',all);
      return json({ok:true,inventory,pending:true,offline:true});
    }
    if(path.startsWith('/api/admin/store/')){
      if(identity.role!=='ADMIN')return localError('Solo administración puede cambiar el catálogo o el stock.',403);
      const snapshot=await data('/api/admin/store/products',{ok:true,products:[],categories:[],movements:[],canManage:true});
      const parts=path.split('/'), target=parts[5], action=parts[6];
      if(parts[4]==='categories'){
        const category={id,name:body.name,image_url:body.image||null,created_at:now,pending:true};
        if(!String(category.name||'').trim())return localError('Escribe el nombre de la categoría.');
        snapshot.categories.push(category);await saveCatalog(snapshot);return json({ok:true,category,pending:true});
      }
      let product=snapshot.products.find(p=>p.id===target);
      if(action==='stock'){
        if(!product)return localError('Descarga primero el producto.');
        if(!Number.isSafeInteger(Number(body.quantity))||Number(body.quantity)<0)return localError('Escribe una cantidad entera válida.');
        const old=Number(product.quantity||0), amount=Number(body.quantity);
        const next=body.type==='count'?amount:body.type==='out'?old-amount:old+amount;
        if(next<0)return localError('No hay existencias suficientes en la copia local.');
        product.quantity=next;product.pending=true;product.version++;
        snapshot.movements.unshift({id,product_id:product.id,created_at:now,quantity_delta:next-old,balance_after:next,type:body.type,reason:body.reason,pending:true});
      }else{
        if(target&&!product)return localError('El artículo no está descargado.');
        if(!String(body.name||'').trim()||!String(body.sku||'').trim())return localError('Escribe nombre y código del artículo.');
        if(snapshot.products.some(p=>p.sku===String(body.sku).toUpperCase()&&p!==product))return localError('Ese código ya existe.');
        const category=snapshot.categories.find(c=>c.id===body.category_id);
        const next={...product,...body,id:product?.id||id,sku:String(body.sku).toUpperCase(),price_cents:money(body.price),cost_cents:money(body.cost),quantity:product?.quantity??Number(body.quantity||0),version:(product?.version||0)+1,track_stock:body.kind==='product',active:body.active!==false,category:category?.name||body.category||'',image_url:body.image||product?.image_url||null,pending:true};
        if(!Number.isFinite(next.price_cents)||next.price_cents<0||next.cost_cents<0)return localError('Escribe precios válidos.');
        if(product)Object.assign(product,next);else{product=next;snapshot.products.push(product);}
      }
      await saveCatalog(snapshot);return json({ok:true,product,...snapshot,pending:true});
    }
    if(path.startsWith('/api/admin/pos/')){
      const people=await data('/api/admin/pos/customers',{customers:[],canCreate:false});
      if(!people.canCreate)return localError('Tu cuenta no puede crear ventas.',403);
      if(path.endsWith('/customers')){
        const digits=String(body.phone||'').replace(/\D/g,'');if(digits.length<10||digits.length>15)return localError('Escribe un teléfono válido con código de país.');
        const existing=people.customers.find(c=>String(c.phone_e164).replace(/\D/g,'').endsWith(digits));
        const customer=existing||{id,name:body.name||digits,phone_e164:'+'+digits,pending:true};
        if(!existing)people.customers.push(customer);
        await save('/api/admin/pos/customers',people);await save('/api/admin/pos/context/'+customer.id,{ok:true,openOrders:[]});
        const all=await data('/api/admin/data',{});all.customers||=[];if(!all.customers.some(c=>c.id===customer.id))all.customers.push(customer);await save('/api/admin/data',all);
        return json({ok:true,customer,pending:true});
      }
      if(path.includes('/tickets')){
        const list=await data('/api/admin/pos/tickets',{ok:true,tickets:[]});
        const target=path.split('/')[5], old=list.tickets.find(t=>t.id===target);
        if(target&&!old)return localError('El ticket no está descargado.');
        const ticket={...old,id:old?.id||id,name:body.name||old?.name||'Ticket local',actor_id:identity.user?.id||'LEGACY_PANEL',draft:clone(body.draft||old?.draft||{}),version:(old?.version||0)+1,status:path.endsWith('/discard')?'discarded':'open',created_at:old?.created_at||now,updated_at:now,pending:true};
        if(body.quoteId){const quote=(await data('/api/admin/pos/quotes/'+body.quoteId)).document;if(!quote)return localError('La cotización no está descargada.');ticket.draft={...quote.input,customer:quote.customer,quoteId:quote.id};}
        if(old)Object.assign(old,ticket);else list.tickets.push(ticket);
        await save('/api/admin/pos/tickets',list);await save('/api/admin/pos/tickets/'+ticket.id,{ok:true,ticket});return json({ok:true,ticket,pending:true});
      }
      const snapshot=await data('/api/admin/store/products',{products:[]});
      const {calculateSale}=await import('./pos-math.js');let sale;
      try{sale=calculateSale(body.items,snapshot.products,body.discount,body.deliveryFee);}catch(e){return localError(e.message);}
      const customer=people.customers.find(c=>c.id===body.customerId);if(!customer)return localError('Selecciona un cliente descargado.');
      if(body.expectedTotal!==sale.total_cents)return localError('Revisa el total de la venta.');
      const mode=body.mode||'quote',number=(mode==='quote'?'COT':'LOCAL')+'-'+id.slice(-8).toUpperCase();
      const document={id,kind:mode,number,customer,customer_id:customer.id,created_at:now,status:'pending_sync',sale,input:body,pending:true};
      if(mode==='quote'){
        const list=await data('/api/admin/pos/quotes',{ok:true,quotes:[]});list.quotes.unshift(document);await save('/api/admin/pos/quotes',list);await save('/api/admin/pos/quotes/'+id,{ok:true,document});
      }else{
        for(const line of body.items){const p=snapshot.products.find(p=>p.id===line.variantId);if(mode==='invoice'&&p?.track_stock&&p.quantity!=null&&p.quantity<line.quantity)return localError('No hay stock suficiente en la copia local.');}
        const capsules=body.items.reduce((n,line)=>n+(snapshot.products.find(p=>p.id===line.variantId)?.legacy?Number(snapshot.products.find(p=>p.id===line.variantId).capsules)*line.quantity:0),0);
        const legacy=snapshot.products.find(p=>p.legacy);
        if(mode==='invoice'&&legacy?.stock_initialized&&legacy?.base_quantity!=null&&capsules>legacy.base_quantity)return localError('No hay cápsulas suficientes en la copia local.');
        if(mode==='invoice'){const error=await consumeStock(body.items);if(error)return localError(error);}
        const all=await data('/api/admin/data',{});
        const lines=sale.items.map(i=>({...i,label:i.name,variantName:i.name,unitPrice:i.unit_price_cents/100,subtotal:i.subtotal_cents/100,subtotal_snapshot_cents:i.subtotal_cents,product_cost_snapshot_cents:i.cost_cents||0}));
        const order={id,order_number:number,items:lines,customer_id:customer.id,conversation_id:body.conversationId||null,subtotal:sale.subtotal_cents/100,discount:sale.discount_cents/100,delivery_fee:sale.delivery_cents/100,total:sale.total_cents/100,status:mode==='invoice'?'entregado':'nuevo',payment_method:body.paymentMethod,currency:'DOP',created_at:now,...(mode==='invoice'?{delivered_at:now}:{}),pending:true};
        const item={id,order_number:number,customer_id:customer.id,name:customer.name,phone:customer.phone_e164,type:'order_intent',status:order.status,order_json:JSON.stringify(order),total:sale.total_cents/100,received_at:now,updated_at:now,offline:true,pending:true};
        (all.items||=[]).unshift(item);await save('/api/admin/data',all);
        await save('/api/admin/orders/'+id,{ok:true,item,order,customer,receipt:order});
      }
      const {receiptUrl,pdfUrl}=await saveReceipt(document);
      if(body.ticketId){const list=await data('/api/admin/pos/tickets',{tickets:[]});const t=list.tickets.find(t=>t.id===body.ticketId);if(t){t.status='completed';t.result={receiptUrl,pdfUrl,number,orderId:mode!=='quote'?id:null,quoteId:mode==='quote'?id:null};await save('/api/admin/pos/tickets/'+t.id,{ok:true,ticket:t});}await save('/api/admin/pos/tickets',{ok:true,...list});}
      return json({ok:true,offline:true,pending:true,document,quoteId:mode==='quote'?id:null,orderId:mode!=='quote'?id:null,number,receiptUrl,pdfUrl,total_cents:sale.total_cents});
    }
    if(/\/orders\/[^/]+\/delivery\/start$/.test(path)||path.startsWith('/api/admin/delivery-tracking/')){
      const all=await data('/api/admin/data',{}),tracking=await data('/api/admin/delivery-tracking',{ok:true,sessions:[]});
      const starting=path.endsWith('/delivery/start'),target=path.split('/')[4];
      let session=starting?tracking.sessions.find(s=>s.order_id===target&&s.status==='ACTIVE'):tracking.sessions.find(s=>s.id===target);
      let item=(all.items||[]).find(i=>i.id===(starting?target:session?.order_id)),order;
      try{order=JSON.parse(item?.order_json||'null');}catch{}
      if(!item||!order)return localError('Descarga primero el pedido y su ruta.');
      if(starting){
        if(['entregado','cancelado','perdido'].includes(order.status))return localError('Este pedido ya está cerrado.');
        if(!order.delivery?.location)return localError('El pedido no tiene ubicación de entrega.');
        const userId=body.deliveryUserId||body.delivery_user_id||identity.user?.id;
        if(!userId)return localError('Selecciona un repartidor.');
        if(identity.role!=='ADMIN'&&order.delivery.delivery_user_id!==userId)return localError('Este pedido está asignado a otro repartidor.',403);
        if(!session){session={id,order_id:target,delivery_user_id:userId,delivery_user_name:identity.user?.display_name,status:'ACTIVE',started_at:now,last_position:null,destination:order.delivery.location};tracking.sessions.unshift(session);}
        item.status=order.status='enviado';
      }else{
        if(!session)return localError('Descarga primero la entrega.');
        if(identity.role!=='ADMIN'&&session.delivery_user_id!==identity.user?.id)return localError('No puedes cambiar esta entrega.',403);
        if(path.endsWith('/location')){
          if(!Number.isFinite(Number(body.lat))||!Number.isFinite(Number(body.lng))||Math.abs(body.lat)>90||Math.abs(body.lng)>180)return localError('La ubicación no es válida.');
          session.last_position={latitude:Number(body.lat),longitude:Number(body.lng),accuracy:body.accuracy,heading:body.heading,speed:body.speed,recorded_at:new Date(body.timestamp||Date.now()).toISOString(),stale:false};
        }else if(path.endsWith('/stop')||path.endsWith('/complete')){
          session.status=path.endsWith('/complete')?'COMPLETED':'CANCELLED';session.ended_at=now;
          if(session.status==='COMPLETED'&&order.status!=='entregado'){const error=await consumeStock(order.items);if(error)return localError(error);item.status=order.status='entregado';}
        }else return localError('Esta operación de reparto requiere conexión.',503);
      }
      session.pending=true;session.updated_at=now;item.pending=true;item.order_json=JSON.stringify(order);
      all.deliveryTracking=tracking.sessions;await save('/api/admin/data',all);await save('/api/admin/delivery-tracking',tracking);
      await save('/api/admin/orders/'+item.id,{...(await data('/api/admin/orders/'+item.id,{})),ok:true,item,order});
      return json({ok:true,session,order,offline:true,pending:true});
    }
    // Los módulos existentes siguen usando sus proyecciones de dominio (guardar/aplicar).
    const parts=path.split('/').filter(Boolean),resource=parts[2],target=parts[3];
    if(['settings','messages','users'].includes(resource)&&identity.role!=='ADMIN'&&!(resource==='users'&&target==='me'))return localError('Tu cuenta no tiene permiso para esta acción.',403);
    const all=await data('/api/admin/data',{});
    const plural=({orders:'items',items:'items',customers:'customers',conversations:'conversations',followups:'followups',notifications:'notifications',scheduled:'scheduled',locations:'locations',messages:'messages',users:'users'})[resource];
    const resourceCopy=await data('/api/admin/'+resource,{});
    const list=Array.isArray(all[plural])?all[plural]:Array.isArray(all[plural]?.items)?all[plural].items:Array.isArray(resourceCopy[plural])?resourceCopy[plural]:[];
    let row=list.find(r=>r.id===(target||body.id))||{id:target||body.id||id,created_at:now};
    const delta={...body,pending:true};
    if(resource==='customers'&&path.endsWith('/stage'))delta.customer_stage=body.stage;
    if(resource==='users'&&body.displayName)delta.display_name=body.displayName;
    if(resource==='conversations'&&/\/(archive|unarchive)$/.test(path))delta.archived=path.endsWith('/archive');
    if(resource==='orders'&&path.endsWith('/finish'))delta.status='entregado';
    if(resource==='orders'&&path.endsWith('/cancel'))delta.status='cancelado';
    if(row.order_json&&delta.status){
      const order=JSON.parse(row.order_json);
      if(delta.status==='entregado'&&order.status!=='entregado'){const error=await consumeStock(order.items);if(error)return localError(error);order.delivered_at=now;}
      order.status=delta.status;row.order_json=JSON.stringify(order);row.updated_at=now;
    }
    if(row.order_json&&body.status){try{const order=JSON.parse(row.order_json);order.status=body.status;row.order_json=JSON.stringify(order);}catch{}}
    if(method==='DELETE'){const i=list.indexOf(row);if(i>=0)list.splice(i,1);}else{Object.assign(row,delta);if(!list.includes(row))list.push(row);}
    if(plural){if(!all[plural])all[plural]=list;await save('/api/admin/data',all);}
    const base='/api/admin/'+resource;
    const cachedList=await data(base,{});
    if(Array.isArray(cachedList[resource]))cachedList[resource]=list;
    await save(base,cachedList);
    const current=await data(path,target?await data('/api/admin/'+resource+'/'+target,{}):{}),result={...current,...delta,ok:true,offline:true,pending:true,item:row,order:row,customer:row,followup:row,tracking:row,user:row,users:list};
    if(resource==='messages')result.messages=list;
    if(resource==='settings'){result.settings={...(current.settings||{}),...body};await save(path,result);}
    if(path==='/api/admin/settings/deepseek'){result.deepseek={...(current.deepseek||{}),...body,pending:true};await save(path,result);}
    if(path==='/api/admin/settings/chat-sharing'){const previous=await data('/api/admin/chat-sharing',{});result.sharing={...(previous.sharing||{}),...body,pending:true};await save('/api/admin/chat-sharing',result);}
    if(target)await save('/api/admin/'+resource+'/'+target,{...result});
    return json(result);
  }
  function enqueue(url,options){
    const mine=owner();
    const run=()=>{if(mine!==owner())throw new Error('La cuenta cambió antes de guardar.');return enqueueRun(url,options);};
    const next=localTail.catch(()=>{}).then(()=>navigator.locks?.request?navigator.locks.request('fulltech-offline-write:'+mine,run):run());
    localTail=next;return next;
  }
  async function enqueueRun(url,options){
    /*
     * SE ENCOLA CON LA CUENTA IDENTIFICADA, AUNQUE LA COPIA HAYA CADUCADO.
     *
     * Lo que caduca a las 24 h son las lecturas privadas, no el cambio que la
     * persona acaba de hacer. Antes se rechazaba con «conéctate para renovar» y
     * el trabajo se quedaba sin guardar en ningún sitio.
     */
    const mine=owner();
    if(!mine)return localError('Conéctate para renovar el acceso sin conexión de 24 horas.',401);
    if(protectedWrite(url))return localError('Esta acción requiere conexión con el servicio.',503);
    let body=options.body?JSON.parse(options.body):{};
    if(url.pathname.startsWith('/api/admin/store/products')&&(body.images!==undefined||url.pathname.endsWith('/publication')))return localError('Los cambios de galería y publicación necesitan conexión. Conserva el formulario y vuelve a guardar cuando haya servicio.',503);
    if(/password|apiKey|accessToken|secret/i.test(JSON.stringify(Object.keys(body))))return localError('Las contraseñas y claves se cambian con conexión segura al servidor.',503);
    const paymentPath=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/payments$/);
    if(paymentPath&&options.method==='POST'){
      const response=await cached('/api/admin/orders/'+decodeURIComponent(paymentPath[1]));
      const current=response?await response.json():null;
      const order=current?.order;
      if(!order)return localError('Descarga el pedido antes de guardar el cobro.',503);
      const payment=order.payment||{};
      const total=Number(payment.total??order.total??0);
      const received=Number(payment.received_total??0);
      const baseDue=Number.isFinite(Number(payment.due))?Number(payment.due):Math.max(0,total-received);
      const reserved=(order.pendingFinancial||[]).reduce((sum,entry)=>sum+Math.max(0,Number(entry.amount)||0),0);
      const due=Math.max(0,baseDue-reserved);
      body={...body,expectedDue:due};
    }
    const pending=await listQueue();
    const same=pending.find(p=>p.path===url.pathname+url.search&&p.method===options.method&&JSON.stringify(p.body)===JSON.stringify(body)&&p.state==='pending');
    if(same)return new Response(same.local.body,{status:same.local.status,headers:same.local.headers});
    const prefix=url.pathname.includes('/store/categories')?'category_':url.pathname.includes('/store/products')?'product_':url.pathname.includes('/tickets')?'ticket_':url.pathname.includes('/quotes')?'pos_':'local_';
    const operation={id:options.operationId||uuid(),path:url.pathname+url.search,method:options.method,body,localId:prefix+uuid().replaceAll('-',''),at:Date.now(),state:'pending'};
    // El diario se escribe ANTES de aplicar cambios o decir que están guardados.
    await changeQueue(q=>[...q,{...operation,state:'preparing'}]);
    try{
      const response=await project(url.pathname,options.method,body,operation);
      if(!response.ok){await changeQueue(q=>q.filter(p=>p.id!==operation.id));return response;}
      const text=await response.clone().text();
      await changeQueue(q=>q.map(p=>p.id===operation.id?{...operation,local:{body:text,status:response.status,headers:[...response.headers]}}:p));
      const snapshot=await db.projectionSnapshot?.(mine);
      if(snapshot){
        const records=snapshot.records.map(([href,record])=>[
          href,/\/api\/admin\/pos\/local\//.test(new URL(href).pathname)?{...record,source:'local'}:record,
        ]);
        await db.commitProjection?.(mine,{...snapshot,records,queueSignature:JSON.stringify(await listQueue())});
      }
      // Cada operación nueva también queda en la copia de recuperación.
      await respaldarCola().catch(()=>{});
      // Cada operación nueva se intenta enviar de inmediato (sin esperar a que
      // nadie pulse «Sincronizar»).
      if(navigator.onLine){if(window.FullTECHSync)window.FullTECHSync.ahora();else setTimeout(()=>synchronize().catch(()=>{}),0);}
      return response;
    }catch(e){await changeQueue(q=>q.map(p=>p.id===operation.id?{...p,state:'review',error:e.message}:p));throw e;}
  }
  async function send(input,options={}){
    const url=new URL(typeof input==='string'?input:input.url,location.href),method=(options.method||input.method||'GET').toUpperCase();
    // Validar la sesión online no necesita abrir IndexedDB. Responde al panel
    // enseguida y conserva la identidad/caché local en segundo plano.
    if(method==='GET'&&url.pathname==='/api/admin/session'&&navigator.onLine){
      const response=await network(input,{...options,cache:'no-store'}),copy=response.clone();
      void ready.then(async()=>{
        if(response.status===401){await forget();return;}
        if(response.ok){await identify(await copy.clone().json().catch(()=>({})));await remember(url,copy,true).catch(()=>signal());}
      }).catch(()=>{});
      return response;
    }
    await ready;
    /*
     * LOS PERMISOS PUEDEN CAMBIAR EN OTRA PESTAÑA.
     * Si la identidad guardada ya no coincide con la de memoria (o quedó marcada
     * como no apta para caché), se deja de servir la copia privada anterior.
     */
    try{
      const persistida=await db.get('identity');
      if(persistida&&identity){
        const cambiados=JSON.stringify(persistida.permissions||[])!==JSON.stringify(identity.permissions||[]);
        if(cambiados||persistida.legacyCacheDisabled)identity={...identity,permissions:persistida.permissions||[],legacyCacheDisabled:true};
      }
    }catch{}
    if(valid()&&options.method&&options.method!=='GET'){
      const mapping=await db.get('mapping:'+owner())||{};
      if(typeof input==='string')input=replace(input,mapping);
      if(typeof options.body==='string'){try{options={...options,body:JSON.stringify(replace(JSON.parse(options.body),mapping))};}catch{}}
    }
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/admin/')||url.pathname.includes('/events'))return network(input,options);
    const mine=owner(),myEpoch=epoch;
    const canRead=(!excluded(url)||/\/conversations\/[^/]+\/messages$/.test(url.pathname))&&!url.pathname.includes('/android-apk/download');
    let legacy=new Headers(options.headers||{}).has('x-fulltech-legacy-outbox');
    if(legacy&&(await listQueue()).some(p=>(url.pathname+String(options.body||'')).includes(p.localId)))legacy=false;
    if(method!=='GET'&&!legacy&&!protectedWrite(url)&&valid()){
      /*
       * SOLO SE ENCOLA CUANDO LA OPERACIÓN DEPENDE DE UN ID LOCAL AÚN NO CONFIRMADO.
       * Las escrituras independientes van DIRECTO al servidor con su clave de
       * idempotencia: así una cola llena de rechazos antiguos no impide trabajar
       * y la nube manda. Si la red falla, el catch de abajo la encola.
       */
      const pendientes=(await listQueue()).filter(p=>p.state==='pending'&&p.localId);
      if(pendientes.length){
        const texto=url.pathname+String(options.body||'');
        if(pendientes.some(p=>texto.includes(p.localId)))return enqueue(url,{...options,method});
      }
    }
    /*
     * LA RED SE INTENTA SIEMPRE, TAMBIÉN CON `navigator.onLine=false`.
     *
     * «navigator.onLine» se equivoca (wifi cautivo, VPN, arranque en frío). Si el
     * servidor está accesible, se usa; si no, el catch encola o devuelve la copia.
     * Lo único que no se intenta sin red es la cola heredada del navegador antiguo.
     */
    /*
     * NINGÚN AVISO DEL NAVEGADOR IMPIDE INTENTARLO.
     *
     * Antes, si la cola heredada llevaba el marcador y `navigator.onLine` decía
     * «no hay red», ni siquiera se probaba: el cambio quedaba en el aparato y el
     * reintento automático volvía a caer en la misma comprobación una y otra vez.
     * `navigator.onLine` se equivoca (VPN, wifi cautivo, app reanudada en segundo
     * plano). Quien decide es el servidor: si no responde, el catch encola.
     */
    // Lo que el servidor no puede ejecutar desde la cola (mensajes, llamadas, claves)
    // falla en el acto sin red, en vez de intentar una petición imposible.
    if(method!=='GET'&&protectedWrite(url)&&!navigator.onLine)return localError('Esta acción requiere conexión con el servicio.',503);
    const operationId=method!=='GET'&&!protectedWrite(url)?new Headers(options.headers||{}).get('x-fulltech-operation')||uuid():null;
    const efimeroEscribir=method!=='GET'&&efimero(url);
    /*
     * Si el aparato DICE que no hay red se espera mucho menos antes de tirar de
     * la copia (2,5 s en vez de 6). Así el panel no se queda colgado en cada
     * petición y el inventario o el catálogo no se caen por tiempo de espera.
     *
     * LECTURAS PESADAS (supervisor, reportes, métricas, datos): el servidor tiene
     * que recorrer todo el histórico. Con 6 s se cortaban en falso, y el panel
     * decía «no está descargado» aunque hubiera conexión. Tienen su propio tope.
     */
    const LECTURA_LENTA=/^\/api\/admin\/(data|delivery-supervisor|reports\/sales|metrics)(\/|$)/;
    /*
     * UNA ESCRITURA NO SE CORTA A LOS 6 SEGUNDOS.
     *
     * Si el servidor tardaba un poco más, el intento se abortaba y el cambio se
     * iba a la cola aunque el servidor lo estuviera guardando: trabajo que había
     * que reenviar por nada y que, con la cola bloqueada, se quedaba esperando a
     * que alguien pulsara «Sincronizar». Las escrituras tienen un margen amplio:
     * esperar es mejor que encolar algo que ya llegó.
     */
    const limite=method!=='GET'?20000:(navigator.onLine?(LECTURA_LENTA.test(url.pathname)?20000:6000):2500);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),limite);
    const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const headers=new Headers(options.headers||{});if(operationId)headers.set('x-fulltech-operation',operationId);
      const response=await network(input,{...options,headers,signal:controller.signal});
      if(response.status===409&&operationId){
        const failure=await response.clone().json().catch(()=>({}));
        if(failure.error==='offline_operation_uncertain')await changeQueue(q=>[...q,{id:operationId,path:url.pathname+url.search,method,body:options.body?JSON.parse(options.body):{},localId:'uncertain_'+operationId,state:'review',at:Date.now(),error:failure.message}]);
      }
      /*
       * UN 401 DEL SERVIDOR CIERRA LA SESIÓN; UNO LOCAL, NO.
       *
       * La cola contesta 401 cuando la autorización de 24 h venció («conéctate
       * para renovar»). Eso NO es que el servidor haya rechazado la cuenta: si se
       * trataba igual, se borraba la identidad local —y con ella el acceso a la
       * copia y la cola— por un cambio guardado. Esa era la causa de que expirar
       * se viera como «pantalla no guardada» y de que el acceso se perdiera solo.
       */
      if(response.status===401){
        /*
         * NO CUALQUIER 401 CIERRA LA SESIÓN.
         *
         * Un 401 de un módulo (por ejemplo el sondeo de llamadas, o una ruta de
         * administración para un usuario que no la tiene) NO significa que la
         * cuenta haya caducado. Tratarlo así borraba la identidad local —y con
         * ella la copia y la cola— por una petición de fondo. Solo se cierra con
         * los endpoints que de verdad identifican la sesión.
         */
        if(response.headers.get('x-fulltech-local')==='1')return response;
        if(!/^\/api\/admin\/(session|auth\/me|data|login|logout)(\/|$)/.test(url.pathname)){
          recordDiag({path:url.pathname,cause:'http',status:401});
          return response;
        }
        await forget();
        return response;
      }
      if([502,503,504].includes(response.status)&&canRead){
        if(method==='GET'){
          const r=await cached(url);
          if(r){const at=r.headers.get('x-fulltech-offline-at');recordDiag({path:url.pathname,cause:'http',status:response.status,copy:true});servedLocal(url,at);return r;}
          recordDiag({path:url.pathname,cause:'http',status:response.status,copy:false});
          /* Venció la autorización de 24 h: se dice ESO, no «no hay copia». */
          if(identity&&!valid())return sinConexion(SIN_VIGENCIA);
          // Sin copia guardada: el 503 del service worker no se enseña en crudo.
          const body=await response.clone().json().catch(()=>({}));
          if(body?.error==='offline'||!body?.message)return sinConexion();
        }
        else if(!legacy&&!efimeroEscribir)return enqueue(url,{...options,method,operationId});
        // Una marca de leído que el servidor no atiende no se guarda: se da por vista.
        else if(efimeroEscribir)return json({ok:true,offline:true,omitted:true});
      }
      const localResponse=response.headers.get('x-fulltech-offline')==='1';
      if(response.ok&&!localResponse&&method==='GET'&&/\/(data|session|auth\/me)$/.test(url.pathname)){
        await identify(await response.clone().json());
      }else if(response.ok&&/\/(login)$/.test(url.pathname))await identify(await response.clone().json());
      if(myEpoch!==epoch&&mine&&mine!==owner())return response;
      if(method==='GET'&&canRead&&response.ok&&!localResponse){await remember(url,response,true).catch(()=>signal());}
      if(response.ok&&identity&&!warming&&url.pathname==='/api/admin/data')setTimeout(()=>warm().catch(()=>{}),100);
      return response;
    }catch(e){
      if(options.signal?.aborted)throw e;
      if(method==='GET'&&canRead){
        const r=await cached(url);
        if(r){const at=r.headers.get('x-fulltech-offline-at');recordDiag({path:url.pathname,cause:e?.name==='AbortError'?'timeout':'network',copy:true});servedLocal(url,at);return r;}
        recordDiag({path:url.pathname,cause:e?.name==='AbortError'?'timeout':'network',copy:false});
        if(identity&&!valid())return sinConexion(SIN_VIGENCIA);
        // Se distingue «tardó demasiado» de «no hay red»: no es lo mismo.
        return sinConexion(e?.name==='AbortError'
          ? 'El servidor tardó demasiado en responder y esta pantalla todavía no está guardada. Comprueba la conexión y pulsa «Reintentar».'
          : SIN_COPIA);
      }
      if(efimeroEscribir)return json({ok:true,offline:true,omitted:true});
      if(method!=='GET'&&!protectedWrite(url)&&!legacy)return enqueue(url,{...options,method,operationId});
      throw e;
    }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',onAbort);}
  }
  /**
   * LA SESIÓN CADUCÓ: SE PIDE VOLVER A ENTRAR, PERO NO SE BORRA NADA.
   *
   * Antes, un 401 llamaba a `forget()`, que borra la identidad y la cola heredada:
   * las operaciones pendientes quedaban sin dueño y ya no se podían enviar. Un
   * aviso de «vuelve a entrar» no puede costar el trabajo de nadie. La identidad
   * se marca como caducada (deja de servir la copia privada) y la cola se
   * conserva bajo la misma clave: al entrar de nuevo se reanuda sola.
   */
  async function marcarReautenticacion(){
    if(!identity)return;
    identity={...identity,verifiedAt:0};
    await db.put('identity',identity).catch(()=>{});
    recordDiag({path:'/offline/sesion',cause:'http',status:401});
    signal();
  }
  async function synchronize(){
    if(syncing)return syncing;
    /*
     * SE INTENTA CON LA CUENTA IDENTIFICADA, NO CON LA CUENTA «VIGENTE».
     *
     * `valid()` solo dice si la copia privada de 24 h se puede leer. Usarlo aquí
     * significaba: cuenta con más de 24 h → la cola no se envía nunca sola.
     */
    if(!storageAvailable||!owner())return {sent:0,pending:0};
    const run=async()=>{
      const mine=owner(),mapping=await db.get('mapping:'+mine)||{};
      /*
       * 1) LA SESIÓN SE COMPRUEBA DE VERDAD ANTES DE ENVIAR NADA.
       *
       * Si el servidor ya no reconoce la sesión, la cola no se toca y la copia
       * privada deja de servir: no se manda trabajo con una cuenta caducada.
       */
      const sesion=await network('/api/admin/session',{credentials:'same-origin',cache:'no-store'}).catch(()=>null);
      if(sesion && (sesion.status===401 || (await sesion.clone().json().catch(()=>({})))?.ok===false)){
        await marcarReautenticacion();
        return {sent:0,pending:await pendientesDeEnviar(),error:'La sesión caducó: vuelve a entrar para enviarlo.',session:false};
      }
      /*
       * 2) RESPALDO ANTES DE ENVIAR, PERO SIN BLOQUEAR.
       *
       * El respaldo protege la cola, no la sustituye: si falla (cuota, disco), se
       * anota y se sigue enviando. Antes, un respaldo fallido detenía TODOS los
       * envíos en silencio y el panel solo decía «pendiente» para siempre.
       */
      if(typeof db.backupQueue==='function')await db.backupQueue(mine).catch(()=>recordDiag({path:'/offline/respaldo',cause:'cuota',status:0}));
      let enviadas=0,motivoFallo='';
      for(const entry of await listQueue()){
        if(mine!==owner())break;
        /*
         * UNA OPERACIÓN EN «REVISAR» NO FRENA A LAS DEMÁS.
         *
         * Antes la primera rechazada cortaba el bucle: lo guardado días atrás
         * detrás de ella no se enviaba nunca. Se salta y se sigue con el resto.
         */
        if(entry.state!=='pending')continue;
        /*
         * LO QUE YA NO SIGNIFICA NADA NO SE ENVÍA TARDE.
         *
         * Una marca de «leído» guardada por una versión anterior se descarta al
         * sincronizar: mandarla ahora solo ensucia la auditoría y deja el aviso
         * de «cambio pendiente» encendido para siempre.
         */
        if(efimeroPath(String(entry.path).split('?')[0])){
          await changeQueue(q=>q.filter(p=>p.id!==entry.id));
          continue;
        }
        /*
         * UN RECUENTO SIN PRECONDICIÓN NO SE ENVÍA A CIEGAS.
         *
         * Los recuentos guardados por versiones anteriores no traen
         * `expectedQuantity`: aplicarlos sobrescribiría un stock más reciente que
         * ya está confirmado. Quedan para revisión, con su payload intacto.
         */
        if(/\/inventory\/count$/.test(String(entry.path))&&entry.body?.expectedQuantity==null){
          await changeQueue(q=>q.map(p=>p.id===entry.id?{...p,state:'review',attempts:(p.attempts||0)+1,
            error:'Recuento guardado por una versión anterior sin la cantidad esperada: no se aplica solo para no sobrescribir stock más reciente.'}:p));
          continue;
        }
        /*
         * EL RITMO DE LOS REINTENTOS LO LLEVA EL MOTOR, NO LA OPERACIÓN.
         *
         * Cada operación solo cuenta sus intentos. Guardar aquí «cuándo le toca»
         * hacía que una sincronización manual (o volver a la app con la red
         * arreglada) se saltara operaciones todavía «en espera» y pareciera que
         * no se enviaban nunca.
         */
        const path=replace(entry.path,mapping),body=sanearCuerpo(replace(entry.body,mapping),path);
        const claveEnvio=entry.retry?.idEnvio||entry.id;
        let r;
        try{r=await network(path,{method:entry.method,credentials:'same-origin',headers:{'content-type':'application/json','x-fulltech-operation':claveEnvio},body:JSON.stringify(body)});}
        catch{
          /* Un fallo de red no es un rechazo: no se cuenta como intento. */
          motivoFallo='Sin conexión con el servidor';
          break;
        }
        if(r.status===401){await marcarReautenticacion();motivoFallo='La sesión caducó: vuelve a entrar para enviarlo.';break;}
        if(r.status>=500){motivoFallo='El servidor no está disponible en este momento.';break;}
        const texto=await r.clone().text().catch(()=> '');
        let result=null;
        try{result=texto?JSON.parse(texto):null;}catch{result=null;}
        if(!r.ok){
          // Se guarda el motivo legible y el código: la pantalla no muestra «invalid_dismissals» a secas.
          await changeQueue(q=>q.map(p=>p.id===entry.id?{...p,state:'review',status:r.status,attempts:(p.attempts||0)+1,
            error:mensajeDeRechazo(result,r.status),lastError:{error:result?.error??null,message:result?.message??null,at:Date.now()}}:p));
          continue;
        }
        /*
         * UN 200 QUE NO ES EL JSON DEL CRM NO CONFIRMA NADA.
         *
         * Un portal cautivo o un proxy devuelven HTML con estado 200: darlo por
         * bueno borraba la operación sin que el servidor la hubiera aplicado.
         */
        if(!result||typeof result!=='object'||result.ok===false){
          await changeQueue(q=>q.map(p=>p.id===entry.id?{...p,state:'review',status:r.status,attempts:(p.attempts||0)+1,
            error:'El servidor respondió algo que no es una confirmación del CRM. La operación se conserva para revisión.',
            lastError:{error:result?.error??null,message:null,at:Date.now()}}:p));
          continue;
        }
        const real=result.session?.id||result.product?.id||result.category?.id||result.customer?.id||result.ticket?.id||result.document?.id||result.quoteId||result.orderId;
        if(real&&real!==entry.localId)mapping[entry.localId]=real;
        await db.put('mapping:'+mine,mapping);
        await changeQueue(q=>q.filter(p=>p.id!==entry.id));
        enviadas+=1;
      }
      if(mine===owner()){
        const url=new URL(location.href);for(const key of ['product','quote','ticket']){const old=url.searchParams.get(key);if(mapping[old])url.searchParams.set(key,mapping[old]);}history.replaceState(history.state,'',url);
        /*
         * LA COPIA SE REFRESCA COMO MUCHO CADA 10 MINUTOS.
         *
         * Antes, cada sincronización volvía a descargar todas las pantallas (~30
         * peticiones). Con el envío automático, eso pasaría después de CADA
         * cambio y en un móvil se comería datos y batería sin necesidad. Los datos
         * frescos ya llegan: los pide la propia pantalla al enviarse el cambio.
         */
        if(!(await listQueue()).length){
          const ultima=await db.get('preparation:'+mine).catch(()=>null);
          if(!ultima?.at||Date.now()-ultima.at>600000)await warm(true);
        }
        window.dispatchEvent(new CustomEvent('fulltech:offline-synced',{detail:{mapping}}));
        window.dispatchEvent(new Event('fulltech:catalog-updated'));window.dispatchEvent(new Event('fulltech:pos-saved'));
      }
      return {sent:enviadas,pending:await pendientesDeEnviar(),error:motivoFallo};
    };
    /*
     * LAS DOS COLAS SON INDEPENDIENTES.
     *
     * Antes, si la cola del panel tenía UN cambio pendiente o uno rechazado, esta
     * función devolvía sin enviar NADA del diario de operaciones: un rechazo
     * antiguo bloqueaba para siempre todo lo nuevo. Ahora cada cola se envía por
     * su lado; que una falle no detiene a la otra.
     */
    const prepare=async()=>{
      try{await window.FullTECHLegacyOffline?.synchronize();}catch{/* la cola del panel se reintenta sola */}
      return navigator.locks?.request?navigator.locks.request('fulltech-offline-write:'+owner(),run):run();
    };
    syncing=prepare().finally(()=>{syncing=null;signal();});return syncing;
  }
  const ROOTS=['session','data?offline=1','catalog','pos/customers','store/products','pos/tickets','pos/quotes','inventory','inventory/reconcile','customers?limit=5000','conversations?limit=5000','followups','customer-tags','notifications','delivery-tracking','locations?limit=5000','users','settings/deepseek','messages','scheduled','reports/sales?period=custom&from=1900-01-01&to=9999-12-31&offline=1','reports/sales?period=hoy','reports/sales?period=ayer','reports/sales?period=7d','reports/sales?period=30d','reports/sales?period=mes','metrics?period=hoy','metrics?period=7d','metrics?period=30d','push-status','chat-sharing','wa-templates','audit?limit=10','delivery-supervisor'];
  async function warm(force=false){
    if(warming)return warming;
    if(!navigator.onLine||!valid())return;
    warming=(async()=>{
      if((await listQueue()).length)return;
      try{if(JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]').length)return;}catch{}
      const mine=owner(),todo=ROOTS.map(p=>'/api/admin/'+p),seen=new Set();let completed=0,failed=0;const fallos=[];
      await navigator.storage?.persist?.().catch(()=>{});
      /*
       * LO PESADO TIENE MÁS MARGEN.
       *
       * Con 6 s para todo, `/api/admin/data` (cientos de KB con clientes,
       * pedidos e historial) se cortaba en un móvil lento: la copia quedaba sin la
       * pantalla principal y offline salía «no está guardada». Ahora lo grande
       * espera 15 s y, si falla, se reintenta UNA vez.
       */
      const fetchOne=async path=>{
        /*
         * LAS RUTAS PESADAS TIENEN EL MISMO MARGEN QUE AL LEERLAS.
         *
         * El servidor da 20 s a datos, supervisor, reportes y métricas; aquí se
         * les daba 8 s y se contaban como fallo aunque el servidor estuviera
         * respondiendo: de ahí venían reintentos eternos que nunca mejoraban.
         */
        const LENTAS=/^\/api\/admin\/(data|customers|conversations|store\/products|orders|delivery-supervisor|reports\/sales|metrics)(\/|$)/;
        const limit=LENTAS.test(path)?20000:8000;
        const run=async timeoutMs=>{
          const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
          try{return await network(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});}
          finally{clearTimeout(timeout);}
        };
        try{return await run(limit);}
        catch(error){recordDiag({path,cause:error?.name==='AbortError'?'timeout':'network',warm:true});
          if(limit>8000)return run(limit);
          throw error;}
      };
      while(todo.length&&mine===owner()&&navigator.onLine){
        const batch=todo.splice(0,4).filter(p=>!seen.has(p));batch.forEach(p=>seen.add(p));
        await Promise.all(batch.map(async path=>{
          try{
            const r=await fetchOne(path);
            if(r.headers.get('x-fulltech-offline')==='1'){failed++;fallos.push({path,cause:'copia'});return;}
            if(r.status===401){await forget();return;}
            if(!r.ok){recordDiag({path,cause:'http',status:r.status,warm:true});failed++;fallos.push({path,status:r.status});return;}
            await remember(path,r,true);if(path==='/api/admin/data?offline=1')await remember('/api/admin/data',r,true);completed++;
            if(!r.headers.get('content-type')?.includes('json'))return;
            const value=await r.json();
            const visit=v=>{
              if(typeof v==='string'&&v.startsWith('/api/admin/')&&!/events|calling|token=|sync=/.test(v)&&!seen.has(v))todo.push(v);
              else if(Array.isArray(v))v.forEach(visit);
              else if(v&&typeof v==='object')Object.values(v).forEach(visit);
            };visit(value);
            for(const [key,items] of Object.entries(value))if(Array.isArray(items)){
              /*
               * HASTA DÓNDE SE BAJA, A PROPÓSITO.
               *
               * Las LISTAS completas sí se guardan (es lo que se consulta). Del
               * detalle de cada registro se bajan solo los más recientes: bajar
               * 2.300 fichas en un móvil tarda minutos, llena el almacenamiento y
               * deja la descarga a medias (y con ella la sensación de «no está
               * guardado»). Lo que no se bajó se pide al servidor cuando vuelva
               * la red.
               */
              const MAX_DETALLE=200;
              const prefix=({customers:'customers',conversations:'conversations',quotes:'pos/quotes',tickets:'pos/tickets'})[key];
              if(prefix)for(const item of items.slice(0,key==='conversations'?120:MAX_DETALLE))if(item.id){todo.push('/api/admin/'+prefix+'/'+encodeURIComponent(item.id)+(key==='conversations'?'/messages':''));if(key==='customers')todo.push('/api/admin/customers/'+item.id+'/tags','/api/admin/pos/context/'+item.id);if(key==='quotes')todo.push('/api/admin/pos/quotes/'+item.id+'/receipt','/api/admin/pos/quotes/'+item.id+'/pdf');}
              if(key==='items'&&path.startsWith('/api/admin/data'))for(const item of items.slice(0,MAX_DETALLE))if(item.type==='order'||item.type==='order_intent')todo.push('/api/admin/orders/'+encodeURIComponent(item.id),'/api/admin/orders/'+encodeURIComponent(item.id)+'/receipt','/api/admin/orders/'+encodeURIComponent(item.id)+'/receipt.pdf');
              if(key==='customers')for(const item of items.slice(0,MAX_DETALLE))if(item.id)todo.push('/api/admin/customers/'+item.id+'/locations');
              if(key==='deliveryOrders')for(const item of items.slice(0,MAX_DETALLE))if(item.id)todo.push('/api/admin/delivery/orders/'+item.id);
            }
          }catch(error){failed++;fallos.push({path,cause:error?.name==='AbortError'?'timeout':'red'});}
        }));
        /*
         * QUÉ SE QUEDÓ SIN DESCARGAR, DICHO CON NOMBRE Y APELLIDO.
         *
         * Antes solo se guardaba un número (los «62 recursos»): imposible saber
         * si faltaba lo importante o una miniatura. Ahora se guarda la lista
         * (acotada) y se separa lo crítico de lo opcional.
         */
        const CRITICOS=new Set(['session','data?offline=1','catalog','inventory','store/products','customers?limit=5000','conversations?limit=5000','delivery-tracking','scheduled','messages','users','settings/deepseek']);
        const faltan=new Set(fallos.map(f=>f.path.replace('/api/admin/','')));
        const criticosFaltan=[...faltan].filter(p=>CRITICOS.has(p));
        await db.put('preparation:'+mine,{at:Date.now(),completed,failed,remaining:todo.length,fallos:fallos.slice(-80),criticosFaltan,listo:criticosFaltan.length===0});signal();
      }
      if(!force&&await listQueue().then(q=>q.length)&&!syncing)setTimeout(()=>synchronize().catch(()=>{}),0);
    })().finally(()=>{warming=null;signal();});return warming;
  }
  window.fetch=send;
  function saveLegacySnapshot(snapshot){
    const mine=owner();
    const run=async()=>{
      if(!valid()||mine!==owner())return;
      if(!JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]').length&&!(await listQueue()).length)return;
      const all=await data('/api/admin/data',{});
      for(const key of ['items','customers','conversations','followups','settings','scheduled','messages','deliveryTracking','notifications'])if(snapshot[key]){
        const value=clone(snapshot[key]);
        if(Array.isArray(value)&&Array.isArray(all[key]))for(const row of all[key])if(row.pending&&!value.some(v=>v.id===row.id))value.push(row);
        all[key]=value;
      }
      await save('/api/admin/data',all);
    };
    const next=localTail.catch(()=>{}).then(run);localTail=next;return next;
  }
  window.FullTECHOffline={ready,valid,warm,synchronize,listQueue,pendientes:pendientesDeEnviar,saveLegacySnapshot,sanearDismissals,backup:()=>db.get('respaldo:'+owner()),respaldar:()=>respaldarCola(),verificar:verificarEnServidor,reintentar:reintentarReparada,resolver:resolverOperacion,reparadas:()=>db.get('reparadas:'+owner()),exportRecovery,status:async()=>({valid:valid(),expiresAt:identity?identity.verifiedAt+DAY:null,shell:await db.get('shell'),preparation:await db.get('preparation:'+owner()),respaldo:await db.get('respaldo:'+owner()).then(r=>r?{at:r.at,count:(r.operaciones||[]).length}:null).catch(()=>null),rol:identity?.role??null,reparadas:await db.get('reparadas:'+owner()).then(r=>r?.length??0).catch(()=>0),queue:await listQueue()}),forget,clearCache,diagnostics:()=>[...diag]};
  if(!window.FullTECHSync)window.addEventListener('online',()=>setTimeout(()=>synchronize().catch(()=>{}),0));
  /*
   * LA COPIA SE BORRA AL CERRAR SESIÓN DE VERDAD, NO AL PINTAR EL ACCESO.
   *
   * `phyto:calling-logout` lo dispara también `showLogin()` cuando el panel no
   * puede validar la sesión sin red. Al escuchar ese evento, quedarse sin señal
   * un momento borraba la autorización de 24 h y todas las copias: el usuario
   * volvía a entrar y no tenía nada. Ahora el borrado lo pide la acción
   * explícita de «Cerrar sesión» (`fulltech:offline-logout`).
   */
  window.addEventListener('fulltech:offline-logout',()=>forget().catch(()=>{}));
  window.addEventListener('pageshow',()=>{if(navigator.onLine)warm().catch(()=>{});});
  /*
   * REINTENTO RÁPIDO MIENTRAS HAYA ALGO PENDIENTE.
   *
   * Cada 5 s, y al volver a la app (visibilitychange/focus), se intenta enviar lo
   * que quedó. Antes eran 30 s y solo con `navigator.onLine` en verdadero: un
   * cambio podía esperar minutos y parecía que había que pulsar «Sincronizar».
   */
  const reintentarPendientes=()=>{
    /* Con el motor único cargado, no se programa un reloj competidor. */
    if(window.FullTECHSync)return;
    if(!owner())return;
    listQueue().then(q=>{if(q.some(p=>p.state==='pending'))return synchronize().catch(()=>{});}).catch(()=>{});
  };
  if(!window.FullTECHSync){
    setInterval(reintentarPendientes,5000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reintentarPendientes();});
    window.addEventListener('focus',reintentarPendientes);
  }
  /*
   * AL ABRIR, PRIMERO LA COPIA DE RECUPERACIÓN.
   *
   * Así, una cola que venía de la versión anterior queda respaldada ANTES de
   * que el temporizador, el evento «online» o una sincronización en curso toquen
   * nada. Es idempotente y no sobrescribe la copia original.
   */
  ready
    .then(async () => {
      // Una cola guardada con la clave antigua (llevaba los permisos) se adopta
      // aunque la identidad ya estuviera migrada: si no, quedaría invisible.
      if (identity?.key) await adoptarColaAntigua(identity.key).catch(() => {});
      await respaldarCola().catch(() => {});
    })
    .catch(() => {});
  window.FulltechOffline=window.FullTECHOffline;
  if(!window.FullTECHSync)setInterval(()=>{
    if(owner())listQueue().then(q=>{if(q.some(p=>p.state==='pending'))synchronize().catch(()=>{});}).catch(()=>{});
  },30000);
})();
