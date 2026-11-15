'use strict';
// Builds benchmarks/RESULTS.md from the JSON files written by scripts/bench-processes.ps1.
// Usage: node scripts/bench-report.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'benchmarks');
const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
  r.processes = [].concat(r.processes || []);
  r.file = f;
  return r;
}).sort((a, b) => String(a.date).localeCompare(String(b.date)));

// Newest run per (app, label)
const latest = new Map();
for (const r of runs) latest.set(r.app + '|' + r.label, r);

const sum = (ps, pick) => ps.reduce((a, p) => a + (Number(p[pick]) || 0), 0);
const fmt = (v, d = 0) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
const APP = { we: 'Wallpaper Engine', astral: 'Astral Engine' };

// "Core" = only the processes needed to show the wallpaper (no library window).
const core = (r) => r.app === 'we' ? r.processes.filter((p) => !/^wallpaperui/i.test(p.name)) : r.processes;

let md = '# Resource usage: Wallpaper Engine vs Astral Engine\n\n';
md += 'Measured with `scripts/bench-processes.ps1` (same method for both apps: CPU time delta over the window, ';
md += 'working set and private memory at the end, GPU = Windows "GPU Engine" counters for the app\'s PIDs). ';
md += 'Regenerate this file with `npm run bench:report`.\n\n';
md += '| Scenario | App | Processes | CPU % | RAM (working set) | Private memory | GPU % | Measured |\n|---|---|---:|---:|---:|---:|---:|---|\n';
for (const r of latest.values()) {
  const t = r.totals || {};
  md += `| ${r.label} | ${APP[r.app] || r.app} (everything) | ${t.processes} | ${fmt(t.cpuPct, 2)} | ${t.workingSetMB} MB | ${t.privateMB} MB | ${fmt(t.gpuPct, 1)} | ${String(r.date).slice(0, 16).replace('T', ' ')} |\n`;
  if (r.app === 'we') {
    const c = core(r);
    md += `| ${r.label} | Wallpaper Engine (wallpaper only, UI excluded) | ${c.length} | ${fmt(sum(c, 'cpuPct'), 2)} | ${sum(c, 'workingSetMB')} MB | ${sum(c, 'privateMB')} MB | – | |\n`;
  }
}

// Side-by-side for labels measured for both apps
const pairs = [];
for (const r of latest.values()) {
  if (r.app !== 'we') continue;
  const l = latest.get('astral|' + r.label);
  if (l) pairs.push([r, l]);
}
if (pairs.length) {
  md += '\n## Like-for-like comparisons\n\n| Scenario | Metric | Wallpaper Engine | Astral Engine | Difference |\n|---|---|---:|---:|---:|\n';
  for (const [w, l] of pairs) {
    const rows = [
      ['RAM, everything', w.totals.workingSetMB, l.totals.workingSetMB, 'MB'],
      ['RAM, wallpaper only', sum(core(w), 'workingSetMB'), l.totals.workingSetMB, 'MB'],
      ['CPU, everything', w.totals.cpuPct, l.totals.cpuPct, '%'],
      ['GPU', w.totals.gpuPct, l.totals.gpuPct, '%']
    ];
    for (const [m, a, b, u] of rows) {
      const diff = a ? Math.round(((b - a) / a) * 100) : null;
      md += `| ${w.label} | ${m} | ${fmt(a, u === '%' ? 2 : 0)} ${u} | ${fmt(b, u === '%' ? 2 : 0)} ${u} | ${diff === null ? '–' : (diff > 0 ? '+' : '') + diff + ' %'} |\n`;
    }
  }
}

const notes = [...latest.values()].filter((r) => r.note).map((r) => `- **${APP[r.app]} — ${r.label}:** ${r.note}`);
if (notes.length) md += '\n## Notes\n\n' + notes.join('\n') + '\n';
md += '\nRaw data: the `*.json` files in this folder (one per run, per-process detail included).\n';

fs.writeFileSync(path.join(dir, 'RESULTS.md'), md);
console.log(md);
