/* ============================================================
   MONEY PRO X — Main Application Logic
   ============================================================ */

(function lockViewportGestures(){
  // User request: prevent page zoom (pinch, double-tap, ctrl/cmd+wheel).
  // NOTE: This is intentionally strict and may reduce accessibility.
  try{
    ['gesturestart','gesturechange','gestureend'].forEach(evt=>{
      document.addEventListener(evt, e=>{ e.preventDefault(); }, {passive:false});
    });

    // Desktop trackpad pinch usually comes through as ctrl/cmd + wheel.
    window.addEventListener('wheel', e=>{
      if(e.ctrlKey||e.metaKey) e.preventDefault();
    }, {passive:false});

    // Common keyboard zoom shortcuts.
    document.addEventListener('keydown', e=>{
      if(!(e.ctrlKey||e.metaKey)) return;
      if(e.key==='+'||e.key==='='||e.key==='-'||e.key==='0') e.preventDefault();
    }, {capture:true});

    // iOS Safari double-tap zoom.
    let lastTouchEnd=0;
    document.addEventListener('touchend', e=>{
      const now=Date.now();
      if(now-lastTouchEnd<=300) e.preventDefault();
      lastTouchEnd=now;
    }, {passive:false});

    // Some iOS versions expose `scale` during a pinch via touch events.
    document.addEventListener('touchmove', e=>{
      if(typeof e.scale==='number' && e.scale!==1) e.preventDefault();
    }, {passive:false});
  }catch(e){}
})();

function saveTxLocal(payload){
  if(AppState.editId){
    const i=AppState.transactions.findIndex(x=>x.id===AppState.editId);
    if(i>=0) AppState.transactions[i]=Object.assign({},AppState.transactions[i],payload,{id:AppState.editId});
  } else {
    payload.id='local_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    AppState.transactions.push(payload);
  }
  saveTransactions();
}

async function saveTx(e){
  if(e) e.preventDefault();
  haptic();
  if(!hasAccounts()){
    toast('Crea prima un conto','warn');
    openAccountSetup();
    return;
  }
  showLoader();
  let payload=null;
  try {
    const isTr = (AppState.fType === 'transfer');
    const amt = parseFloat(document.getElementById('txAmt').value);
    if(isNaN(amt)||amt<=0) throw new Error('Inserisci un importo valido');

    const acc = isTr ? document.getElementById('txAccFrom').value : (document.getElementById('txAcc').value || getDefaultAccountName());
    const accTo = isTr ? document.getElementById('txAccTo').value : null;
    if(isTr && acc === accTo) throw new Error('Scegli due conti diversi');
    if(!acc) throw new Error('Seleziona un conto');

    const tags = isTr ? '[]' : JSON.stringify(Array.from(document.querySelectorAll('.tbtn.on')).map(b=>b.dataset.tag));
    
    payload = {
      type: AppState.fType,
      amount: amt,
      date: document.getElementById('txDate').value,
      time: document.getElementById('txTime')?.value || '',
      category_id: isTr ? 'other' : (document.getElementById('txCat').value || 'other'),
      description: document.getElementById('txDesc').value.trim() || (isTr ? `Giro ${acc}→${accTo}` : ''),
      account: acc,
      account_to: accTo,
      tags
    };

    if(OFFLINE || !db){
      saveTxLocal(payload);
      toast('Salvato localmente ✓','success');
    } else {
      const dbP = toDbPayload(payload, isTr ? 'transfer' : payload.type, payload.description);
      let result = null;
      if(AppState.editId && isUUID(AppState.editId)){
        result = await dbUpdateTxRow(AppState.editId, dbP);
      } else {
        result = await dbInsertTxRow(dbP);
      }
      
      if(result.error) throw result.error;
      const savedId = result.data?.[0]?.id;
      if(!savedId) throw new Error('Salvataggio database fallito (nessun ID)');

      // Meta (tags, account_to)
      try {
        if(isTr || tags !== '[]') await DatabaseService.saveTxMetaStrict(savedId, {account_to: accTo, tags});
        else await DatabaseService.deleteTxMeta(savedId);
      } catch(mE){ console.warn('Meta non-blocking error:', mE); }

      // Update Local State
      payload.id = savedId;
      if(AppState.editId){
        const idx = AppState.transactions.findIndex(x=>x.id===AppState.editId);
        if(idx>=0) AppState.transactions[idx] = payload; else AppState.transactions.push(payload);
      } else {
        AppState.transactions.push(payload);
      }
      saveTransactions();
      toast('Salvato nel database ✓','success');
    }

    // Update balances
    await DatabaseService.updateAccountBalance(payload.account);
    if(payload.account_to) await DatabaseService.updateAccountBalance(payload.account_to);

  } catch(err) {
    console.error('saveTx error:', err);
    const errMsg = err.message || err.details || 'Errore imprevisto';
    if(payload){
      saveTxLocal(payload);
      toast(`Errore Sync: ${errMsg}. Salvato in locale.`,'warn');
    } else {
      toast(`Errore: ${errMsg}`,'error');
    }
  } finally {
    hideLoader();
    closeAll();
    renderAll();
    if(!AppState.editId) checkAch();
  }
}

async function deleteTx(id){
  haptic();
  showLoader();
  try {
    const t=AppState.transactions.find(x=>x.id===id); if(!t) return;
    AppState.undoQ.push(JSON.parse(JSON.stringify(t)));
    // remove both halves of a transfer
    if(t.type==='transfer'&&t._partner_id){
      AppState.transactions=AppState.transactions.filter(x=>x.id!==id&&x.id!==t._partner_id);
    } else {
      AppState.transactions=AppState.transactions.filter(x=>x.id!==id);
    }
    saveTransactions();
    const btn=document.getElementById('undoBtn');
    if(btn){
      btn.classList.remove('hidden');
      clearTimeout(AppState._undoTimer);
      AppState._undoTimer=setTimeout(()=>btn.classList.add('hidden'),8000);
    }
    toast('Eliminato — <b>Annulla</b> entro 8s','warn');
    
    if(!OFFLINE&&db){
      try{
        if(t.type==='transfer'&&t._transfer_ref){
          await db.from('transactions').delete().like('description',`[GIRO:${t._transfer_ref}]%`);
        } else if(t.type==='transfer'&&t._partner_id){
          await Promise.all([
            db.from('transactions').delete().eq('id',id),
            db.from('transactions').delete().eq('id',t._partner_id),
          ]);
        } else {
          await db.from('transactions').delete().eq('id',id);
        }
      }catch(e){ console.warn('deleteTx DB',e); }
      try{
        await DatabaseService.deleteTxMeta(id);
        if(t._partner_id) await DatabaseService.deleteTxMeta(t._partner_id);
      }catch(e){}
    }
    // refresh balance for affected account(s) (works offline too)
    try{
      if(t.type==='transfer'){ await DatabaseService.updateAccountBalance(t.account); if(t.account_to) await DatabaseService.updateAccountBalance(t.account_to); }
      else await DatabaseService.updateAccountBalance(t.account);
    }catch(e){}
  } finally {
    hideLoader();
    renderAll();
  }
}

async function undoTx(){
  const t=AppState.undoQ.pop(); if(!t) return;
  haptic(); AppState.transactions.push(t); saveTransactions();
  document.getElementById('undoBtn').classList.add('hidden');
  toast('Azione annullata ✓','success');
  renderAll();
  try{
    if(t.type==='transfer'){ DatabaseService.updateAccountBalance(t.account); if(t.account_to) DatabaseService.updateAccountBalance(t.account_to); }
    else DatabaseService.updateAccountBalance(t.account);
  }catch(e){}
  if(!OFFLINE&&db){
    try{
      if(t.type==='transfer'){
        const desc=t.description||`Giro ${t.account}→${t.account_to}`;
        const res=await dbInsertTxRow(toDbPayload(t,'transfer',desc));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id;
        if(newId){
          t.id=newId;
          delete t._partner_id;
          delete t._transfer_ref;
          await DatabaseService.saveTxMetaStrict(newId,{account_to:t.account_to||null,tags:'[]'});
        }
      } else {
        const res=await dbInsertTxRow(toDbPayload(t));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id;
        if(newId) t.id=newId;
        try{
          const tags=t.tags||'[]';
          const account_to=t.account_to||null;
          if(newId && (account_to||tags!=='[]')) await DatabaseService.saveTxMeta(newId,{account_to,tags});
        }catch(e){}
      }
      saveTransactions();
      if (t.type === 'transfer') { await DatabaseService.updateAccountBalance(t.account); if (t.account_to) await DatabaseService.updateAccountBalance(t.account_to); }
      else await DatabaseService.updateAccountBalance(t.account);
      renderAll(); // refresh click handlers with updated ids
    }catch(e){ console.warn('undoTx DB',e); }
  }
}

async function dupTx(id){
  haptic();
  const t=AppState.transactions.find(x=>x.id===id); if(!t) return;
  const nt={...t}; delete nt.id; delete nt._partner_id; delete nt._transfer_ref;
  nt.date=fmtDate(new Date());
  nt.time=nowTimeHM();
  const tempId='local_'+Date.now()+'_dup';
  nt.id=tempId;
  AppState.transactions.push(nt); saveTransactions();
  toast('Duplicato ✓','success'); renderAll();
  try{
    if(nt.type==='transfer'){ DatabaseService.updateAccountBalance(nt.account); if(nt.account_to) DatabaseService.updateAccountBalance(nt.account_to); }
    else DatabaseService.updateAccountBalance(nt.account);
  }catch(e){}
  if(!OFFLINE&&db){
    try{
      if(nt.type==='transfer'){
        const desc=nt.description||`Giro ${nt.account}→${nt.account_to}`;
        const res=await dbInsertTxRow(toDbPayload(nt,'transfer',desc));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id||tempId;
        if(newId && newId!==tempId){
          await DatabaseService.saveTxMetaStrict(newId,{account_to:nt.account_to||null,tags:'[]'});
        }
        const merged={
          ...nt,
          id:newId,
          type:'transfer',
          description:desc,
          tags:'[]',
        };
        const i=AppState.transactions.findIndex(x=>x.id===tempId);
        if(i>=0) AppState.transactions[i]=merged;
        saveTransactions();
        await DatabaseService.updateAccountBalance(nt.account); if(nt.account_to) await DatabaseService.updateAccountBalance(nt.account_to);
        renderAll(); // refresh click handlers with updated ids
      } else {
        const res=await dbInsertTxRow(toDbPayload(nt));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id;
        if(newId){
          const i=AppState.transactions.findIndex(x=>x.id===tempId);
          if(i>=0) AppState.transactions[i].id=newId;
          try{
            const tags=nt.tags||'[]';
            const account_to=nt.account_to||null;
          if(account_to||tags!=='[]') await DatabaseService.saveTxMeta(newId,{account_to,tags});
          }catch(e){}
          saveTransactions();
          await DatabaseService.updateAccountBalance(nt.account);
          renderAll(); // refresh click handlers with updated ids
        }
      }
    }catch(e){}
  }
}

async function loadData(force=false){
  if(OFFLINE||!db){ renderAll(); return; }
  const localHas=(()=>{ try{ return (loadTransactions()||[]).length>0; }catch(e){ return false; } })();
  updateSyncStatus('loading');
  try{
    let data=null, error=null;
    {
      const res=await db.from('transactions')
        .select('id,type,amount,category_id,description,date,time,account,recurring,created_at')
        .order('date',{ascending:false})
        .order('time',{ascending:false, nullsFirst:false});
      data=res.data; error=res.error;
      if(error && _isMissingCol(error,'time')){
        _warnMissingTimeCol();
        const res2=await db.from('transactions')
          .select('id,type,amount,category_id,description,date,account,recurring,created_at')
          .order('date',{ascending:false});
        data=res2.data; error=res2.error;
      }
    }
    if(error) throw error;
    if((data||[]).length===0 && localHas){
      // prevent wiping local-only data when DB is empty/new
      updateSyncStatus('ok');
      toast('Database vuoto: tengo i dati locali. Usa "Migra dati locali → Database".','warn');
      renderAll();
      return;
    }
    AppState.transactions=processDbRows(data||[]);
    // Self-heal: legacy giroconti "orfani" (una sola metà salvata) → promuovi a `type='transfer'` + txmeta.account_to.
    try{
      const orphans=(AppState.transactions||[]).filter(t=>t&&t.type==='transfer'&&t._orphan&&isUUID(t.id)&&t.account&&t.account_to);
      if(orphans.length){
        (async()=>{
          for(const t of orphans.slice(0,12)){
            try{
              const desc=t.description||`Giro ${t.account}→${t.account_to}`;
              const upd=await dbUpdateTxRow(t.id,toDbPayload(t,'transfer',desc));
              if(upd?.error) throw upd.error;
              await DatabaseService.saveTxMetaStrict(t.id,{account_to:t.account_to,tags:'[]'});
            }catch(e){ console.warn('giro.repair orphan',t?.id,e); }
          }
        })().catch(()=>{});
      }
    }catch(e){}
    saveTransactions();
    renderAll();
    updateSyncStatus('ok');
  }catch(err){
    console.error('loadData error:',err);
    if(!AppState.transactions.length) AppState.transactions=loadTransactions();
    renderAll(); updateSyncStatus('error');
    toast(`Errore sync: ${err.message||err.code||'controlla URL/chiave'}`,'error');
  }
}

/* ============================================================
   STATE & CONFIG
============================================================ */
// State lives in `AppState` + `UserConfig` (initialized in db.js).

/* ============================================================
   CATEGORIES
============================================================ */

/* ============================================================
   FINTECH & ACCOUNT ICON SYSTEM
============================================================ */
// Fintech brand icons: { key: {label, bg, fg, text, emoji} }
const FINTECH_BRANDS = {
  paypal:    {label:'PayPal',    bg:'#003087',fg:'#009cde',text:'PP',  emoji:'🅿', localIcon:'/Icone/PayPal.png'},
  hype:      {label:'Hype',     bg:'#6B21A8',fg:'#A855F7',text:'HY',  emoji:'💜', localIcon:'/Icone/Hype.png'},
  revolut:   {label:'Revolut',  bg:'#191C1F',fg:'#FF6B35',text:'RV',  emoji:'🔶', localIcon:'/Icone/Revolut.png'},
  satispay:  {label:'Satispay', bg:'#E4002B',fg:'#FF4461',text:'S',   emoji:'🔴', localIcon:'/Icone/Satispay.png'},
  n26:       {label:'N26',      bg:'#1A1A1A',fg:'#00B2A9',text:'N26', emoji:'🏦'},
  postepay:  {label:'Postepay', bg:'#F7941D',fg:'#FFC342',text:'PP',  emoji:'🟠', localIcon:'/Icone/Postepay.jpeg'},
  wise:      {label:'Wise',     bg:'#9FE870',fg:'#163300',text:'W',   emoji:'💚'},
  monzo:     {label:'Monzo',    bg:'#FF3464',fg:'#FFD4E0',text:'M',   emoji:'🌸'},
  bunq:      {label:'bunq',     bg:'#00A86B',fg:'#E8FFF4',text:'bq',  emoji:'🟢'},
  tinaba:    {label:'Tinaba',   bg:'#FF6600',fg:'#fff',   text:'Ti',  emoji:'🟠'},
  illimity:  {label:'illimity', bg:'#1B3A6B',fg:'#5AB4FF',text:'Il',  emoji:'🔵'},
  buddybank: {label:'Buddybank',bg:'#FF5F1F',fg:'#fff',   text:'BB',  emoji:'🟠'},
  fineco:    {label:'FinecoBank',bg:'#005BAC',fg:'#fff',  text:'FN',  emoji:'🔵', localIcon:'/Icone/Fineco.png'},
  mediolanum:{label:'Mediolanum',bg:'#00A86B',fg:'#fff',  text:'MD',  emoji:'🟢'},
  unicredit: {label:'UniCredit',bg:'#E3000F',fg:'#fff',   text:'UC',  emoji:'🔴'},
  intesa:    {label:'Intesa SP',bg:'#008751',fg:'#fff',   text:'IS',  emoji:'🟢'},
  bnl:       {label:'BNL',      bg:'#004A97',fg:'#fff',   text:'BNL', emoji:'🔵'},
  mps:       {label:'Monte Paschi',bg:'#00294D',fg:'#D4AF37',text:'MPS',emoji:'🏦'},
  vinted:    {label:'Vinted',   bg:'#00A1B2',fg:'#fff',   text:'V',   emoji:'👗', localIcon:'/Icone/Vinted.png'},
};

// Generic account icons (lucide icon name → display label)
const GENERIC_ACC_ICONS = [
  {ic:'credit-card', label:'Carta'},
  {ic:'wallet',      label:'Wallet'},
  {ic:'banknote',    label:'Cash'},
  {ic:'piggy-bank',  label:'Risparmi'},
  {ic:'trending-up', label:'Invest.'},
  {ic:'landmark',    label:'Banca'},
  {ic:'building-2',  label:'Ufficio'},
  {ic:'smartphone',  label:'Digital'},
  {ic:'coins',       label:'Monete'},
  {ic:'briefcase',   label:'Lavoro'},
  {ic:'home',        label:'Casa'},
  {ic:'globe',       label:'Online'},
];

// Category emoji map for visual picker
const CAT_EMOJI = {
  food:'🍕', transport:'🚗', home:'🏠', shopping:'🛍',
  health:'💊', entertain:'🎬', travel:'✈️', education:'📚',
  salary:'💰', subscript:'🔄', invest:'📈', other:'🏷',
};

// Detect fintech brand from account name
function detectBrand(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const [key, brand] of Object.entries(FINTECH_BRANDS)) {
    if (n.includes(key) || n.includes(brand.label.toLowerCase())) return key;
  }
  return null;
}

// Render account icon (fintech badge OR custom logo OR lucide icon)
function renderAccIcon(acc, size=26, radius=8) {
  if (acc.logoUrl) {
    return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:white;padding:2px;border:1px solid var(--bo)">
      <img src="${acc.logoUrl}" alt="${acc.name}" style="width:100%;height:100%;object-fit:contain;border-radius:${radius-2}px">
    </div>`;
  }
  const brand = detectBrand(acc.name);
  if (brand) {
    const b = FINTECH_BRANDS[brand];
    if (b.localIcon) {
      return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:white;padding:2px;border:1px solid var(--bo)">
        <img src="${b.localIcon}" alt="${b.label}" style="width:100%;height:100%;object-fit:contain;border-radius:${radius-2}px">
      </div>`;
    }
    return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${b.bg};font-size:${Math.floor(size*.38)}px">${b.text}</div>`;
  }
  return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${acc.color||'var(--br)'}22">
    <i data-lucide="${acc.icon||'wallet'}" style="width:${Math.floor(size*.55)}px;height:${Math.floor(size*.55)}px;color:${acc.color||'var(--br)'}"></i>
  </div>`;
}

// Categories live in `public/legacy/db.js` as `Categories` (and `CATS` alias).

/* ============================================================
   ACHIEVEMENTS
============================================================ */
const ACHS=[
  {id:'first',   e:'🎯',t:'Prima Transazione',  fn:x=>x.length>=1},
  {id:'ten',     e:'📊',t:'10 Movimenti',        fn:x=>x.length>=10},
  {id:'fifty',   e:'🏆',t:'50 Movimenti',        fn:x=>x.length>=50},
  {id:'hundred', e:'💯',t:'100 Movimenti',       fn:x=>x.length>=100},
  {id:'saver',   e:'💰',t:'Risparmio >20%',      fn:(x,c)=>savingsRateFor(x,new Date())>20},
  {id:'multw',   e:'🏦',t:'3 Wallet Attivi',     fn:(_,c)=>c.wallets.length>=3},
  {id:'budget',  e:'⚡',t:'Budget Impostato',    fn:(_,c)=>Object.keys(c.budgets||{}).length>0},
  {id:'bigIn',   e:'💎',t:'Entrata 1000€+',      fn:x=>x.some(t=>t.type==='income'&&+t.amount>=1000)},
  {id:'goal',    e:'🎯',t:'Obiettivo Attivo',    fn:(_,c)=>!!c.goalVal},
  {id:'cats6',   e:'✨',t:'6 Categorie Usate',   fn:x=>new Set(x.filter(t=>t.type!=='transfer').map(t=>t.category_id)).size>=6},
  {id:'posMon',  e:'🌟',t:'Mese Positivo',       fn:x=>{const n=new Date();const mx=x.filter(t=>{const d=new Date(t.date);return d.getMonth()===n.getMonth()&&d.getFullYear()===n.getFullYear()&&t.type!=='transfer';});return mx.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0)>mx.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0)&&mx.length>0;}},
  {id:'export',  e:'📤',t:'Dati Esportati',      fn:()=>false},
  {id:'streak7', e:'🔥',t:'7 giorni consecutivi',fn:x=>{const dates=new Set(x.map(t=>t.date));let streak=0,d=new Date();for(let i=0;i<30;i++){const k=fmtDate(d);if(dates.has(k)){streak++;}else{break;}d.setDate(d.getDate()-1);}return streak>=7;}},
  {id:'tpl',     e:'📌',t:'Template Creato',     fn:(_,c)=>(c.templates||[]).length>0},
  {id:'importer',e:'📥',t:'Dati Importati',      fn:()=>false},
];

/* ============================================================
   PERSIST HELPERS — legacy compat (scrittura locale immediata)
   Ogni saveConfig() ora pusha al DB in background via DBS
============================================================ */
// Persistence helpers moved to db.js

/* ============================================================
   SQL SCHEMA — 10 tabelle complete
============================================================ */
/* ── SQL Schema — Managed in db.js ── */
function copySQLSchema(){
  const s = typeof SQL_SCHEMA !== 'undefined' ? SQL_SCHEMA : '';
  navigator.clipboard?.writeText(s).then(()=>toast('Schema copiato ✓','success')).catch(()=>toast('Copia dal box manualmente','warn'));
}


/* DatabaseService sync logic is now in db.js */

/* ── CATEGORY MANAGER ── */
function openCatManager(){ closeAll(); openModal('catM'); renderCatManager(); }
function renderCatManager(){
  const list = document.getElementById('catManagerList');
  if(!list) return;
  const custom = Object.entries(CATS).filter(([k,v])=>v._custom);
  if(!custom.length){
    list.innerHTML = `<p class="text-xs text-center py-4 opacity-50">Nessuna categoria personalizzata.</p>`;
    return;
  }
  list.innerHTML = custom.map(([k,v])=>`
    <div class="cat-manager-item flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:${v.bg}"><i data-lucide="${v.ic}" class="w-4 h-4" style="color:${v.col}"></i></div>
        <span class="text-sm font-bold">${v.l}</span>
      </div>
      <button onclick="deleteCustomCat('${k}')" class="p-2 text-red-500 opacity-60 hover:opacity-100"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
    </div>
  `).join('');
  lucide.createIcons();
}
async function saveCustomCat(){
  const label = document.getElementById('nCatLabel').value.trim();
  const color = document.getElementById('nCatColor').value;
  const icon = document.getElementById('nCatIcon').value.trim() || 'tag';
  if(!label){ toast('Inserisci un nome','error'); return; }
  const key = 'c_'+Date.now();
  const bg = color + '22';
  
  Categories[key] = {l:label, ic:icon, col:color, bg:bg, kw:[], _custom:true};
  document.getElementById('nCatLabel').value = '';
  document.getElementById('nCatIcon').value = '';
  
  if(!OFFLINE && db){
    try { await db.from('categories').insert([{key, label, icon, color, background:bg}]); } 
    catch(e){ console.warn('cat.save',e); }
  }
  localStorage.setItem('mpx_cats', JSON.stringify(Object.entries(CATS).filter(([k,v])=>v._custom).map(([k,v])=>({key:k,label:v.l,icon:v.ic,color:v.col,background:v.bg}))));
  renderCatManager();
  renderAll();
  toast('Categoria aggiunta ✓','success');
}
async function deleteCustomCat(key){
  if(!confirm('Eliminare questa categoria?')) return;
  delete Categories[key];
  if(!OFFLINE && db){
    try { await db.from('categories').delete().eq('key', key); } 
    catch(e){ console.warn('cat.delete',e); }
  }
  localStorage.setItem('mpx_cats', JSON.stringify(Object.entries(CATS).filter(([k,v])=>v._custom).map(([k,v])=>({key:k,label:v.l,icon:v.ic,color:v.col,background:v.bg}))));
  renderCatManager();
  renderAll();
}

/* ============================================================
   INIT — asincrono: localStorage subito, poi DB in background
============================================================ */
async function init(){
  // 1. Carica config da localStorage (fast, sincrono)
  try{ Object.assign(UserConfig, loadConfig()); }catch(e){}
  if(!localStorage.getItem('mpxCfg2') && window.matchMedia('(prefers-color-scheme:dark)').matches) UserConfig.theme='dark';
  if(!UserConfig.templates)     UserConfig.templates=[];
  if(!UserConfig.notes)         UserConfig.notes=[];
  if(!UserConfig.recurringTxs)  UserConfig.recurringTxs=[];
  if(!UserConfig.fx)            UserConfig.fx={EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
  if(!UserConfig.budgets)       UserConfig.budgets={};
  if(!UserConfig.ach)           UserConfig.ach={};
  if(!UserConfig.layout)        UserConfig.layout={};
  if(!UserConfig._accounts)     UserConfig._accounts=[];
  if(!UserConfig.subscriptions) UserConfig.subscriptions=[];
  if(!UserConfig.debts)         UserConfig.debts=[];
  if(!UserConfig.goals)         UserConfig.goals=[];
  if(!UserConfig.investments)   UserConfig.investments=[];
  if(typeof UserConfig.investIncludeInTotal!=='boolean') UserConfig.investIncludeInTotal=true;
  // 0. Auto-refresh investments on load (REMOVED: moved later to ensure data is loaded first)

  // Prefer per-entity caches (newer than snapshot in mpxCfg2)
  try{ const subs=JSON.parse(localStorage.getItem('mpx_subscriptions')||'null'); if(subs?.length) UserConfig.subscriptions=subs; }catch(e){}
  try{ const debts=JSON.parse(localStorage.getItem('mpx_debts')||'null'); if(debts?.length) UserConfig.debts=debts; }catch(e){}
  try{ const goals=JSON.parse(localStorage.getItem('mpx_goals')||'null'); if(goals?.length) UserConfig.goals=goals; }catch(e){}
  try{ const invs=JSON.parse(localStorage.getItem('mpx_investments')||'null'); if(invs?.length) UserConfig.investments=invs; }catch(e){}
  // One-time backfill for users coming from older versions
  if(localStorage.getItem('mpx_subscriptions')==null && UserConfig.subscriptions?.length) localStorage.setItem('mpx_subscriptions',JSON.stringify(UserConfig.subscriptions));
  if(localStorage.getItem('mpx_debts')==null && UserConfig.debts?.length) localStorage.setItem('mpx_debts',JSON.stringify(UserConfig.debts));
  if(localStorage.getItem('mpx_goals')==null && UserConfig.goals?.length) localStorage.setItem('mpx_goals',JSON.stringify(UserConfig.goals));
  // Normalize ids to strings (DB ids are UUID strings)
  try{ UserConfig.subscriptions=(UserConfig.subscriptions||[]).map(s=>({...(s||{}),id:normId(s.id)})); }catch(e){}
  try{ UserConfig.debts=(UserConfig.debts||[]).map(d=>({...(d||{}),id:normId(d.id)})); }catch(e){}
  try{ UserConfig.goals=(UserConfig.goals||[]).map(g=>({...(g||{}),id:normId(g.id)})); }catch(e){}
  try{ UserConfig.investments=(UserConfig.investments||[]).map(inv=>({...(inv||{}),id:normId(inv.id)})); }catch(e){}

  // 2. Tema e colore immediati
  applyTheme();
  applyColor(UserConfig.color||'#0066FF');
  try{ renderBalToggleBtn(); }catch(e){}

  // 3. UI base
  try{ document.getElementById('darkT').checked=UserConfig.theme==='dark'; }catch(e){}
  try{ document.getElementById('currS').value=UserConfig.currency||'€'; }catch(e){}
  try{ document.getElementById('gNameI').value=UserConfig.goalName||''; }catch(e){}
  try{ document.getElementById('gValI').value=UserConfig.goalVal||''; }catch(e){}

  // 4. Carica conti da localStorage/defaults
  await DatabaseService.loadAccounts();
  if(!hasAccounts()){
    openAccountSetup();
  }
  // First run: if cloud sync isn't configured yet, guide user to paste SQL + credentials.
  try{
    if(OFFLINE && !localStorage.getItem('mpxSbOnboardDone') && hasAccounts()){
      setTimeout(()=>{ try{ openSbOnboard(); }catch(e){} },600);
    }
  }catch(e){}

  // 4b. Carica investimenti da DB/localStorage
  try{ await DatabaseService.loadInvestments(); }catch(e){}
  
  // Auto-refresh investments quotes after loading data
  if((UserConfig.investments||[]).length > 0) {
    refreshInvestQuotes().catch(()=>{});
  }

  // Onboarding investimenti (API mercato) — facoltativo
  try{
    if(!localStorage.getItem('mpxInvestOnboardDone')){
      setTimeout(()=>{ try{ openInvestOnboard(); }catch(e){} },1400);
    }
  }catch(e){}

  // 5. Popola select categorie
  ['txCat','fCat'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel||sel.options.length>1) return;
    Object.entries(CATS).forEach(([k,c])=>{ const o=document.createElement('option'); o.value=k; o.textContent=c.l; sel.appendChild(o); });
  });

  // 6. Setup UI componenti
  try{ setGreeting(); }catch(e){}
  try{ renderWalletSettings(); }catch(e){}
  try{ populateWalletSel(); }catch(e){}
  try{ buildCalc(); }catch(e){}
  try{ buildBudgetList(); }catch(e){}
  try{ buildColorPicker(); }catch(e){}
  try{ renderAchievements(); }catch(e){}
  try{ renderSQLSchema(); }catch(e){}
  try{ captureDefaultLayouts(); applyLayouts(); installLayoutDnD(); }catch(e){}

  // 7. Dati transazioni da localStorage
  try{ AppState._localMeta=loadMetadata(); }catch(e){ AppState._localMeta={}; }
  try{ AppState.transactions=loadTransactions(); }catch(e){ AppState.transactions=[]; }
  AppState.period = AppState.period || 'month';
  try{ injectRecurring().catch(()=>{}); }catch(e){}

  // 8. Prima render con dati locali
  renderAll();
  updateSyncStatus();
  setTimeout(()=>{ try{ refreshSbStatus(); }catch(e){} },100);

  // 9. Keyboard shortcuts
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT') return;
    if(e.key==='n'||e.key==='N') openAdd();
    if(e.key==='k'||e.key==='K') openCalc();
    if(e.key==='/'){ e.preventDefault(); openCommand(); }
    if(e.key==='1') switchTabById('home');
    if(e.key==='2') switchTabById('wallets');
    if(e.key==='3') switchTabById('stats');
    if(e.key==='4') switchTabById('settings');
    if(e.key==='Escape') closeAll();
  });

  // 10. PIN
  try{
    if(UserConfig.pinEnabled&&UserConfig.pin){ const ps=document.getElementById('pinScreen'); if(ps) ps.classList.remove('hidden'); const sk=document.getElementById('pinSkip'); if(sk) sk.style.display='none'; }
  }catch(e){}

  // 11. Carica tutto dal DB in background
  if(!OFFLINE && db){
    await _syncAllFromDB();
  }

  // 12. Automazione abbonamenti
  try {
    await processPendingSubscriptions();
  } catch(e) { console.warn('Subscription automation failed', e); }
}

async function processPendingSubscriptions() {
  const subs = UserConfig.subscriptions || [];
  const today = new Date();
  today.setHours(0,0,0,0);
  let changed = false;
  let createdCount = 0;

  for (const s of subs) {
    if (!s.active) continue;
    let nextDate = new Date(s.nextDate);
    nextDate.setHours(0,0,0,0);

    while (nextDate <= today) {
      const accName = UserConfig.defaultWallet || (UserConfig._accounts && UserConfig._accounts[0] ? UserConfig._accounts[0].name : '');
      const payload = {
        type: 'expense',
        amount: s.amount,
        date: fmtDate(nextDate),
        time: '09:00',
        category_id: 'subscript',
        description: `Abbonamento: ${s.name}`,
        account: accName
      };

      try {
        if (OFFLINE || !db) {
          saveTxLocal(payload);
        } else {
          const dbP = toDbPayload(payload);
          const result = await dbInsertTxRow(dbP);
          if (result.error) throw result.error;
          const savedId = result.data?.[0]?.id;
          if (savedId) payload.id = savedId;
          AppState.transactions.push(payload);
          saveTransactions();
        }
        createdCount++;
        console.log(`Automazione: Creata transazione per ${s.name} del ${payload.date}`);

        // Calcola prossima data
        if (s.frequency === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
        else if (s.frequency === 'yearly') nextDate.setFullYear(nextDate.getFullYear() + 1);
        else nextDate.setMonth(nextDate.getMonth() + 1); // default monthly

        s.nextDate = fmtDate(nextDate);
        changed = true;
      } catch (err) {
        console.error(`Errore automazione ${s.name}:`, err);
        break;
      }
    }

    // Salva la subscription aggiornata
    if (changed) {
      await DatabaseService.saveSub(s);
    }
  }

  if (changed) {
    saveConfig();
    renderAll();
    if (createdCount > 0) {
      toast(`${createdCount} transazione/i abbonamento create automaticamente ✓`, 'success');
    }
  }
}

async function _syncAllFromDB(){
  updateSyncStatus('loading');
  try{
    await Promise.all([
      DatabaseService.pullSettings(),
      DatabaseService.loadAccounts(),
      DatabaseService.loadCustomCategories(),
      DatabaseService.loadBudgets(),
      DatabaseService.loadTemplates(),
      DatabaseService.loadNotes(),
      DatabaseService.loadDebts(),
      DatabaseService.loadSubscriptions(),
      DatabaseService.loadGoals(),
      DatabaseService.loadInvestments(),
    ]);
    // meta must load before transactions render (tags live here)
    await DatabaseService.loadTxMeta();
    await loadData(true);
    // re-apply settings pulled from DB
    try{ document.getElementById('darkT').checked=UserConfig.theme==='dark'; applyTheme(); }catch(e){}
    try{ document.getElementById('currS').value=UserConfig.currency||'€'; }catch(e){}
    applyColor(UserConfig.color||'#0066FF');
    buildBudgetList();
    buildColorPicker();
    renderWalletSettings();
    populateWalletSel();
    renderAchievements();
    applyLayouts();
    renderAll();
    updateSyncStatus('ok');
    toast('✅ Sincronizzato col database','success');
  }catch(err){
    console.error('_syncAllFromDB',err);
    updateSyncStatus('error');
  }
}

function renderSQLSchema(){
  const el=document.getElementById('sqlSchemaEl'); if(el) el.textContent=SQL_SCHEMA;
}
function migrateLocalToDB(){ DatabaseService.migrateAll(); }

/* ── Account color picker ── */
const _ACC_COLORS=['#0066FF','#00C896','#7C3AED','#FF9500','#FF3B5C','#5AC8FA','#FF6B00','#4CAF50'];
let _accColorIdx=0;
function cycleAccColor(){
  _accColorIdx=(_accColorIdx+1)%_ACC_COLORS.length;
  const dot=document.getElementById('nWalletColorDot'); if(dot) dot.style.background=_ACC_COLORS[_accColorIdx];
}

/* ============================================================
   MODAL OPEN/CLOSE
============================================================ */
// `openModal` / `closeAll` are implemented in `public/legacy/ui.js`.
function hasAccounts(){
  return Array.isArray(UserConfig._accounts) && UserConfig._accounts.length>0;
}
function getDefaultAccountName(){
  const accounts=UserConfig._accounts||[];
  if(!accounts.length) return '';
  const names=accounts.map(a=>a.name);
  if(UserConfig.defaultWallet && names.includes(UserConfig.defaultWallet)) return UserConfig.defaultWallet;
  return accounts[0]?.name || '';
}
function getSecondAccountName(primaryName){
  const accounts=UserConfig._accounts||[];
  const alt=accounts.find(a=>a?.name && a.name!==primaryName);
  return alt?.name || primaryName || '';
}
function openAccountSetup(){
  AppState._lockedModalId='accSetupM';
  openModal('accSetupM');
  setTimeout(()=>{ try{ document.getElementById('accSetupName')?.focus(); }catch(e){} },60);
}
function ensureAccountsOrOnboard(){
  if(hasAccounts()) return true;
  openAccountSetup();
  return false;
}
async function createFirstAccount(){
  const name=document.getElementById('accSetupName')?.value?.trim()||'';
  if(!name){ toast('Inserisci un nome conto','warn'); return; }
  if(UserConfig._accounts?.some(a=>a.name===name)){ toast('Conto gia esistente','warn'); return; }
  const type=document.getElementById('accSetupType')?.value||'checking';
  const initialBalance=parseFloat(document.getElementById('accSetupBal')?.value)||0;
  const color=typeof DatabaseService?.nextColor==='function' ? DatabaseService.nextColor() : '#0066FF';
  const icon=typeof DatabaseService?._iconForType==='function' ? DatabaseService._iconForType(type) : ({checking:'credit-card',savings:'piggy-bank',cash:'banknote',credit:'credit-card',invest:'trending-up'}[type]||'wallet');
  const acc={id:'lac'+Date.now(),name,type,color,icon,initialBalance};
  try{
    await DatabaseService.saveAccount(acc);
    if(!UserConfig.defaultWallet) { UserConfig.defaultWallet=acc.name; saveConfig(); }
    AppState._lockedModalId=null;
    closeAll(true);
    try{ document.getElementById('accSetupName').value=''; }catch(e){}
    try{ document.getElementById('accSetupBal').value=''; }catch(e){}
    populateWalletSel();
    renderWalletSettings();
    renderAll();
    toast('Conto creato ✓','success');
    // First run: prompt Supabase credentials + SQL schema (optional, but requested).
    try{
      if(OFFLINE && !localStorage.getItem('mpxSbOnboardDone')){
        setTimeout(()=>{ try{ openSbOnboard(); }catch(e){} },250);
      }
    }catch(e){}
  }catch(e){
    console.warn('createFirstAccount',e);
    toast('Errore creazione conto','error');
  }
}
function openAdd(){
  if(!ensureAccountsOrOnboard()) return;
  haptic(); AppState.editId=null;
  document.getElementById('mTitle').textContent='Nuovo Movimento';
  document.getElementById('addF').reset();
  document.getElementById('txDate').valueAsDate=new Date();
  try{ const ti=document.getElementById('txTime'); if(ti) ti.value=nowTimeHM(); }catch(e){}
  document.querySelectorAll('.tbtn').forEach(b=>b.classList.remove('on'));
  setFType('expense');
  populateWalletSel();
  openModal('addM');
}
function openCalc(){ haptic(); openModal('calcM'); }
function calcToTx(){
  const v=parseFloat(AppState.calcVal)||parseFloat(AppState.calcDisp)||0;
  if(v>0){
    closeAll(false);
    setTimeout(()=>{
      openAdd();
      const el=document.getElementById('txAmt');
      if(el){ el.value=v.toFixed(2); }
      toast('Importo impostato: '+fmt(v),'success');
    },200);
  } else {
    toast('Inserisci un valore valido','warn');
  }
}
function openBudM(){ haptic(); buildBudgetList(); openModal('budM'); }
function saveBudgets(){
  // budget inputs use onchange → setBudget() already → just close & confirm
  closeAll(); toast('Budget salvati ✓','success'); renderAll();
}
function resetF(){ clearFilters(); }
function setDark(v){ toggleDark(v); }

/* ============================================================
   TYPE TOGGLE
============================================================ */
function setFType(t){
  AppState.fType = t;
  const ob=document.getElementById('btnOut');
  const ib=document.getElementById('btnIn');
  const tb=document.getElementById('btnTr');
  const base='flex:1;padding:.65rem .5rem;font-size:.82rem;font-weight:700;border-radius:.875rem;transition:all .22s;';
  ob.style.cssText=base+'color:var(--t2)';
  ib.style.cssText=base+'color:var(--t2)';
  tb.style.cssText=base+'color:var(--t2)';
  if(t==='expense')  ob.style.cssText=base+'background:var(--card);color:var(--t);box-shadow:0 2px 8px rgba(0,0,0,.1)';
  if(t==='income')   ib.style.cssText=base+'background:var(--ok);color:#fff;box-shadow:0 2px 8px rgba(0,200,150,.3)';
  if(t==='transfer') tb.style.cssText=base+'background:var(--wn);color:#fff;box-shadow:0 2px 8px rgba(255,149,0,.3)';
  const isTransfer=(t==='transfer');
  document.getElementById('accRow').classList.toggle('hidden',isTransfer);
  document.getElementById('transferRow').classList.toggle('hidden',!isTransfer);
  document.getElementById('catRow').classList.toggle('hidden',isTransfer);
  document.getElementById('tagsRow').classList.toggle('hidden',isTransfer);
  document.getElementById('txCat').required=!isTransfer;
  document.getElementById('saveLbl').textContent=isTransfer?'Conferma Trasferimento':'Salva Movimento';
  if(t==='income'){
    document.getElementById('txCat').value='salary';
    setTimeout(()=>renderCatPicker('catPickWrap','txCat'),30);
  }
  if(!isTransfer){
    // refresh account picker to correct selection
    const curAcc=document.getElementById('txAcc')?.value;
    renderAccPicker('accPickWrap','txAcc', curAcc);
  } else {
    renderAccPicker('accFromWrap','txAccFrom');
    renderAccPicker('accToWrap','txAccTo');
  }
  lucide.createIcons();
}

/* ============================================================
   EDIT TX
============================================================ */
function editTx(id){
  haptic();
  const t = AppState.transactions.find(x=>x.id===id);
  if(!t) return;
  AppState.editId = id;
  document.getElementById('mTitle').textContent='Modifica';
  populateWalletSel();
  setFType(t.type||'expense');
  document.getElementById('txAmt').value  = t.amount;
  document.getElementById('txDate').value = t.date;
  try{ const ti=document.getElementById('txTime'); if(ti) ti.value=normTime(t.time)||''; }catch(e){}
  document.getElementById('txDesc').value = t.description||'';
  if(t.type==='transfer'){
    const from=t.account||getDefaultAccountName();
    const to=t.account_to||getSecondAccountName(from);
    document.getElementById('txAccFrom').value = from;
    document.getElementById('txAccTo').value   = to;
    setTimeout(()=>{
      renderAccPicker('accFromWrap','txAccFrom', from);
      renderAccPicker('accToWrap','txAccTo', to);
    },50);
  } else {
    if(t.category_id){
      document.getElementById('txCat').value = t.category_id;
      setTimeout(()=>{ renderCatPicker('catPickWrap','txCat'); },50);
    }
    const acc=t.account||getDefaultAccountName();
    document.getElementById('txAcc').value = acc;
    setTimeout(()=>renderAccPicker('accPickWrap','txAcc', acc),50);
    const savedTags = t.tags ? (typeof t.tags==='string'?JSON.parse(t.tags):t.tags) : [];
    document.querySelectorAll('.tbtn').forEach(b=>b.classList.toggle('on', savedTags.includes(b.dataset.tag)));
  }
  openModal('addM');
}

/* ============================================================
   POPULATE WALLET SELECT
============================================================ */
function populateWalletSel(){
  const accounts=UserConfig._accounts||[];
  const wallets=accounts.map(a=>a.name).filter(Boolean);
  const opts = wallets.map(w=>`<option value="${w}">${w}</option>`).join('');
  const defaultWallet=getDefaultAccountName();
  const defaultTo=getSecondAccountName(defaultWallet);
  if(wallets.length && (!UserConfig.defaultWallet || !wallets.includes(UserConfig.defaultWallet))){
    UserConfig.defaultWallet=defaultWallet;
    saveConfig();
  }
  // Update hidden selects
  ['txAcc','txAccFrom','txAccTo'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.innerHTML=opts; }
  });
  const txAcc=document.getElementById('txAcc');
  if(txAcc) txAcc.value=defaultWallet;
  const txAccFrom=document.getElementById('txAccFrom');
  if(txAccFrom) txAccFrom.value=defaultWallet;
  const txAccTo=document.getElementById('txAccTo');
  if(txAccTo) txAccTo.value=defaultTo;
  const mapAccDef=document.getElementById('mapAccDef');
  if(mapAccDef) mapAccDef.innerHTML=opts;
  const defW=document.getElementById('defWalletS');
  if(defW){
    defW.innerHTML=opts || '<option value=\"\">—</option>';
    defW.value=defaultWallet;
    defW.disabled=!wallets.length;
  }
  // Render visual pill pickers
  renderAccPicker('accPickWrap','txAcc', defaultWallet);
  renderAccPicker('accFromWrap','txAccFrom', defaultWallet);
  renderAccPicker('accToWrap','txAccTo', defaultTo);
  // Render category pills
  renderCatPicker('catPickWrap','txCat');
  // Render icon picker for add wallet form
  renderIconPicker();
}

function renderAccPicker(wrapperId, selectId, defaultVal){
  const wrap=document.getElementById(wrapperId); if(!wrap) return;
  const accounts=UserConfig._accounts||[];
  if(!accounts.length){
    wrap.innerHTML=`<button type="button" onclick="openAccountSetup()" class="w-full py-2.5 rounded-xl text-xs font-bold" style="background:var(--bg2);color:var(--br)">+ Crea un conto</button>`;
    return;
  }
  const curVal=document.getElementById(selectId)?.value||defaultVal||accounts[0]?.name;
  wrap.innerHTML=accounts.map(acc=>{
    const brand=detectBrand(acc.name);
    const iconHtml=brand
      ? `<div class="ap-icon ft-badge" style="background:${FINTECH_BRANDS[brand].bg};font-size:10px">${FINTECH_BRANDS[brand].text}</div>`
      : `<div class="ap-icon" style="background:${acc.color}22"><i data-lucide="${acc.icon||'wallet'}" style="width:13px;height:13px;color:${acc.color}"></i></div>`;
    const isOn=acc.name===curVal;
    return `<div class="acc-pill ${isOn?'on':''}" onclick="selectAccPill('${wrapperId}','${selectId}','${acc.name}',this)">${iconHtml}<span>${acc.name}</span></div>`;
  }).join('');
  lucide.createIcons({scope:wrap});
}

function selectAccPill(wrapperId, selectId, name, el){
  const wrap=document.getElementById(wrapperId);
  wrap?.querySelectorAll('.acc-pill').forEach(p=>p.classList.remove('on'));
  el?.classList.add('on');
  const sel=document.getElementById(selectId);
  if(sel) sel.value=name;
}

function renderCatPicker(wrapperId, selectId){
  const wrap=document.getElementById(wrapperId); if(!wrap) return;
  const curVal=document.getElementById(selectId)?.value||'other';
  wrap.innerHTML=Object.entries(CATS).map(([k,c])=>{
    const emoji=CAT_EMOJI[k]||'🏷';
    const isOn=k===curVal;
    return `<div class="cat-pill ${isOn?'on':''}" onclick="selectCatPill('${wrapperId}','${selectId}','${k}',this)">
      <div class="cp-icon" style="background:${c.bg}">${emoji}</div>
      <span>${c.l}</span>
    </div>`;
  }).join('');
}

function selectCatPill(wrapperId, selectId, key, el){
  const wrap=document.getElementById(wrapperId);
  wrap?.querySelectorAll('.cat-pill').forEach(p=>p.classList.remove('on'));
  el?.classList.add('on');
  const sel=document.getElementById(selectId);
  if(sel) sel.value=key;
}

function renderIconPicker(){
  const grid=document.getElementById('iconPickGrid'); if(!grid) return;
  const curIcon=document.getElementById('nWalletIcon')?.value||'credit-card';
  let html='';
  // Fintech brands section
  html+=`<div style="grid-column:1/-1;font-size:8px;font-weight:800;color:var(--br);text-transform:uppercase;letter-spacing:.06em;padding:2px 0 4px">Fintech</div>`;
  Object.entries(FINTECH_BRANDS).forEach(([key,b])=>{
    let previewHtml = '';
    if (b.localIcon) {
      previewHtml = `<div class="icon-preview ft-badge" style="background:white;padding:2px;border:1px solid var(--bo)"><img src="${b.localIcon}" alt="${b.label}" style="width:100%;height:100%;object-fit:contain;border-radius:4px"></div>`;
    } else {
      previewHtml = `<div class="icon-preview ft-badge" style="background:${b.bg};font-size:10px">${b.text}</div>`;
    }
    html+=`<button type="button" class="icon-pick-btn ${curIcon==='ft:'+key?'selected':''}" onclick="selectAccIcon('ft:${key}',this)" title="${b.label}">
      ${previewHtml}
      <span>${b.label.split(' ')[0]}</span>
    </button>`;
  });
  // Generic icons section
  html+=`<div style="grid-column:1/-1;font-size:8px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.06em;padding:6px 0 4px">Generici</div>`;
  GENERIC_ACC_ICONS.forEach(({ic,label})=>{
    html+=`<button type="button" class="icon-pick-btn ${curIcon===ic?'selected':''}" onclick="selectAccIcon('${ic}',this)" title="${label}">
      <div class="icon-preview" style="background:var(--bg2)"><i data-lucide="${ic}" style="width:14px;height:14px;color:var(--t2)"></i></div>
      <span>${label}</span>
    </button>`;
  });
  grid.innerHTML=html;
  lucide.createIcons({scope:grid});
}

function selectAccIcon(icon, el){
  document.getElementById('iconPickGrid')?.querySelectorAll('.icon-pick-btn').forEach(b=>b.classList.remove('selected'));
  el?.classList.add('selected');
  const inp=document.getElementById('nWalletIcon');
  if(inp) inp.value=icon;
}

/* ============================================================
   RENDER ALL
============================================================ */
let _revealObs=null;
let _revealQueued=false;
function _ensureRevealObs(){
  if(_revealObs) return _revealObs;
  const root=document.getElementById('scroll')||null;
  _revealObs=new IntersectionObserver((entries,obs)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        e.target.classList.add('in');
        obs.unobserve(e.target);
      }
    });
  },{root,threshold:0.08});
  return _revealObs;
}
function scanRevealTargets(){
  const page=document.querySelector('.page.on');
  if(!page) return;
  const obs=_ensureRevealObs();
  const targets=page.querySelectorAll('.card, .sch');
  let i=0;
  targets.forEach(t=>{
    if(t.classList.contains('reveal')) return;
    t.classList.add('reveal');
    t.style.setProperty('--d',`${Math.min(i*55,260)}ms`);
    obs.observe(t);
    i++;
  });
}
function queueRevealScan(){
  if(_revealQueued) return;
  _revealQueued=true;
  requestAnimationFrame(()=>{
    _revealQueued=false;
    try{ scanRevealTargets(); }catch(e){}
  });
}

/* ============================================================
   LAYOUT — user customizable block order (Home / Stats)
============================================================ */
let _DEFAULT_LAYOUT=null;
let _layoutDnDInstalled=false;
let _layoutSaveT=null;

function captureDefaultLayouts(){
  if(_DEFAULT_LAYOUT) return;
  _DEFAULT_LAYOUT={};
  document.querySelectorAll('[data-zone]').forEach(zoneEl=>{
    const zone=zoneEl.dataset.zone;
    if(!zone) return;
    _DEFAULT_LAYOUT[zone]=Array.from(zoneEl.children).map(el=>el?.dataset?.block).filter(Boolean);
  });
}

function _applyOrder(zoneEl, order){
  if(!zoneEl) return;
  const kids=Array.from(zoneEl.children).filter(el=>el?.dataset?.block);
  const map=new Map(kids.map(el=>[el.dataset.block, el]));
  const frag=document.createDocumentFragment();
  const used=new Set();
  (order||[]).forEach(id=>{
    const el=map.get(id);
    if(el){ frag.appendChild(el); used.add(id); }
  });
  kids.forEach(el=>{
    const id=el.dataset.block;
    if(id && !used.has(id)) frag.appendChild(el);
  });
  zoneEl.appendChild(frag);
}

function applyLayouts(){
  if(!UserConfig.layout) return;
  document.querySelectorAll('[data-zone]').forEach(zoneEl=>{
    const zone=zoneEl.dataset.zone;
    const order=UserConfig.layout?.[zone];
    if(Array.isArray(order) && order.length) _applyOrder(zoneEl, order);
  });
  
  // Sync Investment Settings UI
  {
    const chkInc = document.getElementById('setInvInclude');
    if(chkInc) chkInc.checked = UserConfig.investIncludeInTotal !== false;
  }
}

function setLayoutFromDOM(zone){
  const zoneEl=document.querySelector(`[data-zone="${zone}"]`);
  if(!zoneEl) return;
  if(!UserConfig.layout) UserConfig.layout={};
  UserConfig.layout[zone]=Array.from(zoneEl.children).map(el=>el?.dataset?.block).filter(Boolean);
}

function _queueLayoutPersist(){
  clearTimeout(_layoutSaveT);
  _layoutSaveT=setTimeout(()=>{ try{ saveConfig(); }catch(e){} }, 260);
}

function _ensureLayoutBar(){
  let bar=document.getElementById('layoutBar');
  if(bar) return bar;
  bar=document.createElement('div');
  bar.id='layoutBar';
  bar.innerHTML=`
    <div style="display:flex;flex-direction:column;line-height:1.05">
      <span style="font-size:12px;font-weight:900">Modalita Layout</span>
      <span style="font-size:10px;font-weight:700;color:var(--t2)">Trascina i blocchi o usa ↑ ↓</span>
    </div>
    <div style="display:flex;gap:8px">
      <button type="button" class="lbBtn" onclick="resetLayout()">Reset</button>
      <button type="button" class="lbBtn primary" onclick="toggleLayoutMode(false)">Fatto</button>
    </div>
  `;
  document.body.appendChild(bar);
  return bar;
}

function refreshLayoutEditUI(){
  document.querySelectorAll('.blkCtl').forEach(el=>el.remove());
  document.querySelectorAll('[data-block]').forEach(el=>{
    el.draggable=false;
    el.classList.remove('dragging','dragOver');
  });
  if(!AppState.layoutMode) return;
  const page=document.querySelector('.page.on');
  if(!page) return;
  page.querySelectorAll('[data-zone] [data-block]').forEach(block=>{
    const zone=block.closest('[data-zone]')?.dataset?.zone;
    const id=block.dataset.block;
    if(!zone || !id) return;
    block.draggable=true;
    const ctl=document.createElement('div');
    ctl.className='blkCtl';
    ctl.innerHTML=`
      <button type="button" class="blkBtn" title="Sposta su" onclick="layoutMove('${zone}','${id}',-1)"><i data-lucide="chevron-up" class="w-4 h-4"></i></button>
      <button type="button" class="blkBtn" title="Sposta giu" onclick="layoutMove('${zone}','${id}',1)"><i data-lucide="chevron-down" class="w-4 h-4"></i></button>
      <button type="button" class="blkBtn" title="Trascina"><i data-lucide="grip-vertical" class="w-4 h-4"></i></button>
    `;
    block.appendChild(ctl);
  });
  lucide.createIcons({scope:page});
}

function _layoutBump(el){
  if(!el) return;
  el.classList.remove('lbump');
  // Force reflow so the animation restarts.
  void el.offsetWidth;
  el.classList.add('lbump');
  setTimeout(()=>el.classList.remove('lbump'), 380);
}

function enterLayoutMode(){
  captureDefaultLayouts();
  applyLayouts();
  AppState.layoutMode=true;
  document.body.classList.add('layout-edit');
  _ensureLayoutBar();
  refreshLayoutEditUI();
  try{ toast('Modalita layout attiva — trascina o usa ↑ ↓','info'); }catch(e){}
}

function exitLayoutMode(){
  // Persist current visible zones.
  const page=document.querySelector('.page.on');
  if(page){
    page.querySelectorAll('[data-zone]').forEach(z=>{
      const zone=z.dataset.zone;
      if(zone) setLayoutFromDOM(zone);
    });
    _queueLayoutPersist();
  }
  AppState.layoutMode=false;
  document.body.classList.remove('layout-edit');
  refreshLayoutEditUI();
  document.getElementById('layoutBar')?.remove();
  try{ toast('Layout salvato ✓','success'); }catch(e){}
}

function toggleLayoutMode(force){
  const want = (typeof force==='boolean') ? force : !AppState.layoutMode;
  if(want) enterLayoutMode();
  else exitLayoutMode();
}

function layoutMove(zone, blockId, dir){
  if(!zone || !blockId) return;
  haptic();
  const zoneEl=document.querySelector(`[data-zone="${zone}"]`);
  if(!zoneEl) return;
  const el=zoneEl.querySelector(`[data-block="${blockId}"]`);
  if(!el) return;
  if(dir<0){
    const prev=el.previousElementSibling;
    if(prev) zoneEl.insertBefore(el, prev);
  } else if(dir>0){
    const next=el.nextElementSibling;
    if(next) zoneEl.insertBefore(el, next.nextElementSibling);
  }
  _layoutBump(el);
  setLayoutFromDOM(zone);
  _queueLayoutPersist();
}

function resetLayout(zone){
  captureDefaultLayouts();
  const page=document.querySelector('.page.on');
  const zones = zone ? [zone] : Array.from(page?.querySelectorAll('[data-zone]')||[]).map(z=>z.dataset.zone).filter(Boolean);
  if(!zones.length) return;
  zones.forEach(z=>{
    const zoneEl=document.querySelector(`[data-zone="${z}"]`);
    if(!zoneEl) return;
    const ord=_DEFAULT_LAYOUT?.[z];
    if(Array.isArray(ord) && ord.length){
      _applyOrder(zoneEl, ord);
      if(!UserConfig.layout) UserConfig.layout={};
      UserConfig.layout[z]=[...ord];
    } else if(UserConfig.layout) {
      delete UserConfig.layout[z];
    }
  });
  _queueLayoutPersist();
  if(AppState.layoutMode) refreshLayoutEditUI();
}

function installLayoutDnD(){
  if(_layoutDnDInstalled) return;
  _layoutDnDInstalled=true;

  const cleanup=()=>{
    document.querySelectorAll('[data-block].dragging').forEach(x=>x.classList.remove('dragging'));
    document.querySelectorAll('[data-block].dragOver').forEach(x=>x.classList.remove('dragOver'));
    AppState._layoutDrag=null;
    AppState._layoutOverId=null;
  };

  document.addEventListener('dragstart',e=>{
    if(!AppState.layoutMode) return;
    const blk=e.target?.closest?.('[data-block]');
    if(!blk || !blk.draggable) return;
    const zoneEl=blk.closest?.('[data-zone]');
    const zone=zoneEl?.dataset?.zone;
    const id=blk.dataset.block;
    if(!zone || !id) return;
    AppState._layoutDrag={zone,id};
    blk.classList.add('dragging');
    try{
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain', id);
    }catch(err){}
  });

  document.addEventListener('dragover',e=>{
    if(!AppState.layoutMode || !AppState._layoutDrag) return;
    const zoneEl=e.target?.closest?.(`[data-zone="${AppState._layoutDrag.zone}"]`);
    if(!zoneEl) return;
    e.preventDefault();
    const over=e.target?.closest?.('[data-block]');
    if(over){
      if(AppState._layoutOverId && AppState._layoutOverId!==over.dataset.block){
        zoneEl.querySelector(`[data-block="${AppState._layoutOverId}"]`)?.classList.remove('dragOver');
      }
      AppState._layoutOverId=over.dataset.block;
      over.classList.add('dragOver');
    }
  });

  document.addEventListener('drop',e=>{
    if(!AppState.layoutMode || !AppState._layoutDrag) return;
    const {zone,id}=AppState._layoutDrag;
    const zoneEl=e.target?.closest?.(`[data-zone="${zone}"]`);
    if(!zoneEl) return;
    e.preventDefault();
    const dragged=zoneEl.querySelector(`[data-block="${id}"]`);
    if(!dragged){ cleanup(); return; }
    const target=e.target?.closest?.('[data-block]');
    if(target && target!==dragged){
      const rect=target.getBoundingClientRect();
      const after=e.clientY > rect.top + rect.height/2;
      if(after) zoneEl.insertBefore(dragged, target.nextElementSibling);
      else zoneEl.insertBefore(dragged, target);
    } else {
      zoneEl.appendChild(dragged);
    }
    _layoutBump(dragged);
    setLayoutFromDOM(zone);
    _queueLayoutPersist();
    cleanup();
  });

  document.addEventListener('dragend',()=>{ if(AppState.layoutMode) cleanup(); });
}

function renderAll(section){
  if(section==='dash') { try{ updateDash(); }catch(e){} return; }
  if(section==='list') { try{ renderList(); }catch(e){} return; }
  if(section==='stats') { try{ renderCharts(); }catch(e){} return; }
  
  try{ updateDash(); }catch(e){ console.warn('updateDash error',e); }
  try{ renderList(); }catch(e){ console.warn('renderList error',e); }
  try{ renderCharts(); }catch(e){ console.warn('renderCharts error',e); }
  try{ renderAchievements(); }catch(e){}
  try{ renderRecurringBadge(); }catch(e){}
  try{ queueRevealScan(); }catch(e){}
}

/* ============================================================
   UPDATE DASHBOARD
============================================================ */
function updateDash(){
  const year  = AppState.viewDate.getFullYear();
  const month = AppState.viewDate.getMonth();
  const dim   = new Date(year,month+1,0).getDate();

  // wallet balances — start from initialBalance for each account
  const accounts=UserConfig._accounts||[];
  const wB={};
  accounts.forEach(a=>{ if(a?.name) wB[a.name]=+a.initialBalance||0; });

  AppState.transactions.forEach(t=>{
    const a=+t.amount||0;
    const w=String(t.account||'').trim();
    if(!w) return;
    if(wB[w]===undefined) wB[w]=0;
    if(t.type==='transfer'){
      wB[w]-=a;
      const to=String(t.account_to||'').trim();
      if(to){
        if(wB[to]===undefined) wB[to]=0;
        wB[to]+=a;
      }
    } else {
      wB[w]+= t.type==='expense'?-a:a;
    }
  });

  // Patrimonio netto (conti) = somma di tutti i saldi dei conti
  const totalNet=Object.values(wB).reduce((s,v)=>s+v,0);

  // Investimenti: valore corrente (convertito in valuta principale)
  let investValue=0;
  try{
    const invs=UserConfig.investments||[];
    const quotes=AppState.investQuotes||{};
    invs.forEach(inv=>{
      if(inv.includeInTotal===false) return;
      const sym=(inv.symbol||'').toUpperCase();
      const q=quotes[sym];
      const price=q && typeof q.price==='number' ? q.price : null;
      if(!price) return;
      const qty=+inv.quantity||0;
      if(qty<=0) return;
      const valInInvCurr=price*qty;
      const invCurr=(inv.currency||'EUR').toUpperCase();
      investValue+=convertToMainCurrency(valInInvCurr,invCurr);
    });
  }catch(e){}

  const includeInv = UserConfig.investIncludeInTotal!==false;
  const effectiveNet = includeInv ? (totalNet + investValue) : totalNet;

  // month transactions
  const mTxs = AppState.transactions.filter(t=>{
    const d=new Date(t.date+'T12:00');
    return d.getMonth()===month && d.getFullYear()===year && t.type!=='transfer';
  });
  const totalIncome  = mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const totalExpense = mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const savingsRate   = savingsRateFor(AppState.transactions, AppState.viewDate);

  // hero balance
  const balEl = document.getElementById('uiBal');
  if(balEl){
    const show = UserConfig.showBalance;
    balEl.textContent = show ? fmtFull(effectiveNet) : '••••••';
    balEl.style.filter = show ? 'none' : 'blur(8px)';
  }
  setEl('uiIn',  fmtShort(totalIncome));
  setEl('uiOut', fmtShort(totalExpense));
  setEl('uiSav', savingsRate>0 ? savingsRate.toFixed(0)+'%' : '0%');

  // month label
  setEl('monthLbl', AppState.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'}));

  // health score
  renderHealthScore(savingsRate, totalIncome, totalExpense);
  renderWallets(wB, totalNet);
  updateGoal(effectiveNet);
  renderBudgetMini(mTxs);
  renderForecast(mTxs, totalExpense, totalIncome, dim);
  renderInsights(mTxs, totalIncome, totalExpense, savingsRate);
  renderQuickStats(mTxs, totalExpense);
  renderSparkline(year, month);
  renderRecentTxs();
  try{ renderDebtsMini(); }catch(e){}
  try{ renderSubsMini(); }catch(e){}
  try{ renderInvestMini(investValue, includeInv ? effectiveNet : null); }catch(e){}

  // savings rate gauge (stats tab)
  setEl('savingsRatePct', savingsRate>0?savingsRate+'%':'0%');
  setEl('savingsRatePctRing', savingsRate>0?savingsRate+'%':'0%');
  setEl('savingsRateLbl', savingsRate>30?'Ottimo risparmio 💪':savingsRate>10?'Risparmio nella media':savingsRate>0?'Risparmio basso':'Nessun risparmio');
  const savingsRateRing=document.getElementById('savingsRateRing');
  if(savingsRateRing){
    const dash=parseFloat(savingsRateRing.getAttribute('stroke-dasharray')||'226')||226;
    setTimeout(()=>{const p=Math.max(0,Math.min(100,savingsRate));savingsRateRing.style.strokeDashoffset=dash-(p/100)*dash;},200);
  }

  // trend badge vs prev month
  const prevDate=new Date(year,month-1,1);
  const prevOut=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===prevDate.getMonth()&&d.getFullYear()===prevDate.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const trendPEl=document.getElementById('trendP');
  if(trendPEl&&prevOut>0){
    const diff=Math.round((totalExpense-prevOut)/prevOut*100);
    trendPEl.textContent=(diff>0?'+':'')+diff+'%';
    trendPEl.style.background=diff>0?'rgba(255,59,92,.18)':'rgba(0,200,150,.18)';
    trendPEl.style.color=diff>0?'var(--bd)':'var(--ok)';
  }
}

/* ============================================================
   HELPERS
============================================================ */
function setEl(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function fmt(n){ return (UserConfig.currency||'€')+' '+parseFloat(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtFull(n){ return (UserConfig.currency||'€')+' '+parseFloat(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtShort(n){
  const abs=Math.abs(parseFloat(n));
  if(abs>=1000000) return (UserConfig.currency||'€')+' '+(abs/1000000).toFixed(1)+'M';
  if(abs>=1000) return (UserConfig.currency||'€')+' '+(abs/1000).toFixed(1)+'k';
  return (UserConfig.currency||'€')+' '+abs.toLocaleString('it-IT',{minimumFractionDigits:0,maximumFractionDigits:0});
}
function td(){ return fmtDate(new Date()).replace(/-/g,''); }
function download(blob, name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
function haptic(){ if(navigator.vibrate) navigator.vibrate(8); }
function savingsRateFor(txs, d){
  const m=d.getMonth(), y=d.getFullYear();
  const mx=txs.filter(t=>{const dd=new Date(t.date+'T12:00');return dd.getMonth()===m&&dd.getFullYear()===y&&t.type!=='transfer';});
  const inc=mx.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const exp=mx.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  return inc>0 ? Math.round((1-exp/inc)*100) : 0;
}

/* ============================================================
   QUICK DATE SHORTCUTS
============================================================ */
function setqd(offset){
  const d=new Date(); d.setDate(d.getDate()+offset);
  document.getElementById('txDate').valueAsDate=d; haptic();
}
function qadd(n){
  const el=document.getElementById('txAmt');
  el.value=(parseFloat(el.value)||0)+n; haptic();
}
function autocat(){
  const desc = document.getElementById('txDesc').value.toLowerCase();
  const sel  = document.getElementById('txCat');
  for(const [k,c] of Object.entries(CATS)){
    if(c.kw.some(kw=>desc.includes(kw))){ sel.value=k; break; }
  }
}
function toggleTag(btn){ btn.classList.toggle('on'); haptic(); }

/* ============================================================
   GREETING
============================================================ */
function setGreeting(){
  const h=new Date().getHours();
  const g=h<5?'Buonanotte':h<12?'Buongiorno':h<17?'Buon pomeriggio':h<21?'Buonasera':'Buonanotte';
  setEl('greet', g);
  setEl('dateLbl', new Date().toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'}));
}

/* ============================================================
   HEALTH SCORE
============================================================ */
function renderHealthScore(savingsRate, totalIncome, totalExpense){
  let score=50;
  if(savingsRate>30) score+=20; else if(savingsRate>0) score+=10; else if(savingsRate<0) score-=20;
  if(totalIncome>totalExpense*1.3) score+=15;
  const bOver = Object.entries(UserConfig.budgets||{}).filter(([cat,lim])=>{
    const sp=AppState.transactions.filter(t=>t.category_id===cat&&t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
    return +sp > +lim;
  }).length;
  score -= bOver*10;
  if(UserConfig.goalVal) score+=5;
  score=Math.max(0,Math.min(100,score));
  const grade=score>=90?'A+':score>=80?'A':score>=70?'B':score>=60?'C':score>=50?'D':'F';
  const col=score>=70?'var(--ok)':score>=50?'var(--wn)':'var(--bd)';
  setEl('hScore',score);
  const hGrade=document.getElementById('hGrade');
  if(hGrade){hGrade.textContent=grade;hGrade.style.color=col;}
  const hBar=document.getElementById('hRing');
  if(hBar){setTimeout(()=>{hBar.style.strokeDashoffset=188-(score/100)*188;hBar.style.stroke=col;},120);}
  setEl('hLbl', score>=80?'Ottima salute finanziaria 💪':score>=60?'Finanze nella media':'Attenzione richiesta ⚠️');
}

/* ============================================================
   QUICK STATS
============================================================ */
function renderQuickStats(mTxs, totalExpense){
  const expenses = mTxs.filter(t=>t.type==='expense');
  const today=new Date().getDate();
  setEl('sAvg', today>0 ? fmtShort(totalExpense/today) : '—');
  const maxT = expenses.reduce((best,t)=>+t.amount>best?+t.amount:best,0);
  setEl('sMax', maxT>0 ? fmtShort(maxT) : '—');
  setEl('sNum', mTxs.length);
}

/* ============================================================
   SPARKLINE
============================================================ */
function renderSparkline(year, month){
  const canvas=document.getElementById('sparkC');
  if(!canvas) return;
  const dim=new Date(year,month+1,0).getDate();
  const days=Array.from({length:dim},(_,i)=>i+1);
  
  // Start with total balance before this month
  const startMonthStr = fmtDate(new Date(year, month, 1));
  let running = 0;
  if(UserConfig._accounts) UserConfig._accounts.forEach(a => running += +a.initialBalance || 0);
  AppState.transactions.filter(t => t.date < startMonthStr && t.type !== 'transfer').forEach(t => {
    running += t.type === 'income' ? +t.amount : -+t.amount;
  });

  const vals=days.map(d=>{
    const day=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    AppState.transactions.filter(t=>t.date===day&&t.type!=='transfer').forEach(t=>running+=t.type==='income'?+t.amount:-+t.amount);
    return running;
  });
  if(AppState.charts.spark) AppState.charts.spark.destroy();
  const ctx=canvas.getContext('2d');
  const pos=vals[vals.length-1]>=0;
  const col=pos?'rgba(0,200,150,.8)':'rgba(255,59,92,.8)';
  
  AppState.charts.spark=new Chart(ctx,{
    type:'line',
    data:{labels:days,datasets:[{data:vals,borderColor:col,borderWidth:2,pointRadius:0,fill:true,backgroundColor:col.replace('.8','.12'),tension:.4}]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation: { duration: 800 },
      plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{x:{display:false},y:{display:false}}
    }
  });
}

/* ============================================================
   RECENT TXS (home)
============================================================ */
function renderRecentTxs(){
  const el=document.getElementById('recentList');
  if(!el) return;
  const recent=[...AppState.transactions].sort(cmpTxDTDesc).slice(0,5);
  el.innerHTML=recent.length ? txItems(recent,false) : emptyEl('Nessun movimento ancora');
  lucide.createIcons();
}

/* ============================================================
   TX ITEM RENDERER
============================================================ */
function txItems(txs, actions=false){
  const sorted=[...txs].sort(cmpTxDTDesc);
  return sorted.map((t,i)=>{
    const isTransfer=(t.type==='transfer');
    const c = isTransfer
      ? {l:'Trasferimento',ic:'arrow-right-left',col:'#FF9500',bg:'rgba(255,149,0,.12)'}
      : (Categories[t.category_id]||Categories.other);
    const amtCol = t.type==='expense'?'var(--bd)':t.type==='income'?'var(--ok)':'var(--wn)';
    const sign   = t.type==='expense'?'−':t.type==='income'?'+':'⇄';
    const dStr   = new Date(t.date+'T12:00').toLocaleDateString('it-IT',{day:'2-digit',month:'short'});
    const timeStr=normTime(t.time);
    const acc    = String(t.account||'').trim() || getDefaultAccountName();
    const accObj = UserConfig._accounts?.find(a=>a.name===acc);
    const brand  = detectBrand(acc);
    const accBadge = brand ? `<span class="ft-badge" style="width:14px;height:14px;border-radius:4px;background:${FINTECH_BRANDS[brand].bg};font-size:6px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:2px;vertical-align:middle;flex-shrink:0">${FINTECH_BRANDS[brand].text}</span>` : '';
    const title  = t.description || c.l;
    const subCat = t.description ? c.l : '';
    const accLbl = acc || 'Senza conto';
    const subAcc = isTransfer ? `${accLbl} → ${t.account_to||'?'}` : accLbl;
    const subtitle = [dStr, timeStr, subCat, subAcc].filter(Boolean).join(' · ');
    let tags='';
    if(!isTransfer && t.tags){
      try{
        const arr=typeof t.tags==='string'?JSON.parse(t.tags):t.tags;
        tags=arr.filter(Boolean).map(tag=>`<span style="background:var(--bg2);color:var(--t2);border-radius:.4rem;padding:.1rem .45rem;font-size:.63rem;font-weight:700">${tag}</span>`).join('');
      }catch(e){}
    }
    const act=actions?`
      <div class="act-row flex gap-1 mt-2 pt-2 border-t justify-end" style="border-color:var(--bo)">
        <button onclick="editTx('${t.id}')" style="background:rgba(0,102,255,.1);color:var(--br);border-radius:.7rem;padding:.35rem;line-height:1"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
        <button onclick="saveAsTemplate('${t.id}')" style="background:rgba(124,58,237,.1);color:var(--acc);border-radius:.7rem;padding:.35rem;line-height:1"><i data-lucide="bookmark" class="w-3.5 h-3.5"></i></button>
        <button onclick="dupTx('${t.id}')" style="background:rgba(255,149,0,.1);color:var(--wn);border-radius:.7rem;padding:.35rem;line-height:1"><i data-lucide="copy" class="w-3.5 h-3.5"></i></button>
        <button onclick="deleteTx('${t.id}')" style="background:rgba(255,59,92,.1);color:var(--bd);border-radius:.7rem;padding:.35rem;line-height:1"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>`:'';
    return `<div class="txRow py-3 px-3 border-b last:border-0 rounded-xl" style="border-color:var(--bo);transition:background .15s" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''" onclick="this.querySelector('.act-row')&&(this.querySelector('.act-row').style.display=this.querySelector('.act-row').style.display==='flex'?'none':'flex')" ontouchend="this.querySelector('.act-row')&&(this.querySelector('.act-row').style.display=this.querySelector('.act-row').style.display==='flex'?'none':'flex')">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:${c.bg}">
          <i data-lucide="${c.ic}" class="w-4 h-4" style="color:${c.col}"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm leading-tight truncate">${title}</p>
          <p class="text-[10px] mt-0.5 truncate flex items-center" style="color:var(--t2)">${accBadge}${subtitle}</p>
          ${tags?`<div class="flex gap-1 mt-1 flex-wrap">${tags}</div>`:''}
        </div>
        <p class="font-black text-sm whitespace-nowrap" style="color:${amtCol};font-variant-numeric:tabular-nums">${sign}${fmt(t.amount)}</p>
      </div>
      ${act}
    </div>`;
  }).join('');
}

function emptyEl(msg){
  return `<div class="py-12 text-center flex flex-col items-center opacity-50">
    <div class="w-14 h-14 rounded-full flex items-center justify-center mb-3" style="background:var(--bg2)"><i data-lucide="ghost" class="w-7 h-7" style="color:var(--t2)"></i></div>
    <p class="text-sm font-bold" style="color:var(--t2)">${msg}</p>
  </div>`;
}

/* ============================================================
   LIST (tab Conti)
============================================================ */
function renderList(){
  const el=document.getElementById('txList');
  if(!el) return;
  const q     = (document.getElementById('sQ')?.value||'').toLowerCase();
  const sort  = document.getElementById('sortS')?.value||'date-desc';
  const fFrom = document.getElementById('fFrom')?.value||'';
  const fTo   = document.getElementById('fTo')?.value||'';
  const fMin  = parseFloat(document.getElementById('fMin')?.value)||0;
  const fMax  = parseFloat(document.getElementById('fMax')?.value)||Infinity;
  const fCat  = document.getElementById('fCat')?.value||'';

  let filtered = AppState.transactions.filter(t=>{
    const mt = (t.description||'').toLowerCase().includes(q)||(Categories[t.category_id]?.l||'').toLowerCase().includes(q);
    const txAcc = String(t.account||'').trim() || getDefaultAccountName();
    const mw = AppState.wFilter==='all'||txAcc===AppState.wFilter||(t.type==='transfer'&&t.account_to===AppState.wFilter);
    const mty= AppState.txFilter==='all'||t.type===AppState.txFilter;
    const mFr= !fFrom||t.date>=fFrom;
    const mTo= !fTo||t.date<=fTo;
    const mA = +t.amount>=fMin&&+t.amount<=fMax;
    const mC = !fCat||t.category_id===fCat;
    return mt&&mw&&mty&&mFr&&mTo&&mA&&mC;
  });

  filtered.sort((a,b)=>{
    if(sort==='date-desc') return cmpTxDTDesc(a,b);
    if(sort==='date-asc')  return cmpTxDTAsc(a,b);
    if(sort==='amt-desc')  return +b.amount - +a.amount;
    if(sort==='amt-asc')   return +a.amount - +b.amount;
    return 0;
  });

  setEl('txCnt', filtered.length+' mov.');
  el.innerHTML = filtered.length ? txItems(filtered,true) : emptyEl('Nessun movimento trovato');
  lucide.createIcons();
}

/* ============================================================
   WALLETS
============================================================ */
function renderWallets(wB, totalNet){
  const el=document.getElementById('wDash');
  if(!el) return;
  const accounts=UserConfig._accounts||[];
  if(!accounts.length){
    el.innerHTML=`<div class="card p-4 w-full" style="min-width:260px">
      <p class="text-xs font-bold" style="color:var(--t2)">Nessun conto configurato.</p>
      <button onclick="openAccountSetup()" class="mt-2 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest" style="background:rgba(0,102,255,.1);color:var(--br)">Crea conto</button>
    </div>`;
    return;
  }
  el.innerHTML=`
    <div onclick="filterWallet('all')" class="wc flex-shrink-0 w-36 card p-4 border cursor-pointer" style="border-color:${AppState.wFilter==='all'?'var(--br)':'var(--bo)'}">
      <p class="text-[9px] font-bold uppercase tracking-wider mb-2" style="color:var(--t2)"><i data-lucide="layout-grid" class="w-3 h-3 inline mr-1"></i>Tutti</p>
      <p class="text-xl font-black" style="font-variant-numeric:tabular-nums;color:${totalNet<0?'var(--bd)':'var(--t)'}">${fmtShort(totalNet)}</p>
    </div>`+accounts.map(acc=>{
      const bal=wB[acc.name]??0;
      return `<div onclick="filterWallet('${acc.name}')" class="wc flex-shrink-0 w-36 card p-4 border cursor-pointer" style="border-color:${AppState.wFilter===acc.name?acc.color:'var(--bo)'}">
        <p class="text-[9px] font-bold uppercase tracking-wider mb-2 truncate" style="color:${acc.color}">
          <i data-lucide="${acc.icon||'wallet'}" class="w-3 h-3 inline mr-1"></i>${acc.name}
        </p>
        <p class="text-xl font-black" style="font-variant-numeric:tabular-nums;color:${bal<0?'var(--bd)':'var(--t)'}">${fmtShort(bal)}</p>
      </div>`;
    }).join('')+'';
  // brand icons for wallets
  el.innerHTML = el.innerHTML; // refresh handled below
  const accounts2=accounts;
  // Re-render with brand icons
  const existing = el.children;
  Array.from(existing).slice(1).forEach((card,i)=>{
    const acc=accounts2[i]; if(!acc) return;
    const brand=detectBrand(acc.name);
    if(brand){
      const p=card.querySelector('p');
      if(p && !p.querySelector('.ft-badge')){
        const badge=document.createElement('span');
        badge.className='ft-badge';
        badge.style.cssText=`width:16px;height:16px;border-radius:4px;background:${FINTECH_BRANDS[brand].bg};font-size:7px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:4px;vertical-align:middle`;
        badge.textContent=FINTECH_BRANDS[brand].text;
        p.insertBefore(badge, p.firstChild);
        const oldIcon=p.querySelector('i[data-lucide]');
        if(oldIcon) oldIcon.remove();
      }
    }
  });
  lucide.createIcons();
}
function filterWallet(w){ haptic(); AppState.wFilter=w; updateDash(); renderList(); }

/* ============================================================
   GOAL
============================================================ */
function updateGoal(net){
  const gb=document.getElementById('goalBox');
  if(!gb) return;
  if(UserConfig.goalVal&&parseFloat(UserConfig.goalVal)>0){
    gb.classList.remove('hidden');
    setEl('gName', UserConfig.goalName||'Obiettivo');
    const p=Math.max(0,Math.min(100,(net/parseFloat(UserConfig.goalVal))*100));
    setEl('gPct', Math.round(p)+'%');
    setEl('gAmt', `${fmt(Math.max(0,net))} / ${fmt(UserConfig.goalVal)}`);
    setTimeout(()=>{ const b=document.getElementById('gBar'); if(b) b.style.width=p+'%'; },120);
    if(p>=100) launchConfetti();
  } else gb.classList.add('hidden');
}

/* ============================================================
   BUDGET MINI
============================================================ */
function renderBudgetMini(mTxs, targetId='budMini'){
  const bl=document.getElementById(targetId);
  if(!bl) return;
  if(!Object.keys(UserConfig.budgets||{}).length){
    bl.innerHTML=`<p class="text-sm text-center py-1" style="color:var(--t2)">Nessun budget. <button onclick="openBudM()" class="font-bold underline" style="color:var(--br)">Imposta ora</button></p>`;
    return;
  }
  bl.innerHTML=Object.entries(UserConfig.budgets).map(([cat,lim])=>{
    const c=Categories[cat]; if(!c) return '';
    const sp=mTxs.filter(t=>t.category_id===cat&&t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
    const p=Math.min(100,Math.round(sp/+lim*100));
    const col=p>=100?'var(--bd)':p>=80?'var(--wn)':'var(--ok)';
    return `<div><div class="flex justify-between items-center mb-1">
      <div class="flex items-center gap-1.5"><div class="w-2 h-2 rounded-full" style="background:${c.col}"></div><span class="text-xs font-bold">${c.l}</span></div>
      <span class="text-xs font-bold" style="color:${col}">${fmt(sp)} / ${fmt(lim)}</span>
    </div><div class="w-full h-1.5 rounded-full overflow-hidden" style="background:var(--bg2)">
      <div class="h-full rounded-full" style="width:${p}%;background:${col};transition:width 1s ease"></div>
    </div></div>`;
  }).join('');
}

/* ============================================================
   FORECAST
============================================================ */
function renderForecast(mTxs, totalExpense, totalIncome, dim){
  const fb=document.getElementById('forecastBox');
  if(!fb) return;
  const today=new Date();
  if(today.getMonth()!==AppState.viewDate.getMonth()||today.getFullYear()!==AppState.viewDate.getFullYear()||today.getDate()<3){fb.classList.add('hidden');return;}
  fb.classList.remove('hidden');
  const daily=totalExpense/today.getDate();
  const proj=totalExpense+daily*(dim-today.getDate());
  const pct=totalIncome>0?Math.min(100,Math.round(proj/totalIncome*100)):0;
  setEl('foreAmt', fmt(proj));
  setEl('forePct', pct+'%');
  setEl('foreNote', proj>totalIncome?`⚠️ ${fmt(proj-totalIncome)} sopra le entrate`:`✅ ${fmt(totalIncome-proj)} sotto le entrate`);
  setTimeout(()=>{ const r=document.getElementById('foreRing'); if(r) r.style.strokeDashoffset=176-(pct/100)*176; },120);
}

/* ============================================================
   INSIGHTS
============================================================ */
function renderInsights(mTxs, totalIncome, totalExpense, savingsRate){
  const list=[];
  const exp=mTxs.filter(t=>t.type==='expense');
  if(exp.length){
    const cats={};
    exp.forEach(t=>{ cats[t.category_id]=(cats[t.category_id]||0)+ +t.amount; });
    const topCat=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];
    if(topCat) list.push({e:'📊',t:`Top categoria: <b>${Categories[topCat[0]]?.l||topCat[0]}</b> — ${fmt(topCat[1])}`});
  }
  
  if(totalExpense > totalIncome && totalIncome > 0) list.push({e:'⚠️', t:`Attenzione: le uscite superano le entrate di <b>${fmt(totalExpense-totalIncome)}</b>.`});
  if(savingsRate > 40) list.push({e:'🚀', t:`Risparmio incredibile! Hai messo da parte il <b>${savingsRate}%</b>.`});
  else if(savingsRate > 20) list.push({e:'✅', t:`Buon tasso di risparmio (<b>${savingsRate}%</b>). Continua così!`});
  
  const avgDay = totalExpense / (new Date().getDate()||1);
  list.push({e:'📅',t:`Media giornaliera: <b>${fmt(avgDay)}</b>.`});
  
  const tips = [
    "Usa i template per velocizzare l'inserimento!",
    "Controlla i tuoi abbonamenti per risparmiare.",
    "Imposta un budget per le categorie più costose.",
    "Il Cloud Sync tiene i tuoi dati al sicuro.",
    "Prova la visualizzazione a 3 mesi per trend più chiari."
  ];
  list.push({e:'💡', t: tips[Math.floor(Math.random()*tips.length)]});

  const el=document.getElementById('insList');
  if(el) el.innerHTML=list.slice(0,3).map(i=>`<div class="flex items-start gap-2.5 py-2.5 border-b last:border-0" style="border-color:var(--bo)"><span class="text-lg">${i.e}</span><p class="text-sm leading-snug">${i.t}</p></div>`).join('');
  const elFull=document.getElementById('insDeep');
  if(elFull) elFull.innerHTML=list.map(i=>`<div class="flex items-start gap-2.5 py-3 border-b last:border-0" style="border-color:var(--bo)"><span class="text-xl">${i.e}</span><p class="text-sm leading-snug">${i.t}</p></div>`).join('');
}

/* ============================================================
   CHARTS
============================================================ */
function renderCharts(){
  const p=AppState.period||'month';
  const base=new Date(AppState.viewDate.getFullYear(),AppState.viewDate.getMonth(),1);
  const baseYear=base.getFullYear();
  const baseMonth=base.getMonth();

  const winMonths = p==='quarter'?3 : p==='year'?12 : 1;
  const winStart  = new Date(baseYear, baseMonth-(winMonths-1), 1);
  const winEnd    = new Date(baseYear, baseMonth+1, 0);
  const startStr  = fmtDate(winStart);
  const endStr    = fmtDate(winEnd);

  const winTxs=AppState.transactions.filter(t=>t.type!=='transfer' && t.date>=startStr && t.date<=endStr);
  const winInc=winTxs.filter(t=>t.type==='income');
  const winExp=winTxs.filter(t=>t.type==='expense');

  const periodLbl=p==='quarter'?'3 mesi':p==='year'?'anno':'mese';
  setEl('statPeriodLbl2', periodLbl.charAt(0).toUpperCase()+periodLbl.slice(1));

  // ── HERO & KPI ──
  const incTotal = winInc.reduce((s,t)=>s+ +t.amount,0);
  const expTotal = winExp.reduce((s,t)=>s+ +t.amount,0);
  const savingsRate       = incTotal>0 ? Math.round((1-expTotal/incTotal)*100) : 0;

  const netTotal=incTotal-expTotal;
  setEl('heroNet', fmt(netTotal));
  setEl('heroInc', fmt(incTotal));
  setEl('heroExp', fmt(expTotal));
  
  const srRingHero=document.getElementById('srRingHero');
  if(srRingHero){
    const dash=144;
    const pp=Math.max(0,Math.min(100,savingsRate));
    srRingHero.style.strokeDashoffset=dash-(pp/100)*dash;
    setEl('srPctHero', savingsRate+'%');
  }

  const daysWin=Math.max(1, Math.round((new Date(endStr+'T12:00')-new Date(startStr+'T12:00'))/(1000*60*60*24))+1);
  const avgDay=expTotal/daysWin;
  setEl('statAvgDay', expTotal>0?fmtShort(avgDay):'—');

  // Avg trend vs previous window (same length)
  const prevEnd=new Date(baseYear, baseMonth-winMonths+1, 0);
  const prevStart=new Date(baseYear, baseMonth-(2*winMonths-1), 1);
  const prevStartStr=fmtDate(prevStart);
  const prevEndStr=fmtDate(prevEnd);
  const prevExpTotal=AppState.transactions.filter(t=>t.type==='expense' && t.date>=prevStartStr && t.date<=prevEndStr).reduce((s,t)=>s+ +t.amount,0);
  const prevDaysWin=Math.max(1, Math.round((new Date(prevEndStr+'T12:00')-new Date(prevStartStr+'T12:00'))/(1000*60*60*24))+1);
  const prevAvg=prevExpTotal/prevDaysWin;
  const diffPct=prevAvg>0 ? Math.round((avgDay-prevAvg)/prevAvg*100) : 0;
  const trEl=document.getElementById('statAvgTrend');
  if(trEl){
    const sym=diffPct>0?'▴':'▾';
    trEl.textContent=`${sym} ${Math.abs(diffPct)}% vs prec.`;
    trEl.className=`tp mt-1 ${diffPct>0?'bg-red-500/10 text-red-500':'bg-green-500/10 text-green-500'}`;
  }
  
  const catTotals={};
  winExp.forEach(t=>{catTotals[t.category_id]=(catTotals[t.category_id]||0)+ +t.amount;});
  const topCat=Object.entries(catTotals).sort((a,b)=>b[1]-a[1])[0]||null;

  // ── INSIGHTS ──
  const insights = [];
  if(expTotal > prevExpTotal && prevExpTotal > 0) insights.push(`Stai spendendo il ${Math.abs(diffPct)}% in più rispetto al periodo precedente.`);
  else if(expTotal < prevExpTotal) insights.push(`Ottimo! Spese ridotte del ${Math.abs(diffPct)}% rispetto al periodo scorso.`);
  
  const topCatObj = topCat ? Categories[topCat[0]] : null;
  if(topCatObj) insights.push(`La tua spesa maggiore è stata in ${topCatObj.l} (${fmt(topCat[1])}).`);
  if(savingsRate > 30) insights.push(`Risparmio eccellente del ${savingsRate}%! Continua così.`);
  
  setEl('ins1', insights[0] || 'Nessun trend rilevante rilevato al momento.');
  setEl('ins2', insights[1] || 'Monitora le tue categorie per ottimizzare il budget.');

  setEl('statTopCat', topCat ? (Categories[topCat[0]]?.l||topCat[0]) : '—');
  setEl('statTopAmt', topCat ? fmt(topCat[1]) : '—');
  setEl('statTxCount', winTxs.length);

  // ── Chart 1: daily balance (base month) ──
  const dim = new Date(baseYear, baseMonth + 1, 0).getDate();
  const days = Array.from({ length: dim }, (_, i) => i + 1);
  
  // Start with total balance before this month
  const startMonthStr = fmtDate(new Date(baseYear, baseMonth, 1));
  let running = 0;
  // Initial account balances
  if(UserConfig._accounts) UserConfig._accounts.forEach(a => running += +a.initialBalance || 0);
  // Transactions before this month
  AppState.transactions.filter(t => t.date < startMonthStr && t.type !== 'transfer').forEach(t => {
    running += t.type === 'income' ? +t.amount : -+t.amount;
  });

  const balVals = days.map(d => {
    const day = `${baseYear}-${String(baseMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    AppState.transactions.filter(t => t.date === day && t.type !== 'transfer').forEach(t => {
      running += t.type === 'income' ? +t.amount : -+t.amount;
    });
    return running;
  });

  const ctxLine = document.getElementById('cLine')?.getContext('2d');
  let gradientLine = 'var(--br)';
  if (ctxLine) {
    gradientLine = ctxLine.createLinearGradient(0, 0, 0, 220);
    gradientLine.addColorStop(0, resolveCol('rgba(0,102,255,0.2)'));
    gradientLine.addColorStop(1, 'rgba(0,102,255,0)');
  }
  
  makeChart('cLine', 'line', {
    labels: days,
    datasets: [{
      label: 'Saldo',
      data: balVals,
      borderColor: resolveCol('var(--br)'),
      backgroundColor: gradientLine,
      fill: true,
      tension: 0.45,
      pointRadius: 0,
      borderWidth: 3,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: resolveCol('var(--br)'),
      pointHoverBorderColor: '#fff',
      pointHoverBorderWidth: 2
    }]
  }, {
    scales: {
      y: {
        ticks: { color: resolveCol('var(--t3)'), font: { size: 10, weight: '600' }, callback: v => fmtShort(v) },
        grid: { color: resolveCol('rgba(0,0,0,0.03)'), drawBorder: false }
      },
      x: {
        ticks: { color: resolveCol('var(--t3)'), font: { size: 10, weight: '600' } },
        grid: { display: false }
      }
    }
  });

  // ── Chart 2: 6-month income vs expense ──
  const mLabels = [];
  const mInc = [];
  const mExp = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(baseYear, baseMonth - i, 1);
    mLabels.push(d.toLocaleDateString('it-IT', { month: 'short' }));
    const start = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1));
    const end = fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const mtxs = AppState.transactions.filter(t => t.type !== 'transfer' && t.date >= start && t.date <= end);
    mInc.push(mtxs.filter(t => t.type === 'income').reduce((s, t) => s + +t.amount, 0));
    mExp.push(mtxs.filter(t => t.type === 'expense').reduce((s, t) => s + +t.amount, 0));
  }

  makeChart('c6m', 'bar', {
    labels: mLabels,
    datasets: [
      { label: 'Entrate', data: mInc, backgroundColor: resolveCol('var(--ok)'), borderRadius: 6, barThickness: 10 },
      { label: 'Uscite', data: mExp, backgroundColor: resolveCol('var(--bd)'), borderRadius: 6, barThickness: 10 }
    ]
  }, {
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: { display: false },
      x: { grid: { display: false }, ticks: { color: resolveCol('var(--t2)'), font: { size: 10, weight: '700' } } }
    }
  });

  // ── Chart 3: Donut ──
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const donutTotalEl = document.getElementById('donutTotal');
  if (donutTotalEl) donutTotalEl.textContent = fmtShort(expTotal);
  
  const donutColors = catEntries.map(([k]) => Categories[k]?.col || '#888');

  makeChart('cDonut', 'doughnut', {
    labels: catEntries.map(([k]) => Categories[k]?.l || k),
    datasets: [{
      data: catEntries.map(([, v]) => v),
      backgroundColor: donutColors,
      borderWidth: 0,
      hoverOffset: 12,
      weight: 0.5
    }]
  }, {
    cutout: '75%',
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(0,0,0,0.85)',
        padding: 12,
        cornerRadius: 12,
        titleFont: { size: 11, weight: 'bold', family: 'Syne' },
        bodyFont: { size: 13, weight: '800', family: 'DM Sans' },
        displayColors: false
      }
    }
  });

  // ── Chart 4: Temporal (Hour/Day) ──
  renderTemporalChart();

  renderHeatmap(baseYear, baseMonth);
  renderCategoryBars(winExp);
  // Budget is monthly (base month), independent from the selected window.
  try{
    const monthTxs=AppState.transactions.filter(t=>{
      const d=new Date(t.date+'T12:00');
      return d.getMonth()===baseMonth && d.getFullYear()===baseYear && t.type!=='transfer';
    });
    renderBudgetMini(monthTxs,'budMiniStats');
  }catch(e){}
}

function switchTemporal(mode){
  AppState._tempMode = mode;
  document.getElementById('btnHour').classList.toggle('on', mode==='hour');
  document.getElementById('btnDay').classList.toggle('on', mode==='day');
  document.getElementById('btnHour').style.color = mode==='hour' ? 'var(--br)' : 'var(--t2)';
  document.getElementById('btnDay').style.color = mode==='day' ? 'var(--br)' : 'var(--t2)';
  document.getElementById('btnHour').style.borderColor = mode==='hour' ? 'var(--br)' : 'transparent';
  document.getElementById('btnDay').style.borderColor = mode==='day' ? 'var(--br)' : 'transparent';
  renderTemporalChart();
}

function renderTemporalChart(){
  const mode = AppState._tempMode || 'hour';
  const p=AppState.period||'month';
  const base=new Date(AppState.viewDate.getFullYear(),AppState.viewDate.getMonth(),1);
  const winMonths = p==='quarter'?3 : p==='year'?12 : 1;
  const winStart  = new Date(base.getFullYear(), base.getMonth()-(winMonths-1), 1);
  const winEnd    = new Date(base.getFullYear(), base.getMonth()+1, 0);
  const winExp=AppState.transactions.filter(t=>t.type==='expense' && t.date>=fmtDate(winStart) && t.date<=fmtDate(winEnd));

  if(mode === 'hour'){
    const hLabels=Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
    const hVals=Array(24).fill(0);
    winExp.forEach(t=>{
      const tStr = normTime(t.time) || '12:00';
      const hh=parseInt(tStr.split(':')[0],10);
      if(Number.isFinite(hh) && hh>=0 && hh<=23) hVals[hh]+= +t.amount;
    });
    makeChart('cTemporal','bar',{
      labels:hLabels,
      datasets:[{label:'Spese',data:hVals,backgroundColor:resolveCol('rgba(0,102,255,0.7)'),borderRadius:6, hoverBackgroundColor: resolveCol('var(--br)')}]
    },{
      interaction: { intersect: false, mode: 'index' },
      scales:{y:{display:false},x:{grid:{display:false}, ticks: { color: resolveCol('var(--t3)'), font: { size: 9 } }}}
    });
  } else {
    const wdLabels=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
    const wdVals=Array(7).fill(0);
    winExp.forEach(t=>{ const wd=new Date(t.date+'T12:00').getDay(); wdVals[wd]+= +t.amount; });
    makeChart('cTemporal','bar',{
      labels:wdLabels,
      datasets:[{
        label:'Spese',
        data:wdVals,
        backgroundColor:wdVals.map((_,i)=>i===0||i===6?resolveCol('rgba(255,59,92,0.6)'):resolveCol('rgba(0,102,255,0.6)')),
        borderRadius:6,
        hoverBackgroundColor: wdVals.map((_,i)=>i===0||i===6?resolveCol('var(--bd)'):resolveCol('var(--br)'))
      }]
    },{
      interaction: { intersect: false, mode: 'index' },
      scales:{y:{display:false},x:{grid:{display:false}, ticks: { color: resolveCol('var(--t3)'), font: { size: 10, weight: '700' } }}}
    });
  }
}
function makeChart(id,type,data,extraOpts={}){
  const canvas=document.getElementById(id);
  if(!canvas) return;
  if(typeof Chart==='undefined'){
    console.warn('Chart.js non disponibile (script non caricato?)');
    return;
  }
  if(AppState.charts[id]) try{AppState.charts[id].destroy();}catch(e){}
  const defaults = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 1200, easing: 'easeOutQuart' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.8)',
        padding: 10,
        cornerRadius: 8,
        titleFont: { family: 'Syne', size: 10 },
        bodyFont: { family: 'DM Sans', size: 12, weight: '700' },
        callbacks: { label: i => ' ' + fmt(i.raw) }
      }
    }
  };
  try {
    if (data.datasets) {
      data.datasets.forEach(ds => {
        if (ds.borderColor) ds.borderColor = resolveCol(ds.borderColor);
        if (ds.backgroundColor) ds.backgroundColor = resolveCol(ds.backgroundColor);
        if (Array.isArray(ds.backgroundColor)) ds.backgroundColor = ds.backgroundColor.map(c => resolveCol(c));
      });
    }
    AppState.charts[id] = new Chart(canvas.getContext('2d'), { type, data, options: Object.assign({}, defaults, extraOpts) });
  }catch(e){ console.warn('makeChart error',id,e); }
}
function renderHeatmap(year, month){
  const el=document.getElementById('heatmap');
  if(!el) return;
  const dim=new Date(year,month+1,0).getDate();
  const dayExp={};
  AppState.transactions.filter(t=>{ const d=new Date(t.date+'T12:00'); return d.getMonth()===month&&d.getFullYear()===year&&t.type==='expense'; }).forEach(t=>{dayExp[t.date]=(dayExp[t.date]||0)+ +t.amount;});
  const maxE=Math.max(...Object.values(dayExp),1);
  const cells=Array.from({length:dim},(_,i)=>{
    const d=i+1;
    const key=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const val=dayExp[key]||0;
    const intensity=val/maxE;
    const alpha=(intensity*.85+.05).toFixed(2);
    // Premium color palette for intensity
    const col=val>0?`rgba(255,59,92,${alpha})`:'var(--bg2)';
    const txtCol=val>0?(alpha > 0.5 ? '#fff' : 'var(--t)') : 'var(--t2)';
    const scale = val > 0 ? (1 + intensity * 0.1).toFixed(2) : 1;
    return `<button class="hc group" title="${key}: ${fmt(val)}" style="background:${col};color:${txtCol};transform:scale(${scale})" onclick="openDayDetails('${key}')">
      <span class="relative z-10 transition-transform group-active:scale-90">${d}</span>
    </button>`;
  }).join('');
  el.innerHTML=`<div class="flex flex-wrap gap-1.5 justify-center sm:justify-start pb-2">${cells}</div>`;
}

function openDayDetails(dateStr){
  haptic();
  AppState._dayFocus=dateStr;
  renderDayDetails();
  openModal('dayM');
}
function renderDayDetails(){
  const dateStr=AppState._dayFocus;
  if(!dateStr) return;
  const d=new Date(dateStr+'T12:00');
  const title=d.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const tEl=document.getElementById('dayTitle'); if(tEl) tEl.textContent=title;
  const dayTxs=AppState.transactions.filter(t=>t.date===dateStr);
  const dayIn=dayTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const dayOut=dayTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const totEl=document.getElementById('dayTotals');
  if(totEl){
    totEl.innerHTML=`<div class="flex justify-between items-center">
      <div><p class="text-[9px] font-bold uppercase tracking-widest" style="color:var(--t2)">Entrate</p><p class="text-lg font-black" style="color:var(--ok)">${fmt(dayIn)}</p></div>
      <div class="text-center"><p class="text-[9px] font-bold uppercase tracking-widest" style="color:var(--t2)">Netto</p><p class="text-lg font-black" style="color:var(--t)">${fmt(dayIn-dayOut)}</p></div>
      <div class="text-right"><p class="text-[9px] font-bold uppercase tracking-widest" style="color:var(--t2)">Uscite</p><p class="text-lg font-black" style="color:var(--bd)">${fmt(dayOut)}</p></div>
    </div>`;
  }
  const listEl=document.getElementById('dayList');
  if(listEl){
    listEl.innerHTML=dayTxs.length ? txItems(dayTxs,true) : emptyEl('Nessun movimento in questo giorno');
  }
  lucide.createIcons();
}
function dayToNew(){
  const dateStr=AppState._dayFocus;
  closeAll(false);
  setTimeout(()=>{
    openAdd();
    const d=document.getElementById('txDate');
    if(d && dateStr) d.value=dateStr;
  },180);
}

function renderCategoryBars(winExp){
  const el=document.getElementById('catBars');
  if(!el) return;
  const cats={};
  winExp.forEach(t=>{cats[t.category_id]=(cats[t.category_id]||0)+ +t.amount;});
  const entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const max=entries[0]?.[1]||1;
  el.innerHTML=entries.map(([k,v])=>{
    const c=Categories[k]||{l:k,col:'#888'};
    const pct=Math.round(v/max*100);
    return `
      <div class="space-y-1 w-full">
        <div class="flex justify-between text-[10px] font-bold gap-2">
          <span class="truncate" style="color:var(--t)">${c.l}</span>
          <span class="flex-shrink-0" style="color:var(--t3)">${fmtShort(v)}</span>
        </div>
        <div class="h-1.5 w-full bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-1000" style="width:${pct}%; background:${c.col}; opacity:0.8"></div>
        </div>
      </div>
    `;
  }).join('');
}

/* ============================================================
   PERIOD
============================================================ */
function setPeriod(p){
  AppState.period=p;
  document.querySelectorAll('.ptab').forEach(b=>b.classList.remove('on'));
  document.getElementById('p'+p[0]).classList.add('on');
  renderCharts();
}

/* ============================================================
   MONTH NAV
============================================================ */
function changeMonth(d){ AppState.viewDate=new Date(AppState.viewDate.getFullYear(),AppState.viewDate.getMonth()+d,1); updateDash(); }
function prevMonth(){ changeMonth(-1); }
function nextMonth(){ changeMonth(1); }
function switchTabById(id){
  const nav=document.querySelector(`.ni[onclick*="'${id}'"]`);
  switchTab(id, nav);
}
function switchTab(name, el){
  const page=document.getElementById('page-'+name);
  const cur=document.querySelector('.page.on');
  if(cur && page && cur===page) return;

  const showNext=()=>{
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('on','leave'));
    if(page){
      page.classList.add('on');
      page.classList.remove('leave');
    }
    try{ applyLayouts(); }catch(e){}
    if(name==='wallets') renderList();
    if(name==='stats') renderCharts();
    if(AppState.layoutMode) refreshLayoutEditUI();
    setTimeout(()=>{ try{ queueRevealScan(); }catch(e){} },40);
  };

  if(cur){
    cur.classList.add('leave');
    clearTimeout(AppState._tabLeaveT);
    AppState._tabLeaveT=setTimeout(showNext,220);
  } else {
    showNext();
  }
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('on'));
  if(el) el.classList.add('on');
}

/* ============================================================
   SETTINGS
============================================================ */
function applyTheme(){
  document.body.classList.toggle('dark', UserConfig.theme==='dark'||(UserConfig.theme==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches));
  const mt=document.getElementById('metaTheme'); if(mt) mt.content=getComputedStyle(document.documentElement).getPropertyValue('--br').trim()||'#0066FF';
}
function applyColor(hex){
  UserConfig.color=hex;
  document.documentElement.style.setProperty('--br',hex);
  const mt=document.getElementById('metaTheme'); if(mt) mt.content=hex;
}
function resolveCol(v){
  // Resolve CSS vars (e.g. "var(--br)") to computed colors (Chart.js can't parse CSS vars reliably).
  const s=String(v==null?'':v).trim();
  if(!s) return s;
  try{
    if(s.startsWith('var(')){
      const m=s.match(/var\((--[^,\s)]+)(?:\s*,\s*([^)]+))?\)/);
      const name=m?.[1];
      const fallback=(m?.[2]||'').trim();
      if(name){
        const val=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return val || fallback || s;
      }
    }
    if(s.startsWith('--')){
      const val=getComputedStyle(document.documentElement).getPropertyValue(s).trim();
      return val || s;
    }
  }catch(e){}
  return s;
}
function toggleDark(v){ UserConfig.theme=v?'dark':'light'; applyTheme(); saveConfig(); }
function saveSettings(){
  UserConfig.currency = document.getElementById('currS')?.value||'€';
  UserConfig.defaultWallet = document.getElementById('defWalletS')?.value || UserConfig.defaultWallet || '';
  UserConfig.goalName = document.getElementById('gNameI')?.value||'';
  UserConfig.goalVal  = document.getElementById('gValI')?.value||'';

  const invInc = document.getElementById('setInvInclude')?.checked !== false;

  UserConfig.investIncludeInTotal = invInc;

  saveConfig(); 
}
function updateSyncStatus(state){
  const dot=document.getElementById('sDot');
  const txt=document.getElementById('sTxt');
  if(!dot||!txt) return;
  if(OFFLINE){
    dot.style.background='var(--ok)'; txt.textContent='Locale';
  } else if(state==='loading'){
    dot.style.background='var(--wn)'; txt.textContent='Sync...';
  } else if(state==='error'){
    dot.style.background='var(--bd)'; txt.textContent='Errore';
  } else {
    dot.style.background='var(--ok)'; txt.textContent='Live';
  }
}
function buildColorPicker(){
  const el=document.getElementById('colorPick');
  if(!el) return;
  const colors=['#0066FF','#7C3AED','#FF3B5C','#FF9500','#00C896','#FF6B00','#5AC8FA','#FF2D55'];
  el.innerHTML=colors.map(c=>`<div onclick="applyColor('${c}');saveConfig();buildColorPicker()" style="width:32px;height:32px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${UserConfig.color===c?'var(--t)':'transparent'};transition:.2s;box-shadow:${UserConfig.color===c?'0 0 0 2px '+c:'none'}"></div>`).join('');
}
function renderWalletSettings(){
  const el=document.getElementById('wList'); if(!el) return;
  if(!UserConfig._accounts?.length){
    el.innerHTML=`<div class="rounded-2xl p-3 text-center" style="background:var(--bg2)">
      <p class="text-xs font-bold" style="color:var(--t2)">Nessun conto. Creane uno per iniziare.</p>
      <button onclick="openAccountSetup()" class="mt-2 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest" style="background:rgba(0,102,255,.1);color:var(--br)">Crea conto</button>
    </div>`;
    return;
  }
  const typeLabel={checking:'Corrente',savings:'Risparmi',cash:'Contanti',credit:'Credito',invest:'Investimenti'};
  el.innerHTML=UserConfig._accounts.map(acc=>{
    const brand=detectBrand(acc.name);
    const iconEl=brand
      ? `<div class="ft-badge" style="width:32px;height:32px;border-radius:10px;background:${FINTECH_BRANDS[brand].bg};font-size:11px">${FINTECH_BRANDS[brand].text}</div>`
      : `<div style="width:32px;height:32px;border-radius:10px;background:${acc.color}22;display:flex;align-items:center;justify-content:center"><i data-lucide="${acc.icon||'wallet'}" style="width:14px;height:14px;color:${acc.color}"></i></div>`;
    const bal=acc.currentBalance??DatabaseService.computeBalance(acc.name);
    return `<div class="flex items-center gap-3 py-3 px-3 rounded-2xl" style="background:var(--bg2)">
      ${iconEl}
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm font-bold truncate">${acc.name}</p>
          <p class="text-sm font-black flex-shrink-0" style="color:${bal<0?'var(--bd)':'var(--ok)'};font-variant-numeric:tabular-nums">${fmt(bal)}</p>
        </div>
        <p class="text-[10px] font-bold truncate" style="color:var(--t2)">${typeLabel[acc.type]||acc.type}${brand?' · '+FINTECH_BRANDS[brand].label:''}</p>
      </div>
      <button onclick="promptRenameWallet('${acc.id}')" class="p-2 rounded-xl flex-shrink-0" style="background:var(--card);border:1px solid var(--bo);color:var(--t2)" aria-label="Rinomina conto">
        <i data-lucide="pencil" class="w-4 h-4"></i>
      </button>
      <button onclick="removeWallet('${acc.id}')" class="p-2 rounded-xl flex-shrink-0" style="background:rgba(255,59,92,.1);color:var(--bd)" aria-label="Elimina conto">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>`;
  }).join('');
  lucide.createIcons();
}

async function recalcAllBalances(){
  toast('Ricalcolo saldi...','info');
  await DatabaseService.updateAllBalances();
  renderWalletSettings();
  renderAll();
  toast('Saldi aggiornati ✓','success');
}
async function addWallet(){
  const n=document.getElementById('nWallet')?.value.trim();
  if(!n){toast('Inserisci un nome','warn');return;}
  if(UserConfig._accounts?.find(a=>a.name===n)){toast('Conto già esistente','warn');return;}
  const type=document.getElementById('nWalletType')?.value||'checking';
  const bal=parseFloat(document.getElementById('nWalletBal')?.value)||0;
  const link=document.getElementById('nWalletLink')?.value.trim()||'';
  const color=_ACC_COLORS[_accColorIdx%_ACC_COLORS.length];
  const selectedIcon=document.getElementById('nWalletIcon')?.value||'wallet';
  const icon=selectedIcon||({checking:'credit-card',savings:'piggy-bank',cash:'banknote',credit:'credit-card',invest:'trending-up'}[type]||'wallet');

  // Fetch favicon from link if provided
  let logoUrl = null;
  if (link) {
    logoUrl = await fetchFavicon(link);
  }

  const acc={id:'lac'+Date.now(),name:n,type,color,icon,initialBalance:bal,logoUrl};
  document.getElementById('nWallet').value='';
  if(document.getElementById('nWalletBal')) document.getElementById('nWalletBal').value='';
  if(document.getElementById('nWalletLink')) document.getElementById('nWalletLink').value='';
  await DatabaseService.saveAccount(acc);
  if(!UserConfig.defaultWallet){ UserConfig.defaultWallet=acc.name; saveConfig(); }
  renderWalletSettings(); populateWalletSel(); renderAll();
  toast(`Conto "${n}" aggiunto ✓`,'success');
}
function promptRenameWallet(id){
  const acc=UserConfig._accounts?.find(a=>a.id===id);
  if(!acc) return;
  const next=prompt('Rinomina conto', acc.name);
  if(next==null) return;
  const newName=String(next).trim();
  if(!newName || newName===acc.name) return;
  renameWallet(id,newName,acc.name);
}
async function renameWallet(id,newName,oldName){
  const nn=String(newName||'').trim();
  if(!nn) return;
  if(UserConfig._accounts?.some(a=>a.name===nn && a.id!==id)){ toast('Nome già usato','warn'); return; }
  // Update in-memory transactions (local + UI) immediately.
  try{
    AppState.transactions.forEach(t=>{
      if(t.account===oldName) t.account=nn;
      if(t.account_to===oldName) t.account_to=nn;
    });
    if(AppState._localMeta){
      Object.values(AppState._localMeta).forEach(m=>{ if(m?.account_to===oldName) m.account_to=nn; });
    }
    saveTransactions();
  }catch(e){}
  if(UserConfig.defaultWallet===oldName){ UserConfig.defaultWallet=nn; saveConfig(); }
  await DatabaseService.renameAccount(id,nn,oldName);
  renderWalletSettings(); populateWalletSel(); renderAll();
}
async function removeWallet(id){
  if(UserConfig._accounts.length<=1){toast('Serve almeno un conto','warn');return;}
  const acc=UserConfig._accounts.find(a=>a.id===id);
  if(!acc) return;
  const otherAccounts=(UserConfig._accounts||[]).filter(a=>a.id!==id).map(a=>a?.name).filter(Boolean);
  const fallbackTarget=(otherAccounts.includes(UserConfig.defaultWallet) ? UserConfig.defaultWallet : (otherAccounts[0]||''));
  const impactedTxs=AppState.transactions.filter(t=>t.account===acc.name || t.account_to===acc.name);
  const impacted=impactedTxs.length;

  if(impacted>0){
    const delAll=confirm(
      `Il conto \"${acc.name}\" è usato in ${impacted} movimenti.\n\n`+
      `OK = Elimina conto + movimenti\n`+
      `Annulla = Sposta i movimenti su un altro conto`
    );

    if(delAll){
      if(!confirm(`Confermi eliminazione DEFINITIVA di ${impacted} movimenti e del conto \"${acc.name}\"?`)) return;

      // 1) Local: remove transactions + local meta.
      try{
        const ids=new Set();
        impactedTxs.forEach(t=>{
          ids.add(normId(t.id));
          if(t?._partner_id) ids.add(normId(t._partner_id)); // legacy giro partner
        });
        AppState.transactions=AppState.transactions.filter(t=>!ids.has(normId(t.id)));
        if(AppState._localMeta){
          ids.forEach(txid=>{ if(txid) delete AppState._localMeta[txid]; });
        }
        saveTransactions();
      }catch(e){}

      // 2) DB: best-effort delete all txs involving the account (as account OR account_to).
      if(!OFFLINE && db){
        try{
          // Legacy GIRO pairs: if we delete only one side we create orphans, so delete both by ref.
          const refs=new Set();
          const {data:legacyRows,error:legacyErr}=await db
            .from('transactions')
            .select('description')
            .eq('account',acc.name)
            .like('description','[GIRO:%');
          if(legacyErr) throw legacyErr;
          (legacyRows||[]).forEach(r=>{
            const m=String(r?.description||'').match(/^\[GIRO:([^\]]+)\]/);
            if(m?.[1]) refs.add(m[1]);
          });
          for(const ref of refs){
            await db.from('transactions').delete().like('description',`[GIRO:${ref}]%`);
          }

          const ids=new Set();
          const {data:accRows}=await db.from('transactions').select('id').eq('account',acc.name);
          (accRows||[]).forEach(r=>{ if(r?.id) ids.add(r.id); });
          const {data:metaRows}=await db.from('transaction_meta').select('tx_id').eq('account_to',acc.name);
          (metaRows||[]).forEach(r=>{ if(r?.tx_id) ids.add(r.tx_id); });
          const all=[...ids].filter(Boolean);
          const chunk=(arr,n)=>{ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };
          for(const part of chunk(all,100)){
            try{ await db.from('transaction_meta').delete().in('tx_id',part); }catch(e){}
            await db.from('transactions').delete().in('id',part);
          }
          // Cleanup orphan meta (in case schema wasn't created with ON DELETE CASCADE).
          try{ await db.from('transaction_meta').delete().eq('account_to',acc.name); }catch(e){}
        }catch(e){ console.warn('accounts.deleteTx',e); }
      }

      if(UserConfig.defaultWallet===acc.name && fallbackTarget){ UserConfig.defaultWallet=fallbackTarget; saveConfig(); }
      await DatabaseService.deleteAccount(id);
      try{ await DatabaseService.updateAllBalances(); }catch(e){}
      renderWalletSettings(); populateWalletSel(); renderAll();
      toast('Conto e movimenti eliminati','warn');
      return;
    }

    // Move transactions to another account, then delete.
    if(!otherAccounts.length){ toast('Impossibile: manca un conto di destinazione','error'); return; }
    let target=fallbackTarget;
    if(otherAccounts.length>1){
      const picked=prompt(`Sposta i ${impacted} movimenti su quale conto?\n\nDisponibili:\n- ${otherAccounts.join('\n- ')}`, target);
      if(picked==null) return;
      target=String(picked).trim();
    }
    if(!target || !otherAccounts.includes(target)){ toast('Conto di destinazione non valido','error'); return; }
    if(!confirm(`Vuoi spostare ${impacted} movimenti su \"${target}\" e poi eliminare \"${acc.name}\"?`)) return;

    try{
      AppState.transactions.forEach(t=>{
        if(t.account===acc.name) t.account=target;
        if(t.account_to===acc.name) t.account_to=target;
      });
      if(AppState._localMeta){
        Object.values(AppState._localMeta).forEach(m=>{ if(m?.account_to===acc.name) m.account_to=target; });
      }
      saveTransactions();
    }catch(e){}
    if(!OFFLINE && db){
      try{
        await db.from('transactions').update({account:target}).eq('account',acc.name);
        await db.from('transaction_meta').update({account_to:target}).eq('account_to',acc.name);
      }catch(e){ console.warn('accounts.reassign',e); }
    }
    if(UserConfig.defaultWallet===acc.name){ UserConfig.defaultWallet=target; saveConfig(); }
    await DatabaseService.deleteAccount(id);
    renderWalletSettings(); populateWalletSel(); renderAll();
    toast('Conto eliminato','warn');
    return;
  }

  // No impacted txs: delete the account only.
  if(!confirm(`Elimina il conto \"${acc.name}\"?`)) return;
  if(UserConfig.defaultWallet===acc.name && fallbackTarget){ UserConfig.defaultWallet=fallbackTarget; saveConfig(); }
  await DatabaseService.deleteAccount(id);
  renderWalletSettings(); populateWalletSel(); renderAll();
  toast('Conto eliminato','warn');
}
function buildBudgetList(){
  const el=document.getElementById('budList');
  if(!el) return;
  el.innerHTML=Object.entries(CATS).map(([k,c])=>{
    const v=UserConfig.budgets[k]||'';
    return `<div class="flex items-center gap-2 py-1.5">
      <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${c.col}"></div>
      <span class="text-xs font-bold flex-1">${c.l}</span>
      <input type="number" min="0" step="1" value="${v}" placeholder="—" onchange="setBudget('${k}',this.value)" class="inp w-24 py-1.5 text-sm text-right">
    </div>`;
  }).join('');
}
function setBudget(cat,v){
  DatabaseService.saveBudget(cat,v).then(()=>renderAll());
}
function renderAchievements(){
  const el=document.getElementById('achList');
  if(!el) return;
  el.innerHTML=ACHS.map(a=>{
    const unlocked=UserConfig.ach[a.id];
    return `<div class="flex flex-col items-center text-center gap-1 p-2 rounded-xl" style="background:${unlocked?'rgba(0,102,255,.08)':'var(--bg2)'}">
      <span class="text-2xl" style="filter:${unlocked?'none':'grayscale(1) opacity(.35)'}">${a.e}</span>
      <p class="text-[9px] font-bold leading-tight" style="color:${unlocked?'var(--t)':'var(--t3)'}">${a.t}</p>
    </div>`;
  }).join('');
}
function checkAch(){
  ACHS.forEach(a=>{
    if(!UserConfig.ach[a.id] && a.fn(AppState.transactions,UserConfig)){
      UserConfig.ach[a.id]=Date.now();
      saveConfig();
      launchConfetti();
      const pop=document.getElementById('achPop');
      document.getElementById('achIco').textContent=a.e;
      document.getElementById('achTxt').textContent=a.t;
      pop.style.cssText='position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:999;display:flex';
      setTimeout(()=>pop.style.display='none',4000);
    }
  });
  renderAchievements();
}

/* ============================================================
   EXPORT
============================================================ */
function exportCSV(){
  if(!AppState.transactions.length){toast('Nessun dato','warn');return;}
  const esc=v=>`"${String(v??'').replace(/\"/g,'\"\"')}"`;
  let csv='Data,Ora,Tipo,Importo,Categoria,Conto,ContoDest,Nota,Tag\n';
  AppState.transactions.forEach(t=>{
    csv+=`${t.date},${normTime(t.time)||''},${t.type},${t.amount},${Categories[t.category_id]?.l||'Altro'},${t.account||''},${t.account_to||''},${esc(t.description||'')},${esc(t.tags||'[]')}\n`;
  });
  download(new Blob([csv],{type:'text/csv;charset=utf-8;'}),`MoneyProX_${td()}.csv`);
  toast('CSV esportato ✓','success');
  unlockAch('export');
}
function exportJSON(){
  download(new Blob([JSON.stringify({txs:AppState.transactions,cfg:UserConfig},null,2)],{type:'application/json'}),`MoneyProX_Backup_${td()}.json`);
  UserConfig.lastBackup=Date.now();
  saveConfig();
  toast('Backup esportato ✓','success');
  unlockAch('export');
}
function unlockAch(id){
  if(!UserConfig.ach[id]){UserConfig.ach[id]=Date.now();saveConfig();renderAchievements();}
}
/* ============================================================
   WIPE
============================================================ */
async function wipeAll(){
  if(prompt('Digita "RESET" per confermare')!=='RESET') return;
  // local
  AppState.transactions=[]; AppState._localMeta={};
  saveTransactions();
  UserConfig.budgets={}; UserConfig.templates=[]; UserConfig.notes=[]; UserConfig.ach={};
  UserConfig.debts=[]; UserConfig.subscriptions=[]; UserConfig.goals=[];
  localStorage.setItem('mpx_acc','[]');
  localStorage.setItem('mpx_bud','{}');
  localStorage.setItem('mpx_notes','[]');
  localStorage.setItem('mpx_tpl','[]');
  localStorage.setItem('mpx_debts','[]');
  localStorage.setItem('mpx_subscriptions','[]');
  localStorage.setItem('mpx_goals','[]');
  localStorage.removeItem('mpxData2');
  localStorage.removeItem('mpxCfg2');
  // DB
  if(db){
    toast('Cancellazione database...','warn');
    try{
      await Promise.all([
        db.from('transactions').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('transaction_meta').delete().neq('tx_id','00000000-0000-0000-0000-000000000000'),
        db.from('accounts').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('budgets').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('categories').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('goals').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('debts').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('subscriptions').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('notes').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('templates').delete().neq('id','00000000-0000-0000-0000-000000000000'),
        db.from('settings').delete().neq('key','__placeholder__'),
      ]);
    }catch(e){ console.warn('wipeAll DB',e); }
  }
  renderAll();
  toast('Tutti i dati cancellati','warn');
}

/* ============================================================
   TOAST
============================================================ */
// toast moved to ui.js

/* ============================================================
   CONFETTI
============================================================ */
function launchConfetti(){
  const canvas=document.getElementById('cfcanvas');
  if(!canvas) return;
  canvas.width=window.innerWidth; canvas.height=window.innerHeight;
  const ctx=canvas.getContext('2d');
  const particles=Array.from({length:100},()=>({x:Math.random()*canvas.width,y:-10,r:Math.random()*6+3,vx:(Math.random()-0.5)*4,vy:Math.random()*4+2,color:`hsl(${Math.random()*360},70%,60%)`,rot:Math.random()*360}));
  let frame=0;
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.rot+=3;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.fillStyle=p.color;ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r);ctx.restore();});
    if(++frame<90) requestAnimationFrame(draw); else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  draw();
}

/* ============================================================
   CALCULATOR
============================================================ */
function buildCalc(){
  const el=document.getElementById('calcGrid');
  if(!el) return;
  const keys=[
    {l:'C',cl:'op',fn:()=>updCalc('')},
    {l:'±',cl:'op',fn:()=>{const v=-parseFloat(AppState.calcDisp||0);updCalc(v);}},
    {l:'%',cl:'op',fn:()=>{const v=parseFloat(AppState.calcDisp||0)/100;updCalc(v);}},
    {l:'÷',cl:'op fn',fn:()=>calcOp('/')},
    {l:'7',cl:'num',fn:()=>calcNum('7')},{l:'8',cl:'num',fn:()=>calcNum('8')},{l:'9',cl:'num',fn:()=>calcNum('9')},
    {l:'×',cl:'op fn',fn:()=>calcOp('*')},
    {l:'4',cl:'num',fn:()=>calcNum('4')},{l:'5',cl:'num',fn:()=>calcNum('5')},{l:'6',cl:'num',fn:()=>calcNum('6')},
    {l:'−',cl:'op fn',fn:()=>calcOp('-')},
    {l:'1',cl:'num',fn:()=>calcNum('1')},{l:'2',cl:'num',fn:()=>calcNum('2')},{l:'3',cl:'num',fn:()=>calcNum('3')},
    {l:'+',cl:'op fn',fn:()=>calcOp('+')},
    {l:'0',cl:'num col-span-2',fn:()=>calcNum('0')},{l:'.',cl:'num',fn:()=>calcNum('.')},
    {l:'=',cl:'eq',fn:()=>calcEq()},
  ];
  el.innerHTML=keys.map(k=>`<button class="cbtn ${k.cl}" onclick='(${k.fn.toString()})()'>${k.l}</button>`).join('');
}
let calcOp_={val:0,op:null,newNum:true};
function calcNum(n){
  if(calcOp_.newNum){AppState.calcDisp='';calcOp_.newNum=false;}
  if(n==='.'&&AppState.calcDisp.includes('.')) return;
  AppState.calcDisp=(AppState.calcDisp==='0'&&n!=='.')?n:(AppState.calcDisp||'')+n;
  const el=document.getElementById('calcDisp');if(el) el.textContent=AppState.calcDisp;
}
function calcOp(op){
  calcOp_.val=parseFloat(AppState.calcDisp||0);calcOp_.op=op;calcOp_.newNum=true;
  const el=document.getElementById('calcDisp');if(el) el.textContent=AppState.calcDisp+(op==='*'?'×':op==='/'?'÷':op);
}
function calcEq(){
  if(!calcOp_.op) return;
  const b=parseFloat(AppState.calcDisp||0);
  let res=0;
  if(calcOp_.op==='+') res=calcOp_.val+b;
  if(calcOp_.op==='-') res=calcOp_.val-b;
  if(calcOp_.op==='*') res=calcOp_.val*b;
  if(calcOp_.op==='/')  res=b!==0?calcOp_.val/b:0;
  res=Math.round(res*100)/100;
  updCalc(res);calcOp_={val:0,op:null,newNum:true};
}
function updCalc(v){
  AppState.calcDisp=v.toString();
  AppState.calcVal=parseFloat(v)||0;
  const el=document.getElementById('calcDisp');if(el) el.textContent=AppState.calcDisp||'0';
}
function useCalcAmt(){
  const v=parseFloat(document.getElementById('calcDisp')?.textContent||0);
  if(v<=0){toast('Nessun valore calcolato','warn');return;}
  closeAll();
  setTimeout(()=>{
    openAdd();
    document.getElementById('txAmt').value=v;
  },200);
}

/* ============================================================
   ══════════════ 50 NUOVE FUNZIONI ══════════════
============================================================ */

// 1. TOGGLE BALANCE VISIBILITY
function renderBalToggleBtn(){
  const btn=document.getElementById('balToggleBtn');
  if(btn) btn.innerHTML=`<i data-lucide="${UserConfig.showBalance?'eye':'eye-off'}" class="w-3.5 h-3.5" style="color:var(--t2)"></i>`;
}
function toggleBalanceVisibility(){
  UserConfig.showBalance=!UserConfig.showBalance;
  saveConfig();
  updateDash();
  renderBalToggleBtn();
  lucide.createIcons();
}

// 2. SEARCH FILTER WALLET
function setTF(type){
  AppState.txFilter=type;
  ['ftA','ftE','ftI'].forEach(id=>{
    const b=document.getElementById(id);
    if(!b) return;
    b.style.background='var(--bg2)'; b.style.color='var(--t2)';
  });
  const activeId=type==='all'?'ftA':type==='expense'?'ftE':'ftI';
  const activeBtn=document.getElementById(activeId);
  if(activeBtn){activeBtn.style.background='var(--br)';activeBtn.style.color='#fff';}
  renderList();
}
function filterTxType(type){ setTF(type); }

// 3. ADVANCED FILTERS TOGGLE
function toggleAdv(){
  AppState.advOpen=!AppState.advOpen;
  document.getElementById('advF')?.classList.toggle('hidden',!AppState.advOpen);
  haptic();
}

// 4. CLEAR FILTERS
function clearFilters(){
  document.getElementById('sQ').value='';
  document.getElementById('fFrom').value='';
  document.getElementById('fTo').value='';
  document.getElementById('fMin').value='';
  document.getElementById('fMax').value='';
  document.getElementById('fCat').value='';
  AppState.wFilter='all'; AppState.txFilter='all';
  AppState.advOpen=false;
  document.getElementById('advF')?.classList.add('hidden');
  renderList(); renderWallets({}, 0);
}

// 5. SMART SEARCH (fuzzy)
function smartSearch(){
  const q=(document.getElementById('sQ')?.value||'').toLowerCase().trim();
  if(!q){renderList();return;}
  renderList();
}

// 6. TEMPLATES — SAVE TX AS TEMPLATE
async function saveAsTemplate(id){
  haptic();
  const t=AppState.transactions.find(x=>x.id===id);
  if(!t) return;
  const name=prompt('Nome template:',t.description||Categories[t.category_id]?.l||'Template');
  if(!name) return;
  if(!UserConfig.templates) UserConfig.templates=[];
  await DatabaseService.addTemplate({name,type:t.type,amount:t.amount,category_id:t.category_id,account:t.account,account_to:t.account_to,tags:t.tags});
  toast('Template salvato ✓','success');
  unlockAch('tpl');
}

// 7. OPEN TEMPLATES MODAL
function openTemplates(){
  haptic();
  renderTemplateList();
  openModal('tplM');
}
function renderTemplateList(){
  const el=document.getElementById('tplList');
  if(!el) return;
  if(!UserConfig.templates||!UserConfig.templates.length){el.innerHTML=emptyEl('Nessun template salvato');lucide.createIcons();return;}
  el.innerHTML=UserConfig.templates.map((tpl,i)=>{
    const c=Categories[tpl.category_id]||Categories.other;
    const col=tpl.type==='expense'?'var(--bd)':tpl.type==='income'?'var(--ok)':'var(--wn)';
    const tid=tpl.id||i;
    return `<div class="flex items-center gap-3 py-3 border-b last:border-0" style="border-color:var(--bo)">
      <div class="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:${c.bg}"><i data-lucide="${c.ic}" class="w-4 h-4" style="color:${c.col}"></i></div>
      <div class="flex-1 min-w-0">
        <p class="font-bold text-sm truncate">${tpl.name}</p>
        <p class="text-[10px]" style="color:var(--t2)">${c.l} · ${fmt(tpl.amount)}</p>
      </div>
      <div class="flex gap-2">
        <button onclick="useTemplate(${i})" style="background:rgba(0,102,255,.1);color:var(--br);border-radius:.7rem;padding:.4rem .75rem;font-size:.75rem;font-weight:700">Usa</button>
        <button onclick="deleteTemplate('${tid}')" style="background:rgba(255,59,92,.1);color:var(--bd);border-radius:.7rem;padding:.4rem;line-height:1"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>
    </div>`;
  }).join('');
  lucide.createIcons();
}
function useTemplate(i){
  const tpl=UserConfig.templates[i];
  if(!tpl) return;
  closeAll();
  setTimeout(()=>{
    openAdd();
    setFType(tpl.type||'expense');
    if(tpl.amount) document.getElementById('txAmt').value=tpl.amount;
    if(tpl.category_id) document.getElementById('txCat').value=tpl.category_id;
    if(tpl.account) document.getElementById('txAcc').value=tpl.account;
    toast(`Template "${tpl.name}" caricato`,'success');
  },200);
}
async function deleteTemplate(i){
  const tpl=UserConfig.templates[i]; if(!tpl) return;
  await DatabaseService.deleteTemplate(tpl.id||i);
  renderTemplateList();
}

// 8. SPLIT BILL
function openSplit(){
  haptic();
  AppState.splitN=2;
  const sN=document.getElementById('splitN'); if(sN) sN.textContent=2;
  const sA=document.getElementById('splitAmt'); if(sA) sA.value='';
  const sR=document.getElementById('splitRes'); if(sR) sR.textContent=fmt(0);
  openModal('splitM');
}
function splitAdj(d){
  AppState.splitN=Math.max(2,Math.min(20,AppState.splitN+d));
  const _sN=document.getElementById('splitN'); if(_sN) _sN.textContent=AppState.splitN;
  calcSplit();haptic();
}
function calcSplit(){
  const _sA=document.getElementById('splitAmt');
  const amt=parseFloat(_sA?.value)||0;
  const res=Math.ceil((amt/AppState.splitN)*100)/100;
  const _sR=document.getElementById('splitRes'); if(_sR) _sR.textContent=fmt(res);
}
function splitToTx(){
  const amt=parseFloat(document.getElementById('splitAmt')?.value)||0;
  if(!amt){toast('Inserisci l\'importo','warn');return;}
  const myShare=Math.ceil((amt/AppState.splitN)*100)/100;
  closeAll();
  setTimeout(()=>{ openAdd(); document.getElementById('txAmt').value=myShare; toast(`La tua quota: ${fmt(myShare)}`,'success'); },200);
}

// 9. CURRENCY CONVERTER
function openConv(){
  haptic();
  buildConvOptions();
  openModal('convM');
  doConvert();
  setTimeout(()=>document.getElementById('convAmt')?.select(),50);
}
function buildConvOptions(){
  const rates=UserConfig.fx||{EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
  const keys=Object.keys(rates);
  const from=document.getElementById('convFrom');
  const to=document.getElementById('convTo');
  if(!from||!to||!keys.length) return;
  const opts=keys.map(k=>`<option value="${k}">${k}</option>`).join('');
  if(!from.options.length) from.innerHTML=opts;
  if(!to.options.length) to.innerHTML=opts;
  if(!from.value) from.value=keys.includes('EUR')?'EUR':keys[0];
  if(!to.value) to.value=keys.includes('USD')?'USD':(keys[1]||keys[0]);
}
function swapConv(){
  const from=document.getElementById('convFrom');
  const to=document.getElementById('convTo');
  if(!from||!to) return;
  const tmp=from.value;
  from.value=to.value;
  to.value=tmp;
  doConvert();
  haptic();
}
function doConvert(){
  const from=document.getElementById('convFrom')?.value||'EUR';
  const to=document.getElementById('convTo')?.value||'USD';
  const amt=parseFloat(document.getElementById('convAmt')?.value)||1;
  const rates=UserConfig.fx||{EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
  const fromRate=rates[from]||1;
  const toRate=rates[to]||1;
  const result=(amt/fromRate)*toRate;
  const rate=toRate/fromRate;
  const el=document.getElementById('convRes');
  if(el) el.textContent=result.toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+to;
  const rel=document.getElementById('convRate');
  if(rel) rel.textContent=`1 ${from} = ${rate.toFixed(4)} ${to} (tasso indicativo)`;
}
function convToTx(){
  const from=document.getElementById('convFrom')?.value||'EUR';
  const to=document.getElementById('convTo')?.value||'USD';
  const amt=parseFloat(document.getElementById('convAmt')?.value)||0;
  const rates=UserConfig.fx||{};
  const fromRate=rates[from]||1;
  const toRate=rates[to]||1;
  const result=Math.round((amt/fromRate)*toRate*100)/100;
  closeAll();
  setTimeout(()=>{ openAdd(); document.getElementById('txAmt').value=result; toast('Importo convertito caricato ✓','success'); },200);
}

/* ============================================================
   ALERT CENTER (pro)
============================================================ */
function openAlerts(){
  haptic();
  renderAlerts();
  openModal('alertsM');
}
function _alertColor(level){
  if(level==='over') return {bg:'rgba(255,59,92,.10)', col:'var(--bd)'};
  if(level==='warn') return {bg:'rgba(255,149,0,.12)', col:'var(--wn)'};
  return {bg:'rgba(0,102,255,.10)', col:'var(--br)'};
}
function _daysUntil(dateStr){
  const d=new Date(dateStr+'T12:00');
  return Math.ceil((d.getTime()-Date.now())/(1000*60*60*24));
}
function getAlertItems(){
  const items=[];

  // Budgets
  try{
    const b=checkBudgetAlerts();
    b.sort((a,b)=>b.pct-a.pct).forEach(a=>{
    const c=Categories[a.cat]||Categories.other;
      const pct=Math.round(a.pct*100);
      items.push({
        level:a.level,
        icon:c.ic||'zap',
        title:`Budget: ${c.l}`,
        desc:`${fmt(a.spent)} / ${fmt(a.lim)} (${pct}%)`,
        actionLabel:'Budget',
        action:'openBudM()'
      });
    });
  }catch(e){}

  // Subs due soon
  try{
    const due=(UserConfig.subscriptions||[]).filter(s=>s.active).map(s=>({s,days:_daysUntil(s.nextDate)})).filter(x=>x.days>=0&&x.days<=7);
    if(due.length){
      due.sort((a,b)=>a.days-b.days);
      const next=due[0];
      items.push({
        level:'warn',
        icon:'refresh-cw',
        title:'Abbonamenti in scadenza',
        desc:`${due.length} nei prossimi 7 giorni · prossimo: ${next.s.name} (${next.days}gg)`,
        actionLabel:'Apri',
        action:'openSubs()'
      });
    }
  }catch(e){}

  // Debts pending
  try{
    const pending=(UserConfig.debts||[]).filter(d=>!d.settled);
    if(pending.length){
      const total=pending.reduce((s,d)=>s+(+d.amount||0),0);
      items.push({
        level:'info',
        icon:'handshake',
        title:'Debiti & crediti aperti',
        desc:`${pending.length} voci · totale ${fmt(total)}`,
        actionLabel:'Apri',
        action:'openDebts()'
      });
    }
  }catch(e){}

  // Possible duplicates
  try{
    const dups=getDuplicateCandidates();
    if(dups.length){
      items.push({
        level:'warn',
        icon:'copy',
        title:'Possibili duplicati',
        desc:`${dups.length} movimenti da verificare`,
        actionLabel:'Rivedi',
        action:'openDupReview()'
      });
    }
  }catch(e){}

  // Low balances (negative)
  try{
    if(typeof DBS!=='undefined' && DatabaseService.computeBalance && UserConfig._accounts?.length){
      const lows=UserConfig._accounts.map(a=>({name:a.name,bal:DatabaseService.computeBalance(a.name)})).filter(x=>x.bal<0).sort((a,b)=>a.bal-b.bal);
      if(lows.length){
        const worst=lows[0];
        items.push({
          level:'over',
          icon:'wallet',
          title:'Saldo negativo',
          desc:`${lows.length} conti · peggiore: ${worst.name} (${fmt(worst.bal)})`,
          actionLabel:'Conti',
          action:"switchTabById('wallets')"
        });
      }
    }
  }catch(e){}

  // Backup reminder
  try{
    const last=UserConfig.lastBackup||0;
    if(last){
      const days=Math.floor((Date.now()-last)/(1000*60*60*24));
      if(days>7){
        items.push({
          level:'warn',
          icon:'package',
          title:'Backup consigliato',
          desc:`Ultimo backup: ${days} giorni fa`,
          actionLabel:'Backup',
          action:'exportJSON()'
        });
      }
    }
  }catch(e){}

  // Velocity insight
  try{
    const vel=getSpendingVelocity();
    if(vel>=25){
      items.push({
        level:'warn',
        icon:'activity',
        title:'Spesa in accelerazione',
        desc:`+${vel}% rispetto al mese scorso (stesso giorno)`,
        actionLabel:'Analisi',
        action:"switchTabById('stats')"
      });
    }
  }catch(e){}

  return items;
}
function renderAlerts(){
  const el=document.getElementById('alertsList');
  if(!el) return;
  const items=getAlertItems();
  if(!items.length){
    el.innerHTML=`<div class="text-center py-10">
      <div class="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3" style="background:var(--bg2)"><i data-lucide="shield-check" class="w-7 h-7" style="color:var(--ok)"></i></div>
      <p class="text-sm font-bold">Nessun alert</p>
      <p class="text-[10px] mt-1" style="color:var(--t2)">Tutto sotto controllo.</p>
    </div>`;
    lucide.createIcons();
    return;
  }
  el.innerHTML=items.map(a=>{
    const {bg,col}=_alertColor(a.level);
    return `<div class="card p-4 flex items-start gap-3" style="background:${bg}">
      <div class="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:var(--card);border:1px solid var(--bo)">
        <i data-lucide="${a.icon}" class="w-4 h-4" style="color:${col}"></i>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold">${a.title}</p>
        <p class="text-[10px] mt-0.5" style="color:var(--t2)">${a.desc}</p>
      </div>
      ${a.action?`<button onclick="${a.action}" class="px-3 py-2 rounded-xl text-[10px] font-black" style="background:var(--card);border:1px solid var(--bo);color:${col}">${a.actionLabel||'Apri'}</button>`:''}
    </div>`;
  }).join('');
  lucide.createIcons();
}

function openDupReview(){
  haptic();
  renderDupReview();
  openModal('dupM');
}
function renderDupReview(){
  const el=document.getElementById('dupList');
  if(!el) return;
  const dups=getDuplicateCandidates();
  if(!dups.length){
    el.innerHTML=emptyEl('Nessun duplicato rilevato');
    lucide.createIcons();
    return;
  }
  const rows=dups.slice(0,30).map(({existing,candidate})=>{
    const title=candidate.description||'(senza nota)';
    const exTitle=existing.description||'(senza nota)';
    return `<div class="card p-4">
      <p class="text-[9px] font-black uppercase tracking-widest mb-2" style="color:var(--t2)">Possibile duplicato</p>
      <div class="grid grid-cols-2 gap-2 text-[10px]" style="color:var(--t2)">
        <div class="rounded-xl p-3" style="background:var(--bg2)">
          <p class="font-bold" style="color:var(--t)">Originale</p>
          <p class="mt-1">${existing.date} · ${fmt(existing.amount)}</p>
          <p class="mt-1 truncate">${exTitle}</p>
        </div>
        <div class="rounded-xl p-3" style="background:rgba(255,149,0,.10)">
          <p class="font-bold" style="color:var(--t)">Candidato</p>
          <p class="mt-1">${candidate.date} · ${fmt(candidate.amount)}</p>
          <p class="mt-1 truncate">${title}</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 mt-3">
        <button onclick="cmdOpenTx('${candidate.id}')" class="px-3 py-2 rounded-xl text-[10px] font-black" style="background:rgba(0,102,255,.10);color:var(--br)">Apri</button>
        <button onclick="deleteDupCandidate('${candidate.id}')" class="px-3 py-2 rounded-xl text-[10px] font-black" style="background:rgba(255,59,92,.10);color:var(--bd)">Elimina</button>
      </div>
    </div>`;
  }).join('');
  el.innerHTML=rows + (dups.length>30?`<p class="text-center text-[10px] mt-2" style="color:var(--t3)">Mostrati 30 di ${dups.length}</p>`:'');
  lucide.createIcons();
}
function deleteDupCandidate(id){
  deleteTx(id).then(()=>{ setTimeout(()=>{ renderDupReview(); renderAlerts(); },220); }).catch(()=>{});
}

/* ============================================================
   COMMAND CENTER (pro)
============================================================ */
const CMD_ACTIONS=[
  {id:'new',      icon:'plus',            label:'Nuovo movimento',            hint:'N', run:()=>openAdd()},
  {id:'layout',   icon:'move',            label:'Personalizza layout (sposta blocchi)', hint:'',  run:()=>toggleLayoutMode()},
  {id:'layreset', icon:'rotate-ccw',      label:'Reset layout dashboard',     hint:'',  run:()=>resetLayout()},
  {id:'alerts',   icon:'bell',            label:'Alert Center',               hint:'',  run:()=>openAlerts()},
  {id:'import',   icon:'upload',          label:'Importa CSV/JSON',           hint:'',  run:()=>openImpM()},
  {id:'budget',   icon:'zap',             label:'Budget mensile',             hint:'',  run:()=>openBudM()},
  {id:'convert',  icon:'arrow-left-right',label:'Currency Converter',         hint:'',  run:()=>openConv()},
  {id:'split',    icon:'divide',          label:'Split Bill',                 hint:'',  run:()=>openSplit()},
  {id:'cashflow', icon:'trending-up',     label:'Cash Flow Predictor',        hint:'',  run:()=>openCashFlowModal()},
  {id:'scan',     icon:'scan-line',       label:'Scanner scontrino',          hint:'',  run:()=>openReceiptScanner()},
  {id:'subs',     icon:'refresh-cw',      label:'Abbonamenti',                hint:'',  run:()=>openSubs()},
  {id:'report',   icon:'file-text',       label:'Esporta report mese',        hint:'',  run:()=>exportCurrentMonthPDF()},
  {id:'backup',   icon:'package',         label:'Backup JSON',                hint:'',  run:()=>exportJSON()},
  {id:'home',     icon:'layout-dashboard',label:'Vai a Home',                 hint:'1', run:()=>switchTabById('home')},
  {id:'wallets',  icon:'wallet',          label:'Vai a Conti',                hint:'2', run:()=>switchTabById('wallets')},
  {id:'stats',    icon:'bar-chart-3',     label:'Vai ad Analisi',             hint:'3', run:()=>switchTabById('stats')},
  {id:'settings', icon:'settings-2',      label:'Vai a Impostazioni',         hint:'4', run:()=>switchTabById('settings')},
];
function _esc(s){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/\"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function openCommand(){
  haptic();
  openModal('cmdM');
  const inp=document.getElementById('cmdQ');
  if(inp){
    inp.value='';
    setTimeout(()=>{ inp.focus(); },80);
  }
  cmdSearch();
}
function cmdSearch(){
  const q=(document.getElementById('cmdQ')?.value||'').toLowerCase().trim();
  const el=document.getElementById('cmdRes');
  if(!el) return;

  const actions=CMD_ACTIONS.filter(a=>{
    if(!q) return true;
    return a.label.toLowerCase().includes(q) || a.id.includes(q);
  }).slice(0,8);

  const txs = q.length>=2
    ? AppState.transactions.filter(t=>{
        const desc=(t.description||'').toLowerCase();
        const cat=(Categories[t.category_id]?.l||'').toLowerCase();
        const acc=(t.account||'').toLowerCase();
        return desc.includes(q) || cat.includes(q) || acc.includes(q);
      }).slice(0,8)
    : [];

  let first=null;
  let html='';
  if(actions.length){
    html+=`<p class="text-[9px] font-black uppercase tracking-widest mb-2" style="color:var(--t2)">Azioni</p>`;
    html+=actions.map(a=>{
      if(!first) first={type:'action', id:a.id};
      return `<button onclick="cmdRunAction('${a.id}')" class="card w-full p-3 flex items-center gap-3 text-left">
        <div class="w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:var(--bg2)"><i data-lucide="${a.icon}" class="w-4 h-4" style="color:var(--t2)"></i></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-bold truncate">${a.label}</p>
        </div>
        ${a.hint?`<span class="text-[9px] font-black px-2 py-1 rounded-lg" style="background:var(--bg2);color:var(--t2)">${a.hint}</span>`:''}
      </button>`;
    }).join('');
  }

  if(txs.length){
    html+=`<p class="text-[9px] font-black uppercase tracking-widest mt-4 mb-2" style="color:var(--t2)">Movimenti</p>`;
    html+=txs.map(t=>{
      if(!first) first={type:'tx', id:t.id};
      const isTransfer=(t.type==='transfer');
      const c=isTransfer ? {l:'Trasferimento',ic:'arrow-right-left',col:'#FF9500',bg:'rgba(255,149,0,.12)'} : (Categories[t.category_id]||Categories.other);
      const amtCol=t.type==='expense'?'var(--bd)':t.type==='income'?'var(--ok)':'var(--wn)';
      const sign=t.type==='expense'?'−':t.type==='income'?'+':'⇄';
      const dStr=new Date(t.date+'T12:00').toLocaleDateString('it-IT',{day:'2-digit',month:'short'});
      const timeStr=normTime(t.time);
      const title=_esc(t.description||c.l);
      return `<button onclick="cmdOpenTx('${t.id}')" class="card w-full p-3 flex items-center gap-3 text-left">
        <div class="w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:${c.bg}"><i data-lucide="${c.ic}" class="w-4 h-4" style="color:${c.col}"></i></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-bold truncate">${title}</p>
          <p class="text-[10px] mt-0.5 truncate" style="color:var(--t2)">${[dStr,timeStr].filter(Boolean).join(' · ')}</p>
        </div>
        <p class="text-sm font-black whitespace-nowrap" style="color:${amtCol};font-variant-numeric:tabular-nums">${sign}${fmt(t.amount)}</p>
      </button>`;
    }).join('');
  }

  if(!html){
    html=`<div class="text-center py-10">
      <div class="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3" style="background:var(--bg2)"><i data-lucide="search-x" class="w-7 h-7" style="color:var(--t2)"></i></div>
      <p class="text-sm font-bold">Nessun risultato</p>
      <p class="text-[10px] mt-1" style="color:var(--t2)">Prova con un'altra parola.</p>
    </div>`;
  }

  AppState._cmdFirst=first;
  el.innerHTML=html;
  lucide.createIcons();
}
function cmdKey(e){
  if(e.key==='Enter'){
    e.preventDefault();
    if(AppState._cmdFirst?.type==='action') cmdRunAction(AppState._cmdFirst.id);
    if(AppState._cmdFirst?.type==='tx') cmdOpenTx(AppState._cmdFirst.id);
  }
}
function cmdRunAction(id){
  const a=CMD_ACTIONS.find(x=>x.id===id);
  if(!a) return;
  closeAll(false);
  setTimeout(()=>{ try{ a.run(); }catch(e){} },120);
}
function cmdOpenTx(id){
  closeAll(false);
  setTimeout(()=>{ editTx(id); },140);
}

// 10. NOTES
function openNotes(){
  haptic();
  renderNotesList();
  openModal('notesM');
}
async function addNote(){
  const inp=document.getElementById('noteInp');
  const txt=inp?.value.trim();
  if(!txt){toast('Scrivi qualcosa prima','warn');return;}
  if(!UserConfig.notes) UserConfig.notes=[];
  await DatabaseService.addNote(txt);
  inp.value='';
  renderNotesList();
  haptic();
}
function renderNotesList(){
  const el=document.getElementById('notesList');
  if(!el||!UserConfig.notes) return;
  if(!UserConfig.notes.length){el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessuna nota ancora</p>';return;}
  el.innerHTML=UserConfig.notes.map(n=>`
    <div class="flex items-start gap-3 p-3 rounded-xl" style="background:var(--bg2)">
      <button onclick="toggleNote('${n.id}')" class="w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all" style="border-color:${n.done?'var(--ok)':'var(--bo)'}; background:${n.done?'var(--ok)':'transparent'}">
        ${n.done?'<svg width="10" height="10" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="white" stroke-width="2" fill="none"/></svg>':''}
      </button>
      <p class="flex-1 text-sm font-medium" style="color:var(--t);text-decoration:${n.done?'line-through':'none'};opacity:${n.done?.6:1}">${n.text}</p>
      <button onclick="deleteNote('${n.id}')" class="p-1 rounded-lg" style="color:var(--t3)"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
    </div>`).join('');
  lucide.createIcons();
}
async function toggleNote(id){
  const n=UserConfig.notes.find(x=>x.id===id); if(!n) return;
  await DatabaseService.updateNote(id,{done:!n.done});
  renderNotesList();
}
async function deleteNote(id){
  await DatabaseService.deleteNote(id);
  renderNotesList();
}

// 11. RECURRING TRANSACTIONS
function openRecurring(){
  haptic();
  renderRecurringList();
  openModal('recM');
}
function renderRecurringList(){
  const el=document.getElementById('recList');
  if(!el) return;
  const txsWithTag=AppState.transactions.filter(t=>{
    try{ return (typeof t.tags==='string'?JSON.parse(t.tags):[]).includes('ricorrente'); }catch(e){return false;}
  });
  const grouped={};
  txsWithTag.forEach(t=>{const k=t.description+'|'+t.amount+'|'+t.category_id; grouped[k]=(grouped[k]||[]);grouped[k].push(t);});
  if(!Object.keys(grouped).length){el.innerHTML=emptyEl('Nessuna spesa ricorrente — aggiungine una con il tag "Ricorrente"');lucide.createIcons();return;}
  el.innerHTML=`<div class="space-y-0.5 mt-2">`+Object.entries(grouped).map(([k,txs])=>{
    const t=txs[0];const c=Categories[t.category_id]||Categories.other;
    const total=txs.reduce((s,x)=>s+ +x.amount,0);
    return `<div class="flex items-center gap-3 py-3 border-b last:border-0" style="border-color:var(--bo)">
      <div class="w-10 h-10 rounded-2xl flex items-center justify-center" style="background:${c.bg}"><i data-lucide="${c.ic}" class="w-4 h-4" style="color:${c.col}"></i></div>
      <div class="flex-1">
        <p class="font-bold text-sm">${t.description||c.l}</p>
        <p class="text-[10px]" style="color:var(--t2)">${txs.length}× · Totale ${fmt(total)}</p>
      </div>
      <p class="font-black text-sm" style="color:var(--bd);font-variant-numeric:tabular-nums">−${fmt(t.amount)}</p>
    </div>`;
  }).join('')+`</div>`;
  lucide.createIcons();
}

/* ============================================================
   DEBITI, ABBONAMENTI, OBIETTIVI, PATRIMONIO
============================================================ */
let debtType="borrow";
function setDebtType(t){
  debtType=t;
  const b=document.getElementById('debtTypeBorrow');
  const l=document.getElementById('debtTypeLend');
  if(b) b.style.background=t==='borrow'?'var(--bd)':'rgba(255,59,92,.12)';
  if(b) b.style.color=t==='borrow'?'#fff':'var(--bd)';
  if(l) l.style.background=t==='lend'?'var(--ok)':'rgba(0,200,150,.12)';
  if(l) l.style.color=t==='lend'?'#fff':'var(--ok)';
}
async function addDebt(){
  const person=document.getElementById('debtPerson')?.value.trim();
  const amt=parseFloat(document.getElementById('debtAmt')?.value)||0;
  const note=document.getElementById('debtNote')?.value.trim()||'';
  if(!person){toast('Inserisci il nome della persona','warn');return;}
  if(!amt||amt<=0){toast('Inserisci un importo valido','error');return;}
  if(!UserConfig.debts) UserConfig.debts=[];
  const debt={person,amount:amt,type:debtType,note,date:fmtDate(new Date()),settled:false};
  await DatabaseService.saveDebt(debt);
  document.getElementById('debtPerson').value='';
  document.getElementById('debtAmt').value='';
  document.getElementById('debtNote').value='';
  saveConfig(); renderDebtsList(); renderDebtsMini();
  toast(`${debtType==='borrow'?'Credito':'Debito'} con ${person} aggiunto ✓`,'success');
}
async function settleDebt(id){
  haptic();
  if(!UserConfig.debts) return;
  const d=UserConfig.debts.find(x=>idEq(x.id,id));
  if(!d) return;
  const next=!d.settled;
  await DatabaseService.updateDebt(d.id,{settled:next});
  saveConfig(); renderDebtsList(); renderDebtsMini();
  toast(next?'Segnato come saldato ✓':'Riaperto','success');
}
async function deleteDebt(id){
  if(!UserConfig.debts) return;
  await DatabaseService.deleteDebt(id);
  saveConfig(); renderDebtsList(); renderDebtsMini();
}
function renderDebtsList(){
  const el=document.getElementById('debtsList');
  if(!el) return;
  const debts=(UserConfig.debts||[]);
  if(!debts.length){el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessun debito o credito</p>';return;}
  const active=debts.filter(d=>!d.settled);
  const settled=debts.filter(d=>d.settled);
  const render=(arr,label)=> arr.length ? `<p class="text-[9px] font-bold uppercase tracking-wider my-2" style="color:var(--t2)">${label}</p>`+arr.map(d=>{
    const isBorrow=d.type==='borrow';
    const col=isBorrow?'var(--ok)':'var(--bd)';
    const bg=isBorrow?'rgba(0,200,150,.1)':'rgba(255,59,92,.1)';
    return `<div class="flex items-center gap-3 p-3 rounded-2xl" style="background:${bg};opacity:${d.settled?.6:1}">
      <div class="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-black flex-shrink-0" style="background:${col}">${d.person.charAt(0).toUpperCase()}</div>
      <div class="flex-1 min-w-0">
        <p class="font-bold text-sm">${d.person}</p>
        <p class="text-[10px]" style="color:var(--t2)">${isBorrow?'💚 Mi deve':'🔴 Devo io'} · ${d.date}${d.note?' · '+d.note:''}</p>
      </div>
      <p class="font-black text-sm" style="color:${col}">${fmt(d.amount)}</p>
      <div class="flex flex-col gap-1">
        <button onclick='settleDebt(${JSON.stringify(normId(d.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:var(--bg2);color:var(--t2)">${d.settled?'Riapri':'Salda'}</button>
        <button onclick='deleteDebt(${JSON.stringify(normId(d.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:rgba(255,59,92,.1);color:var(--bd)">Elimina</button>
      </div>
    </div>`;
  }).join('') : '';
  el.innerHTML=render(active,'In sospeso')+render(settled,'Saldati');
}
function renderDebtsMini(){
  const el=document.getElementById('debtsMini');
  if(!el) return;
  const debts=(UserConfig.debts||[]).filter(d=>!d.settled);
  if(!debts.length){el.innerHTML='<p class="text-xs" style="color:var(--t2)">Nessun debito in sospeso</p>';return;}
  const totalBorrow=debts.filter(d=>d.type==='borrow').reduce((s,d)=>s+d.amount,0);
  const totalLend=debts.filter(d=>d.type==='lend').reduce((s,d)=>s+d.amount,0);
  el.innerHTML=`<div class="flex gap-3">
    ${totalBorrow>0?`<div class="flex-1 p-2 rounded-xl text-center" style="background:rgba(0,200,150,.1)"><p class="text-[9px] font-bold leading-tight" style="color:var(--ok)">Mi devono</p><p class="font-black text-sm leading-tight" style="color:var(--ok);font-variant-numeric:tabular-nums">${fmt(totalBorrow)}</p></div>`:''}
    ${totalLend>0?`<div class="flex-1 p-2 rounded-xl text-center" style="background:rgba(255,59,92,.1)"><p class="text-[9px] font-bold leading-tight" style="color:var(--bd)">Devo io</p><p class="font-black text-sm leading-tight" style="color:var(--bd);font-variant-numeric:tabular-nums">${fmt(totalLend)}</p></div>`:''}
  </div>`;
}
function openDebtsM(){
  haptic();
  if(!UserConfig.debts) UserConfig.debts=[];
  setDebtType('borrow');
  renderDebtsList();
  openModal('debtsM');
}

/* ============================================================
   ABBONAMENTI
============================================================ */
async function fetchFavicon(nameOrUrl) {
  try {
    let url = nameOrUrl;
    if (!url.includes('.')) return null; // Not a URL
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    
    const resp = await fetch(`/api/favicon?url=${encodeURIComponent(url)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.iconUrl || null;
  } catch (e) {
    return null;
  }
}

async function addSubscription(){
  const name=document.getElementById('subName')?.value.trim();
  const amt=parseFloat(document.getElementById('subAmt')?.value)||0;
  const freq=document.getElementById('subFreq')?.value||'monthly';
  const next=document.getElementById('subNextDate')?.value||fmtDate(new Date());
  if(!name){toast('Inserisci il nome','warn');return;}
  if(!amt||amt<=0){toast('Inserisci un importo valido','error');return;}
  if(!UserConfig.subscriptions) UserConfig.subscriptions=[];
  
  // Tenta di recuperare icona
  let logoUrl = null;
  if (name.includes('.')) {
    logoUrl = await fetchFavicon(name);
  }

  const sub={name,amount:amt,frequency:freq,nextDate:next,active:true,logoUrl};
  await DatabaseService.saveSub(sub);
  document.getElementById('subName').value='';
  document.getElementById('subAmt').value='';
  saveConfig(); renderSubsList(); renderSubsMini();
  toast(`${name} aggiunto ✓`,'success');
}
async function toggleSub(id){
  const s=(UserConfig.subscriptions||[]).find(x=>idEq(x.id,id));
  if(!s) return;
  s.active=!s.active;
  await DatabaseService.saveSub(s);
  saveConfig(); renderSubsList(); renderSubsMini();
}
async function deleteSub(id){
  await DatabaseService.deleteSub(id);
  saveConfig(); renderSubsList(); renderSubsMini();
}
function subMonthlyAmount(s){
  if(s.frequency==='monthly') return s.amount;
  if(s.frequency==='yearly') return s.amount/12;
  if(s.frequency==='weekly') return s.amount*52/12;
  return s.amount;
}
function renderSubsList(){
  const el=document.getElementById('subsList');
  if(!el) return;
  const subs=(UserConfig.subscriptions||[]);
  if(!subs.length){el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessun abbonamento</p>';return;}
  const monthly=subs.filter(s=>s.active).reduce((t,s)=>t+subMonthlyAmount(s),0);
  const yearly=monthly*12;
  const totM=document.getElementById('subsTotalMo');
  const totY=document.getElementById('subsTotalYr');
  if(totM) totM.textContent=fmt(monthly);
  if(totY) totY.textContent=fmt(yearly);
  const freqLabel={monthly:'Mensile',yearly:'Annuale',weekly:'Settimanale'};
  el.innerHTML=subs.map(s=>{
    const mo=subMonthlyAmount(s);
    const daysUntil=Math.ceil((new Date(s.nextDate)-new Date())/(1000*60*60*24));
    const urgent=daysUntil<=7&&daysUntil>=0;
    const logoHtml = s.logoUrl 
      ? `<img src="${s.logoUrl}" class="w-10 h-10 rounded-2xl object-cover flex-shrink-0" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">`
      : '';
    const fallbackHtml = `<div class="w-10 h-10 rounded-2xl flex items-center justify-center text-white font-black text-sm flex-shrink-0" style="background:linear-gradient(135deg,var(--acc),var(--br)); ${s.logoUrl ? 'display:none' : ''}">${s.name.charAt(0).toUpperCase()}</div>`;
    
    return `<div class="flex items-center gap-3 p-3 rounded-2xl" style="background:var(--bg2);opacity:${s.active?1:.55}">
      <div class="relative w-10 h-10 flex-shrink-0">
        ${logoHtml}
        ${fallbackHtml}
      </div>
      <div class="flex-1 min-w-0">
        <p class="font-bold text-sm truncate">${s.name}</p>
        <p class="text-[10px]" style="color:${urgent?'var(--wn)':'var(--t2)'}">
          ${freqLabel[s.frequency]||s.frequency} · Prossimo: ${s.nextDate}${urgent?` (fra ${daysUntil}gg!) ⚠️`:''}
        </p>
      </div>
      <div class="text-right">
        <p class="font-black text-sm" style="color:var(--acc)">${fmt(s.amount)}</p>
        <p class="text-[9px]" style="color:var(--t2)">${fmt(mo)}/mo</p>
      </div>
      <div class="flex flex-col gap-1 ml-1">
        <button onclick='toggleSub(${JSON.stringify(normId(s.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:var(--card);color:var(--t2)">${s.active?'Pausa':'Attiva'}</button>
        <button onclick='deleteSub(${JSON.stringify(normId(s.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:rgba(255,59,92,.1);color:var(--bd)">Elimina</button>
      </div>
    </div>`;
  }).join('');
}
function renderSubsMini(){
  const el=document.getElementById('subsMini');
  if(!el) return;
  const subs=(UserConfig.subscriptions||[]).filter(s=>s.active);
  if(!subs.length){el.innerHTML='<p class="text-xs" style="color:var(--t2)">Nessun abbonamento attivo</p>';return;}
  const monthly=subs.reduce((t,s)=>t+subMonthlyAmount(s),0);
  el.innerHTML=`<div class="flex justify-between items-baseline gap-3">
    <p class="text-xs leading-tight" style="color:var(--t2)">${subs.length} abbonamento${subs.length>1?'i':''} attivi</p>
    <p class="font-black text-sm leading-tight" style="color:var(--acc);font-variant-numeric:tabular-nums">${fmt(monthly)}/mese</p>
  </div>`;
}
function openSubsM(){
  haptic();
  if(!UserConfig.subscriptions) UserConfig.subscriptions=[];
  const now=new Date(); now.setDate(now.getDate()+30);
  document.getElementById('subNextDate').valueAsDate=now;
  renderSubsList();
  openModal('subsM');
}

/* ============================================================
   INVESTIMENTI
============================================================ */
function getMainCurrencyCode(){
  const s=String(UserConfig.currency||'€').trim();
  if(s==='$') return 'USD';
  if(s==='£') return 'GBP';
  if(s==='CHF'||s==='Fr') return 'CHF';
  return 'EUR';
}
function convertToMainCurrency(amount, fromCode){
  if(!amount||!Number.isFinite(amount)) return 0;
  const from=String(fromCode||'').toUpperCase().trim()||'EUR';
  const main=getMainCurrencyCode();
  if(from===main) return amount;
  const fx=UserConfig.fx||{EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
  const fromRate=Number(fx[from])||1;
  const mainRate=Number(fx[main])||1;
  return (amount/fromRate)*mainRate;
}
function computeInvestSummary(){
  const invs=UserConfig.investments||[];
  const quotes=AppState.investQuotes||{};
  let totalValue=0;
  let totalCost=0;
  invs.forEach(inv=>{
    const qty=+inv.quantity||0;
    if(!qty) return;
    const invCurr=(inv.currency||'EUR').toUpperCase();
    const buy=inv.buyPrice!=null?+inv.buyPrice:0;
    if(buy>0) totalCost+=convertToMainCurrency(buy*qty,invCurr);
    const sym=(inv.symbol||'').toUpperCase();
    const q=quotes[sym];
    const price=q && typeof q.price==='number'?q.price:0;
    if(price>0) totalValue+=convertToMainCurrency(price*qty,invCurr);
  });
  const pnl=totalValue-totalCost;
  return { totalValue, totalCost, pnl };
}
function renderInvestMini(currentValue, effectiveNet){
  const el=document.getElementById('investMini');
  if(!el) return;
  const invs=UserConfig.investments||[];
  if(!invs.length){
    el.innerHTML='<p class="text-xs" style="color:var(--t2)">Nessun investimento salvato</p>';
    return;
  }
  const sum=computeInvestSummary();
  const val=sum.totalValue||0;
  const pnl=sum.pnl||0;
  const col=pnl>=0?'var(--ok)':'var(--bd)';
  const lblPnl=pnl>=0?`+${fmt(pnl)}`:fmt(pnl);
  const includeInv = UserConfig.investIncludeInTotal!==false;
  const linkLabel=includeInv?'Inclusi nel Patrimonio':'Separati dal Patrimonio';
  el.innerHTML=`<div class="space-y-1.5">
    <div class="flex justify-between items-baseline gap-2">
      <p class="text-xs leading-tight" style="color:var(--t2)">${invs.length} posizione${invs.length>1?'i':''}</p>
      <p class="font-black text-sm leading-tight" style="color:${col};font-variant-numeric:tabular-nums">${fmt(val)}</p>
    </div>
    <p class="text-[10px]" style="color:${col}">${lblPnl} rispetto al costo totale</p>
    <button onclick="openInvestM()" class="mt-1 text-[10px] font-bold px-2 py-1 rounded-lg" style="background:var(--bg2);color:var(--t2)">${linkLabel}</button>
  </div>`;
}
async function refreshInvestQuotes(force=false){
  try{
    const invs = (UserConfig.investments||[]).filter(i=>i.symbol && i.quantity>0);
    if(!invs.length) return;

    // Throttle: avoid refreshing more than once every 1 minute unless forced
    const now = Date.now();
    if(!force && AppState._lastQuoteRefresh && (now - AppState._lastQuoteRefresh < 60000)) return;

    const symbols = [...new Set(invs.map(i=>normYahooSymbol(i.symbol)).filter(Boolean))];
    if(!symbols.length) return;

    const quotes = { ...(AppState.investQuotes||{}) };
    const url = yahooProxy('quote', { symbols: symbols.join(',') });
    const resp = await fetch(url);
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data?.quoteResponse?.result;
    if(!Array.isArray(results)) throw new Error('Yahoo quoteResponse non valido');
    for(const r of results){
      const sym = String(r?.symbol||'').trim().toUpperCase();
      const price = parseYahooPrice(r?.regularMarketPrice ?? r?.regularMarketPreviousClose);
      if(sym && price!=null) quotes[sym] = { price, at: now, raw: r };
      // opportunistic profile cache
      if(sym){
        AppState.investProfiles = AppState.investProfiles || {};
        const prof = AppState.investProfiles[sym] || {};
        const autoLogo = `https://s3-symbol-logo.tradingview.com/${sym.split('.')[0].toLowerCase()}.svg`;
        AppState.investProfiles[sym] = {
          name: prof.name || r.shortName || r.longName || sym,
          currency: prof.currency || r.currency || '',
          logoUrl: prof.logoUrl || autoLogo,
        };
        // Auto-assign logoUrl to investments that don't have one yet
        const matchInv = (UserConfig.investments||[]).find(i => normYahooSymbol(i.symbol) === sym);
        if (matchInv && !matchInv.logoUrl) {
          matchInv.logoUrl = autoLogo;
          DatabaseService._saveInvestments();
        }
      }
    }

    AppState.investQuotes = quotes;
    AppState._lastQuoteRefresh = now;
    renderAll('dash');
  }catch(e){
    console.warn('Yahoo refresh failure',e);
    if(force) toast('Errore aggiornamento prezzi','error');
  }
}
async function addInvestment(){
  const symEl=document.getElementById('invSymbol');
  const qtyEl=document.getElementById('invQty');
  const curEl=document.getElementById('invCurrency');
  const buyEl=document.getElementById('invBuy');
  const accEl=document.getElementById('invAccount');
  const nameEl=document.getElementById('invName');
  const noteEl=document.getElementById('invNote');
  const sym=normYahooSymbol((symEl?.value||''));
  const qty=parseFloat(qtyEl?.value||'0');
  if(!sym){ toast('Inserisci il simbolo (es. AAPL, ENI.MI)','warn'); return; }
  if(!qty || qty<=0){ toast('Inserisci una quantità valida','error'); return; }
  const ok = await validateInvestSymbol(sym);
  if(!ok){
    toast('Simbolo non trovato. Seleziona un titolo dalla lista.', 'error');
    return;
  }
  const profiles = AppState.investProfiles || {};
  const prof = profiles[sym] || null;
  const autoCurrency = prof && prof.currency ? String(prof.currency).toUpperCase() : '';
  const autoName = prof && prof.name ? prof.name : '';
  const autoLogo = prof && prof.logoUrl ? prof.logoUrl : '';
  const inv={
    symbol:sym,
    name:(nameEl?.value||'').trim() || autoName || sym,
    quantity:qty,
    currency:(curEl?.value||'').trim().toUpperCase() || autoCurrency || 'EUR',
    buyPrice:parseFloat(buyEl?.value||'0')||null,
    account:(accEl?.value||'').trim(),
    note:(noteEl?.value||'').trim(),
    logoUrl:autoLogo||'',
    includeInTotal:document.getElementById('invIncludeTotal')?.checked!==false,
  };
  await DatabaseService.saveInvestment(inv);
  try{
    if(symEl) symEl.value='';
    if(nameEl) nameEl.value='';
    if(qtyEl) qtyEl.value='';
    if(noteEl) noteEl.value='';
  }catch(e){}
  try{ localStorage.setItem('mpx_investments',JSON.stringify(UserConfig.investments||[])); }catch(e){}
  toast('Investimento salvato ✓','success');
  await refreshInvestQuotes();
  renderInvestList();
  renderAll('dash');
}
async function deleteInvestment(id){
  await DatabaseService.deleteInvestment(id);
  try{ localStorage.setItem('mpx_investments',JSON.stringify(UserConfig.investments||[])); }catch(e){}
  renderInvestList();
  renderAll('dash');
}
function renderInvestList(){
  const el=document.getElementById('investList');
  if(!el) return;
  const invs=UserConfig.investments||[];
  if(!invs.length){
    el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessun investimento salvato.</p>';
    return;
  }
  const { totalValue,totalCost,pnl }=computeInvestSummary();
  const quotes=AppState.investQuotes||{};
  const col=pnl>=0?'var(--ok)':'var(--bd)';
  const header=document.getElementById('investTotals');
  if(header){
    header.innerHTML=`<div class="flex justify-between items-center">
      <div>
        <p class="text-[10px] font-bold uppercase tracking-wider mb-1" style="color:var(--t2)">Valore corrente</p>
        <p class="text-xl font-black" style="color:${col}">${fmt(totalValue)}</p>
      </div>
      <div class="text-right">
        <p class="text-[10px] font-bold uppercase tracking-wider mb-1" style="color:var(--t2)">P/L totale</p>
        <p class="text-sm font-black" style="color:${col}">${pnl>=0?'+':''}${fmt(pnl)}</p>
      </div>
    </div>`;
  }
  el.innerHTML=invs.map(inv=>{
    const sym=(inv.symbol||'').toUpperCase();
    const invCurr=(inv.currency||'EUR').toUpperCase();
    const q=quotes[sym];
    const price=q && typeof q.price==='number'?q.price:null;
    const qty=+inv.quantity||0;
    const valRaw=price?price*qty:0;
    const buy=inv.buyPrice!=null?+inv.buyPrice:0;
    const costRaw=buy>0?buy*qty:0;
    const val=convertToMainCurrency(valRaw,invCurr);
    const cost=convertToMainCurrency(costRaw,invCurr);
    const pnlRow=val-cost;
    const colRow=pnlRow>=0?'var(--ok)':'var(--bd)';
    return `<div class="flex items-center justify-between gap-3 p-3 rounded-2xl" style="background:var(--bg2)">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center overflow-hidden" style="background:var(--card)">
            ${inv.logoUrl?`<img src="${inv.logoUrl}" alt="${sym}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'; this.parentElement.innerHTML='<span class=\'text-xs font-black\'>${sym}</span>'">`:`<span class="text-xs font-black">${sym}</span>`}
          </div>
          <div class="min-w-0">
            <p class="text-sm font-bold truncate">${inv.name||sym}</p>
            <p class="text-[10px]" style="color:var(--t2)">${qty} · ${buy?('Costo medio '+fmt(convertToMainCurrency(buy,invCurr))):''}</p>
          </div>
        </div>
      </div>
      <div class="text-right text-xs">
        <p class="font-bold" style="color:${price?'var(--t)': 'var(--t3)'}">${price?fmt(convertToMainCurrency(price,invCurr)):'—'}</p>
        <p class="font-black" style="color:${colRow}">${price?fmt(val):'—'}</p>
        ${price?`<p class="text-[10px]" style="color:${colRow}">${pnlRow>=0?'+':''}${fmt(pnlRow)}</p>`:''}
      </div>
      <button onclick='deleteInvestment(${JSON.stringify(normId(inv.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:rgba(255,59,92,.1);color:var(--bd)">Elimina</button>
    </div>`;
  }).join('');
}
function openInvestM(){
  haptic();
  if(!UserConfig.investments) UserConfig.investments=[];
  renderInvestList();
  openModal('investM');
  refreshInvestQuotes();
}
function openInvestOnboard(){
  try{
    const toggle=document.getElementById('invIncludeToggle');
    if(toggle) toggle.checked=UserConfig.investIncludeInTotal!==false;
  }catch(e){}
  openModal('investOnboardM');
}
function skipInvestOnboard(){
  try{ localStorage.setItem('mpxInvestOnboardDone','1'); }catch(e){}
  closeAll(true);
}
function saveInvestOnboard(){
  const include=document.getElementById('invIncludeToggle')?.checked!==false;
  try{
    localStorage.setItem('mpxInvestOnboardDone','1');
    UserConfig.investIncludeInTotal=include;
    DatabaseService.pushSettings();
    toast('Configurazione completata! ✓','success');
    closeAll();
    refreshInvestQuotes(true);
    renderAll('dash');
  }catch(e){ toast('Errore nel salvataggio','error'); }
}

function yahooProxy(endpoint, params){
  const qs = new URLSearchParams({ endpoint, ...params });
  return '/api/yahoo?' + qs.toString();
}
function parseYahooPrice(v){
  if(v==null) return null;
  if(typeof v==='number') return Number.isFinite(v)?v:null;
  if(typeof v==='object'&&v!==null&&typeof v.raw==='number') return Number.isFinite(v.raw)?v.raw:null;
  const n=parseFloat(v);
  return Number.isFinite(n)?n:null;
}
function normYahooSymbol(input){
  const raw = String(input||'').trim().toUpperCase().replace(/\s+/g,'');
  if(!raw) return '';
  // Legacy ENI:XMIL -> ENI.MI
  if(raw.includes(':')){
    const [sym, ex] = raw.split(':');
    const exch = (ex||'').trim();
    if(exch==='XMIL') return (sym||'').trim()+'.MI';
    return (sym||'').trim();
  }
  // Yahoo US stocks: AAPL.US -> AAPL (Yahoo uses plain ticker)
  if(raw.endsWith('.US')) return raw.slice(0,-3);
  return raw;
}
async function searchInvestSymbols(e){
  const input = e && e.target ? e.target : document.getElementById('invSymbol');
  const box = document.getElementById('invSymbolSuggest');
  if(!input || !box) return;
  const q = (input.value||'').trim();
  AppState.investSearch = AppState.investSearch || {query:'',results:[]};
  if(q.length < 2){
    box.innerHTML='';
    box.classList.add('hidden');
    AppState.investSearch.query = q;
    AppState.investSearch.results = [];
    return;
  }
  const results = AppState.investSearch.results || [];
  if(q === AppState.investSearch.query){
    if(results.length){
      box.innerHTML = results.slice(0,10).map(r=>{
        const fullSym = String(r.symbol||'').toUpperCase();
        const desc = r.shortname||r.longname||r.name||fullSym;
        const exch = r.exchDisp||r.exchange||'';
        return `<button type="button" class="w-full text-left px-3 py-2 text-[11px] hover:bg-[var(--bg2)]" onmousedown="selectInvestSymbol('${fullSym}', ${JSON.stringify(desc).replace(/"/g,'&quot;')})"><div class="font-bold">${fullSym} <span class="text-[9px] opacity-70">${exch?'('+exch+')':''}</span></div><div style="color:var(--t2)">${desc}</div><div class="mt-0.5" style="color:var(--t3)">${[r.quoteType,r.currency].filter(Boolean).join(' · ')||'—'}</div></button>`;
      }).join('');
      box.classList.remove('hidden');
    }
    return;
  }
  AppState.investSearch.query = q;
  
  try{
    const url = yahooProxy('search', { q, quotesCount:'10', newsCount:'0', enableFuzzyQuery:'true' });
    const resp = await fetch(url);
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = Array.isArray(data?.quotes) ? data.quotes : [];
    AppState.investSearch.results = results;
    if(!results.length){
      box.innerHTML = '<div class="px-3 py-2 text-[10px]" style="color:var(--t3)">Nessun risultato.</div>';
      box.classList.remove('hidden');
      return;
    }

    box.innerHTML = results.slice(0, 10).map(r => {
      const fullSym = String(r.symbol || '').toUpperCase();
      const desc = r.shortname || r.longname || r.name || fullSym;
      const exch = r.exchDisp || r.exchange || '';
      
      return `<button type="button" class="w-full text-left px-3 py-2 text-[11px] hover:bg-[var(--bg2)]" onmousedown="selectInvestSymbol('${fullSym}', ${JSON.stringify(desc).replace(/"/g, '&quot;')})">
        <div class="font-bold">${fullSym} <span class="text-[9px] opacity-70">${exch?('('+exch+')'):''}</span></div>
        <div style="color:var(--t2)">${desc}</div>
        <div class="mt-0.5" style="color:var(--t3)">${[r.quoteType, r.currency].filter(Boolean).join(' · ') || '—'}</div>
      </button>`;
    }).join('');
    box.classList.remove('hidden');
  }catch(err){
    console.warn('invest.search',err);
    const msg = (err && err.message) ? err.message : 'Errore nella ricerca';
    box.innerHTML = '<div class="px-3 py-2 text-[10px]" style="color:var(--bd)">' + (msg.includes('Invalid')||msg.includes('401') ? 'Chiave API non valida.' : msg.includes('429')||msg.includes('limit') ? 'Limite richieste superato. Riprova più tardi.' : 'Errore: ' + String(msg)) + '</div>';
    box.classList.remove('hidden');
  }
}

function selectInvestSymbol(sym, desc){
  const input = document.getElementById('invSymbol');
  const nameEl = document.getElementById('invName');
  const box = document.getElementById('invSymbolSuggest');
  if(input) input.value = sym;
  if(nameEl && !nameEl.value) nameEl.value = desc || sym;
  if(box){
    box.innerHTML = '';
    box.classList.add('hidden');
  }
  try{ if(input) input.blur(); }catch(e){}
  try{ fetchInvestProfile(sym); }catch(e){}
}

async function validateInvestSymbol(sym){
  const s = normYahooSymbol(sym);
  if(!s) return false;
  try{
    const url = yahooProxy('quote', { symbols: s });
    const resp = await fetch(url);
    if(!resp.ok) return false;
    const data = await resp.json();
    const results = data?.quoteResponse?.result;
    if(!Array.isArray(results) || !results.length) return false;
    return results.some(r => String(r?.symbol||'').trim().toUpperCase() === s && parseYahooPrice(r?.regularMarketPrice ?? r?.regularMarketPreviousClose) != null);
  }catch(e){ return false; }
}

async function fetchInvestProfile(sym){
  const symbol = normYahooSymbol(sym);
  if(!symbol) return;
  try{
    const url = yahooProxy('quote', { symbols: symbol });
    const resp = await fetch(url);
    if(!resp.ok) return;
    const data = await resp.json();
    const r = data?.quoteResponse?.result?.[0];
    if(!r) return;
    
    // Tenta di indovinare la logoUrl (Ticker -> Logo)
    // Usiamo un servizio pubblico affidabile per i loghi dei ticker
    let logoUrl = `https://s3-symbol-logo.tradingview.com/${symbol.split('.')[0].toLowerCase()}.svg`;
    
    // Se è un titolo italiano o altro mercato, proviamo a pulire il simbolo
    const cleanSym = symbol.split('.')[0].toUpperCase();
    
    AppState.investProfiles = AppState.investProfiles || {};
    const prof = {
      name: r.shortName || r.longName || symbol,
      currency: r.currency || '',
      logoUrl: logoUrl,
    };
    AppState.investProfiles[symbol] = prof;
    
    const nameEl = document.getElementById('invName');
    const curEl  = document.getElementById('invCurrency');
    if(nameEl && !nameEl.value && prof.name) nameEl.value = prof.name;
    if(curEl && prof.currency) curEl.value = prof.currency;
    
    // Verifica se il logo esiste effettivamente (opzionale, ma utile)
    // Lo facciamo pigramente: renderInvestList lo caricherà e se fallisce userà il fallback
  } catch(e) {
    console.warn('invest.profile',e);
  }
}

/* ============================================================
   GOALS MANAGER (multipli)
============================================================ */
async function addGoal(){
  const name=document.getElementById('goalNameI')?.value.trim();
  const target=parseFloat(document.getElementById('goalTargetI')?.value)||0;
  const current=parseFloat(document.getElementById('goalCurrentI')?.value)||0;
  const deadline=document.getElementById('goalDeadlineI')?.value||'';
  if(!name){toast('Inserisci un nome per l\'obiettivo','warn');return;}
  if(!target||target<=0){toast('Inserisci un target valido','error');return;}
  if(!UserConfig.goals) UserConfig.goals=[];
  await DatabaseService.saveGoal({name,target,current:Math.min(current,target),deadline,completed:false});
  document.getElementById('goalNameI').value='';
  document.getElementById('goalTargetI').value='';
  document.getElementById('goalCurrentI').value='';
  saveConfig(); renderGoalsList();
  toast(`Obiettivo "${name}" aggiunto ✓`,'success');
}
async function deleteGoal(id){
  await DatabaseService.deleteGoal(id);
  saveConfig(); renderGoalsList();
}
async function depositGoal(id){
  const g=(UserConfig.goals||[]).find(x=>idEq(x.id,id));
  if(!g) return;
  const v=parseFloat(prompt(`Aggiungi risparmio a "${g.name}":`)||0);
  if(!v||v<=0) return;
  const nextCurrent=Math.min(g.target,g.current+v);
  const completed=nextCurrent>=g.target;
  await DatabaseService.updateGoal(g.id,{current:nextCurrent,completed});
  if(completed){ launchConfetti(); toast(`🎉 Obiettivo "${g.name}" raggiunto!`,'success'); }
  saveConfig(); renderGoalsList();
}
function renderGoalsList(){
  const el=document.getElementById('goalsList');
  if(!el) return;
  const goals=(UserConfig.goals||[]);
  if(!goals.length){el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessun obiettivo. Aggiungine uno!</p>';return;}
  el.innerHTML=goals.map(g=>{
    const tgt=+g.target||0;
    const cur=+g.current||0;
    const pct=tgt>0 ? Math.min(100,Math.round(cur/tgt*100)) : 0;
    const col=g.completed?'var(--ok)':pct>=75?'var(--ok)':pct>=40?'var(--wn)':'var(--br)';
    const daysLeft=g.deadline?Math.ceil((new Date(g.deadline)-new Date())/(1000*60*60*24)):-1;
    const monthly=g.deadline&&daysLeft>0?(tgt-cur)/(daysLeft/30):0;
    return `<div class="card p-4">
      <div class="flex justify-between items-start mb-3">
        <div>
          <p class="font-bold">${g.name}${g.completed?' 🎉':''}</p>
          ${g.deadline?`<p class="text-[10px]" style="color:var(--t2)">${daysLeft>0?`Mancano ${daysLeft} giorni`:daysLeft===0?'Scade oggi!':'Scaduto'}</p>`:''}
        </div>
        <div class="text-right">
          <p class="font-black text-lg" style="color:${col}">${pct}%</p>
          <div class="flex gap-1">
            <button onclick='depositGoal(${JSON.stringify(normId(g.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:rgba(0,102,255,.1);color:var(--br)">+</button>
            <button onclick='deleteGoal(${JSON.stringify(normId(g.id))})' class="px-2 py-1 rounded-lg text-[9px] font-bold" style="background:rgba(255,59,92,.1);color:var(--bd)">×</button>
          </div>
        </div>
      </div>
      <div class="w-full h-2.5 rounded-full overflow-hidden mb-2" style="background:var(--bg2)">
        <div style="width:${pct}%;height:100%;background:${col};border-radius:99px;transition:width 1s ease"></div>
      </div>
      <div class="flex justify-between text-[10px]" style="color:var(--t2)">
        <span>${fmt(cur)} risparmiati</span>
        <span>Target: ${fmt(tgt)}</span>
      </div>
      ${monthly>0&&!g.completed?`<p class="text-[10px] mt-1" style="color:var(--wn)">⚡ Risparmia ${fmt(monthly)}/mese per raggiungere l'obiettivo</p>`:''}
    </div>`;
  }).join('');
}
function openGoalsM(){ haptic(); renderGoalsList(); openModal('goalsM'); }

/* ============================================================
   NET WORTH HISTORY CHART
============================================================ */
function openNetworthM(){
  haptic();
  openModal('networthM');
  renderNetworthChart();
}
function renderNetworthChart(){
  const canvas=document.getElementById('networthChart');
  if(!canvas) return;
  // Costruisce net worth mensile
  const now=new Date();
  const months=Array.from({length:12},(_,i)=>{
    const d=new Date(now.getFullYear(),now.getMonth()-11+i,1);
    return d;
  });
  const labels=months.map(d=>d.toLocaleDateString('it-IT',{month:'short',year:'2-digit'}));
  
  // Total initial balance of all accounts
  let initialBalanceAll = 0;
  if(UserConfig._accounts) UserConfig._accounts.forEach(a => initialBalanceAll += +a.initialBalance || 0);

  const netWorthByMonth=months.map(d=>{
    const upTo=new Date(d.getFullYear(),d.getMonth()+1,0);
    let nw = initialBalanceAll;
    AppState.transactions.forEach(t=>{
      if(new Date(t.date+'T12:00')<=upTo && t.type!=='transfer'){
        nw+=t.type==='income'?+t.amount:-+t.amount;
      }
    });
    return nw;
  });
  if(AppState.charts.networth) AppState.charts.networth.destroy();
  const ctx=canvas.getContext('2d');
  const pos=netWorthByMonth[netWorthByMonth.length-1]>=0;
  
  // Create gradient for networth
  let gradientNw = pos ? 'rgba(0,200,150,0.1)' : 'rgba(255,59,92,0.1)';
  if (ctx) {
    gradientNw = ctx.createLinearGradient(0, 0, 0, 240);
    if(pos) {
      gradientNw.addColorStop(0, 'rgba(0,200,150,0.2)');
      gradientNw.addColorStop(1, 'rgba(0,200,150,0)');
    } else {
      gradientNw.addColorStop(0, 'rgba(255,59,92,0.2)');
      gradientNw.addColorStop(1, 'rgba(255,59,92,0)');
    }
  }

  AppState.charts.networth=new Chart(ctx,{
    type:'line',
    data:{labels,datasets:[{
      label:'Patrimonio Netto',
      data:netWorthByMonth,
      borderColor:pos?'var(--ok)':'var(--bd)',
      backgroundColor:gradientNw,
      fill:true,tension:.4,pointRadius:0,
      borderWidth: 3,
      pointHoverRadius: 6,
      pointHoverBackgroundColor: pos?'var(--ok)':'var(--bd)',
    }]},
    options:{
      responsive:true,
      maintainAspectRatio: false,
      animation: { duration: 1500, easing: 'easeOutExpo' },
      plugins:{legend:{display:false}, tooltip: { displayColors: false, padding: 12 }},
      scales:{
        y:{ticks:{callback:v=>fmtShort(v), color: resolveCol('var(--t3)')}, grid: { color: 'rgba(0,0,0,0.02)' }},
        x:{ticks:{color: resolveCol('var(--t3)')}, grid: { display: false }}
      }
    }
  });
  // stats box
  const first=netWorthByMonth[0];
  const last=netWorthByMonth[netWorthByMonth.length-1];
  const change=last-first;
  const pctChange=first!==0?Math.round(change/Math.abs(first)*100):0;
  const statsEl=document.getElementById('networthStats');
  if(statsEl) statsEl.innerHTML=`
    <div class="sch text-center"><p class="text-[9px] font-bold uppercase" style="color:var(--t2)">Ora</p><p class="font-black text-base" style="color:${last>=0?'var(--ok)':'var(--bd)'}">${fmtShort(last)}</p></div>
    <div class="sch text-center"><p class="text-[9px] font-bold uppercase" style="color:var(--t2)">Variazione</p><p class="font-black text-base" style="color:${change>=0?'var(--ok)':'var(--bd)'}">${change>=0?'+':''}${fmtShort(change)}</p></div>
    <div class="sch text-center"><p class="text-[9px] font-bold uppercase" style="color:var(--t2)">12 Mesi %</p><p class="font-black text-base" style="color:${pctChange>=0?'var(--ok)':'var(--bd)'}">${pctChange>=0?'+':''}${pctChange}%</p></div>
  `;
}
// Aliases
function openGoals(){ openGoalsM(); }
function openDebts(){ openDebtsM(); }
function openSubs(){ openSubsM(); }
function openNetworth(){ openNetworthM(); }

function renderRecurringBadge(){
  // nothing to render here — placeholder for badge logic
}
async function injectRecurring(){
  // Auto-add recurring txs if not already added today
  if(!UserConfig.recurringTxs||!UserConfig.recurringTxs.length) return;
  const today=fmtDate(new Date());
  let added=false;
  for(const r of UserConfig.recurringTxs){
    const alreadyToday=AppState.transactions.some(t=>t.date===today&&t.description===r.description&&+t.amount===+r.amount);
    if(!alreadyToday&&r.nextDate<=today){
      const payload={...r,id:'local_rec_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),date:today};
      if(!payload.time) payload.time=nowTimeHM();
      delete payload.nextDate;
      AppState.transactions.push(payload);
      r.nextDate=fmtDate(new Date(today)); // update
      added=true;

      // Persist immediately when online
      if(!OFFLINE&&db){
        try{
          if(payload.type==='transfer'){
            const desc=payload.description||`Giro ${payload.account}→${payload.account_to}`;
            const res=await dbInsertTxRow(toDbPayload(payload,'transfer',desc));
            if(res.error) throw res.error;
            const newId=res.data?.[0]?.id;
            if(newId){
              payload.id=newId;
              delete payload._partner_id;
              delete payload._transfer_ref;
              await DatabaseService.saveTxMetaStrict(newId,{account_to:payload.account_to||null,tags:'[]'});
            }
            DatabaseService.updateAccountBalance(payload.account);
            if(payload.account_to) DatabaseService.updateAccountBalance(payload.account_to);
          } else {
            const res=await dbInsertTxRow(toDbPayload(payload));
            if(res.error) throw res.error;
            const newId=res.data?.[0]?.id;
            if(newId){
              payload.id=newId;
              const tags=payload.tags||'[]';
              const account_to=payload.account_to||null;
              if(account_to||tags!=='[]') await DatabaseService.saveTxMeta(newId,{account_to,tags});
              DatabaseService.updateAccountBalance(payload.account);
            }
          }
        }catch(e){ console.warn('recurring.inject DB',e); }
      }
    }
  }
  if(added){ saveTransactions(); saveConfig(); renderAll(); }
}

// 12. SPENDING STREAKS
function getStreakDays(){
  const dates=new Set(AppState.transactions.map(t=>t.date));
  let streak=0,d=new Date();
  for(let i=0;i<365;i++){
    const k=fmtDate(d);
    if(dates.has(k)) streak++;
    else break;
    d.setDate(d.getDate()-1);
  }
  return streak;
}

// 13. MONTHLY COMPARISON
function getMonthlyDiff(){
  const now=new Date();
  const cur=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const prev=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');const pm=new Date(now.getFullYear(),now.getMonth()-1,1);return d.getMonth()===pm.getMonth()&&d.getFullYear()===pm.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  if(!prev) return {diff:0,pct:0};
  return {diff:cur-prev,pct:Math.round((cur-prev)/prev*100)};
}

// 14. LARGEST EXPENSES THIS MONTH
function getTopExpenses(n=5){
  const now=new Date();
  return AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).sort((a,b)=>+b.amount- +a.amount).slice(0,n);
}

// 15. NET WORTH HISTORY
function getNetWorthHistory(){
  const months=[];
  const now=new Date();
  // sum of all account initial balances
  const initSum=(UserConfig._accounts||[]).reduce((s,a)=>s+(a.initialBalance||0),0);
  for(let i=11;i>=0;i--){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const endOfMonth=new Date(d.getFullYear(),d.getMonth()+1,0);
    const upToDate=AppState.transactions.filter(t=>new Date(t.date+'T12:00')<=endOfMonth);
    let net=initSum;
    // accumulate all non-transfer transactions
    upToDate.filter(t=>t.type!=='transfer').forEach(t=>{ net+=t.type==='income'?+t.amount:-+t.amount; });
    months.push({label:d.toLocaleDateString('it-IT',{month:'short',year:'2-digit'}),net});
  }
  return months;
}

// 16. PIN LOCK
function enablePin(){
  const p=prompt('Scegli un PIN a 4 cifre:');
  if(!p||!/^\d{4}$/.test(p)){toast('PIN deve essere 4 cifre','error');return;}
  UserConfig.pin=p; UserConfig.pinEnabled=true; saveConfig();
  toast('PIN impostato ✓','success');
}
function disablePin(){ UserConfig.pin=''; UserConfig.pinEnabled=false; saveConfig(); toast('PIN rimosso','warn'); }
function pinKey(k){
  if(k==='C'){AppState.pinBuffer='';updatePinDots();return;}
  if(k==='⌫'){AppState.pinBuffer=AppState.pinBuffer.slice(0,-1);updatePinDots();return;}
  if(AppState.pinBuffer.length>=4) return;
  AppState.pinBuffer+=k;
  updatePinDots();
  if(AppState.pinBuffer.length===4){
    if(AppState.pinBuffer===UserConfig.pin) unlockApp();
    else{ toast('PIN errato','error'); setTimeout(()=>{AppState.pinBuffer='';updatePinDots();},600); }
  }
}
function updatePinDots(){
  ['pinD1','pinD2','pinD3','pinD4'].forEach((id,i)=>{
    const d=document.getElementById(id);
    if(d) d.style.background=i<AppState.pinBuffer.length?'var(--br)':'var(--bg2)';
  });
}
function togglePinSetting(v){
  if(v){ enablePin(); }
  else { disablePin(); }
  // sync toggle state
  const tog=document.getElementById('pinToggle');
  if(tog) tog.checked=UserConfig.pinEnabled;
}
function unlockApp(){ document.getElementById('pinScreen').classList.add('hidden'); AppState.pinBuffer=''; }

// 17. FILTER BY TAG
function filterByTag(tag){
  document.getElementById('sQ').value=tag;
  switchTabById('wallets');
  renderList();
}

// 18. BATCH DELETE (by filter)
function deleteFiltered(){
  if(!confirm('Eliminare tutti i movimenti filtrati?')) return;
  const q=(document.getElementById('sQ')?.value||'').toLowerCase();
  AppState.transactions=AppState.transactions.filter(t=>!((t.description||'').toLowerCase().includes(q)||(Categories[t.category_id]?.l||'').toLowerCase().includes(q)));
  saveTransactions(); renderAll(); toast('Movimenti eliminati','warn');
}

// 19. MONTH SELECTOR
function jumpToMonth(offset){
  AppState.viewDate=new Date(AppState.viewDate.getFullYear(),AppState.viewDate.getMonth()+offset,1);
  updateDash();
  setEl('navMonth',AppState.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'}));
}

// 20. CSV IMPORT (full)
let IMP={fmt:null,rows:[],headers:[],_parsed:null,_restoreCfg:null};
function openImpM(){ haptic(); resetImport(); openModal('impM'); }
function selectImpFmt(f){
  IMP.fmt=f;
  document.getElementById('fmtCSV').style.borderColor=f==='csv'?'var(--br)':'var(--bo)';
  document.getElementById('fmtJSON').style.borderColor=f==='json'?'var(--br)':'var(--bo)';
  document.getElementById('dropZ').classList.remove('hidden');
  document.getElementById('csvInfo').classList.toggle('hidden',f!=='csv');
  document.getElementById('pasteArea').classList.toggle('hidden',f!=='csv');
  document.getElementById('fileIn').accept=f==='csv'?'.csv,.txt':'.json';
  lucide.createIcons();
}
function dragOver(e){e.preventDefault();document.getElementById('dropZ').classList.add('drag');}
function dragLeave(){document.getElementById('dropZ').classList.remove('drag');}
function dropFile(e){e.preventDefault();dragLeave();const f=e.dataTransfer.files[0];if(f)handleFile(f);}
function handleFile(file){
  if(!file) return;
  const r=new FileReader();
  r.onload=ev=>{ if(IMP.fmt==='json') parseJSON(ev.target.result); else parseCSV(ev.target.result); };
  r.readAsText(file,'UTF-8');
}
function parseFromPaste(){
  const txt=document.getElementById('csvPaste')?.value.trim();
  if(!txt){toast('Incolla del testo CSV prima','warn');return;}
  parseCSV(txt);
}
function parseCSV(raw){
  const lines=raw.trim().split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2){toast('File CSV vuoto','error');return;}
  const sep=lines[0].includes(';')?';':lines[0].includes('\t')?'\t':',';
  const splitLine=l=>{const res=[];let cur='',inQ=false;for(const ch of l){if(ch==='"'){inQ=!inQ;}else if(ch===sep&&!inQ){res.push(cur.trim());cur='';}else cur+=ch;}res.push(cur.trim());return res;};
  const firstRow=splitLine(lines[0]);
  const isHeader=firstRow.some(c=>isNaN(c.replace(',','.')));
  IMP.headers=isHeader?firstRow:firstRow.map((_,i)=>'col'+i);
  IMP.rows=( isHeader?lines.slice(1):lines ).map(l=>splitLine(l));
  const h=IMP.headers.map(s=>s.toLowerCase().trim());
  const guess=keys=>{const i=h.findIndex(x=>keys.some(k=>x.includes(k)));return i>=0?IMP.headers[i]:'';};
  ['mapDate','mapTime','mapAmt','mapType','mapDesc'].forEach(id=>{
    const sel=document.getElementById(id);if(!sel)return;
    sel.innerHTML='<option value="">(—)</option>'+IMP.headers.map(hh=>`<option value="${hh}">${hh}</option>`).join('');
  });
  document.getElementById('mapDate').value=guess(['data','date']);
  document.getElementById('mapTime').value=guess(['ora','time','hour','orario']);
  document.getElementById('mapAmt').value=guess(['importo','amount','betrag','debito','credito']);
  document.getElementById('mapType').value=guess(['tipo','type']);
  document.getElementById('mapDesc').value=guess(['nota','note','desc','causale']);
  populateWalletSel();
  document.getElementById('colMap')?.classList.remove('hidden');
  buildPreview();
  showStep2('CSV',IMP.rows.length);
}
function remapPreview(){ buildPreview(); }
function buildPreview(){
  const dateCol=document.getElementById('mapDate')?.value;
  const timeCol=document.getElementById('mapTime')?.value;
  const amtCol=document.getElementById('mapAmt')?.value;
  const typeCol=document.getElementById('mapType')?.value;
  const descCol=document.getElementById('mapDesc')?.value;
  const defAcc=document.getElementById('mapAccDef')?.value||getDefaultAccountName();
  const defType=document.getElementById('mapTypeDef')?.value||'expense';
  const colIdx=name=>IMP.headers.indexOf(name);
  const get=(row,col)=>col&&colIdx(col)>=0?row[colIdx(col)]||'':'';
  const parsed=IMP.rows.map(row=>{
    let date=get(row,dateCol).trim();
    let time=get(row,timeCol).trim();
    // If date field contains a timestamp, split it.
    if(!time && /\d{1,2}[:.]\d{2}/.test(date) && /[ T]/.test(date)){
      const parts=date.split(/[ T]/);
      if(parts.length>=2){
        date=parts[0].trim();
        time=parts.slice(1).join(' ').trim();
      }
    }
    if(/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(date)){const p=date.replace(/\//g,'-').split('-');date=`${p[2]}-${p[1]}-${p[0]}`;}
    time=normTime(time);
    const isValidDate=date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&!isNaN(new Date(date));
    const rawAmt=get(row,amtCol).replace(/[€$£\s]/g,'').replace(',','.');
    const amt=parseFloat(rawAmt);
    const isValidAmt=!isNaN(amt)&&amt!==0;
    let type=get(row,typeCol).toLowerCase().trim();
    if(['expense','uscita','debit','debito'].some(x=>type.includes(x))) type='expense';
    else if(['income','entrata','credit','credito'].some(x=>type.includes(x))) type='income';
    else type=amt<0?'expense':defType;
    const finalAmt=Math.abs(amt);
    const desc=get(row,descCol);
    let cat='other';
    const dl=desc.toLowerCase();
    for(const [k,c] of Object.entries(CATS)){if(c.kw.some(kw=>dl.includes(kw))){cat=k;break;}}
    const isDup=AppState.transactions.some(x=>x.date===date&&Math.abs(+x.amount-finalAmt)<.01&&x.type===type);
    const errors=[];
    if(!isValidDate) errors.push('data');
    if(!isValidAmt) errors.push('importo');
    return {date,time,type,amount:finalAmt,category_id:cat,description:desc,account:defAcc,tags:'[]',errors,isDup,_valid:isValidDate&&isValidAmt};
  });
  renderPreview(parsed);
}
function parseJSON(raw){
  try{
    const obj=JSON.parse(raw);
    const txs=obj.txs||obj.transactions||obj;
    if(!Array.isArray(txs)) throw new Error('Formato non riconosciuto');
    IMP.rows=[];IMP.headers=[];
    document.getElementById('colMap')?.classList.add('hidden');
    const parsed=txs.map(t=>{
      const isDup=AppState.transactions.some(x=>x.date===t.date&&Math.abs(+x.amount- +t.amount)<.01&&x.type===t.type);
      return {...t,errors:[],isDup,_valid:true};
    });
    renderPreview(parsed);
    showStep2('JSON',txs.length);
    if(obj.cfg) IMP._restoreCfg=obj.cfg;
  }catch(err){toast('Errore JSON: '+err.message,'error');}
}
function renderPreview(parsed){
  IMP._parsed=parsed;
  const valid=parsed.filter(r=>r._valid&&!r.isDup);
  const errs=parsed.filter(r=>!r._valid);
  const dups=parsed.filter(r=>r.isDup&&r._valid);
  setEl('impOkCnt',valid.length);setEl('impErrCnt',errs.length);setEl('impDupCnt',dups.length);
  setEl('impConfLbl',`Importa ${valid.length} movimenti`);
  const tbody=document.getElementById('prevBody');
  if(!tbody) return;
  tbody.innerHTML=parsed.slice(0,50).map(r=>{
    const cls=!r._valid?'ter':r.isDup?'twn':'tok';
    return `<tr style="${r.isDup?'opacity:.55':''}">
      <td>${r.date}</td>
      <td>${r.time||''}</td>
      <td>${r.type==='expense'?'↑':r.type==='income'?'↓':'⇄'}</td>
      <td class="${r.type==='expense'?'ter':r.type==='income'?'tok':''}" style="font-variant-numeric:tabular-nums">${fmt(r.amount)}</td>
      <td>${Categories[r.category_id]?.l||r.category_id}</td>
      <td>${r.account||''}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${r.description||'—'}</td>
      <td class="${cls}">${!r._valid?'✗':r.isDup?'⚠':'✓'}</td>
    </tr>`;
  }).join('');
  if(parsed.length>50) tbody.innerHTML+=`<tr><td colspan="8" class="text-center" style="color:var(--t2);padding:.6rem">... e altri ${parsed.length-50}</td></tr>`;
  lucide.createIcons();
}
function showStep2(f,count){
  document.getElementById('impStep1')?.classList.add('hidden');
  document.getElementById('impStep2')?.classList.remove('hidden');
  setEl('impTitle','Anteprima importazione');
  setEl('impSubtitle',`${count} righe · ${f}`);
}
function resetImport(){
  IMP={fmt:null,rows:[],headers:[],_parsed:null,_restoreCfg:null};
  document.getElementById('impStep1')?.classList.remove('hidden');
  document.getElementById('impStep2')?.classList.add('hidden');
  document.getElementById('dropZ')?.classList.add('hidden');
  document.getElementById('csvInfo')?.classList.add('hidden');
  document.getElementById('pasteArea')?.classList.add('hidden');
  document.getElementById('colMap')?.classList.add('hidden');
  document.getElementById('fileIn').value='';
  if(document.getElementById('csvPaste')) document.getElementById('csvPaste').value='';
  ['fmtCSV','fmtJSON'].forEach(id=>{ const el=document.getElementById(id);if(el)el.style.borderColor='var(--bo)'; });
  const tbody=document.getElementById('prevBody');if(tbody)tbody.innerHTML='';
  lucide.createIcons();
}
async function confirmImport(){
  if(!IMP._parsed){toast('Nessun file analizzato','warn');return;}
  const skipDups=document.getElementById('skipDups')?.checked;
  const toImport=IMP._parsed.filter(r=>r._valid&&(!skipDups||!r.isDup));
  if(!toImport.length){toast('Nessun movimento valido','warn');return;}
  const clean=toImport.map(r=>{
    const {errors,isDup,_valid,...rest}=r;
    rest.id='local_imp_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
    return rest;
  });
  clean.forEach(r=>AppState.transactions.push(r));
  saveTransactions();
  if(IMP._restoreCfg){ Object.assign(UserConfig, IMP._restoreCfg); saveConfig(); }
  toast(`✅ Importati ${clean.length} movimenti!`,'success');
  unlockAch('importer');
  closeAll(); resetImport(); renderAll(); checkAch();
  // If online, immediately migrate imported data (and any other local-only data) to Supabase
  if(!OFFLINE&&db){
    setTimeout(()=>{ try{ DatabaseService.migrateAll(); }catch(e){} },300);
  }
}

// 21. CATEGORY RENAME (config extension — UI placeholder)
function renameCat(key, newLabel){
  if(Categories[key]) Categories[key].l=newLabel;
  renderAll();
}

// 22. PERCENTAGE OF INCOME SPENT
function getPctotalIncomecomeSpent(){
  const now=new Date();
  const mTxs=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const inc=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const exp=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  return inc>0 ? Math.round(exp/inc*100) : 0;
}

// 23. DAYS UNTIL NEXT SALARY (based on patterns)
function getDaysUntilSalary(){
  const salaryTxs=AppState.transactions.filter(t=>t.type==='income'&&(t.category_id==='salary'||((t.description||'').toLowerCase().includes('stipendio')))).sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(!salaryTxs.length) return null;
  const lastDate=new Date(salaryTxs[0].date+'T12:00');
  const nextDate=new Date(lastDate);
  nextDate.setMonth(nextDate.getMonth()+1);
  const diff=Math.ceil((nextDate-new Date())/(1000*60*60*24));
  return diff>0?diff:0;
}

// 24. AVERAGE DAILY SPEND (rolling 30d)
function getAvgDaily30(){
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-30);
  const exp=AppState.transactions.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  return Math.round(exp/30*100)/100;
}

// 25. TAG STATS
function getTagStats(){
  const stats={};
  AppState.transactions.forEach(t=>{
    try{(typeof t.tags==='string'?JSON.parse(t.tags):t.tags||[]).forEach(tag=>{stats[tag]=(stats[tag]||0)+ +t.amount;});}catch(e){}
  });
  return stats;
}

// 26. COPY TX AMOUNT TO CLIPBOARD
function copyAmount(id){
  const t=AppState.transactions.find(x=>x.id===id);
  if(!t) return;
  navigator.clipboard?.writeText(t.amount.toString()).then(()=>toast('Importo copiato ✓','success')).catch(()=>toast('Copia non supportata','warn'));
}

// 27. SHARE SUMMARY
function shareSummary(){
  const now=new Date();
  const mTxs=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const totalIncome=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const totalExpense=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const msg=`📊 Riepilogo ${now.toLocaleDateString('it-IT',{month:'long',year:'numeric'})}\n💚 Entrate: ${fmt(totalIncome)}\n❤️ Uscite: ${fmt(totalExpense)}\n💰 Netto: ${fmt(totalIncome-totalExpense)}\n\nGenerato con Money Pro X`;
  if(navigator.share){ navigator.share({title:'Riepilogo Finanziario',text:msg}).catch(()=>{}); }
  else{ navigator.clipboard?.writeText(msg); toast('Riepilogo copiato negli appunti ✓','success'); }
}

// 28. SEARCH SUGGESTIONS
function showSuggestions(){
  const q=(document.getElementById('sQ')?.value||'').toLowerCase();
  if(q.length<2) return;
  const seen=new Set();
  AppState.transactions.forEach(t=>{ if((t.description||'').toLowerCase().includes(q)&&t.description) seen.add(t.description); });
  // just trigger renderList for now
  renderList();
}

// 29. COMPACT VIEW TOGGLE
function toggleCompactView(){
  document.querySelectorAll('.txRow').forEach(el=>el.classList.toggle('compact'));
}

// 30. SCROLL TO TODAY
function scrollToToday(){
  const today=fmtDate(new Date());
  const rows=document.querySelectorAll('.txRow');
  rows.forEach(row=>{
    if(row.textContent.includes(today.split('-').reverse().join('/').slice(0,5))){
      row.scrollIntoView({behavior:'smooth',block:'center'});
    }
  });
}

// 31. MARK AS REVIEWED
function markReviewed(id){
  const t=AppState.transactions.find(x=>x.id===id);
  if(!t) return;
  t._reviewed=true;
  saveTransactions();
  toast('Marcato come revisionato ✓','success');
}

// 32. RENAME WALLET (quick)
async function quickRenameWallet(i){
  const acc=UserConfig._accounts?.[i]; if(!acc) return;
  const name=prompt('Nuovo nome conto:', acc.name);
  if(name&&name.trim()) await renameWallet(acc.id,name.trim(),acc.name);
}

// 33. CATEGORY TOTAL (any period)
function getCatTotal(catKey, months=1){
  const cutoff=new Date(); cutoff.setMonth(cutoff.getMonth()-months);
  return AppState.transactions.filter(t=>t.category_id===catKey&&t.type==='expense'&&new Date(t.date+'T12:00')>=cutoff).reduce((s,t)=>s+ +t.amount,0);
}

// 34. EXPORT REPORT (month)
function exportCurrentMonthPDF(){
  const month=AppState.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'});
  const mTxs=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===AppState.viewDate.getMonth()&&d.getFullYear()===AppState.viewDate.getFullYear();}).sort((a,b)=>new Date(b.date)-new Date(a.date));
  let txt=`MONEY PRO X — Report ${month}\n${'─'.repeat(48)}\n\n`;
  mTxs.forEach(t=>{const c=Categories[t.category_id]||Categories.other;txt+=`${t.date}  ${t.type==='expense'?'-':'+'}${String(fmt(t.amount)).padEnd(12)}  ${c.l.padEnd(18)}  ${t.description||''}\n`;});
  const totalIncome=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const totalExpense=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  txt+=`\n${'─'.repeat(48)}\nEntrate:  ${fmt(totalIncome)}\nUscite:   ${fmt(totalExpense)}\nNetto:    ${fmt(totalIncome-totalExpense)}\nRisparmio: ${totalIncome>0?Math.round((1-totalExpense/totalIncome)*100):0}%\n`;
  download(new Blob([txt],{type:'text/plain;charset=utf-8;'}),`Report_${month.replace(/\s/g,'_')}.txt`);
  toast('Report esportato ✓','success');
}

// 35. AUTO-BACKUP REMINDER
function checkAutoBackup(){
  const last=UserConfig.lastBackup||0;
  const days=Math.floor((Date.now()-last)/(1000*60*60*24));
  if(days>7) toast(`⚠️ Ultimo backup ${days} giorni fa — esporta un backup!`,'warn');
}

// 36. BALANCE PROJECTION (next 30 days)
function getProjectedBalance(){
  const avg30=getAvgDaily30();
  const now=new Date();
  const mTxs=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const totalIncome=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const totalExpense=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const currentNet=totalIncome-totalExpense;
  return currentNet-(avg30*30);
}

// 37. KEYBOARD HINTS
function showKeyboardHints(){
  toast('N=Nuovo  K=Calcolatrice  1-4=Tab  ESC=Chiudi','info');
}

// 38. PRINT VIEW
function printView(){
  window.print();
}

// 39. DARK MODE SCHEDULE (auto)
function scheduleTheme(){
  const h=new Date().getHours();
  const shouldBeDark=h>=21||h<7;
  if(UserConfig.theme==='system'){
    document.body.classList.toggle('dark',shouldBeDark);
  }
}

// 40. DUPLICATE DETECTION REPORT
function getDuplicateCandidates(){
  const seen={};const dups=[];
  AppState.transactions.forEach(t=>{
    const k=`${t.date}_${t.amount}_${t.type}`;
    if(seen[k]) dups.push({existing:seen[k],candidate:t});
    else seen[k]=t;
  });
  return dups;
}

// 41. TRANSACTION COUNT BY CATEGORY
function getCatCounts(){
  const counts={};
  AppState.transactions.filter(t=>t.type!=='transfer').forEach(t=>{counts[t.category_id]=(counts[t.category_id]||0)+1;});
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
}

// 42. FIRST/LAST TX DATE
function getDateRange(){
  if(!AppState.transactions.length) return null;
  const dates=AppState.transactions.map(t=>t.date).sort();
  return {first:dates[0], last:dates[dates.length-1]};
}

// 43. CATEGORY BUDGET ALERT
function checkBudgetAlerts(){
  const now=new Date();
  const alerts=[];
  Object.entries(UserConfig.budgets||{}).forEach(([cat,lim])=>{
    const spent=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return t.category_id===cat&&t.type==='expense'&&d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,t)=>s+ +t.amount,0);
    const pct=spent/lim;
    if(pct>=1) alerts.push({cat,spent,lim,pct,level:'over'});
    else if(pct>=.8) alerts.push({cat,spent,lim,pct,level:'warn'});
  });
  return alerts;
}

// 44. INCOME REGULARITY SCORE
function getotalIncomecomeRegularity(){
  const months12=Array.from({length:12},(_,i)=>{
    const d=new Date(); d.setMonth(d.getMonth()-11+i);
    return AppState.transactions.filter(t=>{const dd=new Date(t.date+'T12:00');return dd.getMonth()===d.getMonth()&&dd.getFullYear()===d.getFullYear()&&t.type==='income';}).reduce((s,t)=>s+ +t.amount,0);
  });
  const withIncome=months12.filter(v=>v>0).length;
  return Math.round(withIncome/12*100);
}

// 45. ESTIMATED ANNUAL SAVINGS
function getEstimatedAnnualSavings(){
  const savingsRate=savingsRateFor(AppState.transactions,new Date());
  const now=new Date();
  const totalIncome=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='income';}).reduce((s,t)=>s+ +t.amount,0);
  return totalIncome*(savingsRate/100)*12;
}

// 46. SPENDING VELOCITY (is this month faster than last?)
function getSpendingVelocity(){
  const now=new Date();
  const dom=now.getDate();
  const curSpend=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const prevMonth=new Date(now.getFullYear(),now.getMonth()-1,1);
  const prevDim=new Date(now.getFullYear(),now.getMonth(),0).getDate();
  const prevSpend=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===prevMonth.getMonth()&&d.getFullYear()===prevMonth.getFullYear()&&t.type==='expense'&&d.getDate()<=dom;}).reduce((s,t)=>s+ +t.amount,0);
  if(!prevSpend) return 0;
  return Math.round((curSpend-prevSpend)/prevSpend*100);
}

// 47. CATEGORY BUDGET CREATION SHORTCUT
function quickBudget(cat, amt){
  UserConfig.budgets[cat]=amt;
  saveConfig();
  renderBudgetMini(AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');const now=new Date();return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}));
  toast(`Budget ${Categories[cat]?.l} impostato a ${fmt(amt)} ✓`,'success');
}

// 48. UPCOMING BILL DETECTOR
function getUpcomingBills(){
  const recurring=AppState.transactions.filter(t=>{try{return (typeof t.tags==='string'?JSON.parse(t.tags):[]).includes('ricorrente')&&t.type==='expense';}catch(e){return false;}});
  const byDesc={};
  recurring.forEach(t=>{const k=t.description||t.category_id;if(!byDesc[k]||new Date(t.date)>new Date(byDesc[k].date)) byDesc[k]=t;});
  const upcoming=[];
  Object.values(byDesc).forEach(t=>{
    const nextDate=new Date(t.date+'T12:00');
    nextDate.setMonth(nextDate.getMonth()+1);
    const diff=Math.ceil((nextDate-new Date())/(1000*60*60*24));
    if(diff>=0&&diff<=14) upcoming.push({...t,daysUntil:diff,nextDate:fmtDate(nextDate)});
  });
  return upcoming.sort((a,b)=>a.daysUntil-b.daysUntil);
}

// 49. MULTI-CURRENCY ACCOUNT TOTALS (show in base currency)
function getWalletTotalsConverted(){
  const totals={};
  const wallets=(UserConfig._accounts||[]).map(a=>a?.name).filter(Boolean);
  wallets.forEach(w=>{
    let bal=0;
    AppState.transactions.forEach(t=>{
      const a=+t.amount||0;
      const acc=String(t.account||'').trim();
      if(!acc) return;
      if(t.type==='transfer'){
        if(acc===w) bal-=a;
        if(t.account_to===w) bal+=a;
      } else if(acc===w){
        bal+=t.type==='income'?a:-a;
      }
    });
    totals[w]=bal;
  });
  return totals;
}

// 50. SMART CATEGORY SUGGESTIONS (based on time of day)
function getSmartCatSuggestion(){
  const h=new Date().getHours();
  if(h>=7&&h<=9) return 'food';      // colazione
  if(h>=12&&h<=14) return 'food';    // pranzo
  if(h>=19&&h<=21) return 'food';    // cena
  if(h>=9&&h<=18) return 'shopping'; // giornata
  return 'other';
}
function applySuggestedCat(){
  const cat=getSmartCatSuggestion();
  const sel=document.getElementById('txCat');
  if(sel&&sel.value==='other') sel.value=cat;
}

/* ============================================================
   INSIGHTS MODAL
============================================================ */
function openInsM(){
  haptic();
  const now=new Date();
  const mTxs=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const totalIncome=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const totalExpense=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const savingsRate=savingsRateFor(AppState.transactions,now);
  renderInsights(mTxs,totalIncome,totalExpense,savingsRate);
  openModal('insM');
}

/* ============================================================
   FILTER TX TYPE (tab toggle)
============================================================ */
function setTxFilter(type, el){
  AppState.txFilter=type;
  document.querySelectorAll('.ftBtn').forEach(b=>b.classList.remove('on'));
  if(el) el.classList.add('on');
  renderList();
}

/* ============================================================
   SYNC STATUS
============================================================ */
async function syncNow(){
  if(OFFLINE){toast('Nessuna connessione al server configurata','warn');return;}
  toast('Sincronizzazione...','info');
  await _syncAllFromDB();
}

function openSbOnboard(){
  try{
    const schemaEl=document.getElementById('sbOnSchemaEl');
    if(schemaEl) schemaEl.textContent = (typeof SQL_SCHEMA !== 'undefined' ? SQL_SCHEMA : '');
    const urlInp=document.getElementById('sbOnUrlInp');
    const keyInp=document.getElementById('sbOnKeyInp');
    if(urlInp) urlInp.value = localStorage.getItem('mpxSbUrl')||'';
    if(keyInp) keyInp.value = '';
  }catch(e){}
  openModal('sbOnboardM');
}
function skipSbOnboard(){
  try{ localStorage.setItem('mpxSbOnboardDone','1'); }catch(e){}
  closeAll(true);
  toast('Ok: puoi configurare Supabase più tardi in Impostazioni','info');
}
function saveSbCredentialsOnboard(){
  const url = document.getElementById('sbOnUrlInp')?.value.trim();
  const key = document.getElementById('sbOnKeyInp')?.value.trim();
  if(!url||!key){toast('Inserisci URL e chiave Supabase','error');return;}
  if(!url.startsWith('https://')){toast('URL deve iniziare con https://','error');return;}
  if(key.startsWith('•')){toast('Inserisci la chiave reale, non i pallini','error');return;}
  try{
    localStorage.setItem('mpxSbUrl', url);
    localStorage.setItem('mpxSbKey', key);
    localStorage.setItem('mpxSbOnboardDone','1');
  }catch(e){}
  toast('✅ Credenziali salvate! Ricarico...','success');
  setTimeout(()=>location.reload(), 800);
}
async function testSbConnectionOnboard(){
  const url=document.getElementById('sbOnUrlInp')?.value.trim();
  const key=document.getElementById('sbOnKeyInp')?.value.trim();
  if(!url||!key||key.startsWith('•')){toast('Inserisci prima URL e chiave validi','warn');return;}
  if(!url.startsWith('https://')){toast('URL deve iniziare con https://','error');return;}
  const btn=document.getElementById('sbOnTestBtn');
  if(btn){btn.textContent='⏳ Test...';btn.disabled=true;}
  try{
    const testDb = window.supabase.createClient(url, key);
    const checks=[
      ['transactions','id'],
      ['transaction_meta','tx_id'],
      ['accounts','id'],
      ['budgets','id'],
      ['categories','id'],
      ['goals','id'],
      ['debts','id'],
      ['subscriptions','id'],
      ['templates','id'],
      ['notes','id'],
      ['settings','key'],
    ];
    const res=await Promise.allSettled(checks.map(([t,c])=>testDb.from(t).select(c).limit(1)));
    const ok=[], bad=[];
    res.forEach((r,i)=>{
      const table=checks[i][0];
      if(r.status!=='fulfilled'){ bad.push({table,err:r.reason}); return; }
      const out=r.value;
      if(out?.error) bad.push({table,err:out.error});
      else ok.push(table);
    });

    if(!ok.length) throw (bad[0]?.err||new Error('Connessione fallita'));
    if(bad.length){
      const missing=bad.map(x=>x.table).join(', ');
      toast(`✅ Connessione OK, ma schema incompleto: ${missing}`,'warn');
      if(btn){btn.textContent='⚠️ Parziale';btn.style.background='var(--wn)';}
    } else {
      toast(`✅ Connessione OK! Schema pronto (${ok.length} tabelle)`,'success');
      if(btn){btn.textContent='✅ Connesso';btn.style.background='var(--ok)';}
    }
  }catch(err){
    toast(`❌ Errore: ${err.message||err.code||JSON.stringify(err)}`,'error');
    if(btn){btn.textContent='❌ Fallito';btn.style.background='var(--bd)';}
  }
  setTimeout(()=>{if(btn){btn.textContent='Testa Connessione';btn.disabled=false;btn.style.background='';}},3000);
}

function saveSbCredentials(){
  const url = document.getElementById('sbUrlInp')?.value.trim();
  const key = document.getElementById('sbKeyInp')?.value.trim();
  if(!url||!key){toast('Inserisci URL e chiave Supabase','error');return;}
  if(!url.startsWith('https://')){toast('URL deve iniziare con https://','error');return;}
  if(key.startsWith('•')){toast('Inserisci la chiave reale, non i pallini','error');return;}
  localStorage.setItem('mpxSbUrl', url);
  localStorage.setItem('mpxSbKey', key);
  toast('✅ Credenziali salvate! Ricarico...','success');
  setTimeout(()=>location.reload(), 800);
}
function clearSbCredentials(){
  if(!confirm('Disconnettere Supabase? I dati locali rimarranno.')) return;
  localStorage.removeItem('mpxSbUrl');
  localStorage.removeItem('mpxSbKey');
  toast('Disconnesso','warn');
  setTimeout(()=>location.reload(), 800);
}
async function testSbConnection(){
  const url=document.getElementById('sbUrlInp')?.value.trim();
  const key=document.getElementById('sbKeyInp')?.value.trim();
  if(!url||!key||key.startsWith('•')){toast('Inserisci prima URL e chiave validi','warn');return;}
  if(!url.startsWith('https://')){toast('URL deve iniziare con https://','error');return;}
  const btn=document.getElementById('sbTestBtn');
  if(btn){btn.textContent='⏳ Test...';btn.disabled=true;}
  try{
    const testDb = window.supabase.createClient(url, key);
    const checks=[
      ['transactions','id'],
      ['transaction_meta','tx_id'],
      ['accounts','id'],
      ['budgets','id'],
      ['categories','id'],
      ['goals','id'],
      ['debts','id'],
      ['subscriptions','id'],
      ['templates','id'],
      ['notes','id'],
      ['settings','key'],
    ];
    const res=await Promise.allSettled(checks.map(([t,c])=>testDb.from(t).select(c).limit(1)));
    const ok=[], bad=[];
    res.forEach((r,i)=>{
      const table=checks[i][0];
      if(r.status!=='fulfilled'){ bad.push({table,err:r.reason}); return; }
      const out=r.value;
      if(out?.error) bad.push({table,err:out.error});
      else ok.push(table);
    });

    if(!ok.length) throw (bad[0]?.err||new Error('Connessione fallita'));
    if(bad.length){
      const missing=bad.map(x=>x.table).join(', ');
      toast(`✅ Connessione OK, ma schema incompleto: ${missing}`,'warn');
      if(btn){btn.textContent='⚠️ Parziale';btn.style.background='var(--wn)';}
    } else {
      toast(`✅ Connessione OK! Schema pronto (${ok.length} tabelle)`,'success');
      if(btn){btn.textContent='✅ Connesso';btn.style.background='var(--ok)';}
    }
  }catch(err){
    toast(`❌ Errore: ${err.message||err.code||JSON.stringify(err)}`,'error');
    if(btn){btn.textContent='❌ Fallito';btn.style.background='var(--bd)';}
  }
  setTimeout(()=>{if(btn){btn.textContent='Testa Connessione';btn.disabled=false;btn.style.background='';}},3000);
}
function refreshSbStatus(){
  const dot=document.getElementById('sbDot');
  const txt=document.getElementById('sbTxt');
  const urlInp=document.getElementById('sbUrlInp');
  const keyInp=document.getElementById('sbKeyInp');
  const savedUrl=localStorage.getItem('mpxSbUrl')||'';
  const savedKey=localStorage.getItem('mpxSbKey')||'';
  if(urlInp && savedUrl) urlInp.value=savedUrl;
  if(keyInp && savedKey) keyInp.value='••••••••••••';
  if(!dot||!txt) return;
  if(OFFLINE){
    dot.style.background='#999'; txt.textContent='Non configurato — inserisci credenziali sotto';
  } else {
    dot.style.background='var(--ok)'; txt.textContent=`Connesso · ${SB_URL.replace('https://','').split('.')[0]}`;
  }
}


/* ============================================================
   ████████╗ 5 FUNZIONI INNOVATIVE ████████████████████████
============================================================ */

/* ── 1. CASH FLOW PREDICTOR ─────────────────────────────────
   Analizza le ultime N transazioni ricorrenti (stesso importo +
   descrizione apparse ≥2 volte) e calcola il saldo proiettato
   nei prossimi 30 giorni.
────────────────────────────────────────────────────────── */
function getProjectedCashFlow(){
  const today=new Date();
  const cutoff=new Date(today); cutoff.setDate(cutoff.getDate()-60);
  const recent=AppState.transactions.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type!=='transfer');

  // Trova pattern ricorrenti: stessa (descrizione, amount, type)
  const patterns={};
  recent.forEach(t=>{
    const k=`${t.description||''}|${t.amount}|${t.type}`;
    if(!patterns[k]) patterns[k]={...t,count:0,dates:[]};
    patterns[k].count++;
    patterns[k].dates.push(t.date);
  });

  const recurring=Object.values(patterns).filter(p=>p.count>=2);

  // Calcola saldo attuale (patrimonio netto)
  const accounts=UserConfig._accounts||[];
  let currentBalance=accounts.reduce((s,a)=>s+(a.initialBalance||0),0);
  AppState.transactions.filter(t=>t.type!=='transfer').forEach(t=>{ currentBalance+=t.type==='income'?+t.amount:-+t.amount; });

  // Proietta 30 giorni basandosi sulla media mensile per tipo
  const last30=AppState.transactions.filter(t=>{const d=new Date(t.date+'T12:00');return d>=cutoff&&d<=today&&t.type!=='transfer';});
  const avgOut30=last30.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0)/2; // media mensile
  const avgIn30 =last30.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0)/2;

  const dailyNet=(avgIn30-avgOut30)/30;
  const days30=[];
  for(let d=1;d<=30;d++){
    const date=new Date(today); date.setDate(date.getDate()+d);
    // aggiungi ricorrenti attesi in quel giorno
    let dayExtra=0;
    recurring.forEach(p=>{
      const lastDate=new Date(Math.max(...p.dates.map(dd=>new Date(dd+'T12:00'))));
      const daysSinceLast=Math.round((date-lastDate)/(86400000));
      // se la media inter-occorrenza corrisponde a questo giorno
      const avgInterval=60/p.count;
      if(daysSinceLast>0 && Math.abs(daysSinceLast-avgInterval)<2){
        dayExtra+=p.type==='income'?+p.amount:-+p.amount;
      }
    });
    days30.push({day:d,balance:currentBalance+dailyNet*d+dayExtra,date:date.toLocaleDateString('it-IT',{day:'numeric',month:'short'})});
  }
  return {currentBalance,dailyNet,days30,avgOut30,avgIn30};
}

function openCashFlowModal(){
  haptic();
  const cf=getProjectedCashFlow();
  const el=document.getElementById('cfModal');
  if(!el){ toast('Modal non disponibile','warn'); return; }
  const min=Math.min(...cf.days30.map(d=>d.balance));
  const max=Math.max(...cf.days30.map(d=>d.balance));
  const range=max-min||1;
  const H=80;
  const points=cf.days30.map((d,i)=>`${i*(260/29)},${H-((d.balance-min)/range)*H}`).join(' ');
  const color=cf.days30[29].balance>cf.currentBalance?'var(--ok)':'var(--bd)';
  const minDay=cf.days30.find(d=>d.balance===min);
  document.getElementById('cfContent').innerHTML=`
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-2xl p-3 text-center" style="background:var(--bg2)">
          <p class="text-[9px] font-bold uppercase tracking-wider mb-1" style="color:var(--t2)">Saldo Attuale</p>
          <p class="text-lg font-black" style="color:var(--t)">${fmt(cf.currentBalance)}</p>
        </div>
        <div class="rounded-2xl p-3 text-center" style="background:var(--bg2)">
          <p class="text-[9px] font-bold uppercase tracking-wider mb-1" style="color:var(--t2)">Fra 30 giorni</p>
          <p class="text-lg font-black" style="color:${color}">${fmt(cf.days30[29]?.balance||0)}</p>
        </div>
      </div>
      <div class="rounded-2xl p-3" style="background:var(--bg2)">
        <p class="text-[9px] font-bold uppercase tracking-wider mb-2" style="color:var(--t2)">Proiezione 30 giorni</p>
        <svg viewBox="0 -5 260 ${H+10}" style="width:100%;height:${H+20}px">
          <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="0" y1="${H}" x2="260" y2="${H}" stroke="var(--bo)" stroke-width="1"/>
          <text x="0" y="${H+9}" font-size="7" fill="var(--t2)">Oggi</text>
          <text x="230" y="${H+9}" font-size="7" fill="var(--t2)">+30g</text>
        </svg>
      </div>
      ${min<cf.currentBalance*0.2?`<div class="rounded-2xl p-3 flex gap-2 items-start" style="background:rgba(255,59,92,.1)">
        <span style="font-size:1.2rem">⚠️</span>
        <div><p class="text-xs font-bold" style="color:var(--bd)">Attenzione!</p>
        <p class="text-[11px]" style="color:var(--t2)">Saldo minimo previsto: <b>${fmt(min)}</b> il ${minDay?.date}</p></div>
      </div>`:''}
      <div class="grid grid-cols-2 gap-2 text-center">
        <div class="rounded-xl p-2" style="background:var(--bg2)"><p class="text-[9px]" style="color:var(--t2)">Media entrate/mese</p><p class="text-sm font-bold" style="color:var(--ok)">${fmt(cf.avgIn30)}</p></div>
        <div class="rounded-xl p-2" style="background:var(--bg2)"><p class="text-[9px]" style="color:var(--t2)">Media uscite/mese</p><p class="text-sm font-bold" style="color:var(--bd)">${fmt(cf.avgOut30)}</p></div>
      </div>
    </div>`;
  openModal('cfModal');
  lucide.createIcons();
}

/* ── 2. TRANSACTION RECEIPT SCANNER ─────────────────────────
   Analizza testo incollato (scontrino, estratto conto) ed estrae
   automaticamente le transazioni da importare.
────────────────────────────────────────────────────────── */
function openReceiptScanner(){
  haptic();
  document.getElementById('receiptTxt').value='';
  document.getElementById('receiptResults').innerHTML='';
  openModal('receiptModal');
}

function parseReceipt(){
  const raw=document.getElementById('receiptTxt')?.value||'';
  if(!raw.trim()){toast('Incolla il testo dello scontrino','warn');return;}
  const lines=raw.split('\n').map(l=>l.trim()).filter(Boolean);
  const found=[];
  const amtReg=/([€$£]?\s*[\d]{1,6}[,.][\d]{2})/g;
  const dateReg=/(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;
  const today=fmtDate(new Date());

  lines.forEach(line=>{
    const amounts=[...line.matchAll(amtReg)].map(m=>parseFloat(m[1].replace(/[€$£\s]/g,'').replace(',','.'))).filter(n=>n>0.01&&n<99999);
    if(!amounts.length) return;
    const amount=Math.max(...amounts);
    const dateM=line.match(dateReg);
    let date=today;
    if(dateM){
      const parts=dateM[1].split(/[\/\-\.]/);
      if(parts.length===3){
        const y=parts[2].length===2?'20'+parts[2]:parts[2];
        date=`${y}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      }
    }
    const desc=line.replace(amtReg,'').replace(dateReg,'').replace(/[€$£\s\-*|]+/g,' ').trim().slice(0,60)||'Scontrino';
    const cat=autoDetectCat(desc);
    found.push({desc,amount,date,cat,selected:true});
  });

  AppState._receiptItems=found;
  const el=document.getElementById('receiptResults');
  if(!found.length){el.innerHTML='<p class="text-sm py-3 text-center" style="color:var(--t2)">Nessun importo trovato — prova a riformattare il testo</p>';return;}
  el.innerHTML=`<p class="text-[10px] font-bold uppercase mb-2" style="color:var(--t2)">${found.length} voci rilevate — deseleziona quelle da escludere</p>`+
  found.map((item,i)=>`
    <div class="flex items-center gap-2 py-2 border-b last:border-0" style="border-color:var(--bo)">
      <input type="checkbox" checked onchange="AppState._receiptItems[${i}].selected=this.checked" class="w-4 h-4 flex-shrink-0" style="accent-color:var(--br)">
      <div class="flex-1 min-w-0">
        <p class="text-xs font-bold truncate">${item.desc}</p>
        <p class="text-[9px]" style="color:var(--t2)">${item.date} · ${Categories[item.cat]?.l||'Altro'}</p>
      </div>
      <p class="text-sm font-black flex-shrink-0" style="color:var(--bd)">${fmt(item.amount)}</p>
    </div>`).join('');
}

function autoDetectCat(desc){
  const d=desc.toLowerCase();
  for(const [k,c] of Object.entries(CATS)){
    if((c.kw||[]).some(kw=>d.includes(kw))) return k;
  }
  return 'other';
}

async function importReceiptItems(){
  if(!ensureAccountsOrOnboard()) return;
  const items=(AppState._receiptItems||[]).filter(x=>x.selected);
  if(!items.length){toast('Seleziona almeno una voce','warn');return;}
  const account=getDefaultAccountName();
  if(!account){ toast('Seleziona un conto','warn'); return; }
  const today=fmtDate(new Date());
  const time=nowTimeHM();
  for(const item of items){
    const payload={type:'expense',amount:item.amount,date:item.date||today,time,category_id:item.cat||'other',description:item.desc,account,account_to:null,tags:'[]'};
    if(OFFLINE||!db){
      saveTxLocal(payload);
    } else {
      try{
        const {data}=await dbInsertTxRow(toDbPayload(payload));
        if(data?.[0]) payload.id=data[0].id;
        if(!payload.id) payload.id='local_'+Date.now()+'_r'+Math.random().toString(36).slice(2,5);
        AppState.transactions.push(payload);
      }catch(e){ saveTxLocal(payload); }
    }
  }
  try{ DatabaseService.updateAccountBalance(account); }catch(e){}
  saveTransactions(); closeAll(); renderAll(); checkAch();
  toast(`✅ Importate ${items.length} voci dallo scontrino`,'success');
}

/* ── 3. SPENDING MOOD TRACKER ────────────────────────────────
   Associa un "mood" emoji a ogni transazione (opzionale) e mostra
   la correlazione spesa-umore nel tempo.
────────────────────────────────────────────────────────── */
const MOODS=['😊','😐','😟','😤','🎉','😴','💪'];
function openMoodTracker(){
  haptic();
  const el=document.getElementById('moodContent');
  if(!el){toast('Funzione non disponibile','warn');return;}
  // Raggruppa spese per mood
  const moodStats={};
  MOODS.forEach(m=>{moodStats[m]={count:0,total:0};});
  AppState.transactions.filter(t=>t.type==='expense').forEach(t=>{
    try{
      const tags=typeof t.tags==='string'?JSON.parse(t.tags):t.tags||[];
      const mood=tags.find(tag=>MOODS.includes(tag));
      if(mood){moodStats[mood].count++; moodStats[mood].total+= +t.amount;}
    }catch(e){}
  });
  const totTagged=Object.values(moodStats).reduce((s,v)=>s+v.count,0);
  el.innerHTML=`
    <p class="text-xs mb-3" style="color:var(--t2)">Aggiungi tag emoji nelle transazioni per tracciare il tuo umore di spesa.</p>
    <div class="grid grid-cols-4 gap-2 mb-4">
      ${MOODS.map(m=>`<div class="rounded-2xl p-3 text-center" style="background:var(--bg2)">
        <p class="text-2xl">${m}</p>
        <p class="text-[10px] font-bold mt-1" style="color:var(--t)">${moodStats[m].count}×</p>
        <p class="text-[9px]" style="color:var(--t2)">${moodStats[m].total>0?fmt(moodStats[m].total):'-'}</p>
      </div>`).join('')}
    </div>
    ${totTagged?`<div class="rounded-2xl p-3" style="background:var(--bg2)">
      <p class="text-[10px] font-bold mb-2" style="color:var(--t2)">Mood più costoso</p>
      ${Object.entries(moodStats).filter(([,v])=>v.count>0).sort((a,b)=>b[1].total-a[1].total).slice(0,3).map(([m,v])=>`
        <div class="flex items-center gap-3 py-1.5">
          <span class="text-xl">${m}</span>
          <div class="flex-1 h-1.5 rounded-full overflow-hidden" style="background:var(--bo)">
            <div class="h-full rounded-full" style="background:var(--br);width:${Math.round(v.total/Object.values(moodStats).reduce((s,x)=>s+x.total,1)*100)}%"></div>
          </div>
          <span class="text-xs font-bold">${fmt(v.total)}</span>
        </div>`).join('')}
    </div>`:`<p class="text-center text-sm py-4" style="color:var(--t2)">Inizia ad aggiungere emoji 😊 nelle note delle transazioni!</p>`}`;
  openModal('moodModal');
  lucide.createIcons();
}

/* ── 4. SMART SAVINGS CHALLENGE ─────────────────────────────
   Propone una sfida di risparmio personalizzata basata sulle abitudini
   di spesa: "52 settimane", "risparmia il resto", "no-spend day".
────────────────────────────────────────────────────────── */
function openSavingsChallenge(){
  haptic();
  if(!UserConfig._challenges) UserConfig._challenges={week52:0,roundup:0,noSpendStreak:0,noSpendGoal:7,lastNoSpendCheck:null};
  const ch=UserConfig._challenges;

  // Calcola no-spend streak (giorni senza spese)
  const today=fmtDate(new Date());
  let streak=0; let d=new Date();
  for(let i=0;i<60;i++){
    const k=fmtDate(d);
    const hasSpend=AppState.transactions.some(t=>t.date===k&&t.type==='expense');
    if(!hasSpend) streak++; else break;
    d.setDate(d.getDate()-1);
  }

  // Calcola arrotondamento (risparmia il resto di ogni spesa al €1 prossimo)
  const roundupTotal=AppState.transactions.filter(t=>t.type==='expense').reduce((s,t)=>{
    const cents=Math.round((1-((+t.amount)%1))*100)/100;
    return cents<1?s+cents:s;
  },0);

  const el=document.getElementById('challengeContent');
  if(!el){toast('Funzione non disponibile','warn');return;}
  el.innerHTML=`
    <div class="space-y-3">
      <!-- 52 Weeks Challenge -->
      <div class="rounded-2xl p-4" style="background:var(--bg2)">
        <div class="flex items-center justify-between mb-2">
          <div><p class="font-bold text-sm">💸 Sfida 52 Settimane</p><p class="text-[10px]" style="color:var(--t2)">Risparmia €1 la 1ª settimana, €2 la 2ª, ecc.</p></div>
          <p class="text-lg font-black" style="color:var(--ok)">${fmt(ch.week52)}</p>
        </div>
        <div class="h-1.5 rounded-full overflow-hidden mb-2" style="background:var(--bo)">
          <div class="h-full rounded-full" style="background:var(--ok);width:${Math.min(100,ch.week52/1378*100)}%"></div>
        </div>
        <p class="text-[9px] mb-2" style="color:var(--t2)">Obiettivo: ${fmt(1378)} · ${Math.round(ch.week52/1378*100)}% completato</p>
        <button onclick="addToWeek52Challenge()" class="w-full py-2 rounded-xl text-xs font-bold" style="background:rgba(0,200,150,.1);color:var(--ok)">+ Aggiungi settimana questa settimana</button>
      </div>

      <!-- Round-up savings -->
      <div class="rounded-2xl p-4" style="background:var(--bg2)">
        <div class="flex items-center justify-between mb-1">
          <div><p class="font-bold text-sm">🪙 Arrotondamento</p><p class="text-[10px]" style="color:var(--t2)">Risparmia il resto di ogni spesa</p></div>
          <p class="text-lg font-black" style="color:var(--br)">${fmt(Math.round(roundupTotal*100)/100)}</p>
        </div>
        <p class="text-[10px]" style="color:var(--t2)">Arrotondando ogni spesa al prossimo euro avresti risparmiato questo importo</p>
      </div>

      <!-- No-Spend Streak -->
      <div class="rounded-2xl p-4" style="background:var(--bg2)">
        <div class="flex items-center justify-between mb-2">
          <div><p class="font-bold text-sm">🔥 No-Spend Streak</p><p class="text-[10px]" style="color:var(--t2)">Giorni consecutivi senza spese</p></div>
          <p class="text-3xl font-black" style="color:${streak>0?'var(--wn)':'var(--t3)'}">${streak}</p>
        </div>
        <div class="flex gap-1 mb-2">${Array.from({length:ch.noSpendGoal||7},(_,i)=>`<div class="flex-1 h-2 rounded-full" style="background:${i<streak?'var(--wn)':'var(--bo)'}"></div>`).join('')}</div>
        <p class="text-[9px]" style="color:var(--t2)">Obiettivo: ${ch.noSpendGoal||7} giorni · ${streak>=(ch.noSpendGoal||7)?'🎉 Obiettivo raggiunto!':'Ancora '+(Math.max(0,(ch.noSpendGoal||7)-streak))+' giorni'}</p>
        <div class="flex gap-2 mt-2">
          <button onclick="changeNoSpendGoal(-1)" class="flex-1 py-1.5 rounded-xl text-xs font-bold" style="background:var(--bo)">−</button>
          <span class="flex-1 text-center text-xs font-bold py-1.5">Obiettivo: ${ch.noSpendGoal||7}g</span>
          <button onclick="changeNoSpendGoal(1)" class="flex-1 py-1.5 rounded-xl text-xs font-bold" style="background:var(--bo)">+</button>
        </div>
      </div>
    </div>`;
  openModal('challengeModal');
  if(streak>=(ch.noSpendGoal||7)&&streak>0) launchConfetti();
  lucide.createIcons();
}

function addToWeek52Challenge(){
  if(!UserConfig._challenges) UserConfig._challenges={week52:0};
  const week=Math.ceil(((new Date()-new Date(new Date().getFullYear(),0,1))/86400000)/7);
  UserConfig._challenges.week52=Math.min(1378,(UserConfig._challenges.week52||0)+week);
  saveConfig();
  openSavingsChallenge();
  toast(`Settimana ${week} aggiunta! (${fmt(week)} risparmiati)`,'success');
}

function changeNoSpendGoal(delta){
  if(!UserConfig._challenges) UserConfig._challenges={};
  UserConfig._challenges.noSpendGoal=Math.max(1,Math.min(30,(UserConfig._challenges.noSpendGoal||7)+delta));
  saveConfig(); openSavingsChallenge();
}

/* ── 5. SUBSCRIPTIONS OVERLAP DETECTOR ──────────────────────
   Analizza le transazioni per rilevare automaticamente abbonamenti
   dimenticati, comparali con quelli in lista, e segnala sovrapposizioni.
────────────────────────────────────────────────────────── */
function detectHiddenSubscriptions(){
  haptic();
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-90);
  const recent=AppState.transactions.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type==='expense');

  // Raggruppa per (description, amount) e conta occorrenze
  const groups={};
  recent.forEach(t=>{
    const k=`${(t.description||'').toLowerCase().slice(0,30)}|${+t.amount}`;
    if(!groups[k]) groups[k]={desc:t.description||'?',amount:+t.amount,cat:t.category_id,dates:[],account:t.account};
    groups[k].dates.push(t.date);
  });

  // Filtra: ≥2 occorrenze in 90 giorni con intervallo ~mensile o ~settimanale
  const detected=Object.values(groups).filter(g=>{
    if(g.dates.length<2) return false;
    const sorted=g.dates.map(d=>new Date(d+'T12:00')).sort((a,b)=>a-b);
    const intervals=[];
    for(let i=1;i<sorted.length;i++) intervals.push((sorted[i]-sorted[i-1])/(86400000));
    const avg=intervals.reduce((s,v)=>s+v,0)/intervals.length;
    return avg<=35 && avg>=5; // between 5 and 35 days apart = subscription-like
  }).map(g=>{
    const sorted=g.dates.map(d=>new Date(d+'T12:00')).sort((a,b)=>b-a);
    const intervals=[];
    for(let i=1;i<sorted.length;i++) intervals.push((sorted[i-1]-sorted[i])/(86400000));
    const avgInterval=intervals.reduce((s,v)=>s+v,0)/intervals.length;
    const monthly=avgInterval<20?g.amount*(30/avgInterval):g.amount;
    return {...g,avgInterval:Math.round(avgInterval),monthly:Math.round(monthly*100)/100};
  }).sort((a,b)=>b.monthly-a.monthly);

  // Controlla quali non sono già in UserConfig.subscriptions
  const knownNames=(UserConfig.subscriptions||[]).map(s=>s.name.toLowerCase());
  const unknown=detected.filter(g=>!knownNames.some(n=>g.desc.toLowerCase().includes(n.slice(0,5))));
  const known=detected.filter(g=>knownNames.some(n=>g.desc.toLowerCase().includes(n.slice(0,5))));

  const el=document.getElementById('subDetectContent');
  if(!el){toast('Funzione non disponibile','warn');return;}

  el.innerHTML=`
    ${unknown.length?`
    <p class="text-[10px] font-bold uppercase tracking-wider mb-2" style="color:var(--bd)">⚠️ ${unknown.length} abbonamenti non tracciati</p>
    ${unknown.map(g=>`
      <div class="flex items-center gap-3 py-3 border-b" style="border-color:var(--bo)">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:rgba(255,59,92,.1)">
          <i data-lucide="${Categories[g.cat]?.ic||'refresh-cw'}" class="w-4 h-4" style="color:var(--bd)"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs font-bold truncate">${g.desc}</p>
          <p class="text-[9px]" style="color:var(--t2)">Ogni ~${g.avgInterval}g · ${g.dates.length}× in 90 giorni</p>
        </div>
        <div class="text-right flex-shrink-0">
          <p class="text-sm font-black" style="color:var(--bd)">${fmt(g.amount)}</p>
          <p class="text-[9px]" style="color:var(--t2)">~${fmt(g.monthly)}/mese</p>
        </div>
      </div>`).join('')}
    <p class="text-[10px] mt-2 mb-3" style="color:var(--t2)">Vuoi aggiungerli agli abbonamenti tracciati?</p>
    <button onclick="addDetectedSubs()" class="w-full py-2.5 rounded-xl text-xs font-bold" style="background:rgba(124,58,237,.1);color:var(--acc)">+ Aggiungi tutti agli Abbonamenti</button>`:'<div class="text-center py-4"><p class="text-2xl mb-2">✅</p><p class="text-sm font-bold" style="color:var(--ok)">Tutti gli abbonamenti rilevati sono già tracciati!</p></div>'}
    ${known.length?`<p class="text-[10px] font-bold uppercase tracking-wider mt-4 mb-2" style="color:var(--ok)">✅ ${known.length} già tracciati</p>
    ${known.map(g=>`<div class="flex items-center gap-3 py-2"><div class="w-2 h-2 rounded-full flex-shrink-0" style="background:var(--ok)"></div><p class="text-xs flex-1 truncate">${g.desc}</p><p class="text-xs font-bold" style="color:var(--ok)">${fmt(g.amount)}</p></div>`).join('')}`:''}`;

  AppState._detectedSubs=unknown;
  openModal('subDetectModal');
  lucide.createIcons();
}

async function addDetectedSubs(){
  const subs=AppState._detectedSubs||[];
  const today=fmtDate(new Date());
  for(const g of subs){
    const sub={name:g.desc.slice(0,40),amount:g.amount,frequency:'monthly',nextDate:today,active:true};
    if(!UserConfig.subscriptions) UserConfig.subscriptions=[];
    // Use DatabaseService if available, else local
    if(typeof DBS!=='undefined'&&DatabaseService.saveSub){
      await DatabaseService.saveSub(sub);
    } else {
      sub.id='ls'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      UserConfig.subscriptions.push(sub);
      localStorage.setItem('mpx_subscriptions',JSON.stringify(UserConfig.subscriptions));
    }
  }
  saveConfig(); closeAll();
  toast(`${subs.length} abbonamenti aggiunti ✓`,'success');
}

/* ── Modals HTML per le 5 funzioni (iniettati nel DOM) ───── */
(function injectModals(){
  const html=`
  <!-- Cash Flow Predictor -->
  <div id="cfModal" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:88vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Cash Flow Predictor</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div id="cfContent" class="flex-1 overflow-y-auto px-5 pb-6 ns"></div>
  </div>

  <!-- Receipt Scanner -->
  <div id="receiptModal" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:92vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Scanner Scontrino</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 pb-6 ns space-y-3">
      <p class="text-xs" style="color:var(--t2)">Incolla il testo di uno scontrino o estratto conto — rilevo automaticamente gli importi.</p>
      <textarea id="receiptTxt" rows="5" class="inp w-full text-xs" placeholder="Es:\nSuperMercato 15/03\nPane              1,90\nLatte             0,89\nTotale:           2,79"></textarea>
      <button onclick="parseReceipt()" class="gbtn w-full py-3 rounded-xl text-sm font-bold">🔍 Analizza Testo</button>
      <div id="receiptResults"></div>
      <button onclick="importReceiptItems()" class="w-full py-3 rounded-xl text-sm font-bold" style="background:rgba(0,200,150,.1);color:var(--ok)">✅ Importa Selezionati</button>
    </div>
  </div>

  <!-- Mood Tracker -->
  <div id="moodModal" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:85vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Spending Mood</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div id="moodContent" class="flex-1 overflow-y-auto px-5 pb-6 ns"></div>
  </div>

  <!-- Savings Challenge -->
  <div id="challengeModal" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:88vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Sfide Risparmio</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div id="challengeContent" class="flex-1 overflow-y-auto px-5 pb-6 ns"></div>
  </div>

  <!-- Subscription Detector -->
  <div id="subDetectModal" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:88vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Subscription Detector</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div id="subDetectContent" class="flex-1 overflow-y-auto px-5 pb-6 ns"></div>
  </div>

  <!-- Alerts Center -->
  <div id="alertsM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:86vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Alert Center</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 pb-6 ns space-y-3">
      <div id="alertsList"></div>
    </div>
  </div>

  <!-- Duplicate Review -->
  <div id="dupM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:88vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Duplicati</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 pb-6 ns space-y-3">
      <div id="dupList"></div>
    </div>
  </div>

  <!-- Command Center -->
  <div id="cmdM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:78vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Command Center</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 pb-6 ns space-y-3">
      <div class="relative">
        <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style="color:var(--t3)"></i>
        <input id="cmdQ" class="inp pl-9 text-sm" placeholder="Cerca azioni o movimenti..." oninput="cmdSearch()" onkeydown="cmdKey(event)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      </div>
      <div id="cmdRes" class="space-y-2"></div>
      <p class="text-[10px]" style="color:var(--t3)">Suggerimenti: digita per cercare, Invio per aprire il primo risultato.</p>
    </div>
  </div>

  <!-- Split Bill -->
  <div id="splitM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:74vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Split Bill</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="px-5 pb-6 space-y-3">
      <div class="rounded-2xl p-4 space-y-3" style="background:var(--bg2)">
        <div>
          <label class="text-[10px] font-bold uppercase tracking-wider block mb-1.5" style="color:var(--t2)">Importo totale</label>
          <input id="splitAmt" type="number" step="0.01" min="0" class="inp text-center text-lg font-black" placeholder="0,00" oninput="calcSplit()">
        </div>
        <div class="flex items-center justify-between">
          <button onclick="splitAdj(-1)" class="cbtn op" style="width:44px;height:44px"><i data-lucide="minus" class="w-4 h-4"></i></button>
          <div class="text-center">
            <p class="text-[9px] font-bold uppercase tracking-widest" style="color:var(--t2)">Persone</p>
            <p id="splitN" class="text-3xl font-black gt" style="font-variant-numeric:tabular-nums">2</p>
          </div>
          <button onclick="splitAdj(1)" class="cbtn op" style="width:44px;height:44px"><i data-lucide="plus" class="w-4 h-4"></i></button>
        </div>
      </div>
      <div class="card p-4">
        <p class="text-[10px] font-bold uppercase tracking-widest mb-1" style="color:var(--t2)">La tua quota</p>
        <p id="splitRes" class="text-3xl font-black" style="font-variant-numeric:tabular-nums">€ 0,00</p>
      </div>
      <button onclick="splitToTx()" class="gbtn w-full py-3 rounded-2xl text-sm font-bold">Usa come importo</button>
    </div>
  </div>

  <!-- Currency Converter -->
  <div id="convM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:76vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 class="text-xl font-bold">Currency Converter</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="px-5 pb-6 space-y-3">
      <div class="rounded-2xl p-4 space-y-3" style="background:var(--bg2)">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-[9px] font-bold uppercase tracking-widest block mb-1" style="color:var(--t2)">Da</label>
            <select id="convFrom" class="inp text-sm py-2" onchange="doConvert()"></select>
          </div>
          <div>
            <label class="text-[9px] font-bold uppercase tracking-widest block mb-1" style="color:var(--t2)">A</label>
            <select id="convTo" class="inp text-sm py-2" onchange="doConvert()"></select>
          </div>
        </div>
        <div>
          <label class="text-[9px] font-bold uppercase tracking-widest block mb-1" style="color:var(--t2)">Importo</label>
          <input id="convAmt" type="number" step="0.01" min="0" class="inp text-center text-lg font-black" value="1" oninput="doConvert()">
        </div>
        <button onclick="swapConv()" class="w-full py-2.5 rounded-xl text-xs font-bold" style="background:var(--card);color:var(--t2)"><i data-lucide="repeat" class="w-4 h-4 inline mr-1"></i>Inverti</button>
      </div>
      <div class="card p-4">
        <p class="text-[10px] font-bold uppercase tracking-widest mb-1" style="color:var(--t2)">Risultato</p>
        <p id="convRes" class="text-3xl font-black" style="font-variant-numeric:tabular-nums">—</p>
        <p id="convRate" class="text-[10px] mt-1" style="color:var(--t2)"></p>
      </div>
      <button onclick="convToTx()" class="gbtn w-full py-3 rounded-2xl text-sm font-bold">Usa come importo</button>
    </div>
  </div>

  <!-- Day Details -->
  <div id="dayM" class="sh-up fixed bottom-0 left-0 right-0 flex flex-col" style="max-height:88vh;border-top:1px solid var(--bo);z-index:55;background:var(--card);border-radius:1.5rem 1.5rem 0 0;padding-bottom:max(env(safe-area-inset-bottom),16px)">
    <div class="flex justify-center pt-3 pb-1"><div class="w-10 h-1 rounded-full" style="background:var(--bo)"></div></div>
    <div class="px-5 py-2 flex justify-between items-center">
      <h2 id="dayTitle" class="text-xl font-bold">Dettaglio Giorno</h2>
      <button onclick="closeAll()" class="p-1.5 rounded-full" style="background:var(--bg2)"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 pb-6 ns space-y-3">
      <div id="dayTotals" class="card p-4"></div>
      <div id="dayList" class="card p-2"></div>
      <button onclick="dayToNew()" class="gbtn w-full py-3 rounded-2xl text-sm font-bold">Aggiungi movimento</button>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
})();

/* ── Quick access buttons nella home (inseriamo nella sezione Quick Actions) ── */
(function injectQuickActions(){
  // Home quick actions (pro)
  const existingGrid=document.getElementById('quickActGrid');
  if(!existingGrid) return;
  existingGrid.innerHTML='';
  const btns=[
    {icon:'plus',            label:'Nuovo',   color:'var(--br)',  bg:'rgba(0,102,255,.12)', fn:'openAdd()'},
    {icon:'bell',            label:'Alert',   color:'var(--wn)',  bg:'rgba(255,149,0,.12)', fn:'openAlerts()'},
    {icon:'arrow-left-right',label:'FX',      color:'var(--br)',  bg:'rgba(0,102,255,.10)', fn:'openConv()'},
    {icon:'divide',          label:'Split',   color:'var(--acc)', bg:'rgba(124,58,237,.12)',fn:'openSplit()'},
    {icon:'trending-up',     label:'Cash',    color:'var(--ok)',  bg:'rgba(0,200,150,.12)', fn:'openCashFlowModal()'},
    {icon:'line-chart',      label:'Invest',  color:'var(--ok)',  bg:'rgba(0,200,150,.16)', fn:'openInvestM()'},
    {icon:'scan-line',       label:'Scan',    color:'var(--br)',  bg:'rgba(0,102,255,.10)', fn:'openReceiptScanner()'},
    {icon:'upload',          label:'Import',  color:'var(--t2)',  bg:'var(--bg2)',          fn:'openImpM()'},
    {icon:'command',         label:'Cmd',     color:'var(--t2)',  bg:'var(--bg2)',          fn:'openCommand()'},
  ];
  btns.forEach(b=>{
    const btn=document.createElement('button');
    btn.setAttribute('onclick',b.fn);
    btn.className='flex flex-col items-center gap-1.5 p-3 rounded-2xl border';
    btn.style.cssText=`background:${b.bg};border-color:var(--bo)`;
    btn.innerHTML=`<i data-lucide="${b.icon}" class="w-5 h-5" style="color:${b.color}"></i><span class="text-[9px] font-bold tracking-wide" style="color:${b.color}">${b.label}</span>`;
    existingGrid.appendChild(btn);
  });
  lucide.createIcons();
})();

/* ============================================================
   INIT CALL
============================================================ */
init();
