// Parser for Wallpaper Engine .tex textures (TEXV0005 / TEXI0001 / TEXB0001-4 / TEXS000x).
// Works in the browser and in Node (for tests).

export const TexFormat = { RGBA8888: 0, RGB888: 1, RGB565: 2, DXT5: 4, DXT3: 6, DXT1: 7, RG88: 8, R8: 9, RG1616F: 10, R16F: 11, BC7: 12, RGBA1010102: 13, RGBA16161616F: 14, RGB161616F: 15 };
export const TexFlags = { NoInterpolation: 1, ClampUVs: 2, IsGif: 4 };

export function lz4Decompress(src, dstLen) {
  const dst = new Uint8Array(dstLen);
  let si = 0, di = 0;
  const n = src.length;
  while (si < n) {
    const tok = src[si++];
    let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[si++]; lit += b; } while (b === 255 && si < n); }
    if (lit) { dst.set(src.subarray(si, si + lit), di); si += lit; di += lit; }
    if (si >= n) break;
    const off = src[si] | (src[si + 1] << 8); si += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[si++]; ml += b; } while (b === 255 && si < n); }
    ml += 4;
    let p = di - off;
    if (p < 0 || off === 0) throw new Error('LZ4: bad offset');
    if (off >= ml) { dst.copyWithin(di, p, p + ml); di += ml; }
    else { for (let k = 0; k < ml; k++) dst[di++] = dst[p++]; }
  }
  return di === dstLen ? dst : dst.subarray(0, di);
}

class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.o = 0; }
  str9() { const s = String.fromCharCode(...this.u8.subarray(this.o, this.o + 8)); this.o += 9; return s; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  bytes(n) { const b = this.u8.subarray(this.o, this.o + n); this.o += n; return b; }
  get left() { return this.u8.length - this.o; }
}

export function parseTex(u8) {
  const r = new Reader(u8);
  const magic = r.str9();
  if (!magic.startsWith('TEXV')) throw new Error('Not a TEX file');
  r.str9(); // TEXI0001
  const tex = {
    format: r.i32(), flags: r.u32(), texWidth: r.u32(), texHeight: r.u32(), width: r.u32(), height: r.u32(), unk: r.u32(),
    images: [], freeImageFormat: -1, isVideo: false, frames: null, gifWidth: 0, gifHeight: 0
  };
  const cont = r.str9();
  const imageCount = r.u32();
  const ver = Number(cont.slice(4)) || 1;
  if (ver >= 3) tex.freeImageFormat = r.i32();
  if (ver >= 4) tex.isVideo = r.u32() === 1;
  for (let i = 0; i < imageCount; i++) {
    const mipCount = r.u32();
    const mips = [];
    for (let m = 0; m < mipCount; m++) {
      const w = r.u32(), h = r.u32();
      let compressed = 0, rawSize = 0;
      if (ver >= 2) { compressed = r.u32(); rawSize = r.u32(); }
      const len = r.u32();
      let data = r.bytes(len);
      if (compressed === 1) data = lz4Decompress(data, rawSize);
      mips.push({ width: w, height: h, data });
    }
    tex.images.push(mips);
  }
  if ((tex.flags & TexFlags.IsGif) && r.left > 9) {
    const sm = r.str9();
    const sv = Number(sm.slice(4)) || 1;
    const count = r.u32();
    if (sv >= 3) { tex.gifWidth = r.u32(); tex.gifHeight = r.u32(); }
    tex.frames = [];
    for (let i = 0; i < count; i++) {
      const imageId = r.u32();
      const frametime = r.f32();
      const x = r.f32(), y = r.f32(), w1 = r.f32(), w2 = r.f32(), h2 = r.f32(), h1 = r.f32();
      tex.frames.push({ imageId, frametime, x, y, w1, w2, h1, h2 });
    }
  }
  return tex;
}

// ---------- CPU decoders (fallback when the GPU lacks S3TC) ----------
function rgb565(c) { return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }

function decodeColorBlock(src, o, out, ox, oy, w, h, dxt1) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  const a = rgb565(c0), b = rgb565(c1);
  const cols = [a, b];
  if (c0 > c1 || !dxt1) { cols.push(a.map((v, i) => (2 * v + b[i]) / 3 | 0)); cols.push(a.map((v, i) => (v + 2 * b[i]) / 3 | 0)); }
  else { cols.push(a.map((v, i) => (v + b[i]) / 2 | 0)); cols.push([0, 0, 0]); }
  const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const px = ox + x, py = oy + y;
    if (px >= w || py >= h) continue;
    const idx = (bits >>> (2 * (4 * y + x))) & 3;
    const c = cols[idx];
    const d = (py * w + px) * 4;
    out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2];
    out[d + 3] = dxt1 && c0 <= c1 && idx === 3 ? 0 : 255;
  }
}

export function decodeDXT(data, w, h, format) {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bs = format === TexFormat.DXT1 ? 8 : 16;
  let o = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, o += bs) {
    if (o + bs > data.length) return out;
    if (format === TexFormat.DXT1) { decodeColorBlock(data, o, out, bx * 4, by * 4, w, h, true); continue; }
    decodeColorBlock(data, o + 8, out, bx * 4, by * 4, w, h, false);
    if (format === TexFormat.DXT3) {
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
        if (px >= w || py >= h) continue;
        const nib = (data[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
        out[(py * w + px) * 4 + 3] = nib * 17;
      }
    } else {
      const a0 = data[o], a1 = data[o + 1];
      const al = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) al.push(((7 - i) * a0 + i * a1) / 7 | 0);
      else { for (let i = 1; i < 5; i++) al.push(((5 - i) * a0 + i * a1) / 5 | 0); al.push(0, 255); }
      // 48 bits of 3-bit indices, split in two 24-bit halves to avoid BigInt.
      const lo = data[o + 2] | (data[o + 3] << 8) | (data[o + 4] << 16);
      const hi = data[o + 5] | (data[o + 6] << 8) | (data[o + 7] << 16);
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
        if (px >= w || py >= h) continue;
        const idx = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
        out[(py * w + px) * 4 + 3] = al[idx];
      }
    }
  }
  return out;
}

/** Expand any supported format into RGBA8. */
export function toRGBA(data, w, h, format) {
  const n = w * h;
  if (format === TexFormat.RGBA8888) return data.length >= n * 4 ? data.subarray(0, n * 4) : data;
  const out = new Uint8Array(n * 4);
  if (format === TexFormat.R8) for (let i = 0; i < n; i++) { const v = data[i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
  else if (format === TexFormat.RG88) for (let i = 0; i < n; i++) { const v = data[i * 2], a = data[i * 2 + 1]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = a; }
  else if (format === TexFormat.RGB888) for (let i = 0; i < n; i++) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = 255; }
  else if (format === TexFormat.DXT1 || format === TexFormat.DXT3 || format === TexFormat.DXT5) return decodeDXT(data, w, h, format);
  else throw new Error('Unsupported texture format ' + format);
  return out;
}
