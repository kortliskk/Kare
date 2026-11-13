const state = {
  user: null,
  csrfToken: '',
  items: [],
  filter: 'all',
  query: '',
  newestFirst: true,
  addMode: 'url',
  selectedKind: 'movie',
  imported: null,
  authMode: 'register',
  activeDetailId: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const dialogs = ['addDialog', 'authDialog', 'detailDialog', 'childDialog'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

const supabase = window.supabase.createClient(KARE_CONFIG.supabaseUrl, KARE_CONFIG.supabaseAnonKey);
const GUEST_KEY = 'kare_guest_items_v1';
const ownerId = () => supabase.auth.getUser().then(({data}) => data.user?.id || null);
const guestItems = () => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || '[]'); } catch { return []; } };
const saveGuest = (items) => localStorage.setItem(GUEST_KEY, JSON.stringify(items));
const norm = (row) => ({ ...row, release_year: row.release_year, poster_url: row.poster_url, source_url: row.source_url, parent_id: row.parent_id, progress_season: row.progress_season, progress_episode: row.progress_episode });
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body || {};
  const user = (await supabase.auth.getUser()).data.user;
  if (path === '/api/bootstrap') {
    state.user = user ? { id:user.id, email:user.email } : null;
    if (user) {
      const {data,error}=await supabase.from('items').select('*').order('created_at',{ascending:true});
      if(error) throw error;
      state.items=(data||[]).map(norm);
    } else state.items=guestItems();
    return {user:state.user, csrfToken:'', items:state.items};
  }
  if (path === '/api/register' || path === '/api/login') {
    const fn = path.endsWith('register') ? supabase.auth.signUp : supabase.auth.signInWithPassword;
    const {data,error}=await fn({email:body.email,password:body.password});
    if(error) throw error;
    if(data.session && data.user) await migrateGuest(data.user.id);
    return {user:data.user?{id:data.user.id,email:data.user.email}:null,message:data.session?'Hesabın hazır.':'E-posta doğrulaması gerekiyorsa gelen kutunu kontrol et.'};
  }
  if (path === '/api/logout') { const {error}=await supabase.auth.signOut(); if(error) throw error; return {}; }
  if (path === '/api/import') return {metadata:await importFromTmdb(body.url)};
  const add = path.match(/^\/api\/items$/);
  const child = path.match(/^\/api\/items\/([^/]+)\/children$/);
  const item = path.match(/^\/api\/items\/([^/]+)$/);
  const isGuest = !user;
  const list = isGuest ? guestItems() : null;
  const persist = async (rows) => { if(isGuest) saveGuest(rows); else { const {error}=await supabase.from('items').upsert(rows.map(dbRow)); if(error) throw error; } };
  if(add && method==='POST') {
    const row={id:crypto.randomUUID(),kind:body.kind,title:body.title,overview:body.overview||'',release_year:body.year||null,poster_url:body.posterUrl||'',source_url:body.sourceUrl||'',status:'planned',parent_id:null,progress_season:1,progress_episode:1,created_at:new Date().toISOString()};
    if(isGuest) { list.push(row); saveGuest(list); } else { const {error}=await supabase.from('items').insert(dbRow(row)); if(error) throw error; }
    return {item:row};
  }
  if(child && method==='POST') {
    const parentId=decodeURIComponent(child[1]);
    if(isGuest && !list.some(x=>x.id===parentId)) throw new Error('Üst içerik bulunamadı.');
    const row={id:crypto.randomUUID(),kind:body.kind,title:body.title,overview:body.overview||'',release_year:null,poster_url:'',source_url:'',status:'planned',parent_id:parentId,progress_season:1,progress_episode:1,created_at:new Date().toISOString()};
    if(isGuest){list.push(row);saveGuest(list);} else {const {error}=await supabase.from('items').insert(dbRow(row));if(error)throw error;}
    return {item:row};
  }
  if(item) {
    const id=decodeURIComponent(item[1]);
    if(method==='PATCH') {
      const patch={}; if(body.status) patch.status=body.status; if(body.progressSeason) patch.progress_season=body.progressSeason; if(body.progressEpisode) patch.progress_episode=body.progressEpisode;
      if(isGuest){const idx=list.findIndex(x=>x.id===id);if(idx<0)throw new Error('İçerik bulunamadı.');list[idx]={...list[idx],...patch};saveGuest(list);return {item:list[idx]};}
      const {data,error}=await supabase.from('items').update(patch).eq('id',id).select().single();if(error)throw error;return {item:norm(data)};
    }
    if(method==='DELETE') {
      if(isGuest){const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const x of list)if(ids.has(x.parent_id)&&!ids.has(x.id)){ids.add(x.id);changed=true;}}saveGuest(list.filter(x=>!ids.has(x.id)));}
      else {const {error}=await supabase.from('items').delete().eq('id',id);if(error)throw error;}
      return {};
    }
  }
  throw new Error('Desteklenmeyen işlem.');
}
function dbRow(row){return {id:row.id,owner_id:undefined,kind:row.kind,title:row.title,overview:row.overview,release_year:row.release_year,poster_url:row.poster_url,source_url:row.source_url,status:row.status,parent_id:row.parent_id,progress_season:row.progress_season,progress_episode:row.progress_episode,created_at:row.created_at};}
async function migrateGuest(userId){const rows=guestItems();if(!rows.length)return;const payload=rows.map(r=>({...dbRow(r),owner_id:userId}));const {error}=await supabase.from('items').upsert(payload);if(error)throw error;saveGuest([]);}
async function importFromTmdb(input){
  const apiKey=KARE_CONFIG.tmdbApiKey;
  if(!apiKey || apiKey.includes('BURAYA')) throw new Error('Otomatik afiş için config.js dosyasına TMDB API anahtarını eklemelisin.');
  let url;try{url=new URL(input);}catch{throw new Error('Geçerli bir bağlantı gir.');}
  const match=url.hostname.endsWith('themoviedb.org')?url.pathname.match(/^\/(movie|tv)\/(\d+)/):url.hostname.includes('imdb.com')?url.pathname.match(/^\/title\/(tt\d+)/):null;
  if(!match) throw new Error('TMDB film/dizi veya IMDb başlık bağlantısı destekleniyor.');
  let kind,id;
  if(match[1]==='movie'||match[1]==='tv'){kind=match[1]==='movie'?'movie':'series';id=match[2];}
  else {const find=await fetch(`https://api.themoviedb.org/3/find/${match[1]}?api_key=${apiKey}&external_source=imdb_id`);const f=await find.json();const hit=f.movie_results?.[0]||f.tv_results?.[0];if(!hit)throw new Error('IMDb kaydı TMDB üzerinde bulunamadı.');kind=f.movie_results?.length?'movie':'series';id=hit.id;}
  const res=await fetch(`https://api.themoviedb.org/3/${kind==='movie'?'movie':'tv'}/${id}?api_key=${apiKey}&language=tr-TR`);const data=await res.json();if(!res.ok)throw new Error(data.status_message||'TMDB bilgisi alınamadı.');
  return {kind,title:data.title||data.name,overview:data.overview||'',year:(data.release_date||data.first_air_date||'').slice(0,4),posterUrl:data.poster_path?`https://image.tmdb.org/t/p/w500${data.poster_path}`:'',sourceUrl:`https://www.themoviedb.org/${kind==='movie'?'movie':'tv'}/${id}`};
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toastRegion').appendChild(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = label || 'İşleniyor…';
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

function getItem(itemId) { return state.items.find((item) => item.id === itemId); }
function childrenOf(parentId) { return state.items.filter((item) => item.parent_id === parentId); }
function roots() { return state.items.filter((item) => !item.parent_id && ['movie', 'series'].includes(item.kind)); }
function formatKind(kind) { return ({ movie: 'FİLM', series: 'DİZİ', season: 'SEZON', episode: 'BÖLÜM' })[kind] || kind; }
function formatStatus(status) { return ({ planned: 'İzlenecek', watching: 'İzleniyor', done: 'Tamamlandı' })[status] || 'İzlenecek'; }

function updateAccount() {
  const avatar = $('#accountAvatar');
  const name = $('#accountName');
  const caption = $('#accountCaption');
  const action = $('#accountAction');
  const cta = $('#sidebarAuthBtn');
  if (state.user) {
    const email = state.user.email || 'Hesabım';
    avatar.textContent = email.slice(0, 1).toUpperCase();
    name.textContent = email;
    caption.textContent = 'Senkronize hesap';
    action.title = 'Oturumu kapat';
    action.setAttribute('aria-label', 'Oturumu kapat');
    cta.hidden = true;
  } else {
    avatar.textContent = 'M';
    name.textContent = 'Misafir';
    caption.textContent = 'Bu cihazda kayıtlı';
    action.title = 'Hesap işlemleri';
    action.setAttribute('aria-label', 'Hesap işlemleri');
    cta.hidden = false;
  }
}

function updateStats() {
  const allRoots = roots();
  const movies = allRoots.filter((item) => item.kind === 'movie').length;
  const series = allRoots.filter((item) => item.kind === 'series').length;
  const done = allRoots.filter((item) => item.status === 'done').length;
  $('#statTotal').textContent = allRoots.length;
  $('#statMovies').textContent = movies;
  $('#statSeries').textContent = series;
  $('#statDone').textContent = done;
  $('#navCount').textContent = allRoots.length;
  $('#allCount').textContent = allRoots.length;
  $('#movieCount').textContent = movies;
  $('#seriesCount').textContent = series;
  $('#visibleCount').textContent = `(${allRoots.length})`;
  $('#doneProgress').style.width = allRoots.length ? `${Math.round(done / allRoots.length * 100)}%` : '0%';
}

function cardMarkup(item, index) {
  const image = safeImageUrl(item.poster_url);
  const year = item.release_year ? `<span class="card-year">${escapeHtml(item.release_year)}</span>` : '';
  const countDescendants = (parentId) => childrenOf(parentId).reduce((sum, child) => sum + 1 + countDescendants(child.id), 0);
  const childTotal = item.kind === 'series' ? countDescendants(item.id) : 0;
  return `
    <article class="media-card">
      <div class="card-poster" role="button" tabindex="0" data-action="details" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} detaylarını aç">
        ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)} afişi" loading="lazy" referrerpolicy="no-referrer">` : `<div class="poster-placeholder">K.</div>`}
        <span class="card-type">${formatKind(item.kind)}</span>${year}
      </div>
      <div class="card-body">
        <div class="card-title-row"><strong class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong><button class="card-menu" type="button" data-action="details" data-id="${escapeHtml(item.id)}" aria-label="Detaylar">···</button></div>
        <p class="card-description">${escapeHtml(item.overview || (item.kind === 'series' ? 'Bölümlerini ve sezonlarını arşivinde tut.' : 'Bu hikâyeyi izleme listende sakla.'))}</p>
        <div class="card-meta">
          <select class="status-select status-${escapeHtml(item.status)}" aria-label="İzleme durumunu değiştir" data-action="status" data-id="${escapeHtml(item.id)}">
            <option value="planned" ${item.status === 'planned' ? 'selected' : ''}>İzlenecek</option>
            <option value="watching" ${item.status === 'watching' ? 'selected' : ''}>İzleniyor</option>
            <option value="done" ${item.status === 'done' ? 'selected' : ''}>Tamamlandı</option>
          </select>
          ${item.kind === 'series' ? `<span class="series-count">${childTotal} alt içerik</span>` : `<button class="card-detail-link" type="button" data-action="details" data-id="${escapeHtml(item.id)}">Detay ↗</button>`}
        </div>
      </div>
    </article>`;
}

function render() {
  updateAccount();
  updateStats();
  const all = roots();
  let visible = all.filter((item) => state.filter === 'all' || item.kind === state.filter);
  if (state.query) {
    const query = state.query.toLocaleLowerCase('tr-TR');
    visible = visible.filter((item) => `${item.title} ${item.overview || ''}`.toLocaleLowerCase('tr-TR').includes(query));
  }
  visible.sort((a, b) => state.newestFirst
    ? String(b.created_at).localeCompare(String(a.created_at))
    : String(a.created_at).localeCompare(String(b.created_at)));
  $('#contentGrid').innerHTML = visible.map(cardMarkup).join('');
  const noContent = all.length === 0;
  $('#emptyState').classList.toggle('show', noContent && !state.query && state.filter === 'all');
  $('#contentGrid').hidden = noContent && !state.query && state.filter === 'all';
  $('#noResults').hidden = !(visible.length === 0 && (state.query.length > 0 || state.filter !== 'all' || !noContent));
  $('#visibleCount').textContent = `(${visible.length})`;
  $$('.filter-chip').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  $$('.side-nav [data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  $$('.nav-link[data-nav="all"]').forEach((button) => button.classList.toggle('active', state.filter === 'all'));
  $$('#contentGrid img').forEach((img) => img.addEventListener('error', () => {
    const placeholder = document.createElement('div');
    placeholder.className = 'poster-placeholder';
    placeholder.textContent = 'K.';
    img.replaceWith(placeholder);
  }, { once: true }));
}

async function refreshData() {
  const data = await api('/api/bootstrap');
  state.user = data.user;
  state.csrfToken = data.csrfToken;
  state.items = data.items || [];
  render();
  if ($('#detailDialog').open && state.activeDetailId) openDetails(state.activeDetailId);
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog.open) dialog.showModal();
}
function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function resetAddForm() {
  $('#addForm').reset();
  $('#addError').textContent = '';
  $('#importPreview').hidden = true;
  $('#importPreview').innerHTML = '';
  $('#sourceUrl').value = '';
  $('#manualTitle').value = '';
  $('#manualYear').value = '';
  $('#manualPoster').value = '';
  $('#manualOverview').value = '';
  state.imported = null;
  setAddMode('url');
  setSelectedKind('movie');
}

function setSelectedKind(kind) {
  state.selectedKind = kind;
  $$('.type-option').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
}
function setAddMode(mode) {
  state.addMode = mode;
  $('#urlMode').hidden = mode !== 'url';
  $('#manualMode').hidden = mode !== 'manual';
  $$('.mode-tab').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  $('#addError').textContent = '';
}
function openAddDialog() {
  resetAddForm();
  openDialog('addDialog');
}

function renderImportPreview(metadata) {
  const preview = $('#importPreview');
  const image = safeImageUrl(metadata.posterUrl);
  preview.innerHTML = `${image ? `<img src="${escapeHtml(image)}" alt="Afiş ön izlemesi" referrerpolicy="no-referrer">` : '<div class="preview-fallback">K.</div>'}
    <div class="preview-meta"><strong>${escapeHtml(metadata.title)}</strong><span>${metadata.kind === 'movie' ? 'Film' : 'Dizi'}${metadata.year ? ` · ${escapeHtml(metadata.year)}` : ''}</span><p>${escapeHtml(metadata.overview || 'Açıklama bulunamadı.')}</p></div>`;
  preview.hidden = false;
  const img = $('img', preview);
  if (img) img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('div'), { className: 'preview-fallback', textContent: 'K.' })), { once: true });
}

async function importMetadata() {
  const button = $('#importBtn');
  const url = $('#sourceUrl').value.trim();
  $('#addError').textContent = '';
  if (!url) { $('#addError').textContent = 'Önce bir TMDB veya IMDb bağlantısı gir.'; return; }
  setBusy(button, true, 'Getiriliyor…');
  try {
    const result = await api('/api/import', { method: 'POST', body: { url } });
    state.imported = result.metadata;
    setSelectedKind(result.metadata.kind);
    renderImportPreview(result.metadata);
    showToast('İçerik bilgileri bulundu. Arşivine ekleyebilirsin.');
  } catch (error) {
    $('#addError').textContent = error.message;
    state.imported = null;
    $('#importPreview').hidden = true;
  } finally { setBusy(button, false); }
}

async function saveNewItem(event) {
  event.preventDefault();
  const button = $('#saveItemBtn');
  $('#addError').textContent = '';
  let payload;
  if (state.addMode === 'url') {
    if (!state.imported) { $('#addError').textContent = 'Önce bağlantıdan bilgileri getir.'; return; }
    payload = {
      kind: state.selectedKind,
      title: state.imported.title,
      overview: state.imported.overview,
      year: state.imported.year,
      posterUrl: state.imported.posterUrl,
      sourceUrl: state.imported.sourceUrl
    };
  } else {
    payload = {
      kind: state.selectedKind,
      title: $('#manualTitle').value.trim(),
      year: $('#manualYear').value.trim() || null,
      posterUrl: $('#manualPoster').value.trim(),
      overview: $('#manualOverview').value.trim()
    };
    if (!payload.title) { $('#addError').textContent = 'İçerik adı boş bırakılamaz.'; $('#manualTitle').focus(); return; }
  }
  setBusy(button, true, 'Ekleniyor…');
  try {
    await api('/api/items', { method: 'POST', body: payload });
    closeDialog('addDialog');
    await refreshData();
    showToast(`${payload.title} arşivine eklendi.`);
  } catch (error) { $('#addError').textContent = error.message; }
  finally { setBusy(button, false); }
}

function statusSelectMarkup(item) {
  return `<select class="status-select status-${escapeHtml(item.status)}" aria-label="İzleme durumunu değiştir" data-action="status" data-id="${escapeHtml(item.id)}">
    <option value="planned" ${item.status === 'planned' ? 'selected' : ''}>İzlenecek</option>
    <option value="watching" ${item.status === 'watching' ? 'selected' : ''}>İzleniyor</option>
    <option value="done" ${item.status === 'done' ? 'selected' : ''}>Tamamlandı</option>
  </select>`;
}

function childEntryMarkup(child) {
  const descendants = childrenOf(child.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (child.kind === 'season') {
    return `<div class="child-entry"><div class="child-entry-top"><div><span class="child-entry-kind">Sezon</span><span class="child-entry-title">${escapeHtml(child.title)}</span></div><button class="child-add-btn" type="button" data-action="add-episode" data-parent="${escapeHtml(child.id)}">＋ Bölüm</button></div>
      ${child.overview ? `<p class="child-entry-note">${escapeHtml(child.overview)}</p>` : ''}
      <div class="nested-episodes">${descendants.filter((entry) => entry.kind === 'episode').length ? descendants.filter((entry) => entry.kind === 'episode').map((episode, i) => `<div class="episode-line"><span>${String(i + 1).padStart(2, '0')} · ${escapeHtml(episode.title)}</span><span>${escapeHtml(formatStatus(episode.status))}</span></div>`).join('') : '<div class="episode-line"><span>Henüz bölüm eklenmedi.</span><span></span></div>'}</div>
    </div>`;
  }
  return `<div class="child-entry"><div class="child-entry-top"><div><span class="child-entry-kind">Bölüm</span><span class="child-entry-title">${escapeHtml(child.title)}</span></div><span class="series-count">${escapeHtml(formatStatus(child.status))}</span></div>${child.overview ? `<p class="child-entry-note">${escapeHtml(child.overview)}</p>` : ''}</div>`;
}

function openDetails(itemId) {
  const item = getItem(itemId);
  if (!item) return;
  state.activeDetailId = item.id;
  const image = safeImageUrl(item.poster_url);
  const childItems = childrenOf(item.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const isSeries = item.kind === 'series';
  const isSeason = item.kind === 'season';
  const progressContent = isSeries ? `
    <section class="watch-progress">
      <div><span class="progress-kicker">KALDIĞIN YER</span><strong>İzleme ilerlemen</strong><p>Son kaldığın sezon ve bölümü kaydet.</p></div>
      <div class="progress-fields"><label>Sezon<input id="progressSeason" class="field-input progress-input" type="number" min="1" max="999" value="${Number(item.progress_season) || 1}"></label><label>Bölüm<input id="progressEpisode" class="field-input progress-input" type="number" min="1" max="999" value="${Number(item.progress_episode) || 1}"></label><button class="button button-primary" id="saveProgressBtn" type="button" data-action="save-progress" data-id="${escapeHtml(item.id)}">Kaydet</button></div>
    </section>` : '';
  const bodyContent = isSeries || isSeason ? `
    ${progressContent}
    <div class="detail-subhead"><strong>${isSeries ? 'Sezonlar ve bölümler' : 'Bölümler'}</strong><div class="detail-actions">
      ${isSeries ? `<button class="button button-secondary" type="button" data-action="add-season" data-parent="${escapeHtml(item.id)}">＋ Sezon</button><button class="button button-quiet" type="button" data-action="add-episode" data-parent="${escapeHtml(item.id)}">＋ Bölüm</button>` : `<button class="button button-secondary" type="button" data-action="add-episode" data-parent="${escapeHtml(item.id)}">＋ Bölüm</button>`}
    </div></div>
    <div class="child-list">${childItems.length ? childItems.map(childEntryMarkup).join('') : `<div class="empty-child">Henüz alt içerik eklenmedi. İlk sezonunu veya bölümünü ekleyebilirsin.</div>`}</div>` : `<div class="empty-child">Bu bir film. Tek başına arşivinde tutulur.</div>`;
  $('#detailContent').innerHTML = `
    <div class="detail-head">
      <div class="detail-poster">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)} afişi" referrerpolicy="no-referrer">` : '<div class="poster-placeholder">K.</div>'}</div>
      <div class="detail-head-copy"><div class="eyebrow">${formatKind(item.kind)}${item.release_year ? ` · ${escapeHtml(item.release_year)}` : ''}</div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.overview || 'Bu içerik için henüz bir açıklama eklenmemiş.')}</p></div>
      <button class="icon-button detail-close" type="button" data-close="detailDialog" aria-label="Kapat">×</button>
    </div>
    <div class="detail-body">
      <div class="detail-toolbar"><span>İZLEME DURUMU</span>${statusSelectMarkup(item)}</div>
      ${bodyContent}
      <div class="detail-foot"><button class="delete-link" type="button" data-action="delete-item" data-id="${escapeHtml(item.id)}">İçeriği ve alt öğelerini sil</button>${item.source_url ? `<a class="source-link" href="${escapeHtml(safeImageUrl(item.source_url))}" target="_blank" rel="noopener noreferrer">Kaynak bağlantısı ↗</a>` : '<span class="series-count">KARE ARŞİVİ</span>'}</div>
    </div>`;
  const detailImage = $('.detail-poster img');
  if (detailImage) detailImage.addEventListener('error', () => detailImage.replaceWith(Object.assign(document.createElement('div'), { className: 'poster-placeholder', textContent: 'K.' })), { once: true });
  openDialog('detailDialog');
}

function openChildDialog(parentId, kind) {
  const parent = getItem(parentId);
  if (!parent) return;
  $('#childForm').reset();
  $('#childError').textContent = '';
  $('#childParentId').value = parentId;
  $('#childKind').value = kind;
  if (kind === 'season') {
    $('#childEyebrow').textContent = 'DİZİNE YENİ SEZON EKLE';
    $('#childTitle').innerHTML = 'Yeni sezon<span class="accent-dot">.</span>';
    $('#childNameLabel').textContent = 'Sezon adı';
    $('#childName').placeholder = 'Örn. 1. Sezon';
  } else {
    $('#childEyebrow').textContent = parent.kind === 'season' ? 'SEZONA YENİ BÖLÜM EKLE' : 'DİZİNE YENİ BÖLÜM EKLE';
    $('#childTitle').innerHTML = 'Yeni bölüm<span class="accent-dot">.</span>';
    $('#childNameLabel').textContent = 'Bölüm adı';
    $('#childName').placeholder = 'Örn. Bölüm 1 · Pilot';
  }
  openDialog('childDialog');
  window.setTimeout(() => $('#childName').focus(), 100);
}

async function saveChild(event) {
  event.preventDefault();
  const parentId = $('#childParentId').value;
  const kind = $('#childKind').value;
  const title = $('#childName').value.trim();
  const button = $('#childForm button[type="submit"]');
  $('#childError').textContent = '';
  if (!title) { $('#childError').textContent = 'Bir isim girmen gerekiyor.'; return; }
  setBusy(button, true, 'Kaydediliyor…');
  try {
    await api(`/api/items/${encodeURIComponent(parentId)}/children`, { method: 'POST', body: { kind, title, overview: $('#childOverview').value.trim() } });
    closeDialog('childDialog');
    await refreshData();
    if (state.activeDetailId) openDetails(state.activeDetailId);
    showToast(`${kind === 'season' ? 'Sezon' : 'Bölüm'} eklendi.`);
  } catch (error) { $('#childError').textContent = error.message; }
  finally { setBusy(button, false); }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $$('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
  $('#authEyebrow').textContent = register ? 'KİŞİSEL ARŞİVİNİ KORU' : 'KARE ARŞİVİNE DÖN';
  $('#authTitle').innerHTML = register ? 'Hikâyelerin<br><span>sana özel kalsın.</span>' : 'Güzel hikâyelere<br><span>kaldığın yerden.</span>';
  $('#authCopy').textContent = register ? 'Hesap oluştur, koleksiyonunu farklı cihazlarda senkronize et.' : 'Hesabına giriş yap ve kişisel arşivine kaldığın yerden devam et.';
  $('#authSubmit').innerHTML = register ? 'Ücretsiz hesap oluştur <span>↗</span>' : 'Giriş yap <span>↗</span>';
  $('#authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('#authPassword').placeholder = register ? 'En az 10 karakter' : 'Şifren';
  $('#passwordHint').textContent = register ? 'En az 10 karakter kullan. Misafir listen hesabına aktarılır.' : 'Giriş bilgilerin güvenli oturum çereziyle korunur.';
  $('#authError').textContent = '';
}

function openAuth(mode = 'register') {
  $('#authForm').reset();
  setAuthMode(mode);
  openDialog('authDialog');
}

async function submitAuth(event) {
  event.preventDefault();
  const button = $('#authSubmit');
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  $('#authError').textContent = '';
  if (state.authMode === 'register' && password.length < 10) {
    $('#authError').textContent = 'Şifre en az 10 karakter olmalı.';
    return;
  }
  setBusy(button, true, 'Kontrol ediliyor…');
  try {
    const endpoint = state.authMode === 'register' ? '/api/register' : '/api/login';
    const result = await api(endpoint, { method: 'POST', body: { email, password } });
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    closeDialog('authDialog');
    await refreshData();
    showToast(result.message || 'Oturum açıldı.');
  } catch (error) { $('#authError').textContent = error.message; }
  finally { setBusy(button, false); }
}

async function logout() {
  if (!window.confirm('Oturumu kapatmak istiyor musun?')) return;
  try {
    await api('/api/logout', { method: 'POST', body: {} });
    await refreshData();
    showToast('Oturum kapatıldı. Bu cihazda misafir olarak devam edebilirsin.');
  } catch (error) { showToast(error.message, 'error'); }
}

async function updateStatus(itemId, status, select) {
  try {
    await api(`/api/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: { status } });
    const item = getItem(itemId);
    if (item) item.status = status;
    if (select) select.className = `status-select status-${status}`;
    render();
    if (state.activeDetailId) {
      const dialog = $('#detailDialog');
      if (dialog.open) openDetails(state.activeDetailId);
    }
    showToast(`Durum güncellendi: ${formatStatus(status)}.`);
  } catch (error) {
    showToast(error.message, 'error');
    await refreshData();
  }
}

async function saveProgress(itemId) {
  const season = Number($('#progressSeason')?.value);
  const episode = Number($('#progressEpisode')?.value);
  const button = $('#saveProgressBtn');
  if (!Number.isInteger(season) || season < 1 || season > 999 || !Number.isInteger(episode) || episode < 1 || episode > 999) {
    showToast('Sezon ve bölüm numarası 1–999 arasında olmalı.', 'error');
    return;
  }
  setBusy(button, true, 'Kaydediliyor…');
  try {
    const result = await api(`/api/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: { progressSeason: season, progressEpisode: episode } });
    const index = state.items.findIndex((entry) => entry.id === itemId);
    if (index >= 0) state.items[index] = { ...state.items[index], ...result.item };
    render();
    openDetails(itemId);
    showToast(`İlerleme kaydedildi: ${season}. sezon, ${episode}. bölüm.`);
  } catch (error) {
    showToast(error.message, 'error');
    setBusy(button, false);
  }
}

async function deleteItem(itemId) {
  const item = getItem(itemId);
  if (!item) return;
  if (!window.confirm(`“${item.title}” ve alt içerikleri arşivinden silinsin mi?`)) return;
  try {
    await api(`/api/items/${encodeURIComponent(itemId)}`, { method: 'DELETE', body: {} });
    closeDialog('detailDialog');
    state.activeDetailId = null;
    await refreshData();
    showToast('İçerik arşivinden silindi.');
  } catch (error) { showToast(error.message, 'error'); }
}

function bindEvents() {
  $('#openAddBtn').addEventListener('click', openAddDialog);
  $('#welcomeAddBtn').addEventListener('click', openAddDialog);
  $('#emptyAddBtn').addEventListener('click', openAddDialog);
  $('#addForm').addEventListener('submit', saveNewItem);
  $('#importBtn').addEventListener('click', importMetadata);
  $('#childForm').addEventListener('submit', saveChild);
  $('#authForm').addEventListener('submit', submitAuth);
  $('#sidebarAuthBtn').addEventListener('click', () => openAuth('register'));
  $('#accountAction').addEventListener('click', () => state.user ? logout() : openAuth('register'));
  $('#searchInput').addEventListener('input', (event) => { state.query = event.target.value.trim(); render(); });
  $('#sortBtn').addEventListener('click', () => {
    state.newestFirst = !state.newestFirst;
    $('#sortBtn').innerHTML = `<span class="sort-icon">↕</span> ${state.newestFirst ? 'Son eklenen' : 'İlk eklenen'} <span class="chevron">⌄</span>`;
    render();
  });

  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close]');
    if (close) { closeDialog(close.dataset.close); return; }
    const filter = event.target.closest('[data-filter]');
    if (filter) { state.filter = filter.dataset.filter; render(); return; }
    const mode = event.target.closest('[data-mode]');
    if (mode) { setAddMode(mode.dataset.mode); return; }
    const type = event.target.closest('[data-kind]');
    if (type) { setSelectedKind(type.dataset.kind); return; }
    const authMode = event.target.closest('[data-auth-mode]');
    if (authMode) { setAuthMode(authMode.dataset.authMode); return; }

    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'details') openDetails(action.dataset.id);
    if (action.dataset.action === 'add-season') openChildDialog(action.dataset.parent, 'season');
    if (action.dataset.action === 'add-episode') openChildDialog(action.dataset.parent, 'episode');
    if (action.dataset.action === 'delete-item') deleteItem(action.dataset.id);
    if (action.dataset.action === 'save-progress') saveProgress(action.dataset.id);
  });

  document.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-action="status"]');
    if (select) updateStatus(select.dataset.id, select.value, select);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
    }
    if (event.key === 'Enter' && event.target.matches('.card-poster[role="button"]')) openDetails(event.target.dataset.id);
  });
  dialogs.forEach((id) => {
    const dialog = document.getElementById(id);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

async function init() {
  bindEvents();
  try {
    await refreshData();
    // Aynı hesap farklı cihazlarda kullanıldığında açık arşivleri de güncel tut.
    window.setInterval(() => {
      if (!document.hidden) refreshData().catch(() => {});
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshData().catch(() => {});
    });
  } catch (error) {
    showToast(error.message || 'Uygulama başlatılamadı.', 'error');
  }
}

init();
