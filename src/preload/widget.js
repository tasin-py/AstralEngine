'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('widgetApi', {
  config: (id) => ipcRenderer.invoke('widget:config', id),
  update: (id, patch) => ipcRenderer.invoke('widget:update', id, patch),
  remove: (id) => ipcRenderer.invoke('widget:remove', id),
  addNear: (id, type, options) => ipcRenderer.invoke('widget:addNear', id, type, options),
  fileUrl: (p) => ipcRenderer.invoke('widget:fileUrl', p),
  on: (ch, cb) => { if (['widget:config', 'widget:stats', 'widget:audio', 'widgets:open'].includes(ch)) ipcRenderer.on(ch, (e, d) => cb(d)); }
});
