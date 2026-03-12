/* ============================================================
   UI UTILITIES — Modal & Toast Management
   ============================================================ */

/**
 * Show a simple toast notification
 * @param {string} msg - The message to display
 * @param {string} type - 'success' (ts), 'error' (te), 'info' (ti), 'warn' (tw)
 */
function toast(msg, type='success'){
  const container = document.getElementById('toasts');
  if(!container) return;
  const div = document.createElement('div');
  div.className = `toast ${type === 'success' ? 'ts' : type === 'error' ? 'te' : type === 'info' ? 'ti' : 'tw'}`;
  div.innerHTML = msg;
  container.appendChild(div);
  setTimeout(() => {
    div.classList.add('out');
    setTimeout(() => div.remove(), 400);
  }, 3500);
}

/**
 * Global Loading Indicator
 */
function showLoader(){
  const loader = document.getElementById('globalLoader');
  if(loader) loader.classList.remove('hidden');
}

function hideLoader(){
  const loader = document.getElementById('globalLoader');
  if(loader) loader.classList.add('hidden');
}

/**
 * Modal Management
 */
function openModal(id){
  const lockedId =
    (typeof AppState !== "undefined" && AppState && AppState._lockedModalId) || null;
  if (lockedId) {
    const lockedModal = document.getElementById(lockedId);
    if (lockedModal?.classList.contains("on") && id !== lockedId) {
      toast("Completa prima la creazione del conto.", "warn");
      return;
    }
  }

  closeAll(true);
  const modal = document.getElementById(id);
  const overlay = document.getElementById('ov');
  if(modal && overlay){
    modal.classList.add('on');
    overlay.classList.add('on');
    document.body.style.overflow = 'hidden';
    try{ window.lucide?.createIcons({ scope: modal }); }catch(e){}
  }
}

function closeAll(force=false){
  const lockedId =
    (typeof AppState !== "undefined" && AppState && AppState._lockedModalId) || null;
  if (!force && lockedId) {
    const lockedModal = document.getElementById(lockedId);
    if (lockedModal?.classList.contains("on")) {
      toast("Completa prima la creazione del conto.", "warn");
      return;
    }
  }

  document.querySelectorAll('.sh-up.on, .ov.on').forEach(el => el.classList.remove('on'));
  document.body.style.overflow = 'auto';
  // Specific resets if needed
  if(typeof S !== 'undefined') S.editId = null;
}

// Ensure closeAll is available globally for the overlay click
window.closeAll = closeAll;
