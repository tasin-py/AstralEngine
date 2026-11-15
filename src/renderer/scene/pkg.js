// Wallpaper Engine scene.pkg archive reader (PKGV00xx). Read-only.
export function parsePkg(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const dec = new TextDecoder();
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const str = () => { const n = u32(); const s = dec.decode(u8.subarray(o, o + n)); o += n; return s; };
  const version = str();
  if (!version.startsWith('PKGV')) throw new Error('Not a PKG file');
  const count = u32();
  const entries = [];
  for (let i = 0; i < count; i++) entries.push({ name: str(), offset: u32(), length: u32() });
  const base = o;
  const files = new Map();
  for (const e of entries) files.set(e.name.replace(/\\/g, '/').toLowerCase(), u8.subarray(base + e.offset, base + e.offset + e.length));
  return { version, files };
}
