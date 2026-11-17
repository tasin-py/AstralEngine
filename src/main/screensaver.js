'use strict';
// Screensaver mode: after the PC has had no keyboard/mouse input for a while, every display gets a
// full-screen window playing its wallpaper (or one chosen wallpaper). Any input closes it again.

const path = require('path');
const { BrowserWindow, screen, powerMonitor } = require('electron');
const { EventEmitter } = require('events');
const desktop = require('./desktop');

const ROOT = path.join(__dirname, '..');
const HIDE_CURSOR = '*{cursor:none!important}';

class Screensaver extends EventEmitter {
  constructor({ settings, library, manager }) {
    super();
    this.settings = settings;
    this.library = library;
    this.manager = manager;
    this.slots = new Map();   // 'ss:<displayId>' -> { id, win, item, phys, displays, state }
    this.active = false;
    this.timer = null;
    this.watch = null;
  }

  cfg() { return this.settings.get('screensaver') || {}; }

  /** Starts or stops the idle check to match the settings. Off = no timer at all. */
  refresh() {
    const on = !!this.cfg().enabled;
    if (on && !this.timer) this.timer = setInterval(() => this.check(), 5000);
    if (!on && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  check() {
    if (this.active || this.manager.locked) return;
    const mins = Math.max(1, Number(this.cfg().idleMinutes) || 10);
    if (powerMonitor.getSystemIdleTime() < mins * 60) return;
    // Never cover a game, video or presentation that is running full screen.
    try { if (desktop.foregroundState(this.manager.ownPids()).state === 'fullscreen') return; } catch { /* ignore */ }
    this.start(false);
  }

  /** Which wallpaper each display shows. */
  itemFor(displayId) {
    const src = this.cfg().source || 'current';
    if (src !== 'current') return this.library.get(src);
    const m = this.manager;
    const mode = m.layoutMode();
    const asg = mode === 'span' ? m.assignment('span') : m.assignment(displayId);
    return asg ? this.library.get(asg.itemId) : null;
  }

  start(preview) {
    if (this.active) return;
    this.active = true;
    this.armAt = Infinity;
    this.manager.saverActive = true;
    this.manager.evaluate();
    for (const d of this.manager.displays()) this.createWindow(d);
    // Close on any keyboard or mouse input. Windows resets the idle time on every input, so a drop in
    // the idle time means the user is back. A short grace period stops the click on "Preview" (or a
    // nudge of the mouse right away) from closing it immediately.
    const armAt = this.armAt = Date.now() + (preview ? 2000 : 500);
    let last = powerMonitor.getSystemIdleTime();
    this.watch = setInterval(() => {
      const idle = powerMonitor.getSystemIdleTime();
      if (Date.now() < armAt) { last = idle; return; }
      if (idle < last || (idle === 0 && last === 0)) this.stop(true);
      else last = idle;
    }, 200);
    this.emit('changed', true);
  }

  createWindow(d) {
    const id = 'ss:' + d.id;
    const item = this.itemFor(d.id);
    const isWeb = item && item.type === 'web';
    const b = d.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      show: false, frame: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, focusable: true, hasShadow: false, backgroundColor: '#000000', title: 'Astral Engine Screensaver',
      webPreferences: {
        preload: path.join(ROOT, 'preload', isWeb ? 'webWallpaper.js' : 'wallpaperHost.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false,
        autoplayPolicy: 'no-user-gesture-required', partition: isWeb ? 'webwallpapers' : undefined, webSecurity: true
      }
    });
    win.setMenu(null);
    const slot = { id, win, item, phys: d.phys, displays: [d], state: this.cfg().mute === false ? 'run' : 'mute' };
    this.slots.set(id, slot);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('before-input-event', () => { if (Date.now() >= this.armAt) this.stop(true); }); // key presses while focused

    const show = () => {
      if (win.isDestroyed()) return;
      win.webContents.insertCSS(HIDE_CURSOR).catch(() => {});
      if (process.env.ASTRAL_OFFSCREEN === '1') { win.setPosition(-20000, -20000); win.showInactive(); return; }
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(b);
      win.setFullScreen(true); // covers the taskbar on that display
      win.show();
      win.focus();
    };
    if (!item) {
      // Nothing assigned to this display: a plain black screen.
      win.loadURL('data:text/html,<body style="background:#000"></body>');
      win.once('ready-to-show', show);
    } else if (isWeb) {
      win.loadFile(this.library.entryPath(item)).catch(() => {});
      win.webContents.once('did-finish-load', () => {
        show();
        win.webContents.setAudioMuted(slot.state === 'mute' || !!this.settings.get('audio.muted'));
        this.manager.sendProps(slot, null);
      });
    } else {
      win.loadFile(path.join(ROOT, 'renderer', 'wallpaper', 'host.html'), { query: { slot: id } });
      win.once('ready-to-show', show);
    }
  }

  stop(byUser) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.watch); this.watch = null;
    for (const s of this.slots.values()) if (s.win && !s.win.isDestroyed()) s.win.destroy();
    this.slots.clear();
    this.manager.saverActive = false;
    this.manager.evaluate();
    if (byUser && this.cfg().lockOnExit && process.env.ASTRAL_OFFSCREEN !== '1') { try { desktop.lockWorkstation(); } catch { /* ignore */ } }
    this.emit('changed', false);
  }

  shutdown() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stop(false);
  }
}

module.exports = { Screensaver };
