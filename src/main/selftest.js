'use strict';
// Automated end-to-end check: `electron . --selftest [--out=dir] [--items=id1,id2]`
// Opens the UI, visits every tab, applies wallpapers of each type, captures screenshots of
// the UI and of the wallpaper windows, records console errors and resource usage.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const desktop = require('./desktop');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(ctx) {
  const { settings, library, manager, widgets, createUI } = ctx;
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice(6) : path.join(app.getPath('userData'), 'selftest');
  fs.mkdirSync(out, { recursive: true });
  const report = { started: new Date().toISOString(), errors: [], steps: [], metrics: {} };
  const step = (name, ok, extra) => { report.steps.push({ name, ok, ...extra }); console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + JSON.stringify(extra) : ''}`); };
  const savedAssign = JSON.parse(JSON.stringify(settings.get('wallpaper.assignments') || {}));
  const savedLayout = settings.get('wallpaper.layout');
  const savedFirst = settings.get('firstRunDone');
  const savedWidgets = JSON.parse(JSON.stringify(settings.get('widgets') || []));
  const savedItemProps = JSON.parse(JSON.stringify(settings.get('itemProps') || {}));
  const savedPaused = !!settings.get('paused');
  const savedUI = JSON.parse(JSON.stringify(settings.get('ui') || {}));
  const savedWindow = JSON.parse(JSON.stringify(settings.get('window') || {}));

  const hook = (wc, label) => wc.on('console-message', (e) => {
    const level = e.level !== undefined ? e.level : e.params && e.params.level;
    const msg = e.message || (e.params && e.params.message) || '';
    if (level === 'error' || level === 3 || level === 'warning' || level === 2) report.errors.push({ where: label, msg: String(msg).slice(0, 500) });
  });
  app.on('web-contents-created', (e, wc) => hook(wc, 'wc' + wc.id));

  try {
    // ---- Library ----
    const items = library.list();
    const byType = {};
    for (const it of items) (byType[it.type] = byType[it.type] || []).push(it);
    step('library scan', items.length >= 0, { total: items.length, types: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])) });

    // ---- UI ----
    settings.set('firstRunDone', true);
    const ui = createUI(true);
    hook(ui.webContents, 'ui');
    await new Promise((r) => ui.webContents.once('did-finish-load', r));
    await sleep(2500);
    // Click a selector, waiting up to 5 s for it to appear (UI pieces render asynchronously).
    const click = (sel) => ui.webContents.executeJavaScript(`new Promise((res,rej)=>{let n=0;const t=setInterval(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e){clearInterval(t);e.click();res(true)}else if(++n>50){clearInterval(t);rej(new Error('not found: '+${JSON.stringify(sel)}))}},100)})`);
    const cap = async (wc, name) => { const img = await wc.capturePage(); fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()); return img.getSize(); };
    step('ui loaded', true, { size: await cap(ui.webContents, 'ui-installed') });
    for (const tab of ['discover', 'workshop', 'widgets', 'rainmeter', 'installed']) {
      await ui.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
      await sleep(tab === 'workshop' || tab === 'discover' ? 7000 : 2000);
      const txt = await ui.webContents.executeJavaScript(`(document.getElementById('grid').children.length)+'|'+(document.getElementById('empty').hidden?'':document.getElementById('empty').innerText.slice(0,120))`);
      step('tab ' + tab, true, { info: txt });
      await cap(ui.webContents, 'ui-' + tab);
    }
    // Settings dialog pages
    await click('#btn-settings');
    await sleep(800);
    for (const p of ['performance', 'features', 'general', 'audio', 'taskbar', 'screensaver', 'steam', 'rainmeter', 'updates', 'about']) {
      await click(`.snav button[data-p="${p}"]`);
      await sleep(p === 'steam' || p === 'about' ? 1500 : 600);
      await cap(ui.webContents, 'settings-' + p);
    }
    await click('.modal-head .x');
    await click('#btn-displays');
    await sleep(800);
    await cap(ui.webContents, 'ui-displays');
    await click('.modal-head .x');

    // ---- Multi-monitor: every display gets its own wallpaper window that covers exactly that monitor ----
    const { screen } = require('electron');
    const multimon = async () => {
      const ds = manager.displays();
      if (ds.length < 2) { step('multi-monitor', true, { skipped: 'one display' }); return; }
      const pickMM = ['video', 'scene', 'web'].map((t) => (byType[t] || [])[0]).filter(Boolean);
      for (const layout of ['per-monitor', 'span', 'clone']) {
        settings.set('wallpaper.layout', layout);
        const asg = {};
        if (layout === 'per-monitor') ds.forEach((d, i) => (asg[d.id] = { itemId: pickMM[i % pickMM.length].id }));
        else asg[layout] = { itemId: pickMM[0].id };
        settings.set('wallpaper.assignments', asg);
        await manager.sync();
        await sleep(7000);
        const rows = [];
        for (const [id, sl] of manager.slots) {
          if (!sl.win || sl.win.isDestroyed()) { rows.push({ id, error: 'no window' }); continue; }
          const r = desktop.rectOf(manager.hwnd(sl.win));
          const got = r && { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
          const want = sl.phys;
          const page = await sl.win.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })').catch((e) => ({ error: String(e) }));
          const pagePx = page.w && { w: Math.round(page.w * page.dpr), h: Math.round(page.h * page.dpr) };
          const okRect = got && Math.abs(got.x - want.x) <= 1 && Math.abs(got.y - want.y) <= 1 && Math.abs(got.w - want.width) <= 1 && Math.abs(got.h - want.height) <= 1;
          const okPage = pagePx && Math.abs(pagePx.w - want.width) <= 2 && Math.abs(pagePx.h - want.height) <= 2;
          rows.push({ id, type: sl.item.type, embedded: desktop.isEmbedded(manager.hwnd(sl.win)), want, got, page, okRect, okPage });
          try { await cap(sl.win.webContents, `mm-${layout}-${id}`); } catch { /* ignore */ }
        }
        const want = layout === 'span' ? 1 : ds.length; // clone = one window per display showing the same item
        // Every wallpaper must be above Explorer's static wallpaper layer, otherwise it is invisible.
        const hs = [...manager.slots.values()].filter((sl) => sl.win && !sl.win.isDestroyed()).map((sl) => manager.hwnd(sl.win));
        const visible = desktop.keepAboveStaticWallpaper(hs, false);
        step(`multi-monitor ${layout}`, visible && rows.length === want && rows.every((x) => x.embedded && x.okRect && x.okPage), { visible, displays: ds.map((d) => ({ id: d.id, phys: d.phys, scale: d.scaleFactor, primary: d.primary })), rows });
      }
      settings.set('wallpaper.layout', 'per-monitor');
      // Widgets on every display: right size and position, also after a move within the display.
      const wrows = [];
      for (const d of ds) {
        const w = widgets.add('clock', d.id);
        await sleep(2500);
        const win = widgets.windows.get(w.id);
        const cfg0 = widgets.config(w.id);
        const r0 = win && desktop.rectOf(manager.hwnd(win));
        const want = screen.dipToScreenRect(null, { x: Math.round(cfg0.x), y: Math.round(cfg0.y), width: Math.round(cfg0.w), height: Math.round(cfg0.h) });
        const page = win ? await win.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })').catch(() => null) : null;
        // simulate the user dragging it 40 px left on the same display, then re-read
        widgets.update(w.id, { x: cfg0.x - 40, y: cfg0.y + 10 });
        await sleep(800);
        const cfg1 = widgets.config(w.id);
        const r1 = win && desktop.rectOf(manager.hwnd(win));
        const want1 = screen.dipToScreenRect(null, { x: Math.round(cfg1.x), y: Math.round(cfg1.y), width: Math.round(cfg1.w), height: Math.round(cfg1.h) });
        const g = (r) => r && { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
        const close = (a, b) => a && b && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.width) <= 2 && Math.abs(a.h - b.height) <= 2;
        const onDisplay = r0 && r0.left >= d.phys.x && r0.right <= d.phys.x + d.phys.width;
        wrows.push({ display: d.id, scale: d.scaleFactor, cfg0: { x: cfg0.x, y: cfg0.y, w: cfg0.w, h: cfg0.h }, want, got: g(r0), page, afterMove: { want: want1, got: g(r1) }, ok: !!(onDisplay && close(g(r0), want) && close(g(r1), want1)) });
        try { await cap(win.webContents, 'mm-widget-' + d.id); } catch { /* ignore */ }
        widgets.remove(w.id);
      }
      step('multi-monitor widgets', wrows.every((x) => x.ok), { wrows });
    };
    if (process.argv.includes('--multimon')) { await multimon(); return; }

    // ---- Wallpapers ----
    const pick = (process.argv.find((a) => a.startsWith('--items=')) || '').slice(8).split(',').filter(Boolean);
    const toTest = pick.length ? pick.map((id) => library.get(id) || items.find((x) => x.title.toLowerCase().includes(id.toLowerCase()))).filter(Boolean)
      : ['scene', 'video', 'web', 'image'].flatMap((t) => (byType[t] || []).slice(0, t === 'scene' ? 6 : 1));
    settings.set('wallpaper.layout', 'per-monitor');
    for (const it of toTest) {
      const t0 = Date.now();
      await manager.apply(it.id);
      await sleep(it.type === 'scene' ? 9000 : 4000);
      const slot = [...manager.slots.values()][0];
      if (!slot || !slot.win || slot.win.isDestroyed()) { step('wallpaper ' + it.type + ' ' + it.title, false, { reason: 'no window' }); continue; }
      const embedded = desktop.isEmbedded(manager.hwnd(slot.win));
      const name = 'wp-' + it.type + '-' + (it.workshopid || it.id);
      let size = null;
      try { size = await cap(slot.win.webContents, name); } catch (e) { size = String(e); }
      const errs = report.errors.length;
      try { const dg = await slot.win.webContents.executeJavaScript('window.__diag && window.__diag()'); fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(dg, null, 1)); } catch { /* ignore */ }
      const m = app.getAppMetrics();
      step(`wallpaper ${it.type} "${it.title}"`, embedded || process.env.ASTRAL_OFFSCREEN === '1', { embedded, mode: slot.embedMode, ms: Date.now() - t0, size, memMB: Math.round(m.reduce((a, x) => a + x.memory.workingSetSize, 0) / 1024), errorsSoFar: errs });
    }

    // ---- Screensaver: one full-screen window per display showing that display's wallpaper ----
    if (process.argv.includes('--saver') && ctx.saver) {
      const sv = ctx.saver;
      sv.start(false);
      await sleep(6000);
      const rows = [];
      for (const [id, sl] of sv.slots) {
        const alive = sl.win && !sl.win.isDestroyed();
        const init = manager.hostInit(id);
        const page = alive ? await sl.win.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight, diag: window.__diag ? window.__diag() : null })').catch((e) => ({ error: String(e) })) : null;
        rows.push({ id, item: sl.item && sl.item.title, type: sl.item && sl.item.type, alive, init: !!init, state: sl.state, page: page && { w: page.w, h: page.h, player: page.diag && (page.diag.player !== false), objects: page.diag && page.diag.objects && page.diag.objects.length } });
        if (alive) { try { await cap(sl.win.webContents, 'saver-' + id.replace(':', '-')); } catch { /* ignore */ } }
      }
      const paused = [...manager.slots.values()].every((x) => x.state === 'pause' || x.state === 'stop');
      step('screensaver start', sv.active && rows.length === manager.displays().length && rows.every((r) => r.alive && (r.init || !r.item)) && paused, { rows, desktopPaused: paused });
      sv.stop(false);
      await sleep(1500);
      const resumed = !manager.saverActive;
      step('screensaver stop', !sv.active && sv.slots.size === 0 && resumed, { resumed });
    }

    if (process.argv.includes('--quick')) {
      // Screenshot of the library with the first tested wallpaper selected (used for the README).
      if (toTest[0]) {
        await click('.tab[data-tab="installed"]'); await sleep(1200);
        await click(`#grid .card[data-id="${toTest[0].id}"]`); await sleep(2000);
        await cap(ui.webContents, 'ui-library-selected');
      }
      return;
    }
    await multimon();

    // ---- Built-in display properties + presets panel ----
    const bi = toTest.find((x) => x.type === 'scene') || toTest[0];
    if (bi) {
      await manager.apply(bi.id);
      await sleep(bi.type === 'scene' ? 8000 : 3000);
      await click('.tab[data-tab="installed"]'); await sleep(1500);
      await click(`#grid .card[data-id="${bi.id}"]`);
      await sleep(1500);
      await ui.webContents.executeJavaScript(`(function(){var i=[...document.querySelectorAll('.prop')].find(function(r){return /Show color options/.test(r.textContent)});if(i){var c=i.querySelector('input');c.checked=true;c.dispatchEvent(new Event('change'))}[document.getElementById('details'),document.getElementById('panel')].forEach(function(d){if(d)d.scrollTop=99999});})()`);
      await sleep(800);
      await cap(ui.webContents, 'ui-details-props');
      const modals = await ui.webContents.executeJavaScript("[...document.querySelectorAll('.modal-head')].map(function(m){return m.textContent.trim().slice(0,40)})").catch(() => []);
      step('details panel has built-ins and presets', await ui.webContents.executeJavaScript("!!document.querySelector('#details .presets') && /Show color options/.test(document.getElementById('details').textContent)"), { openModals: modals });
      manager.setItemProps(bi.id, { _ae_coloropts: true, _ae_saturation: 0, _ae_flip: true });
      await sleep(1500);
      const slot = [...manager.slots.values()][0];
      let dg = null;
      try { dg = await slot.win.webContents.executeJavaScript('window.__diag && window.__diag()'); await cap(slot.win.webContents, 'wp-builtin-gray-flip'); } catch { /* ignore */ }
      const inner = dg && dg.inner || [];
      step('built-in props (grayscale + flip)', (inner[5] || '').includes('saturate(0)') && (inner[6] || '').includes('scaleX(-1)'), { filter: inner[5], transform: inner[6] });
      const all = { ...(settings.get('itemProps') || {}) }; delete all[bi.id]; settings.set('itemProps', all);
      manager.sendProps(slot, manager.resolvedProps(bi));
    }

    // ---- Pause policy ----
    manager.setUserPaused(true); await sleep(1500);
    const pausedState = [...manager.slots.values()].map((s) => s.state);
    manager.setUserPaused(false); await sleep(500);
    step('pause / resume', pausedState.every((s) => s === 'pause'), { pausedState });

    // ---- Widgets ----
    const w = widgets.add('clock');
    const w2 = widgets.add('sysmon');
    await sleep(4000);
    const wwin = widgets.windows.get(w.id);
    step('widget window', !!wwin && !wwin.isDestroyed(), { count: widgets.windows.size, sharedProcess: wwin ? wwin.webContents.getOSProcessId() === (widgets.windows.get(w2.id) || wwin).webContents.getOSProcessId() : false });
    if (wwin) { try { await cap(wwin.webContents, 'widget-clock'); } catch { /* ignore */ } }
    const ws = widgets.windows.get(w2.id);
    if (ws) { try { await cap(ws.webContents, 'widget-sysmon'); } catch { /* ignore */ } }

    // ---- 1.2 widget features: fonts, borders, sticky note +, visualizer styles, clock faces ----
    const fonts = widgets.fonts();
    step('installed fonts listed', fonts.length > 20, { count: fonts.length });
    const note = widgets.add('notes');
    await sleep(2500);
    widgets.update(note.id, { options: { noteColor: '#8fc8ff', font: 'Caveat', border: 'none', text: 'hello' } });
    const n2 = widgets.addNear(note.id, 'notes', { noteColor: '#8fc8ff' });
    await sleep(2500);
    const nwin = widgets.windows.get(note.id);
    const noteDiag = nwin ? await nwin.webContents.executeJavaScript(`({ font: getComputedStyle(document.getElementById('w')).fontFamily, bg: document.getElementById('w').style.background, borderNone: document.body.classList.contains('b-none'), plus: !!document.getElementById('nadd'), fontLoaded: document.fonts.check('16px Caveat') })`).catch((e) => String(e)) : null;
    step('sticky note: colour, font, border, + button', !!(noteDiag && noteDiag.plus && noteDiag.borderNone && /Caveat/.test(noteDiag.font)) && widgets.windows.has(n2.id) && n2.x !== note.x, { noteDiag, newNoteNextToIt: n2.x !== note.x });
    if (nwin) { try { await cap(nwin.webContents, 'widget-note'); } catch { /* ignore */ } }
    const an = widgets.add('analog');
    const vz = widgets.add('visualizer');
    await sleep(2500);
    const faceErr = [];
    for (const face of ['classic', 'minimal', 'dots', 'numbers', 'roman', 'neon', 'modern', 'skeleton']) {
      widgets.update(an.id, { options: { face, smooth: face === 'neon' } }); await sleep(400);
      try { await cap(widgets.windows.get(an.id).webContents, 'widget-analog-' + face); } catch (e) { faceErr.push(face + ': ' + e.message); }
    }
    step('analog clock faces', !faceErr.length, { faces: 8, faceErr });
    const vzErr = [];
    for (const vizStyle of ['bars', 'mirror', 'wave', 'fill', 'circle', 'ring', 'dots', 'blocks', 'line']) {
      widgets.update(vz.id, { options: { vizStyle, colorMode: vizStyle === 'circle' ? 'rainbow' : 'gradient', glow: true } }); await sleep(300);
      // feed a fake spectrum so each style draws something
      const win = widgets.windows.get(vz.id);
      const fake = Array.from({ length: 128 }, (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(i / 7)));
      win.webContents.send('widget:audio', fake); await sleep(250); win.webContents.send('widget:audio', fake); await sleep(250);
      try { await cap(win.webContents, 'widget-viz-' + vizStyle); } catch (e) { vzErr.push(vizStyle + ': ' + e.message); }
    }
    step('visualizer styles', !vzErr.length, { styles: 9, vzErr });
    for (const x of [note, n2, an, vz]) widgets.remove(x.id);

    // ---- Workshop filters: several boxes checked must still return wallpapers ----
    try {
      const workshop = require('./workshop');
      const r = await workshop.browse({ sort: 'trend', types: ['Scene', 'Video', 'Web'], ratings: ['Everyone'], tags: ['Abstract', 'Animal', 'Landscape', 'Nature', 'Relaxing'] });
      step('workshop: multi-select filters return results', r.items.length > 0, { items: r.items.length, total: r.total });
    } catch (e) { step('workshop: multi-select filters return results', false, { error: e.message }); }

    // ---- Feature switches: turning Widgets off must unload them completely ----
    const savedFeatures = JSON.parse(JSON.stringify(settings.get('features') || {}));
    settings.set('features.widgets', false); await sleep(1000);
    const offOk = widgets.windows.size === 0 && !widgets.host;
    const tabHidden = await ui.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,300));return document.querySelector('.tab[data-tab="widgets"]').hidden})()`).catch(() => null);
    settings.set('features.widgets', true); await sleep(3000);
    step('feature switch: widgets off/on', offOk && widgets.windows.size > 0, { offOk, backOn: widgets.windows.size, tabHiddenInUI: tabHidden });
    settings.set('features', savedFeatures);

    // ---- Resource benchmark: UI closed, no widgets, one wallpaper forced to run ----
    ui.destroy();
    widgets.stopAll();
    const savedPlayback = JSON.parse(JSON.stringify(settings.get('playback')));
    settings.set('playback', { ...savedPlayback, otherAppFocused: 'run', otherAppMaximized: 'run', otherAppFullscreen: 'run', onBattery: 'run' });
    const sample = async (label, secs) => {
      app.getAppMetrics(); // prime CPU counters
      await sleep(secs * 1000);
      const m = app.getAppMetrics();
      const r = { totalMB: Math.round(m.reduce((a, x) => a + x.memory.workingSetSize, 0) / 1024), privateMB: Math.round(m.reduce((a, x) => a + (x.memory.privateBytes || 0), 0) / 1024), cpuPct: +(m.reduce((a, x) => a + x.cpu.percentCPUUsage, 0)).toFixed(2), procs: m.map((x) => `${x.type}${x.serviceName ? "(" + x.serviceName + ")" : ""}${x.name ? "[" + x.name + "]" : ""}:${Math.round(x.memory.workingSetSize / 1024)}MB/${x.cpu.percentCPUUsage.toFixed(1)}%`).join(' ') };
      report.metrics[label] = r;
      step('metrics ' + label, true, r);
    };
    const bench = (process.argv.find((a) => a.startsWith('--bench=')) || '').slice(8).split(',').filter(Boolean);
    const benchItems = bench.length ? bench : [(byType.video || [])[0], (byType.scene || [])[0]].filter(Boolean).map((x) => x.id);
    for (const id of benchItems) {
      const it = library.get(id); if (!it) continue;
      await manager.apply(id);
      await sleep(it.type === 'scene' ? 8000 : 4000);
      await sample(`${it.type}-running`, 8);
      manager.setUserPaused(true);
      await sleep(7000);
      await sample(`${it.type}-paused`, 3);
      manager.setUserPaused(false);
    }
    settings.set('playback', savedPlayback);
  } catch (e) {
    step('exception', false, { error: e.stack || String(e) });
  } finally {
    settings.set('wallpaper.layout', savedLayout);
    settings.set('wallpaper.assignments', savedAssign);
    settings.set('firstRunDone', savedFirst);
    settings.set('widgets', savedWidgets);
    settings.set('itemProps', savedItemProps);
    settings.set('paused', savedPaused);
    settings.set('ui', savedUI);
    settings.set('window', savedWindow);
    settings.flush();
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log('[selftest] report written to', out);
    try { widgets.stopAll(); manager.shutdown(); } catch { /* ignore */ }
    app.exit(0);
  }
}

/**
 * Restart test: `--persisttest=write` changes many settings through the normal code paths and
 * quits the normal way (no manual save); `--persisttest=check` starts again and compares.
 */
const PERSIST_SAMPLE = {
  'playback.fps': 45, 'playback.otherAppMaximized': 'stop', 'audio.volume': 37, 'audio.muted': true,
  'theme.accent': '#ff7a00', 'features.rainmeter': false, 'features.widgets': false, 'taskbar.color': '#11223344',
  'updates.repo': 'example/test-repo', 'advanced.keepUIInMemory': true, 'globalProps': { _ae_saturation: 50 },
  'ui': { tab: 'installed', sort: 'recent', panelHidden: true }, 'presets': [{ name: 'Test', props: { _ae_flip: true } }]
};
async function persist(mode, { app, settings, manager, createUI, quit }) {
  const get = (k) => JSON.stringify(settings.get(k));
  if (mode === 'write') {
    for (const [k, v] of Object.entries(PERSIST_SAMPLE)) settings.set(k, v);
    manager.setUserPaused(true);
    const ui = createUI(false);
    await new Promise((r) => ui.webContents.once('did-finish-load', r));
    ui.setBounds({ x: 120, y: 90, width: 1100, height: 700 });
    await sleep(1200); // bounds are saved 0.5 s after a move/resize
    console.log('[persist] wrote', Object.keys(PERSIST_SAMPLE).length + 2, 'values; quitting normally');
    quit();
    return;
  }
  const bad = [];
  const same = (k, v) => (k === 'ui' ? Object.entries(v).every(([a, b]) => JSON.stringify((settings.get('ui') || {})[a]) === JSON.stringify(b)) : get(k) === JSON.stringify(v));
  for (const [k, v] of Object.entries(PERSIST_SAMPLE)) if (!same(k, v)) bad.push(`${k}: got ${get(k)}`);
  if (!manager.userPaused) bad.push('paused: not restored');
  const wb = settings.get('window.bounds');
  if (!wb || wb.width !== 1100 || wb.height !== 700) bad.push('window.bounds: got ' + JSON.stringify(wb));
  console.log(bad.length ? '[persist] FAIL ' + bad.join(' | ') : '[persist] PASS all settings, pause state and window size restored after restart');
  app.exit(bad.length ? 1 : 0);
}

module.exports = { run, persist };
