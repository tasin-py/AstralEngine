// WebGL2 renderer for Wallpaper Engine "scene" wallpapers.
// Reads scene.pkg (read-only), image layers, effect shader chains, particles, text layers,
// sounds, camera parallax, user properties and SceneScript.

import { parsePkg } from './pkg.js';
import { parseTex, toRGBA, TexFormat, TexFlags } from './tex.js';
import { buildProgram, compileProgram, findIncludes, parseCombos, parseUniforms, parseValue, setUniform } from './shader.js';
import { ParticleSystem } from './particles.js';
import { SceneScriptRuntime } from './scenescript.js';

const fileUrl = (p) => 'astral://f/' + encodeURIComponent(p);
const joinPath = (a, b) => (a.replace(/[\\/]+$/, '') + '\\' + b.replace(/\//g, '\\'));
const QUALITY = { low: 0.5, medium: 0.75, high: 1, ultra: 1 };
const MAX_TEX = 4096;

function vec(v, d) {
  const p = parseValue(v);
  if (p == null || typeof p === 'string') return d.slice();
  if (typeof p === 'number') return d.map(() => p);
  return d.map((x, i) => (p[i] ?? x));
}

const BASIC_VS = `#version 300 es
in vec2 a_Position; in vec2 a_TexCoord; uniform vec4 u_UVRect; out vec2 v_uv;
void main(){ v_uv = u_UVRect.xy + a_TexCoord * u_UVRect.zw; gl_Position = vec4(a_Position, 0.0, 1.0); }`;
const BASIC_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_Tex; uniform vec4 u_Color; uniform float u_Solid; out vec4 o;
void main(){ vec4 c = u_Solid > 0.5 ? vec4(1.0) : texture(u_Tex, v_uv); o = vec4(c.rgb * u_Color.rgb, c.a * u_Color.a); }`;
const PARTICLE_VS = `#version 300 es
layout(location=0) in vec2 a_Corner;
layout(location=2) in vec4 i_PosSize; layout(location=3) in vec4 i_RotColor; layout(location=4) in vec4 i_AlphaFrame;
uniform mat3 u_World; uniform vec2 u_Scene; uniform vec4 u_Frames[64]; uniform float u_FrameCount; uniform vec2 u_UVMax;
out vec2 v_uv; out vec4 v_col;
void main(){
  float r = i_RotColor.x; vec2 c = a_Corner * i_PosSize.w;
  vec2 rc = vec2(c.x*cos(r) - c.y*sin(r), c.x*sin(r) + c.y*cos(r));
  vec3 w = u_World * vec3(i_PosSize.xy + rc, 1.0);
  gl_Position = vec4(w.xy / u_Scene * 2.0 - 1.0, 0.0, 1.0);
  vec2 uv = a_Corner * vec2(1.0, -1.0) + 0.5;
  if (u_FrameCount > 0.5) { vec4 f = u_Frames[int(mod(i_AlphaFrame.y, u_FrameCount))]; uv = f.xy + uv * f.zw; } else uv *= u_UVMax;
  v_uv = uv; v_col = vec4(i_RotColor.yzw, i_AlphaFrame.x);
}`;
const PARTICLE_FS = `#version 300 es
precision highp float; in vec2 v_uv; in vec4 v_col; uniform sampler2D u_Tex; uniform float u_Gray; out vec4 o;
void main(){ vec4 c = texture(u_Tex, v_uv); if (u_Gray > 0.5) c = vec4(1.0, 1.0, 1.0, c.r * c.a); o = vec4(c.rgb * v_col.rgb, c.a * v_col.a); }`;

export class SceneWallpaper {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.dir = cfg.item.dir;
    this.assets = cfg.assetsDir;
    this.state = cfg.state || 'run';
    this.fps = (cfg.playback && cfg.playback.fps) || 30;
    this.quality = QUALITY[(cfg.playback && cfg.playback.quality) || 'medium'] || 0.75;
    this.audioCfg = cfg.audio || { volume: 50, muted: false };
    this.volumeMul = 1;   // built-in "Volume" property (0..1)
    this.rate = 1;        // built-in "Playback rate" property
    this.cursor = { x: 0.5, y: 0.5 };
    this.smoothCursor = { x: 0.5, y: 0.5 };
    this.audio = new Float32Array(128);
    this.cache = new Map();
    this.textures = new Map();
    this.programs = new Map();
    this.objects = [];
    this.sounds = [];
    this.videos = [];
    this.userProps = {};
    this.applyPropsObject(cfg.props || {});
    this.raf = 0;
    this.last = 0;
    this.time = 0;
    this.destroyed = false;
  }

  // ---------------- asset access (read-only) ----------------
  async fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('missing');
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Looks a file up in scene.pkg, then the wallpaper folder, then Wallpaper Engine's assets. */
  file(p, root) {
    p = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
    const key = (root || '') + '|' + p.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    const pr = (async () => {
      const k = p.toLowerCase();
      if (this.pkg && this.pkg.files.has(k)) return this.pkg.files.get(k);
      const tries = [joinPath(this.dir, p)];
      if (this.assets) {
        if (root) tries.push(joinPath(this.assets, root + '/' + p));
        tries.push(joinPath(this.assets, p));
        if (p.startsWith('shaders/')) tries.push(joinPath(this.assets, 'zcompat/scene/' + p));
      }
      for (const t of tries) { try { return await this.fetchBytes(fileUrl(t)); } catch { /* next */ } }
      return null;
    })();
    this.cache.set(key, pr);
    return pr;
  }

  async text(p, root) { const b = await this.file(p, root); return b ? new TextDecoder().decode(b) : null; }
  async json(p, root) {
    const t = await this.text(p, root);
    if (t == null) return null;
    try { return JSON.parse(t.replace(/^﻿/, '')); } catch { return null; }
  }

  // ---------------- user properties / value binding ----------------
  applyPropsObject(props) {
    for (const [k, p] of Object.entries(props || {})) {
      const v = p && typeof p === 'object' && 'value' in p ? p.value : p;
      this.userProps[k] = v;
    }
  }

  /** Resolve a scene value: plain, {user, value}, {script, value}. */
  resolve(v, slot) {
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return v;
    let base = 'value' in v ? this.resolve(v.value) : undefined;
    if ('user' in v && v.user != null) {
      const u = v.user;
      if (typeof u === 'string') {
        if (u in this.userProps) base = this.userProps[u];
      } else if (typeof u === 'object' && u.name) {
        if (u.name in this.userProps) {
          const pv = this.userProps[u.name];
          base = String(pv) === String(u.condition) || (u.condition === undefined && !!pv);
        }
      }
    }
    if (v.script && slot) {
      if (!slot.script && slot.script !== false && this.scripts) {
        slot.script = this.scripts.compile(v.script, { thisLayer: slot.layer, thisScene: this.sceneApi, scriptProps: v.scriptproperties, resolve: (x) => this.resolve(x) }) || false;
      }
      if (slot.script) {
        let cur = slot.cur !== undefined ? slot.cur : toScriptValue(base, this.scripts);
        cur = slot.script.update(cur);
        slot.cur = cur;
        return fromScriptValue(cur);
      }
    }
    return base;
  }

  // ---------------- GL helpers ----------------
  initGL() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    gl.getExtension('EXT_color_buffer_float');
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(this.raf); });
    this.canvas.addEventListener('webglcontextrestored', () => location.reload());
    this.basic = compileProgram(gl, BASIC_VS, BASIC_FS);
    this.particleProg = compileProgram(gl, PARTICLE_VS, PARTICLE_FS);
    // Dynamic quad buffer (positions + texcoords interleaved)
    this.quadVAO = gl.createVertexArray();
    this.quadBuf = gl.createBuffer();
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    // Static fullscreen quad for effect passes: v=0 at clip y=-1 (row 0 = top of image)
    this.fsVAO = gl.createVertexArray();
    const fsb = gl.createBuffer();
    gl.bindVertexArray(this.fsVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, fsb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    // Particle VAO: corner quad + instance buffer
    this.pVAO = gl.createVertexArray();
    gl.bindVertexArray(this.pVAO);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    this.pInst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pInst);
    for (const [loc, off] of [[2, 0], [3, 16], [4, 32]]) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 48, off); gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    this.white = this.makeTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.black = this.makeTexture(1, 1, new Uint8Array([0, 0, 0, 255]));
  }

  makeTexture(w, h, rgba, { clamp = true, mips = false, nearest = false } = {}) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.texParams(clamp, mips, nearest);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  texParams(clamp, mips, nearest) {
    const gl = this.gl;
    const wrap = clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
  }

  makeFBO(w, h) {
    const gl = this.gl;
    w = Math.max(1, Math.min(MAX_TEX, Math.round(w))); h = Math.max(1, Math.min(MAX_TEX, Math.round(h)));
    const tex = this.makeTexture(w, h, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  /** Loads a WE texture by material name ("bg_day", "effects/waterripplenormal", "util/noise"). */
  texture(name, root) {
    const key = (root || '') + '|' + String(name).toLowerCase();
    if (this.textures.has(key)) return this.textures.get(key);
    const pr = this.loadTexture(name, root).catch((e) => { console.warn('texture failed', name, e); return null; });
    this.textures.set(key, pr);
    return pr;
  }

  async loadTexture(name, root) {
    const gl = this.gl;
    let bytes = await this.file(`materials/${name}.tex`, root);
    if (!bytes) {
      for (const ext of ['.png', '.jpg', '.jpeg', '.gif']) {
        const b = await this.file(`materials/${name}${ext}`, root);
        if (b) return this.textureFromImageBytes(b, name.endsWith('noise'));
      }
      return null;
    }
    const tex = parseTex(bytes);
    const clamp = !!(tex.flags & TexFlags.ClampUVs);
    const nearest = !!(tex.flags & TexFlags.NoInterpolation);
    const mips = tex.images[0];
    const m0 = mips[0];
    const info = { width: tex.width, height: tex.height, texWidth: tex.texWidth, texHeight: tex.texHeight, frames: null, flags: tex.flags, gray: tex.format === TexFormat.R8 };
    if (tex.isVideo) {
      const blob = new Blob([m0.data], { type: 'video/mp4' });
      const v = document.createElement('video');
      v.src = URL.createObjectURL(blob); v.loop = true; v.muted = true; v.playsInline = true;
      await v.play().catch(() => {});
      const t = this.makeTexture(1, 1, new Uint8Array(4), { clamp });
      this.videos.push({ video: v, tex: t });
      return { ...info, tex: t, video: v, texWidth: tex.width, texHeight: tex.height };
    }
    let glTex;
    if (tex.freeImageFormat !== -1) {
      const bmp = await createImageBitmap(new Blob([m0.data]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      glTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      this.texParams(clamp, !nearest, nearest);
      if (!nearest) gl.generateMipmap(gl.TEXTURE_2D);
      info.texWidth = bmp.width; info.texHeight = bmp.height;
      if (!info.width) { info.width = bmp.width; info.height = bmp.height; }
      bmp.close();
    } else {
      const compressed = { [TexFormat.DXT1]: this.s3tc && this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT, [TexFormat.DXT3]: this.s3tc && this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, [TexFormat.DXT5]: this.s3tc && this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT }[tex.format];
      glTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (compressed && m0.width % 4 === 0 && m0.height % 4 === 0) {
        // Upload the full mip chain only if it is complete and valid, otherwise level 0 only.
        let levels = 0;
        for (const m of mips) {
          if (levels > 0 && (m.width % 4 || m.height % 4) && (m.width > 4 || m.height > 4)) break;
          gl.compressedTexImage2D(gl.TEXTURE_2D, levels, compressed, m.width, m.height, 0, m.data);
          levels++;
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
        this.texParams(clamp, levels > 1 && !nearest, nearest);
        if (gl.getError() !== gl.NO_ERROR) {
          gl.deleteTexture(glTex);
          glTex = this.makeTexture(m0.width, m0.height, toRGBA(m0.data, m0.width, m0.height, tex.format), { clamp, mips: !nearest, nearest });
        }
      } else {
        const rgba = toRGBA(m0.data, m0.width, m0.height, tex.format);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, m0.width, m0.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        this.texParams(clamp, !nearest, nearest);
        if (!nearest) gl.generateMipmap(gl.TEXTURE_2D);
      }
      info.texWidth = m0.width; info.texHeight = m0.height;
    }
    if (!info.width) { info.width = info.texWidth; info.height = info.texHeight; }
    if (tex.frames && tex.frames.length) {
      const W = info.texWidth, H = info.texHeight;
      const uvUnits = tex.frames.every((f) => f.w1 <= 1.0001 && f.h1 <= 1.0001 && f.x <= 1.0001 && f.y <= 1.0001);
      info.frames = tex.frames.map((f) => {
        const w = f.w1 || f.w2, h = f.h1 || f.h2;
        return uvUnits ? { x: f.x, y: f.y, w, h, t: f.frametime } : { x: f.x / W, y: f.y / H, w: w / W, h: h / H, t: f.frametime };
      });
      info.frameDuration = info.frames.reduce((a, f) => a + (f.t || 0.05), 0);
      info.frameW = tex.gifWidth || Math.round(info.frames[0].w * W);
      info.frameH = tex.gifHeight || Math.round(info.frames[0].h * H);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { ...info, tex: glTex };
  }

  async textureFromImageBytes(b, repeat) {
    const gl = this.gl;
    const bmp = await createImageBitmap(new Blob([b]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    this.texParams(!repeat, true, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    const r = { tex: t, width: bmp.width, height: bmp.height, texWidth: bmp.width, texHeight: bmp.height, frames: null };
    bmp.close();
    return r;
  }

  // ---------------- shaders / effects ----------------
  async loadShaderSources(name, root) {
    const vs = await this.text(`shaders/${name}.vert`, root);
    const fs = await this.text(`shaders/${name}.frag`, root);
    if (!vs || !fs) return null;
    const includes = {};
    const queue = [...findIncludes(vs), ...findIncludes(fs)];
    while (queue.length) {
      const inc = queue.shift();
      if (inc in includes) continue;
      const t = await this.text(`shaders/${inc}`, root);
      includes[inc] = t;
      if (t) queue.push(...findIncludes(t));
    }
    const uniforms = [...parseUniforms(vs), ...parseUniforms(fs)];
    for (const t of Object.values(includes)) if (t) uniforms.push(...parseUniforms(t));
    return { vs, fs, includes, uniforms, combos: { ...parseCombos(vs), ...parseCombos(fs) } };
  }

  program(name, src, defines) {
    const key = name + JSON.stringify(Object.entries(defines).sort());
    if (this.programs.has(key)) return this.programs.get(key);
    let p = null;
    try { p = buildProgram(this.gl, src.vs, src.fs, defines, (n) => src.includes[n]); } catch (e) { console.warn('shader', name, String(e.message || e).slice(0, 400)); }
    this.programs.set(key, p);
    return p;
  }

  /** Prepare one effect instance (from scene.json) into executable passes. */
  async loadEffect(eff, obj) {
    const effPath = eff.file;
    const root = effPath.replace(/\/effect\.json$/i, '');
    const def = await this.json(effPath);
    if (!def) return null;
    const fbos = {};
    for (const f of def.fbos || []) fbos[f.name] = { scale: Number(f.scale) || 1 };
    const passes = [];
    const instPasses = eff.passes || [];
    let matIndex = 0;
    for (let i = 0; i < (def.passes || []).length; i++) {
      const dp = def.passes[i];
      if (dp.command) { passes.push({ command: dp.command, source: dp.source, target: dp.target }); continue; }
      const mat = await this.json(dp.material, root);
      if (!mat || !mat.passes || !mat.passes[0]) continue;
      const mp = mat.passes[0];
      const ip = instPasses[matIndex] || {};
      matIndex++;
      const src = await this.loadShaderSources(mp.shader, root);
      if (!src) { console.warn('missing shader', mp.shader); continue; }
      const textures = [];
      const texNames = [];
      const maxSlots = 8;
      for (let s = 0; s < maxSlots; s++) {
        const n = (ip.textures && ip.textures[s] !== undefined) ? ip.textures[s] : (mp.textures ? mp.textures[s] : undefined);
        texNames[s] = n || null;
      }
      // Sampler defaults from annotations
      const combos = { ...src.combos, ...(mp.combos || {}) };
      for (const [k, v] of Object.entries(ip.combos || {})) combos[k] = Number(this.resolve(v)) || 0;
      for (const u of src.uniforms) {
        const m = u.name.match(/^g_Texture(\d+)$/);
        if (!m || !u.ann) continue;
        const slot = Number(m[1]);
        if (!texNames[slot] && u.ann.default && slot > 0) texNames[slot] = u.ann.default;
        if (u.ann.combo && texNames[slot] && slot > 0) combos[u.ann.combo] = 1;
      }
      for (let s = 0; s < maxSlots; s++) {
        const n = texNames[s];
        if (n && !String(n).startsWith('_rt_')) textures[s] = await this.texture(n, root);
        else textures[s] = n ? { rt: n } : null;
      }
      const defines = {};
      for (const [k, v] of Object.entries(combos)) defines[k] = Number(v) || 0;
      const prog = this.program(mp.shader, src, defines);
      if (!prog) continue;
      // Uniform values: annotation defaults < material constants < scene constants
      const values = {};
      const consts = { ...(mp.constantshadervalues || {}) };
      const instConsts = ip.constantshadervalues || {};
      for (const u of src.uniforms) {
        if (!u.ann) continue;
        const keyName = u.ann.material;
        let val = u.ann.default;
        if (keyName && keyName in consts) val = consts[keyName];
        let dyn = null;
        const cand = [keyName, u.ann.label].filter(Boolean);
        for (const c of cand) if (c in instConsts) { dyn = instConsts[c]; break; }
        if (dyn !== null) val = dyn;
        if (val !== undefined) values[u.name] = { raw: val, slot: { layer: obj && obj.api } };
      }
      passes.push({ prog, textures, values, target: dp.target, bind: dp.bind, blending: mp.blending || 'normal' });
    }
    return { passes, fbos, visible: eff.visible, name: eff.name };
  }

  // ---------------- scene loading ----------------
  async load() {
    this.initGL();
    const pkgBytes = await this.fetchBytes(fileUrl(joinPath(this.dir, 'scene.pkg'))).catch(() => null);
    if (pkgBytes) this.pkg = parsePkg(pkgBytes);
    const entry = this.cfg.item.file || 'scene.json';
    const scene = await this.json(entry);
    if (!scene) throw new Error('scene.json not found');
    this.scene = scene;
    const g = scene.general || {};
    const ortho = g.orthogonalprojection || {};
    this.W = Number(ortho.width) || 1920;
    this.H = Number(ortho.height) || 1080;
    if (ortho.auto) { this.W = this.cfg.physSize.width; this.H = this.cfg.physSize.height; }
    this.clear = g.clearenabled === false ? null : vec(g.clearcolor, [0, 0, 0]);
    this.parallax = { enabled: !!this.resolve(g.cameraparallax), amount: Number(this.resolve(g.cameraparallaxamount) ?? 0.5), delay: Number(this.resolve(g.cameraparallaxdelay) ?? 0.1), mouse: Number(this.resolve(g.cameraparallaxmouseinfluence) ?? 0.5) };
    this.shake = { enabled: !!this.resolve(g.camerashake), amp: Number(g.camerashakeamplitude || 0.5), speed: Number(g.camerashakespeed || 3), rough: Number(g.camerashakeroughness || 1) };

    // SceneScript runtime
    this.scripts = new SceneScriptRuntime({
      fetchText: async (p) => { if (!this.assets) throw new Error('no assets'); const b = await this.fetchBytes(fileUrl(joinPath(this.assets, p))); return new TextDecoder().decode(b); },
      userProps: this.userProps,
      screen: { width: this.cfg.physSize.width, height: this.cfg.physSize.height, sceneWidth: this.W, sceneHeight: this.H }
    });
    await this.scripts.init();
    this.sceneApi = this.makeSceneApi();

    this.resize();
    const objs = scene.objects || [];
    const byId = new Map();
    for (const o of objs) byId.set(o.id, o);
    for (const o of objs) {
      try {
        const ob = await this.loadObject(o);
        if (ob) { ob.parentId = o.parent; this.objects.push(ob); }
      } catch (e) { console.warn('object failed', o.name, e); }
    }
    const map = new Map(this.objects.map((o) => [o.src.id, o]));
    for (const o of this.objects) o.parent = o.parentId != null ? map.get(o.parentId) || null : null;
    this.started = performance.now();
    window.addEventListener('resize', () => this.resize());
    this.setState(this.state);
  }

  makeSceneApi() {
    const self = this;
    return {
      getLayer: (name) => { const o = self.objects.find((x) => x.src.name === name || x.src.id === name); return o ? o.api : null; },
      enumerateLayers: () => self.objects.map((o) => o.api),
      getLayerCount: () => self.objects.length,
      getLayerIndex: (l) => self.objects.findIndex((o) => o.api === l),
      get clearColor() { return self.clear; }
    };
  }

  makeLayerApi(ob) {
    const self = this;
    const V3 = this.scripts.globals.Vec3;
    return {
      get name() { return ob.src.name; },
      get origin() { return new V3(...ob.origin); }, set origin(v) { ob.origin = [v.x, v.y, v.z || 0]; ob.scriptPos = true; },
      get scale() { return new V3(...ob.scale); }, set scale(v) { ob.scale = [v.x, v.y, v.z ?? 1]; ob.scriptScale = true; },
      get angles() { return new V3(...ob.angles.map((a) => a * 180 / Math.PI)); }, set angles(v) { ob.angles = [v.x * Math.PI / 180, v.y * Math.PI / 180, v.z * Math.PI / 180]; ob.scriptAngles = true; },
      get alpha() { return ob.alpha; }, set alpha(v) { ob.alpha = Number(v); ob.scriptAlpha = true; },
      get visible() { return ob.visible; }, set visible(v) { ob.visible = !!v; ob.scriptVisible = true; },
      get text() { return ob.text; }, set text(v) { ob.text = String(v); },
      get color() { return new V3(...ob.color); }, set color(v) { ob.color = [v.x, v.y, v.z]; },
      get size() { return new self.scripts.globals.Vec2(ob.size[0], ob.size[1]); },
      getEffect: () => null, getAnimation: () => null, play() {}, pause() {}, stop() {}, isPlaying: () => true
    };
  }

  async loadObject(o) {
    const ob = {
      src: o, type: null, slots: {},
      origin: vec(this.resolve(o.origin), [this.W / 2, this.H / 2, 0]),
      scale: vec(this.resolve(o.scale), [1, 1, 1]),
      angles: vec(this.resolve(o.angles), [0, 0, 0]),
      alpha: 1, visible: true, color: vec(this.resolve(o.color), [1, 1, 1]),
      parallax: vec(o.parallaxDepth, [0, 0]),
      effects: []
    };
    ob.api = this.makeLayerApi(ob);
    if (o.sound) return this.loadSound(o, ob);
    if (o.particle) {
      const def = await this.json(o.particle);
      if (!def) return null;
      ob.type = 'particle';
      const mat = def.material ? await this.json(def.material) : null;
      const mp = mat && mat.passes && mat.passes[0];
      ob.blending = (mp && mp.blending) || 'translucent';
      ob.tex = mp && mp.textures && mp.textures[0] ? await this.texture(mp.textures[0]) : null;
      ob.system = new ParticleSystem(def, o.instanceoverride, ob.tex && ob.tex.frames ? Math.min(64, ob.tex.frames.length) : 1);
      return ob;
    }
    if (o.text) {
      ob.type = 'text';
      ob.size = vec(this.resolve(o.size), [400, 100]);
      ob.text = String(this.resolve(o.text.value ?? o.text) ?? '');
      ob.font = o.font ? await this.loadFont(o.font) : 'Segoe UI';
      ob.canvas = document.createElement('canvas');
      ob.glTex = null;
      return ob;
    }
    if (!o.image) return null;
    const model = await this.json(o.image);
    if (!model) return null;
    const mat = model.material ? await this.json(model.material) : null;
    const mp = mat && mat.passes && mat.passes[0];
    const texName = mp && mp.textures && mp.textures[0];
    ob.blending = (mp && mp.blending) || 'translucent';
    ob.type = 'image';
    if (model.fullscreen) ob.capture = 'full';
    else if (texName === '_rt_FullFrameBuffer' || model.passthrough) ob.capture = 'region';
    else if (texName) ob.tex = await this.texture(texName);
    else ob.solid = true;
    const autoSize = ob.tex ? [ob.tex.frameW || ob.tex.width, ob.tex.frameH || ob.tex.height] : [model.width || this.W, model.height || this.H];
    ob.size = model.fullscreen ? [this.W, this.H] : vec(this.resolve(o.size), autoSize);
    if (model.fullscreen) ob.origin = [this.W / 2, this.H / 2, 0];
    for (const e of o.effects || []) {
      try {
        const fx = await this.loadEffect(e, ob);
        if (fx && fx.passes.length) ob.effects.push(fx);
      } catch (err) { console.warn('effect failed', e.file, err); }
    }
    return ob;
  }

  async loadFont(p) {
    try {
      const b = await this.file(p);
      if (!b) return 'Segoe UI';
      const fam = 'f' + Math.random().toString(36).slice(2);
      const ff = new FontFace(fam, b);
      await ff.load();
      document.fonts.add(ff);
      return fam;
    } catch { return 'Segoe UI'; }
  }

  async loadSound(o, ob) {
    ob.type = 'sound';
    const files = Array.isArray(o.sound) ? o.sound : [o.sound];
    ob.tracks = [];
    for (const f of files) {
      const b = await this.file(f);
      if (!b) continue;
      ob.tracks.push(URL.createObjectURL(new Blob([b], { type: 'audio/mpeg' })));
    }
    if (!ob.tracks.length) return null;
    const a = new Audio();
    a.loop = (o.playbackmode || 'loop') === 'loop' && ob.tracks.length === 1;
    a.src = ob.tracks[0];
    let idx = 0;
    a.addEventListener('ended', () => { idx = o.playbackmode === 'random' ? Math.floor(Math.random() * ob.tracks.length) : (idx + 1) % ob.tracks.length; a.src = ob.tracks[idx]; a.play().catch(() => {}); });
    ob.audio = a;
    ob.baseVolume = Number(this.resolve(o.volume) ?? 1);
    this.sounds.push(ob);
    this.updateSoundVolumes();
    return ob;
  }

  updateSoundVolumes() {
    const vol = Math.max(0, Math.min(1, (this.audioCfg.volume ?? 50) / 100 * (this.volumeMul ?? 1)));
    const muted = !!this.audioCfg.muted || this.state !== 'run';
    for (const s of this.sounds) {
      const visible = s.src.visible === undefined ? true : !!this.resolve(s.src.visible);
      s.audio.volume = Math.max(0, Math.min(1, vol * s.baseVolume));
      if (muted || !visible) s.audio.pause(); else s.audio.play().catch(() => {});
    }
  }

  // ---------------- runtime ----------------
  resize() {
    const dpr = 1; // the window is already sized in physical pixels by the host
    const w = Math.max(1, Math.round(this.canvas.clientWidth * (window.devicePixelRatio || 1) * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * (window.devicePixelRatio || 1) * dpr));
    this.canvas.width = w; this.canvas.height = h;
    if (!this.gl || !this.W) return;
    const cover = Math.max(w / this.W, h / this.H);
    this.res = Math.min(1, cover) * this.quality;
    if (this.cfg.playback && this.cfg.playback.quality === 'ultra') this.res = Math.min(2, cover);
    const fw = Math.min(MAX_TEX, this.W * this.res), fh = Math.min(MAX_TEX, this.H * this.res);
    if (this.sceneFBO) this.freeFBO(this.sceneFBO);
    this.sceneFBO = this.makeFBO(fw, fh);
    for (const o of this.objects) { if (o.fbos) { for (const f of Object.values(o.fbos)) this.freeFBO(f); o.fbos = null; } }
  }

  freeFBO(f) { const gl = this.gl; gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }

  setState(st) {
    this.state = st;
    cancelAnimationFrame(this.raf);
    this.updateSoundVolumes();
    for (const v of this.videos) { if (st === 'run' || st === 'mute') v.video.play().catch(() => {}); else v.video.pause(); }
    if (st === 'run' || st === 'mute') { this.last = 0; this.raf = requestAnimationFrame((t) => this.loop(t)); }
    else if (!this.framesDrawn && this.sceneFBO) {
      // Paused before anything was drawn: show a still frame instead of black (like WE).
      this.raf = requestAnimationFrame(() => { for (let i = 0; i < 3; i++) this.renderFrame(1 / 30); });
    }
  }

  applySettings(s) {
    if (s.playback) {
      this.fps = s.playback.fps || this.fps;
      const q = QUALITY[s.playback.quality] || this.quality;
      if (q !== this.quality) { this.quality = q; this.cfg.playback.quality = s.playback.quality; this.resize(); }
    }
    if (s.audio) this.applyAudio(s.audio, this.state);
  }

  applyAudio(a) { if (a) this.audioCfg = a; this.updateSoundVolumes(); }

  applyProps(props) {
    this.applyPropsObject(props);
    const changed = {};
    for (const [k, p] of Object.entries(props || {})) changed[k] = p && typeof p === 'object' && 'value' in p ? p.value : p;
    // Static (non-scripted) bindings re-evaluate every frame through resolve(); scripts get notified.
    for (const h of this.scripts ? this.scripts.scripts : []) { try { h.exp.applyUserProperties && h.exp.applyUserProperties(changed); } catch { /* ignore */ } }
    this.updateSoundVolumes();
    // Restart non-running loop to redraw one frame with the new values.
    if (this.state === 'pause') { this.renderFrame(0); }
  }

  setCursor(c) { this.cursor = c; if (this.scripts) { this.scripts.cursor.x = c.x; this.scripts.cursor.y = c.y; } }
  setAudio(a) { this.audio = a; if (this.scripts) this.scripts.setAudio(a); }

  loop(t) {
    if (this.destroyed || !(this.state === 'run' || this.state === 'mute')) return;
    this.raf = requestAnimationFrame((tt) => this.loop(tt));
    const minDt = 1000 / Math.max(5, this.fps);
    if (this.last && t - this.last < minDt - 1.5) return;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / this.fps;
    this.last = t;
    this.renderFrame(dt * (this.rate || 1));
  }

  dynamic(ob, key, val) {
    const slot = ob.slots[key] || (ob.slots[key] = { layer: ob.api });
    return this.resolve(val, slot);
  }

  updateObject(ob) {
    const o = ob.src;
    if (!ob.scriptVisible) ob.visible = o.visible === undefined ? true : !!this.dynamic(ob, 'visible', o.visible);
    if (!ob.scriptAlpha) ob.alpha = o.alpha === undefined ? 1 : Number(this.dynamic(ob, 'alpha', o.alpha));
    if (o.color && typeof o.color === 'object') ob.color = vec(this.dynamic(ob, 'color', o.color), [1, 1, 1]);
    if (o.origin && typeof o.origin === 'object' && !ob.scriptPos) ob.origin = vec(this.dynamic(ob, 'origin', o.origin), ob.origin);
    if (o.scale && typeof o.scale === 'object' && !ob.scriptScale) ob.scale = vec(this.dynamic(ob, 'scale', o.scale), ob.scale);
    if (o.angles && typeof o.angles === 'object' && !ob.scriptAngles) ob.angles = vec(this.dynamic(ob, 'angles', o.angles), ob.angles);
    if (ob.type === 'text') {
      const tv = o.text && typeof o.text === 'object' ? o.text : { value: o.text };
      const v = this.dynamic(ob, 'text', tv);
      if (v != null && String(v) !== ob.lastText) { ob.text = String(v); }
    }
  }

  /** World transform (2D) including parents. Returns {x, y, sx, sy, r}. */
  world(ob) {
    let x = ob.origin[0], y = ob.origin[1], sx = ob.scale[0], sy = ob.scale[1], r = ob.angles[2] || 0;
    let p = ob.parent;
    let guard = 0;
    while (p && guard++ < 16) {
      const pr = p.angles[2] || 0;
      const lx = x * p.scale[0], ly = y * p.scale[1];
      x = p.origin[0] + lx * Math.cos(pr) - ly * Math.sin(pr);
      y = p.origin[1] + lx * Math.sin(pr) + ly * Math.cos(pr);
      sx *= p.scale[0]; sy *= p.scale[1]; r += pr;
      p = p.parent;
    }
    // Camera parallax
    if (this.parallax.enabled && (ob.parallax[0] || ob.parallax[1])) {
      x += (this.smoothCursor.x - 0.5) * this.parallax.amount * ob.parallax[0] * this.W * 0.05 * this.parallax.mouse * 2;
      y -= (this.smoothCursor.y - 0.5) * this.parallax.amount * ob.parallax[1] * this.H * 0.05 * this.parallax.mouse * 2;
    }
    return { x, y, sx, sy, r };
  }

  quadCorners(wt, w, h) {
    // returns clip-space corners TL, TR, BL, BR for the scene FBO
    const hw = w / 2 * wt.sx, hh = h / 2 * wt.sy;
    const c = Math.cos(wt.r), s = Math.sin(wt.r);
    const pt = (dx, dy) => { const x = wt.x + dx * c - dy * s, y = wt.y + dx * s + dy * c; return [x / this.W * 2 - 1, y / this.H * 2 - 1]; };
    return [pt(-hw, hh), pt(hw, hh), pt(-hw, -hh), pt(hw, -hh)];
  }

  drawQuad(corners, tex, uvRect, color, blending, solid) {
    const gl = this.gl;
    const [tl, tr, bl, br] = corners;
    const data = new Float32Array([tl[0], tl[1], 0, 0, tr[0], tr[1], 1, 0, bl[0], bl[1], 0, 1, br[0], br[1], 1, 1]);
    gl.useProgram(this.basic.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.uniform4fv(this.basic.uniforms.u_UVRect.loc, uvRect);
    gl.uniform4fv(this.basic.uniforms.u_Color.loc, color);
    gl.uniform1f(this.basic.uniforms.u_Solid.loc, solid ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex || this.white);
    gl.uniform1i(this.basic.uniforms.u_Tex.loc, 0);
    this.setBlend(blending);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  setBlend(mode) {
    const gl = this.gl;
    if (mode === 'disabled' || mode === 'none') { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    if (mode === 'additive') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  objectFBOs(ob, w, h) {
    const W = Math.max(1, Math.round(Math.abs(w))), H = Math.max(1, Math.round(Math.abs(h)));
    if (ob.fbos && ob.fbos.a.w === Math.min(MAX_TEX, W) && ob.fbos.a.h === Math.min(MAX_TEX, H)) return ob.fbos;
    if (ob.fbos) for (const f of Object.values(ob.fbos)) this.freeFBO(f);
    ob.fbos = { a: this.makeFBO(W, H), b: this.makeFBO(W, H) };
    return ob.fbos;
  }

  frameRect(tex) {
    if (!tex) return [0, 0, 1, 1];
    if (tex.frames && tex.frames.length) {
      const total = tex.frameDuration || 1;
      let t = (this.time % total);
      for (const f of tex.frames) { t -= f.t || 0.05; if (t <= 0) return [f.x, f.y, f.w, f.h]; }
      const f = tex.frames[0];
      return [f.x, f.y, f.w, f.h];
    }
    return [0, 0, tex.width / tex.texWidth, tex.height / tex.texHeight];
  }

  audioUniforms() {
    const a = this.audio;
    const mk = (n, off) => { const out = new Float32Array(n); const step = 64 / n; for (let i = 0; i < n; i++) { let m = 0; for (let k = Math.floor(i * step); k < Math.floor((i + 1) * step); k++) m = Math.max(m, a[off + k] || 0); out[i] = m; } return out; };
    return {
      g_AudioSpectrum16Left: mk(16, 0), g_AudioSpectrum16Right: mk(16, 64),
      g_AudioSpectrum32Left: mk(32, 0), g_AudioSpectrum32Right: mk(32, 64),
      g_AudioSpectrum64Left: mk(64, 0), g_AudioSpectrum64Right: mk(64, 64)
    };
  }

  runEffects(ob, inputTex, w, h, fb) {
    const gl = this.gl;
    let cur = { tex: inputTex, w, h, tw: w, th: h };
    const effectInput = cur;
    let pingIsA = true;
    const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const now = this.time;
    const d = new Date();
    const daytime = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
    const audio = this.frameAudio;
    for (const fx of ob.effects) {
      if (fx.visible !== undefined && !this.resolve(fx.visible, fx.visSlot || (fx.visSlot = { layer: ob.api }))) continue;
      const named = {};
      const getNamed = (name) => {
        if (!named[name]) {
          const sc = (fx.fbos[name] && fx.fbos[name].scale) || 1;
          const key = 'n_' + name + '_' + sc;
          ob.namedFBOs = ob.namedFBOs || {};
          const want = [Math.max(1, Math.round(w / sc)), Math.max(1, Math.round(h / sc))];
          let f = ob.namedFBOs[key];
          if (!f || f.w !== want[0] || f.h !== want[1]) { if (f) this.freeFBO(f); f = ob.namedFBOs[key] = this.makeFBO(want[0], want[1]); }
          named[name] = f;
        }
        return named[name];
      };
      const fxInput = cur;
      for (const pass of fx.passes) {
        if (pass.command) {
          if (pass.command === 'copy' && pass.target) {
            const t = getNamed(pass.target);
            this.blitTex(pass.source === 'previous' || !pass.source ? fxInput.tex : (named[pass.source] || {}).tex, t);
          }
          continue;
        }
        let out;
        if (pass.target) out = getNamed(pass.target);
        else { out = pingIsA ? fb.a : fb.b; pingIsA = !pingIsA; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
        gl.viewport(0, 0, out.w, out.h);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const P = pass.prog;
        gl.useProgram(P.program);
        const slots = pass.textures.slice();
        const texInfo = [];
        for (let s = 0; s < 8; s++) {
          let t = slots[s];
          let info;
          if (s === 0 && !t) info = { tex: cur.tex, w: cur.w, h: cur.h, tw: cur.w, th: cur.h };
          else if (t && t.rt) {
            if (t.rt === '_rt_FullFrameBuffer') info = { tex: this.sceneFBO.tex, w: this.sceneFBO.w, h: this.sceneFBO.h, tw: this.sceneFBO.w, th: this.sceneFBO.h };
            else if (named[t.rt]) info = { tex: named[t.rt].tex, w: named[t.rt].w, h: named[t.rt].h, tw: named[t.rt].w, th: named[t.rt].h };
            else info = { tex: fxInput.tex, w: fxInput.w, h: fxInput.h, tw: fxInput.w, th: fxInput.h };
          } else if (t && t.tex) info = { tex: t.tex, w: t.width, h: t.height, tw: t.texWidth, th: t.texHeight };
          else info = null;
          texInfo[s] = info;
        }
        for (const b of pass.bind || []) {
          const src = b.name === 'previous' ? fxInput : named[b.name] ? { tex: named[b.name].tex, w: named[b.name].w, h: named[b.name].h, tw: named[b.name].w, th: named[b.name].h } : null;
          if (src) texInfo[b.index] = { tex: src.tex, w: src.w, h: src.h, tw: src.tw || src.w, th: src.th || src.h };
        }
        for (let s = 0; s < 8; s++) {
          const u = P.uniforms['g_Texture' + s];
          const info = texInfo[s];
          if (u) {
            gl.activeTexture(gl.TEXTURE0 + s);
            if (info && info.video) { /* updated per frame */ }
            gl.bindTexture(gl.TEXTURE_2D, info ? info.tex : (s === 0 ? cur.tex : this.black));
            gl.uniform1i(u.loc, s);
          }
          const r = P.uniforms['g_Texture' + s + 'Resolution'];
          if (r && info) gl.uniform4f(r.loc, info.tw, info.th, info.w, info.h);
          else if (r) gl.uniform4f(r.loc, 1, 1, 1, 1);
          const tx = P.uniforms['g_Texture' + s + 'Texel'];
          if (tx && info) gl.uniform4f(tx.loc, 1 / info.tw, 1 / info.th, info.tw, info.th);
        }
        const U = P.uniforms;
        if (U.g_Time) gl.uniform1f(U.g_Time.loc, now);
        if (U.g_Frametime) gl.uniform1f(U.g_Frametime.loc, this.dt || 0.016);
        if (U.g_Daytime) gl.uniform1f(U.g_Daytime.loc, daytime);
        for (const m of ['g_ModelViewProjectionMatrix', 'g_EffectModelViewProjectionMatrix', 'g_EffectTextureProjectionMatrix', 'g_EffectTextureProjectionMatrixInverse', 'g_EffectModelViewProjectionMatrixInverse', 'g_EffectModelMatrix', 'g_ModelMatrix', 'g_ViewProjectionMatrix', 'g_ModelViewProjectionMatrixInverse']) {
          if (U[m]) gl.uniformMatrix4fv(U[m].loc, false, IDENT4);
        }
        if (U.g_PointerPosition) gl.uniform2f(U.g_PointerPosition.loc, this.cursor.x, this.cursor.y);
        if (U.g_PointerPositionLast) gl.uniform2f(U.g_PointerPositionLast.loc, this.lastCursor ? this.lastCursor.x : this.cursor.x, this.lastCursor ? this.lastCursor.y : this.cursor.y);
        if (U.g_PointerState) gl.uniform4f(U.g_PointerState.loc, 0, 0, 0, 0);
        if (U.g_ParallaxPosition) gl.uniform2f(U.g_ParallaxPosition.loc, this.smoothCursor.x, this.smoothCursor.y);
        if (U.g_Screen) gl.uniform3f(U.g_Screen.loc, this.canvas.width, this.canvas.height, this.canvas.width / this.canvas.height);
        if (U.g_TexelSize) gl.uniform2f(U.g_TexelSize.loc, 1 / out.w, 1 / out.h);
        if (U.g_TexelSizeHalf) gl.uniform2f(U.g_TexelSizeHalf.loc, 0.5 / out.w, 0.5 / out.h);
        if (U.g_Alpha) gl.uniform1f(U.g_Alpha.loc, 1);
        if (U.g_UserAlpha) gl.uniform1f(U.g_UserAlpha.loc, 1);
        if (U.g_Brightness) gl.uniform1f(U.g_Brightness.loc, 1);
        if (U.g_Color) gl.uniform3f(U.g_Color.loc, 1, 1, 1);
        if (U.g_TextureReductionScale) gl.uniform1f(U.g_TextureReductionScale.loc, 1);
        for (const [k, arr] of Object.entries(audio)) if (U[k]) gl.uniform1fv(U[k].loc, arr);
        for (const [name, v] of Object.entries(pass.values)) {
          const u = U[name];
          if (!u || name.startsWith('g_Texture')) continue;
          const val = typeof v.raw === 'object' && v.raw !== null && !Array.isArray(v.raw) ? this.resolve(v.raw, v.slot) : v.raw;
          setUniform(gl, u, toUniform(val));
        }
        gl.bindVertexArray(this.fsVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        cur = { tex: out.tex, w: out.w, h: out.h, tw: out.w, th: out.h };
      }
    }
    return cur.tex;
  }

  blitTex(srcTex, dst) {
    if (!srcTex || !dst) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.basic.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]));
    gl.uniform4fv(this.basic.uniforms.u_UVRect.loc, [0, 0, 1, 1]);
    gl.uniform4fv(this.basic.uniforms.u_Color.loc, [1, 1, 1, 1]);
    gl.uniform1f(this.basic.uniforms.u_Solid.loc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  renderText(ob) {
    if (ob.text === ob.lastText && ob.glTex) return;
    ob.lastText = ob.text;
    const o = ob.src;
    const scale = Math.max(0.25, this.res || 1);
    const w = Math.max(4, Math.round(ob.size[0] * scale)), h = Math.max(4, Math.round(ob.size[1] * scale));
    const c = ob.canvas; c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (o.opaquebackground) { const bc = vec(o.backgroundcolor, [0, 0, 0]); ctx.fillStyle = `rgb(${bc.map((x) => x * 255).join(',')})`; ctx.fillRect(0, 0, w, h); }
    const px = (Number(o.pointsize) || 32) * 2 * scale;
    ctx.font = `${px}px "${ob.font}", "Segoe UI", sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    const ha = o.horizontalalign || 'center', va = o.verticalalign || 'center';
    ctx.textAlign = ha === 'left' ? 'left' : ha === 'right' ? 'right' : 'center';
    const pad = (Number(o.padding) || 0) * scale;
    const lines = String(ob.text).split('\n');
    const lh = px * 1.15;
    const total = lh * lines.length;
    const x = ha === 'left' ? pad : ha === 'right' ? w - pad : w / 2;
    let y = va === 'top' ? pad + lh / 2 : va === 'bottom' ? h - pad - total + lh / 2 : h / 2 - total / 2 + lh / 2;
    for (const l of lines) { ctx.fillText(l, x, y); y += lh; }
    const gl = this.gl;
    if (!ob.glTex) ob.glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ob.glTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    this.texParams(true, false, false);
  }

  renderFrame(dt) {
    if (!this.sceneFBO) return;
    const gl = this.gl;
    this.framesDrawn = (this.framesDrawn || 0) + 1;
    this.dt = dt;
    this.time += dt;
    // Smooth cursor for parallax
    const k = this.parallax.delay > 0 ? Math.min(1, dt / Math.max(0.016, this.parallax.delay * 2)) : 1;
    this.smoothCursor.x += (this.cursor.x - this.smoothCursor.x) * k;
    this.smoothCursor.y += (this.cursor.y - this.smoothCursor.y) * k;
    if (this.scripts) this.scripts.frametime = dt;
    this.frameAudio = this.audioUniforms();
    for (const v of this.videos) {
      if (v.video.readyState >= 2) { gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v.video); }
    }
    // Scene pass
    const S = this.sceneFBO;
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb);
    gl.viewport(0, 0, S.w, S.h);
    const cc = this.clear || [0, 0, 0];
    gl.clearColor(cc[0], cc[1], cc[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const ob of this.objects) {
      try { this.updateObject(ob); } catch (e) { /* bad binding */ }
      if (!ob.visible || ob.type === 'sound') continue;
      if (ob.type === 'particle') { this.drawParticles(ob, dt); continue; }
      const wt = this.world(ob);
      const color = [ob.color[0], ob.color[1], ob.color[2], Math.max(0, Math.min(1, ob.alpha))];
      if (color[3] <= 0.001) continue;
      if (ob.type === 'text') {
        this.renderText(ob);
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb); gl.viewport(0, 0, S.w, S.h);
        this.drawQuad(this.quadCorners(wt, ob.size[0], ob.size[1]), ob.glTex, [0, 0, 1, 1], color, 'translucent');
        continue;
      }
      const fw = ob.size[0] * this.res, fh = ob.size[1] * this.res;
      let tex = ob.tex ? ob.tex.tex : null;
      let uv = this.frameRect(ob.tex);
      if (ob.capture || ob.effects.length) {
        const fb = this.objectFBOs(ob, fw, fh);
        // Input: either the layer texture, or what is already drawn behind it (compose / fullscreen layers)
        if (ob.capture) {
          const [tl, tr, bl, br] = this.quadCorners({ ...wt, r: 0, sx: Math.abs(wt.sx), sy: Math.abs(wt.sy) }, ob.size[0], ob.size[1]);
          const x0 = (tl[0] + 1) / 2 * S.w, x1 = (tr[0] + 1) / 2 * S.w, y0 = (bl[1] + 1) / 2 * S.h, y1 = (tl[1] + 1) / 2 * S.h;
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, S.fb);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb.b.fb);
          gl.blitFramebuffer(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), 0, fb.b.h, fb.b.w, 0, gl.COLOR_BUFFER_BIT, gl.LINEAR);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          tex = fb.b.tex;
          // effects must not read and write the same buffer: start ping-pong on 'a'
          tex = this.runEffects(ob, tex, fb.a.w, fb.a.h, { a: fb.a, b: this.spareFBO(ob, fb.a.w, fb.a.h) });
        } else {
          // Crop / animate the layer texture into the first buffer, then run the effect chain.
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb.b.fb);
          gl.viewport(0, 0, fb.b.w, fb.b.h);
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          this.drawQuad([[-1, -1], [1, -1], [-1, 1], [1, 1]], tex, uv, [1, 1, 1, 1], 'disabled', ob.solid);
          tex = this.runEffects(ob, fb.b.tex, fb.b.w, fb.b.h, { a: fb.a, b: this.spareFBO(ob, fb.a.w, fb.a.h) });
        }
        uv = [0, 0, 1, 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb);
        gl.viewport(0, 0, S.w, S.h);
      }
      this.drawQuad(this.quadCorners(wt, ob.size[0], ob.size[1]), tex, uv, color, ob.capture ? 'translucent' : ob.blending, ob.solid && !ob.effects.length);
    }
    this.lastCursor = { ...this.cursor };
    // Present: cover-fit the scene to the screen (with optional camera shake)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const cw = this.canvas.width, ch = this.canvas.height;
    const sceneAR = this.W / this.H, screenAR = cw / ch;
    let uvr;
    if (screenAR > sceneAR) { const v = sceneAR / screenAR; uvr = [0, (1 - v) / 2, 1, v]; }
    else { const u = screenAR / sceneAR; uvr = [(1 - u) / 2, 0, u, 1]; }
    if (this.shake.enabled) {
      const a = this.shake.amp * 0.004, sp = this.shake.speed;
      uvr[0] += Math.sin(this.time * sp * 1.3) * a; uvr[1] += Math.cos(this.time * sp * 1.7) * a;
    }
    // Default framebuffer: v=0 is the bottom row; our scene FBO row 0 is the bottom too.
    this.drawQuad([[-1, 1], [1, 1], [-1, -1], [1, -1]], S.tex, [uvr[0], uvr[1] + uvr[3], uvr[2], -uvr[3]], [1, 1, 1, 1], 'disabled');
  }

  spareFBO(ob, w, h) {
    if (ob.spare && ob.spare.w === w && ob.spare.h === h) return ob.spare;
    if (ob.spare) this.freeFBO(ob.spare);
    ob.spare = this.makeFBO(w, h);
    return ob.spare;
  }

  drawParticles(ob, dt) {
    const gl = this.gl;
    ob.system.update(dt);
    const n = ob.system.fill();
    if (!n) return;
    const wt = this.world(ob);
    const c = Math.cos(wt.r), s = Math.sin(wt.r);
    const P = this.particleProg;
    gl.useProgram(P.program);
    gl.bindVertexArray(this.pVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pInst);
    gl.bufferData(gl.ARRAY_BUFFER, ob.system.data.subarray(0, n * 12), gl.STREAM_DRAW);
    // column-major mat3: scale+rotate+translate
    gl.uniformMatrix3fv(P.uniforms.u_World.loc, false, [c * wt.sx, s * wt.sx, 0, -s * wt.sy, c * wt.sy, 0, wt.x, wt.y, 1]);
    gl.uniform2f(P.uniforms.u_Scene.loc, this.W, this.H);
    const tex = ob.tex;
    if (tex && tex.frames && tex.frames.length) {
      const fr = new Float32Array(256);
      tex.frames.slice(0, 64).forEach((f, i) => fr.set([f.x, f.y, f.w, f.h], i * 4));
      gl.uniform4fv(P.uniforms['u_Frames'].loc, fr);
      gl.uniform1f(P.uniforms.u_FrameCount.loc, Math.min(64, tex.frames.length));
    } else {
      gl.uniform1f(P.uniforms.u_FrameCount.loc, 0);
    }
    gl.uniform2f(P.uniforms.u_UVMax.loc, tex ? tex.width / tex.texWidth : 1, tex ? tex.height / tex.texHeight : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex ? tex.tex : this.white);
    gl.uniform1i(P.uniforms.u_Tex.loc, 0);
    if (P.uniforms.u_Gray) gl.uniform1f(P.uniforms.u_Gray.loc, tex && tex.gray ? 1 : 0);
    this.setBlend(ob.blending === 'additive' ? 'additive' : 'translucent');
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const s of this.sounds) { s.audio.pause(); s.audio.src = ''; s.tracks.forEach((u) => URL.revokeObjectURL(u)); }
    for (const v of this.videos) { v.video.pause(); URL.revokeObjectURL(v.video.src); }
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.canvas.remove();
  }
}

function toUniform(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return parseValue(v);
  if (v && typeof v === 'object' && 'x' in v) return 'w' in v ? [v.x, v.y, v.z, v.w] : 'z' in v ? [v.x, v.y, v.z] : [v.x, v.y];
  return v;
}

function toScriptValue(v, rt) {
  if (typeof v === 'string' && rt && rt.globals) {
    const p = v.trim().split(/\s+/).map(Number);
    if (p.length >= 2 && p.every((x) => !Number.isNaN(x))) return p.length === 2 ? new rt.globals.Vec2(p[0], p[1]) : new rt.globals.Vec3(p[0], p[1], p[2]);
  }
  return v;
}

function fromScriptValue(v) {
  if (v && typeof v === 'object' && 'x' in v && 'y' in v) return 'z' in v ? [v.x, v.y, v.z] : [v.x, v.y];
  return v;
}
