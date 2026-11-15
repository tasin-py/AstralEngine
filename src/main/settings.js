'use strict';
// Persistent settings stored as JSON in the user data folder (atomic writes).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  language: 'en',
  theme: { accent: '#3d8bfd', mode: 'dark' },
  startWithWindows: true,
  startMinimized: true,
  // Playback rules (like Wallpaper Engine's Performance tab)
  playback: {
    otherAppFocused: 'run',        // run | mute | pause | stop
    otherAppMaximized: 'pause',
    otherAppFullscreen: 'pause',
    onBattery: 'pause',            // run | pause | stop
    displayAsleepOrLocked: 'pause',
    fps: 30,                       // 10..144
    quality: 'medium',             // low | medium | high | ultra (render scale)
    msaa: false,
    pauseAllPerMonitor: true       // only pause the monitor that is covered
  },
  audio: { volume: 50, muted: false, muteWhenOtherAppPlays: false, audioVisualizer: true },
  taskbar: { mode: 'normal', color: '#00000000' }, // normal | transparent | blur | acrylic | opaque
  wallpaper: {
    layout: 'per-monitor',         // per-monitor | span | clone
    assignments: {},               // displayId -> { itemId, props }
    lastSpan: null
  },
  playlists: [],                    // { id, name, items:[itemId], intervalMin, order:'sequential'|'random', mode:'timer'|'daytime'|'login' }
  activePlaylist: {},               // displayId -> { playlistId, index, startedAt }
  library: { extraFolders: [], imported: [], favorites: [], sort: 'name', filters: {} },
  workshop: { apiKey: '', defaultSort: 'trend', contentRating: ['Everyone'], openIn: 'steam' },
  // Optional features. Off = the feature is fully unloaded (no windows, timers or network use).
  features: { widgets: true, rainmeter: true, workshop: true, playlists: true, taskbar: true },
  paused: false,                    // user pressed Pause (restored on next launch)
  window: { bounds: null, maximized: false },
  ui: {},                           // library view state: tab, sort, filters, panel
  presets: [],                     // { name, props }
  globalProps: {},                  // built-in display props applied to every wallpaper
  widgets: [],                      // { id, type, x, y, w, h, displayId, options }
  rainmeter: { path: '', closeWithApp: false },
  updates: { repo: '', autoCheck: true, lastCheck: 0, skipVersion: '' },
  advanced: { hardwareAcceleration: true, debug: false, keepUIInMemory: false }
};

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object' && !Array.isArray(over)) {
      for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    }
    return out;
  }
  return over === undefined ? base : over;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run or corrupt */ }
    this.data = deepMerge(DEFAULTS, data);
    this._timer = null;
    this.listeners = new Set();
  }
  get(key) {
    if (!key) return this.data;
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }
  set(key, value) {
    const parts = key.split('.');
    let o = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    this.save();
    for (const l of this.listeners) { try { l(key, value); } catch { /* ignore */ } }
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this._timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS, deepMerge };
