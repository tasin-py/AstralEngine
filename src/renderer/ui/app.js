import { icon, hydrateIcons } from './icons.js';

const L = window.astral;
const api = (ch, ...a) => L.invoke(ch, ...a);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtSize = (b) => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const TYPE_LABEL = { scene: 'Scene', video: 'Video', web: 'Web', image: 'Image', application: 'Application', preset: 'Preset' };

const state = {
  tab: 'installed', view: 'all', items: [], settings: null, info: null, wp: null,
  search: '', sort: 'name', filters: { types: new Set(), ratings: new Set(['Everyone', 'Questionable']), sources: new Set(), favorites: false, audio: false },
  selected: null, selectedWs: null, slot: null, revert: null,
  ws: { page: 1, pages: 1, sort: 'trend', items: [], loading: false, types: new Set(), ratings: new Set(['Everyone']), tags: new Set(), loggedIn: false, pending: new Map() },
  disc: null
};

// ---------------------------------------------------------------- utils
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstElementChild; hydrateIcons(n); return n; }
function toast(msg, kind = '') {
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}
async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message || String(e), 'err'); return undefined; }
}
function modal({ title, body, foot, cls = '', onClose }) {
  const m = el(`<div class="modal-back"><div class="modal ${cls}"><div class="modal-head"><span>${esc(title)}</span><button class="x" data-icon="x"></button></div><div class="modal-body"></div>${foot ? '<div class="modal-foot"></div>' : ''}</div></div>`);
  const b = $('.modal-body', m);
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  if (foot) { const f = $('.modal-foot', m); foot.forEach((x) => f.appendChild(x)); }
  hydrateIcons(m);
  const close = () => { m.remove(); onClose && onClose(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.x', m).onclick = close;
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  $('#modal-root').appendChild(m);
  return { root: m, body: b, close };
}
function button(label, cls, onClick, ic) { const b = el(`<button class="btn ${cls}">${ic ? `<i data-icon="${ic}"></i>` : ''}${esc(label)}</button>`); b.onclick = onClick; return b; }
function menu(x, y, items) {
  const root = $('#menu-root'); root.innerHTML = '';
  const m = el('<div class="menu"></div>');
  for (const it of items) {
    if (it === '-') { m.appendChild(el('<hr>')); continue; }
    const b = el(`<button>${it.icon ? `<i data-icon="${it.icon}"></i>` : ''}${esc(it.label)}</button>`);
    b.onclick = () => { root.innerHTML = ''; it.click(); };
    m.appendChild(b);
  }
  root.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { root.innerHTML = ''; document.removeEventListener('mousedown', h); } }), 0);
}
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    let done = false;
    const m = modal({
      title, body: `<p style="line-height:1.5">${esc(text)}</p>`, cls: 'small',
      foot: [button('Cancel', 'btn-dark', () => { done = true; m.close(); res(false); }), button(okLabel, danger ? 'btn-danger' : 'btn-accent', () => { done = true; m.close(); res(true); })],
      onClose: () => { if (!done) res(false); }
    });
  });
}
function promptBox(title, label, value = '') {
  return new Promise((res) => {
    let done = false;
    const body = el(`<div class="form"><div class="frow" style="grid-template-columns:1fr"><label class="fl">${esc(label)}</label><input type="text" value="${esc(value)}" spellcheck="false"></div></div>`);
    const inp = $('input', body);
    const ok = () => { done = true; m.close(); res(inp.value.trim()); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const m = modal({ title, body, cls: 'small', foot: [button('Cancel', 'btn-dark', () => { done = true; m.close(); res(null); }), button('OK', 'btn-accent', ok)], onClose: () => { if (!done) res(null); } });
    setTimeout(() => inp.focus(), 30);
  });
}

// Static first frame for GIF previews (animated only on hover -> far less CPU in the grid)
const posterCache = new Map();
async function poster(url) {
  if (posterCache.has(url)) return posterCache.get(url);
  const p = (async () => {
    const r = await fetch(url);
    const b = await r.blob();
    return createImageBitmap(b, { resizeWidth: 320, resizeQuality: 'medium' });
  })().catch(() => null);
  posterCache.set(url, p);
  return p;
}
const io = new IntersectionObserver((ents) => {
  for (const e of ents) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    const c = e.target;
    const url = c.dataset.src;
    if (!url) continue;
    if (/\.gif($|\?|%)/i.test(url) || /%2Egif/i.test(url)) {
      poster(url).then((bmp) => {
        if (!bmp) return;
        const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        c.prepend(cv);
        c.addEventListener('mouseenter', () => { if (!$('img', c)) { const im = new Image(); im.src = url; im.decoding = 'async'; c.prepend(im); } });
        c.addEventListener('mouseleave', () => { const im = $('img', c); if (im) im.remove(); });
      });
    } else {
      const im = new Image(); im.decoding = 'async'; im.loading = 'lazy'; im.src = url; c.prepend(im);
    }
  }
}, { rootMargin: '300px' });

// ---------------------------------------------------------------- boot
async function boot() {
  hydrateIcons();
  state.info = await api('app:info');
  state.settings = await api('settings:get');
  $('#tb-title').textContent = `${state.info.name} ${state.info.version}`;
  document.title = state.info.name;
  applyTheme();
  restoreUIState();
  if (state.panelHidden) document.body.classList.add('panel-hidden');
  bindChrome();
  state.wp = await api('wp:status');
  state.slot = state.wp.layout === 'per-monitor' ? (state.wp.displays.find((d) => d.primary) || state.wp.displays[0] || {}).id : state.wp.layout;
  await loadLibrary();
  switchTab(state.lastTab || 'installed');
  applyFeatureUI();
  updatePauseBtn();
  updatePlaylistStatus();
  L.on('lib:changed', async () => { await loadLibrary(); if (state.tab === 'installed') renderGrid(); checkPendingDownloads(); });
  L.on('wp:changed', (st) => { state.wp = st; updatePauseBtn(); markActive(); });
  L.on('ui:navigate', (where) => { if (where === 'settings') openSettings(); else if (where === 'updates') openSettings('updates'); });
  L.on('update:available', (r) => toast(`Update ${r.latest} is available. Open Settings › Updates to install.`));
  L.on('win:state', (s) => { const b = $('#tb-max'); b.dataset.iconDone = ''; b.dataset.icon = s.maximized ? 'restore' : 'max'; hydrateIcons($('#titlebar')); });
  setupDragDrop();
  if (!state.settings.firstRunDone) firstRun();
}

function applyTheme() {
  const a = (state.settings.theme && state.settings.theme.accent) || '#3d8bfd';
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-h', shade(a, 18));
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c).map((v) => v.toString(16).padStart(2, '0')).join('');
}

function bindChrome() {
  $('#tb-min').onclick = () => L.win.minimize();
  $('#tb-max').onclick = () => L.win.maximize();
  $('#tb-close').onclick = () => L.win.close();
  $('#tb-panel').onclick = () => { document.body.classList.toggle('panel-hidden'); state.panelHidden = document.body.classList.contains('panel-hidden'); persistUI(); };
  document.querySelectorAll('.tab[data-tab]').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $('#installed-menu-btn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 2, [
      { label: 'All wallpapers', icon: 'layers', click: () => setView('all', 'Installed') },
      { label: 'Favorites', icon: 'heart', click: () => setView('favorites', 'Favorites') },
      { label: 'Subscribed (Workshop)', icon: 'steam', click: () => setView('workshop', 'Subscribed') },
      { label: 'My wallpapers', icon: 'disk', click: () => setView('mine', 'My wallpapers') }
    ]);
  };
  $('#search').addEventListener('input', debounce(() => { state.search = $('#search').value.trim(); if (state.tab === 'installed') renderGrid(); else if (state.tab === 'workshop') { state.ws.page = 1; loadWorkshop(); } }, 250));
  $('#sort').onchange = () => {
    if (state.tab === 'workshop') { state.ws.sort = $('#sort').value; state.ws.page = 1; loadWorkshop(); }
    else { state.sort = $('#sort').value; renderGrid(); }
  };
  $('#btn-filter').onclick = () => { const f = $('#filters'); f.hidden = !f.hidden; $('#btn-filter').classList.toggle('on', !f.hidden); renderFilters(); };
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-displays').onclick = () => openDisplays();
  $('#btn-pause').onclick = async () => { state.wp = await api('wp:pause', !state.wp.paused); updatePauseBtn(); };
  $('#btn-open-wallpaper').onclick = async () => {
    const items = await safe(() => api('lib:importDialog'));
    if (items && items.length) { await afterImport(items); }
  };
  $('#btn-open-folder').onclick = async () => { const it = await safe(() => api('lib:importFolder')); if (it) await afterImport([it]); };
  $('#btn-ok').onclick = () => { state.revert = null; L.win.close(); };
  $('#btn-cancel').onclick = async () => {
    if (state.revert !== null) {
      const r = state.revert; state.revert = null;
      if (r.itemId) await api('wp:apply', r.itemId, state.slot); else await api('wp:clear', state.slot);
      toast('Reverted to the previous wallpaper');
    }
  };
  $('#pl-add').onclick = () => addToPlaylist();
  $('#pl-save').onclick = () => savePlaylist();
  $('#pl-load').onclick = () => loadPlaylistMenu();
  $('#pl-config').onclick = () => configurePlaylist();
}

/** Library view state (tab, sort, filters, panel) is saved in settings and restored on launch. */
function restoreUIState() {
  const u = (state.settings && state.settings.ui) || {};
  if (u.sort) state.sort = u.sort;
  if (u.wsSort) state.ws.sort = u.wsSort;
  const f = u.filters || {};
  for (const k of ['types', 'ratings', 'sources']) if (Array.isArray(f[k])) state.filters[k] = new Set(f[k]);
  if (typeof f.favorites === 'boolean') state.filters.favorites = f.favorites;
  if (typeof f.audio === 'boolean') state.filters.audio = f.audio;
  for (const k of ['types', 'ratings', 'tags']) if (Array.isArray((u.ws || {})[k])) state.ws[k] = new Set(u.ws[k]);
  state.panelHidden = u.panelHidden !== undefined ? !!u.panelHidden : localStorage.getItem('panelHidden') === '1';
  state.lastTab = u.tab || 'installed';
  state.uiRestored = true;
}
let persistTimer = null;
function persistUI() {
  if (!state.uiRestored) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const ui = {
      tab: state.tab, sort: state.sort, wsSort: state.ws.sort, panelHidden: !!state.panelHidden,
      filters: { types: [...state.filters.types], ratings: [...state.filters.ratings], sources: [...state.filters.sources], favorites: !!state.filters.favorites, audio: !!state.filters.audio },
      ws: { types: [...state.ws.types], ratings: [...state.ws.ratings], tags: [...state.ws.tags] }
    };
    if (JSON.stringify(ui) === JSON.stringify(state.settings.ui || {})) return;
    api('settings:set', 'ui', ui).then((st) => { state.settings = st; }).catch(() => {});
  }, 400);
}

function debounce(f, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; }

function setView(v, label) { state.view = v; $('#installed-label').textContent = label; switchTab('installed'); }

const featureOn = (n) => !state.settings || !state.settings.features || state.settings.features[n] !== false;
const TAB_FEATURE = { discover: 'workshop', workshop: 'workshop', widgets: 'widgets', rainmeter: 'rainmeter' };
/** Hides the tabs / rows of optional features that are turned off. */
function applyFeatureUI() {
  for (const [tab, f] of Object.entries(TAB_FEATURE)) { const t = $(`.tab[data-tab="${tab}"]`); if (t) t.hidden = !featureOn(f); }
  const pr = $('.playlist-row'); if (pr) pr.hidden = !featureOn('playlists');
  if (TAB_FEATURE[state.tab] && !featureOn(TAB_FEATURE[state.tab])) switchTab('installed');
}

function switchTab(tab) {
  if (TAB_FEATURE[tab] && !featureOn(TAB_FEATURE[tab])) tab = 'installed';
  state.tab = tab;
  persistUI();
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const browserTabs = ['installed', 'workshop', 'discover'];
  $('#browser').hidden = !browserTabs.includes(tab);
  $('#page-widgets').hidden = tab !== 'widgets';
  $('#page-rainmeter').hidden = tab !== 'rainmeter';
  $('#footer').hidden = !['installed'].includes(tab);
  $('#toolbar').hidden = tab === 'discover';
  const sort = $('#sort');
  if (tab === 'installed') {
    sort.innerHTML = [['name', 'Name'], ['recent', 'Date added'], ['updated', 'Last updated'], ['type', 'Type'], ['favorite', 'Favorites first']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sort.value = state.sort;
    $('#search').value = state.search;
    renderGrid();
  } else if (tab === 'workshop') {
    sort.innerHTML = [['trend', 'Trending (week)'], ['toprated', 'Top Rated'], ['subscribed', 'Most Subscribed'], ['mostrecent', 'Most Recent'], ['lastupdated', 'Last Updated']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sort.value = state.ws.sort;
    $('#search').value = state.search;
    loadWorkshop();
  } else if (tab === 'discover') {
    renderDiscover();
  } else if (tab === 'widgets') renderWidgets();
  else if (tab === 'rainmeter') renderRainmeter();
  if ($('#filters') && !$('#filters').hidden) renderFilters();
  if (browserTabs.includes(tab)) refreshDetails();
}

// ---------------------------------------------------------------- library
async function loadLibrary() { state.items = await api('lib:list'); }

function filteredItems() {
  const q = state.search.toLowerCase();
  const f = state.filters;
  let list = state.items.filter((it) => {
    if (state.view === 'favorites' && !it.favorite) return false;
    if (state.view === 'workshop' && it.kind !== 'workshop') return false;
    if (state.view === 'mine' && !['imported', 'myprojects', 'folder'].includes(it.kind)) return false;
    if (q && !(it.title.toLowerCase().includes(q) || (it.tags || []).some((t) => t.toLowerCase().includes(q)) || it.workshopid === q)) return false;
    if (f.types.size && !f.types.has(it.type)) return false;
    if (f.ratings.size && !f.ratings.has(it.contentrating || 'Everyone')) return false;
    if (f.sources.size && !f.sources.has(it.kind === 'workshop' ? 'workshop' : 'local')) return false;
    if (f.favorites && !it.favorite) return false;
    if (f.audio && !it.supportsAudio) return false;
    return true;
  });
  const by = state.sort;
  list.sort((a, b) => by === 'recent' ? b.added - a.added : by === 'updated' ? b.updated - a.updated : by === 'type' ? a.type.localeCompare(b.type) || a.title.localeCompare(b.title)
    : by === 'favorite' ? (b.favorite - a.favorite) || a.title.localeCompare(b.title) : a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  return list;
}

function activeItemIds() { return new Set((state.wp && state.wp.slots || []).map((s) => s.itemId)); }

function renderGrid() {
  persistUI();
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#pager').hidden = true;
  const list = filteredItems();
  const active = activeItemIds();
  $('#empty').hidden = list.length > 0;
  grid.hidden = list.length === 0;
  if (!list.length) {
    const s = state.info.steam || {};
    $('#empty').innerHTML = state.items.length
      ? 'No wallpapers match your search or filters.'
      : `<div><div style="font-size:18px;margin-bottom:8px">Your library is empty</div>${s.workshopDirs && s.workshopDirs.length ? '' : 'No Steam Workshop folder for Wallpaper Engine was found.<br>'}Use <b>Workshop</b> to subscribe to wallpapers, or <b>Open Wallpaper</b> to add a video, image or web page.<br>You can also drag files onto this window.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of list) {
    const c = el(`<div class="card${state.selected === it.id ? ' selected' : ''}${active.has(it.id) ? ' active' : ''}" data-id="${esc(it.id)}" title="${esc(it.title)}">
      <div class="badges">${it.approved ? `<span class="badge green">${icon('trophy')}</span>` : ''}${it.kind !== 'workshop' ? `<span class="badge blue">${icon('disk')}</span>` : ''}${it.favorite ? `<span class="badge pink">${icon('heart')}</span>` : ''}</div>
      <span class="tag-type">${esc(TYPE_LABEL[it.type] || it.type || '?')}</span>
      <div class="ti">${esc(it.title)}</div></div>`);
    if (it.preview) c.dataset.src = it.preview;
    else if (it.type === 'image' && it.entryUrl) c.dataset.src = it.entryUrl;
    c.onclick = () => selectItem(it.id, true);
    c.oncontextmenu = (e) => { e.preventDefault(); itemMenu(it, e.clientX, e.clientY); };
    frag.appendChild(c);
    if (c.dataset.src) io.observe(c);
  }
  grid.appendChild(frag);
  for (const it of list) if (!it.preview && it.type === 'video' && it.kind === 'imported') makeVideoThumb(it);
}

function markActive() {
  const active = activeItemIds();
  document.querySelectorAll('#grid .card').forEach((c) => c.classList.toggle('active', active.has(c.dataset.id)));
}

const thumbBusy = new Set();
function makeVideoThumb(it) {
  if (thumbBusy.has(it.id) || !it.entryUrl) return;
  thumbBusy.add(it.id);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'metadata'; v.src = it.entryUrl;
  v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(2, (v.duration || 2) / 3); });
  v.addEventListener('seeked', async () => {
    const cv = document.createElement('canvas');
    const s = 400 / Math.max(v.videoWidth, v.videoHeight);
    cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s);
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    await api('lib:setPreview', it.id, cv.toDataURL('image/jpeg', 0.85)).catch(() => {});
    v.removeAttribute('src'); v.load();
  }, { once: true });
  v.addEventListener('error', () => thumbBusy.delete(it.id));
}

function itemMenu(it, x, y) {
  const items = [
    { label: 'Apply', icon: 'check', click: () => applyItem(it.id) },
    { label: it.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', click: async () => { await api('lib:favorite', it.id); await loadLibrary(); renderGrid(); refreshDetails(); } },
    { label: 'Add to playlist', icon: 'list', click: () => addToPlaylist(it.id) },
    { label: 'Open in Explorer', icon: 'folder', click: () => api('lib:openFolder', it.id) }
  ];
  if (it.workshopid) items.push({ label: 'Open Workshop page', icon: 'steam', click: () => api('ws:openInSteam', it.workshopid) });
  if (it.kind === 'workshop') items.push('-', { label: 'Unsubscribe', icon: 'trash', click: () => unsubscribe(it.workshopid) });
  if (it.kind === 'imported') items.push('-', { label: 'Remove from library', icon: 'trash', click: async () => { if (await confirmBox('Remove wallpaper', `Remove "${it.title}" from your library? The original file is not deleted.`, 'Remove', true)) { await api('lib:remove', it.id); await loadLibrary(); renderGrid(); } } });
  menu(x, y, items);
}

async function selectItem(id, apply) {
  state.selected = id; state.selectedWs = null;
  document.querySelectorAll('#grid .card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  await showLocalDetails(id);
  if (apply) await applyItem(id);
}

async function applyItem(id) {
  const cur = (state.wp.slots || []).find((s) => s.id === state.slot || state.wp.layout !== 'per-monitor');
  if (state.revert === null) state.revert = { itemId: cur ? cur.itemId : null };
  const it = state.items.find((x) => x.id === id);
  if (it && it.type === 'application') { toast('Application wallpapers are not supported for safety reasons.', 'err'); return; }
  if (it && it.missingDependency) { toast('This preset needs its base wallpaper. Subscribe to it first.', 'err'); }
  state.wp = await safe(() => api('wp:apply', id, state.slot)) || state.wp;
  markActive();
  updatePlaylistStatus();
}

function updatePauseBtn() {
  const b = $('#btn-pause');
  const p = state.wp && state.wp.paused;
  b.innerHTML = `<i data-icon="${p ? 'play' : 'pause'}"></i><span>${p ? 'Resume' : 'Pause'}</span>`;
  hydrateIcons(b);
  const n = (state.wp && state.wp.slots || []).length;
  $('#status-line').textContent = n ? `${n} wallpaper${n > 1 ? 's' : ''} running${p ? ' (paused)' : ''}` : 'No wallpaper running';
}

// ---------------------------------------------------------------- details panel
function refreshDetails() {
  if (state.tab === 'installed' && state.selected) showLocalDetails(state.selected);
  else if ((state.tab === 'workshop' || state.tab === 'discover') && state.selectedWs) showWsDetails(state.selectedWs);
  else if (state.tab === 'installed') {
    const cur = (state.wp.slots || [])[0];
    if (cur) { state.selected = cur.itemId; showLocalDetails(cur.itemId); }
    else $('#details').innerHTML = `<div class="d-empty">Select a wallpaper to preview it and change its properties.</div>`;
  } else $('#details').innerHTML = `<div class="d-empty">Select a Workshop item to see its details.</div>`;
}

async function showLocalDetails(id) {
  const it = await api('lib:details', id);
  const d = $('#details');
  if (!it) { d.innerHTML = '<div class="d-empty">Wallpaper not found.</div>'; return; }
  const props = await api('wp:getProps', id);
  const ws = it.workshopid ? state.ws.cache && state.ws.cache.get(it.workshopid) : null;
  d.innerHTML = '';
  const pv = el(`<div class="pv"></div>`);
  if (it.preview) pv.appendChild(Object.assign(new Image(), { src: it.preview }));
  else if (it.type === 'image' && it.entryUrl) pv.appendChild(Object.assign(new Image(), { src: it.entryUrl }));
  else if (it.type === 'video' && it.entryUrl) { const v = Object.assign(document.createElement('video'), { src: it.entryUrl, muted: true, autoplay: true, loop: true }); pv.appendChild(v); }
  d.appendChild(pv);
  d.appendChild(el(`<div class="d-title">${esc(it.title)}</div>`));
  const tags = [...(it.tags || [])];
  if (it.supportsAudio && !tags.includes('Audio responsive')) tags.unshift('Audio responsive');
  d.appendChild(el(`<div class="d-meta">${esc(TYPE_LABEL[it.type] || it.type)}${it.size ? ' &nbsp;' + fmtSize(it.size) : ''}</div>`));
  d.appendChild(el(`<div class="chips">${[...tags, it.contentrating].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`));
  const acts = el('<div class="d-actions"></div>');
  acts.appendChild(button(it.favorite ? 'Favorited' : 'Favorite', 'btn-dark small', async () => { await api('lib:favorite', id); await loadLibrary(); renderGrid(); showLocalDetails(id); }, 'heart'));
  acts.appendChild(button('Folder', 'btn-dark small', () => api('lib:openFolder', id), 'folder'));
  if (it.workshopid) acts.appendChild(button('Steam', 'btn-dark small', () => api('ws:openInSteam', it.workshopid), 'steam'));
  d.appendChild(acts);
  if (it.kind === 'workshop') {
    const row = el('<div class="d-actions"></div>');
    row.appendChild(button('Unsubscribe', 'btn-danger', () => unsubscribe(it.workshopid), 'x'));
    d.appendChild(row);
  }
  if (it.missingDependency) d.appendChild(el(`<div class="banner">This is a preset of another wallpaper that is not installed. Subscribe to the original wallpaper to use it.</div>`));
  d.appendChild(renderProps(it, props));
  if (it.description) d.appendChild(el(`<div class="desc">${esc(it.description.replace(/\[\/?[a-z0-9=*]+\]/gi, ''))}</div>`));
  void ws;
}

const LABELS = { ui_browse_properties_scheme_color: 'Scheme color', ui_browse_properties_alignment: 'Alignment', ui_browse_properties_play_rate: 'Playback rate' };
function labelFor(key, p) {
  let t = p.text || key;
  if (LABELS[t]) return LABELS[t];
  if (/^ui_/.test(t)) t = t.replace(/^ui_(editor_|browse_)?properties_/, '').replace(/_/g, ' ');
  if (/<[a-z]/i.test(t)) { const tmp = document.createElement('div'); tmp.innerHTML = t; t = tmp.textContent; }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Evaluates project.json "condition" expressions such as `clock.value == true && mode.value != 2`. */
function evalCondition(expr, values) {
  if (!expr) return true;
  const tokens = String(expr).match(/\s*([A-Za-z_]\w*\.value|[A-Za-z_]\w*|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|==|!=|<=|>=|&&|\|\||[<>!()])/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== String(expr).replace(/\s/g, '')) return true;
  let js = '';
  for (let t of tokens) {
    t = t.trim();
    const m = t.match(/^([A-Za-z_]\w*)\.value$/);
    if (m) js += JSON.stringify(values[m[1]] ?? null) + ' ';
    else if (t === 'true' || t === 'false' || t === 'null') js += t + ' ';
    else if (/^[A-Za-z_]/.test(t)) return true;
    else js += t + ' ';
  }
  try { return !!new Function('return (' + js.replace(/==/g, '==').replace(/!=/g, '!=') + ')')(); } catch { return true; }
}

function renderProps(it, props) {
  const wrap = el(`<div class="props"><h4><span>Properties</span></h4></div>`);
  const reset = button('Reset', 'btn-dark small', async () => { await api('wp:resetProps', it.id); showLocalDetails(it.id); }, 'refresh');
  $('h4', wrap).appendChild(reset);
  const entries = Object.entries(props || {}).filter(([, p]) => p && p.type);
  // Built-in display properties (like Wallpaper Engine's): every wallpaper gets these.
  for (const b of builtinProps(it, props)) entries.push(b);
  entries.sort((a, b) => (a[1].order ?? a[1].index ?? 0) - (b[1].order ?? b[1].index ?? 0));
  const values = {};
  for (const [k, p] of entries) values[k] = p.value;
  const rows = [];
  const save = debounce((k, v) => api('wp:setProps', it.id, { [k]: v }), 120);
  const refreshConds = () => { for (const r of rows) r.el.hidden = !evalCondition(r.p.condition, values); };
  for (const [k, p] of entries) {
    const lbl = esc(labelFor(k, p));
    let row;
    const set = (v) => { values[k] = v; save(k, v); refreshConds(); };
    switch (p.type) {
      case 'bool': {
        row = el(`<div class="prop"><span class="lbl">${lbl}</span><label class="switch"><input type="checkbox" ${p.value ? 'checked' : ''}><span></span></label></div>`);
        $('input', row).onchange = (e) => set(e.target.checked);
        break;
      }
      case 'slider': {
        const min = Number(p.min ?? 0), max = Number(p.max ?? 100);
        const step = p.step ? Number(p.step) : p.fraction ? (max - min) / 100 : 1;
        row = el(`<div class="prop"><span class="lbl">${lbl}</span><div class="rng"><input type="range" min="${min}" max="${max}" step="${step}" value="${Number(p.value)}"><span>${fmtNum(p.value)}</span></div></div>`);
        $('input', row).oninput = (e) => { $('span', $('.rng', row)).textContent = fmtNum(e.target.value); set(Number(e.target.value)); };
        break;
      }
      case 'color': {
        row = el(`<div class="prop"><span class="lbl">${lbl}</span><input type="color" value="${weToHex(p.value)}"></div>`);
        $('input', row).oninput = (e) => set(hexToWe(e.target.value));
        break;
      }
      case 'combo': {
        row = el(`<div class="prop"><span class="lbl">${lbl}</span><select>${(p.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(p.value) ? 'selected' : ''}>${esc(labelFor('', { text: o.label }))}</option>`).join('')}</select></div>`);
        $('select', row).onchange = (e) => set(e.target.value);
        break;
      }
      case 'textinput': {
        row = el(`<div class="prop"><span class="lbl">${lbl}</span><input type="text" value="${esc(p.value)}" spellcheck="false"></div>`);
        $('input', row).oninput = (e) => set(e.target.value);
        break;
      }
      case 'text': {
        row = el(`<div class="prop full"><span class="lbl muted">${lbl}</span></div>`);
        break;
      }
      default: continue;
    }
    rows.push({ el: row, p });
    wrap.appendChild(row);
  }
  refreshConds();
  wrap.appendChild(renderPresets(it, values));
  return wrap;
}

function builtinProps(it, props) {
  const v = (k, d) => (props['_ae_' + k] && props['_ae_' + k].value !== undefined ? props['_ae_' + k].value : d);
  const t = it.type, out = [];
  const add = (k, p) => out.push(['_ae_' + k, { order: 1000 + out.length, value: v(k, p.def), ...p }]);
  if (t !== 'image') add('volume', { type: 'slider', text: 'Volume', min: 0, max: 100, step: 1, def: 100 });
  if (t !== 'image') add('rate', { type: 'slider', text: 'Playback rate', min: 0.25, max: 2, step: 0.05, def: 1 });
  if (t === 'video' || t === 'image') add('align', { type: 'combo', text: 'Alignment', def: 'cover', options: [{ label: 'Cover', value: 'cover' }, { label: 'Fit', value: 'contain' }, { label: 'Stretch', value: 'stretch' }] });
  add('flip', { type: 'bool', text: 'Flip', def: false });
  if (t !== 'web') add('filter', { type: 'combo', text: 'Image filter', def: 'smooth', options: [{ label: 'Smooth', value: 'smooth' }, { label: 'Pixelated', value: 'pixel' }] });
  add('coloropts', { type: 'bool', text: 'Show color options', def: false });
  const c = '_ae_coloropts.value == true';
  add('brightness', { type: 'slider', text: 'Brightness', min: 0, max: 200, step: 1, def: 100, condition: c });
  add('contrast', { type: 'slider', text: 'Contrast', min: 0, max: 200, step: 1, def: 100, condition: c });
  add('saturation', { type: 'slider', text: 'Saturation', min: 0, max: 200, step: 1, def: 100, condition: c });
  add('hue', { type: 'slider', text: 'Hue', min: -180, max: 180, step: 1, def: 0, condition: c });
  return out;
}

/** "Your Presets": load / save / apply-to-all / share JSON / reset, like Wallpaper Engine. */
function renderPresets(it, values) {
  const box = el(`<div class="presets"><h4><span>Your Presets</span></h4>
    <div class="prow"><select class="psel"></select><button class="btn btn-dark small pload">Load</button><button class="btn btn-dark small pdel" title="Delete preset">✕</button></div>
    <div class="prow"><input type="text" class="pname" placeholder="Preset name" spellcheck="false"><button class="btn btn-dark small psave">Save</button></div>
    <div class="prow wrapbtns"><button class="btn btn-dark small pall">Apply to all wallpapers</button><button class="btn btn-dark small pshare">Share JSON</button><button class="btn btn-dark small pimport">Paste JSON</button><button class="btn btn-dark small preset">Reset</button></div></div>`);
  const sel = $('.psel', box);
  const fill = () => {
    const list = state.settings.presets || [];
    sel.innerHTML = list.length ? list.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('') : '<option value="">No saved presets</option>';
  };
  fill();
  const saveList = async (list) => { state.settings = await api('settings:set', 'presets', list); fill(); };
  const loadProps = async (p) => {
    const known = Object.fromEntries(Object.entries(p || {}).filter(([k]) => k in values));
    if (!Object.keys(known).length) return toast('That preset has no matching properties for this wallpaper', 'err');
    await api('wp:setProps', it.id, known); showLocalDetails(it.id); toast('Preset loaded');
  };
  $('.pload', box).onclick = () => { const p = (state.settings.presets || [])[Number(sel.value)]; if (p) loadProps(p.props); };
  $('.pdel', box).onclick = () => { const list = [...(state.settings.presets || [])]; if (sel.value === '') return; list.splice(Number(sel.value), 1); saveList(list); };
  $('.psave', box).onclick = () => {
    const name = $('.pname', box).value.trim() || (it.title + ' preset');
    const list = (state.settings.presets || []).filter((p) => p.name !== name);
    list.push({ name, props: { ...values } }); saveList(list); $('.pname', box).value = ''; toast('Preset saved');
  };
  $('.pall', box).onclick = async () => { await api('wp:applyAll', it.id); state.settings = await api('settings:get'); toast('Display settings applied to all wallpapers'); };
  $('.pshare', box).onclick = async () => { try { await api('clip:write', JSON.stringify(values, null, 2)); toast('Preset JSON copied to clipboard'); } catch { toast('Clipboard not available', 'err'); } };
  $('.pimport', box).onclick = async () => { try { const p = JSON.parse(await api('clip:read')); loadProps(p); } catch { toast('Clipboard does not contain preset JSON', 'err'); } };
  $('.preset', box).onclick = async () => { await api('wp:resetProps', it.id); showLocalDetails(it.id); };
  return box;
}
function fmtNum(v) { const n = Number(v); return Number.isInteger(n) ? String(n) : n.toFixed(2); }
function weToHex(v) {
  const p = String(v || '1 1 1').trim().split(/\s+/).map(Number);
  const s = p.some((x) => x > 1) ? 1 : 255;
  return '#' + p.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(255, (x || 0) * s))).toString(16).padStart(2, '0')).join('');
}
function hexToWe(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => (x / 255).toFixed(5)).join(' '); }

// ---------------------------------------------------------------- filters
function renderFilters() {
  const f = $('#filters');
  if (f.hidden) return;
  if (state.tab === 'workshop') {
    const ws = state.ws;
    const types = ['Scene', 'Video', 'Web', 'Application'];
    const ratings = ['Everyone', 'Questionable', 'Mature'];
    const genres = ['Abstract', 'Animal', 'Anime', 'Cartoon', 'CGI', 'Cyberpunk', 'Fantasy', 'Game', 'Girls', 'Landscape', 'Medieval', 'Memes', 'MMD', 'Music', 'Nature', 'Pixel art', 'Relaxing', 'Retro', 'Sci-Fi', 'Sports', 'Technology', 'Television', 'Vehicle'];
    const misc = ['Audio responsive', 'Customizable', 'Approved'];
    f.innerHTML = `<h4>Type</h4>${types.map((t) => cb('wt', t, ws.types.has(t))).join('')}<h4>Age rating</h4>${ratings.map((t) => cb('wr', t, ws.ratings.has(t))).join('')}<h4>Misc</h4>${misc.map((t) => cb('wg', t, ws.tags.has(t))).join('')}<h4>Genre</h4>${genres.map((t) => cb('wg', t, ws.tags.has(t))).join('')}`;
    f.querySelectorAll('input').forEach((i) => (i.onchange = () => {
      const set = i.name === 'wt' ? ws.types : i.name === 'wr' ? ws.ratings : ws.tags;
      if (i.checked) set.add(i.value); else set.delete(i.value);
      if (i.name === 'wr' && !ws.ratings.size) { ws.ratings.add('Everyone'); renderFilters(); }
      ws.page = 1; loadWorkshop();
    }));
    return;
  }
  const s = state.filters;
  f.innerHTML = `<h4>Type</h4>${['scene', 'video', 'web', 'image', 'preset'].map((t) => cb('t', t, s.types.has(t), TYPE_LABEL[t])).join('')}
    <h4>Age rating</h4>${['Everyone', 'Questionable', 'Mature'].map((t) => cb('r', t, s.ratings.has(t))).join('')}
    <h4>Source</h4>${cb('s', 'workshop', s.sources.has('workshop'), 'Steam Workshop')}${cb('s', 'local', s.sources.has('local'), 'Local / imported')}
    <h4>Other</h4>${cb('o', 'favorites', s.favorites, 'Favorites only')}${cb('o', 'audio', s.audio, 'Audio responsive')}`;
  f.querySelectorAll('input').forEach((i) => (i.onchange = () => {
    if (i.name === 'o') s[i.value] = i.checked;
    else { const set = i.name === 't' ? s.types : i.name === 'r' ? s.ratings : s.sources; if (i.checked) set.add(i.value); else set.delete(i.value); }
    renderGrid();
  }));
}
function cb(name, value, checked, label) { return `<label><input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}>${esc(label || value)}</label>`; }

// ---------------------------------------------------------------- workshop
let wsReq = 0;
async function loadWorkshop() {
  persistUI();
  const grid = $('#grid');
  const ws = state.ws;
  const req = ++wsReq;
  grid.hidden = false;
  grid.innerHTML = '';
  $('#empty').hidden = false;
  $('#empty').innerHTML = 'Loading Steam Workshop…';
  $('#pager').hidden = true;
  ws.loggedIn = await api('ws:loggedIn').catch(() => false);
  try {
    const r = await api('ws:browse', { page: ws.page, sort: ws.sort, search: state.search, types: [...ws.types], tags: [...ws.tags], ratings: [...ws.ratings] });
    if (req !== wsReq || state.tab !== 'workshop') return;
    ws.items = r.items; ws.pages = r.pages || 1;
    ws.cache = ws.cache || new Map();
    for (const i of r.items) ws.cache.set(i.id, i);
    renderWsGrid(grid, r.items);
    $('#empty').hidden = r.items.length > 0;
    if (!r.items.length) $('#empty').textContent = 'No results.';
    renderPager();
  } catch (e) {
    if (req !== wsReq) return;
    $('#empty').innerHTML = `Could not reach the Steam Workshop.<br><span class="muted">${esc(e.message)}</span>`;
  }
}

function renderWsGrid(grid, items) {
  const installed = new Map(state.items.filter((i) => i.workshopid).map((i) => [i.workshopid, i]));
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const inst = installed.get(it.id);
    const c = el(`<div class="card${state.selectedWs === it.id ? ' selected' : ''}" data-ws="${esc(it.id)}" title="${esc(it.title)}">
      <div class="badges">${it.tags.includes('Approved') ? `<span class="badge green">${icon('trophy')}</span>` : ''}${inst ? `<span class="badge blue">${icon('disk')}</span>` : ''}</div>
      ${it.type ? `<span class="tag-type">${esc(TYPE_LABEL[it.type] || it.type)}</span>` : ''}
      <div class="ti">${esc(it.title)}</div>${state.ws.pending.has(it.id) ? '<div class="dl"></div>' : ''}</div>`);
    if (it.preview) { c.dataset.src = it.preview; io.observe(c); }
    c.onclick = () => { state.selectedWs = it.id; grid.querySelectorAll('.card').forEach((x) => x.classList.toggle('selected', x === c)); showWsDetails(it.id); };
    c.ondblclick = () => { if (inst) { switchTab('installed'); selectItem(inst.id, true); } else subscribe(it.id); };
    frag.appendChild(c);
  }
  grid.appendChild(frag);
}

function renderPager() {
  const p = $('#pager'); const ws = state.ws;
  p.hidden = ws.pages <= 1 && ws.page <= 1;
  p.innerHTML = '';
  const add = (label, page, cls = '') => { const b = el(`<button class="${cls}">${label}</button>`); b.onclick = () => { ws.page = page; loadWorkshop(); }; p.appendChild(b); };
  if (ws.page > 1) add('&laquo;', ws.page - 1, 'arrow');
  const start = Math.max(1, ws.page - 2), end = Math.min(ws.pages, start + 4);
  for (let i = start; i <= end; i++) add(String(i), i, i === ws.page ? 'cur' : '');
  if (end < ws.pages) { p.appendChild(el('<span class="muted">…</span>')); add(String(ws.pages), ws.pages); }
  if (ws.page < ws.pages) add('&raquo;', ws.page + 1, 'arrow');
}

async function showWsDetails(id) {
  const ws = state.ws;
  let it = ws.cache && ws.cache.get(id);
  if (!it) { const r = await api('ws:details', [id]).catch(() => []); it = r[0]; if (it) { ws.cache = ws.cache || new Map(); ws.cache.set(id, it); } }
  const d = $('#details');
  if (!it) { d.innerHTML = '<div class="d-empty">Item not available.</div>'; return; }
  const inst = state.items.find((x) => x.workshopid === id);
  d.innerHTML = '';
  const pv = el('<div class="pv"></div>');
  if (it.preview) pv.appendChild(Object.assign(new Image(), { src: it.preview }));
  d.appendChild(pv);
  d.appendChild(el(`<div class="d-title">${esc(it.title)}</div>`));
  d.appendChild(el(`<div class="d-meta">${esc(TYPE_LABEL[it.type] || it.type || '')} ${fmtSize(it.size)}<br><span class="muted">${it.subscriptions.toLocaleString()} subscribers · ${it.favorited.toLocaleString()} favorites</span></div>`));
  d.appendChild(el(`<div class="chips">${it.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`));
  const row = el('<div class="d-actions"></div>');
  if (inst) {
    row.appendChild(button('Apply', 'btn-accent', () => { switchTab('installed'); selectItem(inst.id, true); }, 'check'));
    row.appendChild(button('Unsubscribe', 'btn-danger', () => unsubscribe(id), 'x'));
  } else if (ws.pending.has(id)) {
    row.appendChild(button('Downloading in Steam…', 'btn-dark', () => {}, 'refresh'));
  } else {
    row.appendChild(button('Subscribe', 'btn-accent', () => subscribe(id), 'plus'));
  }
  d.appendChild(row);
  const row2 = el('<div class="d-actions"></div>');
  row2.appendChild(button('Open in Steam', 'btn-dark small', () => api('ws:openInSteam', id), 'steam'));
  row2.appendChild(button('Web page', 'btn-dark small', () => api('shell:open', it.url), 'external'));
  d.appendChild(row2);
  if (!state.info.steam || !state.info.steam.weOwned) d.appendChild(el(`<div class="banner">Steam only downloads Wallpaper Engine Workshop items for accounts that own Wallpaper Engine.</div>`));
  if (it.description) d.appendChild(el(`<div class="desc">${esc(it.description.replace(/\[\/?[a-z0-9=*]+\]/gi, ''))}</div>`));
}

async function subscribe(id) {
  const ws = state.ws;
  if (!(await api('ws:loggedIn').catch(() => false))) {
    const ok = await confirmBox('Sign in to Steam', 'To subscribe from inside Astral Engine, sign in to Steam Community once. You can also open the item in the Steam client and press Subscribe there.', 'Sign in');
    if (!ok) { api('ws:openInSteam', id); return; }
    const logged = await api('ws:login');
    if (!logged) { toast('Not signed in. Opening the item in Steam instead.'); api('ws:openInSteam', id); return; }
  }
  const r = await safe(() => api('ws:subscribe', id));
  if (r) {
    ws.pending.set(id, Date.now());
    toast('Subscribed. Steam is downloading the wallpaper; it will appear in Installed when ready.', 'ok');
    if (state.selectedWs === id) showWsDetails(id);
    if (state.tab === 'workshop') { const c = document.querySelector(`[data-ws="${id}"]`); if (c && !$('.dl', c)) c.appendChild(el('<div class="dl"></div>')); }
  }
}

async function unsubscribe(wid) {
  if (!wid) return;
  if (!(await confirmBox('Unsubscribe', 'Unsubscribe from this wallpaper? Steam will remove its files.', 'Unsubscribe', true))) return;
  if (!(await api('ws:loggedIn').catch(() => false))) {
    const go = await confirmBox('Sign in to Steam', 'Sign in to Steam Community to unsubscribe from here, or use the Steam client.', 'Sign in');
    if (!go || !(await api('ws:login'))) { api('ws:openInSteam', wid); return; }
  }
  const r = await safe(() => api('ws:unsubscribe', wid), 'Unsubscribed. Steam will remove the files shortly.');
  if (r && state.tab === 'workshop') showWsDetails(wid);
}

function checkPendingDownloads() {
  for (const [id] of state.ws.pending) {
    const it = state.items.find((x) => x.workshopid === id);
    if (it) { state.ws.pending.delete(id); toast(`"${it.title}" is ready.`, 'ok'); }
  }
}

// ---------------------------------------------------------------- discover
async function renderDiscover() {
  const grid = $('#grid');
  grid.hidden = true; $('#pager').hidden = true;
  const e = $('#empty'); e.hidden = false;
  e.style.display = 'block';
  e.className = 'disc';
  e.innerHTML = '<div class="muted">Loading…</div>';
  const sections = [['Trending this week', { sort: 'trend' }], ['Top rated', { sort: 'toprated' }], ['Most recent', { sort: 'mostrecent' }], ['Scenes', { sort: 'trend', types: ['Scene'] }], ['Videos', { sort: 'trend', types: ['Video'] }], ['Relaxing', { sort: 'toprated', tags: ['Relaxing'] }]];
  try {
    if (!state.disc) {
      state.disc = await Promise.all(sections.map(([, q]) => api('ws:browse', { page: 1, ratings: ['Everyone'], ...q }).catch(() => ({ items: [] }))));
    }
    if (state.tab !== 'discover') return;
    e.innerHTML = '';
    state.ws.cache = state.ws.cache || new Map();
    sections.forEach(([title], i) => {
      const items = (state.disc[i] || {}).items || [];
      if (!items.length) return;
      items.forEach((x) => state.ws.cache.set(x.id, x));
      e.appendChild(el(`<h3>${esc(title)}</h3>`));
      const row = el('<div class="row"></div>');
      renderWsGrid(row, items.slice(0, 20));
      e.appendChild(row);
    });
    if (!e.children.length) e.innerHTML = 'Could not load the Workshop. Check your internet connection.';
  } catch (err) { e.textContent = err.message; }
}
const _sw = switchTab;
// reset discover container styles when leaving
switchTab = function (t) { const e = $('#empty'); e.className = 'empty'; e.style.display = ''; _sw(t); }; // eslint-disable-line no-func-assign

// ---------------------------------------------------------------- widgets page
async function renderWidgets() {
  const page = $('#page-widgets');
  const [types, list, displays] = [await api('widgets:types'), await api('widgets:list'), (state.wp && state.wp.displays) || []];
  page.innerHTML = `<h2>Desktop widgets</h2><div class="banner">Widgets sit on your desktop above the wallpaper. Unlock a widget to drag or resize it; lock it to keep it in place. Lock with "click-through" so clicks pass to the desktop.</div>
    <div class="row-flex" style="margin-bottom:8px"><span class="muted">Add to display</span><select class="select" id="wd-display" style="min-width:200px">${displays.map((d, i) => `<option value="${esc(d.id)}">${i + 1}. ${esc(d.label)}${d.primary ? ' (primary)' : ''}</option>`).join('')}</select>
    <div class="grow"></div><button class="btn btn-dark" id="wd-hide"><i data-icon="eye"></i>Show / hide all</button></div>
    <div class="tiles" id="wd-types"></div><h3>Your widgets</h3><div class="list" id="wd-list"></div>`;
  hydrateIcons(page);
  const tiles = $('#wd-types', page);
  for (const t of types) {
    const tile = el(`<div class="tile"><div class="row-flex"><i data-icon="${widgetIcon(t.id)}"></i><span class="ti-name">${esc(t.name)}</span></div><span class="ti-sub">Click to add</span></div>`);
    tile.onclick = async () => { await safe(() => api('widgets:add', t.id, $('#wd-display').value), `${t.name} added`); renderWidgets(); };
    tiles.appendChild(tile);
  }
  let visible = true;
  $('#wd-hide', page).onclick = async () => { visible = !visible; await api('widgets:visible', visible); };
  const ul = $('#wd-list', page);
  if (!list.length) ul.appendChild(el('<div class="muted">No widgets yet. Pick one above.</div>'));
  for (const w of list) {
    const t = types.find((x) => x.id === w.type) || { name: w.type };
    const li = el(`<div class="li"><i data-icon="${widgetIcon(w.type)}"></i><div class="li-main"><div class="li-title">${esc(t.name)}</div><div class="li-sub">${Math.round(w.w)}×${Math.round(w.h)} at ${Math.round(w.x)}, ${Math.round(w.y)}</div></div></div>`);
    const lock = button(w.locked ? 'Locked' : 'Unlocked', 'btn-dark small', async () => { await api('widgets:update', w.id, { locked: !w.locked }); renderWidgets(); }, w.locked ? 'lock' : 'unlock');
    const ct = el(`<label class="row-flex" title="Clicks go through to the desktop when locked"><span class="muted" style="font-size:12px">Click-through</span><label class="switch"><input type="checkbox" ${w.clickThrough ? 'checked' : ''}><span></span></label></label>`);
    $('input', ct).onchange = (e) => api('widgets:update', w.id, { clickThrough: e.target.checked, locked: e.target.checked ? true : w.locked }).then(renderWidgets);
    li.appendChild(ct);
    li.appendChild(lock);
    li.appendChild(button('Settings', 'btn-dark small', () => widgetSettings(w), 'gear'));
    li.appendChild(button('', 'btn-danger small icon-btn', async () => { await api('widgets:remove', w.id); renderWidgets(); }, 'trash'));
    ul.appendChild(li);
  }
  hydrateIcons(page);
}
function widgetIcon(t) { return ({ clock: 'info', analog: 'refresh', calendar: 'list', sysmon: 'bolt', weather: 'globe', notes: 'edit', visualizer: 'audio', battery: 'bolt', countdown: 'refresh', photo: 'layers', quote: 'info' })[t] || 'widgets'; }

function widgetSettings(w) {
  const o = w.options || {};
  const extra = {
    clock: `<div class="frow"><span class="fl">24-hour clock</span><input type="checkbox" data-k="h24" ${o.h24 !== false ? 'checked' : ''}></div><div class="frow"><span class="fl">Show seconds</span><input type="checkbox" data-k="seconds" ${o.seconds ? 'checked' : ''}></div><div class="frow"><span class="fl">Show date</span><input type="checkbox" data-k="date" ${o.date !== false ? 'checked' : ''}></div>`,
    analog: `<div class="frow"><span class="fl">Show seconds hand</span><input type="checkbox" data-k="seconds" ${o.seconds !== false ? 'checked' : ''}></div>`,
    weather: `<div class="frow"><span class="fl">City</span><input type="text" data-k="city" value="${esc(o.city || '')}" placeholder="e.g. Dhaka"></div><div class="frow"><span class="fl">Units</span><select data-k="units"><option value="c" ${o.units !== 'f' ? 'selected' : ''}>Celsius</option><option value="f" ${o.units === 'f' ? 'selected' : ''}>Fahrenheit</option></select></div>`,
    countdown: `<div class="frow"><span class="fl">Title</span><input type="text" data-k="title" value="${esc(o.title || 'New Year')}"></div><div class="frow"><span class="fl">Date & time</span><input type="text" data-k="target" value="${esc(o.target || '')}" placeholder="2027-01-01 00:00"></div>`,
    notes: `<div class="frow"><span class="fl">Note color</span><input type="color" data-k="noteColor" value="${esc(o.noteColor || '#f7e26b')}"></div>`,
    visualizer: `<div class="frow"><span class="fl">Bars</span><input type="number" data-k="bars" min="8" max="64" value="${o.bars || 48}"></div>`,
    quote: `<div class="frow"><span class="fl">Custom quotes (one per line)</span><input type="text" data-k="quotes" value="${esc(o.quotes || '')}" placeholder="Leave empty for built-in quotes"></div>`
  }[w.type] || '';
  const body = el(`<div class="form">
    <div class="frow"><span class="fl">Style</span><select data-k="theme"><option value="glass" ${o.theme === 'glass' ? 'selected' : ''}>Glass</option><option value="dark" ${o.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${o.theme === 'light' ? 'selected' : ''}>Light</option><option value="none" ${o.theme === 'none' ? 'selected' : ''}>Text only</option></select></div>
    <div class="frow"><span class="fl">Accent color</span><input type="color" data-k="accent" value="${esc(o.accent || '#3d8bfd')}"></div>
    <div class="frow"><span class="fl">Opacity</span><input type="range" min="0.2" max="1" step="0.05" data-k="opacity" value="${o.opacity ?? 0.85}"></div>
    <div class="frow"><span class="fl">Size</span><input type="range" min="0.6" max="2" step="0.05" data-k="scale" value="${o.scale ?? 1}"></div>
    ${extra}
    ${w.type === 'photo' ? '<div class="frow"><span class="fl">Picture</span><button class="btn btn-dark" id="pick">Choose image…</button></div>' : ''}
  </div>`);
  const m = modal({ title: 'Widget settings', body, cls: 'small', foot: [button('Done', 'btn-accent', () => m.close())] });
  body.querySelectorAll('[data-k]').forEach((inp) => {
    const ev = inp.type === 'range' || inp.type === 'color' || inp.type === 'text' ? 'input' : 'change';
    inp.addEventListener(ev, debounce(() => {
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' || inp.type === 'number' ? Number(inp.value) : inp.value;
      api('widgets:update', w.id, { options: { [inp.dataset.k]: v } });
      w.options = { ...w.options, [inp.dataset.k]: v };
    }, 150));
  });
  const pick = $('#pick', body);
  if (pick) pick.onclick = async () => { const p = await api('widgets:pickPhoto'); if (p) { await api('widgets:update', w.id, { options: { photo: p } }); toast('Picture set', 'ok'); } };
}

// ---------------------------------------------------------------- rainmeter page
async function renderRainmeter() {
  const page = $('#page-rainmeter');
  page.innerHTML = '<div class="muted">Checking Rainmeter…</div>';
  const st = await api('rm:status');
  if (!st.installed) {
    page.innerHTML = `<h2>Rainmeter</h2><div class="banner">Rainmeter is not installed. Astral Engine works together with Rainmeter so you can load, unload and switch skins and layouts from here, install <span class="kbd">.rmskin</span> packages, and keep your skins on top of live wallpapers.</div>
      <div class="row-flex"><button class="btn btn-accent" id="rm-dl"><i data-icon="external"></i>Download Rainmeter</button><button class="btn btn-dark" id="rm-pick"><i data-icon="folder"></i>I installed it somewhere else…</button><button class="btn btn-dark" id="rm-re"><i data-icon="refresh"></i>Check again</button></div>`;
    hydrateIcons(page);
    $('#rm-dl').onclick = () => api('shell:open', st.downloadUrl);
    $('#rm-pick').onclick = async () => { await api('rm:pickExe'); renderRainmeter(); };
    $('#rm-re').onclick = () => renderRainmeter();
    return;
  }
  const [skins, layouts] = [await api('rm:skins'), await api('rm:layouts')];
  page.innerHTML = `<h2>Rainmeter <span class="status-pill ${st.running ? 'ok' : 'off'}">${st.running ? 'Running' : 'Not running'}</span></h2>
    <div class="row-flex" style="margin-bottom:10px">
      <button class="btn btn-accent" id="rm-refresh"><i data-icon="refresh"></i>${st.running ? 'Refresh all' : 'Start Rainmeter'}</button>
      <button class="btn btn-dark" id="rm-manage"><i data-icon="gear"></i>Manage</button>
      <button class="btn btn-dark" id="rm-install"><i data-icon="plus"></i>Install .rmskin</button>
      <button class="btn btn-dark" id="rm-folder"><i data-icon="folder"></i>Skins folder</button>
      <button class="btn btn-dark" id="rm-get"><i data-icon="globe"></i>Find skins</button>
      <div class="grow"></div>
      ${layouts.length ? `<select class="select" id="rm-layout"><option value="">Load layout…</option>${layouts.map((l) => `<option>${esc(l)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="search" style="width:100%;margin-bottom:10px"><input id="rm-search" type="text" placeholder="Search skins" spellcheck="false"><i data-icon="search"></i></div>
    <div class="list" id="rm-list"></div>`;
  hydrateIcons(page);
  $('#rm-refresh').onclick = async () => { await safe(() => api('rm:refresh')); setTimeout(renderRainmeter, 1200); };
  $('#rm-manage').onclick = () => safe(() => api('rm:manage'));
  $('#rm-install').onclick = () => safe(() => api('rm:install'));
  $('#rm-folder').onclick = () => api('rm:openSkins');
  $('#rm-get').onclick = () => api('shell:open', 'https://www.deviantart.com/rainmeter');
  const lay = $('#rm-layout');
  if (lay) lay.onchange = async () => { if (lay.value) { await safe(() => api('rm:loadLayout', lay.value), 'Layout loaded'); setTimeout(renderRainmeter, 1500); } };
  const draw = () => {
    const q = ($('#rm-search').value || '').toLowerCase();
    const list = $('#rm-list');
    list.innerHTML = '';
    const shown = skins.filter((s) => !q || (s.config + s.name + s.author).toLowerCase().includes(q));
    if (!shown.length) list.appendChild(el(`<div class="muted">${skins.length ? 'No skins match.' : 'No skins found in ' + esc(st.skinsDir)}</div>`));
    for (const s of shown) {
      const li = el(`<div class="li"><div class="li-main"><div class="li-title">${esc(s.name)} <span class="muted" style="font-weight:400">— ${esc(s.config)}</span></div><div class="li-sub">${esc([s.author && 'by ' + s.author, s.version, s.info].filter(Boolean).join(' · ') || s.files.join(', '))}</div></div></div>`);
      const sel = el(`<select class="select" style="min-width:150px;height:28px">${s.files.map((f) => `<option ${f === s.activeFile ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>`);
      li.appendChild(sel);
      const sw = el(`<label class="switch" title="Load / unload"><input type="checkbox" ${s.active ? 'checked' : ''}><span></span></label>`);
      $('input', sw).onchange = async (e) => {
        if (e.target.checked) await safe(() => api('rm:activate', s.config, sel.value)); else await safe(() => api('rm:deactivate', s.config));
        s.active = e.target.checked; s.activeFile = sel.value;
      };
      sel.onchange = async () => { if (s.active) await safe(() => api('rm:activate', s.config, sel.value)); };
      li.appendChild(sw);
      li.appendChild(button('', 'btn-dark small icon-btn', () => safe(() => api('rm:edit', s.config, sel.value)), 'edit'));
      list.appendChild(li);
    }
    hydrateIcons(list);
  };
  $('#rm-search').oninput = draw;
  draw();
}

// ---------------------------------------------------------------- displays
async function openDisplays() {
  state.wp = await api('wp:status');
  const st = state.wp;
  const body = el(`<div><div class="monitors" id="mons"></div>
    <div class="form"><div class="frow"><span class="fl">Wallpaper layout<div class="fd">How wallpapers are placed across your monitors</div></span>
    <select id="layout"><option value="per-monitor">Individual wallpaper per display</option><option value="clone">Same wallpaper on every display</option><option value="span">Stretch one wallpaper across all displays</option></select></div></div>
    <div class="row-flex" style="margin-top:12px" id="mon-actions"></div></div>`);
  const m = modal({ title: 'Displays', body, foot: [button('Close', 'btn-accent', () => m.close())] });
  $('#layout', body).value = st.layout;
  $('#layout', body).onchange = async (e) => { await api('settings:set', 'wallpaper.layout', e.target.value); state.settings = await api('settings:get'); state.wp = await api('wp:status'); state.slot = e.target.value === 'per-monitor' ? state.wp.displays[0].id : e.target.value; draw(); };
  const draw = () => {
    const mons = $('#mons', body); mons.innerHTML = '';
    const ds = state.wp.displays;
    const minX = Math.min(...ds.map((d) => d.bounds.x)), minY = Math.min(...ds.map((d) => d.bounds.y));
    const maxX = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width)), maxY = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
    const sc = Math.min((mons.clientWidth || 800) / (maxX - minX), 200 / (maxY - minY)) * 0.9;
    const ox = ((mons.clientWidth || 800) - (maxX - minX) * sc) / 2, oy = (220 - (maxY - minY) * sc) / 2;
    ds.forEach((d, i) => {
      const key = state.wp.layout === 'per-monitor' ? d.id : state.wp.layout;
      const slot = state.wp.slots.find((s) => s.id === key);
      const item = slot && state.items.find((x) => x.id === slot.itemId);
      const mon = el(`<div class="mon${state.slot === key ? ' sel' : ''}">${i + 1}<small>${esc(slot ? slot.title : 'No wallpaper')}</small></div>`);
      Object.assign(mon.style, { left: ox + (d.bounds.x - minX) * sc + 'px', top: oy + (d.bounds.y - minY) * sc + 'px', width: d.bounds.width * sc - 4 + 'px', height: d.bounds.height * sc - 4 + 'px' });
      if (item && item.preview) mon.style.backgroundImage = `url("${item.preview}")`;
      mon.onclick = () => { state.slot = key; draw(); };
      mons.appendChild(mon);
    });
    const acts = $('#mon-actions', body); acts.innerHTML = '';
    acts.appendChild(el(`<span class="muted">Selected: ${state.wp.layout === 'per-monitor' ? 'display ' + (ds.findIndex((d) => d.id === state.slot) + 1) : 'all displays'}. Wallpapers you pick are applied here.</span>`));
    acts.appendChild(el('<div class="grow"></div>'));
    acts.appendChild(button('Remove wallpaper', 'btn-danger small', async () => { state.wp = await api('wp:clear', state.slot === 'clone' || state.slot === 'span' ? state.slot : state.slot); state.wp = await api('wp:status'); draw(); markActive(); }, 'trash'));
  };
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- playlists
function currentPlaylistItems() {
  const slot = (state.wp.slots || []).find((s) => s.id === state.slot) || (state.wp.slots || [])[0];
  return slot ? [slot.itemId] : [];
}
async function addToPlaylist(itemId) {
  const id = itemId || state.selected;
  if (!id) { toast('Select a wallpaper first.'); return; }
  state.settings = await api('settings:get');
  state.draft = state.draft || [];
  if (!state.draft.includes(id)) state.draft.push(id);
  updatePlaylistStatus();
  toast(`Added to the playlist draft (${state.draft.length}). Use Save to keep it.`);
}
async function savePlaylist() {
  const items = state.draft && state.draft.length ? state.draft : currentPlaylistItems();
  if (!items.length) { toast('Add wallpapers to the playlist first (select a wallpaper, then "Add wallpaper").'); return; }
  const name = await promptBox('Save playlist', 'Playlist name', 'My playlist');
  if (!name) return;
  const lists = [...(state.settings.playlists || [])];
  const ex = lists.find((p) => p.name === name);
  if (ex) ex.items = items; else lists.push({ id: 'p' + Date.now().toString(36), name, items, intervalMin: 30, order: 'sequential', mode: 'timer', times: [] });
  state.settings = await api('settings:set', 'playlists', lists);
  state.draft = [];
  updatePlaylistStatus();
  toast(`Playlist "${name}" saved with ${items.length} wallpapers.`, 'ok');
}
function loadPlaylistMenu() {
  const lists = state.settings.playlists || [];
  const r = $('#pl-load').getBoundingClientRect();
  if (!lists.length) { toast('No saved playlists yet.'); return; }
  menu(r.left, r.top - 8 - Math.min(lists.length + 2, 10) * 32, [
    ...lists.map((p) => ({ label: `${p.name} (${p.items.length})`, icon: 'play', click: async () => { await safe(() => api('playlist:start', p.id, state.slot), `Playing "${p.name}"`); updatePlaylistStatus(); } })),
    '-', { label: 'Stop playlist', icon: 'x', click: async () => { await api('playlist:stop', state.slot); updatePlaylistStatus(); } }
  ]);
}
async function configurePlaylist() {
  state.settings = await api('settings:get');
  const lists = state.settings.playlists || [];
  if (!lists.length) { toast('Save a playlist first.'); return; }
  const body = el(`<div class="form"><div class="frow"><span class="fl">Playlist</span><select id="pl">${lists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div><div id="plf"></div></div>`);
  const m = modal({ title: 'Configure playlist', body, foot: [button('Delete', 'btn-danger', async () => { const id = $('#pl', body).value; await api('settings:set', 'playlists', (state.settings.playlists || []).filter((p) => p.id !== id)); state.settings = await api('settings:get'); m.close(); toast('Playlist deleted'); }), button('Done', 'btn-accent', () => m.close())] });
  const drawPl = () => {
    const p = (state.settings.playlists || []).find((x) => x.id === $('#pl', body).value);
    if (!p) return;
    const f = $('#plf', body);
    f.innerHTML = `<div class="frow"><span class="fl">Switch wallpapers</span><select data-k="mode"><option value="timer">Every N minutes</option><option value="daytime">At set times of day</option><option value="login">Each time the app starts</option></select></div>
      <div class="frow"><span class="fl">Interval (minutes)</span><input type="number" min="1" max="1440" data-k="intervalMin" value="${p.intervalMin || 30}"></div>
      <div class="frow"><span class="fl">Times of day<div class="fd">Comma separated, e.g. 07:00, 18:30</div></span><input type="text" data-k="times" value="${esc((p.times || []).join(', '))}"></div>
      <div class="frow"><span class="fl">Order</span><select data-k="order"><option value="sequential">In order</option><option value="random">Shuffle</option></select></div>
      <h3>Wallpapers</h3><div class="list">${p.items.map((id, i) => { const it = state.items.find((x) => x.id === id); return `<div class="li"><div class="li-main"><div class="li-title">${i + 1}. ${esc(it ? it.title : '(missing) ' + id)}</div></div><button class="btn btn-dark small icon-btn" data-rm="${i}">${icon('trash')}</button></div>`; }).join('')}</div>`;
    $('[data-k=mode]', f).value = p.mode || 'timer';
    $('[data-k=order]', f).value = p.order || 'sequential';
    f.querySelectorAll('[data-k]').forEach((inp) => (inp.onchange = async () => {
      const v = inp.dataset.k === 'intervalMin' ? Math.max(1, Number(inp.value) || 30) : inp.dataset.k === 'times' ? inp.value.split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s)) : inp.value;
      p[inp.dataset.k] = v;
      state.settings = await api('settings:set', 'playlists', state.settings.playlists);
    }));
    f.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { p.items.splice(Number(b.dataset.rm), 1); state.settings = await api('settings:set', 'playlists', state.settings.playlists); drawPl(); }));
  };
  $('#pl', body).onchange = drawPl;
  drawPl();
}
async function updatePlaylistStatus() {
  const act = await api('playlist:status').catch(() => ({}));
  state.settings = await api('settings:get');
  const names = Object.values(act).map((a) => (state.settings.playlists || []).find((p) => p.id === a.playlistId)).filter(Boolean).map((p) => p.name);
  const draft = state.draft && state.draft.length ? `Draft: ${state.draft.length} wallpaper(s)` : '';
  $('#pl-status').textContent = [names.length ? 'Playing: ' + names.join(', ') : '', draft].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- settings
async function openSettings(startPage = 'performance') {
  state.settings = await api('settings:get');
  const s = state.settings;
  const pages = [['performance', 'Performance', 'bolt'], ['features', 'Features', 'widgets'], ['general', 'General', 'gear'], ['audio', 'Audio', 'audio'], ['taskbar', 'Taskbar', 'taskbar'], ['steam', 'Steam & Workshop', 'steam'], ['rainmeter', 'Rainmeter', 'drop'], ['updates', 'Updates', 'update'], ['about', 'About & Support', 'coffee']];
  const body = el(`<div class="settings"><div class="snav">${pages.map(([id, l, ic]) => `<button data-p="${id}"><i data-icon="${ic}"></i>${l}</button>`).join('')}</div><div class="spage"></div></div>`);
  const m = modal({ title: 'Settings', body, foot: [button('Close', 'btn-accent', () => m.close())] });
  const set = async (k, v) => { state.settings = await api('settings:set', k, v); if (k.startsWith('theme')) applyTheme(); };
  const sel = (k, v, opts) => `<select data-k="${k}">${opts.map(([val, l]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const chk = (k, v) => `<label class="switch"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}><span></span></label>`;
  const row = (label, ctl, desc) => `<div class="frow"><div><div class="fl">${label}</div>${desc ? `<div class="fd">${desc}</div>` : ''}</div><div>${ctl}</div></div>`;
  const ruleOpts = [['run', 'Keep running'], ['mute', 'Mute'], ['pause', 'Pause'], ['stop', 'Stop (free memory)']];
  const render = async (p) => {
    body.querySelectorAll('.snav button').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
    const sp = $('.spage', body);
    const pb = s.playback;
    let html = '';
    if (p === 'performance') {
      html = `<div class="form"><h3>Playback</h3>
        ${row('Other application focused', sel('playback.otherAppFocused', pb.otherAppFocused, ruleOpts), 'When you are working in another window')}
        ${row('Other application maximized', sel('playback.otherAppMaximized', pb.otherAppMaximized, ruleOpts), 'When a window covers the desktop')}
        ${row('Other application fullscreen', sel('playback.otherAppFullscreen', pb.otherAppFullscreen, ruleOpts), 'Games, videos and presentations')}
        ${row('On battery power', sel('playback.onBattery', pb.onBattery, [['run', 'Keep running'], ['pause', 'Pause'], ['stop', 'Stop (free memory)']]), 'Laptops: save battery')}
        ${row('Locked / asleep', sel('playback.displayAsleepOrLocked', pb.displayAsleepOrLocked, [['pause', 'Pause'], ['stop', 'Stop (free memory)']]))}
        ${row('Only affect the covered monitor', chk('playback.pauseAllPerMonitor', pb.pauseAllPerMonitor), 'With several monitors, keep the others playing')}
        <h3>Quality</h3>
        ${row('FPS limit', `<div class="rng" style="display:flex;gap:8px;align-items:center"><input type="range" min="10" max="144" step="1" data-k="playback.fps" value="${pb.fps}"><span id="fpsv">${pb.fps}</span></div>`, 'Lower = less GPU and CPU use')}
        ${row('Render quality', sel('playback.quality', pb.quality, [['low', 'Low (50%)'], ['medium', 'Medium (75%)'], ['high', 'High (native)'], ['ultra', 'Ultra (supersampled)']]), 'Resolution of scene wallpapers')}
        </div>`;
    } else if (p === 'features') {
      const fe = s.features || {};
      html = `<div class="form"><h3>Optional features</h3>
        <div class="fd" style="margin:-4px 0 10px">Turning a feature off unloads it completely: no windows, timers or network use, so it takes no memory or CPU. Wallpapers themselves always stay on.</div>
        ${row('Widgets', chk('features.widgets', fe.widgets !== false), 'Desktop widgets (clock, system monitor, weather…). Off closes all widget windows; your widget layout is kept.')}
        ${row('Rainmeter', chk('features.rainmeter', fe.rainmeter !== false), 'Rainmeter skin manager. Off hides the tab; you can also close Rainmeter itself to free its memory.')}
        ${row('Steam Workshop & Discover', chk('features.workshop', fe.workshop !== false), 'Browsing the Workshop online. Off = no network requests; installed wallpapers still work.')}
        ${row('Playlists', chk('features.playlists', fe.playlists !== false), 'Automatic wallpaper rotation. Off stops the playlist timer.')}
        ${row('Taskbar styling', chk('features.taskbar', fe.taskbar !== false), 'Transparent / blurred taskbar. Off restores the normal Windows taskbar.')}
        ${row('Audio visualizer', chk('audio.audioVisualizer', s.audio.audioVisualizer), 'Lets audio-responsive wallpapers react to sound. Off = no audio capture.')}
        </div>`;
    } else if (p === 'general') {
      html = `<div class="form"><h3>Startup</h3>
        ${row('Start with Windows', chk('startWithWindows', s.startWithWindows), 'Applies to the installed app')}
        ${row('Start minimized to tray', chk('startMinimized', s.startMinimized))}
        <h3>Appearance</h3>
        ${row('Accent color', `<input type="color" data-k="theme.accent" value="${esc(s.theme.accent)}">`)}
        <h3>Memory</h3>
        ${row('Keep this window in memory when closed', chk('advanced.keepUIInMemory', s.advanced.keepUIInMemory), 'Off = the library window is fully closed and its memory freed; wallpapers keep running from the tray')}
        ${row('Hardware acceleration', chk('advanced.hardwareAcceleration', s.advanced.hardwareAcceleration), 'Turn off only if wallpapers flicker or crash. Restart required.')}
        ${row('Debug logging', chk('advanced.debug', s.advanced.debug))}
        <h3>Library</h3>
        ${row('Extra wallpaper folders', `<button class="btn btn-dark" id="clr-extra">Clear (${(s.library.extraFolders || []).length})</button>`, 'Folders added with "Open Folder" that contain project.json wallpapers')}
        </div>`;
    } else if (p === 'audio') {
      html = `<div class="form"><h3>Sound</h3>
        ${row('Wallpaper volume', `<div style="display:flex;gap:8px;align-items:center"><input type="range" min="0" max="100" data-k="audio.volume" value="${s.audio.volume}"><span id="volv">${s.audio.volume}</span></div>`)}
        ${row('Mute all wallpapers', chk('audio.muted', s.audio.muted))}
        <h3>Audio visualization</h3>
        ${row('Audio-responsive wallpapers', chk('audio.audioVisualizer', s.audio.audioVisualizer), 'Lets wallpapers and the visualizer widget react to what your PC is playing (system audio loopback, never recorded or sent anywhere)')}
        </div>`;
    } else if (p === 'taskbar') {
      html = `<div class="form"><h3>Taskbar style</h3>
        ${row('Taskbar appearance', sel('taskbar.mode', s.taskbar.mode, [['normal', 'Windows default'], ['transparent', 'Transparent'], ['blur', 'Blur'], ['acrylic', 'Acrylic'], ['opaque', 'Solid color']]), 'Makes the taskbar blend with your live wallpaper')}
        ${row('Tint color', `<input type="color" data-k="taskbar.colorHex" value="${esc((s.taskbar.color || '#000000').slice(0, 7))}">`)}
        ${row('Tint strength', `<input type="range" min="0" max="255" data-k="taskbar.alpha" value="${parseInt((s.taskbar.color || '#00000000').slice(7, 9) || '00', 16)}">`)}
        <div class="banner" style="margin-top:10px">On recent Windows 11 builds Explorer may ignore taskbar styling for some modes; "Transparent" and "Solid color" work most reliably. Choose "Windows default" to restore the normal taskbar.</div></div>`;
    } else if (p === 'steam') {
      const st = state.info.steam || {};
      const logged = await api('ws:loggedIn').catch(() => false);
      html = `<div class="form"><h3>Steam</h3>
        ${row('Steam client', `<span class="status-pill ${st.steamPath ? 'ok' : 'off'}">${st.steamPath ? 'Found' : 'Not found'}</span>`, esc(st.steamPath || 'Install Steam to use Workshop wallpapers'))}
        ${row('Signed-in Steam account', esc(st.user ? st.user.personaName || st.user.accountName : 'Unknown'))}
        ${row('Wallpaper Engine owned', `<span class="status-pill ${st.weOwned ? 'ok' : 'off'}">${st.weOwned ? 'Yes' : 'No'}</span>`, 'Steam downloads Wallpaper Engine Workshop items only for owners')}
        ${row('Workshop folders', esc((st.workshopDirs || []).join('<br>') || 'none'))}
        ${row('Scene support files', `<span class="status-pill ${st.weAssetsDir ? 'ok' : 'off'}">${st.weAssetsDir ? 'Found' : 'Missing'}</span>`, 'Built-in effects and shaders used by scene wallpapers (read-only from your Wallpaper Engine install)')}
        ${row('Rescan', `<button class="btn btn-dark" id="steam-rescan">Rescan Steam</button>`)}
        <h3>Steam Community (subscribe from inside the app)</h3>
        ${row('Status', logged ? '<span class="status-pill ok">Signed in</span>' : '<span class="status-pill off">Not signed in</span>')}
        ${row('', logged ? '<button class="btn btn-dark" id="ws-logout">Sign out</button>' : '<button class="btn btn-accent" id="ws-login">Sign in to Steam</button>')}
        <h3>Workshop browsing</h3>
        ${row('Steam Web API key (optional)', `<input type="password" data-k="workshop.apiKey" value="${esc(s.workshop.apiKey || '')}" placeholder="Not required">`, 'Gives exact result counts and faster searches. Get one at steamcommunity.com/dev/apikey')}
        </div>`;
    } else if (p === 'rainmeter') {
      const rm = await api('rm:status');
      html = `<div class="form"><h3>Rainmeter</h3>
        ${row('Rainmeter', `<span class="status-pill ${rm.installed ? 'ok' : 'off'}">${rm.installed ? 'Installed' : 'Not installed'}</span>`, esc(rm.exe || ''))}
        ${row('Skins folder', esc(rm.skinsDir))}
        ${row('Rainmeter.exe location', `<button class="btn btn-dark" id="rm-pick2">Choose…</button>`)}
        ${rm.installed ? '' : row('', `<button class="btn btn-accent" id="rm-dl2">Download Rainmeter</button>`)}</div>`;
    } else if (p === 'updates') {
      html = `<div class="form"><h3>Updates</h3>
        ${row('Current version', esc(state.info.version))}
        ${row('GitHub repository', `<input type="text" data-k="updates.repo" value="${esc(s.updates.repo || state.info.defaultRepo || '')}" placeholder="owner/repo or GitHub URL" spellcheck="false">`, 'Releases from this repository are used for updates')}
        ${row('Check automatically', chk('updates.autoCheck', s.updates.autoCheck))}
        <div style="margin-top:14px" class="row-flex"><button class="btn btn-accent" id="chk-upd"><i data-icon="update"></i>Check for updates</button><span id="upd-res" class="muted"></span></div>
        <div id="upd-box" style="margin-top:12px"></div></div>`;
    } else if (p === 'about') {
      html = `<div class="form"><h3>About</h3>
        <div style="display:flex;gap:14px;align-items:center;margin:8px 0"><img src="../../../assets/icon.png" width="56" height="56" alt=""><div><div style="font-size:20px;font-weight:600">${esc(state.info.name)}</div><div class="muted">Version ${esc(state.info.version)} · Electron ${esc(state.info.electron)}</div></div></div>
        <p class="muted" style="line-height:1.5">Live wallpapers for Windows: Steam Workshop scenes, videos, web wallpapers, desktop widgets and Rainmeter skins.<br>Wallpaper Engine is a product of its respective owners; this app is independent and only reads your existing Workshop downloads.</p>
        <div class="support"><div style="font-size:34px">☕</div><div style="flex:1"><div style="font-weight:600;font-size:16px">Enjoying the app?</div><div class="muted">Support development with a coffee.</div></div><button class="btn coffee-btn" id="coffee">Buy Me a Coffee</button></div>
        <h3>Updates</h3><div class="row-flex"><button class="btn btn-accent" id="chk-upd"><i data-icon="update"></i>Check for updates</button><span id="upd-res" class="muted"></span></div><div id="upd-box" style="margin-top:12px"></div>
        <h3>Resource usage</h3><div id="metrics" class="muted">Measuring…</div></div>`;
    }
    sp.innerHTML = html;
    hydrateIcons(sp);
    sp.querySelectorAll('[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      const isLive = inp.type === 'range' || inp.type === 'color' || inp.type === 'text' || inp.type === 'password';
      inp.addEventListener(isLive ? 'input' : 'change', debounce(async () => {
        let v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? Number(inp.value) : inp.value;
        if (k === 'playback.fps') $('#fpsv', sp).textContent = v;
        if (k === 'audio.volume') $('#volv', sp).textContent = v;
        if (k === 'taskbar.colorHex' || k === 'taskbar.alpha') {
          const hex = (sp.querySelector('[data-k="taskbar.colorHex"]') || {}).value || '#000000';
          const a = Number((sp.querySelector('[data-k="taskbar.alpha"]') || {}).value || 0);
          await set('taskbar.color', hex + a.toString(16).padStart(2, '0'));
          return;
        }
        await set(k, v);
        if (k.startsWith('features.')) {
          applyFeatureUI();
          if (k === 'features.rainmeter' && !v) {
            const st = await api('rm:status').catch(() => null);
            if (st && st.running && await confirmBox('Close Rainmeter?', 'Rainmeter is still running and using memory. Close it now? (Your skins and layout are kept.)', 'Close Rainmeter')) { await api('rm:quit'); toast('Rainmeter closed'); }
          }
        }
      }, isLive ? 200 : 0));
    });
    const on = (id, f) => { const b = $('#' + id, sp); if (b) b.onclick = f; };
    on('clr-extra', async () => { await set('library.extraFolders', []); toast('Cleared. Restart the app to rescan.'); render('general'); });
    on('steam-rescan', async () => { state.info.steam = await api('steam:refresh'); await loadLibrary(); renderGrid(); render('steam'); toast('Steam rescanned', 'ok'); });
    on('ws-login', async () => { await api('ws:login'); render('steam'); });
    on('ws-logout', async () => { await api('ws:logout'); render('steam'); });
    on('rm-pick2', async () => { await api('rm:pickExe'); render('rainmeter'); });
    on('rm-dl2', () => api('shell:open', 'https://www.rainmeter.net/'));
    on('coffee', () => api('shell:support'));
    on('chk-upd', () => checkUpdates(sp));
    if (p === 'about') {
      const ms = await api('app:metrics');
      const total = ms.reduce((a, x) => a + x.mem, 0);
      const cpu = ms.reduce((a, x) => a + x.cpu, 0);
      const mt = $('#metrics', sp);
      if (mt) mt.innerHTML = `Memory (working set): <b>${Math.round(total / 1024)} MB</b> across ${ms.length} processes · CPU ${cpu.toFixed(1)}%<br>${ms.map((x) => `${esc(x.type)}: ${Math.round(x.mem / 1024)} MB`).join(' · ')}`;
    }
  };
  body.querySelectorAll('.snav button').forEach((b) => (b.onclick = () => render(b.dataset.p)));
  render(startPage);
}

async function checkUpdates(sp) {
  const res = $('#upd-res', sp), box = $('#upd-box', sp);
  res.textContent = 'Checking…'; box.innerHTML = '';
  try {
    const r = await api('update:check');
    if (r.status === 'not-configured') { res.textContent = 'Set your GitHub repository in Settings › Updates first.'; return; }
    if (r.status === 'no-releases') { res.textContent = `No releases found in ${r.repo} yet.`; return; }
    if (r.status === 'up-to-date') { res.textContent = `You're up to date (latest: ${r.latest}).`; return; }
    res.textContent = `Version ${r.latest} is available.`;
    box.appendChild(el(`<div class="banner"><b>What's new in ${esc(r.latest)}</b><div class="desc" style="border:0;margin:6px 0 0;padding:0">${esc((r.notes || '').slice(0, 1500))}</div></div>`));
    const rowB = el('<div class="row-flex"></div>');
    if (r.installer) {
      const prog = el('<div class="progress" style="width:200px" hidden><div></div></div>');
      const off = L.on('update:progress', (p) => { prog.hidden = false; $('div', prog).style.width = Math.round(p * 100) + '%'; });
      rowB.appendChild(button(`Download & install (${fmtSize(r.installer.size)})`, 'btn-accent', async (e) => {
        e.target.disabled = true;
        const file = await safe(() => api('update:download', r.installer));
        off();
        if (file && await confirmBox('Install update', 'The update has been downloaded. Astral Engine will close and the installer will start.', 'Install now')) api('update:install', file);
        e.target.disabled = false;
      }, 'update'));
      rowB.appendChild(prog);
    }
    rowB.appendChild(button('Open release page', 'btn-dark', () => api('shell:open', r.url), 'external'));
    rowB.appendChild(button('Skip this version', 'btn-dark', async () => { await api('settings:set', 'updates.skipVersion', r.latest); toast('Skipped'); }));
    box.appendChild(rowB);
  } catch (e) { res.textContent = 'Update check failed: ' + e.message; }
}

// ---------------------------------------------------------------- import / drag & drop / first run
async function afterImport(items) {
  await loadLibrary();
  state.view = 'all'; $('#installed-label').textContent = 'Installed';
  switchTab('installed');
  const last = items[items.length - 1];
  if (last) { await selectItem(last.id, true); toast(`Added "${last.title}"`, 'ok'); }
}

function setupDragDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => L.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const items = await safe(() => api('lib:importPaths', paths));
    if (items && items.length) afterImport(items);
  });
}

async function firstRun() {
  const st = state.info.steam || {};
  const n = state.items.length;
  const body = el(`<div style="line-height:1.6"><p>Welcome to <b>${esc(state.info.name)}</b>!</p>
    <ul><li>Steam: ${st.steamPath ? 'found' : '<b>not found</b>'}${st.user ? ` (signed in as ${esc(st.user.personaName || st.user.accountName)})` : ''}</li>
    <li>Wallpaper Engine Workshop items found: <b>${state.items.filter((i) => i.kind === 'workshop').length}</b></li>
    <li>Total wallpapers in your library: <b>${n}</b></li></ul>
    <p class="muted">Click any wallpaper to apply it. Use <b>Workshop</b> to find more, <b>Open Wallpaper</b> to add your own videos, and <b>Widgets</b> / <b>Rainmeter</b> to customize your desktop.</p></div>`);
  const m = modal({ title: 'Welcome', body, cls: 'small', foot: [button('Get started', 'btn-accent', () => m.close())] });
  await api('settings:set', 'firstRunDone', true);
}

boot().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;padding:20px">${esc(e.stack || e)}</pre>`); });
