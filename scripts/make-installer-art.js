'use strict';
// Draws the dark installer artwork (NSIS needs 24-bit BMP files).
// Run: npx electron scripts/make-installer-art.js   → build/installerSidebar.bmp, build/installerHeader.bmp …
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');

/** RGBA pixels (top-down) → 24-bit bottom-up BMP. */
function toBmp(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      b[dst + x * 3] = rgba[s + 2]; b[dst + x * 3 + 1] = rgba[s + 1]; b[dst + x * 3 + 2] = rgba[s];
    }
  }
  return b;
}

const DRAW = `
async function draw(kind, w, h, iconUrl) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const icon = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = iconUrl; });
  const bg = x.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, '#20232b'); bg.addColorStop(1, '#16181d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  if (kind === 'sidebar') {
    // soft glow + waves, like the app icon
    const g = x.createRadialGradient(w / 2, 110, 10, w / 2, 110, 140);
    g.addColorStop(0, 'rgba(110,90,255,0.45)'); g.addColorStop(1, 'rgba(110,90,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      x.strokeStyle = 'rgba(61,139,253,' + (0.5 - i * 0.1) + ')'; x.lineWidth = 2;
      x.beginPath();
      for (let px = 0; px <= w; px += 2) { const py = h - 70 + i * 12 + Math.sin(px / 22 + i) * 6; px ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke();
    }
    x.drawImage(icon, w / 2 - 44, 66, 88, 88);
    x.fillStyle = '#ffffff'; x.textAlign = 'center';
    x.font = '600 19px "Segoe UI", sans-serif'; x.fillText('Astral', w / 2, 188);
    x.font = '600 19px "Segoe UI", sans-serif'; x.fillText('Engine', w / 2, 212);
    x.fillStyle = '#8b93a3'; x.font = '11px "Segoe UI", sans-serif'; x.fillText('Live wallpapers for Windows', w / 2, 236);
    x.fillStyle = '#3d8bfd'; x.fillRect(w / 2 - 18, 248, 36, 2);
  } else {
    x.fillStyle = '#3d8bfd'; x.fillRect(0, h - 2, w, 2);
    x.drawImage(icon, w - 52, (h - 44) / 2, 44, 44);
  }
  return Array.from(x.getImageData(0, 0, w, h).data);
}`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'icon512.png')).toString('base64');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');
  await win.webContents.executeJavaScript(DRAW + ';window.draw=draw;0');
  const jobs = [
    ['installerSidebar.bmp', 'sidebar', 164, 314],
    ['uninstallerSidebar.bmp', 'sidebar', 164, 314],
    ['installerHeader.bmp', 'header', 150, 57]
  ];
  for (const [file, kind, w, h] of jobs) {
    const px = await win.webContents.executeJavaScript(`draw(${JSON.stringify(kind)}, ${w}, ${h}, ${JSON.stringify(icon)})`);
    fs.writeFileSync(path.join(OUT, file), toBmp(w, h, px));
    console.log('wrote', file);
  }
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.ico'), path.join(OUT, 'icon.ico'));
  app.quit();
});
