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
    for (const p of ['performance', 'features', 'general', 'audio', 'taskbar', 'steam', 'rainmeter', 'updates', 'about']) {
      await click(`.snav button[data-p="${p}"]`);
      await sleep(p === 'steam' || p === 'about' ? 1500 : 600);
      await cap(ui.webContents, 'settings-' + p);
    }
    await click('.modal-head .x');
    await click('#btn-displays');
    await sleep(800);
    await cap(ui.webContents, 'ui-displays');
    await click('.modal-head .x');

    // ---- Wallpapers ----
    const pick = (process.argv.find((a) => a.startsWith('--items=')) || '').slice(8).split(',').filter(Boolean);
    const toTest = pick.length ? pick.map((id) => library.get(id)).filter(Boolean)
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
      step(`wallpaper ${it.type} "${it.title}"`, embedded, { embedded, mode: slot.embedMode, ms: Date.now() - t0, size, memMB: Math.round(m.reduce((a, x) => a + x.memory.workingSetSize, 0) / 1024), errorsSoFar: errs });
    }

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
