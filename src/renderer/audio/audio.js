'use strict';
// Captures system output (loopback) and produces Wallpaper Engine-compatible spectrum data:
// 128 values, 64 for the left channel followed by 64 for the right, roughly 0..1.
(async () => {
  let paused = false;
  window.astralAudio.onPaused((p) => { paused = p; });
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { console.error('audio capture failed', e); return; }
  stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const split = ctx.createChannelSplitter(2);
  src.connect(split);
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.5; a.minDecibels = -90; a.maxDecibels = -20; return a; };
  const L = mk(), R = mk();
  split.connect(L, 0); split.connect(R, 1);
  const bufL = new Float32Array(L.frequencyBinCount), bufR = new Float32Array(R.frequencyBinCount);
  const bins = 64;
  // Log-spaced band edges between ~30 Hz and ~16 kHz.
  const nyq = ctx.sampleRate / 2;
  const edges = [];
  for (let i = 0; i <= bins; i++) edges.push(Math.min(L.frequencyBinCount - 1, Math.max(1, Math.round((30 * Math.pow(16000 / 30, i / bins)) / nyq * L.frequencyBinCount))));
  const out = new Array(128).fill(0);
  function bands(buf, off) {
    for (let i = 0; i < bins; i++) {
      let m = -Infinity;
      for (let k = edges[i]; k <= Math.max(edges[i], edges[i + 1] - 1); k++) if (buf[k] > m) m = buf[k];
      const v = Math.max(0, (m - L.minDecibels) / (L.maxDecibels - L.minDecibels));
      out[off + i] = Math.min(1.5, v * v * 1.2);
    }
  }
  let silentFrames = 0;
  setInterval(() => {
    if (paused) return;
    L.getFloatFrequencyData(bufL); R.getFloatFrequencyData(bufR);
    bands(bufL, 0); bands(bufR, 64);
    const silent = out.every((v) => v < 0.001);
    silentFrames = silent ? silentFrames + 1 : 0;
    if (silentFrames < 3) window.astralAudio.send(out); // stop spamming IPC when nothing plays
  }, 33);
})();
