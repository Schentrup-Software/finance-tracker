import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, makeZip, readZip } from "~/lib/zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A ZIP with deflated entries, the way Finder and Windows make them. */
function deflatedZip(files: { name: string; text: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.text);
    const data = deflateRawSync(raw);
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dirBuf, end]));
}

describe("reading a zip", () => {
  it("reads back what makeZip wrote", async () => {
    const zip = makeZip([{ name: "a.pdf", data: enc.encode("one") }, { name: "b.pdf", data: enc.encode("two") }]);
    const files = await readZip(zip);
    expect(files.map((f) => [f.name, dec.decode(f.data)])).toEqual([["a.pdf", "one"], ["b.pdf", "two"]]);
  });

  it("inflates deflated entries and leaves out folders and macOS extras", async () => {
    const zip = deflatedZip([
      { name: "stubs/", text: "" },
      { name: "stubs/2026-11-13.pdf", text: "%PDF-1.4 paystub ".repeat(50) },
      { name: "__MACOSX/stubs/._2026-11-13.pdf", text: "junk" },
      { name: "stubs/.DS_Store", text: "junk" },
    ]);
    const files = await readZip(zip);
    expect(files.map((f) => f.name)).toEqual(["stubs/2026-11-13.pdf"]);
    expect(dec.decode(files[0].data)).toBe("%PDF-1.4 paystub ".repeat(50));
  });

  it("says so when the file isn't a zip", async () => {
    await expect(readZip(enc.encode("not a zip at all, just some text here"))).rejects.toThrow("isn't a ZIP");
  });
});
