'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('astralAudio', {
  send: (arr) => ipcRenderer.send('audio:samples', arr),
  onPaused: (cb) => ipcRenderer.on('audio:paused', (e, p) => cb(p))
});
