// CPU particle simulation for Wallpaper Engine particle systems (sprite renderer).
// Supports the common emitters, initializers and operators; everything is drawn with one
// instanced draw call per system.

import { parseValue } from './shader.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const vec = (v, d = [0, 0, 0]) => { const p = parseValue(v); if (p == null) return d.slice(); if (typeof p === 'number') return [p, p, p]; return [p[0] ?? d[0], p[1] ?? d[1], p[2] ?? d[2]]; };
const num = (v, d) => { const p = parseValue(v); return typeof p === 'number' ? p : Array.isArray(p) ? p[0] : d; };

// Simple value noise for turbulence.
function hash(x, y, z) { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) & 0xffff) / 0xffff; }
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
    l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v), w) * 2 - 1;
}

export class ParticleSystem {
  /**
   * def: particle json, override: object.instanceoverride, frames: sprite frame count
   */
  constructor(def, override = {}, frames = 1) {
    this.def = def;
    const ov = override || {};
    this.ov = {
      count: num(ov.count, 1), rate: num(ov.rate, 1), size: num(ov.size, 1), lifetime: num(ov.lifetime, 1),
      speed: num(ov.speed, 1), alpha: num(ov.alpha, 1),
      color: ov.colorn ? vec(ov.colorn, [1, 1, 1]) : ov.color ? vec(ov.color, [1, 1, 1]) : [1, 1, 1]
    };
    if (ov.color && !ov.colorn) { const c = this.ov.color; if (c[0] > 1 || c[1] > 1 || c[2] > 1) this.ov.color = c.map((x) => x / 255); }
    this.max = Math.max(1, Math.min(20000, Math.round((def.maxcount || 100) * this.ov.count)));
    this.frames = frames;
    this.animationmode = def.animationmode || 'sequence';
    this.seqMul = def.sequencemultiplier || 1;
    this.stride = 12; // x y z size rot r g b a frame life age
    this.data = new Float32Array(this.max * this.stride);
    this.p = []; // particle objects
    this.emitters = (def.emitter || []).map((e) => ({ ...e, acc: 0, rate: num(e.rate, 5) * this.ov.rate, origin: vec(e.origin), dmin: vec(e.distancemin, [0, 0, 0]), dmax: vec(e.distancemax, [0, 0, 0]), dirs: vec(e.directions, [1, 1, 0]), sign: vec(e.sign, [0, 0, 0]), instantaneous: num(e.instantaneous, 0), done: false }));
    this.inits = def.initializer || [];
    this.ops = def.operator || [];
    this.time = 0;
    // Warm up so the effect looks "already running" like Wallpaper Engine.
    const warm = Math.min(num(def.starttime, 0), 30);
    for (let t = 0; t < warm; t += 0.1) this.update(0.1);
  }

  spawn(em) {
    if (this.p.length >= this.max) return;
    const d = { pos: [0, 0, 0], vel: [0, 0, 0], size: 20, rot: 0, angVel: 0, color: [1, 1, 1], alpha: 1, life: 1, age: 0, frame: 0, baseSize: 20, baseAlpha: 1, baseColor: [1, 1, 1], seed: Math.random() * 1000 };
    // Emitter position
    if (em.name === 'sphererandom') {
      const dmin = em.dmin[0], dmax = em.dmax[0];
      let v = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)];
      const l = Math.hypot(...v) || 1;
      const r = rnd(dmin, dmax);
      v = v.map((x, i) => x / l * r * em.dirs[i]);
      for (let i = 0; i < 3; i++) if (em.sign[i]) v[i] = Math.abs(v[i]) * Math.sign(em.sign[i]);
      d.pos = v.map((x, i) => x + em.origin[i]);
    } else { // boxrandom (default)
      const v = [0, 1, 2].map((i) => {
        const a = em.dmin[i], b = em.dmax[i];
        const m = rnd(a, b) * (Math.random() < 0.5 ? -1 : 1);
        return em.sign[i] ? Math.abs(m) * Math.sign(em.sign[i]) : m;
      });
      d.pos = v.map((x, i) => x + em.origin[i]);
    }
    for (const it of this.inits) {
      switch (it.name) {
        case 'lifetimerandom': d.life = rnd(num(it.min, 1), num(it.max, 1)) * this.ov.lifetime; break;
        case 'sizerandom': d.baseSize = rnd(num(it.min, 20), num(it.max, 20)) * this.ov.size; break;
        case 'velocityrandom': { const a = vec(it.min, [-32, -32, 0]), b = vec(it.max, [32, 32, 0]); d.vel = [0, 1, 2].map((i) => rnd(a[i], b[i]) * this.ov.speed); break; }
        case 'colorrandom': { const a = vec(it.min, [255, 255, 255]), b = vec(it.max, [255, 255, 255]); d.baseColor = [0, 1, 2].map((i) => rnd(a[i], b[i]) / 255); break; }
        case 'alpharandom': d.baseAlpha = rnd(num(it.min, 1), num(it.max, 1)); break;
        case 'rotationrandom': { const a = vec(it.min, [0, 0, 0]), b = vec(it.max, [0, 0, 6.28]); d.rot = rnd(a[2], b[2]); break; }
        case 'angularvelocityrandom': { const a = vec(it.min, [0, 0, -5]), b = vec(it.max, [0, 0, 5]); d.angVel = rnd(a[2], b[2]); break; }
        case 'turbulentvelocityrandom': {
          const sp = rnd(num(it.speedmin, 100), num(it.speedmax, 250)) * this.ov.speed;
          const sc = num(it.scale, 1), off = num(it.offset, 0);
          const ang = noise3(d.pos[0] * 0.01 * sc + off, d.pos[1] * 0.01 * sc, this.time * 0.1) * Math.PI;
          d.vel[0] += Math.cos(ang) * sp; d.vel[1] += Math.sin(ang) * sp;
          break;
        }
        default: break;
      }
    }
    d.size = d.baseSize; d.alpha = d.baseAlpha; d.color = d.baseColor.slice();
    if (this.frames > 1) d.frame = this.animationmode === 'randomframe' ? Math.floor(Math.random() * this.frames) : 0;
    this.p.push(d);
  }

  update(dt) {
    this.time += dt;
    for (const em of this.emitters) {
      if (em.instantaneous > 0) {
        if (!em.done) { for (let i = 0; i < em.instantaneous * this.ov.count; i++) this.spawn(em); em.done = true; }
        continue;
      }
      em.acc += em.rate * dt;
      let n = Math.floor(em.acc);
      em.acc -= n;
      n = Math.min(n, 500);
      while (n-- > 0) this.spawn(em);
    }
    const alive = [];
    for (const d of this.p) {
      d.age += dt;
      if (d.age >= d.life) continue;
      const t = d.age / d.life;
      let alphaMul = 1, sizeMul = 1;
      let color = d.baseColor;
      for (const op of this.ops) {
        switch (op.name) {
          case 'movement': {
            const g = vec(op.gravity, [0, 0, 0]);
            const drag = num(op.drag, 0);
            for (let i = 0; i < 3; i++) { d.vel[i] += g[i] * dt; d.vel[i] *= Math.max(0, 1 - drag * dt); }
            break;
          }
          case 'angularmovement': { const f = vec(op.force, [0, 0, 0]); const drag = num(op.drag, 0); d.angVel += f[2] * dt; d.angVel *= Math.max(0, 1 - drag * dt); break; }
          case 'alphafade': {
            const fi = num(op.fadeintime, 0.5), fo = num(op.fadeouttime, 0.5);
            if (t < fi) alphaMul *= t / fi;
            if (t > fo) alphaMul *= Math.max(0, 1 - (t - fo) / Math.max(0.0001, 1 - fo));
            break;
          }
          case 'sizechange': {
            const st = num(op.starttime, 0), et = num(op.endtime, 1), sv = num(op.startvalue, 1), ev = num(op.endvalue, 0);
            const k = Math.max(0, Math.min(1, (t - st) / Math.max(0.0001, et - st)));
            sizeMul *= sv + (ev - sv) * k;
            break;
          }
          case 'alphachange': {
            const st = num(op.starttime, 0), et = num(op.endtime, 1), sv = num(op.startvalue, 1), ev = num(op.endvalue, 0);
            const k = Math.max(0, Math.min(1, (t - st) / Math.max(0.0001, et - st)));
            alphaMul *= sv + (ev - sv) * k;
            break;
          }
          case 'colorchange': {
            const st = num(op.starttime, 0), et = num(op.endtime, 1), sv = vec(op.startvalue, [1, 1, 1]), ev = vec(op.endvalue, [1, 1, 1]);
            const k = Math.max(0, Math.min(1, (t - st) / Math.max(0.0001, et - st)));
            color = color.map((c, i) => c * (sv[i] + (ev[i] - sv[i]) * k));
            break;
          }
          case 'oscillatealpha': { const f = rnd(num(op.frequencymin, 1), num(op.frequencymax, 1)); const sc = num(op.scalemin, 0) + (num(op.scalemax, 1) - num(op.scalemin, 0)) * (0.5 + 0.5 * Math.sin(d.seed + d.age * f * 6.28)); alphaMul *= sc; break; }
          case 'oscillatesize': { const f = num(op.frequencymax, 1); const sc = num(op.scalemin, 0.8) + (num(op.scalemax, 1.2) - num(op.scalemin, 0.8)) * (0.5 + 0.5 * Math.sin(d.seed + d.age * f * 6.28)); sizeMul *= sc; break; }
          case 'oscillateposition': {
            const f = num(op.frequencymax, 1) * 6.28, sc = num(op.scalemax, 10);
            const m = vec(op.mask, [1, 1, 0]);
            for (let i = 0; i < 3; i++) d.pos[i] += Math.cos(d.seed * (i + 1) + d.age * f) * sc * f * dt * m[i];
            break;
          }
          case 'turbulence': {
            const sc = num(op.scale, 0.005), sp = rnd(num(op.speedmin, 100), num(op.speedmax, 200)) * this.ov.speed, ts = num(op.timescale, 1);
            const m = vec(op.mask, [1, 1, 0]);
            const nx = noise3(d.pos[0] * sc, d.pos[1] * sc, this.time * ts * 0.2 + d.seed);
            const ny = noise3(d.pos[0] * sc + 31.7, d.pos[1] * sc + 11.3, this.time * ts * 0.2 + d.seed);
            d.vel[0] += nx * sp * dt * m[0]; d.vel[1] += ny * sp * dt * m[1];
            break;
          }
          case 'vortex': {
            const c = vec(op.offset, [0, 0, 0]); const s = num(op.speedinner, 100);
            const dx = d.pos[0] - c[0], dy = d.pos[1] - c[1];
            const l = Math.hypot(dx, dy) || 1;
            d.vel[0] += (-dy / l) * s * dt; d.vel[1] += (dx / l) * s * dt;
            break;
          }
          default: break;
        }
      }
      for (let i = 0; i < 3; i++) d.pos[i] += d.vel[i] * dt;
      d.rot += d.angVel * dt;
      d.size = d.baseSize * sizeMul;
      d.alpha = d.baseAlpha * alphaMul * this.ov.alpha;
      d.color = [color[0] * this.ov.color[0], color[1] * this.ov.color[1], color[2] * this.ov.color[2]];
      if (this.frames > 1 && this.animationmode !== 'randomframe') d.frame = Math.floor(t * this.frames * this.seqMul) % this.frames;
      alive.push(d);
    }
    this.p = alive;
  }

  /** Fills the instance buffer; returns the number of live particles. */
  fill() {
    const s = this.stride, a = this.data;
    let n = 0;
    for (const d of this.p) {
      const o = n * s;
      a[o] = d.pos[0]; a[o + 1] = d.pos[1]; a[o + 2] = d.pos[2]; a[o + 3] = d.size;
      a[o + 4] = d.rot; a[o + 5] = d.color[0]; a[o + 6] = d.color[1]; a[o + 7] = d.color[2];
      a[o + 8] = Math.max(0, Math.min(1, d.alpha)); a[o + 9] = d.frame; a[o + 10] = 0; a[o + 11] = 0;
      n++;
    }
    return n;
  }
}
