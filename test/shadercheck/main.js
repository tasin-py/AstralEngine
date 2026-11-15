'use strict';
// Compiles every Wallpaper Engine effect shader found (assets + workshop scene.pkg files)
// through our translator in a real WebGL2 context. Read-only. Run: npx electron test/shadercheck
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.webContents.on('console-message', (e) => console.log(e.message));
  await win.loadFile(path.join(__dirname, 'index.html'));
  const res = await win.webContents.executeJavaScript('window.done');
  console.log(JSON.stringify(res.summary));
  require('fs').writeFileSync(path.join(__dirname, 'last-result.json'), JSON.stringify(res, null, 1));
  app.exit(res.summary.failed ? 1 : 0);
});
