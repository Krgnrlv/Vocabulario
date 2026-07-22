const GROUP_COLORS = [
  {name:'Золотой', hex:'#E3A83B'},
  {name:'Коралловый', hex:'#D65A46'},
  {name:'Тёмно-бирюзовый', hex:'#2F6E68'},
  {name:'Сливовый', hex:'#7A5980'},
  {name:'Небесный', hex:'#4A7FA5'},
  {name:'Оливковый', hex:'#7C8A4A'},
  {name:'Розовый', hex:'#C1577A'},
  {name:'Индиго', hex:'#4B5A9E'},
  {name:'Горчичный', hex:'#C9A227'},
  {name:'Лесной', hex:'#3F6B4A'},
  {name:'Винный', hex:'#7A2E3B'},
  {name:'Графитовый', hex:'#55636E'},
  {name:'Бирюзовый', hex:'#2D8C8C'},
  {name:'Кирпичный', hex:'#A64B3A'}
];

function hexToHue(hex){
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0;
  if(max !== min){
    const d = max - min;
    switch(max){
      case r: h = ((g-b)/d + (g<b?6:0)); break;
      case g: h = ((b-r)/d + 2); break;
      case b: h = ((r-g)/d + 4); break;
    }
    h /= 6;
  }
  return h;
}
GROUP_COLORS.sort((a,b) => hexToHue(a.hex) - hexToHue(b.hex));

let state = {
  data: { words: [], groups: [] },
  view: 'words',
  wordFilter: { search: '', groupId: 'all' },
  wordSort: 'added',
  editingWordId: null,
  editingGroupId: null,
  pendingDeleteWord: null,
  pendingDeleteGroup: null,
  addGroupColor: GROUP_COLORS[0].hex,
  pendingWordPhoto: null,
  editPhotoPending: undefined,
  pendingGroupPhoto: null,
  editGroupPhotoPending: undefined,
  editGroupColor: null,
  testSetup: { scope: 'all', groupIds: [], direction: 'ru-es', mode: 'flashcards' },
  testSession: null,
  pendingResetProgress: false,
  groupSort: 'created',
  expandedGroupId: null,
  newGroupSelectedWordIds: [],
  newGroupWordSearch: '',
  addWordsPanelGroupId: null,
  addWordsPanelSearch: '',
  sharingGroupId: null,
  loggedIn: false,
  auth: { username: null, displayName: null },
  session: null,
  pendingDeletes: { words: [], groups: [] },
  authMode: 'login',
  authError: '',
  authBusy: false,
  showSettings: false,
  importError: '',
  importSuccess: '',
  pendingImport: null
};

function uid(prefix){ return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

const SUPABASE_URL = 'https://aeqxgexlfypzzfphywpz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_S1hb65vIPjIhKli8ecykKg_QVvoBKqT';
const SESSION_STORAGE_KEY = 'vocabulario-supabase-session';

function normalizeData(parsed){
  parsed = parsed || {};
  parsed.words = parsed.words || [];
  parsed.groups = parsed.groups || [];
  parsed.words.forEach(w => { w.stats = w.stats || {seen:0, correct:0, wrong:0, box:0}; w.groupIds = w.groupIds || []; });
  return parsed;
}

async function storageGetRaw(key){
  try{
    if(window.storage && typeof window.storage.get === 'function'){
      const res = await window.storage.get(key, false);
      if(res && res.value != null) return res.value;
    }
  }catch(e){ /* window.storage unavailable */ }
  try{
    const raw = localStorage.getItem('vocabulario:' + key);
    if(raw != null) return raw;
  }catch(e){ /* localStorage unavailable */ }
  return null;
}
async function storageSetRaw(key, value){
  try{
    if(window.storage && typeof window.storage.set === 'function'){
      await window.storage.set(key, value, false);
    }
  }catch(e){ /* fall through to local backup */ }
  try{ localStorage.setItem('vocabulario:' + key, value); }catch(e){ /* localStorage unavailable */ }
}
async function storageDeleteRaw(key){
  try{
    if(window.storage && typeof window.storage.delete === 'function'){
      await window.storage.delete(key, false);
    }
  }catch(e){ /* window.storage unavailable */ }
  try{ localStorage.removeItem('vocabulario:' + key); }catch(e){ /* localStorage unavailable */ }
}

function normalizeSession(data){
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000
  };
}
async function persistSession(){ if(state.session) await storageSetRaw(SESSION_STORAGE_KEY, JSON.stringify(state.session)); }
async function loadStoredSession(){
  const raw = await storageGetRaw(SESSION_STORAGE_KEY);
  if(raw){ try{ return JSON.parse(raw); }catch(e){ /* ignore */ } }
  return null;
}
async function clearStoredSession(){ await storageDeleteRaw(SESSION_STORAGE_KEY); }

async function authRequest(path, body){
  const res = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok){ throw new Error(data.error_description || data.msg || data.error || 'Ошибка запроса'); }
  return data;
}

async function refreshSupabaseSession(){
  const data = await authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: state.session.refresh_token });
  state.session = normalizeSession(data);
  await persistSession();
}

async function dataFetch(path, options){
  options = options || {};
  const doFetch = () => fetch(SUPABASE_URL + '/rest/v1' + path, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + state.session.access_token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let res = await doFetch();
  if(res.status === 401 && state.session && state.session.refresh_token){
    try{
      await refreshSupabaseSession();
      res = await doFetch();
    }catch(e){
      await performLocalLogout();
      throw new Error('Сессия истекла, войдите снова');
    }
  }
  return res;
}

function groupToRow(g){ return { id: g.id, name: g.name, color: g.color, photo: g.photo || null }; }
function wordToRow(w){ return { id: w.id, es: w.es, ru: w.ru, example: w.example || '', photo: w.photo || null, group_ids: w.groupIds || [], stats: w.stats || {seen:0,correct:0,wrong:0,box:0} }; }
function rowToGroup(r){ return { id: r.id, name: r.name, color: r.color, photo: r.photo || null }; }
function rowToWord(r){ return { id: r.id, es: r.es, ru: r.ru, example: r.example || '', photo: r.photo || null, groupIds: r.group_ids || [], stats: r.stats || {seen:0,correct:0,wrong:0,box:0} }; }

async function loadUserData(){
  const [groupsRes, wordsRes] = await Promise.all([
    dataFetch('/groups?select=*&order=created_at.asc'),
    dataFetch('/words?select=*&order=created_at.asc')
  ]);
  if(!groupsRes.ok || !wordsRes.ok) throw new Error('Не удалось загрузить данные с сервера');
  const groupsRows = await groupsRes.json();
  const wordsRows = await wordsRes.json();
  return { words: wordsRows.map(rowToWord), groups: groupsRows.map(rowToGroup) };
}

async function saveData(){
  if(!state.session) return;
  try{
    if(state.data.groups.length){
      await dataFetch('/groups?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(state.data.groups.map(groupToRow))
      });
    }
    if(state.data.words.length){
      await dataFetch('/words?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(state.data.words.map(wordToRow))
      });
    }
    if(state.pendingDeletes.words.length){
      const ids = state.pendingDeletes.words.map(id => '"' + id + '"').join(',');
      await dataFetch('/words?id=in.(' + ids + ')', { method: 'DELETE' });
      state.pendingDeletes.words = [];
    }
    if(state.pendingDeletes.groups.length){
      const ids = state.pendingDeletes.groups.map(id => '"' + id + '"').join(',');
      await dataFetch('/groups?id=in.(' + ids + ')', { method: 'DELETE' });
      state.pendingDeletes.groups = [];
    }
  }catch(e){
    console.error('Ошибка синхронизации с сервером', e);
  }
}

function groupById(id){ return state.data.groups.find(g => g.id === id); }

function wordGroupsHtml(word){
  if(!word.groupIds || word.groupIds.length === 0) return '';
  const pills = word.groupIds.map(gid => {
    const g = groupById(gid);
    if(!g) return '';
    return `<span class="pill"><span class="pill-dot" style="background:${g.color}"></span>${escapeHtml(g.name)}</span>`;
  }).join('');
  return `<div class="pill-row">${pills}</div>`;
}

function dotsHtml(box){
  let html = '<div class="dots-row">';
  for(let i=0;i<5;i++){
    html += `<span class="dot${i<box?' filled':''}"></span>`;
  }
  html += '</div>';
  return html;
}

function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function tabColorFor(word){
  if(word.groupIds && word.groupIds.length){
    const g = groupById(word.groupIds[0]);
    if(g) return g.color;
  }
  return 'var(--gold)';
}

function resizeImage(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxDim || h > maxDim){
          if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function photoPreviewHtml(dataUrl, clearFnCall){
  return `<div class="photo-thumb-wrap"><img src="${dataUrl}" class="photo-thumb"><button type="button" class="icon-btn photo-remove" onclick="${clearFnCall}">✕</button></div>`;
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function switchTab(view){
  state.view = view;
  state.editingWordId = null;
  state.editingGroupId = null;
  state.editPhotoPending = undefined;
  state.editGroupPhotoPending = undefined;
  state.editGroupColor = null;
  state.pendingDeleteWord = null;
  state.pendingDeleteGroup = null;
  state.sharingGroupId = null;
  state.pendingResetProgress = false;
  if(view === 'test' && !state.testSession){
    state.testSetup.groupIds = state.testSetup.groupIds.filter(id => groupById(id));
  }
  render();
}

/* ---------- WORDS VIEW ---------- */

function renderWordsView(){
  const groups = state.data.groups;
  const groupChecklist = groups.map(g => `
    <label class="chk-pill" id="chk-${g.id}" style="--chip-color:${g.color}">
      <input type="checkbox" value="${g.id}" class="new-word-group" onchange="this.parentElement.classList.toggle('checked', this.checked)">
      <span style="color:${g.color}">●</span> ${escapeHtml(g.name)}
    </label>
  `).join('');

  return `
    <h2 class="section-title">Добавить слово</h2>
    <div class="form-card">
      <div class="form-grid">
        <div>
          <label class="field-label">Испанское слово</label>
          <input type="text" id="input-es" placeholder="например, mariposa">
        </div>
        <div>
          <label class="field-label">Перевод</label>
          <input type="text" id="input-ru" placeholder="например, бабочка">
        </div>
      </div>
      <div class="form-grid full">
        <div>
          <label class="field-label">Пример предложения (необязательно)</label>
          <textarea id="input-example" placeholder="La mariposa vuela sobre las flores."></textarea>
        </div>
      </div>
      ${groups.length ? `
        <label class="field-label">Группы</label>
        <div class="checkbox-list">${groupChecklist}</div>
      ` : `<p class="subtle">Слово можно добавить без группы — группы создаются на вкладке «Группы».</p>`}
      <label class="field-label" style="margin-top:12px;">Фото (необязательно)</label>
      <div class="photo-input-row">
        <label class="file-btn" for="input-photo-file"><span class="file-btn-icon">📷</span> Выбрать фото</label>
        <input type="file" accept="image/*" id="input-photo-file" class="visually-hidden" onchange="handleNewWordPhoto(this)">
      </div>
      <div id="new-word-photo-preview">${state.pendingWordPhoto ? photoPreviewHtml(state.pendingWordPhoto, 'clearNewWordPhoto()') : ''}</div>
      <div style="margin-top:10px;">
        <button class="btn btn-primary" onclick="addWord()">Добавить слово</button>
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" id="search-input" placeholder="Поиск по слову или переводу…" value="${escapeHtml(state.wordFilter.search)}" oninput="onSearchInput(this.value)">
      <select id="word-sort" onchange="onWordSortChange(this.value)">
        <option value="added"${state.wordSort==='added'?' selected':''}>По порядку добавления</option>
        <option value="alpha"${state.wordSort==='alpha'?' selected':''}>По алфавиту (А-Я)</option>
      </select>
    </div>

    <div id="word-list">${renderWordListInner()}</div>
  `;
}

function filteredWords(){
  const search = state.wordFilter.search.trim().toLowerCase();
  let words = state.data.words.filter(w => {
    if(search && !(w.es.toLowerCase().includes(search) || w.ru.toLowerCase().includes(search))) return false;
    return true;
  });
  if(state.wordSort === 'alpha'){
    words = words.slice().sort((a,b) => a.es.localeCompare(b.es, 'es'));
  }
  return words;
}

function renderWordListInner(){
  const words = filteredWords();
  if(state.data.words.length === 0){
    return `<div class="empty-state"><strong>Словарь пока пуст</strong>Добавьте первое испанское слово выше — оно появится здесь в виде карточки.</div>`;
  }
  if(words.length === 0){
    return `<div class="empty-state">По этому запросу слов не найдено.</div>`;
  }
  return words.map(w => renderWordCard(w)).join('');
}

function renderWordCard(w){
  if(state.editingWordId === w.id){
    return renderWordEditCard(w);
  }
  return `
    <div class="card" style="--tab-color:${tabColorFor(w)}">
      <div class="card-row">
        ${w.photo ? `<img src="${w.photo}" class="word-photo" alt="${escapeHtml(w.es)}">` : ''}
        <div style="flex:1;">
          <div class="word-es">${escapeHtml(w.es)}</div>
          <div class="word-ru">${escapeHtml(w.ru)}</div>
          ${w.example ? `<div class="word-example">${escapeHtml(w.example)}</div>` : ''}
          ${wordGroupsHtml(w)}
          ${dotsHtml(w.stats.box)}
        </div>
        <div class="card-actions">
          <button class="icon-btn" title="Изменить" onclick="startEditWord('${w.id}')">✎</button>
        </div>
      </div>
    </div>
  `;
}

function renderWordEditCard(w){
  const groups = state.data.groups;
  const groupChecklist = groups.map(g => `
    <label class="chk-pill${w.groupIds.includes(g.id) ? ' checked':''}" style="--chip-color:${g.color}">
      <input type="checkbox" value="${g.id}" class="edit-word-group" ${w.groupIds.includes(g.id)?'checked':''} onchange="this.parentElement.classList.toggle('checked', this.checked)">
      <span style="color:${g.color}">●</span> ${escapeHtml(g.name)}
    </label>
  `).join('');
  return `
    <div class="card" style="--tab-color:${tabColorFor(w)}">
      <div class="form-grid">
        <div>
          <label class="field-label">Испанское слово</label>
          <input type="text" id="edit-es" value="${escapeHtml(w.es)}">
        </div>
        <div>
          <label class="field-label">Перевод</label>
          <input type="text" id="edit-ru" value="${escapeHtml(w.ru)}">
        </div>
      </div>
      <label class="field-label">Пример предложения</label>
      <textarea id="edit-example">${escapeHtml(w.example||'')}</textarea>
      ${groups.length ? `<label class="field-label" style="margin-top:10px;">Группы</label><div class="checkbox-list">${groupChecklist}</div>` : ''}
      <label class="field-label" style="margin-top:10px;">Фото</label>
      <div class="photo-input-row">
        <label class="file-btn" for="edit-photo-file"><span class="file-btn-icon">📷</span> Заменить фото</label>
        <input type="file" accept="image/*" id="edit-photo-file" class="visually-hidden" onchange="handleEditWordPhoto(this)">
      </div>
      <div id="edit-word-photo-preview">${currentEditPhoto(w) ? photoPreviewHtml(currentEditPhoto(w), 'clearEditWordPhoto()') : ''}</div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="saveEditWord('${w.id}')">Сохранить</button>
        <button class="btn btn-ghost btn-sm" onclick="cancelEditWord()">Отмена</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--coral); border-color:rgba(214,90,70,0.4); margin-left:auto;" onclick="askDeleteWord('${w.id}')">🗑 Удалить слово</button>
      </div>
      ${state.pendingDeleteWord === w.id ? `
        <div class="confirm-row" style="flex-wrap:wrap; margin-top:10px;">
          <span class="confirm-text">Удалить это слово?</span>
          <button class="btn btn-danger btn-sm" onclick="deleteWord('${w.id}')">Да, удалить</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelDeleteWord()">Отмена</button>
        </div>` : ''}
    </div>
  `;
}

function currentEditPhoto(w){
  if(state.editPhotoPending === null) return null;
  if(typeof state.editPhotoPending === 'string') return state.editPhotoPending;
  return w.photo || null;
}

function addWord(){
  const es = document.getElementById('input-es').value.trim();
  const ru = document.getElementById('input-ru').value.trim();
  const example = document.getElementById('input-example').value.trim();
  if(!es || !ru){ flashInvalid(); return; }
  const groupIds = Array.from(document.querySelectorAll('.new-word-group:checked')).map(el => el.value);
  state.data.words.push({
    id: uid('w'), es, ru, example, groupIds, photo: state.pendingWordPhoto || null,
    stats: { seen:0, correct:0, wrong:0, box:0 }
  });
  state.pendingWordPhoto = null;
  saveData();
  render();
}

function handleNewWordPhoto(input){
  const file = input.files[0];
  if(!file) return;
  resizeImage(file, 640, 0.75).then(dataUrl => {
    state.pendingWordPhoto = dataUrl;
    const preview = document.getElementById('new-word-photo-preview');
    if(preview) preview.innerHTML = photoPreviewHtml(dataUrl, 'clearNewWordPhoto()');
  }).catch(() => {});
}
function clearNewWordPhoto(){
  state.pendingWordPhoto = null;
  const preview = document.getElementById('new-word-photo-preview');
  if(preview) preview.innerHTML = '';
  const fileInput = document.getElementById('input-photo-file');
  if(fileInput) fileInput.value = '';
}

function flashInvalid(){
  const esInput = document.getElementById('input-es');
  esInput.style.outline = '2px solid var(--coral)';
  setTimeout(()=>{ esInput.style.outline='none'; }, 900);
}

function onSearchInput(value){
  state.wordFilter.search = value;
  document.getElementById('word-list').innerHTML = renderWordListInner();
}
function onWordSortChange(value){
  state.wordSort = value;
  document.getElementById('word-list').innerHTML = renderWordListInner();
}

function startEditWord(id){
  state.editingWordId = id;
  state.editPhotoPending = undefined;
  state.pendingDeleteWord = null;
  render();
}
function cancelEditWord(){ state.editingWordId = null; state.editPhotoPending = undefined; state.pendingDeleteWord = null; render(); }
function saveEditWord(id){
  const w = state.data.words.find(x => x.id === id);
  if(!w) return;
  const es = document.getElementById('edit-es').value.trim();
  const ru = document.getElementById('edit-ru').value.trim();
  if(!es || !ru) return;
  w.es = es; w.ru = ru;
  w.example = document.getElementById('edit-example').value.trim();
  w.groupIds = Array.from(document.querySelectorAll('.edit-word-group:checked')).map(el => el.value);
  if(state.editPhotoPending === null) w.photo = null;
  else if(typeof state.editPhotoPending === 'string') w.photo = state.editPhotoPending;
  state.editingWordId = null;
  state.editPhotoPending = undefined;
  state.pendingDeleteWord = null;
  saveData();
  render();
}
function handleEditWordPhoto(input){
  const file = input.files[0];
  if(!file) return;
  resizeImage(file, 640, 0.75).then(dataUrl => {
    state.editPhotoPending = dataUrl;
    const preview = document.getElementById('edit-word-photo-preview');
    if(preview) preview.innerHTML = photoPreviewHtml(dataUrl, 'clearEditWordPhoto()');
  }).catch(() => {});
}
function clearEditWordPhoto(){
  state.editPhotoPending = null;
  const preview = document.getElementById('edit-word-photo-preview');
  if(preview) preview.innerHTML = '';
}
function askDeleteWord(id){ state.pendingDeleteWord = id; render(); }
function cancelDeleteWord(){ state.pendingDeleteWord = null; render(); }
function deleteWord(id){
  state.data.words = state.data.words.filter(w => w.id !== id);
  state.pendingDeletes.words.push(id);
  state.pendingDeleteWord = null;
  saveData();
  render();
}

/* ---------- GROUPS VIEW ---------- */

function renderGroupsView(){
  const swatches = GROUP_COLORS.map(c => `
    <div class="swatch${state.addGroupColor===c.hex?' selected':''}" data-color="${c.hex}" style="background:${c.hex}" title="${c.name}" onclick="selectGroupColor('${c.hex}')"></div>
  `).join('');

  const groupsHtml = state.data.groups.length ? sortedGroups().map(g => renderGroupCard(g)).join('') :
    `<div class="empty-state"><strong>Групп пока нет</strong>Создайте первую группу, чтобы объединить слова по темам — еда, глаголы, путешествия…</div>`;

  return `
    <h2 class="section-title">Новая группа</h2>
    <div class="form-card">
      <label class="field-label">Название</label>
      <input type="text" id="input-group-name" placeholder="например, Еда и напитки">
      <label class="field-label" style="margin-top:12px;">Цвет</label>
      <div class="color-swatch-row" id="new-group-swatches">${swatches}</div>
      <label class="field-label">Обложка (необязательно)</label>
      <div class="photo-input-row">
        <label class="file-btn" for="input-group-photo-file"><span class="file-btn-icon">🖼️</span> Выбрать обложку</label>
        <input type="file" accept="image/*" id="input-group-photo-file" class="visually-hidden" onchange="handleNewGroupPhoto(this)">
      </div>
      <div class="group-photo-row" id="new-group-photo-preview">${state.pendingGroupPhoto ? photoPreviewHtml(state.pendingGroupPhoto, 'clearNewGroupPhoto()') : ''}</div>
      <label class="field-label">Добавить уже существующие слова (необязательно)</label>
      ${state.data.words.length ? `
        <input type="text" id="new-group-word-search" placeholder="Поиск по слову или переводу…" style="margin-bottom:8px;" oninput="onNewGroupWordSearch(this.value)">
        <div class="word-picker-list" id="new-group-word-picker">${renderWordPickerList(state.newGroupWordSearch, state.newGroupSelectedWordIds, 'toggleNewGroupWord')}</div>
        <p class="subtle" id="new-group-word-counter" style="margin-top:6px;">${state.newGroupSelectedWordIds.length ? `Выбрано слов: ${state.newGroupSelectedWordIds.length}` : 'Отметь слова, которые нужно сразу включить в группу.'}</p>
      ` : `<p class="subtle">В словаре пока нет слов — сначала добавь их на вкладке «Слова».</p>`}
      <button class="btn btn-primary" style="margin-top:10px;" onclick="addGroup()">Создать группу</button>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
      <h2 class="section-title" style="margin:0;">Мои группы</h2>
      ${state.data.groups.length > 1 ? `
        <select id="group-sort" onchange="onGroupSortChange(this.value)" style="width:auto;">
          <option value="created"${state.groupSort==='created'?' selected':''}>Сначала новые</option>
          <option value="name"${state.groupSort==='name'?' selected':''}>По названию (А-Я)</option>
        </select>
      ` : ''}
    </div>
    ${groupsHtml}
  `;
}

function sortedGroups(){
  const groups = state.data.groups.slice();
  if(state.groupSort === 'name'){
    groups.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  } else {
    groups.reverse();
  }
  return groups;
}

function onGroupSortChange(value){
  state.groupSort = value;
  render();
}

function renderGroupCard(g){
  if(state.editingGroupId === g.id){
    return renderGroupEditCard(g);
  }
  const words = state.data.words.filter(w => w.groupIds.includes(g.id));
  const count = words.length;
  const isExpanded = state.expandedGroupId === g.id;
  const wordsHtml = words.length
    ? words.map(w => `
        <div class="group-word-row">
          ${w.photo ? `<img src="${w.photo}" class="group-word-photo" alt="">` : ''}
          <span class="group-word-es">${escapeHtml(w.es)}</span>
          <span class="group-word-ru">${escapeHtml(w.ru)}</span>
        </div>
      `).join('')
    : `<p class="subtle" style="padding:8px 4px;">В этой группе пока нет слов.</p>`;
  const isAddPanelOpen = state.addWordsPanelGroupId === g.id;
  return `
    <div class="group-card" style="--tab-color:${g.color}">
      <div class="group-row" onclick="toggleGroupExpand('${g.id}')">
        ${g.photo ? `<img src="${g.photo}" class="group-photo" alt="${escapeHtml(g.name)}">` : ''}
        <div style="flex:1;">
          <div class="group-name">${escapeHtml(g.name)}</div>
          <div class="group-count">${count} ${wordNounForm(count)}</div>
        </div>
        <div class="card-actions">
          <span class="group-expand-arrow${isExpanded ? ' open' : ''}">▾</span>
          <button class="icon-btn" title="Изменить" onclick="event.stopPropagation(); startEditGroup('${g.id}')">✎</button>
        </div>
      </div>
      ${isExpanded ? `
        <div class="group-word-list">${wordsHtml}</div>
        <div style="margin-top:10px;" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="toggleAddWordsPanel('${g.id}')">${isAddPanelOpen ? '✕ Закрыть' : '+ Добавить существующие слова'}</button>
          ${isAddPanelOpen ? `
            <div style="margin-top:10px;">
              <input type="text" id="add-words-panel-search" placeholder="Поиск по слову или переводу…" style="margin-bottom:8px;" oninput="onAddWordsPanelSearch(this.value, '${g.id}')">
              <div class="word-picker-list" id="add-words-panel-picker">${renderWordPickerAddList(state.addWordsPanelSearch, g.id)}</div>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function toggleGroupExpand(id){
  state.expandedGroupId = state.expandedGroupId === id ? null : id;
  if(state.expandedGroupId !== id){
    state.addWordsPanelGroupId = null;
    state.addWordsPanelSearch = '';
  }
  render();
}

function renderWordPickerChecklist(search, selectedIds){
  const term = (search || '').trim().toLowerCase();
  const words = state.data.words.filter(w => !term || w.es.toLowerCase().includes(term) || w.ru.toLowerCase().includes(term));
  if(words.length === 0) return `<p class="subtle" style="padding:8px 4px;">Ничего не найдено.</p>`;
  return words.map(w => `
    <label class="word-picker-row">
      <input type="checkbox" ${selectedIds.includes(w.id)?'checked':''} onchange="toggleNewGroupWord('${w.id}')">
      ${w.photo ? `<img src="${w.photo}" class="word-picker-photo" alt="">` : ''}
      <span class="word-picker-es">${escapeHtml(w.es)}</span>
      <span class="word-picker-ru">${escapeHtml(w.ru)}</span>
    </label>
  `).join('');
}

function toggleNewGroupWord(id){
  const idx = state.newGroupSelectedWordIds.indexOf(id);
  if(idx === -1) state.newGroupSelectedWordIds.push(id);
  else state.newGroupSelectedWordIds.splice(idx, 1);
  const picker = document.getElementById('new-group-word-picker');
  if(picker) picker.innerHTML = renderWordPickerChecklist(state.newGroupWordSearch, state.newGroupSelectedWordIds);
  const counter = document.getElementById('new-group-word-counter');
  if(counter) counter.textContent = state.newGroupSelectedWordIds.length ? `Выбрано слов: ${state.newGroupSelectedWordIds.length}` : 'Отметь слова, которые нужно сразу включить в группу.';
}

function onNewGroupWordSearch(value){
  state.newGroupWordSearch = value;
  const picker = document.getElementById('new-group-word-picker');
  if(picker) picker.innerHTML = renderWordPickerChecklist(value, state.newGroupSelectedWordIds);
}

function renderWordPickerAddList(search, groupId){
  const term = (search || '').trim().toLowerCase();
  const words = state.data.words.filter(w => {
    if(w.groupIds.includes(groupId)) return false;
    if(term && !(w.es.toLowerCase().includes(term) || w.ru.toLowerCase().includes(term))) return false;
    return true;
  });
  if(words.length === 0) return `<p class="subtle" style="padding:8px 4px;">${term ? 'Ничего не найдено.' : 'Все слова словаря уже в этой группе.'}</p>`;
  return words.map(w => `
    <div class="word-picker-row word-picker-row-clickable" onclick="addExistingWordToGroup('${w.id}','${groupId}')">
      ${w.photo ? `<img src="${w.photo}" class="word-picker-photo" alt="">` : ''}
      <span class="word-picker-es">${escapeHtml(w.es)}</span>
      <span class="word-picker-ru">${escapeHtml(w.ru)}</span>
      <span class="word-picker-add">+</span>
    </div>
  `).join('');
}

function toggleAddWordsPanel(groupId){
  state.addWordsPanelGroupId = state.addWordsPanelGroupId === groupId ? null : groupId;
  state.addWordsPanelSearch = '';
  render();
}

function onAddWordsPanelSearch(value, groupId){
  state.addWordsPanelSearch = value;
  const picker = document.getElementById('add-words-panel-picker');
  if(picker) picker.innerHTML = renderWordPickerAddList(value, groupId);
}

function addExistingWordToGroup(wordId, groupId){
  const w = state.data.words.find(x => x.id === wordId);
  if(!w) return;
  if(!w.groupIds.includes(groupId)) w.groupIds.push(groupId);
  saveData();
  render();
}

function toggleShareGroup(id){
  state.sharingGroupId = state.sharingGroupId === id ? null : id;
  render();
}

function safeFileName(str){
  return (str || 'group').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'group';
}

function shareGroupFile(id){
  const g = groupById(id);
  if(!g) return;
  const words = state.data.words
    .filter(w => w.groupIds.includes(id))
    .map(w => ({
      es: w.es,
      ru: w.ru,
      example: w.example || '',
      photo: w.photo || null,
      groupIds: [id],
      stats: { seen: 0, correct: 0, wrong: 0, box: 0 }
    }));
  const payload = {
    words,
    groups: [{ id, name: g.name, color: g.color, photo: g.photo || null }],
    exportedAt: new Date().toISOString(),
    sharedGroup: g.name
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabulario-group-${safeFileName(g.name)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  state.sharingGroupId = null;
  render();
}

function selectEditGroupColor(hex){
  state.editGroupColor = hex;
  const container = document.getElementById('edit-group-swatches');
  if(container){
    container.querySelectorAll('.swatch').forEach(el => {
      el.classList.toggle('selected', el.getAttribute('data-color') === hex);
    });
  }
  const card = document.getElementById('edit-group-card-preview');
  if(card) card.style.setProperty('--tab-color', hex);
}

function renderGroupEditCard(g){
  const currentColor = state.editGroupColor || g.color;
  const swatches = GROUP_COLORS.map(c => `
    <div class="swatch${currentColor===c.hex?' selected':''}" data-color="${c.hex}" style="background:${c.hex}" title="${c.name}" onclick="selectEditGroupColor('${c.hex}')"></div>
  `).join('');
  const photo = currentEditGroupPhoto(g);
  const count = state.data.words.filter(w => w.groupIds.includes(g.id)).length;
  const isSharing = state.sharingGroupId === g.id;
  const isPendingDelete = state.pendingDeleteGroup === g.id;
  return `
    <div class="group-card" style="--tab-color:${currentColor}; cursor:default;" id="edit-group-card-preview">
      <div style="display:flex; flex-direction:column; gap:10px;">
        <label class="field-label">Название</label>
        <input type="text" id="edit-group-name" value="${escapeHtml(g.name)}">
        <label class="field-label" style="margin-top:6px;">Цвет</label>
        <div class="color-swatch-row" id="edit-group-swatches">${swatches}</div>
        <label class="field-label">Обложка</label>
        <div class="photo-input-row">
          <label class="file-btn" for="edit-group-photo-file"><span class="file-btn-icon">🖼️</span> Заменить обложку</label>
          <input type="file" accept="image/*" id="edit-group-photo-file" class="visually-hidden" onchange="handleEditGroupPhoto(this)">
        </div>
        <div id="edit-group-photo-preview">${photo ? photoPreviewHtml(photo, 'clearEditGroupPhoto()') : ''}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; flex-wrap:wrap; gap:10px;">
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="saveEditGroup('${g.id}')">Сохранить</button>
            <button class="btn btn-ghost btn-sm" onclick="cancelEditGroup()">Отмена</button>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm" onclick="toggleShareGroup('${g.id}')">🔗 Поделиться</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--coral); border-color:rgba(214,90,70,0.4);" onclick="askDeleteGroup('${g.id}')">🗑 Удалить группу</button>
          </div>
        </div>
        ${isSharing ? `
          <div class="confirm-row" style="flex-wrap:wrap;">
            <span class="confirm-text" style="color:var(--ink); font-weight:600;">Поделиться «${escapeHtml(g.name)}» (${count} ${wordNounForm(count)}):</span>
            <button class="btn btn-primary btn-sm" onclick="shareGroupFile('${g.id}')">Скачать файл группы</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleShareGroup('${g.id}')">Закрыть</button>
          </div>` : ''}
        ${isPendingDelete ? `
          <div class="confirm-row" style="flex-wrap:wrap;">
            <span class="confirm-text">Удалить группу? Слова останутся, но потеряют этот ярлык.</span>
            <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.id}')">Да, удалить</button>
            <button class="btn btn-ghost btn-sm" onclick="cancelDeleteGroup()">Отмена</button>
          </div>` : ''}
      </div>
    </div>
  `;
}

function currentEditGroupPhoto(g){
  if(state.editGroupPhotoPending === null) return null;
  if(typeof state.editGroupPhotoPending === 'string') return state.editGroupPhotoPending;
  return g.photo || null;
}

function startEditGroup(id){
  state.editingGroupId = id;
  state.editGroupPhotoPending = undefined;
  state.editGroupColor = null;
  state.pendingDeleteGroup = null;
  state.sharingGroupId = null;
  render();
}
function cancelEditGroup(){
  state.editingGroupId = null;
  state.editGroupPhotoPending = undefined;
  state.editGroupColor = null;
  state.pendingDeleteGroup = null;
  state.sharingGroupId = null;
  render();
}
function saveEditGroup(id){
  const g = groupById(id);
  if(!g) return;
  const name = document.getElementById('edit-group-name').value.trim();
  if(!name) return;
  g.name = name;
  if(state.editGroupColor) g.color = state.editGroupColor;
  if(state.editGroupPhotoPending === null) g.photo = null;
  else if(typeof state.editGroupPhotoPending === 'string') g.photo = state.editGroupPhotoPending;
  state.editingGroupId = null;
  state.editGroupPhotoPending = undefined;
  state.editGroupColor = null;
  saveData();
  render();
}
function handleEditGroupPhoto(input){
  const file = input.files[0];
  if(!file) return;
  resizeImage(file, 800, 0.75).then(dataUrl => {
    state.editGroupPhotoPending = dataUrl;
    const preview = document.getElementById('edit-group-photo-preview');
    if(preview) preview.innerHTML = photoPreviewHtml(dataUrl, 'clearEditGroupPhoto()');
  }).catch(() => {});
}
function clearEditGroupPhoto(){
  state.editGroupPhotoPending = null;
  const preview = document.getElementById('edit-group-photo-preview');
  if(preview) preview.innerHTML = '';
}

function wordNounForm(n){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod10===1 && mod100!==11) return 'слово';
  if([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return 'слова';
  return 'слов';
}

function selectGroupColor(hex){
  state.addGroupColor = hex;
  const container = document.getElementById('new-group-swatches');
  if(container){
    container.querySelectorAll('.swatch').forEach(el => {
      el.classList.toggle('selected', el.getAttribute('data-color') === hex);
    });
  }
}

function addGroup(){
  const nameInput = document.getElementById('input-group-name');
  const name = nameInput.value.trim();
  if(!name) return;
  const groupId = uid('g');
  state.data.groups.push({ id: groupId, name, color: state.addGroupColor, photo: state.pendingGroupPhoto || null });

  state.newGroupSelectedWordIds.forEach(wid => {
    const w = state.data.words.find(x => x.id === wid);
    if(w && !w.groupIds.includes(groupId)) w.groupIds.push(groupId);
  });
  const addedCount = state.newGroupSelectedWordIds.length;

  state.addGroupColor = GROUP_COLORS[Math.floor(Math.random()*GROUP_COLORS.length)].hex;
  state.pendingGroupPhoto = null;
  state.newGroupSelectedWordIds = [];
  state.newGroupWordSearch = '';
  if(addedCount > 0) state.expandedGroupId = groupId;
  saveData();
  render();
}

function handleNewGroupPhoto(input){
  const file = input.files[0];
  if(!file) return;
  resizeImage(file, 800, 0.75).then(dataUrl => {
    state.pendingGroupPhoto = dataUrl;
    const preview = document.getElementById('new-group-photo-preview');
    if(preview) preview.innerHTML = photoPreviewHtml(dataUrl, 'clearNewGroupPhoto()');
  }).catch(() => {});
}
function clearNewGroupPhoto(){
  state.pendingGroupPhoto = null;
  const preview = document.getElementById('new-group-photo-preview');
  if(preview) preview.innerHTML = '';
  const fileInput = document.getElementById('input-group-photo-file');
  if(fileInput) fileInput.value = '';
}

function askDeleteGroup(id){ state.pendingDeleteGroup = id; render(); }
function cancelDeleteGroup(){ state.pendingDeleteGroup = null; render(); }
function deleteGroup(id){
  state.data.groups = state.data.groups.filter(g => g.id !== id);
  state.data.words.forEach(w => { w.groupIds = w.groupIds.filter(gid => gid !== id); });
  state.pendingDeletes.groups.push(id);
  state.pendingDeleteGroup = null;
  state.sharingGroupId = null;
  if(state.editingGroupId === id) state.editingGroupId = null;
  saveData();
  render();
}

/* ---------- TEST VIEW ---------- */

function renderTestView(){
  if(state.testSession){
    return renderTestSession();
  }
  return renderTestSetup();
}

function renderTestSetup(){
  if(state.data.words.length === 0){
    return `<div class="empty-state"><strong>Проверять пока нечего</strong>Сначала добавьте несколько слов на вкладке «Слова».</div>`;
  }
  const groups = state.data.groups;
  const groupChips = groups.map(g => `
    <button class="choice-chip${state.testSetup.groupIds.includes(g.id)?' selected':''}" onclick="toggleTestGroup('${g.id}')">${escapeHtml(g.name)}</button>
  `).join('');

  const poolSize = computeEffectivePool().length;

  return `
    <div class="setup-card">
      <h2 class="section-title" style="margin-top:0;">Настройка проверки</h2>

      <div class="choice-group">
        <div class="choice-group-label">Какие слова проверять</div>
        <div class="choice-row">
          <button class="choice-chip${state.testSetup.scope==='all'?' selected':''}" onclick="setTestScope('all')">Все слова</button>
          <button class="choice-chip${state.testSetup.scope==='groups'?' selected':''}" onclick="setTestScope('groups')" ${groups.length===0?'disabled':''}>Выбранные группы</button>
        </div>
        ${state.testSetup.scope==='groups' ? `<div class="choice-row" style="margin-top:10px;">${groupChips || '<span class="subtle">Групп ещё нет</span>'}</div>` : ''}
      </div>

      <div class="choice-group">
        <div class="choice-group-label">Направление</div>
        <div class="choice-row">
          <button class="choice-chip${state.testSetup.direction==='ru-es'?' selected':''}" onclick="setTestDirection('ru-es')">Перевод → испанский</button>
          <button class="choice-chip${state.testSetup.direction==='es-ru'?' selected':''}" onclick="setTestDirection('es-ru')">Испанский → перевод</button>
          <button class="choice-chip${state.testSetup.direction==='photo-es'?' selected':''}" onclick="setTestDirection('photo-es')">Фото → слово</button>
        </div>
        ${state.testSetup.direction==='photo-es' && poolSize===0 ? `<div class="warn-text">В этой подборке нет слов с фото. Добавьте фото к словам на вкладке «Слова» или выберите другое направление.</div>` : ''}
      </div>

      <div class="choice-group">
        <div class="choice-group-label">Формат</div>
        <div class="choice-row">
          <button class="choice-chip${state.testSetup.mode==='flashcards'?' selected':''}" onclick="setTestMode('flashcards')">Карточки (самопроверка)</button>
          <button class="choice-chip${state.testSetup.mode==='choice'?' selected':''}" onclick="setTestMode('choice')">Тест с вариантами</button>
        </div>
        ${state.testSetup.mode==='choice' && poolSize < 4 && poolSize > 0 ? `<div class="warn-text">Для теста с вариантами нужно минимум 4 слова в подборке — сейчас ${poolSize}. Добавьте слова или выберите карточки.</div>` : ''}
      </div>

      <p class="subtle">В подборке сейчас: <strong style="color:var(--paper)">${poolSize} ${wordNounForm(poolSize)}</strong></p>

      <button class="btn btn-primary" onclick="startTest()" ${poolSize===0 || (state.testSetup.mode==='choice' && poolSize<4) ? 'disabled':''}>Начать проверку</button>

      <div style="margin-top:26px; padding-top:18px; border-top:1px solid var(--line);">
        ${state.pendingResetProgress ? `
          <div class="confirm-row" style="flex-wrap:wrap;">
            <span class="confirm-text">Сбросить весь прогресс изучения? Это обнулит статистику по всем словам.</span>
            <button class="btn btn-danger btn-sm" onclick="resetProgress()">Да, сбросить</button>
            <button class="btn btn-ghost btn-sm" onclick="cancelResetProgress()">Отмена</button>
          </div>
        ` : `<button class="btn btn-ghost btn-sm" onclick="askResetProgress()">↺ Сбросить прогресс изучения</button>`}
      </div>
    </div>
  `;
}

function askResetProgress(){ state.pendingResetProgress = true; render(); }
function cancelResetProgress(){ state.pendingResetProgress = false; render(); }
function resetProgress(){
  state.data.words.forEach(w => { w.stats = { seen:0, correct:0, wrong:0, box:0 }; });
  state.pendingResetProgress = false;
  saveData();
  render();
}

function computeTestPool(){
  if(state.testSetup.scope === 'all') return state.data.words;
  if(state.testSetup.groupIds.length === 0) return [];
  return state.data.words.filter(w => w.groupIds.some(gid => state.testSetup.groupIds.includes(gid)));
}

function computeEffectivePool(){
  let pool = computeTestPool();
  if(state.testSetup.direction === 'photo-es'){
    pool = pool.filter(w => !!w.photo);
  }
  return pool;
}

function toggleTestGroup(id){
  const idx = state.testSetup.groupIds.indexOf(id);
  if(idx === -1) state.testSetup.groupIds.push(id); else state.testSetup.groupIds.splice(idx,1);
  render();
}
function setTestScope(scope){ state.testSetup.scope = scope; render(); }
function setTestDirection(dir){ state.testSetup.direction = dir; render(); }
function setTestMode(mode){ state.testSetup.mode = mode; render(); }

function startTest(customPool){
  const pool = customPool || computeEffectivePool();
  if(pool.length === 0) return;
  state.testSession = {
    pool: shuffle(pool),
    pos: 0,
    correct: 0,
    wrongIds: [],
    revealed: false,
    feedback: null,
    answering: false,
    mode: state.testSetup.mode,
    direction: state.testSetup.direction
  };
  render();
}

function currentTestWord(){ return state.testSession.pool[state.testSession.pos]; }

function frontDisplay(word, dir){
  if(dir === 'ru-es') return word.ru;
  if(dir === 'photo-es') return '';
  return word.es;
}
function backDisplay(word, dir){
  if(dir === 'ru-es') return word.es;
  if(dir === 'photo-es') return word.es;
  return word.ru;
}

function frontBackText(word){
  const dir = state.testSession.direction;
  return { front: frontDisplay(word, dir), back: backDisplay(word, dir) };
}

function renderTestSession(){
  const ts = state.testSession;
  if(ts.pos >= ts.pool.length){
    return renderTestSummary();
  }
  const word = currentTestWord();
  const { front, back } = frontBackText(word);
  const progressPct = Math.round((ts.pos / ts.pool.length) * 100);

  let stageHtml = '';
  if(ts.mode === 'flashcards'){
    const frontPhoto = ts.direction === 'photo-es'
      ? (word.photo ? `<img src="${word.photo}" class="test-photo" alt="">` : `<div class="no-photo-hint">Нет фото</div>`)
      : (ts.direction === 'ru-es' && word.photo ? `<img src="${word.photo}" class="test-photo" alt="">` : '');
    const backPhoto = ts.direction === 'es-ru' && word.photo ? `<img src="${word.photo}" class="test-photo" alt="">` : '';
    stageHtml = `
      <div class="flash-stage">
        ${ts.revealed ? `<button class="swipe-btn no" onclick="answerFlash(false)" title="Не помню">✕</button>` : `<div style="width:54px;flex-shrink:0;"></div>`}
        <div class="flip-card-outer" id="flip-outer">
          <div class="flip-card-inner${ts.revealed ? ' flipped' : ''}">
            <div class="flip-face flip-face-front">
              ${frontPhoto}
              ${front ? `<div class="flip-front">${escapeHtml(front)}</div>` : ''}
            </div>
            <div class="flip-face flip-face-back">
              ${backPhoto}
              <div class="flip-back">${escapeHtml(back)}</div>
              ${word.example ? `<div class="flip-example">${escapeHtml(word.example)}</div>` : ''}
            </div>
          </div>
        </div>
        ${ts.revealed ? `<button class="swipe-btn yes" onclick="answerFlash(true)" title="Помню">✓</button>` : `<div style="width:54px;flex-shrink:0;"></div>`}
      </div>
      <div class="session-actions">
        ${!ts.revealed ? `<button class="btn btn-primary" onclick="revealFlash()">Показать перевод</button>` : `<p class="subtle">✕ не помню · ✓ помню</p>`}
      </div>
    `;
  } else {
    if(!ts.feedback){
      ts.currentOptions = buildChoiceOptions(word);
    }
    const opts = ts.currentOptions;
    const frontPhoto = ts.direction === 'photo-es'
      ? (word.photo ? `<img src="${word.photo}" class="test-photo" alt="">` : `<div class="no-photo-hint">Нет фото</div>`)
      : (ts.direction === 'ru-es' && word.photo ? `<img src="${word.photo}" class="test-photo" alt="">` : '');
    stageHtml = `
      <div class="static-card">
        ${frontPhoto}
        ${front ? `<div class="flip-front">${escapeHtml(front)}</div>` : ''}
      </div>
      <div class="choice-options">
        ${opts.map(opt => {
          let cls = 'choice-opt';
          let disabled = ts.feedback ? 'disabled' : '';
          if(ts.feedback){
            if(opt === ts.feedback.correct) cls += ' correct';
            else if(opt === ts.feedback.selected) cls += ' wrong';
          }
          return `<button class="${cls}" ${disabled} onclick="answerChoice(${JSON.stringify(opt).replace(/"/g,'&quot;')})">${escapeHtml(opt)}</button>`;
        }).join('')}
      </div>
    `;
  }

  return `
    <div class="session-stage">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <p class="subtle" style="margin:0;">Слово ${ts.pos + 1} из ${ts.pool.length}</p>
        <button class="btn btn-ghost btn-sm" onclick="exitTestSession()">✕ Выйти из проверки</button>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      ${stageHtml}
    </div>
  `;
}

function exitTestSession(){
  state.testSession = null;
  render();
}

function buildChoiceOptions(word){
  const dir = state.testSession.direction;
  const correct = backDisplay(word, dir);
  const others = state.testSession.pool.filter(w => w.id !== word.id);
  const pickFrom = shuffle(others).slice(0, 8);
  const distractorValues = [];
  for(const o of pickFrom){
    const val = backDisplay(o, dir);
    if(val !== correct && !distractorValues.includes(val)) distractorValues.push(val);
    if(distractorValues.length === 3) break;
  }
  return shuffle([correct, ...distractorValues]);
}

function revealFlash(){ state.testSession.revealed = true; render(); }

function answerFlash(known){
  if(state.testSession.answering) return;
  state.testSession.answering = true;
  const outer = document.getElementById('flip-outer');
  if(outer) outer.classList.add(known ? 'swipe-right' : 'swipe-left');
  setTimeout(() => {
    const word = currentTestWord();
    word.stats.seen++;
    if(known){
      word.stats.correct++;
      word.stats.box = Math.min(5, word.stats.box + 1);
      state.testSession.correct++;
    } else {
      word.stats.wrong++;
      word.stats.box = 0;
      state.testSession.wrongIds.push(word.id);
    }
    saveData();
    state.testSession.answering = false;
    advanceTest();
  }, 380);
}

function answerChoice(selected){
  if(state.testSession.feedback) return;
  const word = currentTestWord();
  const correct = backDisplay(word, state.testSession.direction);
  state.testSession.feedback = { selected, correct };
  word.stats.seen++;
  if(selected === correct){
    word.stats.correct++;
    word.stats.box = Math.min(5, word.stats.box + 1);
    state.testSession.correct++;
  } else {
    word.stats.wrong++;
    word.stats.box = 0;
    state.testSession.wrongIds.push(word.id);
  }
  saveData();
  render();
  setTimeout(() => {
    state.testSession.feedback = null;
    advanceTest();
  }, 900);
}

function advanceTest(){
  state.testSession.pos++;
  state.testSession.revealed = false;
  render();
}

function renderTestSummary(){
  const ts = state.testSession;
  const total = ts.pool.length;
  const pct = total ? Math.round((ts.correct / total) * 100) : 0;
  const uniqueWrongIds = [...new Set(ts.wrongIds)];
  const wrongWords = uniqueWrongIds.map(id => ts.pool.find(w => w.id === id)).filter(Boolean);

  return `
    <div class="session-stage">
      <p class="summary-num">${pct}%</p>
      <p class="summary-sub">${ts.correct} из ${total} правильно</p>
      ${wrongWords.length ? `
        <p class="subtle" style="margin-bottom:10px;">Слова, которые стоит повторить:</p>
        <div class="missed-list">${wrongWords.map(w => `<span class="missed-pill">${escapeHtml(w.es)} — ${escapeHtml(w.ru)}</span>`).join('')}</div>
      ` : `<p class="subtle" style="margin-bottom:20px;">Все слова угаданы верно 🎉</p>`}
      <div class="session-actions">
        ${wrongWords.length ? `<button class="btn btn-primary" onclick="retryWrong()">Повторить сложные слова</button>` : ''}
        <button class="btn btn-ghost" onclick="restartSameTest()">Пройти заново</button>
        <button class="btn btn-ghost" onclick="finishTest()">Готово</button>
      </div>
    </div>
  `;
}

function restartSameTest(){
  const ts = state.testSession;
  const pool = ts.pool.slice();
  const mode = ts.mode, direction = ts.direction;
  state.testSetup.mode = mode;
  state.testSetup.direction = direction;
  startTest(pool);
}

function retryWrong(){
  const ts = state.testSession;
  const uniqueWrongIds = [...new Set(ts.wrongIds)];
  const wrongWords = uniqueWrongIds.map(id => ts.pool.find(w => w.id === id)).filter(Boolean);
  const mode = ts.mode, direction = ts.direction;
  state.testSetup.mode = mode;
  state.testSetup.direction = direction;
  startTest(wrongWords);
}

function finishTest(){
  state.testSession = null;
  render();
}

/* ---------- APP SHELL ---------- */

function renderStats(){
  const total = state.data.words.length;
  const groups = state.data.groups.length;
  const mastered = state.data.words.filter(w => w.stats.box >= 4).length;
  return `
    <div class="stat-strip">
      <div class="stat-item"><span class="stat-num">${total}</span><span class="stat-label">слов</span></div>
      <div class="stat-item"><span class="stat-num">${groups}</span><span class="stat-label">групп</span></div>
      <div class="stat-item"><span class="stat-num">${mastered}</span><span class="stat-label">выучено</span></div>
    </div>
  `;
}

function renderAuthScreen(){
  const isRegister = state.authMode === 'register';
  return `
    <div class="auth-shell">
      <div class="auth-card">
        <h1 class="auth-title">Vocabulario</h1>
        <p class="auth-sub">${isRegister ? 'Создайте аккаунт — и слова будут сохраняться на сервере, доступны с любого устройства' : 'Войдите, чтобы открыть свой словарь'}</p>
        <div class="auth-field">
          <label class="field-label">Email</label>
          <input type="text" id="auth-username" placeholder="you@example.com" autocomplete="username" onkeydown="if(event.key==='Enter') ${isRegister?'submitRegister()':'submitLogin()'}">
        </div>
        ${isRegister ? `
        <div class="auth-field">
          <label class="field-label">Имя пользователя</label>
          <input type="text" id="auth-displayname" placeholder="как к тебе обращаться" autocomplete="nickname" onkeydown="if(event.key==='Enter') submitRegister()">
        </div>` : ''}
        <div class="auth-field">
          <label class="field-label">Пароль</label>
          <input type="password" id="auth-password" placeholder="минимум 6 символов" autocomplete="${isRegister?'new-password':'current-password'}" onkeydown="if(event.key==='Enter') ${isRegister?'submitRegister()':'submitLogin()'}">
        </div>
        ${isRegister ? `
        <div class="auth-field">
          <label class="field-label">Повторите пароль</label>
          <input type="password" id="auth-password2" placeholder="••••••" autocomplete="new-password" onkeydown="if(event.key==='Enter') submitRegister()">
        </div>` : ''}
        ${state.authError ? `<div class="auth-error">${escapeHtml(state.authError)}</div>` : ''}
        <button class="btn btn-primary" style="width:100%;" onclick="${isRegister?'submitRegister()':'submitLogin()'}" ${state.authBusy?'disabled':''}>${state.authBusy ? 'Секунду…' : (isRegister?'Создать аккаунт':'Войти')}</button>
        <p class="auth-switch">
          ${isRegister ? `Уже есть аккаунт? <a onclick="switchAuthMode('login')">Войти</a>` : `Ещё нет аккаунта? <a onclick="switchAuthMode('register')">Создать</a>`}
        </p>
      </div>
    </div>
  `;
}

function switchAuthMode(mode){
  state.authMode = mode;
  state.authError = '';
  render();
}

async function afterAuthSuccess(data){
  state.session = normalizeSession(data);
  await persistSession();
  state.auth.username = data.user ? data.user.email : '';
  state.auth.displayName = null;
  state.authError = '';
  state.authBusy = false;
  try{ state.data = await loadUserData(); }catch(e){ state.data = { words: [], groups: [] }; }
  try{
    const res = await dataFetch('/profiles?select=display_name&limit=1');
    if(res.ok){
      const rows = await res.json();
      if(rows[0] && rows[0].display_name) state.auth.displayName = rows[0].display_name;
    }
  }catch(e){ /* fall back to email in the UI */ }
  state.loggedIn = true;
  state.view = 'words';
  state.pendingDeletes = { words: [], groups: [] };
  render();
}

async function setDisplayName(name){
  try{
    await dataFetch('/profiles?id=eq.' + state.session.user.id, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ display_name: name })
    });
    state.auth.displayName = name;
  }catch(e){ /* non-critical, email still shows */ }
}

async function submitLogin(){
  const email = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  if(!email || !password){ state.authError = 'Введите email и пароль.'; render(); return; }
  state.authBusy = true; state.authError = ''; render();
  try{
    const data = await authRequest('/auth/v1/token?grant_type=password', { email, password });
    await afterAuthSuccess(data);
  }catch(e){
    state.authBusy = false;
    state.authError = e.message || 'Не удалось войти';
    render();
  }
}

async function submitRegister(){
  const email = document.getElementById('auth-username').value.trim();
  const displayName = document.getElementById('auth-displayname').value.trim();
  const password = document.getElementById('auth-password').value;
  const password2 = document.getElementById('auth-password2').value;
  if(!email || !email.includes('@')){ state.authError = 'Введите настоящий email.'; render(); return; }
  if(!displayName){ state.authError = 'Введите имя пользователя.'; render(); return; }
  if(!password || password.length < 6){ state.authError = 'Пароль — минимум 6 символов.'; render(); return; }
  if(password !== password2){ state.authError = 'Пароли не совпадают.'; render(); return; }
  state.authBusy = true; state.authError = ''; render();
  try{
    const data = await authRequest('/auth/v1/signup', { email, password });
    if(data.access_token){
      await afterAuthSuccess(data);
      await setDisplayName(displayName);
      render();
    } else {
      state.authBusy = false;
      state.authMode = 'login';
      state.authError = 'Готово! Проверь почту и подтверди email, затем войди.';
      render();
    }
  }catch(e){
    state.authBusy = false;
    state.authError = e.message || 'Не удалось зарегистрироваться';
    render();
  }
}

async function performLocalLogout(){
  await clearStoredSession();
  state.session = null;
  state.loggedIn = false;
  state.auth = { username: null };
  state.data = { words: [], groups: [] };
  state.authMode = 'login';
  state.authError = '';
  state.view = 'words';
  state.showSettings = false;
  state.importError = '';
  state.importSuccess = '';
  state.pendingImport = null;
}

async function logout(){
  if(state.session){
    try{
      await fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + state.session.access_token }
      });
    }catch(e){ /* best effort */ }
  }
  await performLocalLogout();
  render();
}

function toggleSettings(){
  state.showSettings = !state.showSettings;
  state.importError = '';
  state.importSuccess = '';
  state.pendingImport = null;
  render();
}

function exportDictionary(){
  const payload = {
    words: state.data.words.map(w => ({
      ...w,
      stats: { seen: 0, correct: 0, wrong: 0, box: 0 }
    })),
    groups: state.data.groups,
    exportedAt: new Date().toISOString(),
    exportedBy: state.auth.username
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabulario-${state.auth.username}-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleImportFile(input){
  const file = input.files && input.files[0];
  input.value = '';
  if(!file) return;
  state.importError = '';
  state.importSuccess = '';
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try{
      parsed = JSON.parse(reader.result);
    }catch(e){
      state.importError = 'Не удалось прочитать файл. Убедитесь, что это .json файл, экспортированный из Vocabulario.';
      render();
      return;
    }
    const incomingWords = Array.isArray(parsed.words) ? parsed.words : [];
    const incomingGroups = Array.isArray(parsed.groups) ? parsed.groups : [];
    if(!incomingWords.length && !incomingGroups.length){
      state.importError = 'В этом файле не нашлось слов или групп для импорта.';
      render();
      return;
    }
    const isEmpty = state.data.words.length === 0 && state.data.groups.length === 0;
    if(isEmpty){
      applyImport(incomingWords, incomingGroups);
      state.importSuccess = `Готово! Добавлено ${incomingWords.length} слов и ${incomingGroups.length} групп.`;
      render();
    } else {
      state.pendingImport = { words: incomingWords, groups: incomingGroups };
      render();
    }
  };
  reader.onerror = () => {
    state.importError = 'Не удалось прочитать файл.';
    render();
  };
  reader.readAsText(file);
}

function confirmImport(){
  if(!state.pendingImport) return;
  const { words, groups } = state.pendingImport;
  applyImport(words, groups);
  state.importSuccess = `Готово! Добавлено ${words.length} слов и ${groups.length} групп.`;
  state.pendingImport = null;
  render();
}

function cancelImport(){
  state.pendingImport = null;
  render();
}

function applyImport(incomingWords, incomingGroups){
  const groupIdMap = {};
  incomingGroups.forEach(g => {
    const newId = uid('g');
    groupIdMap[g.id] = newId;
    state.data.groups.push({
      id: newId,
      name: g.name || 'Без названия',
      color: g.color || GROUP_COLORS[0].hex,
      photo: g.photo || null
    });
  });
  incomingWords.forEach(w => {
    state.data.words.push({
      id: uid('w'),
      es: w.es || '',
      ru: w.ru || '',
      example: w.example || '',
      photo: w.photo || null,
      groupIds: Array.isArray(w.groupIds) ? w.groupIds.map(gid => groupIdMap[gid]).filter(Boolean) : [],
      stats: { seen:0, correct:0, wrong:0, box:0 }
    });
  });
  saveData();
}

function renderAccountDropdown(){
  return `
    <div class="account-dropdown" onclick="event.stopPropagation()">
      <div class="account-dropdown-name">${escapeHtml(state.auth.displayName || 'Мой словарь')}</div>
      <div class="account-dropdown-email">${escapeHtml(state.auth.username)}</div>

      <button class="btn btn-ghost btn-sm" style="width:100%; margin-bottom:8px;" onclick="exportDictionary()">Скачать словарь</button>
      <label class="btn btn-ghost btn-sm" for="import-json-file" style="width:100%; text-align:center; cursor:pointer; display:block;">Загрузить уже существующий словарь</label>
      <input type="file" accept=".json,application/json" id="import-json-file" class="visually-hidden" onchange="handleImportFile(this)">

      ${state.importError ? `<div class="auth-error" style="margin-top:10px;">${escapeHtml(state.importError)}</div>` : ''}
      ${state.importSuccess ? `<div class="import-success" style="margin-top:10px;">${escapeHtml(state.importSuccess)}</div>` : ''}
      ${state.pendingImport ? `
        <div class="confirm-row" style="flex-wrap:wrap; margin-top:10px;">
          <span class="confirm-text" style="color:var(--coral); font-size:0.8rem;">Добавить ${state.pendingImport.words.length} слов и ${state.pendingImport.groups.length} групп? Существующие не удалятся.</span>
          <button class="btn btn-danger btn-sm" onclick="confirmImport()">Да</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelImport()">Отмена</button>
        </div>
      ` : ''}

      <div style="border-top:1px solid #e3dcc8; margin:14px 0 10px;"></div>
      <button class="btn btn-ghost btn-sm" style="width:100%; color:var(--coral); border-color:rgba(214,90,70,0.4);" onclick="logout()">Выйти из аккаунта</button>
    </div>
  `;
}

function render(){
  const app = document.getElementById('app');
  if(!state.loggedIn){
    app.innerHTML = renderAuthScreen();
    return;
  }
  let body = '';
  if(state.view === 'words') body = renderWordsView();
  else if(state.view === 'groups') body = renderGroupsView();
  else body = renderTestView();

  app.innerHTML = `
    <div class="app-header">
      <div>
        <h1 class="app-title">Vocabulario</h1>
        <p class="app-tagline">Твой личный испанский словарь</p>
      </div>
      <div style="display:flex; align-items:center; gap:25px;">
        ${renderStats()}
        <div class="account-wrap">
          <button class="account-btn" title="Аккаунт" onclick="toggleSettings()">👤</button>
          ${state.showSettings ? renderAccountDropdown() : ''}
        </div>
      </div>
    </div>
    ${state.showSettings ? `<div class="account-overlay" onclick="toggleSettings()"></div>` : ''}
    <nav class="tabs">
      <button class="tab-btn${state.view==='words'?' active':''}" onclick="switchTab('words')">Слова</button>
      <button class="tab-btn${state.view==='groups'?' active':''}" onclick="switchTab('groups')">Группы</button>
      <button class="tab-btn${state.view==='test'?' active':''}" onclick="switchTab('test')">Проверка</button>
    </nav>
    <div class="view-body">${body}</div>
  `;
}

(async function init(){
  const stored = await loadStoredSession();
  if(stored && stored.access_token){
    state.session = stored;
    state.auth.username = stored.user ? stored.user.email : '';
    try{
      state.data = await loadUserData();
      state.loggedIn = true;
      try{
        const res = await dataFetch('/profiles?select=display_name&limit=1');
        if(res.ok){
          const rows = await res.json();
          if(rows[0] && rows[0].display_name) state.auth.displayName = rows[0].display_name;
        }
      }catch(e){ /* fall back to email in the UI */ }
    } catch(e){
      await performLocalLogout();
    }
  }
  render();
})();
