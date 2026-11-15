'use strict';
// Runs wallpapers on each display, embeds them behind the desktop icons and applies the
// playback rules (pause / mute / stop when other apps are focused, maximized or fullscreen,
// on battery, when the session is locked...).

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen, powerMonitor, session } = require('electron');
const { EventEmitter } = require('events');
const desktop = require('./desktop');

const ROOT = path.join(__dirname, '..');
const RANK = { run: 0, mute: 1, pause: 2, stop: 3 };

const BUILTIN_DEFAULTS = { volume: 100, rate: 1, align: null, flip: false, filter: 'smooth', coloropts: false, brightness: 100, contrast: 100, saturation: 100, hue: 0 };

class WallpaperManager extends EventEmitter {
  constructor({ settings, library, steamInfo, audio }) {
    super();
    this.settings = settings;
    this.library = library;
    this.steamInfo = steamInfo;
    this.audio = audio;
    this.slots = new Map();      // slotId(displayId|'span') -> { win, item, state, bounds, kind }
    this.userPaused = !!settings.get('paused'); // restored from the last session
    this.locked = false;
    this.pollTimer = null;
    this.cursorTimer = null;
    this.lastMouseDown = false;
    this.fgCache = { state: 'desktop' };
  }

  // ---------- layout ----------
  displays() {
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id), label: d.label || `Display ${d.id}`, bounds: d.bounds, scaleFactor: d.scaleFactor,
      phys: screen.dipToScreenRect(null, d.bounds), primary: d.id === screen.getPrimaryDisplay().id
    }));
  }

  layoutMode() { return this.settings.get('wallpaper.layout') || 'per-monitor'; }

  /** slotId -> { bounds(phys), displays } */
  slotsWanted() {
    const ds = this.displays();
    const mode = this.layoutMode();
    if (mode === 'span' && ds.length > 0) {
      const xs = ds.map((d) => d.phys);
      const x = Math.min(...xs.map((r) => r.x)), y = Math.min(...xs.map((r) => r.y));
      const r = Math.max(...xs.map((r) => r.x + r.width)), b = Math.max(...xs.map((r) => r.y + r.height));
      return [{ id: 'span', phys: { x, y, width: r - x, height: b - y }, displays: ds }];
    }
    return ds.map((d) => ({ id: d.id, phys: d.phys, displays: [d] }));
  }

  assignment(slotId) {
    const a = this.settings.get('wallpaper.assignments') || {};
    if (this.layoutMode() === 'clone') return a.clone || a[Object.keys(a)[0]] || null;
    return a[slotId] || null;
  }

  // ---------- public API ----------
  async apply(itemId, slotId) {
    const mode = this.layoutMode();
    const key = mode === 'span' ? 'span' : mode === 'clone' ? 'clone' : (slotId || this.slotsWanted()[0].id);
    const a = { ...(this.settings.get('wallpaper.assignments') || {}) };
    a[key] = { itemId };
    this.settings.set('wallpaper.assignments', a);
    await this.sync();
  }

  async clear(slotId) {
    const a = { ...(this.settings.get('wallpaper.assignments') || {}) };
    if (slotId) delete a[slotId]; else for (const k of Object.keys(a)) delete a[k];
    this.settings.set('wallpaper.assignments', a);
    await this.sync();
  }

  itemProps(itemId) {
    return (this.settings.get('itemProps') || {})[itemId] || {};
  }

  setItemProps(itemId, props) {
    const all = { ...(this.settings.get('itemProps') || {}) };
    all[itemId] = { ...(all[itemId] || {}), ...props };
    this.settings.set('itemProps', all);
    for (const s of this.slots.values()) {
      if (s.item && s.item.id === itemId) this.sendProps(s, props);
    }
  }

  /** Effective property values: project defaults + saved user overrides. */
  resolvedProps(item) {
    const out = {};
    // Built-in display properties (every wallpaper): defaults, global values, then per-item overrides.
    for (const [k, v] of Object.entries(BUILTIN_DEFAULTS)) out['_ae_' + k] = { value: v };
    for (const [k, v] of Object.entries(this.settings.get('globalProps') || {})) if (k.startsWith('_ae_')) out[k] = { value: v };
    for (const [k, p] of Object.entries(item.properties || {})) out[k] = { ...p };
    for (const [k, v] of Object.entries(this.itemProps(item.id))) {
      if (out[k]) out[k].value = v; else out[k] = { value: v };
    }
    return out;
  }

  /** Reconciles windows with the desired assignments and displays. */
  /** Serialised: overlapping calls (layout change + apply) must not create duplicate windows. */
  sync() {
    const run = () => this._sync();
    this._syncChain = (this._syncChain || Promise.resolve()).then(run, run);
    return this._syncChain;
  }

  async _sync() {
    const wanted = this.slotsWanted();
    const wantedIds = new Set(wanted.map((w) => w.id));
    for (const [id, s] of this.slots) if (!wantedIds.has(id)) this.destroySlot(id);
    for (const w of wanted) {
      const asg = this.assignment(w.id);
      const item = asg && this.library.get(asg.itemId);
      const cur = this.slots.get(w.id);
      if (!item) { if (cur) this.destroySlot(w.id); continue; }
      if (cur && cur.item.id === item.id && !cur.stopped) {
        cur.phys = w.phys;
        if (cur.win && !cur.win.isDestroyed()) desktop.moveEmbedded(this.hwnd(cur.win), w.phys);
        continue;
      }
      if (cur) this.destroySlot(w.id);
      this.createSlot(w, item);
    }
    this.updateAudioNeeds();
    this.emit('changed', this.status());
  }

  status() {
    return {
      layout: this.layoutMode(),
      paused: this.userPaused,
      displays: this.displays().map((d) => ({ id: d.id, label: d.label, primary: d.primary, bounds: d.bounds, scaleFactor: d.scaleFactor })),
      slots: [...this.slots.entries()].map(([id, s]) => ({ id, itemId: s.item.id, title: s.item.title, type: s.item.type, state: s.state, stopped: !!s.stopped }))
    };
  }

  hwnd(win) { return desktop.hwndFromBuffer(win.getNativeWindowHandle()); }

  // ---------- windows ----------
  createSlot(w, item) {
    const isWeb = item.type === 'web';
    const dipBounds = screen.screenToDipRect(null, w.phys);
    const win = new BrowserWindow({
      x: dipBounds.x, y: dipBounds.y, width: Math.max(1, dipBounds.width), height: Math.max(1, dipBounds.height),
      show: false, frame: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, backgroundColor: '#000000', title: 'Astral Engine Layer',
      webPreferences: {
        preload: path.join(ROOT, 'preload', isWeb ? 'webWallpaper.js' : 'wallpaperHost.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        autoplayPolicy: 'no-user-gesture-required',
        partition: isWeb ? 'webwallpapers' : undefined,
        webSecurity: true,
        enableWebSQL: false
      }
    });
    win.setMenu(null);
    const slot = { id: w.id, win, item, phys: w.phys, state: 'run', webFrozen: false, stopped: false, displays: w.displays };
    this.slots.set(w.id, slot);

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) require('electron').shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !url.startsWith('astral:')) e.preventDefault(); });
    win.webContents.on('render-process-gone', () => {
      // Recover from crashes (e.g. GPU reset) by rebuilding the slot shortly after.
      if (this.slots.get(w.id) === slot) setTimeout(() => { if (this.slots.get(w.id) === slot) { this.destroySlot(w.id); this.sync(); } }, 2000);
    });

    const embed = () => {
      if (win.isDestroyed()) return;
      try {
        const mode = desktop.embedWindow(this.hwnd(win), w.phys);
        slot.embedMode = mode;
      } catch (e) {
        console.error('embed failed', e);
      }
      win.showInactive();
      desktop.embedWindow(this.hwnd(win), w.phys);
    };

    if (isWeb) {
      const entry = this.library.entryPath(item);
      win.loadFile(entry).catch((e) => console.error('web wallpaper load failed', e));
      win.webContents.once('did-finish-load', () => {
        embed();
        this.sendProps(slot, null);
        this.applyStateToSlot(slot, slot.state, true);
      });
    } else {
      win.loadFile(path.join(ROOT, 'renderer', 'wallpaper', 'host.html'), { query: { slot: w.id } });
      win.once('ready-to-show', embed);
    }
    return slot;
  }

  destroySlot(id) {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    if (s.win && !s.win.isDestroyed()) s.win.destroy();
    if (this.slots.size === 0) {
      // Repaint the regular Windows wallpaper so no frozen frame stays behind.
      setTimeout(() => { if (this.slots.size === 0) desktop.refreshSystemWallpaper(); }, 300);
    }
  }

  /** Data the wallpaper host page asks for at startup. */
  hostInit(slotId) {
    const s = this.slots.get(slotId);
    if (!s) return null;
    const item = s.item;
    return {
      slot: slotId,
      item: { id: item.id, type: item.type, supportsAudio: !!item.supportsAudio, title: item.title, dir: item.contentDir, file: item.file, entry: this.library.entryPath(item), preview: item.preview },
      props: this.resolvedProps(item),
      assetsDir: this.steamInfo.weAssetsDir,
      playback: this.settings.get('playback'),
      audio: this.settings.get('audio'),
      state: s.state,
      physSize: { width: s.phys.width, height: s.phys.height },
      displays: (s.displays || []).map((d) => ({ x: d.phys.x - s.phys.x, y: d.phys.y - s.phys.y, width: d.phys.width, height: d.phys.height }))
    };
  }

  sendProps(slot, changed) {
    if (!slot.win || slot.win.isDestroyed()) return;
    if (slot.item.type === 'web') {
      // Wallpaper Engine web API: window.wallpaperPropertyListener.applyUserProperties({...})
      const all = this.resolvedProps(slot.item);
      const payload = {};
      for (const [k, p] of Object.entries(all)) if (!changed || k in changed) payload[k] = { value: p.value, type: p.type };
      const gp = { fps: this.settings.get('playback.fps') };
      const js = `(function(){try{var l=window.wallpaperPropertyListener;if(l&&l.applyUserProperties)l.applyUserProperties(${JSON.stringify(payload)});if(l&&l.applyGeneralProperties)l.applyGeneralProperties(${JSON.stringify(gp)});}catch(e){console.error(e)}})()`;
      slot.win.webContents.executeJavaScript(js, true).catch(() => {});
      this.applyWebBuiltin(slot, all);
    } else {
      slot.win.webContents.send('wp:props', changed || this.resolvedProps(slot.item));
    }
  }

  /** Flip / colour options for web wallpapers, injected as page CSS. */
  async applyWebBuiltin(slot, all) {
    const v = (k, d) => (all['_ae_' + k] ? all['_ae_' + k].value : d);
    const parts = [];
    if (v('coloropts', false)) parts.push(`filter:brightness(${v('brightness', 100) / 100}) contrast(${v('contrast', 100) / 100}) saturate(${v('saturation', 100) / 100}) hue-rotate(${v('hue', 0)}deg)!important;`);
    if (v('flip', false)) parts.push('transform:scaleX(-1)!important;');
    const css = parts.length ? `html{${parts.join('')}}` : '';
    try {
      if (slot.webCssKey) { await slot.win.webContents.removeInsertedCSS(slot.webCssKey).catch(() => {}); slot.webCssKey = null; }
      if (css) slot.webCssKey = await slot.win.webContents.insertCSS(css);
      const vol = v('volume', 100) / 100, rate = v('rate', 1);
      slot.win.webContents.executeJavaScript(`document.querySelectorAll('video,audio').forEach(m=>{m.volume=Math.min(1,${vol});m.playbackRate=${rate}})`, true).catch(() => {});
    } catch { /* page not ready */ }
  }

  broadcast(channel, data) {
    for (const s of this.slots.values()) if (s.win && !s.win.isDestroyed()) s.win.webContents.send(channel, data);
  }

  onSettingsChanged(key) {
    if (key.startsWith('playback') || key.startsWith('audio')) {
      this.broadcast('wp:settings', { playback: this.settings.get('playback'), audio: this.settings.get('audio') });
      for (const s of this.slots.values()) if (s.item.type === 'web' && !s.win.isDestroyed()) {
        s.win.webContents.setAudioMuted(this.settings.get('audio.muted') || s.state === 'mute');
        this.sendProps(s, {});
      }
      this.evaluate();
    }
    if (key.startsWith('wallpaper.layout')) this.sync();
  }

  // ---------- playback policy ----------
  setUserPaused(p) { this.userPaused = p; this.settings.set('paused', !!p); this.evaluate(); this.emit('changed', this.status()); }

  ownPids() {
    const pids = [process.pid];
    for (const w of BrowserWindow.getAllWindows()) { try { pids.push(w.webContents.getOSProcessId()); } catch { /* ignore */ } }
    return pids;
  }

  desiredState(slot) {
    if (this.userPaused) return 'pause';
    const pb = this.settings.get('playback');
    let st = 'run';
    if (this.locked) st = pb.displayAsleepOrLocked === 'stop' ? 'stop' : 'pause';
    if (powerMonitor.isOnBatteryPower() && pb.onBattery !== 'run') st = max(st, pb.onBattery);
    const fg = this.fgCache;
    if (fg.state !== 'desktop') {
      const onThis = !pb.pauseAllPerMonitor || !fg.monitor || slot.id === 'span' || (slot.phys &&
        fg.monitor.x < slot.phys.x + slot.phys.width && fg.monitor.x + fg.monitor.width > slot.phys.x &&
        fg.monitor.y < slot.phys.y + slot.phys.height && fg.monitor.y + fg.monitor.height > slot.phys.y);
      const rule = fg.state === 'fullscreen' ? pb.otherAppFullscreen : fg.state === 'maximized' ? pb.otherAppMaximized : pb.otherAppFocused;
      if (fg.state === 'focused' || onThis) st = max(st, rule || 'run');
    }
    return st;
    function max(a, b) { return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a; }
  }

  evaluate() {
    for (const s of [...this.slots.values()]) {
      const st = this.desiredState(s);
      if (st !== s.state || (s.stopped && st !== 'stop')) this.applyStateToSlot(s, st);
    }
    // While everything is paused, hand idle memory back to Windows (once, after 5 s).
    const idle = this.slots.size > 0 && [...this.slots.values()].every((s) => s.state === 'pause' || s.state === 'stop');
    if (idle) {
      if (!this.idleSince) this.idleSince = Date.now();
      if (!this.trimmed && Date.now() - this.idleSince > 5000) {
        this.trimmed = true;
        try { desktop.trimWorkingSet(this.ownPids()); } catch { /* ignore */ }
      }
    } else { this.idleSince = 0; this.trimmed = false; }
  }

  applyStateToSlot(s, st, force) {
    const prev = s.state;
    s.state = st;
    if (st === 'stop') {
      // Free all memory for this slot; it is rebuilt when the rule no longer applies.
      if (!s.stopped) {
        s.stopped = true;
        if (s.win && !s.win.isDestroyed()) s.win.destroy();
        s.win = null;
        desktop.refreshSystemWallpaper();
      }
      return;
    }
    if (s.stopped) {
      const w = { id: s.id, phys: s.phys, displays: s.displays };
      this.slots.delete(s.id);
      const ns = this.createSlot(w, s.item);
      ns.state = st;
      return;
    }
    if (!s.win || s.win.isDestroyed()) return;
    const muted = this.settings.get('audio.muted') || st !== 'run';
    if (s.item.type === 'web') {
      s.win.webContents.setAudioMuted(muted);
      const freeze = st === 'pause';
      if (freeze !== s.webFrozen || force) {
        s.webFrozen = freeze;
        this.freezeWeb(s.win, freeze);
      }
    } else {
      s.win.webContents.send('wp:state', st);
    }
    if (prev !== st) this.emit('changed', this.status());
  }

  freezeWeb(win, freeze) {
    try {
      const dbg = win.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      dbg.sendCommand('Page.setWebLifecycleState', { state: freeze ? 'frozen' : 'active' }).catch(() => {});
    } catch { /* devtools open or detached */ }
  }

  // ---------- loops ----------
  start() {
    screen.on('display-added', () => this.sync());
    screen.on('display-removed', () => this.sync());
    screen.on('display-metrics-changed', () => this.sync());
    powerMonitor.on('lock-screen', () => { this.locked = true; this.evaluate(); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.evaluate(); });
    powerMonitor.on('suspend', () => { this.locked = true; this.evaluate(); });
    powerMonitor.on('resume', () => { this.locked = false; setTimeout(() => this.evaluate(), 1000); });
    powerMonitor.on('on-battery', () => this.evaluate());
    powerMonitor.on('on-ac', () => this.evaluate());

    // Foreground-window policy: 4 checks per second is plenty and costs well under 0.1% CPU.
    let tick = 0;
    this.pollTimer = setInterval(() => {
      if (this.slots.size === 0) return;
      try { this.fgCache = desktop.foregroundState(this.ownPids()); } catch { this.fgCache = { state: 'desktop' }; }
      this.evaluate();
      // Every ~5 s make sure Explorer hasn't dropped our windows (e.g. after an Explorer restart).
      if (++tick % 20 === 0) this.checkEmbedding();
    }, 250);

    this.startCursorLoop();
  }

  checkEmbedding() {
    for (const s of this.slots.values()) {
      if (!s.win || s.win.isDestroyed()) continue;
      const h = this.hwnd(s.win);
      if (!desktop.isEmbedded(h)) {
        try { desktop.embedWindow(h, s.phys); } catch { /* explorer not ready yet */ }
      }
    }
  }

  /** Feeds the cursor position (parallax / mouse effects) and desktop clicks to wallpapers. */
  startCursorLoop() {
    const koffiDesktop = desktop;
    let last = { x: -1, y: -1 };
    this.cursorTimer = setInterval(() => {
      if (this.slots.size === 0 || this.fgCache.state === 'fullscreen') return;
      const p = koffiDesktop.cursorPos();
      const moved = p.x !== last.x || p.y !== last.y;
      last = p;
      for (const s of this.slots.values()) {
        if (!s.win || s.win.isDestroyed() || s.state === 'pause' || s.state === 'stop') continue;
        const r = s.phys;
        const inside = p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
        if (!inside) continue;
        const lx = p.x - r.x, ly = p.y - r.y;
        if (s.item.type === 'web') {
          if (moved && this.fgCache.state === 'desktop') {
            const sf = r.width / Math.max(1, s.win.getBounds().width);
            try { s.win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(lx / sf), y: Math.round(ly / sf) }); } catch { /* ignore */ }
          }
        } else if (moved) {
          s.win.webContents.send('wp:cursor', { x: lx / r.width, y: ly / r.height });
        }
      }
    }, 33);
  }

  updateAudioNeeds() {
    if (!this.audio) return;
    // Only capture system audio when a running wallpaper declares it is audio-responsive.
    const need = this.settings.get('audio.audioVisualizer') && [...this.slots.values()].some((s) => s.item.supportsAudio && s.item.type === 'web' && !s.stopped);
    this.audio.setEnabled(!!need);
  }

  pushAudio(samples) {
    for (const s of this.slots.values()) {
      if (!s.win || s.win.isDestroyed() || s.state !== 'run') continue;
      s.win.webContents.send('wp:audio', samples);
    }
  }

  shutdown() {
    clearInterval(this.pollTimer);
    clearInterval(this.cursorTimer);
    for (const id of [...this.slots.keys()]) {
      const s = this.slots.get(id);
      if (s && s.win && !s.win.isDestroyed()) s.win.destroy();
    }
    this.slots.clear();
    try { desktop.refreshSystemWallpaper(); } catch { /* ignore */ }
  }
}

module.exports = { WallpaperManager };
