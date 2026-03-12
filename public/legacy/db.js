/* ============================================================
   CONFIG — Supabase Credentials
   ============================================================ */
const SB_URL = (window.ENV && window.ENV.SB_URL) || localStorage.getItem('mpxSbUrl') || 'INSERISCI_QUI_URL';
const SB_KEY = (window.ENV && window.ENV.SB_KEY) || localStorage.getItem('mpxSbKey') || 'INSERISCI_QUI_CHIAVE';
const OFFLINE = SB_URL === 'INSERISCI_QUI_URL' || !SB_URL;
let db = null;
if(!OFFLINE){
  try{ db = window.supabase.createClient(SB_URL, SB_KEY); }
  catch(e){ console.error('Supabase init error:', e); }
}

/* ============================================================
   GLOBAL STATE & CONSTANTS (Shared across modules)
   ============================================================ */
let AppState = {
  transactions:[], charts:{}, fType:'expense',
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
  _localMeta:{}, 
  _lockedModalId:null,
  // Investimenti: cache quote in tempo reale per simbolo
  investQuotes:{}, // es. { 'AAPL': { price: 182.3, at: 1710000000000 } }
  investSearch:{ query:'', results:[] }, // ultimo autocomplete simboli
  investProfiles:{}, // cache profili titoli { [symbol]: { name,currency,logoUrl } }
};
let UserConfig = {
  // Derived from `_accounts` (kept for backward compatibility with older code paths).
  wallets:[],
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
  theme:'system', currency:'€',
  // Investimenti: portafoglio e preferenze
  investments:[],          // [{ id, symbol, name, quantity, currency, buyPrice, account, note, includeInTotal }]
  investIncludeInTotal:true, // se true il valore corrente si somma al Patrimonio Netto
  investApi:{              // provider esterno per le quote (per-user)
    provider:'finnhub',
    apiKey:'',
  },
};
const Categories = {
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
// Alias used by legacy UI helpers.
const CATS = Categories;

/* ============================================================
   UTILITIES
   ============================================================ */
function genUUID(){
  try{ return crypto.randomUUID(); }catch(e){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);});
  }
}
function normId(v){ return v==null?'':String(v); }
function idEq(a,b){ return normId(a)===normId(b); }
function isUUID(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normId(v)); }
function isLocalId(v,prefix){ const s=normId(v); return !s || !isUUID(s) || (prefix && s.startsWith(prefix)); }
function fmtDate(d){ if(!d) return ''; const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }

/* ============================================================
   PERSISTENCE HELPERS (LocalStorage & DB Sync)
   ============================================================ */
function saveTransactions(){
  localStorage.setItem('mpxData2', JSON.stringify(AppState.transactions));
  localStorage.setItem('mpxMeta2', JSON.stringify(AppState._localMeta||{}));
}
function saveConfig(){
  localStorage.setItem('mpxCfg2', JSON.stringify(UserConfig));
  if(!OFFLINE && db) DatabaseService.pushSettings().catch(()=>{});
}
function loadTransactions(){ try{ return JSON.parse(localStorage.getItem('mpxData2')||'[]'); }catch(e){ return []; } }
function loadMetadata(){ try{ return JSON.parse(localStorage.getItem('mpxMeta2')||'{}'); }catch(e){ return {}; } }
function loadConfig(){ try{ return JSON.parse(localStorage.getItem('mpxCfg2')||'{}'); }catch(e){ return {}; } }

function normTime(v){
  const s=String(v==null?'':v).trim();
  if(!s) return '';
  const m=s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if(m){
    const hh=parseInt(m[1],10); const mm=parseInt(m[2],10);
    if(Number.isFinite(hh)&&Number.isFinite(mm)&&hh>=0&&hh<=23&&mm>=0&&mm<=59) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  }
  const m2=s.match(/^(\d{3,4})$/);
  if(m2){
    const raw=m2[1].padStart(4,'0');
    const hh=parseInt(raw.slice(0,2),10); const mm=parseInt(raw.slice(2,4),10);
    if(Number.isFinite(hh)&&Number.isFinite(mm)&&hh>=0&&hh<=23&&mm>=0&&mm<=59) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  }
  return '';
}
function nowTimeHM(){
  const d=new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function txSortMs(t){
  const date=String(t?.date||'').slice(0,10); if(!date) return 0;
  const time=normTime(t?.time)||'12:00';
  const ms=new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(ms)?ms:0;
}
function cmpTxDTDesc(a,b){ return txSortMs(b)-txSortMs(a) || normId(b.id).localeCompare(normId(a.id)); }
function cmpTxDTAsc(a,b){ return txSortMs(a)-txSortMs(b) || normId(a.id).localeCompare(normId(b.id)); }

/* ============================================================
   DB HELPERS & ADAPTERS
   ============================================================ */
function _isMissingCol(err,col){
  const msg=((err?.message||'')+' '+(err?.details||'')+' '+(err?.hint||'')).toLowerCase();
  const c=String(col||'').toLowerCase();
  return err?.code==='42703' || msg.includes(`column \"${c}`) || msg.includes(`column ${c}`) || msg.includes(`${c}\" does not exist`);
}

async function dbInsertTxRow(row){
  let res=await db.from('transactions').insert([row]).select();
  if(res?.error && _isMissingCol(res.error,'time')){
    const r={...row}; delete r.time;
    res=await db.from('transactions').insert([r]).select();
  }
  return res;
}
async function dbUpdateTxRow(id, patch){
  let res=await db.from('transactions').update(patch).eq('id',id).select();
  if(res?.error && _isMissingCol(res.error,'time')){
    const p={...patch}; delete p.time;
    res=await db.from('transactions').update(p).eq('id',id).select();
  }
  return res;
}

function toDbPayload(t, overrideType, overrideDesc){
  const accFallback=(()=>{
    const names=(UserConfig?._accounts||[]).map(a=>a?.name).filter(Boolean);
    if(UserConfig?.defaultWallet && names.includes(UserConfig.defaultWallet)) return UserConfig.defaultWallet;
    return names[0]||null;
  })();
  const type=(overrideType || t.type || 'expense');
  return {
    type,
    amount:      parseFloat(t.amount)||0,
    date:        t.date,
    time:        normTime(t.time)||null,
    category_id: t.category_id||'other',
    description: overrideDesc!=null ? overrideDesc : (t.description||''),
    account:     (t.account ? String(t.account) : accFallback),
    recurring:   false,
  };
}

function processDbRows(rows){
  const meta=(AppState._localMeta||{});
  const accs=(UserConfig?._accounts||[]).map(a=>String(a?.name||'').trim()).filter(Boolean);
  const accEq=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();
  const resolveAcc=(name)=>{
    const n=String(name||'').trim();
    if(!n) return '';
    const exact=accs.find(x=>x===n); if(exact) return exact;
    const ci=accs.find(x=>x.toLowerCase()===n.toLowerCase());
    return ci || n;
  };
  const inferArrow=(desc)=>{
    const s=String(desc||'').trim();
    if(!s) return null;
    const m=s.match(/(.+?)(?:\s*)(?:→|->)(?:\s*)(.+)$/);
    if(!m) return null;
    const a=String(m[1]||'').replace(/^giro\s*/i,'').trim();
    const b=String(m[2]||'').trim();
    if(!a||!b) return null;
    return {from:resolveAcc(a), to:resolveAcc(b)};
  };
  const attachMeta=(r)=>{
    const m=meta?.[r.id]||{};
    return {
      ...r,
      time:r.time||null,
      tags:m.tags||'[]',
      account_to:m.account_to||null,
    };
  };

  // Legacy GIRO pairs stored as 2 rows with "[GIRO:<ref>]" prefix.
  const pending={}; // ref -> { out?, inn?, idx }
  const out=[];
  for(const row of (rows||[])){
    const rawDesc=row?.description||'';
    const mm=rawDesc.match(/^\[GIRO:([^\]]+)\]\s*(.*)$/);
    const isLegacyGiro=!!(mm && (row.type==='expense' || row.type==='income'));
    if(isLegacyGiro){
      const ref=mm[1];
      const cleanDesc=(mm[2]||'').trim();
      if(!pending[ref]){
        pending[ref]={out:null,inn:null,idx:out.length};
        out.push({__giro_placeholder:true,ref});
      }
      if(row.type==='expense') pending[ref].out={...row,description:cleanDesc};
      else                    pending[ref].inn={...row,description:cleanDesc};

      const p=pending[ref];
      if(p?.out && p?.inn){
        out[p.idx]={
          id:p.out.id,
          _partner_id:p.inn.id,
          type:'transfer',
          amount:p.out.amount,
          date:p.out.date,
          time:p.out.time||null,
          category_id:p.out.category_id||'other',
          description:p.out.description||`Giro ${p.out.account}→${p.inn.account}`,
          account:p.out.account,
          account_to:p.inn.account,
          tags:'[]',
          _transfer_ref:ref,
        };
        delete pending[ref];
      }
      continue;
    }

    out.push(attachMeta(row));
  }

  // Flush legacy orphans: try to infer the missing side from the description.
  for(const [ref,p] of Object.entries(pending)){
    const r=p?.out || p?.inn;
    if(!r){ out[p.idx]=null; continue; }
    const inferred=inferArrow(r.description);
    if(inferred && inferred.from && inferred.to && !accEq(inferred.from,inferred.to)){
      if(r.type==='expense'){
        const from=resolveAcc(r.account);
        if(!(accEq(from,inferred.from) || accEq(from,inferred.to))){ out[p.idx]=attachMeta(r); continue; }
        const to=accEq(from,inferred.from)?inferred.to:inferred.from;
        if(to && !accEq(from,to)){
          out[p.idx]={
            id:r.id,
            type:'transfer',
            amount:r.amount,
            date:r.date,
            time:r.time||null,
            category_id:r.category_id||'other',
            description:r.description||`Giro ${from}→${to}`,
            account:from,
            account_to:to,
            tags:'[]',
            _transfer_ref:ref,
            _orphan:true,
          };
          continue;
        }
      } else if(r.type==='income'){
        const to=resolveAcc(r.account);
        if(!(accEq(to,inferred.from) || accEq(to,inferred.to))){ out[p.idx]=attachMeta(r); continue; }
        const from=accEq(to,inferred.to)?inferred.from:inferred.to;
        if(from && !accEq(from,to)){
          out[p.idx]={
            id:r.id,
            type:'transfer',
            amount:r.amount,
            date:r.date,
            time:r.time||null,
            category_id:r.category_id||'other',
            description:r.description||`Giro ${from}→${to}`,
            account:from,
            account_to:to,
            tags:'[]',
            _transfer_ref:ref,
            _orphan:true,
          };
          continue;
        }
      }
    }
    // Fallback: keep it as a normal transaction with metadata.
    out[p.idx]=attachMeta(r);
  }

  return out.filter(Boolean);
}

/* ============================================================
   DBS — Data Synchronization & Business Logic
   ============================================================ */
const DatabaseService = {
  _acColors:['#0066FF','#00C896','#7C3AED','#FF9500','#FF3B5C','#5AC8FA','#FF6B00','#4CAF50'],
  _acColorIdx:0,
  nextColor(){ return this._acColors[this._acColorIdx++ % this._acColors.length]; },
  _iconForType(t){ return {checking:'credit-card',savings:'piggy-bank',cash:'banknote',credit:'credit-card',invest:'trending-up'}[t]||'wallet'; },
  _saveLocal(){
    try{
      UserConfig.wallets=(UserConfig._accounts||[]).map(a=>a.name);
      localStorage.setItem('mpx_acc', JSON.stringify(UserConfig._accounts||[]));
    }catch(e){}
  },

  /* ── SETTINGS ────────────────────────────────────────── */
  async pushSettings(){
    if(!db) return;
    const keys=['currency','theme','color','goalName','goalVal','ach','pinEnabled','pin','showBalance','defaultWallet','recurringTxs','fx','lastBackup','fxUpdated','layout'];
    const rows=keys.map(k=>({key:k,value:JSON.stringify(UserConfig[k]??null),updated_at:new Date().toISOString()}));
    try{ await db.from('settings').upsert(rows,{onConflict:'key'}); }catch(e){ console.warn('settings.push',e); }
  },
  async pullSettings(){
    if(!db) return false;
    try{
      const {data,error}=await db.from('settings').select('key,value');
      if(error||!data?.length) return false;
      data.forEach(r=>{ try{ UserConfig[r.key]=JSON.parse(r.value); }catch(e){ UserConfig[r.key]=r.value; } });
      localStorage.setItem('mpxCfg2',JSON.stringify(UserConfig));
      return true;
    }catch(e){ console.warn('settings.pull',e); return false; }
  },

  /* ── ACCOUNTS ────────────────────────────────────────── */
  computeBalance(accName){
    const acc=UserConfig._accounts?.find(a=>a.name===accName);
    let bal=acc?.initialBalance||0;
    (AppState?.transactions||[]).forEach(t=>{
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
    const acc=UserConfig._accounts?.find(a=>a.name===accName); if(!acc) return;
    const bal=this.computeBalance(accName);
    acc.currentBalance=bal;
    this._saveLocal();
    if(!db||!acc.id||acc.id.toString().startsWith('lac')) return;
    try{ await db.from('accounts').update({current_balance:bal}).eq('id',acc.id); }
    catch(e){ console.warn('balance.update',e); }
  },
  async updateAllBalances(){
    if(!UserConfig._accounts?.length) return;
    for(const acc of UserConfig._accounts) await this.updateAccountBalance(acc.name);
  },
  async loadAccounts(){
    let localAccounts=null;
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_acc')||'null');
      if(Array.isArray(lc) && lc.length) localAccounts=lc;
    }catch(e){}

    const normalizeLocal=(acc, idx)=>({
      id: acc?.id || (`lac_${Date.now()}_${idx}`),
      name: String(acc?.name||'').trim(),
      type: acc?.type || 'checking',
      color: acc?.color || '#0066FF',
      icon: acc?.icon || this._iconForType(acc?.type),
      initialBalance: +(acc?.initialBalance ?? acc?.initial_balance ?? 0) || 0,
      currentBalance: acc?.currentBalance!=null ? +acc.currentBalance : (acc?.current_balance!=null ? +acc.current_balance : undefined),
    });

    const hideDbBadge=()=>{ const b=document.getElementById('accsDbBadge'); if(b) b.classList.add('hidden'); };
    const showDbBadge=()=>{ const b=document.getElementById('accsDbBadge'); if(b) b.classList.remove('hidden'); };

    if(db){
      try{
        const {data,error}=await db.from('accounts').select('*').order('sort_order');
        if(!error){
          if(data?.length){
            UserConfig._accounts=data.map(r=>({id:r.id,name:r.name,type:r.type||'checking',color:r.color||'#0066FF',icon:r.icon||'wallet',initialBalance:+r.initial_balance||0,currentBalance:r.current_balance!=null?+r.current_balance:undefined}));
            this._saveLocal();
            showDbBadge();
            return;
          }
          // DB reachable but empty: fall back to local accounts if present (no defaults).
          if(localAccounts?.length){
            UserConfig._accounts=localAccounts.map(normalizeLocal);
            this._saveLocal();
            hideDbBadge();
            try{ toast?.('☁️ DB conti vuoto: uso quelli locali. Usa "Migra dati locali → Database".','warn'); }catch(e){}
            return;
          }
          UserConfig._accounts=[];
          this._saveLocal();
          hideDbBadge();
          return;
        }
      }catch(e){ console.warn('accounts.load DB',e); }
    }

    if(localAccounts?.length){
      UserConfig._accounts=localAccounts.map(normalizeLocal);
      this._saveLocal();
      hideDbBadge();
      return;
    }

    UserConfig._accounts=[];
    this._saveLocal();
    hideDbBadge();
  },
  async saveAccount(acc){
    const idx=UserConfig._accounts.findIndex(a=>a.id===acc.id);
    if(idx>=0) UserConfig._accounts[idx]=acc; else { UserConfig._accounts.push(acc); }
    UserConfig.wallets=UserConfig._accounts.map(a=>a.name);
    this._saveLocal();
    if(!db) return acc;
    const row={name:acc.name,type:acc.type,color:acc.color,icon:acc.icon,initial_balance:acc.initialBalance||0,sort_order:UserConfig._accounts.indexOf(acc)};
    try{
      const isLocal=!acc.id||acc.id.startsWith('lac');
      const res=isLocal?await db.from('accounts').insert([row]).select():await db.from('accounts').update(row).eq('id',acc.id).select();
      if(!res.error && res.data?.[0]){
        const old=acc.id; acc.id=res.data[0].id;
        const i=UserConfig._accounts.findIndex(a=>a.id===old||a.id===res.data[0].id);
        if(i>=0) UserConfig._accounts[i].id=acc.id;
        this._saveLocal();
        try{ const b=document.getElementById('accsDbBadge'); if(b) b.classList.remove('hidden'); }catch(e){}
      }
    }catch(e){ console.warn('accounts.save',e); }
    return acc;
  },
  async deleteAccount(id){
    UserConfig._accounts=UserConfig._accounts.filter(a=>a.id!==id);
    UserConfig.wallets=UserConfig._accounts.map(a=>a.name);
    this._saveLocal();
    if(!db||id.startsWith('lac')) return;
    try{ await db.from('accounts').delete().eq('id',id); }catch(e){ console.warn('accounts.delete',e); }
  },
  async renameAccount(id,newName,oldName){
    const acc=UserConfig._accounts.find(a=>a.id===id); if(!acc) return;
    acc.name=newName; UserConfig.wallets=UserConfig._accounts.map(a=>a.name); this._saveLocal();
    if(!db||id.startsWith('lac')) return;
    try{
      await db.from('accounts').update({name:newName}).eq('id',id);
      await db.from('transactions').update({account:newName}).eq('account',oldName);
      try{ await db.from('transaction_meta').update({account_to:newName}).eq('account_to',oldName); }catch(e){}
    }catch(e){ console.warn('accounts.rename',e); }
  },

  /* ── BUDGETS ──────────────────────────────────────────── */
  async loadBudgets(){
    const localHas=(()=>{ try{ return Object.keys(JSON.parse(localStorage.getItem('mpx_bud')||'{}')||{}).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('budgets').select('*');
        if(!error && data && (data.length||!localHas)){ UserConfig.budgets={}; data.forEach(r=>UserConfig.budgets[r.category_key]=+r.amount); localStorage.setItem('mpx_bud',JSON.stringify(UserConfig.budgets)); return; }
      }catch(e){ console.warn('budgets.load',e); }
    }
    try{ UserConfig.budgets=JSON.parse(localStorage.getItem('mpx_bud')||'{}'); }catch(e){ UserConfig.budgets={}; }
  },
  async saveBudget(catKey,amount){
    if(amount&&+amount>0) UserConfig.budgets[catKey]=+amount; else delete UserConfig.budgets[catKey];
    localStorage.setItem('mpx_bud',JSON.stringify(UserConfig.budgets));
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
        if(!error && data){ data.forEach(r=>{ if(!Categories[r.key]) Categories[r.key]={l:r.label,ic:r.icon,col:r.color,bg:r.background,kw:[],_dbid:r.id,_custom:true}; }); localStorage.setItem('mpx_cats',JSON.stringify(data)); return; }
      }catch(e){ console.warn('cats.load',e); }
    }
    try{ const lc=JSON.parse(localStorage.getItem('mpx_cats')||'[]'); lc.forEach(r=>{ if(!Categories[r.key]) Categories[r.key]={l:r.label,ic:r.icon,col:r.color,bg:r.background,kw:[],_dbid:r.id,_custom:true}; }); }catch(e){}
  },

  /* ── NOTES ────────────────────────────────────────────── */
  _saveNotes(){ localStorage.setItem('mpx_notes',JSON.stringify(UserConfig.notes)); },
  async loadNotes(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_notes')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('notes').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){ UserConfig.notes=data.map(r=>({id:r.id,text:r.text,done:r.done,date:r.date})); this._saveNotes(); return; }
      }catch(e){ console.warn('notes.load',e); }
    }
    try{ UserConfig.notes=JSON.parse(localStorage.getItem('mpx_notes')||'[]'); }catch(e){ UserConfig.notes=[]; }
  },
  async addNote(text){
    const note={id:'ln'+Date.now(),text,done:false,date:fmtDate(new Date())};
    UserConfig.notes.unshift(note); this._saveNotes();
    if(!db) return note;
    try{
      const {data}=await db.from('notes').insert([{text:note.text,done:false,date:note.date}]).select();
      if(data?.[0]){ UserConfig.notes[0].id=data[0].id; this._saveNotes(); }
    }catch(e){ console.warn('notes.add',e); }
    return note;
  },
  async updateNote(id,patch){
    const n=UserConfig.notes.find(x=>x.id===id); if(!n) return; Object.assign(n,patch); this._saveNotes();
    if(!db||id.startsWith('ln')) return;
    try{ await db.from('notes').update(patch).eq('id',id); }catch(e){ console.warn('notes.update',e); }
  },
  async deleteNote(id){
    UserConfig.notes=UserConfig.notes.filter(n=>n.id!==id); this._saveNotes();
    if(!db||id.toString().startsWith('ln')) return;
    try{ await db.from('notes').delete().eq('id',id); }catch(e){ console.warn('notes.delete',e); }
  },

  /* ── TEMPLATES ────────────────────────────────────────── */
  _saveTpl(){ localStorage.setItem('mpx_tpl',JSON.stringify(UserConfig.templates)); },
  async loadTemplates(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_tpl')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('templates').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){ UserConfig.templates=data.map(r=>({id:r.id,name:r.name,type:r.type,amount:+r.amount,category_id:r.category_key||'other',account:r.account_name||'',description:r.description||'',tags:r.tags||'[]'})); this._saveTpl(); return; }
      }catch(e){ console.warn('templates.load',e); }
    }
    try{ UserConfig.templates=JSON.parse(localStorage.getItem('mpx_tpl')||'[]'); }catch(e){ UserConfig.templates=[]; }
  },
  async addTemplate(tpl){
    tpl.id='lt'+Date.now(); UserConfig.templates.unshift(tpl); this._saveTpl();
    if(!db) return tpl;
    try{
      const {data}=await db.from('templates').insert([{name:tpl.name,type:tpl.type,amount:tpl.amount||null,category_key:tpl.category_id||null,account_name:tpl.account||null,description:tpl.description||null,tags:tpl.tags||'[]'}]).select();
      if(data?.[0]){ UserConfig.templates[0].id=data[0].id; this._saveTpl(); }
    }catch(e){ console.warn('templates.add',e); }
    return tpl;
  },
  async deleteTemplate(id){
    UserConfig.templates=UserConfig.templates.filter(t=>t.id!==id); this._saveTpl();
    if(!db||id.toString().startsWith('lt')) return;
    try{ await db.from('templates').delete().eq('id',id); }catch(e){ console.warn('templates.delete',e); }
  },

  /* ── TX META (tags, account_to) ──────────────────────── */
  _saveTxMeta(){ localStorage.setItem('mpxMeta2',JSON.stringify(AppState._localMeta||{})); },
  async loadTxMeta(){
    if(!AppState._localMeta) AppState._localMeta={};
    if(db){
      try{
        const {data,error}=await db.from('transaction_meta').select('*');
        if(!error && data){
          data.forEach(r=>{ if(r?.tx_id) AppState._localMeta[r.tx_id]={account_to:r.account_to||null,tags:r.tags||'[]'}; });
          this._saveTxMeta();
          return;
        }
      }catch(e){ console.warn('txmeta.load',e); }
    }
  },
  async saveTxMeta(txId,meta){
    const id=normId(txId); if(!id) return;
    if(!AppState._localMeta) AppState._localMeta={};
    const m={account_to:meta?.account_to||null,tags:meta?.tags||'[]'};
    AppState._localMeta[id]=m;
    this._saveTxMeta();
    if(!db || !isUUID(id)) return;
    try{ await db.from('transaction_meta').upsert({tx_id:id,tags:m.tags,account_to:m.account_to,updated_at:new Date().toISOString()},{onConflict:'tx_id'}); }
    catch(e){ console.warn('txmeta.save',e); }
  },
  async saveTxMetaStrict(txId,meta){
    const id=normId(txId); if(!id) throw new Error('tx_id mancante');
    if(!AppState._localMeta) AppState._localMeta={};
    const m={account_to:meta?.account_to||null,tags:meta?.tags||'[]'};
    AppState._localMeta[id]=m;
    this._saveTxMeta();
    if(!db || !isUUID(id)) return m;
    const {error}=await db.from('transaction_meta').upsert({tx_id:id,tags:m.tags,account_to:m.account_to,updated_at:new Date().toISOString()},{onConflict:'tx_id'});
    if(error) throw error;
    return m;
  },
  async deleteTxMeta(txId){
    const id=normId(txId); if(!id) return;
    if(AppState._localMeta) delete AppState._localMeta[id];
    this._saveTxMeta();
    if(!db || !isUUID(id)) return;
    try{ await db.from('transaction_meta').delete().eq('tx_id',id); }catch(e){ console.warn('txmeta.delete',e); }
  },

  /* ── GOALS ───────────────────────────────────────────── */
  _saveGoals(){ localStorage.setItem('mpx_goals',JSON.stringify(UserConfig.goals||[])); },
  async loadGoals(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_goals')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('goals').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          UserConfig.goals=data.map(r=>({id:normId(r.id),name:r.name,target:+r.target||0,current:+r.current||0,deadline:r.deadline||'',completed:!!r.completed,color:r.color||null}));
          this._saveGoals();
          return;
        }
      }catch(e){ console.warn('goals.load',e); }
    }
    try{ const lc=JSON.parse(localStorage.getItem('mpx_goals')||'null'); if(lc?.length){ UserConfig.goals=lc.map(g=>({...(g||{}),id:normId(g.id)})); return; } }catch(e){}
    UserConfig.goals=(UserConfig.goals||[]).map(g=>({...(g||{}),id:normId(g.id)}));
  },
  async saveGoal(goal){
    if(!UserConfig.goals) UserConfig.goals=[];
    const g={...(goal||{})};
    g.id=normId(g.id)||('lg'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    g.name=(g.name||'').trim(); g.target=+g.target||0; g.current=Math.max(0,Math.min(g.target||0,+g.current||0));
    g.deadline=g.deadline||''; g.completed=!!g.completed || (g.target>0 && g.current>=g.target); g.color=g.color||UserConfig.color||'#0066FF';
    if(!g.name||!g.target||g.target<=0) return g;
    const idx=UserConfig.goals.findIndex(x=>idEq(x.id,g.id));
    if(idx>=0) UserConfig.goals[idx]=Object.assign({},UserConfig.goals[idx],g); else UserConfig.goals.unshift(g);
    this._saveGoals();
    if(!db) return g;
    try{
      const row={name:g.name,target:g.target,current:g.current,deadline:g.deadline||null,completed:g.completed,color:g.color||null};
      if(isUUID(g.id) && !isLocalId(g.id,'lg')){ await db.from('goals').upsert({id:g.id,...row},{onConflict:'id'}); }
      else {
        const {data,error}=await db.from('goals').insert([row]).select();
        if(!error && data?.[0]?.id){ g.id=data[0].id; const j=UserConfig.goals.findIndex(x=>idEq(x.id,g.id)); if(j>=0) UserConfig.goals[j].id=g.id; this._saveGoals(); }
      }
    }catch(e){ console.warn('goals.save',e); }
    return g;
  },
  async updateGoal(id,patch){
    const gid=normId(id); if(!gid) return;
    const idx=(UserConfig.goals||[]).findIndex(x=>idEq(x.id,gid)); if(idx<0) return;
    UserConfig.goals[idx]=Object.assign({},UserConfig.goals[idx],patch||{});
    const g=UserConfig.goals[idx]; g.target=+g.target||0; g.current=+g.current||0; g.completed=!!g.completed || (g.target>0 && g.current>=g.target);
    this._saveGoals();
    if(!db || !isUUID(gid) || isLocalId(gid,'lg')) return;
    try{
      const row={}; ['name','target','current','deadline','completed','color'].forEach(k=>{ if(patch && k in patch) row[k]=patch[k]; });
      if('target' in row) row.target=+row.target||0; if('current' in row) row.current=+row.current||0; if('deadline' in row) row.deadline=row.deadline||null;
      await db.from('goals').update(row).eq('id',gid);
    }catch(e){ console.warn('goals.update',e); }
  },
  async deleteGoal(id){
    const gid=normId(id); if(!gid) return;
    UserConfig.goals=(UserConfig.goals||[]).filter(x=>!idEq(x.id,gid)); this._saveGoals();
    if(!db || !isUUID(gid) || isLocalId(gid,'lg')) return;
    try{ await db.from('goals').delete().eq('id',gid); }catch(e){ console.warn('goals.delete',e); }
  },

  /* ── DEBTS ───────────────────────────────────────────── */
  _saveDebts(){ localStorage.setItem('mpx_debts',JSON.stringify(UserConfig.debts||[])); },
  async loadDebts(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_debts')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('debts').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          UserConfig.debts=data.map(r=>({id:normId(r.id),person:r.person,amount:+r.amount||0,type:r.type,note:r.note||'',date:r.date,settled:!!r.settled}));
          this._saveDebts(); return;
        }
      }catch(e){ console.warn('debts.load',e); }
    }
    try{ const lc=JSON.parse(localStorage.getItem('mpx_debts')||'null'); if(lc?.length){ UserConfig.debts=lc.map(d=>({...(d||{}),id:normId(d.id)})); return; } }catch(e){}
    UserConfig.debts=(UserConfig.debts||[]).map(d=>({...(d||{}),id:normId(d.id)}));
  },
  async saveDebt(debt){
    if(!UserConfig.debts) UserConfig.debts=[];
    const d={...(debt||{})}; d.id=normId(d.id)||('ld'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    d.person=(d.person||'').trim(); d.amount=+d.amount||0; d.type=d.type==='lend'?'lend':'borrow'; d.note=d.note||''; d.date=d.date||fmtDate(new Date()); d.settled=!!d.settled;
    if(!d.person||!d.amount||d.amount<=0) return d;
    const idx=UserConfig.debts.findIndex(x=>idEq(x.id,d.id)); if(idx>=0) UserConfig.debts[idx]=Object.assign({},UserConfig.debts[idx],d); else UserConfig.debts.unshift(d);
    this._saveDebts();
    if(!db) return d;
    try{
      const row={person:d.person,amount:d.amount,type:d.type,note:d.note,date:d.date,settled:d.settled};
      if(isUUID(d.id) && !isLocalId(d.id,'ld')){ await db.from('debts').upsert({id:d.id,...row},{onConflict:'id'}); }
      else {
        const {data,error}=await db.from('debts').insert([row]).select();
        if(!error && data?.[0]?.id){ d.id=data[0].id; const j=UserConfig.debts.findIndex(x=>idEq(x.id,d.id)); if(j>=0) UserConfig.debts[j].id=d.id; this._saveDebts(); }
      }
    }catch(e){ console.warn('debts.save',e); }
    return d;
  },
  async updateDebt(id,patch){
    const did=normId(id); if(!did) return;
    const idx=(UserConfig.debts||[]).findIndex(x=>idEq(x.id,did)); if(idx<0) return;
    UserConfig.debts[idx]=Object.assign({},UserConfig.debts[idx],patch||{});
    const d=UserConfig.debts[idx]; d.amount=+d.amount||0; d.settled=!!d.settled;
    this._saveDebts();
    if(!db || !isUUID(did) || isLocalId(did,'ld')) return;
    try{
      const row={}; ['person','amount','type','note','date','settled'].forEach(k=>{ if(patch && k in patch) row[k]=patch[k]; });
      if('amount' in row) row.amount=+row.amount||0;
      await db.from('debts').update(row).eq('id',did);
    }catch(e){ console.warn('debts.update',e); }
  },
  async deleteDebt(id){
    const did=normId(id); if(!did) return;
    UserConfig.debts=(UserConfig.debts||[]).filter(x=>!idEq(x.id,did)); this._saveDebts();
    if(!db || !isUUID(did) || isLocalId(did,'ld')) return;
    try{ await db.from('debts').delete().eq('id',did); }catch(e){ console.warn('debts.delete',e); }
  },

  /* ── SUBSCRIPTIONS ───────────────────────────────────── */
  _saveSubs(){ localStorage.setItem('mpx_subscriptions',JSON.stringify(UserConfig.subscriptions||[])); },
  async loadSubscriptions(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_subscriptions')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('subscriptions').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          const today=fmtDate(new Date());
          UserConfig.subscriptions=data.map(r=>({id:normId(r.id),name:r.name,amount:+r.amount||0,frequency:r.frequency||r.billing_cycle||r.cycle||'monthly',nextDate:r.next_date||r.next_billing||r.nextDate||today,active:r.active!==false,color:r.color||null}));
          this._saveSubs(); return;
        }
      }catch(e){ console.warn('subs.load',e); }
    }
    try{ const lc=JSON.parse(localStorage.getItem('mpx_subscriptions')||'null'); if(lc?.length){ UserConfig.subscriptions=lc.map(s=>({...(s||{}),id:normId(s.id)})); return; } }catch(e){}
    UserConfig.subscriptions=(UserConfig.subscriptions||[]).map(s=>({...(s||{}),id:normId(s.id)}));
  },
  async saveSub(sub){
    if(!UserConfig.subscriptions) UserConfig.subscriptions=[];
    const s={...(sub||{})}; s.id=normId(s.id)||('ls'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    s.name=(s.name||'').trim(); s.amount=+s.amount||0; s.frequency=s.frequency||s.cycle||'monthly'; s.nextDate=s.nextDate||s.next||fmtDate(new Date()); s.active=s.active!==false;
    if(!s.name||!s.amount||s.amount<=0) return s;
    const idx=UserConfig.subscriptions.findIndex(x=>idEq(x.id,s.id)); if(idx>=0) UserConfig.subscriptions[idx]=Object.assign({},UserConfig.subscriptions[idx],s); else UserConfig.subscriptions.unshift(s);
    this._saveSubs();
    if(!db) return s;
    const row={name:s.name,amount:s.amount,frequency:s.frequency,next_date:s.nextDate,active:s.active,color:s.color||null};
    try{
      if(isUUID(s.id) && !isLocalId(s.id,'ls')){ await db.from('subscriptions').upsert({id:s.id,...row},{onConflict:'id'}); }
      else {
        const {data,error}=await db.from('subscriptions').insert([row]).select();
        if(!error && data?.[0]?.id){ s.id=data[0].id; const j=UserConfig.subscriptions.findIndex(x=>idEq(x.id,s.id)); if(j>=0) UserConfig.subscriptions[j].id=s.id; this._saveSubs(); }
      }
    }catch(e){ console.warn('subs.save',e); }
    return s;
  },
  async deleteSub(id){
    const sid=normId(id); if(!sid) return;
    UserConfig.subscriptions=(UserConfig.subscriptions||[]).filter(x=>!idEq(x.id,sid)); this._saveSubs();
    if(!db || !isUUID(sid) || isLocalId(sid,'ls')) return;
    try{ await db.from('subscriptions').delete().eq('id',sid); }catch(e){ console.warn('subs.delete',e); }
  },

  /* ── INVESTMENTS ─────────────────────────────────────── */
  _saveInvestments(){ try{ localStorage.setItem('mpx_investments',JSON.stringify(UserConfig.investments||[])); }catch(e){} },
  async loadInvestments(){
    const localHas=(()=>{ try{ return (JSON.parse(localStorage.getItem('mpx_investments')||'[]')||[]).length>0; }catch(e){ return false; } })();
    if(db){
      try{
        const {data,error}=await db.from('investments').select('*').order('created_at',{ascending:false});
        if(!error && data && (data.length||!localHas)){
          UserConfig.investments=data.map(r=>({
            id:normId(r.id),
            symbol:r.symbol,
            name:r.name||'',
            quantity:+r.quantity||0,
            currency:r.currency||'',
            account:r.account_name||'',
            buyPrice:r.buy_price!=null?+r.buy_price:null,
            includeInTotal:r.include_in_total!==false,
            note:r.note||'',
            logoUrl:r.logo_url||'',
          }));
          this._saveInvestments();
          return;
        }
      }catch(e){ console.warn('invest.load',e); }
    }
    try{
      const lc=JSON.parse(localStorage.getItem('mpx_investments')||'null');
      if(lc?.length){
        UserConfig.investments=lc.map(inv=>({
          ...(inv||{}),
          id:normId(inv.id),
          includeInTotal:inv.includeInTotal!==false,
        }));
        return;
      }
    }catch(e){}
    if(!UserConfig.investments) UserConfig.investments=[];
  },
  async saveInvestment(inv){
    if(!UserConfig.investments) UserConfig.investments=[];
    const v={...(inv||{})};
    v.id=normId(v.id)||('li'+Date.now()+'_'+Math.random().toString(36).slice(2,4));
    v.symbol=(v.symbol||'').trim().toUpperCase();
    v.name=(v.name||'').trim();
    v.quantity=+v.quantity||0;
    v.currency=(v.currency||'').trim().toUpperCase();
    v.account=(v.account||'').trim();
    v.buyPrice=v.buyPrice!=null?+v.buyPrice:null;
    v.includeInTotal=v.includeInTotal!==false;
    v.note=v.note||'';
    if(!v.symbol || !v.quantity || v.quantity<=0) return v;
    const idx=UserConfig.investments.findIndex(x=>idEq(x.id,v.id));
    if(idx>=0) UserConfig.investments[idx]=Object.assign({},UserConfig.investments[idx],v); else UserConfig.investments.unshift(v);
    this._saveInvestments();
    if(!db) return v;
    const row={
      symbol:v.symbol,
      name:v.name||null,
      quantity:v.quantity,
      currency:v.currency||null,
      account_name:v.account||null,
      buy_price:v.buyPrice||null,
      include_in_total:v.includeInTotal!==false,
      note:v.note||null,
      logo_url:v.logoUrl||null,
    };
    try{
      if(isUUID(v.id) && !isLocalId(v.id,'li')){
        await db.from('investments').upsert({id:v.id,...row},{onConflict:'id'});
      }else{
        const {data,error}=await db.from('investments').insert([row]).select();
        if(!error && data?.[0]?.id){
          v.id=data[0].id;
          const j=UserConfig.investments.findIndex(x=>idEq(x.id,v.id));
          if(j>=0) UserConfig.investments[j].id=v.id;
          this._saveInvestments();
        }
      }
    }catch(e){ console.warn('invest.save',e); }
    return v;
  },
  async deleteInvestment(id){
    const iid=normId(id); if(!iid) return;
    UserConfig.investments=(UserConfig.investments||[]).filter(x=>!idEq(x.id,iid));
    this._saveInvestments();
    if(!db || !isUUID(iid) || isLocalId(iid,'li')) return;
    try{ await db.from('investments').delete().eq('id',iid); }catch(e){ console.warn('invest.delete',e); }
  },

  /* ── MIGRATE LOCAL → DB ──────────────────────────────── */
  async migrateAll(){
    if(!db){ toast('Connetti Supabase prima','warn'); return; }
    toast('Migrazione in corso...','info');
    let ok=0,fail=0;
    const run=async(fn,label)=>{ try{ await fn(); ok++; }catch(e){ fail++; console.warn(label,e); } };

    await run(async()=>{
      const rows=UserConfig._accounts.map((a,i)=>({name:a.name,type:a.type,color:a.color,icon:a.icon,initial_balance:a.initialBalance||0,sort_order:i}));
      if(rows.length) await db.from('accounts').upsert(rows,{onConflict:'name'});
    },'accounts');
    await run(async()=>{
      const rows=Object.entries(UserConfig.budgets||{}).map(([k,v])=>({category_key:k,amount:v,updated_at:new Date().toISOString()}));
      if(rows.length) await db.from('budgets').upsert(rows,{onConflict:'category_key'});
    },'budgets');
    await run(async()=>{
      if(!UserConfig.templates?.length) return;
      for(const t of UserConfig.templates){
        const row={name:t.name,type:t.type,amount:t.amount||null,category_key:t.category_id||null,account_name:t.account||null,description:t.description||null,tags:t.tags||'[]'};
        if(isUUID(t.id)){ await db.from('templates').upsert({id:t.id,...row},{onConflict:'id'}); }
        else { const res=await db.from('templates').insert([row]).select(); if(res?.data?.[0]?.id) t.id=res.data[0].id; }
      }
      this._saveTpl();
    },'templates');
    await run(async()=>{
      if(!UserConfig.notes?.length) return;
      for(const n of UserConfig.notes){
        const row={text:n.text,done:!!n.done,date:n.date||fmtDate(new Date())};
        if(isUUID(n.id)){ await db.from('notes').upsert({id:n.id,...row},{onConflict:'id'}); }
        else { const res=await db.from('notes').insert([row]).select(); if(res?.data?.[0]?.id) n.id=res.data[0].id; }
      }
      this._saveNotes();
    },'notes');

    await run(async()=>{ for(const g of (UserConfig.goals||[])) await this.saveGoal(g); },'goals');
    await run(async()=>{ for(const d of (UserConfig.debts||[])) await this.saveDebt(d); },'debts');
    await run(async()=>{ for(const s of (UserConfig.subscriptions||[])) await this.saveSub(s); },'subscriptions');
    await run(async()=>{
      if(!UserConfig.investments?.length || !db) return;
      for(const inv of UserConfig.investments){
        const row={
          symbol:inv.symbol,
          name:inv.name||null,
          quantity:inv.quantity||0,
          currency:inv.currency||null,
          account_name:inv.account||null,
          buy_price:inv.buyPrice||null,
          include_in_total:inv.includeInTotal!==false,
          note:inv.note||null,
          logo_url:inv.logoUrl||null,
        };
        if(isUUID(inv.id) && !isLocalId(inv.id,'li')){
          await db.from('investments').upsert({id:inv.id,...row},{onConflict:'id'});
        }else{
          const {data,error}=await db.from('investments').insert([row]).select();
          if(!error && data?.[0]?.id){
            inv.id=data[0].id;
          }
        }
      }
      try{ localStorage.setItem('mpx_investments',JSON.stringify(UserConfig.investments)); }catch(e){}
    },'investments');

    await run(async()=>{
      const meta=loadMetadata();
      const entries=Object.entries(meta||{}).filter(([k,v])=>isUUID(k)&&(v?.account_to||v?.tags&&v.tags!=='[]'));
      for(const [txId,m] of entries) await this.saveTxMeta(txId,{account_to:m.account_to||null,tags:m.tags||'[]'});
    },'txmeta');

    await run(async()=>{
      const localTxs=(loadTransactions()||[]).filter(t=>!isUUID(t.id)); if(!localTxs.length) return;
      for(const t of localTxs){
        if(t.type==='transfer'){
          const desc=t.description||`Giro ${t.account}→${t.account_to}`;
          const res=await dbInsertTxRow(toDbPayload(t,'transfer',desc));
          if(res?.error) throw res.error;
          const newId=res?.data?.[0]?.id;
          if(newId){
            const tags=t.tags||'[]';
            const account_to=t.account_to||null;
            await this.saveTxMetaStrict(newId,{account_to,tags});
          }
        } else {
          const res=await dbInsertTxRow(toDbPayload(t));
          if(res?.error) throw res.error;
          const newId=res.data?.[0]?.id;
          if(newId){ const tags=t.tags||'[]'; const account_to=t.account_to||null; if(account_to||tags!=='[]') await this.saveTxMeta(newId,{account_to,tags}); }
        }
      }
    },'transactions');

    await run(()=>this.updateAllBalances(),'balances');
    await run(()=>this.pushSettings(),'settings');
    toast(`✅ Migrazione completata`,'success');
    await _syncAllFromDB();
  },
};
const SQL_SCHEMA=`-- ============================================================
-- MONEY PRO X — Schema Supabase (v4, robust)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS transactions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, type text NOT NULL, amount numeric(12,2) NOT NULL, category_id text DEFAULT 'other', description text DEFAULT '', date date NOT NULL, time time, account text NOT NULL, recurring boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS transaction_meta (tx_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE, tags text DEFAULT '[]', account_to text, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL UNIQUE, type text DEFAULT 'checking', color text DEFAULT '#0066FF', icon text DEFAULT 'wallet', initial_balance numeric(12,2) DEFAULT 0, current_balance numeric(12,2) DEFAULT 0, sort_order integer DEFAULT 0, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS categories (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, key text NOT NULL UNIQUE, label text NOT NULL, icon text DEFAULT 'tag', color text DEFAULT '#6B7280', background text DEFAULT 'rgba(107,114,128,.12)', sort_order integer DEFAULT 0, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS budgets (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, category_key text NOT NULL UNIQUE, amount numeric(12,2) NOT NULL, period text DEFAULT 'monthly', updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS goals (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL, target numeric(12,2) NOT NULL, current numeric(12,2) DEFAULT 0, deadline date, completed boolean DEFAULT false, color text DEFAULT '#0066FF', created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS debts (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, person text NOT NULL, amount numeric(12,2) NOT NULL, type text NOT NULL, note text DEFAULT '', date date NOT NULL, settled boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS subscriptions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL, amount numeric(12,2) NOT NULL, frequency text DEFAULT 'monthly', next_date date, active boolean DEFAULT true, color text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS templates (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text NOT NULL, type text NOT NULL, amount numeric(12,2), category_key text, account_name text, description text, tags text DEFAULT '[]', created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS notes (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, text text NOT NULL, done boolean DEFAULT false, date date NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS investments (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, symbol text NOT NULL, name text, quantity numeric(20,8) NOT NULL, currency text, account_name text, buy_price numeric(12,4), include_in_total boolean DEFAULT true, note text, logo_url text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());`;
