// System-audio spectrum (Wallpaper Engine format: 64 left + 64 right values, ~0..1),
// captured inside the wallpaper's own process so no extra helper process is needed.
export async function startAudioCapture(onSamples) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) throw new Error('no loopback audio');
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const src = ctx.createMediaStreamSource(stream);
  const split = ctx.createChannelSplitter(2);
  src.connect(split);
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.5; a.minDecibels = -90; a.maxDecibels = -20; return a; };
  const L = mk(), R = mk();
  split.connect(L, 0); split.connect(R, 1);
  const bufL = new Float32Array(L.frequencyBinCount), bufR = new Float32Array(R.frequencyBinCount);
  const nyq = ctx.sampleRate / 2;
  const edges = [];
  for (let i = 0; i <= 64; i++) edges.push(Math.min(L.frequencyBinCount - 1, Math.max(1, Math.round((30 * Math.pow(16000 / 30, i / 64)) / nyq * L.frequencyBinCount))));
  const out = new Float32Array(128);
  const bands = (buf, off) => {
    for (let i = 0; i < 64; i++) {
      let m = -Infinity;
      for (let k = edges[i]; k <= Math.max(edges[i], edges[i + 1] - 1); k++) if (buf[k] > m) m = buf[k];
      const v = Math.max(0, (m - L.minDecibels) / (L.maxDecibels - L.minDecibels));
      out[off + i] = Math.min(1.5, v * v * 1.2);
    }
  };
  let paused = false;
  const timer = setInterval(() => {
    if (paused) return;
    L.getFloatFrequencyData(bufL); R.getFloatFrequencyData(bufR);
    bands(bufL, 0); bands(bufR, 64);
    onSamples(out);
  }, 33);
  return {
    setPaused(p) { paused = p; if (p) ctx.suspend(); else ctx.resume(); },
    stop() { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close(); }
  };
}
