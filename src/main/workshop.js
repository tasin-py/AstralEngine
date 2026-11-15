'use strict';
// Steam Workshop browsing for Wallpaper Engine items (app 431960).
// - Browse/search: public Workshop pages (or the official Web API when the user adds a key)
// - Details: ISteamRemoteStorage/GetPublishedFileDetails (public, no key)
// - Subscribe/unsubscribe: done as the signed-in Steam Community user, exactly like the
//   Subscribe button on the website. The Steam client then downloads the item, which
//   requires that the account owns Wallpaper Engine.

const APPID = '431960';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const SORTS = {
  trend: { browsesort: 'trend', actualsort: 'trend', apiType: 3 },
  toprated: { browsesort: 'toprated', actualsort: 'toprated', apiType: 0 },
  mostrecent: { browsesort: 'mostrecent', actualsort: 'mostrecent', apiType: 1 },
  lastupdated: { browsesort: 'lastupdated', actualsort: 'lastupdated', apiType: 21 },
  subscribed: { browsesort: 'totaluniquesubscribers', actualsort: 'totaluniquesubscribers', apiType: 9 }
};

const detailCache = new Map(); // id -> {at, data}

function parseIds(html) {
  const seen = new Set();
  const out = [];
  const re = /sharedfiles\/filedetails\/\?id=(\d{6,})/g;
  let m;
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function parseTotal(html) {
  const m = html.match(/of\s+([\d,]+)\s+entries/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function getDetails(ids) {
  const now = Date.now();
  const need = ids.filter((id) => { const c = detailCache.get(id); return !c || now - c.at > 10 * 60e3; });
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const body = new URLSearchParams();
    body.set('itemcount', String(chunk.length));
    chunk.forEach((id, j) => body.set(`publishedfileids[${j}]`, id));
    const r = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST', body, headers: { 'User-Agent': UA }
    });
    if (!r.ok) throw new Error('Steam API error ' + r.status);
    const j = await r.json();
    for (const d of (j.response && j.response.publishedfiledetails) || []) {
      detailCache.set(String(d.publishedfileid), { at: now, data: normalize(d) });
    }
  }
  return ids.map((id) => detailCache.get(id) && detailCache.get(id).data).filter(Boolean);
}

function normalize(d) {
  const tags = (d.tags || []).map((t) => t.tag);
  const typeTag = tags.find((t) => ['Scene', 'Video', 'Web', 'Application', 'Preset'].includes(t));
  return {
    id: String(d.publishedfileid),
    ok: d.result === 1,
    title: d.title || '(unavailable)',
    description: d.description || '',
    preview: d.preview_url || '',
    size: Number(d.file_size || 0),
    creator: d.creator || '',
    subscriptions: d.subscriptions || 0,
    favorited: d.favorited || 0,
    views: d.views || 0,
    created: (d.time_created || 0) * 1000,
    updated: (d.time_updated || 0) * 1000,
    tags,
    type: typeTag ? typeTag.toLowerCase() : '',
    rating: tags.find((t) => ['Everyone', 'Questionable', 'Mature'].includes(t)) || 'Everyone',
    banned: !!d.banned,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`
  };
}

/**
 * Browse / search the Workshop.
 * opts: { page, sort, search, types:[], tags:[], ratings:[], days, apiKey }
 */
async function browse(opts = {}) {
  const page = Math.max(1, opts.page || 1);
  const sort = SORTS[opts.sort] || SORTS.trend;
  const perPage = 30;
  const tags = [...(opts.types || []), ...(opts.tags || [])];
  const ratings = opts.ratings && opts.ratings.length ? opts.ratings : ['Everyone'];

  if (opts.apiKey) {
    const p = new URLSearchParams({
      key: opts.apiKey, query_type: String(sort.apiType), page: String(page), numperpage: String(perPage),
      appid: APPID, return_tags: 'true', return_previews: 'false', search_text: opts.search || '',
      match_all_tags: 'true', days: String(opts.days || 7), filetype: '0'
    });
    tags.forEach((t, i) => p.set(`requiredtags[${i}]`, t));
    if (ratings.length === 1) p.set(`requiredtags[${tags.length}]`, ratings[0]);
    const r = await fetch('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?' + p, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const j = await r.json();
      const files = (j.response && j.response.publishedfiledetails) || [];
      const total = (j.response && j.response.total) || 0;
      const items = files.map(normalize);
      items.forEach((it) => detailCache.set(it.id, { at: Date.now(), data: it }));
      return { page, total, pages: Math.ceil(total / perPage), items };
    }
    // fall through to the public page if the key is rejected
  }

  const q = new URLSearchParams({
    appid: APPID, browsesort: sort.browsesort, actualsort: sort.actualsort,
    section: 'readytouseitems', p: String(page), numperpage: String(perPage)
  });
  if (opts.search) q.set('searchtext', opts.search);
  if (sort.browsesort === 'trend') q.set('days', String(opts.days || 7));
  const parts = [q.toString()];
  for (const t of tags) parts.push('requiredtags%5B%5D=' + encodeURIComponent(t));
  if (ratings.length === 1) parts.push('requiredtags%5B%5D=' + encodeURIComponent(ratings[0]));
  const url = 'https://steamcommunity.com/workshop/browse/?' + parts.join('&');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en' } });
  if (!r.ok) throw new Error('Workshop unavailable (' + r.status + ')');
  const html = await r.text();
  const ids = parseIds(html).slice(0, perPage);
  let items = await getDetails(ids);
  items = items.filter((i) => i.ok && !i.banned && (ratings.length !== 1 || ratings.includes(i.rating)));
  const total = parseTotal(html);
  return { page, total, pages: total ? Math.ceil(total / perPage) : (ids.length >= perPage ? page + 1 : page), items };
}

// ---- Account actions through the Steam Community web session ----
let steamSession = null;
function useSession(ses) { steamSession = ses; }

async function sessionId() {
  if (!steamSession) return null;
  const c = await steamSession.cookies.get({ url: 'https://steamcommunity.com', name: 'sessionid' });
  return c[0] ? c[0].value : null;
}

async function isLoggedIn() {
  if (!steamSession) return false;
  const c = await steamSession.cookies.get({ url: 'https://steamcommunity.com', name: 'steamLoginSecure' });
  return c.length > 0;
}

async function setSubscribed(id, subscribe) {
  if (!steamSession) throw new Error('Steam session not ready');
  if (!(await isLoggedIn())) { const e = new Error('Sign in to Steam first'); e.code = 'LOGIN'; throw e; }
  let sid = await sessionId();
  if (!sid) {
    await steamSession.fetch('https://steamcommunity.com/', { headers: { 'User-Agent': UA } });
    sid = await sessionId();
  }
  const body = new URLSearchParams({ id: String(id), appid: APPID, sessionid: sid || '' });
  const url = `https://steamcommunity.com/sharedfiles/${subscribe ? 'subscribe' : 'unsubscribe'}`;
  const r = await steamSession.fetch(url, {
    method: 'POST', body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': UA, Origin: 'https://steamcommunity.com', Referer: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}` }
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* not json */ }
  if (!r.ok || !j || (j.success !== 1 && j.success !== true)) {
    throw new Error('Steam refused the request' + (j && j.success ? ' (code ' + j.success + ')' : ''));
  }
  return true;
}

module.exports = { browse, getDetails, parseIds, parseTotal, normalize, useSession, isLoggedIn, setSubscribed, SORTS, APPID };
