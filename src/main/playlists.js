'use strict';
// Playlists: rotate wallpapers on a timer, at a given time of day, or each time the app starts.

const crypto = require('crypto');

class Playlists {
  constructor({ settings, manager, library }) {
    this.settings = settings;
    this.manager = manager;
    this.library = library;
    this.timer = null;
  }

  all() { return this.settings.get('playlists') || []; }
  active() { return { ...(this.settings.get('activePlaylist') || {}) }; }

  slotKey(slotId) {
    const mode = this.manager.layoutMode();
    if (mode === 'span') return 'span';
    if (mode === 'clone') return 'clone';
    return slotId || this.manager.slotsWanted()[0].id;
  }

  save(list) { this.settings.set('playlists', list); }

  create(name, items = []) {
    const pl = { id: 'p' + crypto.randomBytes(4).toString('hex'), name, items, intervalMin: 30, order: 'sequential', mode: 'timer', times: [] };
    this.save([...this.all(), pl]);
    return pl;
  }

  async start(playlistId, slotId) {
    const pl = this.all().find((p) => p.id === playlistId);
    if (!pl || !pl.items.length) throw new Error('Playlist is empty');
    const key = this.slotKey(slotId);
    const act = this.active();
    act[key] = { playlistId, index: -1, nextAt: 0 };
    this.settings.set('activePlaylist', act);
    await this.advance(key);
    return this.status();
  }

  stop(slotId) {
    const key = this.slotKey(slotId);
    const act = this.active();
    if (act[key]) { delete act[key]; this.settings.set('activePlaylist', act); }
  }

  status() { return this.active(); }

  async next(slotId) { return this.advance(this.slotKey(slotId)); }
  async nextAll() { for (const k of Object.keys(this.active())) await this.advance(k); }

  pickIndex(pl, cur) {
    const valid = pl.items.map((id, i) => ({ id, i })).filter((x) => this.library.get(x.id));
    if (!valid.length) return -1;
    if (pl.order === 'random' && valid.length > 1) {
      let r;
      do { r = valid[Math.floor(Math.random() * valid.length)].i; } while (r === cur);
      return r;
    }
    const after = valid.find((x) => x.i > cur);
    return (after || valid[0]).i;
  }

  nextTimeOfDay(pl) {
    const now = new Date();
    const times = (pl.times || []).map((t) => { const [h, m] = String(t).split(':').map(Number); const d = new Date(now); d.setHours(h || 0, m || 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d.getTime(); });
    return times.length ? Math.min(...times) : Date.now() + 24 * 3600e3;
  }

  async advance(key) {
    const act = this.active();
    const a = act[key];
    if (!a) return;
    const pl = this.all().find((p) => p.id === a.playlistId);
    if (!pl) { delete act[key]; this.settings.set('activePlaylist', act); return; }
    const idx = this.pickIndex(pl, a.index);
    if (idx < 0) return;
    a.index = idx;
    a.nextAt = pl.mode === 'daytime' ? this.nextTimeOfDay(pl) : pl.mode === 'login' ? 0 : Date.now() + Math.max(1, pl.intervalMin || 30) * 60e3;
    act[key] = a;
    this.settings.set('activePlaylist', act);
    const asg = { ...(this.settings.get('wallpaper.assignments') || {}) };
    asg[key] = { itemId: pl.items[idx] };
    this.settings.set('wallpaper.assignments', asg);
    await this.manager.sync();
  }

  stopTimers() { clearInterval(this.timer); this.timer = null; }

  startTimers() {
    this.stopTimers();
    // "login" playlists switch once per app start.
    for (const [k, a] of Object.entries(this.active())) {
      const pl = this.all().find((p) => p.id === a.playlistId);
      if (pl && pl.mode === 'login') this.advance(k);
    }
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, a] of Object.entries(this.active())) {
        if (a.nextAt && now >= a.nextAt && !this.manager.userPaused) this.advance(k);
      }
    }, 10000);
  }
}

module.exports = { Playlists };
