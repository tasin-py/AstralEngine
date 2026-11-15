'use strict';
// Update checker backed by GitHub Releases. Set the repository in
// src/main/config.js (UPDATE_REPO) or in Settings > About.

const fs = require('fs');
const path = require('path');

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), pre: m[4] || '' };
}

/** Returns >0 if a is newer than b. Pre-releases sort before the release. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function normalizeRepo(repo) {
  if (!repo) return '';
  const m = String(repo).trim().match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

async function checkForUpdate({ repo, currentVersion, includePrerelease = false }) {
  const r = normalizeRepo(repo);
  if (!r) return { status: 'not-configured' };
  const url = includePrerelease ? `https://api.github.com/repos/${r}/releases?per_page=10` : `https://api.github.com/repos/${r}/releases/latest`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AstralEngine-Updater' } });
  if (res.status === 404) return { status: 'no-releases', repo: r };
  // The anonymous API allows 60 calls/hour per IP (shared networks hit this). Fall back to the web pages.
  if (res.status === 403 || res.status === 429) return checkViaWeb(r, currentVersion);
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  let rel = await res.json();
  if (Array.isArray(rel)) rel = rel.find((x) => !x.draft) || null;
  if (!rel) return { status: 'no-releases', repo: r };
  const latest = rel.tag_name || rel.name;
  const newer = compareVersions(latest, currentVersion) > 0;
  const assets = (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const installer = assets.find((a) => /setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)) || null;
  return {
    status: newer ? 'update-available' : 'up-to-date',
    repo: r, current: currentVersion, latest, notes: rel.body || '', url: rel.html_url,
    publishedAt: rel.published_at, installer, assets
  };
}

/** Fallback without the API: /releases/latest redirects to /releases/tag/<tag>; assets are listed on expanded_assets. */
async function checkViaWeb(r, currentVersion) {
  const ua = { 'User-Agent': 'AstralEngine-Updater' };
  const res = await fetch(`https://github.com/${r}/releases/latest`, { headers: ua, redirect: 'follow' });
  if (res.status === 404) return { status: 'no-releases', repo: r };
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const m = res.url.match(/\/releases\/tag\/([^/?#]+)/);
  if (!m) return { status: 'no-releases', repo: r };
  const tag = decodeURIComponent(m[1]);
  let assets = [];
  try {
    const html = await (await fetch(`https://github.com/${r}/releases/expanded_assets/${encodeURIComponent(tag)}`, { headers: ua })).text();
    const prefix = `/${r}/releases/download/`.toLowerCase();
    const re = /href="([^"]+)"/gi;
    const seen = new Set();
    let x;
    while ((x = re.exec(html))) {
      if (!x[1].toLowerCase().startsWith(prefix) || seen.has(x[1])) continue; seen.add(x[1]);
      assets.push({ name: decodeURIComponent(x[1].split('/').pop()), url: 'https://github.com' + x[1], size: 0 });
    }
  } catch { assets = []; }
  const installer = assets.find((a) => /setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)) || null;
  return {
    status: compareVersions(tag, currentVersion) > 0 ? 'update-available' : 'up-to-date',
    repo: r, current: currentVersion, latest: tag, notes: '', url: res.url, publishedAt: null, installer, assets, via: 'web'
  };
}

/** Streams the installer to disk, reporting progress. */
async function downloadInstaller(asset, destDir, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, asset.name.replace(/[^\w.-]/g, '_'));
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'AstralEngine-Updater' } });
  if (!res.ok || !res.body) throw new Error('Download failed: ' + res.status);
  const total = Number(res.headers.get('content-length') || asset.size || 0);
  const out = fs.createWriteStream(dest);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (onProgress && total) onProgress(done / total);
  }
  await new Promise((r, j) => { out.end(r); out.on('error', j); });
  return dest;
}

module.exports = { checkForUpdate, compareVersions, parseVersion, normalizeRepo, downloadInstaller };
