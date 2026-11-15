// Unit tests: `npm test` (Node's built-in test runner, no extra dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parsePkg } from '../src/renderer/scene/pkg.js';
import { lz4Decompress, parseTex } from '../src/renderer/scene/tex.js';
import { parseCombos, parseUniforms } from '../src/renderer/scene/shader.js';

const require = createRequire(import.meta.url);
const { parseVdf } = require('../src/main/vdf.js');
const { compareVersions, parseVersion, normalizeRepo } = require('../src/main/updater.js');
const { Settings, deepMerge, DEFAULTS } = require('../src/main/settings.js');

test('VDF parser reads Steam library folders', () => {
  const v = parseVdf('"libraryfolders"\n{\n "0"\n {\n  "path"  "C:\\\\Program Files (x86)\\\\Steam"\n  "apps" { "431960" "123" }\n }\n}');
  assert.equal(v.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.equal(v.libraryfolders['0'].apps['431960'], '123');
});

test('version comparison for the update checker', () => {
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0);
  assert.ok(compareVersions('v2.0.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
  assert.ok(parseVersion('v1.2.3'));
});

test('GitHub repo links are normalised', () => {
  assert.equal(normalizeRepo('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(normalizeRepo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(normalizeRepo('owner/repo'), 'owner/repo');
});

test('settings survive a restart and keep new defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-settings-'));
  const a = new Settings(dir);
  a.set('audio.volume', 12);
  a.set('features.rainmeter', false);
  a.set('presets', [{ name: 'x', props: { _ae_flip: true } }]);
  a.flush();
  const b = new Settings(dir);
  assert.equal(b.get('audio.volume'), 12);
  assert.equal(b.get('features.rainmeter'), false);
  assert.equal(b.get('features.widgets'), true, 'untouched defaults are still there');
  assert.deepEqual(b.get('presets'), [{ name: 'x', props: { _ae_flip: true } }]);
  assert.equal(b.get('playback.fps'), DEFAULTS.playback.fps);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt settings file falls back to defaults instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-settings-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  const s = new Settings(dir);
  assert.equal(s.get('playback.fps'), DEFAULTS.playback.fps);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deepMerge replaces arrays and merges objects', () => {
  assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 5 } }), { a: [3], b: { c: 1, d: 5 } });
});

test('PKG archive reader', () => {
  const enc = new TextEncoder();
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const str = (s) => { const b = Buffer.from(enc.encode(s)); u32(b.length); parts.push(b); };
  str('PKGV0019'); u32(2);
  str('scene.json'); u32(0); u32(2);
  str('materials/a.json'); u32(2); u32(3);
  parts.push(Buffer.from('{}abc'));
  const pkg = parsePkg(new Uint8Array(Buffer.concat(parts)));
  assert.equal(pkg.version, 'PKGV0019');
  assert.equal(Buffer.from(pkg.files.get('scene.json')).toString(), '{}');
  assert.equal(Buffer.from(pkg.files.get('materials/a.json')).toString(), 'abc');
});

test('PKG reader rejects other files', () => {
  const b = Buffer.alloc(12); b.writeUInt32LE(4); b.write('ABCD', 4);
  assert.throws(() => parsePkg(new Uint8Array(b)));
});

test('LZ4 block decompression (literals + match copy)', () => {
  // token: 4 literals "abcd", then match offset 4, length 4+4=8 → "abcdabcdabcd"
  const src = new Uint8Array([0x44, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00]);
  const out = lz4Decompress(src, 12);
  assert.equal(Buffer.from(out).toString(), 'abcdabcdabcd');
});

test('TEX parser rejects non-texture data', () => {
  assert.throws(() => parseTex(new Uint8Array(64)));
});

test('shader uniform and combo annotations', () => {
  const src = 'uniform float g_Speed; // {"material":"speed","default":2}\n// [COMBO] {"material":"Mode","combo":"MODE","default":1}\nvoid main(){}';
  const u = parseUniforms(src);
  const sp = (Array.isArray(u) ? u : Object.values(u)).find((x) => x.name === 'g_Speed');
  assert.ok(sp, 'g_Speed parsed');
  const c = parseCombos(src);
  assert.equal(c.MODE, 1, 'MODE combo parsed with its default');
});

const WE_ASSETS = 'F:/Steam/steamapps/common/wallpaper_engine/assets';
test('real Wallpaper Engine textures decode (skipped if WE is not installed)', { skip: !fs.existsSync(WE_ASSETS) }, () => {
  const dir = path.join(WE_ASSETS, 'materials');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (files.length >= 25) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.tex')) files.push(p); } };
  walk(dir);
  assert.ok(files.length > 0);
  for (const f of files) {
    const t = parseTex(new Uint8Array(fs.readFileSync(f))); // read-only
    assert.ok(t.width > 0 && t.height > 0, f);
  }
});
