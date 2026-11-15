'use strict';
// System audio capture (WASAPI loopback through Chromium) for audio-responsive wallpapers.
// A tiny hidden window is created only while a running wallpaper needs audio data.

const path = require('path');
const { BrowserWindow, desktopCapturer, session, ipcMain } = require('electron');

class AudioCapture {
  constructor() {
    this.win = null;
    this.enabled = false;
    this.onSamples = null;
    this.ses = session.fromPartition('audiocapture');
    this.ses.setDisplayMediaRequestHandler((req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
    });
    this.ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || perm === 'display-capture'));
    ipcMain.on('audio:samples', (e, arr) => {
      if (this.win && e.sender === this.win.webContents && this.onSamples) this.onSamples(arr);
    });
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.open(); else this.close();
  }

  open() {
    if (this.win && !this.win.isDestroyed()) return;
    this.win = new BrowserWindow({
      show: false, width: 64, height: 64, skipTaskbar: true, focusable: false,
      webPreferences: {
        partition: 'audiocapture', preload: path.join(__dirname, '..', 'preload', 'audio.js'),
        contextIsolation: true, sandbox: true, backgroundThrottling: false
      }
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'audio', 'audio.html'));
    this.win.webContents.on('render-process-gone', () => { this.win = null; if (this.enabled) setTimeout(() => this.open(), 3000); });
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  setPaused(p) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('audio:paused', p);
  }
}

module.exports = { AudioCapture };
