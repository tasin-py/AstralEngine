'use strict';
// Wallpaper library: Steam Workshop items, Wallpaper Engine's local projects,
// and wallpapers the user imported (video / web / image files or folders).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.wmv', '.ogv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const WEB_EXT = new Set(['.html', '.htm']);

function readJson(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch { return null; }
}

function normType(t) {
  t = String(t || '').toLowerCase();
  if (['scene', 'video', 'web', 'application', 'image', 'preset'].includes(t)) return t;
  return t || '';
}

function dirSize(dir, limit = 20000) {
  let total = 0, count = 0;
  const stack = [dir];
  while (stack.length && count < limit) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* skip */ } count++; }
    }
  }
  return total;
}

class Library extends EventEmitter {
  constructor({ settings, userDataDir }) {
    super();
    this.settings = settings;
    this.importDir = path.join(userDataDir, 'imported');
    fs.mkdirSync(this.importDir, { recursive: true });
    this.items = new Map();
    this.sources = [];
    this.watchers = [];
    this._rescanTimer = null;
  }

  setSources({ workshopDirs = [], weInstallDir = null }) {
    this._weDir = weInstallDir;
    const s = [];
    for (const d of workshopDirs) s.push({ dir: d, kind: 'workshop' });
    if (weInstallDir) {
      for (const sub of ['projects/defaultprojects', 'projects/myprojects']) {
        const d = path.join(weInstallDir, sub);
        if (fs.existsSync(d)) s.push({ dir: d, kind: sub.endsWith('myprojects') ? 'myprojects' : 'default' });
      }
    }
    s.push({ dir: this.importDir, kind: 'imported' });
    for (const d of this.settings.get('library.extraFolders') || []) if (fs.existsSync(d)) s.push({ dir: d, kind: 'folder' });
    this.sources = s;
    this.watch();
  }

  watch() {
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
    for (const s of this.sources) {
      try {
        // Non-recursive watch is cheap: we only need to know when item folders appear / vanish.
        const w = fs.watch(s.dir, { persistent: false }, () => this.scheduleRescan());
        w.on('error', () => {});
        this.watchers.push(w);
      } catch { /* folder may not exist yet */ }
    }
  }

  scheduleRescan() {
    clearTimeout(this._rescanTimer);
    this._rescanTimer = setTimeout(() => { this.scan(); this.emit('changed'); }, 1500);
  }

  scan() {
    const items = new Map();
    for (const s of this.sources) {
      let ents;
      try { ents = fs.readdirSync(s.dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const dir = path.join(s.dir, e.name);
        const item = this.loadItem(dir, s.kind);
        if (item && !items.has(item.id)) items.set(item.id, item);
      }
    }
    // Resolve presets (items that reuse another wallpaper's files with different property values).
    for (const it of items.values()) {
      if (it.dependency) {
        const base = items.get('ws_' + it.dependency) || [...items.values()].find((x) => x.workshopid === it.dependency);
        if (base) {
          it.baseId = base.id;
          if (!it.type || it.type === 'preset') it.type = base.type;
          it.contentDir = base.contentDir;
          it.file = it.file || base.file;
          const props = JSON.parse(JSON.stringify(base.properties || {}));
          for (const [k, v] of Object.entries(it.preset || {})) if (props[k]) props[k].value = v;
          it.properties = props;
        } else {
          it.missingDependency = true;
        }
      }
    }
    this.items = items;
    return [...items.values()];
  }

  loadItem(dir, kind) {
    const pj = readJson(path.join(dir, 'project.json'));
    if (!pj) return null;
    const folder = path.basename(dir);
    const workshopid = pj.workshopid ? String(pj.workshopid) : (kind === 'workshop' ? folder : '');
    const id = kind === 'workshop' ? 'ws_' + folder
      : kind === 'imported' ? 'im_' + folder
        : 'lc_' + crypto.createHash('md5').update(dir).digest('hex').slice(0, 12);
    let st = null;
    try { st = fs.statSync(dir); } catch { /* ignore */ }
    const preview = pj.preview ? (path.isAbsolute(pj.preview) ? pj.preview : path.join(dir, pj.preview)) : null;
    const props = (pj.general && pj.general.properties) || {};
    return {
      id,
      kind,
      dir,
      contentDir: dir,
      workshopid,
      type: normType(pj.type),
      title: pj.title || folder,
      description: pj.description || '',
      file: pj.file || '',
      preview: preview && fs.existsSync(preview) ? preview : null,
      tags: pj.tags || [],
      contentrating: pj.contentrating || 'Everyone',
      approved: !!pj.approved,
      properties: props,
      supportsAudio: !!(pj.general && pj.general.supportsaudioprocessing),
      dependency: pj.dependency ? String(pj.dependency) : '',
      preset: pj.preset || null,
      version: pj.version || 0,
      added: st ? st.birthtimeMs || st.mtimeMs : 0,
      updated: st ? st.mtimeMs : 0,
      favorite: (this.settings.get('library.favorites') || []).includes(id)
    };
  }

  list() { return [...this.items.values()]; }
  get(id) { return this.items.get(id) || null; }

  details(id) {
    const it = this.get(id);
    if (!it) return null;
    if (it.size == null) it.size = dirSize(it.dir) + (it.contentDir !== it.dir ? 0 : 0);
    // Video imported by reference: count the referenced file.
    if (it.kind === 'imported' && path.isAbsolute(it.file)) {
      try { it.size = fs.statSync(it.file).size; } catch { /* ignore */ }
    }
    return it;
  }

  /** Absolute path of the wallpaper's entry file. */
  entryPath(it) {
    if (!it.file) return null;
    return path.isAbsolute(it.file) ? it.file : path.join(it.contentDir, it.file);
  }

  /** Import a file or folder as a new wallpaper (by reference, nothing is copied). */
  importPath(p) {
    const st = fs.statSync(p);
    let type, file, title, preview = null;
    if (st.isDirectory()) {
      const pj = readJson(path.join(p, 'project.json'));
      if (pj) {
        // An existing Wallpaper Engine project folder: add as an extra source folder's item.
        const extra = new Set(this.settings.get('library.extraFolders') || []);
        extra.add(path.dirname(p));
        this.settings.set('library.extraFolders', [...extra]);
        this.setSources({ workshopDirs: this.sources.filter((s) => s.kind === 'workshop').map((s) => s.dir), weInstallDir: this._weDir });
        this.scan();
        this.emit('changed');
        return this.list().find((i) => i.dir === p) || null;
      }
      if (fs.existsSync(path.join(p, 'index.html'))) { type = 'web'; file = path.join(p, 'index.html'); title = path.basename(p); }
      else throw new Error('Folder has no index.html or project.json');
    } else {
      const ext = path.extname(p).toLowerCase();
      title = path.basename(p, ext);
      file = p;
      if (VIDEO_EXT.has(ext)) type = 'video';
      else if (IMAGE_EXT.has(ext)) { type = 'image'; preview = p; }
      else if (WEB_EXT.has(ext)) type = 'web';
      else throw new Error('Unsupported file type: ' + ext);
    }
    const folder = crypto.createHash('md5').update(p).digest('hex').slice(0, 16);
    const dir = path.join(this.importDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const pj = { title, type, file, preview: preview || undefined, tags: [], contentrating: 'Everyone' };
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
    const item = this.loadItem(dir, 'imported');
    this.items.set(item.id, item);
    this.emit('changed');
    return item;
  }

  setPreview(id, pngBuffer) {
    const it = this.get(id);
    if (!it || it.kind !== 'imported') return;
    const out = path.join(it.dir, 'preview.jpg');
    fs.writeFileSync(out, pngBuffer);
    const pj = readJson(path.join(it.dir, 'project.json')) || {};
    pj.preview = 'preview.jpg';
    fs.writeFileSync(path.join(it.dir, 'project.json'), JSON.stringify(pj, null, 2));
    it.preview = out;
    this.emit('changed');
  }

  removeImported(id) {
    const it = this.get(id);
    if (!it || it.kind !== 'imported') return false;
    fs.rmSync(it.dir, { recursive: true, force: true });
    this.items.delete(id);
    this.emit('changed');
    return true;
  }

  toggleFavorite(id) {
    const favs = new Set(this.settings.get('library.favorites') || []);
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    this.settings.set('library.favorites', [...favs]);
    const it = this.get(id);
    if (it) it.favorite = favs.has(id);
    return it ? it.favorite : false;
  }
}

module.exports = { Library, VIDEO_EXT, IMAGE_EXT, WEB_EXT, readJson, dirSize };
