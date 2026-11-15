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
  box.style.fontFamily = o.font ? `"${String(o.font).replace(/"/g, '')}", "Segoe UI", sans-serif` : '';
  document.body.classList.toggle('unlocked', !cfg.locked);
  document.body.classList.toggle('b-solid', o.border === 'solid');
  document.body.classList.toggle('b-none', o.border === 'none');
  document.body.classList.toggle('no-close', o.closeBtn === false);
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
    // Faces: classic, minimal, dots, numbers, roman, neon, modern (filled dial), skeleton (rings).
    const face = o.face || 'classic';
    const acc = o.accent || '#3d8bfd';
    const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    const draw = () => {
      const dpr = devicePixelRatio;
      const s = Math.min(cv.clientWidth, cv.clientHeight) * dpr;
      cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
      const x = cv.getContext('2d'); const cx = cv.width / 2, cy = cv.height / 2, R = s / 2 - 6 * dpr;
      x.clearRect(0, 0, cv.width, cv.height);
      const fg = getComputedStyle(box).color;
      const font = getComputedStyle(box).fontFamily;
      const P = (a, r) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
      const line = (a, r1, r2, w, col, alpha = 1) => { x.globalAlpha = alpha; x.strokeStyle = col; x.lineWidth = w * dpr; x.lineCap = 'round'; x.beginPath(); x.moveTo(...P(a, r1)); x.lineTo(...P(a, r2)); x.stroke(); x.globalAlpha = 1; };
      const dot = (px, py, r, col, alpha = 1) => { x.globalAlpha = alpha; x.fillStyle = col; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); x.globalAlpha = 1; };
      const label = (txt, size) => { x.fillStyle = fg; x.font = `600 ${size}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle'; for (let i = 0; i < 12; i++) x.fillText(txt[i], ...P(i * Math.PI / 6, R * 0.78)); };
      if (face === 'neon') { x.shadowColor = acc; x.shadowBlur = 14 * dpr; }
      if (face === 'modern') { dot(cx, cy, R, fg, 0.08); dot(cx, cy, R * 0.97, acc, 0.12); }
      if (face === 'neon') { x.strokeStyle = acc; x.lineWidth = 2 * dpr; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke(); }
      if (face === 'skeleton') { for (const [r, a] of [[R, 0.5], [R * 0.72, 0.25]]) { x.globalAlpha = a; x.strokeStyle = fg; x.lineWidth = 1.5 * dpr; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.stroke(); } x.globalAlpha = 1; }
      if (face === 'classic' || face === 'neon' || face === 'skeleton') {
        for (let i = 0; i < 60; i++) { const big = i % 5 === 0; line(i * Math.PI / 30, R - (big ? R * 0.11 : R * 0.045), R - 1, big ? 3 : 1, face === 'neon' ? acc : fg, big ? 0.95 : 0.4); }
      } else if (face === 'dots' || face === 'modern') {
        for (let i = 0; i < 12; i++) dot(...P(i * Math.PI / 6, R * 0.86), (i % 3 ? 2.5 : 4.5) * dpr, i % 3 ? fg : acc, i % 3 ? 0.7 : 1);
      } else if (face === 'numbers') {
        label(['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], R * 0.2);
        for (let i = 0; i < 60; i++) if (i % 5) dot(...P(i * Math.PI / 30, R * 0.96), 1.2 * dpr, fg, 0.45);
      } else if (face === 'roman') {
        label(ROMAN, R * 0.16);
        x.globalAlpha = 0.5; x.strokeStyle = fg; x.lineWidth = 1 * dpr; x.beginPath(); x.arc(cx, cy, R * 0.97, 0, 7); x.stroke(); x.globalAlpha = 1;
      } else if (face === 'minimal') {
        for (const i of [0, 3, 6, 9]) line(i * Math.PI / 6, R * 0.86, R, 3, fg, 0.9);
      }
      const n = new Date();
      const sec = n.getSeconds() + (o.smooth ? n.getMilliseconds() / 1000 : 0);
      const hA = (n.getHours() % 12 + n.getMinutes() / 60) * Math.PI / 6, mA = (n.getMinutes() + sec / 60) * Math.PI / 30, sA = sec * Math.PI / 30;
      const thin = face === 'minimal' || face === 'skeleton';
      const handCol = face === 'neon' ? acc : fg;
      line(hA, face === 'modern' ? -R * 0.08 : 0, R * 0.5, thin ? 3 : face === 'modern' ? 7 : 5, handCol);
      line(mA, face === 'modern' ? -R * 0.08 : 0, R * 0.74, thin ? 2 : face === 'modern' ? 5 : 3.5, handCol);
      if (o.seconds !== false) line(sA, -R * 0.12, R * 0.86, 1.5, face === 'neon' ? fg : acc);
      dot(cx, cy, (face === 'modern' ? 6 : 4) * dpr, acc);
      if (face === 'modern') dot(cx, cy, 2 * dpr, '#fff');
      x.shadowBlur = 0;
    };
    every(o.seconds === false ? 20000 : o.smooth ? 50 : 1000, draw);
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
    const COLORS = ['#f7e26b', '#ffb86b', '#ff8fa3', '#d7a8ff', '#8fc8ff', '#8ff0c0', '#ffffff', '#2b2d35'];
    const col = o.noteColor || COLORS[0];
    const paint = (hex) => {
      box.classList.add('notew');
      box.style.background = hex;
      // dark text on light notes, light text on dark notes
      const n = parseInt(hex.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      box.style.color = lum > 0.55 ? '#222' : '#f3f3f3';
    };
    paint(col);
    c.innerHTML = `<textarea class="note" spellcheck="false" placeholder="Write a note…"></textarea>
      <div class="ntools"><button id="nadd" title="New sticky note">+</button><button id="ncol" title="Note colour">🎨</button></div>
      <div class="pal" id="pal">${COLORS.map((h) => `<i data-c="${h}" style="background:${h}" class="${h === col ? 'on' : ''}"></i>`).join('')}<label title="Custom colour"><input type="color" value="${esc(col)}"></label></div>`;
    const ta = c.querySelector('textarea');
    ta.value = o.text || '';
    let t;
    // Saving text must not re-render (that would drop the caret), so keep cfg in step locally.
    ta.oninput = () => { clearTimeout(t); t = setTimeout(() => { cfg.options = { ...cfg.options, text: ta.value }; W.update(id, { options: { text: ta.value } }); }, 400); };
    const pal = document.getElementById('pal'), tools = c.querySelector('.ntools');
    const setColor = (h) => { paint(h); pal.querySelectorAll('i').forEach((i) => i.classList.toggle('on', i.dataset.c === h)); cfg.options = { ...cfg.options, noteColor: h }; W.update(id, { options: { noteColor: h } }); };
    document.getElementById('nadd').onclick = () => W.addNear(id, 'notes', { noteColor: cfg.options.noteColor || col });
    document.getElementById('ncol').onclick = () => { pal.classList.toggle('open'); tools.classList.toggle('open', pal.classList.contains('open')); };
    pal.querySelectorAll('i').forEach((i) => (i.onclick = () => { setColor(i.dataset.c); pal.classList.remove('open'); tools.classList.remove('open'); }));
    pal.querySelector('input').oninput = (e) => setColor(e.target.value);
  },
  visualizer(o) {
    c.style.padding = '10px';
    const cv = document.createElement('canvas'); c.appendChild(cv);
    // Styles: bars, mirror, wave, fill (filled wave), circle (radial bars), ring (radial wave),
    // dots, blocks (LED segments), line (thin spectrum). Colour: accent, gradient or rainbow.
    const style = o.vizStyle || 'bars';
    const bars = Math.max(8, Math.min(128, o.bars || 48));
    const gain = o.sens ?? 1;
    const ease = 1 - Math.min(0.95, Math.max(0, o.smoothing ?? 0.65));
    const thick = o.thickness ?? 2;
    const acc = o.accent || '#3d8bfd', acc2 = o.accent2 || '#ff5fa8';
    const smooth = new Array(bars).fill(0);
    let raf;
    const colorAt = (x, t, i) => (o.colorMode === 'rainbow' ? `hsl(${Math.round(i / bars * 300 + Date.now() / 40) % 360},90%,60%)` : null);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio;
      cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
      const W2 = cv.width, H = cv.height;
      const x = cv.getContext('2d');
      x.clearRect(0, 0, W2, H);
      let any = false;
      for (let i = 0; i < bars; i++) {
        // spread bars over the 64 bands (log-ish so bass doesn't take the whole width)
        const k = Math.min(63, Math.floor(Math.pow(i / bars, 1.35) * 64));
        const v = Math.min(1, gain * ((audio[k] || 0) + (audio[64 + k] || 0)) / 2);
        smooth[i] += (v - smooth[i]) * ease;
        if (smooth[i] > 0.002) any = true;
      }
      let fill = acc;
      if (o.colorMode === 'gradient') {
        const g = style === 'circle' || style === 'ring' ? x.createRadialGradient(W2 / 2, H / 2, 0, W2 / 2, H / 2, Math.min(W2, H) / 2) : x.createLinearGradient(0, H, style === 'mirror' ? 0 : W2, 0);
        g.addColorStop(0, acc); g.addColorStop(1, acc2); fill = g;
      }
      x.fillStyle = fill; x.strokeStyle = fill;
      if (o.glow) { x.shadowColor = acc; x.shadowBlur = 12 * dpr; }
      const bw = W2 / bars;
      const lw = Math.max(1, thick) * dpr;
      if (style === 'bars' || style === 'mirror' || style === 'dots' || style === 'blocks' || style === 'line') {
        for (let i = 0; i < bars; i++) {
          const rc = colorAt(0, 0, i); if (rc) { x.fillStyle = rc; x.strokeStyle = rc; }
          const v = smooth[i];
          const bx = i * bw + bw * 0.15, w = style === 'line' ? lw : bw * 0.7;
          if (style === 'mirror') { const h = Math.max(lw, v * H * 0.5); x.fillRect(bx, H / 2 - h, w, h * 2); }
          else if (style === 'dots') { const r = Math.min(bw * 0.35, 6 * dpr); x.beginPath(); x.arc(bx + w / 2, H - r - v * (H - 2 * r), r, 0, 7); x.fill(); }
          else if (style === 'blocks') { const seg = Math.max(3 * dpr, H / 18), n = Math.round(v * H / seg); for (let s = 0; s < n; s++) x.fillRect(bx, H - (s + 1) * seg + 1 * dpr, w, seg - 2 * dpr); }
          else { const h = Math.max(lw, v * H); x.fillRect(bx + (style === 'line' ? bw * 0.35 - lw / 2 : 0), H - h, w, h); }
        }
      } else if (style === 'wave' || style === 'fill') {
        // smooth curve through the bar heights, mirrored so it reads as a wave
        const pts = smooth.map((v, i) => [i / (bars - 1) * W2, H / 2 - v * H * 0.45 * (i % 2 ? 1 : -1) * (style === 'fill' ? -1 : 1)]);
        if (style === 'fill') pts.forEach((p, i) => (p[1] = H - smooth[i] * H * 0.9 - lw));
        x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) { const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2; x.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my); }
        x.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        if (style === 'fill') { x.lineTo(W2, H); x.lineTo(0, H); x.closePath(); x.globalAlpha = 0.85; x.fill(); x.globalAlpha = 1; }
        else { x.lineWidth = lw; x.lineJoin = 'round'; x.stroke(); }
      } else if (style === 'circle' || style === 'ring') {
        const cx = W2 / 2, cy = H / 2, r0 = Math.min(W2, H) * 0.22, span = Math.min(W2, H) * 0.26;
        x.lineWidth = style === 'circle' ? Math.max(lw, (2 * Math.PI * r0 / bars) * 0.55) : lw; x.lineCap = 'round';
        if (style === 'ring') x.beginPath();
        for (let i = 0; i <= bars; i++) {
          const a = (i / bars) * Math.PI * 2 - Math.PI / 2, v = smooth[i % bars];
          const rc = colorAt(0, 0, i % bars); if (rc) x.strokeStyle = rc;
          if (style === 'circle') { x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (r0 + 2 * dpr + v * span), cy + Math.sin(a) * (r0 + 2 * dpr + v * span)); x.stroke(); }
          else { const r = r0 + v * span; i ? x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : x.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        }
        if (style === 'ring') { x.closePath(); x.stroke(); }
      }
      x.shadowBlur = 0;
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
