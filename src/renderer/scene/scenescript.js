// SceneScript runtime: runs the small JavaScript snippets Wallpaper Engine scenes attach to
// properties (clocks, day/night blending, audio-reactive values...).
// Uses Wallpaper Engine's own helper classes from the installed assets folder when available.

const FALLBACK_BASE = `
class Vec2 { constructor(x=0,y=x){ if(typeof x==='string'){const p=x.split(/\\s+/).map(Number);x=p[0]||0;y=p[1]||0;} this.x=x;this.y=y; }
  add(v){return typeof v==='number'?new Vec2(this.x+v,this.y+v):new Vec2(this.x+v.x,this.y+v.y);} subtract(v){return typeof v==='number'?new Vec2(this.x-v,this.y-v):new Vec2(this.x-v.x,this.y-v.y);}
  multiply(v){return typeof v==='number'?new Vec2(this.x*v,this.y*v):new Vec2(this.x*v.x,this.y*v.y);} divide(v){return typeof v==='number'?new Vec2(this.x/v,this.y/v):new Vec2(this.x/v.x,this.y/v.y);}
  length(){return Math.hypot(this.x,this.y);} normalize(){const l=this.length()||1;return new Vec2(this.x/l,this.y/l);} copy(){return new Vec2(this.x,this.y);} toString(){return this.x+' '+this.y;} }
class Vec3 { constructor(x=0,y=x,z=x){ if(typeof x==='string'){const p=x.split(/\\s+/).map(Number);x=p[0]||0;y=p[1]||0;z=p[2]||0;} this.x=x;this.y=y;this.z=z; }
  add(v){return typeof v==='number'?new Vec3(this.x+v,this.y+v,this.z+v):new Vec3(this.x+v.x,this.y+v.y,this.z+(v.z||0));} subtract(v){return typeof v==='number'?new Vec3(this.x-v,this.y-v,this.z-v):new Vec3(this.x-v.x,this.y-v.y,this.z-(v.z||0));}
  multiply(v){return typeof v==='number'?new Vec3(this.x*v,this.y*v,this.z*v):new Vec3(this.x*v.x,this.y*v.y,this.z*(v.z??1));} divide(v){return typeof v==='number'?new Vec3(this.x/v,this.y/v,this.z/v):new Vec3(this.x/v.x,this.y/v.y,this.z/(v.z||1));}
  length(){return Math.hypot(this.x,this.y,this.z);} normalize(){const l=this.length()||1;return new Vec3(this.x/l,this.y/l,this.z/l);} copy(){return new Vec3(this.x,this.y,this.z);} toString(){return this.x+' '+this.y+' '+this.z;} }
class Vec4 { constructor(x=0,y=x,z=x,w=x){this.x=x;this.y=y;this.z=z;this.w=w;} }
class Mat3 {} class Mat4 {}
this.createScriptProperties=function(){var vars={};var obj={order:0,
 addSlider(o){vars[o.name]=o.value;return obj;},addCheckbox(o){vars[o.name]=o.value;return obj;},addText(o){vars[o.name]=o.value;return obj;},
 addCombo(o){vars[o.name]=o.options&&o.options[0]?o.options[0].value:undefined;return obj;},addColor(o){vars[o.name]=o.value;return obj;},addFile(o){vars[o.name]=o.value;return obj;},finish(){return vars;}};return obj;};
`;

const FALLBACK_MODULES = {
  WEMath: `export let deg2rad=Math.PI/180;export let rad2deg=180/Math.PI;export function smoothStep(a,b,v){let x=Math.max(0,Math.min(1,(v-a)/(b-a)));return x*x*(3-2*x);}export function mix(a,b,v){return a+(b-a)*v;}export function clamp(v,a,b){return Math.max(a,Math.min(b,v));}`,
  WEVector: `import * as WEMath from 'WEMath';export function angleVector2(a){a=a*WEMath.deg2rad;return new Vec2(Math.cos(a),Math.sin(a));}export function vectorAngle2(d){return Math.atan2(d.y,d.x)*WEMath.rad2deg;}`,
  WEColor: `export function rgb2hsv(c){return c;}export function hsv2rgb(c){return c;}export function normalizeColor(c){return new Vec3(c.x/255,c.y/255,c.z/255);}export function expandColor(c){return new Vec3(c.x*255,c.y*255,c.z*255);}`
};

/** Turns an ES module-style script into a function body returning its exports. */
function toFunctionBody(src) {
  let s = String(src).replace(/^\s*['"]use strict['"];?/, '');
  const imports = [];
  s = s.replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/gm, (a, name, mod) => { imports.push(`const ${name} = __mod(${JSON.stringify(mod)});`); return ''; });
  s = s.replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?/gm, (a, names, mod) => {
    imports.push(`const {${names.replace(/\s+as\s+/g, ': ')}} = __mod(${JSON.stringify(mod)});`); return '';
  });
  s = s.replace(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/gm, (a, name, mod) => { imports.push(`const ${name} = __mod(${JSON.stringify(mod)}).default;`); return ''; });
  const exported = [];
  s = s.replace(/\bexport\s+(?:async\s+)?function\s+(\w+)/g, (a, n) => { exported.push(n); return a.replace(/^export\s+/, ''); });
  s = s.replace(/\bexport\s+(var|let|const)\s+(\w+)/g, (a, k, n) => { exported.push(n); return `${k} ${n}`; });
  s = s.replace(/\bexport\s+default\s+/g, 'var __default = ');
  s = s.replace(/\bexport\s*\{[^}]*\};?/g, '');
  const ret = exported.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(',');
  return `${imports.join('\n')}\n${s}\nreturn { ${ret}${ret ? ',' : ''} default: typeof __default !== 'undefined' ? __default : undefined };`;
}

export class SceneScriptRuntime {
  constructor({ fetchText, userProps, screen }) {
    this.fetchText = fetchText;
    this.userProps = userProps;   // live object: name -> value
    this.shared = {};
    this.start = performance.now();
    this.frametime = 0;
    this.audioBuffers = [];
    this.cursor = { x: 0.5, y: 0.5, down: false };
    this.screen = screen;
    this.scripts = [];
    this.modules = {};
    this.ready = false;
  }

  async init() {
    let base = null;
    try { base = await this.fetchText('scripts/jsclasses/baseclasses.js'); } catch { /* not installed */ }
    const globals = { shared: this.shared };
    const src = (base || FALLBACK_BASE) + '\n;return { Vec2: typeof Vec2!=="undefined"?Vec2:undefined, Vec3: typeof Vec3!=="undefined"?Vec3:undefined, Vec4: typeof Vec4!=="undefined"?Vec4:undefined, Mat3: typeof Mat3!=="undefined"?Mat3:undefined, Mat4: typeof Mat4!=="undefined"?Mat4:undefined };';
    let classes;
    try { classes = new Function(src).call(globals); } catch (e) {
      classes = new Function(FALLBACK_BASE + '\n;return {Vec2,Vec3,Vec4,Mat3,Mat4};').call(globals);
    }
    this.globals = Object.assign(globals, classes);
    if (globals.shared) this.shared = globals.shared; else globals.shared = this.shared;
    if (!this.globals.createScriptProperties) new Function(FALLBACK_BASE + ';').call(this.globals);
    for (const [name, file] of [['WEMath', 'wemath.js'], ['WEVector', 'wevector.js'], ['WEColor', 'wecolor.js']]) {
      let t = null;
      try { t = await this.fetchText('scripts/jsmodules/' + file); } catch { /* ignore */ }
      this.moduleSources = this.moduleSources || {};
      this.moduleSources[name] = t || FALLBACK_MODULES[name];
    }
    this.ready = true;
  }

  mod(name) {
    const key = Object.keys(this.moduleSources).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (!key) return {};
    if (!this.modules[key]) this.modules[key] = this.evalModule(this.moduleSources[key]);
    return this.modules[key];
  }

  engine() {
    const self = this;
    return {
      get runtime() { return (performance.now() - self.start) / 1000; },
      get frametime() { return self.frametime; },
      get timeOfDay() { const d = new Date(); return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; },
      userProperties: this.userProps,
      screenResolution: new this.globals.Vec2(this.screen.width, this.screen.height),
      canvasSize: new this.globals.Vec2(this.screen.sceneWidth, this.screen.sceneHeight),
      isDesktopDevice: () => true, isMobileDevice: () => false, isWallpaper: () => true, isScreensaver: () => false, isRunningInEditor: () => false,
      registerAudioBuffers: (n = 16) => { const b = { left: new Float32Array(n), right: new Float32Array(n), average: new Float32Array(n), resolution: n }; self.audioBuffers.push(b); return b; },
      setTimeout: (f, ms) => setTimeout(f, ms), setInterval: (f, ms) => setInterval(f, ms), clearTimeout, clearInterval,
      openUserShortcut: () => {}
    };
  }

  evalModule(src, extra = {}) {
    const body = toFunctionBody(src);
    const g = this.globals;
    const names = ['Vec2', 'Vec3', 'Vec4', 'Mat3', 'Mat4', 'createScriptProperties', 'shared', 'engine', 'input', 'console', '__mod', ...Object.keys(extra)];
    const vals = [g.Vec2, g.Vec3, g.Vec4, g.Mat3, g.Mat4, g.createScriptProperties, this.shared, this._engine || (this._engine = this.engine()), this.input(), console, (n) => this.mod(n), ...Object.values(extra)];
    // eslint-disable-next-line no-new-func
    return new Function(...names, body)(...vals);
  }

  input() {
    if (this._input) return this._input;
    const self = this;
    const g = this.globals;
    this._input = {
      get cursorScreenPosition() { return new g.Vec2(self.cursor.x * self.screen.width, (1 - self.cursor.y) * self.screen.height); },
      get cursorWorldPosition() { return new g.Vec3(self.cursor.x * self.screen.sceneWidth, (1 - self.cursor.y) * self.screen.sceneHeight, 0); },
      get cursorLeftDown() { return self.cursor.down; }
    };
    return this._input;
  }

  /**
   * Compile a property script. Returns a handle with update(currentValue) -> newValue, or null.
   * scriptProps: values from the scene (may bind to user properties).
   */
  compile(src, { thisLayer, thisScene, scriptProps, resolve }) {
    if (!this.ready || !src) return null;
    try {
      const exp = this.evalModule(src, { thisLayer, thisObject: thisLayer, thisScene });
      if (exp.scriptProperties && scriptProps) {
        for (const [k, v] of Object.entries(scriptProps)) exp.scriptProperties[k] = resolve ? resolve(v) : v;
      }
      const h = { exp, initDone: false, failed: 0 };
      this.scripts.push(h);
      return {
        update: (value) => {
          if (h.failed > 5) return value;
          try {
            if (!h.initDone) { h.initDone = true; if (exp.init) { const r = exp.init(value); if (r !== undefined) value = r; } }
            if (exp.update) { const r = exp.update(value); if (r !== undefined) return r; }
          } catch (e) { if (++h.failed === 1) console.warn('SceneScript error', e); }
          return value;
        },
        applyUserProperties: (changed) => { try { exp.applyUserProperties && exp.applyUserProperties(changed); } catch { /* ignore */ } },
        cursorClick: (ev) => { try { exp.cursorClick && exp.cursorClick(ev); } catch { /* ignore */ } }
      };
    } catch (e) {
      console.warn('SceneScript compile failed', e);
      return null;
    }
  }

  setAudio(arr) {
    for (const b of this.audioBuffers) {
      const n = b.resolution;
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * 64 / n), z = Math.max(a + 1, Math.floor((i + 1) * 64 / n));
        let l = 0, r = 0;
        for (let k = a; k < z; k++) { l = Math.max(l, arr[k] || 0); r = Math.max(r, arr[64 + k] || 0); }
        b.left[i] = l; b.right[i] = r; b.average[i] = (l + r) / 2;
      }
    }
  }
}
