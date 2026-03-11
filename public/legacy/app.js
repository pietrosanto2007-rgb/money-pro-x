/* ============================================================
   CONFIG — inserisci qui le tue credenziali Supabase
============================================================ */
const SB_URL = localStorage.getItem('mpxSbUrl') || 'INSERISCI_QUI_URL';
const SB_KEY = localStorage.getItem('mpxSbKey') || 'INSERISCI_QUI_CHIAVE';
const OFFLINE = SB_URL === 'INSERISCI_QUI_URL' || !SB_URL;
let db = null;
if(!OFFLINE){
  try{ db = window.supabase.createClient(SB_URL, SB_KEY); }
  catch(e){ console.error('Supabase init error:', e); }
}

/* ============================================================
   SCHEMA ADAPTER — tabella: id, type, amount, category_id,
   description, date, recurring, created_at, account
   (account_to e tags salvati in localStorage)
============================================================ */
/* ── UUID helper ── */
function genUUID(){
  try{ return crypto.randomUUID(); }catch(e){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);});
  }
}

/* ── ID helpers ── */
function normId(v){ return v==null?'':String(v); }
function idEq(a,b){ return normId(a)===normId(b); }
function isUUID(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normId(v)); }
function isLocalId(v,prefix){ const s=normId(v); return !s || !isUUID(s) || (prefix && s.startsWith(prefix)); }

/* ── Time helpers (HH:MM) ── */
function normTime(v){
  const s=String(v==null?'':v).trim();
  if(!s) return '';
  // Accept "HH:MM", "H:MM", "HH.MM", optional seconds.
  const m=s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if(m){
    const hh=parseInt(m[1],10);
    const mm=parseInt(m[2],10);
    if(Number.isFinite(hh)&&Number.isFinite(mm)&&hh>=0&&hh<=23&&mm>=0&&mm<=59){
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    }
  }
  // Accept "930"/"0930" → "09:30"
  const m2=s.match(/^(\d{3,4})$/);
  if(m2){
    const raw=m2[1].padStart(4,'0');
    const hh=parseInt(raw.slice(0,2),10);
    const mm=parseInt(raw.slice(2,4),10);
    if(Number.isFinite(hh)&&Number.isFinite(mm)&&hh>=0&&hh<=23&&mm>=0&&mm<=59){
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    }
  }
  return '';
}
function nowTimeHM(){
  const d=new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function txSortMs(t){
  const date=String(t?.date||'').slice(0,10);
  if(!date) return 0;
  const time=normTime(t?.time)||'12:00';
  const ms=new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(ms)?ms:0;
}
function cmpTxDTDesc(a,b){ return txSortMs(b)-txSortMs(a) || normId(b.id).localeCompare(normId(a.id)); }
function cmpTxDTAsc(a,b){ return txSortMs(a)-txSortMs(b) || normId(a.id).localeCompare(normId(b.id)); }

function fmtDate(d){ if(!d) return ''; const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
function resolveCol(v){ if(!v || !v.startsWith('var(')) return v; const s=getComputedStyle(document.documentElement).getPropertyValue(v.replace(/^var\(|\)$/g,'')).trim(); return s||v; }

/* ── DB helpers (backward compatible schema) ── */
function _isMissingCol(err,col){
  const msg=((err?.message||'')+' '+(err?.details||'')+' '+(err?.hint||'')).toLowerCase();
  const c=String(col||'').toLowerCase();
  return err?.code==='42703' || msg.includes(`column \"${c}`) || msg.includes(`column ${c}`) || msg.includes(`${c}\" does not exist`);
}
let _warnedMissingTimeCol=false;
function _warnMissingTimeCol(){
  if(_warnedMissingTimeCol) return;
  _warnedMissingTimeCol=true;
  try{ toast("⚠️ Schema DB non aggiornato: manca transactions.time. Aggiorna lo schema SQL (v4) per salvare l'orario.",'warn'); }catch(e){}
}
async function dbInsertTxRow(row){
  let res=await db.from('transactions').insert([row]).select();
  if(res?.error && _isMissingCol(res.error,'time')){
    _warnMissingTimeCol();
    const r={...row}; delete r.time;
    res=await db.from('transactions').insert([r]).select();
  }
  return res;
}
async function dbUpdateTxRow(id, patch){
  let res=await db.from('transactions').update(patch).eq('id',id).select();
  if(res?.error && _isMissingCol(res.error,'time')){
    _warnMissingTimeCol();
    const p={...patch}; delete p.time;
    res=await db.from('transactions').update(p).eq('id',id).select();
  }
  return res;
}

/* ── DB payload: one row for normal tx, called per-row for giro ── */
function toDbPayload(t, overrideType, overrideDesc){
  return {
    type:        overrideType || (t.type==='transfer'?'expense':t.type),
    amount:      parseFloat(t.amount)||0,
    date:        t.date,
    time:        normTime(t.time)||null,
    category_id: t.category_id||'other',
    description: overrideDesc!=null ? overrideDesc : (t.description||''),
    account:     t.account||'Principale',
    recurring:   false,
  };
}

/* ── Reconstruct transfers from [GIRO:uuid] pairs ── */
function processDbRows(rows){
  const giroMap={};
  const normal=[];
  rows.forEach(row=>{
    const m=(row.description||'').match(/^\[GIRO:([^\]]+)\](.*)/);
    if(m){
      const ref=m[1]; const desc=m[2].trim();
      if(!giroMap[ref]) giroMap[ref]={};
      if(row.type==='expense') giroMap[ref].out={...row,description:desc};
      else                     giroMap[ref].in={...row,description:desc};
    } else normal.push(row);
  });
  const result=normal.map(r=>{
    const local=(S._localMeta||{})[r.id]||{};
    return {...r, time:r.time||null, account_to:null, tags:local.tags||'[]'};
  });
  Object.entries(giroMap).forEach(([ref,{out,inn}])=>{
    if(out&&inn){
      result.push({
        id:out.id, _partner_id:inn.id,
        type:'transfer',
        amount:out.amount,
        date:out.date,
        time:out.time||null,
        category_id:out.category_id||'other',
        description:out.description||`Giro ${out.account}→${inn.account}`,
        account:out.account,
        account_to:inn.account,
        tags:'[]',
        _transfer_ref:ref,
      });
    } else {
      // orphan row — treat as normal
      const r=out||inn; if(r) result.push({...r,time:r.time||null,account_to:null,tags:'[]'});
    }
  });
  return result;
}

function fromDbRow(row){
  const local=(S._localMeta||{})[row.id]||{};
  return {
    id:row.id, type:row.type||'expense', amount:row.amount,
    date:row.date, time:row.time||null, category_id:row.category_id||'other',
    description:row.description||'', account:row.account||'Principale',
    account_to:local.account_to||null, tags:local.tags||'[]',
  };
}

function saveTxLocal(payload){
  if(S.editId){
    const i=S.txs.findIndex(x=>x.id===S.editId);
    if(i>=0) S.txs[i]=Object.assign({},S.txs[i],payload,{id:S.editId});
  } else {
    payload.id='local_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    S.txs.push(payload);
  }
  saveTxs();
}

async function saveTx(e){
  e.preventDefault(); haptic();
  const isTransfer=(S.fType==='transfer');
  const accFrom=document.getElementById('txAccFrom').value;
  const accTo  =document.getElementById('txAccTo').value;
  if(isTransfer&&accFrom===accTo){toast('Scegli due conti diversi','error');return;}
  const amt=parseFloat(document.getElementById('txAmt').value);
  if(isNaN(amt)||amt<=0){toast('Inserisci un importo valido','error');return;}

  const tags=isTransfer?'[]':JSON.stringify(Array.from(document.querySelectorAll('.tbtn.on')).map(b=>b.dataset.tag));
  const payload={
    type:S.fType, amount:amt,
    date:document.getElementById('txDate').value,
    time:document.getElementById('txTime')?.value||'',
    category_id:isTransfer?'other':(document.getElementById('txCat').value||'other'),
    description:document.getElementById('txDesc').value.trim()||(isTransfer?`Giro ${accFrom}→${accTo}`:''),
    account:isTransfer?accFrom:(document.getElementById('txAcc').value||(CFG._accounts?.[0]?.name||'Principale')),
    account_to:isTransfer?accTo:null, tags,
  };

  if(OFFLINE||!db){
    saveTxLocal(payload);
    toast(S.editId?'Aggiornato ✓':(isTransfer?`Giro ${fmt(amt)} ✓`:'Salvato ✓'),'success');
    try{
      if(payload.type==='transfer'){ DBS.updateAccountBalance(payload.account); if(payload.account_to) DBS.updateAccountBalance(payload.account_to); }
      else DBS.updateAccountBalance(payload.account);
    }catch(e){}
    closeAll(); renderAll(); if(!S.editId) checkAch();
    return;
  }

  try{
    if(isTransfer){
      // — TWO rows in DB with [GIRO:uuid] prefix —
      const ref=genUUID();
      const desc=payload.description;
      const rowOut=toDbPayload(payload,'expense',`[GIRO:${ref}] ${desc}`);
      const rowIn ={...toDbPayload(payload,'income', `[GIRO:${ref}] ${desc}`), account:accTo};

      if(S.editId){
        // find partner and delete both first
        const existing=S.txs.find(x=>x.id===S.editId);
        const oldRef=existing?._transfer_ref;
        if(oldRef){
          await db.from('transactions').delete().like('description',`[GIRO:${oldRef}]%`);
        } else if(existing?._partner_id){
          await Promise.all([
            db.from('transactions').delete().eq('id',S.editId),
            db.from('transactions').delete().eq('id',existing._partner_id),
          ]);
        } else {
          await db.from('transactions').delete().eq('id',S.editId);
        }
      }

      const [r1,r2]=await Promise.all([dbInsertTxRow(rowOut), dbInsertTxRow(rowIn)]);
      if(r1.error) throw r1.error;
      if(r2.error) throw r2.error;

      const merged={
        id:r1.data[0].id, _partner_id:r2.data[0].id,
        type:'transfer', amount:amt, date:payload.date, time:payload.time||null,
        category_id:payload.category_id, description:desc,
        account:accFrom, account_to:accTo, tags:'[]',
        _transfer_ref:ref,
      };
      if(S.editId){ const i=S.txs.findIndex(x=>x.id===S.editId); if(i>=0) S.txs[i]=merged; else S.txs.push(merged); }
      else S.txs.push(merged);
      saveTxs();
      toast(`Giro ${fmt(amt)} salvato ✓`,'success');
      // update both account balances
      if(!OFFLINE&&db){ DBS.updateAccountBalance(accFrom); DBS.updateAccountBalance(accTo); }

    } else {
      // — Normal transaction —
      const dbP=toDbPayload(payload);
      let result;
      if(S.editId){ result=await dbUpdateTxRow(S.editId, dbP); }
      else         { result=await dbInsertTxRow(dbP); }
      if(result.error) throw result.error;
      const savedId=S.editId||(result.data&&result.data[0]?.id);
      if(savedId){
        try{
          if(payload.account_to||tags!=='[]') await DBS.saveTxMeta(savedId,{account_to:payload.account_to,tags});
          else await DBS.deleteTxMeta(savedId);
        }catch(e){ console.warn('txmeta.save (non-blocking)',e); }
      }
      if(savedId){
        const row={id:savedId,...payload};
        if(S.editId){ const i=S.txs.findIndex(x=>x.id===S.editId); if(i>=0) S.txs[i]=row; }
        else S.txs.push(row);
        saveTxs();
      }
      toast(S.editId?'Aggiornato ✓':'Salvato ✓','success');
      // update account balance
      if(!OFFLINE&&db) DBS.updateAccountBalance(payload.account);
    }

    closeAll(); renderAll(); if(!S.editId) checkAch();
  }catch(err){
    console.error('saveTx error:',err);
    saveTxLocal(payload);
    toast(`Salvato localmente (${err.message||'errore sync'})`,'warn');
    try{
      if(payload.type==='transfer'){ DBS.updateAccountBalance(payload.account); if(payload.account_to) DBS.updateAccountBalance(payload.account_to); }
      else DBS.updateAccountBalance(payload.account);
    }catch(e){}
    closeAll(); renderAll(); if(!S.editId) checkAch();
  }
}

async function deleteTx(id){
  haptic();
  const t=S.txs.find(x=>x.id===id); if(!t) return;
  S.undoQ.push(JSON.parse(JSON.stringify(t)));
  // remove both halves of a transfer
  if(t.type==='transfer'&&t._partner_id){
    S.txs=S.txs.filter(x=>x.id!==id&&x.id!==t._partner_id);
  } else {
    S.txs=S.txs.filter(x=>x.id!==id);
  }
  saveTxs();
  const btn=document.getElementById('undoBtn');
  btn.classList.remove('hidden');
  clearTimeout(S._undoTimer);
  S._undoTimer=setTimeout(()=>btn.classList.add('hidden'),8000);
  toast('Eliminato — <b>Annulla</b> entro 8s','warn');
  renderAll();
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
      await DBS.deleteTxMeta(id);
      if(t._partner_id) await DBS.deleteTxMeta(t._partner_id);
    }catch(e){}
  }
  // refresh balance for affected account(s) (works offline too)
  try{
    if(t.type==='transfer'){ DBS.updateAccountBalance(t.account); if(t.account_to) DBS.updateAccountBalance(t.account_to); }
    else DBS.updateAccountBalance(t.account);
  }catch(e){}
}

async function undoTx(){
  const t=S.undoQ.pop(); if(!t) return;
  haptic(); S.txs.push(t); saveTxs();
  document.getElementById('undoBtn').classList.add('hidden');
  toast('Azione annullata ✓','success');
  renderAll();
  try{
    if(t.type==='transfer'){ DBS.updateAccountBalance(t.account); if(t.account_to) DBS.updateAccountBalance(t.account_to); }
    else DBS.updateAccountBalance(t.account);
  }catch(e){}
  if(!OFFLINE&&db){
    try{
      if(t.type==='transfer'){
        const ref=t._transfer_ref||genUUID();
        const desc=t.description||'';
        const rowOut=toDbPayload(t,'expense',`[GIRO:${ref}] ${desc}`);
        const rowIn ={...toDbPayload(t,'income',`[GIRO:${ref}] ${desc}`),account:t.account_to};
        const [r1,r2]=await Promise.all([dbInsertTxRow(rowOut), dbInsertTxRow(rowIn)]);
        if(r1.error) throw r1.error;
        if(r2.error) throw r2.error;
        if(r1.data?.[0]?.id) t.id=r1.data[0].id;
        if(r2.data?.[0]?.id) t._partner_id=r2.data[0].id;
        t._transfer_ref=ref;
      } else {
        const res=await dbInsertTxRow(toDbPayload(t));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id;
        if(newId) t.id=newId;
        try{
          const tags=t.tags||'[]';
          const account_to=t.account_to||null;
          if(newId && (account_to||tags!=='[]')) await DBS.saveTxMeta(newId,{account_to,tags});
        }catch(e){}
      }
      saveTxs();
      if(t.type==='transfer'){ DBS.updateAccountBalance(t.account); if(t.account_to) DBS.updateAccountBalance(t.account_to); }
      else DBS.updateAccountBalance(t.account);
      renderAll(); // refresh click handlers with updated ids
    }catch(e){ console.warn('undoTx DB',e); }
  }
}

async function dupTx(id){
  haptic();
  const t=S.txs.find(x=>x.id===id); if(!t) return;
  const nt={...t}; delete nt.id; delete nt._partner_id; delete nt._transfer_ref;
  nt.date=fmtDate(new Date());
  nt.time=nowTimeHM();
  const tempId='local_'+Date.now()+'_dup';
  nt.id=tempId;
  S.txs.push(nt); saveTxs();
  toast('Duplicato ✓','success'); renderAll();
  try{
    if(nt.type==='transfer'){ DBS.updateAccountBalance(nt.account); if(nt.account_to) DBS.updateAccountBalance(nt.account_to); }
    else DBS.updateAccountBalance(nt.account);
  }catch(e){}
  if(!OFFLINE&&db){
    try{
      if(nt.type==='transfer'){
        const ref=genUUID(); const desc=nt.description||'';
        const rowOut=toDbPayload(nt,'expense',`[GIRO:${ref}] ${desc}`);
        const rowIn ={...toDbPayload(nt,'income',`[GIRO:${ref}] ${desc}`),account:nt.account_to};
        const [r1,r2]=await Promise.all([dbInsertTxRow(rowOut), dbInsertTxRow(rowIn)]);
        if(r1.error) throw r1.error;
        if(r2.error) throw r2.error;
        const merged={
          id:r1.data?.[0]?.id||tempId,
          _partner_id:r2.data?.[0]?.id||null,
          type:'transfer', amount:nt.amount, date:nt.date, time:nt.time||null,
          category_id:nt.category_id||'other',
          description:desc||`Giro ${nt.account}→${nt.account_to}`,
          account:nt.account, account_to:nt.account_to, tags:'[]',
          _transfer_ref:ref,
        };
        const i=S.txs.findIndex(x=>x.id===tempId);
        if(i>=0) S.txs[i]=merged;
        saveTxs();
        DBS.updateAccountBalance(nt.account); if(nt.account_to) DBS.updateAccountBalance(nt.account_to);
        renderAll(); // refresh click handlers with updated ids
      } else {
        const res=await dbInsertTxRow(toDbPayload(nt));
        if(res.error) throw res.error;
        const newId=res.data?.[0]?.id;
        if(newId){
          const i=S.txs.findIndex(x=>x.id===tempId);
          if(i>=0) S.txs[i].id=newId;
          try{
            const tags=nt.tags||'[]';
            const account_to=nt.account_to||null;
          if(account_to||tags!=='[]') await DBS.saveTxMeta(newId,{account_to,tags});
          }catch(e){}
          saveTxs();
          DBS.updateAccountBalance(nt.account);
          renderAll(); // refresh click handlers with updated ids
        }
      }
    }catch(e){}
  }
}

async function loadData(force=false){
  if(OFFLINE||!db){ renderAll(); return; }
  const localHas=(()=>{ try{ return (loadTxs()||[]).length>0; }catch(e){ return false; } })();
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
    S.txs=processDbRows(data||[]);
    saveTxs();
    renderAll();
    updateSyncStatus('ok');
  }catch(err){
    console.error('loadData error:',err);
    if(!S.txs.length) S.txs=loadTxs();
    renderAll(); updateSyncStatus('error');
    toast(`Errore sync: ${err.message||err.code||'controlla URL/chiave'}`,'error');
  }
}

/* ============================================================
   STATE & CONFIG
============================================================ */
let S={
  txs:[], charts:{}, fType:'expense',
  viewDate:new Date(), editId:null,
  wFilter:'all', txFilter:'all',
  selTags:[], period:'month',
  calcExpr:'', calcVal:0, calcDisp:'0',
  advOpen:false, undoQ:[],
  splitN:2,
  pinBuffer:'',
  layoutMode:false,
  _layoutDrag:null,
  _layoutOverId:null,
};
let CFG={
  theme:'system', currency:'€',
  wallets:['Principale','Contanti','Risparmi'],
  goalName:'', goalVal:'', color:'#0066FF',
  budgets:{}, ach:{},
  layout:{},
  templates:[], notes:[],
  pinEnabled:false, pin:'',
  showBalance:true,
  defaultWallet:'',
  recurringTxs:[],
  fx:{ EUR:1, USD:1.08, GBP:0.86, JPY:163, CHF:0.96, CAD:1.47 },
  fxUpdated:null,
};

/* ============================================================
   CATEGORIES
============================================================ */

/* ============================================================
   FINTECH & ACCOUNT ICON SYSTEM
============================================================ */
// Fintech brand icons: { key: {label, bg, fg, text, emoji} }
const FINTECH_BRANDS = {
  paypal:    {label:'PayPal',    bg:'#003087',fg:'#009cde',text:'PP',  emoji:'🅿'},
  hype:      {label:'Hype',     bg:'#6B21A8',fg:'#A855F7',text:'HY',  emoji:'💜'},
  revolut:   {label:'Revolut',  bg:'#191C1F',fg:'#FF6B35',text:'RV',  emoji:'🔶'},
  satispay:  {label:'Satispay', bg:'#E4002B',fg:'#FF4461',text:'S',   emoji:'🔴'},
  n26:       {label:'N26',      bg:'#1A1A1A',fg:'#00B2A9',text:'N26', emoji:'🏦'},
  postepay:  {label:'Postepay', bg:'#F7941D',fg:'#FFC342',text:'PP',  emoji:'🟠'},
  wise:      {label:'Wise',     bg:'#9FE870',fg:'#163300',text:'W',   emoji:'💚'},
  monzo:     {label:'Monzo',    bg:'#FF3464',fg:'#FFD4E0',text:'M',   emoji:'🌸'},
  bunq:      {label:'bunq',     bg:'#00A86B',fg:'#E8FFF4',text:'bq',  emoji:'🟢'},
  tinaba:    {label:'Tinaba',   bg:'#FF6600',fg:'#fff',   text:'Ti',  emoji:'🟠'},
  illimity:  {label:'illimity', bg:'#1B3A6B',fg:'#5AB4FF',text:'Il',  emoji:'🔵'},
  buddybank: {label:'Buddybank',bg:'#FF5F1F',fg:'#fff',   text:'BB',  emoji:'🟠'},
  fineco:    {label:'FinecoBank',bg:'#005BAC',fg:'#fff',  text:'FN',  emoji:'🔵'},
  mediolanum:{label:'Mediolanum',bg:'#00A86B',fg:'#fff',  text:'MD',  emoji:'🟢'},
  unicredit: {label:'UniCredit',bg:'#E3000F',fg:'#fff',   text:'UC',  emoji:'🔴'},
  intesa:    {label:'Intesa SP',bg:'#008751',fg:'#fff',   text:'IS',  emoji:'🟢'},
  bnl:       {label:'BNL',      bg:'#004A97',fg:'#fff',   text:'BNL', emoji:'🔵'},
  mps:       {label:'Monte Paschi',bg:'#00294D',fg:'#D4AF37',text:'MPS',emoji:'🏦'},
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

// Render account icon (fintech badge OR lucide icon)
function renderAccIcon(acc, size=26, radius=8) {
  const brand = detectBrand(acc.name);
  if (brand) {
    const b = FINTECH_BRANDS[brand];
    return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${b.bg};font-size:${Math.floor(size*.38)}px">${b.text}</div>`;
  }
  return `<div class="ft-badge" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${acc.color||'var(--br)'}22">
    <i data-lucide="${acc.icon||'wallet'}" style="width:${Math.floor(size*.55)}px;height:${Math.floor(size*.55)}px;color:${acc.color||'var(--br)'}"></i>
  </div>`;
}

const CATS={

  food:     {l:'Cibo & Rist.',   ic:'utensils',     col:'#FF9500',bg:'rgba(255,149,0,.12)',   kw:['spesa','ristorante','pizza','bar','caffè','paninoteca','gelato','cibo','lidl','esselunga','conad','carrefour','supermercato']},
  transport:{l:'Trasporti',      ic:'car',           col:'#FF3B5C',bg:'rgba(255,59,92,.12)',   kw:['benzina','treno','bus','taxi','uber','parcheggio','metro','volo','atm','trenitalia','frecciarossa','autostrada']},
  home:     {l:'Casa & Utenze',  ic:'home',         col:'#5AC8FA',bg:'rgba(90,200,250,.12)',  kw:['affitto','luce','gas','acqua','bolletta','condominio','wifi','imu','enel','eni','hera','tim','vodafone']},
  shopping: {l:'Shopping',       ic:'shopping-bag', col:'#AF52DE',bg:'rgba(175,82,222,.12)', kw:['amazon','zara','vestiti','scarpe','mall','ikea','primark','zalando','h&m','decathlon']},
  health:   {l:'Salute & Sport', ic:'heart-pulse',  col:'#FF2D55',bg:'rgba(255,45,85,.12)',  kw:['farmacia','medico','palestra','dentista','sport','gym','dottore','ospedale','analisi']},
  entertain:{l:'Svago',          ic:'tv',           col:'#FF6B00',bg:'rgba(255,107,0,.12)',  kw:['cinema','netflix','spotify','disney','concerto','teatro','giochi','playstation','steam']},
  travel:   {l:'Viaggi',         ic:'plane',        col:'#00C896',bg:'rgba(0,200,150,.12)',  kw:['hotel','airbnb','booking','vacanza','viaggio','ryanair','easyjet','aeroporto']},
  education:{l:'Istruzione',     ic:'book-open',    col:'#4CAF50',bg:'rgba(76,175,80,.12)',  kw:['libro','corso','università','scuola','udemy','coursera']},
  salary:   {l:'Stipendio',      ic:'banknote',     col:'#00C896',bg:'rgba(0,200,150,.12)',  kw:['stipendio','paga','bonifico','busta','cedolino']},
  subscript:{l:'Abbonamenti',    ic:'refresh-cw',   col:'#7C3AED',bg:'rgba(124,58,237,.12)',kw:['abbonamento','mensile','annual','subscription','piano']},
  invest:   {l:'Investimenti',   ic:'trending-up',  col:'#00C896',bg:'rgba(0,200,150,.12)',  kw:['btp','azioni','etf','crypto','trading','fondo']},
  other:    {l:'Altro',          ic:'tag',           col:'#6B7280',bg:'rgba(107,114,128,.12)',kw:[]},
};

/* ============================================================
   ACHIEVEMENTS
============================================================ */
const ACHS=[
  {id:'first',   e:'🎯',t:'Prima Transazione',  fn:x=>x.length>=1},
  {id:'ten',     e:'📊',t:'10 Movimenti',        fn:x=>x.length>=10},
  {id:'fifty',   e:'🏆',t:'50 Movimenti',        fn:x=>x.length>=50},
  {id:'hundred', e:'💯',t:'100 Movimenti',       fn:x=>x.length>=100},
  {id:'saver',   e:'💰',t:'Risparmio >20%',      fn:(x,c)=>srFor(x,new Date())>20},
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
   Ogni saveCfg() ora pusha al DB in background via DBS
============================================================ */
function saveTxs(){
  localStorage.setItem('mpxData2', JSON.stringify(S.txs));
  localStorage.setItem('mpxMeta2', JSON.stringify(S._localMeta||{}));
}
function saveCfg(){
  localStorage.setItem('mpxCfg2', JSON.stringify(CFG));
  if(!OFFLINE && db) DBS.pushSettings().catch(()=>{});
}
function loadTxs(){ try{ return JSON.parse(localStorage.getItem('mpxData2')||'[]'); }catch(e){ return []; } }
function loadMeta(){ try{ return JSON.parse(localStorage.getItem('mpxMeta2')||'{}'); }catch(e){ return {}; } }
function loadCfg(){ try{ return JSON.parse(localStorage.getItem('mpxCfg2')||'{}'); }catch(e){ return {}; } }

/* ============================================================
   SQL SCHEMA — 10 tabelle complete
============================================================ */
const SQL_SCHEMA=`-- ============================================================
-- MONEY PRO X — Schema Supabase (v4, robust)
-- Incolla nel SQL Editor → Esegui
-- ============================================================

-- 0) Extensions (needed for gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('expense','income','transfer')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  category_id text DEFAULT 'other',
  description text DEFAULT '',
  date        date NOT NULL,
  time        time,
  account     text DEFAULT 'Principale',
  recurring   boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);
-- v4 migration (safe to re-run)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS time time;
CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS transactions_date_time_idx ON transactions(date DESC, time DESC);
CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions(account);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions(category_id);

-- 1b) Transaction metadata (tags, extra fields)
CREATE TABLE IF NOT EXISTS transaction_meta (
  tx_id      uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  tags       text DEFAULT '[]',
  account_to text,
  updated_at timestamptz DEFAULT now()
);

-- 2) Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  type            text DEFAULT 'checking',
  color           text DEFAULT '#0066FF',
  icon            text DEFAULT 'wallet',
  initial_balance numeric(12,2) DEFAULT 0,
  current_balance numeric(12,2) DEFAULT 0,
  sort_order      integer DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_sort_order_idx ON accounts(sort_order);

-- 3) Custom categories
CREATE TABLE IF NOT EXISTS categories (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  label      text NOT NULL,
  icon       text DEFAULT 'tag',
  color      text DEFAULT '#6B7280',
  background text DEFAULT 'rgba(107,114,128,.12)',
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS categories_sort_order_idx ON categories(sort_order);

-- 4) Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  category_key text NOT NULL UNIQUE,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  period       text DEFAULT 'monthly',
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budgets_category_key_idx ON budgets(category_key);

-- 5) Goals
CREATE TABLE IF NOT EXISTS goals (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL,
  target     numeric(12,2) NOT NULL CHECK (target > 0),
  current    numeric(12,2) DEFAULT 0,
  deadline   date,
  completed  boolean DEFAULT false,
  color      text DEFAULT '#0066FF',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_created_at_idx ON goals(created_at DESC);

-- 6) Debts & Credits
CREATE TABLE IF NOT EXISTS debts (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  person     text NOT NULL,
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  type       text NOT NULL CHECK (type IN ('borrow','lend')),
  note       text DEFAULT '',
  date       date NOT NULL,
  settled    boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debts_person_idx ON debts(person);
CREATE INDEX IF NOT EXISTS debts_settled_idx ON debts(settled);

-- 7) Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL,
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  frequency  text DEFAULT 'monthly' CHECK (frequency IN ('monthly','yearly','weekly')),
  next_date  date,
  active     boolean DEFAULT true,
  color      text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_next_date_idx ON subscriptions(next_date);
CREATE INDEX IF NOT EXISTS subscriptions_active_idx ON subscriptions(active);

-- 8) Transaction templates
CREATE TABLE IF NOT EXISTS templates (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name         text NOT NULL,
  type         text NOT NULL,
  amount       numeric(12,2),
  category_key text,
  account_name text,
  description  text,
  tags         text DEFAULT '[]',
  created_at   timestamptz DEFAULT now()
);

-- 9) Notes / To-Do
CREATE TABLE IF NOT EXISTS notes (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  text       text NOT NULL,
  done       boolean DEFAULT false,
  date       date NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 10) Settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz DEFAULT now()
);`;

function copySQLSchema(){
  navigator.clipboard?.writeText(SQL_SCHEMA).then(()=>toast('Schema copiato ✓','success')).catch(()=>toast('Copia dal box manualmente','warn'));
}

/* ============================================================
   DBS — Database Sync Layer
   Ogni entità ha: load (DB → memoria + localStorage) e save/delete
============================================================ */
const DBS={

  /* ── COLORI ACCOUNT ──────────────────────────────────── */
  _acColors:['#0066FF','#00C896','#7C3AED','#FF9500','#FF3B5C','#5AC8FA','#FF6B00','#4CAF50'],
  _acColorIdx:0,
  nextColor(){ return this._acColors[this._acColorIdx++ % this._acColors.length]; },
  _iconForType(t){ return {checking:'credit-card',savings:'piggy-bank',cash:'banknote',credit:'credit-card',invest:'trending-up'}[t]||'wallet'; },

  /* ── SETTINGS ────────────────────────────────────────── */
  async pushSettings(){
    if(!db) return;
    const rows=['currency','theme','color','goalName','goalVal','ach','pinEnabled','pin','showBalance','defaultWallet','recurringTxs','fx','lastBackup','fxUpdated','layout']
      .map(k=>({key:k,value:JSON.stringify(CFG[k]??null),updated_at:new Date().toISOString()}));
    try{ await db.from('settings').upsert(rows,{onConflict:'key'}); }catch(e){ console.warn('settings.push',e); }
  },
  async pullSettings(){
    if(!db) return false;
    try{
      const {data,error}=await db.from('settings').select('key,value');
      if(error||!data?.length) return false;
      data.forEach(r=>{ try{ CFG[r.key]=JSON.parse(r.value); }catch(e){ CFG[r.key]=r.value; } });
      localStorage.setItem('mpxCfg2',JSON.stringify(CFG));
      return true;
    }catch(e){ console.warn('settings.pull',e); return false; }
  },

  /* ── ACCOUNTS ────────────────────────────────────────── */
  _saveLocal(){ localStorage.setItem('mpx_acc',JSON.stringify(CFG._accounts)); },
  /* ── BALANCE TRACKING ───────────────────────────────── */
  computeBalance(accName){
    const acc=CFG._accounts.find(a=>a.name===accName);
    let bal=acc?.initialBalance||0;
    (window.S?.txs||[]).forEach(t=>{
      const a=+t.amount;
      if(t.type==='transfer'){
        if(t.account===accName) bal-=a;
        if(t.account_to===accName) bal+=a;
      } else if(t.account===accName){
        bal+=t.type==='expense'?-a:a;
      }
    });
    return Math.round(bal*100)/100;
  },
  async updateAccountBalance(accName){
    const acc=CFG._accounts?.find(a=>a.name===accName); if(!acc) return;
    const bal=this.computeBalance(accName);
    acc.currentBalance=bal;
    this._saveLocal();
    if(!db||!acc.id||acc.id.toString().startsWith('lac')) return;
    try{ await db.from('accounts').update({current_balance:bal}).eq('id',acc.id); }
    catch(e){ console.warn('balance.update',e); }
  },
  async updateAllBalances(){
    if(!CFG._accounts?.length) return;
    for(const acc of CFG._accounts) await this.updateAccountBalance(acc.name);
  },

  async loadAccounts(){
    // try DB first
    if(db){
      try{
        const {data,error}=await db.from('accounts').select('*').order('sort_order');
        if(!error && data?.length){
          CFG._accounts=data.map(r=>({id:r.id,name:r.name,type:r.type||'checking',color:r.color||'#0066FF',icon:r.icon||'wallet',initialBalance:+r.initial_balance||0,currentBalance:r.current_balance!=null?+r.current_balance:undefined}));
          CFG.wallets=CFG._accounts.map(a=>a.name);
          this._saveLocal();
          const b=document.getElementById('accsDbBadge'); if(b) b.classList.remove('hidden');
          return;
        }
      }catch(e){ console.warn('accounts.load DB',e); }
    }
    // localStorage fallback
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_acc')||'null');
      if(lc?.length){ CFG._accounts=lc; CFG.wallets=lc.map(a=>a.name); return; }
    }catch(e){}
    // defaults
    const defs=[
      {id:'lac1',name:'Principale',type:'checking',color:'#0066FF',icon:'credit-card',initialBalance:0},
      {id:'lac2',name:'Contanti',  type:'cash',    color:'#00C896',icon:'banknote',   initialBalance:0},
      {id:'lac3',name:'Risparmi',  type:'savings', color:'#7C3AED',icon:'piggy-bank', initialBalance:0},
    ];
    CFG._accounts=defs; CFG.wallets=defs.map(a=>a.name); this._saveLocal();
  },
  async saveAccount(acc){
    // local update
    const idx=CFG._accounts.findIndex(a=>a.id===acc.id);
    if(idx>=0) CFG._accounts[idx]=acc; else { CFG._accounts.push(acc); }
    CFG.wallets=CFG._accounts.map(a=>a.name);
    this._saveLocal();
    if(!db) return acc;
    const row={name:acc.name,type:acc.type,color:acc.color,icon:acc.icon,initial_balance:acc.initialBalance||0,sort_order:CFG._accounts.indexOf(acc)};
    try{
      const isLocal=!acc.id||acc.id.startsWith('lac');
      const res=isLocal?await db.from('accounts').insert([row]).select():await db.from('accounts').update(row).eq('id',acc.id).select();
      if(!res.error && res.data?.[0]){
        const old=acc.id; acc.id=res.data[0].id;
        const i=CFG._accounts.findIndex(a=>a.id===old||a.id===res.data[0].id);
        if(i>=0) CFG._accounts[i].id=acc.id;
        this._saveLocal();
      }
    }catch(e){ console.warn('accounts.save',e); }
    return acc;
  },
  async deleteAccount(id){
    CFG._accounts=CFG._accounts.filter(a=>a.id!==id);
    CFG.wallets=CFG._accounts.map(a=>a.name);
    this._saveLocal();
    if(!db||id.startsWith('lac')) return;
    try{ await db.from('accounts').delete().eq('id',id); }catch(e){ console.warn('accounts.delete',e); }
  },
  async renameAccount(id,newName,oldName){
    const acc=CFG._accounts.find(a=>a.id===id); if(!acc) return;
    acc.name=newName; CFG.wallets=CFG._accounts.map(a=>a.name); this._saveLocal();
    // rename in transactions too
    if(!db||id.startsWith('lac')) return;
    try{
      await db.from('accounts').update({name:newName}).eq('id',id);
      // also update transactions that reference the old account name
      await db.from('transactions').update({account:newName}).eq('account',oldName);
    }catch(e){ console.warn('accounts.rename',e); }
  },

  /* ── BUDGETS ──────────────────────────────────────────── */
  async loadBudgets(){
    const localHas=(()=>{ try{ return Object.keys(JSON.parse(localStorage.getItem('mpx_bud')||'{}')||{}).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('budgets').select('*');
        if(!error && data && (data.length||!localHas)){ CFG.budgets={}; data.forEach(r=>CFG.budgets[r.category_key]=+r.amount); localStorage.setItem('mpx_bud',JSON.stringify(CFG.budgets)); return; }
      }catch(e){ console.warn('budgets.load',e); }
    }
    try{ CFG.budgets=JSON.parse(localStorage.getItem('mpx_bud')||'{}'); }catch(e){ CFG.budgets={}; }
  },
  async saveBudget(catKey,amount){
    if(amount&&+amount>0) CFG.budgets[catKey]=+amount; else delete CFG.budgets[catKey];
    localStorage.setItem('mpx_bud',JSON.stringify(CFG.budgets));
    if(!db) return;
    try{
      if(amount&&+amount>0) await db.from('budgets').upsert({category_key:catKey,amount:+amount,updated_at:new Date().toISOString()},{onConflict:'category_key'});
      else await db.from('budgets').delete().eq('category_key',catKey);
    }catch(e){ console.warn('budgets.save',e); }
  },

  /* ── CATEGORIES ──────────────────────────────────────── */
  async loadCustomCategories(){
    if(db){
      try{
        const {data,error}=await db.from('categories').select('*').order('sort_order');
        if(!error && data){ data.forEach(r=>{ if(!CATS[r.key]) CATS[r.key]={l:r.label,ic:r.icon,col:r.color,bg:r.background,kw:[],_dbid:r.id,_custom:true}; }); localStorage.setItem('mpx_cats',JSON.stringify(data)); return; }
      }catch(e){ console.warn('cats.load',e); }
    }
    try{ const lc=JSON.parse(localStorage.getItem('mpx_cats')||'[]'); lc.forEach(r=>{ if(!CATS[r.key]) CATS[r.key]={l:r.label,ic:r.icon,col:r.color,bg:r.background,kw:[],_dbid:r.id,_custom:true}; }); }catch(e){}
  },

  /* ── NOTES ────────────────────────────────────────────── */
  _saveNotes(){ localStorage.setItem('mpx_notes',JSON.stringify(CFG.notes)); },
  async loadNotes(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_notes')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('notes').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){ CFG.notes=data.map(r=>({id:r.id,text:r.text,done:r.done,date:r.date})); this._saveNotes(); return; }
      }catch(e){ console.warn('notes.load',e); }
    }
    try{ CFG.notes=JSON.parse(localStorage.getItem('mpx_notes')||'[]'); }catch(e){ CFG.notes=[]; }
  },
  async addNote(text){
    const note={id:'ln'+Date.now(),text,done:false,date:fmtDate(new Date())};
    CFG.notes.unshift(note); this._saveNotes();
    if(!db) return note;
    try{
      const {data}=await db.from('notes').insert([{text:note.text,done:false,date:note.date}]).select();
      if(data?.[0]){ CFG.notes[0].id=data[0].id; this._saveNotes(); }
    }catch(e){ console.warn('notes.add',e); }
    return note;
  },
  async updateNote(id,patch){
    const n=CFG.notes.find(x=>x.id===id); if(!n) return; Object.assign(n,patch); this._saveNotes();
    if(!db||id.startsWith('ln')) return;
    try{ await db.from('notes').update(patch).eq('id',id); }catch(e){ console.warn('notes.update',e); }
  },
  async deleteNote(id){
    CFG.notes=CFG.notes.filter(n=>n.id!==id); this._saveNotes();
    if(!db||id.toString().startsWith('ln')) return;
    try{ await db.from('notes').delete().eq('id',id); }catch(e){ console.warn('notes.delete',e); }
  },

  /* ── TEMPLATES ────────────────────────────────────────── */
  _saveTpl(){ localStorage.setItem('mpx_tpl',JSON.stringify(CFG.templates)); },
  async loadTemplates(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_tpl')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('templates').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){ CFG.templates=data.map(r=>({id:r.id,name:r.name,type:r.type,amount:+r.amount,category_id:r.category_key||'other',account:r.account_name||'',description:r.description||'',tags:r.tags||'[]'})); this._saveTpl(); return; }
      }catch(e){ console.warn('templates.load',e); }
    }
    try{ CFG.templates=JSON.parse(localStorage.getItem('mpx_tpl')||'[]'); }catch(e){ CFG.templates=[]; }
  },
  async addTemplate(tpl){
    tpl.id='lt'+Date.now(); CFG.templates.unshift(tpl); this._saveTpl();
    if(!db) return tpl;
    try{
      const {data}=await db.from('templates').insert([{name:tpl.name,type:tpl.type,amount:tpl.amount||null,category_key:tpl.category_id||null,account_name:tpl.account||null,description:tpl.description||null,tags:tpl.tags||'[]'}]).select();
      if(data?.[0]){ CFG.templates[0].id=data[0].id; this._saveTpl(); }
    }catch(e){ console.warn('templates.add',e); }
    return tpl;
  },
  async deleteTemplate(id){
    CFG.templates=CFG.templates.filter(t=>t.id!==id); this._saveTpl();
    if(!db||id.toString().startsWith('lt')) return;
    try{ await db.from('templates').delete().eq('id',id); }catch(e){ console.warn('templates.delete',e); }
  },

  /* ── TX META (tags, account_to) ──────────────────────── */
  _saveTxMeta(){ localStorage.setItem('mpxMeta2',JSON.stringify(S._localMeta||{})); },
  async loadTxMeta(){
    if(!S._localMeta) S._localMeta={};
    if(db){
      try{
        const {data,error}=await db.from('transaction_meta').select('*');
        if(!error && data){
          data.forEach(r=>{
            if(!r?.tx_id) return;
            S._localMeta[r.tx_id]={account_to:r.account_to||null,tags:r.tags||'[]'};
          });
          this._saveTxMeta();
          return;
        }
      }catch(e){ console.warn('txmeta.load',e); }
    }
  },
  async saveTxMeta(txId,meta){
    const id=normId(txId); if(!id) return;
    if(!S._localMeta) S._localMeta={};
    const m={account_to:meta?.account_to||null,tags:meta?.tags||'[]'};
    S._localMeta[id]=m;
    this._saveTxMeta();
    if(!db || !isUUID(id)) return;
    try{
      await db.from('transaction_meta').upsert({tx_id:id,tags:m.tags,account_to:m.account_to,updated_at:new Date().toISOString()},{onConflict:'tx_id'});
    }catch(e){ console.warn('txmeta.save',e); }
  },
  async deleteTxMeta(txId){
    const id=normId(txId); if(!id) return;
    if(S._localMeta) delete S._localMeta[id];
    this._saveTxMeta();
    if(!db || !isUUID(id)) return;
    try{ await db.from('transaction_meta').delete().eq('tx_id',id); }catch(e){ console.warn('txmeta.delete',e); }
  },

  /* ── GOALS (multipli) ────────────────────────────────── */
  _saveGoals(){ localStorage.setItem('mpx_goals',JSON.stringify(CFG.goals||[])); },
  async loadGoals(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_goals')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('goals').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          CFG.goals=data.map(r=>({id:normId(r.id),name:r.name,target:+r.target||0,current:+r.current||0,deadline:r.deadline||'',completed:!!r.completed,color:r.color||null}));
          this._saveGoals();
          return;
        }
      }catch(e){ console.warn('goals.load',e); }
    }
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_goals')||'null');
      if(lc?.length){ CFG.goals=lc.map(g=>({...(g||{}),id:normId(g.id)})); return; }
    }catch(e){}
    CFG.goals=(CFG.goals||[]).map(g=>({...(g||{}),id:normId(g.id)}));
  },
  async saveGoal(goal){
    if(!CFG.goals) CFG.goals=[];
    const g={...(goal||{})};
    g.id=normId(g.id)||('lg'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    g.name=(g.name||'').trim();
    g.target=+g.target||0;
    g.current=Math.max(0,Math.min(g.target||0,+g.current||0));
    g.deadline=g.deadline||'';
    g.completed=!!g.completed || (g.target>0 && g.current>=g.target);
    g.color=g.color||CFG.color||'#0066FF';
    if(!g.name||!g.target||g.target<=0) return g;
    const idx=CFG.goals.findIndex(x=>idEq(x.id,g.id));
    if(idx>=0) CFG.goals[idx]=Object.assign({},CFG.goals[idx],g);
    else CFG.goals.unshift(g);
    this._saveGoals();
    if(!db) return g;
    try{
      const row={name:g.name,target:g.target,current:g.current,deadline:g.deadline||null,completed:g.completed,color:g.color||null};
      if(isUUID(g.id) && !isLocalId(g.id,'lg')){
        await db.from('goals').upsert({id:g.id,...row},{onConflict:'id'});
      } else {
        const {data,error}=await db.from('goals').insert([row]).select();
        if(error) throw error;
        if(data?.[0]?.id){
          const newId=data[0].id;
          const j=CFG.goals.findIndex(x=>idEq(x.id,g.id));
          if(j>=0) CFG.goals[j].id=newId;
          g.id=newId;
          this._saveGoals();
        }
      }
    }catch(e){ console.warn('goals.save',e); }
    return g;
  },
  async updateGoal(id,patch){
    const gid=normId(id); if(!gid) return;
    const idx=(CFG.goals||[]).findIndex(x=>idEq(x.id,gid));
    if(idx<0) return;
    CFG.goals[idx]=Object.assign({},CFG.goals[idx],patch||{});
    const g=CFG.goals[idx];
    g.target=+g.target||0;
    g.current=+g.current||0;
    g.completed=!!g.completed || (g.target>0 && g.current>=g.target);
    this._saveGoals();
    if(!db || !isUUID(gid) || isLocalId(gid,'lg')) return;
    try{
      const row={};
      ['name','target','current','deadline','completed','color'].forEach(k=>{ if(patch && k in patch) row[k]=patch[k]; });
      if('target' in row) row.target=+row.target||0;
      if('current' in row) row.current=+row.current||0;
      if('deadline' in row) row.deadline=row.deadline||null;
      await db.from('goals').update(row).eq('id',gid);
    }catch(e){ console.warn('goals.update',e); }
  },
  async deleteGoal(id){
    const gid=normId(id); if(!gid) return;
    CFG.goals=(CFG.goals||[]).filter(x=>!idEq(x.id,gid));
    this._saveGoals();
    if(!db || !isUUID(gid) || isLocalId(gid,'lg')) return;
    try{ await db.from('goals').delete().eq('id',gid); }catch(e){ console.warn('goals.delete',e); }
  },

  /* ── DEBTS ───────────────────────────────────────────── */
  _saveDebts(){ localStorage.setItem('mpx_debts',JSON.stringify(CFG.debts||[])); },
  async loadDebts(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_debts')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('debts').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          CFG.debts=data.map(r=>({id:normId(r.id),person:r.person,amount:+r.amount||0,type:r.type,note:r.note||'',date:r.date,settled:!!r.settled}));
          this._saveDebts();
          return;
        }
      }catch(e){ console.warn('debts.load',e); }
    }
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_debts')||'null');
      if(lc?.length){ CFG.debts=lc.map(d=>({...(d||{}),id:normId(d.id)})); return; }
    }catch(e){}
    CFG.debts=(CFG.debts||[]).map(d=>({...(d||{}),id:normId(d.id)}));
  },
  async saveDebt(debt){
    if(!CFG.debts) CFG.debts=[];
    const d={...(debt||{})};
    d.id=normId(d.id)||('ld'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    d.person=(d.person||'').trim();
    d.amount=+d.amount||0;
    d.type=d.type==='lend'?'lend':'borrow';
    d.note=d.note||'';
    d.date=d.date||fmtDate(new Date());
    d.settled=!!d.settled;
    if(!d.person||!d.amount||d.amount<=0) return d;
    const idx=CFG.debts.findIndex(x=>idEq(x.id,d.id));
    if(idx>=0) CFG.debts[idx]=Object.assign({},CFG.debts[idx],d);
    else CFG.debts.unshift(d);
    this._saveDebts();
    if(!db) return d;
    try{
      const row={person:d.person,amount:d.amount,type:d.type,note:d.note,date:d.date,settled:d.settled};
      if(isUUID(d.id) && !isLocalId(d.id,'ld')){
        await db.from('debts').upsert({id:d.id,...row},{onConflict:'id'});
      } else {
        const {data,error}=await db.from('debts').insert([row]).select();
        if(error) throw error;
        if(data?.[0]?.id){
          const newId=data[0].id;
          const j=CFG.debts.findIndex(x=>idEq(x.id,d.id));
          if(j>=0) CFG.debts[j].id=newId;
          d.id=newId;
          this._saveDebts();
        }
      }
    }catch(e){ console.warn('debts.save',e); }
    return d;
  },
  async updateDebt(id,patch){
    const did=normId(id); if(!did) return;
    const idx=(CFG.debts||[]).findIndex(x=>idEq(x.id,did));
    if(idx<0) return;
    CFG.debts[idx]=Object.assign({},CFG.debts[idx],patch||{});
    const d=CFG.debts[idx];
    d.amount=+d.amount||0;
    d.settled=!!d.settled;
    this._saveDebts();
    if(!db || !isUUID(did) || isLocalId(did,'ld')) return;
    try{
      const row={};
      ['person','amount','type','note','date','settled'].forEach(k=>{ if(patch && k in patch) row[k]=patch[k]; });
      if('amount' in row) row.amount=+row.amount||0;
      await db.from('debts').update(row).eq('id',did);
    }catch(e){ console.warn('debts.update',e); }
  },
  async deleteDebt(id){
    const did=normId(id); if(!did) return;
    CFG.debts=(CFG.debts||[]).filter(x=>!idEq(x.id,did));
    this._saveDebts();
    if(!db || !isUUID(did) || isLocalId(did,'ld')) return;
    try{ await db.from('debts').delete().eq('id',did); }catch(e){ console.warn('debts.delete',e); }
  },

  /* ── SUBSCRIPTIONS ───────────────────────────────────── */
  _saveSubs(){ localStorage.setItem('mpx_subscriptions',JSON.stringify(CFG.subscriptions||[])); },
  async loadSubscriptions(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_subscriptions')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('subscriptions').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          const today=fmtDate(new Date());
          CFG.subscriptions=data.map(r=>({
            id:normId(r.id),
            name:r.name,
            amount:+r.amount||0,
            frequency:r.frequency||r.billing_cycle||r.cycle||'monthly',
            nextDate:r.next_date||r.next_billing||r.nextDate||today,
            active:r.active!==false,
            color:r.color||null,
          }));
          this._saveSubs();
          return;
        }
      }catch(e){ console.warn('subs.load',e); }
    }
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_subscriptions')||'null');
      if(lc?.length){ CFG.subscriptions=lc.map(s=>({...(s||{}),id:normId(s.id)})); return; }
    }catch(e){}
    CFG.subscriptions=(CFG.subscriptions||[]).map(s=>({...(s||{}),id:normId(s.id)}));
  },
  async saveSub(sub){
    if(!CFG.subscriptions) CFG.subscriptions=[];
    const s={...(sub||{})};
    s.id=normId(s.id)||('ls'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    s.name=(s.name||'').trim();
    s.amount=+s.amount||0;
    s.frequency=s.frequency||s.cycle||'monthly';
    s.nextDate=s.nextDate||s.next||fmtDate(new Date());
    s.active=s.active!==false;
    if(!s.name||!s.amount||s.amount<=0) return s;
    const idx=CFG.subscriptions.findIndex(x=>idEq(x.id,s.id));
    if(idx>=0) CFG.subscriptions[idx]=Object.assign({},CFG.subscriptions[idx],s);
    else CFG.subscriptions.unshift(s);
    this._saveSubs();
    if(!db) return s;
    const rowV3={name:s.name,amount:s.amount,frequency:s.frequency,next_date:s.nextDate,active:s.active,color:s.color||null};
    const rowLegacy={name:s.name,amount:s.amount,billing_cycle:s.frequency,next_billing:s.nextDate,active:s.active,color:s.color||null};
    try{
      if(isUUID(s.id) && !isLocalId(s.id,'ls')){
        let res=await db.from('subscriptions').upsert({id:s.id,...rowV3},{onConflict:'id'});
        if(res?.error) res=await db.from('subscriptions').upsert({id:s.id,...rowLegacy},{onConflict:'id'});
        if(res?.error) throw res.error;
      } else {
        let res=await db.from('subscriptions').insert([rowV3]).select();
        if(res?.error) res=await db.from('subscriptions').insert([rowLegacy]).select();
        if(res?.error) throw res.error;
        if(res?.data?.[0]?.id){
          const newId=res.data[0].id;
          const j=CFG.subscriptions.findIndex(x=>idEq(x.id,s.id));
          if(j>=0) CFG.subscriptions[j].id=newId;
          s.id=newId;
          this._saveSubs();
        }
      }
    }catch(e){ console.warn('subs.save',e); }
    return s;
  },
  async deleteSub(id){
    const sid=normId(id); if(!sid) return;
    CFG.subscriptions=(CFG.subscriptions||[]).filter(x=>!idEq(x.id,sid));
    this._saveSubs();
    if(!db || !isUUID(sid) || isLocalId(sid,'ls')) return;
    try{ await db.from('subscriptions').delete().eq('id',sid); }catch(e){ console.warn('subs.delete',e); }
  },

  /* ── MIGRATE LOCAL → DB ──────────────────────────────── */
  async migrateAll(){
    if(!db){ toast('Connetti Supabase prima','warn'); return; }
    toast('Migrazione in corso...','info');
    let ok=0,fail=0;
    const run=async(fn,label)=>{ try{ await fn(); ok++; }catch(e){ fail++; console.warn(label,e); } };

    await run(async()=>{
      const rows=CFG._accounts.map((a,i)=>({name:a.name,type:a.type,color:a.color,icon:a.icon,initial_balance:a.initialBalance||0,sort_order:i}));
      if(rows.length) await db.from('accounts').upsert(rows,{onConflict:'name'});
    },'accounts');
    await run(async()=>{
      const rows=Object.entries(CFG.budgets||{}).map(([k,v])=>({category_key:k,amount:v,updated_at:new Date().toISOString()}));
      if(rows.length) await db.from('budgets').upsert(rows,{onConflict:'category_key'});
    },'budgets');
    await run(async()=>{
      if(!CFG.templates?.length) return;
      for(const t of CFG.templates){
        const row={name:t.name,type:t.type,amount:t.amount||null,category_key:t.category_id||null,account_name:t.account||null,description:t.description||null,tags:t.tags||'[]'};
        if(isUUID(t.id)){
          const res=await db.from('templates').upsert({id:t.id,...row},{onConflict:'id'});
          if(res?.error) throw res.error;
        } else {
          const res=await db.from('templates').insert([row]).select();
          if(res?.error) throw res.error;
          if(res?.data?.[0]?.id) t.id=res.data[0].id;
        }
      }
      this._saveTpl();
    },'templates');
    await run(async()=>{
      if(!CFG.notes?.length) return;
      for(const n of CFG.notes){
        const row={text:n.text,done:!!n.done,date:n.date||fmtDate(new Date())};
        if(isUUID(n.id)){
          const res=await db.from('notes').upsert({id:n.id,...row},{onConflict:'id'});
          if(res?.error) throw res.error;
        } else {
          const res=await db.from('notes').insert([row]).select();
          if(res?.error) throw res.error;
          if(res?.data?.[0]?.id) n.id=res.data[0].id;
        }
      }
      this._saveNotes();
    },'notes');

    await run(async()=>{
      for(const g of (CFG.goals||[])) await this.saveGoal(g);
    },'goals');
    await run(async()=>{
      for(const d of (CFG.debts||[])) await this.saveDebt(d);
    },'debts');
    await run(async()=>{
      for(const s of (CFG.subscriptions||[])) await this.saveSub(s);
    },'subscriptions');

    await run(async()=>{
      const meta=loadMeta();
      const entries=Object.entries(meta||{}).filter(([k,v])=>isUUID(k)&&(v?.account_to||v?.tags&&v.tags!=='[]'));
      for(const [txId,m] of entries) await this.saveTxMeta(txId,{account_to:m.account_to||null,tags:m.tags||'[]'});
    },'txmeta');

    await run(async()=>{
      // migrate local (offline) transactions into DB
      const localTxs=(loadTxs()||[]).filter(t=>!isUUID(t.id));
      if(!localTxs.length) return;
      for(const t of localTxs){
        if(t.type==='transfer'){
          const ref=genUUID();
          const desc=t.description||`Giro ${t.account}→${t.account_to}`;
          const rowOut=toDbPayload(t,'expense',`[GIRO:${ref}] ${desc}`);
          const rowIn ={...toDbPayload(t,'income', `[GIRO:${ref}] ${desc}`), account:t.account_to};
          const [r1,r2]=await Promise.all([dbInsertTxRow(rowOut), dbInsertTxRow(rowIn)]);
          if(r1.error) throw r1.error;
          if(r2.error) throw r2.error;
        } else {
          const row=toDbPayload(t);
          const res=await dbInsertTxRow(row);
          if(res.error) throw res.error;
          const newId=res.data?.[0]?.id;
          if(newId){
            const tags=t.tags||'[]';
            const account_to=t.account_to||null;
            if(account_to||tags!=='[]') await this.saveTxMeta(newId,{account_to,tags});
          }
        }
      }
    },'transactions');

    await run(()=>this.updateAllBalances(),'balances');
    await run(()=>this.pushSettings(),'settings');

    toast(`✅ Migrazione: ${ok} OK · ${fail} errori`,'success');
    await _syncAllFromDB();
  },
};

/* ============================================================
   INIT — asincrono: localStorage subito, poi DB in background
============================================================ */
async function init(){
  // 1. Carica CFG da localStorage (fast, sincrono)
  try{ CFG=Object.assign(CFG,loadCfg()); }catch(e){}
  if(!localStorage.getItem('mpxCfg2') && window.matchMedia('(prefers-color-scheme:dark)').matches) CFG.theme='dark';
  if(!CFG.templates)     CFG.templates=[];
  if(!CFG.notes)         CFG.notes=[];
  if(!CFG.recurringTxs)  CFG.recurringTxs=[];
  if(!CFG.fx)            CFG.fx={EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
  if(!CFG.budgets)       CFG.budgets={};
  if(!CFG.ach)           CFG.ach={};
  if(!CFG.layout)        CFG.layout={};
  if(!CFG._accounts)     CFG._accounts=[];
  if(!CFG.subscriptions) CFG.subscriptions=[];
  if(!CFG.debts)         CFG.debts=[];
  if(!CFG.goals)         CFG.goals=[];

  // Prefer per-entity caches (newer than CFG snapshot in mpxCfg2)
  try{ const subs=JSON.parse(localStorage.getItem('mpx_subscriptions')||'null'); if(subs?.length) CFG.subscriptions=subs; }catch(e){}
  try{ const debts=JSON.parse(localStorage.getItem('mpx_debts')||'null'); if(debts?.length) CFG.debts=debts; }catch(e){}
  try{ const goals=JSON.parse(localStorage.getItem('mpx_goals')||'null'); if(goals?.length) CFG.goals=goals; }catch(e){}
  // One-time backfill for users coming from older versions
  if(localStorage.getItem('mpx_subscriptions')==null && CFG.subscriptions?.length) localStorage.setItem('mpx_subscriptions',JSON.stringify(CFG.subscriptions));
  if(localStorage.getItem('mpx_debts')==null && CFG.debts?.length) localStorage.setItem('mpx_debts',JSON.stringify(CFG.debts));
  if(localStorage.getItem('mpx_goals')==null && CFG.goals?.length) localStorage.setItem('mpx_goals',JSON.stringify(CFG.goals));
  // Normalize ids to strings (DB ids are UUID strings)
  try{ CFG.subscriptions=(CFG.subscriptions||[]).map(s=>({...(s||{}),id:normId(s.id)})); }catch(e){}
  try{ CFG.debts=(CFG.debts||[]).map(d=>({...(d||{}),id:normId(d.id)})); }catch(e){}
  try{ CFG.goals=(CFG.goals||[]).map(g=>({...(g||{}),id:normId(g.id)})); }catch(e){}

  // 2. Tema e colore immediati
  applyTheme();
  applyColor(CFG.color||'#0066FF');
  try{ renderBalToggleBtn(); }catch(e){}

  // 3. UI base
  try{ document.getElementById('darkT').checked=CFG.theme==='dark'; }catch(e){}
  try{ document.getElementById('currS').value=CFG.currency||'€'; }catch(e){}
  try{ document.getElementById('gNameI').value=CFG.goalName||''; }catch(e){}
  try{ document.getElementById('gValI').value=CFG.goalVal||''; }catch(e){}

  // 4. Carica conti da localStorage/defaults
  await DBS.loadAccounts();

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
  try{ S._localMeta=loadMeta(); }catch(e){ S._localMeta={}; }
  try{ S.txs=loadTxs(); }catch(e){ S.txs=[]; }
  S.period = S.period || 'month';
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
    if(CFG.pinEnabled&&CFG.pin){ const ps=document.getElementById('pinScreen'); if(ps) ps.classList.remove('hidden'); const sk=document.getElementById('pinSkip'); if(sk) sk.style.display='none'; }
  }catch(e){}

  // 11. Carica tutto dal DB in background
  if(!OFFLINE && db){
    _syncAllFromDB();
  }
}

async function _syncAllFromDB(){
  updateSyncStatus('loading');
  try{
    await Promise.all([
      DBS.pullSettings(),
      DBS.loadAccounts(),
      DBS.loadCustomCategories(),
      DBS.loadBudgets(),
      DBS.loadTemplates(),
      DBS.loadNotes(),
      DBS.loadDebts(),
      DBS.loadSubscriptions(),
      DBS.loadGoals(),
    ]);
    // meta must load before transactions render (tags live here)
    await DBS.loadTxMeta();
    await loadData(true);
    // re-apply settings pulled from DB
    try{ document.getElementById('darkT').checked=CFG.theme==='dark'; applyTheme(); }catch(e){}
    try{ document.getElementById('currS').value=CFG.currency||'€'; }catch(e){}
    applyColor(CFG.color||'#0066FF');
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
function migrateLocalToDB(){ DBS.migrateAll(); }

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
function openModal(id){
  closeAll(false);
  document.getElementById('ov').classList.add('on');
  document.getElementById(id).classList.add('on');
  lucide.createIcons();
}
function closeAll(saveState=true){
  document.querySelectorAll('.sh-up.on').forEach(m=>m.classList.remove('on'));
  document.getElementById('ov').classList.remove('on');
  S.editId=null;
}
function openAdd(){
  haptic(); S.editId=null;
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
  const v=parseFloat(S.calcVal)||parseFloat(S.calcDisp)||0;
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
  S.fType = t;
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
  const t = S.txs.find(x=>x.id===id);
  if(!t) return;
  S.editId = id;
  document.getElementById('mTitle').textContent='Modifica';
  populateWalletSel();
  setFType(t.type||'expense');
  document.getElementById('txAmt').value  = t.amount;
  document.getElementById('txDate').value = t.date;
  try{ const ti=document.getElementById('txTime'); if(ti) ti.value=normTime(t.time)||''; }catch(e){}
  document.getElementById('txDesc').value = t.description||'';
  if(t.type==='transfer'){
    document.getElementById('txAccFrom').value = t.account||CFG.wallets[0];
    document.getElementById('txAccTo').value   = t.account_to||(CFG.wallets[1]||CFG.wallets[0]);
    setTimeout(()=>{
      renderAccPicker('accFromWrap','txAccFrom', t.account);
      renderAccPicker('accToWrap','txAccTo', t.account_to);
    },50);
  } else {
    if(t.category_id){
      document.getElementById('txCat').value = t.category_id;
      setTimeout(()=>{ renderCatPicker('catPickWrap','txCat'); },50);
    }
    document.getElementById('txAcc').value = t.account||CFG.wallets[0];
    setTimeout(()=>renderAccPicker('accPickWrap','txAcc', t.account),50);
    const savedTags = t.tags ? (typeof t.tags==='string'?JSON.parse(t.tags):t.tags) : [];
    document.querySelectorAll('.tbtn').forEach(b=>b.classList.toggle('on', savedTags.includes(b.dataset.tag)));
  }
  openModal('addM');
}

/* ============================================================
   POPULATE WALLET SELECT
============================================================ */
function populateWalletSel(){
  const accounts=CFG._accounts?.length ? CFG._accounts : (CFG.wallets||['Principale']).map(w=>({id:w,name:w,color:'var(--br)',icon:'wallet'}));
  const wallets=accounts.map(a=>a.name);
  const opts = wallets.map(w=>`<option value="${w}">${w}</option>`).join('');
  const defaultWallet = (CFG.defaultWallet && wallets.includes(CFG.defaultWallet)) ? CFG.defaultWallet : (wallets[0] || 'Principale');
  const defaultTo = wallets.find(w=>w!==defaultWallet) || defaultWallet;
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
  if(defW){ defW.innerHTML=opts; defW.value=defaultWallet; }
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
  const accounts=CFG._accounts?.length ? CFG._accounts : (CFG.wallets||['Principale']).map(w=>({id:w,name:w,color:'var(--br)',icon:'wallet'}));
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
    html+=`<button type="button" class="icon-pick-btn ${curIcon==='ft:'+key?'selected':''}" onclick="selectAccIcon('ft:${key}',this)" title="${b.label}">
      <div class="icon-preview ft-badge" style="background:${b.bg};font-size:10px">${b.text}</div>
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
  if(!CFG.layout) return;
  document.querySelectorAll('[data-zone]').forEach(zoneEl=>{
    const zone=zoneEl.dataset.zone;
    const order=CFG.layout?.[zone];
    if(Array.isArray(order) && order.length) _applyOrder(zoneEl, order);
  });
}

function setLayoutFromDOM(zone){
  const zoneEl=document.querySelector(`[data-zone="${zone}"]`);
  if(!zoneEl) return;
  if(!CFG.layout) CFG.layout={};
  CFG.layout[zone]=Array.from(zoneEl.children).map(el=>el?.dataset?.block).filter(Boolean);
}

function _queueLayoutPersist(){
  clearTimeout(_layoutSaveT);
  _layoutSaveT=setTimeout(()=>{ try{ saveCfg(); }catch(e){} }, 260);
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
  if(!S.layoutMode) return;
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
  S.layoutMode=true;
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
  S.layoutMode=false;
  document.body.classList.remove('layout-edit');
  refreshLayoutEditUI();
  document.getElementById('layoutBar')?.remove();
  try{ toast('Layout salvato ✓','success'); }catch(e){}
}

function toggleLayoutMode(force){
  const want = (typeof force==='boolean') ? force : !S.layoutMode;
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
      if(!CFG.layout) CFG.layout={};
      CFG.layout[z]=[...ord];
    } else if(CFG.layout) {
      delete CFG.layout[z];
    }
  });
  _queueLayoutPersist();
  if(S.layoutMode) refreshLayoutEditUI();
}

function installLayoutDnD(){
  if(_layoutDnDInstalled) return;
  _layoutDnDInstalled=true;

  const cleanup=()=>{
    document.querySelectorAll('[data-block].dragging').forEach(x=>x.classList.remove('dragging'));
    document.querySelectorAll('[data-block].dragOver').forEach(x=>x.classList.remove('dragOver'));
    S._layoutDrag=null;
    S._layoutOverId=null;
  };

  document.addEventListener('dragstart',e=>{
    if(!S.layoutMode) return;
    const blk=e.target?.closest?.('[data-block]');
    if(!blk || !blk.draggable) return;
    const zoneEl=blk.closest?.('[data-zone]');
    const zone=zoneEl?.dataset?.zone;
    const id=blk.dataset.block;
    if(!zone || !id) return;
    S._layoutDrag={zone,id};
    blk.classList.add('dragging');
    try{
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain', id);
    }catch(err){}
  });

  document.addEventListener('dragover',e=>{
    if(!S.layoutMode || !S._layoutDrag) return;
    const zoneEl=e.target?.closest?.(`[data-zone="${S._layoutDrag.zone}"]`);
    if(!zoneEl) return;
    e.preventDefault();
    const over=e.target?.closest?.('[data-block]');
    if(over){
      if(S._layoutOverId && S._layoutOverId!==over.dataset.block){
        zoneEl.querySelector(`[data-block="${S._layoutOverId}"]`)?.classList.remove('dragOver');
      }
      S._layoutOverId=over.dataset.block;
      over.classList.add('dragOver');
    }
  });

  document.addEventListener('drop',e=>{
    if(!S.layoutMode || !S._layoutDrag) return;
    const {zone,id}=S._layoutDrag;
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

  document.addEventListener('dragend',()=>{ if(S.layoutMode) cleanup(); });
}

function renderAll(){
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
  const year  = S.viewDate.getFullYear();
  const month = S.viewDate.getMonth();
  const dim   = new Date(year,month+1,0).getDate();

  // wallet balances — start from initialBalance for each account
  const accounts=CFG._accounts?.length?CFG._accounts:(CFG.wallets||[]).map(w=>({name:w,initialBalance:0}));
  const wB={};
  accounts.forEach(a=>{ wB[a.name]=a.initialBalance||0; });

  S.txs.forEach(t=>{
    const a=+t.amount, w=t.account||(accounts[0]?.name||'Principale');
    if(t.type==='transfer'){
      if(wB[w]!==undefined) wB[w]-=a;
      if(t.account_to&&wB[t.account_to]!==undefined) wB[t.account_to]+=a;
    } else {
      if(wB[w]!==undefined) wB[w]+= t.type==='expense'?-a:a;
    }
  });

  // Patrimonio netto = somma di tutti i saldi dei conti
  const totalNet=Object.values(wB).reduce((s,v)=>s+v,0);

  // month transactions
  const mTxs = S.txs.filter(t=>{
    const d=new Date(t.date+'T12:00');
    return d.getMonth()===month && d.getFullYear()===year && t.type!=='transfer';
  });
  const tIn  = mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const tOut = mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const sr   = srFor(S.txs, S.viewDate);

  // hero balance
  const balEl = document.getElementById('uiBal');
  if(balEl){
    const show = CFG.showBalance;
    balEl.textContent = show ? fmtFull(totalNet) : '••••••';
    balEl.style.filter = show ? 'none' : 'blur(8px)';
  }
  setEl('uiIn',  fmtShort(tIn));
  setEl('uiOut', fmtShort(tOut));
  setEl('uiSav', sr>0 ? sr.toFixed(0)+'%' : '0%');

  // month label
  setEl('monthLbl', S.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'}));

  // health score
  renderHealthScore(sr, tIn, tOut);
  renderWallets(wB, totalNet);
  updateGoal(totalNet);
  renderBudgetMini(mTxs);
  renderForecast(mTxs, tOut, tIn, dim);
  renderInsights(mTxs, tIn, tOut, sr);
  renderQuickStats(mTxs, tOut);
  renderSparkline(year, month);
  renderRecentTxs();
  try{ renderDebtsMini(); }catch(e){}
  try{ renderSubsMini(); }catch(e){}

  // savings rate gauge (stats tab)
  setEl('srPct', sr>0?sr+'%':'0%');
  setEl('srPctRing', sr>0?sr+'%':'0%');
  setEl('srLbl', sr>30?'Ottimo risparmio 💪':sr>10?'Risparmio nella media':sr>0?'Risparmio basso':'Nessun risparmio');
  const srRing=document.getElementById('srRing');
  if(srRing){
    const dash=parseFloat(srRing.getAttribute('stroke-dasharray')||'226')||226;
    setTimeout(()=>{const p=Math.max(0,Math.min(100,sr));srRing.style.strokeDashoffset=dash-(p/100)*dash;},200);
  }

  // trend badge vs prev month
  const prevDate=new Date(year,month-1,1);
  const prevOut=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===prevDate.getMonth()&&d.getFullYear()===prevDate.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const trendPEl=document.getElementById('trendP');
  if(trendPEl&&prevOut>0){
    const diff=Math.round((tOut-prevOut)/prevOut*100);
    trendPEl.textContent=(diff>0?'+':'')+diff+'%';
    trendPEl.style.background=diff>0?'rgba(255,59,92,.18)':'rgba(0,200,150,.18)';
    trendPEl.style.color=diff>0?'var(--bd)':'var(--ok)';
  }
}

/* ============================================================
   HELPERS
============================================================ */
function setEl(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function fmt(n){ return (CFG.currency||'€')+' '+parseFloat(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtFull(n){ return (CFG.currency||'€')+' '+parseFloat(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtShort(n){
  const abs=Math.abs(parseFloat(n));
  if(abs>=1000000) return (CFG.currency||'€')+' '+(abs/1000000).toFixed(1)+'M';
  if(abs>=1000) return (CFG.currency||'€')+' '+(abs/1000).toFixed(1)+'k';
  return (CFG.currency||'€')+' '+abs.toLocaleString('it-IT',{minimumFractionDigits:0,maximumFractionDigits:0});
}
function td(){ return fmtDate(new Date()).replace(/-/g,''); }
function download(blob, name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
function haptic(){ if(navigator.vibrate) navigator.vibrate(8); }
function srFor(txs, d){
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
function renderHealthScore(sr, tIn, tOut){
  let score=50;
  if(sr>30) score+=20; else if(sr>0) score+=10; else if(sr<0) score-=20;
  if(tIn>tOut*1.3) score+=15;
  const bOver = Object.entries(CFG.budgets||{}).filter(([cat,lim])=>{
    const sp=S.txs.filter(t=>t.category_id===cat&&t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
    return +sp > +lim;
  }).length;
  score -= bOver*10;
  if(CFG.goalVal) score+=5;
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
function renderQuickStats(mTxs, tOut){
  const expenses = mTxs.filter(t=>t.type==='expense');
  const today=new Date().getDate();
  setEl('sAvg', today>0 ? fmtShort(tOut/today) : '—');
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
  let running=0;
  const vals=days.map(d=>{
    const day=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    S.txs.filter(t=>t.date===day&&t.type!=='transfer').forEach(t=>running+=t.type==='income'?+t.amount:-+t.amount);
    return running;
  });
  if(S.charts.spark) S.charts.spark.destroy();
  const ctx=canvas.getContext('2d');
  const col=vals[vals.length-1]>=0?'rgba(0,200,150,.8)':'rgba(255,59,92,.8)';
  S.charts.spark=new Chart(ctx,{type:'line',data:{labels:days,datasets:[{data:vals,borderColor:col,borderWidth:2,pointRadius:0,fill:true,backgroundColor:col.replace('.8','.12'),tension:.4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{enabled:false}},scales:{x:{display:false},y:{display:false}}}});
}

/* ============================================================
   RECENT TXS (home)
============================================================ */
function renderRecentTxs(){
  const el=document.getElementById('recentList');
  if(!el) return;
  const recent=[...S.txs].sort(cmpTxDTDesc).slice(0,5);
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
      : (CATS[t.category_id]||CATS.other);
    const amtCol = t.type==='expense'?'var(--bd)':t.type==='income'?'var(--ok)':'var(--wn)';
    const sign   = t.type==='expense'?'−':t.type==='income'?'+':'⇄';
    const dStr   = new Date(t.date+'T12:00').toLocaleDateString('it-IT',{day:'2-digit',month:'short'});
    const timeStr=normTime(t.time);
    const acc    = t.account||CFG.wallets[0];
    const accObj = CFG._accounts?.find(a=>a.name===acc);
    const brand  = detectBrand(acc);
    const accBadge = brand ? `<span class="ft-badge" style="width:14px;height:14px;border-radius:4px;background:${FINTECH_BRANDS[brand].bg};font-size:6px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:2px;vertical-align:middle;flex-shrink:0">${FINTECH_BRANDS[brand].text}</span>` : '';
    const title  = t.description || c.l;
    const subCat = t.description ? c.l : '';
    const subAcc = isTransfer ? `${acc} → ${t.account_to||'?'}` : acc;
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

  let filtered = S.txs.filter(t=>{
    const mt = (t.description||'').toLowerCase().includes(q)||(CATS[t.category_id]?.l||'').toLowerCase().includes(q);
    const mw = S.wFilter==='all'||(t.account||CFG.wallets[0])===S.wFilter||(t.type==='transfer'&&t.account_to===S.wFilter);
    const mty= S.txFilter==='all'||t.type===S.txFilter;
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
  const accounts=CFG._accounts?.length ? CFG._accounts : (CFG.wallets||[]).map(w=>({name:w,color:'var(--br)',icon:'wallet',initialBalance:0}));
  el.innerHTML=`
    <div onclick="filterWallet('all')" class="wc flex-shrink-0 w-36 card p-4 border cursor-pointer" style="border-color:${S.wFilter==='all'?'var(--br)':'var(--bo)'}">
      <p class="text-[9px] font-bold uppercase tracking-wider mb-2" style="color:var(--t2)"><i data-lucide="layout-grid" class="w-3 h-3 inline mr-1"></i>Tutti</p>
      <p class="text-xl font-black" style="font-variant-numeric:tabular-nums;color:${totalNet<0?'var(--bd)':'var(--t)'}">${fmtShort(totalNet)}</p>
    </div>`+accounts.map(acc=>{
      const bal=wB[acc.name]??0;
      return `<div onclick="filterWallet('${acc.name}')" class="wc flex-shrink-0 w-36 card p-4 border cursor-pointer" style="border-color:${S.wFilter===acc.name?acc.color:'var(--bo)'}">
        <p class="text-[9px] font-bold uppercase tracking-wider mb-2 truncate" style="color:${acc.color}">
          <i data-lucide="${acc.icon||'wallet'}" class="w-3 h-3 inline mr-1"></i>${acc.name}
        </p>
        <p class="text-xl font-black" style="font-variant-numeric:tabular-nums;color:${bal<0?'var(--bd)':'var(--t)'}">${fmtShort(bal)}</p>
      </div>`;
    }).join('')+'';
  // brand icons for wallets
  el.innerHTML = el.innerHTML; // refresh handled below
  const accounts2=CFG._accounts?.length ? CFG._accounts : (CFG.wallets||[]).map(w=>({name:w,color:'var(--br)',icon:'wallet',initialBalance:0}));
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
function filterWallet(w){ haptic(); S.wFilter=w; updateDash(); renderList(); }

/* ============================================================
   GOAL
============================================================ */
function updateGoal(net){
  const gb=document.getElementById('goalBox');
  if(!gb) return;
  if(CFG.goalVal&&parseFloat(CFG.goalVal)>0){
    gb.classList.remove('hidden');
    setEl('gName', CFG.goalName||'Obiettivo');
    const p=Math.max(0,Math.min(100,(net/parseFloat(CFG.goalVal))*100));
    setEl('gPct', Math.round(p)+'%');
    setEl('gAmt', `${fmt(Math.max(0,net))} / ${fmt(CFG.goalVal)}`);
    setTimeout(()=>{ const b=document.getElementById('gBar'); if(b) b.style.width=p+'%'; },120);
    if(p>=100) launchConfetti();
  } else gb.classList.add('hidden');
}

/* ============================================================
   BUDGET MINI
============================================================ */
function renderBudgetMini(mTxs){
  const bl=document.getElementById('budMini');
  if(!bl) return;
  if(!Object.keys(CFG.budgets||{}).length){
    bl.innerHTML=`<p class="text-sm text-center py-1" style="color:var(--t2)">Nessun budget. <button onclick="openBudM()" class="font-bold underline" style="color:var(--br)">Imposta ora</button></p>`;
    return;
  }
  bl.innerHTML=Object.entries(CFG.budgets).map(([cat,lim])=>{
    const c=CATS[cat]; if(!c) return '';
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
function renderForecast(mTxs, tOut, tIn, dim){
  const fb=document.getElementById('forecastBox');
  if(!fb) return;
  const today=new Date();
  if(today.getMonth()!==S.viewDate.getMonth()||today.getFullYear()!==S.viewDate.getFullYear()||today.getDate()<3){fb.classList.add('hidden');return;}
  fb.classList.remove('hidden');
  const daily=tOut/today.getDate();
  const proj=tOut+daily*(dim-today.getDate());
  const pct=tIn>0?Math.min(100,Math.round(proj/tIn*100)):0;
  setEl('foreAmt', fmt(proj));
  setEl('forePct', pct+'%');
  setEl('foreNote', proj>tIn?`⚠️ ${fmt(proj-tIn)} sopra le entrate`:`✅ ${fmt(tIn-proj)} sotto le entrate`);
  setTimeout(()=>{ const r=document.getElementById('foreRing'); if(r) r.style.strokeDashoffset=176-(pct/100)*176; },120);
}

/* ============================================================
   INSIGHTS
============================================================ */
function renderInsights(mTxs, tIn, tOut, sr){
  const list=[];
  const exp=mTxs.filter(t=>t.type==='expense');
  if(exp.length){
    const cats={};
    exp.forEach(t=>{ cats[t.category_id]=(cats[t.category_id]||0)+ +t.amount; });
    const topCat=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];
    if(topCat) list.push({e:'📊',t:`Top categoria: <b>${CATS[topCat[0]]?.l||topCat[0]}</b> — ${fmt(topCat[1])}`});
  }
  if(sr>30) list.push({e:'💰',t:`Ottimo! Stai risparmiando il <b>${sr}%</b> delle entrate`});
  else if(sr<0) list.push({e:'⚠️',t:`Attenzione: spendi più di quello che guadagni (<b>${sr}%</b>)`});
  const avgDay=tOut/(new Date().getDate()||1);
  list.push({e:'📅',t:`Spendi in media <b>${fmt(avgDay)}</b> al giorno questo mese`});
  if(tIn>0&&tOut>tIn*.9) list.push({e:'🚨',t:`Stai usando oltre il 90% delle entrate questo mese`});
  const daysLeft=new Date(S.viewDate.getFullYear(),S.viewDate.getMonth()+1,0).getDate()-new Date().getDate();
  if(daysLeft>0) list.push({e:'📆',t:`Mancano <b>${daysLeft} giorni</b> alla fine del mese`});
  const el=document.getElementById('insList');
  if(el) el.innerHTML=list.slice(0,3).map(i=>`<div class="flex items-start gap-2.5 py-2.5 border-b last:border-0" style="border-color:var(--bo)"><span class="text-lg">${i.e}</span><p class="text-sm leading-snug">${i.t}</p></div>`).join('');
  const elFull=document.getElementById('insDeep');
  if(elFull) elFull.innerHTML=list.map(i=>`<div class="flex items-start gap-2.5 py-3 border-b last:border-0" style="border-color:var(--bo)"><span class="text-xl">${i.e}</span><p class="text-sm leading-snug">${i.t}</p></div>`).join('');
}

/* ============================================================
   CHARTS
============================================================ */
function renderCharts(){
  const p=S.period||'month';
  const base=new Date(S.viewDate.getFullYear(),S.viewDate.getMonth(),1);
  const baseYear=base.getFullYear();
  const baseMonth=base.getMonth();

  const winMonths = p==='quarter'?3 : p==='year'?12 : 1;
  const winStart  = new Date(baseYear, baseMonth-(winMonths-1), 1);
  const winEnd    = new Date(baseYear, baseMonth+1, 0);
  const startStr  = fmtDate(winStart);
  const endStr    = fmtDate(winEnd);

  const winTxs=S.txs.filter(t=>t.type!=='transfer' && t.date>=startStr && t.date<=endStr);
  const winInc=winTxs.filter(t=>t.type==='income');
  const winExp=winTxs.filter(t=>t.type==='expense');

  const periodLbl=p==='quarter'?'3 mesi':p==='year'?'anno':'mese';
  setEl('statPeriodLbl2', periodLbl.charAt(0).toUpperCase()+periodLbl.slice(1));

  // ── HERO & KPI ──
  const incTotal = winInc.reduce((s,t)=>s+ +t.amount,0);
  const expTotal = winExp.reduce((s,t)=>s+ +t.amount,0);
  const sr       = incTotal>0 ? Math.round((1-expTotal/incTotal)*100) : 0;

  const netTotal=incTotal-expTotal;
  setEl('heroNet', fmt(netTotal));
  setEl('heroInc', fmt(incTotal));
  setEl('heroExp', fmt(expTotal));
  
  const srRingHero=document.getElementById('srRingHero');
  if(srRingHero){
    const dash=144;
    const pp=Math.max(0,Math.min(100,sr));
    srRingHero.style.strokeDashoffset=dash-(pp/100)*dash;
    setEl('srPctHero', sr+'%');
  }

  const daysWin=Math.max(1, Math.round((new Date(endStr+'T12:00')-new Date(startStr+'T12:00'))/(1000*60*60*24))+1);
  const avgDay=expTotal/daysWin;
  setEl('statAvgDay', expTotal>0?fmtShort(avgDay):'—');

  // Avg trend vs previous window (same length)
  const prevEnd=new Date(baseYear, baseMonth-winMonths+1, 0);
  const prevStart=new Date(baseYear, baseMonth-(2*winMonths-1), 1);
  const prevStartStr=fmtDate(prevStart);
  const prevEndStr=fmtDate(prevEnd);
  const prevExpTotal=S.txs.filter(t=>t.type==='expense' && t.date>=prevStartStr && t.date<=prevEndStr).reduce((s,t)=>s+ +t.amount,0);
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
  
  const topCatObj = topCat ? CATS[topCat[0]] : null;
  if(topCatObj) insights.push(`La tua spesa maggiore è stata in ${topCatObj.l} (${fmt(topCat[1])}).`);
  if(sr > 30) insights.push(`Risparmio eccellente del ${sr}%! Continua così.`);
  
  setEl('ins1', insights[0] || 'Nessun trend rilevante rilevato al momento.');
  setEl('ins2', insights[1] || 'Monitora le tue categorie per ottimizzare il budget.');

  setEl('statTopCat', topCat ? (CATS[topCat[0]]?.l||topCat[0]) : '—');
  setEl('statTopAmt', topCat ? fmt(topCat[1]) : '—');
  setEl('statTxCount', winTxs.length);

  // ── Chart 1: daily balance (base month) ──
  const dim=new Date(baseYear,baseMonth+1,0).getDate();
  const days=Array.from({length:dim},(_,i)=>i+1);
  let running=0;
  const balVals=days.map(d=>{
    const day=`${baseYear}-${String(baseMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    S.txs.filter(t=>t.date===day&&t.type!=='transfer').forEach(t=>running+=t.type==='income'?+t.amount:-+t.amount);
    return running;
  });
  const ctxLine = document.getElementById('cLine')?.getContext('2d');
  let gradientLine = 'var(--br)';
  if(ctxLine){
    gradientLine = ctxLine.createLinearGradient(0, 0, 0, 220);
    gradientLine.addColorStop(0, resolveCol('var(--br)'));
    gradientLine.addColorStop(1, 'rgba(0,102,255,0)');
  }
  makeChart('cLine','line',{labels:days,datasets:[{label:'Saldo',data:balVals,borderColor:resolveCol('var(--br)'),backgroundColor:gradientLine,fill:true,tension:.4,pointRadius:0,borderWidth:3}]},{scales:{y:{ticks:{callback:v=>fmtShort(v)},grid:{drawBorder:false,color:'rgba(0,0,0,0.03)'}},x:{grid:{display:false}}}});

  // ── Chart 2: 6-month income vs expense (ending at base month) ──
  const mLabels = [];
  const mInc = [];
  const mExp = [];
  for(let i=5; i>=0; i--){
    const d = new Date(baseYear, baseMonth-i, 1);
    mLabels.push(d.toLocaleDateString('it-IT',{month:'short'}));
    const start = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1));
    const end = fmtDate(new Date(d.getFullYear(), d.getMonth()+1, 0));
    const mtxs = S.txs.filter(t=>t.type!=='transfer' && t.date>=start && t.date<=end);
    mInc.push(mtxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0));
    mExp.push(mtxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0));
  }

  makeChart('c6m','bar',{labels:mLabels,datasets:[{label:'Entrate',data:mInc,backgroundColor:resolveCol('var(--ok)'),borderRadius:4,barThickness:12},{label:'Uscite',data:mExp,backgroundColor:resolveCol('var(--bd)'),borderRadius:4,barThickness:12}]},{scales:{y:{ticks:{callback:v=>fmtShort(v)},grid:{display:false}},x:{grid:{display:false}}}});

  // ── Chart 3: Donut ──
  const catEntries=Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).slice(0,7);
  setEl('donutTotal', fmtShort(expTotal));
  
  const ctxDonut = document.getElementById('cDonut')?.getContext('2d');
  const donutColors = catEntries.map(([k])=>CATS[k]?.col||'#888');

  makeChart('cDonut','doughnut',{labels:catEntries.map(([k])=>CATS[k]?.l||k),datasets:[{data:catEntries.map(([,v])=>v),backgroundColor:donutColors,borderWidth:0,hoverOffset:10,weight:0.5}]},{cutout:'70%',plugins:{legend:{display:false},tooltip:{enabled:true,backgroundColor:'rgba(0,0,0,0.8)',padding:12,cornerRadius:12,titleFont:{size:11,weight:'bold'},bodyFont:{size:13,weight:'900'}}}});

  // ── Chart 4: Temporal (Hour/Day) ──
  renderTemporalChart();

  renderHeatmap(baseYear, baseMonth);
  renderCategoryBars(winExp);
}

function switchTemporal(mode){
  S._tempMode = mode;
  document.getElementById('btnHour').classList.toggle('on', mode==='hour');
  document.getElementById('btnDay').classList.toggle('on', mode==='day');
  document.getElementById('btnHour').style.color = mode==='hour' ? 'var(--br)' : 'var(--t2)';
  document.getElementById('btnDay').style.color = mode==='day' ? 'var(--br)' : 'var(--t2)';
  document.getElementById('btnHour').style.borderColor = mode==='hour' ? 'var(--br)' : 'transparent';
  document.getElementById('btnDay').style.borderColor = mode==='day' ? 'var(--br)' : 'transparent';
  renderTemporalChart();
}

function renderTemporalChart(){
  const mode = S._tempMode || 'hour';
  const p=S.period||'month';
  const base=new Date(S.viewDate.getFullYear(),S.viewDate.getMonth(),1);
  const winMonths = p==='quarter'?3 : p==='year'?12 : 1;
  const winStart  = new Date(base.getFullYear(), base.getMonth()-(winMonths-1), 1);
  const winEnd    = new Date(base.getFullYear(), base.getMonth()+1, 0);
  const winExp=S.txs.filter(t=>t.type==='expense' && t.date>=fmtDate(winStart) && t.date<=fmtDate(winEnd));

  if(mode === 'hour'){
    const hLabels=Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
    const hVals=Array(24).fill(0);
    winExp.forEach(t=>{
      const hh=parseInt((normTime(t.time)||'12:00').split(':')[0],10);
      if(Number.isFinite(hh) && hh>=0 && hh<=23) hVals[hh]+= +t.amount;
    });
    makeChart('cTemporal','bar',{labels:hLabels,datasets:[{label:'Spese',data:hVals,backgroundColor:resolveCol('var(--br)'),borderRadius:4}]},{scales:{y:{display:false},x:{grid:{display:false}}}});
  } else {
    const wdLabels=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
    const wdVals=Array(7).fill(0);
    winExp.forEach(t=>{ const wd=new Date(t.date+'T12:00').getDay(); wdVals[wd]+= +t.amount; });
    makeChart('cTemporal','bar',{labels:wdLabels,datasets:[{label:'Spese',data:wdVals,backgroundColor:wdVals.map((_,i)=>i===0||i===6?resolveCol('var(--wn)'):resolveCol('var(--br)')),borderRadius:4}]},{scales:{y:{display:false},x:{grid:{display:false}}}});
  }
}
function makeChart(id,type,data,extraOpts={}){
  const canvas=document.getElementById(id);
  if(!canvas) return;
  if(S.charts[id]) try{S.charts[id].destroy();}catch(e){}
  const defaults={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:i=>' '+fmt(i.raw)}}}};
  try{
    if(data.datasets){
      data.datasets.forEach(ds=>{
        if(ds.borderColor) ds.borderColor=resolveCol(ds.borderColor);
        if(ds.backgroundColor) ds.backgroundColor=resolveCol(ds.backgroundColor);
        if(Array.isArray(ds.backgroundColor)) ds.backgroundColor=ds.backgroundColor.map(c=>resolveCol(c));
      });
    }
    S.charts[id]=new Chart(canvas.getContext('2d'),{type,data,options:Object.assign({},defaults,extraOpts)});
  }catch(e){ console.warn('makeChart error',id,e); }
}
function renderHeatmap(year, month){
  const el=document.getElementById('heatmap');
  if(!el) return;
  const dim=new Date(year,month+1,0).getDate();
  const dayExp={};
  S.txs.filter(t=>{ const d=new Date(t.date+'T12:00'); return d.getMonth()===month&&d.getFullYear()===year&&t.type==='expense'; }).forEach(t=>{dayExp[t.date]=(dayExp[t.date]||0)+ +t.amount;});
  const maxE=Math.max(...Object.values(dayExp),1);
  const cells=Array.from({length:dim},(_,i)=>{
    const d=i+1;
    const key=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const val=dayExp[key]||0;
    const intensity=val/maxE;
    const alpha=(intensity*.85+.05).toFixed(2);
    const col=val>0?`rgba(255,59,92,${alpha})`:'var(--bg2)';
    const txtCol=val>0?'#fff':'var(--t2)';
    return `<button class="hc" title="${key}: ${fmt(val)}" style="background:${col};color:${txtCol}" onclick="openDayDetails('${key}')">${d}</button>`;
  }).join('');
  el.innerHTML=`<div class="flex flex-wrap gap-1">${cells}</div>`;
}

function openDayDetails(dateStr){
  haptic();
  S._dayFocus=dateStr;
  renderDayDetails();
  openModal('dayM');
}
function renderDayDetails(){
  const dateStr=S._dayFocus;
  if(!dateStr) return;
  const d=new Date(dateStr+'T12:00');
  const title=d.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const tEl=document.getElementById('dayTitle'); if(tEl) tEl.textContent=title;
  const dayTxs=S.txs.filter(t=>t.date===dateStr);
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
  const dateStr=S._dayFocus;
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
    const c=CATS[k]||{l:k,col:'#888'};
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
  S.period=p;
  document.querySelectorAll('.ptab').forEach(b=>b.classList.remove('on'));
  document.getElementById('p'+p[0]).classList.add('on');
  renderCharts();
}

/* ============================================================
   MONTH NAV
============================================================ */
function changeMonth(d){ S.viewDate=new Date(S.viewDate.getFullYear(),S.viewDate.getMonth()+d,1); updateDash(); }
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
    if(S.layoutMode) refreshLayoutEditUI();
    setTimeout(()=>{ try{ queueRevealScan(); }catch(e){} },40);
  };

  if(cur){
    cur.classList.add('leave');
    clearTimeout(S._tabLeaveT);
    S._tabLeaveT=setTimeout(showNext,220);
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
  document.body.classList.toggle('dark', CFG.theme==='dark'||(CFG.theme==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches));
  const mt=document.getElementById('metaTheme'); if(mt) mt.content=getComputedStyle(document.documentElement).getPropertyValue('--br').trim()||'#0066FF';
}
function applyColor(hex){
  CFG.color=hex;
  document.documentElement.style.setProperty('--br',hex);
  const mt=document.getElementById('metaTheme'); if(mt) mt.content=hex;
}
function toggleDark(v){ CFG.theme=v?'dark':'light'; applyTheme(); saveCfg(); }
function saveSettings(){
  CFG.currency = document.getElementById('currS')?.value||'€';
  CFG.defaultWallet = document.getElementById('defWalletS')?.value || CFG.defaultWallet || '';
  CFG.goalName = document.getElementById('gNameI')?.value||'';
  CFG.goalVal  = document.getElementById('gValI')?.value||'';
  saveCfg(); renderAll();
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
  el.innerHTML=colors.map(c=>`<div onclick="applyColor('${c}');saveCfg();buildColorPicker()" style="width:32px;height:32px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${CFG.color===c?'var(--t)':'transparent'};transition:.2s;box-shadow:${CFG.color===c?'0 0 0 2px '+c:'none'}"></div>`).join('');
}
function renderWalletSettings(){
  const el=document.getElementById('wList'); if(!el) return;
  if(!CFG._accounts?.length){ el.innerHTML='<p class="text-xs py-2" style="color:var(--t2)">Nessun conto</p>'; return; }
  const typeLabel={checking:'Corrente',savings:'Risparmi',cash:'Contanti',credit:'Credito',invest:'Investimenti'};
  el.innerHTML=CFG._accounts.map(acc=>{
    const brand=detectBrand(acc.name);
    const iconEl=brand
      ? `<div class="ft-badge" style="width:32px;height:32px;border-radius:10px;background:${FINTECH_BRANDS[brand].bg};font-size:11px">${FINTECH_BRANDS[brand].text}</div>`
      : `<div style="width:32px;height:32px;border-radius:10px;background:${acc.color}22;display:flex;align-items:center;justify-content:center"><i data-lucide="${acc.icon||'wallet'}" style="width:14px;height:14px;color:${acc.color}"></i></div>`;
    const bal=acc.currentBalance??DBS.computeBalance(acc.name);
    return `<div class="flex items-center gap-2 py-2 px-3 rounded-2xl" style="background:var(--bg2)">
      ${iconEl}
      <div class="flex-1 min-w-0">
        <p class="text-xs font-bold truncate">${acc.name}</p>
        <p class="text-[9px]" style="color:var(--t2)">${typeLabel[acc.type]||acc.type}${brand?' · '+FINTECH_BRANDS[brand].label:''}</p>
        <p class="text-xs font-black" style="color:${bal<0?'var(--bd)':'var(--ok)'};font-variant-numeric:tabular-nums">${fmt(bal)}</p>
      </div>
      <input type="text" value="${acc.name}" onchange="renameWallet('${acc.id}',this.value,'${acc.name}')" class="inp w-20 py-1 text-xs text-right" placeholder="Rinomina">
      <button onclick="removeWallet('${acc.id}')" class="p-1.5 rounded-xl flex-shrink-0" style="background:rgba(255,59,92,.1);color:var(--bd)"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
    </div>`;
  }).join('');
  lucide.createIcons();
}

async function recalcAllBalances(){
  toast('Ricalcolo saldi...','info');
  await DBS.updateAllBalances();
  renderWalletSettings();
  renderAll();
  toast('Saldi aggiornati ✓','success');
}
async function addWallet(){
  const n=document.getElementById('nWallet')?.value.trim();
  if(!n){toast('Inserisci un nome','warn');return;}
  if(CFG._accounts?.find(a=>a.name===n)){toast('Conto già esistente','warn');return;}
  const type=document.getElementById('nWalletType')?.value||'checking';
  const bal=parseFloat(document.getElementById('nWalletBal')?.value)||0;
  const color=_ACC_COLORS[_accColorIdx%_ACC_COLORS.length];
  const selectedIcon=document.getElementById('nWalletIcon')?.value||'wallet';
  const icon=selectedIcon||({checking:'credit-card',savings:'piggy-bank',cash:'banknote',credit:'credit-card',invest:'trending-up'}[type]||'wallet');
  const acc={id:'lac'+Date.now(),name:n,type,color,icon,initialBalance:bal};
  document.getElementById('nWallet').value='';
  if(document.getElementById('nWalletBal')) document.getElementById('nWalletBal').value='';
  await DBS.saveAccount(acc);
  renderWalletSettings(); populateWalletSel(); renderAll();
  toast(`Conto "${n}" aggiunto ✓`,'success');
}
async function renameWallet(id,newName,oldName){
  if(!newName?.trim()) return;
  await DBS.renameAccount(id,newName.trim(),oldName);
  renderWalletSettings(); populateWalletSel(); renderAll();
}
async function removeWallet(id){
  if(CFG._accounts.length<=1){toast('Serve almeno un conto','warn');return;}
  const acc=CFG._accounts.find(a=>a.id===id);
  if(!confirm(`Elimina il conto "${acc?.name}"?`)) return;
  await DBS.deleteAccount(id);
  renderWalletSettings(); populateWalletSel(); renderAll();
  toast('Conto eliminato','warn');
}
function buildBudgetList(){
  const el=document.getElementById('budList');
  if(!el) return;
  el.innerHTML=Object.entries(CATS).map(([k,c])=>{
    const v=CFG.budgets[k]||'';
    return `<div class="flex items-center gap-2 py-1.5">
      <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${c.col}"></div>
      <span class="text-xs font-bold flex-1">${c.l}</span>
      <input type="number" min="0" step="1" value="${v}" placeholder="—" onchange="setBudget('${k}',this.value)" class="inp w-24 py-1.5 text-sm text-right">
    </div>`;
  }).join('');
}
function setBudget(cat,v){
  DBS.saveBudget(cat,v).then(()=>renderAll());
}
function renderAchievements(){
  const el=document.getElementById('achList');
  if(!el) return;
  el.innerHTML=ACHS.map(a=>{
    const unlocked=CFG.ach[a.id];
    return `<div class="flex flex-col items-center text-center gap-1 p-2 rounded-xl" style="background:${unlocked?'rgba(0,102,255,.08)':'var(--bg2)'}">
      <span class="text-2xl" style="filter:${unlocked?'none':'grayscale(1) opacity(.35)'}">${a.e}</span>
      <p class="text-[9px] font-bold leading-tight" style="color:${unlocked?'var(--t)':'var(--t3)'}">${a.t}</p>
    </div>`;
  }).join('');
}
function checkAch(){
  ACHS.forEach(a=>{
    if(!CFG.ach[a.id] && a.fn(S.txs,CFG)){
      CFG.ach[a.id]=Date.now();
      saveCfg();
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
  if(!S.txs.length){toast('Nessun dato','warn');return;}
  const esc=v=>`"${String(v??'').replace(/\"/g,'\"\"')}"`;
  let csv='Data,Ora,Tipo,Importo,Categoria,Conto,ContoDest,Nota,Tag\n';
  S.txs.forEach(t=>{
    csv+=`${t.date},${normTime(t.time)||''},${t.type},${t.amount},${CATS[t.category_id]?.l||'Altro'},${t.account||''},${t.account_to||''},${esc(t.description||'')},${esc(t.tags||'[]')}\n`;
  });
  download(new Blob([csv],{type:'text/csv;charset=utf-8;'}),`MoneyProX_${td()}.csv`);
  toast('CSV esportato ✓','success');
  unlockAch('export');
}
function exportJSON(){
  download(new Blob([JSON.stringify({txs:S.txs,cfg:CFG},null,2)],{type:'application/json'}),`MoneyProX_Backup_${td()}.json`);
  CFG.lastBackup=Date.now();
  saveCfg();
  toast('Backup esportato ✓','success');
  unlockAch('export');
}
function unlockAch(id){
  if(!CFG.ach[id]){CFG.ach[id]=Date.now();saveCfg();renderAchievements();}
}
/* ============================================================
   WIPE
============================================================ */
async function wipeAll(){
  if(prompt('Digita "RESET" per confermare')!=='RESET') return;
  // local
  S.txs=[]; S._localMeta={};
  saveTxs();
  CFG.budgets={}; CFG.templates=[]; CFG.notes=[]; CFG.ach={};
  CFG.debts=[]; CFG.subscriptions=[]; CFG.goals=[];
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
function toast(msg, type='info'){
  const col=type==='success'?'var(--ok)':type==='error'?'var(--bd)':type==='warn'?'var(--wn)':'var(--br)';
  const t=document.createElement('div');
  t.style.cssText=`position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--card);border:1.5px solid ${col};color:var(--t);padding:.6rem 1.1rem;border-radius:2rem;font-size:.82rem;font-weight:600;box-shadow:var(--shL);z-index:9999;white-space:nowrap;animation:slideUp .3s ease both`;
  t.innerHTML=msg;
  document.getElementById('toasts')?.appendChild(t);
  setTimeout(()=>t.remove(),3200);
}

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
    {l:'±',cl:'op',fn:()=>{const v=-parseFloat(S.calcDisp||0);updCalc(v);}},
    {l:'%',cl:'op',fn:()=>{const v=parseFloat(S.calcDisp||0)/100;updCalc(v);}},
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
  if(calcOp_.newNum){S.calcDisp='';calcOp_.newNum=false;}
  if(n==='.'&&S.calcDisp.includes('.')) return;
  S.calcDisp=(S.calcDisp==='0'&&n!=='.')?n:(S.calcDisp||'')+n;
  const el=document.getElementById('calcDisp');if(el) el.textContent=S.calcDisp;
}
function calcOp(op){
  calcOp_.val=parseFloat(S.calcDisp||0);calcOp_.op=op;calcOp_.newNum=true;
  const el=document.getElementById('calcDisp');if(el) el.textContent=S.calcDisp+(op==='*'?'×':op==='/'?'÷':op);
}
function calcEq(){
  if(!calcOp_.op) return;
  const b=parseFloat(S.calcDisp||0);
  let res=0;
  if(calcOp_.op==='+') res=calcOp_.val+b;
  if(calcOp_.op==='-') res=calcOp_.val-b;
  if(calcOp_.op==='*') res=calcOp_.val*b;
  if(calcOp_.op==='/')  res=b!==0?calcOp_.val/b:0;
  res=Math.round(res*100)/100;
  updCalc(res);calcOp_={val:0,op:null,newNum:true};
}
function updCalc(v){
  S.calcDisp=v.toString();
  S.calcVal=parseFloat(v)||0;
  const el=document.getElementById('calcDisp');if(el) el.textContent=S.calcDisp||'0';
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
  if(btn) btn.innerHTML=`<i data-lucide="${CFG.showBalance?'eye':'eye-off'}" class="w-3.5 h-3.5" style="color:var(--t2)"></i>`;
}
function toggleBalanceVisibility(){
  CFG.showBalance=!CFG.showBalance;
  saveCfg();
  updateDash();
  renderBalToggleBtn();
  lucide.createIcons();
}

// 2. SEARCH FILTER WALLET
function setTF(type){
  S.txFilter=type;
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
  S.advOpen=!S.advOpen;
  document.getElementById('advF')?.classList.toggle('hidden',!S.advOpen);
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
  S.wFilter='all'; S.txFilter='all';
  S.advOpen=false;
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
  const t=S.txs.find(x=>x.id===id);
  if(!t) return;
  const name=prompt('Nome template:',t.description||CATS[t.category_id]?.l||'Template');
  if(!name) return;
  if(!CFG.templates) CFG.templates=[];
  await DBS.addTemplate({name,type:t.type,amount:t.amount,category_id:t.category_id,account:t.account,account_to:t.account_to,tags:t.tags});
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
  if(!CFG.templates||!CFG.templates.length){el.innerHTML=emptyEl('Nessun template salvato');lucide.createIcons();return;}
  el.innerHTML=CFG.templates.map((tpl,i)=>{
    const c=CATS[tpl.category_id]||CATS.other;
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
  const tpl=CFG.templates[i];
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
  const tpl=CFG.templates[i]; if(!tpl) return;
  await DBS.deleteTemplate(tpl.id||i);
  renderTemplateList();
}

// 8. SPLIT BILL
function openSplit(){
  haptic();
  S.splitN=2;
  const sN=document.getElementById('splitN'); if(sN) sN.textContent=2;
  const sA=document.getElementById('splitAmt'); if(sA) sA.value='';
  const sR=document.getElementById('splitRes'); if(sR) sR.textContent=fmt(0);
  openModal('splitM');
}
function splitAdj(d){
  S.splitN=Math.max(2,Math.min(20,S.splitN+d));
  const _sN=document.getElementById('splitN'); if(_sN) _sN.textContent=S.splitN;
  calcSplit();haptic();
}
function calcSplit(){
  const _sA=document.getElementById('splitAmt');
  const amt=parseFloat(_sA?.value)||0;
  const res=Math.ceil((amt/S.splitN)*100)/100;
  const _sR=document.getElementById('splitRes'); if(_sR) _sR.textContent=fmt(res);
}
function splitToTx(){
  const amt=parseFloat(document.getElementById('splitAmt')?.value)||0;
  if(!amt){toast('Inserisci l\'importo','warn');return;}
  const myShare=Math.ceil((amt/S.splitN)*100)/100;
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
  const rates=CFG.fx||{EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
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
  const rates=CFG.fx||{EUR:1,USD:1.08,GBP:0.86,JPY:163,CHF:0.96,CAD:1.47};
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
  const rates=CFG.fx||{};
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
      const c=CATS[a.cat]||CATS.other;
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
    const due=(CFG.subscriptions||[]).filter(s=>s.active).map(s=>({s,days:_daysUntil(s.nextDate)})).filter(x=>x.days>=0&&x.days<=7);
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
    const pending=(CFG.debts||[]).filter(d=>!d.settled);
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
    if(typeof DBS!=='undefined' && DBS.computeBalance && CFG._accounts?.length){
      const lows=CFG._accounts.map(a=>({name:a.name,bal:DBS.computeBalance(a.name)})).filter(x=>x.bal<0).sort((a,b)=>a.bal-b.bal);
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
    const last=CFG.lastBackup||0;
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
    ? S.txs.filter(t=>{
        const desc=(t.description||'').toLowerCase();
        const cat=(CATS[t.category_id]?.l||'').toLowerCase();
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
      const c=isTransfer ? {l:'Trasferimento',ic:'arrow-right-left',col:'#FF9500',bg:'rgba(255,149,0,.12)'} : (CATS[t.category_id]||CATS.other);
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

  S._cmdFirst=first;
  el.innerHTML=html;
  lucide.createIcons();
}
function cmdKey(e){
  if(e.key==='Enter'){
    e.preventDefault();
    if(S._cmdFirst?.type==='action') cmdRunAction(S._cmdFirst.id);
    if(S._cmdFirst?.type==='tx') cmdOpenTx(S._cmdFirst.id);
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
  if(!CFG.notes) CFG.notes=[];
  await DBS.addNote(txt);
  inp.value='';
  renderNotesList();
  haptic();
}
function renderNotesList(){
  const el=document.getElementById('notesList');
  if(!el||!CFG.notes) return;
  if(!CFG.notes.length){el.innerHTML='<p class="text-sm text-center py-4" style="color:var(--t2)">Nessuna nota ancora</p>';return;}
  el.innerHTML=CFG.notes.map(n=>`
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
  const n=CFG.notes.find(x=>x.id===id); if(!n) return;
  await DBS.updateNote(id,{done:!n.done});
  renderNotesList();
}
async function deleteNote(id){
  await DBS.deleteNote(id);
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
  const txsWithTag=S.txs.filter(t=>{
    try{ return (typeof t.tags==='string'?JSON.parse(t.tags):[]).includes('ricorrente'); }catch(e){return false;}
  });
  const grouped={};
  txsWithTag.forEach(t=>{const k=t.description+'|'+t.amount+'|'+t.category_id; grouped[k]=(grouped[k]||[]);grouped[k].push(t);});
  if(!Object.keys(grouped).length){el.innerHTML=emptyEl('Nessuna spesa ricorrente — aggiungine una con il tag "Ricorrente"');lucide.createIcons();return;}
  el.innerHTML=`<div class="space-y-0.5 mt-2">`+Object.entries(grouped).map(([k,txs])=>{
    const t=txs[0];const c=CATS[t.category_id]||CATS.other;
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
  if(!CFG.debts) CFG.debts=[];
  const debt={person,amount:amt,type:debtType,note,date:fmtDate(new Date()),settled:false};
  await DBS.saveDebt(debt);
  document.getElementById('debtPerson').value='';
  document.getElementById('debtAmt').value='';
  document.getElementById('debtNote').value='';
  saveCfg(); renderDebtsList(); renderDebtsMini();
  toast(`${debtType==='borrow'?'Credito':'Debito'} con ${person} aggiunto ✓`,'success');
}
async function settleDebt(id){
  haptic();
  if(!CFG.debts) return;
  const d=CFG.debts.find(x=>idEq(x.id,id));
  if(!d) return;
  const next=!d.settled;
  await DBS.updateDebt(d.id,{settled:next});
  saveCfg(); renderDebtsList(); renderDebtsMini();
  toast(next?'Segnato come saldato ✓':'Riaperto','success');
}
async function deleteDebt(id){
  if(!CFG.debts) return;
  await DBS.deleteDebt(id);
  saveCfg(); renderDebtsList(); renderDebtsMini();
}
function renderDebtsList(){
  const el=document.getElementById('debtsList');
  if(!el) return;
  const debts=(CFG.debts||[]);
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
  const debts=(CFG.debts||[]).filter(d=>!d.settled);
  if(!debts.length){el.innerHTML='<p class="text-xs" style="color:var(--t2)">Nessun debito in sospeso</p>';return;}
  const totalBorrow=debts.filter(d=>d.type==='borrow').reduce((s,d)=>s+d.amount,0);
  const totalLend=debts.filter(d=>d.type==='lend').reduce((s,d)=>s+d.amount,0);
  el.innerHTML=`<div class="flex gap-3">
    ${totalBorrow>0?`<div class="flex-1 p-2 rounded-xl text-center" style="background:rgba(0,200,150,.1)"><p class="text-[9px] font-bold" style="color:var(--ok)">Mi devono</p><p class="font-black text-sm" style="color:var(--ok)">${fmt(totalBorrow)}</p></div>`:''}
    ${totalLend>0?`<div class="flex-1 p-2 rounded-xl text-center" style="background:rgba(255,59,92,.1)"><p class="text-[9px] font-bold" style="color:var(--bd)">Devo io</p><p class="font-black text-sm" style="color:var(--bd)">${fmt(totalLend)}</p></div>`:''}
  </div>`;
}
function openDebtsM(){
  haptic();
  if(!CFG.debts) CFG.debts=[];
  setDebtType('borrow');
  renderDebtsList();
  openModal('debtsM');
}

/* ============================================================
   ABBONAMENTI
============================================================ */
async function addSubscription(){
  const name=document.getElementById('subName')?.value.trim();
  const amt=parseFloat(document.getElementById('subAmt')?.value)||0;
  const freq=document.getElementById('subFreq')?.value||'monthly';
  const next=document.getElementById('subNextDate')?.value||fmtDate(new Date());
  if(!name){toast('Inserisci il nome','warn');return;}
  if(!amt||amt<=0){toast('Inserisci un importo valido','error');return;}
  if(!CFG.subscriptions) CFG.subscriptions=[];
  const sub={name,amount:amt,frequency:freq,nextDate:next,active:true};
  await DBS.saveSub(sub);
  document.getElementById('subName').value='';
  document.getElementById('subAmt').value='';
  saveCfg(); renderSubsList(); renderSubsMini();
  toast(`${name} aggiunto ✓`,'success');
}
async function toggleSub(id){
  const s=(CFG.subscriptions||[]).find(x=>idEq(x.id,id));
  if(!s) return;
  s.active=!s.active;
  await DBS.saveSub(s);
  saveCfg(); renderSubsList(); renderSubsMini();
}
async function deleteSub(id){
  await DBS.deleteSub(id);
  saveCfg(); renderSubsList(); renderSubsMini();
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
  const subs=(CFG.subscriptions||[]);
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
    return `<div class="flex items-center gap-3 p-3 rounded-2xl" style="background:var(--bg2);opacity:${s.active?1:.55}">
      <div class="w-10 h-10 rounded-2xl flex items-center justify-center text-white font-black text-sm flex-shrink-0" style="background:linear-gradient(135deg,var(--acc),var(--br))">${s.name.charAt(0).toUpperCase()}</div>
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
  const subs=(CFG.subscriptions||[]).filter(s=>s.active);
  if(!subs.length){el.innerHTML='<p class="text-xs" style="color:var(--t2)">Nessun abbonamento attivo</p>';return;}
  const monthly=subs.reduce((t,s)=>t+subMonthlyAmount(s),0);
  el.innerHTML=`<div class="flex justify-between items-center">
    <p class="text-xs" style="color:var(--t2)">${subs.length} abbonamento${subs.length>1?'i':''} attivi</p>
    <p class="font-black text-sm" style="color:var(--acc)">${fmt(monthly)}/mese</p>
  </div>`;
}
function openSubsM(){
  haptic();
  if(!CFG.subscriptions) CFG.subscriptions=[];
  const now=new Date(); now.setDate(now.getDate()+30);
  document.getElementById('subNextDate').valueAsDate=now;
  renderSubsList();
  openModal('subsM');
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
  if(!CFG.goals) CFG.goals=[];
  await DBS.saveGoal({name,target,current:Math.min(current,target),deadline,completed:false});
  document.getElementById('goalNameI').value='';
  document.getElementById('goalTargetI').value='';
  document.getElementById('goalCurrentI').value='';
  saveCfg(); renderGoalsList();
  toast(`Obiettivo "${name}" aggiunto ✓`,'success');
}
async function deleteGoal(id){
  await DBS.deleteGoal(id);
  saveCfg(); renderGoalsList();
}
async function depositGoal(id){
  const g=(CFG.goals||[]).find(x=>idEq(x.id,id));
  if(!g) return;
  const v=parseFloat(prompt(`Aggiungi risparmio a "${g.name}":`)||0);
  if(!v||v<=0) return;
  const nextCurrent=Math.min(g.target,g.current+v);
  const completed=nextCurrent>=g.target;
  await DBS.updateGoal(g.id,{current:nextCurrent,completed});
  if(completed){ launchConfetti(); toast(`🎉 Obiettivo "${g.name}" raggiunto!`,'success'); }
  saveCfg(); renderGoalsList();
}
function renderGoalsList(){
  const el=document.getElementById('goalsList');
  if(!el) return;
  const goals=(CFG.goals||[]);
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
  const netWorthByMonth=months.map(d=>{
    const upTo=new Date(d.getFullYear(),d.getMonth()+1,0);
    let nw=0;
    S.txs.forEach(t=>{
      if(new Date(t.date+'T12:00')<=upTo && t.type!=='transfer'){
        nw+=t.type==='income'?+t.amount:-+t.amount;
      }
    });
    return nw;
  });
  if(S.charts.networth) S.charts.networth.destroy();
  const ctx=canvas.getContext('2d');
  const pos=netWorthByMonth[netWorthByMonth.length-1]>=0;
  S.charts.networth=new Chart(ctx,{
    type:'line',
    data:{labels,datasets:[{
      label:'Patrimonio Netto',
      data:netWorthByMonth,
      borderColor:pos?'var(--ok)':'var(--bd)',
      backgroundColor:pos?'rgba(0,200,150,.1)':'rgba(255,59,92,.1)',
      fill:true,tension:.4,pointRadius:3,
      pointBackgroundColor:pos?'var(--ok)':'var(--bd)',
    }]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>fmtShort(v)}}}}
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
  if(!CFG.recurringTxs||!CFG.recurringTxs.length) return;
  const today=fmtDate(new Date());
  let added=false;
  for(const r of CFG.recurringTxs){
    const alreadyToday=S.txs.some(t=>t.date===today&&t.description===r.description&&+t.amount===+r.amount);
    if(!alreadyToday&&r.nextDate<=today){
      const payload={...r,id:'local_rec_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),date:today};
      if(!payload.time) payload.time=nowTimeHM();
      delete payload.nextDate;
      S.txs.push(payload);
      r.nextDate=fmtDate(new Date(today)); // update
      added=true;

      // Persist immediately when online
      if(!OFFLINE&&db){
        try{
          if(payload.type==='transfer'){
            const ref=genUUID();
            const desc=payload.description||`Giro ${payload.account}→${payload.account_to}`;
            const rowOut=toDbPayload(payload,'expense',`[GIRO:${ref}] ${desc}`);
            const rowIn ={...toDbPayload(payload,'income',`[GIRO:${ref}] ${desc}`),account:payload.account_to};
            const [r1,r2]=await Promise.all([dbInsertTxRow(rowOut), dbInsertTxRow(rowIn)]);
            if(r1.error) throw r1.error;
            if(r2.error) throw r2.error;
            payload.id=r1.data?.[0]?.id||payload.id;
            payload._partner_id=r2.data?.[0]?.id||null;
            payload._transfer_ref=ref;
            DBS.updateAccountBalance(payload.account);
            if(payload.account_to) DBS.updateAccountBalance(payload.account_to);
          } else {
            const res=await dbInsertTxRow(toDbPayload(payload));
            if(res.error) throw res.error;
            const newId=res.data?.[0]?.id;
            if(newId){
              payload.id=newId;
              const tags=payload.tags||'[]';
              const account_to=payload.account_to||null;
              if(account_to||tags!=='[]') await DBS.saveTxMeta(newId,{account_to,tags});
              DBS.updateAccountBalance(payload.account);
            }
          }
        }catch(e){ console.warn('recurring.inject DB',e); }
      }
    }
  }
  if(added){ saveTxs(); saveCfg(); renderAll(); }
}

// 12. SPENDING STREAKS
function getStreakDays(){
  const dates=new Set(S.txs.map(t=>t.date));
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
  const cur=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const prev=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');const pm=new Date(now.getFullYear(),now.getMonth()-1,1);return d.getMonth()===pm.getMonth()&&d.getFullYear()===pm.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  if(!prev) return {diff:0,pct:0};
  return {diff:cur-prev,pct:Math.round((cur-prev)/prev*100)};
}

// 14. LARGEST EXPENSES THIS MONTH
function getTopExpenses(n=5){
  const now=new Date();
  return S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).sort((a,b)=>+b.amount- +a.amount).slice(0,n);
}

// 15. NET WORTH HISTORY
function getNetWorthHistory(){
  const months=[];
  const now=new Date();
  // sum of all account initial balances
  const initSum=(CFG._accounts||[]).reduce((s,a)=>s+(a.initialBalance||0),0);
  for(let i=11;i>=0;i--){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const endOfMonth=new Date(d.getFullYear(),d.getMonth()+1,0);
    const upToDate=S.txs.filter(t=>new Date(t.date+'T12:00')<=endOfMonth);
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
  CFG.pin=p; CFG.pinEnabled=true; saveCfg();
  toast('PIN impostato ✓','success');
}
function disablePin(){ CFG.pin=''; CFG.pinEnabled=false; saveCfg(); toast('PIN rimosso','warn'); }
function pinKey(k){
  if(k==='C'){S.pinBuffer='';updatePinDots();return;}
  if(k==='⌫'){S.pinBuffer=S.pinBuffer.slice(0,-1);updatePinDots();return;}
  if(S.pinBuffer.length>=4) return;
  S.pinBuffer+=k;
  updatePinDots();
  if(S.pinBuffer.length===4){
    if(S.pinBuffer===CFG.pin) unlockApp();
    else{ toast('PIN errato','error'); setTimeout(()=>{S.pinBuffer='';updatePinDots();},600); }
  }
}
function updatePinDots(){
  ['pinD1','pinD2','pinD3','pinD4'].forEach((id,i)=>{
    const d=document.getElementById(id);
    if(d) d.style.background=i<S.pinBuffer.length?'var(--br)':'var(--bg2)';
  });
}
function togglePinSetting(v){
  if(v){ enablePin(); }
  else { disablePin(); }
  // sync toggle state
  const tog=document.getElementById('pinToggle');
  if(tog) tog.checked=CFG.pinEnabled;
}
function unlockApp(){ document.getElementById('pinScreen').classList.add('hidden'); S.pinBuffer=''; }

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
  S.txs=S.txs.filter(t=>!((t.description||'').toLowerCase().includes(q)||(CATS[t.category_id]?.l||'').toLowerCase().includes(q)));
  saveTxs(); renderAll(); toast('Movimenti eliminati','warn');
}

// 19. MONTH SELECTOR
function jumpToMonth(offset){
  S.viewDate=new Date(S.viewDate.getFullYear(),S.viewDate.getMonth()+offset,1);
  updateDash();
  setEl('navMonth',S.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'}));
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
  const defAcc=document.getElementById('mapAccDef')?.value||CFG.wallets[0];
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
    const isDup=S.txs.some(x=>x.date===date&&Math.abs(+x.amount-finalAmt)<.01&&x.type===type);
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
      const isDup=S.txs.some(x=>x.date===t.date&&Math.abs(+x.amount- +t.amount)<.01&&x.type===t.type);
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
      <td>${CATS[r.category_id]?.l||r.category_id}</td>
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
  clean.forEach(r=>S.txs.push(r));
  saveTxs();
  if(IMP._restoreCfg){ CFG=Object.assign(CFG,IMP._restoreCfg); saveCfg(); }
  toast(`✅ Importati ${clean.length} movimenti!`,'success');
  unlockAch('importer');
  closeAll(); resetImport(); renderAll(); checkAch();
  // If online, immediately migrate imported data (and any other local-only data) to Supabase
  if(!OFFLINE&&db){
    setTimeout(()=>{ try{ DBS.migrateAll(); }catch(e){} },300);
  }
}

// 21. CATEGORY RENAME (CFG extension — UI placeholder)
function renameCat(key, newLabel){
  if(CATS[key]) CATS[key].l=newLabel;
  renderAll();
}

// 22. PERCENTAGE OF INCOME SPENT
function getPctIncomeSpent(){
  const now=new Date();
  const mTxs=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const inc=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const exp=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  return inc>0 ? Math.round(exp/inc*100) : 0;
}

// 23. DAYS UNTIL NEXT SALARY (based on patterns)
function getDaysUntilSalary(){
  const salaryTxs=S.txs.filter(t=>t.type==='income'&&(t.category_id==='salary'||((t.description||'').toLowerCase().includes('stipendio')))).sort((a,b)=>new Date(b.date)-new Date(a.date));
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
  const exp=S.txs.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  return Math.round(exp/30*100)/100;
}

// 25. TAG STATS
function getTagStats(){
  const stats={};
  S.txs.forEach(t=>{
    try{(typeof t.tags==='string'?JSON.parse(t.tags):t.tags||[]).forEach(tag=>{stats[tag]=(stats[tag]||0)+ +t.amount;});}catch(e){}
  });
  return stats;
}

// 26. COPY TX AMOUNT TO CLIPBOARD
function copyAmount(id){
  const t=S.txs.find(x=>x.id===id);
  if(!t) return;
  navigator.clipboard?.writeText(t.amount.toString()).then(()=>toast('Importo copiato ✓','success')).catch(()=>toast('Copia non supportata','warn'));
}

// 27. SHARE SUMMARY
function shareSummary(){
  const now=new Date();
  const mTxs=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const tIn=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const tOut=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const msg=`📊 Riepilogo ${now.toLocaleDateString('it-IT',{month:'long',year:'numeric'})}\n💚 Entrate: ${fmt(tIn)}\n❤️ Uscite: ${fmt(tOut)}\n💰 Netto: ${fmt(tIn-tOut)}\n\nGenerato con Money Pro X`;
  if(navigator.share){ navigator.share({title:'Riepilogo Finanziario',text:msg}).catch(()=>{}); }
  else{ navigator.clipboard?.writeText(msg); toast('Riepilogo copiato negli appunti ✓','success'); }
}

// 28. SEARCH SUGGESTIONS
function showSuggestions(){
  const q=(document.getElementById('sQ')?.value||'').toLowerCase();
  if(q.length<2) return;
  const seen=new Set();
  S.txs.forEach(t=>{ if((t.description||'').toLowerCase().includes(q)&&t.description) seen.add(t.description); });
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
  const t=S.txs.find(x=>x.id===id);
  if(!t) return;
  t._reviewed=true;
  saveTxs();
  toast('Marcato come revisionato ✓','success');
}

// 32. RENAME WALLET (quick)
async function quickRenameWallet(i){
  const acc=CFG._accounts?.[i]; if(!acc) return;
  const name=prompt('Nuovo nome conto:', acc.name);
  if(name&&name.trim()) await renameWallet(acc.id,name.trim(),acc.name);
}

// 33. CATEGORY TOTAL (any period)
function getCatTotal(catKey, months=1){
  const cutoff=new Date(); cutoff.setMonth(cutoff.getMonth()-months);
  return S.txs.filter(t=>t.category_id===catKey&&t.type==='expense'&&new Date(t.date+'T12:00')>=cutoff).reduce((s,t)=>s+ +t.amount,0);
}

// 34. EXPORT REPORT (month)
function exportCurrentMonthPDF(){
  const month=S.viewDate.toLocaleDateString('it-IT',{month:'long',year:'numeric'});
  const mTxs=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===S.viewDate.getMonth()&&d.getFullYear()===S.viewDate.getFullYear();}).sort((a,b)=>new Date(b.date)-new Date(a.date));
  let txt=`MONEY PRO X — Report ${month}\n${'─'.repeat(48)}\n\n`;
  mTxs.forEach(t=>{const c=CATS[t.category_id]||CATS.other;txt+=`${t.date}  ${t.type==='expense'?'-':'+'}${String(fmt(t.amount)).padEnd(12)}  ${c.l.padEnd(18)}  ${t.description||''}\n`;});
  const tIn=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const tOut=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  txt+=`\n${'─'.repeat(48)}\nEntrate:  ${fmt(tIn)}\nUscite:   ${fmt(tOut)}\nNetto:    ${fmt(tIn-tOut)}\nRisparmio: ${tIn>0?Math.round((1-tOut/tIn)*100):0}%\n`;
  download(new Blob([txt],{type:'text/plain;charset=utf-8;'}),`Report_${month.replace(/\s/g,'_')}.txt`);
  toast('Report esportato ✓','success');
}

// 35. AUTO-BACKUP REMINDER
function checkAutoBackup(){
  const last=CFG.lastBackup||0;
  const days=Math.floor((Date.now()-last)/(1000*60*60*24));
  if(days>7) toast(`⚠️ Ultimo backup ${days} giorni fa — esporta un backup!`,'warn');
}

// 36. BALANCE PROJECTION (next 30 days)
function getProjectedBalance(){
  const avg30=getAvgDaily30();
  const now=new Date();
  const mTxs=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const tIn=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const tOut=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const currentNet=tIn-tOut;
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
  if(CFG.theme==='system'){
    document.body.classList.toggle('dark',shouldBeDark);
  }
}

// 40. DUPLICATE DETECTION REPORT
function getDuplicateCandidates(){
  const seen={};const dups=[];
  S.txs.forEach(t=>{
    const k=`${t.date}_${t.amount}_${t.type}`;
    if(seen[k]) dups.push({existing:seen[k],candidate:t});
    else seen[k]=t;
  });
  return dups;
}

// 41. TRANSACTION COUNT BY CATEGORY
function getCatCounts(){
  const counts={};
  S.txs.filter(t=>t.type!=='transfer').forEach(t=>{counts[t.category_id]=(counts[t.category_id]||0)+1;});
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
}

// 42. FIRST/LAST TX DATE
function getDateRange(){
  if(!S.txs.length) return null;
  const dates=S.txs.map(t=>t.date).sort();
  return {first:dates[0], last:dates[dates.length-1]};
}

// 43. CATEGORY BUDGET ALERT
function checkBudgetAlerts(){
  const now=new Date();
  const alerts=[];
  Object.entries(CFG.budgets||{}).forEach(([cat,lim])=>{
    const spent=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return t.category_id===cat&&t.type==='expense'&&d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,t)=>s+ +t.amount,0);
    const pct=spent/lim;
    if(pct>=1) alerts.push({cat,spent,lim,pct,level:'over'});
    else if(pct>=.8) alerts.push({cat,spent,lim,pct,level:'warn'});
  });
  return alerts;
}

// 44. INCOME REGULARITY SCORE
function getIncomeRegularity(){
  const months12=Array.from({length:12},(_,i)=>{
    const d=new Date(); d.setMonth(d.getMonth()-11+i);
    return S.txs.filter(t=>{const dd=new Date(t.date+'T12:00');return dd.getMonth()===d.getMonth()&&dd.getFullYear()===d.getFullYear()&&t.type==='income';}).reduce((s,t)=>s+ +t.amount,0);
  });
  const withIncome=months12.filter(v=>v>0).length;
  return Math.round(withIncome/12*100);
}

// 45. ESTIMATED ANNUAL SAVINGS
function getEstimatedAnnualSavings(){
  const sr=srFor(S.txs,new Date());
  const now=new Date();
  const tIn=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='income';}).reduce((s,t)=>s+ +t.amount,0);
  return tIn*(sr/100)*12;
}

// 46. SPENDING VELOCITY (is this month faster than last?)
function getSpendingVelocity(){
  const now=new Date();
  const dom=now.getDate();
  const curSpend=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}).reduce((s,t)=>s+ +t.amount,0);
  const prevMonth=new Date(now.getFullYear(),now.getMonth()-1,1);
  const prevDim=new Date(now.getFullYear(),now.getMonth(),0).getDate();
  const prevSpend=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===prevMonth.getMonth()&&d.getFullYear()===prevMonth.getFullYear()&&t.type==='expense'&&d.getDate()<=dom;}).reduce((s,t)=>s+ +t.amount,0);
  if(!prevSpend) return 0;
  return Math.round((curSpend-prevSpend)/prevSpend*100);
}

// 47. CATEGORY BUDGET CREATION SHORTCUT
function quickBudget(cat, amt){
  CFG.budgets[cat]=amt;
  saveCfg();
  renderBudgetMini(S.txs.filter(t=>{const d=new Date(t.date+'T12:00');const now=new Date();return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type==='expense';}));
  toast(`Budget ${CATS[cat]?.l} impostato a ${fmt(amt)} ✓`,'success');
}

// 48. UPCOMING BILL DETECTOR
function getUpcomingBills(){
  const recurring=S.txs.filter(t=>{try{return (typeof t.tags==='string'?JSON.parse(t.tags):[]).includes('ricorrente')&&t.type==='expense';}catch(e){return false;}});
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
  CFG.wallets.forEach(w=>{
    let bal=0;
    S.txs.forEach(t=>{
      const a=+t.amount, acc=t.account||CFG.wallets[0];
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
  const mTxs=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()&&t.type!=='transfer';});
  const tIn=mTxs.filter(t=>t.type==='income').reduce((s,t)=>s+ +t.amount,0);
  const tOut=mTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+ +t.amount,0);
  const sr=srFor(S.txs,now);
  renderInsights(mTxs,tIn,tOut,sr);
  openModal('insM');
}

/* ============================================================
   FILTER TX TYPE (tab toggle)
============================================================ */
function setTxFilter(type, el){
  S.txFilter=type;
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
  const recent=S.txs.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type!=='transfer');

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
  const accounts=CFG._accounts?.length?CFG._accounts:(CFG.wallets||[]).map(w=>({name:w,initialBalance:0}));
  let currentBalance=accounts.reduce((s,a)=>s+(a.initialBalance||0),0);
  S.txs.filter(t=>t.type!=='transfer').forEach(t=>{ currentBalance+=t.type==='income'?+t.amount:-+t.amount; });

  // Proietta 30 giorni basandosi sulla media mensile per tipo
  const last30=S.txs.filter(t=>{const d=new Date(t.date+'T12:00');return d>=cutoff&&d<=today&&t.type!=='transfer';});
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

  S._receiptItems=found;
  const el=document.getElementById('receiptResults');
  if(!found.length){el.innerHTML='<p class="text-sm py-3 text-center" style="color:var(--t2)">Nessun importo trovato — prova a riformattare il testo</p>';return;}
  el.innerHTML=`<p class="text-[10px] font-bold uppercase mb-2" style="color:var(--t2)">${found.length} voci rilevate — deseleziona quelle da escludere</p>`+
  found.map((item,i)=>`
    <div class="flex items-center gap-2 py-2 border-b last:border-0" style="border-color:var(--bo)">
      <input type="checkbox" checked onchange="S._receiptItems[${i}].selected=this.checked" class="w-4 h-4 flex-shrink-0" style="accent-color:var(--br)">
      <div class="flex-1 min-w-0">
        <p class="text-xs font-bold truncate">${item.desc}</p>
        <p class="text-[9px]" style="color:var(--t2)">${item.date} · ${CATS[item.cat]?.l||'Altro'}</p>
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
  const items=(S._receiptItems||[]).filter(x=>x.selected);
  if(!items.length){toast('Seleziona almeno una voce','warn');return;}
  const account=CFG._accounts?.[0]?.name||'Principale';
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
        S.txs.push(payload);
      }catch(e){ saveTxLocal(payload); }
    }
  }
  try{ DBS.updateAccountBalance(account); }catch(e){}
  saveTxs(); closeAll(); renderAll(); checkAch();
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
  S.txs.filter(t=>t.type==='expense').forEach(t=>{
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
  if(!CFG._challenges) CFG._challenges={week52:0,roundup:0,noSpendStreak:0,noSpendGoal:7,lastNoSpendCheck:null};
  const ch=CFG._challenges;

  // Calcola no-spend streak (giorni senza spese)
  const today=fmtDate(new Date());
  let streak=0; let d=new Date();
  for(let i=0;i<60;i++){
    const k=fmtDate(d);
    const hasSpend=S.txs.some(t=>t.date===k&&t.type==='expense');
    if(!hasSpend) streak++; else break;
    d.setDate(d.getDate()-1);
  }

  // Calcola arrotondamento (risparmia il resto di ogni spesa al €1 prossimo)
  const roundupTotal=S.txs.filter(t=>t.type==='expense').reduce((s,t)=>{
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
  if(!CFG._challenges) CFG._challenges={week52:0};
  const week=Math.ceil(((new Date()-new Date(new Date().getFullYear(),0,1))/86400000)/7);
  CFG._challenges.week52=Math.min(1378,(CFG._challenges.week52||0)+week);
  saveCfg();
  openSavingsChallenge();
  toast(`Settimana ${week} aggiunta! (${fmt(week)} risparmiati)`,'success');
}

function changeNoSpendGoal(delta){
  if(!CFG._challenges) CFG._challenges={};
  CFG._challenges.noSpendGoal=Math.max(1,Math.min(30,(CFG._challenges.noSpendGoal||7)+delta));
  saveCfg(); openSavingsChallenge();
}

/* ── 5. SUBSCRIPTIONS OVERLAP DETECTOR ──────────────────────
   Analizza le transazioni per rilevare automaticamente abbonamenti
   dimenticati, comparali con quelli in lista, e segnala sovrapposizioni.
────────────────────────────────────────────────────────── */
function detectHiddenSubscriptions(){
  haptic();
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-90);
  const recent=S.txs.filter(t=>new Date(t.date+'T12:00')>=cutoff&&t.type==='expense');

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

  // Controlla quali non sono già in CFG.subscriptions
  const knownNames=(CFG.subscriptions||[]).map(s=>s.name.toLowerCase());
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
          <i data-lucide="${CATS[g.cat]?.ic||'refresh-cw'}" class="w-4 h-4" style="color:var(--bd)"></i>
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

  S._detectedSubs=unknown;
  openModal('subDetectModal');
  lucide.createIcons();
}

async function addDetectedSubs(){
  const subs=S._detectedSubs||[];
  const today=fmtDate(new Date());
  for(const g of subs){
    const sub={name:g.desc.slice(0,40),amount:g.amount,frequency:'monthly',nextDate:today,active:true};
    if(!CFG.subscriptions) CFG.subscriptions=[];
    // Use DBS if available, else local
    if(typeof DBS!=='undefined'&&DBS.saveSub){
      await DBS.saveSub(sub);
    } else {
      sub.id='ls'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      CFG.subscriptions.push(sub);
      localStorage.setItem('mpx_subscriptions',JSON.stringify(CFG.subscriptions));
    }
  }
  saveCfg(); closeAll();
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
