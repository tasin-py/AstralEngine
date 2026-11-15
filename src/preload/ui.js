'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const EVENTS = new Set(['lib:changed', 'wp:changed', 'win:state', 'ui:navigate', 'update:available', 'update:progress']);
contextBridge.exposeInMainWorld('astral', {
  invoke: async (ch, ...args) => {
    const r = await ipcRenderer.invoke(ch, ...args);
    if (r && r.ok === false) { const e = new Error(r.error); e.code = r.code; throw e; }
    return r ? r.data : r;
  },
  on: (ch, cb) => { if (!EVENTS.has(ch)) return () => {}; const f = (e, d) => cb(d); ipcRenderer.on(ch, f); return () => ipcRenderer.off(ch, f); },
  win: { minimize: () => ipcRenderer.send('win:minimize'), maximize: () => ipcRenderer.send('win:maximize'), close: () => ipcRenderer.send('win:close') },
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } }
});
