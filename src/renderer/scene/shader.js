// Translates Wallpaper Engine's GLSL/HLSL-flavoured shaders to WebGL2 (GLSL ES 3.00).

const HEADER_COMMON = `
#define float1 float
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define float2x2 mat2
#define float3x3 mat3
#define float4x4 mat4
#define half float
#define half2 vec2
#define half3 vec3
#define half4 vec4
#define frac fract
#define lerp mix
#define saturate(x) clamp((x), 0.0, 1.0)
#define mul(x, y) ((y) * (x))
#define atan2 atan
#define fmod mod
#define ddx dFdx
#define ddy dFdy
#define texSample2D texture
#define texSample2DLod textureLod
#define log10(x) (log2(x) * 0.30102999566)
#define CAST2(x) (vec2(x))
#define CAST3(x) (vec3(x))
#define CAST4(x) (vec4(x))
#define CAST3X3(x) (mat3(x))
#define rsqrt inversesqrt
#define GLSL 1
#define HLSL 0
#define sampler2DComparison sampler2DShadow
`;

// HLSL promotes scalars to vectors implicitly; GLSL ES does not and forbids overloading
// built-ins, so these wrappers are defined first and the built-in names are redirected.
const OVERLOADS = (() => {
  const V = ['float', 'vec2', 'vec3', 'vec4'];
  let s = '';
  for (const t of V) {
    s += `${t} ae_pow(${t} a, ${t} b){return pow(a,b);}\n`;
    s += `${t} ae_mix(${t} a, ${t} b, ${t} t){return mix(a,b,t);}\n`;
    s += `${t} ae_step(${t} e, ${t} x){return step(e,x);}\n`;
    s += `${t} ae_smoothstep(${t} a, ${t} b, ${t} x){return smoothstep(a,b,x);}\n`;
    s += `${t} ae_mod(${t} a, ${t} b){return mod(a,b);}\n`;
    s += `${t} ae_max(${t} a, ${t} b){return max(a,b);}\n`;
    s += `${t} ae_min(${t} a, ${t} b){return min(a,b);}\n`;
    s += `${t} ae_clamp(${t} a, ${t} b, ${t} c){return clamp(a,b,c);}\n`;
    s += `${t} ae_atan(${t} a, ${t} b){return atan(a,b);}\n${t} ae_atan(${t} a){return atan(a);}\n`;
    s += `bool ae_bany(${t} a){return a!=${t}(0.0);}\n`;
    if (t !== 'float') {
      s += `${t} ae_pow(${t} a, float b){return pow(a,${t}(b));}\n${t} ae_pow(float a, ${t} b){return pow(${t}(a),b);}\n`;
      s += `${t} ae_mix(${t} a, ${t} b, float t){return mix(a,b,t);}\n${t} ae_mix(${t} a, float b, float t){return mix(a,${t}(b),t);}\n${t} ae_mix(float a, ${t} b, float t){return mix(${t}(a),b,t);}\n${t} ae_mix(float a, float b, ${t} t){return mix(${t}(a),${t}(b),t);}\n${t} ae_mix(${t} a, float b, ${t} t){return mix(a,${t}(b),t);}\n${t} ae_mix(float a, ${t} b, ${t} t){return mix(${t}(a),b,t);}\n`;
      s += `${t} ae_step(float e, ${t} x){return step(e,x);}\n${t} ae_step(${t} e, float x){return step(e,${t}(x));}\n`;
      s += `${t} ae_smoothstep(float a, float b, ${t} x){return smoothstep(a,b,x);}\n${t} ae_smoothstep(${t} a, ${t} b, float x){return smoothstep(a,b,${t}(x));}\n`;
      s += `${t} ae_mod(${t} a, float b){return mod(a,b);}\n${t} ae_mod(float a, ${t} b){return mod(${t}(a),b);}\n`;
      s += `${t} ae_max(${t} a, float b){return max(a,b);}\n${t} ae_max(float a, ${t} b){return max(${t}(a),b);}\n`;
      s += `${t} ae_min(${t} a, float b){return min(a,b);}\n${t} ae_min(float a, ${t} b){return min(${t}(a),b);}\n`;
      s += `${t} ae_clamp(${t} a, float b, float c){return clamp(a,b,c);}\n${t} ae_clamp(${t} a, ${t} b, float c){return clamp(a,b,${t}(c));}\n${t} ae_clamp(${t} a, float b, ${t} c){return clamp(a,${t}(b),c);}\n`;
    }
  }
  s += 'int ae_max(int a, int b){return max(a,b);}\nint ae_min(int a, int b){return min(a,b);}\nint ae_clamp(int a, int b, int c){return clamp(a,b,c);}\nint ae_mod(int a, int b){return a - b * (a / b);}\nint ae_abs(int a){return abs(a);}\n';
  s += '#define pow ae_pow\n#define mix ae_mix\n#define step ae_step\n#define smoothstep ae_smoothstep\n#define mod ae_mod\n#define max ae_max\n#define min ae_min\n#define clamp ae_clamp\n#define atan ae_atan\n';
  return s;
})();

// Words reserved in GLSL ES 3.00 that WE shaders use as identifiers.
const RESERVED = ['sample', 'input', 'output', 'filter', 'active', 'common', 'partition', 'resource', 'noise', 'smooth', 'flat', 'packed', 'fixed', 'cast', 'interface', 'long', 'short', 'double', 'union', 'template', 'this', 'class', 'public', 'static', 'extern', 'external', 'inline', 'superp', 'centroid', 'namespace', 'using', 'goto', 'volatile', 'unsigned', 'enum', 'typedef', 'sizeof', 'asm', 'hvec2', 'hvec3', 'hvec4', 'fvec2', 'fvec3', 'fvec4', 'sampler3DRect', 'filter', 'image1D', 'image2D', 'buffer', 'shared', 'coherent', 'restrict', 'readonly', 'writeonly', 'subroutine', 'patch', 'precise', 'atomic_uint'];
const RESERVED_RE = new RegExp('\\b(' + [...new Set(RESERVED)].join('|') + ')\\b', 'g');

const INC_RE = /^[ \t]*#include\s+"([^"]+)"/gm;

/** Collect include names recursively so they can be fetched before translation. */
export function findIncludes(src) {
  const out = new Set();
  let m;
  INC_RE.lastIndex = 0;
  while ((m = INC_RE.exec(src))) out.add(m[1]);
  return [...out];
}

export function resolveIncludes(src, getInclude, depth = 0, seen = new Set()) {
  if (depth > 8) return src;
  return src.replace(INC_RE, (all, name) => {
    if (seen.has(name)) return '';
    seen.add(name);
    const t = getInclude(name);
    if (t == null) return `// missing include ${name}`;
    return resolveIncludes(t, getInclude, depth + 1, seen);
  });
}

/** Parses "// [COMBO] {...}" annotations. */
export function parseCombos(src) {
  const combos = {};
  const re = /\/\/\s*\[COMBO(?:_OFF)?\]\s*(\{.*\})/g;
  let m;
  while ((m = re.exec(src))) {
    try { const j = JSON.parse(m[1]); if (j.combo) combos[j.combo] = j.default ?? 0; } catch { /* ignore */ }
  }
  return combos;
}

/** Parses uniform declarations and their JSON annotations. */
export function parseUniforms(src) {
  const list = [];
  const re = /^[ \t]*uniform\s+(\w+)\s+(\w+)\s*(\[\s*\d+\s*\])?\s*;[ \t]*(?:\/\/[ \t]*(\{.*\}))?/gm;
  let m;
  while ((m = re.exec(src))) {
    let ann = null;
    if (m[4]) { try { ann = JSON.parse(m[4]); } catch { ann = null; } }
    list.push({ type: m[1], name: m[2], array: m[3] ? Number(m[3].replace(/\D/g, '')) : 0, ann });
  }
  return list;
}

/** Convert bare integer literals to float literals (WE shaders rely on implicit int->float). */
function floatifyLiterals(code) {
  // Integer #define constants only used in float maths become floats.
  const defRe = /^([ \t]*#\s*define\s+(\w+)\s+)(-?\d+)\s*$/gm;
  const intCtx = (name) => new RegExp(`(\\bint\\b|\\bfor\\b|\\[|\\bivec\\d|\\bwhile\\b|%)[^\\n]*\\b${name}\\b|\\b${name}\\b[^\\n]*(\\]|%)|^[ \\t]*#\\s*(if|elif)[^\\n]*\\b${name}\\b|\\bdefine\\s+\\w+\\s+[^\\n]*\\b${name}\\b`, 'm').test(code);
  code = code.replace(defRe, (all, head, name, num) => (intCtx(name) ? all : `${head}${num}.0`));
  // Names of int variables/constants: used in float maths they get wrapped in float().
  const intNames = new Set();
  const inRe = /(?:^|[;{}])[ \t]*(?:const\s+)?int\s+(\w+)\s*[=;]/gm;
  let mm;
  while ((mm = inRe.exec(code))) intNames.add(mm[1]);
  const forRe = /\bfor\s*\(\s*int\s+(\w+)/g;
  while ((mm = forRe.exec(code))) intNames.add(mm[1]);
  const intNameRe = intNames.size ? new RegExp(`\\b(${[...intNames].join('|')})\\b(?!\\s*(?:[-+*/]?=(?!=)|\\+\\+|--))`, 'g') : null;
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    if (/\b(int|uint|ivec\d|uvec\d|for|while|return)\b/.test(t)) continue;
    const asg = l.match(/^\s*(\w+)\s*[-+*/]?=(?!=)/);
    if (intNameRe && !(asg && intNames.has(asg[1]))) {
      // wrap int identifiers outside of [] subscripts
      let depth = 0, o = '', k = 0;
      while (k < l.length) {
        const ch = l[k];
        if (ch === '[') depth++;
        if (ch === ']') depth = Math.max(0, depth - 1);
        if (depth === 0 && /[A-Za-z_]/.test(ch) && (k === 0 || !/[\w.]/.test(l[k - 1]))) {
          let j = k; while (j < l.length && /\w/.test(l[j])) j++;
          const word = l.slice(k, j);
          const rest = l.slice(j);
          if (intNames.has(word) && !/^\s*(?:[-+*/]?=(?!=)|\+\+|--|\()/.test(rest)) o += `float(${word})`; else o += word;
          k = j; continue;
        }
        o += ch; k++;
      }
      l = o;
    }
    lines[i] = l;
    // Protect array subscripts.
    let depth = 0, out = '';
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      if (c === '[') depth++;
      if (c === ']') depth = Math.max(0, depth - 1);
      const exponent = (l[k - 1] === '-' || l[k - 1] === '+') && /[eE]/.test(l[k - 2] || '') && /[0-9.]/.test(l[k - 3] || '');
      if (depth === 0 && !exponent && /[0-9]/.test(c) && (k === 0 || !/[\w.]/.test(l[k - 1]))) {
        let j = k;
        while (j < l.length && /[0-9]/.test(l[j])) j++;
        const next = l[j] || '';
        if (!/[\w.]/.test(next)) { out += l.slice(k, j) + '.0'; k = j - 1; continue; }
        out += l.slice(k, j); k = j - 1; continue;
      }
      out += c;
    }
    lines[i] = out;
  }
  return lines.join('\n');
}

/**
 * WE's compiler accepts headers that use uniforms declared later in the shader.
 * Move unconditional uniform declarations (outside any #if) to the top.
 */
function hoistUniforms(code) {
  const lines = code.split('\n');
  const hoisted = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#\s*if/.test(t)) depth++;
    else if (/^#\s*endif/.test(t)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^uniform\s+\w+\s+\w+(\s*\[[^\]]*\])?\s*;/.test(t)) { hoisted.push(t.replace(/\/\/.*$/, '')); lines[i] = ''; }
  }
  return hoisted.join('\n') + '\n' + lines.join('\n');
}

/**
 * Build GLSL ES 3.00 source.
 * stage: 'vertex' | 'fragment'
 * defines: { COMBO: value }
 */
export function translate(src, stage, defines, getInclude, { floatify = true } = {}) {
  let code = resolveIncludes(src, getInclude);
  // Strip annotations to keep the source clean.
  code = code.replace(/\/\/\s*\[COMBO(?:_OFF)?\][^\n]*/g, '');
  // Legacy keywords
  code = code.replace(/\battribute\b/g, 'in');
  code = code.replace(/\bvarying\b/g, stage === 'vertex' ? 'out' : 'in');
  code = code.replace(/\btexture2D\s*\(/g, 'texture(');
  code = code.replace(/\btexture2DLod\s*\(/g, 'textureLod(');
  code = code.replace(/\bgl_FragColor\b/g, 'ae_FragColor');
  code = code.replace(RESERVED_RE, 'ae_$1');
  // A variable called "texture" would clash with the texture() built-in used by texSample2D.
  code = code.replace(/\btexture\b(?!\s*\()/g, 'ae_texture');
  // HLSL-style "float4 x = 0" style scalars to vector constructors are left for the compiler.
  // "precision" lines inside WE shaders are harmless; remove '#version' if any.
  code = code.replace(/^[ \t]*#version[^\n]*\n/m, '');
  code = code.replace(/^[ \t]*#\s*require\b[^\n]*$/gm, '');
  // Make sure every macro used in #if/#elif exists (undefined macros are errors in GLSL ES).
  const used = new Set();
  const ifRe = /^[ \t]*#\s*(?:if|elif)\b([^\n]*)/gm;
  let m;
  while ((m = ifRe.exec(code))) {
    for (const id of m[1].match(/[A-Za-z_]\w*/g) || []) if (id !== 'defined') used.add(id);
  }
  const definedInSrc = new Set();
  const defRe = /^[ \t]*#\s*define\s+(\w+)/gm;
  while ((m = defRe.exec(code))) definedInSrc.add(m[1]);
  const all = { ...defines };
  for (const id of used) if (!(id in all) && !definedInSrc.has(id)) all[id] = 0;
  let defs = '';
  for (const [k, v] of Object.entries(all)) defs += `#define ${k} ${Number(v) || 0}\n`;
  code = hoistUniforms(code);
  if (floatify) code = floatifyLiterals(code);
  let head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n' + HEADER_COMMON + OVERLOADS + defs;
  if (stage === 'fragment') head += 'out vec4 ae_FragColor;\n';
  return head + '\n#line 1\n' + code;
}

export function compileProgram(gl, vsSrc, fsSrc) {
  const mk = (type, s) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, s);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  };
  const vs = mk(gl.VERTEX_SHADER, vsSrc);
  let fs;
  try { fs = mk(gl.FRAGMENT_SHADER, fsSrc); } catch (e) { gl.deleteShader(vs); throw e; }
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_Position');
  gl.bindAttribLocation(p, 1, 'a_TexCoord');
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log);
  }
  // Cache uniform locations.
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
  }
  return { program: p, uniforms };
}

/** Try translating + compiling with integer-literal fixups, then without. */
export function buildProgram(gl, vs, fs, defines, getInclude) {
  let first;
  for (const floatify of [true, false]) {
    try {
      return compileProgram(gl, translate(vs, 'vertex', defines, getInclude, { floatify }), translate(fs, 'fragment', defines, getInclude, { floatify }));
    } catch (e) { if (!first) first = e; }
  }
  throw first;
}

/** Parses WE value strings ("1 0.5 0") into numbers / arrays. */
export function parseValue(v) {
  if (v == null) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return Number(v);
  if (typeof v === 'string') {
    const parts = v.trim().split(/\s+/).map(Number);
    if (parts.every((x) => !Number.isNaN(x))) return parts.length === 1 ? parts[0] : parts;
    return v;
  }
  return v;
}

export function setUniform(gl, u, value) {
  if (!u || value == null) return;
  const v = typeof value === 'number' ? [value] : value;
  switch (u.type) {
    case gl.FLOAT: if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, v[0] ?? 0); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, pad(v, 2)); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, pad(v, 3)); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, pad(v, 4)); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v[0] | 0); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
    default: break;
  }
  function pad(a, n) {
    if (a.length === n) return a;
    if (a.length === 1) return new Array(n).fill(a[0]);
    const o = new Array(n).fill(n === 4 ? 1 : 0);
    for (let i = 0; i < Math.min(n, a.length); i++) o[i] = a[i];
    return o;
  }
}
