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

  /** Where the one-click install puts a portable Rainmeter. Outside Astral's own install folder,
   *  because Astral's updater replaces that folder on every update. */
  managedDir() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Astral Engine', 'Rainmeter'); }
  isManaged(exe = this.exePath()) { return !!exe && path.resolve(path.dirname(exe)).toLowerCase() === path.resolve(this.managedDir()).toLowerCase(); }

  /** Latest official release from github.com/rainmeter/rainmeter: name, url, size, sha256. */
  async latestRelease() {
    const r = await fetch('https://api.github.com/repos/rainmeter/rainmeter/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AstralEngine' } });
    if (!r.ok) throw new Error(`Couldn't reach GitHub (${r.status}). Try again later or use "Download from website".`);
    const j = await r.json();
    const a = (j.assets || []).find((x) => /^Rainmeter-[\d.]+\.exe$/i.test(x.name));
    if (!a) throw new Error('No Rainmeter installer found in the latest release.');
    return { version: j.tag_name, name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || '').replace(/^sha256:/i, '').toLowerCase() };
  }

  /**
   * One-click install: download the official installer, check its SHA-256 against GitHub's digest and
   * its Authenticode signature, then install a portable copy into managedDir() and start it.
   */
  async installManaged(onProgress = () => {}) {
    if (this.exePath()) throw new Error('Rainmeter is already installed.');
    const rel = await this.latestRelease();
    if (!/^https:\/\/github\.com\/rainmeter\/rainmeter\/releases\/download\//i.test(rel.url)) throw new Error('Unexpected download location.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-rainmeter-'));
    const file = path.join(tmp, rel.name);
    try {
      onProgress({ stage: 'download', p: 0 });
      const res = await fetch(rel.url, { headers: { 'User-Agent': 'AstralEngine' } });
      if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
      const total = Number(res.headers.get('content-length') || rel.size || 0);
      const hash = require('crypto').createHash('sha256');
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let done = 0;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const buf = Buffer.from(value);
        hash.update(buf); done += buf.length;
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        if (total) onProgress({ stage: 'download', p: done / total });
      }
      await new Promise((r, j) => { out.end(r); out.on('error', j); });
      onProgress({ stage: 'verify' });
      const sha = hash.digest('hex');
      if (rel.sha256 && sha !== rel.sha256) throw new Error('The download is damaged (checksum mismatch). Nothing was installed.');
      const sig = this.signature(file);
      if (sig.status !== 'Valid') throw new Error(`The installer's digital signature is not valid (${sig.status}). Nothing was installed.`);
      onProgress({ stage: 'install' });
      const dir = this.managedDir();
      fs.mkdirSync(dir, { recursive: true });
      // NSIS wants /D= last and unquoted. Start-Process (ShellExecute) also handles a UAC prompt if one is needed.
      const args = `/S /PORTABLE=1 /VERSION=64 /D=${dir}`;
      const ps = `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '${args.replace(/'/g, "''")}' -Wait -PassThru; exit $p.ExitCode`;
      await new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 180000 }, (err) => (err && !fs.existsSync(path.join(dir, 'Rainmeter.exe')) ? reject(new Error('The Rainmeter installer did not finish (' + (err.code ?? err.message) + ').')) : resolve())));
      const exe = path.join(dir, 'Rainmeter.exe');
      if (!fs.existsSync(exe)) throw new Error('Rainmeter did not install. Try "Download from website" instead.');
      this.settings.set('rainmeter.path', exe);
      onProgress({ stage: 'start' });
      await this.ensureRunning();
      return { version: rel.version, exe, signer: sig.signer };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** Authenticode check via Windows (Get-AuthenticodeSignature). */
  signature(file) {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`], { encoding: 'utf8', windowsHide: true }).trim();
      const [status, signer] = out.split('|');
      return { status, signer };
    } catch (e) { return { status: 'Unknown', signer: '' }; }
  }

  /**
   * Uninstall. A copy Astral installed is closed and its folder deleted (skins you added to it go too).
   * A copy you installed yourself is removed by Rainmeter's own uninstaller, which shows its own window.
   */
  async uninstall() {
    const exe = this.exePath();
    if (!exe) return { removed: true };
    await this.quit().catch(() => {});
    if (this.isManaged(exe)) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(this.managedDir(), { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
      }
      if (this.settings.get('rainmeter.path') === exe) this.settings.set('rainmeter.path', '');
      return { removed: !fs.existsSync(exe), managed: true };
    }
    const un = ['uninst.exe', 'Uninstall.exe'].map((n) => path.join(path.dirname(exe), n)).find((p) => fs.existsSync(p));
    if (!un) throw new Error("Rainmeter's uninstaller wasn't found. Remove it from Windows Settings › Apps.");
    spawn(un, [], { detached: true, stdio: 'ignore' }).unref();
    return { removed: false, managed: false, launchedUninstaller: true };
  }

  exePath() {
    const custom = this.settings.get('rainmeter.path');
    const cands = [
      custom,
      path.join(this.managedDir(), 'Rainmeter.exe'),
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
    return { installed: !!exe, exe, managed: this.isManaged(exe), running: exe ? this.isRunning() : false, skinsDir: this.skinsDir(), downloadUrl: 'https://www.rainmeter.net/' };
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
    if (!/.rmskin$/i.test(String(file)) || !fs.existsSync(file)) throw new Error('Not a .rmskin package');
    const exe = this.exePath();
    if (!exe) throw new Error('Rainmeter is not installed');
    const installer = path.join(path.dirname(exe), 'SkinInstaller.exe');
    spawn(fs.existsSync(installer) ? installer : exe, fs.existsSync(installer) ? [file] : ['!InstallSkin', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  /** Normal close (Rainmeter saves its layout). */
  async quit() {
    if (!this.isRunning()) return true;
    await this.bang('!Quit');
    for (let i = 0; i < 20 && this.isRunning(); i++) await new Promise((r) => setTimeout(r, 200));
    return !this.isRunning();
  }

  /** Synchronous normal close, for use while the app itself is quitting (no event loop to wait on). */
  quitSync() {
    const exe = this.exePath();
    if (!exe || !this.isRunning()) return false;
    try { execFileSync(exe, ['!Quit'], { windowsHide: true, timeout: 5000 }); } catch { /* it may already be gone */ }
    return true;
  }

  async start() { await this.ensureRunning(); return this.isRunning(); }
}

module.exports = { Rainmeter, parseIni };
