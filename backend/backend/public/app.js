(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {
  token: localStorage.getItem('pw_token') || '',
  user: null,
  stores: [],
  docs: [],
  selectedStore: null
};

const isAdmin = () => state.user?.role === 'SUPER_ADMIN';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const idOf = x => x?.id ?? x?._id ?? x?.storeId ?? null;
const fmt = v => v ? new Date(v).toLocaleDateString('en-US', {
  month:'short', day:'2-digit', year:'numeric'
}) : '—';

function toast(message, bad = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show${bad ? ' toast-error' : ''}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { el.className = 'toast'; }, 4000);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    logout(false);
    throw new Error('Your session expired. Please sign in again.');
  }
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data ?? response;
}

function showLogin() {
  $('#loginView')?.classList.remove('hidden');
  $('#appView')?.classList.add('hidden');
}
function showApp() {
  $('#loginView')?.classList.add('hidden');
  $('#appView')?.classList.remove('hidden');
}
function logout(showMessage = true) {
  state.token = '';
  state.user = null;
  state.stores = [];
  state.docs = [];
  state.selectedStore = null;
  localStorage.removeItem('pw_token');
  showLogin();
  if (showMessage) toast('Signed out.');
}

function closeMobileMenu() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebarBackdrop')?.classList.remove('show');
  $('#sidebarToggle')?.setAttribute('aria-expanded', 'false');
}
function toggleMobileMenu() {
  const open = $('#sidebar')?.classList.toggle('open') || false;
  $('#sidebarBackdrop')?.classList.toggle('show', open);
  $('#sidebarToggle')?.setAttribute('aria-expanded', String(open));
}

function nav(page) {
  if (!isAdmin() && ['stores','store-detail'].includes(page)) page = 'home';
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('.nav-item,.mobile-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === (page === 'store-detail' ? 'stores' : page));
  });
  closeMobileMenu();
  const crumb = $('#crumb');
  if (crumb) crumb.textContent = page === 'store-detail' ? 'Store details' : page[0].toUpperCase() + page.slice(1);
  if (page === 'home') loadHome();
  if (page === 'stores') loadStores();
  if (page === 'uploads') loadUploads();
  if (page === 'store-detail') loadStoreDetail().catch(e => toast(e.message, true));
}

async function enter(user) {
  if (!user) throw new Error('Login response did not include a user.');
  state.user = user;
  $('#userName').textContent = user.name || 'User';
  $('#userRole').textContent = isAdmin() ? 'Super Admin' : 'Store Manager';
  $('#userAvatar').textContent = (user.name || 'U').charAt(0).toUpperCase();
  $$('[data-admin],.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  $('#managerPanel').classList.toggle('hidden', isAdmin());
  $('#adminHome').classList.toggle('hidden', !isAdmin());
  $('#recentHeading').textContent = isAdmin() ? 'Recent store uploads' : 'My uploaded images and files';
  $('#welcomeTitle').textContent = `Welcome, ${(user.name || 'User').split(' ')[0]}`;
  const stores = await api('/api/stores');
  state.stores = Array.isArray(stores) ? stores : [];
  showApp();
  nav('home');
}

async function login(email, password) {
  const result = await api('/api/auth/login', {
    method:'POST',
    body:JSON.stringify({ email, password })
  });
  state.token = result.token;
  localStorage.setItem('pw_token', result.token);
  await enter(result.user);
}

function fileRow(doc) {
  const fileId = idOf(doc);
  return `<div class="upload-row">
    <div class="file-thumb">${doc.mimeType?.startsWith('image/') ? '▧' : '▤'}</div>
    <div class="file-info"><strong>${esc(doc.originalName || doc.title || 'Uploaded file')}</strong>
    <span>${esc(doc.store?.name || 'Your store')} · ${fmt(doc.documentDate || doc.createdAt)}</span></div>
    <button type="button" class="row-action" data-preview="${esc(fileId)}">View</button>
    <button type="button" class="row-action" data-download="${esc(fileId)}">↓</button>
    ${isAdmin() ? `<button type="button" class="row-action" data-edit-file="${esc(fileId)}">Edit</button><button type="button" class="row-action danger-action" data-delete-file="${esc(fileId)}">Delete</button>` : ''}
  </div>`;
}

async function loadHome() {
  try {
    const docs = await api('/api/documents');
    state.docs = Array.isArray(docs) ? docs : [];
    $('#homeUploads').innerHTML = state.docs.slice(0,10).map(fileRow).join('') || '<div class="empty-state">No uploads yet.</div>';
    if (isAdmin()) {
      $('#adminStoreCount').textContent = state.stores.length;
      $('#adminFileCount').textContent = state.docs.length;
      const drive = await api('/api/drive/status');
      $('#driveStatus').textContent = drive.connected
        ? `Connected${drive.email ? ` as ${drive.email}` : ''}`
        : 'Not connected — connect the Google account for monthly workbooks.';
      $('#connectDrive').textContent = drive.connected ? 'Reconnect Google Drive' : 'Connect Google Drive';
      await loadUsers();
    }
  } catch (e) { toast(e.message, true); }
}

// Store directory and store detail
async function loadStores() {
  try {
    const result = await api('/api/stores');
    state.stores = Array.isArray(result) ? result : [];
    renderStores();
  } catch (e) { toast(e.message, true); }
}
function renderStores() {
  const host = $('#storeCards');
  if (!host) return;
  const query = ($('#storeSearch')?.value || '').trim().toLowerCase();
  const matches = state.stores.filter(s => String(s.name || '').toLowerCase().includes(query));
  host.innerHTML = matches.length ? matches.map(store => {
    const storeId = idOf(store);
    return `<div class="store-card-wrap"><button type="button" class="store-card" data-open-store="${esc(storeId)}">
      <span class="store-card-icon">▣</span>
      <span class="store-card-text"><strong>${esc(store.name || 'Unnamed store')}</strong>
      <small>${Number(store._count?.documents || 0)} uploaded files · ${store.active === false ? 'Inactive' : 'Active'}</small></span>
      <span class="store-card-arrow">→</span>
    </button><div class="admin-card-actions"><button type="button" class="row-action" data-edit-store="${esc(storeId)}">Edit</button><button type="button" class="row-action" data-toggle-store="${esc(storeId)}" data-active="${store.active !== false}">${store.active === false ? 'Activate' : 'Deactivate'}</button><button type="button" class="row-action danger-action" data-delete-store="${esc(storeId)}">Delete</button></div></div>`;
  }).join('') : '<div class="empty-state">No stores found.</div>';
}
async function openStore(id) {
  try {
    if (!id) throw new Error('This store has no ID. Check the /api/stores response.');
    let store = state.stores.find(s => String(idOf(s)) === String(id));
    if (!store) {
      const result = await api('/api/stores');
      state.stores = Array.isArray(result) ? result : [];
      store = state.stores.find(s => String(idOf(s)) === String(id));
    }
    if (!store) throw new Error('Store not found. Refresh the store list and try again.');
    state.selectedStore = { ...store, id: String(idOf(store)) };
    nav('store-detail');
  } catch (e) { toast(e.message || 'Could not open this store.', true); }
}
async function loadStoreDetail() {
  const store = state.selectedStore;
  const storeId = idOf(store);
  if (!store || !storeId) throw new Error('Select a valid store first.');
  $('#storeTitle').textContent = store.name || 'Store details';
  const select = $('#monthYear');
  if (!select.options.length) {
    const currentYear = new Date().getFullYear();
    select.innerHTML = Array.from({length:12}, (_,i) => currentYear + 5 - i)
      .map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}${y === currentYear ? ' (Current year)' : ''}</option>`).join('');
  }
  const year = Number(select.value) || new Date().getFullYear();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  $('#monthCards').innerHTML = months.map((month,i) =>
    `<button type="button" class="month-card" data-month="${i+1}">
      <span>${month}</span><small>${year}</small><b>Open workbook →</b>
    </button>`).join('');
  const docs = await api(`/api/documents?storeId=${encodeURIComponent(storeId)}`);
  $('#storeUploads').innerHTML = (Array.isArray(docs) ? docs : []).map(fileRow).join('') ||
    '<div class="empty-state">No files uploaded for this store yet.</div>';
}

// Backend currently exposes GET /api/stores/:id/monthly.xlsx.
// It returns a Google Drive webViewLink for the generated Excel workbook.
async function openMonth(month) {
  try {
    const storeId = idOf(state.selectedStore);
    if (!storeId) throw new Error('Select a store before opening a month.');
    const year = Number($('#monthYear').value) || new Date().getFullYear();
    const monthNumber = Number(month);
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      throw new Error('Invalid month selected.');
    }
    const result = await api(`/api/stores/${encodeURIComponent(storeId)}/monthly.xlsx?year=${year}&month=${monthNumber}`);
    const target = result.webViewLink || result.url;
    if (!target) throw new Error(result.error || 'The server did not return a Google Drive workbook link.');
    window.open(target, '_blank', 'noopener');
  } catch (e) { toast(e.message || 'Could not open the monthly workbook.', true); }
}

// Modal helpers
function openModal(title, fields, submit) {
  let submitting = false;
  $('#modalTitle').textContent = title;
  $('#modalFields').innerHTML = fields;
  $('#modalError').textContent = '';
  $('#modalBackdrop').classList.remove('hidden');
  $('#modalForm').onsubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = $('#modalSubmit');
    button.disabled = true;
    try {
      await submit(new FormData(event.currentTarget));
      $('#modalBackdrop').classList.add('hidden');
    } catch (e) {
      $('#modalError').textContent = e.message;
    } finally { submitting = false; button.disabled = false; }
  };
}
function addStore() {
  openModal('Add a store',
    '<label class="full-field">Store name<input name="name" required placeholder="Enter store name"></label>',
    async form => {
      await api('/api/stores', { method:'POST', body:JSON.stringify({name:form.get('name')}) });
      await loadStores();
      toast('Store added.');
    });
}
async function loadUsers() {
  if (!isAdmin() || !$('#adminUsers')) return;
  try {
    const users = await api('/api/users');
    $('#adminUsers').innerHTML = users.map(user => `<div class="upload-row"><div class="file-thumb">${esc((user.name||'U').slice(0,1).toUpperCase())}</div><div class="file-info"><strong>${esc(user.name)}</strong><span>${esc(user.email)} · ${esc(user.role)} · ${user.active ? 'Active' : 'Inactive'}${user.store?.name ? ` · ${esc(user.store.name)}` : ''}</span></div><button type="button" class="row-action" data-edit-user="${esc(user.id)}">Edit</button><button type="button" class="row-action" data-toggle-user="${esc(user.id)}" data-active="${user.active}">${user.active ? 'Deactivate' : 'Activate'}</button><button type="button" class="row-action danger-action" data-delete-user="${esc(user.id)}">Delete</button></div>`).join('') || '<div class="empty-state">No users found.</div>';
  } catch(e) { $('#adminUsers').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function editUser(id) {
  const users=await api('/api/users'); const user=users.find(u=>String(u.id)===String(id)); if(!user)return toast('User not found.',true);
  const options=state.stores.map(s=>`<option value="${esc(idOf(s))}" ${user.storeId===idOf(s)?'selected':''}>${esc(s.name)}</option>`).join('');
  openModal('Edit user',`<label class="full-field">Name<input name="name" required value="${esc(user.name)}"></label><label class="full-field">Email<input name="email" type="email" required value="${esc(user.email)}"></label><label class="full-field">Role<select name="role"><option value="STORE_MANAGER" ${user.role==='STORE_MANAGER'?'selected':''}>Store manager</option><option value="SUPER_ADMIN" ${user.role==='SUPER_ADMIN'?'selected':''}>Super admin</option></select></label><label class="full-field">Assigned store<select name="storeId"><option value="">No store</option>${options}</select></label><label class="full-field">New password (optional, 10+ characters)<input name="password" type="password" minlength="10"></label>`,async form=>{const body=Object.fromEntries(form.entries());if(!body.password)delete body.password;await api(`/api/users/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(body)});await loadUsers();toast('User updated.');});
}
async function toggleUser(id, active) {
  const users=await api('/api/users');const user=users.find(u=>String(u.id)===String(id));if(!user)return;
  const action=active?'deactivate':'activate';if(!confirm(`${action} ${user.name}'s account?`))return;
  try{await api(`/api/users/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({active:!active})});await loadUsers();toast(`User ${action}d.`);}catch(e){toast(e.message,true);}
}
async function deleteUser(id) {
  const users=await api('/api/users');const user=users.find(u=>String(u.id)===String(id));if(!user)return;
  if(!confirm(`Permanently delete user ${user.name} (${user.email})? This cannot be undone.`))return;
  try{await api(`/api/users/${encodeURIComponent(id)}`,{method:'DELETE'});await loadUsers();toast('User deleted.');}catch(e){toast(e.message,true);}
}

async function editStore(id) {
  const store = state.stores.find(s => String(idOf(s)) === String(id));
  if (!store) return toast('Store not found. Refresh and try again.', true);
  openModal('Edit store', `<label class="full-field">Store name<input name="name" required value="${esc(store.name)}"></label>`, async form => {
    await api(`/api/stores/${encodeURIComponent(id)}`, {method:'PATCH', body:JSON.stringify({name:form.get('name')})});
    await loadStores(); toast('Store updated.');
  });
}
async function toggleStore(id, active) {
  const store = state.stores.find(s => String(idOf(s)) === String(id));
  if (!store) return;
  const action = active ? 'deactivate' : 'activate';
  if (!confirm(`${action.toUpperCase()} "${store.name}"? ${active ? 'Managers will no longer be able to use this store.' : 'This store will become active again.'}`)) return;
  try { await api(`/api/stores/${encodeURIComponent(id)}`, {method:'PATCH',body:JSON.stringify({active:!active})}); await loadStores(); toast(`Store ${action}d.`); }
  catch(e) { toast(e.message,true); }
}
async function deleteStore(id) {
  const store = state.stores.find(s => String(idOf(s)) === String(id));
  if (!store) return;
  if (!confirm(`PERMANENTLY DELETE "${store.name}"? This also deletes its uploaded file records and stored files, monthly slip entries, and deactivates its manager accounts. This cannot be undone. Continue?`)) return;
  if (!confirm(`Final confirmation: permanently delete ${store.name}?`)) return;
  try { const result=await api(`/api/stores/${encodeURIComponent(id)}`,{method:'DELETE'}); await loadStores(); toast(`Store deleted. ${result.deletedDocuments || 0} file records removed.`); }
  catch(e) { toast(e.message,true); }
}
async function editFile(id) {
  const docs = await api('/api/documents');
  const doc = docs.find(d => String(idOf(d)) === String(id));
  if (!doc) return toast('File not found.', true);
  openModal('Edit uploaded file', `<label class="full-field">Title<input name="title" value="${esc(doc.title || '')}" required></label><label class="full-field">File name<input name="originalName" value="${esc(doc.originalName || '')}"></label><label class="full-field">Reference number<input name="referenceNumber" value="${esc(doc.referenceNumber || '')}"></label><label class="full-field">Financial year<input name="financialYear" value="${esc(doc.financialYear || '')}"></label><label class="full-field">Amount<input name="amount" type="number" step="0.01" value="${esc(doc.amount ?? '')}"></label><label class="full-field">Currency<input name="currency" value="${esc(doc.currency || 'INR')}"></label><label class="full-field">Notes<textarea name="notes">${esc(doc.notes || '')}</textarea></label><label class="full-field">Status<select name="status">${['DRAFT','SUBMITTED','APPROVED','REJECTED','CORRECTION_REQUESTED','ARCHIVED'].map(x=>`<option ${doc.status===x?'selected':''}>${x}</option>`).join('')}</select></label>`, async form => {
    const body=Object.fromEntries(form.entries()); await api(`/api/documents/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(body)}); await loadUploads(); if(state.selectedStore) await loadStoreDetail(); toast('File details updated.');
  });
}
async function deleteFile(id) {
  const docs=await api('/api/documents'); const doc=docs.find(d=>String(idOf(d))===String(id));
  if(!doc)return toast('File not found.',true);
  if(!confirm(`Permanently delete "${doc.originalName || doc.title}"? The uploaded file and its record will be removed. This cannot be undone.`))return;
  try{await api(`/api/documents/${encodeURIComponent(id)}`,{method:'DELETE'});await loadUploads();await loadHome();if(state.selectedStore)await loadStoreDetail();toast('File deleted.');}catch(e){toast(e.message,true);}
}

function createManager() {
  if (!state.stores.length) { toast('Add a store before creating a manager login.', true); return; }
  const options = state.stores.map(s => `<option value="${esc(idOf(s))}">${esc(s.name)}</option>`).join('');
  openModal('Create store login', `
    <label class="full-field">Manager display name<input name="name" required></label>
    <label class="full-field">Email address<input name="email" type="email" required></label>
    <label class="full-field">Temporary password (10+ characters)<input name="password" type="password" minlength="10" required></label>
    <label class="full-field">Assigned store<select name="storeId" required>${options}</select></label>`,
    async form => {
      await api('/api/users', { method:'POST', body:JSON.stringify({
        name:form.get('name'), email:form.get('email'), password:form.get('password'),
        role:'STORE_MANAGER', storeId:form.get('storeId')
      })});
      toast('Store login created.');
    });
}

// Uploads
function attachUploadForm(form, kind, errorId) {
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = form.elements.file?.files?.[0];
    if (!file) return;
    const data = new FormData();
    data.append('file', file);
    data.append('kind', kind);
    const now = new Date();
    data.append('documentDate', [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-'));
    const button = form.querySelector('button');
    const error = $('#' + errorId);
    button.disabled = true;
    if (error) error.textContent = '';
    try {
      await api('/api/documents', { method:'POST', body:data });
      form.reset();
      toast(kind === 'DAILY_SHIFT_REPORT' ? 'Daily Shift Report uploaded.' : 'Other file uploaded.');
      await loadHome();
    } catch (e) {
      if (error) error.textContent = e.message;
      else toast(e.message, true);
    } finally { button.disabled = false; }
  });
}
async function loadUploads() {
  try {
    const q = encodeURIComponent($('#uploadSearch').value || '');
    const date = $('#uploadDate').value;
    const docs = await api(`/api/documents?q=${q}${date ? `&date=${date}` : ''}`);
    $('#allUploads').innerHTML = (Array.isArray(docs) ? docs : []).map(fileRow).join('') ||
      '<div class="empty-state">No matching uploads.</div>';
  } catch (e) { toast(e.message, true); }
}
async function fileAction(id, preview) {
  let tab = null;
  try {
    if (preview) tab = window.open('about:blank', '_blank');
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/file`, {
      headers:{ Authorization:`Bearer ${state.token}` }
    });
    if (!response.ok) {
      let message = 'Could not open file';
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (preview && tab) tab.location.href = objectUrl;
    else {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = preview ? '' : 'paper-work-file';
      if (preview) a.target = '_blank';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (e) {
    if (tab) tab.close();
    toast(e.message, true);
  }
}

// All listeners are guarded so a missing optional element cannot stop the app.
function on(selector, event, handler) {
  const element = $(selector);
  if (element) element.addEventListener(event, handler);
}

on('#loginForm','submit',async e => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  $('#loginError').textContent = '';
  try { await login(form.get('email'), form.get('password')); }
  catch (error) { $('#loginError').textContent = error.message; }
});
on('#logoutBtn','click',() => logout());
$$('.nav-item,.mobile-nav-item').forEach(button => button.addEventListener('click', () => nav(button.dataset.page)));
on('#sidebarToggle','click',toggleMobileMenu);
on('#openStoresHome','click',() => nav('stores'));
on('#sidebarBackdrop','click',closeMobileMenu);
$$('[data-go]').forEach(button => button.addEventListener('click',() => nav(button.dataset.go)));
on('#addStoreBtn','click',addStore);
on('#backStores','click',() => nav('stores'));
on('#monthYear','change',() => { if (state.selectedStore) loadStoreDetail().catch(e => toast(e.message,true)); });
on('#closeModal','click',() => $('#modalBackdrop').classList.add('hidden'));
on('#cancelModal','click',() => $('#modalBackdrop').classList.add('hidden'));
on('#storeSearch','input',renderStores);
on('#uploadSearch','input',loadUploads);
on('#uploadDate','change',loadUploads);
on('#createManager','click',createManager);
on('#connectDrive','click',async () => {
  try {
    const result = await api('/api/drive/connect');
    if (!result.url) throw new Error('Google authorization URL was not returned.');
    window.location.href = result.url;
  } catch (e) { toast(e.message,true); }
});
attachUploadForm($('#dailyUploadForm'),'DAILY_SHIFT_REPORT','dailyError');
attachUploadForm($('#otherUploadForm'),'OTHER_FILE','otherError');

document.addEventListener('click', event => {
  const deleteUserButton = event.target.closest('[data-delete-user]');
  if (deleteUserButton) { deleteUser(deleteUserButton.dataset.deleteUser); return; }
  const editUserButton = event.target.closest('[data-edit-user]');
  if (editUserButton) { editUser(editUserButton.dataset.editUser); return; }
  const toggleUserButton = event.target.closest('[data-toggle-user]');
  if (toggleUserButton) { toggleUser(toggleUserButton.dataset.toggleUser, toggleUserButton.dataset.active === 'true'); return; }
  const deleteStoreButton = event.target.closest('[data-delete-store]');
  if (deleteStoreButton) { deleteStore(deleteStoreButton.dataset.deleteStore); return; }
  const editStoreButton = event.target.closest('[data-edit-store]');
  if (editStoreButton) { editStore(editStoreButton.dataset.editStore); return; }
  const toggleStoreButton = event.target.closest('[data-toggle-store]');
  if (toggleStoreButton) { toggleStore(toggleStoreButton.dataset.toggleStore, toggleStoreButton.dataset.active === 'true'); return; }
  const deleteFileButton = event.target.closest('[data-delete-file]');
  if (deleteFileButton) { deleteFile(deleteFileButton.dataset.deleteFile); return; }
  const editFileButton = event.target.closest('[data-edit-file]');
  if (editFileButton) { editFile(editFileButton.dataset.editFile); return; }
  const storeButton = event.target.closest('[data-open-store]');
  if (storeButton) { openStore(storeButton.dataset.openStore); return; }
  const monthButton = event.target.closest('[data-month]');
  if (monthButton) { openMonth(monthButton.dataset.month); return; }
  const previewButton = event.target.closest('[data-preview]');
  if (previewButton) { fileAction(previewButton.dataset.preview,true); return; }
  const downloadButton = event.target.closest('[data-download]');
  if (downloadButton) fileAction(downloadButton.dataset.download,false);
});

(async () => {
  if (!state.token) { showLogin(); return; }
  try {
    const result = await api('/api/auth/me');
    await enter(result.user || result);
  } catch (e) {
    showLogin();
  }
})();
})();
