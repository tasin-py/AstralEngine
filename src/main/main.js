'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, nativeImage, shell, dialog, session, screen, powerMonitor, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const config = require('./config');
const { Settings } = require('./settings');
const steam = require('./steam');
const { Library } = require('./library');
const workshop = require('./workshop');
const { WallpaperManager } = require('./wallpaperManager');
const { AudioCapture } = require('./audio');
const { Widgets } = require('./widgets');
const { Rainmeter } = require('./rainmeter');
const updater = require('./updater');
const { Playlists } = require('./playlists');
const desktop = require('./desktop');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, '..', 'assets');
const isSelfTest = process.argv.includes('--selftest');
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) app.setPath('userData', profileArg.slice(10));

// The app was previously named "RedStone Engine" and, before that, "Lumen Wallpaper". Its data folder
// follows the app name, so on the first start after a rename, copy the settings, imported wallpapers
// and Steam sign-in from the newest old folder. Old folders are left untouched.
const OLD_PROFILE_NAMES = ['RedStone Engine', 'Lumen Wallpaper'];
function migrateOldProfile() {
  const newDir = app.getPath('userData');
  if (profileArg || fs.existsSync(path.join(newDir, 'settings.json'))) return;
  const oldDir = OLD_PROFILE_NAMES.map((n) => path.join(app.getPath('appData'), n))
    .find((d) => path.resolve(d) !== path.resolve(newDir) && fs.existsSync(path.join(d, 'settings.json')));
  if (!oldDir) return;
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of ['settings.json', 'imported', 'Partitions', 'Local State', 'Local Storage']) {
    const src = path.join(oldDir, name);
    if (!fs.existsSync(src)) continue;
    try { fs.cpSync(src, path.join(newDir, name), { recursive: true, force: false, errorOnExist: false }); } catch (e) { console.error('migrate', name, e.message); }
  }
}
try { migrateOldProfile(); } catch (e) { console.error('profile migration failed', e); }
const persistTest = (process.argv.find((a) => a.startsWith('--persisttest=')) || '').slice(14);
const startHidden = process.argv.includes('--hidden');

// ---------- process-wide tuning for low resource use ----------
// Our wallpaper windows live behind the desktop icons; Chromium's occlusion tracking would
// otherwise consider them hidden and stop drawing. We do our own (cheaper) pausing instead.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,Translate,SpareRendererForSitePerProcess,AudioServiceOutOfProcess,AudioServiceSandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,NetworkServiceInProcess2');
app.commandLine.appendSwitch('disable-site-isolation-trials');
try {
  const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  if (s.advanced && s.advanced.hardwareAcceleration === false) app.disableHardwareAcceleration();
} catch { /* first run */ }
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.tasinpy.astralengine');

if (!isSelfTest && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([
  { scheme: 'astral', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

let settings, library, manager, audio, widgets, rainmeter, playlists, steamInfo;
let uiWin = null;
let tray = null;
let taskbarTimer = null;
let quitting = false;

// ---------- astral:// file protocol (with byte ranges for video seeking) ----------
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.json': 'application/json', '.pkg': 'application/octet-stream',
  '.frag': 'text/plain', '.vert': 'text/plain', '.h': 'text/plain', '.ttf': 'font/ttf', '.otf': 'font/otf', '.js': 'text/javascript'
};

function allowedRoots() {
  const roots = [];
  for (const s of library ? library.sources : []) roots.push(s.dir);
  if (steamInfo && steamInfo.weAssetsDir) roots.push(steamInfo.weAssetsDir);
  for (const it of library ? library.list() : []) {
    if (it.kind === 'imported' && it.file && path.isAbsolute(it.file)) roots.push(it.file);
  }
  for (const w of settings ? settings.get('widgets') || [] : []) if (w.options && w.options.photo) roots.push(w.options.photo);
  return roots.map((r) => path.resolve(r).toLowerCase());
}

function isAllowed(p) {
  const full = path.resolve(p).toLowerCase();
  return allowedRoots().some((r) => full === r || full.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function registerFileProtocol(ses) {
  ses.protocol.handle('astral', async (req) => {
    try {
      const u = new URL(req.url);
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (u.host !== 'f' || !path.isAbsolute(p) || !isAllowed(p)) return new Response('Forbidden', { status: 403 });
      const st = await fs.promises.stat(p);
      const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.get('range');
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m && m[1] ? Number(m[1]) : 0;
        let end = m && m[2] ? Number(m[2]) : st.size - 1;
        if (!m || !m[1]) { start = Math.max(0, st.size - Number(m && m[2] || 0)); end = st.size - 1; }
        end = Math.min(end, st.size - 1);
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
        const stream = fs.createReadStream(p, { start, end });
        return new Response(require('stream').Readable.toWeb(stream), {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const stream = fs.createReadStream(p);
      return new Response(require('stream').Readable.toWeb(stream), {
        headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------- UI window ----------
function createUI(show = true) {
  if (uiWin && !uiWin.isDestroyed()) { if (show) { if (uiWin.isMinimized()) uiWin.restore(); uiWin.show(); uiWin.focus(); } return uiWin; }
  const wa = screen.getPrimaryDisplay().workArea;
  // Restore the last window size/position if it is still on a connected screen.
  const saved = settings.get('window') || {};
  const b = saved.bounds;
  const onScreen = !!b && screen.getAllDisplays().some((d) => { const r = d.workArea; return b.x < r.x + r.width - 50 && b.x + b.width > r.x + 50 && b.y >= r.y - 10 && b.y < r.y + r.height - 50; });
  uiWin = new BrowserWindow({
    width: onScreen ? b.width : Math.min(1320, wa.width - 40), height: onScreen ? b.height : Math.min(820, wa.height - 40),
    ...(onScreen ? { x: b.x, y: b.y } : {}), minWidth: 980, minHeight: 600,
    show: false, frame: false, backgroundColor: '#1b1d22', title: config.APP_NAME,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'ui.js'), contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false
    }
  });
  uiWin.setMenu(null);
  uiWin.loadFile(path.join(ROOT, 'renderer', 'ui', 'index.html'));
  if (onScreen && saved.maximized) uiWin.maximize();
  uiWin.once('ready-to-show', () => { if (show) uiWin.show(); });
  const saveBounds = () => {
    if (isSelfTest || !uiWin || uiWin.isDestroyed() || uiWin.isMinimized()) return;
    const max = uiWin.isMaximized();
    settings.set('window', { bounds: max ? uiWin.getNormalBounds() : uiWin.getBounds(), maximized: max });
  };
  let boundsTimer = null;
  const saveBoundsSoon = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); };
  uiWin.on('resize', saveBoundsSoon); uiWin.on('move', saveBoundsSoon);
  uiWin.on('maximize', saveBounds); uiWin.on('unmaximize', saveBounds);
  uiWin.on('maximize', () => sendUI('win:state', { maximized: true }));
  uiWin.on('unmaximize', () => sendUI('win:state', { maximized: false }));
  uiWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^steam:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  uiWin.webContents.on('will-navigate', (e) => e.preventDefault());
  uiWin.on('close', (e) => {
    try { saveBounds(); if (!isSelfTest) settings.flush(); } catch { /* ignore */ }
    if (quitting || isSelfTest) return;
    // Closing the window keeps wallpapers running from the tray. By default the UI is fully
    // destroyed to give its memory back (Wallpaper Engine keeps its UI processes alive).
    if (settings.get('advanced.keepUIInMemory')) { e.preventDefault(); uiWin.hide(); }
  });
  uiWin.on('closed', () => { uiWin = null; });
  return uiWin;
}

function sendUI(ch, data) { if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send(ch, data); }

// ---------- tray ----------
function buildTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip(config.APP_NAME);
  tray.on('click', () => createUI(true));
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const paused = manager && manager.userPaused;
  const muted = settings.get('audio.muted');
  const wvis = widgets ? widgets.visible : true;
  const menu = Menu.buildFromTemplate([
    { label: 'Open ' + config.APP_NAME, click: () => createUI(true) },
    { type: 'separator' },
    { label: paused ? 'Resume wallpapers' : 'Pause wallpapers', click: () => { manager.setUserPaused(!paused); refreshTray(); } },
    { label: muted ? 'Unmute' : 'Mute', click: () => { settings.set('audio.muted', !muted); refreshTray(); } },
    ...(feature('playlists') ? [{ label: 'Next wallpaper (playlist)', click: () => playlists.nextAll() }] : []),
    ...(feature('widgets') ? [{ label: wvis ? 'Hide widgets' : 'Show widgets', click: () => { widgets.setVisible(!wvis); refreshTray(); } }] : []),
    { type: 'separator' },
    { label: 'Settings', click: () => { createUI(true); setTimeout(() => sendUI('ui:navigate', 'settings'), 300); } },
    { label: 'Check for updates', click: () => { createUI(true); setTimeout(() => sendUI('ui:navigate', 'updates'), 600); } },
    { label: 'Support the developer ☕', click: () => shell.openExternal(config.SUPPORT_URL) },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() }
  ]);
  tray.setContextMenu(menu);
}

function quit() {
  quitting = true;
  try { manager && manager.shutdown(); } catch { /* ignore */ }
  try { widgets && widgets.stopAll(); } catch { /* ignore */ }
  try { audio && audio.close(); } catch { /* ignore */ }
  try { if (settings.get('taskbar.mode') !== 'normal') desktop.setTaskbarStyle('normal'); } catch { /* ignore */ }
  settings && settings.flush();
  closeRainmeterWithApp();
  app.quit();
}

// Built-in display property keys were renamed from "_lw_*" to "_ae_*"; rename them in saved data.
function migratePropKeys(st) {
  const fix = (o) => { if (!o || typeof o !== 'object') return [o, false]; let ch = false; const out = {}; for (const [k, v] of Object.entries(o)) { const nk = k.startsWith('_lw_') ? '_ae_' + k.slice(4) : k; if (nk !== k) ch = true; out[nk] = v; } return [out, ch]; };
  const [g, gc] = fix(st.get('globalProps')); if (gc) st.set('globalProps', g);
  const items = st.get('itemProps') || {}; let ic = false; const ni = {};
  for (const [id, p] of Object.entries(items)) { const [o, c] = fix(p); ni[id] = o; ic = ic || c; }
  if (ic) st.set('itemProps', ni);
  const pre = st.get('presets') || []; let pc = false;
  const np = pre.map((x) => { const [o, c] = fix(x && x.props); pc = pc || c; return { ...x, props: o }; });
  if (pc) st.set('presets', np);
}

// ---------- optional features ----------
/** Starts or fully unloads each optional feature to match Settings › Features. */
function applyFeatures() {
  if (feature('widgets')) { if (!widgets.host) widgets.start(); } else widgets.stopAll();
  if (feature('playlists')) { if (!playlists.timer) playlists.startTimers(); } else playlists.stopTimers();
  applyTaskbar();
  manager.updateAudioNeeds();
  if (tray) refreshTray();
}

// ---------- taskbar ----------
function hexToAbgr(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!m) return 0;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const a = m[2] ? parseInt(m[2], 16) : 0xff;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

let taskbarStyled = false;
function applyTaskbar() {
  clearInterval(taskbarTimer);
  const t = settings.get('taskbar');
  const mode = feature('taskbar') ? (t.mode || 'normal') : 'normal';
  if (mode === 'normal' && !taskbarStyled) return; // never touched it: leave Windows' own style alone
  taskbarStyled = mode !== 'normal';
  const run = () => { try { desktop.setTaskbarStyle(mode, hexToAbgr(t.color)); } catch { /* ignore */ } };
  run();
  // Explorer resets the accent on focus/theme changes; re-apply cheaply while enabled.
  if (mode !== 'normal') taskbarTimer = setInterval(run, 1500);
}

// ---------- IPC ----------
function itemForUI(it) {
  return {
    id: it.id, kind: it.kind, workshopid: it.workshopid, type: it.type, title: it.title, description: it.description,
    preview: it.preview ? 'astral://f/' + encodeURIComponent(it.preview) : null, tags: it.tags, contentrating: it.contentrating,
    favorite: it.favorite, added: it.added, updated: it.updated, file: it.file, dir: it.dir, size: it.size,
    properties: it.properties, supportsAudio: it.supportsAudio, missingDependency: !!it.missingDependency, approved: it.approved,
    entryUrl: (it.type === 'video' || it.type === 'image') && library.entryPath(it) ? 'astral://f/' + encodeURIComponent(library.entryPath(it)) : null
  };
}

const feature = (name) => settings.get('features.' + name) !== false;
// IPC channels that belong to an optional feature; refused while that feature is off.
const FEATURE_OF = (ch) => ch.startsWith('widgets:') && ch !== 'widgets:types' ? 'widgets'
  : ch.startsWith('rm:') && ch !== 'rm:status' && ch !== 'rm:quit' ? 'rainmeter'
  : ch === 'ws:browse' || ch === 'ws:details' ? 'workshop'
  : ch === 'playlist:start' || ch === 'playlist:next' ? 'playlists' : null;
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...args) => {
    const feat = FEATURE_OF(ch);
    if (feat && !feature(feat)) return { ok: false, error: 'This feature is turned off in Settings › Features', code: 'disabled' };
    try { return { ok: true, data: await fn(e, ...args) }; } catch (err) { return { ok: false, error: err && err.message || String(err), code: err && err.code }; }
  });
}

function registerIPC() {
  // Older versions offered an in-app Steam Community sign-in. It's gone (subscribing now happens in
  // the Steam app), so wipe any session cookies an older version stored.
  if (!settings.get('steamSessionCleared')) {
    session.fromPartition('persist:steam').clearStorageData().catch(() => {});
    settings.set('steamSessionCleared', true);
  }

  handle('app:info', () => ({
    name: config.APP_NAME, version: app.getVersion(), electron: process.versions.electron, steam: steamInfo,
    supportUrl: config.SUPPORT_URL, defaultRepo: config.UPDATE_REPO, platform: process.platform,
    userData: app.getPath('userData')
  }));
  handle('steam:refresh', () => { steamInfo = steam.detect(); library.setSources(steamInfo); library.scan(); return steamInfo; });

  handle('lib:list', () => library.list().map(itemForUI));
  handle('lib:details', (e, id) => { const it = library.details(id); return it ? itemForUI(it) : null; });
  handle('lib:importDialog', async () => {
    const r = await dialog.showOpenDialog(uiWin, {
      title: 'Open wallpaper', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Wallpapers', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'wmv', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'html', 'htm', 'json'] }]
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => itemForUI(library.importPath(path.basename(p).toLowerCase() === 'project.json' ? path.dirname(p) : p)));
  });
  handle('lib:importFolder', async () => {
    const r = await dialog.showOpenDialog(uiWin, { title: 'Open wallpaper folder', properties: ['openDirectory'] });
    if (r.canceled) return null;
    const it = library.importPath(r.filePaths[0]);
    return it ? itemForUI(it) : null;
  });
  handle('lib:importPaths', (e, paths) => paths.map((p) => itemForUI(library.importPath(p))));
  handle('lib:remove', (e, id) => library.removeImported(id));
  handle('lib:favorite', (e, id) => library.toggleFavorite(id));
  handle('lib:openFolder', (e, id) => { const it = library.get(id); if (it) shell.openPath(it.dir); });
  handle('lib:setPreview', (e, id, dataUrl) => {
    const b64 = String(dataUrl).split(',')[1];
    if (b64) library.setPreview(id, Buffer.from(b64, 'base64'));
  });

  handle('wp:status', () => manager.status());
  handle('lib:is3D', (e, id) => library.is3DScene(library.get(id)));
  handle('wp:apply', (e, itemId, slotId) => manager.apply(itemId, slotId).then(() => { playlists.stop(slotId); return manager.status(); }));
  handle('wp:clear', (e, slotId) => manager.clear(slotId));
  handle('wp:pause', (e, p) => { manager.setUserPaused(!!p); refreshTray(); return manager.status(); });
  handle('wp:getProps', (e, itemId) => { const it = library.get(itemId); return it ? manager.resolvedProps(it) : {}; });
  handle('wp:setProps', (e, itemId, props) => manager.setItemProps(itemId, props));
  handle('clip:write', (e, text) => { require('electron').clipboard.writeText(String(text)); return true; });
  handle('clip:read', () => require('electron').clipboard.readText());
  handle('wp:applyAll', (e, itemId) => {
    // "Apply to all wallpapers": the item's built-in display values become the global default.
    const it = library.get(itemId); if (!it) return false;
    const cur = manager.resolvedProps(it), g = {};
    for (const [k, p] of Object.entries(cur)) if (k.startsWith('_ae_')) g[k] = p.value;
    settings.set('globalProps', g);
    const all = { ...(settings.get('itemProps') || {}) };
    for (const id of Object.keys(all)) { const o = { ...all[id] }; for (const k of Object.keys(o)) if (k.startsWith('_ae_')) delete o[k]; all[id] = o; }
    settings.set('itemProps', all);
    for (const s of manager.slots.values()) manager.sendProps(s, null);
    return true;
  });
  handle('wp:resetProps', (e, itemId) => { const all = { ...(settings.get('itemProps') || {}) }; delete all[itemId]; settings.set('itemProps', all); const it = library.get(itemId); if (it) for (const s of manager.slots.values()) if (s.item.id === itemId) manager.sendProps(s, manager.resolvedProps(it)); return true; });

  handle('ws:browse', (e, opts) => workshop.browse({ ...opts, apiKey: settings.get('workshop.apiKey') }));
  handle('ws:details', (e, ids) => workshop.getDetails(ids));
  // Workshop pages open in the Steam app (default) or the web browser (Settings > Steam & Workshop).
  // The Steam app's built-in browser sometimes shows a blank page; the browser is the fallback.
  const wsPage = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(String(id).replace(/\D/g, ''))}`;
  handle('ws:openInSteam', (e, id, where) => {
    const w = where || settings.get('workshop.openIn') || 'steam';
    return shell.openExternal(w === 'browser' ? wsPage(id) : `steam://openurl/${wsPage(id)}`);
  });

  handle('settings:get', () => settings.get());
  handle('settings:set', (e, key, value) => { settings.set(key, value); return settings.get(); });

  handle('widgets:list', () => widgets.list());
  handle('widgets:types', () => widgets.types());
  handle('widgets:add', (e, type, displayId) => widgets.add(type, displayId));
  handle('widgets:remove', (e, id) => widgets.remove(id));
  handle('widgets:update', (e, id, patch) => widgets.update(id, patch));
  handle('widgets:updateAll', (e, patch) => widgets.updateAll(patch));
  handle('widgets:fonts', () => {
    let bundled = [];
    try { bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'fonts', 'fonts.json'), 'utf8')); } catch { /* none */ }
    return { bundled, installed: widgets.fonts() };
  });
  handle('widgets:visible', (e, v) => { widgets.setVisible(!!v); refreshTray(); return v; });
  handle('widgets:pickPhoto', async () => {
    const r = await dialog.showOpenDialog(uiWin, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('shell:notices', () => {
    const f = app.isPackaged ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt') : path.join(__dirname, '..', '..', 'THIRD_PARTY_NOTICES.txt');
    return shell.openPath(f);
  });
  handle('rm:status', () => rainmeter.status());
  handle('rm:quit', () => rainmeter.quit());
  handle('rm:start', () => rainmeter.start());
  handle('rm:installApp', () => rainmeter.installManaged((p) => sendUI('rm:installProgress', p)));
  handle('rm:uninstallApp', () => rainmeter.uninstall());
  handle('rm:installFile', (e, file) => rainmeter.installPackage(file));
  handle('rm:skins', () => rainmeter.listSkins());
  handle('rm:layouts', () => rainmeter.listLayouts());
  handle('rm:activate', (e, config, file) => rainmeter.activate(config, file));
  handle('rm:deactivate', (e, config) => rainmeter.deactivate(config));
  handle('rm:refresh', () => rainmeter.refreshAll());
  handle('rm:manage', () => rainmeter.manage());
  handle('rm:edit', (e, config, file) => rainmeter.edit(config, file));
  handle('rm:loadLayout', (e, name) => rainmeter.loadLayout(name));
  handle('rm:openSkins', () => shell.openPath(rainmeter.skinsDir()));
  handle('rm:install', async () => {
    const r = await dialog.showOpenDialog(uiWin, { properties: ['openFile'], filters: [{ name: 'Rainmeter skin', extensions: ['rmskin'] }] });
    if (r.canceled) return false;
    return rainmeter.installPackage(r.filePaths[0]);
  });
  handle('rm:pickExe', async () => {
    const r = await dialog.showOpenDialog(uiWin, { properties: ['openFile'], filters: [{ name: 'Rainmeter.exe', extensions: ['exe'] }] });
    if (r.canceled) return null;
    settings.set('rainmeter.path', r.filePaths[0]);
    return rainmeter.status();
  });

  handle('update:check', () => updater.checkForUpdate({ repo: config.UPDATE_REPO, currentVersion: app.getVersion() }).then((r) => { settings.set('updates.lastCheck', Date.now()); return r; }));
  handle('update:download', async (e, asset) => {
    const file = await updater.downloadInstaller(asset, path.join(app.getPath('temp'), 'astral-update'), (p) => sendUI('update:progress', p));
    return file;
  });
  handle('update:install', (e, file) => {
    if (!file || !fs.existsSync(file) || !file.startsWith(path.join(app.getPath('temp'), 'astral-update'))) throw new Error('Installer missing');
    require('child_process').spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => quit(), 500);
    return true;
  });

  handle('taskbar:apply', () => { applyTaskbar(); return true; });

  handle('playlist:start', (e, playlistId, slotId) => playlists.start(playlistId, slotId));
  handle('playlist:stop', (e, slotId) => playlists.stop(slotId));
  handle('playlist:next', (e, slotId) => playlists.next(slotId));
  handle('playlist:status', () => playlists.status());

  handle('shell:open', (e, url) => { if (/^(https?:|steam:)/i.test(url)) return shell.openExternal(url); throw new Error('Blocked URL'); });
  handle('shell:support', () => shell.openExternal(config.SUPPORT_URL));
  handle('app:metrics', () => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, mem: m.memory.workingSetSize })));

  ipcMain.on('win:minimize', () => uiWin && uiWin.minimize());
  ipcMain.on('win:maximize', () => uiWin && (uiWin.isMaximized() ? uiWin.unmaximize() : uiWin.maximize()));
  ipcMain.on('win:close', () => uiWin && uiWin.close());

  // Wallpaper host <-> main
  ipcMain.handle('host:init', (e, slotId) => manager.hostInit(slotId));
  ipcMain.on('host:error', (e, msg) => { if (settings.get('advanced.debug')) console.warn('[wallpaper]', msg); });

  // Widgets
  ipcMain.handle('widget:config', (e, id) => widgets.config(id));
  ipcMain.handle('widget:update', (e, id, patch) => widgets.update(id, patch));
  ipcMain.handle('widget:remove', (e, id) => widgets.remove(id));
  ipcMain.handle('widget:addNear', (e, id, type, options) => widgets.addNear(id, type, options));
  ipcMain.handle('widget:fileUrl', (e, p) => (p && isAllowed(p) ? 'astral://f/' + encodeURIComponent(p) : null));
}

// ---------- startup ----------
app.whenReady().then(async () => {
  settings = new Settings(app.getPath('userData'));
  migratePropKeys(settings);
  steamInfo = steam.detect();
  library = new Library({ settings, userDataDir: app.getPath('userData') });
  library.setSources(steamInfo);
  library.scan();

  registerFileProtocol(session.defaultSession);
  // Scene wallpapers capture system audio themselves (loopback) — only the wallpaper host page may.
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const url = (req.frame && req.frame.url) || '';
    if (!url.startsWith('file:') || !url.includes('/renderer/wallpaper/host.html')) { cb({}); return; }
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });

  audio = new AudioCapture();
  manager = new WallpaperManager({ settings, library, steamInfo, audio });
  widgets = new Widgets(settings);
  rainmeter = new Rainmeter(settings);
  playlists = new Playlists({ settings, manager, library });
  audio.onSamples = (s) => { manager.pushAudio(s); widgets.pushAudio(s); };
  const origAudioNeeds = manager.updateAudioNeeds.bind(manager);
  manager.updateAudioNeeds = () => {
    origAudioNeeds();
    if (feature('widgets') && widgets.needsAudio() && settings.get('audio.audioVisualizer')) audio.setEnabled(true);
  };

  registerIPC();

  library.on('changed', () => sendUI('lib:changed'));
  manager.on('changed', (st) => { sendUI('wp:changed', st); audio.setPaused(manager.userPaused); });
  settings.onChange((key) => {
    manager.onSettingsChanged(key);
    if (key === 'startWithWindows') applyLoginItem();
    if (key.startsWith('taskbar')) applyTaskbar();
    if (key.startsWith('audio') || key === 'widgets') manager.updateAudioNeeds();
    if (key.startsWith('features')) applyFeatures();
  });

  applyInstallerChoices();
  applyLoginItem();
  manager.start();
  await manager.sync();
  applyFeatures();
  setInterval(() => { if (feature('widgets')) widgets.keepOnDesktop(); }, 3000);

  // Benchmark helper: `--benchhold=<itemId> --secs=60 [--profile=dir]` runs one wallpaper with no UI
  // (playback rules forced to "keep running") so scripts/bench-processes.ps1 can measure it.
  const holdArg = process.argv.find((a) => a.startsWith('--benchhold='));
  if (holdArg) {
    const secs = Number((process.argv.find((a) => a.startsWith('--secs=')) || '--secs=60').slice(7)) || 60;
    // --wepolicy: use Wallpaper Engine's default rules (pause when maximized/fullscreen) for a like-for-like test
    const wePolicy = process.argv.includes('--wepolicy');
    settings.set('playback', { ...settings.get('playback'), otherAppFocused: 'run', otherAppMaximized: wePolicy ? 'pause' : 'run', otherAppFullscreen: wePolicy ? 'pause' : 'run', onBattery: 'run' });
    settings.set('firstRunDone', true);
    await manager.apply(holdArg.slice(12));
    console.log('[bench] holding', holdArg.slice(12), 'for', secs, 's');
    setTimeout(() => { manager.shutdown(); app.exit(0); }, secs * 1000);
    return;
  }
  if (persistTest) { require('./selftest').persist(persistTest, { app, settings, manager, createUI, quit }); return; }
  if (isSelfTest) {
    require('./selftest').run({ app, settings, library, manager, widgets, rainmeter, playlists, createUI, steamInfo });
    return;
  }

  buildTray();
  const hidden = startHidden && settings.get('startMinimized');
  createUI(!hidden);

  if (settings.get('updates.autoCheck') && (config.UPDATE_REPO)) {
    setTimeout(async () => {
      try {
        const r = await updater.checkForUpdate({ repo: config.UPDATE_REPO, currentVersion: app.getVersion() });
        if (r.status === 'update-available' && r.latest !== settings.get('updates.skipVersion')) {
          sendUI('update:available', r);
          if (tray) tray.displayBalloon({ title: config.APP_NAME, content: `Version ${r.latest} is available.` });
        }
      } catch { /* offline */ }
    }, 15000);
  }
});

/** The installer's finish page leaves "Start with Windows" in the registry; apply it once, then remove it. */
function applyInstallerChoices() {
  if (!app.isPackaged || isSelfTest) return;
  const { execFileSync } = require('child_process');
  const key = 'HKCU\\Software\\Astral Engine';
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'InstallStartWithWindows'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/InstallStartWithWindows\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) settings.set('startWithWindows', parseInt(m[1], 16) === 1);
    execFileSync('reg', ['delete', key, '/v', 'InstallStartWithWindows', '/f'], { windowsHide: true });
  } catch { /* nothing left by the installer */ }
}

function applyLoginItem() {
  // Only a real installation starts with Windows: not the dev build, not test/benchmark runs,
  // not the unpacked build folder and not the portable exe (its temp path changes every run).
  if (!app.isPackaged || isSelfTest || process.argv.some((a) => /^--(persisttest|benchhold|profile)=/.test(a))) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR || /[\\/]win-unpacked[\\/]/i.test(process.execPath)) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get('startWithWindows'), args: ['--hidden'] });
}

app.on('second-instance', () => createUI(true));
// Make sure settings reach the disk however the app ends (tray Quit, Windows shutdown/log-off, Ctrl+C).
const flushSettings = () => { try { if (settings) settings.flush(); } catch { /* ignore */ } };
app.on('before-quit', flushSettings);
app.on('will-quit', flushSettings);
process.on('exit', flushSettings);
app.whenReady().then(() => { require('electron').powerMonitor.on('shutdown', flushSettings); });
app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => { quitting = true; if (manager) manager.shutdown(); if (settings) settings.flush(); closeRainmeterWithApp(); });
// Settings › Rainmeter › "Close Rainmeter when Astral Engine closes" (off by default). Only on a full quit
// (tray Quit, Windows shutdown); closing the library window keeps Astral running in the tray.
let rainmeterClosed = false;
function closeRainmeterWithApp() {
  if (rainmeterClosed || isSelfTest || !settings || !rainmeter) return;
  rainmeterClosed = true;
  if (settings.get('features.rainmeter') === false || !settings.get('rainmeter.closeWithApp')) return;
  try { rainmeter.quitSync(); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => { console.error('uncaught', e); });
