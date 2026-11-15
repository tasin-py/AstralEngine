// Wallpaper host page: plays video, image and scene wallpapers.
import { SceneWallpaper } from '../scene/scene.js';
import { startAudioCapture } from './audiocap.js';
let audioCap = null;
async function syncAudioCapture() {
  const want = cfg && cfg.item.supportsAudio && cfg.item.type === 'scene' && cfg.audio && cfg.audio.audioVisualizer !== false;
  if (want && !audioCap) { try { audioCap = await startAudioCapture((a) => player && player.setAudio && player.setAudio(a)); } catch (e) { window.host.error('audio capture: ' + e.message); audioCap = false; } }
  else if (!want && audioCap) { audioCap.stop(); audioCap = null; }
  if (audioCap) audioCap.setPaused(!player || (player.state !== 'run' && player.state !== 'mute'));
}

const params = new URLSearchParams(location.search);
const slot = params.get('slot');
const stage = document.getElementById('stage');
const fileUrl = (p) => 'astral://f/' + encodeURIComponent(p);

let player = null;
let cfg = null;

// Built-in display properties shared by every wallpaper type (keys start with "_ae_").
const builtin = { volume: 100, rate: 1, align: null, flip: false, filter: 'smooth', coloropts: false, brightness: 100, contrast: 100, saturation: 100, hue: 0 };
const valOf = (p) => (p && typeof p === 'object' && 'value' in p ? p.value : p);
function applyBuiltin(props) {
  if (!props) return;
  for (const [k, p] of Object.entries(props)) if (k.startsWith('_ae_')) builtin[k.slice(4)] = valOf(p);
  const b = builtin;
  stage.style.transform = b.flip ? 'scaleX(-1)' : '';
  stage.style.imageRendering = b.filter === 'pixel' ? 'pixelated' : '';
  stage.style.filter = b.coloropts
    ? `brightness(${Number(b.brightness) / 100}) contrast(${Number(b.contrast) / 100}) saturate(${Number(b.saturation) / 100}) hue-rotate(${Number(b.hue)}deg)`
    : '';
  if (b.align) for (const m of stage.querySelectorAll('video,img')) m.style.objectFit = ({ cover: 'cover', contain: 'contain', stretch: 'fill' })[b.align] || 'cover';
  if (player && player.setBuiltin) player.setBuiltin(b);
}

function fitMode(props) {
  const p = props && (props.alignment || props.fit || props.scaling);
  const v = p && p.value;
  return ({ 0: 'cover', 1: 'contain', 2: 'fill', cover: 'cover', contain: 'contain', stretch: 'fill', fill: 'fill' })[v] || 'cover';
}

class VideoWallpaper {
  constructor(c) {
    this.c = c;
    const v = this.v = document.createElement('video');
    v.src = fileUrl(c.item.entry);
    v.loop = true; v.autoplay = true; v.playsInline = true; v.preload = 'auto';
    v.disablePictureInPicture = true; v.disableRemotePlayback = true;
    v.style.objectFit = fitMode(c.props);
    stage.appendChild(v);
    this.applyAudio(c.audio, c.state);
    this.applyProps(c.props);
    v.addEventListener('error', () => window.host.error('video error ' + (v.error && v.error.message)));
    this.setState(c.state);
  }
  applyAudio(a, state) {
    this.audio = a || this.audio;
    this.v.volume = Math.max(0, Math.min(1, (this.audio.volume ?? 50) / 100 * (Number(builtin.volume) / 100)));
    this.v.muted = !!this.audio.muted || state === 'mute' || (this.props && this.props.muted);
  }
  applyProps(props) {
    if (!props) return;
    this.props = this.props || {};
    for (const [k, p] of Object.entries(props)) {
      const val = p && typeof p === 'object' && 'value' in p ? p.value : p;
      if (k === 'rate' || k === 'playbackrate' || k === 'speed') this.v.playbackRate = Math.max(0.1, Math.min(4, Number(val) || 1));
      if (k === 'alignment' || k === 'fit' || k === 'scaling') this.v.style.objectFit = fitMode({ [k]: { value: val } });
    }
  }
  setBuiltin(b) { this.v.playbackRate = Math.max(0.1, Math.min(4, Number(b.rate) || 1)); this.applyAudio(null, this.state); }
  setState(st) {
    this.state = st;
    if (st === 'pause' || st === 'stop') this.v.pause();
    else this.v.play().catch(() => {});
    this.applyAudio(null, st);
  }
  destroy() { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); this.v.remove(); }
}

class ImageWallpaper {
  constructor(c) {
    const i = this.i = document.createElement('img');
    i.src = fileUrl(c.item.entry || c.item.preview);
    i.style.objectFit = fitMode(c.props);
    stage.appendChild(i);
  }
  applyProps(props) { if (props) this.i.style.objectFit = fitMode(props); }
  applyAudio() {}
  setState() {}
  destroy() { this.i.remove(); }
}

function message(text) {
  const d = document.createElement('div'); d.className = 'msg'; d.textContent = text; stage.appendChild(d);
}

async function start() {
  cfg = await window.host.init(slot);
  if (!cfg) return;
  const t = cfg.item.type;
  try {
    if (t === 'video') player = new VideoWallpaper(cfg);
    else if (t === 'image') player = new ImageWallpaper(cfg);
    else if (t === 'scene') {
      const canvas = document.createElement('canvas');
      stage.appendChild(canvas);
      player = new SceneWallpaper(canvas, cfg);
      await player.load();
      syncAudioCapture();
    }
    if (t === 'scene' && player) player.setBuiltin = (b) => { player.volumeMul = Number(b.volume) / 100; player.rate = Number(b.rate) || 1; player.updateSoundVolumes && player.updateSoundVolumes(); };
    if (t !== 'video' && t !== 'image' && t !== 'scene') {
      message('This wallpaper type (' + t + ') is not supported yet.');
    }
    applyBuiltin(cfg.props);
  } catch (e) {
    console.error(e);
    window.host.error((e && e.stack) || e);
    // Fall back to the preview image so the desktop never stays black.
    if (player && player.destroy) try { player.destroy(); } catch {}
    stage.innerHTML = '';
    if (cfg.item.preview) { player = new ImageWallpaper({ item: { entry: cfg.item.preview }, props: {} }); }
    else message('Could not load this wallpaper.');
  }
}

// Diagnostics used by the self-test (no effect on normal use).
window.__diag = () => {
  const p = player;
  const inner = [innerWidth, innerHeight, devicePixelRatio, screen.width, screen.height, stage.style.filter, stage.style.transform];
  if (!p || !p.objects) return { type: cfg && cfg.item.type, player: !!p, inner };
  return {
    inner, W: p.W, H: p.H, res: p.res, canvas: [p.canvas.width, p.canvas.height], fbo: p.sceneFBO && [p.sceneFBO.w, p.sceneFBO.h], state: p.state, time: p.time,
    objects: p.objects.map((o) => ({ n: o.src.name, t: o.type, vis: o.visible, a: o.alpha, tex: !!(o.tex && o.tex.tex), fx: o.effects.length, cap: o.capture || '', size: o.size, org: o.origin })),
    progsFailed: [...p.programs.values()].filter((x) => !x).length, progs: p.programs.size, glErr: p.gl.getError()
  };
};
window.host.on('wp:props', (p) => { if (player && player.applyProps) player.applyProps(p); applyBuiltin(p); });
window.host.on('wp:state', (st) => { if (player && player.setState) player.setState(st); if (audioCap) audioCap.setPaused(st !== 'run' && st !== 'mute'); });
window.host.on('wp:settings', (s) => { if (cfg && s.audio) { cfg.audio = s.audio; syncAudioCapture(); } if (player) { player.applyAudio && player.applyAudio(s.audio, player.state); player.applySettings && player.applySettings(s); } });
window.host.on('wp:cursor', (c) => player && player.setCursor && player.setCursor(c));
window.host.on('wp:audio', (a) => player && player.setAudio && player.setAudio(a));

start();
