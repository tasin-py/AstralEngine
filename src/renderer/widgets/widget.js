'use strict';
// Desktop widgets. One file renders every widget type; timers only run as often as needed.
const W = window.widgetApi;
const id = new URLSearchParams(location.search).get('id');
const box = document.getElementById('w');
const c = document.getElementById('c');
let cfg = null;
let timers = [];
let audio = new Array(128).fill(0);
let stats = null;
const every = (ms, f) => { f(); timers.push(setInterval(f, ms)); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const pad = (n) => String(n).padStart(2, '0');

document.getElementById('close').onclick = () => W.remove(id);

function apply(newCfg) {
  const typeChanged = !cfg || cfg.type !== newCfg.type || JSON.stringify(cfg.options) !== JSON.stringify(newCfg.options);
  cfg = newCfg;
  const o = cfg.options || {};
  box.className = 'w ' + (o.theme || 'glass');
  box.style.setProperty('--op', o.opacity ?? 0.85);
  box.style.setProperty('--acc', o.accent || '#3d8bfd');
  const sc = o.scale || 1;
  box.style.transform = sc !== 1 ? `scale(${sc})` : '';
  box.style.width = sc !== 1 ? `calc((100% - 8px) / ${sc})` : '';
  box.style.height = sc !== 1 ? `calc((100% - 8px) / ${sc})` : '';
  document.body.classList.toggle('unlocked', !cfg.locked);
  if (typeChanged) render();
}

function render() {
  timers.forEach(clearInterval); timers = [];
  c.innerHTML = '';
  const o = cfg.options || {};
  const r = RENDER[cfg.type];
  if (r) r(o); else c.textContent = 'Unknown widget';
}

const RENDER = {
  clock(o) {
    c.innerHTML = '<div class="big" id="t"></div><div class="sub" id="d"></div>';
    const t = document.getElementById('t'), d = document.getElementById('d');
    const h24 = o.h24 !== false;
    every(o.seconds ? 1000 : 5000, () => {
      const n = new Date();
      let h = n.getHours();
      let suffix = '';
      if (!h24) { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12 || 12; }
      t.innerHTML = `${pad(h)}:${pad(n.getMinutes())}${o.seconds ? `<span class="acc">:${pad(n.getSeconds())}</span>` : ''}<span style="font-size:22px">${suffix}</span>`;
      d.textContent = o.date === false ? '' : n.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    });
  },
  analog(o) {
    c.style.padding = '8px';
    const cv = document.createElement('canvas'); c.appendChild(cv);
    const draw = () => {
      const s = Math.min(cv.clientWidth, cv.clientHeight) * devicePixelRatio;
      cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio;
      const x = cv.getContext('2d'); const cx = cv.width / 2, cy = cv.height / 2, R = s / 2 - 4;
      x.clearRect(0, 0, cv.width, cv.height);
      const fg = getComputedStyle(box).color;
      x.strokeStyle = fg; x.fillStyle = fg;
      for (let i = 0; i < 60; i++) { const a = i * Math.PI / 30; const l = i % 5 ? R * 0.04 : R * 0.1; x.lineWidth = i % 5 ? 1 * devicePixelRatio : 3 * devicePixelRatio; x.globalAlpha = i % 5 ? 0.4 : 0.9; x.beginPath(); x.moveTo(cx + Math.sin(a) * (R - l), cy - Math.cos(a) * (R - l)); x.lineTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); x.stroke(); }
      x.globalAlpha = 1;
      const n = new Date();
      const hand = (a, len, w, col) => { x.strokeStyle = col; x.lineWidth = w * devicePixelRatio; x.lineCap = 'round'; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len); x.stroke(); };
      hand((n.getHours() % 12 + n.getMinutes() / 60) * Math.PI / 6, R * 0.5, 5, fg);
      hand((n.getMinutes() + n.getSeconds() / 60) * Math.PI / 30, R * 0.75, 3.5, fg);
      if (o.seconds !== false) hand(n.getSeconds() * Math.PI / 30, R * 0.85, 1.5, o.accent || '#3d8bfd');
      x.fillStyle = o.accent || '#3d8bfd'; x.beginPath(); x.arc(cx, cy, 4 * devicePixelRatio, 0, 7); x.fill();
    };
    every(o.seconds !== false ? 1000 : 20000, draw);
  },
  calendar() {
    let off = 0;
    const draw = () => {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() + off, 1);
      const first = (d.getDay() + 6) % 7;
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const prevDays = new Date(d.getFullYear(), d.getMonth(), 0).getDate();
      let html = `<div class="calh"><button id="p">‹</button><span>${d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span><button id="n">›</button></div><table class="cal"><tr>${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((x) => `<th>${x}</th>`).join('')}</tr>`;
      let day = 1 - first;
      for (let r = 0; r < 6; r++) {
        html += '<tr>';
        for (let k = 0; k < 7; k++, day++) {
          if (day < 1) html += `<td class="o">${prevDays + day}</td>`;
          else if (day > days) html += `<td class="o">${day - days}</td>`;
          else html += `<td class="${off === 0 && day === now.getDate() ? 't' : ''}">${day}</td>`;
        }
        html += '</tr>';
        if (day > days) break;
      }
      c.innerHTML = html + '</table>';
      document.getElementById('p').onclick = () => { off--; draw(); };
      document.getElementById('n').onclick = () => { off++; draw(); };
    };
    every(60000, draw);
  },
  sysmon() {
    const gb = (b) => (b / 1073741824).toFixed(1);
    const draw = () => {
      if (!stats) { c.innerHTML = '<div class="sub">Reading system…</div>'; return; }
      const mem = 1 - stats.memFree / stats.memTotal;
      const disk = stats.disk ? 1 - stats.disk.free / stats.disk.total : 0;
      const up = stats.uptime; const hh = Math.floor(up / 3600), mm = Math.floor(up % 3600 / 60);
      c.innerHTML = `
        <div class="meter"><div class="ml"><span>CPU</span><span>${stats.cpu}%</span></div><div class="bar"><div style="width:${stats.cpu}%"></div></div></div>
        <div class="meter"><div class="ml"><span>RAM</span><span>${gb(stats.memTotal - stats.memFree)} / ${gb(stats.memTotal)} GB</span></div><div class="bar"><div style="width:${mem * 100}%"></div></div></div>
        ${stats.disk ? `<div class="meter"><div class="ml"><span>Disk C:</span><span>${gb(stats.disk.free)} GB free</span></div><div class="bar"><div style="width:${disk * 100}%"></div></div></div>` : ''}
        <div class="sub" style="font-size:12px">Up ${hh}h ${mm}m · ${stats.cores} threads</div>`;
    };
    draw();
    RENDER._stats = draw;
  },
  weather(o) {
    const units = o.units === 'f' ? 'fahrenheit' : 'celsius';
    const CODES = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm' };
    const ICON = (code) => code === 0 ? '☀️' : code <= 2 ? '⛅' : code === 3 ? '☁️' : code < 50 ? '🌫️' : code < 70 ? '🌧️' : code < 80 ? '❄️' : code < 90 ? '🌦️' : '⛈️';
    if (!o.city) { c.innerHTML = '<div class="sub">Set your city in the widget settings<br>(Astral › Widgets › Settings).</div>'; return; }
    const load = async () => {
      try {
        const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(o.city))).json();
        const p = g.results && g.results[0];
        if (!p) { c.innerHTML = `<div class="sub">City "${esc(o.city)}" not found.</div>`; return; }
        const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&temperature_unit=${units}&timezone=auto`)).json();
        const cur = w.current; const d = w.daily;
        c.innerHTML = `<div style="display:flex;align-items:center;gap:14px"><div style="font-size:46px">${ICON(cur.weather_code)}</div><div><div class="big" style="font-size:44px">${Math.round(cur.temperature_2m)}°</div><div class="sub" style="margin-top:2px">${esc(CODES[cur.weather_code] || '')}</div></div></div>
          <div class="sub" style="font-size:13px">${esc(p.name)} · H ${Math.round(d.temperature_2m_max[0])}° L ${Math.round(d.temperature_2m_min[0])}° · 💧${cur.relative_humidity_2m}% · 💨${Math.round(cur.wind_speed_10m)} km/h</div>`;
      } catch { c.innerHTML = '<div class="sub">Weather unavailable (offline?)</div>'; }
    };
    every(20 * 60000, load);
  },
  notes(o) {
    box.classList.add('notew');
    box.style.background = o.noteColor || '#f7e26b';
    c.innerHTML = '<textarea class="note" spellcheck="false" placeholder="Write a note…"></textarea>';
    const ta = c.querySelector('textarea');
    ta.value = o.text || '';
    let t;
    ta.oninput = () => { clearTimeout(t); t = setTimeout(() => W.update(id, { options: { text: ta.value } }), 500); };
  },
  visualizer(o) {
    c.style.padding = '10px';
    const cv = document.createElement('canvas'); c.appendChild(cv);
    const bars = Math.max(8, Math.min(64, o.bars || 48));
    const smooth = new Array(bars).fill(0);
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio;
      const x = cv.getContext('2d');
      x.clearRect(0, 0, cv.width, cv.height);
      const bw = cv.width / bars;
      x.fillStyle = o.accent || '#3d8bfd';
      let any = false;
      for (let i = 0; i < bars; i++) {
        const k = Math.floor(i * 64 / bars);
        const v = Math.min(1, ((audio[k] || 0) + (audio[64 + k] || 0)) / 2);
        smooth[i] += (v - smooth[i]) * 0.35;
        if (smooth[i] > 0.002) any = true;
        const h = Math.max(2 * devicePixelRatio, smooth[i] * cv.height);
        x.fillRect(i * bw + bw * 0.15, cv.height - h, bw * 0.7, h);
      }
      if (!any) { cancelAnimationFrame(raf); raf = null; }
    };
    RENDER._wake = () => { if (!raf) draw(); };
    draw();
  },
  battery() {
    if (!navigator.getBattery) { c.innerHTML = '<div class="sub">Battery info unavailable</div>'; return; }
    navigator.getBattery().then((b) => {
      const draw = () => {
        const p = Math.round(b.level * 100);
        c.innerHTML = `<div style="display:flex;align-items:center;gap:12px"><div class="big" style="font-size:38px">${p}%</div><div class="sub" style="margin:0">${b.charging ? '⚡ Charging' : 'On battery'}</div></div><div class="bar" style="margin-top:8px"><div style="width:${p}%"></div></div>`;
      };
      b.onlevelchange = draw; b.onchargingchange = draw; draw();
    });
  },
  countdown(o) {
    c.innerHTML = '<div class="sub" id="ct" style="margin:0 0 4px"></div><div class="big" id="cd" style="font-size:36px"></div>';
    const target = o.target ? new Date(o.target.replace(' ', 'T')) : new Date(new Date().getFullYear() + 1, 0, 1);
    document.getElementById('ct').textContent = o.title || 'New Year';
    every(1000, () => {
      let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
      if (Number.isNaN(s)) { document.getElementById('cd').textContent = 'Set a date'; return; }
      const d = Math.floor(s / 86400); s %= 86400;
      document.getElementById('cd').textContent = `${d}d ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
    });
  },
  async photo(o) {
    if (!o.photo) { c.innerHTML = '<div class="sub">Choose a picture in the widget settings.</div>'; return; }
    const url = await W.fileUrl(o.photo);
    c.innerHTML = '';
    const d = document.createElement('div'); d.className = 'photo';
    if (url) d.style.backgroundImage = `url("${url}")`;
    box.appendChild(d);
  },
  quote(o) {
    const builtin = [['The best way to predict the future is to invent it.', 'Alan Kay'], ['Simplicity is prerequisite for reliability.', 'Edsger Dijkstra'], ['Stay hungry, stay foolish.', 'Stewart Brand'], ['Make it work, make it right, make it fast.', 'Kent Beck'], ['What we think, we become.', 'Buddha'], ['Small steps every day.', ''], ['Done is better than perfect.', '']];
    const custom = String(o.quotes || '').split(/\n|\|/).map((s) => s.trim()).filter(Boolean).map((q) => [q, '']);
    const list = custom.length ? custom : builtin;
    const day = Math.floor(Date.now() / 86400000);
    const [q, a] = list[day % list.length];
    c.innerHTML = `<div class="quote">“${esc(q)}”</div>${a ? `<div class="qa">— ${esc(a)}</div>` : ''}`;
  }
};

W.on('widget:config', apply);
W.on('widget:stats', (s) => { stats = s; if (RENDER._stats && cfg && cfg.type === 'sysmon') RENDER._stats(); });
W.on('widget:audio', (a) => { audio = a; if (RENDER._wake) RENDER._wake(); });
W.config(id).then((c0) => { if (c0) apply(c0); });
