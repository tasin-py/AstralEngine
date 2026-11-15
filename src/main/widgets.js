'use strict';
// Desktop widgets (clock, calendar, system monitor, weather, notes, visualizer...).
// All widget windows are opened from one hidden host page with window.open(), so they
// share a single renderer process instead of one process per widget.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow, screen, ipcMain } = require('electron');
const desktop = require('./desktop');

const TYPES = {
  clock: { w: 320, h: 140, name: 'Digital clock' },
  analog: { w: 220, h: 220, name: 'Analog clock' },
  calendar: { w: 300, h: 300, name: 'Calendar' },
  sysmon: { w: 280, h: 180, name: 'System monitor' },
  weather: { w: 300, h: 170, name: 'Weather' },
  notes: { w: 260, h: 240, name: 'Sticky note' },
  visualizer: { w: 420, h: 140, name: 'Audio visualizer' },
  battery: { w: 200, h: 90, name: 'Battery' },
  countdown: { w: 300, h: 130, name: 'Countdown' },
  photo: { w: 300, h: 220, name: 'Photo frame' },
  quote: { w: 360, h: 140, name: 'Quote of the day' }
};

class Widgets {
  constructor(settings) {
    this.settings = settings;
    this.host = null;
    this.windows = new Map(); // widgetId -> BrowserWindow
    this.statsTimer = null;
    this.prevCpu = null;
    this.visible = true;
    this.saveTimers = new Map();
  }

  list() { return this.settings.get('widgets') || []; }
  saveList(list) { this.settings.set('widgets', list); }
  types() { return Object.entries(TYPES).map(([id, t]) => ({ id, ...t })); }

  start() {
    if (this.list().length) this.ensureHost();
  }

  ensureHost() {
    if (this.host && !this.host.isDestroyed()) return this.host;
    this.host = new BrowserWindow({
      show: false, width: 10, height: 10, skipTaskbar: true, focusable: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'widget.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false }
    });
    this.host.webContents.setWindowOpenHandler(({ frameName }) => {
      const cfg = this.list().find((w) => w.id === frameName);
      if (!cfg) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: Math.round(cfg.x), y: Math.round(cfg.y), width: Math.round(cfg.w), height: Math.round(cfg.h),
          frame: false, transparent: true, resizable: !cfg.locked, movable: true, minimizable: false, maximizable: false,
          skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000', show: false, title: 'Astral Widget',
          webPreferences: { preload: path.join(__dirname, '..', 'preload', 'widget.js'), contextIsolation: true, sandbox: true, backgroundThrottling: true, spellcheck: false }
        }
      };
    });
    this.host.webContents.on('did-create-window', (win, { frameName }) => this.attach(frameName, win));
    this.host.loadFile(path.join(__dirname, '..', 'renderer', 'widgets', 'host.html'));
    this.host.webContents.once('did-finish-load', () => { for (const w of this.list()) this.open(w); });
    this.host.webContents.on('render-process-gone', () => { this.windows.clear(); this.host = null; setTimeout(() => this.start(), 2000); });
    return this.host;
  }

  open(cfg) {
    if (!this.host || this.host.isDestroyed()) return this.ensureHost();
    if (this.windows.has(cfg.id)) return;
    this.host.webContents.send('widgets:open', cfg.id);
  }

  attach(id, win) {
    this.windows.set(id, win);
    const hwnd = () => desktop.hwndFromBuffer(win.getNativeWindowHandle());
    win.setMenu(null);
    win.once('ready-to-show', () => {
      if (this.visible) win.showInactive();
      desktop.sendToBottom(hwnd());
      const cfg = this.list().find((w) => w.id === id);
      if (cfg && cfg.locked) desktop.setClickThrough(hwnd(), !!cfg.clickThrough);
    });
    // Keep widgets on the desktop level, not over other apps.
    win.on('blur', () => { if (!win.isDestroyed()) desktop.sendToBottom(hwnd()); });
    const persist = () => {
      if (win.isDestroyed()) return;
      clearTimeout(this.saveTimers.get(id));
      this.saveTimers.set(id, setTimeout(() => {
        const b = win.getBounds();
        this.update(id, { x: b.x, y: b.y, w: b.width, h: b.height }, true);
      }, 400));
    };
    win.on('moved', persist);
    win.on('resized', persist);
    win.on('closed', () => { this.windows.delete(id); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) require('electron').shell.openExternal(url); return { action: 'deny' }; });
    this.ensureStats();
  }

  add(type, displayId) {
    const t = TYPES[type];
    if (!t) throw new Error('Unknown widget type');
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
    const n = this.list().length;
    const wa = d.workArea;
    const cfg = {
      id: 'w' + crypto.randomBytes(4).toString('hex'), type,
      x: wa.x + wa.width - t.w - 40 - (n % 4) * 30, y: wa.y + 40 + (n % 6) * (t.h + 16),
      w: t.w, h: t.h, locked: false, clickThrough: false,
      options: { theme: 'glass', accent: '#3d8bfd', opacity: 0.85, scale: 1 }
    };
    this.saveList([...this.list(), cfg]);
    this.ensureHost();
    if (this.host.webContents.isLoading()) return cfg; // opened on load
    this.open(cfg);
    return cfg;
  }

  remove(id) {
    this.saveList(this.list().filter((w) => w.id !== id));
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.close();
    this.windows.delete(id);
    if (!this.list().length) this.stopAll();
  }

  update(id, patch, fromWindow) {
    const list = this.list().map((w) => (w.id === id ? { ...w, ...patch, options: { ...w.options, ...(patch.options || {}) } } : w));
    this.saveList(list);
    const cfg = list.find((w) => w.id === id);
    const win = this.windows.get(id);
    if (!cfg || !win || win.isDestroyed()) return cfg;
    if (!fromWindow) {
      if ('x' in patch || 'w' in patch) win.setBounds({ x: Math.round(cfg.x), y: Math.round(cfg.y), width: Math.round(cfg.w), height: Math.round(cfg.h) });
      if ('locked' in patch) { win.setResizable(!cfg.locked); }
      if ('locked' in patch || 'clickThrough' in patch) desktop.setClickThrough(desktop.hwndFromBuffer(win.getNativeWindowHandle()), !!(cfg.locked && cfg.clickThrough));
    }
    win.webContents.send('widget:config', cfg);
    return cfg;
  }

  config(id) { return this.list().find((w) => w.id === id) || null; }

  setVisible(v) {
    this.visible = v;
    for (const win of this.windows.values()) if (!win.isDestroyed()) (v ? win.showInactive() : win.hide());
  }

  // Re-assert desktop level (after Win+D or Explorer restarts).
  keepOnDesktop() {
    if (!this.visible) return;
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) continue;
      if (!win.isVisible()) win.showInactive();
      if (!win.isFocused()) desktop.sendToBottom(desktop.hwndFromBuffer(win.getNativeWindowHandle()));
    }
  }

  // ---- system stats for the system-monitor widget ----
  ensureStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => this.pushStats(), 2000);
  }

  cpuPercent() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
    const prev = this.prevCpu;
    this.prevCpu = { idle, total };
    if (!prev) return 0;
    const dt = total - prev.total;
    return dt > 0 ? Math.round(100 * (1 - (idle - prev.idle) / dt)) : 0;
  }

  pushStats() {
    const sysmon = [...this.windows.entries()].filter(([id]) => (this.config(id) || {}).type === 'sysmon');
    if (!sysmon.length) return;
    let disk = null;
    try { const s = fs.statfsSync('C:\\'); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { /* ignore */ }
    const stats = {
      cpu: this.cpuPercent(), cpuName: (os.cpus()[0] || {}).model || 'CPU', cores: os.cpus().length,
      memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(), disk
    };
    for (const [, win] of sysmon) if (!win.isDestroyed()) win.webContents.send('widget:stats', stats);
  }

  pushAudio(samples) {
    for (const [id, win] of this.windows) {
      if (!win.isDestroyed() && (this.config(id) || {}).type === 'visualizer') win.webContents.send('widget:audio', samples);
    }
  }

  needsAudio() { return this.list().some((w) => w.type === 'visualizer'); }

  stopAll() {
    clearInterval(this.statsTimer); this.statsTimer = null;
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
  }
}

module.exports = { Widgets, TYPES };
