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

// ---------- Reading a ZIP ----------

/** Limits that keep a hostile ZIP (a "zip bomb") from eating the browser's memory. */
export interface ZipLimits {
  /** Most files read out of it (folders and macOS extras don't count). */
  maxFiles: number;
  /** Largest file, unzipped, in bytes. */
  maxFileBytes: number;
  /** All files together, unzipped, in bytes. */
  maxTotalBytes: number;
}

export const ZIP_LIMITS: ZipLimits = { maxFiles: 500, maxFileBytes: 20 << 20, maxTotalBytes: 300 << 20 };

/**
 * Reads the files out of a ZIP archive (as made by Finder, Windows or `zip`):
 * stored or deflated entries, read through the central directory. Folders,
 * macOS resource forks (__MACOSX/, ._name) and hidden files are left out.
 * Names keep their folder path. They are only labels: nothing is written to disk
 * by name, so "../" names or symlink entries can't reach anything. `keep` picks
 * which files to unzip (by name), and only those count toward the limits.
 * Sizes are counted while inflating, not taken from the archive's own headers,
 * which a hostile archive can fake.
 */
export async function readZip(
  bytes: Uint8Array, keep: (name: string) => boolean = () => true, limits: ZipLimits = ZIP_LIMITS,
): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KB (after an optional comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That file isn't a ZIP archive.");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("That ZIP is too large to read here (ZIP64). Zip fewer files at a time.");

  const utf8 = new TextDecoder("utf-8");
  const latin = new TextDecoder("latin1");
  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("That ZIP archive is damaged.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLen);
    const name = (flags & 0x0800 ? utf8 : latin).decode(rawName);
    at += 46 + nameLen + extraLen + commentLen;

    const base = name.split("/").pop() ?? "";
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || !base || base.startsWith(".") || !keep(name)) continue;
    if (out.length >= limits.maxFiles) throw new Error(`That zip has more than ${limits.maxFiles} files. Split it into smaller zips.`);
    if (flags & 0x0001) throw new Error(`${base} is password-protected. Zip the paystubs without a password.`);

    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("That ZIP archive is damaged.");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > bytes.length) throw new Error("That ZIP archive is damaged.");
    const raw = bytes.subarray(start, start + size);
    const cap = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
    const tooBig = () => new Error(
      cap < limits.maxFileBytes
        ? `Everything in that zip adds up to more than ${limits.maxTotalBytes >> 20} MB unzipped. Split it into smaller zips.`
        : `${base} is more than ${limits.maxFileBytes >> 20} MB unzipped, too big for a paystub.`,
    );
    let data: Uint8Array;
    if (method === 0) {
      if (raw.length > cap) throw tooBig();
      data = raw.slice();
    } else if (method === 8) {
      data = await inflateRaw(raw, cap, tooBig);
    } else throw new Error(`${base} is compressed in a way this can't read. Zip it with the usual settings.`);
    total += data.length;
    out.push({ name, data });
  }
  return out;
}

/** Inflates, stopping as soon as the output passes `cap` bytes. */
async function inflateRaw(data: Uint8Array, cap: number, tooBig: () => Error): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof Error && size > cap) throw err;
    throw new Error("A file in that zip is damaged.");
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
