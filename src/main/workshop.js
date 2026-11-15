'use strict';
// Steam Workshop browsing for Wallpaper Engine items (app 431960).
// - Browse/search: public Workshop pages (or the official Web API when the user adds a key)
// - Details: ISteamRemoteStorage/GetPublishedFileDetails (public, no key)
// - Subscribe/unsubscribe: opens the item in the Steam app; Astral never handles the Steam login.

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
  const m = html.match(/of\s+([\d,]+)\s+entries/i) || html.match(/([\d,]+)\s+entries\s+matching/i);
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

const TYPES = ['Scene', 'Video', 'Web', 'Application'];
const RATINGS = ['Everyone', 'Questionable', 'Mature'];
const GENRES = ['Abstract', 'Animal', 'Anime', 'Cartoon', 'CGI', 'Cyberpunk', 'Fantasy', 'Game', 'Girls', 'Landscape', 'Medieval', 'Memes', 'MMD', 'Music', 'Nature', 'Pixel art', 'Relaxing', 'Retro', 'Sci-Fi', 'Sports', 'Technology', 'Television', 'Vehicle'];

/**
 * Steam only supports "has ALL of these tags" (requiredtags) and "has none of these" (excludedtags),
 * and the public pages ignore match_all_tags. Checking several types, ratings or genres should mean
 * "any of them" (as in Wallpaper Engine), so a group with several boxes checked becomes "exclude the
 * unchecked ones", plus a client-side "has at least one" check for genres. Misc tags stay required.
 */
function tagQuery(opts) {
  const required = [], excluded = [];
  const group = (all, picked) => {
    const on = all.filter((t) => picked.includes(t));
    if (!on.length || on.length === all.length) return [];
    if (on.length === 1) { required.push(on[0]); return []; }
    excluded.push(...all.filter((t) => !on.includes(t)));
    return on;
  };
  const tags = opts.tags || [];
  group(TYPES, opts.types || []);
  group(RATINGS, opts.ratings && opts.ratings.length ? opts.ratings : ['Everyone']);
  const anyOf = group(GENRES, tags);
  required.push(...tags.filter((t) => !GENRES.includes(t)));
  return { required, excluded, anyOf };
}

/**
 * Browse / search the Workshop.
 * opts: { page, sort, search, types:[], tags:[], ratings:[], days, apiKey }
 */
async function browse(opts = {}) {
  const page = Math.max(1, opts.page || 1);
  const sort = SORTS[opts.sort] || SORTS.trend;
  const perPage = 30;
  const { required, excluded, anyOf } = tagQuery(opts);
  const keep = (it) => !anyOf.length || (it.tags || []).some((t) => anyOf.includes(t));

  if (opts.apiKey) {
    const p = new URLSearchParams({
      key: opts.apiKey, query_type: String(sort.apiType), page: String(page), numperpage: String(perPage),
      appid: APPID, return_tags: 'true', return_previews: 'false', search_text: opts.search || '',
      match_all_tags: 'true', days: String(opts.days || 7), filetype: '0'
    });
    required.forEach((t, i) => p.set(`requiredtags[${i}]`, t));
    excluded.forEach((t, i) => p.set(`excludedtags[${i}]`, t));
    const r = await fetch('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?' + p, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const j = await r.json();
      const files = (j.response && j.response.publishedfiledetails) || [];
      const total = (j.response && j.response.total) || 0;
      const items = files.map(normalize).filter(keep);
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
  for (const t of required) parts.push('requiredtags%5B%5D=' + encodeURIComponent(t));
  for (const t of excluded) parts.push('excludedtags%5B%5D=' + encodeURIComponent(t));
  const url = 'https://steamcommunity.com/workshop/browse/?' + parts.join('&');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en' } });
  if (!r.ok) throw new Error('Workshop unavailable (' + r.status + ')');
  const html = await r.text();
  const ids = parseIds(html).slice(0, perPage);
  let items = await getDetails(ids);
  items = items.filter((i) => i.ok && !i.banned && !excluded.includes(i.rating) && keep(i));
  const total = parseTotal(html);
  return { page, total, pages: total ? Math.ceil(total / perPage) : (ids.length >= perPage ? page + 1 : page), items };
}

module.exports = { browse, tagQuery, getDetails, parseIds, parseTotal, normalize, SORTS, APPID };
