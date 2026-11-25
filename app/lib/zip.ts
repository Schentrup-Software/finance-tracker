// A minimal ZIP writer (files stored, not compressed) for downloading the year's
// tax documents in one file. PDFs and photos are already compressed.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Builds a ZIP archive. Names are made unique by adding " (2)", " (3)", … before the extension. */
export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const seen = new Map<string, number>();
  const files = entries.map((e) => {
    let name = e.name.replace(/[\\/:*?"<>|]+/g, "-");
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
    return { name: enc.encode(name), data: e.data, crc: crc32(e.data) };
  });

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const local = new Uint8Array(30 + f.name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // stored
    v.setUint32(14, f.crc, true);
    v.setUint32(18, f.data.length, true);
    v.setUint32(22, f.data.length, true);
    v.setUint16(26, f.name.length, true);
    local.set(f.name, 30);

    const dir = new Uint8Array(46 + f.name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x0800, true);
    d.setUint32(16, f.crc, true);
    d.setUint32(20, f.data.length, true);
    d.setUint32(24, f.data.length, true);
    d.setUint16(28, f.name.length, true);
    d.setUint32(42, offset, true);
    dir.set(f.name, 46);

    parts.push(local, f.data);
    central.push(dir);
    offset += local.length + f.data.length;
  }
  const dirSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}
