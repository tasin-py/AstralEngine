'use strict';
// Renders assets/icon.svg to PNGs and a multi-size Windows .ico.  Run: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];

function buildIco(pngs) {
  const list = pngs.filter((p) => p.size <= 256);
  const header = Buffer.alloc(6 + 16 * list.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(list.length, 4);
  let offset = header.length;
  list.forEach((p, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    header.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    header.writeUInt8(0, o + 2); header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4); header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(p.buf.length, o + 8); header.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, ...list.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<html><body style="margin:0"></body></html>');
  const out = [];
  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((res) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, ${size}, ${size}); res(c.toDataURL('image/png')); };
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    out.push({ size, buf });
  }
  const get = (s) => out.find((p) => p.size === s).buf;
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), get(256));
  fs.writeFileSync(path.join(ASSETS, 'icon512.png'), get(512));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), get(32));
  fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), get(64));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(out));
  console.log('icons written:', SIZES.join(', '));
  app.exit(0);
});
