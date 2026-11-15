'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('host', {
  init: (slot) => ipcRenderer.invoke('host:init', slot),
  error: (msg) => ipcRenderer.send('host:error', String(msg)),
  on: (ch, cb) => {
    if (!['wp:props', 'wp:state', 'wp:settings', 'wp:cursor', 'wp:audio'].includes(ch)) return;
    ipcRenderer.on(ch, (e, d) => cb(d));
  }
});
