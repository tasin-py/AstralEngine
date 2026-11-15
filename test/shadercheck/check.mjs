import { buildProgram, parseCombos, findIncludes } from '../../src/renderer/scene/shader.js';
import { parsePkg } from '../../src/renderer/scene/pkg.js';
const fs = require('fs');
const path = require('path');
const steam = require(path.join(process.cwd(), 'src/main/steam.js'));
const info = steam.detect();
const assets = info.weAssetsDir;
const gl = document.getElementById('c').getContext('webgl2');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const shaders = []; // { name, vs, fs, inc(name) }
// 1) built-in effects in assets/effects/*/shaders/effects
if (assets) {
  for (const eff of fs.readdirSync(path.join(assets, 'effects'))) {
    const dir = path.join(assets, 'effects', eff, 'shaders', 'effects');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.frag'))) {
      const base = f.slice(0, -5);
      shaders.push({ name: 'assets:' + eff + '/' + base, vs: read(path.join(dir, base + '.vert')), fs: read(path.join(dir, f)), inc: (n) => read(path.join(assets, 'shaders', n)) });
    }
  }
}
// 2) shaders inside workshop scene.pkg files
for (const wd of info.workshopDirs) {
  for (const id of fs.readdirSync(wd)) {
    const pk = path.join(wd, id, 'scene.pkg');
    if (!fs.existsSync(pk)) continue;
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pk)));
    const dec = (k) => pkg.files.has(k) ? new TextDecoder().decode(pkg.files.get(k)) : null;
    for (const k of pkg.files.keys()) {
      if (!k.endsWith('.frag')) continue;
      const vk = k.slice(0, -5) + '.vert';
      shaders.push({ name: id + ':' + k, vs: dec(vk), fs: dec(k), inc: (n) => dec('shaders/' + n.toLowerCase()) || read(path.join(assets || '', 'shaders', n)) });
    }
  }
}
const failures = [];
let ok = 0, skipped = 0;
const seen = new Set();
for (const s of shaders) {
  if (!s.vs || !s.fs) { skipped++; continue; }
  const key = s.vs.length + ':' + s.fs.length + ':' + s.name.split('/').pop();
  if (seen.has(key)) continue; seen.add(key);
  const combos = { ...parseCombos(s.vs), ...parseCombos(s.fs) };
  try { const p = buildProgram(gl, s.vs, s.fs, combos, s.inc); gl.deleteProgram(p.program); ok++; }
  catch (e) { failures.push({ name: s.name, err: String(e.message || e).split('\n').slice(0, 3).join(' | ') }); }
}
window.done = { summary: { total: ok + failures.length, ok, failed: failures.length, skipped }, failures };
