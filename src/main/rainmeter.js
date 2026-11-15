'use strict';
// Rainmeter integration: discover skins, show their metadata, load/unload them,
// install .rmskin packages and switch layouts by driving Rainmeter's bang commands.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');

function regQuery(key, value) {
  try {
    const args = ['query', key];
    if (value === '') args.push('/ve'); else args.push('/v', value);
    const out = execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_\w+\s+(.*)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function parseIni(text) {
  const out = {};
  let sect = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { sect = s[1]; out[sect] = out[sect] || {}; continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && sect) out[sect][kv[1].trim()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function readText(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}

class Rainmeter {
  constructor(settings) { this.settings = settings; }

  exePath() {
    const custom = this.settings.get('rainmeter.path');
    const cands = [
      custom,
      regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Rainmeter', ''),
      regQuery('HKLM\\SOFTWARE\\Rainmeter', ''),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Rainmeter'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Rainmeter'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Rainmeter')
    ].filter(Boolean);
    for (const c of cands) {
      const exe = c.toLowerCase().endsWith('.exe') ? c : path.join(c, 'Rainmeter.exe');
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }

  settingsFile() {
    const portable = this.exePath() && path.join(path.dirname(this.exePath()), 'Rainmeter.ini');
    if (portable && fs.existsSync(portable)) return portable;
    return path.join(process.env.APPDATA || '', 'Rainmeter', 'Rainmeter.ini');
  }

  readConfig() {
    try { return parseIni(readText(this.settingsFile())); } catch { return {}; }
  }

  skinsDir() {
    const cfg = this.readConfig();
    const p = cfg.Rainmeter && cfg.Rainmeter.SkinPath;
    if (p && fs.existsSync(p)) return p;
    return path.join(os.homedir(), 'Documents', 'Rainmeter', 'Skins');
  }

  isRunning() {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Rainmeter.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /Rainmeter\.exe/i.test(out);
    } catch { return false; }
  }

  status() {
    const exe = this.exePath();
    return { installed: !!exe, exe, running: exe ? this.isRunning() : false, skinsDir: this.skinsDir(), downloadUrl: 'https://www.rainmeter.net/' };
  }

  /** Lists skins grouped by root folder; each config has its .ini variants and metadata. */
  listSkins() {
    const root = this.skinsDir();
    const cfg = this.readConfig();
    const skins = [];
    if (!fs.existsSync(root)) return skins;
    const walk = (dir, rel) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const inis = ents.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ini')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
      if (rel && inis.length) {
        const sect = cfg[rel] || {};
        const activeIdx = Number(sect.Active || 0);
        let meta = {};
        try { meta = parseIni(readText(path.join(dir, inis[Math.max(0, activeIdx - 1)] || inis[0]))).Metadata || {}; } catch { /* ignore */ }
        skins.push({
          config: rel,
          root: rel.split('\\')[0],
          dir,
          files: inis,
          active: activeIdx > 0,
          activeFile: activeIdx > 0 ? inis[activeIdx - 1] : null,
          name: meta.Name || rel.split('\\').pop(),
          author: meta.Author || '',
          info: meta.Information || '',
          version: meta.Version || '',
          x: sect.WindowX, y: sect.WindowY
        });
      }
      for (const e of ents) {
        if (e.isDirectory() && !e.name.startsWith('@')) walk(path.join(dir, e.name), rel ? rel + '\\' + e.name : e.name);
      }
    };
    walk(root, '');
    return skins;
  }

  listLayouts() {
    const dir = path.join(path.dirname(this.settingsFile()), 'Layouts');
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  }

  bang(...args) {
    const exe = this.exePath();
    if (!exe) return Promise.reject(new Error('Rainmeter is not installed'));
    return new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: 15000 }, (err) => (err && err.code !== 0 && err.killed ? reject(err) : resolve(true)));
    });
  }

  /** Asks Rainmeter to close (normal close, it saves its layout). */
  quit() {
    if (!this.isRunning()) return Promise.resolve(false);
    return new Promise((resolve) => execFile('taskkill', ['/IM', 'Rainmeter.exe'], { windowsHide: true }, () => resolve(true)));
  }

  async ensureRunning() {
    if (this.isRunning()) return;
    const exe = this.exePath();
    if (!exe) throw new Error('Rainmeter is not installed');
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    for (let i = 0; i < 20 && !this.isRunning(); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 800));
  }

  async activate(config, file) { await this.ensureRunning(); return this.bang('!ActivateConfig', config, file); }
  async deactivate(config) { if (!this.isRunning()) return true; return this.bang('!DeactivateConfig', config); }
  async refreshAll() { await this.ensureRunning(); return this.bang('!RefreshApp'); }
  async loadLayout(name) { await this.ensureRunning(); return this.bang('!LoadLayout', name); }
  async manage() { await this.ensureRunning(); return this.bang('!Manage'); }
  async edit(config, file) { await this.ensureRunning(); return this.bang('!EditSkin', config, file); }

  installPackage(file) {
    const exe = this.exePath();
    if (!exe) throw new Error('Rainmeter is not installed');
    const installer = path.join(path.dirname(exe), 'SkinInstaller.exe');
    spawn(fs.existsSync(installer) ? installer : exe, fs.existsSync(installer) ? [file] : ['!InstallSkin', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  quit() { return this.isRunning() ? this.bang('!Quit') : Promise.resolve(true); }
}

module.exports = { Rainmeter, parseIni };
