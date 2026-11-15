'use strict';
// Writes THIRD_PARTY_NOTICES.txt: the licence of every third-party component that ships inside
// Astral Engine (runtime npm dependencies, Electron, the bundled fonts). Build-only tools are not
// shipped and are not listed. Chromium's own notices ship as LICENSES.chromium.html next to the exe.
// Run with `npm run notices` (also runs before `npm run dist`).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const readLicense = (dir) => {
  const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
};

const sections = [];
// Runtime dependencies (whole tree, production only)
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: root, encoding: 'utf8' }));
const seen = new Set();
const walk = (deps) => {
  for (const [name, d] of Object.entries(deps || {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(root, 'node_modules', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    sections.push({ name: `${name} ${d.version || meta.version}`, url: (meta.homepage || (meta.repository && (meta.repository.url || meta.repository)) || ''), license: meta.license, text: readLicense(dir) });
    walk(d.dependencies);
  }
};
walk(tree.dependencies);

// Electron runtime (a dev dependency for building, but its binaries are what the app runs on)
const eDir = path.join(root, 'node_modules', 'electron');
sections.push({ name: `Electron ${require(path.join(eDir, 'package.json')).version}`, url: 'https://www.electronjs.org/', license: 'MIT', text: readLicense(eDir) || fs.readFileSync(path.join(eDir, 'dist', 'LICENSE'), 'utf8').trim() });
sections.push({ name: 'Chromium and its components', url: 'https://www.chromium.org/', license: 'BSD-3-Clause and others', text: 'Full notices for Chromium and every library it includes ship with the app as LICENSES.chromium.html in the installation folder.' });

// Bundled fonts (SIL Open Font License 1.1)
const fontDir = path.join(root, 'src', 'renderer', 'fonts');
const fonts = JSON.parse(fs.readFileSync(path.join(fontDir, 'fonts.json'), 'utf8'));
sections.push({ name: `Fonts: ${fonts.join(', ')}`, url: 'https://fonts.google.com/', license: 'OFL-1.1', text: fs.readFileSync(path.join(fontDir, 'LICENSES.txt'), 'utf8').trim() });

const bar = '='.repeat(78);
let out = `${pkg.productName} ${pkg.version} - third-party notices\n\n${pkg.productName} itself is released under the MIT licence (see LICENSE).\nIt includes the following third-party software, each under its own licence.\n\n`;
for (const s of sections) out += `${bar}\n${s.name}\nLicence: ${s.license || 'see below'}${s.url ? `\nSource: ${String(s.url).replace(/^git\+/, '')}` : ''}\n${bar}\n\n${s.text || '(licence text not included in the package)'}\n\n`;
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), out);
console.log('notices:', sections.map((s) => s.name.split(':')[0]).join(' | '));
