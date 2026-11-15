'use strict';
// Steam client integration: locate Steam, its libraries, the Wallpaper Engine workshop
// content folder and the signed-in account. Downloads are handled by the Steam client
// itself (items you subscribe to are downloaded into steamapps/workshop/content/431960).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseVdf } = require('./vdf');

const WE_APPID = '431960';

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function findSteamPath() {
  const candidates = [
    regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ].filter(Boolean).map((p) => path.normalize(p.replace(/\//g, '\\')));
  return candidates.find((p) => fs.existsSync(path.join(p, 'steamapps'))) || null;
}

function readVdfFile(file) {
  try { return parseVdf(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function libraryFolders(steamPath) {
  const libs = new Set();
  if (!steamPath) return [];
  libs.add(path.normalize(steamPath));
  const vdf = readVdfFile(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  const root = vdf && (vdf.libraryfolders || vdf.LibraryFolders);
  if (root) {
    for (const k of Object.keys(root)) {
      const v = root[k];
      const p = typeof v === 'string' ? v : v && v.path;
      if (p && fs.existsSync(p)) libs.add(path.normalize(p));
    }
  }
  return [...libs];
}

function steamUser(steamPath) {
  const vdf = readVdfFile(path.join(steamPath || '', 'config', 'loginusers.vdf'));
  const users = vdf && vdf.users;
  if (!users) return null;
  let best = null;
  for (const id of Object.keys(users)) {
    const u = users[id];
    const entry = { steamId: id, personaName: u.PersonaName, accountName: u.AccountName, mostRecent: u.MostRecent === '1', timestamp: Number(u.Timestamp || 0) };
    if (!best || entry.mostRecent || entry.timestamp > best.timestamp) best = entry;
  }
  return best;
}

function isSteamRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /steam\.exe/i.test(out);
  } catch { return false; }
}

/** Everything the app needs to know about Steam + Wallpaper Engine on this PC. */
function detect() {
  const steamPath = findSteamPath();
  const libs = libraryFolders(steamPath);
  let weInstallDir = null;
  let weOwned = false;
  const workshopDirs = [];
  for (const lib of libs) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${WE_APPID}.acf`);
    if (fs.existsSync(manifest)) {
      weOwned = true;
      const acf = readVdfFile(manifest);
      const dir = acf && acf.AppState && acf.AppState.installdir;
      const full = path.join(lib, 'steamapps', 'common', dir || 'wallpaper_engine');
      if (fs.existsSync(full)) weInstallDir = full;
    }
    const ws = path.join(lib, 'steamapps', 'workshop', 'content', WE_APPID);
    if (fs.existsSync(ws)) workshopDirs.push(ws);
  }
  return {
    steamPath,
    libraries: libs,
    weOwned,
    weInstallDir,
    weAssetsDir: weInstallDir && fs.existsSync(path.join(weInstallDir, 'assets')) ? path.join(weInstallDir, 'assets') : null,
    workshopDirs,
    user: steamPath ? steamUser(steamPath) : null,
    running: isSteamRunning()
  };
}

/** Items the signed-in user is subscribed to, per Steam's workshop manifest. */
function subscribedItemIds(info) {
  const ids = new Set();
  for (const lib of info.libraries || []) {
    const acf = readVdfFile(path.join(lib, 'steamapps', 'workshop', `appworkshop_${WE_APPID}.acf`));
    const st = acf && acf.AppWorkshop;
    if (!st) continue;
    for (const sect of ['WorkshopItemsInstalled', 'WorkshopItemDetails']) {
      if (st[sect]) Object.keys(st[sect]).forEach((k) => ids.add(k));
    }
  }
  return [...ids];
}

module.exports = { detect, subscribedItemIds, findSteamPath, libraryFolders, WE_APPID };
