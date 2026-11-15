'use strict';
// Wallpaper Engine web wallpaper API shim (runs in an isolated world).
const { contextBridge, ipcRenderer } = require('electron');
const audioListeners = [];
contextBridge.exposeInMainWorld('wallpaperRegisterAudioListener', (cb) => { if (typeof cb === 'function') audioListeners.push(cb); });
contextBridge.exposeInMainWorld('wallpaperRegisterMediaStatusListener', () => {});
contextBridge.exposeInMainWorld('wallpaperRegisterMediaPropertiesListener', () => {});
contextBridge.exposeInMainWorld('wallpaperRegisterMediaThumbnailListener', () => {});
contextBridge.exposeInMainWorld('wallpaperRegisterMediaPlaybackListener', () => {});
contextBridge.exposeInMainWorld('wallpaperRegisterMediaTimelineListener', () => {});
contextBridge.exposeInMainWorld('wallpaperRequestRandomFileForProperty', () => {});
ipcRenderer.on('wp:audio', (e, arr) => { for (const cb of audioListeners) { try { cb(arr); } catch { /* wallpaper bug */ } } });
